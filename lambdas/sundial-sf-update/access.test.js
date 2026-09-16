// Tests for the ACCESS MODEL gates on the WRITE path (sundial-sf-update, D-064 §3.4).
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// This is the one write-path change of the access-model rollout, and the failure modes
// are asymmetric: a read that is too narrow shows a user an empty list, a write that is
// too wide lets a rep hand themselves another rep's book. So the assertions below are
// weighted toward what must be REFUSED, and every one of them names the record or field
// that would move if the gate came out.
//
// Salesforce and Supabase are mocked at the module boundary; lib/access.js and the
// field manifest are the REAL ones, so these test the shipped rules rather than a
// restatement of them.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import { resolveScope, accessBlock } from "../../lib/access.js";
import customerManifest from "../../lib/field-manifest/customer.json" with { type: "json" };

const TENANT = "a1W7y000007AszBEAS";
const REP_A = "a1O7y00000REPAAAAA";
const REP_B = "a1O7y00000REPBBBBB";
const DEALER = "a0Y0000000DEALERAA";
const DEALER_B = "a0Y0000000DEALERBB";
const CUST_1 = "a1P000000000001AAA";

const ctx = {
  identity: null,
  soqlSeen: [],
  soqlRows: [], // what the ownership/visibility pre-check returns
  userLookup: null, // what the Sundial_User__c lookup returns (invariant 2)
  writes: [], // { method, path, body }
  warns: [],
};

function identityFor(accessLevel, { userId = REP_A, dealer = { id: DEALER, active: true, isInternal: false } } = {}) {
  const user = { id: userId, accessLevel, dealer, hierarchyLevel: "Client" };
  return {
    user,
    access: accessBlock(resolveScope(user, TENANT)),
    tenantId: TENANT,
    tenantSlug: "harmon",
  };
}

function reset() {
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.soqlSeen = [];
  ctx.soqlRows = [{ Id: CUST_1 }]; // visible by default; tests narrow it
  ctx.writes = [];
  ctx.warns = [];
  ctx.userLookup = { Id: REP_B, Dealer__c: DEALER_B };
  process.env.ACCESS_MODEL_MODE = "enforce";
}

mock.module("../../lib/identity.js", {
  exports: { resolveIdentity: async () => ctx.identity },
});

mock.module("../../lib/salesforce.js", {
  exports: {
    soqlEscapeString: (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    getSalesforceToken: async () => ({
      access_token: "tok",
      instance_url: "https://example.my.salesforce.com",
    }),
    sfQuery: async (soql) => {
      ctx.soqlSeen.push(soql);
      // The rep lookup is a different query from the visibility pre-check and must
      // answer differently, or the invariant-2 tests would pass on the wrong row.
      if (/FROM Sundial_User__c/.test(soql)) {
        return ctx.userLookup ? [ctx.userLookup] : [];
      }
      return ctx.soqlRows;
    },
  },
});

mock.module("../../lib/supabase.js", {
  exports: {
    getSupabaseClient: async () => ({
      from: () => ({
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      }),
    }),
    getSupabaseConfig: async () => ({ url: "https://supa.example.co", serviceRoleKey: "svc" }),
  },
});

// One describe for Sundial_Customer__c, plus the Salesforce write endpoint.
const DESCRIBE_FIELDS = [
  { name: "Id", updateable: false, createable: false },
  { name: "Client__c", updateable: true, createable: true },
  { name: "Sales_Rep__c", updateable: true, createable: true },
  { name: "Dealer__c", updateable: true, createable: true },
  { name: "Stage__c", updateable: true, createable: true },
  { name: "First_Name__c", updateable: true, createable: true },
  { name: "Last_Name__c", updateable: true, createable: true },
  { name: "Commission_Total__c", updateable: true, createable: true },
  { name: "Burden_Rate__c", updateable: true, createable: true },
];

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/describe")) {
    return { ok: true, status: 200, json: async () => ({ fields: DESCRIBE_FIELDS }) };
  }
  ctx.writes.push({
    method: init?.method,
    path: u,
    body: init?.body ? JSON.parse(init.body) : null,
  });
  return {
    ok: true,
    status: init?.method === "POST" ? 201 : 204,
    json: async () => ({ id: "a1PnewRECORD00001", success: true, errors: [] }),
    text: async () => "",
  };
};

const realWarn = console.warn;
console.warn = (...a) => ctx.warns.push(a.map(String).join(" "));

const { handler } = await import("./index.js");

function patchEvent(object, id, fields) {
  return {
    requestContext: { http: { method: "PATCH" } },
    rawPath: `/sf/${object}/${id}`,
    pathParameters: { object, id },
    headers: { authorization: "Bearer t", origin: "http://localhost:5173", "content-type": "application/json" },
    body: JSON.stringify({ fields }),
  };
}
function postEvent(object, fields) {
  return {
    requestContext: { http: { method: "POST" } },
    rawPath: `/sf/${object}`,
    pathParameters: { object },
    headers: { authorization: "Bearer t", origin: "http://localhost:5173", "content-type": "application/json" },
    body: JSON.stringify({ fields }),
  };
}

test.beforeEach(reset);
test.after(() => { console.warn = realWarn; });

// ---------------------------------------------------------------------------
// The four gates
// ---------------------------------------------------------------------------

test("PATCH of an EDITABLE field succeeds for a rep on their own record", async () => {
  // The gate that must NOT over-fire. A fail-closed change whose failure mode is "reps
  // can no longer save anything" is not safer, it is broken — and it is the likeliest
  // way this lands wrong.
  const editable = customerManifest.roles["Sales Rep"].edit;
  assert.ok(editable.includes("First_Name__c"), "fixture assumption: sheet allows this");

  const res = await handler(patchEvent("customer", CUST_1, { First_Name__c: "Zed" }));
  assert.equal(res.statusCode, 200);
  assert.equal(ctx.writes.length, 1);
  assert.deepEqual(ctx.writes[0].body, { First_Name__c: "Zed" });
});

test("PATCH of a HIDDEN field is 403 FIELD_FORBIDDEN, and nothing is written", async () => {
  const res = await handler(
    patchEvent("customer", CUST_1, { First_Name__c: "Zed", Commission_Total__c: 1 })
  );
  assert.equal(res.statusCode, 403);
  const body = JSON.parse(res.body);
  assert.equal(body.code, "FIELD_FORBIDDEN");
  assert.deepEqual(body.fields, ["Commission_Total__c"], "the response names the field");
  assert.equal(ctx.writes.length, 0, "THE WHOLE PATCH IS REJECTED, including the legal field");
});

test("a forbidden field in a PATCH body is LOGGED with the caller (§3.4 step 3)", async () => {
  await handler(patchEvent("customer", CUST_1, { Commission_Total__c: 1 }));
  const line = ctx.warns.find((w) => w.includes("FIELD_FORBIDDEN"));
  assert.ok(line, "an attack signal that is not logged did not happen, as far as anyone knows");
  const parsed = JSON.parse(line);
  assert.equal(parsed.user, REP_A);
  assert.equal(parsed.scope, "own");
  assert.deepEqual(parsed.fields, ["Commission_Total__c"]);
});

test("PATCH of a READ-but-not-edit field is refused", async () => {
  // `read` is not `edit`. A field the rep can SEE is not therefore a field they may set.
  const readOnly = customerManifest.roles["Sales Rep"].read.find(
    (f) => !customerManifest.roles["Sales Rep"].edit.includes(f)
  );
  assert.ok(readOnly, "fixture assumption: the sheet has at least one read-only field");
  const res = await handler(patchEvent("customer", CUST_1, { [readOnly]: "x" }));
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).code, "FIELD_FORBIDDEN");
});

test("EVERY protected field is refused, even though the describe says updateable", async () => {
  // Salesforce would happily accept all four. The manifest is what refuses them, and
  // SALES_PROTECTED_FIELDS refuses them a second time in case the manifest ever does not.
  for (const field of ["Sales_Rep__c", "Dealer__c", "Client__c", "Stage__c"]) {
    ctx.writes = [];
    const res = await handler(patchEvent("customer", CUST_1, { [field]: "x" }));
    assert.equal(res.statusCode, 403, field);
    assert.equal(ctx.writes.length, 0, `${field} must not reach Salesforce`);
  }
});

test("REASSIGNMENT is tenant-scope only — a rep cannot move a record to themselves", async () => {
  // The write that would defeat the entire model in one request: set Sales_Rep__c to
  // yourself on somebody else's deal and the row filter now agrees you own it.
  const res = await handler(patchEvent("customer", CUST_1, { Sales_Rep__c: REP_A }));
  assert.equal(res.statusCode, 403);
  assert.equal(ctx.writes.length, 0);

  // Tenant scope may do it — that is invariant 2's path, and the dealer moves too.
  ctx.identity = identityFor("Admin", { dealer: null });
  const ok = await handler(patchEvent("customer", CUST_1, { Sales_Rep__c: REP_B }));
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ctx.writes[0].body, { Sales_Rep__c: REP_B, Dealer__c: DEALER_B });
});

test("PATCH of a record OUTSIDE the row filter is 404, and never reaches Salesforce", async () => {
  ctx.soqlRows = []; // the visibility-scoped existence check finds nothing
  const res = await handler(patchEvent("customer", CUST_1, { First_Name__c: "Zed" }));
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).code, "RECORD_NOT_FOUND");
  assert.equal(ctx.writes.length, 0);
});

test("the visibility check is ONE query with the row filter ANDed in", async () => {
  // Not "check tenant, then check scope" — one question, one answer, no window between
  // deciding it is visible and writing to it.
  await handler(patchEvent("customer", CUST_1, { First_Name__c: "Zed" }));
  const soql = ctx.soqlSeen[0];
  assert.match(soql, new RegExp(`Id = '${CUST_1}'`));
  assert.match(soql, new RegExp(`Client__c = '${TENANT}'`));
  assert.match(soql, new RegExp(`Sales_Rep__c = '${REP_A}'`), "the row filter");
  assert.doesNotMatch(soql, / OR /, "never OR-ed");
  assert.equal(ctx.soqlSeen.length, 1, "one query, not two");
});

test("a DENIED module is 403 on both PATCH and POST", async () => {
  for (const object of ["roofing", "po"]) {
    ctx.writes = [];
    const p = await handler(patchEvent(object, CUST_1, { First_Name__c: "x" }));
    assert.equal(p.statusCode, 403, `${object} PATCH`);
    assert.equal(JSON.parse(p.body).code, "MODULE_FORBIDDEN");
    const c = await handler(postEvent(object, { First_Name__c: "x" }));
    assert.equal(c.statusCode, 403, `${object} POST`);
    assert.equal(ctx.writes.length, 0);
  }
});

// ---------------------------------------------------------------------------
// Create, and the stamping
// ---------------------------------------------------------------------------

test("CREATE stamps rep + dealer from the token, ignoring the body", async () => {
  const res = await handler(postEvent("customer", { First_Name__c: "New" }));
  assert.equal(res.statusCode, 201);
  const sent = ctx.writes[0].body;
  assert.equal(sent.Sales_Rep__c, REP_A, "stamped from the AccessContext");
  assert.equal(sent.Dealer__c, DEALER, "and the dealer with it (§2.3 invariant 1)");
  assert.equal(sent.Client__c, TENANT, "as Client__c already was");
});

test("CREATE naming another rep is REFUSED, not silently overwritten", async () => {
  // Silently stamping over it would let the caller believe their input was honoured.
  const res = await handler(
    postEvent("customer", { First_Name__c: "New", Sales_Rep__c: REP_B })
  );
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).code, "FIELD_FORBIDDEN");
  assert.equal(ctx.writes.length, 0);
});

test("a sales role may create ONLY customer (§3.4 step 5)", async () => {
  for (const object of ["solar", "user"]) {
    ctx.writes = [];
    const res = await handler(postEvent(object, { First_Name__c: "x" }));
    assert.equal(res.statusCode, 403, `${object} must be refused`);
    assert.equal(ctx.writes.length, 0);
  }
});

// ---------------------------------------------------------------------------
// §2.3 invariant 1, THE TENANT-SCOPE HALF (2026-09-16)
// ---------------------------------------------------------------------------
// This block used to assert `!("Dealer__c" in sent)` under the heading "TENANT scope
// create is unchanged". That assertion was PINNING THE BUG: staff create at tenant scope
// with a rep in the body (a coordinator acting for a rep, and the portal's Create Project
// button), and the record landed with a rep and a null dealer — invisible to that rep's
// own dealer manager. 8 Customers and 6 Solar in the 18 days after the backfill, growing.
//
// A1 says the deal's dealer comes from its rep and from nothing else. That is true on
// every path or it is not an invariant.

test("TENANT create WITH a rep derives Dealer__c from that rep (A1, create half)", async () => {
  ctx.identity = identityFor("Admin", { dealer: null });
  const res = await handler(postEvent("customer", { First_Name__c: "New", Sales_Rep__c: REP_B }));
  assert.equal(res.statusCode, 201);
  const sent = ctx.writes[0].body;
  assert.equal(sent.Sales_Rep__c, REP_B, "staff still create on a rep's behalf");
  assert.equal(sent.Dealer__c, DEALER_B, "and the dealer is derived, not left null");
  assert.equal(sent.Client__c, TENANT, "tenant stamping unchanged");
});

test("TENANT create with NO rep writes NO dealer — D-049 deals keep theirs", async () => {
  // §2.3 invariant 6: a rep-less deal's dealer is set once and left alone. Aurora
  // dealer-originated deals arrive with a dealer and no rep at all, so deriving
  // unconditionally here would CLEAR them — a fix that destroys data.
  ctx.identity = identityFor("Admin", { dealer: null });
  const res = await handler(postEvent("customer", { First_Name__c: "New" }));
  assert.equal(res.statusCode, 201);
  const sent = ctx.writes[0].body;
  assert.ok(!("Sales_Rep__c" in sent), "no rep supplied, none invented");
  assert.ok(!("Dealer__c" in sent), "and no dealer written over a null");
  assert.equal(
    ctx.soqlSeen.filter((q) => /FROM Sundial_User__c/.test(q)).length,
    0,
    "and no rep lookup is made at all"
  );
});

test("TENANT create with a dealer but NO rep keeps the supplied dealer", async () => {
  // The D-049 shape stated positively: a dealer-originated deal with no rep must survive
  // create with its dealer intact.
  ctx.identity = identityFor("Admin", { dealer: null });
  const res = await handler(
    postEvent("customer", { First_Name__c: "New", Dealer__c: DEALER_B })
  );
  assert.equal(res.statusCode, 201);
  assert.equal(ctx.writes[0].body.Dealer__c, DEALER_B, "left exactly as supplied");
});

test("TENANT create: a rep with NO dealer writes an explicit null", async () => {
  ctx.identity = identityFor("Admin", { dealer: null });
  ctx.userLookup = { Id: REP_B, Dealer__c: null }; // an unattributed rep
  const res = await handler(postEvent("customer", { First_Name__c: "New", Sales_Rep__c: REP_B }));
  assert.equal(res.statusCode, 201);
  const sent = ctx.writes[0].body;
  assert.ok("Dealer__c" in sent, "written explicitly, not omitted");
  assert.equal(sent.Dealer__c, null, "a rep with no dealer yields a null dealer");
});

test("TENANT create: the DERIVED dealer overrides one in the body, and warns", async () => {
  // A1: the dealer is never an independent input. Honouring both would let one request
  // name a rep from one dealer and a dealer from another — the disagreement invariant 5
  // exists to make impossible.
  ctx.identity = identityFor("Admin", { dealer: null });
  const res = await handler(
    postEvent("customer", { First_Name__c: "New", Sales_Rep__c: REP_B, Dealer__c: DEALER })
  );
  assert.equal(res.statusCode, 201);
  assert.equal(ctx.writes[0].body.Dealer__c, DEALER_B, "derived wins");
  assert.ok(
    ctx.warns.some((w) => String(w).includes("DEALER_DERIVED_OVERRIDE")),
    "and the override is logged, as on the PATCH path"
  );
});

test("TENANT create: an unknown rep is refused, and nothing is written", async () => {
  ctx.identity = identityFor("Admin", { dealer: null });
  ctx.userLookup = null; // not a user in this tenant
  const res = await handler(postEvent("customer", { First_Name__c: "New", Sales_Rep__c: REP_B }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, "INVALID_SALES_REP");
  assert.equal(ctx.writes.length, 0, "refused before the create, not after");
});

test("SALES-scope create is UNCHANGED — stamped from the token, no rep lookup", async () => {
  // The sales branch already satisfied A1 by construction (the rep IS the caller), and
  // the new derivation must not touch it — a second round-trip per create for a value
  // already known would be cost without meaning.
  const res = await handler(postEvent("customer", { First_Name__c: "New" }));
  assert.equal(res.statusCode, 201);
  const sent = ctx.writes[0].body;
  assert.equal(sent.Sales_Rep__c, REP_A, "stamped from the AccessContext");
  assert.equal(sent.Dealer__c, DEALER, "and the dealer with it");
  assert.equal(
    ctx.soqlSeen.filter((q) => /FROM Sundial_User__c/.test(q)).length,
    0,
    "no rep lookup on the sales path"
  );
});

// ---------------------------------------------------------------------------
// Tenant scope, and the switch
// ---------------------------------------------------------------------------

test("TENANT scope writes are BYTE-IDENTICAL to before this phase", async () => {
  // The rule that does not compress: enforcement may only narrow a sales role.
  ctx.identity = identityFor("Admin", { dealer: null });
  const res = await handler(
    patchEvent("customer", CUST_1, { Commission_Total__c: 1, Stage__c: "Sold" })
  );
  assert.equal(res.statusCode, 200, "staff still write commission and stage");
  assert.deepEqual(ctx.writes[0].body, { Commission_Total__c: 1, Stage__c: "Sold" });
  const soql = ctx.soqlSeen[0];
  assert.doesNotMatch(soql, /Sales_Rep__c/, "and no row filter is added for them");
});

test("with the mode OFF, the write path is exactly as it was", async () => {
  // The same rollback the reads have: one env var, no redeploy.
  delete process.env.ACCESS_MODEL_MODE;
  const res = await handler(
    patchEvent("customer", CUST_1, { Commission_Total__c: 1 })
  );
  assert.equal(res.statusCode, 200, "a rep writing a hidden field is allowed again");
  assert.deepEqual(ctx.writes[0].body, { Commission_Total__c: 1 });
});

test("scope NONE cannot write at all", async () => {
  ctx.identity = identityFor("Technician", { userId: REP_B });
  assert.equal((await handler(patchEvent("customer", CUST_1, { First_Name__c: "x" }))).statusCode, 403);
  assert.equal((await handler(postEvent("customer", { First_Name__c: "x" }))).statusCode, 403);
  assert.equal(ctx.writes.length, 0);
});

// ---------------------------------------------------------------------------
// §2.3 invariant 2 — reassignment re-stamps the dealer
// ---------------------------------------------------------------------------
// The failure this prevents is invisible from every seat that would report it: the
// record looks fine, the new rep can see it (Sales_Rep__c moved), the old rep correctly
// loses it — and only the LOSING dealer's manager still sees a deal their organization
// no longer sells, while the WINNING dealer's manager cannot see one their own rep owns.

test("reassignment moves Dealer__c with Sales_Rep__c, in the SAME update", async () => {
  ctx.identity = identityFor("Admin", { dealer: null });
  ctx.userLookup = { Id: REP_B, Dealer__c: DEALER_B };

  const res = await handler(patchEvent("customer", CUST_1, { Sales_Rep__c: REP_B }));

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.writes.length, 1, "ONE Salesforce write, not a follow-up");
  assert.deepEqual(ctx.writes[0].body, {
    Sales_Rep__c: REP_B,
    Dealer__c: DEALER_B,
    // A second write could fail on its own and leave exactly the broken state this
    // exists to prevent, so both fields must be in the same PATCH.
  });
});

test("a PATCH that does NOT touch Sales_Rep__c leaves Dealer__c alone", async () => {
  ctx.identity = identityFor("Admin", { dealer: null });

  const res = await handler(patchEvent("customer", CUST_1, { First_Name__c: "Zed" }));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(ctx.writes[0].body, { First_Name__c: "Zed" });
  assert.ok(!("Dealer__c" in ctx.writes[0].body), "no dealer stamp on an unrelated edit");
  assert.equal(
    ctx.soqlSeen.filter((q) => /FROM Sundial_User__c/.test(q)).length,
    0,
    "and no rep lookup is performed"
  );
});

test("clearing the rep clears the dealer — null is WRITTEN, not omitted", async () => {
  // Leaving the old value would be the same leak with extra steps: the deal would stay
  // shared with an organization that has no rep on it at all.
  ctx.identity = identityFor("Admin", { dealer: null });

  const res = await handler(patchEvent("customer", CUST_1, { Sales_Rep__c: null }));

  assert.equal(res.statusCode, 200);
  assert.ok("Dealer__c" in ctx.writes[0].body, "the key must be present");
  assert.equal(ctx.writes[0].body.Dealer__c, null);
  assert.equal(
    ctx.soqlSeen.filter((q) => /FROM Sundial_User__c/.test(q)).length,
    0,
    "clearing needs no lookup"
  );
});

test("a rep with NO dealer stamps a null dealer", async () => {
  ctx.identity = identityFor("Admin", { dealer: null });
  ctx.userLookup = { Id: REP_B, Dealer__c: null }; // an unattributed rep

  const res = await handler(patchEvent("customer", CUST_1, { Sales_Rep__c: REP_B }));

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.writes[0].body.Dealer__c, null, "not the old dealer, and not absent");
});

test("the DERIVED dealer wins over one supplied in the body, and says so", async () => {
  // A1: the dealer is derived from the rep and is never an independent input. Honouring
  // both would let one PATCH set a rep from one dealer and a dealer from another —
  // exactly the disagreement invariant 5 exists to make impossible.
  ctx.identity = identityFor("Admin", { dealer: null });
  ctx.userLookup = { Id: REP_B, Dealer__c: DEALER_B };

  const res = await handler(
    patchEvent("customer", CUST_1, { Sales_Rep__c: REP_B, Dealer__c: DEALER })
  );

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.writes[0].body.Dealer__c, DEALER_B, "derived, not supplied");
  const note = ctx.warns.find((w) => w.includes("DEALER_DERIVED_OVERRIDE"));
  assert.ok(note, "an override that is not logged is indistinguishable from a bug");
  assert.equal(JSON.parse(note).supplied, DEALER);
  assert.equal(JSON.parse(note).derived, DEALER_B);
});

test("a Sales_Rep__c that is not a user in this tenant is REFUSED", async () => {
  // The lookup is tenant-scoped, so this also blocks a cross-tenant reassignment.
  ctx.identity = identityFor("Admin", { dealer: null });
  ctx.userLookup = null; // the query returns no rows

  const res = await handler(
    patchEvent("customer", CUST_1, { Sales_Rep__c: "a1O000000000BOGUS" })
  );

  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, "INVALID_SALES_REP");
  assert.equal(ctx.writes.length, 0, "nothing is written on a bad rep id");
});

test("a SALES role still cannot reach any of this", async () => {
  // Invariant 2 is tenant-scope only by construction: Sales_Rep__c is protected, so a
  // rep is refused at the field gate long before the re-stamp could run.
  ctx.identity = identityFor("Sales Rep", { userId: REP_A });
  ctx.userLookup = { Id: REP_B, Dealer__c: DEALER_B };

  const res = await handler(patchEvent("customer", CUST_1, { Sales_Rep__c: REP_B }));

  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).code, "FIELD_FORBIDDEN");
  assert.equal(ctx.writes.length, 0);
  assert.equal(
    ctx.soqlSeen.filter((q) => /FROM Sundial_User__c/.test(q)).length,
    0,
    "the lookup never runs for a role that cannot reassign"
  );
});
