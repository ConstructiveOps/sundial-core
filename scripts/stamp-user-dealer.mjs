// Stamp Dealer__c on an EXPLICIT list of Sundial_User__c records. D-064 §2.3a, item 3 of the
// 2026-09-16 Dealer__c null-attribution cleanup.
//
//   node scripts/stamp-user-dealer.mjs           # REPORT ONLY (dry run). Default.
//   node scripts/stamp-user-dealer.mjs --apply   # writes -- only with Tim's go
//
//   --snapshot-out <file>  dry run: save every planned user's full field read as JSON
//   --snapshot-in  <file>  apply: abort the run if any user to be written differs from it
//                          in ANY field -- "changed since the dry-run report", enforced
//                          across processes rather than only within one
//   --only <userId>        apply to that one user (the canary run), nothing else
//
// WHY A NEW SCRIPT AND NOT stamp-dealer-named-users.mjs
//
// That script (2026-08-27) matches EVERY null-dealer user's name against EVERY dealer row
// and stamps whatever resolves. It did its job -- 37 users -- and re-running it now would
// stamp whatever the alias file happens to make resolve, with no list anybody approved.
// This one takes a closed plan: the `User` rows of docs/integrations/dealer-aliases.csv
// (approved by Tim 2026-09-16) plus the two named people below. Nothing else is eligible.
// It also ABORTS THE WHOLE RUN on any drift, where the older script reported and went on.
//
// WHAT IT PLANS
//
//   - each `User` alias row: the Sundial_User__c whose Name is the alias, and the
//     Sundial_Dealer__c whose Name is the canonical. Exactly one of each, or the row is
//     skipped with the reason. Name is matched exactly; First_Name__c + Last_Name__c is
//     reported as a second key so a mismatch between the two is visible, never guessed at.
//   - Ralph Romano and Ben Wollschlager -> Harmon Solar (Tim, 2026-09-16). Their Name is
//     their email address, so they resolve on First/Last name. They are tenant-scope
//     (Executive / Admin): lib/access.js never reads a tenant role's dealer, so the stamp
//     does NOT change what they see -- it changes, through backfill pass 1 (A1), which
//     dealer their deals are attributed to, and so what Harmon Solar's dealer-scope users
//     see. The report counts both.
//
// ⚠️ ONE FIELD: Dealer__c. A user with a DIFFERENT dealer already is skipped, never
// overwritten -- re-attributing someone is a decision, not a fill.
//
// ⚠️ THE ASSERTION. Before and after every write the record is re-read across every
// scalar field describe reports (minus Salesforce's own audit stamps), and the named
// access fields -- Active__c, Access_Level__c, Super_Admin__c, Hierarchy_Level__c,
// Sales_Rep__c where the object has it -- are printed. ANY field other than Dealer__c
// that differs aborts the ENTIRE run at that record. Canary first per CLAUDE.md.

import { sfQuery, sfUpdateRecord, describeObject, soqlEscapeString } from "../lib/salesforce.js";
import { loadDealerAliases } from "./dealer-aliases.mjs";

const APPLY = process.argv.includes("--apply");
const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) { console.error(`${flag} needs a value`); process.exit(2); }
  return v;
};
const SNAPSHOT_OUT = argValue("--snapshot-out");
const SNAPSHOT_IN = argValue("--snapshot-in");
const ONLY = argValue("--only");
const TENANT_ID = "a1W7y000007AszBEAS";
const T = soqlEscapeString(TENANT_ID);

// Approved by Tim 2026-09-16. Not aliases: people, stamped to the internal dealer.
const PEOPLE = [
  { first: "Ralph", last: "Romano", dealerName: "Harmon Solar" },
  { first: "Ben", last: "Wollschlager", dealerName: "Harmon Solar" },
];

const WATCHED = ["Active__c", "Access_Level__c", "Super_Admin__c", "Hierarchy_Level__c", "Sales_Rep__c"];
// Same list, same reasoning, as stamp-dealer-named-users.mjs: moved by Salesforce on any
// write or read, and unable to carry data.
const EXPECTED_TO_CHANGE = new Set(["LastModifiedDate", "LastModifiedById", "SystemModstamp", "LastViewedDate", "LastReferencedDate"]);

const log = (...a) => console.log(...a);
const rule = (c = "=") => log(c.repeat(100));

// ---------------------------------------------------------------------------
// Field sets
// ---------------------------------------------------------------------------
const desc = await describeObject("Sundial_User__c");
const fieldNames = new Set(desc.fields.map((f) => f.name));
const watched = WATCHED.filter((f) => fieldNames.has(f));
const missingWatched = WATCHED.filter((f) => !fieldNames.has(f));
const COMPARE = desc.fields
  .filter((f) => !f.compound && f.type !== "address" && f.type !== "location")
  .map((f) => f.name)
  .filter((n) => !EXPECTED_TO_CHANGE.has(n));

rule();
log("STAMP USER DEALER — explicit plan");
rule();
log(`  tenant   ${TENANT_ID}`);
log(`  mode     ${APPLY ? "APPLY (this WRITES)" : "REPORT ONLY / DRY RUN (pass --apply to write)"}`);
log(`  writes   Dealer__c only; ${COMPARE.length} fields compared per record, any drift aborts the run`);
log(`  watched  ${watched.join(", ")}`);
if (missingWatched.length) log(`  NOT A FIELD on Sundial_User__c (reported, cannot be watched): ${missingWatched.join(", ")}`);

// ---------------------------------------------------------------------------
// Resolve the plan
// ---------------------------------------------------------------------------
const users = await sfQuery(`SELECT ${COMPARE.join(", ")} FROM Sundial_User__c WHERE Client__c = '${T}'`);
const dealers = await sfQuery(`SELECT Id, Name, Active__c FROM Sundial_Dealer__c WHERE Client__c = '${T}'`);
const dealerById = new Map(dealers.map((d) => [d.Id, d]));
const dLabel = (id) => (id ? `${dealerById.get(id)?.Name ?? id}${dealerById.get(id)?.Active__c === false ? " [inactive]" : ""}` : "(null)");
const fullName = (u) => `${u.First_Name__c ?? ""} ${u.Last_Name__c ?? ""}`.trim();

const aliasRows = loadDealerAliases().rows.filter((r) => r.object === "User");
const planInput = [
  ...aliasRows.map((r) => ({ source: "alias", userKey: r.alias, dealerName: r.dealerName })),
  ...PEOPLE.map((p) => ({ source: "person", userKey: `${p.first} ${p.last}`, dealerName: p.dealerName })),
];

const plan = [];
for (const p of planInput) {
  const byName = users.filter((u) => u.Name === p.userKey);
  const byFull = users.filter((u) => fullName(u) === p.userKey);
  // Aliases are matched on Name (Tim's rule); people on First/Last (their Name is an email).
  const hits = p.source === "alias" ? byName : byFull;
  const other = p.source === "alias" ? byFull : byName;
  const dealerHits = dealers.filter((d) => d.Name === p.dealerName);
  const row = { ...p, userHits: hits.length, dealerHits: dealerHits.length, user: hits[0] ?? null, dealer: dealerHits[0] ?? null };

  if (hits.length !== 1) row.status = `skipped(${hits.length} users match)`;
  else if (dealerHits.length !== 1) row.status = `skipped(${dealerHits.length} dealers named "${p.dealerName}")`;
  else if (other.length && other.some((u) => u.Id !== hits[0].Id)) row.status = "skipped(Name and First/Last resolve to different users)";
  else if (row.user.Dealer__c === row.dealer.Id) row.status = "already-set";
  else if (row.user.Dealer__c) row.status = `skipped(has a different dealer: ${dLabel(row.user.Dealer__c)})`;
  else row.status = "would-change";
  plan.push(row);
}

// ---------------------------------------------------------------------------
// Report: resolution detail
// ---------------------------------------------------------------------------
rule("-");
log("RESOLUTION");
rule("-");
for (const r of plan) {
  log(`  [${r.source}] "${r.userKey}" -> "${r.dealerName}"`);
  log(`      user    ${r.userHits === 1 ? `${r.user.Id}  Name=${JSON.stringify(r.user.Name)}` : `${r.userHits} MATCHES`}`);
  log(`      dealer  ${r.dealerHits === 1 ? `${r.dealer.Id}  ${dLabel(r.dealer.Id)}` : `${r.dealerHits} MATCHES`}`);
  if (r.user) {
    log(`      current Dealer__c ${dLabel(r.user.Dealer__c)}`);
    log(`      ${watched.map((f) => `${f}=${JSON.stringify(r.user[f] ?? null)}`).join("  ")}`);
  }
  log(`      -> ${r.status}`);
}

// ---------------------------------------------------------------------------
// Report: summary table
// ---------------------------------------------------------------------------
rule("-");
log("SUMMARY");
rule("-");
log(`  ${"user".padEnd(28)} ${"current Dealer__c".padEnd(30)} ${"proposed Dealer__c".padEnd(32)} status`);
for (const r of plan) {
  log(`  ${(r.user ? (r.source === "person" ? fullName(r.user) : r.user.Name) : r.userKey).slice(0, 27).padEnd(28)} ` +
      `${(r.user ? dLabel(r.user.Dealer__c) : "-").slice(0, 29).padEnd(30)} ${(r.dealer ? dLabel(r.dealer.Id) : "-").slice(0, 31).padEnd(32)} ${r.status}`);
}
const writes = plan.filter((r) => r.status === "would-change");
log(`\n  ${writes.length} would-change, ${plan.filter((r) => r.status === "already-set").length} already-set, ` +
    `${plan.filter((r) => r.status.startsWith("skipped")).length} skipped`);

// ---------------------------------------------------------------------------
// Report: what backfill pass 1 would do once these users carry a dealer (simulated)
// ---------------------------------------------------------------------------
// Pure A1 arithmetic over live rows: a record whose rep is in the write plan and whose
// Dealer__c is null would be SET to the planned dealer. Nothing else moves.
rule("-");
log("PASS 1 PREVIEW (simulated — what `backfill-deal-ownership.mjs --pass1-only --apply` would set after the stamp)");
rule("-");
const planned = new Map(writes.map((r) => [r.user.Id, r]));
const perUser = new Map();
let solarOrphansResolved = 0;
const solarAfter = { repOwnedNull: 0, resolved: 0 };
for (const [obj, label] of [["Sundial_Customer__c", "customer"], ["Sundial_Solar__c", "solar"]]) {
  const rows = await sfQuery(
    `SELECT Sales_Rep__c r, COUNT(Id) c FROM ${obj} WHERE Client__c = '${T}' AND Dealer__c = null AND Sales_Rep__c != null GROUP BY Sales_Rep__c`
  );
  for (const x of rows) {
    if (label === "solar") solarAfter.repOwnedNull += Number(x.c);
    if (!planned.has(x.r)) continue;
    if (label === "solar") solarAfter.resolved += Number(x.c);
    const e = perUser.get(x.r) ?? { customer: 0, solar: 0 };
    e[label] = Number(x.c);
    perUser.set(x.r, e);
  }
}
log(`  ${"user".padEnd(28)} ${"-> dealer".padEnd(32)} ${"customer".padStart(8)} ${"solar".padStart(7)}`);
let tc = 0, ts = 0;
for (const r of writes) {
  const e = perUser.get(r.user.Id) ?? { customer: 0, solar: 0 };
  tc += e.customer; ts += e.solar;
  log(`  ${(r.source === "person" ? fullName(r.user) : r.user.Name).slice(0, 27).padEnd(28)} ${dLabel(r.dealer.Id).slice(0, 31).padEnd(32)} ${String(e.customer).padStart(8)} ${String(e.solar).padStart(7)}`);
}
log(`  ${"TOTAL".padEnd(61)} ${String(tc).padStart(8)} ${String(ts).padStart(7)}`);

// Who GAINS visibility: dealer-scope users of each ACTIVE target dealer. An inactive
// dealer's users resolve to scope `none` (§1.2), so attribution there grants nobody.
const activeTargets = [...new Set(writes.map((r) => r.dealer.Id))].filter((id) => dealerById.get(id)?.Active__c);
for (const id of activeTargets) {
  const aud = await sfQuery(
    `SELECT Id, Name, First_Name__c, Last_Name__c FROM Sundial_User__c WHERE Client__c = '${T}' AND Active__c = true ` +
      `AND Access_Level__c = 'Sales Dealer' AND Dealer__c = '${soqlEscapeString(id)}'`
  );
  log(`\n  ACTIVE dealer ${dLabel(id)}: ${aud.length} active dealer-scope user(s) would see these records` +
      (aud.length ? `: ${aud.map((u) => fullName(u) || u.Name).join(", ")}` : ""));
}

// Solar, split the way item 3 asks: rep-less (pass 2's domain, untouched by any user
// stamp) and rep-owned (pass 1's domain, which this stamp feeds).
const aliases = loadDealerAliases();
const { normalizeDealerName, resolveDealerName } = await import("./dealer-aliases.mjs");
const dealerByNorm = new Map(dealers.map((d) => [normalizeDealerName(d.Name), d]));
const solarNull = await sfQuery(
  `SELECT Id, Sales_Rep__c, Sales_Company_Harmon_Solar_or_Third__c FROM Sundial_Solar__c WHERE Client__c = '${T}' AND Dealer__c = null`
);
const repLess = solarNull.filter((s) => !s.Sales_Rep__c);
const repLessResolvable = repLess.filter((s) => s.Sales_Company_Harmon_Solar_or_Third__c &&
  dealerByNorm.get(normalizeDealerName(resolveDealerName(s.Sales_Company_Harmon_Solar_or_Third__c, aliases.byAlias))));
const repOwned = solarNull.filter((s) => s.Sales_Rep__c);
const repOwnedResolved = repOwned.filter((s) => planned.has(s.Sales_Rep__c));
const remaining = repOwned.filter((s) => !planned.has(s.Sales_Rep__c));

log("");
log(`  SOLAR with null Dealer__c: ${solarNull.length}`);
log(`    rep-less                          ${String(repLess.length).padStart(6)}   (pass 2's domain — a user stamp cannot reach these)`);
log(`      of which pass 2 would resolve   ${String(repLessResolvable.length).padStart(6)}   (exact match via alias file; pass 2 is NOT in this plan)`);
log(`      of which no/unmatched company   ${String(repLess.length - repLessResolvable.length).padStart(6)}`);
log(`    rep-owned (rep has no dealer)     ${String(repOwned.length).padStart(6)}`);
log(`      would resolve after the stamp   ${String(repOwnedResolved.length).padStart(6)}`);
log(`      remain unresolved               ${String(remaining.length).padStart(6)}`);

const unresolvedValues = new Map();
for (const s of remaining) {
  const v = s.Sales_Company_Harmon_Solar_or_Third__c ?? "(blank)";
  unresolvedValues.set(v, (unresolvedValues.get(v) ?? 0) + 1);
}
log(`\n  sales-company values on the rep-owned Solar that remain unresolved (${unresolvedValues.size} distinct):`);
for (const [v, n] of [...unresolvedValues].sort((a, b) => b[1] - a[1])) log(`    ${String(n).padStart(6)}  ${v}`);

// ---------------------------------------------------------------------------
// APPLY
// ---------------------------------------------------------------------------
rule();
log(APPLY ? "APPLYING" : "DRY RUN — nothing written (pass --apply)");
log(`  ${writes.length} user record(s), Dealer__c only`);
rule();
if (!APPLY) {
  if (SNAPSHOT_OUT) {
    const { writeFileSync } = await import("node:fs");
    const snap = Object.fromEntries(plan.filter((r) => r.user).map((r) => [r.user.Id, r.user]));
    writeFileSync(SNAPSHOT_OUT, JSON.stringify({ takenAt: new Date().toISOString(), users: snap }, null, 1));
    log(`  snapshot of ${Object.keys(snap).length} user(s) written to ${SNAPSHOT_OUT}`);
  }
  process.exit(0);
}
if (writes.length === 0) { log("  nothing to do."); process.exit(0); }

const readOne = async (id) => (await sfQuery(`SELECT ${COMPARE.join(", ")} FROM Sundial_User__c WHERE Id = '${soqlEscapeString(id)}'`))[0] ?? null;
const drift = (a, b) => COMPARE.filter((f) => f !== "Dealer__c" && (a[f] ?? null) !== (b[f] ?? null))
  .map((f) => `${f}: ${JSON.stringify(a[f] ?? null)} -> ${JSON.stringify(b[f] ?? null)}`);

let snapshot = null;
if (SNAPSHOT_IN) {
  const { readFileSync } = await import("node:fs");
  snapshot = JSON.parse(readFileSync(SNAPSHOT_IN, "utf8")).users;
  log(`  comparing against dry-run snapshot ${SNAPSHOT_IN}`);
}
let runWrites = writes;
if (ONLY) {
  runWrites = writes.filter((r) => r.user.Id === ONLY);
  if (runWrites.length !== 1) { log(`  ** --only ${ONLY} is not a would-change row in this plan. ABORTING. **`); process.exit(1); }
  log(`  --only ${ONLY}: 1 of ${writes.length} planned write(s) in this run`);
}

// One row per attempted user, printed however the run ends.
const results = [];
const table = () => {
  log("");
  log(`  ${"user".padEnd(28)} ${"old Dealer__c".padEnd(16)} ${"new Dealer__c".padEnd(46)} invariance`);
  for (const x of results) log(`  ${x.name.slice(0, 27).padEnd(28)} ${x.old.padEnd(16)} ${x.now.slice(0, 45).padEnd(46)} ${x.result ?? "(not reached)"}`);
};
const abort = (msg) => { if (msg) log(msg); table(); process.exit(1); };

let written = 0;
for (const [i, r] of runWrites.entries()) {
  const label = i === 0 ? "CANARY" : "write ";
  const pre = await readOne(r.user.Id);
  const name = r.source === "person" ? fullName(r.user) : r.user.Name;
  if (!pre) abort(`  ** ${r.user.Id} not readable before the write. ABORTING the run. **`);
  if (snapshot) {
    const snap = snapshot[r.user.Id];
    if (!snap) abort(`  ** ${r.user.Id} (${name}) is not in the dry-run snapshot. ABORTING the run. **`);
    const since = COMPARE.filter((f) => (snap[f] ?? null) !== (pre[f] ?? null))
      .map((f) => `${f}: ${JSON.stringify(snap[f] ?? null)} -> ${JSON.stringify(pre[f] ?? null)}`);
    if (since.length) abort(`  ** ${r.user.Id} (${name}) changed since the dry-run snapshot: ${since.join("; ")}. ABORTING the run. **`);
  }
  // Re-check the plan against the fresh read: the org may have moved since the report.
  if ((pre.Dealer__c ?? null) !== null) {
    abort(`  ** ${r.user.Id} now has Dealer__c ${dLabel(pre.Dealer__c)}. ABORTING the run — re-run the report. **`);
  }
  const preDrift = drift(r.user, pre);
  if (preDrift.length) {
    abort(`  ** ${r.user.Id} changed since the report: ${preDrift.join("; ")}. ABORTING the run. **`);
  }

  await sfUpdateRecord("Sundial_User__c", r.user.Id, { Dealer__c: r.dealer.Id });
  const post = await readOne(r.user.Id);
  log(`  ${label} ${r.user.Id} ${String(r.user.Name).slice(0, 30)} -> ${dLabel(r.dealer.Id)}`);
  log(`         before ${watched.map((f) => `${f}=${JSON.stringify(pre[f] ?? null)}`).join(" ")}`);
  log(`         after  ${post ? watched.map((f) => `${f}=${JSON.stringify(post[f] ?? null)}`).join(" ") : "(no row)"}`);
  const row = { name, old: pre.Dealer__c ?? "(null)", now: post?.Dealer__c ? `${post.Dealer__c} ${dLabel(post.Dealer__c)}` : "(null)" };
  results.push(row);
  if (!post || post.Dealer__c !== r.dealer.Id) {
    row.result = "FAIL (write did not stick)";
    abort(`  ** the write did not stick on re-read. ABORTING the run after ${written + 1} write(s). **`);
  }
  const d = drift(pre, post);
  if (d.length) {
    row.result = `FAIL (${d.length} other field(s) changed)`;
    log(`  ** ${d.length} FIELD(S) THIS SCRIPT DID NOT WRITE CHANGED — ABORTING the run: **`);
    for (const x of d) log(`       ${x}`);
    abort("");
  }
  row.result = `PASS (${COMPARE.length - 1} other fields identical)`;
  written++;
}
table();
log(`\n  ${written} of ${runWrites.length} written this run; every record re-read, Dealer__c the only field that moved.`);
log(`  Next: node scripts/backfill-deal-ownership.mjs --pass1-only   (report), then --apply.`);
