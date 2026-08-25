// Creates (or re-seeds) the DESIGNATED portal test record.
//
// WHY THERE IS A DESIGNATED RECORD AT ALL
//
// On 2026-08-24 a "blank Adders tab" incident was triaged against a LIVE customer
// (a1P7y00000AmMy9EAF, Doug Malde) on the belief that a portal save had nulled its
// fields. It had not. The record was a fresh unlinked lead that had never held adder
// data — 13 of the 20 adder prices carry no metadata default and are null on essentially
// every record in the org. Hours went into proving a negative, and the actual question
// (does the frontend's save null untouched fields?) stayed open, because a record with
// almost nothing populated cannot distinguish "not sent" from "sent as null".
//
// This record exists so that question has a witness. It is deliberately RICH: adder
// prices AND quantities, an NS block with material and hours, a battery, and enough
// contract/system data that Commission_Total__c computes to a real number rather than
// blank. If a save nulls untouched fields, this record shows it loudly.
//
// See CLAUDE.md — portal round-trip and save testing uses THIS record, never a live one.
//
//   node scripts/create-portal-test-record.mjs            # dry run, prints the payload
//   node scripts/create-portal-test-record.mjs --apply    # create or re-seed
//
// Re-running with --apply on an existing ZZ PORTAL TEST record RE-SEEDS it to the known
// state below, which is how you reset it after a test has scribbled on it.

import { sfQuery, sfCreateRecord, sfUpdateRecord } from "../lib/salesforce.js";

const APPLY = process.argv.includes("--apply");
const OBJ = "Sundial_Customer__c";
const NAME = "ZZ PORTAL TEST — DO NOT USE";
const TENANT_ID = "a1W7y000007AszBEAS"; // Sundial_Tenant__c "harmon" — Client__c is required

/**
 * The seeded state, built on the D19 worked example so the expected outputs are known
 * numbers rather than whatever falls out:
 *
 *   redline      external + non-Lightreach              = 1.85
 *   adders       the 3,110 set from verify.mjs          = 3,110.00
 *                + Derate 600 x 1                       =   600.00
 *                + Heat Detector 450 x 2                =   900.00
 *   NS block 1   1000 x (1 + 0.25) + 10 x 33 x 1.75     = 1,827.50
 *   battery      1 x 9,950 (field default on create)    = 9,950.00
 *   ------------------------------------------------------------------
 *   Total_Adder_Price__c                                = 16,387.50
 *   Commission_Total__c  36502 - 1.85 x 8800 - 16387.5  =  3,834.50
 *   Commission_Total_PPW__c  3834.5 / 8800              =      0.4357
 *
 * NS markup is written as 25 because the REST/SOQL domain is the DISPLAY domain — a true
 * 25%. The Salesforce formula sees 0.25 for the same field. See D-063.
 */
const SEED = {
  Name: NAME,
  Client__c: TENANT_ID,
  Status__c: "Lead",
  Stage__c: "New",

  // Contract / system — enough for the commission formulas to produce a real number.
  Sales_Company__c: "Third-Party Dealer",   // EXTERNAL
  Financing_Partner__c: "GoodLeap",         // not Lightreach -> redline 1.85
  Final_System_Size_kW__c: 8.8,             // 8,800 W
  Contract_Amount__c: 36502,

  // Adder PRICES + QTYS. The verify.mjs "3110" set.
  Adder_Sub_Panel_Price__c: 500, Adder_Sub_Panel_Qty__c: 1,
  Adder_Structural_Price__c: 500, Adder_Structural_Qty__c: 1,
  // Per-watt adder: 0.10/W is a realistic value and stays well under the $10/W
  // PPW_PRICE_IMPLAUSIBLE ceiling (D28).
  Adder_Bird_Blocking_Price__c: 0.1, Adder_Bird_Blocking_Qty__c: 1,
  Adder_Software_Fee_Price__c: 30, Adder_Software_Fee_Qty__c: 1,
  Adder_Active_Monitoring_Price__c: 100, Adder_Active_Monitoring_Qty__c: 1,
  Adder_LR_Battery_Warranty_Price__c: 600, Adder_LR_Battery_Warranty_Qty__c: 1,
  Adder_Referral_Fee_Price__c: 500, Adder_Referral_Fee_Qty__c: 1,

  // A couple of adders that carry NO metadata default, so the record holds values that
  // exist nowhere else in the org. These are the ones a blanket-null save would destroy
  // most visibly — and the ones Doug Malde could not have shown, because he never had them.
  Adder_Derate_Price__c: 600, Adder_Derate_Qty__c: 1,
  Adder_Heat_Detector_Price__c: 450, Adder_Heat_Detector_Qty__c: 2,

  // NS block 1 — material AND hours AND a markup, so all three code paths are exercised.
  NS_Adder_1_Description__c: "Portal test NS block — do not remove",
  NS_Adder_1_Material_Cost__c: 1000,
  NS_Adder_1_Labor_Hours__c: 10,
  NS_Adder_1_Markup_Percent__c: 25,   // REST domain: a TRUE 25%

  // Storage. Battery_Unit_Price__c is left unset ON PURPOSE so the 9,950 metadata default
  // applies on create — which also makes this record a live check that the default works.
  Battery_Qty__c: 1,

  Outreach_Notes__c:
    "DESIGNATED PORTAL TEST RECORD — DO NOT USE FOR REAL BUSINESS.\n" +
    "Seeded by scripts/create-portal-test-record.mjs. All portal round-trip and save " +
    "testing runs against this record (CLAUDE.md), never a live customer.\n" +
    "Expected: Total_Adder_Price__c = 16387.50, Commission_Total__c = 3834.50, " +
    "Commission_Redline_PPW__c = 1.85.\n" +
    "Re-seed after a test with: node scripts/create-portal-test-record.mjs --apply",
};

const EXPECTED = { Total_Adder_Price__c: 16387.5, Commission_Total__c: 3834.5, Commission_Redline_PPW__c: 1.85 };
const CHECK = [
  "Total_Adder_Price__c", "Commission_Total__c", "Commission_Redline_PPW__c",
  "Commission_Total_PPW__c", "Battery_Qty__c", "Battery_Unit_Price__c",
  "NS_Adder_1_Markup_Percent__c", "NS_Adder_1_Material_Cost__c",
];

const [existing] = await sfQuery(
  `SELECT Id, Name, CreatedDate FROM ${OBJ} WHERE Name = '${NAME.replace(/'/g, "\\'")}' LIMIT 1`
);

console.log("=".repeat(78));
console.log(existing ? `RE-SEED existing ${existing.Id}` : "CREATE a new designated test record");
console.log("=".repeat(78));
console.log(`  name   ${NAME}`);
console.log(`  tenant ${TENANT_ID} (harmon)`);
console.log(`  ${Object.keys(SEED).length} fields seeded\n`);
console.log("  expected once the formulas evaluate:");
for (const [k, v] of Object.entries(EXPECTED)) console.log(`     ${k.padEnd(30)} ${v}`);

if (!APPLY) {
  console.log("\n  DRY RUN — nothing written. Re-run with --apply.\n");
  process.exit(0);
}

let id;
if (existing) {
  const { Name, ...rest } = SEED; // never rename on re-seed
  await sfUpdateRecord(OBJ, existing.Id, rest);
  id = existing.Id;
  console.log(`\n  re-seeded ${id}`);
} else {
  const res = await sfCreateRecord(OBJ, SEED);
  id = res.id ?? res.Id;
  console.log(`\n  created ${id}`);
}

const [rec] = await sfQuery(`SELECT Id, Name, ${CHECK.join(", ")} FROM ${OBJ} WHERE Id = '${id}'`);
console.log("\n  formula outputs as the org computed them:");
let ok = true;
for (const f of CHECK) {
  const exp = EXPECTED[f];
  const got = rec[f];
  const good = exp === undefined ? true : Math.abs(Number(got) - exp) < 0.005;
  if (!good) ok = false;
  console.log(`     ${f.padEnd(30)} ${got}${exp === undefined ? "" : good ? "  ✅" : `  ** expected ${exp} **`}`);
}
console.log(
  ok
    ? "\n  ✅ every formula matches the expected value — the record is a valid baseline.\n"
    : "\n  ** a formula does not match; the record is seeded but the baseline is not what the doc says. **\n"
);
console.log(`  RECORD ID: ${id}\n`);
process.exitCode = ok ? 0 : 1;
