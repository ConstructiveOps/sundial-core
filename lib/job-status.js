// lib/job-status.js — THE rule table for a service job's Status__c (D-072 amendment 4).
//
// Two kinds of thing move a job's status on their own, and both decisions live here so
// nobody re-derives them:
//
//   1. The job follows its service calls — nextJobStatus(). The dispatch board's
//      settleJobStatus (sundial-service-board) and the day-of sweep (sundial-notify) are
//      its only callers; they do the write, the activity row and the cache stale mark.
//   2. A report date on the job means the work is done and billable —
//      readyToBillFromReportDates() (D-081 amendment 3, 2026-10-22), called from the job
//      PATCH in sundial-sf-update.
//
// The full table is in docs/service-workflows.md §2a. Nothing here touches I/O.

/** Call statuses that still have work ahead of them. Unscheduled is NOT open (it is in the tray). */
export const OPEN_CALL_STATUSES = Object.freeze(["Scheduled", "En Route", "In Progress"]);

/** Job statuses that mean "nothing on the calendar yet" — the dispatch tray. */
export const UNSCHEDULED_JOB_STATUSES = Object.freeze(["New", "Triaging", "Remote Investigation", "Ready to Schedule", "Awaiting Parts"]);

/** The org's picklist order (describe, 2026-10-21). "Before X" means an earlier index. */
export const JOB_STATUS_ORDER = Object.freeze([
  "New",
  "Triaging",
  "Remote Investigation",
  "Ready to Schedule",
  "Scheduled",
  "In Progress",
  "Awaiting Parts",
  "Awaiting Office Review",
  "Ready to Bill",
  "Invoiced",
  "Paid",
  "Closed",
]);

/** The three report dates on the job (Setup Date fields, 2026-10-22). Any one set → Ready to Bill. */
export const REPORT_DATE_FIELDS = Object.freeze(["Report_Uploaded_to_Partner_Portal__c", "Report_Sent_to_Customer__c", "Notes_Reported__c"]);
export const READY_TO_BILL = "Ready to Bill";

/** True when `status` sits before `target` in the picklist order. An unknown status is never "before". */
export function isBefore(status, target) {
  const a = JOB_STATUS_ORDER.indexOf(status);
  const b = JOB_STATUS_ORDER.indexOf(target);
  return a >= 0 && b >= 0 && a < b;
}

/** The calendar day (YYYY-MM-DD) of a moment in a time zone. */
export function localDay(iso, timeZone) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
}

/** The local hour (0–23) of a moment in a time zone. */
export function localHour(date, timeZone) {
  const h = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(date);
  return Number(h) % 24;
}

/**
 * What the job's status becomes after `trigger`, given the job's calls AFTER the change.
 * Returns the new status, or null for "leave it".
 *
 *   scheduled       a call got a window        New/Triaging/Remote Inv./Ready/Awaiting Parts → Scheduled
 *   in_progress     a call went In Progress    Scheduled → In Progress
 *   day_of          the sweep: a Scheduled call starts today (local)   Scheduled → In Progress
 *   complete        the last open call closed  Scheduled / In Progress → Awaiting Office Review
 *   cancelled /     the last open call left    Scheduled / In Progress → Ready to Schedule
 *   unscheduled       the calendar               (In Progress with a Complete call → Awaiting Office
 *                                                 Review: the work that WAS done still needs review)
 *   moved           a call's window changed    In Progress → Scheduled, only when no open call is
 *                                                 left on today AND nobody has clocked in on the job
 *                                                 (every Actual_Start__c blank) — the day-of move undone.
 *                                                 A job a tech clocked in on stays In Progress.
 *   reopened        a Complete call reopened   Awaiting Office Review → In Progress
 *
 * `opts.today` (YYYY-MM-DD) and `opts.timeZone` are needed by `moved` only.
 */
export function nextJobStatus(current, trigger, callsAfter, opts = {}) {
  const calls = callsAfter || [];
  const open = calls.filter((c) => OPEN_CALL_STATUSES.includes(c.Status__c));
  let next = null;
  if (trigger === "scheduled" && UNSCHEDULED_JOB_STATUSES.includes(current)) next = "Scheduled";
  if ((trigger === "in_progress" || trigger === "day_of") && current === "Scheduled") next = "In Progress";
  if (trigger === "complete" && open.length === 0 && ["Scheduled", "In Progress"].includes(current)) next = "Awaiting Office Review";
  if ((trigger === "cancelled" || trigger === "unscheduled") && open.length === 0) {
    if (current === "Scheduled") next = "Ready to Schedule";
    if (current === "In Progress") next = calls.some((c) => c.Status__c === "Complete") ? "Awaiting Office Review" : "Ready to Schedule";
  }
  if (trigger === "moved" && current === "In Progress" && opts.today && opts.timeZone) {
    const clockedIn = calls.some((c) => c.Actual_Start__c);
    const openToday = open.some((c) => localDay(c.Scheduled_Start__c, opts.timeZone) === opts.today);
    if (!clockedIn && open.length > 0 && !openToday) next = "Scheduled";
  }
  if (trigger === "reopened" && current === "Awaiting Office Review") next = "In Progress";
  return next && next !== current ? next : null;
}

const blank = (v) => v == null || (typeof v === "string" && v.trim() === "");

/**
 * D-081 amendment 3: when a report date goes from blank to a date and the job is still
 * before Ready to Bill, the job moves to Ready to Bill. Never backwards (Invoiced / Paid /
 * Closed stay), and clearing a date does nothing.
 *
 * @param {object} before  the job as it is now (Status__c + the three date fields)
 * @param {object} patch   the fields about to be written (any casing of the API names)
 * @returns {{ to: string, fields: string[] } | null}  the new status and which dates set it
 */
export function readyToBillFromReportDates(before, patch) {
  if (!before || !patch) return null;
  const keyOf = (name) => Object.keys(patch).find((k) => k.toLowerCase() === name.toLowerCase());
  // A PATCH that sets Status__c itself is the office's own choice; the rule stands aside.
  if (keyOf("Status__c")) return null;
  const set = REPORT_DATE_FIELDS.filter((f) => {
    const k = keyOf(f);
    return k && !blank(patch[k]) && blank(before[f]);
  });
  if (!set.length) return null;
  if (!isBefore(before.Status__c, READY_TO_BILL)) return null;
  return { to: READY_TO_BILL, fields: set };
}
