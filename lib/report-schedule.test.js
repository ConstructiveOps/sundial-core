// node --test lib/report-schedule.test.js — the schedule rules (D-091). Pure.
//
// Pinned: next_run_at for every cadence in ARIZONA time (UTC−7 all year, no DST) — today vs
// tomorrow, strictly after, month ends (31 → the last day), leap years, the year boundary, a
// weekly list wrapping past Sunday, a missed slot never bursts; validation; the recipient rule
// (only active Executive / Admin / Manager of the tenant are users, everyone else is outside);
// the send-time re-check; the words; the download token.

import test from "node:test";
import assert from "node:assert/strict";
import {
  nextRunAt, validateSchedule, classifyRecipients, sendList, isEligibleUser, describeSchedule, scheduleView,
  newDownloadToken, hashToken, isDownloadToken, cleanEmail, clockLabel, MAX_RECIPIENTS,
} from "./report-schedule.js";

const T = "a1W7y000007AszBEAS";
const at = (iso) => new Date(iso);
const az = (d) => new Date(d.getTime() - 7 * 3600_000).toISOString().slice(0, 16).replace("T", " "); // Arizona wall time

test("daily: later today if the slot is still ahead, else tomorrow; strictly after", () => {
  const s = { cadence: "daily", time: "07:00" };
  assert.equal(az(nextRunAt(s, at("2026-11-10T13:59:00Z"))), "2026-11-10 07:00"); // 6:59 AM AZ
  assert.equal(nextRunAt(s, at("2026-11-10T13:59:00Z")).toISOString(), "2026-11-10T14:00:00.000Z");
  assert.equal(az(nextRunAt(s, at("2026-11-10T14:00:00Z"))), "2026-11-11 07:00", "exactly at the slot → the next one");
  // 11:30 PM Arizona on the 10th is already the 11th in UTC; the next 7 AM is the 11th's.
  assert.equal(az(nextRunAt(s, at("2026-11-11T06:30:00Z"))), "2026-11-11 07:00");
  assert.equal(az(nextRunAt({ cadence: "daily", time: "23:45" }, at("2026-11-11T06:30:00Z"))), "2026-11-10 23:45");
});

test("no daylight saving: 7:00 AM Arizona is 14:00 UTC in January and in July, and across the US DST change dates", () => {
  const s = { cadence: "daily", time: "07:00" };
  for (const d of ["2026-01-15", "2026-03-08", "2026-03-09", "2026-07-04", "2026-11-01", "2026-11-02"]) {
    assert.equal(nextRunAt(s, at(`${d}T00:00:00Z`)).getUTCHours(), 14, d);
  }
});

test("weekly: the next listed weekday, wrapping past Sunday", () => {
  const s = { cadence: "weekly", time: "08:30", days: ["mon", "thu"] };
  // Tue Nov 10 2026 → Thu Nov 12
  assert.equal(az(nextRunAt(s, at("2026-11-10T20:00:00Z"))), "2026-11-12 08:30");
  // Fri Nov 13 → Mon Nov 16
  assert.equal(az(nextRunAt(s, at("2026-11-13T20:00:00Z"))), "2026-11-16 08:30");
  // Thu Nov 12 after the slot → Mon Nov 16
  assert.equal(az(nextRunAt(s, at("2026-11-12T16:00:00Z"))), "2026-11-16 08:30");
  // Sunday only, from a Sunday evening → next Sunday
  assert.equal(az(nextRunAt({ cadence: "weekly", time: "06:00", days: ["sun"] }, at("2026-11-15T20:00:00Z"))), "2026-11-22 06:00");
});

test("monthly: the day, or the month's last day when it is shorter; leap years; the year boundary", () => {
  const s31 = { cadence: "monthly", time: "07:00", dayOfMonth: 31 };
  assert.equal(az(nextRunAt(s31, at("2026-11-01T00:00:00Z"))), "2026-11-30 07:00");
  assert.equal(az(nextRunAt(s31, at("2026-12-01T00:00:00Z"))), "2026-12-31 07:00");
  assert.equal(az(nextRunAt(s31, at("2027-01-31T15:00:00Z"))), "2027-02-28 07:00");
  assert.equal(az(nextRunAt(s31, at("2028-02-01T00:00:00Z"))), "2028-02-29 07:00", "leap year");
  const s1 = { cadence: "monthly", time: "00:00", dayOfMonth: 1 };
  assert.equal(az(nextRunAt(s1, at("2026-12-15T00:00:00Z"))), "2027-01-01 00:00");
  assert.equal(nextRunAt(s1, at("2026-12-15T00:00:00Z")).toISOString(), "2027-01-01T07:00:00.000Z");
  const s15 = { cadence: "monthly", time: "07:00", dayOfMonth: 15 };
  assert.equal(az(nextRunAt(s15, at("2026-11-15T13:00:00Z"))), "2026-11-15 07:00");
  assert.equal(az(nextRunAt(s15, at("2026-11-15T14:00:00Z"))), "2026-12-15 07:00");
});

test("a long-missed schedule moves to the next slot after NOW — one send, never a burst", () => {
  const s = { cadence: "daily", time: "07:00" };
  const now = at("2026-11-10T20:00:00Z");
  assert.equal(az(nextRunAt(s, now)), "2026-11-11 07:00");
});

test("validateSchedule: shapes and refusals", () => {
  const ok = validateSchedule({ cadence: "weekly", time: "07:15", days: ["fri", "mon", "fri"], recipients: [{ userId: "a0U000000000000ADM" }, { email: " X@Example.COM " }, { email: "x@example.com" }] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { cadence: "weekly", time: "07:15", days: ["mon", "fri"], format: "csv", enabled: true, recipients: [{ userId: "a0U000000000000ADM" }, { email: "x@example.com" }] });
  const bad = (b) => validateSchedule(b).body?.field;
  const r = [{ email: "a@b.co" }];
  assert.equal(bad(null), "");
  assert.equal(bad({ cadence: "daily", time: "07:00", recipients: r, extra: 1 }), "extra");
  assert.equal(bad({ cadence: "daily", time: "7:00", recipients: r }), "time");
  assert.equal(bad({ cadence: "daily", time: "07:05", recipients: r }), "time");
  assert.equal(bad({ cadence: "daily", time: "24:00", recipients: r }), "time");
  assert.equal(bad({ cadence: "daily", time: "07:00", days: ["mon"], recipients: r }), "days");
  assert.equal(bad({ cadence: "weekly", time: "07:00", days: [], recipients: r }), "days");
  assert.equal(bad({ cadence: "weekly", time: "07:00", days: ["monday"], recipients: r }), "days");
  assert.equal(bad({ cadence: "monthly", time: "07:00", dayOfMonth: 0, recipients: r }), "dayOfMonth");
  assert.equal(bad({ cadence: "monthly", time: "07:00", dayOfMonth: 1.5, recipients: r }), "dayOfMonth");
  assert.equal(bad({ cadence: "daily", time: "07:00", dayOfMonth: 3, recipients: r }), "dayOfMonth");
  assert.equal(bad({ cadence: "daily", time: "07:00", recipients: r, format: "pdf" }), "format");
  assert.equal(bad({ cadence: "daily", time: "07:00", recipients: r, enabled: "yes" }), "enabled");
  assert.equal(bad({ cadence: "daily", time: "07:00", recipients: [{ email: "not an email" }] }), "recipients[0]");
  assert.equal(bad({ cadence: "daily", time: "07:00", recipients: [{ userId: "x" }] }), "recipients[0]");
  assert.equal(bad({ cadence: "daily", time: "07:00", recipients: [{ userId: "a0U000000000000ADM", email: "a@b.co" }] }), "recipients[0]");
  assert.equal(validateSchedule({ cadence: "daily", time: "07:00", recipients: Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => ({ email: `a${i}@b.co` })) }).body.code, "TOO_MANY_RECIPIENTS");
});

const u = (sf_id, access_level, email, extra = {}) => ({ sf_id, client_sf_id: T, first_name: "F", last_name: sf_id.slice(-3), email, active: true, access_level, isdeleted: false, ...extra });

test("eligible = active Executive / Admin / Manager of THIS tenant with an email", () => {
  assert.equal(isEligibleUser(u("a0U000000000000ADM", "Admin", "a@x.co"), T), true);
  assert.equal(isEligibleUser(u("a0U000000000000EXE", "Executive", "e@x.co"), T), true);
  assert.equal(isEligibleUser(u("a0U000000000000MGR", "Manager", "m@x.co"), T), true);
  for (const lvl of ["Sales Rep", "Sales Dealer", "Technician", null]) assert.equal(isEligibleUser(u("a0U000000000000XXX", lvl, "z@x.co"), T), false, String(lvl));
  assert.equal(isEligibleUser(u("a0U000000000000ADM", "Admin", "a@x.co", { active: false }), T), false);
  assert.equal(isEligibleUser(u("a0U000000000000ADM", "Admin", "a@x.co", { isdeleted: true }), T), false);
  assert.equal(isEligibleUser(u("a0U000000000000ADM", "Admin", null), T), false);
  assert.equal(isEligibleUser(u("a0U000000000000ADM", "Admin", "a@x.co"), "a1W7y000008UvsHEAS"), false);
});

test("classifyRecipients: a user id must be eligible; an email that is an eligible user becomes the user; anything else is outside", () => {
  const users = [u("a0U000000000000ADM", "Admin", "Admin@X.co"), u("a0U000000000000MGR", "Manager", "m@x.co")];
  const c = classifyRecipients([{ userId: "a0U000000000000ADM" }, { email: "m@x.co" }, { email: "partner@y.co" }, { userId: "a0U000000000000REP" }, { email: "admin@x.co" }], users);
  assert.deepEqual(c.stored, [{ userId: "a0U000000000000ADM" }, { userId: "a0U000000000000MGR" }, { email: "partner@y.co" }]);
  assert.deepEqual(c.problems, [{ index: 3, code: "USER_NOT_ELIGIBLE" }]);
  assert.equal(c.external, 1);
});

test("sendList: the send-time re-check — current emails, ineligible users and (without the action) outside addresses skipped, repeats once", () => {
  const users = [u("a0U000000000000ADM", "Admin", "new@x.co")];
  const recips = [{ userId: "a0U000000000000ADM" }, { userId: "a0U000000000000GON" }, { email: "partner@y.co" }, { email: "new@x.co" }];
  assert.deepEqual(sendList(recips, users, { canExternal: true }), { to: [{ email: "new@x.co", external: false }, { email: "partner@y.co", external: true }], skipped: 1 });
  assert.deepEqual(sendList(recips, users, { canExternal: false }), { to: [{ email: "new@x.co", external: false }], skipped: 3 });
});

test("words: the summary, the clock, the view hides recipients unless asked", () => {
  assert.equal(clockLabel("00:00"), "12:00 AM");
  assert.equal(clockLabel("12:15"), "12:15 PM");
  assert.equal(clockLabel("23:45"), "11:45 PM");
  assert.equal(describeSchedule({ cadence: "daily", time: "07:00" }), "Daily at 7:00 AM (Arizona time)");
  assert.equal(describeSchedule({ cadence: "weekly", time: "07:00", days: ["mon", "tue", "wed", "thu", "fri"] }), "Weekly on weekdays at 7:00 AM (Arizona time)");
  assert.equal(describeSchedule({ cadence: "monthly", time: "17:30", dayOfMonth: 31 }), "Monthly on day 31 (or the month's last day) at 5:30 PM (Arizona time)");
  const row = { schedule: { cadence: "daily", time: "07:00", recipients: [{ email: "a@b.co" }], enabled: true, format: "csv" }, next_run_at: "x", consecutive_failures: 1 };
  assert.equal(scheduleView(row).recipients, undefined);
  assert.equal(scheduleView(row).recipientCount, 1);
  assert.deepEqual(scheduleView(row, { withRecipients: true }).recipients, [{ email: "a@b.co" }]);
  assert.equal(scheduleView({ ...row, schedule: { ...row.schedule, enabled: false } }).nextRunAt, null);
  assert.equal(scheduleView({ schedule: null }), null);
});

test("download tokens: 43 url-safe characters, random, stored as a SHA-256", () => {
  const a = newDownloadToken();
  const b = newDownloadToken();
  assert.equal(isDownloadToken(a), true);
  assert.notEqual(a, b);
  assert.match(hashToken(a), /^[0-9a-f]{64}$/);
  assert.equal(isDownloadToken("short"), false);
  assert.equal(isDownloadToken(`${a}/`), false);
  assert.equal(cleanEmail(" A@B.Co "), "a@b.co");
  assert.equal(cleanEmail("a@b"), null);
});
