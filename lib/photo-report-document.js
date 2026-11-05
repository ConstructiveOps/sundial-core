// lib/photo-report-document.js — THE renderer for the Service module's PHOTO REPORT
// (D-072 amendment 17, 2026-11-05). Harmon's ask since day one: Housecall Pro's photo report —
// a cover page, then sections that each hold MANY photos picked from the job, with an optional
// description per section and per photo. It sits beside the old job report
// (lib/job-report-document.js, one photo + one caption per section), which is untouched.
//
//   normalizePhotoReport()     what the office saved → a clean, capped report (version 2)
//   photoReportChoices()       the job's photos, grouped by call, as the picker shows them
//   buildPhotoReportModel()    job + report + photos + invoice → a plain DOCUMENT MODEL
//   renderPhotoReportDocument  model → HTML  (office preview, the customer's hosted page)
//   lib/photo-report-pdf.js    model → PDF   (download, and every send)
//
// Everything that decides WHAT is shown lives here; the two painters only draw it. The frame
// (brand, meta box, CONTACT US, footer) is the shared one (lib/document-html.js / -pdf.js, D-081).
// THE HEADER IS NOT THE INVOICE'S PAYER BLOCK (Tim, 2026-11-05): the left block is the
// customer's name + the service address when the customer pays, and ONLY the service address
// when anyone else pays — a partner's name never prints on the homeowner's photos. The title is
// "Photo report for {service address}".
//
// A blank leaves no trace: no empty heading, no empty text column, no placeholder, no border.
// PURE: plain objects in, plain objects / one string out; every CSS rule inline.

import { createHash } from "node:crypto";
import { buildInvoiceModel, DEFAULT_BRAND, brandBlock, dateOnly, money } from "./estimate-document.js";
import { addressLines } from "./customer-name.js";
import { esc, frameCss, headerHtml, bodyHtml, itemsTableHtml, totalsHtml, footerHtml } from "./document-html.js";
import { publicUrlForKey } from "./file-access.js";
import { groupJobPhotos, jobPhotoPrefix } from "./job-photos.js";
import { thumbKey } from "./photo-thumbs.js";
import { REPORT_MAX_EDGE } from "./image-resize.js";

export const PHOTO_REPORT_VERSION = 2;
export const MAX_SECTIONS = 60;
export const MAX_PHOTOS = 300;
export const MAX_TITLE = 200;
export const MAX_SCOPE = 4000;
export const MAX_SECTION_NAME = 200;
export const MAX_SECTION_DESCRIPTION = 4000;
export const MAX_PHOTO_DESCRIPTION = 500;
export const LAYOUTS = Object.freeze(["list", "grid"]);
export const DEFAULT_LAYOUT = "list";

/** What can be listed in the picker (an image by its name). */
const IMAGE_RE = /\.(jpe?g|png|gif|webp|heic|heif)$/i;
/** What the PDF can carry — JPEG and PNG only. Anything else may not be put in a report:
 *  the PDF always contains every photo (Tim, 2026-11-05), so a HEIC is refused at save. */
const EMBEDDABLE_RE = /\.(jpe?g|png)$/i;
export const isEmbeddable = (key) => EMBEDDABLE_RE.test(String(key || ""));

const clean = (v) => (v == null ? "" : String(v).replace(/\r\n?/g, "\n").trim());
const keyShape = /^SUNDIAL\/[A-Za-z0-9]{15,18}\/photos\/\S+$/;

/**
 * The shrunk copy of a photo — the SAME key the old report's cache uses
 * (sundial-service-estimate/report.js reportImageCacheKey; a test pins the two together),
 * so a photo shrunk for either report is shrunk for both.
 */
export const REPORT_IMAGE_CACHE_PREFIX = "SUNDIAL/_cache/report-images";
export function reportImageCacheKey(jobId, photoKey) {
  return `${REPORT_IMAGE_CACHE_PREFIX}/${jobId}/${createHash("sha1").update(photoKey).digest("hex").slice(0, 16)}-${REPORT_MAX_EDGE}.jpg`;
}
export const reportImageCachePrefix = (jobId) => `${REPORT_IMAGE_CACHE_PREFIX}/${jobId}/`;

/** An empty report: what a job with no saved row shows, and what "start over" leaves. */
export const emptyPhotoReport = (scope = "") => ({ version: PHOTO_REPORT_VERSION, cover: { title: "", scope: clean(scope).slice(0, MAX_SCOPE), coverPhotoKey: null }, sections: [], receipt: false });

/**
 * The saved report (the PUT body, or the row's cover / sections / receipt) → the clean shape.
 * Unknown keys dropped, text capped, layout defaulted, empty sections dropped, ids made unique.
 * With `jobId`, every photo key must sit under SUNDIAL/{jobId}/photos/.
 * @returns {{ ok: true, value } | { ok: false, error: string }}
 */
export function normalizePhotoReport(input, { jobId = null } = {}) {
  let src = input;
  if (typeof src === "string") {
    try {
      src = src.trim() ? JSON.parse(src) : {};
    } catch {
      return { ok: false, error: "The report could not be read." };
    }
  }
  if (src == null) src = {};
  if (typeof src !== "object" || Array.isArray(src)) return { ok: false, error: "The report must be an object with a cover and sections." };
  const prefix = jobId ? jobPhotoPrefix(jobId) : null;
  const badKey = (k) => !keyShape.test(k) || k.includes("..") || (prefix && !k.startsWith(prefix));

  const c = src.cover && typeof src.cover === "object" && !Array.isArray(src.cover) ? src.cover : {};
  const coverPhotoKey = clean(c.coverPhotoKey) || null;
  if (coverPhotoKey && badKey(coverPhotoKey)) return { ok: false, error: "The cover photo is not a photo on this job." };
  const cover = { title: clean(c.title).slice(0, MAX_TITLE), scope: clean(c.scope).slice(0, MAX_SCOPE), coverPhotoKey };

  if (src.sections != null && !Array.isArray(src.sections)) return { ok: false, error: "sections must be a list." };
  const list = src.sections || [];
  if (list.length > MAX_SECTIONS) return { ok: false, error: `At most ${MAX_SECTIONS} sections.` };
  const sections = [];
  const ids = new Set();
  let photoCount = 0;
  for (const [i, s] of list.entries()) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return { ok: false, error: `Section ${i + 1} is not an object.` };
    if (s.photos != null && !Array.isArray(s.photos)) return { ok: false, error: `Section ${i + 1}: photos must be a list.` };
    const photos = [];
    for (const [k, p] of (s.photos || []).entries()) {
      const key = clean(typeof p === "string" ? p : p?.key);
      if (!key) return { ok: false, error: `Section ${i + 1}, photo ${k + 1}: no photo.` };
      if (badKey(key)) return { ok: false, error: `Section ${i + 1}, photo ${k + 1}: that is not a photo on this job.` };
      photos.push({ key, description: clean(typeof p === "string" ? "" : p?.description).slice(0, MAX_PHOTO_DESCRIPTION) });
    }
    const name = clean(s.name).slice(0, MAX_SECTION_NAME);
    const description = clean(s.description).slice(0, MAX_SECTION_DESCRIPTION);
    if (!photos.length && !name && !description) continue; // nothing in it: nothing
    photoCount += photos.length;
    if (photoCount > MAX_PHOTOS) return { ok: false, error: `At most ${MAX_PHOTOS} photos in one report.` };
    let id = clean(s.id).slice(0, 64) || `s${i + 1}`;
    if (ids.has(id)) id = `s${i + 1}-${ids.size}`;
    ids.add(id);
    sections.push({ id, name, description, layout: LAYOUTS.includes(s.layout) ? s.layout : DEFAULT_LAYOUT, photos });
  }
  return { ok: true, value: { version: PHOTO_REPORT_VERSION, cover, sections, receipt: src.receipt === true } };
}

/** Every photo key the report uses — the cover first, then section order, each once. */
export function reportPhotoKeys(report) {
  const keys = [];
  if (report?.cover?.coverPhotoKey) keys.push(report.cover.coverPhotoKey);
  for (const s of report?.sections || []) for (const p of s.photos || []) keys.push(p.key);
  return [...new Set(keys)];
}

/** A report with nothing a customer could read: no cover photo, no title, no scope, no section photo. */
export function isPhotoReportEmpty(report) {
  const c = report?.cover || {};
  return !c.coverPhotoKey && !c.title && !c.scope && !(report?.sections || []).some((s) => s.photos?.length);
}

/** The saved report with every photo no longer on the job taken out (deleted since it was picked). */
export function withoutMissingPhotos(report, onJob) {
  const missing = new Set(reportPhotoKeys(report).filter((k) => !onJob.has(k)));
  if (!missing.size) return { report, missing: [] };
  const cover = { ...report.cover, coverPhotoKey: missing.has(report.cover?.coverPhotoKey) ? null : report.cover?.coverPhotoKey ?? null };
  const sections = report.sections
    .map((s) => ({ ...s, photos: s.photos.filter((p) => !missing.has(p.key)) }))
    .filter((s) => s.photos.length || s.name || s.description);
  return { report: { ...report, cover, sections }, missing: [...missing] };
}

/**
 * The job's photos as the picker shows them: GET /service/jobs/{id}/photos's groups (by call,
 * the office's folder first, the HCP migration last), images only, each photo with its
 * thumbnail, its shrunk copy for the page (`largeUrl`, null until made) and whether the PDF
 * can carry it. `files` is the job folder's S3 listing; `cachedKeys` / `thumbKeys` are Sets.
 */
export function photoReportChoices({ files, jobId, calls = [], cachedKeys = new Set(), thumbKeys = new Set() }) {
  const prefix = jobPhotoPrefix(jobId);
  const photos = (files || [])
    .filter((f) => f.key && f.key.startsWith(prefix) && IMAGE_RE.test(f.key))
    .map((f) => {
      const cache = reportImageCacheKey(jobId, f.key);
      const thumb = thumbKey(jobId, f.key);
      return {
        key: f.key,
        fileName: f.fileName,
        publicUrl: f.publicUrl ?? publicUrlForKey(f.key),
        thumbUrl: thumbKeys.has(thumb) ? publicUrlForKey(thumb) : null,
        largeUrl: cachedKeys.has(cache) ? publicUrlForKey(cache) : null,
        size: f.size ?? null,
        lastModified: f.lastModified ?? null,
        embeddable: isEmbeddable(f.key),
      };
    });
  const groups = groupJobPhotos(photos, prefix, calls).map((g) => ({ callId: g.callId, callNumber: g.callNumber, techName: g.techName, label: g.label, photos: g.photos }));
  const byKey = new Map(groups.flatMap((g) => g.photos.map((p) => [p.key, p])));
  return { groups, byKey, total: byKey.size };
}

/** A day in Arizona as YYYY-MM-DD (Harmon's day; the state keeps no daylight time). */
export function azDay(at) {
  const d = at instanceof Date ? at : new Date(at || Date.now());
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", { timeZone: "America/Phoenix" });
}

/** "Photo report for 12 Palm Ln, Mesa, AZ 85201" — the job's service address; else the job number. */
export function photoReportTitle(job) {
  const where = addressLines(job?.Address_at_Creation__c).join(", ");
  return where ? `Photo report for ${where}` : `Photo report for ${job?.Name || "your service"}`;
}

/** The download / attachment name: the title, made safe for a file system. */
export function photoReportFileName(job, suffix = "") {
  const base = photoReportTitle(job).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "Photo-report";
  return `${base}${suffix ? `-${suffix}` : ""}.pdf`;
}

/**
 * Build the document model.
 * @param {object} args
 * @param {object} args.job         Sundial_Service_Job__c (snapshot fields, Bill_To_Type__c)
 * @param {object} args.report      normalizePhotoReport().value (photos already checked against the job)
 * @param {Map}    [args.photos]    photoReportChoices().byKey — urls for the page
 * @param {object} [args.invoice]   the job's live invoice (null → no receipt)
 * @param {Array}  [args.lines]     the invoice's frozen lines
 * @param {Array}  [args.payments]  the invoice's payments
 * @param {object} [args.estimate]  for the tax jurisdiction / discount labels
 * @param {object} [args.preparedBy] { name, at } — the sender and the send (or today, before one)
 * @param {object} [args.brand]
 * @param {object} [args.options]   { mode: "preview"|"customer"|"pdf", watermark, pdfUrl }
 */
export function buildPhotoReportModel({ job, report, photos = new Map(), invoice = null, lines = [], payments = [], estimate = null, preparedBy = null, brand = {}, options = {} }) {
  const b = { ...DEFAULT_BRAND, ...brand };
  const mode = options.mode || "preview";
  const j = job || {};
  const r = report || emptyPhotoReport();
  const number = j.Name || "Job";
  const brandModel = brandBlock(b, "Photo report");
  const urlOf = (key) => {
    const p = photos.get(key);
    return { url: p?.largeUrl || p?.publicUrl || publicUrlForKey(key), thumbUrl: p?.thumbUrl || p?.largeUrl || p?.publicUrl || publicUrlForKey(key) };
  };

  // --- the header: the customer when they pay, else the service address alone ---------------
  const customerPays = !j.Bill_To_Type__c || j.Bill_To_Type__c === "Customer";
  const where = addressLines(j.Address_at_Creation__c);
  const left = [
    customerPays && j.Customer_Name_at_Creation__c ? { text: j.Customer_Name_at_Creation__c, bold: true } : null,
    ...where.map((text) => ({ text })),
  ].filter(Boolean);
  const meta = [
    { label: "Job", value: number },
    j.Service_Type__c ? { label: "Service type", value: String(j.Service_Type__c) } : null,
    preparedBy?.at ? { label: mode === "preview" ? "Date" : "Sent", value: dateOnly(azDay(preparedBy.at)) } : null,
  ].filter(Boolean);

  // --- the cover ------------------------------------------------------------------------------
  const c = r.cover || {};
  const preparedLine = [preparedBy?.name ? `Prepared by ${preparedBy.name}` : "", preparedBy?.at ? dateOnly(azDay(preparedBy.at)) : ""].filter(Boolean).join(" · ");
  const cover = {
    photo: c.coverPhotoKey ? { key: c.coverPhotoKey, ...urlOf(c.coverPhotoKey) } : null,
    title: c.title || "",
    scopeLabel: "Scope of work",
    scope: c.scope || "",
    prepared: preparedLine,
  };

  // --- the sections: grid shows photos only, list shows each photo's words beside it ----------
  const sections = (r.sections || []).map((s) => ({
    id: s.id,
    name: s.name || "",
    description: s.description || "",
    layout: s.layout === "grid" ? "grid" : "list",
    photos: (s.photos || []).map((p) => ({ key: p.key, ...urlOf(p.key), description: s.layout === "grid" ? "" : p.description || "" })),
  }));

  // --- the receipt: ticked, a live invoice, and the customer pays (never a partner's bill) ----
  const live = invoice && invoice.Status__c !== "Void" && invoice.Status__c !== "Draft" ? invoice : null;
  let receipt = null;
  if (r.receipt === true && live && customerPays) {
    const inv = buildInvoiceModel({ invoice: live, job: j, estimate, lines, payments, brand: b, options: { mode: "pdf" } });
    const paid = Number(live.Paid_Amount__c) || 0;
    const balance = Math.round(((Number(live.Total__c) || 0) - paid) * 100) / 100;
    receipt = {
      label: live.Status__c === "Paid" ? "Receipt" : "Invoice summary",
      number: live.Name || number,
      columns: inv.columns,
      rows: inv.rows,
      totalRows: inv.totalRows,
      paymentLines: (payments || [])
        .filter((p) => p.Status__c === "Succeeded" && p.Type__c !== "Refund")
        .map((p) => `${p.Received_At__c ? dateOnly(p.Received_At__c) : "Payment"} · ${p.Method__c || "Payment"}${p.Reference__c ? ` ${p.Reference__c}` : ""} · ${money(p.Amount__c)}`),
      note: live.Status__c === "Paid" ? "Paid in full — thank you." : balance > 0 ? `Balance due: ${money(balance)}${live.Due_Date__c ? ` by ${dateOnly(live.Due_Date__c)}` : ""}.` : "",
    };
  }

  const title = photoReportTitle(j);
  return {
    mode,
    docLabel: "Photo report",
    title,
    heading: title,
    number,
    brand: brandModel,
    meta,
    metaTotal: null,
    left: { lines: left },
    rightBlocks: [{ label: "Contact us", lines: brandModel.contactLines }],
    cover,
    sections,
    receipt,
    photoKeys: reportPhotoKeys(r),
    pdfUrl: options.pdfUrl || null,
    watermark: options.watermark || (mode === "preview" ? "PREVIEW" : ""),
    footerNotes: [b.footerNote].filter(Boolean),
    empty: isPhotoReportEmpty(r),
  };
}

/** HTML painter. @returns {{ html: string, title: string, model: object }} */
export function renderPhotoReportDocument(args) {
  const m = args.model || buildPhotoReportModel(args);
  const accent = esc(m.brand.accentColor);
  const img = (src, alt, cls = "", lazy = true) => `<img${cls ? ` class="${cls}"` : ""} src="${esc(src)}" alt="${esc(alt)}"${lazy ? ' loading="lazy"' : ""}>`;

  const cover = [
    m.cover.photo ? `<figure class="cover">${img(m.cover.photo.url, m.cover.title || m.title, "", false)}</figure>` : "",
    m.cover.title ? `<div class="ctitle">${esc(m.cover.title)}</div>` : "",
    bodyHtml(m.cover.scopeLabel, m.cover.scope),
    m.cover.prepared ? `<p class="prep">${esc(m.cover.prepared)}</p>` : "",
  ].join("");

  const sections = m.sections
    .map((s) => {
      const head = `${s.name ? `<h3>${esc(s.name)}</h3>` : ""}${s.description ? `<div class="sdesc">${esc(s.description)}</div>` : ""}`;
      const body =
        s.layout === "grid"
          ? s.photos.length ? `<div class="grid">${s.photos.map((p, i) => `<div class="cell">${img(p.thumbUrl, `${s.name || "Photo"} ${i + 1}`)}</div>`).join("")}</div>` : ""
          : s.photos
              .map((p, i) =>
                p.description
                  ? `<div class="row">${`<div class="ph">${img(p.url, p.description.slice(0, 120))}</div>`}<div class="tx">${esc(p.description)}</div></div>`
                  : `<div class="row full">${img(p.url, `${s.name || "Photo"} ${i + 1}`)}</div>`
              )
              .join("");
      return `<section class="sec">${head}${body}</section>`;
    })
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
  .rtitle{font-size:22px;font-weight:700;margin:4px 0 16px}
  figure.cover{margin:0 0 16px}
  figure.cover img{width:100%;height:auto;display:block}
  .ctitle{font-size:20px;font-weight:700;margin:0 0 10px}
  .prep{font-size:12px;color:#71717a;margin:14px 0 0}
  .sec{margin:30px 0 0}
  .sec h3{font-size:17px;margin:0 0 6px}
  .sdesc{font-weight:700;font-size:15px;white-space:pre-wrap;margin:0 0 10px}
  .row{display:flex;gap:18px;align-items:flex-start;margin:14px 0;break-inside:avoid}
  .row .ph{flex:0 0 45%}
  .row img{width:100%;height:auto;display:block}
  .row.full img{max-height:640px;object-fit:contain}
  .row .tx{flex:1;white-space:pre-wrap}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}
  .grid .cell{aspect-ratio:1/1;display:flex;align-items:flex-start;justify-content:center;break-inside:avoid}
  .grid img{max-width:100%;max-height:100%;object-fit:contain;display:block}
  .pay{font-size:12px;color:#52525b;margin-top:8px;text-align:right}
  .note{font-weight:600;margin:12px 0 0;text-align:right}
  .pdf{margin-top:24px;font-size:13px}
  .pdf a{color:${accent};font-weight:600}
  @media (max-width:640px){.row{flex-direction:column}.row .ph{flex-basis:auto;width:100%}.grid{grid-template-columns:repeat(2,1fr)}}
</style></head>
<body><div class="page">
  ${m.watermark ? `<div class="wm">${esc(m.watermark)}</div>` : ""}
  ${headerHtml(m)}
  <div class="rtitle">${esc(m.heading)}</div>
  ${cover}
  ${sections}
  ${m.empty ? '<p style="color:#a1a1aa">Nothing in this report yet.</p>' : ""}
  ${receipt}
  ${m.pdfUrl ? `<p class="pdf"><a href="${esc(m.pdfUrl)}">Download the PDF</a></p>` : ""}
  ${footerHtml(m, "<p>Questions about this report? Reply to the email it came with, or call us.</p>")}
</div></body></html>`;

  return { html, title: m.title, model: m };
}
