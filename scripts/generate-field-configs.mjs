// Phase 4 — the field manifest generator. D-064, docs/access-model.md §4.1, §4.2.
//
//   node scripts/generate-field-configs.mjs            # report only
//   node scripts/generate-field-configs.mjs --apply    # write lib/field-manifest/*.json
//   node scripts/generate-field-configs.mjs --json
//
// Reads the field-design workbooks in docs/ and emits, per object, the set of fields
// each sales role may READ and EDIT. That JSON is the only thing the server consults;
// the sheets are the only thing a human edits. There is no third place.
//
// ---------------------------------------------------------------------------
// THE REFUSALS ARE THE POINT (§4.1)
// ---------------------------------------------------------------------------
// This generator FAILS THE BUILD rather than the request. Every rule below is one that,
// if it were checked at request time instead, would be checked thousands of times a day
// and would fail in front of a user:
//
//   - a value that is not hidden/read/edit is an ERROR, never a default. "Read-only"
//     in the Sales Rep column is a typo somebody meant as `read`, and guessing which of
//     the three they meant is exactly the wrong instinct for an authorization input.
//   - `edit` on a field Salesforce says is not updateable (a formula, a roll-up, an
//     autonumber) is an ERROR. It would produce a manifest promising an edit the org
//     will refuse, and the user would meet that refusal as a save failure.
//   - `edit` on a PROTECTED field is an ERROR whatever the sheet says (§3.4). These are
//     the fields that decide who owns a record: letting a rep edit Sales_Rep__c lets a
//     rep hand themselves another rep's book, which is the entire model defeated in one
//     PATCH.
//
// An unknown API name is a WARNING, not an error: the sheets legitimately carry rows for
// fields that are planned but not yet created in Salesforce. Those rows are EXCLUDED
// from the manifest (a field that does not exist cannot be read), and listed so a typo
// is visible rather than silently costing a rep a field they were meant to see.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { getSalesforceToken } from "../lib/salesforce.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const OUT_DIR = path.join(ROOT, "lib", "field-manifest");
const APPLY = process.argv.includes("--apply");
const JSON_OUT = process.argv.includes("--json");
const SF_API_VERSION = "v60.0";

const log = (...a) => { if (!JSON_OUT) console.log(...a); };
const rule = (c = "=") => log(c.repeat(100));

/** The sales roles that get a column. Tenant-wide roles are not columns (§4.1). */
const ROLES = ["Sales Rep", "Sales Dealer"];

/**
 * Never `edit` for a sales role, whatever the sheet says (§3.4 step 4).
 *
 * These decide who OWNS a record. `Stage__c`/`Status__c` are here because moving a deal
 * through stages is a business action with side effects (Flows, budget recalcs,
 * notifications), not a field edit — if a role should move stages, that is an action key
 * in ACTION_SCOPES, not an editable field.
 */
const PROTECTED_FIELDS = new Set([
  "Sales_Rep__c",
  "Dealer__c",
  "Client__c",
  "Stage__c",
  "Status__c",
]);

/**
 * Cache columns that carry no sheet row and are ALWAYS in a list response: the record
 * key, the isolation key, and the freshness/ordering control columns. Reviewed once,
 * here, rather than inferred — an inferred allowlist would quietly grow.
 *
 * ⚠️ NOT a visibility decision. These are plumbing every list row needs to be a row at
 * all; none of them is business data. `client_sf_id` in particular is the tenant key the
 * caller already proved they belong to.
 */
const ALWAYS_LIST_COLUMNS = [
  "sf_id",
  "client_sf_id",
  "tenant_id",
  "created_date",
  "last_synced_at",
  "is_stale",
  "cache_version",
];

const OBJECTS = [
  {
    key: "customer",
    sfObject: "Sundial_Customer__c",
    workbook: "Sundial_Customer__c_Field_Design.xlsx",
    sheet: "Fields by Section",
    apiCol: "API Name",
    sectionCol: "Sundial Section",
    roleColumns: true,
  },
  {
    key: "solar",
    sfObject: "Sundial_Solar__c",
    workbook: "Sundial_Solar_Fields_by_Section.xlsx",
    sheet: "Fields by Section",
    apiCol: "API Name",
    sectionCol: "Section",
    roleColumns: true,
  },
  {
    // §4.1: roofing needs no role columns while the module is denied to every sales
    // scope. It still gets a manifest — an ALL-HIDDEN one — so the loader never has to
    // special-case a missing file, and so the day roofing opens the shape already exists.
    key: "roofing",
    sfObject: "Sundial_Roofing__c",
    workbook: "Sundial_Roofing_Fields_by_Section.xlsx",
    sheet: "Field List (Module)",
    apiCol: "API Name",
    sectionCol: "Section",
    roleColumns: false,
  },
];

// --- The harmon-crm copies, which must not drift ----------------------------
//
// The workbooks live HERE (§4.2): this is where the manifest that gates real access
// is generated from. harmon-crm keeps a copy only because its two client-config
// generators still read it for LAYOUT (sections, labels, field order) -- which is not
// authorization, but is the same file.
//
// Two committed copies of a source-of-truth file is exactly the fork §4.2 warns about,
// so the generator compares them on every run and says so. It WARNS rather than fails:
// a sibling checkout may be absent or on another branch, and refusing to generate the
// server manifest because a client repo is missing would be the wrong dependency.
//
// The close-out is to teach this generator to emit the client configs too (§4.2 output
// 2), then delete harmon-crm's two generators, its sheet copies AND its
// generate:configs npm script together -- all three, or the deletion breaks whatever
// is left behind.
function warnIfClientCopyDrifted(spec) {
  const sibling = path.join(ROOT, "..", "harmon-crm", "docs", spec.workbook);
  if (!fs.existsSync(sibling)) return null;
  const sha = (p) =>
    crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const here = sha(path.join(DOCS, spec.workbook));
  const there = sha(sibling);
  if (here === there) return null;
  return (
    spec.workbook +
    ": harmon-crm copy DIFFERS from this one (" +
    here.slice(0, 12) +
    " vs " +
    there.slice(0, 12) +
    "). This file is the source of truth; copy it over, or the client layout and the " +
    "server field rules describe different sheets."
  );
}

// --- Salesforce describe ----------------------------------------------------
async function describe(sfObject) {
  const { access_token, instance_url } = await getSalesforceToken();
  const resp = await fetch(
    `${instance_url}/services/data/${SF_API_VERSION}/sobjects/${sfObject}/describe`,
    { headers: { Authorization: `Bearer ${access_token}` } }
  );
  if (!resp.ok) throw new Error(`describe ${sfObject} failed (${resp.status})`);
  const meta = await resp.json();
  const byName = new Map();
  for (const f of meta.fields || []) byName.set(f.name.toLowerCase(), f);
  return byName;
}

/** Mirrors sfFieldToColumn() in cache-sync and sf-query. Duplicated deliberately: a
 *  rename in one must fail visibly here rather than produce a column of nulls. */
function sfFieldToColumn(field) {
  let base = field.name.replace(/__c$/i, "").toLowerCase();
  if (field.type === "reference") base += "_sf_id";
  return base;
}

// --- Workbook ---------------------------------------------------------------
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
  if (!col[spec.apiCol]) throw new Error(`${spec.workbook}: no "${spec.apiCol}" column`);

  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cell = (name) => {
      if (!col[name]) return "";
      const v = row.getCell(col[name]).value;
      // A formula cell reads as { formula, result }; take the displayed result.
      if (v && typeof v === "object" && "result" in v) return String(v.result ?? "").trim();
      if (v && typeof v === "object" && "richText" in v) {
        return v.richText.map((t) => t.text).join("").trim();
      }
      return String(v ?? "").trim();
    };
    const apiName = cell(spec.apiCol);
    if (!apiName) continue;
    const entry = { rowNumber: r, apiName, section: cell(spec.sectionCol) };
    for (const role of ROLES) entry[role] = cell(role).toLowerCase();
    rows.push(entry);
  }
  return { rows, headers: Object.keys(col) };
}

// --- Build one object's manifest --------------------------------------------
const VALID = new Set(["hidden", "read", "edit"]);

async function buildManifest(spec) {
  const { rows, headers } = await readSheet(spec);
  const fields = await describe(spec.sfObject);

  const errors = [];
  const warnings = [];
  const roles = {};
  for (const role of ROLES) roles[role] = { read: [], edit: [] };

  // §4.1: roofing carries no role columns while the module is denied. If somebody adds
  // them, WARN rather than silently honour them — the module gate in lib/access.js is
  // what closes roofing, and a sheet cannot open it.
  if (!spec.roleColumns) {
    const added = ROLES.filter((r) => headers.includes(r));
    if (added.length > 0) {
      warnings.push(
        `${spec.key}: sheet now has ${added.join(" / ")} column(s), but roofing is denied ` +
          `to every sales scope by the MODULE gate (§3.1). The manifest stays all-hidden; ` +
          `open the module in lib/access.js first if that is the intent.`
      );
    }
  }

  for (const row of rows) {
    const def = fields.get(row.apiName.toLowerCase());
    if (!def) {
      warnings.push(
        `${spec.key} row ${row.rowNumber}: "${row.apiName}" is not a field on ` +
          `${spec.sfObject} — excluded from the manifest (planned field, or a typo)`
      );
      continue;
    }
    if (!spec.roleColumns) continue; // all-hidden by construction

    for (const role of ROLES) {
      const raw = row[role];
      const value = raw === "" ? "hidden" : raw;
      if (!VALID.has(value)) {
        errors.push(
          `${spec.key} row ${row.rowNumber} "${row.apiName}" [${role}]: ` +
            `"${raw}" is not hidden | read | edit`
        );
        continue;
      }
      if (value === "hidden") continue;
      if (value === "edit") {
        if (PROTECTED_FIELDS.has(def.name)) {
          errors.push(
            `${spec.key} row ${row.rowNumber} "${def.name}" [${role}]: PROTECTED field ` +
              `cannot be \`edit\` for a sales role (§3.4). It decides who owns the record.`
          );
          continue;
        }
        if (def.updateable !== true) {
          errors.push(
            `${spec.key} row ${row.rowNumber} "${def.name}" [${role}]: marked \`edit\` but ` +
              `Salesforce says updateable=false (${def.calculated ? "formula" : def.type}). ` +
              `The org would refuse the save.`
          );
          continue;
        }
        roles[role].edit.push(def.name);
      }
      // `edit` implies `read`: a field you may change is a field you may see. Kept as
      // two lists rather than one so the response can say which is which, but read
      // always contains the edit set -- a caller checking only `read` is never wrong.
      roles[role].read.push(def.name);
    }
  }

  // listColumns: the cache columns a role's list/search rows may carry (§4.2).
  const listColumns = {};
  for (const role of ROLES) {
    const cols = new Set(ALWAYS_LIST_COLUMNS);
    for (const name of roles[role].read) {
      const def = fields.get(name.toLowerCase());
      if (def) cols.add(sfFieldToColumn(def));
    }
    listColumns[role] = [...cols].sort();
  }

  for (const role of ROLES) {
    roles[role].read = [...new Set(roles[role].read)].sort();
    roles[role].edit = [...new Set(roles[role].edit)].sort();
  }

  // The version hashes the DECISIONS, not the file: re-saving the workbook without
  // changing a role value must not churn the version, or the client's "config out of
  // date" banner cries wolf on every spreadsheet touch.
  const payload = { object: spec.sfObject, roles, listColumns };
  const version =
    "sha256:" + crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);

  // The two committed copies must stay identical until the client generator moves
  // here; a silent divergence would mean the layout and the field rules describe
  // different sheets.
  const drift = warnIfClientCopyDrifted(spec);
  if (drift) warnings.push(drift);

  return { key: spec.key, manifest: { version, ...payload }, errors, warnings, rowCount: rows.length };
}

// --- Run --------------------------------------------------------------------
const results = [];
for (const spec of OBJECTS) results.push(await buildManifest(spec));

const allErrors = results.flatMap((r) => r.errors);
const allWarnings = results.flatMap((r) => r.warnings);

if (JSON_OUT) {
  console.log(JSON.stringify({ results, errors: allErrors, warnings: allWarnings }, null, 2));
  process.exit(allErrors.length === 0 ? 0 : 1);
}

rule();
log("FIELD MANIFEST GENERATOR — D-064 §4.1/§4.2");
rule();
for (const r of results) {
  log(`\n  ${r.key}  (${r.rowCount} sheet rows)`);
  for (const role of ROLES) {
    const m = r.manifest.roles[role];
    log(
      `    ${role.padEnd(13)} read ${String(m.read.length).padStart(3)}   ` +
        `edit ${String(m.edit.length).padStart(3)}   ` +
        `listColumns ${String(r.manifest.listColumns[role].length).padStart(3)}`
    );
  }
  log(`    version ${r.manifest.version}`);
}

if (allWarnings.length > 0) {
  rule("-");
  log(`WARNINGS — ${allWarnings.length}. Excluded from the manifest, not fatal.`);
  rule("-");
  for (const w of allWarnings) log(`  ${w}`);
}

if (allErrors.length > 0) {
  rule("-");
  log(`** ${allErrors.length} ERROR(S) — THE SHEET IS REFUSED (§4.1) **`);
  rule("-");
  for (const e of allErrors) log(`  ${e}`);
  log(
    "\n  Nothing was written. Fix the rows above in the workbook and re-run.\n" +
      "  These are refused at GENERATION time on purpose: every one of them would\n" +
      "  otherwise fail in front of a user, thousands of times a day."
  );
  process.exit(1);
}

if (!APPLY) {
  rule("-");
  log("REPORT ONLY — re-run with --apply to write lib/field-manifest/*.json");
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const r of results) {
  const file = path.join(OUT_DIR, `${r.key}.json`);
  fs.writeFileSync(file, JSON.stringify(r.manifest, null, 2) + "\n", "utf8");
  log(`  wrote ${path.relative(ROOT, file)}`);
}
log("\n  Done. The server reads these at cold start and REFUSES TO BOOT if one is");
log("  missing or malformed — a broken manifest must fail loudly, never serve unfiltered.");
