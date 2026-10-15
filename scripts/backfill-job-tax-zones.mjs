// Backfill the tax zone on open Service jobs created before D-083 (2026-10-15).
//
// Every OPEN job (Status__c not Closed / Cancelled / Paid) whose Tax_Zone_Code__c is blank:
// the service address's city (the job's Address_at_Creation__c, read from the end; else the
// customer's City__c) goes through the SAME resolver the job create uses (lib/tax-zones.js).
// EXACT MATCHES ONLY are written (a city, or an alias like Sun City → Maricopa County);
// everything else is listed for the office to pick on the job page. Never a guess.
//
//   node scripts/backfill-job-tax-zones.mjs                 # DRY RUN (default): counts + the unmatched list
//   node scripts/backfill-job-tax-zones.mjs --apply         # write the exact matches (canary first)
//   node scripts/backfill-job-tax-zones.mjs --tenant harmon # default: the primary tenant
//
// Writes ONLY Tax_Zone_Code__c and Tax_Zone_Label__c on Sundial_Service_Job__c. CANARY FIRST
// (CLAUDE.md, bulk data fixes): one job is written and re-read, and the run aborts if any
// field it did not write has changed. Idempotent: a re-run only sees jobs still blank.
// The unmatched list is also saved to _delivery/acumatica-tax/backfill-unmatched.csv
// (git-ignored — it holds customer names).
//
// The jobs' estimates are not re-saved here: every read and the invoice issue compute the tax
// from the zone live; the stored Tax_Amount__c on an estimate catches up on its next edit.
//
// Prerequisites: the D-083 Setup fields exist, sql/sundial_tax_zones.sql is run and
// scripts/seed-tax-zones.mjs --apply has loaded the tables.
//
// ⚠️ Do not pipe the output through head / tail on an --apply run: a partial failure must be
// seen (the script prints each failure and exits 1).

import fs from "node:fs";
import path from "node:path";
import { sfQuery, sfUpdateRecord, soqlEscapeString } from "../lib/salesforce.js";
import { getSupabaseClient } from "../lib/supabase.js";
import { loadTaxTables, planJobZones, CLOSED_JOB_STATUSES } from "../lib/tax-zones.js";
import { primaryTenantSlug } from "../lib/tenant-guard.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const tenantArg = args.includes("--tenant") ? args[args.indexOf("--tenant") + 1] : null;
const slug = tenantArg || primaryTenantSlug();
const JOB = "Sundial_Service_Job__c";
// The fields the canary watches: anything a Flow or trigger reacting to the write might move.
const WATCHED = ["Status__c", "Bill_To_Type__c", "Bill_To_Customer__c", "Estimate__c", "Sundial_Customer__c", "Address_at_Creation__c", "Payment_Status__c", "Priority__c", "Assigned_To__c"];

const tenantRows = await sfQuery(`SELECT Id, Name FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(slug)}' LIMIT 1`);
const tenantId = tenantRows?.[0]?.Id;
if (!tenantId) {
  console.error(`No Sundial_Tenant__c named "${slug}".`);
  process.exit(1);
}
const tables = await loadTaxTables(slug, { getSupabaseClient });
if (!tables || !tables.zones.size) {
  console.error(`The tax tables for "${slug}" are empty — run sql/sundial_tax_zones.sql and scripts/seed-tax-zones.mjs --apply first.`);
  process.exit(1);
}

const closed = CLOSED_JOB_STATUSES.map((s) => `'${soqlEscapeString(s)}'`).join(", ");
const jobs = await sfQuery(
  `SELECT Id, Name, Status__c, Tax_Zone_Code__c, Address_at_Creation__c, Customer_Name_at_Creation__c, Sundial_Customer__r.City__c ` +
    `FROM ${JOB} WHERE Client__c = '${soqlEscapeString(tenantId)}' AND Status__c NOT IN (${closed}) AND Tax_Zone_Code__c = null ORDER BY Name`
);
const plan = planJobZones(jobs, tables);

console.log(`Tenant ${slug}: ${jobs.length} open job(s) with no tax zone.`);
console.log(`  exact matches (would be written): ${plan.matched.length}`);
const byZone = {};
for (const m of plan.matched) byZone[`${m.zoneCode} ${m.label}`] = (byZone[`${m.zoneCode} ${m.label}`] || 0) + 1;
for (const [z, n] of Object.entries(byZone).sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)}  ${z}`);
const viaAlias = plan.matched.filter((m) => m.via === "alias").length;
const fromCustomer = plan.matched.filter((m) => m.source === "customer city").length;
if (viaAlias) console.log(`     (${viaAlias} through an alias; ${fromCustomer} from the customer's city because the job's address had none)`);
console.log(`  unmatched (the office picks the zone on the job page): ${plan.unmatched.length}`);
for (const u of plan.unmatched) console.log(`     ${String(u.number ?? u.id).padEnd(12)} ${String(u.customer ?? "").slice(0, 32).padEnd(32)} ${u.city ? `"${u.city}"` : "(no city)"}  ${u.reason}`);

const csvDir = path.resolve("_delivery/acumatica-tax");
fs.mkdirSync(csvDir, { recursive: true });
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
fs.writeFileSync(path.join(csvDir, "backfill-unmatched.csv"), ["job,customer,city,source,reason,jobId", ...plan.unmatched.map((u) => [u.number, u.customer, u.city, u.source, u.reason, u.id].map(q).join(","))].join("\n"));
console.log(`  unmatched list saved: ${path.join(csvDir, "backfill-unmatched.csv")}`);

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply to write the exact matches.");
  process.exit(0);
}
if (!plan.matched.length) {
  console.log("\nNothing to write.");
  process.exit(0);
}

const readWatched = async (id) => (await sfQuery(`SELECT Id, Tax_Zone_Code__c, Tax_Zone_Label__c, ${WATCHED.join(", ")} FROM ${JOB} WHERE Id = '${soqlEscapeString(id)}' LIMIT 1`))?.[0];
const fieldsFor = (m) => ({ Tax_Zone_Code__c: m.zoneCode, Tax_Zone_Label__c: m.label });

// --- canary ---------------------------------------------------------------------------------
const [canary, ...rest] = plan.matched;
const before = await readWatched(canary.id);
await sfUpdateRecord(JOB, canary.id, fieldsFor(canary));
const after = await readWatched(canary.id);
const moved = WATCHED.filter((f) => JSON.stringify(before?.[f] ?? null) !== JSON.stringify(after?.[f] ?? null));
if (after?.Tax_Zone_Code__c !== canary.zoneCode || moved.length) {
  console.error(`\nCANARY FAILED on ${canary.number} (${canary.id}): ${moved.length ? `fields it did not write changed: ${moved.join(", ")}` : "the zone did not stick"}. Aborting — nothing else written.`);
  process.exit(1);
}
console.log(`\ncanary ok: ${canary.number} → ${canary.zoneCode} (${canary.label}); no other field moved.`);

// --- the rest ---------------------------------------------------------------------------------
let written = 1;
const failures = [];
for (const m of rest) {
  try {
    await sfUpdateRecord(JOB, m.id, fieldsFor(m));
    written += 1;
  } catch (e) {
    failures.push({ m, error: e?.sfBody ? JSON.stringify(e.sfBody) : e?.message || String(e) });
  }
}
console.log(`written: ${written} of ${plan.matched.length}`);
for (const f of failures) console.error(`  FAILED ${f.m.number} (${f.m.id}): ${f.error}`);
if (failures.length) {
  console.error("Re-run the script: it only picks up jobs still blank.");
  process.exit(1);
}
