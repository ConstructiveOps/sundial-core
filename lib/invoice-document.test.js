// D-081 — the invoice document, built to Harmon's Housecall Pro layout, painted twice (HTML
// and PDF) from one model. Four snapshots: the homeowner pays; a company with a contact
// pays; a company with no contact but a reference pays; a Paid invoice. Each one checks the
// MODEL (what is shown), the HTML (it reached the page) and the PDF (the text drawn on it,
// read back out of the inflated content streams).

import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { buildInvoiceModel, buildEstimateModel, renderEstimateDocument } from "./estimate-document.js";
import { renderEstimatePdf } from "./estimate-pdf.js";
import { buildJobReportModel, renderJobReportDocument } from "./job-report-document.js";
import { renderJobReportPdf } from "./job-report-pdf.js";

/** Every string a PDF draws (Tj operands), page streams inflated, in drawing order. */
function pdfText(bytes) {
  const raw = Buffer.from(bytes);
  const out = [];
  let at = 0;
  for (;;) {
    const s = raw.indexOf("stream", at, "latin1");
    if (s < 0) break;
    let start = s + 6;
    if (raw[start] === 0x0d) start++;
    if (raw[start] === 0x0a) start++;
    const e = raw.indexOf("endstream", start, "latin1");
    if (e < 0) break;
    let body = raw.subarray(start, e);
    try {
      body = inflateSync(body);
    } catch {
      /* not compressed, or not a content stream */
    }
    for (const m of body.toString("latin1").matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) out.push(new TextDecoder("windows-1252").decode(Buffer.from(m[1], "hex")));
    at = e + 9;
  }
  return out;
}

const BRAND = {
  companyName: "Harmon Electric",
  logoUrl: "https://cdn.example.com/logo.png",
  logoBytes: Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACgAAAAQCAIAAADrtar6AAAAIElEQVR4nGPgV3QYEMQwavGoxaMWj1o8avGoxaMWwxAAiw4YEPdwm6sAAAAASUVORK5CYII=", "base64")),
  logoKind: "png",
  tagline: "We keep the energy flowing.",
  addressLine: "945 W Deer Valley Rd  Phoenix, AZ 85027",
  phone: "(602) 555-0199",
  email: "service@example.com",
  licenseLine: "280246 KB1",
  websiteUrl: "https://harmon.example.com",
  termsUrl: "https://harmon.example.com/terms",
};
const HOMEOWNER = "a1P000000HOMEOWNAA";
const SUNRUN = "a1P000000SUNRUNXAA";
const job = {
  Id: "a1X000000000JOB1AA",
  Name: "SVC-02108",
  Sundial_Customer__c: HOMEOWNER,
  Customer_Name_at_Creation__c: "Mark Haughn",
  Address_at_Creation__c: "25825 N 134th Drive, Peoria, AZ, 85383",
  Primary_Phone_at_Creation__c: "623-555-0142",
  Primary_Email_at_Creation__c: "mark@example.com",
  Customer_Summary__c: "Replaced the failed optimizer on string 2; production verified.",
};
const lines = [
  { Description__c: "Standard truck roll", Quantity__c: 1, Unit_Price__c: 275, Line_Total__c: 275, Stage__c: "Approved" },
  { Description__c: "Optimizer replacement", Quantity__c: 2, Unit_Price__c: 395, Line_Total__c: 790, Stage__c: "Approved" },
];
const estimate = { Tax_Jurisdiction__c: "Peoria" };
const issued = { Name: "SVC-02108", Status__c: "Issued", Subtotal__c: 1065, Discount_Amount__c: 0, Tax_Rate__c: 8.1, Tax_Amount__c: 86.27, Total__c: 1151.27, Paid_Amount__c: 0, Issued_At__c: "2026-09-25T17:00:00Z", Due_Date__c: "2026-10-02" };

const homeownerInvoice = { ...issued, Bill_To_Type__c: "Customer", Bill_To_Customer__c: HOMEOWNER, Bill_To_Name__c: "Mark Haughn", Bill_To_Address__c: "25825 N 134th Drive, Peoria, AZ 85383" };
const companyInvoice = { ...issued, Bill_To_Type__c: "Leasing Partner", Bill_To_Customer__c: SUNRUN, Bill_To_Name__c: "SunRun", Bill_To_Address__c: "Po Box 53940, Phoenix, AZ 85072", Billing_Reference__c: "SR-77120" };
const apsInvoice = { ...issued, Bill_To_Type__c: "Other", Bill_To_Customer__c: "a1P000000APSXXXXAA", Bill_To_Name__c: "APS", Bill_To_Address__c: "Po Box 53940, Phoenix, AZ 85072", Billing_Reference__c: "APS-259358" };
const sunrunPayer = { Id: SUNRUN, Is_Company__c: true, Company_Name__c: "SunRun", First_Name__c: "Dana", Last_Name__c: "Ruiz" };
const apsPayer = { Id: "a1P000000APSXXXXAA", Is_Company__c: true, Company_Name__c: "APS" };

const build = (invoice, extra = {}) => buildInvoiceModel({ invoice, job, estimate, lines, payments: [], serviceDate: "2026-09-24", brand: BRAND, options: { mode: "pdf" }, ...extra });
const texts = (m) => m.left.lines.map((l) => l.text);
const block = (m, label) => m.rightBlocks.find((b) => b.label === label);

async function painted(model) {
  const { html } = renderEstimateDocument({ model });
  const pdf = pdfText(await renderEstimatePdf(model));
  return { html, pdf, pdfJoined: pdf.join("\n") };
}

test("header: the logo, then the company name UNDER it — on the page and in the PDF", async () => {
  const m = build(homeownerInvoice);
  assert.equal(m.brand.companyName, "Harmon Electric");
  const { html, pdf } = await painted(m);
  assert.match(html, /<img class="logo" src="https:\/\/cdn\.example\.com\/logo\.png"[^>]*><div class="co">Harmon Electric<\/div>/);
  assert.equal(pdf[0], "Harmon Electric", "the first text drawn after the logo is the company name");
  // A brand with no name configured prints NOTHING under the logo (never "Invoice").
  const nameless = build(homeownerInvoice, { brand: { ...BRAND, companyName: "" } });
  assert.equal(nameless.brand.companyName, "");
  assert.ok(!renderEstimateDocument({ model: nameless }).html.includes('class="co"'));
  assert.notEqual(pdfText(await renderEstimatePdf(nameless))[0], "Invoice");
});

test("meta box: INVOICE · SERVICE DATE · PAYMENT TERMS (Upon receipt by default) · DUE DATE, then AMOUNT DUE", async () => {
  const m = build(homeownerInvoice);
  assert.deepEqual(m.meta.slice(0, 4), [
    { label: "Invoice", value: "SVC-02108" },
    { label: "Service date", value: "Sep 24, 2026" },
    { label: "Payment terms", value: "Upon receipt" },
    { label: "Due date", value: "Oct 2, 2026" },
  ]);
  assert.deepEqual(m.metaTotal, { label: "Amount due", value: "$1,151.27" });
  assert.equal(build(homeownerInvoice, { brand: { ...BRAND, paymentTerms: "Net 15" } }).meta[2].value, "Net 15", "the tenant's default wins");
  const { html, pdf } = await painted(m);
  assert.match(html, /<span class="k">Payment terms<\/span><span class="v">Upon receipt<\/span>/);
  for (const s of ["INVOICE", "SERVICE DATE", "PAYMENT TERMS", "Upon receipt", "DUE DATE", "AMOUNT DUE", "$1,151.27"]) assert.ok(pdf.includes(s), `PDF draws ${s}`);
});

test("payer = homeowner: the homeowner is the left block, no SERVICE ADDRESS, CONTACT US stays", async () => {
  const m = build(homeownerInvoice);
  assert.deepEqual(texts(m), ["Mark Haughn", "25825 N 134th Drive", "Peoria, AZ 85383", "623-555-0142", "mark@example.com"]);
  assert.equal(m.left.lines[0].bold, true);
  assert.equal(block(m, "Service address"), undefined);
  assert.deepEqual(block(m, "Contact us").lines, ["945 W Deer Valley Rd", "Phoenix, AZ 85027", "(602) 555-0199", "service@example.com"]);
  const { html, pdf } = await painted(m);
  assert.equal((html.match(/Mark Haughn/g) || []).length, 1, "the homeowner is printed once");
  assert.equal(pdf.filter((s) => s === "Mark Haughn").length, 1);
  assert.ok(!pdf.includes("SERVICE ADDRESS"));
  assert.ok(pdf.includes("CONTACT US"));
});

test("payer = company with a contact: name, Attn, address, Ref on the left; the homeowner under SERVICE ADDRESS", async () => {
  const m = build(companyInvoice, { payer: sunrunPayer });
  assert.deepEqual(texts(m), ["SunRun", "Attn: Dana Ruiz", "Po Box 53940", "Phoenix, AZ 85072", "Ref SR-77120"]);
  assert.deepEqual(block(m, "Service address").lines, ["Mark Haughn", "25825 N 134th Drive", "Peoria, AZ 85383", "623-555-0142", "mark@example.com"]);
  assert.deepEqual(m.rightBlocks.map((b) => b.label), ["Service address", "Contact us"]);
  const { html, pdf } = await painted(m);
  assert.ok(html.includes("Attn: Dana Ruiz"));
  assert.ok(html.indexOf("SunRun") < html.indexOf("Service address"), "bill-to on the left, before the right column");
  for (const s of ["SunRun", "Attn: Dana Ruiz", "Po Box 53940", "Phoenix, AZ 85072", "Ref SR-77120", "SERVICE ADDRESS", "Mark Haughn", "CONTACT US"]) assert.ok(pdf.includes(s), `PDF draws ${s}`);
});

test("payer = company with no contact, with a reference: no Attn line, Ref last", async () => {
  const m = build(apsInvoice, { payer: apsPayer });
  assert.deepEqual(texts(m), ["APS", "Po Box 53940", "Phoenix, AZ 85072", "Ref APS-259358"]);
  assert.ok(block(m, "Service address"));
  const { pdf } = await painted(m);
  assert.ok(!pdf.some((s) => s.startsWith("Attn:")));
  assert.ok(pdf.includes("Ref APS-259358"));
});

test("a partner invoice issued before D-081 (name, no payer record) still prints the name", () => {
  const legacy = { ...issued, Bill_To_Type__c: "Leasing Partner", Bill_To_Name__c: "SunRun" };
  const m = build(legacy);
  assert.deepEqual(texts(m), ["SunRun"]);
  assert.ok(block(m, "Service address"));
});

test("totals: Subtotal, Total tax with the jurisdiction beneath, Total, Balance due (the big one)", () => {
  const m = build(homeownerInvoice);
  assert.deepEqual(
    m.totalRows.map((r) => [r.label, r.amount, !!r.strong, !!r.big, !!r.sub]),
    [
      ["Subtotal", "$1,065.00", false, false, false],
      ["Total tax", "$86.27", false, false, false],
      ["Peoria (8.1%)", "$86.27", false, false, true],
      ["Total", "$1,151.27", true, false, false],
      ["Balance due", "$1,151.27", true, true, false],
    ]
  );
});

test("a Paid invoice: Paid to date + Balance rows, PAID watermark, status in the meta box, AMOUNT DUE $0.00", async () => {
  const paid = { ...homeownerInvoice, Status__c: "Paid", Paid_Amount__c: 1151.27, Paid_At__c: "2026-09-30T18:00:00Z" };
  const m = build(paid);
  assert.deepEqual(m.totalRows.slice(-2).map((r) => [r.label, r.amount]), [["Paid to date", "-$1,151.27"], ["Balance", "$0.00"]]);
  assert.equal(m.watermark, "PAID");
  assert.deepEqual(m.meta.at(-1), { label: "Status", value: "PAID Sep 30, 2026" });
  assert.deepEqual(m.metaTotal, { label: "Amount due", value: "$0.00" });
  const { html, pdf } = await painted(m);
  assert.ok(html.includes('class="wm">PAID'));
  for (const s of ["PAID", "Paid to date", "Balance", "Thank you — this invoice is paid in full."]) assert.ok(pdf.includes(s), `PDF draws ${s}`);
  // VOID: no AMOUNT DUE row.
  assert.equal(build({ ...homeownerInvoice, Status__c: "Void" }).metaTotal, null);
});

test("table + footer: the Services columns, the tagline, the terms line, and 'Harmon Electric | license', website, '1 of 1'", async () => {
  const m = build(homeownerInvoice);
  assert.deepEqual(m.columns, { description: "Services", qty: "qty", unit: "unit price", amount: "amount" });
  const { html, pdf } = await painted(m);
  assert.ok(html.includes("We keep the energy flowing."));
  assert.ok(html.includes('See our Terms &amp; Conditions (<a href="https://harmon.example.com/terms">'));
  assert.ok(html.includes("Harmon Electric | 280246 KB1"));
  for (const s of ["Services", "unit price", "INVOICE", "Replaced the failed optimizer on string 2; production verified.", "We keep the energy flowing.", "See our Terms & Conditions (https://harmon.example.com/terms)", "Harmon Electric | 280246 KB1", "harmon.example.com", "1 of 1"]) {
    assert.ok(pdf.includes(s), `PDF draws ${s}`);
  }
});

test("the estimate and the job report wear the same header: name under the logo, meta box, CONTACT US", async () => {
  const est = buildEstimateModel({ estimate: { Name: "EST-0101", Version__c: 1, Customer_Name_at_Creation__c: "Mark Haughn", Address_at_Creation__c: "1 Main St, Peoria, AZ, 85383" }, lines, totals: { subtotal: 1065, total: 1065 }, brand: BRAND, options: { mode: "pdf" } });
  assert.deepEqual(est.metaTotal, { label: "Estimate total", value: "$1,065.00" });
  const estPdf = pdfText(await renderEstimatePdf(est));
  assert.equal(estPdf[0], "Harmon Electric");
  assert.ok(estPdf.includes("ESTIMATE") && estPdf.includes("CONTACT US") && estPdf.includes("1 of 1"));

  const rep = buildJobReportModel({ job, report: { sections: [], receipt: true, intro: "" }, brand: BRAND, serviceDate: "2026-09-24", options: { mode: "pdf" } });
  assert.deepEqual(rep.meta.slice(0, 2), [{ label: "Job", value: "SVC-02108" }, { label: "Service date", value: "Sep 24, 2026" }]);
  assert.ok(renderJobReportDocument({ model: rep }).html.includes('<div class="co">Harmon Electric</div>'));
  const repPdf = pdfText(await renderJobReportPdf(rep));
  assert.equal(repPdf[0], "Harmon Electric");
  assert.ok(repPdf.includes("SUMMARY OF WORK") && repPdf.includes("CONTACT US"));
});
