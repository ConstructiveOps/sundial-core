// Data fix for the NS markup percent-domain bug.
//
// ---------------------------------------------------------------------------
// WHAT WENT WRONG
// ---------------------------------------------------------------------------
// The five `NS_Adder_N_Markup_Percent__c` fields were created with
// `<defaultValue>25</defaultValue>`. A Percent field's defaultValue is a formula
// expression evaluated in the **DECIMAL** domain, so `25` there means 25.0 as a fraction
// — **2500%** — and every record created since carries a stored API value of **2500**.
// Setup renders the default expression back as "25", so nothing looked wrong.
//
// The REST/SOQL domain is different again: there a true 25% reads as **25**. So the fix
// is `2500 -> 25`, and that is a genuine change of meaning (2500% -> 25%), not a rescale
// of the same number.
//
// All three domains were measured on a live record by
// `scripts/probe-percent-field-domain.mjs`. Do not adjust the constants here without
// re-running it.
//
// ---------------------------------------------------------------------------
// ⚠️ DEPLOY ORDER — THIS SCRIPT AND THE FORMULA FIX ARE A PAIR
// ---------------------------------------------------------------------------
// Until now TWO bugs cancelled out:
//
//   data 2500  ->  formula sees 25  ->  old formula did 1 + 25/100  =  1.25   ✔ by accident
//
// The formula fix removes that `/100` (a formula already receives the decimal). So:
//
//   * DATA FIXED, FORMULA NOT:  1 + 0.25/100 = 1.0025  -> markup nearly vanishes.
//     Mild, and it understates the adder deduction, so commission is slightly OVERpaid.
//   * FORMULA FIXED, DATA NOT:  1 + 25       = 26      -> a 26x markup on materials.
//     Catastrophic.
//
// So: **run this FIRST, deploy the formula package immediately after.** The safe window is
// the small one. Both orders are recoverable; only one is quiet.
//
// (budgetCalc.js is unaffected by the ordering — it reads the REST domain and its own
// /100 was always correct. On a 2500 record it produced a 26x markup today, which the new
// NS_MARKUP_IMPLAUSIBLE guard now refuses outright.)
//
// ---------------------------------------------------------------------------
// RUNNING IT
// ---------------------------------------------------------------------------
//   node scripts/fix-ns-markup-percent-domain.mjs           # READ-ONLY. Default.
//   node scripts/fix-ns-markup-percent-domain.mjs --apply   # writes
//
// Only values that are EXACTLY 2500 are touched. Anything else non-null was set by a
// human and is listed for review, never overwritten — same rule as
// scripts/backfill-storage-adder-prices.mjs.

import { sfQuery, sfUpdateRecord } from "../lib/salesforce.js";

const APPLY = process.argv.includes("--apply");

/** The broken stored value, and what a true 25% is in the REST domain. */
const BROKEN_VALUE = 2500;
const CORRECT_VALUE = 25;

const BLOCKS = [1, 2, 3, 4, 5];
const MARKUP = (n) => `NS_Adder_${n}_Markup_Percent__c`;
const MARKUP_FIELDS = BLOCKS.map(MARKUP);

const OBJECTS = {
  Sundial_Customer__c: {
    label: "Customer",
    nameField: "Name",
    // No record-triggered flow on this object watches these fields.
    triggersRecalc: false,
  },
  Sundial_Solar__c: {
    label: "Solar",
    nameField: "Name",
    // ⚠️ Sundial_Budget_Recalc_Trigger fires on Sundial_Solar__c and lists every
    // NS_Adder_N_Markup_Percent__c among its ISCHANGED inputs. A write here sets
    // Budget_Calc_Status__c = Pending and publishes a recalc platform event PER RECORD.
    // Reported loudly before applying so the blast radius is a decision, not a surprise.
    triggersRecalc: true,
  },
};

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const show = (v) => (v === null ? "null" : String(v));

async function loadAll(objName) {
  const o = OBJECTS[objName];
  return (
    (await sfQuery(
      `SELECT Id, ${o.nameField}, Client__r.Name, Total_Adder_Price__c, Commission_Total__c, ` +
        `${MARKUP_FIELDS.join(", ")} FROM ${objName}`
    )) ?? []
  );
}

// ---------------------------------------------------------------------------
// SURVEY — counts before anything is written
// ---------------------------------------------------------------------------
console.log("=".repeat(80));
console.log("NS MARKUP PERCENT-DOMAIN FIX — survey");
console.log("=".repeat(80));
console.log(`  broken value ${BROKEN_VALUE} (= ${BROKEN_VALUE}%)  ->  ${CORRECT_VALUE} (= a true ${CORRECT_VALUE}%)`);

const loaded = {};
const plans = [];
const humanSet = [];

for (const objName of Object.keys(OBJECTS)) {
  const rows = await loadAll(objName);
  loaded[objName] = rows;
  console.log(`\n  ${objName} — ${rows.length} records`);
  console.log("    block                            null      2500(fix)   other(leave)");
  for (const n of BLOCKS) {
    const f = MARKUP(n);
    let nulls = 0, broken = 0;
    const others = new Map();
    for (const r of rows) {
      const v = num(r[f]);
      if (v === null) nulls++;
      else if (v === BROKEN_VALUE) broken++;
      else others.set(String(v), (others.get(String(v)) ?? 0) + 1);
    }
    const otherTotal = [...others.values()].reduce((a, b) => a + b, 0);
    const otherDesc = [...others.entries()].map(([v, c]) => `${v}x${c}`).join(" ");
    console.log(
      `    ${f.padEnd(30)} ${String(nulls).padStart(8)} ${String(broken).padStart(11)} ` +
        `${String(otherTotal).padStart(14)}  ${otherDesc}`
    );
  }

  // Build the plan and collect human-set values.
  for (const r of rows) {
    const updates = {};
    for (const n of BLOCKS) {
      const f = MARKUP(n);
      const v = num(r[f]);
      if (v === BROKEN_VALUE) updates[f] = CORRECT_VALUE;
      else if (v !== null && v !== 0) humanSet.push({ objName, r, field: f, value: v });
    }
    if (Object.keys(updates).length > 0) plans.push({ objName, r, updates });
  }
}

// ---------------------------------------------------------------------------
// HUMAN-SET VALUES — listed, never touched
// ---------------------------------------------------------------------------
console.log("\n" + "-".repeat(80));
console.log("HUMAN-SET VALUES — NOT 2500, so NOT touched. Review these yourself.");
console.log("-".repeat(80));
if (humanSet.length === 0) {
  console.log("  none.");
} else {
  for (const h of humanSet) {
    const o = OBJECTS[h.objName];
    console.log(
      `  ${o.label.padEnd(8)} ${h.r.Id}  ${String(h.r[o.nameField] ?? "").slice(0, 28).padEnd(28)} ` +
        `${h.field} = ${h.value}`
    );
  }
}

// Zeros are reported as a count rather than a list — there are thousands, and 0 is a
// legitimate "no markup" value, not a symptom. Flagged because the INTENDED default is
// now 25%: whether these should become 25 is a business decision, not a bug fix.
console.log("\n  zeros (legitimate 'no markup', left alone — but note the default is now 25%):");
for (const objName of Object.keys(OBJECTS)) {
  for (const n of BLOCKS) {
    const c = loaded[objName].filter((r) => num(r[MARKUP(n)]) === 0).length;
    if (c > 0) console.log(`     ${OBJECTS[objName].label.padEnd(8)} ${MARKUP(n).padEnd(30)} ${c}`);
  }
}

// ---------------------------------------------------------------------------
// APPLY
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(80));
console.log(`${APPLY ? "APPLYING" : "DRY RUN (no writes — pass --apply)"} — ${plans.length} record(s) to change`);
console.log("=".repeat(80));

if (plans.length === 0) {
  console.log("  nothing to do — no record carries the broken value.\n");
  process.exit(0);
}

// Recalc-trigger warning, per object, before any write.
for (const objName of Object.keys(OBJECTS)) {
  const n = plans.filter((p) => p.objName === objName).length;
  if (n > 0 && OBJECTS[objName].triggersRecalc) {
    console.log(
      `\n  ⚠️  ${n} ${objName} write(s) will each fire Sundial_Budget_Recalc_Trigger:\n` +
        "      Budget_Calc_Status__c -> Pending and a Sundial_Budget_Recalc__e platform\n" +
        "      event per record. That is a real load, and any record with a blank sales\n" +
        "      company will come back with a SALES_COMPANY_MISSING calc error."
    );
  }
}

console.log("\n  obj      Id                  name                      fields        Total_Adder_Price      Commission_Total");
console.log("  " + "-".repeat(112));

let applied = 0;
const failures = [];
for (const p of plans) {
  const o = OBJECTS[p.objName];
  const fields = Object.keys(p.updates).map((f) => f.replace(/NS_Adder_(\d)_Markup_Percent__c/, "NS$1")).join(",");
  const beforeAdder = num(p.r.Total_Adder_Price__c);
  const beforeComm = num(p.r.Commission_Total__c);

  let afterAdder = beforeAdder;
  let afterComm = beforeComm;
  let status = "dry-run";

  if (APPLY) {
    try {
      await sfUpdateRecord(p.objName, p.r.Id, p.updates);
      // Re-read so the audit shows what the org actually holds, not what we predicted.
      const [fresh] = await sfQuery(
        `SELECT Id, Total_Adder_Price__c, Commission_Total__c FROM ${p.objName} WHERE Id = '${p.r.Id}'`
      );
      afterAdder = num(fresh?.Total_Adder_Price__c);
      afterComm = num(fresh?.Commission_Total__c);
      applied++;
      status = "written";
    } catch (e) {
      status = "FAILED";
      failures.push({ id: p.r.Id, obj: p.objName, error: String(e.sfBody ?? e.message).slice(0, 160) });
    }
  }

  console.log(
    `  ${o.label.padEnd(8)} ${p.r.Id.padEnd(19)} ${String(p.r[o.nameField] ?? "").slice(0, 24).padEnd(25)} ` +
      `${fields.padEnd(13)} ${show(beforeAdder).padStart(9)} -> ${show(afterAdder).padStart(9)}   ` +
      `${show(beforeComm).padStart(9)} -> ${show(afterComm).padStart(9)}  ${status}`
  );
}

if (failures.length) {
  console.log(`\n  ** ${failures.length} WRITE FAILURE(S) **`);
  for (const f of failures) console.log(`     ${f.obj} ${f.id}: ${f.error}`);
  process.exitCode = 1;
}

if (APPLY) {
  console.log(`\n  ${applied} of ${plans.length} record(s) written.`);
  console.log(
    "\n  ⚠️  NOW DEPLOY salesforce/v3-redline-commission-fields/ — until it lands, the\n" +
      "      Total_Adder_Price__c formula still has its /100 and these records' markup\n" +
      "      reads as ~0% rather than 25%. See the deploy-order note at the top of this file."
  );
} else {
  console.log("\n  DRY RUN — nothing was written. Re-run with --apply.");
}
console.log("");
