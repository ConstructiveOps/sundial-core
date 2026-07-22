/* Verifies budgetCalc against the HOLLAND example workbook and builds a sample snapshot. */
const assert = require('assert');
const fs = require('fs');
const { calculateBudget } = require('./budgetCalc');
const { buildWorkbook, snapshotKey } = require('./budgetWorkbook');

const HOLLAND = {
  Project_Name__c: 'HOLLAND', Panel_Type__c: 'HYUNDAI',
  Contract_Amount__c: 108000, Dealer_Fee__c: 0,
  System_Size__c: 19.8, Module_STC_Wattage__c: 440, Module_Cost_Per_Watt__c: 0.4,
  Sales_Rep_Commission_PPW__c: 0.1, Sales_Mgr_Commission_PPW__c: 0.04,
  Geo_Commission_Amount__c: 70, Overhead_Commission_PPW__c: 0.015, Commission_Burden_Rate__c: 75,
  Combiner_Unit_Cost__c: 604.81, Combiner_Qty__c: 1, Gateway_Unit_Cost__c: 878.64, Gateway_Qty__c: 1,
  Microinverter_Unit_Cost__c: 109.93, Microinverter_Qty__c: 45, Battery_Unit_Cost__c: 7383.33, Battery_Qty__c: 4,
  BOS_Solar_Cost_Per_Watt__c: 0.17, BOS_Electrical_Cost_Per_Watt__c: 0.1,
  Roof_Material_Cost_Per_Pen__c: 24, Penetrations_Per_Module__c: 1.75,
  Blended_Labor_Rate__c: 28.25, Labor_Burden_Rate__c: 75, Audit_Hours__c: 2, QA_Commissioning_Hours__c: 6,
  Roofing_Cost_Per_Penetration__c: 21, Roofing_Pens_Per_Module__c: 1.75, Install_Hours_Per_Module__c: 2,
  Battery_Labor_Rate__c: 33, Battery_Install_Hours__c: 64,
  Material_Other_Cost__c: 890.15, Constructive_Ops_Fee__c: 850, Permit_Pass_Through_Cost__c: 800,
  Adder_Sub_Panel_Price__c: 500, Adder_Sub_Panel_Qty__c: 0,
  Adder_Flat_Roof_Price__c: 0.1, Adder_Flat_Roof_Qty__c: 1,
  Adder_Bird_Blocking_Price__c: 0.1, Adder_Bird_Blocking_Qty__c: 0,
  Adder_Derate_Price__c: 600, Adder_Derate_Qty__c: 0,
  Adder_Structural_Price__c: 500, Adder_Structural_Qty__c: 0,
  Adder_Small_System_10_12_Price__c: 1250, Adder_Small_System_10_12_Qty__c: 0,
  Adder_Small_System_13_15_Price__c: 1000, Adder_Small_System_13_15_Qty__c: 0,
  Adder_Heat_Detector_Price__c: 350, Adder_Heat_Detector_Qty__c: 1,
  Adder_Conduit_Attic_Price__c: 0.1, Adder_Conduit_Attic_Qty__c: 0,
  Adder_Roof_Tile_Price__c: 0.05, Adder_Roof_Tile_Qty__c: 0,
  Adder_Software_Fee_Price__c: 30, Adder_Software_Fee_Qty__c: 0,
  Adder_Upgrade_225_Price__c: 2850, Adder_Upgrade_225_Qty__c: 0,
  Adder_Upgrade_400_Price__c: 4950, Adder_Upgrade_400_Qty__c: 0,
  NS_Adder_1_Description__c: 'PW NOW MAIN GARAGE - TRM - BACK TO SES LOCATION',
  NS_Adder_1_Markup_Percent__c: 0, NS_Adder_1_Material_Cost__c: 846.82, NS_Adder_1_Labor_Hours__c: 4,
  NS_Adder_2_Description__c: 'INITIAL WIRE PULL ADDER',
  NS_Adder_2_Markup_Percent__c: 15.3927, NS_Adder_2_Material_Cost__c: 2355, NS_Adder_2_Labor_Hours__c: 40,
  NS_Adder_3_Description__c: 'WIRE PULL ADDER - TO DETACHED GARAGE',
  NS_Adder_3_Markup_Percent__c: 0, NS_Adder_3_Material_Cost__c: 6354, NS_Adder_3_Labor_Hours__c: 58,
};

const EXPECTED = { // from the original workbook's cached values
  System_Size_Watts__c: 19800, Calculated_Module_Count__c: 45,
  Commission_Subtotal__c: 3139, Commission_Burden_Amt__c: 869.25, Total_Commissions__c: 4008.25,
  Std_Adder_Material_Total__c: 2099, Std_Adder_Cost_Total__c: 2330,
  NS_Adder_1_Total__c: 1044.57, NS_Adder_2_Total__c: 4694.998085, NS_Adder_3_Total__c: 9221.375,
  NS_Adder_Material_Total__c: 9555.82, Adder_Labor_Total__c: 3013.5, Adder_Burden_Total__c: 2260.125,
  Adder_Hours_Total__c: 106, Total_Adder_Cost__c: 17290.943085,
  Total_Material_Budget__c: 60675.44, Total_Other_Budget__c: 2989.15,
  Total_Labor_Budget__c: 9547.75, Total_Labor_Burden_Budget__c: 7160.8125,
  Constructive_Ops_Total__c: 1650, Total_Job_Cost__c: 82023.1525, Total_Job_Cost_With_Comm__c: 86031.4025,
  GENA_Hours__c: 8, S1_Hours__c: 60, S2_Hours__c: 30, S3_Hours__c: 170, Total_Job_Hours__c: 268,
  Balance_of_Revenue__c: 103991.75, Total_Labor_And_Burden__c: 16708.5625,
  GP_Dollars__c: 21968.6, GP_Percent_With_Comm__c: 20.34, GP_Percent_No_Comm__c: 21.13,
};

const { fields, cells } = calculateBudget(HOLLAND);
let failures = 0;
for (const [k, exp] of Object.entries(EXPECTED)) {
  const got = fields[k];
  if (Math.abs(got - exp) > 0.011) { console.error(`FAIL ${k}: expected ${exp}, got ${got}`); failures++; }
}
assert.strictEqual(failures, 0, `${failures} field checks failed`);
console.log(`budgetCalc: all ${Object.keys(EXPECTED).length} field checks pass`);

buildWorkbook(cells, { recordId: 'a0XTEST00000001', generatedAt: '2026-07-21T12:00:00Z' }).then((buf) => {
  const key = snapshotKey('a0XTEST00000001', 'HOLLAND', new Date('2026-07-21T12:00:00Z'));
  fs.writeFileSync('/tmp/snapshot-test.xlsx', Buffer.from(buf));
  console.log(`workbook snapshot written (${buf.byteLength} bytes), key example: ${key}`);
});
