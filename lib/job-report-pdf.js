// lib/job-report-pdf.js — the PDF painter for the customer's job report + receipt.
//
// Paints the SAME model lib/job-report-document.js builds; never decides what is shown.
// The header, the receipt's table and totals and the footer are the shared frame in
// lib/document-pdf.js (D-081, 2026-10-07), so the report prints as the same family as the
// estimate and the invoice; only the photo sections are drawn here.
//
// The photos are embedded from their bytes: `images` maps a section's photoKey to
// { bytes, contentType }. JPEG and PNG embed natively; anything else (a HEIC that slipped
// through, a photo that could not be fetched) leaves a labelled placeholder rather than
// failing the send — the hosted page still shows every photo, and it is the document of
// record. Photos are drawn at up to the content width, scaled to keep their aspect ratio,
// and a section always keeps its photo and caption together (a new page rather than a split).

import {
  createPen, drawHeader, drawBody, drawItemsTable, drawTotals, drawFooterContent, stampPageFooters,
  wrap, CONTENT_W, MARGIN, PAGE, GREY, LIGHT,
} from "./document-pdf.js";

const MAX_PHOTO_H = 380;

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
  const pen = await createPen(model);
  const { doc } = pen;

  await drawHeader(pen, model);
  drawBody(pen, model.summaryLabel, model.summary);
  if (model.intro) {
    pen.y -= 4;
    pen.paragraph(model.intro, { size: 10 });
  }

  // --- Sections: photo + caption, kept together -------------------------------
  if (model.sections.length) {
    pen.ensure(30);
    pen.y -= 8;
    pen.label("What we found and did", MARGIN, 8);
    pen.y -= 12;
  }
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
    const capLines = s.caption ? wrap(pen.safe(s.caption), pen.font, 10, CONTENT_W) : [];
    const needed = (dims ? dims.h + 8 : s.photoKey ? 24 : 0) + (s.visitLabel ? 12 : 0) + capLines.length * 13 + 16;
    if (pen.y - Math.min(needed, PAGE.height - MARGIN * 2) < MARGIN) pen.newPage();
    pen.y -= 6;
    if (dims) {
      pen.page.drawImage(img, { x: MARGIN, y: pen.y - dims.h, width: dims.w, height: dims.h });
      pen.y -= dims.h + 4;
    } else if (s.photoKey) {
      pen.page.drawRectangle({ x: MARGIN, y: pen.y - 20, width: CONTENT_W, height: 20, borderColor: LIGHT, borderWidth: 1 });
      pen.page.drawText(pen.safe("Photo — see the online report"), { x: MARGIN + 6, y: pen.y - 14, size: 9, font: pen.font, color: GREY });
      pen.y -= 24;
    }
    if (s.visitLabel) {
      pen.text(s.visitLabel, MARGIN, 8, { color: GREY });
      pen.y -= 12;
    }
    for (const l of capLines) {
      pen.ensure(16);
      pen.text(l, MARGIN, 10);
      pen.y -= 13;
    }
    pen.y -= 10;
  }

  // --- Receipt: the invoice's own rows and totals -----------------------------
  if (model.receipt) {
    const r = model.receipt;
    pen.ensure(90);
    pen.y -= 8;
    pen.label(`${r.label} · ${r.number}`, MARGIN, 8);
    pen.y -= 12;
    drawItemsTable(pen, r.columns, r.rows, { emptyText: "No line items" });
    drawTotals(pen, r.totalRows);
    for (const l of r.paymentLines) {
      pen.ensure(14);
      pen.textRight(l, PAGE.width - MARGIN, 9, { color: GREY });
      pen.y -= 12;
    }
    if (r.note) {
      pen.ensure(18);
      pen.y -= 4;
      pen.textRight(r.note, PAGE.width - MARGIN, 10, { bold: true });
      pen.y -= 14;
    }
  }

  drawFooterContent(pen, model, model.pdfUrl ? [`Online copy: ${model.pdfUrl}`] : []);
  stampPageFooters(pen, model);
  return doc.save();
}
