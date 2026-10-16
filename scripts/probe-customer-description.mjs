// scripts/probe-customer-description.mjs — why does "Tell us more about your issue" not stick?
// (2026-10-16, Harmon: intake notes typed on Blake Stoddard and Erin McNamara — on the popup and
// again through Edit on the customer page — come back as "Blake Stoddard - Arizona Public Service
// Company Other Lease", i.e. `Name - Utility Financing partner Financing type`.)
//
//   node scripts/probe-customer-description.mjs --tenant harmon --name "Erin McNamara"
//   node scripts/probe-customer-description.mjs --tenant harmon --name "Blake Stoddard" --name "Erin McNamara"
//   node scripts/probe-customer-description.mjs --tenant harmon --id a1P7y00000xxxxxAAA
//   node scripts/probe-customer-description.mjs --tenant harmon --test-write      # the ZZ test record only, see below
//
// READS ONLY, unless --test-write. For each customer it prints `Description__c`, who last touched
// the record and when, whether the text is exactly the composed `Name - Utility Partner Type`
// string (the signature of a Flow / field update, not of a person typing), the linked solar
// project's own Description__c, and the field's history rows if Salesforce tracks them.
//
// --test-write is the empirical check CLAUDE.md asks for (the integration user cannot read
// FlowDefinitionView, so the org cannot be ASKED what automation is live): it writes a probe
// sentence into Description__c on the designated test record `a1P7y00000AmyXCEAZ` — never a live
// customer — re-reads it at once and again after a pause, reports whether it stuck, then puts
// the original value back. A value that bounces straight back means a before-save automation on
// Sundial_Customer__c rewrites the field.

import { sfQuery, sfUpdateRecord, soqlEscapeString } from "../lib/salesforce.js";

const args = process.argv.slice(2);
const opts = (n) => args.flatMap((a, i) => (a === n && args[i + 1] ? [args[i + 1]] : []));
const TENANT = opts("--tenant")[0];
const NAMES = opts("--name");
const IDS = opts("--id");
const TEST_WRITE = args.includes("--test-write");
const TEST_RECORD = "a1P7y00000AmyXCEAZ"; // "ZZ PORTAL TEST — DO NOT USE" (CLAUDE.md)
const OBJECT = "Sundial_Customer__c";

if (!TENANT || (!NAMES.length && !IDS.length && !TEST_WRITE)) {
  console.error('usage: node scripts/probe-customer-description.mjs --tenant <slug> (--name "First Last" | --id <sfId>)... [--test-write]');
  process.exit(2);
}

const tenantRows = await sfQuery(`SELECT Id FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(TENANT)}' LIMIT 1`);
const tenantId = tenantRows?.[0]?.Id;
if (!tenantId) {
  console.error(`tenant "${TENANT}" not found`);
  process.exit(2);
}

const SELECT = [
  "Id", "Name", "Description__c", "Customer_Type__c", "Status__c", "Service_Stage__c",
  "Utility_Company__c", "Financing_Partner__c", "Financing_Type__c", "Leasing_Partner__c",
  "Linked_Solar_Project__c", "Linked_Solar_Project__r.Name", "Linked_Solar_Project__r.Description__c",
  "CreatedDate", "LastModifiedDate", "LastModifiedBy.Name", "SystemModstamp",
].join(", ");

/** The composed string the symptom shows: `Name - Utility Partner Type`, loose on spacing. */
const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
function looksComposed(c) {
  const parts = [c.Utility_Company__c, c.Financing_Partner__c, c.Financing_Type__c, c.Leasing_Partner__c].filter(Boolean);
  const desc = squash(c.Description__c);
  if (!desc || !parts.length) return false;
  const head = squash(`${c.Name} -`);
  return desc.startsWith(head) && parts.every((p) => desc.includes(squash(p)));
}

async function show(c) {
  console.log(`\n=== ${c.Name} (${c.Id}) · ${c.Status__c ?? "—"} · departments ${c.Customer_Type__c ?? "—"} · service stage ${c.Service_Stage__c ?? "—"}`);
  console.log(`  Description__c : ${JSON.stringify(c.Description__c ?? null)}`);
  console.log(`  composed?      : ${looksComposed(c) ? "YES — reads as Name - Utility Partner Type (an automation's value, not typed notes)" : "no"}`);
  console.log(`  utility / partner / type : ${c.Utility_Company__c ?? "—"} / ${c.Financing_Partner__c ?? "—"} / ${c.Financing_Type__c ?? "—"}`);
  console.log(`  last modified  : ${c.LastModifiedDate} by ${c.LastModifiedBy?.Name ?? "?"}   (created ${c.CreatedDate})`);
  if (c.Linked_Solar_Project__c) {
    const same = squash(c.Linked_Solar_Project__r?.Description__c) === squash(c.Description__c);
    console.log(`  solar project  : ${c.Linked_Solar_Project__r?.Name ?? c.Linked_Solar_Project__c} — its Description__c ${JSON.stringify(c.Linked_Solar_Project__r?.Description__c ?? null)}${same ? "  (IDENTICAL to the customer's)" : ""}`);
  } else console.log("  solar project  : none linked");
  try {
    const hist = await sfQuery(
      `SELECT Field, OldValue, NewValue, CreatedDate, CreatedBy.Name FROM ${OBJECT.replace("__c", "__History")} ` +
        `WHERE ParentId = '${c.Id}' AND Field = 'Description__c' ORDER BY CreatedDate DESC LIMIT 20`,
    );
    if (!hist.length) console.log("  history        : field history tracking is on, but no Description__c changes are recorded");
    else {
      console.log(`  history (newest first):`);
      for (const h of hist) console.log(`    ${h.CreatedDate}  ${h.CreatedBy?.Name ?? "?"}: ${JSON.stringify(h.OldValue)} → ${JSON.stringify(h.NewValue)}`);
    }
  } catch (e) {
    const msg = e?.sfBody || e?.message || String(e);
    console.log(`  history        : not available (${/INVALID_TYPE|sObject type/.test(msg) ? "history tracking is off for this object — turn it on for Description__c in Setup → Object Manager → Sundial Customer → Set History Tracking" : msg.slice(0, 160)})`);
  }
}

const where = [];
if (IDS.length) where.push(`Id IN (${IDS.map((i) => `'${soqlEscapeString(i)}'`).join(",")})`);
for (const n of NAMES) where.push(`Name LIKE '%${soqlEscapeString(n)}%'`);
if (where.length) {
  const rows = await sfQuery(`SELECT ${SELECT} FROM ${OBJECT} WHERE Client__c = '${tenantId}' AND (${where.join(" OR ")}) ORDER BY Name LIMIT 20`);
  if (!rows.length) console.log("no customers matched");
  for (const c of rows) await show(c);
}

if (TEST_WRITE) {
  const [t] = await sfQuery(`SELECT ${SELECT} FROM ${OBJECT} WHERE Id = '${TEST_RECORD}' LIMIT 1`);
  if (!t) {
    console.error(`test record ${TEST_RECORD} not found — node scripts/create-portal-test-record.mjs --apply`);
    process.exit(2);
  }
  console.log(`\n=== TEST WRITE on ${t.Name} (${t.Id}) — never a live customer`);
  const original = t.Description__c ?? null;
  const probe = `Probe ${new Date().toISOString()} — if you can read this, Description__c keeps what is written.`;
  console.log(`  before : ${JSON.stringify(original)}`);
  await sfUpdateRecord(OBJECT, TEST_RECORD, { Description__c: probe });
  const reread = async () => (await sfQuery(`SELECT Description__c, LastModifiedBy.Name FROM ${OBJECT} WHERE Id = '${TEST_RECORD}'`))[0];
  const now = await reread();
  console.log(`  right after the write : ${JSON.stringify(now.Description__c)}`);
  await new Promise((r) => setTimeout(r, 8000));
  const later = await reread();
  console.log(`  8 seconds later       : ${JSON.stringify(later.Description__c)}  (last modified by ${later.LastModifiedBy?.Name ?? "?"})`);
  const stuck = now.Description__c === probe && later.Description__c === probe;
  console.log(stuck ? "  RESULT: the write STUCK on the test record — whatever rewrites Description__c did not fire here (its entry condition may need a utility / financing / linked solar project, which the test record has: see the 'composed?' line above)" : "  RESULT: the write was REPLACED — an automation on Sundial_Customer__c rewrites Description__c on save");
  await sfUpdateRecord(OBJECT, TEST_RECORD, { Description__c: original });
  console.log(`  restored : ${JSON.stringify((await reread()).Description__c)}`);
}
