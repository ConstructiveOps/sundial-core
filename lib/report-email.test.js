// node --test lib/report-email.test.js — the scheduled-report emails (D-091). Pure.

import test from "node:test";
import assert from "node:assert/strict";
import { buildDeliveryEmail, buildDisabledEmail, cellDisplay, longDate, arizonaStamp, escapeHtml } from "./report-email.js";

const base = { reportName: "Jobs <by> status", runDate: "2026-11-10", ownerName: "Ada Admin", asOf: "2026-11-10T14:02:00Z", rowCount: 1234, truncated: false, fileName: "service_jobs-2026-11-10.csv" };

test("subject = the report name and the Arizona run date; every value escaped in the HTML", () => {
  const m = buildDeliveryEmail({ ...base, attached: true, reportUrl: "https://sundial.example/reports/1" });
  assert.equal(m.subject, "Jobs <by> status — Nov 10, 2026");
  assert.match(m.html, /Jobs &lt;by&gt; status/);
  assert.ok(!m.html.includes("<by>"));
  assert.match(m.text, /1,234 rows · data as of Nov 10, 2026, 7:02 AM/);
  assert.match(m.text, /The file is attached \(service_jobs-2026-11-10\.csv\)/);
  assert.match(m.html, /<a href="https:\/\/sundial\.example\/reports\/1"[^>]*>Open the report in Sundial<\/a>/);
  assert.match(m.text, /Open the report in Sundial: https:\/\/sundial\.example\/reports\/1/);
});

test("a link instead of an attachment, with its expiry; a truncated export says so", () => {
  const m = buildDeliveryEmail({ ...base, truncated: true, attached: false, downloadUrl: "https://api.example/public/reports/download/T", expiresAt: "2026-11-17T14:02:00Z", reportUrl: null });
  assert.match(m.html, />Download the report \(CSV\)<\/a> — the link works until Nov 17, 2026, 7:02 AM/);
  assert.match(m.text, /export limit/);
  assert.ok(!m.text.includes("attached"));
  assert.ok(!m.html.includes("Open the report"), "no portal address → no link");
});

test("a grouped table: labels, formatted cells, a 'first rows' note", () => {
  const output = [{ label: "Created (month)", type: "date" }, { label: "Count", type: "number" }, { label: "Sum of Total", type: "number", format: "currency" }];
  const m = buildDeliveryEmail({ ...base, attached: true, table: { output, rows: [["2026-10-01", 3, 1234.5], [null, 1, null]], more: true } });
  assert.match(m.html, /<th[^>]*>Created \(month\)<\/th>/);
  assert.match(m.html, />Oct 1, 2026</);
  assert.match(m.html, />\$1,234\.50</);
  assert.match(m.html, /Showing the first 2 rows/);
  assert.match(m.text, /Created \(month\): Oct 1, 2026 \| Count: 3 \| Sum of Total: \$1,234\.50/);
});

test("cells, dates and escaping", () => {
  assert.equal(cellDisplay(true, { type: "boolean" }), "Yes");
  assert.equal(cellDisplay(12.5, { type: "number", format: "percent" }), "12.5%");
  assert.equal(cellDisplay("2026-11-01T06:30:00Z", { type: "datetime" }), "Oct 31, 2026, 11:30 PM");
  assert.equal(cellDisplay(null, { type: "text" }), "");
  assert.equal(longDate("2026-01-05"), "Jan 5, 2026");
  assert.equal(arizonaStamp(null), null);
  assert.equal(escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
});

test("the owner's notice names the report, the count and the reason in plain words", () => {
  const m = buildDisabledEmail({ reportName: "Daily jobs", failures: 3, lastError: "CSV_TOO_SLOW", reportUrl: "https://sundial.example/reports/9" });
  assert.equal(m.subject, "Scheduled report turned off: Daily jobs");
  assert.match(m.text, /after 3 failed deliveries in a row\. The last one failed because the report took too long to build\./);
  assert.match(m.html, /Open the report in Sundial/);
  assert.match(buildDisabledEmail({ reportName: "X", failures: 3, lastError: "WHO_KNOWS" }).text, /something went wrong/);
});
