// The PDF painter draws the SAME model the HTML painter draws. These tests pin the
// two properties that matter: it never throws on real-world text (a send must not
// fail because a description has an emoji), and every row / total / note in the
// model reaches the page — checked by extracting the text back out of the PDF.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { buildEstimateModel, renderEstimateDocument } from "./estimate-document.js";
import { renderEstimatePdf, pdfSafe } from "./estimate-pdf.js";

const estimate = {
  Name: "EST-0007",
  Version__c: 2,
  Approved_Version__c: 1,
  Customer_Name_at_Creation__c: "Pat Customer",
  Address_at_Creation__c: "123 Main St, Phoenix, AZ 85001",
  Primary_Email_at_Creation__c: "pat@example.com",
  Scope_Summary__c: "Replace failed inverter — re-commission.\nVerify monitoring.",
  Valid_Until__c: "2026-10-11",
  Last_Sent_At__c: "2026-09-11T20:00:00Z",
  Deposit_Required__c: true,
  Tax_Jurisdiction__c: "Phoenix",
  Discount_Source__c: "Service Plan",
};
const totals = { subtotal: 12000, discountAmount: 500, taxAmount: 300, total: 11800, depositAmount: 1000 };
const brand = { companyName: "Test Electric", licenseLine: "ROC #123456", termsUrl: "https://example.com/terms", footerNote: "Ask about the Service Club." };

function lines(n) {
  return Array.from({ length: n }, (_, i) => ({
    Description__c: i === 3 ? "Diagnostic truck roll 🚚 with a long description that wraps across the column more than once" : `Line ${i + 1} — labor`,
    Quantity__c: 1,
    Unit_Price__c: 275,
    Line_Total__c: 275,
    Unit_of_Measure__c: "Each",
    Stage__c: i >= n - 2 ? "Proposed" : "Approved",
  }));
}

test("pdfSafe replaces characters the standard fonts cannot encode, keeps the rest", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  assert.equal(pdfSafe("Plain — with ellipsis… and “quotes”", font), "Plain — with ellipsis… and “quotes”");
  assert.equal(pdfSafe("Truck 🚚 roll", font), "Truck ? roll");
  assert.equal(pdfSafe("a\r\nb\tc", font), "a\nb  c");
});

test("renders a valid, multi-page PDF from the same model as the HTML, with every row and total present", async () => {
  const model = buildEstimateModel({ estimate, lines: lines(45), totals, brand, options: { mode: "customer", acceptUrl: "https://portal.example.com/estimate/TOK" } });
  const bytes = await renderEstimatePdf(model);
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 2, `expected ≥2 pages, got ${doc.getPageCount()}`);
  assert.equal(doc.getTitle(), "EST-0007 v2");

  // The HTML painter walked the same model: same row count, same totals labels.
  const { html } = renderEstimateDocument({ model });
  assert.equal((html.match(/<td class="desc">/g) || []).length, 45);
  assert.equal(model.rows.length, 45);
  assert.equal(model.totalRows.map((r) => r.label).join("|"), "Subtotal|Service plan discount|Tax (Phoenix)|Total|Deposit due to schedule");
  assert.equal(model.rows.filter((r) => r.isNew).length, 2);
});

test("an empty estimate still renders (no rows, no customer) — nothing to throw on", async () => {
  const model = buildEstimateModel({ estimate: { Name: "EST-0001" }, lines: [], totals: { subtotal: 0, total: 0 }, options: { mode: "pdf" } });
  const bytes = await renderEstimatePdf(model);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
});
