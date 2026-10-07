// lib/document-pdf.js — the PDF FRAME every customer document shares (D-081, 2026-10-07).
//
// The PDF twin of lib/document-html.js: the same header (logo, company name under it, the
// left block; the bordered meta box and the labelled blocks on the right), the accent-band
// table, the narrow totals box and the footer, so the estimate, the invoice and the job
// report print as one family (the layout of the Housecall Pro invoice Harmon sends today).
// The painters (estimate-pdf.js, job-report-pdf.js) open a pen here and call these in turn;
// they never decide what is shown — the model builders do.
//
// pdf-lib, pure JavaScript (bundles into the single-file Lambda). Text is Windows-1252 (the
// standard fonts); anything outside it is replaced so a customer's odd keyboard can never
// block a send.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export const PAGE = { width: 612, height: 792 }; // US Letter
export const MARGIN = 44;
export const CONTENT_W = PAGE.width - MARGIN * 2;
/** The right-hand header column (meta box + blocks) and the totals box. */
export const RIGHT_W = 232;
export const RIGHT_X = PAGE.width - MARGIN - RIGHT_W;
export const LEFT_W = RIGHT_X - MARGIN - 20;
export const TOTALS_W = 236;
const COLS = { desc: 0.58, qty: 0.12, unit: 0.15, amount: 0.15 }; // fractions of CONTENT_W
/** The logo's box in the header: at most this tall, at most this wide. */
export const LOGO_MAX_H = 64;
export const LOGO_MAX_W = 220;
/** Where the per-page footer line sits (below the content area). */
const FOOT_Y = 22;

export const GREY = rgb(0.44, 0.44, 0.48);
export const DARK = rgb(0.16, 0.16, 0.18);
export const LIGHT = rgb(0.89, 0.89, 0.91);
export const FAINT = rgb(0.93, 0.93, 0.94);
export const INK = rgb(0.09, 0.09, 0.11);
const WHITE = rgb(1, 1, 1);

export const hex = (h) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h || "");
  return m ? rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255) : rgb(0.12, 0.22, 0.39);
};

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
export function wrap(text, font, size, width) {
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
 * Draw the brand's logo with its top-left at (x, top). Returns the height used, 0 when
 * there is no logo or it cannot be embedded — the caller prints the name instead.
 */
export async function drawLogo(doc, page, brand, x, top) {
  if (!brand?.logoBytes) return 0;
  try {
    const img = brand.logoKind === "jpg" ? await doc.embedJpg(brand.logoBytes) : await doc.embedPng(brand.logoBytes);
    const scale = Math.min(LOGO_MAX_H / img.height, LOGO_MAX_W / img.width, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, { x, y: top - h, width: w, height: h });
    return h;
  } catch (e) {
    console.error("pdf logo:", e?.message || e);
    return 0;
  }
}

/** The footer's links as lines to print: terms as one line, the rest label (bold) + copy. */
export function footerLinkLines(brand, font, bold, width) {
  const out = [];
  for (const l of brand?.links || []) {
    if (l.kind === "terms") {
      for (const t of wrap(pdfSafe(`See our Terms & Conditions (${l.url})`, font), font, 8, width)) out.push({ text: t, bold: false, gap: false });
    } else {
      out.push({ text: pdfSafe(l.label, bold), bold: true, gap: false });
      for (const t of wrap(pdfSafe(`${l.blurb} ${l.url}`, font), font, 8, width)) out.push({ text: t, bold: false, gap: false });
    }
    if (out.length) out[out.length - 1].gap = true;
  }
  return out;
}

/**
 * A pen: one document, its fonts, the current page and the y cursor (top-down). Every
 * helper reads and moves `pen.y`; `ensure(h)` starts a new page when h will not fit.
 */
export async function createPen(model) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(model.title);
  doc.setProducer("Sundial");
  doc.setCreator("Sundial");
  const pen = {
    doc,
    font,
    bold,
    accent: hex(model.brand?.accentColor),
    page: doc.addPage([PAGE.width, PAGE.height]),
    y: PAGE.height - MARGIN,
    onNewPage: null, // e.g. redraw a table header
  };
  pen.safe = (s, f = font) => pdfSafe(s, f);
  pen.text = (s, x, size, opts = {}) => {
    const f = opts.bold ? bold : font;
    pen.page.drawText(pen.safe(s, f), { x, y: pen.y - size, size, font: f, color: opts.color || INK });
  };
  pen.width = (s, size, isBold = false) => (isBold ? bold : font).widthOfTextAtSize(pen.safe(s, isBold ? bold : font), size);
  pen.textRight = (s, rightX, size, opts = {}) => pen.text(s, rightX - pen.width(s, size, opts.bold), size, opts);
  pen.rule = (color = LIGHT, thickness = 1, x1 = MARGIN, x2 = PAGE.width - MARGIN) => {
    pen.page.drawLine({ start: { x: x1, y: pen.y }, end: { x: x2, y: pen.y }, thickness, color });
  };
  pen.newPage = () => {
    pen.page = doc.addPage([PAGE.width, PAGE.height]);
    pen.y = PAGE.height - MARGIN;
  };
  pen.ensure = (needed) => {
    if (pen.y - needed < MARGIN) {
      pen.newPage();
      if (pen.onNewPage) pen.onNewPage();
      return true;
    }
    return false;
  };
  /** A small grey caps label at x (default the margin). */
  pen.label = (s, x = MARGIN, size = 7.5) => pen.text(String(s).toUpperCase(), x, size, { color: GREY });
  /** Wrapped paragraph that flows across pages. */
  pen.paragraph = (s, { size = 10, color = INK, width = CONTENT_W, x = MARGIN } = {}) => {
    for (const l of wrap(pen.safe(s), font, size, width)) {
      pen.ensure(size + 4);
      pen.page.drawText(l, { x, y: pen.y - size, size, font, color });
      pen.y -= size + 3;
    }
  };
  return pen;
}

/**
 * The header: logo + company name + left block on the left; the meta box and the labelled
 * blocks on the right. Leaves pen.y under whichever side is taller.
 */
export async function drawHeader(pen, model) {
  const b = model.brand;
  if (model.watermark) {
    // In the top margin, clear of the meta box.
    const w = pen.width(model.watermark, 8, true);
    pen.page.drawText(pen.safe(model.watermark, pen.bold), { x: PAGE.width - MARGIN - w, y: PAGE.height - MARGIN / 2 - 4, size: 8, font: pen.bold, color: GREY });
  }
  const top = pen.y;

  // --- left: logo, the company name under it (D-081), then the left block ----------
  const logoH = await drawLogo(pen.doc, pen.page, b, MARGIN, top);
  if (logoH > 0) {
    pen.y -= logoH + 6;
    if (b.companyName) {
      pen.text(b.companyName, MARGIN, 12, { bold: true });
      pen.y -= 16;
    }
  } else {
    pen.text(b.displayName, MARGIN, 18, { bold: true, color: pen.accent });
    pen.y -= 22;
  }
  const leftLines = model.left?.lines || [];
  if (leftLines.length) pen.y -= 10;
  leftLines.forEach((l, i) => {
    const isBold = i === 0 || l.bold;
    const size = i === 0 ? 11 : 10;
    for (const t of wrap(pen.safe(l.text, isBold ? pen.bold : pen.font), isBold ? pen.bold : pen.font, size, LEFT_W)) {
      pen.text(t, MARGIN, size, { bold: isBold });
      pen.y -= size + 3;
    }
  });
  const leftBottom = pen.y;

  // --- right: the meta box ---------------------------------------------------------
  const meta = model.meta || [];
  const rowH = 15;
  const pad = 9;
  const boxH = pad * 2 + meta.length * rowH + (model.metaTotal ? 28 : 0);
  pen.page.drawRectangle({ x: RIGHT_X, y: top - boxH, width: RIGHT_W, height: boxH, borderColor: LIGHT, borderWidth: 1 });
  pen.y = top - pad;
  for (const r of meta) {
    pen.label(r.label, RIGHT_X + 10, 7.5);
    const value = wrap(pen.safe(r.value), pen.font, 9.5, RIGHT_W - 110)[0] ?? "";
    pen.textRight(value, RIGHT_X + RIGHT_W - 10, 9.5);
    pen.y -= rowH;
  }
  if (model.metaTotal) {
    pen.y -= 3;
    pen.rule(LIGHT, 1, RIGHT_X + 10, RIGHT_X + RIGHT_W - 10);
    pen.y -= 7;
    pen.text(String(model.metaTotal.label).toUpperCase(), RIGHT_X + 10, 8.5, { bold: true });
    pen.y += 4;
    pen.textRight(model.metaTotal.value, RIGHT_X + RIGHT_W - 10, 14, { bold: true });
  }
  pen.y = top - boxH - 14;

  // --- right: the labelled blocks (SERVICE ADDRESS, CONTACT US) --------------------
  for (const blk of model.rightBlocks || []) {
    if (!blk.lines?.length) continue;
    pen.label(blk.label, RIGHT_X, 7.5);
    pen.y -= 11;
    pen.rule(LIGHT, 0.75, RIGHT_X, RIGHT_X + RIGHT_W);
    pen.y -= 4;
    for (const line of blk.lines) {
      for (const t of wrap(pen.safe(line), pen.font, 9.5, RIGHT_W)) {
        pen.text(t, RIGHT_X, 9.5);
        pen.y -= 12.5;
      }
    }
    pen.y -= 10;
  }
  pen.y = Math.min(pen.y, leftBottom) - 12;
}

/** A labelled paragraph (INVOICE / SCOPE OF WORK / SUMMARY OF WORK); nothing when empty. */
export function drawBody(pen, label, text) {
  if (!text) return;
  pen.ensure(30);
  pen.label(label, MARGIN, 8);
  pen.y -= 13;
  pen.paragraph(text, { size: 10 });
  pen.y -= 6;
}

/** The line items: accent header band (repeated on a new page), grey qty / unit, black amount. */
export function drawItemsTable(pen, columns, rows, { emptyText = "No line items yet" } = {}) {
  const xQty = MARGIN + CONTENT_W * (COLS.desc + COLS.qty);
  const xUnit = xQty + CONTENT_W * COLS.unit;
  const xAmt = MARGIN + CONTENT_W;
  const descW = CONTENT_W * COLS.desc - 8;
  const band = () => {
    const h = 18;
    pen.page.drawRectangle({ x: MARGIN, y: pen.y - h, width: CONTENT_W, height: h, color: pen.accent });
    pen.y -= 5;
    pen.text(columns.description, MARGIN + 6, 8.5, { bold: true, color: WHITE });
    pen.textRight(columns.qty, xQty - 4, 8.5, { bold: true, color: WHITE });
    if (columns.unit) pen.textRight(columns.unit, xUnit - 4, 8.5, { bold: true, color: WHITE });
    pen.textRight(columns.amount, xAmt - 6, 8.5, { bold: true, color: WHITE });
    pen.y -= h - 5 + 2;
  };
  pen.ensure(60);
  band();
  pen.onNewPage = band;
  if (!rows.length) {
    pen.y -= 6;
    pen.text(emptyText, MARGIN + 6, 10, { color: GREY });
    pen.y -= 16;
  }
  for (const r of rows) {
    const descLines = wrap(pen.safe(r.description) + (r.isNew ? "  (new)" : ""), pen.font, 10, descW);
    pen.ensure(Math.max(1, descLines.length) * 13 + 12);
    pen.y -= 5;
    const rowTop = pen.y;
    for (const l of descLines) {
      pen.text(l, MARGIN + 6, 10);
      pen.y -= 13;
    }
    const rowBottom = pen.y;
    pen.y = rowTop;
    pen.textRight(r.qty, xQty - 4, 10, { color: GREY });
    if (r.unit) pen.textRight(r.unit, xUnit - 4, 10, { color: GREY });
    pen.textRight(r.amount, xAmt - 6, 10);
    pen.y = rowBottom - 3;
    pen.rule(FAINT, 0.75);
  }
  pen.onNewPage = null;
}

/** The totals, right-aligned in their own narrow box. */
export function drawTotals(pen, totalRows) {
  if (!totalRows?.length) return;
  const sizeOf = (r) => (r.big ? 14 : r.sub ? 8.5 : 10);
  const gapOf = (r) => sizeOf(r) + (r.strong ? 12 : 6);
  const h = totalRows.reduce((a, r) => a + gapOf(r), 0) + 14;
  pen.ensure(h + 12);
  pen.y -= 10;
  const x = PAGE.width - MARGIN - TOTALS_W;
  const right = PAGE.width - MARGIN - 10;
  const top = pen.y;
  pen.page.drawRectangle({ x, y: top - h, width: TOTALS_W, height: h, borderColor: LIGHT, borderWidth: 1 });
  pen.y -= 8;
  for (const r of totalRows) {
    if (r.strong) {
      pen.y -= 3;
      pen.rule(LIGHT, 1, x + 10, PAGE.width - MARGIN - 10);
      pen.y -= 5;
    }
    const size = sizeOf(r);
    const color = r.sub ? GREY : INK;
    pen.text(r.label, x + (r.sub ? 22 : 10), size, { bold: r.strong || r.big, color });
    pen.textRight(r.amount, right, size, { bold: r.strong || r.big, color });
    pen.y -= size + 6;
  }
  pen.y = top - h - 6;
}

/** The "Approve / Pay online" block (customer, email and pdf modes when the model has one). */
export function drawAccept(pen, model) {
  if (!model.accept) return;
  pen.ensure(60);
  pen.y -= 12;
  pen.text(model.accept.label ? `${model.accept.label} online:` : "Approve online:", MARGIN, 10, { bold: true });
  pen.y -= 13;
  for (const l of wrap(model.accept.url, pen.font, 9, CONTENT_W)) {
    pen.page.drawText(l, { x: MARGIN, y: pen.y - 9, size: 9, font: pen.font, color: pen.accent });
    pen.y -= 12;
  }
  for (const l of wrap(pen.safe(model.accept.note || ""), pen.font, 9, CONTENT_W)) {
    if (!l) continue;
    pen.text(l, MARGIN, 9, { color: GREY });
    pen.y -= 12;
  }
}

/** Notes, tagline, terms and links — flowing content at the end of the document. */
export function drawFooterContent(pen, model, extraLines = []) {
  const b = model.brand;
  const notes = [];
  for (const n of [...(model.footerNotes || []), ...extraLines]) notes.push(...wrap(pen.safe(n), pen.font, 8, CONTENT_W));
  if (b.tagline) notes.push(...wrap(pen.safe(b.tagline), pen.font, 8, CONTENT_W));
  const linkLines = footerLinkLines(b, pen.font, pen.bold, CONTENT_W);
  pen.ensure(Math.min((notes.length + linkLines.length) * 11 + 20, PAGE.height - MARGIN * 2));
  pen.y -= 16;
  for (const l of notes) {
    pen.ensure(11);
    pen.text(l, MARGIN, 8, { color: GREY });
    pen.y -= 11;
  }
  for (const l of linkLines) {
    pen.ensure(11);
    pen.text(l.text, MARGIN, 8, { bold: l.bold, color: l.bold ? DARK : GREY });
    pen.y -= l.gap ? 14 : 11;
  }
}

/** On every page, under the content: a rule, "Name | license" left, website centre, "n of N" right. */
export function stampPageFooters(pen, model) {
  const b = model.brand;
  const pages = pen.doc.getPages();
  const left = b.footerLine?.left || "";
  const center = b.footerLine?.center || "";
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: FOOT_Y + 11 }, end: { x: PAGE.width - MARGIN, y: FOOT_Y + 11 }, thickness: 0.75, color: LIGHT });
    const draw = (s, x) => p.drawText(pen.safe(s), { x, y: FOOT_Y, size: 7.5, font: pen.font, color: GREY });
    if (left) draw(left, MARGIN);
    if (center) draw(center, (PAGE.width - pen.width(center, 7.5)) / 2);
    const n = `${i + 1} of ${pages.length}`;
    draw(n, PAGE.width - MARGIN - pen.width(n, 7.5));
  });
}
