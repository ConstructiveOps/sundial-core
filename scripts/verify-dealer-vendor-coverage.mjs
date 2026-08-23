// Check the D4 dealer->vendor map against the LIVE Salesforce picklist and the live
// record population.
//
//   node scripts/verify-dealer-vendor-coverage.mjs
//
// Read-only. Answers two questions the CSV cannot answer about itself:
//
//   1. Which Sales Company picklist values have NO vendor? Every one of those is a deal
//      whose commission PO will fail loudly at creation time. Failing loudly is correct
//      (D4 — never guess a vendor), but it is only useful if someone knows the list in
//      advance rather than discovering it one job at a time.
//   2. How many EXISTING records carry each of those values? That turns "N gaps" into
//      "N deals blocked", which is the number worth acting on.
//
// It also reports CSV keys that are not picklist values at all. Those are harmless —
// a key nothing can match costs nothing — but they are usually one of two things worth
// knowing about: an intentional alias for a spelling that was retired, or a vendor
// matched from the export that never became a picklist option.
import { sfQuery, describeObject } from "../lib/salesforce.js";
import { DEALER_VENDOR_ROWS, lookupDealerVendor } from "../lib/acumatica-dealer-vendors.js";

const SF_OBJECT = "Sundial_Solar__c";
const FIELD = "Sales_Company_Harmon_Solar_or_Third__c";

const described = await describeObject(SF_OBJECT);
const field = described.fields.find((f) => f.name === FIELD);
if (!field) {
  console.error(`${SF_OBJECT}.${FIELD} not found — has the field been renamed?`);
  process.exit(1);
}

const live = field.picklistValues.filter((p) => p.active).map((p) => p.value);
const mapped = new Set(DEALER_VENDOR_ROWS.map((r) => r.salesCompany));

console.log(`\n=== ${SF_OBJECT}.${FIELD} ===`);
console.log(`  active picklist values : ${live.length}`);
console.log(`  CSV rows               : ${mapped.size}`);

const tally = { ok: 0, internal: 0, inactive: 0, unmapped: 0, blank: 0 };
const unmapped = [];
for (const v of live) {
  const r = lookupDealerVendor(v);
  const k = r.ok ? "ok" : r.reason;
  tally[k]++;
  if (!r.ok && (r.reason === "unmapped" || r.reason === "inactive")) unmapped.push([v, r.reason]);
}
console.log(`\n  resolution over the live picklist:`);
console.log(`    resolves to an ACTIVE vendor : ${tally.ok}`);
console.log(`    internal (no PO — correct)   : ${tally.internal}`);
console.log(`    INACTIVE vendor  -> fails    : ${tally.inactive}`);
console.log(`    UNMAPPED         -> fails    : ${tally.unmapped}`);

const extra = [...mapped].filter((v) => !live.includes(v));
if (extra.length) {
  console.log(`\n  CSV keys that are NOT active picklist values (harmless, but check they are intended aliases): ${extra.length}`);
  for (const v of extra) console.log(`    ${JSON.stringify(v)}`);
}

// --- The number that actually matters: how many records are affected ---------
const grouped = await sfQuery(
  `SELECT ${FIELD} c, COUNT(Id) n FROM ${SF_OBJECT} ` +
    `WHERE ${FIELD} != null GROUP BY ${FIELD} ORDER BY COUNT(Id) DESC`
);

const counts = { ok: 0, internal: 0, inactive: 0, unmapped: 0 };
const failing = [];
for (const row of grouped) {
  const r = lookupDealerVendor(row.c);
  const k = r.ok ? "ok" : r.reason;
  counts[k] = (counts[k] ?? 0) + row.n;
  if (!r.ok && r.reason !== "internal") failing.push([row.c, row.n, r.reason]);
}

console.log(`\n=== existing ${SF_OBJECT} records, by PO-vendor resolution ===`);
console.log(`  resolves to an active vendor : ${counts.ok}`);
console.log(`  internal (no PO — correct)   : ${counts.internal}`);
console.log(`  INACTIVE vendor -> would fail: ${counts.inactive}`);
console.log(`  UNMAPPED        -> would fail: ${counts.unmapped}`);

if (failing.length) {
  console.log(`\n  ⚠ ${counts.inactive + counts.unmapped} records would fail commission-PO creation today:`);
  for (const [c, n, why] of failing.sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${why.toUpperCase().padEnd(9)} ${JSON.stringify(c)}`);
  }
  console.log(`\n  Fix: add each to docs/integrations/dealer-vendor-map.csv (Harmon supplies the`);
  console.log(`  VendorID from the Acumatica vendor list), then:`);
  console.log(`    node scripts/generate-dealer-vendors.mjs`);
}

process.exitCode = 0; // report-only: gaps are information, not a build failure
