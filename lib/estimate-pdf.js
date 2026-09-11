// lib/estimate-pdf.js — the PDF painter for the estimate document.
//
// Paints the SAME model lib/estimate-document.js builds (buildEstimateModel) — the
// rows, labels, totals and notes are decided there, once, and this file only draws
// them. Never compute a number or choose a label here; if the PDF needs something the
// page does not have, add it to the model so both painters get it.
//
// pdf-lib, pure JavaScript: no headless browser, no native binary, no Lambda layer —
// it bundles into the single-file esbuild artifact deploy.ps1 produces, which is why
// it was chosen over an HTML-to-PDF engine. The trade is typography: standard
// Helvetica, our own line-wrapping, one column of rows that flows across pages.
//
// Text is Windows-1252 (the standard fonts' encoding). Characters outside it — an
// emoji in a description, say — are replaced rather than allowed to throw, so a
// customer's odd keyboard can never block a send.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PAGE = { width: 612, height: 792 }; // US Letter
const MARGIN = 44;
const CONTENT_W = PAGE.width - MARGIN * 2;
const COLS = { desc: 0.58, qty: 0.12, unit: 0.15, amount: 0.15 }; // fractions of CONTENT_W

const hex = (h) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h || "");
  return m ? rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255) : rgb(0.12, 0.22, 0.39);
};
const GREY = rgb(0.44, 0.44, 0.48);
const LIGHT = rgb(0.89, 0.89, 0.91);
const INK = rgb(0.09, 0.09, 0.11);

/** Make a string safe for the standard (WinAnsi) fonts. */
export function pdfSafe(s, font) {
  let t = String(s ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  if (!font) return t;
  try {
    font.encodeText(t.replace(/\n/g, " "));
    return t;
  } catch {
    return Array.from(t)
      .map((ch) => {
        if (ch === "\n") return ch;
        try {
          font.encodeText(ch);
          return ch;
        } catch {
          return "?";
        }
      })
      .join("");
  }
}

/** Greedy word wrap for one paragraph at a given width. */
function wrap(text, font, size, width) {
  const out = [];
  for (const para of String(text).split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const w of words) {
      const probe = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(probe, size) <= width) line = probe;
      else {
        if (line) out.push(line);
        // A single word wider than the column is hard-split so it can never overflow.
        let chunk = "";
        for (const ch of w) {
          if (font.widthOfTextAtSize(chunk + ch, size) <= width) chunk += ch;
          else {
            out.push(chunk);
            chunk = ch;
          }
        }
        line = chunk;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * @param {object} model  buildEstimateModel() output
 * @returns {Promise<Uint8Array>} the PDF bytes
 */
export async function renderEstimatePdf(model) {
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

  const text = (s, x, size, opts = {}) => {
    page.drawText(safe(s), { x, y: y - size, size, font: opts.bold ? bold : font, color: opts.color || INK });
  };
  const textRight = (s, rightX, size, opts = {}) => {
    const f = opts.bold ? bold : font;
    const w = f.widthOfTextAtSize(safe(s), size);
    page.drawText(safe(s), { x: rightX - w, y: y - size, size, font: f, color: opts.color || INK });
  };
  const rule = (color = LIGHT, thickness = 1) => {
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE.width - MARGIN, y }, thickness, color });
  };
  const ensure = (needed) => {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE.width, PAGE.height]);
      y = PAGE.height - MARGIN;
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

  // --- Watermark (preview only) ---------------------------------------------
  if (model.watermark) {
    textRight(model.watermark, PAGE.width - MARGIN, 8, { color: GREY });
  }

  // --- Header: brand left, estimate number right -----------------------------
  const headerTop = y;
  text(model.brand.companyName, MARGIN, 18, { bold: true, color: accent });
  y -= 22;
  for (const line of model.brand.lines) {
    text(line, MARGIN, 9, { color: GREY });
    y -= 12;
  }
  const leftBottom = y;
  y = headerTop;
  textRight("Estimate", PAGE.width - MARGIN, 9, { color: GREY });
  y -= 13;
  textRight(model.number, PAGE.width - MARGIN, 16, { bold: true });
  y -= 20;
  for (const line of model.metaLines) {
    textRight(line, PAGE.width - MARGIN, 9, { color: GREY });
    y -= 12;
  }
  y = Math.min(y, leftBottom) - 8;
  rule(accent, 2.5);

  // --- Prepared for / Scope --------------------------------------------------
  const colW = (CONTENT_W - 24) / 2;
  const blockTop = y;
  sectionLabel("Prepared for");
  if (model.customerLines.length === 0) {
    text("No customer on this estimate", MARGIN, 10, { color: GREY });
    y -= 13;
  }
  for (const line of model.customerLines) {
    for (const l of wrap(line, font, 10, colW)) {
      text(l, MARGIN, 10);
      y -= 13;
    }
  }
  const leftEnd = y;
  if (model.scope) {
    y = blockTop;
    const x = MARGIN + colW + 24;
    y -= 14;
    page.drawText("SCOPE OF WORK", { x, y: y - 8, size: 8, font, color: GREY });
    y -= 12;
    for (const l of wrap(safe(model.scope), font, 10, colW)) {
      if (y - 13 < MARGIN) break; // a very long scope is truncated on the PDF, never overflows
      page.drawText(l, { x, y: y - 10, size: 10, font, color: INK });
      y -= 13;
    }
    y = Math.min(y, leftEnd);
  } else y = leftEnd;

  // --- Line items ------------------------------------------------------------
  const xDesc = MARGIN;
  const xQty = MARGIN + CONTENT_W * COLS.desc + CONTENT_W * COLS.qty;
  const xUnit = xQty + CONTENT_W * COLS.unit;
  const xAmt = MARGIN + CONTENT_W;
  const descW = CONTENT_W * COLS.desc - 8;

  const tableHeader = () => {
    text(model.columns.description, xDesc, 8, { color: GREY });
    textRight(model.columns.qty, xQty, 8, { color: GREY });
    if (model.columns.unit) textRight(model.columns.unit, xUnit, 8, { color: GREY });
    textRight(model.columns.amount, xAmt, 8, { color: GREY });
    y -= 12;
    rule(LIGHT, 1);
    y -= 4;
  };
  sectionLabel("Line items");
  tableHeader();

  if (model.rows.length === 0) {
    y -= 4;
    text("No line items yet", xDesc, 10, { color: GREY });
    y -= 16;
  }
  for (const r of model.rows) {
    const descLines = wrap(safe(r.description) + (r.isNew ? "  (new)" : ""), font, 10, descW);
    const h = Math.max(1, descLines.length) * 13 + 8;
    if (ensure(h + 20)) tableHeader();
    y -= 4;
    const rowTop = y;
    for (const l of descLines) {
      text(l, xDesc, 10);
      y -= 13;
    }
    const rowBottom = y;
    y = rowTop;
    textRight(r.qty, xQty, 10);
    if (r.unit) textRight(r.unit, xUnit, 10);
    textRight(r.amount, xAmt, 10);
    y = rowBottom - 4;
    rule(rgb(0.95, 0.95, 0.96), 0.75);
  }

  // --- Totals ----------------------------------------------------------------
  ensure(model.totalRows.length * 18 + 30);
  y -= 6;
  for (const r of model.totalRows) {
    if (r.strong) {
      y -= 4;
      rule(INK, 1.5);
      y -= 6;
    }
    const size = r.strong ? 13 : 10;
    textRight(r.amount, xAmt, size, { bold: r.strong });
    page.drawText(safe(r.label), { x: xQty - CONTENT_W * COLS.qty, y: y - size, size, font: r.strong ? bold : font, color: INK });
    y -= size + 6;
  }

  // --- Accept note (customer / email modes) ----------------------------------
  const acceptNote = model.accept?.note || model.acceptPlaceholder?.note;
  if (model.accept) {
    ensure(60);
    y -= 10;
    text("Approve online:", MARGIN, 10, { bold: true });
    y -= 13;
    for (const l of wrap(model.accept.url, font, 9, CONTENT_W)) {
      page.drawText(l, { x: MARGIN, y: y - 9, size: 9, font, color: accent });
      y -= 12;
    }
    for (const l of wrap(safe(acceptNote), font, 9, CONTENT_W)) {
      text(l, MARGIN, 9, { color: GREY });
      y -= 12;
    }
  }

  // --- Footer ----------------------------------------------------------------
  const footerLines = [];
  for (const n of model.footerNotes) footerLines.push(...wrap(safe(n), font, 8, CONTENT_W));
  if (model.brand.termsUrl) footerLines.push(...wrap(`Terms and conditions: ${model.brand.termsUrl}`, font, 8, CONTENT_W));
  ensure(footerLines.length * 11 + 20);
  y -= 16;
  rule(LIGHT, 1);
  y -= 8;
  for (const l of footerLines) {
    text(l, MARGIN, 8, { color: GREY });
    y -= 11;
  }

  // Page numbers — only worth the ink when there is more than one page.
  const pages = doc.getPages();
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const s = `${model.title} · page ${i + 1} of ${pages.length}`;
      p.drawText(safe(s), { x: PAGE.width - MARGIN - font.widthOfTextAtSize(safe(s), 8), y: MARGIN / 2, size: 8, font, color: GREY });
    });
  }

  return doc.save();
}
