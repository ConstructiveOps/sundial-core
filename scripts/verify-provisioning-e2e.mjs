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
//   5. force-change: set new password + clear must_change_password flag
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

const login = async (password) => {
  const r = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password }),
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
    const created = await sfCreateRecord('Sundial_User__c', {
      First_Name__c: 'E2E', Last_Name__c: 'Verify', Email__c: EMAIL,
      Access_Level__c: 'Sales Rep', Hierarchy_Level__c: 'Sales Rep',
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
    const upd = await fetch(`${cfg.url}/auth/v1/user`, {
      method: 'PUT',
      headers: { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: NEW_PW, data: { must_change_password: false } }),
    });
    check('set new password + clear must_change_password', upd.status === 200, `HTTP ${upd.status}`);
  }

  // 6. re-login with new password; flag cleared; old temp rejected.
  const second = await login(NEW_PW);
  check('re-login with new password', second.status === 200, `HTTP ${second.status}`);
  check('must_change_password cleared',
    second.body?.user?.user_metadata?.must_change_password === false);
  const oldTry = await login(TEMP_PW);
  check('old temp password now rejected', oldTry.status !== 200, `HTTP ${oldTry.status}`);
} finally {
  // 7. cleanup.
  if (authUserId) await admin.auth.admin.deleteUser(authUserId).catch(() => {});
  if (sfUserId) await sfDeleteRecord('Sundial_User__c', sfUserId).catch(() => {});
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED ✓' : `${failures} CHECK(S) FAILED ✗`}`);
  process.exit(failures === 0 ? 0 : 1);
}
