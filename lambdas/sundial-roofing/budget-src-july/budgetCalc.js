/**
 * budgetCalc.js — Sundial Roofing budget calculator (pure function, no I/O)
 *
 * Ported cell-for-cell from Harmon's Roofing Budget sheet and verified against the
 * Mills example (all 29 rollup/summary cells reproduce exactly).
 *
 * Input:  plain object of Sundial_Roofing__c field values (API names as keys).
 * Output: { fields, cells } — Salesforce output fields + spreadsheet cell map for the snapshot.
 *
 * Same conventions as the solar module: SF percent fields arrive as whole numbers
 * (20 means 20%) and are divided by 100 here; this module is also importable by the
 * React portal for live previews.
 *
 * Deliberate deviations from the sheet (see design quirks, confirm with Harmon):
 *  - Cost-per-square divides by TOTAL squares (sheet divides by tile squares only — breaks on non-tile jobs)
 *  - Burden is one input field (sheet hardcodes 20% in three formulas)
 */

// 46-item material catalog: field base name -> sheet row (Qty=B{row}, Cost=C{row}, Total=D{row})
const MATERIALS = {
  OC_Oakridge: 16, Ridge_Shingles: 18, GAF_ProStart: 21, OC_Starter_Strip: 22,
  Boral_Ply_40: 25, Fontana_G40: 26, ABC_Proguard: 29, GAF_Felt_Buster: 30,
  Mulehide_SA_Nail_Base: 33, Mulehide_SA_Base_Sheet: 34, Mulehide_SA_APP_Cap: 35,
  Mulehide_A200_Flashing: 38, Mulehide_A310_White: 39, Mulehide_A310_Tan: 40,
  Mulehide_210_Cement: 41, Foam_Pack: 42, Furring_Strip: 45,
  Drip_Edge_Galv: 48, Drip_Edge_Painted: 49, Valley_18_W_Galv: 52, Valley_24_3Rib: 53,
  Tile_Pan_Galv: 56, Jack_15_Alum_Sleeve: 59, Jack_2_Alum_Sleeve: 60,
  Jack_15_Alum: 61, Jack_2_Alum: 62, Jack_3_Alum: 63, Jack_4_Alum: 64,
  Jack_15_Galv: 65, Jack_2_Galv: 66, Jack_3_Galv: 67,
  TTop_4_Alum: 70, TTop_4_Galv: 71, TTop_7_Alum: 72, TTop_7_Galv: 73,
  Nails_125_Coil: 76, Nails_75_EG: 77, Staples: 78, Nails_1_Simplex: 79,
  WB_Flat: 82, WB_Ridge: 83, WB_Hips: 84, Birdstop_Metal: 87,
  Tile_Piece: 90, Tile_Pallet: 91, OHagen_Vent: 94,
};

// Sheet constants for the crew metrics (see quirks: labor notes say $31 avg, hours calc uses $29)
const HOURS_CALC_RATE = 29;   // B134 = Total Labor / 29
const CREW_DAY_HOURS = 32;    // B135 = hours / 32 (4 men x 8 hours)

const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? 0 : Number(v));
const r2 = (v) => Math.round(v * 100) / 100;

function calculateBudget(rec) {
  const g = (f) => num(rec[f]);
  const burden = g('Burden_Rate__c') / 100;

  // ---- Labor (D8:D11, D97:D100) ----
  const shingleLabor = g('Labor_Rate_Shingle__c') * g('Squares_Shingle__c');
  const tileLabor = g('Labor_Rate_Tile__c') * g('Squares_Tile__c');
  const modifiedLabor = g('Labor_Rate_Modified__c') * g('Squares_Modified__c');
  const recoatLabor = g('Labor_Rate_Recoat__c') * g('Squares_Recoat__c');
  const totalLabor = shingleLabor + tileLabor + modifiedLabor + recoatLabor;      // D97/E97
  const laborBurden = totalLabor * burden;                                        // D98/E98
  const laborMarkup = (totalLabor + laborBurden) * (g('Labor_Markup_Percent__c') / 100); // D99
  const laborWithMarkup = totalLabor + laborBurden + laborMarkup;                 // D100

  // ---- Materials (46 x qty*cost, D102:D104) ----
  let totalMaterial = 0;
  const matRows = [];
  for (const [base, row] of Object.entries(MATERIALS)) {
    const qty = g(`Mat_${base}_Qty__c`);
    const cost = g(`Mat_${base}_Cost__c`);
    const total = qty * cost;
    totalMaterial += total;
    matRows.push({ base, row, qty, cost, total });
  }
  const materialMarkup = totalMaterial * (g('Material_Markup_Percent__c') / 100); // D103
  const materialWithMarkup = totalMaterial + materialMarkup;                      // D104

  // ---- Other (roll-off + misc, D106:D108) ----
  const rollOff = g('Roll_Off_Qty__c') * g('Roll_Off_Cost__c');                   // D12
  const miscOther = g('Misc_Other_Qty__c') * g('Misc_Other_Cost__c');             // D13
  const otherBudget = rollOff + miscOther;                                        // D106/E106
  const otherMarkup = otherBudget * (g('Other_Markup_Percent__c') / 100);         // D107
  const otherWithMarkup = otherBudget + otherMarkup;                              // D108

  // ---- Subtotal & commissions (D110, D113:D118) ----
  const costSubtotal = laborWithMarkup + materialWithMarkup + otherWithMarkup;    // D110
  // NOTE (quirk): the sheet's tier legend says the commission rate applies to Total
  // Contract Price, but the formula applies it to this marked-up cost subtotal.
  const commission = costSubtotal * (g('Commission_Rate_Percent__c') / 100);      // D113/E113
  const commissionBurden = commission * burden;                                   // D114/E114
  const commissionMarkup = (commission + commissionBurden) * (g('Commission_Markup_Percent__c') / 100); // D115
  const geo = g('Geo_Commission_Amount__c');                                      // D116/E116
  const geoBurden = geo * burden;                                                 // D117/E117
  const commissionTotal = commission + commissionBurden + commissionMarkup + geo + geoBurden; // D118

  // ---- Totals (D119, E119, E120) ----
  const totalJobCostClient = laborWithMarkup + materialWithMarkup + otherWithMarkup + commissionTotal; // D119
  const acumaticaBudgetTotal = (totalLabor + laborBurden) + totalMaterial + otherBudget
    + (commission + commissionBurden) + (geo + geoBurden);                        // E119 (no markups)
  const markupProfit = totalJobCostClient - acumaticaBudgetTotal;                 // E120

  // ---- Tax, warranty, proposal (D121:D132) ----
  const taxableAmount = materialWithMarkup;                                       // D121 (materials only — quirk)
  const taxRate = g('City_Tax_Rate__c') / 100;
  const cityTax = taxRate * taxableAmount;                                        // D127
  const warrantyCharged = g('Warranty_Line_Item_Amount__c');
  const warrantyDelta = warrantyCharged - g('Warranty_Cost__c');                  // C124
  const totalProposal = totalJobCostClient + cityTax + warrantyCharged;           // D130
  const proposalLessTax = totalProposal - cityTax;                                // D132

  // ---- Metrics (B134:B135, A138, A141, A145) ----
  const totalSquares = g('Squares_Shingle__c') + g('Squares_Tile__c') + g('Squares_Modified__c') + g('Squares_Recoat__c');
  const budgetedHours = totalLabor / HOURS_CALC_RATE;                             // B134
  const daysOnJob = budgetedHours / CREW_DAY_HOURS;                               // B135
  const profitPct = totalJobCostClient > 0 ? markupProfit / totalJobCostClient : 0; // A138
  const perSqAllIn = totalSquares > 0 ? totalProposal / totalSquares : 0;         // A141 (÷ total squares — deviation)
  const perSqNoTax = totalSquares > 0 ? proposalLessTax / totalSquares : 0;       // A145

  const fields = {
    Shingle_Labor_Total__c: r2(shingleLabor),
    Tile_Labor_Total__c: r2(tileLabor),
    Modified_Labor_Total__c: r2(modifiedLabor),
    Recoat_Labor_Total__c: r2(recoatLabor),
    Total_Labor_Budget__c: r2(totalLabor),
    Labor_Burden_Budget__c: r2(laborBurden),
    Labor_Markup_Amt__c: r2(laborMarkup),
    Labor_Total_With_Markup__c: r2(laborWithMarkup),
    Total_Material_Budget__c: r2(totalMaterial),
    Material_Markup_Amt__c: r2(materialMarkup),
    Material_Total_With_Markup__c: r2(materialWithMarkup),
    Roll_Off_Total__c: r2(rollOff),
    Misc_Other_Total__c: r2(miscOther),
    Other_Budget__c: r2(otherBudget),
    Other_Markup_Amt__c: r2(otherMarkup),
    Other_Total_With_Markup__c: r2(otherWithMarkup),
    Cost_Subtotal__c: r2(costSubtotal),
    Commission_Amt__c: r2(commission),
    Commission_Burden_Amt__c: r2(commissionBurden),
    Commission_Markup_Amt__c: r2(commissionMarkup),
    Geo_Burden_Amt__c: r2(geoBurden),
    Commission_Total__c: r2(commissionTotal),
    Total_Job_Cost_Client__c: r2(totalJobCostClient),
    Acumatica_Budget_Total__c: r2(acumaticaBudgetTotal),
    Markup_Profit_Dollars__c: r2(markupProfit),
    Taxable_Amount__c: r2(taxableAmount),
    City_Tax_Amount__c: r2(cityTax),
    Warranty_Delta__c: r2(warrantyDelta),
    Total_Proposal_Cost__c: r2(totalProposal),
    Proposal_Cost_Less_Taxes__c: r2(proposalLessTax),
    Total_Squares__c: totalSquares,
    Budgeted_Hours__c: Math.round(budgetedHours * 10) / 10,
    Days_On_Job__c: Math.round(daysOnJob * 10) / 10,
    Profit_After_Commission_Pct__c: r2(profitPct * 100), // percent stored as whole number
    Cost_Per_Square_All_In__c: r2(perSqAllIn),
    Cost_Per_Square_No_Tax__c: r2(perSqNoTax),
  };

  // ---- Spreadsheet cell map (inputs + every computed cell on NEW BUDGET SHEET) ----
  const cells = {
    B3: rec.Project_Name__c || rec.Name || '',
    B4: g('Squares_Shingle__c'), B5: g('Squares_Tile__c'), B6: g('Squares_Modified__c'), B7: g('Squares_Recoat__c'),
    B8: g('Labor_Rate_Shingle__c'), B9: g('Labor_Rate_Tile__c'), B10: g('Labor_Rate_Modified__c'), B11: g('Labor_Rate_Recoat__c'),
    D8: shingleLabor, D9: tileLabor, D10: modifiedLabor, D11: recoatLabor,
    B12: g('Roll_Off_Qty__c'), C12: g('Roll_Off_Cost__c'), D12: rollOff,
    B13: g('Misc_Other_Qty__c'), C13: g('Misc_Other_Cost__c'), D13: miscOther,
    D97: totalLabor, E97: totalLabor, D98: laborBurden, E98: laborBurden,
    B99: g('Labor_Markup_Percent__c') / 100, D99: laborMarkup, D100: laborWithMarkup,
    D102: totalMaterial, E102: totalMaterial,
    B103: g('Material_Markup_Percent__c') / 100, D103: materialMarkup, D104: materialWithMarkup,
    D106: otherBudget, E106: otherBudget,
    B107: g('Other_Markup_Percent__c') / 100, D107: otherMarkup, D108: otherWithMarkup,
    D110: costSubtotal,
    B113: g('Commission_Rate_Percent__c') / 100, D113: commission, E113: commission,
    D114: commissionBurden, E114: commissionBurden,
    B115: g('Commission_Markup_Percent__c') / 100, D115: commissionMarkup,
    D116: geo, E116: geo, D117: geoBurden, E117: geoBurden, D118: commissionTotal,
    D119: totalJobCostClient, E119: acumaticaBudgetTotal, E120: markupProfit,
    D121: taxableAmount,
    B123: warrantyCharged, B124: g('Warranty_Cost__c'), C124: warrantyDelta,
    B127: rec.Job_City__c || '', C127: taxRate, D127: cityTax,
    D130: totalProposal, D131: g('Contract_Presented_Amount__c') || null, D132: proposalLessTax,
    B134: budgetedHours, B135: daysOnJob,
    A137: markupProfit, A138: profitPct, A141: perSqAllIn, A145: perSqNoTax,
  };
  for (const m of matRows) {
    cells[`B${m.row}`] = m.qty; cells[`C${m.row}`] = m.cost; cells[`D${m.row}`] = m.total;
  }

  return { fields, cells };
}

module.exports = { calculateBudget, MATERIALS, HOURS_CALC_RATE, CREW_DAY_HOURS };
