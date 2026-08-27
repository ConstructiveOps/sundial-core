// Phase 1 item 3 — create the Sundial_Dealer__c rows and stamp Dealer__c on users.
// D-064, docs/access-model.md §2.4 ("backfill-dealers.mjs") and §9 (test fixtures).
//
//   node scripts/backfill-dealers.mjs           # REPORT ONLY. Default. Writes nothing.
//   node scripts/backfill-dealers.mjs --apply   # writes
//
// WHAT IT WRITES, AND NOTHING ELSE
//
//   1. One Sundial_Dealer__c per DISTINCT dealer value SEEN ON A RECORD, across both
//      picklists -- Customer Dealer_Name__c and Solar
//      Sales_Company_Harmon_Solar_or_Third__c. The union, not the intersection: a
//      Customer-only value and a Solar-only value are each a real dealer somebody sold
//      through.
//   2. The three §9 fixture dealers: ZZ TEST DEALER A, ZZ TEST DEALER B (active) and
//      ZZ TEST DEALER INACTIVE (inactive).
//   3. Dealer__c on the ten ZZ TEST users, from TEST_USERS in
//      seed-access-test-fixtures.mjs -- imported, not copied.
//   4. Dealer__c on DENNIS ALESSANDRO -> Harmon Solar. The ONLY live user this script
//      touches, and it is in the brief.
//
// It writes NO deal records. Dealer__c on Customer and Solar is
// scripts/backfill-deal-ownership.mjs, which runs after this one and derives from the
// rep (A1) -- so this script has to run first, or every rep would have a null dealer to
// derive from.
//
// ⚠️ ACTIVE__C IS THE ONE THING HERE THAT GRANTS ACCESS.
// Exactly three real dealers are created active -- Harmon Solar, Heavenly Power,
// Property Upgrades LLC (§12.4) -- plus the two active ZZ fixtures. EVERY OTHER ROW IS
// CREATED INACTIVE, and under §1.2 a user attached to an inactive dealer resolves to
// scope `none` and sees nothing. Getting this wrong in the generous direction would
// hand ~50 dealers a live scope the day the model is enforced, so the active list is a
// hardcoded constant here rather than anything derived.
//
// ⚠️ IT NEVER FLIPS ACTIVE__C ON AN EXISTING ROW.
// Re-running is safe and idempotent for creation, but a dealer somebody switched on or
// off by hand in Salesforce is a DECISION, and a backfill that silently reverted it
// would be an access change nobody asked for. Divergence is REPORTED, never corrected.
//
// CANARY FIRST (CLAUDE.md): the first dealer is created alone, re-read, and every field
// compared against what was sent. Anything the script did not write coming back changed
// means automation is live on the object, and the run stops there.

import {
  sfQuery,
  sfCreateRecord,
  sfUpdateRecord,
  soqlEscapeString,
} from "../lib/salesforce.js";
import { TEST_USERS, EMAIL } from "./seed-access-test-fixtures.mjs";
import {
  loadDealerAliases,
  normalizeDealerName,
  resolveDealerName,
} from "./dealer-aliases.mjs";

const APPLY = process.argv.includes("--apply");
const TENANT_ID = "a1W7y000007AszBEAS"; // Sundial_Tenant__c "harmon"

// Dennis Alessandro, the one live restricted user (docs/access-model.md §2.4a).
const DENNIS_ID = "a1O7y00000s5sK1EAI";
const DENNIS_DEALER = "Harmon Solar";

// §12.4, confirmed by Tim 2026-08-26. Hardcoded on purpose — see the note above.
const ACTIVE_DEALERS = new Set(["Harmon Solar", "Heavenly Power", "Property Upgrades LLC"]);
const INTERNAL_DEALERS = new Set(["Harmon Solar"]);

// §9. ZZ TEST DEALER INACTIVE is deliberately inactive: it is the fixture that proves
// §2.1's inactive-dealer rule fails closed, and an active one would prove nothing.
const ZZ_DEALERS = [
  { name: "ZZ TEST DEALER A", active: true },
  { name: "ZZ TEST DEALER B", active: true },
  { name: "ZZ TEST DEALER INACTIVE", active: false },
];

const SOURCES = [
  { object: "Sundial_Customer__c", field: "Dealer_Name__c", label: "Customer" },
  { object: "Sundial_Solar__c", field: "Sales_Company_Harmon_Solar_or_Third__c", label: "Solar" },
];

const log = (...a) => console.log(...a);
const rule = (c = "=") => log(c.repeat(84));

// ---------------------------------------------------------------------------
// Near-miss detection — REPORTED, never acted on (A2)
// ---------------------------------------------------------------------------
// Two picklist values that differ only by case, punctuation or whitespace are almost
// certainly one organization. This script still creates a row for EACH, because merging
// them is a judgement about the real world and A2 says a judgement is Tim's, made once,
// in a reviewed file -- never inferred by a script mid-run.
//
// The cost of the conservative choice is small and the cost of the other one is not: a
// duplicate dealer row is inactive, unattached and free to merge later, whereas an
// incorrect merge silently shares one dealer's deals with another dealer's manager.
// The ONE normalizer, shared with the alias loader so the file and the report agree.
const normalize = normalizeDealerName;

function findNearMisses(names) {
  const byKey = new Map();
  for (const n of names) {
    const k = normalize(n);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(n);
  }
  return [...byKey.values()].filter((g) => g.length > 1);
}

/**
 * The WEAKER class: one normalized name is a whole-word prefix of another. Catches the
 * suffix differences an exact normalize misses -- "James Campbell Consulting" against
 * "James Campbell Consulting LLC", "Impact Solar" against "Impact Solar Energy".
 *
 * WHY THIS EXISTS: the first run of this report said "0 near-miss groups" and, four
 * lines further down, listed `James Campbell Consulting` as the single Customer-only
 * value -- with `James Campbell Consulting LLC` sitting in the Solar list. The strict
 * check was right by its own definition (A2 says case, punctuation, whitespace) and
 * useless in practice, because a legal suffix is the commonest way one organization
 * ends up spelled two ways. A report that has the evidence and does not join it up is
 * worse than one that never had it.
 *
 * DELIBERATELY REPORTED SEPARATELY, and still never merged. Prefix containment has real
 * false positives -- "Blue Sky" and "Blue Sky Solar" are one company in
 * dealer-vendor-map.csv, but "Solar Buddy" and "Solar Buddy AZ" are two distinct
 * picklist values that map to the same vendor, and "Harmon Solar" against "Harmon
 * Oklahoma" is neither. Only a human knows which.
 */
function findSuffixCandidates(names) {
  const out = [];
  const norm = names.map((n) => ({ raw: n, key: normalize(n) }));
  for (const a of norm) {
    for (const b of norm) {
      if (a.raw === b.raw || a.key === b.key) continue;
      if (b.key.startsWith(a.key + " ")) out.push([a.raw, b.raw]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Survey
// ---------------------------------------------------------------------------

/** Distinct non-null values of one picklist, with the record count behind each. */
async function distinctValues(source) {
  const rows = await sfQuery(
    `SELECT ${source.field} v, COUNT(Id) c FROM ${source.object} ` +
      `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND ${source.field} != null ` +
      `GROUP BY ${source.field}`
  );
  return new Map(rows.map((r) => [r.v, Number(r.c)]));
}

async function existingDealers() {
  const rows = await sfQuery(
    `SELECT Id, Name, Active__c, Is_Internal__c FROM Sundial_Dealer__c ` +
      `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}'`
  );
  return new Map(rows.map((r) => [r.Name, r]));
}

async function loadUsers() {
  const emails = TEST_USERS.map((u) => `'${soqlEscapeString(EMAIL(u.slug))}'`).join(",");
  const rows = await sfQuery(
    `SELECT Id, First_Name__c, Last_Name__c, Email__c, Access_Level__c, Dealer__c, Dealer__r.Name ` +
      `FROM Sundial_User__c WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' ` +
      `AND (Email__c IN (${emails}) OR Id = '${soqlEscapeString(DENNIS_ID)}')`
  );
  return rows;
}

rule();
log("BACKFILL DEALERS — survey");
rule();
log(`  tenant ${TENANT_ID}`);
log(`  mode   ${APPLY ? "APPLY (this WRITES)" : "REPORT ONLY (pass --apply to write)"}`);

// The reviewed merges (A2). Loading FAILS LOUDLY on a malformed file rather than
// falling back to "no aliases" -- a silently-ignored alias file would create the
// duplicate rows it exists to prevent, and the run would look successful.
const aliases = loadDealerAliases();
log(`\n  aliases: ${aliases.rows.length} reviewed merge(s) from docs/integrations/dealer-aliases.csv`);
for (const r of aliases.rows) log(`    "${r.alias}"  ->  "${r.dealerName}"`);

const seen = new Map(); // CANONICAL dealer name -> { customer: n, solar: n }
const folded = []; // { raw, canonical, source, count } — what the CSV actually changed
for (const source of SOURCES) {
  const values = await distinctValues(source);
  log(`\n  ${source.object}.${source.field}`);
  log(`    ${values.size} distinct value(s) on ${[...values.values()].reduce((a, b) => a + b, 0)} record(s)`);
  for (const [rawName, count] of values) {
    const name = resolveDealerName(rawName, aliases.byAlias);
    if (name !== rawName) folded.push({ raw: rawName, canonical: name, source: source.label, count });
    if (!seen.has(name)) seen.set(name, { customer: 0, solar: 0 });
    // += not =, because an alias and its canonical form can both appear on the SAME
    // object ("Blue Sky" and "Blue Sky Solar" are both Solar values). Assigning would
    // silently drop whichever was folded second.
    seen.get(name)[source.label.toLowerCase()] += count;
  }
}

if (folded.length) {
  log(`\n  FOLDED by the alias file — ${folded.length} value(s) get no row of their own:`);
  for (const f of folded) {
    log(`    ${f.source.padEnd(9)} "${f.raw}" (${f.count} record(s))  ->  "${f.canonical}"`);
  }
}

// A canonical name nobody actually uses means the CSV is stale -- a dealer renamed, or
// a merge recorded against a spelling no record carries. Reported rather than fatal:
// the row it would have created simply is not needed.
const unusedCanonicals = aliases.rows.map((r) => r.dealerName).filter((n) => !seen.has(n));
if (unusedCanonicals.length) {
  log(`\n  ** ${unusedCanonicals.length} canonical name(s) in the alias file appear on NO record: **`);
  for (const n of unusedCanonicals) log(`     "${n}" — the CSV may be stale.`);
}

// ---------------------------------------------------------------------------
// Plan the dealer rows
// ---------------------------------------------------------------------------
const existing = await existingDealers();

const plannedDealers = [];
for (const [name, counts] of [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  plannedDealers.push({
    name,
    active: ACTIVE_DEALERS.has(name),
    internal: INTERNAL_DEALERS.has(name),
    counts,
    existing: existing.get(name) ?? null,
    fixture: false,
  });
}
for (const z of ZZ_DEALERS) {
  plannedDealers.push({
    name: z.name,
    active: z.active,
    internal: false,
    counts: { customer: 0, solar: 0 },
    existing: existing.get(z.name) ?? null,
    fixture: true,
  });
}

const toCreate = plannedDealers.filter((d) => !d.existing);
const alreadyThere = plannedDealers.filter((d) => d.existing);

// A row that exists but disagrees with the plan. REPORTED, never corrected — see the
// header. A hand-flip of Active__c is a decision, and reverting it would be an access
// change nobody asked for.
const diverged = alreadyThere.filter(
  (d) => d.existing.Active__c !== d.active || d.existing.Is_Internal__c !== d.internal
);

rule("-");
log(`DEALER ROWS — ${plannedDealers.length} planned, ${toCreate.length} to create, ${alreadyThere.length} already present`);
rule("-");
log(`  ${"dealer".padEnd(36)} ${"active".padEnd(7)} ${"intl".padEnd(5)} ${"cust".padStart(5)} ${"solar".padStart(6)}   state`);
for (const d of plannedDealers) {
  const state = d.existing ? "exists" : "CREATE";
  log(
    `  ${d.name.slice(0, 35).padEnd(36)} ${(d.active ? "ACTIVE" : "-").padEnd(7)} ` +
      `${(d.internal ? "yes" : "-").padEnd(5)} ${String(d.counts.customer || "").padStart(5)} ` +
      `${String(d.counts.solar || "").padStart(6)}   ${state}${d.fixture ? "  (ZZ fixture)" : ""}`
  );
}

const activeCount = plannedDealers.filter((d) => d.active).length;
log(`\n  ACTIVE: ${activeCount} of ${plannedDealers.length}.`);
log(`    real dealers  : ${[...ACTIVE_DEALERS].join(", ")}`);
log(`    ZZ fixtures   : ${ZZ_DEALERS.filter((z) => z.active).map((z) => z.name).join(", ")}`);
log(`    Every other row is created INACTIVE -> its users would resolve to scope 'none'.`);

if (diverged.length) {
  log(`\n  ** ${diverged.length} EXISTING ROW(S) DISAGREE WITH THE PLAN — reported, NOT changed: **`);
  for (const d of diverged) {
    log(
      `     ${d.name.padEnd(36)} org: active=${d.existing.Active__c} internal=${d.existing.Is_Internal__c}` +
        `  | plan: active=${d.active} internal=${d.internal}`
    );
  }
  log(`     A hand-set Active__c is a decision. Change it in Salesforce, not here.`);
}

// ---------------------------------------------------------------------------
// Near-miss report (A2) — informational, nothing is merged
// ---------------------------------------------------------------------------
const names = [...seen.keys()];
const nearMisses = findNearMisses(names);
const suffixes = findSuffixCandidates(names).filter(
  ([a, b]) => !aliases.byAlias.has(normalize(a)) && !aliases.byAlias.has(normalize(b))
);
rule("-");
log(`NEAR-MISS SPELLINGS — ${nearMisses.length} exact-normalize, ${suffixes.length} suffix. NOTHING IS MERGED.`);
rule("-");

log(`  STRICT (differ only by case, punctuation or whitespace) — ${nearMisses.length}:`);
if (nearMisses.length === 0) log("    none.");
else for (const g of nearMisses) log(`    ${g.map((n) => JSON.stringify(n)).join("  ==  ")}`);

log(`\n  SUFFIX (one name is a whole-word prefix of another) — ${suffixes.length}:`);
if (suffixes.length === 0) log("    none.");
else for (const [a, b] of suffixes) log(`    ${JSON.stringify(a)}  is a prefix of  ${JSON.stringify(b)}`);

if (nearMisses.length + suffixes.length > 0) {
  log(
    "\n  Each value still gets ITS OWN dealer row. Merging is a judgement about the real\n" +
      "  world, and A2 puts judgements in a reviewed file, not in a script's guess. A\n" +
      "  duplicate row is inactive, unattached and free to merge later; a wrong merge\n" +
      "  silently shares one dealer's deals with another dealer's manager.\n" +
      "\n  The SUFFIX list is the weaker signal and has real false positives:\n" +
      "  dealer-vendor-map.csv treats \"Blue Sky\"/\"Blue Sky Solar\" as one organization but\n" +
      "  \"Solar Buddy\"/\"Solar Buddy AZ\" as two picklist values reaching one vendor. Only a\n" +
      "  human knows which. Decide in docs/integrations/dealer-aliases.csv."
  );
}

// Values on ONE object only, which is where the cross-object mismatch shows up in
// practice. Informational: after A1 the deal's dealer comes from its rep, so a
// Customer-only value costs nothing -- but it is worth seeing the shape.
const customerOnly = [...seen.entries()].filter(([, c]) => c.customer && !c.solar).map(([n]) => n);
const solarOnly = [...seen.entries()].filter(([, c]) => c.solar && !c.customer).map(([n]) => n);
const both = [...seen.entries()].filter(([, c]) => c.customer && c.solar).map(([n]) => n);
log(`\n  on BOTH picklists: ${both.length}   Customer only: ${customerOnly.length}   Solar only: ${solarOnly.length}`);
if (customerOnly.length) log(`    Customer only: ${customerOnly.join(", ")}`);

// ---------------------------------------------------------------------------
// Plan the user stamps
// ---------------------------------------------------------------------------
const users = await loadUsers();
const byEmail = new Map(users.map((u) => [String(u.Email__c || "").toLowerCase(), u]));
const dennis = users.find((u) => u.Id === DENNIS_ID) ?? null;

const userPlans = [];
for (const t of TEST_USERS) {
  const email = EMAIL(t.slug);
  const rec = byEmail.get(email.toLowerCase()) ?? null;
  userPlans.push({
    label: `zz-${t.slug}`,
    email,
    accessLevel: t.accessLevel,
    wantDealer: t.dealer ?? null,
    record: rec,
    live: false,
  });
}
userPlans.push({
  label: "Dennis Alessandro",
  email: dennis?.Email__c ?? "(not found)",
  accessLevel: dennis?.Access_Level__c ?? null,
  wantDealer: DENNIS_DEALER,
  record: dennis,
  live: true,
});

rule("-");
log(`USER Dealer__c STAMPS — ${userPlans.length} user(s): the ten ZZ TEST accounts + Dennis`);
rule("-");
log(`  ${"user".padEnd(24)} ${"access level".padEnd(14)} ${"dealer to set".padEnd(26)} state`);
for (const p of userPlans) {
  let state;
  if (!p.record) state = "** USER RECORD NOT FOUND **";
  else if (p.wantDealer === null) state = p.record.Dealer__c ? "would CLEAR — see below" : "leave null";
  else if (p.record.Dealer__r?.Name === p.wantDealer) state = "already set";
  else if (p.record.Dealer__c) state = `RESTAMP (was ${p.record.Dealer__r?.Name})`;
  else state = "SET";
  log(
    `  ${p.label.padEnd(24)} ${String(p.accessLevel ?? "-").padEnd(14)} ` +
      `${(p.wantDealer ?? "(none)").padEnd(26)} ${state}${p.live ? "   <- LIVE USER" : ""}`
  );
}

// A user whose fixture says "no dealer" but who carries one in the org. NOT cleared:
// clearing a dealer removes access, and doing that to a record this script did not set
// is exactly the class of change that must be a decision rather than a side effect.
const wouldClear = userPlans.filter((p) => p.record && p.wantDealer === null && p.record.Dealer__c);
if (wouldClear.length) {
  log(`\n  ** ${wouldClear.length} user(s) carry a dealer the fixture says they should not. NOT CLEARED: **`);
  for (const p of wouldClear) log(`     ${p.label} has ${p.record.Dealer__r?.Name}`);
  log(`     Clearing a dealer removes access; do it deliberately in Salesforce.`);
}

const missingUsers = userPlans.filter((p) => !p.record);
if (missingUsers.length) {
  log(`\n  ** ${missingUsers.length} user record(s) NOT FOUND: ${missingUsers.map((p) => p.label).join(", ")} **`);
  log(`     Run: node scripts/seed-access-test-fixtures.mjs --apply`);
}

log(
  `\n  zz-rep-nodealer and zz-tech are SUPPOSED to end with no dealer. That is the fixture:\n` +
    `  §1.2 says a sales role with a null dealer resolves to scope 'none', not to 'all\n` +
    `  dealers', and zz-rep-nodealer is the only thing that can prove it.`
);

// ---------------------------------------------------------------------------
// APPLY
// ---------------------------------------------------------------------------
const userWrites = userPlans.filter(
  (p) => p.record && p.wantDealer !== null && p.record.Dealer__r?.Name !== p.wantDealer
);

rule();
log(`${APPLY ? "APPLYING" : "REPORT ONLY — nothing written (pass --apply)"}`);
log(`  ${toCreate.length} dealer row(s) to create, ${userWrites.length} user stamp(s) to write`);
rule();

if (!APPLY) {
  log("\n  Review the tables above, then re-run with --apply.\n");
  process.exit(0);
}

if (toCreate.length === 0 && userWrites.length === 0) {
  log("\n  nothing to do.\n");
  process.exit(0);
}

/**
 * CANARY (CLAUDE.md). Create ONE dealer, read it back, and compare every field sent.
 * Then check nothing we did NOT send came back populated.
 *
 * This is the only empirical check available: the integration user cannot read
 * FlowDefinitionView or ApexTrigger (both INVALID_TYPE — no View Setup), so there is no
 * way to ASK the org what automation is live on a brand-new object. Sundial_Dealer__c
 * was created an hour ago and nothing should be watching it — which is a belief, and the
 * canary is the measurement.
 *
 * The SELECT list is derived from the fields being written, not hardcoded: on
 * 2026-08-27 the fixture seeder's canary fired spuriously because its re-read query did
 * not select a field it then compared. A canary that cries wolf gets switched off.
 */
async function canaryCreateDealer(plan) {
  const fields = {
    Name: plan.name,
    Client__c: TENANT_ID,
    Active__c: plan.active,
    Is_Internal__c: plan.internal,
  };
  log(`\n  CANARY — creating "${plan.name}" alone first`);

  // sfCreateRecord returns { ok, id } -- NOT a bare id. Destructured here because the
  // first run of this script did not, interpolated "[object Object]" into the re-read
  // WHERE clause, got zero rows back, and reported "AUTOMATION DETECTED - every field
  // came back null" over a record that was written perfectly. See the note below.
  const { id } = await sfCreateRecord("Sundial_Dealer__c", fields);
  if (!id) {
    log(`  ** create returned no id — cannot verify. STOPPING. **`);
    return { ok: false, id: null };
  }

  // The SELECT list is derived from the fields being written, never hardcoded: on
  // 2026-08-27 the fixture seeder's canary fired spuriously because its re-read did not
  // select a field it then compared.
  const selectList = ["Id", ...Object.keys(fields)].join(", ");
  const [back] = await sfQuery(
    `SELECT ${selectList} FROM Sundial_Dealer__c WHERE Id = '${soqlEscapeString(id)}'`
  );

  // ⚠️ "NO ROW CAME BACK" IS NOT "AUTOMATION CHANGED EVERYTHING", AND SAYING SO MATTERS.
  // Those two produce identical field-by-field diffs -- every field reads back null --
  // and they need opposite responses: one is a bug in this script or a permissions gap,
  // the other is a live Flow on the object. The first run of this script conflated them
  // and accused the org of automation it does not have. Separated here so the message
  // names the real problem.
  if (!back) {
    log(`  ** RE-READ RETURNED NO ROW for ${id}. **`);
    log(`     This is NOT evidence of automation: it means the verification query failed`);
    log(`     to find a record that was just created. Check the id, the SELECT list, and`);
    log(`     the integration user's FLS on Sundial_Dealer__c. STOPPING.`);
    return { ok: false, id };
  }

  const drift = [];
  for (const [f, sent] of Object.entries(fields)) {
    const got = back[f] ?? null;
    if (got !== sent) drift.push(`${f}: sent ${JSON.stringify(sent)}, read back ${JSON.stringify(got)}`);
  }
  if (drift.length) {
    log(`  ** AUTOMATION DETECTED on Sundial_Dealer__c — a field came back changed: **`);
    for (const d of drift) log(`     ${d}`);
    log(`     STOPPING after one record. The canary row ${id} EXISTS and may need deleting.`);
    return { ok: false, id };
  }
  log(`     read back identical on all ${Object.keys(fields).length} field(s):`);
  for (const [f, sent] of Object.entries(fields)) {
    log(`       ${f.padEnd(16)} sent ${JSON.stringify(sent)}  ==  read ${JSON.stringify(back[f] ?? null)}`);
  }
  log(`     -> no automation on these fields. Proceeding.`);
  return { ok: true, id };
}

const failures = [];
let created = 0;
const dealerIdByName = new Map([...existing.entries()].map(([n, r]) => [n, r.Id]));

if (toCreate.length > 0) {
  const canary = await canaryCreateDealer(toCreate[0]);
  dealerIdByName.set(toCreate[0].name, canary.id);
  created++;
  if (!canary.ok) {
    log(`\n  1 of ${toCreate.length} created (the canary). ${toCreate.length - 1} left untouched.`);
    log(`  NO user was stamped — the stamps run only after every dealer row exists.\n`);
    process.exit(1);
  }

  for (const plan of toCreate.slice(1)) {
    try {
      const { id } = await sfCreateRecord("Sundial_Dealer__c", {
        Name: plan.name,
        Client__c: TENANT_ID,
        Active__c: plan.active,
        Is_Internal__c: plan.internal,
      });
      dealerIdByName.set(plan.name, id);
      created++;
    } catch (e) {
      failures.push({ what: `dealer "${plan.name}"`, error: String(e.sfBody ?? e.message).slice(0, 160) });
    }
  }
  log(`\n  ${created} of ${toCreate.length} dealer row(s) created.`);
}

// User stamps run LAST and only if every dealer they need exists. A stamp pointing at a
// dealer that failed to create would be a null write dressed up as a success.
let stamped = 0;
for (const p of userWrites) {
  const dealerId = dealerIdByName.get(p.wantDealer);
  if (!dealerId) {
    failures.push({ what: `stamp ${p.label}`, error: `dealer "${p.wantDealer}" does not exist` });
    continue;
  }
  try {
    await sfUpdateRecord("Sundial_User__c", p.record.Id, { Dealer__c: dealerId });
    stamped++;
    log(`     stamped ${p.label.padEnd(24)} -> ${p.wantDealer}${p.live ? "   (LIVE USER)" : ""}`);
  } catch (e) {
    failures.push({ what: `stamp ${p.label}`, error: String(e.sfBody ?? e.message).slice(0, 160) });
  }
}
log(`\n  ${stamped} of ${userWrites.length} user stamp(s) written.`);

if (failures.length) {
  log(`\n  ** ${failures.length} FAILURE(S) **`);
  for (const f of failures) log(`     ${f.what}: ${f.error}`);
  process.exitCode = 1;
} else {
  log(`\n  Done. Next: node scripts/backfill-deal-ownership.mjs   (report only by default)\n`);
}
