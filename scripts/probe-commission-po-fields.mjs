// Read-only describe probe for the §4f commission-PO package.
//
// Two questions, both facts rather than judgements:
//   1. COLLISION — do any of the 8 proposed Commission_PO_* API names already exist on
//      Sundial_Solar__c? An additive package that collides is a failed deploy at best.
//   2. Q13 — do the two named milestone date fields exist, and what type are they?
//      Audit_Date_and_DateTime__c (M1) and Scheduled_Install_Date__c (M2).
//
// Also re-checks the Bill_Out_in_Acumatica_Requested__c pair, which the gap list called
// unrelated AR markers.
//
//   node scripts/probe-commission-po-fields.mjs

import { describeObject } from "../lib/salesforce.js";

const PROPOSED = [
  "Commission_PO_M1_Number__c",
  "Commission_PO_M2_Number__c",
  "Commission_PO_M1_Amount__c",
  "Commission_PO_M2_Amount__c",
  "Commission_PO_M1_Created__c",
  "Commission_PO_M2_Created__c",
  "Commission_PO_Status__c",
  "Commission_PO_Error__c",
];

const Q13 = ["Audit_Date_and_DateTime__c", "Scheduled_Install_Date__c"];

const d = await describeObject("Sundial_Solar__c");
const byName = new Map(d.fields.map((f) => [f.name, f]));

console.log(`Sundial_Solar__c: ${d.fields.length} fields\n`);

console.log("-- collision check (expect all ABSENT):");
let collisions = 0;
for (const api of PROPOSED) {
  const f = byName.get(api);
  if (f) { collisions++; console.log(`   ** PRESENT ** ${api}  (${f.type})`); }
  else console.log(`   absent      ${api}`);
}

console.log("\n-- Q13 milestone dates (expect PRESENT):");
for (const api of Q13) {
  const f = byName.get(api);
  console.log(f ? `   ${api} = ${f.type}${f.updateable ? "" : " (READ ONLY)"}  label="${f.label}"` : `   ** MISSING ** ${api}`);
}

console.log("\n-- anything else matching PO / Commission / Milestone / Bill_Out:");
for (const f of d.fields) {
  if (/Bill_Out|Commission|Milestone|_PO_/i.test(f.name)) {
    console.log(`   ${f.name.padEnd(42)} ${String(f.type).padEnd(10)} "${f.label}"`);
  }
}

process.exitCode = collisions === 0 ? 0 : 1;
