# Stripe — card on file, deposits, off-session charges, refunds (D-072 amendment 8)

**Built 2026-09-17.** Harmon pays on **Harmon's own Stripe account** (D-065 decision 6). Sundial
never sees a card number: the customer pays on a Stripe-hosted Checkout page, Stripe keeps the
card, and Stripe tells Sundial what happened through a signed webhook. Everything money-shaped
lands in the one place money is settled — `settleMoney()` in `invoice.js` — so a Stripe payment,
a check and a refund all move the invoice and the job the same way.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| Keys | Secrets Manager **`sundial/stripe`** | Per tenant: `{ "tenants": { "harmon": { "secretKey": "sk_…", "webhookSecret": "whsec_…" } } }` |
| Client + signature check | `lib/stripe.js` | A page of REST over `fetch` (no SDK); `verifyWebhookSignature` (HMAC-SHA256, 5-min tolerance, constant-time) |
| Customer side | `lambdas/sundial-service-public` → `POST /public/estimates/{token}/checkout` | A Checkout Session: `setup` (card on file, nothing charged), `deposit` (charges the deposit AND keeps the card), `balance` (pays the live invoice). The step is **re-derived from the records** — the page's word for it is never trusted |
| Stripe → Sundial | `lambdas/sundial-service-estimate/stripe.js` → `POST /webhooks/stripe/{tenant}` | Signature-gated. `checkout.session.completed` (card on file), `payment_intent.succeeded` (a Payment row), `payment_intent.payment_failed` (a Failed row), `charge.refunded` (a Refund row) |
| Office side | same file → `POST /service/invoices/{id}/charge`, and `chargeCard: true` on issue | Off-session charge of the balance on the card on file. PaymentIntent → **Pending row first** → confirm, so the webhook only ever updates an existing row |
| Ledger | Supabase `sundial_stripe_events` (`sql/sundial_stripe_events.sql`) | One row per Stripe event id: applied / deferred / ignored / error. A redelivered event is a no-op |
| Portal | `PublicEstimatePage` (the customer), `JobInvoiceCard` (the office) | The money step after Approve; "Charge card on file $X" and the issue-time tick |

**Idempotency, in one sentence:** the PaymentIntent id is the key on `Sundial_Service_Payment__c`
(`Stripe_Payment_Intent_Id__c`), a refund's id on `Stripe_Refund_Id__c`, and Stripe's event id on
the ledger — every path looks before it writes.

**Money before the job exists.** The customer often pays the deposit at approval, before the
office has clicked Create Job. A Payment row needs a job, so the webhook **defers**: it stamps
`Deposit_Paid_At__c` on the estimate, keeps the event in the ledger as `deferred`, and Create Job
writes the Payment row (and the card-on-file flag) then. The office sees "Deposit Paid" on the
job the moment it exists.

**What the customer sees.** After Approve the page offers exactly one step: the deposit (if
the estimate requires one and it is unpaid), else "Keep a card on file" (if none), else — once the
invoice is issued — "Pay SVC-00042 — $440.07". A partner-billed job never asks the customer for
a card. If Stripe is not configured for the tenant the page says "Online payment isn't set up
yet — we'll take care of it over the phone." instead of a dead button.

## Setup (Tim) — do it in TEST mode first, then repeat with live keys

1. **Keys.** Stripe Dashboard → Developers → API keys. Create a **restricted key** (not the
   full secret) with **Write** on Customers, Checkout Sessions, PaymentIntents, SetupIntents,
   Payment Methods, and **Read** on Charges and Refunds. Copy it once.
2. **Webhook.** Developers → Webhooks → Add endpoint →
   `https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod/webhooks/stripe/harmon`
   (the last segment is the tenant slug — `Sundial_Tenant__c.Name`). Events:
   `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`,
   `charge.refunded`. Copy the **signing secret** (`whsec_…`).
3. **Secrets Manager** → Store a new secret → *Other type* → plaintext →
   ```json
   { "tenants": { "harmon": { "secretKey": "sk_test_…", "webhookSecret": "whsec_…" } } }
   ```
   name **`sundial/stripe`**. (A second tenant is a second entry; the Lambdas read `sundial/*`.)
   Test and live keys are the same shape — swap the values when you go live; the code tells them
   apart by the key prefix and refuses a live event on test keys (and vice versa).
4. **SQL.** Supabase SQL editor: `sql/sundial_stripe_events.sql`.
5. **Lambdas.** `.\deploy.ps1 sundial-service-estimate`, `.\deploy.ps1 sundial-service-public`.
   On **`sundial-service-public`** add the env var `SERVICE_PUBLIC_BASE_URL` (the portal's URL, no
   trailing slash — the same value the estimate Lambda has) so Stripe can send the customer back.
6. **Routes.** `.\scripts\wire-service-estimate-routes.ps1` (adds `/service/invoices/{id}/charge`
   and `/webhooks/stripe/{tenant}` + the second invoke permission) and
   `.\scripts\wire-service-public-routes.ps1` (adds `/public/estimates/{token}/checkout`).
7. **Portal** deploys with `main`.

## Test-mode walkthrough (the ZZ customer only)

Stripe's test cards: `4242 4242 4242 4242` succeeds; `4000 0000 0000 9995` declines with
*insufficient funds*; any future expiry, any CVC.

1. Quote the ZZ customer: New Estimate with a $50 flat deposit, one $200 labor line, Send.
2. Open the emailed link → Approve → **Pay deposit** → Stripe → 4242 → back on the page: the
   thank-you banner, then (a moment later) the deposit stamped. In the portal the estimate shows
   the deposit paid; no Payment row yet (no job).
3. Create Job from the estimate → the job page's Invoice card lists **Deposit $50 (Card)** and
   the job is *Deposit Paid*. The ledger row went `deferred → applied`.
4. Issue the invoice with **Charge the card on file now** ticked → `SVC-xxxxx` is *Paid*, the
   job is *Paid*, the customer gets Stripe's receipt email.
5. In the Stripe dashboard refund $20 of that charge → within seconds the job shows a **Refund
   −$20.00** row and the invoice is *Partially Paid*.
6. Void the invoice and reissue with the tick OFF → **Charge card on file $…** on the card; try
   it with the 9995 card on file to see the decline in Stripe's words, as a Failed row.

Stripe Dashboard → Developers → Webhooks → the endpoint shows every delivery and Sundial's
response; `sundial_stripe_events` shows what Sundial did with each one.

## Things to know

- **No Sundial receipt email yet.** Stripe's own receipt (`receipt_email` on the charge, and
  Checkout's receipts if enabled in the dashboard) is what the customer gets today. The
  "receipt + photo job report" email is the next increment.
- **Nothing is auth-and-captured** (D-065 decision 6): a card on file is a SetupIntent, the
  final charge is off-session at issue. If the bank asks for authentication on an off-session
  charge, the row stays *Pending* and Stripe's webhook finishes it either way.
- **Deposits without a job are deferred, never lost.** If Create Job is skipped and the office
  quick-creates a job by hand instead, the deferred row stays in the ledger — open it there.
- **The tenant slug in the URL is the routing key.** A second tenant gets its own endpoint
  (`/webhooks/stripe/<slug>`) on its own Stripe account with its own signing secret.
- **HCP's vaulted cards do not transfer** (D-065). Card re-onboarding is a rollout task: sending
  the estimate link is how a customer puts a card on file.
