// END-TO-END provisioning verification against the REAL Supabase + API Gateway.
// Proves the WHOLE chain a provisioned user depends on — including tenant binding —
// without needing email:
//
//   1. create auth user + Sundial_User__c (Client__c = harmon), exactly like the
//      user-admin Lambda's password path
//   2. log in with the temp password (what the browser does)
//   3. GET /auth/me -> tenant.clientId resolves to harmon      [tenant binding #1]
//   4. GET /sf/customer -> 200 + records load                  [tenant binding #2:
//      proves sf-query resolves the tenant and returns the Sales list]
//   5. force-change: set new password (with current_password — the project runs
//      Supabase secure password change) + clear must_change_password flag, and
//      assert the same call WITHOUT current_password is rejected
//   6. re-login with the new password; flag cleared; old temp password rejected
//   7. clean up (delete the auth user + the Sundial_User__c)
//
// Run:  node scripts/verify-provisioning-e2e.mjs
// The test user is created and deleted within this run; nothing is left behind.

import { getSupabaseClient, getSupabaseConfig } from '../lib/supabase.js';
import { sfQuery, soqlEscapeString, sfCreateRecord, sfUpdateRecord, sfDeleteRecord } from '../lib/salesforce.js';

const API_BASE = (process.env.API_BASE_URL
  || 'https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod').replace(/\/+$/, '');
const EMAIL = process.env.TEST_EMAIL || 'tim+e2everify@constructiveoperations.com';
const TEMP_PW = 'TempPass123!';
const NEW_PW = 'BrandNewPass456!';

const ok = (b) => (b ? 'PASS ✓' : 'FAIL ✗');
let failures = 0;
const check = (label, pass, extra = '') => {
  if (!pass) failures++;
  console.log(`  ${ok(pass)}  ${label}${extra ? `  (${extra})` : ''}`);
};

const admin = await getSupabaseClient();
const cfg = await getSupabaseConfig();
const apikey = cfg.anonKey || cfg.serviceRoleKey;

// `email` defaults to the throwaway e2e user so every existing caller is unchanged;
// the derived-hierarchy step passes the ZZ super admin's address explicitly.
const login = async (password, email = EMAIL) => {
  const r = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: r.status, body: await r.json() };
};
const apiGet = async (path, token) => {
  const r = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, body };
};

// Resolve the harmon tenant id (don't hardcode).
const tenants = await sfQuery(`SELECT Id, Name FROM Sundial_Tenant__c WHERE Name = 'harmon' LIMIT 1`);
const HARMON = tenants?.[0]?.Id;
if (!HARMON) { console.error('Could not resolve harmon tenant id; aborting.'); process.exit(1); }
console.log(`Harmon tenant id: ${HARMON}\nAPI base: ${API_BASE}\n`);

// --- clean any prior run (auth user + SF record) ---------------------------
const { data: l0 } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
const prior = (l0.users || []).find((u) => (u.email || '').toLowerCase() === EMAIL.toLowerCase());
if (prior) await admin.auth.admin.deleteUser(prior.id);
const priorSf = await sfQuery(`SELECT Id FROM Sundial_User__c WHERE Email__c = '${soqlEscapeString(EMAIL)}'`);
// (leave SF cleanup to the end; we recreate below)

const ZZ_ADMIN_EMAIL = 'tim+zz-admin@constructiveoperations.com';

// The three mappings sundial-user-admin must produce. Kept short deliberately: the
// exhaustive cases live in lambdas/sundial-user-admin/test.js as pure unit tests.
// What THIS proves is different and cannot be unit-tested -- that the value survives
// the round trip through the real endpoint into a real Salesforce record, against a
// RESTRICTED picklist that would reject an invalid one.
// D-064: the two SALES cases need a dealer, because a sales role without one is now
// refused outright -- it would create an account that signs in and sees nothing.
const DERIVATION_CASES = [
  { accessLevel: 'Sales Dealer', expect: 'Sales Manager', needsDealer: true },
  { accessLevel: 'Sales Rep', expect: 'Sales Rep', needsDealer: true },
  // Admin and Manager both collapse to `Client` -- the point of asserting BOTH is that
  // neither may come back as the literal "Sales Rep" the TEMP guard in sundial-sf-query
  // keys on. That string on a non-rep is exactly the bug this endpoint change fixes.
  { accessLevel: 'Admin', expect: 'Client' },
  { accessLevel: 'Manager', expect: 'Client' },
];

async function verifyDerivedHierarchy() {
  const { getSecret } = await import('../lib/secrets.js');
  const passwords = await getSecret('sundial/test-users').catch(() => null);
  if (!passwords?.[ZZ_ADMIN_EMAIL]) {
    console.log(`
  SKIP derived-hierarchy checks: no password for ${ZZ_ADMIN_EMAIL}.`);
    console.log(`       Run: node scripts/seed-access-test-fixtures.mjs --apply`);
    return;
  }

  const adminLogin = await login(passwords[ZZ_ADMIN_EMAIL], ZZ_ADMIN_EMAIL);
  const adminToken = adminLogin.body?.access_token;
  if (!adminToken) {
    console.log(`
  SKIP derived-hierarchy checks: could not log in as ${ZZ_ADMIN_EMAIL} ` +
      `(HTTP ${adminLogin.status}).`);
    return;
  }

  // Probe whether the token actually carries Super_Admin__c before asserting.
  const probe = await fetch(`${API_BASE}/admin/users`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (probe.status === 403) {
    console.log(`
  SKIP derived-hierarchy checks: ${ZZ_ADMIN_EMAIL} is not a Super Admin yet.`);
    console.log(`       Tick Super_Admin__c on that Sundial_User__c in Salesforce (D-043:`);
    console.log(`       Salesforce-set only, never writable through an endpoint), then re-run.`);
    return;
  }
  if (probe.status !== 200) {
    check('GET /admin/users as the ZZ super admin', false, `HTTP ${probe.status}`);
    return;
  }

  // The ZZ dealer the sales cases are provisioned into. Resolved by NAME from
  // Salesforce rather than hardcoded by id, so a re-seeded fixture does not silently
  // turn these into DEALER_NOT_FOUND failures.
  const dealerRows = await sfQuery(
    `SELECT Id, Name, Active__c FROM Sundial_Dealer__c ` +
    `WHERE Client__c = '${soqlEscapeString(HARMON)}' AND Name = 'ZZ TEST DEALER A' LIMIT 1`
  );
  const dealerAId = dealerRows?.[0]?.Id ?? null;
  const dealerAActive = dealerRows?.[0]?.Active__c === true;
  check('ZZ TEST DEALER A exists and is ACTIVE', !!dealerAId && dealerAActive,
    dealerAId ? `active=${dealerAActive}` : 'not found -- run seed-access-test-fixtures.mjs');

  for (const c of DERIVATION_CASES) {
    const email = `tim+zz-derive-${c.accessLevel.toLowerCase().replace(/\s+/g, '-')}@constructiveoperations.com`;
    let createdId = null;
    try {
      const res = await fetch(`${API_BASE}/admin/users`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email, firstName: 'ZZ Derive', lastName: c.accessLevel,
          accessLevel: c.accessLevel, credentialMode: 'password',
          tempPassword: 'TempDerive123!',
          ...(c.needsDealer && dealerAId ? { dealerId: dealerAId } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      createdId = body?.id ?? null;
      if (res.status !== 201 || !createdId) {
        check(`POST /admin/users (${c.accessLevel})`, false, `HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
        continue;
      }
      // Read the field back from Salesforce. The endpoint does not return it, and
      // asserting on the response would only test the response.
      const rows = await sfQuery(
        `SELECT Id, Access_Level__c, Hierarchy_Level__c FROM Sundial_User__c ` +
        `WHERE Id = '${soqlEscapeString(createdId)}' LIMIT 1`
      );
      const got = rows?.[0]?.Hierarchy_Level__c;
      check(`${c.accessLevel} -> Hierarchy_Level__c "${c.expect}"`, got === c.expect, `got "${got}"`);
    } finally {
      // Clean up both sides regardless of outcome; a leftover ZZ user would show up
      // in the next audit run as a real user.
      if (createdId) await sfDeleteRecord('Sundial_User__c', createdId).catch(() => {});
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const found = list?.users?.find((x) => x.email?.toLowerCase() === email);
      if (found) await admin.auth.admin.deleteUser(found.id).catch(() => {});
    }
  }

  // The refusal added in the same change: a super admin cannot also be a sales role.
  const refusal = await fetch(`${API_BASE}/admin/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'tim+zz-derive-refuse@constructiveoperations.com',
      firstName: 'ZZ', lastName: 'Refuse', accessLevel: 'Sales Rep',
      credentialMode: 'password', tempPassword: 'TempDerive123!', superAdmin: true,
    }),
  });
  const rBody = await refusal.json().catch(() => ({}));
  check('super admin + sales role is refused',
    refusal.status === 400 && rBody?.code === 'SUPER_ADMIN_WITH_SALES_ROLE',
    `HTTP ${refusal.status} ${rBody?.code || ''}`);

  await verifyDealerProvisioning(adminToken, dealerAId);
}

// ---------------------------------------------------------------------------
// D-064 — dealer provisioning, end to end through the LIVE endpoint
// ---------------------------------------------------------------------------
// The unit tests pin the rules against mocks. This pins the thing they cannot: that a
// rep created through the real API actually ends up with Dealer__c set AND that the
// resulting login resolves to `own` scope on /auth/me. Those are two different systems
// agreeing -- user-admin writes the field, identity.js reads it back through
// Dealer__r.Active__c and turns it into a scope. A test of either alone would pass
// while the pair was broken.
async function verifyDealerProvisioning(adminToken, dealerAId) {
  if (!dealerAId) {
    console.log('\n  SKIP dealer provisioning: ZZ TEST DEALER A not found.');
    return;
  }
  const email = 'tim+zz-dealer-e2e@constructiveoperations.com';
  const pw = 'TempDealer123!';
  let createdId = null;

  const post = (body) =>
    fetch(`${API_BASE}/admin/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const base = {
    email, firstName: 'ZZ Dealer', lastName: 'E2E',
    accessLevel: 'Sales Rep', credentialMode: 'password', tempPassword: pw,
  };

  try {
    // 1. No dealer -> refused. Asserted FIRST so a later success cannot be mistaken
    //    for the rule being absent.
    const noDealer = await post(base);
    const nBody = await noDealer.json().catch(() => ({}));
    check('POST rep with NO dealer -> 400 DEALER_REQUIRED_FOR_SALES_ROLE',
      noDealer.status === 400 && nBody?.code === 'DEALER_REQUIRED_FOR_SALES_ROLE',
      `HTTP ${noDealer.status} ${nBody?.code || ''}`);

    // 2. A dealer that is not a dealer in this tenant -> refused.
    const bogus = await post({ ...base, dealerId: 'a1X000000000BOGUS' });
    const bBody = await bogus.json().catch(() => ({}));
    check('POST rep with an unknown dealer -> 400 DEALER_NOT_FOUND',
      bogus.status === 400 && bBody?.code === 'DEALER_NOT_FOUND',
      `HTTP ${bogus.status} ${bBody?.code || ''}`);

    // 3. The real thing.
    const res = await post({ ...base, dealerId: dealerAId });
    const body = await res.json().catch(() => ({}));
    createdId = body?.id ?? null;
    check('POST rep under ZZ TEST DEALER A -> 201', res.status === 201 && !!createdId,
      `HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
    if (!createdId) return;
    check('the response echoes the dealer', body?.dealerId === dealerAId,
      `${body?.dealerId} / ${body?.dealerName}`);

    // 4. Read Dealer__c back FROM SALESFORCE. Asserting on the response would only
    //    test the response.
    const rows = await sfQuery(
      `SELECT Id, Access_Level__c, Dealer__c, Dealer__r.Name FROM Sundial_User__c ` +
      `WHERE Id = '${soqlEscapeString(createdId)}' LIMIT 1`
    );
    check('Dealer__c is written to Salesforce', rows?.[0]?.Dealer__c === dealerAId,
      `got ${rows?.[0]?.Dealer__c} (${rows?.[0]?.Dealer__r?.Name})`);

    // 5. THE PAIR: log in as the new rep and read the scope /auth/me resolves. This is
    //    what makes the field mean something -- Dealer__c set but scope `none` would be
    //    a user who looks provisioned and cannot work.
    const repLogin = await login(pw, email);
    const repToken = repLogin.body?.access_token;
    check('the new rep can sign in', repLogin.status === 200 && !!repToken,
      `HTTP ${repLogin.status}`);
    if (repToken) {
      const me = await apiGet('/auth/me', repToken);
      const access = me.body?.user?.access;
      check('/auth/me resolves scope "own"', access?.scope === 'own',
        `scope=${access?.scope} level=${access?.level}`);
      check('/auth/me carries the dealer', access?.dealerId === dealerAId,
        `dealerId=${access?.dealerId}`);
      check('/auth/me reports the dealer ACTIVE', access?.dealerActive === true,
        `dealerActive=${access?.dealerActive}`);
      check('modules are the sales set (customer, solar, user)',
        JSON.stringify(access?.modules) === JSON.stringify(['customer', 'solar', 'user']),
        JSON.stringify(access?.modules));
    }

    // 6. PATCH the rep to a tenant-wide role WITH a dealerId -> refused.
    const patchBad = await fetch(`${API_BASE}/admin/users/${createdId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessLevel: 'Manager', dealerId: dealerAId }),
    });
    const pBody = await patchBad.json().catch(() => ({}));
    check('PATCH to a tenant role WITH a dealer -> 400 DEALER_NOT_APPLICABLE',
      patchBad.status === 400 && pBody?.code === 'DEALER_NOT_APPLICABLE',
      `HTTP ${patchBad.status} ${pBody?.code || ''}`);
  } finally {
    // Clean up BOTH sides. A leftover tim+zz- user shows up in the next audit as real.
    if (createdId) await sfDeleteRecord('Sundial_User__c', createdId).catch(() => {});
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const found = list?.users?.find((x) => x.email?.toLowerCase() === email);
    if (found) await admin.auth.admin.deleteUser(found.id).catch(() => {});
  }
}

// The ten users scripts/seed-access-test-fixtures.mjs owns. Anything else answering to
// `tim+zz-` was created by THIS run and must not outlive it.
const SEEDED_ZZ = [
  'rep-a1', 'rep-a2', 'mgr-a', 'rep-b1', 'rep-harmon', 'rep-nodealer',
  'rep-inactive-dealer', 'tech', 'admin', 'exec',
].map((slug) => `tim+zz-${slug}@constructiveoperations.com`);

// A leftover ZZ user is not cosmetic. The next `verify-access-matrix` run enumerates
// every ZZ account and would test an eleventh one nobody defined a expectation for,
// and `audit-user-levels` would count it as a real user. Sweep, THEN assert -- the
// assertion is on what remains after the sweep, so a per-case cleanup that silently
// failed still shows up as a failure here rather than as a surprise next week.
async function verifyNoLeftoverZzUsers() {
  const sfRows = await sfQuery(
    `SELECT Id, Email__c, Active__c FROM Sundial_User__c WHERE Email__c LIKE 'tim+zz-%'`
  );
  const straySf = (sfRows || []).filter(
    (r) => !SEEDED_ZZ.includes((r.Email__c || '').toLowerCase())
  );
  for (const r of straySf) await sfDeleteRecord('Sundial_User__c', r.Id).catch(() => {});

  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const strayAuth = (list?.users || []).filter((u) => {
    const e = (u.email || '').toLowerCase();
    return e.startsWith('tim+zz-') && !SEEDED_ZZ.includes(e);
  });
  for (const u of strayAuth) await admin.auth.admin.deleteUser(u.id).catch(() => {});

  const after = await sfQuery(
    `SELECT Id, Email__c FROM Sundial_User__c WHERE Email__c LIKE 'tim+zz-%'`
  );
  const remaining = (after || []).map((r) => (r.Email__c || '').toLowerCase()).sort();
  const expected = [...SEEDED_ZZ].sort();
  check('only the ten seeded ZZ TEST users remain (Sundial_User__c)',
    remaining.length === 10 && remaining.every((e, i) => e === expected[i]),
    `${remaining.length} found` +
      (straySf.length ? `, swept ${straySf.length} stray SF` : '') +
      (strayAuth.length ? `, swept ${strayAuth.length} stray auth` : ''));
}

let authUserId = null;
let sfUserId = priorSf?.[0]?.Id || null;
try {
  // 1. create — mirror the Lambda password path.
  const { data: c, error: cErr } = await admin.auth.admin.createUser({
    email: EMAIL, password: TEMP_PW, email_confirm: true,
    user_metadata: { must_change_password: true },
  });
  authUserId = c?.user?.id ?? null;
  check('create auth user', !cErr && !!authUserId, cErr?.message);

  if (!sfUserId && authUserId) {
    // D-064: this throwaway user is a MANAGER, not a Sales Rep, and the change is
    // deliberate. It was created as a dealerless "Sales Rep", which under the access
    // model resolves to scope `none` -- so the two checks below ("the Sales list
    // loads", "the list is tenant-scoped and non-empty") started failing with 403 and
    // total=0. Both were CORRECT refusals, but they broke what this block is actually
    // for: proving that provisioning -> login -> /auth/me -> a tenant-scoped read works
    // end to end. A tenant-wide level keeps that assertion meaningful.
    //
    // The sales-scope path is not lost -- verifyDealerProvisioning() below covers it
    // properly, with a real dealer and an assertion on the resolved scope.
    const created = await sfCreateRecord('Sundial_User__c', {
      First_Name__c: 'E2E', Last_Name__c: 'Verify', Email__c: EMAIL,
      Access_Level__c: 'Manager', Hierarchy_Level__c: 'Client',
      Active__c: true, Supabase_User_Id__c: authUserId, Client__c: HARMON,
    });
    sfUserId = created.id;
  } else if (sfUserId && authUserId) {
    // reuse leftover SF record: relink + ensure tenant/active
    await sfUpdateRecord('Sundial_User__c', sfUserId, {
      Supabase_User_Id__c: authUserId, Client__c: HARMON, Active__c: true,
    });
  }
  check('create Sundial_User__c bound to harmon', !!sfUserId);

  // 2. login with temp password.
  const first = await login(TEMP_PW);
  const token = first.body?.access_token;
  check('login with temp password', first.status === 200 && !!token, `HTTP ${first.status}`);

  // 3. /auth/me -> tenant resolves to harmon.
  if (token) {
    const me = await apiGet('/auth/me', token);
    check('/auth/me returns 200', me.status === 200, `HTTP ${me.status}`);
    check('/auth/me tenant.clientId == harmon', me.body?.tenant?.clientId === HARMON,
      `got ${me.body?.tenant?.clientId}`);

    // 4. sf-query customer list -> proves tenant scope + Sales list loads.
    const sales = await apiGet('/sf/customer?limit=1&offset=0', token);
    const total = sales.body?.total ?? (Array.isArray(sales.body?.records) ? sales.body.records.length : 0);
    check('GET /sf/customer returns 200 (Sales list loads)', sales.status === 200, `HTTP ${sales.status}`);
    check('Sales list is tenant-scoped & non-empty', (total ?? 0) > 0, `total=${total}`);

    // 5. force-change: new password + clear flag (what ChangePasswordModal does).
    // current_password is REQUIRED: the project runs Supabase's secure password
    // change (GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD), so a
    // password-session update without it is rejected 400 current_password_required.
    // Recovery-token sessions (invite / reset links) are exempt — that path is
    // covered by the manual checks in docs/integrations/auth-email-ses.md.
    const upd = await fetch(`${cfg.url}/auth/v1/user`, {
      method: 'PUT',
      headers: { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: NEW_PW,
        current_password: TEMP_PW,
        data: { must_change_password: false },
      }),
    });
    check('set new password + clear must_change_password', upd.status === 200,
      `HTTP ${upd.status}${upd.status !== 200 ? ` ${await upd.clone().text()}` : ''}`);

    // Guard the security control itself: omitting current_password must FAIL.
    // If this ever passes, secure password change has been switched off and the
    // modal's current-password field has quietly become decorative.
    const noCurrent = await fetch(`${cfg.url}/auth/v1/user`, {
      method: 'PUT',
      headers: { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'SomeOtherPass789!' }),
    });
    check('password change WITHOUT current_password is rejected', noCurrent.status === 400,
      `HTTP ${noCurrent.status}`);
  }

  // 6. re-login with new password; flag cleared; old temp rejected.
  const second = await login(NEW_PW);
  check('re-login with new password', second.status === 200, `HTTP ${second.status}`);
  check('must_change_password cleared',
    second.body?.user?.user_metadata?.must_change_password === false);
  const oldTry = await login(TEMP_PW);
  check('old temp password now rejected', oldTry.status !== 200, `HTTP ${oldTry.status}`);

  // 8. Hierarchy_Level__c is DERIVED by the real endpoint (Phase 0 deliverable C').
  //
  // Steps 1-7 create the Sundial_User__c DIRECTLY, so they prove nothing about
  // sundial-user-admin's own behaviour -- they set both fields themselves. The
  // derivation only exists inside POST /admin/users, so the only way to assert it
  // is to call that endpoint, which needs a Super_Admin__c bearer token.
  //
  // That token comes from the ZZ TEST super admin, never from a real person's
  // account: logging in as a live super admin to test provisioning is the thing
  // CLAUDE.md's test-user rule forbids. Super_Admin__c is Salesforce-set only
  // (D-043), so the checkbox is ticked by hand once; until then this SKIPS rather
  // than failing, because an un-ticked box is a setup step, not a regression.
  await verifyDerivedHierarchy();
  await verifyNoLeftoverZzUsers();
} finally {
  // 7. cleanup.
  if (authUserId) await admin.auth.admin.deleteUser(authUserId).catch(() => {});
  if (sfUserId) await sfDeleteRecord('Sundial_User__c', sfUserId).catch(() => {});
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED ✓' : `${failures} CHECK(S) FAILED ✗`}`);
  process.exit(failures === 0 ? 0 : 1);
}
