// sundial-sms — customer texting for the Service module (D-072 amendment 6).
//
//   GET  /service/jobs/{id}/sms      the job's thread + who it would go to (JWT)
//   POST /service/jobs/{id}/sms      { body, to? } → send one text (JWT, service.sms.send)
//   POST /sms/inbound                Twilio → us: a customer replied (signed, PUBLIC)
//   POST /sms/status                 Twilio → us: delivery status of a sent text (signed, PUBLIC)
//
// THE NUMBER IS THE TENANT'S, THE ACCOUNT IS OURS. Secrets Manager `sundial/twilio`:
//   { accountSid, authToken, fromNumber, tenantNumbers?: { "<slug>": "+1…" }, defaultTenant?: "<slug>" }
// A tenant texts from tenantNumbers[slug] when it has one, else the shared fromNumber.
// Inbound texts route by the number they were sent TO: tenantNumbers reversed, else
// defaultTenant (also env SMS_DEFAULT_TENANT). Harmon starts on the shared
// Constructive Ops number (A2P-registered) and moves to its own line by adding one
// entry to tenantNumbers — no code change, no redeploy (the secret is re-read every
// five minutes).
//
// MATCHING A REPLY TO A JOB, in order: (1) the job we last texted this number from —
// a reply belongs to the conversation it answers; (2) the tenant's most recent OPEN
// job whose phone snapshot matches; (3) the customer with that phone and their latest
// job. No match still stores the row (job null) — a text is never dropped — and the
// office sees it under GET /service/sms/unmatched.
//
// TWO PUBLIC ROUTES, held to the doorbell discipline (aurora-webhook, comment-notify):
// the ONLY gate is Twilio's request signature (HMAC-SHA1 over the exact URL + params
// with the auth token), constant-time compared, FAILING CLOSED when the secret cannot
// be read. resolveIdentity is not used on them and must not be — Twilio has no
// Sundial user. Both answer Twilio quickly (no TwiML reply: an empty <Response/>).
//
// TENANT ISOLATION: tenantId comes from resolveIdentity (JWT routes) or the To-number
// map (webhooks); every Salesforce and Supabase read filters on it.
//
// Value-safety: never logs the auth token, a phone number in full, or a message body.

import { resolveIdentity as realResolveIdentity } from "../../lib/identity.js";
import { sfQuery as realSfQuery, soqlEscapeString } from "../../lib/salesforce.js";
import { getSupabaseClient as realGetSupabaseClient } from "../../lib/supabase.js";
import { getSecret as realGetSecret } from "../../lib/secrets.js";
import { broadcast as realBroadcast, recordChannel } from "../../lib/realtime.js";
import { alwaysEnforcedAccess, assertAction } from "../../lib/access-enforce.js";
import { corsHeaders, normalizeHeaders, jsonResponse, mapIdentityError, parseJsonBody, httpMethod } from "../../lib/http.js";
import { digitsOf, last10, mediaFrom, parseFormBody, prettyPhone, requestUrls, sendSms as realSendSms, toE164, validateSignature } from "./twilio.js";

export const SMS_TABLE = "sundial_sms_messages";
export const TWILIO_SECRET_NAME = "sundial/twilio";
export const JOB_SF_OBJECT = "Sundial_Service_Job__c";
export const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";
export const TENANT_SF_OBJECT = "Sundial_Tenant__c";
export const MAX_BODY_CHARS = 1600; // Twilio's ceiling for a concatenated SMS
export const CLOSED_JOB_STATUSES = Object.freeze(["Closed", "Cancelled"]);
const SECRET_TTL_MS = 5 * 60 * 1000;
const THREAD_LIMIT = 500;

export const JOB_SELECT =
  "Id, Name, Client__c, Client__r.Name, Status__c, Sundial_Customer__c, Customer_Name_at_Creation__c, " +
  "Primary_Phone_at_Creation__c, CreatedDate";

const ROUTES = [
  ["GET", /^\/service\/jobs\/([^/]+)\/sms\/?$/, "getThread"],
  ["POST", /^\/service\/jobs\/([^/]+)\/sms\/?$/, "sendText"],
  ["GET", /^\/service\/sms\/unmatched\/?$/, "unmatched"],
  ["POST", /^\/sms\/inbound\/?$/, "inbound"],
  ["POST", /^\/sms\/status\/?$/, "status"],
];
const PUBLIC_ROUTES = new Set(["inbound", "status"]);
const ACTION_FOR = { getThread: "service.estimate.write", sendText: "service.sms.send", unmatched: "service.estimate.write" };

export function matchRoute(method, path) {
  // Strip a stage prefix ("/prod/sms/inbound") — but never a real first segment.
  const p = (path || "").replace(/^\/(?!service\/|sms\/)[^/]+(?=\/(service|sms)\/)/, "");
  for (const [m, re, name] of ROUTES) {
    if (m !== method) continue;
    const hit = p.match(re);
    if (hit) return { name, params: hit.slice(1).map((s) => decodeURIComponent(s)) };
  }
  return null;
}

/** What the portal sees for one row. */
export function messageToView(r) {
  return {
    id: r.id,
    direction: r.direction,
    jobId: r.job_sf_id ?? null,
    from: r.from_number,
    to: r.to_number,
    fromPretty: prettyPhone(r.from_number),
    toPretty: prettyPhone(r.to_number),
    body: r.body ?? "",
    media: Array.isArray(r.media) ? r.media : [],
    status: r.status,
    errorCode: r.error_code ?? null,
    sentByName: r.sent_by_name ?? null,
    at: r.created_at,
    updatedAt: r.updated_at ?? null,
  };
}

/** Resolve the Twilio config from the secret (+ env for the non-credential knobs). */
export function twilioConfigFrom(secret, env = process.env) {
  const s = secret && typeof secret === "object" ? secret : {};
  const tenantNumbers = {};
  for (const [slug, num] of Object.entries(s.tenantNumbers || {})) {
    const e = toE164(num);
    if (e) tenantNumbers[String(slug).toLowerCase()] = e;
  }
  return {
    accountSid: str(s.accountSid ?? s.account_sid),
    authToken: str(s.authToken ?? s.auth_token),
    fromNumber: toE164(s.fromNumber ?? s.from_number) ?? null,
    tenantNumbers,
    defaultTenant: (str(env.SMS_DEFAULT_TENANT) ?? str(s.defaultTenant ?? s.default_tenant) ?? "").toLowerCase() || null,
    webhookBase: str(env.SMS_WEBHOOK_BASE) ?? null,
  };
}
export function fromNumberFor(cfg, tenantSlug) {
  return cfg.tenantNumbers[String(tenantSlug ?? "").toLowerCase()] ?? cfg.fromNumber ?? null;
}
/** Which tenant slug owns the number a text was sent to. */
export function tenantSlugForNumber(cfg, toNumber) {
  const to = toE164(toNumber);
  for (const [slug, num] of Object.entries(cfg.tenantNumbers)) if (num === to) return slug;
  return cfg.defaultTenant;
}

function str(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export function createHandler(deps = {}) {
  const d = {
    resolveIdentity: realResolveIdentity,
    sfQuery: realSfQuery,
    getSupabaseClient: realGetSupabaseClient,
    getSecret: realGetSecret,
    broadcast: realBroadcast,
    sendSms: realSendSms,
    now: () => new Date(),
    env: process.env,
    ...deps,
  };

  let secretCache = null;
  async function config() {
    if (secretCache && Date.now() - secretCache.at < SECRET_TTL_MS) return secretCache.cfg;
    let secret = {};
    try {
      secret = (await d.getSecret(TWILIO_SECRET_NAME)) || {};
    } catch (e) {
      console.error("sms: cannot read", TWILIO_SECRET_NAME, e?.message);
      return twilioConfigFrom({}, d.env); // no creds → sends refuse, webhooks fail closed
    }
    const cfg = twilioConfigFrom(secret, d.env);
    secretCache = { cfg, at: Date.now() };
    return cfg;
  }

  const tenantIdCache = new Map(); // slug → { id, at }
  async function tenantIdForSlug(slug) {
    if (!slug) return null;
    const hit = tenantIdCache.get(slug);
    if (hit && Date.now() - hit.at < SECRET_TTL_MS) return hit.id;
    const rows = await d.sfQuery(`SELECT Id, Name FROM ${TENANT_SF_OBJECT} WHERE Name = '${soqlEscapeString(slug)}' LIMIT 1`);
    const id = rows?.[0]?.Id ?? null;
    if (id) tenantIdCache.set(slug, { id, at: Date.now() });
    return id;
  }

  async function loadJob(id, tenantId) {
    const rows = await d.sfQuery(
      `SELECT ${JOB_SELECT} FROM ${JOB_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
    );
    return rows?.[0] ?? null;
  }
  /** The customer's CURRENT phone wins over the job's snapshot (same rule as email). */
  async function customerPhoneFor(job, tenantId) {
    if (job?.Sundial_Customer__c) {
      const rows = await d.sfQuery(
        `SELECT Id, Primary_Phone__c FROM ${CUSTOMER_SF_OBJECT} WHERE Id = '${soqlEscapeString(job.Sundial_Customer__c)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
      );
      const e = toE164(rows?.[0]?.Primary_Phone__c);
      if (e) return e;
    }
    return toE164(job?.Primary_Phone_at_Creation__c);
  }
  async function listThread(tenantId, jobId) {
    const supabase = await d.getSupabaseClient();
    const { data, error } = await supabase
      .from(SMS_TABLE)
      .select("*")
      .eq("client_sf_id", tenantId)
      .eq("job_sf_id", jobId)
      .order("created_at", { ascending: true })
      .limit(THREAD_LIMIT);
    if (error) throw new Error(`sms list: ${error.message}`);
    return (data || []).map(messageToView);
  }
  function announce(tenantId, jobId, payload) {
    if (!jobId) return Promise.resolve({ ok: false, reason: "no job" });
    return d.broadcast(recordChannel(tenantId, "sundial_service_job", jobId), "sms", payload).catch(() => ({ ok: false }));
  }

  /**
   * Find the job an inbound text belongs to. See the header for the order. Returns
   * { jobId, customerId } with nulls when nothing fits.
   */
  async function matchInbound(tenantId, fromNumber) {
    const ten = last10(fromNumber);
    if (!ten) return { jobId: null, customerId: null, how: "none" };
    // (1) The conversation we started.
    const supabase = await d.getSupabaseClient();
    const { data: prior } = await supabase
      .from(SMS_TABLE)
      .select("job_sf_id, customer_sf_id")
      .eq("client_sf_id", tenantId)
      .eq("direction", "out")
      .eq("to_number", toE164(fromNumber))
      .not("job_sf_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    if (prior?.[0]?.job_sf_id) return { jobId: prior[0].job_sf_id, customerId: prior[0].customer_sf_id ?? null, how: "conversation" };
    // (2) A job whose phone snapshot matches — open ones first, newest first.
    const like = `'%${soqlEscapeString(ten.slice(-4))}'`;
    const jobs = await d.sfQuery(
      `SELECT Id, Status__c, Sundial_Customer__c, Primary_Phone_at_Creation__c, CreatedDate FROM ${JOB_SF_OBJECT} ` +
        `WHERE Client__c = '${soqlEscapeString(tenantId)}' AND Primary_Phone_at_Creation__c LIKE ${like} ORDER BY CreatedDate DESC LIMIT 50`
    );
    const hits = (jobs || []).filter((j) => last10(j.Primary_Phone_at_Creation__c) === ten);
    const open = hits.find((j) => !CLOSED_JOB_STATUSES.includes(j.Status__c));
    const pick = open ?? hits[0];
    if (pick) return { jobId: pick.Id, customerId: pick.Sundial_Customer__c ?? null, how: open ? "open-job" : "closed-job" };
    // (3) The customer hub, then their latest job.
    const custs = await d.sfQuery(
      `SELECT Id, Primary_Phone__c FROM ${CUSTOMER_SF_OBJECT} WHERE Client__c = '${soqlEscapeString(tenantId)}' AND Primary_Phone__c LIKE ${like} LIMIT 50`
    );
    const cust = (custs || []).find((c) => last10(c.Primary_Phone__c) === ten);
    if (!cust) return { jobId: null, customerId: null, how: "none" };
    const theirs = await d.sfQuery(
      `SELECT Id, Status__c FROM ${JOB_SF_OBJECT} WHERE Client__c = '${soqlEscapeString(tenantId)}' AND Sundial_Customer__c = '${soqlEscapeString(cust.Id)}' ORDER BY CreatedDate DESC LIMIT 20`
    );
    const openJob = (theirs || []).find((j) => !CLOSED_JOB_STATUSES.includes(j.Status__c)) ?? theirs?.[0];
    return { jobId: openJob?.Id ?? null, customerId: cust.Id, how: openJob ? "customer" : "customer-no-job" };
  }

  const H = {
    // --- GET /service/jobs/{id}/sms -------------------------------------------------
    async getThread({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return jsonResponse(404, cors, { error: "not_found", code: "JOB_NOT_FOUND" });
      const cfg = await config();
      const from = fromNumberFor(cfg, ctx.tenantSlug ?? job.Client__r?.Name);
      const to = await customerPhoneFor(job, tenantId);
      const messages = await listThread(tenantId, job.Id);
      return jsonResponse(200, cors, {
        jobId: job.Id,
        jobNumber: job.Name ?? null,
        customerName: job.Customer_Name_at_Creation__c ?? null,
        customerPhone: to,
        customerPhonePretty: to ? prettyPhone(to) : null,
        fromNumber: from,
        fromNumberPretty: from ? prettyPhone(from) : null,
        canSend: !!(cfg.accountSid && cfg.authToken && from),
        notConfiguredReason: !cfg.accountSid || !cfg.authToken ? "Texting isn't set up yet (no Twilio credentials)." : !from ? "No sending number is configured for this tenant." : null,
        messages,
      });
    },

    // --- POST /service/jobs/{id}/sms -------------------------------------------------
    async sendText({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const text = typeof body?.body === "string" ? body.body.trim() : "";
      if (!text) return jsonResponse(400, cors, { error: "bad_request", code: "EMPTY_BODY", message: "Type a message first." });
      if (text.length > MAX_BODY_CHARS) return jsonResponse(400, cors, { error: "bad_request", code: "BODY_TOO_LONG", message: `Keep it under ${MAX_BODY_CHARS} characters.` });
      const job = await loadJob(params[0], tenantId);
      if (!job) return jsonResponse(404, cors, { error: "not_found", code: "JOB_NOT_FOUND" });
      const cfg = await config();
      const from = fromNumberFor(cfg, ctx.tenantSlug ?? job.Client__r?.Name);
      if (!cfg.accountSid || !cfg.authToken || !from) {
        return jsonResponse(503, cors, { error: "not_configured", code: "SMS_NOT_CONFIGURED", message: "Texting isn't set up for this tenant yet." });
      }
      const to = body?.to != null && body.to !== "" ? toE164(body.to) : await customerPhoneFor(job, tenantId);
      if (!to) return jsonResponse(400, cors, { error: "bad_request", code: "NO_PHONE", message: "This job has no mobile number to text. Add one on the customer." });

      const statusCallback = cfg.webhookBase ? `${cfg.webhookBase.replace(/\/+$/, "")}/sms/status` : null;
      const sent = await d.sendSms({ accountSid: cfg.accountSid, authToken: cfg.authToken }, { from, to, body: text, statusCallback });

      const row = {
        client_sf_id: tenantId,
        tenant_id: ctx.tenantSlug ?? job.Client__r?.Name ?? null,
        direction: "out",
        job_sf_id: job.Id,
        customer_sf_id: job.Sundial_Customer__c ?? null,
        from_number: from,
        to_number: to,
        body: text,
        status: sent.ok ? sent.status || "queued" : "failed",
        error_code: sent.ok ? null : sent.code ?? null,
        provider_sid: sent.ok ? sent.sid : null,
        sent_by_user_sf_id: ctx.userId,
        sent_by_name: ctx.actor?.name ?? null,
        created_at: d.now().toISOString(),
        updated_at: d.now().toISOString(),
      };
      const supabase = await d.getSupabaseClient();
      const { data, error } = await supabase.from(SMS_TABLE).insert(row).select().single();
      if (error) console.error("sms insert error:", error.message);
      const view = data ? messageToView(data) : messageToView({ ...row, id: null });
      await announce(tenantId, job.Id, { kind: "sent", message: view });
      if (!sent.ok) {
        console.warn("sms send failed:", sent.code, sent.error);
        return jsonResponse(502, cors, { error: "send_failed", code: "SMS_SEND_FAILED", message: `The text was not sent (${sent.error}).`, message_row: view });
      }
      return jsonResponse(200, cors, { success: true, message: view });
    },

    // --- GET /service/sms/unmatched --------------------------------------------------
    async unmatched({ ctx }) {
      const supabase = await d.getSupabaseClient();
      const { data, error } = await supabase
        .from(SMS_TABLE)
        .select("*")
        .eq("client_sf_id", ctx.tenantId)
        .is("job_sf_id", null)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new Error(`sms unmatched: ${error.message}`);
      return jsonResponse(200, ctx.cors, { messages: (data || []).map(messageToView) });
    },

    // --- POST /sms/inbound (Twilio) --------------------------------------------------
    async inbound({ params, headers }) {
      const cfg = await config();
      const slug = tenantSlugForNumber(cfg, params.To);
      const tenantId = await tenantIdForSlug(slug);
      if (!tenantId) {
        console.warn(`sms inbound: no tenant for the To number (…${digitsOf(params.To).slice(-4)}); slug=${slug ?? "none"} — set defaultTenant / tenantNumbers in sundial/twilio and check Sundial_Tenant__c.Name`);
        return twiml(200); // acknowledged, nothing to do; Twilio must not retry
      }
      const from = toE164(params.From);
      if (!from || !params.MessageSid) return twiml(200);
      const match = await matchInbound(tenantId, from);
      const row = {
        client_sf_id: tenantId,
        tenant_id: slug,
        direction: "in",
        job_sf_id: match.jobId,
        customer_sf_id: match.customerId,
        from_number: from,
        to_number: toE164(params.To) ?? String(params.To ?? ""),
        body: String(params.Body ?? ""),
        media: mediaFrom(params),
        status: "received",
        provider_sid: params.MessageSid,
        created_at: d.now().toISOString(),
        updated_at: d.now().toISOString(),
      };
      const supabase = await d.getSupabaseClient();
      // Idempotent on the Twilio sid: a redelivery updates nothing and creates nothing.
      const { data, error } = await supabase.from(SMS_TABLE).upsert(row, { onConflict: "provider_sid", ignoreDuplicates: true }).select();
      if (error) {
        console.error("sms inbound insert error:", error.message);
        return twiml(500); // let Twilio retry
      }
      console.log(`sms inbound: sid ${params.MessageSid} tenant ${slug} (${tenantId}) matched=${match.how} job=${match.jobId ?? "-"} stored=${data?.length ? "new" : "duplicate"}`);
      if (data?.[0]) await announce(tenantId, match.jobId, { kind: "received", message: messageToView(data[0]) });
      return twiml(200);
    },

    // --- POST /sms/status (Twilio delivery callback) ---------------------------------
    async status({ params }) {
      const sid = str(params.MessageSid ?? params.SmsSid);
      const status = str(params.MessageStatus ?? params.SmsStatus);
      if (!sid || !status) return twiml(200);
      const supabase = await d.getSupabaseClient();
      const { data } = await supabase
        .from(SMS_TABLE)
        .update({ status, error_code: str(params.ErrorCode), updated_at: d.now().toISOString() })
        .eq("provider_sid", sid)
        .select();
      const r = data?.[0];
      if (r) await announce(r.client_sf_id, r.job_sf_id, { kind: "status", message: messageToView(r) });
      return twiml(200);
    },
  };

  function twiml(status) {
    return { statusCode: status, headers: { "Content-Type": "text/xml" }, body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>' };
  }

  return async function handler(event) {
    const method = httpMethod(event);
    const headers = normalizeHeaders(event?.headers);
    const cors = corsHeaders(headers["origin"]);
    if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
    const route = matchRoute(method, event?.rawPath || event?.path || "");
    if (!route) return jsonResponse(404, cors, { error: "not_found", code: "ROUTE_NOT_FOUND" });

    if (PUBLIC_ROUTES.has(route.name)) {
      // Twilio signature gate — the only protection on these two routes.
      const cfg = await config();
      if (!cfg.authToken) {
        console.error("sms webhook rejected: sundial/twilio has no authToken — failing closed.");
        return jsonResponse(401, cors, { error: "unauthorized" });
      }
      const params = parseFormBody(event);
      const urls = requestUrls(event, headers, cfg.webhookBase);
      const signature = headers["x-twilio-signature"];
      if (!urls.some((url) => validateSignature(cfg.authToken, url, params, signature))) {
        // The URL spellings tried are logged (no secrets in them) — a mismatch here is
        // nearly always the console URL vs SMS_WEBHOOK_BASE, and this line says which.
        console.warn(`sms webhook rejected: ${signature ? "invalid" : "missing"} X-Twilio-Signature; tried ${urls.map((u) => u.replace(/\?.*$/, "")).join(" | ")}; params ${Object.keys(params).length}`);
        return jsonResponse(401, cors, { error: "unauthorized" });
      }
      try {
        return await H[route.name]({ params, headers });
      } catch (err) {
        console.error(`sms ${route.name} error:`, err?.message || err);
        return jsonResponse(500, cors, { error: "server_error" });
      }
    }

    let identity;
    try {
      identity = await d.resolveIdentity(headers["authorization"]);
    } catch (err) {
      const m = mapIdentityError(err?.code);
      if (m) return jsonResponse(m.status, cors, m.body);
      console.error("identity error:", err?.message || err);
      return jsonResponse(500, cors, { error: "server_error" });
    }
    const tenantId = identity?.tenantId;
    if (!tenantId) return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });
    const denied = assertAction(ACTION_FOR[route.name], alwaysEnforcedAccess(identity));
    if (denied) return jsonResponse(denied.status, cors, denied.body);

    let body = {};
    if (method !== "GET") {
      const parsed = parseJsonBody(event);
      if (!parsed.ok && event?.body) return jsonResponse(400, cors, { error: "bad_request", code: "INVALID_BODY", message: "Body must be JSON." });
      body = parsed.ok ? parsed.data : {};
    }
    try {
      const u = identity?.user ?? {};
      const ctx = {
        tenantId,
        tenantSlug: identity?.tenantSlug ?? null,
        userId: u.id ?? null,
        actor: { id: u.id ?? null, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || null },
        cors,
      };
      return await H[route.name]({ ctx, params: route.params, body, query: event?.queryStringParameters || {} });
    } catch (err) {
      console.error(`sms ${route.name} error:`, err?.message || err);
      return jsonResponse(500, cors, { error: "server_error", route: route.name });
    }
  };
}

export const handler = createHandler();
