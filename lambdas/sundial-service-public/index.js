// sundial-service-public — the CUSTOMER-facing estimate page's backend (D-072.7).
//
//   GET  /public/estimates/{token}            the rendered document + status + PDF link (marks Viewed)
//                                             + `payment` (card on file / deposit / balance — what to offer)
//   POST /public/estimates/{token}/accept     { name }   → Approved (method Online)
//   POST /public/estimates/{token}/decline    { reason } → Declined
//   POST /public/estimates/{token}/checkout   { kind: setup|deposit|balance } → { url } a Stripe Checkout
//                                             Session on the tenant's own Stripe account (amendment 8)
//
// NO PORTAL LOGIN. The only credential is the token in the URL — 24 random bytes
// (base64url) issued once per estimate by the estimate Lambda's Send, stored in
// Sundial_Estimate__c.Public_Token__c (External ID) with Public_Token_Expires_At__c.
// That is the whole authorization model, so the rules are strict and few:
//   - the token resolves to exactly one estimate or the request is 404 (never "expired"
//     vs "wrong" — both are 404 so the URL space cannot be probed for shape);
//   - an expired token is 410 GONE with a short message (the customer had a real link);
//   - nothing here takes a record id, a tenant id, or a field name from the caller;
//   - the tenant is READ FROM THE ESTIMATE (Client__c) and stamped onto the activity row;
//   - accept/decline are idempotent: a second accept of an approved estimate is a 200
//     that says so, never a second approval.
// The document is rendered by lib/estimate-document.js in "customer" mode — the same
// renderer the office previews with, so the two can never differ.
//
// Card capture is Stripe Checkout (2026-09-17, D-072 amendment 8): the page never sees a
// card number — it asks for a Checkout Session and sends the customer to Stripe. `setup`
// keeps a card on file (SetupIntent under the hood), `deposit` charges the deposit AND
// keeps the card, `balance` pays the live invoice. The money lands through the Stripe
// webhook in the estimate Lambda (payment_intent.succeeded → Payment row → settleMoney);
// this Lambda never writes a Payment row itself, so a page refresh and a webhook can
// never double-count. Keys: Secrets Manager `sundial/stripe`, per tenant (lib/stripe.js).
//
// Dependencies are injectable (createHandler) so test.js drives the real router.

import {
  sfQuery as realSfQuery,
  sfUpdateRecord as realSfUpdateRecord,
  soqlEscapeString,
} from "../../lib/salesforce.js";
import { getSupabaseClient as realGetSupabaseClient } from "../../lib/supabase.js";
import { corsHeaders, normalizeHeaders, jsonResponse, parseJsonBody, httpMethod } from "../../lib/http.js";
import { renderEstimateDocument, DEFAULT_BRAND } from "../../lib/estimate-document.js";
import { EVENTS, recordActivity } from "../../lib/service-activity.js";
import { computeTotals, lineFromRecord, estimateFromRecord } from "../sundial-service-estimate/totals.js";
import { LINE_SELECT, LINE_SF_OBJECT } from "../sundial-service-estimate/pricebook.js";
import { ESTIMATE_SELECT, ESTIMATE_SF_OBJECT } from "../sundial-service-estimate/fields.js";
import { createNotifier } from "../../lib/notify.js";
import { publicUrlForKey } from "../../lib/file-access.js";
import { getSecret as realGetSecret } from "../../lib/secrets.js";
import { createBrandLoader } from "../../lib/brand.js";
import { ensureStripeCustomer, stripeForTenant, toCents, StripeError } from "../../lib/stripe.js";
import { INVOICE_SELECT, INVOICE_SF_OBJECT, PAYMENT_SELECT, PAYMENT_SF_OBJECT } from "../sundial-service-estimate/invoice.js";
import { JOB_SF_OBJECT } from "../sundial-service-estimate/fields.js";
import { REPORT_JOB_SELECT } from "../sundial-service-estimate/report.js";
import { buildJobReportModel, normalizeReportSections, renderJobReportDocument, reportPhotoChoices } from "../../lib/job-report-document.js";
import { listRecordFiles, S3_REGION } from "../../lib/file-access.js";
import { S3Client } from "@aws-sdk/client-s3";

const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

const ROUTES = [
  ["GET", /^\/public\/estimates\/([^/]+)\/?$/, "view"],
  ["POST", /^\/public\/estimates\/([^/]+)\/accept\/?$/, "accept"],
  ["POST", /^\/public\/estimates\/([^/]+)\/decline\/?$/, "decline"],
  ["POST", /^\/public\/estimates\/([^/]+)\/checkout\/?$/, "checkout"],
  // The customer's job report + receipt (D-072 amendment 10): the token is the job's
  // Report_Public_Token__c, issued by the estimate Lambda's send. Read-only.
  ["GET", /^\/public\/reports\/([^/]+)\/?$/, "report"],
];
export const CHECKOUT_KINDS = Object.freeze(["setup", "deposit", "balance"]);
export const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";
export const TENANT_SF_OBJECT = "Sundial_Tenant__c";
const PUBLIC_JOB_SELECT = "Id, Name, Client__c, Status__c, Payment_Status__c, Bill_To_Type__c, Sundial_Customer__c, Customer_Card_on_File__c, Customer_Name_at_Creation__c, Primary_Email_at_Creation__c, Primary_Phone_at_Creation__c";
const PUBLIC_CUSTOMER_SELECT = "Id, Name, Client__c, Primary_Email__c, Primary_Phone__c, Stripe_Customer_Id__c";
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * What the page should offer, from the records alone (pure, tested):
 *   deposit  — approved, a deposit is required and not yet paid
 *   setup    — approved, no card on file yet (nothing charged; the card is for the work)
 *   balance  — the job's live invoice has a balance
 * `null` when there is nothing to pay or keep. A partner-billed job never asks the
 * customer for a card.
 */
export function paymentSummary({ est, job, invoice, configured }) {
  const approved = ["Approved", "Invoiced"].includes(est?.Status__c);
  const partner = job?.Bill_To_Type__c && job.Bill_To_Type__c !== "Customer";
  const live = invoice && invoice.Status__c !== "Void" && invoice.Status__c !== "Draft" ? invoice : null;
  const balance = live ? cents((Number(live.Total__c) || 0) - (Number(live.Paid_Amount__c) || 0)) : 0;
  const depositAmount = cents(est?.Deposit_Amount__c);
  const depositRequired = est?.Deposit_Required__c === true && depositAmount > 0;
  const depositPaidAt = est?.Deposit_Paid_At__c ?? null;
  const cardOnFile = job?.Customer_Card_on_File__c === true;
  let next = null;
  if (!partner) {
    if (live && balance > 0) next = "balance";
    else if (approved && depositRequired && !depositPaidAt && !live) next = "deposit";
    else if (approved && !cardOnFile && !live) next = "setup";
  }
  return {
    configured: configured === true,
    cardOnFile,
    depositRequired,
    depositAmount,
    depositPaidAt,
    invoice: live ? { number: live.Name ?? null, status: live.Status__c ?? null, total: cents(live.Total__c), paid: cents(live.Paid_Amount__c), balance } : null,
    next: configured === true ? next : null,
    // The office can still take the money by hand; the page says so instead of a dead button.
    unavailable: configured === true ? null : next ? "Online payment isn't set up yet — we'll take care of it over the phone." : null,
  };
}

export function matchRoute(method, path) {
  const p = (path || "").replace(/^\/[^/]+(?=\/public\/)/, "");
  for (const [m, re, name] of ROUTES) {
    if (m !== method) continue;
    const hit = p.match(re);
    if (hit) return { name, token: decodeURIComponent(hit[1]) };
  }
  return null;
}

function notFound(cors) {
  return jsonResponse(404, cors, { error: "not_found", code: "ESTIMATE_NOT_FOUND" });
}

/**
 * The PDF of the version the customer is looking at: the version log's entry for
 * Version__c carries the S3 key the send wrote (null when that send's PDF failed).
 * Public-read bucket, same URL the office's Files tab uses.
 */
export function currentPdfUrl(est) {
  try {
    const log = est.Version_Log__c ? JSON.parse(est.Version_Log__c) : [];
    const v = Number(est.Version__c) || 0;
    const entry = Array.isArray(log) ? log.find((e) => Number(e?.version) === v) : null;
    return entry?.pdfKey ? publicUrlForKey(entry.pdfKey) : null;
  } catch {
    return null;
  }
}

/** The parts of the estimate the customer page may see (never the internal fields). */
function publicSummary(est, totals) {
  return {
    pdfUrl: currentPdfUrl(est),
    number: est.Name ?? null,
    status: est.Status__c ?? null,
    version: Number(est.Version__c) || 0,
    total: totals.total,
    depositAmount: totals.depositAmount,
    depositRequired: est.Deposit_Required__c === true,
    validUntil: est.Valid_Until__c ?? null,
    approvedAt: est.Approved_At__c ?? null,
    approvedByName: est.Approved_By_Name__c ?? null,
    customerName: est.Customer_Name_at_Creation__c ?? null,
  };
}

let _s3 = null;
const s3Client = () => (_s3 ??= new S3Client({ region: S3_REGION }));

export function createHandler(deps = {}) {
  const d = {
    sfQuery: realSfQuery,
    sfUpdateRecord: realSfUpdateRecord,
    getSupabaseClient: realGetSupabaseClient,
    getSecret: realGetSecret,
    fetchUrl: undefined, // tests inject a fake Stripe; production uses fetch
    publicBaseUrl: process.env.SERVICE_PUBLIC_BASE_URL || "",
    listFiles: async (recordId) => listRecordFiles(s3Client(), recordId), // the job report's photos
    now: () => new Date(),
    ...deps,
  };
  // Notifications (D-074): the office's bell when a customer approves / declines online.
  const notifier = d.notifier ?? createNotifier({ getSupabaseClient: d.getSupabaseClient, getSecret: d.getSecret, now: d.now, env: process.env });
  const stripeFor = (slug) => stripeForTenant(slug, { getSecret: d.getSecret, ...(d.fetchUrl ? { fetchUrl: d.fetchUrl } : {}) });
  // The tenant's brand on the hosted pages (2026-09-24, lib/brand.js): logo by URL, the
  // identity lines, the terms + Service Club footer. No logo bytes here — the pages are HTML.
  const brands = d.brands ?? createBrandLoader({ getSecret: d.getSecret, env: { ...process.env, ...(deps.brandName ? { SERVICE_BRAND_NAME: deps.brandName } : {}) } });
  async function brandFor(tenantId) {
    try {
      const slug = await tenantSlug(tenantId);
      return await brands.brandFor({ tenantSlug: slug });
    } catch (e) {
      console.error("public brand:", e?.message || e);
      return { ...DEFAULT_BRAND, companyName: deps.brandName || "" };
    }
  }

  async function loadByToken(token) {
    if (!TOKEN_RE.test(token || "")) return null;
    const rows = await d.sfQuery(
      `SELECT ${ESTIMATE_SELECT} FROM ${ESTIMATE_SF_OBJECT} WHERE Public_Token__c = '${soqlEscapeString(token)}' LIMIT 2`
    );
    // Exactly one, or nothing: a token that somehow matched twice is a data problem,
    // and answering with either record would be guessing.
    return rows && rows.length === 1 ? rows[0] : null;
  }
  async function loadLines(est) {
    return (
      (await d.sfQuery(
        `SELECT ${LINE_SELECT} FROM ${LINE_SF_OBJECT} WHERE Estimate__c = '${soqlEscapeString(est.Id)}' ` +
          `AND Client__c = '${soqlEscapeString(est.Client__c)}' ORDER BY Sort_Order__c NULLS LAST, CreatedDate`
      )) || []
    );
  }
  function expired(est) {
    const exp = est.Public_Token_Expires_At__c ? new Date(est.Public_Token_Expires_At__c).getTime() : 0;
    return exp > 0 && exp < d.now().getTime();
  }
  async function act(est, event, details, actorName) {
    return recordActivity(d.getSupabaseClient, {
      tenantId: est.Client__c,
      event,
      recordType: "estimate",
      recordSfId: est.Id,
      estimateSfId: est.Id,
      jobSfId: est.Service_Job__c ?? null,
      actor: { id: null, name: actorName },
      details,
      at: d.now().toISOString(),
    });
  }
  const canAccept = (est) => ["Sent", "Viewed", "Draft"].includes(est.Status__c) && Number(est.Version__c) > 0;

  // --- the money side of the page ------------------------------------------------------
  async function loadJob(est) {
    if (!est.Service_Job__c) return null;
    const rows = await d.sfQuery(`SELECT ${PUBLIC_JOB_SELECT} FROM ${JOB_SF_OBJECT} WHERE Id = '${soqlEscapeString(est.Service_Job__c)}' AND Client__c = '${soqlEscapeString(est.Client__c)}' LIMIT 1`);
    return rows?.[0] ?? null;
  }
  async function loadLiveInvoice(job) {
    if (!job) return null;
    const rows = (await d.sfQuery(`SELECT ${INVOICE_SELECT} FROM ${INVOICE_SF_OBJECT} WHERE Service_Job__c = '${soqlEscapeString(job.Id)}' AND Client__c = '${soqlEscapeString(job.Client__c)}' ORDER BY CreatedDate`)) || [];
    return rows.find((i) => i.Status__c !== "Void") ?? null;
  }
  async function loadCustomer(est) {
    if (!est.Sundial_Customer__c) return null;
    const rows = await d.sfQuery(`SELECT ${PUBLIC_CUSTOMER_SELECT} FROM ${CUSTOMER_SF_OBJECT} WHERE Id = '${soqlEscapeString(est.Sundial_Customer__c)}' AND Client__c = '${soqlEscapeString(est.Client__c)}' LIMIT 1`);
    return rows?.[0] ?? null;
  }
  async function tenantSlug(tenantId) {
    const rows = await d.sfQuery(`SELECT Id, Name FROM ${TENANT_SF_OBJECT} WHERE Id = '${soqlEscapeString(tenantId)}' LIMIT 1`);
    return rows?.[0]?.Name ?? null;
  }
  /** The tenant's Stripe (null = not set up), computed once per request. */
  async function stripeContext(est) {
    const slug = await tenantSlug(est.Client__c);
    const stripe = slug ? await stripeFor(slug) : null;
    return { slug, stripe };
  }
  async function paymentFor(est, { job, invoice, stripe } = {}) {
    const j = job === undefined ? await loadJob(est) : job;
    const inv = invoice === undefined ? await loadLiveInvoice(j) : invoice;
    const s = stripe === undefined ? (await stripeContext(est)).stripe : stripe;
    return paymentSummary({ est, job: j, invoice: inv, configured: !!s });
  }

  const H = {
    async view({ cors, token }) {
      const est = await loadByToken(token);
      if (!est || est.Is_Template__c === true) return notFound(cors);
      if (expired(est)) return jsonResponse(410, cors, { error: "expired", code: "LINK_EXPIRED", message: "This estimate link has expired. Please contact us for a fresh one." });
      const lines = await loadLines(est);
      const totals = computeTotals(lines.map(lineFromRecord), estimateFromRecord(est));
      // First open of a Sent estimate = Viewed. Best-effort; the page renders regardless.
      if (est.Status__c === "Sent" || !est.Last_Viewed_At__c) {
        try {
          const fields = { Last_Viewed_At__c: d.now().toISOString() };
          if (est.Status__c === "Sent") fields.Status__c = "Viewed";
          await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, fields);
          if (est.Status__c === "Sent") {
            est.Status__c = "Viewed";
            await act(est, EVENTS.ESTIMATE_UPDATED, { viewed: true, version: Number(est.Version__c) || 0 }, "Customer");
          }
        } catch (e) {
          console.error("public view stamp failed:", e?.message || e);
        }
      }
      const brand = await brandFor(est.Client__c);
      const { html, title } = renderEstimateDocument({ estimate: est, lines, totals, brand, options: { mode: "customer" } });
      let payment = null;
      try {
        payment = await paymentFor(est);
      } catch (e) {
        console.error("public view: payment summary failed:", e?.message || e); // the document still renders
      }
      return jsonResponse(200, cors, { html, title, ...publicSummary(est, totals), canAccept: canAccept(est), payment });
    },

    async accept({ cors, token, body }) {
      const est = await loadByToken(token);
      if (!est || est.Is_Template__c === true) return notFound(cors);
      if (expired(est)) return jsonResponse(410, cors, { error: "expired", code: "LINK_EXPIRED" });
      const name = String(body?.name ?? "").trim().slice(0, 120);
      if (!name) return jsonResponse(400, cors, { error: "bad_request", code: "NAME_REQUIRED", message: "Please type your name to approve." });
      const lines = await loadLines(est);
      const totals = computeTotals(lines.map(lineFromRecord), estimateFromRecord(est));
      if (est.Status__c === "Approved") {
        return jsonResponse(200, cors, { success: true, alreadyApproved: true, ...publicSummary(est, totals) });
      }
      if (!canAccept(est)) {
        return jsonResponse(409, cors, { error: "not_acceptable", code: "ESTIMATE_NOT_OPEN", status: est.Status__c, message: "This estimate can no longer be approved online. Please contact us." });
      }
      const fields = {
        Status__c: "Approved",
        Approved_At__c: d.now().toISOString(),
        Approved_Version__c: Number(est.Version__c) || 0,
        Approved_Amount__c: totals.total,
        Approval_Method__c: "Online",
        Approved_By_Name__c: name,
      };
      try {
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, fields);
        for (const l of lines) {
          if (l.Stage__c === "Proposed") await d.sfUpdateRecord(LINE_SF_OBJECT, l.Id, { Stage__c: "Approved" });
        }
      } catch (e) {
        console.error("public accept failed:", e?.sfBody || e?.message || e);
        return jsonResponse(502, cors, { error: "salesforce_error", code: "SALESFORCE_ERROR", message: "We couldn't record your approval. Please try again or contact us." });
      }
      Object.assign(est, fields);
      await act(est, EVENTS.ESTIMATE_APPROVED, { method: "Online", approvedBy: name, version: fields.Approved_Version__c, amount: totals.total }, `Customer: ${name}`);
      await notifier.toOffice({
        tenantId: est.Client__c, category: "money", kind: "estimate_approved",
        title: `Approved online: ${est.Name ?? "estimate"} · ${est.Customer_Name_at_Creation__c ?? name} — $${Number(totals.total || 0).toFixed(2)}`,
        body: `Signed by ${name} (v${fields.Approved_Version__c})${est.Service_Job__c ? "" : " · no job yet — Create Job to schedule it"}`,
        url: `/service/estimates/${est.Id}`, recordType: "estimate", recordSfId: est.Id, dedupeKey: `money:approved:${est.Id}:${fields.Approved_Version__c}`,
      });
      let payment = null;
      try {
        payment = await paymentFor(est);
      } catch (e) {
        console.error("public accept: payment summary failed:", e?.message || e);
      }
      return jsonResponse(200, cors, { success: true, ...publicSummary(est, totals), payment });
    },

    /**
     * A Stripe Checkout Session for what the page offered. The kind is re-derived from
     * the records here — the browser's word for it is never trusted: asking for
     * `balance` with no invoice, or `deposit` after it was paid, is a 409.
     */
    async checkout({ cors, token, body }) {
      const est = await loadByToken(token);
      if (!est || est.Is_Template__c === true) return notFound(cors);
      if (expired(est)) return jsonResponse(410, cors, { error: "expired", code: "LINK_EXPIRED" });
      const kind = String(body?.kind ?? "");
      if (!CHECKOUT_KINDS.includes(kind)) return jsonResponse(400, cors, { error: "bad_request", code: "KIND_INVALID", message: `kind must be one of ${CHECKOUT_KINDS.join(", ")}.` });
      const { slug, stripe } = await stripeContext(est);
      if (!stripe) return jsonResponse(503, cors, { error: "not_configured", code: "STRIPE_NOT_CONFIGURED", message: "Online payment isn't set up yet — please give us a call." });
      const job = await loadJob(est);
      const invoice = await loadLiveInvoice(job);
      const summary = paymentSummary({ est, job, invoice, configured: true });
      const allowed = summary.next === kind || (kind === "setup" && ["Approved", "Invoiced"].includes(est.Status__c) && !summary.cardOnFile && !(job?.Bill_To_Type__c && job.Bill_To_Type__c !== "Customer"));
      if (!allowed) return jsonResponse(409, cors, { error: "not_applicable", code: "CHECKOUT_NOT_APPLICABLE", next: summary.next, message: summary.next ? "That step isn't the one that's due — reload the page." : "There's nothing to pay right now." });
      const base = String(d.publicBaseUrl || "").replace(/\/+$/, "");
      if (!base) return jsonResponse(503, cors, { error: "not_configured", code: "PUBLIC_URL_NOT_SET", message: "Online payment isn't set up yet — please give us a call." });

      // The Stripe customer: reuse the id on the customer hub, else create and remember it.
      const customer = await loadCustomer(est);
      let stripeCustomerId = customer?.Stripe_Customer_Id__c || null;
      try {
        const ensured = await ensureStripeCustomer(stripe.client, {
          existingId: stripeCustomerId,
          name: customer?.Name || est.Customer_Name_at_Creation__c || job?.Customer_Name_at_Creation__c || undefined,
          email: customer?.Primary_Email__c || est.Primary_Email_at_Creation__c || job?.Primary_Email_at_Creation__c || undefined,
          phone: customer?.Primary_Phone__c || undefined,
          metadata: { tenant: slug, sundialCustomerId: customer?.Id || "", source: "sundial" },
        });
        if (customer && ensured !== stripeCustomerId) {
          await d.sfUpdateRecord(CUSTOMER_SF_OBJECT, customer.Id, { Stripe_Customer_Id__c: ensured });
        }
        stripeCustomerId = ensured;
      } catch (e) {
        console.error("public checkout: customer failed:", e?.message || e);
        return jsonResponse(502, cors, { error: "stripe_error", code: "STRIPE_ERROR", message: "We couldn't start the payment. Please try again or give us a call." });
      }

      const page = `${base}/estimate/${encodeURIComponent(token)}`;
      const metadata = { tenant: slug, tenantId: est.Client__c, estimateId: est.Id, jobId: job?.Id || "", customerId: customer?.Id || "", invoiceId: invoice?.Id || "", kind };
      const params = {
        customer: stripeCustomerId,
        success_url: `${page}?checkout=success&kind=${kind}`,
        cancel_url: `${page}?checkout=cancel`,
        client_reference_id: est.Id,
        metadata,
      };
      const brand = deps.brandName || "";
      if (kind === "setup") {
        Object.assign(params, { mode: "setup", payment_method_types: ["card"], setup_intent_data: { metadata } });
      } else {
        const amount = kind === "deposit" ? summary.depositAmount : summary.invoice.balance;
        const name = kind === "deposit" ? `Deposit — ${est.Name}${brand ? ` (${brand})` : ""}` : `${summary.invoice.number} — balance due${brand ? ` (${brand})` : ""}`;
        Object.assign(params, {
          mode: "payment",
          line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: toCents(amount), product_data: { name } } }],
          // The card is kept for the rest of the job (the final charge is off-session).
          payment_intent_data: { setup_future_usage: "off_session", description: name, metadata },
        });
      }
      let session;
      try {
        session = await stripe.client.post("checkout/sessions", params, { idempotencyKey: `checkout:${est.Id}:${kind}:${invoice?.Id || ""}:${summary.invoice?.balance ?? summary.depositAmount}:${d.now().toISOString().slice(0, 13)}` });
      } catch (e) {
        console.error("public checkout: session failed:", e instanceof StripeError ? `${e.code} ${e.message}` : e?.message || e);
        return jsonResponse(502, cors, { error: "stripe_error", code: "STRIPE_ERROR", message: "We couldn't start the payment. Please try again or give us a call." });
      }
      await act(est, EVENTS.ESTIMATE_UPDATED, { checkout: kind, amount: kind === "setup" ? null : kind === "deposit" ? summary.depositAmount : summary.invoice.balance, sessionId: session.id ?? null, mode: stripe.config.mode }, "Customer");
      return jsonResponse(200, cors, { url: session.url, kind, mode: stripe.config.mode });
    },

    async decline({ cors, token, body }) {
      const est = await loadByToken(token);
      if (!est || est.Is_Template__c === true) return notFound(cors);
      if (expired(est)) return jsonResponse(410, cors, { error: "expired", code: "LINK_EXPIRED" });
      if (est.Status__c === "Approved" || est.Status__c === "Invoiced") {
        return jsonResponse(409, cors, { error: "not_declinable", code: "ESTIMATE_NOT_OPEN", status: est.Status__c });
      }
      const reason = String(body?.reason ?? "").trim().slice(0, 255) || null;
      try {
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, { Status__c: "Declined", Declined_Reason__c: reason });
      } catch (e) {
        console.error("public decline failed:", e?.sfBody || e?.message || e);
        return jsonResponse(502, cors, { error: "salesforce_error", code: "SALESFORCE_ERROR" });
      }
      est.Status__c = "Declined";
      await act(est, EVENTS.ESTIMATE_DECLINED, { reason, online: true }, "Customer");
      await notifier.toOffice({
        tenantId: est.Client__c, category: "money", kind: "estimate_declined",
        title: `Declined online: ${est.Name ?? "estimate"} · ${est.Customer_Name_at_Creation__c ?? "customer"}`,
        body: reason ? `Reason: ${reason}` : "No reason given",
        url: `/service/estimates/${est.Id}`, recordType: "estimate", recordSfId: est.Id, dedupeKey: `money:declined:${est.Id}:${est.Version__c ?? ""}`,
      });
      return jsonResponse(200, cors, { success: true, status: "Declined" });
    },
  };

  // --- the customer's job report ------------------------------------------------------
  H.report = async ({ cors, token }) => {
    if (!TOKEN_RE.test(token || "")) return jsonResponse(404, cors, { error: "not_found", code: "REPORT_NOT_FOUND" });
    const rows = await d.sfQuery(`SELECT ${REPORT_JOB_SELECT} FROM ${JOB_SF_OBJECT} WHERE Report_Public_Token__c = '${soqlEscapeString(token)}' LIMIT 2`);
    const job = rows && rows.length === 1 ? rows[0] : null;
    if (!job) return jsonResponse(404, cors, { error: "not_found", code: "REPORT_NOT_FOUND" });
    const exp = job.Report_Token_Expires_At__c ? new Date(job.Report_Token_Expires_At__c).getTime() : 0;
    if (exp > 0 && exp < d.now().getTime()) return jsonResponse(410, cors, { error: "expired", code: "LINK_EXPIRED", message: "This report link has expired. Please contact us for a fresh one." });
    const norm = normalizeReportSections(job.Report_Sections__c);
    const report = norm.ok ? norm.value : { sections: [], receipt: true, intro: "" };
    const [files, calls, invoice] = await Promise.all([
      d.listFiles(job.Id).catch((e) => (console.error("public report: photo list failed:", e?.message || e), [])),
      d.sfQuery(`SELECT Id, Name, Scheduled_Start__c, Actual_Start__c, Tech__c, Tech__r.First_Name__c, Tech__r.Last_Name__c FROM Sundial_Service_Call__c WHERE Sundial_Service_Job__c = '${soqlEscapeString(job.Id)}' AND Client__c = '${soqlEscapeString(job.Client__c)}' LIMIT 200`).catch(() => []),
      loadLiveInvoice(job),
    ]);
    const payments = invoice ? ((await d.sfQuery(`SELECT ${PAYMENT_SELECT} FROM ${PAYMENT_SF_OBJECT} WHERE Service_Job__c = '${soqlEscapeString(job.Id)}' AND Client__c = '${soqlEscapeString(job.Client__c)}' ORDER BY Received_At__c`)) || []).filter((p) => !p.Invoice__c || p.Invoice__c === invoice.Id) : [];
    let estimate = null;
    let lines = [];
    if (invoice && job.Estimate__c) {
      const est = await d.sfQuery(`SELECT ${ESTIMATE_SELECT} FROM ${ESTIMATE_SF_OBJECT} WHERE Id = '${soqlEscapeString(job.Estimate__c)}' AND Client__c = '${soqlEscapeString(job.Client__c)}' LIMIT 1`);
      estimate = est?.[0] ?? null;
      if (estimate) lines = (await loadLines(estimate)).filter((l) => l.Stage__c !== "Removed");
    }
    const brand = await brandFor(job.Client__c);
    const pdfUrl = job.Report_PDF_S3_Key__c ? publicUrlForKey(job.Report_PDF_S3_Key__c) : null;
    const model = buildJobReportModel({ job, report, photos: reportPhotoChoices(files, job.Id, calls), invoice, lines, payments, estimate, brand, options: { mode: "customer", pdfUrl } });
    const { html, title } = renderJobReportDocument({ model });
    return jsonResponse(200, cors, {
      html,
      title,
      jobNumber: job.Name ?? null,
      customerName: job.Customer_Name_at_Creation__c ?? null,
      sentAt: job.Report_Sent_At__c ?? null,
      pdfUrl,
      sections: model.sections.length,
      receipt: !!model.receipt,
      paid: invoice?.Status__c === "Paid",
    });
  };

  return async function handler(event) {
    const method = httpMethod(event);
    const headers = normalizeHeaders(event?.headers);
    const cors = corsHeaders(headers["origin"]);
    if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
    const route = matchRoute(method, event?.rawPath || event?.path || "");
    if (!route) return jsonResponse(404, cors, { error: "not_found", code: "ROUTE_NOT_FOUND" });
    let body = {};
    if (method === "POST") {
      const parsed = parseJsonBody(event);
      body = parsed.ok ? parsed.data : {};
    }
    try {
      return await H[route.name]({ cors, token: route.token, body });
    } catch (err) {
      console.error(`service-public ${route.name} error:`, err?.sfBody || err?.message || err);
      return jsonResponse(500, cors, { error: "server_error" });
    }
  };
}

export const handler = createHandler({ brandName: process.env.SERVICE_BRAND_NAME || "" });
