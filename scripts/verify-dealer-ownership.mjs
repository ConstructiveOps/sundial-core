// Post-backfill verification for D-064 Phase 1 items 3 and 4.
// READ-ONLY. Re-reads everything from Salesforce; asserts nothing from a script's own
// report, because a backfill agreeing with itself proves nothing.
//
//   node scripts/verify-dealer-ownership.mjs
//
// Checks, in the order they matter:
//   1. The A3 gate, again. 3,534 / 777 with zero difference either way.
//   2. Dealer__c populated counts per object, and the accounting that explains the gap.
//   3. Count per dealer for the five ACTIVE dealers — the only rows that grant anything.
//   4. The ZZ TEST fixtures, since every later phase's gate is measured against them.
//
// Exit 1 if any assertion fails.

import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";
import { TEST_USERS, EMAIL } from "./seed-access-test-fixtures.mjs";

const TENANT_ID = "a1W7y000007AszBEAS";
const DENNIS_ID = "a1O7y00000s5sK1EAI";
const DENNIS_NAME = "Dennis Alessandro";

const log = (...a) => console.log(...a);
const rule = (c = "=") => log(c.repeat(84));
const failures = [];
function check(label, ok, detail = "") {
  log(`  ${ok ? "PASS" : "FAIL"} ${ok ? "OK " : "** "} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

const one = async (soql) => Number((await sfQuery(soql))[0].n);
const countWhere = (obj, where) =>
  one(`SELECT COUNT(Id) n FROM ${obj} WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND ${where}`);

rule();
log("VERIFY DEALER OWNERSHIP — read-only, straight from Salesforce");
rule();

// --- 1. A3 gate -------------------------------------------------------------
//
// ⚠️ THE ASSERTION IS THE SET EQUALITY, NOT THE COUNT. This block used to also assert
// `byName.size === 3534` and `=== 777` -- the numbers §2.4a measured on 2026-08-27.
// Those are a point-in-time snapshot of a LIVE org that gains records every day: by
// 2026-09-15 they read 3,549 and 783, and the script went red on two lines while the
// invariant it exists to protect was perfectly intact (`onlyInOld` and `onlyInNew` both
// zero, on every run).
//
// That is the worst failure mode a gate can have. A check that cries wolf on correct
// data gets read as noise, and the next time it goes red for a REAL reason -- a record
// Dennis would lose at cutover -- nobody looks. We already learned this on 2026-08-27
// with the workbook hash: it hashed file BYTES, Excel never writes the same bytes twice,
// so it fired on every save. The fix there was to hash the DECISIONS rather than the
// file. Same lesson, and this script had regressed to numbers.
//
// So the counts are still MEASURED and PRINTED -- they are useful context, and a sudden
// collapse from 3,549 to 40 should be visible -- but what is ASSERTED is the property
// that holds at any size:
//
//   the legacy name match and the Sales_Rep__c match return the SAME SET,
//   and that set is not empty.
//
// Non-emptiness earns its place: two empty sets are trivially equal, so a query that
// silently stopped matching anything -- a renamed field, a re-spelled name -- would
// otherwise pass the equality and report success over zero records.
log("\n1. THE A3 GATE (docs/access-model.md §2.4a, §7.2)");
log("   Asserting SET EQUALITY, not a pinned count -- the org grows; the invariant does not.");
for (const [obj, nameField, measured] of [
  ["Sundial_Customer__c", "Sunbase_Sales_Rep__c", 3534],
  ["Sundial_Solar__c", "Sales_Representative__c", 777],
]) {
  const byName = new Set(
    (await sfQuery(
      `SELECT Id FROM ${obj} WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' ` +
        `AND ${nameField} = '${soqlEscapeString(DENNIS_NAME)}'`
    )).map((r) => r.Id)
  );
  const byId = new Set(
    (await sfQuery(
      `SELECT Id FROM ${obj} WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' ` +
        `AND Sales_Rep__c = '${soqlEscapeString(DENNIS_ID)}'`
    )).map((r) => r.Id)
  );
  const onlyInOld = [...byName].filter((id) => !byId.has(id));
  const onlyInNew = [...byId].filter((id) => !byName.has(id));
  const label = obj.replace("Sundial_", "").replace("__c", "");
  const drift = byName.size - measured;
  log(
    `  ${label}: name match ${byName.size}, id match ${byId.size}` +
      `  (measured ${measured} on 2026-08-27${drift === 0 ? "" : `, ${drift > 0 ? "+" : ""}${drift} since`})`
  );
  // The invariant, at any size.
  check(
    `${label}: both matches return a NON-EMPTY set`,
    byName.size > 0 && byId.size > 0,
    `name ${byName.size}, id ${byId.size}`
  );
  check(
    `${label}: the two matches return the SAME SIZE`,
    byName.size === byId.size,
    `name ${byName.size} vs id ${byId.size}`
  );
  check(`${label}: onlyInOld is EMPTY (nothing Dennis loses)`, onlyInOld.length === 0, `${onlyInOld.length}`);
  check(`${label}: onlyInNew is EMPTY (nothing Dennis gains)`, onlyInNew.length === 0, `${onlyInNew.length}`);
}

// --- 2. Dealer__c populated, with the accounting that explains the gap ------
log("\n2. Dealer__c POPULATED PER OBJECT");
log(`  ${"object".padEnd(10)} ${"total".padStart(8)} ${"with dealer".padStart(12)} ${"pending".padStart(8)}  accounting`);
for (const [obj, label] of [
  ["Sundial_Customer__c", "Customer"],
  ["Sundial_Solar__c", "Solar"],
  ["Sundial_Roofing__c", "Roofing"],
]) {
  const total = await countWhere(obj, "Id != null");
  const withDealer = await countWhere(obj, "Dealer__c != null");
  // A record whose rep HAS a dealer but which has no Dealer__c is unfinished work.
  // Anything else null is a deliberate outcome (no rep, or a rep with no dealer).
  const pending = await countWhere(obj, "Dealer__c = null AND Sales_Rep__r.Dealer__c != null");
  log(
    `  ${label.padEnd(10)} ${String(total).padStart(8)} ${String(withDealer).padStart(12)} ${String(pending).padStart(8)}` +
      `  ${pending === 0 ? "complete" : "** UNFINISHED **"}`
  );
  check(`${label}: no record left where the rep HAS a dealer`, pending === 0, `${pending} pending`);

  // The disagreement invariant (§2.3 rule 5): Dealer__c must equal the rep's dealer
  // wherever a rep is set. This is the check the nightly reconcile will run.
  //
  // ⚠️ SOQL CANNOT COMPARE TWO FIELDS. `WHERE Dealer__c != Sales_Rep__r.Dealer__c` is a
  // MALFORMED_QUERY, not an empty result -- the right-hand side of a comparison must be
  // a literal. So the rows come back and the comparison happens here. Worth knowing
  // before writing the nightly reconcile, which will hit the same wall.
  const paired = await sfQuery(
    `SELECT Id, Dealer__c, Sales_Rep__r.Dealer__c FROM ${obj} ` +
      `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' ` +
      `AND Dealer__c != null AND Sales_Rep__c != null AND Sales_Rep__r.Dealer__c != null`
  );
  const disagreeing = paired.filter((r) => r.Dealer__c !== r.Sales_Rep__r?.Dealer__c);
  check(
    `${label}: Dealer__c never disagrees with the rep's dealer (§2.3.5)`,
    disagreeing.length === 0,
    `${disagreeing.length} of ${paired.length} checked`
  );
  for (const r of disagreeing.slice(0, 10)) {
    log(`       ${r.Id}: deal ${r.Dealer__c} vs rep ${r.Sales_Rep__r?.Dealer__c}`);
  }
}

// --- 2b. THE PAIR INVARIANT (§2.3.5, added 2026-09-15) ----------------------
// Every check above is SINGLE-OBJECT: it asks whether one record agrees with its own
// rep. A linked Customer/Solar pair can pass both halves and still be half-attributed,
// and that is not a hypothetical — it is how this check came to exist.
//
// A live pair carried "Property Upgrades" in the sales-company fields and had NO rep on
// either record. The §2.4 backfill's pass 2 (A2) resolves a rep-less record's
// sales-company value through the alias file, but it runs on SOLAR ONLY (deliberately:
// Customer Dealer_Name__c was populated on 13 of 31,637 rows, so a Customer pass was
// risk without benefit). So the Solar record got a Dealer__c and its Customer did not.
// The dealer's manager saw the project and could not open the customer behind it.
//
// Nothing above catches that. The rep invariant needs a rep and there is none. The
// `pending` probe needs a rep with a dealer, likewise. Both records are individually
// defensible; the defect only exists BETWEEN them. So the pair is now checked here, and
// `scripts/report-dealer-pair-consistency.mjs` is the drill-down with proposed
// resolutions per record.
//
// ⚠️ "THE TWO DISAGREE" IS THREE FINDINGS, AND ONLY TWO ARE DEFECTS. Where both records
// have a rep and each equals ITS OWN rep's dealer, nothing is broken: A1 says the dealer
// comes from the rep, both obey, and the pair is split because two organizations' reps
// own the two records. Failing on that would make the nightly cry wolf on correct data —
// and worse, would invite a "fix" that overwrites a rep-derived value, which is the one
// thing A1 forbids. It is counted and shown, never failed.
log("\n2b. THE PAIR INVARIANT — linked Customer/Solar must agree on Dealer__c (§2.3.5)");
{
  const solarPairs = await sfQuery(
    `SELECT Id, Sundial_Customer__c, Dealer__c, Sales_Rep__c, Sales_Rep__r.Dealer__c ` +
      `FROM Sundial_Solar__c WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' ` +
      `AND Sundial_Customer__c != null`
  );
  const custIds = [...new Set(solarPairs.map((r) => r.Sundial_Customer__c))];
  const cust = new Map();
  for (let i = 0; i < custIds.length; i += 400) {
    const chunk = custIds.slice(i, i + 400).map((v) => `'${soqlEscapeString(v)}'`).join(",");
    const rows = await sfQuery(
      `SELECT Id, Dealer__c, Sales_Rep__c, Sales_Rep__r.Dealer__c FROM Sundial_Customer__c ` +
        `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND Id IN (${chunk})`
    );
    for (const r of rows) cust.set(r.Id, r);
  }

  const n0 = (v) => v ?? null;
  const found = { splitByRep: [], conflict: [], halfAttributed: [] };
  for (const sRow of solarPairs) {
    const c = cust.get(sRow.Sundial_Customer__c);
    if (!c) continue;
    const sd = n0(sRow.Dealer__c);
    const cd = n0(c.Dealer__c);
    if (sd === cd) continue;
    const srd = n0(sRow.Sales_Rep__r?.Dealer__c);
    const crd = n0(c.Sales_Rep__r?.Dealer__c);
    if (sd && cd) {
      if (srd && crd && sd === srd && cd === crd) found.splitByRep.push([c.Id, sRow.Id]);
      else found.conflict.push([c.Id, sRow.Id]);
    } else {
      // Exactly one side is null. If the NULL side's own rep has a dealer this is
      // unfinished backfill pass 1, already counted as `pending` above — not a pair
      // defect, and counting it twice would make the pair number unreadable.
      const nullSideRepDealer = cd === null ? crd : srd;
      if (!nullSideRepDealer) found.halfAttributed.push([c.Id, sRow.Id]);
    }
  }

  log(`  pairs examined ${solarPairs.length}`);
  log(`  split by rep (both correct, informational) ${found.splitByRep.length}`);
  for (const [cid, sid] of found.splitByRep.slice(0, 10)) log(`       ${cid} / ${sid}`);

  // A genuine conflict: two dealers, and at least one of them agrees with no rep. There
  // is no rule in the model that produces this, so it is a write path that went wrong.
  check(
    "Pair: no linked Customer/Solar disagree with NO rep to settle it",
    found.conflict.length === 0,
    `${found.conflict.length} pair(s)`
  );
  for (const [cid, sid] of found.conflict.slice(0, 10)) log(`       ${cid} / ${sid}`);

  // HALF-ATTRIBUTED is the reported class. It is REPORTED, NOT FAILED, until Tim rules
  // on the proposed §2.3.8 amendment (a Customer inherits its linked Solar's Dealer__c
  // when its own is null, and the reverse) — because until that rule exists, a null here
  // is fail-closed behaviour working as specified, not a broken record. The moment the
  // amendment lands, turn this into a `check(...)` and it fails on the next occurrence.
  if (found.halfAttributed.length > 0) {
    log(`  ** ${found.halfAttributed.length} HALF-ATTRIBUTED pair(s) — one side has a dealer,`);
    log(`     the other is null, and neither has a rep to derive it from.`);
    log(`     PENDING the D-064 §2.3.8 decision. Drill down:`);
    log(`       node scripts/report-dealer-pair-consistency.mjs`);
    for (const [cid, sid] of found.halfAttributed.slice(0, 10)) log(`       ${cid} / ${sid}`);
  } else {
    log("  half-attributed pairs 0");
  }
}

// --- 3. Per-dealer counts for the ACTIVE dealers ----------------------------
log("\n3. RECORD COUNT PER **ACTIVE** DEALER (the only rows that grant anything)");
const activeDealers = await sfQuery(
  `SELECT Id, Name, Is_Internal__c FROM Sundial_Dealer__c ` +
    `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND Active__c = true ORDER BY Name`
);
check("exactly 5 active dealers", activeDealers.length === 5, `${activeDealers.length}`);
log(`  ${"dealer".padEnd(26)} ${"internal".padEnd(9)} ${"customer".padStart(9)} ${"solar".padStart(7)}`);
for (const d of activeDealers) {
  const c = await countWhere("Sundial_Customer__c", `Dealer__c = '${soqlEscapeString(d.Id)}'`);
  const s = await countWhere("Sundial_Solar__c", `Dealer__c = '${soqlEscapeString(d.Id)}'`);
  log(
    `  ${d.Name.padEnd(26)} ${(d.Is_Internal__c ? "yes" : "-").padEnd(9)} ${String(c).padStart(9)} ${String(s).padStart(7)}`
  );
}

// Harmon Solar must hold Dennis's whole book plus his ZZ twin's records, and nothing
// else -- it is the dealer whose count Phase 3 will be measured against.
const harmon = activeDealers.find((d) => d.Name === "Harmon Solar");
if (harmon) {
  const hc = await countWhere("Sundial_Customer__c", `Dealer__c = '${soqlEscapeString(harmon.Id)}'`);
  const dennisC = await countWhere("Sundial_Customer__c", `Sales_Rep__c = '${soqlEscapeString(DENNIS_ID)}'`);
  check(
    "Harmon Solar's customers >= Dennis's own book",
    hc >= dennisC,
    `${hc} >= ${dennisC}`
  );
  log(`     of which ${dennisC} are Dennis's; the remainder are the ZZ TEST twin's.`);
}

// --- 4. The ZZ TEST fixtures ------------------------------------------------
// Every later phase's gate is measured against these users, so a fixture that drifted
// would make the matrix assert one thing while the org holds another.
log("\n4. ZZ TEST FIXTURES (docs/access-model.md §9)");
const emails = TEST_USERS.map((u) => `'${soqlEscapeString(EMAIL(u.slug))}'`).join(",");
const zz = await sfQuery(
  `SELECT Id, Email__c, Access_Level__c, Active__c, Dealer__c, Dealer__r.Name, Dealer__r.Active__c ` +
    `FROM Sundial_User__c WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND Email__c IN (${emails})`
);
const byEmail = new Map(zz.map((u) => [String(u.Email__c).toLowerCase(), u]));
log(`  ${"user".padEnd(22)} ${"access level".padEnd(14)} ${"dealer".padEnd(26)} dealerActive`);
for (const t of TEST_USERS) {
  const u = byEmail.get(EMAIL(t.slug).toLowerCase());
  const got = u?.Dealer__r?.Name ?? null;
  const want = t.dealer ?? null;
  const ok = got === want;
  log(
    `  ${("zz-" + t.slug).padEnd(22)} ${String(t.accessLevel).padEnd(14)} ${String(got ?? "(null)").padEnd(26)} ` +
      `${u?.Dealer__r?.Active__c ?? "-"}${ok ? "" : `   ** want ${want ?? "(null)"} **`}`
  );
  if (!ok) failures.push(`zz-${t.slug} dealer is ${got}, expected ${want}`);
}
check("all ten ZZ TEST users carry their fixture dealer", !failures.some((f) => f.startsWith("zz-")));

// zz-rep-nodealer and zz-tech MUST stay null: they are the only fixtures that can prove
// §1.2's "a sales role with a null dealer sees NOTHING, not everything".
for (const slug of ["rep-nodealer", "tech"]) {
  const u = byEmail.get(EMAIL(slug).toLowerCase());
  check(`zz-${slug} still has NO dealer (proves the fail-closed rule)`, !u?.Dealer__c);
}
const inactiveFixture = byEmail.get(EMAIL("rep-inactive-dealer").toLowerCase());
check(
  "zz-rep-inactive-dealer's dealer is INACTIVE (proves §2.1)",
  inactiveFixture?.Dealer__r?.Active__c === false
);
const dennisRow = await sfQuery(
  `SELECT Id, Dealer__r.Name, Dealer__r.Active__c FROM Sundial_User__c WHERE Id = '${soqlEscapeString(DENNIS_ID)}'`
);
check("Dennis's dealer is Harmon Solar and it is ACTIVE",
  dennisRow[0]?.Dealer__r?.Name === "Harmon Solar" && dennisRow[0]?.Dealer__r?.Active__c === true,
  dennisRow[0]?.Dealer__r?.Name ?? "(null)");

// --- verdict ----------------------------------------------------------------
log("");
rule();
if (failures.length === 0) {
  log("ALL CHECKS PASS.");
  log("Next: apply sql/sundial_access_p1_cache_columns.sql, then full-resync the caches.");
} else {
  log(`** ${failures.length} CHECK(S) FAILED **`);
  for (const f of failures) log(`   ${f}`);
  process.exitCode = 1;
}
rule();
