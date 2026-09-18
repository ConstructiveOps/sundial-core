// lib/stripe.js — the client's encoding, the secret resolution, and the signature gate
// (the only thing standing between the internet and a "paid" invoice).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createStripeClient, defaultPaymentMethod, ensureStripeCustomer, formEncode, fromCents, stripeConfigFor, stripeForTenant, StripeError, toCents, verifyWebhookSignature } from "./stripe.js";

test("cents never float; form encoding nests the way Stripe expects", () => {
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(fromCents(1999), 19.99);
  const enc = formEncode({
    mode: "payment",
    customer: "cus_1",
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 1999, product_data: { name: "Deposit" } } }],
    metadata: { jobId: "J1", kind: "deposit" },
    payment_intent_data: { setup_future_usage: "off_session" },
    skip: null,
    flag: true,
  });
  assert.equal(
    enc,
    "mode=payment&customer=cus_1&line_items%5B0%5D%5Bquantity%5D=1&line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=usd&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=1999&line_items%5B0%5D%5Bprice_data%5D%5Bproduct_data%5D%5Bname%5D=Deposit&metadata%5BjobId%5D=J1&metadata%5Bkind%5D=deposit&payment_intent_data%5Bsetup_future_usage%5D=off_session&flag=true"
  );
});

test("secret resolution: per-tenant entry first, flat fallback, nothing → null; mode from the key prefix", () => {
  const secret = { tenants: { harmon: { secretKey: "sk_live_h", webhookSecret: "whsec_h" } }, secretKey: "sk_test_flat", webhookSecret: "whsec_flat" };
  assert.deepEqual(stripeConfigFor(secret, "harmon"), { secretKey: "sk_live_h", webhookSecret: "whsec_h", mode: "live" });
  assert.deepEqual(stripeConfigFor(secret, "other"), { secretKey: "sk_test_flat", webhookSecret: "whsec_flat", mode: "test" });
  assert.equal(stripeConfigFor({ tenants: { harmon: { secretKey: "sk_test_h" } } }, "other"), null);
  assert.equal(stripeConfigFor({ tenants: { harmon: { secretKey: "sk_test_h" } } }, "harmon").webhookSecret, null);
  assert.equal(stripeConfigFor(null, "harmon"), null);
  assert.equal(stripeConfigFor({}, "harmon"), null);
});

test("webhook signature: the exact raw body, within tolerance, constant-time; every refusal names its reason", () => {
  const secret = "whsec_test";
  const body = '{"id":"evt_1","type":"payment_intent.succeeded"}';
  const t = 1_800_000_000;
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const now = t * 1000 + 60_000;
  assert.deepEqual(verifyWebhookSignature({ header: `t=${t},v1=${sig}`, rawBody: body, secret, now }), { ok: true, reason: null });
  // Two v1 entries (Stripe sends more than one during a secret rotation): any match wins.
  assert.equal(verifyWebhookSignature({ header: `t=${t},v1=deadbeef,v1=${sig}`, rawBody: body, secret, now }).ok, true);
  // A Buffer body (API Gateway base64) verifies the same.
  assert.equal(verifyWebhookSignature({ header: `t=${t},v1=${sig}`, rawBody: Buffer.from(body), secret, now }).ok, true);
  assert.equal(verifyWebhookSignature({ header: `t=${t},v1=${sig}`, rawBody: body + " ", secret, now }).reason, "signature mismatch");
  assert.equal(verifyWebhookSignature({ header: `t=${t},v1=${sig}`, rawBody: body, secret: "whsec_other", now }).reason, "signature mismatch");
  assert.equal(verifyWebhookSignature({ header: `t=${t},v1=${sig}`, rawBody: body, secret, now: now + 6 * 60_000 }).reason, "timestamp outside tolerance");
  assert.equal(verifyWebhookSignature({ header: `v1=${sig}`, rawBody: body, secret, now }).reason, "malformed header (no timestamp)");
  assert.equal(verifyWebhookSignature({ header: `t=${t}`, rawBody: body, secret, now }).reason, "malformed header (no v1 signature)");
  assert.equal(verifyWebhookSignature({ header: null, rawBody: body, secret, now }).reason, "missing Stripe-Signature header");
  assert.equal(verifyWebhookSignature({ header: `t=${t},v1=${sig}`, rawBody: body, secret: null, now }).reason, "no webhook secret configured");
});

test("client: bearer + version + form body + idempotency key; a Stripe error carries its code; customer find-or-create; default card", async () => {
  const calls = [];
  const fetchUrl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/customers/cus_gone")) return { ok: false, status: 404, json: async () => ({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such customer" } }) };
    if (url.endsWith("/customers/cus_ok")) return { ok: true, status: 200, json: async () => ({ id: "cus_ok", invoice_settings: { default_payment_method: "pm_default" } }) };
    if (url.endsWith("/customers/cus_nodefault")) return { ok: true, status: 200, json: async () => ({ id: "cus_nodefault", invoice_settings: { default_payment_method: null } }) };
    if (url.startsWith("https://api.stripe.com/v1/payment_methods?")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "pm_first" }] }) };
    if (url.endsWith("/customers") && init.method === "POST") return { ok: true, status: 200, json: async () => ({ id: "cus_new" }) };
    if (url.endsWith("/payment_intents") && init.method === "POST") return { ok: false, status: 402, json: async () => ({ error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." } }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const client = createStripeClient({ secretKey: "sk_test_x", fetchUrl });

  assert.equal(await ensureStripeCustomer(client, { existingId: "cus_ok" }), "cus_ok");
  assert.equal(await ensureStripeCustomer(client, { existingId: "cus_gone", name: "Cy Diaz", email: "cy@example.com", metadata: { sundialCustomerId: "CUS1" } }), "cus_new");
  const create = calls.find((c) => c.url.endsWith("/customers") && c.init.method === "POST");
  assert.equal(create.init.headers.Authorization, "Bearer sk_test_x");
  assert.equal(create.init.headers["Stripe-Version"], "2024-06-20");
  assert.equal(create.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.ok(create.init.headers["Idempotency-Key"]);
  assert.equal(create.init.body, "name=Cy%20Diaz&email=cy%40example.com&metadata%5BsundialCustomerId%5D=CUS1");

  assert.equal(await defaultPaymentMethod(client, "cus_ok"), "pm_default");
  assert.equal(await defaultPaymentMethod(client, "cus_nodefault"), "pm_first");

  await assert.rejects(
    () => client.post("payment_intents", { amount: 100 }, { idempotencyKey: "k1" }),
    (e) => e instanceof StripeError && e.status === 402 && e.code === "card_declined" && e.declineCode === "insufficient_funds" && /insufficient funds/.test(e.message)
  );
  assert.equal(calls.at(-1).init.headers["Idempotency-Key"], "k1");

  // DELETE (a subscription cancelled now, D-073): no body, no idempotency key, the path as given.
  await client.del("subscriptions/sub_1");
  assert.equal(calls.at(-1).url, "https://api.stripe.com/v1/subscriptions/sub_1");
  assert.equal(calls.at(-1).init.method, "DELETE");
  assert.equal(calls.at(-1).init.body, undefined);

  // No secret for the tenant → null, never a throw.
  assert.equal(await stripeForTenant("harmon", { getSecret: async () => ({}) }), null);
  assert.equal(await stripeForTenant("harmon", { getSecret: async () => { throw Object.assign(new Error("x"), { name: "ResourceNotFoundException" }); } }), null);
  const s = await stripeForTenant("harmon", { getSecret: async () => ({ tenants: { harmon: { secretKey: "sk_test_h", webhookSecret: "w" } } }), fetchUrl });
  assert.equal(s.config.mode, "test");
  assert.equal(typeof s.client.post, "function");
});
