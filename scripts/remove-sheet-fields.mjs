// Remove field rows from the field-design workbooks — D-090 (Solar field cleanup, 2026-11).
//
//   node scripts/remove-sheet-fields.mjs salesforce/solar-field-cleanup-2026-11/fields.json           # dry run
//   node scripts/remove-sheet-fields.mjs salesforce/solar-field-cleanup-2026-11/fields.json --apply   # write
//
// WHY: the sheets are what the generators read (portal page configs, the field manifest,
// the report catalog). A field leaves the portal by leaving the sheet, never by a
// hand-edit to a generated file.
//
// A row is removed ONLY when its "API Name" cell is exactly one of the listed fields.
// Any other row that merely MENTIONS a listed field (a description, a formula note) is
// reported and left alone — a person decides those.
//
// After writing, each workbook is re-read and checked: exactly the planned rows gone,
// every other row's API name still there in the same order. Any mismatch exits 1.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKBOOKS = [
  "docs/Sundial_Solar_Fields_by_Section.xlsx",
  "docs/Dealer Portal Field Visibility from Harmon.xlsx",
  "docs/Sundial_Solar_Budget_Fields.xlsx",
];

const [listFile, ...flags] = process.argv.slice(2);
if (!listFile) {
  console.error("usage: node scripts/remove-sheet-fields.mjs <fields.json> [--apply]");
  process.exit(2);
}
const apply = flags.includes("--apply");
const { fields } = JSON.parse(fs.readFileSync(path.resolve(ROOT, listFile), "utf8"));
const targets = new Set(fields.map((f) => f.toLowerCase()));

const text = (v) =>
  v == null ? "" : typeof v === "string" ? v : v.richText ? v.richText.map((t) => t.text).join("") : String(v.text ?? v.result ?? v);

/** Per sheet: the API-name column, and every row's API name (rowNumber -> name). */
function apiColumn(ws) {
  for (let r = 1; r <= Math.min(ws.rowCount, 5); r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= row.cellCount; c++) {
      if (/^api\s*name$/i.test(text(row.getCell(c).value).trim())) return { headerRow: r, col: c };
    }
  }
  return null;
}
function apiNames(ws, loc) {
  const out = [];
  for (let r = loc.headerRow + 1; r <= ws.rowCount; r++) out.push(text(ws.getRow(r).getCell(loc.col).value).trim());
  return out;
}

let failed = false;
for (const rel of WORKBOOKS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const plan = [];
  wb.eachSheet((ws) => {
    const loc = apiColumn(ws);
    if (!loc) return;
    const remove = [];
    const mentions = [];
    for (let r = loc.headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const api = text(row.getCell(loc.col).value).trim();
      if (targets.has(api.toLowerCase())) {
        remove.push({ r, api });
        continue;
      }
      row.eachCell((cell) => {
        for (const tok of text(cell.value).match(/[A-Za-z0-9_]+__c/gi) ?? []) {
          if (targets.has(tok.toLowerCase())) mentions.push({ r, api, tok });
        }
      });
    }
    plan.push({ ws, loc, remove, mentions, before: apiNames(ws, loc) });
  });

  for (const p of plan) {
    console.log(`${rel} [${p.ws.name}]: ${p.remove.length} row(s) to remove${p.remove.length ? " — " + p.remove.map((x) => `${x.r}:${x.api}`).join(", ") : ""}`);
    for (const m of p.mentions) console.log(`  left alone: row ${m.r} (${m.api}) mentions ${m.tok}`);
  }
  if (!apply || plan.every((p) => p.remove.length === 0)) continue;

  // Bottom-up so earlier row numbers stay valid.
  for (const p of plan) for (const x of [...p.remove].sort((a, b) => b.r - a.r)) p.ws.spliceRows(x.r, 1);
  await wb.xlsx.writeFile(file);

  // Verify by re-reading from disk.
  const check = new ExcelJS.Workbook();
  await check.xlsx.readFile(file);
  for (const p of plan) {
    const ws = check.getWorksheet(p.ws.name);
    const after = apiNames(ws, p.loc);
    const removedRows = new Set(p.remove.map((x) => x.r - p.loc.headerRow - 1));
    const expected = p.before.filter((_, i) => !removedRows.has(i));
    // Trailing blank rows are not content; compare without them.
    const trim = (a) => { const b = [...a]; while (b.length && b[b.length - 1] === "") b.pop(); return b; };
    const ok = JSON.stringify(trim(after)) === JSON.stringify(trim(expected)) && !after.some((a) => targets.has(a.toLowerCase()));
    console.log(`  verify ${p.ws.name}: ${ok ? "OK" : "MISMATCH"} (${trim(p.before).length} -> ${trim(after).length} rows)`);
    if (!ok) failed = true;
  }
}
if (!apply) console.log("\nDry run. Re-run with --apply to write.");
process.exit(failed ? 1 : 0);
