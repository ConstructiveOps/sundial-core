// scripts/hcp-import.mjs — Housecall Pro → Sundial Service (2026-09-25, docs/migration.md).
// Reads the pull in migration/hcp/raw/ (scripts/hcp-pull.mjs) and upserts it into Salesforce
// on HCP_Id__c: customers (+ leads), estimates, lines, jobs, calls, invoices, payments.
//
//   node scripts/hcp-import.mjs --tenant harmon                 # DRY RUN: the plan, review.csv, the tech-map template — no writes
//   node scripts/hcp-import.mjs --tenant harmon --apply         # write it (canary first, then batches of 200)
//   node scripts/hcp-import.mjs --tenant harmon --apply --limit 25      # a trial: the first 25 customers' worth
//   node scripts/hcp-import.mjs --tenant harmon --apply --only customers,leads
//   --in migration/hcp   --out migration/hcp/import   --tech-map migration/hcp/tech-map.json
//   --stale-days 90      the abandonment cutoff for Archived__c (lib/hcp-disposition.js)
//   --keep-leads         do NOT archive every job-less customer (Harmon's clean-pipeline ask, 2026-10-02, is the default)
//
// What is ACTIVE (2026-10-02, after Harmon's "too many records" feedback): the import stamps
// Archived__c on customers / jobs / estimates from HCP's signals, gives an open lead its real
// stage, closes a won / lost one, blanks the "New" the first import left, and writes
// stale-jobs.csv (what it archived as abandoned) + picklist-gaps.csv (values the org lacks —
// Tim adds them in Setup, re-run) in the dry run. Rules in lib/hcp-disposition.js.
//
// Re-runnable by design — that is the go-live delta: run the pull again, run this again.
//   • a customer already carrying HCP_Id__c is found by it alone; one the import CREATED is
//     refreshed from HCP; one it LINKED to an existing Sundial customer (prior solar / roofing
//     work, matched by exact email else street+zip) only has its blanks filled — Sales owns it
//   • every child (estimate, line, job, call, invoice, payment) upserts on its own HCP_Id__c
//   • ambiguity is never guessed: created new + a line in review.csv
//
// Canary rule (CLAUDE.md): with --apply, the first record of every object is written ALONE,
// read back, and — for an update of an existing customer — its untouched fields compared; a
// difference aborts before the batches start.
//
// Never run this against anything but the tenant named on the command line; every row is
// stamped Client__c = that tenant. Reads only what the pull left on disk; no HCP calls.

import { promises as fs } from "node:fs";
import path from "node:path";
import { sfQuery, sfUpsertMany, describeObject, soqlEscapeString } from "../lib/salesforce.js";
import {
  HCP_ID_FIELD, writable, callKey, indexExisting, decideCustomer, customerFields, leadFields, lineFields, estimateFields, jobEstimateFields,
  invoiceState, jobFields, callFields, callStatusFor, invoiceFields, paymentFields, pickOption, estimateStatus, techResolver, personName, normalizeEmail, addressLine,
} from "../lib/hcp-import.js";
import { matchPicklist, unionProjectTypes } from "../lambdas/sundial-service-estimate/customer.js";
import { toCsv } from "../lib/hcp-api.js";
import { DEFAULT_STALE_DAYS, claimedEstimates, customerDisposition, estimateDisposition, jobDisposition, leadConversions } from "../lib/hcp-disposition.js";

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const TENANT = opt("--tenant");
const APPLY = flag("--apply");
const LIMIT = Number(opt("--limit", 0)) || 0;
const ONLY = (opt("--only", "") || "").split(",").map((x) => x.trim()).filter(Boolean);
const IN = path.resolve(opt("--in", path.join("migration", "hcp")));
const OUT = path.resolve(opt("--out", path.join(IN, "import")));
const TECH_MAP = path.resolve(opt("--tech-map", path.join(IN, "tech-map.json")));
const STALE_DAYS = Number(opt("--stale-days", DEFAULT_STALE_DAYS)) || DEFAULT_STALE_DAYS;
const CLEAN_LEAD_PIPELINE = !flag("--keep-leads");
const NOW = new Date();
if (!TENANT) {
  console.error("usage: node scripts/hcp-import.mjs --tenant <slug> [--apply] [--limit N] [--only customers,leads,estimates,jobs]");
  process.exit(2);
}
const PHASES = ["customers", "leads", "estimates", "jobs"].filter((p) => ONLY.length === 0 || ONLY.includes(p));
const BATCH = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s = (v) => (v == null ? "" : String(v).trim());

const OBJ = {
  customer: "Sundial_Customer__c",
  estimate: "Sundial_Estimate__c",
  line: "Sundial_Service_Line__c",
  job: "Sundial_Service_Job__c",
  call: "Sundial_Service_Call__c",
  invoice: "Sundial_Service_Invoice__c",
  payment: "Sundial_Service_Payment__c",
  user: "Sundial_User__c",
  item: "Sundial_Price_Book_Item__c",
  tenant: "Sundial_Tenant__c",
};

// ---------------------------------------------------------------- files
async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}
async function readDir(dir) {
  try {
    const out = [];
    for (const f of await fs.readdir(dir)) if (f.endsWith(".json")) out.push(await readJson(path.join(dir, f), null));
    return out.filter(Boolean);
  } catch {
    return [];
  }
}

const RAW = path.join(IN, "raw");
const customersHcp = await readJson(path.join(RAW, "customers.json"), []);
const leadsHcp = await readJson(path.join(RAW, "leads.json"), []);
const jobsHcp = await readJson(path.join(RAW, "jobs.json"), []);
const estimatesHcp = await readJson(path.join(RAW, "estimates.json"), []);
const invoicesHcp = await readJson(path.join(RAW, "invoices.json"), []);
const employees = await readJson(path.join(RAW, "employees.json"), []);
const jobTypes = new Map((await readJson(path.join(RAW, "job_types.json"), [])).map((jt) => [s(jt.id), s(jt.name)]));
const jobDetail = new Map((await readDir(path.join(RAW, "jobs"))).map((f) => [s(f.job?.id), f]));
const estDetail = new Map((await readDir(path.join(RAW, "estimates"))).map((f) => [s(f.estimate?.id), f]));
if (!customersHcp.length || !jobsHcp.length) {
  console.error(`Nothing to import in ${RAW} — run scripts/hcp-pull.mjs first.`);
  process.exit(2);
}
const techMap = await readJson(TECH_MAP, {});
const idMap = await readJson(path.join(OUT, "id-map.json"), { customers: {}, estimates: {}, lines: {}, jobs: {}, calls: {}, invoices: {}, payments: {} });
const review = [];
/** A review row: `needs_action` = a person must merge / decide; otherwise it is a note. */
const reviewRow = (row) => ({ needs_action: /created new|merge by hand|skipped/.test(row.decision) ? "YES" : "no", ...row });
const errors = [];
const counts = {};
const bump = (k, n = 1) => (counts[k] = (counts[k] || 0) + n);
/** Picklist values the org lacks (field → value → count): picklist-gaps.csv, for Tim to add in Setup. */
const gaps = new Map();
const onGap = (field, value) => {
  const k = `${field}\u0000${value}`;
  gaps.set(k, (gaps.get(k) || 0) + 1);
};

// ---------------------------------------------------------------- Salesforce references
console.log(`HCP import → tenant "${TENANT}" ${APPLY ? "(APPLY)" : "(dry run)"}${LIMIT ? ` limit ${LIMIT}` : ""}\n  phases: ${PHASES.join(", ")}`);
const tenantRows = await sfQuery(`SELECT Id FROM ${OBJ.tenant} WHERE Name = '${soqlEscapeString(TENANT)}' LIMIT 1`);
const tenantId = tenantRows[0]?.Id;
if (!tenantId) {
  console.error(`No ${OBJ.tenant} named "${TENANT}".`);
  process.exit(2);
}
const users = await sfQuery(`SELECT Id, First_Name__c, Last_Name__c, Email__c FROM ${OBJ.user} WHERE Client__c = '${tenantId}'`);
const items = await sfQuery(`SELECT Id, ${HCP_ID_FIELD}, Kind__c, Is_Active__c FROM ${OBJ.item} WHERE Client__c = '${tenantId}' AND ${HCP_ID_FIELD} != null`);
const itemsByHcpId = new Map();
for (const it of items) if (!itemsByHcpId.has(it[HCP_ID_FIELD]) || it.Is_Active__c) itemsByHcpId.set(it[HCP_ID_FIELD], it);
const customerDescribe = await describeObject(OBJ.customer);
const picklist = (name) => (customerDescribe?.fields || []).find((f) => f.name === name)?.picklistValues?.filter((v) => v.active !== false) || null;
const leadSources = picklist("Lead_Source__c");
const states = picklist("State__c");
const pickState = (v) => (states ? matchPicklist(v, states) : v || null);
const hasHcpField = (customerDescribe?.fields || []).some((f) => f.name === HCP_ID_FIELD);
if (!hasHcpField) {
  console.error(`${OBJ.customer} has no ${HCP_ID_FIELD} yet — deploy salesforce/hcp-migration-2026-09-25/ first.`);
  process.exit(2);
}
const stageValues = picklist("Service_Stage__c");
const resolutionValues = picklist("Service_Resolution__c");
const requestTypeValues = picklist("Service_Request_Type__c");
// The archive flag is the point of the re-run: every object must carry it before anything is written.
for (const sfObject of [OBJ.customer, OBJ.estimate, OBJ.job]) {
  const meta = sfObject === OBJ.customer ? customerDescribe : await describeObject(sfObject);
  if (!(meta?.fields || []).some((f) => f.name === "Archived__c")) {
    console.error(`${sfObject} has no Archived__c yet — add the checkbox in Setup (docs/migration.md → "What is active") and give the integration user read/edit on it.`);
    process.exit(2);
  }
}
const CUSTOMER_SELECT = `Id, Name, First_Name__c, Last_Name__c, Street__c, City__c, State__c, Postal_Code__c, Primary_Email__c, Primary_Phone__c, Customer_Type__c, Requested_Project_Types__c, Status__c, Service_Stage__c, Lead_Source__c, ${HCP_ID_FIELD}`;
const existing = await sfQuery(`SELECT ${CUSTOMER_SELECT} FROM ${OBJ.customer} WHERE Client__c = '${tenantId}'`);
const existingById = new Map(existing.map((r) => [r.Id, r]));
const index = indexExisting(existing);
const resolveTech = techResolver({ employees, users, map: techMap });
console.log(`  Salesforce: ${existing.length} customers, ${users.length} users, ${items.length} price-book items with an HCP id`);
console.log(`  HCP: ${customersHcp.length} customers, ${leadsHcp.length} leads, ${estimatesHcp.length} estimates, ${jobsHcp.length} jobs, ${invoicesHcp.length} invoices`);

// ---------------------------------------------------------------- the tech-map template (every dry run)
// HCP knows a tech by whatever email they signed up with; Sundial by their work login. When
// the emails differ, a same-name Sundial user is SUGGESTED (never assumed): the suggestions
// land in tech-map.suggested.json, and renaming that file to tech-map.json after a look is
// the whole job. A tech with no Sundial user at all (left the company) stays name-only.
{
  const norm = (v) => s(v).toLowerCase().replace(/[^a-z]/g, "");
  const byName = new Map();
  for (const u of users) {
    const k = norm(`${u.First_Name__c} ${u.Last_Name__c}`);
    if (!k) continue;
    byName.set(k, byName.has(k) ? null : u); // null = ambiguous (two users with that name)
  }
  const suggested = {};
  const rows = employees.map((e) => {
    const r = resolveTech(e.id);
    const guess = r.sfId ? null : byName.get(norm(`${e.first_name} ${e.last_name}`)) || null;
    if (guess) suggested[s(e.email) || s(e.id)] = guess.Email__c || guess.Id;
    return {
      hcp_employee_id: s(e.id), name: personName(e), hcp_email: s(e.email), role: s(e.role),
      sundial_user_id: r.sfId || "", matched: r.sfId ? "yes" : guess ? `SUGGESTED by name → ${guess.Email__c || guess.Id}` : "NO Sundial user — name-only on the calls unless you map one",
    };
  });
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, "tech-map.template.csv"), toCsv(rows));
  const missing = rows.filter((r) => !r.sundial_user_id);
  if (missing.length) {
    console.log(`  techs without a Sundial user by email (${missing.length}): ${missing.map((r) => r.name).join(", ")}`);
    if (Object.keys(suggested).length) {
      const merged = { ...suggested, ...techMap }; // what you already mapped wins
      await writeJson(path.join(OUT, "tech-map.suggested.json"), merged);
      console.log(`  ${Object.keys(suggested).length} of them have a same-name Sundial user → ${path.join(OUT, "tech-map.suggested.json")} (check it, then copy to ${TECH_MAP})`);
    }
    console.log(`  the rest stay name-only in the call's private notes, or map them in ${TECH_MAP} as { "<hcp email or id>": "<Sundial user email or id>" }`);
  }
}

// ---------------------------------------------------------------- writing (upsert in batches, canary first)
async function upsertAll(kind, sfObject, records, { verify, keyField = HCP_ID_FIELD } = {}) {
  const results = new Map(); // HCP id → sf id
  if (!records.length) return results;
  records = records.map((r) => writable(sfObject, r)); // formulas are Salesforce's to fill
  if (!APPLY) {
    bump(`${kind}:planned`, records.length);
    return results;
  }
  const first = records[0];
  const [canary] = await sfUpsertMany(sfObject, keyField, [first]);
  const keyOf = (r) => r[HCP_ID_FIELD] ?? r[keyField];
  if (!canary.success) throw new Error(`canary ${sfObject} ${keyOf(first)} failed: ${JSON.stringify(canary.errors)}`);
  results.set(keyOf(first), canary.id);
  if (verify) await verify(first, canary.id);
  bump(`${kind}:${canary.created ? "created" : "updated"}`);
  for (let i = 1; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const res = await sfUpsertMany(sfObject, keyField, chunk);
    res.forEach((r, j) => {
      const rec = chunk[j];
      if (r.success) {
        results.set(keyOf(rec), r.id);
        bump(`${kind}:${r.created ? "created" : "updated"}`);
      } else {
        bump(`${kind}:failed`);
        errors.push({ phase: kind, object: sfObject, hcp_id: keyOf(rec), error: r.errors.map((e) => `${e.statusCode}: ${e.message}${e.fields?.length ? ` [${e.fields.join(",")}]` : ""}`).join(" | ") });
      }
    });
    process.stdout.write(`\r  ${kind}: ${Math.min(i + BATCH, records.length)}/${records.length}   `);
    await sleep(150);
  }
  process.stdout.write("\n");
  return results;
}

/** The canary check for a customer update: nothing we did not write may have moved. */
async function verifyCustomer(written, sfId) {
  const before = existingById.get(sfId);
  const [after] = await sfQuery(`SELECT ${CUSTOMER_SELECT} FROM ${OBJ.customer} WHERE Id = '${sfId}'`);
  if (!after) throw new Error(`canary: ${sfId} not readable after the write`);
  if (s(after[HCP_ID_FIELD]) !== s(written[HCP_ID_FIELD])) throw new Error(`canary: ${HCP_ID_FIELD} did not land on ${sfId}`);
  if (before) {
    for (const k of Object.keys(before)) {
      if (k === "attributes" || k in written) continue;
      if (s(before[k]) !== s(after[k])) throw new Error(`canary: ${OBJ.customer}.${k} changed on ${sfId} (${s(before[k])} → ${s(after[k])}) — a field the import did not write. Aborting.`);
    }
  }
  console.log(`  canary ok: ${OBJ.customer} ${sfId}`);
}

// ---------------------------------------------------------------- what is active (lib/hcp-disposition.js)
const invoicesByJob = new Map();
for (const i of invoicesHcp) {
  const jid = s(i.job_id);
  if (!invoicesByJob.has(jid)) invoicesByJob.set(jid, []);
  invoicesByJob.get(jid).push(i);
}
const claimed = claimedEstimates(jobsHcp, estimatesHcp); // HCP estimate id → the job it became
const jobDisp = new Map(); // HCP job id → { archived, reason, stale }
for (const j of jobsHcp) jobDisp.set(s(j.id), jobDisposition(j, { st: invoiceState(invoicesByJob.get(s(j.id)) || []), now: NOW, staleDays: STALE_DAYS }));
const estDisp = new Map(); // HCP estimate id → { archived, reason }
for (const e of estimatesHcp) estDisp.set(s(e.id), estimateDisposition(e, { convertedTo: claimed.get(s(e.id)) || null, status: estimateStatus(e, pickOption(e)), now: NOW, staleDays: STALE_DAYS }));
const jobsByCustomer = new Map();
for (const j of jobsHcp) {
  const cid = s(j.customer?.id);
  if (!jobsByCustomer.has(cid)) jobsByCustomer.set(cid, []);
  jobsByCustomer.get(cid).push(j);
}
const leadsByCustomer = new Map();
for (const l of leadsHcp) {
  const cid = s(l.customer?.id);
  if (!leadsByCustomer.has(cid)) leadsByCustomer.set(cid, []);
  leadsByCustomer.get(cid).push(l);
}
const estimatesByCustomer = new Map();
for (const e of estimatesHcp) {
  const cid = s(e.customer?.id);
  if (!estimatesByCustomer.has(cid)) estimatesByCustomer.set(cid, []);
  estimatesByCustomer.get(cid).push(e);
}
const hasOpenLead = (cid) => (leadsByCustomer.get(cid) || []).some((l) => s(l.status).toLowerCase() === "open" && !s(l.lost_at));
const dispositionFor = (c) => {
  const cid = s(c.id);
  return customerDisposition(c, {
    leads: leadsByCustomer.get(cid) || [],
    jobs: (jobsByCustomer.get(cid) || []).map((job) => ({ job, disposition: jobDisp.get(s(job.id)) })),
    estimates: (estimatesByCustomer.get(cid) || []).map((est) => ({ est, disposition: estDisp.get(s(est.id)) })),
    now: NOW,
    staleDays: STALE_DAYS,
    cleanLeadPipeline: CLEAN_LEAD_PIPELINE,
  });
};
const jobsById = new Map(jobsHcp.map((j) => [s(j.id), j]));
const estimatesById = new Map(estimatesHcp.map((e) => [s(e.id), e]));
{
  const n = (m) => [...m.values()].filter((d) => d.archived).length;
  console.log(`  active (cutoff ${STALE_DAYS} days): jobs ${jobsHcp.length - n(jobDisp)} of ${jobsHcp.length} stay visible (${[...jobDisp.values()].filter((d) => d.stale).length} archived as abandoned → stale-jobs.csv), estimates ${estimatesHcp.length - n(estDisp)} of ${estimatesHcp.length}, HCP estimates converted to a job: ${claimed.size}`);
}

// ---------------------------------------------------------------- customers
// every HCP customer, plus the ones only embedded on a job / estimate / lead
const customerPool = new Map(customersHcp.map((c) => [s(c.id), c]));
for (const rec of [...jobsHcp, ...estimatesHcp, ...leadsHcp]) {
  const c = rec.customer;
  if (c?.id && !customerPool.has(s(c.id))) customerPool.set(s(c.id), { ...c, addresses: c.addresses?.length ? c.addresses : rec.address ? [{ type: "service", ...rec.address }] : [] });
}
let customerList = [...customerPool.values()];
if (LIMIT) customerList = customerList.slice(0, LIMIT);
const limitedCustomerIds = new Set(customerList.map((c) => s(c.id)));

const customerSf = new Map(); // HCP customer id → Sundial id (known / linked now; created after the write)
const customerRecords = [];
// Every customer whose Salesforce id is already known (a link, or one seen on an earlier
// run) is written as an update BY SALESFORCE ID; only a brand-new customer is upserted by
// HCP id. A link stamps HCP_Id__c onto a record that does not carry one yet, so it could
// never be found by that id (2026-09-28: the first trial's four links came back "Required
// fields are missing: [Client__c]" — the upsert had tried to create a bare record instead).
const linkRecords = [];
const taken = new Set();
if (PHASES.includes("customers")) {
  for (const c of customerList) {
    const hcpId = s(c.id);
    const d = decideCustomer(c, index, taken);
    const hasJobs = (jobsByCustomer.get(hcpId) || []).length > 0;
    if (d.action === "known") {
      const rec = index.byHcp.get(hcpId);
      const created = idMap.customers[hcpId]?.created === true;
      customerSf.set(hcpId, rec.Id);
      taken.add(rec.Id); // a second HCP record for this household must not re-stamp it on a later run
      // by Salesforce id, like a link: we KNOW the record; an upsert by HCP id that somehow
      // misses would try to create a bare one (2026-09-28: two of 9,424 did exactly that)
      const disposition = created ? dispositionFor(c) : null; // a linked record is Sales's — never archived by the import
      const blankStage = created && s(rec.Service_Stage__c) === "New" && !hasOpenLead(hcpId); // the first import's "New" (2026-09-29)
      linkRecords.push({ Id: rec.Id, ...customerFields(c, { mode: created ? "refresh" : "fillBlanks", existing: rec, pickState, leadSources, hasJobs, tenantId, disposition, blankStage }) });
      bump(`customers:${created ? "refresh" : "known-linked"}`);
      if (disposition?.archived) bump(disposition.leadReset ? "customers:archived-lead-reset" : "customers:archived");
      if (blankStage) bump("customers:stage-New-cleared");
    } else if (d.action === "link") {
      customerSf.set(hcpId, d.sfId);
      if (d.shared) {
        // a second HCP record for one Sundial customer: the jobs land on it, HCP_Id__c stays with the first
        review.push(reviewRow({ hcp_customer_id: hcpId, name: personName(c), email: s(c.email), address: addressLine(c.addresses?.[0]), decision: `shares Sundial customer ${d.sfId} with another HCP customer — its jobs / estimates land there; HCP_Id__c not stamped`, sundial_id: d.sfId }));
        bump("customers:shared");
      } else {
        taken.add(d.sfId);
        linkRecords.push({ Id: d.sfId, ...customerFields(c, { mode: "fillBlanks", existing: existingById.get(d.sfId), pickState, leadSources, hasJobs, tenantId }) });
        idMap.customers[hcpId] = { sfId: d.sfId, created: false, by: d.by };
        bump(`customers:link-by-${d.by}`);
        if (d.review) review.push(reviewRow({ hcp_customer_id: hcpId, name: personName(c), email: s(c.email), address: addressLine(c.addresses?.[0]), decision: d.review, sundial_id: d.sfId }));
      }
    } else {
      const disposition = dispositionFor(c);
      customerRecords.push(customerFields(c, { mode: "create", pickState, leadSources, hasJobs, tenantId, disposition }));
      bump("customers:create");
      if (disposition.archived) bump(disposition.leadReset ? "customers:archived-lead-reset" : "customers:archived");
      if (d.review) review.push(reviewRow({ hcp_customer_id: hcpId, name: personName(c), email: s(c.email), address: addressLine(c.addresses?.[0]), decision: d.review, sundial_id: "" }));
    }
  }
  {
    // Sales's own Leads / Opportunities that HCP also knows (linked, never archived by the import): Tim decides those by hand
    const seen = new Set();
    let linkedPipeline = 0;
    for (const [hcpId, sfId] of customerSf) {
      if (seen.has(sfId) || idMap.customers[hcpId]?.created === true) continue;
      seen.add(sfId);
      if (/^(Lead|Opportunity)$/.test(s(existingById.get(sfId)?.Status__c))) linkedPipeline += 1;
    }
    if (linkedPipeline) {
      bump("customers:linked-lead-or-opportunity-left-alone", linkedPipeline);
      console.log(`  ${linkedPipeline} linked customer(s) are Sales's Lead / Opportunity — the import never archives a linked record; archive them by hand if the Service list should not show them`);
    }
  }
  console.log(`\ncustomers: ${customerRecords.length + linkRecords.length} to write (${Object.entries(counts).filter(([k]) => k.startsWith("customers:")).map(([k, v]) => `${k.slice(10)} ${v}`).join(", ")})`);
  const linked = await upsertAll("customers-by-id", OBJ.customer, linkRecords, { verify: verifyCustomer, keyField: "Id" });
  for (const [hcpId, sfId] of linked) customerSf.set(hcpId, sfId);
  const ids = await upsertAll("customers", OBJ.customer, customerRecords, { verify: verifyCustomer });
  for (const [hcpId, sfId] of ids) {
    customerSf.set(hcpId, sfId);
    if (!idMap.customers[hcpId]) idMap.customers[hcpId] = { sfId, created: true };
  }
} else {
  for (const [hcpId, v] of Object.entries(idMap.customers)) customerSf.set(hcpId, v.sfId);
  for (const [hcpId, rec] of index.byHcp) customerSf.set(hcpId, rec.Id);
}
const sfCustomerFor = (hcpCustomerId) => customerSf.get(s(hcpCustomerId)) || null;

// ---------------------------------------------------------------- leads
if (PHASES.includes("leads")) {
  const leadRecords = [];
  let list = leadsHcp;
  if (LIMIT) list = list.filter((l) => limitedCustomerIds.has(s(l.customer?.id)));
  for (const l of list) {
    const cid = s(l.customer?.id);
    const sfId = sfCustomerFor(cid);
    if (!sfId && APPLY) {
      review.push(reviewRow({ hcp_customer_id: cid, name: personName(l.customer), email: s(l.customer?.email), address: addressLine(l.address), decision: `lead #${s(l.number)} has no customer in Sundial — skipped`, sundial_id: "" }));
      bump("leads:skipped");
      continue;
    }
    const existingRec = sfId ? existingById.get(sfId) : null;
    const linkedNotCreated = existingRec && idMap.customers[cid]?.created !== true;
    const assigned = l.assigned_employee?.id ? resolveTech(l.assigned_employee.id).sfId : null;
    // a won lead resolves on the day its job / estimate was made in HCP
    const conv = leadConversions(l).map((x) => (x.type === "job" ? jobsById.get(x.id)?.created_at : estimatesById.get(x.id)?.created_at)).filter(Boolean).sort()[0] || null;
    const jobTypeName = jobTypes.get(s(l.job_fields?.job_type_uuid ?? l.job_fields?.job_type?.id)) || s(l.job_fields?.job_type?.name);
    // the archive line on Description__c only where the customers phase wrote the flag (created / refreshed, never a linked record)
    const disposition = existingRec && linkedNotCreated ? null : dispositionFor(customerPool.get(cid) || l.customer || { id: cid });
    const f = leadFields(l, { assignedToId: assigned, leadSources, stages: stageValues, resolutions: resolutionValues, requestTypes: requestTypeValues, jobTypeName, convertedAt: conv, onGap, disposition });
    // A linked customer is Sales's: a stage set there stays (unless it is the import's own
    // "New"), and the outcome fields go with it. A customer the import created takes HCP's
    // state on every run — that is how the 09-28 run's "Estimate Created" on a won lead becomes
    // Resolved now (2026-10-02); the office starts working these records after this run.
    const officeStage = s(existingRec?.Service_Stage__c);
    if (linkedNotCreated && officeStage && officeStage !== "New") {
      delete f.Service_Stage__c;
      delete f.Service_Resolution__c;
      delete f.Service_Resolved_Date__c;
      delete f.Call_Attempts__c;
      bump("leads:stage-kept");
    }
    if (existingRec) {
      // Solar stays Solar: the type is unioned, never replaced (the customers phase did the same)
      const ct = unionProjectTypes(existingRec.Customer_Type__c, "Service");
      if (ct) f.Customer_Type__c = ct;
      else delete f.Customer_Type__c;
    }
    // addressed by the customer's SALESFORCE id: a shared household's second HCP record, or a
    // linked solar customer, has no HCP_Id__c of its own to be found by (the 2026-09-28 strays)
    if (!sfId) {
      bump("leads:planned-unresolved"); // dry run only: the customer does not exist yet
      leadRecords.push({ [HCP_ID_FIELD]: cid, ...f });
    } else {
      leadRecords.push({ Id: sfId, [HCP_ID_FIELD]: cid, ...f });
    }
    if (f.Service_Stage__c) bump(`leads:stage-${f.Service_Stage__c}`);
  }
  // one row per Sundial customer: the newest lead wins
  const byKey = new Map();
  for (const r of leadRecords) byKey.set(r.Id ?? r[HCP_ID_FIELD], r);
  const rows = [...byKey.values()];
  console.log(`\nleads: ${rows.length} customers get a Service pipeline entry`);
  // HCP_Id__c stays what the customers phase decided: a shared / linked record must not be re-stamped
  await upsertAll("leads", OBJ.customer, rows.filter((r) => r.Id).map(({ [HCP_ID_FIELD]: _hcp, ...r }) => r), { keyField: "Id" });
  if (!APPLY) bump("leads:planned", rows.filter((r) => !r.Id).length);
}

// ---------------------------------------------------------------- estimates + jobs

const estimateRecords = [];
const lineRecordsByEstimate = new Map(); // estimate HCP id → line field rows (Estimate__c filled after the estimate write)
const jobPlans = [];

if (PHASES.includes("estimates")) {
  let list = estimatesHcp; // the ones a job came from too — their own (archived) record, see jobEstimateFields
  if (LIMIT) list = list.filter((e) => limitedCustomerIds.has(s(e.customer?.id)));
  for (const est of list) {
    const customerSfId = sfCustomerFor(est.customer?.id);
    if (!customerSfId && APPLY) {
      bump("estimates:no-customer");
      continue;
    }
    const option = pickOption(est);
    const detail = estDetail.get(s(est.id));
    const optLines = (detail?.options || []).find((o) => s(o.option?.id) === s(option?.id))?.line_items || [];
    const stage = /approved/i.test(s(option?.approval_status)) ? "Approved" : "Proposed";
    const rows = optLines.map((li, i) => lineFields(li, { estimateSfId: null, itemsByHcpId, stage, tenantId, index: i }));
    const disposition = estDisp.get(s(est.id));
    estimateRecords.push(estimateFields(est, { customerSfId, tenantId, lineRows: rows, disposition }));
    lineRecordsByEstimate.set(s(est.id), rows);
    bump("estimates:standalone");
    if (disposition?.archived) bump(`estimates:archived${claimed.has(s(est.id)) ? "-converted" : ""}`);
  }
}

if (PHASES.includes("jobs")) {
  let list = jobsHcp;
  if (LIMIT) list = list.filter((j) => limitedCustomerIds.has(s(j.customer?.id)));
  for (const job of list) {
    const jid = s(job.id);
    const customerSfId = sfCustomerFor(job.customer?.id);
    if (!customerSfId && APPLY) {
      bump("jobs:no-customer");
      errors.push({ phase: "jobs", object: OBJ.job, hcp_id: jid, error: "no Sundial customer for this job's HCP customer" });
      continue;
    }
    const detail = jobDetail.get(jid) || {};
    const invoices = invoicesByJob.get(jid) || [];
    const st = invoiceState(invoices);
    const estKey = `job:${jid}:estimate`;
    const complete = /complete/i.test(s(job.work_status));
    const disposition = jobDisp.get(jid);
    const sourceLines = detail.line_items?.length ? detail.line_items : st.live?.items || [];
    const rows = sourceLines.map((li, i) => lineFields(li, { estimateSfId: null, itemsByHcpId, stage: complete ? "Completed" : "Approved", tenantId, index: i }));
    estimateRecords.push(jobEstimateFields(job, { customerSfId, tenantId, lineRows: rows, jobState: st, archived: disposition?.archived === true }));
    lineRecordsByEstimate.set(estKey, rows);
    jobPlans.push({ job, jid, estKey, customerSfId, st, invoices, appointments: detail.appointments || [], disposition });
    if (disposition?.archived) bump(`jobs:archived${disposition.stale ? "-stale" : ""}`);
  }
}

console.log(`\nestimates: ${estimateRecords.length} (standalone + one per job), lines: ${[...lineRecordsByEstimate.values()].reduce((n, r) => n + r.length, 0)}`);
const estimateIds = await upsertAll("estimates", OBJ.estimate, estimateRecords);
for (const [k, v] of estimateIds) idMap.estimates[k] = v;

const lineRecords = [];
for (const [estKey, rows] of lineRecordsByEstimate) {
  const estimateSfId = estimateIds.get(estKey) || idMap.estimates[estKey];
  if (!estimateSfId && APPLY) continue;
  for (const r of rows) lineRecords.push({ ...r, Estimate__c: estimateSfId });
}
const lineIds = await upsertAll("lines", OBJ.line, lineRecords);
for (const [k, v] of lineIds) idMap.lines[k] = v;

const jobRecords = jobPlans.map((p) => jobFields(p.job, { customerSfId: p.customerSfId, estimateSfId: estimateIds.get(p.estKey) || idMap.estimates[p.estKey] || null, tenantId, st: p.st, appointments: p.appointments, disposition: p.disposition }));
console.log(`jobs: ${jobRecords.length}`);
const jobIds = await upsertAll("jobs", OBJ.job, jobRecords);
for (const [k, v] of jobIds) idMap.jobs[k] = v;

// the job's estimate points back at the job (a job never without an estimate, and the estimate knows its job)
const backlinks = jobPlans.map((p) => ({ [HCP_ID_FIELD]: p.estKey, Service_Job__c: jobIds.get(p.jid) || idMap.jobs[p.jid] })).filter((r) => r.Service_Job__c);
await upsertAll("estimate-backlinks", OBJ.estimate, backlinks);

const callRecords = [];
const invoiceRecords = [];
const paymentPlans = [];
for (const p of jobPlans) {
  const jobSfId = jobIds.get(p.jid) || idMap.jobs[p.jid];
  if (!jobSfId && APPLY) continue;
  const status = callStatusFor(p.job);
  for (const a of p.appointments) {
    const techIds = (a.dispatched_employees_ids || []).map(s).filter(Boolean);
    const per = techIds.length ? techIds : [null];
    for (const empId of per) {
      const t = empId ? resolveTech(empId) : { sfId: null, name: "" };
      callRecords.push(callFields(p.job, a, { jobSfId, techSfId: t.sfId, techName: t.name, tenantId, hcpId: callKey(a.id, empId, techIds.length > 1), status }));
      if (empId && !t.sfId) bump("calls:tech-unmatched");
    }
  }
  for (const inv of p.invoices) {
    invoiceRecords.push(invoiceFields(inv, { jobSfId, tenantId }));
    for (const pay of inv.payments || []) paymentPlans.push({ p: pay, kind: "payment", inv, jobSfId });
    for (const ref of inv.refunds || []) paymentPlans.push({ p: ref, kind: "refund", inv, jobSfId });
  }
}
console.log(`calls: ${callRecords.length}, invoices: ${invoiceRecords.length}, payments: ${paymentPlans.length}`);
const callIds = await upsertAll("calls", OBJ.call, callRecords);
for (const [k, v] of callIds) idMap.calls[k] = v;
const invoiceIds = await upsertAll("invoices", OBJ.invoice, invoiceRecords);
for (const [k, v] of invoiceIds) idMap.invoices[k] = v;
const paymentRecords = paymentPlans
  .map(({ p, kind, inv, jobSfId }) => paymentFields(p, kind, { inv, jobSfId, invoiceSfId: invoiceIds.get(s(inv.id)) || idMap.invoices[s(inv.id)] || null, tenantId }))
  .filter((r) => r.Invoice__c || !APPLY);
const paymentIds = await upsertAll("payments", OBJ.payment, paymentRecords);
for (const [k, v] of paymentIds) idMap.payments[k] = v;

// ---------------------------------------------------------------- reports
await fs.mkdir(OUT, { recursive: true });
if (APPLY) await writeJson(path.join(OUT, "id-map.json"), idMap);
await fs.writeFile(path.join(OUT, "review.csv"), toCsv(review));
await fs.writeFile(path.join(OUT, "errors.csv"), toCsv(errors));
// The jobs archived as abandoned — Monday's review list; Unarchive on the job page brings one back.
const staleRows = jobPlans
  .filter((p) => p.disposition?.stale)
  .map((p) => ({
    hcp_job: s(p.job.invoice_number) || p.jid,
    customer: personName(p.job.customer),
    address: addressLine(p.job.address),
    hcp_status: s(p.job.work_status),
    scheduled_for: s(p.job.schedule?.scheduled_start).slice(0, 10),
    last_updated: s(p.job.updated_at).slice(0, 10),
    reason: p.disposition.reason,
    sundial_id: idMap.jobs[p.jid] || "",
  }))
  .sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for) || a.last_updated.localeCompare(b.last_updated));
await fs.writeFile(path.join(OUT, "stale-jobs.csv"), toCsv(staleRows));
const gapRows = [...gaps.entries()].map(([k, n]) => ({ field: k.split("\u0000")[0], value: k.split("\u0000")[1], leads: n })).sort((a, b) => a.field.localeCompare(b.field) || b.leads - a.leads);
await fs.writeFile(path.join(OUT, "picklist-gaps.csv"), toCsv(gapRows));
const summary = [
  `HCP import — ${new Date().toISOString()} — tenant ${TENANT} — ${APPLY ? "APPLIED" : "DRY RUN (nothing written)"}${LIMIT ? ` — limit ${LIMIT}` : ""}`,
  "",
  ...Object.entries(counts).sort().map(([k, v]) => `  ${k.padEnd(32)} ${v}`),
  "",
  `review.csv: ${review.length} row(s) — ${review.filter((r) => r.needs_action === "YES").length} need a decision (needs_action = YES; the rest are notes on how a customer was matched)   errors.csv: ${errors.length} row(s)`,
  `stale-jobs.csv: ${staleRows.length} job(s) archived as abandoned (cutoff ${STALE_DAYS} days) — Harmon's Monday review; Unarchive on the job page brings one back`,
  gapRows.length ? `picklist-gaps.csv: ${gapRows.length} value(s) the org lacks — add them in Setup and re-run for the exact stages / sources:\n${gapRows.map((g) => `    ${g.field.padEnd(28)} ${g.value.padEnd(40)} ${g.leads}`).join("\n")}` : "picklist-gaps.csv: none — every HCP value landed on a picklist value",
  APPLY ? "" : "Dry run: re-run with --apply to write. --limit 25 first is a good idea.",
  APPLY ? "Next: a FULL cache resync for customer, estimate, service_line, service_job, service_call, service_invoice, service_payment (docs/migration.md)." : "",
].filter((l) => l !== undefined).join("\n");
await fs.writeFile(path.join(OUT, "SUMMARY.txt"), summary);
console.log(`\n${summary}\n\nReports in ${OUT}`);
