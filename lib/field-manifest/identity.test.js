// The identity rule, on BOTH surfaces, from ONE list.
// D-064, docs/access-model.md §4.2, §4.3. See ./identity.js for the why.
//
// These tests exist because the rule was fixed once, on lists only, and the detail page
// stayed broken for two weeks — the manifest was right, `listColumns` carried
// `project_name`, every leak assertion was green, and a dealer still opened a Solar
// project whose header said "—". A leak test cannot see a NARROW answer, so the
// assertions here are all of the form "this field IS present", which is the opposite
// shape of everything else in the manifest suite.

import test from "node:test";
import assert from "node:assert/strict";

import {
  fieldsFor,
  listColumnsFor,
  selectListFor,
  projectRecord,
  editableFor,
  MANIFESTS,
} from "./index.js";
import { IDENTITY, identityFields, identityColumns } from "./identity.js";

const REP = { scope: "own", level: "Sales Rep" };
const DEALER = { scope: "dealer", level: "Sales Dealer" };
const TENANT = { scope: "tenant", level: "Admin" };
const NONE = { scope: "none", level: "Technician" };
const SALES = [
  ["Sales Rep", REP],
  ["Sales Dealer", DEALER],
];

// --- the list itself --------------------------------------------------------

test("every identity element carries BOTH spellings", () => {
  for (const [key, elements] of Object.entries(IDENTITY)) {
    assert.ok(elements.length > 0, `${key}: empty identity list`);
    for (const e of elements) {
      assert.equal(typeof e.field, "string", `${key}: missing SF field name`);
      assert.equal(typeof e.column, "string", `${key}: missing cache column`);
      assert.ok(e.field && e.column, `${key}: blank spelling on ${JSON.stringify(e)}`);
    }
  }
});

test("every manifest object has an identity entry", () => {
  // A new object added to MANIFESTS without one would be legible nowhere, which is the
  // failure this whole module exists to make impossible.
  for (const key of Object.keys(MANIFESTS)) {
    assert.ok(IDENTITY[key], `${key} is in MANIFESTS but has no identity entry`);
  }
});

// --- surface 1: the detail read (?full=true) --------------------------------

test("fieldsFor grants the identity fields to every sales role", () => {
  for (const [key] of Object.entries(IDENTITY)) {
    for (const [label, access] of SALES) {
      const f = fieldsFor(key, access);
      for (const name of identityFields(key)) {
        assert.ok(f.read.has(name), `${key} / ${label}: ${name} missing from read`);
      }
    }
  }
});

test("Project_Name__c reaches the Solar ?full=true SELECT — the 2026-09-15 bug", () => {
  // The regression, stated as the exact call the Lambda makes. `Project_Name__c` has no
  // row in Sundial_Solar_Fields_by_Section.xlsx, so the sheet alone will never put it
  // here; if this fails, the detail header is blank for every sales role again.
  for (const [label, access] of SALES) {
    const all = ["Id", "Client__c", "Project_Name__c", "Stage__c", "Commission_Total__c"];
    const select = selectListFor("solar", access, all);
    assert.ok(select.includes("Project_Name__c"), `${label}: SELECT has no name column`);
  }
});

test("the identity field survives projectRecord", () => {
  // Belt-and-braces strip runs after the SELECT. If it dropped the name the response
  // would be nameless even with a correct query.
  const rec = { Id: "a1Q", Client__c: "a1W", Project_Name__c: "Smith — 8.4kW" };
  for (const [label, access] of SALES) {
    const out = projectRecord("solar", access, rec);
    assert.equal(out.Project_Name__c, "Smith — 8.4kW", `${label}: name stripped`);
  }
});

test("identity is READ, never EDIT", () => {
  // Naming a record is a read. Renaming it is a sheet decision, and Project_Name__c is a
  // formula on Solar anyway — promising an edit would produce a save the org refuses.
  for (const key of Object.keys(IDENTITY)) {
    for (const [label, access] of SALES) {
      const editable = new Set(editableFor(key, access));
      const sheetEdit = new Set(MANIFESTS[key].roles[access.level].edit);
      for (const name of identityFields(key)) {
        if (sheetEdit.has(name)) continue; // the SHEET granted it; that is its call
        assert.ok(!editable.has(name), `${key} / ${label}: ${name} became editable`);
      }
    }
  }
});

// --- surface 2: list rows ---------------------------------------------------

test("listColumnsFor carries the identity columns for every sales role", () => {
  for (const key of Object.keys(IDENTITY)) {
    for (const [label, access] of SALES) {
      const cols = listColumnsFor(key, access);
      for (const c of identityColumns(key)) {
        assert.ok(cols.has(c), `${key} / ${label}: ${c} missing from listColumns`);
      }
    }
  }
});

test("the generated manifest ALREADY carries the identity columns", () => {
  // The runtime union above would mask a stale manifest, so assert the JSON separately.
  // A failure here means the workbook moved and nobody re-ran generate-field-configs —
  // the deployed behaviour is still correct, but the two have started to drift.
  for (const [key, m] of Object.entries(MANIFESTS)) {
    for (const role of ["Sales Rep", "Sales Dealer"]) {
      const cols = new Set(m.listColumns[role] ?? []);
      const have = identityColumns(key).filter((c) => cols.has(c));
      assert.ok(
        have.length > 0,
        `${key} / ${role}: generated listColumns names the row via none of ` +
          `[${identityColumns(key).join(", ")}] — re-run scripts/generate-field-configs.mjs`
      );
    }
  }
});

// --- the scopes the union must NOT touch ------------------------------------

test("tenant scope stays unrestricted (null), not a set containing the name", () => {
  for (const key of Object.keys(IDENTITY)) {
    assert.equal(fieldsFor(key, TENANT), null, `${key}: tenant scope got a restriction`);
    assert.equal(listColumnsFor(key, TENANT), null, `${key}: tenant list got a restriction`);
    assert.equal(selectListFor(key, TENANT, ["Id", "Project_Name__c"]), null);
  }
});

test("scope `none` and an unknown level stay EMPTY — the union grants them nothing", () => {
  // The rule is "a record the role is ENTITLED TO SEE arrives legible". An unresolvable
  // entitlement is not an entitlement, so the fail-closed empty set stays empty.
  const unknownLevel = { scope: "own", level: "Field Marketer" };
  for (const key of Object.keys(IDENTITY)) {
    assert.equal(fieldsFor(key, NONE), null, `${key}: scope none is not a sales role`);
    const f = fieldsFor(key, unknownLevel);
    assert.equal(f.read.size, 0, `${key}: unknown level gained ${[...f.read].join(", ")}`);
    assert.equal(listColumnsFor(key, unknownLevel).size, 0, `${key}: unknown level gained columns`);
  }
});

test("an object with no identity entry is unaffected", () => {
  // `commercial`, `po`, service — denied to sales scopes and absent from MANIFESTS.
  // identityFields must answer [] rather than throw, or every caller needs a guard.
  assert.deepEqual(identityFields("commercial"), []);
  assert.deepEqual(identityColumns("nope"), []);
});
