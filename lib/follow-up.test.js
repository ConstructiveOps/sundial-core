// lib/follow-up.js — a new follow-up date sets Follow-up needed (2026-10-22).

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFollowUpFlag } from "./follow-up.js";

test("date set → flag true; date cleared → flag untouched; false sent with a new date → the date wins", () => {
  const set = { Next_Follow_Up_Date__c: "2026-10-30" };
  assert.equal(applyFollowUpFlag({ Next_Follow_Up_Date__c: null }, set), true);
  assert.equal(set.Follow_Up_Needed__c, true);

  const cleared = { Next_Follow_Up_Date__c: null };
  assert.equal(applyFollowUpFlag({ Next_Follow_Up_Date__c: "2026-10-30" }, cleared), false);
  assert.equal("Follow_Up_Needed__c" in cleared, false);

  const both = { next_follow_up_date__c: "2026-11-02", follow_up_needed__c: false };
  assert.equal(applyFollowUpFlag({ Next_Follow_Up_Date__c: "2026-10-30" }, both), true);
  assert.deepEqual(both, { next_follow_up_date__c: "2026-11-02", Follow_Up_Needed__c: true });

  // the same date again is not a change; an unknown before (create) counts as new
  const same = { Next_Follow_Up_Date__c: "2026-10-30", Follow_Up_Needed__c: false };
  assert.equal(applyFollowUpFlag({ Next_Follow_Up_Date__c: "2026-10-30" }, same), false);
  assert.equal(same.Follow_Up_Needed__c, false);
  const created = { Next_Follow_Up_Date__c: "2026-10-30" };
  assert.equal(applyFollowUpFlag(null, created), true);
  // a write that does not name the date does nothing
  const other = { First_Name__c: "Ann" };
  assert.equal(applyFollowUpFlag(null, other), false);
  assert.deepEqual(other, { First_Name__c: "Ann" });
});
