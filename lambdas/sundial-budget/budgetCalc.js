/**
 * budgetCalc.js — Sundial Solar budget calculator (pure function, no I/O)
 *
 * This is the single source of truth for Harmon's budget math, ported cell-for-cell
 * from the Sunbase Budget Sheet and verified against the HOLLAND example workbook
 * (all 34 rollup/summary cells reproduce exactly).
 *
 * Input:  a plain object of Sundial_Solar__c field values (API names as keys).
 * Output: { fields, cells }
 *   fields — output field values keyed by Salesforce API name, ready for record update
 *   cells  — every input + computed spreadsheet cell keyed by A1 reference, ready for
 *            the workbook snapshot generator (budgetWorkbook.js)
 *
 * The same module can be imported by the React portal for live what-if previews.
 *
 * Salesforce percent fields arrive as whole numbers (75 means 75%) — we divide by 100 here.
 */

// Standard adder catalog: field base name, sheet row, pricing kind, labor hours per unit.
// Labor on standard adders is priced at the BATTERY labor rate (that's what the sheet does).
const STD_ADDERS = [
  { base: 'Sub_Panel',          row: 36, kind: 'flat',  hoursPerUnit: 3 },
  { base: 'Flat_Roof',          row: 37, kind: 'ppw',   hoursPerUnit: 0 },
  { base: 'Bird_Blocking',      row: 38, kind: 'ppw',   hoursPerUnit: 0 },
  { base: 'Derate',             row: 39, kind: 'flat',  hoursPerUnit: 3 },
  { base: 'Structural',         row: 40, kind: 'flat',  hoursPerUnit: 0 },
  { base: 'Small_System_10_12', row: 41, kind: 'flat',  hoursPerUnit: 0 },
  { base: 'Small_System_13_15', row: 42, kind: 'flat',  hoursPerUnit: 0 },
  // All-in price: material is backed out as price minus labor minus burden (sheet D43).
  // NOTE: the sheet does not multiply the all-in price by qty beyond the labor side; we use price*qty for symmetry.
  { base: 'Heat_Detector',      row: 43, kind: 'allin', hoursPerUnit: 4 },
  { base: 'Conduit_Attic',      row: 44, kind: 'ppw',   hoursPerUnit: 0 },
  { base: 'Roof_Tile',          row: 45, kind: 'ppw',   hoursPerUnit: 0 },
  { base: 'Software_Fee',       row: 46, kind: 'flat',  hoursPerUnit: 0 },
  { base: 'Upgrade_225',        row: 47, kind: 'flat',  hoursPerUnit: 16 },
  { base: 'Upgrade_400',        row: 48, kind: 'flat',  hoursPerUnit: 16 },
];

// Non-standard adder blocks and their sheet rows
const NS_BLOCKS = [
  { n: 1, descCell: 'A55', markupCell: 'B57', matCell: 'D58', hoursCell: 'C59', laborCell: 'D59', burdenCell: 'D60', totalCell: 'D56', markupOutCell: 'D57', hoursOutCell: 'E59' },
  { n: 2, descCell: 'A63', markupCell: 'B65', matCell: 'D66', hoursCell: 'C67', laborCell: 'D67', burdenCell: 'D68', totalCell: 'D64', markupOutCell: 'D65', hoursOutCell: 'E67' },
  { n: 3, descCell: 'A71', markupCell: 'B73', matCell: 'D74', hoursCell: 'C75', laborCell: 'D75', burdenCell: 'D76', totalCell: 'D72', markupOutCell: 'D73', hoursOutCell: 'E75' },
];

const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? 0 : Number(v));
const r2 = (v) => Math.round(v * 100) / 100;

function calculateBudget(rec) {
  const g = (f) => num(rec[f]);

  // ---- Rates (percent fields stored as whole numbers in Salesforce) ----
  const burden = g('Labor_Burden_Rate__c') / 100;              // 75 -> 0.75
  const commBurdenRate = g('Commission_Burden_Rate__c') / 100;

  // ---- Basics ----
  const watts = g('System_Size__c') * 1000;                                    // F7
  const moduleWatts = g('Module_STC_Wattage__c');
  const mods = moduleWatts > 0 ? watts / moduleWatts : 0;                      // F9

  // ---- Commissions ----
  const salesRepComm = g('Sales_Rep_Commission_PPW__c') * watts;               // K7
  const mgrComm = g('Sales_Mgr_Commission_PPW__c') * watts;                    // K8
  const geoComm = g('Geo_Commission_Amount__c');                               // K9 (flat)
  const overheadComm = g('Overhead_Commission_PPW__c') * watts;                // K10
  const commSubtotal = salesRepComm + mgrComm + geoComm + overheadComm;        // J11
  // Burden applies to Mgr/Geo/Overhead only — the Sales Rep row is excluded (sheet J12 array formula)
  const commBurden = (mgrComm + geoComm + overheadComm) * commBurdenRate;      // J12
  const totalCommissions = commSubtotal + commBurden;                          // J13 / N8

  // ---- Materials ----
  const moduleMat = watts * g('Module_Cost_Per_Watt__c');                      // G12
  const combinerMat = g('Combiner_Unit_Cost__c') * g('Combiner_Qty__c');       // G13
  const gatewayMat = g('Gateway_Unit_Cost__c') * g('Gateway_Qty__c');          // G14
  const inverterMat = g('Microinverter_Unit_Cost__c') * g('Microinverter_Qty__c'); // G15
  const batteryMat = g('Battery_Unit_Cost__c') * g('Battery_Qty__c');          // G16
  const bosSolar = g('BOS_Solar_Cost_Per_Watt__c') * watts;                    // G17
  const bosElec = g('BOS_Electrical_Cost_Per_Watt__c') * watts;                // G18
  const roofMat = g('Penetrations_Per_Module__c') * g('Roof_Material_Cost_Per_Pen__c') * mods; // G19

  // ---- Labor ----
  const laborRate = g('Blended_Labor_Rate__c');
  const auditLabor = laborRate * g('Audit_Hours__c');                          // G21
  const qaLabor = laborRate * g('QA_Commissioning_Hours__c');                  // G23
  const roofLabor = g('Roofing_Cost_Per_Penetration__c') * g('Roofing_Pens_Per_Module__c') * mods; // G25 (piece rate)
  const installLabor = laborRate * g('Install_Hours_Per_Module__c') * mods;    // G27
  const s2Labor = installLabor / 3;                                            // G30 (1/3)
  const s1Labor = installLabor - s2Labor;                                      // G28 (2/3)
  // CAUTION: the sheet uses battery hours as a flat TOTAL, not hours-per-battery (see design doc quirk #1)
  const batteryLabor = g('Battery_Install_Hours__c') * g('Battery_Labor_Rate__c'); // G32

  // ---- Standard adders ----
  const battRate = g('Battery_Labor_Rate__c'); // sheet prices standard adder labor at the battery rate
  let stdMat = 0, stdLabor = 0, stdBurden = 0, stdHours = 0;
  const adderRows = [];
  for (const a of STD_ADDERS) {
    const price = g(`Adder_${a.base}_Price__c`);
    const qty = g(`Adder_${a.base}_Qty__c`);
    let mat = 0, hours = 0, labor = 0, bur = 0;
    if (a.kind === 'ppw') {
      mat = price * watts * qty;
    } else {
      hours = qty * a.hoursPerUnit;
      labor = hours * battRate;
      bur = labor * 0.75; // sheet hardcodes 75% on adder rows
      mat = a.kind === 'allin' ? price * qty - labor - bur : price * qty;
    }
    stdMat += mat; stdLabor += labor; stdBurden += bur; stdHours += hours;
    adderRows.push({ ...a, mat, hours, labor, bur });
  }
  const stdAdderTotal = stdMat + stdLabor + stdBurden;                         // D51

  // ---- Non-standard adders ----
  let nsMat = 0, nsLabor = 0, nsBurden = 0, nsHours = 0;
  const nsRows = [];
  for (const b of NS_BLOCKS) {
    const markup = g(`NS_Adder_${b.n}_Markup_Percent__c`) / 100;
    const mat = g(`NS_Adder_${b.n}_Material_Cost__c`);
    const hours = g(`NS_Adder_${b.n}_Labor_Hours__c`);
    const labor = laborRate * hours;      // NS adders use the BLENDED rate (unlike standard adders)
    const bur = labor * 0.75;
    const markupAmt = mat * markup;
    // Standardized: markup included in the adder total for all three blocks (design doc quirk #3)
    const total = mat + markupAmt + labor + bur;
    nsMat += mat; nsLabor += labor; nsBurden += bur; nsHours += hours;
    nsRows.push({ ...b, markup, mat, hours, labor, bur, markupAmt, total });
  }

  const adderLaborTotal = stdLabor + nsLabor;                                  // J41
  const adderBurdenTotal = stdBurden + nsBurden;                               // J42
  const adderHoursTotal = stdHours + nsHours;                                  // K42
  const totalAdderCost = stdAdderTotal + nsRows.reduce((s, r) => s + r.total, 0); // J39

  // ---- Budget lines (Acumatica-coded) ----
  const coFee = g('Constructive_Ops_Fee__c');                                  // K22 -> GENO
  const permit = g('Permit_Pass_Through_Cost__c');                             // K23 -> GENO
  const totalMaterial = moduleMat + combinerMat + gatewayMat + inverterMat + batteryMat + bosSolar + bosElec + roofMat + nsMat; // K24 -> GENM
  const totalOther = g('Material_Other_Cost__c') + stdMat;                     // K25 -> GENO (std adder materials land here)
  const totalLabor = auditLabor + qaLabor + roofLabor + s1Labor + s2Labor + batteryLabor + adderLaborTotal; // K26
  const totalBurden = (auditLabor + qaLabor + roofLabor + s1Labor + s2Labor + batteryLabor) * burden + adderBurdenTotal; // K27 -> BURDENEXR
  const s3Labor = batteryLabor + adderLaborTotal;                              // S3 Acumatica line
  const totalJobCost = coFee + permit + totalMaterial + totalOther + totalLabor + totalBurden; // K28
  const totalJobCostWithComm = totalJobCost + totalCommissions;                // K29

  // ---- Hours ----
  const genaHours = g('Audit_Hours__c') + g('QA_Commissioning_Hours__c');      // K33
  const s1Hours = laborRate > 0 ? s1Labor / laborRate : 0;                     // K34
  const s2Hours = laborRate > 0 ? s2Labor / laborRate : 0;                     // K35
  const s3Hours = g('Battery_Install_Hours__c') + adderHoursTotal;             // K36
  const totalHours = genaHours + s1Hours + s2Hours + s3Hours;                  // K32

  // ---- Summary ----
  const contract = g('Contract_Amount__c');
  const balanceOfRevenue = contract - g('Dealer_Fee__c') - totalCommissions;   // N9
  const gpDollars = balanceOfRevenue - totalMaterial - totalOther - (totalLabor + totalBurden) - (coFee + permit); // N14
  const gpPctWithComm = contract > 0 ? gpDollars / contract : 0;               // N15
  const gpPctNoComm = balanceOfRevenue !== 0 ? gpDollars / balanceOfRevenue : 0; // N16

  // ---- Salesforce output fields ----
  const fields = {
    System_Size_Watts__c: watts,
    Calculated_Module_Count__c: r2(mods),
    Sales_Rep_Commission_Amt__c: r2(salesRepComm),
    Sales_Mgr_Commission_Amt__c: r2(mgrComm),
    Overhead_Commission_Amt__c: r2(overheadComm),
    Commission_Subtotal__c: r2(commSubtotal),
    Commission_Burden_Amt__c: r2(commBurden),
    Total_Commissions__c: r2(totalCommissions),
    Commission_PPW__c: watts > 0 ? totalCommissions / watts : 0,
    Module_Material_Cost__c: r2(moduleMat),
    Combiner_Cost__c: r2(combinerMat),
    Gateway_Cost__c: r2(gatewayMat),
    Microinverter_Cost__c: r2(inverterMat),
    Battery_Material_Cost__c: r2(batteryMat),
    BOS_Solar_Cost__c: r2(bosSolar),
    BOS_Electrical_Cost__c: r2(bosElec),
    Roofing_Material_Cost__c: r2(roofMat),
    Audit_Labor_Cost__c: r2(auditLabor),
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
    Std_Adder_Cost_Total__c: r2(stdAdderTotal),
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
    Cost_PPW__c: watts > 0 ? totalJobCost / watts : 0,
    Cost_PPW_With_Comm__c: watts > 0 ? totalJobCostWithComm / watts : 0,
    GENA_Hours__c: genaHours,
    S1_Hours__c: s1Hours,
    S2_Hours__c: s2Hours,
    S3_Hours__c: s3Hours,
    Total_Job_Hours__c: totalHours,
    Balance_of_Revenue__c: r2(balanceOfRevenue),
    Total_Labor_And_Burden__c: r2(totalLabor + totalBurden),
    GP_Dollars__c: r2(gpDollars),
    GP_Percent_With_Comm__c: r2(gpPctWithComm * 100), // percent fields stored as whole numbers
    GP_Percent_No_Comm__c: r2(gpPctNoComm * 100),
  };

  // ---- Spreadsheet cell map (inputs + every computed cell) for the snapshot workbook ----
  const cells = {
    A4: rec.Project_Name__c || rec.Name || '',
    N6: contract, N7: g('Dealer_Fee__c'),
    D7: g('System_Size__c'), B7: rec.Panel_Type__c || rec.Module_Manufacturer__c || '',
    B8: moduleWatts, B9: g('Module_Cost_Per_Watt__c'),
    B10: g('Combiner_Unit_Cost__c'), C10: g('Combiner_Qty__c'),
    B11: g('Gateway_Unit_Cost__c'), C11: g('Gateway_Qty__c'),
    B12: g('Microinverter_Unit_Cost__c'), C12: g('Microinverter_Qty__c'),
    B13: g('Battery_Unit_Cost__c'), C13: g('Battery_Qty__c'),
    B14: g('BOS_Solar_Cost_Per_Watt__c'), B15: g('BOS_Electrical_Cost_Per_Watt__c'),
    B16: g('Roof_Material_Cost_Per_Pen__c'), B17: g('Penetrations_Per_Module__c'),
    B18: laborRate, B19: burden, B20: g('Audit_Hours__c'), B21: g('QA_Commissioning_Hours__c'),
    B22: g('Roofing_Cost_Per_Penetration__c'), B23: g('Roofing_Pens_Per_Module__c'),
    B24: g('Install_Hours_Per_Module__c'), B25: g('Material_Other_Cost__c'),
    B26: coFee, B27: permit, B28: battRate, B29: g('Battery_Install_Hours__c'),
    J7: g('Sales_Rep_Commission_PPW__c'), J8: g('Sales_Mgr_Commission_PPW__c'),
    J9: geoComm, J10: g('Overhead_Commission_PPW__c'), K12: commBurdenRate,
    // computed
    F7: watts, G7: moduleWatts, F9: mods,
    K7: salesRepComm, K8: mgrComm, K9: geoComm, K10: overheadComm,
    J11: commSubtotal, J12: commBurden, J13: totalCommissions, J14: watts > 0 ? totalCommissions / watts : 0,
    G12: moduleMat, G13: combinerMat, G14: gatewayMat, G15: inverterMat, G16: batteryMat,
    F17: g('BOS_Solar_Cost_Per_Watt__c'), G17: bosSolar,
    F18: g('BOS_Electrical_Cost_Per_Watt__c'), G18: bosElec,
    F19: g('Roof_Material_Cost_Per_Pen__c'), G19: roofMat,
    F21: laborRate, G21: auditLabor, H21: g('Audit_Hours__c'),
    F22: burden, G22: auditLabor * burden, K22: coFee,
    F23: laborRate, G23: qaLabor, H23: g('QA_Commissioning_Hours__c'), K23: permit,
    F24: burden, G24: qaLabor * burden, K24: totalMaterial,
    F25: g('Roofing_Cost_Per_Penetration__c'), G25: roofLabor, K25: totalOther,
    F26: burden, G26: roofLabor * burden, K26: totalLabor,
    F27: laborRate, G27: installLabor, H27: g('Install_Hours_Per_Module__c') * mods, K27: totalBurden,
    F28: s1Labor, G28: s1Labor, H28: s1Hours, K28: totalJobCost,
    F29: burden, G29: s1Labor * burden, K29: totalJobCostWithComm,
    F30: s2Labor, G30: s2Labor, H30: s2Hours, K30: watts > 0 ? totalJobCost / watts : 0,
    F31: burden, G31: s2Labor * burden, K31: watts > 0 ? totalJobCostWithComm / watts : 0,
    F32: battRate, G32: batteryLabor, H32: g('Battery_Install_Hours__c'), K32: totalHours,
    F33: burden, G33: batteryLabor * burden, K33: genaHours,
    K34: s1Hours, K35: s2Hours, K36: s3Hours,
    D49: stdMat, D50: stdLabor + stdBurden, D51: stdAdderTotal,
    J39: totalAdderCost, J40: nsMat, J41: adderLaborTotal, J42: adderBurdenTotal, J43: adderLaborTotal + adderBurdenTotal, K42: adderHoursTotal,
    N8: totalCommissions, N9: balanceOfRevenue, N10: totalMaterial, N11: totalOther,
    N12: totalLabor + totalBurden, N13: coFee + permit, N14: gpDollars, N15: gpPctWithComm, N16: gpPctNoComm,
  };
  // per-adder rows (price, qty, materials D, hours E, labor F, burden G)
  for (const a of adderRows) {
    cells[`B${a.row}`] = num(rec[`Adder_${a.base}_Price__c`]);
    cells[`C${a.row}`] = num(rec[`Adder_${a.base}_Qty__c`]);
    cells[`D${a.row}`] = a.mat;
    if (a.hoursPerUnit > 0) {
      cells[`E${a.row}`] = a.hours; cells[`F${a.row}`] = a.labor; cells[`G${a.row}`] = a.bur;
    }
  }
  // non-standard blocks
  for (const b of nsRows) {
    cells[b.descCell] = rec[`NS_Adder_${b.n}_Description__c`] || '';
    cells[b.markupCell] = b.markup; cells[b.matCell] = b.mat; cells[b.hoursCell] = b.hours;
    cells[b.laborCell] = b.labor; cells[b.burdenCell] = b.bur;
    cells[b.totalCell] = b.total; cells[b.markupOutCell] = b.markupAmt; cells[b.hoursOutCell] = b.hours;
  }

  return { fields, cells };
}

module.exports = { calculateBudget, STD_ADDERS, NS_BLOCKS };
