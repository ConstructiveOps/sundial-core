// Point every partner-billed job at its paying COMPANY record (D-081, 2026-10-07).
//
// WHY. Until D-081 a job named its payer as text — Bill_To_Name__c, typed by the office or
// read off the HCP job title ("SunRun", "SMA", "APS"). D-081 makes the payer a customer
// record (Bill_To_Customer__c → Sundial_Customer__c, a company), so the invoice can carry the
// payer's address and, later, the payer's Acumatica customer id. This fills that lookup on the
// jobs that only have the text, by matching the text to a company's Company_Name__c in the same
// tenant (trimmed, case-insensitive — lib/bill-to-backfill.js). It never guesses between two
// companies with the same name, and it never touches an invoice: an issued invoice keeps the
// name it was issued with; the next issue / reissue snapshots the record.
//
//   node scripts/backfill-bill-to-customers.mjs                    # READ-ONLY (default), tenant harmon
//   node scripts/backfill-bill-to-customers.mjs --apply            # writes Bill_To_Customer__c
//   options: --tenant <slug> (default harmon)   --limit N
//
//   Dry run: prints every distinct typed name with its job count and outcome —
//     matched     one company by that name: the job will point at it
//     unmatched   no company by that name: CREATE IT (tick Is Company, type the name), re-run
//     ambiguous   two companies share the name: merge or rename one, re-run
//   --apply: CANARY FIRST (CLAUDE.md rule) — one job alone, re-read, abort if any field this
//   script did not write moved; then batches of 200 (sObject Collections, Id as key).
//
// Idempotent: a re-run plans only the jobs still without a payer record. Needs the AWS
// credentials lib/salesforce.js reads — Tim's PowerShell.
//
// ⚠️ DO NOT PIPE THE OUTPUT through head/tail on a real run — a partial write must be seen.
//
// AFTER AN APPLY: run the cache-sync Lambda with { "object": "job", "mode": "full" }, or wait
// for the 5-minute sync.

import { sfQuery, sfUpdateRecord, sfUpsertMany, soqlEscapeString } from "../lib/salesforce.js";
import { planBillToBackfill } from "../lib/bill-to-backfill.js";

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const TENANT = opt("--tenant", "harmon");
const APPLY = args.includes("--apply");
const LIMIT = Number(opt("--limit", "0")) || 0;
const BATCH = 200;
const JOB = "Sundial_Service_Job__c";
// The canary watches every field it reads but does not write.
const JOB_SELECT = "Id, Name, Bill_To_Type__c, Bill_To_Name__c, Bill_To_Customer__c, Status__c, Payment_Status__c, Customer_Name_at_Creation__c, Sundial_Customer__c";
const JOB_WATCH = ["Bill_To_Type__c", "Bill_To_Name__c", "Status__c", "Payment_Status__c", "Customer_Name_at_Creation__c", "Sundial_Customer__c"];
const s = (v) => (v == null ? "" : String(v).trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("=".repeat(80));
console.log(`BILL TO -> CUSTOMER RECORD BACKFILL (D-081) - tenant ${TENANT} ${APPLY ? "(APPLY)" : "(dry run)"}`);
console.log("=".repeat(80));

const [tenant] = await sfQuery(`SELECT Id FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(TENANT)}' LIMIT 1`);
if (!tenant) {
  console.error(`No Sundial_Tenant__c named "${TENANT}".`);
  process.exit(2);
}
const T = soqlEscapeString(tenant.Id);

const jobs = await sfQuery(
  `SELECT ${JOB_SELECT} FROM ${JOB} WHERE Client__c = '${T}' AND Bill_To_Type__c != 'Customer' AND Bill_To_Type__c != null ` +
    `AND Bill_To_Name__c != null AND Bill_To_Customer__c = null ORDER BY Name`
);
const companies = await sfQuery(`SELECT Id, Name, Is_Company__c, Company_Name__c FROM Sundial_Customer__c WHERE Client__c = '${T}' AND Is_Company__c = true`);
const { writes: allWrites, byName } = planBillToBackfill(jobs, companies);
const writes = LIMIT ? allWrites.slice(0, LIMIT) : allWrites;

console.log(`\n  ${jobs.length} partner-billed job(s) with a typed payer name and no payer record; ${companies.length} company customer(s) in the tenant.\n`);
const counts = { matched: 0, unmatched: 0, ambiguous: 0 };
for (const r of byName) counts[r.outcome] += r.jobs;
console.log(`  jobs: ${counts.matched} matched | ${counts.unmatched} unmatched | ${counts.ambiguous} ambiguous\n`);
for (const outcome of ["matched", "unmatched", "ambiguous"]) {
  const rows = byName.filter((r) => r.outcome === outcome);
  if (!rows.length) continue;
  console.log(`  ${outcome.toUpperCase()} (${rows.length} name${rows.length === 1 ? "" : "s"})`);
  for (const r of rows) {
    const extra = r.companyId ? `-> ${r.companyId}` : r.companyIds ? `-> ${r.companyIds.join(", ")}` : "";
    console.log(`    ${String(r.jobs).padStart(5)} job(s)  ${r.name.padEnd(36)} ${extra}`);
  }
  console.log("");
}
if (counts.unmatched) console.log("  UNMATCHED names are the companies to create: New Customer -> tick Is Company -> the name exactly as above. Then re-run.\n");
if (counts.ambiguous) console.log("  AMBIGUOUS names have two company records - merge or rename one, then re-run.\n");

if (!APPLY) {
  console.log(`  DRY RUN - nothing written. ${writes.length} job(s) would get Bill_To_Customer__c. Re-run with --apply to write.\n`);
  process.exit(0);
}
if (!writes.length) {
  console.log("  Nothing to write.\n");
  process.exit(0);
}

// ---------------------------------------------------------------- apply, canary first
const items = writes.map((w) => ({ sf: w.job, fields: { Bill_To_Customer__c: w.company.Id } }));
const readOne = async (id) => (await sfQuery(`SELECT ${JOB_SELECT} FROM ${JOB} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${T}'`))[0];
const first = items[0];
console.log(`  CANARY - ${first.sf.Name} (${first.sf.Id}) alone first: Bill_To_Customer__c -> ${first.fields.Bill_To_Customer__c}`);
const pre = await readOne(first.sf.Id);
await sfUpdateRecord(JOB, first.sf.Id, first.fields);
const post = await readOne(first.sf.Id);
if (s(post?.Bill_To_Customer__c) !== s(first.fields.Bill_To_Customer__c)) {
  console.log("\n  ** The canary write did not land. STOPPING. **\n");
  process.exit(1);
}
const reacted = JOB_WATCH.filter((f) => s(pre?.[f]) !== s(post?.[f]));
if (reacted.length) {
  console.log(`\n  ** AUTOMATION DETECTED - ${reacted.join(", ")} changed on the canary and this script did not write it. STOPPING after one record. **\n     The canary HAS been written. Find the Flow on ${JOB}, then re-run.\n`);
  process.exit(1);
}
console.log(`     -> landed, nothing else moved. Proceeding in batches of ${BATCH}.`);

let written = 1;
const failures = [];
const rest = items.slice(1);
for (let i = 0; i < rest.length; i += BATCH) {
  const chunk = rest.slice(i, i + BATCH);
  try {
    const res = await sfUpsertMany(JOB, "Id", chunk.map((it) => ({ Id: it.sf.Id, ...it.fields })));
    res.forEach((r, k) => {
      if (r.success) written++;
      else failures.push({ id: chunk[k].sf.Id, name: chunk[k].sf.Name, error: JSON.stringify(r.errors).slice(0, 200) });
    });
  } catch (e) {
    for (const it of chunk) failures.push({ id: it.sf.Id, name: it.sf.Name, error: String(e.sfBody ?? e.message).slice(0, 200) });
  }
  process.stdout.write(`\r     jobs: ${written} written, ${failures.length} failed  (${Math.min(i + BATCH, rest.length) + 1}/${items.length})   `);
  await sleep(150);
}
process.stdout.write("\n");
if (failures.length) {
  console.log(`\n  ** ${failures.length} WRITE FAILURE(S) ** (re-run: it plans only what is still missing)`);
  for (const f of failures.slice(0, 20)) console.log(`     ${f.id} ${f.name}: ${f.error}`);
  if (failures.length > 20) console.log(`     ... and ${failures.length - 20} more`);
  process.exitCode = 1;
}
console.log(`\n  Done: ${written} job(s) point at their paying company. Next: cache-sync { "object": "job", "mode": "full" }.\n`);
