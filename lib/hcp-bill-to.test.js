import { test } from "node:test";
import assert from "node:assert/strict";
import { billToFromTitle, billToFields, jobNotesText } from "./hcp-bill-to.js";

test("jobNotesText: HCP's list of {id, content} becomes one block, never [object Object]", () => {
  assert.equal(jobNotesText({ notes: [{ id: "nte_1", content: "CUSTOMER R&R 13 MODULES - " }, { id: "nte_2", content: "  " }, { id: "nte_3", content: "Called, left VM" }] }), "CUSTOMER R&R 13 MODULES -\n\nCalled, left VM");
  assert.equal(jobNotesText({ notes: [] }), "");
  assert.equal(jobNotesText({ notes: null }), "");
  assert.equal(jobNotesText({ notes: "plain string from an older pull" }), "plain string from an older pull");
  assert.ok(!jobNotesText({ notes: [{ id: "x", content: "a" }] }).includes("[object Object]"));
});

test("billToFromTitle: Harmon's real titles", () => {
  const t = (d) => billToFromTitle(d);
  assert.deepEqual(t("Solar - SunRun Standard Truck Roll"), { billToType: "Leasing Partner", billToName: "SunRun", serviceType: "Partner Work Order", rule: "partner:SunRun" });
  assert.equal(t("Solar - Sunrun - Inverter (unlike)").billToName, "SunRun");
  assert.equal(t("Solar - Spruce - 101-AZ").billToName, "Spruce Power");
  assert.deepEqual(t("EV - Omnidian Standard Truck Roll"), { billToType: "Other", billToName: "Omnidian", serviceType: "Partner Work Order", rule: "partner:Omnidian" });
  assert.equal(t("EV - ChargePoint Dispatch").billToName, "ChargePoint");
  assert.equal(t("Other - APS Quoted Cost").billToName, "APS");
  assert.equal(t("Solar - APS Standard Truck Roll").billToType, "Other");
  assert.equal(t("collapsed roof").billToName, null, "'aps' inside a word is not APS");
  assert.deepEqual(t("Solar - SMA RMA"), { billToType: "Manufacturer", billToName: "SMA", serviceType: "Warranty", rule: "rma:SMA" });
  assert.equal(t("EV - Tesla -RMA - SV02D77423").billToName, "Tesla");
  assert.equal(t("Qcell RMA").billToName, "Qcells");
  assert.equal(t("Fronius - RMA").billToName, "Fronius");
  assert.deepEqual(t("RMA"), { billToType: "Manufacturer", billToName: null, serviceType: "Warranty", rule: "rma" });
  assert.equal(t("Solar - Non Warranty Repair -TESLA RMA").billToName, "Tesla", "an RMA is the manufacturer's even when the title says non-warranty");
  assert.deepEqual(t("Solar - Non Warranty Repair"), { billToType: "Customer", billToName: null, serviceType: "Paid Service", rule: "non-warranty" });
  assert.deepEqual(t("Solar - Warranty Repair"), { billToType: "Internal Warranty", billToName: null, serviceType: "Warranty", rule: "warranty" });
  assert.equal(t("warranty").billToType, "Internal Warranty");
  assert.equal(t("WARRANT").billToType, "Internal Warranty", "typed by hand, cut short");
  assert.equal(t("Solar - QUOTED O&M").serviceType, "Maintenance");
  assert.equal(t("Maintain Plan").serviceType, "Maintenance");
  assert.equal(t("APS - EV O&M").serviceType, "Partner Work Order", "a partner's O&M is still their work order");
  assert.deepEqual(t("Solar - Standard Service Call"), { billToType: "Customer", billToName: null, serviceType: "Paid Service", rule: "paid" });
  assert.equal(t("Solar - DISPATCH MAN HOURS").serviceType, "Paid Service");
  assert.equal(t("Solar - Quoted - Removal-Reinstall").serviceType, "Paid Service");
  assert.deepEqual(t("Visit #1"), { billToType: "Customer", billToName: null, serviceType: null, rule: "customer" });
  assert.deepEqual(t(""), { billToType: "Customer", billToName: null, serviceType: null, rule: "blank" });
  assert.deepEqual(t(null).rule, "blank");
});

test("billToFields: only what the title decides", () => {
  assert.deepEqual(billToFields("Solar - SunRun Standard Truck Roll"), { Bill_To_Type__c: "Leasing Partner", Bill_To_Name__c: "SunRun", Service_Type__c: "Partner Work Order" });
  assert.deepEqual(billToFields("Solar - Warranty Repair"), { Bill_To_Type__c: "Internal Warranty", Service_Type__c: "Warranty" });
  assert.deepEqual(billToFields(""), { Bill_To_Type__c: "Customer" });
});
