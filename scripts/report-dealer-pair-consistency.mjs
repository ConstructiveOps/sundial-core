// Customer ↔ Solar dealer-attribution report. D-064 §2.3, proposed amendment §2.3.8.
//
//   node scripts/report-dealer-pair-consistency.mjs
//   node scripts/report-dealer-pair-consistency.mjs --csv out.csv
//   node scripts/report-dealer-pair-consistency.mjs --limit 40      # rows shown per bucket
//
// ⚠️ REPORT-ONLY BY DEFAULT. `--apply` writes, and writes ONLY the two inheritance
// buckets §2.3.8 decides (Tim, 2026-09-16): a linked pair where one side is null, the
// other is attributed, and NEITHER record has a `Sales_Rep__c`. Canary-first per CLAUDE.md.
//
// ⚠️ `--apply` DELIBERATELY REFUSES THE ALIAS-FILE ORPHANS, and that refusal is a
// finding rather than a limitation. Those 179 Solar records look like "pass 2 was never
// re-run", but 169 of them HAVE a rep -- a rep with no `Dealer__c`, because 23 of the 24
// reps involved are dealer ORGANIZATIONS imported from Sunbase as user records, and
// backfill-dealers.mjs only ever stamped the ZZ fixtures and Dennis. They fell between
// pass 1 (which needs the rep to have a dealer) and pass 2 (which needs no rep at all),
// exactly as both passes are specified. The fix is on `Sundial_User__c`, not on the
// deals: stamp those 23 users, re-run pass 1, and all 163 resolve through A1 with zero
// name matching on any deal -- and STAY correct, because the rep is then the source.
// Writing a dealer onto 163 deals from a picklist reaches the same values today by a
// route that has to be repeated forever. docs/access-model.md §2.3a.
//
// ---------------------------------------------------------------------------
// WHAT WENT WRONG, AND WHY A COUNT WOULD NOT HAVE CAUGHT IT
// ---------------------------------------------------------------------------
// Reported from live usage, 2026-09-15. A Customer/Solar pair carried "Property Upgrades"
// in the sales-company fields and had no `Sales_Rep__c` at all. The §2.4 backfill's pass 2
// (A2) resolves a rep-less record's sales-company value through the alias file — but it
// runs on SOLAR ONLY, deliberately (Customer `Dealer_Name__c` is populated on 13 of
// 31,637 rows, so a Customer pass would have added name-matching risk for almost nothing).
//
// So the Solar record got a `Dealer__c` and its Customer did not. The dealer's manager saw
// the project and could not open the customer behind it. Nothing is wrong with either
// record on its own — and that is the point: every existing check is single-object.
//
//   - `verify-dealer-ownership.mjs` §2 checks `Dealer__c == Sales_Rep__r.Dealer__c`
//     wherever a rep is set. Both records here have NO rep, so both pass.
//   - The `pending` count (`Dealer__c = null AND Sales_Rep__r.Dealer__c != null`) is the
//     unfinished-backfill probe. No rep means no pending. Both pass.
//   - Every access assertion is per object. A half-attributed pair is two individually
//     defensible rows.
//
// The invariant nobody was checking is the one BETWEEN the two records. This report adds
// it, and §2.3.5's nightly reconcile gains the same check (see verify-dealer-ownership.mjs)
// so the next one is caught by a job rather than by a dealer.
//
// ---------------------------------------------------------------------------
// WHY THE COMPARISON HAPPENS HERE AND NOT IN SOQL
// ---------------------------------------------------------------------------
// `WHERE Dealer__c != Sundial_Customer__r.Dealer__c` is a MALFORMED_QUERY, not an empty
// result: the right-hand side of a SOQL comparison must be a literal. Same wall
// `verify-dealer-ownership.mjs` hit on the rep invariant. So the rows come back and the
// comparison is done in JS.
//
// ---------------------------------------------------------------------------
// WHAT "DEALER-ISH" MEANS, PRECISELY
// ---------------------------------------------------------------------------
// A sales-company value that RESOLVES, through `docs/integrations/dealer-aliases.csv`, to
// an existing `Sundial_Dealer__c` row in this tenant. That is the same resolution the A2
// backfill pass uses, and using a different one here would report candidates the backfill
// could never act on.
//
//   Customer `Dealer_Name__c`                        — the dealer list (110 values)
//   Solar    `Sales_Company_Harmon_Solar_or_Third__c` — the dealer list (56 values)
//   Customer `Sales_Company__c`                      — NOT a dealer list. Two values,
//     `Harmon Solar` / `Third-Party Dealer`: the internal/external discriminator. It is
//     read here ONLY to label a row, never to resolve one. (§2.2 A1, D19.)
//
// A near-miss — differing only by case, punctuation or whitespace from a dealer name, with
// no alias row approving the merge — is reported SEPARATELY and never proposed as a
// resolution. "Are these the same company" is a fact about the world, not a property of
// the strings, and the alias CSV is where a human records having decided it.

import fs from "node:fs";
import { sfQuery, sfUpdateRecord, soqlEscapeString } from "../lib/salesforce.js";
import { loadDealerAliases, normalizeDealerName, resolveDealerName } from "./dealer-aliases.mjs";

const TENANT_ID = "a1W7y000007AszBEAS";
const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes("--apply");
const CSV_PATH = (() => {
  const i = ARGV.indexOf("--csv");
  return i === -1 ? null : ARGV[i + 1];
})();
const ROW_LIMIT = (() => {
  const i = ARGV.indexOf("--limit");
  const n = i === -1 ? NaN : Number(ARGV[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : 25;
})();

const log = (...a) => console.log(...a);
const rule = (c = "=") => log(c.repeat(100));
const idChunks = (ids, size = 400) => {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
};
const inList = (ids) => ids.map((v) => `'${soqlEscapeString(v)}'`).join(",");

// ---------------------------------------------------------------------------
// 1. The dealer directory, and the alias file the A2 pass resolves through
// ---------------------------------------------------------------------------
const dealers = await sfQuery(
  `SELECT Id, Name, Active__c, Is_Internal__c FROM Sundial_Dealer__c ` +
    `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' ORDER BY Name`
);
const dealerById = new Map(dealers.map((d) => [d.Id, d]));
const dealerByNormName = new Map(dealers.map((d) => [normalizeDealerName(d.Name), d]));
const { byAlias, path: aliasPath } = loadDealerAliases();

const dealerLabel = (id) => {
  if (!id) return "(null)";
  const d = dealerById.get(id);
  if (!d) return `${id} (NOT A DEALER ROW)`;
  return `${d.Name}${d.Active__c ? "" : " [inactive]"}`;
};

/**
 * Resolve a raw sales-company value the way the A2 backfill pass would.
 * @returns {{kind:'exact'|'near'|'unknown'|'blank', dealer?:object, canonical?:string, near?:string}}
 */
function resolveSalesCompany(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { kind: "blank" };
  const canonical = resolveDealerName(value, byAlias);
  const exact = dealerByNormName.get(normalizeDealerName(canonical));
  if (exact) return { kind: "exact", dealer: exact, canonical };
  // A near-miss is a dealer whose normalized name SHARES A PREFIX or is contained in the
  // value (or vice versa). Reported, never proposed — the alias CSV is the only thing
  // that may turn one into the other.
  const n = normalizeDealerName(canonical);
  for (const [dn, d] of dealerByNormName) {
    if (dn && n && (dn.startsWith(n) || n.startsWith(dn) || dn.includes(n) || n.includes(dn))) {
      return { kind: "near", near: d.Name, canonical };
    }
  }
  return { kind: "unknown", canonical };
}

// ---------------------------------------------------------------------------
// 2. Every linked Customer/Solar pair
// ---------------------------------------------------------------------------
// Driven from SOLAR (4.5k rows) rather than Customer (31.6k): the link field lives on
// Solar, and the Customers we need are exactly the ones it points at.
const solar = await sfQuery(
  `SELECT Id, Name, Project_Name__c, Sundial_Customer__c, Dealer__c, Sales_Rep__c, ` +
    `Sales_Rep__r.Dealer__c, Sales_Company_Harmon_Solar_or_Third__c ` +
    `FROM Sundial_Solar__c WHERE Client__c = '${soqlEscapeString(TENANT_ID)}'`
);
const linkedCustomerIds = [...new Set(solar.map((s) => s.Sundial_Customer__c).filter(Boolean))];

const customersById = new Map();
for (const chunk of idChunks(linkedCustomerIds)) {
  const rows = await sfQuery(
    `SELECT Id, Name, Dealer__c, Sales_Rep__c, Sales_Rep__r.Dealer__c, ` +
      `Dealer_Name__c, Sales_Company__c FROM Sundial_Customer__c ` +
      `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND Id IN (${inList(chunk)})`
  );
  for (const r of rows) customersById.set(r.Id, r);
}

// ---------------------------------------------------------------------------
// 3. Classify every pair
// ---------------------------------------------------------------------------
// The buckets are ordered by what a human has to DO about them, not by how they arose.
const pairs = {
  splitByRep: [],     // both set, different, and EACH AGREES WITH ITS OWN REP -> correct
  conflictOneRep: [], // both set, different, one rep -> that rep settles it
  conflictNoRep: [],  // both set, different, no rep anywhere -> needs Tim
  inheritCustomer: [],// Customer null, Solar set -> the (a) rule, Customer inherits
  inheritSolar: [],   // Solar null, Customer set -> the (a) rule, reversed
  backfillPending: [],// one side null but ITS OWN rep has a dealer -> pass 1 never ran
  repPresent: [],     // one side null, a Sales_Rep__c on EITHER record -> A1's, never §2.3.8's
  bothNull: [],       // neither attributed -> the orphan buckets decide what that means
};

/** Null-safe id equality, so `null === undefined` reads as "the same answer". */
const r0 = (v) => v ?? null;

for (const s of solar) {
  const c = s.Sundial_Customer__c ? customersById.get(s.Sundial_Customer__c) : null;
  if (!c) continue; // an unlinked Solar record has no pair to be inconsistent with
  const sd = s.Dealer__c ?? null;
  const cd = c.Dealer__c ?? null;
  const row = {
    solarId: s.Id,
    solarName: s.Project_Name__c ?? s.Name ?? "",
    customerId: c.Id,
    customerName: c.Name ?? "",
    solarDealer: sd,
    customerDealer: cd,
    solarRep: s.Sales_Rep__c ?? null,
    customerRep: c.Sales_Rep__c ?? null,
    solarRepDealer: s.Sales_Rep__r?.Dealer__c ?? null,
    customerRepDealer: c.Sales_Rep__r?.Dealer__c ?? null,
    solarSalesCompany: s.Sales_Company_Harmon_Solar_or_Third__c ?? null,
    customerDealerName: c.Dealer_Name__c ?? null,
    customerSalesCompany: c.Sales_Company__c ?? null,
  };

  if (sd && cd && sd !== cd) {
    // ⚠️ "THE TWO DISAGREE" IS NOT ONE FINDING. Three states hide under it, and only
    // two are defects:
    //
    //   BOTH sides have a rep and each record already equals ITS OWN rep's dealer.
    //     Nothing is broken. A1 says the dealer comes from the rep, both records obey
    //     it, and the pair is split because the customer and the project were sold by
    //     people at different organizations. Copying either way would OVERWRITE a value
    //     the rep determines, which A1 forbids outright. Reported as information.
    //
    //   ONE side has a rep. The rep is the source (§2.3.6), so the answer exists.
    //
    //   NEITHER has a rep. Two independent guesses produced two values, and there is no
    //     rule in the model that picks between them. A human does.
    const cAgrees = r0(row.customerDealer) === r0(row.customerRepDealer);
    const sAgrees = r0(row.solarDealer) === r0(row.solarRepDealer);
    if (row.customerRepDealer && row.solarRepDealer && cAgrees && sAgrees) {
      pairs.splitByRep.push(row);
    } else if (row.customerRepDealer || row.solarRepDealer) {
      pairs.conflictOneRep.push(row);
    } else {
      pairs.conflictNoRep.push(row);
    }
    continue;
  }
  if (sd === cd) {
    if (sd === null) pairs.bothNull.push(row);
    continue; // both set and equal: nothing to report
  }
  // Exactly one side is null from here.
  //
  // ⚠️ A REP WITH A DEALER ON THE NULL SIDE IS NOT AN INHERITANCE CASE. §2.3 rule 6 is
  // explicit that the rep is the source wherever one exists, so a null `Dealer__c` beside
  // a rep who HAS a dealer is unfinished backfill pass 1 — a different fix, with a
  // different (and unambiguous) answer. Folding it into the (a) rule would let the link
  // overwrite what the rep already determines, which is the one thing A1 forbids.
  const nullSideRepDealer = cd === null ? row.customerRepDealer : row.solarRepDealer;
  if (nullSideRepDealer) { pairs.backfillPending.push(row); continue; }
  // ⚠️ §2.3.8 REQUIRES THAT NEITHER RECORD HAS A `Sales_Rep__c` -- not merely that the
  // null side's rep lacks a dealer. Corrected 2026-09-16 (Tim): the test above was the
  // only one here, so a null side whose rep has NO dealer, and a pair whose ATTRIBUTED
  // side carries a rep, both fell through into the inheritance buckets. The report called
  // 40 pairs "no rep either side" and 33 of them had one. A rep anywhere in the pair
  // makes it A1's question -- the dealer comes from that rep or it stays null -- and the
  // link must not answer it.
  if (row.solarRep || row.customerRep) { pairs.repPresent.push(row); continue; }
  if (cd === null) pairs.inheritCustomer.push(row);
  else pairs.inheritSolar.push(row);
}

// ---------------------------------------------------------------------------
// 4. Standalone: a dealer-ish sales-company value with a null Dealer__c, either object
// ---------------------------------------------------------------------------
// Targeted queries rather than a scan: `Dealer_Name__c != null` is 13 rows on Customer,
// and the Solar picklist is populated on ~780 of 4,477.
const orphanCustomers = await sfQuery(
  `SELECT Id, Name, Dealer_Name__c, Sales_Company__c, Sales_Rep__c, Sales_Rep__r.Dealer__c ` +
    `FROM Sundial_Customer__c WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' ` +
    `AND Dealer__c = null AND Dealer_Name__c != null`
);
const orphanSolar = await sfQuery(
  `SELECT Id, Name, Project_Name__c, Sundial_Customer__c, Sales_Company_Harmon_Solar_or_Third__c, ` +
    `Sales_Rep__c, Sales_Rep__r.Dealer__c FROM Sundial_Solar__c ` +
    `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND Dealer__c = null ` +
    `AND Sales_Company_Harmon_Solar_or_Third__c != null`
);

const orphans = { exact: [], near: [], unknown: [], repOwned: [] };
function classifyOrphan(objectLabel, id, name, rawValue, repId, repDealer, extra = {}) {
  const r = resolveSalesCompany(rawValue);
  const row = { object: objectLabel, id, name, value: rawValue, resolution: r, repId, repDealer, ...extra };
  // The rep still wins. A rep-owned row with a null dealer is pass-1 work, not A2 work,
  // whatever the picklist says.
  if (repDealer) orphans.repOwned.push(row);
  else if (r.kind === "exact") orphans.exact.push(row);
  else if (r.kind === "near") orphans.near.push(row);
  else orphans.unknown.push(row);
}
for (const c of orphanCustomers) {
  classifyOrphan("Customer", c.Id, c.Name, c.Dealer_Name__c, c.Sales_Rep__c ?? null,
    c.Sales_Rep__r?.Dealer__c ?? null, { salesCompany: c.Sales_Company__c ?? null });
}
for (const s of orphanSolar) {
  classifyOrphan("Solar", s.Id, s.Project_Name__c ?? s.Name, s.Sales_Company_Harmon_Solar_or_Third__c,
    s.Sales_Rep__c ?? null, s.Sales_Rep__r?.Dealer__c ?? null,
    { linkedCustomer: s.Sundial_Customer__c ?? null });
}

// ---------------------------------------------------------------------------
// 5. Report
// ---------------------------------------------------------------------------
rule();
log("DEALER PAIR CONSISTENCY — Customer ↔ Solar. READ-ONLY, nothing is written.");
rule();
log(`  tenant         ${TENANT_ID}`);
log(`  dealer rows    ${dealers.length} (${dealers.filter((d) => d.Active__c).length} active)`);
log(`  alias file     ${aliasPath}`);
log(`  solar records  ${solar.length}  (${linkedCustomerIds.length} distinct linked customers)`);
log(`  rows shown     ${ROW_LIMIT} per bucket (--limit N to change)`);
log(`  mode           ${APPLY ? "APPLY (writes the inheritance buckets ONLY)" : "REPORT ONLY (pass --apply to write)"}`);

function section(title, rows, note) {
  log("");
  rule("-");
  log(`${title}  —  ${rows.length} record(s)`);
  rule("-");
  if (note) log(note);
  if (rows.length === 0) log("  none.");
}

// --- 1. THE THREE WAYS A PAIR DISAGREES -------------------------------------
section(
  "1a. SPLIT BY REP — both sides attributed, DIFFERENT dealers, and BOTH are CORRECT",
  pairs.splitByRep,
  "  NOT A DEFECT, and the most important row in this report to read before proposing a\n" +
    "  fix. Each record equals ITS OWN rep's dealer, which is exactly what A1 requires. The\n" +
    "  pair is split because the customer and the project are owned by reps at different\n" +
    "  organizations — the deal changed hands, or one org sold it and another installed it.\n" +
    "  Rule (a) MUST NOT touch these: copying either direction would overwrite a value the\n" +
    "  rep determines, which is the one thing A1 forbids."
);
for (const r of pairs.splitByRep.slice(0, ROW_LIMIT)) {
  log(`  ${r.customerId}  ${String(r.customerName).slice(0, 30).padEnd(30)} ${dealerLabel(r.customerDealer)}`);
  log(`  ${r.solarId}  ${String(r.solarName).slice(0, 30).padEnd(30)} ${dealerLabel(r.solarDealer)}`);
  log(`      → both agree with their own rep. NO ACTION.`);
}
if (pairs.splitByRep.length > ROW_LIMIT) log(`  … and ${pairs.splitByRep.length - ROW_LIMIT} more`);

section(
  "1b. CONFLICT, ONE REP — the rep settles it (§2.3.6)",
  pairs.conflictOneRep,
  "  One side has a rep and the other does not, and the two dealers differ. The rep is the\n" +
    "  source, so the answer already exists; the rep-less side is carrying a guess that lost."
);
for (const r of pairs.conflictOneRep.slice(0, ROW_LIMIT)) {
  const settled = r.customerRepDealer ?? r.solarRepDealer;
  log(`  ${r.customerId}  ${String(r.customerName).slice(0, 30).padEnd(30)} ${dealerLabel(r.customerDealer)}`);
  log(`  ${r.solarId}  ${String(r.solarName).slice(0, 30).padEnd(30)} ${dealerLabel(r.solarDealer)}`);
  log(`      → rep's dealer wins: ${dealerLabel(settled)}`);
}
if (pairs.conflictOneRep.length > ROW_LIMIT) log(`  … and ${pairs.conflictOneRep.length - ROW_LIMIT} more`);

section(
  "1c. CONFLICT, NO REP ANYWHERE — NEEDS TIM",
  pairs.conflictNoRep,
  "  Two values from two independent guesses, and no rule in the model picks between them.\n" +
    "  Rule (a) does not apply (neither side is null); §2.3.6 does not apply (no rep)."
);
for (const r of pairs.conflictNoRep.slice(0, ROW_LIMIT)) {
  log(`  ${r.customerId}  ${String(r.customerName).slice(0, 30).padEnd(30)} ${dealerLabel(r.customerDealer)}` +
      (r.customerDealerName ? `   [Dealer_Name__c: ${r.customerDealerName}]` : ""));
  log(`  ${r.solarId}  ${String(r.solarName).slice(0, 30).padEnd(30)} ${dealerLabel(r.solarDealer)}` +
      (r.solarSalesCompany ? `   [sales company: ${r.solarSalesCompany}]` : ""));
}
if (pairs.conflictNoRep.length > ROW_LIMIT) log(`  … and ${pairs.conflictNoRep.length - ROW_LIMIT} more`);

// --- 2/3. INHERIT (the proposed rule (a)) -----------------------------------
section(
  "2. CUSTOMER INHERITS FROM SOLAR — Customer null, Solar attributed, no rep either side",
  pairs.inheritCustomer,
  "  PROPOSED RESOLUTION (a). This is the reported class: the A2 backfill pass runs on\n" +
    "  Solar only, so a rep-less pair ends up half attributed and the dealer's manager sees\n" +
    "  the project without its customer. Copying ACROSS THE LINK introduces no new name\n" +
    "  matching — the value was already resolved and written on the Solar side."
);
for (const r of pairs.inheritCustomer.slice(0, ROW_LIMIT)) {
  log(`  ${r.customerId}  ${String(r.customerName).slice(0, 40).padEnd(40)} (null)`);
  log(`      ← ${r.solarId}  ${dealerLabel(r.solarDealer)}` +
      (r.solarSalesCompany ? `   [solar sales company: ${r.solarSalesCompany}]` : ""));
}
if (pairs.inheritCustomer.length > ROW_LIMIT)
  log(`  … and ${pairs.inheritCustomer.length - ROW_LIMIT} more`);

section(
  "3. SOLAR INHERITS FROM CUSTOMER — Solar null, Customer attributed, no rep either side",
  pairs.inheritSolar,
  "  PROPOSED RESOLUTION (a), reversed. Rarer, because the A2 pass only ever wrote Solar —\n" +
    "  these are Customers attributed some other way (Aurora dealer-originated, D-049)."
);
for (const r of pairs.inheritSolar.slice(0, ROW_LIMIT)) {
  log(`  ${r.solarId}  ${String(r.solarName).slice(0, 40).padEnd(40)} (null)`);
  log(`      ← ${r.customerId}  ${dealerLabel(r.customerDealer)}`);
}
if (pairs.inheritSolar.length > ROW_LIMIT)
  log(`  … and ${pairs.inheritSolar.length - ROW_LIMIT} more`);

// --- 4. BACKFILL PENDING ----------------------------------------------------
section(
  "4. BACKFILL PASS 1 PENDING — a null side whose OWN rep has a dealer",
  pairs.backfillPending,
  "  NOT an inheritance case and not a decision: §2.3.6 makes the rep the source wherever\n" +
    "  one exists, so the answer is already determined and the link is irrelevant. Fixed by\n" +
    "  re-running `node scripts/backfill-deal-ownership.mjs --apply` (pass 1), not by rule (a)."
);
for (const r of pairs.backfillPending.slice(0, ROW_LIMIT)) {
  const side = r.customerDealer === null ? "Customer" : "Solar";
  const id = r.customerDealer === null ? r.customerId : r.solarId;
  const want = r.customerDealer === null ? r.customerRepDealer : r.solarRepDealer;
  log(`  ${side.padEnd(8)} ${id}  → rep's dealer ${dealerLabel(want)}`);
}
if (pairs.backfillPending.length > ROW_LIMIT)
  log(`  … and ${pairs.backfillPending.length - ROW_LIMIT} more`);

// --- 4b. EXCLUDED: A REP IS PRESENT ------------------------------------------
section(
  "4b. EXCLUDED — one side null, but a Sales_Rep__c on at least one record (§2.3.8 does not apply)",
  pairs.repPresent,
  "  NEVER WRITTEN FROM HERE. A rep anywhere in the pair makes the dealer A1's answer: it\n" +
    "  comes from that rep, or it stays null. Many resolve on their own once the rep's\n" +
    "  Sundial_User__c carries a dealer and backfill pass 1 re-runs."
);
const repLabel = (id, repDealer) =>
  id ? `${id} (rep dealer ${repDealer ? dealerLabel(repDealer) : "null"})` : "-";
for (const r of pairs.repPresent.slice(0, ROW_LIMIT)) {
  const dir = r.customerDealer === null ? "customer ← solar" : "solar ← customer";
  log(`  ${dir}  ${r.customerId} ${String(r.customerName).slice(0, 24).padEnd(24)} | ${r.solarId}  ` +
      `would copy ${dealerLabel(r.customerDealer ?? r.solarDealer)}`);
  log(`      reps: customer ${repLabel(r.customerRep, r.customerRepDealer)}  solar ${repLabel(r.solarRep, r.solarRepDealer)}`);
}
if (pairs.repPresent.length > ROW_LIMIT)
  log(`  … and ${pairs.repPresent.length - ROW_LIMIT} more`);

// --- 5. ORPHANS -------------------------------------------------------------
section(
  "5. DEALER-ISH VALUE, NULL Dealer__c — resolvable EXACTLY through the alias file",
  orphans.exact,
  "  These are what the A2 pass would write today. A Solar row here means the pass has not\n" +
    "  been run since the value appeared; a CUSTOMER row here is outside A2's scope entirely\n" +
    "  (§2.4 excludes Customer from pass 2) and is reachable only by rule (a) or by a\n" +
    "  deliberate decision to extend the pass."
);
for (const r of orphans.exact.slice(0, ROW_LIMIT)) {
  const linked = r.linkedCustomer ? `  [linked customer ${r.linkedCustomer}]` : "";
  log(`  ${r.object.padEnd(8)} ${r.id}  "${r.value}" → ${dealerLabel(r.resolution.dealer.Id)}${linked}`);
}
if (orphans.exact.length > ROW_LIMIT) log(`  … and ${orphans.exact.length - ROW_LIMIT} more`);

section(
  "6. DEALER-ISH VALUE, NULL Dealer__c — NEAR MISS, never auto-applied",
  orphans.near,
  "  Differs from a real dealer name by case, punctuation or whitespace and has NO row in\n" +
    `  ${aliasPath}.\n` +
    "  Approving one means adding an alias row, which is a human deciding two spellings are\n" +
    "  one organization. Listed so the decision is possible; never taken here."
);
for (const r of orphans.near.slice(0, ROW_LIMIT)) {
  log(`  ${r.object.padEnd(8)} ${r.id}  "${r.value}"  ≈  "${r.resolution.near}"   (no alias row)`);
}
if (orphans.near.length > ROW_LIMIT) log(`  … and ${orphans.near.length - ROW_LIMIT} more`);

section(
  "7. UNATTRIBUTED — value resolves to no dealer at all",
  orphans.unknown,
  "  PROPOSED RESOLUTION (b): STAYS NULL. Fail closed, the same rule D19 applies to\n" +
    "  commissions — a blank is a blank, never defaulted to Harmon. A null Dealer__c is\n" +
    "  invisible to every sales role and fully visible to tenant scope, so nothing is lost\n" +
    "  except a wrong guess."
);
const unknownByValue = new Map();
for (const r of orphans.unknown) {
  const k = `${r.object}|${r.value}`;
  unknownByValue.set(k, (unknownByValue.get(k) ?? 0) + 1);
}
for (const [k, n] of [...unknownByValue.entries()].sort((a, b) => b[1] - a[1]).slice(0, ROW_LIMIT)) {
  const [obj, value] = k.split("|");
  log(`  ${obj.padEnd(8)} ${String(n).padStart(5)} record(s)   "${value}"`);
}
if (unknownByValue.size > ROW_LIMIT) log(`  … and ${unknownByValue.size - ROW_LIMIT} more distinct values`);

section(
  "8. REP-OWNED with a null dealer — the picklist is not the answer here",
  orphans.repOwned,
  "  A dealer-ish value AND a rep whose dealer is set. §2.3.6: the rep is the source, so\n" +
    "  this is pass-1 backfill work and the picklist value is ignored (it is the commission\n" +
    "  discriminator, D19, and may legitimately name a different company from the owner)."
);
for (const r of orphans.repOwned.slice(0, ROW_LIMIT)) {
  log(`  ${r.object.padEnd(8)} ${r.id}  "${r.value}"  → rep's dealer ${dealerLabel(r.repDealer)}`);
}
if (orphans.repOwned.length > ROW_LIMIT) log(`  … and ${orphans.repOwned.length - ROW_LIMIT} more`);

// --- summary ----------------------------------------------------------------
log("");
rule();
log("SUMMARY");
rule();
const byObject = (rows) => {
  const c = rows.filter((r) => r.object === "Customer").length;
  return `${c} customer / ${rows.length - c} solar`;
};
const table = [
  ["1a. split by rep — BOTH CORRECT, no action", pairs.splitByRep.length],
  ["1b. conflict, one rep — the rep settles it", pairs.conflictOneRep.length],
  ["1c. conflict, no rep — NEEDS TIM", pairs.conflictNoRep.length],
  ["2. customer inherits from solar  — rule (a)", pairs.inheritCustomer.length],
  ["3. solar inherits from customer  — rule (a)", pairs.inheritSolar.length],
  ["4. backfill pass 1 pending       — re-run the backfill", pairs.backfillPending.length],
  ["4b. excluded, rep present        — A1's, never written here", pairs.repPresent.length],
  [`5. orphan, resolves EXACTLY      — ${byObject(orphans.exact)}`, orphans.exact.length],
  ["6. orphan, NEAR MISS             — needs an alias row", orphans.near.length],
  [`7. orphan, unattributed          — rule (b), stays null`, orphans.unknown.length],
  ["8. orphan, rep-owned             — re-run the backfill", orphans.repOwned.length],
];
for (const [label, n] of table) log(`  ${label.padEnd(58)} ${String(n).padStart(6)}`);
log(`  ${"pairs examined".padEnd(58)} ${String(solar.filter((s) => s.Sundial_Customer__c).length).padStart(6)}`);
log(`  ${"pairs already consistent".padEnd(58)} ${String(
  solar.filter((s) => {
    const c = s.Sundial_Customer__c ? customersById.get(s.Sundial_Customer__c) : null;
    return c && (s.Dealer__c ?? null) === (c.Dealer__c ?? null) && s.Dealer__c;
  }).length
).padStart(6)}`);

log("");
if (!APPLY) {
  log("NOTHING WAS WRITTEN. Buckets 2 and 3 are what `--apply` writes (the decided");
  log("2.3.8 rule). Bucket 7 stays null by rule (b). Buckets 4, 5 and 8 are NOT");
  log("writable from here — they are the rep's dealer, i.e. backfill pass 1 work,");
  log("and for bucket 5 the fix is on Sundial_User__c (see this file's header).");
}

// ---------------------------------------------------------------------------
// 6. APPLY — the two inheritance buckets only (§2.3.8, decided 2026-09-16)
// ---------------------------------------------------------------------------
// Writes `Dealer__c` on the NULL side of a pair from its attributed partner, and only
// where NEITHER record has a `Sales_Rep__c`. Nothing else in this report is writable
// from here, by design:
//
//   bucket 1a  both sides already correct — copying would CORRUPT a rep-derived value
//   bucket 1b/1c  a conflict; the rep settles it or Tim does, not a script
//   bucket 4/8  the rep's dealer is the answer — that is backfill pass 1's job
//   bucket 5    the orphans; see the header — the fix is on Sundial_User__c
//   bucket 6    a near miss needs an alias row, i.e. a human decision
//   bucket 7    stays null (rule (b))
//
// ⚠️ CANARY FIRST (CLAUDE.md). One record is written alone, re-read, and the run ABORTS
// if any field this script did not write came back changed. That is not belt-and-braces:
// the integration user cannot read `FlowDefinitionView` or `ApexTrigger`, so there is no
// way to ASK the org what automation is live, and the repo's `salesforce/flows/` holds
// drafts that may never have been deployed. A canary write is the only empirical check
// available. `Sundial_Budget_Recalc_Trigger` fires on `Sundial_Solar__c` writes and is a
// DRAFT today — an accident of sequencing, not a design property, and this is what
// carries the rule forward when nobody remembers.
if (APPLY) {
  log("");
  rule();
  log("APPLYING §2.3.8 — the inheritance buckets ONLY");
  rule();

  // Each plan row names BOTH records of the pair: the target (null side) and the source
  // (attributed side), so the fresh re-check below can test the whole §2.3.8 condition.
  const plan = [
    ...pairs.inheritCustomer.map((r) => ({
      target: { sfObject: "Sundial_Customer__c", id: r.customerId, name: r.customerName },
      source: { sfObject: "Sundial_Solar__c", id: r.solarId },
      dealerId: r.solarDealer,
    })),
    ...pairs.inheritSolar.map((r) => ({
      target: { sfObject: "Sundial_Solar__c", id: r.solarId, name: r.solarName },
      source: { sfObject: "Sundial_Customer__c", id: r.customerId },
      dealerId: r.customerDealer,
    })),
  ];

  // Fields re-read on the TARGET around the canary write; none of them may move. The
  // recalc Flow's outputs on Solar are watched per CLAUDE.md (a draft today).
  const WATCH = {
    Sundial_Customer__c: ["Sales_Rep__c", "Dealer_Name__c", "Sales_Company__c"],
    Sundial_Solar__c: ["Sales_Rep__c", "Budget_Calc_Status__c", "Budget_Calc_Error__c"],
  };
  const readRow = async (sfObject, id, extra = []) =>
    (
      await sfQuery(
        `SELECT ${[...new Set(["Id", "Dealer__c", "Sales_Rep__c", ...extra])].join(", ")} ` +
          `FROM ${sfObject} WHERE Id = '${soqlEscapeString(id)}' LIMIT 1`
      )
    )[0] ?? null;

  /**
   * THE FRESH RE-CHECK, immediately before each write (added 2026-09-16). The plan was
   * classified from a read that may be minutes old on a live org: a rep assigned since, a
   * dealer stamped since, or a source that changed since each turn a correct plan row into
   * a wrong write. BOTH records are re-read and the full §2.3.8 condition is re-tested.
   * A failure SKIPS the row rather than aborting the run -- leaving that pair alone is the
   * §2.3.8-correct outcome for it.
   */
  async function freshCheck(p) {
    const target = await readRow(p.target.sfObject, p.target.id, WATCH[p.target.sfObject]);
    const source = await readRow(p.source.sfObject, p.source.id);
    if (!target || !source) return { ok: false, reason: "a record in the pair is no longer readable" };
    if (target.Sales_Rep__c || source.Sales_Rep__c)
      return { ok: false, reason: `a rep is now present (target ${target.Sales_Rep__c ?? "-"} / source ${source.Sales_Rep__c ?? "-"})` };
    if (target.Dealer__c) return { ok: false, reason: `target is no longer blank (${dealerLabel(target.Dealer__c)})` };
    if ((source.Dealer__c ?? null) !== p.dealerId)
      return {
        ok: false,
        reason: `source dealer changed: planned ${dealerLabel(p.dealerId)}, now ${source.Dealer__c ? dealerLabel(source.Dealer__c) : "null"}`,
      };
    return { ok: true, target };
  }

  if (plan.length === 0) {
    log("  Nothing to apply — no half-attributed rep-less pairs.");
  } else if (plan.some((p) => !p.dealerId)) {
    log(`  ** ABORT: planned row(s) carry no source dealer. Nothing written.`);
    process.exitCode = 1;
  } else {
    log(`  ${plan.length} record(s) planned (${pairs.inheritCustomer.length} customer, ` +
        `${pairs.inheritSolar.length} solar). Each is re-checked fresh before its write.`);

    const skipped = [];
    let written = 0;
    let failed = 0;
    let canaryDone = false;

    for (const p of plan) {
      const chk = await freshCheck(p);
      if (!chk.ok) {
        skipped.push({ p, reason: chk.reason });
        log(`    SKIP ${p.target.sfObject} ${p.target.id}: ${chk.reason}`);
        continue;
      }

      if (!canaryDone) {
        // --- the canary: the first row that passes the fresh check, written alone ----
        const before = chk.target;
        log(`\n  CANARY  ${p.target.sfObject} ${p.target.id} (${String(p.target.name).slice(0, 30)}) -> ${dealerLabel(p.dealerId)}`);
        await sfUpdateRecord(p.target.sfObject, p.target.id, { Dealer__c: p.dealerId });
        const after = await readRow(p.target.sfObject, p.target.id, WATCH[p.target.sfObject]);
        const problems = [];
        if (!after) {
          problems.push("re-read found no record AFTER writing — script bug or permissions, not automation");
        } else {
          if ((after.Dealer__c ?? null) !== p.dealerId)
            problems.push(`Dealer__c is ${after.Dealer__c ?? "(null)"}, expected ${p.dealerId}`);
          for (const f of WATCH[p.target.sfObject]) {
            if ((after[f] ?? null) !== (before[f] ?? null))
              problems.push(`${f} moved ${JSON.stringify(before[f] ?? null)} -> ${JSON.stringify(after[f] ?? null)} on a write that did not touch it — automation is live`);
          }
        }
        if (problems.length > 0) {
          log("  ** CANARY FAILED — ABORTING before the remaining writes:");
          for (const x of problems) log(`       ${x}`);
          process.exitCode = 1;
          break;
        }
        log("  canary OK (dealer set, nothing else moved). Continuing.\n");
        canaryDone = true;
        written++;
        continue;
      }

      try {
        await sfUpdateRecord(p.target.sfObject, p.target.id, { Dealer__c: p.dealerId });
        written++;
        if (written % 10 === 0) log(`    ... ${written}/${plan.length}`);
      } catch (e) {
        failed++;
        log(`    ** FAILED ${p.target.sfObject} ${p.target.id}: ${e.message}`);
      }
    }

    log(`\n  WROTE ${written} of ${plan.length}` +
        `${skipped.length ? `, SKIPPED ${skipped.length} on the fresh re-check` : ""}` +
        `${failed ? `, ${failed} FAILED` : ""}.`);
    if (failed) process.exitCode = 1;
    log("  Re-run without --apply to confirm buckets 2 and 3 are empty, then");
    log("  node scripts/verify-dealer-ownership.mjs  (§2b should report 0 half-attributed).");
  }
  rule();
}

// --- optional CSV -----------------------------------------------------------
if (CSV_PATH) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    "bucket,object,id,name,currentDealer,proposedDealer,proposedDealerName,basis,salesCompanyValue",
  ];
  const push = (bucket, object, id, name, cur, prop, basis, value) =>
    lines.push([bucket, object, id, name, cur ?? "", prop ?? "", prop ? dealerLabel(prop) : "", basis, value ?? ""]
      .map(esc).join(","));
  for (const r of pairs.splitByRep)
    push("split-by-rep", "Pair", `${r.customerId}|${r.solarId}`, r.customerName,
      `${r.customerDealer}|${r.solarDealer}`, null, "both agree with their own rep — NO ACTION",
      r.solarSalesCompany);
  for (const r of pairs.conflictOneRep)
    push("conflict-one-rep", "Pair", `${r.customerId}|${r.solarId}`, r.customerName,
      `${r.customerDealer}|${r.solarDealer}`, r.customerRepDealer ?? r.solarRepDealer,
      "rep wins (§2.3.6)", r.solarSalesCompany);
  for (const r of pairs.conflictNoRep)
    push("conflict-no-rep", "Pair", `${r.customerId}|${r.solarId}`, r.customerName,
      `${r.customerDealer}|${r.solarDealer}`, null, "NEEDS TIM — no rep on either side",
      r.solarSalesCompany);
  for (const r of pairs.inheritCustomer)
    push("inherit-customer", "Customer", r.customerId, r.customerName, null, r.solarDealer,
      `rule (a) from Solar ${r.solarId}`, r.solarSalesCompany);
  for (const r of pairs.inheritSolar)
    push("inherit-solar", "Solar", r.solarId, r.solarName, null, r.customerDealer,
      `rule (a) from Customer ${r.customerId}`, r.customerDealerName);
  for (const r of pairs.backfillPending) {
    const isCust = r.customerDealer === null;
    push("backfill-pending", isCust ? "Customer" : "Solar", isCust ? r.customerId : r.solarId,
      isCust ? r.customerName : r.solarName, null, isCust ? r.customerRepDealer : r.solarRepDealer,
      "backfill pass 1 (rep's dealer)", null);
  }
  for (const r of pairs.repPresent) {
    const isCust = r.customerDealer === null;
    push("excluded-rep-present", isCust ? "Customer" : "Solar", isCust ? r.customerId : r.solarId,
      isCust ? r.customerName : r.solarName, null, null,
      `rep present (customer ${r.customerRep ?? "-"} / solar ${r.solarRep ?? "-"}) — A1, not §2.3.8`, null);
  }
  for (const r of orphans.exact)
    push("orphan-exact", r.object, r.id, r.name, null, r.resolution.dealer.Id, "alias file, exact", r.value);
  for (const r of orphans.near)
    push("orphan-near", r.object, r.id, r.name, null, null, `NEAR MISS of "${r.resolution.near}" — needs an alias row`, r.value);
  for (const r of orphans.unknown)
    push("orphan-unattributed", r.object, r.id, r.name, null, null, "rule (b): stays null", r.value);
  for (const r of orphans.repOwned)
    push("orphan-rep-owned", r.object, r.id, r.name, null, r.repDealer, "backfill pass 1 (rep's dealer)", r.value);
  fs.writeFileSync(CSV_PATH, lines.join("\n") + "\n", "utf8");
  log(`\nCSV written: ${CSV_PATH} (${lines.length - 1} row(s))`);
}
rule();
