// Handler-level tests for sundial-user-admin — the two paths test.js cannot reach.
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// WHY A SECOND FILE. test.js covers deriveHierarchyLevel() and SALES_ACCESS_LEVELS as
// pure functions over constants, which is the right shape for them — no mocks, no
// import order to think about. The three rules below are not pure: they live inside
// handleCreate and handleUpdate, between a Salesforce read and a Salesforce write, and
// pinning them means driving the real handler with the real router. Mixing mock.module
// into test.js would force every pure test to pay for that setup. Same Lambda, two
// files, two shapes.
//
// WHAT THESE PIN.
//   1. PATCH with accessLevel writes Access_Level__c AND the derived
//      Hierarchy_Level__c in the SAME patch. Without it, re-levelling a Sales Rep to
//      Manager leaves the old hierarchy behind and the TEMP guard in sundial-sf-query
//      goes on serving them a rep's records — the create-time bug, on the update path.
//   2. PATCH WITHOUT accessLevel must not touch Hierarchy_Level__c at all. The field
//      is derived from the access level; a patch that does not move the access level
//      has no business rewriting it.
//   3. The SUPER_ADMIN_WITH_SALES_ROLE refusal, on BOTH doors — create (a request
//      asking for super admin) and PATCH (an existing super admin re-levelled down).
//      access-model.md §1.2: `own`/`dealer` scope plus Manage Users is an account that
//      can provision its way out of its own scope.
//
// The Salesforce and Supabase mocks are PostgREST/REST-shaped stubs over a mutable
// `ctx`, the same pattern as sundial-comment-notify/test.js. Salesforce writes are
// RECORDED rather than faked away, because every assertion here is about the exact
// field map that reaches Salesforce — a stub that swallowed the fields would pass
// whatever the handler did.

import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const TENANT = "a1W7y000007AszBEAS";
const CALLER_ID = "a1O7y00000CallerAA";
const TARGET_ID = "a1O7y00000TargetAA";
const TARGET_UID = "12ba1387-7b7a-48c8-9d07-b2578f4cbddf";

// ---------------------------------------------------------------------------
// Mutable context the mocks read from
// ---------------------------------------------------------------------------
const ctx = {
  identity: null,
  identityError: null,
  queryRows: [], // successive sfQuery results, shifted in order
  queries: [], // every SOQL string that was issued
  created: [], // { sfObject, fields }
  updated: [], // { sfObject, id, fields }
  createError: null,
  updateError: null,
  authCalls: [],
  banCalls: [],
};

function resetCtx() {
  ctx.identity = {
    tenantId: TENANT,
    user: { id: CALLER_ID, superAdmin: true },
  };
  ctx.identityError = null;
  ctx.queryRows = [];
  ctx.queries = [];
  ctx.created = [];
  ctx.updated = [];
  ctx.createError = null;
  ctx.updateError = null;
  ctx.authCalls = [];
  ctx.banCalls = [];
}
resetCtx();

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
mock.module("../../lib/identity.js", {
  exports: {
    resolveIdentity: async () => {
      if (ctx.identityError) throw ctx.identityError;
      return ctx.identity;
    },
    IdentityError: class IdentityError extends Error {},
  },
});

mock.module("../../lib/salesforce.js", {
  exports: {
    // Real escaping — a test that produced a quote-breaking value should not pass.
    soqlEscapeString: (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    sfQuery: async (soql) => {
      ctx.queries.push(soql);
      return ctx.queryRows.shift() ?? [];
    },
    sfCreateRecord: async (sfObject, fields) => {
      if (ctx.createError) throw new Error(ctx.createError);
      ctx.created.push({ sfObject, fields });
      return { id: TARGET_ID };
    },
    sfUpdateRecord: async (sfObject, id, fields) => {
      if (ctx.updateError) throw new Error(ctx.updateError);
      ctx.updated.push({ sfObject, id, fields });
      return { success: true };
    },
  },
});

function supabaseStub() {
  return {
    auth: {
      admin: {
        createUser: async (args) => {
          ctx.authCalls.push({ op: "createUser", args });
          return { data: { user: { id: TARGET_UID } }, error: null };
        },
        inviteUserByEmail: async (email, opts) => {
          ctx.authCalls.push({ op: "inviteUserByEmail", email, opts });
          return { data: { user: { id: TARGET_UID } }, error: null };
        },
        listUsers: async () => ({ data: { users: [] }, error: null }),
        deleteUser: async (id) => {
          ctx.authCalls.push({ op: "deleteUser", id });
          return { error: null };
        },
        updateUserById: async (id, args) => {
          ctx.banCalls.push({ id, args });
          return { error: null };
        },
      },
    },
  };
}

mock.module("../../lib/supabase.js", {
  exports: {
    getSupabaseClient: async () => supabaseStub(),
    getSupabaseConfig: async () => ({ url: "https://x.supabase.co", serviceRoleKey: "svc" }),
  },
});

const { handler } = await import("./index.js");

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------
function postEvent(body) {
  return {
    requestContext: { http: { method: "POST" } },
    headers: { authorization: "Bearer test", origin: "http://localhost:5173" },
    rawPath: "/admin/users",
    body: JSON.stringify(body),
  };
}

function patchEvent(id, body) {
  return {
    requestContext: { http: { method: "PATCH" } },
    headers: { authorization: "Bearer test", origin: "http://localhost:5173" },
    rawPath: `/admin/users/${id}`,
    pathParameters: { id },
    body: JSON.stringify(body),
  };
}

const parse = (res) => JSON.parse(res.body);

// A valid create body. Individual tests override only what they are testing, so a
// failure points at the field under test rather than at a typo'd fixture.
function createBody(over = {}) {
  return {
    email: "zz.newuser@example.com",
    firstName: "ZZ",
    lastName: "New User",
    accessLevel: "Admin",
    credentialMode: "password",
    tempPassword: "temp-password-123",
    ...over,
  };
}

// PATCH reaches sfQuery once (the tenant/ownership pre-check). This is that row.
//
// D-064: it now also carries Access_Level__c and Dealer__c, because the dealer rule is
// evaluated against the state the PATCH RESULTS IN — which may come from the record
// rather than from the body.
function ownedRow(over = {}) {
  return [
    {
      Id: TARGET_ID,
      Supabase_User_Id__c: TARGET_UID,
      Super_Admin__c: false,
      Access_Level__c: "Manager",
      Dealer__c: null,
      ...over,
    },
  ];
}

const DEALER_ID = "a1X7y00001ASRILEA5";
const DEALER_NAME = "ZZ TEST DEALER A";
/** What the dealer validation lookup returns for an ACTIVE dealer in this tenant. */
function dealerRow(over = {}) {
  return [{ Id: DEALER_ID, Name: DEALER_NAME, Active__c: true, ...over }];
}

beforeEach(() => resetCtx());

// ===========================================================================
// (a) PATCH — the derived hierarchy rides along with the access level
// ===========================================================================

test("PATCH with accessLevel sets BOTH Access_Level__c and the derived Hierarchy_Level__c in one patch", async () => {
  ctx.queryRows = [ownedRow()];

  const res = await handler(patchEvent(TARGET_ID, { accessLevel: "Manager" }));

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.updated.length, 1, "exactly one Salesforce update");

  const { sfObject, id, fields } = ctx.updated[0];
  assert.equal(sfObject, "Sundial_User__c");
  assert.equal(id, TARGET_ID);
  assert.equal(fields.Access_Level__c, "Manager");
  assert.equal(
    fields.Hierarchy_Level__c,
    "Client",
    "Manager must derive to Client — leaving the old value behind is the bug this closes"
  );
});

test("PATCH re-levelling a rep UP does not leave the TEMP guard's value behind", async () => {
  // The concrete regression. Someone created under the old flat-"Sales Rep" default,
  // promoted to Executive: if Hierarchy_Level__c is not rewritten they keep being
  // served one hardcoded rep's records.
  ctx.queryRows = [ownedRow()];

  const res = await handler(patchEvent(TARGET_ID, { accessLevel: "Executive" }));

  assert.equal(res.statusCode, 200);
  assert.notEqual(
    ctx.updated[0].fields.Hierarchy_Level__c,
    "Sales Rep",
    "an Executive must never carry the TEMP guard's key"
  );
  assert.equal(ctx.updated[0].fields.Hierarchy_Level__c, "Client");
});

test("PATCH to an actual Sales Rep still derives Sales Rep", async () => {
  // D-064: moving INTO a sales role now requires a dealer, so the request carries one
  // and the lookup answers it. The hierarchy derivation under test is unchanged.
  ctx.queryRows = [ownedRow(), dealerRow()];

  await handler(patchEvent(TARGET_ID, { accessLevel: "Sales Rep", dealerId: DEALER_ID }));

  assert.equal(ctx.updated[0].fields.Access_Level__c, "Sales Rep");
  assert.equal(ctx.updated[0].fields.Hierarchy_Level__c, "Sales Rep");
});

test("PATCH to Sales Dealer derives Sales Manager", async () => {
  ctx.queryRows = [ownedRow(), dealerRow()];

  await handler(patchEvent(TARGET_ID, { accessLevel: "Sales Dealer", dealerId: DEALER_ID }));

  assert.equal(ctx.updated[0].fields.Access_Level__c, "Sales Dealer");
  assert.equal(ctx.updated[0].fields.Hierarchy_Level__c, "Sales Manager");
});

test("PATCH WITHOUT accessLevel leaves Hierarchy_Level__c untouched", async () => {
  ctx.queryRows = [ownedRow()];

  const res = await handler(
    patchEvent(TARGET_ID, { firstName: "Renamed", phone: "602-555-0100" })
  );

  assert.equal(res.statusCode, 200);
  const { fields } = ctx.updated[0];
  assert.equal(fields.First_Name__c, "Renamed");
  assert.equal(fields.Phone__c, "602-555-0100");
  assert.ok(
    !("Hierarchy_Level__c" in fields),
    "a patch that does not move the access level must not rewrite the derived field"
  );
  assert.ok(!("Access_Level__c" in fields));
});

test("PATCH of `active` alone leaves both role fields untouched", async () => {
  // The deactivate path also runs a Supabase ban; neither should drag a role field in.
  ctx.queryRows = [ownedRow()];

  const res = await handler(patchEvent(TARGET_ID, { active: false }));

  assert.equal(res.statusCode, 200);
  const { fields } = ctx.updated[0];
  assert.equal(fields.Active__c, false);
  assert.ok(!("Hierarchy_Level__c" in fields));
  assert.ok(!("Access_Level__c" in fields));
  assert.equal(ctx.banCalls.length, 1, "deactivation bans the Supabase auth user");
});

test("PATCH still refuses a caller-supplied hierarchyLevel", async () => {
  // The server owns the field; deriving it does not make it client-writable. Both
  // spellings stay in DISALLOWED, and the refusal happens before any Salesforce read.
  for (const key of ["hierarchyLevel", "Hierarchy_Level__c"]) {
    resetCtx();
    ctx.queryRows = [ownedRow()];

    const res = await handler(patchEvent(TARGET_ID, { [key]: "Client" }));

    assert.equal(res.statusCode, 400);
    const body = parse(res);
    assert.equal(body.code, "FIELD_NOT_ALLOWED");
    assert.ok(body.fields.includes(key));
    assert.equal(ctx.updated.length, 0, "nothing reaches Salesforce");
  }
});

// ===========================================================================
// (b) POST — the super-admin / sales-role refusal
// ===========================================================================

test("POST with superAdmin + a sales role returns 400 SUPER_ADMIN_WITH_SALES_ROLE — all four spellings", async () => {
  const spellings = [
    { superAdmin: true },
    { superAdmin: "true" },
    { Super_Admin__c: true },
    { Super_Admin__c: "true" },
  ];

  for (const spelling of spellings) {
    for (const accessLevel of ["Sales Rep", "Sales Dealer"]) {
      resetCtx();

      const res = await handler(postEvent(createBody({ accessLevel, ...spelling })));

      const label = `${JSON.stringify(spelling)} + ${accessLevel}`;
      assert.equal(res.statusCode, 400, label);
      const body = parse(res);
      assert.equal(body.code, "SUPER_ADMIN_WITH_SALES_ROLE", label);
      assert.equal(body.error, "invalid_role_combination", label);
      assert.match(body.message, new RegExp(accessLevel), label);

      // Refused BEFORE any side effect: no auth user, no Salesforce record, and not
      // even the duplicate-check query. A partially-honoured request is the thing
      // this refusal exists to prevent.
      assert.equal(ctx.created.length, 0, `${label} — no Salesforce record`);
      assert.equal(ctx.authCalls.length, 0, `${label} — no Supabase auth user`);
      assert.equal(ctx.queries.length, 0, `${label} — no Salesforce query`);
    }
  }
});

test("POST with superAdmin + a NON-sales role succeeds and never writes Super_Admin__c", async () => {
  for (const accessLevel of ["Executive", "Admin", "Manager", "Technician"]) {
    resetCtx();
    ctx.queryRows = [[]]; // duplicate check: no existing user

    const res = await handler(
      postEvent(createBody({ accessLevel, superAdmin: true }))
    );

    assert.equal(res.statusCode, 201, accessLevel);
    assert.equal(ctx.created.length, 1, accessLevel);

    const { fields } = ctx.created[0];
    assert.equal(fields.Access_Level__c, accessLevel);
    assert.equal(fields.Hierarchy_Level__c, "Client");
    // The point of the test: the request ASKED for super admin and was allowed
    // through, but the field is Salesforce-set only (D-043) and must not be written.
    assert.ok(
      !("Super_Admin__c" in fields),
      `${accessLevel} — Super_Admin__c must never be written by this endpoint`
    );
    assert.equal(fields.Client__c, TENANT, "tenant is force-stamped from the token");
  }
});

test("POST with Admin and no superAdmin key is unaffected", async () => {
  ctx.queryRows = [[]];

  const res = await handler(postEvent(createBody({ accessLevel: "Admin" })));

  assert.equal(res.statusCode, 201);
  assert.equal(ctx.created[0].fields.Access_Level__c, "Admin");
  assert.equal(ctx.created[0].fields.Hierarchy_Level__c, "Client");
  assert.ok(!("Super_Admin__c" in ctx.created[0].fields));
});

test("POST with a sales role and NO superAdmin key still succeeds", async () => {
  // The refusal must key on the COMBINATION, not on the access level alone —
  // otherwise it would have quietly banned creating sales reps.
  //
  // D-064: a sales role also needs a dealer now. queryRows order is
  // [dealer validation, duplicate guard] — the dealer is resolved during validation,
  // before the duplicate check, so an invalid dealer is refused without a Supabase call.
  ctx.queryRows = [dealerRow(), []];

  const res = await handler(
    postEvent(createBody({ accessLevel: "Sales Rep", dealerId: DEALER_ID }))
  );

  assert.equal(res.statusCode, 201);
  assert.equal(ctx.created[0].fields.Access_Level__c, "Sales Rep");
  assert.equal(ctx.created[0].fields.Hierarchy_Level__c, "Sales Rep");
  assert.equal(ctx.created[0].fields.Dealer__c, DEALER_ID, "and the dealer is stamped");
});

// ===========================================================================
// (2) PATCH — the other door into the same combination
// ===========================================================================

test("PATCH re-levelling an EXISTING super admin down to a sales role is refused", async () => {
  for (const accessLevel of ["Sales Rep", "Sales Dealer"]) {
    resetCtx();
    ctx.queryRows = [ownedRow({ Super_Admin__c: true })];

    const res = await handler(patchEvent(TARGET_ID, { accessLevel }));

    assert.equal(res.statusCode, 400, accessLevel);
    const body = parse(res);
    assert.equal(body.code, "SUPER_ADMIN_WITH_SALES_ROLE", accessLevel);
    assert.equal(body.error, "invalid_role_combination", accessLevel);
    assert.match(body.message, new RegExp(accessLevel), accessLevel);
    assert.equal(
      ctx.updated.length,
      0,
      `${accessLevel} — refused BEFORE the Salesforce write, so the record is unchanged`
    );
  }
});

test("PATCH reads Super_Admin__c from the RECORD, not from the request", async () => {
  // A caller cannot assert their way past this: `superAdmin` is in DISALLOWED, so the
  // only source is the ownership query. Target is NOT a super admin in Salesforce, so
  // the same re-level that was refused above is allowed here.
  ctx.queryRows = [ownedRow({ Super_Admin__c: false }), dealerRow()];

  const res = await handler(
    patchEvent(TARGET_ID, { accessLevel: "Sales Rep", dealerId: DEALER_ID })
  );

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.updated.length, 1);
  assert.equal(ctx.updated[0].fields.Access_Level__c, "Sales Rep");

  // And the ownership query must actually select the field, or the check above reads
  // undefined on every record and silently never fires.
  assert.match(ctx.queries[0], /Super_Admin__c/);
});

test("PATCH of a super admin to a NON-sales role is allowed", async () => {
  // The refusal is about scope, not about super admins being immutable. Moving one
  // between tenant-wide levels is fine and must stay fine.
  for (const accessLevel of ["Executive", "Admin", "Manager", "Technician"]) {
    resetCtx();
    ctx.queryRows = [ownedRow({ Super_Admin__c: true })];

    const res = await handler(patchEvent(TARGET_ID, { accessLevel }));

    assert.equal(res.statusCode, 200, accessLevel);
    assert.equal(ctx.updated[0].fields.Access_Level__c, accessLevel, accessLevel);
    assert.equal(ctx.updated[0].fields.Hierarchy_Level__c, "Client", accessLevel);
  }
});

test("PATCH of a super admin that does NOT touch accessLevel is allowed", async () => {
  // Renaming a super admin, or deactivating one, has nothing to do with scope.
  ctx.queryRows = [ownedRow({ Super_Admin__c: true })];

  const res = await handler(patchEvent(TARGET_ID, { firstName: "Renamed" }));

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.updated[0].fields.First_Name__c, "Renamed");
});

// ===========================================================================
// The auth gate still stands in front of all of it
// ===========================================================================

test("a non-super-admin caller is refused before any of the above runs", async () => {
  for (const event of [postEvent(createBody()), patchEvent(TARGET_ID, { accessLevel: "Manager" })]) {
    resetCtx();
    ctx.identity = { tenantId: TENANT, user: { id: CALLER_ID, superAdmin: false } };

    const res = await handler(event);

    assert.equal(res.statusCode, 403);
    assert.equal(parse(res).code, "NOT_SUPER_ADMIN");
    assert.equal(ctx.created.length + ctx.updated.length, 0);
  }
});

// ===========================================================================
// (d) D-064 — the dealer, on both doors
// ===========================================================================
// A sales user with no dealer, or an inactive one, resolves to scope `none`
// (access-model.md §1.2, §2.1). Provisioning one is not a validation slip: it creates
// an account that authenticates successfully and then sees nothing, and whose problem
// is invisible from the admin screen that created it.

test("CREATE: a sales role with NO dealer is refused", async () => {
  for (const accessLevel of ["Sales Rep", "Sales Dealer"]) {
    resetCtx();
    ctx.queryRows = [[]];
    const res = await handler(postEvent(createBody({ accessLevel })));
    assert.equal(res.statusCode, 400, accessLevel);
    assert.equal(parse(res).code, "DEALER_REQUIRED_FOR_SALES_ROLE", accessLevel);
    assert.equal(ctx.created.length, 0, "nothing is written");
    assert.equal(ctx.authCalls.length, 0, "and no Supabase auth user is created");
  }
});

test("CREATE: an INACTIVE dealer is refused", async () => {
  // §2.1 makes deactivating a dealer the switch that turns off their people. A rep
  // provisioned into one would sign in and see nothing.
  ctx.queryRows = [dealerRow({ Active__c: false })];
  const res = await handler(
    postEvent(createBody({ accessLevel: "Sales Rep", dealerId: DEALER_ID }))
  );
  assert.equal(res.statusCode, 400);
  assert.equal(parse(res).code, "DEALER_NOT_FOUND");
  assert.match(parse(res).message, /INACTIVE/);
  assert.equal(ctx.created.length, 0);
});

test("CREATE: an unknown or cross-tenant dealer is refused, indistinguishably", async () => {
  // Unknown, wrong tenant and inactive all answer the same. A distinct "exists but is
  // not yours" would confirm another tenant's record ids to anyone willing to guess.
  ctx.queryRows = [[]];
  const res = await handler(
    postEvent(createBody({ accessLevel: "Sales Rep", dealerId: "a1X000000000BOGUS" }))
  );
  assert.equal(res.statusCode, 400);
  assert.equal(parse(res).code, "DEALER_NOT_FOUND");
});

test("CREATE: the dealer lookup is TENANT-SCOPED", async () => {
  ctx.queryRows = [dealerRow(), []];
  await handler(postEvent(createBody({ accessLevel: "Sales Rep", dealerId: DEALER_ID })));
  const lookup = ctx.queries.find((q) => /FROM Sundial_Dealer__c/.test(q));
  assert.ok(lookup, "the dealer was validated against Salesforce");
  assert.match(lookup, new RegExp(`Client__c = '${TENANT}'`));
  assert.match(lookup, new RegExp(`Id = '${DEALER_ID}'`));
});

test("CREATE: a dealerId on a TENANT-WIDE level is a 400, not a silent drop", async () => {
  // Silently ignoring it would leave the admin believing an Executive had been
  // attributed to a dealer, with nothing in the UI to contradict them.
  const res = await handler(
    postEvent(createBody({ accessLevel: "Executive", dealerId: DEALER_ID }))
  );
  assert.equal(res.statusCode, 400);
  assert.equal(parse(res).code, "DEALER_NOT_APPLICABLE");
  assert.equal(ctx.created.length, 0);
});

test("PATCH: moving to a sales role with NO dealer, on a user who has none, is refused", async () => {
  // THE CARRIED-FORWARD RULE. This body mentions neither dealers nor visibility, and
  // would silently create an account that can sign in and see nothing.
  ctx.queryRows = [ownedRow({ Access_Level__c: "Manager", Dealer__c: null })];
  const res = await handler(patchEvent(TARGET_ID, { accessLevel: "Sales Rep" }));
  assert.equal(res.statusCode, 400);
  assert.equal(parse(res).code, "DEALER_REQUIRED_FOR_SALES_ROLE");
  assert.equal(ctx.updated.length, 0);
});

test("PATCH: moving to a sales role is ALLOWED when the record already has a dealer", async () => {
  // The rule is about where the user ENDS UP, not about what the body happens to say.
  ctx.queryRows = [ownedRow({ Access_Level__c: "Manager", Dealer__c: DEALER_ID })];
  const res = await handler(patchEvent(TARGET_ID, { accessLevel: "Sales Rep" }));
  assert.equal(res.statusCode, 200);
  assert.equal(ctx.updated[0].fields.Access_Level__c, "Sales Rep");
});

test("PATCH: clearing the dealer of someone who STAYS a sales rep is refused", async () => {
  ctx.queryRows = [ownedRow({ Access_Level__c: "Sales Rep", Dealer__c: DEALER_ID })];
  const res = await handler(patchEvent(TARGET_ID, { dealerId: "" }));
  assert.equal(res.statusCode, 400);
  assert.equal(parse(res).code, "DEALER_REQUIRED_FOR_SALES_ROLE");
  assert.equal(ctx.updated.length, 0);
});

test("PATCH: changing the dealer of a rep validates the new one", async () => {
  ctx.queryRows = [
    ownedRow({ Access_Level__c: "Sales Rep", Dealer__c: "a1X000000000OLDAA" }),
    dealerRow({ Active__c: false }),
  ];
  const res = await handler(patchEvent(TARGET_ID, { dealerId: DEALER_ID }));
  assert.equal(res.statusCode, 400, "an inactive target dealer is refused on PATCH too");
  assert.equal(parse(res).code, "DEALER_NOT_FOUND");
  assert.equal(ctx.updated.length, 0);
});

test("PATCH: a valid dealer change is written", async () => {
  ctx.queryRows = [
    ownedRow({ Access_Level__c: "Sales Rep", Dealer__c: "a1X000000000OLDAA" }),
    dealerRow(),
  ];
  const res = await handler(patchEvent(TARGET_ID, { dealerId: DEALER_ID }));
  assert.equal(res.statusCode, 200);
  assert.equal(ctx.updated[0].fields.Dealer__c, DEALER_ID);
});

test("PATCH: a dealerId on a user who ends up TENANT-WIDE is refused", async () => {
  ctx.queryRows = [ownedRow({ Access_Level__c: "Sales Rep", Dealer__c: DEALER_ID })];
  const res = await handler(
    patchEvent(TARGET_ID, { accessLevel: "Manager", dealerId: DEALER_ID })
  );
  assert.equal(res.statusCode, 400);
  assert.equal(parse(res).code, "DEALER_NOT_APPLICABLE");
});

test("PATCH: moving OUT of a sales role leaves Dealer__c alone", async () => {
  // Unread for tenant scopes (§1.2), so clearing it would change nothing about access
  // while discarding the attribution — and would silently un-attribute someone who is
  // later moved back into a sales role.
  ctx.queryRows = [ownedRow({ Access_Level__c: "Sales Rep", Dealer__c: DEALER_ID })];
  const res = await handler(patchEvent(TARGET_ID, { accessLevel: "Manager" }));
  assert.equal(res.statusCode, 200);
  assert.ok(!("Dealer__c" in ctx.updated[0].fields), "not touched");
});

test("the SUPER-ADMIN refusal wins over the dealer refusal", async () => {
  // Both apply to this request. The combination is the more consequential problem and
  // its message tells the admin what to actually do (clear Super_Admin__c first); a
  // DEALER_REQUIRED answer would send them to pick a dealer for a change that must not
  // happen at all.
  ctx.queryRows = [ownedRow({ Super_Admin__c: true, Access_Level__c: "Admin", Dealer__c: null })];
  const res = await handler(patchEvent(TARGET_ID, { accessLevel: "Sales Rep" }));
  assert.equal(res.statusCode, 400);
  assert.equal(parse(res).code, "SUPER_ADMIN_WITH_SALES_ROLE");
});

test("GET returns dealerId and dealerName, plus the dealer options", async () => {
  ctx.queryRows = [
    [
      {
        Id: TARGET_ID,
        First_Name__c: "ZZ",
        Last_Name__c: "Rep",
        Email__c: "zz@example.com",
        Access_Level__c: "Sales Rep",
        Active__c: true,
        Super_Admin__c: false,
        Dealer__c: DEALER_ID,
        Dealer__r: { Name: DEALER_NAME },
      },
    ],
    [{ Id: DEALER_ID, Name: DEALER_NAME }],
  ];
  const res = await handler({
    requestContext: { http: { method: "GET" } },
    headers: { authorization: "Bearer test", origin: "http://localhost:5173" },
    rawPath: "/admin/users",
  });
  const body = parse(res);
  assert.equal(body.users[0].dealerId, DEALER_ID);
  assert.equal(body.users[0].dealerName, DEALER_NAME);
  assert.deepEqual(body.dealers, [{ id: DEALER_ID, name: DEALER_NAME }]);
});

test("GET /admin/dealers returns ACTIVE dealers only, tenant-scoped", async () => {
  ctx.queryRows = [[{ Id: DEALER_ID, Name: DEALER_NAME }]];
  const res = await handler({
    requestContext: { http: { method: "GET" } },
    headers: { authorization: "Bearer test", origin: "http://localhost:5173" },
    rawPath: "/admin/dealers",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parse(res).dealers, [{ id: DEALER_ID, name: DEALER_NAME }]);
  const q = ctx.queries[0];
  assert.match(q, /Active__c = true/);
  assert.match(q, new RegExp(`Client__c = '${TENANT}'`));
  assert.ok(!/Sundial_User__c/.test(q), "the dealers route must not query users");
});
