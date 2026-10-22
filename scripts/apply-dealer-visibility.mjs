// Apply Harmon's dealer-portal field visibility sheet to the two field-design workbooks.
// Dealer module step 0. docs/access-model.md §4.1a.
//
//   node scripts/apply-dealer-visibility.mjs                 # dry run: report only
//   node scripts/apply-dealer-visibility.mjs --apply         # write the two workbooks
//   node scripts/apply-dealer-visibility.mjs --sheet <path>  # a newer sheet from Harmon
//
// Then: node scripts/generate-field-configs.mjs --apply, and copy both workbooks to
// harmon-crm/docs/ (the generator warns on drift).
//
// ---------------------------------------------------------------------------
// WHAT THE SHEET MEANS
// ---------------------------------------------------------------------------
// Harmon's sheet has "Y" or blank under "Viewable by Sales Rep" / "Viewable by Dealer".
// It speaks ONLY for the fields it lists:
//
//   - listed, Y        -> `read`, or `edit` if the workbook already said `edit`.
//                         The sheet answers "may they SEE it"; whether they may change it
//                         stays the workbook's call, and this script never grants `edit`.
//   - listed, blank    -> `hidden`.
//   - NOT listed       -> unchanged. The sheet never hides a field it does not mention.
//                         (The first version hid them, and took Stage__c, the Solar
//                         name / address snapshot and every structural field with it.)
//   - listed twice with different answers -> the stricter one, reported. A field Harmon
//                         answered both ways is a question for Harmon, not a coin toss.
//   - an API name the workbook does not know -> reported and skipped. Never added: a row
//                         invented here would have no section, label or type.
//
// Then the Solar adder mirror (rule 7, SOLAR_MIRROR below) and OVERRIDES are applied on
// top, so the next sheet from Harmon can be re-applied without losing either.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

/**
 * Decisions made outside Harmon's sheet, applied AFTER it on every run.
 *
 * Commission fields (Tim, 2026-10-22): Ralph left these off the sheet by mistake. A dealer
 * sees what the deal pays them; a rep does not.
 *
 * `value` is `read` or `hidden` -- never `edit`, for the same reason the sheet never
 * grants it. A `read` here keeps an existing `edit`, like a Y on the sheet.
 */
const OVERRIDES = [
  { object: "customer", field: "Commission_Total__c", role: "Sales Dealer", value: "read" },
  { object: "customer", field: "Commission_Total__c", role: "Sales Rep", value: "hidden" },
  { object: "customer", field: "Commission_Total_PPW__c", role: "Sales Dealer", value: "read" },
  { object: "customer", field: "Commission_Total_PPW__c", role: "Sales Rep", value: "hidden" },
  { object: "customer", field: "Commission_Redline_PPW__c", role: "Sales Dealer", value: "read" },
  { object: "customer", field: "Commission_Redline_PPW__c", role: "Sales Rep", value: "hidden" },
  { object: "solar", field: "Commission_Total__c", role: "Sales Dealer", value: "read" },
  { object: "solar", field: "Commission_Total__c", role: "Sales Rep", value: "hidden" },
  { object: "solar", field: "Commission_Total_PPW__c", role: "Sales Dealer", value: "read" },
  { object: "solar", field: "Commission_Total_PPW__c", role: "Sales Rep", value: "hidden" },
  { object: "solar", field: "Commission_Redline_PPW__c", role: "Sales Dealer", value: "read" },
  { object: "solar", field: "Commission_Redline_PPW__c", role: "Sales Rep", value: "hidden" },
];

/**
 * Rule 7 — the Solar adder set takes the dealer's Customer answer (Tim, 2026-10-22).
 *
 * The dealer page's Pricing section shows the CUSTOMER's adders until
 * Linked_Solar_Project__c is set and the SOLAR's after (harmon-crm
 * src/config/customer-solar-mirror.ts). The audience must not change at that switch, so a
 * Solar field the mirror shows takes Harmon's Customer-side answer for the SAME API name
 * when that answer is Dealer-Y: `read` for Sales Dealer, and the Customer's own answer for
 * Sales Rep (blank -> hidden for every adder).
 *
 * The selection is the mirror config's own, read from the Solar workbook those configs
 * are generated from: the whole Adders and Commissions sections, Budget fields matching
 * ADDER_OUTPUT / ADDER_OUTPUT_EXTRA, plus Budget Inputs (named by Tim).
 *
 * ⚠️ THE DEALER-Y FILTER IS THE POINT. The mirror also shows Harmon's internal cost and
 * margin fields (Adder_*_Cost__c, the Budget roll-ups, every commission amount, the Budget
 * Inputs cost basis). Those carry no Customer-side Y, so they are left as the workbook says,
 * and the dry run lists them. A dealer never sees what Harmon pays.
 *
 * `extra`: price fields Tim named that have no Customer-side row on the sheet.
 */
const SOLAR_MIRROR = {
  sections: ["Adders", "Commissions", "Budget Inputs"],
  budgetSection: "Budget",
  ADDER_OUTPUT: /^(Std_Adder_|NS_Adder_|Adder_)/,
  ADDER_OUTPUT_EXTRA: ["Total_Adder_Cost__c", "Engineer_Stamps_Cost__c", "Subcontractor_Cost__c"],
  extra: ["Total_Adder_Price__c", "Battery_Unit_Price__c"],
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const APPLY = process.argv.includes("--apply");

/** The sheet as Harmon sent it (spaces in the name). The underscore spelling is accepted too. */
function sheetPath() {
  const i = process.argv.indexOf("--sheet");
  if (i !== -1) return path.resolve(process.argv[i + 1] ?? "");
  const spaced = path.join(DOCS, "Dealer Portal Field Visibility from Harmon.xlsx");
  const underscored = path.join(DOCS, "Dealer_Portal_Field_Visibility_from_Harmon.xlsx");
  return fs.existsSync(spaced) ? spaced : underscored;
}

/** Harmon's sheet column -> the workbook's role column. */
const ROLE_COLUMNS = {
  "Viewable by Sales Rep": "Sales Rep",
  "Viewable by Dealer": "Sales Dealer",
};
const ROLES = Object.values(ROLE_COLUMNS);

/**
 * Which object a sheet section belongs to. A section not listed here is an ERROR: guessing
 * the object for an authorization input is how a field ends up visible on the wrong one.
 */
const SECTION_OBJECT = {
  "Contact & Household": "customer",
  "Property & Site": "customer",
  "Lead & Source": "customer",
  "Utility Company": "customer",
  "Contract & Financing": "customer",
  "Project Routing": "customer",
  "Budget Inputs": "customer",
  "Adders": "customer",
  "Customer/Site Details": "solar",
  "Audit": "solar",
  "Roofing": "solar",
  "Design/Engineering": "solar",
  "PM/NTP/Adder Review": "solar",
  "Permitting": "solar",
  "Utility": "solar",
  "HOA": "solar",
  "Installation": "solar",
  "Post Install/PTO": "solar",
};

const WORKBOOKS = {
  customer: { file: "Sundial_Customer__c_Field_Design.xlsx", sheet: "Fields by Section", sectionCol: "Sundial Section" },
  solar: { file: "Sundial_Solar_Fields_by_Section.xlsx", sheet: "Fields by Section", sectionCol: "Section" },
};

const STRICTNESS = { hidden: 0, read: 1, edit: 2 };

function cellText(v) {
  if (v && typeof v === "object" && "result" in v) return String(v.result ?? "").trim();
  if (v && typeof v === "object" && "richText" in v) return v.richText.map((t) => t.text).join("").trim();
  return String(v ?? "").trim();
}

function headerMap(ws) {
  const col = {};
  ws.getRow(1).eachCell({ includeEmpty: false }, (c, n) => {
    col[cellText(c.value)] = n;
  });
  return col;
}

// --- Harmon's sheet -> { object: Map(lowerApi -> { apiName, Sales Rep, Sales Dealer }) } ---
async function readHarmonSheet(file) {
  if (!fs.existsSync(file)) throw new Error(`Harmon sheet missing: ${file}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet("Sheet1");
  if (!ws) throw new Error(`${path.basename(file)}: no sheet named "Sheet1"`);
  const col = headerMap(ws);
  for (const name of ["Section", "API Name", ...Object.keys(ROLE_COLUMNS)]) {
    if (!col[name]) throw new Error(`${path.basename(file)}: no "${name}" column`);
  }

  const errors = [];
  const byObject = { customer: new Map(), solar: new Map() };
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const apiName = cellText(row.getCell(col["API Name"]).value);
    if (!apiName) continue;
    const section = cellText(row.getCell(col["Section"]).value);
    const object = SECTION_OBJECT[section];
    if (!object) {
      errors.push(`sheet row ${r} "${apiName}": section "${section}" is not mapped to an object`);
      continue;
    }
    const answers = {};
    for (const [sheetCol, role] of Object.entries(ROLE_COLUMNS)) {
      const raw = cellText(row.getCell(col[sheetCol]).value).toUpperCase();
      if (raw !== "" && raw !== "Y") {
        errors.push(`sheet row ${r} "${apiName}" [${sheetCol}]: "${raw}" is not Y or blank`);
      }
      answers[role] = raw === "Y";
    }
    const key = apiName.toLowerCase();
    const entry = byObject[object].get(key) ?? { apiName, occurrences: [] };
    entry.occurrences.push({ row: r, section, ...answers });
    byObject[object].set(key, entry);
  }

  // Rule 3: listed more than once with different answers -> the stricter (Y only if every
  // occurrence says Y), and named in the report.
  const conflicts = [];
  for (const [object, map] of Object.entries(byObject)) {
    for (const entry of map.values()) {
      for (const role of ROLES) {
        const answers = entry.occurrences.map((o) => o[role]);
        entry[role] = answers.every(Boolean);
        if (new Set(answers).size > 1) {
          conflicts.push(
            `${object} ${entry.apiName} [${role}]: ` +
              entry.occurrences.map((o) => `row ${o.row} ${o.section} = ${o[role] ? "Y" : "blank"}`).join(", ") +
              " -> hidden (stricter)"
          );
        }
      }
    }
  }
  return { byObject, conflicts, errors };
}

// --- One workbook ----------------------------------------------------------------
async function loadWorkbook(object) {
  const spec = WORKBOOKS[object];
  const file = path.join(DOCS, spec.file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(spec.sheet);
  if (!ws) throw new Error(`${spec.file}: no sheet named "${spec.sheet}"`);
  const col = headerMap(ws);
  for (const name of ["API Name", spec.sectionCol, ...ROLES]) {
    if (!col[name]) throw new Error(`${spec.file}: no "${name}" column`);
  }
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const apiName = cellText(row.getCell(col["API Name"]).value);
    if (!apiName) continue;
    const section = cellText(row.getCell(col[spec.sectionCol]).value);
    const entry = { row: r, apiName, section, before: {}, after: {}, why: {} };
    for (const role of ROLES) {
      const v = cellText(row.getCell(col[role]).value).toLowerCase();
      entry.before[role] = v === "" ? "hidden" : v;
    }
    rows.push(entry);
  }
  return { file, wb, ws, col, rows };
}

/** Per role, counts by the value the GENERATOR would see: one per field, the widest row wins. */
function counts(rows, which) {
  const out = {};
  for (const role of ROLES) {
    const best = new Map();
    for (const r of rows) {
      const v = r[which][role];
      const k = r.apiName.toLowerCase();
      if (!best.has(k) || (STRICTNESS[v] ?? -1) > (STRICTNESS[best.get(k)] ?? -1)) best.set(k, v);
    }
    const c = { read: 0, edit: 0, hidden: 0, other: 0 };
    for (const v of best.values()) c[v in c ? v : "other"]++;
    out[role] = c;
  }
  return out;
}

function applyToObject(object, sheetFields, wbk, mirrorRows) {
  const unknown = [];
  const known = new Set(wbk.rows.map((r) => r.apiName.toLowerCase()));
  for (const [key, entry] of sheetFields) {
    if (!known.has(key)) {
      unknown.push(`${object} ${entry.apiName} (sheet row ${entry.occurrences.map((o) => o.row).join(", ")})`);
    }
  }

  // Rules 1 and A: a listed field is the sheet's answer; an unlisted one is left alone.
  for (const r of wbk.rows) {
    const s = sheetFields.get(r.apiName.toLowerCase());
    for (const role of ROLES) {
      if (!s) {
        r.after[role] = r.before[role];
        r.why[role] = "not on sheet, kept";
      } else if (s[role]) {
        r.after[role] = r.before[role] === "edit" ? "edit" : "read";
        r.why[role] = "sheet Y";
      } else {
        r.after[role] = "hidden";
        r.why[role] = "sheet blank";
      }
    }
  }

  // Rule 7, then rule 6: the mirror rows, then OVERRIDES last so Tim's table always wins.
  const overrideMisses = [];
  for (const o of [...mirrorRows, ...OVERRIDES].filter((x) => x.object === object)) {
    if (!["read", "hidden"].includes(o.value) || !ROLES.includes(o.role)) {
      throw new Error(`OVERRIDES: ${JSON.stringify(o)} -- value must be read|hidden and role one of ${ROLES.join(", ")}`);
    }
    const hits = wbk.rows.filter((r) => r.apiName.toLowerCase() === o.field.toLowerCase());
    if (hits.length === 0) {
      overrideMisses.push(`${object} ${o.field} [${o.role}]: not in the workbook -- override skipped`);
      continue;
    }
    for (const r of hits) {
      r.after[o.role] = o.value === "read" && r.before[o.role] === "edit" ? "edit" : o.value;
      r.why[o.role] = o.source ?? "OVERRIDE";
    }
  }
  return { unknown, overrideMisses };
}

/**
 * Rule 7: the Solar mirror fields, split into the ones that take the dealer's Customer
 * answer (`rows`, in OVERRIDES shape) and the ones the filter leaves alone (`excluded`).
 */
function deriveSolarMirror(solarRows, customerSheetFields) {
  const shown = new Map();
  for (const r of solarRows) {
    const inMirror =
      SOLAR_MIRROR.sections.includes(r.section) ||
      (r.section === SOLAR_MIRROR.budgetSection &&
        (SOLAR_MIRROR.ADDER_OUTPUT.test(r.apiName) || SOLAR_MIRROR.ADDER_OUTPUT_EXTRA.includes(r.apiName)));
    if (inMirror && !shown.has(r.apiName.toLowerCase())) shown.set(r.apiName.toLowerCase(), r);
  }
  const extra = new Set(SOLAR_MIRROR.extra.map((f) => f.toLowerCase()));
  const included = [];
  const excluded = [];
  for (const [key, r] of shown) {
    const dealerY = customerSheetFields.get(key)?.["Sales Dealer"] === true;
    (dealerY || extra.has(key) ? included : excluded).push(`${r.apiName} (${r.section}${dealerY ? "" : extra.has(key) ? ", named by Tim" : ""})`);
  }
  const missingExtra = SOLAR_MIRROR.extra.filter((f) => !shown.has(f.toLowerCase()));
  // Each role copies the Customer answer, not a fixed one: for the adders that IS dealer
  // read / rep hidden, but Budget Inputs drags in Contract_Amount__c, which Harmon gave the
  // rep too -- a fixed "rep hidden" would take it off the rep's Solar page.
  const rows = included.flatMap((label) => {
    const field = label.split(" ")[0];
    const rep = customerSheetFields.get(field.toLowerCase())?.["Sales Rep"] === true;
    return [
      { object: "solar", field, role: "Sales Dealer", value: "read", source: "RULE 7 mirror" },
      { object: "solar", field, role: "Sales Rep", value: rep ? "read" : "hidden", source: "RULE 7 mirror" },
    ];
  });
  return { rows, included, excluded, missingExtra };
}

// --- Run ---------------------------------------------------------------------------
const line = (c = "=") => console.log(c.repeat(100));
const sheetFile = sheetPath();
const harmon = await readHarmonSheet(sheetFile);

line();
console.log("DEALER-PORTAL VISIBILITY — Harmon's sheet + rule 7 mirror + OVERRIDES -> workbook role columns");
console.log(`  sheet: ${path.relative(ROOT, sheetFile)}`);
line();

if (harmon.errors.length > 0) {
  console.log(`\n** ${harmon.errors.length} ERROR(S) in Harmon's sheet — nothing applied **`);
  for (const e of harmon.errors) console.log(`  ${e}`);
  process.exit(1);
}

const workbooks = {};
for (const object of Object.keys(WORKBOOKS)) workbooks[object] = await loadWorkbook(object);
const mirror = deriveSolarMirror(workbooks.solar.rows, harmon.byObject.customer);

const results = {};
for (const object of Object.keys(WORKBOOKS)) {
  const wbk = workbooks[object];
  const { unknown, overrideMisses } = applyToObject(object, harmon.byObject[object], wbk, mirror.rows);
  results[object] = { wbk, unknown, overrideMisses };

  const before = counts(wbk.rows, "before");
  const after = counts(wbk.rows, "after");
  console.log(`\n  ${object}  (${WORKBOOKS[object].file}, ${wbk.rows.length} rows, ${harmon.byObject[object].size} fields on the sheet)`);
  for (const role of ROLES) {
    const b = before[role];
    const a = after[role];
    const fmt = (c) => `read ${String(c.read).padStart(3)}  edit ${String(c.edit).padStart(3)}  hidden ${String(c.hidden).padStart(3)}${c.other ? `  OTHER ${c.other}` : ""}`;
    console.log(`    ${role.padEnd(13)} before  ${fmt(b)}`);
    console.log(`    ${"".padEnd(13)} after   ${fmt(a)}`);
  }

  const changes = [];
  for (const r of wbk.rows) {
    for (const role of ROLES) {
      if (r.before[role] !== r.after[role]) {
        changes.push(`    row ${String(r.row).padStart(3)}  ${r.apiName.padEnd(48)} ${role.padEnd(13)} ${r.before[role].padEnd(6)} -> ${r.after[role].padEnd(6)} (${r.why[role]})`);
      }
    }
  }
  console.log(`\n    ${changes.length} cell change(s):`);
  for (const c of changes) console.log(c);
  for (const source of ["RULE 7 mirror", "OVERRIDE"]) {
    const hits = wbk.rows.flatMap((r) =>
      ROLES.filter((role) => r.why[role] === source).map((role) => `    row ${r.row} ${r.apiName} [${role}] = ${r.after[role]}`)
    );
    if (hits.length === 0) continue;
    console.log(`\n    ${source} applied (${hits.length}):`);
    for (const o of hits) console.log(o);
  }
}

line("-");
console.log(`Rule 3 — listed more than once with different answers (${harmon.conflicts.length}):`);
for (const c of harmon.conflicts) console.log(`  ${c}`);
const unknown = Object.values(results).flatMap((r) => r.unknown);
console.log(`\nRule 4 — on the sheet but not in the workbook, SKIPPED (${unknown.length}):`);
for (const u of unknown) console.log(`  ${u}`);
console.log(`\nRule 7 — Solar mirror fields that take the dealer's Customer answer (${mirror.included.length}):`);
for (const m of mirror.included) console.log(`  ${m}`);
console.log(
  `\nRule 7 — Solar mirror fields LEFT AS THE WORKBOOK SAYS (no Customer-side Dealer Y: internal cost / commission) (${mirror.excluded.length}):`
);
for (const m of mirror.excluded) console.log(`  ${m}`);
if (mirror.missingExtra.length > 0) {
  console.log(`\nRule 7 — named extras not in the Solar mirror: ${mirror.missingExtra.join(", ")}`);
}
const misses = Object.values(results).flatMap((r) => r.overrideMisses);
if (misses.length > 0) {
  console.log(`\nOVERRIDES that matched no workbook row (${misses.length}):`);
  for (const m of misses) console.log(`  ${m}`);
}
line("-");

if (!APPLY) {
  console.log("DRY RUN — re-run with --apply to write the two workbooks.");
  process.exit(0);
}

for (const { wbk } of Object.values(results)) {
  for (const r of wbk.rows) {
    for (const role of ROLES) {
      if (r.before[role] !== r.after[role]) wbk.ws.getRow(r.row).getCell(wbk.col[role]).value = r.after[role];
    }
  }
  await wbk.wb.xlsx.writeFile(wbk.file);
  console.log(`  wrote ${path.relative(ROOT, wbk.file)}`);
}
console.log("\n  Next: node scripts/generate-field-configs.mjs --apply, then copy both workbooks to harmon-crm/docs/.");
