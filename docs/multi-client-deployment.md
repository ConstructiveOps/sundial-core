# Sundial — Multi-Client Deployment Architecture

> How Sundial scales from one client (Harmon) to multiple clients without rebuilding the platform each time.

> **Status 2026-09-29 — what the code actually does.** The text below is the DESIGN. As built, a second tenant (`conops-demo`, a demo) is added on the **same deployed Lambdas and the same Supabase project** as Harmon — there is no per-client Supabase project, no `sundial-template` repo, no per-tenant S3 prefix and no `supabase/migrations/` (the Supabase project ref is a constant in `lib/supabase-auth.js`; the bucket is `sfsolproj`, keys `SUNDIAL/{recordId}/…`).
>
> - **A tenant is a `Sundial_Tenant__c` record** (its `Name` is the slug). Every record carries `Client__c`, every Lambda read and write filters on it (D-034, D-035, D-064), and the per-tenant settings are blocks keyed by slug in Secrets Manager: `sundial/brand` (`companyName`, logo, `portalUrl`, `publicUrl`), `sundial/twilio.tenantNumbers`, `sundial/stripe.tenants`, `sundial/service-club.tenants`.
> - **The primary-tenant rule (D-078).** Harmon predates per-tenant configuration, so every single-credential integration (Acumatica, Aurora, the Retell welcome call) and every un-keyed fallback (the shared texting line, a flat Stripe / club secret, `PORTAL_BASE_URL`, `SERVICE_PUBLIC_BASE_URL`, `SERVICE_BRAND_NAME`) serves the primary tenant (`SUNDIAL_PRIMARY_TENANT`, default `harmon`) and nobody else. Any other tenant gets an integration only through its own per-slug entry or that integration's `SUNDIAL_<NAME>_TENANTS` allowlist, and otherwise a clean `INTEGRATION_NOT_ENABLED` / `PORTAL_URL_NOT_CONFIGURED` / "not set up" — never Harmon's credentials, phone line, company name or portal address.
> - **Not solved yet:** the CORS allowlist is hardcoded in six files (a `*.vercel.app` origin works, a custom domain does not); one shared `auth.users` (one email = one login = one tenant) and Realtime channels that are not private; org-wide picklists and field manifest; shared auto-number sequences; Salesforce Flows and alerts are not tenant-filtered.
>
> See **DECISIONS.md D-078** for the full list of guarded surfaces and what a new tenant needs.
>
> **2026-10-09:** [Spinning Up a New Client](#spinning-up-a-new-client-checklist) is rewritten against the code (no longer the design), and the portal side is checked against **`docs/portal-feature-inventory.md`** — the manifest of every platform feature, with what each needs on the backend and what a new client repeats (D-025 amendment 1). Sections below the status note that still describe the design are marked *(design — not built)*.

---

## Architecture Pattern

Sundial uses a **shared backend, forked frontend** multi-client pattern:

- **Shared across all Sundial deployments:** Salesforce org, Sundial_* custom objects, Sundial Integration User, Connected App, Lambda code, all third-party integrations (Acumatica, Aurora, Nonstop Automation, Stripe, etc.)
- **Forked per client:** React/Vite codebase, GitHub repo, Vercel deployment, Supabase project, branding, custom field configurations, module enablement, custom layouts

This pattern is right-sized for the target client count (under 10 clients in the first two years per Tim's direction). Past that scale, we would revisit toward a true multi-tenant single-frontend architecture, but that's not a near-term concern.

---

## What Is Shared

### Salesforce
- Single org (Constructive Operations Sales Cloud Enterprise)
- All Sundial_* custom objects
- Sundial Integration User (one user services all clients via the Connected App)
- Connected App `Sundial Portal` with the JWT bearer flow

### Lambda Code
- All integration code (Acumatica push/pull, Aurora webhook ingestion via Zapier, Stripe handling, etc.)
- Authentication and authorization logic
- File upload/download/list handlers
- Tenant filtering enforcement
- Common business logic

*(design — not built.)* As built, one set of deployed Lambdas (this repo, `.\deploy.ps1`) serves every tenant; there is no NPM package and no per-client deployment.

Lambda code lives in a shared private NPM package (`@constructiveops/sundial-core`) consumed by each client's Lambda deployment. Bug fixes and feature additions in the shared package propagate to all clients by version-bumping.

### Cross-Cutting Infrastructure
- AWS account (single, shared across clients)
- S3 bucket — *as built* `sfsolproj`, keys `SUNDIAL/{recordId}/…`, no per-client prefix (D-033); its own CORS rules must allow every portal origin (see the checklist, step 3)
- SQS queues (per integration, shared across clients with tenant-aware processing)
- CloudWatch alarms

### Co-Branding Signature (Standard — planned, not yet implemented)
Per **DECISIONS.md D-037**, every client portal keeps **client branding dominant** while carrying a **subtle, consistent Sundial platform signature** as co-branding. Although it renders in the forked frontend, the *standard itself is shared*: it lives in the `sundial-template` so every client fork inherits the same understated treatment. Two standard placements:
- **Login page:** a small Sundial mark centered at the bottom, beneath the client "Powered by Sundial" footer text.
- **App shell:** a persistent, muted "Powered by Sundial" footer on every authenticated page (implemented as a shared layout component).

Status: **planned/standard element, not yet built.** It depends on a Sundial mark asset (transparent-background SVG or small PNG) being added to `src/assets/branding/`, which is **not yet present in the repo**. See D-037 for the full standard and implementation notes.

---

## What Is Forked Per Client

### Frontend Repository
Each client gets its own GitHub repo, forked from the `sundial-template` repo. Examples:
- `harmon-crm` (Harmon Electric)
- `clientB-crm`
- `clientC-crm`

### Vercel Project
Each client's frontend deploys to its own Vercel project, with its own domain or subdomain.

### Supabase Project
*(design — not built.)* **As built, one Supabase project is shared by every tenant** (D-078; the checklist's step 6 lists what that means).

Each client has a dedicated Supabase project for:
- Authentication (portal users)
- Real-time chat per project/ticket
- Notifications
- Audit logs
- File metadata
- The cached Salesforce data layer (see `docs/caching-architecture.md`)

Why Supabase is forked rather than shared: clean tenant isolation at the database layer, no cross-client query risk, independent scaling per client, and each client's data lives in its own Supabase project for portability.

### Per-Client Configuration
A `client-config.ts` file in each forked repo controls:
- Module enablement (which of the four modules this client uses)
- Branding (logo URL, primary color, secondary color, company name, favicon)
- Field visibility per module (which fields show on which layouts)
- Pipeline stage definitions (clients have different sales/install workflows)
- Document categories (clients organize files differently)
- Feature flags (drag-and-drop scheduling, service plan e-commerce, etc.)
- Default report and dashboard set
- Acumatica template IDs and field mappings for that client
- Dropbox sync target path

---

## Tenant Isolation Rules

These are **hard rules** enforced at every layer. *As built (2026-10-09):* rule 1's target is `Sundial_Tenant__c` (D-034), not a user record; rule 3 is **not** true — one Supabase project serves every tenant, and the cache rows carry `client_sf_id`; rule 5 is **not** built — S3 keys are `SUNDIAL/{recordId}/…` with no tenant segment (D-033), and a presigned URL is issued only after the record's tenant is checked. Rules 2 and 4 hold.

1. **Every Sundial_* Salesforce record has a `Client__c` lookup** pointing to the top-level Sundial_User__c record representing the client organization.

2. **Every Lambda query against Salesforce filters by Client__c** based on the authenticated portal user's client scope. No exceptions. Tenant filtering is a code-level enforcement, not a configuration option.

3. **Every Supabase project is single-tenant.** No cross-client data ever lives in one Supabase project.

4. **Lambda functions accept a tenant context** (derived from the authenticated user's Sundial_User__c.Client__c) and reject any operation where the requested data doesn't match the tenant context.

5. **S3 file paths include the tenant ID** as the first path segment (`{tenant_id}/{object_type}/{sf_record_id}/{filename}`). Lambda enforces tenant ID match before generating presigned URLs.

---

## Spinning Up a New Client (Checklist)

> **Rewritten 2026-10-09 against what the code does** (the 2026-09-29 status note at the top
> of this file). The earlier checklist — a Supabase project per client, a `sundial-template`
> repo, schema migrations per client, Lambdas per client, sharing rules, an S3 prefix per
> tenant — described a design that was not built. The worked example is the `conops-demo`
> tenant (`docs/demo-tenant-seed.md`, and the `conops-demo` repo's `CLIENT_DIVERGENCE.md`).
>
> The portal side is checked row by row against **`docs/portal-feature-inventory.md`**: every
> row is present in the fork or listed in its `CLIENT_DIVERGENCE.md`. The step codes in
> brackets (ORIGIN, BRAND, TWILIO, …) are that file's.

**What a new client is, as built:** one `Sundial_Tenant__c` record, per-slug blocks in a few
Secrets Manager secrets, a forked portal repo + Vercel project, and nothing else. The
Salesforce org, the deployed Lambdas, the API Gateway, the Supabase project (auth, cache,
comments, notifications, Realtime), the S3 bucket and the EventBridge schedules are all
**shared** and already serve every tenant. Records are kept apart by `Client__c` on every
read and write (D-034, D-035, D-064); everything around the records is kept apart by the
primary-tenant rule (D-078).

### 0. Decide first (30 minutes, with the client)

1. **The slug** — lower-case, e.g. `acme`. It becomes `Sundial_Tenant__c.Name` and the key
   of every per-tenant secret block. **It is load-bearing: never rename it later** without
   re-keying every block in the same change (D-078).
2. **Modules and integrations.** Which of Solar / Roofing / Service / Commercial; Stripe
   (card on file, hosted payments)? Texting? The Service Club? Acumatica, Aurora and the
   Retell welcome call are single-credential and serve the primary tenant (Harmon) only —
   a new client gets them only with its own credentials and code work, never by sharing
   Harmon's. Whatever is "no" is removed from the fork and listed in `CLIENT_DIVERGENCE.md`.
3. **The portal address** (custom domain, e.g. `https://sundial.acme.com`) — needed by the
   CORS allowlist, Supabase Auth and the brand secret before the first invite goes out.

### 1. Salesforce — the shared org (1 hour)

1. Create the **`Sundial_Tenant__c`** record: `Name` = the slug. Set
   `Default_Tax_Rate__c`, `Default_Tax_Jurisdiction__c` (new estimates' tax) and
   `Labor_Burden_Percent__c` (job costing) [TENANT-ROW].
2. Create the **first admin's** `Sundial_User__c` (`Client__c` → the tenant,
   `Access_Level__c` Admin or Executive) and its Supabase login — the way
   `scripts/seed-demo-tenant.mjs` does it. Everyone after that is created by that admin in
   **Manage Users** (invite email from `sundial-user-admin`). Per person: access level
   (Technician → the tech app), default department, **On Dispatch Board** + order, bill and
   cost rates [USERS]. **One email = one login = one tenant**: an address that already has
   a login in another tenant is refused (`409 EMAIL_IN_USE_OTHER_TENANT`).
3. **Dealers** (`Sundial_Dealer__c`) if the client sells through dealers.
4. **Price book** — `Sundial_Price_Book_Item__c` rows with `Client__c` (the import in
   `salesforce/pricebook-import/`). Never the standard `Pricebook2`.
5. **Service Club** (if any) — the tenant's `Sundial_Service_Plan__c` rows [CLUB].
6. **Picklists and the field manifest are org-wide.** Stages, lead sources, request
   types, intake picklists, departments: the new client sees the same values as Harmon.
   Agree on them, or narrow them client-side in the fork (`conops-demo`'s
   `picklist-overrides.ts`) [PICKLIST].
7. **Check the org's automation is tenant-safe** — record-triggered Flows, email alerts
   and the D-019 mirror are not tenant-filtered by any code (D-078 → *What this does NOT
   solve*). The integration user cannot list them; Tim checks in Setup. Auto-numbers
   (`EST-`, `SVC-`) are shared sequences.
8. **Nothing else.** No sharing rules (OWD is Public Read/Write on every `Sundial_*`
   object and Salesforce sharing is inert — access is `lib/access.js`), no new fields
   (a client-only field goes on the shared object; see Open Decisions), no new Connected
   App, no new integration user.

### 2. Secrets Manager — the tenant's blocks (30 minutes)

Each is a block **keyed by the slug** inside an existing secret. Another tenant's value —
Harmon's included — is never used as a fallback (D-078): a tenant with no block is "not
set up", not "uses Harmon's".

| Secret | Block | Needed for | Without it |
|---|---|---|---|
| `sundial/brand` | `<slug>`: `companyName`, `portalUrl`, `publicUrl` (defaults to `portalUrl`), `logoUrl`, `addressLine`, `phone`, `email`, `licenseLine`, `websiteUrl`, `paymentTerms`, `termsUrl` / `termsBlurb`, `clubUrl` / `clubBlurb`, `tagline`, `footerNote` | **Anything customer- or invite-facing**: invites, password resets, @-mention emails, estimate / invoice / report pages, PDFs and emails, card links, the "on my way" text | `PORTAL_URL_NOT_CONFIGURED` on invite / resend / card links; messages go without the link or are recorded unsent; documents print no name or logo |
| `sundial/twilio` | `tenantNumbers.<slug>` = a Twilio number on the Constructive Ops account | Texting from the job page, "on my way", report-by-text | "Texting isn't set up" |
| `sundial/stripe` | `tenants.<slug>` = the client's Stripe secret key + webhook signing secret | Card on file, charge card, pay on the hosted estimate page, the Service Club | Money buttons say Stripe isn't set up |
| `sundial/service-club` | `tenants.<slug>` = SolarFax credentials + team email | The Service Club (needs Stripe) | Club routes refuse |
| `sundial/lead-webhooks` | the vendor's URL slug → this tenant | A lead vendor posting straight to Sundial (D-077) | — (only if wanted) |

**Shared, nothing per tenant:** `sundial/salesforce`, `sundial/supabase`, `sundial/push`
(one VAPID pair for every portal), `sundial/google-maps` (one server key; billing only).
**Primary tenant only, never copied:** `sundial/acumatica`, `sundial/aurora`,
`sundial/retell`, `sundial/hcp`.

### 3. The portal's origin (30 minutes + a redeploy) [ORIGIN]

1. **API CORS allowlist** — add the origin to `lib/http.js` **and** the five inline copies
   (`sundial-auth-proxy`, `sundial-sf-query`, `sundial-sf-update`,
   `sundial-acumatica-push`, `sundial-aurora-push`); `lib/http.test.js` fails if one is
   missed. Redeploy every Lambda that bundles them (take the list from the esbuild
   metafiles, not from memory). A `*.vercel.app` preview origin already works; a custom
   domain does not until this is done.
2. **Supabase Auth → URL Configuration** — add `https://<domain>/**` to the redirect
   allowlist. Leave the Site URL as Harmon's (one project; `docs/integrations/auth-email-ses.md`
   Part C).
3. **The S3 bucket's own CORS** — `aws s3api get-bucket-cors --bucket sfsolproj
   --region us-west-1`. Today it is `AllowedOrigins: ["*"]` for `GET`, `PUT`, `POST`,
   `HEAD` with `ETag` exposed, so nothing to do. **If it has been narrowed, add the origin**:
   every browser upload (presigned `PUT`), file download, photo view, the photo viewer's
   Download and **Download all as zip** (`fetch()` from S3 in the browser) fail without it.
   This step was unwritten until 2026-10-09.
4. **Google Maps browser key** — add the origin to the referrer restriction of the key in
   `VITE_GOOGLE_MAPS_BROWSER_KEY` (or issue the fork its own key) [GMAPS-B].

### 4. Third-party consoles (only what step 0 said yes to)

- **Twilio:** the tenant's number → Messaging webhooks `POST /sms/inbound` and
  `/sms/status` on the shared API base, exactly as `SMS_WEBHOOK_BASE` (the signature covers
  the URL) [TWILIO]; `docs/integrations/sms-twilio.md`.
- **Stripe:** in the client's account, a webhook endpoint `POST /webhooks/stripe/<slug>`
  with the events in `docs/integrations/stripe.md`; its signing secret into the stripe
  block [STRIPE].
- **Service Club:** `node scripts/seed-service-club.mjs` for the tenant (mints the Stripe
  Products / Prices from the plan rows) [CLUB]; `docs/integrations/service-club.md`.

### 5. Lambdas — nothing to deploy

The deployed functions already serve every tenant; there is no per-client Lambda set and no
per-client environment. Two things to know:

- `SUNDIAL_<NAME>_TENANTS` would let the new tenant share Harmon's Acumatica, Aurora or
  Retell. **Leave it unset.**
- Some settings are still **one value per Lambda**, i.e. Harmon's for every tenant:
  `SERVICE_TIMEZONE` (appointment emails, payroll weeks), `SERVICE_SHOP_LATLNG` +
  `SERVICE_GEOFENCE_METERS` (the geofence tag), `REMINDER_HOUR`, `EMAIL_FROM` /
  `EMAIL_REPLY_TO` (replies go to Constructive Ops). A client in another timezone or
  wanting replies to reach its own office is a code change (move it into the brand / tenant
  settings) before go-live — not an env edit, which would change Harmon too.

### 6. Supabase — nothing to create

One project serves every tenant (ref in `lib/supabase-auth.js`); every SQL file in `sql/`
is already applied there; the cache tables carry `client_sf_id` and the sync fills them for
every tenant. Know the consequences:

- The fork's `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are **the same values as
  Harmon's**.
- A login works at any tenant's portal URL. `GET /auth/me` returns `tenant.slug`; the fork
  should sign out a login whose slug is not its own (`conops-demo`'s
  `src/lib/tenant-lock.ts`). **harmon-crm does not have this yet** — port it into the
  template.
- Realtime broadcast channels are not private (names carry the tenant id; the payloads
  are invalidation hints, not records).
- Auth session lifetime is one setting for everyone (`docs/pwa-architecture.md` →
  *Staying signed in*).

### 7. The portal fork (half a day to two days)

1. **Copy harmon-crm at a known commit** into the new repo and write that commit at the top
   of `CLIENT_DIVERGENCE.md`. (There is no `sundial-template` repo; harmon-crm is the
   template — D-025 amendment 1.)
2. **`src/config/client-config.ts`** — `tenantId` = the slug, names, and the switches the
   fork reads. harmon-crm's copy is mostly unread; `conops-demo` rewrote it so every key is
   read — prefer that shape.
3. **Branding** — the logo / mark PNGs and their 13 import sites, `index.html` title,
   `public/icons/*`, `public/sw.js` `VERSION` [BRAND-ASSETS].
4. **Remove what step 0 said no to** — PRIMARY-ONLY integrations always (Acumatica budget
   push / attribute sync / customer push, Send to Aurora, the "Not in Acumatica" invoice
   filter), the Service Club if not wanted, and so on. Each removal is a section in
   `CLIENT_DIVERGENCE.md` (`conops-demo` § 3 is the model).
5. **Harmon-specific text in code** — the generated detail configs' labels and help text,
   `INTAKE_FIELDS`, default state `AZ`, the Phoenix map centre, board hours
   (`portal-feature-inventory.md` → *Known Harmon leftovers*).
6. **Walk `docs/portal-feature-inventory.md` row by row.** Each row: present and working,
   or in `CLIENT_DIVERGENCE.md`. Rows dated after the copy commit are improvements the fork
   does not have yet.

### 8. Vercel (15 minutes)

1. New project from the fork's repo (`vercel.json` already rewrites every path to
   `index.html` — needed for `/tech`, `/estimate/:token`, `/report/:token`, `/club`).
2. Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
   `VITE_API_GATEWAY_URL` (all three the shared values), `VITE_GOOGLE_MAPS_BROWSER_KEY`
   (optional). `VITE_TENANT_ID` is in `.env.example` but **no code reads it** — the tenant
   comes from the login.
3. Custom domain + DNS. Only then send invites — the invite link is built from
   `portalUrl`.

### 9. Data

- Records written straight to Salesforce (a migration, a seed) reach the portal's lists
  through the cache sync. It runs every 5 / 30 minutes but a never-synced object only looks
  back 24 hours — invoke `sundial-cache-sync` once by hand right after a bulk load
  (`docs/demo-tenant-seed.md` step 5, with `--cli-read-timeout 0`).
- Migrations follow the bulk-fix rule (canary first). HCP (`scripts/hcp-*.mjs`) and
  Sunbase tooling were written for Harmon; reuse them with new mappings and a new
  `HCP_Id__c` population, never over another tenant's records.

### 10. Verification

1. Log in as the new tenant's admin: every module that should exist has its screens; the
   lists show only the new tenant's records.
2. Log in as a Harmon **ZZ TEST** user (never a live one): none of the new tenant's
   records is visible. `scripts/verify-access-matrix.mjs` still passes.
3. Upload a file, open a photo full-screen, **Download all** on a job's photos — proves the
   bucket CORS for the origin.
4. Send an invite and a password reset — both links open the new portal, not Harmon's.
5. Send an estimate to yourself: the page and PDF carry the new brand; no Harmon name,
   logo, phone or address anywhere.
6. If texting: send a text from a job and reply — the reply lands on that job.
7. If Stripe: a test-mode card on file, then a charge; the webhook settles it.
8. Turn push on in Settings → Notifications and **Send me a test**.
9. Press the Acumatica / Aurora buttons if any survived the fork: they must answer
   `INTEGRATION_NOT_ENABLED`, never act.

---

## Config-Driven Customization

The principle: **default to configuration, fork code only when configuration cannot express what's needed.**

### What Belongs in `client-config.ts`
- Module enablement
- Branding (logo, colors, copy)
- Field visibility per layout
- Pipeline stage labels and ordering
- Document categories
- Default report and dashboard sets
- Acumatica template IDs and field mappings
- External system endpoints unique to this client
- Module-level feature flags

### What Belongs in Forked Code
- Truly custom UI components a client needs that no other client wants
- Client-specific business logic that doesn't generalize
- Custom integration to a system unique to this client
- Workflow logic that diverges substantially from the shared default

When a client requests a "small tweak," default to adding a config knob. Fork the code only when the config approach would make `client-config.ts` unmaintainable.

### After Forking
Document what diverged in a `CLIENT_DIVERGENCE.md` file at the root of each forked repo. This makes it obvious during template upstream pulls what conflicts to expect.

---

## Template Repo Strategy

*(design — not built.)* **As built (D-025 amendment 1, 2026-10-09): there is no `sundial-template` repo — `harmon-crm` is the template.** A fork is a copy of harmon-crm at a recorded commit; what the platform includes is `docs/portal-feature-inventory.md`; what the fork does differently is its `CLIENT_DIVERGENCE.md`. Bringing a fork up to date = take the inventory rows dated after its copy commit, port them, re-apply the divergences that touch the same files. The workflow below is the eventual shape once a second paying client exists.

The `sundial-template` repo is the gold copy. As features evolve, the template gets updated. Existing client repos selectively pull template updates.

### Workflow
1. New features and bug fixes land in `sundial-template` first
2. Each client repo can pull from template via `git remote add template ...` and `git merge template/main` (with conflict resolution)
3. Diverged areas (per `CLIENT_DIVERGENCE.md`) are resolved manually
4. Each client's merge happens on its own cadence based on what features matter to them

### Discipline
- Don't push client-specific code back to the template
- Don't pull from one client's repo into another (always go through template)
- Keep the template lean and well-documented; bloat in the template makes every client harder to maintain

---

## Open Decisions

- **Lambda deployment model:** shared functions with tenant context routing, or per-client function deployments? Shared is simpler but couples failures; per-client is more isolated but more deployments to manage. Defer until we have 2+ clients in production. *(As built: shared, with the D-078 guards — revisit only if a client needs its own Acumatica / Aurora / timezone settings that the shared functions cannot key by slug.)*
- **Per-client custom Salesforce fields:** when a client needs a field no one else uses, add it to the shared Sundial_* object with a clear naming convention (`ClientName_Field__c`), or hold them in a separate object? Defer until the second client requires it.
