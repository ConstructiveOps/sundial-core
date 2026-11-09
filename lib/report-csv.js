// lib/report-csv.js — turn report rows into CSV text (D-089, Reporting R1b). PURE: no I/O.
// lambdas/sundial-reports/csv.js pages sundial_report_run and streams what this returns to S3.
//
// THE FILE:
//   - UTF-8 with a byte-order mark, so Excel opens names like "Peña" correctly;
//   - CRLF line ends and RFC 4180 quoting (a value with , " CR or LF is quoted, " doubled);
//   - headers "<object label>: <field label>" ("Customer: Name", "Sales rep: Name"), so two
//     aliases of one object (rep / assignee) stay apart; a grouped report's aggregates keep
//     their own label ("Count", "Sum of Total");
//   - a TEXT value that starts with = + - @ TAB or CR gets a leading ' — a spreadsheet would
//     otherwise run it as a formula (CSV injection). Numbers, dates and booleans are never
//     touched (a negative amount stays a number);
//   - datetimes in ARIZONA time ("2026-10-07 05:00", the tenant zone, UTC−07:00 all year,
//     like every report date — lib/report-def.js), dates as stored, booleans Yes / No, blank
//     as an empty cell.
//
// RECORD LINKS (D-089 am. 1, 2026-11-09). An UNGROUPED export ends each row with one column
// per record alias that has a portal page (lib/report-types.js recordLinkOf), titled
// "<alias label> link", holding the full URL: the tenant's portal origin (lib/tenant-settings.js
// portalUrlFor — resolved when the export is queued) + the recordPath with the record's sf_id.
// An alias with linkVia (an invoice, a payment, a call, a line) is titled with its OWN label
// and opens its parent's page. A grouped export, or a tenant with no portal address, has none.
//
// The S3 key lives here too, so the path rule has one home:
//   REPORTS/<client_sf_id>/<yyyy-mm-dd in Arizona>/<uuid>.csv in sfsolproj — NEVER under
//   SUNDIAL/, which is the Salesforce-record folder tree XFiles Pro and the Dropbox copy-back
//   read (these files hold contact details). The bucket's 7-day lifecycle rule is scoped to
//   REPORTS/ (scripts/add-reports-lifecycle.ps1).

import { arizonaToday, REPORT_UTC_OFFSET } from "./report-def.js";
import { recordAliasesOf, recordLinkOf, RECORD_PATHS } from "./report-types.js";

// The bucket every Sundial file lives in — the same value as lib/file-access.js S3_BUCKET /
// S3_REGION (pinned equal by lib/report-csv.test.js; not imported, so the reports Lambda does
// not bundle the Salesforce client file-access.js needs).
export const REPORTS_BUCKET = "sfsolproj";
export const REPORTS_REGION = "us-west-1";

export const CSV_BOM = "﻿";
export const CSV_EOL = "\r\n";
export const REPORTS_PREFIX = "REPORTS/";

const OFFSET_MS = (() => {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(REPORT_UTC_OFFSET);
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
})();
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;
const SF_ID = /^[a-zA-Z0-9]{15,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A timestamptz value → "YYYY-MM-DD HH:MM" in Arizona; anything unparseable as given. */
export function arizonaDateTime(v) {
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return String(v);
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
}

/** One cell's text (unquoted), by the column's catalog type. */
export function cellText(value, type) {
  if (value === null || value === undefined) return "";
  switch (type) {
    case "boolean":
      return value === true || value === "true" ? "Yes" : value === false || value === "false" ? "No" : String(value);
    case "number":
      return String(value);
    case "datetime":
      return arizonaDateTime(value);
    case "date":
      return String(value);
    default: {
      const s = typeof value === "string" ? value : String(value);
      return FORMULA_START.test(s) ? `'${s}` : s;
    }
  }
}

/** RFC 4180 quoting. */
export function quote(s) {
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV line (with its CRLF) from already-formatted cell texts. */
export function csvLine(cells) {
  return cells.map(quote).join(",") + CSV_EOL;
}

/**
 * The link columns of a report type, in alias order (base first): { title, alias, recordPath }
 * where `alias` is the record whose sf_id goes in the URL (the parent's, for a linkVia alias).
 */
export function linkColumns(type) {
  const recs = recordAliasesOf(type);
  const out = [];
  for (const r of recs) {
    const link = recordLinkOf(type, r.alias);
    if (!link) continue;
    const target = link.recordPath ? r : recs.find((x) => x.alias === link.linkVia);
    out.push({ title: `${r.label} link`, alias: target.alias, recordPath: RECORD_PATHS[target.object] });
  }
  return out;
}

const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i;

/** A portal origin fit for a link ("https://host"), trailing slashes dropped; else null. */
export function cleanOrigin(origin) {
  const o = typeof origin === "string" ? origin.trim().replace(/\/+$/, "") : "";
  return ORIGIN.test(o) ? o : null;
}

/** The full URL of one record's page, or "" when the row has no such record. */
export function recordUrl(origin, recordPath, sfId) {
  if (!origin || !sfId) return "";
  return origin + recordPath.replace("{id}", encodeURIComponent(String(sfId)));
}

/**
 * The header line. `output` is normalizeDefinition()'s output list; `type` the report type
 * (for the alias labels). Starts with the BOM — it is the first thing in the file.
 */
export function csvHeader(output, type, links = []) {
  const labels = new Map([[type.base.alias, type.base.label], ...type.joins.map((j) => [j.alias, j.label])]);
  const cells = output.map((o) => (o.aggregate ? o.label : `${labels.get(o.object) ?? o.object}: ${o.label}`));
  return CSV_BOM + csvLine([...cells, ...links.map((l) => l.title)]);
}

/**
 * A page of rows (arrays in output order) → CSV text. With `links` (linkColumns) and an
 * `origin`, each line ends with the link cells, read from `records` (parallel to rows).
 */
export function csvRows(rows, output, { records = null, links = [], origin = null } = {}) {
  let out = "";
  rows.forEach((row, k) => {
    const cells = output.map((o, i) => cellText(row[i], o.type));
    for (const l of links) cells.push(recordUrl(origin, l.recordPath, records?.[k]?.[l.alias]?.sfId));
    out += csvLine(cells);
  });
  return out;
}

/** The S3 key of an export. Refuses anything that is not a Salesforce id / a uuid. */
export function exportKey(clientSfId, exportId, now = new Date()) {
  if (!SF_ID.test(String(clientSfId))) throw new Error("exportKey: bad client_sf_id");
  if (!UUID.test(String(exportId))) throw new Error("exportKey: bad export id");
  return `${REPORTS_PREFIX}${clientSfId}/${arizonaToday(now)}/${exportId}.csv`;
}

/** The file name the browser saves: "<type>-<yyyy-mm-dd>.csv" (letters, digits, - and _ only). */
export function downloadName(typeKey, now = new Date()) {
  return `${String(typeKey).replace(/[^a-z0-9_-]/gi, "") || "report"}-${arizonaToday(now)}.csv`;
}
