// lib/report-catalog-build.js — the report field catalog (D-088, R1a; docs/reporting-module.md
// §6.1). PURE: no Salesforce, no Supabase, no file system. scripts/generate-report-catalog.mjs
// gathers the live inputs and calls buildCatalogObject() once per cache table, then
// renderCatalogSql() / renderCatalogIndex() once; lib/report-catalog-build.test.js runs the
// same functions on fixtures.
//
// WHAT A CATALOG ENTRY IS. One cache column a report could touch, described for three readers:
//   - the engine (lib/report-def.js) allowlists against it: a column not here does not exist;
//   - sundial_report_run (Postgres) re-checks every identifier against the SQL seed rendered
//     from the same entries (public.sundial_report_catalog);
//   - the picker and, in R4, the AI read label / section / description / picklistValues.
//
// WHERE THE COLUMNS COME FROM. Only lib/report-columns.js planTable(): the columns it calls
// `existing` (a Salesforce field that maps onto a live cache column of the expected type),
// plus the ones it skipped as `type_mismatch` (the column exists and is filled, only its
// Postgres type differs from the map — the live type is what Postgres compares against).
// Plus two control columns, named by CONTROL_COLUMNS rather than typed here: `sf_id` (the
// join key, never selectable) and `created_date` (the sync's created date, selectable).
// A column with no Salesforce field behind it is NOT in the catalog — no hand-typed names.
//
// WHAT IS NEVER REPORTABLE (in the catalog with reportable:false, so the database can still
// resolve it as a join key but no report can select, filter, group or sort on it):
//   - sf_id;
//   - a sensitive field (lib/report-columns.js sensitiveReason — credentials);
//   - Salesforce's own bookkeeping that means nothing in a report (IsDeleted,
//     LastViewedDate, LastReferencedDate).
// client_sf_id / tenant_id / is_stale / cache_version / last_synced_at are not in the
// catalog at all: the tenant clause is the function's own, the rest are the sync's.
//
// GATES. A column a cost gate protects (lib/cost-gate.js — COST_FIELDS' cache columns and
// every markup key) carries gate "service.costing.read". The engine strips it for a caller
// without that action; the function RAISES if one reaches it anyway.

import { CONTROL_COLUMNS, sensitiveReason } from "./report-columns.js";
import { COST_FIELDS, COSTING_READ, isMarkupKey } from "./cost-gate.js";

/** Salesforce describe type → the catalog's type (§6.1). */
export const CATALOG_TYPE = Object.freeze({
  string: "text",
  textarea: "text",
  phone: "text",
  email: "text",
  url: "text",
  id: "text",
  encryptedstring: "text",
  picklist: "picklist",
  multipicklist: "multipicklist",
  reference: "reference",
  boolean: "boolean",
  int: "number",
  double: "number",
  currency: "number",
  percent: "number",
  date: "date",
  datetime: "datetime",
});

/** Salesforce bookkeeping fields: cached, but never a report's business. */
export const BOOKKEEPING_FIELDS = Object.freeze(["IsDeleted", "LastViewedDate", "LastReferencedDate"]);
const BOOKKEEPING = new Set(BOOKKEEPING_FIELDS.map((n) => n.toLowerCase()));

// Taken from CONTROL_COLUMNS (and checked there by the test), never typed as a second copy.
const SF_ID_COLUMN = CONTROL_COLUMNS.find((c) => c === "sf_id");
const CREATED_DATE_COLUMN = CONTROL_COLUMNS.find((c) => c === "created_date");

/** The gate on one cache column of one object, or null. */
export function gateFor(objectKey, column) {
  const cost = COST_FIELDS[objectKey];
  if (cost && cost.cache.includes(column)) return COSTING_READ;
  if (isMarkupKey(column)) return COSTING_READ;
  return null;
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * One object's catalog.
 *
 * @param {object} input
 * @param {{key:string, sfObject:string, cacheTable:string}} input.spec
 * @param {object} input.plan  planTable()'s result for this table.
 * @param {Array<object>} input.describeFields  the raw describe fields.
 * @param {Array<{apiName,label,section,description}>|null} input.workbookRows
 * @param {Map<string,string>} input.liveColumns  column → Postgres type (OpenAPI format).
 * @returns {{objectKey, sfObject, table, fields: Array<object>}}
 */
export function buildCatalogObject({ spec, plan, describeFields, workbookRows, liveColumns }) {
  const byName = new Map(describeFields.map((f) => [f.name.toLowerCase(), f]));
  const wbByName = new Map((workbookRows || []).map((r) => [r.apiName.toLowerCase(), r]));
  const fields = [];
  const seen = new Set();

  const entries = [
    ...plan.existing.map((e) => ({ column: e.column, field: e.field })),
    ...plan.skipped.filter((s) => s.reason === "type_mismatch").map((s) => ({ column: s.column, field: s.field })),
  ];
  for (const { column, field } of entries) {
    if (seen.has(column) || !liveColumns.has(column)) continue;
    if (CONTROL_COLUMNS.includes(column)) continue; // client_sf_id — the function's own clause
    const f = byName.get(field.toLowerCase());
    const type = f ? CATALOG_TYPE[f.type] : undefined;
    if (!f || !type) continue;
    seen.add(column);
    const wb = wbByName.get(field.toLowerCase());
    const reportable = !sensitiveReason(spec.sfObject, f) && !BOOKKEEPING.has(f.name.toLowerCase());
    const entry = {
      column,
      sfField: f.name,
      label: oneLine(wb?.label || f.label || f.name),
      section: oneLine(wb?.section),
      type,
      pgType: liveColumns.get(column) ?? "text",
      description: oneLine(wb?.description || f.inlineHelpText),
      gate: gateFor(spec.key, column),
      reportable,
      longText: f.type === "textarea" && Number(f.length) > 255,
    };
    if (type === "picklist" || type === "multipicklist") {
      entry.picklistValues = (f.picklistValues || []).filter((p) => p.active !== false).map((p) => p.value);
    }
    fields.push(entry);
  }

  // The two control columns that are the catalog's business, when the table has them.
  if (liveColumns.has(CREATED_DATE_COLUMN) && !seen.has(CREATED_DATE_COLUMN)) {
    fields.push({
      column: CREATED_DATE_COLUMN, sfField: null, label: "Created Date", section: "", type: "datetime",
      pgType: liveColumns.get(CREATED_DATE_COLUMN) ?? "timestamp with time zone",
      description: "When the record was created (the original system's created date where one was migrated).",
      gate: null, reportable: true, longText: false,
    });
  }
  if (liveColumns.has(SF_ID_COLUMN)) {
    fields.push({
      column: SF_ID_COLUMN, sfField: "Id", label: "Record ID", section: "", type: "text",
      pgType: liveColumns.get(SF_ID_COLUMN) ?? "text", description: "The Salesforce record id (join key).",
      gate: null, reportable: false, longText: false,
    });
  }
  return { objectKey: spec.key, sfObject: spec.sfObject, table: spec.cacheTable, fields };
}

// --- Rendering (deterministic: no timestamps, input order only) ----------------

/** Postgres string literal. */
const lit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);

export const CATALOG_SQL_FILE = "sql/2026-11-03_report_catalog.sql";

export function renderCatalogSql(catalogs, { file = CATALOG_SQL_FILE } = {}) {
  const out = [];
  out.push(`-- ${file} — the report field catalog the engine re-checks against (D-088, R1a).`);
  out.push("--");
  out.push("-- GENERATED by scripts/generate-report-catalog.mjs — do not edit by hand; re-run the");
  out.push("-- script after any new cache column, then run this file again. The same entries are");
  out.push("-- lib/report-catalog/<object>.json, which the sundial-reports Lambda carries.");
  out.push("--");
  out.push("-- public.sundial_report_run (sql/sundial_report_run.sql) refuses any table, column,");
  out.push("-- join key or gated column that is not a row here. Service role only, like the caches.");
  out.push("--");
  out.push("-- Idempotent: the whole catalog is replaced inside one transaction.");
  out.push("");
  out.push("begin;");
  out.push("");
  out.push("create table if not exists public.sundial_report_catalog (");
  out.push("  object_key  text    not null,");
  out.push("  table_name  text    not null,");
  out.push("  column_name text    not null,");
  out.push("  data_type   text    not null,  -- the live Postgres type (information_schema spelling)");
  out.push("  gate        text,              -- the action a caller needs to see it, or null");
  out.push("  reportable  boolean not null,  -- false = a join key only (sf_id, credentials, bookkeeping)");
  out.push("  primary key (table_name, column_name)");
  out.push(");");
  out.push("alter table public.sundial_report_catalog enable row level security;");
  out.push("revoke all on public.sundial_report_catalog from public, anon, authenticated;");
  out.push("grant select on public.sundial_report_catalog to service_role;");
  out.push("");
  out.push("delete from public.sundial_report_catalog;");
  let total = 0;
  for (const c of catalogs) {
    if (!c.fields.length) continue;
    out.push("");
    out.push(`-- ${c.table} (${c.sfObject}) — ${c.fields.length} column(s)`);
    out.push("insert into public.sundial_report_catalog (object_key, table_name, column_name, data_type, gate, reportable) values");
    c.fields.forEach((f, i) => {
      out.push(`  (${lit(c.objectKey)}, ${lit(c.table)}, ${lit(f.column)}, ${lit(f.pgType)}, ${lit(f.gate)}, ${f.reportable})${i === c.fields.length - 1 ? ";" : ","}`);
    });
    total += c.fields.length;
  }
  out.push("");
  out.push("commit;");
  out.push("");
  out.push(`-- ${total} column(s) in all. Check (must be ${total}):`);
  out.push("select count(*) as catalog_rows from public.sundial_report_catalog;");
  return out.join("\n") + "\n";
}

/** The JSON file for one object (stable key order, two-space indent). */
export function renderCatalogJson(catalog) {
  return JSON.stringify(catalog, null, 2) + "\n";
}

/** lib/report-catalog/index.js — imports every object's JSON, so no list of objects is typed. */
export function renderCatalogIndex(catalogs) {
  const out = [];
  out.push("// lib/report-catalog/index.js — GENERATED by scripts/generate-report-catalog.mjs; do not edit.");
  out.push("// Every reportable object's catalog (D-088), keyed by object key. esbuild bundles the JSON.");
  out.push("");
  for (const c of catalogs) out.push(`import ${c.objectKey} from "./${c.objectKey}.json" with { type: "json" };`);
  out.push("");
  out.push(`export const CATALOG = Object.freeze({ ${catalogs.map((c) => c.objectKey).join(", ")} });`);
  return out.join("\n") + "\n";
}
