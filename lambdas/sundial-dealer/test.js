// node --experimental-test-module-mocks --test lambdas/sundial-dealer/test.js
//
// Drives the real handler with a fake identity, a fake Salesforce, a fake Supabase builder
// and a fake describe / OpenAPI (the sf-query test harness). The shared lib/full-read.js,
// lib/cache-read.js and the real field manifests run unmocked, so the narrowed SELECT and
// the projections are the real ones.
//
// Pinned:
//   - the action gate: tenant / dealer / own in, tech and none 403; always on, whatever
//     ACCESS_MODEL_MODE says;
//   - the list: the VIEW, tenant + the customer row filter FIRST, the Service-only
//     exclusion (null-safe), search, the journey-stage or-group, limit clamp, 400s;
//   - list rows: manifest projection, the view's own columns never leaked, the solar
//     summary through the SOLAR manifest, the journey;
//   - the detail: one SOQL carrying the row filter (404 when it finds nothing, with no
//     solar read after it), the narrowed SELECT, the solar found by customer id and NOT by
//     its own dealer / rep, the newest one leading, solarCount, the access block (solar
//     visible ⊆ the solar manifest), picklists limited to readable fields, the journey;
//   - pickLeadingSolar agrees with the view's ORDER BY, and its source list is sf-query's.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolveScope, accessBlock } from "../../lib/access.js";

const TENANT = "a1W7y000007AszBEAS";
const REP = "a0U000000000REPAAA";
const DEALER = "a2D000000000DLRAAA";
const CUST = "a1P000000000001AAA";
const SOLAR_OLD = "a1S000000000001AAA";
const SOLAR_NEW = "a1S000000000002AAA";

const ctx = {};
function reset() {
  ctx.level = "Sales Rep";
  ctx.soql = [];
  ctx.calls = [];
  ctx.viewRows = [];
  ctx.customerRows = [];
  ctx.solarCandidates = [];
  ctx.solarRecords = {};
}

const USERS = {
  "Sales Rep": { id: REP, accessLevel: "Sales Rep", dealer: { id: DEALER, active: true, isInternal: false } },
  "Sales Dealer": { id: "a0U000000000MGRAAA", accessLevel: "Sales Dealer", dealer: { id: DEALER, active: true, isInternal: false } },
  Admin: { id: "a0U000000000ADMAAA", accessLevel: "Admin", dealer: null },
  Technician: { id: "a0U000000000TECAAA", accessLevel: "Technician", dealer: null },
  None: { id: "a0U000000000NONAAA", accessLevel: "Sales Rep", dealer: null },
};
const accessFor = (level) => accessBlock(resolveScope(USERS[level], TENANT));

mock.module("../../lib/identity.js", {
  namedExports: {
    resolveIdentity: async () => ({ tenantId: TENANT, tenantSlug: "harmon", user: USERS[ctx.level], access: accessFor(ctx.level) }),
  },
});

mock.module("../../lib/salesforce.js", {
  namedExports: {
    soqlEscapeString: (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    getSalesforceToken: async () => ({ access_token: "tok", instance_url: "https://example.my.salesforce.com" }),
    sfQuery: async (soql) => {
      ctx.soql.push(soql);
      if (soql.includes(" FROM Sundial_Customer__c ")) return ctx.customerRows;
      if (soql.includes(" FROM Sundial_Solar__c ") && soql.endsWith("LIMIT 200")) return ctx.solarCandidates;
      if (soql.includes(" FROM Sundial_Solar__c ")) {
        const id = soql.match(/WHERE Id = '([^']+)'/)?.[1];
        return ctx.solarRecords[id] ? [ctx.solarRecords[id]] : [];
      }
      return [];
    },
  },
});

function builder(table) {
  const b = {
    _calls: [],
    select(sel, opts) { ctx.calls.push(["from", table], ["select", sel, opts]); return b; },
    eq(c, v) { ctx.calls.push(["eq", c, v]); return b; },
    or(expr) { ctx.calls.push(["or", expr]); return b; },
    order(c, o) { ctx.calls.push(["order", c, o]); return b; },
    range(a, z) {
      ctx.calls.push(["range", a, z]);
      return Promise.resolve({ data: ctx.viewRows, count: ctx.viewRows.length, error: null });
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

const VIEW_COLUMNS = [
  "journey_solar_sf_id", "journey_solar_stage", "journey_solar_project_name", "journey_solar_count",
  "sf_id", "client_sf_id", "tenant_id", "created_date", "is_stale", "last_synced_at", "cache_version",
  "name", "first_name", "last_name", "stage", "status", "street", "city", "postal_code", "primary_email", "primary_phone",
  "company_name", "alternate_contact_phone", "alternate_contact_email", "customer_type", "lead_source",
  "sales_rep_sf_id", "dealer_sf_id", "commission_total", "notes", "sales_rep_name", "lastmodifieddate",
];
const pl = (values, extra = {}) => ({ type: "picklist", picklistValues: values.map((v) => ({ label: v, value: v, active: true })), ...extra });
const DESCRIBE = {
  Sundial_Customer__c: [
    { name: "Id", type: "id" }, { name: "Client__c", type: "reference" }, { name: "Name", type: "string" },
    { name: "First_Name__c", type: "string" }, { name: "Last_Name__c", type: "string" },
    { name: "Status__c", ...pl(["Lead", "Opportunity"]) }, { name: "Stage__c", ...pl(["New", "Appointment Set"], { controllerName: "Status__c" }) },
    { name: "Sales_Rep__c", type: "reference" }, { name: "Dealer__c", type: "reference" },
    { name: "Commission_Total__c", type: "currency" }, { name: "Commission_Redline_PPW__c", type: "double" },
    { name: "Lead_Source__c", ...pl(["Web", "Referral"]) },
  ],
  Sundial_Solar__c: [
    { name: "Id", type: "id" }, { name: "Client__c", type: "reference" }, { name: "Project_Name__c", type: "string" },
    { name: "Stage__c", ...pl(["Audit", "Permitting"]) }, { name: "Contract_Amount__c", type: "currency" },
    { name: "Sales_Rep__c", type: "reference" }, { name: "Dealer__c", type: "reference" },
    { name: "Sundial_Customer__c", type: "reference" }, { name: "Sunbase_Created_Date__c", type: "datetime" },
    { name: "Contract_Date__c", type: "date" }, { name: "CreatedDate", type: "datetime" },
  ],
};
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/rest/v1/")) {
    const properties = Object.fromEntries(VIEW_COLUMNS.map((c) => [c, {}]));
    return { ok: true, status: 200, json: async () => ({ definitions: { sundial_dealer_customer_view: { properties } } }) };
  }
  const obj = u.match(/sobjects\/([^/]+)\/describe/)?.[1];
  return { ok: true, status: 200, json: async () => ({ fields: DESCRIBE[obj] || [] }) };
};

const { handler, matchRoute, stageOrExpr, pickLeadingSolar, toListRow, SOLAR_CREATED_DATE_SOURCE, VIEW, MAX_LIMIT } = await import("./index.js");
const { fieldsFor, listColumnsFor } = await import("../../lib/field-manifest/index.js");

const ev = (path, qs = null, method = "GET") => ({
  requestContext: { http: { method } },
  rawPath: path,
  queryStringParameters: qs,
  headers: { authorization: "Bearer t", origin: "http://localhost:5173" },
});
const body = (res) => JSON.parse(res.body);
const calls = (kind) => ctx.calls.filter((c) => c[0] === kind);

test.beforeEach(reset);

// --- routing and the gate ---------------------------------------------------------------

test("matchRoute: with and without the stage prefix; anything else is no route", () => {
  assert.deepEqual(matchRoute("/dealer/customers"), { name: "list", params: [] });
  assert.deepEqual(matchRoute("/prod/dealer/customers/"), { name: "list", params: [] });
  assert.deepEqual(matchRoute(`/prod/dealer/customers/${CUST}`), { name: "detail", params: [CUST] });
  assert.equal(matchRoute("/dealer/solar"), null);
  assert.equal(matchRoute(`/dealer/customers/${CUST}/files`), null);
});

test("OPTIONS is 204, a write is 405, an unknown path is 404", async () => {
  assert.equal((await handler(ev("/dealer/customers", null, "OPTIONS"))).statusCode, 204);
  assert.equal((await handler(ev("/dealer/customers", null, "POST"))).statusCode, 405);
  assert.equal((await handler(ev("/dealer/elsewhere"))).statusCode, 404);
});

test("dealer.read: a Technician and a sales user with no dealer are 403, before any read", async () => {
  for (const level of ["Technician", "None"]) {
    ctx.level = level;
    const res = await handler(ev("/dealer/customers"));
    assert.equal(res.statusCode, 403, level);
    assert.equal(body(res).code, "ACTION_FORBIDDEN");
    assert.equal(ctx.calls.length + ctx.soql.length, 0, `${level}: nothing read`);
  }
});

test("the gate does not follow ACCESS_MODEL_MODE: off still filters a rep to their own rows", async () => {
  const prev = process.env.ACCESS_MODEL_MODE;
  process.env.ACCESS_MODEL_MODE = "off";
  try {
    await handler(ev("/dealer/customers"));
    assert.ok(calls("eq").some(([, c, v]) => c === "sales_rep_sf_id" && v === REP));
  } finally {
    if (prev === undefined) delete process.env.ACCESS_MODEL_MODE;
    else process.env.ACCESS_MODEL_MODE = prev;
  }
});

// --- the list -----------------------------------------------------------------------------

test("list (rep): the VIEW, tenant then the row filter FIRST, then the Service-only exclusion, newest first", async () => {
  const res = await handler(ev("/dealer/customers"));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls("from")[0], ["from", VIEW]);
  const eqs = calls("eq").map(([, c, v]) => [c, v]);
  assert.deepEqual(eqs.slice(0, 3), [["client_sf_id", TENANT], ["client_sf_id", TENANT], ["sales_rep_sf_id", REP]]);
  const firstOr = ctx.calls.findIndex((c) => c[0] === "or");
  const lastEq = ctx.calls.map((c) => c[0]).lastIndexOf("eq");
  assert.ok(lastEq < firstOr, "every caller filter comes after the row filter");
  assert.deepEqual(calls("or")[0], ["or", 'customer_type.is.null,customer_type.neq."Service"'], "null-safe, never neq alone");
  assert.deepEqual(calls("order").map(([, c]) => c), ["created_date", "sf_id"]);
  assert.deepEqual(calls("range")[0], ["range", 0, 49], "default page of 50");
});

test("list (dealer): filtered by the dealer, not the rep", async () => {
  ctx.level = "Sales Dealer";
  await handler(ev("/dealer/customers"));
  const eqs = calls("eq").map(([, c, v]) => `${c}=${v}`);
  assert.ok(eqs.includes(`dealer_sf_id=${DEALER}`));
  assert.ok(!eqs.some((e) => e.startsWith("sales_rep_sf_id")));
});

test("list (tenant): the tenant clause only", async () => {
  ctx.level = "Admin";
  await handler(ev("/dealer/customers"));
  assert.deepEqual(calls("eq").map(([, c]) => c), ["client_sf_id", "client_sf_id"]);
});

test("list: q is the shared word search, stage the journey or-group, limit clamped, offset kept", async () => {
  await handler(ev("/dealer/customers", { q: "Ada Phoenix", stage: "appointment-set", limit: "999", offset: "40" }));
  const ors = calls("or").map(([, e]) => e);
  assert.equal(ors.length, 3);
  assert.match(ors[1], /^and\(or\(.*first_name\.ilike\."%Ada%".*\),or\(.*city\.ilike\."%Phoenix%"/);
  assert.equal(ors[2], stageOrExpr(["Appointment Set", "Follow Up", "Reschedule Needed", "Rescheduled Appointment", "10 Day Revive", "Reset"]));
  assert.deepEqual(calls("range")[0], ["range", 40, 40 + MAX_LIMIT - 1]);
});

test("list: a floor off-path key (Hold) filters on that one value — the deals no step can reach", async () => {
  await handler(ev("/dealer/customers", { stage: "hold" }));
  const ors = calls("or").map(([, e]) => e);
  assert.equal(ors[ors.length - 1], stageOrExpr(["Hold"]));
});

test("stageOrExpr: the customer's stage when there is no solar, the solar's when there is", () => {
  assert.equal(
    stageOrExpr(["Audit", "Site survey scheduled"]),
    'and(journey_solar_sf_id.is.null,stage.in.("Audit","Site survey scheduled")),' +
      'and(journey_solar_sf_id.not.is.null,journey_solar_stage.in.("Audit","Site survey scheduled"))'
  );
});

test("list: an unknown stage key and a sort off the allowlist are 400s; nothing is read", async () => {
  let res = await handler(ev("/dealer/customers", { stage: "not-a-stage" }));
  assert.equal(res.statusCode, 400);
  assert.equal(body(res).code, "INVALID_STAGE");
  res = await handler(ev("/dealer/customers", { sort: "commission_total:desc" }));
  assert.equal(res.statusCode, 400);
  assert.equal(body(res).code, "INVALID_SORT");
  assert.equal(calls("range").length, 0);
});

test("list rows: the role's columns only, never the view's own; the solar summary; the journey", async () => {
  ctx.viewRows = [
    { sf_id: CUST, client_sf_id: TENANT, name: "Ada Lee", first_name: "Ada", last_name: "Lee", stage: "Sold", status: "Opportunity",
      commission_total: 3834.5, primary_email: "ada@example.com", notes: "long", sales_rep_sf_id: REP,
      journey_solar_sf_id: SOLAR_NEW, journey_solar_stage: "Permitting", journey_solar_project_name: "Lee PV", journey_solar_count: 2 },
    { sf_id: "a1P000000000002AAA", client_sf_id: TENANT, name: "Bo", stage: "Follow Up", journey_solar_sf_id: null, journey_solar_count: 0 },
  ];
  const res = await handler(ev("/dealer/customers"));
  const b = body(res);
  assert.equal(b.total, 2);
  const [a, c] = b.records;
  const cols = listColumnsFor("customer", accessFor("Sales Rep"));
  for (const k of Object.keys(a)) if (!["solar", "journey", "updatedAt"].includes(k)) assert.ok(cols.has(k), `${k} is a rep list column`);
  assert.equal(a.commission_total, undefined, "hidden from a rep");
  assert.equal(a.sales_rep_sf_id, undefined, "an access column is not a rep list column");
  assert.equal(a.notes, undefined, "long text is never in a list row");
  for (const k of ["journey_solar_sf_id", "journey_solar_stage", "journey_solar_count"]) assert.equal(a[k], undefined, k);
  assert.deepEqual(a.solar, { sf_id: SOLAR_NEW, stage: "Permitting", project_name: "Lee PV" });
  assert.deepEqual(a.journey, { stage: "permitting", source: "solar", index: 15, offPath: null });
  assert.equal(c.solar, null);
  assert.equal(c.journey.stage, "appointment-set");
  assert.deepEqual(c.journey.offPath, { value: "Follow Up", anchor: "appointment-set", tone: "info" });
});

test("toListRow (tenant scope): every customer column, still not the view's journey columns", () => {
  const r = toListRow({ sf_id: CUST, stage: "New", commission_total: 1, journey_solar_sf_id: null, journey_solar_count: 0 }, accessFor("Admin"));
  assert.equal(r.commission_total, 1);
  assert.equal(r.journey_solar_count, undefined);
  assert.equal(r.journey.source, "customer");
});

// --- rep name and last updated (2026-10-26) ------------------------------------------------

test("manifest: Sales_Rep_Name__c is read (never edit) and sales_rep_name a list column, for rep AND dealer", () => {
  for (const level of ["Sales Rep", "Sales Dealer"]) {
    const f = fieldsFor("customer", accessFor(level));
    assert.ok(f.read.has("Sales_Rep_Name__c"), `${level} reads it`);
    assert.ok(!f.edit.has("Sales_Rep_Name__c"), `${level} never edits a formula`);
    assert.ok(listColumnsFor("customer", accessFor(level)).has("sales_rep_name"), `${level} list column`);
    assert.ok(!listColumnsFor("customer", accessFor(level)).has("lastmodifieddate"), "the raw column is not a list column");
  }
});

test("list rows (rep, dealer): carry sales_rep_name; updatedAt is the row's LastModifiedDate, the raw column never", async () => {
  const MOD = "2026-10-24T17:05:00.000Z";
  for (const level of ["Sales Rep", "Sales Dealer"]) {
    reset();
    ctx.level = level;
    ctx.viewRows = [{ sf_id: CUST, client_sf_id: TENANT, name: "Ada Lee", stage: "Sold", sales_rep_name: "Rae Rep", lastmodifieddate: MOD,
      last_synced_at: "2026-10-26T00:00:00Z", journey_solar_sf_id: null, journey_solar_count: 0 }];
    const res = await handler(ev("/dealer/customers"));
    assert.equal(res.statusCode, 200);
    const sel = calls("select")[0][1].split(",");
    assert.ok(sel.includes("sales_rep_name") && sel.includes("lastmodifieddate"), "both are selected from the view");
    const [r] = body(res).records;
    assert.equal(r.sales_rep_name, "Rae Rep", level);
    assert.equal(r.updatedAt, MOD, `${level}: the Salesforce modification time, not last_synced_at`);
    assert.equal(r.lastmodifieddate, undefined, level);
  }
});

test("toListRow: updatedAt for tenant scope too, without the raw column; null when the cache has none", () => {
  const admin = toListRow({ sf_id: CUST, stage: "New", lastmodifieddate: "2026-10-01T00:00:00Z", journey_solar_sf_id: null }, accessFor("Admin"));
  assert.equal(admin.updatedAt, "2026-10-01T00:00:00Z");
  assert.equal(admin.lastmodifieddate, undefined, "row metadata, not a passed-through column");
  const blank = toListRow({ sf_id: CUST, stage: "New", journey_solar_sf_id: null }, accessFor("Sales Rep"));
  assert.equal(blank.updatedAt, null, "a row synced before the column existed");
});

// --- the detail ---------------------------------------------------------------------------

function seedDetail() {
  ctx.customerRows = [{ attributes: { type: "Sundial_Customer__c" }, Id: CUST, Client__c: TENANT, Name: "Ada Lee", Stage__c: "Sold", Status__c: "Opportunity" }];
  ctx.solarCandidates = [
    { Id: SOLAR_OLD, Sunbase_Created_Date__c: null, Contract_Date__c: "2025-01-01", CreatedDate: "2026-09-01T00:00:00Z" },
    { Id: SOLAR_NEW, Sunbase_Created_Date__c: "2026-03-01T00:00:00Z", Contract_Date__c: null, CreatedDate: "2026-09-02T00:00:00Z" },
  ];
  // The solar belongs to ANOTHER rep and dealer — still this customer's.
  ctx.solarRecords[SOLAR_NEW] = { Id: SOLAR_NEW, Client__c: TENANT, Project_Name__c: "Lee PV", Stage__c: "Permitting", Contract_Amount__c: 30000 };
}

test("detail (rep): one customer SOQL carrying the rep filter and only the rep's readable fields", async () => {
  seedDetail();
  const res = await handler(ev(`/dealer/customers/${CUST}`));
  assert.equal(res.statusCode, 200);
  const q = ctx.soql[0];
  assert.match(q, / FROM Sundial_Customer__c WHERE Id = 'a1P000000000001AAA' AND Client__c = 'a1W7y000007AszBEAS' AND .*Sales_Rep__c = 'a0U000000000REPAAA' LIMIT 1$/);
  const selected = q.slice(7, q.indexOf(" FROM ")).split(", ");
  const read = fieldsFor("customer", accessFor("Sales Rep")).read;
  for (const f of selected) assert.ok(f === "Id" || f === "Client__c" || read.has(f), `${f} selected`);
  assert.ok(!selected.includes("Commission_Total__c"), "a hidden field never leaves Salesforce");
});

test("detail: the solar is found by its customer and tenant only, the newest leads, bound to the customer", async () => {
  seedDetail();
  const b = body(await handler(ev(`/dealer/customers/${CUST}`)));
  const cand = ctx.soql.find((s) => s.endsWith("LIMIT 200"));
  assert.equal(cand, `SELECT Id, Sunbase_Created_Date__c, Contract_Date__c, CreatedDate FROM Sundial_Solar__c WHERE Sundial_Customer__c = '${CUST}' AND Client__c = '${TENANT}' LIMIT 200`);
  assert.doesNotMatch(cand, /Sales_Rep__c|Dealer__c/, "never the solar's own rep or dealer");
  const full = ctx.soql.find((s) => s.includes(`WHERE Id = '${SOLAR_NEW}'`));
  assert.match(full, new RegExp(`AND Sundial_Customer__c = '${CUST}' LIMIT 1$`));
  assert.equal(b.solar.Id, SOLAR_NEW);
  assert.equal(b.solarCount, 2);
  assert.equal(b.customer.Id, CUST);
  assert.equal(b.customer.attributes, undefined);
});

test("detail: the access block — customer visible/editable, solar visible within the solar manifest", async () => {
  seedDetail();
  const b = body(await handler(ev(`/dealer/customers/${CUST}`)));
  const read = fieldsFor("solar", accessFor("Sales Rep")).read;
  assert.ok(Array.isArray(b.access.solar.visible) && b.access.solar.visible.length > 0);
  for (const f of b.access.solar.visible) assert.ok(read.has(f), `${f} in the solar manifest`);
  assert.equal(b.access.solar.editable, undefined, "the solar is read-only here");
  assert.ok(b.access.customer.editable.every((f) => b.access.customer.visible.includes(f)));
  assert.match(b.access.manifestVersion, /customer:/);
  for (const k of Object.keys(b.solar)) assert.ok(k === "Id" || k === "Client__c" || read.has(k), k);
});

test("detail: picklists are Stage + Status (with the dependency) and solar Stage, readable fields only", async () => {
  seedDetail();
  const b = body(await handler(ev(`/dealer/customers/${CUST}`)));
  assert.deepEqual(Object.keys(b.picklists.customer).sort(), ["Stage__c", "Status__c"]);
  assert.equal(b.picklists.customer.Stage__c.controllingField, "Status__c");
  assert.deepEqual(b.picklists.solar.Stage__c.values.map((v) => v.value), ["Audit", "Permitting"]);
});

test("detail: the journey leads with the solar", async () => {
  seedDetail();
  const b = body(await handler(ev(`/dealer/customers/${CUST}`)));
  assert.deepEqual(b.journey, { stage: "permitting", source: "solar", index: 15, offPath: null });
});

test("detail: no solar → solar null, count 0, access.solar null, the customer's journey", async () => {
  seedDetail();
  ctx.solarCandidates = [];
  const b = body(await handler(ev(`/dealer/customers/${CUST}`)));
  assert.equal(b.solar, null);
  assert.equal(b.solarCount, 0);
  assert.equal(b.access.solar, null);
  assert.deepEqual(b.journey.offPath, { value: "Sold", anchor: "sold-pending-review", tone: "info" });
});

test("detail: outside the row filter (no rows) is 404 and nothing else is read", async () => {
  ctx.customerRows = [];
  const res = await handler(ev(`/dealer/customers/${CUST}`));
  assert.equal(res.statusCode, 404);
  assert.equal(body(res).code, "RECORD_NOT_FOUND");
  assert.equal(ctx.soql.length, 1, "no solar query after a miss");
});

test("detail: a malformed id is 404 without a query", async () => {
  const res = await handler(ev("/dealer/customers/not-an-id'--"));
  assert.equal(res.statusCode, 404);
  assert.equal(ctx.soql.length, 0);
});

test("detail (tenant): every field, visible / editable null", async () => {
  ctx.level = "Admin";
  seedDetail();
  const b = body(await handler(ev(`/dealer/customers/${CUST}`)));
  assert.match(ctx.soql[0], /Commission_Total__c/);
  assert.doesNotMatch(ctx.soql[0], /Sales_Rep__c = /);
  assert.equal(b.access.customer.visible, null);
  assert.equal(b.access.solar.visible, null);
});

// --- which solar leads --------------------------------------------------------------------

test("pickLeadingSolar: first non-empty source, newest first, undated last, then Id descending", () => {
  const S = SOLAR_CREATED_DATE_SOURCE;
  assert.equal(pickLeadingSolar([], S), null);
  // Sunbase date beats a later CreatedDate (it is the first source).
  assert.equal(pickLeadingSolar([
    { Id: "a", Sunbase_Created_Date__c: "2024-01-01", CreatedDate: "2026-12-01T00:00:00Z" },
    { Id: "b", Sunbase_Created_Date__c: "2025-01-01", CreatedDate: "2026-01-01T00:00:00Z" },
  ], S).Id, "b");
  // Dated beats undated, whatever the order.
  assert.equal(pickLeadingSolar([{ Id: "z" }, { Id: "a", Contract_Date__c: "2020-01-01" }], S).Id, "a");
  // Ties (both undated, or the same instant) → the higher Id.
  assert.equal(pickLeadingSolar([{ Id: "a" }, { Id: "c" }, { Id: "b" }], S).Id, "c");
  assert.equal(pickLeadingSolar([{ Id: "a", CreatedDate: "2026-01-01T00:00:00Z" }, { Id: "b", CreatedDate: "2026-01-01T00:00:00.000Z" }], S).Id, "b");
});

test("the source list is sf-query's CREATED_DATE_SOURCE.solar — the cache column the view sorts by", async () => {
  const { CREATED_DATE_SOURCE } = await import("../sundial-sf-query/index.js");
  assert.deepEqual([...SOLAR_CREATED_DATE_SOURCE], CREATED_DATE_SOURCE.solar);
});
