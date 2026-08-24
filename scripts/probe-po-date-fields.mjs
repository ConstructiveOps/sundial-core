// Read-only probe: which DATE fields does the PurchaseOrder entity actually expose?
//
// Q13 named two Salesforce milestone dates (Audit_Date_and_DateTime__c for M1,
// Scheduled_Install_Date__c for M2) and asked that they be wired "wherever the engine
// references milestone dates (PO Requested/Promised dates if applicable)". Whether they
// ARE applicable is a fact about the endpoint, not a judgement call — this answers it.
//
// GET only. Nothing here writes.
//
//   node scripts/probe-po-date-fields.mjs 016442 016102

import { getAcumaticaEntity } from "../lib/acumatica.js";

const nbrs = process.argv.slice(2);
if (nbrs.length === 0) {
  console.error("usage: node scripts/probe-po-date-fields.mjs <OrderNbr> [OrderNbr...]");
  process.exit(1);
}

const isDateish = (k) => /date|on$|promis|request|expect|due/i.test(k);

for (const nbr of nbrs) {
  const res = await getAcumaticaEntity("PurchaseOrder", {
    $filter: `OrderNbr eq '${nbr}'`,
    $expand: "Details",
  });
  if (!res.ok) {
    console.log(`\n== ${nbr}: read failed (${res.status}) ${res.text.slice(0, 200)}`);
    continue;
  }
  const rows = Array.isArray(res.data) ? res.data : [];
  if (rows.length !== 1) {
    console.log(`\n== ${nbr}: ${rows.length} rows`);
    continue;
  }
  const po = rows[0];
  console.log(`\n== PO ${nbr}  (${po.Status?.value}, vendor ${po.VendorID?.value})`);

  console.log("-- header fields (all):");
  console.log("   " + Object.keys(po).sort().join(", "));
  console.log("-- header date-ish:");
  for (const [k, v] of Object.entries(po)) {
    if (isDateish(k)) console.log(`   ${k} = ${JSON.stringify(v?.value ?? v)}`);
  }

  const line = (po.Details ?? [])[0];
  if (!line) continue;
  console.log("-- line fields (all):");
  console.log("   " + Object.keys(line).sort().join(", "));
  console.log("-- line date-ish:");
  for (const [k, v] of Object.entries(line)) {
    if (isDateish(k)) console.log(`   ${k} = ${JSON.stringify(v?.value ?? v)}`);
  }
}
