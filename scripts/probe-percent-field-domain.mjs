// EMPIRICAL probe of Salesforce's Percent-field domain — API, storage, and FORMULA.
//
// WHY THIS EXISTS, and why it is a probe rather than a paragraph of reasoning.
//
// `v2-field-alignments` and `v2-budget-adder-fields` created the five
// `NS_Adder_N_Markup_Percent__c` fields as **Percent** with `<defaultValue>25</defaultValue>`.
// A Percent field's `defaultValue` is a FORMULA EXPRESSION evaluated in the DECIMAL
// domain, so `25` there does not mean "25%" — it means 25.0 as a decimal fraction, i.e.
// **2500%**. Setup renders the default expression back as "25", so it reads as correct.
//
// Three separate domains could each be the decimal one or the display one, and getting any
// of them wrong silently changes what a rep is paid:
//
//   1. the metadata `defaultValue` expression
//   2. the REST API read/write value (what `sfUpdateRecord` and SOQL see)
//   3. what a FORMULA FIELD sees when it references the percent field
//
// Salesforce genuinely does treat (1) differently from (2), which is the entire bug. And
// (3) is not safe to assume equals (2) — formula fields can see Percent differently from
// the API. Tim also reported observing a save of "25" reading back as ".25", which no
// amount of reasoning can confirm or dismiss.
//
// So: measure all three, on a real record, and let every layer below agree with the
// numbers this prints rather than with anybody's model of Salesforce.
//
//   node scripts/probe-percent-field-domain.mjs
//
// SAFETY
//   - Runs against ONE Customer test record, whose original values are saved up front and
//     restored in a `finally` block whether it passes, fails or throws.
//   - CUSTOMER ON PURPOSE. `Sundial_Budget_Recalc_Trigger` fires on Sundial_Solar__c and
//     lists NS_Adder_N_Markup_Percent__c among its ISCHANGED inputs, so probing on Solar
//     would set Budget_Calc_Status = Pending and publish a recalc platform event on every
//     write. Customer has no such trigger, so the probe is inert.
//   - Customer's markup fields are Percent(6,3) — max 999.999 — so 2500 CANNOT be written
//     there. That is itself the symptom Tim hit, and the probe records it rather than
//     working around it.

import { describeObject, sfQuery, sfUpdateRecord } from "../lib/salesforce.js";

const BLOCKS = [1, 2, 3, 4, 5];
const MARKUP = (n) => `NS_Adder_${n}_Markup_Percent__c`;

// A clearly-named test record that already carries a default-created value.
const PROBE_ID = "a1P7y00000AmMTVEA3"; // Sundial_Customer__c "Test Roofing 1"

const F_MARKUP = MARKUP(1);
const F_MATERIAL = "NS_Adder_1_Material_Cost__c";
const F_HOURS = "NS_Adder_1_Labor_Hours__c";
const TOUCHED = [F_MARKUP, F_MATERIAL, F_HOURS];
const READBACK = [...TOUCHED, "Total_Adder_Price__c", "Commission_Total__c"];

const show = (v) => (v === null || v === undefined ? "null" : JSON.stringify(v));

async function read(id, fields) {
  const rows = await sfQuery(`SELECT Id, ${fields.join(", ")} FROM Sundial_Customer__c WHERE Id = '${id}'`);
  return rows[0];
}

// ---------------------------------------------------------------------------
// PART A — what is actually deployed
// ---------------------------------------------------------------------------
console.log("=".repeat(78));
console.log("PART A — live describe of the five markup fields on BOTH objects");
console.log("=".repeat(78));
console.log("  (precision/scale and the DEFAULT EXPRESSION as the org actually holds it)");

for (const obj of ["Sundial_Customer__c", "Sundial_Solar__c"]) {
  const d = await describeObject(obj);
  const byName = new Map(d.fields.map((f) => [f.name, f]));
  console.log(`\n  ${obj}`);
  for (const n of BLOCKS) {
    const f = byName.get(MARKUP(n));
    if (!f) {
      console.log(`     ** ABSENT ** ${MARKUP(n)}`);
      continue;
    }
    const maxVal = 10 ** (f.precision - f.scale) - 10 ** -f.scale;
    console.log(
      `     ${MARKUP(n).padEnd(30)} ${String(f.type).padEnd(8)} ` +
        `(${f.precision},${f.scale}) max=${maxVal.toFixed(f.scale).padStart(12)} ` +
        `default=${show(f.defaultValueFormula ?? f.defaultValue)}`
    );
  }
}

// ---------------------------------------------------------------------------
// PART B/C — round trip on a real record
// ---------------------------------------------------------------------------
const before = await read(PROBE_ID, READBACK);
if (!before) throw new Error(`probe record ${PROBE_ID} not readable`);

console.log("\n" + "=".repeat(78));
console.log(`PART B — a DEFAULT-CREATED record, read raw (${PROBE_ID} "Test Roofing 1")`);
console.log("=".repeat(78));
for (const f of READBACK) console.log(`  ${f.padEnd(30)} ${show(before[f])}`);
console.log(
  `\n  => the stored value produced by <defaultValue>25</defaultValue> is ${show(before[F_MARKUP])}.`
);

const original = Object.fromEntries(TOUCHED.map((f) => [f, before[f] ?? null]));
const results = [];

try {
  // Baseline with NO material, so the block contributes nothing and everything else on the
  // record is held constant. Every later delta is measured against this.
  await sfUpdateRecord("Sundial_Customer__c", PROBE_ID, {
    [F_MATERIAL]: 0, [F_HOURS]: 0, [F_MARKUP]: 0,
  });
  const base = await read(PROBE_ID, READBACK);
  const baseAdder = Number(base.Total_Adder_Price__c ?? 0);

  console.log("\n" + "=".repeat(78));
  console.log("PART C — REST round trip AND the formula domain, measured together");
  console.log("=".repeat(78));
  console.log(`  baseline Total_Adder_Price__c with material 0 / markup 0: ${baseAdder}`);
  console.log(`\n  Holding ${F_MATERIAL} = 1000 and ${F_HOURS} = 0, the formula term is`);
  console.log("      Material x (1 + Markup/100)");
  console.log("  so the Total_Adder_Price__c DELTA tells us what the FORMULA sees:");
  console.log("      delta 1002.50  => formula sees 0.25   (decimal domain)");
  console.log("      delta 1250.00  => formula sees 25     (display domain)");
  console.log("      delta 26000.00 => formula sees 2500   (decimal-as-percent, the bug)");
  console.log("");
  console.log("  wrote     read back    Total_Adder_Price   delta    => formula saw");
  console.log("  " + "-".repeat(72));

  for (const wrote of [25, 0.25, 1, 100]) {
    await sfUpdateRecord("Sundial_Customer__c", PROBE_ID, {
      [F_MATERIAL]: 1000, [F_HOURS]: 0, [F_MARKUP]: wrote,
    });
    const after = await read(PROBE_ID, READBACK);
    const readBack = after[F_MARKUP];
    const adder = Number(after.Total_Adder_Price__c ?? 0);
    const delta = adder - baseAdder;
    // delta = 1000 * (1 + M/100)  =>  M = (delta/1000 - 1) * 100
    const formulaSaw = (delta / 1000 - 1) * 100;
    results.push({ wrote, readBack, delta, formulaSaw });
    console.log(
      `  ${String(wrote).padStart(7)}  ${show(readBack).padStart(10)}  ` +
        `${adder.toFixed(2).padStart(16)}  ${delta.toFixed(2).padStart(10)}  => ${formulaSaw.toFixed(4)}`
    );
  }

  // Customer is Percent(6,3): 2500 must NOT fit. Recording the refusal is the point.
  console.log("\n  Precision ceiling check — writing 2500 to Customer's Percent(6,3):");
  try {
    await sfUpdateRecord("Sundial_Customer__c", PROBE_ID, { [F_MARKUP]: 2500 });
    const after = await read(PROBE_ID, [F_MARKUP]);
    console.log(`     ACCEPTED, read back ${show(after[F_MARKUP])}  (unexpected — check the describe)`);
  } catch (e) {
    const body = String(e.sfBody ?? e.message).slice(0, 200);
    console.log(`     REFUSED as expected: ${body}`);
  }
} finally {
  // ⚠️ THE RESTORE CAN ITSELF HIT THE BUG, and the first run of this probe did.
  // The record's ORIGINAL markup was 2500 — a value Customer's Percent(6,3) will not
  // accept, because it was only ever written by the metadata default, which is evaluated
  // in a domain the API does not share. So "put it back exactly as it was" is impossible
  // through the API. The fallback writes the CORRECTED value (25 = a true 25%), which is
  // what the data fix sets it to anyway, and says loudly that it did.
  let restoreNote = "exact";
  try {
    await sfUpdateRecord("Sundial_Customer__c", PROBE_ID, original);
  } catch (e) {
    restoreNote = "CORRECTED, not exact";
    console.log(
      `\n  ** exact restore REFUSED ** ${String(e.sfBody ?? e.message).slice(0, 130)}` +
        `\n     The original value cannot be written back through the API — that IS the bug.` +
        `\n     Writing the corrected value (25 = a true 25%) instead.`
    );
    await sfUpdateRecord("Sundial_Customer__c", PROBE_ID, { ...original, [F_MARKUP]: 25 });
  }
  const restored = await read(PROBE_ID, READBACK);
  console.log(`\n  restored (${restoreNote}):`);
  for (const f of TOUCHED) {
    const ok = show(restored[f]) === show(original[f]);
    console.log(`     ${f.padEnd(30)} ${show(restored[f])} ${ok ? "ok" : "(differs — see note above)"}`);
  }
}

// ---------------------------------------------------------------------------
// The verdict, stated in terms every layer below has to match
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("VERDICT");
console.log("=".repeat(78));
const r25 = results.find((r) => r.wrote === 25);
if (r25) {
  const apiEcho = Number(r25.readBack) === 25;
  console.log(`  REST domain    : wrote 25, read back ${show(r25.readBack)} ` +
    `-> the API ${apiEcho ? "ECHOES the value unchanged (no scaling)" : "SCALES the value"}.`);
  console.log(`  FORMULA domain : with 25 written, the formula saw ${r25.formulaSaw.toFixed(4)}.`);
  const agree = Math.abs(r25.formulaSaw - Number(r25.readBack)) < 0.0001;
  console.log(`  => REST and FORMULA ${agree ? "AGREE — one domain, no conversion needed between them." : "DISAGREE — a layer must convert."}`);
  console.log(`  => To store a true 25% the REST/SOQL value is ${apiEcho && agree ? "25" : "(see the table above)"},`);
  console.log(`     and budgetCalc's /100 then yields ${(1 + Number(r25.readBack) / 100).toFixed(4)} as the markup multiplier.`);
}
console.log("");
