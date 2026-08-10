// Signed-agreement notification email for the Aurora inbound worker.
//
// Mirrors the design-request notification (lambdas/sundial-aurora-push/designRequest.js):
// same env-driven recipients, same best-effort contract — this never throws, and a
// failure here must not block the Salesforce write-back.
//
// Recipients (worker env):
//   DESIGN_REQUEST_NOTIFY_TO  (required to send) — the design manager
//   DESIGN_REQUEST_NOTIFY_CC  (optional) — no Cc header at all when unset

import { sendEmail, isEmailConfigured } from "../../lib/email.js";

const BUSINESS_TIME_ZONE = "America/Phoenix";
const EMPTY = "—";

function cleanStr(v) {
  return v == null ? "" : String(v).trim();
}

function parseRecipients(raw) {
  return cleanStr(raw)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function resolveNotifyRecipients() {
  return {
    to: parseRecipients(process.env.DESIGN_REQUEST_NOTIFY_TO),
    cc: parseRecipients(process.env.DESIGN_REQUEST_NOTIFY_CC),
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(n) {
  if (n === null || n === undefined || n === "") return EMPTY;
  const v = Number(n);
  if (!Number.isFinite(v)) return EMPTY;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function datetimeLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EMPTY;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TIME_ZONE,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

/**
 * Build the "agreement signed" email.
 *
 * @param {object} args
 * @param {object} args.customer     - the Sundial_Customer__c record
 * @param {object} args.event        - { agreement_id, project_id, design_id, received_at }
 * @param {object|null} args.design
 * @param {object|null} args.financing
 * @param {object|null} args.proposal
 * @param {object} args.fields       - the field map written to Salesforce
 * @param {string|null} args.pdfKey  - S3 key the signed PDF landed at (null if it didn't)
 * @param {string[]} args.warnings   - unmappable picklists, 403s, missing fields...
 */
export function buildSignedEmail({
  customer,
  event,
  design,
  financing,
  proposal,
  fields = {},
  pdfKey = null,
  warnings = [],
}) {
  const name =
    [cleanStr(customer?.First_Name__c), cleanStr(customer?.Last_Name__c)]
      .filter(Boolean)
      .join(" ") ||
    cleanStr(customer?.Name) ||
    "Unnamed Customer";

  const cityState = [cleanStr(customer?.City__c), cleanStr(customer?.State__c)]
    .filter(Boolean)
    .join(", ");

  const subject = `Agreement SIGNED — ${name}${cityState ? ` — ${cityState}` : ""}`;

  const sizeKw = fields.Final_System_Size_kW__c;
  const rows = [
    ["Customer", name],
    ["Signed (received)", datetimeLocal(event?.received_at)],
    ["Financing Type", fields.Financing_Type__c || cleanStr(financing?.financing_option) || EMPTY],
    ["Financing Partner", fields.Financing_Partner__c || cleanStr(financing?.financier?.provider) || EMPTY],
    ["System Price", money(financing?.system_price)],
    ["System Size", sizeKw ? `${sizeKw} kW (STC)` : EMPTY],
    ["Panel Count", fields.Final_Panel_Count__c ?? EMPTY],
    ["Year-1 Production", fields.First_Year_kW_Production__c
      ? `${fields.First_Year_kW_Production__c} kWh`
      : EMPTY],
    ["Monthly Payment", money(fields.Monthly_Payment__c)],
    ["Proposal", cleanStr(proposal?.proposal_link) || EMPTY],
    ["Signed PDF", pdfKey ? `s3://sfsolproj/${pdfKey}` : "NOT SAVED — see warnings"],
    ["Customer record", cleanStr(customer?.Id)],
    ["Aurora agreement", cleanStr(event?.agreement_id)],
  ];

  const textRows = rows.map(([l, v]) => `${l}: ${v}`).join("\n");
  const warnBlockText =
    warnings.length > 0
      ? `\n\nNEEDS ATTENTION\n---------------\n${warnings.map((w) => `- ${w}`).join("\n")}\n`
      : "";

  const text =
    `${name} signed their Aurora agreement.\n\n${textRows}\n${warnBlockText}`;

  const htmlRows = rows
    .map(
      ([l, v], i) =>
        `<tr style="background:${i % 2 ? "#fff" : "#f7f7f8"}">` +
        `<td style="padding:6px 10px;color:#555;white-space:nowrap;vertical-align:top;width:38%">${escapeHtml(l)}</td>` +
        `<td style="padding:6px 10px;color:#111;vertical-align:top">${escapeHtml(v)}</td></tr>`
    )
    .join("");

  const warnBlockHtml =
    warnings.length > 0
      ? `<h3 style="margin:24px 0 8px;font:600 14px/1.3 system-ui,sans-serif;color:#8a1c1c">Needs attention</h3>` +
        `<ul style="font:14px/1.5 system-ui,sans-serif;color:#8a1c1c;padding-left:20px">` +
        warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("") +
        `</ul>`
      : "";

  const html =
    `<div style="max-width:680px;margin:0 auto;padding:8px">` +
    `<p style="font:15px/1.5 system-ui,sans-serif;color:#111"><strong>${escapeHtml(name)}</strong> signed their Aurora agreement.</p>` +
    `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font:14px/1.5 system-ui,sans-serif">${htmlRows}</table>` +
    warnBlockHtml +
    `</div>`;

  return { subject, text, html };
}

/**
 * Build the "agreement no longer signed" email.
 *
 * Sent when Aurora CONFIRMS a negative terminal status (canceled / cancel-pending /
 * declined) — including when it lands on a customer already recorded as signed,
 * which is the case a status field alone would let slip past unnoticed.
 *
 * @param {object} args
 * @param {object} args.customer
 * @param {object} args.event            - { agreement_id, received_at }
 * @param {string} args.status           - Aurora's confirmed current status
 * @param {string|null} args.previousStatus - what Sundial had recorded
 */
export function buildCancellationEmail({ customer, event, status, previousStatus }) {
  const name =
    [cleanStr(customer?.First_Name__c), cleanStr(customer?.Last_Name__c)]
      .filter(Boolean)
      .join(" ") ||
    cleanStr(customer?.Name) ||
    "Unnamed Customer";

  const cityState = [cleanStr(customer?.City__c), cleanStr(customer?.State__c)]
    .filter(Boolean)
    .join(", ");

  const wasSigned = String(previousStatus ?? "").toLowerCase() === "signed";
  const label = String(status).toUpperCase();

  // A cancellation AFTER a recorded signature is the one that needs a human today:
  // downstream work (project creation, scheduling, commissions) may already be
  // moving on a contract that no longer exists.
  const subject = wasSigned
    ? `Agreement ${label} AFTER SIGNING — ${name}${cityState ? ` — ${cityState}` : ""}`
    : `Agreement ${label} — ${name}${cityState ? ` — ${cityState}` : ""}`;

  const rows = [
    ["Customer", name],
    ["New status", status],
    ["Previous status in Sundial", previousStatus || EMPTY],
    ["Received", datetimeLocal(event?.received_at)],
    ["Customer record", cleanStr(customer?.Id)],
    ["Aurora agreement", cleanStr(event?.agreement_id)],
  ];

  const lead = wasSigned
    ? `${name}'s agreement was previously recorded as SIGNED in Sundial, and Aurora now reports it as ${status}. ` +
      `This was confirmed directly with Aurora (not inferred from webhook order). ` +
      `Anything already started off the signed contract needs review.`
    : `${name}'s Aurora agreement is now ${status}.`;

  const text =
    `${lead}\n\n` + rows.map(([l, v]) => `${l}: ${v}`).join("\n") + "\n";

  const htmlRows = rows
    .map(
      ([l, v], i) =>
        `<tr style="background:${i % 2 ? "#fff" : "#f7f7f8"}">` +
        `<td style="padding:6px 10px;color:#555;white-space:nowrap;vertical-align:top;width:38%">${escapeHtml(l)}</td>` +
        `<td style="padding:6px 10px;color:#111;vertical-align:top">${escapeHtml(v)}</td></tr>`
    )
    .join("");

  const html =
    `<div style="max-width:680px;margin:0 auto;padding:8px">` +
    `<p style="font:15px/1.5 system-ui,sans-serif;color:${wasSigned ? "#8a1c1c" : "#111"}">${escapeHtml(lead)}</p>` +
    `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font:14px/1.5 system-ui,sans-serif">${htmlRows}</table>` +
    `</div>`;

  return { subject, text, html };
}

/**
 * Send the cancellation notification. Best-effort and never throws, same contract
 * as the signed notification — the status write-back has already happened.
 */
export async function sendCancellationNotification(args) {
  try {
    if (!isEmailConfigured()) {
      console.warn("aurora-inbound: cancellation email skipped — EMAIL_FROM not configured.");
      return { sent: false, reason: "email_not_configured" };
    }
    const { to, cc } = resolveNotifyRecipients();
    if (to.length === 0) {
      console.error(
        "aurora-inbound: cancellation email skipped — DESIGN_REQUEST_NOTIFY_TO is not set on this Lambda."
      );
      return { sent: false, reason: "no_recipient_configured" };
    }
    const { subject, text, html } = buildCancellationEmail(args);
    const msg = { to, subject, text, html };
    if (cc.length > 0) msg.cc = cc;

    const res = await sendEmail(msg);
    if (!res.ok) {
      console.error(`aurora-inbound: cancellation email FAILED — ${res.error}`);
      return { sent: false, reason: res.error };
    }
    return {
      sent: true,
      messageId: res.messageId,
      recipients: { to: to.length, cc: cc.length },
    };
  } catch (e) {
    const reason = e?.message || String(e);
    console.error("aurora-inbound: cancellation email threw:", reason);
    return { sent: false, reason };
  }
}

/**
 * Send the signed notification. ALWAYS best-effort: returns a status object and
 * never throws, because the Salesforce write-back has already happened by the time
 * this runs and must not be undone by an email problem.
 *
 * @returns {Promise<{ sent: boolean, messageId?: string, reason?: string,
 *                     recipients?: { to: number, cc: number } }>}
 */
export async function sendSignedNotification(args) {
  try {
    if (!isEmailConfigured()) {
      console.warn("aurora-inbound: signed email skipped — EMAIL_FROM not configured.");
      return { sent: false, reason: "email_not_configured" };
    }
    const { to, cc } = resolveNotifyRecipients();
    if (to.length === 0) {
      console.error(
        "aurora-inbound: signed email skipped — DESIGN_REQUEST_NOTIFY_TO is not set on this Lambda."
      );
      return { sent: false, reason: "no_recipient_configured" };
    }
    const { subject, text, html } = buildSignedEmail(args);
    const msg = { to, subject, text, html };
    if (cc.length > 0) msg.cc = cc;

    const res = await sendEmail(msg);
    if (!res.ok) {
      console.error(`aurora-inbound: signed email FAILED — ${res.error}`);
      return { sent: false, reason: res.error };
    }
    return {
      sent: true,
      messageId: res.messageId,
      recipients: { to: to.length, cc: cc.length },
    };
  } catch (e) {
    const reason = e?.message || String(e);
    console.error("aurora-inbound: signed email threw:", reason);
    return { sent: false, reason };
  }
}
