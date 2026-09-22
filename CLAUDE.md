# Sundial — CLAUDE.md

> This is the project constitution. Claude Code reads this file at the start of every session.
> It defines architecture, conventions, and standing instructions for the Sundial platform build.

---

## Project Overview

**Product Name:** Sundial
**Client:** Harmon Electric (Phoenix, AZ — established multi-department solar company)
**Vendor:** Constructive Operations LLC (Phoenix, AZ)
**Owner/Developer:** Tim Murphy — sole AI developer, non-professional coder. Claude Code is the co-developer.
**Repository Path:** `C:\Users\TimMurphy\Projects\harmon-crm`
**GitHub Repo (to be created):** `https://github.com/ConstructiveOps/harmon-crm` (working name)

Sundial is a single-tenant, custom-built operations platform for Harmon Electric covering four operational departments: residential solar, roofing, service operations, and commercial solar. It is built on Salesforce data infrastructure (no Salesforce user licenses for Harmon), integrated with Acumatica for accounting, and integrated with Nonstop Automation for marketing intake.

### Business Context

Harmon Electric is replacing Sunbase (their current CRM) and Housecall Pro (their service platform) with a unified custom-built solution. They are keeping Acumatica (accounting), Aurora Solar (design and proposals — for now), Dropbox (document storage, as a mirror), and Nonstop Automation (marketing/AI voice).

Harmon will **not have any Salesforce user licenses**. All Salesforce data access happens through a single integration user in Constructive Operations' existing Sales Cloud Enterprise org. Harmon users authenticate against Supabase and interact with Salesforce data exclusively through the Sundial portal UI. Tim handles all Salesforce administration, Flow development, report and dashboard creation, and ongoing platform configuration.

### Engagement Model

Constructive Operations provides:
1. **One-time build** of Sundial across three phases (fixed price per phase)
2. **Ongoing monthly subscription** per module with volume-based discounts when Harmon uses Constructive Operations for back-office operational services ($800/project)
3. **Future add-on services** (sold separately after platform adoption): AI after-hours intake, inbound/outbound call handling, marketing email campaigns, AI customer troubleshooting, additional automation

All third-party costs (Salesforce licenses, AWS, Supabase, Vercel, FullCalendar Premium, SMS messaging, email delivery, etc.) are absorbed by Constructive Operations as part of the subscription.

### Departments and Workstreams

| Department | Current Tools | Replacing With |
|-----------|--------------|----------------|
| Residential Solar | Sunbase | Sundial (Residential Solar module) |
| Roofing | Sunbase | Sundial (Roofing module) |
| Service Operations | Housecall Pro | Sundial (Service Operations module) |
| Commercial Solar | Sunbase | Sundial (Commercial Solar module) |
| Field Documentation | SiteCapture (basic plan) | Continue using SiteCapture; integrate later if plan supports API |
| Accounting | Acumatica | Keep — integrate via REST API |
| Design/Proposals | Aurora Solar | Keep — integrated (design-request push + agreement webhook). All Aurora integration runs on `Sundial_Customer__c`, never on a project object (D-047) |
| Marketing/Lead Capture | Nonstop Automation | Keep — integrate via webhooks |
| Document Storage | Dropbox | Keep as mirror — AWS S3 is primary, Dropbox receives copy-back for Harmon's ownership comfort |

---

## Architecture

### Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | React + Vite | Portal UI |
| Styling | Tailwind CSS | Utility-first, dark/light mode |
| Hosting | Vercel | Frontend deployment from GitHub |
| Auth | Supabase Auth | Harmon user login |
| Portal DB | Supabase Postgres | Chat, notifications, user profiles, draft state, audit logs, file metadata, Salesforce data cache |
| Real-time | Supabase Realtime | Live chat, dispatch board updates, notifications, cache invalidation broadcasts |
| API Layer | AWS Lambda + API Gateway | Salesforce and Acumatica integration |
| Queue | AWS SQS | Outbound integration calls (Acumatica rate-limit handling), Dropbox sync retries |
| Event Routing | AWS EventBridge | Scheduled cache refreshes, batch operations, retry orchestration |
| CRM Data | Salesforce (Enterprise) | Source of truth for project, customer, service data |
| Accounting | Acumatica Cloud (2024 R1) | Integrated via REST API, single company |
| Primary File Storage | AWS S3 | Document storage, organized by Salesforce record ID |
| Salesforce-side File Access | XFiles Pro | Reads from the same S3 bucket so admin users see Sundial files inside Salesforce natively |
| Document Mirror | Dropbox (Harmon's existing) | Automated copy-back from S3 for data ownership |
| Lead Intake Routing | Zapier | Aurora and Roofr webhooks create Sundial records (handled by Tim, not in build scope) |
| Payments | Stripe | Service payments (D-072 amendment 8), Service Club subscriptions (D-073) |
| SMS | Twilio (under the hood, not branded in client docs) | Customer texting from the job page (`sundial-sms`, built 2026-09-15); appointment reminders next |
| Email | SendGrid or Salesforce email | Customer comms, automated notifications |
| AI Voice | Retell.ai | **Welcome Call (built, D-054):** automated post-sale contract verification, triggered from Salesforce via one platform event over Event Relay/EventBridge; no portal UI. Also the engine for after-hours service intake — that one is still an add-on service, not built into the platform. |
| Scheduling Library (Phase 3) | FullCalendar Premium with Scheduler plugin | Drag-and-drop install scheduling board |
| Version Control | GitHub | Source code repository |

### Data Flow

```
Harmon user browser → Supabase Auth (JWT) → React app → API Gateway → Lambda
                                                                        ├── Reads: Supabase cache first, Salesforce on miss
                                                                        ├── Writes: Salesforce, then update cache + Realtime broadcast
                                                                        ├── Acumatica REST API (via SQS queue)
                                                                        ├── S3 (presigned URLs for file ops)
                                                                        ├── Dropbox API (copy-back sync)
                                                                        ├── Stripe API
                                                                        └── SMS provider

Inbound webhooks → API Gateway → Lambda → Salesforce (Acumatica payment events, SMS responses,
                                                     Stripe payment events, Aurora & Roofr via Zapier)

Salesforce Platform Events → Lambda (via EventBridge) → Update Supabase cache → Realtime broadcast
```

See `docs/caching-architecture.md` for the full cache pattern, `docs/file-storage.md` for the file storage architecture, and `docs/multi-client-deployment.md` for the multi-client deployment model.

### Reused Infrastructure from TAG Portal

Sundial leans on patterns and code from the TAG portal build where appropriate:

- Salesforce integration Lambda pattern (JSforce, integration user, JWT flow)
- Supabase auth and real-time chat infrastructure
- S3 presigned URL pattern for uploads
- React component library and Tailwind styling conventions
- Multi-section project detail UI pattern (adapted for Sundial's data model)
- Document checklist UI pattern (adapted for service photos and project documents)

### Key Differences from TAG Portal

- **Single tenant** — Harmon-only, no multi-tenant config, no subdomain resolution, no per-tenant branding logic
- **Four distinct operational departments** in one platform: residential solar, roofing, service, commercial solar
- **Bigger data model** with separate project objects per department (see schema doc)
- **Acumatica integration** as a major workstream (not present in TAG portal)
- **Mobile field tech experience** as a major workstream (PWA with offline capability)
- **GPS tracking and geofenced clock in/out** for service techs AND solar/roofing/commercial install crews
- **Drag-and-drop dispatch board** for service operations (FullCalendar-based, matching HCP capability)
- **Dual document storage** (AWS S3 primary, Dropbox mirror, XFiles Pro for Salesforce-native access)
- **Salesforce data caching in Supabase** to dramatically reduce SF API consumption (different pattern from TAG, which queried SF on every read)
- **Designed for multi-client deployment** — this Harmon build becomes the template for future Sundial clients

---

## Multi-Client Architecture

Sundial is designed from the start for multiple clients, even though Harmon is the first. The pattern is **shared backend, forked frontend**:

- **Shared:** Salesforce org, Sundial_* custom objects, Connected App, Lambda code, all third-party integrations
- **Forked per client:** React/Vite repo, Vercel deployment, Supabase project, branding, custom field configurations, module enablement

The Harmon repo (`harmon-crm`) evolves into the canonical `sundial-template` as the platform matures. New clients fork from the template, customize via `client-config.ts`, and only fork code when configuration cannot express what's needed.

Target scale: under 10 clients in the first two years. If the count grows past that, we revisit toward a true multi-tenant single-frontend architecture.

Every Salesforce record carries a `Client__c` lookup. Every Lambda query enforces tenant filtering. This is a hard architectural rule. The tenant anchor is the dedicated `Sundial_Tenant__c` object (its `Name` holds the tenant slug, e.g. `harmon`); `Client__c` targets `Sundial_Tenant__c`.

Full pattern documented in `docs/multi-client-deployment.md`.

---

## Salesforce Data Caching

The portal does not query Salesforce on every read. Doing so would exhaust the org's API budget and make the portal slow. Instead, Sundial caches Salesforce data in the per-client Supabase project:

- **Reads** hit Supabase cache first; Salesforce only on cache miss or staleness
- **Writes** go to Salesforce first; on success, update the cache and broadcast invalidation via Supabase Realtime
- **Out-of-band changes** (Salesforce Flows, Zapier writes, admin edits) fire Platform Events that Lambda consumes and propagates to the cache
- **Critical operations** (payments, scheduling commits, Acumatica writes) explicitly bypass cache and read fresh from Salesforce

Estimated API call reduction: 80-95 percent compared to a no-cache design.

Full pattern, including cache table schemas, invalidation strategy, Platform Event integration, and always-fresh-from-Salesforce operation list, is in `docs/caching-architecture.md`.

---

## File Storage Architecture

Files for all Sundial records live in AWS S3, organized by Salesforce record ID. The same folder structure serves three access surfaces:

1. **Sundial portal** — Files tab on every record detail page with upload, download, search, and related-files navigation
2. **Salesforce + XFiles Pro** — Admin users see the same files natively inside Salesforce via XFiles Pro reading from the same S3 bucket
3. **Harmon's Dropbox** — Automated copy-back keeps a human-readable mirror for ownership comfort

S3 bucket: `sfsolproj` (shared with XFiles Pro). Sundial path format: `SUNDIAL/{sf_record_id}/{filename}`. The Salesforce record ID as folder name is the architectural keystone that makes XFiles Pro alignment work without sync logic.

File metadata (filename, uploader, upload date, category, size) lives in Supabase, not Salesforce, to avoid API consumption on file listings.

This is a deliberate move away from the URL-field-per-document pattern used in the TAG portal. Folder-per-record scales better and supports unlimited file categories without schema changes.

Full architecture, Lambda function specs, portal UI requirements, XFiles Pro configuration, and Dropbox sync details in `docs/file-storage.md`.

---

## Salesforce Data Model

Full schema lives in `docs/salesforce-schema.md`. This section is the high-level overview.

### Naming Convention

All Sundial custom objects use the `Sundial_` prefix (e.g., `Sundial_User__c`, `Sundial_Customer__c`).

### Core Custom Objects

| Object | Purpose |
|--------|---------|
| `Sundial_User__c` | Portal users with hierarchy field (Client, Dealer, Sales Manager, Sales Rep) and self-lookup parent |
| `Sundial_Customer__c` | Customer/address hub. Serves as Lead, Opportunity, and ongoing Customer record |
| `Sundial_Solar__c` | Residential solar projects |
| `Sundial_Roofing__c` | Roofing projects (residential or commercial roofing-only, or reroof component of solar projects) |
| `Sundial_Commercial__c` | Commercial solar projects |
| `Sundial_Estimate__c` | Service estimate — the quote **and** the living bill of work; can exist without a job; every job has exactly one (D-072) |
| `Sundial_Service_Job__c` | Service job (parent record for service work; was `Sundial_Service__c`). Bill-To lives here: one job = one payer |
| `Sundial_Service_Call__c` | One tech × one appointment on a job: clock in/out, GPS, notes, photos (was `Sundial_Service_Visit__c`) |
| `Sundial_Price_Book_Item__c` | Tenant-scoped, versioned price book (never edited in place once used — *Update* clones a new version with the same `Item_Code__c`) |
| `Sundial_Service_Line__c` | Junction: estimate × price-book item (+ quantity, price/cost snapshots, ad-hoc lines) |
| `Sundial_Service_Invoice__c` | One invoice per job (reissue = `-2`); amounts frozen from the estimate at billing |
| `Sundial_Service_Payment__c` | One row per deposit / payment / refund (Stripe PaymentIntent id = idempotency key) |
| `Sundial_Service_Plan__c` | The Service Club catalog per tenant (D-073): plans, prices, Stripe ids, member discount, entitlements |
| `Sundial_Membership__c` | One row per customer × plan × Stripe subscription (D-073); `Stripe_Subscription_Id__c` = idempotency key |
| `Sundial_PO__c` | Purchase orders mirrored to Acumatica |
| `Sundial_PO_Credit__c` | Credit and return tracking against POs (solves the Acumatica gap) |

### Snapshot Pattern

When a project record is created, customer name, address, primary phone, and primary email are snapshot-copied from `Sundial_Customer__c` onto the project record itself. The lookup to `Sundial_Customer__c` remains for current-state queries, while the snapshot fields preserve historical accuracy if the Customer record later changes (new owner at the address, person moves, etc.). Applies to all four project objects.

### Standard Objects in Use

| Standard Object | Usage |
|----------------|-------|
| `Asset` | Installed solar systems and equipment, linked to `Sundial_Customer__c` via custom lookup |
| `Pricebook2` / `Product2` / `PricebookEntry` | Service price book (matching the HCP feature Harmon values) |

### Sundial_Solar__c ↔ Solar_Project__c Mirror

When a Sundial residential solar project is handed to Constructive Operations for back-office services, a Salesforce Flow mirrors the relevant data into the existing `Solar_Project__c` object (used by Constructive Operations' internal team). Mirror is via Flow so that Sundial functions whether or not the project is handled by Constructive. Source-of-truth rules are field-by-field (see `docs/salesforce-schema.md`).

### Salesforce Org Architecture

Harmon does not get Salesforce user licenses. All access goes through:

- Tim's named user license (admin, dev, support)
- One **Sundial Integration User** (API-only license) for all portal-to-SF traffic

Data isolation between Harmon and other Constructive clients is handled via:

- A `Client__c` lookup field on all relevant Sundial records
- **Org-wide default Public Read/Write (internal), Private (external) on every `Sundial_*` object** (decided 2026-09-18, `salesforce/pricebook-import/README.md` → Sharing). Salesforce sharing is inert for Sundial: one integration user serves every session and every access decision is `lib/access.js` by tenant scope (D-064). A Private OWD only hides admin-created rows (DataLoader imports, Flows) from the integration user. The `.object` files and both generators declare `<sharingModel>ReadWrite</sharingModel>` so a redeploy cannot flip it back
- Integration user owns the records the portal creates; Tim maintains the org

---

## Acumatica Integration

### Key Constraints

- **Acumatica Cloud, 2024 R1** (upgrade in progress as of discovery)
- **Construction Edition** with Project Accounting, Inventory, PO, Payroll, Banking, Finance modules active
- **Single company** (no multi-entity routing)
- **Concurrent API call limit** — exact number TBD. Workaround: schedule API calls to avoid concurrency with other Harmon integrations
- **Minimal customizations**: few custom inquiries, one custom PO field
- **Volume**: ~275 AR/month, ~300 AP/month, ~250 POs/month, ~70 new customers/month

### Integration Architecture

Queue-based, asynchronous-first design:

1. Salesforce events (Flow, Platform Events) push job messages to AWS SQS
2. Consumer Lambda pulls from SQS at configurable concurrency
3. Consumer makes Acumatica REST API call with exponential backoff on rate-limit errors
4. Permanent failures route to Dead Letter Queue with alerts
5. Inbound webhooks from Acumatica via generic inquiries trigger Lambda → Salesforce writeback

### Integration Scope

**Salesforce → Acumatica:**
- Customer creation (with existence check)
- Project creation from Acumatica templates (residential vs commercial)
- Initial PO creation (template-driven)
- Ad-hoc PO creation (PM-initiated from portal)
- AR Invoice triggering (residential vs commercial patterns)
- Vendor creation

**Acumatica → Salesforce:**
- Payment received events
- Vendor bill status updates
- PO status updates
- Project closeout signals

### Differentiator Features (Pain-Point Solutions)

- **PO credit tracking** — `Sundial_PO_Credit__c` solves the Acumatica gap
- **Cash-basis sales tax reporting** — replicate the manual custom inquiry as a Salesforce report (if data crosses our integration set)

---

## Service Operations Module

### Replacing Housecall Pro Completely

Harmon currently runs 7 service techs on HCP Max (15 seats, ~150-230 tickets/month). The HCP scheduler is a real dispatch board (FullCalendar-based with drag-and-drop, proportional time blocks, edge-drag resize, multi-tech timeline, travel-time suggestions, real-time GPS map). Sundial must match this capability or the service team will revolt.

### Service Object Architecture (v2 — D-072, 2026-09-09; full model in `docs/service-data-model.md`)

- **Seven objects:** `Sundial_Estimate__c` (EST-#) → `Sundial_Service_Job__c` (SVC-#, was `Sundial_Service__c`) → `Sundial_Service_Call__c` (SC-#, was `Sundial_Service_Visit__c`); `Sundial_Service_Line__c` hangs off the **estimate** and points at a versioned `Sundial_Price_Book_Item__c`; `Sundial_Service_Invoice__c` (one per job) and `Sundial_Service_Payment__c` (one per money event) hang off the job. No Asset object (D-065.1).
- **Rules the code enforces, never bypass them:** (1) an estimate can exist without a job, a job never without an estimate — quick-create makes both; (2) lines live on the estimate only — the job's money fields are cross-object formulas; (3) one job = one payer — Bill-To on the job, a second payer is a second job; (4) price-book items are never deleted and never edited in place once a line references them — *Update* = clone with the same `Item_Code__c`, old version `Is_Active__c = false`, exactly one active version per code (Lambda-enforced); lines snapshot price/cost/description at add time regardless; (5) nothing blocks scheduling/sending/invoicing on another record's state — restrictions are per-tenant validation rules added only on request.
- **Money math runs in the estimate Lambda** (kind subtotals → scoped discount → hidden markup → tax → total → deposit) and is stored; a nightly reconcile catches drift. **Time** roll-ups (service call → job) run on the Flow. Estimate versions = append-only `Version_Log__c` JSON + a PDF per send (`SUNDIAL/{estimateId}/estimate-v{n}.pdf`, rendered by `lib/estimate-pdf.js` from the SAME document model as the hosted page — `buildEstimateModel()` in `lib/estimate-document.js` decides what is shown, the two painters only draw it; D-072 amendment 3); templates are estimates with `Is_Template__c`.
- **The hosted estimate page is the payment link** (accept + Stripe SetupIntent/deposit at the bottom). Customers get receipt + photo job report; partners get the invoice document.
- `Sundial_Service_Call__c` is also used for non-service field work (solar/roofing/commercial visits) via `Visit_Type__c` plus optional project lookups (D-027). Files and photos use the Solar module's S3 pattern unchanged (`sfsolproj/SUNDIAL/{jobId}/…`, photos in the `photos/{serviceCallId}/` subfolder, XFiles Pro reads the same prefix, nothing stored in Salesforce); per-photo flags ride on the existing Supabase `sundial_file_metadata` row; photos default internal until flagged customer-visible.
- **Every project-creating popup does customer select-or-create** (D-072 amendment): New Estimate / New Job — and New Roofing / New Commercial when built — search the customer hub first, or create the customer from the basics in the same request; never send the user to Sales to make a customer. The module silently tags `Sundial_Customer__c.Requested_Project_Types__c` **and `Customer_Type__c`** with its value (`Service`, `Roofing`, `Commercial`): set on a new customer, union-added on an existing one. Soft duplicate guard (email / phone / street+zip) before any create; reuse the `POST /sf/customer` validation path.
- **Every service write lands in the activity tracker** (D-072 amendment 2): `sundial_service_activity` in Supabase — event, actor, timestamp, old → new — written best-effort *after* the Salesforce write by `sundial-service-estimate` and `sundial-sf-update` through `lib/service-activity.js`; never a reason to fail the user's action. Keyed by job **and** estimate (pre-job history is re-keyed at Create Job). Lines are editable after they are added (the line is the office's snapshot); a money-affecting edit to an Approved line drops it to Proposed.
- **The dispatch board is always fresh and the job's status follows its calls** (D-072 amendment 4): `sundial-service-board` reads and writes Salesforce directly (no cache on the scheduling path), every move carries `baseModstamp` and a stale one is a 409, and scheduling / progressing / cancelling calls moves the job's `Status__c` in exactly one function (`settleJobStatus`) — never anywhere else. Techs = users marked Technician or in the Service department. FullCalendar Premium is the later front-end upgrade on the same API.
- **Money is settled in one function, inside the estimate Lambda** (D-072 amendment 5): `invoice.js` issues the job's one live invoice (the estimate's lines frozen; the estimate goes `Invoiced` and locks), records manual payments, sends, voids. `settleMoney()` alone writes `Paid_Amount__c` / invoice status / `Paid_At__c` and the job's `Payment_Status__c` and `Invoiced ↔ Paid` status — no roll-up Flow, and never anywhere else. Void unhooks payments (keeps them on the job) so the `-2` reissue picks them up. Action `service.invoice.write`. Stripe rows will arrive by webhook keyed on `Stripe_Payment_Intent_Id__c` and go through the same settle.
- **Street View is fetched once, server-side** (amendment 5): key in Secrets Manager `sundial/google-maps`, still cached at `SUNDIAL/{jobId}/street-view.jpg`, remembered on the job. Never a browser key.
- **Labor is billed per call, opt-in, or not at all** (D-072 amendment 6): `Billable_to_Customer__c` on a Complete call turns its clocked time (rounded UP to the quarter hour, at the call's rate else the tech's `Hourly_Bill_Rate__c`) into exactly one `Source__c = Time` Labor line on the estimate; off means nothing about hours reaches the estimate or invoice. `labor.js` owns the decision in one request and deletes the line when the call is switched off. Never add hours to an invoice any other way.
- **A call can be `Unscheduled`** (amendment 6): created "schedule later", it waits in the dispatch tray as its own card; giving it a start is a PATCH that moves it to Scheduled. Job status does not move until then.
- **Customer texting is `sundial-sms`** (amendment 6): Twilio on Constructive Ops' account; the *number* is per tenant in Secrets Manager `sundial/twilio` (`tenantNumbers[slug]`, else the shared line; `defaultTenant` routes inbound on the shared line) — never a tenant's number in code. Rows in Supabase `sundial_sms_messages`, browser access revoked. The two webhooks are gated only by Twilio's request signature, constant-time, failing closed. A reply goes to the conversation we started first, the phone snapshot second, and is never dropped. Action `service.sms.send`. Runbook `docs/integrations/sms-twilio.md`.
- **The technician app is `/tech` inside the portal** (D-072 amendment 7, `docs/pwa-architecture.md`): a Technician login has scope `tech` and ONE action, `service.tech.self` — the `/service/tech/*` routes in `sundial-service-board/tech.js` (+ `estimate-lines` in the estimate Lambda) are everything a tech can reach; a call that is not theirs is a 404. **Online-first with a queue**: the phone sends now, else queues the tap with its own time and id, replays in order, and the server treats the id as idempotent — never make a tech route non-idempotent. **The clock is an append-only log** (`Clock_Intervals__c`): the app appends, the office corrects on the board (`POST /service/calls/{id}/clock`, 2026-09-17 — every correction stamped with who / when / why, a removed interval kept and flagged, never a hand-typed actual); `Actual_Start/End__c` and `Duration_Minutes__c` are derived from it, by the phone's taps, the board's status menu and the correction alike. **Completion is gated by the checklist on the server.** **The geofence is a tag, never a gate.** Every customer text — the office's and the tech's "on my way" — goes through `lib/sms-send.js`. **Reads are wider than writes** (addendum 2026-09-16): `service.tech.read` gives a tech the whole Service module read-only (jobs / estimates / customers lists and records, the job's texts and activity) and `sql/sundial_access_p10_tech_scope.sql` teaches the comments RLS the `tech` scope so the tech app reuses the office's `CommunicationsPanel` — never a second write path into `comments`. **Photos are one folder per job** (2026-09-18): `SUNDIAL/{jobId}/photos/{callId}/…` from the phone, `SUNDIAL/{jobId}/photos/…` from the office's job page; every reader (`GET /service/jobs/{id}/photos`, `GET /service/tech/jobs/{id}/photos`) gets the whole folder grouped by call, and the tech app reads the job's Files too (`GET /service/tech/jobs/{id}/files`) — tech reads of files stay on the board Lambda under `service.tech.read`, never by widening `canReadObject`.
- **Payments are Stripe Checkout + a signed webhook into `settleMoney`** (D-072 amendment 8, `docs/integrations/stripe.md`): the customer pays on Stripe's page (`POST /public/estimates/{token}/checkout` — the step offered is re-derived on the server), Stripe reports through `POST /webhooks/stripe/{tenant}` (signature-gated, fail closed, tenant = the URL's slug), and every event lands as a Payment row keyed on the PaymentIntent id and a `sundial_stripe_events` ledger row keyed on the event id — look before you write, always. Keys per tenant in Secrets Manager `sundial/stripe`, read only through `lib/stripe.js`; never a card number, a publishable key or Stripe.js in the browser. Money that arrives before its job (a deposit at approval) is **deferred** and landed by Create Job — a webhook never creates a job. The office's off-session charge writes its Pending row BEFORE confirming. Refunds happen in the Stripe dashboard and are mirrored.
- **The Service Club is rows + Stripe subscriptions + the same webhook** (D-073, 2026-09-18, `docs/integrations/service-club.md`): the catalog is `Sundial_Service_Plan__c` per tenant (the seed script derives the Stripe Products / Prices from it; a price change is a new Price, never an edit), a membership is a `Sundial_Membership__c` row **born only from Sundial's own join** (Pending → Active when Stripe's subscription Checkout completes; a subscription event that names no row we know is `ignored`, never a create), `Sundial_Customer__c.Active_Membership__c` points at the one live row, and money moves only in Stripe (cancel goes through Stripe, the webhook confirms; the office sends a join link, never types a card). The public pages are `/public/club/{tenant}/…` in `club.js` inside the estimate Lambda (they reuse its customer / estimate / job creation), the **SolarFax hand-off is their API through `lib/solarfacts.js` only** (D-073 amendment 1: activation → create the member + SolarFax emails the connect invite; `customer.subscription.deleted` → `disconnect`; Past Due never disconnects), credentials + the team email per tenant in Secrets Manager `sundial/service-club`, and a member's new estimate carries the plan's discount in the estimate's own discount fields (`Discount_Source__c = Service Plan`). Actions `service.club.read` / `service.club.write`.
- **A Complete call's notes roll up onto the job, in the Lambda, one block per call** (D-072 amendment 9, 2026-09-19, `sundial-service-board/job-notes.js`): work notes → `Notes_for_Summary__c`, private notes → `Notes_From_Service_Calls__c`, headed by the call number so a later edit replaces the block; nothing before completion; never a Flow. `Customer_Type__c` (Solar / Roofing / Commercial / Service) is set like `Requested_Project_Types__c`: Sales defaults Solar, the Service module sets / adds Service.
- **The customer's job report + receipt is one document, built by the office section by section, stored on the job, sent with a button** (D-072 amendment 10, 2026-09-19, `sundial-service-estimate/report.js`, `lib/job-report-document.js` + `lib/job-report-pdf.js`): `Report_Sections__c` JSON (photo on the job + caption, text-only allowed), the header merges the customer / job details and `Customer_Summary__c`, the receipt is `buildInvoiceModel`'s rows and is left out for a partner payer; editable after sending, re-sent as often as needed (`job-report-{n}.pdf` per send, one token for the life of the report); the customer page is `GET /public/reports/{token}` / portal `/report/{token}`. Nothing sends itself.
- **Notifications go through one notifier, to a bell, an open tab and the person's phones** (D-074, 2026-09-21, `lib/notify.js`, `docs/integrations/push-notifications.md`): a Lambda that has something to tell a person calls `notifier.toUsers / toOffice / toProfile` — a row in Supabase `sundial_notifications` (the bell, read by the browser under RLS on `profile_id = auth.uid()`), a broadcast on `user:{profile_id}:notify`, and Web Push (`web-push`, VAPID pair in Secrets Manager `sundial/push`, subscriptions written only by `sundial-notify` from the verified JWT). Recipients are auth uuids; a `Sundial_User__c` id is translated through `profiles.sundial_user_id`. Techs hear schedule changes, reminders (the `sundial-notify` sweep, EventBridge every 5 min), customer texts on today's job, mentions; the office hears tech activity (never "on my way"), money + approvals, customer messages, mentions — each switchable off in `user_preferences.notify_prefs` (a missing key is ON). Every emitter names a `dedupeKey`; the unique `(profile_id, dedupe_key)` is what keeps a replay silent. Best-effort, never a reason to fail the write; never log a title, a body, an endpoint or a key. Action `notify.self`.
- **The Google key stays on the server, for address lookup too** (2026-09-22, `sundial-service-estimate/address.js`): the Service module's customer create gets Google Places suggestions through `GET /service/address/suggest` / `GET /service/address/place/{placeId}` with the key from Secrets Manager `sundial/google-maps` (Places API (New) enabled on it), one Google session per address entry, never a key or Google's widget in the browser. **Every SES attachment declares `ContentTransferEncoding: BASE64`** (`lib/email.js`) — SES's real default is 7-bit and a PDF sent without it arrives unreadable.
- **The price book is tenant-scoped** (`Client__c` on every item) — never the standard Salesforce `Pricebook2`/`Product2`, which cannot be isolated per tenant.

### Key Workflows

**Intake:**
- Phone (manual entry by office staff)
- Email (manufacturer referrals, leasing company work orders — AI parsing)
- Web form on portal
- Online booking (Phase 3)
- AI after-hours voice intake (Add-on service, not Phase 1)

**Triage and scheduling:**
- Office staff create a `Sundial_Service_Job__c` (quick-create also creates its `Sundial_Estimate__c`) — or start from an estimate and *Create Job* on acceptance
- Remote troubleshooting attempted first (monitoring portals)
- Quote truck roll / troubleshooting cost
- Schedule via dispatch board (FullCalendar Premium Scheduler)
- Tech receives schedule in mobile PWA

**Field work:**
- Mobile PWA on tech iPhones (offline-capable via service workers + IndexedDB)
- Clock in opens the tech's `Sundial_Service_Call__c` interval with start time + GPS coordinates + geofence tag (never a blocker)
- Clock out closes the visit with end time + GPS
- Notes, photos, materials captured per visit
- Multi-tech jobs handled by parallel `Sundial_Service_Call__c` records (one tech × one appointment) under one parent job

**Post-field:**
- Office review of completed work
- Manufacturer follow-up if needed
- Invoice generation via Stripe (deferred capture: card on file pre-appointment, charge post-completion)
- Payment receipt syncs to Acumatica

---

## Frontend Specifications

### UI/UX

- **Design language:** Modern SaaS, polished, branded to Harmon
- **Brand name:** Sundial
- **Navigation:** Sidebar on desktop, bottom nav on mobile
- **Color mode:** User toggle (light/dark)
- **Mobile:** Fully responsive, with dedicated PWA mode for field techs

### Key UI Components

1. **Department dashboards** — Residential, Roofing, Service, Commercial, plus executive overview
2. **Project Kanban / Pipeline** — Per department, organized by stage
3. **Project Detail** — Multi-section view with snapshot identity, current customer link, fields, Files tab, communication feed
4. **Service Ticket Detail** — Ticket + linked visits + photos + customer history + payment status + Files tab
5. **Service Dispatch Board** — Multi-tech drag-and-drop schedule (FullCalendar Premium Scheduler)
6. **Install Schedule Builder** — Crew-by-week capacity grid (Phase 3 advanced UI; Phase 1 uses Harmon's existing calendar tools with two-way sync for install scheduling)
7. **Customer Hub** — Sundial_Customer__c view with related projects across all four objects, current and historical
8. **Field User PWA** — Offline-capable mobile: today's assigned work (service tickets AND install jobs), clock in/out with geofence, notes, photos, materials, complete. Service techs see Service Visit context; solar installers see Solar project context; same underlying functionality.
9. **Files Tab on Every Record** — S3-backed file management with upload, download, search, category filtering, and a Related Files section pulling from linked records (customer, related projects, POs). Files automatically sync to Dropbox and are visible in Salesforce via XFiles Pro.
10. **Commercial Gantt View** — Phase 3. Visualizes commercial project milestones (Site Assessment, Design, Permitting, Procurement, Construction, Commissioning, Closeout, PTO) with start/end dates and percent complete from direct fields on `Sundial_Commercial__c`.
11. **Reporting** — Salesforce reports surfaced in portal UI

---

## Coding Conventions

(Inherits from TAG portal CLAUDE.md)

### General

- JavaScript/Node.js everywhere; no Python unless unavoidable
- Comments in plain English explaining WHY
- camelCase for variables/functions, PascalCase for components, SCREAMING_SNAKE for constants
- Always wrap async calls in try/catch
- Use `.env` files locally, Vercel env vars for deployment, never commit secrets

### React

- Functional components with hooks only
- Tailwind CSS for all styling
- shadcn/ui component library
- File structure: `/src/components/`, `/src/pages/`, `/src/hooks/`, `/src/lib/`, `/src/config/`
- State management: React Context for global state, local state for component-level

### Lambda Functions

- Node.js runtime
- One function per API endpoint or grouped by resource
- JSforce for Salesforce
- Shared utilities in `/lib`
- API Gateway with CORS configured

### Acumatica-Specific

- All outbound goes through SQS queue
- OAuth 2.0 patterns per Acumatica REST API docs
- Test against their 2024 R1 sandbox before production
- Always handle retry-after on rate limit responses

### Salesforce-Specific

- Custom object API names use `Sundial_` prefix
- Field API names use clear, descriptive snake_case (e.g., `Customer_Name_at_Creation__c`)
- Flows for cross-object automation; Apex only when Flow can't do it
- Use Platform Events for queue-triggering integration calls

### ⚠️ Portal testing uses the designated test record — never a live customer

**All portal round-trip, save, and field-diff testing runs against the designated test
record. Never a live customer.**

| | |
|---|---|
| **Record** | `Sundial_Customer__c` **`a1P7y00000AmyXCEAZ`** — *"ZZ PORTAL TEST — DO NOT USE"* |
| **Seed / reset** | `node scripts/create-portal-test-record.mjs --apply` (idempotent re-seed) |
| **Known baseline** | `Total_Adder_Price__c` **16,387.50** · `Commission_Total__c` **3,834.50** · `Commission_Redline_PPW__c` **1.85** |

It is deliberately **rich** — adder prices *and* quantities, adders that carry no metadata
default, an NS block with material + hours + markup, a battery, and enough contract/system
data that the commission formulas produce real numbers instead of blanks.

**Why (2026-08-24, the Doug Malde false alarm).** A "blank Adders tab" incident was
triaged against live customer `a1P7y00000AmMy9EAF` on the belief that a portal save had
nulled its fields. It had not. The record was a fresh unlinked lead that had *never* held
adder data — 13 of the 20 adder prices carry no metadata default and are null on
essentially every record in the org (`Adder_Sub_Panel_Price__c`: 0 of 31,626). Hours went
into proving a negative.

Worse, it could not answer the question that mattered. **A record with almost nothing
populated cannot distinguish "the save didn't send that field" from "the save sent it as
null"** — a field that was already blank looks identical either way. The live record was
simultaneously the wrong thing to risk *and* a useless witness.

Two rules follow:

1. **Never test saves against a live customer.** If a save does null fields, you have
   damaged real data to find out.
2. **Test against a record rich enough to fail loudly.** The designated record holds values
   that exist nowhere else in the org, so a blanket-null save is unmissable.

Reset it with the seed script after any test that writes to it, and re-run the script
rather than hand-editing if the baseline ever drifts. Solar-side testing needs its own
designated record when the need arises — note that `Sundial_Budget_Recalc_Trigger` fires
on `Sundial_Solar__c` writes and publishes a recalc platform event, which
`Sundial_Customer__c` does not.

### ⚠️ Access testing uses the designated test USERS — never a live user

**Never log in as, re-level, or reassign the records of a real user to test what they
can see.** Access-model work needs designated test users for the same reason save
testing needs a designated test record, and the reason is sharper one level up.

| | |
|---|---|
| **Users** | 12 ZZ TEST accounts, `tim+zz-*@constructiveoperations.com` (Supabase auth + `Sundial_User__c`) — the ten access-model fixtures plus `zz-tech-2` / `zz-tech-3` for the dispatch board |
| **Passwords** | Secrets Manager **`sundial/test-users`** — never in a file, never in a commit |
| **Seed / reset** | `node scripts/seed-access-test-fixtures.mjs --apply` (idempotent, canary-first) |
| **Records** | `ZZ PORTAL TEST 2` · `ZZ PORTAL TEST B` · `ZZ PORTAL TEST HARMON` + a Solar twin each, `ZZ PORTAL TEST ROOFING`, and the existing designated record stamped to `zz-rep-a1` |
| **Matrix** | `node scripts/verify-access-matrix.mjs` — every test user × every read surface |

**Why a live user is worse here than a live record.** Harmon has exactly **one**
restricted user, Dennis Alessandro, and he is a working salesperson with 3,534
customers. Testing visibility against him means one of three things, all bad:

1. **Logging in as him** — you need his password, so either it gets shared or it gets
   reset out from under him mid-workday. His session is his livelihood.
2. **Re-levelling him** — changing `Access_Level__c` or `Hierarchy_Level__c` to see
   what a different role sees changes *his* access while he is using the portal, and
   the wrong value either blinds him or shows him the whole tenant.
3. **Reassigning his records** — moving `Sales_Rep__c` to observe the filter changes
   who owns real deals, and Salesforce keeps no undo for that.

A test record can be re-seeded. **A person's live access cannot be un-broken while
they are mid-sale**, and the failure is silent from your side and immediate from
theirs.

There is a second reason, the same one the test-record rule rests on: a fixture must
be able to **fail loudly**. The ZZ users span every access level, both dealer sides,
a null dealer and an inactive one, so a scope bug shows up as one user seeing the
wrong set. One live rep can only ever demonstrate one path, and the paths that matter
most — dealer scope, `none` scope, cross-dealer denial — have no live user at all.

**Never substitute a real account to fill a gap in the fixtures.** If a fixture is
missing, add it to the seed script. `scripts/verify-access-matrix.mjs` and
`scripts/probe-cache-reachability.mjs` both take credentials only from
`sundial/test-users` by design.


### ⚠️ Bulk data fixes: canary first, and mind the recalc Flow

**Any script that writes more than a handful of Salesforce records must write ONE record
first, re-read it, and abort if a field it did not write has changed.**
`scripts/fix-burden-rate-percent-domain.mjs` is the reference implementation.

This is not belt-and-braces, it is the *only* check available: **the integration user
cannot read `FlowDefinitionView` or `ApexTrigger`** (both return `INVALID_TYPE` — no View
Setup permission), so there is no way to ask the org what automation is live. The repo
cannot answer it either — `salesforce/flows/` holds drafts that may never have been
deployed. A canary write is empirical where everything else is assumption.

⚠️ **`Sundial_Budget_Recalc_Trigger` is currently a DRAFT — it has never been deployed, and
the SF→AWS platform-event relay was never wired** (see TASKS.md). It lists ~60 fields as
`ISCHANGED` inputs, including every adder, NS block, burden rate and cost parameter.

**When that Flow is activated, bulk data fixes on `Sundial_Solar__c` must deactivate it
first**, then reactivate afterwards. Otherwise a fix touching N records fans out to N
platform events and N Lambda invocations — and today, with 83% of Solar records carrying a
blank sales company, most of those would come back as `SALES_COMPANY_MISSING` errors
written to N records.

On 2026-08-24 a 4,473-record burden-rate fix ran with no fan-out at all. That was **an
accident of sequencing, not a design property** — the Flow simply wasn't live yet. Do not
let its absence today become an assumption tomorrow; the canary is what carries the rule
forward when nobody remembers this note.

`Sundial_Customer__c` has no such trigger, which is why Customer is the safer object to
probe and test against.

### Git Workflow

- **`master` is the mainline in THIS repo (sundial-core) — not `main`.** Deployed code
  lives on the pushed mainline, never on a local-only branch: merge and push `master`
  in the same pass that deploys.
  - Note the asymmetry: the **harmon-crm** repo's mainline is **`main`**. Two repos,
    two names — check which one you are in before merging.
  - History: this repo briefly had an orphan `main` holding only a README, unrelated to
    `master` (no common ancestor). It was the GitHub default branch, which made tooling
    and `git log main` point at an empty tree. The README was ported onto `master` and
    `main` retired.
- Feature branches: `feature/sundial-customer-object`, `feature/acumatica-customer-sync`, etc.
- Descriptive commit messages
- Claude Code handles Git, Tim reviews and approves

---

## Documentation Requirements

Claude Code MUST maintain these files as work progresses:

### PROGRESS.md
- Chronological log of what was built, dated entries
- Bugs found and fixed
- Architectural changes noted

### TASKS.md
- Roadmap and to-do list by phase
- Status markers: `[ ]` TODO, `[x]` DONE, `[~]` IN PROGRESS, `[!]` BLOCKED

### DECISIONS.md — canonical here (sundial-core is self-contained)

sundial-core is the self-contained backend base copied to stand up new tenants, so it carries its OWN decision log and does not depend on harmon-crm docs.

- `DECISIONS.md` (this repo, repo root) — append-only ADRs; **canonical for backend decisions.** Seeded D-001…D-037 from the shared pre-split log; new backend decisions increment here (D-038+). Record any new backend architectural decision here (and update this CLAUDE.md). Numbering caution: coordinate before reusing a D-number on the harmon-crm side (see the provenance note in DECISIONS.md).

**DISCOVERY.md** is NOT carried into sundial-core (it's Harmon discovery prose, product-scoped): it lives only in the harmon-crm repo (`C:\Users\TimMurphy\Projects\harmon-crm\DISCOVERY.md`). A few backend docs still reference it — treat those as pointers to the product repo, not a build dependency.

### docs/ folder

- `docs/salesforce-schema.md` — Full custom object schema, field definitions, relationships, snapshot pattern, sharing architecture. sundial-core owns its copy (self-contained base); synced up to the harmon-crm content 2026-07-21.
- `docs/api-endpoints.md` — Canonical reference for the deployed API Gateway routes, Lambda mappings, request/response shapes
- `docs/caching-architecture.md` — Supabase cache layer, read/write paths, invalidation, Platform Events, always-fresh operations
- `docs/file-storage.md` — S3 bucket structure, file metadata, Lambda functions, portal UI, XFiles Pro integration, Dropbox sync
- `docs/multi-client-deployment.md` — Multi-client deployment pattern, what's shared vs forked, new client checklist, config-driven customization
- `docs/acumatica-integration.md` — API endpoints, payloads, queue config (create when Acumatica work starts)
- `docs/service-workflows.md` — Service ticket lifecycle, intake patterns, dispatch logic
- `docs/migration.md` — Sunbase, HCP, and Dropbox migration plans
- `docs/integrations/` — One file per external system (acumatica, stripe, dropbox-sync, xfiles-pro, sitecapture). Written so far: `aurora-api-reference.md`, `aurora-inbound.md`, `acumatica-budget-push.md`, `budget-recalc-relay.md`, `auth-email-ses.md`, `retell-welcome-call.md`, `sms-twilio.md`, `stripe.md`, `service-club.md`, `push-notifications.md`

**Standing instruction:** After completing any feature, Claude Code must:
1. Update PROGRESS.md
2. Check off the task in TASKS.md
3. Update affected docs/ files
4. If an architectural decision was made or changed, update this repo's `DECISIONS.md` (backend-canonical) and this CLAUDE.md

---

## Communication Style

(From TAG CLAUDE.md, applies here too)

- Tim needs plain English explanations
- Explain trade-offs in practical terms
- Don't assume Tim knows terminal commands, Git concepts, or deployment patterns without checking
- Tim prefers ease of setup over complexity
- Tim prioritizes working software over perfect architecture
- When in doubt, choose simpler and note future improvements
- **Windows-specific:** Use PowerShell commands and Windows file paths. WSL 2 and Docker Desktop for Windows where relevant
- **Always end a session's file changes with the exact git commands to commit them** (branch check, the explicit `git add` list, and the `git commit` with the attribution lines) — Tim runs them; never assume he will compose them (2026-09-11)

---

## Phasing Summary

(Detailed scope in SOW; this is the headline view)

**Phase 1 — Core Platform, Acumatica Integration, Residential Solar, Roofing**
Foundation build. Core Platform, Acumatica integration (full), Sundial_User__c, Sundial_Customer__c, Sundial_Solar__c, Sundial_Roofing__c, Sundial_PO__c, Sundial_PO_Credit__c. Sunbase data migration for residential and roofing. Dropbox documents migrated to S3 with sync-back established. Residential and roofing teams go live.

**Phase 2 — Service Operations**
Service module replacing Housecall Pro: the seven service objects (D-072 — estimate, job, service call, price book item, line, invoice, payment), dispatch board (FullCalendar Premium), mobile PWA with GPS and geofencing, Stripe payments, customer notifications, HCP data migration. Service team goes live, HCP decommissioned.

**Phase 3 — Commercial Solar and Feature Improvements**
Sundial_Commercial__c module, Sunbase commercial migration, Sunbase fully decommissioned. Feature improvements identified through Phase 1 and 2 use. Optional advanced capabilities: install scheduling state machine, service plan e-commerce, customer self-service booking, route optimization.

**Add-On Services (post-Phase 3, separately sold)**
AI after-hours intake (Retell.ai), inbound/outbound call handling, marketing email campaigns, AI customer troubleshooting, continued platform development.

---

## External Service Credentials Needed

Before starting Phase 1 development:

**Completed:**
- [x] GitHub repo created at `https://github.com/ConstructiveOps/harmon-crm`
- [x] Vercel project connected to repo
- [x] Supabase project created, URL and keys captured to `.env`
- [x] AWS access for Lambda + S3 + SQS (existing IAM credentials in use)
- [x] Salesforce Sundial Integration User provisioned
- [x] Salesforce Connected App `Sundial Portal` with JWT bearer flow configured

**Pending:**
- [ ] **Harmon Acumatica API credentials and sandbox tenant URL** (request during ongoing conversations)
- [ ] **Harmon Dropbox API access** for the sync-back Lambda (request alongside Acumatica)
- [ ] Harmon branding: logo (SVG), brand colors, favicon, desired domain
- [ ] **Sunbase export credentials or data export** for migration
- [ ] FullCalendar Premium license (Phase 2)
- [ ] **Harmon Stripe account credentials** (Phase 2)
- [ ] **Housecall Pro export credentials or data export** for migration (Phase 2)
- [ ] **Nonstop Automation webhook configuration** (sometime during Phase 1)

## XFiles Pro Configuration Tasks

XFiles Pro requires manual per-object configuration in Salesforce for the file path pattern. Path pattern uses `SUNDIAL/{record_id}/` (matching the existing OPS prefix pattern Tim's already using for Solar_Project__c). To configure before Phase 1 file features go live:

- [ ] Configure XFiles Pro for `Sundial_Customer__c` with path pattern `SUNDIAL/{record_id}/`
- [ ] Configure XFiles Pro for `Sundial_Solar__c` with path pattern `SUNDIAL/{record_id}/`
- [ ] Configure XFiles Pro for `Sundial_Roofing__c` with path pattern `SUNDIAL/{record_id}/`
- [ ] Configure XFiles Pro for `Sundial_PO__c` with path pattern `SUNDIAL/{record_id}/`
- [ ] Configure XFiles Pro for `Sundial_Service_Job__c` (Phase 2 — after the D-072 package deploys)
- [ ] Configure XFiles Pro for `Sundial_Service_Call__c` and `Sundial_Estimate__c` (Phase 2)
- [ ] Configure XFiles Pro for `Sundial_Commercial__c` (Phase 3, but can be done now)

This is Tim's manual configuration step inside Salesforce; Claude Code does not need to do this. Once configured, files written by Sundial via Lambda to `SUNDIAL/{record_id}/...` will automatically appear in XFiles Pro on the corresponding Salesforce record, and vice versa.
