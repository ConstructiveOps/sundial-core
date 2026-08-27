// Phase 1 item 8 — the shadow diff. D-064, docs/access-model.md §7.2.
//
//   node scripts/access-shadow-report.mjs            # all users
//   node scripts/access-shadow-report.mjs --user "Dennis Alessandro"
//   node scripts/access-shadow-report.mjs --json
//
// READ-ONLY. Writes nothing, deploys nothing, and does not touch sundial-sf-query.
//
// For every portal user, on customer and solar: the set of record ids they can see
// TODAY under the TEMP guard, against the set they would see under lib/access.js's
// rowFilter. Reported as onlyInOld (records they LOSE) and onlyInNew (records they
// GAIN).
//
// THE GATE (§7.2): for Dennis, onlyInNew must be EMPTY -- nothing widens -- and
// onlyInOld must be empty before Phase 3 enforces. For everybody else the report is
// the input to a decision, not a pass/fail: it says who loses what, so the levels can
// be fixed BEFORE the flip rather than discovered after it.
//
// ---------------------------------------------------------------------------
// WHAT "TODAY" ACTUALLY MEANS, which is uglier than it sounds
// ---------------------------------------------------------------------------
// The TEMP guard (sundial-sf-query, "TEMP — Sales Rep hard-restrict") does this:
//
//   if (Hierarchy_Level__c === "Sales Rep")  -> restrict customer/solar to the records
//                                               whose LEGACY NAME FIELD equals the
//                                               hardcoded string "Dennis Alessandro"
//   else                                     -> NO RESTRICTION AT ALL
//
// Two consequences the report has to model faithfully rather than tidy up:
//
//   1. It keys on a NAME, not on the caller. Any user carrying that hierarchy value is
//      served DENNIS'S book -- not their own. So "old set" for such a user is Dennis's
//      records, however little sense that makes.
//   2. Its default is OPEN. A Technician, or anyone whose hierarchy is not that exact
//      string, sees EVERY record in the tenant.
//
// Modelling this honestly is the whole point: a report that assumed the guard did
// something sensible would understate what Phase 3 changes.

import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";
import { getSupabaseConfig } from "../lib/supabase.js";
import { resolveScope, rowFilter, OBJECT_ACCESS } from "../lib/access.js";

const TENANT_ID = "a1W7y000007AszBEAS";
const JSON_OUT = process.argv.includes("--json");
const ONLY_USER = (() => {
  const i = process.argv.indexOf("--user");
  return i === -1 ? null : process.argv[i + 1];
})();

// The TEMP guard's constants, copied verbatim from sundial-sf-query/index.js.
// DUPLICATED ON PURPOSE: importing them would couple this report to the Lambda and
// make "the report agrees with the guard" true by construction rather than by
// checking. When the guard is deleted in Phase 3, these stay as the record of what it
// did, and this script becomes the before/after evidence.
const TEMP_SALES_REP_HIERARCHY = "Sales Rep";
const TEMP_SALES_REP_NAME = "Dennis Alessandro";
const TEMP_SALES_REP_FIELD = { customer: "Sunbase_Sales_Rep__c", solar: "Sales_Representative__c" };

const OBJECTS = [
  { key: "customer", sfObject: "Sundial_Customer__c", table: "sundial_customer_cache" },
  { key: "solar", sfObject: "Sundial_Solar__c", table: "sundial_solar_cache" },
];

const log = (...a) => { if (!JSON_OUT) console.log(...a); };
const rule = (c = "=") => log(c.repeat(100));

// ---------------------------------------------------------------------------
// Set representation — ALL is a sentinel, never a materialized 31,651-id Set
// ---------------------------------------------------------------------------
// Most users see everything under both rules. Materializing 31,651 ids per user, twice,
// for ~130 users would be minutes of pointless work and gigabytes of garbage. So a set
// is either the sentinel ALL (every record in the tenant) or a real Set of ids, and the
// difference operations know how to handle the sentinel exactly.
const ALL = Symbol("all-tenant-records");
const NONE_SET = new Set();

const sizeOf = (set, total) => (set === ALL ? total : set.size);

/** onlyInA = A minus B, as a COUNT plus up to `sample` ids. Exact for every combination. */
function difference(a, b, total, allIds, sample = 10) {
  if (a === ALL && b === ALL) return { count: 0, sample: [] };
  if (a === ALL) {
    // Everything minus a subset. Needs the full id list to sample from, but the COUNT
    // is arithmetic — so the count is always right even when sampling is skipped.
    const count = total - b.size;
    const s = allIds ? allIds.filter((id) => !b.has(id)).slice(0, sample) : [];
    return { count, sample: s };
  }
  if (b === ALL) return { count: 0, sample: [] }; // a subset minus everything is empty
  const s = [...a].filter((id) => !b.has(id));
  return { count: s.length, sample: s.slice(0, sample) };
}

async function idSet(sfObject, where) {
  const rows = await sfQuery(
    `SELECT Id FROM ${sfObject} WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND ${where}`
  );
  return new Set(rows.map((r) => r.Id));
}

// --- the NEW set, read from the CACHE (which is what will serve it) ----------
// Deliberately not from Salesforce: Phase 3 serves these reads from the cache, so the
// question the report must answer is "what will the cache return", not "what does
// Salesforce contain". If the two disagree, that disagreement IS the finding, and
// scripts/verify-cache-access-columns.mjs is where it would surface.
const cfg = await getSupabaseConfig();
async function cacheIdSet(table, filterPairs) {
  const qs = filterPairs.map((f) => `${f.column}=eq.${encodeURIComponent(f.value)}`).join("&");
  const out = new Set();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const resp = await fetch(`${cfg.url}/rest/v1/${table}?select=sf_id&${qs}`, {
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        Range: `${offset}-${offset + PAGE - 1}`,
      },
    });
    if (!resp.ok) throw new Error(`${table} read failed (${resp.status}): ${await resp.text()}`);
    const rows = await resp.json();
    for (const r of rows) out.add(r.sf_id);
    if (rows.length < PAGE) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gather
// ---------------------------------------------------------------------------
const users = await sfQuery(
  `SELECT Id, First_Name__c, Last_Name__c, Email__c, Access_Level__c, Hierarchy_Level__c, ` +
    `Active__c, Dealer__c, Dealer__r.Name, Dealer__r.Active__c, Dealer__r.Is_Internal__c ` +
    `FROM Sundial_User__c WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND Active__c = true`
);

const totals = {};
const allIds = {};
const tempSets = {};
for (const o of OBJECTS) {
  const [{ n }] = await sfQuery(
    `SELECT COUNT(Id) n FROM ${o.sfObject} WHERE Client__c = '${soqlEscapeString(TENANT_ID)}'`
  );
  totals[o.key] = Number(n);
  // The TEMP guard's restricted set, computed once — it is the same for every user it
  // applies to, because it keys on a hardcoded name rather than on the caller.
  tempSets[o.key] = await idSet(o.sfObject, `${TEMP_SALES_REP_FIELD[o.key]} = '${soqlEscapeString(TEMP_SALES_REP_NAME)}'`);
  allIds[o.key] = (
    await sfQuery(`SELECT Id FROM ${o.sfObject} WHERE Client__c = '${soqlEscapeString(TENANT_ID)}'`)
  ).map((r) => r.Id);
}

const rows = [];
for (const u of users) {
  const name = `${u.First_Name__c ?? ""} ${u.Last_Name__c ?? ""}`.trim() || u.Email__c || u.Id;
  if (ONLY_USER && !name.toLowerCase().includes(ONLY_USER.toLowerCase())) continue;

  const dealer = u.Dealer__c
    ? {
        id: u.Dealer__c,
        name: u.Dealer__r?.Name ?? null,
        active: u.Dealer__r?.Active__c === true,
        isInternal: u.Dealer__r?.Is_Internal__c === true,
      }
    : null;
  const access = resolveScope(
    { id: u.Id, accessLevel: u.Access_Level__c ?? null, dealer },
    TENANT_ID
  );

  const restrictedToday = u.Hierarchy_Level__c === TEMP_SALES_REP_HIERARCHY;
  const perObject = {};

  for (const o of OBJECTS) {
    // OLD: the TEMP guard. Restricted users get Dennis's name-matched set (whoever they
    // are); everyone else gets everything, because the guard's default is open.
    const oldSet = restrictedToday ? tempSets[o.key] : ALL;

    // NEW: rowFilter over the cache. A denial is an empty set, not an error — from the
    // user's seat "the module is closed" and "there are no records" look the same.
    const f = rowFilter(o.key, access);
    let newSet;
    if (f.deny) newSet = NONE_SET;
    else if (access.scope === "tenant") newSet = ALL;
    else newSet = await cacheIdSet(o.table, f.cache);

    perObject[o.key] = {
      oldCount: sizeOf(oldSet, totals[o.key]),
      newCount: sizeOf(newSet, totals[o.key]),
      onlyInOld: difference(oldSet, newSet, totals[o.key], allIds[o.key]),
      onlyInNew: difference(newSet, oldSet, totals[o.key], allIds[o.key]),
    };
  }

  rows.push({
    id: u.Id,
    name,
    email: u.Email__c,
    accessLevel: u.Access_Level__c ?? null,
    hierarchy: u.Hierarchy_Level__c ?? null,
    dealer: dealer?.name ?? null,
    scope: access.scope,
    restrictedToday,
    perObject,
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (JSON_OUT) {
  console.log(JSON.stringify({ tenantId: TENANT_ID, totals, users: rows }, null, 2));
  process.exit(0);
}

const KNOWN_LEVELS = new Set(["Executive", "Admin", "Manager", "Sales Dealer", "Sales Rep"]);
const fmt = (n) => (n === 0 ? "0" : n.toLocaleString());

rule();
log("ACCESS SHADOW REPORT — what Phase 3 would change, per user");
rule();
log(`  tenant ${TENANT_ID}   customer ${fmt(totals.customer)}   solar ${fmt(totals.solar)}`);
log(`  ${rows.length} active user(s). READ-ONLY: nothing is written and sundial-sf-query is untouched.`);

// --- Dennis first: he is the gate -------------------------------------------
const dennis = rows.find((r) => r.name === "Dennis Alessandro");
rule("-");
log("THE GATE — Dennis Alessandro (the one live restricted user)");
rule("-");
if (!dennis) {
  log("  ** NOT FOUND among active users. **");
} else {
  log(`  ${dennis.email}   Access_Level__c=${dennis.accessLevel}   Hierarchy_Level__c=${dennis.hierarchy}`);
  log(`  dealer=${dennis.dealer}   new scope=${dennis.scope}   restricted today=${dennis.restrictedToday}`);
  log(`\n  ${"object".padEnd(10)} ${"sees today".padStart(11)} ${"would see".padStart(10)} ${"onlyInOld".padStart(10)} ${"onlyInNew".padStart(10)}`);
  for (const o of OBJECTS) {
    const p = dennis.perObject[o.key];
    log(
      `  ${o.key.padEnd(10)} ${fmt(p.oldCount).padStart(11)} ${fmt(p.newCount).padStart(10)} ` +
        `${fmt(p.onlyInOld.count).padStart(10)} ${fmt(p.onlyInNew.count).padStart(10)}`
    );
    for (const id of p.onlyInOld.sample) log(`       onlyInOld: ${id}`);
    for (const id of p.onlyInNew.sample) log(`       onlyInNew: ${id}`);
  }
  const clean = OBJECTS.every(
    (o) => dennis.perObject[o.key].onlyInOld.count === 0 && dennis.perObject[o.key].onlyInNew.count === 0
  );
  log(
    clean
      ? "\n  GATE PASSES — identical sets on both objects. Phase 3 cannot change what he sees."
      : "\n  ** GATE FAILS — the sets differ. onlyInNew is a WIDENING and §7 forbids it; onlyInOld is a\n" +
          "     backfill defect to fix before enforce, not a tolerance. **"
  );
}

// --- the users who lose access at Phase 3 -----------------------------------
// Tim's ask: "every user whose Access_Level__c is Technician, null, or not in the list".
// These are the ones the guard's open default is currently serving everything to, and
// who resolve to `none` under the new model. They are the decision Phase 3 forces.
const atRisk = rows.filter(
  (r) => r.accessLevel === null || r.accessLevel === "Technician" || !KNOWN_LEVELS.has(r.accessLevel)
);
rule("-");
log(`USERS WHO RESOLVE TO scope none — ${atRisk.length} active user(s)`);
rule("-");
log(
  "  Access_Level__c is Technician, blank, or a value the scope table does not map.\n" +
    "  Today the TEMP guard serves them EVERYTHING (its default is open). Under the new\n" +
    "  model they see NOTHING. That is the largest behaviour change in Phase 3 and it is\n" +
    "  a decision for you, not a defect: `none` is the correct fail-closed answer for a\n" +
    "  role nobody has defined, and the fix is to give them a level, not to loosen it.\n"
);
if (atRisk.length === 0) {
  log("  none — every active user carries a level the scope table maps.");
} else {
  log(`  ${"user".padEnd(28)} ${"Access_Level__c".padEnd(16)} ${"hierarchy".padEnd(14)} ${"loses (cust)".padStart(12)} ${"loses (solar)".padStart(13)}`);
  for (const r of atRisk) {
    log(
      `  ${r.name.slice(0, 27).padEnd(28)} ${String(r.accessLevel ?? "(blank)").padEnd(16)} ` +
        `${String(r.hierarchy ?? "-").padEnd(14)} ${fmt(r.perObject.customer.onlyInOld.count).padStart(12)} ` +
        `${fmt(r.perObject.solar.onlyInOld.count).padStart(13)}`
    );
  }
}

// --- everyone else, summarized ----------------------------------------------
rule("-");
log("EVERY ACTIVE USER — what changes");
rule("-");
log(
  `  ${"user".padEnd(26)} ${"level".padEnd(14)} ${"scope".padEnd(7)} ` +
    `${"cust now".padStart(9)} ${"cust new".padStart(9)} ${"solar now".padStart(10)} ${"solar new".padStart(10)}  change`
);
for (const r of [...rows].sort((a, b) => a.name.localeCompare(b.name))) {
  const c = r.perObject.customer;
  const s = r.perObject.solar;
  const loses = c.onlyInOld.count + s.onlyInOld.count;
  const gains = c.onlyInNew.count + s.onlyInNew.count;
  // BOTH numbers, always. The first version printed "GAINS n" whenever gains > 0 and
  // hid the loss behind it -- so ZZ Rep A One, who loses 3,535 of Dennis's records and
  // gains its own 1, read as "GAINS 2" with no mention of the 4,314 it loses. A user can
  // lose and gain in the same change, and a column that shows only one of them is worse
  // than a column that shows neither, because it looks complete.
  const change =
    loses === 0 && gains === 0
      ? "no change"
      : `${loses ? `-${fmt(loses)}` : ""}${loses && gains ? " / " : ""}${gains ? `+${fmt(gains)}` : ""}`;
  log(
    `  ${r.name.slice(0, 25).padEnd(26)} ${String(r.accessLevel ?? "(blank)").padEnd(14)} ${r.scope.padEnd(7)} ` +
      `${fmt(c.oldCount).padStart(9)} ${fmt(c.newCount).padStart(9)} ${fmt(s.oldCount).padStart(10)} ${fmt(s.newCount).padStart(10)}  ${change}`
  );
}

// --- the only failure class that is a LEAK ----------------------------------
// Everything else in this report makes somebody see LESS. A widening makes somebody see
// MORE, and §7's rule is that access may only tighten. Called out separately so it can
// never be lost among rows of expected narrowing.
//
// ⚠️ BUT NOT EVERY WIDENING IS A LEAK, AND SAYING WHICH IS THE POINT OF THIS SECTION.
// The TEMP guard NARROWS wrongly in two known ways, and undoing a wrong narrowing shows
// up here as a gain:
//
//   MIS-STAMPED — Hierarchy_Level__c is "Sales Rep" while Access_Level__c is not. The
//     guard is serving them Dennis's book instead of their own view. This is the Phase 0
//     user-admin default bug (docs/access-model-phase0-user-audit.md), and A6 repairs it
//     independently of Phase 3. The "gain" is them getting back the access their real
//     role always implied.
//
//   OWN RECORD — a Sales Rep who is not Dennis is served DENNIS's records today and not
//     their own, because the guard filters on a hardcoded name rather than on the
//     caller. Under the new model they get their own records. That single record shows
//     as a gain while 3,535 of Dennis's show as a loss.
//
// A widening that is NEITHER of those is the one to stop for: it means the new model
// grants something the old one did not, to somebody the old one was treating correctly.
const widened = rows.filter((r) =>
  OBJECTS.some((o) => r.perObject[o.key].onlyInNew.count > 0)
);
const classify = (r) => {
  if (r.restrictedToday && r.accessLevel !== "Sales Rep") {
    return "EXPECTED — mis-stamped by the old user-admin default; A6 repairs this";
  }
  if (r.restrictedToday && r.scope === "own") {
    return "EXPECTED — a rep gaining their OWN records, which the name-matched guard never gave them";
  }
  return "** UNEXPLAINED — the new model grants what the old one did not. Investigate before Phase 3. **";
};
rule("-");
log(`WIDENINGS — ${widened.length}. §7: access may only TIGHTEN.`);
rule("-");
if (widened.length === 0) {
  log("  none. No user would see a single record they cannot see today.");
} else {
  for (const r of widened) {
    log(`  ${r.name} (${r.accessLevel ?? "blank"}, hierarchy ${r.hierarchy ?? "-"}, scope ${r.scope})`);
    for (const o of OBJECTS) {
      const p = r.perObject[o.key];
      if (p.onlyInNew.count === 0) continue;
      log(`     ${o.key}: +${fmt(p.onlyInNew.count)}  e.g. ${p.onlyInNew.sample.slice(0, 3).join(", ")}`);
    }
    log(`     ${classify(r)}`);
  }
  const unexplained = widened.filter((r) => classify(r).startsWith("**"));
  log(
    unexplained.length === 0
      ? `\n  All ${widened.length} are explained by the TEMP guard's known wrong-narrowing. None is a leak.`
      : `\n  ** ${unexplained.length} UNEXPLAINED widening(s). Do not enforce Phase 3 until each is understood. **`
  );
}

log("");
