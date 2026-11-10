// lib/report-schedule.js — scheduled delivery of a saved report (D-091, Reporting R3,
// 2026-11-10; docs/reporting-module.md §7). PURE: no I/O. lambdas/sundial-reports/schedule.js
// stores what this validates and asks it every question about when, and to whom.
//
// THE SCHEDULE (stored as public.sundial_reports.schedule jsonb):
//   { cadence: "daily" | "weekly" | "monthly",
//     time: "HH:MM"            on the quarter hour (:00 :15 :30 :45) — the tick runs every 15 min
//     days: ["mon", ...]       weekly only, at least one
//     dayOfMonth: 1..31        monthly only; past a shorter month's end it is that month's last day
//     recipients: [{ userId } | { email }]   1..25
//     format: "csv"            the only format (there is no report PDF)
//     enabled: true | false }
//
// TIME. Every time is ARIZONA wall time (America/Phoenix). Arizona does not observe daylight
// saving: it is UTC−07:00 all year, so 07:00 is always 14:00 UTC and no slot is ever skipped or
// doubled by a clock change. The offset is lib/report-def.js REPORT_UTC_OFFSET, the reports'
// one time zone. (A tenant in a zone WITH daylight saving would need the zone database here,
// not a fixed offset — revisit when one exists.)
//
// RECIPIENTS (Tim, 2026-11-10). A recipient is either
//   - a TENANT USER: an active Executive / Admin / Manager of the tenant (TENANT_ACCESS_LEVELS,
//     the levels that may open reports), stored by Sundial_User__c id so an email change
//     follows them; or
//   - an OUTSIDE address: any other email — a sales rep, a tech, anyone outside Harmon. Only an
//     owner holding reports.schedule.external (Admin / Executive) may add one, and it is
//     re-checked at every send.
// An email typed in that IS an eligible tenant user's is stored as that user.

import { createHash, randomBytes } from "node:crypto";
import { REPORT_UTC_OFFSET } from "./report-def.js";
import { TENANT_ACCESS_LEVELS } from "./access.js";

export const CADENCES = Object.freeze(["daily", "weekly", "monthly"]);
export const WEEKDAYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export const FORMATS = Object.freeze(["csv"]);
export const MAX_RECIPIENTS = 25;
// After this many failed deliveries in a row the schedule turns itself off and tells the owner.
export const MAX_FAILURES = 3;
// A CSV under this is attached; at or over it the email carries a download link instead.
export const ATTACH_MAX_BYTES = 8 * 1024 * 1024;
// A download link works for this long (the file itself is deleted after 7 days by the
// bucket's REPORTS/ lifecycle rule).
export const LINK_TTL_MS = 7 * 24 * 3600_000;
// One link (one recipient's) may be followed this many times.
export const MAX_DOWNLOADS_PER_LINK = 20;
// A grouped report also draws its table in the email body, this many rows at most.
export const BODY_ROWS = 100;

const SCHEDULE_KEYS = new Set(["cadence", "time", "days", "dayOfMonth", "recipients", "format", "enabled"]);
const TIME_RE = /^([01]\d|2[0-3]):(00|15|30|45)$/;
const SF_ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
// Deliberately plain: one @, no spaces / brackets / commas / quotes, a dotted domain.
const EMAIL_RE = /^[^\s@<>(),;:"[\]\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const OFFSET_MS = (() => {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(REPORT_UTC_OFFSET);
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
})();

const bad = (code, field, message) => ({ ok: false, status: 400, body: { error: "invalid_schedule", code, field, message } });

/** A plausible email address (lower-cased), or null. */
export function cleanEmail(v) {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

/**
 * Validate a PUT /reports/{id}/schedule body. Returns { ok:true, value } — the schedule as it
 * will be stored, recipients still as given ({ userId } / { email }, cleaned, de-duplicated) —
 * or the 400. Whether each recipient is ALLOWED is classifyRecipients' question.
 */
export function validateSchedule(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("BAD_SCHEDULE", "", "Send the schedule as a JSON object.");
  for (const k of Object.keys(body)) {
    if (!SCHEDULE_KEYS.has(k)) return bad("BAD_SCHEDULE", k, `${k}: not a schedule field (${[...SCHEDULE_KEYS].join(", ")}).`);
  }
  const { cadence } = body;
  if (!CADENCES.includes(cadence)) return bad("BAD_CADENCE", "cadence", `cadence: one of ${CADENCES.join(", ")}.`);
  if (typeof body.time !== "string" || !TIME_RE.test(body.time)) {
    return bad("BAD_TIME", "time", "time: \"HH:MM\" on the quarter hour (:00, :15, :30, :45), Arizona time.");
  }
  const value = { cadence, time: body.time };

  if (cadence === "weekly") {
    const days = body.days;
    if (!Array.isArray(days) || days.length === 0 || days.some((d) => !WEEKDAYS.includes(d))) {
      return bad("BAD_DAYS", "days", `days: at least one of ${WEEKDAYS.join(", ")}.`);
    }
    value.days = WEEKDAYS.filter((d) => days.includes(d)); // week order, no repeats
  } else if (body.days !== undefined && body.days !== null) {
    return bad("BAD_DAYS", "days", "days: only a weekly schedule names days.");
  }
  if (cadence === "monthly") {
    const dom = body.dayOfMonth;
    if (!Number.isInteger(dom) || dom < 1 || dom > 31) return bad("BAD_DAY_OF_MONTH", "dayOfMonth", "dayOfMonth: 1 to 31 (past a shorter month's end, its last day).");
    value.dayOfMonth = dom;
  } else if (body.dayOfMonth !== undefined && body.dayOfMonth !== null) {
    return bad("BAD_DAY_OF_MONTH", "dayOfMonth", "dayOfMonth: only a monthly schedule names a day of the month.");
  }

  const format = body.format ?? "csv";
  if (!FORMATS.includes(format)) return bad("BAD_FORMAT", "format", `format: ${FORMATS.join(", ")}.`);
  value.format = format;
  const enabled = body.enabled ?? true;
  if (typeof enabled !== "boolean") return bad("BAD_SCHEDULE", "enabled", "enabled: true or false.");
  value.enabled = enabled;

  const list = body.recipients;
  if (!Array.isArray(list) || list.length === 0) return bad("BAD_RECIPIENT", "recipients", "recipients: at least one.");
  if (list.length > MAX_RECIPIENTS) return bad("TOO_MANY_RECIPIENTS", "recipients", `recipients: at most ${MAX_RECIPIENTS}.`);
  const seen = new Set();
  const recipients = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const where = `recipients[${i}]`;
    if (!r || typeof r !== "object" || Array.isArray(r)) return bad("BAD_RECIPIENT", where, `${where}: { userId } or { email }.`);
    const keys = Object.keys(r);
    if (keys.length !== 1 || (keys[0] !== "userId" && keys[0] !== "email")) return bad("BAD_RECIPIENT", where, `${where}: { userId } or { email }.`);
    let entry;
    if (keys[0] === "userId") {
      if (typeof r.userId !== "string" || !SF_ID_RE.test(r.userId)) return bad("BAD_RECIPIENT", where, `${where}.userId: a user id.`);
      entry = { userId: r.userId };
    } else {
      const e = cleanEmail(r.email);
      if (!e) return bad("BAD_RECIPIENT", where, `${where}.email: not an email address.`);
      entry = { email: e };
    }
    const k = entry.userId ? `u:${entry.userId}` : `e:${entry.email}`;
    if (seen.has(k)) continue; // a repeat is dropped, not refused
    seen.add(k);
    recipients.push(entry);
  }
  value.recipients = recipients;
  return { ok: true, value };
}

/**
 * Is this sundial_user_cache row an eligible recipient (a tenant user)? Active, not deleted,
 * an Executive / Admin / Manager (TENANT_ACCESS_LEVELS) of THIS tenant, with an email.
 */
export function isEligibleUser(row, tenantId) {
  return !!row && row.client_sf_id === tenantId && row.active === true && row.isdeleted !== true
    && TENANT_ACCESS_LEVELS.includes(row.access_level) && !!cleanEmail(row.email);
}

/** A cache row's display name. */
export function userName(row) {
  const n = [row?.first_name, row?.last_name].filter((x) => typeof x === "string" && x.trim()).join(" ").trim();
  return n || (typeof row?.name === "string" && row.name.trim()) || null;
}

/**
 * Sort a validated recipient list against the tenant's eligible users (`users`: cache rows
 * already passing isEligibleUser).
 * Returns { stored, resolved, problems, external }:
 *   stored     what to save: an { email } that is an eligible user becomes { userId }
 *   resolved   [{ kind: "user", userId, email, name } | { kind: "external", email }]
 *   problems   [{ index, code }] — a { userId } that is not an eligible user (USER_NOT_ELIGIBLE)
 *   external   how many outside addresses
 */
export function classifyRecipients(recipients, users) {
  const byId = new Map(users.map((u) => [u.sf_id, u]));
  const byEmail = new Map(users.map((u) => [cleanEmail(u.email), u]));
  const stored = [];
  const resolved = [];
  const problems = [];
  const seen = new Set();
  recipients.forEach((r, index) => {
    let u = null;
    if (r.userId) {
      u = byId.get(r.userId) ?? null;
      if (!u) {
        problems.push({ index, code: "USER_NOT_ELIGIBLE" });
        return;
      }
    } else {
      u = byEmail.get(r.email) ?? null;
    }
    const key = u ? `u:${u.sf_id}` : `e:${r.email}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (u) {
      stored.push({ userId: u.sf_id });
      resolved.push({ kind: "user", userId: u.sf_id, email: cleanEmail(u.email), name: userName(u) });
    } else {
      stored.push({ email: r.email });
      resolved.push({ kind: "external", email: r.email });
    }
  });
  return { stored, resolved, problems, external: resolved.filter((r) => r.kind === "external").length };
}

/**
 * Who a delivery goes to NOW (the send-time re-check): tenant users still eligible, at their
 * current email; outside addresses only while the owner may send to them. Two entries with the
 * same address go once. Returns { to: [{ email, external }], skipped }.
 */
export function sendList(recipients, users, { canExternal }) {
  const byId = new Map(users.map((u) => [u.sf_id, u]));
  const out = [];
  const seen = new Set();
  let skipped = 0;
  for (const r of recipients ?? []) {
    let email = null;
    let external = false;
    if (r?.userId) {
      const u = byId.get(r.userId);
      email = u ? cleanEmail(u.email) : null;
    } else if (r?.email) {
      external = true;
      email = canExternal ? cleanEmail(r.email) : null;
    }
    if (!email) {
      skipped += 1;
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ email, external });
  }
  return { to: out, skipped };
}

// --- when ---------------------------------------------------------------------------------
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

function onDay(schedule, day) {
  switch (schedule.cadence) {
    case "daily":
      return true;
    case "weekly":
      return (schedule.days ?? []).includes(WEEKDAYS[(day.getUTCDay() + 6) % 7]);
    case "monthly": {
      const y = day.getUTCFullYear();
      const m = day.getUTCMonth();
      return day.getUTCDate() === Math.min(schedule.dayOfMonth, daysInMonth(y, m));
    }
    default:
      return false;
  }
}

/**
 * The first slot STRICTLY AFTER `after`, as a Date. A slot is the schedule's Arizona wall time
 * on a day the cadence names; Arizona is UTC−07:00 all year, so the instant is wall time + 7 h.
 * Strictly after: a schedule just run at its slot moves to the next one, and after an outage it
 * moves past every missed slot at once (one send, never a burst).
 */
export function nextRunAt(schedule, after = new Date()) {
  const [hh, mm] = String(schedule.time).split(":").map(Number);
  const afterMs = after.getTime();
  const local = new Date(afterMs + OFFSET_MS); // Arizona wall clock, read through the UTC getters
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  for (let i = 0; i <= 400; i++) {
    const day = new Date(Date.UTC(y, m, d + i));
    if (!onDay(schedule, day)) continue;
    const slot = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh, mm) - OFFSET_MS;
    if (slot > afterMs) return new Date(slot);
  }
  throw new Error("nextRunAt: no slot within 400 days");
}

// --- words --------------------------------------------------------------------------------
const DAY_LABEL = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** "7:00 AM" from "07:00". */
export function clockLabel(time) {
  const [h, m] = String(time).split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "Daily at 7:00 AM", "Weekly on Mon, Wed at 7:00 AM", "Monthly on day 31 at 7:00 AM" — Arizona time. */
export function describeSchedule(s) {
  if (!s) return null;
  const at = `at ${clockLabel(s.time)} (Arizona time)`;
  if (s.cadence === "daily") return `Daily ${at}`;
  if (s.cadence === "weekly") {
    const days = s.days ?? [];
    const words = days.length === 7 ? "every day" : days.length === 5 && !days.includes("sat") && !days.includes("sun") ? "weekdays" : days.map((d) => DAY_LABEL[d]).join(", ");
    return `Weekly on ${words} ${at}`;
  }
  if (s.cadence === "monthly") {
    return `Monthly on day ${s.dayOfMonth}${s.dayOfMonth >= 29 ? " (or the month's last day)" : ""} ${at}`;
  }
  return null;
}

/**
 * The schedule as GET /reports and GET /reports/{id}/schedule show it. Recipients only for the
 * owner (`withRecipients`): nobody else is told who a report goes to.
 */
export function scheduleView(row, { withRecipients = false, recipients = null } = {}) {
  const s = row?.schedule;
  if (!s) return null;
  return {
    cadence: s.cadence,
    time: s.time,
    ...(s.days ? { days: s.days } : {}),
    ...(s.dayOfMonth ? { dayOfMonth: s.dayOfMonth } : {}),
    format: s.format ?? "csv",
    enabled: s.enabled === true,
    summary: describeSchedule(s),
    recipientCount: Array.isArray(s.recipients) ? s.recipients.length : 0,
    ...(withRecipients ? { recipients: recipients ?? s.recipients ?? [] } : {}),
    nextRunAt: s.enabled === true ? row.next_run_at ?? null : null,
    lastRunAt: row.last_run_at ?? null,
    lastRunStatus: row.last_run_status ?? null,
    lastRunError: row.last_run_error ?? null,
    consecutiveFailures: row.consecutive_failures ?? 0,
  };
}

// --- download links -----------------------------------------------------------------------
/** A new download token: 32 random bytes, base64url (43 characters). Never stored, never logged. */
export function newDownloadToken() {
  return randomBytes(32).toString("base64url");
}
/** What is stored and logged instead of the token: its SHA-256, hex. */
export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}
/** Is this shaped like a token we issue? */
export function isDownloadToken(v) {
  return typeof v === "string" && TOKEN_RE.test(v);
}

/** Plain-English reasons for the owner's email and the list (codes are the API's). */
export const FAILURE_WORDS = Object.freeze({
  OWNER_NOT_ALLOWED: "the report's owner can no longer run reports",
  DEFINITION_INVALID: "the report no longer runs (a field it uses has changed)",
  NO_RECIPIENTS: "none of its recipients can receive it any more",
  REPORT_CATALOG_MISMATCH: "the report engine was being updated",
  CSV_TOO_SLOW: "the report took too long to build",
  CSV_FAILED: "the report could not be built",
  WORKER_INVOKE_FAILED: "the report could not be started",
  DELIVERY_LOST: "the delivery stopped part-way",
  SEND_FAILED: "the email could not be sent",
  SOME_SENDS_FAILED: "the email could not be sent to some recipients",
  OWNER_LOOKUP_FAILED: "its owner's account could not be checked",
  RECIPIENT_LOOKUP_FAILED: "its recipients could not be looked up",
  QUEUE_FAILED: "the report could not be started",
  LINK_FAILED: "a download link could not be made",
});
export const failureWords = (code) => FAILURE_WORDS[code] ?? "something went wrong";
