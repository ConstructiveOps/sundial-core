// D-081: the bill-to backfill's matching — exact name (trimmed, any case), companies only,
// never a guess between two, never a job that already has a payer or bills the customer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsPayer, planBillToBackfill } from "./bill-to-backfill.js";

const companies = [
  { Id: "C1", Is_Company__c: true, Company_Name__c: "SunRun" },
  { Id: "C2", Is_Company__c: true, Company_Name__c: "SMA" },
  { Id: "C3", Is_Company__c: true, Company_Name__c: "Spruce Power" },
  { Id: "C4", Is_Company__c: true, Company_Name__c: "spruce  power" }, // a duplicate in all but case/spacing
  { Id: "P1", Is_Company__c: false, Company_Name__c: "APS" }, // not ticked: not a company
];
const job = (id, type, name, extra = {}) => ({ Id: id, Name: id, Bill_To_Type__c: type, Bill_To_Name__c: name, Bill_To_Customer__c: null, ...extra });

test("needsPayer: a partner type, a typed name, no record yet", () => {
  assert.equal(needsPayer(job("J", "Leasing Partner", "SunRun")), true);
  assert.equal(needsPayer(job("J", "Customer", "SunRun")), false);
  assert.equal(needsPayer(job("J", "Leasing Partner", "  ")), false);
  assert.equal(needsPayer(job("J", "Leasing Partner", "SunRun", { Bill_To_Customer__c: "C1" })), false);
  assert.equal(needsPayer(job("J", "", "SunRun")), false);
});

test("plan: matched / unmatched / ambiguous, counted per name, most jobs first", () => {
  const jobs = [
    job("J1", "Leasing Partner", "SunRun"),
    job("J2", "Leasing Partner", " sunrun "),
    job("J3", "Manufacturer", "SMA"),
    job("J4", "Leasing Partner", "Spruce Power"),
    job("J5", "Other", "APS"),
    job("J6", "Other", "APS"),
    job("J7", "Other", "APS"),
    job("J8", "Customer", "SunRun"), // bills the customer: not this backfill's
    job("J9", "Leasing Partner", "SunRun", { Bill_To_Customer__c: "C1" }), // already done
  ];
  const { writes, byName } = planBillToBackfill(jobs, companies);
  assert.deepEqual(writes.map((w) => [w.job.Id, w.company.Id]), [["J1", "C1"], ["J2", "C1"], ["J3", "C2"]]);
  assert.deepEqual(byName, [
    { name: "APS", outcome: "unmatched", jobs: 3 },
    { name: "SunRun", outcome: "matched", jobs: 2, companyId: "C1" },
    { name: "SMA", outcome: "matched", jobs: 1, companyId: "C2" },
    { name: "Spruce Power", outcome: "ambiguous", jobs: 1, companyIds: ["C3", "C4"] },
  ]);
});
