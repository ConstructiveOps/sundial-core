// Tests for sundial-comment-notify.
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// The things worth pinning hardest are the ones that decide whether a real person gets
// an email they should not, or misses one they should:
//   - a MISSING preferences row must SEND (absence means alerts on — the whole contract
//     of the no-backfill design)
//   - alerts-off, self-mention and already-notified must NOT send
//   - an unknown record_object must never emit a link that 404s
//   - the shared-secret gate must reject before any work happens

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const SECRET = "comment-notify-secret";
const MENTION_ID = "11111111-1111-4111-8111-111111111111";
const COMMENT_ID = "22222222-2222-4222-8222-222222222222";
const RECIPIENT = "33333333-3333-4333-8333-333333333333";
const AUTHOR = "44444444-4444-4444-8444-444444444444";
const RECORD_ID = "a1P7y00000AUo6TEAT";

// ---------------------------------------------------------------------------
// Mutable context the mocks read from
// ---------------------------------------------------------------------------
const ctx = {
  secret: {},
  rows: {}, // table -> array of rows
  authUsers: {}, // uuid -> { email } | null
  authError: null,
  updates: [], // { table, patch, filters }
  selectErrors: {}, // table -> message (forces a query error)
  sent: [], // messages handed to sendEmail
  sendResult: { ok: true, messageId: "ses-1" },
  emailConfigured: true,
  // The §3.7 record-visibility re-check. `true` is the default because the RLS
  // insert policy has already refused the invisible case by the time we run — the
  // interesting values here are `false` (a policy regression) and an error.
  recordVisible: true,
  rpcError: null,
  rpcCalls: [], // { fn, args }
};

function baseMention(over = {}) {
  return {
    id: MENTION_ID,
    comment_id: COMMENT_ID,
    mentioned_user_id: RECIPIENT,
    notified_at: null,
    ...over,
  };
}

function baseComment(over = {}) {
  return {
    id: COMMENT_ID,
    tenant_id: "harmon",
    record_id: RECORD_ID,
    record_object: "customer",
    author_id: AUTHOR,
    author_name: "Tim Murphy",
    body: "Can you check the roof pitch on this one, @Dana?",
    ...over,
  };
}

function resetCtx() {
  ctx.secret = { comment_notify_secret: SECRET };
  ctx.rows = {
    comment_mentions: [baseMention()],
    comments: [baseComment()],
    user_preferences: [], // NO ROW — the default-on case is the default in these tests
    profiles: [{ id: RECIPIENT, tenant_id: "harmon" }],
    sundial_customer_cache: [{ sf_id: RECORD_ID, customer_name: "HOLLAND, DANA", name: "C-0042" }],
    sundial_solar_cache: [],
    sundial_roofing_cache: [],
  };
  ctx.authUsers = { [RECIPIENT]: { email: "dana@example.com" } };
  ctx.authError = null;
  ctx.updates = [];
  ctx.selectErrors = {};
  ctx.updateError = null;
  ctx.sent = [];
  ctx.sendResult = { ok: true, messageId: "ses-1" };
  ctx.emailConfigured = true;
  ctx.recordVisible = true;
  ctx.rpcError = null;
  ctx.rpcCalls = [];
  delete process.env.COMMENT_NOTIFY_SECRET;
  delete process.env.PORTAL_BASE_URL;
}
resetCtx();

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
mock.module("../../lib/secrets.js", {
  exports: { getSecret: async () => ctx.secret, clearSecretCache: () => {} },
});

mock.module("../../lib/email.js", {
  exports: {
    isEmailConfigured: () => ctx.emailConfigured,
    sendEmail: async (msg) => {
      ctx.sent.push(msg);
      return ctx.sendResult;
    },
  },
});

// A PostgREST-shaped stub over ctx.rows. Filters are applied for real, so a test that
// forgets a filter shows up as the wrong row rather than a passing assertion.
function supabaseStub() {
  return {
    from(table) {
      const rec = { table, op: "select", patch: null, filters: {} };
      const run = () => {
        if (ctx.selectErrors[table] && rec.op === "select") {
          return Promise.resolve({ data: null, error: { message: ctx.selectErrors[table] } });
        }
        if (rec.op === "update") {
          if (ctx.updateError) {
            return Promise.resolve({ data: null, error: { message: ctx.updateError } });
          }
          ctx.updates.push({ table, patch: rec.patch, filters: { ...rec.filters } });
          for (const row of ctx.rows[table] || []) {
            if (Object.entries(rec.filters).every(([k, v]) => row[k] === v)) {
              Object.assign(row, rec.patch);
            }
          }
          return Promise.resolve({ data: null, error: null });
        }
        const match = (ctx.rows[table] || []).filter((row) =>
          Object.entries(rec.filters).every(([k, v]) => row[k] === v)
        );
        return Promise.resolve({ data: match[0] ?? null, error: null });
      };
      const chain = {
        select() {
          return chain;
        },
        update(patch) {
          rec.op = "update";
          rec.patch = patch;
          return chain;
        },
        eq(col, val) {
          rec.filters[col] = val;
          return chain;
        },
        limit() {
          return chain;
        },
        maybeSingle: () => run(),
        then: (resolve, reject) => run().then(resolve, reject),
      };
      return chain;
    },
    // The definer helper from sql/sundial_access_p1b_comment_rls.sql, called
    // through the service role. Records its arguments so a test can assert we
    // asked about the MENTIONED user and the COMMENT'S record, not our own.
    async rpc(fn, args) {
      ctx.rpcCalls.push({ fn, args });
      if (ctx.rpcError) return { data: null, error: { message: ctx.rpcError } };
      return { data: ctx.recordVisible, error: null };
    },
    auth: {
      admin: {
        getUserById: async (id) => {
          if (ctx.authError) return { data: null, error: { message: ctx.authError } };
          const u = ctx.authUsers[id];
          return { data: u ? { user: u } : { user: null }, error: null };
        },
      },
    },
  };
}

mock.module("../../lib/supabase.js", {
  exports: {
    getSupabaseClient: async () => supabaseStub(),
    getSupabaseConfig: async () => ({ url: "https://x.supabase.co", serviceRoleKey: "svc" }),
  },
});

// ---------------------------------------------------------------------------
const content = await import("./content.js");
const { handler } = await import("./index.js");
const { clearConfigCache, DEFAULT_PORTAL_BASE_URL } = await import("./config.js");

function fresh() {
  resetCtx();
  clearConfigCache();
}

const parse = (res) => JSON.parse(res.body);

function hookEvent(body = { mention_id: MENTION_ID }, secret = SECRET) {
  const headers = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Sundial-Comment-Secret"] = secret;
  return { httpMethod: "POST", headers, body: JSON.stringify(body) };
}

// ===========================================================================
// content.js — links (pure)
// ===========================================================================

test("the three known object keys build the documented paths", () => {
  const base = "https://sundial.harmonelectric.net";
  assert.deepEqual(content.recordLink(base, "customer", "a1P"), {
    url: `${base}/customers/a1P`,
    known: true,
  });
  assert.deepEqual(content.recordLink(base, "solar", "a1Q"), {
    url: `${base}/projects/solar/a1Q`,
    known: true,
  });
  assert.deepEqual(content.recordLink(base, "roofing", "a1R"), {
    url: `${base}/projects/roofing/a1R`,
    known: true,
  });
  // Case-insensitive, because record_object is free text in the database.
  assert.equal(content.recordLink(base, "Customer", "a1P").known, true);
});

test("an unknown or missing object key falls back to /dashboard, never a 404 link", () => {
  const base = "https://sundial.harmonelectric.net";
  for (const key of ["service", "commercial", "", null, undefined, "../admin"]) {
    const r = content.recordLink(base, key, "a1P");
    assert.equal(r.known, false, `${key} should be unknown`);
    assert.equal(r.url, `${base}/dashboard`);
  }
  // A known key with no id is also unsafe to link.
  assert.equal(content.recordLink(base, "customer", "").url, `${base}/dashboard`);
});

test("the record label prefers a real name and degrades to object + id", () => {
  assert.equal(content.recordLabel("customer", "a1P", "HOLLAND, DANA"), "HOLLAND, DANA");
  assert.equal(content.recordLabel("customer", "a1P", null), "customer a1P");
  assert.equal(content.recordLabel("customer", "a1P", "   "), "customer a1P");
});

test("the email escapes HTML and keeps the comment text in full", () => {
  const long = "x".repeat(2000);
  const mail = content.buildMentionEmail({
    authorName: "Tim <script>",
    commentBody: `${long} & <b>bold</b>`,
    label: "HOLLAND, DANA",
    url: "https://portal/customers/a1P",
  });
  assert.equal(mail.subject, "Tim <script> mentioned you on HOLLAND, DANA");
  assert.ok(mail.text.includes(long)); // not truncated
  assert.ok(mail.html.includes("&lt;script&gt;"));
  assert.ok(mail.html.includes("&amp;"));
  assert.ok(!mail.html.includes("<b>bold</b>"));
  assert.ok(mail.text.includes("https://portal/customers/a1P"));
});

// ===========================================================================
// Auth gate
// ===========================================================================

test("a missing or wrong shared secret is rejected before any work", async () => {
  fresh();
  assert.equal((await handler(hookEvent({ mention_id: MENTION_ID }, null))).statusCode, 401);
  assert.equal((await handler(hookEvent({ mention_id: MENTION_ID }, "nope"))).statusCode, 401);
  assert.equal((await handler(hookEvent({ mention_id: MENTION_ID }, ""))).statusCode, 401);
  assert.equal(ctx.sent.length, 0);
  assert.equal(ctx.updates.length, 0);
});

test("an unconfigured secret FAILS CLOSED", async () => {
  fresh();
  ctx.secret = {}; // nothing in Secrets Manager, nothing in the env
  clearConfigCache();
  const res = await handler(hookEvent());
  assert.equal(res.statusCode, 401);
  assert.equal(ctx.sent.length, 0);
});

test("the env var is accepted when the secret has no value", async () => {
  fresh();
  ctx.secret = {};
  process.env.COMMENT_NOTIFY_SECRET = "from-env";
  clearConfigCache();
  assert.equal((await handler(hookEvent({ mention_id: MENTION_ID }, "from-env"))).statusCode, 200);
});

test("non-POST is rejected; OPTIONS is a bare 204", async () => {
  fresh();
  assert.equal((await handler({ httpMethod: "OPTIONS", headers: {} })).statusCode, 204);
  assert.equal((await handler({ httpMethod: "GET", headers: {} })).statusCode, 405);
});

test("a malformed body is a 400, and an empty payload names what it needs", async () => {
  fresh();
  assert.equal(
    (await handler({ httpMethod: "POST", headers: { "X-Sundial-Comment-Secret": SECRET }, body: "{oops" }))
      .statusCode,
    400
  );
  const res = await handler(hookEvent({}));
  assert.equal(res.statusCode, 400);
  assert.equal(parse(res).code, "MISSING_FIELDS");
});

// ===========================================================================
// The happy path
// ===========================================================================

test("a mention with no preferences row SENDS — absence means alerts on", async () => {
  fresh();
  assert.equal(ctx.rows.user_preferences.length, 0); // the state every existing user is in
  const res = await handler(hookEvent());
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).sent, true);
  assert.equal(ctx.sent.length, 1);

  const msg = ctx.sent[0];
  assert.equal(msg.to, "dana@example.com");
  // Subject names the record by its cached display name, not its opaque id.
  assert.equal(msg.subject, "Tim Murphy mentioned you on HOLLAND, DANA");
  assert.ok(msg.text.includes("Can you check the roof pitch"));
  assert.ok(msg.text.includes(`${DEFAULT_PORTAL_BASE_URL}/customers/${RECORD_ID}`));
});

test("a successful send stamps notified_at", async () => {
  fresh();
  const res = await handler(hookEvent());
  assert.equal(parse(res).stamped, true);
  assert.equal(ctx.updates.length, 1);
  assert.equal(ctx.updates[0].table, "comment_mentions");
  assert.equal(ctx.updates[0].filters.id, MENTION_ID);
  assert.ok(ctx.updates[0].patch.notified_at);
  // ...and the row really carries it, so a redelivery sees it.
  assert.ok(ctx.rows.comment_mentions[0].notified_at);
});

test("PORTAL_BASE_URL overrides the default and trailing slashes don't double up", async () => {
  fresh();
  process.env.PORTAL_BASE_URL = "https://preview.example.com/";
  clearConfigCache();
  await handler(hookEvent());
  assert.ok(ctx.sent[0].text.includes(`https://preview.example.com/customers/${RECORD_ID}`));
  assert.ok(!ctx.sent[0].text.includes("//customers"));
});

test("a mention can also be addressed by comment_id + mentioned_user_id", async () => {
  fresh();
  const res = await handler(hookEvent({ comment_id: COMMENT_ID, mentioned_user_id: RECIPIENT }));
  assert.equal(parse(res).sent, true);
});

// ===========================================================================
// Skips — each a 200, each sending nothing
// ===========================================================================

test("alerts off skips", async () => {
  fresh();
  ctx.rows.user_preferences = [{ user_id: RECIPIENT, comment_email_alerts: false }];
  const res = await handler(hookEvent());
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).sent, false);
  assert.equal(parse(res).reason, "alerts_disabled");
  assert.equal(ctx.sent.length, 0);
  assert.equal(ctx.updates.length, 0); // NOT stamped — re-enabling must be replayable
});

test("an explicit alerts-on row sends", async () => {
  fresh();
  ctx.rows.user_preferences = [{ user_id: RECIPIENT, comment_email_alerts: true }];
  assert.equal(parse(await handler(hookEvent())).sent, true);
});

test("another user's alerts-off row does not suppress this recipient", async () => {
  fresh();
  ctx.rows.user_preferences = [{ user_id: AUTHOR, comment_email_alerts: false }];
  assert.equal(parse(await handler(hookEvent())).sent, true);
});

test("self-mention skips — never email someone their own words", async () => {
  fresh();
  ctx.rows.comment_mentions = [baseMention({ mentioned_user_id: AUTHOR })];
  ctx.authUsers[AUTHOR] = { email: "tim@example.com" };
  const res = await handler(hookEvent());
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).reason, "self_mention");
  assert.equal(ctx.sent.length, 0);
});

test("already notified returns without re-sending", async () => {
  fresh();
  ctx.rows.comment_mentions = [baseMention({ notified_at: "2026-08-18T12:00:00Z" })];
  const res = await handler(hookEvent());
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).reason, "already_notified");
  assert.equal(ctx.sent.length, 0);
});

test("a redelivery of a just-sent mention is a no-op", async () => {
  fresh();
  assert.equal(parse(await handler(hookEvent())).sent, true);
  const second = parse(await handler(hookEvent()));
  assert.equal(second.sent, false);
  assert.equal(second.reason, "already_notified");
  assert.equal(ctx.sent.length, 1); // still one email
});

test("a recipient with no email address skips", async () => {
  fresh();
  ctx.authUsers = { [RECIPIENT]: { email: null } };
  const res = await handler(hookEvent());
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).reason, "no_recipient_email");
  assert.equal(ctx.sent.length, 0);
});

test("a recipient with no auth user at all skips", async () => {
  fresh();
  ctx.authUsers = {};
  assert.equal(parse(await handler(hookEvent())).reason, "no_recipient_email");
});

test("email_not_configured degrades non-fatally and stays replayable", async () => {
  fresh();
  ctx.emailConfigured = false;
  const res = await handler(hookEvent());
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).sent, false);
  assert.equal(parse(res).reason, "email_not_configured");
  assert.equal(ctx.sent.length, 0);
  // Crucially NOT stamped: once SES lands, a replay must still deliver.
  assert.equal(ctx.updates.length, 0);
  assert.equal(ctx.rows.comment_mentions[0].notified_at, null);
});

test("a cross-tenant mention is refused rather than emailed", async () => {
  fresh();
  ctx.rows.profiles = [{ id: RECIPIENT, tenant_id: "someone-else" }];
  const res = await handler(hookEvent());
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).reason, "cross_tenant");
  assert.equal(ctx.sent.length, 0);
});

test("a recipient with no profile row still gets the alert", async () => {
  fresh();
  ctx.rows.profiles = []; // never hit /auth/me yet
  assert.equal(parse(await handler(hookEvent())).sent, true);
});

// ===========================================================================
// Unknown object key
// ===========================================================================

test("an unknown record_object links to /dashboard and still sends", async () => {
  fresh();
  ctx.rows.comments = [baseComment({ record_object: "service" })];
  const res = await handler(hookEvent());
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).sent, true);
  assert.equal(parse(res).linkKnown, false);
  assert.ok(ctx.sent[0].text.includes(`${DEFAULT_PORTAL_BASE_URL}/dashboard`));
  assert.ok(!ctx.sent[0].text.includes("/service/"));
  // No cached label for an unknown object, so the subject falls back to object + id.
  assert.equal(ctx.sent[0].subject, `Tim Murphy mentioned you on service ${RECORD_ID}`);
});

test("a solar comment links to /projects/solar and uses the solar cache label", async () => {
  fresh();
  ctx.rows.comments = [baseComment({ record_object: "solar", record_id: "a1Q7y00000JDmqHEAT" })];
  ctx.rows.sundial_solar_cache = [
    { sf_id: "a1Q7y00000JDmqHEAT", customer_name_at_creation: "GARCIA, LUIS", project_name: "P-77" },
  ];
  await handler(hookEvent());
  assert.equal(ctx.sent[0].subject, "Tim Murphy mentioned you on GARCIA, LUIS");
  assert.ok(ctx.sent[0].text.includes("/projects/solar/a1Q7y00000JDmqHEAT"));
});

test("a cache miss falls back to object + id without failing the send", async () => {
  fresh();
  ctx.rows.sundial_customer_cache = [];
  await handler(hookEvent());
  assert.equal(ctx.sent[0].subject, `Tim Murphy mentioned you on customer ${RECORD_ID}`);
});

// ===========================================================================
// Faults
// ===========================================================================

test("a missing mention row is a 404, not a silent success", async () => {
  fresh();
  ctx.rows.comment_mentions = [];
  const res = await handler(hookEvent());
  assert.equal(res.statusCode, 404);
  assert.equal(parse(res).code, "MENTION_NOT_FOUND");
});

test("a mention pointing at a deleted comment is a 404", async () => {
  fresh();
  ctx.rows.comments = [];
  const res = await handler(hookEvent());
  assert.equal(res.statusCode, 404);
  assert.equal(parse(res).code, "COMMENT_NOT_FOUND");
});

test("a failed send returns 502 and does NOT stamp, so it stays replayable", async () => {
  fresh();
  ctx.sendResult = { ok: false, error: "Throttling" };
  const res = await handler(hookEvent());
  assert.equal(res.statusCode, 502);
  assert.equal(parse(res).sent, false);
  assert.equal(ctx.updates.length, 0);
  assert.equal(ctx.rows.comment_mentions[0].notified_at, null);
});

test("a preferences read that ERRORS fails open — a blip must not eat an alert", async () => {
  fresh();
  ctx.selectErrors.user_preferences = "connection reset";
  const res = await handler(hookEvent());
  assert.equal(parse(res).sent, true);
});

test("an auth lookup failure is a 502, distinct from 'no email'", async () => {
  fresh();
  ctx.authError = "service unavailable";
  const res = await handler(hookEvent());
  assert.equal(res.statusCode, 502);
  assert.equal(parse(res).code, "AUTH_LOOKUP_FAILED");
  assert.equal(ctx.sent.length, 0);
});

test("a stamp failure after a successful send still reports success", async () => {
  fresh();
  ctx.updateError = "deadlock detected";
  const res = await handler(hookEvent());
  // The email HAS been delivered. Reporting failure would invite a replay and a
  // duplicate, so this is a 200 that names the risk via `stamped: false`.
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).sent, true);
  assert.equal(parse(res).stamped, false);
  assert.equal(ctx.sent.length, 1);
});

// ---------------------------------------------------------------------------
// §3.7 record-visibility re-check (D-064 Phase 1b)
// ---------------------------------------------------------------------------

test("a mention of a user who cannot see the record is refused, and NOT stamped", async () => {
  fresh();
  ctx.recordVisible = false;
  const res = await handler(hookEvent());
  // A skip, not a failure: pg_net must not retry, and the row stays replayable in
  // case the record is later reassigned TO this person.
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).sent, false);
  assert.equal(parse(res).reason, "record_not_visible");
  assert.equal(ctx.sent.length, 0);
  assert.equal(ctx.rows.comment_mentions[0].notified_at, null);
});

test("the visibility check asks about the MENTIONED user and the COMMENT'S record", async () => {
  fresh();
  await handler(hookEvent());
  const call = ctx.rpcCalls.find((c) => c.fn === "record_visible_for");
  assert.ok(call, "record_visible_for was never called");
  // Asking about the author, or about a record id taken from the request body,
  // would make the whole check decorative — these three assertions are the point.
  assert.equal(call.args.p_profile_id, RECIPIENT);
  assert.equal(call.args.p_object, ctx.rows.comments[0].record_object);
  assert.equal(call.args.p_id, ctx.rows.comments[0].record_id);
});

test("a visibility check that ERRORS fails open — the insert policy is the primary control", async () => {
  fresh();
  ctx.rpcError = "function does not exist";
  const res = await handler(hookEvent());
  // Deliberately the same call the preferences read makes: a transient fault is not
  // evidence of a scope violation, and RLS already refused the real one.
  assert.equal(parse(res).sent, true);
  assert.equal(ctx.sent.length, 1);
});

test("A11: a rep mentioned on a SOLAR comment is SKIPPED, not emailed", async () => {
  // D-064 A11: sales-role comments are CUSTOMER-ONLY. This Lambda needs no code
  // change to honour that -- record_visible_for() is the single predicate and the SQL
  // amendment returns false for solar at `own`/`dealer` scope, so the re-check below
  // simply starts answering no.
  //
  // The test exists to PIN that inheritance. The alternative -- assuming it -- is how
  // a Lambda ends up with its own quietly-diverging copy of an authorization rule,
  // which is the exact failure D-064 was written to end.
  //
  // What is at stake if it ever stops inheriting: the notification email carries the
  // COMMENT BODY. A rep who cannot open a solar thread would receive its contents by
  // email, which is a worse leak than the tab being visible.
  fresh();
  ctx.rows.comments[0].record_object = "solar";
  ctx.rows.comments[0].record_id = "a1Q7y00000JWmkvEAD";
  ctx.recordVisible = false; // what the amended RPC now returns for this pair

  const res = await handler(hookEvent());

  assert.equal(res.statusCode, 200, "a skip is not an error -- pg_net must not retry");
  assert.equal(parse(res).sent, false);
  assert.equal(parse(res).reason, "record_not_visible");
  assert.equal(ctx.sent.length, 0, "NO EMAIL -- the body never leaves the Lambda");
  assert.equal(
    ctx.rows.comment_mentions[0].notified_at,
    null,
    "and the row stays replayable, in case the rule or the record changes later"
  );

  // The check must have asked about THIS record, not about some default.
  const call = ctx.rpcCalls.find((c) => c.fn === "record_visible_for");
  assert.ok(call, "record_visible_for was never called");
  assert.equal(call.args.p_object, "solar");
  assert.equal(call.args.p_id, "a1Q7y00000JWmkvEAD");
  assert.equal(call.args.p_profile_id, RECIPIENT);
});

test("A11: the SAME mention on a CUSTOMER comment still sends", async () => {
  // The control. Without it, the test above passes just as happily if the Lambda
  // stopped sending mail altogether.
  fresh();
  ctx.rows.comments[0].record_object = "customer";
  ctx.rows.comments[0].record_id = "a1P7y00000AmyXCEAZ";
  ctx.recordVisible = true;

  const res = await handler(hookEvent());

  assert.equal(parse(res).sent, true);
  assert.equal(ctx.sent.length, 1);
  const call = ctx.rpcCalls.find((c) => c.fn === "record_visible_for");
  assert.equal(call.args.p_object, "customer");
});
