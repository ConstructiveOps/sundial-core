// scripts/hcp-import.mjs end to end against an in-memory Salesforce (2026-09-25): a dry run
// writes nothing but the reports; --apply links the customer with prior solar history by
// email (blanks filled, Solar;Service), creates the new one, and lands estimate → lines →
// job → call (tech by email) → invoice → payment on their HCP ids; a second --apply is
// idempotent (same ids, nothing duplicated). Runs under --experimental-test-module-mocks.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// ---- the in-memory Salesforce
const store = new Map(); // object → Map(HCP id → record with Id)
let nextId = 1;
const newId = (prefix) => `${prefix}${String(nextId++).padStart(12, "0")}`;
const existingCustomers = [
  { Id: "a1PSOLAR000001", Name: "Cy Diaz", First_Name__c: "Cy", Last_Name__c: "Diaz", Street__c: "9 Elm St", City__c: "Mesa", State__c: "AZ", Postal_Code__c: "85201", Primary_Email__c: "cy.diaz@example.com", Primary_Phone__c: "", Customer_Type__c: "Solar", Requested_Project_Types__c: "Solar", Status__c: "Customer", Service_Stage__c: null, Lead_Source__c: null, HCP_Id__c: null },
];
const upserts = [];
mock.module("../lib/salesforce.js", {
  namedExports: {
    soqlEscapeString: (v) => String(v).replace(/'/g, "\\'"),
    async describeObject() {
      return { fields: [{ name: "HCP_Id__c" }, { name: "Lead_Source__c", picklistValues: [{ value: "Web", active: true }, { value: "Phone", active: true }] }, { name: "State__c", picklistValues: [{ value: "AZ", active: true }] }] };
    },
    async sfQuery(soql) {
      if (/FROM Sundial_Tenant__c/.test(soql)) return [{ Id: "a0TENANT000001" }];
      if (/FROM Sundial_User__c/.test(soql)) return [{ Id: "a1USER00000001", First_Name__c: "Jake", Last_Name__c: "Dorsey", Email__c: "jake@harmon.test" }, { Id: "a1USER00000002", First_Name__c: "Sam", Last_Name__c: "Lee", Email__c: "sam@harmon.test" }];
      if (/FROM Sundial_Price_Book_Item__c/.test(soql)) return [{ Id: "a1ITEM00000001", HCP_Id__c: "svc_1", Kind__c: "Product", Is_Active__c: true }];
      if (/FROM Sundial_Customer__c WHERE Id = '/.test(soql)) {
        const id = soql.match(/Id = '([^']+)'/)[1];
        const all = [...existingCustomers, ...[...(store.get("Sundial_Customer__c") || new Map()).values()]];
        return all.filter((r) => r.Id === id).slice(-1);
      }
      if (/FROM Sundial_Customer__c WHERE Client__c/.test(soql)) {
        const created = [...(store.get("Sundial_Customer__c") || new Map()).values()].filter((r) => !existingCustomers.some((e) => e.Id === r.Id));
        return [...existingCustomers, ...created];
      }
      throw new Error(`unexpected SOQL: ${soql}`);
    },
    async sfUpsertMany(sfObject, extField, records) {
      if (!store.has(sfObject)) store.set(sfObject, new Map());
      const m = store.get(sfObject);
      return records.map((r) => {
        upserts.push({ sfObject, r });
        const key = r[extField];
        let rec;
        if (extField === "Id") {
          // an update by Salesforce id (the links): the record must exist, like the real API
          rec = existingCustomers.find((e) => e.Id === key) || [...m.values()].find((e) => e.Id === key);
          if (!rec) return { id: null, success: false, created: false, errors: [{ statusCode: "NOT_FOUND", message: `no ${sfObject} ${key}` }] };
        } else {
          rec = m.get(key) || (sfObject === "Sundial_Customer__c" ? existingCustomers.find((e) => e.HCP_Id__c === key) : undefined);
        }
        // an upsert by external id that finds nothing CREATES — and a bare record has no Client__c (the real refusal of 2026-09-28)
        if (!rec && extField !== "Id" && sfObject === "Sundial_Customer__c" && !r.Client__c) {
          return { id: null, success: false, created: false, errors: [{ statusCode: "REQUIRED_FIELD_MISSING", message: "Required fields are missing: [Client__c]" }] };
        }
        const created = !rec;
        if (created) rec = { Id: newId(sfObject.slice(8, 11).toUpperCase()) };
        Object.assign(rec, r);
        m.set(rec.HCP_Id__c ?? key, rec);
        return { id: rec.Id, success: true, created, errors: [] };
      });
    },
  },
});

const jobs = [
  { id: "job_1", invoice_number: "1042", work_status: "complete", description: "Breaker trips", notes: "gate 1234", total_amount: 45000, subtotal: 42000, original_estimate_id: "est_1", customer: { id: "cus_1", first_name: "Cy", last_name: "Diaz", email: "cy.diaz@example.com", mobile_number: "6025550100" }, address: { street: "9 Elm St", city: "Mesa", state: "AZ", zip: "85201" }, work_timestamps: { started_at: "2026-09-01T15:05:00Z", completed_at: "2026-09-01T16:50:00Z" }, schedule: {}, tags: [], created_at: "2026-08-30T10:00:00Z", updated_at: "2026-09-02T10:00:00Z" },
  { id: "job_2", invoice_number: "1043", work_status: "scheduled", description: "Panel offline", total_amount: 0, customer: { id: "cus_2", first_name: "New", last_name: "Person", email: "new@example.com" }, address: { street: "12 Oak Ave", city: "Tempe", state: "AZ", zip: "85281" }, schedule: { scheduled_start: "2026-10-01T15:00:00Z" }, created_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-20T10:00:00Z" },
];

async function seedRaw(dir) {
  const raw = path.join(dir, "raw");
  await fs.mkdir(path.join(raw, "jobs"), { recursive: true });
  await fs.mkdir(path.join(raw, "estimates"), { recursive: true });
  const w = (f, v) => fs.writeFile(path.join(raw, f), JSON.stringify(v));
  await w("customers.json", [
    { id: "cus_1", first_name: "Cy", last_name: "Diaz", email: "Cy.Diaz@example.com", mobile_number: "(602) 555-0100", lead_source: "Web", addresses: [{ type: "service", street: "9 Elm St.", city: "Mesa", state: "AZ", zip: "85201" }] },
    { id: "cus_2", first_name: "New", last_name: "Person", email: "new@example.com", lead_source: "Yard sign", addresses: [{ type: "service", street: "12 Oak Ave", city: "Tempe", state: "AZ", zip: "85281" }] },
    { id: "cus_3", first_name: "Only", last_name: "Lead", email: "lead@example.com", addresses: [] },
    // a second HCP record for the Diaz household (same email): shares the solar customer, never stamps HCP_Id__c
    { id: "cus_4", first_name: "Cy", last_name: "Diaz", email: "cy.diaz@example.com", addresses: [] },
  ]);
  await w("leads.json", [
    { id: "lead_1", number: "L-9", status: "open", pipeline_status: "Contacted", lead_source: "Phone", customer: { id: "cus_3", first_name: "Only", last_name: "Lead", email: "lead@example.com" }, address: { street: "1 Lead Ln", zip: "85000" }, tags: [], assigned_employee: { id: "e1" }, conversions: [] },
    { id: "lead_2", number: "L-77", status: "open", customer: { id: "cus_4", first_name: "Cy", last_name: "Diaz", email: "cy.diaz@example.com" }, address: {}, tags: [], conversions: [] },
  ]);
  await w("employees.json", [{ id: "e1", first_name: "Jake", last_name: "Dorsey", email: "JAKE@harmon.test", role: "field_tech" }, { id: "e2", first_name: "Old", last_name: "Tech", email: "old@harmon.test" }, { id: "e3", first_name: "Sam", last_name: "Lee", email: "sam.personal@example.com" }]);
  await w("jobs.json", jobs);
  await w("jobs/job_1.json", { job: jobs[0], line_items: [{ id: "li_1", name: "Inverter", description: "x".repeat(400), quantity: 1, unit_price: 210000, unit_cost: 150000, kind: "materials", service_item_id: "svc_1", taxable: true, order_index: 0 }, { id: "li_2", name: "Labor", quantity: 2, unit_price: 12000, kind: "labor", order_index: 1 }], appointments: [{ id: "ap_1", start_date: "2026-09-01", start_time: "08:00", end_time: "10:00", dispatched_employees_ids: ["e1", "e2"] }], errors: {} });
  await w("jobs/job_2.json", { job: jobs[1], line_items: [], appointments: [{ id: "ap_2", start_date: "2026-10-01", start_time: "08:00", end_time: "10:00", dispatched_employees_ids: ["e1"] }], errors: {} });
  await w("estimates.json", [
    { id: "est_1", estimate_number: "E-1", customer: jobs[0].customer, address: jobs[0].address, options: [{ id: "o1", name: "Option 1", total_amount: 45000, approval_status: "customer_approved" }], created_at: "2026-08-29T10:00:00Z" },
    { id: "est_2", estimate_number: "E-2", customer: { id: "cus_2", first_name: "New", last_name: "Person" }, address: jobs[1].address, options: [{ id: "o2", name: "Good", total_amount: 99000, approval_status: "pending" }, { id: "o3", name: "Better", total_amount: 150000, approval_status: "pending" }], created_at: "2026-09-21T10:00:00Z" },
  ]);
  await w("estimates/est_2.json", { estimate: { id: "est_2" }, options: [{ option: { id: "o2" }, line_items: [{ id: "eli_1", name: "Panel", quantity: 3, unit_price: 33000, kind: "materials" }] }, { option: { id: "o3" }, line_items: [{ id: "eli_2", name: "Panel+", quantity: 3, unit_price: 50000 }] }], errors: {} });
  await w("invoices.json", [{ id: "inv_1", invoice_number: "1042", status: "paid", amount: 45000, subtotal: 42000, due_amount: 0, job_id: "job_1", invoice_date: "2026-09-02T00:00:00Z", paid_at: "2026-09-03T00:00:00Z", taxes: [{ amount: 3000 }], discounts: [], items: [], payments: [{ id: "p1", amount: 45000, payment_method: "credit_card", paid_at: "2026-09-03T00:00:00Z" }], refunds: [] }]);
}

async function runImport(dir, extra = []) {
  process.argv = ["node", "hcp-import.mjs", "--tenant", "harmon", "--in", dir, "--out", path.join(dir, "import"), ...extra];
  const log = mock.method(console, "log", () => {});
  try {
    await import(`./hcp-import.mjs?run=${Date.now()}-${Math.random()}`);
  } finally {
    log.mock.restore();
  }
}
const rec = (obj, key) => store.get(obj)?.get(key);

test("hcp-import: dry run writes only reports; --apply lands everything on HCP ids; a second --apply is idempotent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcp-import-"));
  await seedRaw(dir);

  await runImport(dir);
  assert.equal(upserts.length, 0, "a dry run writes nothing");
  const summary = await fs.readFile(path.join(dir, "import", "SUMMARY.txt"), "utf8");
  assert.match(summary, /DRY RUN/);
  assert.match(summary, /customers:create\s+2/, summary);
  assert.match(summary, /jobs:planned\s+2\n/, "jobs counted once");
  assert.match(summary, /customers:link-by-email\s+1/, summary);
  const techTpl = await fs.readFile(path.join(dir, "import", "tech-map.template.csv"), "utf8");
  assert.match(techTpl, /Old Tech,old@harmon.test,,,NO Sundial user/);
  assert.match(techTpl, /Sam Lee,sam.personal@example.com,,,SUGGESTED by name → sam@harmon.test/);
  const suggested = JSON.parse(await fs.readFile(path.join(dir, "import", "tech-map.suggested.json"), "utf8"));
  assert.deepEqual(suggested, { "sam.personal@example.com": "sam@harmon.test" }, "a same-name user is suggested, never assumed");
  const rev = await fs.readFile(path.join(dir, "import", "review.csv"), "utf8");
  assert.ok(rev === "" || rev.startsWith("\uFEFFneeds_action,"), "review rows carry needs_action first");

  await runImport(dir, ["--apply"]);
  // the solar customer: linked, blanks filled, types unioned, nothing else touched
  const solar = existingCustomers[0];
  assert.equal(solar.HCP_Id__c, "cus_1");
  assert.equal(solar.Customer_Type__c, "Solar;Service");
  assert.equal(solar.Primary_Phone__c, "(602) 555-0100");
  assert.equal(solar.Street__c, "9 Elm St", "Sales's street stays");
  assert.equal(solar.Status__c, "Customer");
  assert.match(solar.Description__c ?? "", /HCP lead #L-77/, "the shared household's lead lands on the solar record by Salesforce id");
  assert.equal(solar.Service_Stage__c, "New");
  // the new customer: created as a Customer (has a job); the lead-only one as a Lead in the pipeline
  const c2 = rec("Sundial_Customer__c", "cus_2");
  assert.equal(c2.Status__c, "Customer");
  assert.equal(c2.Client__c, "a0TENANT000001");
  assert.equal(c2.Lead_Source__c, undefined, "'Yard sign' is not a picklist value");
  const c3 = rec("Sundial_Customer__c", "cus_3");
  assert.equal(c3.Status__c, "Lead");
  assert.equal(c3.Service_Stage__c, "New");
  assert.equal(c3.Lead_Source__c, "Phone");
  assert.equal(c3.Assigned_To__c, "a1USER00000001");
  assert.match(c3.Description__c, /HCP lead #L-9 · Contacted \(open\)/);
  // estimates: est_1 claimed by job_1 (Invoiced, the job's lines); est_2 standalone with option "Good"'s lines only; job_2 gets its own
  const e1 = rec("Sundial_Estimate__c", "est_1");
  assert.equal(e1.Status__c, "Invoiced");
  assert.equal(e1.Sundial_Customer__c, "a1PSOLAR000001");
  assert.equal(e1.Total__c, 450);
  assert.equal(e1.Subtotal__c, 2340);
  assert.equal(e1.Material_Subtotal__c, 0, "the price-book item is a Product: subtotal only, like totals.js");
  assert.equal(e1.Labor_Subtotal__c, 240);
  const e2 = rec("Sundial_Estimate__c", "est_2");
  assert.equal(e2.Status__c, "Sent");
  assert.equal(e2.Total__c, 990);
  assert.ok(rec("Sundial_Estimate__c", "job:job_2:estimate"));
  assert.ok(rec("Sundial_Service_Line__c", "eli_1"));
  assert.equal(rec("Sundial_Service_Line__c", "eli_2"), undefined, "the other option's lines are not written");
  const l1 = rec("Sundial_Service_Line__c", "li_1");
  assert.equal(l1.Line_Total__c, undefined, "a formula field is never sent");
  assert.equal(l1.Description__c.length, 255, "Text(255) — cut, never refused");
  assert.ok(l1.Description__c.endsWith("…"));
  assert.equal(rec("Sundial_Service_Job__c", "job_1").Estimate_Total__c, undefined, "the job's estimate formulas are never sent");
  assert.equal(rec("Sundial_Service_Invoice__c", "inv_1").Balance__c, undefined);
  assert.equal(l1.Estimate__c, e1.Id);
  assert.equal(l1.Price_Book_Item__c, "a1ITEM00000001");
  assert.equal(l1.Kind__c, "Product");
  assert.equal(l1.Stage__c, "Completed");
  // jobs
  const j1 = rec("Sundial_Service_Job__c", "job_1");
  assert.equal(j1.Estimate__c, e1.Id);
  assert.equal(j1.Sundial_Customer__c, "a1PSOLAR000001");
  assert.equal(j1.Status__c, "Paid");
  assert.equal(j1.Payment_Status__c, "Paid");
  assert.equal(e1.Service_Job__c, j1.Id, "the estimate points back at its job");
  const j2 = rec("Sundial_Service_Job__c", "job_2");
  assert.equal(j2.Status__c, "Scheduled");
  assert.equal(j2.Sundial_Customer__c, c2.Id);
  // calls: two techs on ap_1 → two calls; e2 has no Sundial user
  const callKeys = [...store.get("Sundial_Service_Call__c").keys()].filter((k) => k.startsWith("ap_1:"));
  assert.equal(callKeys.length, 2);
  assert.ok(callKeys.every((k) => k.length <= 64 && /^ap_1:[0-9a-f]{8}$/.test(k)), `short stable keys: ${callKeys}`);
  const c1a = [...store.get("Sundial_Service_Call__c").values()].find((c) => c.HCP_Id__c.startsWith("ap_1:") && c.Tech__c === "a1USER00000001");
  const c1b = [...store.get("Sundial_Service_Call__c").values()].find((c) => c.HCP_Id__c.startsWith("ap_1:") && !c.Tech__c);
  assert.equal(c1a.Tech__c, "a1USER00000001");
  assert.equal(c1a.Status__c, "Complete");
  assert.equal(c1a.Actual_Start__c, "2026-09-01T15:05:00.000Z");
  assert.equal(c1b.Tech__c, undefined);
  assert.match(c1b.Private_Notes__c, /Old Tech \(no matching Sundial user\)/);
  assert.equal(rec("Sundial_Service_Call__c", "ap_2").Status__c, "Scheduled");
  // money
  const inv = rec("Sundial_Service_Invoice__c", "inv_1");
  assert.equal(inv.Service_Job__c, j1.Id);
  assert.equal(inv.Status__c, "Paid");
  assert.equal(inv.Name, "1042");
  const pay = rec("Sundial_Service_Payment__c", "p1");
  assert.equal(pay.Invoice__c, inv.Id);
  assert.equal(pay.Amount__c, 450);
  assert.equal(pay.Method__c, "Card");
  const summaryApply = await fs.readFile(path.join(dir, "import", "SUMMARY.txt"), "utf8");
  assert.doesNotMatch(summaryApply, /failed/, summaryApply);
  const idMap = JSON.parse(await fs.readFile(path.join(dir, "import", "id-map.json"), "utf8"));
  assert.equal(idMap.customers.cus_1.created, false);
  assert.equal(idMap.customers.cus_2.created, true);
  const firstCount = upserts.length;
  const sizes = [...store.entries()].map(([k, m]) => [k, m.size]);

  // second apply: same records, same ids, nothing new
  await runImport(dir, ["--apply"]);
  assert.ok(upserts.length > firstCount);
  assert.deepEqual([...store.entries()].map(([k, m]) => [k, m.size]), sizes, `no duplicates on a re-run: ${[...store.get("Sundial_Customer__c").keys()]}`);
  assert.equal(rec("Sundial_Service_Job__c", "job_1").Id, j1.Id);
  const summary2 = await fs.readFile(path.join(dir, "import", "SUMMARY.txt"), "utf8");
  assert.match(summary2, /customers:refresh\s+2/, "the two the import created are refreshed");
  assert.match(summary2, /customers:known-linked\s+1/, "the linked one only gets blanks filled");
  assert.doesNotMatch(summary2, /failed/, "nothing failed on the re-run");
});
