// labor.js — direct labor billing (D-072 amendment 6, 2026-09-15).
//
//   GET  /service/jobs/{id}/labor          the job's COMPLETED calls with their clock hours,
//                                          the tech's default rate, and the billing state
//   POST /service/jobs/{id}/labor          { calls:[{ id, billable, hours?, rate? }] } — flip
//                                          calls in/out of the bill, overtype hours / rates
//   POST /service/labor/default-rate       { userId, rate } — set a tech's Hourly_Bill_Rate__c
//
// The concept (Tim, 2026-09-15): scheduled calls have a window, but when the techs clock in
// and out they log REAL hours. Most jobs are priced from the price book, so those hours stay
// off the invoice. When the office decides a job (or one visit on it) is billed for time, it
// flips "Billable to customer" on that call and the hours become a Labor line on the job's
// estimate — one line per billable call — which flows onto the invoice like any other line.
//
// Rules the code holds:
//   - Only Complete calls are offered (the work is done; the clock is final).
//   - Hours = Duration_Minutes__c if the PWA summed intervals, else Actual_Start → Actual_End,
//     rounded UP to the quarter hour. The office may overtype (Billable_Hours__c). No clock and
//     no overtype = nothing to bill yet (the screen says so).
//   - Rate = Bill_Rate__c on the call, else the tech's Hourly_Bill_Rate__c, else nothing — the
//     office types one (and can push it to every call on the job, or save it as the tech's
//     default).
//   - The LINE is owned by this module: Source__c = "Time", Added_By_Service_Call__c = the
//     call. Flipping billable off deletes it; changing hours / rate rewrites it. Nothing here
//     touches lines from the price book.
//   - Once the estimate is Invoiced the lines are frozen → 409 ESTIMATE_INVOICED (void the
//     invoice first, like any other line edit).
//   - The call's own fields (Billable_to_Customer__c, Billable_Hours__c, Bill_Rate__c) are the
//     record of what the office decided, so the screen reopens exactly as it was left.

import { soqlEscapeString } from "../../lib/salesforce.js";
import { EVENTS } from "../../lib/service-activity.js";
import { LINE_SF_OBJECT, LINE_SELECT } from "./pricebook.js";
import { JOB_SF_OBJECT } from "./fields.js";

export const CALL_SF_OBJECT = "Sundial_Service_Call__c";
export const USER_SF_OBJECT = "Sundial_User__c";
export const LABOR_SOURCE = "Time";
export const LABOR_CALL_SELECT =
  "Id, Name, Sundial_Service_Job__c, Client__c, Tech__c, Status__c, Visit_Sub_Type__c, Scheduled_Start__c, Scheduled_End__c, " +
  "Actual_Start__c, Actual_End__c, Duration_Minutes__c, Billable_to_Customer__c, Billable_Hours__c, Bill_Rate__c, " +
  "Tech__r.First_Name__c, Tech__r.Last_Name__c, Tech__r.Hourly_Bill_Rate__c";
const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;

// --- pure helpers (tested directly) ------------------------------------------------

/** Clock minutes for a call: the PWA's interval sum, else actual start → end. Null = no clock. */
export function clockMinutes(call) {
  if (call.Duration_Minutes__c != null && Number(call.Duration_Minutes__c) > 0) return Number(call.Duration_Minutes__c);
  if (call.Actual_Start__c && call.Actual_End__c) {
    const m = (Date.parse(call.Actual_End__c) - Date.parse(call.Actual_Start__c)) / 60000;
    return m > 0 ? Math.round(m) : null;
  }
  return null;
}

/** Minutes → billable hours, rounded UP to the quarter hour (Tim: "round up to 15 min"). */
export function roundUpQuarterHours(minutes) {
  if (minutes == null || !(minutes > 0)) return null;
  return Math.ceil(minutes / 15) * 0.25;
}

const techName = (r) => [r?.First_Name__c, r?.Last_Name__c].filter(Boolean).join(" ").trim() || null;
const dayOf = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

/** The screen row for one call: what would be billed, and from where each number came. */
export function laborRow(call, line) {
  const minutes = clockMinutes(call);
  const clockHours = roundUpQuarterHours(minutes);
  const hours = call.Billable_Hours__c != null ? Number(call.Billable_Hours__c) : clockHours;
  const techRate = call.Tech__r?.Hourly_Bill_Rate__c != null ? Number(call.Tech__r.Hourly_Bill_Rate__c) : null;
  const rate = call.Bill_Rate__c != null ? Number(call.Bill_Rate__c) : techRate;
  const billable = call.Billable_to_Customer__c === true;
  return {
    id: call.Id,
    number: call.Name ?? null,
    status: call.Status__c ?? null,
    subType: call.Visit_Sub_Type__c ?? null,
    techId: call.Tech__c ?? null,
    techName: techName(call.Tech__r),
    techDefaultRate: techRate,
    date: call.Actual_Start__c ?? call.Scheduled_Start__c ?? null,
    actualStart: call.Actual_Start__c ?? null,
    actualEnd: call.Actual_End__c ?? null,
    clockMinutes: minutes,
    clockHours,
    hours,
    hoursSource: call.Billable_Hours__c != null ? "office" : clockHours != null ? "clock" : "none",
    rate,
    rateSource: call.Bill_Rate__c != null ? "call" : techRate != null ? "tech" : "none",
    billable,
    amount: billable && hours != null && rate != null ? cents(hours * rate) : 0,
    lineId: line?.Id ?? null,
    lineTotal: line?.Line_Total__c ?? (line ? cents(Number(line.Quantity__c || 0) * Number(line.Unit_Price__c || 0)) : null),
  };
}

/** The Labor line a billable call becomes. */
export function laborLineFields(call, { hours, rate, estimateId, tenantId, sortOrder }) {
  const who = techName(call.Tech__r) || "Technician";
  const f = {
    Estimate__c: estimateId,
    Client__c: tenantId,
    Kind__c: "Labor",
    Description__c: `Labor — ${who}${call.Actual_Start__c || call.Scheduled_Start__c ? `, ${dayOf(call.Actual_Start__c || call.Scheduled_Start__c)}` : ""} (${hours} h @ $${cents(rate).toFixed(2)}/h)`.slice(0, 255),
    Quantity__c: hours,
    Unit_of_Measure__c: "Hour",
    Unit_Price__c: cents(rate),
    Unit_Labor_Price__c: cents(rate),
    Price_Overridden__c: false,
    Taxable__c: false,
    Stage__c: "Proposed",
    Show_Unit_Price__c: true,
    Source__c: LABOR_SOURCE,
    Added_By_Service_Call__c: call.Id,
  };
  if (sortOrder != null) f.Sort_Order__c = sortOrder;
  return f;
}

/** Validate one entry of the POST body. */
export function parseLaborEntry(e) {
  const problems = [];
  const id = typeof e?.id === "string" ? e.id.trim() : "";
  if (!SF_ID_RE.test(id)) problems.push("id must be a Salesforce id");
  const billable = e?.billable === true;
  let hours;
  if (e?.hours !== undefined) {
    hours = e.hours === null || e.hours === "" ? null : Number(e.hours);
    if (hours !== null && !(Number.isFinite(hours) && hours >= 0)) problems.push("hours must be a non-negative number");
    if (hours !== null) hours = Math.round(hours * 100) / 100;
  }
  let rate;
  if (e?.rate !== undefined) {
    rate = e.rate === null || e.rate === "" ? null : Number(e.rate);
    if (rate !== null && !(Number.isFinite(rate) && rate >= 0)) problems.push("rate must be a non-negative number");
    if (rate !== null) rate = cents(rate);
  }
  return { id, billable, hours, rate, problems };
}

// --- handler factory -----------------------------------------------------------------
export function createLaborHandlers(d, h) {
  const { jsonResponse, bad, notFound, sfError, CACHE } = h;

  async function loadJob(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(
      `SELECT Id, Name, Estimate__c, Status__c, Client__c FROM ${JOB_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
    );
    return rows?.[0] ?? null;
  }
  async function loadCompletedCalls(jobId, tenantId) {
    return (
      (await d.sfQuery(
        `SELECT ${LABOR_CALL_SELECT} FROM ${CALL_SF_OBJECT} WHERE Sundial_Service_Job__c = '${soqlEscapeString(jobId)}' ` +
          `AND Client__c = '${soqlEscapeString(tenantId)}' AND Status__c = 'Complete' ORDER BY Actual_Start__c NULLS LAST, Scheduled_Start__c NULLS LAST, CreatedDate`
      )) || []
    );
  }
  async function loadTimeLines(estimateId, tenantId) {
    return (
      (await d.sfQuery(
        `SELECT ${LINE_SELECT} FROM ${LINE_SF_OBJECT} WHERE Estimate__c = '${soqlEscapeString(estimateId)}' ` +
          `AND Client__c = '${soqlEscapeString(tenantId)}' AND Source__c = '${LABOR_SOURCE}' ORDER BY Sort_Order__c NULLS LAST, CreatedDate`
      )) || []
    );
  }
  const lineByCall = (lines) => new Map(lines.filter((l) => l.Added_By_Service_Call__c).map((l) => [l.Added_By_Service_Call__c, l]));

  async function present(job, tenantId) {
    const est = job.Estimate__c ? await h.loadEstimate(job.Estimate__c, tenantId) : null;
    const [calls, lines] = await Promise.all([loadCompletedCalls(job.Id, tenantId), est ? loadTimeLines(est.Id, tenantId) : []]);
    const byCall = lineByCall(lines);
    const rows = calls.map((c) => laborRow(c, byCall.get(c.Id)));
    const billed = rows.filter((r) => r.billable);
    return {
      jobId: job.Id,
      jobNumber: job.Name ?? null,
      estimateId: est?.Id ?? null,
      estimateLocked: est?.Status__c === "Invoiced",
      calls: rows,
      summary: {
        billableCalls: billed.length,
        billableHours: cents(billed.reduce((s, r) => s + (r.hours ?? 0), 0)),
        billableAmount: cents(billed.reduce((s, r) => s + r.amount, 0)),
      },
    };
  }

  return {
    async getLabor({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      return jsonResponse(200, cors, await present(job, tenantId));
    },

    async saveLabor({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const entries = Array.isArray(body?.calls) ? body.calls.map(parseLaborEntry) : [];
      if (!entries.length) return bad(cors, "NO_CALLS", "Send calls: [{ id, billable, hours?, rate? }].");
      const problems = entries.flatMap((e) => e.problems);
      if (problems.length) return bad(cors, "LABOR_INVALID", problems.join("; "));
      const est = job.Estimate__c ? await h.loadEstimate(job.Estimate__c, tenantId) : null;
      if (!est) return bad(cors, "NO_ESTIMATE", "This job has no estimate to put labor lines on.");
      if (est.Status__c === "Invoiced") return jsonResponse(409, cors, { error: "locked", code: "ESTIMATE_INVOICED", message: "The invoice is issued; void it before changing billed labor." });

      const calls = await loadCompletedCalls(job.Id, tenantId);
      const byId = new Map(calls.map((c) => [c.Id, c]));
      const existing = lineByCall(await loadTimeLines(est.Id, tenantId));
      const applied = [];
      let sort = 900; // labor lines sit after whatever the office priced by hand
      for (const e of entries) {
        const call = byId.get(e.id);
        if (!call) return bad(cors, "CALL_INVALID", `${e.id} is not a completed call on this job.`);
        // 1. The call remembers the decision.
        const callFields = { Billable_to_Customer__c: e.billable };
        if (e.hours !== undefined) callFields.Billable_Hours__c = e.hours;
        if (e.rate !== undefined) callFields.Bill_Rate__c = e.rate;
        try {
          await d.sfUpdateRecord(CALL_SF_OBJECT, call.Id, callFields);
        } catch (err) {
          return sfError(cors, err, "service call billing update");
        }
        Object.assign(call, callFields);
        // 2. The line follows.
        const row = laborRow(call, existing.get(call.Id));
        const line = existing.get(call.Id);
        let action = "none";
        if (row.billable && row.hours != null && row.hours > 0 && row.rate != null && row.rate > 0) {
          const fields = laborLineFields(call, { hours: row.hours, rate: row.rate, estimateId: est.Id, tenantId, sortOrder: line?.Sort_Order__c ?? sort++ });
          try {
            if (line) {
              const { Estimate__c: _e, Client__c: _c, Source__c: _s, Added_By_Service_Call__c: _a, ...upd } = fields;
              await d.sfUpdateRecord(LINE_SF_OBJECT, line.Id, upd);
              action = "updated";
              row.lineId = line.Id;
            } else {
              const created = await d.sfCreateRecord(LINE_SF_OBJECT, fields);
              action = "created";
              row.lineId = created.id;
              existing.set(call.Id, { Id: created.id, ...fields });
            }
          } catch (err) {
            return sfError(cors, err, "labor line write");
          }
        } else if (line) {
          try {
            await d.sfDeleteRecord(LINE_SF_OBJECT, line.Id);
          } catch (err) {
            return sfError(cors, err, "labor line delete");
          }
          existing.delete(call.Id);
          action = "removed";
          row.lineId = null;
        } else if (row.billable) {
          action = "pending"; // billable but no hours / rate yet — nothing to write
        }
        applied.push({ id: call.Id, action, hours: row.hours, rate: row.rate, amount: row.amount });
      }
      await h.markStale(CACHE.call, applied.map((a) => a.id), tenantId);
      await h.markStale(CACHE.line, [...existing.values()].map((l) => l.Id), tenantId);
      const { totals } = await h.recomputeAndStore(est, tenantId);
      await h.act(ctx, {
        event: EVENTS.LABOR_BILLED, recordType: "job", recordSfId: job.Id, jobSfId: job.Id, estimateSfId: est.Id,
        details: { calls: applied, total: totals.total },
      });
      const view = await present(job, tenantId);
      return jsonResponse(200, cors, { success: true, applied, totals: totals.fields, ...view });
    },

    async setDefaultRate({ ctx, body }) {
      const { tenantId, cors } = ctx;
      const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
      const rate = body?.rate === null ? null : Number(body?.rate);
      if (!SF_ID_RE.test(userId)) return bad(cors, "USER_INVALID", "userId must be a Salesforce id.");
      if (rate !== null && !(Number.isFinite(rate) && rate >= 0)) return bad(cors, "RATE_INVALID", "rate must be a non-negative number (or null to clear).");
      const rows = await d.sfQuery(
        `SELECT Id, First_Name__c, Last_Name__c, Hourly_Bill_Rate__c FROM ${USER_SF_OBJECT} WHERE Id = '${soqlEscapeString(userId)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
      );
      const user = rows?.[0];
      if (!user) return notFound(cors);
      try {
        await d.sfUpdateRecord(USER_SF_OBJECT, user.Id, { Hourly_Bill_Rate__c: rate === null ? null : cents(rate) });
      } catch (err) {
        return sfError(cors, err, "user bill rate update");
      }
      await h.markStale("sundial_user_cache", [user.Id], tenantId);
      await h.act(ctx, { event: EVENTS.FIELD_UPDATED, recordType: "user", recordSfId: user.Id, details: { fields: { Hourly_Bill_Rate__c: { from: user.Hourly_Bill_Rate__c ?? null, to: rate } } } });
      return jsonResponse(200, cors, { success: true, id: user.Id, name: techName(user), rate: rate === null ? null : cents(rate) });
    },
  };
}
