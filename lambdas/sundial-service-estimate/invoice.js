// invoice.js — issuing the job's invoice and recording money against it (D-072.6 / .1).
//
//   POST /service/jobs/{id}/invoice            issue: the estimate's lines frozen, one per job
//   GET  /service/jobs/{id}/invoice            the job's current invoice + payments (or canIssue)
//   GET  /service/invoices/{id}                one invoice + payments + job/estimate summary
//   GET  /service/invoices/{id}/preview        the document (HTML) — same model as the PDF
//   POST /service/invoices/{id}/payments       record a check / ACH / partner remittance / refund
//   POST /service/invoices/{id}/send           email the PDF to the payer
//   POST /service/invoices/{id}/void           void (reason required); a reissue is "-2"
//
// Rules the code holds, never bypass them:
//   - ONE live invoice per job. Issue refuses (409 INVOICE_EXISTS) while one is not Void.
//   - The invoice is FROZEN: money is copied from the estimate at issue and never
//     recomputed; the estimate goes Invoiced and locks (patchEstimate refuses it).
//   - Paid_Amount__c is written HERE from Succeeded payment rows (Payment + Deposit +
//     Adjustment − Refund) — the design's roll-up Flow is not built; this is the truth.
//   - Job Payment_Status__c and the Invoiced → Paid job status follow the money in one
//     function (settleMoney), the way settleJobStatus owns the schedule states.
//   - Deposits taken before the invoice existed (Invoice__c blank) are back-filled onto
//     the invoice at issue and count toward it.
//   - Stripe rows are written by stripe.js (the webhook + the off-session charge) through
//     the SAME settleMoney — createMoneyCore() below is what both modules share. Manual
//     rows here are Succeeded the moment the office records them — a check in hand is
//     money received.
//
// This module is deployed INSIDE sundial-service-estimate (one Lambda, one wire script)
// and receives that handler's helpers, so tenant scoping, activity, staleness, brand
// and the PDF pipe are the same code paths the estimate uses.

import { soqlEscapeString } from "../../lib/salesforce.js";
import { buildInvoiceModel, renderEstimateDocument } from "../../lib/estimate-document.js";
import { buildKey, publicUrlForKey, registerFileMetadata, findFileMetadataByKey } from "../../lib/file-access.js";
import { EVENTS } from "../../lib/service-activity.js";
import { computeTotals, lineFromRecord, estimateFromRecord } from "./totals.js";
import { LINE_SF_OBJECT } from "./pricebook.js";
import { ESTIMATE_SF_OBJECT, JOB_SF_OBJECT } from "./fields.js";

export const INVOICE_SF_OBJECT = "Sundial_Service_Invoice__c";
export const PAYMENT_SF_OBJECT = "Sundial_Service_Payment__c";

export const INVOICE_SELECT =
  "Id, Name, Service_Job__c, Client__c, Status__c, Bill_To_Type__c, Bill_To_Name__c, Billing_Reference__c, " +
  "Subtotal__c, Discount_Amount__c, Tax_Rate__c, Tax_Amount__c, Total__c, Paid_Amount__c, Issued_At__c, Sent_At__c, " +
  "Due_Date__c, Paid_At__c, PDF_S3_Key__c, Acumatica_Ref__c, Acumatica_Entered_At__c, Voided_At__c, Void_Reason__c, CreatedDate";
export const PAYMENT_SELECT =
  "Id, Name, Service_Job__c, Invoice__c, Client__c, Type__c, Method__c, Amount__c, Status__c, Received_At__c, " +
  "Reference__c, Recorded_By__c, Notes__c, Stripe_Payment_Intent_Id__c, Stripe_Charge_Id__c, Stripe_Refund_Id__c, Failure_Reason__c, CreatedDate";
export const INVOICE_JOB_SELECT =
  "Id, Name, Sundial_Customer__c, Estimate__c, Client__c, Status__c, Payment_Status__c, Bill_To_Type__c, Bill_To_Name__c, " +
  "Billing_Reference__c, Customer_Name_at_Creation__c, Address_at_Creation__c, Primary_Phone_at_Creation__c, " +
  "Primary_Email_at_Creation__c, Customer_Summary__c, Customer_Card_on_File__c";

export const PAYMENT_TYPES = ["Deposit", "Payment", "Refund", "Adjustment"];
export const PAYMENT_METHODS = ["Card", "Check", "ACH", "Partner Remittance", "Other"];
const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;

// --- pure helpers (tested directly) ------------------------------------------------

/** The invoice's PDF lives in the JOB's folder under the invoice number (data model §5.5). */
export function invoicePdfKey(jobId, invoiceName) {
  return buildKey(jobId, `${String(invoiceName).replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`);
}

/** "SVC-00012" for the first invoice, "SVC-00012-2" after a void, and so on. */
export function nextInvoiceName(jobName, existingCount) {
  const n = Number(existingCount) || 0;
  return n === 0 ? String(jobName) : `${jobName}-${n + 1}`;
}

/** Money received, from Succeeded rows: Payment + Deposit + Adjustment − Refund. */
export function paidSummary(payments) {
  let paid = 0;
  let deposits = 0;
  let refunds = 0;
  for (const p of payments || []) {
    if (p.Status__c !== "Succeeded") continue;
    const amt = cents(p.Amount__c);
    if (p.Type__c === "Refund") {
      refunds += amt;
      paid -= amt;
    } else {
      paid += amt;
      if (p.Type__c === "Deposit") deposits += amt;
    }
  }
  return { paid: cents(paid), deposits: cents(deposits), refunds: cents(refunds) };
}

/** Invoice Status__c from the money. Void and Draft are never touched by money. */
export function invoiceStatusFor(current, total, paid) {
  if (current === "Void" || current === "Draft") return current;
  if (paid >= cents(total) - 0.004 && cents(total) > 0) return "Paid";
  if (cents(total) === 0) return paid > 0 ? "Paid" : current;
  if (paid > 0) return "Partially Paid";
  return current === "Paid" || current === "Partially Paid" ? "Issued" : current;
}

/** Job Payment_Status__c from the money against the invoice total. */
export function jobPaymentStatusFor(summary, total, hasInvoice) {
  const { paid, deposits, refunds } = summary;
  if (refunds > 0 && paid <= 0) return "Refunded";
  if (paid <= 0) return "None";
  if (hasInvoice && paid >= cents(total) - 0.004) return "Paid";
  if (!hasInvoice && deposits > 0 && paid === deposits) return "Deposit Paid";
  return "Partially Paid";
}

/** Validate + translate a manual payment body. */
export function paymentFieldsFromBody(body, { jobId, invoiceId, tenantId, userId, now }) {
  const problems = [];
  const type = body?.type || "Payment";
  const method = body?.method || "Check";
  const amount = Number(body?.amount);
  if (!PAYMENT_TYPES.includes(type)) problems.push(`type must be one of ${PAYMENT_TYPES.join(", ")}`);
  if (!PAYMENT_METHODS.includes(method)) problems.push(`method must be one of ${PAYMENT_METHODS.join(", ")}`);
  if (!Number.isFinite(amount) || amount <= 0) problems.push("amount must be a positive number (Refund rows are positive too — the type says the direction)");
  let receivedAt = now.toISOString();
  if (body?.receivedAt) {
    const t = Date.parse(body.receivedAt);
    if (Number.isNaN(t)) problems.push("receivedAt must be a date");
    else receivedAt = new Date(t).toISOString();
  }
  if (problems.length) return { problems };
  const fields = {
    Service_Job__c: jobId,
    Invoice__c: invoiceId,
    Client__c: tenantId,
    Type__c: type,
    Method__c: method,
    Amount__c: cents(amount),
    Status__c: "Succeeded",
    Received_At__c: receivedAt,
    Reference__c: body?.reference ? String(body.reference).slice(0, 100) : null,
    Notes__c: body?.notes ? String(body.notes).slice(0, 255) : null,
    Recorded_By__c: userId || null,
  };
  for (const k of Object.keys(fields)) if (fields[k] === null) delete fields[k];
  return { fields };
}

/** Where the invoice's estimate goes back to when the invoice is voided. */
export function estimateStatusAfterVoid(est) {
  if ((Number(est?.Approved_Version__c) || 0) > 0) return "Approved";
  if ((Number(est?.Version__c) || 0) > 0) return "Sent";
  return "Draft";
}

export function buildInvoiceEmail({ invoice, job, brandName, balance, pdfAttached }) {
  const number = invoice.Name || "Invoice";
  const who = brandName ? ` from ${brandName}` : "";
  const money = (n) => Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const paidInFull = balance <= 0;
  const subject = paidInFull ? `Receipt for ${number}${who}` : `Invoice ${number}${who} — ${money(balance)} due`;
  const name = job?.Customer_Name_at_Creation__c;
  const lines = [
    `Hello${name ? ` ${name}` : ""},`,
    "",
    paidInFull
      ? `Thank you — invoice ${number}${who} is paid in full (${money(invoice.Total__c)}).`
      : `Your invoice ${number}${who} is ready. Total ${money(invoice.Total__c)}${Number(invoice.Paid_Amount__c) > 0 ? `, ${money(invoice.Paid_Amount__c)} received` : ""} — balance due ${money(balance)}${invoice.Due_Date__c ? ` by ${invoice.Due_Date__c}` : ""}.`,
    pdfAttached ? "The invoice is attached as a PDF." : "",
    invoice.Billing_Reference__c ? `Your reference: ${invoice.Billing_Reference__c}` : "",
    "",
    "Questions? Just reply to this email.",
  ].filter((l) => l !== "");
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;max-width:560px">${lines
    .map((l, i) => (i === 0 ? `<p>${esc(l)}</p>` : `<p style="color:${i > 2 ? "#52525b" : "#18181b"}">${esc(l)}</p>`))
    .join("")}</div>`;
  return { subject, text: lines.join("\n"), html };
}

// --- handler factory ---------------------------------------------------------------
/**
 * @param {object} d        the estimate handler's deps (sfQuery, sfCreateRecord, ...)
 * @param {object} h        helpers from index.js: { loadEstimate, loadLines, act, markStale,
 *                          brandFor, jsonResponse, bad, notFound, sfError, CACHE,
 *                          customerEmailFor }
 */
/**
 * The money core, shared by the invoice routes and stripe.js: the tenant-scoped loaders
 * and settleMoney — the ONE function that turns payment rows into invoice / job status.
 */
export function createMoneyCore(d, h) {
  const { CACHE } = h;

  async function loadJob(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(
      `SELECT ${INVOICE_JOB_SELECT} FROM ${JOB_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
    );
    return rows?.[0] ?? null;
  }
  async function loadInvoice(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(
      `SELECT ${INVOICE_SELECT} FROM ${INVOICE_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
    );
    return rows?.[0] ?? null;
  }
  async function loadJobInvoices(jobId, tenantId) {
    return (
      (await d.sfQuery(
        `SELECT ${INVOICE_SELECT} FROM ${INVOICE_SF_OBJECT} WHERE Service_Job__c = '${soqlEscapeString(jobId)}' ` +
          `AND Client__c = '${soqlEscapeString(tenantId)}' ORDER BY CreatedDate`
      )) || []
    );
  }
  async function loadJobPayments(jobId, tenantId) {
    return (
      (await d.sfQuery(
        `SELECT ${PAYMENT_SELECT} FROM ${PAYMENT_SF_OBJECT} WHERE Service_Job__c = '${soqlEscapeString(jobId)}' ` +
          `AND Client__c = '${soqlEscapeString(tenantId)}' ORDER BY Received_At__c NULLS LAST, CreatedDate`
      )) || []
    );
  }
  /** The live invoice (not Void), else the latest one, else null. */
  const currentOf = (invoices) => invoices.find((i) => i.Status__c !== "Void") ?? invoices[invoices.length - 1] ?? null;
  const balanceOf = (inv) => cents((Number(inv.Total__c) || 0) - (Number(inv.Paid_Amount__c) || 0));

  /**
   * THE money function: re-sum the payments on the invoice, write Paid_Amount / Status /
   * Paid_At on the invoice, and Payment_Status (+ Invoiced → Paid, Paid → Invoiced) on
   * the job. Called after every payment row and at issue.
   */
  async function settleMoney({ invoice, job, tenantId, ctx }) {
    const payments = (await loadJobPayments(job.Id, tenantId)).filter((p) => p.Invoice__c === invoice.Id);
    const summary = paidSummary(payments);
    const total = cents(invoice.Total__c);
    const status = invoiceStatusFor(invoice.Status__c, total, summary.paid);
    const invFields = { Paid_Amount__c: summary.paid };
    if (status !== invoice.Status__c) invFields.Status__c = status;
    if (status === "Paid" && !invoice.Paid_At__c) invFields.Paid_At__c = d.now().toISOString();
    if (status !== "Paid" && invoice.Paid_At__c) invFields.Paid_At__c = null;
    await d.sfUpdateRecord(INVOICE_SF_OBJECT, invoice.Id, invFields);
    Object.assign(invoice, invFields);

    const jobFields = {};
    const payStatus = jobPaymentStatusFor(summary, total, true);
    if (payStatus !== job.Payment_Status__c) jobFields.Payment_Status__c = payStatus;
    if (status === "Paid" && job.Status__c === "Invoiced") jobFields.Status__c = "Paid";
    if (status !== "Paid" && job.Status__c === "Paid") jobFields.Status__c = "Invoiced";
    if (jobFields.Status__c) jobFields.Status_Changed_At__c = d.now().toISOString();
    if (Object.keys(jobFields).length) {
      await d.sfUpdateRecord(JOB_SF_OBJECT, job.Id, jobFields);
      if (jobFields.Status__c) {
        await h.act(ctx, { event: EVENTS.JOB_UPDATED, recordType: "job", recordSfId: job.Id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null, details: { fields: { Status__c: { from: job.Status__c, to: jobFields.Status__c } }, via: "invoice" } });
      }
      Object.assign(job, jobFields);
    }
    await h.markStale(CACHE.job, [job.Id], tenantId);
    await h.markStale(CACHE.invoice, [invoice.Id], tenantId);
    return { payments, summary, balance: balanceOf(invoice) };
  }

  /**
   * Money on a job that has NO invoice yet (a deposit): the job's Payment_Status follows
   * the rows alone. The invoice, when issued, adopts the rows and settleMoney takes over.
   */
  async function settleJobWithoutInvoice({ job, tenantId }) {
    const payments = (await loadJobPayments(job.Id, tenantId)).filter((p) => !p.Invoice__c);
    const summary = paidSummary(payments);
    const payStatus = jobPaymentStatusFor(summary, 0, false);
    if (payStatus !== job.Payment_Status__c) {
      await d.sfUpdateRecord(JOB_SF_OBJECT, job.Id, { Payment_Status__c: payStatus });
      job.Payment_Status__c = payStatus;
      await h.markStale(CACHE.job, [job.Id], tenantId);
    }
    return { payments, summary };
  }

  return { loadJob, loadInvoice, loadJobInvoices, loadJobPayments, currentOf, balanceOf, settleMoney, settleJobWithoutInvoice };
}

export function createInvoiceHandlers(d, h) {
  const { jsonResponse, bad, notFound, sfError, CACHE } = h;
  const money = h.money || createMoneyCore(d, h);
  const { loadJob, loadInvoice, loadJobInvoices, loadJobPayments, currentOf, balanceOf, settleMoney } = money;

  /** Render + store the PDF for an invoice (best-effort; returns { key, bytes } or nulls). */
  async function renderAndStorePdf({ invoice, job, est, lines, payments, ctx, tenantId }) {
    try {
      const model = buildInvoiceModel({ invoice, job, estimate: est, lines, payments, brand: h.brandFor(ctx), options: { mode: "pdf" } });
      const bytes = await d.renderPdf(model);
      const key = invoicePdfKey(job.Id, invoice.Name);
      await d.putObject({ key, body: bytes, contentType: "application/pdf" });
      if (invoice.PDF_S3_Key__c !== key) {
        await d.sfUpdateRecord(INVOICE_SF_OBJECT, invoice.Id, { PDF_S3_Key__c: key });
        invoice.PDF_S3_Key__c = key;
      }
      try {
        const supabase = await d.getSupabaseClient();
        if (!(await findFileMetadataByKey(supabase, key))) {
          await registerFileMetadata(supabase, {
            s3Key: key,
            fileName: `${invoice.Name}.pdf`,
            tenantId,
            sfRecordId: job.Id,
            sfObjectType: JOB_SF_OBJECT,
            uploadedByUserId: ctx.userId ?? null,
            uploadedByUserName: "Sundial (invoice)",
            fileSizeBytes: bytes?.byteLength ?? null,
            mimeType: "application/pdf",
            category: "Invoice",
            subfolder: null,
          });
        }
      } catch (e) {
        console.error(`invoice: file metadata register failed for ${key}: ${e?.message || e}`);
      }
      return { key, bytes, error: null };
    } catch (e) {
      console.error(`invoice: PDF failed for ${invoice.Id}: ${e?.message || e}`);
      return { key: invoice.PDF_S3_Key__c || null, bytes: null, error: e?.message || String(e) };
    }
  }

  function present(invoice, payments) {
    return {
      invoice,
      payments,
      balance: balanceOf(invoice),
      pdfUrl: invoice.PDF_S3_Key__c ? publicUrlForKey(invoice.PDF_S3_Key__c) : null,
    };
  }

  /** Why the job cannot be invoiced right now, or null. */
  function issueBlocker(job, invoices) {
    const live = invoices.find((i) => i.Status__c !== "Void");
    if (live) return { code: "INVOICE_EXISTS", message: `${live.Name} is already issued. Void it to reissue.`, invoiceId: live.Id };
    if (!job.Estimate__c) return { code: "NO_ESTIMATE", message: "This job has no estimate to invoice from." };
    return null;
  }

  return {
    async getJobInvoice({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const invoices = await loadJobInvoices(job.Id, tenantId);
      const inv = currentOf(invoices);
      const payments = await loadJobPayments(job.Id, tenantId);
      const blocker = issueBlocker(job, invoices);
      return jsonResponse(200, cors, {
        jobId: job.Id,
        jobStatus: job.Status__c,
        paymentStatus: job.Payment_Status__c,
        canIssue: !blocker,
        issueBlocker: blocker,
        cardOnFile: job.Customer_Card_on_File__c === true, // Stripe (amendment 8): the office may charge it
        billToType: job.Bill_To_Type__c || "Customer",
        history: invoices.map((i) => ({ id: i.Id, name: i.Name, status: i.Status__c, total: i.Total__c, issuedAt: i.Issued_At__c, voidedAt: i.Voided_At__c })),
        ...(inv ? present(inv, payments.filter((p) => p.Invoice__c === inv.Id)) : { invoice: null, payments: payments.filter((p) => !p.Invoice__c), balance: null, pdfUrl: null }),
      });
    },

    async issueInvoice({ ctx, params, body }) {
      const { tenantId, userId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const invoices = await loadJobInvoices(job.Id, tenantId);
      const blocker = issueBlocker(job, invoices);
      if (blocker) return jsonResponse(blocker.code === "INVOICE_EXISTS" ? 409 : 400, cors, { error: "cannot_issue", ...blocker });
      const est = await h.loadEstimate(job.Estimate__c, tenantId);
      if (!est) return bad(cors, "NO_ESTIMATE", "The job's estimate could not be loaded.");
      const lines = (await h.loadLines(est.Id, tenantId)).filter((l) => l.Stage__c !== "Removed");
      if (!lines.length) return bad(cors, "NO_LINES", "The estimate has no lines to invoice.");
      const totals = computeTotals(lines.map(lineFromRecord), estimateFromRecord(est));
      const proposed = lines.filter((l) => l.Stage__c === "Proposed").length;
      const now = d.now();
      let dueDate = null;
      if (body?.dueDate) {
        const t = Date.parse(body.dueDate);
        if (Number.isNaN(t)) return bad(cors, "DUE_DATE_INVALID", "dueDate must be a date (YYYY-MM-DD).");
        dueDate = new Date(t).toISOString().slice(0, 10);
      } else if (Number(body?.netDays) > 0) {
        dueDate = new Date(now.getTime() + Number(body.netDays) * 86400000).toISOString().slice(0, 10);
      }
      const fields = {
        Name: nextInvoiceName(job.Name, invoices.length),
        Service_Job__c: job.Id,
        Client__c: tenantId,
        Status__c: "Issued",
        Bill_To_Type__c: job.Bill_To_Type__c || "Customer",
        Bill_To_Name__c: job.Bill_To_Name__c || null,
        Billing_Reference__c: job.Billing_Reference__c || null,
        Subtotal__c: totals.subtotal,
        Discount_Amount__c: totals.discountAmount,
        Tax_Rate__c: Number(est.Tax_Rate__c) || 0,
        Tax_Amount__c: totals.taxAmount,
        Total__c: totals.total,
        Paid_Amount__c: 0,
        Issued_At__c: now.toISOString(),
        Due_Date__c: dueDate,
      };
      for (const k of Object.keys(fields)) if (fields[k] === null) delete fields[k];
      let created;
      try {
        created = await d.sfCreateRecord(INVOICE_SF_OBJECT, fields);
      } catch (e) {
        return sfError(cors, e, "invoice create");
      }
      const invoice = { Id: created.id, ...fields };

      // Money already on the job with no invoice (a deposit) now belongs to this one.
      const orphans = (await loadJobPayments(job.Id, tenantId)).filter((p) => !p.Invoice__c && p.Status__c === "Succeeded");
      for (const p of orphans) await d.sfUpdateRecord(PAYMENT_SF_OBJECT, p.Id, { Invoice__c: invoice.Id });

      // The estimate is now the invoice's frozen source: lock it; the job moves on.
      await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, { Status__c: "Invoiced" });
      await d.sfUpdateRecord(JOB_SF_OBJECT, job.Id, { Status__c: "Invoiced", Status_Changed_At__c: now.toISOString() });
      await h.act(ctx, { event: EVENTS.JOB_UPDATED, recordType: "job", recordSfId: job.Id, jobSfId: job.Id, estimateSfId: est.Id, details: { fields: { Status__c: { from: job.Status__c, to: "Invoiced" } }, via: "invoice" } });
      job.Status__c = "Invoiced";
      await h.markStale(CACHE.estimate, [est.Id], tenantId);

      let money = await settleMoney({ invoice, job, tenantId, ctx });
      const pdf = await renderAndStorePdf({ invoice, job, est, lines, payments: money.payments, ctx, tenantId });
      await h.markStale(CACHE.invoice, [invoice.Id], tenantId);
      await h.act(ctx, {
        event: EVENTS.INVOICE_ISSUED, recordType: "serviceinvoice", recordSfId: invoice.Id, jobSfId: job.Id, estimateSfId: est.Id,
        details: { number: invoice.Name, total: totals.total, lineCount: lines.length, proposedLines: proposed, billTo: invoice.Bill_To_Type__c, dueDate, depositsApplied: orphans.length, paid: money.summary.paid, pdfKey: pdf.key },
      });
      // Customer-pay job with a card on file: charge the balance now, off-session (D-065.6).
      // The charge's own outcome rides along; a decline never un-issues the invoice.
      let charge = null;
      if (body?.chargeCard === true && h.chargeInvoice) {
        charge = await h.chargeInvoice({ ctx, invoice, job });
        if (charge?.settled) money = charge.settled;
      }
      return jsonResponse(201, cors, {
        success: true,
        id: invoice.Id,
        ...present(invoice, money.payments),
        jobStatus: job.Status__c,
        paymentStatus: job.Payment_Status__c,
        charge,
        warnings: [
          proposed ? `${proposed} line${proposed === 1 ? "" : "s"} the customer never approved ${proposed === 1 ? "is" : "are"} on this invoice.` : null,
          pdf.error ? "The PDF could not be generated (the invoice is issued; try Send again later)." : null,
          charge && !charge.ok ? `The card on file was not charged: ${charge.message}` : null,
        ].filter(Boolean),
      });
    },

    async getInvoice({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const inv = await loadInvoice(params[0], tenantId);
      if (!inv) return notFound(cors);
      const job = await loadJob(inv.Service_Job__c, tenantId);
      const payments = (await loadJobPayments(inv.Service_Job__c, tenantId)).filter((p) => p.Invoice__c === inv.Id);
      return jsonResponse(200, cors, { ...present(inv, payments), job: job ? { id: job.Id, name: job.Name, status: job.Status__c, paymentStatus: job.Payment_Status__c, customerId: job.Sundial_Customer__c, customerName: job.Customer_Name_at_Creation__c, estimateId: job.Estimate__c } : null });
    },

    async previewInvoice({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const inv = await loadInvoice(params[0], tenantId);
      if (!inv) return notFound(cors);
      const job = await loadJob(inv.Service_Job__c, tenantId);
      const est = job?.Estimate__c ? await h.loadEstimate(job.Estimate__c, tenantId) : null;
      const lines = est ? await h.loadLines(est.Id, tenantId) : [];
      const payments = (await loadJobPayments(inv.Service_Job__c, tenantId)).filter((p) => p.Invoice__c === inv.Id);
      const model = buildInvoiceModel({ invoice: inv, job, estimate: est, lines, payments, brand: h.brandFor(ctx), options: { mode: "preview" } });
      const { html, title } = renderEstimateDocument({ model });
      return jsonResponse(200, cors, { html, title, number: inv.Name, status: inv.Status__c, total: inv.Total__c, balance: balanceOf(inv) });
    },

    async recordPayment({ ctx, params, body }) {
      const { tenantId, userId, cors } = ctx;
      const inv = await loadInvoice(params[0], tenantId);
      if (!inv) return notFound(cors);
      if (inv.Status__c === "Void") return jsonResponse(409, cors, { error: "invoice_void", code: "INVOICE_VOID", message: "This invoice is void — record the payment on its reissue." });
      const job = await loadJob(inv.Service_Job__c, tenantId);
      if (!job) return notFound(cors);
      const { fields, problems } = paymentFieldsFromBody(body, { jobId: job.Id, invoiceId: inv.Id, tenantId, userId, now: d.now() });
      if (problems) return bad(cors, "PAYMENT_INVALID", problems.join("; "));
      let created;
      try {
        created = await d.sfCreateRecord(PAYMENT_SF_OBJECT, fields);
      } catch (e) {
        return sfError(cors, e, "payment create");
      }
      await h.markStale(CACHE.payment, [created.id], tenantId);
      const money = await settleMoney({ invoice: inv, job, tenantId, ctx });
      await h.act(ctx, {
        event: EVENTS.PAYMENT_RECORDED, recordType: "servicepayment", recordSfId: created.id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null,
        details: { invoice: inv.Name, type: fields.Type__c, method: fields.Method__c, amount: fields.Amount__c, reference: fields.Reference__c ?? null, paid: money.summary.paid, balance: money.balance, invoiceStatus: inv.Status__c },
      });
      return jsonResponse(201, cors, { success: true, id: created.id, ...present(inv, money.payments), jobStatus: job.Status__c, paymentStatus: job.Payment_Status__c });
    },

    async sendInvoice({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const inv = await loadInvoice(params[0], tenantId);
      if (!inv) return notFound(cors);
      if (inv.Status__c === "Void") return jsonResponse(409, cors, { error: "invoice_void", code: "INVOICE_VOID", message: "This invoice is void." });
      const job = await loadJob(inv.Service_Job__c, tenantId);
      if (!job) return notFound(cors);
      const est = job.Estimate__c ? await h.loadEstimate(job.Estimate__c, tenantId) : null;
      const lines = est ? (await h.loadLines(est.Id, tenantId)).filter((l) => l.Stage__c !== "Removed") : [];
      const payments = (await loadJobPayments(job.Id, tenantId)).filter((p) => p.Invoice__c === inv.Id);
      // Always a fresh PDF: the balance / PAID watermark reflect the money as of now.
      const pdf = await renderAndStorePdf({ invoice: inv, job, est, lines, payments, ctx, tenantId });

      let delivery = "recorded";
      let deliveryDetail = null;
      let recipient = null;
      if (!d.isEmailConfigured()) deliveryDetail = "EMAIL_FROM is not set on this Lambda (SES not wired).";
      else {
        let email = body?.to ? String(body.to).trim() : null;
        if (!email) {
          if (inv.Bill_To_Type__c && inv.Bill_To_Type__c !== "Customer") deliveryDetail = `This invoice bills ${inv.Bill_To_Name__c || inv.Bill_To_Type__c} — enter the partner's email address to send it.`;
          else email = await h.customerEmailFor(job, tenantId);
        }
        if (!email && !deliveryDetail) deliveryDetail = "The customer has no email address on file.";
        if (email) {
          const balance = balanceOf(inv);
          const msg = buildInvoiceEmail({ invoice: inv, job, brandName: h.brandFor(ctx).companyName, balance, pdfAttached: Boolean(pdf.bytes) });
          const attachments = pdf.bytes ? [{ fileName: `${inv.Name}.pdf`, contentType: "application/pdf", content: pdf.bytes }] : [];
          const sent = await d.sendEmail({ to: email, subject: msg.subject, html: msg.html, text: msg.text, attachments });
          if (sent.ok) {
            delivery = "email";
            recipient = email;
          } else deliveryDetail = `Email failed: ${sent.error}`;
        }
      }
      if (pdf.error) deliveryDetail = [deliveryDetail, "The PDF could not be generated."].filter(Boolean).join(" ");
      if (delivery === "email") {
        const upd = { Sent_At__c: d.now().toISOString() };
        if (inv.Status__c === "Issued") upd.Status__c = "Sent";
        await d.sfUpdateRecord(INVOICE_SF_OBJECT, inv.Id, upd);
        Object.assign(inv, upd);
        await h.markStale(CACHE.invoice, [inv.Id], tenantId);
      }
      await h.act(ctx, { event: EVENTS.INVOICE_SENT, recordType: "serviceinvoice", recordSfId: inv.Id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null, details: { number: inv.Name, delivery, recipient, deliveryDetail, balance: balanceOf(inv), pdfKey: pdf.key } });
      return jsonResponse(200, cors, { success: true, id: inv.Id, delivery, recipient, deliveryDetail, ...present(inv, payments) });
    },

    async voidInvoice({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const inv = await loadInvoice(params[0], tenantId);
      if (!inv) return notFound(cors);
      if (inv.Status__c === "Void") return jsonResponse(200, cors, { success: true, id: inv.Id, unchanged: true });
      const reason = body?.reason ? String(body.reason).trim().slice(0, 255) : "";
      if (!reason) return bad(cors, "REASON_REQUIRED", "A void reason is required.");
      const job = await loadJob(inv.Service_Job__c, tenantId);
      if (!job) return notFound(cors);
      const now = d.now().toISOString();
      try {
        await d.sfUpdateRecord(INVOICE_SF_OBJECT, inv.Id, { Status__c: "Void", Voided_At__c: now, Void_Reason__c: reason });
      } catch (e) {
        return sfError(cors, e, "invoice void");
      }
      // Money stays on the job; the rows unhook so the reissue picks them up.
      const payments = (await loadJobPayments(job.Id, tenantId)).filter((p) => p.Invoice__c === inv.Id);
      for (const p of payments) await d.sfUpdateRecord(PAYMENT_SF_OBJECT, p.Id, { Invoice__c: null });
      // The estimate reopens; the job goes back to billing.
      const est = job.Estimate__c ? await h.loadEstimate(job.Estimate__c, tenantId) : null;
      if (est && est.Status__c === "Invoiced") {
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, { Status__c: estimateStatusAfterVoid(est) });
        await h.markStale(CACHE.estimate, [est.Id], tenantId);
      }
      const summary = paidSummary(payments);
      const jobFields = { Payment_Status__c: jobPaymentStatusFor(summary, 0, false) };
      if (["Invoiced", "Paid"].includes(job.Status__c)) {
        jobFields.Status__c = "Ready to Bill";
        jobFields.Status_Changed_At__c = now;
      }
      await d.sfUpdateRecord(JOB_SF_OBJECT, job.Id, jobFields);
      if (jobFields.Status__c) {
        await h.act(ctx, { event: EVENTS.JOB_UPDATED, recordType: "job", recordSfId: job.Id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null, details: { fields: { Status__c: { from: job.Status__c, to: jobFields.Status__c } }, via: "invoice" } });
      }
      await h.markStale(CACHE.job, [job.Id], tenantId);
      await h.markStale(CACHE.invoice, [inv.Id], tenantId);
      await h.act(ctx, { event: EVENTS.INVOICE_VOIDED, recordType: "serviceinvoice", recordSfId: inv.Id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null, details: { number: inv.Name, reason, paymentsUnhooked: payments.length } });
      return jsonResponse(200, cors, { success: true, id: inv.Id, status: "Void", jobStatus: jobFields.Status__c ?? job.Status__c });
    },
  };
}
