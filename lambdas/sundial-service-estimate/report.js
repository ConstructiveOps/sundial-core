// report.js — the customer's job report + receipt (D-072 amendment 10, 2026-09-19).
//
//   GET  /service/jobs/{id}/report           the saved sections + the photos to pick from + send state
//   PUT  /service/jobs/{id}/report           { sections:[{ id?, photoKey?, caption }], receipt?, intro? } — save (stamps Report_Updated_At__c)
//   GET  /service/jobs/{id}/report/preview   the document (HTML), PREVIEW watermark
//   POST /service/jobs/{id}/report/send      { to?, via?: "Email"|"Both"|"SMS", message? } — render the PDF, email the link + PDF, text the link
//   (public)  GET /public/reports/{token}    lives in sundial-service-public — the hosted page
//
// The office builds the report one section at a time in the portal (a photo on the job +
// a description) and the JSON lives on the job (`Report_Sections__c`) — the report is a
// document ABOUT the job, edited after sending and sent again as often as needed; there is
// no separate report record and no version log (the send count and last-sent stamp are the
// history; every send's PDF is kept in the job's Files). The header merges the customer /
// job details and the job's Summary of work; the receipt is the invoice document's own rows
// (lib/job-report-document.js decides what shows — never here).
//
// Send is best-effort past the write: the PDF failing, the email failing, the text failing
// are each reported in `deliveryDetail`, never a reason to lose the sections. The hosted
// link is the document of record; the PDF is a convenience (attached when it is under
// EMAIL_ATTACH_MAX_BYTES, linked otherwise — a report with ten phone photos is big).

import { soqlEscapeString } from "../../lib/salesforce.js";
import { EVENTS } from "../../lib/service-activity.js";
import { buildKey, publicUrlForKey, registerFileMetadata } from "../../lib/file-access.js";
import { buildJobReportModel, normalizeReportSections, renderJobReportDocument, reportPhotoChoices } from "../../lib/job-report-document.js";
import { INVOICE_JOB_SELECT } from "./invoice.js";
import { JOB_SF_OBJECT } from "./fields.js";

export const REPORT_JOB_SELECT =
  INVOICE_JOB_SELECT +
  ", Service_Type__c, Report_Sections__c, Report_Public_Token__c, Report_Token_Expires_At__c, Report_Updated_At__c, Report_Sent_At__c, Report_Sent_Count__c, Report_PDF_S3_Key__c";
export const REPORT_TOKEN_DAYS = 365; // a report is kept, not acted on; the link lives a year and is renewed on every send
export const EMAIL_ATTACH_MAX_BYTES = 8 * 1024 * 1024; // SES tops out at 10 MB per message; over this the email links the PDF instead
const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;
const MAX_TEXT_CHARS = 320;

const strOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/** The hosted report page: the portal's public /report/{token} route. */
export function publicReportUrl(token, baseUrl) {
  const base = (baseUrl || "").replace(/\/+$/, "");
  return base && token ? `${base}/report/${encodeURIComponent(token)}` : null;
}

/** SUNDIAL/{jobId}/job-report-{n}.pdf — one file per send, all kept in the job's Files. */
export const reportPdfKey = (jobId, n) => buildKey(jobId, `job-report-${n}.pdf`);

export function buildReportEmail({ job, brandName, url, paid, pdfAttached, pdfUrl, message }) {
  const who = brandName ? ` from ${brandName}` : "";
  const name = job?.Customer_Name_at_Creation__c;
  const subject = `${paid ? "Receipt and job report" : "Job report"} for ${job?.Name || "your service"}${who}`;
  const lines = [
    `Hello${name ? ` ${name}` : ""},`,
    "",
    message ? String(message).trim() : `Here is the report from our visit${job?.Address_at_Creation__c ? ` at ${job.Address_at_Creation__c}` : ""}${paid ? ", with your receipt" : ""}.`,
    url ? `View it online: ${url}` : "",
    pdfAttached ? "A PDF copy is attached." : pdfUrl ? `PDF copy: ${pdfUrl}` : "",
    "",
    "Questions? Just reply to this email.",
  ].filter((l) => l !== "");
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;max-width:560px">${lines
    .map((l) => {
      const m = l.match(/^(View it online|PDF copy): (https?:\/\/\S+)$/);
      return m ? `<p><a href="${esc(m[2])}" style="display:inline-block;background:#1F3864;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${esc(m[1] === "View it online" ? "View the report" : "Download the PDF")}</a></p>` : `<p>${esc(l)}</p>`;
    })
    .join("")}</div>`;
  return { subject, text: lines.join("\n"), html };
}

export function buildReportText({ job, brandName, url, paid }) {
  const who = brandName ? ` from ${brandName}` : "";
  return `${paid ? "Your receipt and job report" : "Your job report"}${who} for ${job?.Name || "your service"}: ${url}`.slice(0, MAX_TEXT_CHARS);
}

/**
 * @param d  the estimate handler's deps (sfQuery, sfUpdateRecord, listFiles, getObject, putObject,
 *           sendEmail, isEmailConfigured, publicBaseUrl, now, randomToken, getSupabaseClient, sms?)
 * @param h  { loadEstimate, loadLines, act, markStale, brandFor, jsonResponse, bad, notFound, sfError,
 *             CACHE, customerEmailFor, money, loadJobCalls }
 */
export function createReportHandlers(d, h) {
  const { jsonResponse, bad, notFound, sfError, CACHE, money } = h;

  async function loadJob(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(`SELECT ${REPORT_JOB_SELECT} FROM ${JOB_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
    return rows?.[0] ?? null;
  }

  /** Everything the document needs, loaded once: photos, the live invoice + its lines + payments. */
  async function gather(job, tenantId) {
    const [files, calls, invoices, payments] = await Promise.all([
      d.listFiles(job.Id).catch((e) => (console.error("report: photo list failed:", e?.message || e), [])),
      h.loadJobCalls ? h.loadJobCalls(job.Id, tenantId).catch(() => []) : [],
      money.loadJobInvoices(job.Id, tenantId),
      money.loadJobPayments(job.Id, tenantId),
    ]);
    const photos = reportPhotoChoices(files, job.Id, calls);
    const invoice = money.currentOf(invoices);
    const live = invoice && invoice.Status__c !== "Void" ? invoice : null;
    const estimate = job.Estimate__c ? await h.loadEstimate(job.Estimate__c, tenantId) : null;
    const lines = live && estimate ? (await h.loadLines(estimate.Id, tenantId)).filter((l) => l.Stage__c !== "Removed") : [];
    return { photos, invoice: live, lines, payments: (payments || []).filter((p) => !live || !p.Invoice__c || p.Invoice__c === live.Id), estimate };
  }

  function reportState(job, report) {
    const updated = job.Report_Updated_At__c ?? null;
    const sent = job.Report_Sent_At__c ?? null;
    return {
      sections: report.sections,
      receipt: report.receipt,
      intro: report.intro,
      sectionCount: report.sections.length,
      updatedAt: updated,
      sentAt: sent,
      sentCount: Number(job.Report_Sent_Count__c) || 0,
      editedSinceSent: !!(sent && updated && updated > sent),
      publicUrl: job.Report_Public_Token__c ? publicReportUrl(job.Report_Public_Token__c, d.publicBaseUrl) : null,
      pdfUrl: job.Report_PDF_S3_Key__c ? publicUrlForKey(job.Report_PDF_S3_Key__c) : null,
      partnerBilled: !!(job.Bill_To_Type__c && job.Bill_To_Type__c !== "Customer"),
    };
  }

  async function modelFor(job, report, ctx, tenantId, options) {
    const g = await gather(job, tenantId);
    const model = buildJobReportModel({ job, report, photos: g.photos, invoice: g.invoice, lines: g.lines, payments: g.payments, estimate: g.estimate, brand: h.brandFor(ctx), options });
    return { model, ...g };
  }

  return {
    async getReport({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const norm = normalizeReportSections(job.Report_Sections__c);
      const report = norm.ok ? norm.value : { version: 1, sections: [], receipt: true, intro: "" };
      const g = await gather(job, tenantId);
      return jsonResponse(200, cors, {
        jobId: job.Id,
        jobNumber: job.Name ?? null,
        ...reportState(job, report),
        summary: job.Customer_Summary__c ?? null,
        photos: g.photos,
        invoice: g.invoice ? { number: g.invoice.Name ?? null, status: g.invoice.Status__c ?? null, total: Number(g.invoice.Total__c) || 0, paid: Number(g.invoice.Paid_Amount__c) || 0 } : null,
        ...(norm.ok ? {} : { warning: norm.error }),
      });
    },

    async saveReport({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const norm = normalizeReportSections(body);
      if (!norm.ok) return bad(cors, "REPORT_INVALID", norm.error);
      // Every photo must be one of the job's own (the key check in normalize is shape-only).
      const files = await d.listFiles(job.Id).catch(() => []);
      const known = new Set(reportPhotoChoices(files, job.Id).map((p) => p.key));
      const strangers = norm.value.sections.filter((s) => s.photoKey && !known.has(s.photoKey));
      if (strangers.length) return bad(cors, "PHOTO_NOT_ON_JOB", `${strangers.length} photo(s) are not on this job.`, { keys: strangers.map((s) => s.photoKey) });
      const now = d.now().toISOString();
      const fields = { Report_Sections__c: JSON.stringify(norm.value), Report_Updated_At__c: now };
      try {
        await d.sfUpdateRecord(JOB_SF_OBJECT, job.Id, fields);
      } catch (e) {
        return sfError(cors, e, "report save");
      }
      Object.assign(job, fields);
      await h.markStale(CACHE.job, [job.Id], tenantId);
      await h.act(ctx, { event: EVENTS.JOB_UPDATED, recordType: "job", recordSfId: job.Id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null, details: { report: "saved", sections: norm.value.sections.length, receipt: norm.value.receipt } });
      return jsonResponse(200, cors, { success: true, jobId: job.Id, ...reportState(job, norm.value) });
    },

    async previewReport({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const norm = normalizeReportSections(job.Report_Sections__c);
      const report = norm.ok ? norm.value : { sections: [], receipt: true, intro: "" };
      const { model } = await modelFor(job, report, ctx, tenantId, { mode: "preview", pdfUrl: job.Report_PDF_S3_Key__c ? publicUrlForKey(job.Report_PDF_S3_Key__c) : null });
      const { html, title } = renderJobReportDocument({ model });
      return jsonResponse(200, cors, { html, title, sections: model.sections.length, receipt: !!model.receipt });
    },

    async sendReport({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const norm = normalizeReportSections(job.Report_Sections__c);
      if (!norm.ok) return bad(cors, "REPORT_INVALID", norm.error);
      const report = norm.value;
      if (!report.sections.length && !strOrNull(job.Customer_Summary__c)) return bad(cors, "REPORT_EMPTY", "Add at least one section (or a Summary of work) before sending.");
      const via = ["Email", "SMS", "Both"].includes(body?.via) ? body.via : "Email";
      const now = d.now();
      const token = job.Report_Public_Token__c || d.randomToken();
      const url = publicReportUrl(token, d.publicBaseUrl);
      const sentCount = (Number(job.Report_Sent_Count__c) || 0) + 1;
      const pdfKey = reportPdfKey(job.Id, sentCount);
      const pdfUrl = publicUrlForKey(pdfKey);
      const brand = h.brandFor(ctx);

      // The document as of now (the sections, the Summary, the money) → the PDF of this send.
      const docJob = { ...job, Report_Sent_At__c: now.toISOString() };
      const { model, invoice } = await modelFor(docJob, report, ctx, tenantId, { mode: "customer", pdfUrl });
      const paid = !!model.receipt && invoice?.Status__c === "Paid"; // "receipt" only when the document carries one (never for a partner payer)
      let pdfBytes = null;
      let pdfError = null;
      try {
        const images = new Map();
        await Promise.all(
          model.sections
            .filter((s) => s.photoKey)
            .map(async (s) => {
              try {
                const obj = await d.getObject({ key: s.photoKey });
                if (obj?.bytes) images.set(s.photoKey, obj);
              } catch (e) {
                console.error("report: photo fetch failed:", s.photoKey, e?.message || e);
              }
            })
        );
        pdfBytes = await d.renderReportPdf(model, images);
        await d.putObject({ key: pdfKey, body: pdfBytes, contentType: "application/pdf" });
        try {
          const supabase = d.getSupabaseClient();
          await registerFileMetadata(supabase, { sfRecordId: job.Id, objectKey: "job", s3Key: pdfKey, fileName: `job-report-${sentCount}.pdf`, mimeType: "application/pdf", size: pdfBytes.byteLength, uploadedBy: ctx.userId ?? null, uploadedByName: ctx.actor?.name ?? null, category: "Job Report", subfolder: null });
        } catch (e) {
          console.error(`report: file metadata register failed for ${pdfKey}: ${e?.message || e}`);
        }
      } catch (e) {
        pdfError = e?.message || String(e);
        pdfBytes = null;
        console.error(`report: PDF failed for ${job.Id}: ${pdfError}`);
      }

      // Delivery: email (link + PDF attached when it fits), text (link).
      let delivery = "recorded";
      const detail = [];
      let recipient = null;
      let textedTo = null;
      if (!url) detail.push("SERVICE_PUBLIC_BASE_URL is not set on this Lambda, so no link could be built.");
      if (via === "Email" || via === "Both") {
        if (!url) {
          /* said above */
        } else if (!d.isEmailConfigured()) detail.push("EMAIL_FROM is not set on this Lambda (SES not wired).");
        else {
          const email = strOrNull(body?.to) || (await h.customerEmailFor(job, tenantId));
          if (!email) detail.push("The customer has no email address on file.");
          else {
            const attach = !!pdfBytes && pdfBytes.byteLength <= EMAIL_ATTACH_MAX_BYTES;
            const msg = buildReportEmail({ job, brandName: brand.companyName, url, paid, pdfAttached: attach, pdfUrl: pdfBytes ? pdfUrl : null, message: strOrNull(body?.message) });
            const attachments = attach ? [{ fileName: `${job.Name || "job"}-report.pdf`, contentType: "application/pdf", content: pdfBytes }] : [];
            const sent = await d.sendEmail({ to: email, subject: msg.subject, html: msg.html, text: msg.text, attachments });
            if (sent.ok) {
              delivery = "email";
              recipient = email;
            } else detail.push(`Email failed: ${sent.error}`);
          }
        }
      }
      if ((via === "SMS" || via === "Both") && url) {
        if (!d.sms) detail.push("Texting is not wired on this Lambda.");
        else {
          const r = await d.sms.sendText({ tenantId, tenantSlug: ctx.tenantSlug, job, to: strOrNull(body?.toPhone), body: buildReportText({ job, brandName: brand.companyName, url, paid }), sentBy: { id: ctx.userId ?? null, name: ctx.actor?.name ?? null } });
          if (r.ok) {
            textedTo = r.to ?? null;
            if (delivery !== "email") delivery = "sms";
            else delivery = "both";
          } else detail.push(r.code === "NO_PHONE" ? "The customer has no mobile number on file." : `Text failed: ${r.error || r.code}`);
        }
      }
      if (pdfError) detail.push("The PDF could not be generated (the link still works).");

      const fields = {
        Report_Public_Token__c: token,
        Report_Token_Expires_At__c: new Date(now.getTime() + REPORT_TOKEN_DAYS * 86400000).toISOString(),
        Report_Sent_At__c: now.toISOString(),
        Report_Sent_Count__c: sentCount,
        ...(pdfBytes ? { Report_PDF_S3_Key__c: pdfKey } : {}),
      };
      try {
        await d.sfUpdateRecord(JOB_SF_OBJECT, job.Id, fields);
      } catch (e) {
        return sfError(cors, e, "report send");
      }
      Object.assign(job, fields);
      await h.markStale(CACHE.job, [job.Id], tenantId);
      await h.act(ctx, { event: EVENTS.JOB_REPORT_SENT, recordType: "job", recordSfId: job.Id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null, details: { via, delivery, recipient, textedTo, deliveryDetail: detail.join(" ") || null, sections: report.sections.length, receipt: !!model.receipt, sentCount, pdfKey: pdfBytes ? pdfKey : null } });
      return jsonResponse(200, cors, { success: true, jobId: job.Id, delivery, recipient, textedTo, deliveryDetail: detail.join(" ") || null, ...reportState(job, report) });
    },
  };
}
