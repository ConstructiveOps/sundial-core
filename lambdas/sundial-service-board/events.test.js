// events.js — one popup, one call per tech per day (2026-10-05).
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventOccurrences, MAX_OCCURRENCES } from "./events.js";

const TZ = "America/Phoenix"; // 7 AM Phoenix = 14:00Z all year (no DST)
const base = { start: "2026-10-12T14:00:00Z", end: "2026-10-12T22:00:00Z", timeZone: TZ }; // Monday 7–3

test("no through date → the one window as given", () => {
  assert.deepEqual(eventOccurrences(base), { occurrences: [{ start: "2026-10-12T14:00:00.000Z", end: "2026-10-12T22:00:00.000Z" }] });
});

test("PTO Mon–Fri as one ask: weekdays through Friday = five days, same wall-clock window; daily keeps the weekend; weekly = the same weekday", () => {
  const wk = eventOccurrences({ ...base, untilDate: "2026-10-16", repeat: "weekdays" }).occurrences;
  assert.deepEqual(wk.map((o) => o.start.slice(0, 13)), ["2026-10-12T14", "2026-10-13T14", "2026-10-14T14", "2026-10-15T14", "2026-10-16T14"]);
  assert.ok(wk.every((o) => Date.parse(o.end) - Date.parse(o.start) === 8 * 3600e3));
  // through the next Monday, weekdays: Sat/Sun skipped → 6
  assert.equal(eventOccurrences({ ...base, untilDate: "2026-10-19", repeat: "weekdays" }).occurrences.length, 6);
  assert.equal(eventOccurrences({ ...base, untilDate: "2026-10-19", repeat: "daily" }).occurrences.length, 8);
  assert.equal(eventOccurrences({ ...base, untilDate: "2026-10-19" }).occurrences.length, 8, "daily is the default pattern");
  assert.deepEqual(eventOccurrences({ ...base, untilDate: "2026-11-02", repeat: "weekly" }).occurrences.map((o) => o.start.slice(0, 10)), ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]);
});

test("the wall-clock time survives a DST change in a zone that has one", () => {
  // 9 AM New York on Fri 2026-10-30 (EDT, 13:00Z) through Mon 11-02 (EST, 14:00Z)
  const r = eventOccurrences({ start: "2026-10-30T13:00:00Z", end: "2026-10-30T14:00:00Z", untilDate: "2026-11-02", repeat: "daily", timeZone: "America/New_York" });
  assert.deepEqual(r.occurrences.map((o) => o.start), ["2026-10-30T13:00:00.000Z", "2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z", "2026-11-02T14:00:00.000Z"]);
});

test("problems: bad window, bad pattern, bad / early through date, nothing matching, too many", () => {
  assert.equal(eventOccurrences({ ...base, end: base.start }).problem, "WINDOW_INVALID");
  assert.equal(eventOccurrences({ ...base, untilDate: "2026-10-16", repeat: "fortnightly" }).problem, "REPEAT_INVALID");
  assert.equal(eventOccurrences({ ...base, untilDate: "next friday" }).problem, "UNTIL_INVALID");
  assert.equal(eventOccurrences({ ...base, untilDate: "2026-10-11" }).problem, "UNTIL_BEFORE_START");
  // a Saturday start, weekdays, through Sunday → no day matches
  assert.equal(eventOccurrences({ start: "2026-10-17T14:00:00Z", end: "2026-10-17T15:00:00Z", untilDate: "2026-10-18", repeat: "weekdays", timeZone: TZ }).problem, "NO_DATES");
  assert.equal(eventOccurrences({ ...base, untilDate: "2027-10-12", repeat: "daily" }).problem, "TOO_MANY");
  assert.equal(eventOccurrences({ ...base, untilDate: "2027-01-08", repeat: "weekdays" }).occurrences.length, 65, "13 weeks of weekdays fits under the cap");
  assert.ok(65 <= MAX_OCCURRENCES);
});

// tech.js searchWhere (2026-10-07): the phone's lists search by every word, and by phone digits.
import { searchWhere } from "./tech.js";
test("searchWhere: every word in some field; a phone number also matches by digits; nothing without a term", () => {
  const f = ["Name", "Street__c", "Primary_Phone__c"];
  assert.equal(searchWhere("", f), null);
  assert.equal(searchWhere("Ann", f), "((Name LIKE '%Ann%' OR Street__c LIKE '%Ann%' OR Primary_Phone__c LIKE '%Ann%'))");
  assert.equal(searchWhere("123 Main", f), "(((Name LIKE '%123%' OR Street__c LIKE '%123%' OR Primary_Phone__c LIKE '%123%') AND (Name LIKE '%Main%' OR Street__c LIKE '%Main%' OR Primary_Phone__c LIKE '%Main%')))");
  assert.ok(searchWhere("(602) 555-0100", f).endsWith(" OR Primary_Phone__c LIKE '%602%555%0100%')"));
  assert.ok(searchWhere("6025550100", f).includes("Primary_Phone__c LIKE '%602%555%0100%'"));
  assert.ok(!searchWhere("O'Brien % _", f).includes("%'%"), "SOQL-escaped, wildcards neutralised");
});
