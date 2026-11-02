// scripts/backfill-invoice-date.mjs — stamp Invoice_Date__c on the invoices issued before the
// field existed (Harmon, 2026-11-02).
//
//   node scripts/backfill-invoice-date.mjs --tenant harmon            # dry run: lists what would be written
//   node scripts/backfill-invoice-date.mjs --tenant harmon --apply    # canary first, then the rest
//
// The invoice date is the day the office means the invoice to carry; for an invoice issued
// before the field existed that is the local day (SERVICE_TIMEZONE, America/Phoenix) of its
// Issued_At__c — exactly what the report and the document already assume for a blank field.
// Writes ONLY rows whose Invoice_Date__c is blank; never touches a dated one. Canary first
// (CLAUDE.md): one row, re-read, abort if any field it did not write moved.

import { sfQuery, sfUpdateRecord, soqlEscapeString } from "../lib/salesforce.js";
import { localDayOf } from "../lambdas/sundial-service-estimate/invoice.js";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const TENANT = opt("--tenant");
const APPLY = args.includes("--apply");
const TZ = process.env.SERVICE_TIMEZONE || "America/Phoenix";
if (!TENANT) {
  console.error("usage: node scripts/backfill-invoice-date.mjs --tenant <slug> [--apply]");
  process.exit(2);
}
const tenantRows = await sfQuery(`SELECT Id FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(TENANT)}' LIMIT 1`);
const tenantId = tenantRows?.[0]?.Id;
if (!tenantId) { console.error(`tenant "${TENANT}" not found`); process.exit(2); }

const WATCH = ["Name", "Status__c", "Total__c", "Paid_Amount__c", "Issued_At__c", "Due_Date__c", "Voided_At__c"];
const SELECT = ["Id", "Invoice_Date__c", ...WATCH].join(", ");
const rows = await sfQuery(`SELECT ${SELECT} FROM Sundial_Service_Invoice__c WHERE Client__c = '${tenantId}' AND Invoice_Date__c = null AND Issued_At__c != null ORDER BY Issued_At__c`);
console.log(`INVOICE DATE BACKFILL — tenant ${TENANT} — ${APPLY ? "APPLY" : "dry run"} — ${rows.length} invoice(s) with no Invoice_Date__c (timezone ${TZ})`);
for (const r of rows) console.log(`  ${r.Name}  issued ${r.Issued_At__c}  →  ${localDayOf(r.Issued_At__c, TZ)}  (${r.Status__c})`);
if (!APPLY || !rows.length) process.exit(0);

async function reread(id) {
  return (await sfQuery(`SELECT ${SELECT} FROM Sundial_Service_Invoice__c WHERE Id = '${id}'`))[0];
}
// Canary: one invoice alone, re-read, every watched field unchanged.
const canary = rows[0];
const want = localDayOf(canary.Issued_At__c, TZ);
await sfUpdateRecord("Sundial_Service_Invoice__c", canary.Id, { Invoice_Date__c: want });
const after = await reread(canary.Id);
const moved = WATCH.filter((f) => String(after[f] ?? "") !== String(canary[f] ?? ""));
if (after.Invoice_Date__c !== want || moved.length) {
  console.error(`CANARY FAILED on ${canary.Name}: Invoice_Date__c=${after.Invoice_Date__c} (wanted ${want}); fields that moved: ${moved.join(", ") || "none"}. Stopping — nothing else written.`);
  process.exit(1);
}
console.log(`canary ok: ${canary.Name} → ${want}`);
let n = 1;
for (const r of rows.slice(1)) {
  await sfUpdateRecord("Sundial_Service_Invoice__c", r.Id, { Invoice_Date__c: localDayOf(r.Issued_At__c, TZ) });
  n++;
  if (n % 25 === 0) console.log(`  ${n}/${rows.length}`);
}
console.log(`done: ${n} invoice(s) stamped. The serviceinvoice cache refreshes on its next sync.`);
