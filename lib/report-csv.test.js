// node --test lib/report-csv.test.js
//
// Pinned (D-089): BOM + CRLF + RFC 4180 quoting; "<object>: <field>" headers (aggregates keep
// their label); the formula guard on TEXT only (= + - @ TAB CR), never on a number; datetimes
// in Arizona; booleans Yes / No; blank = empty; the S3 key is REPORTS/<tenant>/<AZ date>/<uuid>.csv
// and never anything else (never SUNDIAL/).

import test from "node:test";
import assert from "node:assert/strict";
import { csvHeader, csvRows, cellText, quote, arizonaDateTime, exportKey, downloadName, CSV_BOM, REPORTS_PREFIX } from "./report-csv.js";
import { reportType } from "./report-types.js";
import { normalizeDefinition } from "./report-def.js";

const T = "a1W7y000007AszBEAS";
const ID = "0b9c6f1e-2d3a-4c5b-8e7f-123456789abc";

test("header: BOM, '<object>: <field>', aggregates keep their label", () => {
  const t = reportType("customers");
  const n = normalizeDefinition({ type: "customers", columns: ["customer.name", "rep.name", "assignee.name"] });
  const h = csvHeader(n.output, t);
  assert.ok(h.startsWith(CSV_BOM));
  assert.equal(h, `${CSV_BOM}Customer: Customer Name,Sales rep: User Name,Assigned to: User Name\r\n`);
  const g = normalizeDefinition({ type: "customers", groupBy: ["customer.stage"], aggregates: [{ fn: "count" }] });
  assert.match(csvHeader(g.output, t), /,Count\r\n$/);
});

test("quoting: commas, quotes and line breaks", () => {
  assert.equal(quote("plain"), "plain");
  assert.equal(quote("a,b"), '"a,b"');
  assert.equal(quote('say "hi"'), '"say ""hi"""');
  assert.equal(quote("line\nbreak"), '"line\nbreak"');
  assert.equal(quote("cr\rhere"), '"cr\rhere"');
});

test("the formula guard is for text only", () => {
  for (const s of ["=SUM(A1)", "+1 555", "-x", "@cmd", "\tlead", "\rlead"]) assert.equal(cellText(s, "text"), `'${s}`);
  assert.equal(cellText("=HYPERLINK()", "picklist"), "'=HYPERLINK()");
  assert.equal(cellText("Mesa", "text"), "Mesa");
  assert.equal(cellText(-30, "number"), "-30");
  assert.equal(cellText("-30", "number"), "-30");
});

test("types: datetimes in Arizona, dates as stored, Yes / No, blank", () => {
  assert.equal(arizonaDateTime("2026-10-07T12:00:00+00:00"), "2026-10-07 05:00");
  assert.equal(arizonaDateTime("2026-11-01T03:30:00Z"), "2026-10-31 20:30"); // still Oct 31 in Phoenix
  assert.equal(cellText("2026-10-07T12:00:00Z", "datetime"), "2026-10-07 05:00");
  assert.equal(cellText("2026-10-07", "date"), "2026-10-07");
  assert.equal(cellText(true, "boolean"), "Yes");
  assert.equal(cellText(false, "boolean"), "No");
  assert.equal(cellText(null, "text"), "");
  assert.equal(cellText(undefined, "number"), "");
  assert.equal(cellText(0, "number"), "0");
});

test("rows: one CRLF line per row, in output order", () => {
  const output = [{ type: "text" }, { type: "number" }, { type: "boolean" }, { type: "datetime" }];
  const text = csvRows([["O'Brien, Pat", 12.5, true, "2026-10-07T12:00:00Z"], [null, null, null, null]], output);
  assert.equal(text, `"O'Brien, Pat",12.5,Yes,2026-10-07 05:00\r\n,,,\r\n`);
});

test("the bucket is the file bucket", async () => {
  const { S3_BUCKET, S3_REGION } = await import("./file-access.js");
  const { REPORTS_BUCKET, REPORTS_REGION } = await import("./report-csv.js");
  assert.equal(REPORTS_BUCKET, S3_BUCKET);
  assert.equal(REPORTS_REGION, S3_REGION);
});

test("the S3 key: REPORTS/<tenant>/<Arizona date>/<uuid>.csv, nothing else", () => {
  const late = new Date("2026-11-04T05:00:00Z"); // 10 PM Nov 3 in Arizona
  assert.equal(exportKey(T, ID, late), `REPORTS/${T}/2026-11-03/${ID}.csv`);
  assert.equal(REPORTS_PREFIX, "REPORTS/");
  assert.ok(!exportKey(T, ID).startsWith("SUNDIAL/"));
  assert.throws(() => exportKey("../SUNDIAL", ID), /bad client_sf_id/);
  assert.throws(() => exportKey(T, "../../x"), /bad export id/);
  assert.equal(downloadName("service_jobs", late), "service_jobs-2026-11-03.csv");
  assert.equal(downloadName("../x\"y", late), "xy-2026-11-03.csv");
});

// --- record links (D-089 am. 1) ---------------------------------------------------------------
import { linkColumns, recordUrl, cleanOrigin } from "./report-csv.js";

test("links: one '<alias label> link' column per alias with a page; a linkVia alias keeps its own label and opens the parent", () => {
  assert.deepEqual(linkColumns(reportType("payments")).map((l) => [l.title, l.alias, l.recordPath]), [
    ["Payment link", "job", "/service/jobs/{id}"],
    ["Invoice link", "job", "/service/jobs/{id}"],
    ["Service job link", "job", "/service/jobs/{id}"],
    ["Customer link", "customer", "/customers/{id}"],
  ]);
  // rollups, users, dealers and price book items have none
  assert.deepEqual(linkColumns(reportType("service_jobs")).map((l) => l.title), ["Service job link", "Customer link", "Bill-to customer link", "Estimate link", "Invoice (newest, not void) link"]);
  assert.deepEqual(linkColumns(reportType("estimate_lines")).map((l) => [l.title, l.alias]), [["Line link", "estimate"], ["Estimate link", "estimate"], ["Customer link", "customer"]]);
  assert.deepEqual(linkColumns(reportType("solar")).map((l) => l.title), ["Solar project link", "Customer link"]);
});

test("links: the header ends with the link titles; each row with full URLs (blank when the row has no such record)", () => {
  const t = reportType("solar");
  const n = normalizeDefinition({ type: "solar", columns: ["solar.project_name", "solar.contract_amount"] }, { mode: "csv" });
  const links = linkColumns(t);
  assert.equal(csvHeader(n.output, t, links), `${CSV_BOM}Solar project: Project Name,Solar project: Contract Amount,Solar project link,Customer link\r\n`);
  const origin = cleanOrigin("https://sundial.harmonelectric.net/");
  const records = [
    { solar: { sfId: "a1S7y00000AbCdEFGH", name: "Sunny" }, customer: { sfId: "a1P7y00000AmyXCEAZ", name: "ZZ" }, rep: null, dealer: null },
    { solar: { sfId: "a1S7y00000ZZZZZZZZ", name: "Alone" }, customer: null, rep: null, dealer: null },
  ];
  assert.equal(
    csvRows([["Sunny", 10000], ["Alone", null]], n.output, { records, links, origin }),
    "Sunny,10000,https://sundial.harmonelectric.net/projects/solar/a1S7y00000AbCdEFGH,https://sundial.harmonelectric.net/customers/a1P7y00000AmyXCEAZ\r\n"
      + "Alone,,https://sundial.harmonelectric.net/projects/solar/a1S7y00000ZZZZZZZZ,\r\n"
  );
  // without links the rows are exactly what they were
  assert.equal(csvRows([["Sunny", 10000]], n.output), "Sunny,10000\r\n");
});

test("links: the origin must be a bare http(s) origin; the id is URL-encoded", () => {
  assert.equal(cleanOrigin("https://a.example.com//"), "https://a.example.com");
  assert.equal(cleanOrigin("http://localhost:5173"), "http://localhost:5173");
  for (const bad of [null, "", "javascript:alert(1)", "https://a.example.com/path", "a.example.com", "https://a b.com"]) assert.equal(cleanOrigin(bad), null, String(bad));
  assert.equal(recordUrl("https://x.example", "/customers/{id}", "a/b?c"), "https://x.example/customers/a%2Fb%3Fc");
  assert.equal(recordUrl("https://x.example", "/customers/{id}", null), "");
  assert.equal(recordUrl(null, "/customers/{id}", "a1"), "");
});
