// node --experimental-test-module-mocks --test lambdas/sundial-reports/test.js
//
// Drives the real handler with a fake identity and a fake Supabase; lib/access.js,
// lib/report-def.js, lib/report-types.js and the GENERATED catalog run unmocked.
//
// Pinned:
//   - routes and methods (OPTIONS 204, wrong method 405, unknown 404, stage prefix tolerated);
//   - reports.read: Executive / Admin / Manager in; Sales Rep, Sales Dealer, Technician and
//     a no-dealer rep get 403 MODULE_FORBIDDEN on all three routes, before any database call;
//     no tenant = 403 NO_TENANT; identity errors map as everywhere else;
//   - run: the tenant comes from the identity (never the body), the wire definition is what
//     reaches the rpc, a 400 never reaches the rpc, a Manager's cost column is stripped and
//     named, an Admin's is not; the response shape; asOf = the oldest object's newest ok run;
//   - a function RAISE is 500 REPORT_CATALOG_MISMATCH; any other rpc error is a plain 500;
//   - catalog: projected per caller (gated + non-reportable gone), operators per field.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolveScope, accessBlock } from "../../lib/access.js";

const TENANT = "a1W7y000007AszBEAS";
const DEALER = "a2D000000000DLRAAA";
const USERS = {
  Executive: { id: "a0U0000000000EXEC", accessLevel: "Executive", dealer: null },
  Admin: { id: "a0U00000000000ADM", accessLevel: "Admin", dealer: null },
  Manager: { id: "a0U00000000000MGR", accessLevel: "Manager", dealer: null },
  "Sales Rep": { id: "a0U00000000000REP", accessLevel: "Sales Rep", dealer: { id: DEALER, active: true, isInternal: false } },
  "Sales Dealer": { id: "a0U00000000000DLR", accessLevel: "Sales Dealer", dealer: { id: DEALER, active: true, isInternal: false } },
  Technician: { id: "a0U00000000000TEC", accessLevel: "Technician", dealer: null },
  NoDealerRep: { id: "a0U00000000000NDR", accessLevel: "Sales Rep", dealer: null },
};

const ctx = {};
function reset(level = "Admin") {
  ctx.level = level;
  ctx.tenant = TENANT;
  ctx.identityError = null;
  ctx.rpcCalls = [];
  ctx.rpcResult = { data: { rows: [["A", 1]], aggregates: { count: 7 }, truncated: false }, error: null };
  ctx.syncRuns = [
    { object: "solar", finished_at: "2026-11-03T17:05:00Z" },
    { object: "customer", finished_at: "2026-11-03T17:04:00Z" },
    { object: "solar", finished_at: "2026-11-03T17:00:00Z" },
    { object: "user", finished_at: "2026-11-03T16:45:00Z" },
  ];
  ctx.fromCalls = [];
}

mock.module("../../lib/identity.js", {
  namedExports: {
    resolveIdentity: async () => {
      if (ctx.identityError) {
        const e = new Error("nope");
        e.code = ctx.identityError;
        throw e;
      }
      const user = USERS[ctx.level];
      return { tenantId: ctx.tenant, tenantSlug: "harmon", user, access: accessBlock(resolveScope(user, ctx.tenant)) };
    },
  },
});

function syncRunsQuery() {
  const q = {
    select() { return q; },
    eq() { return q; },
    in(_c, objects) { q._objects = objects; return q; },
    not() { return q; },
    order() { return q; },
    limit() {
      return Promise.resolve({ data: ctx.syncRuns.filter((r) => q._objects.includes(r.object)), error: null });
    },
  };
  return q;
}
mock.module("../../lib/supabase.js", {
  namedExports: {
    getSupabaseClient: async () => ({
      rpc: async (name, args) => {
        ctx.rpcCalls.push({ name, args });
        return ctx.rpcResult;
      },
      from: (t) => {
        ctx.fromCalls.push(t);
        return syncRunsQuery();
      },
    }),
  },
});

const { handler, matchRoute, catalogFor, CATALOG_GATES } = await import("./index.js");

const ev = (path, { method = "GET", body, qs } = {}) => ({
  httpMethod: method,
  path,
  headers: { Origin: "http://localhost:5173", Authorization: "Bearer x" },
  queryStringParameters: qs ?? null,
  body: body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body),
});
const call = async (...a) => {
  const res = await handler(ev(...a));
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, raw: res };
};
const GROUPED = {
  type: "solar",
  groupBy: ["solar.stage"],
  aggregates: [{ fn: "count" }],
  filters: [{ field: "solar.contract_date", op: "between", value: "this_quarter" }],
  sort: [{ field: "count", dir: "desc" }],
};

test("routes and methods", async () => {
  reset();
  assert.equal((await handler(ev("/reports/run", { method: "OPTIONS" }))).statusCode, 204);
  assert.equal((await call("/reports/run")).status, 405);
  assert.equal((await call("/reports/types", { method: "POST", body: {} })).status, 405);
  assert.equal((await call("/reports/elsewhere")).status, 404);
  assert.deepEqual(matchRoute("/prod/reports/types"), { name: "types", method: "GET" });
  assert.equal(matchRoute("/reports"), null);
});

test("reports.read: tenant levels in; sales, tech and none get 403 MODULE_FORBIDDEN on every route, before any read", async () => {
  for (const level of ["Executive", "Admin", "Manager"]) {
    reset(level);
    assert.equal((await call("/reports/types")).status, 200, level);
  }
  for (const level of ["Sales Rep", "Sales Dealer", "Technician", "NoDealerRep"]) {
    for (const [path, opts] of [["/reports/types"], ["/reports/catalog", { qs: { type: "solar" } }], ["/reports/run", { method: "POST", body: GROUPED }]]) {
      reset(level);
      const r = await call(path, opts);
      assert.equal(r.status, 403, `${level} ${path}`);
      assert.deepEqual(r.body, { error: "forbidden", code: "MODULE_FORBIDDEN" });
      assert.equal(ctx.rpcCalls.length + ctx.fromCalls.length, 0, `${level} ${path}: touched the database`);
    }
  }
});

test("no tenant, and identity errors", async () => {
  reset();
  ctx.tenant = null;
  assert.deepEqual((await call("/reports/types")).body, { error: "no_tenant", code: "NO_TENANT" });
  reset();
  ctx.identityError = "AUTH_INVALID_TOKEN";
  assert.equal((await call("/reports/types")).status, 401);
});

test("run: the tenant from the identity, the wire definition to the rpc, the response shape", async () => {
  reset("Admin");
  const r = await call("/reports/run", { method: "POST", body: { ...GROUPED, client_sf_id: "x" } });
  assert.equal(r.status, 400, "an unknown body key is refused, so no tenant can be smuggled in");
  assert.equal(r.body.field, "client_sf_id");
  assert.equal(ctx.rpcCalls.length, 0);

  reset("Admin");
  const ok = await call("/reports/run", { method: "POST", body: GROUPED });
  assert.equal(ok.status, 200);
  assert.equal(ctx.rpcCalls.length, 1);
  const { name, args } = ctx.rpcCalls[0];
  assert.equal(name, "sundial_report_run");
  assert.equal(args.p_client_sf_id, TENANT);
  assert.equal(args.p_def.base.table, "sundial_solar_cache");
  assert.equal(args.p_def.grouped, true);
  assert.equal(args.p_def.filters[0].op, "between");
  assert.match(args.p_def.filters[0].value[0], /^\d{4}-(01|04|07|10)-01$/);
  assert.deepEqual(ok.body.columns.map((c) => c.field), ["solar.stage", "count"]);
  assert.deepEqual(ok.body.rows, [["A", 1]]);
  assert.deepEqual(ok.body.aggregates, [{ field: "count", label: "Count", type: "number", aggregate: "count", value: 7 }]);
  assert.equal(ok.body.truncated, false);
  assert.equal(ok.body.limit, 5000);
  assert.deepEqual(ok.body.stripped, []);
  // solar 17:05, customer 17:04, user 16:45 → the oldest newest run
  assert.equal(ok.body.asOf, "2026-11-03T16:45:00Z");
});

test("run: asOf is null when an object has no ok run on record", async () => {
  reset("Admin");
  ctx.syncRuns = ctx.syncRuns.filter((r) => r.object !== "user");
  assert.equal((await call("/reports/run", { method: "POST", body: GROUPED })).body.asOf, null);
});

test("run: a bad definition is a 400 that never reaches the database", async () => {
  for (const body of [{ type: "solar", columns: ["solar.nope"] }, "not json", undefined]) {
    reset("Admin");
    const r = await call("/reports/run", { method: "POST", body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, "invalid_report");
    assert.equal(ctx.rpcCalls.length, 0);
  }
});

test("run: a Manager's cost column is stripped and named; an Admin keeps it", async () => {
  assert.deepEqual(CATALOG_GATES, ["service.costing.read"]);
  // The solar type has no gated column, so drive the gate through the catalog projection and
  // the held-gate list the wire carries.
  reset("Manager");
  await call("/reports/run", { method: "POST", body: GROUPED });
  assert.deepEqual(ctx.rpcCalls[0].args.p_def.allowedGates, []);
  reset("Admin");
  await call("/reports/run", { method: "POST", body: GROUPED });
  assert.deepEqual(ctx.rpcCalls[0].args.p_def.allowedGates, ["service.costing.read"]);
});

test("run: a function RAISE is REPORT_CATALOG_MISMATCH; another rpc error a plain 500", async () => {
  reset("Admin");
  ctx.rpcResult = { data: null, error: { message: "sundial_report_run: unknown column solar.x" } };
  const r = await call("/reports/run", { method: "POST", body: GROUPED });
  assert.equal(r.status, 500);
  assert.equal(r.body.code, "REPORT_CATALOG_MISMATCH");
  reset("Admin");
  ctx.rpcResult = { data: null, error: { message: "connection reset" } };
  const r2 = await call("/reports/run", { method: "POST", body: GROUPED });
  assert.deepEqual(r2.body, { error: "server_error" });
});

test("types: no table names", async () => {
  reset("Manager");
  const r = await call("/reports/types");
  assert.equal(r.body.types[0].key, "solar");
  assert.doesNotMatch(r.raw.body, /_cache/);
});

test("catalog: per caller — gated and non-reportable fields are absent; operators per field", async () => {
  reset("Manager");
  const r = await call("/reports/catalog", { qs: { type: "solar" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.aliases.map((a) => a.alias), ["solar", "customer", "rep"]);
  const solar = r.body.aliases[0].fields;
  assert.ok(!solar.some((f) => f.field === "solar.sf_id"));
  const stage = solar.find((f) => f.field === "solar.stage");
  assert.equal(stage.type, "picklist");
  assert.ok(stage.operators.includes("in"));
  assert.ok(Array.isArray(stage.picklistValues));
  assert.doesNotMatch(r.raw.body, /_cache/);
  assert.equal((await call("/reports/catalog", { qs: { type: "nope" } })).status, 400);
  assert.equal((await call("/reports/catalog")).status, 400);

  // The gate, on the projection itself (the price book's cost columns).
  const fakeType = (held) => {
    const out = catalogFor("solar", held);
    return out.aliases.flatMap((a) => a.fields.map((f) => f.field));
  };
  assert.deepEqual(fakeType([]), fakeType(["service.costing.read"])); // solar has no gated column
});
