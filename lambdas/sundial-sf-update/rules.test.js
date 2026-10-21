// sundial-sf-update — the 2026-10-22 write rules on the generic PATCH / POST:
//   A6  a report date on a job before Ready to Bill → Ready to Bill (never backwards)
//   A7  a service call's window / status is the dispatch board's, never this route's
//   A8  a new follow-up date ticks Follow-up needed in the same write
//   A9  intake answers / Assigned To leave a system line in the customer's feed (D-084)
//
// Salesforce + Supabase are mocked at the module boundary (same pattern as access.test.js).
// Run with: npm test (needs --experimental-test-module-mocks)

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolveScope, accessBlock } from "../../lib/access.js";

const TENANT = "a1W7y000007AszBEAS";
const ADMIN = "a1O7y00000ADMINAAA";
const PAIGE = "a1O7y00000PAIGEAAA";
const CUST = "a1P000000000001AAA";
const JOB = "a1c000000000001AAA";
const CALL = "a1d000000000001AAA";

const ctx = {};
function reset() {
  const user = { id: ADMIN, accessLevel: "Admin", hierarchyLevel: "Client", firstName: "Beth", lastName: "Office", dealer: null };
  ctx.identity = { user, access: accessBlock(resolveScope(user, TENANT)), tenantId: TENANT, tenantSlug: "harmon", authUserId: "uuid-beth" };
  ctx.customer = { Id: CUST, Name: "Ann Lee", Assigned_To__c: null, Archived__c: false, Customer_Type__c: "Service", System_Ownership__c: "Lease", Inverter_Manufacturer__c: "SMA", Next_Follow_Up_Date__c: null };
  ctx.job = { Id: JOB, Status__c: "Awaiting Office Review", Estimate__c: "a1E000000000001AAA", Report_Uploaded_to_Partner_Portal__c: null, Report_Sent_to_Customer__c: null, Notes_Reported__c: null };
  ctx.writes = [];
  ctx.inserts = [];
  process.env.ACCESS_MODEL_MODE = "enforce";
}

mock.module("../../lib/identity.js", { namedExports: { resolveIdentity: async () => ctx.identity } });
mock.module("../../lib/salesforce.js", {
  namedExports: {
    soqlEscapeString: (v) => String(v).replace(/'/g, "\\'"),
    getSalesforceToken: async () => ({ access_token: "tok", instance_url: "https://example.my.salesforce.com" }),
    sfQuery: async (soql) => {
      if (/FROM Sundial_User__c/.test(soql)) return soql.includes(PAIGE) ? [{ Id: PAIGE, First_Name__c: "Paige", Last_Name__c: "Ng" }] : [];
      if (/FROM Sundial_Service_Job__c/.test(soql)) return [{ ...ctx.job }];
      if (/FROM Sundial_Service_Call__c/.test(soql)) return [{ Id: CALL, Name: "SC-1", Sundial_Service_Job__c: JOB }];
      if (/FROM Sundial_Customer__c/.test(soql)) return [{ ...ctx.customer }];
      return [];
    },
  },
});
const supabase = {
  from: (table) => ({
    update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
    insert: async (row) => (ctx.inserts.push({ table, row }), { error: null }),
  }),
};
mock.module("../../lib/supabase.js", {
  namedExports: { getSupabaseClient: async () => supabase, getSupabaseConfig: async () => ({ url: "https://supa.example.co", serviceRoleKey: "svc" }) },
});

const F = (name) => ({ name, updateable: true, createable: true });
const DESCRIBE_FIELDS = [
  { name: "Id", updateable: false, createable: false },
  ...["Name", "First_Name__c", "Assigned_To__c", "Archived__c", "Customer_Type__c", "Next_Follow_Up_Date__c", "Follow_Up_Needed__c",
    "System_Ownership__c", "Inverter_Manufacturer__c", "Type_of_Service__c", "Description__c",
    "Status__c", "Status_Changed_At__c", "Priority__c", "Report_Uploaded_to_Partner_Portal__c", "Report_Sent_to_Customer__c", "Notes_Reported__c",
    "Scheduled_Start__c", "Scheduled_End__c", "Work_Notes__c"].map(F),
];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/describe")) return { ok: true, status: 200, json: async () => ({ fields: DESCRIBE_FIELDS }) };
  ctx.writes.push({ method: init?.method, path: u, body: init?.body ? JSON.parse(init.body) : null });
  return { ok: true, status: init?.method === "POST" ? 201 : 204, json: async () => ({ id: "a1PnewRECORD00001", success: true, errors: [] }), text: async () => "" };
};

const { handler } = await import("./index.js");
const patch = (object, id, fields) =>
  handler({ requestContext: { http: { method: "PATCH" } }, rawPath: `/sf/${object}/${id}`, pathParameters: { object, id }, headers: { authorization: "Bearer t", origin: "http://localhost:5173" }, body: JSON.stringify({ fields }) });
const post = (object, fields) =>
  handler({ requestContext: { http: { method: "POST" } }, rawPath: `/sf/${object}`, pathParameters: { object }, headers: { authorization: "Bearer t", origin: "http://localhost:5173" }, body: JSON.stringify({ fields }) });
const comments = () => ctx.inserts.filter((i) => i.table === "comments").map((i) => i.row);
const activity = () => ctx.inserts.filter((i) => i.table === "sundial_service_activity").map((i) => i.row);

test.beforeEach(reset);

// --- A6 --------------------------------------------------------------------------------------
for (const f of ["Report_Uploaded_to_Partner_Portal__c", "Report_Sent_to_Customer__c", "Notes_Reported__c"]) {
  test(`A6: ${f} set on an Awaiting Office Review job → Ready to Bill in the same write, logged via report_date`, async () => {
    const res = await patch("job", JOB, { [f]: "2026-10-22" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).jobStatusChanged, "Ready to Bill");
    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].body[f], "2026-10-22");
    assert.equal(ctx.writes[0].body.Status__c, "Ready to Bill");
    assert.ok(ctx.writes[0].body.Status_Changed_At__c);
    const row = activity().find((a) => a.details.via === "report_date");
    assert.deepEqual(row.details.fields.Status__c, { from: "Awaiting Office Review", to: "Ready to Bill" });
    assert.equal(row.event, "job_updated");
    // the edit's own row does not repeat the status
    assert.equal(activity().find((a) => a.details.via === "sf-update").details.fields.Status__c, undefined);
  });
}

test("A6: from Paid → unchanged; blank → blank → unchanged; clearing a date → unchanged", async () => {
  ctx.job.Status__c = "Paid";
  await patch("job", JOB, { Notes_Reported__c: "2026-10-22" });
  assert.equal(ctx.writes[0].body.Status__c, undefined);
  reset();
  await patch("job", JOB, { Notes_Reported__c: null });
  assert.deepEqual(ctx.writes[0].body, { Notes_Reported__c: null });
  reset();
  ctx.job.Notes_Reported__c = "2026-10-20";
  await patch("job", JOB, { Notes_Reported__c: null });
  assert.deepEqual(ctx.writes[0].body, { Notes_Reported__c: null });
  assert.equal(activity().some((a) => a.details.via === "report_date"), false);
});

// --- A7 --------------------------------------------------------------------------------------
test("A7: the generic service-call PATCH refuses the window and the status (the board's routes settle the job)", async () => {
  for (const fields of [{ Scheduled_Start__c: null }, { Scheduled_End__c: "2026-10-23T18:00:00Z" }, { Status__c: "Complete" }]) {
    const res = await patch("servicecall", CALL, fields);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, "CALL_SCHEDULE_READ_ONLY");
  }
  assert.equal(ctx.writes.length, 0);
  // anything else on a call still saves
  assert.equal((await patch("servicecall", CALL, { Work_Notes__c: "ok" })).statusCode, 200);
});

// --- A8 --------------------------------------------------------------------------------------
test("A8: a new follow-up date → Follow-up needed true; cleared → flag untouched; false + a new date → the date wins", async () => {
  await patch("customer", CUST, { Next_Follow_Up_Date__c: "2026-10-30" });
  assert.deepEqual(ctx.writes[0].body, { Next_Follow_Up_Date__c: "2026-10-30", Follow_Up_Needed__c: true });
  reset();
  ctx.customer.Next_Follow_Up_Date__c = "2026-10-30";
  await patch("customer", CUST, { Next_Follow_Up_Date__c: null });
  assert.deepEqual(ctx.writes[0].body, { Next_Follow_Up_Date__c: null });
  reset();
  await patch("customer", CUST, { Next_Follow_Up_Date__c: "2026-11-02", Follow_Up_Needed__c: false });
  assert.deepEqual(ctx.writes[0].body, { Next_Follow_Up_Date__c: "2026-11-02", Follow_Up_Needed__c: true });
  reset();
  await post("customer", { Name: "New", Next_Follow_Up_Date__c: "2026-11-02" });
  assert.equal(ctx.writes[0].body.Follow_Up_Needed__c, true);
});

// --- A9 --------------------------------------------------------------------------------------
test("A9: a PATCH changing two intake fields → ONE system comment naming both; an unchanged PATCH → none", async () => {
  await patch("customer", CUST, { System_Ownership__c: "Own", Inverter_Manufacturer__c: "Enphase" });
  assert.equal(comments().length, 1);
  const c = comments()[0];
  assert.equal(c.record_object, "customer");
  assert.equal(c.record_id, CUST);
  assert.equal(c.tenant_id, TENANT);
  assert.equal(c.author_id, "uuid-beth");
  assert.equal(c.kind, "system");
  assert.match(c.body, /^Intake updated by Beth Office on \w{3} \d{1,2}, \d{4} \d{1,2}:\d{2} [AP]M \(Arizona\): Do you own or lease the system\? — Own; What brand is your solar inverter\? — Enphase$/);
  reset();
  await patch("customer", CUST, { System_Ownership__c: "Lease", First_Name__c: "Ann" });
  assert.equal(comments().length, 0);
});

test("A9: assignment → 'Assigned to Paige Ng by Beth Office …'; unassigning says Unassigned", async () => {
  await patch("customer", CUST, { Assigned_To__c: PAIGE });
  assert.equal(comments().length, 1);
  assert.match(comments()[0].body, /^Assigned to Paige Ng by Beth Office on .* \(Arizona\)$/);
  reset();
  ctx.customer.Assigned_To__c = PAIGE;
  await patch("customer", CUST, { Assigned_To__c: null });
  assert.match(comments()[0].body, /^Unassigned by Beth Office on /);
});

test("A9: a customer created here with intake answers → one comment", async () => {
  const res = await post("customer", { Name: "New One", Type_of_Service__c: "Repair", Description__c: "Panels dirty" });
  assert.equal(res.statusCode, 201);
  assert.equal(comments().length, 1);
  assert.match(comments()[0].body, /What type of work do you need done\? — Repair; Tell us more about your issue\. — Panels dirty$/);
  assert.equal(comments()[0].record_id, "a1PnewRECORD00001");
});
