// scripts/generate-report-catalog.mjs — the report field catalog (D-088, R1a;
// docs/reporting-module.md §6.1). READ-ONLY against Salesforce and Supabase.
//
//   node scripts/generate-report-catalog.mjs           # write lib/report-catalog/*.json + index.js + the SQL seed
//   node scripts/generate-report-catalog.mjs --check   # write nothing; exit 1 if any output would change
//
// Per reportable object (scripts/lib/report-sources.mjs OBJECTS — the same list R0's
// generate-report-columns.mjs reads) it gathers the live describe, the live cache columns and
// the workbook, asks lib/report-columns.js planTable() which columns exist, and hands the
// answer to lib/report-catalog-build.js. Nothing here decides anything; nothing here types a
// column name.
//
// Outputs (deterministic — an unchanged state is an empty diff):
//   lib/report-catalog/<objectKey>.json   the catalog the sundial-reports Lambda carries
//   lib/report-catalog/index.js           imports them all
//   sql/2026-11-03_report_catalog.sql     public.sundial_report_catalog + its rows
//
// WHEN TO RE-RUN: after any cache column is added (an R0 follow-on SQL file), then run the
// SQL file again and redeploy sundial-reports, so the Lambda and the database agree. Until
// then a new column simply is not reportable.

import fs from "node:fs";
import path from "node:path";
import { getRawDescribe, getQueryableFields } from "../lib/sf-describe.js";
import { planTable } from "../lib/report-columns.js";
import {
  buildCatalogObject, renderCatalogSql, renderCatalogJson, renderCatalogIndex, CATALOG_SQL_FILE,
} from "../lib/report-catalog-build.js";
import { ROOT, OBJECTS, readSheet, loadCacheSpec, sourceOf } from "./lib/report-sources.mjs";

const CHECK = process.argv.includes("--check");
const OUT_DIR = path.join(ROOT, "lib", "report-catalog");

const columnsOf = await loadCacheSpec();
const catalogs = [];
for (const spec of OBJECTS) {
  const meta = await getRawDescribe(spec.sfObject);
  const { fields: queryable } = await getQueryableFields(spec.sfObject);
  const queryableNames = new Set(queryable.map((f) => f.name.toLowerCase()));
  const liveColumns = columnsOf(spec.cacheTable);
  const workbookRows = spec.workbook ? await readSheet(spec) : null;
  const plan = planTable({
    objectKey: spec.key, sfObject: spec.sfObject, cacheTable: spec.cacheTable, source: sourceOf(spec),
    workbookRows, describeFields: meta.fields || [], queryableNames, existingColumns: liveColumns,
  });
  if (plan.tableMissing) {
    console.log(`${spec.key.padEnd(15)} NO CACHE TABLE — skipped`);
    continue;
  }
  const catalog = buildCatalogObject({ spec, plan, describeFields: meta.fields || [], workbookRows, liveColumns });
  catalogs.push(catalog);
  const gated = catalog.fields.filter((f) => f.gate).length;
  const reportable = catalog.fields.filter((f) => f.reportable).length;
  console.log(`${spec.key.padEnd(15)} columns ${String(catalog.fields.length).padStart(3)}  reportable ${String(reportable).padStart(3)}  gated ${gated}`);
}

const outputs = [
  ...catalogs.map((c) => [path.join(OUT_DIR, `${c.objectKey}.json`), renderCatalogJson(c)]),
  [path.join(OUT_DIR, "index.js"), renderCatalogIndex(catalogs)],
  [path.join(ROOT, CATALOG_SQL_FILE), renderCatalogSql(catalogs)],
];
const same = (file, text) => fs.existsSync(file) && fs.readFileSync(file, "utf8") === text;
if (CHECK) {
  const changed = outputs.filter(([f, t]) => !same(f, t)).map(([f]) => path.relative(ROOT, f));
  if (changed.length) {
    console.log(`\nWould change: ${changed.join(", ")}`);
    process.exit(1);
  }
  console.log("\nNo change.");
  process.exit(0);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
console.log("");
for (const [file, text] of outputs) {
  fs.writeFileSync(file, text, "utf8");
  console.log(`wrote ${path.relative(ROOT, file)}`);
}
console.log(`Nothing was run against the database. Run ${CATALOG_SQL_FILE} in the Supabase SQL editor (TASKS.md, Reporting R1a).`);
