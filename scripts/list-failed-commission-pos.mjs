// List every Solar project whose commission POs last FAILED, with the error — the
// work list for the re-push pass after D-085 amendment 1.
//
//   node scripts/list-failed-commission-pos.mjs [tenantSlug] [--csv out.csv]   (default: harmon)
//
// Read-only. `Commission_PO_Status__c = 'Failed'` is written by the PO engine for every
// refusal that somebody has to fix (vendor_missing, vendor_not_in_acumatica,
// dealer_missing, a rejected create, …) — internal deals and zero commissions are `None`,
// never Failed. Fix the cause shown, then re-push the budget from the project page; the
// push re-runs the PO stage, and the stored OrderNbrs keep it idempotent.
import fs from "node:fs";
import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";

const args = process.argv.slice(2);
const csvAt = args.indexOf("--csv");
const csvPath = csvAt >= 0 ? args[csvAt + 1] : null;
const slug = args.find((a, i) => !a.startsWith("--") && i !== csvAt + 1) || "harmon";

const tenant = (await sfQuery(`SELECT Id FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(slug)}' LIMIT 1`))?.[0];
if (!tenant) {
  console.error(`No Sundial_Tenant__c named "${slug}".`);
  process.exit(1);
}

const rows = await sfQuery(
  `SELECT Id, Name, Project_Name__c, Acumatica_Project_ID__c, Commission_Deal_Type__c, ` +
    `Dealer__r.Name, Dealer__r.Acumatica_Vendor_ID__c, Sales_Company_Harmon_Solar_or_Third__c, ` +
    `Commission_PO_M1_Number__c, Commission_PO_M2_Number__c, Commission_PO_Error__c, LastModifiedDate ` +
    `FROM Sundial_Solar__c WHERE Client__c = '${soqlEscapeString(tenant.Id)}' ` +
    `AND Commission_PO_Status__c = 'Failed' ORDER BY LastModifiedDate DESC`
);

console.log(`\n=== ${rows.length} Solar project(s) with Commission_PO_Status__c = Failed ("${slug}") ===`);
// The error field joins one line per milestone. A FROZEN M1 is an expected resting state,
// so the line that made the run Failed is the first one that is not a frozen note — group
// by THAT, with numbers blanked, so one cause with many jobs reads as one fix.
const FROZEN_NOTE = /is (Closed|Completed|Canceled) and cannot be changed/;
const causeOf = (r) => {
  const lines = String(r.Commission_PO_Error__c ?? "(no error text)").split("\n").filter(Boolean);
  return lines.find((l) => !FROZEN_NOTE.test(l)) ?? lines[0];
};
const keyOf = (line) => {
  const k = line.replace(/\d+(\.\d+)?/g, "#").replace(/"[^"]*"/g, '"…"');
  return k.length > 140 ? `${k.slice(0, 137)}...` : k;
};
const byCause = new Map();
for (const r of rows) {
  const key = keyOf(causeOf(r));
  if (!byCause.has(key)) byCause.set(key, []);
  byCause.get(key).push(r);
}
for (const [key, list] of [...byCause].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n  ${list.length} × ${key}`);
  for (const r of list) {
    const dealer = r.Dealer__r?.Name ? `dealer ${r.Dealer__r.Name} (${r.Dealer__r.Acumatica_Vendor_ID__c || "no vendor"})` : `no dealer; picklist ${JSON.stringify(r.Sales_Company_Harmon_Solar_or_Third__c ?? null)}`;
    const nbrs = [r.Commission_PO_M1_Number__c, r.Commission_PO_M2_Number__c].filter(Boolean).join("/") || "no POs";
    console.log(`    ${r.Name.padEnd(10)} ${String(r.Acumatica_Project_ID__c ?? "-").padEnd(8)} ${nbrs.padEnd(13)} ${dealer}   ${r.Id}`);
    const cause = causeOf(r);
    console.log(`               ${cause.length > 200 ? `${cause.slice(0, 197)}...` : cause}`);
  }
}

if (csvPath) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Id", "Name", "Project", "AcumaticaProject", "DealType", "Dealer", "DealerVendor", "SalesCompany", "M1", "M2", "Error", "LastModified"];
  const lines = rows.map((r) => [r.Id, r.Name, r.Project_Name__c, r.Acumatica_Project_ID__c, r.Commission_Deal_Type__c,
    r.Dealer__r?.Name, r.Dealer__r?.Acumatica_Vendor_ID__c, r.Sales_Company_Harmon_Solar_or_Third__c,
    r.Commission_PO_M1_Number__c, r.Commission_PO_M2_Number__c, r.Commission_PO_Error__c, r.LastModifiedDate].map(esc).join(","));
  fs.writeFileSync(csvPath, [head.join(","), ...lines].join("\n") + "\n");
  console.log(`\nwrote ${rows.length} row(s) to ${csvPath}`);
}
