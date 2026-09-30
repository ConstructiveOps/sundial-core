// users.js — the eleven demo logins: a Supabase auth user each, their passwords in
// Secrets Manager, and (through the normal writer) a Sundial_User__c.
//
// Mirrors scripts/seed-access-test-fixtures.mjs:
//   * passwords are generated here and kept in ONE Secrets Manager secret
//     (sundial/demo-users) — never in a file, never printed unless --show-passwords;
//   * an existing login keeps its stored password, so a re-run never locks anyone out;
//   * a password that had to be generated AGAIN (the secret was lost, or lost an entry)
//     is also set on the login that already exists — the secret and the login must
//     always agree, whichever of the two was lost;
//   * the emails are plus-addresses of the owner, so an invite or reset lands in a real
//     inbox and none can collide with a client's login.
//
// One extra guard the test fixtures did not need: if Supabase already has a user with one
// of these emails, it is reused ONLY when no Sundial user in ANOTHER tenant is bound to
// it. Re-pointing somebody else's login at the demo tenant would lock a real person out.

import { DEMO_USERS_SECRET } from "./policy.js";
import { PERSONAS } from "./catalog.js";
import { SeedError } from "./writer.js";
import { loginEntries } from "./run-record.js";

/** Every auth user, by lower-cased email. Pages through the admin list. */
async function listAuthUsers(supabase) {
  const byEmail = new Map();
  const perPage = 1000;
  for (let page = 1; page < 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new SeedError(`Supabase could not list users: ${error.message}`, "SUPABASE_LIST");
    const users = data?.users || [];
    for (const u of users) if (u.email) byEmail.set(u.email.toLowerCase(), u);
    if (users.length < perPage) break;
  }
  return byEmail;
}

/**
 * READ-ONLY: which demo emails already exist as logins, and is any of them bound to a
 * Sundial user outside the demo tenant? Used by the preflight (dry run and apply alike).
 */
export async function checkAuthCollisions({ supabase, sfQuery, tenantId }) {
  const byEmail = await listAuthUsers(supabase);
  const existing = [];
  const blocked = [];
  for (const p of PERSONAS) {
    const found = byEmail.get(p.email.toLowerCase());
    if (!found) continue;
    existing.push({ key: p.key, email: p.email, id: found.id });
    const rows = await sfQuery(`SELECT Id, Client__c FROM Sundial_User__c WHERE Supabase_User_Id__c = '${found.id}'`);
    const foreign = (rows || []).filter((r) => !tenantId || String(r.Client__c).slice(0, 15) !== String(tenantId).slice(0, 15));
    if (foreign.length) blocked.push(`${p.email}: this login already belongs to a Sundial user in another tenant`);
  }
  return { existing, blocked, byEmail };
}

/**
 * Create (or safely reuse) the auth users and store the passwords. Apply only.
 * Fills idmap.data.supabase.authUsers and counters.
 */
export async function ensureAuthUsers({ io, idmap, tenantSlug, log, counters }) {
  const supabase = await io.getSupabase();
  const tenantId = idmap.idOf("tenant");
  if (!tenantId) throw new SeedError(`the tenant has not been created yet — run the "tenant" phase first.`, "MISSING_REFERENCE");

  // 1. Passwords: keep what the secret already holds, generate only what is missing, and
  //    save BEFORE creating a login — the secret must always be able to open every login.
  //    (The secret also carries the run record under `_run`; it is passed through untouched.)
  const stored = await io.secrets.load(DEMO_USERS_SECRET);
  const passwords = { ...(stored || {}) };
  const generated = new Set();
  for (const p of PERSONAS) {
    if (!passwords[p.email]) {
      passwords[p.email] = io.randomPassword();
      generated.add(p.email);
    }
  }
  if (generated.size || !stored) {
    await io.secrets.save(DEMO_USERS_SECRET, passwords, Boolean(stored));
    const what = Object.keys(loginEntries(stored)).length ? `updated (${generated.size} new password(s))` : `${stored ? "updated" : "created"} (${generated.size} password(s))`;
    counters.secret = what;
    log(`  passwords: ${generated.size} generated, stored in Secrets Manager "${DEMO_USERS_SECRET}"`);
  }

  // 2. Logins.
  const { blocked, byEmail } = await checkAuthCollisions({ supabase, sfQuery: io.sf.sfQuery, tenantId });
  if (blocked.length) throw new SeedError(`Refusing to reuse a login that is in use elsewhere:\n    ${blocked.join("\n    ")}`, "AUTH_IN_USE");
  const setPassword = async (p, id) => {
    const { error } = await supabase.auth.admin.updateUserById(id, { password: passwords[p.email] });
    if (error) throw new SeedError(`Supabase could not reset the password of ${p.email}: ${error.message}`, "SUPABASE_UPDATE");
  };
  for (const p of PERSONAS) {
    const found = byEmail.get(p.email.toLowerCase());
    const recorded = idmap.data.supabase.authUsers[p.key];
    if (recorded) {
      // The login was made by an earlier run. Nothing to do — UNLESS its password had to be
      // generated again just now (the secret was lost or lost this entry): the old password
      // is gone for good, so the login gets the new one. It passed the check above: it is
      // not bound to a Sundial user of any other tenant.
      if (!generated.has(p.email)) continue;
      if (!found) {
        log(`  login ${p.email}: recorded in the id-map but no longer in Supabase — a password was stored for it, but there is no login to open.`);
        continue;
      }
      await setPassword(p, found.id);
      if (found.id !== recorded) {
        idmap.data.supabase.authUsers[p.key] = found.id;
        await idmap.save();
      }
      counters.authReused = (counters.authReused || 0) + 1;
      log(`  login ${p.email}: password reset to the newly stored one (the secret had lost it)`);
      continue;
    }
    let id;
    if (found) {
      // Reuse, and set the password to the stored one so the secret stays the truth.
      await setPassword(p, found.id);
      id = found.id;
      counters.authReused = (counters.authReused || 0) + 1;
      log(`  login ${p.email}: reused`);
    } else {
      const { data, error } = await supabase.auth.admin.createUser({
        email: p.email,
        password: passwords[p.email],
        email_confirm: true, // no confirmation email is sent
        user_metadata: { demo_tenant: tenantSlug, demo_persona: p.slug },
      });
      if (error) throw new SeedError(`Supabase could not create ${p.email}: ${error.message}`, "SUPABASE_CREATE");
      id = data?.user?.id;
      if (!id) throw new SeedError(`Supabase returned no id for ${p.email}.`, "SUPABASE_CREATE");
      counters.authCreated = (counters.authCreated || 0) + 1;
      log(`  login ${p.email}: created`);
    }
    idmap.data.supabase.authUsers[p.key] = id;
    await idmap.save();
  }
}

/** --show-passwords: the stored logins (never the run record), or null when the secret does not exist yet. */
export async function loadPasswords(io) {
  const secret = await io.secrets.load(DEMO_USERS_SECRET);
  return secret === null ? null : loginEntries(secret);
}
