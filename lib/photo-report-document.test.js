// lib/photo-report-document.js + lib/photo-report-pdf.js (D-072 amendment 17): the normaliser and
// its caps, every "a blank leaves no trace" case, list vs grid, the header (customer vs a partner
// payer), the receipt rule (off by default, never for a partner), and the PDF: every photo drawn,
// none split across a page, a section heading never alone at the bottom, and NO placeholder —
// a missing photo refuses the render.

import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import jpeg from "jpeg-js";
import { PDFDocument } from "pdf-lib";
import {
  normalizePhotoReport, buildPhotoReportModel, renderPhotoReportDocument, photoReportChoices, reportPhotoKeys, isPhotoReportEmpty,
  withoutMissingPhotos, photoReportTitle, photoReportFileName, reportImageCacheKey, emptyPhotoReport, MAX_SECTIONS, MAX_PHOTOS,
} from "./photo-report-document.js";
import { renderPhotoReportPdf, PhotoNotReadyError } from "./photo-report-pdf.js";
import { reportImageCacheKey as oldReportCacheKey } from "../lambdas/sundial-service-estimate/report.js";
import { thumbKey } from "./photo-thumbs.js";
import { MARGIN, PAGE } from "./document-pdf.js";

const JOB = "a1c7y00000RwICvAAN";
const P = (n) => `SUNDIAL/${JOB}/photos/a1d000000000001AAA/p${n}.jpg`;
const job = {
  Id: JOB, Name: "SVC-02108", Bill_To_Type__c: "Customer", Customer_Name_at_Creation__c: "Ivy Customer",
  Address_at_Creation__c: "5 Fir Ln, Mesa, AZ 85201", Primary_Email_at_Creation__c: "ivy@example.com", Primary_Phone_at_Creation__c: "602-555-0101",
};

/** A real JPEG of w × h (for layout tests: pdf-lib reads the size from it). */
function jpg(w, h) {
  const data = Buffer.alloc(w * h * 4, 0x80);
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, 50).data);
}

/** Per content stream: its Tj strings and its image placements (x, y, w, h). */
function pdfPages(bytes) {
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
    try { body = inflateSync(body); } catch { /* not compressed */ }
    const txt = body.toString("latin1");
    const text = [...txt.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)].map((m) => new TextDecoder("windows-1252").decode(Buffer.from(m[1], "hex")));
    // pdf-lib places an image as: q / 1 0 0 1 x y cm / … / w 0 0 h 0 0 cm / … / /Image-n Do / Q
    const images = [...txt.matchAll(/q\n1 0 0 1 ([-\d.]+) ([-\d.]+) cm\n(?:[^\n]*\n)*?([-\d.]+) 0 0 ([-\d.]+) 0 0 cm\n(?:[^\n]*\n)*?\/(\S+) Do\nQ/g)].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], name: m[5] }));
    if (text.length || images.length) out.push({ text, images, raw: txt });
    at = e + 9;
  }
  return out;
}

// --- normalising ------------------------------------------------------------------------------
test("normalize: unknown keys dropped, layout defaulted, text capped, empty sections dropped, receipt OFF by default", () => {
  const n = normalizePhotoReport({
    junk: 1,
    cover: { title: "x".repeat(300), scope: "  Swap the inverter.  ", coverPhotoKey: P(1), extra: true },
    sections: [
      { id: "a", name: "Before", description: "", layout: "sideways", photos: [{ key: P(1), description: "y".repeat(600), other: 1 }] },
      { id: "b", name: "", description: "", photos: [] }, // nothing in it: dropped
      { name: "Notes only", photos: [] },                   // a heading alone is kept
      { id: "a", photos: [P(2)] },                          // duplicate id made unique; a bare key string is accepted
    ],
  }, { jobId: JOB });
  assert.equal(n.ok, true, n.error);
  const v = n.value;
  assert.equal(v.version, 2);
  assert.equal(v.receipt, false, "the photo report's receipt is off until ticked");
  assert.deepEqual(Object.keys(v.cover).sort(), ["coverPhotoKey", "scope", "title"]);
  assert.equal(v.cover.title.length, 200);
  assert.equal(v.cover.scope, "Swap the inverter.");
  assert.equal(v.sections.length, 3);
  assert.equal(v.sections[0].layout, "list");
  assert.deepEqual(Object.keys(v.sections[0].photos[0]).sort(), ["description", "key"]);
  assert.equal(v.sections[0].photos[0].description.length, 500);
  assert.equal(v.sections[1].name, "Notes only");
  assert.notEqual(v.sections[2].id, "a");
  assert.deepEqual(v.sections[2].photos, [{ key: P(2), description: "" }]);
  assert.equal(normalizePhotoReport({ receipt: true }).value.receipt, true);
  assert.equal(normalizePhotoReport({ receipt: "yes" }).value.receipt, false, "only a real true ticks it");
});

test("normalize: the caps and the key rules", () => {
  assert.equal(normalizePhotoReport({ sections: Array.from({ length: MAX_SECTIONS + 1 }, (_, i) => ({ name: `s${i}` })) }).ok, false);
  const many = Array.from({ length: 4 }, () => ({ photos: Array.from({ length: 76 }, (_, k) => P(k)) })); // 304
  const r = normalizePhotoReport({ sections: many }, { jobId: JOB });
  assert.equal(r.ok, false);
  assert.match(r.error, new RegExp(`${MAX_PHOTOS} photos`));
  assert.equal(normalizePhotoReport({ sections: [{ photos: Array.from({ length: 300 }, (_, k) => P(k)) }] }, { jobId: JOB }).ok, true, "exactly 300 is fine");
  for (const bad of ["SUNDIAL/a1cOTHERJOB0000001/photos/x.jpg", `SUNDIAL/${JOB}/estimate-v1.pdf`, `SUNDIAL/${JOB}/photos/../x.jpg`, "photos/x.jpg"]) {
    assert.equal(normalizePhotoReport({ sections: [{ photos: [bad] }] }, { jobId: JOB }).ok, false, bad);
    assert.equal(normalizePhotoReport({ cover: { coverPhotoKey: bad } }, { jobId: JOB }).ok, false, `cover ${bad}`);
  }
  assert.equal(normalizePhotoReport("not json").ok, false);
  assert.equal(normalizePhotoReport([]).ok, false);
  assert.equal(normalizePhotoReport({ sections: "x" }).ok, false);
  assert.equal(normalizePhotoReport(null).ok, true);
});

test("the same photo may sit in two sections; the key list is the cover first, each once", () => {
  const v = normalizePhotoReport({ cover: { coverPhotoKey: P(3) }, sections: [{ photos: [P(1), P(3)] }, { photos: [P(1)] }] }, { jobId: JOB }).value;
  assert.deepEqual(reportPhotoKeys(v), [P(3), P(1)]);
});

test("empty means nothing a customer could read; a photo deleted since it was picked is taken out", () => {
  assert.equal(isPhotoReportEmpty(emptyPhotoReport()), true);
  assert.equal(isPhotoReportEmpty(normalizePhotoReport({ sections: [{ name: "Heading only" }] }).value), true, "a heading with no photos is not a report");
  assert.equal(isPhotoReportEmpty(normalizePhotoReport({ cover: { scope: "We fixed it." } }).value), false);
  const v = normalizePhotoReport({ cover: { coverPhotoKey: P(9) }, sections: [{ photos: [P(9)] }, { name: "Keep", photos: [P(9), P(1)] }] }, { jobId: JOB }).value;
  const { report, missing } = withoutMissingPhotos(v, new Set([P(1)]));
  assert.deepEqual(missing, [P(9)]);
  assert.equal(report.cover.coverPhotoKey, null);
  assert.equal(report.sections.length, 1, "a section left with nothing is dropped");
  assert.deepEqual(report.sections[0].photos.map((p) => p.key), [P(1)]);
});

test("the cache key is the old report's (one shrunk copy serves both); choices group by call with thumb / large urls", () => {
  assert.equal(reportImageCacheKey(JOB, P(1)), oldReportCacheKey(JOB, P(1)));
  const files = [
    { key: P(1), fileName: "photos/a1d000000000001AAA/p1.jpg", publicUrl: "https://s3/p1.jpg", size: 1, lastModified: "2026-11-01T10:00:00Z" },
    { key: `SUNDIAL/${JOB}/photos/office.heic`, fileName: "photos/office.heic", publicUrl: "https://s3/o.heic", size: 1, lastModified: "2026-11-02T10:00:00Z" },
    { key: `SUNDIAL/${JOB}/estimate-v1.pdf`, fileName: "estimate-v1.pdf", publicUrl: "https://s3/e.pdf", size: 1, lastModified: "2026-11-01T10:00:00Z" },
    { key: `SUNDIAL/${JOB}/photos/notes.txt`, fileName: "photos/notes.txt", publicUrl: "https://s3/n.txt", size: 1, lastModified: "2026-11-01T10:00:00Z" },
  ];
  const calls = [{ Id: "a1d000000000001AAA", Name: "SC-00001", Scheduled_Start__c: "2026-11-01T16:00:00Z", Tech__r: { First_Name__c: "Paige", Last_Name__c: "King" } }];
  const c = photoReportChoices({ files, jobId: JOB, calls, cachedKeys: new Set([reportImageCacheKey(JOB, P(1))]), thumbKeys: new Set([thumbKey(JOB, P(1))]) });
  assert.equal(c.total, 2, "images only");
  assert.deepEqual(c.groups.map((g) => g.label), ["Office", "Paige King · Nov 1"]);
  const p1 = c.byKey.get(P(1));
  assert.equal(p1.fileName, "p1.jpg");
  assert.match(p1.thumbUrl, /photo-thumbs/);
  assert.match(p1.largeUrl, /report-images/);
  assert.equal(p1.embeddable, true);
  assert.equal(c.byKey.get(`SUNDIAL/${JOB}/photos/office.heic`).embeddable, false, "HEIC cannot go in the PDF");
});

// --- the header, the title ------------------------------------------------------------------
test("header: the customer pays → name + service address; a partner pays → the service address alone, never a payer name", () => {
  const cust = buildPhotoReportModel({ job, report: emptyPhotoReport() });
  assert.deepEqual(cust.left.lines.map((l) => l.text), ["Ivy Customer", "5 Fir Ln", "Mesa, AZ 85201"]);
  const blank = buildPhotoReportModel({ job: { ...job, Bill_To_Type__c: null }, report: emptyPhotoReport() });
  assert.equal(blank.left.lines[0].text, "Ivy Customer", "a blank type is the customer");
  for (const type of ["Leasing Partner", "Manufacturer", "Internal Warranty", "Other"]) {
    const m = buildPhotoReportModel({ job: { ...job, Bill_To_Type__c: type, Bill_To_Name__c: "SunRun" }, report: emptyPhotoReport() });
    assert.deepEqual(m.left.lines.map((l) => l.text), ["5 Fir Ln", "Mesa, AZ 85201"], type);
    const { html } = renderPhotoReportDocument({ model: m });
    assert.ok(!html.includes("SunRun") && !html.includes("Ivy Customer"), `${type}: no payer, no homeowner name`);
    assert.ok(!html.includes("Service address"), "the address is the block itself, not a second labelled one");
  }
  assert.equal(cust.title, "Photo report for 5 Fir Ln, Mesa, AZ 85201");
  assert.equal(photoReportTitle({ Name: "SVC-1" }), "Photo report for SVC-1");
  assert.equal(photoReportFileName(job), "Photo-report-for-5-Fir-Ln-Mesa-AZ-85201.pdf");
  assert.deepEqual(cust.rightBlocks.map((b) => b.label), ["Contact us"]);
});

// --- a blank leaves no trace ------------------------------------------------------------------
test("a blank leaves no trace: no cover photo, no title, no scope, no section name / description, no photo description", () => {
  const report = normalizePhotoReport({ sections: [{ layout: "list", photos: [{ key: P(1) }] }] }, { jobId: JOB }).value;
  const { html } = renderPhotoReportDocument({ job, report, options: { mode: "customer" } });
  assert.ok(!html.includes('class="cover"'), "no cover figure");
  assert.ok(!html.includes('class="ctitle"'), "no title");
  assert.ok(!/Scope of work/i.test(html), "no scope heading");
  assert.ok(!html.includes("<h3>") && !html.includes('class="sdesc"'), "no section heading or description");
  assert.ok(html.includes('class="row full"'), "a photo with no words takes the full width");
  assert.ok(!html.includes('class="tx"'), "no empty text column");
  assert.ok(!/placeholder|see the online|see the hosted/i.test(html));
  assert.ok(!html.includes("Prepared by"), "no sender, no line");
});

test("list vs grid: list draws each photo's words beside it; grid is three across and draws no words even when they exist", () => {
  const report = normalizePhotoReport({
    cover: { title: "Inverter swap", scope: "Replace the failed inverter.", coverPhotoKey: P(1) },
    sections: [
      { name: "Before", description: "What we found", layout: "list", photos: [{ key: P(1), description: "Burn marks on the DC side" }, { key: P(2) }] },
      { name: "After", layout: "grid", photos: [{ key: P(3), description: "NOT SHOWN IN GRID" }, { key: P(4) }, { key: P(5) }, { key: P(6) }] },
    ],
  }, { jobId: JOB }).value;
  const photos = new Map([[P(3), { key: P(3), publicUrl: "https://s3/p3.jpg", thumbUrl: "https://s3/t3.jpg", largeUrl: "https://s3/l3.jpg" }]]);
  const m = buildPhotoReportModel({ job, report, photos, preparedBy: { name: "Paige King", at: "2026-11-05T20:00:00Z" }, options: { mode: "customer" } });
  const { html } = renderPhotoReportDocument({ model: m });
  assert.ok(html.indexOf("Photo report for 5 Fir Ln") < html.indexOf('class="cover"'), "the title line, then the cover photo");
  assert.ok(html.indexOf('class="cover"') < html.indexOf("Inverter swap") && html.indexOf("Inverter swap") < html.indexOf("Replace the failed"), "cover order: photo, title, scope");
  assert.ok(html.includes("Prepared by Paige King · Nov 5, 2026"));
  assert.ok(html.includes("<h3>Before</h3>") && html.includes('<div class="sdesc">What we found</div>'));
  assert.ok(html.includes('<div class="tx">Burn marks on the DC side</div>'));
  assert.equal((html.match(/class="cell"/g) || []).length, 4);
  assert.ok(html.includes("grid-template-columns:repeat(3,1fr)"));
  assert.ok(!html.includes("NOT SHOWN IN GRID"), "grid shows no words");
  assert.ok(html.includes('src="https://s3/t3.jpg"'), "grid tiles use the thumbnail");
  assert.equal(m.sections[1].photos[0].description, "", "kept in the data, not in the model the painters draw");
  assert.equal(report.sections[1].photos[0].description, "NOT SHOWN IN GRID");
});

// --- the receipt ------------------------------------------------------------------------------
const invoice = { Id: "inv1", Name: "INV-1", Status__c: "Paid", Total__c: 275, Paid_Amount__c: 275, Subtotal__c: 275, Tax_Amount__c: 0, Bill_To_Type__c: "Customer" };
const lines = [{ Description__c: "Diagnostic", Quantity__c: 1, Unit_Price__c: 275, Line_Total__c: 275, Stage__c: "Approved" }];

test("receipt: off by default; ticked + a live invoice + the customer pays → the invoice's own rows; never for a partner", () => {
  const off = buildPhotoReportModel({ job, report: normalizePhotoReport({}).value, invoice, lines });
  assert.equal(off.receipt, null);
  const on = buildPhotoReportModel({ job, report: normalizePhotoReport({ receipt: true }).value, invoice, lines });
  assert.equal(on.receipt.label, "Receipt");
  assert.ok(on.receipt.rows.some((r) => r.description === "Diagnostic"));
  assert.equal(buildPhotoReportModel({ job: { ...job, Bill_To_Type__c: "Leasing Partner" }, report: normalizePhotoReport({ receipt: true }).value, invoice, lines }).receipt, null);
  assert.equal(buildPhotoReportModel({ job, report: normalizePhotoReport({ receipt: true }).value, invoice: { ...invoice, Status__c: "Void" }, lines }).receipt, null);
  assert.equal(buildPhotoReportModel({ job, report: normalizePhotoReport({ receipt: true }).value, invoice: null }).receipt, null);
});

// --- the PDF ----------------------------------------------------------------------------------
test("PDF: refuses to render with a photo missing — no placeholder, ever", async () => {
  const report = normalizePhotoReport({ sections: [{ photos: [P(1), P(2)] }] }, { jobId: JOB }).value;
  const model = buildPhotoReportModel({ job, report, options: { mode: "pdf" } });
  await assert.rejects(renderPhotoReportPdf(model, new Map([[P(1), { bytes: jpg(40, 30) }]])), (e) => e instanceof PhotoNotReadyError && e.code === "PHOTOS_NOT_READY" && e.keys[0] === P(2));
  await assert.rejects(renderPhotoReportPdf(model, new Map([[P(1), { bytes: jpg(40, 30) }], [P(2), { bytes: new Uint8Array([1, 2, 3, 4]) }]])), (e) => e instanceof PhotoNotReadyError && /JPEG/.test(e.message));
});

test("PDF: every photo drawn (a repeat embedded once), none split across a page, a heading kept with its first photos; the title is the metadata", async () => {
  const sections = [
    { name: "Before", description: "What we found on arrival", layout: "list", photos: [1, 2, 3, 4].map((n) => ({ key: P(n), description: n % 2 ? `Photo ${n} described` : "" })) },
    { name: "Grid of the work", layout: "grid", photos: [5, 6, 7, 8, 9, 10, 11].map((n) => ({ key: P(n) })) },
    { name: "After", description: "Everything back up", layout: "list", photos: [12, 13, 1].map((n) => ({ key: P(n), description: "" })) },
  ];
  const report = normalizePhotoReport({ cover: { title: "Inverter swap", scope: "Scope words.", coverPhotoKey: P(1) }, sections }, { jobId: JOB }).value;
  const model = buildPhotoReportModel({ job, report, preparedBy: { name: "Paige King", at: "2026-11-05T20:00:00Z" }, options: { mode: "pdf" } });
  const images = new Map(model.photoKeys.map((k, i) => [k, { bytes: jpg(i % 2 ? 300 : 400, i % 2 ? 400 : 300) }]));
  const bytes = await renderPhotoReportPdf(model, images);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getTitle(), "Photo report for 5 Fir Ln, Mesa, AZ 85201");
  const pages = pdfPages(bytes);
  const placed = pages.flatMap((p) => p.images);
  // the logo is absent in this test, so every placed image is a photo: cover + 4 + 7 + 3
  assert.equal(placed.length, 15);
  for (const im of placed) {
    assert.ok(im.y >= MARGIN - 0.5, `photo bottom ${im.y} under the margin`);
    assert.ok(im.y + im.h <= PAGE.height - MARGIN + 0.5, `photo top ${im.y + im.h} over the top margin`);
  }
  const text = pages.flatMap((p) => p.text).join(" | ");
  for (const t of ["Photo report for 5 Fir Ln, Mesa, AZ 85201", "Inverter swap", "SCOPE OF WORK", "Prepared by Paige King", "Before", "What we found on arrival", "Photo 1 described", "Grid of the work", "After"]) assert.ok(text.includes(t), t);
  assert.ok(!/see the online|Photo — see/i.test(text), "no placeholder text");
  // a heading never sits alone: every page that prints a section name also places a photo after it
  for (const p of pages) for (const name of ["Before", "Grid of the work", "After"]) if (p.text.includes(name)) assert.ok(p.raw.lastIndexOf("Do") > p.raw.indexOf(Buffer.from(name, "latin1").toString("hex").toUpperCase()) || p.images.length > 0, `${name} with its photos`);
  // P(1) is used three times (cover, Before, After) but embedded once
  // (a page names an image afresh each time, so count the image OBJECTS in the file instead)
  const imageObjects = (Buffer.from(bytes).toString("latin1").match(/\/Subtype\s*\/Image/g) || []).length;
  assert.equal(imageObjects, model.photoKeys.length, "one embedded image per distinct photo");
});

test("PDF: a section heading near the bottom of a page moves to the next page with its first photo", async () => {
  // A cover photo tall enough to leave too little room for a heading + a photo row.
  const report = normalizePhotoReport({ cover: { coverPhotoKey: P(1), scope: "x\n".repeat(10) }, sections: [{ name: "Moved section", photos: [{ key: P(2) }] }] }, { jobId: JOB }).value;
  const model = buildPhotoReportModel({ job, report, options: { mode: "pdf" } });
  const bytes = await renderPhotoReportPdf(model, new Map([[P(1), { bytes: jpg(300, 400) }], [P(2), { bytes: jpg(400, 300) }]]));
  const pages = pdfPages(bytes).filter((p) => p.images.length || p.text.length);
  const withHeading = pages.find((p) => p.text.includes("Moved section"));
  assert.ok(withHeading, "the heading is printed");
  assert.equal(withHeading.images.length, 1, "on the same page as its photo");
});
