// Tests for lib/report-columns.js — the reporting-grade cache plan (D-087, R0;
// docs/reporting-module.md §4.2 / §4.3). Fixtures only: no Salesforce, no Supabase.
//
// Pinned: the type map, every refusal (name > 63, collision, not readable, existing column
// of another type, unsupported type, formula the sync cannot keep fresh, sensitive), the
// no-workbook rule, column names from sfFieldToColumn, and deterministic rendering.

import test from "node:test";
import assert from "node:assert/strict";
import { sfFieldToColumn } from "./cache-row.js";
import {
  TYPE_MAP, OPENAPI_FORMAT, MAX_IDENTIFIER_LENGTH, pgTypeFor, planTable, renderSql, renderCoverage, sensitiveReason, APPLIED_SQL_FILES,
} from "./report-columns.js";

const base = (over = {}) => ({
  objectKey: "customer",
  sfObject: "Sundial_Customer__c",
  cacheTable: "sundial_customer_cache",
  source: "fixture",
  workbookRows: [],
  describeFields: [],
  existingColumns: new Map([["sf_id", "text"], ["client_sf_id", "text"], ["created_date", "timestamp with time zone"]]),
  ...over,
});
const plan = (over) => {
  const input = base(over);
  const queryableNames = input.queryableNames ?? new Set(input.describeFields.filter((f) => !["address", "location", "base64"].includes(f.type)).map((f) => f.name.toLowerCase()));
  return planTable({ ...input, queryableNames });
};
const rows = (...names) => names.map((apiName) => ({ apiName, label: `${apiName} label`, section: "S" }));

test("type map: every §4.2 describe type, and nothing guessed", () => {
  const expect = {
    string: "text", textarea: "text", picklist: "text", multipicklist: "text", phone: "text", email: "text",
    url: "text", id: "text", encryptedstring: "text", reference: "text", boolean: "boolean", int: "integer",
    double: "numeric", currency: "numeric", percent: "numeric", date: "date", datetime: "timestamptz",
  };
  assert.deepEqual({ ...TYPE_MAP }, expect);
  for (const t of ["address", "location", "base64", "anyType", "time", "combobox"]) {
    assert.equal(pgTypeFor({ type: t }), null, `${t} has no column type`);
  }
  // Every mapped type has the spelling PostgREST reports, for the type-mismatch check.
  for (const pg of new Set(Object.values(TYPE_MAP))) assert.ok(OPENAPI_FORMAT[pg], pg);
});

test("a workbook field becomes a column named by sfFieldToColumn, with the mapped type", () => {
  const describeFields = [
    { name: "Id", type: "id", label: "Record ID" },
    { name: "Client__c", type: "reference", label: "Client" },
    { name: "Stage__c", type: "picklist", label: "Stage" },
    { name: "Sales_Rep__c", type: "reference", label: "Sales Rep" },
    { name: "Contract_Amount__c", type: "currency", label: "Contract Amount" },
    { name: "Panels__c", type: "int", label: "Panels" },
    { name: "Contract_Date__c", type: "date", label: "Contract Date" },
    { name: "Signed_At__c", type: "datetime", label: "Signed At" },
    { name: "Is_Company__c", type: "boolean", label: "Company" },
    { name: "Notes__c", type: "textarea", length: 32768, label: "Notes" },
    { name: "Total__c", type: "currency", calculated: true, label: "Total" }, // formula → result type
  ];
  const p = plan({ describeFields, workbookRows: rows(...describeFields.map((f) => f.name)) });
  const byField = Object.fromEntries(p.add.map((a) => [a.field, a]));
  assert.equal(byField.Stage__c.column, "stage");
  assert.equal(byField.Sales_Rep__c.column, "sales_rep_sf_id");
  assert.equal(byField.Sales_Rep__c.pgType, "text");
  assert.equal(byField.Contract_Amount__c.pgType, "numeric");
  assert.equal(byField.Panels__c.pgType, "integer");
  assert.equal(byField.Contract_Date__c.pgType, "date");
  assert.equal(byField.Signed_At__c.pgType, "timestamptz");
  assert.equal(byField.Is_Company__c.pgType, "boolean");
  assert.equal(byField.Total__c.pgType, "numeric");
  assert.equal(byField.Notes__c.longText, true, "long text is included, and marked");
  for (const a of p.add) assert.equal(a.column, sfFieldToColumn({ name: a.field, type: describeFields.find((f) => f.name === a.field).type }));
  // Id is the sync's own sf_id; Client__c is the control column it is meant to fill.
  assert.ok(!p.add.some((a) => a.field === "Id"));
  assert.deepEqual(p.existing.map((e) => e.column), ["client_sf_id"]);
});

test("refusal: a column name over 63 characters is skipped, never truncated", () => {
  const long = "A".repeat(MAX_IDENTIFIER_LENGTH - 1) + "_x__c"; // 64 once __c goes
  const ok = "B".repeat(MAX_IDENTIFIER_LENGTH) + "__c"; // exactly 63
  const p = plan({ describeFields: [{ name: long, type: "string" }, { name: ok, type: "string" }], workbookRows: rows(long, ok) });
  assert.deepEqual(p.skipped.map((s) => [s.field, s.reason]), [[long, "name_too_long"]]);
  assert.deepEqual(p.add.map((a) => a.column), [ok.slice(0, -3).toLowerCase()]);
});

test("refusal: two fields mapping to one column — neither gets a NEW column", () => {
  const p = plan({ describeFields: [{ name: "Name", type: "string" }, { name: "Name__c", type: "string" }], workbookRows: rows("Name__c") });
  assert.deepEqual(p.add, []);
  assert.equal(p.skipped[0].reason, "collision");
  assert.match(p.skipped[0].detail, /also be filled by Name/);
});

test("refusal: a collision on an EXISTING column keeps the column as it is and reports it", () => {
  const existingColumns = new Map([["sf_id", "text"], ["client_sf_id", "text"], ["name", "text"]]);
  const p = plan({ existingColumns, describeFields: [{ name: "Name", type: "string" }, { name: "Name__c", type: "string" }], workbookRows: rows("Name", "Name__c") });
  assert.deepEqual(p.add, []);
  assert.deepEqual(p.skipped.map((s) => s.field).sort(), ["Name", "Name__c"]);
  assert.ok(p.skipped.every((s) => /stays as it is/.test(s.detail)));
});

test("refusal: a field that maps onto a control column the sync writes itself", () => {
  const p = plan({ describeFields: [{ name: "Created_Date__c", type: "date" }, { name: "Is_Stale__c", type: "boolean" }], workbookRows: rows("Created_Date__c", "Is_Stale__c") });
  assert.deepEqual(p.add, []);
  assert.deepEqual(p.skipped.map((s) => s.reason), ["collision", "collision"]);
});

test("refusal: a workbook field absent from the describe is a Read FLS item, not a column", () => {
  const p = plan({ describeFields: [{ name: "Stage__c", type: "picklist" }], workbookRows: [{ apiName: "Secret_Thing__c", label: "Secret Thing", section: "Money" }, ...rows("Stage__c")] });
  assert.deepEqual(p.fls, [{ field: "Secret_Thing__c", label: "Secret Thing", section: "Money" }]);
  assert.deepEqual(p.add.map((a) => a.field), ["Stage__c"]);
  assert.match(renderCoverage([p]), /- \[ \] `Sundial_Customer__c\.Secret_Thing__c` — Secret Thing \(Money\)/);
});

test("refusal: an existing column of another type is left alone and reported", () => {
  const existingColumns = new Map([["sf_id", "text"], ["client_sf_id", "text"], ["number_of_panels", "integer"], ["stage", "text"]]);
  const p = plan({
    existingColumns,
    describeFields: [{ name: "Number_of_Panels__c", type: "double" }, { name: "Stage__c", type: "picklist" }],
    workbookRows: rows("Number_of_Panels__c", "Stage__c"),
  });
  assert.deepEqual(p.add, []);
  assert.deepEqual(p.skipped.map((s) => [s.column, s.reason]), [["number_of_panels", "type_mismatch"]]);
  assert.match(p.skipped[0].detail, /column is integer; the map says numeric/);
  assert.deepEqual(p.existing.map((e) => e.column), ["stage"], "a matching type is just 'already cached'");
});

test("refusal: compound / unmapped types are reported, never typed", () => {
  const p = plan({ describeFields: [{ name: "Billing_Address__c", type: "address" }, { name: "Blob__c", type: "anyType" }], workbookRows: rows("Billing_Address__c", "Blob__c") });
  assert.deepEqual(p.add, []);
  assert.deepEqual(p.skipped.map((s) => s.reason), ["unsupported_type", "unsupported_type"]);
});

test("refusal: a NEW formula column the sync cannot keep fresh; an existing one is untouched", () => {
  const existingColumns = new Map([["sf_id", "text"], ["client_sf_id", "text"], ["age_days", "numeric"]]);
  const describeFields = [
    { name: "Active_Days__c", type: "double", calculated: true },
    { name: "Age_Days__c", type: "double", calculated: true },
  ];
  const p = plan({ existingColumns, describeFields, workbookRows: rows("Active_Days__c", "Age_Days__c"), freshnessProblem: () => "time-dependent (TODAY/NOW)" });
  assert.deepEqual(p.skipped.map((s) => [s.field, s.reason]), [["Active_Days__c", "formula_not_fresh"]]);
  assert.deepEqual(p.existing.map((e) => e.column), ["age_days"]);
});

test("refusal: credentials and the pay rate are never cached", () => {
  assert.ok(sensitiveReason("Sundial_Customer__c", { name: "Utility_Password__c" }));
  assert.ok(sensitiveReason("Sundial_Estimate__c", { name: "Public_Token__c" }));
  assert.ok(sensitiveReason("Sundial_Service_Job__c", { name: "Report_Public_Token__c" }));
  assert.ok(sensitiveReason("Sundial_User__c", { name: "Hourly_Cost_Rate__c" }));
  assert.equal(sensitiveReason("Sundial_Estimate__c", { name: "Public_Token_Expires_At__c" }), null, "the expiry is not a credential");
  assert.equal(sensitiveReason("Sundial_User__c", { name: "Hourly_Bill_Rate__c" }), null, "a selling price is not gated");
  const p = plan({ describeFields: [{ name: "Utility_Password__c", type: "string" }, { name: "Utility_Account_Number__c", type: "string" }], workbookRows: rows("Utility_Password__c", "Utility_Account_Number__c") });
  assert.deepEqual(p.skipped.map((s) => [s.field, s.reason]), [["Utility_Password__c", "sensitive"]]);
  assert.deepEqual(p.add.map((a) => a.field), ["Utility_Account_Number__c"]);
});

test("no workbook: every readable describe field is a candidate", () => {
  const describeFields = [
    { name: "Id", type: "id" }, { name: "OwnerId", type: "reference", label: "Owner ID" },
    { name: "Name", type: "string", label: "PO Name" }, { name: "Mailing__c", type: "address" },
  ];
  const p = plan({ objectKey: "po", sfObject: "Sundial_PO__c", cacheTable: "sundial_po_cache", workbookRows: null, describeFields });
  assert.deepEqual(p.add.map((a) => a.column), ["ownerid_sf_id", "name"]);
  assert.deepEqual(p.skipped.map((s) => s.field), ["Mailing__c"]);
});

test("a field already cached but not on the workbook is still counted as cached", () => {
  const existingColumns = new Map([["sf_id", "text"], ["client_sf_id", "text"], ["legacy", "text"]]);
  const p = plan({ existingColumns, describeFields: [{ name: "Legacy__c", type: "string" }], workbookRows: [] });
  assert.deepEqual(p.existing.map((e) => e.column), ["legacy"]);
});

test("a missing cache table generates nothing for it", () => {
  const p = plan({ existingColumns: new Map(), describeFields: [{ name: "Stage__c", type: "picklist" }], workbookRows: rows("Stage__c") });
  assert.equal(p.tableMissing, true);
  assert.doesNotMatch(renderSql([p]), /alter table/);
});

test("rendering: one idempotent statement per column, commented, and byte-identical on a re-run", () => {
  const describeFields = [{ name: "Stage__c", type: "picklist", label: "Stage | Status" }, { name: "Notes__c", type: "textarea", length: 1000, label: "Notes\nlong" }];
  const p = plan({ describeFields, workbookRows: rows("Stage__c", "Notes__c") });
  const sql = renderSql([p]);
  assert.match(sql, /^alter table public\.sundial_customer_cache add column if not exists stage text; -- Stage__c — Stage \| Status$/m);
  assert.match(sql, /add column if not exists notes text; -- Notes__c — Notes long \(long text\)$/m);
  assert.equal(sql, renderSql([plan({ describeFields, workbookRows: rows("Stage__c", "Notes__c") })]));
  const doc = renderCoverage([{ ...p, syncUriLength: 20000 }]);
  assert.match(doc, /20,000 \*\*OVER\*\*/);
  assert.match(doc, /Stage \\\| Status/, "a pipe in a label cannot break the table");
});

test("a follow-on SQL file is named in its own header and listed after the applied ones", () => {
  const p = plan({ describeFields: [{ name: "Stage__c", type: "picklist", label: "Stage" }], workbookRows: rows("Stage__c") });
  assert.ok(renderSql([p]).startsWith("-- sql/2026-10-30_report_columns.sql — "), "the default is the first applied file");
  const file = "sql/2026-11-02_report_columns_followon.sql";
  assert.ok(renderSql([p], { file }).startsWith("-- sql/2026-11-02_report_columns_followon.sql — "));
  const doc = renderCoverage([{ ...p, syncUriLength: 100 }], { sqlFiles: [...APPLIED_SQL_FILES, file] });
  assert.ok(doc.includes("SQL, in the order run: `sql/2026-10-30_report_columns.sql`, `sql/2026-11-02_report_columns_followon.sql`."));
});
