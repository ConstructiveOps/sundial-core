// Tests for sundial-acumatica-budget-push — MAPPING_ROWS v3 and the write-path rules.
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// This Lambda had no tests. It now writes real money into Acumatica, and the v3 rewrite
// changed what half the rows read, so the things pinned here are the ones that would
// silently post a WRONG NUMBER rather than fail:
//
//   - GENO is ONE row (v1's three would double-count CO fee + permit)
//   - GENA reads one field (v1's sum would double-count QA)
//   - SLMC reads the combined amount, not the two components as well
//   - the setter line reads what APPLIED, not the always-70 input rate
//   - a deal with both rep amounts refuses instead of paying twice
//   - a DC rebate with no harvested key refuses instead of dropping the income
//
// Plus the v1 safety rules the rewrite had to preserve: exact-one-match, skip-zero on
// expense only, income always written, fail-loud on 0 scaffold lines.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const ctx = {
  lines: [],
  puts: [],
  putStatus: 200,
};

mock.module("../../lib/acumatica.js", {
  exports: {
    getAcumaticaEntity: async () => ({ ok: true, status: 200, data: ctx.lines }),
    putAcumaticaEntity: async (_entity, body) => {
      ctx.puts.push(body);
      return { ok: ctx.putStatus < 400, status: ctx.putStatus, text: "" };
    },
  },
});
mock.module("../../lib/salesforce.js", {
  exports: {
    sfQuery: async () => [],
    soqlEscapeString: (v) => String(v),
    sfUpdateRecord: async () => ({ ok: true }),
  },
});

const mod = await import("./index.js");
const { MAPPING_ROWS, PENDING_HARVEST_ROWS, budgetFieldNames, matchMappingToLines, naturalKey, writeBudgetLines } = mod;

/**
 * A scaffold line in the RAW Acumatica shape, which is what the stubbed
 * getAcumaticaEntity must return — readProjectBudgetLines does the ProjectTaskID ->
 * taskId mapping itself, so handing it pre-mapped objects silently produces undefined
 * keys and every row "fails to match". (That is exactly what the first run of this
 * suite did, which is a decent argument for the stub sitting at the real boundary.)
 */
const rawScaffoldFor = (row) => ({
  id: `guid-${row.taskId}-${row.accountGroup}-${row.inventoryId}-${row.type}`,
  ProjectTaskID: { value: row.taskId },
  AccountGroup: { value: row.accountGroup },
  InventoryID: { value: row.inventoryId },
  Type: { value: row.type },
  UOM: { value: row.hoursField ? "HOUR" : null },
  Description: { value: row.line },
  OriginalBudgetedAmount: { value: 0 },
  OriginalBudgetedQty: { value: 0 },
});

/** RAW scaffold for the Acumatica stub: exactly one line per distinct mapping key. */
function rawScaffold() {
  const seen = new Map();
  for (const r of MAPPING_ROWS) if (!seen.has(naturalKey(r))) seen.set(naturalKey(r), rawScaffoldFor(r));
  return [...seen.values()];
}

/** MAPPED scaffold, for the matchMappingToLines tests which take that shape directly. */
function fullScaffold() {
  const seen = new Map();
  for (const r of MAPPING_ROWS) {
    const k = naturalKey(r);
    if (!seen.has(k)) {
      seen.set(k, {
        id: `guid-${k}`,
        taskId: r.taskId, accountGroup: r.accountGroup, inventoryId: r.inventoryId,
        type: r.type, uom: r.hoursField ? "HOUR" : null, key: k,
      });
    }
  }
  return [...seen.values()];
}

/** Budget values matching the REVISED fixture (third-party deal, no DC rebate). */
const VALUES = {
  Contract_Amount__c: 36502,
  Total_Material_Budget__c: 16140.73,
  Sales_Rep_Commission_Amt__c: 2200,
  Internal_Rep_Commission_Amt__c: 0,
  Management_Commission_Amt__c: 484,
  Setter_Commission_Amt__c: 70,
  Commission_Burden_Amt__c: 415.5,
  Audit_Labor_Cost__c: 113,
  GENA_Hours__c: 4,
  Roofing_Labor_Cost__c: 735,
  S1_Labor_Cost__c: 753.3333333333333, S1_Hours__c: 26.666666666666664,
  S2_Labor_Cost__c: 376.6666666666667, S2_Hours__c: 13.333333333333334,
  S3_Labor_Cost__c: 627, S3_Hours__c: 19,
  Total_Labor_Burden_Budget__c: 1953.75,
  Total_Other_Budget__c: 2550,
  Dealer_Fee__c: 0,
  Engineer_Stamps_Cost__c: 250,
  Subcontractor_Cost__c: 528,
  Adder_Software_Fee_Price__c: 30, Adder_Software_Fee_Qty__c: 1,
  Adder_Referral_Fee_Price__c: 500, Adder_Referral_Fee_Qty__c: 1,
  DC_Rebate_Amount__c: 0,
  // Only budgetCalc v2 writes this; its presence is the rollout guard's v2 marker.
  Commission_Deal_Type__c: "3rd Party",
};

function reset() {
  ctx.lines = rawScaffold();
  ctx.puts = [];
  ctx.putStatus = 200;
}

const rowsFor = (taskId, accountGroup) =>
  MAPPING_ROWS.filter((r) => r.taskId === taskId && (accountGroup === undefined || r.accountGroup === accountGroup));

// ===========================================================================
// Shape of the v3 mapping
// ===========================================================================

test("every mapping row has a complete 4-part key and an amount source", () => {
  for (const r of MAPPING_ROWS) {
    for (const part of ["taskId", "accountGroup", "inventoryId", "type"]) {
      assert.ok(r[part], `${r.line} is missing ${part}`);
    }
    assert.ok(r.amountField, `${r.line} has no amountField`);
    assert.ok(["harvested", "provisional", "harvested_absent"].includes(r.keyStatus), `${r.line} keyStatus`);
  }
});

test("the four v3 commission lines exist, each with ONE source", () => {
  const thirdParty = MAPPING_ROWS.find((r) => r.line === "3rd Party Rep Commission");
  const internal = MAPPING_ROWS.find((r) => r.line === "Internal Rep Commission");
  const mgmt = MAPPING_ROWS.find((r) => r.line === "Management Commission");
  const setter = MAPPING_ROWS.find((r) => r.line === "Setter Commission");

  assert.equal(thirdParty.amountField, "Sales_Rep_Commission_Amt__c");
  assert.equal(naturalKey(thirdParty), "SLPC OUT | OTHER | M1&M2COM | Expense");
  assert.equal(internal.amountField, "Internal_Rep_Commission_Amt__c");
  assert.equal(naturalKey(internal), "SLPC | LABOR | SALESCOMM | Expense");
  assert.equal(naturalKey(mgmt), "SLMC | LABOR | SALESCOMM | Expense");
  assert.equal(naturalKey(setter), "APPT COM | LABOR | SALESCOMM | Expense");

  // The two rep lines are DIFFERENT keys — that is the whole point of D16.
  assert.notEqual(naturalKey(thirdParty), naturalKey(internal));
});

test("SLMC reads the COMBINED management amount, not the two components as well", () => {
  const slmc = rowsFor("SLMC");
  assert.equal(slmc.length, 1, "SLMC must be one row");
  assert.equal(slmc[0].amountField, "Management_Commission_Amt__c");
  // Adding the components here would double the line.
  const all = MAPPING_ROWS.map((r) => r.amountField).join(" ");
  assert.ok(!all.includes("Sales_Mgr_Commission_Amt__c"), "mgr component must not be mapped");
  assert.ok(!all.includes("Overhead_Commission_Amt__c"), "overhead component must not be mapped");
});

test("the setter line reads what APPLIED, never the always-70 input rate", () => {
  const setter = MAPPING_ROWS.find((r) => r.line === "Setter Commission");
  assert.equal(setter.amountField, "Setter_Commission_Amt__c");
  const all = MAPPING_ROWS.map((r) => r.amountField).join(" ");
  assert.ok(!all.includes("Geo_Commission_Amount__c"), "v1 mapped the INPUT rate — it would post 70 on every job");
});

test("GENO is ONE row — v1's three would double-count CO fee and permit", () => {
  const geno = rowsFor("GENO");
  assert.equal(geno.length, 1, `expected 1 GENO row, got ${geno.length}: ${geno.map((r) => r.line)}`);
  assert.equal(geno[0].amountField, "Total_Other_Budget__c");
  const all = MAPPING_ROWS.map((r) => r.amountField).join(" ");
  assert.ok(!all.includes("Constructive_Ops_Fee__c"), "CO fee is already inside Total_Other_Budget__c");
  assert.ok(!all.includes("Permit_Pass_Through_Cost__c"), "permit is already inside Total_Other_Budget__c");
  // And it must NOT be the summary figure, which also contains the standalone lines.
  assert.ok(!all.includes("Total_Other_Summary__c"), "N13 includes the four standalone lines — would double-count them");
});

test("GENA reads the combined audit+QA field — v1's sum would double-count QA", () => {
  const gena = rowsFor("GENA");
  assert.equal(gena.length, 1);
  assert.equal(gena[0].amountField, "Audit_Labor_Cost__c");
  assert.ok(!MAPPING_ROWS.map((r) => r.amountField).join(" ").includes("QA_Labor_Cost__c"));
});

test("the four D11 standalone cost lines are present, with harvest-confirmed keys", () => {
  for (const [line, task] of [["Engineer Stamps", "ENGR"], ["Subcontractor", "SUBCON"], ["Audit Software", "SOFTWARE"], ["Referral Fees", "REFERRAL"]]) {
    const r = MAPPING_ROWS.find((x) => x.line === line);
    assert.ok(r, `${line} missing`);
    assert.equal(r.taskId, task);
  }
  // Nothing is provisional any more — the 2026-08-20 harvest settled every key.
  assert.equal(MAPPING_ROWS.filter((r) => r.keyStatus === "provisional").length, 0);
  // REFERRAL is the one key that is confirmed ABSENT from the live template.
  const ref = MAPPING_ROWS.find((r) => r.line === "Referral Fees");
  assert.equal(ref.keyStatus, "harvested_absent");
  assert.equal(ref.scaffoldOptional, true);
  assert.match(ref.missingLineMessage, /Harmon must add it/);
});

test("the DC rebate is now ACTIVE with the harvested key, and conditional", () => {
  assert.equal(PENDING_HARVEST_ROWS.length, 0, "nothing is awaiting a key any more");
  const dc = MAPPING_ROWS.find((r) => r.amountField === "DC_Rebate_Amount__c");
  assert.ok(dc, "the DC rebate must be in the active mapping now");
  assert.equal(naturalKey(dc), "DCREBATE | BILLING | <N/A> | Income");
  assert.equal(dc.type, "Income");
  // Conditional: absent from the RS template, so it must be optional or every RS push
  // would abort on a line that template legitimately does not have.
  assert.equal(dc.scaffoldOptional, true);
  assert.match(dc.missingLineMessage, /RSDC template/);
});

test("RESIDENTAL stays misspelled and <N/A> stays a literal", () => {
  const inv = new Set(MAPPING_ROWS.map((r) => r.inventoryId));
  assert.ok(inv.has("RESIDENTAL"), "the Acumatica-side spelling must be preserved verbatim");
  assert.ok(!inv.has("RESIDENTIAL"), "correcting the spelling breaks every match");
  assert.ok(inv.has("<N/A>"), "<N/A> is a literal InventoryID value, not null");
});

test("the two BURDENEXR lines are separated only by InventoryID", () => {
  const b = rowsFor("BURDENEXR");
  assert.equal(b.length, 2);
  assert.deepEqual(new Set(b.map((r) => r.inventoryId)), new Set(["SALESCOMM", "RESIDENTAL"]));
});

test("budgetFieldNames splits +, - and * and covers the pending rows", () => {
  const names = budgetFieldNames();
  assert.ok(names.includes("Contract_Amount__c") && names.includes("Total_Material_Budget__c"));
  assert.ok(names.includes("Adder_Software_Fee_Price__c") && names.includes("Adder_Software_Fee_Qty__c"));
  // The guard cannot fire if its trigger field is not selected.
  assert.ok(names.includes("DC_Rebate_Amount__c"), "the DC guard needs its own field in the SOQL");
  assert.ok(!names.some((n) => /[+\-*]/.test(n)), "no operator leaked into a field name");
});

// ===========================================================================
// Matching rules (v1 safety, preserved)
// ===========================================================================

test("a key matching exactly one line matches; 0 or 2 fail loudly", () => {
  const lines = fullScaffold();
  const { matched, problems } = matchMappingToLines(MAPPING_ROWS, lines);
  assert.equal(problems.length, 0);
  assert.equal(matched.length, MAPPING_ROWS.length);

  // Remove a NON-optional line -> that key reports "no scaffolded line matched".
  // (Structural reconcile: no budgetValues, so no amount can excuse it.)
  const missingOne = lines.filter((l) => l.taskId !== "GENO");
  const r0 = matchMappingToLines(MAPPING_ROWS, missingOne);
  assert.equal(r0.problems.length, 1);
  assert.match(r0.problems[0].reason, /no scaffolded line matched/);

  // Duplicate one line -> "matched multiple lines".
  const dup = [...lines, lines.find((l) => l.taskId === "GENO")];
  const r2 = matchMappingToLines(MAPPING_ROWS, dup);
  assert.equal(r2.problems.length, 1);
  assert.match(r2.problems[0].reason, /matched multiple lines/);
});

test("a row with an incomplete key is a problem, never a guess", () => {
  const bad = [{ line: "broken", taskId: "X", accountGroup: "Y", type: "Expense", inventoryId: null, amountField: "A__c" }];
  const { matched, problems } = matchMappingToLines(bad, fullScaffold());
  assert.equal(matched.length, 0);
  assert.equal(problems.length, 1);
});

// ===========================================================================
// Write path
// ===========================================================================

test("dry run computes every line and writes nothing", async () => {
  reset();
  const res = await writeBudgetLines("R000001", VALUES, { dryRun: true });
  assert.equal(res.ok, true);
  assert.equal(ctx.puts.length, 0);
  const by = Object.fromEntries(res.results.map((r) => [r.key, r]));

  assert.equal(by["GENM | MATERIAL | <N/A> | Expense"].amount, 16140.73);
  assert.equal(by["GENO | OTHER | <N/A> | Expense"].amount, 2550);
  assert.equal(by["SLPC OUT | OTHER | M1&M2COM | Expense"].amount, 2200);
  assert.equal(by["SLMC | LABOR | SALESCOMM | Expense"].amount, 484);
  assert.equal(by["APPT COM | LABOR | SALESCOMM | Expense"].amount, 70);
  assert.equal(by["ENGR | SUBCON | <N/A> | Expense"].amount, 250);
  assert.equal(by["SUBCON | SUBCON | <N/A> | Expense"].amount, 528);
  // The two product expressions.
  assert.equal(by["SOFTWARE | OTHER | <N/A> | Expense"].amount, 30);
  assert.equal(by["REFERRAL | OTHER | <N/A> | Expense"].amount, 500);
  // BALANCE income is contract MINUS material, and excludes the rebate.
  assert.equal(by["BALANCE | BILLING | <N/A> | Income"].amount, 36502 - 16140.73);
});

test("expense lines at zero are skipped; income is always written", async () => {
  reset();
  const res = await writeBudgetLines("R000001", VALUES, { dryRun: true });
  const by = Object.fromEntries(res.results.map((r) => [r.key, r]));
  // Internal rep is 0 on this third-party deal -> skipped, not written as 0.
  assert.equal(by["SLPC | LABOR | SALESCOMM | Expense"].action, "skip_zero");
  assert.equal(by["DLR | OTHER | <N/A> | Expense"].action, "skip_zero");
  // Income is written even though nothing forces it.
  assert.equal(by["GENM | BILLING | <N/A> | Income"].action, "would_write");
});

test("hours are written only where the mapping has an hours source", async () => {
  reset();
  const res = await writeBudgetLines("R000001", VALUES, { dryRun: true });
  const by = Object.fromEntries(res.results.map((r) => [r.key, r]));
  assert.equal(by["S1 | LABOR | RESIDENTAL | Expense"].qty, 26.67);
  assert.equal(by["GENA | LABOR | RESIDENTAL | Expense"].qty, 4);
  // ROOFCOM is piece-rate: no hours source, so the scaffold qty is left alone.
  assert.equal(by["ROOFCOM | LABOR | RESIDENTAL | Expense"].qty, undefined);
});

// ---------------------------------------------------------------------------
// v2-engine rollout guard
// ---------------------------------------------------------------------------

test("a v1-calculated record REFUSES before any PUT", async () => {
  reset();
  // A v1 record: the numbers the v3 mapping reads are simply absent, and
  // Commission_Deal_Type__c — only ever written by budgetCalc v2 — is blank.
  const { Commission_Deal_Type__c, ...v1Values } = { ...VALUES, Commission_Deal_Type__c: null };
  const res = await writeBudgetLines("R000001", v1Values);
  assert.equal(res.ok, false);
  assert.equal(res.aborted, "budget_calculated_by_previous_engine");
  assert.match(res.message, /Recalculate Budget first/);
  assert.equal(ctx.puts.length, 0);
});

test("the v2 guard runs BEFORE any amount is considered", async () => {
  reset();
  // Deliberately also ambiguous (both rep amounts) and carrying a DC rebate. The v2
  // guard must win, because on a v1 record every other reading is meaningless.
  const res = await writeBudgetLines("R000001", {
    ...VALUES,
    Commission_Deal_Type__c: "",
    Internal_Rep_Commission_Amt__c: 1800,
    DC_Rebate_Amount__c: 3960,
  });
  assert.equal(res.aborted, "budget_calculated_by_previous_engine");
});

test("'None' is a VALID v2 marker — it means the calc ran and found no rep commission", async () => {
  reset();
  const res = await writeBudgetLines(
    "R000001",
    { ...VALUES, Commission_Deal_Type__c: "None", Sales_Rep_Commission_Amt__c: 0 },
    { dryRun: true }
  );
  // Must NOT be mistaken for a v1 record.
  assert.equal(res.ok, true);
  assert.notEqual(res.aborted, "budget_calculated_by_previous_engine");
});

test("whitespace-only is treated as blank, not as a marker", async () => {
  reset();
  const res = await writeBudgetLines("R000001", { ...VALUES, Commission_Deal_Type__c: "   " });
  assert.equal(res.aborted, "budget_calculated_by_previous_engine");
});

test("the guard's field is in the SOQL — a guard that can't read its trigger is not a guard", () => {
  assert.ok(budgetFieldNames().includes("Commission_Deal_Type__c"));
});

test("D16: both rep amounts non-zero REFUSES before any PUT", async () => {
  reset();
  const res = await writeBudgetLines("R000001", { ...VALUES, Internal_Rep_Commission_Amt__c: 1800 });
  assert.equal(res.ok, false);
  assert.equal(res.aborted, "commission_deal_type_ambiguous");
  assert.equal(ctx.puts.length, 0);
});

test("an internal-only deal writes SLPC and skips SLPC OUT", async () => {
  reset();
  const res = await writeBudgetLines(
    "R000001",
    { ...VALUES, Sales_Rep_Commission_Amt__c: 0, Internal_Rep_Commission_Amt__c: 2200 },
    { dryRun: true }
  );
  const by = Object.fromEntries(res.results.map((r) => [r.key, r]));
  assert.equal(by["SLPC | LABOR | SALESCOMM | Expense"].amount, 2200);
  assert.equal(by["SLPC OUT | OTHER | M1&M2COM | Expense"].action, "skip_zero");
});

test("a DC rebate on a scaffold with no DCREBATE line REFUSES — wrong template", async () => {
  reset();
  // Simulate an RS-template project: drop the DCREBATE line from the scaffold.
  ctx.lines = rawScaffold().filter((l) => l.ProjectTaskID.value !== "DCREBATE");
  const res = await writeBudgetLines("R000001", { ...VALUES, DC_Rebate_Amount__c: 3960 }, { dryRun: true });
  assert.equal(res.ok, false);
  assert.equal(res.aborted, "match_problems");
  assert.match(res.problems[0].reason, /RSDC template/);
  assert.equal(ctx.puts.length, 0);
});

test("a zero DC rebate does not trip the guard (every RS project)", async () => {
  reset();
  const res = await writeBudgetLines("R000001", VALUES, { dryRun: true });
  assert.equal(res.ok, true);
});

test("zero scaffold lines aborts — never create lines from scratch", async () => {
  reset();
  ctx.lines = [];
  const res = await writeBudgetLines("R000001", VALUES, { dryRun: true });
  assert.equal(res.ok, false);
  assert.equal(res.aborted, "no_scaffolded_lines");
});

test("a missing scaffold line aborts before any PUT", async () => {
  reset();
  ctx.lines = rawScaffold().filter((l) => l.ProjectTaskID.value !== "REFERRAL");
  const res = await writeBudgetLines("R000001", VALUES);
  assert.equal(res.ok, false);
  assert.equal(res.aborted, "match_problems");
  assert.equal(ctx.puts.length, 0);
});

test("a real run PUTs by GUID only — no inserts, no key upserts", async () => {
  reset();
  const res = await writeBudgetLines("R000001", VALUES);
  assert.equal(res.ok, true);
  assert.ok(ctx.puts.length > 0);
  for (const body of ctx.puts) {
    assert.ok(body.id, "every PUT must address an existing line by GUID");
    assert.ok("OriginalBudgetedAmount" in body);
  }
  // Zero-amount expense lines were skipped, so fewer PUTs than matched groups.
  assert.ok(res.summary.skipped > 0);
  assert.equal(res.summary.written + res.summary.skipped, MAPPING_ROWS.length);
});

// ===========================================================================
// Skip-before-match ordering, and the conditional lines (harvest, 2026-08-20)
// ===========================================================================

test("a zero expense row with NO scaffold line is inactive, not a failure", async () => {
  reset();
  // REFERRAL is confirmed absent from the live template. The overwhelming majority of
  // jobs have no referral fee, and they must not fail on a line nobody needs.
  ctx.lines = rawScaffold().filter((l) => l.ProjectTaskID.value !== "REFERRAL");
  const res = await writeBudgetLines("R000001", { ...VALUES, Adder_Referral_Fee_Qty__c: 0 }, { dryRun: true });
  assert.equal(res.ok, true);
  assert.ok(res.inactive.some((i) => i.rows.includes("Referral Fees")));
});

test("a NON-zero expense row with no scaffold line aborts with its own message", async () => {
  reset();
  ctx.lines = rawScaffold().filter((l) => l.ProjectTaskID.value !== "REFERRAL");
  const res = await writeBudgetLines("R000001", { ...VALUES, Adder_Referral_Fee_Qty__c: 1 }, { dryRun: true });
  assert.equal(res.ok, false);
  assert.equal(res.aborted, "match_problems");
  assert.match(res.problems[0].reason, /no REFERRAL line/);
  assert.equal(res.problems[0].amount, 500);
});

test("skip-before-match applies to ANY zero expense row, not just the optional ones", async () => {
  reset();
  // GENO is a normal, non-optional row. With a zero amount and no line, there is
  // nothing to write, so it is inactive rather than a hard failure on the WRITE path.
  ctx.lines = rawScaffold().filter((l) => l.ProjectTaskID.value !== "GENO");
  const res = await writeBudgetLines("R000001", { ...VALUES, Total_Other_Budget__c: 0 }, { dryRun: true });
  assert.equal(res.ok, true);
  assert.ok(res.inactive.some((i) => i.rows.includes("Other (GENO)")));
  // ...but with a real amount it still aborts.
  const res2 = await writeBudgetLines("R000001", VALUES, { dryRun: true });
  assert.equal(res2.ok, false);
  assert.equal(res2.aborted, "match_problems");
});

test("RECONCILE stays strict — no amounts means every non-optional row must match", () => {
  // The leniency above is write-path only. A structural check must still catch a
  // broken key, because that is the run whose job is to catch broken keys.
  const lines = fullScaffold().filter((l) => l.taskId !== "GENO");
  const { problems } = matchMappingToLines(MAPPING_ROWS, lines); // no budgetValues
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /no scaffolded line matched/);
});

test("income is EXEMPT from skip-before-match — a missing income line still fails", () => {
  const lines = fullScaffold().filter((l) => l.taskId !== "BALANCE");
  const { problems } = matchMappingToLines(MAPPING_ROWS, lines, { ...VALUES, Contract_Amount__c: 0, Total_Material_Budget__c: 0 });
  assert.equal(problems.length, 1, "income-always means a missing income line fails even at 0");
});

test("DCREBATE present + zero rebate still WRITES — income-always", async () => {
  reset();
  const res = await writeBudgetLines("R000001", { ...VALUES, DC_Rebate_Amount__c: 0 }, { dryRun: true });
  const dc = res.results.find((r) => r.key.startsWith("DCREBATE"));
  assert.equal(dc.action, "would_write");
  assert.equal(dc.amount, 0);
});

// ===========================================================================
// Regression against the REAL harvested scaffolds (out-rs.json / out-rsdc.json)
// ===========================================================================
// These are the actual live line dumps from R261077 (RS) and R261066 (RSDC), so this
// is the closest thing to the live reconcile that can run offline. If the template
// changes under us, this is what notices.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const harvest = (f) => JSON.parse(fs.readFileSync(path.join(here, "harvest", f), "utf8")).lines;

test("LIVE RS scaffold (R261077): all rows resolve, 0 problems", () => {
  const lines = harvest("R261077-rs.json");
  assert.equal(lines.length, 38);
  const { matched, problems, inactive } = matchMappingToLines(MAPPING_ROWS, lines, {
    ...VALUES, DC_Rebate_Amount__c: 0, Adder_Referral_Fee_Qty__c: 0,
  });
  assert.equal(problems.length, 0, JSON.stringify(problems));
  assert.equal(matched.length, 19);
  // Exactly two rows correctly do nothing on an RS project.
  assert.deepEqual(
    inactive.map((i) => i.rows).flat().sort(),
    ["Income - DC Rebate (RSDC only)", "Referral Fees"]
  );
  // The harvest's headline fix: single-space SLPC OUT now resolves.
  assert.ok(matched.some((m) => m.key === "SLPC OUT | OTHER | M1&M2COM | Expense"));
});

test("LIVE RSDC scaffold (R261066): DCREBATE resolves, 0 problems", () => {
  const lines = harvest("R261066-rsdc.json");
  assert.equal(lines.length, 39);
  const { matched, problems, inactive } = matchMappingToLines(MAPPING_ROWS, lines, {
    ...VALUES, DC_Rebate_Amount__c: 3960, Adder_Referral_Fee_Qty__c: 0,
  });
  assert.equal(problems.length, 0, JSON.stringify(problems));
  assert.equal(matched.length, 20);
  assert.ok(matched.some((m) => m.key === "DCREBATE | BILLING | <N/A> | Income"));
  assert.deepEqual(inactive.map((i) => i.rows).flat(), ["Referral Fees"]);
});

test("LIVE RS scaffold + a domestic-content rebate = wrong template, loud abort", () => {
  const { problems } = matchMappingToLines(MAPPING_ROWS, harvest("R261077-rs.json"), {
    ...VALUES, DC_Rebate_Amount__c: 3960, Adder_Referral_Fee_Qty__c: 0,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /RSDC template/);
  assert.equal(problems[0].amount, 3960);
});

test("the RSDC scaffold is the RS scaffold plus exactly one line", () => {
  const rs = new Set(harvest("R261077-rs.json").map((l) => l.key));
  const delta = harvest("R261066-rsdc.json").filter((l) => !rs.has(l.key));
  assert.equal(delta.length, 1);
  assert.equal(delta[0].key, "DCREBATE | BILLING | <N/A> | Income");
});
