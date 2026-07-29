// Verify the temporary-password provisioning flow end to end, against the REAL
// Supabase project the portal uses — no email required. Mirrors exactly what the
// backend create + the browser login + the ChangePasswordModal do.
//
// Run: node scripts/verify-provisioning.mjs
import { getSupabaseClient, getSupabaseConfig } from '../lib/supabase.js';

const admin = await getSupabaseClient();
const cfg = await getSupabaseConfig();
const apikey = cfg.anonKey || cfg.serviceRoleKey; // token endpoint accepts either project key
const email = `tim+provverify@constructiveoperations.com`;
const tempPw = 'TempPass123!';
const newPw = 'BrandNewPass456!';
const ok = (b) => (b ? 'PASS ✓' : 'FAIL ✗');

const login = async (password) => {
  const r = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: r.status, body: await r.json() };
};

// clean any prior run
const { data: l } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
const prior = (l.users || []).find((u) => (u.email || '').toLowerCase() === email);
if (prior) await admin.auth.admin.deleteUser(prior.id);

// 1. Create exactly like the Lambda password path.
const { data: c, error: cErr } = await admin.auth.admin.createUser({
  email, password: tempPw, email_confirm: true, user_metadata: { must_change_password: true },
});
console.log(`1. create user: ${ok(!cErr && c?.user?.id)} ${cErr ? cErr.message : ''}`);

// 2. Log in with the TEMP password via the anon token endpoint (what the browser does).
const first = await login(tempPw);
console.log(`2. login with temp password: ${ok(first.status === 200 && first.body.access_token)} (HTTP ${first.status})`);

// 3. The app's force-change gate: must_change_password === true on the signed-in user.
const gate = first.body?.user?.user_metadata?.must_change_password === true;
console.log(`3. force-change gate would fire (must_change_password=true): ${ok(gate)}`);

// 4. Perform the EXACT call ChangePasswordModal makes (updateUser: new password + clear flag),
//    using the just-established session's access token.
const upd = await fetch(`${cfg.url}/auth/v1/user`, {
  method: 'PUT',
  headers: { apikey, Authorization: `Bearer ${first.body.access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: newPw, data: { must_change_password: false } }),
});
console.log(`4. set new password + clear flag: ${ok(upd.status === 200)} (HTTP ${upd.status})`);

// 5. Re-login with the NEW password; flag must now be cleared.
const second = await login(newPw);
const cleared = second.body?.user?.user_metadata?.must_change_password === false;
console.log(`5. re-login with new password: ${ok(second.status === 200)} (HTTP ${second.status})`);
console.log(`6. flag cleared (no more forced change): ${ok(cleared)}`);
console.log(`7. old temp password now rejected: ${ok((await login(tempPw)).status !== 200)}`);

// cleanup
await admin.auth.admin.deleteUser(c.user.id);
console.log('(cleaned up test user)');
