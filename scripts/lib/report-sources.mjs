// scripts/lib/report-sources.mjs — the inputs BOTH reporting generators read (D-087 R0,
// D-088 R1a). One copy, so the cache-column generator and the report-catalog generator can
// never disagree about which objects are reportable, which workbook describes them, or how
// a workbook cell is read.
//
//   scripts/generate-report-columns.mjs   which cache columns should exist (R0)
//   scripts/generate-report-catalog.mjs   what a report may select / filter / group (R1)
//
// READ-ONLY. Moved here verbatim from generate-report-columns.mjs on 2026-11-03; the only
// additions are `descriptionCol` per workbook and the `description` a row now carries
// (the catalog's "what this field means" — also what the R4 AI reads).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { getSupabaseConfig } from "../../lib/supabase.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DOCS = path.join(ROOT, "docs");

// docs/reporting-module.md §4.1. The order is the resync order (§4.5), so the SQL reads in
// the order Tim works. No `workbook` = every readable describe field.
// labelCol / sectionCol / descriptionCol default to "Field Label" / "Section" /
// "Description / Calculation" — the headers every workbook but two uses.
export const OBJECTS = [
  { key: "customer", sfObject: "Sundial_Customer__c", cacheTable: "sundial_customer_cache", workbook: "Sundial_Customer__c_Field_Design.xlsx", sheet: "Fields by Section", sectionCol: "Sundial Section", labelCol: "Label", descriptionCol: "Help Text" },
  { key: "solar", sfObject: "Sundial_Solar__c", cacheTable: "sundial_solar_cache", workbook: "Sundial_Solar_Fields_by_Section.xlsx", sheet: "Fields by Section", descriptionCol: "Description" },
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

/** Where the field list came from, for the coverage report. */
export function sourceOf(spec) {
  return spec.workbook ? `\`docs/${spec.workbook}\` (*${spec.sheet}*)` : "every field the integration user can read (no workbook)";
}

// --- Workbook (the cell reading of generate-field-configs.mjs readSheet) ------
export async function readSheet(spec) {
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
    rows.push({
      rowNumber: r,
      apiName,
      label: cell(spec.labelCol ?? "Field Label"),
      section: cell(spec.sectionCol ?? "Section"),
      description: cell(spec.descriptionCol ?? "Description / Calculation"),
    });
  }
  return rows;
}

// --- Live cache columns, with their types -------------------------------------
// PostgREST's OpenAPI document (the method sundial-cache-sync's getCacheColumns uses).
// Returns (table) => Map(column → OpenAPI format, e.g. "text", "timestamp with time zone").
export async function loadCacheSpec() {
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
