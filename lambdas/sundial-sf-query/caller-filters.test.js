// Tests for caller-filters.js — f[] / not[] / sort parsing and their PostgREST and SOQL
// forms (D-080).
//
// Run with:  npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
  readMulti,
  parseCallerFilters,
  parseSort,
  applyCallerFiltersToQuery,
  callerFiltersToSoql,
  filtersToNarrow,
  pgrstQuote,
  IGNORED_FILTER_COLUMNS,
  PIPELINE_NARROW_COLUMNS,
} from "./caller-filters.js";

const COLS = new Set(["sf_id", "status", "stage", "lead_source", "customer_type", "call_attempts", "sales_rep_name", "sales_rep_sf_id", "dealer_sf_id", "client_sf_id", "created_date", "name", "street", "primary_phone", "requested_project_types"]);
const m = (obj) => new Map(Object.entries(obj).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));

/** A recording stand-in for a supabase-js builder. */
function rec() {
  const ops = [];
  const b = {
    ops,
    eq: (c, v) => (ops.push(["eq", c, v]), b),
    or: (e) => (ops.push(["or", e]), b),
    in: (c, v) => (ops.push(["in", c, v]), b),
    neq: (c, v) => (ops.push(["neq", c, v]), b),
  };
  return b;
}

// --- readMulti: the repeated-key trap -------------------------------------------------

test("readMulti prefers multiValueQueryStringParameters (queryStringParameters keeps only the LAST repeat)", () => {
  const event = {
    queryStringParameters: { "f[stage]": "B" },
    multiValueQueryStringParameters: { "f[stage]": ["A", "B"] },
  };
  assert.deepEqual(readMulti(event, event.queryStringParameters).get("f[stage]"), ["A", "B"]);
});

test("readMulti falls back to qs when the event has no multi-value map", () => {
  assert.deepEqual(readMulti({}, { "f[stage]": "A" }).get("f[stage]"), ["A"]);
});

// --- parseCallerFilters ---------------------------------------------------------------

test("different columns AND; the same column repeated is any-of; '' is blank", () => {
  const r = parseCallerFilters(m({ "f[status]": "Lead", "f[stage]": ["", "Odd", "Odd"] }), COLS);
  assert.ok(r.ok);
  assert.deepEqual(r.filters.any, [
    { column: "status", values: ["Lead"], blank: false },
    { column: "stage", values: ["Odd"], blank: true },
  ]);
  assert.equal(r.filters.active, true);
});

test("an unknown column is 400 INVALID_FILTER_FIELD naming it", () => {
  const r = parseCallerFilters(m({ "f[nope]": "x" }), COLS);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "INVALID_FILTER_FIELD");
  assert.equal(r.body.field, "nope");
  assert.equal(parseCallerFilters(m({ "f[Status]": "x" }), COLS).body.field, "Status", "column names are exact");
  assert.equal(parseCallerFilters(m({ "f[a;drop]": "x" }), COLS).body.code, "INVALID_FILTER_FIELD");
});

test("tenant and access columns are IGNORED from the caller, never honoured", () => {
  for (const col of ["client_sf_id", "tenant_id", "sales_rep_sf_id", "dealer_sf_id", "access_level"]) {
    assert.ok(IGNORED_FILTER_COLUMNS.has(col), col);
    const r = parseCallerFilters(m({ [`f[${col}]`]: "x", [`not[${col}]`]: "y" }), COLS);
    assert.ok(r.ok, col);
    assert.deepEqual(r.filters.any, []);
    assert.deepEqual(r.filters.not, []);
    assert.equal(r.filters.active, false);
    assert.ok(r.filters.ignored.includes(col));
  }
});

test("not[] is exact only: a value is required; repeats are each excluded", () => {
  assert.equal(parseCallerFilters(m({ "not[customer_type]": "" }), COLS).body.code, "INVALID_FILTER_VALUE");
  const r = parseCallerFilters(m({ "not[customer_type]": ["Service", "Roofing"] }), COLS);
  assert.deepEqual(r.filters.not, [{ column: "customer_type", value: "Service" }, { column: "customer_type", value: "Roofing" }]);
});

test("other bracket forms are not filters (ignored like any unknown query key)", () => {
  const r = parseCallerFilters(m({ "in[status]": "x", "f[]": "y", fields: "list" }), COLS);
  assert.equal(r.ok, false, "an empty column name is refused");
  assert.equal(parseCallerFilters(m({ "in[status]": "x" }), COLS).filters.active, false);
});

test("limits: values per column, value length", () => {
  assert.equal(parseCallerFilters(m({ "f[stage]": Array.from({ length: 101 }, (_, i) => `s${i}`) }), COLS).body.code, "TOO_MANY_FILTER_VALUES");
  assert.equal(parseCallerFilters(m({ "f[stage]": "x".repeat(256) }), COLS).body.code, "INVALID_FILTER_VALUE");
});

test("pipeline narrowing: only stage / rep name / source, and no not[]", () => {
  const opt = { allowColumns: PIPELINE_NARROW_COLUMNS, allowNot: false };
  assert.ok(parseCallerFilters(m({ "f[sales_rep_name]": "Ann" }), null, opt).ok);
  assert.equal(parseCallerFilters(m({ "f[status]": "Lead" }), null, opt).body.field, "status");
  assert.equal(parseCallerFilters(m({ "not[stage]": "x" }), null, opt).body.code, "INVALID_FILTER_FIELD");
  const n = filtersToNarrow(parseCallerFilters(m({ "f[stage]": ["", "New"] }), null, opt).filters);
  assert.deepEqual(n, { stage: { values: ["New"], blank: true } });
  assert.equal(filtersToNarrow(parseCallerFilters(new Map(), null, opt).filters), null);
});

// --- the PostgREST form -------------------------------------------------------------

test("not[] is NULL-safe: or(col.is.null,col.neq.\"v\"), never a bare neq", () => {
  const q = applyCallerFiltersToQuery(rec(), parseCallerFilters(m({ "not[customer_type]": "Service" }), COLS).filters);
  assert.deepEqual(q.ops, [["or", 'customer_type.is.null,customer_type.neq."Service"']]);
  assert.ok(!q.ops.some(([op]) => op === "neq"));
});

test("one value → eq; several → quoted in.(); with blank → is.null / eq.\"\" / in.()", () => {
  const f = (o) => applyCallerFiltersToQuery(rec(), parseCallerFilters(m(o), COLS).filters).ops;
  assert.deepEqual(f({ "f[status]": "Lead" }), [["eq", "status", "Lead"]]);
  assert.deepEqual(f({ "f[stage]": ["A", "B"] }), [["or", 'stage.in.("A","B")']]);
  assert.deepEqual(f({ "f[stage]": "" }), [["or", 'stage.is.null,stage.eq.""']]);
  assert.deepEqual(f({ "f[stage]": ["", "Odd"] }), [["or", 'stage.is.null,stage.eq."",stage.in.("Odd")']]);
});

test("pgrstQuote escapes quotes and backslashes (the live 'Clean Energy Experts \"B\"')", () => {
  assert.equal(pgrstQuote('Clean Energy Experts "B"'), '"Clean Energy Experts \\"B\\""');
  assert.equal(pgrstQuote("a\\b"), '"a\\\\b"');
  assert.equal(pgrstQuote("a, b (c)"), '"a, b (c)"');
});

test("no filters → the builder is untouched", () => {
  const q = applyCallerFiltersToQuery(rec(), parseCallerFilters(new Map(), COLS).filters);
  assert.deepEqual(q.ops, []);
});

// --- sort ------------------------------------------------------------------------------

test("sort: allowlisted column with direction; default asc; NOT allowlisted → 400", () => {
  assert.deepEqual(parseSort({ sort: "name:desc" }, "customer", COLS).sort, { column: "name", ascending: false });
  assert.deepEqual(parseSort({ sort: "call_attempts" }, "customer", COLS).sort, { column: "call_attempts", ascending: true });
  assert.equal(parseSort({}, "customer", COLS).sort, null);
  const bad = parseSort({ sort: "primary_email:asc" }, "customer", COLS);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "INVALID_SORT");
  assert.equal(parseSort({ sort: "name;drop" }, "customer", COLS).body.code, "INVALID_SORT");
  assert.equal(parseSort({ sort: "name:sideways" }, "customer", COLS).body.code, "INVALID_SORT");
});

test("sort: the Sales table's Address / Phone / Requested Types columns are sortable (2026-10-05)", () => {
  for (const col of ["street", "primary_phone", "requested_project_types"]) {
    assert.deepEqual(parseSort({ sort: `${col}:desc` }, "customer", COLS).sort, { column: col, ascending: false }, col);
  }
  assert.equal(parseSort({ sort: "street:asc" }, "job", COLS).body.code, "INVALID_SORT", "customer only");
});

test("sort: an object with no allowlist may only sort by created_date", () => {
  assert.ok(parseSort({ sort: "created_date:asc" }, "job", COLS).ok);
  assert.equal(parseSort({ sort: "name:asc" }, "job", COLS).body.code, "INVALID_SORT");
});

test("sort: an allowlisted column the cache table lacks is refused", () => {
  assert.equal(parseSort({ sort: "last_name:asc" }, "customer", COLS).body.code, "INVALID_SORT");
});

// --- SOQL form (cold-cache path) ------------------------------------------------------

const FIELDS = {
  status: { name: "Status__c", type: "picklist" },
  customer_type: { name: "Customer_Type__c", type: "multipicklist" },
  call_attempts: { name: "Call_Attempts__c", type: "double" },
  stage: { name: "Stage__c", type: "picklist" },
};
const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

test("SOQL: typed literals, OR-of-equals for any-of, null-safe exclusion", () => {
  const filters = parseCallerFilters(m({ "f[status]": "Lead", "f[stage]": ["", "O'Brien"], "f[call_attempts]": "3", "not[customer_type]": "Service" }), COLS).filters;
  const r = callerFiltersToSoql(filters, (c) => FIELDS[c], esc);
  assert.deepEqual(r.clauses, [
    "Status__c = 'Lead'",
    "(Stage__c = 'O\\'Brien' OR Stage__c = null)",
    "Call_Attempts__c = 3",
    "(Customer_Type__c = null OR Customer_Type__c != 'Service')",
  ]);
});

test("SOQL: a value that is not a valid literal for the field is a 400, not a SOQL error", () => {
  const filters = parseCallerFilters(m({ "f[call_attempts]": "three" }), COLS).filters;
  assert.equal(callerFiltersToSoql(filters, (c) => FIELDS[c], esc).body.code, "INVALID_FILTER_VALUE");
});

test("D-081: the Customer header sorts by display_name_sort (company name for a company), once the column exists", () => {
  const withCol = new Set([...COLS, "display_name_sort"]);
  assert.deepEqual(parseSort({ sort: "display_name_sort:asc" }, "customer", withCol).sort, { column: "display_name_sort", ascending: true });
  // Before the SQL file runs the column is not in the cache → a 400, never a broken query.
  assert.equal(parseSort({ sort: "display_name_sort" }, "customer", COLS).ok, false);
});
