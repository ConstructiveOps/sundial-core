// GET /sf/users row shape (2026-10-23): `staff` is a boolean derived from
// Access_Level__c, and the level name itself never leaves the Lambda — sales roles call
// this route and must not learn who is an Admin. No module mocks — runs anywhere
// (`node --test lambdas/sundial-sf-query/users.test.js`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { toUserRow, STAFF_ACCESS_LEVELS } from "./index.js";
import { TENANT_ACCESS_LEVELS } from "../../lib/access.js";

const rec = (level, extra = {}) => ({
  Id: "a1O000000000001AAA",
  First_Name__c: "Pat",
  Last_Name__c: "Lee",
  Email__c: "pat@example.com",
  Supabase_User_Id__c: "8f3c-uuid",
  Access_Level__c: level,
  ...extra,
});

test("Executive, Admin, Manager and Technician are staff", () => {
  for (const level of ["Executive", "Admin", "Manager", "Technician"]) {
    assert.equal(toUserRow(rec(level)).staff, true, level);
  }
});

test("sales roles, a blank level and an unknown level are not staff", () => {
  for (const level of ["Sales Dealer", "Sales Rep", null, undefined, "", "admin", "Executive Assistant"]) {
    assert.equal(toUserRow(rec(level)).staff, false, String(level));
  }
});

test("the staff list is the tenant levels plus Technician — no second hand-kept list", () => {
  assert.deepEqual(STAFF_ACCESS_LEVELS, [...TENANT_ACCESS_LEVELS, "Technician"]);
});

test("the row is exactly id, name, supabaseUserId, staff — the level name is never returned", () => {
  const row = toUserRow(rec("Admin"));
  assert.deepEqual(row, { id: "a1O000000000001AAA", name: "Pat Lee", supabaseUserId: "8f3c-uuid", staff: true });
  assert.ok(!JSON.stringify(row).includes("Admin"));
});

test("name falls back to Email, then Id; a missing Supabase id is null", () => {
  assert.equal(toUserRow(rec("Sales Rep", { First_Name__c: null, Last_Name__c: null })).name, "pat@example.com");
  const bare = toUserRow({ Id: "a1O000000000002AAA" });
  assert.deepEqual(bare, { id: "a1O000000000002AAA", name: "a1O000000000002AAA", supabaseUserId: null, staff: false });
});
