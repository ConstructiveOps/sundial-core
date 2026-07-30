// Shared transactional email sender (AWS SES v2).
//
// SCAFFOLD — deliberately NOT wired to any feature yet. Three consumers will import
// sendEmail() from here once SES is live: the Design Request "notify sales manager"
// step (sundial-aurora-push), the @-mention alerts, and (optionally) Supabase Auth
// invite/reset emails.
//
// CONFIG comes only from environment variables (set per-Lambda that actually sends;
// never hardcode addresses or regions here):
//   SES_REGION       - region the SES identity is verified in (default us-west-1)
//   EMAIL_FROM       - verified From, e.g. "Sundial <no-reply@mail.constructiveoperations.com>"
//   EMAIL_REPLY_TO   - optional default Reply-To
//   EMAIL_CONFIG_SET - optional SES configuration set (bounce/complaint tracking)
//
// isEmailConfigured() lets a caller degrade gracefully (e.g. skip the email and log)
// until EMAIL_FROM is set — so features can ship BEFORE SES without a hard dependency.
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
