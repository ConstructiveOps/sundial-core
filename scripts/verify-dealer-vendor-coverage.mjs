// Check every ACTIVE dealer's commission-PO vendor — in Salesforce and in Acumatica.
//
//   node scripts/verify-dealer-vendor-coverage.mjs [tenantSlug]     (default: harmon)
//
// Read-only. Since D-085 amendment 1 a commission PO is paid to the DEALER's
// Acumatica_Vendor_ID__c (lib/dealer-terms.js); the sales-company picklist + CSV map only
// serve deals created before 2026-09-04 with no dealer. So the questions are now about
// dealers, not picklist values:
//
//   1. Which active (external) dealers have NO vendor ID? Their POs refuse vendor_missing.
//   2. Which vendor IDs are NOT IN ACUMATICA, or are Inactive there? Their POs refuse
//      vendor_not_in_acumatica — the same GET the PO engine makes before every create
//      (lib/acumatica-vendor-check.js), so this report and the engine cannot disagree.
//   3. How many Solar records does each gap block? "N gaps" becomes "N deals".
//
// Internal dealers (Is_Internal__c) need no vendor — their commission is payroll (D16) —
// and are listed only so a vendor ID set on one by mistake is visible.
import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";
import { checkAcumaticaVendor } from "../lib/acumatica-vendor-check.js";

const slug = process.argv[2] || "harmon";
const tenant = (await sfQuery(`SELECT Id FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(slug)}' LIMIT 1`))?.[0];
if (!tenant) {
  console.error(`No Sundial_Tenant__c named "${slug}".`);
  process.exit(1);
}
const T = soqlEscapeString(tenant.Id);

const dealers = await sfQuery(
  `SELECT Id, Name, Is_Internal__c, Acumatica_Vendor_ID__c, Acumatica_Vendor_Name__c FROM Sundial_Dealer__c ` +
    `WHERE Client__c = '${T}' AND Active__c = true ORDER BY Name`
);

// Solar records per dealer — what a gap actually blocks.
const counts = new Map();
for (const r of await sfQuery(
  `SELECT Dealer__c d, COUNT(Id) n FROM Sundial_Solar__c WHERE Client__c = '${T}' AND Dealer__c != null GROUP BY Dealer__c`
)) counts.set(r.d, r.n);

console.log(`\n=== Active dealers in "${slug}": ${dealers.length} ===\n`);
const missing = [];
const notInAcumatica = [];
const ok = [];
for (const d of dealers) {
  const n = counts.get(d.Id) ?? 0;
  const vendorId = String(d.Acumatica_Vendor_ID__c ?? "").trim();
  if (d.Is_Internal__c) {
    console.log(`  INTERNAL  ${d.Name}${vendorId ? `  ⚠ has vendor ${vendorId} set — internal deals raise no PO, so it is unused` : ""}`);
    continue;
  }
  if (!vendorId) { missing.push([d, n]); continue; }
  const v = await checkAcumaticaVendor(vendorId);
  if (v.ok) ok.push([d, n, v]);
  else notInAcumatica.push([d, n, v]);
}

for (const [d, n, v] of ok) {
  const nameNote = d.Acumatica_Vendor_Name__c && d.Acumatica_Vendor_Name__c !== v.vendorName
    ? `  (Sundial says "${d.Acumatica_Vendor_Name__c}")` : "";
  console.log(`  ok        ${d.Name.padEnd(30)} ${v.vendorId}  ${v.vendorName} [${v.status}]${nameNote}  — ${n} Solar`);
}

if (missing.length) {
  console.log(`\n  ⚠ ${missing.length} active dealer(s) with NO Acumatica_Vendor_ID__c — POs refuse vendor_missing:`);
  for (const [d, n] of missing) console.log(`    ${d.Name.padEnd(30)} ${String(n).padStart(4)} Solar   ${d.Id}`);
}
if (notInAcumatica.length) {
  console.log(`\n  ⚠ ${notInAcumatica.length} vendor ID(s) not usable in Acumatica — POs refuse ${notInAcumatica[0][2].reason}:`);
  for (const [d, n, v] of notInAcumatica) console.log(`    ${d.Name.padEnd(30)} ${v.vendorId.padEnd(7)} ${String(n).padStart(4)} Solar   ${v.message}`);
}
if (!missing.length && !notInAcumatica.length) console.log("\n  Every active external dealer has a vendor that exists and is active in Acumatica.");

console.log(`\nFix: Harmon finance creates / reactivates the vendor; Constructive Ops sets the`);
console.log(`dealer's Acumatica_Vendor_ID__c. Then re-push the blocked jobs —`);
console.log(`node scripts/list-failed-commission-pos.mjs lists the ones already refused.`);

process.exitCode = 0; // report-only: gaps are information, not a build failure
