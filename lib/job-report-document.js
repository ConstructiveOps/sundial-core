// lib/job-report-document.js — THE renderer for the customer's job report + receipt
// (D-072 amendment 10, 2026-09-19). Same discipline as lib/estimate-document.js:
//
//   normalizeReportSections()  what the office saved (JSON on the job) → a clean list
//   buildJobReportModel()      job + sections + photos + invoice → a plain DOCUMENT MODEL
//   renderJobReportDocument()  model → HTML  (office preview, hosted page, email body)
//   lib/job-report-pdf.js      model → PDF   (attached to the send, stored in S3)
//
// The office builds the report one section at a time in the portal (a photo from the
// job + a description), so the model is mostly what they typed; the header merges the
// customer / job details and the job's Summary of work, the receipt at the end is the
// invoice document's own rows and totals (buildInvoiceModel, so the two never disagree),
// and it is left out when the payer is a partner — the customer's copy never shows a
// partner's money. Anything that decides WHAT is shown lives here and nowhere else.
//
// PURE: plain objects in, one string out; every CSS rule inline (email clients and the
// PDF need that); tenant identity comes in as `brand`.

import { buildInvoiceModel, DEFAULT_BRAND, brandBlock, dateOnly, footerLinksHtml, money } from "./estimate-document.js";
import { publicUrlForKey } from "./file-access.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const REPORT_JSON_VERSION = 1;
export const MAX_SECTIONS = 60;
export const MAX_CAPTION_CHARS = 2000;
const IMAGE_RE = /\.(jpe?g|png|gif|webp|heic|heif)$/i;

const clean = (v) => (v == null ? "" : String(v).replace(/\r\n?/g, "\n").trim());

/**
 * The saved report (Report_Sections__c JSON, or the popup's body) → { version, sections,
 * receipt, intro }. Unknown keys are dropped, captions capped, photo keys must be plain
 * S3 keys (no path tricks). Returns { ok:false, error } for garbage.
 */
export function normalizeReportSections(input) {
  let src = input;
  if (typeof src === "string") {
    try {
      src = src.trim() ? JSON.parse(src) : {};
    } catch {
      return { ok: false, error: "The saved report could not be read." };
    }
  }
  if (src == null) src = {};
  if (typeof src !== "object" || Array.isArray(src)) return { ok: false, error: "sections must be an object with a sections list." };
  const list = Array.isArray(src.sections) ? src.sections : [];
  if (list.length > MAX_SECTIONS) return { ok: false, error: `At most ${MAX_SECTIONS} sections.` };
  const sections = [];
  for (const [i, s] of list.entries()) {
    if (!s || typeof s !== "object") return { ok: false, error: `Section ${i + 1} is not an object.` };
    const photoKey = clean(s.photoKey);
    const caption = clean(s.caption).slice(0, MAX_CAPTION_CHARS);
    if (photoKey && !/^SUNDIAL\/[A-Za-z0-9]{15,18}\/photos\/[^\s]+$/.test(photoKey)) return { ok: false, error: `Section ${i + 1}: that is not a photo on this job.` };
    if (!photoKey && !caption) continue; // an empty section is nothing
    sections.push({ id: clean(s.id) || `s${i + 1}`, photoKey: photoKey || null, caption });
  }
  const receipt = src.receipt !== false; // default on; the model still drops it for a partner payer
  const intro = clean(src.intro).slice(0, MAX_CAPTION_CHARS);
  return { ok: true, value: { version: REPORT_JSON_VERSION, sections, receipt, intro } };
}

/** The job's photos the popup may pick from: images under SUNDIAL/{jobId}/photos/, grouped by visit. */
export function reportPhotoChoices(files, jobId, calls = []) {
  const prefix = `SUNDIAL/${jobId}/photos/`;
  const callInfo = new Map((calls || []).map((c) => [c.Id, c]));
  return (files || [])
    .filter((f) => f.key && f.key.startsWith(prefix) && IMAGE_RE.test(f.key))
    .map((f) => {
      const rest = f.key.slice(prefix.length);
      const slash = rest.indexOf("/");
      const callId = slash > 0 ? rest.slice(0, slash) : null;
      const c = callId ? callInfo.get(callId) : null;
      const tech = c?.Tech__r ? [c.Tech__r.First_Name__c, c.Tech__r.Last_Name__c].filter(Boolean).join(" ") : null;
      return {
        key: f.key,
        fileName: slash > 0 ? rest.slice(slash + 1) : rest,
        publicUrl: f.publicUrl,
        size: f.size ?? null,
        lastModified: f.lastModified ?? null,
        callId,
        callNumber: c?.Name ?? null,
        visitLabel: callId ? [tech ?? "Visit", c?.Scheduled_Start__c ? dateOnly(c.Scheduled_Start__c) : null].filter(Boolean).join(" · ") : "Office",
      };
    })
    .sort((a, b) => String(a.lastModified ?? "").localeCompare(String(b.lastModified ?? "")));
}

/**
 * Build the document model.
 * @param {object} args
 * @param {object} args.job        Sundial_Service_Job__c (snapshot fields, Customer_Summary__c, Report_*)
 * @param {object} args.report     normalizeReportSections().value
 * @param {Array}  [args.photos]   reportPhotoChoices() output (to resolve keys → URLs / visit labels)
 * @param {object} [args.invoice]  the job's live invoice (null → no receipt)
 * @param {Array}  [args.lines]    the invoice's frozen lines
 * @param {Array}  [args.payments] Succeeded payment rows
 * @param {object} [args.estimate] for the tax jurisdiction / discount source labels
 * @param {object} [args.brand]
 * @param {object} [args.options]  { mode: "preview"|"customer"|"pdf"|"email", watermark, pdfUrl }
 */
export function buildJobReportModel({ job, report, photos = [], invoice = null, lines = [], payments = [], estimate = null, brand = {}, options = {} }) {
  const b = { ...DEFAULT_BRAND, ...brand };
  const mode = options.mode || "preview";
  const j = job || {};
  const r = report || { sections: [], receipt: true, intro: "" };
  const number = j.Name || "Job";
  const byKey = new Map((photos || []).map((p) => [p.key, p]));

  const sections = (r.sections || []).map((s, i) => {
    const p = s.photoKey ? byKey.get(s.photoKey) : null;
    return {
      index: i + 1,
      photoKey: s.photoKey,
      photoUrl: p?.publicUrl ?? (s.photoKey ? publicUrlForKey(s.photoKey) : null),
      photoMissing: !!s.photoKey && !p,
      visitLabel: p?.visitLabel ?? null,
      caption: s.caption || "",
    };
  });

  // The receipt: the invoice document's rows and totals, verbatim — never a second set
  // of numbers. Skipped for a partner payer (the customer's copy never shows their bill),
  // when the office switched it off, or when there is no invoice yet.
  const partner = !!(j.Bill_To_Type__c && j.Bill_To_Type__c !== "Customer");
  const live = invoice && invoice.Status__c !== "Void" && invoice.Status__c !== "Draft" ? invoice : null;
  let receipt = null;
  if (r.receipt !== false && live && !partner) {
    const inv = buildInvoiceModel({ invoice: live, job: j, estimate, lines, payments, brand: b, options: { mode: "pdf" } });
    const paid = Number(live.Paid_Amount__c) || 0;
    const balance = Math.round(((Number(live.Total__c) || 0) - paid) * 100) / 100;
    const paymentLines = (payments || [])
      .filter((p) => p.Status__c === "Succeeded" && p.Type__c !== "Refund")
      .map((p) => `${p.Received_At__c ? dateOnly(p.Received_At__c) : "Payment"} · ${p.Method__c || "Payment"}${p.Reference__c ? ` ${p.Reference__c}` : ""} · ${money(p.Amount__c)}`);
    receipt = {
      label: live.Status__c === "Paid" ? "Receipt" : "Invoice summary",
      number: live.Name || number,
      status: live.Status__c || "",
      columns: inv.columns,
      rows: inv.rows,
      totalRows: inv.totalRows,
      paymentLines,
      note: live.Status__c === "Paid" ? "Paid in full — thank you." : balance > 0 ? `Balance due: ${money(balance)}${live.Due_Date__c ? ` by ${dateOnly(live.Due_Date__c)}` : ""}.` : "",
    };
  }

  const customerLines = [j.Customer_Name_at_Creation__c, j.Address_at_Creation__c, j.Primary_Phone_at_Creation__c, j.Primary_Email_at_Creation__c].filter(Boolean);
  const metaLines = [
    j.Service_Type__c ? String(j.Service_Type__c) : null,
    j.Report_Sent_At__c ? `Sent ${dateOnly(j.Report_Sent_At__c)}` : null,
    live?.Status__c === "Paid" ? `PAID${live.Paid_At__c ? ` ${dateOnly(live.Paid_At__c)}` : ""}` : null,
  ].filter(Boolean);

  return {
    mode,
    docLabel: "Job report",
    customerLabel: "Prepared for",
    title: `Job report ${number}`,
    number,
    brand: brandBlock(b, "Job report"),
    metaLines,
    customerLines,
    summaryLabel: "Summary of work",
    summary: j.Customer_Summary__c || "",
    intro: r.intro || "",
    sections,
    receipt,
    pdfUrl: options.pdfUrl || null,
    watermark: options.watermark || (mode === "preview" ? "PREVIEW" : ""),
    footerNotes: [b.footerNote].filter(Boolean),
    empty: sections.length === 0 && !(j.Customer_Summary__c || "").trim(),
  };
}

/** HTML painter. @returns {{ html: string, title: string, model: object }} */
export function renderJobReportDocument(args) {
  const m = args.model || buildJobReportModel(args);
  const accent = esc(m.brand.accentColor);

  const sections = m.sections
    .map(
      (s) => `<section class="sec">
        ${s.photoUrl ? `<figure><img src="${esc(s.photoUrl)}" alt="${esc(s.caption ? s.caption.slice(0, 120) : `Photo ${s.index}`)}">${s.visitLabel ? `<figcaption>${esc(s.visitLabel)}</figcaption>` : ""}</figure>` : ""}
        ${s.caption ? `<div class="cap">${esc(s.caption)}</div>` : ""}
      </section>`
    )
    .join("");

  const receipt = m.receipt
    ? `<h2>${esc(m.receipt.label)} · ${esc(m.receipt.number)}</h2>
  <table>
    <thead><tr><th>${esc(m.receipt.columns.description)}</th><th class="num">${esc(m.receipt.columns.qty)}</th><th class="num">${esc(m.receipt.columns.unit)}</th><th class="num">${esc(m.receipt.columns.amount)}</th></tr></thead>
    <tbody>${m.receipt.rows.map((r) => `<tr><td class="desc">${esc(r.description)}</td><td class="num">${esc(r.qty)}</td><td class="num">${esc(r.unit)}</td><td class="num">${esc(r.amount)}</td></tr>`).join("") || '<tr><td colspan="4" style="color:#a1a1aa">No line items</td></tr>'}</tbody>
    <tfoot>${m.receipt.totalRows.map((r) => `<tr class="${r.strong ? "grand" : ""}"><td colspan="3">${esc(r.label)}</td><td class="num">${esc(r.amount)}</td></tr>`).join("")}</tfoot>
  </table>
  ${m.receipt.paymentLines.length ? `<div class="pay">${m.receipt.paymentLines.map((l) => `<div>${esc(l)}</div>`).join("")}</div>` : ""}
  ${m.receipt.note ? `<p class="note">${esc(m.receipt.note)}</p>` : ""}`
    : "";

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(m.title)}</title>
<style>
  body{margin:0;background:#f4f4f5;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b}
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
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#71717a;margin:22px 0 8px}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  .summary,.cap,.intro{white-space:pre-wrap}
  .sec{margin:18px 0 26px;break-inside:avoid}
  figure{margin:0 0 8px}
  figure img{width:100%;max-height:520px;object-fit:contain;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;display:block}
  figcaption{font-size:11px;color:#71717a;margin-top:4px}
  .cap{font-size:14px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#71717a;text-align:left;padding:6px 8px;border-bottom:1px solid #e4e4e7}
  td{padding:8px;border-bottom:1px solid #f1f1f3;vertical-align:top}
  td.desc{width:60%}
  .num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  th.num{text-align:right}
  tr.grand td{font-weight:700;font-size:16px;border-top:2px solid #18181b;border-bottom:none}
  .pay{font-size:12px;color:#52525b;margin-top:8px}
  .note{font-weight:600;margin:12px 0 0}
  .pdf{margin-top:24px;font-size:12px}
  .pdf a{color:${accent}}
  footer{margin-top:28px;border-top:1px solid #e4e4e7;padding-top:12px;font-size:11px;color:#71717a}
  footer a{color:inherit}
  @media (max-width:640px){.page{padding:22px 18px;margin:0}.two{grid-template-columns:1fr}}
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
      <div>${esc(m.docLabel)}</div>
      <div class="num">${esc(m.number)}</div>
      ${m.metaLines.map((s) => `<div>${esc(s)}</div>`).join("")}
    </div>
  </header>

  <div class="two">
    <div><h2>${esc(m.customerLabel)}</h2>${m.customerLines.map((s) => `<div>${esc(s)}</div>`).join("") || '<div style="color:#a1a1aa">No customer on this document</div>'}</div>
    ${m.summary ? `<div><h2>${esc(m.summaryLabel)}</h2><div class="summary">${esc(m.summary)}</div></div>` : ""}
  </div>

  ${m.intro ? `<p class="intro">${esc(m.intro)}</p>` : ""}
  ${m.sections.length ? `<h2>What we found and did</h2>${sections}` : m.empty ? '<p style="color:#a1a1aa">Nothing in this report yet.</p>' : ""}

  ${receipt}

  ${m.pdfUrl ? `<p class="pdf">Download this report as a PDF: <a href="${esc(m.pdfUrl)}">${esc(m.pdfUrl)}</a></p>` : ""}

  <footer>
    ${m.footerNotes.map((s) => `<p>${esc(s)}</p>`).join("")}
    <p>Questions about this report? Reply to the email it came with, or call us.</p>
    ${footerLinksHtml(m.brand)}
  </footer>
</div></body></html>`;

  return { html, title: m.title, model: m };
}
