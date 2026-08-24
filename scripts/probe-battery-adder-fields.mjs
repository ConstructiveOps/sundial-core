// Read-only describe gate for the battery / Tesla-expansion adder commission fix.
//
// Batteries and expansion packs are sold OUTSIDE the redline x watts model, so their
// price has to land in Total_Adder_Price__c like any other adder. Before touching the
// generator, prove against the LIVE org that:
//
//   1. Battery_Unit_Price__c and Tesla_Expansion_Pack_Unit_Price__c exist on BOTH
//      Sundial_Customer__c and Sundial_Solar__c (Tim created them via the Setup UI).
//   2. The INTEGRATION USER can read them — describe() only returns FLS-visible fields
//      for the calling user, so absence here is either "not created" or "no FLS", and
//      `accessible` on the field distinguishes the two.
//   3. The quantity fields the formulas will multiply by are present, INCLUDING the
//      deliberate Solar mismatch: Tesla_* price x Gateway_* qty (see README / D19).
//
//   node scripts/probe-battery-adder-fields.mjs

import { describeObject } from "../lib/salesforce.js";

const PRICE_FIELDS = ["Battery_Unit_Price__c", "Tesla_Expansion_Pack_Unit_Price__c"];

// Quantity fields, per object. Solar's expansion-pack qty is Gateway_Qty__c on purpose:
// the budget engine and the Create Project map both maintain Gateway_*, and Solar's
// Tesla_Expansion_Pack_Quantity__c is an orphan nothing writes.
const QTY_FIELDS = {
  Sundial_Customer__c: ["Battery_Qty__c", "Tesla_Expansion_Pack_Qty__c"],
  Sundial_Solar__c: ["Battery_Qty__c", "Gateway_Qty__c"],
};

// Reported for the record, never used by a formula.
const ORPHANS = {
  Sundial_Customer__c: [],
  Sundial_Solar__c: ["Tesla_Expansion_Pack_Quantity__c"],
};

let problems = 0;

function show(f, api) {
  if (!f) {
    problems++;
    console.log(`   ** ABSENT **  ${api}  (not created, or no FLS for the integration user)`);
    return;
  }
  const readable = f.accessible !== false;
  if (!readable) problems++;
  console.log(
    `   ${readable ? "ok        " : "** NO FLS **"}  ${api.padEnd(38)} ` +
      `${String(f.type).padEnd(10)} (${f.precision ?? "-"},${f.scale ?? "-"}) ` +
      `default=${f.defaultValueFormula ?? f.defaultValue ?? "(none)"} ` +
      `updateable=${f.updateable}`
  );
}

for (const objName of ["Sundial_Customer__c", "Sundial_Solar__c"]) {
  const d = await describeObject(objName);
  const byName = new Map(d.fields.map((f) => [f.name, f]));
  console.log(`\n=== ${objName} — ${d.fields.length} fields visible to the integration user ===`);

  console.log("-- NEW price fields (expect PRESENT + readable):");
  for (const api of PRICE_FIELDS) show(byName.get(api), api);

  console.log("-- quantity fields the formula multiplies by (expect PRESENT):");
  for (const api of QTY_FIELDS[objName]) show(byName.get(api), api);

  if (ORPHANS[objName].length) {
    console.log("-- deliberately UNUSED (documented mismatch, listed for the record):");
    for (const api of ORPHANS[objName]) {
      const f = byName.get(api);
      console.log(`   ${api.padEnd(38)} ${f ? String(f.type) : "(absent)"}`);
    }
  }

  console.log("-- anything else matching Battery / Expansion / Gateway (near-duplicate watch):");
  for (const f of d.fields) {
    if (/Battery|Expansion|Gateway/i.test(f.name)) {
      console.log(`   ${f.name.padEnd(38)} ${String(f.type).padEnd(10)} "${f.label}"`);
    }
  }
}

console.log(
  problems === 0
    ? "\nGATE PASSED — every field present and readable.\n"
    : `\n** GATE FAILED — ${problems} field(s) absent or not readable. STOP. **\n`
);
process.exitCode = problems === 0 ? 0 : 1;
