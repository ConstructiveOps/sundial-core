// lib/stripe.js — the ONE way Sundial talks to Stripe (D-072 amendment 8, 2026-09-17).
//
// Deliberately a small REST client over fetch rather than the `stripe` npm package: the
// handful of calls Sundial makes (a customer, a Checkout Session, an off-session
// PaymentIntent, a refund lookup, a webhook signature check) fit in a page, and a page
// we own is easier to read than an SDK we bundle into four Lambdas.
//
// Keys live in Secrets Manager `sundial/stripe`, PER TENANT — Harmon pays on Harmon's
// own Stripe account (D-065 decision 6), a second tenant on theirs:
//
//   { "tenants": { "harmon": { "secretKey": "sk_…", "webhookSecret": "whsec_…" } } }
//
// A flat `{ secretKey, webhookSecret }` at the top level is the fallback for a tenant
// with no entry (a single-tenant install). Never a key in code, an env var or the browser;
// the browser only ever sees a Checkout Session URL.
//
// Money is in whole cents everywhere Stripe is concerned; the callers pass dollars.

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { getSecret as realGetSecret } from "./secrets.js";

export const STRIPE_SECRET_NAME = "sundial/stripe";
export const STRIPE_API = "https://api.stripe.com/v1";
export const STRIPE_API_VERSION = "2024-06-20";
/** Stripe recommends rejecting signatures older than 5 minutes (replay window). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Dollars → integer cents, never a float in a Stripe amount. */
export const toCents = (dollars) => Math.round((Number(dollars) || 0) * 100);
export const fromCents = (cents) => Math.round(Number(cents) || 0) / 100;

/**
 * The tenant's keys from the secret. Returns null when nothing is configured for the
 * tenant — callers treat that as "payments are not set up yet" (a 503 with a plain
 * message), never as an exception.
 */
export function stripeConfigFor(secret, tenantSlug) {
  if (!secret || typeof secret !== "object") return null;
  const t = tenantSlug && secret.tenants && typeof secret.tenants === "object" ? secret.tenants[tenantSlug] : null;
  const cfg = t && typeof t === "object" ? t : secret.secretKey ? secret : null;
  if (!cfg || typeof cfg.secretKey !== "string" || !cfg.secretKey) return null;
  return { secretKey: cfg.secretKey, webhookSecret: typeof cfg.webhookSecret === "string" ? cfg.webhookSecret : null, mode: cfg.secretKey.startsWith("sk_live_") ? "live" : "test" };
}

/**
 * Stripe's form encoding: nested objects as bracketed keys (`metadata[jobId]=…`,
 * `line_items[0][price_data][unit_amount]=…`), arrays by index, booleans as words,
 * null/undefined dropped.
 */
export function formEncode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null || v === undefined) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" && item !== null ? formEncode(item, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`)));
    else if (typeof v === "object") formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return prefix ? out : out.join("&");
}

/**
 * Verify a `Stripe-Signature` header against the RAW request body (the bytes as sent —
 * a re-serialised JSON body would not match). Constant-time compare; every failure is
 * a reason string so the log says which gate refused. Returns { ok, reason }.
 */
export function verifyWebhookSignature({ header, rawBody, secret, now = Date.now(), tolerance = SIGNATURE_TOLERANCE_SECONDS }) {
  if (!secret) return { ok: false, reason: "no webhook secret configured" };
  if (!header || typeof header !== "string") return { ok: false, reason: "missing Stripe-Signature header" };
  const parts = Object.create(null);
  for (const kv of header.split(",")) {
    const i = kv.indexOf("=");
    if (i < 0) continue;
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim();
    if (k === "v1") (parts.v1 ||= []).push(v);
    else parts[k] = v;
  }
  const t = Number(parts.t);
  if (!Number.isFinite(t)) return { ok: false, reason: "malformed header (no timestamp)" };
  if (!parts.v1?.length) return { ok: false, reason: "malformed header (no v1 signature)" };
  if (Math.abs(Math.floor(now / 1000) - t) > tolerance) return { ok: false, reason: "timestamp outside tolerance" };
  const body = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody || "").toString("utf8");
  const expected = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  const eb = Buffer.from(expected, "utf8");
  const match = parts.v1.some((sig) => {
    const sb = Buffer.from(String(sig), "utf8");
    return sb.length === eb.length && timingSafeEqual(sb, eb);
  });
  return match ? { ok: true, reason: null } : { ok: false, reason: "signature mismatch" };
}

/** A StripeError carries Stripe's own code/message so the office sees the real reason. */
export class StripeError extends Error {
  constructor(status, body, where) {
    const err = body?.error || {};
    super(err.message || `Stripe ${where} failed (${status})`);
    this.name = "StripeError";
    this.status = status;
    this.code = err.code || err.type || null;
    this.declineCode = err.decline_code || null;
    this.where = where;
    this.stripe = err;
  }
}

/**
 * The client. `fetchUrl` is injectable so tests never touch the network.
 *   const stripe = createStripeClient({ secretKey })
 *   await stripe.post("checkout/sessions", {...}, { idempotencyKey })
 *   await stripe.get("payment_intents/pi_…")
 */
export function createStripeClient({ secretKey, fetchUrl = (url, init) => fetch(url, { signal: AbortSignal.timeout(15000), ...init }) }) {
  if (!secretKey) throw new Error("stripe: no secret key");
  async function call(method, path, params, { idempotencyKey } = {}) {
    const headers = { Authorization: `Bearer ${secretKey}`, "Stripe-Version": STRIPE_API_VERSION };
    let url = `${STRIPE_API}/${path}`;
    let body;
    if (method === "GET") {
      const qs = params ? formEncode(params) : "";
      if (qs) url += `?${qs}`;
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = formEncode(params || {});
      if (idempotencyKey) headers["Idempotency-Key"] = String(idempotencyKey).slice(0, 255);
    }
    let res;
    try {
      res = await fetchUrl(url, { method, headers, body });
    } catch (e) {
      throw new StripeError(0, { error: { type: "network", message: e?.message || String(e) } }, path);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new StripeError(res.status, json, path);
    return json;
  }
  return {
    get: (path, params) => call("GET", path, params),
    post: (path, params, opts) => call("POST", path, params, opts || { idempotencyKey: randomUUID() }),
  };
}

/**
 * Resolve the tenant's client + config in one go. `null` when payments are not set up
 * for this tenant (no secret, no entry, no key) — callers answer 503 STRIPE_NOT_CONFIGURED.
 */
export async function stripeForTenant(tenantSlug, { getSecret = realGetSecret, fetchUrl } = {}) {
  let secret = null;
  try {
    secret = await getSecret(STRIPE_SECRET_NAME);
  } catch (e) {
    if (!/ResourceNotFound/i.test(e?.name || e?.message || "")) console.error("stripe secret:", e?.message || e);
    return null;
  }
  const cfg = stripeConfigFor(secret, tenantSlug);
  if (!cfg) return null;
  return { config: cfg, client: createStripeClient({ secretKey: cfg.secretKey, ...(fetchUrl ? { fetchUrl } : {}) }) };
}

/** Find-or-create the Stripe customer for a Sundial customer record. Returns the Stripe id. */
export async function ensureStripeCustomer(client, { existingId, name, email, phone, metadata }) {
  if (existingId) {
    try {
      const c = await client.get(`customers/${encodeURIComponent(existingId)}`);
      if (c && !c.deleted) return c.id;
    } catch (e) {
      if (e?.status !== 404) throw e; // a deleted / foreign-account id falls through to a fresh customer
    }
  }
  const created = await client.post("customers", { name: name || undefined, email: email || undefined, phone: phone || undefined, metadata: metadata || undefined });
  return created.id;
}

/** The customer's default card, if any: from invoice_settings, else the first attached card. */
export async function defaultPaymentMethod(client, customerId) {
  const c = await client.get(`customers/${encodeURIComponent(customerId)}`);
  const pm = c?.invoice_settings?.default_payment_method;
  if (pm) return typeof pm === "string" ? pm : pm.id;
  const list = await client.get("payment_methods", { customer: customerId, type: "card", limit: 1 });
  return list?.data?.[0]?.id ?? null;
}
