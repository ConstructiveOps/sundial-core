// Recovery for the provisioning incident. Supersedes recover-provisioned-users.mjs
// (which hard-coded a name list). This one DISCOVERS state by joining the harmon
// Sundial_User__c set to the Supabase auth users and classifies each:
//
//   OK              signed in at least once, has SF + auth, bound to harmon
//   NEVER_ONBOARDED active SF + auth, but never signed in  -> needs a credential
//   ORPHAN_AUTH     auth user exists, NO Sundial_User__c    -> can log in, loads nothing
//   ORPHAN_SF       Sundial_User__c exists, NO matching auth -> can't log in
//   INACTIVE        Active__c = false (deactivated; left alone)
//   NO_TENANT       Sundial_User__c with blank Client__c (would 403 on Sales)
//
// Fix-in-place (no email dependency — proven by verify-provisioning-e2e.mjs):
//   APPLY=1 OUT=<path>   -> for NEVER_ONBOARDED: set a fresh temp password +
//                           must_change_password=true, ensure not banned. Temp
//                           passwords are written ONLY to OUT (never stdout/logs);
//                           distribute securely. Users are forced to change on login.
//   DELETE_ORPHANS=1     -> delete ORPHAN_AUTH users (e.g. the troyjohnson typo dup).
//                           Destructive; off by default. Review the dry run first.
//
// Dry run (default) changes nothing:  node scripts/recover-provisioning.mjs
//
// NOTE: once SES custom SMTP is live (docs/integrations/auth-email-ses.md), you can
// alternatively re-invite / send resets so users self-serve. Fix-in-place is the
// safe path that works regardless of email state.

import { getSupabaseClient } from '../lib/supabase.js';
import { sfQuery } from '../lib/salesforce.js';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const apply = process.env.APPLY === '1';
const deleteOrphans = process.env.DELETE_ORPHANS === '1';
const out = process.env.OUT;
const genPw = () =>
  randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) + 'A9!';

const admin = await getSupabaseClient();

// harmon tenant id.
const tRows = await sfQuery(`SELECT Id FROM Sundial_Tenant__c WHERE Name = 'harmon' LIMIT 1`);
const HARMON = tRows?.[0]?.Id;

// All portal users for harmon (+ any with blank tenant, to catch NO_TENANT).
const sfUsers = await sfQuery(
  `SELECT Id, Email__c, Active__c, Client__c, Supabase_User_Id__c, First_Name__c, Last_Name__c ` +
  `FROM Sundial_User__c ORDER BY Email__c`
);
const sfByUid = new Map();
const sfByEmail = new Map();
for (const r of sfUsers || []) {
  if (r.Supabase_User_Id__c) sfByUid.set(String(r.Supabase_User_Id__c), r);
  if (r.Email__c) sfByEmail.set(r.Email__c.toLowerCase(), r);
}

// All auth users.
const { data: l, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (error) { console.error('listUsers failed:', error.message); process.exit(1); }
const authUsers = l.users || [];
const authByEmail = new Map(authUsers.map((u) => [(u.email || '').toLowerCase(), u]));

const rows = [];
const seenAuth = new Set();

// Classify from the auth side (catches ORPHAN_AUTH).
for (const u of authUsers) {
  const email = (u.email || '').toLowerCase();
  seenAuth.add(email);
  const sf = sfByUid.get(u.id) || sfByEmail.get(email);
  let cls;
  if (!sf) cls = 'ORPHAN_AUTH';
  else if (sf.Active__c === false) cls = 'INACTIVE';
  else if (!sf.Client__c) cls = 'NO_TENANT';
  else if (!u.last_sign_in_at) cls = 'NEVER_ONBOARDED';
  else cls = 'OK';
  rows.push({ email, cls, authId: u.id, sfId: sf?.Id || null,
    lastSignIn: u.last_sign_in_at || null, banned: !!u.banned_until && new Date(u.banned_until) > new Date('2000-01-01') });
}
// Classify SF-only (ORPHAN_SF): SF user whose email has no auth user.
for (const r of sfUsers || []) {
  const email = (r.Email__c || '').toLowerCase();
  if (email && !authByEmail.has(email)) {
    rows.push({ email, cls: 'ORPHAN_SF', authId: null, sfId: r.Id, lastSignIn: null, banned: false });
  }
}

// --- report ----------------------------------------------------------------
const order = ['ORPHAN_AUTH', 'ORPHAN_SF', 'NO_TENANT', 'NEVER_ONBOARDED', 'INACTIVE', 'OK'];
rows.sort((a, b) => order.indexOf(a.cls) - order.indexOf(b.cls) || a.email.localeCompare(b.email));
const counts = rows.reduce((m, r) => ((m[r.cls] = (m[r.cls] || 0) + 1), m), {});
console.log(`${apply ? 'APPLY' : 'DRY RUN'} — harmon tenant ${HARMON}`);
console.log('Summary:', JSON.stringify(counts), '\n');
for (const r of rows) {
  console.log(`  ${r.cls.padEnd(16)} ${r.email.padEnd(42)} ${r.lastSignIn ? 'signed-in' : 'never'}${r.banned ? ' BANNED' : ''}`);
}
console.log('');

// --- actions ---------------------------------------------------------------
const creds = [];
if (apply) {
  for (const r of rows.filter((x) => x.cls === 'NEVER_ONBOARDED')) {
    const pw = genPw();
    const u = authByEmail.get(r.email);
    const { error: e } = await admin.auth.admin.updateUserById(u.id, {
      password: pw, ban_duration: 'none',
      user_metadata: { ...(u.user_metadata || {}), must_change_password: true },
    });
    if (e) { console.log(`  FAILED reset ${r.email}: ${e.message}`); continue; }
    creds.push({ email: r.email, tempPassword: pw });
    console.log(`  reset OK  ${r.email}`);
  }
  if (out && creds.length) {
    writeFileSync(out,
      'Sundial temporary credentials (distribute securely; users must change on first login)\n\n' +
      creds.map((c) => `${c.email}\t${c.tempPassword}`).join('\n') + '\n', { encoding: 'utf8' });
    console.log(`\nWrote ${creds.length} credential(s) to ${out}`);
  }
}

if (deleteOrphans) {
  for (const r of rows.filter((x) => x.cls === 'ORPHAN_AUTH')) {
    const { error: e } = await admin.auth.admin.deleteUser(r.authId);
    console.log(`  ${e ? 'FAILED delete' : 'deleted orphan'} ${r.email}${e ? `: ${e.message}` : ''}`);
  }
} else if (rows.some((x) => x.cls === 'ORPHAN_AUTH')) {
  console.log('  (ORPHAN_AUTH users present — re-run with DELETE_ORPHANS=1 to remove, after review)');
}

if (!apply) console.log('\n(dry run — nothing changed; set APPLY=1 to fix NEVER_ONBOARDED, DELETE_ORPHANS=1 to remove orphans)');
