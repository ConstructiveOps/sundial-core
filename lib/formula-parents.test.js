// Tests for lib/formula-parents.js — deriving the parent relationships whose change can
// move a cached cross-object formula column (D-079).
//
// Run with:  npm test
//
// The fixtures mirror the real cases found 2026-10-05: the job's Estimate_*__c columns
// (Estimate__r.*) and customer/solar Sales_Rep_Name__c (Sales_Rep__r.Name).

import test from "node:test";
import assert from "node:assert/strict";
import { parentModstampPaths, dottedReferences, incrementalWhere, readPath } from "./formula-parents.js";

const JOB_FIELDS = [
  { name: "Id", type: "id" },
  { name: "Estimate__c", type: "reference", relationshipName: "Estimate__r", referenceTo: ["Sundial_Estimate__c"] },
  { name: "Customer__c", type: "reference", relationshipName: "Customer__r", referenceTo: ["Sundial_Customer__c"] },
  { name: "OwnerId", type: "reference", relationshipName: "Owner", referenceTo: ["User", "Group"] },
  { name: "Estimate_Total__c", type: "currency", calculated: true, calculatedFormula: "Estimate__r.Total__c" },
  { name: "Estimate_Status__c", type: "string", calculated: true, calculatedFormula: 'TEXT(estimate__r.Status__c)' },
  { name: "Customer_City__c", type: "string", calculated: true, calculatedFormula: "Estimate__r.Customer__r.City__c" },
  { name: "Balance__c", type: "currency", calculated: true, calculatedFormula: "Total__c - Paid_Amount__c" },
  { name: "Age_Days__c", type: "double", calculated: true, calculatedFormula: "TODAY() - DATEVALUE(CreatedDate)" },
  { name: "Owner_Name__c", type: "string", calculated: true, calculatedFormula: "Owner:User.Name" },
  { name: "Owner_Alias__c", type: "string", calculated: true, calculatedFormula: "Owner.Alias" },
  { name: "Who__c", type: "string", calculated: true, calculatedFormula: "$User.FirstName" },
  { name: "Label__c", type: "string", calculated: true, calculatedFormula: 'IF(Total__c > 1.5, "a.b", "c")' },
  { name: "Uncached_Formula__c", type: "string", calculated: true, calculatedFormula: "Customer__r.Name" },
  { name: "Rollup__c", type: "currency", calculated: true, calculatedFormula: null },
];
const ESTIMATE_FIELDS = [
  { name: "Customer__c", type: "reference", relationshipName: "Customer__r", referenceTo: ["Sundial_Customer__c"] },
];
const describe = async (name) => ({ Sundial_Estimate__c: { fields: ESTIMATE_FIELDS }, Sundial_Customer__c: { fields: [] } })[name];

const CACHED = new Set([
  "Estimate_Total__c", "Estimate_Status__c", "Customer_City__c", "Balance__c", "Age_Days__c",
  "Owner_Alias__c", "Who__c", "Label__c", "Rollup__c",
]);

test("job: the estimate (and, through it, the customer) are the formula parents", async () => {
  const r = await parentModstampPaths({ sfObject: "Sundial_Service_Job__c", fields: JOB_FIELDS, isCached: (f) => CACHED.has(f.name), describe });
  assert.deepEqual(r.paths, ["Estimate__r", "Estimate__r.Customer__r"]);
  const byField = Object.fromEntries(r.covered.map((c) => [c.field, c.paths]));
  assert.deepEqual(byField.Estimate_Total__c, ["Estimate__r"]);
  assert.deepEqual(byField.Estimate_Status__c, ["Estimate__r"], "formula casing is canonicalised from the describe");
  assert.deepEqual(byField.Customer_City__c, ["Estimate__r", "Estimate__r.Customer__r"], "every hop of a multi-hop reference");
});

test("same-record formulas, roll-ups and string literals add nothing", async () => {
  const r = await parentModstampPaths({ sfObject: "Sundial_Service_Job__c", fields: JOB_FIELDS, isCached: (f) => CACHED.has(f.name), describe });
  const names = [...r.covered.map((c) => c.field), ...r.uncoverable.map((u) => u.field)];
  for (const f of ["Balance__c", "Rollup__c", "Label__c"]) assert.ok(!names.includes(f), `${f} needs no parent`);
});

test("uncoverable columns are REPORTED, not silently dropped", async () => {
  const r = await parentModstampPaths({ sfObject: "Sundial_Service_Job__c", fields: JOB_FIELDS, isCached: (f) => CACHED.has(f.name), describe });
  const reasons = Object.fromEntries(r.uncoverable.map((u) => [u.field, u.reason]));
  assert.match(reasons.Age_Days__c, /time-dependent/);
  assert.match(reasons.Who__c, /\$ global/);
  assert.match(reasons.Owner_Alias__c, /polymorphic/);
});

test("a formula column that is not cached is ignored", async () => {
  const r = await parentModstampPaths({ sfObject: "Sundial_Service_Job__c", fields: JOB_FIELDS, isCached: (f) => CACHED.has(f.name), describe });
  assert.ok(!r.paths.includes("Customer__r"), "Uncached_Formula__c (Customer__r.Name) is not a cache column");
});

test("an unresolvable relationship is uncoverable (the sync would otherwise send bad SOQL)", async () => {
  const fields = [{ name: "X__c", type: "string", calculated: true, calculatedFormula: "Nope__r.Name" }];
  const r = await parentModstampPaths({ sfObject: "O", fields, isCached: () => true, describe });
  assert.deepEqual(r.paths, []);
  assert.match(r.uncoverable[0].reason, /does not resolve/);
});

test("customer: Sales_Rep__r.Name", async () => {
  const fields = [
    { name: "Sales_Rep__c", type: "reference", relationshipName: "Sales_Rep__r", referenceTo: ["Sundial_User__c"] },
    { name: "Sales_Rep_Name__c", type: "string", calculated: true, calculatedFormula: "Sales_Rep__r.Name" },
  ];
  const r = await parentModstampPaths({ sfObject: "Sundial_Customer__c", fields, isCached: () => true, describe });
  assert.deepEqual(r.paths, ["Sales_Rep__r"]);
});

test("dottedReferences ignores numbers and quoted text", () => {
  assert.deepEqual(dottedReferences('IF(A__r.B__c > 1.5, "x.y", Z__c)'), ["A__r.B__c"]);
});

test("incrementalWhere: plain without parents, an OR group with them", () => {
  const wm = "2026-10-05T00:00:00.000Z";
  assert.equal(incrementalWhere(wm), `SystemModstamp > ${wm}`);
  assert.equal(
    incrementalWhere(wm, ["Estimate__r", "Estimate__r.Customer__r"]),
    `(SystemModstamp > ${wm} OR Estimate__r.SystemModstamp > ${wm} OR Estimate__r.Customer__r.SystemModstamp > ${wm})`
  );
});

test("readPath walks nested relationships and tolerates a null hop", () => {
  const rec = { Estimate__r: { SystemModstamp: "t1", Customer__r: null } };
  assert.equal(readPath(rec, "Estimate__r.SystemModstamp"), "t1");
  assert.equal(readPath(rec, "Estimate__r.Customer__r.SystemModstamp"), undefined);
});
