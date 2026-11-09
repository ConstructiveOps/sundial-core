// GET /sf/search?q= (2026-11-09): the header search as ONE request. Five cache legs in one
// invocation — tenant-scoped, the access row filter ahead of the ILIKE group, the module
// gate per leg, a failing leg its own `error`, never a Salesforce fallback.
//
// Run with:  node --experimental-test-module-mocks --test lambdas/sundial-sf-query/global-search.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolveScope, accessBlock } from "../../lib/access.js";

const TENANT = "a0XharmonTENANT";
const REP_A = "a1O7y00000REPAAAAA";
const DEALER = "a0Y0000000DEALERAA";

const ctx = { identity: null, queries: [], rows: {}, failTables: new Set() };
function identityFor(user) {
  return { user, tenantId: TENANT, tenantSlug: "harmon", access: accessBlock(resolveScope(user, TENANT)) };
}
function reset() {
  ctx.identity = identityFor({ id: "u1", hierarchyLevel: "Client", accessLevel: "Admin", dealer: null });
  delete process.env.ACCESS_MODEL_MODE;
  ctx.queries = [];
  ctx.rows = {};
  ctx.failTables = new Set();
}

mock.module("../../lib/identity.js", { namedExports: { resolveIdentity: async () => ctx.identity } });
mock.module("../../lib/salesforce.js", {
  namedExports: {
    soqlEscapeString: (v) => String(v).replace(/'/g, "\\'"),
    getSalesforceToken: async () => { throw new Error("Salesforce must never be called by the global search"); },
    sfQuery: async () => { throw new Error("Salesforce must never be called by the global search"); },
  },
});

// A PostgREST stand-in that records what each leg asked for and answers from ctx.rows.
function makeBuilder(table) {
  const rec = { table, select: null, eqs: [], ors: [], range: null };
  ctx.queries.push(rec);
  const b = {
    select(sel, opts) { rec.select = sel; rec.count = !!opts?.count; return b; },
    eq(c, v) { rec.eqs.push({ column: c, value: v }); return b; },
    or(expr) { rec.ors.push(expr); return b; },
    order() { return b; },
    range(from, to) {
      rec.range = [from, to];
      if (ctx.failTables.has(table)) return Promise.resolve({ data: null, count: null, error: { message: "boom" } });
      const all = (ctx.rows[table] || []).filter((r) => rec.eqs.every(({ column, value }) => r[column] === value));
      return Promise.resolve({ data: all.slice(from, to + 1), count: all.length, error: null });
    },
  };
  return b;
}
mock.module("../../lib/supabase.js", {
  namedExports: {
    getSupabaseClient: async () => ({ from: (t) => makeBuilder(t) }),
    getSupabaseConfig: async () => ({ url: "https://supa.example.co", serviceRoleKey: "svc" }),
  },
});

const COMMON = ["sf_id", "client_sf_id", "created_date", "is_stale", "last_synced_at", "cache_version", "sales_rep_sf_id", "dealer_sf_id", "sundial_customer_sf_id"];
const TABLES = {
  sundial_customer_cache: [...COMMON, "name", "first_name", "last_name", "is_company", "company_name", "street", "city", "state", "postal_code", "primary_phone", "customer_type", "primary_email", "description"],
  sundial_solar_cache: [...COMMON, "project_name", "first_name", "last_name", "customer_name_at_creation", "address", "address_at_creation", "stage"],
  sundial_roofing_cache: [...COMMON, "project_name", "customer_name_at_creation", "address_at_creation"],
  sundial_service_job_cache: [...COMMON, "name", "customer_name_at_creation", "address_at_creation", "status", "billing_reference"],
  sundial_estimate_cache: [...COMMON, "name", "customer_name_at_creation", "address_at_creation", "status", "template_name", "bill_to_name"],
};
globalThis.fetch = async (url) => {
  if (String(url).includes("/rest/v1/")) {
    const definitions = Object.fromEntries(Object.entries(TABLES).map(([t, cols]) => [t, { properties: Object.fromEntries(cols.map((c) => [c, {}])) }]));
    return { ok: true, status: 200, json: async () => ({ definitions }) };
  }
  return { ok: true, status: 200, json: async () => ({ fields: [] }) };
};

const { handler, globalSearchObjects, globalSearchLimit } = await import("./index.js");

function searchEvent(query) {
  return {
    requestContext: { http: { method: "GET" } },
    rawPath: "/sf/search",
    pathParameters: null,
    queryStringParameters: query,
    headers: { authorization: "Bearer test.jwt", origin: "http://localhost:5173" },
  };
}
const row = (table, sf_id, extra = {}) => ({ sf_id, client_sf_id: TENANT, created_date: "2026-01-01T00:00:00Z", ...extra });

test.beforeEach(reset);

test("one request, five groups: each leg tenant-scoped, ILIKE'd on its own columns, selected narrow, capped per leg with the exact total", async () => {
  ctx.rows.sundial_customer_cache = [row("c", "a1P1", { name: "Ann Lee", street: "1 Main" }), row("c", "a1P2", { name: "Ann Lee 2" }), row("c", "a1Px", { client_sf_id: "OTHER", name: "Ann Other" })];
  ctx.rows.sundial_service_job_cache = Array.from({ length: 8 }, (_, i) => row("j", `a1J${i}`, { name: `SVC-${i}`, status: "Open" }));
  const res = await handler(searchEvent({ q: "Ann", limit: "3" }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.source, "cache");
  assert.equal(body.q, "Ann");
  assert.equal(body.limit, 3);
  assert.deepEqual(Object.keys(body.groups), ["customer", "solar", "roofing", "job", "estimate"]);
  // customers: the other tenant's row never comes back
  assert.deepEqual(body.groups.customer.records.map((r) => r.sf_id), ["a1P1", "a1P2"]);
  assert.equal(body.groups.customer.total, 2);
  // jobs: 3 of 8, the total exact
  assert.equal(body.groups.job.count, 3);
  assert.equal(body.groups.job.total, 8);
  assert.equal(body.total, 10);
  // every leg: client_sf_id first, then the search OR-group, a narrow select, the per-leg range
  for (const q of ctx.queries) {
    assert.deepEqual(q.eqs[0], { column: "client_sf_id", value: TENANT }, q.table);
    assert.equal(q.ors.length, 1, q.table);
    assert.match(q.ors[0], /ilike\."%Ann%"/, q.table);
    assert.deepEqual(q.range, [0, 2], q.table);
    assert.ok(q.count, `${q.table} asks for the exact count`);
  }
  const cust = ctx.queries.find((q) => q.table === "sundial_customer_cache");
  assert.ok(cust.select.includes("street") && !cust.select.includes("description") && !cust.select.includes("primary_email"), "a hit's columns only — never a long-text column");
  const roof = ctx.queries.find((q) => q.table === "sundial_roofing_cache");
  assert.equal(roof.select, "sf_id,project_name,customer_name_at_creation,address_at_creation", "a column the cache lacks is left out of the select");
  assert.match(cust.ors[0], /company_name\.ilike/);
  assert.match(ctx.queries.find((q) => q.table === "sundial_service_job_cache").ors[0], /billing_reference\.ilike/, "the partner's number finds a job here too");
});

test("objects= picks the legs (unknown names ignored); a too-short or missing term is a 400; limit is clamped", async () => {
  const res = await handler(searchEvent({ q: "Lee", objects: "customer,job,bogus" }));
  const body = JSON.parse(res.body);
  assert.deepEqual(Object.keys(body.groups), ["customer", "job"]);
  assert.equal(ctx.queries.length, 2, "only the asked legs run a query");
  assert.equal((await handler(searchEvent({ q: "a" }))).statusCode, 400);
  assert.equal(JSON.parse((await handler(searchEvent({}))).body).code, "SEARCH_TERM_REQUIRED");
  assert.deepEqual(globalSearchObjects(""), ["customer", "solar", "roofing", "job", "estimate"]);
  assert.deepEqual(globalSearchObjects("JOB, estimate"), ["job", "estimate"]);
  assert.equal(globalSearchLimit(undefined), 5);
  assert.equal(globalSearchLimit("500"), 20);
  assert.equal(globalSearchLimit("0"), 5);
});

test("a failing leg is its own error; the others still answer", async () => {
  ctx.rows.sundial_customer_cache = [row("c", "a1P1", { name: "Lee" })];
  ctx.failTables.add("sundial_solar_cache");
  const body = JSON.parse((await handler(searchEvent({ q: "Lee" }))).body);
  assert.equal(body.groups.solar.error, true);
  assert.equal(body.groups.solar.total, 0);
  assert.equal(body.groups.customer.total, 1);
  assert.equal(body.groups.job.error, undefined);
});

test("enforce: a Sales Rep's customer / solar legs carry the row filter ahead of the term; the Service legs are forbidden with no query", async () => {
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor({ id: REP_A, accessLevel: "Sales Rep", hierarchyLevel: "Sales Rep", dealer: { id: DEALER, active: true, isInternal: false } });
  ctx.rows.sundial_customer_cache = [row("c", "a1P1", { name: "Lee", sales_rep_sf_id: REP_A }), row("c", "a1P2", { name: "Lee B", sales_rep_sf_id: "someoneelse" })];
  const body = JSON.parse((await handler(searchEvent({ q: "Lee" }))).body);
  assert.deepEqual(body.groups.customer.records.map((r) => r.sf_id), ["a1P1"], "the rep sees only their own book");
  assert.equal(body.groups.customer.total, 1);
  assert.equal(body.groups.job.forbidden, true);
  assert.equal(body.groups.estimate.forbidden, true);
  assert.ok(!ctx.queries.some((q) => q.table === "sundial_service_job_cache" || q.table === "sundial_estimate_cache"), "a forbidden leg runs no query");
  const cust = ctx.queries.find((q) => q.table === "sundial_customer_cache");
  const repEq = cust.eqs.findIndex((e) => e.column === "sales_rep_sf_id");
  assert.ok(repEq > 0, "the rep filter is an eq on the cache");
  assert.equal(cust.ors.length, 1, "the term is the only OR-group, AND-ed after the filter");
});

test("enforce: a `none` scope gets every group forbidden and no query at all", async () => {
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor({ id: "t1", accessLevel: "Technician", hierarchyLevel: "Technician", dealer: null });
  const res = await handler(searchEvent({ q: "Lee" }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Object.values(body.groups).every((g) => g.forbidden === true));
  assert.equal(ctx.queries.length, 0);
});
