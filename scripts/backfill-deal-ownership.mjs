// Phase 1 item 4 — set Dealer__c on Sundial_Customer__c and Sundial_Solar__c.
// D-064 amendments A1/A2/A3, docs/access-model.md §2.4.
//
//   node scripts/backfill-deal-ownership.mjs           # REPORT ONLY. Default.
//   node scripts/backfill-deal-ownership.mjs --apply   # writes
//
// TWO PASSES, AND THE FIRST ONE IS THE RULE
//
//   PASS 1 (A1) — BOTH OBJECTS, from the rep:
//       Dealer__c := Sales_Rep__r.Dealer__c
//     for every record that HAS a Sales_Rep__c. If that rep has no dealer, the deal is
//     LEFT NULL. The derivation is never guessed at from anything else.
//
//   PASS 2 (A2) — SOLAR ONLY, rep-less records only:
//     for a Sundial_Solar__c row with NO Sales_Rep__c but a populated
//     Sales_Company_Harmon_Solar_or_Third__c, resolve the value through
//     docs/integrations/dealer-aliases.csv and then by exact name against the
//     Sundial_Dealer__c rows. Exact matches auto-map. NEAR-MISSES ARE LISTED FOR
//     APPROVAL AND NEVER AUTO-APPLIED. Anything else stays null.
//
//     Customer is deliberately excluded from pass 2: Dealer_Name__c is populated on 13
//     of 31,637 rows, so the pass would do almost nothing while adding a whole class of
//     name-matching risk to the object that carries the tenant's entire book.
//
// ⚠️ A BLANK STAYS NULL. Never defaulted to Harmon, on either object. A null Dealer__c
// is invisible to every sales role and visible to tenant scope -- fail closed, the same
// "blank => NULL, never the default" rule D19 applies to commissions. A record nobody
// has attributed is better shown as unattributed than quietly handed to somebody.
//
// ⚠️ THE A3 ABORT. Before anything is planned, this compares Dennis Alessandro's
// visible id SET under the legacy name match against the set under Sales_Rep__c, on both
// objects, and ABORTS if they differ. Phase 0 measured them identical (3,534 Customer,
// 777 Solar, zero difference either way), so there is nothing for this script to do for
// him -- but that was a point-in-time snapshot of a LIVE org. One record created or
// reassigned since breaks the equality, and the failure would be silent: the backfill
// would complete, the report would look ordinary, and the one live restricted user would
// quietly stop seeing records. An abort makes it a question instead of a support ticket.
//
// ⚠️ THE RECALC FLOW (CLAUDE.md). Sundial_Budget_Recalc_Trigger fires on
// Sundial_Solar__c writes. It is a DRAFT and the SF->AWS relay was never wired, so today
// a bulk Solar write fans out to nothing -- but that is an accident of sequencing, not a
// design property, and Dealer__c is a brand-new field that no existing Flow can list as
// an ISCHANGED input. The canary is what carries this forward when nobody remembers:
// one record is written alone and re-read, and the run stops if anything the script did
// not write comes back changed.

import {
  sfQuery,
  sfUpdateRecord,
  soqlEscapeString,
} from "../lib/salesforce.js";
import { loadDealerAliases, normalizeDealerName, resolveDealerName } from "./dealer-aliases.mjs";

const APPLY = process.argv.includes("--apply");

// --limit N: write at most N records this run, then stop cleanly and report what is
// left. Added because two unattended runs were stopped part-way by the environment
// rather than by anything wrong -- 2,500 and 360 records in, no failures either time.
//
// It is safe ONLY because this script is idempotent: it re-reads the org every run and
// plans only records that still need a write, so N chunks of a run and one long run end
// in the same place. A bounded chunk that finishes and reports beats an unbounded one
// that is killed and cannot.
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  if (i === -1) return Infinity;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n) || n < 1) {
    console.error("--limit needs a positive integer");
    process.exit(2);
  }
  return n;
})();
const TENANT_ID = "a1W7y000007AszBEAS";

// docs/access-model.md §2.4a. The gate for the whole migration.
const DENNIS = {
  id: "a1O7y00000s5sK1EAI",
  name: "Dennis Alessandro",
  customerNameField: "Sunbase_Sales_Rep__c",
  solarNameField: "Sales_Representative__c",
};

const OBJECTS = {
  customer: {
    sfObject: "Sundial_Customer__c",
    label: "Customer",
    // Pass 2 does NOT run here — see the header.
    salesCompanyField: null,
  },
  solar: {
    sfObject: "Sundial_Solar__c",
    label: "Solar",
    salesCompanyField: "Sales_Company_Harmon_Solar_or_Third__c",
  },
};

const log = (...a) => console.log(...a);
const rule = (c = "=") => log(c.repeat(88));
const pct = (n, d) => (d === 0 ? "  0.0%" : `${((n / d) * 100).toFixed(1).padStart(5)}%`);

// ---------------------------------------------------------------------------
// A3 — the abort check
// ---------------------------------------------------------------------------

async function idSet(sfObject, whereClause) {
  const rows = await sfQuery(
    `SELECT Id FROM ${sfObject} WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND ${whereClause}`
  );
  return new Set(rows.map((r) => r.Id));
}

/**
 * Compare the legacy NAME match against the authoritative ID match, as SETS.
 *
 * Counts are not enough and the reason is worth stating: two DISJOINT sets of 3,534 rows
 * pass a count check and would lose him every record he has. §2.4a compares id sets for
 * exactly this reason, and so does this.
 */
async function checkDennis() {
  rule();
  log("A3 — DENNIS GATE (must pass before anything is planned)");
  rule();

  const results = [];
  for (const [key, o] of Object.entries(OBJECTS)) {
    const nameField = key === "customer" ? DENNIS.customerNameField : DENNIS.solarNameField;
    const byName = await idSet(o.sfObject, `${nameField} = '${soqlEscapeString(DENNIS.name)}'`);
    const byId = await idSet(o.sfObject, `Sales_Rep__c = '${soqlEscapeString(DENNIS.id)}'`);
    const onlyInOld = [...byName].filter((id) => !byId.has(id));
    const onlyInNew = [...byId].filter((id) => !byName.has(id));
    results.push({ label: o.label, nameField, byName: byName.size, byId: byId.size, onlyInOld, onlyInNew });
  }

  log(`  ${"object".padEnd(10)} ${"legacy name match".padStart(18)} ${"Sales_Rep__c match".padStart(19)} ${"onlyInOld".padStart(10)} ${"onlyInNew".padStart(10)}`);
  for (const r of results) {
    log(
      `  ${r.label.padEnd(10)} ${String(r.byName).padStart(18)} ${String(r.byId).padStart(19)} ` +
        `${String(r.onlyInOld.length).padStart(10)} ${String(r.onlyInNew.length).padStart(10)}`
    );
  }

  const broken = results.filter((r) => r.onlyInOld.length > 0 || r.onlyInNew.length > 0);
  if (broken.length === 0) {
    log(`\n  PASS — identical id sets on both objects. Nothing for this backfill to do for Dennis,`);
    log(`  and Phase 3's enforce step cannot change what he sees.`);
    return true;
  }

  log(`\n  ** ABORT — the sets are NO LONGER IDENTICAL. **`);
  for (const r of broken) {
    if (r.onlyInOld.length) {
      log(`\n  ${r.label}: ${r.onlyInOld.length} record(s) the LEGACY rule serves him and the new one does NOT.`);
      log(`     These are records he can see today and would LOSE. Sample:`);
      for (const id of r.onlyInOld.slice(0, 20)) log(`       ${id}`);
      if (r.onlyInOld.length > 20) log(`       ... and ${r.onlyInOld.length - 20} more`);
    }
    if (r.onlyInNew.length) {
      log(`\n  ${r.label}: ${r.onlyInNew.length} record(s) the NEW rule serves him and the legacy one does not.`);
      log(`     These are records he would GAIN — a widening, which §7 forbids. Sample:`);
      for (const id of r.onlyInNew.slice(0, 20)) log(`       ${id}`);
      if (r.onlyInNew.length > 20) log(`       ... and ${r.onlyInNew.length - 20} more`);
    }
  }
  log(
    `\n  Phase 0 measured these sets as identical on 2026-08-27. Something has changed since:\n` +
      `  a record created, reassigned, or renamed. Reconcile it before backfilling — this\n` +
      `  script will not proceed past a moving gate.`
  );
  return false;
}

const dennisOk = await checkDennis();
if (!dennisOk) process.exit(1);

// ---------------------------------------------------------------------------
// Load the dealer rows and the alias file
// ---------------------------------------------------------------------------
const aliases = loadDealerAliases();
const dealerRows = await sfQuery(
  `SELECT Id, Name, Active__c FROM Sundial_Dealer__c WHERE Client__c = '${soqlEscapeString(TENANT_ID)}'`
);
const dealerByNormName = new Map(dealerRows.map((d) => [normalizeDealerName(d.Name), d]));
const dealerById = new Map(dealerRows.map((d) => [d.Id, d]));

rule();
log("BACKFILL DEAL OWNERSHIP — survey");
rule();
log(`  tenant  ${TENANT_ID}`);
log(`  mode    ${APPLY ? "APPLY (this WRITES)" : "REPORT ONLY (pass --apply to write)"}`);
log(`  dealers ${dealerRows.length} row(s), ${dealerRows.filter((d) => d.Active__c).length} active`);
log(`  aliases ${aliases.rows.length} reviewed merge(s)`);
if (dealerRows.length === 0) {
  log(`\n  ** No Sundial_Dealer__c rows. Run scripts/backfill-dealers.mjs --apply first. **`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------
// Outcome keys, in report order. Every record lands in exactly one.
const OUTCOMES = [
  ["set_from_rep", "SET from the rep (A1)"],
  ["set_from_alias", "SET from the sales company (A2, Solar only)"],
  ["already_correct", "already correct — no write"],
  ["restamp", "RE-STAMP — Dealer__c disagrees with the rep"],
  ["rep_has_no_dealer", "left null — the rep has no dealer"],
  ["no_rep_no_company", "left null — no rep and no sales company"],
  ["no_rep_company_unmatched", "left null — sales company matches no dealer"],
  ["would_clear", "left alone — has a dealer, nothing to derive one from"],
];

async function planObject(key) {
  const o = OBJECTS[key];
  const fields = [
    "Id",
    "Name",
    "Sales_Rep__c",
    "Sales_Rep__r.Dealer__c",
    "Sales_Rep__r.First_Name__c",
    "Sales_Rep__r.Last_Name__c",
    "Dealer__c",
    ...(o.salesCompanyField ? [o.salesCompanyField] : []),
  ];
  const rows = await sfQuery(
    `SELECT ${fields.join(", ")} FROM ${o.sfObject} WHERE Client__c = '${soqlEscapeString(TENANT_ID)}'`
  );

  const counts = Object.fromEntries(OUTCOMES.map(([k]) => [k, 0]));
  const writes = [];
  const unmatchedCompanies = new Map(); // raw value -> count
  const repsWithoutDealer = new Map(); // "First Last" -> count

  for (const r of rows) {
    const current = r.Dealer__c ?? null;
    const repDealer = r.Sales_Rep__r?.Dealer__c ?? null;

    if (r.Sales_Rep__c) {
      if (repDealer) {
        if (current === repDealer) counts.already_correct++;
        else {
          // A record whose Dealer__c disagrees with its rep's dealer. On this first run
          // every deal's Dealer__c is null so this is just "set"; the distinction exists
          // because invariant 2 (§2.3) re-stamps on reassignment, and a re-run of this
          // script after a rep move must show that as a RE-STAMP, not as a fresh set.
          counts[current ? "restamp" : "set_from_rep"]++;
          writes.push({ id: r.Id, name: r.Name, dealerId: repDealer, why: current ? "restamp" : "rep" });
        }
      } else {
        counts.rep_has_no_dealer++;
        const who = `${r.Sales_Rep__r?.First_Name__c ?? ""} ${r.Sales_Rep__r?.Last_Name__c ?? ""}`.trim() || r.Sales_Rep__c;
        repsWithoutDealer.set(who, (repsWithoutDealer.get(who) ?? 0) + 1);
      }
      continue;
    }

    // No rep. Pass 2 applies to Solar only.
    const company = o.salesCompanyField ? r[o.salesCompanyField] : null;
    if (!company) {
      counts[current ? "would_clear" : "no_rep_no_company"]++;
      continue;
    }
    const canonical = resolveDealerName(company, aliases.byAlias);
    const dealer = dealerByNormName.get(normalizeDealerName(canonical));
    if (!dealer) {
      counts.no_rep_company_unmatched++;
      unmatchedCompanies.set(company, (unmatchedCompanies.get(company) ?? 0) + 1);
      continue;
    }
    if (current === dealer.Id) counts.already_correct++;
    else {
      counts.set_from_alias++;
      writes.push({ id: r.Id, name: r.Name, dealerId: dealer.Id, why: "company", company, canonical });
    }
  }

  return { key, o, total: rows.length, counts, writes, unmatchedCompanies, repsWithoutDealer };
}

const plans = [];
for (const key of Object.keys(OBJECTS)) plans.push(await planObject(key));

// ---------------------------------------------------------------------------
// Report — counts by outcome
// ---------------------------------------------------------------------------
for (const p of plans) {
  rule("-");
  log(`${p.o.label} (${p.o.sfObject}) — ${p.total.toLocaleString()} record(s)`);
  rule("-");
  for (const [k, label] of OUTCOMES) {
    const n = p.counts[k];
    if (n === 0 && !["set_from_rep", "rep_has_no_dealer"].includes(k)) continue;
    log(`  ${String(n).padStart(7)}  ${pct(n, p.total)}  ${label}`);
  }
  const sum = Object.values(p.counts).reduce((a, b) => a + b, 0);
  log(`  ${String(sum).padStart(7)}          (total, must equal ${p.total.toLocaleString()})`);
  if (sum !== p.total) log(`  ** ACCOUNTING ERROR: outcomes sum to ${sum}, not ${p.total}. **`);
  log(`\n  writes planned: ${p.writes.length.toLocaleString()}`);
}

// ---------------------------------------------------------------------------
// The reps who have no dealer — the number that decides how much this achieves
// ---------------------------------------------------------------------------
rule("-");
log("REPS WITH NO DEALER — every record they own is left null");
rule("-");
log(
  "  A1 derives a deal's dealer from its rep, so a rep with no Dealer__c contributes\n" +
    "  nothing. These records stay unattributed and are invisible to every dealer-scope\n" +
    "  user (visible to tenant scope). That is fail-closed and correct, but it is also the\n" +
    "  number that says how much of the book this backfill actually attributes.\n"
);
const allReps = new Map();
for (const p of plans) {
  for (const [who, n] of p.repsWithoutDealer) {
    if (!allReps.has(who)) allReps.set(who, { customer: 0, solar: 0 });
    allReps.get(who)[p.key] = n;
  }
}
const repRows = [...allReps.entries()].sort(
  (a, b) => b[1].customer + b[1].solar - (a[1].customer + a[1].solar)
);
log(`  ${"rep".padEnd(34)} ${"customer".padStart(9)} ${"solar".padStart(7)}`);
for (const [who, c] of repRows.slice(0, 25)) {
  log(`  ${who.slice(0, 33).padEnd(34)} ${String(c.customer || "").padStart(9)} ${String(c.solar || "").padStart(7)}`);
}
if (repRows.length > 25) log(`  ... and ${repRows.length - 25} more rep(s)`);
log(`\n  ${repRows.length} distinct rep(s) carry records and have no dealer.`);
log(`  Stamping any of them (Manage Users, or a follow-up run of backfill-dealers.mjs)`);
log(`  and re-running this script attributes their records with no other change.`);

// ---------------------------------------------------------------------------
// Pass 2 detail: what matched, and the FULL near-miss list (A2)
// ---------------------------------------------------------------------------
rule("-");
log("PASS 2 (A2) — Solar, rep-less records, resolved through the alias file");
rule("-");
const solar = plans.find((p) => p.key === "solar");
const aliasWrites = solar.writes.filter((w) => w.why === "company");
log(`  ${aliasWrites.length} record(s) resolved by EXACT name after alias folding.`);
const byCanonical = new Map();
for (const w of aliasWrites) {
  const k = `${w.company}${w.company === w.canonical ? "" : `  ->  ${w.canonical}`}`;
  byCanonical.set(k, (byCanonical.get(k) ?? 0) + 1);
}
for (const [k, n] of [...byCanonical.entries()].sort((a, b) => b[1] - a[1])) {
  log(`    ${String(n).padStart(5)}  ${k}`);
}

log(`\n  UNMATCHED sales-company values — ${solar.unmatchedCompanies.size}. LEFT NULL, never guessed.`);
if (solar.unmatchedCompanies.size === 0) {
  log(`    none: every sales company on a rep-less Solar record resolves to a dealer row.`);
} else {
  for (const [v, n] of [...solar.unmatchedCompanies.entries()].sort((a, b) => b[1] - a[1])) {
    // The near-miss candidates for THIS value, so the list is actionable rather than a
    // bare "unmatched". Anything here is a decision for docs/integrations/dealer-aliases.csv.
    const norm = normalizeDealerName(v);
    const near = dealerRows
      .filter((d) => {
        const dn = normalizeDealerName(d.Name);
        return dn !== norm && (dn.startsWith(norm + " ") || norm.startsWith(dn + " "));
      })
      .map((d) => d.Name);
    log(`    ${String(n).padStart(5)}  ${JSON.stringify(v)}${near.length ? `   near: ${near.map((x) => JSON.stringify(x)).join(", ")}` : ""}`);
  }
  log(
    `\n  Each of these is a judgement about whether two spellings are one organization.\n` +
      `  A2 says that judgement goes in docs/integrations/dealer-aliases.csv, reviewed,\n` +
      `  never inferred here. Add the row, re-run, and the records resolve.`
  );
}

// ---------------------------------------------------------------------------
// What this buys, per dealer — the active ones are the only ones that grant anything
// ---------------------------------------------------------------------------
rule("-");
log("RESULTING OWNERSHIP, by dealer (planned + already correct)");
rule("-");
const perDealer = new Map();
for (const p of plans) {
  for (const w of p.writes) {
    if (!perDealer.has(w.dealerId)) perDealer.set(w.dealerId, { customer: 0, solar: 0 });
    perDealer.get(w.dealerId)[p.key]++;
  }
}
log(`  ${"dealer".padEnd(34)} ${"active".padEnd(7)} ${"customer".padStart(9)} ${"solar".padStart(7)}`);
for (const [id, c] of [...perDealer.entries()].sort((a, b) => b[1].customer + b[1].solar - (a[1].customer + a[1].solar))) {
  const d = dealerById.get(id);
  log(
    `  ${String(d?.Name ?? id).slice(0, 33).padEnd(34)} ${(d?.Active__c ? "ACTIVE" : "-").padEnd(7)} ` +
      `${String(c.customer || "").padStart(9)} ${String(c.solar || "").padStart(7)}`
  );
}
log(
  `\n  Rows against an INACTIVE dealer are attributed but grant nothing: §1.2 resolves an\n` +
    `  inactive dealer's users to scope 'none'. Attributing them now is still worth doing —\n` +
    `  activating a dealer later becomes a one-field change rather than a backfill.`
);

// ---------------------------------------------------------------------------
// APPLY
// ---------------------------------------------------------------------------
const totalWrites = plans.reduce((a, p) => a + p.writes.length, 0);
rule();
log(APPLY ? "APPLYING" : "REPORT ONLY — nothing written (pass --apply)");
for (const p of plans) log(`  ${p.o.label.padEnd(10)} ${p.writes.length.toLocaleString()} write(s)`);
rule();

if (!APPLY) {
  log("\n  Review the tables above, then re-run with --apply.\n");
  process.exit(0);
}
if (totalWrites === 0) {
  log("\n  nothing to do.\n");
  process.exit(0);
}

/**
 * CANARY (CLAUDE.md). Write ONE record, re-read it, and compare.
 *
 * The re-read selects the fields being written PLUS the ones a recalc Flow would touch
 * first, so a live automation shows up as a field this script did not write coming back
 * changed. Sundial_Budget_Recalc_Trigger is a draft today and cannot list Dealer__c
 * (the field is a day old) -- but "cannot today" is not "will not tomorrow", and the
 * canary is what carries the rule forward when nobody remembers this note.
 *
 * ⚠️ A re-read that returns NO ROW is a SCRIPT BUG, not automation. Those two produce
 * identical all-null diffs and need opposite responses. backfill-dealers.mjs conflated
 * them on its first run and accused the org of automation it does not have.
 */
const CANARY_WATCH = ["Budget_Calc_Status__c", "Budget_Calc_Error__c", "LastModifiedDate"];

async function canaryWrite(plan, w) {
  const watch = [];
  for (const f of CANARY_WATCH) {
    try {
      await sfQuery(`SELECT ${f} FROM ${plan.o.sfObject} LIMIT 1`);
      watch.push(f);
    } catch {
      /* field absent on this object */
    }
  }
  const sel = ["Id", "Dealer__c", ...watch].join(", ");
  const readOne = async () => {
    const [r] = await sfQuery(`SELECT ${sel} FROM ${plan.o.sfObject} WHERE Id = '${soqlEscapeString(w.id)}'`);
    return r ?? null;
  };

  log(`\n  CANARY — ${plan.o.label} ${w.id} (${String(w.name ?? "").slice(0, 30)}) alone first`);
  const pre = await readOne();
  if (!pre) {
    log(`  ** re-read found no such record BEFORE writing. Script bug, not automation. STOPPING. **`);
    return false;
  }
  for (const f of watch) log(`     before  ${f.padEnd(24)} ${JSON.stringify(pre[f] ?? null)}`);

  await sfUpdateRecord(plan.o.sfObject, w.id, { Dealer__c: w.dealerId });
  const post = await readOne();
  if (!post) {
    log(`  ** re-read found no record AFTER writing. Script bug or permissions, not automation. STOPPING. **`);
    return false;
  }
  for (const f of watch) log(`     after   ${f.padEnd(24)} ${JSON.stringify(post[f] ?? null)}`);

  if (post.Dealer__c !== w.dealerId) {
    log(`  ** the write did not stick: Dealer__c reads ${JSON.stringify(post.Dealer__c)}. STOPPING. **`);
    return false;
  }
  // LastModifiedDate ALWAYS changes on a write — it is watched to prove the re-read is
  // seeing the post-write row at all, not as a drift signal.
  const drift = watch.filter((f) => f !== "LastModifiedDate" && (pre[f] ?? null) !== (post[f] ?? null));
  if (drift.length) {
    log(`\n  ** AUTOMATION DETECTED — a field this script did not write changed: **`);
    for (const f of drift) log(`     ${f}: ${JSON.stringify(pre[f] ?? null)} -> ${JSON.stringify(post[f] ?? null)}`);
    log(`     A record-triggered Flow is live on ${plan.o.sfObject}. Deactivate it, then re-run.`);
    log(`     The canary record HAS been written and is correct.`);
    return false;
  }
  log(`     -> Dealer__c set, nothing else changed. Proceeding.`);
  return true;
}

// ---------------------------------------------------------------------------
// Transient failures — retried, and VISIBLE while they happen
// ---------------------------------------------------------------------------
// A 2026-08-27 run wrote 2,500 records cleanly and then failed ~600 in a burst before
// recovering on its own. The error text existed only in the end-of-run summary, so when
// the run was interrupted the diagnosis went with it: 600 failures, no reason. The
// end-of-run report is still there; this makes the FIRST occurrence of each distinct
// error shape print the moment it happens, so a long run says what is wrong while it is
// still wrong.
//
// A bounded retry sits alongside it because that burst pattern -- clean, then a wall,
// then clean again -- is what Salesforce rate limiting and transient socket failures
// look like, not what a bad payload looks like. A bad payload fails identically every
// time and the retry costs three attempts before reporting it, which is cheap.
//
// It is NOT an unbounded retry and never sleeps long: this script writes thousands of
// records, and a retry loop that hides a real rate limit just makes the run take hours
// and still fail. Three attempts, then report and move on. The script is idempotent, so
// the honest recovery for a run with failures is to run it again.
const MAX_ATTEMPTS = 3;
const seenErrors = new Set();

/** Distinct-error fingerprint: the message without ids, so 600 of one shape print once. */
const errorShape = (s) => String(s).replace(/[0-9a-zA-Z]{15,18}/g, "<id>").slice(0, 120);

async function writeWithRetry(sfObject, w) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await sfUpdateRecord(sfObject, w.id, { Dealer__c: w.dealerId });
      if (attempt > 1) log(`     (recovered on attempt ${attempt}: ${w.id})`);
      return { ok: true };
    } catch (e) {
      lastError = String(e.sfBody ?? e.message).slice(0, 300);
      const shape = errorShape(lastError);
      if (!seenErrors.has(shape)) {
        seenErrors.add(shape);
        log(`\n     ** first occurrence of a new error shape (attempt ${attempt}) **`);
        log(`        ${sfObject} ${w.id}`);
        log(`        ${lastError}`);
      }
      if (attempt < MAX_ATTEMPTS) {
        // 1s, then 4s. Long enough for a rate-limit window to move, short enough that a
        // genuinely broken run still ends today.
        await new Promise((r) => setTimeout(r, attempt * attempt * 1000));
      }
    }
  }
  return { ok: false, error: lastError };
}

// Progress every N rather than a line per record: 14,000 lines of "written" is a wall,
// not a log.
const PROGRESS_EVERY = 250;
const failures = [];
let applied = 0;

for (const p of plans) {
  if (p.writes.length === 0) continue;
  log(`\n  --- ${p.o.label}: ${p.writes.length.toLocaleString()} record(s) ---`);

  const ok = await canaryWrite(p, p.writes[0]);
  applied++;
  if (!ok) {
    log(`\n  1 of ${p.writes.length} written (the canary). The rest are untouched, and so is`);
    log(`  every later object. Nothing is half-applied beyond that one record.\n`);
    process.exit(1);
  }

  // The canary already consumed one of this run's budget.
  const budget = Math.max(0, LIMIT - applied);
  const rest = p.writes.slice(1, 1 + budget);
  const deferred = p.writes.length - 1 - rest.length;
  log(`  writing ${rest.length.toLocaleString()} more, progress every ${PROGRESS_EVERY}...`);
  for (const [i, w] of rest.entries()) {
    const res = await writeWithRetry(p.o.sfObject, w);
    if (res.ok) applied++;
    else failures.push({ obj: p.o.label, id: w.id, error: res.error });
    if ((i + 1) % PROGRESS_EVERY === 0) {
      log(`     ${applied.toLocaleString()} written, ${failures.length} failed  (${i + 1}/${rest.length})`);
    }
  }
  if (deferred > 0) {
    log(`     --limit reached: ${deferred.toLocaleString()} ${p.o.label} record(s) deferred to the next run.`);
  }
  if (applied >= LIMIT) break;
}

// ⚠️ DO NOT PIPE THIS SCRIPT'S OUTPUT through head/sed/tail on a real run: the shell
// reports the LAST command's status, so a partial write exits 0 and the failure signal
// is swallowed. On the 2026-08-24 burden-rate run, 2 of 4,473 records failed with
// transient `fetch failed` and the piped invocation still reported success.
if (failures.length) {
  log(`\n  ** ${failures.length} WRITE FAILURE(S) **`);
  for (const f of failures.slice(0, 40)) log(`     ${f.obj} ${f.id}: ${f.error}`);
  if (failures.length > 40) log(`     ... and ${failures.length - 40} more`);
  log(`\n  This script is IDEMPOTENT — it re-reads the org every run and only plans records`);
  log(`  that still need a write. Re-running is the correct recovery.`);
  process.exitCode = 1;
} else {
  log(`\n  ${applied.toLocaleString()} of ${totalWrites.toLocaleString()} record(s) written.`);
  log(`\n  Next: apply sql/sundial_access_p1_cache_columns.sql, then full-resync the caches.\n`);
}
