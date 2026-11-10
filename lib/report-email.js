// lib/report-email.js — the email a scheduled report goes out in (D-091, Reporting R3). PURE.
// lambdas/sundial-reports/deliver.js sends what this builds through lib/email.js.
//
//   Subject  "<report name> — Nov 10, 2026"   (the ARIZONA date of the delivery)
//   Body     who scheduled it, "data as of", the row count (and a note when the file was cut at
//            the export limit), the file — attached, or a link that works for 7 days — and, for
//            a GROUPED report, its table (the first BODY_ROWS groups). A link to the report in
//            the portal when the tenant has a portal address.
// Every value that reaches the HTML is escaped; links are words, never a bare URL (the
// plain-text part carries the addresses, as the photo-report email does).

import { arizonaDateTime } from "./report-csv.js";
import { failureWords } from "./report-schedule.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** "2026-11-10" → "Nov 10, 2026". */
export function longDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : String(ymd ?? "");
}

/** A timestamptz → "Nov 10, 2026, 7:05 AM" in Arizona; null → null. */
export function arizonaStamp(v) {
  if (!v) return null;
  const s = arizonaDateTime(v); // "YYYY-MM-DD HH:MM"
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(s);
  if (!m) return s;
  const h = Number(m[2]);
  return `${longDate(m[1])}, ${((h + 11) % 12) + 1}:${m[3]} ${h < 12 ? "AM" : "PM"}`;
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** One table cell's text, by the output column's type / format. */
export function cellDisplay(value, col) {
  if (value === null || value === undefined || value === "") return "";
  switch (col?.type) {
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) return String(value);
      if (col.format === "currency") return money.format(n);
      if (col.format === "percent") return `${plain.format(n)}%`;
      return plain.format(n);
    }
    case "boolean":
      return value === true || value === "true" ? "Yes" : value === false || value === "false" ? "No" : String(value);
    case "datetime":
      return arizonaStamp(value) ?? "";
    case "date":
      return longDate(value);
    default:
      return String(value);
  }
}

const P = 'style="margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937"';
const SMALL = 'style="margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b7280"';
const A = 'style="color:#b45309;font-weight:bold"';

function tableHtml(output, rows) {
  const th = output.map((o) => `<th style="text-align:${o.type === "number" ? "right" : "left"};padding:6px 10px;border-bottom:2px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;font-size:13px">${escapeHtml(o.label)}</th>`).join("");
  const trs = rows.map((r) => `<tr>${output.map((o, i) => `<td style="text-align:${o.type === "number" ? "right" : "left"};padding:5px 10px;border-bottom:1px solid #f3f4f6;font-family:Arial,Helvetica,sans-serif;font-size:13px">${escapeHtml(cellDisplay(r[i], o))}</td>`).join("")}</tr>`).join("");
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px 0"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

function tableText(output, rows) {
  return rows.map((r) => output.map((o, i) => `${o.label}: ${cellDisplay(r[i], o) || "—"}`).join(" | ")).join("\n");
}

/**
 * The delivery email.
 * @param {object} a
 *   reportName, runDate ("YYYY-MM-DD", Arizona), ownerName, asOf (timestamptz | null),
 *   rowCount, truncated, fileName,
 *   attached (bool) | downloadUrl + expiresAt (when not attached),
 *   reportUrl (the report's portal page, or null),
 *   table: { output, rows, more } | null   (a grouped report's first rows)
 * @returns {{ subject, html, text }}
 */
export function buildDeliveryEmail(a) {
  const subject = `${a.reportName} — ${longDate(a.runDate)}`;
  const rows = Number(a.rowCount ?? 0);
  const count = `${plain.format(rows)} row${rows === 1 ? "" : "s"}${a.truncated ? " (the export limit — the report matched more)" : ""}`;
  const asOf = arizonaStamp(a.asOf);
  const who = a.ownerName ? `${a.ownerName} scheduled this report to be sent to you.` : "This report was scheduled to be sent to you.";
  const fileLine = a.attached
    ? `The file is attached (${a.fileName}).`
    : null;
  const expires = a.expiresAt ? arizonaStamp(a.expiresAt) : null;

  const html = [
    `<p ${P}><strong>${escapeHtml(a.reportName)}</strong></p>`,
    `<p ${P}>${escapeHtml(who)}</p>`,
    `<p ${P}>${escapeHtml(count)}${asOf ? ` · data as of ${escapeHtml(asOf)}` : ""}</p>`,
    a.table && a.table.rows?.length ? tableHtml(a.table.output, a.table.rows) : "",
    a.table && a.table.more ? `<p ${SMALL}>Showing the first ${a.table.rows.length} rows — the file has them all.</p>` : "",
    fileLine ? `<p ${P}>${escapeHtml(fileLine)}</p>` : "",
    !a.attached && a.downloadUrl
      ? `<p ${P}><a href="${escapeHtml(a.downloadUrl)}" ${A}>Download the report (CSV)</a>${expires ? ` — the link works until ${escapeHtml(expires)}` : ""}.</p>`
      : "",
    a.reportUrl ? `<p ${P}><a href="${escapeHtml(a.reportUrl)}" ${A}>Open the report in Sundial</a></p>` : "",
    `<p ${SMALL}>Times are Arizona time. To stop receiving this report, ask ${escapeHtml(a.ownerName || "its owner")}.</p>`,
  ].join("");

  const text = [
    a.reportName,
    "",
    who,
    `${count}${asOf ? ` · data as of ${asOf}` : ""}`,
    a.table && a.table.rows?.length ? `\n${tableText(a.table.output, a.table.rows)}${a.table.more ? `\n(the first ${a.table.rows.length} rows — the file has them all)` : ""}\n` : "",
    fileLine ?? "",
    !a.attached && a.downloadUrl ? `Download the report (CSV): ${a.downloadUrl}${expires ? ` (works until ${expires})` : ""}` : "",
    a.reportUrl ? `Open the report in Sundial: ${a.reportUrl}` : "",
    "",
    `Times are Arizona time. To stop receiving this report, ask ${a.ownerName || "its owner"}.`,
  ].filter((l, i, all) => l !== "" || all[i - 1] !== "").join("\n");

  return { subject, html, text };
}

/** The one email the owner gets when their schedule turns itself off. */
export function buildDisabledEmail({ reportName, failures, lastError, reportUrl }) {
  const subject = `Scheduled report turned off: ${reportName}`;
  const why = failureWords(lastError);
  const lead = `The schedule on your report "${reportName}" has been turned off after ${failures} failed deliveries in a row. The last one failed because ${why}.`;
  const fix = "Open the report, check it still runs, then turn its schedule back on.";
  const html = [
    `<p ${P}>${escapeHtml(lead)}</p>`,
    `<p ${P}>${escapeHtml(fix)}</p>`,
    reportUrl ? `<p ${P}><a href="${escapeHtml(reportUrl)}" ${A}>Open the report in Sundial</a></p>` : "",
  ].join("");
  const text = [lead, "", fix, reportUrl ? `\nOpen the report in Sundial: ${reportUrl}` : ""].join("\n");
  return { subject, html, text };
}
