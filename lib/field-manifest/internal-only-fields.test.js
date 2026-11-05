// Internal-only Solar fields (2026-11-05): Extended_Install_Reason__c and
// PTO_Approved_Date__c are office fields. One test per role pins WHICH mechanism decides:
//
//   - Sales Rep / Sales Dealer: the Solar workbook's role columns say `hidden` (pinned by
//     scripts/apply-dealer-visibility.mjs OVERRIDES), so the generated manifest grants
//     neither field. The server then never SELECTs them, strips them from a record and a
//     list row, and refuses a write.
//   - Admin / Executive / Manager: tenant scope, so the manifest applies no restriction
//     (null); reads and edits follow the integration user's describe (both fields are
//     createable + updateable, checked live 2026-11-05).
//
// The scope comes from lib/access.js SCOPE_BY_ACCESS_LEVEL — the one place a level becomes a
// scope — so a level that moved to another scope would fail here, not in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCOPE_BY_ACCESS_LEVEL } from "../access.js";
import {
  fieldsFor,
  selectListFor,
  projectRecord,
  projectRow,
  listColumnsFor,
  canEditField,
  editableFor,
} from "./index.js";

const FIELDS = ["Extended_Install_Reason__c", "PTO_Approved_Date__c"];
const COLUMNS = ["extended_install_reason", "pto_approved_date"];
const as = (level) => ({ scope: SCOPE_BY_ACCESS_LEVEL[level], level });

for (const level of ["Sales Rep", "Sales Dealer"]) {
  test(`${level}: both fields are hidden by the field manifest (read, select, strip, list, write)`, () => {
    const access = as(level);
    assert.ok(["own", "dealer"].includes(access.scope), `${level} must be a sales scope`);

    const f = fieldsFor("solar", access);
    assert.ok(f, "a sales role gets a restriction, never null");
    for (const name of FIELDS) {
      assert.equal(f.read.has(name), false, `${name} readable by ${level}`);
      assert.equal(f.edit.has(name), false, `${name} editable by ${level}`);
      assert.equal(canEditField("solar", access, name), false);
    }
    assert.deepEqual(editableFor("solar", access).filter((n) => FIELDS.includes(n)), []);

    // Never fetched from Salesforce…
    const select = selectListFor("solar", access, ["Id", "Client__c", "Commission_of_System__c", ...FIELDS]);
    for (const name of FIELDS) assert.equal(select.includes(name), false);

    // …and stripped if a record or a cache row ever carried them.
    const rec = projectRecord("solar", access, {
      Id: "a1Q",
      Extended_Install_Reason__c: "Roof rework",
      PTO_Approved_Date__c: "2026-11-05",
    });
    for (const name of FIELDS) assert.equal(name in rec, false);

    const cols = listColumnsFor("solar", access);
    const row = projectRow("solar", access, { sf_id: "a1Q", extended_install_reason: "x", pto_approved_date: "2026-11-05" });
    for (const c of COLUMNS) {
      assert.equal(cols.has(c), false, `${c} in ${level} list columns`);
      assert.equal(c in row, false);
    }
  });
}

test("the Solar workbook says `hidden` for both sales roles on both rows (the manifest's source)", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/Sundial_Solar_Fields_by_Section.xlsx");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet("Fields by Section");
  const text = (v) => (v == null ? "" : typeof v === "string" ? v : v.richText ? v.richText.map((t) => t.text).join("") : String(v.text ?? v.result ?? v));
  const col = {};
  ws.getRow(1).eachCell((c, i) => (col[text(c.value).trim()] = i));
  const found = {};
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const api = text(row.getCell(col["API Name"]).value).trim();
    if (FIELDS.includes(api)) found[api] = [text(row.getCell(col["Sales Rep"]).value).trim(), text(row.getCell(col["Sales Dealer"]).value).trim()];
  }
  for (const name of FIELDS) assert.deepEqual(found[name], ["hidden", "hidden"], `${name} row`);
});

for (const level of ["Admin", "Executive", "Manager"]) {
  test(`${level}: tenant scope — the manifest does not restrict either field (read + write)`, () => {
    const access = as(level);
    assert.equal(access.scope, "tenant");
    assert.equal(fieldsFor("solar", access), null);
    assert.equal(selectListFor("solar", access, FIELDS), null); // caller's all-fields list
    for (const name of FIELDS) assert.equal(canEditField("solar", access, name), null); // describe decides
    const rec = { Id: "a1Q", Extended_Install_Reason__c: "Roof rework", PTO_Approved_Date__c: "2026-11-05" };
    assert.deepEqual(projectRecord("solar", access, rec), rec);
    const row = { sf_id: "a1Q", extended_install_reason: "x", pto_approved_date: "2026-11-05" };
    assert.deepEqual(projectRow("solar", access, row), row);
  });
}
