// CLASS-WIDE AUDIT: every Percent field with a default, on every Sundial object.
//
// The point is to make this bug EXTINCT rather than chase it a field at a time. Two
// instances have now been found by accident — the NS markups (D-063) and the burden rates
// — and both were found because a number looked odd on a screen, not because anything
// checked.
//
// THE RULE, measured empirically by scripts/probe-percent-field-domain.mjs:
//
//   A Percent field's <defaultValue> is a formula expression evaluated in the DECIMAL
//   domain. It stores `default x 100` as the API/display value.
//
//     default 0.75  ->  stored 75    ->  displays 75%     ✅ a true 75%
//     default 75    ->  stored 7500  ->  displays 7500%   ❌ the bug
//
// So a Percent default of 1 or more is almost certainly wrong: it would mean a rate of
// 100% or higher, and essentially nothing we model is. That is the heuristic, and it is
// stated as a heuristic rather than a proof — the audit also reads the DATA, which settles
// it. If the stored values on real records are ~100x what a human would call the rate,
// the default is wrong regardless of what anyone intended.
//
// This checks metadata AND data, because either alone can mislead:
//   - a wrong default on a field no record has yet exercised is still a live landmine
//   - a right default cannot rescue records created before it was fixed
//
//   node scripts/audit-percent-field-defaults.mjs
//
// READ-ONLY. Exits non-zero if any suspect default or suspect stored value is found, so
// it can be wired into a pre-deploy check.

import { describeObject, sfQuery } from "../lib/salesforce.js";

// Every Sundial object we deploy fields to. Objects that do not exist are reported and
// skipped rather than throwing, so this keeps working as the schema grows.
const OBJECTS = [
  "Sundial_Customer__c",
  "Sundial_Solar__c",
  "Sundial_Roofing__c",
  "Sundial_Commercial__c",
  "Sundial_PO__c",
  "Sundial_PO_Credit__c",
  "Sundial_Service__c",
  "Sundial_Service_Visit__c",
  "Sundial_User__c",
  "Sundial_Tenant__c",
];

/** A stored Percent value above this is very unlikely to be a real rate. */
const SUSPECT_STORED = 100;

/**
 * Percent fields where a value above 100% is LEGITIMATE, so the heuristic must not cry
 * wolf. Each entry needs a reason, because an exemption is how a real bug gets hidden.
 *
 *   Proposed_Offset__c — the share of a customer's usage the system is designed to
 *   produce. Over-production is normal and intentional; 1,563 records sit between 101%
 *   and 405%, with fractional values (104.76, 113.03, 151.92) that only make sense as
 *   real measurements rather than a domain error. A 100x-inflated 1% would read as 100,
 *   not 104.76.
 */
const STORED_EXEMPT = new Set(["Proposed_Offset__c"]);
/** A Percent default at or above this stores >= 100% and is very unlikely to be intended. */
const SUSPECT_DEFAULT = 1;

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

const rows = [];
const missing = [];

for (const objName of OBJECTS) {
  let d;
  try {
    d = await describeObject(objName);
  } catch {
    missing.push(objName);
    continue;
  }

  const percents = d.fields.filter((f) => f.type === "percent" && !f.calculated);
  const withDefault = percents.filter((f) => {
    const dv = f.defaultValueFormula ?? f.defaultValue;
    return dv !== null && dv !== undefined && dv !== "";
  });

  // Read the DATA for every percent field on the object, defaulted or not — a field with
  // no default can still hold bad values written by a human or an integration.
  const names = percents.map((f) => f.name);
  const dataByField = new Map();
  if (names.length) {
    // Chunked: a wide object can exceed SOQL's statement length.
    const chunk = (a, n) => a.reduce((acc, _, i) => (i % n ? acc : [...acc, a.slice(i, i + n)]), []);
    const tally = new Map(names.map((n) => [n, new Map()]));
    for (const part of chunk(names, 100)) {
      const recs = await sfQuery(`SELECT ${part.join(", ")} FROM ${objName}`);
      for (const r of recs) {
        for (const n of part) {
          const v = num(r[n]);
          const k = v === null ? "null" : String(v);
          const t = tally.get(n);
          t.set(k, (t.get(k) ?? 0) + 1);
        }
      }
    }
    for (const [n, t] of tally) dataByField.set(n, t);
  }

  for (const f of percents) {
    const dv = f.defaultValueFormula ?? f.defaultValue ?? null;
    const hasDefault = dv !== null && dv !== undefined && dv !== "";
    const dvNum = hasDefault ? Number(dv) : null;
    const stores = dvNum === null || Number.isNaN(dvNum) ? null : dvNum * 100;

    const tally = dataByField.get(f.name) ?? new Map();
    const over = [...tally.entries()].filter(([k]) => k !== "null" && Number(k) > SUSPECT_STORED);
    const exempt = STORED_EXEMPT.has(f.name);
    const suspectValues = exempt ? [] : over;
    const suspectCount = suspectValues.reduce((a, [, c]) => a + c, 0);
    const exemptOver = exempt ? over.reduce((a, [, c]) => a + c, 0) : 0;

    const defaultSuspect = hasDefault && !Number.isNaN(dvNum) && Math.abs(dvNum) >= SUSPECT_DEFAULT;

    rows.push({
      object: objName.replace("Sundial_", "").replace("__c", ""),
      field: f.name,
      type: `Percent(${f.precision},${f.scale})`,
      dv: hasDefault ? String(dv) : null,
      stores,
      defaultSuspect,
      suspectCount,
      suspectValues: suspectValues.map(([k, c]) => `${k}x${c}`).join(" "),
      populated: [...tally.entries()].filter(([k]) => k !== "null").reduce((a, [, c]) => a + c, 0),
      exempt,
      exemptOver,
    });
  }

  console.log(
    `  ${objName.padEnd(28)} ${String(percents.length).padStart(3)} percent field(s), ${withDefault.length} with a default`
  );
}

if (missing.length) console.log(`\n  (not present in this org, skipped: ${missing.join(", ")})`);

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(104));
console.log("EVERY Percent FIELD WITH A DEFAULT — is the literal decimal-correct?");
console.log("=".repeat(104));
console.log("  object    field                              type            default   stores   verdict");
console.log("  " + "-".repeat(100));

const withDefaults = rows.filter((r) => r.dv !== null).sort((a, b) => a.object.localeCompare(b.object) || a.field.localeCompare(b.field));
let badDefaults = 0;
for (const r of withDefaults) {
  const verdict = r.defaultSuspect
    ? `** WRONG — stores ${r.stores}% **`
    : `ok (a true ${r.stores}%)`;
  if (r.defaultSuspect) badDefaults++;
  console.log(
    `  ${r.object.padEnd(9)} ${r.field.padEnd(34)} ${r.type.padEnd(15)} ${String(r.dv).padStart(7)}  ${String(r.stores).padStart(7)}   ${verdict}`
  );
}
if (withDefaults.length === 0) console.log("  (none)");

// ---------------------------------------------------------------------------
// Data-side check — a right default cannot rescue records made before it
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(104));
console.log(`STORED VALUES ABOVE ${SUSPECT_STORED}% — regardless of what the default says`);
console.log("=".repeat(104));
const badData = rows.filter((r) => r.suspectCount > 0).sort((a, b) => b.suspectCount - a.suspectCount);
if (badData.length === 0) {
  console.log("  none — no record on any Sundial object holds a Percent value above the ceiling.");
} else {
  console.log("  object    field                              records   values");
  console.log("  " + "-".repeat(100));
  for (const r of badData) {
    console.log(`  ${r.object.padEnd(9)} ${r.field.padEnd(34)} ${String(r.suspectCount).padStart(7)}   ${r.suspectValues}`);
  }
}

// ---------------------------------------------------------------------------
// Percent fields with NO default — listed so the absence is a known fact
// ---------------------------------------------------------------------------
const exempted = rows.filter((r) => r.exempt && r.exemptOver > 0);
if (exempted.length) {
  console.log("\n  EXEMPT (above 100% is legitimate here — see STORED_EXEMPT for the reasoning):");
  for (const r of exempted) {
    console.log(`     ${r.object}.${r.field} — ${r.exemptOver} record(s) above ${SUSPECT_STORED}%, not a defect`);
  }
}

const noDefault = rows.filter((r) => r.dv === null);
console.log("\n" + "-".repeat(104));
console.log(`Percent fields with NO default (${noDefault.length}) — cannot carry this bug from metadata:`);
console.log("  " + noDefault.map((r) => `${r.object}.${r.field}`).join(", ") || "  (none)");

console.log("\n" + "=".repeat(104));
console.log("VERDICT");
console.log("=".repeat(104));
console.log(`  ${withDefaults.length} Percent field(s) carry a default; ${badDefaults} are decimal-INCORRECT.`);
console.log(`  ${badData.reduce((a, r) => a + r.suspectCount, 0)} stored value(s) above ${SUSPECT_STORED}% across ${badData.length} field(s).`);
console.log(
  badDefaults === 0 && badData.length === 0
    ? "\n  ✅ CLASS EXTINCT — every Percent default is decimal-correct and no stored value is out of range.\n"
    : "\n  ** Work remains — see the tables above. **\n"
);
process.exitCode = badDefaults === 0 && badData.length === 0 ? 0 : 1;
