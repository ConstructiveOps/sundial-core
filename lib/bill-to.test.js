// D-081: resolveBillTo — the type says what kind of payer, the lookup says who, the name is derived.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBillTo, stripDerivedBillToName, billToCustomerLoader } from "./bill-to.js";

const SUNRUN = { Id: "a1P7y00000SUNRUNAA", Is_Company__c: true, Company_Name__c: "SunRun", First_Name__c: "Dana", Last_Name__c: "Ruiz", Name: "SunRun" };
const loader = (rows) => async (id) => rows.find((r) => r.Id === id) ?? null;

test("untouched → nothing to write", async () => {
  const r = await resolveBillTo({ before: { Bill_To_Type__c: "Leasing Partner" }, loadCustomer: loader([]) });
  assert.deepEqual(r, { ok: true, fields: {}, payer: null });
});

test("type Customer → lookup and name cleared", async () => {
  const r = await resolveBillTo({ type: "Customer", customerId: SUNRUN.Id, before: null, loadCustomer: loader([SUNRUN]) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.fields, { Bill_To_Type__c: "Customer", Bill_To_Customer__c: null, Bill_To_Name__c: null });
});

test("partner type with a customer → lookup + derived name", async () => {
  const r = await resolveBillTo({ type: "Leasing Partner", customerId: SUNRUN.Id, loadCustomer: loader([SUNRUN]) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.fields, { Bill_To_Type__c: "Leasing Partner", Bill_To_Customer__c: SUNRUN.Id, Bill_To_Name__c: "SunRun" });
  assert.equal(r.payer, SUNRUN);
});

test("partner type with no customer → 400 BILL_TO_CUSTOMER_REQUIRED, named", async () => {
  const r = await resolveBillTo({ type: "Manufacturer", loadCustomer: loader([]) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, "BILL_TO_CUSTOMER_REQUIRED");
  assert.match(r.message, /Bill_To_Customer__c/);
});

test("type change uses the job's existing payer; clearing the payer on a partner job is refused", async () => {
  const before = { Bill_To_Type__c: "Leasing Partner", Bill_To_Customer__c: SUNRUN.Id };
  const r = await resolveBillTo({ type: "Other", before, loadCustomer: loader([SUNRUN]) });
  assert.deepEqual(r.fields, { Bill_To_Type__c: "Other", Bill_To_Customer__c: SUNRUN.Id, Bill_To_Name__c: "SunRun" });
  const cleared = await resolveBillTo({ customerId: "", before, loadCustomer: loader([SUNRUN]) });
  assert.equal(cleared.code, "BILL_TO_CUSTOMER_REQUIRED");
});

test("payer change alone keeps the type, re-derives the name", async () => {
  const aps = { Id: "a1P7y00000APSXXXAA", Is_Company__c: true, Company_Name__c: "APS" };
  const r = await resolveBillTo({ customerId: aps.Id, before: { Bill_To_Type__c: "Other", Bill_To_Customer__c: SUNRUN.Id }, loadCustomer: loader([aps]) });
  assert.deepEqual(r.fields, { Bill_To_Customer__c: aps.Id, Bill_To_Name__c: "APS" });
});

test("unknown / other-tenant / malformed payer ids are refused alike", async () => {
  const missing = await resolveBillTo({ type: "Other", customerId: "a1P7y00000NOPEXXAA", loadCustomer: loader([]) });
  assert.equal(missing.code, "BILL_TO_CUSTOMER_NOT_FOUND");
  const bad = await resolveBillTo({ type: "Other", customerId: "'; DELETE", loadCustomer: loader([]) });
  assert.equal(bad.code, "BILL_TO_CUSTOMER_INVALID");
});

test("blank type is Customer", async () => {
  const r = await resolveBillTo({ type: "", loadCustomer: loader([]) });
  assert.deepEqual(r.fields, { Bill_To_Type__c: "Customer", Bill_To_Customer__c: null, Bill_To_Name__c: null });
});

test("stripDerivedBillToName drops the field in any case", () => {
  assert.deepEqual(stripDerivedBillToName({ bill_to_name__c: "x", Priority__c: "High" }), { fields: { Priority__c: "High" }, dropped: true });
  assert.deepEqual(stripDerivedBillToName({ Priority__c: "High" }), { fields: { Priority__c: "High" }, dropped: false });
});

test("the loader is tenant-scoped and refuses malformed ids without a query", async () => {
  const seen = [];
  const load = billToCustomerLoader({ sfQuery: async (q) => (seen.push(q), [SUNRUN]), soqlEscapeString: (v) => v, tenantId: "a1W7y000007AszBEAS" });
  assert.equal(await load("nope"), null);
  assert.equal(seen.length, 0);
  assert.equal(await load(SUNRUN.Id), SUNRUN);
  assert.match(seen[0], /Client__c = 'a1W7y000007AszBEAS'/);
  assert.match(seen[0], /Company_Name__c/);
});
