// Read-only collision check for the v6 access-model package (D-064 Phase 1 item 2).
//
// Same job as scripts/probe-attribute-sync-fields.mjs: prove the new API names are ABSENT
// before deploying an additive package, and prove the things the package depends on are
// PRESENT. An additive Salesforce package that collides fails at deploy with a name
// conflict; one whose lookup target does not exist fails with INVALID_CROSS_REFERENCE_KEY.
// Both are cheap to rule out from here and expensive to discover in Workbench.
//
// It also prints the existing Client__c lookup on each object, because the new Dealer__c
// fields are modelled on it -- if the org's convention differs from what generate.mjs
// writes, this is where that shows up.
//
//   node scripts/probe-access-model-fields.mjs

import { describeObject, sfQuery } from "../lib/salesforce.js";

const NEW_OBJECT = "Sundial_Dealer__c";
const DEALER_LOOKUP_ON = [
  "Sundial_User__c",
  "Sundial_Customer__c",
  "Sundial_Solar__c",
  "Sundial_Roofing__c",
  "Sundial_Commercial__c",
];

console.log("=".repeat(78));
console.log("v6-access-model — pre-deploy probe (READ ONLY)");
console.log("=".repeat(78));

// --- 1. Does Sundial_Dealer__c already exist? -------------------------------
console.log(`\n-- ${NEW_OBJECT} (expect ABSENT: this package creates it)`);
let dealerExists = false;
try {
  const d = await describeObject(NEW_OBJECT);
  dealerExists = true;
  console.log(`   ** PRESENT ** ${d.fields.length} fields:`);
  for (const f of d.fields) console.log(`        ${f.name.padEnd(34)} ${f.type}`);
  console.log("   -> the package would COLLIDE. Reconcile before deploying.");
} catch {
  console.log("   absent — the package will create it.");
}

// --- 2. Is the lookup target real? ------------------------------------------
console.log("\n-- Sundial_Tenant__c (the Client__c lookup target; expect PRESENT)");
try {
  const t = await describeObject("Sundial_Tenant__c");
  const rows = await sfQuery("SELECT Id, Name FROM Sundial_Tenant__c ORDER BY Name");
  console.log(`   present — ${t.fields.length} fields, ${rows.length} tenant row(s):`);
  for (const r of rows) console.log(`        ${r.Id}  ${r.Name}`);
} catch (e) {
  console.log(`   ** MISSING ** ${String(e.message).slice(0, 120)}`);
  console.log("   -> Client__c on Sundial_Dealer__c cannot deploy. Stop.");
}

// --- 3. Dealer__c collision + the Client__c convention on each object --------
console.log("\n-- Dealer__c on each target object (expect ABSENT), beside its Client__c");
let collisions = 0;
for (const obj of DEALER_LOOKUP_ON) {
  let d;
  try {
    d = await describeObject(obj);
  } catch (e) {
    console.log(`   ${obj.padEnd(24)} ** OBJECT MISSING ** ${String(e.message).slice(0, 60)}`);
    continue;
  }
  const byName = new Map(d.fields.map((f) => [f.name, f]));
  const dealer = byName.get("Dealer__c");
  const client = byName.get("Client__c");
  const rep = byName.get("Sales_Rep__c");

  if (dealer) {
    collisions++;
    console.log(`   ${obj.padEnd(24)} ** Dealer__c PRESENT ** (${dealer.type} -> ${dealer.referenceTo?.join(",") || "-"})`);
  } else {
    console.log(`   ${obj.padEnd(24)} Dealer__c absent`);
  }
  console.log(
    `        Client__c     ${client ? `${client.type} -> ${client.referenceTo?.join(",")} · required=${!client.nillable} · updateable=${client.updateable}` : "** MISSING **"}`
  );
  console.log(
    `        Sales_Rep__c  ${rep ? `${rep.type} -> ${rep.referenceTo?.join(",")} · updateable=${rep.updateable}` : "absent (A1 has nothing to derive from on this object)"}`
  );
}

console.log("\n" + "=".repeat(78));
if (dealerExists || collisions > 0) {
  console.log(`** ${collisions} Dealer__c collision(s)${dealerExists ? " + the object already exists" : ""} — do NOT deploy as-is. **`);
  process.exitCode = 1;
} else {
  console.log("No collisions. The package is safe to deploy additively.");
}
