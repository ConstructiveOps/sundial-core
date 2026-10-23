#!/usr/bin/env node
// Live proof of the comment-scope rules at the database, as a real rep session:
// D-086 per-comment privacy (which amends D-064 A11) and the mention rules around it.
//
//   node scripts/verify-comment-scope.mjs
//
// RUN THIS AFTER APPLYING sql/sundial_access_p11_comment_privacy.sql. Before the SQL is
// applied it is EXPECTED to fail checks 1-6 (A11 still hides solar threads from the rep and
// `is_private` / set_comment_private() do not exist) — that failure is the before-picture,
// and the verdict at the bottom says so rather than leaving it looking broken.
//
// ---------------------------------------------------------------------------
// WHY A LIVE SCRIPT AND NOT JUST THE SQL'S OWN V-BLOCKS
// ---------------------------------------------------------------------------
// The V-blocks run as YOU, in the SQL editor, and check the predicate by calling it
// directly. That proves the FUNCTION returns the right answer. It does not prove the
// policies call it, that they are attached to the tables the browser actually queries, or
// that a real end-user JWT resolves to the profile the predicate keys on.
//
// This script closes those gaps, and it is the only thing that can, because comments are
// BROWSER-DIRECT (D-056): the portal talks to PostgREST itself with the user's own token.
// So this is the identical code path a rep's browser takes. Nothing is mocked, no service
// key is used, and there is no Lambda in the middle to be blamed if it passes.
//
// ---------------------------------------------------------------------------
// WHAT IT ASSERTS (D-086)
// ---------------------------------------------------------------------------
//   0. SETUP   — the rep can SEE the solar record; staff seeds a PUBLIC solar comment and
//                a PRIVATE comment on the solar's customer, and reads both back
//   1. READ    — the rep reads the PUBLIC solar comment (solar is visible through its
//                customer, D-086 reversing A11)
//   2. PRIVATE — the rep reads 0 rows for the PRIVATE comment on their own customer
//   3. WRITE   — the rep inserting is_private = true is REFUSED with 42501
//   4. TOGGLE  — staff set_comment_private() works (and the rep then reads 0 rows of the
//                flipped comment); the rep calling it returns false; staff cannot make a
//                REP's comment private (false)
//   5. MENTION — staff mentioning the rep on the PRIVATE comment is REFUSED with 42501;
//                on the PUBLIC solar comment it is ALLOWED; the picker agrees
//   6. CONTROL — public customer comments still read AND write for the same rep
//
// (5) is the one that matters most. `sundial-comment-notify` emails the COMMENT BODY to
// whoever is mentioned, so if a mention row can exist on a private comment, a rep receives
// by email what they cannot open.
//
// (6) is not decoration. Without it, 2, 3 and 5 pass just as happily against a bad token,
// a renamed table, or RLS refusing everything: three ways to get a green run with no
// access model at all.
//
// (0) proves visibility by a 200 from the read endpoint and the rows' existence by staff
// reading back what staff just wrote — a "0 rows" against a row that does not exist proves
// nothing (the first version of this script did exactly that; see git history).
//
// ⚠️ WRITES: every insert targets the ZZ fixtures only, and each is deleted again in a
// finally block. Per CLAUDE.md no live customer and no live user is touched, and the
// passwords come from Secrets Manager rather than from any file. The allowed mention in
// (5) fires sundial-comment-notify and emails the ZZ rep's mailbox — a ZZ address only.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { getSecret } from '../lib/secrets.js';

// ZZ fixtures. Never substitute a live record or a live user — see CLAUDE.md.
const CUSTOMER_ID = 'a1P7y00000AmyXCEAZ'; // ZZ PORTAL TEST — DO NOT USE
const SOLAR_ID_FALLBACK = 'a1Q7y00000JWmkvEAD'; // the ZZ Solar twin used by the p8 / p11 V-blocks
const REP_EMAIL = 'tim+zz-rep-a1@constructiveoperations.com';
const STAFF_EMAIL = 'tim+zz-admin@constructiveoperations.com';
// The writes below may only ever land on these. assertZz() makes that mechanical.
const ZZ_RECORDS = new Set([
  CUSTOMER_ID, 'a1P7y00000ApR0PEAV', 'a1P7y00000ApR21EAF', 'a1P7y00000ApR3dEAF',
  SOLAR_ID_FALLBACK, 'a1Q7y00000JWmo9EAD',
]);

/** PostgreSQL insufficient_privilege — what an RLS WITH CHECK refusal looks like. */
const RLS_DENIED = '42501';

const API = 'https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod';

function assertZz(recordId) {
  if (!ZZ_RECORDS.has(recordId)) {
    throw new Error(`REFUSING to write to ${recordId} — not a ZZ PORTAL TEST record.`);
  }
}

function env() {
  // The SAME url + ANON key the browser uses. The anon key is deliberate: a service key
  // bypasses RLS and would make every assertion below meaningless.
  for (const p of ['../../harmon-crm/.env.local', '../.env']) {
    let text;
    try {
      text = readFileSync(new URL(p, import.meta.url), 'utf8');
    } catch {
      continue;
    }
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    const url = out.VITE_SUPABASE_URL ?? out.SUPABASE_URL;
    const key = out.VITE_SUPABASE_ANON_KEY ?? out.SUPABASE_ANON_KEY;
    if (url && key) return { url, key };
  }
  throw new Error('No Supabase URL + ANON key in ../harmon-crm/.env.local or .env');
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log(`        ${detail}`);
}

async function signIn(url, key, email, passwords) {
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInWithPassword({
    email,
    password: passwords[email],
  });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return { sb, userId: data.user.id, token: data.session.access_token };
}

/** `comments.tenant_id` is the client SF id, the same value the portal sends. */
async function tenantIdFor(token) {
  const r = await fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  const me = await r.json();
  const id = me?.tenantId ?? me?.clientId ?? me?.tenant?.clientId ?? me?.tenant_id;
  if (!id) throw new Error('could not resolve tenant/client id from /auth/me');
  return id;
}

/** The portal's comment insert, with its .select().single() read-back. */
async function post(actor, { object, id, body, isPrivate }, tenantId) {
  assertZz(id);
  return actor.sb
    .from('comments')
    .insert({
      tenant_id: tenantId,
      record_object: object,
      record_id: id,
      author_id: actor.userId,
      author_name: 'ZZ D-086 probe',
      body,
      ...(isPrivate === undefined ? {} : { is_private: isPrivate }),
    })
    .select('id')
    .single();
}

/** Rows of one comment id this actor can read (0 or 1). */
async function readable(actor, commentId) {
  const r = await actor.sb.from('comments').select('id').eq('id', commentId);
  return { n: (r.data ?? []).length, error: r.error };
}

/**
 * Delete one probe row AS ITS AUTHOR and say what actually happened.
 *
 * A refused DELETE comes back as 0 rows and no error, so `await delete()` alone cannot
 * tell 'removed' from 'silently left behind'.
 */
async function purge(actor, commentId, label) {
  if (!commentId) return;
  await actor.sb.from('comment_mentions').delete().eq('comment_id', commentId);
  const del = await actor.sb.from('comments').delete().eq('id', commentId).select('id');
  const gone = !del.error && (del.data ?? []).length === 1;
  console.log(
    gone
      ? `        (${label} deleted)`
      : `        ⚠️ ${label} ${commentId} NOT deleted` +
        `${del.error ? ` — ${del.error.code}: ${del.error.message}` : ' — 0 rows affected'}` +
        ' — remove it by hand before re-running',
  );
}

async function main() {
  const { url, key } = env();
  const passwords = await getSecret('sundial/test-users');

  console.log('D-086 — per-comment privacy; dealer / rep read public Customer + Solar comments');
  console.log(`  supabase : ${url}`);
  console.log(`  as       : ${REP_EMAIL} (Sales Rep, own scope)\n`);

  const rep = await signIn(url, key, REP_EMAIL, passwords);
  const staff = await signIn(url, key, STAFF_EMAIL, passwords);
  const tenantId = await tenantIdFor(rep.token);

  // A solar record the rep CAN see, so a refusal below is about the COMMENT rule and not
  // about the record. Cache rows key on `sf_id`.
  let solarId = SOLAR_ID_FALLBACK;
  const listed = await fetch(`${API}/sf/solar?limit=1`, {
    headers: { Authorization: `Bearer ${rep.token}` },
  })
    .then((r) => r.json())
    .catch(() => null);
  const listedId = listed?.records?.[0]?.sf_id;
  if (listedId && ZZ_RECORDS.has(listedId)) solarId = listedId;

  // HARD ASSERT, not a comment. If the rep cannot see this record, every solar check below
  // is about the RECORD and proves nothing about the comment rule.
  const seen = await fetch(`${API}/sf/solar/${solarId}?full=true`, {
    headers: { Authorization: `Bearer ${rep.token}` },
  });
  if (seen.status !== 200) {
    console.log(`  ABORT: the rep cannot read solar ${solarId} (HTTP ${seen.status}).`);
    console.log('         Seed a visible solar twin and re-run:');
    console.log('         node scripts/seed-access-test-fixtures.mjs --apply');
    process.exit(2);
  }

  // The solar's CUSTOMER — D-086 makes the solar visible through it, and the private
  // comment goes on it. Read as staff: the full record carries the lookup for tenant scope.
  const staffSolar = await fetch(`${API}/sf/solar/${solarId}?full=true`, {
    headers: { Authorization: `Bearer ${staff.token}` },
  })
    .then((r) => r.json())
    .catch(() => null);
  const solarCustomerId = staffSolar?.record?.Sundial_Customer__c ?? null;
  if (!solarCustomerId || !ZZ_RECORDS.has(solarCustomerId)) {
    console.log(`  ABORT: solar ${solarId}'s customer (${solarCustomerId ?? 'unknown'}) is not a ZZ fixture.`);
    console.log('         Re-seed: node scripts/seed-access-test-fixtures.mjs --apply');
    process.exit(2);
  }

  console.log(`  solar rec: ${solarId} (customer ${solarCustomerId})`);
  console.log(`             HTTP ${seen.status} for this rep — so a refusal below is about`);
  console.log('             the COMMENT rule and not about the record');
  console.log(`  tenant   : ${tenantId}`);
  console.log();

  let publicSolarId = null;
  let privateCustId = null;
  let repOwnId = null;
  let strayId = null;

  try {
    // -------------------------------------------------------------- 0. SETUP
    const pub = await post(staff, { object: 'solar', id: solarId, body: 'ZZ D-086 probe — staff PUBLIC solar comment' }, tenantId);
    const priv = await post(staff, { object: 'customer', id: solarCustomerId, body: 'ZZ D-086 probe — staff PRIVATE customer comment', isPrivate: true }, tenantId);
    publicSolarId = pub.data?.id ?? null;
    privateCustId = priv.data?.id ?? null;
    const staffSeesPub = publicSolarId ? await readable(staff, publicSolarId) : { n: 0 };
    const staffSeesPriv = privateCustId ? await readable(staff, privateCustId) : { n: 0 };
    check(
      '0. SETUP    staff writes a PUBLIC solar comment and a PRIVATE customer comment, and reads both',
      staffSeesPub.n === 1 && staffSeesPriv.n === 1,
      pub.error || priv.error
        ? `${(pub.error ?? priv.error).code}: ${(pub.error ?? priv.error).message}`
        : `public ${publicSolarId} · private ${privateCustId}`,
    );

    if (publicSolarId && privateCustId) {
      // ------------------------------------------------------------ 1. READ
      const r1 = await rep.sb.from('comments').select('id, is_private').eq('record_object', 'solar').eq('record_id', solarId);
      const got1 = (r1.data ?? []).filter((c) => c.id === publicSolarId);
      check(
        '1. READ     the rep reads the PUBLIC comment on their own solar (via the customer)',
        !r1.error && got1.length === 1,
        r1.error ? `${r1.error.code}: ${r1.error.message}` : `${got1.length} of 1 — D-086 reverses A11 for public comments`,
      );

      // ------------------------------------------------------------ 2. PRIVATE
      const r2 = await readable(rep, privateCustId);
      check(
        '2. PRIVATE  the rep reads 0 rows for the PRIVATE comment on their own customer',
        !r2.error && r2.n === 0,
        r2.error ? `unexpected error ${r2.error.code}: ${r2.error.message}` : `${r2.n} row(s) against a row staff can read`,
      );

      // ------------------------------------------------------------ 5. MENTION (private / public)
      // Before any toggle, while each comment's privacy is known.
      const mPriv = await staff.sb.from('comment_mentions').insert({ comment_id: privateCustId, mentioned_user_id: rep.userId });
      check(
        `5. MENTION  staff mentioning the rep on the PRIVATE comment is refused with ${RLS_DENIED}`,
        mPriv.error?.code === RLS_DENIED,
        mPriv.error ? `got ${mPriv.error.code}: ${mPriv.error.message}` : 'MENTION SUCCEEDED — sundial-comment-notify would email this rep a private body',
      );
      const mPub = await staff.sb.from('comment_mentions').insert({ comment_id: publicSolarId, mentioned_user_id: rep.userId });
      check(
        '5. MENTION  staff mentioning the rep on the PUBLIC solar comment is allowed',
        !mPub.error,
        mPub.error ? `${mPub.error.code}: ${mPub.error.message}` : 'allowed (emails the ZZ rep mailbox)',
      );
      const pick = async (isPrivate) =>
        staff.sb.rpc('mentionable_users', { p_object: 'customer', p_id: solarCustomerId, p_user_ids: [rep.userId], p_is_private: isPrivate });
      const pickPriv = await pick(true);
      const pickPub = await pick(false);
      check(
        '5. PICKER   mentionable_users agrees: the rep is out for a private comment, in for a public one',
        !pickPriv.error && !pickPub.error && (pickPriv.data ?? []).length === 0 && (pickPub.data ?? []).length === 1,
        pickPriv.error || pickPub.error
          ? `${(pickPriv.error ?? pickPub.error).message}`
          : `private ${(pickPriv.data ?? []).length} · public ${(pickPub.data ?? []).length}`,
      );

      // ------------------------------------------------------------ 4. TOGGLE
      const repToggle = await rep.sb.rpc('set_comment_private', { p_comment_id: publicSolarId, p_private: true });
      check(
        '4. TOGGLE   the rep calling set_comment_private returns false',
        !repToggle.error && repToggle.data === false,
        repToggle.error ? `${repToggle.error.code}: ${repToggle.error.message}` : `returned ${repToggle.data}`,
      );
      const staffToggle = await staff.sb.rpc('set_comment_private', { p_comment_id: publicSolarId, p_private: true });
      const afterToggle = await readable(rep, publicSolarId);
      check(
        '4. TOGGLE   staff set_comment_private(true) works, and the rep then reads 0 rows of it',
        !staffToggle.error && staffToggle.data === true && afterToggle.n === 0,
        staffToggle.error ? `${staffToggle.error.code}: ${staffToggle.error.message}` : `returned ${staffToggle.data}; rep reads ${afterToggle.n}`,
      );
      const staffBack = await staff.sb.rpc('set_comment_private', { p_comment_id: publicSolarId, p_private: false });
      const afterBack = await readable(rep, publicSolarId);
      check(
        '4. TOGGLE   and back to public: the rep reads it again',
        !staffBack.error && staffBack.data === true && afterBack.n === 1,
        staffBack.error ? `${staffBack.error.code}: ${staffBack.error.message}` : `returned ${staffBack.data}; rep reads ${afterBack.n}`,
      );
    }

    // -------------------------------------------------------------- 3. WRITE
    const ins = await post(rep, { object: 'customer', id: solarCustomerId, body: 'ZZ D-086 probe — private from a rep, should be refused', isPrivate: true }, tenantId);
    strayId = ins.data?.id ?? null;
    check(
      `3. WRITE    the rep inserting is_private = true is refused with ${RLS_DENIED}`,
      ins.error?.code === RLS_DENIED,
      ins.error ? `got ${ins.error.code}: ${ins.error.message}` : 'INSERT SUCCEEDED — the WITH CHECK policy is not in force',
    );

    // -------------------------------------------------------------- 4. TOGGLE (a rep's own words)
    const own = await post(rep, { object: 'customer', id: solarCustomerId, body: 'ZZ D-086 probe — rep public comment' }, tenantId);
    repOwnId = own.data?.id ?? null;
    if (repOwnId) {
      const hide = await staff.sb.rpc('set_comment_private', { p_comment_id: repOwnId, p_private: true });
      check(
        "4. TOGGLE   staff CANNOT make a rep's own comment private (false)",
        !hide.error && hide.data === false,
        hide.error ? `${hide.error.code}: ${hide.error.message}` : `returned ${hide.data}`,
      );
    } else {
      check("4. TOGGLE   staff CANNOT make a rep's own comment private (false)", false,
        `could not create the rep's comment: ${own.error?.code}: ${own.error?.message}`);
    }
  } finally {
    // Each row is deleted by its OWN author (the delete policy is author-scoped, and a
    // refused DELETE reports 0 rows, not an error — see purge()).
    await purge(staff, publicSolarId, 'staff public solar comment');
    await purge(staff, privateCustId, 'staff private customer comment');
    await purge(rep, repOwnId, 'rep public comment');
    await purge(rep, strayId, 'wrongly-created rep private comment');
  }

  // ---------------------------------------------------------------- 6. CONTROL
  const custRead = await rep.sb
    .from('comments')
    .select('id')
    .eq('record_object', 'customer')
    .eq('record_id', CUSTOMER_ID);

  check(
    '6. CONTROL  customer comments READ without error',
    !custRead.error,
    custRead.error
      ? `${custRead.error.code}: ${custRead.error.message}`
      : `${(custRead.data ?? []).length} row(s) — the read path itself works`,
  );

  const custIns = await post(rep, { object: 'customer', id: CUSTOMER_ID, body: 'ZZ D-086 control — the rep MAY post a public customer comment' }, tenantId);
  try {
    check(
      '6. CONTROL  public customer comment INSERT succeeds for the same rep',
      !custIns.error && !!custIns.data?.id,
      custIns.error
        ? `${custIns.error.code}: ${custIns.error.message}`
        : 'inserted, so the refusals above are about privacy and nothing else',
    );
  } finally {
    await purge(rep, custIns.data?.id ?? null, 'control comment');
  }

  // ---------------------------------------------------------------- 7. MENTIONS (rep tags staff)
  //
  // The launch blocker of 2026-08-31: reps reported they could not @-mention Harmon
  // staff. Diagnosed to the CLIENT picker (`.slice(0, 6)` over a last-name-ordered list,
  // so a bare "@" showed only the alphabetically-first six). The server union and RLS
  // were both correct — but nothing was asserting either, so nothing would have caught
  // it if they had not been.
  //
  // ⚠️ THE INSERT BELOW DELIBERATELY HAS NO `.select()`.
  //
  // That is the client's exact call shape, and the difference is not cosmetic. Adding
  // `.select()` makes it INSERT ... RETURNING, and RETURNING is filtered by
  // `mentions_select_own` (a mention is readable only by the person mentioned). Postgres
  // reports that with the SAME 42501 "new row violates row-level security policy" text as
  // a WITH CHECK failure. During the original diagnosis that produced a false "RLS
  // refuses tenant-staff mentions" finding, which was wrong and sent the investigation
  // at the database instead of the picker. Keep the shapes identical to the client's.
  const staffTarget = await signIn(url, key, STAFF_EMAIL, passwords);
  let mentionComment = null;
  try {
    const c5 = await rep.sb
      .from('comments')
      .insert({
        tenant_id: tenantId,
        record_object: 'customer',
        record_id: CUSTOMER_ID,
        author_id: rep.userId,
        author_name: 'ZZ A11 probe',
        body: 'ZZ A11 mention probe — rep tagging tenant staff on own customer',
      })
      .select('id')
      .single();

    if (c5.error) {
      check('7. MENTION  could not create the customer comment to tag on', false,
        `${c5.error.code}: ${c5.error.message}`);
    } else {
      mentionComment = c5.data.id;
      const m5 = await rep.sb
        .from('comment_mentions')
        .insert({ comment_id: mentionComment, mentioned_user_id: staffTarget.userId });

      check(
        '7. MENTION  a rep CAN tag tenant-scope staff on their own customer record',
        !m5.error,
        m5.error
          ? `${m5.error.code}: ${m5.error.message} — §3.5 and D-086 both say this must work`
          : 'allowed — reps tag Harmon staff from their feed (D-086)',
      );

      // Prove the row PERSISTED, not merely that the call returned no error. Read as the
      // mentioned user, since mentions_select_own is the only way to see it.
      const seen = await staffTarget.sb
        .from('comment_mentions')
        .select('id')
        .eq('comment_id', mentionComment);
      check(
        '7. MENTION  the mention row actually persisted',
        !seen.error && (seen.data ?? []).length === 1,
        seen.error
          ? `${seen.error.code}: ${seen.error.message}`
          : `${(seen.data ?? []).length} row(s) visible to the mentioned user`,
      );
    }
  } finally {
    if (mentionComment) {
      // The mention row is deleted by the MENTIONED user: mentions_select_own scopes
      // visibility to them, and you cannot delete what you cannot see.
      await staffTarget.sb.from('comment_mentions').delete().eq('comment_id', mentionComment);
      await purge(rep, mentionComment, 'mention probe comment');
    }
  }

  // ---------------------------------------------------------------- 8. PICKER SOURCE
  //
  // The picker is fed by GET /sf/users (`api.listUsers()`), so if staff are missing from
  // THAT, no amount of client fixing helps. Asserted here because the reported symptom
  // was "staff never appear", and the only way to tell a server-side omission from a
  // client-side truncation is to check the payload itself.
  const picker = await fetch(`${API}/sf/users`, {
    headers: { Authorization: `Bearer ${rep.token}` },
  });
  const pickerBody = await picker.json().catch(() => ({}));
  const pickerUsers = pickerBody.users ?? [];
  const staffPresent = pickerUsers.some((u) => u.supabaseUserId === staffTarget.userId);
  const noAuthId = pickerUsers.filter((u) => !u.supabaseUserId);

  check(
    '8. PICKER   GET /sf/users includes tenant-scope staff for a sales role (§3.5)',
    picker.status === 200 && staffPresent,
    picker.status !== 200
      ? `HTTP ${picker.status}`
      : `${pickerUsers.length} users returned; the staff target is ${staffPresent ? 'present' : 'MISSING'}` +
        `; ${noAuthId.length} without a Supabase login` +
        (noAuthId.length ? ` (not mentionable, shown greyed: ${noAuthId.map((u) => u.name).join(', ')})` : ''),
  );

  // The rep must reach staff who are NOT in the first handful, since that is precisely
  // what the old cap hid. Counting past the old limit is what makes this a regression
  // test rather than a restatement of the first check 8.
  const staffIndex = pickerUsers.findIndex((u) => u.supabaseUserId === staffTarget.userId);
  check(
    '8. PICKER   staff are reachable beyond the old 6-name cap',
    staffIndex >= 0 && pickerUsers.length > 6,
    `the staff target sits at position ${staffIndex + 1} of ${pickerUsers.length}` +
      (staffIndex >= 6
        ? ' — INVISIBLE under the old .slice(0, 6), which is the bug this pins'
        : ' — inside the old cap, so this run does not exercise the truncation'),
  );



  // ---------------------------------------------------------------- verdict
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}`);
    console.log(
      '\nIf 1-5 failed and 6 passed, the p11 SQL has not been applied yet — that is the\n' +
        'expected before-picture. If 6 failed, fix that FIRST: the others cannot be\n' +
        'trusted until the control passes.',
    );
    process.exit(1);
  }
  console.log('\nD-086 is enforced at the database, on the same path the browser uses.');
}

main().catch((e) => {
  console.error(`\nverify-comment-scope: ${e.message}`);
  process.exit(1);
});
