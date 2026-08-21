/**
 * budgetCalc.js — Sundial Solar budget calculator, v2 (pure function, no I/O)
 *
 * Ported cell-for-cell from `template/budget-template-v2.xlsx` — the REVISED workbook
 * (`Harmon Budget Revised 82026.xlsx`), which supersedes HOLLAND and BRADS as the
 * source of truth (D1). Every rollup and budget-line cell in that workbook's cached
 * example is reproduced by test.js.
 *
 * Input:  a plain object of Sundial_Solar__c field values (API names as keys), plus
 *         the read-through `Sundial_Customer__r.Setter__c` (D17).
 * Output: { fields, cells }
 *   fields — output field values keyed by Salesforce API name, ready for record update
 *   cells  — every input + computed spreadsheet cell keyed by A1 reference (REVISED
 *            layout), ready for the snapshot generator (budgetWorkbook.js)
 *
 * WHAT CHANGED FROM v1 — the four things that will trip you up if you skim:
 *
 *  1. COMMISSIONS ARE FOUR INPUTS, NOT THREE (D9/D10/D16/D17). Third-party rep and
 *     internal rep are now SEPARATE fields hitting DIFFERENT budget lines, and which
 *     one is populated decides the deal type. Management is stored as two fields but
 *     SUMMED into one cost line. Setter is gated on the CUSTOMER's Setter__c, read
 *     through the relationship because Solar has no such field.
 *  2. COSTS ARE READ, NEVER DERIVED (D15). v1 backed material out of price
 *     (`price − labor − burden`, ÷1.25). v2 reads Adder_<X>_Cost__c and multiplies —
 *     by QTY for flat adders, by WATTS for per-watt adders. The sheet still SHOWS the
 *     derivation (columns H/I) because that is where the defaults came from, but the
 *     calc does not run it.
 *  3. EVERY COST LINE ROLLS UP (D11/D12/D13). The BRADS anomaly where SUBCON /
 *     SOFTWARE / REFERRAL were computed but excluded from Total Job Cost is fixed, and
 *     GENO absorbed Active Monitoring + LightReach Battery Warranty (D12).
 *  4. `Total_Labor_Budget__c` MEANS SOMETHING DIFFERENT. Sheet J26 is labor only;
 *     sheet N12 ("Total Labor" on the summary block) is labor PLUS burden. Both exist,
 *     they differ by 1,953.75 in the fixture, and the GP formula uses N12.
 *
 * Salesforce percent fields arrive as whole numbers (75 means 75%) — divided by 100 here.
 */

// ---------------------------------------------------------------------------
// Constants that are NOT Salesforce fields
// ---------------------------------------------------------------------------

/**
 * LightReach domestic-content rebate, dollars per watt (D2). Hardcoded because there is
 * no SF field for the RATE — only the yes/no toggle. Sheet D4: IF(D3="YES", 0.45).
 */
const DC_REBATE_PPW = 0.45;

/**
 * The sheet hardcodes 75% on every adder and NS burden row (G40 `=F40*75%`,
 * D72 `=D71*75%`) rather than referencing B19. Preserved literally: a job that
 * overrides Labor_Burden_Rate__c would still get 75% on adders in the real workbook,
 * and the calc must not silently disagree with the sheet it snapshots.
 */
const ADDER_BURDEN_RATE = 0.75;

/**
 * Internal deal-type token -> the `Commission_Deal_Type__c` picklist LABEL.
 *
 * The field is a RESTRICTED picklist, so a raw token ('third_party') is not merely
 * ugly — Salesforce rejects the save outright. The tokens stay snake_case in `extras`
 * because that is what the push worker and the portal branch on; the label is a
 * presentation concern that belongs at the boundary.
 */
const DEAL_TYPE_PICKLIST = {
  third_party: '3rd Party',
  internal: 'Internal',
  none: 'None',
};

/** Per-watt labor coefficients, sheet F49/F50 (0.02) and F51 (0.005). */
const PPW_LABOR_CONDUIT = 0.02;
const PPW_LABOR_FLAT_ROOF = 0.02;
const PPW_LABOR_ROOF_TILE = 0.005;

// ---------------------------------------------------------------------------
// Adder catalog — REVISED layout
// ---------------------------------------------------------------------------

/**
 * FLAT adders (rows 40-47, 52). Price = price × qty. Labor = hours × rate.
 * Material comes from the Cost field × qty (D15), except the labor-only rows.
 *
 * `rate: 'blended'` is Site Audit and Travel only — everything else is priced at the
 * Powerwall rate (sheet F40 `=E40*B28` vs F47 `=E47*B18`).
 *
 * `hoursFlag: true` is the Travel quirk: sheet E52 is `IF(C52=1, 12, 0)`, a SELECTION
 * flag, not hours × qty. Two travel adders still bill twelve hours.
 */
const FLAT_ADDERS = [
  { base: 'Sub_Panel',       row: 40, hoursPerUnit: 3,  rate: 'powerwall', cost: true },
  { base: 'Derate',          row: 41, hoursPerUnit: 3,  rate: 'powerwall', cost: true },
  { base: 'Heat_Detector',   row: 42, hoursPerUnit: 4,  rate: 'powerwall', cost: true },
  { base: 'Upgrade_225',     row: 43, hoursPerUnit: 16, rate: 'powerwall', cost: true },
  { base: 'Upgrade_400',     row: 44, hoursPerUnit: 16, rate: 'powerwall', cost: true },
  { base: 'Upgrade_225_UG',  row: 45, hoursPerUnit: 16, rate: 'powerwall', cost: true },
  { base: 'Gateway3',        row: 46, hoursPerUnit: 4,  rate: 'powerwall', cost: true },
  // Labor-only: no Cost field, no material (sheet row 47 has H but no I).
  { base: 'Site_Audit',      row: 47, hoursPerUnit: 2,  rate: 'blended',   cost: false },
  // Labor-only AND flag-based hours (sheet row 52 has neither H nor I).
  { base: 'Travel',          row: 52, hoursPerUnit: 12, rate: 'blended',   cost: false, hoursFlag: true },
];

/**
 * PER-WATT adders (rows 49-51). Three different multipliers on one row, and they do
 * NOT agree — this is the sheet's shape, preserved:
 *   price    = ppwPrice × watts × QTY     (D49 — scales with qty)
 *   labor    = coeff × watts, gated on selection, NOT × qty  (F49 `IF(C49=1, …)`)
 *   material = ppwCost × watts, gated on selection, NOT × qty (D15)
 * So a qty of 2 doubles the revenue and nothing else.
 */
const PPW_ADDERS = [
  { base: 'Conduit_Attic', row: 49, laborPerWatt: PPW_LABOR_CONDUIT },
  { base: 'Flat_Roof',     row: 50, laborPerWatt: PPW_LABOR_FLAT_ROOF },
  { base: 'Roof_Tile',     row: 51, laborPerWatt: PPW_LABOR_ROOF_TILE },
];

/**
 * BUDGET-ONLY adders (rows 55-56): they carry a price on the commission side and a
 * single cost line, with no labor, no hours, and no share of GENM material.
 *   Structural     → SUBCON Engineering  (J17)
 *   Bird_Blocking  → SUBCON Subcontractor (J18)
 */
const SUBCON_ADDERS = [
  { base: 'Structural',    row: 55, priceKind: 'flat', costKind: 'unit', line: 'engineerStamps' },
  { base: 'Bird_Blocking', row: 56, priceKind: 'ppw',  costKind: 'watt', line: 'subcontractor' },
];

/**
 * PASS-THROUGH / revenue rows (58-63). Sheet E = D, i.e. the cost IS the price — these
 * have no Cost field in §4c and none is wanted.
 *   `line: null` = revenue-only, no cost anywhere (D14).
 */
const PASSTHROUGH_ADDERS = [
  { base: 'Small_System_10_12',  row: 58, line: null },
  { base: 'Small_System_13_15',  row: 59, line: null },
  { base: 'Software_Fee',        row: 60, line: 'software' },
  { base: 'Active_Monitoring',   row: 61, line: 'geno' },
  { base: 'LR_Battery_Warranty', row: 62, line: 'geno' },
  { base: 'Referral_Fee',        row: 63, line: 'referral' },
];

/** NS blocks 1-5 and their REVISED cell addresses (rows 68/76/84/92/100). */
const NS_BLOCKS = [1, 2, 3, 4, 5].map((n, i) => {
  const base = 68 + i * 8;
  return {
    n,
    descCell: `A${base - 1}`,
    totalCell: `D${base}`,
    markupOutCell: `D${base + 1}`,
    markupCell: `B${base + 1}`,
    matCell: `D${base + 2}`,
    hoursCell: `C${base + 3}`,
    laborCell: `D${base + 3}`,
    hoursOutCell: `E${base + 3}`,
    burdenCell: `D${base + 4}`,
  };
});

const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? 0 : Number(v));
const r2 = (v) => Math.round(v * 100) / 100;

/** Is a value absent for the purposes of the D15 "cost must be present" check? */
const isBlank = (v) => v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v));

/**
 * Read the setter through the Customer relationship (D17).
 *
 * `Setter__c` exists only on Sundial_Customer__c and is deliberately NOT mirrored onto
 * Solar or copied by Create Project, so the calc reads it via
 * `Sundial_Customer__r.Setter__c` in its input SOQL. jsforce/REST returns that as a
 * nested object; a flattened key is accepted too so a hand-built record still works.
 *
 * Reading through rather than mirroring means a setter added to the Customer AFTER the
 * project was created flows into the next recalc with no backfill.
 */
function resolveSetterId(rec) {
  const nested = rec?.Sundial_Customer__r;
  const viaNested = nested && typeof nested === 'object' ? nested.Setter__c : undefined;
  const viaFlat = rec?.['Sundial_Customer__r.Setter__c'];
  const v = viaNested ?? viaFlat ?? null;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * Domestic Content → does this job get the DC rebate revenue line?
 *
 * SOURCE FIELD: `Sundial_Solar__c.Domestic_Content__c`. It is the ONLY domestic-content
 * field on the object the calc reads. (Customer has `Domestic_Content_Eligible__c`, a
 * Yes/No picklist — "eligible" is a different question from "elected", and the calc is
 * Solar-side, so it is not used here.)
 *
 * ⚠️ It is an unrestricted TEXT field, so it can hold anything. Parsed permissively for
 * affirmatives and defaulted to NO: a missing or unrecognised value must never invent a
 * $0.45/W revenue line. Sheet D3 is a YES/NO validation list (Sheet2), which a picklist
 * or checkbox would model better — flagged in the rework doc.
 */
function isDomesticContent(rec) {
  const raw = rec?.Domestic_Content__c;
  if (raw === true) return true;
  if (typeof raw !== 'string') return false;
  return ['yes', 'y', 'true', '1'].includes(raw.trim().toLowerCase());
}

/** Typed calc error so the handler can distinguish bad data from a bug. */
class BudgetInputError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BudgetInputError';
    this.code = code || 'BUDGET_INPUT_ERROR';
  }
}

function calculateBudget(rec) {
  const g = (f) => num(rec[f]);

  // ---- Rates -------------------------------------------------------------
  const burden = g('Labor_Burden_Rate__c') / 100;         // B19
  const commBurdenRate = g('Commission_Burden_Rate__c') / 100; // K12

  // ---- Basics ------------------------------------------------------------
  const watts = g('System_Size__c') * 1000;               // E7
  const moduleWatts = g('Module_STC_Wattage__c');         // B8 / F7
  const mods = moduleWatts > 0 ? watts / moduleWatts : 0; // E9

  // =========================================================================
  // Commissions (D9 / D10 / D16 / D17)
  // =========================================================================
  const thirdPartyPPW = g('Sales_Rep_Commission_PPW__c');       // J7 (repurposed)
  const internalPPW = g('Internal_Rep_Commission_PPW__c');      // J8 (new, §4d)

  // D16: which rep field is populated IS the deal type, so both populated is not a
  // number to reconcile — it is a record nobody has decided about. Fail loudly rather
  // than pick one and quietly bill the wrong budget line (and, downstream, either
  // create commission POs that shouldn't exist or skip ones that should).
  if (thirdPartyPPW > 0 && internalPPW > 0) {
    throw new BudgetInputError(
      'Both Sales_Rep_Commission_PPW__c (3rd party) and Internal_Rep_Commission_PPW__c ' +
        'are greater than zero. A deal is either third-party or internal (D16) — the two ' +
        'route to different budget lines and different PO behaviour. Clear one before recalculating.',
      'COMMISSION_DEAL_TYPE_AMBIGUOUS'
    );
  }

  const thirdPartyComm = thirdPartyPPW * watts;                 // K7 → SLPC OUT · M1&M2COM
  const internalComm = internalPPW * watts;                     // K8 → SLPC · SALESCOMM

  // D10: two stored inputs, ONE cost line. The components survive into the outputs
  // because the Acumatica attribute sync splits them apart again (MGRCOM* from .04,
  // MGMTOR* from .015) — summing them here and nowhere else would lose that.
  const mgrPPW = g('Sales_Mgr_Commission_PPW__c');
  const overheadPPW = g('Overhead_Commission_PPW__c');
  const mgmtPPW = mgrPPW + overheadPPW;                         // J9 (0.055 in the fixture)
  const mgrComm = mgrPPW * watts;
  const overheadComm = overheadPPW * watts;
  const mgmtComm = mgmtPPW * watts;                             // K9 → SLMC · SALESCOMM

  // D17: gated on the CUSTOMER's setter lookup, not on a name match.
  const setterId = resolveSetterId(rec);
  const setterComm = setterId ? g('Geo_Commission_Amount__c') : 0; // K10 → APPT COM

  const commSubtotal = thirdPartyComm + internalComm + mgmtComm + setterComm; // J11
  // Third-party is NOT burdened (they invoice us); the other three are payroll.
  const commBurden = (internalComm + mgmtComm + setterComm) * commBurdenRate; // J12
  const totalCommissions = commSubtotal + commBurden;                         // J13 / N9
  const commissionPPW = watts > 0 ? totalCommissions / watts : 0;             // J14

  // =========================================================================
  // Equipment + BOS material (F12:F19)
  // =========================================================================
  const moduleMat = watts * g('Module_Cost_Per_Watt__c');                          // F12
  const combinerMat = g('Combiner_Unit_Cost__c') * g('Combiner_Qty__c');           // F13
  // Gateway_* fields are REUSED for the Tesla Expansion Pack (§3) — relabel pending.
  const teslaMat = g('Gateway_Unit_Cost__c') * g('Gateway_Qty__c');                // F14
  const inverterMat = g('Microinverter_Unit_Cost__c') * g('Microinverter_Qty__c'); // F15
  const batteryMat = g('Battery_Unit_Cost__c') * g('Battery_Qty__c');              // F16
  const bosSolar = g('BOS_Solar_Cost_Per_Watt__c') * watts;                        // F17
  const bosElec = g('BOS_Electrical_Cost_Per_Watt__c') * watts;                    // F18
  const roofMat = g('Penetrations_Per_Module__c') * g('Roof_Material_Cost_Per_Pen__c') * mods; // F19

  // =========================================================================
  // Core labor (rows 21-33)
  // =========================================================================
  const laborRate = g('Blended_Labor_Rate__c');   // B18
  const powerwallRate = g('Battery_Labor_Rate__c'); // B28
  const auditHrs = g('Audit_Hours__c');           // B20
  const qaHrs = g('QA_Commissioning_Hours__c');   // B21

  const auditLabor = laborRate * auditHrs;        // F21
  const auditBurden = auditLabor * burden;        // F22
  const qaLabor = qaHrs * laborRate;              // F23
  const qaBurden = qaLabor * burden;              // F24
  const roofLabor = g('Roofing_Cost_Per_Penetration__c') * g('Roofing_Pens_Per_Module__c') * mods; // F25 piece rate
  const roofBurden = roofLabor * burden;          // F26

  const installLabor = laborRate * g('Install_Hours_Per_Module__c') * mods; // F27
  const installHours = g('Install_Hours_Per_Module__c') * mods;             // G27
  const s2Labor = installLabor / 3;               // E30/F30
  const s1Labor = installLabor - s2Labor;         // E28/F28
  const s1Burden = s1Labor * burden;              // F29
  const s2Burden = s2Labor * burden;              // F31
  const s1Hours = laborRate > 0 ? s1Labor / laborRate : 0; // G28
  const s2Hours = laborRate > 0 ? s2Labor / laborRate : 0; // G30

  // PRESERVED QUIRK: battery hours are a flat TOTAL, not per battery — G32 is B29, not
  // B29 × battery qty. Deliberate; the sheet has always worked this way.
  // TODO(Q6): the "*Add 4 Hrs Labor" (Tesla Expansion Pack) and "*Add 16 Hrs Labor"
  // (Powerwall III) notes on rows 11/13 are MANUAL today — the sheet's formulas do not
  // add them, so neither does this. Revisit if Harmon says they should be automatic.
  const batteryHours = g('Battery_Install_Hours__c');    // G32 / B29
  const batteryLabor = batteryHours * powerwallRate;     // F32
  const batteryBurden = batteryLabor * burden;           // F33

  // =========================================================================
  // Adders (rows 40-63)
  // =========================================================================
  const adderRows = [];
  let stdMat = 0;      // K40 — GENM share
  let stdLabor = 0;    // K41
  let stdBurden = 0;   // K42
  let stdHours = 0;    // L41
  let stdPriceTotal = 0; // K39 (commission side)

  /**
   * D15 cost read. The Cost fields carry static defaults, so a blank one on a SELECTED
   * adder means something broke — the package didn't deploy, FLS is missing, or a data
   * load nulled it. Zero would silently understate job cost and inflate margin, so this
   * is an error, not a fallback.
   */
  const readCost = (base, qty) => {
    const raw = rec[`Adder_${base}_Cost__c`];
    if (qty > 0 && isBlank(raw)) {
      throw new BudgetInputError(
        `Adder_${base}_Cost__c is blank but the adder is selected (qty ${qty}). ` +
          'Cost fields carry static defaults (D15) and the calc never derives one, so a ' +
          'blank here means the field package did not deploy, the integration user lacks ' +
          'FLS on it, or a data load cleared it. Refusing to treat it as zero.',
        'ADDER_COST_MISSING'
      );
    }
    return num(raw);
  };

  // ---- Flat adders --------------------------------------------------------
  for (const a of FLAT_ADDERS) {
    const price = g(`Adder_${a.base}_Price__c`);
    const qty = g(`Adder_${a.base}_Qty__c`);
    const rate = a.rate === 'blended' ? laborRate : powerwallRate;

    const priceTotal = price * qty;                                   // D
    const hours = a.hoursFlag ? (qty >= 1 ? a.hoursPerUnit : 0) : qty * a.hoursPerUnit; // E
    const labor = hours * rate;                                       // F
    const bur = labor * ADDER_BURDEN_RATE;                            // G
    const mat = a.cost ? readCost(a.base, qty) * qty : 0;             // I (D15: per-UNIT × qty)

    stdPriceTotal += priceTotal;
    stdMat += mat; stdLabor += labor; stdBurden += bur; stdHours += hours;
    adderRows.push({ ...a, kind: 'flat', price, qty, priceTotal, hours, labor, bur, mat });
  }

  // ---- Per-watt adders ----------------------------------------------------
  for (const a of PPW_ADDERS) {
    const price = g(`Adder_${a.base}_Price__c`);
    const qty = g(`Adder_${a.base}_Qty__c`);
    const selected = qty >= 1;

    const priceTotal = price * watts * qty;                           // D (× qty)
    const labor = selected ? a.laborPerWatt * watts : 0;              // F (NOT × qty)
    const hours = powerwallRate > 0 ? labor / powerwallRate : 0;      // E
    const bur = labor * ADDER_BURDEN_RATE;                            // G
    const mat = selected ? readCost(a.base, qty) * watts : 0;         // I (D15: per-WATT × watts)

    stdPriceTotal += priceTotal;
    stdMat += mat; stdLabor += labor; stdBurden += bur; stdHours += hours;
    adderRows.push({ ...a, kind: 'ppw', price, qty, priceTotal, hours, labor, bur, mat });
  }

  // ---- SUBCON adders (own budget lines, no material/labor rollup) ---------
  let engineerStamps = 0;   // J17
  let subcontractor = 0;    // J18
  for (const a of SUBCON_ADDERS) {
    const price = g(`Adder_${a.base}_Price__c`);
    const qty = g(`Adder_${a.base}_Qty__c`);
    const selected = qty >= 1;
    const priceTotal = a.priceKind === 'ppw' ? price * watts * qty : price * qty;
    // costKind 'unit' → × qty; 'watt' → × watts, selection-gated (D15).
    const cost = !selected ? 0 : a.costKind === 'watt' ? readCost(a.base, qty) * watts : readCost(a.base, qty) * qty;

    if (a.line === 'engineerStamps') engineerStamps += cost;
    else subcontractor += cost;

    stdPriceTotal += priceTotal;
    adderRows.push({ ...a, kind: 'subcon', price, qty, priceTotal, cost, hours: 0, labor: 0, bur: 0, mat: 0 });
  }

  // ---- Pass-through / revenue rows ---------------------------------------
  let software = 0;         // J19
  let referral = 0;         // J20
  let genoAdders = 0;       // the E61 + E62 half of J16
  for (const a of PASSTHROUGH_ADDERS) {
    const price = g(`Adder_${a.base}_Price__c`);
    const qty = g(`Adder_${a.base}_Qty__c`);
    const priceTotal = price * qty;                 // D
    // Sheet E = D on these rows: the cost IS the price, no Cost field exists (§4c).
    const cost = a.line ? priceTotal : 0;

    if (a.line === 'software') software += cost;
    else if (a.line === 'referral') referral += cost;
    else if (a.line === 'geno') genoAdders += cost;

    stdPriceTotal += priceTotal;
    adderRows.push({ ...a, kind: 'passthrough', price, qty, priceTotal, cost, hours: 0, labor: 0, bur: 0, mat: 0 });
  }

  // ---- Non-standard adder blocks 1-5 --------------------------------------
  let nsMat = 0, nsLabor = 0, nsBurden = 0, nsHours = 0, nsTotalWithMarkup = 0;
  const nsRows = [];
  for (const b of NS_BLOCKS) {
    const markup = g(`NS_Adder_${b.n}_Markup_Percent__c`) / 100;
    const mat = g(`NS_Adder_${b.n}_Material_Cost__c`);
    const hours = g(`NS_Adder_${b.n}_Labor_Hours__c`);
    // v2: NS labor is at the POWERWALL rate (v1 used blended) — §3.
    const labor = powerwallRate * hours;
    const bur = labor * ADDER_BURDEN_RATE;
    const markupAmt = mat * markup;
    const total = mat + markupAmt + labor + bur;   // D68 = SUM(D69:D72)

    // NOTE: the markup does NOT reach the cost budget. J15 pulls G68, which is
    // SUM(D70, D78, …) — materials with NO markup. The markup is a revenue-side
    // concept that only shows up in the block's own total.
    nsMat += mat; nsLabor += labor; nsBurden += bur; nsHours += hours;
    nsTotalWithMarkup += total;
    nsRows.push({ ...b, markup, mat, hours, labor, bur, markupAmt, total });
  }

  const adderLaborTotal = stdLabor + nsLabor;
  const adderBurdenTotal = stdBurden + nsBurden;
  const adderHoursTotal = stdHours + nsHours;
  const totalAdderCost = stdMat + stdLabor + stdBurden + nsTotalWithMarkup;

  // =========================================================================
  // Budget lines (Acumatica-coded) — sheet column J
  // =========================================================================
  const materialOther = g('Material_Other_Cost__c');   // B25
  const coFee = g('Constructive_Ops_Fee__c');          // B26
  const permit = g('Permit_Pass_Through_Cost__c');     // B27

  const totalMaterial = moduleMat + combinerMat + teslaMat + inverterMat + batteryMat
    + bosSolar + bosElec + roofMat + stdMat + nsMat;                       // J15 → GENM
  const totalOther = materialOther + coFee + permit + genoAdders;          // J16 → GENO (D12)
  const auditLaborLine = auditLabor + qaLabor;                             // J21 → GENA
  const s3Labor = batteryLabor + stdLabor + nsLabor;                       // J25 → S3
  const totalLabor = auditLaborLine + roofLabor + s1Labor + s2Labor + s3Labor; // J26
  const totalBurden = auditBurden + qaBurden + roofBurden + s1Burden + s2Burden
    + batteryBurden + stdBurden + nsBurden;                                // J27 → BURDENEXR

  // D11: SUBCON / SOFTWARE / REFERRAL are IN the total now (the BRADS bug).
  const totalJobCost = totalMaterial + totalOther + engineerStamps + subcontractor
    + software + referral + totalLabor + totalBurden;                      // J28
  const totalJobCostWithComm = totalJobCost + totalCommissions;            // J29

  // ---- Hours --------------------------------------------------------------
  const genaHours = auditHrs + qaHrs;                              // J33
  const s3Hours = batteryHours + stdHours + nsHours;               // J36
  const totalHours = genaHours + s1Hours + s2Hours + s3Hours;      // J32

  // =========================================================================
  // Summary block (column N)
  // =========================================================================
  const contract = g('Contract_Amount__c');                        // N6
  const dcRebate = isDomesticContent(rec) ? DC_REBATE_PPW * watts : 0; // N7 / D5
  const dealerFee = g('Dealer_Fee__c');                            // N8
  const balanceOfRevenue = contract + dcRebate - dealerFee - totalCommissions; // N10
  const summaryTotalLabor = totalLabor + totalBurden;              // N12 — labor AND burden
  const summaryTotalOther = totalOther + engineerStamps + subcontractor + software + referral; // N13
  const gpDollars = balanceOfRevenue - totalMaterial - summaryTotalLabor - summaryTotalOther;  // N14
  const gpPctWithComm = contract > 0 ? gpDollars / contract : 0;   // N15
  const gpPctNoComm = balanceOfRevenue !== 0 ? gpDollars / balanceOfRevenue : 0; // N16

  const costPPW = watts > 0 ? totalJobCost / watts : 0;            // J30
  const costPPWWithComm = costPPW + commissionPPW;                 // J31

  // Deal type (D16). Computed once here so `fields` (as a picklist label) and
  // `extras` (as a token) cannot disagree.
  const dealType = thirdPartyPPW > 0 ? 'third_party' : internalPPW > 0 ? 'internal' : 'none';

  // =========================================================================
  // Salesforce output fields
  // =========================================================================
  // NOTE: several v2 values have NO Salesforce home yet (third-party vs internal
  // commission amounts, the management combined amount, the DC rebate, the SUBCON /
  // SOFTWARE / REFERRAL lines, NS 4-5 totals, and the attribute milestone splits).
  // They are computed and returned in `extras` below rather than invented as fields —
  // see docs/integrations/budget-v2-output-gap.md.
  const fields = {
    System_Size_Watts__c: watts,
    Calculated_Module_Count__c: r2(mods),

    // Commissions — only the fields that already exist. Sales_Rep_Commission_Amt__c
    // now holds the THIRD-PARTY amount (the field is being relabelled, §4d).
    Sales_Rep_Commission_Amt__c: r2(thirdPartyComm),
    Sales_Mgr_Commission_Amt__c: r2(mgrComm),
    Overhead_Commission_Amt__c: r2(overheadComm),
    Commission_Subtotal__c: r2(commSubtotal),
    Commission_Burden_Amt__c: r2(commBurden),
    Total_Commissions__c: r2(totalCommissions),
    Commission_PPW__c: commissionPPW,

    Module_Material_Cost__c: r2(moduleMat),
    Combiner_Cost__c: r2(combinerMat),
    Gateway_Cost__c: r2(teslaMat),
    Microinverter_Cost__c: r2(inverterMat),
    Battery_Material_Cost__c: r2(batteryMat),
    BOS_Solar_Cost__c: r2(bosSolar),
    BOS_Electrical_Cost__c: r2(bosElec),
    Roofing_Material_Cost__c: r2(roofMat),

    Audit_Labor_Cost__c: r2(auditLaborLine),
    QA_Labor_Cost__c: r2(qaLabor),
    Roofing_Labor_Cost__c: r2(roofLabor),
    Solar_Install_Labor_Total__c: r2(installLabor),
    S1_Labor_Cost__c: r2(s1Labor),
    S2_Labor_Cost__c: r2(s2Labor),
    S3_Labor_Cost__c: r2(s3Labor),

    Std_Adder_Material_Total__c: r2(stdMat),
    Std_Adder_Labor_Total__c: r2(stdLabor),
    Std_Adder_Burden_Total__c: r2(stdBurden),
    Std_Adder_Hours_Total__c: stdHours,
    Std_Adder_Cost_Total__c: r2(stdMat + stdLabor + stdBurden),
    NS_Adder_1_Total__c: r2(nsRows[0].total),
    NS_Adder_2_Total__c: r2(nsRows[1].total),
    NS_Adder_3_Total__c: r2(nsRows[2].total),
    NS_Adder_Material_Total__c: r2(nsMat),
    Adder_Labor_Total__c: r2(adderLaborTotal),
    Adder_Burden_Total__c: r2(adderBurdenTotal),
    Adder_Hours_Total__c: adderHoursTotal,
    Total_Adder_Cost__c: r2(totalAdderCost),

    Total_Material_Budget__c: r2(totalMaterial),
    Total_Other_Budget__c: r2(totalOther),
    Total_Labor_Budget__c: r2(totalLabor),
    Total_Labor_Burden_Budget__c: r2(totalBurden),
    Constructive_Ops_Total__c: r2(coFee + permit),
    Total_Job_Cost__c: r2(totalJobCost),
    Total_Job_Cost_With_Comm__c: r2(totalJobCostWithComm),
    Cost_PPW__c: costPPW,
    Cost_PPW_With_Comm__c: costPPWWithComm,

    GENA_Hours__c: genaHours,
    S1_Hours__c: s1Hours,
    S2_Hours__c: s2Hours,
    S3_Hours__c: s3Hours,
    Total_Job_Hours__c: totalHours,

    Balance_of_Revenue__c: r2(balanceOfRevenue),
    Total_Labor_And_Burden__c: r2(summaryTotalLabor),
    GP_Dollars__c: r2(gpDollars),
    GP_Percent_With_Comm__c: r2(gpPctWithComm * 100),
    GP_Percent_No_Comm__c: r2(gpPctNoComm * 100),

    // ---- The §D output fields (deployed 2026-08-20) ----------------------
    // Promoted out of `extras` now that they have somewhere to land. Reviewed and
    // approved in docs/integrations/budget-v2-output-gap.md §D.
    Internal_Rep_Commission_Amt__c: r2(internalComm),
    Management_Commission_Amt__c: r2(mgmtComm),
    Setter_Commission_Amt__c: r2(setterComm),
    // MUST be a picklist LABEL, not the internal token. Commission_Deal_Type__c is a
    // RESTRICTED picklist (`3rd Party` / `Internal` / `None`), so writing the raw
    // 'third_party' would be rejected by Salesforce on every save.
    Commission_Deal_Type__c: DEAL_TYPE_PICKLIST[dealType],
    DC_Rebate_Amount__c: r2(dcRebate),
    Engineer_Stamps_Cost__c: r2(engineerStamps),
    Subcontractor_Cost__c: r2(subcontractor),
    Total_Other_Summary__c: r2(summaryTotalOther),
  };

  /**
   * Computed v2 values, ALL of them — including the eight that now have Salesforce
   * fields (see `fields` above and the disposition table in
   * docs/integrations/budget-v2-output-gap.md).
   *
   * The eight are deliberately in BOTH maps rather than moved: `fields` is what gets
   * PATCHed to Salesforce, `extras` is the calc's computed-value surface that the push
   * worker and the portal read. Keeping them here means a consumer that already reads
   * `extras.dealType` does not break, and the duplication is free because both come
   * from the same local.
   */
  const extras = {
    dealType,
    thirdPartyCommissionAmt: r2(thirdPartyComm),
    internalCommissionAmt: r2(internalComm),
    managementCommissionAmt: r2(mgmtComm),
    managementCommissionPPW: mgmtPPW,
    setterCommissionAmt: r2(setterComm),
    setterUserId: setterId,
    dcRebateAmount: r2(dcRebate),
    domesticContent: isDomesticContent(rec),
    engineerStampsCost: r2(engineerStamps),
    subcontractorCost: r2(subcontractor),
    softwareCost: r2(software),
    referralCost: r2(referral),
    genoAdderCost: r2(genoAdders),
    summaryTotalOther: r2(summaryTotalOther),
    nsAdder4Total: r2(nsRows[3].total),
    nsAdder5Total: r2(nsRows[4].total),
    nsAdderTotalWithMarkup: r2(nsTotalWithMarkup),
    stdAdderPriceTotal: r2(stdPriceTotal),
  };

  // =========================================================================
  // Cell map — REVISED layout, for the snapshot workbook
  // =========================================================================
  const cells = {
    A3: rec.Project_Name__c || rec.Name || '',
    B3: rec.Project_Name__c || rec.Name || '',
    D3: isDomesticContent(rec) ? 'YES' : 'NO',
    D4: isDomesticContent(rec) ? DC_REBATE_PPW : null,
    D5: dcRebate || null,

    // Cost parameters (column B)
    B7: rec.Panel_Type__c || rec.Module_Manufacturer__c || '',
    B8: moduleWatts, B9: g('Module_Cost_Per_Watt__c'),
    B10: g('Combiner_Unit_Cost__c'), C10: g('Combiner_Qty__c'),
    B11: g('Gateway_Unit_Cost__c'), C11: g('Gateway_Qty__c'),
    B12: g('Microinverter_Unit_Cost__c'), C12: g('Microinverter_Qty__c'),
    B13: g('Battery_Unit_Cost__c'), C13: g('Battery_Qty__c'),
    B14: g('BOS_Solar_Cost_Per_Watt__c'), B15: g('BOS_Electrical_Cost_Per_Watt__c'),
    B16: g('Roof_Material_Cost_Per_Pen__c'), B17: g('Penetrations_Per_Module__c'),
    B18: laborRate, B19: burden, B20: auditHrs, B21: qaHrs,
    B22: g('Roofing_Cost_Per_Penetration__c'), B23: g('Roofing_Pens_Per_Module__c'),
    B24: g('Install_Hours_Per_Module__c'), B25: materialOther,
    B26: coFee, B27: permit, B28: powerwallRate, B29: batteryHours,

    // System size
    D7: g('System_Size__c'), E7: watts, F7: moduleWatts, C8: g('Module_Cost_Per_Watt__c'), E9: mods,

    // Commissions block
    J7: thirdPartyPPW, K7: thirdPartyComm,
    J8: internalPPW, K8: internalComm,
    J9: mgmtPPW, K9: mgmtComm,
    J10: g('Geo_Commission_Amount__c'), K10: setterComm,
    J11: commSubtotal, J12: commBurden, K12: commBurdenRate,
    J13: totalCommissions, J14: commissionPPW,

    // Material budgets
    F12: moduleMat, F13: combinerMat, F14: teslaMat, F15: inverterMat, F16: batteryMat,
    E17: g('BOS_Solar_Cost_Per_Watt__c'), F17: bosSolar,
    E18: g('BOS_Electrical_Cost_Per_Watt__c'), F18: bosElec,
    E19: g('Roof_Material_Cost_Per_Pen__c'), F19: roofMat,

    // Labor budgets / hours
    E21: laborRate, F21: auditLabor, G21: auditHrs,
    E22: burden, F22: auditBurden,
    E23: laborRate, F23: qaLabor, G23: qaHrs,
    E24: burden, F24: qaBurden,
    E25: g('Roofing_Cost_Per_Penetration__c'), F25: roofLabor,
    E26: burden, F26: roofBurden,
    E27: laborRate, F27: installLabor, G27: installHours,
    E28: s1Labor, F28: s1Labor, G28: s1Hours,
    E29: burden, F29: s1Burden,
    E30: s2Labor, F30: s2Labor, G30: s2Hours,
    E31: burden, F31: s2Burden,
    E32: powerwallRate, F32: batteryLabor, G32: batteryHours,
    E33: burden, F33: batteryBurden,

    // Acumatica-coded summary column J
    J15: totalMaterial, J16: totalOther, J17: engineerStamps, J18: subcontractor,
    J19: software, J20: referral, J21: auditLaborLine, J22: roofLabor,
    J23: s1Labor, J24: s2Labor, J25: s3Labor, J26: totalLabor, J27: totalBurden,
    J28: totalJobCost, J29: totalJobCostWithComm, J30: costPPW, J31: costPPWWithComm,
    J32: totalHours, J33: genaHours, J34: s1Hours, J35: s2Hours, J36: s3Hours,

    // Contract / GP summary column N
    N6: contract, N7: dcRebate || null, N8: dealerFee, N9: totalCommissions,
    N10: balanceOfRevenue, N11: totalMaterial, N12: summaryTotalLabor,
    N13: summaryTotalOther, N14: gpDollars, N15: gpPctWithComm, N16: gpPctNoComm,

    // Adder rollups
    K39: stdPriceTotal, K40: stdMat, K41: stdLabor, K42: stdBurden,
    K43: stdLabor + stdBurden, K44: stdMat + stdLabor + stdBurden, L41: stdHours,
    G67: nsTotalWithMarkup, G68: nsMat, G69: nsLabor, G70: nsBurden,
    G71: nsLabor + nsBurden, G72: nsMat + nsLabor + nsBurden, H69: nsHours,
  };

  // Per-adder rows
  for (const a of adderRows) {
    cells[`B${a.row}`] = a.price;
    cells[`C${a.row}`] = a.qty;
    cells[`D${a.row}`] = a.priceTotal;
    if (a.kind === 'flat' || a.kind === 'ppw') {
      cells[`E${a.row}`] = a.hours;
      cells[`F${a.row}`] = a.labor;
      cells[`G${a.row}`] = a.bur;
      // H (balance) and I (materials) are the sheet's DERIVATION columns. v2 reads the
      // Cost field instead (D15), so I is written from the cost and H is left alone —
      // writing a stale balance would imply the derivation still drives the number.
      if (a.cost !== false && a.kind === 'flat') cells[`I${a.row}`] = a.mat;
      if (a.kind === 'ppw') cells[`I${a.row}`] = a.mat;
    } else if (a.kind === 'subcon' || a.kind === 'passthrough') {
      if (a.line) cells[`E${a.row}`] = a.cost;
    }
  }

  // NS blocks
  for (const b of nsRows) {
    cells[b.descCell] = rec[`NS_Adder_${b.n}_Description__c`] || '';
    cells[b.markupCell] = b.markup;
    cells[b.matCell] = b.mat;
    cells[b.hoursCell] = b.hours;
    cells[b.laborCell] = b.labor;
    cells[b.burdenCell] = b.bur;
    cells[b.totalCell] = b.total;
    cells[b.markupOutCell] = b.markupAmt;
    cells[b.hoursOutCell] = b.hours;
  }

  return { fields, cells, extras };
}

module.exports = {
  calculateBudget,
  BudgetInputError,
  FLAT_ADDERS,
  PPW_ADDERS,
  SUBCON_ADDERS,
  PASSTHROUGH_ADDERS,
  NS_BLOCKS,
  DC_REBATE_PPW,
};
