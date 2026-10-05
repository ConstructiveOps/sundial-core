// Fix up the HCP-imported jobs and estimates in place (2026-10-05) — NOT a re-import.
//
// WHY. Harmon's 2026-10-05 list: (6) the imported jobs' notes read "[object Object]" — HCP's
// `notes` is a list of { id, content } and the import stringified it; (7) every job bills the
// Customer — HCP has no Bill-To, the payer is in the job's title ("Solar - SunRun Standard
// Truck Roll"); (2) estimates that carried tax have no Tax_Rate__c, so opening one recomputes
// its tax to $0. The office has been working these records since Monday, so a full re-run of
// scripts/hcp-import.mjs would trample statuses. This writes ONLY what lib/hcp-backfill.js
// plans per record, and leaves alone anything the office changed (an edited description, a
// chosen payer, a set service type, a typed rate).
//
// WHAT IT DOES.
//   node scripts/hcp-backfill-notes-billto.mjs --tenant harmon              # READ-ONLY (default)
//   node scripts/hcp-backfill-notes-billto.mjs --tenant harmon --apply      # writes
//   options: --in migration/hcp   --only jobs|estimates   --fallback-rate 8.6   --limit N
//
//   Dry run: plans every record, prints the counts, and writes
//     migration/hcp/import/bill-to-review.csv     one row per imported job: title → payer / type
//     migration/hcp/import/backfill-plan.csv      every field this run would write
//   --apply: CANARY FIRST (CLAUDE.md rule) — one job alone, re-read, abort if any field this
//   script did not write moved; then batches of 200 through sObject Collections (Id as key),
//   each row succeeding or failing on its own. Then the same for estimates.
//
// Idempotent: a re-run plans only what is still wrong. Needs the pull in migration/hcp/raw/
// (scripts/hcp-pull.mjs) and the AWS credentials lib/salesforce.js reads — Tim's PowerShell,
// never the device VM.
//
// ⚠️ DO NOT PIPE THE OUTPUT through head/tail on a real run — a partial write must be seen.
//
// AFTER AN APPLY (Tim): run the cache-sync Lambda with { "object": "job", "mode": "full" }
// and { "object": "estimate", "mode": "full" }, or wait for the 5-minute sync.

import fs from "node:fs/promises";
import path from "node:path";
import { sfQuery, sfUpdateRecord, sfUpsertMany, soqlEscapeString } from "../lib/salesforce.js";
import { HCP_ID_FIELD } from "../lib/hcp-import.js";
import { csvLine, describeBillTo, planEstimateFix, planJobFix, taxJurisdictionOf } from "../lib/hcp-backfill.js";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const TENANT = opt("--tenant");
const APPLY = flag("--apply");
const IN = path.resolve(opt("--in", path.join("migration", "hcp")));
const OUT = path.join(IN, "import");
const ONLY = opt("--only");
const LIMIT = Number(opt("--limit", "0")) || 0;
const FALLBACK_RATE = opt("--fallback-rate") != null ? Number(opt("--fallback-rate")) : null;
if (!TENANT) {
  console.error("usage: node scripts/hcp-backfill-notes-billto.mjs --tenant <slug> [--apply] [--only jobs|estimates] [--fallback-rate 8.6] [--limit N]");
  process.exit(2);
}
const BATCH = 200;
const s = (v) => (v == null ? "" : String(v).trim());
const show = (v) => (v == null ? "null" : String(v).slice(0, 60).replace(/\n/g, "⏎"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
};

console.log("=".repeat(80));
console.log(`HCP BACKFILL — notes / bill-to / tax rate — tenant ${TENANT} ${APPLY ? "(APPLY)" : "(dry run)"}`);
console.log("=".repeat(80));

const [tenant] = await sfQuery(`SELECT Id FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(TENANT)}' LIMIT 1`);
if (!tenant) {
  console.error(`No Sundial_Tenant__c named "${TENANT}".`);
  process.exit(2);
}
const T = tenant.Id;

// ---------------------------------------------------------------- the pull
const jobsHcp = await readJson(path.join(IN, "raw", "jobs.json"), []);
if (!jobsHcp.length) {
  console.error(`No jobs in ${path.join(IN, "raw", "jobs.json")} — run scripts/hcp-pull.mjs first.`);
  process.exit(2);
}
const byHcpId = new Map(jobsHcp.map((j) => [s(j.id), j]));
/** The job's line items (for the tax line's city) live in raw/jobs/<id>.json. */
async function hcpLineItems(hcpId) {
  const d = await readJson(path.join(IN, "raw", "jobs", `${hcpId}.json`), null);
  return d?.line_items || [];
}
console.log(`  ${jobsHcp.length} HCP jobs in the pull`);

const JOB = "Sundial_Service_Job__c";
const EST = "Sundial_Estimate__c";
const LINE = "Sundial_Service_Line__c";
const JOB_SELECT = `Id, Name, ${HCP_ID_FIELD}, Office_Notes__c, Issue_Description__c, Bill_To_Type__c, Bill_To_Name__c, Service_Type__c, Status__c, Payment_Status__c, Archived__c, LastModifiedDate`;
const EST_SELECT = `Id, Name, ${HCP_ID_FIELD}, Tax_Rate__c, Tax_Amount__c, Tax_Jurisdiction__c, Total__c, Subtotal__c, Status__c, LastModifiedDate`;
const JOB_WATCH = ["Status__c", "Payment_Status__c", "Archived__c"]; // what a Flow would plausibly move on a job write
const EST_WATCH = ["Total__c", "Subtotal__c", "Status__c"];

const plan = { jobs: [], estimates: [] };
const review = [];
const rows = [];
const counts = {};
const bump = (k, n = 1) => (counts[k] = (counts[k] || 0) + n);

// ---------------------------------------------------------------- jobs
if (!ONLY || ONLY === "jobs") {
  const sfJobs = await sfQuery(`SELECT ${JOB_SELECT} FROM ${JOB} WHERE Client__c = '${T}' AND ${HCP_ID_FIELD} != null ORDER BY CreatedDate`);
  console.log(`  ${sfJobs.length} imported jobs in Salesforce`);
  for (const sf of sfJobs) {
    const hcp = byHcpId.get(s(sf[HCP_ID_FIELD]));
    if (!hcp) {
      bump("jobs:not-in-pull");
      continue;
    }
    const fields = planJobFix(sf, hcp);
    const bill = describeBillTo(hcp);
    review.push(csvLine([sf.Name, s(hcp.invoice_number) || hcp.id, s(hcp.description), bill.rule, fields?.Bill_To_Type__c ?? sf.Bill_To_Type__c, fields?.Bill_To_Name__c ?? sf.Bill_To_Name__c, fields?.Service_Type__c ?? sf.Service_Type__c, fields?.Bill_To_Type__c || fields?.Bill_To_Name__c || fields?.Service_Type__c ? "planned" : bill.rule === "blank" ? "blank title" : "kept (office set it)"]));
    if (!fields) {
      bump("jobs:nothing-to-do");
      continue;
    }
    for (const k of Object.keys(fields)) {
      bump(`jobs:field:${k}`);
      rows.push(csvLine([JOB, sf.Id, sf.Name, k, show(sf[k]), show(fields[k])]));
    }
    plan.jobs.push({ sf, fields });
    if (LIMIT && plan.jobs.length >= LIMIT) break;
  }
}

// ---------------------------------------------------------------- estimates
if (!ONLY || ONLY === "estimates") {
  const sfEsts = await sfQuery(`SELECT ${EST_SELECT} FROM ${EST} WHERE Client__c = '${T}' AND ${HCP_ID_FIELD} != null ORDER BY CreatedDate`);
  console.log(`  ${sfEsts.length} imported estimates in Salesforce`);
  // Lines for the estimates that carry tax (the only ones that need a rate), in chunks of 200 ids.
  const needLines = sfEsts.filter((e) => e.Tax_Rate__c == null && Number(e.Tax_Amount__c) > 0);
  const linesByEst = new Map();
  for (let i = 0; i < needLines.length; i += 200) {
    const ids = needLines.slice(i, i + 200).map((e) => `'${e.Id}'`).join(",");
    for (const l of await sfQuery(`SELECT Estimate__c, Taxable__c, Line_Total__c, Quantity__c, Unit_Price__c, Stage__c FROM ${LINE} WHERE Estimate__c IN (${ids})`)) {
      if (!linesByEst.has(l.Estimate__c)) linesByEst.set(l.Estimate__c, []);
      linesByEst.get(l.Estimate__c).push(l);
    }
  }
  console.log(`  ${needLines.length} of them carry tax with no rate`);
  for (const sf of sfEsts) {
    // A job's estimate is `job:<hcp id>:estimate`; its city is on the HCP job's tax line.
    const m = s(sf[HCP_ID_FIELD]).match(/^job:(.+):estimate$/);
    const jurisdiction = m ? taxJurisdictionOf(await hcpLineItems(m[1])) : null;
    const r = planEstimateFix(sf, linesByEst.get(sf.Id) || [], { jurisdiction, fallbackRate: FALLBACK_RATE });
    if (!r) {
      bump("estimates:nothing-to-do");
      continue;
    }
    if (r.note) {
      bump(`estimates:${r.note}`);
      rows.push(csvLine([EST, sf.Id, sf.Name, "(note)", show(sf.Tax_Amount__c), r.note]));
    }
    if (!r.fields) continue;
    for (const k of Object.keys(r.fields)) {
      bump(`estimates:field:${k}`);
      rows.push(csvLine([EST, sf.Id, sf.Name, k, show(sf[k]), show(r.fields[k])]));
    }
    plan.estimates.push({ sf, fields: r.fields });
    if (LIMIT && plan.estimates.length >= LIMIT) break;
  }
}

// ---------------------------------------------------------------- files + summary
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, "bill-to-review.csv"), [csvLine(["Job", "HCP #", "HCP title", "rule", "Bill_To_Type__c", "Bill_To_Name__c", "Service_Type__c", "action"]), ...review].join("\r\n") + "\r\n");
await fs.writeFile(path.join(OUT, "backfill-plan.csv"), [csvLine(["object", "Id", "Name", "field", "from", "to"]), ...rows].join("\r\n") + "\r\n");
console.log("\nSUMMARY");
for (const k of Object.keys(counts).sort()) console.log(`  ${k.padEnd(52)} ${counts[k]}`);
console.log(`\n  ${plan.jobs.length} job(s) and ${plan.estimates.length} estimate(s) to write`);
console.log(`  review:  ${path.join(OUT, "bill-to-review.csv")}`);
console.log(`  plan:    ${path.join(OUT, "backfill-plan.csv")}`);
if (!APPLY) {
  console.log("\n  DRY RUN — nothing written. Re-run with --apply to write through the API.\n");
  process.exit(0);
}

// ---------------------------------------------------------------- apply, canary first
async function applyAll(label, object, items, select, watch) {
  if (!items.length) return;
  const readOne = async (id) => (await sfQuery(`SELECT ${select} FROM ${object} WHERE Id = '${id}'`))[0];
  const first = items[0];
  console.log(`\n  CANARY — ${object} ${first.sf.Id} (${first.sf.Name}) alone first: ${Object.keys(first.fields).join(", ")}`);
  const pre = await readOne(first.sf.Id);
  await sfUpdateRecord(object, first.sf.Id, first.fields);
  const post = await readOne(first.sf.Id);
  for (const f of Object.keys(first.fields)) {
    const ok = s(post?.[f]) === s(first.fields[f]);
    console.log(`     ${f.padEnd(24)} ${show(pre?.[f]).padEnd(30)} -> ${show(post?.[f])}${ok ? "" : "   ** DID NOT LAND **"}`);
    if (!ok) {
      console.log("\n  ** The canary write did not land. STOPPING. **\n");
      process.exit(1);
    }
  }
  const reacted = watch.filter((f) => s(pre?.[f]) !== s(post?.[f]));
  if (reacted.length) {
    console.log(`\n  ** AUTOMATION DETECTED — ${reacted.join(", ")} changed on the canary and this script did not write it. STOPPING after one record. **\n     The canary HAS been written. Deactivate the Flow on ${object}, then re-run.\n`);
    process.exit(1);
  }
  console.log(`     -> nothing else moved. Proceeding in batches of ${BATCH}.`);
  let written = 1;
  const failures = [];
  const rest = items.slice(1);
  for (let i = 0; i < rest.length; i += BATCH) {
    const chunk = rest.slice(i, i + BATCH);
    try {
      const res = await sfUpsertMany(object, "Id", chunk.map((it) => ({ Id: it.sf.Id, ...it.fields })));
      res.forEach((r, k) => {
        if (r.success) written++;
        else failures.push({ id: chunk[k].sf.Id, name: chunk[k].sf.Name, error: JSON.stringify(r.errors).slice(0, 200) });
      });
    } catch (e) {
      for (const it of chunk) failures.push({ id: it.sf.Id, name: it.sf.Name, error: String(e.sfBody ?? e.message).slice(0, 200) });
    }
    process.stdout.write(`\r     ${label}: ${written} written, ${failures.length} failed  (${Math.min(i + BATCH, rest.length) + 1}/${items.length})   `);
    await sleep(150);
  }
  process.stdout.write("\n");
  if (failures.length) {
    console.log(`\n  ** ${failures.length} ${label} WRITE FAILURE(S) ** (re-run: it plans only what is still wrong)`);
    for (const f of failures.slice(0, 20)) console.log(`     ${f.id} ${f.name}: ${f.error}`);
    if (failures.length > 20) console.log(`     ... and ${failures.length - 20} more`);
    process.exitCode = 1;
  }
}
await applyAll("jobs", JOB, plan.jobs, JOB_SELECT, JOB_WATCH);
await applyAll("estimates", EST, plan.estimates, EST_SELECT, EST_WATCH);
console.log(`\n  Done. Next: cache-sync { "object": "job", "mode": "full" } and { "object": "estimate", "mode": "full" }, then reload the Service pages.\n`);
