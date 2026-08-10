// Design Request field map + notification email builder (sundial-aurora-push).
//
// WHY THIS FILE EXISTS: the Design Request form on Sundial_Customer__c captures far
// more than Aurora's project-create API accepts. Aurora's documented request surface
// (docs/integrations/aurora-api-reference.md) is:
//
//   POST /tenants/{t}/projects        -> external_provider_id, name, status,
//                                        location.property_address (or lat/lng),
//                                        customer_first_name / _last_name /
//                                        _email / _phone / _salutation
//   PUT  .../consumption_profile      -> monthly_energy[12]
//
// There is NO documented Aurora endpoint that accepts a "design request" (panel SKU,
// inverter SKU, turnaround, financing, offset...) — those live only in Aurora's UI,
// and our API key is not provisioned for any design-ordering surface. So the split is:
//
//   Aurora API  <- customer identity + site address        (index.js builds this)
//               <- the 12 monthly usage values             (consumption profile)
//   EMAIL       <- EVERYTHING, including all 20 Design Request form fields, which
//                  have no Aurora API home at all. The email IS the delivery channel
//                  for that data; the design manager keys it into Aurora by hand.
//
// If Aurora ever provisions a design-request API for us, fields move from the email
// section to the payload here and in index.js — the route contract does not change.
//
// Value-safety: never logs recipients or bodies (lib/email.js holds the same rule).

import { sendEmail, isEmailConfigured } from "../../lib/email.js";

// Harmon is Phoenix, AZ — no DST, so this is stable year-round. Datetimes come back
// from Salesforce in UTC; the design manager reads them in local time.
const DISPLAY_TIME_ZONE = "America/Phoenix";

// Shown when a field is empty. A design manager needs to SEE the blank (an omitted
// row reads as "not asked" rather than "not answered").
const EMPTY = "—";

// Customer identity + site address. These DO go to Aurora as well; they're repeated
// in the email so the manager can match the Aurora project to the request.
export const IDENTITY_FIELDS = [
  { api: "Name", label: "Customer", kind: "text" },
  { api: "First_Name__c", label: "First Name", kind: "text" },
  { api: "Last_Name__c", label: "Last Name", kind: "text" },
  { api: "Primary_Email__c", label: "Email", kind: "text" },
  { api: "Primary_Phone__c", label: "Phone", kind: "text" },
  { api: "Street__c", label: "Street", kind: "text" },
  { api: "City__c", label: "City", kind: "text" },
  { api: "State__c", label: "State", kind: "text" },
  { api: "Postal_Code__c", label: "Postal Code", kind: "text" },
];

// The Design Request form itself. NONE of these are accepted by any Aurora endpoint
// we can call — every one of them reaches Aurora only via this email. Order matches
// the Salesforce page layout so the email reads like the form.
//
// `kind` drives formatting only:
//   text | number | bool | datetime | percent | multipicklist | longtext
export const DESIGN_REQUEST_FIELDS = [
  { api: "Project_Type__c", label: "Project Type", kind: "text" },
  { api: "Existing_Solar_System__c", label: "Existing Solar System", kind: "bool" },
  { api: "Existing_Panel_Count__c", label: "Existing Panel Count", kind: "number" },
  { api: "Design_Turnaround__c", label: "Design Turnaround", kind: "text" },
  { api: "Proposed_Panel_Type__c", label: "Proposed Panel Type", kind: "text" },
  { api: "Inverter_Type__c", label: "Inverter Type", kind: "text" },
  { api: "Battery_Type__c", label: "Battery Type", kind: "text" },
  { api: "Battery_Quantity__c", label: "Battery Quantity", kind: "number" },
  { api: "For_Profit_PPW__c", label: "For-Profit PPW", kind: "text" },
  { api: "Annual_Usage_kWh__c", label: "Annual Usage (kWh)", kind: "number" },
  { api: "Utility_Company__c", label: "Utility Company", kind: "text" },
  { api: "Appointment_DateTime__c", label: "Appointment", kind: "datetime" },
  { api: "Proposed_Panel_Count__c", label: "Proposed Panel Count", kind: "number" },
  { api: "Offset_Requested__c", label: "Offset Requested", kind: "text" },
  { api: "Financing_Type__c", label: "Financing Type", kind: "text" },
  { api: "Financing_Partner__c", label: "Financing Partner", kind: "text" },
  // Term__c is a MULTI-select picklist in the org (verified by describe 2026-08-03):
  // Salesforce returns selections semicolon-joined, e.g. "20yr;25yr".
  { api: "Term__c", label: "Term", kind: "multipicklist" },
  { api: "APR__c", label: "APR", kind: "percent" },
  // NOTE: Design_Notes__c does not exist on Sundial_Customer__c yet (confirmed by
  // describe 2026-08-03). index.js filters this list against the live describe, so
  // the row is simply skipped until the field is created — no SOQL breakage.
  { api: "Design_Notes__c", label: "Design Notes", kind: "longtext" },
];

// Every field name this module wants to read, for index.js's SELECT builder.
export const ALL_EMAIL_FIELD_NAMES = [
  ...IDENTITY_FIELDS,
  ...DESIGN_REQUEST_FIELDS,
].map((f) => f.api);

// --- value formatting ------------------------------------------------------

function cleanStr(v) {
  return v == null ? "" : String(v).trim();
}

/** Format one Salesforce value for display. Always returns a non-empty string. */
export function formatValue(raw, kind) {
  if (raw === null || raw === undefined || raw === "") return EMPTY;

  switch (kind) {
    case "bool":
      return raw === true || raw === "true" ? "Yes" : "No";

    case "number": {
      const n = Number(raw);
      // String(4) is "4", String(4.5) is "4.5" — Salesforce's trailing ".0" on
      // doubles drops out for free.
      return Number.isFinite(n) ? String(n) : cleanStr(raw) || EMPTY;
    }

    case "percent": {
      const n = Number(raw);
      return Number.isFinite(n) ? `${n}%` : cleanStr(raw) || EMPTY;
    }

    case "multipicklist":
      // Salesforce joins multi-select values with ";" and no spaces.
      return (
        cleanStr(raw)
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
          .join(", ") || EMPTY
      );

    case "datetime": {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return cleanStr(raw) || EMPTY;
      try {
        return new Intl.DateTimeFormat("en-US", {
          timeZone: DISPLAY_TIME_ZONE,
          dateStyle: "medium",
          timeStyle: "short",
        }).format(d);
      } catch {
        // No ICU data — fall back to the raw ISO value rather than losing it.
        return d.toISOString();
      }
    }

    default:
      return cleanStr(raw) || EMPTY;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Build [label, value] display rows for a field group, skipping fields the org
// doesn't have (availableFields = lowercased API names present on the describe;
// pass null to skip the filter entirely).
function rowsFor(fields, rec, availableFields) {
  const rows = [];
  for (const f of fields) {
    if (availableFields && !availableFields.has(f.api.toLowerCase())) continue;
    rows.push([f.label, formatValue(rec[f.api], f.kind)]);
  }
  return rows;
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// One compact line for the 12 monthly usage values, e.g. "Jan 950 · Feb 880 · ...".
// These DO go to Aurora (consumption profile); the line is here so the manager can
// confirm at a glance that usage data was supplied. Returns null when there is none.
function monthlyUsageLine(monthlyEnergy) {
  if (!Array.isArray(monthlyEnergy) || monthlyEnergy.length !== 12) return null;
  const parts = [];
  for (let i = 0; i < 12; i++) {
    const v = monthlyEnergy[i];
    if (typeof v === "number" && Number.isFinite(v)) {
      parts.push(`${MONTH_LABELS[i]} ${v}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

// --- email builder ---------------------------------------------------------

/**
 * Build the design-request notification email.
 *
 * @param {object} args
 * @param {object} args.rec              - the Sundial_Customer__c record (fresh read)
 * @param {string} [args.auroraProjectId]- Aurora project id, when one was created
 * @param {string} [args.consumption]    - "sent" | "skipped_no_data" | "failed"
 * @param {Array}  [args.monthlyEnergy]  - the ordered Jan..Dec array sent to Aurora
 * @param {Set<string>} [args.availableFields] - lowercased API names present on the
 *        object's describe; fields not present are omitted from the email
 * @param {string} [args.portalUrl]      - deep link back to the customer record
 * @returns {{ subject: string, text: string, html: string }}
 */
export function buildDesignRequestEmail({
  rec,
  auroraProjectId = "",
  consumption = "",
  monthlyEnergy = null,
  availableFields = null,
  portalUrl = "",
}) {
  const customerName =
    [cleanStr(rec.First_Name__c), cleanStr(rec.Last_Name__c)]
      .filter(Boolean)
      .join(" ") ||
    cleanStr(rec.Name) ||
    "Unnamed Customer";

  const cityState = [cleanStr(rec.City__c), cleanStr(rec.State__c)]
    .filter(Boolean)
    .join(", ");
  const turnaround = cleanStr(rec.Design_Turnaround__c);

  // Turnaround leads the subject because it is the triage signal ("Within 2 Hours"
  // has to jump the queue over "Next Day").
  const subject =
    `Design Request${turnaround ? ` (${turnaround})` : ""} — ${customerName}` +
    (cityState ? ` — ${cityState}` : "");

  const identityRows = rowsFor(IDENTITY_FIELDS, rec, availableFields);
  const designRows = rowsFor(DESIGN_REQUEST_FIELDS, rec, availableFields);

  const usageLine = monthlyUsageLine(monthlyEnergy);
  const auroraRows = [];
  if (auroraProjectId) auroraRows.push(["Aurora Project ID", auroraProjectId]);
  if (consumption) {
    auroraRows.push([
      "Usage pushed to Aurora",
      consumption === "sent"
        ? "Yes"
        : consumption === "skipped_no_data"
          ? "No — no monthly usage on the record"
          : "FAILED — re-send from the portal",
    ]);
  }
  if (usageLine) auroraRows.push(["Monthly Usage (kWh)", usageLine]);
  auroraRows.push(["Salesforce Customer ID", cleanStr(rec.Id)]);

  // --- plain text ---
  const textSection = (title, rows) =>
    rows.length === 0
      ? ""
      : `${title}\n${"-".repeat(title.length)}\n` +
        rows.map(([l, v]) => `${l}: ${v}`).join("\n") +
        "\n\n";

  const text =
    `A Design Request was submitted for ${customerName}.\n\n` +
    textSection("Customer", identityRows) +
    textSection("Design Request", designRows) +
    textSection("Aurora", auroraRows) +
    (portalUrl ? `Open in Sundial: ${portalUrl}\n` : "");

  // --- html ---
  const htmlSection = (title, rows) =>
    rows.length === 0
      ? ""
      : `<h3 style="margin:24px 0 8px;font:600 14px/1.3 system-ui,sans-serif;color:#111">${escapeHtml(
          title
        )}</h3>` +
        `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font:14px/1.5 system-ui,sans-serif">` +
        rows
          .map(
            ([l, v], i) =>
              `<tr style="background:${i % 2 ? "#fff" : "#f7f7f8"}">` +
              `<td style="padding:6px 10px;color:#555;white-space:nowrap;vertical-align:top;width:38%">${escapeHtml(
                l
              )}</td>` +
              `<td style="padding:6px 10px;color:#111;vertical-align:top">${escapeHtml(
                v
              ).replace(/\n/g, "<br>")}</td></tr>`
          )
          .join("") +
        `</table>`;

  const html =
    `<div style="max-width:680px;margin:0 auto;padding:8px">` +
    `<p style="font:15px/1.5 system-ui,sans-serif;color:#111">A Design Request was submitted for <strong>${escapeHtml(
      customerName
    )}</strong>.</p>` +
    htmlSection("Customer", identityRows) +
    htmlSection("Design Request", designRows) +
    htmlSection("Aurora", auroraRows) +
    (portalUrl
      ? `<p style="font:14px/1.5 system-ui,sans-serif;margin-top:20px"><a href="${escapeHtml(
          portalUrl
        )}">Open this customer in Sundial</a></p>`
      : "") +
    `</div>`;

  return { subject, text, html };
}

// --- recipients (env-driven, mirroring lib/email.js's config-by-env pattern) --

// Accept comma- or semicolon-separated lists so one var can hold several people.
function parseRecipients(raw) {
  return cleanStr(raw)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the design-request notification recipients from Lambda env vars.
 *   DESIGN_REQUEST_NOTIFY_TO  (required) — the design manager
 *   DESIGN_REQUEST_NOTIFY_CC  (optional) — the director; omitted entirely if unset
 *
 * @returns {{ to: string[], cc: string[] }}
 */
export function resolveNotifyRecipients() {
  return {
    to: parseRecipients(process.env.DESIGN_REQUEST_NOTIFY_TO),
    cc: parseRecipients(process.env.DESIGN_REQUEST_NOTIFY_CC),
  };
}

/**
 * Build and send the design-request notification. ALWAYS best-effort: it returns a
 * status object and never throws, because the Aurora push has already happened by
 * the time this runs and must not be reported as failed over an email problem.
 *
 * @returns {Promise<{ sent: boolean, messageId?: string, reason?: string,
 *                     recipients?: { to: number, cc: number } }>}
 */
export async function sendDesignRequestNotification(args) {
  try {
    if (!isEmailConfigured()) {
      // Expected until SES env config lands on this Lambda — log, don't fail.
      console.warn("design-request email skipped: EMAIL_FROM not configured.");
      return { sent: false, reason: "email_not_configured" };
    }

    const { to, cc } = resolveNotifyRecipients();
    if (to.length === 0) {
      console.error(
        "design-request email skipped: DESIGN_REQUEST_NOTIFY_TO is not set on this Lambda."
      );
      return { sent: false, reason: "no_recipient_configured" };
    }

    const { subject, text, html } = buildDesignRequestEmail(args);

    // cc is omitted entirely when DESIGN_REQUEST_NOTIFY_CC is unset — SES gets no
    // empty Cc header.
    const msg = { to, subject, text, html };
    if (cc.length > 0) msg.cc = cc;

    const res = await sendEmail(msg);
    if (!res.ok) return { sent: false, reason: res.error };
    return {
      sent: true,
      messageId: res.messageId,
      recipients: { to: to.length, cc: cc.length },
    };
  } catch (e) {
    const reason = e?.message || String(e);
    console.error("design-request email threw:", reason);
    return { sent: false, reason };
  }
}
