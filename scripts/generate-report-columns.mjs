// scripts/generate-report-columns.mjs — the reporting-grade cache (D-087, R0;
// docs/reporting-module.md §4.1–4.4). READ-ONLY against Salesforce and Supabase.
//
//   node scripts/generate-report-columns.mjs                                  # the coverage report; SQL only if nothing is missing
//   node scripts/generate-report-columns.mjs --sql sql/<date>_report_columns_followon.sql   # + the missing columns' SQL
//   node scripts/generate-report-columns.mjs --check                          # write nothing; exit 1 if the report would change
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
// It writes docs/reporting-cache-coverage.md and, when columns are missing, the SQL file named
// with --sql (one idempotent `add column if not exists` per column, grouped by table). It never
// rewrites a file in APPLIED_SQL_FILES (lib/report-columns.js) — those have run; the first
// was sql/2026-10-30_report_columns.sql (run 2026-11-02). The decisions — the
// type map, the refusals — are lib/report-columns.js, unit-tested there. This file only
// gathers inputs and writes files. It never runs the SQL.
//
// Re-runnable: both outputs are deterministic, so an unchanged state is an empty diff.
// After Tim runs a SQL file, a re-run moves its columns to "Already cached" — the expected
// diff, not drift. Missing columns with no --sql: the script names the count and exits 1.

import fs from "node:fs";
import path from "node:path";
import { getRawDescribe, getQueryableFields } from "../lib/sf-describe.js";
import { sfFieldToColumn, buildCacheSelect } from "../lib/cache-row.js";
import { parentModstampPaths, incrementalWhere } from "../lib/formula-parents.js";
import { planTable, renderSql, renderCoverage, APPLIED_SQL_FILES } from "../lib/report-columns.js";
// OBJECTS, the workbook reader and the live-column reader are shared with
// scripts/generate-report-catalog.mjs (D-088) — one copy, in scripts/lib/report-sources.mjs.
import { ROOT, DOCS, OBJECTS, readSheet, loadCacheSpec, sourceOf } from "./lib/report-sources.mjs";

const SQL_ARG = process.argv.includes("--sql") ? process.argv[process.argv.indexOf("--sql") + 1] : null;
const SQL_REL = SQL_ARG ? path.relative(ROOT, path.resolve(ROOT, SQL_ARG)).split(path.sep).join("/") : null;
if (process.argv.includes("--sql") && (!SQL_REL || !SQL_REL.startsWith("sql/") || APPLIED_SQL_FILES.includes(SQL_REL))) {
  console.error(`--sql must name a NEW file under sql/ (never ${APPLIED_SQL_FILES.join(", ")}).`);
  process.exit(2);
}
const SQL_OUT = SQL_REL ? path.join(ROOT, SQL_REL) : null;
const DOC_OUT = path.join(DOCS, "reporting-cache-coverage.md");
const CHECK = process.argv.includes("--check");

// --- Run ------------------------------------------------------------------------
const columnsOf = await loadCacheSpec();
const plans = [];
for (const spec of OBJECTS) {
  const meta = await getRawDescribe(spec.sfObject);
  const { fields: queryable } = await getQueryableFields(spec.sfObject);
  const queryableNames = new Set(queryable.map((f) => f.name.toLowerCase()));
  const existingColumns = columnsOf(spec.cacheTable);
  const workbookRows = spec.workbook ? await readSheet(spec) : null;
  const source = sourceOf(spec);

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

const missing = plans.reduce((n, p) => n + (p.tableMissing ? 0 : p.add.length), 0);
const sql = SQL_OUT ? renderSql(plans, { file: SQL_REL }) : null;
const doc = renderCoverage(plans, { sqlFiles: SQL_REL && missing ? [...APPLIED_SQL_FILES, SQL_REL] : APPLIED_SQL_FILES });
const same = (file, text) => fs.existsSync(file) && fs.readFileSync(file, "utf8") === text;
const outputs = [[DOC_OUT, doc], ...(SQL_OUT && missing ? [[SQL_OUT, sql]] : [])];
if (CHECK) {
  const changed = outputs.filter(([f, t]) => !same(f, t)).map(([f]) => path.relative(ROOT, f));
  if (changed.length) {
    console.log(`\nWould change: ${changed.join(", ")}`);
    process.exit(1);
  }
  console.log("\nNo change.");
  process.exit(0);
}
if (missing && !SQL_OUT) {
  console.error(`\n${missing} column(s) missing. Re-run with --sql sql/<today>_report_columns_followon.sql — nothing written.`);
  process.exit(1);
}
console.log("");
for (const [file, text] of outputs) {
  fs.writeFileSync(file, text, "utf8");
  console.log(`wrote ${path.relative(ROOT, file)}`);
}
if (!missing) console.log("No column is missing — no SQL file written.");
console.log("Nothing was run against the database. The steps are in TASKS.md (Reporting R0).");
