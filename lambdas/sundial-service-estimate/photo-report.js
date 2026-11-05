// photo-report.js — the Service module's PHOTO REPORT (D-072 amendment 17, 2026-11-05).
//
//   GET    /service/jobs/{id}/photo-report                    the report + the photos to pick from + send state
//   PUT    /service/jobs/{id}/photo-report                    { cover, sections, receipt, baseUpdatedAt? } — save
//   DELETE /service/jobs/{id}/photo-report                    start over (the row, its link and its send history stay)
//   GET    /service/jobs/{id}/photo-report/preview            { html, title } — PREVIEW watermark
//   GET    /service/jobs/{id}/photo-report/pdf                the PDF as it stands — 200 { base64 | url } or 202 { renderId }
//   POST   /service/jobs/{id}/photo-report/prepare            shrink the report's photos into the cache, in rounds
//   POST   /service/jobs/{id}/photo-report/send               { via, to?, toPhone?, message? } — 200 sent, or 202 { renderId }
//   GET    /service/jobs/{id}/photo-report/renders/{renderId} a background render's status (the portal polls it)
//   { task: "photo-report-render", renderId }                 the background worker: this Lambda invoking itself
//   (public) GET /public/photo-reports/{token}                lives in sundial-service-public
//
// Modelled on Housecall Pro's photo report (Harmon's ask since day one): a cover, then sections
// each holding many of the job's photos. It sits BESIDE the old job report (report.js,
// Report_Sections__c), which is untouched. The report lives in Supabase
// (sundial_job_photo_reports, one row per job), never in Salesforce.
//
// EVERY PHOTO IS IN THE PDF (Tim, 2026-11-05) — no placeholder, no "see the hosted page".
// The PDF embeds only the shrunk copies in the report-image cache (the SAME cache the old
// report fills — lib/photo-report-document.js reportImageCacheKey), and it is not rendered
// until every photo of the report is in that cache. A JPEG is shrunk to 1,600 px
// (lib/image-resize.js); a small JPEG or a PNG is COPIED into the cache as it is. An original
// is never re-encoded, moved or touched. So:
//   - prepare shrinks what is missing, in ~21 s rounds (the portal calls it until done);
//   - send / download first prepare inside the request (SEND_PREPARE_BUDGET_MS); when every
//     photo is cached and the report is small enough (INLINE_MAX_PHOTOS) the PDF is made in the
//     request; otherwise a render row is queued and this Lambda invokes itself — the CSV
//     pattern of sundial-reports — and the portal polls GET …/renders/{renderId}. The worker
//     prepares what is left, hands itself on (a new invocation) when its time runs low, and
//     sends the email / text ONLY once the PDF exists. A send never goes out without its PDF.
//
// Who receives it: lib/send-to.js — the box, else the BILL-TO PARTY (the payer record when
// someone other than the homeowner pays), else the job's customer. Sending never stamps
// Report_Sent_to_Customer__c (Tim's standing call, 2026-10-22).

import { soqlEscapeString } from "../../lib/salesforce.js";
import { EVENTS } from "../../lib/service-activity.js";
import { buildKey, publicUrlForKey, registerFileMetadata } from "../../lib/file-access.js";
import { PhotoNotReadyError } from "../../lib/photo-report-pdf.js";
import { thumbPrefix } from "../../lib/photo-thumbs.js";
import { resolveRecipients, sendDefaults, viaFrom, needsEmail, needsPhone } from "../../lib/send-to.js";
import {
  buildPhotoReportModel, emptyPhotoReport, isEmbeddable, isPhotoReportEmpty, normalizePhotoReport, photoReportChoices,
  photoReportFileName, photoReportTitle, renderPhotoReportDocument, reportImageCacheKey, reportImageCachePrefix, reportPhotoKeys, withoutMissingPhotos,
} from "../../lib/photo-report-document.js";
import { invoicePayerId } from "./invoice.js";
import { REPORT_JOB_SELECT, PREPARE_BUDGET_MS } from "./report.js";
import { JOB_SF_OBJECT } from "./fields.js";

export const PHOTO_REPORT_TABLE = "sundial_job_photo_reports";
export const RENDERS_TABLE = "sundial_job_photo_report_renders";
export const PHOTO_REPORT_TOKEN_DAYS = 365;
/** Attached when the PDF is at most this; linked above it (SES v2: 40 MB per message, base64 adds a third). */
export const EMAIL_ATTACH_MAX_BYTES = 20 * 1024 * 1024;
/** The download comes back as base64 up to this (Lambda's response cap is 6 MB; base64 adds a third). */
export const DOWNLOAD_INLINE_MAX_BYTES = 4 * 1024 * 1024;
/** A send / download is made in the request only when every photo is cached and there are at most this many. */
export const INLINE_MAX_PHOTOS = 60;
/** How long a send / download spends shrinking photos inside the request before handing the rest to the worker. */
export const SEND_PREPARE_BUDGET_MS = 12000;
/** The worker hands itself on when less than this is left of its invocation. */
export const WORKER_RESERVE_MS = 60000;
/** A worker that hands itself on more than this many times has stalled. */
export const MAX_HOPS = 12;
/** A queued / running render older than this was lost (the worker died without saying so). */
export const LOST_AFTER_MS = 20 * 60000;
/** Cached copies fetched at once for a render. */
const FETCH_CONCURRENCY = 6;
const MAX_TEXT_CHARS = 320;
const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const strOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/** Whether two reports say the same thing (cover, sections, receipt), key order aside. */
export function sameReport(a, b) {
  const canon = (r) => {
    const n = normalizePhotoReport({ cover: r?.cover, sections: r?.sections, receipt: r?.receipt });
    return n.ok ? JSON.stringify(n.value) : "";
  };
  return canon(a) === canon(b);
}

/** JPEG / PNG from the bytes alone (a file named .jpg that is not one must never reach the PDF). */
export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 7 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  return null;
}
/** A photo the PDF can never carry: answered at once, naming it (a retry would not help). */
const unsupportedOf = (t) => t.failed.filter((f) => f.reason === "unsupported").map((f) => f.key);

/** The hosted page: the portal's public /photo-report/{token} route. */
export function publicPhotoReportUrl(token, baseUrl) {
  const base = (baseUrl || "").replace(/\/+$/, "");
  return base && token ? `${base}/photo-report/${encodeURIComponent(token)}` : null;
}
/** SUNDIAL/{jobId}/photo-report-{n}.pdf — one file per send, all kept in the job's Files. */
export const photoReportPdfKey = (jobId, n) => buildKey(jobId, `photo-report-${n}.pdf`);
/** A download too big to answer inline: REPORTS/ (7-day lifecycle rule), never SUNDIAL/. */
export const downloadKey = (clientSfId, jobId, renderId, at) => `REPORTS/${clientSfId}/${at.toISOString().slice(0, 10)}/photo-report-${jobId}-${renderId}.pdf`;

/**
 * The email (Tim, 2026-11-05): HTML with real links — "Click here for the report" (the hosted
 * page) and "Download the PDF" — never a bare URL in the HTML. The plain-text alternative has to
 * carry the addresses (a text-only mail client has no link text).
 */
export function buildPhotoReportEmail({ job, title, brandName, url, pdfUrl, pdfAttached, message }) {
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const name = job?.Customer_Name_at_Creation__c;
  const customerPays = !job?.Bill_To_Type__c || job.Bill_To_Type__c === "Customer";
  const subject = `${title}${brandName ? ` — ${brandName}` : ""}`;
  const greeting = customerPays && name ? `Hello ${name},` : "Hello,";
  const lead = message ? String(message).trim() : `Here is the photo report from our visit${job?.Address_at_Creation__c ? ` at ${job.Address_at_Creation__c}` : ""}.`;
  const attachNote = pdfAttached ? "A PDF copy is attached." : "";
  const button = (href, label, ghost = false) =>
    `<a href="${esc(href)}" style="display:inline-block;${ghost ? "background:#e4e4e7;color:#18181b" : "background:#1F3864;color:#fff"};padding:10px 18px;border-radius:8px;text-decoration:none;margin:0 8px 8px 0">${esc(label)}</a>`;
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;max-width:560px">
<p>${esc(greeting)}</p>
${lead.split("\n").filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join("")}
<p>${url ? button(url, "Click here for the report") : ""}${pdfUrl ? button(pdfUrl, "Download the PDF", true) : ""}</p>
${attachNote ? `<p>${esc(attachNote)}</p>` : ""}
<p>Questions? Just reply to this email.</p>
</div>`;
  const text = [greeting, "", lead, url ? `Click here for the report: ${url}` : "", pdfUrl ? `Download the PDF: ${pdfUrl}` : "", attachNote, "", "Questions? Just reply to this email."].filter((l, i, a) => l !== "" || (a[i - 1] !== "" && i > 0)).join("\n");
  return { subject, html, text };
}

/** The text message: short, the hosted link only (SMS has no link text). */
export function buildPhotoReportText({ brandName, url }) {
  return `${brandName ? `${brandName}: your` : "Your"} photo report is ready: ${url}`.slice(0, MAX_TEXT_CHARS);
}

/**
 * @param d  the estimate handler's deps (sfQuery, getSupabaseClient, listFiles, listKeys, getObject,
 *           putObject, resizeImage, renderPhotoReportPdf, sendEmail, isEmailConfigured, sms,
 *           presignGet, invokeSelf, now, randomToken)
 * @param h  { publicBaseFor, noPublicUrlDetail, loadEstimate, loadLines, act, brandFor, jsonResponse,
 *             bad, notFound, money, loadJobCalls, recipientRecords }
 */
export function createPhotoReportHandlers(d, h) {
  const { jsonResponse, bad, notFound, money } = h;
  const db = () => d.getSupabaseClient();

  async function loadJob(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(`SELECT ${REPORT_JOB_SELECT} FROM ${JOB_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
    return rows?.[0] ?? null;
  }
  async function readRow(jobId, tenantId) {
    const { data, error } = await (await db()).from(PHOTO_REPORT_TABLE).select("*").eq("job_sf_id", jobId).eq("client_sf_id", tenantId).maybeSingle();
    if (error) throw new Error(`photo report read failed: ${error.message}`);
    return data ?? null;
  }
  async function writeRow(row, patch, { jobId, tenantId, profileId }) {
    const sb = await db();
    if (row) {
      const { error } = await sb.from(PHOTO_REPORT_TABLE).update({ ...patch, updated_by: profileId ?? null }).eq("id", row.id);
      if (error) throw new Error(`photo report write failed: ${error.message}`);
    } else {
      const { error } = await sb.from(PHOTO_REPORT_TABLE).insert({ client_sf_id: tenantId, job_sf_id: jobId, created_by: profileId ?? null, updated_by: profileId ?? null, ...patch });
      if (error) throw new Error(`photo report create failed: ${error.message}`);
    }
    return readRow(jobId, tenantId);
  }
  const reportOf = (row, jobId) => {
    if (!row) return null;
    const n = normalizePhotoReport({ cover: row.cover, sections: row.sections, receipt: row.receipt }, { jobId });
    return n.ok ? n.value : emptyPhotoReport();
  };

  /** The job's photo folder, its cached copies and its thumbnails — three listings, nothing read. */
  async function photoIndex(job, tenantId) {
    const [files, calls, cached, thumbs] = await Promise.all([
      d.listFiles(job.Id).catch((e) => (console.error("photo report: photo list failed:", e?.message || e), [])),
      h.loadJobCalls(job.Id, tenantId).catch(() => []),
      d.listKeys(reportImageCachePrefix(job.Id)).catch(() => []),
      d.listKeys(thumbPrefix(job.Id)).catch(() => []),
    ]);
    const cachedKeys = new Set(cached);
    return { ...photoReportChoices({ files, jobId: job.Id, calls, cachedKeys, thumbKeys: new Set(thumbs) }), cachedKeys };
  }

  /** The live invoice + its lines and payments, and the estimate — for the receipt. */
  async function receiptData(job, tenantId) {
    const [invoices, payments] = await Promise.all([money.loadJobInvoices(job.Id, tenantId), money.loadJobPayments(job.Id, tenantId)]);
    const invoice = money.currentOf(invoices);
    const live = invoice && invoice.Status__c !== "Void" ? invoice : null;
    const estimate = job.Estimate__c ? await h.loadEstimate(job.Estimate__c, tenantId) : null;
    const lines = live && estimate ? (await h.loadLines(estimate.Id, tenantId)).filter((l) => l.Stage__c !== "Removed") : [];
    return { invoice: live, lines, payments: (payments || []).filter((p) => !live || !p.Invoice__c || p.Invoice__c === live.Id), estimate };
  }

  /** The send box's prefill: the payer record when someone other than the homeowner pays, else the customer. */
  async function recipientsFor(job, tenantId) {
    const recs = await h.recipientRecords({ payerId: invoicePayerId(null, job), customerId: job.Sundial_Customer__c, tenantId });
    return { recs, snapshot: { email: job.Primary_Email_at_Creation__c, phone: job.Primary_Phone_at_Creation__c, name: job.Customer_Name_at_Creation__c } };
  }

  /** The latest unfinished render of a kind, or null. A lost one counts as finished. */
  async function activeRender(jobId, tenantId, kind) {
    const { data } = await (await db()).from(RENDERS_TABLE).select("*").eq("job_sf_id", jobId).eq("client_sf_id", tenantId).eq("kind", kind).order("created_at", { ascending: false }).limit(1);
    const r = data?.[0];
    if (!r || !["queued", "running"].includes(r.status)) return null;
    return d.now().getTime() - new Date(r.created_at).getTime() > LOST_AFTER_MS ? null : r;
  }

  function state(job, row, report, extras, ctx) {
    const updated = row?.updated_at ?? null;
    const sent = row?.sent_at ?? null;
    return {
      jobId: job.Id,
      jobNumber: job.Name ?? null,
      report: row ? { cover: report.cover, sections: report.sections, receipt: report.receipt } : null,
      updatedAt: updated,
      sentAt: sent,
      sentCount: Number(row?.sent_count) || 0,
      // Edited since sent = what is saved differs from what was sent (the row's updated_at moves
      // on the send's own write too, so a timestamp cannot say it).
      editedSinceSent: !!(sent && row?.sent_report && report && sameReport(row.sent_report, report) === false),
      publicUrl: row?.public_token ? publicPhotoReportUrl(row.public_token, h.publicBaseFor(ctx)) : null,
      pdfUrl: row?.pdf_key ? publicUrlForKey(row.pdf_key) : null,
      partnerBilled: !!(job.Bill_To_Type__c && job.Bill_To_Type__c !== "Customer"),
      summary: job.Customer_Summary__c ?? null,
      ...extras,
    };
  }

  // --- the shrunk-copy cache ------------------------------------------------------------------
  /**
   * Put ONE photo's copy in the report-image cache: a JPEG shrunk (lib/image-resize.js), or —
   * when it is already small, or cannot be decoded — the original bytes as they are; a PNG as
   * it is. Never anything else, never the original's own key.
   * @returns {"resized"|"copied"|"unsupported"|"failed"}
   */
  async function cacheOne(jobId, key) {
    try {
      const obj = await d.getObject({ key });
      if (!obj?.bytes?.length) return "failed";
      const kind = sniffImage(obj.bytes); // the bytes decide — S3's content type is not trusted
      if (!kind) return "unsupported";
      const cacheKey = reportImageCacheKey(jobId, key);
      if (kind === "jpg" && d.resizeImage) {
        const r = d.resizeImage(obj.bytes, { contentType: obj.contentType });
        if (r?.resized) {
          await d.putObject({ key: cacheKey, body: r.bytes, contentType: "image/jpeg" });
          return "resized";
        }
      }
      await d.putObject({ key: cacheKey, body: obj.bytes, contentType: kind === "png" ? "image/png" : "image/jpeg" });
      return "copied";
    } catch (e) {
      console.error("photo report: cache failed:", key, e?.message || e);
      return "failed";
    }
  }

  /** Cache what is missing until the budget runs out. Mutates `cached` (a Set of cache keys). */
  async function prepareKeys(jobId, keys, cached, { budgetMs, startedAt = Date.now() }) {
    const tally = { total: keys.length, ready: 0, pending: 0, shrunk: 0, failed: [] };
    for (const key of keys) {
      const ck = reportImageCacheKey(jobId, key);
      if (cached.has(ck)) {
        tally.ready++;
        continue;
      }
      if (Date.now() - startedAt >= budgetMs) {
        tally.pending++;
        continue;
      }
      const s = await cacheOne(jobId, key);
      if (s === "resized" || s === "copied") {
        cached.add(ck);
        tally.ready++;
        if (s === "resized") tally.shrunk++;
      } else tally.failed.push({ key, reason: s });
    }
    return tally;
  }

  /** The cached copies of every key, a few at a time. Throws PhotoNotReadyError for any gap. */
  async function loadImages(jobId, keys) {
    const images = new Map();
    const absent = [];
    for (let i = 0; i < keys.length; i += FETCH_CONCURRENCY) {
      await Promise.all(
        keys.slice(i, i + FETCH_CONCURRENCY).map(async (key) => {
          const obj = await d.getObject({ key: reportImageCacheKey(jobId, key) }).catch(() => null);
          if (obj?.bytes?.length) images.set(key, obj);
          else absent.push(key);
        })
      );
    }
    if (absent.length) throw new PhotoNotReadyError(absent);
    return images;
  }

  // --- making the PDF, and sending it ---------------------------------------------------------
  async function makePdf({ ctx, job, report, index, preparedBy, pdfUrl, tenantId }) {
    const m = await receiptData(job, tenantId);
    const model = buildPhotoReportModel({ job, report, photos: index.byKey, ...m, preparedBy, brand: h.brandFor(ctx), options: { mode: "pdf", pdfUrl } });
    const images = await loadImages(job.Id, model.photoKeys);
    const bytes = await d.renderPhotoReportPdf(model, images);
    return { bytes, model, invoice: m.invoice };
  }

  /** A download: base64 when it fits the response, else stored under REPORTS/ and linked. */
  async function finishDownload({ ctx, job, report, index, tenantId, renderId = null, inline }) {
    const { bytes } = await makePdf({ ctx, job, report, index, tenantId, preparedBy: { name: ctx.actor?.name ?? null, at: d.now().toISOString() } });
    const fileName = photoReportFileName(job);
    if (inline && bytes.byteLength <= DOWNLOAD_INLINE_MAX_BYTES) return { fileName, contentType: "application/pdf", base64: Buffer.from(bytes).toString("base64"), bytes: bytes.byteLength };
    const key = downloadKey(tenantId, job.Id, renderId || d.randomToken(), d.now());
    await d.putObject({ key, body: bytes, contentType: "application/pdf" });
    return { fileName, contentType: "application/pdf", key, url: await d.presignGet({ key, fileName }), bytes: bytes.byteLength };
  }

  /**
   * A send: the PDF (refused without it), stored in the job's Files, then the email / text, then
   * the row's token / stamps / snapshot. Returns the response body or { error: { status, body } }.
   */
  async function finishSend({ ctx, job, row, report, index, tenantId, body }) {
    const via = viaFrom(body);
    const { recs, snapshot } = await recipientsFor(job, tenantId);
    const who = resolveRecipients({ via, to: body?.to, toPhone: body?.toPhone, ...recs, snapshot });
    if (!who.ok) return { error: { status: who.status, body: { error: "bad_request", code: who.code, message: who.message, ...(who.missing ? { missing: who.missing } : {}), ...(who.invalid ? { invalid: who.invalid } : {}) } } };
    const now = d.now();
    const token = row.public_token || d.randomToken();
    const url = publicPhotoReportUrl(token, h.publicBaseFor(ctx));
    const sentCount = (Number(row.sent_count) || 0) + 1;
    const pdfKey = photoReportPdfKey(job.Id, sentCount);
    const pdfUrl = publicUrlForKey(pdfKey);
    const brand = h.brandFor(ctx);
    const senderName = strOrNull(ctx.actor?.name);

    // The PDF first: nothing goes out without it.
    let pdf;
    try {
      pdf = await makePdf({ ctx, job, report, index, tenantId, pdfUrl, preparedBy: { name: senderName, at: now.toISOString() } });
      await d.putObject({ key: pdfKey, body: pdf.bytes, contentType: "application/pdf" });
    } catch (e) {
      console.error(`photo report: PDF failed for ${job.Id}: ${e?.message || e}`);
      return { error: { status: e instanceof PhotoNotReadyError ? 409 : 502, body: { error: "pdf_failed", code: e?.code || "PDF_RENDER_FAILED", message: "The PDF could not be made, so nothing was sent. Try again.", ...(e?.keys ? { keys: e.keys } : {}) } } };
    }
    try {
      await registerFileMetadata(await db(), {
        s3Key: pdfKey, fileName: `photo-report-${sentCount}.pdf`, tenantId, sfRecordId: job.Id, sfObjectType: "job",
        uploadedByUserId: ctx.profileId ?? null, uploadedByUserName: senderName, fileSizeBytes: pdf.bytes.byteLength,
        mimeType: "application/pdf", category: "Photo Report", description: pdf.model.title.slice(0, 255), subfolder: null,
      });
    } catch (e) {
      console.error(`photo report: file metadata register failed for ${pdfKey}: ${e?.message || e}`);
    }

    let delivery = "recorded";
    const detail = [];
    let recipient = null;
    let textedTo = null;
    let attached = false;
    if (!url) detail.push(h.noPublicUrlDetail(ctx));
    if (needsEmail(via) && url) {
      if (!d.isEmailConfigured()) detail.push("EMAIL_FROM is not set on this Lambda (SES not wired).");
      else {
        attached = pdf.bytes.byteLength <= EMAIL_ATTACH_MAX_BYTES;
        const msg = buildPhotoReportEmail({ job, title: pdf.model.title, brandName: brand.companyName, url, pdfUrl, pdfAttached: attached, message: strOrNull(body?.message) });
        const attachments = attached ? [{ fileName: photoReportFileName(job), contentType: "application/pdf", content: pdf.bytes }] : [];
        const sent = await d.sendEmail({ to: who.email, subject: msg.subject, html: msg.html, text: msg.text, attachments });
        if (sent.ok) {
          delivery = "email";
          recipient = who.email;
        } else detail.push(`Email failed: ${sent.error}`);
      }
    }
    if (needsPhone(via) && url) {
      if (!d.sms) detail.push("Texting is not wired on this Lambda.");
      else {
        const r = await d.sms.sendText({ tenantId, tenantSlug: ctx.tenantSlug, job, to: who.phone, body: buildPhotoReportText({ brandName: brand.companyName, url }), sentBy: { id: ctx.userId ?? null, name: senderName } });
        if (r.ok) {
          textedTo = r.to ?? who.phone;
          delivery = delivery === "email" ? "both" : "sms";
        } else detail.push(r.code === "NO_PHONE" ? "There is no mobile number to text." : `Text failed: ${r.error || r.code}`);
      }
    }

    const fresh = await writeRow(row, {
      public_token: token,
      token_expires_at: new Date(now.getTime() + PHOTO_REPORT_TOKEN_DAYS * 86400000).toISOString(),
      sent_at: now.toISOString(),
      sent_count: sentCount,
      pdf_key: pdfKey,
      sent_by_name: senderName,
      sent_report: { cover: report.cover, sections: report.sections, receipt: report.receipt },
    }, { jobId: job.Id, tenantId, profileId: ctx.profileId });
    const deliveryDetail = detail.join(" ") || null;
    await h.act(ctx, {
      event: EVENTS.JOB_REPORT_SENT, recordType: "job", recordSfId: job.Id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null,
      details: { report: "photo", via, delivery, recipient, textedTo, deliveryDetail, sections: report.sections.length, photos: pdf.model.photoKeys.length, receipt: !!pdf.model.receipt, sentCount, pdfKey, pdfBytes: pdf.bytes.byteLength, attached },
    });
    return { body: { success: true, jobId: job.Id, via, delivery, recipient, textedTo, deliveryDetail, attached, pdfBytes: pdf.bytes.byteLength, sentCount, sentAt: fresh?.sent_at ?? now.toISOString(), publicUrl: url, pdfUrl } };
  }

  /** Queue a background render and start the worker. */
  async function queueRender({ ctx, job, kind, body }) {
    const sb = await db();
    const request = { ctx: { tenantId: ctx.tenantId, tenantSlug: ctx.tenantSlug, userId: ctx.userId ?? null, profileId: ctx.profileId ?? null, actorName: ctx.actor?.name ?? null }, body: kind === "send" ? { via: body?.via ?? null, to: body?.to ?? null, toPhone: body?.toPhone ?? null, message: body?.message ?? null } : {} };
    const { data, error } = await sb.from(RENDERS_TABLE).insert({ client_sf_id: ctx.tenantId, job_sf_id: job.Id, kind, status: "queued", request, created_by: ctx.profileId ?? null }).select("id").maybeSingle();
    if (error || !data?.id) {
      console.error("photo report: could not queue the render:", error?.message || "no id");
      return jsonResponse(500, ctx.cors, { error: "server_error" });
    }
    try {
      await d.invokeSelf({ task: "photo-report-render", renderId: data.id, tenantSlug: ctx.tenantSlug ?? null });
    } catch (e) {
      console.error("photo report: self-invoke failed:", e?.message || e);
      await sb.from(RENDERS_TABLE).update({ status: "failed", error_code: "WORKER_INVOKE_FAILED", finished_at: d.now().toISOString() }).eq("id", data.id);
      return jsonResponse(502, ctx.cors, { error: "worker_invoke_failed", code: "WORKER_INVOKE_FAILED" });
    }
    return jsonResponse(202, ctx.cors, { renderId: data.id, kind, status: "queued" });
  }

  /** What a send or download needs before it can start: the job, the saved report, the photos. */
  async function readyToRender({ ctx, params }) {
    const { tenantId, cors } = ctx;
    const job = await loadJob(params[0], tenantId);
    if (!job) return { res: notFound(cors) };
    const row = await readRow(job.Id, tenantId);
    const index = await photoIndex(job, tenantId);
    const { report } = withoutMissingPhotos(reportOf(row, job.Id) ?? emptyPhotoReport(), new Set(index.byKey.keys()));
    if (!row || isPhotoReportEmpty(report)) return { res: bad(cors, "PHOTO_REPORT_EMPTY", "Add a cover photo, a title, a Scope of work or a section with photos before sending.") };
    const keys = reportPhotoKeys(report);
    const odd = keys.filter((k) => !isEmbeddable(k));
    if (odd.length) return { res: bad(cors, "PHOTO_NOT_EMBEDDABLE", `${odd.length} photo(s) are not JPEG or PNG and cannot go in the PDF — take them out of the report.`, { keys: odd }) };
    return { job, row, report, index, keys };
  }

  return {
    async getPhotoReport({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const [row, index, m, who] = await Promise.all([readRow(job.Id, tenantId), photoIndex(job, tenantId), receiptData(job, tenantId), recipientsFor(job, tenantId)]);
      const saved = reportOf(row, job.Id);
      const { report, missing } = saved ? withoutMissingPhotos(saved, new Set(index.byKey.keys())) : { report: null, missing: [] };
      const rendering = await activeRender(job.Id, tenantId, "send");
      return jsonResponse(200, cors, state(job, row, report, {
        title: photoReportTitle(job),
        photos: index.groups,
        photoCount: index.total,
        missingPhotos: missing,
        invoice: m.invoice ? { number: m.invoice.Name ?? null, status: m.invoice.Status__c ?? null, total: Number(m.invoice.Total__c) || 0, paid: Number(m.invoice.Paid_Amount__c) || 0 } : null,
        sendDefaults: sendDefaults({ ...who.recs, snapshot: who.snapshot }),
        rendering: rendering ? { renderId: rendering.id, kind: rendering.kind, status: rendering.status } : null,
      }, ctx));
    },

    async savePhotoReport({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const norm = normalizePhotoReport(body, { jobId: job.Id });
      if (!norm.ok) return bad(cors, "PHOTO_REPORT_INVALID", norm.error);
      const row = await readRow(job.Id, tenantId);
      if (body?.baseUpdatedAt && row && row.updated_at !== body.baseUpdatedAt) {
        return jsonResponse(409, cors, { error: "conflict", code: "PHOTO_REPORT_CHANGED", message: "Someone else saved this report since you opened it — reload to see their changes.", updatedAt: row.updated_at });
      }
      const value = norm.value;
      // First save: the Scope of Work starts as the job's Summary of work unless the body says otherwise.
      if (!row && (body?.cover?.scope === undefined) && job.Customer_Summary__c) value.cover.scope = String(job.Customer_Summary__c).trim().slice(0, 4000);
      const index = await photoIndex(job, tenantId);
      const keys = reportPhotoKeys(value);
      const strangers = keys.filter((k) => !index.byKey.has(k));
      if (strangers.length) return bad(cors, "PHOTO_NOT_ON_JOB", `${strangers.length} photo(s) are not on this job.`, { keys: strangers });
      const odd = keys.filter((k) => !isEmbeddable(k));
      if (odd.length) return bad(cors, "PHOTO_NOT_EMBEDDABLE", `${odd.length} photo(s) are not JPEG or PNG — the PDF can only carry JPEG and PNG photos.`, { keys: odd });
      const fresh = await writeRow(row, { cover: value.cover, sections: value.sections, receipt: value.receipt }, { jobId: job.Id, tenantId, profileId: ctx.profileId });
      await h.act(ctx, { event: EVENTS.JOB_UPDATED, recordType: "job", recordSfId: job.Id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null, details: { report: "photo", action: row ? "saved" : "created", sections: value.sections.length, photos: keys.length, receipt: value.receipt } });
      return jsonResponse(200, cors, { success: true, ...state(job, fresh, value, { title: photoReportTitle(job), photoCount: index.total, missingPhotos: [] }, ctx) });
    },

    async deletePhotoReport({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const row = await readRow(job.Id, tenantId);
      if (!row) return jsonResponse(200, cors, { success: true, cleared: false, ...state(job, null, null, {}, ctx) });
      // Start over: the content goes; the row, its token, its last PDF and its send history stay,
      // so a link already sent keeps showing what was sent until the next send replaces it.
      const fresh = await writeRow(row, { cover: {}, sections: [], receipt: false }, { jobId: job.Id, tenantId, profileId: ctx.profileId });
      await h.act(ctx, { event: EVENTS.JOB_UPDATED, recordType: "job", recordSfId: job.Id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null, details: { report: "photo", action: "cleared" } });
      return jsonResponse(200, cors, { success: true, cleared: true, ...state(job, fresh, emptyPhotoReport(), {}, ctx) });
    },

    async previewPhotoReport({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const [row, index, m] = await Promise.all([readRow(job.Id, tenantId), photoIndex(job, tenantId), receiptData(job, tenantId)]);
      const { report } = withoutMissingPhotos(reportOf(row, job.Id) ?? emptyPhotoReport(job.Customer_Summary__c), new Set(index.byKey.keys()));
      const model = buildPhotoReportModel({ job, report, photos: index.byKey, ...m, preparedBy: { name: ctx.actor?.name ?? null, at: d.now().toISOString() }, brand: h.brandFor(ctx), options: { mode: "preview", pdfUrl: row?.pdf_key ? publicUrlForKey(row.pdf_key) : null } });
      const { html, title } = renderPhotoReportDocument({ model });
      return jsonResponse(200, cors, { html, title, sections: model.sections.length, photos: model.photoKeys.length, receipt: !!model.receipt });
    },

    /** POST …/photo-report/prepare — warm the cache in rounds; the portal calls it until `done`. */
    async preparePhotoReport({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const startedAt = Date.now();
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const row = await readRow(job.Id, tenantId);
      const index = await photoIndex(job, tenantId);
      const { report } = withoutMissingPhotos(reportOf(row, job.Id) ?? emptyPhotoReport(), new Set(index.byKey.keys()));
      const keys = reportPhotoKeys(report).filter(isEmbeddable);
      const t = await prepareKeys(job.Id, keys, index.cachedKeys, { budgetMs: PREPARE_BUDGET_MS, startedAt });
      return jsonResponse(200, cors, { total: t.total, ready: t.ready, pending: t.pending, shrunk: t.shrunk, failed: t.failed, done: t.pending === 0 && t.failed.length === 0 });
    },

    /** GET …/photo-report/pdf — the document as it stands, for the portal's Download button. Nothing in the job's Files. */
    async photoReportPdf({ ctx, params }) {
      const startedAt = Date.now();
      const r = await readyToRender({ ctx, params });
      if (r.res) return r.res;
      const t = await prepareKeys(r.job.Id, r.keys, r.index.cachedKeys, { budgetMs: SEND_PREPARE_BUDGET_MS, startedAt });
      const odd = unsupportedOf(t);
      if (odd.length) return bad(ctx.cors, "PHOTO_NOT_EMBEDDABLE", `${odd.length} photo(s) are not readable JPEG or PNG files — take them out of the report.`, { keys: odd });
      if (t.pending || t.failed.length || r.keys.length > INLINE_MAX_PHOTOS) return queueRender({ ctx, job: r.job, kind: "download", body: {} });
      try {
        const out = await finishDownload({ ctx, job: r.job, report: r.report, index: r.index, tenantId: ctx.tenantId, inline: true });
        const { key, ...rest } = out;
        return jsonResponse(200, ctx.cors, rest);
      } catch (e) {
        console.error(`photo report: download failed for ${r.job.Id}: ${e?.message || e}`);
        if (e instanceof PhotoNotReadyError) return queueRender({ ctx, job: r.job, kind: "download", body: {} });
        return jsonResponse(502, ctx.cors, { error: "pdf_failed", code: "PDF_RENDER_FAILED", message: "The PDF could not be made. Try again." });
      }
    },

    async sendPhotoReport({ ctx, params, body }) {
      const startedAt = Date.now();
      const r = await readyToRender({ ctx, params });
      if (r.res) return r.res;
      const { job, row, report, index, keys } = r;
      const { tenantId, cors } = ctx;
      // Who it goes to is settled before anything else happens — a 400 records nothing.
      const via = viaFrom(body);
      const { recs, snapshot } = await recipientsFor(job, tenantId);
      const who = resolveRecipients({ via, to: body?.to, toPhone: body?.toPhone, ...recs, snapshot });
      if (!who.ok) return jsonResponse(who.status, cors, { error: "bad_request", code: who.code, message: who.message, ...(who.missing ? { missing: who.missing } : {}), ...(who.invalid ? { invalid: who.invalid } : {}) });
      const busy = await activeRender(job.Id, tenantId, "send");
      if (busy) return jsonResponse(409, cors, { error: "conflict", code: "PHOTO_REPORT_SENDING", message: "This report is already being sent.", renderId: busy.id });
      const t = await prepareKeys(job.Id, keys, index.cachedKeys, { budgetMs: SEND_PREPARE_BUDGET_MS, startedAt });
      const odd = unsupportedOf(t);
      if (odd.length) return bad(cors, "PHOTO_NOT_EMBEDDABLE", `${odd.length} photo(s) are not readable JPEG or PNG files — take them out of the report.`, { keys: odd });
      if (t.pending || t.failed.length || keys.length > INLINE_MAX_PHOTOS) return queueRender({ ctx, job, kind: "send", body });
      const out = await finishSend({ ctx, job, row, report, index, tenantId, body });
      if (out.error) return jsonResponse(out.error.status, cors, out.error.body);
      return jsonResponse(200, cors, out.body);
    },

    /** GET …/photo-report/renders/{renderId} — a background render's progress. */
    async photoReportRender({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const [jobId, renderId] = params;
      if (!SF_ID_RE.test(jobId || "") || !UUID_RE.test(renderId || "")) return notFound(cors);
      const { data: row } = await (await db()).from(RENDERS_TABLE).select("*").eq("id", renderId).eq("job_sf_id", jobId).eq("client_sf_id", tenantId).maybeSingle();
      if (!row) return notFound(cors);
      const lost = ["queued", "running"].includes(row.status) && d.now().getTime() - new Date(row.created_at).getTime() > LOST_AFTER_MS;
      const status = lost ? "failed" : row.status;
      const out = { renderId: row.id, kind: row.kind, status, errorCode: lost ? "RENDER_LOST" : row.error_code ?? null, progress: row.result?.progress ?? null, createdAt: row.created_at, finishedAt: row.finished_at ?? null };
      if (status === "done" && row.kind === "download" && row.pdf_key) {
        out.fileName = row.result?.fileName ?? null;
        out.url = await d.presignGet({ key: row.pdf_key, fileName: out.fileName || "photo-report.pdf" });
      }
      if (status === "done" && row.kind === "send") Object.assign(out, row.result || {});
      if (status === "failed" && row.result?.keys) out.keys = row.result.keys;
      return jsonResponse(200, cors, out);
    },

    /**
     * The background worker ({ task: "photo-report-render", renderId }). Prepares what is not
     * cached, hands itself on when its time runs low, then makes the PDF and — for a send —
     * delivers it. Never sends without the PDF; a failure is written on the row.
     */
    async photoReportWorker({ renderId }, { remainingMs = () => Infinity } = {}) {
      if (!UUID_RE.test(renderId || "")) return { ok: false, error: "bad_render_id" };
      const sb = await db();
      const { data: render } = await sb.from(RENDERS_TABLE).select("*").eq("id", renderId).maybeSingle();
      if (!render || !["queued", "running"].includes(render.status)) return { ok: false, error: "not_pending" };
      const fail = async (code, extra = {}) => {
        await sb.from(RENDERS_TABLE).update({ status: "failed", error_code: code, result: { ...(render.result || {}), ...extra }, finished_at: d.now().toISOString() }).eq("id", renderId);
        console.log(JSON.stringify({ photoReport: "render failed", renderId, kind: render.kind, code }));
        return { ok: false, error: code };
      };
      await sb.from(RENDERS_TABLE).update({ status: "running", ...(render.started_at ? {} : { started_at: d.now().toISOString() }) }).eq("id", renderId);
      const rc = render.request?.ctx || {};
      const ctx = { tenantId: render.client_sf_id, tenantSlug: rc.tenantSlug ?? null, userId: rc.userId ?? null, profileId: rc.profileId ?? null, actor: { id: rc.userId ?? null, name: rc.actorName ?? null }, cors: {} };
      try {
        const job = await loadJob(render.job_sf_id, ctx.tenantId);
        if (!job) return fail("JOB_NOT_FOUND");
        const row = await readRow(job.Id, ctx.tenantId);
        const index = await photoIndex(job, ctx.tenantId);
        const { report } = withoutMissingPhotos(reportOf(row, job.Id) ?? emptyPhotoReport(), new Set(index.byKey.keys()));
        if (!row || isPhotoReportEmpty(report)) return fail("PHOTO_REPORT_EMPTY");
        const keys = reportPhotoKeys(report).filter(isEmbeddable);
        const t = await prepareKeys(job.Id, keys, index.cachedKeys, { budgetMs: Math.max(0, remainingMs() - WORKER_RESERVE_MS) });
        if (t.failed.some((f) => f.reason === "unsupported")) return fail("PHOTO_NOT_EMBEDDABLE", { keys: t.failed.map((f) => f.key) });
        if (t.pending || t.failed.length) {
          // Out of time (or S3 hiccupped): hand on to a fresh invocation, which picks up from the cache.
          const hops = (Number(render.hops) || 0) + 1;
          if (hops > MAX_HOPS) return fail("PHOTOS_NOT_READY", { keys: t.failed.map((f) => f.key) });
          await sb.from(RENDERS_TABLE).update({ hops, result: { ...(render.result || {}), progress: { total: t.total, ready: t.ready } } }).eq("id", renderId);
          await d.invokeSelf({ task: "photo-report-render", renderId, tenantSlug: ctx.tenantSlug });
          return { ok: true, handedOn: true, ready: t.ready, total: t.total };
        }
        if (render.kind === "download") {
          const out = await finishDownload({ ctx, job, report, index, tenantId: ctx.tenantId, renderId, inline: false });
          await sb.from(RENDERS_TABLE).update({ status: "done", pdf_key: out.key, result: { fileName: out.fileName, bytes: out.bytes }, finished_at: d.now().toISOString() }).eq("id", renderId);
          return { ok: true };
        }
        const out = await finishSend({ ctx, job, row, report, index, tenantId: ctx.tenantId, body: render.request?.body || {} });
        if (out.error) return fail(out.error.body.code || "SEND_FAILED", { message: out.error.body.message, ...(out.error.body.keys ? { keys: out.error.body.keys } : {}) });
        await sb.from(RENDERS_TABLE).update({ status: "done", pdf_key: out.body.pdfUrl ? photoReportPdfKey(job.Id, out.body.sentCount) : null, result: out.body, finished_at: d.now().toISOString() }).eq("id", renderId);
        return { ok: true };
      } catch (e) {
        console.error(`photo report worker ${renderId}: ${e?.message || e}`);
        return fail(e instanceof PhotoNotReadyError ? "PHOTOS_NOT_READY" : "RENDER_FAILED", e?.keys ? { keys: e.keys } : {});
      }
    },
  };
}
