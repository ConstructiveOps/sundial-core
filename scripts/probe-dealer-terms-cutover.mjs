// Which records' redline changes shape when salesforce/v9-dealer-terms deploys? (D-085)
// Read-only.
//
//   node scripts/probe-dealer-terms-cutover.mjs
//   node scripts/probe-dealer-terms-cutover.mjs --limit 50    # rows listed per group (default 200)
//
// From v9, a deal created on/after 2026-09-04 takes its redline from its DEALER
// (Dealer__r.Redline_PPW__c / Redline_LightReach_PPW__c), and the legacy sales-company
// picklists are never consulted for it. So a post-cutover record with a sales company
// set but NO dealer goes from a number to BLANK the moment the package lands — and a
// blank redline blanks Commission_Total__c, which is what the budget calc reads.
//
// The date is the CUSTOMER's CreatedDate on both objects, matching the formulas: a
// linked Solar record's post-cutover redline is its Customer's, so what blanks it is the
// CUSTOMER's Dealer__c, not the Solar record's own. Both are reported for Solar; the
// first is the one that moves the number.
//
// `CreatedDate >= 2026-09-04T00:00:00Z` is exactly the formula's
// `DATEVALUE(CreatedDate) >= DATE(2026,9,4)` — DATEVALUE of a datetime is its GMT date.
//
// Also counted, the other direction: post-cutover records with a dealer but NO sales
// company. Their redline goes from blank to a number (once the dealer terms are
// backfilled) — a change too, just not a loss.

import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";

const TENANT_ID = "a1W7y000007AszBEAS"; // Sundial_Tenant__c "harmon"
const CUTOFF = "2026-09-04T00:00:00Z";
const LIMIT = process.argv.includes("--limit")
  ? Number(process.argv[process.argv.indexOf("--limit") + 1])
  : 200;

const tenant = `Client__c = '${soqlEscapeString(TENANT_ID)}'`;
const log = (...a) => console.log(...a);
const rule = (c = "=") => log(c.repeat(96));

function listRows(rows, cols) {
  for (const r of rows.slice(0, LIMIT)) {
    log("  " + cols.map(([label, get, w]) => String(get(r) ?? "—").slice(0, w).padEnd(w)).join(" "));
  }
  if (rows.length > LIMIT) log(`  … and ${rows.length - LIMIT} more (--limit to see them)`);
}

rule();
log("DEALER TERMS CUTOVER PROBE — what v9 changes for records created on/after 2026-09-04");
rule();

// --- Customer ---------------------------------------------------------------
const custBlanking = await sfQuery(
  `SELECT Id, Name, CreatedDate, Sales_Rep__c, Sales_Rep__r.Dealer__c, Sales_Company__c, Dealer_Name__c, Financing_Partner__c ` +
    `FROM Sundial_Customer__c WHERE ${tenant} AND CreatedDate >= ${CUTOFF} ` +
    `AND Dealer__c = null AND Sales_Company__c != null ORDER BY CreatedDate`
);
const custGaining = await sfQuery(
  `SELECT COUNT(Id) n FROM Sundial_Customer__c WHERE ${tenant} AND CreatedDate >= ${CUTOFF} ` +
    `AND Dealer__c != null AND Sales_Company__c = null`
);
const custPost = await sfQuery(
  `SELECT COUNT(Id) n FROM Sundial_Customer__c WHERE ${tenant} AND CreatedDate >= ${CUTOFF}`
);

log(`\nSundial_Customer__c — ${custPost[0].n} record(s) created on/after the cutover`);
log(`  redline NUMBER -> BLANK (no Dealer__c, Sales_Company__c set): ${custBlanking.length}`);
log(`  redline BLANK -> NUMBER (Dealer__c set, no Sales_Company__c): ${custGaining[0].n}`);
if (custBlanking.length) {
  log("");
  listRows(custBlanking, [
    ["Id", (r) => r.Id, 18],
    ["Name", (r) => r.Name, 30],
    ["Created", (r) => r.CreatedDate?.slice(0, 10), 10],
    ["Sales_Rep__c", (r) => r.Sales_Rep__c, 18],
    ["Sales_Company__c", (r) => r.Sales_Company__c, 18],
    ["Dealer_Name__c", (r) => r.Dealer_Name__c, 22],
  ]);
  const withRep = custBlanking.filter((r) => r.Sales_Rep__c);
  const repHasDealer = withRep.filter((r) => r.Sales_Rep__r?.Dealer__c);
  log(`\n  of those: ${withRep.length} have a Sales_Rep__c, ${repHasDealer.length} of whose rep HAS a dealer`);
  if (repHasDealer.length) {
    log(`  ** ${repHasDealer.length} break D-064 invariant 5 (rep has a dealer, deal does not) — re-stamp them,`);
    log(`     scripts/backfill-deal-ownership.mjs, before deploying v9. **`);
  }
}

// --- Solar ------------------------------------------------------------------
const solarPostCount = await sfQuery(
  `SELECT COUNT(Id) n FROM Sundial_Solar__c WHERE ${tenant} AND Sundial_Customer__c != null ` +
    `AND Sundial_Customer__r.CreatedDate >= ${CUTOFF}`
);
// The one that moves the number: the CUSTOMER has no dealer.
const solarBlanking = await sfQuery(
  `SELECT Id, Name, Sales_Rep__c, Dealer__c, Sundial_Customer__c, Sundial_Customer__r.CreatedDate, ` +
    `Sundial_Customer__r.Dealer__c, Sales_Company_Harmon_Solar_or_Third__c ` +
    `FROM Sundial_Solar__c WHERE ${tenant} AND Sundial_Customer__c != null ` +
    `AND Sundial_Customer__r.CreatedDate >= ${CUTOFF} AND Sundial_Customer__r.Dealer__c = null ` +
    `AND Sales_Company_Harmon_Solar_or_Third__c != null ORDER BY Sundial_Customer__r.CreatedDate`
);
// The literal reading of "its Dealer__c is null" — the Solar record's own lookup.
const solarOwnNull = await sfQuery(
  `SELECT COUNT(Id) n FROM Sundial_Solar__c WHERE ${tenant} AND Sundial_Customer__c != null ` +
    `AND Sundial_Customer__r.CreatedDate >= ${CUTOFF} AND Dealer__c = null ` +
    `AND Sales_Company_Harmon_Solar_or_Third__c != null`
);
// Post-cutover Solar now follows the Customer's FINANCE field too. Count where the two
// disagree on "is this LightReach", because those redlines change even with a dealer.
const solarFinance = await sfQuery(
  `SELECT Id, Sales_Type_Partner__c, Sundial_Customer__r.Financing_Partner__c FROM Sundial_Solar__c ` +
    `WHERE ${tenant} AND Sundial_Customer__c != null AND Sundial_Customer__r.CreatedDate >= ${CUTOFF}`
);
const isLr = (v) => String(v ?? "").toLowerCase() === "lightreach";
const financeDisagree = solarFinance.filter(
  (r) => isLr(r.Sales_Type_Partner__c) !== isLr(r.Sundial_Customer__r?.Financing_Partner__c)
);

log(`\nSundial_Solar__c — ${solarPostCount[0].n} linked record(s) whose Customer was created on/after the cutover`);
log(`  redline NUMBER -> BLANK (Customer has no Dealer__c, Solar sales company set): ${solarBlanking.length}`);
log(`  (Solar's OWN Dealer__c null with sales company set: ${solarOwnNull[0].n} — informational; the`);
log(`   post-cutover Solar redline is the Customer's, so the Customer's dealer is what counts)`);
log(`  LightReach-ness differs between Solar Sales_Type_Partner__c and Customer Financing_Partner__c: ${financeDisagree.length}`);
if (solarBlanking.length) {
  log("");
  listRows(solarBlanking, [
    ["Id", (r) => r.Id, 18],
    ["Name", (r) => r.Name, 30],
    ["Cust created", (r) => r.Sundial_Customer__r?.CreatedDate?.slice(0, 10), 12],
    ["Sales_Rep__c", (r) => r.Sales_Rep__c, 18],
    ["Sales company", (r) => r.Sales_Company_Harmon_Solar_or_Third__c, 28],
  ]);
}
if (financeDisagree.length) {
  log("\n  finance disagreements (Solar -> Customer):");
  for (const r of financeDisagree.slice(0, LIMIT)) {
    log(`    ${r.Id}  ${r.Sales_Type_Partner__c ?? "—"}  vs  ${r.Sundial_Customer__r?.Financing_Partner__c ?? "—"}`);
  }
}

rule();
log(
  `SUMMARY  Customer number->blank ${custBlanking.length} · Solar number->blank ${solarBlanking.length} · ` +
    `Customer blank->number ${custGaining[0].n} · Solar finance mismatch ${financeDisagree.length}`
);
rule();
