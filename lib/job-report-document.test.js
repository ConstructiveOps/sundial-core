// lib/job-report-document.js + lib/job-report-pdf.js — the customer's job report: the saved
// sections normalized, the photo choices, the model (header, sections, receipt rules), the
// HTML and a real PDF with an embedded photo.
import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { buildJobReportModel, normalizeReportSections, renderJobReportDocument, reportPhotoChoices, MAX_SECTIONS } from "./job-report-document.js";
import { imageKind, renderJobReportPdf } from "./job-report-pdf.js";

const JOB = "SVC000000000000003";
const job = { Id: JOB, Name: "SVC-00003", Customer_Name_at_Creation__c: "Cy Diaz", Address_at_Creation__c: "3 Elm St, Phoenix, AZ 85001", Primary_Phone_at_Creation__c: "602-555-0100", Primary_Email_at_Creation__c: "cy@example.com", Service_Type__c: "Paid Service", Bill_To_Type__c: "Customer", Customer_Summary__c: "Replaced the failed 20A breaker and tested the array under load.\nEverything is producing again." };
const files = [
  { key: `SUNDIAL/${JOB}/photos/SC0000000000000001/20260914-breaker.jpg`, publicUrl: "https://s3/a.jpg", size: 100, lastModified: "2026-09-14T16:20:00Z" },
  { key: `SUNDIAL/${JOB}/photos/SC0000000000000001/notes.pdf`, publicUrl: "https://s3/notes.pdf", size: 100, lastModified: "2026-09-14T16:21:00Z" },
  { key: `SUNDIAL/${JOB}/photos/office-after.png`, publicUrl: "https://s3/b.png", size: 100, lastModified: "2026-09-15T10:00:00Z" },
  { key: `SUNDIAL/${JOB}/estimate-v1.pdf`, publicUrl: "https://s3/e.pdf", size: 100, lastModified: "2026-09-10T10:00:00Z" },
];
const calls = [{ Id: "SC0000000000000001", Name: "SC-00001", Scheduled_Start__c: "2026-09-14T16:00:00Z", Tech__r: { First_Name__c: "Jake", Last_Name__c: "Dorsey" } }];
const invoice = { Name: "SVC-00003", Status__c: "Paid", Subtotal__c: 450, Discount_Amount__c: 0, Tax_Amount__c: 0, Total__c: 450, Paid_Amount__c: 450, Paid_At__c: "2026-09-16T18:00:00Z", Bill_To_Type__c: "Customer" };
const lines = [{ Description__c: "Diagnostic", Quantity__c: 1, Unit_Price__c: 150, Line_Total__c: 150, Stage__c: "Approved" }, { Description__c: "Breaker 20A", Quantity__c: 1, Unit_Price__c: 300, Line_Total__c: 300, Stage__c: "Approved" }];
const payments = [{ Status__c: "Succeeded", Type__c: "Payment", Method__c: "Card", Amount__c: 450, Received_At__c: "2026-09-16T18:00:00Z" }];

test("normalize: strings and objects, empty sections dropped, bad photo keys refused, caps", () => {
  const r = normalizeReportSections(JSON.stringify({ sections: [{ id: "a", photoKey: files[0].key, caption: " Before ", extra: 1 }, { caption: "" }, { caption: "Text only" }] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { version: 1, receipt: true, intro: "", sections: [{ id: "a", photoKey: files[0].key, caption: "Before" }, { id: "s3", photoKey: null, caption: "Text only" }] });
  assert.equal(normalizeReportSections("").value.sections.length, 0);
  assert.equal(normalizeReportSections(null).ok, true);
  assert.equal(normalizeReportSections("{not json").ok, false);
  assert.equal(normalizeReportSections({ sections: [{ photoKey: "SUNDIAL/../../etc/passwd", caption: "x" }] }).ok, false);
  assert.equal(normalizeReportSections({ sections: [{ photoKey: "https://evil/x.jpg", caption: "x" }] }).ok, false);
  assert.equal(normalizeReportSections({ sections: Array.from({ length: MAX_SECTIONS + 1 }, () => ({ caption: "x" })) }).ok, false);
  assert.equal(normalizeReportSections({ receipt: false, intro: "Hi" }).value.receipt, false);
});

test("photo choices: images under the job's photos folder only, labelled by visit", () => {
  const c = reportPhotoChoices(files, JOB, calls);
  assert.deepEqual(c.map((p) => [p.fileName, p.visitLabel, p.callNumber]), [["20260914-breaker.jpg", "Jake Dorsey · Sep 14, 2026", "SC-00001"], ["office-after.png", "Office", null]]);
});

test("model: header merges customer + summary; sections resolve to URLs; the receipt is the invoice's rows; a partner payer gets no receipt", () => {
  const report = normalizeReportSections({ sections: [{ photoKey: files[0].key, caption: "The failed breaker." }, { photoKey: files[2].key, caption: "After: new breaker installed." }, { caption: "We also tightened the lugs." }] }).value;
  const photos = reportPhotoChoices(files, JOB, calls);
  const m = buildJobReportModel({ job, report, photos, invoice, lines, payments, brand: { companyName: "Test Electric" }, options: { mode: "customer", pdfUrl: "https://s3/r.pdf" } });
  assert.equal(m.title, "Job report SVC-00003");
  assert.deepEqual(m.customerLines, ["Cy Diaz", "3 Elm St, Phoenix, AZ 85001", "602-555-0100", "cy@example.com"]);
  assert.match(m.summary, /Replaced the failed 20A breaker/);
  assert.deepEqual(m.metaLines, ["Paid Service", "PAID Sep 16, 2026"]);
  assert.equal(m.sections.length, 3);
  assert.equal(m.sections[0].photoUrl, "https://s3/a.jpg");
  assert.equal(m.sections[0].visitLabel, "Jake Dorsey · Sep 14, 2026");
  assert.equal(m.sections[2].photoUrl, null);
  assert.equal(m.receipt.label, "Receipt");
  assert.deepEqual(m.receipt.rows.map((r) => r.amount), ["$150.00", "$300.00"]);
  assert.equal(m.receipt.totalRows.at(-1).label, "Balance");
  assert.deepEqual(m.receipt.paymentLines, ["Sep 16, 2026 · Card · $450.00"]);
  assert.equal(m.receipt.note, "Paid in full — thank you.");
  assert.equal(m.watermark, "");
  // a photo the job no longer has still gets a URL (and a flag for the office)
  const gone = buildJobReportModel({ job, report: normalizeReportSections({ sections: [{ photoKey: `SUNDIAL/${JOB}/photos/x.jpg`, caption: "?" }] }).value, photos });
  assert.equal(gone.sections[0].photoMissing, true);
  assert.match(gone.sections[0].photoUrl, /\/photos\/x\.jpg$/);
  // partner payer → no receipt; office switch → no receipt; no invoice → no receipt
  assert.equal(buildJobReportModel({ job: { ...job, Bill_To_Type__c: "Leasing Partner" }, report, photos, invoice, lines, payments }).receipt, null);
  assert.equal(buildJobReportModel({ job, report: { ...report, receipt: false }, photos, invoice, lines, payments }).receipt, null);
  assert.equal(buildJobReportModel({ job, report, photos }).receipt, null);
  const unpaid = buildJobReportModel({ job, report, photos, invoice: { ...invoice, Status__c: "Sent", Paid_Amount__c: 100, Paid_At__c: null, Due_Date__c: "2026-10-01" }, lines, payments });
  assert.equal(unpaid.receipt.label, "Invoice summary");
  assert.equal(unpaid.receipt.note, "Balance due: $350.00 by Oct 1, 2026.");
  assert.equal(buildJobReportModel({ job: { Name: "SVC-1" }, report: { sections: [] } }).empty, true);
});

test("html: escapes, one figure per photo section, the receipt table, the PDF link; preview watermark", () => {
  const report = normalizeReportSections({ sections: [{ photoKey: files[0].key, caption: "<b>Before</b> & after" }] }).value;
  const { html } = renderJobReportDocument({ job, report, photos: reportPhotoChoices(files, JOB, calls), invoice, lines, payments, brand: { companyName: "Test Electric" }, options: { mode: "preview", pdfUrl: "https://s3/r.pdf" } });
  assert.ok(html.includes("&lt;b&gt;Before&lt;/b&gt; &amp; after"));
  assert.ok(!html.includes("<b>Before"));
  assert.equal((html.match(/<figure>/g) || []).length, 1);
  assert.ok(html.includes('src="https://s3/a.jpg"'));
  assert.ok(html.includes("Receipt · SVC-00003"));
  assert.ok(html.includes("Paid in full"));
  assert.ok(html.includes('class="wm">PREVIEW'));
  assert.ok(html.includes("https://s3/r.pdf"));
});

test("pdf: a real document with an embedded JPEG, a placeholder for a photo without bytes, and the receipt", async () => {
  // A 1x1 JPEG.
  const jpg = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
  assert.equal(imageKind(jpg), "jpg");
  assert.equal(imageKind(new Uint8Array([1, 2, 3]), "image/png"), "png");
  assert.equal(imageKind(new Uint8Array([1, 2, 3]), "image/heic"), null);
  const report = normalizeReportSections({ sections: [{ photoKey: files[0].key, caption: "The failed breaker, arc marks on the bus." }, { photoKey: files[2].key, caption: "After." }, { caption: "Lugs torqued to spec." }] }).value;
  const model = buildJobReportModel({ job, report, photos: reportPhotoChoices(files, JOB, calls), invoice, lines, payments, brand: { companyName: "Test Electric" }, options: { mode: "pdf", pdfUrl: "https://s3/r.pdf" } });
  const bytes = await renderJobReportPdf(model, new Map([[files[0].key, { bytes: jpg, contentType: "image/jpeg" }]]));
  assert.ok(bytes.length > 1500);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getTitle(), "Job report SVC-00003");
  assert.ok(doc.getPageCount() >= 1);
  // a big report paginates without throwing
  const many = buildJobReportModel({ job, report: normalizeReportSections({ sections: Array.from({ length: 30 }, (_, i) => ({ photoKey: files[0].key, caption: `Section ${i + 1} ${"words ".repeat(40)}` })) }).value, photos: reportPhotoChoices(files, JOB, calls), invoice, lines, payments });
  const big = await renderJobReportPdf(many, new Map([[files[0].key, { bytes: jpg }]]));
  assert.ok((await PDFDocument.load(big)).getPageCount() > 3);
});
