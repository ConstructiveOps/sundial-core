/*
 * budgetCalc v2 — verified against the REVISED workbook
 * (template/budget-template-v2.xlsx, `Harmon Budget Revised 82026.xlsx`).
 *
 * The fixture inputs below ARE that workbook's inputs, and the expectations ARE its
 * cached values, extracted cell-by-cell rather than retyped from the doc. Two layers:
 *
 *   1. CELL expectations — every summary and budget-line cell. This is the real
 *      regression net: it pins each Acumatica-coded line (J15-J36) and the whole GP
 *      block independently, so a compensating pair of errors cannot hide inside a
 *      total the way it can when only the totals are checked.
 *   2. FIELD expectations — what actually gets written back to Salesforce.
 *
 * Plus the behaviours that have no cached cell because the fixture doesn't exercise
 * them: the D19 sales-company routing and its two fail-loud validations, the D15
 * missing-cost error, the D17 setter gate, and the DC rebate.
 *
 * ⚠️ THE COMMISSION EXPECTATIONS ARE NOT THE WORKBOOK'S. D19 replaced the PPW-input
 * model after the workbook was cut, so the commission block and everything downstream
 * of it is pinned to the redline worked example instead. See COMMISSION_REPIN below —
 * it lists exactly which numbers moved and why, and one consequence (a negative GP) is
 * expected rather than a bug.
 *
 * HOLLAND is retired (D1) — its template and fixture are deleted, not commented out.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { calculateBudget, BudgetInputError } = require('./budgetCalc');
const { buildWorkbook, snapshotKey } = require('./budgetWorkbook');

const TOL = 0.011;

// A real Sundial_User__c-shaped id; only its presence matters (D17).
const SETTER_ID = 'a0X7y00000SETTER01';

/** The REVISED workbook's own inputs, as Sundial_Solar__c field values. */
const REVISED = {
  Project_Name__c: 'REVISED EXAMPLE',
  Panel_Type__c: 'SILFAB',

  // Contract block
  Contract_Amount__c: 36502,        // N6
  Dealer_Fee__c: 0,                 // N8
  Domestic_Content__c: 'NO',        // D3 — no rebate in the cached example
  System_Size__c: 8.8,              // D7 -> 8800 W
  Module_STC_Wattage__c: 440,       // B8
  Module_Cost_Per_Watt__c: 0.6,     // B9

  // Equipment
  Combiner_Unit_Cost__c: 604.81, Combiner_Qty__c: 0,
  // Gateway_* is REUSED for the Tesla Expansion Pack (§3).
  Gateway_Unit_Cost__c: 6009.03, Gateway_Qty__c: 0,
  Microinverter_Unit_Cost__c: 109.93, Microinverter_Qty__c: 0,
  Battery_Unit_Cost__c: 7383.33, Battery_Qty__c: 1,

  // BOS / roofing material
  BOS_Solar_Cost_Per_Watt__c: 0.17, BOS_Electrical_Cost_Per_Watt__c: 0.1,
  Roof_Material_Cost_Per_Pen__c: 24, Penetrations_Per_Module__c: 1.75,

  // Labor parameters
  Blended_Labor_Rate__c: 28.25, Labor_Burden_Rate__c: 75,
  Audit_Hours__c: 2, QA_Commissioning_Hours__c: 2,
  Roofing_Cost_Per_Penetration__c: 21, Roofing_Pens_Per_Module__c: 1.75,
  Install_Hours_Per_Module__c: 2,
  Battery_Labor_Rate__c: 33, Battery_Install_Hours__c: 16,

  // Other costs
  Material_Other_Cost__c: 250, Constructive_Ops_Fee__c: 850, Permit_Pass_Through_Cost__c: 750,

  // Commissions — D19 REDLINE MODEL. The rep commission is READ in dollars off the
  // Commission_Total__c formula field, not computed from a PPW input, so the two
  // rep-PPW fields are gone from this fixture entirely (see COMMISSION_REPIN below for
  // the arithmetic). External + non-Lightreach = redline 1.85:
  //   36502 − 1.85 × 8800 − 3110 = 17112
  Sales_Company_Harmon_Solar_or_Third__c: 'Blue Sky Solar',  // external
  Commission_Total__c: 17112,
  // Management is unchanged: J9 0.055 on the sheet is stored as .04 + .015
  Sales_Mgr_Commission_PPW__c: 0.04,
  Overhead_Commission_PPW__c: 0.015,
  Geo_Commission_Amount__c: 70,           // J10
  Commission_Burden_Rate__c: 75,          // K12
  // D17: setter read through the Customer relationship.
  Sundial_Customer__r: { Setter__c: SETTER_ID },

  // ---- Adders. Selected in the cached example: Sub Panel, Structural,
  //      Bird Blocking, Software, Active Monitoring, LR Warranty, Referral.
  Adder_Sub_Panel_Price__c: 500, Adder_Sub_Panel_Qty__c: 1, Adder_Sub_Panel_Cost__c: 261.4,
  Adder_Derate_Price__c: 600, Adder_Derate_Qty__c: 0, Adder_Derate_Cost__c: 341.4,
  Adder_Heat_Detector_Price__c: 450, Adder_Heat_Detector_Qty__c: 0, Adder_Heat_Detector_Cost__c: 175.2,
  Adder_Upgrade_225_Price__c: 2850, Adder_Upgrade_225_Qty__c: 0, Adder_Upgrade_225_Cost__c: 1540.8,
  Adder_Upgrade_400_Price__c: 4950, Adder_Upgrade_400_Qty__c: 0, Adder_Upgrade_400_Cost__c: 3220.8,
  Adder_Upgrade_225_UG_Price__c: 2500, Adder_Upgrade_225_UG_Qty__c: 0, Adder_Upgrade_225_UG_Cost__c: 1260.8,
  Adder_Gateway3_Price__c: 2950, Adder_Gateway3_Qty__c: 0, Adder_Gateway3_Cost__c: 2175.2,
  Adder_Site_Audit_Price__c: 350, Adder_Site_Audit_Qty__c: 0,
  Adder_Travel_Price__c: 750, Adder_Travel_Qty__c: 0,
  Adder_Conduit_Attic_Price__c: 0.1, Adder_Conduit_Attic_Qty__c: 0, Adder_Conduit_Attic_Cost__c: 0.052,
  Adder_Flat_Roof_Price__c: 0.1, Adder_Flat_Roof_Qty__c: 0, Adder_Flat_Roof_Cost__c: 0.052,
  Adder_Roof_Tile_Price__c: 0.02, Adder_Roof_Tile_Qty__c: 0, Adder_Roof_Tile_Cost__c: 0.009,
  Adder_Structural_Price__c: 500, Adder_Structural_Qty__c: 1, Adder_Structural_Cost__c: 250,
  Adder_Bird_Blocking_Price__c: 0.1, Adder_Bird_Blocking_Qty__c: 1, Adder_Bird_Blocking_Cost__c: 0.06,
  Adder_Small_System_10_12_Price__c: 1250, Adder_Small_System_10_12_Qty__c: 0,
  Adder_Small_System_13_15_Price__c: 1000, Adder_Small_System_13_15_Qty__c: 0,
  Adder_Software_Fee_Price__c: 30, Adder_Software_Fee_Qty__c: 1,
  Adder_Active_Monitoring_Price__c: 100, Adder_Active_Monitoring_Qty__c: 1,
  Adder_LR_Battery_Warranty_Price__c: 600, Adder_LR_Battery_Warranty_Qty__c: 1,
  Adder_Referral_Fee_Price__c: 500, Adder_Referral_Fee_Qty__c: 1,

  // NS blocks 1-5 all empty in the cached example.
  ...[1, 2, 3, 4, 5].reduce((acc, n) => Object.assign(acc, {
    [`NS_Adder_${n}_Description__c`]: '',
    [`NS_Adder_${n}_Markup_Percent__c`]: 25,
    [`NS_Adder_${n}_Material_Cost__c`]: 0,
    [`NS_Adder_${n}_Labor_Hours__c`]: 0,
  }), {}),
};

/**
 * The same job sold INTERNALLY. Only two fields move, and the second is not an
 * independent input — it is what the deployed Salesforce formula returns once the first
 * one changes, so the two must be edited together:
 *
 *   internal + non-Lightreach = redline 2.20
 *   36502 − 2.20 × 8800 − 3110 = 14032
 */
const INTERNAL_DEAL = {
  Sales_Company_Harmon_Solar_or_Third__c: 'Harmon Solar',
  Commission_Total__c: 14032,
};

/**
 * COMMISSION_REPIN — why the commission numbers here are NOT the workbook's.
 *
 * Every non-commission expectation below is still the REVISED workbook's own cached
 * value, extracted cell-by-cell. The commission block and everything downstream of it
 * (J7/J8/K7/J11/J13/J14, J29, J31, the N-column summary, the GP fields) is re-pinned to
 * the D19 redline worked example instead, because the workbook predates the model:
 *
 *   redline 1.85 (external, non-Lightreach)
 *   commission = 36502 − 1.85 × 8800 − 3110 = 17112     → $1.9445/W
 *   subtotal   = 17112 + 484 + 70 = 17666
 *   burden     = 0.75 × (484 + 70) = 415.50              (D21: mgmt + setter ONLY)
 *   total      = 18081.50                                → $2.0547/W all-in
 *
 * The 415.50 is unchanged by D21 — this is an EXTERNAL deal, so the rep amount was
 * never in the basis either way. That also means these cells CANNOT catch a regression
 * in the burden basis; the D21 behaviour tests are what pin it.
 *
 * The 3110 is `stdAdderPriceTotal`, which the workbook and the Salesforce
 * `Total_Adder_Price__c` formula agree on — that agreement is what lets the two halves
 * of this fixture be combined at all.
 */
const CELL_EXPECTED = {
  // Basics
  E7: 8800, E9: 20,
  // Commissions — RE-PINNED to the D19 redline worked example (see COMMISSION_REPIN).
  // J7 is the DERIVED rate now, so it is asserted here rather than echoed from an input.
  J7: 1.9445454545454546, K7: 17112,
  J8: 0, K8: 0,
  K9: 484, K10: 70,
  J11: 17666, J12: 415.5, J13: 18081.5, J14: 2.054715909090909,
  // Material rows
  F12: 5280, F16: 7383.33, F17: 1496, F18: 880, F19: 840,
  // Labor rows
  F21: 56.5, F22: 42.375, F23: 56.5, F24: 42.375,
  F25: 735, F26: 551.25, F27: 1130, G27: 40,
  F28: 753.3333333333333, G28: 26.666666666666664, F29: 565,
  F30: 376.6666666666667, G30: 13.333333333333334, F31: 282.5,
  F32: 528, G32: 16, F33: 396,
  // Acumatica-coded budget lines — the heart of the regression
  J15: 16140.73,  // GENM total material
  J16: 2550,      // GENO other (incl. Active Monitoring + LR Warranty, D12)
  J17: 250,       // SUBCON engineer stamps
  J18: 528,       // SUBCON subcontractor
  J19: 30,        // SOFTWARE
  J20: 500,       // REFERRAL (D13)
  J21: 113,       // GENA audit + QA
  J22: 735,       // ROOFCOM
  J23: 753.3333333333333, // S1
  J24: 376.6666666666667, // S2
  J25: 627,       // S3 = battery + adder + NS labor
  J26: 2605,      // total labor
  J27: 1953.75,   // BURDENEXR
  J28: 24557.48,  // job cost, no commission (D11: everything included)
  J29: 42638.98,  // with commission — D19 re-pin
  J30: 2.7906227272727273,
  J31: 4.845338636363636,  // D19 re-pin
  // Hours
  J32: 63, J33: 4, J34: 26.666666666666664, J35: 13.333333333333334, J36: 19,
  // Adder rollups
  K39: 3110, K40: 261.4, K41: 99, K42: 74.25, K43: 173.25, K44: 434.65, L41: 3,
  // Individual adder rows
  D40: 500, E40: 3, F40: 99, G40: 74.25, I40: 261.4,
  D55: 500, E55: 250, D56: 880, E56: 528,
  D60: 30, E60: 30, D61: 100, E61: 100, D62: 600, E62: 600, D63: 500, E63: 500,
  // Summary / GP block. N11/N12/N13 are cost-side and unmoved; N9/N10/N14/N15/N16 are
  // the D19 re-pin.
  //
  // ⚠️ N14 IS NEGATIVE, and that is expected here rather than a failing assertion in
  // disguise. The fixture is the REVISED workbook's COST example bolted onto the D19
  // COMMISSION model, and the two were never priced against each other: a 17,112
  // commission on a 36,502 contract leaves 18,420.50 to cover 24,557.48 of job cost.
  // Both halves are individually correct, which is exactly what the test is for. Do NOT
  // "fix" this by tuning the fixture's contract until GP goes positive — that would
  // unpin the cost cells from the workbook they came from. A real record with real
  // Harmon numbers is where GP plausibility gets checked.
  N9: 18081.5, N10: 18420.5, N11: 16140.73, N12: 4558.75, N13: 3858,
  N14: -6136.98, N15: -0.16812722590542983, N16: -0.3331603376672729,
};

/** What lands on the Salesforce record. */
const FIELD_EXPECTED = {
  System_Size_Watts__c: 8800,
  Calculated_Module_Count__c: 20,
  Sales_Rep_Commission_Amt__c: 17112,  // the THIRD-PARTY amount, straight from D19
  Sales_Mgr_Commission_Amt__c: 352,    // .04 × 8800 — component, not the SLMC line
  Overhead_Commission_Amt__c: 132,     // .015 × 8800
  Commission_Subtotal__c: 17666,
  Commission_Burden_Amt__c: 415.5,     // D21: 0.75 × (mgmt 484 + setter 70), no rep
  Total_Commissions__c: 18081.5,
  Commission_PPW__c: 2.054715909090909,
  Module_Material_Cost__c: 5280,
  Battery_Material_Cost__c: 7383.33,
  BOS_Solar_Cost__c: 1496,
  BOS_Electrical_Cost__c: 880,
  Roofing_Material_Cost__c: 840,
  Audit_Labor_Cost__c: 113,            // GENA line = audit + QA
  QA_Labor_Cost__c: 56.5,
  Roofing_Labor_Cost__c: 735,
  Solar_Install_Labor_Total__c: 1130,
  S1_Labor_Cost__c: 753.3333333333333,
  S2_Labor_Cost__c: 376.6666666666667,
  S3_Labor_Cost__c: 627,
  Std_Adder_Material_Total__c: 261.4,
  Std_Adder_Labor_Total__c: 99,
  Std_Adder_Burden_Total__c: 74.25,
  Std_Adder_Hours_Total__c: 3,
  NS_Adder_Material_Total__c: 0,
  Adder_Labor_Total__c: 99,
  Adder_Burden_Total__c: 74.25,
  Adder_Hours_Total__c: 3,
  Total_Material_Budget__c: 16140.73,
  Total_Other_Budget__c: 2550,
  Total_Labor_Budget__c: 2605,          // J26 — labor ONLY
  Total_Labor_Burden_Budget__c: 1953.75,
  Constructive_Ops_Total__c: 1600,
  Total_Job_Cost__c: 24557.48,
  Total_Job_Cost_With_Comm__c: 42638.98,
  Cost_PPW__c: 2.7906227272727273,
  Cost_PPW_With_Comm__c: 4.845338636363636,
  GENA_Hours__c: 4,
  S1_Hours__c: 26.666666666666664,
  S2_Hours__c: 13.333333333333334,
  S3_Hours__c: 19,
  Total_Job_Hours__c: 63,
  Balance_of_Revenue__c: 18420.5,
  Total_Labor_And_Burden__c: 4558.75,   // N12 — labor AND burden
  // Negative by construction — see the note on the N14 cell expectation.
  GP_Dollars__c: -6136.98,
  GP_Percent_With_Comm__c: -16.81,
  GP_Percent_No_Comm__c: -33.32,

  // The §D output fields, promoted out of `extras` once they were deployed.
  Internal_Rep_Commission_Amt__c: 0,
  Management_Commission_Amt__c: 484,     // (.04 + .015) × 8800 — the SLMC line
  Setter_Commission_Amt__c: 70,
  DC_Rebate_Amount__c: 0,
  Engineer_Stamps_Cost__c: 250,
  Subcontractor_Cost__c: 528,
  Total_Other_Summary__c: 3858,          // N13 — NOT Total_Other_Budget__c (2550)
};

/** v2 values with no Salesforce home yet — see the output gap list. */
const EXTRAS_EXPECTED = {
  redlineCommissionAmt: 17112,
  redlineCommissionPPW: 1.9445454545454546,
  thirdPartyCommissionAmt: 17112,
  internalCommissionAmt: 0,
  managementCommissionAmt: 484,   // the SLMC line: (.04 + .015) × 8800
  setterCommissionAmt: 70,
  dcRebateAmount: 0,
  engineerStampsCost: 250,
  subcontractorCost: 528,
  softwareCost: 30,
  referralCost: 500,
  genoAdderCost: 700,             // Active Monitoring 100 + LR Warranty 600
  summaryTotalOther: 3858,
  nsAdder4Total: 0,
  nsAdder5Total: 0,
  stdAdderPriceTotal: 3110,
};

// ---------------------------------------------------------------------------
let failures = 0;
let checks = 0;
const near = (label, got, exp) => {
  checks++;
  if (typeof got !== 'number' || Math.abs(got - exp) > TOL) {
    console.error(`FAIL ${label}: expected ${exp}, got ${got}`);
    failures++;
  }
};

const { fields, cells, extras } = calculateBudget(REVISED);

for (const [ref, exp] of Object.entries(CELL_EXPECTED)) near(`cell ${ref}`, cells[ref], exp);
for (const [k, exp] of Object.entries(FIELD_EXPECTED)) near(`field ${k}`, fields[k], exp);
for (const [k, exp] of Object.entries(EXTRAS_EXPECTED)) near(`extra ${k}`, extras[k], exp);

// Deal type is a string, not a number.
checks++;
if (extras.dealType !== 'third_party') {
  console.error(`FAIL extras.dealType: expected 'third_party', got ${extras.dealType}`);
  failures++;
}
// ...and so is the company that decided it (D19).
checks++;
if (extras.salesCompany !== 'Blue Sky Solar') {
  console.error(`FAIL extras.salesCompany: expected 'Blue Sky Solar', got ${extras.salesCompany}`);
  failures++;
}
checks++;
if (extras.setterUserId !== SETTER_ID) {
  console.error(`FAIL extras.setterUserId: expected ${SETTER_ID}, got ${extras.setterUserId}`);
  failures++;
}

// ---------------------------------------------------------------------------
// v2 behaviours the cached example does not exercise
// ---------------------------------------------------------------------------
const it = (name, fn) => {
  checks++;
  try { fn(); } catch (e) { console.error(`FAIL ${name}: ${e.message}`); failures++; }
};

it('Commission_Deal_Type__c writes the PICKLIST LABEL, never the internal token', () => {
  // The field is a RESTRICTED picklist — 'third_party' would be rejected on save.
  assert.strictEqual(fields.Commission_Deal_Type__c, '3rd Party');
  assert.strictEqual(extras.dealType, 'third_party');

  const internal = calculateBudget({ ...REVISED, ...INTERNAL_DEAL });
  assert.strictEqual(internal.fields.Commission_Deal_Type__c, 'Internal');

  // Every emitted label must be one the picklist actually accepts. ('None' is still a
  // picklist value but is no longer reachable — a blank sales company throws.)
  const ALLOWED = new Set(['3rd Party', 'Internal', 'None']);
  for (const r of [fields, internal.fields]) {
    assert.ok(ALLOWED.has(r.Commission_Deal_Type__c), `bad picklist value ${r.Commission_Deal_Type__c}`);
  }
});

it('D19: the push worker still gets its v2 marker — the calc always sets a deal type', () => {
  // The push lambda refuses to write unless Commission_Deal_Type__c is populated (that
  // is how it tells a v2/v3 budget from a v1 one). D19 changed WHAT sets the field, so
  // this asserts the guard's precondition still holds under the new discriminator.
  for (const variant of [{}, INTERNAL_DEAL, { ...INTERNAL_DEAL, Commission_Total__c: 0 }]) {
    const r = calculateBudget({ ...REVISED, ...variant });
    assert.ok(
      r.fields.Commission_Deal_Type__c === '3rd Party' || r.fields.Commission_Deal_Type__c === 'Internal',
      `deal type was ${r.fields.Commission_Deal_Type__c}`
    );
  }
});

it('the §D fields track their extras twins exactly', () => {
  const pairs = [
    ['Internal_Rep_Commission_Amt__c', 'internalCommissionAmt'],
    ['Management_Commission_Amt__c', 'managementCommissionAmt'],
    ['Setter_Commission_Amt__c', 'setterCommissionAmt'],
    ['DC_Rebate_Amount__c', 'dcRebateAmount'],
    ['Engineer_Stamps_Cost__c', 'engineerStampsCost'],
    ['Subcontractor_Cost__c', 'subcontractorCost'],
    ['Total_Other_Summary__c', 'summaryTotalOther'],
  ];
  // They are deliberately in both maps; if they ever disagree, one of them is stale.
  for (const [f, x] of pairs) assert.strictEqual(fields[f], extras[x], `${f} != extras.${x}`);
});

it('D19: an INTERNAL deal routes to the internal amount, and D21: it is NOT burdened', () => {
  const r = calculateBudget({ ...REVISED, ...INTERNAL_DEAL });
  assert.strictEqual(r.extras.dealType, 'internal');
  assert.ok(Math.abs(r.extras.internalCommissionAmt - 14032) < TOL);
  assert.ok(Math.abs(r.extras.thirdPartyCommissionAmt) < TOL);
  // D21: burden is 0.75 × (484 + 70) = 415.50 — management and setter only. The rep
  // amount is NOT in the basis, so this is the same 415.50 the external case produces.
  // Before D21 it was 0.75 × (14032 + 484 + 70) = 10939.50.
  assert.ok(
    Math.abs(r.fields.Commission_Burden_Amt__c - 415.5) < TOL,
    `internal burden was ${r.fields.Commission_Burden_Amt__c}`
  );
  // 14032 + 484 + 70 + 415.50
  assert.ok(Math.abs(r.fields.Total_Commissions__c - 15001.5) < TOL);
});

it('D21: burden is identical whichever way the deal is sold', () => {
  // The single sentence of the ruling, as an assertion: routing picks the Acumatica
  // line and nothing else. If someone restores the sheet's K8-in-the-burden-array
  // behaviour, this fails — the main fixture cannot, because it is an external deal
  // where the internal cell is zero and both formulas agree.
  const ext = calculateBudget(REVISED).fields.Commission_Burden_Amt__c;
  const int = calculateBudget({ ...REVISED, ...INTERNAL_DEAL }).fields.Commission_Burden_Amt__c;
  assert.ok(Math.abs(ext - int) < TOL, `external ${ext} != internal ${int}`);
  assert.ok(Math.abs(ext - 415.5) < TOL);
});

it('D21: the rep commission is absent from the burden basis at any size', () => {
  // Scaling the rep amount by 10x must not move burden by a cent. A basis bug that
  // happened to be small on the fixture would still show up here.
  const base = calculateBudget({ ...REVISED, ...INTERNAL_DEAL }).fields.Commission_Burden_Amt__c;
  for (const amt of [0, 1000, 140320]) {
    const r = calculateBudget({ ...REVISED, ...INTERNAL_DEAL, Commission_Total__c: amt });
    assert.ok(
      Math.abs(r.fields.Commission_Burden_Amt__c - base) < TOL,
      `rep ${amt} moved burden to ${r.fields.Commission_Burden_Amt__c}`
    );
  }
});

it('D19: "Harmon Solar" is matched case-insensitively, like the Salesforce formula', () => {
  // SF formula `=` on text ignores case; if the calc were stricter than the formula, a
  // record could get the INTERNAL redline from the formula and the EXTERNAL routing
  // from the calc — the commission would be right and land on the wrong line.
  for (const spelling of ['Harmon Solar', 'HARMON SOLAR', 'harmon solar', '  Harmon Solar  ']) {
    const r = calculateBudget({ ...REVISED, ...INTERNAL_DEAL, Sales_Company_Harmon_Solar_or_Third__c: spelling });
    assert.strictEqual(r.extras.dealType, 'internal', `"${spelling}" did not read as internal`);
  }
});

it('D19: any other sales company is EXTERNAL — a new dealer needs no code change', () => {
  for (const company of ['Blue Sky Solar', 'Some Dealer Added Next Tuesday', 'Harmon Roofing']) {
    const r = calculateBudget({ ...REVISED, Sales_Company_Harmon_Solar_or_Third__c: company });
    assert.strictEqual(r.extras.dealType, 'third_party', `"${company}" did not read as external`);
    assert.ok(Math.abs(r.extras.thirdPartyCommissionAmt - 17112) < TOL);
  }
});

it('D19: a BLANK sales company throws — it does not default to external', () => {
  // Defaulting would quietly pay the external redline on the ~83% of Solar records that
  // have no company set. A blank field is a question someone answers; a wrong number is
  // one nobody asks.
  for (const blank of [null, undefined, '', '   ']) {
    assert.throws(
      () => calculateBudget({ ...REVISED, Sales_Company_Harmon_Solar_or_Third__c: blank }),
      (e) => e instanceof BudgetInputError && e.code === 'SALES_COMPANY_MISSING',
      `blank value ${JSON.stringify(blank)} did not throw`
    );
  }
});

it('D19: a blank Commission_Total__c throws rather than posting a $0 commission', () => {
  // The realistic cause is the integration user missing Read FLS on the formula field,
  // which makes SOQL omit it entirely. Silently reading that as zero would produce a
  // plausible-looking budget with no commission on it at all.
  for (const blank of [null, undefined, '']) {
    assert.throws(
      () => calculateBudget({ ...REVISED, Commission_Total__c: blank }),
      (e) => e instanceof BudgetInputError && e.code === 'COMMISSION_TOTAL_UNAVAILABLE',
      `blank value ${JSON.stringify(blank)} did not throw`
    );
  }
  // Zero is NOT blank: a redline that eats the whole contract is a legitimate answer.
  const zero = calculateBudget({ ...REVISED, Commission_Total__c: 0 });
  assert.strictEqual(zero.extras.thirdPartyCommissionAmt, 0);
  assert.strictEqual(zero.fields.Commission_Deal_Type__c, '3rd Party');
});

it('D19: the retired PPW fields are inert — setting them changes nothing', () => {
  // They still exist on the object. If someone repopulates one out of habit, the calc
  // must ignore it rather than resurrect the old model or throw the old ambiguity error.
  const r = calculateBudget({
    ...REVISED,
    Sales_Rep_Commission_PPW__c: 0.25,
    Internal_Rep_Commission_PPW__c: 0.9,
  });
  assert.ok(Math.abs(r.extras.thirdPartyCommissionAmt - 17112) < TOL);
  assert.strictEqual(r.extras.internalCommissionAmt, 0);
  assert.ok(Math.abs(r.fields.Total_Commissions__c - 18081.5) < TOL);
});

it('D19: the snapshot rate cell multiplies out to the amount cell beside it', () => {
  // The workbook has to be internally consistent — J7 × watts must equal K7, or the
  // snapshot shows a rate that does not explain its own total.
  const ext = calculateBudget(REVISED).cells;
  assert.ok(Math.abs(ext.J7 * ext.E7 - ext.K7) < TOL, `J7 × watts != K7 (${ext.J7 * ext.E7} vs ${ext.K7})`);
  assert.strictEqual(ext.J8, 0);   // the unused side stays empty, not stale

  const int = calculateBudget({ ...REVISED, ...INTERNAL_DEAL }).cells;
  assert.ok(Math.abs(int.J8 * int.E7 - int.K8) < TOL, `J8 × watts != K8 (${int.J8 * int.E7} vs ${int.K8})`);
  assert.strictEqual(int.J7, 0);
});

it('D17: no setter on the Customer means no setter commission', () => {
  const r = calculateBudget({ ...REVISED, Sundial_Customer__r: { Setter__c: null } });
  assert.strictEqual(r.extras.setterCommissionAmt, 0);
  // Burden drops by 0.75 × 70 = 52.50, and the total by the 70 as well: 18081.50 − 122.50.
  assert.ok(Math.abs(r.fields.Commission_Burden_Amt__c - 363) < TOL);
  assert.ok(Math.abs(r.fields.Total_Commissions__c - 17959) < TOL);
});

it('D17: the setter is also readable from a flattened relationship key', () => {
  const flat = { ...REVISED };
  delete flat.Sundial_Customer__r;
  flat['Sundial_Customer__r.Setter__c'] = SETTER_ID;
  assert.strictEqual(calculateBudget(flat).extras.setterCommissionAmt, 70);
});

it('D15: a blank Cost on a SELECTED adder throws instead of costing zero', () => {
  assert.throws(
    () => calculateBudget({ ...REVISED, Adder_Sub_Panel_Cost__c: null }),
    (e) => e instanceof BudgetInputError && e.code === 'ADDER_COST_MISSING'
  );
});

it('D15: a blank Cost on an UNSELECTED adder is fine', () => {
  const r = calculateBudget({ ...REVISED, Adder_Derate_Cost__c: null });
  assert.ok(Math.abs(r.fields.Total_Job_Cost__c - 24557.48) < TOL);
});

it('D15: cost is READ, not derived — changing price alone must not move job cost', () => {
  const r = calculateBudget({ ...REVISED, Adder_Sub_Panel_Price__c: 5000 });
  assert.ok(
    Math.abs(r.fields.Total_Job_Cost__c - 24557.48) < TOL,
    `job cost moved to ${r.fields.Total_Job_Cost__c} when only the PRICE changed`
  );
  // ...but the commission-side price total does move.
  assert.ok(Math.abs(r.extras.stdAdderPriceTotal - 7610) < TOL);
});

it('D15: per-watt cost multiplies by WATTS, not by qty', () => {
  const r = calculateBudget({ ...REVISED, Adder_Flat_Roof_Qty__c: 1 });
  // material += 0.052 × 8800 = 457.60; labor += 0.02 × 8800 = 176; burden += 132
  assert.ok(Math.abs(r.fields.Std_Adder_Material_Total__c - (261.4 + 457.6)) < TOL);
  assert.ok(Math.abs(r.fields.Std_Adder_Labor_Total__c - (99 + 176)) < TOL);
  // Doubling qty must NOT double material or labor (only the price side scales).
  const r2x = calculateBudget({ ...REVISED, Adder_Flat_Roof_Qty__c: 2 });
  assert.ok(Math.abs(r2x.fields.Std_Adder_Material_Total__c - r.fields.Std_Adder_Material_Total__c) < TOL);
  assert.ok(Math.abs(r2x.fields.Std_Adder_Labor_Total__c - r.fields.Std_Adder_Labor_Total__c) < TOL);
});

it('D2: domestic content adds a 0.45/W revenue line and lifts GP by the same', () => {
  const r = calculateBudget({ ...REVISED, Domestic_Content__c: 'YES' });
  assert.ok(Math.abs(r.extras.dcRebateAmount - 3960) < TOL);         // 0.45 × 8800
  // The rebate is pure upside: it is NOT in the D19 commission formula (contract −
  // redline×W − adders), so it lifts revenue and GP by its full amount and moves the
  // commission not at all.
  assert.ok(Math.abs(r.fields.Balance_of_Revenue__c - (18420.5 + 3960)) < TOL);
  assert.ok(Math.abs(r.fields.GP_Dollars__c - (-6136.98 + 3960)) < TOL);
  assert.ok(Math.abs(r.fields.Total_Commissions__c - 18081.5) < TOL);
});

it('DC parsing is permissive on affirmatives and defaults to NO', () => {
  for (const v of ['YES', 'yes', ' Yes ', 'true', '1', true]) {
    assert.ok(calculateBudget({ ...REVISED, Domestic_Content__c: v }).extras.domesticContent, `${v} should be DC`);
  }
  for (const v of ['NO', '', null, undefined, 'maybe', 'N']) {
    assert.ok(!calculateBudget({ ...REVISED, Domestic_Content__c: v }).extras.domesticContent, `${v} should NOT be DC`);
  }
});

it('Travel hours are a selection FLAG, not hours × qty (sheet E52)', () => {
  const one = calculateBudget({ ...REVISED, Adder_Travel_Qty__c: 1 });
  const two = calculateBudget({ ...REVISED, Adder_Travel_Qty__c: 2 });
  assert.ok(Math.abs(one.fields.Std_Adder_Hours_Total__c - (3 + 12)) < TOL);
  assert.strictEqual(two.fields.Std_Adder_Hours_Total__c, one.fields.Std_Adder_Hours_Total__c);
  // ...and Travel is priced at the BLENDED rate, not the Powerwall rate.
  assert.ok(Math.abs(one.fields.Std_Adder_Labor_Total__c - (99 + 12 * 28.25)) < TOL);
});

it('Site Audit is labor-only: hours and labor, but no material', () => {
  const r = calculateBudget({ ...REVISED, Adder_Site_Audit_Qty__c: 1 });
  assert.ok(Math.abs(r.fields.Std_Adder_Material_Total__c - 261.4) < TOL); // unchanged
  assert.ok(Math.abs(r.fields.Std_Adder_Labor_Total__c - (99 + 2 * 28.25)) < TOL);
});

it('NS blocks 4 and 5 are live and use the POWERWALL rate', () => {
  const r = calculateBudget({
    ...REVISED,
    NS_Adder_4_Material_Cost__c: 1000, NS_Adder_4_Labor_Hours__c: 10, NS_Adder_4_Markup_Percent__c: 25,
    NS_Adder_5_Material_Cost__c: 500, NS_Adder_5_Labor_Hours__c: 4, NS_Adder_5_Markup_Percent__c: 25,
  });
  // labor at 33/hr: 330 + 132; burden 75%: 247.5 + 99
  assert.ok(Math.abs(r.fields.NS_Adder_Material_Total__c - 1500) < TOL);
  assert.ok(Math.abs(r.fields.Adder_Labor_Total__c - (99 + 330 + 132)) < TOL);
  assert.ok(Math.abs(r.extras.nsAdder4Total - (1000 + 250 + 330 + 247.5)) < TOL);
  // The MARKUP must not reach the material budget (sheet J15 pulls G68, no markup).
  assert.ok(Math.abs(r.fields.Total_Material_Budget__c - (16140.73 + 1500)) < TOL);
});

it('D14: small systems are revenue-only — they touch price, never cost', () => {
  const r = calculateBudget({ ...REVISED, Adder_Small_System_10_12_Qty__c: 1 });
  assert.ok(Math.abs(r.fields.Total_Job_Cost__c - 24557.48) < TOL);
  assert.ok(Math.abs(r.extras.stdAdderPriceTotal - (3110 + 1250)) < TOL);
});

it('D11: every cost line is inside Total Job Cost', () => {
  // Drop the four lines BRADS excluded and job cost must fall by exactly their sum.
  const r = calculateBudget({
    ...REVISED,
    Adder_Structural_Qty__c: 0, Adder_Bird_Blocking_Qty__c: 0,
    Adder_Software_Fee_Qty__c: 0, Adder_Referral_Fee_Qty__c: 0,
  });
  assert.ok(
    Math.abs(r.fields.Total_Job_Cost__c - (24557.48 - 250 - 528 - 30 - 500)) < TOL,
    `job cost was ${r.fields.Total_Job_Cost__c}`
  );
});

it('D12: GENO absorbs Active Monitoring and LR Battery Warranty', () => {
  const r = calculateBudget({
    ...REVISED, Adder_Active_Monitoring_Qty__c: 0, Adder_LR_Battery_Warranty_Qty__c: 0,
  });
  assert.ok(Math.abs(r.fields.Total_Other_Budget__c - (2550 - 700)) < TOL);
});

// ---------------------------------------------------------------------------
assert.strictEqual(failures, 0, `${failures} of ${checks} checks failed`);
console.log(`budgetCalc v2: all ${checks} checks pass (${Object.keys(CELL_EXPECTED).length} cells, ${Object.keys(FIELD_EXPECTED).length} fields, ${Object.keys(EXTRAS_EXPECTED).length} extras, ${checks - Object.keys(CELL_EXPECTED).length - Object.keys(FIELD_EXPECTED).length - Object.keys(EXTRAS_EXPECTED).length} behaviours)`);

buildWorkbook(cells, { recordId: 'a0XTEST00000001', generatedAt: '2026-08-20T12:00:00Z' }).then((buf) => {
  const key = snapshotKey('a0XTEST00000001', 'REVISED EXAMPLE', new Date('2026-08-20T12:00:00Z'));
  const out = path.join(os.tmpdir(), 'sundial-budget-snapshot-test.xlsx');
  fs.writeFileSync(out, Buffer.from(buf));
  console.log(`workbook snapshot written (${buf.byteLength} bytes) -> ${out}`);
  console.log(`key example: ${key}`);
});
