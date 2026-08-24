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
  /**
   * What the fake Acumatica does when a PUT arrives with NO `id` — i.e. a create (D20).
   *
   *   "insert"        the honest one: appends the line, so the verifying re-read finds it
   *   "reject"        4xx, nothing created
   *   "silent"        200 but nothing actually appears (the failure that would otherwise
   *                   report success and lose the money)
   *   "duplicate"     200 and TWO lines appear (breaks the exactly-one-match invariant)
   *   "wrong_group"   200 but Acumatica derives a different AccountGroup from the item
   *
   * The last three are the reason verification re-reads instead of trusting the 200.
   */
  createBehaviour: "insert",
  createCount: 0,
};

/** Build the raw line Acumatica would return for a created referral row. */
function rawCreatedReferralLine(body, overrides = {}) {
  const v = (f) => body[f]?.value;
  return {
    id: "guid-created-referral",
    ProjectTaskID: { value: v("ProjectTaskID") },
    AccountGroup: { value: v("AccountGroup") },
    InventoryID: { value: v("InventoryID") },
    Type: { value: "Expense" }, // Acumatica derives this, we never send it
    UOM: { value: v("UOM") },
    Description: { value: v("Description") },
    OriginalBudgetedAmount: { value: v("OriginalBudgetedAmount") },
    OriginalBudgetedQty: { value: 0 },
    ...overrides,
  };
}

mock.module("../../lib/acumatica.js", {
  exports: {
    getAcumaticaEntity: async () => ({ ok: true, status: 200, data: ctx.lines }),
    putAcumaticaEntity: async (_entity, body) => {
      ctx.puts.push(body);
      // An UPDATE (has id) behaves as before. Only a create is simulated.
      if (body.id) return { ok: ctx.putStatus < 400, status: ctx.putStatus, text: "" };

      ctx.createCount++;
      switch (ctx.createBehaviour) {
        case "reject":
          return { ok: false, status: 400, text: "Inventory item REFERRAL not found" };
        case "silent":
          return { ok: true, status: 200, text: "" }; // ...but ctx.lines is untouched
        case "duplicate":
          ctx.lines.push(rawCreatedReferralLine(body));
          ctx.lines.push(rawCreatedReferralLine(body, { id: "guid-created-referral-2" }));
          return { ok: true, status: 200, text: "" };
        case "wrong_group":
          ctx.lines.push(rawCreatedReferralLine(body, { AccountGroup: { value: "MATERIAL" } }));
          return { ok: true, status: 200, text: "" };
        default:
          ctx.lines.push(rawCreatedReferralLine(body));
          return { ok: true, status: 200, text: "" };
      }
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
const {
  MAPPING_ROWS, PENDING_HARVEST_ROWS, budgetFieldNames, matchMappingToLines, naturalKey,
  writeBudgetLines, CREATE_GATE, REFERRAL_LINE_KEY, REFERRAL_CREATE_SPEC,
  downstreamFieldNames, workerFieldNames, runDownstreamStages,
} = mod;

/**
 * Run `fn` with the D20 create gate forced to `state`, then RESTORE WHAT IT WAS.
 *
 * The gate is a mutable export precisely so both states can be exercised here — a plain
 * `const` would leave one branch untested until the day someone flipped it in production,
 * which is the opposite of what a gate is for.
 *
 * Note these save and restore rather than resetting to a literal. An earlier version
 * hard-coded `false` in the finally, which was correct only while `false` was the
 * committed value; when the gate opened after the sandbox proof, that would have leaked a
 * CLOSED gate into every later test and made the whole suite order-dependent.
 */
async function withGate(state, fn) {
  const prior = CREATE_GATE.enabled;
  CREATE_GATE.enabled = state;
  try {
    return await fn();
  } finally {
    CREATE_GATE.enabled = prior;
  }
}
const withCreateEnabled = (fn) => withGate(true, fn);
const withCreateDisabled = (fn) => withGate(false, fn);

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

/**
 * The realistic scaffold: everything EXCEPT the referral line.
 *
 * This is what every live RS and RSDC project actually looks like (D18/D20 — Harmon is
 * not adding the line to the templates), so it is the default state for the D20 tests
 * rather than an edge case. Filtered on InventoryID, not task id: since the key change
 * the referral line shares ProjectTaskID `GENO` with the other-costs sum line, and
 * filtering by task would remove both.
 */
function withoutReferralLine() {
  return rawScaffold().filter((l) => l.InventoryID.value !== "REFERRAL");
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
  ctx.createBehaviour = "insert";
  ctx.createCount = 0;
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
  // The GENO *sum* line is keyed by InventoryID <N/A>. Since D20 the referral line also
  // lives under ProjectTaskID GENO, with InventoryID REFERRAL — a different key, and a
  // different line in Acumatica. Filtering by task alone would now catch both, which is
  // the collision this test has to be careful not to imagine.
  const geno = rowsFor("GENO").filter((r) => r.inventoryId === "<N/A>");
  assert.equal(geno.length, 1, `expected 1 GENO sum row, got ${geno.length}: ${geno.map((r) => r.line)}`);
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
  for (const [line, task] of [["Engineer Stamps", "ENGR"], ["Subcontractor", "SUBCON"], ["Audit Software", "SOFTWARE"], ["Referral Fees", "GENO"]]) {
    const r = MAPPING_ROWS.find((x) => x.line === line);
    assert.ok(r, `${line} missing`);
    assert.equal(r.taskId, task);
  }
  // Nothing is provisional any more — the 2026-08-20 harvest settled every key.
  assert.equal(MAPPING_ROWS.filter((r) => r.keyStatus === "provisional").length, 0);
  // Referral is the one key confirmed ABSENT from the live template, and since D20 it
  // is the one row allowed to create its own line.
  const ref = MAPPING_ROWS.find((r) => r.line === "Referral Fees");
  assert.equal(ref.keyStatus, "harvested_absent");
  assert.equal(ref.scaffoldOptional, true);
  assert.equal(ref.createIfMissing, true);
});

// ===========================================================================
// D20 — the referral line's key, and the only create capability in the system
// ===========================================================================

test("D20: the referral key is GENO | OTHER | REFERRAL, and does NOT collide with GENO sum", () => {
  const ref = MAPPING_ROWS.find((r) => r.line === "Referral Fees");
  assert.equal(naturalKey(ref), "GENO | OTHER | REFERRAL | Expense");
  assert.equal(naturalKey(ref), REFERRAL_LINE_KEY);
  // The old key is gone entirely — a stale REFERRAL task id would match nothing.
  assert.ok(!MAPPING_ROWS.some((r) => r.taskId === "REFERRAL"));
  // Same task, different InventoryID, therefore different key and different line. This
  // is the assertion the whole key change rests on: if these two ever collapsed to one
  // key, the matcher would see two rows for one line and SUM them — posting the referral
  // fee into the GENO other-costs total, silently and with the right-looking total.
  const sum = MAPPING_ROWS.find((r) => r.taskId === "GENO" && r.inventoryId === "<N/A>");
  assert.notEqual(naturalKey(ref), naturalKey(sum));
  assert.equal(MAPPING_ROWS.filter((r) => naturalKey(r) === REFERRAL_LINE_KEY).length, 1);
});

test("D20: the create gate ships OPEN, on the strength of the sandbox hand-proof", () => {
  // This test exists to make a change to line creation a visible, deliberate diff in
  // EITHER direction. It shipped asserting `false`; it now asserts `true` because the
  // hand-proof passed against sandbox R261065 (runbook §Results) — PUT-without-id
  // inserts, AccountGroup/Type come back OTHER/Expense, update-by-guid is in place, no
  // duplicate.
  //
  // If a future change closes the gate, this test is the thing that says so out loud
  // rather than letting referral fees start silently aborting again.
  assert.equal(CREATE_GATE.enabled, true, "CREATE_GATE — see the runbook results before changing this");
});

test("D20: only the referral row carries createIfMissing", () => {
  const creators = MAPPING_ROWS.filter((r) => r.createIfMissing);
  assert.deepEqual(creators.map((r) => r.line), ["Referral Fees"]);
  assert.equal(REFERRAL_CREATE_SPEC.key, REFERRAL_LINE_KEY);
});

test("D20: the create spec is Harmon's line spec verbatim", () => {
  assert.deepEqual(REFERRAL_CREATE_SPEC, {
    key: "GENO | OTHER | REFERRAL | Expense",
    projectTaskId: "GENO",
    accountGroup: "OTHER",
    inventoryId: "REFERRAL",
    description: "Referral Fee",
    uom: "EA",
    type: "Expense",
  });
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
  assert.equal(by[REFERRAL_LINE_KEY].amount, 500);
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
  // GENM (total material), not the referral line: with the gate open, a missing referral
  // line is CREATED rather than an abort, so using it here would test the opposite of
  // what this test is named for. Every other line in the mapping is still update-only,
  // and a template missing one of them is a broken scaffold — refuse, write nothing.
  ctx.lines = rawScaffold().filter(
    (l) => !(l.ProjectTaskID.value === "GENM" && l.AccountGroup.value === "MATERIAL")
  );
  const res = await writeBudgetLines("R000001", VALUES);
  assert.equal(res.ok, false);
  assert.equal(res.aborted, "match_problems");
  assert.equal(ctx.puts.length, 0);
  assert.equal(ctx.createCount, 0, "no line other than the referral line may be created");
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
  ctx.lines = withoutReferralLine();
  const res = await writeBudgetLines("R000001", { ...VALUES, Adder_Referral_Fee_Qty__c: 0 }, { dryRun: true });
  assert.equal(res.ok, true);
  assert.ok(res.inactive.some((i) => i.rows.includes("Referral Fees")));
});

test("a NON-zero optional row with no scaffold line aborts with its own message", async () => {
  reset();
  // The DC rebate, since D20 gave the referral row a create path instead of this one.
  // The mechanic being pinned is generic and still matters: a scaffoldOptional row that
  // is absent while carrying a real amount must abort with the row's OWN message naming
  // the actual fix, rather than being skipped as "optional" and losing the money.
  ctx.lines = rawScaffold().filter((l) => l.ProjectTaskID.value !== "DCREBATE");
  const res = await writeBudgetLines("R000001", { ...VALUES, DC_Rebate_Amount__c: 3960 }, { dryRun: true });
  assert.equal(res.ok, false);
  assert.equal(res.aborted, "match_problems");
  assert.match(res.problems[0].reason, /RSDC template/);
  assert.equal(res.problems[0].amount, 3960);
  assert.equal(ctx.createCount, 0, "an optional row that is not the referral line never creates");
});

test("skip-before-match applies to ANY zero expense row, not just the optional ones", async () => {
  reset();
  // GENO is a normal, non-optional row. With a zero amount and no line, there is
  // nothing to write, so it is inactive rather than a hard failure on the WRITE path.
  //
  // Removed by FULL KEY, not by task id: since D20 the referral line is also a GENO
  // task, so dropping every GENO line would silently make this a two-missing-line test
  // and it would fail on the referral row instead of proving anything about skip-zero.
  ctx.lines = rawScaffold().filter(
    (l) => !(l.ProjectTaskID.value === "GENO" && l.InventoryID.value === "<N/A>")
  );
  const res = await writeBudgetLines("R000001", { ...VALUES, Total_Other_Budget__c: 0 }, { dryRun: true });
  assert.equal(res.ok, true);
  assert.ok(res.inactive.some((i) => i.rows.includes("Other (GENO)")));
  // ...but with a real amount it still aborts.
  const res2 = await writeBudgetLines("R000001", VALUES, { dryRun: true });
  assert.equal(res2.ok, false);
  assert.equal(res2.aborted, "match_problems");
});

// ===========================================================================
// D20 — the three branches of the referral line, and the create mechanic
// ===========================================================================
//
// Branch 1: line PRESENT        -> update by guid, business as usual
// Branch 2: ABSENT + amount 0   -> inactive (the common case, every job with no referral)
// Branch 3: ABSENT + amount > 0 -> create, verify by re-read, then business as usual
//
// Branch 2 is covered above ("a zero expense row with NO scaffold line is inactive").
// The gate-closed form of branch 3 is covered above too ("a NON-zero expense row with
// no scaffold line aborts with its own message") — that IS the shipped behaviour.

test("D20 branch 1: the line PRESENT is a plain update by guid, no create", async () => {
  reset();
  const res = await writeBudgetLines("R000001", VALUES);
  assert.equal(res.ok, true);
  assert.equal(ctx.createCount, 0, "a present line must never trigger a create");
  assert.equal(res.summary.created, 0);
  const put = ctx.puts.find((b) => b.id === `guid-GENO-OTHER-REFERRAL-Expense`);
  assert.ok(put, "the referral line should have been updated by guid");
  assert.equal(put.OriginalBudgetedAmount.value, 500);
});

test("D20 branch 1 holds even with the gate OPEN — present means update, never create", async () => {
  await withCreateEnabled(async () => {
    reset();
    const res = await writeBudgetLines("R000001", VALUES);
    assert.equal(res.ok, true);
    assert.equal(ctx.createCount, 0);
    assert.equal(res.summary.created, 0);
  });
});

test("D20 branch 2: absent + zero referral is inactive even with the gate OPEN", async () => {
  await withCreateEnabled(async () => {
    reset();
    ctx.lines = withoutReferralLine();
    const res = await writeBudgetLines("R000001", { ...VALUES, Adder_Referral_Fee_Qty__c: 0 });
    assert.equal(res.ok, true);
    assert.equal(ctx.createCount, 0, "nothing to write means nothing to create");
    assert.ok(res.inactive.some((i) => i.rows.includes("Referral Fees")));
  });
});

test("D20 branch 3: absent + non-zero CREATES the line and verifies it", async () => {
  await withCreateEnabled(async () => {
    reset();
    ctx.lines = withoutReferralLine();
    const res = await writeBudgetLines("R000001", VALUES);

    assert.equal(res.ok, true);
    assert.equal(res.summary.created, 1);
    assert.equal(ctx.createCount, 1);

    // The create body is Harmon's spec, and critically carries NO id — that is what
    // makes it an insert rather than an update of some unrelated line.
    const body = ctx.puts.find((b) => !b.id);
    assert.ok(body, "a create PUT must have been issued");
    assert.equal(body.id, undefined);
    assert.equal(body.ProjectID.value, "R000001");
    assert.equal(body.ProjectTaskID.value, "GENO");
    assert.equal(body.AccountGroup.value, "OTHER");
    assert.equal(body.InventoryID.value, "REFERRAL");
    assert.equal(body.Description.value, "Referral Fee");
    assert.equal(body.UOM.value, "EA");
    assert.equal(body.OriginalBudgetedAmount.value, 500);
    // No qty and no rate — Harmon's spec says no defaults.
    assert.ok(!("OriginalBudgetedQty" in body));

    const created = res.results.find((r) => r.action === "created");
    assert.equal(created.key, REFERRAL_LINE_KEY);
    assert.equal(created.amount, 500);
    assert.ok(created.lineId, "verification must have found a guid");
  });
});

test("D20 branch 3: a re-push after creation takes branch 1", async () => {
  // The point of the whole design: creating is a one-off correction, not a mode. The
  // second push must find the line and update it, or every referral job would grow a
  // new line on every push until the key stopped matching uniquely.
  await withCreateEnabled(async () => {
    reset();
    ctx.lines = withoutReferralLine();

    const first = await writeBudgetLines("R000001", VALUES);
    assert.equal(first.summary.created, 1);

    // ctx.lines now contains the created line — exactly what a fresh read would return.
    ctx.puts = [];
    ctx.createCount = 0;
    const second = await writeBudgetLines("R000001", { ...VALUES, Adder_Referral_Fee_Price__c: 750 });

    assert.equal(second.ok, true);
    assert.equal(second.summary.created, 0, "the second push must NOT create again");
    assert.equal(ctx.createCount, 0);
    const update = ctx.puts.find((b) => b.id === "guid-created-referral");
    assert.ok(update, "the second push must update the created line by its guid");
    assert.equal(update.OriginalBudgetedAmount.value, 750);
    // And the project still has exactly one referral line.
    assert.equal(ctx.lines.filter((l) => l.InventoryID.value === "REFERRAL").length, 1);
  });
});

test("D20: a REJECTED create aborts the push and says nothing needs cleaning up", async () => {
  await withCreateEnabled(async () => {
    reset();
    ctx.lines = withoutReferralLine();
    ctx.createBehaviour = "reject";
    const res = await writeBudgetLines("R000001", VALUES);
    assert.equal(res.ok, false);
    assert.equal(res.aborted, "referral_line_create_failed");
    assert.equal(res.create.action, "create_failed");
    assert.match(res.message, /nothing needs cleaning up/);
  });
});

test("D20: a create that 200s but produces NO line fails verification", async () => {
  // The dangerous one. Without the re-read this reports success and the referral fee
  // silently never reaches Acumatica.
  await withCreateEnabled(async () => {
    reset();
    ctx.lines = withoutReferralLine();
    ctx.createBehaviour = "silent";
    const res = await writeBudgetLines("R000001", VALUES);
    assert.equal(res.ok, false);
    assert.equal(res.aborted, "referral_line_create_failed");
    assert.equal(res.create.action, "create_unverified");
    assert.equal(res.create.count, 0);
  });
});

test("D20: a create that produces TWO lines fails verification loudly", async () => {
  // A duplicate breaks the exactly-one-match invariant, so every FUTURE push on the
  // project would abort. Catching it in the run that caused it is the difference
  // between one message and a mystery.
  await withCreateEnabled(async () => {
    reset();
    ctx.lines = withoutReferralLine();
    ctx.createBehaviour = "duplicate";
    const res = await writeBudgetLines("R000001", VALUES);
    assert.equal(res.ok, false);
    assert.equal(res.create.action, "create_unverified");
    assert.equal(res.create.count, 2);
    assert.match(res.message, /Delete the duplicates/);
  });
});

test("D20: a created line whose AccountGroup came back different fails verification", async () => {
  // Acumatica may derive AccountGroup from the inventory item's posting class rather
  // than taking what we send. If it does, the line is real but keyed differently and
  // the mapping row would never match it again. This is the specific thing the sandbox
  // hand-proof runbook exists to settle.
  await withCreateEnabled(async () => {
    reset();
    ctx.lines = withoutReferralLine();
    ctx.createBehaviour = "wrong_group";
    const res = await writeBudgetLines("R000001", VALUES);
    assert.equal(res.ok, false);
    assert.equal(res.create.action, "create_unverified");
    assert.match(res.message, /AccountGroup came back "MATERIAL"/);
  });
});

test("D20: an unverified create aborts BEFORE any other line is written", async () => {
  // Creates run first for exactly this reason: a project left in an unknown state must
  // not also have twenty updated lines to reason about.
  await withCreateEnabled(async () => {
    reset();
    ctx.lines = withoutReferralLine();
    ctx.createBehaviour = "silent";
    await writeBudgetLines("R000001", VALUES);
    const updates = ctx.puts.filter((b) => b.id);
    assert.equal(updates.length, 0, "no update PUTs may follow a failed create");
  });
});

test("D20: dry run reports would_create and issues no PUT at all", async () => {
  await withCreateEnabled(async () => {
    reset();
    ctx.lines = withoutReferralLine();
    const res = await writeBudgetLines("R000001", VALUES, { dryRun: true });
    assert.equal(res.ok, true);
    assert.equal(ctx.puts.length, 0);
    assert.equal(ctx.createCount, 0);
    const would = res.results.find((r) => r.action === "would_create");
    assert.ok(would);
    assert.equal(would.amount, 500);
    assert.equal(would.spec.inventoryId, "REFERRAL");
  });
});

test("D20: closing the gate restores the pre-D20 behaviour exactly", async () => {
  // The gate is open now, but closing it has to remain a safe, complete rollback rather
  // than a half-state: a loud abort before any write, not a silently skipped line. This
  // is the test that makes "set CREATE_GATE back to false" a real answer if the create
  // path ever misbehaves in production.
  await withCreateDisabled(async () => {
    reset();
    ctx.lines = withoutReferralLine();
    const res = await writeBudgetLines("R000001", VALUES);
    assert.equal(res.ok, false);
    assert.equal(res.aborted, "match_problems");
    assert.equal(ctx.puts.length, 0, "the abort must come before any write");
    assert.equal(ctx.createCount, 0);
    assert.match(res.problems[0].reason, /CREATE_GATE has been closed/);
  });
});

test("D20: reconcile never creates — it has no amounts and no write path", () => {
  // matchMappingToLines with no budgetValues cannot know an amount is non-zero, so
  // toCreate must be empty even with the gate open. Reconcile is read-only and stays so —
  // which matters more now that the gate is open by default.
  const lines = fullScaffold().filter((l) => l.inventoryId !== "REFERRAL");
  const { toCreate, problems, inactive } = matchMappingToLines(MAPPING_ROWS, lines);
  assert.deepEqual(toCreate, []);
  // It surfaces as INACTIVE, not a problem: reconcile allows a scaffoldOptional row to
  // be absent (that is the whole point of the flag), and with no amounts it cannot
  // know whether this project would need the line. Reported rather than swallowed, so
  // "why is Referral Fees not in the output" still has an answer.
  assert.ok(inactive.some((i) => i.key === REFERRAL_LINE_KEY));
  assert.ok(!problems.some((p) => p.key === REFERRAL_LINE_KEY));
});

test("D20: no row other than the referral line can reach the create path", async () => {
  // The guard is three redundant conditions (opt-in flag, exact key, gate). This proves
  // the KEY condition specifically: a row that opts in but is not the referral line
  // aborts the way any other missing line does, rather than gaining create powers.
  await withCreateEnabled(async () => {
    reset();
    const impostor = { ...MAPPING_ROWS.find((r) => r.line === "Engineer Stamps"), createIfMissing: true, scaffoldOptional: true };
    const rows = MAPPING_ROWS.map((r) => (r.line === "Engineer Stamps" ? impostor : r));
    const lines = fullScaffold().filter((l) => l.taskId !== "ENGR");
    const { toCreate, problems } = matchMappingToLines(rows, lines, VALUES);
    assert.deepEqual(toCreate, [], "only the referral key may be created");
    assert.ok(problems.some((p) => p.key.startsWith("ENGR")));
  });
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

test("LIVE RS scaffold + a referral fee = create, against the real 38-line harvest", () => {
  // The D20 branch tests run against a synthetic scaffold built from MAPPING_ROWS, which
  // by construction agrees with the mapping. This one runs against the actual harvested
  // template, so it also proves the harvest genuinely has no GENO/REFERRAL line and no
  // OTHER line collides with the new key — the thing a self-consistent fixture cannot say.
  const lines = harvest("R261077-rs.json");
  assert.equal(lines.filter((l) => l.key === REFERRAL_LINE_KEY).length, 0);
  // ...and the GENO sum line IS there, unaffected, which is the no-collision proof.
  assert.equal(lines.filter((l) => l.key === "GENO | OTHER | <N/A> | Expense").length, 1);

  const { toCreate, problems } = matchMappingToLines(MAPPING_ROWS, lines, {
    ...VALUES, DC_Rebate_Amount__c: 0, Adder_Referral_Fee_Qty__c: 1,
  });
  assert.equal(problems.length, 0, JSON.stringify(problems));
  assert.equal(toCreate.length, 1);
  assert.equal(toCreate[0].key, REFERRAL_LINE_KEY);
  assert.equal(toCreate[0].amount, 500);
});

test("the RSDC scaffold is the RS scaffold plus exactly one line", () => {
  const rs = new Set(harvest("R261077-rs.json").map((l) => l.key));
  const delta = harvest("R261066-rsdc.json").filter((l) => !rs.has(l.key));
  assert.equal(delta.length, 1);
  assert.equal(delta[0].key, "DCREBATE | BILLING | <N/A> | Income");
});

// ===========================================================================
// Downstream stages — commission POs (B) and project attributes (E)
// ===========================================================================

test("the worker SELECTs everything both downstream stages read", () => {
  // A field missing from this SELECT does not throw. It arrives as `undefined`, the PO
  // engine reads "no stored OrderNbr", and raises a SECOND purchase order — so the list
  // is derived from the modules' own exported constants rather than retyped here.
  const names = workerFieldNames();
  for (const f of [
    "Acumatica_Project_ID__c",
    "Commission_PO_M1_Number__c", "Commission_PO_M2_Number__c",
    "Audit_Date_and_DateTime__c", "Scheduled_Install_Date__c",
    "System_Size__c", "Sales_Company_Harmon_Solar_or_Third__c",
    "Commission_Deal_Type__c", "Internal_Rep_Commission_Amt__c",
    "Sales_Mgr_Commission_Amt__c", "Overhead_Commission_Amt__c",
  ]) {
    assert.ok(names.includes(f), `${f} missing from the worker SELECT`);
  }
  // The budget mapping's own fields are still all there.
  for (const f of budgetFieldNames()) assert.ok(names.includes(f), `${f} dropped`);
  assert.equal(new Set(names).size, names.length, "duplicate field would break the SOQL");
  assert.ok(downstreamFieldNames().length > 0);
});

test("a clean run reports no problem and CLEARS the error field", async () => {
  const r = await runDownstreamStages("a0X1", "R261065", {}, {
    syncCommissionPos: async () => ({ ok: true, status: "Both Raised" }),
    syncProjectAttributes: async () => ({ ok: true, action: "synced" }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.note, null, "null clears Budget_Push_Error__c, which is its contract");
});

test("an INTERNAL deal is not a problem — it is the system working", async () => {
  // syncCommissionPos already recorded `None` on the record. Surfacing it as a push
  // problem would train people to ignore the field.
  for (const reason of ["internal_deal", "no_commission", "gate_closed"]) {
    const r = await runDownstreamStages("a0X1", "R261065", {}, {
      syncCommissionPos: async () => ({ ok: false, reason, message: "nope" }),
      syncProjectAttributes: async () => ({ ok: true, action: "synced" }),
    });
    assert.equal(r.ok, true, `${reason} must not read as a failure`);
    assert.equal(r.note, null);
  }
});

test("a REAL PO failure surfaces on the record, not just in CloudWatch", async () => {
  const r = await runDownstreamStages("a0X1", "R261065", {}, {
    syncCommissionPos: async () => ({ ok: false, reason: "vendor_unmapped", message: "Solar Bill is not in dealer-vendor-map.csv" }),
    syncProjectAttributes: async () => ({ ok: true, action: "synced" }),
  });
  assert.equal(r.ok, false);
  assert.match(r.note, /Budget lines pushed OK/);
  assert.match(r.note, /dealer-vendor-map\.csv/);
});

test("an attribute verification failure surfaces too — it has no field of its own", async () => {
  // KNOWN GAP: there is no Attribute_Sync_Status__c pair, so this note is the only place
  // a discarded attribute becomes visible. Thin, and better than silent.
  const r = await runDownstreamStages("a0X1", "R261065", {}, {
    syncCommissionPos: async () => ({ ok: true, status: "Both Raised" }),
    syncProjectAttributes: async () => ({ ok: false, action: "unverified", message: "GREENTAG was discarded" }),
  });
  assert.equal(r.ok, false);
  assert.match(r.note, /GREENTAG was discarded/);
});

test("NEITHER STAGE MAY THROW PAST THIS — a successful budget push stays successful", async () => {
  // An escaping exception would land in the worker's catch and mark a push that genuinely
  // wrote every budget line as Failed, leaving Budget_Finalized__c false and inviting a
  // pointless re-push.
  const r = await runDownstreamStages("a0X1", "R261065", {}, {
    syncCommissionPos: async () => { throw new Error("acumatica exploded"); },
    syncProjectAttributes: async () => { throw new Error("and again"); },
  });
  assert.equal(r.ok, false);
  assert.match(r.note, /threw: acumatica exploded/);
  assert.match(r.note, /threw: and again/);
  assert.equal(r.commissionPos.reason, "exception");
});

test("the ATTRIBUTE stage still runs when the PO stage fails", async () => {
  // They are independent facts about the job. A dealer with no vendor mapping should not
  // also stop Harmon's reporting attributes from updating.
  let ran = false;
  await runDownstreamStages("a0X1", "R261065", {}, {
    syncCommissionPos: async () => { throw new Error("boom"); },
    syncProjectAttributes: async () => { ran = true; return { ok: true, action: "synced" }; },
  });
  assert.equal(ran, true);
});

test("both problems are reported together, not just the first", async () => {
  const r = await runDownstreamStages("a0X1", "R261065", {}, {
    syncCommissionPos: async () => ({ ok: false, reason: "vendor_inactive", message: "vendor 01863 is inactive" }),
    syncProjectAttributes: async () => ({ ok: false, action: "unverified", message: "KW discarded" }),
  });
  assert.match(r.note, /inactive/);
  assert.match(r.note, /KW discarded/);
});
