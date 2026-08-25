// Data fix + sweep for the BURDEN RATE percent-domain defect (D-063 amendment).
//
// Same defect as the NS markup: `<defaultValue>75</defaultValue>` on a Percent field is a
// formula expression evaluated in the DECIMAL domain, so it means 75.0 as a fraction —
// **7500%** — and every record created since stores an API value of 7500. Setup renders
// the expression back as "75".
//
// AFFECTED (confirmed against the live describe):
//   Sundial_Solar__c.Labor_Burden_Rate__c        Percent(18,2)  default 75  -> stores 7500
//   Sundial_Solar__c.Commission_Burden_Rate__c   Percent(18,2)  default 75  -> stores 7500
//
// NOT affected, and worth knowing why:
//   Sundial_Customer__c — both fields are Percent(5,2) with NO default at all. The narrow
//   type also makes 7500 structurally unstorable there (max 999.99). Swept anyway rather
//   than reasoned about.
//
// ⚠️ WHY THIS ONE IS WORSE THAN THE MARKUP BUG. budgetCalc reads these through SOQL and
// divides by 100:
//     const burden        = g('Labor_Burden_Rate__c') / 100;
//     const commBurdenRate = g('Commission_Burden_Rate__c') / 100;
// A true 75% arrives as 75 and becomes 0.75. A record carrying 7500 becomes **75.0** — a
// 7500% burden, i.e. every burden figure 100x too large. Unlike the markup bug there is no
// second error cancelling it: this one is wrong in the calc today.
//
// ⚠️ AUTOMATION FAN-OUT — verified EMPIRICALLY, because it cannot be verified from
// metadata with this user's access.
//
// `salesforce/flows/Sundial_Budget_Recalc_Trigger.flow-meta.xml` fires on
// Sundial_Solar__c and lists BOTH burden fields among its ISCHANGED inputs. On paper that
// makes 4,473 writes into 4,473 platform events. But that flow is **repo metadata only** —
// drafted during the budget build and never deployed (TASKS.md still lists "Activate the
// Flow" and "wire the Platform-Event relay" as open), and the SF->AWS relay was never
// wired either, so no event could reach the Lambda regardless.
//
// The integration user cannot read `FlowDefinitionView` or `ApexTrigger` (both return
// INVALID_TYPE — no View Setup), so THE REPO CANNOT BE CHECKED AGAINST THE ORG FROM HERE.
// Rather than trust either the repo or an assumption, this script writes ONE record first
// and then re-reads it to see whether anything reacted. That is the canary below, and it
// aborts the run if automation is detected.
//
// ⚠️ FOR THE FUTURE: today's safety is an accident of sequencing, not a design property.
// **When the recalc Flow is eventually activated, a bulk data fix like this one MUST
// deactivate it first**, or it will fan out one platform event per record. The canary
// will catch it either way — it is designed to stop, not to plough on.
//
//   node scripts/fix-burden-rate-percent-domain.mjs           # READ-ONLY. Default.
//   node scripts/fix-burden-rate-percent-domain.mjs --apply   # writes
//
// ⚠️ DO NOT PIPE THE OUTPUT through `head`/`sed`/`tail` on a real run. The shell reports
// the LAST command's exit status, so a partial write exits 0 and the failure signal is
// swallowed — which is exactly the case where you need it. On the 2026-08-24 run, 2 of
// 4,473 records failed with transient `fetch failed` and the piped invocation still
// reported success; the failures were only visible because the script prints them.
//
// This script is IDEMPOTENT: it re-reads the org every run and only plans records still
// holding the broken value. Re-running after a partial write is the correct recovery, and
// costs nothing when there is nothing left to do.

import { sfQuery, sfUpdateRecord } from "../lib/salesforce.js";

const APPLY = process.argv.includes("--apply");

const BROKEN_VALUE = 7500;
const CORRECT_VALUE = 75;
const CEILING = 100; // a burden rate above 100% is not a percentage

const FIELDS = ["Labor_Burden_Rate__c", "Commission_Burden_Rate__c"];

const OBJECTS = {
  Sundial_Solar__c: { label: "Solar", nameField: "Name", triggersRecalc: true },
  Sundial_Customer__c: { label: "Customer", nameField: "Name", triggersRecalc: false },
};

// Evidence that a budget calc has actually RUN on a record. If any of these is set while
// the record carries 7500, its burden outputs are 100x wrong and someone has to know.
const CALC_EVIDENCE = [
  "Budget_Calc_Status__c", "Budget_Calculated_At__c",
  "Total_Burden_Budget__c", "Total_Job_Cost__c", "Total_Labor_Budget__c",
];

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const show = (v) => (v === null || v === undefined ? "null" : String(v));

/** Not every object has every calc field — probe once so the SELECT cannot 400. */
async function usableCalcFields(objName) {
  const ok = [];
  for (const f of CALC_EVIDENCE) {
    try {
      await sfQuery(`SELECT ${f} FROM ${objName} LIMIT 1`);
      ok.push(f);
    } catch {
      /* absent on this object */
    }
  }
  return ok;
}

console.log("=".repeat(80));
console.log("BURDEN RATE PERCENT-DOMAIN FIX — survey");
console.log("=".repeat(80));
console.log(`  broken ${BROKEN_VALUE} (= ${BROKEN_VALUE}%)  ->  ${CORRECT_VALUE} (= a true ${CORRECT_VALUE}%)`);

const plans = [];
const outOfRange = [];
const calcedWhileBroken = [];

for (const [objName, o] of Object.entries(OBJECTS)) {
  const calcFields = await usableCalcFields(objName);
  const rows = await sfQuery(
    `SELECT Id, ${o.nameField}, ${FIELDS.join(", ")}${calcFields.length ? ", " + calcFields.join(", ") : ""} FROM ${objName}`
  );

  console.log(`\n  ${objName} — ${rows.length} records`);
  console.log(`    calc-evidence fields present: ${calcFields.join(", ") || "(none)"}`);
  console.log("    field                          null      7500(fix)   other(leave)");
  for (const f of FIELDS) {
    let nulls = 0, broken = 0;
    const others = new Map();
    for (const r of rows) {
      const v = num(r[f]);
      if (v === null) nulls++;
      else if (v === BROKEN_VALUE) broken++;
      else others.set(String(v), (others.get(String(v)) ?? 0) + 1);
    }
    const otherTotal = [...others.values()].reduce((a, b) => a + b, 0);
    const otherDesc = [...others.entries()].sort((a, b) => b[1] - a[1]).map(([v, c]) => `${v}x${c}`).join(" ");
    console.log(
      `    ${f.padEnd(30)} ${String(nulls).padStart(6)} ${String(broken).padStart(11)} ${String(otherTotal).padStart(14)}  ${otherDesc}`
    );
  }

  for (const r of rows) {
    const updates = {};
    for (const f of FIELDS) {
      const v = num(r[f]);
      if (v === BROKEN_VALUE) updates[f] = CORRECT_VALUE;
      else if (v !== null && v > CEILING) outOfRange.push({ objName, r, field: f, value: v });
    }
    if (Object.keys(updates).length === 0) continue;
    plans.push({ objName, r, updates, calcFields });

    // Has a calc actually run on this record while it held 7500?
    const evidence = calcFields
      .filter((f) => r[f] !== null && r[f] !== undefined && r[f] !== "" && r[f] !== 0)
      .map((f) => `${f}=${r[f]}`);
    if (evidence.length) calcedWhileBroken.push({ objName, r, evidence });
  }
}

// ---------------------------------------------------------------------------
// The question that decides whether this is an incident or a near miss
// ---------------------------------------------------------------------------
console.log("\n" + "-".repeat(80));
console.log("HAS A BUDGET CALC RUN ON A RECORD CARRYING 7500?");
console.log("-".repeat(80));
if (calcedWhileBroken.length === 0) {
  console.log("  NO — no record carrying 7500 shows any evidence of a completed budget calc.");
  console.log("  Nothing downstream is 100x wrong. This is a near miss, not an incident.");
} else {
  console.log(`  ** YES — ${calcedWhileBroken.length} record(s). Their burden outputs are 100x too large. **\n`);
  for (const c of calcedWhileBroken) {
    console.log(`  ${OBJECTS[c.objName].label} ${c.r.Id}  ${String(c.r[OBJECTS[c.objName].nameField] ?? "").slice(0, 34)}`);
    for (const e of c.evidence) console.log(`     ${e}`);
  }
}

console.log("\n" + "-".repeat(80));
console.log(`OUT-OF-RANGE BUT NOT 7500 — listed, NOT touched (> ${CEILING}%)`);
console.log("-".repeat(80));
if (outOfRange.length === 0) console.log("  none.");
else {
  for (const h of outOfRange) {
    console.log(`  ${OBJECTS[h.objName].label.padEnd(9)} ${h.r.Id}  ${String(h.r[OBJECTS[h.objName].nameField] ?? "").slice(0, 28).padEnd(29)} ${h.field} = ${h.value}`);
  }
}

// ---------------------------------------------------------------------------
// APPLY
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(80));
console.log(`${APPLY ? "APPLYING" : "DRY RUN (no writes — pass --apply)"} — ${plans.length} record(s)`);
console.log("=".repeat(80));

if (plans.length === 0) {
  console.log("  nothing to do.\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CANARY — write ONE record, then look for a reaction before writing 4,472 more.
//
// This is the only automation check available: the integration user cannot read
// FlowDefinitionView or ApexTrigger. If a record-triggered flow on Sundial_Solar__c
// watches these fields, its first act is `Budget_Calc_Status__c = Pending`, applied in the
// same save and therefore visible on an immediate re-read.
//
// The canary record is one that needed fixing anyway, so nothing is wasted if it passes.
// ---------------------------------------------------------------------------
const CANARY_WATCH = ["Budget_Calc_Status__c", "Budget_Calc_Error__c"];

async function canary(plan) {
  const o = OBJECTS[plan.objName];
  const sel = CANARY_WATCH.filter((f) => plan.calcFields.includes(f) || f === "Budget_Calc_Error__c");
  const readOne = async () => {
    try {
      const [r] = await sfQuery(`SELECT Id, ${sel.join(", ")}, LastModifiedDate FROM ${plan.objName} WHERE Id = '${plan.r.Id}'`);
      return r;
    } catch {
      const [r] = await sfQuery(`SELECT Id, LastModifiedDate FROM ${plan.objName} WHERE Id = '${plan.r.Id}'`);
      return r;
    }
  };

  console.log(`\n  CANARY — writing ${plan.r.Id} (${String(plan.r[o.nameField] ?? "")}) alone first`);
  const pre = await readOne();
  for (const f of sel) console.log(`     before  ${f.padEnd(24)} ${show(pre?.[f])}`);

  await sfUpdateRecord(plan.objName, plan.r.Id, plan.updates);
  const post = await readOne();
  for (const f of sel) console.log(`     after   ${f.padEnd(24)} ${show(post?.[f])}`);

  const reacted = sel.some((f) => show(pre?.[f]) !== show(post?.[f]));
  if (reacted) {
    console.log(
      "\n  ** AUTOMATION DETECTED — a field this script did not write has changed. **\n" +
        "     A record-triggered flow on this object is live and watching the burden fields.\n" +
        "     STOPPING after one record. Deactivate the flow, then re-run.\n" +
        `     The canary record ${plan.r.Id} HAS been written and is now correct.`
    );
    return false;
  }
  console.log("     -> nothing else changed. No active automation on these fields. Proceeding.");
  return true;
}

let applied = 0;
const failures = [];
let remaining = plans;

if (APPLY) {
  const ok = await canary(plans[0]);
  applied++;
  remaining = plans.slice(1);
  if (!ok) {
    console.log(`\n  1 of ${plans.length} written (the canary). ${plans.length - 1} left untouched.\n`);
    process.exitCode = 1;
    process.exit(1);
  }
}

// Progress is printed periodically rather than per record: 4,473 lines of "written" is
// not a log, it is a wall.
const PROGRESS_EVERY = 250;
console.log(`\n  writing ${remaining.length} more record(s), progress every ${PROGRESS_EVERY}...`);

for (const [i, p] of remaining.entries()) {
  if (!APPLY) {
    if (i < 5) {
      const o = OBJECTS[p.objName];
      const fields = Object.keys(p.updates).map((f) => f.replace("_Burden_Rate__c", "")).join(",");
      console.log(`  ${o.label.padEnd(9)} ${p.r.Id.padEnd(19)} ${String(p.r[o.nameField] ?? "").slice(0, 25).padEnd(26)} ${fields.padEnd(28)} dry-run`);
    } else if (i === 5) {
      console.log(`  ... and ${remaining.length - 5} more`);
    }
    continue;
  }
  try {
    await sfUpdateRecord(p.objName, p.r.Id, p.updates);
    applied++;
  } catch (e) {
    failures.push({ id: p.r.Id, obj: p.objName, error: String(e.sfBody ?? e.message).slice(0, 160) });
  }
  if ((i + 1) % PROGRESS_EVERY === 0) {
    console.log(`     ${applied} written, ${failures.length} failed  (${i + 1}/${remaining.length})`);
  }
}

if (failures.length) {
  console.log(`\n  ** ${failures.length} WRITE FAILURE(S) **`);
  for (const f of failures) console.log(`     ${f.obj} ${f.id}: ${f.error}`);
  process.exitCode = 1;
}
console.log(APPLY ? `\n  ${applied} of ${plans.length} record(s) written.\n` : "\n  DRY RUN — nothing written.\n");
