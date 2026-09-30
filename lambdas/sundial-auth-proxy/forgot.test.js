// node --test lambdas/sundial-auth-proxy/forgot.test.js
//
// POST /auth/forgot (2026-09-22): always the same 200 (no user enumeration), the
// recovery link minted + emailed by us with the token unspent, garbage ignored, the
// per-address limiter, and the Supabase fallback without EMAIL_FROM. Drives the real
// router through createHandler with fakes — no module mocks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, FORGOT_LIMIT } from "./index.js";
import { mintAndSend, DEFAULT_PORTAL_BASE_URL } from "../../lib/auth-email.js";

function world() {
  const ctx = { emails: [], emailConfigured: true, links: [], resets: [], genError: null };
  const supabase = {
    auth: {
      admin: {
        generateLink: async (args) => {
          ctx.links.push(args);
          if (ctx.genError) return { data: null, error: ctx.genError };
          return { data: { user: { id: "U1" }, properties: { hashed_token: "HASH" } }, error: null };
        },
      },
      resetPasswordForEmail: async (email, opts) => (ctx.resets.push({ email, opts }), { data: {}, error: null }),
    },
  };
  const handler = createHandler({
    resolveIdentity: async () => {
      throw Object.assign(new Error("no token"), { code: "AUTH_NO_TOKEN" });
    },
    getSupabaseClient: async () => supabase,
    isEmailConfigured: () => ctx.emailConfigured,
    // The real minting code, with only the SES send swapped out.
    mintAndSend: (sb, args) => mintAndSend(sb, args, { isEmailConfigured: () => ctx.emailConfigured, sendEmail: async (m) => (ctx.emails.push(m), { ok: true, messageId: "m" }) }),
  });
  const post = (body, ip = "1.2.3.4") =>
    handler({ requestContext: { http: { method: "POST" } }, rawPath: "/prod/auth/forgot", headers: { origin: "https://sundial.harmonelectric.net", "x-forwarded-for": ip }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { ctx, handler, post };
}

test("a known address: generateLink(recovery) + our email with the unspent token; always the same 200", async () => {
  const { ctx, post } = world();
  const r = await post({ email: " Dana@Example.com " });
  assert.equal(r.statusCode, 200);
  assert.match(JSON.parse(r.body).message, /If that address has a Sundial account/);
  assert.deepEqual(ctx.links[0], { type: "recovery", email: "dana@example.com", options: { redirectTo: "https://sundial.harmonelectric.net/reset-password" } });
  assert.equal(ctx.emails.length, 1);
  assert.equal(ctx.emails[0].to, "dana@example.com");
  assert.equal(ctx.emails[0].subject, "Reset your Sundial password");
  assert.ok(ctx.emails[0].text.includes("/reset-password?token_hash=HASH&type=recovery"));
  assert.ok(!/auth\/v1\/verify/.test(ctx.emails[0].html));
  assert.equal(r.headers["Access-Control-Allow-Origin"], "https://sundial.harmonelectric.net");
});

test("an unknown address gets the SAME 200 and no email; garbage is ignored", async () => {
  const { ctx, post } = world();
  ctx.genError = { message: "User not found", status: 404 };
  const r = await post({ email: "nobody@example.com" });
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).ok, true);
  assert.equal(ctx.emails.length, 0);
  ctx.genError = null;
  for (const body of [{}, { email: "not-an-email" }, { email: 42 }, "{oops"]) {
    const g = await post(body);
    assert.equal(g.statusCode, 200);
  }
  assert.equal(ctx.emails.length, 0);
  assert.equal(ctx.links.length, 1, "no Supabase call for garbage");
});

test("the per-address limiter: beyond the hourly allowance nothing is sent, still 200", async () => {
  const { ctx, post } = world();
  for (let i = 0; i < FORGOT_LIMIT.perKey + 2; i += 1) await post({ email: "burst@example.com" }, `9.9.9.${i}`);
  assert.equal(ctx.emails.length, FORGOT_LIMIT.perKey);
});

test("without EMAIL_FROM: Supabase's own reset email, still 200", async () => {
  const { ctx, post } = world();
  ctx.emailConfigured = false;
  const r = await post({ email: "fallback@example.com" });
  assert.equal(r.statusCode, 200);
  assert.equal(ctx.emails.length, 0);
  assert.deepEqual(ctx.resets[0], { email: "fallback@example.com", opts: { redirectTo: "https://sundial.harmonelectric.net/reset-password" } });
});

test("GET /auth/me is untouched by the new route (still needs a token); OPTIONS advertises POST", async () => {
  const { handler } = world();
  const r = await handler({ requestContext: { http: { method: "GET" } }, rawPath: "/auth/me", headers: {} });
  assert.equal(r.statusCode, 401);
  const o = await handler({ requestContext: { http: { method: "OPTIONS" } }, rawPath: "/auth/forgot", headers: {} });
  assert.equal(o.statusCode, 204);
  assert.match(o.headers["Access-Control-Allow-Methods"], /POST/);
});

// ===========================================================================
// D-078 — which portal the reset link opens, and tenant.slug on /auth/me
// ===========================================================================

const PRIMARY_PORTAL = "https://sundial.harmonelectric.net";
const DEMO_PORTAL = "https://demo.constructiveops.example";
const UID = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
const SAME_200 = { ok: true, message: "If that address has a Sundial account, a reset link is on its way." };

let nextIp = 0;
/** A world where the login's tenant can be looked up: Salesforce + the brand secret are fakes that record every read. */
function tenantWorld({ slug = "conops-demo", userRows } = {}) {
  const ctx = { emails: [], emailConfigured: true, links: [], resets: [], soql: [], secretReads: [], sfError: null, sfFailures: 0 };
  const supabase = {
    auth: {
      admin: {
        generateLink: async (args) => (ctx.links.push(args), { data: { user: { id: UID }, properties: { hashed_token: "HASH" } }, error: null }),
      },
      resetPasswordForEmail: async (email, opts) => (ctx.resets.push({ email, opts }), { data: {}, error: null }),
    },
  };
  const handler = createHandler({
    resolveIdentity: async () => {
      throw Object.assign(new Error("no token"), { code: "AUTH_NO_TOKEN" });
    },
    getSupabaseClient: async () => supabase,
    isEmailConfigured: () => ctx.emailConfigured,
    mintAndSend: (sb, args) => mintAndSend(sb, args, { isEmailConfigured: () => ctx.emailConfigured, sendEmail: async (m) => (ctx.emails.push(m), { ok: true, messageId: "m" }) }),
    sfQuery: async (soql) => {
      ctx.soql.push(soql);
      if (ctx.sfError) throw new Error(ctx.sfError);
      if (ctx.sfFailures > 0) {
        ctx.sfFailures -= 1;
        throw new Error("Salesforce hiccup");
      }
      return userRows ?? (slug ? [{ Id: "a1O000000000USER01", Client__r: { Name: slug } }] : []);
    },
    getSecret: async (name) => {
      ctx.secretReads.push(name);
      return { harmon: { companyName: "Harmon Service" }, "conops-demo": { portalUrl: `${DEMO_PORTAL}/` }, "no-portal": { companyName: "No Portal Co" } };
    },
  });
  // A fresh address per request: the route's per-IP limiter is module-wide, across worlds.
  const post = (email, origin) =>
    handler({
      requestContext: { http: { method: "POST" } },
      rawPath: "/prod/auth/forgot",
      headers: { ...(origin ? { origin } : {}), "x-forwarded-for": `10.0.${Math.floor(nextIp / 250)}.${(nextIp += 1) % 250}` },
      body: JSON.stringify({ email }),
    });
  return { ctx, handler, post };
}

test("D-078: from the PRIMARY tenant's portal nothing changed — same link, no Salesforce read, no secret read", async () => {
  const { ctx, post } = tenantWorld();
  const r = await post("dana@example.com", PRIMARY_PORTAL);
  assert.deepEqual(JSON.parse(r.body), SAME_200);
  assert.deepEqual(ctx.links[0], { type: "recovery", email: "dana@example.com", options: { redirectTo: `${PRIMARY_PORTAL}/reset-password` } });
  assert.ok(ctx.emails[0].text.includes(`${PRIMARY_PORTAL}/reset-password?token_hash=HASH&type=recovery`));
  assert.ok(ctx.emails[0].text.includes(`Sundial · ${PRIMARY_PORTAL}`));
  assert.deepEqual(ctx.soql, [], "no Salesforce query on the primary tenant's path");
  assert.deepEqual(ctx.secretReads, [], "no Secrets Manager read on the primary tenant's path");
  // A trailing slash or different case on the Origin is still the same portal.
  await post("dana2@example.com", "HTTPS://Sundial.HarmonElectric.net/");
  assert.deepEqual(ctx.soql, []);
});

test("D-078: from any other origin the login's tenant is resolved first — a non-primary user is linked to THEIR portal", async () => {
  const { ctx, post } = tenantWorld({ slug: "conops-demo" });
  const r = await post("demo.user@example.com", "https://conops-demo.vercel.app");
  assert.deepEqual(JSON.parse(r.body), SAME_200);
  assert.equal(ctx.soql.length, 1);
  // Deterministic when several records point at one login: an active one first, then the oldest.
  assert.equal(ctx.soql[0], "SELECT Id, Client__r.Name FROM Sundial_User__c WHERE Supabase_User_Id__c = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f' ORDER BY Active__c DESC, CreatedDate ASC LIMIT 1");
  assert.equal(ctx.emails.length, 1);
  assert.ok(ctx.emails[0].text.includes(`${DEMO_PORTAL}/reset-password?token_hash=HASH&type=recovery`), ctx.emails[0].text);
  assert.ok(ctx.emails[0].text.includes(`Sundial · ${DEMO_PORTAL}`));
  assert.ok(!(ctx.emails[0].text + ctx.emails[0].html).includes("harmonelectric"), "never the primary tenant's portal");
});

test("D-078: from any other origin a PRIMARY-tenant user still gets the primary portal's link (their tenant decides, not the page they asked from)", async () => {
  for (const origin of ["https://conops-demo.vercel.app", "http://localhost:5173", undefined]) {
    const { ctx, post } = tenantWorld({ slug: "harmon" });
    await post("dana@example.com", origin);
    assert.equal(ctx.soql.length, 1);
    assert.equal(ctx.emails.length, 1);
    assert.ok(ctx.emails[0].text.includes(`${PRIMARY_PORTAL}/reset-password?token_hash=HASH&type=recovery`));
    assert.deepEqual(ctx.secretReads, [], "the primary tenant's address never comes from the secret");
  }
});

test("D-078: a person POSITIVELY identified as another tenant's user, whose tenant has no portal address → nothing is sent, same 200", async () => {
  const cases = [
    tenantWorld({ slug: "no-portal" }), // the tenant's brand block has no portalUrl
    tenantWorld({ slug: "not-in-the-secret" }), // the tenant has no brand block at all
  ];
  for (const [i, { ctx, post }] of cases.entries()) {
    const r = await post(`no.address.${i}@example.com`, "https://conops-demo.vercel.app");
    assert.equal(r.statusCode, 200);
    assert.deepEqual(JSON.parse(r.body), SAME_200, "the caller learns nothing");
    assert.equal(ctx.emails.length, 0, "never the primary tenant's link for a known non-primary user");
    assert.equal(ctx.resets.length, 0);
  }
});

test("D-078: a login that cannot be placed in another tenant gets the PRIMARY link, exactly as before the rule — no user record, no tenant on the record, no usable id", async () => {
  const cases = [
    tenantWorld({ slug: null }), // a login with no Sundial_User__c
    tenantWorld({ userRows: [{ Id: "a1O000000000USER01", Client__r: null }] }), // a user record with no tenant
    tenantWorld({ userRows: [{ Id: "a1O000000000USER01", Client__r: { Name: "  " } }] }), // …or a blank slug
  ];
  for (const [i, { ctx, post }] of cases.entries()) {
    const r = await post(`unplaced.${i}@example.com`, "https://conops-demo.vercel.app");
    assert.deepEqual(JSON.parse(r.body), SAME_200);
    assert.equal(ctx.soql.length, 1, "a clean empty answer is not retried");
    assert.equal(ctx.emails.length, 1);
    assert.ok(ctx.emails[0].text.includes(`${PRIMARY_PORTAL}/reset-password?token_hash=HASH&type=recovery`), ctx.emails[0].text);
    assert.ok(ctx.emails[0].text.includes(`Sundial · ${PRIMARY_PORTAL}`));
    assert.deepEqual(ctx.secretReads, [], "the primary address never comes from the secret");
  }
  // A login whose id is not a UUID cannot be looked up at all: the primary link, no query.
  // (world() hands back the id "U1".)
  const { ctx, handler } = world();
  await handler({ requestContext: { http: { method: "POST" } }, rawPath: "/prod/auth/forgot", headers: { origin: "https://conops-demo.vercel.app", "x-forwarded-for": "10.9.9.1" }, body: JSON.stringify({ email: "odd.id@example.com" }) });
  assert.equal(ctx.emails.length, 1);
  assert.ok(ctx.emails[0].text.includes(`${PRIMARY_PORTAL}/reset-password?token_hash=HASH&type=recovery`));
});

test("D-078: the tenant lookup is retried ONCE; if Salesforce is still failing the person gets the primary link rather than nothing", async () => {
  // Still down on the retry → the primary link (what this route always sent).
  const down = tenantWorld({ slug: "conops-demo" });
  down.ctx.sfError = "Salesforce is down";
  let r = await down.post("sf.down@example.com", "https://some-preview.vercel.app");
  assert.deepEqual(JSON.parse(r.body), SAME_200);
  assert.equal(down.ctx.soql.length, 2, "one retry, no more");
  assert.equal(down.ctx.emails.length, 1, "a Salesforce outage never costs the primary tenant its password reset");
  assert.ok(down.ctx.emails[0].text.includes(`${PRIMARY_PORTAL}/reset-password?token_hash=HASH&type=recovery`));
  assert.deepEqual(down.ctx.secretReads, []);

  // A single transient failure: the retry answers, and the person's own tenant decides.
  const flaky = tenantWorld({ slug: "conops-demo" });
  flaky.ctx.sfFailures = 1;
  r = await flaky.post("sf.flaky@example.com", "https://conops-demo.vercel.app");
  assert.deepEqual(JSON.parse(r.body), SAME_200);
  assert.equal(flaky.ctx.soql.length, 2);
  assert.equal(flaky.ctx.emails.length, 1);
  assert.ok(flaky.ctx.emails[0].text.includes(`${DEMO_PORTAL}/reset-password?token_hash=HASH&type=recovery`));
  assert.ok(!(flaky.ctx.emails[0].text + flaky.ctx.emails[0].html).includes("harmonelectric"));
});

test("D-078: the in-code default portal address counts as the primary portal even when PORTAL_BASE_URL says something else", async () => {
  const saved = process.env.PORTAL_BASE_URL;
  process.env.PORTAL_BASE_URL = "https://portal.harmon.example/";
  try {
    // From the in-code default address (any case, trailing slash): no lookup, and the
    // link is the Lambda's configured address — what it sent before D-078.
    for (const origin of [DEFAULT_PORTAL_BASE_URL, "HTTPS://Sundial.HarmonElectric.net/"]) {
      const { ctx, post } = tenantWorld({ slug: "conops-demo" });
      await post(`default.origin.${origin.length}@example.com`, origin);
      assert.deepEqual(ctx.soql, [], "no Salesforce query from the primary tenant's login page");
      assert.deepEqual(ctx.secretReads, []);
      assert.ok(ctx.emails[0].text.includes("https://portal.harmon.example/reset-password?token_hash=HASH&type=recovery"), ctx.emails[0].text);
    }
    // From the configured address itself: the same.
    const own = tenantWorld({ slug: "conops-demo" });
    await own.post("configured.origin@example.com", "https://Portal.Harmon.example");
    assert.deepEqual(own.ctx.soql, []);
    assert.equal(own.ctx.emails.length, 1);
    // Anything else still looks the tenant up. A look-alike host is not the primary portal.
    const other = tenantWorld({ slug: "conops-demo" });
    await other.post("lookalike.origin@example.com", "https://sundial.harmonelectric.net.evil.example");
    assert.equal(other.ctx.soql.length, 1);
    assert.ok(other.ctx.emails[0].text.includes(`${DEMO_PORTAL}/reset-password`));
  } finally {
    if (saved === undefined) delete process.env.PORTAL_BASE_URL;
    else process.env.PORTAL_BASE_URL = saved;
  }
});

test("D-078: without EMAIL_FROM every origin gets Supabase's own reset email with the primary redirect — the degraded mode is unchanged", async () => {
  // A fresh address each time: the per-address limiter is module-wide.
  for (const [i, origin] of [PRIMARY_PORTAL, "https://conops-demo.vercel.app", "http://localhost:5173", undefined].entries()) {
    const w = tenantWorld();
    w.ctx.emailConfigured = false;
    const email = `no.ses.${i}@example.com`;
    const r = await w.post(email, origin);
    assert.deepEqual(JSON.parse(r.body), SAME_200);
    assert.deepEqual(w.ctx.resets, [{ email, opts: { redirectTo: `${PRIMARY_PORTAL}/reset-password` } }], `origin ${origin}`);
    assert.equal(w.ctx.links.length, 0, "no link is minted here in this mode");
    assert.equal(w.ctx.emails.length, 0);
    assert.deepEqual(w.ctx.soql, [], "and no tenant lookup: Supabase's email cannot carry a per-tenant link");
    assert.deepEqual(w.ctx.secretReads, []);
  }
});

test("D-078: GET /auth/me carries tenant.slug next to tenant.clientId — additive, nothing else moved", async () => {
  const upserts = [];
  const identity = {
    user: { id: "a1O7y00000CallerAA", firstName: "Dana", lastName: "Holland", email: "dana@example.com" },
    access: { level: "Admin", scope: "tenant", tenantId: "a1W7y000007AszBEAS" },
    authUserId: UID,
    tenantId: "a1W7y000007AszBEAS",
    tenantSlug: "harmon",
  };
  const make = (id) =>
    createHandler({
      resolveIdentity: async () => id,
      getSupabaseClient: async () => ({ from: () => ({ upsert: async (row) => (upserts.push(row), { error: null }) }) }),
    });
  const me = (h) => h({ requestContext: { http: { method: "GET" } }, rawPath: "/auth/me", headers: { authorization: "Bearer x" } });
  const r = await me(make(identity));
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(body.tenant, { clientId: "a1W7y000007AszBEAS", slug: "harmon" });
  assert.deepEqual(body.user, { ...identity.user, access: identity.access }, "the user block is what it was");
  assert.deepEqual(Object.keys(body), ["user", "tenant"]);
  assert.equal(upserts[0].tenant_id, "a1W7y000007AszBEAS", "the profile still stores the tenant RECORD id");
  // Another tenant reads its own slug; a user with no tenant record reads null.
  assert.deepEqual(JSON.parse((await me(make({ ...identity, tenantId: "a1W000000000DEMO01", tenantSlug: "conops-demo" }))).body).tenant, { clientId: "a1W000000000DEMO01", slug: "conops-demo" });
  assert.deepEqual(JSON.parse((await me(make({ ...identity, tenantSlug: undefined }))).body).tenant, { clientId: "a1W7y000007AszBEAS", slug: null });
});
