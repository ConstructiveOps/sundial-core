// Stamp Dealer__c on the Sundial_User__c records that ARE dealers.
// D-064 Phase 1, follow-up to backfill-dealers.mjs. Approved by Tim 2026-08-27.
//
//   node scripts/stamp-dealer-named-users.mjs           # REPORT ONLY. Default.
//   node scripts/stamp-dealer-named-users.mjs --apply   # writes
//
// WHY THESE RECORDS EXIST
//
// The Sunbase migration created a Sundial_User__c per selling entity, so 37 "users" are
// not people -- they are dealers. Every one is INACTIVE with a BLANK Access_Level__c,
// and each carries records as Sales_Rep__c. Under A1 a deal's dealer comes from its rep,
// so until these carry a Dealer__c their ~1,181 records stay unattributed.
//
// ⚠️ IT WRITES EXACTLY ONE FIELD: Dealer__c. Nothing else, on any record.
//
// That is not a coding preference, it is the safety property. These are live user
// records, and Active__c / Access_Level__c / Hierarchy_Level__c are precisely the fields
// that decide what somebody can see (docs/access-model.md §1.1-§1.2). A stamping script
// that "tidied" a blank Access_Level__c would be handing out scope, and an inactive user
// flipped active is an account that can log in. So: one field, and the re-read ASSERTS
// that every other field came back byte-identical -- not a spot check on a few named
// fields, but every scalar field the describe reports, minus the audit stamps that must
// change on any write.
//
// ⚠️ IT REFUSES AMBIGUITY. A user whose name matches TWO dealer rows, or NONE, is
// skipped and listed. Never a best guess: picking one of two dealers is picking whose
// manager sees the records.
//
// Matching is: alias file (docs/integrations/dealer-aliases.csv) first, then the shared
// normalizer (case, punctuation, whitespace). The report labels which one fired, so a
// match that depends on normalization is visible rather than implied.

import { sfQuery, sfUpdateRecord, describeObject, soqlEscapeString } from "../lib/salesforce.js";
import { loadDealerAliases, normalizeDealerName, resolveDealerName } from "./dealer-aliases.mjs";

const APPLY = process.argv.includes("--apply");
const TENANT_ID = "a1W7y000007AszBEAS";

// Salesforce-maintained audit fields, excluded from the comparison because Salesforce
// moves them on its own. Kept as SHORT as it can be: every name added here is a field
// this script stops watching, so the list is the assertion's blind spot.
//
//   LastModifiedDate / LastModifiedById / SystemModstamp — move on any write.
//
//   LastViewedDate / LastReferencedDate — move when a record is READ. These two were
//   added after the first --apply run stopped on them, reporting "automation is live on
//   Sundial_User__c updates". It was not: the "recently viewed" tracking had fired on
//   THIS SCRIPT'S OWN verification SELECT, so the canary was detecting itself. Both were
//   null before the run and stamped with the read timestamp after, on a record whose
//   Dealer__c, Active__c, Access_Level__c and Hierarchy_Level__c were all exactly right.
//
//   They are safe to exclude for a reason worth stating rather than assuming: neither
//   can carry data. They are timestamps written by the platform's view tracking, are not
//   settable through the API, and no Sundial code reads them. Excluding a field that
//   automation COULD write would blunt the check; excluding these does not.
const EXPECTED_TO_CHANGE = new Set([
  "LastModifiedDate",
  "LastModifiedById",
  "SystemModstamp",
  "LastViewedDate",
  "LastReferencedDate",
]);

const log = (...a) => console.log(...a);
const rule = (c = "=") => log(c.repeat(92));

rule();
log("STAMP DEALER-NAMED USERS — survey");
rule();
log(`  tenant ${TENANT_ID}`);
log(`  mode   ${APPLY ? "APPLY (this WRITES)" : "REPORT ONLY (pass --apply to write)"}`);
log(`  writes ONLY Dealer__c. Every other field is asserted unchanged on the re-read.`);

const aliases = loadDealerAliases();
const dealers = await sfQuery(
  `SELECT Id, Name, Active__c FROM Sundial_Dealer__c WHERE Client__c = '${soqlEscapeString(TENANT_ID)}'`
);
if (dealers.length === 0) {
  log(`\n  ** No Sundial_Dealer__c rows. Run scripts/backfill-dealers.mjs --apply first. **`);
  process.exit(1);
}

// Normalized name -> [dealer]. A LIST, so a collision is detectable rather than
// last-one-wins. backfill-dealers reported zero strict near-misses among the rows it
// created, so this should always be single-valued -- "should" is why it is checked.
const dealersByNorm = new Map();
for (const d of dealers) {
  const k = normalizeDealerName(d.Name);
  if (!dealersByNorm.has(k)) dealersByNorm.set(k, []);
  dealersByNorm.get(k).push(d);
}
const collisions = [...dealersByNorm.entries()].filter(([, v]) => v.length > 1);
if (collisions.length) {
  log(`\n  ** ${collisions.length} dealer name(s) collide after normalization: **`);
  for (const [k, v] of collisions) log(`     ${JSON.stringify(k)} <- ${v.map((d) => JSON.stringify(d.Name)).join(", ")}`);
  log(`     Every user matching one of these is refused below.`);
}

// ---------------------------------------------------------------------------
// The comparable field set — derived from describe, not hand-listed
// ---------------------------------------------------------------------------
// A hardcoded list is a list that goes stale: a field added to Sundial_User__c next
// month would be outside the assertion and could be rewritten by automation with nobody
// noticing. Compound and relationship fields are excluded because they are not scalars
// to compare; audit stamps because they must change.
const desc = await describeObject("Sundial_User__c");
const COMPARE_FIELDS = desc.fields
  .filter((f) => !f.compound && f.type !== "address" && f.type !== "location")
  .map((f) => f.name)
  .filter((n) => !EXPECTED_TO_CHANGE.has(n));
log(`\n  comparing ${COMPARE_FIELDS.length} field(s) per record on the re-read`);
log(`  (every scalar field on Sundial_User__c except ${[...EXPECTED_TO_CHANGE].join(", ")})`);

async function readUsers(whereClause) {
  return sfQuery(
    `SELECT ${COMPARE_FIELDS.join(", ")} FROM Sundial_User__c ` +
      `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND ${whereClause}`
  );
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------
const users = await readUsers("Dealer__c = null");

// Record counts per rep, so the report says what each stamp is worth.
const recordCounts = new Map();
for (const [obj, key] of [
  ["Sundial_Customer__c", "customer"],
  ["Sundial_Solar__c", "solar"],
]) {
  const rows = await sfQuery(
    `SELECT Sales_Rep__c r, COUNT(Id) c FROM ${obj} ` +
      `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND Sales_Rep__c != null GROUP BY Sales_Rep__c`
  );
  for (const r of rows) {
    if (!recordCounts.has(r.r)) recordCounts.set(r.r, { customer: 0, solar: 0 });
    recordCounts.get(r.r)[key] = Number(r.c);
  }
}

const matched = [];
const refusedAmbiguous = [];
const unmatched = [];

for (const u of users) {
  const fullName = `${u.First_Name__c ?? ""} ${u.Last_Name__c ?? ""}`.trim();
  if (!fullName) continue;

  const canonical = resolveDealerName(fullName, aliases.byAlias);
  const viaAlias = canonical !== fullName;
  const hits = dealersByNorm.get(normalizeDealerName(canonical)) ?? [];
  const counts = recordCounts.get(u.Id) ?? { customer: 0, solar: 0 };

  if (hits.length === 0) {
    unmatched.push({ u, fullName, counts });
    continue;
  }
  if (hits.length > 1) {
    refusedAmbiguous.push({ u, fullName, counts, hits });
    continue;
  }
  const dealer = hits[0];
  // How the match was made, so a normalization-dependent one is visible in the report
  // rather than implied. "ReFract Solar" -> "Refract Solar" is a `normalized` match:
  // the two differ only by case, which the alias file cannot record (loadDealerAliases
  // rejects a row whose alias and canonical normalize identically, as a no-op).
  const how = viaAlias ? "alias-file" : fullName === dealer.Name ? "exact" : "normalized";
  matched.push({ u, fullName, dealer, counts, how });
}

matched.sort((a, b) => b.counts.customer + b.counts.solar - (a.counts.customer + a.counts.solar));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
rule("-");
log(`MATCHED — ${matched.length} user record(s) whose name resolves to exactly one dealer`);
rule("-");
log(
  `  ${"user name".padEnd(32)} ${"match".padEnd(11)} ${"dealer".padEnd(32)} ${"dActive".padEnd(8)} ${"cust".padStart(5)} ${"solar".padStart(6)}  uActive  level`
);
let tc = 0;
let ts = 0;
for (const m of matched) {
  tc += m.counts.customer;
  ts += m.counts.solar;
  log(
    `  ${m.fullName.slice(0, 31).padEnd(32)} ${m.how.padEnd(11)} ${m.dealer.Name.slice(0, 31).padEnd(32)} ` +
      `${(m.dealer.Active__c ? "ACTIVE" : "-").padEnd(8)} ${String(m.counts.customer || "").padStart(5)} ` +
      `${String(m.counts.solar || "").padStart(6)}  ${String(m.u.Active__c).padEnd(7)}  ${m.u.Access_Level__c ?? "(blank)"}`
  );
}
log(`\n  ${tc.toLocaleString()} customer + ${ts.toLocaleString()} solar record(s) become attributable.`);
const byHow = matched.reduce((a, m) => ({ ...a, [m.how]: (a[m.how] ?? 0) + 1 }), {});
log(`  match kinds: ${Object.entries(byHow).map(([k, v]) => `${k} ${v}`).join(", ")}`);

const activeDealerHits = matched.filter((m) => m.dealer.Active__c);
log(
  `\n  ${activeDealerHits.length} of ${matched.length} point at an ACTIVE dealer` +
    `${activeDealerHits.length ? ` (${activeDealerHits.map((m) => m.dealer.Name).join(", ")})` : ""}.`
);
log(
  `  The rest point at INACTIVE dealers and therefore grant nobody anything today (§1.2).\n` +
    `  Every user here is itself INACTIVE with a blank Access_Level__c, so none of them can\n` +
    `  log in regardless — this is data attribution, not an access change.`
);

if (refusedAmbiguous.length) {
  rule("-");
  log(`REFUSED — ${refusedAmbiguous.length} user(s) match MORE THAN ONE dealer. Not stamped.`);
  rule("-");
  for (const r of refusedAmbiguous) {
    log(`  ${r.fullName.padEnd(34)} -> ${r.hits.map((d) => JSON.stringify(d.Name)).join(" | ")}`);
  }
  log(`\n  Picking one of two dealers is picking whose manager sees the records. Resolve the`);
  log(`  duplicate dealer rows first, then re-run.`);
}

rule("-");
log(`NOT A DEALER — ${unmatched.length} user(s) with no dealer whose name matches no dealer row`);
rule("-");
log(`  These stay null. They are people (or migration placeholders), not selling entities,`);
log(`  and which dealer they belong to is a Harmon question. Full list with record counts:`);
log(`  docs/access-model-phase1-unattributed-reps.md\n`);
const withRecords = unmatched
  .map((x) => ({ ...x, total: x.counts.customer + x.counts.solar }))
  .filter((x) => x.total > 0)
  .sort((a, b) => b.total - a.total);
log(`  ${withRecords.length} of them carry records:`);
for (const x of withRecords.slice(0, 10)) {
  log(`    ${x.fullName.slice(0, 33).padEnd(34)} ${String(x.counts.customer || "").padStart(6)} cust ${String(x.counts.solar || "").padStart(6)} solar`);
}
if (withRecords.length > 10) log(`    ... and ${withRecords.length - 10} more`);

// ---------------------------------------------------------------------------
// APPLY
// ---------------------------------------------------------------------------
rule();
log(APPLY ? "APPLYING" : "REPORT ONLY — nothing written (pass --apply)");
log(`  ${matched.length} user record(s), ONE field each (Dealer__c)`);
rule();

if (!APPLY) {
  log("\n  Review the table above, then re-run with --apply.\n");
  process.exit(0);
}
if (matched.length === 0) {
  log("\n  nothing to do.\n");
  process.exit(0);
}

/**
 * Compare two snapshots of the same record across EVERY compared field.
 * @returns {string[]} human-readable drift lines, empty when identical.
 */
function diffRecord(pre, post) {
  const drift = [];
  for (const f of COMPARE_FIELDS) {
    const a = pre[f] ?? null;
    const b = post[f] ?? null;
    if (a !== b) drift.push(`${f}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
  return drift;
}

async function readOne(id) {
  const [r] = await readUsers(`Id = '${soqlEscapeString(id)}'`);
  return r ?? null;
}

/**
 * CANARY (CLAUDE.md). Write ONE record and diff every compared field.
 *
 * Sundial_User__c is the object the fixture seeder's canary already covers for CREATES;
 * this is the first script to bulk-UPDATE it, and an update fires a different set of
 * record-triggered automation than an insert. The integration user cannot read
 * FlowDefinitionView, so this is the only way to ask.
 *
 * A re-read that returns NO ROW is a script or permissions failure, NOT automation.
 * Those produce identical all-null diffs and need opposite responses -- conflating them
 * is a mistake backfill-dealers.mjs made on its first run.
 */
async function canaryStamp(m) {
  log(`\n  CANARY — ${m.fullName} (${m.u.Id}) alone first`);
  const pre = await readOne(m.u.Id);
  if (!pre) {
    log(`  ** re-read found no such record BEFORE writing. Script bug, not automation. STOPPING. **`);
    return false;
  }
  log(`     before  Dealer__c=${JSON.stringify(pre.Dealer__c ?? null)} Active__c=${pre.Active__c} ` +
      `Access_Level__c=${JSON.stringify(pre.Access_Level__c ?? null)} Hierarchy_Level__c=${JSON.stringify(pre.Hierarchy_Level__c ?? null)}`);

  await sfUpdateRecord("Sundial_User__c", m.u.Id, { Dealer__c: m.dealer.Id });

  const post = await readOne(m.u.Id);
  if (!post) {
    log(`  ** re-read found no record AFTER writing. Script bug or permissions, not automation. STOPPING. **`);
    return false;
  }
  log(`     after   Dealer__c=${JSON.stringify(post.Dealer__c ?? null)} Active__c=${post.Active__c} ` +
      `Access_Level__c=${JSON.stringify(post.Access_Level__c ?? null)} Hierarchy_Level__c=${JSON.stringify(post.Hierarchy_Level__c ?? null)}`);

  if (post.Dealer__c !== m.dealer.Id) {
    log(`  ** the write did not stick: Dealer__c reads ${JSON.stringify(post.Dealer__c)}. STOPPING. **`);
    return false;
  }
  const drift = diffRecord(pre, post).filter((d) => !d.startsWith("Dealer__c:"));
  if (drift.length) {
    log(`\n  ** ${drift.length} FIELD(S) THIS SCRIPT DID NOT WRITE CHANGED: **`);
    for (const d of drift) log(`     ${d}`);
    log(`     Automation is live on Sundial_User__c updates. STOPPING after one record.`);
    return false;
  }
  log(`     -> Dealer__c set; all ${COMPARE_FIELDS.length - 1} other field(s) byte-identical. Proceeding.`);
  return true;
}

const ok = await canaryStamp(matched[0]);
if (!ok) {
  log(`\n  1 of ${matched.length} written (the canary). The other ${matched.length - 1} are untouched.\n`);
  process.exit(1);
}

// 37 records is few enough to verify EVERY one rather than sampling. The whole point of
// this script is that it touched one field; asserting that on the canary alone would
// leave 36 records where it is a claim.
const failures = [];
const drifted = [];
let applied = 1;

for (const m of matched.slice(1)) {
  try {
    const pre = await readOne(m.u.Id);
    await sfUpdateRecord("Sundial_User__c", m.u.Id, { Dealer__c: m.dealer.Id });
    const post = await readOne(m.u.Id);
    if (!post || post.Dealer__c !== m.dealer.Id) {
      failures.push({ name: m.fullName, id: m.u.Id, error: "write did not stick on re-read" });
      continue;
    }
    const drift = diffRecord(pre, post).filter((d) => !d.startsWith("Dealer__c:"));
    if (drift.length) drifted.push({ name: m.fullName, id: m.u.Id, drift });
    applied++;
  } catch (e) {
    failures.push({ name: m.fullName, id: m.u.Id, error: String(e.sfBody ?? e.message).slice(0, 160) });
  }
}

log(`\n  ${applied} of ${matched.length} user record(s) stamped.`);
log(`  every one re-read and diffed across ${COMPARE_FIELDS.length} field(s).`);

if (drifted.length) {
  log(`\n  ** ${drifted.length} record(s) had a field change that this script did not write: **`);
  for (const d of drifted) {
    log(`     ${d.name} (${d.id})`);
    for (const line of d.drift) log(`        ${line}`);
  }
  log(`     Automation on Sundial_User__c updates. Investigate before running anything else.`);
  process.exitCode = 1;
} else {
  log(`  NO drift: Dealer__c is the only field that moved on any of them.`);
}

if (failures.length) {
  log(`\n  ** ${failures.length} FAILURE(S) **`);
  for (const f of failures) log(`     ${f.name} (${f.id}): ${f.error}`);
  log(`\n  This script is IDEMPOTENT — it only selects users with a NULL Dealer__c.`);
  log(`  Re-running is the correct recovery.`);
  process.exitCode = 1;
} else if (!drifted.length) {
  log(`\n  Next: node scripts/backfill-deal-ownership.mjs   (report only by default)\n`);
}
