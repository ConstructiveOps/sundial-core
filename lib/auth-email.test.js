// node --test lib/auth-email.test.js — the invite / reset emails Sundial sends itself
// (2026-09-22): the link is OUR page with the UNSPENT token hash, never Supabase's
// /auth/v1/verify (a mail scanner's prefetch would spend it); the copy; and mintAndSend's
// outcomes — sent, not configured, Supabase refused, no hash.

import { test } from "node:test";
import assert from "node:assert/strict";
import { authLink, buildInviteEmail, buildRecoveryEmail, mintAndSend, portalBaseUrl } from "./auth-email.js";

const BASE = "https://sundial.harmonelectric.net/reset-password";

test("authLink: our page, the token unspent, the type on the query string", () => {
  assert.equal(authLink("abc+/=", "invite", BASE), `${BASE}?token_hash=abc%2B%2F%3D&type=invite`);
  assert.equal(authLink("h", "recovery", BASE), `${BASE}?token_hash=h&type=recovery`);
  assert.equal(authLink("h", "anything-else", BASE), `${BASE}?token_hash=h&type=invite`);
  assert.ok(!authLink("h", "invite").includes("auth/v1/verify"));
  assert.equal(portalBaseUrl({ PORTAL_BASE_URL: "https://p.example/" }), "https://p.example");
  assert.equal(portalBaseUrl({}), "https://sundial.harmonelectric.net");
});

test("buildInviteEmail / buildRecoveryEmail: the words, the link in text and (escaped) html, nothing unescaped", () => {
  const link = `${BASE}?token_hash=H&type=invite`;
  const inv = buildInviteEmail({ firstName: "Dana", email: "dana@example.com", link, portalBase: "https://p", invitedBy: "Tim Murphy" });
  assert.equal(inv.subject, "You're invited to Sundial");
  assert.ok(inv.text.startsWith("Hi Dana,"));
  assert.ok(inv.text.includes("Tim Murphy has set up a Sundial account for dana@example.com."));
  assert.ok(inv.text.includes(`Set my password:\n${link}`));
  assert.ok(inv.html.includes('href="https://sundial.harmonelectric.net/reset-password?token_hash=H&amp;type=invite"'));
  const anon = buildInviteEmail({ firstName: null, email: "x@y.z", link, portalBase: "https://p" });
  assert.ok(anon.text.startsWith("Hello,"));
  assert.ok(anon.text.includes("You have been set up a Sundial account for"));
  const rec = buildRecoveryEmail({ firstName: "Bo", email: "bo@example.com", link: `${BASE}?token_hash=R&type=recovery`, portalBase: "https://p" });
  assert.equal(rec.subject, "Reset your Sundial password");
  assert.ok(rec.text.includes("We received a request to reset the Sundial password for bo@example.com."));
  assert.ok(rec.text.includes("your password won't change"));
  assert.ok(rec.html.includes("Set a new password"));
  const evil = buildInviteEmail({ firstName: "<b>x</b>", email: "a@b.c", link, portalBase: "https://p" });
  assert.ok(!evil.html.includes("<b>x</b>"));
});

function fakeSupabase(script) {
  const calls = [];
  return {
    calls,
    auth: { admin: { generateLink: async (args) => (calls.push(args), script(args)) } },
  };
}

test("mintAndSend: sent — generateLink with our redirect, then one SES email carrying the link", async () => {
  const sb = fakeSupabase(() => ({ data: { user: { id: "U1" }, properties: { hashed_token: "HASH" } }, error: null }));
  const emails = [];
  const r = await mintAndSend(sb, { type: "invite", email: "a@b.c", firstName: "A", redirectTo: BASE }, { isEmailConfigured: () => true, sendEmail: async (m) => (emails.push(m), { ok: true, messageId: "m" }) });
  assert.deepEqual(r, { ok: true, sent: true, via: "ses", user: { id: "U1" } });
  assert.deepEqual(sb.calls[0], { type: "invite", email: "a@b.c", options: { redirectTo: BASE } });
  assert.equal(emails[0].to, "a@b.c");
  assert.ok(emails[0].text.includes(`${BASE}?token_hash=HASH&type=invite`));
});

test("mintAndSend: Supabase refused (already registered / unknown user) → ok:false with its error, nothing sent", async () => {
  const sb = fakeSupabase(() => ({ data: null, error: { message: "A user with this email address has already been registered", status: 422 } }));
  const r = await mintAndSend(sb, { type: "invite", email: "a@b.c", redirectTo: BASE }, { isEmailConfigured: () => true, sendEmail: async () => ({ ok: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.sent, false);
  assert.match(r.error.message, /already been registered/);
});

test("mintAndSend: no EMAIL_FROM / no hash / SES failure → the user exists, nothing sent, the reason says why", async () => {
  const ok = () => ({ data: { user: { id: "U1" }, properties: { hashed_token: "HASH" } }, error: null });
  let r = await mintAndSend(fakeSupabase(ok), { type: "recovery", email: "a@b.c", redirectTo: BASE }, { isEmailConfigured: () => false, sendEmail: async () => ({ ok: true }) });
  assert.equal(r.sent, false);
  assert.match(r.reason, /EMAIL_FROM/);
  r = await mintAndSend(fakeSupabase(() => ({ data: { user: { id: "U1" }, properties: {} }, error: null })), { type: "recovery", email: "a@b.c", redirectTo: BASE }, { isEmailConfigured: () => true, sendEmail: async () => ({ ok: true }) });
  assert.match(r.reason, /no token hash/);
  r = await mintAndSend(fakeSupabase(ok), { type: "recovery", email: "a@b.c", redirectTo: BASE }, { isEmailConfigured: () => true, sendEmail: async () => ({ ok: false, error: "SES said no" }) });
  assert.equal(r.ok, true);
  assert.equal(r.sent, false);
  assert.match(r.reason, /SES said no/);
});
