// Tests for lib/identity.js — where the pure scope resolver meets a live Salesforce row.
//
// lib/access.test.js already pins resolveScope over clean inputs. This file pins the
// JOIN: that the SOQL asks for the dealer sub-object at all, that a Salesforce record is
// mapped onto the shape resolveScope expects, and that the awkward real-world rows
// (dealer id with no sub-object, inactive dealer, blank level) come out fail-closed.
//
// WHY THAT SEAM NEEDS ITS OWN TESTS. resolveScope can be perfect and the system still
// wrong, in one specific way: if the identity SOQL stops selecting Dealer__r.Active__c,
// every sales user silently resolves to `none` and the portal empties. Nothing else
// would catch it — the field is absent, not wrong, so no error is raised anywhere.
//
// Run with: npm test  (needs --experimental-test-module-mocks)

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(39);

const ctx = { record: null, lastSoql: null, claims: { sub: "auth-uuid-1" } };

mock.module("../lib/salesforce.js", {
  exports: {
    // Real escaping, built without literal backslashes so the heredoc that wrote this
    // file could not mangle them. A test that produced a quote-breaking value should fail.
    soqlEscapeString: (v) =>
      String(v).split(BACKSLASH).join(BACKSLASH + BACKSLASH).split(QUOTE).join(BACKSLASH + QUOTE),
    sfQuery: async (soql) => {
      ctx.lastSoql = soql;
      return ctx.record ? [ctx.record] : [];
    },
  },
});

mock.module("../lib/supabase-auth.js", {
  exports: { verifySupabaseToken: async () => ctx.claims },
});

const { resolveIdentity, IdentityError } = await import("./identity.js");

const TENANT = "a1W7y000007AszBEAS";
const DEALER = "a0Y0000000DealerA";

/** A Salesforce row as the identity SOQL would return it. */
const sfRecord = (over = {}) => ({
  Id: "a1O7y00000s5sK1EAI",
  First_Name__c: "Test",
  Last_Name__c: "User",
  Email__c: "t@example.com",
  Access_Level__c: "Sales Rep",
  Super_Admin__c: false,
  Active__c: true,
  Client__c: TENANT,
  Client__r: { Name: "harmon" },
  Supabase_User_Id__c: "auth-uuid-1",
  Dealer__c: DEALER,
  Dealer__r: { Name: "ZZ TEST DEALER A", Active__c: true, Is_Internal__c: false },
  ...over,
});

// ---------------------------------------------------------------------------
// The SOQL must ask for what the decision needs
// ---------------------------------------------------------------------------

test("the identity SOQL selects the dealer sub-object, not just the id", async () => {
  ctx.record = sfRecord();
  await resolveIdentity("Bearer x");
  // Asserted on the SOQL STRING, deliberately. The mock returns Dealer__r whether or
  // not the query asked for it, so a test that only checked the result would pass with
  // the traversal deleted — and in production that deletion silently sends every sales
  // user to scope `none`.
  assert.match(ctx.lastSoql, /Dealer__c/);
  assert.match(ctx.lastSoql, /Dealer__r\.Active__c/);
  assert.match(ctx.lastSoql, /Dealer__r\.Is_Internal__c/);
  assert.match(ctx.lastSoql, /Dealer__r\.Name/);
});

// ---------------------------------------------------------------------------
// The mapping, over rows that actually occur
// ---------------------------------------------------------------------------

test("a rep with an ACTIVE dealer resolves to scope own, with the dealer attached", async () => {
  ctx.record = sfRecord();
  const id = await resolveIdentity("Bearer x");
  assert.equal(id.user.dealer.id, DEALER);
  assert.equal(id.user.dealer.name, "ZZ TEST DEALER A");
  assert.equal(id.user.dealer.active, true);
  assert.equal(id.access.scope, "own");
  assert.equal(id.access.dealerId, DEALER);
  assert.equal(id.access.tenantId, TENANT);
  assert.deepEqual(id.access.modules, ["customer", "solar", "user"]);
});

test("a Sales Dealer resolves to scope dealer", async () => {
  ctx.record = sfRecord({ Access_Level__c: "Sales Dealer" });
  const id = await resolveIdentity("Bearer x");
  assert.equal(id.access.scope, "dealer");
});

test("Harmon staff resolve to tenant scope with a null dealer", async () => {
  for (const level of ["Executive", "Admin", "Manager"]) {
    ctx.record = sfRecord({ Access_Level__c: level, Dealer__c: null, Dealer__r: null });
    const id = await resolveIdentity("Bearer x");
    assert.equal(id.access.scope, "tenant", level);
    assert.equal(id.user.dealer, null, level);
    assert.equal(id.access.dealerId, null, level);
  }
});

// ---------------------------------------------------------------------------
// Fail-closed, on the rows that actually caused trouble
// ---------------------------------------------------------------------------

test("FAIL CLOSED: a dealer id with NO Dealer__r sub-object resolves to none", async () => {
  // This is the shape a dropped `Dealer__r.Active__c` from the SELECT produces. It must
  // not read as "dealer present, therefore active" — the whole point is that the
  // absence of a field can never be a permission.
  ctx.record = sfRecord({ Dealer__r: null });
  const id = await resolveIdentity("Bearer x");
  assert.equal(id.access.scope, "none");
  assert.deepEqual(id.access.modules, []);
});

test("FAIL CLOSED: an INACTIVE dealer resolves to none", async () => {
  ctx.record = sfRecord({
    Dealer__r: { Name: "ZZ TEST DEALER INACTIVE", Active__c: false, Is_Internal__c: false },
  });
  const id = await resolveIdentity("Bearer x");
  assert.equal(id.access.scope, "none");
  assert.equal(id.user.dealer.active, false);
});

test("FAIL CLOSED: a sales role with NO dealer resolves to none, not to all dealers", async () => {
  ctx.record = sfRecord({ Dealer__c: null, Dealer__r: null });
  const id = await resolveIdentity("Bearer x");
  assert.equal(id.access.scope, "none");
});

test("FAIL CLOSED: a blank or unknown Access_Level__c resolves to none", async () => {
  for (const level of [null, "", "Dispatcher", "Client"]) {
    ctx.record = sfRecord({ Access_Level__c: level });
    const id = await resolveIdentity("Bearer x");
    assert.equal(id.access.scope, "none", JSON.stringify(level));
  }
});

test("Technician resolves to none (Phase II defines it; until then, nothing)", async () => {
  ctx.record = sfRecord({ Access_Level__c: "Technician", Dealer__c: null, Dealer__r: null });
  const id = await resolveIdentity("Bearer x");
  assert.equal(id.access.scope, "none");
  assert.equal(id.access.level, "Technician"); // the raw level survives, for the report
});

test("Dealer__r booleans are STRICT — a non-boolean active is not true", async () => {
  ctx.record = sfRecord({ Dealer__r: { Name: "x", Active__c: "true", Is_Internal__c: 1 } });
  const id = await resolveIdentity("Bearer x");
  assert.equal(id.user.dealer.active, false);
  assert.equal(id.user.dealer.isInternal, false);
  assert.equal(id.access.scope, "none");
});
