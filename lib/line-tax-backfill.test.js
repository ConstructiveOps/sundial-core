// lib/line-tax-backfill.test.js — the decision table behind scripts/backfill-line-tax-categories.mjs
// (2026-10-16: restore the pre-D-083 tax), and the invoiced-estimate snapshot rule.
//
// Run: node --test lib/line-tax-backfill.test.js   (also in `npm test`)

import test from "node:test";
import assert from "node:assert/strict";
import { lineCategoryDecision, isZzName, planLineBackfill, planItemBackfill, planTaxedLineBackfill, TAXED_PASS_STATUSES, chunk } from "./line-tax-backfill.js";
import { computeTotals, withStoredTotals, showsStoredTotals, STORED_TOTAL_STATUSES } from "../lambdas/sundial-service-estimate/totals.js";

test("decision table: only an UNTAXED blank material becomes SOLAR", () => {
  const cases = [
    // kind, taxable, category → write
    ["Material", false, null, "SOLAR"],
    ["Material", null, null, "SOLAR"], // blank flag = untaxed
    ["Material", undefined, "", "SOLAR"],
    ["Product", false, null, "SOLAR"],
    ["Material", true, null, null], // was taxed: the RETAIL default is what Harmon charged
    ["Product", true, null, null],
    ["Labor", false, null, null], // LABSERV default, already untaxed
    ["Labor", true, null, null], // labor is never written
    ["Fee", false, null, null],
    [null, false, null, null], // no kind = labor's default
    ["Material", false, "SOLAR", null], // explicit: left
    ["Material", false, "RETAIL", null],
    ["Material", true, "WARRANTY", null],
    ["Material", false, "retail", null], // validTaxCategory is case-blind
    ["Material", false, "BOGUS", null], // unknown value: left for a person, never overwritten
  ];
  for (const [kind, taxable, taxCategory, want] of cases) {
    assert.equal(lineCategoryDecision({ kind, taxable, taxCategory }).write, want, JSON.stringify({ kind, taxable, taxCategory }));
  }
});

test("ZZ test records are recognised by either name", () => {
  assert.equal(isZzName("ZZ PORTAL TEST — DO NOT USE"), true);
  assert.equal(isZzName(null, "ZZZ Test Test Customer"), true);
  assert.equal(isZzName("zz lower"), true);
  assert.equal(isZzName("Lizzy Smith", "Buzz Co"), false);
  assert.equal(isZzName(null, undefined), false);
});

test("planLineBackfill: every estimate status is covered; ZZ records and archived jobs are never touched", () => {
  const est = (Status__c, extra = {}) => ({ Name: `EST-${Status__c}`, Status__c, Customer_Name_at_Creation__c: "Jane Doe", Sundial_Customer__r: { Name: "Jane Doe" }, Service_Job__r: { Archived__c: false }, ...extra });
  const L = (Id, Kind__c, Taxable__c, Estimate__r) => ({ Id, Kind__c, Taxable__c, Tax_Category__c: null, Description__c: Id, Estimate__r });
  const plan = planLineBackfill([
    L("draft", "Material", false, est("Draft")),
    L("sent", "Material", false, est("Sent")),
    L("viewed", "Material", null, est("Viewed")),
    L("approved", "Material", false, est("Approved")),
    L("invoiced", "Material", false, est("Invoiced")),
    L("taxed", "Material", true, est("Approved")),
    L("labor", "Labor", true, est("Approved")),
    L("nojob", "Material", false, { ...est("Draft"), Service_Job__r: null }),
    L("zz", "Material", false, est("Draft", { Customer_Name_at_Creation__c: "ZZ PORTAL TEST — DO NOT USE" })),
    L("zzz", "Material", false, est("Sent", { Sundial_Customer__r: { Name: "ZZZ Test Test Customer" } })),
    L("archived", "Material", false, est("Invoiced", { Service_Job__r: { Archived__c: true } })),
  ]);
  assert.deepEqual(plan.writes.map((w) => w.Id), ["draft", "sent", "viewed", "approved", "invoiced", "nojob"]);
  assert.ok(plan.writes.every((w) => w.Tax_Category__c === "SOLAR" && Object.keys(w).length === 2), "only Tax_Category__c is written");
  assert.deepEqual(plan.skipped, { zz: 2, archivedJob: 1 });
  assert.deepEqual(plan.byStatus.Approved, { write: 1, leave: 2 });
  assert.deepEqual(plan.byStatus.Invoiced, { write: 1, leave: 0 });
  assert.equal(plan.leave["material, was taxed (RETAIL default)"], 1);
  assert.equal(plan.leave["labor / fee default (LABSERV, untaxed)"], 1);
});

test("planItemBackfill: untaxed material items of every version → SOLAR; taxed, labor and ZZ items left", () => {
  const plan = planItemBackfill([
    { Id: "a", Name: "Fuse", Item_Code__c: "FUSE", Kind__c: "Material", Taxable__c: false, Tax_Category__c: null, Is_Active__c: true },
    { Id: "b", Name: "Fuse", Item_Code__c: "FUSE", Kind__c: "Material", Taxable__c: false, Tax_Category__c: null, Is_Active__c: false },
    { Id: "c", Name: "Outlet", Item_Code__c: "OUT", Kind__c: "Material", Taxable__c: true, Tax_Category__c: null, Is_Active__c: true },
    { Id: "d", Name: "Trip charge", Item_Code__c: "TRIP", Kind__c: "Fee", Taxable__c: false, Tax_Category__c: null, Is_Active__c: true },
    { Id: "e", Name: "ZZ test part", Item_Code__c: "ZZ-1", Kind__c: "Material", Taxable__c: false, Tax_Category__c: null, Is_Active__c: true },
  ]);
  assert.deepEqual(plan.writes, [{ Id: "a", Tax_Category__c: "SOLAR" }, { Id: "b", Tax_Category__c: "SOLAR" }]);
  assert.equal(plan.skipped.zz, 1);
});

test("chunk splits into the collection API's 200", () => {
  const list = Array.from({ length: 450 }, (_, i) => i);
  assert.deepEqual(chunk(list).map((c) => c.length), [200, 200, 50]);
  assert.deepEqual(chunk([]), []);
});

test("withStoredTotals: an INVOICED estimate shows its stored money, never today's recomputation", () => {
  const lines = [{ id: "l1", kind: "Material", quantity: 1, unitPrice: 100, taxCategory: null, stage: "Approved" }];
  const ctx = { categoryRates: { RETAIL: 8.6, LABSERV: 0 }, billToType: null };
  // Recomputed today, the blank material is RETAIL: $8.60 of tax.
  const live = computeTotals(lines, ctx);
  assert.equal(live.taxAmount, 8.6);
  // Invoiced before D-083 with no tax: the stored snapshot wins, fields and figures alike.
  const stored = { Status__c: "Invoiced", Subtotal__c: 100, Tax_Amount__c: 0, Total__c: 100, Discount_Amount__c: 0 };
  const pinned = withStoredTotals(computeTotals(lines, ctx), stored);
  assert.equal(pinned.taxAmount, 0);
  assert.equal(pinned.total, 100);
  assert.equal(pinned.fields.Tax_Amount__c, 0);
  assert.equal(pinned.fields.Total__c, 100);
  assert.equal(pinned.frozen, true);
  assert.equal(pinned.lineTotals.length, 1, "the line rows still come from the lines");
  // An invoiced estimate with nothing stored: the live computation.
  assert.equal(withStoredTotals(computeTotals(lines, ctx), { Status__c: "Invoiced", Total__c: null }).taxAmount, 8.6);
});

test("the status gate: Sent / Viewed / Approved / Invoiced show their stored totals; Draft / Declined / Expired / a template compute live", () => {
  const lines = [{ id: "l1", kind: "Material", quantity: 1, unitPrice: 100, taxCategory: null, stage: "Approved" }];
  const ctx = { categoryRates: { RETAIL: 8.6, LABSERV: 0 }, billToType: null };
  const stored = { Subtotal__c: 100, Tax_Amount__c: 0, Total__c: 100 };
  const shown = (Status__c, extra = {}) => withStoredTotals(computeTotals(lines, ctx), { ...stored, Status__c, ...extra });
  for (const st of ["Sent", "Viewed", "Approved", "Invoiced"]) {
    assert.equal(showsStoredTotals({ ...stored, Status__c: st }), true, st);
    assert.equal(shown(st).taxAmount, 0, st + ": the stored tax");
    assert.equal(shown(st).total, 100, st);
  }
  for (const st of ["Draft", "Declined", "Expired", "Template", undefined]) {
    assert.equal(showsStoredTotals({ ...stored, Status__c: st }), false, String(st));
    assert.equal(shown(st).taxAmount, 8.6, String(st) + ": live");
  }
  assert.equal(shown("Approved", { Is_Template__c: true }).taxAmount, 8.6, "a template is never pinned");
  assert.equal(shown("Approved", { Total__c: null }).taxAmount, 8.6, "nothing stored: live");
  assert.equal(shown("Approved", { Tax_Amount__c: 25.5, Total__c: 125.5 }).taxAmount, 25.5, "a stored tax > 0 is shown as stored too");
  assert.deepEqual(STORED_TOTAL_STATUSES, ["Sent", "Viewed", "Approved", "Invoiced"]);
});

test("--taxed-lines: a ticked blank material → SOLAR when the estimate stored no tax; kept (and listed) when it stored some; Invoiced, ZZ, archived never", () => {
  const est = (Id, Status__c, Tax_Amount__c, extra = {}) => ({ Id, Name: Id, Status__c, Tax_Amount__c, Customer_Name_at_Creation__c: "Jane Doe", Sundial_Customer__r: { Name: "Jane Doe" }, Service_Job__r: { Archived__c: false }, ...extra });
  const L = (Id, Estimate__r, over = {}) => ({ Id, Kind__c: "Material", Taxable__c: true, Tax_Category__c: null, Description__c: Id, Estimate__r, ...over });
  const zeroTax = est("EST-1", "Approved", 0);
  const nullTax = est("EST-2", "Draft", null);
  const typed = est("EST-3", "Approved", 41.28);
  const plan = planTaxedLineBackfill([
    L("a", zeroTax),
    L("b", zeroTax),
    L("c", nullTax),
    L("d", est("EST-4", "Sent", 0)),
    L("e", est("EST-5", "Viewed", 0)),
    L("f", est("EST-6", "Declined", 0)),
    L("g", est("EST-7", "Expired", 0)),
    L("k1", typed),
    L("k2", typed),
    L("inv", est("EST-8", "Invoiced", 0)),
    L("zz", est("EST-9", "Draft", 0, { Customer_Name_at_Creation__c: "ZZ PORTAL TEST — DO NOT USE" })),
    L("arch", est("EST-10", "Approved", 0, { Service_Job__r: { Archived__c: true } })),
    L("archTaxed", est("EST-11", "Approved", 319.25, { Service_Job__r: { Archived__c: true } })),
    L("unticked", zeroTax, { Taxable__c: false }), // the first pass's job, not this one
    L("labor", zeroTax, { Kind__c: "Labor" }),
    L("explicit", zeroTax, { Tax_Category__c: "RETAIL" }),
  ]);
  assert.deepEqual(plan.writes.map((w) => w.Id), ["a", "b", "c", "d", "e", "f", "g"]);
  assert.ok(plan.writes.every((w) => w.Tax_Category__c === "SOLAR"));
  assert.deepEqual(plan.keep, [
    { estimateId: "EST-11", estimate: "EST-11", status: "Approved", storedTax: 319.25, lineCount: 1, archived: true }, // listed, never written
    { estimateId: "EST-3", estimate: "EST-3", status: "Approved", storedTax: 41.28, lineCount: 2, archived: false },
  ]);
  assert.deepEqual(plan.skipped, { zz: 1, archivedJob: 2, otherStatus: 1, notTickedMaterial: 3 });
  assert.deepEqual(plan.byStatus.Approved, { write: 2, leave: 2 });
  assert.deepEqual(TAXED_PASS_STATUSES, ["Draft", "Sent", "Viewed", "Approved", "Declined", "Expired"]);
});
