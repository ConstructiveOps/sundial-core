// Phase 1 item 5 verification — the cache row-filter columns are POPULATED, and they
// agree with Salesforce. D-064, docs/access-model.md §3.3.
//
//   node scripts/verify-cache-access-columns.mjs
//
// READ-ONLY. Run after sql/sundial_access_p1_cache_columns.sql and a full resync.
//
// ⚠️ "THE COLUMN EXISTS" AND "THE COLUMN HAS DATA IN IT" ARE DIFFERENT QUESTIONS, and
// only the second one matters. sundial-cache-sync selects exactly the fields whose
// derived column name exists (buildCacheSelect), so a MISSPELLED column is not an error
// anywhere: the sync reports success, the resync reports every row processed, and the
// result is a column of nulls, a row filter matching nothing, and a sales rep with an
// empty portal at Phase 3. Verification 1 in the SQL file answers the first question.
// This answers the second.
//
// ⚠️ AND IT COMPARES AGAINST SALESFORCE, not against the cache's own totals. A cache
// that agrees with itself proves nothing at all -- the whole failure mode here is the
// cache being internally consistent and empty in the column that matters.

import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";
import { getSupabaseConfig } from "../lib/supabase.js";

const TENANT_ID = "a1W7y000007AszBEAS";
const DENNIS_ID = "a1O7y00000s5sK1EAI";
const DENNIS_NAME = "Dennis Alessandro";

const log = (...a) => console.log(...a);
const rule = (c = "=") => log(c.repeat(90));
const failures = [];
function check(label, ok, detail = "") {
  log(`  ${ok ? "PASS OK " : "FAIL ** "} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

// --- PostgREST count helper -------------------------------------------------
// Uses the SERVICE ROLE, which bypasses RLS. That is correct here and worth saying:
// after the Phase 1 revoke, anon and authenticated hold NO privileges on these tables,
// so any other key would answer 401 and this script would be measuring the grant rather
// than the data.
const cfg = await getSupabaseConfig();
async function cacheCount(table, filter = "") {
  const url = `${cfg.url}/rest/v1/${table}?select=sf_id&limit=1${filter}`;
  const resp = await fetch(url, {
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
      Prefer: "count=exact",
      Range: "0-0",
    },
  });
  if (!resp.ok) throw new Error(`${table} count failed (${resp.status}): ${await resp.text()}`);
  // content-range is "0-0/12345"; the total is what we want.
  const cr = resp.headers.get("content-range") || "";
  const total = Number(cr.split("/")[1]);
  if (!Number.isFinite(total)) throw new Error(`${table}: unparseable content-range "${cr}"`);
  return total;
}

const soqlCount = async (obj, where) =>
  Number(
    (await sfQuery(
      `SELECT COUNT(Id) n FROM ${obj} WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND ${where}`
    ))[0].n
  );

const TENANT_FILTER = `&client_sf_id=eq.${TENANT_ID}`;

const OBJECTS = [
  { key: "customer", table: "sundial_customer_cache", sfObject: "Sundial_Customer__c", hasRep: true },
  { key: "solar", table: "sundial_solar_cache", sfObject: "Sundial_Solar__c", hasRep: true },
  { key: "roofing", table: "sundial_roofing_cache", sfObject: "Sundial_Roofing__c", hasRep: true },
];

rule();
log("VERIFY CACHE ACCESS COLUMNS — cache vs Salesforce, not cache vs itself");
rule();

log("\n1. ROW TOTALS (cache should equal Salesforce after a full resync)");
log(`  ${"object".padEnd(10)} ${"cache".padStart(8)} ${"salesforce".padStart(11)}`);
for (const o of OBJECTS) {
  const cache = await cacheCount(o.table, TENANT_FILTER);
  const sf = await soqlCount(o.sfObject, "Id != null");
  log(`  ${o.key.padEnd(10)} ${String(cache).padStart(8)} ${String(sf).padStart(11)}`);
  // A cache AHEAD of Salesforce means ghosts (deleted records the upsert-only sync
  // cannot remove — see caching-architecture.md). Behind means an incomplete resync.
  check(`${o.key}: cache row count matches Salesforce`, cache === sf, `${cache} vs ${sf}`);
}

log("\n2. non_null PER COLUMN — the question 'does the column exist' cannot answer");
log(`  ${"object".padEnd(10)} ${"column".padEnd(17)} ${"cache non_null".padStart(15)} ${"salesforce".padStart(11)}`);
for (const o of OBJECTS) {
  for (const [col, field] of [
    ...(o.hasRep ? [["sales_rep_sf_id", "Sales_Rep__c"]] : []),
    ["dealer_sf_id", "Dealer__c"],
  ]) {
    const cache = await cacheCount(o.table, `${TENANT_FILTER}&${col}=not.is.null`);
    const sf = await soqlCount(o.sfObject, `${field} != null`);
    log(`  ${o.key.padEnd(10)} ${col.padEnd(17)} ${String(cache).padStart(15)} ${String(sf).padStart(11)}`);
    check(`${o.key}.${col} matches ${field} in Salesforce`, cache === sf, `${cache} vs ${sf}`);
    // Stated separately, because "0 vs 0" passes the equality above and is exactly what
    // a misspelled column looks like on an object nobody has attributed yet.
    if (sf > 0 && cache === 0) {
      check(`${o.key}.${col} is NOT an empty column`, false, "Salesforce has data, the cache column is all null");
    }
  }
}

log("\n3. sundial_user_cache");
const userCacheRows = await cacheCount("sundial_user_cache", TENANT_FILTER);
const userSf = await soqlCount("Sundial_User__c", "Id != null");
check("user: cache row count matches Salesforce", userCacheRows === userSf, `${userCacheRows} vs ${userSf}`);
for (const [col, field] of [["dealer_sf_id", "Dealer__c"], ["access_level", "Access_Level__c"]]) {
  const cache = await cacheCount("sundial_user_cache", `${TENANT_FILTER}&${col}=not.is.null`);
  const sf = await soqlCount("Sundial_User__c", `${field} != null`);
  log(`  ${"user".padEnd(10)} ${col.padEnd(17)} ${String(cache).padStart(15)} ${String(sf).padStart(11)}`);
  check(`user.${col} matches ${field} in Salesforce`, cache === sf, `${cache} vs ${sf}`);
}

// --- 4. The gate: counts BY sales_rep_sf_id agree with SOQL ------------------
// The Phase 1 gate is "cache counts by sales_rep_sf_id match SOQL". A total that matches
// is not that: two sets of 3,534 rows can both total 3,534 and contain different records.
// So this checks the per-rep breakdown for every rep that owns anything, and Dennis by id.
log("\n4. COUNTS **BY sales_rep_sf_id** — the Phase 1 gate");
for (const o of OBJECTS.filter((x) => x.hasRep)) {
  const sfRows = await sfQuery(
    `SELECT Sales_Rep__c r, COUNT(Id) n FROM ${o.sfObject} ` +
      `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND Sales_Rep__c != null GROUP BY Sales_Rep__c`
  );
  let mismatches = 0;
  let firstFew = [];
  for (const row of sfRows) {
    const cache = await cacheCount(o.table, `${TENANT_FILTER}&sales_rep_sf_id=eq.${row.r}`);
    if (cache !== Number(row.n)) {
      mismatches++;
      if (firstFew.length < 5) firstFew.push(`${row.r}: cache ${cache} vs SOQL ${row.n}`);
    }
  }
  check(
    `${o.key}: every rep's count matches SOQL (${sfRows.length} rep(s) checked)`,
    mismatches === 0,
    mismatches ? `${mismatches} mismatch(es)` : "all agree"
  );
  for (const m of firstFew) log(`       ${m}`);
}

// Dennis by id — the number Phase 3 is measured against.
//
// ⚠️ THIS ASSERTS AN INVARIANT, NOT A NUMBER, AND THE FIRST VERSION GOT THAT WRONG.
// It was written as `expected 3534 / 777`, the counts Phase 0 measured. Forty minutes
// later it failed at 3,535 and 779 — because the org is LIVE and Harmon had created 11
// customers and 3 solar projects in the meantime, one and two of them Dennis's. The
// data was correct; the assertion was a snapshot pretending to be a rule.
//
// §2.4a says exactly this about its own tables ("counts are a point-in-time snapshot of
// a live org and drift by a row or two between runs; the shapes below do not"), and the
// shapes are what matter here:
//
//   * the CACHE agrees with SALESFORCE for Dennis, whatever the number is, and
//   * the id set and the legacy-name set are still identical (the A3 gate).
//
// A hardcoded count would need editing after every working day, and a check that has to
// be edited to keep passing stops being read.
log("\n  Dennis Alessandro, by id:");
for (const [table, sfObject, nameField] of [
  ["sundial_customer_cache", "Sundial_Customer__c", "Sunbase_Sales_Rep__c"],
  ["sundial_solar_cache", "Sundial_Solar__c", "Sales_Representative__c"],
]) {
  const cache = await cacheCount(table, `${TENANT_FILTER}&sales_rep_sf_id=eq.${DENNIS_ID}`);
  const sf = await soqlCount(sfObject, `Sales_Rep__c = '${soqlEscapeString(DENNIS_ID)}'`);
  const byName = await soqlCount(sfObject, `${nameField} = '${soqlEscapeString(DENNIS_NAME)}'`);
  log(`    ${table.padEnd(24)} cache ${String(cache).padStart(6)}   SOQL ${String(sf).padStart(6)}   legacy-name ${String(byName).padStart(6)}`);
  check(`${table}: cache agrees with Salesforce for Dennis`, cache === sf, `${cache} vs ${sf}`);
  check(`${sfObject}: the id match still equals the legacy-name match`, sf === byName, `${sf} vs ${byName}`);
  check(`${table}: Dennis's book fits in ONE cache page (D-050 cap 5000)`, cache <= 5000, `${cache} <= 5000`);
}

log("");
rule();
if (failures.length === 0) {
  log("ALL CHECKS PASS — the cache carries the filter columns and agrees with Salesforce.");
} else {
  log(`** ${failures.length} CHECK(S) FAILED **`);
  for (const f of failures) log(`   ${f}`);
  process.exitCode = 1;
}
rule();
