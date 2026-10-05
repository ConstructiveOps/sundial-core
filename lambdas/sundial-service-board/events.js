// lambdas/sundial-service-board/events.js — an event that spans days (Harmon, 2026-10-05).
//
// "PTO Monday through Friday" is ONE ask at the New event popup and FIVE Event calls on the
// board — one per tech per day, each with the same wall-clock window — because a call is one
// tech × one appointment and the board, the phone, the clock and payroll all read calls.
// The expansion is pure and lives here; `createEvent` loops over what it returns.

import { addDays, weekMonday } from "./day.js";
import { dayBounds, localDate, localTimeUtc, tzOffsetMs } from "./tech.js";

export const REPEATS = Object.freeze(["daily", "weekdays", "weekly"]);
/** The most calls one popup may make per tech — three months of weekdays. */
export const MAX_OCCURRENCES = 66;

const dow = (dateStr) => new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0 = Sunday, from the date alone

/**
 * The `{ start, end }` windows an event covers. One window when there is no `untilDate`;
 * otherwise the same local wall-clock window on every matching date from the start's date
 * through `untilDate` (inclusive): every day, weekdays (Mon–Fri) or the same weekday each week.
 * Returns `{ problem }` instead when the ask is invalid.
 */
export function eventOccurrences({ start, end, repeat = null, untilDate = null, timeZone }) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return { problem: "WINDOW_INVALID" };
  if (!untilDate) return { occurrences: [{ start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() }] };
  const pattern = repeat ?? "daily";
  if (!REPEATS.includes(pattern)) return { problem: "REPEAT_INVALID" };
  const firstDate = localDate(new Date(startMs), timeZone);
  const until = dayBounds(untilDate, timeZone) ? String(untilDate) : null;
  if (!until) return { problem: "UNTIL_INVALID" };
  if (until < firstDate) return { problem: "UNTIL_BEFORE_START" };
  // The window's local wall-clock time — rebuilt on each date, so a 7:00 AM event is 7:00 AM
  // every day even across a DST change (the length in hours is kept, not the UTC offset).
  const wallMs = (startMs + tzOffsetMs(new Date(startMs), timeZone)) % 86400000;
  const length = endMs - startMs;
  const firstDow = dow(firstDate);
  const occurrences = [];
  for (let date = firstDate; date <= until; date = addDays(date, pattern === "weekly" ? 7 : 1)) {
    const d = dow(date);
    if (pattern === "weekdays" && (d === 0 || d === 6)) continue;
    if (pattern === "weekly" && d !== firstDow) continue;
    const s = localTimeUtc(date, wallMs, timeZone).getTime();
    occurrences.push({ start: new Date(s).toISOString(), end: new Date(s + length).toISOString() });
    if (occurrences.length > MAX_OCCURRENCES) return { problem: "TOO_MANY" };
  }
  if (!occurrences.length) return { problem: "NO_DATES" };
  return { occurrences };
}

export { weekMonday };
