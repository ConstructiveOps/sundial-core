// lib/bill-to-backfill.js — match a job's typed Bill To name to a company customer (D-081), pure.
//
// Before D-081 a partner job named its payer as text (Bill_To_Name__c — typed by the office or
// read off the HCP title by lib/hcp-bill-to.js). D-081 makes the payer a record
// (Bill_To_Customer__c). scripts/backfill-bill-to-customers.mjs feeds this the tenant's
// candidate jobs and its company customers; this decides, per job, the one company whose
// Company_Name__c equals the typed name (trimmed, case-insensitive) — or why not:
//   matched     exactly one company → write Bill_To_Customer__c (the lookup ONLY)
//   unmatched   no company by that name → the list Tim uses to create the missing companies
//   ambiguous   two or more companies share the name → never a guess; reported
// Issued invoices are never touched: they keep the name they were issued with.

const norm = (v) => (v == null ? "" : String(v).trim().replace(/\s+/g, " ").toLowerCase());

/** The jobs this backfill is for: a partner type, a typed name, no payer record yet. */
export function needsPayer(job) {
  const type = String(job?.Bill_To_Type__c ?? "").trim();
  return !!type && type !== "Customer" && norm(job.Bill_To_Name__c) !== "" && !job.Bill_To_Customer__c;
}

/** normalized company name → [company records] (only rows ticked Is_Company__c with a name). */
export function companyIndex(companies) {
  const idx = new Map();
  for (const c of companies || []) {
    if (c?.Is_Company__c !== true) continue;
    const k = norm(c.Company_Name__c);
    if (!k) continue;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(c);
  }
  return idx;
}

/**
 * Plan the backfill.
 * @returns {{ writes: Array<{job, company}>, byName: Array<{name, outcome, jobs:number, companyId?:string, companyIds?:string[]}> }}
 *   byName is one row per distinct typed name, most jobs first — what the dry run prints.
 */
export function planBillToBackfill(jobs, companies) {
  const idx = companyIndex(companies);
  const writes = [];
  const names = new Map();
  for (const job of jobs || []) {
    if (!needsPayer(job)) continue;
    const k = norm(job.Bill_To_Name__c);
    const hits = idx.get(k) || [];
    const outcome = hits.length === 1 ? "matched" : hits.length > 1 ? "ambiguous" : "unmatched";
    if (outcome === "matched") writes.push({ job, company: hits[0] });
    const row = names.get(k) || { name: String(job.Bill_To_Name__c).trim(), outcome, jobs: 0 };
    row.jobs++;
    if (outcome === "matched") row.companyId = hits[0].Id;
    if (outcome === "ambiguous") row.companyIds = hits.map((h) => h.Id);
    names.set(k, row);
  }
  const byName = [...names.values()].sort((a, b) => b.jobs - a.jobs || a.name.localeCompare(b.name));
  return { writes, byName };
}
