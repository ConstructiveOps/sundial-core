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
| Payments | Stripe | Service payments, service plan e-commerce (Phase 3) |
| SMS | Twilio (under the hood, not branded in client docs) | Customer notifications, appointment reminders |
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
| `Sundial_Service__c` | Service tickets (parent record for service work) |
| `Sundial_Service_Visit__c` | Individual visits associated with a service ticket (child of `Sundial_Service__c`) |
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
- Sharing rules and role hierarchy based on `Client__c`
- Integration user owns records; Tim maintains the sharing config

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

### Service Object Architecture

- `Sundial_Service__c` (parent ticket) holds work order details, customer reference, system reference (Asset), billing, status, total time roll-up
- `Sundial_Service_Visit__c` (child, many-to-one) holds per-visit time, tech, work performed, photos, clock in/out coordinates, geofence verification
- Photos attach to visit AND ticket AND Asset AND customer using Salesforce native multi-record file linking
- `Sundial_Service_Visit__c` is also used for non-service field work (solar install visits, roofing crew visits, commercial install visits) via a `Visit_Type__c` picklist field plus optional lookups to the project objects. The PWA displays different fields depending on context (service tab vs solar tab) but uses the same underlying object, same GPS, and same clock in/out functions.

### Key Workflows

**Intake:**
- Phone (manual entry by office staff)
- Email (manufacturer referrals, leasing company work orders — AI parsing)
- Web form on portal
- Online booking (Phase 3)
- AI after-hours voice intake (Add-on service, not Phase 1)

**Triage and scheduling:**
- Office staff create `Sundial_Service__c` ticket
- Remote troubleshooting attempted first (monitoring portals)
- Quote truck roll / troubleshooting cost
- Schedule via dispatch board (FullCalendar Premium Scheduler)
- Tech receives schedule in mobile PWA

**Field work:**
- Mobile PWA on tech iPhones (offline-capable via service workers + IndexedDB)
- Clock in creates `Sundial_Service_Visit__c` with start time + GPS coordinates + geofence verification
- Clock out closes the visit with end time + GPS
- Notes, photos, materials captured per visit
- Multi-tech jobs handled by multiple `Sundial_Service_Visit__c` records under one parent ticket

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
- `docs/integrations/` — One file per external system (acumatica, stripe, dropbox-sync, xfiles-pro, sitecapture). Written so far: `aurora-api-reference.md`, `aurora-inbound.md`, `acumatica-budget-push.md`, `budget-recalc-relay.md`, `auth-email-ses.md`, `retell-welcome-call.md`

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

---

## Phasing Summary

(Detailed scope in SOW; this is the headline view)

**Phase 1 — Core Platform, Acumatica Integration, Residential Solar, Roofing**
Foundation build. Core Platform, Acumatica integration (full), Sundial_User__c, Sundial_Customer__c, Sundial_Solar__c, Sundial_Roofing__c, Sundial_PO__c, Sundial_PO_Credit__c. Sunbase data migration for residential and roofing. Dropbox documents migrated to S3 with sync-back established. Residential and roofing teams go live.

**Phase 2 — Service Operations**
Service module replacing Housecall Pro: Sundial_Service__c, Sundial_Service_Visit__c, dispatch board (FullCalendar Premium), mobile PWA with GPS and geofencing, Stripe payments, customer notifications, HCP data migration. Service team goes live, HCP decommissioned.

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
- [ ] Configure XFiles Pro for `Sundial_Service__c` (Phase 2, but can be done now)
- [ ] Configure XFiles Pro for `Sundial_Service_Visit__c` (Phase 2)
- [ ] Configure XFiles Pro for `Sundial_Commercial__c` (Phase 3, but can be done now)

This is Tim's manual configuration step inside Salesforce; Claude Code does not need to do this. Once configured, files written by Sundial via Lambda to `SUNDIAL/{record_id}/...` will automatically appear in XFiles Pro on the corresponding Salesforce record, and vice versa.
