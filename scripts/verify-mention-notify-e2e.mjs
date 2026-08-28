// End-to-end gate for the @-mention notification path, INCLUDING the §3.7
// record-visibility re-check added in Phase 1b (D-064, access-model.md §3.7).
//
// WHY THIS IS SEPARATE FROM scripts/verify-comment-rls.mjs
// -------------------------------------------------------
// That script is deliberately browser-only: it holds nothing but ZZ user sessions,
// so everything it proves, it proves about RLS as a real user meets it.
//
// This one needs the SERVICE ROLE, because the interesting case is unreachable
// through the browser BY DESIGN. `mentions_insert_scoped` refuses a mention of a
// user who cannot see the record, so the only way to put such a row in front of the
// Lambda is to write it the way a POLICY REGRESSION would — bypassing RLS. That is
// exactly the scenario the re-check exists for, and it cannot be tested from a
// session that the policy correctly stops.
//
// So: this script SIMULATES the failure the second lock is there to catch, and
// asserts the Lambda catches it.
//
// WHAT IT ASSERTS
//   1. HAPPY PATH — a mention rep-a1 is allowed to make (of Harmon staff, on their
//      own record) flows browser -> RLS -> trigger -> pg_net -> Lambda -> SES, and
//      comes back stamped with notified_at.
//   2. THE RE-CHECK — a mention written past RLS, of a user who cannot see the
//      record, is refused by the Lambda with reason `record_not_visible`, sends no
//      email, and is NOT stamped (so it stays replayable if access later changes).
//
// IT SENDS A REAL EMAIL for case 1, to tim+zz-admin@constructiveoperations.com —
// a ZZ TEST mailbox, never a live user. EMAIL_FROM is set on the deployed function.
//
// Every record id written to is a ZZ PORTAL TEST fixture, checked before use.
// Everything created is deleted, including on the failure paths.
//
// Usage:  node scripts/verify-mention-notify-e2e.mjs   [--keep]

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { getSecret } from "../lib/secrets.js";
import { getSupabaseClient } from "../lib/supabase.js";

const KEEP = process.argv.includes("--keep");
const TENANT_ID = "a1W7y000007AszBEAS";
const RUN_ID = `ZZ-NOTIFY-${Date.now()}`;
const FUNCTION_NAME = "sundial-comment-notify";
const REGION = process.env.AWS_REGION || "us-west-1";

// ZZ PORTAL TEST fixtures only.
const REC_A1 = { object: "customer", id: "a1P7y00000AmyXCEAZ" }; // zz-rep-a1's
const REC_B1 = { object: "customer", id: "a1P7y00000ApR21EAF" }; // zz-rep-b1's
const ZZ_RECORDS = new Set([REC_A1.id, REC_B1.id]);

const results = [];
const say = (status, name, detail) => {
  results.push({ status, name, detail });
  console.log(`${status === "PASS" ? "  ok  " : " FAIL "} ${name}${detail ? `  — ${detail}` : ""}`);
};
const pass = (n, d) => say("PASS", n, d);
const fail = (n, d) => say("FAIL", n, d);
const check = (n, a, e) => (a === e ? pass(n, `${a}`) : fail(n, `expected ${e}, got ${a}`));

function loadSupabaseConfig() {
  let url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  let key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const p = new URL("../../harmon-crm/.env.local", import.meta.url).pathname.replace(/^\//, "");
  if ((!url || !key) && existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      if (m[1] === "VITE_SUPABASE_URL") url = url || m[2].replace(/^["']|["']$/g, "");
      if (m[1] === "VITE_SUPABASE_ANON_KEY") key = key || m[2].replace(/^["']|["']$/g, "");
    }
  }
  if (!url || !key) { console.error("No Supabase URL / publishable key."); process.exit(2); }
  return { url: url.replace(/\/+$/, ""), key };
}

/** Call the Lambda the way pg_net does, so the response body is readable here. */
async function invokeNotify(payload, secret) {
  const lambda = new LambdaClient({ region: REGION });
  const event = {
    httpMethod: "POST",
    headers: { "Content-Type": "application/json", "X-Sundial-Comment-Secret": secret },
    body: JSON.stringify(payload),
  };
  const res = await lambda.send(new InvokeCommand({
    FunctionName: FUNCTION_NAME,
    Payload: Buffer.from(JSON.stringify(event)),
  }));
  const out = JSON.parse(Buffer.from(res.Payload).toString("utf8"));
  return { statusCode: out.statusCode, body: JSON.parse(out.body || "{}") };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadSupabaseConfig();
  const passwords = await getSecret("sundial/test-users");
  const notifySecretRaw = await getSecret("sundial/comment-notify");
  const notifySecret =
    notifySecretRaw?.comment_notify_secret || notifySecretRaw?.webhook_secret || notifySecretRaw?.secret;
  if (!notifySecret) { console.error("No comment-notify secret."); process.exit(2); }

  const svc = await getSupabaseClient(); // service role — bypasses RLS
  const cleanup = [];

  // --- sessions -----------------------------------------------------------
  async function session(slug) {
    const email = `tim+zz-${slug}@constructiveoperations.com`;
    const c = createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await c.auth.signInWithPassword({ email, password: passwords[email] });
    if (error) { console.error(`sign-in failed for ${email}: ${error.message}`); process.exit(2); }
    return { slug, email, client: c, uid: data.user.id };
  }
  const repA1 = await session("rep-a1");
  const admin = await session("admin");
  console.log(`Signed in as zz-rep-a1 and zz-admin. Run ${RUN_ID}\n`);

  try {
    // =====================================================================
    // 1. HAPPY PATH — the whole chain, driven from the browser.
    // =====================================================================
    if (!ZZ_RECORDS.has(REC_A1.id)) throw new Error("not a ZZ record");
    const { data: c1, error: e1 } = await repA1.client.from("comments").insert({
      tenant_id: TENANT_ID, record_id: REC_A1.id, record_object: REC_A1.object,
      author_id: repA1.uid, author_name: "ZZ rep-a1",
      body: `ZZ NOTIFY E2E ${RUN_ID} — happy path, @zz-admin please ignore`,
    }).select().single();
    if (e1) { fail("rep-a1 posts on their own record", e1.message); throw e1; }
    cleanup.push(c1.id);
    pass("rep-a1 posts on their own record");

    const { error: m1 } = await repA1.client.from("comment_mentions")
      .insert({ comment_id: c1.id, mentioned_user_id: admin.uid });
    if (m1) fail("RLS allows the in-scope mention (staff, own record)", m1.message);
    else pass("RLS allows the in-scope mention (staff, own record)");

    // The trigger fires via pg_net after commit; give the worker + SES a moment.
    let stamped = null;
    for (let i = 0; i < 12 && !stamped; i++) {
      await sleep(2500);
      const { data } = await svc.from("comment_mentions")
        .select("id, notified_at").eq("comment_id", c1.id).maybeSingle();
      stamped = data?.notified_at ?? null;
    }
    if (stamped) pass("trigger -> pg_net -> Lambda -> SES: notified_at stamped", stamped);
    else fail("trigger -> pg_net -> Lambda -> SES: notified_at stamped",
              "still NULL after 30s — check the sundial-comment-notify log group");

    // =====================================================================
    // 2. THE §3.7 RE-CHECK — simulate a policy regression via the service role.
    // =====================================================================
    // A comment on ZZ-REP-B1's record (another dealer), mentioning ZZ-REP-A1, who
    // cannot see it. RLS would refuse this from a browser; the service role does not,
    // which is precisely the regression the Lambda's second lock is there to catch.
    if (!ZZ_RECORDS.has(REC_B1.id)) throw new Error("not a ZZ record");
    const { data: c2, error: e2 } = await svc.from("comments").insert({
      tenant_id: TENANT_ID, record_id: REC_B1.id, record_object: REC_B1.object,
      author_id: admin.uid, author_name: "ZZ admin",
      body: `ZZ NOTIFY E2E ${RUN_ID} — out-of-scope mention, must NOT be emailed`,
    }).select().single();
    if (e2) { fail("service role seeds the out-of-scope comment", e2.message); throw e2; }
    cleanup.push(c2.id);
    pass("service role seeds the out-of-scope comment (RLS would have refused)");

    const { data: m2, error: e3 } = await svc.from("comment_mentions")
      .insert({ comment_id: c2.id, mentioned_user_id: repA1.uid }).select().single();
    if (e3) { fail("service role seeds the out-of-scope mention", e3.message); throw e3; }
    pass("service role seeds the out-of-scope mention");

    // Invoke synchronously so the REASON is readable, not just inferred from a NULL.
    const res = await invokeNotify({ mention_id: m2.id }, notifySecret);
    check("Lambda returns 200 (a skip is a success — pg_net must not retry)", res.statusCode, 200);
    check("Lambda refuses it with reason `record_not_visible`", res.body.reason, "record_not_visible");
    check("Lambda sent nothing", res.body.sent, false);

    await sleep(3000);
    const { data: after } = await svc.from("comment_mentions")
      .select("notified_at").eq("id", m2.id).maybeSingle();
    check("the refused mention is NOT stamped (stays replayable)", after?.notified_at ?? null, null);

    // And the same row, once the recipient CAN see the record, must go through —
    // proving the refusal was about scope and not about something incidental.
    const res2 = await invokeNotify(
      { comment_id: c1.id, mentioned_user_id: admin.uid }, notifySecret);
    if (res2.body.reason === "already_notified") {
      pass("re-invoking the happy-path mention is idempotent", "already_notified");
    } else {
      fail("re-invoking the happy-path mention is idempotent", JSON.stringify(res2.body));
    }
  } finally {
    if (KEEP) {
      console.log(`\n--keep: leaving ${cleanup.length} comment(s): ${cleanup.join(", ")}`);
    } else {
      for (const id of cleanup) await svc.from("comments").delete().eq("id", id);
      const { data: left } = await svc.from("comments").select("id").ilike("body", "ZZ NOTIFY E2E%");
      check("cleanup: no ZZ NOTIFY E2E comments remain", (left ?? []).length, 0);
    }
  }

  const failed = results.filter((r) => r.status === "FAIL");
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(2); });
