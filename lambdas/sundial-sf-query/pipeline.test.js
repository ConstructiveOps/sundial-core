// Handler-level tests for D-080 in sundial-sf-query: GET /sf/customer/pipeline and the
// list's f[] / not[] / sort, through the real handler with Salesforce and Supabase mocked.
// (The SQL function itself is tested against real Postgres in
// sql/sundial_customer_pipeline.test.js.)
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// Pinned:
//   - the pipeline goes through the SAME enforce path as the list: a rep's access filter
//     reaches the RPC's p_filters exactly as it reaches the list query;
//   - a closed module is 403 on both; a non-customer pipeline is 400;
//   - f[] on the access columns can't widen or replace the access filter (ignored);
//   - f[] repeats arrive through multiValueQueryStringParameters;
//   - total is the same with and without ?fields=list;
//   - an empty FILTERED page never falls to the live Salesforce path while the tenant
//     has cached rows.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolveScope, accessBlock } from "../../lib/access.js";

const TENANT = "a0XharmonTENANT";
const REP = "a1O7y00000REPAAAAA";
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

const ctx = { identity: null, ops: [], rpc: [], soql: [], rows: [], count: null, tenantRows: 5, rpcResult: null };
function reset() {
  ctx.ops = [];
  ctx.rpc = [];
  ctx.soql = [];
  ctx.rows = [];
  ctx.count = null;
  ctx.tenantRows = 5;
  ctx.rpcResult = { by_status: { Lead: 2 }, by_stage: { Lead: { New: 2 } }, reps: { Lead: [[REP, "Ann", 2]] }, sources: { Lead: [["Web", 2]] } };
  process.env.ACCESS_MODEL_MODE = "enforce";
  asAdmin();
}
function asAdmin() {
  const user = { id: "u1", hierarchyLevel: "Client", accessLevel: "Admin", dealer: null };
  ctx.identity = { tenantId: TENANT, tenantSlug: "harmon", user, access: accessBlock(resolveScope(user, TENANT)) };
}
function asRep() {
  const user = { id: REP, accessLevel: "Sales Rep", dealer: { id: "a0Y0000000DEALERAA", active: true, isInternal: false }, hierarchyLevel: "Sales Rep" };
  ctx.identity = { tenantId: TENANT, tenantSlug: "harmon", user, access: accessBlock(resolveScope(user, TENANT)) };
}

mock.module("../../lib/identity.js", { namedExports: { resolveIdentity: async () => ctx.identity } });
mock.module("../../lib/salesforce.js", {
  namedExports: {
    soqlEscapeString: (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    getSalesforceToken: async () => ({ access_token: "tok", instance_url: "https://example.my.salesforce.com" }),
    sfQuery: async (soql) => {
      ctx.soql.push(soql);
      return /COUNT\(Id\)/.test(soql) ? [{ c: 0 }] : [];
    },
  },
});

function builder(table) {
  const mine = [];
  ctx.ops.push({ table, ops: mine });
  const b = {
    select(sel, opts) { mine.push(["select", sel, opts?.count || null, !!opts?.head]); b.head = !!opts?.head; return b; },
    eq(c, v) { mine.push(["eq", c, v]); return b; },
    or(e) { mine.push(["or", e]); return b; },
    in(c, v) { mine.push(["in", c, v]); return b; },
    order(c, o) { mine.push(["order", c, o?.ascending]); return b; },
    limit() { return b; },
    async upsert() { return { error: null }; },
    async maybeSingle() { return { data: { finished_at: ago(1), expected_interval_s: 300 }, error: null }; },
    range() { return Promise.resolve({ data: ctx.rows, count: ctx.count ?? ctx.rows.length, error: null }); },
    then(res, rej) {
      // head-only count (the tenant probe)
      return Promise.resolve({ data: null, count: ctx.tenantRows, error: null }).then(res, rej);
    },
  };
  return b;
}
mock.module("../../lib/supabase.js", {
  namedExports: {
    getSupabaseClient: async () => ({
      from: (t) => builder(t),
      rpc: async (fn, args) => { ctx.rpc.push({ fn, args }); return { data: ctx.rpcResult, error: null }; },
    }),
    getSupabaseConfig: async () => ({ url: "https://supa.example.co", serviceRoleKey: "svc" }),
  },
});

const COLS = ["sf_id", "client_sf_id", "tenant_id", "created_date", "is_stale", "last_synced_at", "cache_version",
  "name", "status", "stage", "lead_source", "customer_type", "sales_rep_sf_id", "sales_rep_name", "dealer_sf_id", "call_attempts", "primary_email"];
globalThis.fetch = async (url) => {
  if (String(url).includes("/rest/v1/")) {
    const properties = Object.fromEntries(COLS.map((c) => [c, {}]));
    return { ok: true, status: 200, json: async () => ({ definitions: { sundial_customer_cache: { properties }, sundial_service_job_cache: { properties } } }) };
  }
  return {
    ok: true, status: 200,
    json: async () => ({ fields: [
      { name: "Id", type: "id" }, { name: "Client__c", type: "reference" }, { name: "Name", type: "string" },
      { name: "Status__c", type: "picklist" }, { name: "Stage__c", type: "picklist" }, { name: "Customer_Type__c", type: "multipicklist" },
      { name: "Sales_Rep__c", type: "reference" }, { name: "CreatedDate", type: "datetime" },
    ] }),
  };
};

const { _resetFreshnessMemo } = await import("./freshness.js");
const { handler } = await import("./index.js");

function ev(path, { qs = null, multi = null } = {}) {
  const parts = path.split("/").filter(Boolean); // sf, object, [id]
  return {
    requestContext: { http: { method: "GET" } },
    rawPath: path,
    pathParameters: { object: parts[1], ...(parts[2] && parts[2] !== "pipeline" ? { id: parts[2] } : {}) },
    queryStringParameters: qs,
    multiValueQueryStringParameters: multi,
    headers: { authorization: "Bearer t", origin: "http://localhost:5173" },
  };
}
const cacheOps = () => ctx.ops.filter((o) => o.table === "sundial_customer_cache").flatMap((o) => o.ops);
const row = (id, extra = {}) => ({ sf_id: id, client_sf_id: TENANT, name: "N", status: "Lead", primary_email: "e@x", created_date: "2026-01-01", last_synced_at: ago(1), is_stale: false, ...extra });

test.beforeEach(() => { reset(); _resetFreshnessMemo(); });

// --- pipeline ----------------------------------------------------------------------------

test("pipeline: Admin (tenant scope) → p_filters has no access columns; the answer is passed through", async () => {
  const res = await handler(ev("/sf/customer/pipeline"));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(ctx.rpc, [{ fn: "sundial_customer_pipeline", args: { p_client_sf_id: TENANT, p_filters: { eq: {} }, p_narrow: null } }]);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.by_status, { Lead: 2 });
  assert.deepEqual(body.reps.Lead, [[REP, "Ann", 2]]);
  assert.equal(body.narrowed, false);
});

test("the access filter reaches the pipeline's counts AND the list's rows alike (rep scope)", async () => {
  asRep();
  await handler(ev("/sf/customer/pipeline"));
  assert.deepEqual(ctx.rpc[0].args.p_filters, { eq: { sales_rep_sf_id: REP } });

  ctx.rows = [row("a1P000000000001AAA")];
  await handler(ev("/sf/customer", { qs: { "f[status]": "Lead" } }));
  const ops = cacheOps();
  assert.ok(ops.some(([op, c, v]) => op === "eq" && c === "sales_rep_sf_id" && v === REP), "list gets the same rep equality");
  assert.ok(ops.some(([op, c, v]) => op === "eq" && c === "client_sf_id" && v === TENANT));
});

test("a caller cannot pass an access column: f[sales_rep_sf_id] is ignored on the list and refused on the pipeline", async () => {
  asRep();
  ctx.rows = [row("a1P000000000001AAA")];
  await handler(ev("/sf/customer", { qs: { "f[sales_rep_sf_id]": "a1OsomeoneELSE" } }));
  const repEqs = cacheOps().filter(([op, c]) => op === "eq" && c === "sales_rep_sf_id");
  assert.ok(repEqs.length > 0, "the access filter is applied");
  assert.ok(repEqs.every(([, , v]) => v === REP), "only the access filter's value, never the caller's");
  assert.ok(!cacheOps().some((op) => op.includes("a1OsomeoneELSE")), "the caller's value appears nowhere");

  const res = await handler(ev("/sf/customer/pipeline", { qs: { "f[sales_rep_sf_id]": "x" } }));
  assert.equal(res.statusCode, 200, "ignored like the list — never honoured");
  assert.deepEqual(ctx.rpc.at(-1).args.p_filters, { eq: { sales_rep_sf_id: REP } });
  assert.equal(ctx.rpc.at(-1).args.p_narrow, null);
});

test("pipeline narrowing: repeated f[] via multiValueQueryStringParameters, '' = blank", async () => {
  const res = await handler(ev("/sf/customer/pipeline", {
    qs: { "f[stage]": "Odd" }, // what API Gateway leaves in the single-value map: the LAST one
    multi: { "f[stage]": ["", "Odd"], "f[lead_source]": ["Web"] },
  }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(ctx.rpc[0].args.p_narrow, { stage: { values: ["Odd"], blank: true }, lead_source: { values: ["Web"], blank: false } });
  assert.equal(JSON.parse(res.body).narrowed, true);
});

test("pipeline: a narrowing column outside stage/rep/source is 400; not[] is 400", async () => {
  assert.equal((await handler(ev("/sf/customer/pipeline", { qs: { "f[status]": "Lead" } }))).statusCode, 400);
  assert.equal((await handler(ev("/sf/customer/pipeline", { qs: { "not[stage]": "New" } }))).statusCode, 400);
  assert.equal(ctx.rpc.length, 0);
});

test("pipeline: any object but customer is 400 PIPELINE_UNSUPPORTED", async () => {
  const res = await handler(ev("/sf/job/pipeline"));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, "PIPELINE_UNSUPPORTED");
});

test("pipeline: a scope the list would 403 is 403 here too (Technician on customer)", async () => {
  const user = { id: "u9", hierarchyLevel: "Client", accessLevel: "Technician", dealer: null };
  ctx.identity = { tenantId: TENANT, tenantSlug: "harmon", user, access: accessBlock(resolveScope(user, TENANT)) };
  const list = await handler(ev("/sf/customer"));
  const pipe = await handler(ev("/sf/customer/pipeline"));
  assert.equal(list.statusCode, pipe.statusCode);
  assert.equal(pipe.statusCode, 403);
  assert.equal(ctx.rpc.length, 0);
});

test("pipeline: also recognised when API Gateway routes it as /sf/{object}/{id} with id 'pipeline'", async () => {
  const e = ev("/sf/customer/pipeline");
  e.pathParameters = { object: "customer", id: "pipeline" };
  assert.equal((await handler(e)).statusCode, 200);
  assert.equal(ctx.rpc.length, 1);
});

// --- list: f[] / not[] / sort ------------------------------------------------------------

test("list: f[] any-of from the multi-value map, not[] null-safe, sort allowlisted", async () => {
  ctx.rows = [row("a1P000000000001AAA")];
  const res = await handler(ev("/sf/customer", {
    qs: { "f[stage]": "B", "not[customer_type]": "Service", sort: "name:desc" },
    multi: { "f[status]": ["Lead"], "f[stage]": ["A", "B"], "not[customer_type]": ["Service"], sort: ["name:desc"] },
  }));
  assert.equal(res.statusCode, 200);
  const ops = cacheOps();
  assert.ok(ops.some(([op, c, v]) => op === "eq" && c === "status" && v === "Lead"));
  assert.ok(ops.some(([op, e]) => op === "or" && e === 'stage.in.("A","B")'), "both repeated values, not just the last");
  assert.ok(ops.some(([op, e]) => op === "or" && e === 'customer_type.is.null,customer_type.neq."Service"'));
  const orders = ops.filter(([op]) => op === "order");
  assert.deepEqual(orders.slice(0, 2), [["order", "name", false], ["order", "sf_id", true]]);
});

test("list: an unknown filter column is a 400 naming it; a bad sort is 400 INVALID_SORT", async () => {
  const a = await handler(ev("/sf/customer", { qs: { "f[favourite_colour]": "red" } }));
  assert.equal(a.statusCode, 400);
  assert.equal(JSON.parse(a.body).field, "favourite_colour");
  const b = await handler(ev("/sf/customer", { qs: { sort: "primary_email:asc" } }));
  assert.equal(b.statusCode, 400);
  assert.equal(JSON.parse(b.body).code, "INVALID_SORT");
  assert.equal(ctx.soql.length, 0);
});

test("list: total is the same with and without ?fields=list", async () => {
  ctx.rows = [row("a1P000000000001AAA"), row("a1P000000000002AAA")];
  ctx.count = 1234;
  const full = JSON.parse((await handler(ev("/sf/customer", { qs: { "f[status]": "Lead" } }))).body);
  _resetFreshnessMemo();
  const narrow = JSON.parse((await handler(ev("/sf/customer", { qs: { "f[status]": "Lead", fields: "list" } }))).body);
  assert.equal(full.total, 1234);
  assert.equal(narrow.total, full.total);
  assert.ok(full.records[0].primary_email && !narrow.records[0].primary_email, "only the row width differs");
});

test("list: an EMPTY filtered page stays on the cache (no Salesforce) while the tenant has rows", async () => {
  ctx.rows = [];
  ctx.tenantRows = 39000;
  const res = await handler(ev("/sf/customer", { qs: { "f[stage]": "Nothing Here" } }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.total, 0);
  assert.equal(body.source, "cache");
  assert.equal(ctx.soql.length, 0, "no live query for an ordinary empty column");
});

test("list: an empty filtered page with a genuinely EMPTY tenant cache still goes live, filters in SOQL", async () => {
  ctx.rows = [];
  ctx.tenantRows = 0;
  await handler(ev("/sf/customer", { qs: { "f[status]": "Lead", "not[customer_type]": "Service", sort: "name:asc" } }));
  const select = ctx.soql.find((s) => s.startsWith("SELECT ") && !/COUNT/.test(s));
  assert.match(select, /Status__c = 'Lead'/);
  assert.match(select, /\(Customer_Type__c = null OR Customer_Type__c != 'Service'\)/);
  assert.match(select, /ORDER BY Name ASC NULLS LAST, Id ASC/);
});

test("search: f[] / not[] narrow a ?q= search server-side", async () => {
  ctx.rows = [row("a1P000000000001AAA")];
  await handler(ev("/sf/customer", { qs: { q: "smith", "f[status]": "Lead", "not[customer_type]": "Service" } }));
  const ops = cacheOps();
  assert.ok(ops.some(([op, c, v]) => op === "eq" && c === "status" && v === "Lead"));
  assert.ok(ops.some(([op, e]) => op === "or" && e === 'customer_type.is.null,customer_type.neq."Service"'));
});

test("list: no new params → the query is exactly as before (default order)", async () => {
  ctx.rows = [row("a1P000000000001AAA")];
  await handler(ev("/sf/customer"));
  const ops = cacheOps();
  assert.ok(!ops.some(([op]) => op === "or"));
  assert.deepEqual(ops.filter(([op]) => op === "order").slice(0, 2), [["order", "created_date", false], ["order", "sf_id", true]]);
});
