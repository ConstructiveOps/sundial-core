// day.js — the technician's DAY clock, the techs' last-known locations, and the weekly
// payroll report (D-076, 2026-09-28). Mounted by index.js next to tech.js.
//
//   POST /service/tech/day/start   { at?, gps?, eventId?, kind?: "Warehouse"|"Other" }   clock in for the day
//   POST /service/tech/day/end     { at?, gps?, eventId?, note? }                         clock out for the day
//   POST /service/tech/day/note    { note, date?, eventId? }                              the end-of-day note
//   GET  /service/techs/locations                                   (office) every tech's last clocked spot
//   GET  /service/payroll?week=YYYY-MM-DD[&techId=]                 (Admin) hours by job + outside calls
//
// THE DAY (Sundial_Tech_Day__c, one row per tech per calendar day, Day_Key__c = "{tech}:{date}"):
//   - "Start my day" on the phone opens it (Start_Kind__c Warehouse / Other), OR the first
//     clock-in on a service call opens it for the tech (Start_Kind__c = Call, Start_Call__c) —
//     Tim, 2026-09-28: clocking in on a call is the start of the day, nobody should have to
//     remember two taps.
//   - "Clock out for the day" closes it and is REFUSED while any of the tech's calls is still
//     on the clock (409 DAY_CALL_OPEN) — a day can't end with an open call, and the office
//     would otherwise get a call that runs all night.
//   - Every tap carries its own time and eventId (the offline queue replays in order); the
//     day's log (Day_Log__c) is append-only and a replayed id is a no-op, like the call clock.
//   - The note is the tech's word on what the hours outside calls were: parts run, shop time,
//     a training. Latest note wins on the row; the log keeps every version.
//
// PAYROLL (Mon–Sun, decimal hours, the minutes underneath): computed LIVE from the calls'
// Clock_Intervals__c and the day rows — there is no nightly job to be wrong. For each tech:
//   hours by job     = the sum of their live call intervals in the week, per job (the
//                      interval's minutes belong to the local day it started on)
//   Time Outside Calls, per day = the day's span (Day_Start → Day_End) minus the union of the
//                      call intervals that fall inside it. A day still open on a past date is
//                      reported with "no clock-out" and its span ends at the last call clock-out
//                      of that day, so a forgotten tap costs nothing and hides nothing.
//   A day with call time but no day row is flagged "no day clock" — the office knows the
//   tech never started the day and only the call hours count.
//
// TENANT ISOLATION: every read is Client__c-bound. A tech reaches only their own day
// (the office may act as one with ?techId= / body.techId, as on the call routes).

import { soqlEscapeString } from "../../lib/salesforce.js";
import { dayBounds, gpsFrom, liveIntervals, localDate, openIntervalIndex, parseIntervals, resolveEventAt } from "./tech.js";

export const DAY_SF_OBJECT = "Sundial_Tech_Day__c";
export const DAY_SELECT =
  "Id, Name, Client__c, Tech__c, Work_Date__c, Day_Key__c, Day_Start__c, Day_End__c, Status__c, Start_Kind__c, Start_Call__c, " +
  "Start_Latitude__c, Start_Longitude__c, End_Latitude__c, End_Longitude__c, Day_Log__c, House_Notes__c, Outside_Minutes__c, SystemModstamp, " +
  "Tech__r.First_Name__c, Tech__r.Last_Name__c";
export const START_KINDS = Object.freeze(["Warehouse", "Call", "Other"]);
const MAX_NOTE_CHARS = 4000;
const LOCATION_LOOKBACK_DAYS = 14;
const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;
const strOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export const dayKey = (techId, date) => `${techId}:${date}`;

export function parseDayLog(json) {
  if (!json) return [];
  let v = json;
  if (typeof json === "string") {
    try {
      v = JSON.parse(json);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v.filter((e) => e && typeof e === "object" && typeof e.kind === "string" && typeof e.at === "string");
}
export const hasDayEvent = (log, eventId) => !!eventId && log.some((e) => e.eventId === eventId);

/** What the log says: the first start, the last end after it, the latest note. */
export function dayFromLog(log) {
  let start = null;
  let end = null;
  let note = null;
  for (const e of log) {
    if (e.kind === "start" && !start) start = e;
    else if (e.kind === "end") end = e; // the last end wins; a re-start after an end reopens (below)
    else if (e.kind === "note") note = e;
    if (e.kind === "start" && start && end && e.at > end.at) end = null; // reopened
  }
  return { start, end, note };
}

/** Salesforce fields that follow from a log. */
export function dayFields(log) {
  const { start, end, note } = dayFromLog(log);
  const f = {
    Day_Log__c: JSON.stringify(log),
    Day_Start__c: start?.at ?? null,
    Day_End__c: end?.at ?? null,
    Status__c: start && !end ? "Open" : "Closed",
    House_Notes__c: note ? note.note ?? null : null,
  };
  if (start?.gps) {
    f.Start_Latitude__c = start.gps.lat;
    f.Start_Longitude__c = start.gps.lng;
  }
  if (end?.gps) {
    f.End_Latitude__c = end.gps.lat;
    f.End_Longitude__c = end.gps.lng;
  } else {
    f.End_Latitude__c = null;
    f.End_Longitude__c = null;
  }
  return f;
}

/** The day as the app shows it. `now` (ISO) lets an open day count up. */
export function dayView(row, now = null) {
  if (!row) return { state: "none", id: null, date: null, start: null, end: null, startKind: null, startCallId: null, note: null, minutes: 0 };
  const start = row.Day_Start__c ?? null;
  const end = row.Day_End__c ?? null;
  const until = end ?? now;
  const minutes = start && until && Date.parse(until) > Date.parse(start) ? Math.round((Date.parse(until) - Date.parse(start)) / 60000) : 0;
  return {
    state: !start ? "none" : end ? "closed" : "open",
    id: row.Id,
    date: row.Work_Date__c ?? null,
    start,
    end,
    startKind: row.Start_Kind__c ?? null,
    startCallId: row.Start_Call__c ?? null,
    note: row.House_Notes__c ?? null,
    minutes,
  };
}

// --- weeks ----------------------------------------------------------------------------
/** The Monday of the week holding YYYY-MM-DD (pure calendar math, no timezone involved). */
export function weekMonday(dateStr) {
  const m = String(dateStr ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const probe = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(probe.getTime()) || probe.getUTCMonth() !== +m[2] - 1 || probe.getUTCDate() !== +m[3]) return null;
  const dow = (probe.getUTCDay() + 6) % 7; // Monday = 0
  probe.setUTCDate(probe.getUTCDate() - dow);
  return probe.toISOString().slice(0, 10);
}
/** YYYY-MM-DD + n days. */
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** The seven dates and the UTC window of a Mon–Sun week in a timezone. */
export function weekBounds(mondayStr, timeZone) {
  const dates = Array.from({ length: 7 }, (_, i) => addDays(mondayStr, i));
  const first = dayBounds(dates[0], timeZone);
  const last = dayBounds(dates[6], timeZone);
  if (!first || !last) return null;
  return { monday: dates[0], sunday: dates[6], dates, from: first.from, to: last.to };
}

// --- time math ------------------------------------------------------------------------
/** Live intervals as [fromMs, toMs] pairs; an open one runs to `now` (ms) when given, else is skipped. */
export function intervalSpans(intervals, nowMs = null) {
  const out = [];
  for (const i of liveIntervals(intervals)) {
    const a = Date.parse(i.in);
    const b = i.out ? Date.parse(i.out) : nowMs;
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) out.push([a, b]);
  }
  return out;
}
/** Clip spans to [from, to) ms. */
export function clipSpans(spans, from, to) {
  const out = [];
  for (const [a, b] of spans) {
    const x = Math.max(a, from);
    const y = Math.min(b, to);
    if (y > x) out.push([x, y]);
  }
  return out;
}
/** Milliseconds covered by the union of spans (overlaps counted once). */
export function unionMs(spans) {
  const sorted = [...spans].sort((p, q) => p[0] - q[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of sorted) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else if (b > cur[1]) cur[1] = b;
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}
const toMinutes = (ms) => Math.round(ms / 60000);
export const hoursOf = (minutes) => Math.round((minutes / 60) * 100) / 100;

/**
 * The report. `techs` = [{ id, name }], `days` = Sundial_Tech_Day__c rows, `calls` = service
 * call rows (Tech__c, Clock_Intervals__c, the job's name / customer). `week` from weekBounds.
 */
export function buildPayroll({ techs, days, calls, week, timeZone, now }) {
  const nowMs = Date.parse(now);
  const today = localDate(new Date(nowMs), timeZone);
  const weekFrom = Date.parse(week.from);
  const weekTo = Date.parse(week.to);

  const daysByTech = new Map();
  for (const r of days) {
    if (!daysByTech.has(r.Tech__c)) daysByTech.set(r.Tech__c, new Map());
    daysByTech.get(r.Tech__c).set(r.Work_Date__c, r);
  }
  const callsByTech = new Map();
  for (const c of calls) {
    if (!c.Tech__c) continue;
    if (!callsByTech.has(c.Tech__c)) callsByTech.set(c.Tech__c, []);
    callsByTech.get(c.Tech__c).push(c);
  }

  const rows = [];
  for (const tech of techs) {
    const techDays = daysByTech.get(tech.id) ?? new Map();
    const techCalls = callsByTech.get(tech.id) ?? [];
    const jobs = new Map(); // jobId → { …, ms, calls: Set }
    const callMsByDate = new Map(); // date → ms (job time on that date)
    const spansByDate = new Map(); // date → [[a,b]] (for the outside-calls subtraction)
    for (const c of techCalls) {
      const intervals = parseIntervals(c.Clock_Intervals__c);
      const spans = clipSpans(intervalSpans(intervals, nowMs), weekFrom, weekTo);
      for (const [a, b] of spans) {
        const date = localDate(new Date(a), timeZone);
        const ms = b - a;
        callMsByDate.set(date, (callMsByDate.get(date) ?? 0) + ms);
        if (!spansByDate.has(date)) spansByDate.set(date, []);
        spansByDate.get(date).push([a, b]);
        const jobId = c.Sundial_Service_Job__c ?? "__none";
        if (!jobs.has(jobId)) {
          const j = c.Sundial_Service_Job__r ?? {};
          jobs.set(jobId, { jobId: c.Sundial_Service_Job__c ?? null, jobNumber: j.Name ?? null, customer: j.Customer_Name_at_Creation__c ?? null, address: j.Address_at_Creation__c ?? null, ms: 0, calls: new Set() });
        }
        const jr = jobs.get(jobId);
        jr.ms += ms;
        jr.calls.add(c.Id);
      }
    }

    const dayRows = [];
    let outsideMs = 0;
    let callMs = 0;
    for (const date of week.dates) {
      const row = techDays.get(date) ?? null;
      const dayCallMs = callMsByDate.get(date) ?? 0;
      callMs += dayCallMs;
      const spans = spansByDate.get(date) ?? [];
      let start = row?.Day_Start__c ?? null;
      let end = row?.Day_End__c ?? null;
      let flag = null;
      if (!row && dayCallMs > 0) flag = "no_day_clock";
      if (row && start && !end) {
        if (date === today) end = null; // still working; the outside time counts up to now
        else {
          // A forgotten clock-out on a past day: the day ends at the last call clock-out that day.
          const lastOut = spans.reduce((m, [, b]) => Math.max(m, b), 0);
          end = lastOut ? new Date(lastOut).toISOString() : start;
          flag = "no_clock_out";
        }
      }
      let dayOutsideMs = 0;
      let spanMs = 0;
      if (start) {
        const a = Date.parse(start);
        const b = end ? Date.parse(end) : nowMs;
        if (b > a) {
          spanMs = b - a;
          dayOutsideMs = Math.max(0, spanMs - unionMs(clipSpans(spans, a, b)));
        }
      }
      outsideMs += dayOutsideMs;
      if (row || dayCallMs > 0) {
        dayRows.push({
          date,
          start,
          end: row?.Day_End__c ?? (flag === "no_clock_out" ? end : null),
          open: !!row && !!start && !row.Day_End__c,
          startKind: row?.Start_Kind__c ?? null,
          note: row?.House_Notes__c ?? null,
          flag,
          callMinutes: toMinutes(dayCallMs),
          outsideMinutes: toMinutes(dayOutsideMs),
          spanMinutes: toMinutes(spanMs),
        });
      }
    }
    const jobRows = [...jobs.values()]
      .map((j) => ({ jobId: j.jobId, jobNumber: j.jobNumber, customer: j.customer, address: j.address, minutes: toMinutes(j.ms), hours: hoursOf(toMinutes(j.ms)), calls: j.calls.size }))
      .sort((a, b) => b.minutes - a.minutes);
    const callMinutes = toMinutes(callMs);
    const outsideMinutes = toMinutes(outsideMs);
    rows.push({
      tech: { id: tech.id, name: tech.name },
      jobs: jobRows,
      days: dayRows,
      totals: { callMinutes, outsideMinutes, totalMinutes: callMinutes + outsideMinutes, callHours: hoursOf(callMinutes), outsideHours: hoursOf(outsideMinutes), totalHours: hoursOf(callMinutes + outsideMinutes) },
      notes: dayRows.filter((r) => r.note).map((r) => ({ date: r.date, note: r.note })),
    });
  }
  const grand = rows.reduce((t, r) => ({ callMinutes: t.callMinutes + r.totals.callMinutes, outsideMinutes: t.outsideMinutes + r.totals.outsideMinutes }), { callMinutes: 0, outsideMinutes: 0 });
  return {
    week: { monday: week.monday, sunday: week.sunday, dates: week.dates, from: week.from, to: week.to },
    timeZone,
    techs: rows,
    totals: { ...grand, totalMinutes: grand.callMinutes + grand.outsideMinutes, callHours: hoursOf(grand.callMinutes), outsideHours: hoursOf(grand.outsideMinutes), totalHours: hoursOf(grand.callMinutes + grand.outsideMinutes) },
    generatedAt: now,
  };
}

/**
 * Each tech's last clocked spot, from the calls' GPS-bearing clock events and the day rows.
 * Returns [{ techId, at, gps, kind, callId, jobId, jobNumber, customer }] — one per tech, the newest.
 */
export function lastLocations({ techs, calls, days }) {
  const best = new Map();
  const consider = (techId, cand) => {
    if (!techId || !cand?.gps || !cand.at) return;
    const cur = best.get(techId);
    if (!cur || cand.at > cur.at) best.set(techId, cand);
  };
  for (const c of calls) {
    const job = c.Sundial_Service_Job__r ?? {};
    const base = { callId: c.Id, callNumber: c.Name ?? null, jobId: c.Sundial_Service_Job__c ?? null, jobNumber: job.Name ?? null, customer: job.Customer_Name_at_Creation__c ?? null, address: job.Address_at_Creation__c ?? null };
    for (const i of liveIntervals(parseIntervals(c.Clock_Intervals__c))) {
      if (i.in_gps) consider(c.Tech__c, { ...base, at: i.in, gps: gpsFrom(i.in_gps), kind: i.kind === "en_route" ? "en_route" : "clock_in" });
      if (i.arrived && i.arrived_gps) consider(c.Tech__c, { ...base, at: i.arrived, gps: gpsFrom(i.arrived_gps), kind: "clock_in" });
      if (i.out && i.out_gps) consider(c.Tech__c, { ...base, at: i.out, gps: gpsFrom(i.out_gps), kind: "clock_out" });
    }
  }
  for (const r of days) {
    const g1 = gpsFrom({ lat: r.Start_Latitude__c, lng: r.Start_Longitude__c });
    if (r.Day_Start__c && g1) consider(r.Tech__c, { at: r.Day_Start__c, gps: g1, kind: "day_start", callId: r.Start_Call__c ?? null });
    const g2 = gpsFrom({ lat: r.End_Latitude__c, lng: r.End_Longitude__c });
    if (r.Day_End__c && g2) consider(r.Tech__c, { at: r.Day_End__c, gps: g2, kind: "day_end" });
  }
  return techs.map((t) => ({ techId: t.id, ...(best.get(t.id) ?? { at: null, gps: null, kind: null }) }));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
export function createDayHandlers(d, h) {
  const { CALL_SF_OBJECT, CALL_SELECT, DEFAULTS, jsonResponse, bad, sfError } = h;
  const tz = () => DEFAULTS.timeZone;

  async function loadDay(techId, date, tenantId) {
    const rows = await d.sfQuery(`SELECT ${DAY_SELECT} FROM ${DAY_SF_OBJECT} WHERE Day_Key__c = '${soqlEscapeString(dayKey(techId, date))}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
    return rows?.[0] ?? null;
  }
  async function loadDays(tenantId, where, order = "Work_Date__c") {
    return (await d.sfQuery(`SELECT ${DAY_SELECT} FROM ${DAY_SF_OBJECT} WHERE Client__c = '${soqlEscapeString(tenantId)}' AND ${where} ORDER BY ${order} LIMIT 2000`)) || [];
  }
  async function loadCalls(tenantId, where) {
    return (await d.sfQuery(`SELECT ${CALL_SELECT} FROM ${CALL_SF_OBJECT} WHERE Client__c = '${soqlEscapeString(tenantId)}' AND ${where} ORDER BY Scheduled_Start__c LIMIT 2000`)) || [];
  }
  /** The tech this request acts as: the caller, or (office only) body.techId / ?techId=. */
  async function actingTech(ctx, techId) {
    const wanted = ctx.scope === "tenant" && strOrNull(techId) ? strOrNull(techId) : ctx.userId;
    if (!wanted) return null;
    return h.loadTech(wanted, ctx.tenantId);
  }
  /** Any of the tech's calls with an open clock interval. */
  async function openCall(tenantId, techId) {
    const calls = await loadCalls(tenantId, `Tech__c = '${soqlEscapeString(techId)}' AND Status__c IN ('En Route', 'In Progress')`);
    return calls.find((c) => openIntervalIndex(parseIntervals(c.Clock_Intervals__c)) >= 0) ?? null;
  }
  /** Create or update the row for (tech, date) from a log. Returns the row after. */
  async function saveDay(ctx, tech, date, existing, log, extra = {}) {
    const fields = { ...dayFields(log), ...extra };
    if (existing) {
      await d.sfUpdateRecord(DAY_SF_OBJECT, existing.Id, fields);
      return { ...existing, ...fields };
    }
    const created = await d.sfCreateRecord(DAY_SF_OBJECT, { Client__c: ctx.tenantId, Tech__c: tech.Id, Work_Date__c: date, Day_Key__c: dayKey(tech.Id, date), ...fields });
    return { Id: created?.id ?? created?.Id ?? null, Client__c: ctx.tenantId, Tech__c: tech.Id, Work_Date__c: date, Day_Key__c: dayKey(tech.Id, date), ...fields };
  }
  /** Minutes inside the day's span no call accounts for — stored on close for Salesforce reports. */
  async function outsideMinutesFor(tenantId, tech, date, start, end) {
    const b = dayBounds(date, tz());
    const next = dayBounds(addDays(date, 1), tz()); // a call that ran past midnight still belongs to this day's span
    if (!b || !next || !start || !end) return null;
    const calls = await loadCalls(tenantId, `Tech__c = '${soqlEscapeString(tech.Id)}' AND Actual_Start__c >= ${h.soqlDateTime(b.from)} AND Actual_Start__c < ${h.soqlDateTime(next.to)}`);
    const a = Date.parse(start);
    const z = Date.parse(end);
    if (!(z > a)) return 0;
    const spans = calls.flatMap((c) => clipSpans(intervalSpans(parseIntervals(c.Clock_Intervals__c), null), a, z));
    return toMinutes(Math.max(0, z - a - unionMs(spans)));
  }

  const ops = {
    loadDay,
    view: dayView,
    /**
     * A call clock-in starts the tech's day when nothing has (D-076). Best-effort: a failure
     * here never fails the call's clock — it is logged, and the tech can still tap "Start my day".
     */
    async autoStart({ ctx, tech, call, at, gps }) {
      const date = localDate(new Date(at), tz());
      try {
        const existing = await loadDay(tech.Id, date, ctx.tenantId);
        if (existing && existing.Day_Start__c) return dayView(existing, at);
        const log = [...parseDayLog(existing?.Day_Log__c), { kind: "start", at, gps: gps ?? null, via: "call", callId: call.Id }];
        const row = await saveDay(ctx, tech, date, existing, log, { Start_Kind__c: "Call", Start_Call__c: call.Id });
        return dayView(row, at);
      } catch (e) {
        console.error("day auto-start:", e?.sfBody || e?.message || e);
        return null;
      }
    },
  };

  const handlers = {
    async techDayStart({ ctx, body }) {
      const { tenantId, cors } = ctx;
      const tech = await actingTech(ctx, body?.techId);
      if (!tech) return jsonResponse(403, cors, { error: "no_user", code: "NO_TECH_USER", message: "Your login is not linked to an active Sundial user." });
      const now = d.now();
      const r = resolveEventAt(body?.at, now, null);
      if (r.error) return bad(cors, r.error[0], r.error[1]);
      const at = r.at;
      const date = localDate(new Date(at), tz());
      const gps = gpsFrom(body?.gps);
      const eventId = strOrNull(body?.eventId);
      const kind = START_KINDS.includes(body?.kind) && body.kind !== "Call" ? body.kind : "Warehouse";
      const existing = await loadDay(tech.Id, date, tenantId);
      const log = parseDayLog(existing?.Day_Log__c);
      if (hasDayEvent(log, eventId)) return jsonResponse(200, cors, { success: true, duplicate: true, day: dayView(existing, now.toISOString()) });
      if (existing?.Day_Start__c && !existing.Day_End__c) return jsonResponse(200, cors, { success: true, alreadyStarted: true, day: dayView(existing, now.toISOString()) });
      const reopen = !!existing?.Day_End__c;
      log.push({ kind: "start", at, gps, eventId, via: "tech" });
      let row;
      try {
        row = await saveDay(ctx, tech, date, existing, log, reopen ? {} : { Start_Kind__c: kind });
      } catch (e) {
        return sfError(cors, e, "day start");
      }
      return jsonResponse(200, cors, { success: true, reopened: reopen, day: dayView(row, now.toISOString()) });
    },

    async techDayEnd({ ctx, body }) {
      const { tenantId, cors } = ctx;
      const tech = await actingTech(ctx, body?.techId);
      if (!tech) return jsonResponse(403, cors, { error: "no_user", code: "NO_TECH_USER", message: "Your login is not linked to an active Sundial user." });
      const now = d.now();
      const r = resolveEventAt(body?.at, now, null);
      if (r.error) return bad(cors, r.error[0], r.error[1]);
      const at = r.at;
      const gps = gpsFrom(body?.gps);
      const eventId = strOrNull(body?.eventId);
      // The day being ended is the one that is open — today's, or yesterday's when the tap
      // comes after midnight (a late job); never a day that was never started.
      const date = strOrNull(body?.date) ?? localDate(new Date(at), tz());
      let existing = await loadDay(tech.Id, date, tenantId);
      if (!existing?.Day_Start__c && !strOrNull(body?.date)) {
        const open = await loadDays(tenantId, `Tech__c = '${soqlEscapeString(tech.Id)}' AND Status__c = 'Open' AND Day_Start__c != null`, "Work_Date__c DESC");
        existing = open[0] ?? null;
      }
      const log = parseDayLog(existing?.Day_Log__c);
      if (hasDayEvent(log, eventId)) return jsonResponse(200, cors, { success: true, duplicate: true, day: dayView(existing, now.toISOString()) });
      if (!existing?.Day_Start__c) return jsonResponse(409, cors, { error: "state", code: "DAY_NOT_STARTED", message: "You haven't started a day yet — clock in on a call or tap Start my day first." });
      if (existing.Day_End__c) return jsonResponse(200, cors, { success: true, alreadyEnded: true, day: dayView(existing, now.toISOString()) });
      if (at < existing.Day_Start__c) return bad(cors, "AT_OUT_OF_ORDER", `That time is before the day started (${existing.Day_Start__c}).`);
      const stillOn = await openCall(tenantId, tech.Id);
      if (stillOn) {
        return jsonResponse(409, cors, {
          error: "state",
          code: "DAY_CALL_OPEN",
          callId: stillOn.Id,
          callNumber: stillOn.Name ?? null,
          jobNumber: stillOn.Sundial_Service_Job__r?.Name ?? null,
          message: `Clock out of ${stillOn.Sundial_Service_Job__r?.Name ?? stillOn.Name ?? "your open call"} first — a day can't end with a call still on the clock.`,
        });
      }
      const note = strOrNull(body?.note);
      log.push({ kind: "end", at, gps, eventId, via: "tech" });
      if (note) log.push({ kind: "note", at, note: note.slice(0, MAX_NOTE_CHARS), eventId: eventId ? `${eventId}:note` : null, via: "tech" });
      const outside = await outsideMinutesFor(tenantId, tech, existing.Work_Date__c, existing.Day_Start__c, at).catch(() => null);
      let row;
      try {
        row = await saveDay(ctx, tech, existing.Work_Date__c, existing, log, outside == null ? {} : { Outside_Minutes__c: outside });
      } catch (e) {
        return sfError(cors, e, "day end");
      }
      return jsonResponse(200, cors, { success: true, day: dayView(row, now.toISOString()), outsideMinutes: outside });
    },

    async techDayNote({ ctx, body }) {
      const { tenantId, cors } = ctx;
      const tech = await actingTech(ctx, body?.techId);
      if (!tech) return jsonResponse(403, cors, { error: "no_user", code: "NO_TECH_USER", message: "Your login is not linked to an active Sundial user." });
      const note = strOrNull(body?.note);
      if (!note) return bad(cors, "NOTE_REQUIRED", "Write a note first.");
      const now = d.now();
      const r = resolveEventAt(body?.at, now, null);
      if (r.error) return bad(cors, r.error[0], r.error[1]);
      const at = r.at;
      const date = strOrNull(body?.date) ?? localDate(new Date(at), tz());
      if (!dayBounds(date, tz())) return bad(cors, "DATE_INVALID", "date must be YYYY-MM-DD.");
      const eventId = strOrNull(body?.eventId);
      const existing = await loadDay(tech.Id, date, tenantId);
      const log = parseDayLog(existing?.Day_Log__c);
      if (hasDayEvent(log, eventId)) return jsonResponse(200, cors, { success: true, duplicate: true, day: dayView(existing, now.toISOString()) });
      if (!existing?.Day_Start__c) return jsonResponse(409, cors, { error: "state", code: "DAY_NOT_STARTED", message: "There is no day to note on — start the day (or clock in on a call) first." });
      log.push({ kind: "note", at, note: note.slice(0, MAX_NOTE_CHARS), eventId, via: "tech" });
      let row;
      try {
        row = await saveDay(ctx, tech, date, existing, log);
      } catch (e) {
        return sfError(cors, e, "day note");
      }
      return jsonResponse(200, cors, { success: true, day: dayView(row, now.toISOString()) });
    },

    // --- the office: where everyone last was ------------------------------------------
    async techLocations({ ctx }) {
      const { tenantId, cors } = ctx;
      const now = d.now();
      const since = new Date(now.getTime() - LOCATION_LOOKBACK_DAYS * 86400000).toISOString();
      const [{ techs }, calls, days] = await Promise.all([
        h.loadTechs(tenantId),
        loadCalls(tenantId, `Tech__c != null AND Actual_Start__c >= ${h.soqlDateTime(since)}`),
        loadDays(tenantId, `Day_Start__c >= ${h.soqlDateTime(since)}`),
      ]);
      const spots = lastLocations({ techs, calls, days });
      const openByTech = new Map();
      for (const c of calls) {
        if (c.Tech__c && ["En Route", "In Progress"].includes(c.Status__c) && openIntervalIndex(parseIntervals(c.Clock_Intervals__c)) >= 0) openByTech.set(c.Tech__c, c);
      }
      const dayByTech = new Map();
      for (const r of days) if (r.Day_Start__c && !r.Day_End__c) dayByTech.set(r.Tech__c, r);
      return jsonResponse(200, cors, {
        techs: techs.map((t) => {
          const spot = spots.find((s) => s.techId === t.id) ?? {};
          const open = openByTech.get(t.id) ?? null;
          const day = dayByTech.get(t.id) ?? null;
          return {
            id: t.id,
            name: t.name,
            location: spot.gps ? { lat: spot.gps.lat, lng: spot.gps.lng, at: spot.at, kind: spot.kind, callId: spot.callId ?? null, callNumber: spot.callNumber ?? null, jobId: spot.jobId ?? null, jobNumber: spot.jobNumber ?? null, customer: spot.customer ?? null, address: spot.address ?? null } : null,
            onCall: open ? { callId: open.Id, callNumber: open.Name ?? null, jobId: open.Sundial_Service_Job__c ?? null, jobNumber: open.Sundial_Service_Job__r?.Name ?? null, customer: open.Sundial_Service_Job__r?.Customer_Name_at_Creation__c ?? null, status: open.Status__c } : null,
            dayOpen: day ? { since: day.Day_Start__c, date: day.Work_Date__c } : null,
          };
        }),
        serverTime: now.toISOString(),
      });
    },

    // --- Admin: the weekly payroll report -------------------------------------------------
    async payroll({ ctx, query }) {
      const { tenantId, cors } = ctx;
      const now = d.now();
      const asked = strOrNull(query?.week) ?? localDate(now, tz());
      const monday = weekMonday(asked);
      if (!monday) return bad(cors, "WEEK_INVALID", "week must be YYYY-MM-DD.");
      const week = weekBounds(monday, tz());
      const techFilter = strOrNull(query?.techId);
      if (techFilter && !SF_ID_RE.test(techFilter)) return bad(cors, "TECH_INVALID", "techId must be a Salesforce id.");
      const techWhere = techFilter ? ` AND Tech__c = '${soqlEscapeString(techFilter)}'` : "";
      // Calls whose clock could touch the week: started in it, or scheduled in it (a call clocked
      // in late Sunday is caught by the +1 day slack; the clip does the rest).
      const [{ techs }, calls, days] = await Promise.all([
        h.loadTechs(tenantId),
        loadCalls(tenantId, `Tech__c != null AND Actual_Start__c >= ${h.soqlDateTime(new Date(Date.parse(week.from) - 86400000).toISOString())} AND Actual_Start__c < ${h.soqlDateTime(new Date(Date.parse(week.to) + 86400000).toISOString())}${techWhere}`),
        loadDays(tenantId, `Work_Date__c >= ${week.monday} AND Work_Date__c <= ${week.sunday}${techWhere}`),
      ]);
      const wanted = techFilter ? techs.filter((t) => t.id === techFilter) : techs;
      const report = buildPayroll({ techs: wanted, days, calls, week, timeZone: tz(), now: now.toISOString() });
      return jsonResponse(200, cors, report);
    },
  };
  return { handlers, ops };
}
