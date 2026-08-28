// Tests for lib/access-enforce.js — the shared action/record gate (D-064 §3.6, Phase 5).
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE LAMBDA TESTS. Seven Lambdas now share these
// four functions. Testing the rule once, here, and the WIRING in each Lambda, is the
// difference between one authority and seven — which is the whole premise of D-064,
// whose predecessor spread one decision across three places that disagreed.
//
// The existing Lambda test suites pass unchanged with these gates in place, and that is
// itself the property worth naming: with ACCESS_MODEL_MODE unset every gate is a no-op,
// so the code can be DEPLOYED before the flag is set. Every phase has shipped that way.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import { resolveScope, accessBlock } from "./access.js";

const TENANT = "a1W7y000007AszBEAS";
const REP_A = "a1O7y00000REPAAAAA";
const DEALER = "a0Y0000000DEALERAA";
const CUST = "a1P000000000001AAA";

const ctx = { rows: [], soqlSeen: [], throwOnQuery: false };

mock.module("./salesforce.js", {
  exports: {
    soqlEscapeString: (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    sfQuery: async (soql) => {
      ctx.soqlSeen.push(soql);
      if (ctx.throwOnQuery) throw new Error("Salesforce unavailable");
      return ctx.rows;
    },
  },
});

const {
  enforcedAccess,
  alwaysEnforcedAccess,
  assertAction,
  assertRecordVisible,
  assertActionOnRecord,
} = await import("./access-enforce.js");

function accessFor(level, over = {}) {
  const user = {
    id: REP_A,
    accessLevel: level,
    dealer: { id: DEALER, active: true, isInternal: false },
    ...over,
  };
  return accessBlock(resolveScope(user, TENANT));
}
const REP = accessFor("Sales Rep");
const ADMIN = accessFor("Admin", { dealer: null });

test.beforeEach(() => {
  ctx.rows = [{ Id: CUST }];
  ctx.soqlSeen = [];
  ctx.throwOnQuery = false;
  delete process.env.ACCESS_MODEL_MODE;
});

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

test("enforcedAccess is NULL unless the mode is enforce", () => {
  const identity = { access: REP };
  assert.equal(enforcedAccess(identity), null, "unset");
  process.env.ACCESS_MODEL_MODE = "shadow";
  assert.equal(enforcedAccess(identity), null, "shadow measures, it does not enforce");
  process.env.ACCESS_MODEL_MODE = "enforce";
  assert.equal(enforcedAccess(identity), REP);
});

test("alwaysEnforcedAccess IGNORES the mode — Phase 5 gates cannot be switched off", () => {
  // The switch may make the system tighter, never looser than the day before. Phase 5
  // REMOVED the TEMP solar-files 403, so a switchable gate would mean the documented
  // incident rollback (ACCESS_MODEL_MODE=off) re-opens Solar files to every sales rep,
  // at exactly the moment somebody is already dealing with a problem.
  const identity = { access: REP };
  for (const mode of ["off", "shadow", "enforce", undefined]) {
    if (mode === undefined) delete process.env.ACCESS_MODEL_MODE;
    else process.env.ACCESS_MODEL_MODE = mode;
    assert.equal(alwaysEnforcedAccess(identity), REP, `mode=${mode}`);
  }
});

test("a null access makes every gate a no-op — deploy before the flag", async () => {
  assert.equal(assertAction("files.solar.list", null), null);
  assert.equal(await assertRecordVisible("customer", CUST, null), null);
  assert.equal(await assertActionOnRecord("files.solar.list", "solar", CUST, null), null);
  assert.deepEqual(ctx.soqlSeen, [], "and costs no Salesforce round trip");
});

// ---------------------------------------------------------------------------
// The action gate
// ---------------------------------------------------------------------------

test("solar files are closed to a sales role on ALL FOUR routes (§3.6)", () => {
  for (const action of [
    "files.solar.list",
    "files.solar.related",
    "files.solar.upload",
    "files.solar.delete",
  ]) {
    const denied = assertAction(action, REP);
    assert.ok(denied, `${action} must be refused`);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "ACTION_FORBIDDEN");
  }
});

test("customer files are OPEN to a sales role, except delete", () => {
  for (const action of ["files.customer.list", "files.customer.download", "files.customer.upload"]) {
    assert.equal(assertAction(action, REP), null, action);
  }
  const del = assertAction("files.customer.delete", REP);
  assert.ok(del, "delete is tenant-scope only — destructive and unrecoverable");
  assert.equal(del.status, 403);
});

test("the action gate is 403, never 404 — it names a capability, not a record", () => {
  // The inverse of the record rule below. Refusing a capability leaks nothing about
  // what exists, so there is no oracle to protect against and an honest 403 is right.
  assert.equal(assertAction("budget.recalc", REP).status, 403);
  assert.equal(assertAction("acumatica.sync", REP).status, 403);
});

test("tenant scope may perform every gated action", () => {
  for (const action of [
    "files.solar.list", "files.solar.delete", "files.customer.delete",
    "budget.recalc", "acumatica.sync", "aurora.design_request",
  ]) {
    assert.equal(assertAction(action, ADMIN), null, action);
  }
});

// ---------------------------------------------------------------------------
// The record gate
// ---------------------------------------------------------------------------

test("a visible record passes, and the SOQL carries the row filter", async () => {
  assert.equal(await assertRecordVisible("customer", CUST, REP), null);
  const soql = ctx.soqlSeen[0];
  assert.match(soql, new RegExp(`Id = '${CUST}'`));
  assert.match(soql, new RegExp(`Client__c = '${TENANT}'`));
  assert.match(soql, new RegExp(`Sales_Rep__c = '${REP_A}'`));
});

test("a record outside the filter is 404, NEVER 403", async () => {
  // A 403 on a record id confirms the record exists, which turns a file endpoint —
  // which takes a record id in the path — into an enumeration oracle.
  ctx.rows = [];
  const denied = await assertRecordVisible("customer", CUST, REP);
  assert.equal(denied.status, 404);
  assert.equal(denied.body.code, "RECORD_NOT_FOUND");
});

test("A FAILED VISIBILITY QUERY DENIES", async () => {
  // "Could not establish visibility" is not "allowed". A Salesforce hiccup must not
  // open a file listing.
  ctx.throwOnQuery = true;
  const denied = await assertRecordVisible("customer", CUST, REP);
  assert.equal(denied.status, 404, "fail closed");
});

test("a module denied to the role is 404 on a record, with no query at all", async () => {
  const denied = await assertRecordVisible("roofing", CUST, REP);
  assert.equal(denied.status, 404);
  assert.deepEqual(ctx.soqlSeen, [], "a denied module needs no round trip");
});

// ---------------------------------------------------------------------------
// Both together
// ---------------------------------------------------------------------------

test("assertActionOnRecord asks BOTH questions, action first", async () => {
  // canAction("aurora.design_request", rep) is TRUE for every rep — the role may do it.
  // Whether THIS rep may do it to THAT customer is the second question, and a caller
  // that asked only the first would let a rep fire a design request at any customer id.
  assert.equal(assertAction("aurora.design_request", REP), null, "the role may");
  ctx.rows = [];
  const denied = await assertActionOnRecord("aurora.design_request", "customer", CUST, REP);
  assert.equal(denied.status, 404, "but not on a record they cannot see");
});

test("the action gate short-circuits, so a forbidden action costs no query", async () => {
  const denied = await assertActionOnRecord("files.solar.list", "solar", CUST, REP);
  assert.equal(denied.status, 403);
  assert.deepEqual(ctx.soqlSeen, [], "fails cheapest first");
});

test("scope none is refused on both halves", async () => {
  const tech = accessFor("Technician");
  assert.equal(assertAction("files.customer.list", tech).status, 403);
  assert.equal((await assertRecordVisible("customer", CUST, tech)).status, 404);
});
