/* Verifies roofing budgetCalc against the Mills example workbook and builds a sample snapshot. */
const assert = require('assert');
const fs = require('fs');
const { calculateBudget } = require('./budgetCalc');
const { buildWorkbook, snapshotKey } = require('./budgetWorkbook');

const MILLS = {
  Project_Name__c: 'Mills',
  Squares_Shingle__c: 0, Squares_Tile__c: 28, Squares_Modified__c: 0, Squares_Recoat__c: 0,
  Labor_Rate_Shingle__c: 124, Labor_Rate_Tile__c: 217, Labor_Rate_Modified__c: 93, Labor_Rate_Recoat__c: 124,
  Roll_Off_Qty__c: 1, Roll_Off_Cost__c: 600, Misc_Other_Qty__c: 1, Misc_Other_Cost__c: 250,
  Labor_Markup_Percent__c: 35, Material_Markup_Percent__c: 30, Other_Markup_Percent__c: 30,
  Commission_Markup_Percent__c: 20, Burden_Rate__c: 20,
  Commission_Rate_Percent__c: 2.5, Geo_Commission_Amount__c: 70,
  Job_City__c: 'El Mirage', City_Tax_Rate__c: 9.3,
  Warranty_Line_Item_Amount__c: 0, Warranty_Cost__c: 1500, Contract_Presented_Amount__c: 14775,
  // materials with nonzero qty on the Mills job; all costs are catalog defaults
  Mat_OC_Oakridge_Qty__c: 7, Mat_OC_Oakridge_Cost__c: 40.66,
  Mat_Fontana_G40_Qty__c: 10, Mat_Fontana_G40_Cost__c: 45,
  Mat_ABC_Proguard_Qty__c: 1, Mat_ABC_Proguard_Cost__c: 59.75,
  Mat_Furring_Strip_Qty__c: 15, Mat_Furring_Strip_Cost__c: 16.5,
  Mat_Drip_Edge_Painted_Qty__c: 14, Mat_Drip_Edge_Painted_Cost__c: 7.5,
  Mat_Jack_15_Alum_Qty__c: 2, Mat_Jack_15_Alum_Cost__c: 29.99,
  Mat_Jack_2_Alum_Qty__c: 2, Mat_Jack_2_Alum_Cost__c: 29.99,
  Mat_Jack_2_Galv_Qty__c: 2, Mat_Jack_2_Galv_Cost__c: 5.65,
  Mat_Jack_3_Galv_Qty__c: 2, Mat_Jack_3_Galv_Cost__c: 8.7,
  Mat_TTop_4_Alum_Qty__c: 2, Mat_TTop_4_Alum_Cost__c: 15.05,
  Mat_TTop_7_Galv_Qty__c: 1, Mat_TTop_7_Galv_Cost__c: 12.9,
  Mat_Staples_Qty__c: 1, Mat_Staples_Cost__c: 50.99,
  Mat_Nails_1_Simplex_Qty__c: 1, Mat_Nails_1_Simplex_Cost__c: 20,
  Mat_WB_Ridge_Qty__c: 1, Mat_WB_Ridge_Cost__c: 60,
  Mat_Birdstop_Metal_Qty__c: 14, Mat_Birdstop_Metal_Cost__c: 8.1,
  Mat_Tile_Pallet_Qty__c: 1, Mat_Tile_Pallet_Cost__c: 697,
};

const EXPECTED = { // from the original workbook's cached values
  Total_Labor_Budget__c: 6076, Labor_Burden_Budget__c: 1215.2, Labor_Markup_Amt__c: 2551.92,
  Labor_Total_With_Markup__c: 9843.12,
  Total_Material_Budget__c: 2279.92, Material_Markup_Amt__c: 683.98, Material_Total_With_Markup__c: 2963.9,
  Other_Budget__c: 850, Other_Markup_Amt__c: 255, Other_Total_With_Markup__c: 1105,
  Cost_Subtotal__c: 13912.02,
  Commission_Amt__c: 347.8, Commission_Burden_Amt__c: 69.56, Commission_Markup_Amt__c: 83.47,
  Geo_Burden_Amt__c: 14, Commission_Total__c: 584.83,
  Total_Job_Cost_Client__c: 14496.85, Acumatica_Budget_Total__c: 10922.48, Markup_Profit_Dollars__c: 3574.37,
  Taxable_Amount__c: 2963.9, City_Tax_Amount__c: 275.64, Warranty_Delta__c: -1500,
  Total_Proposal_Cost__c: 14772.49, Proposal_Cost_Less_Taxes__c: 14496.85,
  Total_Squares__c: 28, Budgeted_Hours__c: 209.5, Days_On_Job__c: 6.5,
  Profit_After_Commission_Pct__c: 24.66, Cost_Per_Square_All_In__c: 527.59, Cost_Per_Square_No_Tax__c: 517.74,
};

const { fields, cells } = calculateBudget(MILLS);
let failures = 0;
for (const [k, exp] of Object.entries(EXPECTED)) {
  if (Math.abs(fields[k] - exp) > 0.011) { console.error(`FAIL ${k}: expected ${exp}, got ${fields[k]}`); failures++; }
}
assert.strictEqual(failures, 0, `${failures} field checks failed`);
console.log(`roofing budgetCalc: all ${Object.keys(EXPECTED).length} field checks pass`);

buildWorkbook(cells, { recordId: 'a0YTEST00000001', generatedAt: '2026-07-22T12:00:00Z' }).then((buf) => {
  fs.writeFileSync('/tmp/roofing-snapshot-test.xlsx', Buffer.from(buf));
  console.log(`workbook snapshot written (${buf.byteLength} bytes), key example: ${snapshotKey('a0YTEST00000001', 'Mills', new Date('2026-07-22T12:00:00Z'))}`);
});
