// stripe.js — Stripe money INTO Sundial (D-072 amendment 8, 2026-09-17).
//
//   POST /webhooks/stripe/{tenant}          Stripe's events for this tenant's account (no login;
//                                           gated only by the Stripe-Signature check, fail closed)
//   POST /service/invoices/{id}/charge      the office charges the card on file for the balance
//                                           (off-session; also `chargeCard: true` on issue)
//   THE OFFICE'S CARD ON FILE (amendment 11, 2026-09-28 — a card over the phone):
//   GET  /service/jobs/{id}/card            is there a card? (brand / last 4, live from Stripe), what is owed
//   POST /service/jobs/{id}/card-session    a Stripe-hosted card page for the OFFICE to type the card the
//                                           customer reads out (Checkout in setup mode; the card never
//                                           touches Sundial's own page — Stripe's, in a new tab)
//   POST /service/jobs/{id}/card-link       text / email the customer the estimate link so THEY add the card
//   POST /service/jobs/{id}/charge          charge the card on file for ANY amount up to what is owed — a
//                                           deposit before the invoice, part or all of the balance after.
//                                           Admin / Executive only (service.card.charge, ACTION_LEVELS).
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
import { defaultPaymentMethod, ensureStripeCustomer, fromCents, stripeForTenant, toCents, verifyWebhookSignature, StripeError } from "../../lib/stripe.js";
import { isPrimaryTenant } from "../../lib/tenant-guard.js";
import { portalUrlNotConfiguredBody } from "../../lib/tenant-settings.js";
import { PAYMENT_SELECT, PAYMENT_SF_OBJECT } from "./invoice.js";
import { ESTIMATE_SF_OBJECT, JOB_SF_OBJECT } from "./fields.js";

export const STRIPE_EVENTS_TABLE = "sundial_stripe_events";
export const TENANT_SF_OBJECT = "Sundial_Tenant__c";
export const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";
/** The events the endpoint should be subscribed to in the Stripe dashboard. */
export const STRIPE_EVENT_TYPES = Object.freeze(["checkout.session.completed", "payment_intent.succeeded", "payment_intent.payment_failed", "charge.refunded", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"]);
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
 * @param {object} h   { money (createMoneyCore), act, markStale, jsonResponse, bad, notFound, sfError, CACHE, customerEmailFor, brandFor, club (D-073: applyEvent for subscription events) }
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
    const rows = await d.sfQuery(`SELECT Id, Name, Client__c, Primary_Email__c, Primary_Phone__c, Stripe_Customer_Id__c FROM ${CUSTOMER_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
    return rows?.[0] ?? null;
  }
  async function loadEstimateLite(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(`SELECT Id, Name, Client__c, Service_Job__c, Deposit_Paid_At__c, Total__c, Deposit_Amount__c, Public_Token__c, Status__c FROM ${ESTIMATE_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
    return rows?.[0] ?? null;
  }
  const systemCtx = (tenantId, slug, cors) => ({ tenantId, tenantSlug: slug, userId: null, scope: "system", actor: { id: null, name: "Stripe" }, cors });
  // "No address to build the customer's link from" (D-078). The primary tenant's answer is
  // unchanged (its address is the Lambda's SERVICE_PUBLIC_BASE_URL); any other tenant is
  // told its own brand block has no publicUrl / portalUrl — and is never lent the primary's.
  const noPublicUrl = (ctx) =>
    isPrimaryTenant(ctx?.tenantSlug)
      ? { error: "not_configured", code: "PUBLIC_URL_NOT_SET", message: "SERVICE_PUBLIC_BASE_URL is not set on this Lambda." }
      : portalUrlNotConfiguredBody("This account has no public page address configured yet, so the customer's link can't be built.");

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
      const amount = fromCents(pi.amount_received ?? pi.amount);
      await h.act(ctx, {
        event: EVENTS.PAYMENT_RECORDED, recordType: "servicepayment", recordSfId: paymentId, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? meta.estimateId ?? null,
        details: { invoice: invoice?.Name ?? null, type: kind === "deposit" ? "Deposit" : "Payment", method: "Card", amount, reference: pi.id, paid: settled.summary?.paid ?? null, balance: settled.balance ?? null, invoiceStatus: invoice?.Status__c ?? null, via: "stripe", kind, mode: stripe.config.mode },
      });
      // The office's bell (D-074): money arrived. Keyed on the PaymentIntent, like the row.
      if (h.notifier) {
        const label = [job.Name, job.Customer_Name_at_Creation__c].filter(Boolean).join(" · ");
        const paidOff = invoice && invoice.Status__c === "Paid"; // settleMoney mutates the invoice it settled
        await h.notifier.toOffice({
          tenantId, category: "money", kind: kind === "deposit" ? "deposit_paid" : "invoice_paid",
          title: `${kind === "deposit" ? "Deposit" : "Payment"} received: $${amount.toFixed(2)} on ${label || "a job"}`,
          body: invoice ? `${invoice.Name}${paidOff ? " is paid in full" : settled?.balance != null ? ` · balance $${Number(settled.balance).toFixed(2)}` : ""}` : "Paid online by card",
          url: `/service/jobs/${job.Id}`, recordType: "job", recordSfId: job.Id, dedupeKey: `money:paid:${pi.id}`,
        });
      }
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
    if (h.notifier) {
      await h.notifier.toOffice({
        tenantId, category: "money", kind: "payment_failed",
        title: `Card payment failed: $${(Number(existing.Amount__c) || 0).toFixed(2)}${existing.Service_Job__c ? "" : " (no job)"}`,
        body: String(reason).slice(0, 200),
        url: existing.Service_Job__c ? `/service/jobs/${existing.Service_Job__c}` : "/service/invoices", recordType: existing.Service_Job__c ? "job" : null, recordSfId: existing.Service_Job__c ?? null, dedupeKey: `money:failed:${pi.id}`,
      });
    }
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

  // --- the office's card on file ----------------------------------------------------------
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  /** Money already taken on the job that is not a refund: Succeeded and Pending rows both count (a Pending charge is money in flight). */
  function takenOn(payments) {
    let taken = 0;
    for (const p of payments) {
      if (!["Succeeded", "Pending"].includes(p.Status__c)) continue;
      const a = Number(p.Amount__c) || 0;
      taken += p.Type__c === "Refund" ? -Math.abs(a) : a;
    }
    return round2(taken);
  }
  /**
   * What the customer still owes on the job: the live invoice's balance when there is one,
   * else the estimate's total less what has been taken (a deposit before the bill). With no
   * estimate total there is nothing to charge against.
   */
  async function owedOn({ job, invoice, tenantId }) {
    if (invoice && invoice.Status__c !== "Void") return { owed: money.balanceOf(invoice), basis: "invoice", invoice };
    const est = job.Estimate__c ? await loadEstimateLite(job.Estimate__c, tenantId) : null;
    const total = round2(est?.Total__c);
    const payments = (await money.loadJobPayments(job.Id, tenantId)).filter((p) => !p.Invoice__c);
    return { owed: round2(Math.max(0, total - takenOn(payments))), basis: "estimate", estimate: est, total, taken: takenOn(payments) };
  }
  /** The default card's brand / last four, straight from Stripe — the flag on the job is a hint, this is the fact. */
  async function cardOnFileFor({ ctx, job }) {
    const stripe = await stripeFor(ctx.tenantSlug);
    if (!stripe) return { configured: false, mode: null, cardOnFile: false, card: null, customer: null, stripe: null };
    const customer = job.Sundial_Customer__c ? await loadCustomer(job.Sundial_Customer__c, ctx.tenantId) : null;
    if (!customer?.Stripe_Customer_Id__c) return { configured: true, mode: stripe.config.mode, cardOnFile: false, card: null, customer, stripe };
    let pm = null;
    let card = null;
    try {
      pm = await defaultPaymentMethod(stripe.client, customer.Stripe_Customer_Id__c);
      if (pm) {
        const full = await stripe.client.get(`payment_methods/${encodeURIComponent(pm)}`);
        const c = full?.card || null;
        card = { id: pm, brand: c?.brand ?? null, last4: c?.last4 ?? null, expMonth: c?.exp_month ?? null, expYear: c?.exp_year ?? null };
      }
    } catch (e) {
      console.error("stripe: card lookup failed:", e?.message || e);
      return { configured: true, mode: stripe.config.mode, cardOnFile: false, card: null, customer, stripe, error: e?.message || "Stripe could not be reached." };
    }
    const cardOnFile = !!pm;
    // The job's flag catches up with Stripe (the webhook may not have run, or the card was added from another job).
    if (cardOnFile !== (job.Customer_Card_on_File__c === true)) {
      try {
        await d.sfUpdateRecord(JOB_SF_OBJECT, job.Id, { Customer_Card_on_File__c: cardOnFile });
        job.Customer_Card_on_File__c = cardOnFile;
        await h.markStale(CACHE.job, [job.Id], ctx.tenantId);
      } catch (e) {
        console.error("stripe: card flag write failed:", e?.sfBody || e?.message || e);
      }
    }
    return { configured: true, mode: stripe.config.mode, cardOnFile, card, paymentMethodId: pm, customer, stripe };
  }

  /**
   * Charge the card on file. `amount` is the office's (a deposit, a partial, the balance) and is
   * capped at what is owed; `invoice` is the live invoice when there is one (the row hangs off it
   * and settleMoney moves the bill), else the row is a Deposit on the job. Never throws for a
   * decline — a Failed row with Stripe's words is the answer.
   */
  async function chargeCard({ ctx, job, invoice = null, amount, note = null, kind = "charge" }) {
    const { tenantId } = ctx;
    if (invoice && invoice.Status__c === "Void") return { ok: false, code: "INVOICE_VOID", message: "This invoice is void." };
    if (job.Bill_To_Type__c && job.Bill_To_Type__c !== "Customer") return { ok: false, code: "NOT_CUSTOMER_PAY", message: `This job bills ${job.Bill_To_Name__c || job.Bill_To_Type__c}, not the customer's card.` };
    const wanted = round2(amount);
    if (!(wanted > 0)) return { ok: false, code: "AMOUNT_INVALID", message: "Enter an amount greater than zero." };
    const due = await owedOn({ job, invoice, tenantId });
    if (due.owed <= 0) return { ok: false, code: "NOTHING_DUE", message: due.basis === "invoice" ? "There is no balance on this invoice." : "There is nothing to charge yet — the estimate has no total, or it is already covered." };
    if (wanted > due.owed + 0.005) return { ok: false, code: "AMOUNT_TOO_HIGH", message: `That is more than what is owed ($${due.owed.toFixed(2)}).`, owed: due.owed };
    const cof = await cardOnFileFor({ ctx, job });
    if (!cof.configured) return { ok: false, code: "STRIPE_NOT_CONFIGURED", message: "Stripe isn't set up for this tenant yet (Secrets Manager sundial/stripe)." };
    if (cof.error) return { ok: false, code: "STRIPE_ERROR", message: cof.error };
    if (!cof.cardOnFile) return { ok: false, code: "NO_CARD", message: "There is no card on file for this customer — enter one, or send them the card link." };
    const { stripe, customer, paymentMethodId: pm } = cof;
    // Pending in Sundial first — refuse to double-charge while an earlier charge is still in flight.
    const pending = (await money.loadJobPayments(job.Id, tenantId)).find((p) => (invoice ? p.Invoice__c === invoice.Id : !p.Invoice__c) && p.Status__c === "Pending" && p.Stripe_Payment_Intent_Id__c);
    if (pending) return { ok: false, code: "CHARGE_PENDING", message: `A card charge (${pending.Stripe_Payment_Intent_Id__c}) is still processing on this ${invoice ? "invoice" : "job"}.` };
    const metadata = { tenant: ctx.tenantSlug || "", tenantId, jobId: job.Id, invoiceId: invoice?.Id || "", estimateId: job.Estimate__c || "", customerId: customer.Id, kind };
    const brandName = h.brandFor ? h.brandFor(ctx).companyName || "Sundial" : "Sundial";
    const description = `${invoice ? invoice.Name : `${job.Name} deposit`} — ${brandName}`.slice(0, 200);
    const email = customer.Primary_Email__c || job.Primary_Email_at_Creation__c || null;
    const type = invoice ? "Payment" : "Deposit";
    let pi;
    try {
      pi = await stripe.client.post(
        "payment_intents",
        { amount: toCents(wanted), currency: "usd", customer: customer.Stripe_Customer_Id__c, payment_method: pm, off_session: true, confirm: false, description, metadata, ...(email ? { receipt_email: email } : {}) },
        { idempotencyKey: `charge:${invoice?.Id || job.Id}:${toCents(wanted)}:${d.now().toISOString().slice(0, 16)}` }
      );
    } catch (e) {
      return { ok: false, code: e instanceof StripeError ? e.code || "STRIPE_ERROR" : "STRIPE_ERROR", message: e?.message || "Stripe could not create the charge." };
    }
    const now = d.now().toISOString();
    const who = ctx.actor?.name ? ` by ${ctx.actor.name}` : " by the office";
    const rowFields = { Service_Job__c: job.Id, Invoice__c: invoice?.Id || undefined, Client__c: tenantId, Type__c: type, Method__c: "Card", Amount__c: wanted, Status__c: "Pending", Received_At__c: now, Reference__c: pi.id, Stripe_Payment_Intent_Id__c: pi.id, Recorded_By__c: ctx.userId || undefined, Notes__c: [`Stripe (${stripe.config.mode}) — charged${who}`, note ? String(note).slice(0, 200) : null].filter(Boolean).join(" · ").slice(0, 255) };
    for (const k of Object.keys(rowFields)) if (rowFields[k] === undefined) delete rowFields[k];
    const row = await d.sfCreateRecord(PAYMENT_SF_OBJECT, rowFields);
    await h.markStale(CACHE.payment, [row.id], tenantId);
    const actBase = { event: EVENTS.PAYMENT_RECORDED, recordType: "servicepayment", recordSfId: row.id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null };
    let confirmed;
    try {
      confirmed = await stripe.client.post(`payment_intents/${encodeURIComponent(pi.id)}/confirm`, { off_session: true }, { idempotencyKey: `confirm:${pi.id}` });
    } catch (e) {
      const reason = e instanceof StripeError ? e.message : e?.message || "Payment failed";
      const code = e instanceof StripeError ? e.declineCode || e.code || "STRIPE_ERROR" : "STRIPE_ERROR";
      await d.sfUpdateRecord(PAYMENT_SF_OBJECT, row.id, { Status__c: "Failed", Failure_Reason__c: String(reason).slice(0, 255) });
      await h.markStale(CACHE.payment, [row.id], tenantId);
      await h.act(ctx, { ...actBase, details: { invoice: invoice?.Name ?? null, type, method: "Card", amount: wanted, failed: true, reason, reference: pi.id, note, via: "office-charge" } });
      return { ok: false, code, message: reason, paymentId: row.id, paymentIntentId: pi.id };
    }
    if (confirmed.status === "succeeded") {
      const upd = { Status__c: "Succeeded", Received_At__c: isoFromUnix(confirmed.created, now) };
      const charge = typeof confirmed.latest_charge === "string" ? confirmed.latest_charge : confirmed.latest_charge?.id;
      if (charge) upd.Stripe_Charge_Id__c = charge;
      await d.sfUpdateRecord(PAYMENT_SF_OBJECT, row.id, upd);
      await h.markStale(CACHE.payment, [row.id], tenantId);
      const settled = invoice ? await money.settleMoney({ invoice, job, tenantId, ctx }) : await money.settleJobWithoutInvoice({ job, tenantId });
      await h.act(ctx, { ...actBase, details: { invoice: invoice?.Name ?? null, type, method: "Card", amount: wanted, reference: pi.id, note, paid: settled.summary?.paid ?? null, balance: settled.balance ?? null, invoiceStatus: invoice?.Status__c ?? null, via: "office-charge", mode: stripe.config.mode } });
      return { ok: true, status: "succeeded", paymentId: row.id, paymentIntentId: pi.id, amount: wanted, type, settled };
    }
    // processing / requires_action: the webhook finishes it.
    return { ok: true, status: confirmed.status, pending: true, paymentId: row.id, paymentIntentId: pi.id, amount: wanted, type };
  }

  /** The office's charge of an invoice's whole balance (issue-time tick, the invoice card's button). */
  async function chargeInvoice({ ctx, invoice, job }) {
    if (invoice.Status__c === "Void") return { ok: false, code: "INVOICE_VOID", message: "This invoice is void." };
    const balance = money.balanceOf(invoice);
    if (balance <= 0) return { ok: false, code: "NOTHING_DUE", message: "There is no balance on this invoice." };
    return chargeCard({ ctx, job, invoice, amount: balance, kind: "charge" });
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

  const chargeStatusFor = (code) => (["NOTHING_DUE", "INVOICE_VOID", "NOT_CUSTOMER_PAY", "CHARGE_PENDING", "AMOUNT_TOO_HIGH"].includes(code) ? 409 : ["NO_CARD", "STRIPE_NOT_CONFIGURED", "AMOUNT_INVALID"].includes(code) ? 400 : 402);
  /** The customer's page for this job's estimate — where a card is added or a bill paid (money.customerLinkFor mints the token). */
  const customerLinkFor = async (job, tenantId, ctx) => ({ ...(await money.customerLinkFor(job, tenantId, ctx)), estimate: job.Estimate__c ? { Id: job.Estimate__c } : null });
  const cardView = (cof) => ({ configured: cof.configured, mode: cof.mode, cardOnFile: cof.cardOnFile, card: cof.card ? { brand: cof.card.brand, last4: cof.card.last4, expMonth: cof.card.expMonth, expYear: cof.card.expYear } : null, stripeError: cof.error ?? null });

  return {
    chargeInvoice,
    chargeCard,
    cardOnFileFor,
    applyDeferred,

    /** GET /service/jobs/{id}/card — the card on file (from Stripe) and what is owed. */
    async jobCard({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const job = await money.loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const cof = await cardOnFileFor({ ctx, job });
      const invoice = (await money.loadJobInvoices(job.Id, tenantId)).find((i) => i.Status__c !== "Void") ?? null;
      const due = await owedOn({ job, invoice, tenantId });
      const link = await customerLinkFor(job, tenantId, ctx).catch(() => ({ url: null }));
      return jsonResponse(200, cors, {
        jobId: job.Id,
        ...cardView(cof),
        billToType: job.Bill_To_Type__c || "Customer",
        customerPays: !job.Bill_To_Type__c || job.Bill_To_Type__c === "Customer",
        owed: due.owed,
        owedBasis: due.basis,
        invoice: invoice ? { id: invoice.Id, number: invoice.Name, status: invoice.Status__c, balance: money.balanceOf(invoice) } : null,
        estimateTotal: due.total ?? null,
        customerUrl: link.url,
        customerEmail: cof.customer?.Primary_Email__c ?? job.Primary_Email_at_Creation__c ?? null,
        customerPhone: cof.customer?.Primary_Phone__c ?? job.Primary_Phone_at_Creation__c ?? null,
      });
    },

    /** POST /service/jobs/{id}/card-session — Stripe's hosted card page for the office (Checkout, setup mode). */
    async jobCardSession({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const job = await money.loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      if (job.Bill_To_Type__c && job.Bill_To_Type__c !== "Customer") return jsonResponse(409, cors, { error: "not_applicable", code: "NOT_CUSTOMER_PAY", message: `This job bills ${job.Bill_To_Name__c || job.Bill_To_Type__c} — there is no customer card to keep.` });
      const stripe = await stripeFor(ctx.tenantSlug);
      if (!stripe) return jsonResponse(503, cors, { error: "not_configured", code: "STRIPE_NOT_CONFIGURED", message: "Stripe isn't set up for this tenant yet (Secrets Manager sundial/stripe)." });
      // The tenant's own customer-page address (D-078) — Stripe sends the office back there.
      const base = String(h.portalBaseUrl?.(ctx) || "").replace(/\/+$/, "");
      if (!base) return jsonResponse(503, cors, noPublicUrl(ctx));
      const customer = job.Sundial_Customer__c ? await loadCustomer(job.Sundial_Customer__c, tenantId) : null;
      if (!customer) return jsonResponse(409, cors, { error: "no_customer", code: "NO_CUSTOMER", message: "This job has no customer record to keep a card for." });
      let stripeCustomerId = customer.Stripe_Customer_Id__c || null;
      try {
        const ensured = await ensureStripeCustomer(stripe.client, {
          existingId: stripeCustomerId,
          name: customer.Name || job.Customer_Name_at_Creation__c || undefined,
          email: customer.Primary_Email__c || job.Primary_Email_at_Creation__c || undefined,
          phone: customer.Primary_Phone__c || undefined,
          metadata: { tenant: ctx.tenantSlug || "", sundialCustomerId: customer.Id, source: "sundial" },
        });
        if (ensured !== stripeCustomerId) {
          await d.sfUpdateRecord(CUSTOMER_SF_OBJECT, customer.Id, { Stripe_Customer_Id__c: ensured });
          await h.markStale(CACHE.customer, [customer.Id], tenantId);
        }
        stripeCustomerId = ensured;
      } catch (e) {
        return jsonResponse(502, cors, { error: "stripe_error", code: "STRIPE_ERROR", message: e?.message || "Stripe could not be reached." });
      }
      const page = `${base}/service/jobs/${encodeURIComponent(job.Id)}`;
      const metadata = { tenant: ctx.tenantSlug || "", tenantId, estimateId: job.Estimate__c || "", jobId: job.Id, customerId: customer.Id, invoiceId: "", kind: "office_setup", by: ctx.userId || "" };
      let session;
      try {
        session = await stripe.client.post(
          "checkout/sessions",
          { mode: "setup", customer: stripeCustomerId, payment_method_types: ["card"], success_url: `${page}?card=saved`, cancel_url: `${page}?card=cancel`, client_reference_id: job.Id, metadata, setup_intent_data: { metadata } },
          { idempotencyKey: `office-setup:${job.Id}:${d.now().toISOString().slice(0, 16)}` }
        );
      } catch (e) {
        return jsonResponse(502, cors, { error: "stripe_error", code: "STRIPE_ERROR", message: e instanceof StripeError ? e.message : e?.message || "Stripe could not start the card page." });
      }
      await h.act(ctx, { event: EVENTS.JOB_UPDATED, recordType: "job", recordSfId: job.Id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null, details: { cardSession: session.id ?? null, via: "office", mode: stripe.config.mode } });
      return jsonResponse(200, cors, { url: session.url, mode: stripe.config.mode });
    },

    /** POST /service/jobs/{id}/card-link { via: "sms"|"email", to? } — the customer adds the card themselves. */
    async jobCardLink({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const job = await money.loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      if (job.Bill_To_Type__c && job.Bill_To_Type__c !== "Customer") return jsonResponse(409, cors, { error: "not_applicable", code: "NOT_CUSTOMER_PAY", message: `This job bills ${job.Bill_To_Name__c || job.Bill_To_Type__c}.` });
      const via = body?.via === "email" ? "email" : "sms";
      const link = await customerLinkFor(job, tenantId, ctx);
      if (!link.url) {
        if (!job.Estimate__c) return jsonResponse(409, cors, { error: "no_link", code: "NO_ESTIMATE_LINK", message: "This job has no estimate to link to." });
        const why = noPublicUrl(ctx); // the primary tenant keeps its old code; another tenant is told its address is missing
        return jsonResponse(409, cors, { error: "no_link", code: isPrimaryTenant(ctx.tenantSlug) ? "NO_ESTIMATE_LINK" : why.code, message: why.message });
      }
      const brand = h.brandFor ? h.brandFor(ctx).companyName || "" : "";
      const first = (job.Customer_Name_at_Creation__c || "").split(" ")[0] || "there";
      const text = `Hi ${first}, ${brand ? `${brand} here. ` : ""}To keep a card on file for ${job.Name}, open this secure link and choose "Keep a card on file": ${link.url}`;
      if (via === "sms") {
        if (!d.sms) return jsonResponse(503, cors, { error: "not_configured", code: "SMS_NOT_WIRED", message: "Texting is not wired on this Lambda." });
        const r = await d.sms.sendText({ tenantId, tenantSlug: ctx.tenantSlug, job, to: body?.to ? String(body.to) : null, body: text, sentBy: { id: ctx.userId ?? null, name: ctx.actor?.name ?? null } });
        if (!r.ok) return jsonResponse(r.code === "NO_PHONE" ? 409 : 502, cors, { error: "send_failed", code: r.code || "SMS_FAILED", message: r.code === "NO_PHONE" ? "No mobile number on this job — enter one." : r.error || "The text could not be sent." });
        await h.act(ctx, { event: EVENTS.JOB_UPDATED, recordType: "job", recordSfId: job.Id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null, details: { cardLink: "sms", to: r.to ?? null, via: "office" } });
        return jsonResponse(200, cors, { success: true, via, to: r.to ?? null, url: link.url });
      }
      if (!d.isEmailConfigured || !d.isEmailConfigured()) return jsonResponse(503, cors, { error: "not_configured", code: "EMAIL_NOT_WIRED", message: "Email is not wired on this Lambda." });
      const customer = job.Sundial_Customer__c ? await loadCustomer(job.Sundial_Customer__c, tenantId) : null;
      const to = (body?.to ? String(body.to).trim() : "") || customer?.Primary_Email__c || job.Primary_Email_at_Creation__c || null;
      if (!to) return jsonResponse(409, cors, { error: "no_email", code: "NO_EMAIL", message: "The customer has no email address on file — enter one." });
      const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
      const subject = `Keep a card on file for ${job.Name}${brand ? ` — ${brand}` : ""}`;
      const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;max-width:560px"><p>Hi ${esc(first)},</p><p>${esc(brand ? `${brand} keeps a card on file so we can bill your service work when it is done.` : "We keep a card on file so we can bill your service work when it is done.")} Open the secure link below and choose <strong>Keep a card on file</strong>. Your card details go straight to Stripe — we never see the number.</p><p><a href="${esc(link.url)}" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Keep a card on file</a></p><p style="color:#52525b">Or copy this link: ${esc(link.url)}</p><p style="color:#52525b">Questions? Just reply to this email.</p></div>`;
      const sent = await d.sendEmail({ to, subject, html, text });
      if (!sent.ok) return jsonResponse(502, cors, { error: "send_failed", code: "EMAIL_FAILED", message: `Email failed: ${sent.error}` });
      await h.act(ctx, { event: EVENTS.JOB_UPDATED, recordType: "job", recordSfId: job.Id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null, details: { cardLink: "email", to, via: "office" } });
      return jsonResponse(200, cors, { success: true, via, to, url: link.url });
    },

    /** POST /service/jobs/{id}/charge { amount, note? } — Admin / Executive: charge the card on file for any amount owed. */
    async jobCharge({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const job = await money.loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const amount = Number(body?.amount);
      if (!Number.isFinite(amount) || amount <= 0) return bad(cors, "AMOUNT_INVALID", "Enter an amount greater than zero.");
      const invoice = (await money.loadJobInvoices(job.Id, tenantId)).find((i) => i.Status__c !== "Void") ?? null;
      const note = body?.note ? String(body.note).trim().slice(0, 200) : null;
      const r = await chargeCard({ ctx, job, invoice, amount, note, kind: invoice ? "charge" : "deposit" });
      if (!r.ok) return jsonResponse(chargeStatusFor(r.code), cors, { error: "charge_failed", ...r });
      const payments = await money.loadJobPayments(job.Id, tenantId);
      return jsonResponse(200, cors, { success: true, ...r, settled: undefined, invoice: invoice ? { id: invoice.Id, number: invoice.Name, status: invoice.Status__c, balance: money.balanceOf(invoice) } : null, payments, jobStatus: job.Status__c, paymentStatus: job.Payment_Status__c });
    },

    /** POST /service/invoices/{id}/charge — the office charges the card on file. */
    async chargeInvoiceRoute({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const invoice = await money.loadInvoice(params[0], tenantId);
      if (!invoice) return notFound(cors);
      const job = await money.loadJob(invoice.Service_Job__c, tenantId);
      if (!job) return notFound(cors);
      const r = await chargeInvoice({ ctx, invoice, job });
      if (!r.ok) return jsonResponse(chargeStatusFor(r.code), cors, { error: "charge_failed", ...r });
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
      const base = { id: evt.id, client_sf_id: tenantId, tenant_id: slug, type: evt.type, kind: meta.kind || null, mode: stripe.config.mode, estimate_sf_id: meta.estimateId || null, job_sf_id: meta.jobId || null, invoice_sf_id: meta.invoiceId || null, payment_intent_id: obj.object === "payment_intent" ? obj.id : typeof obj.payment_intent === "string" ? obj.payment_intent : null, amount: obj.amount_received != null ? fromCents(obj.amount_received) : obj.amount_paid != null ? fromCents(obj.amount_paid) : obj.amount_total != null ? fromCents(obj.amount_total) : obj.amount != null ? fromCents(obj.amount) : null, payload: obj, received_at: d.now().toISOString() };
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
        // The Service Club's events first (a subscription checkout, subscription and
        // subscription-invoice events); null means "not the club's", so payments handle it.
        const club = h.club ? await h.club.applyEvent({ stripe, tenantId, slug, evt, cors }) : null;
        if (club) result = club;
        else if (evt.type === "checkout.session.completed") result = await applyCheckoutCompleted({ stripe, tenantId, slug, session: obj, cors });
        else if (evt.type === "payment_intent.succeeded") result = await applyIntentSucceeded({ stripe, tenantId, slug, pi: obj, cors });
        else if (evt.type === "payment_intent.payment_failed") result = await applyIntentFailed({ tenantId, slug, pi: obj, cors });
        else if (evt.type === "charge.refunded") result = await applyChargeRefunded({ stripe, tenantId, slug, charge: obj, cors });
        else result = { status: "ignored", reason: `unhandled event type ${evt.type}` };
      } catch (e) {
        console.error(`stripe webhook ${evt.type} (${evt.id}) failed:`, e?.sfBody || e?.message || e);
        await ledgerPut({ ...base, status: "error", error: String(e?.sfBody || e?.message || e).slice(0, 500) });
        return jsonResponse(500, cors, { error: "apply_failed", code: "STRIPE_APPLY_FAILED" }); // Stripe retries
      }
      await ledgerPut({ ...base, status: result.status, error: result.reason || null, job_sf_id: result.jobId || base.job_sf_id, invoice_sf_id: result.invoiceId || base.invoice_sf_id, payment_sf_id: result.paymentId || null, membership_sf_id: result.membershipId || meta.membershipId || null, applied_at: result.status === "applied" ? d.now().toISOString() : null });
      return jsonResponse(200, cors, { received: true, ...result });
    },
  };
}
