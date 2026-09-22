// sundial-notify — the notification service's own routes + the reminder sweep (D-074).
//
//   GET    /notify/config              { pushConfigured, publicKey }  the VAPID public key the
//                                       browser subscribes with (never the private one)
//   POST   /notify/subscriptions       { endpoint, keys:{p256dh,auth}, app? }  turn push on for
//                                       THIS browser / phone — the row is stamped with the
//                                       caller's verified identity, never request input
//   DELETE /notify/subscriptions       { endpoint }  turn it off (only the caller's own row)
//   POST   /notify/test                ring the caller: a bell row + a push to their devices
//   (EventBridge, every 5 minutes)     the sweep — see below
//
// EVERYTHING ELSE that notifies lives where the event happens: the dispatch board
// (schedule changes, tech activity), sundial-sms (customer texts), the estimate Lambda
// (approvals, payments, the club), sundial-comment-notify (@-mentions) — each through
// lib/notify.js. This Lambda only owns the routes above and the time-based events
// nothing else can see happening:
//
//   reminder / one_hour   a tech's call starts within the hour            → the tech
//   reminder / day_before tomorrow's calls, once, at REMINDER_HOUR local   → the tech
//   tech_activity / late  a Scheduled call 30+ minutes past its start with
//                         no tap from the tech                             → the office
//
// Every sweep notification carries a dedupe key ({kind}:{callId}[:{day}]), so a sweep
// that runs every five minutes re-finds the same calls and rings nobody twice. The
// sweep is a system process with no tenant of its own: it reads calls across tenants in
// ONE query and routes each by its Client__c — every row it writes is tenant-stamped.
//
// TENANT ISOLATION on the HTTP routes: the recipient / owner of every row is
// identity.authUserId (the JWT subject). A subscription can only be removed by the
// profile that created it. Action `notify.self` (every signed-in scope but none).
//
// Value-safety: never logs an endpoint, a key, or a notification body.

import { resolveIdentity as realResolveIdentity } from "../../lib/identity.js";
import { sfQuery as realSfQuery, soqlEscapeString } from "../../lib/salesforce.js";
import { getSupabaseClient as realGetSupabaseClient } from "../../lib/supabase.js";
import { getSecret as realGetSecret } from "../../lib/secrets.js";
import { broadcast as realBroadcast } from "../../lib/realtime.js";
import { alwaysEnforcedAccess, assertAction } from "../../lib/access-enforce.js";
import { corsHeaders, normalizeHeaders, jsonResponse, mapIdentityError, parseJsonBody, httpMethod } from "../../lib/http.js";
import { CATEGORIES, SUBSCRIPTIONS_TABLE, createNotifier, fmtTime, jobLabel, realSendPush } from "../../lib/notify.js";

export const CALL_SF_OBJECT = "Sundial_Service_Call__c";
export const ONE_HOUR_WINDOW_MIN = 65; // a 5-minute sweep must not miss a call that starts in exactly 60
export const LATE_AFTER_MIN = 30;
export const LATE_LOOKBACK_HOURS = 12; // older than this is yesterday's problem, not a live alert
export const DAY_BEFORE_HOUR = Number(process.env.REMINDER_HOUR || 17); // 5 pm local

export const CALL_SELECT =
  "Id, Name, Client__c, Client__r.Name, Tech__c, Status__c, Scheduled_Start__c, Scheduled_End__c, Sundial_Service_Job__c, " +
  "Sundial_Service_Job__r.Name, Sundial_Service_Job__r.Customer_Name_at_Creation__c, Sundial_Service_Job__r.Address_at_Creation__c, " +
  "Tech__r.First_Name__c, Tech__r.Last_Name__c";

const ROUTES = [
  ["GET", /^\/notify\/config\/?$/, "config"],
  ["POST", /^\/notify\/subscriptions\/?$/, "subscribe"],
  ["DELETE", /^\/notify\/subscriptions\/?$/, "unsubscribe"],
  ["POST", /^\/notify\/test\/?$/, "test"],
];
const ACTION = "notify.self";

export function matchRoute(method, path) {
  const p = (path || "").replace(/^\/(?!notify\/)[^/]+(?=\/notify\/)/, "");
  for (const [m, re, name] of ROUTES) {
    if (m !== method) continue;
    const hit = p.match(re);
    if (hit) return { name, params: hit.slice(1).map((s) => decodeURIComponent(s)) };
  }
  return null;
}

/** EventBridge's scheduled-event shape, or our own { sweep: true } for a manual run. */
export function isSweepEvent(event) {
  return !!event && (event.sweep === true || event.source === "aws.events" || event["detail-type"] === "Scheduled Event");
}

function str(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
const techName = (r) => [r?.First_Name__c, r?.Last_Name__c].filter(Boolean).join(" ").trim() || null;

/** Local calendar day (YYYY-MM-DD) and hour of a moment in a time zone. */
export function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hour12: false }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}
/** The local day after `day` (YYYY-MM-DD), computed on the calendar, not by adding 24h. */
export function nextDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

export function createHandler(deps = {}) {
  const d = {
    resolveIdentity: realResolveIdentity,
    sfQuery: realSfQuery,
    getSupabaseClient: realGetSupabaseClient,
    getSecret: realGetSecret,
    broadcast: realBroadcast,
    sendPush: realSendPush,
    now: () => new Date(),
    env: process.env,
    ...deps,
  };
  const timeZone = d.env.SERVICE_TIMEZONE || "America/Phoenix";
  const notifier = deps.notifier ?? createNotifier({ getSupabaseClient: d.getSupabaseClient, getSecret: d.getSecret, broadcast: d.broadcast, sendPush: d.sendPush, now: d.now, env: d.env });

  const H = {
    // --- GET /notify/config -----------------------------------------------------------
    async config({ ctx }) {
      const cfg = await notifier.pushConfig();
      return jsonResponse(200, ctx.cors, { pushConfigured: cfg.configured, publicKey: cfg.configured ? cfg.publicKey : null });
    },

    // --- POST /notify/subscriptions ---------------------------------------------------
    async subscribe({ ctx, body }) {
      const { cors } = ctx;
      const sub = body?.subscription && typeof body.subscription === "object" ? body.subscription : body;
      const endpoint = str(sub?.endpoint);
      const p256dh = str(sub?.keys?.p256dh);
      const auth = str(sub?.keys?.auth);
      if (!endpoint || !p256dh || !auth) return jsonResponse(400, cors, { error: "bad_request", code: "SUBSCRIPTION_INVALID", message: "The browser did not hand us a complete push subscription." });
      if (!/^https:\/\//i.test(endpoint) || endpoint.length > 2000) return jsonResponse(400, cors, { error: "bad_request", code: "ENDPOINT_INVALID" });
      const app = body?.app === "tech" ? "tech" : "office";
      const cfg = await notifier.pushConfig();
      if (!cfg.configured) return jsonResponse(503, cors, { error: "not_configured", code: "PUSH_NOT_CONFIGURED", message: "Push isn't set up on the server yet (no VAPID keys)." });
      const supabase = await d.getSupabaseClient();
      const now = d.now().toISOString();
      const row = {
        client_sf_id: ctx.tenantId,
        profile_id: ctx.profileId,
        user_sf_id: ctx.userId,
        endpoint,
        p256dh,
        auth,
        user_agent: str(ctx.userAgent)?.slice(0, 300) ?? null,
        app,
        last_seen_at: now,
        failed_at: null,
        fail_reason: null,
      };
      // The endpoint is unique per browser install: re-subscribing (a new key pair, a
      // reinstalled app) replaces the row. A row that belonged to ANOTHER profile on the
      // same browser (a shared iPad, a sign-out / sign-in) moves to the current one —
      // pushes follow whoever is signed in on that device.
      const { error } = await supabase.from(SUBSCRIPTIONS_TABLE).upsert(row, { onConflict: "endpoint" });
      if (error) {
        console.error("notify subscribe: upsert failed:", error.message);
        return jsonResponse(500, cors, { error: "server_error", code: "SUBSCRIBE_FAILED" });
      }
      const { count } = await supabase.from(SUBSCRIPTIONS_TABLE).select("id", { count: "exact", head: true }).eq("profile_id", ctx.profileId);
      console.log(`notify subscribe: profile ${ctx.profileId} app=${app} devices=${count ?? "?"}`);
      return jsonResponse(200, cors, { success: true, app, devices: count ?? null });
    },

    // --- DELETE /notify/subscriptions -------------------------------------------------
    async unsubscribe({ ctx, body }) {
      const { cors } = ctx;
      const endpoint = str(body?.endpoint) ?? str(body?.subscription?.endpoint);
      if (!endpoint) return jsonResponse(400, cors, { error: "bad_request", code: "ENDPOINT_REQUIRED" });
      const supabase = await d.getSupabaseClient();
      const { data, error } = await supabase.from(SUBSCRIPTIONS_TABLE).delete().eq("endpoint", endpoint).eq("profile_id", ctx.profileId).select("id");
      if (error) {
        console.error("notify unsubscribe: delete failed:", error.message);
        return jsonResponse(500, cors, { error: "server_error", code: "UNSUBSCRIBE_FAILED" });
      }
      return jsonResponse(200, cors, { success: true, removed: data?.length ?? 0 });
    },

    // --- POST /notify/test ------------------------------------------------------------
    async test({ ctx }) {
      const r = await notifier.toProfile({
        tenantId: ctx.tenantId,
        profileId: ctx.profileId,
        userSfId: ctx.userId,
        category: CATEGORIES.MENTION, // the one category both audiences share; a test must not be filtered out by a switch
        kind: "test",
        title: "Sundial notifications are on",
        body: `Test sent ${fmtTime(d.now().toISOString(), timeZone)}. You'll get alerts here and on any device where you turned push on.`,
        url: "/dashboard",
        push: true,
      });
      return jsonResponse(200, ctx.cors, { success: true, ...r });
    },
  };

  // --- the sweep ----------------------------------------------------------------------
  async function sweep() {
    const now = d.now();
    const iso = (t) => new Date(t).toISOString();
    const summary = { oneHour: 0, dayBefore: 0, late: 0, techsReminded: 0 };

    // (1) One hour out: Scheduled calls starting within the next 65 minutes.
    const soon = await d.sfQuery(
      `SELECT ${CALL_SELECT} FROM ${CALL_SF_OBJECT} WHERE Status__c = 'Scheduled' AND Tech__c != null ` +
        `AND Scheduled_Start__c >= ${iso(now.getTime())} AND Scheduled_Start__c <= ${iso(now.getTime() + ONE_HOUR_WINDOW_MIN * 60000)} ORDER BY Scheduled_Start__c LIMIT 500`
    );
    for (const c of soon || []) {
      const job = c.Sundial_Service_Job__r;
      const r = await notifier.toUsers({
        tenantId: c.Client__c,
        userSfIds: [c.Tech__c],
        category: CATEGORIES.REMINDER,
        kind: "one_hour",
        title: `Up next at ${fmtTime(c.Scheduled_Start__c, timeZone)}: ${jobLabel(job)}`,
        body: job?.Address_at_Creation__c ?? null,
        url: `/tech/calls/${c.Id}`,
        recordType: "servicecall",
        recordSfId: c.Id,
        dedupeKey: `reminder:one_hour:${c.Id}`,
      });
      summary.oneHour += r.inserted;
    }

    // (2) Tomorrow's calls, once per tech, in the early evening (local). The dedupe key is
    // per tech per day, so every sweep between REMINDER_HOUR:00 and :59 tries and only the
    // first one lands. A call added AFTER that still reaches the tech through "schedule".
    const local = localParts(now, timeZone);
    if (local.hour === DAY_BEFORE_HOUR) {
      const tomorrow = nextDay(local.day);
      // Salesforce compares datetimes in UTC; a local day is [00:00, 24:00) in the tenant's
      // zone. Cheap and exact enough: pull a 48h window and bucket by local day here.
      const rows = await d.sfQuery(
        `SELECT ${CALL_SELECT} FROM ${CALL_SF_OBJECT} WHERE Status__c = 'Scheduled' AND Tech__c != null ` +
          `AND Scheduled_Start__c >= ${iso(now.getTime())} AND Scheduled_Start__c <= ${iso(now.getTime() + 48 * 3600000)} ORDER BY Scheduled_Start__c LIMIT 1000`
      );
      const byTech = new Map(); // `${tenant}|${tech}` → calls
      for (const c of rows || []) {
        if (localParts(new Date(Date.parse(c.Scheduled_Start__c)), timeZone).day !== tomorrow) continue;
        const k = `${c.Client__c}|${c.Tech__c}`;
        if (!byTech.has(k)) byTech.set(k, []);
        byTech.get(k).push(c);
      }
      for (const [k, calls] of byTech) {
        const [tenantId, techId] = k.split("|");
        const first = calls[0];
        const n = calls.length;
        const r = await notifier.toUsers({
          tenantId,
          userSfIds: [techId],
          category: CATEGORIES.REMINDER,
          kind: "day_before",
          title: `Tomorrow: ${n} call${n === 1 ? "" : "s"}, first at ${fmtTime(first.Scheduled_Start__c, timeZone)}`,
          body: calls.slice(0, 4).map((c) => `${fmtTime(c.Scheduled_Start__c, timeZone)} ${jobLabel(c.Sundial_Service_Job__r)}`).join(" · ") + (n > 4 ? ` · +${n - 4} more` : ""),
          url: "/tech",
          recordType: null,
          recordSfId: null,
          dedupeKey: `reminder:day_before:${techId}:${tomorrow}`,
        });
        summary.dayBefore += r.inserted;
        if (r.inserted) summary.techsReminded += 1;
      }
    }

    // (3) Running late: still Scheduled 30+ minutes after the start (no en-route / clock-in
    // tap), within the last 12 hours. The office decides what to do; nothing here moves
    // the call.
    const late = await d.sfQuery(
      `SELECT ${CALL_SELECT} FROM ${CALL_SF_OBJECT} WHERE Status__c = 'Scheduled' ` +
        `AND Scheduled_Start__c <= ${iso(now.getTime() - LATE_AFTER_MIN * 60000)} AND Scheduled_Start__c >= ${iso(now.getTime() - LATE_LOOKBACK_HOURS * 3600000)} ORDER BY Scheduled_Start__c LIMIT 500`
    );
    for (const c of late || []) {
      const job = c.Sundial_Service_Job__r;
      const who = techName(c.Tech__r) ?? "No tech";
      const r = await notifier.toOffice({
        tenantId: c.Client__c,
        category: CATEGORIES.TECH_ACTIVITY,
        kind: "late",
        title: `${who} hasn't started ${c.Name ?? "a call"} (${fmtTime(c.Scheduled_Start__c, timeZone)})`,
        body: jobLabel(job),
        url: c.Sundial_Service_Job__c ? `/service/jobs/${c.Sundial_Service_Job__c}` : "/service/dispatch",
        recordType: "servicecall",
        recordSfId: c.Id,
        dedupeKey: `late:${c.Id}`,
      });
      summary.late += r.inserted;
    }
    console.log(`notify sweep: ${JSON.stringify(summary)} at ${now.toISOString()} (${timeZone} ${local.day} ${local.hour}h)`);
    return summary;
  }

  return async function handler(event) {
    if (isSweepEvent(event)) {
      try {
        return { ok: true, ...(await sweep()) };
      } catch (err) {
        console.error("notify sweep error:", err?.sfBody || err?.message || err);
        return { ok: false, error: err?.message || String(err) };
      }
    }

    const method = httpMethod(event);
    const headers = normalizeHeaders(event?.headers);
    const cors = corsHeaders(headers["origin"]);
    if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
    const route = matchRoute(method, event?.rawPath || event?.path || "");
    if (!route) return jsonResponse(404, cors, { error: "not_found", code: "ROUTE_NOT_FOUND" });

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
    const denied = assertAction(ACTION, alwaysEnforcedAccess(identity));
    if (denied) return jsonResponse(denied.status, cors, denied.body);
    const profileId = str(identity?.authUserId);
    if (!profileId) return jsonResponse(403, cors, { error: "no_profile", code: "NO_AUTH_USER" });

    let body = {};
    if (method !== "GET") {
      const parsed = parseJsonBody(event);
      if (!parsed.ok && event?.body) return jsonResponse(400, cors, { error: "bad_request", code: "INVALID_BODY", message: "Body must be JSON." });
      body = parsed.ok ? parsed.data : {};
    }
    try {
      const ctx = { tenantId, profileId, userId: identity?.user?.id ?? null, userAgent: headers["user-agent"] ?? null, cors };
      return await H[route.name]({ ctx, params: route.params, body });
    } catch (err) {
      console.error(`notify ${route.name} error:`, err?.message || err);
      return jsonResponse(500, cors, { error: "server_error", route: route.name });
    }
  };
}

export const handler = createHandler();
