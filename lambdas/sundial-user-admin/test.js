// Unit tests for sundial-user-admin's pure logic.
//
// SCOPE: the Hierarchy_Level__c derivation and the role-combination rule. Both are
// pure functions over constants, so they test without Salesforce, Supabase, or a
// deployed Lambda. The endpoint-level assertion (that a real POST /admin/users lands
// the derived value in Salesforce) lives in scripts/verify-provisioning-e2e.mjs and
// needs the ZZ TEST super admin from scripts/seed-access-test-fixtures.mjs.
//
// WHAT THESE PIN. Until 2026-08-27 the hierarchy was a flat `"Sales Rep"` constant on
// every created user, and the TEMP guard in sundial-sf-query restricts exactly that
// string to one hardcoded rep's records. The tests below are the regression fence:
// the specific thing that must never come back is a NON-REP receiving "Sales Rep".

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACCESS_LEVELS,
  HIERARCHY_BY_ACCESS_LEVEL,
  DEFAULT_HIERARCHY_LEVEL,
  SALES_ACCESS_LEVELS,
  deriveHierarchyLevel,
} from "./index.js";

// The live Hierarchy_Level__c picklist, confirmed by describe against the org on
// 2026-08-27. It is RESTRICTED, so a derived value outside this set is not a silent
// no-op -- Salesforce rejects the insert with INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST
// and the user cannot be created at all. ("Sales Manager" and "Technician" were added
// to the picklist that day; the first four predate this work.)
const LIVE_HIERARCHY_PICKLIST = new Set([
  "Client",
  "Dealer",
  "Manager",
  "Sales Rep",
  "Sales Manager",
  "Technician",
]);

test("the three specified mappings", () => {
  assert.equal(deriveHierarchyLevel("Sales Rep"), "Sales Rep");
  assert.equal(deriveHierarchyLevel("Sales Dealer"), "Sales Manager");
  // "anything else" -- every remaining access level collapses to Client.
  assert.equal(deriveHierarchyLevel("Executive"), "Client");
  assert.equal(deriveHierarchyLevel("Admin"), "Client");
  assert.equal(deriveHierarchyLevel("Manager"), "Client");
  assert.equal(deriveHierarchyLevel("Technician"), "Client");
});

test("EVERY valid access level derives to a value the restricted picklist accepts", () => {
  // The load-bearing test. A picklist edit that removes a value, or a new access
  // level added to ACCESS_LEVELS without a mapping, fails HERE rather than at the
  // first create attempt against the org.
  for (const level of ACCESS_LEVELS) {
    const derived = deriveHierarchyLevel(level);
    assert.ok(
      LIVE_HIERARCHY_PICKLIST.has(derived),
      `${level} -> "${derived}" is not in the restricted Hierarchy_Level__c picklist; ` +
        `Salesforce would reject the insert with INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`
    );
  }
});

test("THE BUG: only an actual Sales Rep may receive the TEMP guard's value", () => {
  // sundial-sf-query restricts any caller whose Hierarchy_Level__c === "Sales Rep"
  // to one hardcoded rep's records. A non-rep landing on that string is the exact
  // defect this change removes, and it is a NARROWING -- the user sees someone
  // else's small slice instead of their own tenant-wide view.
  const TEMP_GUARD_VALUE = "Sales Rep";
  for (const level of ACCESS_LEVELS) {
    if (level === "Sales Rep") continue;
    assert.notEqual(
      deriveHierarchyLevel(level),
      TEMP_GUARD_VALUE,
      `access level "${level}" must not derive to "${TEMP_GUARD_VALUE}" -- that is the TEMP guard's key`
    );
  }
});

test("unknown, null and undefined fail CLOSED to the least-privileged value", () => {
  // Hierarchy_Level__c is not nillable, so there is no "leave it blank" option; the
  // question is only which value an unmapped input gets. Client grants nothing.
  assert.equal(deriveHierarchyLevel(undefined), "Client");
  assert.equal(deriveHierarchyLevel(null), "Client");
  assert.equal(deriveHierarchyLevel(""), "Client");
  assert.equal(deriveHierarchyLevel("Sales rep"), "Client"); // wrong case is NOT a rep
  assert.equal(deriveHierarchyLevel("sales dealer"), "Client");
  assert.equal(deriveHierarchyLevel("Wizard"), "Client");
  assert.equal(DEFAULT_HIERARCHY_LEVEL, "Client");
});

test("the derivation is total and takes nothing from request input", () => {
  // Whatever comes in, something valid comes out -- the field is required, so a
  // throw or an undefined here would be a failed create rather than a safe default.
  for (const weird of [0, 1, true, false, {}, [], Symbol.iterator, 12.5]) {
    assert.equal(deriveHierarchyLevel(weird), "Client");
  }
});

test("the sales-role set matches the scopes access-model.md §1.2 calls row-scoped", () => {
  // Sales Dealer -> `dealer`, Sales Rep -> `own`. Everything else is `tenant` or
  // `none`. This set is what the super-admin refusal keys on, so widening it
  // silently would widen that refusal too.
  assert.deepEqual([...SALES_ACCESS_LEVELS].sort(), ["Sales Dealer", "Sales Rep"]);
  for (const level of SALES_ACCESS_LEVELS) {
    assert.ok(ACCESS_LEVELS.has(level), `${level} must be a real access level`);
  }
});

test("the map itself carries no entry that grants more than it should", () => {
  // Reading the map directly, not through the function: an entry mapping a non-sales
  // level to "Sales Rep" would pass the function-level tests only if that level were
  // in ACCESS_LEVELS. This catches a typo'd key too.
  for (const [level, hierarchy] of Object.entries(HIERARCHY_BY_ACCESS_LEVEL)) {
    assert.ok(ACCESS_LEVELS.has(level), `"${level}" is not a valid Access_Level__c value`);
    assert.ok(LIVE_HIERARCHY_PICKLIST.has(hierarchy), `"${hierarchy}" is not a valid Hierarchy_Level__c value`);
    if (hierarchy === "Sales Rep") {
      assert.equal(level, "Sales Rep", `only "Sales Rep" may map to the TEMP guard's value`);
    }
  }
});
