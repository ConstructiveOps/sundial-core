// Tests for the ?parentId= related-list filter on GET /sf/{object} (sundial-sf-query).
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// Salesforce, Supabase, and the two describe/introspection fetches are mocked at
// the module boundary — no network, no AWS, no Salesforce org is touched.
//
// The property under test is CONTAINMENT: ?parentId= must narrow a result set and
// must never widen one. The cases that matter are the compositions —
// parent + tenant, parent + Sales-Rep restriction, parent + search, and the
// zero-row path where an empty related list looks exactly like a cold cache.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const TENANT = "a0XharmonTENANT";
const CUSTOMER_A = "a1P000000000001AAA";
const CUSTOMER_B = "a1P000000000002AAA";

const ctx = {
  identity: { tenantId: TENANT, tenantSlug: "harmon", user: { id: "u1", hierarchyLevel: "Client" } },
  soqlSeen: [], // every SOQL string issued
  cacheFilters: [], // every {column, value} applied to a cache query
  cacheRows: [], // rows the cache returns
  cacheCount: 0, // exact count the cache reports
  sfRows: [], // rows Salesforce returns for the live path
};

function resetCtx() {
  ctx.identity = {
    tenantId: TENANT,
    tenantSlug: "harmon",
    user: { id: "u1", hierarchyLevel: "Client" },
  };
  ctx.soqlSeen = [];
  ctx.cacheFilters = [];
  ctx.cacheRows = [];
  ctx.cacheCount = 0;
  ctx.sfRows = [];
}

mock.module("../../lib/identity.js", {
  exports: { resolveIdentity: async () => ctx.identity },
});

mock.module("../../lib/salesforce.js", {
  exports: {
    soqlEscapeString: (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    getSalesforceToken: async () => ({
      access_token: "tok",
      instance_url: "https://example.my.salesforce.com",
    }),
    sfQuery: async (soql) => {
      ctx.soqlSeen.push(soql);
      if (/COUNT\(Id\)/.test(soql)) return [{ c: ctx.sfRows.length }];
      return ctx.sfRows;
    },
  },
});

// Chainable PostgREST stand-in. Records every .eq() so a test can assert exactly
// which filters were applied, and resolves on .range().
function makeQueryBuilder() {
  const applied = [];
  const builder = {
    select(_sel, opts) {
      builder.__wantCount = !!(opts && opts.count);
      return builder;
    },
    eq(column, value) {
      applied.push({ column, value });
      ctx.cacheFilters.push({ column, value });
      return builder;
    },
    or() {
      return builder;
    },
    // Cache writes are best-effort by contract; the read paths log and continue.
    // Present here so the tested behavior isn't hidden behind write noise.
    async upsert() {
      return { error: null };
    },
    order() {
      return builder;
    },
    range() {
      // Only rows matching every applied .eq() come back — this is what makes a
      // missing filter observable as leaked rows rather than as a passing test.
      const rows = ctx.cacheRows.filter((row) =>
        applied.every(({ column, value }) => row[column] === value)
      );
      return Promise.resolve({
        data: rows,
        count: builder.__wantCount ? rows.length : null,
        error: null,
      });
    },
  };
  return builder;
}

mock.module("../../lib/supabase.js", {
  exports: {
    getSupabaseClient: async () => ({
      from: () => makeQueryBuilder(),
    }),
    getSupabaseConfig: async () => ({
      url: "https://supa.example.co",
      serviceRoleKey: "svc",
    }),
  },
});

// Cache columns come from the PostgREST OpenAPI spec; SF fields from the describe.
// One fetch stub serves both, dispatching on URL.
const CACHE_COLUMNS = [
  "sf_id", "client_sf_id", "tenant_id", "created_date", "is_stale",
  "last_synced_at", "cache_version", "project_name", "customer_name_at_creation",
  "sundial_customer_sf_id", "stage",
];
const SF_FIELDS = [
  { name: "Id", type: "id" },
  { name: "Client__c", type: "reference" },
  { name: "Sundial_Customer__c", type: "reference" },
  { name: "Project_Name__c", type: "string" },
  { name: "Stage__c", type: "picklist" },
  { name: "Sales_Representative__c", type: "string" },
  { name: "CreatedDate", type: "datetime" },
];

globalThis.fetch = async (url) => {
  if (String(url).includes("/rest/v1/")) {
    const properties = Object.fromEntries(CACHE_COLUMNS.map((c) => [c, {}]));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        definitions: {
          sundial_solar_cache: { properties },
          sundial_roofing_cache: { properties },
          sundial_customer_cache: { properties },
        },
      }),
    };
  }
  // Salesforce describe
  return { ok: true, status: 200, json: async () => ({ fields: SF_FIELDS }) };
};

const { handler } = await import("./index.js");

function listEvent(object, query = {}) {
  return {
    requestContext: { http: { method: "GET" } },
    rawPath: `/sf/${object}`,
    pathParameters: { object },
    queryStringParameters: Object.keys(query).length ? query : null,
    headers: { authorization: "Bearer test.jwt", origin: "http://localhost:5173" },
  };
}

function solarRow(sfId, customerSfId, extra = {}) {
  return {
    sf_id: sfId,
    client_sf_id: TENANT,
    sundial_customer_sf_id: customerSfId,
    project_name: `Project ${sfId}`,
    created_date: "2026-01-01T00:00:00Z",
    is_stale: false,
    last_synced_at: new Date().toISOString(),
    cache_version: 1,
    ...extra,
  };
}

test.beforeEach(resetCtx);

test("parentId filters the cache to that parent's children only", async () => {
  ctx.cacheRows = [
    solarRow("a1Q001", CUSTOMER_A),
    solarRow("a1Q002", CUSTOMER_A),
    solarRow("a1Q003", CUSTOMER_B),
  ];
  const res = await handler(listEvent("solar", { parentId: CUSTOMER_A }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);

  assert.equal(body.records.length, 2);
  assert.deepEqual(
    body.records.map((r) => r.sf_id).sort(),
    ["a1Q001", "a1Q002"]
  );
  assert.equal(body.total, 2, "total must reflect the filtered set, not the table");

  // Tenant scope is still applied alongside the parent scope.
  assert.ok(
    ctx.cacheFilters.some((f) => f.column === "client_sf_id" && f.value === TENANT),
    "tenant filter missing"
  );
  assert.ok(
    ctx.cacheFilters.some(
      (f) => f.column === "sundial_customer_sf_id" && f.value === CUSTOMER_A
    ),
    "parent filter missing"
  );
});

test("a customer with no children returns empty — NOT the whole table", async () => {
  // The cache holds projects, just none for CUSTOMER_B. A zero-row result is
  // indistinguishable from a cold cache, so this is the regression that matters:
  // the cold-cache fallback must carry the parent clause into SOQL.
  ctx.cacheRows = [solarRow("a1Q001", CUSTOMER_A)];
  ctx.sfRows = []; // Salesforce agrees: no children for B

  const res = await handler(listEvent("solar", { parentId: CUSTOMER_B }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);

  assert.equal(body.records.length, 0);
  assert.equal(body.total, 0);
  // If it fell through to a live read, that read must still be parent-scoped.
  for (const soql of ctx.soqlSeen) {
    assert.match(
      soql,
      new RegExp(`Sundial_Customer__c = '${CUSTOMER_B}'`),
      `live query lost the parent clause: ${soql}`
    );
  }
});

test("Sales-Rep restriction composes with parentId (intersection, live path)", async () => {
  ctx.identity.user.hierarchyLevel = "Sales Rep";
  ctx.sfRows = [{ Id: "a1Q001", Sundial_Customer__c: CUSTOMER_A, Client__c: TENANT }];

  const res = await handler(listEvent("solar", { parentId: CUSTOMER_A }));
  assert.equal(res.statusCode, 200);

  const selects = ctx.soqlSeen.filter((s) => !/COUNT\(Id\)/.test(s));
  assert.ok(selects.length > 0, "expected a live SELECT for the restricted rep");
  for (const soql of ctx.soqlSeen) {
    // Both clauses, ANDed — the rep clause must survive the parent filter.
    assert.match(soql, /Sales_Representative__c = 'Dennis Alessandro'/, soql);
    assert.match(soql, new RegExp(`Sundial_Customer__c = '${CUSTOMER_A}'`), soql);
    assert.match(soql, new RegExp(`Client__c = '${TENANT}'`), soql);
    assert.doesNotMatch(soql, / OR /, `rep clause must never be OR-ed: ${soql}`);
  }
});

test("a rep cannot reach another rep's projects via a customer's related list", async () => {
  // Salesforce is the enforcement point on this path: the rep clause is in the
  // WHERE, so the org returns nothing for a customer whose projects belong to a
  // different rep. The endpoint must surface that empty set, not fall back to an
  // unrestricted read.
  ctx.identity.user.hierarchyLevel = "Sales Rep";
  ctx.cacheRows = [solarRow("a1Q003", CUSTOMER_B)]; // another rep's, sitting in cache
  ctx.sfRows = []; // SF: no rows for this rep + this customer

  const res = await handler(listEvent("solar", { parentId: CUSTOMER_B }));
  const body = JSON.parse(res.body);

  assert.equal(body.records.length, 0, "cached row for another rep must not leak");
  assert.equal(body.total, 0);
  assert.equal(body.source, "salesforce", "restricted rep must not be served from cache");
});

test("search composes with parentId — narrows within the related list", async () => {
  ctx.cacheRows = [
    solarRow("a1Q001", CUSTOMER_A, { project_name: "Roof Array" }),
    solarRow("a1Q003", CUSTOMER_B, { project_name: "Roof Array" }),
  ];
  const res = await handler(
    listEvent("solar", { parentId: CUSTOMER_A, q: "Roof" })
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);

  assert.equal(body.records.length, 1);
  assert.equal(body.records[0].sf_id, "a1Q001");
  assert.ok(
    ctx.cacheFilters.some(
      (f) => f.column === "sundial_customer_sf_id" && f.value === CUSTOMER_A
    ),
    "search path dropped the parent filter"
  );
});

test("parentId on an object with no parent lookup is rejected, not ignored", async () => {
  ctx.cacheRows = [];
  const res = await handler(listEvent("customer", { parentId: CUSTOMER_A }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, "PARENT_FILTER_UNSUPPORTED");
});

test("a malformed parentId is rejected before any query runs", async () => {
  for (const bad of ["'; DROP--", "abc", "a1P000000000001AAA'", "../../etc", "%25"]) {
    resetCtx();
    const res = await handler(listEvent("solar", { parentId: bad }));
    assert.equal(res.statusCode, 400, `accepted bad id: ${bad}`);
    assert.equal(JSON.parse(res.body).code, "INVALID_PARENT_ID");
    assert.equal(ctx.soqlSeen.length, 0, `queried Salesforce with bad id: ${bad}`);
    assert.equal(ctx.cacheFilters.length, 0, `queried cache with bad id: ${bad}`);
  }
});

test("15-char and 18-char Salesforce ids are both accepted", async () => {
  for (const id of ["a1P000000000001", "a1P000000000001AAA"]) {
    resetCtx();
    ctx.cacheRows = [solarRow("a1Q001", id)];
    const res = await handler(listEvent("solar", { parentId: id }));
    assert.equal(res.statusCode, 200, `rejected valid id: ${id}`);
    assert.equal(JSON.parse(res.body).records.length, 1);
  }
});

test("roofing uses the same registry entry as solar", async () => {
  ctx.cacheRows = [
    { ...solarRow("a1R001", CUSTOMER_A) },
    { ...solarRow("a1R002", CUSTOMER_B) },
  ];
  const res = await handler(listEvent("roofing", { parentId: CUSTOMER_A }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.records.length, 1);
  assert.equal(body.records[0].sf_id, "a1R001");
});

test("no parentId leaves list behavior unchanged", async () => {
  ctx.cacheRows = [
    solarRow("a1Q001", CUSTOMER_A),
    solarRow("a1Q003", CUSTOMER_B),
  ];
  const res = await handler(listEvent("solar"));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);

  assert.equal(body.records.length, 2, "unfiltered list must still return everything");
  assert.ok(
    !ctx.cacheFilters.some((f) => f.column === "sundial_customer_sf_id"),
    "parent filter applied when none was requested"
  );
});

test("an empty parentId is treated as absent, not as a bad id", async () => {
  ctx.cacheRows = [solarRow("a1Q001", CUSTOMER_A)];
  const res = await handler(listEvent("solar", { parentId: "" }));
  assert.equal(res.statusCode, 200);
  assert.ok(
    !ctx.cacheFilters.some((f) => f.column === "sundial_customer_sf_id"),
    "empty parentId must not filter"
  );
});

test("the response shape is unchanged by the parent filter", async () => {
  ctx.cacheRows = [solarRow("a1Q001", CUSTOMER_A)];
  const res = await handler(listEvent("solar", { parentId: CUSTOMER_A }));
  const body = JSON.parse(res.body);
  for (const key of ["source", "count", "total", "limit", "offset", "hasMore", "records"]) {
    assert.ok(key in body, `response lost the ${key} field`);
  }
  assert.equal(body.count, body.records.length);
});
