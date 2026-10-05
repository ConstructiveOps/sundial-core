import { test } from "node:test";
import assert from "node:assert/strict";
import { planJobFix, planEstimateFix, taxJurisdictionOf } from "./hcp-backfill.js";

const hcp = { id: "job_1", invoice_number: "1042", description: "Solar - SunRun Standard Truck Roll", notes: [{ id: "n1", content: "gate 1234" }, { id: "n2", content: "Inverter faulted" }] };

test("planJobFix: the import's record gets notes, description, and Bill-To from the title", () => {
  const sf = { Office_Notes__c: "Migrated from Housecall Pro — HCP job #1042\nTags: invoiced\n[object Object]", Issue_Description__c: "Solar - SunRun Standard Truck Roll", Bill_To_Type__c: "Customer", Bill_To_Name__c: null, Service_Type__c: null };
  assert.deepEqual(planJobFix(sf, hcp), {
    Office_Notes__c: "Migrated from Housecall Pro — HCP job #1042\nTags: invoiced\ngate 1234\n\nInverter faulted",
    Issue_Description__c: "Solar - SunRun Standard Truck Roll\n\ngate 1234\n\nInverter faulted",
    Bill_To_Type__c: "Leasing Partner",
    Bill_To_Name__c: "SunRun",
    Service_Type__c: "Partner Work Order",
  });
});

test("planJobFix: the office's edits are kept — an edited description, a chosen payer, a set service type; notes never already there are appended", () => {
  const sf = { Office_Notes__c: "Called the customer, parts ordered.", Issue_Description__c: "Customer says the inverter is clicking", Bill_To_Type__c: "Manufacturer", Bill_To_Name__c: "SMA", Service_Type__c: "Warranty" };
  assert.deepEqual(planJobFix(sf, hcp), { Office_Notes__c: "Called the customer, parts ordered.\n\nHCP notes:\ngate 1234\n\nInverter faulted" });
  // nothing to do: notes already landed, description edited, payer chosen
  const done = { ...sf, Office_Notes__c: "Called the customer.\n\nHCP notes:\ngate 1234\n\nInverter faulted" };
  assert.equal(planJobFix(done, hcp), null);
  // a job with no notes and a blank title: nothing
  assert.equal(planJobFix({ Office_Notes__c: "Migrated from Housecall Pro — HCP job #7", Issue_Description__c: "", Bill_To_Type__c: "Customer" }, { description: "", notes: [] }), null);
  // a plain title: service type only, Bill-To stays Customer
  assert.deepEqual(planJobFix({ Office_Notes__c: "x", Issue_Description__c: "Solar - Standard Service Call", Bill_To_Type__c: "Customer" }, { description: "Solar - Standard Service Call", notes: [] }), { Service_Type__c: "Paid Service" });
});

test("taxJurisdictionOf + planEstimateFix: the rate from the tax ÷ the taxable lines; the city from HCP's tax line", () => {
  assert.equal(taxJurisdictionOf([{ kind: "labor", name: "x" }, { kind: "tax", name: "Maricopa County" }]), "Maricopa County");
  assert.equal(taxJurisdictionOf([{ kind: "tax", name: "Cave Creek Retail tax" }]), "Cave Creek");
  assert.equal(taxJurisdictionOf([]), null);
  const lines = [{ Taxable__c: true, Line_Total__c: 200, Stage__c: "Approved" }, { Taxable__c: false, Line_Total__c: 275 }, { Taxable__c: true, Line_Total__c: 50, Stage__c: "Removed" }];
  assert.deepEqual(planEstimateFix({ Tax_Rate__c: null, Tax_Amount__c: 17.2, Tax_Jurisdiction__c: null }, lines, { jurisdiction: "Phoenix" }), { fields: { Tax_Rate__c: 8.6, Tax_Jurisdiction__c: "Phoenix" }, note: null });
  assert.deepEqual(planEstimateFix({ Tax_Rate__c: 8.6, Tax_Amount__c: 17.2, Tax_Jurisdiction__c: "Phoenix" }, lines, { jurisdiction: "Phoenix" }), null, "already right");
  assert.deepEqual(planEstimateFix({ Tax_Rate__c: null, Tax_Amount__c: 0 }, lines, {}), null, "no tax, nothing to derive");
  const noTaxable = planEstimateFix({ Tax_Rate__c: null, Tax_Amount__c: 27.5 }, [{ Taxable__c: false, Line_Total__c: 275 }], {});
  assert.deepEqual(noTaxable, { fields: null, note: "tax with no taxable line — no rate written" });
  assert.deepEqual(planEstimateFix({ Tax_Rate__c: null, Tax_Amount__c: 27.5 }, [{ Taxable__c: false, Line_Total__c: 275 }], { fallbackRate: 8.6 }), { fields: { Tax_Rate__c: 8.6 }, note: "tax with no taxable line — fallback rate" });
});
