// Read-only collision check for the v5 attribute-sync field package.
//
// Same job as scripts/probe-commission-po-fields.mjs: prove the three API names are absent
// before deploying an additive package, and re-confirm the fields the attribute-only path
// reads are all present.
//
//   node scripts/probe-attribute-sync-fields.mjs

import { describeObject } from "../lib/salesforce.js";
import {
  ATTRIBUTE_SYNC_FIELDS,
  nonCommissionFieldNames,
} from "../lib/acumatica-attributes.js";

const PROPOSED = Object.values(ATTRIBUTE_SYNC_FIELDS);

const d = await describeObject("Sundial_Solar__c");
const byName = new Map(d.fields.map((f) => [f.name, f]));

console.log(`Sundial_Solar__c: ${d.fields.length} fields\n`);

console.log("-- collision check (expect all ABSENT):");
let collisions = 0;
for (const api of PROPOSED) {
  const f = byName.get(api);
  if (f) { collisions++; console.log(`   ** PRESENT ** ${api}  (${f.type})`); }
  else console.log(`   absent      ${api}`);
}

console.log("\n-- fields the attribute-only path READS (expect all PRESENT, all readable):");
let missing = 0;
for (const api of ["Acumatica_Project_ID__c", ...nonCommissionFieldNames()]) {
  const f = byName.get(api);
  if (!f) { missing++; console.log(`   ** MISSING ** ${api}`); }
  else console.log(`   ${api.padEnd(40)} ${f.type}`);
}

console.log("\n-- anything already matching Attribute_ / _Sync (watch for near-duplicates):");
for (const f of d.fields) {
  if (/Attribute_|_Sync_|Synced/i.test(f.name)) {
    console.log(`   ${f.name.padEnd(40)} ${String(f.type).padEnd(10)} "${f.label}"`);
  }
}

process.exitCode = collisions === 0 && missing === 0 ? 0 : 1;
