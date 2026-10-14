// Put HCP customer notes back on the lead customers the import stripped them from (2026-10-14)
// — a targeted repair, NOT a re-import.
//
// WHY. The import's leads phase wrote the lead block ("HCP lead #…") into
// Sundial_Customer__c.Description__c and REPLACED the customer's own HCP notes (Harmon, Ben:
// "migrated without the historical notes"). lib/hcp-import.js now keeps them; this repairs the
// records already written. The plan is lib/hcp-lead-notes.js: a customer the import CREATED
// (id-map.json `created: true`, matched on HCP_Id__c) whose Description__c is still exactly a
// lead block (+ the archive line) and whose HCP customer notes are not in it gets
//   <HCP notes>⏎⏎<the lead block + archive line, unchanged>
// Anything else is left alone: a Description__c a person edited is LISTED, never overwritten;
// a linked (Sales) record is listed too — its replaced text was Sales's, not in the pull.
// The HCP lead object carries no notes field of its own (checked against the 2026-10-04
// pull: id, number, customer, address, lead_source, status, pipeline_status, tags,
// total_amount, assigned_employee, conversions, lost_at, job_fields, company_*), so the
// customer's notes are the only notes there are to restore.
//
//   node scripts/hcp-restore-lead-notes.mjs --tenant harmon              # READ-ONLY (default)
//   node scripts/hcp-restore-lead-notes.mjs --tenant harmon --apply      # writes Description__c
//   options: --in migration/hcp   --limit N
//
//   Dry run: the counts, a sample of 10 (before → after), and
//     migration/hcp/import/lead-notes-plan.csv       every record this run would write
//     migration/hcp/import/lead-notes-edited.csv     hand-edited records, skipped — look at them
//     migration/hcp/import/lead-notes-linked.csv     Sales records whose text the lead block replaced
//   --apply: CANARY FIRST (CLAUDE.md rule) — one customer alone, re-read, abort if any field
//   this script did not write moved; then batches of 200 (sObject Collections, Id as key),
//   each batch's Description__c re-read just before it is written and any record that changed
//   since the plan skipped (an edit made mid-run is still a hand edit).
//
// Idempotent: a restored record contains its notes, so a re-run skips it. Needs the pull in
// migration/hcp/raw/ and import/id-map.json, and the AWS credentials lib/salesforce.js reads.
//
// ⚠️ DO NOT PIPE THE OUTPUT through head/tail on a real run — a partial write must be seen.
//
// AFTER AN APPLY: run the cache-sync Lambda with { "object": "customer", "mode": "full" }, or
// wait for the 5-minute sync.

import fs from "node:fs/promises";
import path from "node:path";
import { sfQuery, sfUpdateRecord, sfUpsertMany, soqlEscapeString } from "../lib/salesforce.js";
import { HCP_ID_FIELD } from "../lib/hcp-import.js";
import { toCsv } from "../lib/hcp-api.js";
import { planLeadNotesRestore } from "../lib/hcp-lead-notes.js";

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const TENANT = opt("--tenant");
const APPLY = args.includes("--apply");
const IN = path.resolve(opt("--in", path.join("migration", "hcp")));
const OUT = path.join(IN, "import");
const LIMIT = Number(opt("--limit", "0")) || 0;
if (!TENANT) {
  console.error("usage: node scripts/hcp-restore-lead-notes.mjs --tenant <slug> [--apply] [--limit N]");
  process.exit(2);
}
const BATCH = 200;
const CUSTOMER = "Sundial_Customer__c";
// The canary watches every field it reads but does not write.
const SELECT = `Id, Name, ${HCP_ID_FIELD}, Description__c, Status__c, Service_Stage__c, Customer_Type__c, Archived__c, Assigned_To__c, Primary_Email__c, Primary_Phone__c`;
const WATCH = ["Name", HCP_ID_FIELD, "Status__c", "Service_Stage__c", "Customer_Type__c", "Archived__c", "Assigned_To__c", "Primary_Email__c", "Primary_Phone__c"];
const s = (v) => (v == null ? "" : String(v).trim());
const nl = (v) => String(v ?? "").replace(/\r\n/g, "\n").trim();
const show = (v, n = 160) => String(v ?? "").slice(0, n).replace(/\n/g, "⏎");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));

console.log("=".repeat(80));
console.log(`HCP LEAD NOTES RESTORE — Description__c — tenant ${TENANT} ${APPLY ? "(APPLY)" : "(dry run)"}`);
console.log("=".repeat(80));

const [tenant] = await sfQuery(`SELECT Id FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(TENANT)}' LIMIT 1`);
if (!tenant) {
  console.error(`No Sundial_Tenant__c named "${TENANT}".`);
  process.exit(2);
}
const T = soqlEscapeString(tenant.Id);

let customersHcp, leadsHcp, jobTypesRaw, idMap;
try {
  customersHcp = await readJson(path.join(IN, "raw", "customers.json"));
  leadsHcp = await readJson(path.join(IN, "raw", "leads.json"));
  jobTypesRaw = await readJson(path.join(IN, "raw", "job_types.json")).catch(() => []);
  idMap = await readJson(path.join(OUT, "id-map.json"));
} catch (e) {
  console.error(`The pull is not readable under ${IN} (${e.message}) — run scripts/hcp-pull.mjs, and the import's id-map.json must be in ${OUT}.`);
  process.exit(2);
}
const jobTypes = new Map(jobTypesRaw.map((jt) => [s(jt.id), s(jt.name)]));

// Description__c is a long text area: SOQL cannot filter on it, so read every HCP-stamped
// customer in the tenant and let the planner decide.
const records = await sfQuery(`SELECT ${SELECT} FROM ${CUSTOMER} WHERE Client__c = '${T}' AND ${HCP_ID_FIELD} != null ORDER BY Name`);
const plan = planLeadNotesRestore({ records, customersHcp, leadsHcp, jobTypes, idMapCustomers: idMap.customers || {} });
const writes = LIMIT ? plan.writes.slice(0, LIMIT) : plan.writes;
const c = plan.counts;

console.log(`\n  pull: ${customersHcp.length} HCP customers, ${leadsHcp.length} leads (no notes field on the lead itself)`);
console.log(`  Salesforce: ${records.length} customers with ${HCP_ID_FIELD} in the tenant\n`);
console.log(`  description is not a lead block        ${String(c.notLeadBlock).padStart(6)}   (nothing to do)`);
console.log(`  lead block, linked Sales record        ${String(c.linked).padStart(6)}   (left alone → lead-notes-linked.csv)`);
console.log(`  lead block, HCP notes blank            ${String(c.noNotes).padStart(6)}   (nothing to restore)`);
console.log(`  lead block, notes already there        ${String(c.alreadyRestored).padStart(6)}   (restored before)`);
console.log(`  description edited by a person         ${String(c.edited).padStart(6)}   (SKIPPED → lead-notes-edited.csv)`);
console.log(`  notes + block over 32,000 characters   ${String(c.tooLong).padStart(6)}   (SKIPPED → lead-notes-edited.csv)`);
console.log(`  TO RESTORE                             ${String(c.restore).padStart(6)}${LIMIT ? `   (--limit ${LIMIT}: ${writes.length} this run)` : ""}\n`);

if (plan.writes.length) {
  console.log("  SAMPLE (10):");
  for (const w of plan.writes.slice(0, 10)) {
    console.log(`    ${w.id}  ${w.name}  (HCP lead #${w.lead})`);
    console.log(`      before: ${show(w.before)}`);
    console.log(`      after:  ${show(w.after)}`);
  }
  console.log("");
}
if (plan.edited.length) {
  console.log(`  EDITED BY A PERSON — skipped, never overwritten (${plan.edited.length}):`);
  for (const e of plan.edited.slice(0, 20)) console.log(`    ${e.id}  ${e.name}${e.reason ? `  [${e.reason}]` : ""}: ${show(e.description, 100)}`);
  if (plan.edited.length > 20) console.log(`    … and ${plan.edited.length - 20} more in lead-notes-edited.csv`);
  console.log("");
}

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, "lead-notes-plan.csv"), toCsv(plan.writes.map((w) => ({ id: w.id, name: w.name, hcp_id: w.hcp_id, lead: w.lead, before: w.before, after: w.after }))));
await fs.writeFile(path.join(OUT, "lead-notes-edited.csv"), toCsv(plan.edited.map((e) => ({ id: e.id, name: e.name, hcp_id: e.hcp_id, reason: e.reason || "edited after the import", description: e.description }))));
await fs.writeFile(path.join(OUT, "lead-notes-linked.csv"), toCsv(plan.linked));
console.log(`  wrote ${path.join(OUT, "lead-notes-plan.csv")}, lead-notes-edited.csv, lead-notes-linked.csv\n`);

if (!APPLY) {
  console.log(`  DRY RUN — nothing written. ${writes.length} customer(s) would get their HCP notes back. Re-run with --apply to write.\n`);
  process.exit(0);
}
if (!writes.length) {
  console.log("  Nothing to write.\n");
  process.exit(0);
}

// ---------------------------------------------------------------- apply, canary first
const readMany = async (ids) => sfQuery(`SELECT ${SELECT} FROM ${CUSTOMER} WHERE Client__c = '${T}' AND Id IN (${ids.map((id) => `'${soqlEscapeString(id)}'`).join(", ")})`);
const first = writes[0];
console.log(`  CANARY — ${first.name} (${first.id}) alone first`);
const [pre] = await readMany([first.id]);
if (nl(pre?.Description__c) !== first.before) {
  console.log("\n  ** The canary's Description__c changed since the plan (someone is editing it). STOPPING — re-run. **\n");
  process.exit(1);
}
await sfUpdateRecord(CUSTOMER, first.id, { Description__c: first.after });
const [post] = await readMany([first.id]);
if (nl(post?.Description__c) !== nl(first.after)) {
  console.log("\n  ** The canary write did not land. STOPPING. **\n");
  process.exit(1);
}
const reacted = WATCH.filter((f) => s(pre?.[f]) !== s(post?.[f]));
if (reacted.length) {
  console.log(`\n  ** AUTOMATION DETECTED — ${reacted.join(", ")} changed on the canary and this script did not write it. STOPPING after one record. **\n     The canary HAS been written. Find the Flow on ${CUSTOMER}, then re-run.\n`);
  process.exit(1);
}
console.log(`     -> landed, nothing else moved. Proceeding in batches of ${BATCH}.`);

let written = 1;
let changedSincePlan = 0;
const failures = [];
const rest = writes.slice(1);
for (let i = 0; i < rest.length; i += BATCH) {
  const chunk = rest.slice(i, i + BATCH);
  try {
    // re-read just before writing: a description edited since the plan is a hand edit — skip it
    const now = new Map((await readMany(chunk.map((w) => w.id))).map((r) => [r.Id, nl(r.Description__c)]));
    const safe = chunk.filter((w) => now.get(w.id) === w.before);
    changedSincePlan += chunk.length - safe.length;
    if (safe.length) {
      const res = await sfUpsertMany(CUSTOMER, "Id", safe.map((w) => ({ Id: w.id, Description__c: w.after })));
      res.forEach((r, k) => {
        if (r.success) written++;
        else failures.push({ id: safe[k].id, name: safe[k].name, error: JSON.stringify(r.errors).slice(0, 200) });
      });
    }
  } catch (e) {
    for (const w of chunk) failures.push({ id: w.id, name: w.name, error: String(e.sfBody ?? e.message).slice(0, 200) });
  }
  process.stdout.write(`\r     customers: ${written} written, ${changedSincePlan} changed since the plan (skipped), ${failures.length} failed  (${Math.min(i + BATCH, rest.length) + 1}/${writes.length})   `);
  await sleep(150);
}
process.stdout.write("\n");
if (failures.length) {
  console.log(`\n  ** ${failures.length} WRITE FAILURE(S) ** (re-run: it plans only what is still missing)`);
  for (const f of failures.slice(0, 20)) console.log(`     ${f.id} ${f.name}: ${f.error}`);
  if (failures.length > 20) console.log(`     ... and ${failures.length - 20} more`);
  process.exitCode = 1;
}
console.log(`\n  Done: ${written} customer(s) have their HCP notes back${changedSincePlan ? `; ${changedSincePlan} edited mid-run were skipped (re-run to see them listed)` : ""}. Next: cache-sync { "object": "customer", "mode": "full" }.\n`);
