// plan-service.js — the Service module: schedule, jobs, estimates, lines, calls, invoices,
// payments and the technicians' day clocks.
//
// The rules the real Lambdas enforce are reproduced here BY HAND, because a direct seed
// bypasses them (nothing in Salesforce fills these in):
//
//   * every job has exactly one estimate; lines live on the estimate; one payer per job
//   * estimate totals        = the real computeTotals() from the estimate Lambda
//   * a line from the book   = the real lineFromItem() (price / cost / description snapshot)
//   * a call's clock         = the real applyClockEvent() + clockFields() from tech.js, so
//                              Clock_Intervals__c is exactly the shape the board parses
//   * the job's status       = what settleJobStatus() would have left after its calls
//   * invoice / payment state = the real paidSummary(), invoiceStatusFor(),
//                              jobPaymentStatusFor() from invoice.js
//   * a tech's day           = the real dayFields() from day.js
//
// THE DISPATCH BOARD is designed first: for each of the three techs, 2–4 calls per working
// day from ten days before the anchor to seven days after, never overlapping, inside
// 07:00–16:00 Phoenix time. Past calls are Complete, today has one tech clocked in on a
// call, one on the way, one waiting for the next call, and the future is Scheduled. The
// 45 jobs are then laid over those calls so each job's status is the one its calls imply.

import { computeTotals, lineFromRecord, estimateFromRecord } from "../../lambdas/sundial-service-estimate/totals.js";
import { lineFromItem, adHocLine } from "../../lambdas/sundial-service-estimate/pricebook.js";
import { paidSummary, invoiceStatusFor, jobPaymentStatusFor } from "../../lambdas/sundial-service-estimate/invoice.js";
import { applyClockEvent, clockFields, appendStamped } from "../../lambdas/sundial-service-board/tech.js";
import { dayFields, intervalSpans, clipSpans, unionMs } from "../../lambdas/sundial-service-board/day.js";
import { addDays, addMinutes, isWeekday, onWeekday, phxAt, phxDateOf, phxMinutesOf, PHOENIX_TZ } from "./dates.js";
import { ref, nameOf, json, concat } from "./tokens.js";
import { OBJ } from "./policy.js";
import { PRICE_BOOK, SCENARIOS, AD_HOC_LINES, itemByCode } from "./service-catalog.js";
import { TECH_KEYS, DISPATCHER_KEY, SHOP, persona } from "./catalog.js";

export const JOB_COUNT = 45;
export const JOBLESS_ESTIMATE_COUNT = 6;
export const SCHEDULE_DAYS_BACK = 10;
export const SCHEDULE_DAYS_AHEAD = 7;
/** Scheduled windows stay inside these, so clock taps (a few minutes either side) stay inside 07:00–16:00. */
export const FIRST_START_MIN = 7 * 60 + 20;
export const LAST_END_MIN = 15 * 60 + 50;
/** "Now" for today's picture is kept inside the working day so the board always has a live call. */
export const DEMO_NOW_MIN = 8 * 60 + 30;
export const DEMO_NOW_MAX = 13 * 60 + 30;

/** Jobs are numbered oldest work first, the way real job numbers grow. */
export const JOB_STATUS_ORDER = Object.freeze([
  "Closed", "Paid", "Invoiced", "Ready to Bill", "Awaiting Parts", "Awaiting Office Review", "In Progress",
  "Scheduled", "Ready to Schedule", "Remote Investigation", "Triaging", "New",
]);
const JOB_STATUS_COUNTS = Object.freeze({
  Closed: 2, Paid: 4, Invoiced: 4, "Ready to Bill": 3, "Awaiting Parts": 2, "Awaiting Office Review": 4, "In Progress": 4,
  Scheduled: 14, "Ready to Schedule": 4, "Remote Investigation": 1, Triaging: 1, New: 2,
});
/** settleJobStatus (lambdas/sundial-service-board/index.js): what counts as an open call / an unscheduled job. */
export const OPEN_CALL_STATUSES = Object.freeze(["Scheduled", "En Route", "In Progress"]);
export const UNSCHEDULED_JOB_STATUSES = Object.freeze(["New", "Triaging", "Remote Investigation", "Ready to Schedule", "Awaiting Parts"]);

const money = (n) => Math.round(n * 100) / 100;
const pad3 = (n) => String(n).padStart(3, "0");
const round5 = (m) => Math.round(m / 5) * 5;
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
const clampIso = (iso, maxIso) => (Date.parse(iso) > Date.parse(maxIso) ? maxIso : iso);
const hoursBefore = (iso, h) => addMinutes(iso, -Math.round(h * 60));
/** `want`, kept no earlier than `lo` and (where that still allows) no later than `hi`. */
const between = (lo, want, hi) => {
  const t = Math.max(Date.parse(lo), Math.min(Date.parse(want), Date.parse(hi)));
  return new Date(t).toISOString();
};
/**
 * The office works 08:00–17:00 on weekdays. A thing the OFFICE did (sent an estimate,
 * booked a call) is moved back to the end of the previous office day when the arithmetic
 * landed it at 3 a.m. or on a Sunday. Moving only ever goes EARLIER, so the order of the
 * events around it is kept.
 */
function officeBefore(iso) {
  let date = phxDateOf(iso);
  const min = phxMinutesOf(iso);
  if (isWeekday(date) && min >= 8 * 60 && min <= 17 * 60) return iso;
  if (!isWeekday(date) || min < 8 * 60) date = onWeekday(addDays(date, -1));
  return phxAt(date, 16 * 60 + (Date.parse(iso) / 60000) % 45);
}

// ---------------------------------------------------------------------------------------
// 1. The dispatch board
// ---------------------------------------------------------------------------------------

/** Lay calls end to end inside [fromMin, toMin] — never overlapping, 30–50 minutes apart. */
function fillWindow(r, fromMin, toMin, want) {
  const out = [];
  let cursor = Math.ceil(fromMin / 5) * 5 + r.int(0, 4) * 5;
  const lengths = { 1: [120, 150, 180], 2: [120, 150, 180], 3: [90, 120, 150], 4: [60, 90, 90, 120] }[Math.min(4, Math.max(1, want))];
  while (out.length < want) {
    let dur = r.pick(lengths);
    if (cursor + dur > toMin) dur = 90;
    if (cursor + dur > toMin) dur = 60;
    if (cursor + dur > toMin) break;
    out.push({ startMin: cursor, endMin: cursor + dur });
    cursor += dur + r.int(6, 10) * 5;
  }
  return out;
}

/** The demo's "now": the run's real time, moved inside the working day if it fell outside. */
export function demoNowFor(anchorDate, anchorNow) {
  const real = phxDateOf(anchorNow) === anchorDate ? phxMinutesOf(anchorNow) : DEMO_NOW_MIN + 120;
  const nowMin = Math.min(DEMO_NOW_MAX, Math.max(DEMO_NOW_MIN, round5(real)));
  return { nowMin, now: phxAt(anchorDate, nowMin) };
}

/**
 * Every slot on the board. `kind` is what the call in that slot will be:
 * complete | inprogress | enroute | scheduled  (cancelled / noshow are marked later).
 * `fromOffset` / `toOffset` are days relative to the anchor; --freshen reuses this with
 * its own range.
 */
export const NORMAL_DAY = Object.freeze([[2, 70], [3, 24], [4, 6]]);
export function buildSchedule({ rng, anchorDate, nowMin, fromOffset = -SCHEDULE_DAYS_BACK, toOffset = SCHEDULE_DAYS_AHEAD, techKeys = TECH_KEYS, futureDay = NORMAL_DAY }) {
  const slots = [];
  const push = (techKey, date, w, kind) =>
    slots.push({ techKey, date, startMin: w.startMin, endMin: w.endMin, start: phxAt(date, w.startMin), end: phxAt(date, w.endMin), kind });
  for (let off = fromOffset; off <= toOffset; off++) {
    const date = addDays(anchorDate, off);
    // The anchor day is ALWAYS a working day for the demo, even on a weekend — the board
    // has to look alive on the day it is shown.
    if (off !== 0 && !isWeekday(date)) continue;
    techKeys.forEach((techKey, ti) => {
      const r = rng.fork(`${techKey}/${date}`);
      if (off !== 0) {
        // Mostly two calls a day, sometimes three, now and then four. (--freshen may ask for
        // fuller FUTURE days when it has more open calls to place than a normal week holds.)
        const want = r.weighted(off > 0 ? futureDay : NORMAL_DAY);
        let windows = fillWindow(r, FIRST_START_MIN, LAST_END_MIN, want);
        if (windows.length < 2) windows = [{ startMin: FIRST_START_MIN, endMin: FIRST_START_MIN + 120 }, { startMin: FIRST_START_MIN + 165, endMin: FIRST_START_MIN + 285 }];
        for (const w of windows) push(techKey, date, w, off < 0 ? "complete" : "scheduled");
        return;
      }
      // TODAY. Each tech has a "pivot" call placed around the demo's now:
      //   tech 1 is clocked in on it, tech 2 is driving to it, tech 3 has it next.
      const pivot = ti === 0
        ? { startMin: round5(nowMin - 40), len: 120, kind: "inprogress", beforeGap: 35 }
        : ti === 1
          ? { startMin: round5(nowMin + 15), len: 120, kind: "enroute", beforeEnd: nowMin - 25 }
          : { startMin: round5(nowMin + 45), len: 120, kind: "scheduled", beforeEnd: nowMin - 20 };
      pivot.endMin = Math.min(pivot.startMin + pivot.len, LAST_END_MIN);
      const beforeEnd = pivot.beforeEnd ?? pivot.startMin - pivot.beforeGap;
      const before = fillWindow(r, FIRST_START_MIN, beforeEnd, r.int(1, 2));
      let after = fillWindow(r, pivot.endMin + 30, LAST_END_MIN, r.int(1, 2));
      if (before.length + after.length > 3) after = after.slice(0, 3 - before.length);
      for (const w of before) push(techKey, date, w, "complete");
      push(techKey, date, pivot, pivot.kind);
      for (const w of after) push(techKey, date, w, "scheduled");
    });
  }
  slots.sort((a, b) => a.start.localeCompare(b.start) || a.techKey.localeCompare(b.techKey));
  return slots;
}

/**
 * Hand a time-ordered pool of slots to a time-ordered list of jobs: each job gets one
 * "first visit" spread evenly through the pool, and the slots in between become return
 * visits (or a second tech) on the job whose first visit is nearest — never the same tech
 * twice on one job on one day.
 */
function distribute(slots, jobs, maxPerJob = 4) {
  const n = slots.length;
  const m = jobs.length;
  if (m === 0) return;
  if (n < m) throw new Error(`demo schedule: ${n} slots for ${m} jobs — not enough calls on the board`);
  const primary = new Set();
  jobs.forEach((job, j) => {
    const i = Math.floor((j * n) / m);
    primary.add(i);
    job.slots.push(slots[i]);
  });
  const fits = (job, slot, cap) => job.slots.length < cap && !job.slots.some((s) => s.techKey === slot.techKey && s.date === slot.date);
  slots.forEach((slot, i) => {
    if (primary.has(i)) return;
    const near = Math.min(m - 1, Math.floor((i * m) / n));
    const order = [...jobs.keys()].sort((a, b) => Math.abs(a - near) - Math.abs(b - near) || a - b);
    const j = order.find((x) => fits(jobs[x], slot, maxPerJob)) ?? order.find((x) => fits(jobs[x], slot, maxPerJob + 3)) ?? near;
    jobs[j].slots.push(slot);
  });
}

// ---------------------------------------------------------------------------------------
// 2. Calls
// ---------------------------------------------------------------------------------------

const near = (r, p, spread = 0.0003) => ({
  lat: Math.round((p.lat + (r.next() - 0.5) * spread) * 1e6) / 1e6,
  lng: Math.round((p.lng + (r.next() - 0.5) * spread) * 1e6) / 1e6,
  accuracy: r.int(5, 18),
});

/** One service call for one slot — status, clock, notes, exactly as the tech app would leave them. */
function buildCall(job, slot, idx, r) {
  const tech = slot.techKey ? persona(slot.techKey) : null;
  const key = `call:${pad3(job.no)}-${idx}`;
  const place = job.profile.place;
  const f = {
    Client__c: ref("tenant"),
    Visit_Type__c: "Service",
    Visit_Sub_Type__c: "On-Site",
    Sundial_Service_Job__c: ref(job.key),
    Tech__c: slot.techKey ? ref(slot.techKey) : undefined,
    Scheduled_Start__c: slot.start ?? undefined,
    Scheduled_End__c: slot.end ?? undefined,
  };
  const call = { key, jobKey: job.key, techKey: slot.techKey ?? null, kind: slot.kind, start: slot.start ?? null, end: slot.end ?? null, date: slot.date ?? null, intervals: [], fields: f };
  const ev = (n) => `demo-${key.replace(":", "-")}-${n}`;
  let log = [];
  const apply = (kind, at, gps, n) => {
    log = applyClockEvent(log, { kind, at, gps, eventId: ev(n) }).intervals;
  };

  if (slot.kind === "unscheduled") {
    f.Status__c = "Unscheduled";
    f.Private_Notes__c = slot.note ?? undefined;
    return call;
  }
  if (slot.kind === "scheduled") {
    f.Status__c = "Scheduled";
    return call;
  }
  if (slot.kind === "cancelled") {
    f.Status__c = "Cancelled";
    f.Cancel_Reason__c = "Customer asked to move the appointment.";
    call.cancelledAt = hoursBefore(slot.start, 3);
    return call;
  }

  const arriveAt = addMinutes(slot.start, r.int(-5, 8));
  const viaDrive = slot.kind !== "complete" || r.chance(0.7);
  if (slot.kind === "enroute") {
    // On the way: an OPEN en_route interval with no arrival yet.
    apply("en_route", addMinutes(slot.demoNow, -8), near(r, SHOP, 0.02), 1);
    f.Status__c = "En Route";
  } else {
    if (viaDrive) apply("en_route", addMinutes(arriveAt, -r.int(8, 15)), near(r, SHOP, 0.02), 1);
    apply("clock_in", arriveAt, near(r, place), 2);
    if (slot.kind === "inprogress") {
      f.Status__c = "In Progress";
    } else if (slot.kind === "noshow") {
      apply("clock_out", addMinutes(arriveAt, 15), near(r, place), 3);
      f.Status__c = "No-Show";
    } else {
      apply("clock_out", addMinutes(slot.end, r.int(-20, 5)), near(r, place), 3);
      f.Status__c = "Complete";
    }
    f.Geofence_Verified__c = true;
  }
  call.intervals = log;
  Object.assign(f, compact(clockFields(log)));
  call.actualStart = f.Actual_Start__c ?? null;
  call.actualEnd = f.Actual_End__c ?? null;
  call.minutes = f.Duration_Minutes__c ?? null;
  call.arrivedAt = log[0]?.arrived ?? null;

  if (slot.kind === "complete") {
    const stampAt = addMinutes(call.actualEnd, -4);
    const body = job.visitNotes[(idx - 1) % job.visitNotes.length];
    call.workNote = body;
    f.Work_Notes__c = appendStamped(null, { name: tech.name, at: stampAt, timeZone: PHOENIX_TZ, body });
    if (r.chance(0.5)) {
      call.privateNote = job.scenario.priv;
      f.Private_Notes__c = appendStamped(null, { name: tech.name, at: stampAt, timeZone: PHOENIX_TZ, body: job.scenario.priv });
    }
    f.Checklist_Template_Key__c = "default";
    const done = { done: true, at: stampAt, by: tech.name };
    f.Checklist_State__c = JSON.stringify({ walkthrough: done, tools: done, review: r.chance(0.6) ? done : { done: false } });
  }
  if (slot.kind === "noshow") {
    call.workNote = "Nobody home at the appointment time. Waited fifteen minutes, left a door tag and texted the customer.";
    f.Work_Notes__c = appendStamped(null, { name: tech.name, at: call.actualEnd, timeZone: PHOENIX_TZ, body: call.workNote });
  }
  return call;
}

/**
 * What settleJobStatus() leaves a job at after its calls, replayed in time order, followed
 * by the office's own steps (the statuses no automation sets). Exported for the tests:
 * the plan says what status each job has, this says what the calls imply.
 *
 * Mirrors lambdas/sundial-service-board/index.js settleJobStatus:
 *   scheduled    job in an "unscheduled" status              -> Scheduled
 *   in_progress  job Scheduled                                -> In Progress
 *   complete     no open call left, job Scheduled/In Progress -> Awaiting Office Review
 *   cancelled    no open call left, job Scheduled             -> Ready to Schedule
 */
export function replayJobTransitions(startStatus, calls, officeSteps = []) {
  let status = startStatus;
  const open = new Set();
  const events = [];
  const transitions = [];
  for (const c of calls) {
    if (c.kind === "unscheduled") continue; // never moves the job (D-072 amendment 6)
    events.push({ at: c.bookedAt ?? "0000", order: 0, call: c, trigger: "scheduled" });
    if (["inprogress", "complete", "noshow"].includes(c.kind)) events.push({ at: c.arrivedAt ?? c.start, order: 1, call: c, trigger: "in_progress" });
    if (c.kind === "complete" || c.kind === "noshow") events.push({ at: c.actualEnd ?? c.end, order: 2, call: c, trigger: "complete" });
    if (c.kind === "cancelled") events.push({ at: c.cancelledAt ?? c.start, order: 2, call: c, trigger: "cancelled" });
  }
  for (const s of officeSteps) events.push({ at: s.at, order: 3, office: s.to });
  events.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.order - b.order);
  const move = (to, at, via) => {
    if (to === status) return;
    transitions.push({ from: status, to, at, via });
    status = to;
  };
  for (const e of events) {
    if (e.office) { move(e.office, e.at, e.office === "Invoiced" || e.office === "Paid" ? "invoice" : "office"); continue; }
    if (e.trigger === "scheduled") {
      open.add(e.call.key);
      if (UNSCHEDULED_JOB_STATUSES.includes(status)) move("Scheduled", e.at, "dispatch");
    } else if (e.trigger === "in_progress") {
      if (status === "Scheduled") move("In Progress", e.at, "dispatch");
    } else if (e.trigger === "complete") {
      open.delete(e.call.key);
      if (open.size === 0 && ["Scheduled", "In Progress"].includes(status)) move("Awaiting Office Review", e.at, "dispatch");
    } else if (e.trigger === "cancelled") {
      open.delete(e.call.key);
      if (open.size === 0 && status === "Scheduled") move("Ready to Schedule", e.at, "dispatch");
    }
  }
  return { status, transitions };
}
export function replayJobStatus(startStatus, calls, officeSteps = []) {
  return replayJobTransitions(startStatus, calls, officeSteps).status;
}

// ---------------------------------------------------------------------------------------
// 3. Estimates and lines
// ---------------------------------------------------------------------------------------

function itemRecord(item) {
  // The shape lineFromItem() reads: a Sundial_Price_Book_Item__c row. `Id` is a marker the
  // writer swaps for the real id.
  return {
    Id: ref(item.key),
    Name: item.name,
    Kind__c: item.kind,
    Description__c: item.description,
    Default_Quantity__c: 1,
    Unit_of_Measure__c: item.unit,
    Labor_Price__c: item.kind === "Material" ? null : item.price,
    Material_Price__c: item.kind === "Material" ? item.price : null,
    Labor_Cost__c: item.kind === "Material" ? null : item.cost || null,
    Material_Cost__c: item.kind === "Material" ? item.cost : null,
    Taxable__c: item.taxable,
  };
}

/** The price-book rows as Salesforce records. */
export function priceBookOps() {
  return PRICE_BOOK.map((item) => ({
    op: "create",
    key: item.key,
    object: OBJ.item,
    phase: "pricebook",
    fields: compact({
      Name: item.name,
      Client__c: ref("tenant"),
      Item_Code__c: item.code,
      Version__c: 1,
      Is_Active__c: true,
      Kind__c: item.kind,
      Category__c: item.category,
      Job_Type__c: item.jobType,
      Service_Type__c: item.serviceType,
      Description__c: item.description,
      Unit_of_Measure__c: item.unit,
      Default_Quantity__c: 1,
      Estimated_Hours__c: item.hours ?? undefined,
      Labor_Price__c: item.kind === "Material" ? undefined : item.price,
      Material_Price__c: item.kind === "Material" ? item.price : undefined,
      Labor_Cost__c: item.kind === "Material" || !item.cost ? undefined : item.cost,
      Material_Cost__c: item.kind === "Material" ? item.cost : undefined,
      Taxable__c: item.taxable,
    }),
  }));
}

/**
 * One estimate with its lines and stored totals.
 * @param {object} spec { key, profile, scenario, status, times, discount, deposit, approvalMethod, versions, jobKey, solarKey, adHoc, removedLine }
 */
function buildEstimate(spec, r) {
  const { key, profile, scenario, status } = spec;
  const sent = status !== "Draft";
  const approved = status === "Approved" || status === "Invoiced";
  const lineStage = approved ? "Approved" : "Proposed";
  const ctx = { estimateId: ref(key), tenantId: ref("tenant") };
  const lines = [];
  let sort = 0;
  for (const [code, qty] of scenario.lines) {
    sort += 10;
    const fields = compact(lineFromItem(itemRecord(itemByCode(code)), { quantity: qty, stage: lineStage, sortOrder: sort }, ctx));
    lines.push({ key: `line:${key.split(":")[1]}-${sort / 10}`, fields });
  }
  if (spec.adHoc) {
    sort += 10;
    const built = adHocLine({ ...spec.adHoc, quantity: 1, stage: lineStage, sortOrder: sort }, ctx);
    lines.push({ key: `line:${key.split(":")[1]}-${sort / 10}`, fields: compact(built.fields) });
  }
  if (spec.removedLine) {
    // A line the office took off again: it stays on the estimate as "Removed" and counts for nothing.
    sort += 10;
    const fields = compact(lineFromItem(itemRecord(itemByCode("SVC-TRIP")), { quantity: 1, stage: "Removed", sortOrder: sort }, ctx));
    lines.push({ key: `line:${key.split(":")[1]}-${sort / 10}`, fields });
  }

  const f = {
    Client__c: ref("tenant"),
    Sundial_Customer__c: ref(profile.key),
    Status__c: status,
    Version__c: sent ? spec.versions ?? 1 : 0,
    Is_Template__c: false,
    Discount_Scope__c: spec.discount?.scope ?? "Both",
    Discount_Type__c: spec.discount?.type ?? "Percent",
    Discount_Value__c: spec.discount?.value ?? undefined,
    Discount_Source__c: spec.discount ? "Manual" : undefined,
    Markup_Type__c: "Percent",
    Deposit_Type__c: spec.deposit?.type ?? "Percent",
    Deposit_Required__c: !!spec.deposit,
    Deposit_Value__c: spec.deposit?.value ?? undefined,
    Tax_Rate__c: profile.place.taxRate,
    Tax_Jurisdiction__c: `${profile.place.city}, ${profile.place.state}`,
    // The four snapshots, as snapshotFields() in the estimate Lambda composes them.
    Customer_Name_at_Creation__c: profile.person.name,
    Address_at_Creation__c: [profile.place.street, profile.place.city, profile.place.state, profile.place.zip].join(", "),
    Primary_Phone_at_Creation__c: profile.phone,
    Primary_Email_at_Creation__c: profile.email,
    Originating_Solar_Project__c: spec.solarKey ? ref(spec.solarKey) : undefined,
    Sold_By__c: ref(DISPATCHER_KEY),
    Scope_Summary__c: spec.scope,
    Internal_Notes__c: "DEMO DATA - fictional estimate.",
  };
  // Totals: the estimate Lambda's own function over the lines, stored exactly as it stores them.
  const totals = computeTotals(lines.map((l) => lineFromRecord(l.fields)), estimateFromRecord(f));
  Object.assign(f, totals.fields);

  const t = spec.times;
  if (sent) {
    f.Last_Sent_At__c = t.sentAt;
    f.Last_Sent_Via__c = spec.sentVia ?? "Email";
    f.Valid_Until__c = spec.validUntil ?? addDays(phxDateOf(t.sentAt), 30);
    // Version_Log__c in the shape sendEstimate() appends: one entry per send. The lines
    // were "Proposed" at the moment of sending. No PDF was rendered for a seeded estimate.
    const entryLines = lines.filter((l) => l.fields.Stage__c !== "Removed").map((l) => ({
      itemId: l.fields.Price_Book_Item__c ?? null,
      desc: l.fields.Description__c,
      qty: l.fields.Quantity__c,
      unitPrice: l.fields.Unit_Price__c,
      kind: l.fields.Kind__c,
      stage: "Proposed",
    }));
    const log = [];
    const count = f.Version__c;
    for (let v = 1; v <= count; v++) {
      log.push({
        version: v,
        sentAt: v === count ? t.sentAt : hoursBefore(t.sentAt, 26 * (count - v)),
        sentBy: ref(DISPATCHER_KEY),
        sentVia: f.Last_Sent_Via__c,
        total: v === count ? totals.total : money(totals.total + 45),
        lines: entryLines,
        pdfKey: null,
      });
    }
    f.Version_Log__c = json(log);
  }
  if (["Viewed", "Approved", "Invoiced", "Declined"].includes(status)) f.Last_Viewed_At__c = t.viewedAt;
  if (approved) {
    f.Approved_At__c = t.approvedAt;
    f.Approved_Version__c = f.Version__c;
    f.Approved_Amount__c = totals.total;
    f.Approval_Method__c = spec.approvalMethod ?? "Online";
    f.Approved_By_Name__c = profile.person.name;
  }
  if (status === "Declined") f.Declined_Reason__c = "Decided to wait until after the summer.";
  if (spec.depositPaidAt) f.Deposit_Paid_At__c = spec.depositPaidAt;
  void r;
  return { key, status, profileKey: profile.key, fields: compact(f), lines, totals, times: t, scenario, jobKey: spec.jobKey ?? null };
}

// ---------------------------------------------------------------------------------------
// 4. Everything together
// ---------------------------------------------------------------------------------------

/**
 * @param {object} p
 *   profiles     all customer profiles (solar designed already)
 *   rng, schema, pick, anchorDate, anchorNow
 * @returns {{ ops: object[], jobs: object[], estimates: object[], calls: object[], techDays: object[], slots: object[], demoNow: string }}
 */
export function planService({ profiles, rng, schema, pick, anchorDate, anchorNow, onLiveDemo = null }) {
  const J = OBJ.job;
  const { nowMin, now } = demoNowFor(anchorDate, anchorNow);
  const slots = buildSchedule({ rng: rng.fork("schedule"), anchorDate, nowMin });
  for (const s of slots) s.demoNow = now;
  const r = rng.fork("service");

  // --- which statuses exist live, and how many jobs each gets ------------------------
  const liveStatuses = new Set(schema.values(J, "Status__c"));
  const jobs = [];
  let lost = 0;
  for (const status of JOB_STATUS_ORDER) {
    if (!liveStatuses.has(status)) { lost += JOB_STATUS_COUNTS[status]; continue; }
    for (let i = 0; i < JOB_STATUS_COUNTS[status]; i++) jobs.push({ status, idx: i, slots: [], extraSlots: [] });
  }
  for (let i = 0; i < lost; i++) jobs.push({ status: "Scheduled", idx: 100 + i, slots: [], extraSlots: [] });
  jobs.forEach((j, i) => { j.no = i + 1; j.key = `job:${pad3(i + 1)}`; j.estKey = `estimate:${pad3(i + 1)}`; });
  const of = (status) => jobs.filter((j) => j.status === status);

  // --- lay the jobs over the board ------------------------------------------------------
  const past = slots.filter((s) => s.kind === "complete" && s.date < anchorDate);
  const special = rng.fork("special").shuffle(past);
  const cancelledSlots = special.slice(0, 2);
  const noShowSlot = special[2];
  for (const s of cancelledSlots) s.kind = "cancelled";
  if (noShowSlot) noShowSlot.kind = "noshow";

  const livePivot = slots.find((s) => s.kind === "inprogress");
  const inProgress = of("In Progress");
  const liveJob = inProgress[0] ?? null;
  const multiVisit = inProgress.slice(1);
  if (liveJob && livePivot) liveJob.slots.push(livePivot);

  // Jobs whose work is done take the completed calls, oldest status first. The calls of the
  // last day or so go to jobs still waiting for the office (or still in progress); jobs that
  // were already billed only take calls at least two days old, so "invoiced the next
  // morning, paid a few days later" always fits before today.
  const complete = slots.filter((s) => s.kind === "complete");
  const recentJobs = [...of("Awaiting Office Review"), ...multiVisit];
  const billedJobs = [...of("Closed"), ...of("Paid"), ...of("Invoiced"), ...of("Ready to Bill"), ...of("Awaiting Parts")];
  const sinceYesterday = complete.filter((s) => s.date >= addDays(anchorDate, -1)).length;
  const recentCount = Math.min(complete.length, Math.max(sinceYesterday, recentJobs.length + 2));
  distribute(complete.slice(0, complete.length - recentCount), billedJobs);
  distribute(complete.slice(complete.length - recentCount), recentJobs);
  // Jobs with work still to come take the open calls (today's en-route call first).
  const openJobs = [...of("Scheduled"), ...multiVisit];
  distribute(slots.filter((s) => s.kind === "scheduled" || s.kind === "enroute"), openJobs);

  // A cancelled call is the ONLY call of a job that went back to Ready to Schedule; a
  // no-show is an extra call on a job waiting for the office.
  const rts = of("Ready to Schedule");
  cancelledSlots.forEach((s, i) => rts[i]?.slots.push(s));
  if (noShowSlot) of("Awaiting Office Review")[0]?.slots.push(noShowSlot);
  // Four calls waiting in the tray with no window yet.
  const tray = [
    { job: rts[0], techKey: TECH_KEYS[0], note: "Customer will call back with a day that works. Morning preferred." },
    { job: rts[2], techKey: TECH_KEYS[1], note: "Needs the long ladder. Schedule with a second tech if possible." },
    { job: rts[3], techKey: null, note: "Any tech. Customer is home all week." },
    { job: of("Awaiting Parts")[0], techKey: TECH_KEYS[2], note: "Return visit once the part arrives. Same tech if possible." },
  ];
  for (const t of tray) if (t.job) t.job.extraSlots.push({ kind: "unscheduled", techKey: t.techKey, note: t.note });

  // --- who each job is for ----------------------------------------------------------------
  // Service-only customers with work: the first five have only called in (no estimate yet).
  const serviceOnly = profiles.filter((p) => p.kind === "service").slice(5);
  const INSTALLED_FROM = ["installEnd", "inspectionBooked", "inspection", "inspectionPass", "utilityDocs", "meterSet", "pto", "finalInvoiced", "finalPaid", "closeoutDocs", "closed"];
  const installed = profiles.filter((p) => p.kind === "solar" && INSTALLED_FROM.includes(p.solar.rule.done) && !p.solar.rule.cancelled && !p.solar.rule.hold);
  const total = jobs.length + JOBLESS_ESTIMATE_COUNT;
  const owners = new Array(total).fill(null);
  // Eight service-only customers get exactly ONE piece of work each, chosen so that the
  // Service > Customers board has a card in every column: closed, resolved, waiting on
  // parts, in progress (two), estimate created, waiting on the customer, closed-lost.
  // Two of them double as the "live demo" contacts: the job a tech is driving to right
  // now, and the first job ready to bill.
  const enRouteJob = jobs.find((j) => j.slots.some((s) => s.kind === "enroute")) ?? null;
  const readyToBill = of("Ready to Bill")[0] ?? null;
  const joblessNo = (i) => jobs.length + 1 + i; // Draft, Draft, Sent, Sent, Declined, Expired
  const single = [enRouteJob?.no, readyToBill?.no, of("Closed")[0]?.no, of("Paid")[0]?.no, of("Awaiting Parts")[0]?.no, of("New")[0]?.no, joblessNo(2), joblessNo(4)]
    .filter((no) => Number.isInteger(no));
  [...new Set(single)].forEach((no, i) => { if (serviceOnly[i]) owners[no - 1] = serviceOnly[i]; });
  const shared = serviceOnly.slice(new Set(single).size);
  let si = 0;
  let ii = 0;
  for (let i = 0; i < total; i++) {
    if (owners[i]) continue;
    const useSolar = installed.length && (i % 2 === 1 || !shared.length);
    owners[i] = useSolar ? installed[ii++ % installed.length] : (shared.length ? shared : serviceOnly)[si++ % (shared.length || serviceOnly.length)];
  }
  const liveDemoKeys = [enRouteJob, readyToBill].filter(Boolean).map((j) => owners[j.no - 1].key);
  // The owner's own phone / email go onto the live-demo customers NOW, before any record
  // (and its snapshot of the customer's contact details) is built.
  if (onLiveDemo) onLiveDemo(liveDemoKeys);

  // A customer never gets the same kind of job twice (it also keeps estimates tell-apart-able).
  const usedScenario = new Map();
  const scenarioFor = (profile, i) => {
    const used = usedScenario.get(profile.key) ?? new Set();
    usedScenario.set(profile.key, used);
    for (let k = 0; k < SCENARIOS.length; k++) {
      const s = SCENARIOS[(i * 5 + k) % SCENARIOS.length];
      if (!used.has(s.id)) { used.add(s.id); return s; }
    }
    return SCENARIOS[i % SCENARIOS.length];
  };

  const estimateStatusFor = (job) => {
    switch (job.status) {
      case "New": case "Triaging": return "Draft";
      case "Remote Investigation": return "Draft";
      case "Ready to Schedule": return job.idx === 3 ? "Viewed" : "Approved";
      case "Scheduled": return job.idx === 5 || job.idx === 8 ? "Sent" : job.idx === 10 ? "Viewed" : "Approved";
      case "Closed": case "Paid": case "Invoiced": return "Invoiced";
      default: return "Approved";
    }
  };
  const liveOr = (field, value, fallback) => (schema.isLive(J, field, value) ? value : fallback);

  const ops = [];
  const estimates = [];
  const calls = [];

  // --- jobs ------------------------------------------------------------------------------
  for (const job of jobs) {
    const profile = owners[job.no - 1];
    const jr = r.fork(job.key);
    job.profile = profile;
    job.scenario = scenarioFor(profile, job.no);
    job.visitNotes = [job.scenario.work, "Return visit. Finished the remaining work, tested and tidied up.", "Second tech on site to help with the lift. Work completed together."];
    job.slots.sort((a, b) => a.start.localeCompare(b.start));
    const firstStart = job.slots.length ? job.slots[0].start : null;
    const estStatus = estimateStatusFor(job);
    const approvedEst = estStatus === "Approved" || estStatus === "Invoiced";

    // Times: the paperwork happened before the first visit, and never after "now".
    const t = {};
    if (firstStart) {
      t.approvedAt = clampIso(hoursBefore(firstStart, jr.int(20, 70)), hoursBefore(now, jr.int(3, 40)));
      t.viewedAt = hoursBefore(t.approvedAt, jr.int(1, 6));
      t.sentAt = officeBefore(hoursBefore(t.viewedAt, jr.int(1, 20)));
      t.createdAt = officeBefore(addMinutes(t.sentAt, -jr.int(20, 120)));
      t.intakeAt = officeBefore(addMinutes(t.createdAt, -jr.int(15, 90)));
    } else {
      const daysAgo = { New: 0, Triaging: 1, "Remote Investigation": 2 + job.idx, "Ready to Schedule": 3 + job.idx * 2 }[job.status] ?? 2;
      const day = daysAgo === 0 ? anchorDate : onWeekday(addDays(anchorDate, -daysAgo));
      t.intakeAt = daysAgo === 0 ? phxAt(day, Math.max(7 * 60 + 35, nowMin - 20 - job.idx * 35)) : phxAt(day, 8 * 60 + jr.int(0, 40) * 10);
      t.createdAt = clampIso(addMinutes(t.intakeAt, jr.int(10, 45)), now);
      t.sentAt = clampIso(addMinutes(t.createdAt, jr.int(30, 180)), now);
      t.viewedAt = clampIso(addMinutes(t.sentAt, jr.int(60, 600)), now);
      t.approvedAt = clampIso(addMinutes(t.viewedAt, jr.int(60, 900)), now);
    }
    job.times = t;
    // The call was booked once the customer said yes (or, on a few jobs, straight after the
    // estimate went out) — always before the first visit.
    job.bookedAt = approvedEst ? addMinutes(t.approvedAt, 40) : addMinutes(t.sentAt, 30);

    // Money set-up on a few jobs so the demo shows a discount, a deposit, a refund.
    const deposit =
      (job.status === "Scheduled" && (job.idx === 1 || job.idx === 4)) || (job.status === "Paid" && job.idx === 1)
        ? { type: "Percent", value: 25 }
        : job.status === "Paid" && job.idx === 2 ? { type: "Flat", value: 200 } : null;
    const discount =
      (job.status === "Paid" && job.idx === 0) || (job.status === "Awaiting Office Review" && job.idx === 1)
        ? { scope: "Both", type: "Percent", value: 10 }
        : job.status === "Invoiced" && job.idx === 2 ? { scope: "Labor", type: "Percent", value: 10 }
          : job.status === "Scheduled" && job.idx === 2 ? { scope: "Both", type: "Amount", value: 50 } : null;
    const solarKey = profile.solar ? profile.solar.key : null;
    const warranty = !!solarKey && job.scenario.serviceType === "Warranty";
    const leased = profile.solar?.finance === "Lease";
    const billTo =
      job.status === "Closed" && job.idx === 1 ? { type: "Leasing Partner", name: "Demo Leasing Partner (sample)", ref: `WO-DEMO-${1040 + job.no}` }
        : job.status === "Invoiced" && job.idx === 1 ? { type: "Manufacturer", name: "Inverter manufacturer warranty desk (sample)", ref: `RMA-DEMO-${2200 + job.no}` }
          : warranty && job.status === "Awaiting Office Review" ? { type: "Internal Warranty", name: null, ref: null }
            : { type: "Customer", name: null, ref: null };

    const est = buildEstimate({
      key: job.estKey, profile, scenario: job.scenario, status: estStatus, times: t, discount, deposit,
      approvalMethod: deposit ? "Deposit Paid" : ["Online", "Verbal", "Signed", "Online"][job.no % 4],
      versions: job.no % 9 === 0 && estStatus !== "Draft" ? 2 : 1,
      sentVia: ["Email", "Email", "SMS", "Both"][job.no % 4],
      jobKey: job.key, solarKey,
      adHoc: job.no % 7 === 3 ? AD_HOC_LINES[job.no % AD_HOC_LINES.length] : null,
      removedLine: job.no % 11 === 5,
      scope: `${job.scenario.issue} Proposed: ${job.scenario.lines.map(([c]) => itemByCode(c).name.toLowerCase()).join(", ")}.`,
      depositPaidAt: deposit && approvedEst ? addMinutes(t.approvedAt, 5) : null,
    }, jr);
    job.estimate = est;
    estimates.push(est);

    // Calls, in time order, then the tray call (if any).
    job.calls = [];
    [...job.slots, ...job.extraSlots].forEach((slot, i) => {
      const call = buildCall(job, slot, i + 1, jr.fork(`call${i + 1}`));
      call.bookedAt = job.bookedAt;
      job.calls.push(call);
      calls.push(call);
    });
    const worked = job.calls.filter((c) => c.kind === "complete");
    const lastOut = worked.length ? worked.map((c) => c.actualEnd).sort().pop() : null;

    // --- money: invoice + payments, settled the way settleMoney() does -----------------
    const paymentRows = [];
    const pay = (type, method, amount, at, extra = {}) => paymentRows.push({ type, method, amount: money(amount), at, ...extra });
    let invoice = null;
    const total2 = est.totals.total;
    const depositAmount = est.totals.depositAmount;
    if (deposit && approvedEst) pay("Deposit", "Card", depositAmount, addMinutes(t.approvedAt, 5), { note: "Deposit taken at approval." });
    if (["Invoiced", "Paid", "Closed"].includes(job.status)) {
      const workDone = lastOut ?? t.approvedAt;
      const issuedAt = between(addMinutes(workDone, 120), addMinutes(workDone, 60 * jr.int(16, 26)), hoursBefore(now, 12));
      const sentInvoice = !(job.status === "Invoiced" && job.idx === 0);
      invoice = { key: `invoice:${pad3(job.no)}`, issuedAt, sentAt: sentInvoice ? addMinutes(issuedAt, 12) : null, dueDate: addDays(phxDateOf(issuedAt), 14) };
      const payAt = between(addMinutes(issuedAt, 60), addMinutes(issuedAt, 60 * jr.int(5, 60)), hoursBefore(now, 2));
      if (job.status === "Invoiced" && job.idx === 3) pay("Payment", "Check", Math.round(total2 / 2), payAt, { reference: `Check ${1200 + job.no}`, note: "First half. Customer will send the balance at month end." });
      if (job.status === "Paid" || job.status === "Closed") {
        if (job.status === "Paid" && job.idx === 2) {
          // The customer paid the full invoice by check forgetting the deposit; the
          // overpayment was refunded. Net received = the invoice total.
          pay("Payment", "Check", total2, payAt, { reference: `Check ${1200 + job.no}` });
          pay("Refund", "Check", depositAmount, addMinutes(payAt, 20), { reference: `Refund check ${500 + job.no}`, note: "Deposit refunded - invoice was paid in full by check." });
        } else {
          const method = billTo.type === "Leasing Partner" ? "Partner Remittance" : ["Check", "ACH", "Card", "Check"][job.idx % 4];
          const already = paymentRows.reduce((s, p) => s + p.amount, 0);
          pay("Payment", method, total2 - already, payAt, { reference: method === "Check" ? `Check ${1200 + job.no}` : method === "Partner Remittance" ? `Remit ${billTo.ref}` : undefined });
        }
      }
    }
    const asRecords = paymentRows.map((p) => ({ Type__c: p.type, Amount__c: p.amount, Status__c: "Succeeded" }));
    const summary = paidSummary(asRecords);
    let paymentStatus;
    let closedAt = null;
    if (invoice) {
      invoice.status = invoiceStatusFor(invoice.sentAt ? "Sent" : "Issued", total2, summary.paid);
      invoice.paid = summary.paid;
      invoice.paidAt = invoice.status === "Paid" ? paymentRows.filter((p) => p.type !== "Refund").map((p) => p.at).sort().pop() : null;
      paymentStatus = jobPaymentStatusFor(summary, total2, true);
      if (job.status === "Closed") closedAt = between(addMinutes(invoice.paidAt ?? invoice.issuedAt, 30), addMinutes(invoice.paidAt ?? invoice.issuedAt, 120), hoursBefore(now, 0.5));
    } else {
      paymentStatus = jobPaymentStatusFor(summary, 0, false);
    }
    job.invoice = invoice;
    job.payments = paymentRows;
    job.paymentStatus = paymentStatus;

    // --- the office's own steps (the statuses no automation sets) ---------------------------
    const officeSteps = [];
    if (job.status === "Triaging") officeSteps.push({ at: addMinutes(t.intakeAt, 60), to: "Triaging" });
    if (job.status === "Remote Investigation") officeSteps.push({ at: addMinutes(t.intakeAt, 180), to: "Remote Investigation" });
    if (job.status === "Ready to Schedule" && !job.slots.length) officeSteps.push({ at: clampIso(addMinutes(approvedEst ? t.approvedAt : t.viewedAt, 10), now), to: "Ready to Schedule" });
    if (job.status === "Awaiting Parts") officeSteps.push({ at: addMinutes(lastOut, 60), to: "Awaiting Parts" });
    if (job.status === "Ready to Bill") officeSteps.push({ at: clampIso(addMinutes(lastOut, 60 * jr.int(2, 20)), now), to: "Ready to Bill" });
    if (invoice) officeSteps.push({ at: invoice.issuedAt, to: "Invoiced" }); // issueInvoice()
    if (invoice?.status === "Paid" && job.status !== "Invoiced") officeSteps.push({ at: invoice.paidAt, to: "Paid" }); // settleMoney()
    if (closedAt) officeSteps.push({ at: closedAt, to: "Closed" });
    job.officeSteps = officeSteps;
    const lastOffice = officeSteps.length ? officeSteps[officeSteps.length - 1].at : null;
    const firstArrive = job.calls.filter((c) => c.arrivedAt).map((c) => c.arrivedAt).sort()[0] ?? null;
    job.statusChangedAt =
      lastOffice && ["Triaging", "Remote Investigation", "Awaiting Parts", "Ready to Bill", "Invoiced", "Paid", "Closed"].includes(job.status) ? lastOffice
        : job.status === "Ready to Schedule" ? (job.calls.find((c) => c.kind === "cancelled")?.cancelledAt ?? lastOffice ?? t.intakeAt)
          : job.status === "Scheduled" ? job.bookedAt
            : job.status === "In Progress" ? firstArrive
              : job.status === "Awaiting Office Review" ? job.calls.filter((c) => c.actualEnd).map((c) => c.actualEnd).sort().pop()
                : t.intakeAt;

    // --- the job record ----------------------------------------------------------------------
    const counted = job.calls.filter((c) => !["cancelled", "unscheduled"].includes(c.kind));
    const ownership = leased ? "Leased" : profile.kind === "service" && job.no % 6 === 0 ? "Third-Party Owned" : "Customer Owned";
    const channel = billTo.type === "Leasing Partner" ? "Leasing Company"
      : job.scenario.id === "monitoring" ? "Monitoring Alert" : ["Phone", "Phone", "Email", "Web Form", "Phone"][job.no % 5];
    job.fields = compact({
      Client__c: ref("tenant"),
      Sundial_Customer__c: ref(profile.key),
      Estimate__c: ref(job.estKey),
      Status__c: job.status,
      Status_Changed_At__c: job.statusChangedAt,
      Resolution__c: job.status === "Closed" ? liveOr("Resolution__c", "Completed", undefined) : undefined,
      Priority__c: liveOr("Priority__c", job.scenario.priority, "Standard"),
      Service_Type__c: liveOr("Service_Type__c", billTo.type === "Leasing Partner" ? "Partner Work Order" : job.scenario.serviceType, undefined),
      System_Ownership__c: liveOr("System_Ownership__c", ownership, undefined),
      Intake_Channel__c: liveOr("Intake_Channel__c", channel, undefined),
      Intake_Date__c: t.intakeAt,
      Needs_Intake_Review__c: job.status === "New" && channel === "Web Form",
      Assigned_To__c: ref(DISPATCHER_KEY),
      Issue_Description__c: job.scenario.issue,
      Initial_Remote_Diagnosis__c: ["New", "Triaging"].includes(job.status) ? undefined : job.scenario.diagnosis,
      Office_Notes__c: "DEMO DATA - fictional job.",
      Customer_Summary__c: ["Ready to Bill", "Invoiced", "Paid", "Closed"].includes(job.status) ? job.scenario.summary : undefined,
      Originating_Solar_Project__c: solarKey ? ref(solarKey) : undefined,
      Bill_To_Type__c: billTo.type,
      Bill_To_Name__c: billTo.name ?? undefined,
      Billing_Reference__c: billTo.ref ?? undefined,
      Payment_Status__c: paymentStatus,
      Customer_Name_at_Creation__c: profile.person.name,
      Address_at_Creation__c: [profile.place.street, profile.place.city, profile.place.state, profile.place.zip].join(", "),
      Primary_Phone_at_Creation__c: profile.phone,
      Primary_Email_at_Creation__c: profile.email,
      // Pins for the dispatch map. "Manual" = a person placed the pin, so no Lambda re-geocodes a made-up address.
      Geocode_Lat__c: profile.place.lat,
      Geocode_Lon__c: profile.place.lng,
      Geocode_Status__c: liveOr("Geocode_Status__c", "Manual", undefined),
      // "NONE" tells the job page not to ask Google for a Street View of a fictional address.
      Street_View_Image_Key__c: "NONE",
      Total_Call_Count__c: counted.length || undefined,
      Total_Time_Minutes__c: counted.reduce((s, c) => s + (c.minutes || 0), 0) || undefined,
      First_Scheduled_Start__c: counted.length ? counted.map((c) => c.start).sort()[0] : undefined,
    });
    job.billTo = billTo;
  }

  // --- the six estimates that never became a job ------------------------------------------
  const joblessStatuses = ["Draft", "Draft", "Sent", "Sent", "Declined", "Expired"].filter((s) => schema.isLive(OBJ.estimate, "Status__c", s));
  joblessStatuses.forEach((status, i) => {
    const no = jobs.length + 1 + i;
    const profile = owners[no - 1];
    const jr = r.fork(`jobless${i}`);
    const scenario = scenarioFor(profile, no);
    const ageDays = { Draft: 1 + i, Sent: 3 + i, Declined: 12, Expired: 48 }[status];
    const created = phxAt(onWeekday(addDays(anchorDate, -ageDays)), 9 * 60 + jr.int(0, 30) * 10);
    const t = { intakeAt: created, createdAt: created, sentAt: clampIso(addMinutes(created, 90), now), viewedAt: clampIso(addMinutes(created, 60 * 26), now) };
    const est = buildEstimate({
      key: `estimate:${pad3(no)}`, profile, scenario, status, times: t,
      discount: status === "Sent" && i === 2 ? { scope: "Both", type: "Percent", value: 10 } : null,
      deposit: null, versions: 1, sentVia: "Email", jobKey: null, solarKey: profile.solar ? profile.solar.key : null,
      scope: `${scenario.issue} Proposed: ${scenario.lines.map(([c]) => itemByCode(c).name.toLowerCase()).join(", ")}.`,
      validUntil: status === "Expired" ? addDays(phxDateOf(t.sentAt), 30) : undefined,
    }, jr);
    estimates.push(est);
  });

  // --- operations, in the order they must be written ----------------------------------------
  // estimate -> its lines -> the job (needs the estimate) -> estimate back-pointer -> calls
  // -> job notes roll-up (needs the call numbers) -> invoice (named after the job number) -> payments
  for (const est of estimates) {
    const job = est.jobKey ? jobs.find((j) => j.key === est.jobKey) : null;
    ops.push({ op: "create", key: est.key, object: OBJ.estimate, phase: "service", fields: est.fields });
    for (const l of est.lines) ops.push({ op: "create", key: l.key, object: OBJ.line, phase: "service", fields: l.fields });
    if (!job) continue;
    ops.push({ op: "create", key: job.key, object: OBJ.job, phase: "service", fields: job.fields });
    ops.push({ op: "update", key: `${est.key}#job`, target: est.key, object: OBJ.estimate, phase: "service", fields: { Service_Job__c: ref(job.key) } });
    for (const c of job.calls) ops.push({ op: "create", key: c.key, object: OBJ.call, phase: "service", fields: compact(c.fields) });
    const done = job.calls.filter((c) => c.kind === "complete");
    if (done.length) {
      const noteCalls = done.map((c) => ({ key: c.key, techName: persona(c.techKey).name, at: c.actualEnd, work: c.fields.Work_Notes__c ?? null, priv: c.fields.Private_Notes__c ?? null }));
      const fields = { Notes_for_Summary__c: { $jobNotes: { kind: "work", calls: noteCalls } } };
      if (noteCalls.some((c) => c.priv)) fields.Notes_From_Service_Calls__c = { $jobNotes: { kind: "private", calls: noteCalls } };
      ops.push({ op: "update", key: `${job.key}#notes`, target: job.key, object: OBJ.job, phase: "service", fields });
    }
    if (job.invoice) {
      const inv = job.invoice;
      ops.push({
        op: "create", key: inv.key, object: OBJ.invoice, phase: "service",
        fields: compact({
          // "SVC-00012" — the job's own number, as nextInvoiceName() gives the first invoice.
          Name: nameOf(job.key),
          Service_Job__c: ref(job.key),
          Client__c: ref("tenant"),
          Status__c: inv.status,
          Bill_To_Type__c: job.billTo.type,
          Bill_To_Name__c: job.billTo.name ?? undefined,
          Billing_Reference__c: job.billTo.ref ?? undefined,
          Subtotal__c: est.totals.subtotal,
          Discount_Amount__c: est.totals.discountAmount,
          Tax_Rate__c: est.fields.Tax_Rate__c,
          Tax_Amount__c: est.totals.taxAmount,
          Total__c: est.totals.total,
          Paid_Amount__c: inv.paid,
          Issued_At__c: inv.issuedAt,
          Sent_At__c: inv.sentAt ?? undefined,
          Due_Date__c: inv.dueDate,
          Paid_At__c: inv.paidAt ?? undefined,
        }),
      });
    }
    job.payments.forEach((p, i) => {
      p.key = `payment:${pad3(job.no)}-${i + 1}`;
      ops.push({
        op: "create", key: p.key, object: OBJ.payment, phase: "service",
        fields: compact({
          Service_Job__c: ref(job.key),
          // A deposit taken before the invoice existed is adopted by the invoice when it is issued.
          Invoice__c: job.invoice ? ref(job.invoice.key) : undefined,
          Client__c: ref("tenant"),
          Type__c: p.type,
          Method__c: p.method,
          Amount__c: p.amount,
          Status__c: "Succeeded",
          Received_At__c: p.at,
          Reference__c: p.reference ?? undefined,
          Recorded_By__c: ref(DISPATCHER_KEY),
          Notes__c: p.note ?? undefined,
        }),
      });
    });
  }

  // --- the technicians' days ---------------------------------------------------------------------
  const techDays = planTechDays(calls, { rng: rng.fork("days"), anchorDate });
  for (const d of techDays) ops.push({ op: "create", key: d.key, object: OBJ.day, phase: "service", fields: d.fields });

  void pick;
  return { ops, jobs, estimates, calls, techDays, slots, demoNow: now, nowMin, liveDemoKeys };
}

/**
 * One Sundial_Tech_Day__c per tech per day they were on the clock, in the shape day.js
 * writes: an append-only Day_Log__c and the fields derived from it by dayFields().
 * Exported because --freshen builds the same rows for the days it adds.
 */
export function planTechDays(calls, { rng, anchorDate, keyPrefix = "day" }) {
  const byDay = new Map();
  for (const c of calls) {
    if (!c.techKey || !c.intervals?.length) continue;
    const id = `${c.techKey}|${c.date}`;
    if (!byDay.has(id)) byDay.set(id, []);
    byDay.get(id).push(c);
  }
  const out = [];
  for (const [id, dayCalls] of [...byDay.entries()].sort()) {
    const [techKey, date] = id.split("|");
    const r = rng.fork(id);
    const tech = persona(techKey);
    const spans = dayCalls.flatMap((c) => intervalSpans(c.intervals, null));
    const firstCall = dayCalls.slice().sort((a, b) => a.intervals[0].in.localeCompare(b.intervals[0].in))[0];
    const firstIn = firstCall.intervals[0].in;
    const today = date === anchorDate;
    const viaCall = !today && r.chance(0.18);
    const evt = `demo-${keyPrefix}-${tech.slug}-${date}`;
    const log = [];
    let extra;
    if (viaCall) {
      // The tech never tapped "Start my day": the first clock tap on a call opened it (day.js autoStart).
      log.push({ kind: "start", at: firstIn, gps: firstCall.intervals[0].in_gps ?? null, via: "call", callId: ref(firstCall.key) });
      extra = { Start_Kind__c: "Call", Start_Call__c: ref(firstCall.key) };
    } else {
      log.push({ kind: "start", at: addMinutes(firstIn, -r.int(12, 28)), gps: { lat: SHOP.lat, lng: SHOP.lng }, eventId: `${evt}-start`, via: "tech" });
      extra = { Start_Kind__c: "Warehouse" };
    }
    let outside;
    if (!today) {
      const lastOut = Math.max(...spans.map(([, b]) => b));
      const endAt = new Date(lastOut + r.int(15, 40) * 60000).toISOString();
      log.push({ kind: "end", at: endAt, gps: { lat: SHOP.lat, lng: SHOP.lng }, eventId: `${evt}-end`, via: "tech" });
      if (r.chance(0.35)) log.push({ kind: "note", at: endAt, note: r.pick(["Parts run to the supply house between calls.", "Restocked the truck at the end of the day.", "Thirty minutes at the shop sorting returns."]), eventId: `${evt}-end:note`, via: "tech" });
      // Time Outside Calls, as day.js stores it on close: the day's span minus the call time inside it.
      const a = Date.parse(log[0].at);
      const z = Date.parse(endAt);
      outside = Math.round(Math.max(0, z - a - unionMs(clipSpans(spans, a, z))) / 60000);
    }
    // dayFields() stringifies the log itself; the log may hold an id marker, so the text
    // is produced by the writer instead and the rest of the derived fields are kept.
    const derived = dayFields(log.map((e) => ({ ...e, callId: undefined })));
    delete derived.Day_Log__c;
    const fields = compact({
      Client__c: ref("tenant"),
      Tech__c: ref(techKey),
      Work_Date__c: date,
      Day_Key__c: concat(ref(techKey), ":", date),
      ...derived,
      ...extra,
      Day_Log__c: json(log),
      Outside_Minutes__c: outside,
    });
    out.push({ key: `${keyPrefix}:${tech.slug}:${date}`, techKey, date, log, open: today, fields });
  }
  return out;
}
