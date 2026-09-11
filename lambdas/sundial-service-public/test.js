// Tests for sundial-service-public — the customer page's backend, driven through
// the real router with an in-memory Salesforce and a recording activity sink.
// Run:  node --test lambdas/sundial-service-public/test.js   (also in `npm test`)

import test from "node:test";
import assert from "node:assert/strict";
import { createHandler, matchRoute } from "./index.js";

const TENANT = "a1W7y000007AszBEAS";
const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";
const NOW = new Date("2026-09-12T15:00:00Z");

function fake({ status = "Sent", expiresAt = "2026-10-30T00:00:00Z", version = 1, approvedAt = null } = {}) {
  const est = {
    Id: "EST000000000000001", Name: "EST-00042", Client__c: TENANT, Status__c: status, Version__c: version,
    Public_Token__c: TOKEN, Public_Token_Expires_At__c: expiresAt, Customer_Name_at_Creation__c: "Ann Lee",
    Address_at_Creation__c: "123 N Main St, Phoenix, AZ 85001", Tax_Rate__c: 8.6, Deposit_Required__c: true,
    Deposit_Type__c: "Percent", Deposit_Value__c: 25, Valid_Until__c: "2026-10-12", Approved_At__c: approvedAt,
    Service_Job__c: "SVC000000000000001", Is_Template__c: false,
  };
  const lines = [
    { Id: "SL1", Estimate__c: est.Id, Client__c: TENANT, Description__c: "Standard service call", Kind__c: "Labor", Quantity__c: 1, Unit_Price__c: 275, Line_Total__c: 275, Taxable__c: false, Stage__c: "Proposed" },
    { Id: "SL2", Estimate__c: est.Id, Client__c: TENANT, Description__c: "Disconnect", Kind__c: "Material", Quantity__c: 1, Unit_Price__c: 120, Line_Total__c: 120, Taxable__c: true, Stage__c: "Proposed" },
  ];
  const updates = [];
  const activity = [];
  const deps = {
    sfQuery: async (soql) => {
      if (soql.includes("FROM Sundial_Estimate__c")) return soql.includes(`Public_Token__c = '${TOKEN}'`) ? [{ ...est }] : [];
      if (soql.includes("FROM Sundial_Service_Line__c")) return lines.map((l) => ({ ...l }));
      return [];
    },
    sfUpdateRecord: async (obj, id, fields) => {
      updates.push({ obj, id, fields });
      const target = obj === "Sundial_Estimate__c" ? est : lines.find((l) => l.Id === id);
      Object.assign(target, fields);
      return { ok: true, id };
    },
    getSupabaseClient: async () => ({ from: () => ({ insert: async (row) => { activity.push(row); return { error: null }; } }) }),
    now: () => NOW,
    brandName: "Acme Solar",
  };
  return { est, lines, updates, activity, deps };
}
const call = (h, method, path, body) =>
  h({ requestContext: { http: { method } }, rawPath: path, headers: { origin: "http://localhost:5173" }, body: body ? JSON.stringify(body) : undefined })
    .then((r) => ({ status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }));

test("matchRoute: token captured, stage prefix stripped, unknown 404", () => {
  assert.deepEqual(matchRoute("GET", `/prod/public/estimates/${TOKEN}`), { name: "view", token: TOKEN });
  assert.deepEqual(matchRoute("POST", `/public/estimates/${TOKEN}/accept`), { name: "accept", token: TOKEN });
  assert.equal(matchRoute("GET", "/public/estimates"), null);
});

test("view: renders the customer document, marks Sent → Viewed once, reports canAccept + totals", async () => {
  const f = fake();
  const h = createHandler(f.deps);
  const r = await call(h, "GET", `/public/estimates/${TOKEN}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.html.includes("Standard service call"));
  assert.ok(r.body.html.includes("Acme Solar"));
  assert.ok(!r.body.html.includes("PREVIEW"), "customer mode has no watermark");
  assert.equal(r.body.number, "EST-00042");
  assert.equal(r.body.status, "Viewed");
  assert.equal(r.body.canAccept, true);
  assert.equal(r.body.total, 405.32); // 395 + 8.6% of 120
  assert.equal(r.body.depositAmount, 101.33);
  assert.equal(f.est.Status__c, "Viewed");
  assert.equal(f.activity.length, 1);
  assert.equal(f.activity[0].actor_name, "Customer");
  assert.equal(f.activity[0].client_sf_id, TENANT);
  // Second view: no status change, no second activity row.
  await call(h, "GET", `/public/estimates/${TOKEN}`);
  assert.equal(f.activity.length, 1);
});

test("view: wrong token → 404, expired → 410, template → 404, malformed → 404 without a query", async () => {
  const f = fake();
  const h = createHandler(f.deps);
  assert.equal((await call(h, "GET", "/public/estimates/zzzzzzzzzzzzzzzzzzzzzzzz")).status, 404);
  assert.equal((await call(h, "GET", "/public/estimates/short")).status, 404);
  const g = fake({ expiresAt: "2026-09-01T00:00:00Z" });
  assert.equal((await call(createHandler(g.deps), "GET", `/public/estimates/${TOKEN}`)).status, 410);
});

test("accept: needs a name; approves online, promotes Proposed lines, writes the activity row with the customer as actor; idempotent", async () => {
  const f = fake();
  const h = createHandler(f.deps);
  const noName = await call(h, "POST", `/public/estimates/${TOKEN}/accept`, {});
  assert.equal(noName.status, 400);
  const ok = await call(h, "POST", `/public/estimates/${TOKEN}/accept`, { name: "  Ann Lee  " });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, "Approved");
  assert.equal(ok.body.approvedByName, "Ann Lee");
  assert.equal(f.est.Approval_Method__c, "Online");
  assert.equal(f.est.Approved_Version__c, 1);
  assert.equal(f.est.Approved_Amount__c, 405.32);
  assert.ok(f.lines.every((l) => l.Stage__c === "Approved"));
  const row = f.activity.find((a) => a.event === "estimate_approved");
  assert.equal(row.actor_name, "Customer: Ann Lee");
  assert.equal(row.job_sf_id, "SVC000000000000001");
  const again = await call(h, "POST", `/public/estimates/${TOKEN}/accept`, { name: "Ann Lee" });
  assert.equal(again.body.alreadyApproved, true);
  assert.equal(f.activity.filter((a) => a.event === "estimate_approved").length, 1);
});

test("accept on a declined/unsent estimate is 409; decline works and refuses after approval", async () => {
  const f = fake({ status: "Draft", version: 0 });
  const h = createHandler(f.deps);
  const r = await call(h, "POST", `/public/estimates/${TOKEN}/accept`, { name: "X" });
  assert.equal(r.status, 409);
  const g = fake();
  const h2 = createHandler(g.deps);
  const dec = await call(h2, "POST", `/public/estimates/${TOKEN}/decline`, { reason: "Too expensive" });
  assert.equal(dec.status, 200);
  assert.equal(g.est.Status__c, "Declined");
  assert.equal(g.est.Declined_Reason__c, "Too expensive");
  const k = fake({ status: "Approved" });
  assert.equal((await call(createHandler(k.deps), "POST", `/public/estimates/${TOKEN}/decline`, {})).status, 409);
});
