// scripts/hcp-address-notes.mjs — Housecall Pro "Address Notes" → Sundial_Customer__c.Warranty_Notes__c
// (2026-10-07; docs/migration.md → "Address Notes"). Part of the HCP media migration pass:
// the same login cookie, the same web-app endpoints, a few minutes after the photos.
//
//   node scripts/hcp-address-notes.mjs --tenant harmon                   # DRY RUN: pull from HCP, plan, write plan.csv — Salesforce untouched
//   node scripts/hcp-address-notes.mjs --tenant harmon --apply --limit 3 # a canary: three customers
//   node scripts/hcp-address-notes.mjs --tenant harmon --apply           # everything (resumable — run again after a stop)
//   options: --only cus_a,cus_b   --refresh (re-ask HCP for customers already pulled)   --in migration/hcp
//
// THREE STEPS, EACH RESUMABLE.
//   1. PULL — one GET /api/customers/{cus}/addresses per customer the import matched (≈ 9,430;
//      the public API has no notes on addresses, the web app does). Every answer is kept in
//      migration\hcp\address-notes\pull.jsonl, so a stop (the cookie expired, the PC slept)
//      resumes where it was and a re-run asks HCP nothing it already knows (`--refresh` to re-ask).
//      ≈ 200 ms between calls → about 45–60 minutes the first time.
//   2. PLAN — read the matched customers' Warranty_Notes__c from Salesforce (only those HCP has
//      notes for) and decide per record: set (blank) / append (other text, kept) / skip (already
//      there, or nothing to say). migration\hcp\address-notes\plan.csv lists every decision.
//   3. APPLY (`--apply`) — CANARY FIRST (CLAUDE.md rule): one customer alone, re-read, abort if a
//      field this script did not write moved; then batches of 200, each record on its own.
//
// Needs: migration\hcp\raw\customers.json + migration\hcp\import\id-map.json (the pull and the
// import), AWS credentials (Tim's PowerShell — the cookie in Secrets Manager sundial/hcp →
// webCookie, the Salesforce connected app), never the device VM. Nothing here writes HCP.
//
// ⚠️ DO NOT PIPE THE OUTPUT through head/tail on a real run — a stop must be seen.

import { promises as fs } from "node:fs";
import path from "node:path";
import { sfQuery, sfUpdateRecord, sfUpsertMany, soqlEscapeString } from "../lib/salesforce.js";
import { getSecret } from "../lib/secrets.js";
import { HCP_SECRET } from "../lib/hcp-api.js";
import { createHcpWebClient, HCP_WEB_COOKIE_KEY } from "../lib/hcp-media.js";
import { addressNotesText, csvCell, planWarrantyNotes, WARRANTY_NOTES_FIELD } from "../lib/hcp-address-notes.js";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const TENANT = opt("--tenant");
const APPLY = flag("--apply");
const REFRESH = flag("--refresh");
const LIMIT = Number(opt("--limit", "0")) || 0;
const ONLY = (opt("--only", "") || "").split(",").map((x) => x.trim()).filter(Boolean);
const IN = path.resolve(opt("--in", path.join("migration", "hcp")));
const OUT = path.join(IN, "address-notes");
const PULL = path.join(OUT, "pull.jsonl");
if (!TENANT) {
  console.error("usage: node scripts/hcp-address-notes.mjs --tenant <slug> [--apply] [--limit N] [--only cus_a,cus_b] [--refresh]");
  process.exit(2);
}
const OBJECT = "Sundial_Customer__c";
const SELECT = `Id, Name, ${WARRANTY_NOTES_FIELD}, Description__c, Service_Stage__c, Archived__c, Status__c, Outreach_Notes__c`;
/** Fields the canary watches: this script writes none of them, so a change means automation. */
const WATCH = ["Name", "Description__c", "Service_Stage__c", "Archived__c", "Status__c", "Outreach_Notes__c"];
const BATCH = 200;
const s = (v) => (v == null ? "" : String(v).trim());
const show = (v) => (v == null ? "null" : String(v).slice(0, 70).replace(/\r?\n/g, "⏎"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
};

console.log("=".repeat(80));
console.log(`HCP ADDRESS NOTES → ${OBJECT}.${WARRANTY_NOTES_FIELD} — tenant ${TENANT} ${APPLY ? "(APPLY)" : "(dry run)"}`);
console.log("=".repeat(80));

// ---------------------------------------------------------------- the customers
const customers = await readJson(path.join(IN, "raw", "customers.json"), []);
const idMap = await readJson(path.join(IN, "import", "id-map.json"), null);
if (!customers.length || !idMap?.customers) {
  console.error(`Need ${path.join(IN, "raw", "customers.json")} (scripts/hcp-pull.mjs) and ${path.join(IN, "import", "id-map.json")} (scripts/hcp-import.mjs --apply).`);
  process.exit(2);
}
await fs.mkdir(OUT, { recursive: true });
const pulled = new Map(); // hcpCustomerId → its pull line
try {
  for (const line of (await fs.readFile(PULL, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.hcpCustomerId) pulled.set(e.hcpCustomerId, e);
    } catch {}
  }
} catch {}

let noSf = 0;
const matched = [];
for (const c of customers) {
  const hcpCustomerId = s(c.id);
  const sfId = idMap.customers[hcpCustomerId]?.sfId || idMap.customers[hcpCustomerId];
  if (!hcpCustomerId) continue;
  if (!sfId || typeof sfId !== "string") {
    noSf++;
    continue;
  }
  if (ONLY.length && !ONLY.includes(hcpCustomerId)) continue;
  matched.push({ hcpCustomerId, sfId, name: [s(c.first_name), s(c.last_name)].filter(Boolean).join(" ") || s(c.company) });
}
console.log(`  ${customers.length} HCP customers; ${matched.length} matched to a Sundial customer; ${noSf} never imported — skipped`);

// ---------------------------------------------------------------- 1. pull from HCP
const toPull = matched.filter((m) => REFRESH || !pulled.has(m.hcpCustomerId));
console.log(`  ${pulled.size} already pulled in an earlier run; ${toPull.length} to ask HCP for\n`);
if (toPull.length) {
  const secret = await getSecret(HCP_SECRET);
  if (!secret?.[HCP_WEB_COOKIE_KEY]) {
    console.error(`  ** Secrets Manager ${HCP_SECRET} has no ${HCP_WEB_COOKIE_KEY} — see docs/migration.md ("The cookie"). **`);
    process.exit(2);
  }
  const client = createHcpWebClient({ cookie: secret[HCP_WEB_COOKIE_KEY], log: (m) => console.log("  ", m) });
  const startedAt = Date.now();
  let n = 0;
  let withNotes = 0;
  let stopped = null;
  for (const m of toPull) {
    let line;
    try {
      const addresses = await client.listCustomerAddresses({ customerId: m.hcpCustomerId });
      const text = addressNotesText(addresses);
      line = { at: new Date().toISOString(), hcpCustomerId: m.hcpCustomerId, sfId: m.sfId, addresses: addresses.length, noted: addresses.filter((a) => a.notes).length, text };
      if (text) withNotes++;
    } catch (e) {
      if (e?.code === "SESSION_EXPIRED") {
        stopped = e.message;
        break;
      }
      line = { at: new Date().toISOString(), hcpCustomerId: m.hcpCustomerId, sfId: m.sfId, error: String(e?.message || e).slice(0, 200) };
    }
    await fs.appendFile(PULL, JSON.stringify(line) + "\n");
    pulled.set(m.hcpCustomerId, line);
    n++;
    if (n % 100 === 0 || n === toPull.length) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const rate = n / Math.max(1, elapsed);
      const eta = Math.round((toPull.length - n) / Math.max(0.1, rate));
      process.stdout.write(`  pulled ${n}/${toPull.length} (${withNotes} with address notes) · ${elapsed}s elapsed · ~${eta}s left\n`);
    }
  }
  if (stopped) {
    console.error(`\n  ** ${stopped} **\n     Copy a fresh cookie into Secrets Manager sundial/hcp → webCookie (docs/migration.md), then re-run — it resumes at customer ${n + 1} of ${toPull.length}.\n`);
    process.exit(1);
  }
}
// a pull that errored (not the session) is retried next run
const pullErrors = matched.filter((m) => pulled.get(m.hcpCustomerId)?.error);
for (const m of pullErrors) pulled.delete(m.hcpCustomerId);
if (pullErrors.length) {
  await fs.writeFile(PULL, [...pulled.values()].map((e) => JSON.stringify(e)).join("\n") + "\n");
  console.log(`  ${pullErrors.length} customer(s) could not be listed (kept out of the ledger — the next run asks again): ${pullErrors.slice(0, 5).map((m) => m.hcpCustomerId).join(", ")}${pullErrors.length > 5 ? ", …" : ""}`);
}

// ---------------------------------------------------------------- 2. plan against Salesforce
const noted = matched.filter((m) => s(pulled.get(m.hcpCustomerId)?.text));
console.log(`\n  ${noted.length} of ${matched.length} matched customers have address notes in HCP`);
const T = soqlEscapeString(TENANT);
const tenantRows = await sfQuery(`SELECT Id FROM Sundial_Tenant__c WHERE Name = '${T}' LIMIT 1`);
const tenantId = tenantRows?.[0]?.Id;
if (!tenantId) {
  console.error(`  ** No Sundial_Tenant__c named "${TENANT}" **`);
  process.exit(2);
}
const sfById = new Map();
for (let i = 0; i < noted.length; i += 200) {
  const ids = noted.slice(i, i + 200).map((m) => `'${m.sfId}'`).join(",");
  for (const r of await sfQuery(`SELECT ${SELECT} FROM ${OBJECT} WHERE Client__c = '${tenantId}' AND Id IN (${ids})`)) sfById.set(r.Id, r);
}
const counts = {};
const bump = (k) => (counts[k] = (counts[k] || 0) + 1);
const rows = [["Id", "Name", "HCP customer", "action", "from", "to"].map(csvCell).join(",")];
const plan = [];
for (const m of noted) {
  const sf = sfById.get(m.sfId);
  const text = pulled.get(m.hcpCustomerId).text;
  if (!sf) {
    bump("not-in-salesforce-or-other-tenant");
    rows.push([m.sfId, m.name, m.hcpCustomerId, "not-in-salesforce", "", show(text)].map(csvCell).join(","));
    continue;
  }
  const r = planWarrantyNotes(sf[WARRANTY_NOTES_FIELD], text);
  bump(r.action);
  rows.push([sf.Id, sf.Name, m.hcpCustomerId, r.action, show(sf[WARRANTY_NOTES_FIELD]), show(r.value ?? text)].map(csvCell).join(","));
  if (r.action === "set" || r.action === "append") plan.push({ sf, fields: { [WARRANTY_NOTES_FIELD]: r.value } });
}
const work = LIMIT ? plan.slice(0, LIMIT) : plan;
await fs.writeFile(path.join(OUT, "plan.csv"), rows.join("\r\n") + "\r\n");
console.log("\nPLAN");
for (const k of Object.keys(counts).sort()) console.log(`  ${k.padEnd(40)} ${counts[k]}`);
console.log(`\n  ${work.length} customer(s) to write${LIMIT ? ` (--limit ${LIMIT} of ${plan.length})` : ""}`);
console.log(`  plan: ${path.join(OUT, "plan.csv")}`);
const summaryLines = [`HCP address notes → ${OBJECT}.${WARRANTY_NOTES_FIELD} — ${new Date().toISOString()} — tenant ${TENANT} — ${APPLY ? "applied" : "dry run"}`, `matched ${matched.length}; pulled ${pulled.size}; with address notes ${noted.length}; ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join("; ")}`];
if (!APPLY || !work.length) {
  await fs.writeFile(path.join(OUT, "SUMMARY.txt"), summaryLines.join("\n") + "\n");
  console.log(APPLY ? "\n  Nothing to write.\n" : "\n  DRY RUN — Salesforce untouched. Re-run with --apply --limit 3 first, then --apply.\n");
  process.exit(0);
}

// ---------------------------------------------------------------- 3. apply, canary first
const readOne = async (id) => (await sfQuery(`SELECT ${SELECT} FROM ${OBJECT} WHERE Id = '${id}'`))[0];
const first = work[0];
console.log(`\n  CANARY — ${OBJECT} ${first.sf.Id} (${first.sf.Name}) alone first`);
const pre = await readOne(first.sf.Id);
await sfUpdateRecord(OBJECT, first.sf.Id, first.fields);
const post = await readOne(first.sf.Id);
const landed = s(post?.[WARRANTY_NOTES_FIELD]).replace(/\r\n/g, "\n") === s(first.fields[WARRANTY_NOTES_FIELD]).replace(/\r\n/g, "\n");
console.log(`     ${WARRANTY_NOTES_FIELD.padEnd(22)} ${show(pre?.[WARRANTY_NOTES_FIELD]).padEnd(40)} -> ${show(post?.[WARRANTY_NOTES_FIELD])}${landed ? "" : "   ** DID NOT LAND **"}`);
if (!landed) {
  console.log("\n  ** The canary write did not land. STOPPING. **\n");
  process.exit(1);
}
const reacted = WATCH.filter((f) => s(pre?.[f]) !== s(post?.[f]));
if (reacted.length) {
  console.log(`\n  ** AUTOMATION DETECTED — ${reacted.join(", ")} changed on the canary and this script did not write it. STOPPING after one record. **\n     The canary HAS been written. Deactivate the Flow on ${OBJECT}, then re-run.\n`);
  process.exit(1);
}
console.log(`     -> nothing else moved. Proceeding in batches of ${BATCH}.`);
let written = 1;
const failures = [];
const rest = work.slice(1);
for (let i = 0; i < rest.length; i += BATCH) {
  const chunk = rest.slice(i, i + BATCH);
  try {
    const res = await sfUpsertMany(OBJECT, "Id", chunk.map((it) => ({ Id: it.sf.Id, ...it.fields })));
    res.forEach((r, k) => {
      if (r.success) written++;
      else failures.push({ id: chunk[k].sf.Id, name: chunk[k].sf.Name, error: JSON.stringify(r.errors).slice(0, 200) });
    });
  } catch (e) {
    for (const it of chunk) failures.push({ id: it.sf.Id, name: it.sf.Name, error: String(e.sfBody ?? e.message).slice(0, 200) });
  }
  process.stdout.write(`\r     written ${written}, failed ${failures.length}  (${Math.min(i + BATCH, rest.length) + 1}/${work.length})   `);
  await sleep(150);
}
process.stdout.write("\n");
if (failures.length) {
  console.log(`\n  ** ${failures.length} WRITE FAILURE(S) ** (re-run: it plans only what is still missing)`);
  for (const f of failures.slice(0, 20)) console.log(`     ${f.id} ${f.name}: ${f.error}`);
  if (failures.length > 20) console.log(`     ... and ${failures.length - 20} more`);
  process.exitCode = 1;
}
summaryLines.push(`written ${written}; failed ${failures.length}`);
await fs.writeFile(path.join(OUT, "SUMMARY.txt"), summaryLines.join("\n") + "\n");
console.log(`\n  Done: ${written} customer(s) updated. The Service customer header and Intake tab show them after the next 5-minute cache sync (or run cache-sync { "object": "customer", "mode": "full" }).\n`);
