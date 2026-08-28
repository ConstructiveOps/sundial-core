// Tests for ACCESS MODEL SHADOW MODE in sundial-sf-query (D-064 Phase 2).
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// THREE PROPERTIES, and they are the whole phase:
//
//   1. mode=off is BYTE-IDENTICAL to before Phase 2 — no log line, no extra query, and
//      the same response. This is what ships first and what the access matrix is run
//      against, so it is asserted rather than assumed.
//   2. mode=shadow COMPUTES THE RIGHT ANSWER per path per scope — including the two the
//      §8 gate exists to catch: a narrowing (a rep loses another rep's records) and a
//      WIDENING (a record the TEMP guard hides that the new model would serve).
//   3. mode=shadow CANNOT BREAK A REQUEST. A throwing lib/access must produce one log
//      line and a completely unchanged response. If this test ever fails, shadow has
//      stopped being a measurement and become a liability.
//
// Salesforce and Supabase are mocked at the module boundary — no network, no AWS, no
// Salesforce org. lib/access.js is mocked as a PASS-THROUGH to the real module, so every
// assertion below is against the real authorization logic; the wrapper exists only so one
// test can make it throw.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

// The real module, captured BEFORE the mock is installed, so the mock can delegate to it.
import * as realAccess from "../../lib/access.js";
// The REAL generated manifest — Phase 4 assertions read from it rather than a fixture,
// so they fail if the workbook stops saying what they assume.
import customerManifest from "../../lib/field-manifest/customer.json" with { type: "json" };

const TENANT = "a1W7y000007AszBEAS";
const REP_A = "a1O7y00000REPAAAAA";
const REP_B = "a1O7y00000REPBBBBB";
const DEALER = "a0Y0000000DEALERAA";
const CUST_1 = "a1P000000000001AAA";
const CUST_2 = "a1P000000000002AAA";

const ctx = {
  identity: null,
  soqlSeen: [],
  cacheQueries: [], // every query built: { table, eq: [...], or: [...], head }
  cacheRows: [],
  sfRows: [],
  accessThrows: false, // flips the lib/access mock into a landmine
  failHeadCount: false, // makes ONLY the shadow's own count query fail
  logs: [], // every console.log line
  warns: [],
};

function resetCtx(access) {
  ctx.identity = identityFor("Admin", { userId: REP_A, dealer: null });
  ctx.soqlSeen = [];
  ctx.cacheQueries = [];
  ctx.cacheRows = [];
  ctx.sfRows = [];
  ctx.accessThrows = false;
  ctx.failHeadCount = false;
  ctx.logs = [];
  ctx.warns = [];
  delete process.env.ACCESS_MODEL_MODE;
}

/** An identity shaped exactly like resolveIdentity()'s return, access block included. */
function identityFor(accessLevel, { userId = REP_A, dealer = { id: DEALER, active: true, isInternal: false }, hierarchyLevel = "Client" } = {}) {
  const user = { id: userId, accessLevel, dealer, hierarchyLevel };
  const scope = realAccess.resolveScope(user, TENANT);
  return {
    user,
    access: realAccess.accessBlock(scope),
    tenantId: TENANT,
    tenantSlug: "harmon",
    authUserId: "auth-uuid",
  };
}

// --- module mocks ----------------------------------------------------------

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

// lib/access.js: a pass-through wrapper over the REAL module. Every export delegates, so
// the tests exercise the real matrix; `ctx.accessThrows` turns the three functions shadow
// calls into landmines, which is the only way to prove the try/catch actually holds.
const accessMock = {};
for (const [name, value] of Object.entries(realAccess)) {
  if (typeof value !== "function") {
    accessMock[name] = value;
    continue;
  }
  accessMock[name] = (...args) => {
    if (ctx.accessThrows) throw new Error("lib/access exploded");
    return value(...args);
  };
}
mock.module("../../lib/access.js", { exports: accessMock });

/**
 * Chainable PostgREST stand-in.
 *
 * Awaitable directly (the shadow count is a HEAD request with no .range()) AND via
 * .range() (the list path). Records every filter so a test can assert exactly which
 * predicate the shadow count ran — which is the difference between "it logged a number"
 * and "it logged the right number".
 */
function makeQueryBuilder(table) {
  const q = { table, eq: [], or: [], head: false, wantCount: false };
  ctx.cacheQueries.push(q);

  const matching = () =>
    ctx.cacheRows.filter(
      (row) =>
        row.__table === table &&
        q.eq.every(({ column, value }) => row[column] === value) &&
        q.or.every((group) => orMatches(group, row))
    );

  const builder = {
    select(_sel, opts) {
      q.wantCount = !!(opts && opts.count);
      q.head = !!(opts && opts.head);
      return builder;
    },
    eq(column, value) {
      q.eq.push({ column, value });
      return builder;
    },
    or(group) {
      q.or.push(group);
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    async maybeSingle() {
      const rows = matching();
      return { data: rows[0] ?? null, error: null };
    },
    async upsert() {
      return { error: null };
    },
    delete: () => builder,
    in: () => builder,
    range() {
      const rows = matching();
      return Promise.resolve({
        data: rows,
        count: q.wantCount ? rows.length : null,
        error: null,
      });
    },
    // Awaiting the builder itself resolves the query — this is what a HEAD count does.
    then(resolve, reject) {
      try {
        // Only the HEAD count fails — the served read is left working. That is the shape
        // of a Supabase hiccup that hits the shadow query and not the request's own.
        if (q.head && ctx.failHeadCount) {
          resolve({ data: null, count: null, error: { message: "PostgREST unavailable" } });
          return;
        }
        const rows = matching();
        resolve({
          data: q.head ? null : rows,
          count: q.wantCount ? rows.length : null,
          error: null,
        });
      } catch (e) {
        reject(e);
      }
    },
  };
  return builder;
}

/**
 * Minimal parser for the or-group shapes this code emits.
 *
 * Splits on TOP-LEVEL commas only: `access_level.in.("Executive","Admin","Manager")` is
 * one clause containing commas, and a naive split turns it into three broken fragments —
 * which silently drops the Harmon-staff half of the §3.5 union and makes the union test
 * pass for the wrong reason.
 */
function splitTopLevel(group) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of String(group)) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function orMatches(group, row) {
  return splitTopLevel(group)
    .some((clause) => {
      let m = /^([a-z_]+)\.eq\."?([^",]*)"?$/.exec(clause);
      if (m) return row[m[1]] === m[2];
      m = /^([a-z_]+)\.in\.\((.*)\)$/.exec(clause);
      if (m) {
        const values = m[2].split(",").map((v) => v.replace(/^"|"$/g, ""));
        return values.includes(row[m[1]]);
      }
      m = /^([a-z_]+)\.ilike\."%(.*)%"$/.exec(clause);
      if (m) return String(row[m[1]] ?? "").toLowerCase().includes(m[2].toLowerCase());
      return false;
    });
}

mock.module("../../lib/supabase.js", {
  exports: {
    getSupabaseClient: async () => ({ from: (t) => makeQueryBuilder(t) }),
    getSupabaseConfig: async () => ({
      url: "https://supa.example.co",
      serviceRoleKey: "svc",
    }),
  },
});

const CACHE_COLUMNS = [
  "sf_id", "client_sf_id", "tenant_id", "created_date", "is_stale", "last_synced_at",
  "cache_version", "name", "first_name", "last_name", "customer_name", "project_name",
  "customer_name_at_creation", "sundial_customer_sf_id", "stage",
  "sales_rep_sf_id", "dealer_sf_id", "access_level", "active",
];
const SF_FIELDS = [
  { name: "Id", type: "id" },
  { name: "Client__c", type: "reference" },
  { name: "Sales_Rep__c", type: "reference" },
  { name: "Dealer__c", type: "reference" },
  { name: "Sundial_Customer__c", type: "reference" },
  { name: "First_Name__c", type: "string" },
  { name: "Last_Name__c", type: "string" },
  { name: "Name", type: "string" },
  { name: "Project_Name__c", type: "string" },
  { name: "Stage__c", type: "picklist" },
  { name: "Sunbase_Sales_Rep__c", type: "string" },
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
          sundial_customer_cache: { properties },
          sundial_solar_cache: { properties },
          sundial_roofing_cache: { properties },
          sundial_po_cache: { properties },
          sundial_user_cache: { properties },
        },
      }),
    };
  }
  return { ok: true, status: 200, json: async () => ({ fields: SF_FIELDS }) };
};

// Capture stdout so the shadow lines can be asserted on.
const realLog = console.log;
const realWarn = console.warn;
console.log = (...a) => { ctx.logs.push(a.map(String).join(" ")); };
console.warn = (...a) => { ctx.warns.push(a.map(String).join(" ")); };

const { handler } = await import("./index.js");

// --- helpers ---------------------------------------------------------------

const AUTH = { authorization: "Bearer test.jwt", origin: "http://localhost:5173" };

function event(rawPath, pathParameters, query = {}) {
  return {
    requestContext: { http: { method: "GET" } },
    rawPath,
    pathParameters,
    queryStringParameters: Object.keys(query).length ? query : null,
    headers: AUTH,
  };
}
const listEvent = (object, query) => event(`/sf/${object}`, { object }, query);
const singleEvent = (object, id, query) => event(`/sf/${object}/${id}`, { object, id }, query);

/** Every shadow line emitted by the last request, parsed. */
function shadowLines() {
  return ctx.logs
    .filter((l) => l.includes('"shadow":true'))
    .map((l) => JSON.parse(l.slice(l.indexOf("{"))));
}
function oneLine() {
  const lines = shadowLines();
  assert.equal(lines.length, 1, `expected exactly one shadow line, got ${lines.length}`);
  return lines[0];
}

function customerRow(sfId, repId, extra = {}) {
  return {
    __table: "sundial_customer_cache",
    sf_id: sfId,
    client_sf_id: TENANT,
    sales_rep_sf_id: repId,
    dealer_sf_id: DEALER,
    name: `Customer ${sfId}`,
    created_date: "2026-01-01T00:00:00Z",
    is_stale: false,
    last_synced_at: new Date().toISOString(),
    cache_version: 1,
    ...extra,
  };
}

/** The count queries shadow added — i.e. the ones that are HEAD-count reads. */
const countQueries = () => ctx.cacheQueries.filter((q) => q.head);

test.beforeEach(() => resetCtx());

// ---------------------------------------------------------------------------
// 1. mode=off — the property that lets this ship
// ---------------------------------------------------------------------------

test("mode OFF: no shadow line, no extra query, unchanged response", async () => {
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A), customerRow(CUST_2, REP_B)];

  const res = await handler(listEvent("customer", { limit: "10" }));
  const body = JSON.parse(res.body);

  assert.equal(res.statusCode, 200);
  assert.equal(body.records.length, 2, "a rep still sees BOTH rows — nothing is enforced");
  assert.deepEqual(shadowLines(), [], "mode off must not log");
  assert.deepEqual(countQueries(), [], "mode off must not query");
});

test("mode OFF is the DEFAULT — an unset env var is off, not shadow", async () => {
  assert.equal(process.env.ACCESS_MODEL_MODE, undefined);
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A)];
  await handler(listEvent("customer"));
  assert.deepEqual(shadowLines(), []);
});

test("an UNRECOGNIZED mode falls back to off, loudly", async () => {
  // A typo in an env var must degrade to today's behavior, never to a mode nobody chose.
  process.env.ACCESS_MODEL_MODE = "shdow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A)];
  const res = await handler(listEvent("customer"));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(shadowLines(), []);
  assert.ok(
    ctx.warns.some((w) => w.includes("not a recognized mode")),
    "a bad mode must warn, or it is indistinguishable from off"
  );
});

test("mode ENFORCE now SERVES the filtered answer (Phase 3)", async () => {
  // Phase 2's version of this test asserted the opposite -- that enforce served the OLD
  // answer -- because enforce was recognized but unimplemented. Phase 3 gives it meaning,
  // and the assertion flips with it. Left as a named change rather than a quiet edit:
  // this single test is the difference between "measuring" and "enforcing".
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A), customerRow(CUST_2, REP_B)];

  const res = await handler(listEvent("customer"));
  const body = JSON.parse(res.body);

  assert.equal(res.statusCode, 200);
  assert.equal(body.records.length, 1, "a rep is served their OWN record and no other");
  assert.equal(body.records[0].sf_id, CUST_1);
  assert.equal(body.total, 1, "the COUNT is scoped too, not just the page");
});

test("under ENFORCE the log still runs, and now agrees with what was served", async () => {
  // Shadow logging stays on after the cutover as the post-launch watch. Under enforce the
  // served answer and the computed answer are the SAME answer, so a disagreement line is
  // the signal that enforcement and the model have drifted -- the one failure nobody
  // would otherwise notice, because the portal would look fine.
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A), customerRow(CUST_2, REP_B)];

  await handler(listEvent("customer"));
  const line = oneLine();
  assert.equal(line.mode, "enforce");
  assert.equal(line.oldTotal, 1, "what was served");
  assert.equal(line.newTotal, 1, "what the model says");
  assert.equal(line.verdict, "same_count");
  assert.equal(line.wider, false);
  assert.equal(line.narrower, false);
});

test("ENFORCE: a denied module is 403 on a LIST and 404 on a SINGLE read (§3.1)", async () => {
  // Not a style choice. A 403 on a record id confirms the record exists, which turns any
  // detail endpoint into an enumeration oracle for a rep counting the tenant. A closed
  // MODULE leaks nothing about any particular record, so that one is an honest 403.
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [];

  const list = await handler(listEvent("po"));
  assert.equal(list.statusCode, 403);
  assert.equal(JSON.parse(list.body).code, "MODULE_FORBIDDEN");

  const single = await handler(singleEvent("po", "a2X000000000001AAA"));
  assert.equal(single.statusCode, 404);
  assert.equal(JSON.parse(single.body).code, "RECORD_NOT_FOUND");
});

test("ENFORCE: roofing closes for a sales scope, stays open for tenant", async () => {
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.cacheRows = [];

  ctx.identity = identityFor("Sales Dealer", { userId: REP_A });
  assert.equal((await handler(listEvent("roofing"))).statusCode, 403);

  ctx.logs = [];
  ctx.identity = identityFor("Admin", { dealer: null });
  assert.equal((await handler(listEvent("roofing"))).statusCode, 200);
});

test("ENFORCE: the cache SHORTCUT refuses another rep's row", async () => {
  // The row is fresh and in the cache, so the shortcut would have served it. It must fall
  // through to the SOQL path, which carries the same clause, and 404.
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_2, REP_B)];
  ctx.sfRows = []; // the SOQL clause finds nothing either

  const res = await handler(singleEvent("customer", CUST_2));
  assert.equal(res.statusCode, 404);
});

test("ENFORCE: a rep's OWN row is still served from the cache shortcut", async () => {
  // The narrowing must not become "reps get nothing" -- that is the failure mode a
  // fail-closed change is most likely to ship.
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A)];

  const res = await handler(singleEvent("customer", CUST_1));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).source, "cache", "served from the cache, not live SOQL");
});

test("ENFORCE: ?q= search narrows WITHIN the role's scope, never outside it", async () => {
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [
    customerRow(CUST_1, REP_A, { name: "ZZ Alpha" }),
    customerRow(CUST_2, REP_B, { name: "ZZ Beta" }),
  ];

  const res = await handler(listEvent("customer", { q: "ZZ" }));
  const body = JSON.parse(res.body);
  assert.equal(body.records.length, 1);
  assert.equal(body.records[0].sf_id, CUST_1);
  assert.equal(body.total, 1);
});

test("ENFORCE: TENANT scope is untouched on every surface", async () => {
  // The rule that does not compress: enforcement may only narrow a SALES role. If a
  // tenant-scope user loses a single row, the change is wrong regardless of what else
  // passes.
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Admin", { dealer: null });
  ctx.cacheRows = [customerRow(CUST_1, REP_A), customerRow(CUST_2, REP_B)];
  ctx.sfRows = [{ Id: CUST_1, Client__c: TENANT, Sales_Rep__c: REP_A }];

  const list = await handler(listEvent("customer"));
  assert.equal(JSON.parse(list.body).records.length, 2, "every row, as today");
  assert.equal(JSON.parse(list.body).total, 2);

  const single = await handler(singleEvent("customer", CUST_2));
  assert.equal(single.statusCode, 200, "including another rep's record");

  const full = await handler(singleEvent("customer", CUST_1, { full: "true" }));
  assert.equal(full.statusCode, 200);

  const meta = await handler(event("/sf/meta/roofing/picklists", { object: "roofing" }));
  assert.equal(meta.statusCode, 200, "and the meta routes of a module sales roles cannot reach");
});

test("ENFORCE: scope none reaches nothing, on every route", async () => {
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Technician", { userId: REP_B });
  ctx.cacheRows = [customerRow(CUST_1, REP_A)];
  ctx.sfRows = [{ Id: CUST_1, Client__c: TENANT }];

  assert.equal((await handler(listEvent("customer"))).statusCode, 403);
  assert.equal((await handler(singleEvent("customer", CUST_1))).statusCode, 404);
  assert.equal((await handler(singleEvent("customer", CUST_1, { full: "true" }))).statusCode, 404);
  assert.equal((await handler(event("/sf/users", null))).statusCode, 403);
  assert.equal(
    (await handler(event("/sf/meta/customer/picklists", { object: "customer" }))).statusCode,
    403
  );
});

test("ENFORCE: GET /sf/users returns the §3.5 union for a dealer", async () => {
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Dealer", { userId: REP_A });
  ctx.sfRows = [
    { Id: REP_A, First_Name__c: "Rep", Last_Name__c: "A" },
    { Id: "a1O7y00000ADMINAAAA", First_Name__c: "An", Last_Name__c: "Admin" },
  ];

  const res = await handler(event("/sf/users", null));
  assert.equal(res.statusCode, 200);
  const soql = ctx.soqlSeen.find((q) => q.includes("Supabase_User_Id__c"));
  assert.match(soql, /Dealer__c = '/, "the dealer half");
  assert.match(soql, /Access_Level__c IN \('Executive', 'Admin', 'Manager'\)/, "the staff half");
  assert.match(soql, /Active__c = true/, "and the endpoint's own active rule survives");
});

test("ENFORCE: the picklist MODULE gate closes, values stay org-wide", async () => {
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });

  const denied = await handler(
    event("/sf/meta/roofing/picklist/Stage__c", { object: "roofing", field: "Stage__c" })
  );
  assert.equal(denied.statusCode, 403, "roofing is closed to sales roles");

  const allowed = await handler(
    event("/sf/meta/customer/picklist/Stage__c", { object: "customer", field: "Stage__c" })
  );
  assert.equal(allowed.statusCode, 200, "customer is reachable; §4.4 field filtering is Phase 4");
});

// ---------------------------------------------------------------------------
// 2. mode=shadow — the decision, per path, per scope
// ---------------------------------------------------------------------------

test("list.cache, TENANT scope: identical by construction, and NO extra query", async () => {
  // The cost-control property. rowFilter for tenant scope is the tenant clause alone —
  // exactly the predicate the request already ran — so there is nothing to ask.
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Admin", { dealer: null });
  ctx.cacheRows = [customerRow(CUST_1, REP_A), customerRow(CUST_2, REP_B)];

  await handler(listEvent("customer"));

  const line = oneLine();
  assert.equal(line.path, "list.cache");
  assert.equal(line.scope, "tenant");
  assert.equal(line.newCountSource, "identical_by_construction");
  assert.equal(line.verdict, "same_count");
  assert.equal(line.newTotal, line.oldTotal);
  assert.deepEqual(countQueries(), [], "tenant scope must add no query");
});

test("list.cache, OWN scope: one count query, filtered on the rep", async () => {
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A), customerRow(CUST_2, REP_B)];

  const res = await handler(listEvent("customer"));
  assert.equal(JSON.parse(res.body).records.length, 2, "still SERVES both");

  const line = oneLine();
  assert.equal(line.path, "list.cache");
  assert.equal(line.oldTotal, 2);
  assert.equal(line.newTotal, 1, "the new model sees only the rep's own row");
  assert.equal(line.verdict, "narrower");
  assert.equal(line.narrower, true);
  assert.equal(line.wider, false);
  assert.equal(line.newCountSource, "cache_count");

  const q = countQueries();
  assert.equal(q.length, 1, "exactly one added query");
  assert.deepEqual(q[0].eq, [
    { column: "client_sf_id", value: TENANT },
    { column: "sales_rep_sf_id", value: REP_A },
  ]);
});

test("list.cache, DEALER scope: filtered on the dealer, not the rep", async () => {
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Dealer", { userId: REP_A });
  ctx.cacheRows = [
    customerRow(CUST_1, REP_A),
    customerRow(CUST_2, REP_B),
    customerRow("a1P000000000003AAA", REP_B, { dealer_sf_id: "a0Y0000000OTHERAA" }),
  ];

  await handler(listEvent("customer"));
  const line = oneLine();
  assert.equal(line.newTotal, 2, "both of this dealer's rows, neither of the other's");
  assert.deepEqual(countQueries()[0].eq, [
    { column: "client_sf_id", value: TENANT },
    { column: "dealer_sf_id", value: DEALER },
  ]);
});

test("list: a DENIED module is logged as forbidden with no query at all", async () => {
  // po is closed to every sales scope (§3.1). A denial is zero rows by construction —
  // asking the database how many rows a rep may not see would be a pointless round trip.
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [{ __table: "sundial_po_cache", sf_id: "po1", client_sf_id: TENANT, is_stale: false, last_synced_at: new Date().toISOString() }];

  await handler(listEvent("po"));
  const line = oneLine();
  assert.equal(line.newOutcome, "forbidden");
  assert.equal(line.newDeny, "MODULE_FORBIDDEN");
  assert.equal(line.newTotal, 0);
  assert.equal(line.narrower, true);
  assert.equal(line.newCountSource, "by_construction");
  assert.deepEqual(countQueries(), []);
});

test("list: ROOFING is denied to a sales scope even though it carries the columns", async () => {
  // The module gate and the data model are separate decisions (§3.1). Roofing has both
  // filter columns and is still closed — this is the assertion that keeps them separate.
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Dealer", { userId: REP_A });
  ctx.cacheRows = [];
  await handler(listEvent("roofing"));
  const line = oneLine();
  assert.equal(line.newOutcome, "forbidden");
  assert.equal(realAccess.OBJECT_ACCESS.roofing.dealerColumn, "dealer_sf_id");
});

test("list: the caller's ?field= filter is applied to the NEW count too", async () => {
  // Otherwise a filtered list compares "this stage, old scope" against "every stage, new
  // scope" and reads as a wild widening on every request.
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [
    customerRow(CUST_1, REP_A, { stage: "Sold" }),
    customerRow(CUST_2, REP_A, { stage: "Lead" }),
  ];

  await handler(listEvent("customer", { field: "Stage__c", value: "Sold" }));
  const line = oneLine();
  assert.equal(line.oldTotal, 1);
  assert.equal(line.newTotal, 1);
  assert.equal(line.verdict, "same_count");
  assert.ok(countQueries()[0].eq.some((e) => e.column === "stage" && e.value === "Sold"));
});

test("search.cache: the ILIKE group is applied to the new count", async () => {
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [
    customerRow(CUST_1, REP_A, { name: "ZZ Alpha" }),
    customerRow(CUST_2, REP_B, { name: "ZZ Beta" }),
  ];

  await handler(listEvent("customer", { q: "ZZ" }));
  const line = oneLine();
  assert.equal(line.path, "search.cache");
  assert.equal(line.oldTotal, 2);
  assert.equal(line.newTotal, 1, "the rep's own match only");
  assert.equal(line.params.hasQ, true);
  assert.equal(line.params.qLen, 2);
  assert.ok(countQueries()[0].or.length >= 1, "the search or-group must be applied");
});

test("THE SEARCH TERM IS NEVER LOGGED", async () => {
  // ?q= is whatever somebody typed into a search box: names, addresses, phone fragments.
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A, { name: "Doug Malde" })];

  await handler(listEvent("customer", { q: "Malde", field: "Stage__c", value: "Sold" }));
  const raw = ctx.logs.join("\n");
  assert.ok(!raw.includes("Malde"), "the search term must not reach the log");
  assert.ok(!raw.includes("Sold"), "nor a filter VALUE");
  const line = oneLine();
  assert.equal(line.params.field, "Stage__c", "the FIELD NAME is safe and is useful");
  assert.equal(line.params.hasValue, true);
});

test("§7.4: a rep's list is CACHE-served — the live-SOQL bypass is gone", async () => {
  // This replaces the TEMP guard's "list.live.rep" test. That path no longer exists, and
  // its absence IS the improvement: the guard forced every restricted read to live SOQL
  // because its field was not cached, and SOQL's OFFSET cap of 2000 made ~1,500 of
  // Dennis's 3,536 customers unreachable on deep pages. An id equality on an indexed
  // cache column has no such cap.
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A, hierarchyLevel: "Sales Rep" });
  ctx.cacheRows = [customerRow(CUST_1, REP_A), customerRow(CUST_2, REP_B)];

  const res = await handler(listEvent("customer"));
  const body = JSON.parse(res.body);

  assert.equal(body.source, "cache", "served from the cache like any other role");
  assert.equal(body.records.length, 1);
  const line = oneLine();
  assert.equal(line.path, "list.cache", "not list.live.rep — that path is deleted");
  assert.equal(line.temp, false, "and no TEMP guard is active on any request any more");
});

test("§7.4: Hierarchy_Level__c is NO LONGER READ — the mis-stamped user is cured", async () => {
  // The Phase 0 user-admin default stamped users as Hierarchy_Level__c = "Sales Rep"
  // regardless of their real role, and the TEMP guard keyed on exactly that string — so
  // an Admin carrying it was served Dennis's book. Removing the guard removes the whole
  // failure class: nothing reads that field on a read path now, so the mis-stamp is
  // inert rather than dangerous.
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Admin", { dealer: null, hierarchyLevel: "Sales Rep" });
  ctx.cacheRows = [customerRow(CUST_1, REP_A), customerRow(CUST_2, REP_B)];

  const res = await handler(listEvent("customer"));
  const body = JSON.parse(res.body);

  assert.equal(body.records.length, 2, "an Admin sees the tenant, mis-stamp or not");
  assert.equal(body.total, 2);
  const line = oneLine();
  assert.equal(line.scope, "tenant");
  assert.equal(line.temp, false);
  assert.equal(line.verdict, "same_count", "and enforce agrees with itself");
});

test("single.cache: the row in hand answers it — no extra query", async () => {
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A)];

  const res = await handler(singleEvent("customer", CUST_1));
  assert.equal(res.statusCode, 200);
  const line = oneLine();
  assert.equal(line.path, "single.cache");
  assert.equal(line.oldOutcome, "served");
  assert.equal(line.newOutcome, "served");
  assert.equal(line.newCountSource, "row_in_hand");
  assert.equal(line.verdict, "same_outcome");
  assert.deepEqual(countQueries(), []);
});

test("single.cache: ANOTHER rep's record is served today and would 404 tomorrow", async () => {
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_2, REP_B)];

  const res = await handler(singleEvent("customer", CUST_2));
  assert.equal(res.statusCode, 200, "shadow changes NOTHING about what is served");
  const line = oneLine();
  assert.equal(line.oldOutcome, "served");
  assert.equal(line.newOutcome, "not_found");
  assert.equal(line.narrower, true);
});

test("single: a denied module logs 404, NOT 403 (§3.1)", async () => {
  // A record you may not see must be indistinguishable from one that does not exist.
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [{ __table: "sundial_po_cache", sf_id: "po1", client_sf_id: TENANT, is_stale: false, last_synced_at: new Date().toISOString() }];

  await handler(singleEvent("po", "po1"));
  const line = oneLine();
  assert.equal(line.newOutcome, "not_found");
  assert.notEqual(line.newOutcome, "forbidden");
  assert.equal(line.newDeny, "MODULE_FORBIDDEN");
});

test("single.soql served: the filter fields ride along on the record — no second fetch", async () => {
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = []; // cold: falls through to Salesforce
  ctx.sfRows = [{ Id: CUST_2, Client__c: TENANT, Sales_Rep__c: REP_B, Dealer__c: DEALER }];

  const res = await handler(singleEvent("customer", CUST_2));
  assert.equal(res.statusCode, 200);
  const line = oneLine();
  assert.equal(line.path, "single.soql");
  assert.equal(line.newCountSource, "row_in_hand");
  assert.equal(line.newOutcome, "not_found", "REP_B's record is not REP_A's");
  assert.equal(line.narrower, true);
});

test("the widening detector still fires — the 404-branch cache probe survives §7.4", async () => {
  // The Phase 2 version of this test manufactured the widening with the TEMP guard: it
  // hid a rep's own record and the probe found it. The guard is gone, so the scenario is
  // built directly instead — a record the SERVED query missed that the row filter would
  // have allowed. The detector matters more after the cutover, not less: it is the only
  // thing that would notice enforcement and the model drifting apart.
  process.env.ACCESS_MODEL_MODE = "shadow"; // shadow, so the served answer stays unfiltered
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.sfRows = []; // the served read finds nothing -> 404
  // STALE, so the cache shortcut declines to serve it and the request falls through to
  // the Salesforce miss above. That is the shape the probe exists for: the row is in the
  // cache and the caller may see it, but the served path returned nothing.
  ctx.cacheRows = [customerRow(CUST_1, REP_A, { last_synced_at: "2020-01-01T00:00:00Z" })];

  const res = await handler(singleEvent("customer", CUST_1));
  assert.equal(res.statusCode, 404, "shadow serves nothing differently");
  const line = oneLine();
  assert.equal(line.oldOutcome, "not_found");
  assert.equal(line.newOutcome, "served");
  assert.equal(line.wider, true);
  assert.equal(line.verdict, "wider");
  assert.equal(line.newCountSource, "cache_probe");
});

test("single 404 that stays 404 costs one probe and reports same_outcome", async () => {
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.sfRows = [];
  ctx.cacheRows = [];

  const res = await handler(singleEvent("customer", CUST_1));
  assert.equal(res.statusCode, 404);
  const line = oneLine();
  assert.equal(line.verdict, "same_outcome");
  assert.equal(line.wider, false);
});

test("?full=true: evaluated from the record already returned", async () => {
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.sfRows = [{ Id: CUST_2, Client__c: TENANT, Sales_Rep__c: REP_B }];

  const res = await handler(singleEvent("customer", CUST_2, { full: "true" }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).full, true);
  const line = oneLine();
  assert.equal(line.path, "single.full");
  assert.equal(line.params.full, true);
  assert.equal(line.newOutcome, "not_found");
  assert.deepEqual(countQueries(), [], "full mode adds no query when it served a record");
});

// --- users and meta --------------------------------------------------------

test("users.route, DEALER scope: the §3.5 UNION, not a dealer equality", async () => {
  // My dealer's people PLUS Harmon staff. A dealer equality alone would hide every
  // Harmon employee from the mention picker — which is why rowFilter refuses `user`.
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Dealer", { userId: REP_A });
  ctx.sfRows = [
    { Id: REP_A, First_Name__c: "Rep", Last_Name__c: "A" },
    { Id: REP_B, First_Name__c: "Rep", Last_Name__c: "B" },
    { Id: "a1O7y00000ADMINAAAA", First_Name__c: "An", Last_Name__c: "Admin" },
  ];
  ctx.cacheRows = [
    { __table: "sundial_user_cache", sf_id: REP_A, client_sf_id: TENANT, dealer_sf_id: DEALER, access_level: "Sales Rep", active: true },
    { __table: "sundial_user_cache", sf_id: REP_B, client_sf_id: TENANT, dealer_sf_id: "a0Y0000000OTHERAA", access_level: "Sales Rep", active: true },
    { __table: "sundial_user_cache", sf_id: "a1O7y00000ADMINAAAA", client_sf_id: TENANT, dealer_sf_id: null, access_level: "Admin", active: true },
    { __table: "sundial_user_cache", sf_id: "a1O7y00000GONEAAAAA", client_sf_id: TENANT, dealer_sf_id: DEALER, access_level: "Sales Rep", active: false },
  ];

  const res = await handler(event("/sf/users", null));
  assert.equal(JSON.parse(res.body).users.length, 3, "the served answer is unchanged");
  const line = oneLine();
  assert.equal(line.path, "users.route");
  assert.equal(line.oldCount, 3);
  assert.equal(line.newTotal, 2, "own dealer's ACTIVE rep + the admin; not the other dealer's");
  assert.equal(line.countSourcesDiffer, true);
  assert.ok(
    countQueries()[0].eq.some((e) => e.column === "active" && e.value === true),
    "active-only is the endpoint's rule and must be applied to both sides"
  );
});

test("users.route, TENANT scope: identical by construction", async () => {
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Admin", { dealer: null });
  ctx.sfRows = [{ Id: REP_A, First_Name__c: "Rep", Last_Name__c: "A" }];
  await handler(event("/sf/users", null));
  const line = oneLine();
  assert.equal(line.newCountSource, "identical_by_construction");
  assert.deepEqual(countQueries(), []);
});

test("GET /sf/user (the object list) uses the union too, not a denial", async () => {
  // Two different routes, one filter. If this used rowFilter it would log `forbidden`,
  // and the three-day gate would be measuring a blackout that is not the design.
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Dealer", { userId: REP_A });
  ctx.cacheRows = [
    { __table: "sundial_user_cache", sf_id: REP_A, client_sf_id: TENANT, dealer_sf_id: DEALER, access_level: "Sales Rep", active: true, is_stale: false, last_synced_at: new Date().toISOString() },
    { __table: "sundial_user_cache", sf_id: REP_B, client_sf_id: TENANT, dealer_sf_id: "a0Y0000000OTHERAA", access_level: "Sales Rep", active: true, is_stale: false, last_synced_at: new Date().toISOString() },
  ];

  await handler(listEvent("user"));
  const line = oneLine();
  assert.equal(line.path, "list.cache");
  assert.equal(line.newOutcome, "served", "NOT forbidden — the union answers for `user`");
  assert.equal(line.newTotal, 1);
});

test("meta.picklists: module gate only, and it says so", async () => {
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });

  await handler(event("/sf/meta/customer/picklists", { object: "customer" }));
  const line = oneLine();
  assert.equal(line.path, "meta.picklists");
  assert.equal(line.newOutcome, "served");
  assert.equal(
    line.fieldFilter,
    "deferred_phase4",
    "the field-level narrowing needs the Phase 4 manifest; the line must not imply otherwise"
  );
  assert.deepEqual(countQueries(), [], "a metadata route must not open a DB connection");
});

test("meta.picklist on a DENIED object is forbidden for a sales scope", async () => {
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  await handler(
    event("/sf/meta/roofing/picklist/Stage__c", { object: "roofing", field: "Stage__c" })
  );
  const line = oneLine();
  assert.equal(line.path, "meta.picklist");
  assert.equal(line.newOutcome, "forbidden");
  assert.equal(line.narrower, true);
});

// ---------------------------------------------------------------------------
// 3. Shadow cannot break a request
// ---------------------------------------------------------------------------

test("a THROWING lib/access does not fail the request", async () => {
  // The property the whole phase rests on. Whatever goes wrong inside the shadow
  // computation, the caller gets the response they would have got with the feature off.
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A), customerRow(CUST_2, REP_B)];

  ctx.accessThrows = true;
  const res = await handler(listEvent("customer", { limit: "10" }));
  const body = JSON.parse(res.body);

  assert.equal(res.statusCode, 200);
  assert.equal(body.records.length, 2);
  assert.equal(body.source, "cache");
  const line = oneLine();
  assert.equal(line.verdict, "unknown");
  assert.equal(line.newOutcome, "unknown");
  assert.match(line.error, /exploded/);
});

test("a throwing lib/access does not fail a SINGLE read either", async () => {
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A)];

  ctx.accessThrows = true;
  const res = await handler(singleEvent("customer", CUST_1));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).record.sf_id, CUST_1);
  assert.equal(oneLine().verdict, "unknown");
});

test("a FAILING cache count is one log line, not a 500", async () => {
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A)];

  ctx.failHeadCount = true;
  const res = await handler(listEvent("customer"));
  assert.equal(res.statusCode, 200, "the read must survive a broken shadow count");
  assert.equal(JSON.parse(res.body).records.length, 1);
  const line = oneLine();
  assert.equal(line.verdict, "unknown");
  assert.match(line.error, /PostgREST unavailable/);
});

// ---------------------------------------------------------------------------
// 4. One request, one line
// ---------------------------------------------------------------------------

test("every read path emits EXACTLY ONE line", async () => {
  // A path that emits twice double-counts in the summary; a path that emits none is
  // indistinguishable from a path nobody used. Both would corrupt the §8 gate.
  process.env.ACCESS_MODEL_MODE = "shadow";
  const cases = [
    ["list", () => listEvent("customer")],
    ["search", () => listEvent("customer", { q: "ZZ" })],
    ["single", () => singleEvent("customer", CUST_1)],
    ["full", () => singleEvent("customer", CUST_1, { full: "true" })],
    ["users", () => event("/sf/users", null)],
    ["picklists", () => event("/sf/meta/customer/picklists", { object: "customer" })],
  ];
  for (const [label, make] of cases) {
    ctx.logs = [];
    ctx.identity = identityFor("Sales Rep", { userId: REP_A });
    ctx.cacheRows = [customerRow(CUST_1, REP_A)];
    ctx.sfRows = [{ Id: CUST_1, Client__c: TENANT, Sales_Rep__c: REP_A }];
    await handler(make());
    assert.equal(shadowLines().length, 1, `${label} emitted ${shadowLines().length} lines`);
  }
});

test("no token, secret, email or record id reaches the log", async () => {
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A, { name: "Real Person" })];

  await handler(singleEvent("customer", CUST_1));
  const raw = ctx.logs.join("\n");
  assert.ok(!raw.includes("test.jwt"), "no token");
  assert.ok(!raw.includes(CUST_1), "no record id");
  assert.ok(!raw.includes("Real Person"), "no record data");
  assert.ok(raw.includes(REP_A), "the CALLER's user id is logged, and is the join key");
});


// ---------------------------------------------------------------------------
// 5. `none` scope must be IDENTIFIABLE, not just denied
// ---------------------------------------------------------------------------
// Found by the first live shadow run, not by these tests, which is why they exist now:
// accessBlock() nulls userId/dealerId for scope `none`, so taking the log's join key from
// there collapsed every unattributed rep, inactive-dealer rep and Technician into one
// "(unknown)" row. §8's gate requires those users be identified and re-levelled before
// Phase 3 — a bucket cannot be re-levelled.

test("a `none` user is still IDENTIFIED in the line", async () => {
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Technician", { userId: REP_B });
  ctx.cacheRows = [customerRow(CUST_1, REP_A)];

  await handler(listEvent("customer"));
  const line = oneLine();
  assert.equal(line.scope, "none");
  assert.equal(line.user, REP_B, "the caller must be nameable even with no scope");
  assert.equal(line.level, "Technician");
  assert.equal(line.newOutcome, "forbidden");
});

test("the THREE ways to reach `none` are told apart by the line alone", async () => {
  // Technician / unattributed rep / switched-off dealer all resolve to the same scope and
  // the same denial. They need completely different fixes, so the line has to distinguish
  // them without a second lookup.
  process.env.ACCESS_MODEL_MODE = "shadow";
  const cases = [
    [
      "Technician",
      { userId: "a1O7y00000TECHAAAAA" },
      { level: "Technician", dealer: DEALER, dealerActive: true },
    ],
    [
      "Sales Rep",
      { userId: "a1O7y00000NODEALERA", dealer: null },
      { level: "Sales Rep", dealer: null, dealerActive: null },
    ],
    [
      "Sales Rep",
      { userId: "a1O7y00000INACTIVED", dealer: { id: DEALER, active: false, isInternal: false } },
      { level: "Sales Rep", dealer: DEALER, dealerActive: false },
    ],
  ];
  const seen = new Set();
  for (const [level, over, expected] of cases) {
    ctx.logs = [];
    ctx.identity = identityFor(level, over);
    ctx.cacheRows = [];
    await handler(listEvent("customer"));
    const line = oneLine();
    assert.equal(line.scope, "none", `${level} ${over.userId}`);
    assert.equal(line.user, over.userId, "each is a distinct, nameable user");
    assert.equal(line.level, expected.level);
    assert.equal(line.dealer, expected.dealer);
    assert.equal(line.dealerActive, expected.dealerActive);
    seen.add(`${line.user}|${line.level}|${line.dealer}|${line.dealerActive}`);
  }
  assert.equal(seen.size, 3, "three users must produce three distinguishable signatures");
});

test("a scoped user's dealer is the RESOLVED one, not the raw fallback", async () => {
  // The fallback must not quietly change what a working line reports.
  process.env.ACCESS_MODEL_MODE = "shadow";
  ctx.identity = identityFor("Sales Dealer", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A)];
  await handler(listEvent("customer"));
  const line = oneLine();
  assert.equal(line.scope, "dealer");
  assert.equal(line.dealer, DEALER);
  assert.equal(line.dealerActive, true);
});


// ---------------------------------------------------------------------------
// 6. Phase 4 — the field manifest (§4.3, §4.4)
// ---------------------------------------------------------------------------
// These run against the REAL generated manifest, not a fixture, so they fail if the
// workbook stops saying what the assertions assume. That is the intent: the sheet is the
// source of truth and a test that mocked it would be testing itself.

test("?full=true: a hidden field is ABSENT from the response for a rep", async () => {
  // Commission and burden fields are `hidden` for Sales Rep in the customer workbook.
  // "Absent", not "null": a null would tell the rep the field exists and is empty.
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.sfRows = [{
    Id: CUST_1, Client__c: TENANT, Sales_Rep__c: REP_A,
    First_Name__c: "Zed", Commission_Total__c: 3834.5, Burden_Rate__c: 0.21,
  }];

  const res = await handler(singleEvent("customer", CUST_1, { full: "true" }));
  const body = JSON.parse(res.body);

  assert.equal(res.statusCode, 200);
  assert.ok(!("Commission_Total__c" in body.record), "commission must not be present");
  assert.ok(!("Burden_Rate__c" in body.record), "burden rate must not be present");
  assert.equal(body.record.First_Name__c, "Zed", "a readable field still comes through");
});

test("?full=true: the hidden fields are NEVER FETCHED, not fetched-then-stripped", async () => {
  // §4.3 is explicit about this and it is the stronger property: data a role may not see
  // should not leave Salesforce at all. A strip-after-fetch would hold the values in
  // Lambda memory and in any log line that dumped the record.
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.sfRows = [{ Id: CUST_1, Client__c: TENANT, Sales_Rep__c: REP_A }];

  await handler(singleEvent("customer", CUST_1, { full: "true" }));

  const soql = ctx.soqlSeen.find((q) => /FROM Sundial_Customer__c/.test(q));
  assert.ok(soql, "expected the full-mode query");
  assert.doesNotMatch(soql, /Commission_Total__c/, "hidden field must not be SELECTed");
  assert.doesNotMatch(soql, /Burden_Rate__c/, "nor this one");
  assert.match(soql, /First_Name__c/, "readable fields are still selected");
});

test("?full=true: access.editable matches the manifest, and excludes protected fields", async () => {
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.sfRows = [{ Id: CUST_1, Client__c: TENANT, Sales_Rep__c: REP_A }];

  const res = await handler(singleEvent("customer", CUST_1, { full: "true" }));
  const body = JSON.parse(res.body);

  assert.ok(Array.isArray(body.access.editable), "the client needs a list to reflect");
  assert.deepEqual(
    body.access.editable,
    [...customerManifest.roles["Sales Rep"].edit].sort(),
    "editable is the manifest's edit set, verbatim"
  );
  for (const protectedField of ["Sales_Rep__c", "Dealer__c", "Client__c", "Stage__c"]) {
    assert.ok(
      !body.access.editable.includes(protectedField),
      `${protectedField} must never be editable by a sales role`
    );
  }
  assert.match(body.access.manifestVersion, /^customer:[0-9a-f]{8}/);
});

test("?full=true: TENANT scope is unprojected and unchanged", async () => {
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Admin", { dealer: null });
  ctx.sfRows = [{
    Id: CUST_1, Client__c: TENANT, First_Name__c: "Zed", Commission_Total__c: 3834.5,
  }];

  const res = await handler(singleEvent("customer", CUST_1, { full: "true" }));
  const body = JSON.parse(res.body);

  assert.equal(body.record.Commission_Total__c, 3834.5, "staff still see commissions");
  assert.equal(body.access.editable, null, "null means: apply your existing describe rules");
});

test("list rows are projected too — the hidden columns do not ride along", async () => {
  // The detail view is not the only way a field reaches the browser. A list row carries
  // the same columns, and projecting only the detail read would have left every hidden
  // number sitting in the list payload.
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [
    customerRow(CUST_1, REP_A, { commission_total: 3834.5, burden_rate: 0.21, stage: "Sold" }),
  ];

  const res = await handler(listEvent("customer"));
  const [row] = JSON.parse(res.body).records;

  assert.ok(!("commission_total" in row), "hidden column must not reach a list row");
  assert.ok(!("burden_rate" in row), "nor this one");
  assert.equal(row.sf_id, CUST_1, "control columns survive — a row needs to be a row");
  assert.equal(row.client_sf_id, TENANT);
});

test("search rows are projected on the same rule as list rows", async () => {
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A, { name: "ZZ Alpha", commission_total: 99 })];

  const res = await handler(listEvent("customer", { q: "ZZ" }));
  const [row] = JSON.parse(res.body).records;
  assert.ok(row, "the row is still served");
  assert.ok(!("commission_total" in row), "and still projected");
});

test("§4.4: picklist metadata is filtered to the role's fields", async () => {
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });

  const res = await handler(
    event("/sf/meta/customer/picklists", { object: "customer" })
  );
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  const rep = new Set(customerManifest.roles["Sales Rep"].read);
  for (const name of Object.keys(body.picklists)) {
    assert.ok(rep.has(name), `${name} is not readable by this role and must not appear`);
  }
});

test("§4.4: a single picklist for a hidden field 404s — not 403", async () => {
  // Same reasoning as a record: a 403 confirms the field exists, which turns the
  // describe into an enumeration oracle. It must be indistinguishable from a typo.
  process.env.ACCESS_MODEL_MODE = "enforce";
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });

  const res = await handler(
    event("/sf/meta/customer/picklist/Hidden_Picklist__c", {
      object: "customer",
      field: "Hidden_Picklist__c",
    })
  );
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).code, "FIELD_NOT_FOUND");
});

test("THE PHASE 4 SWITCH: with the mode OFF, nothing is projected", async () => {
  // The same property Phases 2 and 3 shipped under, and the one that makes the env var a
  // real rollback: field projection is bound to enforce, not to the deploy.
  delete process.env.ACCESS_MODEL_MODE;
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.cacheRows = [customerRow(CUST_1, REP_A, { commission_total: 3834.5 })];
  ctx.sfRows = [{ Id: CUST_1, Client__c: TENANT, Commission_Total__c: 3834.5 }];

  const list = await handler(listEvent("customer"));
  assert.equal(
    JSON.parse(list.body).records[0].commission_total,
    3834.5,
    "mode off must not project"
  );

  const full = await handler(singleEvent("customer", CUST_1, { full: "true" }));
  assert.equal(JSON.parse(full.body).record.Commission_Total__c, 3834.5);
  assert.equal(JSON.parse(full.body).access.editable, null);
});

// Restore the console for any downstream reporter.
test.after(() => {
  console.log = realLog;
  console.warn = realWarn;
});
