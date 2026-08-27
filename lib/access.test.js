// Unit tests for lib/access.js — the fail-closed matrix.
//
// WHAT THESE PIN. The guard this module replaces defaults OPEN: repRestrictFor() in
// sundial-sf-query returns "no restriction" for any hierarchy value it does not
// recognize, which is why Phase 0 measured a Technician seeing all 31,638 customers.
// The regression that must never come back is ANY input this module does not recognize
// resolving to something other than `none`.
//
// So the tests are written as a MATRIX rather than as cases: every access level (live
// picklist, plus the ones that are not) crossed with every object key, plus the four
// ways a sales role loses its dealer. A new access level added to SCOPE_BY_ACCESS_LEVEL
// without a matching expectation here fails the exhaustiveness test at the bottom
// rather than sliding through.
//
// Pure functions over plain objects — no Salesforce, no Supabase, no deployed Lambda.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SCOPES,
  SCOPE_BY_ACCESS_LEVEL,
  OBJECT_ACCESS,
  ACTION_SCOPES,
  DENY,
  resolveScope,
  rowFilter,
  rowMatchesFilter,
  canReadObject,
  canAction,
  modulesFor,
  actionsFor,
  assertVisibleRecord,
  accessBlock,
  profileScopeColumns,
  escapeSoqlValue,
} from "./access.js";
import { soqlEscapeString } from "./salesforce.js";

const TENANT = "a1W7y000007AszBEAS";
const USER = "a1O7y00000s5sK1EAI";
const DEALER = "a0Y0000000DealerA";

/** A user shaped like resolveIdentity()'s output, with an ACTIVE dealer by default. */
const userWith = (accessLevel, over = {}) => ({
  id: USER,
  accessLevel,
  dealer: { id: DEALER, active: true, isInternal: false },
  ...over,
});

const ctxFor = (accessLevel, over = {}) => resolveScope(userWith(accessLevel, over), TENANT);

// ---------------------------------------------------------------------------
// 1. Every access level resolves to the documented scope (§1.2)
// ---------------------------------------------------------------------------

const LEVEL_SCOPES = [
  ["Executive", SCOPES.TENANT],
  ["Admin", SCOPES.TENANT],
  ["Manager", SCOPES.TENANT],
  ["Sales Dealer", SCOPES.DEALER],
  ["Sales Rep", SCOPES.OWN],
  ["Technician", SCOPES.NONE],
];

for (const [level, expected] of LEVEL_SCOPES) {
  test(`resolveScope: "${level}" -> ${expected}`, () => {
    assert.equal(ctxFor(level).scope, expected);
  });
}

// The inputs the TEMP guard treated as "unrestricted". Each must be `none`.
const FAIL_CLOSED_LEVELS = [
  ["null", null],
  ["undefined", undefined],
  ["empty string", ""],
  ["whitespace", "   "],
  ["unknown role", "Dispatcher"],
  ["wrong case", "sales rep"],
  ["hierarchy value, not an access level", "Sales Manager"],
  ["hierarchy value, not an access level", "Client"],
  ["a number", 7],
  ["an object", { level: "Admin" }],
];

for (const [label, level] of FAIL_CLOSED_LEVELS) {
  test(`resolveScope FAILS CLOSED: ${label} (${JSON.stringify(level)}) -> none`, () => {
    assert.equal(ctxFor(level).scope, SCOPES.NONE);
  });
}

test("resolveScope FAILS CLOSED: no user object at all", () => {
  assert.equal(resolveScope(undefined, TENANT).scope, SCOPES.NONE);
  assert.equal(resolveScope(null, TENANT).scope, SCOPES.NONE);
  assert.equal(resolveScope({}, TENANT).scope, SCOPES.NONE);
});

// ---------------------------------------------------------------------------
// 2. The four dealer conditions (§1.2, §2.1)
// ---------------------------------------------------------------------------
// A null foreign key reads as "unfiltered" in SQL, which is exactly the intuition that
// makes this the easy thing to get wrong. Both sales roles are tested, because a
// `dealer`-scope user with no dealer and an `own`-scope user with no dealer fail for
// different reasons and could plausibly be handled in only one branch.

for (const level of ["Sales Rep", "Sales Dealer"]) {
  test(`${level} + NULL dealer -> none, NOT "all dealers"`, () => {
    assert.equal(ctxFor(level, { dealer: null }).scope, SCOPES.NONE);
  });

  test(`${level} + INACTIVE dealer -> none`, () => {
    const c = ctxFor(level, { dealer: { id: DEALER, active: false, isInternal: false } });
    assert.equal(c.scope, SCOPES.NONE);
  });

  test(`${level} + dealer id but NO Dealer__r sub-object -> none (cannot confirm active)`, () => {
    // The identity SOQL selected Dealer__c but not Dealer__r.Active__c. A missing field
    // in a SELECT list must never read as a permission.
    const c = resolveScope({ id: USER, accessLevel: level, dealerId: DEALER }, TENANT);
    assert.equal(c.scope, SCOPES.NONE);
  });

  test(`${level} + dealer with active omitted -> none`, () => {
    const c = ctxFor(level, { dealer: { id: DEALER } });
    assert.equal(c.scope, SCOPES.NONE);
  });

  test(`${level} + active:"true" (string, not boolean) -> none`, () => {
    const c = ctxFor(level, { dealer: { id: DEALER, active: "true" } });
    assert.equal(c.scope, SCOPES.NONE);
  });
}

test("Sales Rep with no user id -> none (nothing to filter on)", () => {
  assert.equal(ctxFor("Sales Rep", { id: null }).scope, SCOPES.NONE);
});

test("tenant-wide roles are UNAFFECTED by a null or inactive dealer", () => {
  for (const level of ["Executive", "Admin", "Manager"]) {
    assert.equal(ctxFor(level, { dealer: null }).scope, SCOPES.TENANT, level);
    assert.equal(
      ctxFor(level, { dealer: { id: DEALER, active: false } }).scope,
      SCOPES.TENANT,
      level
    );
  }
});

test("Is_Internal__c grants nothing — an internal rep is still `own`", () => {
  const internal = ctxFor("Sales Rep", { dealer: { id: DEALER, active: true, isInternal: true } });
  const external = ctxFor("Sales Rep");
  assert.equal(internal.scope, SCOPES.OWN);
  assert.equal(internal.scope, external.scope);
  assert.equal(internal.dealerInternal, true);
});

// ---------------------------------------------------------------------------
// 3. The module gate — every access level x every object key (§3.1)
// ---------------------------------------------------------------------------
// Written out in full rather than derived from OBJECT_ACCESS, so that changing the
// table changes the expectations here too and somebody has to mean it.

const MODULE_MATRIX = {
  //            customer solar roofing commercial po  po_credit user
  Executive:   ["y",     "y",  "y",    "y",       "y", "y",     "y"],
  Admin:       ["y",     "y",  "y",    "y",       "y", "y",     "y"],
  Manager:     ["y",     "y",  "y",    "y",       "y", "y",     "y"],
  "Sales Dealer": ["y",  "y",  "n",    "n",       "n", "n",     "y"],
  "Sales Rep": ["y",     "y",  "n",    "n",       "n", "n",     "y"],
  Technician:  ["n",     "n",  "n",    "n",       "n", "n",     "n"],
};
const OBJECT_ORDER = ["customer", "solar", "roofing", "commercial", "po", "po_credit", "user"];

for (const [level, row] of Object.entries(MODULE_MATRIX)) {
  for (const [i, key] of OBJECT_ORDER.entries()) {
    const want = row[i] === "y";
    test(`canReadObject: ${level} x ${key} -> ${want}`, () => {
      assert.equal(canReadObject(key, ctxFor(level)), want);
    });
  }
}

test("canReadObject FAILS CLOSED on an unknown object key, even for tenant scope", () => {
  const admin = ctxFor("Admin");
  for (const key of ["asset", "service", "sundial_customer__c", "", null, undefined, "__proto__"]) {
    assert.equal(canReadObject(key, admin), false, `key ${JSON.stringify(key)}`);
  }
});

test("canReadObject FAILS CLOSED on a malformed access context", () => {
  for (const bad of [null, undefined, {}, { scope: "TENANT" }, { scope: "admin" }, "tenant"]) {
    assert.equal(canReadObject("customer", bad), false, JSON.stringify(bad));
  }
});

test("modulesFor matches the matrix row for every level", () => {
  for (const [level, row] of Object.entries(MODULE_MATRIX)) {
    const want = OBJECT_ORDER.filter((_, i) => row[i] === "y");
    assert.deepEqual(modulesFor(ctxFor(level)), want, level);
  }
});

test("roofing carries the filter columns and is STILL denied to sales roles", () => {
  // The module gate is a separate decision from whether the data model could support a
  // filter. This asserts the two have not been conflated.
  assert.ok(OBJECT_ACCESS.roofing.repColumn);
  assert.ok(OBJECT_ACCESS.roofing.dealerColumn);
  assert.equal(canReadObject("roofing", ctxFor("Sales Rep")), false);
  assert.equal(canReadObject("roofing", ctxFor("Sales Dealer")), false);
});

// ---------------------------------------------------------------------------
// 4. rowFilter — the predicate, in both dialects (§3.2)
// ---------------------------------------------------------------------------

test("rowFilter: tenant scope filters on the tenant ALONE", () => {
  const f = rowFilter("customer", ctxFor("Admin"));
  assert.equal(f.deny, false);
  assert.deepEqual(f.cache, [{ column: "client_sf_id", value: TENANT }]);
  assert.equal(f.soql, `Client__c = '${TENANT}'`);
});

test("rowFilter: own scope -> sales_rep_sf_id / Sales_Rep__c", () => {
  for (const key of ["customer", "solar"]) {
    const f = rowFilter(key, ctxFor("Sales Rep"));
    assert.equal(f.deny, false, key);
    assert.deepEqual(
      f.cache,
      [{ column: "client_sf_id", value: TENANT }, { column: "sales_rep_sf_id", value: USER }],
      key
    );
    assert.equal(f.soql, `Client__c = '${TENANT}' AND Sales_Rep__c = '${USER}'`, key);
  }
});

test("rowFilter: dealer scope -> dealer_sf_id / Dealer__c", () => {
  for (const key of ["customer", "solar"]) {
    const f = rowFilter(key, ctxFor("Sales Dealer"));
    assert.equal(f.deny, false, key);
    assert.deepEqual(
      f.cache,
      [{ column: "client_sf_id", value: TENANT }, { column: "dealer_sf_id", value: DEALER }],
      key
    );
    assert.equal(f.soql, `Client__c = '${TENANT}' AND Dealer__c = '${DEALER}'`, key);
  }
});

test("rowFilter: THE TENANT CLAUSE IS IN EVERY BRANCH", () => {
  // The row filter and the tenant filter are one object on purpose: a caller who has to
  // remember to AND client_sf_id separately is a caller who will one day forget.
  for (const level of ["Executive", "Admin", "Manager", "Sales Dealer", "Sales Rep"]) {
    const f = rowFilter("customer", ctxFor(level));
    assert.equal(f.deny, false, level);
    assert.equal(f.cache[0].column, "client_sf_id", level);
    assert.equal(f.cache[0].value, TENANT, level);
    assert.ok(f.soql.startsWith("Client__c = "), level);
  }
});

test("rowFilter FAILS CLOSED with no tenant id — never falls back to the rep clause alone", () => {
  const noTenant = resolveScope(userWith("Sales Rep"), null);
  const f = rowFilter("customer", noTenant);
  assert.equal(f.deny, true);
  assert.equal(f.code, DENY.MODULE_FORBIDDEN);

  // The same for tenant scope: an unscoped "everything" query is the worst case.
  const adminNoTenant = resolveScope(userWith("Admin"), null);
  assert.equal(rowFilter("customer", adminNoTenant).deny, true);
});

test("rowFilter FAILS CLOSED for scope none, every object", () => {
  const tech = ctxFor("Technician");
  for (const key of Object.keys(OBJECT_ACCESS)) {
    const f = rowFilter(key, tech);
    assert.equal(f.deny, true, key);
    assert.equal(f.code, DENY.MODULE_FORBIDDEN, key);
  }
});

test("rowFilter FAILS CLOSED on denied modules for both sales scopes", () => {
  for (const level of ["Sales Rep", "Sales Dealer"]) {
    for (const key of ["roofing", "commercial", "po", "po_credit"]) {
      assert.equal(rowFilter(key, ctxFor(level)).deny, true, `${level} x ${key}`);
    }
  }
});

test("rowFilter REFUSES `user` for sales scopes — it is a union, not an equality (§3.5)", () => {
  // Returning an equality here would be wrong in a way the caller could not see: it
  // would silently hide the Harmon staff half of the mentions picker.
  assert.equal(rowFilter("user", ctxFor("Sales Rep")).deny, true);
  assert.equal(rowFilter("user", ctxFor("Sales Dealer")).deny, true);
  // Tenant scope is a plain tenant filter and works.
  assert.equal(rowFilter("user", ctxFor("Admin")).deny, false);
});

test("rowFilter: SOQL values are escaped, identically to lib/salesforce.js", () => {
  const nasty = "x" + String.fromCharCode(39) + " OR Id != " + String.fromCharCode(39);
  const c = resolveScope({ id: nasty, accessLevel: "Sales Rep", dealer: { id: DEALER, active: true } }, TENANT);
  const f = rowFilter("customer", c);
  assert.equal(f.soql, `Client__c = '${TENANT}' AND Sales_Rep__c = '${soqlEscapeString(nasty)}'`);
  assert.ok(!f.soql.includes(" OR Id != '"));
  // The cache side takes the RAW value — PostgREST parameters are not string-spliced.
  assert.equal(f.cache[1].value, nasty);
});

test("escapeSoqlValue agrees with soqlEscapeString on the awkward inputs", () => {
  const B = String.fromCharCode(92);
  const Q = String.fromCharCode(39);
  for (const v of ["plain", Q, B, B + Q, "O" + Q + "Brien", B + B, "", "a" + B + "nb"]) {
    assert.equal(escapeSoqlValue(v), soqlEscapeString(v), JSON.stringify(v));
  }
});

// ---------------------------------------------------------------------------
// 5. Actions (§3.6)
// ---------------------------------------------------------------------------

const SALES_ALLOWED_ACTIONS = [
  "customer.create",
  "aurora.design_request",
  "files.customer.list",
  "files.customer.download",
  "files.customer.upload",
];

test("sales roles get EXACTLY the five allowed actions and no others", () => {
  for (const level of ["Sales Rep", "Sales Dealer"]) {
    assert.deepEqual(actionsFor(ctxFor(level)), SALES_ALLOWED_ACTIONS, level);
  }
});

test("every OTHER action is denied to both sales roles", () => {
  const denied = Object.keys(ACTION_SCOPES).filter((k) => !SALES_ALLOWED_ACTIONS.includes(k));
  // Named explicitly so the list cannot quietly shrink to nothing and still pass.
  assert.ok(denied.includes("files.customer.delete"));
  assert.ok(denied.includes("files.solar.list"));
  assert.ok(denied.includes("files.solar.related")); // ungated today — §3.6
  assert.ok(denied.includes("files.copy_to_solar"));
  assert.ok(denied.includes("project.create"));
  assert.ok(denied.includes("budget.recalc"));
  assert.ok(denied.includes("acumatica.sync"));
  for (const level of ["Sales Rep", "Sales Dealer"]) {
    for (const key of denied) {
      assert.equal(canAction(key, ctxFor(level)), false, `${level} x ${key}`);
    }
  }
});

test("tenant scope may perform every action", () => {
  for (const level of ["Executive", "Admin", "Manager"]) {
    for (const key of Object.keys(ACTION_SCOPES)) {
      assert.equal(canAction(key, ctxFor(level)), true, `${level} x ${key}`);
    }
  }
});

test("scope none may perform NO action", () => {
  for (const key of Object.keys(ACTION_SCOPES)) {
    assert.equal(canAction(key, ctxFor("Technician")), false, key);
    assert.equal(canAction(key, ctxFor("Sales Rep", { dealer: null })), false, key);
  }
});

test("canAction FAILS CLOSED on an unknown or inherited action key", () => {
  const admin = ctxFor("Admin");
  for (const key of ["budget.recalculate", "", null, undefined, "__proto__", "toString", 42]) {
    assert.equal(canAction(key, admin), false, JSON.stringify(key));
  }
});

test("canAction is NOT a record check — the caller must also assertVisibleRecord", () => {
  // A rep may fire a design request. That says nothing about WHICH customer, and the
  // two questions being separate is the point: conflating them would let a rep aim the
  // action at any customer id in the tenant.
  const rep = ctxFor("Sales Rep");
  assert.equal(canAction("aurora.design_request", rep), true);
  const other = "a1P000000000OTHER";
  const check = assertVisibleRecord("customer", other, rep);
  assert.equal(check.deny, false);
  assert.ok(check.soql.includes(`Sales_Rep__c = '${USER}'`));
});

// ---------------------------------------------------------------------------
// 6. assertVisibleRecord and the cache-row shortcut (§3.2)
// ---------------------------------------------------------------------------

test("assertVisibleRecord builds an existence query with the row filter ANDed in", () => {
  const q = assertVisibleRecord("customer", "a1P7y00000AmyXCEAZ", ctxFor("Sales Rep"));
  assert.equal(q.deny, false);
  assert.equal(
    q.soql,
    "SELECT Id FROM Sundial_Customer__c WHERE Id = 'a1P7y00000AmyXCEAZ' " +
      `AND Client__c = '${TENANT}' AND Sales_Rep__c = '${USER}' LIMIT 1`
  );
});

test("assertVisibleRecord DENIES WITH 404, NEVER 403", () => {
  // A 403 on a record id confirms the record exists, which turns any detail endpoint
  // into an enumeration oracle. Every denial here must be RECORD_NOT_FOUND.
  const cases = [
    ["module denied", "roofing", "a1x", ctxFor("Sales Rep")],
    ["scope none", "customer", "a1x", ctxFor("Technician")],
    ["null dealer", "customer", "a1x", ctxFor("Sales Rep", { dealer: null })],
    ["inactive dealer", "solar", "a1x", ctxFor("Sales Dealer", { dealer: { id: DEALER, active: false } })],
    ["unknown object", "asset", "a1x", ctxFor("Admin")],
    ["blank id", "customer", "", ctxFor("Admin")],
    ["null id", "customer", null, ctxFor("Admin")],
  ];
  for (const [label, key, id, access] of cases) {
    const q = assertVisibleRecord(key, id, access);
    assert.equal(q.deny, true, label);
    assert.equal(q.code, DENY.RECORD_NOT_FOUND, label);
  }
});

test("assertVisibleRecord escapes the record id", () => {
  const Q = String.fromCharCode(39);
  const q = assertVisibleRecord("customer", "a1x" + Q + " OR Id != " + Q, ctxFor("Admin"));
  assert.equal(q.deny, false);
  assert.ok(!q.soql.includes(" OR Id != '"));
});

test("rowMatchesFilter: the cache shortcut the TEMP guard had to skip", () => {
  const rep = ctxFor("Sales Rep");
  const mine = { sf_id: "a1", client_sf_id: TENANT, sales_rep_sf_id: USER };
  const theirs = { sf_id: "a2", client_sf_id: TENANT, sales_rep_sf_id: "a1Oother" };
  const otherTenant = { sf_id: "a3", client_sf_id: "a1Wother", sales_rep_sf_id: USER };

  assert.equal(rowMatchesFilter("customer", rep, mine), true);
  assert.equal(rowMatchesFilter("customer", rep, theirs), false);
  assert.equal(rowMatchesFilter("customer", rep, otherTenant), false);
});

test("rowMatchesFilter: an UN-BACKFILLED row is not a visible row", () => {
  // §3.3 — column absent means the filter cannot be applied, so the answer is no. The
  // opposite of the created_date "column absent -> stable order" tolerance, and
  // deliberately so: there, absence degrades ordering; here it would remove a filter.
  const rep = ctxFor("Sales Rep");
  assert.equal(rowMatchesFilter("customer", rep, { sf_id: "a1", client_sf_id: TENANT }), false);
  assert.equal(
    rowMatchesFilter("customer", rep, { sf_id: "a1", client_sf_id: TENANT, sales_rep_sf_id: null }),
    false
  );
  const dealer = ctxFor("Sales Dealer");
  assert.equal(rowMatchesFilter("customer", dealer, { sf_id: "a1", client_sf_id: TENANT }), false);
});

test("rowMatchesFilter: tenant scope still checks the tenant, and nothing else", () => {
  const admin = ctxFor("Admin");
  assert.equal(rowMatchesFilter("customer", admin, { client_sf_id: TENANT }), true);
  assert.equal(rowMatchesFilter("customer", admin, { client_sf_id: "a1Wother" }), false);
});

test("rowMatchesFilter FAILS CLOSED on a missing or non-object row", () => {
  const admin = ctxFor("Admin");
  for (const row of [null, undefined, "", 0, "a string"]) {
    assert.equal(rowMatchesFilter("customer", admin, row), false, JSON.stringify(row));
  }
});

// ---------------------------------------------------------------------------
// 7. The /auth/me block and the profiles columns (§1.3, §5.2)
// ---------------------------------------------------------------------------

test("accessBlock carries the whole context for the client to reflect", () => {
  const b = accessBlock(ctxFor("Sales Dealer"));
  assert.equal(b.level, "Sales Dealer");
  assert.equal(b.scope, SCOPES.DEALER);
  assert.equal(b.userId, USER);
  assert.equal(b.dealerId, DEALER);
  assert.equal(b.tenantId, TENANT);
  assert.deepEqual(b.modules, ["customer", "solar", "user"]);
  assert.deepEqual(b.actions, SALES_ALLOWED_ACTIONS);
});

test("accessBlock for a `none` user is empty, not absent", () => {
  // The client must be able to tell "resolved to nothing" from "the field is missing",
  // so it renders an empty portal rather than falling back to a default.
  const b = accessBlock(ctxFor("Technician"));
  assert.equal(b.scope, SCOPES.NONE);
  assert.deepEqual(b.modules, []);
  assert.deepEqual(b.actions, []);
});

test("profileScopeColumns writes exactly the three server-owned columns", () => {
  assert.deepEqual(profileScopeColumns(ctxFor("Sales Rep")), {
    access_scope: "own",
    access_level: "Sales Rep",
    dealer_sf_id: DEALER,
  });
  assert.deepEqual(profileScopeColumns(ctxFor("Sales Rep", { dealer: null })), {
    access_scope: "none",
    access_level: "Sales Rep",
    dealer_sf_id: null,
  });
  // The level is recorded verbatim even when it resolves to none, so the shadow report
  // can tell "Technician" apart from "nobody set a level".
  assert.equal(profileScopeColumns(ctxFor("Technician")).access_level, "Technician");
  assert.equal(profileScopeColumns(ctxFor(null)).access_level, null);
});

// ---------------------------------------------------------------------------
// 8. Exhaustiveness — the tests cannot silently fall behind the tables
// ---------------------------------------------------------------------------

test("every access level in SCOPE_BY_ACCESS_LEVEL has an expectation above", () => {
  const tested = new Set(LEVEL_SCOPES.map(([l]) => l));
  for (const level of Object.keys(SCOPE_BY_ACCESS_LEVEL)) {
    assert.ok(tested.has(level), `${level} is in the scope table with no test — add one`);
  }
  for (const [level, expected] of LEVEL_SCOPES) {
    assert.equal(
      SCOPE_BY_ACCESS_LEVEL[level] ?? SCOPES.NONE,
      expected,
      `${level} moved in the scope table without the test moving`
    );
  }
});

test("every access level has a row in the module matrix", () => {
  for (const level of Object.keys(SCOPE_BY_ACCESS_LEVEL)) {
    assert.ok(MODULE_MATRIX[level], `${level} has no MODULE_MATRIX row`);
    assert.equal(MODULE_MATRIX[level].length, OBJECT_ORDER.length, level);
  }
});

test("every object key is in the module matrix, in order", () => {
  assert.deepEqual(OBJECT_ORDER, Object.keys(OBJECT_ACCESS));
});

test("every action key is either sales-allowed or asserted denied", () => {
  const keys = Object.keys(ACTION_SCOPES);
  for (const k of SALES_ALLOWED_ACTIONS) {
    assert.ok(keys.includes(k), `${k} is expected-allowed but not in ACTION_SCOPES`);
  }
  // Anything new lands in the denied half by default, which the test above enumerates.
  assert.ok(keys.length > SALES_ALLOWED_ACTIONS.length);
});

test("an object that allows sales scopes carries BOTH filter columns", () => {
  // Otherwise rowFilter would deny for one scope and allow for the other, which reads
  // as a bug in the caller rather than a gap in this table.
  for (const [key, def] of Object.entries(OBJECT_ACCESS)) {
    if (def.salesScopes !== true || def.unionFilter) continue;
    assert.ok(def.repColumn && def.repField, `${key} has no rep filter`);
    assert.ok(def.dealerColumn && def.dealerField, `${key} has no dealer filter`);
  }
});

// ---------------------------------------------------------------------------
// 9. The two dealer guards are NOT redundant
// ---------------------------------------------------------------------------
// Found by mutation: deleting the `dealerId === null` check broke nothing, because an
// absent dealer also has no `active` and the second guard caught it. The case that
// separates them is a dealer sub-object that says active but carries no id.
//
// Both guards fail closed for row reads either way — rowFilter refuses a null filter
// value. The difference is what /auth/me TELLS THE CLIENT: without this check the user
// resolves to scope `dealer`, the portal renders a dealer's navigation, and every list
// then comes back denied. A user who is shown a door that does not open files a bug
// report; a user shown no door does not.

test("dealer with active:true but NO id -> none (not a broken `dealer` scope)", () => {
  for (const level of ["Sales Rep", "Sales Dealer"]) {
    const c = ctxFor(level, { dealer: { active: true, isInternal: false } });
    assert.equal(c.scope, SCOPES.NONE, level);
    assert.equal(c.dealerId, null, level);
    assert.deepEqual(accessBlock(c).modules, [], level);
  }
});

test("dealer with a blank-string id -> none", () => {
  const c = ctxFor("Sales Rep", { dealer: { id: "   ", active: true } });
  assert.equal(c.scope, SCOPES.NONE);
});

// ---------------------------------------------------------------------------
// 10. The cache column names are what the sync actually derives
// ---------------------------------------------------------------------------
// D-064 Phase 1 item 5. The whole "no Lambda change needed" claim rests on
// sfFieldToColumn() producing exactly the names lib/access.js filters on, and the
// failure mode is SILENT: sundial-cache-sync selects only fields whose derived column
// name exists, so a mismatch is not an error anywhere. It is a column of nulls, a row
// filter that matches nothing, and a sales rep with an empty portal.
//
// Importing the real function rather than restating the rule is the point — a
// reimplementation here would agree with itself while disagreeing with the sync.

import { sfFieldToColumn } from "../lambdas/sundial-cache-sync/index.js";

test("sfFieldToColumn derives exactly the columns OBJECT_ACCESS filters on", () => {
  for (const [key, def] of Object.entries(OBJECT_ACCESS)) {
    if (!def.repField) continue;
    assert.equal(
      sfFieldToColumn({ name: def.repField, type: "reference" }),
      def.repColumn,
      `${key}: ${def.repField} must derive to ${def.repColumn}`
    );
    assert.equal(
      sfFieldToColumn({ name: def.dealerField, type: "reference" }),
      def.dealerColumn,
      `${key}: ${def.dealerField} must derive to ${def.dealerColumn}`
    );
  }
});

test("sfFieldToColumn: the three Phase 1 columns, spelled out", () => {
  // Named literally so a rename of BOTH the constant and the column still fails here.
  assert.equal(sfFieldToColumn({ name: "Sales_Rep__c", type: "reference" }), "sales_rep_sf_id");
  assert.equal(sfFieldToColumn({ name: "Dealer__c", type: "reference" }), "dealer_sf_id");
  assert.equal(sfFieldToColumn({ name: "Access_Level__c", type: "picklist" }), "access_level");
});

test("sfFieldToColumn: a reference field WITHOUT the _sf_id suffix would be wrong", () => {
  // The suffix comes from the TYPE, not the name. A Dealer__c mistakenly described as a
  // string would derive `dealer` and silently never populate — this pins that the type
  // is what drives it, so the mistake is visible if the field is ever redefined.
  assert.equal(sfFieldToColumn({ name: "Dealer__c", type: "string" }), "dealer");
  assert.notEqual(sfFieldToColumn({ name: "Dealer__c", type: "string" }), "dealer_sf_id");
});
