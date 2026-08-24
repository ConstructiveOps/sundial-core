// Storage adder price BACKFILL + the per-watt price sweep.
//
// Two jobs, one script, because they read the same records and both exist for the same
// reason: a commission number that is wrong because of DATA, not because of a formula.
//
// ---------------------------------------------------------------------------
// JOB 1 — BACKFILL (Task 3)
// ---------------------------------------------------------------------------
// The two storage price fields carry static defaults (9,950 / 7,900), and a Salesforce
// field default ONLY applies to records created after the field existed. Every existing
// battery/expansion record therefore has a NULL price, and a null price contributes 0 to
// Total_Adder_Price__c — so the formula change alone fixes nothing for history. This is
// what covers it.
//
//   Battery_Unit_Price__c            = 9950  where Battery_Qty__c > 0
//   Tesla_Expansion_Pack_Unit_Price__c = 7900 where the OBJECT-APPROPRIATE qty > 0
//
// ONLY where the price is currently NULL. A human-entered price is never overwritten —
// that is the difference between a backfill and a data loss, and the WHERE clause is the
// only thing enforcing it.
//
// ⚠️ THE OBJECT-APPROPRIATE QTY DIFFERS, deliberately:
//   Customer -> Tesla_Expansion_Pack_Qty__c
//   Solar    -> Gateway_Qty__c   (Gateway_* IS the expansion pack, §3 reuse; Solar's
//                                 Tesla_Expansion_Pack_Quantity__c is unmaintained)
// Same pairing as the Total_Adder_Price__c formula and budgetCalc. All three agree or
// none of them do.
//
// ---------------------------------------------------------------------------
// JOB 2 — PER-WATT PRICE SWEEP (Task 4)
// ---------------------------------------------------------------------------
// Lists every existing record with a per-watt adder price above $10/W — the same
// condition budgetCalc now throws PPW_PRICE_IMPLAUSIBLE on. These multiply by WATTS, so
// a flat dollar total in one of them is the $2.5M class of error.
//
// ---------------------------------------------------------------------------
// RUNNING IT
// ---------------------------------------------------------------------------
//   node scripts/backfill-storage-adder-prices.mjs            # READ-ONLY. Default.
//   node scripts/backfill-storage-adder-prices.mjs --apply    # writes
//
// Dry run is the default on purpose: this shifts commissions across the whole book.
//
// TENANT SAFETY: the backfill refuses to --apply if the candidates span more than one
// Client__c tenant, because 9,950 / 7,900 are HARMON's prices. --allow-multi-tenant
// overrides that, deliberately awkwardly.
//
// ORDERING NOTE (read before interpreting the output): if the amended
// Total_Adder_Price__c formula is NOT yet deployed, the observed "after" Commission_Total
// will equal the "before" — the formula does not reference these price fields yet. The
// PREDICTED column is what each commission becomes the moment the package deploys. That
// is the intended order: backfill first, then deploy, so the shift lands at once rather
// than record by record.

import { sfQuery, sfUpdateRecord } from "../lib/salesforce.js";

const APPLY = process.argv.includes("--apply");
const ALLOW_MULTI_TENANT = process.argv.includes("--allow-multi-tenant");

const BATTERY_PRICE = 9950;
const EXPANSION_PRICE = 7900;
const PPW_CEILING = 10;

const PPW_PRICE_FIELDS = [
  "Adder_Conduit_Attic_Price__c",
  "Adder_Flat_Roof_Price__c",
  "Adder_Roof_Tile_Price__c",
  "Adder_Bird_Blocking_Price__c",
];

/**
 * Per-object shape. `pushState` is the "already went to Acumatica" evidence, and it is
 * genuinely different per object rather than merely named differently:
 *
 *   Solar    — carries the real thing. Commission_PO_M1/M2_Number__c mean a commission
 *              PO was actually raised, with the pushed AMOUNT alongside it, and
 *              Budget_Push_Status__c/Budget_Pushed_At__c mean the budget (which carries
 *              the SLPC / SLPC OUT commission lines) went across.
 *   Customer — carries NONE of that. Synced_to_Acumatica__c means the customer record
 *              synced; Acumatica_Project_ID__c means a project exists over there. Neither
 *              says a commission was pushed. So for Customer candidates the evidence is
 *              looked up on the LINKED Sundial_Solar__c records instead (attachRelatedPush
 *              below) - which is the only place a commission push is actually recorded.
 */
const OBJECTS = {
  Sundial_Customer__c: {
    label: "Customer",
    expansionQty: "Tesla_Expansion_Pack_Qty__c",
    nameField: "Name",
    pushState: ["Synced_to_Acumatica__c", "Acumatica_Project_ID__c"],
    // A Customer's own Acumatica_Project_ID__c only says a PROJECT exists over there. It
    // says nothing about whether a COMMISSION was pushed, and treating it as if it did
    // produces a list of false positives long enough to be useless. The real evidence is
    // on the linked Solar record, so it is fetched separately and attached as
    // `_relatedPush` before this runs.
    isPushed: (r) => Boolean(r._relatedPush),
    pushDetail: (r) => r._relatedPush ?? "-",
  },
  Sundial_Solar__c: {
    label: "Solar",
    expansionQty: "Gateway_Qty__c",
    nameField: "Name",
    pushState: [
      "Acumatica_Project_ID__c",
      "Budget_Push_Status__c",
      "Budget_Pushed_At__c",
      "Commission_PO_Status__c",
      "Commission_PO_M1_Number__c",
      "Commission_PO_M1_Amount__c",
      "Commission_PO_M2_Number__c",
      "Commission_PO_M2_Amount__c",
    ],
    isPushed: (r) =>
      Boolean(String(r.Commission_PO_M1_Number__c ?? "").trim()) ||
      Boolean(String(r.Commission_PO_M2_Number__c ?? "").trim()) ||
      Boolean(r.Budget_Pushed_At__c),
    pushDetail: (r) => {
      const m1 = String(r.Commission_PO_M1_Number__c ?? "").trim();
      const m2 = String(r.Commission_PO_M2_Number__c ?? "").trim();
      const bits = [];
      if (m1) bits.push(`M1 PO ${m1} @ ${fmt(r.Commission_PO_M1_Amount__c)}`);
      if (m2) bits.push(`M2 PO ${m2} @ ${fmt(r.Commission_PO_M2_Amount__c)}`);
      if (r.Budget_Pushed_At__c)
        bits.push(`budget pushed ${String(r.Budget_Pushed_At__c).slice(0, 10)} (${r.Budget_Push_Status__c ?? "?"})`);
      return bits.join("; ") || "-";
    },
  },
};

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const fmt = (v) => (num(v) === null ? "(blank)" : num(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/** Common select list, per object. */
function selectFields(objName) {
  const o = OBJECTS[objName];
  return [
    "Id", o.nameField, "Client__r.Name",
    "Battery_Qty__c", "Battery_Unit_Price__c",
    o.expansionQty, "Tesla_Expansion_Pack_Unit_Price__c",
    "Total_Adder_Price__c", "Commission_Total__c", "Commission_Total_PPW__c",
    ...o.pushState,
  ];
}

/** Records needing one or both prices set. NULL-only, never an overwrite. */
async function findBackfillCandidates(objName) {
  const o = OBJECTS[objName];
  const soql =
    `SELECT ${selectFields(objName).join(", ")} FROM ${objName} WHERE ` +
    `(Battery_Qty__c > 0 AND Battery_Unit_Price__c = NULL) OR ` +
    `(${o.expansionQty} > 0 AND Tesla_Expansion_Pack_Unit_Price__c = NULL)`;
  return (await sfQuery(soql)) ?? [];
}

/**
 * Attach each Customer candidate's REAL push evidence, which lives on its Solar children.
 *
 * One query for the whole set rather than one per record. A Customer with no Solar child,
 * or whose children were never pushed, comes back with nothing attached and is correctly
 * absent from the reconciliation list.
 */
async function attachRelatedPush(customerRows) {
  if (customerRows.length === 0) return;
  const ids = customerRows.map((r) => `'${r.Id}'`).join(",");
  const solar = OBJECTS.Sundial_Solar__c;
  const rows =
    (await sfQuery(
      `SELECT Id, Name, Sundial_Customer__c, ${solar.pushState.join(", ")} ` +
        `FROM Sundial_Solar__c WHERE Sundial_Customer__c IN (${ids})`
    )) ?? [];

  const byCustomer = new Map();
  for (const sr of rows) {
    if (!solar.isPushed(sr)) continue;
    const list = byCustomer.get(sr.Sundial_Customer__c) ?? [];
    list.push(`${sr.Name}: ${solar.pushDetail(sr)}`);
    byCustomer.set(sr.Sundial_Customer__c, list);
  }
  for (const r of customerRows) {
    const hits = byCustomer.get(r.Id);
    if (hits) r._relatedPush = hits.join(" | ");
  }
}

/** What this record's commission becomes once the amended formula is live. */
function planRecord(objName, r) {
  const o = OBJECTS[objName];
  const batteryQty = num(r.Battery_Qty__c) ?? 0;
  const expansionQty = num(r[o.expansionQty]) ?? 0;
  const batteryPriceNull = num(r.Battery_Unit_Price__c) === null;
  const expansionPriceNull = num(r.Tesla_Expansion_Pack_Unit_Price__c) === null;

  const updates = {};
  let delta = 0;
  if (batteryQty > 0 && batteryPriceNull) {
    updates.Battery_Unit_Price__c = BATTERY_PRICE;
    delta += BATTERY_PRICE * batteryQty;
  }
  if (expansionQty > 0 && expansionPriceNull) {
    updates.Tesla_Expansion_Pack_Unit_Price__c = EXPANSION_PRICE;
    delta += EXPANSION_PRICE * expansionQty;
  }

  // A record whose price fields are ALREADY populated (human-entered) contributes its
  // own delta once the formula deploys, but this script must not touch it.
  const before = num(r.Commission_Total__c);
  // Blank commission stays blank — the formula refuses on a blank sales company or zero
  // watts, and subtracting from "no answer" is not an answer either.
  const predicted = before === null ? null : before - delta;

  return { updates, delta, before, predicted, batteryQty, expansionQty };
}

async function runBackfill() {
  console.log("\n" + "=".repeat(78));
  console.log("BACKFILL — storage adder prices");
  console.log("=".repeat(78));

  const plans = [];
  for (const objName of Object.keys(OBJECTS)) {
    const rows = await findBackfillCandidates(objName);
    // Customer push evidence lives on the Solar children, not the Customer.
    if (objName === "Sundial_Customer__c") await attachRelatedPush(rows);
    console.log(`\n${objName}: ${rows.length} candidate record(s)`);
    for (const r of rows) {
      const p = planRecord(objName, r);
      if (Object.keys(p.updates).length === 0) continue; // belt-and-braces
      plans.push({ objName, r, ...p });
    }
  }

  if (plans.length === 0) {
    console.log("\nNothing to backfill — no record has a storage qty with a null price.");
    return plans;
  }

  // ---- Tenant safety --------------------------------------------------------
  const tenants = [...new Set(plans.map((p) => p.r.Client__r?.Name ?? "(no Client__c)"))];
  console.log(`\nTenants represented: ${tenants.join(", ")}`);
  const multiTenant = tenants.length > 1;
  if (multiTenant && APPLY && !ALLOW_MULTI_TENANT) {
    console.log(
      "\n** REFUSING TO APPLY ** — candidates span more than one tenant, and 9,950 / 7,900 " +
        "are HARMON's prices. Re-run with --allow-multi-tenant only if that is genuinely intended."
    );
    process.exitCode = 1;
    return plans;
  }

  // ---- The audit table ------------------------------------------------------
  console.log(
    `\n${APPLY ? "APPLYING" : "DRY RUN (no writes — pass --apply)"} — ${plans.length} record(s)\n`
  );
  console.log(
    "  obj      Id                  batt exp   sets                    Commission_Total"
  );
  console.log(
    "                                                                  before -> predicted (delta)"
  );
  console.log("  " + "-".repeat(100));

  let applied = 0;
  const failures = [];
  for (const p of plans) {
    const sets = Object.keys(p.updates)
      .map((k) => (k === "Battery_Unit_Price__c" ? `batt=${BATTERY_PRICE}` : `exp=${EXPANSION_PRICE}`))
      .join(" ");

    let status = "dry-run";
    if (APPLY) {
      try {
        await sfUpdateRecord(p.objName, p.r.Id, p.updates);
        applied++;
        status = "written";
      } catch (e) {
        status = "FAILED";
        failures.push({ id: p.r.Id, obj: p.objName, error: e.sfBody ?? e.message });
      }
    }

    console.log(
      `  ${OBJECTS[p.objName].label.padEnd(8)} ${p.r.Id.padEnd(19)} ` +
        `${String(p.batteryQty).padStart(4)} ${String(p.expansionQty).padStart(3)}   ` +
        `${sets.padEnd(23)} ${fmt(p.before).padStart(12)} -> ${fmt(p.predicted).padStart(12)} ` +
        `(${p.delta > 0 ? "-" : ""}${fmt(p.delta)})  ${status}`
    );
  }

  if (failures.length) {
    console.log(`\n** ${failures.length} WRITE FAILURE(S) **`);
    for (const f of failures) console.log(`   ${f.obj} ${f.id}: ${f.error}`);
    process.exitCode = 1;
  }
  if (APPLY) console.log(`\n${applied} of ${plans.length} record(s) written.`);

  // ---- Acumatica reconciliation list ----------------------------------------
  // Separate section, deliberately: these are the ones where a number that already left
  // for Acumatica is about to stop matching Salesforce.
  console.log("\n" + "-".repeat(78));
  console.log("ALREADY PUSHED TO ACUMATICA — reconcile these with Harmon finance");
  console.log("-".repeat(78));
  const pushed = plans.filter((p) => OBJECTS[p.objName].isPushed(p.r));
  if (pushed.length === 0) {
    console.log("  none — no touched record shows evidence of an Acumatica push.");
  } else {
    for (const p of pushed) {
      const o = OBJECTS[p.objName];
      console.log(
        `\n  ${o.label} ${p.r.Id}  ${String(p.r[o.nameField] ?? "").slice(0, 40)}` +
          `${p.objName === "Sundial_Customer__c" ? "   [evidence is on the linked Solar record]" : ""}`
      );
      console.log(`     pushed:    ${o.pushDetail(p.r)}`);
      console.log(`     commission: ${fmt(p.before)} -> ${fmt(p.predicted)}  (falls by ${fmt(p.delta)})`);
    }
  }

  return plans;
}

async function runPpwSweep() {
  console.log("\n" + "=".repeat(78));
  console.log(`PER-WATT PRICE SWEEP — any of 4 adder prices above $${PPW_CEILING}/W`);
  console.log("=".repeat(78));

  let total = 0;
  for (const objName of Object.keys(OBJECTS)) {
    const o = OBJECTS[objName];
    const where = PPW_PRICE_FIELDS.map((f) => `${f} > ${PPW_CEILING}`).join(" OR ");
    const soql =
      `SELECT Id, ${o.nameField}, Client__r.Name, Commission_Total__c, ` +
      `${PPW_PRICE_FIELDS.join(", ")} FROM ${objName} WHERE ${where}`;
    const rows = (await sfQuery(soql)) ?? [];
    console.log(`\n${objName}: ${rows.length} record(s) over the ceiling`);
    total += rows.length;
    for (const r of rows) {
      const bad = PPW_PRICE_FIELDS.filter((f) => (num(r[f]) ?? 0) > PPW_CEILING)
        .map((f) => `${f}=${fmt(r[f])}`)
        .join(", ");
      console.log(
        `   ${r.Id}  ${String(r[o.nameField] ?? "").slice(0, 32).padEnd(32)} ` +
          `commission=${fmt(r.Commission_Total__c).padStart(14)}   ${bad}`
      );
    }
  }

  console.log(
    total === 0
      ? "\nCLEAN — nothing over the ceiling. Every recalc will pass the new PPW_PRICE_IMPLAUSIBLE guard."
      : `\n${total} record(s) will now be REFUSED by budgetCalc with PPW_PRICE_IMPLAUSIBLE until the value is fixed.`
  );
  return total;
}

// The sweep runs FIRST and always: it is read-only, and knowing whether the book is
// clean is context for reading the backfill numbers.
await runPpwSweep();
await runBackfill();

if (!APPLY) {
  console.log("\nDRY RUN — nothing was written. Re-run with --apply to perform the backfill.\n");
}
