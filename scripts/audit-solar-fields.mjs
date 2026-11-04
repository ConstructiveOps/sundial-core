// AUDIT: every custom field on Sundial_Solar__c, for deletion. READ-ONLY.
//
// WHY (2026-11-04): Harmon is out of custom fields on Sundial_Solar__c (Enterprise
// Edition caps an object at 500). Before anything is deleted we need, per field: does it
// hold data, when was that data last touched, and what reads it — in BOTH repos, in the
// three design spreadsheets, and (where the integration user can see it) in Salesforce.
//
//   node scripts/audit-solar-fields.mjs
//
// Writes:
//   docs/audits/solar-fields-2026-11.csv         one row per field, every column
//   docs/audits/solar-fields-2026-11.md          the three buckets + reasoning
//   docs/audits/solar-fields-2026-11-backup.csv  current values of every A/B field with data
//
// NOTHING is written to Salesforce. Every Salesforce call is a describe or a SELECT.
//
// WHAT THIS CANNOT SEE (stated in the md so nobody reads silence as "unused"):
//   - Fields the integration user has no field-level access to are absent from its
//     describe. Compare the total printed here with Setup → Object Manager → Fields.
//   - The Tooling API (FieldDefinition created date, MetadataComponentDependency) returns
//     INVALID_TYPE for the integration user (no View Setup), so Flow / formula /
//     validation-rule / layout / report / email-template references are blank. Tim runs
//     "Where is this used?" in Setup on the shortlist.
//   - "Last touched" is MAX(LastModifiedDate) of the RECORDS holding a value — a record
//     edited for another reason counts. It is an upper bound on how stale the field is.

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { describeObject, getSalesforceToken } from "../lib/salesforce.js";
import { sfFieldToColumn } from "../lib/cache-row.js";

const OBJECT = "Sundial_Solar__c";
const API = "v60.0";
const CORE = fileURLToPath(new URL("..", import.meta.url));
const CRM = join(CORE, "..", "harmon-crm");
const OUT_DIR = join(CORE, "docs", "audits");
const STAMP = "2026-11";
const TODAY = new Date();
const TWELVE_MONTHS_AGO = new Date(TODAY.getTime() - 365 * 24 * 3600 * 1000);
const NEAR_EMPTY_MAX = 5;

// Tim's decision (2026-11-04): these go whatever the counts. A or B, never C.
const FORCED = (name) =>
  /^Permit_.*_(3|4)__c$/i.test(name) || /^Web_Inspection_Key_Code_(3|4)__c$/i.test(name);

// ---------------------------------------------------------------- Salesforce helpers

async function sfGet(path) {
  for (const force of [false, true]) {
    const { access_token, instance_url } = await getSalesforceToken({ forceRefresh: force });
    const r = await fetch(`${instance_url}${path}`, { headers: { Authorization: `Bearer ${access_token}` } });
    if (r.status === 401 && !force) continue;
    const text = await r.text();
    if (!r.ok) {
      const e = new Error(`Salesforce ${r.status}: ${text.slice(0, 300)}`);
      e.status = r.status;
      throw e;
    }
    return JSON.parse(text);
  }
}
const q = (soql, tooling = false) =>
  sfGet(`/services/data/${API}/${tooling ? "tooling/" : ""}query?q=${encodeURIComponent(soql)}`);

async function qAll(soql) {
  let page = await q(soql);
  const out = [...page.records];
  while (!page.done && page.nextRecordsUrl) {
    page = await sfGet(page.nextRecordsUrl);
    out.push(...page.records);
  }
  return out;
}

/** Run fn over items with a small concurrency cap (stay well inside the API budget). */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------- 1. describe

const describe = await describeObject(OBJECT);
const custom = describe.fields.filter((f) => f.custom);
console.log(`${OBJECT}: ${custom.length} custom fields visible to the integration user (${describe.fields.length} total incl. standard).`);

// Tooling (created date + dependencies): probe once, say so once.
let toolingNote = "";
let toolingOk = false;
try {
  await q(`SELECT Id FROM CustomField WHERE TableEnumOrId = '${OBJECT}' LIMIT 1`, true);
  toolingOk = true;
} catch (e) {
  toolingNote = "The integration user cannot use the Tooling API (CustomField / FieldDefinition / MetadataComponentDependency all return INVALID_TYPE — no View Setup).";
  console.log(toolingNote);
}

// FieldDefinition through the REGULAR API does answer; it carries LastModifiedDate of
// the field's metadata (not its created date). Kept as a separate column.
const fieldDefModified = new Map();
try {
  const rows = await qAll(
    `SELECT QualifiedApiName, LastModifiedDate FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${OBJECT}'`,
  );
  for (const r of rows) fieldDefModified.set(r.QualifiedApiName, r.LastModifiedDate ?? "");
} catch (e) {
  console.log(`FieldDefinition (regular API) unavailable: ${e.message.slice(0, 120)}`);
}

const createdDate = new Map();
const sfDeps = new Map();
if (toolingOk) {
  // Not reached for the integration user today; kept so a better-privileged run fills it.
  const objId = (await q(`SELECT Id FROM CustomObject WHERE DeveloperName = '${OBJECT.replace(/__c$/, "")}'`, true)).records[0]?.Id;
  const cfs = await q(`SELECT Id, DeveloperName, CreatedDate FROM CustomField WHERE TableEnumOrId = '${objId}'`, true);
  for (const r of cfs.records) createdDate.set(`${r.DeveloperName}__c`, { date: r.CreatedDate, id: r.Id });
  await pool(custom, 4, async (f) => {
    const id = createdDate.get(f.name)?.id;
    if (!id) return;
    const d = await q(
      `SELECT MetadataComponentType, MetadataComponentName FROM MetadataComponentDependency WHERE RefMetadataComponentId = '${id}'`,
      true,
    );
    sfDeps.set(f.name, d.records.map((r) => `${r.MetadataComponentType}:${r.MetadataComponentName}`));
  });
}

// ---------------------------------------------------------------- 2. data

const totalRecords = (await q(`SELECT COUNT() FROM ${OBJECT}`)).totalSize;
console.log(`${totalRecords} ${OBJECT} records.`);

const data = new Map(); // name -> { count, lastTouched }
const filterable = custom.filter((f) => f.filterable);
const unfilterable = custom.filter((f) => !f.filterable);

await pool(filterable, 8, async (f) => {
  const where = f.type === "boolean" ? `${f.name} = true` : `${f.name} != null`;
  const r = await q(`SELECT COUNT(Id) c, MAX(LastModifiedDate) m FROM ${OBJECT} WHERE ${where}`);
  data.set(f.name, { count: r.records[0].c ?? 0, lastTouched: r.records[0].m ?? "" });
});

// Long / rich text cannot appear in WHERE: scan every record, 25 such fields at a time,
// and keep the values (the backup needs them if the field lands in A/B).
const scanned = new Map(); // name -> [{Id, Name, value}]
for (let i = 0; i < unfilterable.length; i += 25) {
  const chunk = unfilterable.slice(i, i + 25);
  const recs = await qAll(`SELECT Id, Name, LastModifiedDate, ${chunk.map((f) => f.name).join(", ")} FROM ${OBJECT}`);
  for (const f of chunk) {
    const hits = recs.filter((r) => r[f.name] != null && r[f.name] !== "");
    const last = hits.reduce((m, r) => (r.LastModifiedDate > m ? r.LastModifiedDate : m), "");
    data.set(f.name, { count: hits.length, lastTouched: last });
    scanned.set(f.name, hits.map((r) => ({ Id: r.Id, Name: r.Name, value: r[f.name] })));
  }
}
console.log(`Data counted (${filterable.length} by aggregate, ${unfilterable.length} by scan).`);

// ---------------------------------------------------------------- 3. code references

const SCAN_DIRS = ["lambdas", "lib", "scripts", "sql", "src", "docs"];
const EXTS = new Set([".js", ".mjs", ".ts", ".tsx", ".sql", ".json", ".md"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "audits"]);
const SELF = "scripts/audit-solar-fields.mjs";

function* walk(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (SKIP_DIRS.has(n)) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else yield p;
  }
}

// API name (lower-cased) -> Set(file), and cache column -> Set(file).
const apiHits = new Map();
const colHits = new Map();
const generatedFiles = new Set();
const add = (m, k, v) => (m.get(k) ?? m.set(k, new Set()).get(k)).add(v);

for (const [repo, root] of [["sundial-core", CORE], ["harmon-crm", CRM]]) {
  for (const d of SCAN_DIRS) {
    for (const p of walk(join(root, d))) {
      const ext = p.slice(p.lastIndexOf("."));
      if (!EXTS.has(ext)) continue;
      const rel = `${repo}/${relative(root, p).split(sep).join("/")}`;
      if (rel === `sundial-core/${SELF}`) continue;
      const text = readFileSync(p, "utf8");
      if (/^\s*\/\/\s*AUTO-GENERATED/.test(text) || /^\s*--\s*(AUTO-)?GENERATED/i.test(text)) generatedFiles.add(rel);
      for (const tok of text.match(/[A-Za-z0-9_]+/g) ?? []) {
        const low = tok.toLowerCase();
        if (low.endsWith("__c")) add(apiHits, low, rel);
        else if (low.endsWith("__r")) add(apiHits, low.replace(/__r$/, "__c"), rel); // relationship traversal
        else if (tok === low && low.includes("_")) add(colHits, low, rel);
      }
    }
  }
}

// The xlsx design sheets: every cell, sheet + row.
const XLSX = [
  "docs/Sundial_Solar_Fields_by_Section.xlsx",
  "docs/Sundial_Solar_Budget_Fields.xlsx",
  "docs/Dealer Portal Field Visibility from Harmon.xlsx",
];
const xlsxHits = new Map(); // api lower -> [ "file!sheet!row" ]
for (const [repo, root] of [["sundial-core", CORE], ["harmon-crm", CRM]]) {
  for (const f of XLSX) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(p);
    const short = `${repo === "harmon-crm" ? "harmon-crm/" : ""}${f.split("/").pop()}`;
    wb.eachSheet((ws) => {
      ws.eachRow((row, rn) => {
        const seen = new Set();
        row.eachCell((cell) => {
          const v = cell.value;
          const s = typeof v === "string" ? v : v?.richText ? v.richText.map((t) => t.text).join("") : v?.text ?? v?.result ?? "";
          for (const tok of String(s).match(/[A-Za-z0-9_]+__c/gi) ?? []) seen.add(tok.toLowerCase());
        });
        for (const t of seen) (xlsxHits.get(t) ?? xlsxHits.set(t, []).get(t)).push(`${short}!${ws.name}!${rn}`);
      });
    });
  }
}

// LIST_PROJECTION.solar, parsed from source (importing sf-query would pull its secrets).
const sfq = readFileSync(join(CORE, "lambdas/sundial-sf-query/index.js"), "utf8");
const solarProj = new Set(
  (sfq.slice(sfq.indexOf("export const LIST_PROJECTION")).match(/\n\s*solar:\s*\[([\s\S]*?)\]/)?.[1].match(/"([a-z0-9_]+)"/g) ?? []).map((s) => s.slice(1, -1)),
);

// Path classifiers. "auto" = describe-driven or regenerated from the cache/describe:
// such a reference disappears when the generator is re-run; it never blocks a delete.
const isCacheSync = (f) => f.startsWith("sundial-core/lambdas/sundial-cache-sync/");
const isReportCatalog = (f) =>
  f.startsWith("sundial-core/lib/report-catalog/") || /sql\/.*report_catalog/.test(f);
const isCacheSchemaGen = (f) =>
  /sql\/.*report_columns/.test(f) || f.endsWith("docs/reporting-cache-coverage.md");
const isFieldManifest = (f) => f.startsWith("sundial-core/lib/field-manifest/");
const isAuto = (f) => isCacheSync(f) || isReportCatalog(f) || isCacheSchemaGen(f);
const isDoc = (f) => f.endsWith(".md");
const isPipelineSql = (f) => /sql\/.*solar_pipeline/.test(f);
const isAuroraHcp = (f) => /aurora|hcp/i.test(f);
const isCustToSolar = (f) => /customer-to-solar|customer-solar-mirror|create-solar-from-customer/.test(f);

// ---------------------------------------------------------------- 4. assemble

const rows = custom.map((f) => {
  const api = f.name;
  const low = api.toLowerCase();
  const col = sfFieldToColumn(f);
  const files = new Set(apiHits.get(low) ?? []);
  const colFiles = col.includes("_") ? [...(colHits.get(col) ?? [])].filter((x) => !files.has(x)) : [];
  const all = [...files, ...colFiles.map((x) => `${x} (col)`)].sort();
  const strip = (x) => x.replace(/ \(col\)$/, "");
  const code = all.filter((x) => !isAuto(strip(x)) && !isDoc(strip(x)) && !isFieldManifest(strip(x)));
  const auto = all.filter((x) => isAuto(strip(x)) || isFieldManifest(strip(x)));
  const docs = all.filter((x) => isDoc(strip(x)) && !isAuto(strip(x)));
  const xl = xlsxHits.get(low) ?? [];
  const d = data.get(api) ?? { count: 0, lastTouched: "" };
  const isLookup = f.type === "reference";
  const required = !f.nillable && f.type !== "boolean";
  return {
    api_name: api,
    label: f.label,
    type: f.type + (f.length && ["string", "textarea"].includes(f.type) ? `(${f.length})` : ""),
    formula: f.calculated ? "yes" : "",
    required: required ? "yes" : "",
    external_id: f.externalId ? "yes" : "",
    lookup: isLookup ? `${f.relationshipName ?? ""} → ${(f.referenceTo ?? []).join("/")}${f.cascadeDelete ? " (master-detail)" : ""}` : "",
    created_date: createdDate.get(api)?.date ?? "",
    metadata_last_modified: fieldDefModified.get(api) ?? "",
    records_with_value: d.count,
    last_touched: d.lastTouched ? d.lastTouched.slice(0, 10) : "",
    forced_by_tim: FORCED(api) ? "yes" : "",
    code_refs: code,
    auto_refs: auto,
    doc_refs: docs,
    xlsx_refs: xl,
    cache_sync_only: code.length === 0 && xl.length === 0 && auto.some((x) => isCacheSync(strip(x))) ? "yes" : "",
    in_list_projection: solarProj.has(col) ? "yes" : "",
    in_solar_pipeline_sql: all.some((x) => isPipelineSql(strip(x))) ? "yes" : "",
    in_generated_portal_config: all.filter((x) => generatedFiles.has(strip(x)) && strip(x).startsWith("harmon-crm/src/")).join("; "),
    in_aurora_hcp_import: all.filter((x) => isAuroraHcp(strip(x)) && !isDoc(strip(x))).join("; "),
    in_report_catalog: all.some((x) => isReportCatalog(strip(x))) ? "yes" : "",
    in_customer_to_solar_copy: all.filter((x) => isCustToSolar(strip(x))).join("; "),
    sf_dependencies: toolingOk ? (sfDeps.get(api) ?? []).join("; ") : "",
  };
});

// Buckets.
const empty = (r) =>
  r.records_with_value === 0 ||
  (r.records_with_value <= NEAR_EMPTY_MAX && r.last_touched && new Date(r.last_touched) < TWELVE_MONTHS_AGO);
const structural = (r) => r.formula || r.required || r.external_id || r.lookup;
for (const r of rows) {
  const blockers = r.code_refs.length + r.xlsx_refs.length + (r.sf_dependencies ? 1 : 0);
  if (r.forced_by_tim) {
    r.bucket = blockers || structural(r) ? "B" : "A";
    r.reason = `Tim's decision${r.records_with_value ? ` — ${r.records_with_value} record(s) hold a value (backed up)` : ""}${blockers ? "; references to remove first" : ""}`;
  } else if (empty(r) && !blockers && !structural(r)) {
    r.bucket = "A";
    r.reason = r.records_with_value ? `${r.records_with_value} record(s), last touched ${r.last_touched}` : "no data, no references";
  } else if (empty(r)) {
    r.bucket = "B";
    const why = [];
    if (blockers) why.push("referenced");
    if (r.formula) why.push("formula");
    if (r.lookup) why.push("lookup");
    if (r.required) why.push("required");
    if (r.external_id) why.push("external id");
    r.reason = `empty/near-empty but ${why.join(", ")}`;
  } else {
    r.bucket = "C";
    r.reason = `${r.records_with_value} record(s) hold a value${r.last_touched ? `, last touched ${r.last_touched}` : ""}`;
  }
}

// ---------------------------------------------------------------- 5. write

mkdirSync(OUT_DIR, { recursive: true });
const csvCell = (v) => {
  const s = Array.isArray(v) ? v.join("; ") : String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const COLS = [
  "bucket", "api_name", "label", "type", "formula", "required", "external_id", "lookup",
  "created_date", "metadata_last_modified", "records_with_value", "last_touched", "forced_by_tim",
  "code_refs", "xlsx_refs", "auto_refs", "doc_refs", "cache_sync_only", "in_list_projection",
  "in_solar_pipeline_sql", "in_generated_portal_config", "in_aurora_hcp_import", "in_report_catalog",
  "in_customer_to_solar_copy", "sf_dependencies", "reason",
];
const order = { A: 0, B: 1, C: 2 };
rows.sort((a, b) => order[a.bucket] - order[b.bucket] || a.api_name.localeCompare(b.api_name));
writeFileSync(
  join(OUT_DIR, `solar-fields-${STAMP}.csv`),
  [COLS.join(","), ...rows.map((r) => COLS.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n",
);

// Backup of every A/B field that holds anything.
const backup = [["Id", "Name", "field", "value"]];
for (const r of rows.filter((x) => (x.bucket === "A" || x.bucket === "B") && x.records_with_value > 0)) {
  const f = custom.find((x) => x.name === r.api_name);
  let vals = scanned.get(r.api_name);
  if (!vals) {
    const where = f.type === "boolean" ? `${f.name} = true` : `${f.name} != null`;
    vals = (await qAll(`SELECT Id, Name, ${f.name} FROM ${OBJECT} WHERE ${where}`)).map((x) => ({ Id: x.Id, Name: x.Name, value: x[f.name] }));
  }
  for (const v of vals) backup.push([v.Id, v.Name, r.api_name, typeof v.value === "object" ? JSON.stringify(v.value) : v.value]);
}
writeFileSync(join(OUT_DIR, `solar-fields-${STAMP}-backup.csv`), backup.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");

// The markdown report.
const A = rows.filter((r) => r.bucket === "A");
const B = rows.filter((r) => r.bucket === "B");
const C = rows.filter((r) => r.bucket === "C");
const forced = rows.filter((r) => r.forced_by_tim);
const md = [];
md.push(`# Sundial_Solar__c custom-field audit — ${TODAY.toISOString().slice(0, 10)}`);
md.push("");
md.push(`Generated by \`node scripts/audit-solar-fields.mjs\` (read-only). Full detail per field: \`solar-fields-${STAMP}.csv\`; values of every A/B field that holds data: \`solar-fields-${STAMP}-backup.csv\` (${backup.length - 1} values).`);
md.push("");
md.push("## Summary");
md.push("");
md.push(`| | |\n|---|---|`);
md.push(`| Custom fields visible to the integration user | **${custom.length}** — compare with Setup → Object Manager → Sundial Solar → Fields; any field without integration-user field access is missing here |`);
md.push(`| Records on the object | ${totalRecords} |`);
md.push(`| A — delete now | **${A.length}** |`);
md.push(`| B — delete after cleanup | **${B.length}** |`);
md.push(`| C — keep | ${C.length} |`);
md.push(`| Tim's forced set (Permit_*_3/4, Web_Inspection_Key_Code_3/4) | ${forced.length} found${forced.length === 12 ? "" : " — expected 12, check the names"} |`);
md.push("");
md.push("## What this audit could not see");
md.push("");
md.push(`- **Salesforce-side references are blank.** ${toolingNote || "Tooling API reachable."} Flows, formula fields, validation rules, page layouts, reports and email templates that use a field are therefore not in this audit — run **Setup → field → "Where is this used?"** on every A and B field before deleting. Deleting a field that a Flow or formula uses is blocked by Salesforce, so the risk is a failed delete, not silent breakage; reports and list views are NOT blocked and simply lose the column.`);
md.push(`- **Created date is blank** for the same reason. \`metadata_last_modified\` in the CSV is FieldDefinition.LastModifiedDate (regular API) — when the field's definition last changed.`);
const touched = rows.map((r) => r.last_touched).filter(Boolean).sort();
md.push(`- **"Last touched" is the record's LastModifiedDate**, not the field's — a record edited for any reason counts, so a field can be staler than it looks. The earliest "last touched" of any field with data is **${touched[0] ?? "n/a"}**: the Solar records were written by the Sunbase migration, so the "≤ ${NEAR_EMPTY_MAX} records, untouched in 12 months" rule cannot fire yet — in practice A means no data at all.`);
md.push("- **Saved reports** (`public.sundial_reports`, R1b) can name a cache column. Before regenerating the report catalog after a delete, check no saved report uses the dropped column.");
md.push(`- Code references are token matches of the API name (and of the cache column name, marked \`(col)\`, when it has an underscore) across both repos' lambdas/ lib/ scripts/ sql/ src/ docs/. A \`(col)\` hit can be an unrelated variable of the same name.`);
md.push("");
md.push("## How the buckets were decided");
md.push("");
md.push(`- **Data:** "empty" = no record holds a value (booleans: none ticked), or ≤ ${NEAR_EMPTY_MAX} records none of which was modified after ${TWELVE_MONTHS_AGO.toISOString().slice(0, 10)}.`);
md.push("- **Blocking references:** code/config files (both repos), the three xlsx sheets (the Fields-by-Section and Dealer sheets generate the portal's page configs), and Salesforce dependencies when visible.");
md.push("- **Not blocking (listed as `auto_refs` / `doc_refs`):** the cache sync (describe-driven: a deleted field simply stops being selected), the generated report catalog / report-column SQL / `reporting-cache-coverage.md`, the generated access manifest `lib/field-manifest/*.json`, and prose `.md` docs. After deleting, re-run the generators (catalog, field configs) and drop the cache column if you want the column gone too.");
md.push("- **A** needs empty + no blocking reference + not formula / lookup / required / external id. **B** is empty but has one of those. **C** is everything holding data. Tim's forced 12 go to A or B regardless of data.");
md.push("");
const refList = (r) => [
  ...r.code_refs.map((x) => `  - code: \`${x}\``),
  ...r.xlsx_refs.map((x) => `  - sheet: ${x}`),
  ...(r.formula ? ["  - is a **formula** field"] : []),
  ...(r.lookup ? [`  - is a **lookup** (${r.lookup}) — delete its related list from layouts`] : []),
  ...(r.required ? ["  - is **required**"] : []),
  ...(r.external_id ? ["  - is an **external id**"] : []),
];
const tidy = (r) => (r.auto_refs.length || r.doc_refs.length ? ` · regenerate/tidy: ${[...r.auto_refs, ...r.doc_refs].length} auto/doc file(s)` : "");

md.push(`## A. DELETE NOW (${A.length})`);
md.push("");
md.push("| Field | Label | Type | Records | Last touched | Note |\n|---|---|---|---|---|---|");
for (const r of A) md.push(`| \`${r.api_name}\` | ${r.label} | ${r.type} | ${r.records_with_value} | ${r.last_touched} | ${r.forced_by_tim ? "Tim's set · " : ""}${r.reason}${tidy(r)} |`);
md.push("");
md.push(`## B. DELETE AFTER CLEANUP (${B.length})`);
md.push("");
for (const r of B) {
  md.push(`- **\`${r.api_name}\`** (${r.label}, ${r.type}) — ${r.records_with_value} record(s)${r.last_touched ? `, last touched ${r.last_touched}` : ""}. ${r.forced_by_tim ? "Tim's set. " : ""}Remove:`);
  md.push(...refList(r));
  if (r.auto_refs.length || r.doc_refs.length) md.push(`  - then regenerate/tidy: ${[...r.auto_refs, ...r.doc_refs].map((x) => `\`${x}\``).join(", ")}`);
}
md.push("");
md.push(`## C. KEEP (${C.length})`);
md.push("");
const cBand = (lo, hi) => C.filter((r) => r.records_with_value >= lo && r.records_with_value <= hi).length;
md.push(`Every C field holds data. By volume: ${cBand(1, 5)} with 1–5 records (touched within 12 months), ${cBand(6, 50)} with 6–50, ${cBand(51, 500)} with 51–500, ${cBand(501, Infinity)} with more than 500.`);
md.push("");
const thin = C.filter((r) => r.records_with_value <= 50).sort((a, b) => a.records_with_value - b.records_with_value);
if (thin.length) {
  md.push(`**Next candidates if more room is needed** — C fields with ≤ 50 records (data would have to be migrated or accepted as lost):`);
  md.push("");
  md.push("| Field | Records | Last touched | Code refs |\n|---|---|---|---|");
  for (const r of thin) md.push(`| \`${r.api_name}\` | ${r.records_with_value} | ${r.last_touched} | ${r.code_refs.length + r.xlsx_refs.length} |`);
  md.push("");
}
writeFileSync(join(OUT_DIR, `solar-fields-${STAMP}.md`), md.join("\n") + "\n");

console.log(`A ${A.length} · B ${B.length} · C ${C.length} · forced ${forced.length} · backup values ${backup.length - 1}`);
