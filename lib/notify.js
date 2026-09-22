// lib/notify.js — the ONE way Sundial tells a person something happened (D-074, 2026-09-21).
//
// Three deliveries from one call:
//   1. a row in `sundial_notifications` — the bell's list; the truth an open tab re-reads
//   2. a Realtime broadcast on `user:{profile_id}:notify` — an open tab rings at once
//   3. a Web Push to every browser / phone that opted in (`sundial_push_subscriptions`)
//
// WHO IS A RECIPIENT. The recipient key is the Supabase auth uuid (`profiles.id`) —
// what the browser's RLS compares against — never a Sundial_User__c id. The emitters
// know the Salesforce side (a call's Tech__c, an actor's user id), so this module
// translates through `public.profiles.sundial_user_id`, which sundial-auth-proxy stamps
// on every /auth/me. A tech who has never signed in has no profile and gets nothing —
// correct: there is no device to reach.
//
// TWO AUDIENCES, seven categories (Tim's scope, 2026-09-19):
//   techs   schedule (a call put on / moved on / taken off their board), mention,
//           customer_text (a reply on today's job), reminder (day-before + one-hour)
//   office  tech_activity (clocked in / complete / no-show / a call running late),
//           money (approved / declined / paid / failed / club join + cancel),
//           customer_message (an inbound text, a website call-me), mention
// "The office" = every profile in the tenant with access_scope = 'tenant'. Each person
// can switch a category off in Settings (`user_preferences.notify_prefs`); a missing key
// is ON, the comment-alert convention.
//
// BEST-EFFORT, ALWAYS. A notification accompanies a write that has already happened.
// Nothing here throws to the caller; every failure is logged and swallowed. Dedupe is
// the unique (profile_id, dedupe_key): a replayed webhook, a retried sweep, a tech who
// taps twice — the second insert is a no-op and nobody is rung twice.
//
// WEB PUSH. `web-push` (pure JS, bundles into deploy.ps1's single file). VAPID keys live
// in Secrets Manager `sundial/push` = { publicKey, privateKey, subject } — the private
// key never leaves this process, the public key is what the browser subscribes with
// (GET /notify/config). A 404 / 410 from the push service means the subscription is
// dead (the person uninstalled, cleared site data) and the row is deleted; any other
// failure is stamped on the row and retried next time.
//
// Value-safety: never logs a push endpoint, a key, or a notification body.

import webpush from "web-push";
import { getSecret as realGetSecret } from "./secrets.js";
import { getSupabaseClient as realGetSupabaseClient } from "./supabase.js";
import { broadcast as realBroadcast } from "./realtime.js";

export const NOTIFICATIONS_TABLE = "sundial_notifications";
export const SUBSCRIPTIONS_TABLE = "sundial_push_subscriptions";
export const PREFERENCES_TABLE = "user_preferences";
export const PROFILES_TABLE = "profiles";
export const PUSH_SECRET_NAME = "sundial/push";
export const PUSH_TTL_SECONDS = 60 * 60 * 6; // a phone that is off for a day does not need a 6-hour-old "on my way"
export const MAX_BODY_CHARS = 280;
export const DEFAULT_PORTAL_BASE_URL = "https://sundial.harmonelectric.net";
const SECRET_TTL_MS = 5 * 60 * 1000;

export const CATEGORIES = Object.freeze({
  SCHEDULE: "schedule",
  MENTION: "mention",
  CUSTOMER_TEXT: "customer_text",
  REMINDER: "reminder",
  TECH_ACTIVITY: "tech_activity",
  MONEY: "money",
  CUSTOMER_MESSAGE: "customer_message",
});
/** What the Settings page offers each audience, in display order. */
export const TECH_CATEGORIES = Object.freeze([CATEGORIES.SCHEDULE, CATEGORIES.REMINDER, CATEGORIES.CUSTOMER_TEXT, CATEGORIES.MENTION]);
export const OFFICE_CATEGORIES = Object.freeze([CATEGORIES.TECH_ACTIVITY, CATEGORIES.MONEY, CATEGORIES.CUSTOMER_MESSAGE, CATEGORIES.MENTION]);

/** The Realtime channel one person's open tabs listen on. */
export function userChannel(profileId) {
  return `user:${profileId}:notify`;
}

/** A missing key means ON — nobody opts in to keep today's behaviour. */
export function prefAllows(prefs, category) {
  return !(prefs && typeof prefs === "object" && prefs[category] === false);
}

function str(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
function clip(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Portal paths for the records a notification can point at. Unknown → the dashboard. */
export const RECORD_PATHS = Object.freeze({
  job: (id) => `/service/jobs/${id}`,
  estimate: (id) => `/service/estimates/${id}`,
  customer: (id) => `/customers/${id}`,
  membership: (id) => `/service/club?membership=${encodeURIComponent(id)}`,
  servicecall: (id, extra) => (extra?.jobId ? `/service/jobs/${extra.jobId}` : "/service/dispatch"),
  techcall: (id) => `/tech/calls/${id}`,
  techjob: (id) => `/tech/jobs/${id}`,
});
export function recordPath(recordType, recordSfId, extra) {
  const f = RECORD_PATHS[String(recordType ?? "").toLowerCase()];
  return f && recordSfId ? f(recordSfId, extra) : "/";
}

/** The VAPID config from the secret; `configured` is false until Tim creates it. */
export function pushConfigFrom(secret) {
  const s = secret && typeof secret === "object" ? secret : {};
  const publicKey = str(s.publicKey ?? s.public_key ?? s.vapidPublicKey);
  const privateKey = str(s.privateKey ?? s.private_key ?? s.vapidPrivateKey);
  const subject = str(s.subject ?? s.vapidSubject) ?? "mailto:support@constructiveoperations.com";
  return { publicKey, privateKey, subject, configured: !!(publicKey && privateKey) };
}

/** What a push carries. Small on purpose: the tab / the bell holds the rest. */
export function pushPayload(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body ?? "",
    url: row.url ?? "/",
    tag: row.dedupe_key ?? row.id,
    category: row.category,
    kind: row.kind,
    at: row.created_at,
  };
}

/** Default push transport: web-push. Returns { ok } | { ok:false, status, gone, reason }. */
export async function realSendPush(subscription, payload, vapid) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), {
      TTL: PUSH_TTL_SECONDS,
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    });
    return { ok: true };
  } catch (e) {
    const status = e?.statusCode ?? null;
    return { ok: false, status, gone: status === 404 || status === 410, reason: e?.body ? clip(e.body, 160) : e?.message || String(e) };
  }
}

/**
 * Build the notifier. Every dependency is injectable for tests.
 *
 * @param {object} deps
 *   getSupabaseClient, getSecret, broadcast, sendPush, now, env, portalBaseUrl
 */
export function createNotifier(deps = {}) {
  const d = {
    getSupabaseClient: realGetSupabaseClient,
    getSecret: realGetSecret,
    broadcast: realBroadcast,
    sendPush: realSendPush,
    now: () => new Date(),
    env: process.env,
    ...deps,
  };
  const portalBase = String(d.portalBaseUrl ?? d.env.PORTAL_BASE_URL ?? DEFAULT_PORTAL_BASE_URL).replace(/\/+$/, "");

  let vapidCache = null; // { value, at }
  async function pushConfig() {
    if (vapidCache && Date.now() - vapidCache.at < SECRET_TTL_MS) return vapidCache.value;
    let value = pushConfigFrom(null);
    try {
      value = pushConfigFrom(await d.getSecret(PUSH_SECRET_NAME));
    } catch (e) {
      // Not created yet: the bell + Realtime still work, push is simply off.
      console.warn(`notify: ${PUSH_SECRET_NAME} unreadable (${e?.message || e}) — push disabled.`);
    }
    vapidCache = { value, at: Date.now() };
    return value;
  }

  // --- recipients -----------------------------------------------------------------
  /** Sundial_User__c ids → profiles, tenant-bound. Returns [{ id, sundial_user_id }]. */
  async function profilesForUsers(tenantId, userSfIds) {
    const ids = [...new Set((userSfIds || []).filter(Boolean))];
    if (!ids.length || !tenantId) return [];
    const supabase = await d.getSupabaseClient();
    const { data, error } = await supabase.from(PROFILES_TABLE).select("id, sundial_user_id").eq("tenant_id", tenantId).in("sundial_user_id", ids);
    if (error) {
      console.error("notify: profiles lookup failed:", error.message);
      return [];
    }
    return data || [];
  }
  /** Everyone in the tenant with the office scope. */
  async function officeProfiles(tenantId) {
    if (!tenantId) return [];
    const supabase = await d.getSupabaseClient();
    const { data, error } = await supabase.from(PROFILES_TABLE).select("id, sundial_user_id").eq("tenant_id", tenantId).eq("access_scope", "tenant");
    if (error) {
      console.error("notify: office profiles lookup failed:", error.message);
      return [];
    }
    return data || [];
  }
  /** notify_prefs per profile id (missing row = {}). */
  async function prefsFor(profileIds) {
    const out = new Map();
    if (!profileIds.length) return out;
    try {
      const supabase = await d.getSupabaseClient();
      const { data, error } = await supabase.from(PREFERENCES_TABLE).select("user_id, notify_prefs").in("user_id", profileIds);
      if (error) console.warn("notify: preferences lookup failed — defaulting to ON:", error.message);
      for (const r of data || []) out.set(r.user_id, r.notify_prefs || {});
    } catch (e) {
      console.warn("notify: preferences lookup threw — defaulting to ON:", e?.message || e);
    }
    return out;
  }

  // --- push -------------------------------------------------------------------------
  async function pushTo(rows) {
    if (!rows.length) return { sent: 0, dropped: 0 };
    const vapid = await pushConfig();
    if (!vapid.configured) return { sent: 0, dropped: 0, reason: "not_configured" };
    const supabase = await d.getSupabaseClient();
    const profileIds = [...new Set(rows.map((r) => r.profile_id))];
    const { data: subs, error } = await supabase.from(SUBSCRIPTIONS_TABLE).select("id, profile_id, endpoint, p256dh, auth").in("profile_id", profileIds);
    if (error) {
      console.error("notify: subscriptions lookup failed:", error.message);
      return { sent: 0, dropped: 0 };
    }
    let sent = 0;
    let dropped = 0;
    const gone = [];
    const failed = [];
    for (const row of rows) {
      const mine = (subs || []).filter((s) => s.profile_id === row.profile_id);
      let ok = 0;
      let lastErr = null;
      for (const s of mine) {
        const r = await d.sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, pushPayload(row), vapid);
        if (r.ok) ok += 1;
        else if (r.gone) gone.push(s.id);
        else {
          lastErr = `${r.status ?? "?"} ${r.reason ?? ""}`.trim();
          failed.push({ id: s.id, reason: lastErr });
        }
      }
      if (ok) sent += ok;
      const patch = ok ? { pushed_at: d.now().toISOString() } : lastErr ? { push_error: clip(lastErr, 200) } : null;
      if (patch) await supabase.from(NOTIFICATIONS_TABLE).update(patch).eq("id", row.id);
    }
    if (gone.length) {
      dropped = gone.length;
      await supabase.from(SUBSCRIPTIONS_TABLE).delete().in("id", gone);
    }
    for (const f of failed) await supabase.from(SUBSCRIPTIONS_TABLE).update({ failed_at: d.now().toISOString(), fail_reason: clip(f.reason, 200) }).eq("id", f.id);
    return { sent, dropped };
  }

  // --- the core write ---------------------------------------------------------------
  /**
   * Notify a set of profiles. Returns { inserted, skipped, pushed } and never throws.
   *
   * @param {object} n
   *   tenantId, recipients: [{ id, sundial_user_id? }], category, kind, title, body?,
   *   url? (portal path or absolute), recordType?, recordSfId?, dedupeKey?, push? (default true)
   */
  async function deliver(n) {
    const category = str(n?.category);
    const kind = str(n?.kind);
    const title = str(n?.title);
    if (!n?.tenantId || !category || !kind || !title) return { inserted: 0, skipped: 0, pushed: 0, reason: "incomplete" };
    const recipients = [];
    const seen = new Set();
    for (const r of n.recipients || []) {
      if (!r?.id || seen.has(r.id)) continue;
      seen.add(r.id);
      recipients.push(r);
    }
    if (!recipients.length) return { inserted: 0, skipped: 0, pushed: 0, reason: "no_recipients" };
    try {
      const prefs = await prefsFor(recipients.map((r) => r.id));
      const wanted = recipients.filter((r) => prefAllows(prefs.get(r.id), category));
      const skipped = recipients.length - wanted.length;
      if (!wanted.length) return { inserted: 0, skipped, pushed: 0, reason: "opted_out" };
      const at = d.now().toISOString();
      const rows = wanted.map((r) => ({
        client_sf_id: n.tenantId,
        profile_id: r.id,
        user_sf_id: r.sundial_user_id ?? null,
        category,
        kind,
        title: clip(title, 140),
        body: n.body ? clip(n.body, MAX_BODY_CHARS) : null,
        url: str(n.url) ?? null,
        record_type: str(n.recordType) ?? null,
        record_sf_id: str(n.recordSfId) ?? null,
        dedupe_key: str(n.dedupeKey) ?? null,
        created_at: at,
      }));
      const supabase = await d.getSupabaseClient();
      // ON CONFLICT (profile_id, dedupe_key) DO NOTHING: a replay inserts nothing and rings nobody.
      const { data, error } = await supabase.from(NOTIFICATIONS_TABLE).upsert(rows, { onConflict: "profile_id,dedupe_key", ignoreDuplicates: true }).select();
      if (error) {
        console.error("notify: insert failed:", error.message, `${category}/${kind}`);
        return { inserted: 0, skipped, pushed: 0, reason: "insert_failed" };
      }
      const inserted = data || [];
      // The open tab first (cheap, best-effort), then the phones.
      await Promise.all(
        inserted.map((row) =>
          d.broadcast(userChannel(row.profile_id), "notification", { id: row.id, title: row.title, body: row.body, url: row.url, category: row.category, kind: row.kind, createdAt: row.created_at }).catch(() => ({ ok: false }))
        )
      );
      const push = n.push === false ? { sent: 0 } : await pushTo(inserted);
      console.log(`notify: ${category}/${kind} → ${inserted.length} of ${recipients.length} (${skipped} opted out, ${push.sent} pushes${push.dropped ? `, ${push.dropped} dead subscriptions removed` : ""})`);
      return { inserted: inserted.length, skipped, pushed: push.sent };
    } catch (e) {
      console.error("notify: threw:", e?.message || String(e));
      return { inserted: 0, skipped: 0, pushed: 0, reason: "threw" };
    }
  }

  // Every public entry point is guarded: a notification rides on a write that already
  // succeeded, so nothing in here may throw back into the caller — not even a fake
  // Supabase in a test that lacks a method this module uses.
  const guard = (fn) => async (arg) => {
    try {
      return await fn(arg);
    } catch (e) {
      console.error("notify: threw:", e?.message || String(e));
      return { inserted: 0, skipped: 0, pushed: 0, reason: "threw" };
    }
  };

  return {
    pushConfig,
    profilesForUsers,
    officeProfiles,
    deliver: guard(deliver),
    portalBase,
    /** Notify specific Sundial users (techs, an assignee) by their Sundial_User__c ids. */
    toUsers: guard(async ({ userSfIds, ...n }) => {
      const recipients = await profilesForUsers(n.tenantId, userSfIds);
      return deliver({ ...n, recipients });
    }),
    /** Notify the whole office of a tenant, minus the person who did it. */
    toOffice: guard(async ({ exceptUserSfId = null, exceptProfileId = null, ...n }) => {
      const all = await officeProfiles(n.tenantId);
      const recipients = all.filter((p) => p.id !== exceptProfileId && (!exceptUserSfId || p.sundial_user_id !== exceptUserSfId));
      return deliver({ ...n, recipients });
    }),
    /** Notify one profile directly (the @-mention path already holds the auth uuid). */
    toProfile: guard(async ({ profileId, userSfId = null, ...n }) => deliver({ ...n, recipients: [{ id: profileId, sundial_user_id: userSfId }] })),
    /** Absolute URL for an email / push that must leave the portal. */
    absoluteUrl(path) {
      return /^https?:\/\//i.test(path || "") ? path : `${portalBase}${path?.startsWith("/") ? "" : "/"}${path || ""}`;
    },
  };
}

// --- copy helpers shared by the emitters ---------------------------------------------
// Kept here so every Lambda words the same event the same way, and a test can pin it.

const TIME_FMT = { hour: "numeric", minute: "2-digit" };
const DAY_FMT = { weekday: "short", month: "short", day: "numeric" };
export function fmtWhen(iso, timeZone = "America/Phoenix") {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const dt = new Date(t);
  return `${dt.toLocaleDateString("en-US", { ...DAY_FMT, timeZone })}, ${dt.toLocaleTimeString("en-US", { ...TIME_FMT, timeZone })}`;
}
export function fmtTime(iso, timeZone = "America/Phoenix") {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString("en-US", { ...TIME_FMT, timeZone }) : "";
}
/** "SVC-00012 · Ann Lee" — the job line every notification opens with. */
export function jobLabel(job) {
  return [job?.Name ?? job?.jobNumber, job?.Customer_Name_at_Creation__c ?? job?.customerName].filter(Boolean).join(" · ") || "a job";
}
