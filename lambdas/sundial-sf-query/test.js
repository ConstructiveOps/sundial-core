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

// The REAL access module -- not mocked here, so these tests exercise the shipped rules.
import { resolveScope, accessBlock } from "../../lib/access.js";

const TENANT = "a0XharmonTENANT";
const CUSTOMER_A = "a1P000000000001AAA";
const CUSTOMER_B = "a1P000000000002AAA";
const REP_A = "a1O7y00000REPAAAAA";
const REP_B = "a1O7y00000REPBBBBB";
const DEALER = "a0Y0000000DEALERAA";

/** An identity shaped like resolveIdentity()'s return, for an `own`-scope sales rep. */
function repIdentity(userId) {
  const user = {
    id: userId,
    accessLevel: "Sales Rep",
    dealer: { id: DEALER, active: true, isInternal: false },
    hierarchyLevel: "Sales Rep", // deliberately set: §7.4 means it is no longer READ
  };
  return {
    user,
    access: accessBlock(resolveScope(user, TENANT)),
    tenantId: TENANT,
    tenantSlug: "harmon",
  };
}

const ctx = {
  identity: { tenantId: TENANT, tenantSlug: "harmon", user: { id: "u1", hierarchyLevel: "Client" } },
  soqlSeen: [], // every SOQL string issued
  cacheFilters: [], // every {column, value} applied to a cache query
  cacheRows: [], // rows the cache returns
  cacheCount: 0, // exact count the cache reports
  sfRows: [], // rows Salesforce returns for the live path
};

function resetCtx() {
  const user = { id: "u1", hierarchyLevel: "Client", accessLevel: "Admin", dealer: null };
  ctx.identity = {
    tenantId: TENANT,
    tenantSlug: "harmon",
    user,
    access: accessBlock(resolveScope(user, TENANT)),
  };
  delete process.env.ACCESS_MODEL_MODE;
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
  // The Phase 1 row-filter columns. Without these the enforcement tests would pass
  // for the wrong reason -- a filter on a column the fixture does not have matches
  // nothing, which looks exactly like a filter that works.
  "sales_rep_sf_id", "dealer_sf_id",
];
const SF_FIELDS = [
  { name: "Id", type: "id" },
  { name: "Client__c", type: "reference" },
  { name: "Sales_Rep__c", type: "reference" },
  { name: "Dealer__c", type: "reference" },
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

test("a sales rep's related list is CACHE-served now, not live SOQL (§7.4)", async () => {
  // The TEMP guard forced every restricted-rep read to live Salesforce, because the
  // field it filtered on was not cached. That is what capped a rep at the first ~2,000
  // rows of their own book (SOQL OFFSET) and what this replaces. The row filter is an id
  // equality on an indexed cache column, so a rep now takes the same path as anyone.
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = repIdentity(REP_A);
  ctx.cacheRows = [
    solarRow("a1Q001", CUSTOMER_A, { sales_rep_sf_id: REP_A }),
    solarRow("a1Q002", CUSTOMER_A, { sales_rep_sf_id: REP_B }),
  ];

  const res = await handler(listEvent("solar", { parentId: CUSTOMER_A }));
  const body = JSON.parse(res.body);

  assert.equal(res.statusCode, 200);
  assert.equal(body.source, "cache", "no live-SOQL bypass survives");
  assert.equal(body.records.length, 1, "their own project for this customer, and no other");
  assert.equal(body.records[0].sf_id, "a1Q001");
  assert.deepEqual(
    ctx.soqlSeen.filter((s) => /FROM Sundial_Solar__c/.test(s)),
    [],
    "and Salesforce was not queried at all"
  );
  delete process.env.ACCESS_MODEL_MODE;
});

test("a rep cannot reach another rep's projects via a customer's related list", async () => {
  // THE SAME PROPERTY THE TEMP-GUARD VERSION OF THIS TEST PROTECTED, re-pinned against
  // the enforcement that replaced it. The row filter is applied FIRST and ?parentId= is
  // ANDed after it, so a related list can only ever narrow within what the caller may
  // see. A cached row belonging to another rep must not leak through the parent filter.
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = repIdentity(REP_A);
  ctx.cacheRows = [solarRow("a1Q003", CUSTOMER_B, { sales_rep_sf_id: REP_B })];

  const res = await handler(listEvent("solar", { parentId: CUSTOMER_B }));
  const body = JSON.parse(res.body);

  assert.equal(body.records.length, 0, "another rep's row must not leak");
  assert.equal(body.total, 0, "and must not be counted either");
  delete process.env.ACCESS_MODEL_MODE;
});

test("the row filter is ANDed, never OR-ed, on the live path", async () => {
  // An OR anywhere in this composition would turn a narrowing into a widening. Pinned on
  // the cold-cache path, which is the only one that still builds SOQL for a list.
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = repIdentity(REP_A);
  ctx.cacheRows = []; // cold -> live fallback
  ctx.sfRows = [{ Id: "a1Q001", Sundial_Customer__c: CUSTOMER_A, Client__c: TENANT }];

  await handler(listEvent("solar", { parentId: CUSTOMER_A }));

  const seen = ctx.soqlSeen.filter((s) => /FROM Sundial_Solar__c/.test(s));
  assert.ok(seen.length > 0, "expected the cold-cache live fallback");
  for (const soql of seen) {
    assert.match(soql, new RegExp(`Sales_Rep__c = '${REP_A}'`), soql);
    assert.match(soql, new RegExp(`Sundial_Customer__c = '${CUSTOMER_A}'`), soql);
    assert.match(soql, new RegExp(`Client__c = '${TENANT}'`), soql);
    assert.doesNotMatch(soql, / OR /, `the row filter must never be OR-ed: ${soql}`);
  }
  delete process.env.ACCESS_MODEL_MODE;
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
