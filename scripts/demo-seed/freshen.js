// freshen.js — `--freshen`: bring the demo's DATE-RELATIVE data back to "this week".
//
// WHY: the dispatch board shows the calls of the viewed week, the tech's Today screen
// shows today's calls and payroll shows the current week's clocks. A demo given three
// weeks after the seed would show an empty board and an empty payroll. Freshen fixes
// exactly that and nothing else.
//
// WHAT IT DOES (only ever to records in the id-map — never to anything else):
//   1. MOVES every demo call that is still open (Scheduled / En Route / In Progress) into
//      today … +7 days, laid out by the same rules as the original board (no overlaps per
//      tech, 07:00–16:00 Phoenix). Call STATUSES do not change, so no job status changes.
//   2. RE-CREATES TODAY'S PICTURE: tech 1 clocked in on a call (an open clock interval),
//      tech 2 on the way, tech 3 with a call coming up. If the demo no longer has a call in
//      one of those states (someone completed it while demoing), the tech's next open call
//      is promoted — and where that starts work on a job that was only Scheduled, the job
//      moves to In Progress, which is what settleJobStatus() does on a clock-in.
//   3. ADDS Complete calls (with clock data) for the working days of THIS week since the
//      board was last anchored, plus this morning's, attached to demo jobs that are In
//      Progress and still have a visit booked; and a tech-day row for each of those days.
//      That is what fills payroll for the current week.
//   4. CLOSES the demo tech days left open on the old "today".
//
// WHAT IT DOES NOT DO — the limits, stated plainly:
//   * It creates no new jobs, estimates, invoices or payments. The added Complete calls
//     pile up on the handful of jobs that are In Progress, so after many freshens those
//     jobs carry many visits.
//   * If no job is In Progress any more, up to three Scheduled jobs take the added calls and
//     become In Progress (the honest outcome of "a tech worked on it and another visit is
//     still booked"). Otherwise no job changes status.
//   * Only the CURRENT payroll week gets history. After a gap of several weeks the weeks in
//     between stay empty on the board and in payroll.
//   * Solar and roofing dates, estimate "valid until" dates, invoice due dates and the
//     Supabase rows (comments, texts, activity) are NOT moved; they simply age.
//   * If every open call has been completed or cancelled by hand, there is nothing left to
//     move and nothing to attach new calls to: freshen says so and changes nothing.

import { applyClockEvent, clockFields, appendStamped, parseIntervals } from "../../lambdas/sundial-service-board/tech.js";
import { dayFields, parseDayLog, intervalSpans, clipSpans, unionMs, weekMonday } from "../../lambdas/sundial-service-board/day.js";
import { createRng } from "./prng.js";
import { addDays, addMinutes, daysBetween, phxDateOf, PHOENIX_TZ } from "./dates.js";
import { ref, json } from "./tokens.js";
import { OBJ } from "./policy.js";
import { TECH_KEYS, SHOP, persona } from "./catalog.js";
import { buildSchedule, demoNowFor, planTechDays, OPEN_CALL_STATUSES, NORMAL_DAY } from "./plan-service.js";

const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
const iso = (v) => (v ? new Date(Date.parse(String(v).replace(/\+0000$/, "Z"))).toISOString() : null);
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/** The date the board is currently anchored to: the last freshen, else the original seed. */
export function boardDateOf(idmapData) {
  const last = (idmapData.freshen || []).slice(-1)[0];
  return last?.date ?? idmapData.anchor?.date ?? null;
}

/** READ-ONLY: the demo's own calls, jobs and tech days, as they are in Salesforce right now. */
export async function collectFreshenState({ sf, idmap }) {
  const keysOf = (prefix, sfObject) => Object.keys(idmap.ids).filter((k) => k.startsWith(prefix) || idmap.data.objects?.[k] === sfObject);
  const keyById = new Map(Object.entries(idmap.ids).map(([k, v]) => [v, k]));
  const tenantId = idmap.idOf("tenant");
  const load = async (sfObject, keys, select) => {
    const rows = [];
    for (const part of chunk(keys.map((k) => idmap.ids[k]), 150)) {
      rows.push(...(await sf.sfQuery(`SELECT ${select} FROM ${sfObject} WHERE Id IN (${part.map((id) => `'${id}'`).join(", ")})`)));
    }
    // A record whose tenant is not the demo's is never touched (it should not exist; if it does, it is left alone).
    return rows.filter((r) => String(r.Client__c).slice(0, 15) === String(tenantId).slice(0, 15));
  };
  const calls = (await load(OBJ.call, keysOf("call:", OBJ.call), "Id, Name, Client__c, Status__c, Tech__c, Sundial_Service_Job__c, Scheduled_Start__c, Scheduled_End__c, Clock_Intervals__c"))
    .map((r) => ({ key: keyById.get(r.Id), status: r.Status__c, techKey: keyById.get(r.Tech__c) ?? null, jobKey: keyById.get(r.Sundial_Service_Job__c) ?? null, start: iso(r.Scheduled_Start__c), end: iso(r.Scheduled_End__c), intervals: parseIntervals(r.Clock_Intervals__c) }));
  const jobs = (await load(OBJ.job, keysOf("job:", OBJ.job), "Id, Name, Client__c, Status__c, Geocode_Lat__c, Geocode_Lon__c, Total_Call_Count__c, Total_Time_Minutes__c, Notes_for_Summary__c"))
    .map((r) => ({ key: keyById.get(r.Id), status: r.Status__c, lat: r.Geocode_Lat__c ?? SHOP.lat, lng: r.Geocode_Lon__c ?? SHOP.lng, callCount: r.Total_Call_Count__c ?? 0, minutes: r.Total_Time_Minutes__c ?? 0 }));
  const days = (await load(OBJ.day, keysOf("day:", OBJ.day), "Id, Client__c, Tech__c, Work_Date__c, Status__c, Day_Start__c, Day_Log__c"))
    .map((r) => ({ key: keyById.get(r.Id), techKey: keyById.get(r.Tech__c) ?? null, date: r.Work_Date__c, status: r.Status__c, start: iso(r.Day_Start__c), log: parseDayLog(r.Day_Log__c) }));
  return { calls, jobs, days };
}

/**
 * PURE. Decide every change freshen would make.
 * @param {{calls, jobs, days}} state   from collectFreshenState (or a test fixture)
 * @param {{ boardDate, newDate, nowIso, seed, existingDayKeys?: Set<string> }} p
 *        existingDayKeys: "techKey|date" of tech-day rows already in the org for those days
 * @returns {{ ops: object[], summary: object, notes: string[] }}
 */
export function planFreshen(state, { boardDate, newDate, nowIso, seed, existingDayKeys = new Set() }) {
  const notes = [];
  const ops = [];
  const summary = { moved: 0, promoted: 0, reassigned: 0, addedCalls: 0, addedDays: 0, closedDays: 0, jobsStarted: 0 };
  const gap = daysBetween(boardDate, newDate);
  if (gap <= 0) {
    notes.push(`The board is already anchored to ${boardDate}; nothing to freshen.`);
    return { ops, summary, notes };
  }
  const open = state.calls.filter((c) => OPEN_CALL_STATUSES.includes(c.status) && c.key);
  if (!open.length) {
    notes.push("No demo call is still open (they were all completed or cancelled). There is nothing to move and nothing to attach new calls to — freshen changes nothing.");
    return { ops, summary, notes };
  }
  const tag = `fresh:${newDate}`;
  const jobs = new Map(state.jobs.map((j) => [j.key, { ...j }]));
  const { nowMin, now } = demoNowFor(newDate, nowIso);
  // History is added for THIS payroll week only (Monday … yesterday), and never for a day the
  // board already covers. Older weeks stay as they are — empty, if the gap was long.
  const history = Math.min(gap - 1, daysBetween(weekMonday(newDate), newDate));
  // The week ahead is laid out like the original board. If that leaves fewer free slots than
  // there are open calls to place, the future days are made fuller (three to four calls a
  // day, then four) — today's picture and the history days are the same either way.
  let usable = [];
  for (const futureDay of [NORMAL_DAY, [[3, 60], [4, 40]], [[4, 100]]]) {
    const slots = buildSchedule({ rng: createRng(seed, tag), anchorDate: newDate, nowMin, fromOffset: -history, toOffset: 7, futureDay });
    // Days the original board (or an earlier freshen) already covers are never written to twice.
    usable = slots.filter((s) => s.date > boardDate);
    if (usable.filter((s) => ["scheduled", "inprogress", "enroute"].includes(s.kind)).length >= open.length) break;
  }
  const r = createRng(seed, `${tag}/calls`);
  const near = (p, spread = 0.0003) => ({ lat: Math.round((p.lat + (r.next() - 0.5) * spread) * 1e6) / 1e6, lng: Math.round((p.lng + (r.next() - 0.5) * spread) * 1e6) / 1e6, accuracy: r.int(5, 18) });
  const byStart = (a, b) => String(a.start ?? "").localeCompare(String(b.start ?? "")) || a.key.localeCompare(b.key);

  // --- 1 + 2: today's picture, then every other open call into a free slot ---------------
  const left = open.slice().sort(byStart);
  const take = (pred) => {
    const i = left.findIndex(pred);
    return i < 0 ? null : left.splice(i, 1)[0];
  };
  const todays = [];
  const moveFields = (slot, call) => compact({ Scheduled_Start__c: slot.start, Scheduled_End__c: slot.end, Tech__c: call.techKey !== slot.techKey ? ref(slot.techKey) : undefined });
  for (const slot of usable.filter((s) => s.kind === "inprogress" || s.kind === "enroute")) {
    const wanted = slot.kind === "inprogress" ? "In Progress" : "En Route";
    // Prefer the call already in that state; else that tech's next open call; else anyone's.
    const call = take((c) => c.status === wanted && c.techKey === slot.techKey) ?? take((c) => c.status === wanted)
      ?? take((c) => c.status === "Scheduled" && c.techKey === slot.techKey) ?? take((c) => c.status === "Scheduled");
    if (!call) continue;
    const job = jobs.get(call.jobKey);
    let log = [];
    const ev = (n) => `demo-${tag}-${call.key.replace(":", "-")}-${n}`;
    if (slot.kind === "inprogress") {
      const arrive = addMinutes(slot.start, 2);
      log = applyClockEvent(log, { kind: "en_route", at: addMinutes(arrive, -12), gps: near(SHOP, 0.02), eventId: ev(1) }).intervals;
      log = applyClockEvent(log, { kind: "clock_in", at: arrive, gps: near(job ?? SHOP), eventId: ev(2) }).intervals;
    } else {
      log = applyClockEvent(log, { kind: "en_route", at: addMinutes(now, -8), gps: near(SHOP, 0.02), eventId: ev(1) }).intervals;
    }
    ops.push({ op: "update", key: `${tag}:${call.key}#today`, target: call.key, object: OBJ.call, phase: "freshen", fields: { ...moveFields(slot, call), Status__c: wanted, ...compact(clockFields(log)), Geofence_Verified__c: slot.kind === "inprogress" ? true : undefined } });
    if (call.status !== wanted) summary.promoted++;
    else summary.moved++;
    if (call.techKey !== slot.techKey) summary.reassigned++;
    todays.push({ key: call.key, techKey: slot.techKey, date: slot.date, intervals: log });
    // A clock-in on a job that was only Scheduled starts the job (settleJobStatus: in_progress).
    if (slot.kind === "inprogress" && job && job.status === "Scheduled") {
      job.status = "In Progress";
      summary.jobsStarted++;
      ops.push({ op: "update", key: `${tag}:${job.key}#started`, target: job.key, object: OBJ.job, phase: "freshen", fields: { Status__c: "In Progress", Status_Changed_At__c: log[0].arrived } });
    }
  }
  // Scheduled calls keep their tech where a slot is free, else take another tech's free slot.
  const free = usable.filter((s) => s.kind === "scheduled");
  const place = (call, slot) => {
    free.splice(free.indexOf(slot), 1);
    // A call that was "on the way" but is not today's en-route call goes back to a plain
    // booking: its half-open drive interval is cleared (a planned blank on each clock field).
    const demote = call.status === "Scheduled" ? {} : { Status__c: "Scheduled", Clock_Intervals__c: null, Actual_Start__c: null, Clock_In_Latitude__c: null, Clock_In_Longitude__c: null };
    ops.push({ op: "update", key: `${tag}:${call.key}#move`, target: call.key, object: OBJ.call, phase: "freshen", fields: { ...moveFields(slot, call), ...demote } });
    summary.moved++;
    if (call.techKey !== slot.techKey) summary.reassigned++;
  };
  const waiting = [];
  for (const call of left) {
    // A call that was En Route / In Progress but did not get today's pivot goes back to a plain booking
    // only if it never recorded an arrival; one with work on the clock is left exactly as it is.
    if (call.status !== "Scheduled" && call.intervals.some((i) => i.arrived)) { notes.push(`${call.key} is ${call.status} with time on the clock; left untouched.`); continue; }
    const slot = free.find((s) => s.techKey === call.techKey);
    if (slot) place(call, slot);
    else waiting.push(call);
  }
  for (const call of waiting) {
    if (free.length) place(call, free[0]);
    else notes.push(`${call.key}: no free slot in the next 7 days even with full days; left where it was (it will show as overdue).`);
  }

  // --- 3: Complete calls for the days since the board was last anchored --------------------
  // The added calls go onto jobs that are already In Progress and still have a visit booked:
  // "a tech worked on it again, another visit is still to come" leaves such a job exactly
  // where it is. Only if the demo has no such job left do Scheduled jobs take them (and start).
  const withOpenCall = (j) => open.some((c) => c.jobKey === j.key);
  const inProgress = [...jobs.values()].filter((j) => j.status === "In Progress" && withOpenCall(j)).sort((a, b) => a.key.localeCompare(b.key));
  const hosts = inProgress.length ? inProgress : [...jobs.values()].filter((j) => j.status === "Scheduled" && withOpenCall(j)).sort((a, b) => a.key.localeCompare(b.key)).slice(0, 3);
  const added = [];
  if (!hosts.length) notes.push("No demo job is In Progress or Scheduled, so no Complete calls were added.");
  else {
    usable.filter((s) => s.kind === "complete").forEach((slot, i) => {
      const job = hosts[i % hosts.length];
      const tech = persona(slot.techKey);
      const key = `${tag}:call:${slot.date}:${tech.slug}:${i + 1}`;
      let log = [];
      const arrive = addMinutes(slot.start, r.int(-5, 8));
      if (r.chance(0.7)) log = applyClockEvent(log, { kind: "en_route", at: addMinutes(arrive, -r.int(8, 15)), gps: near(SHOP, 0.02), eventId: `demo-${key}-1` }).intervals;
      log = applyClockEvent(log, { kind: "clock_in", at: arrive, gps: near(job), eventId: `demo-${key}-2` }).intervals;
      log = applyClockEvent(log, { kind: "clock_out", at: addMinutes(slot.end, r.int(-20, 5)), gps: near(job), eventId: `demo-${key}-3` }).intervals;
      const derived = compact(clockFields(log));
      const stampAt = addMinutes(derived.Actual_End__c, -4);
      const note = "Follow-up visit. Checked the earlier work, readings normal, site left tidy.";
      const workNotes = appendStamped(null, { name: tech.name, at: stampAt, timeZone: PHOENIX_TZ, body: note });
      const done = { done: true, at: stampAt, by: tech.name };
      ops.push({
        op: "create", key, object: OBJ.call, phase: "freshen",
        fields: {
          Client__c: ref("tenant"), Visit_Type__c: "Service", Visit_Sub_Type__c: "On-Site", Sundial_Service_Job__c: ref(job.key), Tech__c: ref(slot.techKey),
          Scheduled_Start__c: slot.start, Scheduled_End__c: slot.end, Status__c: "Complete", ...derived, Geofence_Verified__c: true,
          Work_Notes__c: workNotes, Checklist_Template_Key__c: "default", Checklist_State__c: JSON.stringify({ walkthrough: done, tools: done, review: { done: false } }),
        },
      });
      job.callCount += 1;
      job.minutes += derived.Duration_Minutes__c;
      // Keep the job's roll-ups in step, and start a job that was only Scheduled.
      const jobFields = { Total_Call_Count__c: job.callCount, Total_Time_Minutes__c: job.minutes };
      if (job.status === "Scheduled") {
        job.status = "In Progress";
        jobFields.Status__c = "In Progress";
        jobFields.Status_Changed_At__c = log[0].arrived;
        summary.jobsStarted++;
      }
      // The completed call's work notes roll up onto the job, as they do when a tech completes a call.
      jobFields.Notes_for_Summary__c = { $jobNotes: { kind: "work", mergeInto: job.key, calls: [{ key, techName: tech.name, at: derived.Actual_End__c, work: workNotes, priv: null }] } };
      ops.push({ op: "update", key: `${key}#job`, target: job.key, object: OBJ.job, phase: "freshen", fields: jobFields });
      added.push({ key, techKey: slot.techKey, date: slot.date, intervals: log });
      summary.addedCalls++;
    });
  }

  // --- tech days for every day that now has clock time (skipping any that already exist) ---
  const dayRows = planTechDays([...added, ...todays], { rng: createRng(seed, `${tag}/days`), anchorDate: newDate, keyPrefix: `${tag}:day` })
    .filter((d) => !existingDayKeys.has(`${d.techKey}|${d.date}`));
  for (const d of dayRows) ops.push({ op: "create", key: d.key, object: OBJ.day, phase: "freshen", fields: d.fields });
  summary.addedDays = dayRows.length;

  // --- 4: close the demo tech days still open on an earlier date ------------------------------
  for (const d of state.days.filter((x) => x.status === "Open" && x.date < newDate && x.key && x.start)) {
    const spans = state.calls.filter((c) => c.techKey === d.techKey).flatMap((c) => intervalSpans(c.intervals, null)).filter(([a]) => phxDateOf(new Date(a).toISOString()) === d.date);
    const lastOut = spans.length ? Math.max(...spans.map(([, b]) => b)) : Date.parse(d.start) + 4 * 3600000;
    const endAt = new Date(Math.max(lastOut, Date.parse(d.start)) + 20 * 60000).toISOString();
    const log = [...d.log, { kind: "end", at: endAt, gps: { lat: SHOP.lat, lng: SHOP.lng }, eventId: `demo-${tag}-${d.key}-end`, via: "tech" }];
    const derived = dayFields(log);
    const a = Date.parse(d.start);
    const z = Date.parse(endAt);
    ops.push({
      op: "update", key: `${tag}:${d.key}#close`, target: d.key, object: OBJ.day, phase: "freshen",
      fields: compact({ ...derived, Day_Log__c: json(log), Outside_Minutes__c: Math.round(Math.max(0, z - a - unionMs(clipSpans(spans, a, z))) / 60000) }),
    });
    summary.closedDays++;
  }
  return { ops, summary, notes, newDate, demoNow: now };
}
