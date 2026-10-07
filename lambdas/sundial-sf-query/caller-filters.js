// caller-filters.js — the list endpoint's multi-filter, exclusion and sort parameters
// (D-080, 2026-10-05), and the pipeline route's narrowing. Pure functions; the list
// read (index.js) applies them.
//
//   f[<cacheColumn>]=<value>      repeatable. Different columns AND; the SAME column
//                                 repeated means ANY OF its values. An EMPTY value means
//                                 blank (NULL or ''): f[stage]=&f[stage]=Odd is the
//                                 board's "Other" column in one request.
//   not[<cacheColumn>]=<value>    exact-value exclusion, the ONLY negative form. Keeps
//                                 blanks: not[customer_type]=Service keeps the NULL rows.
//   sort=<column>:<asc|desc>      from SORT_ALLOWLIST; NULLS LAST, sf_id as tie-breaker.
//
// ⚠️ REPEATED KEYS ARRIVE ONLY IN multiValueQueryStringParameters. API Gateway's REST
// proxy event keeps just the LAST value of a repeated key in queryStringParameters, so
// reading `qs` alone would turn f[stage]=A&f[stage]=B into "B" — a silently narrower
// list, not an error. readMulti() reads the multi-value map and falls back to `qs` only
// when the event has none (tests, a direct invoke).
//
// ⚠️ not[] IS NULL-SAFE ON PURPOSE. PostgREST `neq` (like SQL `<>`) drops NULL rows:
// measured 2026-10-05 on Harmon's customers, customer_type neq Service returned 21 rows
// where the answer is 29,770. The cache form is or(col.is.null,col.neq."v").
//
// The tenant and access columns (client_sf_id, tenant_id, the rep / dealer columns
// lib/access.js filters on, access_level, supabase_user_id) are IGNORED from the caller
// — never honoured, never an error — so no request can name its way around the row
// filter. Every other column must exist in the cache table, or the request is 400
// INVALID_FILTER_FIELD naming it.

import { OBJECT_ACCESS } from "../../lib/access.js";

const MAX_FILTER_COLUMNS = 20;
const MAX_VALUES_PER_COLUMN = 100;
const MAX_VALUE_LENGTH = 255;
const COLUMN_RE = /^[a-z][a-z0-9_]*$/;

/** Columns a caller may never filter on: the isolation key and every access column. */
export const IGNORED_FILTER_COLUMNS = (() => {
  const s = new Set(["client_sf_id", "tenant_id", "access_level", "supabase_user_id"]);
  for (const def of Object.values(OBJECT_ACCESS)) {
    if (def?.repColumn) s.add(def.repColumn);
    if (def?.dealerColumn) s.add(def.dealerColumn);
  }
  return s;
})();

/**
 * Sortable columns per object. Absent object = default order only. A sort runs after the
 * WHERE (status, stage, …), over at most one status's rows (~18k for Harmon's Leads), so an
 * unindexed column costs milliseconds.
 *
 * customer: every column the Sales table can sort by. street / primary_phone /
 * requested_project_types added 2026-10-05 so the Address, Phone and Requested Types
 * headers keep sorting once the table pages server-side. Requested_Project_Types__c is a
 * multi-select picklist, which SOQL cannot ORDER BY — the live cold-cache path falls back
 * to the default order for it (SOQL_UNSORTABLE_TYPES in index.js); the cache path sorts it
 * as text.
 */
export const SORT_ALLOWLIST = {
  customer: [
    "created_date", "name", "last_name", "status", "stage", "sales_rep_name", "lead_source", "call_attempts",
    "street", "primary_phone", "requested_project_types",
    // D-081 (2026-10-07): the Customer header — a company sorts by its company name, a person
    // by "first last", else the record name. display_name_sort is a GENERATED column
    // (sql/2026-10-07_company_customers.sql) because PostgREST cannot order by an
    // expression. It is not a Salesforce field, so the cold-cache SOQL path falls back to
    // the default order for it (columnToField finds nothing), like an unsortable type.
    "display_name_sort",
  ],
};

/** The pipeline route's narrowing columns (sundial_customer_pipeline's p_narrow). */
export const PIPELINE_NARROW_COLUMNS = ["stage", "sales_rep_name", "lead_source"];

/**
 * Every query key → its list of values. multiValueQueryStringParameters FIRST (see the
 * header: queryStringParameters keeps only the last of a repeated key).
 */
export function readMulti(event, qs) {
  const multi = event?.multiValueQueryStringParameters;
  const out = new Map();
  if (multi && typeof multi === "object") {
    for (const [k, v] of Object.entries(multi)) out.set(k, Array.isArray(v) ? v.map(String) : [String(v)]);
    return out;
  }
  for (const [k, v] of Object.entries(qs || {})) if (v != null) out.set(k, [String(v)]);
  return out;
}

const fail = (status, code, extra = {}) => ({ ok: false, status, body: { error: code.toLowerCase(), code, ...extra } });

/**
 * Parse f[] / not[] into { any: [{column, values, blank}], not: [{column, value}], ignored: [...] }.
 * Returns { ok: true, filters } or { ok: false, status, body }.
 * `allowColumns` (optional) restricts the columns further (the pipeline's narrowing).
 */
export function parseCallerFilters(multi, columnSet, { allowColumns = null, allowNot = true } = {}) {
  const any = new Map();
  const not = [];
  const ignored = [];
  for (const [key, values] of multi) {
    const m = key.match(/^(f|not)\[([^\]]*)\]$/);
    if (!m) continue;
    const [, kind, column] = m;
    if (!COLUMN_RE.test(column)) return fail(400, "INVALID_FILTER_FIELD", { field: column });
    if (IGNORED_FILTER_COLUMNS.has(column)) {
      ignored.push(column);
      continue;
    }
    if (allowColumns ? !allowColumns.includes(column) : !columnSet?.has(column)) {
      return fail(400, "INVALID_FILTER_FIELD", { field: column });
    }
    if (values.length > MAX_VALUES_PER_COLUMN) return fail(400, "TOO_MANY_FILTER_VALUES", { field: column });
    for (const v of values) {
      if (v.length > MAX_VALUE_LENGTH) return fail(400, "INVALID_FILTER_VALUE", { field: column });
    }
    if (kind === "not") {
      if (!allowNot) return fail(400, "INVALID_FILTER_FIELD", { field: `not[${column}]` });
      for (const v of values) {
        // not[] is EXACT only: no blank form, no list form beyond repeating the key.
        if (v === "") return fail(400, "INVALID_FILTER_VALUE", { field: `not[${column}]`, reason: "not[] needs a value" });
        not.push({ column, value: v });
      }
      continue;
    }
    const entry = any.get(column) || { column, values: [], blank: false };
    for (const v of values) {
      if (v === "") entry.blank = true;
      else if (!entry.values.includes(v)) entry.values.push(v);
    }
    any.set(column, entry);
  }
  if (any.size + new Set(not.map((n) => n.column)).size > MAX_FILTER_COLUMNS) return fail(400, "TOO_MANY_FILTERS");
  const filters = { any: [...any.values()], not, ignored };
  filters.active = filters.any.length > 0 || filters.not.length > 0;
  return { ok: true, filters };
}

/** ?sort=col:dir → { column, ascending } | null (absent); { error } when not allowed. */
export function parseSort(qs, objectKey, columnSet) {
  const raw = qs?.sort;
  if (raw == null || String(raw).trim() === "") return { ok: true, sort: null };
  const m = String(raw).trim().match(/^([a-z][a-z0-9_]*)(?::(asc|desc))?$/i);
  const allowed = SORT_ALLOWLIST[objectKey] ?? ["created_date"];
  if (!m || !allowed.includes(m[1].toLowerCase()) || !columnSet?.has(m[1].toLowerCase())) {
    return fail(400, "INVALID_SORT", { sort: String(raw).slice(0, 80), allowed });
  }
  return { ok: true, sort: { column: m[1].toLowerCase(), ascending: (m[2] || "asc").toLowerCase() === "asc" } };
}

// A PostgREST double-quoted value: backslash and double quote escaped. Verified against
// the live cache 2026-10-05 with `Clean Energy Experts "B"`, `R.E. Leads`, commas,
// parentheses and a backslash.
const BS = "\\";
export function pgrstQuote(v) {
  return '"' + String(v).split(BS).join(BS + BS).split('"').join(BS + '"') + '"';
}

/**
 * Apply caller filters to a supabase-js builder. Each any-of with a blank and each not[]
 * is its own .or() group; separate .or() groups are ANDed by PostgREST (checked against
 * the live cache 2026-10-05: two groups returned 7,667, the SQL truth).
 */
export function applyCallerFiltersToQuery(q, filters) {
  if (!filters?.active) return q;
  for (const { column, values, blank } of filters.any) {
    if (!blank && values.length === 1) q = q.eq(column, values[0]);
    else if (!blank) q = q.or(`${column}.in.(${values.map(pgrstQuote).join(",")})`);
    else {
      const parts = [`${column}.is.null`, `${column}.eq.""`];
      if (values.length) parts.push(`${column}.in.(${values.map(pgrstQuote).join(",")})`);
      q = q.or(parts.join(","));
    }
  }
  for (const { column, value } of filters.not) {
    // NULL-SAFE (header): never q.neq(column, value).
    q = q.or(`${column}.is.null,${column}.neq.${pgrstQuote(value)}`);
  }
  return q;
}

// --- Live (SOQL) form, for the cold-cache path --------------------------------------
const STRINGY = new Set(["string", "picklist", "multipicklist", "textarea", "email", "phone", "url", "id", "reference", "combobox"]);
const NUMERIC = new Set(["int", "double", "currency", "percent", "long"]);

function soqlLiteral(field, value, soqlEscapeString) {
  if (STRINGY.has(field.type)) return `'${soqlEscapeString(value)}'`;
  if (NUMERIC.has(field.type) && /^-?\d+(\.\d+)?$/.test(value)) return value;
  if (field.type === "boolean" && /^(true|false)$/i.test(value)) return value.toLowerCase();
  if (field.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (field.type === "datetime" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return value;
  return null;
}

/**
 * The same filters as SOQL clauses (ANDed by the caller). `columnToField` maps a cache
 * column to its describe field {name, type}. Returns { ok, clauses } or a 400.
 * OR-of-equals rather than IN, so multi-select picklists work too.
 */
export function callerFiltersToSoql(filters, columnToField, soqlEscapeString) {
  const clauses = [];
  if (!filters?.active) return { ok: true, clauses };
  for (const { column, values, blank } of filters.any) {
    const f = columnToField(column);
    if (!f) return fail(400, "INVALID_FILTER_FIELD", { field: column });
    const parts = [];
    for (const v of values) {
      const lit = soqlLiteral(f, v, soqlEscapeString);
      if (lit == null) return fail(400, "INVALID_FILTER_VALUE", { field: column });
      parts.push(`${f.name} = ${lit}`);
    }
    if (blank) parts.push(`${f.name} = null`);
    clauses.push(parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`);
  }
  for (const { column, value } of filters.not) {
    const f = columnToField(column);
    if (!f) return fail(400, "INVALID_FILTER_FIELD", { field: column });
    const lit = soqlLiteral(f, value, soqlEscapeString);
    if (lit == null) return fail(400, "INVALID_FILTER_VALUE", { field: `not[${column}]` });
    clauses.push(`(${f.name} = null OR ${f.name} != ${lit})`);
  }
  return { ok: true, clauses };
}

/** f[] for the pipeline → sundial_customer_pipeline's p_narrow, or null when none. */
export function filtersToNarrow(filters) {
  if (!filters?.any?.length) return null;
  const out = {};
  for (const { column, values, blank } of filters.any) out[column] = { values, blank };
  return out;
}
