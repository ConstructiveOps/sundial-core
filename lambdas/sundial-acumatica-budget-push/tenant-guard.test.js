// sundial-acumatica-budget-push — the PRIMARY-TENANT RULE (D-078) on its three doors.
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// This Lambda ends in real budget lines, real project attributes and REAL purchase
// orders in the one Acumatica the platform is connected to — the primary tenant's. What
// is pinned here is that a caller from any other tenant is turned away before ANYTHING
// happens (no Salesforce read, no status flip, no worker, no Acumatica call), on both
// HTTP routes and again in the worker that runs the commission-PO stage — and that the
// primary tenant walks through exactly as before.
//
// Kept apart from test.js because that file deliberately does not mock identity or the
// Lambda client; mocking them there would change what its 90-odd tests run against.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const RECORD_ID = "a1S000000000001AAA";
const ctx = {
  identity: null,
  soql: [], // every Salesforce read
  sfUpdates: [], // every Salesforce write
  acumatica: [], // every Acumatica call (read or write)
  invokes: [], // every async self-invoke payload
  rows: [], // what the tenant-scoped Solar read returns
};
function reset(identity) {
  ctx.identity = identity;
  ctx.soql = [];
  ctx.sfUpdates = [];
  ctx.acumatica = [];
  ctx.invokes = [];
  ctx.rows = [];
  delete process.env.SUNDIAL_ACUMATICA_TENANTS;
  delete process.env.SUNDIAL_PRIMARY_TENANT;
}
const HARMON = { tenantId: "a0XharmonTENANT", tenantSlug: "harmon" };
const DEMO = { tenantId: "a0XdemoTENANT00", tenantSlug: "conops-demo" };

mock.module("../../lib/acumatica.js", {
  namedExports: {
    getAcumaticaEntity: async (...a) => (ctx.acumatica.push(["GET", ...a]), { ok: true, status: 200, data: [] }),
    putAcumaticaEntity: async (...a) => (ctx.acumatica.push(["PUT", ...a]), { ok: true, status: 200, text: "" }),
  },
});
mock.module("../../lib/salesforce.js", {
  namedExports: {
    sfQuery: async (soql) => (ctx.soql.push(soql), ctx.rows),
    soqlEscapeString: (v) => String(v),
    sfUpdateRecord: async (obj, id, fields) => (ctx.sfUpdates.push({ obj, id, fields }), { ok: true }),
  },
});
mock.module("../../lib/identity.js", {
  namedExports: { resolveIdentity: async () => ctx.identity },
});
mock.module("@aws-sdk/client-lambda", {
  namedExports: {
    LambdaClient: class {
      async send(cmd) {
        ctx.invokes.push(JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8")));
        return {};
      }
    },
    InvokeCommand: class {
      constructor(input) {
        this.input = input;
      }
    },
  },
});

const { handler } = await import("./index.js");

const httpEvent = (route) => ({
  httpMethod: "POST",
  resource: `/projects/{recordId}/budget/${route}`,
  path: `/projects/${RECORD_ID}/budget/${route}`,
  pathParameters: { recordId: RECORD_ID },
  headers: { authorization: "Bearer x", origin: "http://localhost:5173" },
});
const parse = (res) => JSON.parse(res.body);
const REFUSAL = { error: "integration_not_enabled", code: "INTEGRATION_NOT_ENABLED", message: "Acumatica isn't enabled for this account." };
const nothingHappened = () => {
  assert.equal(ctx.soql.length, 0, "no Salesforce read");
  assert.equal(ctx.sfUpdates.length, 0, "no Salesforce write (the status is never flipped to Pushing)");
  assert.equal(ctx.invokes.length, 0, "the worker is never started");
  assert.equal(ctx.acumatica.length, 0, "no Acumatica call");
};

test("budget push: a NON-primary tenant is refused 403 before any read, write, worker or Acumatica call", async () => {
  reset(DEMO);
  // Even a record that would pass every gate: the refusal comes first.
  ctx.rows = [{ Id: RECORD_ID, Acumatica_Project_ID__c: "R261065", Budget_Calc_Status__c: "Calculated", Commission_Deal_Type__c: "None", Sundial_Customer__r: { Synced_to_Acumatica__c: true } }];
  const res = await handler(httpEvent("push"));
  assert.equal(res.statusCode, 403);
  assert.deepEqual(parse(res), REFUSAL);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "http://localhost:5173");
  nothingHappened();
});

test("attributes-sync: a NON-primary tenant is refused 403 before any read or Acumatica call", async () => {
  reset(DEMO);
  ctx.rows = [{ Id: RECORD_ID, Acumatica_Project_ID__c: "R261065" }];
  const res = await handler(httpEvent("attributes-sync"));
  assert.equal(res.statusCode, 403);
  assert.deepEqual(parse(res), REFUSAL);
  nothingHappened();
});

test("both routes fail closed for a caller with a tenant id but no slug", async () => {
  for (const route of ["push", "attributes-sync"]) {
    reset({ tenantId: "a0XharmonTENANT", tenantSlug: null });
    const res = await handler(httpEvent(route));
    assert.equal(res.statusCode, 403);
    assert.equal(parse(res).code, "INTEGRATION_NOT_ENABLED");
    nothingHappened();
  }
});

test("budget push: the PRIMARY tenant is served as before — 202, status flipped, worker started with its slug", async () => {
  reset(HARMON);
  ctx.rows = [{ Id: RECORD_ID, Acumatica_Project_ID__c: "R261065", Budget_Calc_Status__c: "Calculated", Commission_Deal_Type__c: "None", Sundial_Customer__r: { Synced_to_Acumatica__c: true } }];
  const res = await handler(httpEvent("push"));
  assert.equal(res.statusCode, 202, res.body);
  assert.equal(parse(res).status, "Pushing");
  assert.equal(ctx.soql.length, 1);
  assert.match(ctx.soql[0], /Client__c = 'a0XharmonTENANT'/);
  assert.deepEqual(ctx.sfUpdates, [{ obj: "Sundial_Solar__c", id: RECORD_ID, fields: { Budget_Push_Status__c: "Pushing" } }]);
  assert.deepEqual(ctx.invokes, [{ __worker: true, recordId: RECORD_ID, acumaticaProjectId: "R261065", tenantId: "a0XharmonTENANT", tenantSlug: "harmon" }]);
});

test("attributes-sync: the PRIMARY tenant gets past the guard to the tenant-scoped read", async () => {
  reset(HARMON);
  ctx.rows = []; // not found → 404, which proves the read ran
  const res = await handler(httpEvent("attributes-sync"));
  assert.equal(res.statusCode, 404);
  assert.equal(parse(res).code, "RECORD_NOT_FOUND");
  assert.equal(ctx.soql.length, 1);
  assert.match(ctx.soql[0], /Client__c = 'a0XharmonTENANT'/);
});

test("a tenant named in SUNDIAL_ACUMATICA_TENANTS is served like the primary one", async () => {
  reset(DEMO);
  process.env.SUNDIAL_ACUMATICA_TENANTS = "conops-demo";
  ctx.rows = [];
  const res = await handler(httpEvent("push"));
  assert.equal(res.statusCode, 404, "past the guard, to the (empty) tenant-scoped read");
  assert.equal(ctx.soql.length, 1);
  delete process.env.SUNDIAL_ACUMATICA_TENANTS;
});

test("the WORKER re-checks: a payload carrying a non-primary slug does nothing — no budget lines, no commission POs", async () => {
  reset(null);
  const out = await handler({ __worker: true, recordId: RECORD_ID, acumaticaProjectId: "R261065", tenantId: DEMO.tenantId, tenantSlug: "conops-demo" });
  assert.deepEqual(out, { ok: false, error: "integration_not_enabled", code: "INTEGRATION_NOT_ENABLED" });
  nothingHappened();
});

test("the WORKER still runs a payload with the primary slug, and one with NO slug (an operator's direct invoke, or a push started before this deploy)", async () => {
  for (const payload of [
    { __worker: true, recordId: RECORD_ID, acumaticaProjectId: "R261065", tenantId: HARMON.tenantId, tenantSlug: "harmon" },
    { __worker: true, recordId: RECORD_ID, acumaticaProjectId: "R261065", tenantId: HARMON.tenantId },
  ]) {
    reset(null);
    ctx.rows = []; // the worker's own read finds nothing → it records the failure, as it always has
    const out = await handler(payload);
    assert.equal(out.error, "record_not_found");
    assert.equal(ctx.soql.length, 1, "the worker got as far as its Salesforce read");
    assert.equal(ctx.sfUpdates[0].fields.Budget_Push_Status__c, "Failed");
  }
});
