// club.js — the Service Club (D-073, 2026-09-18): the plan catalog, memberships sold
// through Stripe subscriptions from Sundial's own public pages, mirrored to Salesforce
// by the same signed webhook that carries payments, plan discounts on estimates, and the
// office's view of it all.
//
//   PUBLIC (no login; the tenant slug is in the URL, like the Stripe webhook)
//   GET  /public/club/{tenant}/plans            the catalog the page renders
//   POST /public/club/{tenant}/join             { planCode, interval, customer } → { url }  Stripe Checkout (subscription)
//   POST /public/club/{tenant}/truck-roll       { customer, issue }              → { url }  an approved estimate + job, paid as the deposit
//   POST /public/club/{tenant}/request          { customer, message }            → { jobNumber }  "call me"
//   POST /public/club/{tenant}/manage           { email }                        → 200 always; emails a Stripe customer-portal link
//   GET  /public/club/{tenant}/joined?session=  what the success page may show
//
//   OFFICE (service.club.read / service.club.write)
//   GET  /service/club/plans · PATCH /service/club/plans/{id}
//   GET  /service/club/memberships?status=&q= · GET /service/club/report · GET /service/club/customers/{id}
//   POST /service/club/memberships              { customerId, planCode, interval, source, email? } → a join link
//   POST /service/club/memberships/{id}/cancel  { reason, immediately }
//   POST /service/club/memberships/{id}/solarfacts   resend the hand-off
//   POST /service/estimates/{id}/apply-plan-discount
//
// Rules the code holds, never bypass them:
//   - A membership is only ever BORN from our own join (Pending). A subscription event that
//     names no membership we know is `ignored` in the ledger, never a create.
//   - Stripe_Subscription_Id__c is the idempotency key for subscription events; the checkout
//     session id for the join's completion. Look before you write.
//   - Sundial_Customer__c.Active_Membership__c points at the one live row (Active / Past Due)
//     and is cleared when it ends — every reader (customer hub, estimate, job) uses it.
//   - Money moves only in Stripe: cancel goes through Stripe and the webhook confirms; the
//     office never types a card (the join link is how Ben migrates the existing members).
//   - Nothing about a tenant's plans, hooks or addresses is in this code: plans are rows,
//     the SolarFax credentials + team email are Secrets Manager sundial/service-club per tenant.
//   - SolarFax (lib/solarfacts.js): on activation the member is created there and sent the
//     connect-your-utility invite; when the membership ends they are disconnected. Both are
//     POST /users on their API. A tenant with only a Zapier catch hook still gets the old
//     JSON payload; a tenant with neither is stamped Not Applicable.

import { soqlEscapeString } from "../../lib/salesforce.js";
import { EVENTS } from "../../lib/service-activity.js";
import { getSecret as realGetSecret } from "../../lib/secrets.js";
import { ensureStripeCustomer, fromCents, stripeForTenant, toCents, StripeError } from "../../lib/stripe.js";
import { createSolarFactsClient, solarFactsConfigFor, splitName } from "../../lib/solarfacts.js";
import { candidateSoql, matchCandidates, normalizeNewCustomer, CANDIDATE_SELECT, CUSTOMER_SF_OBJECT } from "./customer.js";
import { ESTIMATE_SF_OBJECT, JOB_SF_OBJECT } from "./fields.js";
import { ITEM_SELECT, ITEM_SF_OBJECT } from "./pricebook.js";
import { computeTotals, lineFromRecord, estimateFromRecord } from "./totals.js";

export const PLAN_SF_OBJECT = "Sundial_Service_Plan__c";
export const MEMBERSHIP_SF_OBJECT = "Sundial_Membership__c";
export const TENANT_SF_OBJECT = "Sundial_Tenant__c";
export const CLUB_SECRET_NAME = "sundial/service-club";
export const CLUB_CACHE = Object.freeze({ plan: "sundial_service_plan_cache", membership: "sundial_membership_cache" });
/** Subscription events the Stripe endpoint must also be subscribed to (docs/integrations/service-club.md). */
export const CLUB_EVENT_TYPES = Object.freeze(["customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"]);
export const INTERVALS = Object.freeze({ monthly: "Monthly", yearly: "Yearly" });

export const PLAN_SELECT =
  "Id, Name, Client__c, Plan_Code__c, Kind__c, Availability__c, Sort_Order__c, Highlight__c, Tagline__c, Features__c, " +
  "Monthly_Price__c, Yearly_Price__c, Price__c, Price_Book_Item_Code__c, Stripe_Product_Id__c, Stripe_Monthly_Price_Id__c, " +
  "Stripe_Yearly_Price_Id__c, Discount_Scope__c, Discount_Type__c, Discount_Value__c, Discount_Description__c, " +
  "Includes_Tune_Up__c, Includes_Cleaning__c, Notes__c, CreatedDate";
export const MEMBERSHIP_SELECT =
  "Id, Name, Client__c, Sundial_Customer__c, Service_Plan__c, Customer_Name_at_Creation__c, Address_at_Creation__c, " +
  "Primary_Phone_at_Creation__c, Primary_Email_at_Creation__c, Status__c, Billing_Interval__c, Price__c, Source__c, " +
  "Stripe_Subscription_Id__c, Stripe_Checkout_Session_Id__c, Stripe_Customer_Id__c, Started_At__c, Current_Period_End__c, " +
  "Cancel_At_Period_End__c, Cancelled_At__c, Ended_At__c, Cancel_Reason__c, Last_Payment_At__c, Last_Payment_Amount__c, " +
  "Lifetime_Revenue__c, Payment_Failures__c, SolarFacts_Status__c, SolarFacts_Last_Sent_At__c, SolarFacts_Last_Error__c, " +
  "SolarFacts_Account_Id__c, SolarFacts_User_Id__c, Notes__c, CreatedDate";
const CUSTOMER_SELECT = `${CANDIDATE_SELECT}, Client__c, Stripe_Customer_Id__c, Active_Membership__c`;
const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;
const LIVE_STATUSES = new Set(["Active", "Past Due"]);
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const strOrNull = (v) => (v == null ? null : String(v).trim() === "" ? null : String(v).trim());
const isoFromUnix = (s, fallback = null) => (Number.isFinite(Number(s)) && Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : fallback);
const idOf = (v) => (typeof v === "string" ? v : v?.id ?? null);

// ---------------------------------------------------------------------------
// Pure helpers (tested directly)
// ---------------------------------------------------------------------------

/**
 * The per-tenant club config from the secret:
 *   { solarFacts: { apiKey, accessToken, inviteTemplate, baseUrl?, test? } | null,   ← SolarFax's API (lib/solarfacts.js)
 *     solarFactsHookUrl, solarFactsCancelHookUrl,                                    ← the older Zapier catch hook, if any
 *     teamEmail }
 * or null when the tenant has no entry.
 */
export function clubConfigFor(secret, tenantSlug) {
  if (!secret || typeof secret !== "object") return null;
  const t = secret.tenants?.[tenantSlug] || (secret.tenants ? null : secret);
  if (!t || typeof t !== "object") return null;
  return {
    solarFacts: solarFactsConfigFor(t),
    solarFactsHookUrl: strOrNull(t.solarFactsHookUrl),
    solarFactsCancelHookUrl: strOrNull(t.solarFactsCancelHookUrl) || strOrNull(t.solarFactsHookUrl),
    teamEmail: strOrNull(t.teamEmail),
  };
}

/** A plan row as the public page and the office see it. */
export function planToView(p) {
  const features = String(p.Features__c || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const kind = p.Kind__c === "One-time" ? "one-time" : "subscription";
  return {
    id: p.Id,
    code: p.Plan_Code__c,
    name: p.Name,
    kind,
    availability: p.Availability__c || "Available",
    purchasable: (p.Availability__c || "Available") === "Available",
    sortOrder: Number(p.Sort_Order__c) || 0,
    highlight: p.Highlight__c || null,
    tagline: p.Tagline__c || null,
    features,
    monthly: kind === "subscription" ? (p.Monthly_Price__c != null ? money(p.Monthly_Price__c) : null) : null,
    yearly: kind === "subscription" ? (p.Yearly_Price__c != null ? money(p.Yearly_Price__c) : null) : null,
    price: kind === "one-time" ? (p.Price__c != null ? money(p.Price__c) : null) : null,
    discount: p.Discount_Value__c ? { scope: p.Discount_Scope__c || "Labor", type: p.Discount_Type__c || "Percent", value: money(p.Discount_Value__c), description: p.Discount_Description__c || null } : null,
    includes: { tuneUp: p.Includes_Tune_Up__c === true, cleaning: p.Includes_Cleaning__c === true },
    stripe: { productId: p.Stripe_Product_Id__c || null, monthlyPriceId: p.Stripe_Monthly_Price_Id__c || null, yearlyPriceId: p.Stripe_Yearly_Price_Id__c || null },
    priceBookItemCode: p.Price_Book_Item_Code__c || null,
    notes: p.Notes__c || null,
  };
}

/** What the public page gets: purchasable-or-coming-soon rows, sorted, with no office-only detail. */
export function publicPlans(rows) {
  return (rows || [])
    .filter((p) => ["Available", "Coming Soon"].includes(p.Availability__c || "Available"))
    .sort((a, b) => (Number(a.Sort_Order__c) || 0) - (Number(b.Sort_Order__c) || 0))
    .map((p) => {
      const v = planToView(p);
      return { code: v.code, name: v.name, kind: v.kind, availability: v.availability, purchasable: v.purchasable, highlight: v.highlight, tagline: v.tagline, features: v.features, monthly: v.monthly, yearly: v.yearly, price: v.price, discountDescription: v.discount?.description ?? null, includes: v.includes };
    });
}

export function membershipToView(m, plan) {
  return {
    id: m.Id,
    number: m.Name ?? null,
    status: m.Status__c ?? null,
    customerId: m.Sundial_Customer__c ?? null,
    customerName: m.Customer_Name_at_Creation__c ?? null,
    email: m.Primary_Email_at_Creation__c ?? null,
    phone: m.Primary_Phone_at_Creation__c ?? null,
    address: m.Address_at_Creation__c ?? null,
    plan: plan ? { id: plan.Id, code: plan.Plan_Code__c, name: plan.Name, discountDescription: plan.Discount_Description__c || null } : { id: m.Service_Plan__c ?? null, code: null, name: null, discountDescription: null },
    interval: m.Billing_Interval__c ?? null,
    price: m.Price__c != null ? money(m.Price__c) : null,
    source: m.Source__c ?? null,
    startedAt: m.Started_At__c ?? null,
    currentPeriodEnd: m.Current_Period_End__c ?? null,
    cancelAtPeriodEnd: m.Cancel_At_Period_End__c === true,
    cancelledAt: m.Cancelled_At__c ?? null,
    endedAt: m.Ended_At__c ?? null,
    cancelReason: m.Cancel_Reason__c ?? null,
    lastPaymentAt: m.Last_Payment_At__c ?? null,
    lastPaymentAmount: m.Last_Payment_Amount__c != null ? money(m.Last_Payment_Amount__c) : null,
    lifetimeRevenue: money(m.Lifetime_Revenue__c),
    paymentFailures: Number(m.Payment_Failures__c) || 0,
    solarFacts: { status: m.SolarFacts_Status__c || "Not Sent", lastSentAt: m.SolarFacts_Last_Sent_At__c ?? null, lastError: m.SolarFacts_Last_Error__c ?? null, accountId: m.SolarFacts_Account_Id__c ?? null, userId: m.SolarFacts_User_Id__c ?? null },
    stripeSubscriptionId: m.Stripe_Subscription_Id__c ?? null,
    notes: m.Notes__c ?? null,
    createdAt: m.CreatedDate ?? null,
  };
}

/** Stripe's subscription status → ours (+ the dates), for updated/deleted events. */
export function statusFromSubscription(sub) {
  const s = sub?.status;
  let status;
  if (s === "active" || s === "trialing") status = "Active";
  else if (s === "past_due" || s === "unpaid" || s === "paused") status = "Past Due";
  else if (s === "canceled" || s === "incomplete_expired") status = "Cancelled";
  else if (s === "incomplete") status = "Pending";
  else status = "Active";
  return {
    status,
    cancelAtPeriodEnd: sub?.cancel_at_period_end === true,
    currentPeriodEnd: isoFromUnix(sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end),
    endedAt: isoFromUnix(sub?.ended_at ?? sub?.canceled_at),
    canceledAt: isoFromUnix(sub?.canceled_at),
  };
}

/** Monthly-equivalent revenue of one row (for MRR). */
export function monthlyEquivalent(price, interval) {
  const p = Number(price) || 0;
  return money(interval === "Yearly" ? p / 12 : interval === "Monthly" ? p : 0);
}

/** The plans report: counts by status, by plan × status, MRR of the live rows. */
export function summarizeMemberships(rows, plans = []) {
  const byStatus = {};
  const byPlan = {};
  let mrr = 0;
  const planName = new Map(plans.map((p) => [p.Id, p.Name]));
  for (const m of rows || []) {
    const st = m.Status__c || "Pending";
    byStatus[st] = (byStatus[st] || 0) + 1;
    const key = m.Service_Plan__c || "?";
    if (!byPlan[key]) byPlan[key] = { planId: key, plan: planName.get(key) || null, total: 0 };
    byPlan[key].total += 1;
    byPlan[key][st] = (byPlan[key][st] || 0) + 1;
    if (LIVE_STATUSES.has(st)) mrr += monthlyEquivalent(m.Price__c, m.Billing_Interval__c);
  }
  return { total: (rows || []).length, active: (byStatus.Active || 0) + (byStatus["Past Due"] || 0), byStatus, byPlan: Object.values(byPlan), mrr: money(mrr) };
}

/** What SolarFacts' Zapier hook receives. Same shape for start and end; `event` says which. */
export function solarFactsPayload(m, plan, event, { tenant, at }) {
  return {
    event,
    tenant,
    at,
    membershipNumber: m.Name ?? null,
    membershipId: m.Id,
    status: m.Status__c ?? null,
    plan: plan ? { code: plan.Plan_Code__c, name: plan.Name } : null,
    interval: m.Billing_Interval__c ?? null,
    price: m.Price__c != null ? money(m.Price__c) : null,
    startedAt: m.Started_At__c ?? null,
    endedAt: m.Ended_At__c ?? null,
    customer: { id: m.Sundial_Customer__c ?? null, name: m.Customer_Name_at_Creation__c ?? null, email: m.Primary_Email_at_Creation__c ?? null, phone: m.Primary_Phone_at_Creation__c ?? null, address: m.Address_at_Creation__c ?? null },
  };
}

/** The join form → a clean spec, or the problems. */
export function normalizeJoin(body) {
  const problems = [];
  const planCode = strOrNull(body?.planCode)?.toLowerCase() ?? null;
  const intervalKey = strOrNull(body?.interval)?.toLowerCase() ?? "monthly";
  if (!planCode) problems.push("planCode is required");
  if (!INTERVALS[intervalKey]) problems.push("interval must be monthly or yearly");
  const cust = normalizeNewCustomer(body?.customer);
  if (!cust.ok) problems.push(`customer: ${cust.missing.join(", ")}`);
  const notes = strOrNull(body?.notes)?.slice(0, 255) ?? null;
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { planCode, interval: INTERVALS[intervalKey], customer: cust.value, notes } };
}

/** Plan → the estimate discount fields a member's estimate gets (null = the plan carries none). */
export function planDiscountFields(plan, membershipId) {
  const v = Number(plan?.Discount_Value__c) || 0;
  if (!plan || v <= 0) return null;
  return { Discount_Scope__c: plan.Discount_Scope__c || "Labor", Discount_Type__c: plan.Discount_Type__c || "Percent", Discount_Value__c: v, Discount_Source__c: "Service Plan", ...(membershipId ? { Membership__c: membershipId } : {}) };
}

/**
 * Make the Stripe Product + recurring Prices agree with a plan row. Returns the plan
 * fields to write back (empty when nothing changed). Shared by the seed script and the
 * office's PATCH; a changed amount = a new Price + the old one archived.
 */
export async function syncPlanPrices(stripe, plan, { tenant, log = () => {} } = {}) {
  if (plan.Kind__c !== "Subscription") return {};
  const out = {};
  let productId = plan.Stripe_Product_Id__c || null;
  if (productId) {
    try {
      const prod = await stripe.get(`products/${encodeURIComponent(productId)}`);
      if (!prod?.id || prod.deleted) productId = null;
    } catch (e) {
      if (e?.status === 404) productId = null;
      else throw e;
    }
  }
  if (!productId) {
    const prod = await stripe.post("products", { name: `${plan.Name} — Service Club`, description: plan.Tagline__c || undefined, metadata: { tenant, planCode: plan.Plan_Code__c, sundialPlanId: plan.Id } });
    productId = prod.id;
    out.Stripe_Product_Id__c = productId;
    log(`Stripe product ${productId}`);
  }
  for (const [interval, amount, field] of [["month", plan.Monthly_Price__c, "Stripe_Monthly_Price_Id__c"], ["year", plan.Yearly_Price__c, "Stripe_Yearly_Price_Id__c"]]) {
    if (amount == null || Number(amount) <= 0) continue;
    let current = null;
    if (plan[field]) {
      try {
        current = await stripe.get(`prices/${encodeURIComponent(plan[field])}`);
      } catch (e) {
        if (e?.status !== 404) throw e;
      }
    }
    const matches = current && current.active && current.unit_amount === toCents(amount) && current.recurring?.interval === interval && current.product === productId;
    if (matches) continue;
    const created = await stripe.post("prices", { product: productId, currency: "usd", unit_amount: toCents(amount), recurring: { interval }, nickname: `${plan.Name} ${interval}ly`, metadata: { tenant, planCode: plan.Plan_Code__c, interval } });
    if (current && current.active) {
      await stripe.post(`prices/${encodeURIComponent(current.id)}`, { active: false });
      log(`archived old ${interval} price ${current.id}`);
    }
    out[field] = created.id;
    log(`Stripe ${interval} price ${created.id} ($${amount})`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------
/**
 * @param d  the estimate Lambda's deps (sfQuery, sfCreateRecord, sfUpdateRecord, getSupabaseClient,
 *           getSecret, fetchUrl, sendEmail, isEmailConfigured, now, publicBaseUrl, brandName)
 * @param h  { resolveCustomer, createEstimateRecord, createJobRecord, addLinesToEstimate, loadEstimate,
 *             loadLines, recomputeAndStore, act, markStale, flushEvents, linkEstimateActivityToJob,
 *             CACHE, jsonResponse, bad, notFound, sfError, brandFor }
 */
export function createClubHandlers(d, h) {
  const { jsonResponse, bad, notFound, sfError, CACHE } = h;
  const getSecret = d.getSecret || realGetSecret;
  const stripeFor = (slug) => stripeForTenant(slug, { getSecret, ...(d.fetchUrl ? { fetchUrl: d.fetchUrl } : {}) });
  const fetchUrl = d.fetchUrl || ((url, init) => fetch(url, { signal: AbortSignal.timeout(10000), ...init }));

  async function clubConfig(slug) {
    try {
      return clubConfigFor(await getSecret(CLUB_SECRET_NAME), slug);
    } catch (e) {
      if (!/ResourceNotFound/i.test(e?.name || e?.message || "")) console.error("club secret:", e?.message || e);
      return null;
    }
  }

  // --- loaders (all tenant-scoped) ------------------------------------------------
  async function tenantIdFor(slug) {
    if (!slug || !/^[a-z0-9-]{1,40}$/i.test(slug)) return null;
    const rows = await d.sfQuery(`SELECT Id, Name FROM ${TENANT_SF_OBJECT} WHERE Name = '${soqlEscapeString(slug)}' LIMIT 1`);
    return rows?.[0]?.Id ?? null;
  }
  async function loadPlans(tenantId) {
    return (await d.sfQuery(`SELECT ${PLAN_SELECT} FROM ${PLAN_SF_OBJECT} WHERE Client__c = '${soqlEscapeString(tenantId)}' ORDER BY Sort_Order__c NULLS LAST, Name LIMIT 200`)) || [];
  }
  async function loadPlan(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(`SELECT ${PLAN_SELECT} FROM ${PLAN_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
    return rows?.[0] ?? null;
  }
  async function loadPlanByCode(code, tenantId) {
    if (!code) return null;
    const rows = await d.sfQuery(`SELECT ${PLAN_SELECT} FROM ${PLAN_SF_OBJECT} WHERE Plan_Code__c = '${soqlEscapeString(code)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
    return rows?.[0] ?? null;
  }
  async function loadMembership(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(`SELECT ${MEMBERSHIP_SELECT} FROM ${MEMBERSHIP_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
    return rows?.[0] ?? null;
  }
  async function loadMembershipBy(field, value, tenantId) {
    if (!value) return null;
    const rows = await d.sfQuery(`SELECT ${MEMBERSHIP_SELECT} FROM ${MEMBERSHIP_SF_OBJECT} WHERE ${field} = '${soqlEscapeString(value)}' AND Client__c = '${soqlEscapeString(tenantId)}' ORDER BY CreatedDate DESC LIMIT 1`);
    return rows?.[0] ?? null;
  }
  async function loadCustomerMemberships(customerId, tenantId) {
    if (!SF_ID_RE.test(customerId || "")) return [];
    return (await d.sfQuery(`SELECT ${MEMBERSHIP_SELECT} FROM ${MEMBERSHIP_SF_OBJECT} WHERE Sundial_Customer__c = '${soqlEscapeString(customerId)}' AND Client__c = '${soqlEscapeString(tenantId)}' ORDER BY CreatedDate DESC LIMIT 50`)) || [];
  }
  async function loadCustomer(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(`SELECT ${CUSTOMER_SELECT} FROM ${CUSTOMER_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
    return rows?.[0] ?? null;
  }
  /** The customer's live membership + its plan, through the hub's pointer (one hop). */
  async function activeMembershipFor(customerId, tenantId) {
    const customer = await loadCustomer(customerId, tenantId);
    if (!customer?.Active_Membership__c) return { customer, membership: null, plan: null };
    const membership = await loadMembership(customer.Active_Membership__c, tenantId);
    if (!membership || !LIVE_STATUSES.has(membership.Status__c)) return { customer, membership: null, plan: null };
    const plan = await loadPlan(membership.Service_Plan__c, tenantId);
    return { customer, membership, plan };
  }
  const snapshot = (c) => ({
    Customer_Name_at_Creation__c: c.Name ?? [c.First_Name__c, c.Last_Name__c].filter(Boolean).join(" ") ?? null,
    Address_at_Creation__c: [c.Street__c, c.City__c, c.State__c, c.Postal_Code__c].filter(Boolean).join(", ") || null,
    Primary_Phone_at_Creation__c: c.Primary_Phone__c ?? null,
    Primary_Email_at_Creation__c: c.Primary_Email__c ?? null,
  });
  const systemCtx = (tenantId, slug, cors, name = "Stripe") => ({ tenantId, tenantSlug: slug, userId: null, scope: "system", actor: { id: null, name }, cors });
  const publicCtx = (tenantId, slug, cors) => systemCtx(tenantId, slug, cors, "Customer (online)");

  // --- the public customer: find by email / phone / address, else create ------------
  // A visitor is never shown a "possible duplicate" list: an exact email or phone
  // match IS that customer (tagged Service, like the office popup would); otherwise
  // the record is created. The office sees which happened on the activity feed.
  async function resolvePublicCustomer(ctx, spec, cors) {
    const soql = candidateSoql(ctx.tenantId, spec);
    const rows = soql ? await d.sfQuery(soql) : [];
    const candidates = matchCandidates(rows, spec);
    const best = candidates.find((c) => c.reasons.includes("email")) || candidates.find((c) => c.reasons.includes("phone")) || candidates.find((c) => c.reasons.includes("address")) || null;
    const body = best ? { customer: { id: best.id } } : { customer: { new: spec, confirmNew: true } };
    const r = await h.resolveCustomer(body, ctx, cors);
    if (!r.ok) return r;
    // Keep the hub current when the visitor typed something the record lacks.
    if (best) {
      const fill = {};
      if (!r.customer.Primary_Email__c && spec.email) fill.Primary_Email__c = spec.email;
      if (!r.customer.Primary_Phone__c && spec.phone) fill.Primary_Phone__c = spec.phone;
      if (Object.keys(fill).length) {
        try {
          await d.sfUpdateRecord(CUSTOMER_SF_OBJECT, r.customer.Id, fill);
          Object.assign(r.customer, fill);
        } catch (e) {
          console.error("club: customer fill failed:", e?.message || e);
        }
      }
    }
    return { ...r, matched: best ? best.reasons : null };
  }

  // --- side channels: SolarFax, team email, member email --------------------------------
  /**
   * The monitoring hand-off. `member.activated` → SolarFax creates the member and emails
   * the connect-your-utility invite; `member.cancelled` → full disconnect. Through their API
   * when the tenant has credentials, else through a Zapier catch hook if one is configured,
   * else stamped Not Applicable. Never throws; the membership row carries the outcome.
   */
  async function postSolarFacts({ membership, plan, event, slug, cfg }) {
    const cancelling = event === "member.cancelled";
    const okStatus = cancelling ? "Cancel Sent" : "Sent";
    const failStatus = cancelling ? "Cancel Failed" : "Failed";
    const now = d.now().toISOString();
    const fail = async (err) => {
      const msg = String(err).slice(0, 255);
      console.error("club: SolarFax hand-off failed:", msg);
      await d.sfUpdateRecord(MEMBERSHIP_SF_OBJECT, membership.Id, { SolarFacts_Status__c: failStatus, SolarFacts_Last_Error__c: msg });
      return { sent: false, reason: msg };
    };

    if (cfg?.solarFacts) {
      // The member as SolarFax needs them: the hub's current name / contact / address, the
      // membership snapshot when the hub is thin.
      const customer = await loadCustomer(membership.Sundial_Customer__c, membership.Client__c);
      const name = customer?.First_Name__c || customer?.Last_Name__c ? { firstName: customer.First_Name__c || "", lastName: customer.Last_Name__c || "" } : splitName(customer?.Name || membership.Customer_Name_at_Creation__c);
      const email = strOrNull(customer?.Primary_Email__c) || strOrNull(membership.Primary_Email_at_Creation__c);
      if (!email) return fail("The member has no email address — SolarFax needs one for the invite.");
      const member = { ...name, email, phone: customer?.Primary_Phone__c || membership.Primary_Phone_at_Creation__c || "", street: customer?.Street__c || "", city: customer?.City__c || "", state: customer?.State__c || "", zip: customer?.Postal_Code__c || "" };
      try {
        const client = createSolarFactsClient(cfg.solarFacts, { fetchUrl });
        const res = cancelling ? await client.disconnect(member) : await client.invite(member);
        const upd = { SolarFacts_Status__c: okStatus, SolarFacts_Last_Sent_At__c: now, SolarFacts_Last_Error__c: null };
        if (res?.account_id) upd.SolarFacts_Account_Id__c = String(res.account_id).slice(0, 60);
        if (res?.user_id) upd.SolarFacts_User_Id__c = String(res.user_id).slice(0, 60);
        await d.sfUpdateRecord(MEMBERSHIP_SF_OBJECT, membership.Id, upd);
        Object.assign(membership, upd);
        return { sent: true, via: "api", action: res?.action ?? null, accountId: upd.SolarFacts_Account_Id__c ?? null, test: cfg.solarFacts.test };
      } catch (e) {
        return fail(e?.message || e);
      }
    }

    const url = cancelling ? cfg?.solarFactsCancelHookUrl : cfg?.solarFactsHookUrl;
    if (!url) {
      await d.sfUpdateRecord(MEMBERSHIP_SF_OBJECT, membership.Id, { SolarFacts_Status__c: "Not Applicable", SolarFacts_Last_Error__c: "SolarFax is not configured for this tenant (sundial/service-club)" });
      return { sent: false, reason: "not_configured" };
    }
    const payload = solarFactsPayload(membership, plan, event, { tenant: slug, at: now });
    try {
      const res = await fetchUrl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(`hook answered ${res.status}`);
      await d.sfUpdateRecord(MEMBERSHIP_SF_OBJECT, membership.Id, { SolarFacts_Status__c: okStatus, SolarFacts_Last_Sent_At__c: now, SolarFacts_Last_Error__c: null });
      return { sent: true, via: "hook" };
    } catch (e) {
      return fail(e?.message || e);
    }
  }
  async function notifyTeam(cfg, { subject, lines }) {
    if (!cfg?.teamEmail || !d.isEmailConfigured?.()) return { sent: false };
    try {
      const text = lines.join("\n");
      const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.5">${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}</div>`;
      const r = await d.sendEmail({ to: cfg.teamEmail, subject, text, html });
      return { sent: r?.ok !== false };
    } catch (e) {
      console.error("club: team email failed:", e?.message || e);
      return { sent: false };
    }
  }
  async function emailCustomer(to, { subject, lines, cta }) {
    if (!to || !d.isEmailConfigured?.()) return { sent: false };
    try {
      const text = [...lines, cta ? `${cta.label}: ${cta.url}` : null].filter(Boolean).join("\n\n");
      const html = `<div style="font-family:sans-serif;font-size:15px;line-height:1.5;color:#222">${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}${cta ? `<p><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:10px 18px;background:#b92e33;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(cta.label)}</a></p><p style="font-size:12px;color:#666">${escapeHtml(cta.url)}</p>` : ""}</div>`;
      const r = await d.sendEmail({ to, subject, text, html });
      return { sent: r?.ok !== false };
    } catch (e) {
      console.error("club: customer email failed:", e?.message || e);
      return { sent: false };
    }
  }
  const brandName = (ctx) => (h.brandFor ? h.brandFor(ctx).companyName : "") || "";
  const publicBase = () => String(d.publicBaseUrl || "").replace(/\/+$/, "");

  // --- the join: Pending row + Checkout session (shared by the public page and the office) --
  async function startJoin({ ctx, customer, plan, interval, source, notes, cors, ownerNote }) {
    const { tenantId, tenantSlug: slug } = ctx;
    const stripe = await stripeFor(slug);
    if (!stripe) return { ok: false, response: jsonResponse(503, cors, { error: "not_configured", code: "STRIPE_NOT_CONFIGURED", message: "Online membership isn't set up yet — please give us a call." }) };
    const base = publicBase();
    if (!base) return { ok: false, response: jsonResponse(503, cors, { error: "not_configured", code: "PUBLIC_URL_NOT_SET", message: "Online membership isn't set up yet — please give us a call." }) };
    const priceId = interval === "Yearly" ? plan.Stripe_Yearly_Price_Id__c : plan.Stripe_Monthly_Price_Id__c;
    const price = interval === "Yearly" ? plan.Yearly_Price__c : plan.Monthly_Price__c;
    if (!priceId || price == null) return { ok: false, response: jsonResponse(409, cors, { error: "not_available", code: "PLAN_INTERVAL_UNAVAILABLE", message: `${plan.Name} isn't offered ${interval === "Yearly" ? "yearly" : "monthly"}.` }) };
    // One live membership per customer.
    const live = await activeMembershipFor(customer.Id, tenantId);
    if (live.membership) return { ok: false, response: jsonResponse(409, cors, { error: "already_member", code: "ALREADY_MEMBER", membershipId: live.membership.Id, plan: live.plan?.Name ?? null, message: `You're already a Service Club member${live.plan ? ` (${live.plan.Name})` : ""}. Use "Manage my membership" to make changes, or give us a call.` }) };
    let stripeCustomerId = customer.Stripe_Customer_Id__c || null;
    try {
      const ensured = await ensureStripeCustomer(stripe.client, {
        existingId: stripeCustomerId,
        name: customer.Name || [customer.First_Name__c, customer.Last_Name__c].filter(Boolean).join(" ") || undefined,
        email: customer.Primary_Email__c || undefined,
        phone: customer.Primary_Phone__c || undefined,
        metadata: { tenant: slug, sundialCustomerId: customer.Id, source: "sundial" },
      });
      if (ensured !== stripeCustomerId) {
        await d.sfUpdateRecord(CUSTOMER_SF_OBJECT, customer.Id, { Stripe_Customer_Id__c: ensured });
        await h.markStale(CACHE.customer, [customer.Id], tenantId);
      }
      stripeCustomerId = ensured;
    } catch (e) {
      console.error("club join: stripe customer failed:", e?.message || e);
      return { ok: false, response: jsonResponse(502, cors, { error: "stripe_error", code: "STRIPE_ERROR", message: "We couldn't start the signup. Please try again or give us a call." }) };
    }
    const fields = {
      Client__c: tenantId,
      Sundial_Customer__c: customer.Id,
      Service_Plan__c: plan.Id,
      Status__c: "Pending",
      Billing_Interval__c: interval,
      Price__c: money(price),
      Source__c: source,
      Stripe_Customer_Id__c: stripeCustomerId,
      SolarFacts_Status__c: "Not Sent",
      Lifetime_Revenue__c: 0,
      Payment_Failures__c: 0,
      ...snapshot(customer),
      ...(notes ? { Notes__c: notes } : {}),
    };
    for (const k of Object.keys(fields)) if (fields[k] === null) delete fields[k];
    let created;
    try {
      created = await d.sfCreateRecord(MEMBERSHIP_SF_OBJECT, fields);
    } catch (e) {
      return { ok: false, response: sfError(cors, e, "membership create") };
    }
    const membershipId = created.id;
    const metadata = { tenant: slug, tenantId, kind: "membership", membershipId, customerId: customer.Id, planId: plan.Id, planCode: plan.Plan_Code__c, interval, source };
    let session;
    try {
      session = await stripe.client.post(
        "checkout/sessions",
        {
          mode: "subscription",
          customer: stripeCustomerId,
          line_items: [{ price: priceId, quantity: 1 }],
          success_url: `${base}/club/joined?session={CHECKOUT_SESSION_ID}`,
          cancel_url: `${base}/club/join?plan=${encodeURIComponent(plan.Plan_Code__c)}&interval=${interval === "Yearly" ? "yearly" : "monthly"}&checkout=cancel`,
          client_reference_id: membershipId,
          metadata,
          subscription_data: { metadata },
          allow_promotion_codes: true,
        },
        { idempotencyKey: `club-join:${membershipId}` }
      );
    } catch (e) {
      console.error("club join: session failed:", e instanceof StripeError ? `${e.code} ${e.message}` : e?.message || e);
      try {
        await d.sfUpdateRecord(MEMBERSHIP_SF_OBJECT, membershipId, { Status__c: "Expired", Notes__c: "Checkout could not be started".slice(0, 255) });
      } catch { /* reported below either way */ }
      return { ok: false, response: jsonResponse(502, cors, { error: "stripe_error", code: "STRIPE_ERROR", message: "We couldn't start the signup. Please try again or give us a call." }) };
    }
    await d.sfUpdateRecord(MEMBERSHIP_SF_OBJECT, membershipId, { Stripe_Checkout_Session_Id__c: session.id });
    await h.markStale(CLUB_CACHE.membership, [membershipId], tenantId);
    await h.act(ctx, { event: EVENTS.MEMBERSHIP_STARTED, recordType: "membership", recordSfId: membershipId, details: { plan: plan.Name, planCode: plan.Plan_Code__c, interval, price: money(price), source, customerId: customer.Id, sessionId: session.id, mode: stripe.config.mode, ...(ownerNote ? { note: ownerNote } : {}) } });
    return { ok: true, membershipId, url: session.url, sessionId: session.id, mode: stripe.config.mode, plan, price: money(price) };
  }

  // --- what the webhook does with subscription events --------------------------------
  async function setActivePointer(customerId, membershipId, tenantId) {
    if (!SF_ID_RE.test(customerId || "")) return;
    await d.sfUpdateRecord(CUSTOMER_SF_OBJECT, customerId, { Active_Membership__c: membershipId });
    await h.markStale(CACHE.customer, [customerId], tenantId);
  }
  async function clearActivePointer(customerId, membershipId, tenantId) {
    const customer = await loadCustomer(customerId, tenantId);
    if (customer && customer.Active_Membership__c === membershipId) {
      await d.sfUpdateRecord(CUSTOMER_SF_OBJECT, customerId, { Active_Membership__c: null });
      await h.markStale(CACHE.customer, [customerId], tenantId);
    }
  }

  async function applyJoinCompleted({ stripe, tenantId, slug, session, cors }) {
    const meta = session.metadata || {};
    const ctx = systemCtx(tenantId, slug, cors);
    let m = meta.membershipId ? await loadMembership(meta.membershipId, tenantId) : null;
    if (!m) m = await loadMembershipBy("Stripe_Checkout_Session_Id__c", session.id, tenantId);
    if (!m) return { status: "ignored", reason: "no membership for this checkout session" };
    const subId = idOf(session.subscription);
    if (m.Status__c === "Active" && m.Stripe_Subscription_Id__c === subId) return { status: "applied", membershipId: m.Id, duplicate: true };
    let sub = null;
    if (subId) {
      try {
        sub = await stripe.client.get(`subscriptions/${encodeURIComponent(subId)}`);
      } catch (e) {
        console.error("club: subscription lookup failed:", e?.message || e);
      }
    }
    const from = sub ? statusFromSubscription(sub) : { status: "Active", currentPeriodEnd: null, cancelAtPeriodEnd: false };
    const now = d.now().toISOString();
    const upd = {
      Status__c: from.status === "Pending" ? "Active" : from.status,
      Stripe_Subscription_Id__c: subId || null,
      Stripe_Customer_Id__c: idOf(session.customer) || m.Stripe_Customer_Id__c || null,
      Started_At__c: m.Started_At__c || isoFromUnix(sub?.start_date ?? session.created, now),
      Current_Period_End__c: from.currentPeriodEnd,
      Cancel_At_Period_End__c: from.cancelAtPeriodEnd,
    };
    for (const k of Object.keys(upd)) if (upd[k] === null) delete upd[k];
    await d.sfUpdateRecord(MEMBERSHIP_SF_OBJECT, m.Id, upd);
    Object.assign(m, upd);
    await h.markStale(CLUB_CACHE.membership, [m.Id], tenantId);
    const stripeCustomerId = idOf(session.customer);
    const customer = await loadCustomer(m.Sundial_Customer__c, tenantId);
    if (customer && stripeCustomerId && customer.Stripe_Customer_Id__c !== stripeCustomerId) await d.sfUpdateRecord(CUSTOMER_SF_OBJECT, customer.Id, { Stripe_Customer_Id__c: stripeCustomerId });
    await setActivePointer(m.Sundial_Customer__c, m.Id, tenantId);
    const plan = await loadPlan(m.Service_Plan__c, tenantId);
    await h.act(ctx, { event: EVENTS.MEMBERSHIP_STARTED, recordType: "membership", recordSfId: m.Id, details: { activated: true, plan: plan?.Name ?? null, interval: m.Billing_Interval__c, price: money(m.Price__c), subscriptionId: subId, via: "stripe", mode: stripe.config.mode } });
    const cfg = await clubConfig(slug);
    const sf = await postSolarFacts({ membership: m, plan, event: "member.activated", slug, cfg });
    await notifyTeam(cfg, {
      subject: `New Service Club member: ${m.Customer_Name_at_Creation__c ?? "customer"} — ${plan?.Name ?? "plan"}`,
      lines: [
        `${m.Customer_Name_at_Creation__c ?? "A customer"} just joined the ${plan?.Name ?? "Service Club"} (${m.Billing_Interval__c?.toLowerCase() ?? ""}, $${money(m.Price__c).toFixed(2)}).`,
        `Address: ${m.Address_at_Creation__c ?? "—"}`,
        `Phone: ${m.Primary_Phone_at_Creation__c ?? "—"} · Email: ${m.Primary_Email_at_Creation__c ?? "—"}`,
        `Membership ${m.Name ?? m.Id} · source ${m.Source__c ?? "Online"}.`,
        plan?.Includes_Tune_Up__c ? "This plan includes an annual tune-up — schedule the first one." : null,
        sf.sent ? `SolarFax has been sent the connect invite${sf.test ? " (SolarFax TEST mode — no real user was created)" : ""}.` : `SolarFax was NOT told (${sf.reason}) — resend from Sundial once it is set up.`,
      ].filter(Boolean),
    });
    return { status: "applied", membershipId: m.Id, subscriptionId: subId, solarFacts: sf.sent };
  }

  async function applySubscription({ tenantId, slug, sub, cors, deleted }) {
    const ctx = systemCtx(tenantId, slug, cors);
    let m = await loadMembershipBy("Stripe_Subscription_Id__c", sub.id, tenantId);
    if (!m && sub.metadata?.membershipId) m = await loadMembership(sub.metadata.membershipId, tenantId);
    if (!m) return { status: "ignored", reason: "no membership for this subscription" };
    const from = statusFromSubscription(deleted ? { ...sub, status: "canceled" } : sub);
    const before = m.Status__c;
    const now = d.now().toISOString();
    const upd = { Status__c: from.status, Current_Period_End__c: from.currentPeriodEnd, Cancel_At_Period_End__c: from.cancelAtPeriodEnd };
    if (!m.Stripe_Subscription_Id__c) upd.Stripe_Subscription_Id__c = sub.id;
    if (from.cancelAtPeriodEnd && !m.Cancelled_At__c) upd.Cancelled_At__c = from.canceledAt || now;
    if (from.status === "Cancelled") {
      upd.Ended_At__c = m.Ended_At__c || from.endedAt || now;
      if (!m.Cancelled_At__c) upd.Cancelled_At__c = from.canceledAt || upd.Ended_At__c;
    }
    // A Pending row whose subscription went straight to active (webhook ordering): treat as the join.
    if (before === "Pending" && from.status === "Active" && !m.Started_At__c) upd.Started_At__c = isoFromUnix(sub.start_date, now);
    for (const k of Object.keys(upd)) if (upd[k] === null) delete upd[k];
    const changed = Object.keys(upd).some((k) => m[k] !== upd[k]);
    if (!changed) return { status: "applied", membershipId: m.Id, duplicate: true };
    await d.sfUpdateRecord(MEMBERSHIP_SF_OBJECT, m.Id, upd);
    Object.assign(m, upd);
    await h.markStale(CLUB_CACHE.membership, [m.Id], tenantId);
    const plan = await loadPlan(m.Service_Plan__c, tenantId);
    const cfg = await clubConfig(slug);
    let sf = null;
    if (from.status === "Cancelled") {
      await clearActivePointer(m.Sundial_Customer__c, m.Id, tenantId);
      sf = await postSolarFacts({ membership: m, plan, event: "member.cancelled", slug, cfg });
      await h.act(ctx, { event: EVENTS.MEMBERSHIP_CANCELLED, recordType: "membership", recordSfId: m.Id, details: { plan: plan?.Name ?? null, from: before, endedAt: m.Ended_At__c ?? null, reason: m.Cancel_Reason__c ?? null, via: "stripe" } });
      await notifyTeam(cfg, {
        subject: `Service Club membership ended: ${m.Customer_Name_at_Creation__c ?? "customer"} — ${plan?.Name ?? "plan"}`,
        lines: [`${m.Customer_Name_at_Creation__c ?? "A customer"}'s ${plan?.Name ?? ""} membership (${m.Name ?? m.Id}) has ended.`, m.Cancel_Reason__c ? `Reason: ${m.Cancel_Reason__c}` : null, sf?.sent ? "SolarFax has disconnected the member's monitoring." : `SolarFax was NOT told (${sf?.reason}) — resend from Sundial.`].filter(Boolean),
      });
    } else {
      if (LIVE_STATUSES.has(from.status)) await setActivePointer(m.Sundial_Customer__c, m.Id, tenantId);
      await h.act(ctx, { event: EVENTS.MEMBERSHIP_UPDATED, recordType: "membership", recordSfId: m.Id, details: { from: before, to: from.status, cancelAtPeriodEnd: from.cancelAtPeriodEnd, currentPeriodEnd: from.currentPeriodEnd, via: "stripe" } });
      if (from.status === "Past Due" && before !== "Past Due") {
        await notifyTeam(cfg, { subject: `Service Club payment past due: ${m.Customer_Name_at_Creation__c ?? "customer"}`, lines: [`${m.Customer_Name_at_Creation__c ?? "A member"}'s ${plan?.Name ?? ""} renewal failed (${m.Name ?? m.Id}). Stripe will retry; the member can update their card from the "Manage my membership" link.`, `Phone: ${m.Primary_Phone_at_Creation__c ?? "—"} · Email: ${m.Primary_Email_at_Creation__c ?? "—"}`] });
      }
      // The first time we hear of a scheduled cancellation (the member did it in the
      // portal, or the office here): tell the team now; the end itself comes later.
      if (upd.Cancelled_At__c && from.cancelAtPeriodEnd) {
        await notifyTeam(cfg, { subject: `Service Club cancellation scheduled: ${m.Customer_Name_at_Creation__c ?? "customer"}`, lines: [`${m.Customer_Name_at_Creation__c ?? "A member"} cancelled their ${plan?.Name ?? ""} membership (${m.Name ?? m.Id}); it stays active until ${from.currentPeriodEnd ? new Date(from.currentPeriodEnd).toLocaleDateString("en-US") : "the period ends"}.`] });
      }
    }
    return { status: "applied", membershipId: m.Id, to: from.status, solarFacts: sf?.sent ?? null };
  }

  async function applyInvoice({ tenantId, slug, invoice, cors, failed }) {
    const subId = idOf(invoice.subscription);
    if (!subId) return null; // not a subscription invoice — not ours
    const ctx = systemCtx(tenantId, slug, cors);
    const m = await loadMembershipBy("Stripe_Subscription_Id__c", subId, tenantId);
    if (!m) return { status: "ignored", reason: "no membership for this subscription" };
    const now = d.now().toISOString();
    if (failed) {
      const upd = { Payment_Failures__c: (Number(m.Payment_Failures__c) || 0) + 1 };
      if (m.Status__c === "Active") upd.Status__c = "Past Due";
      await d.sfUpdateRecord(MEMBERSHIP_SF_OBJECT, m.Id, upd);
      await h.markStale(CLUB_CACHE.membership, [m.Id], tenantId);
      await h.act(ctx, { event: EVENTS.MEMBERSHIP_PAYMENT, recordType: "membership", recordSfId: m.Id, details: { failed: true, amount: fromCents(invoice.amount_due), invoiceId: invoice.id, via: "stripe" } });
      // The failed renewal is the first signal (the subscription.updated that follows finds
      // the row already Past Due, so the team hears exactly once).
      if (upd.Status__c === "Past Due") {
        const plan = await loadPlan(m.Service_Plan__c, tenantId);
        await notifyTeam(await clubConfig(slug), { subject: `Service Club payment past due: ${m.Customer_Name_at_Creation__c ?? "customer"}`, lines: [`${m.Customer_Name_at_Creation__c ?? "A member"}'s ${plan?.Name ?? ""} renewal failed (${m.Name ?? m.Id}, $${fromCents(invoice.amount_due).toFixed(2)}). Stripe will retry; the member can update their card from the "Manage my membership" link.`, `Phone: ${m.Primary_Phone_at_Creation__c ?? "—"} · Email: ${m.Primary_Email_at_Creation__c ?? "—"}`] });
      }
      return { status: "applied", membershipId: m.Id, failed: true };
    }
    const amount = fromCents(invoice.amount_paid ?? invoice.amount_due ?? 0);
    const upd = { Last_Payment_At__c: isoFromUnix(invoice.status_transitions?.paid_at ?? invoice.created, now), Last_Payment_Amount__c: amount, Lifetime_Revenue__c: money((Number(m.Lifetime_Revenue__c) || 0) + amount) };
    if (m.Status__c === "Past Due") upd.Status__c = "Active";
    await d.sfUpdateRecord(MEMBERSHIP_SF_OBJECT, m.Id, upd);
    await h.markStale(CLUB_CACHE.membership, [m.Id], tenantId);
    if (upd.Status__c === "Active") await setActivePointer(m.Sundial_Customer__c, m.Id, tenantId);
    await h.act(ctx, { event: EVENTS.MEMBERSHIP_PAYMENT, recordType: "membership", recordSfId: m.Id, details: { amount, invoiceId: invoice.id, billingReason: invoice.billing_reason ?? null, lifetime: upd.Lifetime_Revenue__c, via: "stripe" } });
    return { status: "applied", membershipId: m.Id, amount };
  }

  /**
   * The webhook's club branch. Returns a result for a club event, or null when the event
   * is not the club's (so the payments branch handles it).
   */
  async function applyEvent({ stripe, tenantId, slug, evt, cors }) {
    const obj = evt.data.object;
    if (evt.type === "checkout.session.completed") return obj.mode === "subscription" ? applyJoinCompleted({ stripe, tenantId, slug, session: obj, cors }) : null;
    if (evt.type === "customer.subscription.updated" || evt.type === "customer.subscription.created") return applySubscription({ tenantId, slug, sub: obj, cors, deleted: false });
    if (evt.type === "customer.subscription.deleted") return applySubscription({ tenantId, slug, sub: obj, cors, deleted: true });
    if (evt.type === "invoice.paid" || evt.type === "invoice.payment_succeeded") return applyInvoice({ tenantId, slug, invoice: obj, cors, failed: false });
    if (evt.type === "invoice.payment_failed") return applyInvoice({ tenantId, slug, invoice: obj, cors, failed: true });
    return null;
  }

  /** The discount fields a NEW estimate for this customer should carry (index.js calls this). */
  async function discountForCustomer(customerId, tenantId) {
    try {
      const { membership, plan } = await activeMembershipFor(customerId, tenantId);
      return membership ? planDiscountFields(plan, membership.Id) : null;
    } catch (e) {
      console.error("club: discount lookup failed:", e?.message || e);
      return null;
    }
  }

  // --- the public handlers ------------------------------------------------------------
  async function publicTenant(params, cors) {
    const slug = params[0];
    const tenantId = await tenantIdFor(slug);
    if (!tenantId) return { response: jsonResponse(404, cors, { error: "not_found", code: "TENANT_UNKNOWN" }) };
    return { slug, tenantId, ctx: publicCtx(tenantId, slug, cors) };
  }

  const H = {
    async clubPlans({ params, cors }) {
      const t = await publicTenant(params, cors);
      if (t.response) return t.response;
      const [rows, stripe] = await Promise.all([loadPlans(t.tenantId), stripeFor(t.slug)]);
      const plans = publicPlans(rows);
      return jsonResponse(200, cors, { tenant: t.slug, brand: brandName(t.ctx) || null, configured: !!stripe, plans: plans.filter((p) => p.kind === "subscription"), oneTime: plans.filter((p) => p.kind === "one-time") });
    },

    async clubJoin({ params, body, cors }) {
      const t = await publicTenant(params, cors);
      if (t.response) return t.response;
      const n = normalizeJoin(body);
      if (!n.ok) return bad(cors, "JOIN_INVALID", "Please check the form.", { problems: n.problems });
      const plan = await loadPlanByCode(n.value.planCode, t.tenantId);
      if (!plan || plan.Kind__c !== "Subscription") return notFound(cors);
      if (plan.Availability__c !== "Available") return jsonResponse(409, cors, { error: "not_available", code: "PLAN_NOT_AVAILABLE", message: `${plan.Name} isn't available yet.` });
      const r = await resolvePublicCustomer(t.ctx, n.value.customer, cors);
      if (!r.ok) return r.response;
      const customer = await loadCustomer(r.customer.Id, t.tenantId);
      const started = await startJoin({ ctx: t.ctx, customer, plan, interval: n.value.interval, source: "Online", notes: n.value.notes, cors, ownerNote: r.matched ? `matched existing customer by ${r.matched.join("/")}` : "new customer" });
      if (!started.ok) return started.response;
      await h.flushEvents(t.ctx, r.events, {});
      return jsonResponse(200, cors, { url: started.url, membershipId: started.membershipId, plan: plan.Name, interval: n.value.interval, price: started.price, mode: started.mode });
    },

    async clubJoined({ params, query, cors }) {
      const t = await publicTenant(params, cors);
      if (t.response) return t.response;
      const sessionId = strOrNull(query?.session);
      if (!sessionId || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return notFound(cors);
      const m = await loadMembershipBy("Stripe_Checkout_Session_Id__c", sessionId, t.tenantId);
      if (!m) return notFound(cors);
      const plan = await loadPlan(m.Service_Plan__c, t.tenantId);
      return jsonResponse(200, cors, { status: m.Status__c, number: m.Name ?? null, plan: plan ? { code: plan.Plan_Code__c, name: plan.Name, includesTuneUp: plan.Includes_Tune_Up__c === true } : null, interval: m.Billing_Interval__c, price: money(m.Price__c), firstName: (m.Customer_Name_at_Creation__c || "").split(" ")[0] || null });
    },

    /** A truck roll bought online: an approved estimate + a job, paid now as the deposit. */
    async clubTruckRoll({ params, body, cors }) {
      const t = await publicTenant(params, cors);
      if (t.response) return t.response;
      const planCode = strOrNull(body?.planCode)?.toLowerCase() || "truck-roll";
      const plan = await loadPlanByCode(planCode, t.tenantId);
      if (!plan || plan.Kind__c !== "One-time") return notFound(cors);
      if (plan.Availability__c !== "Available") return jsonResponse(409, cors, { error: "not_available", code: "PLAN_NOT_AVAILABLE" });
      const cust = normalizeNewCustomer(body?.customer);
      if (!cust.ok) return bad(cors, "CUSTOMER_INVALID", "Please check the form.", { missing: cust.missing });
      const issue = strOrNull(body?.issue)?.slice(0, 2000) ?? null;
      const stripe = await stripeFor(t.slug);
      const base = publicBase();
      if (!stripe || !base) return jsonResponse(503, cors, { error: "not_configured", code: "STRIPE_NOT_CONFIGURED", message: "Online booking isn't set up yet — please give us a call." });
      const r = await resolvePublicCustomer(t.ctx, cust.value, cors);
      if (!r.ok) return r.response;
      const customer = await loadCustomer(r.customer.Id, t.tenantId);
      const name = customer.Name || [customer.First_Name__c, customer.Last_Name__c].filter(Boolean).join(" ");
      // The line: the price-book item by code when the plan names one (its active price wins), else ad hoc.
      let lineSpec = null;
      if (plan.Price_Book_Item_Code__c) {
        const items = await d.sfQuery(`SELECT ${ITEM_SELECT} FROM ${ITEM_SF_OBJECT} WHERE Item_Code__c = '${soqlEscapeString(plan.Price_Book_Item_Code__c)}' AND Client__c = '${soqlEscapeString(t.tenantId)}' AND Is_Active__c = true LIMIT 1`);
        if (items?.[0]) lineSpec = { priceBookItemId: items[0].Id, quantity: 1, stage: "Approved", source: "Ad hoc" };
      }
      if (!lineSpec) {
        if (plan.Price__c == null || Number(plan.Price__c) <= 0) return jsonResponse(409, cors, { error: "not_available", code: "PLAN_NO_PRICE" });
        lineSpec = { description: plan.Name, kind: "Fee", unitPrice: money(plan.Price__c), quantity: 1, stage: "Approved", source: "Ad hoc", taxable: false };
      }
      let est;
      let job;
      try {
        est = await h.createEstimateRecord({ customer, body: { estimate: { scopeSummary: `${plan.Name} booked online${issue ? ` — ${issue.slice(0, 200)}` : ""}` } }, tenantId: t.tenantId, userId: null });
        job = await h.createJobRecord({ customer, estimateId: est.id, body: { job: { intakeChannel: "Web Form", issueDescription: issue || `${plan.Name} booked online`, serviceType: "Paid Service" } }, tenantId: t.tenantId });
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.id, { Service_Job__c: job.id });
        await d.sfUpdateRecord(JOB_SF_OBJECT, job.id, { Needs_Intake_Review__c: true });
      } catch (e) {
        return sfError(cors, e, "truck roll create");
      }
      const lines = await h.addLinesToEstimate(est.id, t.tenantId, [lineSpec]);
      if (!lines.createdIds.length) return jsonResponse(500, cors, { error: "server_error", code: "LINE_FAILED", problems: lines.problems });
      // Approved as sold, deposit = the whole price, so the existing deposit checkout + webhook pay it.
      const full0 = await h.loadEstimate(est.id, t.tenantId);
      const lineRows = await h.loadLines(est.id, t.tenantId);
      const pre = computeTotals(lineRows.map(lineFromRecord), estimateFromRecord(full0));
      const approval = { Status__c: "Approved", Approved_At__c: d.now().toISOString(), Approved_Version__c: 0, Approved_Amount__c: pre.total, Approval_Method__c: "Online", Approved_By_Name__c: name, Deposit_Required__c: true, Deposit_Type__c: "Flat", Deposit_Value__c: pre.total };
      await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.id, approval);
      const { totals } = await h.recomputeAndStore({ ...full0, ...approval }, t.tenantId);
      await h.markStale(CACHE.job, [job.id], t.tenantId);
      await h.flushEvents(t.ctx, r.events, { estimateSfId: est.id, jobSfId: job.id });
      await h.act(t.ctx, { event: EVENTS.JOB_CREATED, recordType: "job", recordSfId: job.id, jobSfId: job.id, estimateSfId: est.id, details: { online: true, plan: plan.Name, total: totals.total, customerId: customer.Id, customerCreated: r.created } });
      // The Checkout: the deposit path from the estimate page, with the same metadata the webhook expects.
      let stripeCustomerId = customer.Stripe_Customer_Id__c || null;
      try {
        const ensured = await ensureStripeCustomer(stripe.client, { existingId: stripeCustomerId, name: name || undefined, email: customer.Primary_Email__c || undefined, phone: customer.Primary_Phone__c || undefined, metadata: { tenant: t.slug, sundialCustomerId: customer.Id, source: "sundial" } });
        if (ensured !== stripeCustomerId) await d.sfUpdateRecord(CUSTOMER_SF_OBJECT, customer.Id, { Stripe_Customer_Id__c: ensured });
        stripeCustomerId = ensured;
      } catch (e) {
        console.error("club truck roll: stripe customer failed:", e?.message || e);
        return jsonResponse(502, cors, { error: "stripe_error", code: "STRIPE_ERROR", message: "We couldn't start the payment. Please give us a call — your request has been received." });
      }
      const metadata = { tenant: t.slug, tenantId: t.tenantId, estimateId: est.id, jobId: job.id, customerId: customer.Id, invoiceId: "", kind: "deposit" };
      const label = `${plan.Name}${brandName(t.ctx) ? ` (${brandName(t.ctx)})` : ""}`;
      let session;
      try {
        session = await stripe.client.post(
          "checkout/sessions",
          {
            mode: "payment",
            customer: stripeCustomerId,
            line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: toCents(totals.depositAmount), product_data: { name: label } } }],
            payment_intent_data: { setup_future_usage: "off_session", description: label, metadata },
            success_url: `${base}/club/booked?job=${encodeURIComponent(job.id)}`,
            cancel_url: `${base}/club/service?checkout=cancel`,
            client_reference_id: est.id,
            metadata,
          },
          { idempotencyKey: `club-truck-roll:${est.id}` }
        );
      } catch (e) {
        console.error("club truck roll: session failed:", e instanceof StripeError ? `${e.code} ${e.message}` : e?.message || e);
        return jsonResponse(502, cors, { error: "stripe_error", code: "STRIPE_ERROR", message: "We couldn't start the payment. Please give us a call — your request has been received." });
      }
      const cfg = await clubConfig(t.slug);
      await notifyTeam(cfg, { subject: `Online booking started: ${name} — ${plan.Name}`, lines: [`${name} is booking a ${plan.Name} online ($${money(totals.depositAmount).toFixed(2)}). The job is on the board once they pay; if they don't, it stays in Needs Intake Review.`, `Address: ${customer.Street__c ? [customer.Street__c, customer.City__c, customer.State__c, customer.Postal_Code__c].filter(Boolean).join(", ") : "—"}`, `Phone: ${customer.Primary_Phone__c ?? "—"} · Email: ${customer.Primary_Email__c ?? "—"}`, issue ? `The issue: ${issue}` : null].filter(Boolean) });
      return jsonResponse(200, cors, { url: session.url, jobId: job.id, estimateId: est.id, amount: money(totals.depositAmount), mode: stripe.config.mode });
    },

    /** "I don't know what I need — call me": a job for the office, an email to the team. */
    async clubRequest({ params, body, cors }) {
      const t = await publicTenant(params, cors);
      if (t.response) return t.response;
      const cust = normalizeNewCustomer(body?.customer);
      if (!cust.ok) return bad(cors, "CUSTOMER_INVALID", "Please check the form.", { missing: cust.missing });
      const message = strOrNull(body?.message)?.slice(0, 2000) ?? null;
      const r = await resolvePublicCustomer(t.ctx, cust.value, cors);
      if (!r.ok) return r.response;
      const customer = await loadCustomer(r.customer.Id, t.tenantId);
      let est;
      let job;
      try {
        est = await h.createEstimateRecord({ customer, body: {}, tenantId: t.tenantId, userId: null });
        job = await h.createJobRecord({ customer, estimateId: est.id, body: { job: { intakeChannel: "Web Form", issueDescription: message || "Service request from the website (no details given)" } }, tenantId: t.tenantId });
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.id, { Service_Job__c: job.id });
        await d.sfUpdateRecord(JOB_SF_OBJECT, job.id, { Needs_Intake_Review__c: true });
      } catch (e) {
        return sfError(cors, e, "request create");
      }
      const full = await h.loadEstimate(est.id, t.tenantId);
      await h.recomputeAndStore(full, t.tenantId);
      await h.markStale(CACHE.job, [job.id], t.tenantId);
      await h.flushEvents(t.ctx, r.events, { estimateSfId: est.id, jobSfId: job.id });
      await h.act(t.ctx, { event: EVENTS.JOB_CREATED, recordType: "job", recordSfId: job.id, jobSfId: job.id, estimateSfId: est.id, details: { online: true, request: true, customerId: customer.Id, customerCreated: r.created } });
      const jobRow = await d.sfQuery(`SELECT Id, Name FROM ${JOB_SF_OBJECT} WHERE Id = '${job.id}' LIMIT 1`);
      const number = jobRow?.[0]?.Name ?? null;
      const name = customer.Name || [customer.First_Name__c, customer.Last_Name__c].filter(Boolean).join(" ");
      const cfg = await clubConfig(t.slug);
      await notifyTeam(cfg, { subject: `Website service request: ${name}${number ? ` (${number})` : ""}`, lines: [`${name} asked for a call from the website.`, `Phone: ${customer.Primary_Phone__c ?? "—"} · Email: ${customer.Primary_Email__c ?? "—"}`, `Address: ${[customer.Street__c, customer.City__c, customer.State__c, customer.Postal_Code__c].filter(Boolean).join(", ") || "—"}`, message ? `They wrote: ${message}` : "They didn't describe the issue.", `The job is in Needs Intake Review in Sundial.`] });
      return jsonResponse(201, cors, { success: true, jobNumber: number });
    },

    /** Emails a Stripe customer-portal link to the member. Always 200 — never says whether the email is known. */
    async clubManage({ params, body, cors }) {
      const t = await publicTenant(params, cors);
      if (t.response) return t.response;
      const email = strOrNull(body?.email)?.toLowerCase() ?? null;
      const generic = jsonResponse(200, cors, { sent: true, message: "If that email belongs to a Service Club member, a link to manage the membership is on its way." });
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return generic;
      try {
        const stripe = await stripeFor(t.slug);
        const base = publicBase();
        if (!stripe || !base) return generic;
        const customers = await d.sfQuery(`SELECT Id, Name, Primary_Email__c, Stripe_Customer_Id__c, Active_Membership__c FROM ${CUSTOMER_SF_OBJECT} WHERE Primary_Email__c = '${soqlEscapeString(email)}' AND Client__c = '${soqlEscapeString(t.tenantId)}' AND Active_Membership__c != null LIMIT 3`);
        for (const c of customers || []) {
          if (!c.Stripe_Customer_Id__c) continue;
          const session = await stripe.client.post("billing_portal/sessions", { customer: c.Stripe_Customer_Id__c, return_url: `${base}/club` });
          await emailCustomer(c.Primary_Email__c, { subject: `Manage your ${brandName(t.ctx) || ""} Service Club membership`.replace("  ", " "), lines: [`Hi ${(c.Name || "").split(" ")[0] || "there"},`, "Use the link below to update your card, see your receipts or change your membership. It works for a short while, so open it soon.", "If you didn't ask for this, you can ignore it."], cta: { label: "Manage my membership", url: session.url } });
          await h.act(publicCtx(t.tenantId, t.slug, cors), { event: EVENTS.MEMBERSHIP_UPDATED, recordType: "membership", recordSfId: c.Active_Membership__c, details: { portalLinkEmailed: true } });
        }
      } catch (e) {
        console.error("club manage:", e?.message || e);
      }
      return generic;
    },

    // --- office --------------------------------------------------------------------
    async clubPlansOffice({ ctx }) {
      const { tenantId, cors } = ctx;
      const [rows, stripe] = await Promise.all([loadPlans(tenantId), stripeFor(ctx.tenantSlug)]);
      return jsonResponse(200, cors, { plans: rows.map(planToView), stripeConfigured: !!stripe, stripeMode: stripe?.config?.mode ?? null });
    },

    async clubPatchPlan({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const plan = await loadPlan(params[0], tenantId);
      if (!plan) return notFound(cors);
      const MAP = {
        name: ["Name", (v) => strOrNull(v)?.slice(0, 80)],
        availability: ["Availability__c", (v) => (["Available", "Coming Soon", "Hidden", "Retired"].includes(v) ? v : undefined)],
        sortOrder: ["Sort_Order__c", (v) => (v == null ? null : Number(v))],
        highlight: ["Highlight__c", (v) => strOrNull(v)?.slice(0, 40) ?? null],
        tagline: ["Tagline__c", (v) => strOrNull(v)?.slice(0, 255) ?? null],
        features: ["Features__c", (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean).join("\n") : strOrNull(v))],
        monthlyPrice: ["Monthly_Price__c", (v) => (v == null || v === "" ? null : money(v))],
        yearlyPrice: ["Yearly_Price__c", (v) => (v == null || v === "" ? null : money(v))],
        price: ["Price__c", (v) => (v == null || v === "" ? null : money(v))],
        priceBookItemCode: ["Price_Book_Item_Code__c", (v) => strOrNull(v)?.slice(0, 40) ?? null],
        discountScope: ["Discount_Scope__c", (v) => (["Labor", "Material", "Both"].includes(v) ? v : undefined)],
        discountType: ["Discount_Type__c", (v) => (["Percent", "Amount"].includes(v) ? v : undefined)],
        discountValue: ["Discount_Value__c", (v) => (v == null || v === "" ? null : money(v))],
        discountDescription: ["Discount_Description__c", (v) => strOrNull(v)?.slice(0, 255) ?? null],
        includesTuneUp: ["Includes_Tune_Up__c", (v) => v === true],
        includesCleaning: ["Includes_Cleaning__c", (v) => v === true],
        notes: ["Notes__c", (v) => strOrNull(v)?.slice(0, 255) ?? null],
      };
      const fields = {};
      const rejected = [];
      for (const [k, v] of Object.entries(body || {})) {
        if (!MAP[k]) {
          rejected.push(k);
          continue;
        }
        const out = MAP[k][1](v);
        if (out === undefined) rejected.push(k);
        else fields[MAP[k][0]] = out;
      }
      if (!Object.keys(fields).length) return bad(cors, "NO_FIELDS", "Nothing to update.", { rejectedFields: rejected });
      try {
        await d.sfUpdateRecord(PLAN_SF_OBJECT, plan.Id, fields);
      } catch (e) {
        return sfError(cors, e, "plan update");
      }
      Object.assign(plan, fields);
      const warnings = [];
      // A price change = a new Stripe Price (the old one archived), so the next join sells at the new amount.
      if (plan.Kind__c === "Subscription" && ("Monthly_Price__c" in fields || "Yearly_Price__c" in fields || "Name" in fields)) {
        const stripe = await stripeFor(ctx.tenantSlug);
        if (!stripe) warnings.push("Stripe isn't configured — the price changed in Sundial only.");
        else {
          try {
            const back = await syncPlanPrices(stripe.client, plan, { tenant: ctx.tenantSlug });
            if (Object.keys(back).length) {
              await d.sfUpdateRecord(PLAN_SF_OBJECT, plan.Id, back);
              Object.assign(plan, back);
            }
          } catch (e) {
            warnings.push(`Stripe price update failed: ${e?.message || e}`);
          }
        }
      }
      await h.markStale(CLUB_CACHE.plan, [plan.Id], tenantId);
      await h.act(ctx, { event: EVENTS.FIELD_UPDATED, recordType: "serviceplan", recordSfId: plan.Id, details: { fields: Object.keys(fields) } });
      return jsonResponse(200, cors, { success: true, plan: planToView(plan), rejectedFields: rejected, warnings });
    },

    async clubMemberships({ ctx, query }) {
      const { tenantId, cors } = ctx;
      const status = strOrNull(query?.status);
      const q = strOrNull(query?.q);
      const where = [`Client__c = '${soqlEscapeString(tenantId)}'`];
      if (status && status !== "all") where.push(`Status__c = '${soqlEscapeString(status)}'`);
      if (q) {
        const like = `'%${soqlEscapeString(q).replace(/[%_]/g, " ")}%'`;
        where.push(`(Name LIKE ${like} OR Customer_Name_at_Creation__c LIKE ${like} OR Primary_Email_at_Creation__c LIKE ${like} OR Primary_Phone_at_Creation__c LIKE ${like} OR Address_at_Creation__c LIKE ${like})`);
      }
      const [rows, plans] = await Promise.all([d.sfQuery(`SELECT ${MEMBERSHIP_SELECT} FROM ${MEMBERSHIP_SF_OBJECT} WHERE ${where.join(" AND ")} ORDER BY CreatedDate DESC LIMIT 500`), loadPlans(tenantId)]);
      const planById = new Map(plans.map((p) => [p.Id, p]));
      return jsonResponse(200, cors, { status: status || null, q, memberships: (rows || []).map((m) => membershipToView(m, planById.get(m.Service_Plan__c))), plans: plans.map(planToView) });
    },

    async clubReport({ ctx }) {
      const { tenantId, cors } = ctx;
      const [rows, plans] = await Promise.all([d.sfQuery(`SELECT ${MEMBERSHIP_SELECT} FROM ${MEMBERSHIP_SF_OBJECT} WHERE Client__c = '${soqlEscapeString(tenantId)}' AND Status__c != 'Expired' LIMIT 2000`, { maxRecords: 2000 }), loadPlans(tenantId)]);
      const summary = summarizeMemberships(rows || [], plans);
      // Revenue from the Stripe ledger: every invoice.paid we applied, by month.
      const revenue = { last30Days: 0, thisMonth: 0, yearToDate: 0, byMonth: [] };
      try {
        const supabase = await d.getSupabaseClient();
        const since = new Date(d.now().getFullYear(), 0, 1).toISOString();
        const { data, error } = await supabase.from("sundial_stripe_events").select("amount, received_at").eq("client_sf_id", tenantId).in("type", ["invoice.paid", "invoice.payment_succeeded"]).eq("status", "applied").gte("received_at", since).limit(5000);
        if (error) throw new Error(error.message);
        const now = d.now();
        const monthKey = (iso) => iso.slice(0, 7);
        const byMonth = new Map();
        for (const r of data || []) {
          const amt = Number(r.amount) || 0;
          const at = new Date(r.received_at);
          revenue.yearToDate += amt;
          if (now.getTime() - at.getTime() <= 30 * 86400000) revenue.last30Days += amt;
          if (monthKey(r.received_at) === monthKey(now.toISOString())) revenue.thisMonth += amt;
          byMonth.set(monthKey(r.received_at), (byMonth.get(monthKey(r.received_at)) || 0) + amt);
        }
        revenue.byMonth = [...byMonth.entries()].sort().map(([month, amount]) => ({ month, amount: money(amount) }));
        for (const k of ["last30Days", "thisMonth", "yearToDate"]) revenue[k] = money(revenue[k]);
      } catch (e) {
        console.error("club report: ledger read failed:", e?.message || e);
      }
      // Who is owed a visit this year: live members on a plan with a tune-up / cleaning.
      const planById = new Map(plans.map((p) => [p.Id, p]));
      const owed = (rows || []).filter((m) => LIVE_STATUSES.has(m.Status__c)).map((m) => ({ m, p: planById.get(m.Service_Plan__c) })).filter(({ p }) => p && (p.Includes_Tune_Up__c || p.Includes_Cleaning__c)).map(({ m, p }) => ({ membershipId: m.Id, number: m.Name, customerId: m.Sundial_Customer__c, customerName: m.Customer_Name_at_Creation__c, plan: p.Name, tuneUp: p.Includes_Tune_Up__c === true, cleaning: p.Includes_Cleaning__c === true, startedAt: m.Started_At__c ?? null }));
      return jsonResponse(200, cors, { ...summary, revenue, owedVisits: owed, plans: plans.map(planToView) });
    },

    async clubCustomer({ ctx, params }) {
      const { tenantId, cors } = ctx;
      if (!SF_ID_RE.test(params[0] || "")) return notFound(cors);
      const { customer, membership, plan } = await activeMembershipFor(params[0], tenantId);
      if (!customer) return notFound(cors);
      const history = await loadCustomerMemberships(customer.Id, tenantId);
      const plans = await loadPlans(tenantId);
      const planById = new Map(plans.map((p) => [p.Id, p]));
      return jsonResponse(200, cors, { customerId: customer.Id, active: membership ? membershipToView(membership, plan) : null, discount: membership ? planDiscountFields(plan, membership.Id) : null, history: history.map((m) => membershipToView(m, planById.get(m.Service_Plan__c))) });
    },

    /** The office records a member and gets the join link (Ben's migration; a phone signup). */
    async clubCreateMembership({ ctx, body }) {
      const { tenantId, cors } = ctx;
      const customerId = strOrNull(body?.customerId);
      const customer = await loadCustomer(customerId, tenantId);
      if (!customer) return bad(cors, "CUSTOMER_REQUIRED", "customerId must be a customer in this tenant.");
      const plan = body?.planId ? await loadPlan(String(body.planId), tenantId) : await loadPlanByCode(strOrNull(body?.planCode)?.toLowerCase(), tenantId);
      if (!plan || plan.Kind__c !== "Subscription") return bad(cors, "PLAN_REQUIRED", "planCode / planId must name a subscription plan.");
      if (plan.Availability__c === "Retired") return jsonResponse(409, cors, { error: "not_available", code: "PLAN_NOT_AVAILABLE" });
      const intervalKey = strOrNull(body?.interval)?.toLowerCase() || "monthly";
      if (!INTERVALS[intervalKey]) return bad(cors, "INTERVAL_INVALID", "interval must be monthly or yearly.");
      const source = body?.source === "Migrated" ? "Migrated" : "Office";
      const started = await startJoin({ ctx, customer, plan, interval: INTERVALS[intervalKey], source, notes: strOrNull(body?.notes)?.slice(0, 255) ?? null, cors });
      if (!started.ok) return started.response;
      let emailed = false;
      if (body?.email === true && customer.Primary_Email__c) {
        const r = await emailCustomer(customer.Primary_Email__c, {
          subject: `Complete your ${brandName(ctx) || ""} Service Club membership`.replace("  ", " "),
          lines: [`Hi ${customer.First_Name__c || (customer.Name || "").split(" ")[0] || "there"},`, `Here's your link to set up the ${plan.Name} (${started.price.toFixed(2)} ${intervalKey}). It takes a minute: enter your card on the secure payment page and you're a member.`, "Questions? Just reply to this email or give us a call."],
          cta: { label: `Join the ${plan.Name}`, url: started.url },
        });
        emailed = r.sent;
      }
      return jsonResponse(201, cors, { success: true, membershipId: started.membershipId, url: started.url, emailed, plan: plan.Name, interval: INTERVALS[intervalKey], price: started.price, mode: started.mode });
    },

    async clubCancel({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const m = await loadMembership(params[0], tenantId);
      if (!m) return notFound(cors);
      const reason = strOrNull(body?.reason)?.slice(0, 255) ?? null;
      const immediately = body?.immediately === true;
      const now = d.now().toISOString();
      if (m.Status__c === "Cancelled" || m.Status__c === "Expired") return jsonResponse(409, cors, { error: "already_ended", code: "MEMBERSHIP_ENDED", status: m.Status__c });
      if (!m.Stripe_Subscription_Id__c) {
        // Never activated: nothing in Stripe to cancel.
        await d.sfUpdateRecord(MEMBERSHIP_SF_OBJECT, m.Id, { Status__c: "Expired", Cancelled_At__c: now, Ended_At__c: now, Cancel_Reason__c: reason });
        await h.markStale(CLUB_CACHE.membership, [m.Id], tenantId);
        await clearActivePointer(m.Sundial_Customer__c, m.Id, tenantId);
        await h.act(ctx, { event: EVENTS.MEMBERSHIP_CANCELLED, recordType: "membership", recordSfId: m.Id, details: { from: m.Status__c, to: "Expired", reason, neverActivated: true } });
        return jsonResponse(200, cors, { success: true, status: "Expired" });
      }
      const stripe = await stripeFor(ctx.tenantSlug);
      if (!stripe) return jsonResponse(503, cors, { error: "not_configured", code: "STRIPE_NOT_CONFIGURED" });
      try {
        if (immediately) await stripe.client.del(`subscriptions/${encodeURIComponent(m.Stripe_Subscription_Id__c)}`);
        else await stripe.client.post(`subscriptions/${encodeURIComponent(m.Stripe_Subscription_Id__c)}`, { cancel_at_period_end: true, ...(reason ? { cancellation_details: { comment: reason } } : {}) });
      } catch (e) {
        return jsonResponse(502, cors, { error: "stripe_error", code: e instanceof StripeError ? e.code || "STRIPE_ERROR" : "STRIPE_ERROR", message: e?.message || "Stripe could not cancel the subscription." });
      }
      const upd = { Cancelled_At__c: now, Cancel_Reason__c: reason, Cancel_At_Period_End__c: !immediately };
      if (immediately) {
        upd.Status__c = "Cancelled";
        upd.Ended_At__c = now;
      }
      await d.sfUpdateRecord(MEMBERSHIP_SF_OBJECT, m.Id, upd);
      Object.assign(m, upd);
      await h.markStale(CLUB_CACHE.membership, [m.Id], tenantId);
      let sf = null;
      if (immediately) {
        await clearActivePointer(m.Sundial_Customer__c, m.Id, tenantId);
        const plan = await loadPlan(m.Service_Plan__c, tenantId);
        sf = await postSolarFacts({ membership: m, plan, event: "member.cancelled", slug: ctx.tenantSlug, cfg: await clubConfig(ctx.tenantSlug) });
      }
      await h.act(ctx, { event: EVENTS.MEMBERSHIP_CANCELLED, recordType: "membership", recordSfId: m.Id, details: { immediately, reason, periodEnd: m.Current_Period_End__c ?? null, solarFacts: sf?.sent ?? null } });
      return jsonResponse(200, cors, { success: true, status: m.Status__c, cancelAtPeriodEnd: !immediately, currentPeriodEnd: m.Current_Period_End__c ?? null, solarFacts: sf?.sent ?? null });
    },

    async clubResendSolarFacts({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const m = await loadMembership(params[0], tenantId);
      if (!m) return notFound(cors);
      const plan = await loadPlan(m.Service_Plan__c, tenantId);
      const event = m.Status__c === "Cancelled" || m.Status__c === "Expired" ? "member.cancelled" : "member.activated";
      const r = await postSolarFacts({ membership: m, plan, event, slug: ctx.tenantSlug, cfg: await clubConfig(ctx.tenantSlug) });
      await h.markStale(CLUB_CACHE.membership, [m.Id], tenantId);
      await h.act(ctx, { event: EVENTS.MEMBERSHIP_UPDATED, recordType: "membership", recordSfId: m.Id, details: { solarFactsResend: event, sent: r.sent, reason: r.reason ?? null } });
      const back = await loadMembership(m.Id, tenantId);
      return jsonResponse(r.sent ? 200 : 502, cors, { success: r.sent, event, via: r.via ?? null, reason: r.reason ?? null, membership: membershipToView(back, plan) });
    },

    /** Put the member's plan discount on an existing estimate. */
    async applyPlanDiscount({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const est = await h.loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      if (est.Status__c === "Invoiced") return jsonResponse(409, cors, { error: "locked", code: "ESTIMATE_INVOICED" });
      if (!est.Sundial_Customer__c) return jsonResponse(409, cors, { error: "no_customer", code: "ESTIMATE_NO_CUSTOMER" });
      const { membership, plan } = await activeMembershipFor(est.Sundial_Customer__c, tenantId);
      if (!membership) return jsonResponse(409, cors, { error: "not_member", code: "NOT_A_MEMBER", message: "This customer has no active Service Club membership." });
      const fields = planDiscountFields(plan, membership.Id);
      if (!fields) return jsonResponse(409, cors, { error: "no_discount", code: "PLAN_NO_DISCOUNT", message: `${plan.Name} carries no estimate discount.` });
      try {
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, fields);
      } catch (e) {
        return sfError(cors, e, "plan discount");
      }
      const { totals } = await h.recomputeAndStore({ ...est, ...fields }, tenantId);
      await h.act(ctx, { event: EVENTS.ESTIMATE_UPDATED, recordType: "estimate", recordSfId: est.Id, estimateSfId: est.Id, jobSfId: est.Service_Job__c ?? null, details: { planDiscount: { plan: plan.Name, scope: fields.Discount_Scope__c, type: fields.Discount_Type__c, value: fields.Discount_Value__c }, total: totals.total } });
      return jsonResponse(200, cors, { success: true, id: est.Id, totals: totals.fields, plan: plan.Name, discount: { scope: fields.Discount_Scope__c, type: fields.Discount_Type__c, value: fields.Discount_Value__c, description: plan.Discount_Description__c ?? null } });
    },
  };

  return { handlers: H, applyEvent, discountForCustomer, activeMembershipFor, syncPlanPrices };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
