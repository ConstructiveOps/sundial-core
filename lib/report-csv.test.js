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

// --- summary reports (D-093) -------------------------------------------------------------------
import { summaryCsvHeader, createSummaryCsv } from "./report-csv.js";

const SUM_DEF = {
  type: "solar", showDetails: true, groupBy: ["rep.name"], columns: ["solar.project_name", "solar.contract_amount"],
  aggregates: [{ fn: "count" }, { fn: "sum", field: "solar.contract_amount" }],
};
// Two pages of four, as sundial_report_run returns them: Bob's group is split across the pages.
const PAGE1 = {
  rows: [["A-300", 300], ["A-200", 200], ["A-100", 100], ["B-2000", 2000]],
  groups: [
    { key: "Ann", first: 0, shown: 3, count: 3, aggregates: { count: 3, sum_solar_contract_amount: 600 } },
    { key: "Bob", first: 3, shown: 1, count: 2, aggregates: { count: 2, sum_solar_contract_amount: 3000 } },
  ],
};
const PAGE2 = {
  rows: [["B-1000", 1000], ["Nobody", 5]],
  groups: [
    { key: "Bob", first: 0, shown: 1, count: 2, aggregates: { count: 2, sum_solar_contract_amount: 3000 } },
    { key: null, first: 1, shown: 1, count: 1, aggregates: { count: 1, sum_solar_contract_amount: 5 } },
  ],
};

test("summary CSV: the group first, then the columns, then one column per aggregate", () => {
  const n = normalizeDefinition(SUM_DEF, { mode: "csv" });
  assert.equal(summaryCsvHeader(n.output, n.group, n.totals, reportType("solar")),
    `${CSV_BOM}Sales rep: User Name,Solar project: Project Name,Solar project: Contract Amount,Count,Sum of Contract Amount\r\n`);
});

test("summary CSV: a subtotal after each group's last row (one, even across pages), a grand total at the end", () => {
  const n = normalizeDefinition(SUM_DEF, { mode: "csv" });
  const w = createSummaryCsv({ output: n.output, group: n.group, totals: n.totals });
  const text = w.page(PAGE1) + w.page(PAGE2) + w.end({ aggregates: { count: 6, sum_solar_contract_amount: 3605 }, totalRows: 6 });
  assert.equal(text, [
    "Ann,A-300,300,,",
    "Ann,A-200,200,,",
    "Ann,A-100,100,,",
    "Subtotal: Ann (3 records),,,3,600",
    "Bob,B-2000,2000,,",
    "Bob,B-1000,1000,,",
    "Subtotal: Bob (2 records),,,2,3000",
    ",Nobody,5,,",
    "Subtotal: (blank) (1 record),,,1,5",
    "Grand total (6 records),,,6,3605",
    "",
  ].join("\r\n"));
});

test("summary CSV: a group cut by the export cap still gets its subtotal with its FULL count", () => {
  const n = normalizeDefinition(SUM_DEF, { mode: "csv" });
  const w = createSummaryCsv({ output: n.output, group: n.group, totals: n.totals });
  const text = w.page(PAGE1) + w.end({ aggregates: { count: 6, sum_solar_contract_amount: 3605 }, totalRows: 6 });
  const lines = text.split("\r\n");
  assert.deepEqual(lines.slice(-4), ["Bob,B-2000,2000,,", "Subtotal: Bob (2 records),,,2,3000", "Grand total (6 records),,,6,3605", ""]);
  // an export with no rows is just its grand total
  const empty = createSummaryCsv({ output: n.output, group: n.group, totals: n.totals });
  assert.equal(empty.page({ rows: [], groups: [] }) + empty.end({ aggregates: { count: 0, sum_solar_contract_amount: null }, totalRows: 0 }), "Grand total (0 records),,,0,\r\n");
});

test("summary CSV: a period group — the cell is the period's first day, the subtotal names the period; links last", () => {
  const n = normalizeDefinition({ type: "solar", showDetails: true, groupBy: [{ field: "solar.contract_date", dateTrunc: "month" }], columns: ["solar.project_name"], aggregates: [{ fn: "count" }] }, { mode: "csv" });
  const links = linkColumns(reportType("solar"));
  assert.match(summaryCsvHeader(n.output, n.group, n.totals, reportType("solar"), links), /^﻿Solar project: .+ \(month\),Solar project: Project Name,Count,Solar project link,Customer link\r\n$/);
  const w = createSummaryCsv({ output: n.output, group: n.group, totals: n.totals, links, origin: "https://x.example" });
  const text = w.page({
    rows: [["=Oct"]],
    records: [{ solar: { sfId: "a1S7y00000AbCdEFGH", name: "x" }, customer: null }],
    groups: [{ key: "2026-10-01", first: 0, shown: 1, count: 4, aggregates: { count: 4 } }],
  }) + w.end({ aggregates: { count: 4 }, totalRows: 4 });
  assert.equal(text, [
    "2026-10-01,'=Oct,,https://x.example/projects/solar/a1S7y00000AbCdEFGH,",
    "Subtotal: October 2026 (4 records),,4,,",
    "Grand total (4 records),,4,,",
    "",
  ].join("\r\n"));
});
