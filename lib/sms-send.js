// lib/sms-send.js — the ONE way Sundial sends a customer a text (D-072 amendment 7).
//
// Extracted from lambdas/sundial-sms on 2026-09-16 so the dispatch board can send the
// tech's "on my way" text through exactly the code the office's Communications panel
// uses: same secret, same tenant→number rule, same `sundial_sms_messages` row, same
// Realtime broadcast to the job page. A text sent from anywhere lands in the job's
// thread, and a customer reply matches back to that job by the conversation rule.
//
// Secrets Manager `sundial/twilio`:
//   { accountSid, authToken, fromNumber, tenantNumbers?: { "<slug>": "+1…" }, defaultTenant?: "<slug>" }
// A tenant texts from tenantNumbers[slug] when it has one, else the shared fromNumber.
// Env (non-secret knobs): SMS_WEBHOOK_BASE (status callback + inbound signature base),
// SMS_DEFAULT_TENANT.
//
// Value-safety: never logs the auth token, a phone number in full, or a message body.

import { getSecret as realGetSecret } from "./secrets.js";
import { getSupabaseClient as realGetSupabaseClient } from "./supabase.js";
import { sfQuery as realSfQuery, soqlEscapeString } from "./salesforce.js";
import { broadcast as realBroadcast, recordChannel } from "./realtime.js";
import { prettyPhone, sendSms as realSendSms, toE164 } from "./twilio.js";

export const SMS_TABLE = "sundial_sms_messages";
export const TWILIO_SECRET_NAME = "sundial/twilio";
export const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";
export const MAX_BODY_CHARS = 1600; // Twilio's ceiling for a concatenated SMS
const SECRET_TTL_MS = 5 * 60 * 1000;

function str(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
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

/**
 * The number to text for a job: the customer's CURRENT phone wins over the job's
 * snapshot (same rule as email). Null when neither is a usable North American number.
 */
export async function customerPhoneFor(sfQuery, job, tenantId) {
  if (job?.Sundial_Customer__c) {
    const rows = await sfQuery(
      `SELECT Id, Primary_Phone__c FROM ${CUSTOMER_SF_OBJECT} WHERE Id = '${soqlEscapeString(job.Sundial_Customer__c)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
    );
    const e = toE164(rows?.[0]?.Primary_Phone__c);
    if (e) return e;
  }
  return toE164(job?.Primary_Phone_at_Creation__c);
}

/**
 * A sender bound to one set of dependencies (all injectable for tests). Holds the
 * five-minute secret cache, so create one per Lambda instance, not per request.
 */
export function createSmsSender(deps = {}) {
  const d = {
    getSecret: realGetSecret,
    getSupabaseClient: realGetSupabaseClient,
    sfQuery: realSfQuery,
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

  function announce(tenantId, jobId, payload) {
    if (!jobId) return Promise.resolve({ ok: false, reason: "no job" });
    return d.broadcast(recordChannel(tenantId, "sundial_service_job", jobId), "sms", payload).catch(() => ({ ok: false }));
  }

  /**
   * Send one text to a job's customer and record it on the thread.
   *
   * @param {{ tenantId:string, tenantSlug?:string|null, job:object, to?:string|null,
   *           body:string, sentBy?:{id?:string|null,name?:string|null} }} args
   *   `job` needs Id, Sundial_Customer__c, Primary_Phone_at_Creation__c (and
   *   Client__r.Name as a slug fallback). `to` overrides the customer lookup.
   * @returns {Promise<{ ok:boolean, code:string|null, error:string|null, to:string|null,
   *                    message:object|null }>}
   *   code: null on success; NOT_CONFIGURED / NO_PHONE / EMPTY_BODY / BODY_TOO_LONG
   *   before any send; SEND_FAILED (row stored as `failed`) after one.
   */
  async function sendText({ tenantId, tenantSlug = null, job, to = null, body, sentBy = {} }) {
    const text = typeof body === "string" ? body.trim() : "";
    if (!text) return { ok: false, code: "EMPTY_BODY", error: "Type a message first.", to: null, message: null };
    if (text.length > MAX_BODY_CHARS) return { ok: false, code: "BODY_TOO_LONG", error: `Keep it under ${MAX_BODY_CHARS} characters.`, to: null, message: null };
    const cfg = await config();
    const slug = tenantSlug ?? job?.Client__r?.Name ?? null;
    const from = fromNumberFor(cfg, slug);
    if (!cfg.accountSid || !cfg.authToken || !from) {
      return { ok: false, code: "NOT_CONFIGURED", error: "Texting isn't set up for this tenant yet.", to: null, message: null };
    }
    const dest = to != null && to !== "" ? toE164(to) : await customerPhoneFor(d.sfQuery, job, tenantId);
    if (!dest) return { ok: false, code: "NO_PHONE", error: "This job has no mobile number to text. Add one on the customer.", to: null, message: null };

    const statusCallback = cfg.webhookBase ? `${cfg.webhookBase.replace(/\/+$/, "")}/sms/status` : null;
    const sent = await d.sendSms({ accountSid: cfg.accountSid, authToken: cfg.authToken }, { from, to: dest, body: text, statusCallback });

    const at = d.now().toISOString();
    const row = {
      client_sf_id: tenantId,
      tenant_id: slug,
      direction: "out",
      job_sf_id: job?.Id ?? null,
      customer_sf_id: job?.Sundial_Customer__c ?? null,
      from_number: from,
      to_number: dest,
      body: text,
      status: sent.ok ? sent.status || "queued" : "failed",
      error_code: sent.ok ? null : sent.code ?? null,
      provider_sid: sent.ok ? sent.sid : null,
      sent_by_user_sf_id: sentBy?.id ?? null,
      sent_by_name: sentBy?.name ?? null,
      created_at: at,
      updated_at: at,
    };
    let view = messageToView({ ...row, id: null });
    try {
      const supabase = await d.getSupabaseClient();
      const { data, error } = await supabase.from(SMS_TABLE).insert(row).select().single();
      if (error) console.error("sms insert error:", error.message);
      else if (data) view = messageToView(data);
    } catch (e) {
      console.error("sms insert threw:", e?.message || String(e));
    }
    await announce(tenantId, job?.Id ?? null, { kind: "sent", message: view });
    if (!sent.ok) {
      console.warn("sms send failed:", sent.code, sent.error);
      return { ok: false, code: "SEND_FAILED", error: `The text was not sent (${sent.error}).`, to: dest, message: view };
    }
    return { ok: true, code: null, error: null, to: dest, message: view };
  }

  return { config, sendText, announce };
}
