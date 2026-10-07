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

import { buildInvoiceModel, DEFAULT_BRAND, brandBlock, dateOnly, money } from "./estimate-document.js";
import { addressLines } from "./customer-name.js";
import { esc, frameCss, headerHtml, bodyHtml, itemsTableHtml, totalsHtml, footerHtml } from "./document-html.js";
import { publicUrlForKey } from "./file-access.js";

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
 * @param {string} [args.serviceDate] the work's date for the meta box (optional)
 * @param {object} [args.brand]
 * @param {object} [args.options]  { mode: "preview"|"customer"|"pdf"|"email", watermark, pdfUrl }
 */
export function buildJobReportModel({ job, report, photos = [], invoice = null, lines = [], payments = [], estimate = null, serviceDate = null, brand = {}, options = {} }) {
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

  const brandModel = brandBlock(b, "Job report");
  const left = [
    j.Customer_Name_at_Creation__c ? { text: j.Customer_Name_at_Creation__c, bold: true } : null,
    ...addressLines(j.Address_at_Creation__c).map((text) => ({ text })),
    j.Primary_Phone_at_Creation__c ? { text: j.Primary_Phone_at_Creation__c } : null,
    j.Primary_Email_at_Creation__c ? { text: j.Primary_Email_at_Creation__c } : null,
  ].filter(Boolean);
  const meta = [
    { label: "Job", value: number },
    serviceDate ? { label: "Service date", value: dateOnly(serviceDate) } : null,
    j.Service_Type__c ? { label: "Service type", value: String(j.Service_Type__c) } : null,
    j.Report_Sent_At__c ? { label: "Sent", value: dateOnly(j.Report_Sent_At__c) } : null,
    live?.Status__c === "Paid" ? { label: "Status", value: `PAID${live.Paid_At__c ? ` ${dateOnly(live.Paid_At__c)}` : ""}` } : null,
  ].filter(Boolean);

  return {
    mode,
    docLabel: "Job report",
    title: `Job report ${number}`,
    number,
    brand: brandModel,
    meta,
    metaTotal: null,
    left: { lines: left },
    rightBlocks: [{ label: "Contact us", lines: brandModel.contactLines }],
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
  ${itemsTableHtml(m.receipt.columns, m.receipt.rows, "No line items")}
  ${totalsHtml(m.receipt.totalRows)}
  ${m.receipt.paymentLines.length ? `<div class="pay">${m.receipt.paymentLines.map((l) => `<div>${esc(l)}</div>`).join("")}</div>` : ""}
  ${m.receipt.note ? `<p class="note">${esc(m.receipt.note)}</p>` : ""}`
    : "";

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(m.title)}</title>
<style>${frameCss(m.brand.accentColor)}
  .cap,.intro{white-space:pre-wrap}
  .sec{margin:18px 0 26px;break-inside:avoid}
  figure{margin:0 0 8px}
  figure img{width:100%;max-height:520px;object-fit:contain;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;display:block}
  figcaption{font-size:11px;color:#71717a;margin-top:4px}
  .pay{font-size:12px;color:#52525b;margin-top:8px;text-align:right}
  .note{font-weight:600;margin:12px 0 0;text-align:right}
  .pdf{margin-top:24px;font-size:12px}
  .pdf a{color:${accent}}
</style></head>
<body><div class="page">
  ${m.watermark ? `<div class="wm">${esc(m.watermark)}</div>` : ""}
  ${headerHtml(m)}
  ${bodyHtml(m.summaryLabel, m.summary)}

  ${m.intro ? `<p class="intro">${esc(m.intro)}</p>` : ""}
  ${m.sections.length ? `<h2>What we found and did</h2>${sections}` : m.empty ? '<p style="color:#a1a1aa">Nothing in this report yet.</p>' : ""}

  ${receipt}

  ${m.pdfUrl ? `<p class="pdf">Download this report as a PDF: <a href="${esc(m.pdfUrl)}">${esc(m.pdfUrl)}</a></p>` : ""}

  ${footerHtml(m, "<p>Questions about this report? Reply to the email it came with, or call us.</p>")}
</div></body></html>`;

  return { html, title: m.title, model: m };
}
