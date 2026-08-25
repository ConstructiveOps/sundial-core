// POST-DEPLOY probe for the NS markup percent-domain fix (D-063).
//
// This is the README's manual "set material 1000, hours 0, markup 25%, expect +1,250"
// check, automated so it is repeatable and so the restore cannot be forgotten.
//
// WHAT IT PROVES, and why the delta is the right instrument:
//
//   Holding NS block 1 at material 1000 / hours 0, the block contributes
//   `Material x (1 + Markup)` to Total_Adder_Price__c. Everything else on the record is
//   held constant, so the DELTA isolates the markup term:
//
//     +1,250.00  ✅ correct — a true 25% markup
//     +1,002.50  ✗ the formula still has its `/100`, dividing an already-decimal value
//                  twice. The v3 package did not land.
//     +26,000    ✗ the record's markup reads 2500, so the data fix missed it.
//
// ⚠️ TEST RECORDS ONLY. Defaults to a Sundial_Customer__c test record, and Customer is
// also the safe object here: Sundial_Budget_Recalc_Trigger fires on Sundial_Solar__c and
// watches NS_Adder_N_Markup_Percent__c, so probing Solar would publish a recalc platform
// event per write. See CLAUDE.md — portal/round-trip testing uses the designated
// ZZ PORTAL TEST record, never a live customer.
//
// Originals are captured up front and restored in a `finally`, pass or fail.
//
//   node scripts/verify-ns-markup-postdeploy.mjs [recordId]

import { describeObject, sfQuery, sfUpdateRecord } from "../lib/salesforce.js";

const OBJ = "Sundial_Customer__c";
const ID = process.argv[2] || "a1P7y00000AmMTVEA3"; // "Test Roofing 1"

const F_MARKUP = "NS_Adder_1_Markup_Percent__c";
const F_MATERIAL = "NS_Adder_1_Material_Cost__c";
const F_HOURS = "NS_Adder_1_Labor_Hours__c";
const TOUCHED = [F_MARKUP, F_MATERIAL, F_HOURS];
const READ = [...TOUCHED, "Total_Adder_Price__c", "Commission_Total__c"];

const show = (v) => (v === null || v === undefined ? "null" : String(v));
const money = (v) => (v === null || v === undefined ? "null" : Number(v).toFixed(2));

async function read() {
  const [r] = await sfQuery(`SELECT Id, Name, ${READ.join(", ")} FROM ${OBJ} WHERE Id = '${ID}'`);
  return r;
}

// ---------------------------------------------------------------------------
// STEP 1 — did the metadata actually land? Read it before moving any data.
// ---------------------------------------------------------------------------
console.log("=".repeat(78));
console.log("STEP 1 — live metadata: did both packages land?");
console.log("=".repeat(78));

let metadataOk = true;
for (const obj of ["Sundial_Customer__c", "Sundial_Solar__c"]) {
  const d = await describeObject(obj);
  const byName = new Map(d.fields.map((f) => [f.name, f]));

  const tap = byName.get("Total_Adder_Price__c");
  const formula = tap?.calculatedFormula ?? "";
  const hasDiv = /NS_Adder_1_Markup_Percent__c,0\)\/100/.test(formula);
  if (hasDiv) metadataOk = false;
  console.log(`\n  ${obj}`);
  console.log(`     Total_Adder_Price__c markup term has /100 : ${hasDiv ? "** YES — v3 NOT deployed **" : "no  ✅"}`);

  const m1 = byName.get(F_MARKUP);
  const dv = m1?.defaultValueFormula ?? m1?.defaultValue ?? null;
  const dvOk = String(dv) === "0.25";
  if (!dvOk) metadataOk = false;
  console.log(`     ${F_MARKUP} default             : ${show(dv)} ${dvOk ? "✅" : "** expected 0.25 **"}`);
  console.log(`     ${F_MARKUP} type                 : Percent(${m1?.precision},${m1?.scale})`);
}

// ---------------------------------------------------------------------------
// STEP 2 — the arithmetic, on a test record
// ---------------------------------------------------------------------------
const before = await read();
if (!before) throw new Error(`test record ${ID} not readable`);

console.log("\n" + "=".repeat(78));
console.log(`STEP 2 — arithmetic probe on ${ID} "${before.Name}"`);
console.log("=".repeat(78));
console.log("  original state:");
for (const f of READ) console.log(`     ${f.padEnd(30)} ${show(before[f])}`);

const original = Object.fromEntries(TOUCHED.map((f) => [f, before[f] ?? null]));
let verdict = "INCONCLUSIVE";
let delta = null;

try {
  // Baseline: block 1 contributes nothing.
  await sfUpdateRecord(OBJ, ID, { [F_MATERIAL]: 0, [F_HOURS]: 0, [F_MARKUP]: 0 });
  const base = await read();
  const baseAdder = Number(base.Total_Adder_Price__c ?? 0);

  // The measurement. 25 is a TRUE 25% in the REST/SOQL domain (D-063).
  await sfUpdateRecord(OBJ, ID, { [F_MATERIAL]: 1000, [F_HOURS]: 0, [F_MARKUP]: 25 });
  const after = await read();
  const afterAdder = Number(after.Total_Adder_Price__c ?? 0);
  delta = afterAdder - baseAdder;

  console.log("\n  material 1000, hours 0, markup 25 (= a true 25%)");
  console.log(`     markup read back            ${show(after[F_MARKUP])}`);
  console.log(`     Total_Adder_Price__c base   ${money(baseAdder)}`);
  console.log(`     Total_Adder_Price__c after  ${money(afterAdder)}`);
  console.log(`     DELTA                       ${money(delta)}`);

  const near = (x) => Math.abs(delta - x) < 0.005;
  if (near(1250)) verdict = "PASS";
  else if (near(1002.5)) verdict = "FAIL_FORMULA_NOT_DEPLOYED";
  else if (near(26000)) verdict = "FAIL_LEGACY_2500";
  else verdict = "FAIL_UNEXPECTED";
} finally {
  await sfUpdateRecord(OBJ, ID, original);
  const restored = await read();
  console.log("\n  restored:");
  for (const f of TOUCHED) {
    const ok = show(restored[f]) === show(original[f]);
    console.log(`     ${f.padEnd(30)} ${show(restored[f])} ${ok ? "ok" : "** MISMATCH **"}`);
  }
  console.log(`     Total_Adder_Price__c back to ${money(restored.Total_Adder_Price__c)} ` +
    `(was ${money(before.Total_Adder_Price__c)}) ` +
    `${money(restored.Total_Adder_Price__c) === money(before.Total_Adder_Price__c) ? "ok" : "** MISMATCH **"}`);
}

console.log("\n" + "=".repeat(78));
console.log("VERDICT");
console.log("=".repeat(78));
const MSG = {
  PASS: "✅ +1,250.00 — the formula fix landed and the record holds a true 25%.",
  FAIL_FORMULA_NOT_DEPLOYED:
    "✗ +1,002.50 — the Total_Adder_Price__c formula STILL divides by 100. The v3 package did not land. STOP.",
  FAIL_LEGACY_2500:
    "✗ +26,000 — the record's markup is being read as 2500. A legacy value survived the data fix. STOP.",
  FAIL_UNEXPECTED: `✗ delta ${money(delta)} matches none of the three expected outcomes. STOP and investigate.`,
  INCONCLUSIVE: "✗ the probe threw before measuring.",
};
console.log(`  ${MSG[verdict]}`);
console.log(`  metadata check: ${metadataOk ? "both packages present ✅" : "** something did not land **"}`);
console.log("");
process.exitCode = verdict === "PASS" && metadataOk ? 0 : 1;
