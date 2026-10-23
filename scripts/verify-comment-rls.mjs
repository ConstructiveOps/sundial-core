// Phase 1b gate: the comments / comment_mentions RLS, exercised as REAL SESSIONS.
//
// docs/access-model.md §5.3 + §8 "Phase 1b", D-064 amendment A5.
//
// WHY THIS SCRIPT EXISTS ALONGSIDE THE SQL FILE'S VERIFICATION QUERIES
// -------------------------------------------------------------------
// sql/sundial_access_p1b_comment_rls.sql ends with V1–V13. V1–V9 run as `postgres`
// or through the service role, and BOTH BYPASS RLS — they prove the helper
// functions compute the right answers and that the catalog holds the right
// policies. They cannot prove a policy is ATTACHED AND EFFECTIVE, because nothing
// they run is subject to one. V10–V13 can, but they need `set role`, which only
// Tim can do in the SQL editor.
//
// This script is the other half: it signs in over the real auth endpoint, holds a
// real user JWT, and issues the SAME PostgREST and Realtime calls the browser
// issues. If the policies are missing, mis-attached, or wider than intended, it is
// this script that notices.
//
//   THE RULE THIS SCRIPT KEEPS (CLAUDE.md, both repos):
//   Never log in as, re-level, or reassign the records of a REAL user to test
//   visibility. Every credential comes from Secrets Manager `sundial/test-users`
//   and belongs to a ZZ TEST account from scripts/seed-access-test-fixtures.mjs.
//
// IT WRITES. Comments and mentions are created and then deleted. Every write target
// is checked against ZZ_RECORDS below before the request is made — see assertZz().
// A run that dies half way leaves rows tagged with its RUN_ID; re-running cleans
// them (cleanup deletes by body prefix, not just by this run's ids).
//
// IT ALSO SENDS REAL EMAIL. Every mention this script succeeds in creating fires the
// AFTER INSERT trigger, which posts to sundial-comment-notify, which has EMAIL_FROM
// set — so the three allowed mentions below each deliver a message. All go to ZZ TEST
// mailboxes (tim+zz-admin@, tim+zz-rep-a1@ and, since D-086, tim+zz-exec@ for the
// staff-on-a-private-comment mention), never to a live user, and that is a property of
// the ZZ fixtures rather than of any check here. Deleting the comment afterwards
// cascades the mention away but does not un-send the mail. Expect three messages per
// green run.
//
// D-086 (2026-10-23, sql/sundial_access_p11_comment_privacy.sql): solar threads are
// readable by a rep / dealer through the solar's customer again; private comments, the
// is_private insert rule and set_comment_private() are §4b; the tech user is `tech`
// scope (p10), no longer `none`.
//
// Usage:
//   node scripts/verify-comment-rls.mjs
//   node scripts/verify-comment-rls.mjs --json
//   node scripts/verify-comment-rls.mjs --no-realtime     (skip the websocket leg)
//
// Exit 0 = every check passed. Exit 1 = at least one FAIL. Exit 2 = setup problem.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { getSecret } from "../lib/secrets.js";

const JSON_OUT = process.argv.includes("--json");
const NO_REALTIME = process.argv.includes("--no-realtime");

const TEST_USER_SECRET = "sundial/test-users";
const TENANT_ID = "a1W7y000007AszBEAS"; // Sundial_Tenant__c record id — profiles' vocabulary
const RUN_ID = `ZZ-RLS-${Date.now()}`;
const BODY_PREFIX = "ZZ RLS CHECK"; // cleanup matches on this, across runs

const EMAIL = (slug) => `tim+zz-${slug}@constructiveoperations.com`;

// ---------------------------------------------------------------------------
// The fixtures. EVERY id here is a ZZ PORTAL TEST record; nothing else is ever
// written to. Dealer A = a1X7y00001ASRILEA5, Dealer B = a1X7y00001ARRAkEAP.
// ---------------------------------------------------------------------------
const R = {
  custA1:     { object: "customer", id: "a1P7y00000AmyXCEAZ", owner: "rep-a1", dealer: "A" },
  custA2:     { object: "customer", id: "a1P7y00000ApR0PEAV", owner: "rep-a2", dealer: "A" },
  custB1:     { object: "customer", id: "a1P7y00000ApR21EAF", owner: "rep-b1", dealer: "B" },
  custHarmon: { object: "customer", id: "a1P7y00000ApR3dEAF", owner: "rep-harmon", dealer: "H" },
  solarA1:    { object: "solar",    id: "a1Q7y00000JWmkvEAD", owner: "rep-a1", dealer: "A" },
  solarB1:    { object: "solar",    id: "a1Q7y00000JWmo9EAD", owner: "rep-b1", dealer: "B" },
  roofing:    { object: "roofing",  id: "a1R7y00000yBU9DEAW", owner: null,     dealer: null },
};
const ZZ_RECORDS = new Set(Object.values(R).map((r) => r.id));

/** The guard that keeps CLAUDE.md's rule mechanical rather than aspirational. */
function assertZz(recordId) {
  if (!ZZ_RECORDS.has(recordId)) {
    throw new Error(
      `REFUSING to write to ${recordId} — not a ZZ PORTAL TEST record. ` +
        `Add it to ZZ_RECORDS only if it really is a fixture.`
    );
  }
}

const USERS = [
  "rep-a1", "rep-a2", "mgr-a", "rep-b1", "rep-harmon",
  "rep-nodealer", "rep-inactive-dealer", "tech", "admin", "exec",
];

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
const results = [];
function record(status, name, detail) {
  results.push({ status, name, detail });
  if (!JSON_OUT) {
    const tag = status === "PASS" ? "  ok  " : status === "SKIP" ? " skip " : " FAIL ";
    console.log(`${tag} ${name}${detail ? `  — ${detail}` : ""}`);
  }
}
const pass = (n, d) => record("PASS", n, d);
const fail = (n, d) => record("FAIL", n, d);
const skip = (n, d) => record("SKIP", n, d);

function check(name, actual, expected) {
  if (actual === expected) pass(name, `${actual}`);
  else fail(name, `expected ${expected}, got ${actual}`);
}

/** True when a PostgREST error is an RLS refusal rather than something else. */
function isRlsDenial(error) {
  if (!error) return false;
  return error.code === "42501" || /row-level security/i.test(error.message || "");
}

function checkDenied(name, error) {
  if (isRlsDenial(error)) pass(name, "42501");
  else if (!error) fail(name, "the write SUCCEEDED — this is a leak");
  else fail(name, `wrong error: ${error.code || "?"} ${error.message}`);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
function loadSupabaseConfig() {
  let url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  let key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const envPath = new URL("../../harmon-crm/.env.local", import.meta.url).pathname.replace(/^\//, "");
  if ((!url || !key) && existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      if (m[1] === "VITE_SUPABASE_URL") url = url || m[2].replace(/^["']|["']$/g, "");
      if (m[1] === "VITE_SUPABASE_ANON_KEY") key = key || m[2].replace(/^["']|["']$/g, "");
    }
  }
  if (!url || !key) {
    console.error("Could not resolve the Supabase URL / publishable key (env or ../harmon-crm/.env.local).");
    process.exit(2);
  }
  return { url: url.replace(/\/+$/, ""), key };
}

/**
 * One signed-in supabase-js client per ZZ user — the same class the browser uses,
 * so RLS, PostgREST and Realtime all behave exactly as they do in the portal.
 */
async function signIn(cfg, slug, passwords) {
  const email = EMAIL(slug);
  const password = passwords[email];
  if (!password) return { slug, email, error: `no password for ${email} in ${TEST_USER_SECRET}` };

  const client = createClient(cfg.url, cfg.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data?.user) return { slug, email, error: error?.message || "no user" };
  return { slug, email, client, uid: data.user.id };
}

// ---------------------------------------------------------------------------
// Helpers over the browser's actual queries
// ---------------------------------------------------------------------------

/** Exactly CommentThread.tsx's thread load. */
async function readThread(u, rec) {
  const { data, error } = await u.client
    .from("comments")
    .select("*")
    .eq("record_id", rec.id)
    .eq("record_object", rec.object)
    .order("created_at", { ascending: false });
  return { rows: data ?? [], error };
}

/**
 * Exactly CommentThread.tsx's post, including the .select().single() read-back.
 * `isPrivate` (D-086) is sent only when given, so the default-public path stays the
 * client's original call shape.
 */
async function postComment(u, rec, note, { isPrivate } = {}) {
  assertZz(rec.id);
  const { data, error } = await u.client
    .from("comments")
    .insert({
      tenant_id: TENANT_ID,
      record_id: rec.id,
      record_object: rec.object,
      author_id: u.uid,
      author_name: `ZZ ${u.slug}`,
      body: `${BODY_PREFIX} ${RUN_ID} — ${note}`,
      ...(isPrivate === undefined ? {} : { is_private: isPrivate }),
    })
    .select()
    .single();
  return { row: data, error };
}

/** Exactly CommentThread.tsx's mention persist (no .select(), as in the component). */
async function mention(u, commentId, targetUid) {
  const { error } = await u.client
    .from("comment_mentions")
    .insert({ comment_id: commentId, mentioned_user_id: targetUid });
  return { error };
}

/** Exactly MentionsFeed.tsx's preferred embedded-join query. */
async function mentionsFeed(u) {
  const { data, error } = await u.client
    .from("comment_mentions")
    .select("id, created_at, comment:comments(id, record_id, record_object, author_name, body, created_at)")
    .eq("mentioned_user_id", u.uid)
    .order("created_at", { ascending: false })
    .limit(20);
  return { rows: data ?? [], error };
}

/** Count only the rows THIS run created, so a busy tenant cannot skew a check. */
const mine = (rows) => rows.filter((c) => (c.body || "").includes(RUN_ID));

/** Whether `u` can read one comment by id (0 or 1 rows). */
async function canRead(u, commentId) {
  const { data, error } = await u.client.from("comments").select("id").eq("id", commentId);
  return error ? -1 : (data ?? []).length;
}

/** The one write path for is_private (D-086). Returns the boolean, or the error text. */
async function setPrivate(u, commentId, isPrivate) {
  const { data, error } = await u.client.rpc("set_comment_private", { p_comment_id: commentId, p_private: isPrivate });
  return error ? `error ${error.code || "?"} ${error.message}` : data;
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------
/**
 * Subscribe as `u` to INSERTs (or, with `event`, UPDATEs) on one record, run `trigger`,
 * and report whether an event arrived — and the last delivered `new` row, so a check
 * can read what the event carried (D-086: an UPDATE must carry is_private). Realtime
 * authorizes postgres_changes per subscriber under RLS, so "delivered" and "not
 * delivered" are both policy results — but a websocket that never connects is an
 * environment result, and is reported as SKIP, not FAIL.
 */
async function realtimeProbe(u, rec, trigger, waitMs = 6000, event = "INSERT") {
  const channel = u.client.channel(`zz-rls:${rec.object}:${rec.id}:${Math.random()}`);
  let delivered = false;
  let lastRow = null;

  const subscribed = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10000);
    channel
      .on(
        "postgres_changes",
        { event, schema: "public", table: "comments", filter: `record_id=eq.${rec.id}` },
        (payload) => {
          if ((payload.new?.body || "").includes(RUN_ID)) {
            delivered = true;
            lastRow = payload.new;
          }
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timer);
          resolve(true);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          clearTimeout(timer);
          resolve(false);
        }
      });
  });

  if (!subscribed) {
    await u.client.removeChannel(channel);
    return { subscribed: false, delivered: false };
  }

  await trigger();
  await new Promise((r) => setTimeout(r, waitMs));
  await u.client.removeChannel(channel);
  return { subscribed: true, delivered, lastRow };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const cfg = loadSupabaseConfig();
  const passwords = await getSecret(TEST_USER_SECRET).catch(() => null);
  if (!passwords) {
    console.error(
      `No secret "${TEST_USER_SECRET}". Run: node scripts/seed-access-test-fixtures.mjs --apply`
    );
    process.exit(2);
  }

  const sessions = {};
  for (const slug of USERS) {
    const s = await signIn(cfg, slug, passwords);
    if (s.error) {
      console.error(`Could not sign in ${s.email}: ${s.error}`);
      process.exit(2);
    }
    sessions[slug] = s;
  }
  if (!JSON_OUT) console.log(`Signed in ${USERS.length} ZZ users. Run id ${RUN_ID}\n`);

  const created = []; // { slug, id } — for cleanup
  const track = (slug, row) => { if (row?.id) created.push({ slug, id: row.id }); return row; };

  // =========================================================================
  // 1. SEED — as zz-admin (tenant scope), a comment on every ZZ record.
  // =========================================================================
  const seeded = {};
  for (const [key, rec] of Object.entries(R)) {
    const { row, error } = await postComment(sessions.admin, rec, `seed ${key}`);
    if (error) {
      fail(`seed: admin can comment on ${key}`, `${error.code || "?"} ${error.message}`);
    } else {
      seeded[key] = row;
      track("admin", row);
      pass(`seed: admin can comment on ${key}`);
    }
  }
  // The roofing seed is itself a check: tenant scope must NOT be module-gated
  // (divergence (a) in the SQL header). If it failed above, staff lost roofing threads.

  // =========================================================================
  // 2. READS — a rep sees their own record's thread and nothing else.
  // =========================================================================
  {
    const u = sessions["rep-a1"];
    check("rep-a1 reads comments on their OWN customer",   mine((await readThread(u, R.custA1)).rows).length, 1);
    // D-086: solar is visible through its CUSTOMER (reverses A11 for public comments).
    check("rep-a1 reads comments on their OWN solar (via the customer)", mine((await readThread(u, R.solarA1)).rows).length, 1);
    check("rep-a1 reads 0 on ANOTHER DEALER'S solar",     mine((await readThread(u, R.solarB1)).rows).length, 0);
    check("rep-a1 reads 0 on ANOTHER REP'S customer",      mine((await readThread(u, R.custA2)).rows).length, 0);
    check("rep-a1 reads 0 on ANOTHER DEALER'S customer",   mine((await readThread(u, R.custB1)).rows).length, 0);
    check("rep-a1 reads 0 on a ROOFING record",            mine((await readThread(u, R.roofing)).rows).length, 0);
  }

  // Dealer scope: mgr-a sees both Dealer A reps, never Dealer B.
  {
    const u = sessions["mgr-a"];
    check("mgr-a (dealer) reads rep-a1's customer",        mine((await readThread(u, R.custA1)).rows).length, 1);
    check("mgr-a (dealer) reads rep-a2's customer",        mine((await readThread(u, R.custA2)).rows).length, 1);
    check("mgr-a (dealer) reads Dealer A's solar (D-086)", mine((await readThread(u, R.solarA1)).rows).length, 1);
    check("mgr-a (dealer) reads 0 on Dealer B's solar",    mine((await readThread(u, R.solarB1)).rows).length, 0);
    check("mgr-a (dealer) reads 0 on Dealer B's customer", mine((await readThread(u, R.custB1)).rows).length, 0);
    check("mgr-a (dealer) reads 0 on roofing",             mine((await readThread(u, R.roofing)).rows).length, 0);
  }

  // Tenant scope: everything, roofing included.
  for (const slug of ["admin", "exec"]) {
    const u = sessions[slug];
    let seen = 0;
    for (const rec of Object.values(R)) seen += mine((await readThread(u, rec)).rows).length;
    check(`${slug} (tenant) reads EVERY seeded thread`, seen, Object.keys(R).length);
  }

  // `none` scope: nothing, anywhere.
  for (const slug of ["rep-nodealer", "rep-inactive-dealer"]) {
    const u = sessions[slug];
    let seen = 0;
    for (const rec of Object.values(R)) seen += mine((await readThread(u, rec)).rows).length;
    check(`${slug} (none) reads NOTHING anywhere`, seen, 0);
  }

  // `tech` scope (p10, D-072 am. 7): every customer thread in the tenant, no solar, no
  // roofing. zz-tech is a Technician; this script listed it under `none` until D-086,
  // which was stale from the day p10 was applied.
  {
    const u = sessions.tech;
    let customers = 0;
    let others = 0;
    for (const rec of Object.values(R)) {
      const n = mine((await readThread(u, rec)).rows).length;
      if (rec.object === "customer") customers += n;
      else others += n;
    }
    check("tech reads EVERY seeded customer thread", customers, Object.values(R).filter((r) => r.object === "customer").length);
    check("tech reads 0 on solar / roofing", others, 0);
  }

  // =========================================================================
  // 3. INSERTS
  // =========================================================================
  {
    const u = sessions["rep-a1"];

    const own = await postComment(u, R.custA1, "rep-a1 on own record");
    if (own.error) fail("rep-a1 CAN comment on their own record", `${own.error.code} ${own.error.message}`);
    else { track("rep-a1", own.row); pass("rep-a1 CAN comment on their own record"); }

    checkDenied("rep-a1 CANNOT comment on another rep's record",   (await postComment(u, R.custA2, "should fail")).error);
    checkDenied("rep-a1 CANNOT comment on another dealer's record", (await postComment(u, R.custB1, "should fail")).error);
    checkDenied("rep-a1 CANNOT comment on a roofing record",        (await postComment(u, R.roofing, "should fail")).error);
  }
  checkDenied("rep-nodealer CANNOT comment anywhere", (await postComment(sessions["rep-nodealer"], R.custA1, "should fail")).error);
  {
    const t = await postComment(sessions.tech, R.custA1, "tech on a customer");
    if (t.error) fail("tech CAN comment on a customer (p10)", `${t.error.code} ${t.error.message}`);
    else { track("tech", t.row); pass("tech CAN comment on a customer (p10)"); }
  }
  checkDenied("tech CANNOT comment on a solar record", (await postComment(sessions.tech, R.solarA1, "should fail")).error);

  // A rep cannot forge someone else's authorship even on a record they can see.
  {
    const u = sessions["rep-a1"];
    assertZz(R.custA1.id);
    const { error } = await u.client.from("comments").insert({
      tenant_id: TENANT_ID, record_id: R.custA1.id, record_object: "customer",
      author_id: sessions.admin.uid, author_name: "forged",
      body: `${BODY_PREFIX} ${RUN_ID} — forged author, should fail`,
    });
    checkDenied("rep-a1 CANNOT post as another author", error);
  }

  // =========================================================================
  // 4. MENTIONS — the clause that keeps the notify email inside its scope.
  // =========================================================================
  const carrier = created.find((c) => c.slug === "rep-a1");
  if (!carrier) {
    fail("mentions: no carrier comment", "rep-a1's own-record insert did not succeed");
  } else {
    const u = sessions["rep-a1"];

    // (a) Harmon staff, on rep-a1's own record — ALLOWED. Staff are tenant scope,
    //     so record_visible_for(admin, rep-a1's record) is true.
    const okStaff = await mention(u, carrier.id, sessions.admin.uid);
    if (okStaff.error) fail("rep-a1 CAN mention Harmon staff", `${okStaff.error.code} ${okStaff.error.message}`);
    else pass("rep-a1 CAN mention Harmon staff");

    // (b) Another dealer's rep — DENIED by user_visible().
    checkDenied("rep-a1 CANNOT mention another dealer's rep", (await mention(u, carrier.id, sessions["rep-b1"].uid)).error);

    // (c) SAME-DEALER rep, onto a record that rep cannot see — DENIED by
    //     record_visible_for(). user_visible() PASSES here, so this is the check
    //     that isolates the second clause. It is the most important one in the file.
    checkDenied("nobody can mention a same-dealer rep onto a record THEY cannot see",
      (await mention(u, carrier.id, sessions["rep-a2"].uid)).error);

    // (d) A `none`-scope user can never be mentioned. (Was zz-tech — staff since p10,
    //     and so mentionable on a customer.)
    checkDenied("rep-a1 CANNOT mention a none-scope user", (await mention(u, carrier.id, sessions["rep-nodealer"].uid)).error);
  }

  // (e) Even ADMIN cannot mention a rep onto a record outside that rep's scope.
  //     Tenant scope widens what YOU can see, never what you can send someone.
  if (seeded.custB1) {
    checkDenied("admin CANNOT mention rep-a1 onto another dealer's record",
      (await mention(sessions.admin, seeded.custB1.id, sessions["rep-a1"].uid)).error);
  }

  // (f) A mention rep-a1 SHOULD receive: admin mentions them on their own record.
  if (seeded.custA1) {
    const okIn = await mention(sessions.admin, seeded.custA1.id, sessions["rep-a1"].uid);
    if (okIn.error) fail("admin CAN mention rep-a1 on rep-a1's own record", `${okIn.error.code} ${okIn.error.message}`);
    else pass("admin CAN mention rep-a1 on rep-a1's own record");
  }

  // =========================================================================
  // 4b. PRIVACY (D-086) — staff-only comments on a record a rep CAN see.
  // =========================================================================
  // Every refusal below is on rep-a1's OWN customer, which the reads above prove they
  // can open — so a 0 is about the private flag and nothing else.
  let privateRow = null;
  {
    const { row, error } = await postComment(sessions.admin, R.custA1, "PRIVATE staff note", { isPrivate: true });
    if (error) fail("admin CAN write a PRIVATE comment", `${error.code || "?"} ${error.message}`);
    else { privateRow = track("admin", row); pass("admin CAN write a PRIVATE comment", `is_private=${row.is_private}`); }
  }
  if (privateRow) {
    check("admin reads the private comment",                           await canRead(sessions.admin, privateRow.id), 1);
    check("tech (staff) reads the private comment",                    await canRead(sessions.tech, privateRow.id), 1);
    check("rep-a1 reads 0 of a PRIVATE comment on their own customer", await canRead(sessions["rep-a1"], privateRow.id), 0);
    check("mgr-a (dealer) reads 0 of it",                              await canRead(sessions["mgr-a"], privateRow.id), 0);
    checkDenied("admin CANNOT mention rep-a1 on a PRIVATE comment",
      (await mention(sessions.admin, privateRow.id, sessions["rep-a1"].uid)).error);
    const exec = await mention(sessions.admin, privateRow.id, sessions.exec.uid);
    if (exec.error) fail("admin CAN mention staff on a private comment", `${exec.error.code} ${exec.error.message}`);
    else pass("admin CAN mention staff on a private comment");
  }

  // Only tenant / tech may WRITE a private comment.
  checkDenied("rep-a1 CANNOT insert is_private = true",
    (await postComment(sessions["rep-a1"], R.custA1, "rep private, should fail", { isPrivate: true })).error);
  checkDenied("mgr-a (dealer) CANNOT insert is_private = true",
    (await postComment(sessions["mgr-a"], R.custA1, "dealer private, should fail", { isPrivate: true })).error);

  // The toggle: set_comment_private() is the only write path for is_private.
  if (seeded.custA1) {
    const id = seeded.custA1.id;
    check("rep-a1 set_comment_private on a staff comment returns false", await setPrivate(sessions["rep-a1"], id, true), false);
    check("admin set_comment_private(true) works",                       await setPrivate(sessions.admin, id, true), true);
    check("…and rep-a1 then reads 0 of that comment",                    await canRead(sessions["rep-a1"], id), 0);
    check("admin set_comment_private(false) works",                      await setPrivate(sessions.admin, id, false), true);
    check("…and rep-a1 reads it again",                                  await canRead(sessions["rep-a1"], id), 1);
  }
  if (carrier) {
    // A rep's own words can never be hidden from them, by anybody.
    check("admin CANNOT make rep-a1's own comment private (false)", await setPrivate(sessions.admin, carrier.id, true), false);
    check("rep-a1 still reads their own comment",                   await canRead(sessions["rep-a1"], carrier.id), 1);
  }
  // A plain UPDATE is still refused: there is no UPDATE policy (p1b), RLS filters it to 0 rows.
  if (seeded.custA1) {
    const { data, error } = await sessions.admin.client
      .from("comments").update({ is_private: true }).eq("id", seeded.custA1.id).select();
    if (error && !isRlsDenial(error)) fail("a direct UPDATE of is_private changes nothing (0 rows)", error.message);
    else check("a direct UPDATE of is_private changes nothing (0 rows)", (data ?? []).length, 0);
  }

  // =========================================================================
  // 5. MENTIONS FEED — MentionsFeed.tsx's exact embedded join, both scopes.
  // =========================================================================
  {
    const a1 = await mentionsFeed(sessions["rep-a1"]);
    if (a1.error) fail("MentionsFeed query works for rep-a1", a1.error.message);
    else {
      pass("MentionsFeed query works for rep-a1", `${a1.rows.length} row(s)`);
      const thisRun = a1.rows.filter((r) => (r.comment?.body || "").includes(RUN_ID));
      check("rep-a1's feed shows the mention OF them, with its comment embedded", thisRun.length, 1);
      // "Every row is about them" is asserted below, against the UNFILTERED table —
      // asserting it here would only re-test the .eq() the query already applied.
    }

    const adm = await mentionsFeed(sessions.admin);
    if (adm.error) fail("MentionsFeed query works for a tenant-scope user", adm.error.message);
    else {
      pass("MentionsFeed query works for a tenant-scope user", `${adm.rows.length} row(s)`);
      const embedded = adm.rows.filter((r) => r.comment != null).length;
      check("tenant-scope feed embeds every comment (no silent drops)", embedded, adm.rows.length);
    }
  }

  // A rep must not be able to read the mentions table at large.
  {
    const { data, error } = await sessions["rep-a1"].client
      .from("comment_mentions").select("id, mentioned_user_id");
    if (error) fail("rep-a1 can query comment_mentions at all", error.message);
    else {
      const foreign = (data ?? []).filter((m) => m.mentioned_user_id !== sessions["rep-a1"].uid).length;
      check("rep-a1 sees ONLY mentions of themselves (was: all 14)", foreign, 0);
    }
  }

  // =========================================================================
  // 6. DELETE — own only.
  // =========================================================================
  {
    const u = sessions["rep-a1"];
    const ownRow = created.find((c) => c.slug === "rep-a1");
    if (ownRow) {
      const { data, error } = await u.client.from("comments").delete().eq("id", ownRow.id).select();
      if (error) fail("rep-a1 CAN delete their own comment", error.message);
      else {
        check("rep-a1 CAN delete their own comment", (data ?? []).length, 1);
        const i = created.findIndex((c) => c.id === ownRow.id);
        if (i >= 0) created.splice(i, 1);
      }
    }
    if (seeded.custA1) {
      // Not an error — RLS makes the row invisible to DELETE, so 0 rows change.
      const { data, error } = await u.client.from("comments").delete().eq("id", seeded.custA1.id).select();
      if (error && !isRlsDenial(error)) fail("rep-a1 CANNOT delete someone else's comment", error.message);
      else check("rep-a1 CANNOT delete someone else's comment (0 rows)", (data ?? []).length, 0);
    }
  }

  // =========================================================================
  // 7. REALTIME — postgres_changes honours the same policies.
  // =========================================================================
  if (NO_REALTIME) {
    skip("realtime: delivery respects the new policies", "--no-realtime");
  } else {
    const u = sessions["rep-a1"];

    const off = await realtimeProbe(u, R.custA2, async () => {
      const { row } = await postComment(sessions.admin, R.custA2, "realtime negative");
      track("admin", row);
    });
    if (!off.subscribed) skip("realtime: rep-a1 gets NO event on another rep's record", "channel never subscribed");
    else check("realtime: rep-a1 gets NO event on another rep's record", off.delivered, false);

    const on = await realtimeProbe(u, R.custA1, async () => {
      const { row } = await postComment(sessions.admin, R.custA1, "realtime positive");
      track("admin", row);
    });
    if (!on.subscribed) skip("realtime: rep-a1 DOES get events on their own record", "channel never subscribed");
    else check("realtime: rep-a1 DOES get events on their own record", on.delivered, true);

    // D-086: making a private comment PUBLIC reaches the rep's open thread as an UPDATE
    // carrying the new is_private (replica identity full, p11 step 7).
    if (privateRow) {
      const upd = await realtimeProbe(u, R.custA1, async () => {
        await setPrivate(sessions.admin, privateRow.id, false);
      }, 6000, "UPDATE");
      if (!upd.subscribed) skip("realtime: a comment made public reaches rep-a1 as an UPDATE with is_private=false", "channel never subscribed");
      else check(
        "realtime: a comment made public reaches rep-a1 as an UPDATE with is_private=false",
        upd.delivered && upd.lastRow?.is_private === false,
        true,
      );
    }
  }

  // =========================================================================
  // 8. CLEANUP — every author removes their own rows, then admin sweeps.
  // =========================================================================
  for (const { slug, id } of created) {
    const s = sessions[slug];
    if (s) await s.client.from("comments").delete().eq("id", id);
  }
  // Mentions go with their comment via ON DELETE CASCADE, so nothing to sweep there.
  {
    const { data } = await sessions.admin.client
      .from("comments").select("id, body").ilike("body", `${BODY_PREFIX}%`);
    const left = data ?? [];
    if (left.length > 0) {
      // Belt and braces: admin authored most of them and can delete their own.
      for (const row of left) await sessions.admin.client.from("comments").delete().eq("id", row.id);
    }
    const { data: after } = await sessions.admin.client
      .from("comments").select("id").ilike("body", `${BODY_PREFIX}%`);
    check("cleanup: no ZZ RLS CHECK comments remain", (after ?? []).length, 0);
  }

  // =========================================================================
  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  if (JSON_OUT) {
    console.log(JSON.stringify({ runId: RUN_ID, results, failed: failed.length }, null, 2));
  } else {
    console.log(
      `\n${results.length - failed.length - skipped.length} passed, ` +
        `${failed.length} failed, ${skipped.length} skipped.`
    );
    for (const f of failed) console.log(`  FAIL  ${f.name} — ${f.detail}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(2);
});
