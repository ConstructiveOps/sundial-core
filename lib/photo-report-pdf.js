// lib/photo-report-pdf.js — the PDF painter for the PHOTO REPORT (D-072 amendment 17).
//
// Paints the model lib/photo-report-document.js builds; never decides what is shown. The
// header, the receipt's table and totals and the footer are the shared frame
// (lib/document-pdf.js, D-081); the cover and the photo sections are drawn here.
//
// EVERY PHOTO IS IN THE PDF (Tim, 2026-11-05): `images` must carry the bytes of every key in
// model.photoKeys — the shrunk copies from the report-image cache. A photo that is missing,
// or that pdf-lib cannot embed, throws PhotoNotReadyError: there is NO placeholder and no
// "see the hosted page". The caller (sundial-service-estimate/photo-report.js) makes sure the
// cache is complete before it ever calls this.
//
// Page rules: a photo is never split across pages; a section's heading and description are
// kept with its first row of photos; a list row's description that is taller than the page
// carries on in its own column on the next page. A photo used twice is embedded once.

import { createPen, drawHeader, drawBody, drawItemsTable, drawTotals, drawFooterContent, stampPageFooters, wrap, CONTENT_W, MARGIN, PAGE, GREY } from "./document-pdf.js";
import { imageKind } from "./job-report-pdf.js";

export const COVER_MAX_H = 420;
export const FULL_MAX_H = 460;      // a list photo with no description, full width
export const LIST_PHOTO_FRACTION = 0.45;
export const LIST_GAP = 14;
export const LIST_MAX_H = 380;
export const GRID_COLS = 3;
export const GRID_GAP = 8;
const BODY = 10;
const LINE = 13;
const DESC = 11;                     // a section description: bold, one step above body
const DESC_LINE = 14.5;
const NAME = 13;
const USABLE_H = PAGE.height - MARGIN * 2;

export class PhotoNotReadyError extends Error {
  constructor(keys, why = "not prepared") {
    super(`${keys.length} photo(s) ${why}: the PDF is never made without every photo.`);
    this.name = "PhotoNotReadyError";
    this.code = "PHOTOS_NOT_READY";
    this.keys = keys;
  }
}

/**
 * @param {object} model   buildPhotoReportModel() output
 * @param {Map<string,{bytes:Uint8Array,contentType?:string}>} images  photo key → its shrunk copy
 * @returns {Promise<Uint8Array>}
 */
export async function renderPhotoReportPdf(model, images = new Map()) {
  const absent = model.photoKeys.filter((k) => !images.get(k)?.bytes?.length);
  if (absent.length) throw new PhotoNotReadyError(absent);

  const pen = await createPen(model);
  const { doc } = pen;
  const embedded = new Map();
  const unembeddable = [];
  for (const key of model.photoKeys) {
    const src = images.get(key);
    try {
      const kind = imageKind(src.bytes, src.contentType);
      const img = kind === "jpg" ? await doc.embedJpg(src.bytes) : kind === "png" ? await doc.embedPng(src.bytes) : null;
      if (!img) unembeddable.push(key);
      else embedded.set(key, img);
    } catch {
      unembeddable.push(key);
    }
  }
  if (unembeddable.length) throw new PhotoNotReadyError(unembeddable, "could not be read as JPEG / PNG");
  const fit = (key, maxW, maxH) => {
    const img = embedded.get(key);
    const s = Math.min(maxW / img.width, maxH / img.height);
    return { img, w: img.width * s, h: img.height * s };
  };
  const draw = (f, x) => pen.page.drawImage(f.img, { x, y: pen.y - f.h, width: f.w, height: f.h });

  await drawHeader(pen, model);

  // --- the cover --------------------------------------------------------------------------
  for (const l of wrap(pen.safe(model.heading, pen.bold), pen.bold, 16, CONTENT_W)) {
    pen.ensure(22);
    pen.text(l, MARGIN, 16, { bold: true });
    pen.y -= 21;
  }
  pen.y -= 6;
  if (model.cover.photo) {
    const f = fit(model.cover.photo.key, CONTENT_W, COVER_MAX_H);
    pen.ensure(f.h + 4);
    draw(f, MARGIN + (CONTENT_W - f.w) / 2);
    pen.y -= f.h + 16;
  }
  if (model.cover.title) {
    for (const l of wrap(pen.safe(model.cover.title, pen.bold), pen.bold, 18, CONTENT_W)) {
      pen.ensure(24);
      pen.text(l, MARGIN, 18, { bold: true });
      pen.y -= 23;
    }
    pen.y -= 6;
  }
  drawBody(pen, model.cover.scopeLabel, model.cover.scope);
  if (model.cover.prepared) {
    pen.ensure(16);
    pen.y -= 4;
    pen.text(model.cover.prepared, MARGIN, 9, { color: GREY });
    pen.y -= 14;
  }

  // --- the sections -----------------------------------------------------------------------
  const listW = CONTENT_W * LIST_PHOTO_FRACTION;
  const textX = MARGIN + listW + LIST_GAP;
  const textW = CONTENT_W - listW - LIST_GAP;
  const cellW = (CONTENT_W - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;

  /** The rows of a section, each { h, paint() }, so the heading can be kept with the first. */
  function rowsOf(s) {
    if (s.layout === "grid") {
      const rows = [];
      for (let i = 0; i < s.photos.length; i += GRID_COLS) {
        const cells = s.photos.slice(i, i + GRID_COLS).map((p) => fit(p.key, cellW, cellW));
        const h = Math.max(...cells.map((c) => c.h));
        rows.push({ h, paint: () => { cells.forEach((c, k) => draw(c, MARGIN + k * (cellW + GRID_GAP) + (cellW - c.w) / 2)); pen.y -= h + GRID_GAP; } });
      }
      return rows;
    }
    return s.photos.map((p) => {
      if (!p.description) {
        const f = fit(p.key, CONTENT_W, FULL_MAX_H);
        return { h: f.h, paint: () => { draw(f, MARGIN + (CONTENT_W - f.w) / 2); pen.y -= f.h + 14; } };
      }
      const f = fit(p.key, listW, LIST_MAX_H);
      const lines = wrap(pen.safe(p.description), pen.font, BODY, textW);
      // What must fit for the row to start: the photo and as much of its words as fits beside
      // it, capped at a page (longer words carry on in their column on the next page).
      const h = Math.min(Math.max(f.h, lines.length * LINE), USABLE_H);
      return {
        h,
        paint: () => {
          const startPage = pen.page;
          const top = pen.y;
          draw(f, MARGIN);
          for (const l of lines) {
            if (pen.y - LINE < MARGIN) pen.newPage();
            pen.text(l, textX, BODY);
            pen.y -= LINE;
          }
          // Same page: the row ends under whichever is lower, photo or words. Carried over:
          // the words ended on a later page, below everything else.
          if (pen.page === startPage) pen.y = Math.min(pen.y, top - f.h);
          pen.y -= 14;
        },
      };
    });
  }

  for (const s of model.sections) {
    const nameLines = s.name ? wrap(pen.safe(s.name, pen.bold), pen.bold, NAME, CONTENT_W) : [];
    const descLines = s.description ? wrap(pen.safe(s.description, pen.bold), pen.bold, DESC, CONTENT_W) : [];
    const rows = rowsOf(s);
    // Keep the heading (and up to the first few description lines) with the first row of photos.
    const headH = (nameLines.length ? nameLines.length * 17 + 4 : 0) + Math.min(descLines.length, 4) * DESC_LINE + (descLines.length ? 8 : 0);
    const firstH = rows.length ? rows[0].h : 0;
    pen.y -= 14;
    if (pen.y - Math.min(headH + firstH, USABLE_H) < MARGIN) pen.newPage();
    for (const l of nameLines) {
      pen.text(l, MARGIN, NAME, { bold: true });
      pen.y -= 17;
    }
    if (nameLines.length) pen.y -= 4;
    for (const l of descLines) {
      pen.ensure(DESC_LINE);
      pen.text(l, MARGIN, DESC, { bold: true });
      pen.y -= DESC_LINE;
    }
    if (descLines.length) pen.y -= 8;
    for (const r of rows) {
      if (pen.y - r.h < MARGIN) pen.newPage(); // a photo is never split
      r.paint();
    }
  }

  // --- the receipt: the invoice's own rows and totals --------------------------------------
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

  drawFooterContent(pen, model, []);
  stampPageFooters(pen, model);
  return doc.save();
}
