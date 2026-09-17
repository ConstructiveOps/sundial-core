// stripe.js — Stripe money INTO Sundial (D-072 amendment 8, 2026-09-17).
//
//   POST /webhooks/stripe/{tenant}          Stripe's events for this tenant's account (no login;
//                                           gated only by the Stripe-Signature check, fail closed)
//   POST /service/invoices/{id}/charge      the office charges the card on file for the balance
//                                           (off-session; also `chargeCard: true` on issue)
//
// The customer's side (Checkout Sessions for card-on-file / deposit / balance) lives in
// sundial-service-public. Everything that turns a Stripe event into MONEY lives here, and
// lands in the one place money is settled: createMoneyCore().settleMoney (invoice.js).
//
// Rules the code holds, never bypass them:
//   - The PaymentIntent id is the idempotency key. A Payment row is looked up by
//     Stripe_Payment_Intent_Id__c before anything is written; a redelivered event, or a
//     charge whose webhook beat the office's own confirm, can never double-count.
//   - Every accepted event is written to sundial_stripe_events (keyed by Stripe's event
//     id) with what Sundial did: applied / deferred / ignored / error. A duplicate event id
//     is answered 200 without touching Salesforce.
//   - Money that arrives BEFORE the job exists (a deposit paid on an estimate the office
//     has not converted yet) is DEFERRED: the estimate is stamped Deposit_Paid_At__c and the
//     ledger row waits; Create Job calls applyDeferred() and writes the Payment row then.
//     No Payment row is ever created without a job to hang it on.
//   - The tenant is the URL's slug → Sundial_Tenant__c, and the event's metadata.tenantId
//     must agree, or the event is ignored. Keys come from Secrets Manager per tenant
//     (lib/stripe.js); a tenant with no webhook secret gets a 503, never a pass.
//   - Off-session charges: PaymentIntent created UNCONFIRMED → Pending Payment row written
//     → confirm. The row exists before Stripe can possibly call back, so the webhook only
//     ever updates it. A decline leaves a Failed row with Stripe's reason for the office.

import { soqlEscapeString } from "../../lib/salesforce.js";
import { EVENTS } from "../../lib/service-activity.js";
import { getSecret as realGetSecret } from "../../lib/secrets.js";
import { defaultPaymentMethod, fromCents, stripeForTenant, toCents, verifyWebhookSignature, StripeError } from "../../lib/stripe.js";
import { PAYMENT_SELECT, PAYMENT_SF_OBJECT } from "./invoice.js";
import { ESTIMATE_SF_OBJECT, JOB_SF_OBJECT } from "./fields.js";

export const STRIPE_EVENTS_TABLE = "sundial_stripe_events";
export const TENANT_SF_OBJECT = "Sundial_Tenant__c";
export const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";
/** The events the endpoint should be subscribed to in the Stripe dashboard. */
export const STRIPE_EVENT_TYPES = Object.freeze(["checkout.session.completed", "payment_intent.succeeded", "payment_intent.payment_failed", "charge.refunded"]);
const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isoFromUnix = (s, fallback) => (Number.isFinite(Number(s)) && Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : fallback);

// --- pure helpers (tested directly) ------------------------------------------------

/** The Payment row a succeeded PaymentIntent becomes. `kind` from our own metadata. */
export function paymentFieldsFromIntent(pi, { tenantId, jobId, invoiceId, mode, now }) {
  const kind = pi?.metadata?.kind;
  const f = {
    Service_Job__c: jobId,
    Client__c: tenantId,
    Type__c: kind === "deposit" ? "Deposit" : "Payment",
    Method__c: "Card",
    Amount__c: fromCents(pi.amount_received ?? pi.amount),
    Status__c: "Succeeded",
    Received_At__c: isoFromUnix(pi.created, now),
    Reference__c: String(pi.id).slice(0, 100),
    Stripe_Payment_Intent_Id__c: pi.id,
    Notes__c: `Stripe (${mode})${kind ? ` — ${kind}` : ""}`.slice(0, 255),
  };
  if (invoiceId) f.Invoice__c = invoiceId;
  const charge = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id;
  if (charge) f.Stripe_Charge_Id__c = charge;
  return f;
}

/** The Refund row one Stripe refund becomes (a refund made in the Stripe dashboard is mirrored). */
export function refundFields(refund, { tenantId, jobId, invoiceId, paymentIntentId, mode, now }) {
  const f = {
    Service_Job__c: jobId,
    Client__c: tenantId,
    Type__c: "Refund",
    Method__c: "Card",
    Amount__c: fromCents(refund.amount),
    Status__c: "Succeeded",
    Received_At__c: isoFromUnix(refund.created, now),
    Reference__c: String(refund.id).slice(0, 100),
    Stripe_Refund_Id__c: refund.id,
    Notes__c: `Stripe refund (${mode})${refund.reason ? ` — ${refund.reason}` : ""}`.slice(0, 255),
  };
  if (paymentIntentId) f.Stripe_Payment_Intent_Id__c = paymentIntentId;
  if (invoiceId) f.Invoice__c = invoiceId;
  return f;
}

/** The raw bytes API Gateway handed us — what the signature was computed over. */
export function rawBodyOf(event) {
  if (event?.body == null) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
}

// --- handler factory ---------------------------------------------------------------
/**
 * @param {object} d   the estimate handler's deps (+ getSecret, fetchUrl)
 * @param {object} h   { money (createMoneyCore), act, markStale, jsonResponse, bad, notFound, sfError, CACHE, customerEmailFor, brandFor }
 */
export function createStripeHandlers(d, h) {
  const { money, jsonResponse, bad, notFound, CACHE } = h;
  const getSecret = d.getSecret || realGetSecret;
  const stripeFor = (slug) => stripeForTenant(slug, { getSecret, ...(d.fetchUrl ? { fetchUrl: d.fetchUrl } : {}) });

  async function tenantIdFor(slug) {
    if (!slug || !/^[a-z0-9-]{1,40}$/i.test(slug)) return null;
    const rows = await d.sfQuery(`SELECT Id, Name FROM ${TENANT_SF_OBJECT} WHERE Name = '${soqlEscapeString(slug)}' LIMIT 1`);
    return rows?.[0]?.Id ?? null;
  }
  async function findPaymentByPI(piId, tenantId) {
    if (!piId) return null;
    const rows = await d.sfQuery(`SELECT ${PAYMENT_SELECT} FROM ${PAYMENT_SF_OBJECT} WHERE Stripe_Payment_Intent_Id__c = '${soqlEscapeString(piId)}' AND Client__c = '${soqlEscapeString(tenantId)}' ORDER BY CreatedDate LIMIT 5`);
    // The refund rows share the intent id; the money row is the non-refund one.
    return (rows || []).find((r) => r.Type__c !== "Refund") ?? null;
  }
  async function findPaymentByRefund(refundId, tenantId) {
    if (!refundId) return null;
    const rows = await d.sfQuery(`SELECT ${PAYMENT_SELECT} FROM ${PAYMENT_SF_OBJECT} WHERE Stripe_Refund_Id__c = '${soqlEscapeString(refundId)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
    return rows?.[0] ?? null;
  }
  async function loadCustomer(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(`SELECT Id, Name, Client__c, Primary_Email__c, Stripe_Customer_Id__c FROM ${CUSTOMER_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
    return rows?.[0] ?? null;
  }
  async function loadEstimateLite(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(`SELECT Id, Name, Client__c, Service_Job__c, Deposit_Paid_At__c FROM ${ESTIMATE_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
    return rows?.[0] ?? null;
  }
  const systemCtx = (tenantId, slug, cors) => ({ tenantId, tenantSlug: slug, userId: null, scope: "system", actor: { id: null, name: "Stripe" }, cors });

  // --- the ledger -----------------------------------------------------------------
  async function ledgerGet(id) {
    const supabase = await d.getSupabaseClient();
    const { data, error } = await supabase.from(STRIPE_EVENTS_TABLE).select("id, status").eq("id", id).maybeSingle();
    if (error) console.error("stripe ledger read:", error.message);
    return data ?? null;
  }
  async function ledgerPut(row) {
    try {
      const supabase = await d.getSupabaseClient();
      const { error } = await supabase.from(STRIPE_EVENTS_TABLE).upsert(row, { onConflict: "id" });
      if (error) console.error("stripe ledger write:", error.message);
    } catch (e) {
      console.error("stripe ledger threw:", e?.message || e);
    }
  }
  async function ledgerDeferred(estimateId, tenantId) {
    const supabase = await d.getSupabaseClient();
    const { data, error } = await supabase.from(STRIPE_EVENTS_TABLE).select("*").eq("client_sf_id", tenantId).eq("estimate_sf_id", estimateId).eq("status", "deferred");
    if (error) {
      console.error("stripe ledger deferred read:", error.message);
      return [];
    }
    return data || [];
  }

  // --- what each event does ---------------------------------------------------------
  /** Stripe's own default card for the customer, so the office's off-session charge finds it. */
  async function rememberDefaultCard(stripe, { stripeCustomerId, paymentMethodId }) {
    if (!stripeCustomerId || !paymentMethodId) return;
    try {
      await stripe.client.post(`customers/${encodeURIComponent(stripeCustomerId)}`, { invoice_settings: { default_payment_method: paymentMethodId } });
    } catch (e) {
      console.error("stripe: default card set failed:", e?.message || e);
    }
  }

  async function applyCheckoutCompleted({ stripe, tenantId, slug, session, cors }) {
    const meta = session.metadata || {};
    const ctx = systemCtx(tenantId, slug, cors);
    const stripeCustomerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
    // The customer hub remembers the Stripe customer (a Checkout may have created it).
    const customer = meta.customerId ? await loadCustomer(meta.customerId, tenantId) : null;
    if (customer && stripeCustomerId && customer.Stripe_Customer_Id__c !== stripeCustomerId) {
      await d.sfUpdateRecord(CUSTOMER_SF_OBJECT, customer.Id, { Stripe_Customer_Id__c: stripeCustomerId });
      await h.markStale(CACHE.customer, [customer.Id], tenantId);
    }
    // The card the customer just used becomes the default for off-session charges.
    let pm = null;
    try {
      if (session.mode === "setup" && session.setup_intent) {
        const si = await stripe.client.get(`setup_intents/${encodeURIComponent(typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent.id)}`);
        pm = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id ?? null;
      } else if (session.mode === "payment" && session.payment_intent) {
        const pi = await stripe.client.get(`payment_intents/${encodeURIComponent(typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id)}`);
        pm = typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id ?? null;
      }
    } catch (e) {
      console.error("stripe: intent lookup failed:", e?.message || e);
    }
    await rememberDefaultCard(stripe, { stripeCustomerId, paymentMethodId: pm });
    const cardOnFile = !!(stripeCustomerId && pm);
    const job = meta.jobId ? await money.loadJob(meta.jobId, tenantId) : null;
    if (job && cardOnFile && job.Customer_Card_on_File__c !== true) {
      await d.sfUpdateRecord(JOB_SF_OBJECT, job.Id, { Customer_Card_on_File__c: true });
      await h.markStale(CACHE.job, [job.Id], tenantId);
      await h.act(ctx, { event: EVENTS.JOB_UPDATED, recordType: "job", recordSfId: job.Id, jobSfId: job.Id, estimateSfId: meta.estimateId || job.Estimate__c || null, details: { fields: { Customer_Card_on_File__c: { from: false, to: true } }, via: "stripe", kind: meta.kind || null } });
    }
    // No job yet: Create Job will set the flag from the ledger.
    return { status: job || !cardOnFile ? "applied" : "deferred", cardOnFile, jobId: job?.Id ?? null, paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null };
  }

  async function applyIntentSucceeded({ stripe, tenantId, slug, pi, cors, jobIdOverride = null }) {
    const meta = pi.metadata || {};
    const ctx = systemCtx(tenantId, slug, cors);
    const kind = meta.kind || null;
    const jobId = jobIdOverride || meta.jobId || null;
    const existing = await findPaymentByPI(pi.id, tenantId);
    // A deposit on an estimate that has no job yet: stamp the estimate, wait for Create Job.
    if (!existing && !jobId) {
      if (kind === "deposit" && meta.estimateId) {
        const est = await loadEstimateLite(meta.estimateId, tenantId);
        if (est && !est.Deposit_Paid_At__c) {
          await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, { Deposit_Paid_At__c: isoFromUnix(pi.created, d.now().toISOString()) });
          await h.markStale(CACHE.estimate, [est.Id], tenantId);
          await h.act(ctx, { event: EVENTS.ESTIMATE_UPDATED, recordType: "estimate", recordSfId: est.Id, estimateSfId: est.Id, details: { depositPaid: fromCents(pi.amount_received ?? pi.amount), paymentIntentId: pi.id, via: "stripe", deferred: true } });
        }
      }
      return { status: "deferred", paymentId: null, amount: fromCents(pi.amount_received ?? pi.amount) };
    }
    const job = await money.loadJob(jobId || existing?.Service_Job__c, tenantId);
    if (!job) throw new Error(`stripe: job ${jobId || existing?.Service_Job__c} not found for ${pi.id}`);
    let paymentId;
    let duplicate = false;
    let invoiceId = existing?.Invoice__c || meta.invoiceId || null;
    if (!invoiceId) {
      const live = (await money.loadJobInvoices(job.Id, tenantId)).find((i) => i.Status__c !== "Void");
      invoiceId = live?.Id ?? null;
    }
    const now = d.now().toISOString();
    if (existing) {
      paymentId = existing.Id;
      if (existing.Status__c === "Succeeded") duplicate = true;
      else {
        const upd = { Status__c: "Succeeded", Amount__c: fromCents(pi.amount_received ?? pi.amount), Received_At__c: isoFromUnix(pi.created, now), Failure_Reason__c: null };
        const charge = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id;
        if (charge) upd.Stripe_Charge_Id__c = charge;
        if (!existing.Invoice__c && invoiceId) upd.Invoice__c = invoiceId;
        await d.sfUpdateRecord(PAYMENT_SF_OBJECT, existing.Id, upd);
      }
    } else {
      const fields = paymentFieldsFromIntent(pi, { tenantId, jobId: job.Id, invoiceId, mode: stripe.config.mode, now });
      const created = await d.sfCreateRecord(PAYMENT_SF_OBJECT, fields);
      paymentId = created.id;
    }
    await h.markStale(CACHE.payment, [paymentId], tenantId);
    if (kind === "deposit" && (meta.estimateId || job.Estimate__c)) {
      const est = await loadEstimateLite(meta.estimateId || job.Estimate__c, tenantId);
      if (est && !est.Deposit_Paid_At__c) {
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, { Deposit_Paid_At__c: isoFromUnix(pi.created, now) });
        await h.markStale(CACHE.estimate, [est.Id], tenantId);
      }
    }
    // Settle: through the invoice when there is one, else the job's own status.
    const invoice = invoiceId ? await money.loadInvoice(invoiceId, tenantId) : null;
    let settled;
    if (invoice && invoice.Status__c !== "Void") settled = await money.settleMoney({ invoice, job, tenantId, ctx });
    else settled = await money.settleJobWithoutInvoice({ job, tenantId });
    if (!duplicate) {
      await h.act(ctx, {
        event: EVENTS.PAYMENT_RECORDED, recordType: "servicepayment", recordSfId: paymentId, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? meta.estimateId ?? null,
        details: { invoice: invoice?.Name ?? null, type: kind === "deposit" ? "Deposit" : "Payment", method: "Card", amount: fromCents(pi.amount_received ?? pi.amount), reference: pi.id, paid: settled.summary?.paid ?? null, balance: settled.balance ?? null, invoiceStatus: invoice?.Status__c ?? null, via: "stripe", kind, mode: stripe.config.mode },
      });
    }
    return { status: "applied", paymentId, jobId: job.Id, invoiceId: invoice?.Id ?? null, amount: fromCents(pi.amount_received ?? pi.amount), duplicate };
  }

  async function applyIntentFailed({ tenantId, slug, pi, cors }) {
    const existing = await findPaymentByPI(pi.id, tenantId);
    if (!existing) return { status: "ignored", reason: "no Payment row for this intent (a Checkout attempt the customer can retry)" };
    if (existing.Status__c === "Succeeded") return { status: "ignored", reason: "already succeeded" };
    if (existing.Status__c === "Failed") return { status: "ignored", reason: "already failed (the office's confirm recorded it)" };
    const reason = pi.last_payment_error?.message || pi.last_payment_error?.decline_code || pi.last_payment_error?.code || "Payment failed";
    await d.sfUpdateRecord(PAYMENT_SF_OBJECT, existing.Id, { Status__c: "Failed", Failure_Reason__c: String(reason).slice(0, 255) });
    await h.markStale(CACHE.payment, [existing.Id], tenantId);
    await h.act(systemCtx(tenantId, slug, cors), { event: EVENTS.PAYMENT_RECORDED, recordType: "servicepayment", recordSfId: existing.Id, jobSfId: existing.Service_Job__c ?? null, details: { type: existing.Type__c, method: "Card", amount: cents(existing.Amount__c), failed: true, reason, reference: pi.id, via: "stripe" } });
    return { status: "applied", paymentId: existing.Id, failed: true, reason };
  }

  async function applyChargeRefunded({ stripe, tenantId, slug, charge, cors }) {
    const ctx = systemCtx(tenantId, slug, cors);
    const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id ?? null;
    const original = await findPaymentByPI(piId, tenantId);
    const jobId = original?.Service_Job__c || charge.metadata?.jobId || null;
    if (!jobId) return { status: "ignored", reason: "no Sundial payment behind this charge" };
    let refunds = charge.refunds?.data;
    if (!Array.isArray(refunds)) {
      try {
        refunds = (await stripe.client.get("refunds", { charge: charge.id, limit: 20 }))?.data || [];
      } catch (e) {
        throw new Error(`stripe: refunds list failed: ${e?.message || e}`);
      }
    }
    const job = await money.loadJob(jobId, tenantId);
    if (!job) throw new Error(`stripe: job ${jobId} not found for refund on ${charge.id}`);
    const created = [];
    for (const r of refunds) {
      if (r.status && r.status !== "succeeded") continue;
      if (await findPaymentByRefund(r.id, tenantId)) continue;
      const fields = refundFields(r, { tenantId, jobId: job.Id, invoiceId: original?.Invoice__c || null, paymentIntentId: piId, mode: stripe.config.mode, now: d.now().toISOString() });
      const row = await d.sfCreateRecord(PAYMENT_SF_OBJECT, fields);
      created.push({ id: row.id, amount: fields.Amount__c });
      await h.markStale(CACHE.payment, [row.id], tenantId);
    }
    const invoice = original?.Invoice__c ? await money.loadInvoice(original.Invoice__c, tenantId) : null;
    let settled;
    if (invoice && invoice.Status__c !== "Void") settled = await money.settleMoney({ invoice, job, tenantId, ctx });
    else settled = await money.settleJobWithoutInvoice({ job, tenantId });
    for (const c of created) {
      await h.act(ctx, { event: EVENTS.PAYMENT_RECORDED, recordType: "servicepayment", recordSfId: c.id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null, details: { invoice: invoice?.Name ?? null, type: "Refund", method: "Card", amount: c.amount, reference: piId, paid: settled.summary?.paid ?? null, balance: settled.balance ?? null, via: "stripe" } });
    }
    return { status: created.length ? "applied" : "ignored", refunds: created.length, jobId: job.Id, duplicate: !created.length };
  }

  /** The office's charge on the card on file. Returns a plain result; never throws for a decline. */
  async function chargeInvoice({ ctx, invoice, job }) {
    const { tenantId } = ctx;
    if (invoice.Status__c === "Void") return { ok: false, code: "INVOICE_VOID", message: "This invoice is void." };
    const balance = money.balanceOf(invoice);
    if (balance <= 0) return { ok: false, code: "NOTHING_DUE", message: "There is no balance on this invoice." };
    if (job.Bill_To_Type__c && job.Bill_To_Type__c !== "Customer") return { ok: false, code: "NOT_CUSTOMER_PAY", message: `This invoice bills ${job.Bill_To_Name__c || job.Bill_To_Type__c}, not the customer's card.` };
    const stripe = await stripeFor(ctx.tenantSlug);
    if (!stripe) return { ok: false, code: "STRIPE_NOT_CONFIGURED", message: "Stripe isn't set up for this tenant yet (Secrets Manager sundial/stripe)." };
    const customer = job.Sundial_Customer__c ? await loadCustomer(job.Sundial_Customer__c, tenantId) : null;
    if (!customer?.Stripe_Customer_Id__c) return { ok: false, code: "NO_CARD", message: "There is no card on file for this customer — send the estimate link so they can add one." };
    let pm = null;
    try {
      pm = await defaultPaymentMethod(stripe.client, customer.Stripe_Customer_Id__c);
    } catch (e) {
      return { ok: false, code: "STRIPE_ERROR", message: e?.message || "Stripe could not be reached." };
    }
    if (!pm) return { ok: false, code: "NO_CARD", message: "There is no card on file for this customer — send the estimate link so they can add one." };
    // Pending in Sundial first — refuse to double-charge a balance a Pending row already covers.
    const pending = (await money.loadJobPayments(job.Id, tenantId)).find((p) => p.Invoice__c === invoice.Id && p.Status__c === "Pending" && p.Stripe_Payment_Intent_Id__c);
    if (pending) return { ok: false, code: "CHARGE_PENDING", message: `A card charge (${pending.Stripe_Payment_Intent_Id__c}) is still processing on this invoice.` };
    const metadata = { tenant: ctx.tenantSlug || "", tenantId, jobId: job.Id, invoiceId: invoice.Id, estimateId: job.Estimate__c || "", customerId: customer.Id, kind: "charge" };
    const description = `${invoice.Name} — ${h.brandFor ? h.brandFor(ctx).companyName || "Sundial" : "Sundial"}`.slice(0, 200);
    const email = customer.Primary_Email__c || job.Primary_Email_at_Creation__c || null;
    let pi;
    try {
      pi = await stripe.client.post(
        "payment_intents",
        { amount: toCents(balance), currency: "usd", customer: customer.Stripe_Customer_Id__c, payment_method: pm, off_session: true, confirm: false, description, metadata, ...(email ? { receipt_email: email } : {}) },
        { idempotencyKey: `charge:${invoice.Id}:${toCents(balance)}:${d.now().toISOString().slice(0, 13)}` }
      );
    } catch (e) {
      return { ok: false, code: e instanceof StripeError ? e.code || "STRIPE_ERROR" : "STRIPE_ERROR", message: e?.message || "Stripe could not create the charge." };
    }
    const now = d.now().toISOString();
    const rowFields = { Service_Job__c: job.Id, Invoice__c: invoice.Id, Client__c: tenantId, Type__c: "Payment", Method__c: "Card", Amount__c: balance, Status__c: "Pending", Received_At__c: now, Reference__c: pi.id, Stripe_Payment_Intent_Id__c: pi.id, Recorded_By__c: ctx.userId || undefined, Notes__c: `Stripe (${stripe.config.mode}) — charged by the office` };
    for (const k of Object.keys(rowFields)) if (rowFields[k] === undefined) delete rowFields[k];
    const row = await d.sfCreateRecord(PAYMENT_SF_OBJECT, rowFields);
    await h.markStale(CACHE.payment, [row.id], tenantId);
    let confirmed;
    try {
      confirmed = await stripe.client.post(`payment_intents/${encodeURIComponent(pi.id)}/confirm`, { off_session: true }, { idempotencyKey: `confirm:${pi.id}` });
    } catch (e) {
      const reason = e instanceof StripeError ? e.message : e?.message || "Payment failed";
      const code = e instanceof StripeError ? e.declineCode || e.code || "STRIPE_ERROR" : "STRIPE_ERROR";
      await d.sfUpdateRecord(PAYMENT_SF_OBJECT, row.id, { Status__c: "Failed", Failure_Reason__c: String(reason).slice(0, 255) });
      await h.markStale(CACHE.payment, [row.id], tenantId);
      await h.act(ctx, { event: EVENTS.PAYMENT_RECORDED, recordType: "servicepayment", recordSfId: row.id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null, details: { invoice: invoice.Name, type: "Payment", method: "Card", amount: balance, failed: true, reason, reference: pi.id, via: "office-charge" } });
      return { ok: false, code, message: reason, paymentId: row.id, paymentIntentId: pi.id };
    }
    if (confirmed.status === "succeeded") {
      const upd = { Status__c: "Succeeded", Received_At__c: isoFromUnix(confirmed.created, now) };
      const charge = typeof confirmed.latest_charge === "string" ? confirmed.latest_charge : confirmed.latest_charge?.id;
      if (charge) upd.Stripe_Charge_Id__c = charge;
      await d.sfUpdateRecord(PAYMENT_SF_OBJECT, row.id, upd);
      await h.markStale(CACHE.payment, [row.id], tenantId);
      const settled = await money.settleMoney({ invoice, job, tenantId, ctx });
      await h.act(ctx, { event: EVENTS.PAYMENT_RECORDED, recordType: "servicepayment", recordSfId: row.id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null, details: { invoice: invoice.Name, type: "Payment", method: "Card", amount: balance, reference: pi.id, paid: settled.summary.paid, balance: settled.balance, invoiceStatus: invoice.Status__c, via: "office-charge", mode: stripe.config.mode } });
      return { ok: true, status: "succeeded", paymentId: row.id, paymentIntentId: pi.id, amount: balance, settled };
    }
    // processing / requires_action: the webhook finishes it.
    return { ok: true, status: confirmed.status, pending: true, paymentId: row.id, paymentIntentId: pi.id, amount: balance };
  }

  /** Create Job hook: money and cards that arrived before the job existed. */
  async function applyDeferred({ ctx, estimateId, jobId }) {
    const { tenantId } = ctx;
    const rows = await ledgerDeferred(estimateId, tenantId);
    if (!rows.length) return { applied: 0 };
    const stripe = await stripeFor(ctx.tenantSlug);
    let applied = 0;
    for (const row of rows) {
      try {
        const obj = row.payload || {};
        let result = null;
        if (row.type === "payment_intent.succeeded" && stripe) result = await applyIntentSucceeded({ stripe, tenantId, slug: ctx.tenantSlug, pi: obj, cors: ctx.cors, jobIdOverride: jobId });
        else if (row.type === "checkout.session.completed") {
          const job = await money.loadJob(jobId, tenantId);
          if (job && job.Customer_Card_on_File__c !== true) {
            await d.sfUpdateRecord(JOB_SF_OBJECT, job.Id, { Customer_Card_on_File__c: true });
            await h.markStale(CACHE.job, [job.Id], tenantId);
          }
          result = { status: "applied", jobId };
        }
        if (result?.status === "applied") {
          applied += 1;
          await ledgerPut({ id: row.id, client_sf_id: tenantId, type: row.type, status: "applied", job_sf_id: jobId, payment_sf_id: result.paymentId ?? row.payment_sf_id ?? null, applied_at: d.now().toISOString() });
        }
      } catch (e) {
        console.error(`stripe: deferred ${row.id} failed:`, e?.message || e);
        await ledgerPut({ id: row.id, client_sf_id: tenantId, type: row.type, status: "deferred", error: String(e?.message || e).slice(0, 500) });
      }
    }
    return { applied };
  }

  return {
    chargeInvoice,
    applyDeferred,

    /** POST /service/invoices/{id}/charge — the office charges the card on file. */
    async chargeInvoiceRoute({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const invoice = await money.loadInvoice(params[0], tenantId);
      if (!invoice) return notFound(cors);
      const job = await money.loadJob(invoice.Service_Job__c, tenantId);
      if (!job) return notFound(cors);
      const r = await chargeInvoice({ ctx, invoice, job });
      if (!r.ok) {
        const status = ["NOTHING_DUE", "INVOICE_VOID", "NOT_CUSTOMER_PAY", "CHARGE_PENDING"].includes(r.code) ? 409 : ["NO_CARD", "STRIPE_NOT_CONFIGURED"].includes(r.code) ? 400 : 402;
        return jsonResponse(status, cors, { error: "charge_failed", ...r });
      }
      const payments = (await money.loadJobPayments(job.Id, tenantId)).filter((p) => p.Invoice__c === invoice.Id);
      return jsonResponse(200, cors, { success: true, ...r, settled: undefined, invoice, payments, balance: money.balanceOf(invoice), jobStatus: job.Status__c, paymentStatus: job.Payment_Status__c });
    },

    /** POST /webhooks/stripe/{tenant} — no login; the signature is the gate. */
    async stripeWebhook({ params, event, headers, cors }) {
      const slug = params[0];
      const stripe = await stripeFor(slug);
      if (!stripe?.config?.webhookSecret) {
        console.error(`stripe webhook: no webhook secret for tenant '${slug}' — failing closed.`);
        return jsonResponse(503, cors, { error: "not_configured", code: "STRIPE_NOT_CONFIGURED" });
      }
      const raw = rawBodyOf(event);
      const v = verifyWebhookSignature({ header: headers["stripe-signature"], rawBody: raw, secret: stripe.config.webhookSecret, now: d.now().getTime() });
      if (!v.ok) {
        console.warn(`stripe webhook rejected (${slug}): ${v.reason}`);
        return jsonResponse(400, cors, { error: "bad_signature", code: "SIGNATURE_INVALID" });
      }
      let evt;
      try {
        evt = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
      } catch {
        return bad(cors, "INVALID_BODY", "Body must be JSON.");
      }
      if (!evt?.id || !evt?.type || !evt?.data?.object) return bad(cors, "INVALID_EVENT", "Not a Stripe event.");
      const tenantId = await tenantIdFor(slug);
      if (!tenantId) return jsonResponse(503, cors, { error: "not_configured", code: "TENANT_UNKNOWN" });
      // Livemode must match the keys that verified it — a test event on live keys is noise.
      const obj = evt.data.object;
      const meta = obj.metadata || {};
      const seen = await ledgerGet(evt.id);
      if (seen && seen.status !== "error") return jsonResponse(200, cors, { received: true, duplicate: true, status: seen.status });
      const base = { id: evt.id, client_sf_id: tenantId, tenant_id: slug, type: evt.type, kind: meta.kind || null, mode: stripe.config.mode, estimate_sf_id: meta.estimateId || null, job_sf_id: meta.jobId || null, invoice_sf_id: meta.invoiceId || null, payment_intent_id: obj.object === "payment_intent" ? obj.id : typeof obj.payment_intent === "string" ? obj.payment_intent : null, amount: obj.amount_received != null ? fromCents(obj.amount_received) : obj.amount_total != null ? fromCents(obj.amount_total) : obj.amount != null ? fromCents(obj.amount) : null, payload: obj, received_at: d.now().toISOString() };
      if (meta.tenantId && meta.tenantId !== tenantId) {
        await ledgerPut({ ...base, status: "ignored", error: "metadata.tenantId does not match the URL's tenant" });
        return jsonResponse(200, cors, { received: true, status: "ignored" });
      }
      if (typeof evt.livemode === "boolean" && (evt.livemode ? "live" : "test") !== stripe.config.mode) {
        await ledgerPut({ ...base, status: "ignored", error: `livemode ${evt.livemode} does not match ${stripe.config.mode} keys` });
        return jsonResponse(200, cors, { received: true, status: "ignored" });
      }
      let result;
      try {
        if (evt.type === "checkout.session.completed") result = await applyCheckoutCompleted({ stripe, tenantId, slug, session: obj, cors });
        else if (evt.type === "payment_intent.succeeded") result = await applyIntentSucceeded({ stripe, tenantId, slug, pi: obj, cors });
        else if (evt.type === "payment_intent.payment_failed") result = await applyIntentFailed({ tenantId, slug, pi: obj, cors });
        else if (evt.type === "charge.refunded") result = await applyChargeRefunded({ stripe, tenantId, slug, charge: obj, cors });
        else result = { status: "ignored", reason: `unhandled event type ${evt.type}` };
      } catch (e) {
        console.error(`stripe webhook ${evt.type} (${evt.id}) failed:`, e?.sfBody || e?.message || e);
        await ledgerPut({ ...base, status: "error", error: String(e?.sfBody || e?.message || e).slice(0, 500) });
        return jsonResponse(500, cors, { error: "apply_failed", code: "STRIPE_APPLY_FAILED" }); // Stripe retries
      }
      await ledgerPut({ ...base, status: result.status, error: result.reason || null, job_sf_id: result.jobId || base.job_sf_id, invoice_sf_id: result.invoiceId || base.invoice_sf_id, payment_sf_id: result.paymentId || null, applied_at: result.status === "applied" ? d.now().toISOString() : null });
      return jsonResponse(200, cors, { received: true, ...result });
    },
  };
}
