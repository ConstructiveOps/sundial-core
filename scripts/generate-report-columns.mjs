// scripts/generate-report-columns.mjs — the reporting-grade cache (D-087, R0;
// docs/reporting-module.md §4.1–4.4). READ-ONLY against Salesforce and Supabase.
//
//   node scripts/generate-report-columns.mjs             # write the SQL + the coverage report
//   node scripts/generate-report-columns.mjs --check     # write nothing; exit 1 if either would change
//
// Per cache table it reads three things:
//   1. the field list — the object's field-design workbook (the sheet and "API Name"
//      column in OBJECTS below, read the way generate-field-configs.mjs reads them), or,
//      for po / user / membership / serviceplan, every field the integration user can read;
//   2. a live describe, through lib/sf-describe.js (getQueryableFields — the integration
//      user's view, so a field without Read FLS is simply absent);
//   3. the live cache columns, from PostgREST's OpenAPI document (the method
//      sundial-cache-sync's getCacheColumns uses), with each column's type.
//
// It writes sql/2026-10-30_report_columns.sql (one idempotent `add column if not exists`
// per column, grouped by table) and docs/reporting-cache-coverage.md. The decisions — the
// type map, the refusals — are lib/report-columns.js, unit-tested there. This file only
// gathers inputs and writes files. It never runs the SQL.
//
// Re-runnable: both outputs are deterministic, so an unchanged state is an empty diff.
// After Tim runs the SQL, a re-run moves every added column to "Already cached" and the
// SQL file shrinks to its header — that is the expected diff, not drift.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { getRawDescribe, getQueryableFields } from "../lib/sf-describe.js";
import { getSupabaseConfig } from "../lib/supabase.js";
import { sfFieldToColumn, buildCacheSelect } from "../lib/cache-row.js";
import { parentModstampPaths, incrementalWhere } from "../lib/formula-parents.js";
import { planTable, renderSql, renderCoverage } from "../lib/report-columns.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const SQL_OUT = path.join(ROOT, "sql", "2026-10-30_report_columns.sql");
const DOC_OUT = path.join(DOCS, "reporting-cache-coverage.md");
const CHECK = process.argv.includes("--check");

// §4.1. The order is the resync order (§4.5), so the SQL reads in the order Tim works.
// No `workbook` = every readable describe field.
const OBJECTS = [
  { key: "customer", sfObject: "Sundial_Customer__c", cacheTable: "sundial_customer_cache", workbook: "Sundial_Customer__c_Field_Design.xlsx", sheet: "Fields by Section", sectionCol: "Sundial Section", labelCol: "Label" },
  { key: "solar", sfObject: "Sundial_Solar__c", cacheTable: "sundial_solar_cache", workbook: "Sundial_Solar_Fields_by_Section.xlsx", sheet: "Fields by Section" },
  { key: "roofing", sfObject: "Sundial_Roofing__c", cacheTable: "sundial_roofing_cache", workbook: "Sundial_Roofing_Fields_by_Section.xlsx", sheet: "Field List (Module)" },
  { key: "job", sfObject: "Sundial_Service_Job__c", cacheTable: "sundial_service_job_cache", workbook: "Sundial_Service_Job_Fields_by_Section.xlsx", sheet: "Service Job Fields" },
  { key: "estimate", sfObject: "Sundial_Estimate__c", cacheTable: "sundial_estimate_cache", workbook: "Sundial_Estimate_Fields_by_Section.xlsx", sheet: "Estimate Fields" },
  { key: "servicecall", sfObject: "Sundial_Service_Call__c", cacheTable: "sundial_service_call_cache", workbook: "Sundial_Service_Call_Fields_by_Section.xlsx", sheet: "Service Call Fields" },
  { key: "serviceinvoice", sfObject: "Sundial_Service_Invoice__c", cacheTable: "sundial_service_invoice_cache", workbook: "Sundial_Service_Job_Fields_by_Section.xlsx", sheet: "Service Invoice Fields" },
  { key: "servicepayment", sfObject: "Sundial_Service_Payment__c", cacheTable: "sundial_service_payment_cache", workbook: "Sundial_Service_Job_Fields_by_Section.xlsx", sheet: "Service Payment Fields" },
  { key: "serviceline", sfObject: "Sundial_Service_Line__c", cacheTable: "sundial_service_line_cache", workbook: "Sundial_Estimate_Fields_by_Section.xlsx", sheet: "Service Line Fields" },
  { key: "pricebookitem", sfObject: "Sundial_Price_Book_Item__c", cacheTable: "sundial_price_book_item_cache", workbook: "Sundial_Estimate_Fields_by_Section.xlsx", sheet: "Price Book Item Fields" },
  { key: "po", sfObject: "Sundial_PO__c", cacheTable: "sundial_po_cache" },
  { key: "user", sfObject: "Sundial_User__c", cacheTable: "sundial_user_cache" },
  { key: "membership", sfObject: "Sundial_Membership__c", cacheTable: "sundial_membership_cache" },
  { key: "serviceplan", sfObject: "Sundial_Service_Plan__c", cacheTable: "sundial_service_plan_cache" },
];

// --- Workbook (the cell reading of generate-field-configs.mjs readSheet) ------
async function readSheet(spec) {
  const file = path.join(DOCS, spec.workbook);
  if (!fs.existsSync(file)) throw new Error(`workbook missing: ${file}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(spec.sheet);
  if (!ws) throw new Error(`${spec.workbook}: no sheet named "${spec.sheet}"`);
  const col = {};
  ws.getRow(1).eachCell({ includeEmpty: false }, (c, n) => {
    col[String(c.value ?? "").trim()] = n;
  });
  if (!col["API Name"]) throw new Error(`${spec.workbook} [${spec.sheet}]: no "API Name" column`);
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cell = (name) => {
      if (!col[name]) return "";
      const v = row.getCell(col[name]).value;
      // A formula cell reads as { formula, result }; take the displayed result.
      if (v && typeof v === "object" && "result" in v) return String(v.result ?? "").trim();
      if (v && typeof v === "object" && "richText" in v) return v.richText.map((t) => t.text).join("").trim();
      return String(v ?? "").trim();
    };
    const apiName = cell("API Name");
    // A section banner or a note in the API Name column is not a field.
    if (!apiName || !/^[A-Za-z][A-Za-z0-9_]*$/.test(apiName)) continue;
    rows.push({ rowNumber: r, apiName, label: cell(spec.labelCol ?? "Field Label"), section: cell(spec.sectionCol ?? "Section") });
  }
  return rows;
}

// --- Live cache columns, with their types -------------------------------------
async function loadCacheSpec() {
  const cfg = await getSupabaseConfig();
  const resp = await fetch(`${cfg.url}/rest/v1/`, {
    headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` },
  });
  if (!resp.ok) throw new Error(`OpenAPI fetch failed (${resp.status})`);
  const spec = await resp.json();
  return (table) => {
    const def = spec?.definitions?.[table] || spec?.components?.schemas?.[table];
    return new Map(Object.entries(def?.properties ?? {}).map(([c, p]) => [c, p?.format ?? null]));
  };
}

// --- Run ------------------------------------------------------------------------
const columnsOf = await loadCacheSpec();
const plans = [];
for (const spec of OBJECTS) {
  const meta = await getRawDescribe(spec.sfObject);
  const { fields: queryable } = await getQueryableFields(spec.sfObject);
  const queryableNames = new Set(queryable.map((f) => f.name.toLowerCase()));
  const existingColumns = columnsOf(spec.cacheTable);
  const workbookRows = spec.workbook ? await readSheet(spec) : null;
  const source = spec.workbook ? `\`docs/${spec.workbook}\` (*${spec.sheet}*)` : "every field the integration user can read (no workbook)";

  // A NEW formula column must be one the incremental sync can keep fresh (D-079). Ask
  // lib/formula-parents.js the same question the sync asks, about the table as it will
  // be: what exists now plus every readable workbook field.
  const wanted = new Set(existingColumns.keys());
  for (const f of meta.fields || []) wanted.add(sfFieldToColumn(f));
  const parents = await parentModstampPaths({
    sfObject: spec.sfObject,
    fields: meta.fields || [],
    isCached: (f) => queryableNames.has(f.name.toLowerCase()) && wanted.has(sfFieldToColumn(f)),
    describe: getRawDescribe,
  });
  const unfresh = new Map(parents.uncoverable.map((u) => [u.field, u.reason]));

  const plan = planTable({
    objectKey: spec.key, sfObject: spec.sfObject, cacheTable: spec.cacheTable, source,
    workbookRows, describeFields: meta.fields || [], queryableNames, existingColumns,
    freshnessProblem: (f) => unfresh.get(f.name) ?? null,
  });
  // How long the sync's incremental SOQL becomes once the columns exist. sfQuery sends it
  // as a GET, and Salesforce refuses a URI over 16,384 bytes — solar, the widest table, is
  // the one to watch. Built the way the sync builds it (approximate by the created-date
  // source fields, a few dozen characters).
  const after = new Set([...existingColumns.keys(), ...plan.add.map((a) => a.column)]);
  const { selectFields } = buildCacheSelect(queryable, after, ["CreatedDate"]);
  const names = selectFields.map((f) => f.name);
  for (const extra of ["SystemModstamp", "Client__r.Name", ...parents.paths.map((pp) => `${pp}.SystemModstamp`)]) {
    if (!names.some((n) => n.toLowerCase() === extra.toLowerCase())) names.push(extra);
  }
  const soql =
    `SELECT ${names.join(", ")} FROM ${spec.sfObject} ` +
    `WHERE ${incrementalWhere("2026-10-30T00:00:00.000Z", parents.paths)} ORDER BY SystemModstamp ASC`;
  plan.syncUriLength = `/services/data/v60.0/query?q=${encodeURIComponent(soql)}`.length;

  plans.push(plan);
  console.log(
    `${spec.key.padEnd(15)} cached ${String(plan.existing.length).padStart(3)}  add ${String(plan.add.length).padStart(3)}  ` +
      `skipped ${String(plan.skipped.length).padStart(3)}  FLS ${String(plan.fls.length).padStart(3)}  ` +
      `sync URI ${String(plan.syncUriLength).padStart(6)}${plan.tableMissing ? "  (NO CACHE TABLE)" : ""}`
  );
}

const sql = renderSql(plans);
const doc = renderCoverage(plans);
const same = (file, text) => fs.existsSync(file) && fs.readFileSync(file, "utf8") === text;
if (CHECK) {
  const changed = [[SQL_OUT, sql], [DOC_OUT, doc]].filter(([f, t]) => !same(f, t)).map(([f]) => path.relative(ROOT, f));
  if (changed.length) {
    console.log(`\nWould change: ${changed.join(", ")}`);
    process.exit(1);
  }
  console.log("\nNo change.");
  process.exit(0);
}
fs.writeFileSync(SQL_OUT, sql, "utf8");
fs.writeFileSync(DOC_OUT, doc, "utf8");
console.log(`\nwrote ${path.relative(ROOT, SQL_OUT)}\nwrote ${path.relative(ROOT, DOC_OUT)}`);
console.log("Nothing was run against the database. The steps are in TASKS.md (Reporting R0).");
