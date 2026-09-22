// lib/auth-email.js — the invite and password-reset emails Sundial sends ITSELF (2026-09-22).
//
// WHY WE SEND THEM. Supabase's own invite / recovery emails carry `{{ .ConfirmationURL }}`,
// which is Supabase's /auth/v1/verify — a GET that SPENDS the one-time token. Corporate
// mail scanners (Microsoft Defender Safe Links, Mimecast, Gmail) prefetch every link
// within minutes of delivery, so the person who clicks afterwards sees "Email link is
// invalid or has expired". The dashboard template can be edited to avoid that, and was —
// and it reverted, silently, because a dashboard setting has no diff.
//
// So the link shape lives here: `auth.admin.generateLink(...)` hands the Lambda the
// UNSPENT token hash (Supabase sends nothing), and the email carries
//   {portal}/reset-password?token_hash=…&type=invite|recovery
// The portal page redeems it only when a person submits a password (verifyOtp on
// submit, harmon-crm ResetPasswordPage.tsx). A scanner can load that page all day.
//
// Used by sundial-user-admin (invites, resends) and sundial-auth-proxy (forgot password).
// Pure builders + one small sender; every caller falls back to Supabase's own email when
// EMAIL_FROM is not set on that Lambda, and says so in its log.

import { isEmailConfigured as realIsEmailConfigured, sendEmail as realSendEmail } from "./email.js";

export const DEFAULT_PORTAL_BASE_URL = "https://sundial.harmonelectric.net";

export function portalBaseUrl(env = process.env) {
  return String(env.PORTAL_BASE_URL || DEFAULT_PORTAL_BASE_URL).replace(/\/+$/, "");
}

/** The unspent-token link the page redeems on submit. type: invite | recovery */
export function authLink(tokenHash, type, base = `${portalBaseUrl()}/reset-password`) {
  return `${base}?token_hash=${encodeURIComponent(tokenHash)}&type=${type === "recovery" ? "recovery" : "invite"}`;
}

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function shell({ hello, lead, email, link, button, footer, portalBase }) {
  const text = [hello, "", `${lead} ${email}.`, "", `${button}:`, link, "", footer, "", `Sundial · ${portalBase}`].join("\n");
  const html = `<div style="font-family:sans-serif;font-size:15px;line-height:1.5;color:#0f172a">
<p>${esc(hello)}</p>
<p>${esc(lead)} <strong>${esc(email)}</strong>.</p>
<p><a href="${esc(link)}" style="display:inline-block;padding:12px 22px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600">${esc(button)}</a></p>
<p style="color:#64748b;font-size:13px">Or paste this into your browser:<br>${esc(link)}</p>
<p style="color:#64748b;font-size:13px">${esc(footer)}</p>
<p style="color:#64748b;font-size:13px">Sundial · <a href="${esc(portalBase)}" style="color:#64748b">${esc(portalBase)}</a></p>
</div>`;
  return { text, html };
}

/** The invite email: plain, one button, the unspent link. Pure — tests pin it. */
export function buildInviteEmail({ firstName, email, link, portalBase = portalBaseUrl(), invitedBy = null }) {
  const hello = firstName ? `Hi ${firstName},` : "Hello,";
  const who = invitedBy ? `${invitedBy} has` : "You have been";
  const body = shell({
    hello,
    lead: `${who} set up a Sundial account for`,
    email,
    link,
    button: "Set my password",
    footer: "This link can only be used once. If you weren't expecting it, you can ignore this email.",
    portalBase,
  });
  return { subject: "You're invited to Sundial", ...body };
}

/** The password-reset email ("Forgot password", or the office re-sending a set-password link). */
export function buildRecoveryEmail({ firstName, email, link, portalBase = portalBaseUrl() }) {
  const hello = firstName ? `Hi ${firstName},` : "Hello,";
  const body = shell({
    hello,
    lead: "We received a request to reset the Sundial password for",
    email,
    link,
    button: "Set a new password",
    footer: "This link can only be used once. If you didn't request a password reset, you can ignore this email — your password won't change.",
    portalBase,
  });
  return { subject: "Reset your Sundial password", ...body };
}

/**
 * Mint an unspent link for `email` and send it ourselves.
 * type: "invite" (creates the auth user if new; re-issues for an un-completed invite)
 *       "recovery" (an existing user)
 * @returns {Promise<{ ok: boolean, sent: boolean, via: "ses"|"none", user: object|null, error?: object, reason?: string }>}
 *   `error` is Supabase's (e.g. already registered / user not found) — the caller decides;
 *   `reason` explains a send that did not happen after the link was minted.
 */
export async function mintAndSend(supabase, { type, email, firstName = null, invitedBy = null, redirectTo }, deps = {}) {
  const isEmailConfigured = deps.isEmailConfigured ?? realIsEmailConfigured;
  const sendEmail = deps.sendEmail ?? realSendEmail;
  const base = redirectTo || `${portalBaseUrl()}/reset-password`;
  const gen = await supabase.auth.admin.generateLink({ type, email, options: { redirectTo: base } });
  if (gen.error) return { ok: false, sent: false, via: "none", user: null, error: gen.error };
  const user = gen.data?.user ?? null;
  const tokenHash = gen.data?.properties?.hashed_token ?? null;
  if (!tokenHash) return { ok: true, sent: false, via: "none", user, reason: "Supabase returned no token hash; nothing was emailed." };
  if (!isEmailConfigured()) return { ok: true, sent: false, via: "none", user, reason: "EMAIL_FROM is not set on this Lambda; nothing was emailed." };
  const link = authLink(tokenHash, type, base);
  const mail = type === "recovery" ? buildRecoveryEmail({ firstName, email, link }) : buildInviteEmail({ firstName, email, link, invitedBy });
  const sent = await sendEmail({ to: email, subject: mail.subject, text: mail.text, html: mail.html });
  if (!sent.ok) return { ok: true, sent: false, via: "none", user, reason: `The email could not be sent: ${sent.error}` };
  return { ok: true, sent: true, via: "ses", user };
}
