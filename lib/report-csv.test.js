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
