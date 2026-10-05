// Tests for the D-079 list path in sundial-sf-query: the freshness rule wired into the
// list read, and ?fields=list (the list projection).
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// Salesforce, Supabase and the describe / OpenAPI fetches are mocked at the module
// boundary. What is pinned:
//   - HEALTHY sync: clock-old rows are served from the cache with ZERO SOQL; only a row
//     flagged is_stale is re-fetched.
//   - UNHEALTHY sync: exactly the pre-D-079 behaviour (clock-old rows re-fetched).
//   - ?fields=list narrows the SELECT and the response; without it nothing changes.
//   - LIST_PROJECTION covers every column the harmon-crm list screens read
//     (LIST_PROJECTION_SOURCES below, with file evidence). A column missing from the
//     projection renders BLANK on that screen — this test is the guard.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolveScope, accessBlock } from "../../lib/access.js";

const TENANT = "a0XharmonTENANT";
const NOW = Date.now();
const ago = (min) => new Date(NOW - min * 60 * 1000).toISOString();

const ctx = { soql: [], selects: [], upserts: [], cacheRows: [], run: null, runQueries: 0 };
function resetCtx() {
  ctx.soql = [];
  ctx.selects = [];
  ctx.upserts = [];
  ctx.cacheRows = [];
  ctx.run = null;
  ctx.runQueries = 0;
}

const user = { id: "u1", hierarchyLevel: "Client", accessLevel: "Admin", dealer: null };
mock.module("../../lib/identity.js", {
  namedExports: {
    resolveIdentity: async () => ({ tenantId: TENANT, tenantSlug: "harmon", user, access: accessBlock(resolveScope(user, TENANT)) }),
  },
});

mock.module("../../lib/salesforce.js", {
  namedExports: {
    soqlEscapeString: (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    getSalesforceToken: async () => ({ access_token: "tok", instance_url: "https://example.my.salesforce.com" }),
    sfQuery: async (soql) => {
      ctx.soql.push(soql);
      const ids = [...soql.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      // Return a fresh copy of every cached row whose id was asked for.
      return ctx.cacheRows
        .filter((r) => ids.includes(r.sf_id))
        .map((r) => ({ Id: r.sf_id, Client__c: TENANT, Name: r.name, Stage__c: r.stage, CreatedDate: r.created_date }));
    },
  },
});

function builder(table) {
  const b = {
    select(sel) { if (table !== "cache_sync_runs") ctx.selects.push(sel); return b; },
    eq() { return b; },
    or() { return b; },
    in() { return b; },
    order() { return b; },
    limit() { return b; },
    delete() { return b; },
    async upsert(rows) { ctx.upserts.push(...rows); return { error: null }; },
    async maybeSingle() {
      ctx.runQueries++;
      return { data: ctx.run, error: null };
    },
    range() {
      return Promise.resolve({ data: ctx.cacheRows, count: ctx.cacheRows.length, error: null });
    },
  };
  return b;
}
mock.module("../../lib/supabase.js", {
  namedExports: {
    getSupabaseClient: async () => ({ from: (t) => builder(t) }),
    getSupabaseConfig: async () => ({ url: "https://supa.example.co", serviceRoleKey: "svc" }),
  },
});

const CACHE_COLUMNS = [
  "sf_id", "client_sf_id", "tenant_id", "created_date", "is_stale", "last_synced_at", "cache_version",
  "name", "first_name", "last_name", "stage", "status", "city", "primary_email", "notes", "sales_rep_sf_id",
];
globalThis.fetch = async (url) => {
  if (String(url).includes("/rest/v1/")) {
    const properties = Object.fromEntries(CACHE_COLUMNS.map((c) => [c, {}]));
    return { ok: true, status: 200, json: async () => ({ definitions: { sundial_customer_cache: { properties } } }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      fields: [
        { name: "Id", type: "id" },
        { name: "Client__c", type: "reference" },
        { name: "Name", type: "string" },
        { name: "Stage__c", type: "picklist" },
        { name: "CreatedDate", type: "datetime" },
      ],
    }),
  };
};

const { _resetFreshnessMemo } = await import("./freshness.js");
const { handler, LIST_PROJECTION, listProjectionFor, buildProjectedSelect, applyListProjection } = await import("./index.js");

function listEvent(query = {}) {
  return {
    requestContext: { http: { method: "GET" } },
    rawPath: "/sf/customer",
    pathParameters: { object: "customer" },
    queryStringParameters: Object.keys(query).length ? query : null,
    headers: { authorization: "Bearer t", origin: "http://localhost:5173" },
  };
}
const row = (id, extra = {}) => ({
  sf_id: id, client_sf_id: TENANT, name: `Cust ${id}`, first_name: "A", last_name: "B", stage: "Lead",
  status: "Lead", city: "Phoenix", primary_email: "x@example.com", notes: "long text",
  created_date: "2026-01-01T00:00:00Z", last_synced_at: ago(600), is_stale: false, cache_version: 1, ...extra,
});

test.beforeEach(() => {
  resetCtx();
  _resetFreshnessMemo();
});

// --- freshness wired into the list read ---------------------------------------

test("HEALTHY sync: clock-old rows are served from the cache with zero SOQL", async () => {
  ctx.run = { finished_at: ago(2), expected_interval_s: 300 };
  ctx.cacheRows = [row("a1P000000000001AAA"), row("a1P000000000002AAA")];
  const res = await handler(listEvent({ limit: "5000" }));
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.source, "cache");
  assert.equal(ctx.soql.length, 0, "no Salesforce round trip");
  assert.equal(ctx.upserts.length, 0, "no cache rewrite");
});

test("HEALTHY sync: only the row flagged is_stale is re-fetched", async () => {
  ctx.run = { finished_at: ago(2), expected_interval_s: 300 };
  ctx.cacheRows = [row("a1P000000000001AAA"), row("a1P000000000002AAA", { is_stale: true })];
  const body = JSON.parse((await handler(listEvent())).body);
  assert.equal(body.source, "cache+salesforce");
  assert.equal(ctx.soql.length, 1);
  assert.match(ctx.soql[0], /a1P000000000002AAA/);
  assert.doesNotMatch(ctx.soql[0], /a1P000000000001AAA/);
  assert.deepEqual(ctx.upserts.map((r) => r.sf_id), ["a1P000000000002AAA"]);
});

test("UNHEALTHY sync: falls back to the 10-minute TTL (clock-old rows re-fetched)", async () => {
  ctx.run = { finished_at: ago(60), expected_interval_s: 300 };
  ctx.cacheRows = [row("a1P000000000001AAA"), row("a1P000000000002AAA", { last_synced_at: ago(1) })];
  const body = JSON.parse((await handler(listEvent())).body);
  assert.equal(body.source, "cache+salesforce");
  assert.equal(ctx.soql.length, 1);
  assert.match(ctx.soql[0], /a1P000000000001AAA/, "the 600-minute-old row is refreshed");
  assert.doesNotMatch(ctx.soql[0], /a1P000000000002AAA/, "the 1-minute-old row is not");
});

test("NO run row (table not created yet): same as today", async () => {
  ctx.run = null;
  ctx.cacheRows = [row("a1P000000000001AAA")];
  await handler(listEvent());
  assert.equal(ctx.soql.length, 1);
});

test("the run lookup happens once per request, then is memoised across requests", async () => {
  ctx.run = { finished_at: ago(2), expected_interval_s: 300 };
  ctx.cacheRows = [row("a1P000000000001AAA")];
  await handler(listEvent());
  await handler(listEvent({ offset: "5000" }));
  assert.equal(ctx.runQueries, 1);
});

// --- ?fields=list ---------------------------------------------------------------

test("?fields=list narrows the SELECT to list + control columns", async () => {
  ctx.run = { finished_at: ago(2), expected_interval_s: 300 };
  ctx.cacheRows = [row("a1P000000000001AAA")];
  await handler(listEvent({ fields: "list" }));
  const cols = ctx.selects[0].split(",");
  for (const c of ["sf_id", "name", "stage", "status", "city", "is_stale", "last_synced_at", "cache_version"]) {
    assert.ok(cols.includes(c), `select keeps ${c}`);
  }
  for (const c of ["primary_email", "notes"]) assert.ok(!cols.includes(c), `select drops ${c}`);
});

test("?fields=list narrows the response rows; without it the rows are unchanged", async () => {
  ctx.run = { finished_at: ago(2), expected_interval_s: 300 };
  ctx.cacheRows = [row("a1P000000000001AAA")];
  const narrow = JSON.parse((await handler(listEvent({ fields: "list" }))).body).records[0];
  assert.equal(narrow.sf_id, "a1P000000000001AAA");
  assert.equal(narrow.name, "Cust a1P000000000001AAA");
  assert.equal(narrow.primary_email, undefined);
  assert.equal(narrow.cache_version, undefined, "control columns used by the partition are not echoed");
  for (const k of Object.keys(narrow)) assert.ok(LIST_PROJECTION.customer.includes(k), `${k} is a list column`);

  _resetFreshnessMemo();
  const full = JSON.parse((await handler(listEvent())).body).records[0];
  assert.equal(full.primary_email, "x@example.com", "no ?fields=list → full row as before");
});

test("?fields=list on a stale row narrows the REFRESHED row too", async () => {
  ctx.run = { finished_at: ago(2), expected_interval_s: 300 };
  ctx.cacheRows = [row("a1P000000000001AAA", { is_stale: true })];
  const rec = JSON.parse((await handler(listEvent({ fields: "list" }))).body).records[0];
  for (const k of Object.keys(rec)) assert.ok(LIST_PROJECTION.customer.includes(k), `${k} is a list column`);
  assert.equal(ctx.upserts.length, 1, "but the cache still gets the full refreshed row");
});

test("listProjectionFor: only ?fields=list, only listed objects", () => {
  assert.equal(listProjectionFor("customer", {}), null);
  assert.equal(listProjectionFor("customer", { fields: "all" }), null);
  assert.ok(listProjectionFor("customer", { fields: "LIST" }));
  assert.equal(listProjectionFor("pricebookitem", { fields: "list" }), null, "price book keeps full rows (edit modal reuses them)");
  assert.equal(listProjectionFor("user", { fields: "list" }), null);
});

test("applyListProjection can only remove keys — never re-add one access projection dropped", () => {
  const accessProjected = { sf_id: "x", name: "N" }; // e.g. a role that may not see `stage`
  const out = applyListProjection(accessProjected, LIST_PROJECTION.customer);
  assert.deepEqual(out, { sf_id: "x", name: "N" });
  assert.equal(applyListProjection(accessProjected, null), accessProjected);
});

test("buildProjectedSelect only names columns the cache has, and always the control columns", () => {
  const set = new Set(["sf_id", "name", "is_stale", "last_synced_at", "cache_version", "client_sf_id", "created_date", "tenant_id"]);
  const sel = buildProjectedSelect(["sf_id", "name", "no_such_column"], set).split(",");
  assert.ok(!sel.includes("no_such_column"));
  for (const c of ["sf_id", "name", "is_stale", "last_synced_at", "cache_version"]) assert.ok(sel.includes(c));
  assert.equal(buildProjectedSelect(["sf_id"], new Set()), "*", "no introspection → today's fallback");
});

// --- the projection against the frontend's column lists ------------------------------
// Every row key each harmon-crm list screen reads (traced 2026-10-05 through tables,
// boards, filters, sorts and helpers). Paths are relative to harmon-crm/src. Adding a
// column to a list screen means adding it HERE and to LIST_PROJECTION.
const LIST_PROJECTION_SOURCES = {
  customer: {
    "pages/SalesPage.tsx + components/sales/{CustomersTable,CustomersBoard,helpers}.tsx + config/customer-status-columns.ts": [
      "sf_id", "customer_type", "status", "stage", "sales_rep_name", "lead_source", "first_name", "last_name", "name",
      "street", "city", "state", "postal_code", "primary_phone", "requested_project_types", "call_attempts",
    ],
    "pages/service/ServiceCustomersPage.tsx + lib/service-customers.ts": [
      "sf_id", "archived", "service_stage", "status", "assigned_to_sf_id", "service_request_type", "created_date",
      "next_follow_up_date", "first_name", "last_name", "name", "street", "city", "state", "postal_code",
      "lead_source", "last_contact_date", "customer_type",
    ],
  },
  solar: {
    "pages/DashboardPage.tsx + pages/SolarProjectsPage.tsx + components/solar/{ProjectsTable,ProjectsBoard,record-display}": [
      "sf_id", "stage", "system_size", "system_size_kw", "contract_amount", "last_synced_at", "project_name",
      "first_name", "last_name", "customer_name_at_creation", "address", "address_at_creation", "harmon_job_number",
      "contract_type", "authority_having_jurisdiction", "utility_company", "project_manager", "sales_rep_name",
    ],
  },
  roofing: {
    "pages/RoofingProjectsPage.tsx + components/roofing/{ProjectsTable,ProjectsBoard,record-display}": [
      "sf_id", "stage", "project_name", "first_name", "last_name", "customer_name_at_creation",
      "contract_presented_amount", "total_proposal_cost",
    ],
  },
  job: {
    "pages/service/ServiceJobsPage.tsx + components/service/reportMarker.ts": [
      "sf_id", "archived", "status", "created_date", "name", "customer_name_at_creation", "address_at_creation",
      "priority", "estimate_status", "estimate_total", "bill_to_type", "report_sent_at", "intake_date",
    ],
  },
  estimate: {
    "pages/service/ServiceEstimatesPage.tsx": [
      "sf_id", "is_template", "status", "archived", "created_date", "name", "template_name",
      "customer_name_at_creation", "version", "total", "service_job_sf_id", "last_sent_at", "valid_until",
    ],
  },
  serviceinvoice: {
    "pages/service/ServiceInvoicesPage.tsx": [
      "sf_id", "status", "acumatica_entered_at", "issued_at", "created_date", "service_job_sf_id", "name",
      "bill_to_type", "bill_to_name", "billing_reference", "total", "paid_amount", "balance", "due_date",
    ],
  },
};

for (const [object, screens] of Object.entries(LIST_PROJECTION_SOURCES)) {
  test(`LIST_PROJECTION.${object} covers every column its list screens read`, () => {
    const proj = LIST_PROJECTION[object];
    assert.ok(Array.isArray(proj), `${object} has a projection`);
    for (const [screen, cols] of Object.entries(screens)) {
      const missing = cols.filter((c) => !proj.includes(c));
      assert.deepEqual(missing, [], `${screen} reads ${missing.join(", ")} which ?fields=list would blank`);
    }
  });
}

test("every projected object is one the frontend lists (no orphan projections)", () => {
  assert.deepEqual(Object.keys(LIST_PROJECTION).sort(), Object.keys(LIST_PROJECTION_SOURCES).sort());
});
