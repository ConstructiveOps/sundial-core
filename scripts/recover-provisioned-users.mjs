// Recovery for users provisioned while email delivery was down. FIX IN PLACE:
// sets a fresh temporary password + forces a change on first sign-in, on the
// EXISTING auth user (the linked Sundial_User__c is untouched — no delete/recreate).
//
// Usage:
//   node scripts/recover-provisioned-users.mjs                 # dry run: lists targets only
//   APPLY=1 OUT=<path> node scripts/recover-provisioned-users.mjs   # applies; writes creds to OUT
//
// Temp passwords are written ONLY to the OUT file (never stdout/logs). Distribute
// them securely to each user; they are forced to set their own on first login.
import { getSupabaseClient } from '../lib/supabase.js';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const TARGETS = (process.env.EMAILS
  ? process.env.EMAILS.split(',').map((s) => s.trim()).filter(Boolean)
  : [
      'benwollschlager@harmonelectric.net', 'troyjohnston@harmonelectric.net',
      'bradleyyant@harmonelectric.net', 'troyjohnson@harmonelectric.net',
      'cameronlabonte@harmonelectric.net', 'marjoriekopp@harmonelectric.net',
      'lindsaymccormack@harmonelectric.net', 'arnoldyazzie@harmonelectric.net',
      'davidcoleman@harmonelectric.net', 'johnheckert@harmonelectric.net',
    ]);

// Strong, readable temp password: 16 url-safe chars (satisfies the 8-char min).
const genPw = () => randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) + 'A9!';

const admin = await getSupabaseClient();
const { data: list, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
if (error) { console.error('listUsers failed:', error.message); process.exit(1); }
const byEmail = new Map((list.users || []).map((u) => [(u.email || '').toLowerCase(), u]));

const apply = process.env.APPLY === '1';
const out = process.env.OUT;
console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — ${TARGETS.length} target(s)\n`);

const creds = [];
for (const email of TARGETS) {
  const u = byEmail.get(email.toLowerCase());
  if (!u) { console.log(`  MISSING  ${email} (no auth user)`); continue; }
  if (!apply) { console.log(`  would reset  ${email}`); continue; }
  const pw = genPw();
  const { error: uErr } = await admin.auth.admin.updateUserById(u.id, {
    password: pw,
    ban_duration: 'none', // ensure not banned
    user_metadata: { ...(u.user_metadata || {}), must_change_password: true },
  });
  if (uErr) { console.log(`  FAILED   ${email}: ${uErr.message}`); continue; }
  creds.push({ email, tempPassword: pw });
  console.log(`  reset OK  ${email}`);
}

if (apply && out && creds.length) {
  const body = 'Sundial temporary credentials (distribute securely; users must change on first login)\n\n'
    + creds.map((c) => `${c.email}\t${c.tempPassword}`).join('\n') + '\n';
  writeFileSync(out, body, { encoding: 'utf8' });
  console.log(`\nCredentials for ${creds.length} user(s) written to:\n  ${out}`);
}
