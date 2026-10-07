// lib/estimate-document.js — THE renderer for the customer-facing estimate and invoice.
//
// One model, two painters (Tim, 2026-09-11: "see the final product before sending"):
//
//   buildEstimateModel()     estimate + lines + totals + brand → a plain DOCUMENT MODEL
//   buildInvoiceModel()      invoice + job + lines + payments + payer → the same shape
//   renderEstimateDocument() model → HTML   (office Preview, hosted page, email body)
//   lib/estimate-pdf.js      model → PDF    (attached to the send email, stored in S3)
//
// The model is the single source of truth. Both painters walk the SAME rows, labels
// and totals, so the PDF the customer files away cannot say something different from
// the page they approved on — the only thing that can differ is typography.
// Anything that decides WHAT is shown (which lines, which total rows, the deposit
// line, the "new" tag, the validity date, which blocks the header carries) lives in the
// builders here and nowhere else.
//
// The model's FRAME (D-081, 2026-10-07 — laid out after Harmon's Housecall Pro invoice,
// shared with the job report so the three documents are one family):
//   brand        brandBlock(): logo, the company name printed UNDER the logo, contact
//                lines, tagline, the footer line (name | license, website), payment terms
//   meta         [{ label, value }] — the bordered box top-right
//   metaTotal    { label, value } | null — the box's large last row (AMOUNT DUE)
//   left         { lines: [{ text, bold? }] } — top-left, under the name, NO label
//   rightBlocks  [{ label, lines }] — under the box (SERVICE ADDRESS, CONTACT US)
//   scopeLabel / scope, columns / rows, totalRows [{ label, amount, strong?, big?, sub? }],
//   accept, watermark, footerNotes
// lib/document-html.js and lib/document-pdf.js paint it.
//
// PURE and self-contained: plain objects in, one string (or byte array) out, every
// CSS rule inline, no external assets (email clients and the PDF both need that).
// Tenant identity comes in as `brand` — nothing Harmon-specific lives here (CLAUDE.md
// multi-client rule). Markup is NEVER printed as a line; it is inside the totals by
// design (D-072.8).

import { addressLines, customerContactName } from "./customer-name.js";
import { esc, frameCss, headerHtml, bodyHtml, itemsTableHtml, totalsHtml, footerHtml, footerLinksHtml } from "./document-html.js";

export { footerLinksHtml };

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

/** A percent as the customer reads it: 8.1 → "8.1%", 8.10 → "8.1%", 8 → "8%". */
const pct = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? `${Number(v.toFixed(3))}%` : "";
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
  websiteUrl: "", // D-081: centred in the footer line
  paymentTerms: "", // D-081: the invoice's PAYMENT TERMS row; DEFAULT_PAYMENT_TERMS when blank
  termsUrl: "", // terms and conditions — printed in the footer of every document
  termsBlurb: "",
  clubUrl: "", // the Service Club landing page — printed in the footer with a line of copy
  clubBlurb: "",
  footerNote: "",
  accentColor: "#1F3864",
});

/** The invoice's payment terms when the tenant has set none (D-081). */
export const DEFAULT_PAYMENT_TERMS = "Upon receipt";

// The footer's two links, with the copy the tenant did not write (generic on purpose —
// nothing Harmon-specific lives here). A brand with no URL for one prints nothing for it.
export const DEFAULT_TERMS_BLURB = "This document and the work it describes are subject to our terms and conditions.";
export const DEFAULT_CLUB_BLURB = "Members get priority scheduling, member pricing on repairs and ongoing system monitoring. See the plans and join online.";

const str = (v) => (v == null ? "" : String(v).trim());

/** The brand block every document model carries. Shared by the estimate, invoice and job report builders. */
export function brandBlock(b, fallbackName) {
  const lines = [b.tagline, b.addressLine, [b.phone, b.email].filter(Boolean).join(" · "), b.licenseLine].filter(Boolean);
  const links = [];
  if (b.termsUrl) links.push({ kind: "terms", label: "Terms & Conditions", url: b.termsUrl, blurb: b.termsBlurb || DEFAULT_TERMS_BLURB });
  if (b.clubUrl) links.push({ kind: "club", label: "Solar Service Club", url: b.clubUrl, blurb: b.clubBlurb || DEFAULT_CLUB_BLURB });
  const companyName = str(b.companyName);
  const websiteUrl = str(b.websiteUrl);
  const websiteLabel = websiteUrl.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return {
    // The tenant's own name, "" when it has none: printed in bold UNDER the logo (D-081).
    companyName,
    // The header's name when there is no logo — never blank, so a document always says something.
    displayName: companyName || fallbackName,
    lines, // kept for any reader of the old single brand column; the frame does not print it
    logoUrl: b.logoUrl || "",
    logoBytes: b.logoBytes instanceof Uint8Array ? b.logoBytes : null, // the PDF painter's; never serialised into the page
    logoKind: b.logoKind || null,
    tagline: str(b.tagline),
    contactLines: [...addressLines(b.addressLine), str(b.phone), str(b.email)].filter(Boolean),
    licenseLine: str(b.licenseLine),
    websiteUrl,
    paymentTerms: str(b.paymentTerms) || DEFAULT_PAYMENT_TERMS,
    footerLine: { left: [companyName, str(b.licenseLine)].filter(Boolean).join(" | "), center: websiteLabel },
    termsUrl: b.termsUrl || "",
    links,
    footerNote: b.footerNote || "",
    accentColor: b.accentColor,
  };
}

/** CONTACT US under the meta box: the tenant's office address, phone and email. */
const contactBlock = (brand) => ({ label: "Contact us", lines: brand.contactLines });

/** A person block from a record's snapshot fields: name (bold), street, city line, phone, email. */
function personLines(r) {
  return [
    r.Customer_Name_at_Creation__c ? { text: r.Customer_Name_at_Creation__c, bold: true } : null,
    ...addressLines(r.Address_at_Creation__c).map((text) => ({ text })),
    r.Primary_Phone_at_Creation__c ? { text: r.Primary_Phone_at_Creation__c } : null,
    r.Primary_Email_at_Creation__c ? { text: r.Primary_Email_at_Creation__c } : null,
  ].filter(Boolean);
}

/** "Total tax", then the jurisdiction (and rate) indented beneath it. */
function taxRows(taxAmount, jurisdiction, rate) {
  if (!(Number(taxAmount) > 0)) return [];
  const where = [str(jurisdiction), pct(rate) ? `(${pct(rate)})` : ""].filter(Boolean).join(" ");
  return [{ label: "Total tax", amount: money(taxAmount) }, where ? { label: where, amount: money(taxAmount), sub: true } : null].filter(Boolean);
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
  const brandModel = brandBlock(b, "Estimate");

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
    { label: "Subtotal", amount: money(t.subtotal) },
    t.discountAmount > 0 ? { label: est.Discount_Source__c === "Service Plan" ? "Service plan discount" : "Discount", amount: money(-t.discountAmount) } : null,
    ...taxRows(t.taxAmount, est.Tax_Jurisdiction__c, est.Tax_Rate__c),
    { label: "Total", amount: money(t.total), strong: true, big: true },
    est.Deposit_Required__c === true && t.depositAmount > 0 ? { label: "Deposit due to schedule", amount: money(t.depositAmount) } : null,
  ].filter(Boolean);

  const meta = [
    { label: "Estimate", value: number },
    version ? { label: "Version", value: String(version) } : null,
    est.Last_Sent_At__c ? { label: "Sent", value: dateOnly(est.Last_Sent_At__c) } : null,
    est.Valid_Until__c ? { label: "Valid through", value: dateOnly(est.Valid_Until__c) } : null,
  ].filter(Boolean);

  const acceptNote = `Approving lets us schedule the work. You'll be asked for a card to keep on file; nothing is charged until the work is done${
    est.Deposit_Required__c === true ? ", except the deposit shown above" : ""
  }.`;

  return {
    mode,
    docLabel: "Estimate",
    title,
    number,
    version,
    brand: brandModel,
    meta,
    metaTotal: { label: "Estimate total", value: money(t.total) },
    left: { lines: personLines(est) },
    rightBlocks: [contactBlock(brandModel)],
    scopeLabel: "Scope of work",
    scope: est.Scope_Summary__c || "",
    columns: { description: "Description", qty: "Qty", unit: showUnit ? "Unit price" : "", amount: "Amount" },
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
 * the payments to date decide the "Balance due" row.
 *
 * Who is billed (D-081): the invoice's own snapshot — Bill_To_Name__c and
 * Bill_To_Address__c, frozen at issue — printed top-left with NO label, plus "Attn:" (the
 * payer company's contact, read live from `payer`) and "Ref" (the partner's reference).
 * When someone other than the homeowner pays, the homeowner moves to SERVICE ADDRESS on
 * the right. When the homeowner pays, they are the left block and SERVICE ADDRESS is left
 * out — the same person is never printed twice. CONTACT US is always there.
 *
 * @param {object} args
 * @param {object} args.invoice   Sundial_Service_Invoice__c record (API names)
 * @param {object} args.job       Sundial_Service_Job__c record (snapshot fields)
 * @param {object} [args.estimate] the source estimate (scope summary, tax jurisdiction)
 * @param {Array}  args.lines     the frozen lines
 * @param {Array}  [args.payments] Sundial_Service_Payment__c rows (Succeeded ones count)
 * @param {object} [args.payer]   the Bill_To_Customer__c record (only for the "Attn:" line)
 * @param {string} [args.serviceDate] the work's date (YYYY-MM-DD or ISO) for SERVICE DATE
 * @param {object} [args.brand]
 * @param {object} [args.options] { mode: "preview"|"pdf"|"email", showUnitPrices, watermark, payUrl }
 */
export function buildInvoiceModel({ invoice, job, estimate, lines, payments = [], payer = null, serviceDate = null, brand = {}, options = {} }) {
  const b = { ...DEFAULT_BRAND, ...brand };
  const mode = options.mode || "pdf";
  const inv = invoice || {};
  const j = job || {};
  const est = estimate || {};
  const number = inv.Name || j.Name || "Invoice";
  const showUnit = options.showUnitPrices !== false;
  const brandModel = brandBlock(b, "Invoice");

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
    { label: "Subtotal", amount: money(inv.Subtotal__c) },
    Number(inv.Discount_Amount__c) > 0 ? { label: est.Discount_Source__c === "Service Plan" ? "Service plan discount" : "Discount", amount: money(-Number(inv.Discount_Amount__c)) } : null,
    ...taxRows(inv.Tax_Amount__c, est.Tax_Jurisdiction__c, inv.Tax_Rate__c),
    { label: "Total", amount: money(total), strong: true },
    paid > 0 ? { label: "Paid to date", amount: money(-paid) } : null,
    { label: balance <= 0 ? "Balance" : "Balance due", amount: money(Math.max(0, balance)), strong: true, big: true },
  ].filter(Boolean);

  // Who pays (D-081). A partner invoice from before D-081 has a name and no record: it
  // prints the name alone, as it always did.
  const partner = !!(inv.Bill_To_Type__c && inv.Bill_To_Type__c !== "Customer");
  const homeownerPays = !partner || (!!inv.Bill_To_Customer__c && inv.Bill_To_Customer__c === j.Sundial_Customer__c);
  const ref = inv.Billing_Reference__c ? { text: `Ref ${inv.Billing_Reference__c}` } : null;
  let left;
  const rightBlocks = [];
  if (homeownerPays) {
    left = [...personLines(j), ref].filter(Boolean);
  } else {
    const attn = customerContactName(payer);
    left = [
      { text: inv.Bill_To_Name__c || inv.Bill_To_Type__c, bold: true },
      attn ? { text: `Attn: ${attn}` } : null,
      ...addressLines(inv.Bill_To_Address__c).map((text) => ({ text })),
      ref,
    ].filter(Boolean);
    rightBlocks.push({ label: "Service address", lines: personLines(j).map((l) => l.text) });
  }
  rightBlocks.push(contactBlock(brandModel));

  const status = inv.Status__c || "";
  const meta = [
    { label: "Invoice", value: number },
    serviceDate ? { label: "Service date", value: dateOnly(serviceDate) } : null,
    { label: "Payment terms", value: brandModel.paymentTerms },
    inv.Due_Date__c ? { label: "Due date", value: dateOnly(inv.Due_Date__c) } : null,
    inv.Issued_At__c ? { label: "Issued", value: dateOnly(inv.Issued_At__c) } : null,
    j.Name && j.Name !== number ? { label: "Job", value: j.Name } : null,
    status === "Paid" ? { label: "Status", value: `PAID${inv.Paid_At__c ? ` ${dateOnly(inv.Paid_At__c)}` : ""}` } : null,
    status === "Void" ? { label: "Status", value: "VOID" } : null,
  ].filter(Boolean);

  const paidNote = status === "Paid" ? "Thank you — this invoice is paid in full." : balance > 0 ? `Balance due: ${money(balance)}${inv.Due_Date__c ? ` by ${dateOnly(inv.Due_Date__c)}` : ""}.` : "";
  return {
    mode,
    docLabel: "Invoice",
    title: `Invoice ${number}`,
    number,
    version: 0,
    brand: brandModel,
    meta,
    metaTotal: status === "Void" ? null : { label: "Amount due", value: money(Math.max(0, balance)) },
    left: { lines: left },
    rightBlocks,
    // The job's "Summary of work" (Customer_Summary__c) is the narrative the office writes
    // for the bill; the estimate's scope is the fallback when there is none yet.
    scopeLabel: "Invoice",
    scope: j.Customer_Summary__c || est.Scope_Summary__c || "",
    columns: { description: "Services", qty: "qty", unit: showUnit ? "unit price" : "", amount: "amount" },
    rows,
    totalRows,
    accept: options.payUrl ? { url: options.payUrl, label: "Pay this invoice", note: "" } : null,
    acceptPlaceholder: null,
    watermark: options.watermark || (status === "Void" ? "VOID" : status === "Paid" ? "PAID" : mode === "preview" ? "PREVIEW" : ""),
    footerNotes: [b.footerNote, paidNote].filter(Boolean),
  };
}

/**
 * HTML painter. Accepts either the raw inputs (estimate/lines/totals/brand/options)
 * or a prebuilt `model` (an estimate's or an invoice's).
 * @returns {{ html: string, title: string, model: object }}
 */
export function renderEstimateDocument(args) {
  const m = args.model || buildEstimateModel(args);
  const accept = m.accept
    ? `<div class="accept"><a class="btn" href="${esc(m.accept.url)}">${esc(m.accept.label)}</a>${m.accept.note ? `<p>${esc(m.accept.note)}</p>` : ""}</div>`
    : m.acceptPlaceholder
      ? `<div class="accept muted"><span class="btn ghost">${esc(m.acceptPlaceholder.label)}</span><p>${esc(m.acceptPlaceholder.note)}</p></div>`
      : "";

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(m.title)}</title>
<style>${frameCss(m.brand.accentColor)}</style></head>
<body><div class="page">
  ${m.watermark ? `<div class="wm">${esc(m.watermark)}</div>` : ""}
  ${headerHtml(m)}
  ${bodyHtml(m.scopeLabel || "Scope of work", m.scope)}
  ${itemsTableHtml(m.columns, m.rows)}
  ${totalsHtml(m.totalRows)}
  ${accept}
  ${footerHtml(m)}
</div></body></html>`;

  return { html, title: m.title, model: m };
}
