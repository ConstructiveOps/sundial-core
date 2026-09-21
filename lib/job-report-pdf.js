// lib/job-report-pdf.js — the PDF painter for the customer's job report + receipt.
//
// Paints the SAME model lib/job-report-document.js builds; never decides what is shown.
// pdf-lib (pure JS, bundles into the single-file Lambda) with the photos embedded from
// their bytes: `images` maps a section's photoKey to { bytes, contentType }. JPEG and PNG
// embed natively; anything else (a HEIC that slipped through, a photo that could not be
// fetched) leaves a labelled placeholder rather than failing the send — the hosted page
// still shows every photo, and it is the document of record.
//
// Photos are drawn at up to the content width, scaled to keep their aspect ratio, and a
// section always keeps its photo and caption together (a new page rather than a split).

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { pdfSafe, wrap } from "./estimate-pdf.js";

const PAGE = { width: 612, height: 792 };
const MARGIN = 44;
const CONTENT_W = PAGE.width - MARGIN * 2;
const MAX_PHOTO_H = 380;
const COLS = { desc: 0.58, qty: 0.12, unit: 0.15, amount: 0.15 };

const hex = (h) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h || "");
  return m ? rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255) : rgb(0.12, 0.22, 0.39);
};
const GREY = rgb(0.44, 0.44, 0.48);
const LIGHT = rgb(0.89, 0.89, 0.91);
const INK = rgb(0.09, 0.09, 0.11);

/** JPEG / PNG sniffed from the bytes (content types from S3 lie often enough). */
export function imageKind(bytes, contentType = "") {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 7 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("png")) return "png";
  return null;
}

/**
 * @param {object} model   buildJobReportModel() output
 * @param {Map<string,{bytes:Uint8Array,contentType?:string}>} [images]  photoKey → bytes
 * @returns {Promise<Uint8Array>}
 */
export async function renderJobReportPdf(model, images = new Map()) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const accent = hex(model.brand.accentColor);
  doc.setTitle(model.title);
  doc.setProducer("Sundial");
  doc.setCreator("Sundial");

  let page = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;
  const safe = (s) => pdfSafe(s, font);
  const text = (s, x, size, opts = {}) => page.drawText(safe(s), { x, y: y - size, size, font: opts.bold ? bold : font, color: opts.color || INK });
  const textRight = (s, rightX, size, opts = {}) => {
    const f = opts.bold ? bold : font;
    const w = f.widthOfTextAtSize(safe(s), size);
    page.drawText(safe(s), { x: rightX - w, y: y - size, size, font: f, color: opts.color || INK });
  };
  const rule = (color = LIGHT, thickness = 1) => page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE.width - MARGIN, y }, thickness, color });
  const newPage = () => {
    page = doc.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN;
  };
  const ensure = (needed) => {
    if (y - needed < MARGIN) {
      newPage();
      return true;
    }
    return false;
  };
  const sectionLabel = (label) => {
    ensure(30);
    y -= 14;
    text(label.toUpperCase(), MARGIN, 8, { color: GREY });
    y -= 12;
  };
  const paragraph = (s, size = 10, color = INK, width = CONTENT_W, x = MARGIN) => {
    for (const l of wrap(safe(s), font, size, width)) {
      ensure(size + 4);
      page.drawText(l, { x, y: y - size, size, font, color });
      y -= size + 3;
    }
  };

  if (model.watermark) textRight(model.watermark, PAGE.width - MARGIN, 8, { color: GREY });

  // --- Header ----------------------------------------------------------------
  const headerTop = y;
  text(model.brand.companyName, MARGIN, 18, { bold: true, color: accent });
  y -= 22;
  for (const line of model.brand.lines) {
    text(line, MARGIN, 9, { color: GREY });
    y -= 12;
  }
  const leftBottom = y;
  y = headerTop;
  textRight(model.docLabel, PAGE.width - MARGIN, 9, { color: GREY });
  y -= 13;
  textRight(model.number, PAGE.width - MARGIN, 16, { bold: true });
  y -= 20;
  for (const line of model.metaLines) {
    textRight(line, PAGE.width - MARGIN, 9, { color: GREY });
    y -= 12;
  }
  y = Math.min(y, leftBottom) - 8;
  rule(accent, 2.5);

  // --- Prepared for / Summary of work ---------------------------------------
  const colW = (CONTENT_W - 24) / 2;
  const blockTop = y;
  sectionLabel(model.customerLabel);
  if (!model.customerLines.length) {
    text("No customer on this document", MARGIN, 10, { color: GREY });
    y -= 13;
  }
  for (const line of model.customerLines) for (const l of wrap(safe(line), font, 10, colW)) {
    text(l, MARGIN, 10);
    y -= 13;
  }
  const leftEnd = y;
  if (model.summary) {
    y = blockTop;
    const x = MARGIN + colW + 24;
    y -= 14;
    page.drawText(safe(model.summaryLabel.toUpperCase()), { x, y: y - 8, size: 8, font, color: GREY });
    y -= 12;
    for (const l of wrap(safe(model.summary), font, 10, colW)) {
      if (y - 13 < MARGIN) break;
      page.drawText(l, { x, y: y - 10, size: 10, font, color: INK });
      y -= 13;
    }
    y = Math.min(y, leftEnd);
  } else y = leftEnd;

  if (model.intro) {
    y -= 10;
    paragraph(model.intro, 10);
  }

  // --- Sections: photo + caption, kept together -------------------------------
  if (model.sections.length) sectionLabel("What we found and did");
  for (const s of model.sections) {
    let img = null;
    let dims = null;
    const src = s.photoKey ? images.get(s.photoKey) : null;
    if (src?.bytes) {
      try {
        const kind = imageKind(src.bytes, src.contentType);
        if (kind === "jpg") img = await doc.embedJpg(src.bytes);
        else if (kind === "png") img = await doc.embedPng(src.bytes);
      } catch (e) {
        console.error("job-report pdf: photo skipped:", s.photoKey, e?.message || e);
        img = null;
      }
    }
    if (img) {
      const scale = Math.min(CONTENT_W / img.width, MAX_PHOTO_H / img.height, 1);
      dims = { w: img.width * scale, h: img.height * scale };
    }
    const capLines = s.caption ? wrap(safe(s.caption), font, 10, CONTENT_W) : [];
    const needed = (dims ? dims.h + 8 : s.photoKey ? 24 : 0) + (s.visitLabel ? 12 : 0) + capLines.length * 13 + 16;
    if (y - Math.min(needed, PAGE.height - MARGIN * 2) < MARGIN) newPage();
    y -= 6;
    if (dims) {
      page.drawImage(img, { x: MARGIN, y: y - dims.h, width: dims.w, height: dims.h });
      y -= dims.h + 4;
    } else if (s.photoKey) {
      page.drawRectangle({ x: MARGIN, y: y - 20, width: CONTENT_W, height: 20, borderColor: LIGHT, borderWidth: 1 });
      page.drawText(safe("Photo — see the online report"), { x: MARGIN + 6, y: y - 14, size: 9, font, color: GREY });
      y -= 24;
    }
    if (s.visitLabel) {
      text(s.visitLabel, MARGIN, 8, { color: GREY });
      y -= 12;
    }
    for (const l of capLines) {
      ensure(16);
      text(l, MARGIN, 10);
      y -= 13;
    }
    y -= 10;
  }

  // --- Receipt ---------------------------------------------------------------
  if (model.receipt) {
    const r = model.receipt;
    const xQty = MARGIN + CONTENT_W * COLS.desc + CONTENT_W * COLS.qty;
    const xUnit = xQty + CONTENT_W * COLS.unit;
    const xAmt = MARGIN + CONTENT_W;
    const descW = CONTENT_W * COLS.desc - 8;
    ensure(80);
    sectionLabel(`${r.label} · ${r.number}`);
    const tableHeader = () => {
      text(r.columns.description, MARGIN, 8, { color: GREY });
      textRight(r.columns.qty, xQty, 8, { color: GREY });
      if (r.columns.unit) textRight(r.columns.unit, xUnit, 8, { color: GREY });
      textRight(r.columns.amount, xAmt, 8, { color: GREY });
      y -= 12;
      rule(LIGHT, 1);
      y -= 4;
    };
    tableHeader();
    for (const row of r.rows) {
      const descLines = wrap(safe(row.description), font, 10, descW);
      const h = Math.max(1, descLines.length) * 13 + 8;
      if (ensure(h + 20)) tableHeader();
      y -= 4;
      const top = y;
      for (const l of descLines) {
        text(l, MARGIN, 10);
        y -= 13;
      }
      const bottom = y;
      y = top;
      textRight(row.qty, xQty, 10);
      if (row.unit) textRight(row.unit, xUnit, 10);
      textRight(row.amount, xAmt, 10);
      y = bottom - 4;
      rule(rgb(0.95, 0.95, 0.96), 0.75);
    }
    ensure(r.totalRows.length * 18 + 30);
    y -= 6;
    for (const t of r.totalRows) {
      if (t.strong) {
        y -= 4;
        rule(INK, 1.5);
        y -= 6;
      }
      const size = t.strong ? 13 : 10;
      textRight(t.amount, xAmt, size, { bold: t.strong });
      page.drawText(safe(t.label), { x: xQty - CONTENT_W * COLS.qty, y: y - size, size, font: t.strong ? bold : font, color: INK });
      y -= size + 6;
    }
    for (const l of r.paymentLines) {
      ensure(14);
      text(l, MARGIN, 9, { color: GREY });
      y -= 12;
    }
    if (r.note) {
      ensure(18);
      y -= 4;
      text(r.note, MARGIN, 10, { bold: true });
      y -= 14;
    }
  }

  // --- Footer ----------------------------------------------------------------
  const footerLines = [];
  for (const n of model.footerNotes) footerLines.push(...wrap(safe(n), font, 8, CONTENT_W));
  if (model.brand.termsUrl) footerLines.push(...wrap(`Terms and conditions: ${model.brand.termsUrl}`, font, 8, CONTENT_W));
  if (model.pdfUrl) footerLines.push(...wrap(`Online copy: ${model.pdfUrl}`, font, 8, CONTENT_W));
  ensure(footerLines.length * 11 + 20);
  y -= 16;
  rule(LIGHT, 1);
  y -= 8;
  for (const l of footerLines) {
    text(l, MARGIN, 8, { color: GREY });
    y -= 11;
  }

  const pages = doc.getPages();
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const s = `${model.title} · page ${i + 1} of ${pages.length}`;
      p.drawText(safe(s), { x: PAGE.width - MARGIN - font.widthOfTextAtSize(safe(s), 8), y: MARGIN / 2, size: 8, font, color: GREY });
    });
  }
  return doc.save();
}
