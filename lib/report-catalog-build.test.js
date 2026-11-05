// node --test lib/report-catalog-build.test.js
//
// Pinned (D-088): the catalog takes its columns only from planTable() (existing +
// type_mismatch) plus the sf_id / created_date control columns; client_sf_id never appears;
// sensitive and bookkeeping fields are reportable:false; the cost-gate lists become gates;
// long text is flagged; workbook label / section / description win over the describe; the
// SQL seed and the index are deterministic; and the COMMITTED catalog agrees with
// lib/cost-gate.js (every cost / markup column gated, nothing else).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCatalogObject, renderCatalogSql, renderCatalogIndex, gateFor, CATALOG_SQL_FILE } from "./report-catalog-build.js";
import { planTable, CONTROL_COLUMNS } from "./report-columns.js";
import { COST_FIELDS, COSTING_READ, isMarkupKey } from "./cost-gate.js";
import { CATALOG } from "./report-catalog/index.js";

const describe = [
  { name: "Id", type: "id", label: "Record ID" },
  { name: "Client__c", type: "reference", label: "Client" },
  { name: "Name", type: "string", label: "Name" },
  { name: "Stage__c", type: "picklist", label: "Stage", picklistValues: [{ value: "A", active: true }, { value: "Old", active: false }], inlineHelpText: "help" },
  { name: "Notes__c", type: "textarea", length: 32768, label: "Notes" },
  { name: "Count__c", type: "double", label: "Count" },
  { name: "Owner_Password__c", type: "string", label: "Password" },
  { name: "IsDeleted", type: "boolean", label: "Deleted" },
  { name: "Labor_Cost__c", type: "currency", label: "Labor Cost" },
  { name: "Not_Cached__c", type: "string", label: "Not cached" },
];
const live = new Map([
  ["sf_id", "text"], ["client_sf_id", "text"], ["tenant_id", "text"], ["created_date", "timestamp with time zone"],
  ["last_synced_at", "timestamp with time zone"], ["name", "text"], ["stage", "text"], ["notes", "text"],
  ["count", "integer"], ["owner_password", "text"], ["isdeleted", "boolean"], ["labor_cost", "numeric"],
  ["orphan_column", "text"], // a column with no Salesforce field behind it
]);
const spec = { key: "pricebookitem", sfObject: "Sundial_Price_Book_Item__c", cacheTable: "sundial_price_book_item_cache" };
const workbookRows = [{ apiName: "Stage__c", label: "Stage (WB)", section: "Main", description: "From the workbook" }];
const plan = planTable({
  objectKey: spec.key, sfObject: spec.sfObject, cacheTable: spec.cacheTable, source: "test",
  workbookRows: null, describeFields: describe, queryableNames: new Set(describe.map((f) => f.name.toLowerCase())), existingColumns: live,
});
const cat = buildCatalogObject({ spec, plan, describeFields: describe, workbookRows, liveColumns: live });
const by = (c) => cat.fields.find((f) => f.column === c);

test("columns come from planTable + the two control columns; never client_sf_id or an orphan", () => {
  const cols = cat.fields.map((f) => f.column).sort();
  assert.deepEqual(cols, ["count", "created_date", "isdeleted", "labor_cost", "name", "notes", "owner_password", "sf_id", "stage"]);
  assert.ok(CONTROL_COLUMNS.includes("sf_id") && CONTROL_COLUMNS.includes("created_date"));
});

test("a type_mismatch column is kept with its LIVE Postgres type", () => {
  assert.equal(by("count").type, "number");
  assert.equal(by("count").pgType, "integer");
});

test("reportable, gate, long text, picklists, labels", () => {
  assert.equal(by("sf_id").reportable, false);
  assert.equal(by("owner_password").reportable, false); // a credential
  assert.equal(by("isdeleted").reportable, false); // bookkeeping
  assert.equal(by("created_date").reportable, true);
  assert.equal(by("labor_cost").gate, COSTING_READ);
  assert.equal(by("name").gate, null);
  assert.equal(by("notes").longText, true);
  assert.equal(by("stage").type, "picklist");
  assert.deepEqual(by("stage").picklistValues, ["A"]);
  assert.equal(by("stage").label, "Stage (WB)");
  assert.equal(by("stage").section, "Main");
  assert.equal(by("stage").description, "From the workbook");
  assert.equal(by("name").description, "");
});

test("gateFor follows lib/cost-gate.js", () => {
  assert.equal(gateFor("serviceline", "unit_labor_cost"), COSTING_READ);
  assert.equal(gateFor("estimate", "markup_amount"), COSTING_READ);
  assert.equal(gateFor("solar", "labor_cost"), null); // cost columns are per object
  assert.equal(gateFor("solar", "contract_amount"), null);
});

test("the SQL seed and the index render deterministically", () => {
  const a = renderCatalogSql([cat]);
  assert.equal(a, renderCatalogSql([cat]));
  assert.match(a, /^begin;$/m);
  assert.match(a, /delete from public\.sundial_report_catalog;/);
  assert.match(a, /\('pricebookitem', 'sundial_price_book_item_cache', 'labor_cost', 'numeric', 'service\.costing\.read', true\)/);
  assert.match(a, /revoke all on public\.sundial_report_catalog from public, anon, authenticated;/);
  assert.match(renderCatalogIndex([cat]), /import pricebookitem from "\.\/pricebookitem\.json" with \{ type: "json" \};/);
});

test("the COMMITTED catalog: every cost / markup column gated, nothing else; no control columns leak", () => {
  for (const [objectKey, c] of Object.entries(CATALOG)) {
    for (const f of c.fields) {
      const shouldGate = (COST_FIELDS[objectKey]?.cache.includes(f.column) ?? false) || isMarkupKey(f.column);
      assert.equal(f.gate, shouldGate ? COSTING_READ : null, `${objectKey}.${f.column}`);
      assert.ok(!["client_sf_id", "tenant_id", "is_stale", "cache_version", "last_synced_at"].includes(f.column), `${objectKey}.${f.column}`);
    }
  }
  for (const [objectKey, f] of Object.entries(COST_FIELDS)) {
    for (const col of f.cache) assert.ok(CATALOG[objectKey].fields.some((x) => x.column === col), `${objectKey}.${col} missing`);
  }
});

test("the COMMITTED SQL seed matches the committed JSON", () => {
  // Compared without CRs: git (core.autocrlf on Windows) checks the file out with CRLF
  // endings after any merge, and that is not a content difference.
  const sql = readFileSync(new URL(`../${CATALOG_SQL_FILE}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(sql, renderCatalogSql(Object.values(CATALOG)));
});
