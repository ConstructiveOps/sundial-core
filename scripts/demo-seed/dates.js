// dates.js — calendar maths for the demo, always in America/Phoenix.
//
// WHY A FIXED OFFSET: Arizona does not observe daylight saving, so Phoenix is UTC-7 all
// year (lib/hcp-import.js relies on the same fact). Doing the arithmetic with a fixed
// offset keeps the plan pure and independent of the machine's own timezone — the owner
// runs this on a Windows PC, the tests run in a Linux sandbox set to UTC.

export const PHOENIX_TZ = "America/Phoenix";
export const PHOENIX_OFFSET_HOURS = -7;
const DAY_MS = 86400000;

const pad = (n) => String(n).padStart(2, "0");

/** YYYY-MM-DD + n days (pure calendar maths). */
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}
export const isWeekday = (dateStr) => {
  const d = dayOfWeek(dateStr);
  return d >= 1 && d <= 5;
};

/** Minutes after local midnight in Phoenix -> the UTC instant, as an ISO string. */
export function phxAt(dateStr, minutesAfterMidnight) {
  const ms = Date.parse(`${dateStr}T00:00:00Z`) - PHOENIX_OFFSET_HOURS * 3600000 + minutesAfterMidnight * 60000;
  return new Date(ms).toISOString();
}
/** "HH:MM" local Phoenix time on a date -> ISO UTC. */
export function phxTime(dateStr, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return phxAt(dateStr, h * 60 + m);
}

/** The Phoenix calendar date of an instant. */
export function phxDateOf(iso) {
  const ms = (iso instanceof Date ? iso.getTime() : Date.parse(iso)) + PHOENIX_OFFSET_HOURS * 3600000;
  return new Date(ms).toISOString().slice(0, 10);
}
/** Minutes after local midnight (Phoenix) of an instant. */
export function phxMinutesOf(iso) {
  const ms = (iso instanceof Date ? iso.getTime() : Date.parse(iso)) + PHOENIX_OFFSET_HOURS * 3600000;
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function addMinutes(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60000).toISOString();
}
export function minutesBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60000);
}

/** "Sep 18, 2026" — the way notes and summaries write a day. */
export function prettyDate(dateStr) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${months[m - 1]} ${d}, ${y}`;
}

/** The previous weekday on or before a date (projects do not reach milestones on Sundays). */
export function onWeekday(dateStr) {
  let d = dateStr;
  while (!isWeekday(d)) d = addDays(d, -1);
  return d;
}

/** A date plus n WORKING days (n may be negative). */
export function addWorkdays(dateStr, n) {
  let d = dateStr;
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    d = addDays(d, step);
    if (isWeekday(d)) left--;
  }
  return d;
}

export const isIsoDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
export const isIsoDateTime = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(v);
export { pad };
