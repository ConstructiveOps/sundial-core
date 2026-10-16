// Restore the pre-D-083 tax on Service lines and price-book items (2026-10-16).
//
// D-083 made a blank Tax_Category__c on a Material / Product line mean RETAIL (taxed), so every
// material Harmon had left untaxed (Taxable__c off) started being taxed. Taxable__c still holds
// the old choice (no recalc rewrites it), so this script makes that choice explicit.
//
// FIRST PASS (default):
//   Material / Product, blank category, Taxable__c off (or blank) → Tax_Category__c = SOLAR
//   Material / Product, blank category, Taxable__c on              → left blank (RETAIL)
//   Labor / Fee                                                    → left (LABSERV, already untaxed)
//   any explicit category                                          → left
// Every estimate status (Draft … Invoiced), and every price-book item version, active or not, so
// re-adding an item never re-taxes.
//
// SECOND PASS (--taxed-lines): before D-083 a TICKED material was taxed only when the estimate
// also had a typed rate. For every NON-invoiced estimate (Draft / Sent / Viewed / Approved /
// Declined / Expired), a ticked blank Material / Product line:
//   the estimate's stored Tax_Amount__c is 0 / blank → SOLAR (the tick never charged anything)
//   stored Tax_Amount__c > 0                         → left (RETAIL) and LISTED with the stored tax,
//                                                      the old typed rate, the tax recomputed now
//                                                      and the zone, for the office to decide
// Lines only.
//
// The decision tables are lib/line-tax-backfill.js (tested). Never touched in either pass: ZZ test
// records (customer / item name starting "ZZ"), lines on an ARCHIVED job, other tenants. Only
// Tax_Category__c is written.
//
//   node scripts/backfill-line-tax-categories.mjs                          # first pass, DRY RUN
//   node scripts/backfill-line-tax-categories.mjs --apply                  # first pass, write
//   node scripts/backfill-line-tax-categories.mjs --taxed-lines            # second pass, DRY RUN + the list
//   node scripts/backfill-line-tax-categories.mjs --taxed-lines --apply    # second pass, write
//   ... --tenant harmon                                                    # default: the primary tenant
//
// CANARY FIRST (CLAUDE.md, bulk data fixes): one line is written and re-read with its estimate,
// and the run aborts if anything it did not write has moved; the same for one item. Then batches
// of 200. Idempotent: a re-run only sees what is still blank.
//
// After --apply: sundial-cache-sync full runs for "serviceline" (both passes) and "pricebookitem"
// (first pass).
//
// ⚠️ Do not pipe the output through head / tail on an --apply run: a failure must be seen
// (each is printed and the script exits 1).

import { sfQuery, sfUpdateRecord, sfUpdateMany, soqlEscapeString } from "../lib/salesforce.js";
import { planLineBackfill, planItemBackfill, planTaxedLineBackfill, TAXED_PASS_STATUSES, MATERIAL_KINDS, chunk } from "../lib/line-tax-backfill.js";
import { primaryTenantSlug } from "../lib/tenant-guard.js";
import { estimateTaxContext, loadTaxTables } from "../lib/tax-zones.js";
import { getSupabaseClient } from "../lib/supabase.js";
import { computeTotals, lineFromRecord, estimateFromRecord } from "../lambdas/sundial-service-estimate/totals.js";
import { ESTIMATE_SELECT } from "../lambdas/sundial-service-estimate/fields.js";
import { LINE_SELECT } from "../lambdas/sundial-service-estimate/pricebook.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const TAXED = args.includes("--taxed-lines");
const tenantArg = args.includes("--tenant") ? args[args.indexOf("--tenant") + 1] : null;
const slug = tenantArg || primaryTenantSlug();
const LINE = "Sundial_Service_Line__c";
const ITEM = "Sundial_Price_Book_Item__c";
const LINE_WATCHED = ["Kind__c", "Taxable__c", "Quantity__c", "Unit_Price__c", "Line_Total__c", "Stage__c", "Description__c", "Price_Book_Item__c", "Estimate__c"];
const EST_WATCHED = ["Status__c", "Subtotal__c", "Tax_Amount__c", "Total__c"];
const ITEM_WATCHED = ["Name", "Item_Code__c", "Kind__c", "Taxable__c", "Price__c", "Is_Active__c", "Version__c"];

const tenantRows = await sfQuery(`SELECT Id, Name FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(slug)}' LIMIT 1`);
const tenantId = tenantRows?.[0]?.Id;
if (!tenantId) {
  console.error(`No Sundial_Tenant__c named "${slug}".`);
  process.exit(1);
}
const T = soqlEscapeString(tenantId);

// --- the writer both passes share ---------------------------------------------------------------
const diff = (before, after, fields) => fields.filter((f) => JSON.stringify(before?.[f] ?? null) !== JSON.stringify(after?.[f] ?? null));
const failures = [];

async function writeAll(sfObject, writes, label, canaryCheck) {
  if (!writes.length) {
    console.log(`\n${label}: nothing to write.`);
    return 0;
  }
  const [canary, ...rest] = writes;
  const moved = await canaryCheck(canary);
  if (moved) {
    console.error(`\nCANARY FAILED on ${label} ${canary.Id}: ${moved}. Aborting — nothing else written.`);
    process.exit(1);
  }
  console.log(`\n${label}: canary ok (${canary.Id} → ${canary.Tax_Category__c}; nothing else moved).`);
  let written = 1;
  for (const batch of chunk(rest, 200)) {
    try {
      const res = await sfUpdateMany(sfObject, batch);
      res.forEach((r, i) => {
        if (r.success) written += 1;
        else failures.push({ label, id: batch[i].Id, error: JSON.stringify(r.errors) });
      });
    } catch (e) {
      for (const b of batch) failures.push({ label, id: b.Id, error: e?.sfBody || e?.message || String(e) });
    }
  }
  console.log(`${label}: written ${written} of ${writes.length}.`);
  return written;
}

function finish(summary, cacheEvents) {
  console.log(`\nTOTAL: ${summary}`);
  for (const f of failures) console.error(`  FAILED ${f.label} ${f.id}: ${f.error}`);
  if (failures.length) {
    console.error("Re-run the script: it only picks up what is still blank.");
    process.exit(1);
  }
  console.log(`Next: sundial-cache-sync Test event(s) ${cacheEvents}.`);
  process.exit(0);
}

const readLine = async (id) =>
  (await sfQuery(`SELECT Id, Tax_Category__c, ${LINE_WATCHED.join(", ")}, ${EST_WATCHED.map((f) => `Estimate__r.${f}`).join(", ")} FROM ${LINE} WHERE Id = '${soqlEscapeString(id)}' LIMIT 1`))?.[0];
const lineCanary = async (c) => {
  const before = await readLine(c.Id);
  await sfUpdateRecord(LINE, c.Id, { Tax_Category__c: c.Tax_Category__c });
  const after = await readLine(c.Id);
  if (after?.Tax_Category__c !== c.Tax_Category__c) return "the category did not stick";
  const m = [...diff(before, after, LINE_WATCHED), ...diff(before?.Estimate__r, after?.Estimate__r, EST_WATCHED).map((f) => `estimate ${f}`)];
  return m.length ? `fields it did not write changed: ${m.join(", ")}` : null;
};
const readItem = async (id) => (await sfQuery(`SELECT Id, Tax_Category__c, ${ITEM_WATCHED.join(", ")} FROM ${ITEM} WHERE Id = '${soqlEscapeString(id)}' LIMIT 1`))?.[0];
const itemCanary = async (c) => {
  const before = await readItem(c.Id);
  await sfUpdateRecord(ITEM, c.Id, { Tax_Category__c: c.Tax_Category__c });
  const after = await readItem(c.Id);
  if (after?.Tax_Category__c !== c.Tax_Category__c) return "the category did not stick";
  const m = diff(before, after, ITEM_WATCHED);
  return m.length ? `fields it did not write changed: ${m.join(", ")}` : null;
};
const statusTable = (byStatus) => {
  console.log(`  by estimate status          write   leave`);
  for (const [st, c] of Object.entries(byStatus).sort((a, b) => b[1].write - a[1].write)) console.log(`    ${st.padEnd(24)} ${String(c.write).padStart(6)}  ${String(c.leave).padStart(6)}`);
};

// --- SECOND PASS: --taxed-lines --------------------------------------------------------------------
if (TAXED) {
  const statuses = TAXED_PASS_STATUSES.map((x) => `'${x}'`).join(", ");
  const kinds = MATERIAL_KINDS.map((x) => `'${x}'`).join(", ");
  const ticked = await sfQuery(
    `SELECT Id, Kind__c, Taxable__c, Tax_Category__c, Description__c, Estimate__r.Id, Estimate__r.Name, Estimate__r.Status__c, Estimate__r.Tax_Amount__c, ` +
      `Estimate__r.Customer_Name_at_Creation__c, Estimate__r.Sundial_Customer__r.Name, Estimate__r.Service_Job__r.Archived__c ` +
      `FROM ${LINE} WHERE Client__c = '${T}' AND Tax_Category__c = null AND Taxable__c = true AND Kind__c IN (${kinds}) ` +
      `AND Estimate__r.Status__c IN (${statuses}) ORDER BY Estimate__r.Name, Sort_Order__c`
  );
  const tp = planTaxedLineBackfill(ticked);
  console.log(`Tenant ${slug}: ${ticked.length} ticked material line(s) with a blank Tax Category on non-invoiced estimates.`);
  console.log(`\nTICKED LINES → SOLAR (the estimate stored no tax): ${tp.writes.length}`);
  statusTable(tp.byStatus);
  console.log(`  never touched: ${tp.skipped.zz} on ZZ test records, ${tp.skipped.archivedJob} on archived jobs`);
  console.log(`  sample:`);
  for (const r of tp.rows.slice(0, 12)) console.log(`    ${String(r.estimate).padEnd(10)} ${r.status.padEnd(9)} ${r.description.slice(0, 55)}`);

  // The estimates that DID store tax: the old typed rate vs Acumatica's. The office decides each.
  let tables = null;
  const loadTables = async (sl) => (tables ||= await loadTaxTables(sl, { getSupabaseClient }));
  console.log(`\nLEFT RETAIL — the estimate stored tax (${tp.keep.length} estimate(s)); the office decides each (* = on an ARCHIVED job: listed, never written):`);
  console.log(`    estimate    status     lines  stored tax  old rate   recomputed tax  zone now`);
  for (const k of tp.keep) {
    let recomputed = "?";
    let zone = "?";
    let oldRate = "";
    try {
      const est = (await sfQuery(`SELECT ${ESTIMATE_SELECT} FROM Sundial_Estimate__c WHERE Id = '${soqlEscapeString(k.estimateId)}' AND Client__c = '${T}' LIMIT 1`))?.[0];
      const all = await sfQuery(`SELECT ${LINE_SELECT} FROM ${LINE} WHERE Estimate__c = '${soqlEscapeString(k.estimateId)}' AND Client__c = '${T}'`);
      oldRate = est?.Tax_Rate__c != null ? `${est.Tax_Rate__c}%` : "";
      const tax = await estimateTaxContext({ est, tenantId, tenantSlug: slug, now: new Date(), sfQuery, soqlEscapeString, loadTables });
      recomputed = computeTotals(all.map(lineFromRecord), estimateFromRecord(est, tax)).taxAmount.toFixed(2);
      zone = tax.matched ? `${tax.label} (${tax.rate}%)` : `none: ${tax.reason}`;
    } catch (e) {
      zone = `could not compute: ${e?.message || e}`;
    }
    console.log(`    ${String(k.estimate).padEnd(11)} ${(k.status + (k.archived ? "*" : "")).padEnd(10)} ${String(k.lineCount).padStart(5)}  ${k.storedTax.toFixed(2).padStart(10)}  ${oldRate.padEnd(9)} ${String(recomputed).padStart(14)}  ${zone}`);
  }
  console.log(`    (Sent / Viewed / Approved show the stored tax until the office edits a line or the zone; a Draft computes live.)`);

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --taxed-lines --apply to write.");
    process.exit(0);
  }
  const written = await writeAll(LINE, tp.writes, "Ticked lines", lineCanary);
  finish(`${written} ticked line(s) set to SOLAR.`, `{"object":"serviceline","mode":"full"}`);
}

// --- FIRST PASS: read -----------------------------------------------------------------------------
const lines = await sfQuery(
  `SELECT Id, Kind__c, Taxable__c, Tax_Category__c, Description__c, Estimate__r.Name, Estimate__r.Status__c, ` +
    `Estimate__r.Customer_Name_at_Creation__c, Estimate__r.Sundial_Customer__r.Name, Estimate__r.Service_Job__r.Archived__c ` +
    `FROM ${LINE} WHERE Client__c = '${T}' AND Tax_Category__c = null ORDER BY Estimate__r.Name, Sort_Order__c`
);
const items = await sfQuery(
  `SELECT Id, Name, Item_Code__c, Kind__c, Taxable__c, Tax_Category__c, Is_Active__c FROM ${ITEM} ` +
    `WHERE Client__c = '${T}' AND Tax_Category__c = null ORDER BY Item_Code__c, Version__c`
);
const lp = planLineBackfill(lines);
const ip = planItemBackfill(items);

// --- FIRST PASS: report ---------------------------------------------------------------------------
console.log(`Tenant ${slug}: ${lines.length} line(s) and ${items.length} price-book item(s) with a blank Tax Category.`);
console.log(`\nLINES → SOLAR: ${lp.writes.length}`);
statusTable(lp.byStatus);
console.log(`  left, by reason:`);
for (const [r, n] of Object.entries(lp.leave)) console.log(`    ${String(n).padStart(6)}  ${r}`);
console.log(`  never touched: ${lp.skipped.zz} on ZZ test records, ${lp.skipped.archivedJob} on archived jobs`);
console.log(`  sample:`);
for (const r of lp.rows.slice(0, 12)) console.log(`    ${String(r.estimate).padEnd(10)} ${r.status.padEnd(9)} ${String(r.kind).padEnd(9)} ${r.description.slice(0, 50)}`);

console.log(`\nPRICE-BOOK ITEMS → SOLAR: ${ip.writes.length} (${ip.rows.filter((r) => r.active).length} active versions)`);
for (const [r, n] of Object.entries(ip.leave)) console.log(`    ${String(n).padStart(6)}  left: ${r}`);
if (ip.skipped.zz) console.log(`    ${String(ip.skipped.zz).padStart(6)}  ZZ test items, never touched`);
for (const r of ip.rows.slice(0, 12)) console.log(`    ${String(r.code).padEnd(22)} ${r.active ? "active  " : "inactive"} ${r.name.slice(0, 50)}`);
console.log(`\n(Ticked material lines are the --taxed-lines pass.)`);

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply to write.");
  process.exit(0);
}

// --- FIRST PASS: write ----------------------------------------------------------------------------
const linesWritten = await writeAll(LINE, lp.writes, "Lines", lineCanary);
const itemsWritten = await writeAll(ITEM, ip.writes, "Price-book items", itemCanary);
finish(`${linesWritten} line(s) and ${itemsWritten} price-book item(s) set to SOLAR.`, `{"object":"serviceline","mode":"full"} then {"object":"pricebookitem","mode":"full"}`);
