// lib/estimate-document.js — THE renderer for the customer-facing estimate document.
//
// One model, two painters (Tim, 2026-09-11: "see the final product before sending"):
//
//   buildEstimateModel()     estimate + lines + totals + brand → a plain DOCUMENT MODEL
//                            (every label, row, amount and note the customer will see)
//   renderEstimateDocument() model → HTML   (office Preview, hosted page, email body)
//   lib/estimate-pdf.js      model → PDF    (attached to the send email, stored in S3)
//
// The model is the single source of truth. Both painters walk the SAME rows, labels
// and totals, so the PDF the customer files away cannot say something different from
// the page they approved on — the only thing that can differ is typography.
// Anything that decides WHAT is shown (which lines, which total rows, the deposit
// line, the "new" tag, the validity date) lives in buildEstimateModel and nowhere else.
//
// PURE and self-contained: plain objects in, one string (or byte array) out, every
// CSS rule inline, no external assets (email clients and the PDF both need that).
// Tenant identity (company name, license numbers, contact line, terms link) comes in
// as `brand` — nothing Harmon-specific lives here (CLAUDE.md multi-client rule).
// Markup is NEVER printed as a line; it is inside the totals by design (D-072.8).

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const money = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
};

const qtyText = (n, uom) => {
  const v = Number(n);
  const q = Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : "—";
  return uom && uom !== "Each" ? `${q} ${uom}` : q;
};

export const dateOnly = (v) => {
  if (!v) return "";
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(v);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
};

/** Default brand block when the tenant has not configured one yet. */
export const DEFAULT_BRAND = Object.freeze({
  companyName: "",
  tagline: "",
  addressLine: "",
  phone: "",
  email: "",
  licenseLine: "", // e.g. "ROC #123456 · ROC #654321"
  logoUrl: "", // the logo on every document (2026-09-24): the hosted page shows it, the PDF embeds it
  termsUrl: "", // terms and conditions — printed in the footer of every document
  termsBlurb: "",
  clubUrl: "", // the Service Club landing page — printed in the footer with a line of copy
  clubBlurb: "",
  footerNote: "",
  accentColor: "#1F3864",
});

// The footer's two links, with the copy the tenant did not write (generic on purpose —
// nothing Harmon-specific lives here). A brand with no URL for one prints nothing for it.
export const DEFAULT_TERMS_BLURB = "This document and the work it describes are subject to our terms and conditions.";
export const DEFAULT_CLUB_BLURB = "Members get priority scheduling, member pricing on repairs and ongoing system monitoring. See the plans and join online.";

/** The brand block every document model carries. Shared by the estimate, invoice and job report builders. */
export function brandBlock(b, fallbackName) {
  const lines = [b.tagline, b.addressLine, [b.phone, b.email].filter(Boolean).join(" · "), b.licenseLine].filter(Boolean);
  const links = [];
  if (b.termsUrl) links.push({ label: "Terms & Conditions", url: b.termsUrl, blurb: b.termsBlurb || DEFAULT_TERMS_BLURB });
  if (b.clubUrl) links.push({ label: "Solar Service Club", url: b.clubUrl, blurb: b.clubBlurb || DEFAULT_CLUB_BLURB });
  return {
    companyName: b.companyName || fallbackName,
    lines,
    logoUrl: b.logoUrl || "",
    logoBytes: b.logoBytes instanceof Uint8Array ? b.logoBytes : null, // the PDF painter's; never serialised into the page
    logoKind: b.logoKind || null,
    termsUrl: b.termsUrl || "",
    links,
    footerNote: b.footerNote || "",
    accentColor: b.accentColor,
  };
}

export const FOOTER_VALIDITY_NOTE =
  "Prices are valid through the date shown; work added after approval appears on an updated version for your approval.";

/**
 * Build the document model — everything the customer sees, as plain data.
 *
 * @param {object} args
 * @param {object} args.estimate   Sundial_Estimate__c record (API names)
 * @param {Array}  args.lines      Sundial_Service_Line__c records (API names)
 * @param {object} args.totals     computeTotals() output (numbers)
 * @param {object} [args.brand]    tenant identity (see DEFAULT_BRAND)
 * @param {object} [args.options]  { mode: "preview"|"customer"|"pdf"|"email",
 *                                   acceptUrl, showUnitPrices (default true), watermark }
 */
export function buildEstimateModel({ estimate, lines, totals, brand = {}, options = {} }) {
  const b = { ...DEFAULT_BRAND, ...brand };
  const mode = options.mode || "preview";
  const est = estimate || {};
  const version = Number(est.Version__c) || 0;
  const number = est.Name || "Estimate";
  const title = `${number}${version ? ` v${version}` : ""}`;
  const showUnit = options.showUnitPrices !== false;
  const approvedBefore = (est.Approved_Version__c ?? 0) > 0;

  const rows = (lines || [])
    .filter((l) => l.Stage__c !== "Removed")
    .map((l) => {
      const perLine = showUnit && l.Show_Unit_Price__c !== false;
      const amount = l.Line_Total__c ?? Number(l.Quantity__c || 0) * Number(l.Unit_Price__c || 0);
      return {
        description: l.Description__c || "",
        // "new" marks work added since the customer last approved a version.
        isNew: l.Stage__c === "Proposed" && version > 0 && approvedBefore,
        qty: qtyText(l.Quantity__c, l.Unit_of_Measure__c),
        unit: perLine ? money(l.Unit_Price__c) : "",
        amount: money(amount),
      };
    });

  const t = totals || {};
  const totalRows = [
    { label: "Subtotal", amount: money(t.subtotal), strong: false },
    t.discountAmount > 0
      ? { label: est.Discount_Source__c === "Service Plan" ? "Service plan discount" : "Discount", amount: money(-t.discountAmount), strong: false }
      : null,
    t.taxAmount > 0 ? { label: `Tax${est.Tax_Jurisdiction__c ? ` (${est.Tax_Jurisdiction__c})` : ""}`, amount: money(t.taxAmount), strong: false } : null,
    { label: "Total", amount: money(t.total), strong: true },
    est.Deposit_Required__c === true && t.depositAmount > 0 ? { label: "Deposit due to schedule", amount: money(t.depositAmount), strong: false } : null,
  ].filter(Boolean);

  const customerLines = [
    est.Customer_Name_at_Creation__c,
    est.Address_at_Creation__c,
    est.Primary_Phone_at_Creation__c,
    est.Primary_Email_at_Creation__c,
  ].filter(Boolean);

  const metaLines = [
    version ? `Version ${version}` : null,
    est.Last_Sent_At__c ? `Sent ${dateOnly(est.Last_Sent_At__c)}` : null,
    est.Valid_Until__c ? `Valid through ${dateOnly(est.Valid_Until__c)}` : null,
  ].filter(Boolean);

  const acceptNote = `Approving lets us schedule the work. You'll be asked for a card to keep on file; nothing is charged until the work is done${
    est.Deposit_Required__c === true ? ", except the deposit shown above" : ""
  }.`;

  return {
    mode,
    docLabel: "Estimate",
    customerLabel: "Prepared for",
    title,
    number,
    version,
    brand: brandBlock(b, "Estimate"),
    metaLines,
    customerLines,
    scope: est.Scope_Summary__c || "",
    columns: { description: "Description", qty: "Qty", unit: showUnit ? "Unit" : "", amount: "Amount" },
    rows,
    totalRows,
    accept: mode === "customer" && options.acceptUrl ? { url: options.acceptUrl, label: "Approve this estimate", note: acceptNote } : null,
    acceptPlaceholder: mode === "preview" ? { label: "Approve this estimate", note: "The customer sees the approve button and card form here." } : null,
    watermark: options.watermark || (mode === "preview" ? "PREVIEW" : ""),
    footerNotes: [b.footerNote, FOOTER_VALIDITY_NOTE].filter(Boolean),
  };
}

/**
 * The INVOICE document — the same model shape, so both painters draw it unchanged.
 * An invoice is the estimate's lines frozen at issue (D-072.6): the rows come from the
 * estimate's non-removed lines as they were, the money from the invoice record, and
 * the payments to date decide the "Balance due" row. Nothing here is "new", there is
 * no approve button, and the customer block is "Bill to" (the job's one payer).
 *
 * @param {object} args
 * @param {object} args.invoice   Sundial_Service_Invoice__c record (API names)
 * @param {object} args.job       Sundial_Service_Job__c record (snapshot fields)
 * @param {object} [args.estimate] the source estimate (scope summary, tax jurisdiction)
 * @param {Array}  args.lines     the frozen lines
 * @param {Array}  [args.payments] Sundial_Service_Payment__c rows (Succeeded ones count)
 * @param {object} [args.brand]
 * @param {object} [args.options] { mode: "preview"|"pdf"|"email", showUnitPrices, watermark, payUrl }
 */
export function buildInvoiceModel({ invoice, job, estimate, lines, payments = [], brand = {}, options = {} }) {
  const b = { ...DEFAULT_BRAND, ...brand };
  const mode = options.mode || "pdf";
  const inv = invoice || {};
  const j = job || {};
  const est = estimate || {};
  const number = inv.Name || j.Name || "Invoice";
  const showUnit = options.showUnitPrices !== false;

  const rows = (lines || [])
    .filter((l) => l.Stage__c !== "Removed")
    .map((l) => {
      const perLine = showUnit && l.Show_Unit_Price__c !== false;
      const amount = l.Line_Total__c ?? Number(l.Quantity__c || 0) * Number(l.Unit_Price__c || 0);
      return { description: l.Description__c || "", isNew: false, qty: qtyText(l.Quantity__c, l.Unit_of_Measure__c), unit: perLine ? money(l.Unit_Price__c) : "", amount: money(amount) };
    });

  const total = Number(inv.Total__c) || 0;
  const paid = Number(inv.Paid_Amount__c) || 0;
  const balance = Math.round((total - paid) * 100) / 100;
  const totalRows = [
    { label: "Subtotal", amount: money(inv.Subtotal__c), strong: false },
    Number(inv.Discount_Amount__c) > 0 ? { label: est.Discount_Source__c === "Service Plan" ? "Service plan discount" : "Discount", amount: money(-Number(inv.Discount_Amount__c)), strong: false } : null,
    Number(inv.Tax_Amount__c) > 0 ? { label: `Tax${est.Tax_Jurisdiction__c ? ` (${est.Tax_Jurisdiction__c})` : ""}`, amount: money(inv.Tax_Amount__c), strong: false } : null,
    { label: "Total", amount: money(total), strong: paid <= 0 },
    paid > 0 ? { label: "Paid to date", amount: money(-paid), strong: false } : null,
    paid > 0 ? { label: balance <= 0 ? "Balance" : "Balance due", amount: money(Math.max(0, balance)), strong: true } : null,
  ].filter(Boolean);

  // Bill to: the job's one payer. A partner invoice names the partner and carries the
  // partner's reference; a customer invoice names the customer.
  const partner = inv.Bill_To_Type__c && inv.Bill_To_Type__c !== "Customer";
  const customerLines = (partner
    ? [inv.Bill_To_Name__c || inv.Bill_To_Type__c, inv.Billing_Reference__c ? `Ref ${inv.Billing_Reference__c}` : null, `Service at: ${[j.Customer_Name_at_Creation__c, j.Address_at_Creation__c].filter(Boolean).join(", ")}`]
    : [j.Customer_Name_at_Creation__c, j.Address_at_Creation__c, j.Primary_Phone_at_Creation__c, j.Primary_Email_at_Creation__c]
  ).filter(Boolean);


  const status = inv.Status__c || "";
  const metaLines = [
    inv.Issued_At__c ? `Issued ${dateOnly(inv.Issued_At__c)}` : null,
    inv.Due_Date__c ? `Due ${dateOnly(inv.Due_Date__c)}` : null,
    j.Name && j.Name !== number ? `Job ${j.Name}` : null,
    status === "Paid" ? `PAID${inv.Paid_At__c ? ` ${dateOnly(inv.Paid_At__c)}` : ""}` : null,
    status === "Void" ? "VOID" : null,
  ].filter(Boolean);

  const paidNote = status === "Paid" ? "Thank you — this invoice is paid in full." : balance > 0 ? `Balance due: ${money(balance)}${inv.Due_Date__c ? ` by ${dateOnly(inv.Due_Date__c)}` : ""}.` : "";
  return {
    mode,
    docLabel: "Invoice",
    customerLabel: "Bill to",
    scopeLabel: "Summary of work",
    title: `Invoice ${number}`,
    number,
    version: 0,
    brand: brandBlock(b, "Invoice"),
    metaLines,
    customerLines,
    // The job's "Summary of work" (Customer_Summary__c) is the narrative the office writes
    // for the bill; the estimate's scope is the fallback when there is none yet.
    scope: j.Customer_Summary__c || est.Scope_Summary__c || "",
    columns: { description: "Description", qty: "Qty", unit: showUnit ? "Unit" : "", amount: "Amount" },
    rows,
    totalRows,
    accept: options.payUrl ? { url: options.payUrl, label: "Pay this invoice", note: "" } : null,
    acceptPlaceholder: null,
    watermark: options.watermark || (status === "Void" ? "VOID" : status === "Paid" ? "PAID" : mode === "preview" ? "PREVIEW" : ""),
    footerNotes: [b.footerNote, paidNote].filter(Boolean),
  };
}

/** The footer's links block (terms, the Service Club), shared by the estimate/invoice and job-report pages. */
export function footerLinksHtml(brand) {
  if (!brand?.links?.length) return "";
  return `<div class="links">${brand.links
    .map((l) => `<p><strong>${esc(l.label)}</strong> — ${esc(l.blurb)} <a href="${esc(l.url)}">${esc(l.url)}</a></p>`)
    .join("")}</div>`;
}

/**
 * HTML painter. Accepts either the raw inputs (estimate/lines/totals/brand/options)
 * or a prebuilt `model`.
 * @returns {{ html: string, title: string, model: object }}
 */
export function renderEstimateDocument(args) {
  const m = args.model || buildEstimateModel(args);
  const accent = esc(m.brand.accentColor);

  const rows = m.rows
    .map(
      (r) => `<tr>
        <td class="desc">${esc(r.description)}${r.isNew ? ' <span class="tag">new</span>' : ""}</td>
        <td class="num">${esc(r.qty)}</td>
        <td class="num">${esc(r.unit)}</td>
        <td class="num">${esc(r.amount)}</td>
      </tr>`
    )
    .join("");

  const totalRows = m.totalRows
    .map((r) => `<tr class="${r.strong ? "grand" : ""}"><td colspan="3">${esc(r.label)}</td><td class="num">${esc(r.amount)}</td></tr>`)
    .join("");

  const customerBlock = m.customerLines.map((s) => `<div>${esc(s)}</div>`).join("");

  const accept = m.accept
    ? `<div class="accept"><a class="btn" href="${esc(m.accept.url)}">${esc(m.accept.label)}</a><p>${esc(m.accept.note)}</p></div>`
    : m.acceptPlaceholder
      ? `<div class="accept muted"><span class="btn ghost">${esc(m.acceptPlaceholder.label)}</span><p>${esc(m.acceptPlaceholder.note)}</p></div>`
      : "";

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(m.title)}</title>
<style>
  body{margin:0;background:#f4f4f5;font:14px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b}
  .page{max-width:800px;margin:24px auto;background:#fff;padding:40px 44px;box-shadow:0 1px 3px rgba(0,0,0,.08);position:relative}
  .wm{position:absolute;top:18px;right:24px;font-size:11px;letter-spacing:.2em;color:#a1a1aa;border:1px solid #d4d4d8;padding:2px 8px;border-radius:999px}
  header{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid ${accent};padding-bottom:16px;margin-bottom:20px}
  .brand h1{margin:0;font-size:20px;color:${accent}}
  .brand .logo{display:block;max-height:72px;max-width:260px;margin-bottom:6px}
  .links{margin-top:10px;display:grid;gap:8px}
  .links p{margin:0}
  .links strong{color:#3f3f46}
  .brand div{color:#52525b;font-size:12px}
  .meta{text-align:right;font-size:12px;color:#52525b}
  .meta .num{font-size:18px;color:#18181b;font-weight:600}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#71717a;margin:18px 0 6px}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  .scope{white-space:pre-wrap}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#71717a;text-align:left;padding:6px 8px;border-bottom:1px solid #e4e4e7}
  td{padding:8px;border-bottom:1px solid #f1f1f3;vertical-align:top}
  td.desc{width:60%}
  .num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  th.num{text-align:right}
  tr.grand td{font-weight:700;font-size:16px;border-top:2px solid #18181b;border-bottom:none}
  .tag{font-size:10px;background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:999px;margin-left:6px;vertical-align:middle}
  .accept{margin-top:28px;padding:18px;border:1px solid #e4e4e7;border-radius:10px;text-align:center}
  .accept.muted{border-style:dashed;color:#71717a}
  .btn{display:inline-block;background:${accent};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600}
  .btn.ghost{background:#e4e4e7;color:#52525b}
  .accept p{font-size:12px;margin:10px 0 0}
  footer{margin-top:28px;border-top:1px solid #e4e4e7;padding-top:12px;font-size:11px;color:#71717a}
  footer a{color:inherit}
  @media print{body{background:#fff}.page{box-shadow:none;margin:0;padding:24px}.wm{display:none}}
</style></head>
<body><div class="page">
  ${m.watermark ? `<div class="wm">${esc(m.watermark)}</div>` : ""}
  <header>
    <div class="brand">
      ${m.brand.logoUrl ? `<img class="logo" src="${esc(m.brand.logoUrl)}" alt="${esc(m.brand.companyName)}">` : `<h1>${esc(m.brand.companyName)}</h1>`}
      ${m.brand.lines.map((s) => `<div>${esc(s)}</div>`).join("")}
    </div>
    <div class="meta">
      <div>${esc(m.docLabel || "Estimate")}</div>
      <div class="num">${esc(m.number)}</div>
      ${m.metaLines.map((s) => `<div>${esc(s)}</div>`).join("")}
    </div>
  </header>

  <div class="two">
    <div><h2>${esc(m.customerLabel || "Prepared for")}</h2>${customerBlock || '<div style="color:#a1a1aa">No customer on this document</div>'}</div>
    ${m.scope ? `<div><h2>${esc(m.scopeLabel || "Scope of work")}</h2><div class="scope">${esc(m.scope)}</div></div>` : ""}
  </div>

  <h2>Line items</h2>
  <table>
    <thead><tr><th>${esc(m.columns.description)}</th><th class="num">${esc(m.columns.qty)}</th><th class="num">${esc(m.columns.unit)}</th><th class="num">${esc(m.columns.amount)}</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" style="color:#a1a1aa">No line items yet</td></tr>'}</tbody>
    <tfoot>${totalRows}</tfoot>
  </table>

  ${accept}

  <footer>
    ${m.footerNotes.slice(0, -1).map((s) => `<p>${esc(s)}</p>`).join("")}
    <p>${esc(FOOTER_VALIDITY_NOTE)}</p>
    ${footerLinksHtml(m.brand)}
  </footer>
</div></body></html>`;

  return { html, title: m.title, model: m };
}
