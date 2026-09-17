// tech.js — the technician app's backend (D-072 amendment 7, docs/pwa-architecture.md).
// Mounted by index.js under /service/tech/*; every route needs `service.tech.self`.
//
//   GET  /service/tech/day?date=YYYY-MM-DD        my calls that day (+ anything I'm mid-way through)
//   GET  /service/tech/calls/{id}                 one call: job, clock, checklist, photos, estimate, other techs
//   POST /service/tech/calls/{id}/status          { status, at?, gps?, eventId?, message?, textCustomer?, note? }
//   POST /service/tech/calls/{id}/notes           { body, private?, at?, eventId? }
//   POST /service/tech/calls/{id}/checklist       { key, done, at? }
//   POST /service/tech/calls/{id}/photos          { fileName, contentType } → presigned PUT
//   POST /service/tech/calls/{id}/photos/confirm  { key, size?, caption? } → metadata row + Photos_Count__c
//   GET  /service/tech/calls/{id}/photos
//   GET  /service/tech/price-book?q=              active items, for "add to estimate"
//   READ-ONLY, TENANT-WIDE (action service.tech.read — 2026-09-16, Tim: "techs may need
//   to see these even if they aren't assigned"):
//   GET  /service/tech/jobs?q=&status=            jobs (open ones by default), search by number / name / address / phone
//   GET  /service/tech/jobs/{id}                  one job: header, its calls, the estimate summary
//   GET  /service/tech/estimates?q=&status=       estimates (not templates)
//   GET  /service/tech/estimates/{id}             one estimate with its lines and stored totals
//   GET  /service/tech/customers?q=               the customer hub
//   GET  /service/tech/customers/{id}             one customer with their jobs and estimates
//
// WHO MAY TOUCH A CALL: the tech it is assigned to (Tech__c = the caller's Sundial user),
// or anyone with tenant scope (the office acting as / checking on a tech). Anyone else
// gets a 404 — the app never learns another tech's call exists.
//
// THE CLOCK (service-workflows.md §8). One append-only log per call, Clock_Intervals__c:
//   [{ in, out, kind: "en_route"|"on_site", arrived?, in_gps?, out_gps?, ids: [...] }]
//   "On my way"  opens an en_route interval (drive time belongs to the destination) and
//                ENDS whatever the tech had open on another call.
//   "Clock in"   continues the open en_route interval (marks `arrived`) or opens on_site.
//   "Complete"   closes the open interval; the completion gate must pass first.
//   Actual_Start = first `in`, Actual_End = last `out`, Duration = the sum of intervals.
//   Re-clocking-in on a Complete call reopens it (a new interval; the log never edits).
// Every event carries the phone's tap time (`at`) — the offline queue replays in order
// with the original times — and an `eventId` so a replayed request is a no-op, not a
// second interval. Time corrections are the office's job (the board), never the app's.
//
// GEOFENCE: a tag, never a gate. On clock-in we compare the phone's GPS with the job's
// geocode (lazily geocoded on first use through Google, key in `sundial/google-maps`)
// or the shop (SERVICE_SHOP_LATLNG). Within SERVICE_GEOFENCE_METERS (default 250) →
// Geofence_Verified__c = true. No GPS, no geocode, no key → simply unverified.
//
// TENANT ISOLATION: every read is Client__c-bound; ids from another tenant are 404.

import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { soqlEscapeString } from "../../lib/salesforce.js";
import { EVENTS } from "../../lib/service-activity.js";
import { buildKey, publicUrlForKey, sanitizeFileName, registerFileMetadata, findFileMetadataByKey, S3_BUCKET, S3_REGION } from "../../lib/file-access.js";

export const GOOGLE_SECRET_NAME = "sundial/google-maps"; // { apiKey } — same key the street-view feature uses
export const ESTIMATE_SF_OBJECT = "Sundial_Estimate__c";
export const LINE_SF_OBJECT = "Sundial_Service_Line__c";
export const ITEM_SF_OBJECT = "Sundial_Price_Book_Item__c";
export const TECH_STATUSES = Object.freeze(["En Route", "In Progress", "Complete", "No-Show"]);
export const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";
/** Jobs the lists hide unless asked for by status: finished business. */
export const CLOSED_JOB_STATUSES = Object.freeze(["Closed", "Cancelled", "Paid"]);
const LIST_LIMIT = 50;
export const TECH_JOB_SELECT =
  "Id, Name, Client__c, Status__c, Priority__c, Service_Type__c, Job_Type__c, Customer_Name_at_Creation__c, Address_at_Creation__c, " +
  "Primary_Phone_at_Creation__c, Primary_Email_at_Creation__c, Issue_Description__c, Customer_Summary__c, Sundial_Customer__c, Estimate__c, " +
  "Estimate_Total__c, Bill_To_Type__c, Payment_Status__c, Geocode_Lat__c, Geocode_Lon__c, CreatedDate, SystemModstamp";
export const TECH_ESTIMATE_SELECT =
  "Id, Name, Client__c, Status__c, Version__c, Is_Template__c, Customer_Name_at_Creation__c, Address_at_Creation__c, Primary_Phone_at_Creation__c, " +
  "Sundial_Customer__c, Service_Job__c, Subtotal__c, Discount_Amount__c, Tax_Amount__c, Total__c, Deposit_Amount__c, Sent_At__c, Approved_At__c, CreatedDate";
export const TECH_CUSTOMER_SELECT =
  "Id, Name, First_Name__c, Last_Name__c, Street__c, City__c, State__c, Postal_Code__c, Primary_Email__c, Primary_Phone__c, Requested_Project_Types__c, CreatedDate";
const CLOCK_FUTURE_GRACE_MS = 5 * 60 * 1000;
const CLOCK_MAX_AGE_MS = 7 * 86400000;
const PHOTO_URL_EXPIRY_SECONDS = 300;
const PHOTO_MAX_BYTES = 25 * 1024 * 1024;
const MAX_NOTE_CHARS = 20000;
const MAX_TEXT_CHARS = 320;

/** Extra columns the app needs beyond the board's CALL_SELECT. */
export const TECH_CALL_EXTRA =
  "Clock_In_Latitude__c, Clock_In_Longitude__c, Clock_Out_Latitude__c, Clock_Out_Longitude__c, " + // Clock_Intervals__c is in CALL_SELECT (the board's PATCH needs it too)
  "Checklist_Template_Key__c, Checklist_State__c, " +
  "Sundial_Service_Job__r.Issue_Description__c, Sundial_Service_Job__r.Estimate__c, Sundial_Service_Job__r.Primary_Email_at_Creation__c, " +
  "Sundial_Service_Job__r.Geocode_Lat__c, Sundial_Service_Job__r.Geocode_Lon__c, Sundial_Service_Job__r.Geocode_Status__c";

const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;
const strOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Phone GPS → { lat, lng, accuracy } or null. Rejects anything that is not a coordinate. */
export function gpsFrom(v) {
  if (!v || typeof v !== "object") return null;
  const lat = num(v.lat ?? v.latitude);
  const lng = num(v.lng ?? v.lon ?? v.longitude);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const out = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
  const acc = num(v.accuracy);
  if (acc !== null && acc >= 0) out.accuracy = Math.round(acc);
  return out;
}

/** Great-circle distance in metres. */
export function haversineMeters(a, b) {
  if (!a || !b) return null;
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(Math.min(1, s))));
}

/** "33.45,-112.07" (env SERVICE_SHOP_LATLNG) → { lat, lng } or null. */
export function parseLatLng(s) {
  const m = String(s ?? "").trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  return m ? gpsFrom({ lat: m[1], lng: m[2] }) : null;
}

/**
 * Is the phone within `radius` metres of any of the given points? Returns
 * { verified, distanceMeters (to the nearest point), against: "job"|"shop"|null }.
 */
export function geofenceCheck(gps, points, radius) {
  let best = null;
  for (const p of points) {
    if (!p?.point) continue;
    const dist = haversineMeters(gps, p.point);
    if (dist === null) continue;
    if (!best || dist < best.distanceMeters) best = { distanceMeters: dist, against: p.label };
  }
  if (!gps || !best) return { verified: false, distanceMeters: null, against: null };
  return { verified: best.distanceMeters <= radius, distanceMeters: best.distanceMeters, against: best.against };
}

export function parseIntervals(json) {
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
  return v.filter((i) => i && typeof i === "object" && typeof i.in === "string").map((i) => ({ ...i, ids: Array.isArray(i.ids) ? i.ids : [] }));
}
/**
 * An interval the office removed stays in the log (with `removed: { at, by, reason }`) so the
 * history is never lost, but it counts for nothing: not time, not the open clock, not the floor.
 * The one thing it keeps is its event ids — a replayed tap that produced it is still a duplicate.
 */
export const isLive = (i) => !i.removed;
export const liveIntervals = (intervals) => intervals.filter(isLive);
export const openIntervalIndex = (intervals) => intervals.findIndex((i) => isLive(i) && !i.out);
export const hasClockEvent = (intervals, id) => !!id && intervals.some((i) => i.ids.includes(id));
/** The latest timestamp in the log — the floor for the next event. */
export function lastClockTime(intervals) {
  let t = null;
  for (const i of intervals) {
    if (!isLive(i)) continue;
    for (const k of ["in", "arrived", "out"]) if (i[k] && (!t || i[k] > t)) t = i[k];
  }
  return t;
}
/** Minutes across all live intervals; an open one counts up to `now` when given. */
export function sumMinutes(intervals, now = null) {
  let ms = 0;
  for (const i of intervals) {
    if (!isLive(i)) continue;
    const a = Date.parse(i.in);
    const b = i.out ? Date.parse(i.out) : now ? Date.parse(now) : NaN;
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) ms += b - a;
  }
  return Math.round(ms / 60000);
}

/**
 * Apply one clock event to a log. kind: "en_route" | "clock_in" | "clock_out".
 * Returns { intervals, changed, duplicate }. Never edits a closed interval.
 */
export function applyClockEvent(intervals, { kind, at, gps = null, eventId = null }) {
  const log = intervals.map((i) => ({ ...i, ids: [...i.ids] }));
  if (hasClockEvent(log, eventId)) return { intervals: log, changed: false, duplicate: true };
  const open = openIntervalIndex(log);
  const tag = (i) => {
    if (eventId) i.ids.push(eventId);
  };
  if (kind === "en_route") {
    if (open >= 0) return { intervals: log, changed: false, duplicate: false }; // already on the clock for this call
    const i = { in: at, out: null, kind: "en_route", ids: [] };
    if (gps) i.in_gps = gps;
    tag(i);
    log.push(i);
    return { intervals: log, changed: true, duplicate: false };
  }
  if (kind === "clock_in") {
    if (open >= 0) {
      const i = log[open];
      if (i.kind === "en_route" && !i.arrived) {
        i.arrived = at;
        if (gps) i.arrived_gps = gps;
        tag(i);
        return { intervals: log, changed: true, duplicate: false };
      }
      return { intervals: log, changed: false, duplicate: false }; // already clocked in
    }
    const i = { in: at, out: null, kind: "on_site", arrived: at, ids: [] };
    if (gps) i.in_gps = gps;
    tag(i);
    log.push(i);
    return { intervals: log, changed: true, duplicate: false };
  }
  if (kind === "clock_out") {
    if (open < 0) return { intervals: log, changed: false, duplicate: false };
    const i = log[open];
    i.out = at;
    if (gps) i.out_gps = gps;
    tag(i);
    return { intervals: log, changed: true, duplicate: false };
  }
  throw new Error(`unknown clock event ${kind}`);
}

/** The clock as the app shows it. */
export function clockState(intervals, now = null) {
  const open = openIntervalIndex(intervals);
  const i = open >= 0 ? intervals[open] : null;
  const state = !i ? "idle" : i.kind === "on_site" || i.arrived ? "on_site" : "en_route";
  return {
    state,
    since: i ? i.arrived || i.in : null,
    openSince: i ? i.in : null,
    minutes: sumMinutes(intervals, now),
    intervals: liveIntervals(intervals).length,
  };
}

/** Salesforce fields that follow from a log: actuals + duration (+ GPS snapshots). */
export function clockFields(intervals) {
  const live = liveIntervals(intervals);
  const first = live[0] || null;
  const last = live[live.length - 1] || null;
  const closed = live.every((i) => i.out);
  const f = {
    Clock_Intervals__c: JSON.stringify(intervals),
    Actual_Start__c: first ? first.in : null,
    Actual_End__c: closed && last ? last.out : null,
    Duration_Minutes__c: closed ? sumMinutes(intervals) : null,
  };
  const inGps = first?.arrived_gps || first?.in_gps || null;
  if (inGps) {
    f.Clock_In_Latitude__c = inGps.lat;
    f.Clock_In_Longitude__c = inGps.lng;
  }
  const outGps = closed && last?.out_gps ? last.out_gps : null;
  if (outGps) {
    f.Clock_Out_Latitude__c = outGps.lat;
    f.Clock_Out_Longitude__c = outGps.lng;
  }
  return f;
}

// --- the office's corrections -------------------------------------------------
/** The log as the office sees it: every row (removed ones too), numbered so an edit can point at one. */
export function annotateLog(intervals) {
  return intervals.map((i, index) => ({
    index,
    in: i.in,
    arrived: i.arrived ?? null,
    out: i.out ?? null,
    kind: i.kind ?? (i.arrived ? "on_site" : "en_route"),
    minutes: i.out ? Math.max(0, Math.round((Date.parse(i.out) - Date.parse(i.in)) / 60000)) : null,
    gps: { in: i.in_gps ?? null, arrived: i.arrived_gps ?? null, out: i.out_gps ?? null },
    fromPhone: (i.ids || []).length > 0,
    added: i.added ?? null,
    removed: i.removed ?? null,
    corrections: i.corrections ?? [],
  }));
}

/**
 * Apply the office's version of the log. `rows` is the list the dialog sends back: each row
 * either points at an existing interval by `index` (only in / arrived / out may change) or is a
 * new one (needs in + out; kind defaults to on_site). An existing interval left out of the list
 * is removed — kept in the log with a `removed` stamp, ignored everywhere else. Nothing is ever
 * reopened: an open interval may stay open, a closed one stays closed, a new one is closed.
 * Returns { intervals, changed, changes } or { error: [code, message] }.
 */
export function applyCorrection(intervals, rows, { now, by, reason }) {
  if (!Array.isArray(rows)) return { error: ["INTERVALS_REQUIRED", "intervals must be a list."] };
  const nowMs = Date.parse(now);
  const parseT = (v, label, n) => {
    if (v === null || v === undefined || v === "") return { t: null };
    const t = Date.parse(String(v));
    if (!Number.isFinite(t)) return { error: ["TIME_INVALID", `Row ${n + 1}: ${label} must be a date and time.`] };
    if (t > nowMs + CLOCK_FUTURE_GRACE_MS) return { error: ["TIME_FUTURE", `Row ${n + 1}: ${label} is in the future.`] };
    return { t: new Date(t).toISOString() };
  };
  const stamp = { at: now, by: by ? { id: by.id ?? null, name: by.name ?? null } : null, reason };
  const seen = new Set();
  const next = [];
  for (let n = 0; n < rows.length; n++) {
    const r = rows[n] && typeof rows[n] === "object" ? rows[n] : {};
    let base = null;
    let idx = null;
    if (r.index !== undefined && r.index !== null) {
      idx = Number(r.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= intervals.length || !isLive(intervals[idx])) return { error: ["INDEX_INVALID", `Row ${n + 1}: that interval is not on this call.`] };
      if (seen.has(idx)) return { error: ["INDEX_DUPLICATE", `Row ${n + 1}: the same interval is listed twice.`] };
      seen.add(idx);
      base = intervals[idx];
    }
    const inT = parseT(r.in, "the start", n);
    if (inT.error) return inT;
    const arrT = parseT(r.arrived, "arrived", n);
    if (arrT.error) return arrT;
    const outT = parseT(r.out, "the end", n);
    if (outT.error) return outT;
    if (!inT.t) return { error: ["IN_REQUIRED", `Row ${n + 1}: a start time is required.`] };
    const kind = base ? base.kind ?? (base.arrived ? "on_site" : "en_route") : r.kind === "en_route" ? "en_route" : "on_site";
    if (!base && !outT.t) return { error: ["OUT_REQUIRED", `Row ${n + 1}: a new interval needs an end time.`] };
    if (base && base.out && !outT.t) return { error: ["NO_REOPEN", `Row ${n + 1}: a closed interval can't be reopened — the tech clocks in again instead.`] };
    if (outT.t && outT.t <= inT.t) return { error: ["ORDER_INVALID", `Row ${n + 1}: the end must be after the start.`] };
    const arrived = arrT.t ?? (kind === "on_site" ? inT.t : null);
    if (arrived && (arrived < inT.t || (outT.t && arrived > outT.t))) return { error: ["ORDER_INVALID", `Row ${n + 1}: arrived must fall between the start and the end.`] };
    next.push({ base, idx, in: inT.t, arrived, out: outT.t, kind });
  }
  next.sort((a, b) => a.in.localeCompare(b.in));
  for (let i = 0; i < next.length; i++) {
    if (!next[i].out && i !== next.length - 1) return { error: ["OPEN_NOT_LAST", "Only the latest interval can be open."] };
    if (i > 0 && next[i].in < next[i - 1].out) return { error: ["OVERLAP", `Intervals ${i} and ${i + 1} overlap.`] };
  }

  const changes = { corrected: [], added: 0, removed: 0 };
  const out = intervals.map((i) => ({ ...i, ids: [...i.ids] }));
  for (const row of next) {
    if (row.base) {
      const cur = out[row.idx];
      const from = { in: cur.in, arrived: cur.arrived ?? null, out: cur.out ?? null };
      if (from.in === row.in && from.arrived === row.arrived && from.out === row.out) continue;
      cur.in = row.in;
      if (row.arrived) cur.arrived = row.arrived;
      else delete cur.arrived;
      cur.out = row.out;
      cur.corrections = [...(cur.corrections || []), { ...stamp, from }];
      changes.corrected.push({ index: row.idx, from, to: { in: row.in, arrived: row.arrived, out: row.out } });
    } else {
      const i = { in: row.in, out: row.out, kind: row.kind, ids: [], added: stamp };
      if (row.arrived) i.arrived = row.arrived;
      out.push(i);
      changes.added += 1;
    }
  }
  for (let idx = 0; idx < intervals.length; idx++) {
    if (isLive(intervals[idx]) && !seen.has(idx)) {
      out[idx].removed = stamp;
      changes.removed += 1;
    }
  }
  const changed = changes.corrected.length > 0 || changes.added > 0 || changes.removed > 0;
  // Keep the array in time order so first/last mean what they say; removed rows ride along.
  out.sort((a, b) => a.in.localeCompare(b.in));
  return { intervals: changed ? out : intervals, changed, changes };
}

// --- notes -------------------------------------------------------------------
export function stampFor(name, at, timeZone) {
  const d = new Date(at);
  const when = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
    .format(d)
    .replace(/ /g, " ");
  return `── ${name || "Unknown"} · ${when}`;
}
/** Append one stamped entry. Existing text is never altered — notes are append-only. */
export function appendStamped(existing, { name, at, timeZone, body }) {
  const entry = `${stampFor(name, at, timeZone)}\n${String(body).trim()}`;
  const prev = strOrNull(existing);
  return prev ? `${prev}\n\n${entry}` : entry;
}

// --- checklist -------------------------------------------------------------------
/**
 * The generic default (service-workflows.md §8: "pick up your tools"). A per-tenant
 * template library keyed by Checklist_Template_Key__c is the follow-up; until then
 * every call gets this list. `auto` items are satisfied by the record itself.
 */
export const DEFAULT_CHECKLIST = Object.freeze({
  key: "default",
  title: "Before you leave",
  items: Object.freeze([
    { key: "work_notes", label: "Write up what you did (work notes)", required: true, auto: "notes" },
    { key: "photos", label: "Take at least one photo", required: true, auto: "photos" },
    { key: "walkthrough", label: "Walk the customer through the work", required: true },
    { key: "tools", label: "Pick up your tools and leave the area clean", required: true },
    { key: "review", label: "Ask for a review / leave a card", required: false },
  ]),
});
export function parseChecklistState(json) {
  if (!json) return {};
  try {
    const v = typeof json === "string" ? JSON.parse(json) : json;
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
/** The checklist with each item's state, plus what still blocks Complete. */
export function checklistFor(call) {
  const tpl = DEFAULT_CHECKLIST; // Checklist_Template_Key__c selects a template once there are several
  const state = parseChecklistState(call?.Checklist_State__c);
  const items = tpl.items.map((it) => {
    let done = false;
    let at = null;
    let by = null;
    if (it.auto === "notes") done = !!strOrNull(call?.Work_Notes__c);
    else if (it.auto === "photos") done = (num(call?.Photos_Count__c) ?? 0) > 0;
    else {
      const s = state[it.key];
      done = s === true || (!!s && typeof s === "object" && s.done === true);
      at = s && typeof s === "object" ? s.at ?? null : null;
      by = s && typeof s === "object" ? s.by ?? null : null;
    }
    return { ...it, auto: it.auto ?? null, done, at, by };
  });
  const missing = items.filter((i) => i.required && !i.done).map((i) => i.key);
  return { key: tpl.key, title: tpl.title, items, missing, complete: missing.length === 0 };
}

// --- dates ------------------------------------------------------------------------
function tzOffsetMs(date, timeZone) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime();
}
/** YYYY-MM-DD as seen in the tenant's timezone. */
export function localDate(date, timeZone) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(date);
}
/** Local midnight of (y, mo, d) in a timezone, as a UTC instant — DST-safe (two passes). */
function localMidnightUtc(y, mo, d, timeZone) {
  const guess = Date.UTC(y, mo - 1, d);
  let t = guess - tzOffsetMs(new Date(guess), timeZone);
  const off2 = tzOffsetMs(new Date(t), timeZone);
  if (guess - off2 !== t) t = guess - off2;
  return new Date(t);
}
/** The UTC bounds of one calendar day in a timezone. */
export function dayBounds(dateStr, timeZone) {
  const m = String(dateStr ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d, 12));
  if (Number.isNaN(probe.getTime()) || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null; // Date.UTC rolls "13-40" over; we do not
  return { from: localMidnightUtc(y, mo, d, timeZone).toISOString(), to: localMidnightUtc(y, mo, d + 1, timeZone).toISOString() };
}

/** The "on my way" text. `first` = the customer's first name, `tech` = the tech's. */
export function onMyWayText({ customerName, techFirstName, brandName, jobNumber }) {
  const first = customerName ? String(customerName).split(" ")[0] : "there";
  const who = `${techFirstName || "Your technician"}${brandName ? ` from ${brandName}` : ""}`;
  return `Hi ${first}, ${who} is on the way to you now.${jobNumber ? ` (Job ${jobNumber})` : ""} Reply to this text if anything changes.`;
}

/** Photos live under the job, in a folder per call. */
export const photoPrefix = (jobId, callId) => `${buildKey(jobId, "photos")}/${callId}/`;

/** A search box's text → the SOQL LIKE literal, or null when there is nothing to search for. */
export function likeFor(q) {
  const t = strOrNull(q);
  if (!t) return null;
  return `'%${soqlEscapeString(t).replace(/[%_]/g, " ")}%'`;
}
export function jobToView(j) {
  return {
    id: j.Id,
    number: j.Name ?? null,
    status: j.Status__c ?? null,
    priority: j.Priority__c ?? null,
    serviceType: j.Service_Type__c ?? null,
    jobType: j.Job_Type__c ?? null,
    customerId: j.Sundial_Customer__c ?? null,
    customerName: j.Customer_Name_at_Creation__c ?? null,
    address: j.Address_at_Creation__c ?? null,
    phone: j.Primary_Phone_at_Creation__c ?? null,
    email: j.Primary_Email_at_Creation__c ?? null,
    issue: j.Issue_Description__c ?? null,
    summary: j.Customer_Summary__c ?? null,
    estimateId: j.Estimate__c ?? null,
    estimateTotal: j.Estimate_Total__c ?? null,
    billToType: j.Bill_To_Type__c ?? null,
    paymentStatus: j.Payment_Status__c ?? null,
    createdAt: j.CreatedDate ?? null,
  };
}
export function estimateToView(e) {
  return {
    id: e.Id,
    number: e.Name ?? null,
    status: e.Status__c ?? null,
    version: e.Version__c ?? null,
    customerId: e.Sundial_Customer__c ?? null,
    customerName: e.Customer_Name_at_Creation__c ?? null,
    address: e.Address_at_Creation__c ?? null,
    phone: e.Primary_Phone_at_Creation__c ?? null,
    jobId: e.Service_Job__c ?? null,
    subtotal: e.Subtotal__c ?? null,
    discount: e.Discount_Amount__c ?? null,
    tax: e.Tax_Amount__c ?? null,
    total: e.Total__c ?? null,
    deposit: e.Deposit_Amount__c ?? null,
    sentAt: e.Sent_At__c ?? null,
    approvedAt: e.Approved_At__c ?? null,
    createdAt: e.CreatedDate ?? null,
  };
}
export function customerToView(c) {
  const address = [c.Street__c, [c.City__c, c.State__c].filter(Boolean).join(", "), c.Postal_Code__c].filter(Boolean).join(", ");
  return {
    id: c.Id,
    name: c.Name ?? [c.First_Name__c, c.Last_Name__c].filter(Boolean).join(" ") ?? null,
    firstName: c.First_Name__c ?? null,
    lastName: c.Last_Name__c ?? null,
    address: address || null,
    phone: c.Primary_Phone__c ?? null,
    email: c.Primary_Email__c ?? null,
    projectTypes: c.Requested_Project_Types__c ?? null,
    createdAt: c.CreatedDate ?? null,
  };
}
export function lineToView(l, callId = null) {
  return { id: l.Id, description: l.Description__c ?? null, kind: l.Kind__c ?? null, quantity: l.Quantity__c ?? null, unitPrice: l.Unit_Price__c ?? null, lineTotal: l.Line_Total__c ?? null, stage: l.Stage__c ?? null, addedByThisCall: !!callId && l.Added_By_Service_Call__c === callId };
}

// ---------------------------------------------------------------------------
// Real S3 helpers (injectable through deps: presignPut, listPhotos)
// ---------------------------------------------------------------------------
let s3Client = null;
const s3 = () => (s3Client ??= new S3Client({ region: S3_REGION }));
export async function realPresignPut({ key, contentType }) {
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: contentType }), { expiresIn: PHOTO_URL_EXPIRY_SECONDS });
}
export async function realListPhotos(prefix) {
  const out = [];
  let ContinuationToken;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken }));
    for (const o of page.Contents || []) {
      if (!o.Key || o.Key.endsWith("/")) continue;
      out.push({ key: o.Key, fileName: o.Key.slice(prefix.length), publicUrl: publicUrlForKey(o.Key), size: o.Size ?? null, lastModified: o.LastModified ? o.LastModified.toISOString() : null });
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out.sort((a, b) => String(a.lastModified).localeCompare(String(b.lastModified)));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
/**
 * @param d  the board's dependency bag (sfQuery, sfUpdateRecord, getSupabaseClient,
 *           getSecret, fetchUrl, presignPut, listPhotos, now, env, …)
 * @param h  shared pieces from index.js: CALL_SF_OBJECT, JOB_SF_OBJECT, USER_SF_OBJECT,
 *           CALL_SELECT, DEFAULTS, callToBoard, techName, loadTech, loadJob, loadJobCalls,
 *           settleJobStatus, act, markStale, announce, sms (createSmsSender), CACHE,
 *           jsonResponse, bad, notFound, sfError
 */
export function createTechHandlers(d, h) {
  const { CALL_SF_OBJECT, JOB_SF_OBJECT, CALL_SELECT, DEFAULTS, callToBoard, techName, jsonResponse, bad, notFound, sfError, CACHE } = h;
  const SELECT = `${CALL_SELECT}, ${TECH_CALL_EXTRA}`;
  const geofenceMeters = () => Math.max(25, num(d.env?.SERVICE_GEOFENCE_METERS) ?? 250);
  const shopPoint = () => parseLatLng(d.env?.SERVICE_SHOP_LATLNG);

  // --- reads ---------------------------------------------------------------------
  async function loadTechCall(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(`SELECT ${SELECT} FROM ${CALL_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
    return rows?.[0] ?? null;
  }
  async function loadTechCalls(where, tenantId, order = "Scheduled_Start__c") {
    return (await d.sfQuery(`SELECT ${SELECT} FROM ${CALL_SF_OBJECT} WHERE Client__c = '${soqlEscapeString(tenantId)}' AND ${where} ORDER BY ${order} LIMIT 200`)) || [];
  }
  /** The tech this request acts as: the caller, or (office only) ?techId= / body.techId. */
  async function actingTech(ctx, techId) {
    const wanted = ctx.scope === "tenant" && strOrNull(techId) ? strOrNull(techId) : ctx.userId;
    if (!wanted) return null;
    return h.loadTech(wanted, ctx.tenantId);
  }
  const ownsCall = (ctx, call) => ctx.scope === "tenant" || (!!ctx.userId && call.Tech__c === ctx.userId);

  function callView(c, now) {
    const intervals = parseIntervals(c.Clock_Intervals__c);
    const job = c.Sundial_Service_Job__r || {};
    return {
      ...callToBoard(c),
      issue: job.Issue_Description__c ?? null,
      email: job.Primary_Email_at_Creation__c ?? null,
      estimateId: job.Estimate__c ?? null,
      geocode: job.Geocode_Lat__c != null && job.Geocode_Lon__c != null ? { lat: job.Geocode_Lat__c, lng: job.Geocode_Lon__c, status: job.Geocode_Status__c ?? null } : null,
      geofenceVerified: c.Geofence_Verified__c === true,
      photosCount: num(c.Photos_Count__c) ?? 0,
      clock: clockState(intervals, now),
      intervals: liveIntervals(intervals), // the phone never sees a removed row; the office's GET /clock does
      checklist: checklistFor(c),
    };
  }

  // --- geocode (lazy, Google, best-effort) -------------------------------------------
  async function geocodeJob(job, tenantId) {
    if (!job) return null;
    if (job.Geocode_Lat__c != null && job.Geocode_Lon__c != null && ["Geocoded", "Manual"].includes(job.Geocode_Status__c)) {
      return { lat: job.Geocode_Lat__c, lng: job.Geocode_Lon__c };
    }
    if (job.Geocode_Status__c === "Failed") return null; // the office fixes the address / sets Manual; we do not hammer Google
    const address = strOrNull(job.Address_at_Creation__c);
    if (!address) return null;
    let apiKey = null;
    try {
      apiKey = (await d.getSecret(GOOGLE_SECRET_NAME))?.apiKey || null;
    } catch (e) {
      if (!/ResourceNotFound/i.test(e?.name || e?.message || "")) console.error("geocode secret:", e?.message);
    }
    if (!apiKey) return null;
    let status = null;
    let point = null;
    try {
      const r = await d.fetchUrl(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${encodeURIComponent(apiKey)}`);
      const data = await r.json();
      status = data?.status ?? null;
      const loc = data?.results?.[0]?.geometry?.location;
      if (status === "OK" && loc) point = gpsFrom({ lat: loc.lat, lng: loc.lng });
    } catch (e) {
      console.error("geocode fetch:", e?.message || e);
      return null; // transient — stays Pending, tried again next clock-in
    }
    const fields = point
      ? { Geocode_Lat__c: point.lat, Geocode_Lon__c: point.lng, Geocode_Status__c: "Geocoded" }
      : status === "ZERO_RESULTS"
        ? { Geocode_Status__c: "Failed" }
        : null; // OVER_QUERY_LIMIT / REQUEST_DENIED etc.: leave Pending
    if (fields) {
      try {
        await d.sfUpdateRecord(JOB_SF_OBJECT, job.Id, fields);
        Object.assign(job, fields);
        await h.markStale(CACHE.job, [job.Id], tenantId);
      } catch (e) {
        console.error("geocode write:", e?.sfBody || e?.message || e);
      }
    }
    return point;
  }

  // --- the event time -------------------------------------------------------------
  function resolveAt(v, now, floor) {
    if (v == null || v === "") return { at: now.toISOString() };
    const t = Date.parse(String(v));
    if (!Number.isFinite(t)) return { error: ["AT_INVALID", "at must be an ISO datetime."] };
    if (t > now.getTime() + CLOCK_FUTURE_GRACE_MS) return { error: ["AT_FUTURE", "That time is in the future."] };
    if (t < now.getTime() - CLOCK_MAX_AGE_MS) return { error: ["AT_TOO_OLD", "That time is more than a week ago — ask the office to correct it."] };
    const at = new Date(t).toISOString();
    if (floor && at < floor) return { error: ["AT_OUT_OF_ORDER", `That time is before the last clock event on this call (${floor}).`] };
    return { at };
  }

  /** Close whatever the tech has open on OTHER calls (leaving for the next job). */
  async function closeOtherClocks(ctx, tech, exceptCallId, at, gps) {
    const others = (await loadTechCalls(`Tech__c = '${soqlEscapeString(tech.Id)}' AND Status__c IN ('En Route', 'In Progress')`, ctx.tenantId, "Scheduled_Start__c")).filter((c) => c.Id !== exceptCallId);
    const closed = [];
    for (const c of others) {
      const log = parseIntervals(c.Clock_Intervals__c);
      const open = openIntervalIndex(log);
      const fields = {};
      if (open >= 0) {
        const floor = lastClockTime(log);
        const r = applyClockEvent(log, { kind: "clock_out", at: floor && at < floor ? floor : at, gps });
        Object.assign(fields, clockFields(r.intervals));
        delete fields.Actual_End__c; // not finished — paused; Actual_End is set by Complete
        delete fields.Duration_Minutes__c;
      }
      if (c.Status__c === "En Route") fields.Status__c = "Scheduled"; // never arrived; back on the board as scheduled
      if (!Object.keys(fields).length) continue;
      try {
        await d.sfUpdateRecord(CALL_SF_OBJECT, c.Id, fields);
      } catch (e) {
        console.error("tech: closing other clock failed:", e?.sfBody || e?.message || e);
        continue;
      }
      await h.markStale(CACHE.call, [c.Id], ctx.tenantId);
      await h.act(ctx, { event: EVENTS.SERVICE_CALL_CLOCK, recordType: "servicecall", recordSfId: c.Id, jobSfId: c.Sundial_Service_Job__c ?? null, details: { status: fields.Status__c ?? c.Status__c, at, via: "tech", reason: "left for another call", leftFor: exceptCallId } });
      const after = { ...c, ...fields };
      await h.announce(ctx, { kind: "call", action: "updated", call: callToBoard(after), jobStatus: after.Sundial_Service_Job__r?.Status__c ?? null, via: "tech" });
      closed.push({ id: c.Id, status: after.Status__c });
    }
    return closed;
  }

  // --- handlers ---------------------------------------------------------------------
  return {
    async techDay({ ctx, query }) {
      const { tenantId, cors } = ctx;
      const tech = await actingTech(ctx, query?.techId);
      if (!tech) return jsonResponse(403, cors, { error: "no_user", code: "NO_TECH_USER", message: "Your login is not linked to an active Sundial user." });
      const now = d.now();
      const date = strOrNull(query?.date) ?? localDate(now, DEFAULTS.timeZone);
      const bounds = dayBounds(date, DEFAULTS.timeZone);
      if (!bounds) return bad(cors, "DATE_INVALID", "date must be YYYY-MM-DD.");
      const me = `Tech__c = '${soqlEscapeString(tech.Id)}'`;
      const [day, active, unscheduled] = await Promise.all([
        loadTechCalls(`${me} AND Scheduled_Start__c >= ${h.soqlDateTime(bounds.from)} AND Scheduled_Start__c < ${h.soqlDateTime(bounds.to)}`, tenantId),
        loadTechCalls(`${me} AND Status__c IN ('En Route', 'In Progress')`, tenantId),
        loadTechCalls(`${me} AND Status__c = 'Unscheduled'`, tenantId, "CreatedDate"),
      ]);
      const seen = new Set();
      const calls = [];
      for (const c of [...day, ...active]) {
        if (seen.has(c.Id)) continue;
        seen.add(c.Id);
        calls.push(callView(c, now.toISOString()));
      }
      calls.sort((a, b) => String(a.start ?? "").localeCompare(String(b.start ?? "")));
      const activeCall = calls.find((c) => c.clock.state !== "idle") || null;
      return jsonResponse(200, cors, {
        date,
        timeZone: DEFAULTS.timeZone,
        window: bounds,
        tech: { id: tech.Id, name: techName(tech) },
        calls,
        unscheduled: unscheduled.map((c) => callView(c, now.toISOString())),
        activeCallId: activeCall?.id ?? null,
        serverTime: now.toISOString(),
      });
    },

    async techCall({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const call = await loadTechCall(params[0], tenantId);
      if (!call || !ownsCall(ctx, call)) return notFound(cors);
      const now = d.now().toISOString();
      const jobId = call.Sundial_Service_Job__c;
      const estimateId = call.Sundial_Service_Job__r?.Estimate__c ?? null;
      const [siblings, photos, estimate, lines] = await Promise.all([
        jobId ? h.loadJobCalls(jobId, tenantId) : [],
        jobId ? d.listPhotos(photoPrefix(jobId, call.Id)).catch((e) => (console.error("photos list:", e?.message), [])) : [],
        estimateId
          ? d.sfQuery(`SELECT Id, Name, Status__c, Total__c, Subtotal__c FROM ${ESTIMATE_SF_OBJECT} WHERE Id = '${soqlEscapeString(estimateId)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`).then((r) => r?.[0] ?? null)
          : null,
        estimateId
          ? d.sfQuery(
              `SELECT Id, Description__c, Kind__c, Quantity__c, Unit_Price__c, Line_Total__c, Stage__c, Added_By_Service_Call__c, Sort_Order__c FROM ${LINE_SF_OBJECT} ` +
                `WHERE Estimate__c = '${soqlEscapeString(estimateId)}' AND Client__c = '${soqlEscapeString(tenantId)}' ORDER BY Sort_Order__c LIMIT 200`
            )
          : [],
      ]);
      const otherTechs = (siblings || [])
        .filter((c) => c.Id !== call.Id && c.Status__c !== "Cancelled")
        .map((c) => ({ id: c.Id, techId: c.Tech__c ?? null, techName: c.Tech__r ? techName(c.Tech__r) : null, status: c.Status__c ?? null, start: c.Scheduled_Start__c ?? null, end: c.Scheduled_End__c ?? null, isMe: !!ctx.userId && c.Tech__c === ctx.userId }));
      return jsonResponse(200, cors, {
        call: callView(call, now),
        otherTechs,
        photos: photos || [],
        estimate: estimate
          ? {
              id: estimate.Id,
              number: estimate.Name ?? null,
              status: estimate.Status__c ?? null,
              total: estimate.Total__c ?? null,
              subtotal: estimate.Subtotal__c ?? null,
              lines: (lines || [])
                .filter((l) => l.Stage__c !== "Removed")
                .map((l) => ({ id: l.Id, description: l.Description__c ?? null, kind: l.Kind__c ?? null, quantity: l.Quantity__c ?? null, unitPrice: l.Unit_Price__c ?? null, lineTotal: l.Line_Total__c ?? null, stage: l.Stage__c ?? null, addedByThisCall: l.Added_By_Service_Call__c === call.Id })),
            }
          : null,
        geofenceMeters: geofenceMeters(),
        serverTime: now,
      });
    },

    // --- the status buttons ----------------------------------------------------------
    async techStatus({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const call = await loadTechCall(params[0], tenantId);
      if (!call || !ownsCall(ctx, call)) return notFound(cors);
      const status = body?.status;
      if (!TECH_STATUSES.includes(status)) return bad(cors, "STATUS_INVALID", `status must be one of ${TECH_STATUSES.join(", ")}.`);
      if (call.Status__c === "Cancelled") return jsonResponse(409, cors, { error: "cancelled", code: "CALL_CANCELLED", message: "This call was cancelled by the office." });
      if (call.Status__c === "Unscheduled") return jsonResponse(409, cors, { error: "unscheduled", code: "CALL_NOT_SCHEDULED", message: "The office hasn't put this call on the board yet." });
      const tech = call.Tech__c ? await h.loadTech(call.Tech__c, tenantId) : null;
      if (!tech) return bad(cors, "TECH_REQUIRED", "This call has no technician assigned.");
      const now = d.now();
      const log = parseIntervals(call.Clock_Intervals__c);
      const eventId = strOrNull(body?.eventId);
      if (hasClockEvent(log, eventId)) return jsonResponse(200, cors, { success: true, duplicate: true, call: callView(call, now.toISOString()) });
      const gps = gpsFrom(body?.gps);
      const r = resolveAt(body?.at, now, lastClockTime(log));
      if (r.error) return bad(cors, r.error[0], r.error[1]);
      const at = r.at;
      const job = call.Sundial_Service_Job__c ? await h.loadJob(call.Sundial_Service_Job__c, tenantId) : null;

      const fields = {};
      const extra = {};
      let closedOthers = [];
      let logAfter = log;

      if (status === "En Route") {
        if (!["Scheduled", "En Route", "No-Show"].includes(call.Status__c)) return jsonResponse(409, cors, { error: "state", code: "CALL_STATE", status: call.Status__c, message: `You can't go en route from ${call.Status__c}.` });
        closedOthers = await closeOtherClocks(ctx, tech, call.Id, at, gps);
        const ev = applyClockEvent(log, { kind: "en_route", at, gps, eventId });
        logAfter = ev.intervals;
        if (ev.changed) Object.assign(fields, clockFields(logAfter));
        if (call.Status__c !== "En Route") fields.Status__c = "En Route";
        // The text. Skipped silently when the customer has no mobile; the app shows the outcome.
        if (body?.textCustomer !== false && job) {
          const custom = strOrNull(body?.message);
          const text = custom ? custom.slice(0, MAX_TEXT_CHARS) : onMyWayText({ customerName: job.Customer_Name_at_Creation__c, techFirstName: tech.First_Name__c, brandName: DEFAULTS.brandName || ctx.tenantSlug || "", jobNumber: job.Name });
          const sent = await h.sms.sendText({ tenantId, tenantSlug: ctx.tenantSlug, job, body: text, sentBy: { id: ctx.userId, name: ctx.actor?.name ?? techName(tech) } });
          extra.text = sent.ok ? { sent: true, to: sent.message?.toPretty ?? null } : { sent: false, reason: sent.code, detail: sent.code === "NO_PHONE" ? "No mobile number on this job." : sent.error };
        } else extra.text = { sent: false, reason: body?.textCustomer === false ? "SKIPPED" : "NO_JOB" };
      } else if (status === "In Progress") {
        if (!["Scheduled", "En Route", "In Progress", "Complete", "No-Show"].includes(call.Status__c)) return jsonResponse(409, cors, { error: "state", code: "CALL_STATE", status: call.Status__c });
        closedOthers = await closeOtherClocks(ctx, tech, call.Id, at, gps);
        const ev = applyClockEvent(log, { kind: "clock_in", at, gps, eventId });
        logAfter = ev.intervals;
        if (ev.changed) {
          Object.assign(fields, clockFields(logAfter));
          fields.Actual_End__c = null; // open again (a reopen clears the end; Complete sets it)
          fields.Duration_Minutes__c = null;
        }
        if (call.Status__c !== "In Progress") fields.Status__c = "In Progress";
        // Geofence tag — never a gate.
        if (gps && ev.changed) {
          const points = [{ label: "job", point: await geocodeJob(job, tenantId) }, { label: "shop", point: shopPoint() }];
          const g = geofenceCheck(gps, points, geofenceMeters());
          extra.geofence = g;
          if (g.verified && call.Geofence_Verified__c !== true) fields.Geofence_Verified__c = true;
        } else extra.geofence = { verified: call.Geofence_Verified__c === true, distanceMeters: null, against: null };
      } else if (status === "Complete") {
        if (call.Status__c !== "In Progress") return jsonResponse(409, cors, { error: "state", code: "CALL_NOT_STARTED", status: call.Status__c, message: "Clock in before completing the call." });
        const gate = checklistFor(call);
        if (!gate.complete && !(ctx.scope === "tenant" && body?.override === true)) {
          return jsonResponse(409, cors, { error: "checklist", code: "CHECKLIST_INCOMPLETE", missing: gate.missing, checklist: gate, message: "Finish the checklist before completing the call." });
        }
        const ev = applyClockEvent(log, { kind: "clock_out", at, gps, eventId });
        logAfter = ev.intervals;
        Object.assign(fields, clockFields(logAfter));
        if (!fields.Actual_End__c) fields.Actual_End__c = at; // no open interval (office-started call): the tap is the end
        if (fields.Duration_Minutes__c == null) fields.Duration_Minutes__c = sumMinutes(logAfter);
        fields.Status__c = "Complete";
      } else if (status === "No-Show") {
        if (!["Scheduled", "En Route"].includes(call.Status__c)) return jsonResponse(409, cors, { error: "state", code: "CALL_STATE", status: call.Status__c, message: "No-show only applies before the work starts." });
        const note = strOrNull(body?.note);
        if (!note) return bad(cors, "NOTE_REQUIRED", "Say what happened (a short note) when marking a no-show.");
        const ev = applyClockEvent(log, { kind: "clock_out", at, gps, eventId });
        logAfter = ev.intervals;
        if (ev.changed) {
          Object.assign(fields, clockFields(logAfter));
          delete fields.Actual_End__c;
          delete fields.Duration_Minutes__c;
        }
        fields.Status__c = "No-Show";
        fields.Private_Notes__c = appendStamped(call.Private_Notes__c, { name: ctx.actor?.name ?? techName(tech), at, timeZone: DEFAULTS.timeZone, body: `No-show: ${note.slice(0, MAX_NOTE_CHARS)}` });
      }
      // A note can ride along with any status tap (e.g. "customer not home yet").
      if (status !== "No-Show" && strOrNull(body?.note)) {
        fields.Work_Notes__c = appendStamped(call.Work_Notes__c, { name: ctx.actor?.name ?? techName(tech), at, timeZone: DEFAULTS.timeZone, body: String(body.note).slice(0, MAX_NOTE_CHARS) });
      }
      for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];

      if (Object.keys(fields).length) {
        try {
          await d.sfUpdateRecord(CALL_SF_OBJECT, call.Id, fields);
        } catch (e) {
          return sfError(cors, e, "tech status");
        }
      }
      const after = (await loadTechCall(call.Id, tenantId)) || { ...call, ...fields };
      await h.act(ctx, {
        event: EVENTS.SERVICE_CALL_CLOCK,
        recordType: "servicecall",
        recordSfId: call.Id,
        jobSfId: call.Sundial_Service_Job__c ?? null,
        estimateSfId: job?.Estimate__c ?? null,
        details: { status, from: call.Status__c, at, gps: gps ? { lat: gps.lat, lng: gps.lng } : null, geofence: extra.geofence?.verified ?? null, text: extra.text?.sent ?? null, minutes: fields.Duration_Minutes__c ?? null, via: "tech", eventId },
      });
      await h.markStale(CACHE.call, [call.Id], tenantId);
      let jobStatusChanged = null;
      if (job && fields.Status__c && fields.Status__c !== call.Status__c) {
        const calls = await h.loadJobCalls(job.Id, tenantId);
        if (fields.Status__c === "In Progress") jobStatusChanged = await h.settleJobStatus(ctx, job, call.Status__c === "Complete" ? "reopened" : "in_progress", calls);
        else if (["Complete", "No-Show"].includes(fields.Status__c)) jobStatusChanged = await h.settleJobStatus(ctx, job, "complete", calls);
      }
      const view = callView(after, d.now().toISOString());
      await h.announce(ctx, { kind: "call", action: "updated", call: callToBoard(after), jobStatus: job?.Status__c ?? null, via: "tech" });
      return jsonResponse(200, cors, { success: true, call: view, jobStatus: job?.Status__c ?? null, jobStatusChanged, closedOthers, ...extra });
    },

    // --- the office's time corrections (dispatch board) ---------------------------------
    // The phone appends; the office corrects here. Every edit stamps who / when / why onto the
    // interval; a removed interval stays in the log flagged `removed`. Actual_Start/End and
    // Duration_Minutes are re-derived from the log — never typed in.
    async clockGet({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const call = await loadTechCall(params[0], tenantId);
      if (!call) return notFound(cors);
      const now = d.now().toISOString();
      const log = parseIntervals(call.Clock_Intervals__c);
      return jsonResponse(200, cors, { call: callView(call, now), log: annotateLog(log), timeZone: DEFAULTS.timeZone, serverTime: now });
    },

    async clockCorrect({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const call = await loadTechCall(params[0], tenantId);
      if (!call) return notFound(cors);
      if (call.Status__c === "Cancelled") return jsonResponse(409, cors, { error: "cancelled", code: "CALL_CANCELLED", message: "This call is cancelled." });
      if (call.Status__c === "Unscheduled") return jsonResponse(409, cors, { error: "unscheduled", code: "CALL_NOT_SCHEDULED", message: "Schedule the call before correcting its time." });
      const base = strOrNull(body?.baseModstamp);
      if (base && call.SystemModstamp && base !== call.SystemModstamp) {
        return jsonResponse(409, cors, { error: "conflict", code: "CALL_CONFLICT", message: "This call changed since you loaded it — take another look.", call: callView(call, d.now().toISOString()) });
      }
      const reason = strOrNull(body?.reason);
      if (!reason) return bad(cors, "REASON_REQUIRED", "Say why the time is being corrected.");
      const now = d.now();
      const log = parseIntervals(call.Clock_Intervals__c);
      const r = applyCorrection(log, body?.intervals ?? annotateLog(log).filter((i) => !i.removed), { now: now.toISOString(), by: ctx.actor, reason: reason.slice(0, 255) });
      if (r.error) return bad(cors, r.error[0], r.error[1]);
      const complete = body?.complete === true;
      if (!r.changed && !complete) return jsonResponse(200, cors, { success: true, unchanged: true, call: callView(call, now.toISOString()), log: annotateLog(log) });

      const logAfter = r.intervals;
      const open = openIntervalIndex(logAfter) >= 0;
      let status = call.Status__c;
      if (complete) {
        if (!["Scheduled", "En Route", "In Progress"].includes(call.Status__c)) return jsonResponse(409, cors, { error: "state", code: "CALL_STATE", status: call.Status__c, message: `A ${call.Status__c} call can't be marked complete from here.` });
        if (open) return bad(cors, "STILL_OPEN", "Give the open interval an end time before marking the call complete.");
        if (!liveIntervals(logAfter).length) return bad(cors, "NO_CLOCK", "There is no clocked time on this call — mark it complete from the board's status menu instead.");
        status = "Complete";
      } else if (call.Status__c === "En Route" && !open) {
        status = "Scheduled"; // the drive was closed off without an arrival: back on the board as scheduled
      }
      const fields = r.changed ? clockFields(logAfter) : {};
      if (status !== "Complete") {
        // Not finished: the end and the duration belong to Complete (mirrors the tech's clock-in / pause).
        fields.Actual_End__c = null;
        fields.Duration_Minutes__c = null;
      } else if (!r.changed) {
        Object.assign(fields, clockFields(logAfter));
      }
      if (status !== call.Status__c) fields.Status__c = status;
      try {
        await d.sfUpdateRecord(CALL_SF_OBJECT, call.Id, fields);
      } catch (e) {
        return sfError(cors, e, "clock correction");
      }
      const after = (await loadTechCall(call.Id, tenantId)) || { ...call, ...fields };
      const job = call.Sundial_Service_Job__c ? await h.loadJob(call.Sundial_Service_Job__c, tenantId) : null;
      await h.act(ctx, {
        event: EVENTS.SERVICE_CALL_CLOCK,
        recordType: "servicecall",
        recordSfId: call.Id,
        jobSfId: call.Sundial_Service_Job__c ?? null,
        estimateSfId: job?.Estimate__c ?? null,
        details: {
          via: "dispatch",
          reason,
          corrected: r.changes.corrected.length,
          added: r.changes.added,
          removed: r.changes.removed,
          status,
          from: call.Status__c,
          minutes: fields.Duration_Minutes__c ?? null,
          fields: {
            Actual_Start__c: { from: call.Actual_Start__c ?? null, to: fields.Actual_Start__c ?? call.Actual_Start__c ?? null },
            Actual_End__c: { from: call.Actual_End__c ?? null, to: fields.Actual_End__c ?? null },
            Duration_Minutes__c: { from: call.Duration_Minutes__c ?? null, to: fields.Duration_Minutes__c ?? null },
          },
        },
      });
      await h.markStale(CACHE.call, [call.Id], tenantId);
      let jobStatusChanged = null;
      if (job && status === "Complete" && call.Status__c !== "Complete") {
        jobStatusChanged = await h.settleJobStatus(ctx, job, "complete", await h.loadJobCalls(job.Id, tenantId));
      }
      await h.announce(ctx, { kind: "call", action: "updated", call: callToBoard(after), jobStatus: job?.Status__c ?? null, via: "dispatch" });
      return jsonResponse(200, cors, {
        success: true,
        call: callView(after, d.now().toISOString()),
        log: annotateLog(parseIntervals(after.Clock_Intervals__c)),
        changes: r.changes,
        jobStatusChanged,
        // Labor billing (amendment 6) reads the clock when the office has not typed hours: the
        // job's Labor card needs a re-save for its line to follow this correction.
        laborFromClock: after.Billable_to_Customer__c === true && after.Billable_Hours__c == null,
      });
    },

    // --- notes (append-only, stamped) ---------------------------------------------------
    async techNote({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const call = await loadTechCall(params[0], tenantId);
      if (!call || !ownsCall(ctx, call)) return notFound(cors);
      const text = strOrNull(body?.body);
      if (!text) return bad(cors, "EMPTY_NOTE", "Type a note first.");
      const now = d.now();
      const r = resolveAt(body?.at, now, null);
      if (r.error) return bad(cors, r.error[0], r.error[1]);
      const isPrivate = body?.private === true;
      const api = isPrivate ? "Private_Notes__c" : "Work_Notes__c";
      // Replay guard: the same eventId already stamped → no double entry.
      const eventId = strOrNull(body?.eventId);
      const marker = eventId ? `​${eventId}` : ""; // zero-width — invisible, greppable
      if (marker && String(call[api] ?? "").includes(marker)) return jsonResponse(200, cors, { success: true, duplicate: true, call: callView(call, now.toISOString()) });
      const fields = { [api]: appendStamped(call[api], { name: ctx.actor?.name ?? "Technician", at: r.at, timeZone: DEFAULTS.timeZone, body: text.slice(0, MAX_NOTE_CHARS) + marker }) };
      try {
        await d.sfUpdateRecord(CALL_SF_OBJECT, call.Id, fields);
      } catch (e) {
        return sfError(cors, e, "tech note");
      }
      await h.act(ctx, { event: EVENTS.SERVICE_CALL_NOTE, recordType: "servicecall", recordSfId: call.Id, jobSfId: call.Sundial_Service_Job__c ?? null, details: { private: isPrivate, at: r.at, preview: text.slice(0, 140), via: "tech" } });
      await h.markStale(CACHE.call, [call.Id], tenantId);
      const after = { ...call, ...fields };
      await h.announce(ctx, { kind: "call", action: "updated", call: callToBoard(after), jobStatus: call.Sundial_Service_Job__r?.Status__c ?? null, via: "tech" });
      return jsonResponse(200, cors, { success: true, call: callView(after, now.toISOString()) });
    },

    // --- checklist ----------------------------------------------------------------------
    async techChecklist({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const call = await loadTechCall(params[0], tenantId);
      if (!call || !ownsCall(ctx, call)) return notFound(cors);
      const key = strOrNull(body?.key);
      const item = DEFAULT_CHECKLIST.items.find((i) => i.key === key);
      if (!item) return bad(cors, "ITEM_INVALID", `key must be one of ${DEFAULT_CHECKLIST.items.map((i) => i.key).join(", ")}.`);
      if (item.auto) return bad(cors, "ITEM_AUTOMATIC", `"${item.label}" is checked off by the record itself.`);
      const now = d.now();
      const r = resolveAt(body?.at, now, null);
      if (r.error) return bad(cors, r.error[0], r.error[1]);
      const state = parseChecklistState(call.Checklist_State__c);
      const done = body?.done !== false;
      const next = { ...state, [key]: done ? { done: true, at: r.at, by: ctx.actor?.name ?? null } : { done: false } };
      const fields = { Checklist_State__c: JSON.stringify(next) };
      if (!call.Checklist_Template_Key__c) fields.Checklist_Template_Key__c = DEFAULT_CHECKLIST.key;
      try {
        await d.sfUpdateRecord(CALL_SF_OBJECT, call.Id, fields);
      } catch (e) {
        return sfError(cors, e, "tech checklist");
      }
      await h.markStale(CACHE.call, [call.Id], tenantId);
      const after = { ...call, ...fields };
      return jsonResponse(200, cors, { success: true, checklist: checklistFor(after) });
    },

    // --- photos -----------------------------------------------------------------------
    async techPhotoPresign({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const call = await loadTechCall(params[0], tenantId);
      if (!call || !ownsCall(ctx, call)) return notFound(cors);
      if (!call.Sundial_Service_Job__c) return bad(cors, "NO_JOB", "This call has no job to file photos under.");
      const contentType = strOrNull(body?.contentType);
      if (!contentType || !/^image\//i.test(contentType)) return bad(cors, "NOT_AN_IMAGE", "Only images can be added as photos.");
      const size = num(body?.size);
      if (size !== null && size > PHOTO_MAX_BYTES) return bad(cors, "TOO_LARGE", "Photos are capped at 25 MB.");
      const safe = sanitizeFileName(body?.fileName) || "photo.jpg";
      const stamp = d.now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      const key = `${photoPrefix(call.Sundial_Service_Job__c, call.Id)}${stamp}-${safe}`;
      const uploadUrl = await d.presignPut({ key, contentType });
      return jsonResponse(200, cors, { uploadUrl, key, publicUrl: publicUrlForKey(key), expiresIn: PHOTO_URL_EXPIRY_SECONDS });
    },

    async techPhotoConfirm({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const call = await loadTechCall(params[0], tenantId);
      if (!call || !ownsCall(ctx, call)) return notFound(cors);
      const prefix = photoPrefix(call.Sundial_Service_Job__c, call.Id);
      const key = strOrNull(body?.key);
      if (!key || !key.startsWith(prefix) || key.includes("..")) return bad(cors, "KEY_INVALID", "That key does not belong to this call.");
      const supabase = await d.getSupabaseClient();
      let registered = false;
      try {
        if (!(await findFileMetadataByKey(supabase, key))) {
          await registerFileMetadata(supabase, {
            s3Key: key,
            fileName: key.slice(prefix.length),
            tenantId,
            sfRecordId: call.Sundial_Service_Job__c,
            sfObjectType: "job",
            uploadedByUserId: ctx.userId,
            uploadedByUserName: ctx.actor?.name ?? null,
            fileSizeBytes: num(body?.size),
            mimeType: strOrNull(body?.contentType),
            category: "photo",
            description: strOrNull(body?.caption)?.slice(0, 255) ?? null,
            subfolder: `photos/${call.Id}`,
          });
          registered = true;
        }
      } catch (e) {
        console.error("photo metadata:", e?.message || e);
      }
      let photos = [];
      try {
        photos = await d.listPhotos(prefix);
      } catch (e) {
        console.error("photos list:", e?.message || e);
      }
      const count = photos.length || (num(call.Photos_Count__c) ?? 0) + 1;
      try {
        await d.sfUpdateRecord(CALL_SF_OBJECT, call.Id, { Photos_Count__c: count });
      } catch (e) {
        return sfError(cors, e, "photo count");
      }
      if (registered) {
        await h.act(ctx, { event: EVENTS.SERVICE_CALL_PHOTO, recordType: "servicecall", recordSfId: call.Id, jobSfId: call.Sundial_Service_Job__c ?? null, details: { key, publicUrl: publicUrlForKey(key), caption: strOrNull(body?.caption), count, via: "tech" } });
      }
      await h.markStale(CACHE.call, [call.Id], tenantId);
      const after = { ...call, Photos_Count__c: count };
      return jsonResponse(200, cors, { success: true, photosCount: count, photos, checklist: checklistFor(after) });
    },

    async techPhotos({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const call = await loadTechCall(params[0], tenantId);
      if (!call || !ownsCall(ctx, call)) return notFound(cors);
      const photos = call.Sundial_Service_Job__c ? await d.listPhotos(photoPrefix(call.Sundial_Service_Job__c, call.Id)) : [];
      return jsonResponse(200, cors, { photos, photosCount: num(call.Photos_Count__c) ?? photos.length });
    },

    // --- read-only lists + records (service.tech.read) ----------------------------------
    async techJobs({ ctx, query }) {
      const { tenantId, cors } = ctx;
      const like = likeFor(query?.q);
      const status = strOrNull(query?.status);
      const where =
        `Client__c = '${soqlEscapeString(tenantId)}'` +
        (status ? ` AND Status__c = '${soqlEscapeString(status)}'` : like ? "" : ` AND Status__c NOT IN (${CLOSED_JOB_STATUSES.map((x) => `'${x}'`).join(", ")})`) +
        (like ? ` AND (Name LIKE ${like} OR Customer_Name_at_Creation__c LIKE ${like} OR Address_at_Creation__c LIKE ${like} OR Primary_Phone_at_Creation__c LIKE ${like})` : "");
      const rows = await d.sfQuery(`SELECT ${TECH_JOB_SELECT} FROM ${JOB_SF_OBJECT} WHERE ${where} ORDER BY CreatedDate DESC LIMIT ${LIST_LIMIT}`);
      return jsonResponse(200, cors, { q: strOrNull(query?.q), status, jobs: (rows || []).map(jobToView) });
    },
    async techJob({ ctx, params }) {
      const { tenantId, cors } = ctx;
      if (!SF_ID_RE.test(params[0] || "")) return notFound(cors);
      const rows = await d.sfQuery(`SELECT ${TECH_JOB_SELECT} FROM ${JOB_SF_OBJECT} WHERE Id = '${soqlEscapeString(params[0])}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
      const job = rows?.[0];
      if (!job) return notFound(cors);
      const [calls, estimate, lines] = await Promise.all([
        h.loadJobCalls(job.Id, tenantId),
        job.Estimate__c ? d.sfQuery(`SELECT ${TECH_ESTIMATE_SELECT} FROM ${ESTIMATE_SF_OBJECT} WHERE Id = '${soqlEscapeString(job.Estimate__c)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`).then((r) => r?.[0] ?? null) : null,
        job.Estimate__c
          ? d.sfQuery(`SELECT Id, Description__c, Kind__c, Quantity__c, Unit_Price__c, Line_Total__c, Stage__c, Added_By_Service_Call__c, Sort_Order__c FROM ${LINE_SF_OBJECT} WHERE Estimate__c = '${soqlEscapeString(job.Estimate__c)}' AND Client__c = '${soqlEscapeString(tenantId)}' ORDER BY Sort_Order__c LIMIT 200`)
          : [],
      ]);
      const mine = (c) => !!ctx.userId && c.Tech__c === ctx.userId;
      return jsonResponse(200, cors, {
        job: jobToView(job),
        calls: (calls || []).map((c) => ({ ...callToBoard(c), isMine: mine(c) })),
        estimate: estimate ? { ...estimateToView(estimate), lines: (lines || []).filter((l) => l.Stage__c !== "Removed").map((l) => lineToView(l)) } : null,
      });
    },
    async techEstimates({ ctx, query }) {
      const { tenantId, cors } = ctx;
      const like = likeFor(query?.q);
      const status = strOrNull(query?.status);
      const where =
        `Client__c = '${soqlEscapeString(tenantId)}' AND Is_Template__c = false` +
        (status ? ` AND Status__c = '${soqlEscapeString(status)}'` : "") +
        (like ? ` AND (Name LIKE ${like} OR Customer_Name_at_Creation__c LIKE ${like} OR Address_at_Creation__c LIKE ${like} OR Primary_Phone_at_Creation__c LIKE ${like})` : "");
      const rows = await d.sfQuery(`SELECT ${TECH_ESTIMATE_SELECT} FROM ${ESTIMATE_SF_OBJECT} WHERE ${where} ORDER BY CreatedDate DESC LIMIT ${LIST_LIMIT}`);
      return jsonResponse(200, cors, { q: strOrNull(query?.q), status, estimates: (rows || []).map(estimateToView) });
    },
    async techEstimate({ ctx, params }) {
      const { tenantId, cors } = ctx;
      if (!SF_ID_RE.test(params[0] || "")) return notFound(cors);
      const rows = await d.sfQuery(`SELECT ${TECH_ESTIMATE_SELECT} FROM ${ESTIMATE_SF_OBJECT} WHERE Id = '${soqlEscapeString(params[0])}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
      const est = rows?.[0];
      if (!est || est.Is_Template__c === true) return notFound(cors);
      const lines = await d.sfQuery(`SELECT Id, Description__c, Kind__c, Quantity__c, Unit_Price__c, Line_Total__c, Stage__c, Added_By_Service_Call__c, Sort_Order__c FROM ${LINE_SF_OBJECT} WHERE Estimate__c = '${soqlEscapeString(est.Id)}' AND Client__c = '${soqlEscapeString(tenantId)}' ORDER BY Sort_Order__c LIMIT 200`);
      return jsonResponse(200, cors, { estimate: { ...estimateToView(est), lines: (lines || []).filter((l) => l.Stage__c !== "Removed").map((l) => lineToView(l)) } });
    },
    async techCustomers({ ctx, query }) {
      const { tenantId, cors } = ctx;
      const like = likeFor(query?.q);
      const where =
        `Client__c = '${soqlEscapeString(tenantId)}'` +
        (like ? ` AND (Name LIKE ${like} OR Street__c LIKE ${like} OR Primary_Phone__c LIKE ${like} OR Primary_Email__c LIKE ${like})` : "");
      // Without a search the hub is far too big to page through on a phone: the newest 50.
      const rows = await d.sfQuery(`SELECT ${TECH_CUSTOMER_SELECT} FROM ${CUSTOMER_SF_OBJECT} WHERE ${where} ORDER BY CreatedDate DESC LIMIT ${LIST_LIMIT}`);
      return jsonResponse(200, cors, { q: strOrNull(query?.q), customers: (rows || []).map(customerToView) });
    },
    async techCustomer({ ctx, params }) {
      const { tenantId, cors } = ctx;
      if (!SF_ID_RE.test(params[0] || "")) return notFound(cors);
      const rows = await d.sfQuery(`SELECT ${TECH_CUSTOMER_SELECT} FROM ${CUSTOMER_SF_OBJECT} WHERE Id = '${soqlEscapeString(params[0])}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
      const cust = rows?.[0];
      if (!cust) return notFound(cors);
      const [jobs, estimates] = await Promise.all([
        d.sfQuery(`SELECT ${TECH_JOB_SELECT} FROM ${JOB_SF_OBJECT} WHERE Sundial_Customer__c = '${soqlEscapeString(cust.Id)}' AND Client__c = '${soqlEscapeString(tenantId)}' ORDER BY CreatedDate DESC LIMIT ${LIST_LIMIT}`),
        d.sfQuery(`SELECT ${TECH_ESTIMATE_SELECT} FROM ${ESTIMATE_SF_OBJECT} WHERE Sundial_Customer__c = '${soqlEscapeString(cust.Id)}' AND Client__c = '${soqlEscapeString(tenantId)}' AND Is_Template__c = false ORDER BY CreatedDate DESC LIMIT ${LIST_LIMIT}`),
      ]);
      return jsonResponse(200, cors, { customer: customerToView(cust), jobs: (jobs || []).map(jobToView), estimates: (estimates || []).map(estimateToView) });
    },

    // --- price book search (for "add to estimate") ----------------------------------------
    async techPriceBook({ ctx, query }) {
      const { tenantId, cors } = ctx;
      const q = strOrNull(query?.q);
      const like = q ? `'%${soqlEscapeString(q).replace(/[%_]/g, "")}%'` : null;
      const rows = await d.sfQuery(
        `SELECT Id, Name, Item_Code__c, Kind__c, Category__c, Description__c, Unit_of_Measure__c, Default_Quantity__c, Price__c, Taxable__c FROM ${ITEM_SF_OBJECT} ` +
          `WHERE Client__c = '${soqlEscapeString(tenantId)}' AND Is_Active__c = true` +
          (like ? ` AND (Name LIKE ${like} OR Item_Code__c LIKE ${like} OR Description__c LIKE ${like})` : "") +
          ` ORDER BY Name LIMIT 25`
      );
      return jsonResponse(200, cors, {
        q,
        items: (rows || []).map((r) => ({ id: r.Id, name: r.Name ?? null, code: r.Item_Code__c ?? null, kind: r.Kind__c ?? null, category: r.Category__c ?? null, description: r.Description__c ?? null, unit: r.Unit_of_Measure__c ?? null, defaultQuantity: r.Default_Quantity__c ?? null, price: r.Price__c ?? null, taxable: r.Taxable__c === true })),
      });
    },
  };
}
