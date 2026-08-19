// Shared transactional email sender (AWS SES v2).
//
// LIVE since 2026-08-19 (docs/integrations/ses-transactional-email.md). Consumers:
// the Design Request notification (sundial-aurora-push), the signed-agreement and
// cancellation notifications (sundial-aurora-inbound), and the @-mention alerts
// (sundial-comment-notify, once deployed).
//
// NOT the path for Supabase Auth invite/reset email. That goes through Supabase
// Custom SMTP → SES (D-046, docs/integrations/auth-email-ses.md) and shares only the
// verified domain with this module. Two independent paths, one identity: changing one
// does not change the other, and a break in one is not evidence about the other.
//
// CONFIG comes only from environment variables (set per-Lambda that actually sends;
// never hardcode addresses or regions here):
//   SES_REGION       - region the SES identity is verified in (default us-west-1)
//   EMAIL_FROM       - verified From. Harmon: "Sundial <no-reply@sundialcrm.com>".
//                      The verified identity is the DOMAIN sundialcrm.com — there is
//                      no mail.constructiveoperations.com identity and one should not
//                      be created; a second domain would split sending reputation.
//   EMAIL_REPLY_TO   - default Reply-To. REQUIRED IN PRACTICE: no mailbox exists
//                      behind no-reply@, so without this a reply bounces. Per-tenant.
//   EMAIL_CONFIG_SET - SES configuration set (bounce/complaint tracking).
//                      Harmon: "sundial-transactional".
//
// Only SendEmail with Content.Simple is ever called, so the execution role needs
// `ses:SendEmail` and NOT `ses:SendRawEmail`. (Harmon's role currently has the broader
// AmazonSESFullAccess — see the runbook.)
//
// isEmailConfigured() lets a caller degrade gracefully (e.g. skip the email and log)
// when EMAIL_FROM is unset — which is how the Design Request path silently reported
// `email_not_configured` for weeks. Keep the degradation; make sure the env var is set.
//
// Value-safety: never log full recipient lists or message bodies.

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const REGION = process.env.SES_REGION || "us-west-1";

// Lazily construct the client so importing this module is free in Lambdas that
// never send (and so a missing SDK/region can't break cold start of unrelated code).
let _client = null;
function client() {
  if (!_client) _client = new SESv2Client({ region: REGION });
  return _client;
}

/** True once a From address is configured — callers should check before sending. */
export function isEmailConfigured() {
  return Boolean(process.env.EMAIL_FROM);
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v];
}

/**
 * Send one transactional email via SES.
 *
 * Best-effort by default (returns { ok:false, error } instead of throwing) so
 * callers can treat email as non-fatal — mirroring the aurora-writeback / supabase-ban
 * philosophy elsewhere in this codebase. Pass { throwOnError:true } to opt into throws.
 *
 * @param {object} msg
 * @param {string|string[]} msg.to        - recipient(s)
 * @param {string}          msg.subject
 * @param {string}         [msg.html]      - HTML body (at least one of html/text)
 * @param {string}         [msg.text]      - plain-text body
 * @param {string}         [msg.from]      - override EMAIL_FROM
 * @param {string}         [msg.replyTo]   - override EMAIL_REPLY_TO
 * @param {string|string[]}[msg.cc]
 * @param {string|string[]}[msg.bcc]
 * @param {{ throwOnError?: boolean }} [opts]
 * @returns {Promise<{ ok: true, messageId: string } | { ok: false, error: string }>}
 */
export async function sendEmail(msg, opts = {}) {
  const from = msg.from || process.env.EMAIL_FROM || "";
  if (!from) {
    const error = "EMAIL_FROM not configured (SES not wired yet).";
    if (opts.throwOnError) throw new Error(error);
    return { ok: false, error };
  }

  const to = asArray(msg.to);
  if (to.length === 0) {
    const error = "sendEmail: at least one recipient is required.";
    if (opts.throwOnError) throw new Error(error);
    return { ok: false, error };
  }
  if (!msg.html && !msg.text) {
    const error = "sendEmail: provide html and/or text body.";
    if (opts.throwOnError) throw new Error(error);
    return { ok: false, error };
  }

  const replyTo = msg.replyTo || process.env.EMAIL_REPLY_TO || null;
  const body = {};
  if (msg.html) body.Html = { Data: msg.html, Charset: "UTF-8" };
  if (msg.text) body.Text = { Data: msg.text, Charset: "UTF-8" };

  const cmd = new SendEmailCommand({
    FromEmailAddress: from,
    Destination: {
      ToAddresses: to,
      CcAddresses: asArray(msg.cc),
      BccAddresses: asArray(msg.bcc),
    },
    ReplyToAddresses: replyTo ? [replyTo] : undefined,
    ConfigurationSetName: process.env.EMAIL_CONFIG_SET || undefined,
    Content: {
      Simple: {
        Subject: { Data: msg.subject || "", Charset: "UTF-8" },
        Body: body,
      },
    },
  });

  try {
    const res = await client().send(cmd);
    return { ok: true, messageId: res.MessageId };
  } catch (e) {
    const error = e?.message || String(e);
    console.error("sendEmail failed:", error);
    if (opts.throwOnError) throw e;
    return { ok: false, error };
  }
}
