// The daily lead-performance CSV to The Cool Down (D-077).
//
// EventBridge rule `sundial-tcd-daily-report` invokes this Lambda with { "report": "tcd" }
// at cron(0 13 * * ? *) — 13:00 UTC is 6:00 AM in Arizona, which is UTC−7 ALL YEAR
// (Arizona does not observe daylight saving time), so the send time never shifts.
//
// What it sends: every Sundial_Customer__c in the tenant with Lead_Source__c = 'TCD'
// created on or after TCD_REPORT_SINCE (midnight Arizona), newest first, EXCEPT test
// records (Last_Name__c or Name starting "ZZ" — excludeTestRecordsClause) — CUMULATIVE, so
// every morning TCD sees the whole cohort's current state. Live SOQL, not the cache: a
// nightly report where correctness beats API cost (two or three queries).
//
// It sends even when there are no rows (a header-only CSV), so a MISSING email always
// means a failure, never "no leads". `{ "report": "tcd", "dryRun": true }` builds the CSV
// and returns it in the response without sending — the way to check the columns.
//
// Columns whose Salesforce field does not exist (yet) are emitted EMPTY with one warning
// per run; the report never fails over a missing optional field.
//
// Value-safety: logs counts, the filename and field names — never a row or a recipient list.

import { SERVICE_TIMEZONE, TENANT_SF_OBJECT, CUSTOMER_SF_OBJECT } from "./intake.js";

export const SOLAR_SF_OBJECT = "Sundial_Solar__c";
export const DEFAULT_SINCE = "2026-09-29";
export const DEFAULT_TO = "ryan@thecooldown.com";
export const SUBJECT = "Your Daily Report from Harmon Electric";

// Customer fields each column reads. `optional` ones may be absent from the org.
export const COLUMNS = [
  "Email",
  "Lead Received",
  "Contacted Date",
  "Contact Disposition",
  "Appointment Scheduled",
  "Appointment Date",
  "Appointment Disposition",
  "Contract Signed",
  "Contract Signed Date",
  "Installed",
  "Install Date",
];
export const CUSTOMER_FIELDS = [
  "Id",
  "CreatedDate",
  "Primary_Email__c",
  "First_Contact_Date__c",
  "Contact_Disposition__c",
  "Appointment_DateTime__c",
  // "Appointment Disposition": the org's existing Appointment_Outcome__c (Sold / Follow Up
  // Needed / Not Interested / No-Show / Reschedule / Disqualified) — Tim, 2026-09-29, in
  // place of a new Appointment_Disposition__c.
  "Appointment_Outcome__c",
  "Contract_Signed_Date__c",
  "Sold_Date__c",
];
// Install_Complete__c is a DATE (describe, 2026-09-29) — the one install signal used.
// Install_Start/End_DateTime__c are schedule fields: a future start is not an install.
export const SOLAR_FIELDS = ["Sundial_Customer__c", "Install_Complete__c", "CreatedDate"];

// --- dates -----------------------------------------------------------------------

const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: SERVICE_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: SERVICE_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false });

/** A Salesforce datetime -> "YYYY-MM-DD" in Arizona. "" for empty/invalid. */
export function toPhoenixDate(v) {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : dateFmt.format(d);
}

/** A Salesforce datetime -> "YYYY-MM-DD HH:MM" (24-hour) in Arizona. */
export function toPhoenixDateTime(v) {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : `${dateFmt.format(d)} ${timeFmt.format(d)}`;
}

/** A Salesforce DATE field is already "YYYY-MM-DD" — pass through, else "". */
export function dateOnly(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";
}

/** "YYYY-MM-DD" (a day in Arizona) -> the UTC instant of its midnight, for SOQL. */
export function phoenixMidnightUtc(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || "")) throw new Error(`TCD_REPORT_SINCE must be YYYY-MM-DD (got "${ymd}")`);
  // Arizona is a fixed UTC−7 (no DST), so midnight there is 07:00Z the same day.
  return `${ymd}T07:00:00Z`;
}

// --- test records --------------------------------------------------------------------

/**
 * The repo's test convention: a record whose Last_Name__c or Name starts with "ZZ" (the
 * designated test records, the "ZZ TCD TEST" smoke lead) is never a real lead and never
 * goes to TCD. The null guard matters: a lead with no last name must stay in the report.
 * SOQL's LIKE is case-insensitive, so "zz…" is excluded too (no real surname starts "Zz").
 */
export function excludeTestRecordsClause(has = () => true) {
  const parts = [];
  if (has("Last_Name__c")) parts.push(`(Last_Name__c = null OR (NOT Last_Name__c LIKE 'ZZ%'))`);
  parts.push(`(NOT Name LIKE 'ZZ%')`); // Name is standard and never null
  return " AND " + parts.join(" AND ");
}

// --- rows ----------------------------------------------------------------------------

const yesNo = (b) => (b ? "Yes" : "No");

/**
 * One CSV row (array of strings, COLUMNS order) from a customer and its newest Solar
 * project (or null). `has(name)` says whether the field exists in the org.
 */
export function buildRow(c, solar, has = () => true) {
  const get = (n) => (has(n) ? c[n] ?? null : null);
  const signed = dateOnly(get("Contract_Signed_Date__c")) || dateOnly(get("Sold_Date__c"));
  const appt = get("Appointment_DateTime__c");
  const installed = dateOnly(solar?.Install_Complete__c);
  return [
    get("Primary_Email__c") ?? "",
    toPhoenixDate(c.CreatedDate),
    dateOnly(get("First_Contact_Date__c")),
    get("Contact_Disposition__c") ?? "",
    yesNo(Boolean(appt)),
    toPhoenixDateTime(appt),
    get("Appointment_Outcome__c") ?? "",
    yesNo(Boolean(signed)),
    signed,
    yesNo(Boolean(installed)),
    installed,
  ];
}

// --- CSV -----------------------------------------------------------------------------

/**
 * One RFC 4180 cell. Quoted when it holds a comma, quote, CR or LF (quotes doubled).
 * A cell that starts with = + - @ TAB or CR is prefixed with ' so Excel shows it as text
 * instead of running it as a formula — the email column comes from a public web form.
 */
export function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The whole file: UTF-8 BOM (Excel), CRLF line endings, header always present. */
export function buildCsv(rows) {
  const lines = [COLUMNS, ...rows].map((r) => r.map(csvCell).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export function reportFilename(tenantSlug, today) {
  return `${tenantSlug}-tcd-leads-${today}.csv`;
}

// --- email ---------------------------------------------------------------------------

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function buildEmailBody({ since, today }) {
  const para =
    `please see the attached lead performance report for leads from The Cool Down being worked by Harmon Electric. ` +
    `This report covers all leads received since ${since} and reflects their status as of ${today}.`;
  return {
    text: `Hello,\n\n${para}\n\n— Harmon Electric\n`,
    html: `<p>Hello,</p><p>${escHtml(para)}</p><p>— Harmon Electric</p>`,
  };
}

// --- handler -------------------------------------------------------------------------

/**
 * @param {object} d
 *   getLeadConfig(source) -> { tenant }, sfQuery, describeObject, soqlEscapeString,
 *   sendEmail, isEmailConfigured, env, now() -> Date, log / warn
 */
export function createReportHandler(d) {
  const log = d.log || console.log;
  const warn = d.warn || console.warn;
  const now = d.now || (() => new Date());

  return async function runTcdReport({ dryRun = false } = {}) {
    const env = d.env || process.env;
    const since = (env.TCD_REPORT_SINCE || DEFAULT_SINCE).trim();
    const sinceUtc = phoenixMidnightUtc(since);
    const today = toPhoenixDate(now());

    const conf = await d.getLeadConfig("tcd");
    const slug = conf?.tenant;
    if (!slug || !/^[a-z0-9-]{1,40}$/i.test(slug)) throw new Error(`sundial/lead-webhooks has no valid "tcd.tenant"`);
    const esc = d.soqlEscapeString;
    const tenantId = (await d.sfQuery(`SELECT Id FROM ${TENANT_SF_OBJECT} WHERE Name = '${esc(slug)}' LIMIT 1`))?.[0]?.Id;
    if (!tenantId) throw new Error(`Tenant "${slug}" not found`);

    // Describe-guard every column's field: a missing one is an empty column + ONE warning.
    const warnings = [];
    const custNames = new Set(((await d.describeObject(CUSTOMER_SF_OBJECT))?.fields || []).map((f) => f.name));
    const custFields = CUSTOMER_FIELDS.filter((n) => {
      if (custNames.has(n)) return true;
      warnings.push(`${CUSTOMER_SF_OBJECT} has no field ${n} — its column is empty.`);
      return false;
    });
    const has = (n) => custNames.has(n);

    const customers = (await d.sfQuery(
      `SELECT ${custFields.join(", ")} FROM ${CUSTOMER_SF_OBJECT} ` +
        `WHERE Client__c = '${esc(tenantId)}' AND Lead_Source__c = 'TCD' AND CreatedDate >= ${sinceUtc}` +
        excludeTestRecordsClause(has) +
        ` ORDER BY CreatedDate DESC`
    )) || [];

    // Newest Solar project per customer (the ORDER BY makes the first one seen the newest).
    const newestSolar = new Map();
    const ids = customers.map((c) => c.Id);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200).map((id) => `'${esc(id)}'`).join(",");
      const projects = (await d.sfQuery(
        `SELECT ${SOLAR_FIELDS.join(", ")} FROM ${SOLAR_SF_OBJECT} ` +
          `WHERE Client__c = '${esc(tenantId)}' AND Sundial_Customer__c IN (${chunk}) ORDER BY CreatedDate DESC`
      )) || [];
      for (const p of projects) if (!newestSolar.has(p.Sundial_Customer__c)) newestSolar.set(p.Sundial_Customer__c, p);
    }

    const rows = customers.map((c) => buildRow(c, newestSolar.get(c.Id) || null, has));
    const csv = buildCsv(rows);
    const filename = reportFilename(slug, today);
    for (const w of warnings) warn(`tcd-report WARNING: ${w}`);

    if (dryRun) {
      log(`tcd-report: dry run — ${rows.length} row(s), ${filename}, not sent.`);
      return { ok: true, dryRun: true, filename, rows: rows.length, since, today, warnings, csv };
    }

    if (!d.isEmailConfigured()) throw new Error("EMAIL_FROM is not set on this Lambda — the TCD report was NOT sent.");
    const to = (env.TCD_REPORT_TO || DEFAULT_TO).trim();
    const bcc = (env.TCD_REPORT_BCC || "").split(",").map((s) => s.trim()).filter(Boolean);
    const body = buildEmailBody({ since, today });
    const res = await d.sendEmail({
      to, bcc, subject: SUBJECT, text: body.text, html: body.html,
      attachments: [{ fileName: filename, contentType: "text/csv; charset=utf-8", content: Buffer.from(csv, "utf8") }],
    });
    // A failed send must FAIL the invocation (CloudWatch Errors, EventBridge retry):
    // the whole point of sending on zero rows is that silence means something broke.
    if (!res?.ok) throw new Error(`TCD report send failed: ${res?.error || "unknown"}`);
    log(`tcd-report: sent ${filename} — ${rows.length} row(s), bcc ${bcc.length ? "yes" : "no"}, messageId ${res.messageId}.`);
    return { ok: true, sent: true, filename, rows: rows.length, messageId: res.messageId, warnings };
  };
}
