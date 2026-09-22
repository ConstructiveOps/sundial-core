// node --test lambdas/sundial-auth-proxy/forgot.test.js
//
// POST /auth/forgot (2026-09-22): always the same 200 (no user enumeration), the
// recovery link minted + emailed by us with the token unspent, garbage ignored, the
// per-address limiter, and the Supabase fallback without EMAIL_FROM. Drives the real
// router through createHandler with fakes — no module mocks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, FORGOT_LIMIT } from "./index.js";
import { mintAndSend } from "../../lib/auth-email.js";

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
