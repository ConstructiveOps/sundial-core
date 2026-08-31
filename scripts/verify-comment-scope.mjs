#!/usr/bin/env node
// Live proof that D-064 A11 is enforced by RLS: sales-role comments are CUSTOMER-ONLY.
//
//   node scripts/verify-comment-scope.mjs
//
// RUN THIS AFTER APPLYING sql/sundial_access_p8_comments_customer_only.sql. Before the
// SQL is applied it is EXPECTED to fail checks 1-3 — that failure is the before-picture,
// and the verdict at the bottom says so rather than leaving it looking broken.
//
// ---------------------------------------------------------------------------
// WHY A LIVE SCRIPT AND NOT JUST THE SQL'S OWN V1-V8
// ---------------------------------------------------------------------------
// V1-V8 run as YOU, in the SQL editor, and check the predicate by calling it directly.
// That proves the FUNCTION returns the right answer. It does not prove the policies call
// it, that they are attached to the tables the browser actually queries, or that a real
// end-user JWT resolves to the profile the predicate keys on.
//
// This script closes those gaps, and it is the only thing that can, because comments are
// BROWSER-DIRECT (D-056): the portal talks to PostgREST itself with the user's own token.
// So this is the identical code path a rep's browser takes. Nothing is mocked, no service
// key is used, and there is no Lambda in the middle to be blamed if it passes.
//
// ---------------------------------------------------------------------------
// WHAT IT ASSERTS
// ---------------------------------------------------------------------------
//   0. SETUP   — the rep can SEE the solar record, and STAFF seeds a comment on it
//   1. READ    — that seeded comment returns 0 ROWS for zz-rep-a1 (RLS filters, no error)
//   2. WRITE   — the rep inserting a solar comment is REFUSED with 42501
//   3. MENTION — STAFF mentioning the rep on a solar comment is REFUSED with 42501
//   4. CONTROL — customer comments still read AND write for the same rep, same session
//
// (3) is the one that matters most. `sundial-comment-notify` emails the COMMENT BODY to
// whoever is mentioned, so if the mention row can exist, a rep who cannot open a solar
// comment receives its contents by email — a worse leak than the tab being visible.
//
// (4) is not decoration. Without it, 1-3 pass just as happily against a bad token, a
// renamed table, or RLS refusing everything: three ways to get a green run with no
// access model at all.
//
// (0) exists because the FIRST version of this script passed checks 1 and 3 for the
// wrong reasons, while asserting in a comment what it had not verified:
//
//   - it checked "0 rows" against a record carrying NO solar comments at all, so the
//     read check would have gone green with RLS switched off entirely; and
//   - it called the solar record "visible to this rep" while silently using a
//     hard-coded fallback id, because cache rows key on `sf_id` and it read `Id`. Had
//     the rep not been able to see that record, every solar refusal below would have
//     been a refusal about the RECORD and none of them about comments.
//
// Both are now proven instead of assumed: visibility by a 200 from the read endpoint,
// and the row's existence by staff reading back what staff just wrote.
//
// ⚠️ WRITES: every insert targets the ZZ fixtures only, and each is deleted again in a
// finally block. Per CLAUDE.md no live customer and no live user is touched, and the
// passwords come from Secrets Manager rather than from any file.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { getSecret } from '../lib/secrets.js';

// ZZ fixtures. Never substitute a live record or a live user — see CLAUDE.md.
const CUSTOMER_ID = 'a1P7y00000AmyXCEAZ'; // ZZ PORTAL TEST — DO NOT USE
const SOLAR_ID_FALLBACK = 'a1Q7y00000JWmkvEAD'; // the ZZ Solar twin used by the p8 V-blocks
const REP_EMAIL = 'tim+zz-rep-a1@constructiveoperations.com';
const STAFF_EMAIL = 'tim+zz-admin@constructiveoperations.com';

/** PostgreSQL insufficient_privilege — what an RLS WITH CHECK refusal looks like. */
const RLS_DENIED = '42501';

const API = 'https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod';

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

  console.log('D-064 A11 — sales-role comments are CUSTOMER-ONLY');
  console.log(`  supabase : ${url}`);
  console.log(`  as       : ${REP_EMAIL} (Sales Rep, own scope)\n`);

  const rep = await signIn(url, key, REP_EMAIL, passwords);
  const tenantId = await tenantIdFor(rep.token);

  // A solar record the rep CAN see, so a refusal below is about the COMMENT rule and not
  // about the record. Taken from the rep's own visible set where possible: a hard-coded
  // id can silently become one they cannot see, which turns every solar assertion into a
  // pass for the wrong reason.
  let solarId = SOLAR_ID_FALLBACK;
  const listed = await fetch(`${API}/sf/solar?limit=1`, {
    headers: { Authorization: `Bearer ${rep.token}` },
  })
    .then((r) => r.json())
    .catch(() => null);
  // Cache rows key on `sf_id`. Reading `Id` here fell through to the hard-coded fallback
  // without saying so, which is how the visibility claim went unverified the first time.
  const listedId = listed?.records?.[0]?.sf_id;
  if (listedId) solarId = listedId;

  // HARD ASSERT, not a comment. If the rep cannot see this record, every solar refusal
  // below is a refusal about the RECORD and proves nothing about the comment rule.
  const seen = await fetch(`${API}/sf/solar/${solarId}?full=true`, {
    headers: { Authorization: `Bearer ${rep.token}` },
  });
  if (seen.status !== 200) {
    console.log(`  ABORT: the rep cannot read solar ${solarId} (HTTP ${seen.status}).`);
    console.log('         Every solar refusal below would be about the RECORD, not the');
    console.log('         comment rule. Seed a visible solar twin and re-run:');
    console.log('         node scripts/seed-access-test-fixtures.mjs --apply');
    process.exit(2);
  }

  console.log(`  solar rec: ${solarId}`);
  console.log(`             HTTP ${seen.status} for this rep — so a refusal below is about`);
  console.log('             the COMMENT rule and not about the record');
  console.log(`  tenant   : ${tenantId}`);
  console.log();

  // ---------------------------------------------------------------- 0. SETUP
  //
  // STAFF seeds a solar comment first, so that check 1's "0 rows" is a statement
  // about RLS and not about an empty table. Without a row that DOES exist and IS
  // hidden, the read check goes green with the access model switched off entirely.
  const staff = await signIn(url, key, STAFF_EMAIL, passwords);
  let staffCommentId = null;
  let strayId = null;

  try {
    const seeded = await staff.sb
      .from('comments')
      .insert({
        tenant_id: tenantId,
        record_object: 'solar',
        record_id: solarId,
        author_id: staff.userId,
        author_name: 'ZZ A11 probe (staff)',
        body: 'ZZ A11 scope probe — staff comment on a solar record',
      })
      .select('id')
      .single();

    if (seeded.error) {
      // Tenant scope keeps FULL comments on Solar — A11 narrows sales roles only. So
      // this is a real failure, not a permission working as intended, and every solar
      // check below would be untestable without the row.
      check(
        '0. SETUP    staff can comment on a solar record (tenant scope is unchanged)',
        false,
        `${seeded.error.code}: ${seeded.error.message} — cannot seed the row the read`
          + ' check needs, so checks 1 and 3 are being skipped rather than reported',
      );
    } else {
      staffCommentId = seeded.data.id;
      const staffSees = await staff.sb.from('comments').select('id').eq('id', staffCommentId);
      check(
        '0. SETUP    staff can comment on a solar record AND read it back',
        !staffSees.error && (staffSees.data ?? []).length === 1,
        staffSees.error
          ? `${staffSees.error.code}: ${staffSees.error.message}`
          : `comment ${staffCommentId} exists and is visible to staff`,
      );

      // ------------------------------------------------------------ 1. READ
      const solarRead = await rep.sb
        .from('comments')
        .select('id')
        .eq('record_object', 'solar')
        .eq('record_id', solarId);

      check(
        '1. READ     the rep sees 0 rows for a solar comment that DOES exist',
        !solarRead.error && (solarRead.data ?? []).length === 0,
        solarRead.error
          ? `unexpected error ${solarRead.error.code}: ${solarRead.error.message}`
          : `${(solarRead.data ?? []).length} row(s) — RLS FILTERS a select, it does`
            + ' not error, so 0 rows against a row staff can see is the whole proof',
      );

      // ------------------------------------------------------------ 3. MENTION
      //
      // The sharpest one. sundial-comment-notify emails the COMMENT BODY to whoever
      // is mentioned, so if this row can exist, a rep who cannot open the comment
      // receives its contents by email — a worse leak than the tab being visible.
      const mention = await staff.sb
        .from('comment_mentions')
        .insert({ comment_id: staffCommentId, mentioned_user_id: rep.userId })
        .select('id');

      check(
        `3. MENTION  mentioning the rep on that solar comment is refused with ${RLS_DENIED}`,
        mention.error?.code === RLS_DENIED,
        mention.error
          ? `got ${mention.error.code}: ${mention.error.message}`
          : 'MENTION SUCCEEDED — sundial-comment-notify would email this rep the BODY',
      );
    }

    // -------------------------------------------------------------- 2. WRITE
    const ins = await rep.sb
      .from('comments')
      .insert({
        tenant_id: tenantId,
        record_object: 'solar',
        record_id: solarId,
        author_id: rep.userId,
        author_name: 'ZZ A11 probe',
        body: 'ZZ A11 scope probe — should be refused',
      })
      .select('id');

    strayId = ins.data?.[0]?.id ?? null;
    check(
      `2. WRITE    the rep inserting a solar comment is refused with ${RLS_DENIED}`,
      ins.error?.code === RLS_DENIED,
      ins.error
        ? `got ${ins.error.code}: ${ins.error.message}`
        : 'INSERT SUCCEEDED — the WITH CHECK policy is not in force',
    );
  } finally {
    // Roll back everything this script created, refused or not.
    //
    // ⚠️ EACH ROW IS DELETED BY ITS OWN AUTHOR. The delete policy is author-scoped, so
    // staff deleting the REP's comment is refused — and PostgREST reports a refused
    // DELETE as 0 rows affected, not as an error. The first version of this cleanup
    // did exactly that, printed 'deleted', and left two probe comments on the ZZ twin
    // that turned up in the next run as a phantom extra row.
    //
    // Hence `.select('id')` and a count on every delete: a cleanup that cannot report
    // its own failure is how test data becomes permanent.
    await purge(staff, staffCommentId, 'staff probe comment');
    await purge(rep, strayId, 'wrongly-created rep comment');
  }

  // ---------------------------------------------------------------- 4. CONTROL
  const custRead = await rep.sb
    .from('comments')
    .select('id')
    .eq('record_object', 'customer')
    .eq('record_id', CUSTOMER_ID);

  check(
    '4. CONTROL  customer comments READ without error',
    !custRead.error,
    custRead.error
      ? `${custRead.error.code}: ${custRead.error.message}`
      : `${(custRead.data ?? []).length} row(s) — the read path itself works`,
  );

  const custIns = await rep.sb
    .from('comments')
    .insert({
      tenant_id: tenantId,
      record_object: 'customer',
      record_id: CUSTOMER_ID,
      author_id: rep.userId,
      author_name: 'ZZ A11 probe',
      body: 'ZZ A11 control — the rep MAY comment on a customer',
    })
    .select('id');

  try {
    check(
      '4. CONTROL  customer comment INSERT succeeds for the same rep',
      !custIns.error && !!custIns.data?.[0]?.id,
      custIns.error
        ? `${custIns.error.code}: ${custIns.error.message} — A11 must narrow SOLAR ONLY`
        : 'inserted, so the refusals above are about the object and nothing else',
    );
  } finally {
    // Same author-scoped delete, same verification — see purge().
    await purge(rep, custIns.data?.[0]?.id ?? null, 'control comment');
  }

  // ---------------------------------------------------------------- 5. MENTIONS
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
      check('5. MENTION  could not create the customer comment to tag on', false,
        `${c5.error.code}: ${c5.error.message}`);
    } else {
      mentionComment = c5.data.id;
      const m5 = await rep.sb
        .from('comment_mentions')
        .insert({ comment_id: mentionComment, mentioned_user_id: staffTarget.userId });

      check(
        '5. MENTION  a rep CAN tag tenant-scope staff on their own customer record',
        !m5.error,
        m5.error
          ? `${m5.error.code}: ${m5.error.message} — §3.5 and A11 both say this must work`
          : 'allowed — A11 closes Solar comments, it does not close tagging staff',
      );

      // Prove the row PERSISTED, not merely that the call returned no error. Read as the
      // mentioned user, since mentions_select_own is the only way to see it.
      const seen = await staffTarget.sb
        .from('comment_mentions')
        .select('id')
        .eq('comment_id', mentionComment);
      check(
        '5. MENTION  the mention row actually persisted',
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

  // ---------------------------------------------------------------- 6. PICKER SOURCE
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
    '6. PICKER   GET /sf/users includes tenant-scope staff for a sales role (§3.5)',
    picker.status === 200 && staffPresent,
    picker.status !== 200
      ? `HTTP ${picker.status}`
      : `${pickerUsers.length} users returned; the staff target is ${staffPresent ? 'present' : 'MISSING'}` +
        `; ${noAuthId.length} without a Supabase login` +
        (noAuthId.length ? ` (not mentionable, shown greyed: ${noAuthId.map((u) => u.name).join(', ')})` : ''),
  );

  // The rep must reach staff who are NOT in the first handful, since that is precisely
  // what the old cap hid. Counting past the old limit is what makes this a regression
  // test rather than a restatement of check 6.
  const staffIndex = pickerUsers.findIndex((u) => u.supabaseUserId === staffTarget.userId);
  check(
    '6. PICKER   staff are reachable beyond the old 6-name cap',
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
      '\nIf 1-3 failed and 4 passed, the p8 SQL has not been applied yet — that is the\n' +
        'expected before-picture. If 4 failed, fix that FIRST: the other three cannot be\n' +
        'trusted until the control passes.',
    );
    process.exit(1);
  }
  console.log('\nA11 is enforced at the database, on the same path the browser uses.');
}

main().catch((e) => {
  console.error(`\nverify-comment-scope: ${e.message}`);
  process.exit(1);
});
