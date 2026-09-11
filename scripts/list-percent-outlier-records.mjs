// LIST PERCENT-DOMAIN OUTLIER RECORDS — Customer + Solar, with record Ids.
//
// Companion to audit-percent-field-defaults.mjs, which reports FIELD-level state but
// not which records carry bad values. This one names the records, so a human can fix
// them in the UI.
//
// Two outlier shapes, both from the percent-domain saga (D-063 / D-063a):
//   value >= SUSPECT_HIGH        -> the default-domain bug (e.g. 7500 = "75" default)
//   0 < value < 1                -> the mirror-image error (decimal typed into the
//                                   display domain: 0.75 where 75 was meant)
//
// Fields swept: every Percent-type field on the object (from a live describe), plus
// the two burden fields by name in case their describe type is not 'percent'.
// Proposed_Offset__c is exempt from the HIGH check only (legit over-production values,
// see the audit script) but still checked for < 1.
//
//   node scripts/list-percent-outlier-records.mjs
//
// READ-ONLY. Prints Id, Name, field, value, and which shape it matched.

import { describeObject, sfQuery } from "../lib/salesforce.js";

const OBJECTS = ["Sundial_Customer__c", "Sundial_Solar__c"];
const EXTRA_FIELDS = ["Labor_Burden_Rate__c", "Commission_Burden_Rate__c"];
const HIGH_EXEMPT = new Set(["Proposed_Offset__c"]);
const SUSPECT_HIGH = 100; // >= this is presumed domain-bugged (matches the audit heuristic)

let totalHits = 0;

for (const obj of OBJECTS) {
  let meta;
  try {
    meta = await describeObject(obj, { forceRefresh: true });
  } catch (e) {
    console.log(`\n${obj}: describe failed (${e?.message || e}) — skipped`);
    continue;
  }
  const fields = meta.fields
    .filter((f) => f.type === "percent" || EXTRA_FIELDS.includes(f.name))
    .map((f) => f.name);
  if (fields.length === 0) {
    console.log(`\n${obj}: no percent fields — skipped`);
    continue;
  }

  // One WHERE clause across all fields; each field contributes its two conditions.
  const conds = fields.map((f) => {
    const high = HIGH_EXEMPT.has(f) ? null : `${f} >= ${SUSPECT_HIGH}`;
    const low = `(${f} > 0 AND ${f} < 1)`;
    return high ? `${high} OR ${low}` : low;
  });
  const soql =
    `SELECT Id, Name, ${fields.join(", ")} FROM ${obj} ` +
    `WHERE ${conds.map((c) => `(${c})`).join(" OR ")}`;

  const rows = await sfQuery(soql);
  const recs = rows?.records ?? rows ?? [];
  console.log(`\n===== ${obj}: ${recs.length} record(s) with outliers =====`);
  for (const r of recs) {
    for (const f of fields) {
      const v = r[f];
      if (v == null) continue;
      const isHigh = !HIGH_EXEMPT.has(f) && v >= SUSPECT_HIGH;
      const isLow = v > 0 && v < 1;
      if (!isHigh && !isLow) continue;
      totalHits++;
      const shape = isHigh ? "HIGH (default-domain bug?)" : "LOW  (decimal-in-display?)";
      console.log(
        `${r.Id}  ${String(r.Name ?? "").padEnd(28)} ${f.padEnd(34)} = ${v}   ${shape}`
      );
    }
  }
}

console.log(`\nTotal outlier values: ${totalHits}`);
process.exit(totalHits > 0 ? 1 : 0);
