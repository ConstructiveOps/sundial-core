# Service Club — memberships sold from Sundial's own pages, billed by Stripe (D-073)

**Built 2026-09-18.** The Harmon Service Club (Monitor / Maintain / Clean, Protect coming
soon) sells itself: a homeowner picks a plan on Sundial's public page, pays on Stripe's hosted
Checkout page, and is a member — a `Sundial_Membership__c` row that follows the Stripe
subscription for the rest of its life. The team is emailed, SolarFax (Solar Data Pros) is sent
the member and told to email them the "connect your monitoring" invite, and the member's next
estimate carries the plan's discount. When the membership ends — cancelled or lapsed — SolarFax
is told to disconnect them. Nobody in the office
ever types a card, and nothing about Harmon's plans is in code: the catalog is Salesforce rows.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| Catalog | `Sundial_Service_Plan__c` (rows per tenant), seeded by `scripts/seed-service-club.mjs` | Name, tagline, features, monthly / yearly price, availability (Available / Coming Soon / Hidden / Retired), the member discount, what the plan owes (tune-up / cleaning), the Stripe product + price ids |
| Memberships | `Sundial_Membership__c` (MEM-#) | One row per customer × plan × subscription: status, interval, price, `Stripe_Subscription_Id__c`, period end, cancellation stamps, payments, the SolarFax hand-off (status, last sent, last error, SolarFax's account + user ids), customer snapshot. `Sundial_Customer__c.Active_Membership__c` points at the live one |
| Public pages | harmon-crm `/club`, `/club/join`, `/club/joined`, `/club/service`, `/club/booked`, `/club/manage` | No login. Plans → join form → Stripe. Book a truck roll (paid on Stripe) or "call me". "Manage my membership" emails a Stripe customer-portal link |
| Public API | `lambdas/sundial-service-estimate/club.js` → `/public/club/{tenant}/…` | `GET plans`, `POST join`, `GET joined`, `POST truck-roll`, `POST request`, `POST manage` — the tenant is the URL's slug, like the Stripe webhook |
| Stripe → Sundial | the existing `POST /webhooks/stripe/{tenant}` | `checkout.session.completed` in `subscription` mode activates the membership; `customer.subscription.updated / deleted`, `invoice.paid`, `invoice.payment_failed` keep it current. Same signature gate, same `sundial_stripe_events` ledger (+ `membership_sf_id`) |
| Office | harmon-crm **Service → Service Club** (`/service/club`); `GET/POST /service/club/memberships`, `POST …/{id}/cancel`, `POST …/{id}/solarfacts`, `GET /service/club/report`, `GET /service/club/customers/{id}`, `GET/PATCH /service/club/plans` | The list + tiles, a membership dialog (cancel through Stripe, resend to SolarFax), **Add member** (a join link — Ben's migration), the plan editor |
| SolarFax | `lib/solarfacts.js` — their REST API (`POST https://api.solardatapros.com/api/v1/users`, headers `Api-Key` + `Access-Token`) | On activation: create-or-update the member as a SolarFax user with the address, login + weekly emails on, and send the tenant's white-labelled connect-invite template. On the end of the membership: `disconnect` (SolarFax's full disconnect + data deletion). A Zapier catch hook is the fallback if the API is not configured |
| Discounts | `createEstimateRecord` + `POST /service/estimates/{id}/apply-plan-discount` | A member's new estimate starts with the plan's discount (`Discount_Source__c = Service Plan`, `Membership__c`); the estimate page's "Apply member discount" puts it back |
| Config | Secrets Manager **`sundial/service-club`** | Per tenant: the SolarFax API credentials + invite template (or the older Zapier catch-hook URLs) and the team's notification email |
| Actions | `lib/access.js` | `service.club.read`, `service.club.write` (tenant scope) |

## How a join flows

1. `POST /public/club/{tenant}/join { planCode, interval, customer }` — the visitor's email or
   phone is matched against the customer hub (the D-072 duplicate guard; a match IS that
   customer, silently; else the customer is created and tagged `Service`), a **Pending**
   membership row is written, and a Stripe Checkout Session in `subscription` mode is minted on
   the plan's price. The browser is sent to Stripe.
2. Stripe's `checkout.session.completed` (mode `subscription`) arrives on the webhook: the row goes
   **Active** with the subscription id, period end and start; `Active_Membership__c` is set on the
   customer; SolarFax is sent the member (`POST users` with name / email / phone / address, the
   connect-invite template — SolarFax emails the invite, not Sundial); the team is emailed. A
   redelivered event is a no-op. SolarFax refusing or being down is stamped on the row
   (`SolarFacts_Status__c = Failed`, the message in `SolarFacts_Last_Error__c`) and named in the
   team email — it never fails the webhook; the office's **Resend** retries it.
3. `/club/joined?session=cs_…` polls `GET joined` until the row says Active — the page never
   waits on the webhook; the email is the confirmation.
4. Renewals: `invoice.paid` stamps the last payment and lifetime revenue; `invoice.payment_failed`
   → **Past Due** + a team email (once); a later `invoice.paid` → Active again.
5. Cancellation: the member cancels in Stripe's portal or the office clicks Cancel (Stripe
   `cancel_at_period_end`, or DELETE for "end it now"). `customer.subscription.deleted` ends the
   row (**Cancelled**, `Ended_At__c`), clears the customer's pointer, tells SolarFax to
   **disconnect** the member (status `Cancel Sent`), emails the team. A lapse works the same way:
   Stripe cancels the subscription after its retry schedule gives up, and that
   `customer.subscription.deleted` is what ends the row and disconnects — Past Due alone does not.

A subscription event that names no membership we know is `ignored` in the ledger — a membership is
only ever born from our own join. The join refuses a customer who already has a live membership
(`409 ALREADY_MEMBER`).

## Setup (Tim)

1. **Salesforce.** Zip the contents of `salesforce/service-club/` → Workbench → Migration →
   Deploy → **Check Only** first (5/5: 2 objects, 2 fields, 1 permission set) → deploy. Assign
   permission set **Sundial Service Club** to the integration user.
   *Already deployed before 2026-09-18's SolarFax revision?* Redeploy the same folder once more —
   it adds `SolarFacts_Account_Id__c` / `SolarFacts_User_Id__c` on the membership and declares
   both objects Public Read/Write (see `salesforce/pricebook-import/README.md`, "Sharing"). A
   redeploy is an upsert: existing rows and fields are untouched.
2. **Supabase SQL editor**, in order: `sql/sundial_service_plan_cache.sql`,
   `sql/sundial_membership_cache.sql`, `sql/2026-09-18_service_club.sql` (the two pointer columns
   on the customer / estimate caches + `membership_sf_id` on the Stripe ledger + the two SolarFax
   id columns). All three are re-runnable (`IF NOT EXISTS`) — run them again after the SolarFax
   revision if you ran them before it.
3. **The catalog + Stripe products.** With the Stripe keys in `sundial/stripe` (test mode first):
   ```powershell
   node scripts/seed-service-club.mjs --tenant harmon           # dry run — prints the five rows
   node scripts/seed-service-club.mjs --tenant harmon --apply   # writes the rows, creates the Stripe products + prices, writes the ids back
   ```
   Re-run after the live keys land — the rows keep the same codes, the live products get created,
   and the ids are replaced. The prices are the ones on solarserviceclub.com on 2026-09-18; edit
   the catalog in this script (or later from the portal's Plans dialog) if they change.
4. **Stripe dashboard.**
   - Developers → Webhooks → the existing `…/prod/webhooks/stripe/harmon` endpoint → add the
     events `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
     `invoice.payment_failed` (the four payment events stay).
   - The restricted key needs **Write** on Subscriptions, Products, Prices, Customer portal
     sessions (in addition to what payments already needed).
   - Settings → Billing → **Customer portal**: turn it on; allow "update payment method" and
     "cancel subscription" (at period end); "switch plans" is optional — if you allow it, the
     `customer.subscription.updated` event keeps Sundial's row current, but the row's
     `Service_Plan__c` is NOT re-pointed today (the Stripe price id changes; the office corrects the
     plan by cancelling and re-joining, or a follow-up maps price id → plan).
   - Settings → Billing → **Subscriptions and emails** → *Manage failed payments*: leave Stripe's
     Smart Retries on and set the end state to **cancel the subscription**. That cancellation is
     the event that ends a lapsed membership in Sundial and disconnects the member from SolarFax.
5. **SolarFax (Solar Data Pros).** Ask their support (the API docs are at
   solardatapros.crunch.help → System Guides → API Docs) for three things, for Harmon's account:
   - the **`Api-Key`** and the **`Access-Token`** (two separate values; both go on every request);
   - the **name of the email template** to send on join — the white-labelled "connect your
     utility / monitoring" invite for Harmon (the API's `sendEmailTemplate.Name`; if they have
     not made one, ask them to, with Harmon's branding and the club's wording). Without it the
     member is created in SolarFax but no email goes out;
   - confirmation that the **`disconnect`** flag on `POST users` is what they want us to send when
     a membership ends (their docs describe it as "full disconnect and data deletion for utility
     and solar"). If they would rather keep the account and only stop monitoring, tell me and
     the call changes in one place (`lib/solarfacts.js`).
   Their API also takes `test: "1"`, which validates a request without doing it — the secret's
   `"test": true` turns that on for a dry run of the whole join flow.
6. **Secrets Manager** → Store a new secret → *Other type* → plaintext → name **`sundial/service-club`**:
   ```json
   {
     "tenants": {
       "harmon": {
         "solarFacts": { "apiKey": "…", "accessToken": "…", "inviteTemplate": "<template name from SolarFax>" },
         "teamEmail": "solarservice@harmonelectric.net"
       }
     }
   }
   ```
   - `solarFacts.test: true` (optional) makes every SolarFax call a dry run — use it for the first
     test join, then remove it.
   - `solarFacts.baseUrl` (optional) overrides `https://api.solardatapros.com/api/v1` if SolarFax
     gives Harmon a different host.
   - Until the credentials arrive, leave `solarFacts` out: memberships are stamped
     `Not Applicable` and the office's **Resend to SolarFax** sends each one once it is set
     (their `newOnly` is off, so a member SolarFax already knows is updated, not refused).
   - The older Zapier shape (`solarFactsHookUrl` / `solarFactsCancelHookUrl`) still works as a
     fallback when `solarFacts` is absent; with both present the API wins.
   - The team email needs `EMAIL_FROM` on `sundial-service-estimate` (already set for estimate
     sends).
7. **Lambdas + routes.** `npm test`, then `.\deploy.ps1 sundial-service-estimate`,
   `.\deploy.ps1 sundial-auth-proxy` (two new actions in `lib/access.js`),
   `.\deploy.ps1 sundial-sf-query` and `.\deploy.ps1 sundial-cache-sync` (the two new objects in
   the registries), then `.\scripts\wire-service-club-routes.ps1` (the public + office routes and
   the invoke permission for `/public/club/*`; prompts before the prod deploy).
8. **Portal.** Push harmon-crm `main`. The public pages are at
   `https://sundial.harmonelectric.net/club` — point solarserviceclub.com's "Join Now" and plan
   buttons at `/club/join?plan=monitor|maintain|clean&interval=monthly|yearly`, "Manage" at
   `/club/manage`, and the truck-roll / call-me at `/club/service` (or move the domain itself to
   the portal later; the pages are self-contained).

## Test walk-through (test keys, the ZZ customer's email, card 4242 4242 4242 4242)

1. Open `/club`, choose Monitor monthly, fill the form with `tim+zz-club@…` and a ZZ address,
   continue → Stripe's test page → pay with 4242 → back to `/club/joined` → "Welcome to the club".
2. Service → Service Club: the row is Active, MRR $8.99, SolarFax **Sent** (or Not Applicable
   without credentials; **Failed** with the reason if SolarFax refused — fix and Resend), the team
   email arrived, and the ZZ inbox got SolarFax's connect invite (unless `test: true`). The ZZ customer's page shows the "Service Club · Monitor Plan" chip
   and the related-records bar has a Service Club group.
3. New Estimate for that customer: the Pricing card shows 10% on Labor, source Service Plan.
4. Stripe dashboard → the subscription → Cancel at period end → the row shows "ends <date>";
   Cancel immediately → Cancelled, the pointer clears, SolarFax shows **Cancel Sent** (the ZZ
   user is disconnected on their side).
5. `/club/manage` with the member's email → the portal link arrives (Stripe's test portal).
6. `/club/service` → "call me" → a job in Needs Intake Review + the team email; "Book a service
   call" → pay 275 → the job shows Deposit Paid, the estimate Approved (Online).

## What is deliberately not here (yet)

- **Per-kind discounts.** The site promises "$50 off inspections, 10% off repair work, 5% off
  add-on equipment"; a plan carries ONE estimate discount (scope Labor / Material / Both). Monitor
  ships as 10% off Labor; the office handles the other two by hand. A per-kind discount table is
  the amendment if Harmon wants it exact.
- **Plan switches from the Stripe portal** (see setup 4).
- **Reconnecting a returning member.** A cancelled member who rejoins gets a fresh invite (their
  SolarFax user is updated, `newOnly` off), but whatever SolarFax deleted at disconnect is gone —
  they connect their utility again.
- **Proration / trials / promotion codes** — Checkout accepts promo codes (`allow_promotion_codes`),
  so a Stripe coupon works today; nothing in Sundial knows about it beyond the invoice amounts.
- **Refunds** — Stripe dashboard, as with payments; subscription refunds are not mirrored to the
  membership's revenue fields (the ledger keeps the truth).
