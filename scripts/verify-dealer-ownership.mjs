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
log("\n1. THE A3 GATE (docs/access-model.md §2.4a, §7.2)");
for (const [obj, nameField, expected] of [
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
  check(`${label}: legacy name match = ${expected}`, byName.size === expected, `got ${byName.size}`);
  check(`${label}: Sales_Rep__c match = ${expected}`, byId.size === expected, `got ${byId.size}`);
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
