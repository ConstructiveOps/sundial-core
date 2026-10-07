// lib/estimate-pdf.js — the PDF painter for the estimate and the invoice document.
//
// Paints the SAME model lib/estimate-document.js builds (buildEstimateModel /
// buildInvoiceModel) — the rows, labels, totals and notes are decided there, once, and
// this file only draws them. Never compute a number or choose a label here; if the PDF
// needs something the page does not have, add it to the model so both painters get it.
//
// The drawing itself is the shared frame in lib/document-pdf.js (D-081, 2026-10-07): the
// header with the logo, the company name under it and the meta box, the accent-band table,
// the totals box and the footer — the same on the job report, so the three documents print
// as one family. pdf-lib, pure JavaScript: it bundles into the single-file esbuild artifact
// deploy.ps1 produces, which is why it was chosen over an HTML-to-PDF engine.

import { createPen, drawHeader, drawBody, drawItemsTable, drawTotals, drawAccept, drawFooterContent, stampPageFooters } from "./document-pdf.js";

// The primitives moved to lib/document-pdf.js; re-exported so existing imports keep working.
export { pdfSafe, wrap, drawLogo, footerLinkLines, LOGO_MAX_H, LOGO_MAX_W } from "./document-pdf.js";

/**
 * @param {object} model  buildEstimateModel() / buildInvoiceModel() output
 * @returns {Promise<Uint8Array>} the PDF bytes
 */
export async function renderEstimatePdf(model) {
  const pen = await createPen(model);
  await drawHeader(pen, model);
  drawBody(pen, model.scopeLabel || "Scope of work", model.scope);
  drawItemsTable(pen, model.columns, model.rows);
  drawTotals(pen, model.totalRows);
  drawAccept(pen, model);
  drawFooterContent(pen, model);
  stampPageFooters(pen, model);
  return pen.doc.save();
}
