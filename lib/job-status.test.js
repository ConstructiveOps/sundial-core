// lib/job-status.js — the job-status rule table (D-072 am. 4 + 2026-10-22) and the
// report-dates → Ready to Bill rule (D-081 am. 3). Pure; no I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JOB_STATUS_ORDER, REPORT_DATE_FIELDS, isBefore, localDay, nextJobStatus, readyToBillFromReportDates } from "./job-status.js";

const TZ = "America/Phoenix";
const call = (Status__c, extra = {}) => ({ Status__c, Scheduled_Start__c: "2026-10-22T16:00:00.000Z", ...extra });

test("Harmon's four transitions, each from the status before it", () => {
  // schedule → Scheduled
  assert.equal(nextJobStatus("Ready to Schedule", "scheduled", [call("Scheduled")]), "Scheduled");
  // unschedule / clear dates → Ready to Schedule (from Scheduled, and now from In Progress)
  assert.equal(nextJobStatus("Scheduled", "unscheduled", [call("Unscheduled")]), "Ready to Schedule");
  assert.equal(nextJobStatus("In Progress", "unscheduled", [call("Unscheduled")]), "Ready to Schedule");
  assert.equal(nextJobStatus("In Progress", "cancelled", [call("Cancelled")]), "Ready to Schedule");
  // day-of → In Progress
  assert.equal(nextJobStatus("Scheduled", "day_of", [call("Scheduled")]), "In Progress");
  // complete (last open call) → Awaiting Office Review
  assert.equal(nextJobStatus("In Progress", "complete", [call("Complete")]), "Awaiting Office Review");
  assert.equal(nextJobStatus("Scheduled", "complete", [call("Complete")]), "Awaiting Office Review");
});

test("nothing moves while an open call remains, and nothing moves backwards", () => {
  assert.equal(nextJobStatus("In Progress", "unscheduled", [call("Unscheduled"), call("Scheduled")]), null);
  assert.equal(nextJobStatus("In Progress", "complete", [call("Complete"), call("Scheduled")]), null);
  assert.equal(nextJobStatus("Invoiced", "unscheduled", []), null);
  assert.equal(nextJobStatus("In Progress", "day_of", [call("Scheduled")]), null);
  assert.equal(nextJobStatus("Paid", "scheduled", [call("Scheduled")]), null);
  // In Progress with work already done: the review is not skipped.
  assert.equal(nextJobStatus("In Progress", "cancelled", [call("Complete"), call("Cancelled")]), "Awaiting Office Review");
});

test("moved: In Progress → Scheduled only when nothing open is left on today AND nobody clocked in", () => {
  const today = "2026-10-22";
  const tomorrow = "2026-10-23T16:00:00.000Z";
  assert.equal(nextJobStatus("In Progress", "moved", [call("Scheduled", { Scheduled_Start__c: tomorrow })], { today, timeZone: TZ }), "Scheduled");
  // still a call today → stays
  assert.equal(nextJobStatus("In Progress", "moved", [call("Scheduled", { Scheduled_Start__c: tomorrow }), call("Scheduled")], { today, timeZone: TZ }), null);
  // a tech clocked in (on any call) → stays In Progress
  assert.equal(nextJobStatus("In Progress", "moved", [call("Scheduled", { Scheduled_Start__c: tomorrow }), call("Complete", { Actual_Start__c: "2026-10-22T15:00:00Z" })], { today, timeZone: TZ }), null);
  assert.equal(nextJobStatus("In Progress", "moved", [call("Scheduled", { Scheduled_Start__c: tomorrow, Actual_Start__c: "2026-10-22T15:00:00Z" })], { today, timeZone: TZ }), null);
  // without a clock reference the rule does nothing
  assert.equal(nextJobStatus("In Progress", "moved", [call("Scheduled", { Scheduled_Start__c: tomorrow })]), null);
});

test("localDay is the tenant's calendar day, not UTC's", () => {
  assert.equal(localDay("2026-10-23T05:00:00Z", TZ), "2026-10-22"); // 10 pm Phoenix
  assert.equal(localDay("2026-10-23T07:00:00Z", TZ), "2026-10-23");
  assert.equal(localDay(null, TZ), null);
});

test("readyToBillFromReportDates: each of the three from Awaiting Office Review → Ready to Bill", () => {
  for (const f of REPORT_DATE_FIELDS) {
    const r = readyToBillFromReportDates({ Status__c: "Awaiting Office Review", [f]: null }, { [f]: "2026-10-22" });
    assert.deepEqual(r, { to: "Ready to Bill", fields: [f] }, f);
  }
  // every status before Ready to Bill moves
  for (const s of JOB_STATUS_ORDER.slice(0, JOB_STATUS_ORDER.indexOf("Ready to Bill"))) {
    assert.equal(readyToBillFromReportDates({ Status__c: s }, { Notes_Reported__c: "2026-10-22" })?.to, "Ready to Bill", s);
  }
});

test("readyToBillFromReportDates: never backwards, clearing does nothing, blank → blank does nothing", () => {
  for (const s of ["Ready to Bill", "Invoiced", "Paid", "Closed"]) {
    assert.equal(readyToBillFromReportDates({ Status__c: s }, { Report_Sent_to_Customer__c: "2026-10-22" }), null, s);
  }
  assert.equal(readyToBillFromReportDates({ Status__c: "Awaiting Office Review", Notes_Reported__c: "2026-10-20" }, { Notes_Reported__c: null }), null);
  assert.equal(readyToBillFromReportDates({ Status__c: "Awaiting Office Review" }, { Notes_Reported__c: null }), null);
  assert.equal(readyToBillFromReportDates({ Status__c: "Awaiting Office Review" }, { Notes_Reported__c: "" }), null);
  // a date that was already set and is changed is not "from blank"
  assert.equal(readyToBillFromReportDates({ Status__c: "Awaiting Office Review", Notes_Reported__c: "2026-10-20" }, { Notes_Reported__c: "2026-10-21" }), null);
  // the office setting Status__c in the same PATCH wins
  assert.equal(readyToBillFromReportDates({ Status__c: "In Progress" }, { Notes_Reported__c: "2026-10-22", Status__c: "Awaiting Parts" }), null);
  // casing of the body's keys is the caller's
  assert.equal(readyToBillFromReportDates({ Status__c: "In Progress" }, { notes_reported__c: "2026-10-22" })?.to, "Ready to Bill");
  assert.equal(isBefore("Mystery", "Ready to Bill"), false);
});
