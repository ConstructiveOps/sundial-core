// sundial-reports/schedule.js — scheduled delivery of saved reports (D-091, Reporting R3,
// 2026-11-10; docs/reporting-module.md §7).
//
//   GET    /reports/recipients          who a schedule may go to: the tenant's active Executive /
//                                       Admin / Manager users (the picker) + canAddExternal
//   GET    /reports/{id}/schedule       the report's schedule (recipients for the owner only)
//   PUT    /reports/{id}/schedule       set it (owner; reports.write) → next_run_at computed
//   DELETE /reports/{id}/schedule       remove it (owner)
//   POST   /reports/{id}/send-now       deliver now (owner) → 202 { exportId }; { "toMe": true }
//                                       sends to the caller only and records nothing on the report
//   { task: "tick" }                    NOT a route: EventBridge (sundial-reports-tick,
//                                       cron(0/15 * * * ? *)) — claim what is due, queue each
//
// THE OWNER IS THE SENDER. A delivery runs the report as its OWNER as they are at send time:
// their identity is re-read (lib/identity.js resolveIdentityForProfile — the same code as a
// login), their gates decide which columns are in the file, their reports.schedule.external
// decides whether outside addresses still get it. A Manager on an Admin's cost report receives
// the costs — the Admin chose to send them. An owner who is gone, inactive, moved to another
// tenant or no longer a tenant-level user turns the schedule OFF at once (OWNER_NOT_ALLOWED).
//
// CLAIM BEFORE RUN. The tick reads at most CLAIMS_PER_TICK due rows and claims each with ONE
// conditional update: next_run_at moves to the next slot WHERE next_run_at is still what it
// read. Two ticks (or a retried one) racing for the same slot: Postgres re-checks the WHERE
// after the first commits, the second updates nothing and skips it. Then the delivery is queued
// down the CSV export path (csv.js queueExport → this Lambda invoked by itself), one background
// worker per delivery, each with its own 300 s; the worker emails when the file is done
// (deliver.js) and records the outcome here (recordOutcome).
//
// THREE FAILURES IN A ROW turn the schedule off and email the owner once (the email goes only
// on the enabled → disabled change, which happens once).
//
// NEVER LOGGED: an address, a name, a row, a value.

import { getSupabaseClient } from "../../lib/supabase.js";
import { jsonResponse } from "../../lib/http.js";
import { canAction, DENY, TENANT_ACCESS_LEVELS } from "../../lib/access.js";
import { alwaysEnforcedAccess } from "../../lib/access-enforce.js";
import { resolveIdentityForProfile } from "../../lib/identity.js";
import { normalizeDefinition, arizonaToday } from "../../lib/report-def.js";
import { reportType } from "../../lib/report-types.js";
import { linkColumns } from "../../lib/report-csv.js";
import { canEdit, isUuid } from "../../lib/saved-reports.js";
import {
  validateSchedule, classifyRecipients, sendList, nextRunAt, scheduleView, isEligibleUser, userName, cleanEmail,
  MAX_RECIPIENTS, MAX_FAILURES, BODY_ROWS,
} from "../../lib/report-schedule.js";
import { buildDisabledEmail } from "../../lib/report-email.js";
import { sendEmail } from "../../lib/email.js";
import { queueExport, tenantPortalOrigin } from "./csv.js";
import { loadVisible, ownerNameOf, REPORTS_TABLE } from "./saved.js";
import { heldGates } from "./gates.js";

export const USERS_TABLE = "sundial_user_cache";
export const EXTERNAL_ACTION = "reports.schedule.external";
export const CLAIMS_PER_TICK = 5;
// A delivery still "running" after this was lost (the worker died). Far past the Lambda's 300 s.
export const LOST_AFTER_MS = 15 * 60_000;
const LOST_PER_TICK = 20;

const notFound = (cors) => jsonResponse(404, cors, { error: "not_found", code: DENY.RECORD_NOT_FOUND });
const readOnly = (cors) => jsonResponse(403, cors, { error: "forbidden", code: "REPORT_READ_ONLY" });
const serverError = (cors, what, error) => {
  console.error(`reports schedule: ${what} failed:`, error?.message || String(error));
  return jsonResponse(500, cors, { error: "server_error" });
};
const badSchedule = (cors, code, field, message) => jsonResponse(400, cors, { error: "invalid_schedule", code, field, message });

/** The tenant's eligible recipients (active Executive / Admin / Manager with an email), from the cache. */
export async function eligibleUsers(supabase, tenantId) {
  const { data, error } = await supabase
    .from(USERS_TABLE)
    .select("sf_id, client_sf_id, first_name, last_name, name, email, active, access_level, isdeleted")
    .eq("client_sf_id", tenantId)
    .eq("active", true)
    .in("access_level", [...TENANT_ACCESS_LEVELS])
    .limit(2000);
  if (error) return { error };
  return { users: (data ?? []).filter((u) => isEligibleUser(u, tenantId)) };
}

const userView = (u) => ({ userId: u.sf_id, name: userName(u), email: cleanEmail(u.email), accessLevel: u.access_level });

/** Stored recipients → what the owner sees: names for users, a flag for an outside address. */
function recipientsView(stored, users) {
  const byId = new Map((users ?? []).map((u) => [u.sf_id, u]));
  return (stored ?? []).map((r) => {
    if (r.userId) {
      const u = byId.get(r.userId);
      return u ? { userId: r.userId, name: userName(u), email: cleanEmail(u.email), eligible: true } : { userId: r.userId, name: null, email: null, eligible: false };
    }
    return { email: r.email, external: true };
  });
}

// --- routes --------------------------------------------------------------------------------
/** GET /reports/recipients */
export async function listRecipients({ me, access, cors }) {
  const supabase = await getSupabaseClient();
  const r = await eligibleUsers(supabase, me.tenantId);
  if (r.error) return serverError(cors, "recipients", r.error);
  const users = r.users.map(userView).sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")) || (a.userId < b.userId ? -1 : 1));
  return jsonResponse(200, cors, { users, canAddExternal: canAction(EXTERNAL_ACTION, access), maxRecipients: MAX_RECIPIENTS });
}

/** GET /reports/{id}/schedule */
export async function getSchedule({ id, me, cors }) {
  const supabase = await getSupabaseClient();
  const { row, error } = await loadVisible(supabase, id, me);
  if (error) return serverError(cors, "read", error);
  if (!row) return notFound(cors);
  const mine = row.owner_profile_id === me.profileId;
  // The owner's name, by GET /reports' rule (one profile lookup; "former user"; null on failure).
  const ownerName = await ownerNameOf(supabase, row.owner_profile_id);
  if (!row.schedule) return jsonResponse(200, cors, { reportId: row.id, ownerName, schedule: null });
  let recipients = null;
  if (mine) {
    const u = await eligibleUsers(supabase, me.tenantId);
    if (u.error) console.warn("reports schedule: recipient names unavailable:", u.error?.message || String(u.error));
    recipients = recipientsView(row.schedule.recipients, u.users ?? []);
  }
  return jsonResponse(200, cors, { reportId: row.id, ownerName, schedule: scheduleView(row, { withRecipients: mine, recipients }) });
}

/** PUT /reports/{id}/schedule */
export async function putSchedule({ id, body, me, perms, access, cors, now = new Date() }) {
  const supabase = await getSupabaseClient();
  const { row, error } = await loadVisible(supabase, id, me);
  if (error) return serverError(cors, "read", error);
  if (!row) return notFound(cors);
  if (!canEdit(row, me, perms)) return readOnly(cors);
  const v = validateSchedule(body);
  if (!v.ok) return jsonResponse(v.status, cors, v.body);

  const u = await eligibleUsers(supabase, me.tenantId);
  if (u.error) return serverError(cors, "recipients", u.error);
  const c = classifyRecipients(v.value.recipients, u.users);
  if (c.problems.length) {
    const p = c.problems[0];
    return badSchedule(cors, "BAD_RECIPIENT", `recipients[${p.index}]`, `recipients[${p.index}]: not an active Executive, Admin or Manager of this account.`);
  }
  if (c.external > 0 && !canAction(EXTERNAL_ACTION, access)) {
    return jsonResponse(403, cors, {
      error: "forbidden",
      code: "EXTERNAL_RECIPIENT_FORBIDDEN",
      message: "Only an Admin or an Executive can send a scheduled report to someone who is not an Executive, Admin or Manager here.",
    });
  }

  const schedule = { ...v.value, recipients: c.stored };
  const patch = {
    schedule,
    next_run_at: nextRunAt(schedule, now).toISOString(),
    consecutive_failures: 0,
    updated_at: now.toISOString(),
    updated_by: me.profileId,
  };
  if (row.last_run_status === "disabled") patch.last_run_status = null; // set again = a clean start
  const { data, error: upErr } = await supabase.from(REPORTS_TABLE).update(patch).eq("id", row.id).eq("client_sf_id", me.tenantId).select("*").single();
  if (upErr) return serverError(cors, "save", upErr);
  console.log(JSON.stringify({ schedule: "set", id: row.id, cadence: schedule.cadence, recipients: c.stored.length, external: c.external, enabled: schedule.enabled }));
  return jsonResponse(200, cors, { reportId: row.id, schedule: scheduleView(data, { withRecipients: true, recipients: recipientsView(c.stored, u.users) }) });
}

/** DELETE /reports/{id}/schedule — the run history (last_run_*) stays. */
export async function deleteSchedule({ id, me, perms, cors, now = new Date() }) {
  const supabase = await getSupabaseClient();
  const { row, error } = await loadVisible(supabase, id, me);
  if (error) return serverError(cors, "read", error);
  if (!row) return notFound(cors);
  if (!canEdit(row, me, perms)) return readOnly(cors);
  const { error: upErr } = await supabase
    .from(REPORTS_TABLE)
    .update({ schedule: null, next_run_at: null, consecutive_failures: 0, updated_at: now.toISOString(), updated_by: me.profileId })
    .eq("id", row.id)
    .eq("client_sf_id", me.tenantId);
  if (upErr) return serverError(cors, "delete", upErr);
  console.log(JSON.stringify({ schedule: "removed", id: row.id }));
  return { statusCode: 204, headers: cors, body: "" };
}

/**
 * POST /reports/{id}/send-now — the owner (the caller) delivers now. With { toMe: true } only
 * to the caller, as a test: nothing is recorded on the report. Otherwise to the saved
 * recipients, recorded in last_run_* like a scheduled run; next_run_at is untouched.
 */
export async function sendNow({ id, body, me, perms, identity, access, cors, now = new Date() }) {
  if (body !== undefined && body !== null) {
    if (typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "toMe") || (body.toMe !== undefined && typeof body.toMe !== "boolean")) {
      return badSchedule(cors, "BAD_SCHEDULE", "", "Send nothing, or { \"toMe\": true }.");
    }
  }
  const toMe = body?.toMe === true;
  const supabase = await getSupabaseClient();
  const { row, error } = await loadVisible(supabase, id, me);
  if (error) return serverError(cors, "read", error);
  if (!row) return notFound(cors);
  if (!canEdit(row, me, perms)) return readOnly(cors);

  let to;
  let skipped = 0;
  if (toMe) {
    const email = cleanEmail(identity?.user?.email);
    if (!email) return badSchedule(cors, "NO_EMAIL", "toMe", "Your user record has no email address.");
    to = [{ email, external: false }];
  } else {
    if (!row.schedule) return badSchedule(cors, "NO_SCHEDULE", "", "This report has no schedule — set one, or send it to yourself ({ \"toMe\": true }).");
    const u = await eligibleUsers(supabase, me.tenantId);
    if (u.error) return serverError(cors, "recipients", u.error);
    const sl = sendList(row.schedule.recipients, u.users, { canExternal: canAction(EXTERNAL_ACTION, access) });
    if (sl.to.length === 0) return badSchedule(cors, "NO_RECIPIENTS", "recipients", "None of this schedule's recipients can receive it now.");
    to = sl.to;
    skipped = sl.skipped;
  }

  const q = await queueDelivery({
    row, kind: toMe ? "to_me" : "send_now", to, skipped, ownerIdentity: identity, held: heldGates(access), now,
    // Before the worker starts, so its outcome always finds its own export id on the report.
    beforeInvoke: toMe ? null : (exportId) => markRunning(supabase, row.id, exportId, now),
  });
  if (q.error === "DEFINITION_INVALID") return jsonResponse(400, cors, q.body);
  if (q.error === "QUEUE_FAILED") return serverError(cors, "queue", q.error);
  if (q.error) return jsonResponse(502, cors, { error: "worker_invoke_failed", code: q.error });
  return jsonResponse(202, cors, { exportId: q.exportId, status: "queued", recipients: to.length, skipped });
}

async function markRunning(supabase, reportId, exportId, now) {
  const { error } = await supabase
    .from(REPORTS_TABLE)
    .update({ last_run_status: "running", last_run_at: now.toISOString(), last_run_error: null, last_export_id: exportId })
    .eq("id", reportId);
  if (error) console.error("reports schedule: could not mark the run:", error.message);
}

// --- queue one delivery --------------------------------------------------------------------
/**
 * Validate the report AS ITS OWNER (held = the owner's gates) in CSV mode and queue it down the
 * export path with a `delivery` block the worker reads when the file is done (deliver.js).
 * A grouped report also gets the on-screen wire, capped at BODY_ROWS, for the email's table.
 * Returns { exportId } or { error, body? }.
 */
export async function queueDelivery({ row, kind, to, skipped = 0, ownerIdentity, held, now = new Date(), beforeInvoke = null }) {
  const def = row.definition;
  const n = normalizeDefinition(def, { heldGates: held, now, mode: "csv" });
  if (!n.ok) return { error: "DEFINITION_INVALID", body: n.body };
  const type = reportType(def.type);
  let bodyWire = null;
  let bodyOutput = null;
  if (n.wire.grouped) {
    const b = normalizeDefinition(def, { heldGates: held, now, mode: "run" });
    if (b.ok) {
      bodyWire = { ...b.wire, limit: BODY_ROWS, offset: 0, totals: false };
      bodyOutput = b.output;
    }
  }
  const portal = await tenantPortalOrigin(ownerIdentity?.tenantSlug ?? null);
  const owner = ownerIdentity?.user ?? {};
  const job = {
    type: def.type, wire: n.wire, output: n.output, rowLimit: n.rowLimit, stripped: n.stripped, objects: n.objects,
    // Link columns follow the export's own rule: ungrouped, and a type with record pages.
    portalOrigin: !n.wire.grouped && type && linkColumns(type).length ? portal : null,
    delivery: {
      reportId: row.id,
      reportName: row.name,
      kind, // schedule | send_now | to_me
      to,
      skipped,
      owner: { profileId: row.owner_profile_id, name: userName({ first_name: owner.firstName, last_name: owner.lastName }), email: cleanEmail(owner.email) },
      reportUrl: portal ? `${portal}/reports/${row.id}` : null,
      runDate: arizonaToday(now),
      bodyWire,
      bodyOutput,
    },
  };
  const q = await queueExport({ tenantId: row.client_sf_id, ownerProfileId: row.owner_profile_id, reportId: row.id, reportType: def.type, job, beforeInvoke });
  console.log(JSON.stringify({ delivery: q.error ? "queue_failed" : "queued", reportId: row.id, kind, exportId: q.exportId ?? null, recipients: to.length, skipped, code: q.error ?? null }));
  return q;
}

// --- outcomes ------------------------------------------------------------------------------
/**
 * Record a delivery's outcome on its report. `exportId` must still be the report's
 * last_export_id (null when the delivery failed before an export existed) — an outcome for an
 * older run never overwrites a newer one. Three failures in a row (MAX_FAILURES), or
 * `forceDisable`, turn the schedule off; the owner is emailed only on that enabled → disabled
 * change (so once) and only when `notifyOwner`.
 */
export async function recordOutcome(supabase, reportId, { ok, partial = false, code = null, exportId = null, forceDisable = false, notifyOwner = true }) {
  const { data: row, error } = await supabase.from(REPORTS_TABLE).select("*").eq("id", reportId).maybeSingle();
  if (error || !row) {
    if (error) console.error("reports schedule: outcome read failed:", error.message);
    return { skipped: "no report" };
  }
  if ((row.last_export_id ?? null) !== (exportId ?? null)) {
    console.log(JSON.stringify({ outcome: "stale", reportId, exportId }));
    return { skipped: "stale" };
  }
  const before = row.consecutive_failures ?? 0;
  const failures = ok ? 0 : before + 1;
  const wasEnabled = row.schedule?.enabled === true;
  const disable = !!row.schedule && wasEnabled && (forceDisable || (!ok && failures >= MAX_FAILURES));
  const patch = {
    last_run_status: disable ? "disabled" : ok ? (partial ? "partial" : "ok") : "failed",
    last_run_error: code,
    consecutive_failures: failures,
  };
  if (disable) patch.schedule = { ...row.schedule, enabled: false };
  const { data: upd, error: upErr } = await supabase.from(REPORTS_TABLE).update(patch).eq("id", row.id).eq("consecutive_failures", before).select("id");
  if (upErr) {
    console.error("reports schedule: outcome write failed:", upErr.message);
    return { skipped: "write failed" };
  }
  if (!upd?.length) return { skipped: "changed meanwhile" };
  console.log(JSON.stringify({ outcome: patch.last_run_status, reportId, exportId, code, failures }));
  if (disable && notifyOwner) await notifyOwnerDisabled(row, failures, code);
  return { status: patch.last_run_status, failures, disabled: disable };
}

async function notifyOwnerDisabled(row, failures, code) {
  try {
    const identity = await resolveIdentityForProfile(row.owner_profile_id);
    const email = cleanEmail(identity?.user?.email);
    if (!email) return;
    const portal = await tenantPortalOrigin(identity.tenantSlug);
    const mail = buildDisabledEmail({ reportName: row.name, failures, lastError: code, reportUrl: portal ? `${portal}/reports/${row.id}` : null });
    const res = await sendEmail({ to: email, ...mail });
    console.log(JSON.stringify({ disabledNotice: res.ok ? "sent" : "failed", reportId: row.id, messageId: res.messageId ?? null }));
  } catch (err) {
    console.error("reports schedule: owner notice failed:", err?.message || String(err));
  }
}

// --- the tick ------------------------------------------------------------------------------
const OWNER_GONE = new Set(["NO_SUNDIAL_USER", "USER_INACTIVE"]);

/** Queue one claimed schedule, as its owner. */
async function startScheduled(supabase, row, now) {
  const fail = (code, extra = {}) => recordOutcome(supabase, row.id, { ok: false, code, exportId: null, ...extra }).then(() => ({ ok: false, code }));
  let identity;
  try {
    identity = await resolveIdentityForProfile(row.owner_profile_id);
  } catch (err) {
    if (OWNER_GONE.has(err?.code)) return fail("OWNER_NOT_ALLOWED", { forceDisable: true, notifyOwner: false });
    console.error("reports tick: owner lookup failed:", err?.message || String(err));
    return fail("OWNER_LOOKUP_FAILED");
  }
  const access = alwaysEnforcedAccess(identity);
  if (identity?.tenantId !== row.client_sf_id || !canAction("reports.read", access)) {
    return fail("OWNER_NOT_ALLOWED", { forceDisable: true, notifyOwner: false });
  }
  const u = await eligibleUsers(supabase, row.client_sf_id);
  if (u.error) {
    console.error("reports tick: recipient lookup failed:", u.error?.message || String(u.error));
    return fail("RECIPIENT_LOOKUP_FAILED");
  }
  const sl = sendList(row.schedule?.recipients, u.users, { canExternal: canAction(EXTERNAL_ACTION, access) });
  if (sl.to.length === 0) return fail("NO_RECIPIENTS");
  const q = await queueDelivery({
    row, kind: "schedule", to: sl.to, skipped: sl.skipped, ownerIdentity: identity, held: heldGates(access), now,
    beforeInvoke: async (exportId) => {
      const { error } = await supabase.from(REPORTS_TABLE).update({ last_export_id: exportId }).eq("id", row.id).eq("last_run_status", "running");
      if (error) console.error("reports tick: could not stamp the export:", error.message);
    },
  });
  if (q.error) {
    // WORKER_INVOKE_FAILED already stamped its export id on the report (beforeInvoke).
    return recordOutcome(supabase, row.id, { ok: false, code: q.error, exportId: q.exportId ?? null }).then(() => ({ ok: false, code: q.error }));
  }
  return { ok: true, exportId: q.exportId };
}

/** A delivery still "running" long after any worker could be: record it (from its export, if it got that far). */
async function sweepLost(supabase, now) {
  const cutoff = new Date(now.getTime() - LOST_AFTER_MS).toISOString();
  const { data, error } = await supabase.from(REPORTS_TABLE).select("*").eq("last_run_status", "running").lt("last_run_at", cutoff).limit(LOST_PER_TICK);
  if (error) {
    console.error("reports tick: lost sweep failed:", error.message);
    return 0;
  }
  let n = 0;
  for (const r of data ?? []) {
    let outcome = { ok: false, code: "DELIVERY_LOST" };
    if (isUuid(r.last_export_id)) {
      const { data: ex } = await supabase.from("sundial_report_exports").select("id, status, error_code, delivery").eq("id", r.last_export_id).maybeSingle();
      const d = ex?.delivery;
      // The worker finished but its outcome never landed: record what it did.
      if (d?.status === "sent") outcome = { ok: true };
      else if (d?.status === "partial") outcome = { ok: true, partial: true, code: "SOME_SENDS_FAILED" };
      else if (d?.status === "failed") outcome = { ok: false, code: d.code || "SEND_FAILED" };
    }
    await recordOutcome(supabase, r.id, { ...outcome, exportId: r.last_export_id ?? null });
    n += 1;
  }
  return n;
}

/**
 * { task: "tick" } — every 15 minutes. Sweep lost runs, then claim and queue what is due (at
 * most CLAIMS_PER_TICK; the rest wait for the next tick).
 */
export async function runTick({ now = new Date() } = {}) {
  const started = Date.now();
  const supabase = await getSupabaseClient();
  const summary = { lost: await sweepLost(supabase, now), due: 0, claimed: 0, queued: 0, failed: 0 };
  const nowIso = now.toISOString();
  const { data, error } = await supabase
    .from(REPORTS_TABLE)
    .select("*")
    .eq("schedule->>enabled", "true")
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })
    .limit(CLAIMS_PER_TICK);
  if (error) {
    console.error("reports tick: due read failed:", error.message);
    return { ...summary, error: "DUE_READ_FAILED" };
  }
  for (const r of data ?? []) {
    summary.due += 1;
    let next = null;
    try {
      next = nextRunAt(r.schedule, now).toISOString();
    } catch (err) {
      console.error(`reports tick: no next slot for ${r.id}:`, err?.message || String(err));
    }
    // THE CLAIM: only if next_run_at is still what we read. A second tick updates nothing.
    const { data: claimed, error: claimErr } = await supabase
      .from(REPORTS_TABLE)
      .update({ next_run_at: next, last_run_status: "running", last_run_at: nowIso, last_run_error: null, last_export_id: null })
      .eq("id", r.id)
      .eq("next_run_at", r.next_run_at)
      .select("id");
    if (claimErr) {
      console.error(`reports tick: claim failed for ${r.id}:`, claimErr.message);
      continue;
    }
    if (!claimed?.length) continue; // someone else has it
    summary.claimed += 1;
    const res = await startScheduled(supabase, { ...r, next_run_at: next, last_run_status: "running", last_export_id: null }, now);
    if (res.ok) summary.queued += 1;
    else summary.failed += 1;
  }
  console.log(JSON.stringify({ tick: "done", ...summary, ms: Date.now() - started }));
  return summary;
}
