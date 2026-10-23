// Seed the dealer's commercial terms on Sundial_Dealer__c (D-085, salesforce/v9-dealer-terms).
//
//   node scripts/backfill-dealer-terms.mjs           # REPORT ONLY. Default. Writes nothing.
//   node scripts/backfill-dealer-terms.mjs --apply   # writes
//
// Run it STRAIGHT AFTER deploying v9: from that moment every deal created on/after
// 2026-09-04 takes its redline from its dealer, and an unseeded dealer means a blank
// redline and a blank Commission_Total__c on every one of its deals.
//
// WHAT IT WRITES, on every Sundial_Dealer__c row of the Harmon tenant, AND ONLY WHERE THE
// FIELD IS STILL BLANK:
//
//   Redline_PPW__c / Redline_LightReach_PPW__c
//       Harmon Solar      2.20 / 2.10   (the internal rates)
//       Invictus Energy   1.75 / 1.65
//       every other       1.85 / 1.65   (the ZZ TEST fixture dealers included)
//
//   Acumatica_Vendor_ID__c / Acumatica_Vendor_Name__c
//       from docs/integrations/dealer-vendor-map.csv: each row's picklist value is
//       resolved to a dealer Name through docs/integrations/dealer-aliases.csv, then
//       matched EXACTLY against Sundial_Dealer__c.Name. No fuzzy matching — the alias
//       file is the reviewed list of which spellings are one organization (D-064 A2).
//       Skipped: the INTERNAL row (Harmon Solar never gets commission POs, D16), an
//       INACTIVE vendor (a PO against it must fail loudly, D4 — a blank ID does that),
//       and a dealer two CSV rows give two different vendor IDs (reported, never picked).
//
// ⚠️ A VALUE ALREADY ON A DEALER IS NEVER OVERWRITTEN, Harmon and Invictus included. A
// rate or vendor someone set by hand is a decision; a backfill that reverted it would be
// a commission change nobody asked for. A set value that differs from this table is
// REPORTED.
//
// CANARY FIRST (CLAUDE.md): the first dealer is written alone, then re-read with
// FIELDS(ALL); any field this script did not write that changed means automation is
// live on the object, and the run stops there.
//
// ⚠️ DO NOT PIPE A REAL RUN through head/tail — the shell then reports the pipe's last
// exit status and a partial failure exits 0. The script prints every failure itself.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sfQuery, sfUpdateRecord, sfUpdateMany, describeObject, soqlEscapeString } from "../lib/salesforce.js";
import { loadDealerAliases, resolveDealerName } from "./dealer-aliases.mjs";

const APPLY = process.argv.includes("--apply");
const TENANT_ID = "a1W7y000007AszBEAS"; // Sundial_Tenant__c "harmon"
const VENDOR_CSV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "docs/integrations/dealer-vendor-map.csv");

// D-085 / Harmon 2026-10-22. Hardcoded, like the legacy redlines in the formulas: these
// are the commission model's numbers, decided once, not derived from anything.
const NAMED_RATES = new Map([
  ["Harmon Solar", { standard: 2.2, lightreach: 2.1 }],
  ["Invictus Energy", { standard: 1.75, lightreach: 1.65 }],
]);
const DEFAULT_RATES = { standard: 1.85, lightreach: 1.65 };

const NEW_FIELDS = ["Redline_PPW__c", "Redline_LightReach_PPW__c", "Acumatica_Vendor_ID__c", "Acumatica_Vendor_Name__c"];

const log = (...a) => console.log(...a);
const rule = (c = "=") => log(c.repeat(92));
const isBlank = (v) => v === null || v === undefined || v === "";

// --- Minimal RFC-4180 reader (quoted fields carry commas: "Impact Solar Energy, LLC") ---
function splitCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function loadVendorMap() {
  const [header, ...lines] = fs.readFileSync(VENDOR_CSV, "utf8").split("\r\n").join("\n").trim().split("\n");
  const expected = "SalesCompanyPicklistValue,AcumaticaVendorID,AcumaticaVendorName,VendorStatus,Note";
  if (splitCsvLine(header).join(",") !== expected) {
    throw new Error(`dealer-vendor-map.csv header is "${header}", expected "${expected}". Refusing to guess the columns.`);
  }
  return lines.filter((l) => l.trim()).map((l) => {
    const [value, vendorId, vendorName, status, note] = splitCsvLine(l);
    return { value, vendorId, vendorName, status, note };
  });
}

// --- Preflight: the package must be deployed ------------------------------------
const described = await describeObject("Sundial_Dealer__c");
const missing = NEW_FIELDS.filter((f) => !described.fields.some((x) => x.name === f));
if (missing.length) {
  console.error(`Sundial_Dealer__c is missing ${missing.join(", ")} — deploy salesforce/v9-dealer-terms first.`);
  process.exit(1);
}

rule();
log("BACKFILL DEALER TERMS (D-085)");
rule();
log(`  tenant ${TENANT_ID}`);
log(`  mode   ${APPLY ? "APPLY (this WRITES)" : "REPORT ONLY (pass --apply to write)"}`);

const dealers = await sfQuery(
  `SELECT Id, Name, Active__c, Is_Internal__c, ${NEW_FIELDS.join(", ")} FROM Sundial_Dealer__c ` +
    `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' ORDER BY Name`
);
const byName = new Map(dealers.map((d) => [d.Name, d]));
log(`  ${dealers.length} dealer row(s)`);

// --- Vendor resolution ------------------------------------------------------------
const aliases = loadDealerAliases();
const vendorRows = loadVendorMap();
const unresolved = []; // CSV rows that reach no dealer
const skipped = []; // resolved, deliberately not applied
const vendorFor = new Map(); // dealer Id -> { vendorId, vendorName, from: [values] }
const conflicts = new Map(); // dealer Id -> Set of vendor ids

for (const row of vendorRows) {
  const canonical = resolveDealerName(row.value, aliases.byAlias);
  const dealer = byName.get(canonical);
  if (!dealer) { unresolved.push({ ...row, canonical }); continue; }
  if (/^INTERNAL/i.test(row.note) || dealer.Is_Internal__c) {
    skipped.push({ row, dealer, why: "internal — never gets commission POs (D16)" });
    continue;
  }
  if (row.status !== "Active") {
    skipped.push({ row, dealer, why: `vendor ${row.vendorId} is ${row.status} in Acumatica — left blank so a PO fails loudly (D4)` });
    continue;
  }
  const prior = vendorFor.get(dealer.Id);
  if (prior && prior.vendorId !== row.vendorId) {
    if (!conflicts.has(dealer.Id)) conflicts.set(dealer.Id, new Set([prior.vendorId]));
    conflicts.get(dealer.Id).add(row.vendorId);
    continue;
  }
  if (prior) prior.from.push(row.value);
  else vendorFor.set(dealer.Id, { vendorId: row.vendorId, vendorName: row.vendorName, from: [row.value] });
}
for (const id of conflicts.keys()) vendorFor.delete(id);

// --- Plan -----------------------------------------------------------------------------
const plans = [];
const divergent = [];
for (const d of dealers) {
  const rates = NAMED_RATES.get(d.Name) ?? DEFAULT_RATES;
  const vendor = vendorFor.get(d.Id) ?? null;
  const updates = {};
  const want = {
    Redline_PPW__c: rates.standard,
    Redline_LightReach_PPW__c: rates.lightreach,
    ...(vendor ? { Acumatica_Vendor_ID__c: vendor.vendorId, Acumatica_Vendor_Name__c: vendor.vendorName } : {}),
  };
  for (const [f, v] of Object.entries(want)) {
    if (isBlank(d[f])) updates[f] = v;
    else if (String(d[f]) !== String(v) && Number(d[f]) !== Number(v)) divergent.push({ d, f, have: d[f], want: v });
  }
  if (Object.keys(updates).length) plans.push({ d, updates, vendor });
}

rule("-");
log(`PLAN — ${plans.length} dealer(s) to write, ${dealers.length - plans.length} already complete`);
rule("-");
log(`  ${"dealer".padEnd(34)} ${"act".padEnd(4)} ${"redline".padEnd(12)} ${"vendor".padEnd(8)} via`);
for (const d of dealers) {
  const p = plans.find((x) => x.d.Id === d.Id);
  const u = p?.updates ?? {};
  const std = u.Redline_PPW__c ?? d.Redline_PPW__c;
  const lr = u.Redline_LightReach_PPW__c ?? d.Redline_LightReach_PPW__c;
  const vid = u.Acumatica_Vendor_ID__c ?? d.Acumatica_Vendor_ID__c ?? "—";
  const via = vendorFor.get(d.Id)?.from.map((v) => JSON.stringify(v)).join(", ") ?? "";
  log(
    `  ${d.Name.slice(0, 33).padEnd(34)} ${(d.Active__c ? "yes" : "-").padEnd(4)} ` +
      `${`${Number(std).toFixed(2)}/${Number(lr).toFixed(2)}`.padEnd(12)} ${String(vid).padEnd(8)} ${via}` +
      `${p ? "" : "   (no change)"}`
  );
}

if (divergent.length) {
  log(`\n  ** ${divergent.length} value(s) already set differ from the table — NOT overwritten: **`);
  for (const x of divergent) log(`     ${x.d.Name.padEnd(34)} ${x.f.padEnd(26)} has ${x.have}, table says ${x.want}`);
}

log(`\n  CSV ROWS THAT RESOLVE TO NO DEALER — ${unresolved.length}:`);
if (!unresolved.length) log("    none.");
for (const u of unresolved) {
  const via = u.canonical !== u.value ? ` (alias -> "${u.canonical}")` : "";
  log(`    "${u.value}"${via}  vendor ${u.vendorId} ${u.vendorName}${u.status !== "Active" ? ` [${u.status}]` : ""}`);
}
if (unresolved.length) {
  log("    A rep's own name (a person paid directly) or a spelling the alias file does not fold.");
  log("    To attach one: add a reviewed row to docs/integrations/dealer-aliases.csv, or set the");
  log("    vendor on the dealer by hand. This script never guesses which dealer a row means.");
}

if (skipped.length) {
  log(`\n  RESOLVED BUT DELIBERATELY NOT APPLIED — ${skipped.length}:`);
  for (const s of skipped) log(`    "${s.row.value}" -> ${s.dealer.Name}: ${s.why}`);
}
if (conflicts.size) {
  log(`\n  ** ${conflicts.size} dealer(s) reached by CSV rows with DIFFERENT vendor IDs — none applied: **`);
  for (const [id, ids] of conflicts) log(`     ${dealers.find((d) => d.Id === id).Name}: ${[...ids].join(" vs ")}`);
}

const activeWithout = dealers.filter(
  (d) => d.Active__c && isBlank(d.Acumatica_Vendor_ID__c) && !vendorFor.has(d.Id)
);
log(`\n  ACTIVE DEALERS LEFT WITHOUT A VENDOR ID — ${activeWithout.length}:`);
if (!activeWithout.length) log("    none.");
for (const d of activeWithout) {
  log(`    ${d.Name}${d.Is_Internal__c ? "   (internal — correct, no commission POs)" : ""}`);
}

// --- Apply ----------------------------------------------------------------------------
if (!APPLY) {
  rule();
  log(`REPORT ONLY. ${plans.length} dealer(s) would be written. Re-run with --apply.`);
  rule();
  process.exit(0);
}
if (!plans.length) {
  rule();
  log("Nothing to write.");
  rule();
  process.exit(0);
}

// Re-read with FIELDS(ALL) and compare everything but what we wrote and the audit stamps.
const IGNORE = new Set(["attributes", "LastModifiedDate", "LastModifiedById", "SystemModstamp", "LastViewedDate", "LastReferencedDate"]);
const readAll = async (id) =>
  (await sfQuery(`SELECT FIELDS(ALL) FROM Sundial_Dealer__c WHERE Id = '${soqlEscapeString(id)}' LIMIT 1`))[0];

const [canary, ...rest] = plans;
rule("-");
log(`CANARY — writing ${canary.d.Name} (${canary.d.Id}) alone first`);
const before = await readAll(canary.d.Id);
await sfUpdateRecord("Sundial_Dealer__c", canary.d.Id, canary.updates);
const after = await readAll(canary.d.Id);
const reacted = Object.keys(after).filter(
  (k) => !IGNORE.has(k) && !(k in canary.updates) && JSON.stringify(before[k]) !== JSON.stringify(after[k])
);
const notLanded = Object.entries(canary.updates).filter(([k, v]) => String(after[k]) !== String(v) && Number(after[k]) !== Number(v));
if (reacted.length || notLanded.length) {
  if (reacted.length) log(`  ** AUTOMATION DETECTED — changed without being written: ${reacted.join(", ")} **`);
  if (notLanded.length) log(`  ** WRITE DID NOT LAND AS SENT: ${notLanded.map(([k]) => k).join(", ")} **`);
  log(`  The canary ${canary.d.Id} HAS been written. ${rest.length} dealer(s) left untouched. Stopping.`);
  process.exit(1);
}
log("  -> nothing else changed. Proceeding.");

let ok = 1;
const failures = [];
for (let i = 0; i < rest.length; i += 200) {
  const batch = rest.slice(i, i + 200);
  try {
    const res = await sfUpdateMany("Sundial_Dealer__c", batch.map((p) => ({ Id: p.d.Id, ...p.updates })));
    res.forEach((r, j) => {
      if (r.success) ok++;
      else failures.push({ name: batch[j].d.Name, errors: r.errors.map((e) => e.message).join("; ") });
    });
  } catch (e) {
    for (const p of batch) failures.push({ name: p.d.Name, errors: e.sfBody ?? e.message });
  }
}

rule();
log(`WROTE ${ok} of ${plans.length} dealer(s).`);
for (const f of failures) log(`  FAILED ${f.name}: ${f.errors}`);
rule();
process.exitCode = failures.length ? 1 : 0;
