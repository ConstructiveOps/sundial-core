// Blank the Service Stage on every customer of a tenant that carries "New" (2026-09-29).
//
// WHY. The Housecall Pro import (2026-09-25) stamped `Service_Stage__c = New` on ~7,400
// service customers that had no job — every one of them became a card in the Service
// module's board and a row at the top of its list, and Harmon's real pipeline vanished
// under them. Harmon asked for the value removed: the office will set the stage by hand
// on the customers it is actually working. `lib/hcp-import.js` no longer writes "New"
// (customers or open leads), so the go-live re-run of the import will not put it back.
//
// WHAT IT DOES.
//   node scripts/clear-new-service-stage.mjs --tenant harmon           # READ-ONLY (default)
//   node scripts/clear-new-service-stage.mjs --tenant harmon --apply   # writes
//
//   Dry run: counts the records, prints a sample, and writes the DataLoader file
//     migration/service-stage-new-<tenant>.csv   (columns: Id, Service_Stage__c — blank)
//   for anyone who would rather push the change through DataLoader. In DataLoader tick
//   Settings → "Insert null values", or the blank column is ignored and nothing changes.
//
//   --apply: writes the same change through the API. CANARY FIRST (CLAUDE.md rule): one
//   record alone, re-read, abort if anything this script did not write moved (a Flow on
//   Sundial_Customer__c reacting to the stage). Then batches of 200 through the sObject
//   Collections API (`Id` as the external id), each row succeeding or failing on its own.
//
// It touches ONLY records whose Service_Stage__c is exactly "New", and only in the tenant
// named on the command line. It is idempotent: re-run after a partial write and it plans
// only what is still "New".
//
// ⚠️ DO NOT PIPE THE OUTPUT through head/tail on a real run — a partial write must be
// seen, and the shell's exit status would be the pipe's, not this script's.
//
// AFTER AN APPLY (Tim): the scheduled cache sync picks the change up by SystemModstamp
// within its window; to see it at once, run the cache-sync Lambda with
//   { "object": "customer", "mode": "full" }
// then reload /service/customers.

import fs from "node:fs";
import path from "node:path";
import { sfQuery, sfUpdateRecord, sfUpsertMany, soqlEscapeString } from "../lib/salesforce.js";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const TENANT = opt("--tenant");
const APPLY = flag("--apply");
const OUT = path.resolve(opt("--out", path.join("migration", `service-stage-new-${TENANT ?? "tenant"}.csv`)));
if (!TENANT) {
  console.error("usage: node scripts/clear-new-service-stage.mjs --tenant <slug> [--apply] [--out file.csv]");
  process.exit(2);
}

const OBJECT = "Sundial_Customer__c";
const FIELD = "Service_Stage__c";
const VALUE = "New";
const BATCH = 200;
// Fields a Flow on the customer would plausibly move when the stage changes. Watched on the
// canary; the script never writes them.
const CANARY_WATCH = ["Service_Resolution__c", "Service_Resolved_Date__c", "Status__c", "Stage__c", "Assigned_To__c"];
const show = (v) => (v === null || v === undefined ? "null" : String(v));

console.log("=".repeat(80));
console.log(`CLEAR SERVICE STAGE "${VALUE}" — tenant ${TENANT} ${APPLY ? "(APPLY)" : "(dry run)"}`);
console.log("=".repeat(80));

const tenantRows = await sfQuery(`SELECT Id, Name FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(TENANT)}' LIMIT 1`);
const tenantId = tenantRows[0]?.Id;
if (!tenantId) {
  console.error(`No Sundial_Tenant__c named "${TENANT}".`);
  process.exit(2);
}

// The query a human can paste into Workbench / a report to see the same set:
const SOQL = `SELECT Id, Name, ${FIELD}, ${CANARY_WATCH.join(", ")}, LastModifiedDate FROM ${OBJECT} WHERE Client__c = '${tenantId}' AND ${FIELD} = '${VALUE}' ORDER BY CreatedDate`;
console.log(`\n  SOQL: ${SOQL}\n`);
const rows = await sfQuery(SOQL);
console.log(`  ${rows.length} customer(s) carry ${FIELD} = "${VALUE}".`);

// Everything else on the field, for the record (untouched):
const others = await sfQuery(`SELECT ${FIELD} stage, COUNT(Id) n FROM ${OBJECT} WHERE Client__c = '${tenantId}' GROUP BY ${FIELD}`);
console.log("  stage counts in this tenant (before):");
for (const r of others) console.log(`     ${String(r.stage ?? "(blank)").padEnd(22)} ${r.n}`);

if (rows.length === 0) {
  console.log("\n  nothing to do.\n");
  process.exit(0);
}
console.log("\n  sample:");
for (const r of rows.slice(0, 8)) console.log(`     ${r.Id}  ${String(r.Name ?? "").slice(0, 40)}`);
if (rows.length > 8) console.log(`     ... and ${rows.length - 8} more`);

// The DataLoader file — always written, so the dry run is useful on its own.
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, ["Id,Service_Stage__c", ...rows.map((r) => `${r.Id},`)].join("\r\n") + "\r\n");
console.log(`\n  DataLoader file: ${OUT}  (${rows.length} rows; Update on ${OBJECT}; tick "Insert null values")`);

if (!APPLY) {
  console.log("\n  DRY RUN — nothing written. Re-run with --apply to clear them through the API.\n");
  process.exit(0);
}

// ---------------------------------------------------------------- canary
const first = rows[0];
console.log(`\n  CANARY — writing ${first.Id} (${String(first.Name ?? "")}) alone first`);
const readOne = async (id) => (await sfQuery(`SELECT Id, ${FIELD}, ${CANARY_WATCH.join(", ")}, LastModifiedDate FROM ${OBJECT} WHERE Id = '${id}'`))[0];
const pre = await readOne(first.Id);
await sfUpdateRecord(OBJECT, first.Id, { [FIELD]: null });
const post = await readOne(first.Id);
for (const f of [FIELD, ...CANARY_WATCH]) console.log(`     ${f.padEnd(26)} ${show(pre?.[f]).padEnd(20)} -> ${show(post?.[f])}`);
if (show(post?.[FIELD]) !== "null") {
  console.log("\n  ** The stage did not clear on the canary (something set it back). STOPPING. **\n");
  process.exit(1);
}
const reacted = CANARY_WATCH.some((f) => show(pre?.[f]) !== show(post?.[f]));
if (reacted) {
  console.log(
    "\n  ** AUTOMATION DETECTED — a field this script did not write has changed. **\n" +
      "     A Flow on Sundial_Customer__c is reacting to the stage. STOPPING after one record.\n" +
      `     The canary ${first.Id} HAS been cleared. Deactivate the Flow, then re-run.\n`
  );
  process.exit(1);
}
console.log("     -> nothing else moved. Proceeding in batches of 200.");

// ---------------------------------------------------------------- the rest
const remaining = rows.slice(1);
let written = 1;
const failures = [];
for (let i = 0; i < remaining.length; i += BATCH) {
  const chunk = remaining.slice(i, i + BATCH);
  try {
    const results = await sfUpsertMany(OBJECT, "Id", chunk.map((r) => ({ Id: r.Id, [FIELD]: null })));
    results.forEach((res, k) => {
      if (res.success) written++;
      else failures.push({ id: chunk[k].Id, error: JSON.stringify(res.errors).slice(0, 160) });
    });
  } catch (e) {
    for (const r of chunk) failures.push({ id: r.Id, error: String(e.sfBody ?? e.message).slice(0, 160) });
  }
  console.log(`     ${written} cleared, ${failures.length} failed  (${Math.min(i + BATCH, remaining.length) + 1}/${rows.length})`);
}

if (failures.length) {
  console.log(`\n  ** ${failures.length} WRITE FAILURE(S) ** (re-run the script: it plans only what is still "New")`);
  for (const f of failures.slice(0, 20)) console.log(`     ${f.id}: ${f.error}`);
  if (failures.length > 20) console.log(`     ... and ${failures.length - 20} more`);
  process.exitCode = 1;
}
const after = await sfQuery(`SELECT COUNT(Id) n FROM ${OBJECT} WHERE Client__c = '${tenantId}' AND ${FIELD} = '${VALUE}'`);
console.log(`\n  ${written} of ${rows.length} cleared. Still "${VALUE}" in Salesforce now: ${after[0]?.n ?? "?"}.`);
console.log(`  Next: run the cache-sync Lambda with { "object": "customer", "mode": "full" }, then reload /service/customers.\n`);
