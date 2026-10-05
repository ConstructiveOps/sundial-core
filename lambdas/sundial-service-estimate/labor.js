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
/**
 * The tech's pay rate (2026-10-05, Harmon's burden rate / job costing): Sundial_User__c.
 * Hourly_Cost_Rate__c, a Setup field, describe-guarded — selected only when the org has it.
 * Burdened cost per hour = cost rate × (1 + Labor_Burden_Percent__c / 100) from the tenant.
 */
export const COST_RATE_FIELD = "Hourly_Cost_Rate__c";
export const laborCallSelect = (withCost) => (withCost ? `${LABOR_CALL_SELECT}, Tech__r.${COST_RATE_FIELD}` : LABOR_CALL_SELECT);

/** A tech's burdened cost per hour, or null when the tech has no cost rate. */
export function burdenedRate(costRate, burdenPercent) {
  if (costRate == null || !Number.isFinite(Number(costRate))) return null;
  const b = Number(burdenPercent);
  return cents(Number(costRate) * (1 + (Number.isFinite(b) ? b : 0) / 100));
}
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

/**
 * The screen row for one call: what would be billed, and from where each number came.
 * `burdenPercent` (the tenant's) turns the tech's cost rate into `costRate` (burdened, per
 * hour) and `cost` (what the clocked hours cost the company, billable or not).
 */
export function laborRow(call, line, { burdenPercent = null } = {}) {
  const minutes = clockMinutes(call);
  const clockHours = roundUpQuarterHours(minutes);
  const hours = call.Billable_Hours__c != null ? Number(call.Billable_Hours__c) : clockHours;
  const techRate = call.Tech__r?.Hourly_Bill_Rate__c != null ? Number(call.Tech__r.Hourly_Bill_Rate__c) : null;
  const rate = call.Bill_Rate__c != null ? Number(call.Bill_Rate__c) : techRate;
  const billable = call.Billable_to_Customer__c === true;
  const techCostRate = call.Tech__r?.[COST_RATE_FIELD] != null ? Number(call.Tech__r[COST_RATE_FIELD]) : null;
  const costRate = burdenedRate(techCostRate, burdenPercent);
  const costHours = clockHours ?? hours; // what the clock says the work took; the office's billable hours only when there is no clock
  return {
    techCostRate,
    costRate,
    costHours,
    cost: costRate != null && costHours != null ? cents(costHours * costRate) : null,
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

/** The Labor line a billable call becomes. `costRate` (burdened) is remembered on the line for margin reporting. */
export function laborLineFields(call, { hours, rate, estimateId, tenantId, sortOrder, costRate = null }) {
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
  if (costRate != null) f.Unit_Labor_Cost__c = cents(costRate);
  return f;
}

/**
 * Job costing (2026-10-05): what the job cost against what it bills. Pure over the rows the
 * handler loads. `lines` are the estimate's non-Removed lines; `calls` the laborRow()s of
 * every Complete call (billable or not — the tech was paid either way).
 */
export function jobCosting({ lines = [], calls = [], totals = null, invoiceTotal = null, burdenPercent = null }) {
  const live = lines.filter((l) => l.Stage__c !== "Removed");
  const qty = (l) => Number(l.Quantity__c) || 0;
  const materialCost = cents(live.reduce((s, l) => s + qty(l) * (Number(l.Unit_Material_Cost__c) || 0), 0));
  // Labor PRICE-BOOK cost (a flat-rate labor item's internal cost) — never the Time lines,
  // whose cost is the tech's clock below (counting both would double it).
  const laborLineCost = cents(live.filter((l) => l.Source__c !== LABOR_SOURCE).reduce((s, l) => s + qty(l) * (Number(l.Unit_Labor_Cost__c) || 0), 0));
  const techLaborCost = cents(calls.reduce((s, c) => s + (c.cost ?? 0), 0));
  const techHours = cents(calls.reduce((s, c) => s + (c.costHours ?? 0), 0));
  const unpriced = calls.filter((c) => c.costHours != null && c.costHours > 0 && c.costRate == null);
  const totalCost = cents(materialCost + laborLineCost + techLaborCost);
  const revenue = invoiceTotal != null ? cents(invoiceTotal) : totals ? cents(totals.total) : null;
  const margin = revenue != null ? cents(revenue - totalCost) : null;
  return {
    burdenPercent: burdenPercent == null ? null : Number(burdenPercent),
    revenue,
    revenueSource: invoiceTotal != null ? "invoice" : totals ? "estimate" : "none",
    materialCost,
    laborLineCost,
    techLaborCost,
    techHours,
    totalCost,
    margin,
    marginPercent: revenue ? Math.round((margin / revenue) * 1000) / 10 : null,
    calls: calls.map((c) => ({ id: c.id, number: c.number, techId: c.techId, techName: c.techName, date: c.date, hours: c.costHours, techCostRate: c.techCostRate, costRate: c.costRate, cost: c.cost, billable: c.billable, billed: c.amount })),
    warnings: [
      ...unpriced.map((c) => `${c.techName ?? "A tech"} has no hourly cost rate — ${c.number ?? "a call"}'s ${c.costHours} h cost nothing here.`),
      ...(burdenPercent == null ? ["No Labor_Burden_Percent__c on the tenant — costs are unburdened pay."] : []),
    ],
  };
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
  /** The org has the tech cost-rate field? (describe-guarded; false when the Lambda has no describe helper) */
  async function hasCostRate() {
    return h.fieldExists ? (await h.fieldExists(USER_SF_OBJECT, COST_RATE_FIELD)) === true : false;
  }
  async function burdenPercentFor(tenantId) {
    return h.tenantSettings ? (await h.tenantSettings(tenantId))?.laborBurdenPercent ?? null : null;
  }
  async function loadCompletedCalls(jobId, tenantId) {
    return (
      (await d.sfQuery(
        `SELECT ${laborCallSelect(await hasCostRate())} FROM ${CALL_SF_OBJECT} WHERE Sundial_Service_Job__c = '${soqlEscapeString(jobId)}' ` +
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

  /** Pay rates are an Admin's to see (service.costing.read): everyone else gets the row without its cost columns. */
  const COST_KEYS = ["techCostRate", "costRate", "costHours", "cost"];
  function hideCosts(row) {
    const out = { ...row };
    for (const k of COST_KEYS) out[k] = null;
    return out;
  }
  async function present(job, tenantId, ctx = null) {
    const est = job.Estimate__c ? await h.loadEstimate(job.Estimate__c, tenantId) : null;
    const seesCost = ctx?.can ? ctx.can("service.costing.read") === true : false;
    const [calls, lines, burdenPercent] = await Promise.all([loadCompletedCalls(job.Id, tenantId), est ? loadTimeLines(est.Id, tenantId) : [], seesCost ? burdenPercentFor(tenantId) : null]);
    const byCall = lineByCall(lines);
    const rows = calls.map((c) => laborRow(c, byCall.get(c.Id), { burdenPercent })).map((r) => (seesCost ? r : hideCosts(r)));
    const billed = rows.filter((r) => r.billable);
    return {
      jobId: job.Id,
      jobNumber: job.Name ?? null,
      estimateId: est?.Id ?? null,
      estimateLocked: est?.Status__c === "Invoiced",
      burdenPercent: seesCost ? burdenPercent : null,
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
      return jsonResponse(200, cors, await present(job, tenantId, ctx));
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
      const burdenPercent = await burdenPercentFor(tenantId);
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
        const row = laborRow(call, existing.get(call.Id), { burdenPercent });
        const line = existing.get(call.Id);
        let action = "none";
        if (row.billable && row.hours != null && row.hours > 0 && row.rate != null && row.rate > 0) {
          const fields = laborLineFields(call, { hours: row.hours, rate: row.rate, estimateId: est.Id, tenantId, sortOrder: line?.Sort_Order__c ?? sort++, costRate: row.costRate });
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
      const view = await present(job, tenantId, ctx);
      return jsonResponse(200, cors, { success: true, applied, totals: totals.fields, ...view });
    },

    /** Job costing (2026-10-05): cost vs. revenue for one job, Admin / Executive only. */
    async getCosting({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const est = job.Estimate__c ? await h.loadEstimate(job.Estimate__c, tenantId) : null;
      const [calls, lines, burdenPercent] = await Promise.all([loadCompletedCalls(job.Id, tenantId), est && h.loadLines ? h.loadLines(est.Id, tenantId) : [], burdenPercentFor(tenantId)]);
      const rows = calls.map((c) => laborRow(c, null, { burdenPercent }));
      const totals = est && h.estimateTotals ? h.estimateTotals(est, lines) : null;
      // The live invoice's total is the revenue once issued; the estimate's total before.
      let invoiceTotal = null;
      try {
        const inv = await d.sfQuery(`SELECT Total__c, Status__c FROM Sundial_Service_Invoice__c WHERE Service_Job__c = '${soqlEscapeString(job.Id)}' AND Client__c = '${soqlEscapeString(tenantId)}' AND Status__c != 'Void' ORDER BY CreatedDate DESC LIMIT 1`);
        if (inv?.[0]?.Total__c != null) invoiceTotal = Number(inv[0].Total__c);
      } catch (e) {
        console.error("costing: invoice read failed:", e?.message || e);
      }
      const costing = jobCosting({ lines, calls: rows, totals, invoiceTotal, burdenPercent });
      if (!(await hasCostRate())) costing.warnings.unshift(`${USER_SF_OBJECT} has no ${COST_RATE_FIELD} yet — add it in Setup to cost the techs' hours.`);
      return jsonResponse(200, cors, { jobId: job.Id, jobNumber: job.Name ?? null, estimateId: est?.Id ?? null, ...costing });
    },

    /**
     * The rate sheet (2026-10-05): every active user with a bill rate, a cost rate, or a
     * place on the dispatch board — what the Payroll page's "Tech rates" table edits.
     * Admin / Executive (service.costing.read).
     */
    async listRates({ ctx }) {
      const { tenantId, cors } = ctx;
      const [withCost, withBoard, burdenPercent] = await Promise.all([hasCostRate(), h.fieldExists ? h.fieldExists(USER_SF_OBJECT, "Dispatch_Board__c") : false, burdenPercentFor(tenantId)]);
      const cols = `Id, First_Name__c, Last_Name__c, Access_Level__c, Default_Department__c, Hourly_Bill_Rate__c${withCost ? `, ${COST_RATE_FIELD}` : ""}${withBoard ? ", Dispatch_Board__c, Dispatch_Order__c" : ""}`;
      const rows = (await d.sfQuery(`SELECT ${cols} FROM ${USER_SF_OBJECT} WHERE Client__c = '${soqlEscapeString(tenantId)}' AND Active__c = true ORDER BY Last_Name__c, First_Name__c`)) || [];
      const techs = rows
        .filter((u) => u.Dispatch_Board__c === true || u.Access_Level__c === "Technician" || u.Default_Department__c === "Service" || u.Hourly_Bill_Rate__c != null || u[COST_RATE_FIELD] != null)
        .map((u) => ({
          id: u.Id,
          name: techName(u),
          level: u.Access_Level__c ?? null,
          onBoard: u.Dispatch_Board__c === true,
          billRate: u.Hourly_Bill_Rate__c != null ? Number(u.Hourly_Bill_Rate__c) : null,
          costRate: u[COST_RATE_FIELD] != null ? Number(u[COST_RATE_FIELD]) : null,
          burdenedRate: burdenedRate(u[COST_RATE_FIELD], burdenPercent),
        }));
      return jsonResponse(200, cors, { techs, burdenPercent, costRateField: withCost, warnings: withCost ? [] : [`${USER_SF_OBJECT} has no ${COST_RATE_FIELD} yet — add it in Setup to record pay rates.`] });
    },

    /** A tech's Hourly_Cost_Rate__c (their pay rate, before burden). Admin / Executive. */
    async setDefaultCostRate({ ctx, body }) {
      const { tenantId, cors } = ctx;
      const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
      const rate = body?.rate === null ? null : Number(body?.rate);
      if (!SF_ID_RE.test(userId)) return bad(cors, "USER_INVALID", "userId must be a Salesforce id.");
      if (rate !== null && !(Number.isFinite(rate) && rate >= 0)) return bad(cors, "RATE_INVALID", "rate must be a non-negative number (or null to clear).");
      if (!(await hasCostRate())) return bad(cors, "FIELD_MISSING", `${USER_SF_OBJECT} has no ${COST_RATE_FIELD} yet — add the currency field in Setup first.`);
      const rows = await d.sfQuery(
        `SELECT Id, First_Name__c, Last_Name__c, ${COST_RATE_FIELD} FROM ${USER_SF_OBJECT} WHERE Id = '${soqlEscapeString(userId)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
      );
      const user = rows?.[0];
      if (!user) return notFound(cors);
      try {
        await d.sfUpdateRecord(USER_SF_OBJECT, user.Id, { [COST_RATE_FIELD]: rate === null ? null : cents(rate) });
      } catch (err) {
        return sfError(cors, err, "user cost rate update");
      }
      await h.markStale("sundial_user_cache", [user.Id], tenantId);
      await h.act(ctx, { event: EVENTS.FIELD_UPDATED, recordType: "user", recordSfId: user.Id, details: { fields: { [COST_RATE_FIELD]: { from: user[COST_RATE_FIELD] ?? null, to: rate } } } });
      return jsonResponse(200, cors, { success: true, id: user.Id, name: techName(user), rate: rate === null ? null : cents(rate) });
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
