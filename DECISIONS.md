# Sundial — DECISIONS.md

> Architectural Decision Records (ADRs) for the Sundial platform project.
> Append-only. Superseded decisions are marked but not deleted.
>
> **Provenance & scope (2026-07-21):** sundial-core is the self-contained backend
> base copied to stand up new tenants, so it carries its own decision log — it must
> not depend on the harmon-crm repo. D-001…D-037 were seeded from the shared
> pre-split log; sundial-core is canonical for **backend** decisions going forward
> (D-038+ here). The harmon-crm repo keeps its copy as the product-wide history
> (incl. frontend/product decisions). **Numbering caution:** to avoid D-number
> collisions across the two repos, backend decisions increment here; coordinate
> before reusing a number on the harmon-crm side.

---

## D-001: Single-Tenant Salesforce Architecture for Harmon

**Date:** 2026-05 (discovery phase)
**Status:** Decided

**Context:** Need to decide whether Harmon gets its own Salesforce org or shares Constructive Operations' existing Sales Cloud Enterprise org.

**Decision:** Harmon's data lives in Constructive Operations' existing Salesforce org alongside TAG portal data and Constructive Operations data. Data isolation handled via `Tenant__c` or `Client_Account__c` field on all relevant records, sharing rules, and role hierarchy. Harmon does not get its own Salesforce org.

**Alternatives Considered:**
- Separate Salesforce org for Harmon — Cleaner tenancy story but added licensing cost (~$165+/user/month for Tim as admin), separate maintenance, and operational overhead. Not justified given Tim is the only Salesforce user across all clients.
- Salesforce Experience Cloud / Partner Community — Heavier setup, more rigid licensing, and overkill for the no-Salesforce-users model.

**Rationale:** Tim is the sole admin across all clients. Single org maximizes consistency, minimizes licensing, and matches how the TAG portal already operates. Multi-tenancy is handled at the application layer (portal + integration user) rather than the Salesforce org layer.

**Risks:** API limit consumption is shared across all clients. Need to monitor and possibly batch operations during high-traffic periods.

---

## D-002: No Salesforce Licenses for Harmon Users

**Date:** 2026-05
**Status:** Decided

**Context:** Harmon will have between 15 and 30 users across sales, PM, dispatch, service, office, and admin. Should they have Salesforce user licenses?

**Decision:** No. All Harmon users authenticate against Supabase and interact with Salesforce data exclusively through the custom portal UI. A single Salesforce Integration User handles all portal-to-SF API traffic.

**Alternatives Considered:**
- Per-user Salesforce licenses ($165+/user/month) — Would cost Harmon $30k-60k/year just in SF licensing. Defeats the cost model.
- Salesforce Experience Cloud licenses (~$50-75/user/month) — Still adds material cost and locks the UI into Salesforce's framework.

**Rationale:** Matches the TAG portal model that already works. Keeps Harmon's cost predictable and the UX fully under our control. Tim writes all Flows, builds all reports, and pushes those reports into the portal UI.

**Implications:**
- Tim must build report rendering into the portal (cannot rely on native Salesforce report viewing)
- Audit trail at the Salesforce layer attributes everything to the Integration User; the portal must capture user-level actions in its own audit log
- Real-time multi-user features go through Supabase, not Salesforce

---

## D-003: Service Data Model — Custom Service_Ticket__c + Service_Visit__c

**Date:** 2026-05
**Status:** Decided (object names updated under D-018; pattern unchanged)

**Context:** Need to model service work in Salesforce. Three options: standard Case + WorkOrder + ServiceAppointment (Field Service objects), Case alone with extensions, or fully custom objects.

**Decision:** Custom `Service_Ticket__c` as parent with `Service_Visit__c` as child for per-visit time tracking. Linked to standard `Asset` for the installed system and `Account` for the customer.

**Alternatives Considered:**
- Standard Case + WorkOrder + ServiceAppointment — Built for Field Service Lightning. Inherits FSL-shaped logic and would push us toward FSL licensing.
- Standard Case alone with custom fields — Too constrained for the multi-visit time tracking pattern. Case is built for help-desk style work, not field service.

**Rationale:** Service_Visit__c child object directly solves Harmon's biggest stated HCP pain point: time tracking on paused-and-resumed jobs. Each visit has its own start/end times, assigned tech, and notes; the parent ticket aggregates them. Custom objects give us total schema control without inheriting FSL complexity or licensing pressure.

**Implications:**
- Reporting on ticket vs visit metrics requires both objects to be queryable in the same report (parent-child reporting standard in SF)
- Multi-tech jobs handled via a junction object or via multiple Service_Visit__c records per ticket
- Photos and files attached at the Visit level but linked to Ticket, Asset, and Account using SF's native multi-record file linking

---

## D-004: Mobile Field Tech App as Progressive Web App (PWA)

**Date:** 2026-05
**Status:** Decided

**Context:** Field techs need a mobile experience to view schedule, clock in/out, capture photos, add notes, log materials, and complete jobs. Harmon explicitly stated offline capability is a real requirement (rooftops, basements, hot phones in summer). The field UX does not need to be flashier than HCP, just functional and easy.

**Decision:** Build a Progressive Web App in the existing React/Vite stack with service workers for offline capability and IndexedDB for queued actions. Install to iPhone home screen via Safari's "Add to Home Screen."

**Alternatives Considered:**
- Native iOS app (React Native, Swift) — Better offline UX, push notifications easier, but separate codebase, App Store deployment hassle, longer build time.
- Basic mobile-responsive web (no offline) — Insufficient given explicit offline requirement.
- Continue using HCP's mobile app temporarily — Defeats the unified-platform goal and maintains HCP cost.

**Rationale:** PWA gives us 90% of native app capability with 30% of the engineering effort, keeps everything in one codebase, no App Store gatekeeping, and works well enough for field service requirements when designed carefully. Harmon's "doesn't need to be flashier than HCP" answer takes pressure off the UI polish.

**Implications:**
- Service workers must handle background sync, conflict resolution on reconnect
- Photo uploads need queueing and retry logic
- IndexedDB stores today's schedule, draft notes, captured photos until online
- Push notifications via Web Push API (Safari support landed in iOS 16.4)

---

## D-005: Dispatch Board Phasing — List First, Drag-and-Drop Later

**Date:** 2026-05
**Status:** Decided

**Context:** A drag-and-drop dispatch board is the single hardest UI component in the service module. Harmon currently uses HCP's drag-and-drop board. Building one from scratch is 3-5 months of solo dev work.

**Decision:** Phase 1 ships scheduling via Salesforce-driven list and grid views in the portal, with Google Calendar push to tech phones at lock-in. Phase 2 layers FullCalendar Premium with the Scheduler plugin on top of the existing data model for true drag-and-drop dispatch.

**Alternatives Considered:**
- Build full drag-and-drop dispatch board in Phase 1 — Delays go-live by months and pushes other work off the critical path.
- Use third-party scheduling tool (Skedulo, GeoOp) — Conflicts with no-Salesforce-users model or introduces another platform to integrate.
- Keep HCP running for dispatch only during transition — Maintains the Acumatica integration pain point and the cost of two systems.

**Rationale:** The underlying data model, automations, and state machine are identical regardless of dispatcher UI. Phase 1 list view is genuinely usable for a 7-tech operation doing 150-230 tickets/month. Phase 2 adds the visual polish without architectural rework. Honest with Harmon about the trade-off and the upgrade path.

**Implications:**
- Phase 1 dispatchers operate via form-based assignment rather than drag-and-drop (more clicks per change, but functional)
- Phase 2 effort is mostly UI work, not data model work
- FullCalendar Premium license required for Phase 2 (~$480-960/year, exact pricing TBD)

---

## D-006: Install Scheduling State Machine

**Date:** 2026-05
**Status:** Decided

**Context:** Install scheduling is materially different from service dispatch. Multi-day jobs, capacity balancing across crews by wattage, materials gates, and customer-affirmative-confirmation are all required. Drafts must be reworkable, with no downstream effects firing until explicit progression.

**Decision:** Install projects move through an explicit state machine: Ready for Install → Draft Scheduled → Customer Confirmation Requested → Customer Confirmed → Materials Confirmed → Locked → In Progress → Complete. Each transition is gated by Flow logic and configurable via `Scheduling_Automation_Settings__mdt` Custom Metadata Types.

**Alternatives Considered:**
- Simple "scheduled" vs "not scheduled" status — Doesn't support the draft/rework workflow Harmon described.
- Drag-on-calendar = scheduled-and-confirmed — Triggers customer comms prematurely, can't support the "draft a week, then send confirmations" workflow.

**Rationale:** The state machine separates the dispatcher's planning work from downstream side effects (customer comms, calendar pushes, materials orders). Draft state is a safe playground. Nothing happens to the customer or the crew until the dispatcher explicitly advances state.

**Implications:**
- Every Flow checks current state before firing
- Custom Metadata Types control automation behavior (toggles for SMS, email, days-of-notice, etc.) — Tim can change behavior in Setup without code changes
- Portal Schedule Builder UI shows state as visual indicators (draft = dashed, confirmed = solid, etc.)

---

## D-007: Acumatica Integration via Custom Lambda + SQS Queue

**Date:** 2026-05
**Status:** Decided

**Context:** Acumatica has a "concurrent" API call limit shared across all integrations. Harmon has at least one and possibly several other systems hitting their API. We need to integrate without colliding.

**Decision:** Custom AWS Lambda + SQS architecture. Outbound calls queued in SQS, consumed by Lambda at configurable concurrency, with exponential backoff and dead-letter queue. Inbound via Acumatica webhook generic inquiries. No paid connector (Commercient, Celigo, etc.).

**Alternatives Considered:**
- Commercient SYNC — White-glove but $5-10k setup + $300-800/month ongoing. Not aligned with Tim's cost model.
- Celigo iPaaS — Flexible, ~$600-1,800/month. Better than Commercient but still ongoing third-party cost.
- Direct synchronous Lambda calls (no queue) — Vulnerable to rate-limit collisions and creates user-facing failures.

**Rationale:** Tim already has the Lambda + Salesforce integration pattern from TAG. Adding Acumatica is incremental work, not a new platform. SQS handles the rate-limit problem elegantly. Cost: pennies per month at Harmon's volume.

**Implications:**
- Queue infrastructure is foundational; build it early
- Configurable concurrency lets us tune up after observing Acumatica's actual behavior
- Permanent failure routing to DLQ requires alerting (CloudWatch + email/SMS to Tim)
- Time-sensitive operations (customer creation on deal close) need to be flagged as high-priority in the queue

---

## D-008: Project Templates Driven from Acumatica Side

**Date:** 2026-05
**Status:** Decided

**Context:** Harmon uses pre-built Acumatica templates for both residential and commercial job setup. Many POs are cut at template-driven project creation.

**Decision:** Trigger Acumatica's template-based project creation via REST API rather than replicating template logic in Salesforce. Our integration sends template ID, customer reference, address, watts, and required custom fields. Acumatica handles the template expansion.

**Alternatives Considered:**
- Build all project setup logic in Salesforce and create line items individually — Brittle, duplicates Acumatica's accounting setup, and breaks when their templates change.

**Rationale:** Templates live where the accounting team manages them. Their changes flow through naturally without code updates on our side.

**Implications:**
- Need to capture template IDs from Harmon (residential vs commercial, possibly variants)
- Need to confirm custom PO field mapping with their team
- If template logic changes, our integration adapts automatically as long as the API payload structure remains compatible

---

## D-009: PO Credit Tracking Built on Salesforce Side

**Date:** 2026-05
**Status:** Decided

**Context:** Acumatica's PO system does not natively trace credits and returns against POs. Harmon called this out as a recurring pain point.

**Decision:** Build `PO_Credit__c` custom object in Salesforce, related to a `Purchase_Order__c` parent. Credits captured manually by PMs in the portal initially, with potential to ingest vendor credit events from Acumatica's API if available.

**Alternatives Considered:**
- Wait for Acumatica to add the feature — Indefinite timeline, not actionable.
- Build it in Acumatica via customizations — Requires Acumatica development expertise we don't have, plus VAR involvement.

**Rationale:** Salesforce-side is fully under our control. Surface in the portal as a tab on the PO record. Solves a stated pain point with low engineering cost.

**Implications:**
- Need to define the data structure with Harmon's PM team
- Reporting on PO credits becomes a Salesforce report we surface in the portal
- Phase 2 or later feature, not critical path for Phase 1

---

## D-010: Pricing Model — Per-Module Subscription with Ops-Volume Discounts

**Date:** 2026-05
**Status:** Decided

**Context:** Need a pricing model that works for Harmon and as a template for future clients.

**Decision:** Constructive Operations bills:
1. **Fixed-price buildout per phase** (one-time per phase)
2. **Per-module monthly subscription** based on which CRM modules the client uses (Residential, Commercial, Service, Sales/Core)
3. **Operations volume discount** that reduces the monthly subscription based on how many back-office service projects the client gives Constructive Operations at $800/project. Discount formula: 5% of project ops fees applied as a discount against the subscription, capped at the subscription cost.

**Alternatives Considered:**
- Pure per-user pricing — Doesn't fit because Harmon has no Salesforce users.
- Pure ops-volume pricing — Removes the subscription floor and creates revenue volatility.
- Flat all-in monthly — Doesn't reward clients for engaging Constructive Operations for ops.

**Rationale:** Creates the right incentive: clients who lean on Constructive Operations get the CRM almost free; clients who only want the CRM pay full freight. Predictable revenue floor plus upside as ops volume grows. Modular pricing accommodates future clients who only need part of the platform.

**Implications:**
- Need clear module boundaries in the platform
- Operations volume tracked monthly; discount calculated and applied automatically
- Contract structure needs to spell out how the discount works and the cap

---

## D-011: All Third-Party Infrastructure Costs Absorbed by Constructive Operations

**Date:** 2026-05
**Status:** Decided

**Context:** Salesforce, AWS, Supabase, Vercel, Twilio, FullCalendar Premium, SendGrid, etc. — who pays?

**Decision:** Constructive Operations absorbs all third-party infrastructure costs as part of the per-module subscription. Harmon sees one line-item per module per month.

**Alternatives Considered:**
- Pass-through billing — More transparent but creates procurement complexity for Harmon and exposes our cost basis.

**Rationale:** Simpler procurement for Harmon. Constructive Operations manages all vendor relationships and absorbs cost-of-goods. Margins built into the subscription pricing.

**Implications:**
- Pricing must include realistic projections of infrastructure cost growth as Harmon scales
- Constructive Operations bears the risk of unexpected infrastructure spikes (e.g., Twilio overages from a heavy SMS month)
- Need cost monitoring across all services to avoid margin erosion

---

## D-012: Document Storage Migrated from Dropbox to S3

**Date:** 2026-05
**Status:** Decided

**Context:** Harmon stores documents in Dropbox today. Migration is in scope.

**Decision:** All documents migrate to AWS S3, organized by project, customer, or category. References stored in Salesforce records as URL fields. Portal renders documents inline where possible and provides download links otherwise.

**Alternatives Considered:**
- Continue using Dropbox via API — Adds another vendor relationship and integration to maintain.
- Salesforce Files / Content — Storage limits and per-file costs at scale.

**Rationale:** S3 is already in our stack for TAG. Cheap, reliable, integrates cleanly with our Lambda layer. One less third-party platform.

**Implications:**
- Migration is a real workstream (script and verify file moves from Dropbox to S3)
- Need to preserve folder structure or remap to project-based organization
- Versioning and audit on critical documents handled via S3 versioning + Salesforce-side metadata

---

## D-013: SiteCapture Integration Deferred

**Date:** 2026-05
**Status:** Decided

**Context:** Harmon uses SiteCapture for field documentation but on the basic plan, which does not include API access (the same plan-tier gotcha pattern we surfaced for Acumatica and HCP).

**Decision:** Continue with Harmon's existing SiteCapture workflow as-is. Revisit integration only if Harmon upgrades their SiteCapture plan.

**Alternatives Considered:**
- Replace SiteCapture entirely — Out of scope; they like it and it works for them.
- Build photo capture in our PWA to replace SiteCapture — Possible long-term but not Phase 1 priority.

**Rationale:** Don't fix what isn't broken. Field techs already use SiteCapture comfortably. Integrating later, when their plan allows, is straightforward.

---

## D-014: Platform Naming — Sundial

**Date:** 2026-05
**Status:** Decided

**Context:** Need a product name for the platform that can be used in client-facing documents, the portal UI, and the codebase.

**Decision:** The platform is named **Sundial**.

**Implications:**
- All custom Salesforce objects use `Sundial_` prefix
- The portal UI brand is Sundial (Harmon branding layered on top for their deployment)
- Repository path uses `harmon-crm` for the Harmon-specific build, but the product itself is Sundial across future deployments
- SOW and external documents reference Sundial as the platform name

---

## D-015: Sundial_User__c Custom Object for Portal Users

**Date:** 2026-05
**Status:** Decided (supersedes earlier informal discussion of using standard Account)

**Context:** Portal users need to be represented in Salesforce with a hierarchy (Client, Dealer, Sales Manager, Sales Rep). Considered using standard Account vs a custom object.

**Decision:** Use a custom object `Sundial_User__c` to represent portal users.

**Alternatives Considered:**
- Standard Account — Already used in Constructive Operations org for other purposes. Semantically overloaded (Account = customer in standard SF). Risk of confusion and namespace collision.
- Custom Dealer_Account__c pattern (TAG-style) — Could work but the "Dealer" naming doesn't generalize cleanly across the four-level hierarchy.

**Rationale:** Custom `Sundial_User__c` is namespace-clean, doesn't collide with standard Account semantics, supports all four hierarchy levels uniformly, and matches the pattern that scales for future Sundial tenants beyond Harmon.

**Implications:**
- Standard Account remains available for vendor records and any other use
- Hierarchy is implemented via `Hierarchy_Level__c` picklist + `Parent_User__c` self-lookup
- Salesforce native role hierarchy is NOT used to drive portal visibility (Harmon users don't have SF licenses); visibility is enforced at the portal layer by traversing the `Parent_User__c` chain in SOQL queries

---

## D-016: Sundial_Customer__c as Customer/Address Hub with Snapshot Pattern

**Date:** 2026-05
**Status:** Decided

**Context:** Solar businesses think of "the customer" as both a person and an address. Address is the durable concept (system is bolted to a specific roof); the occupant changes over time. Need a clean way to handle Lead → Opportunity → Customer lifecycle, plus changes of ownership and contact updates over time.

**Decision:** Single custom object `Sundial_Customer__c` serves as the customer/address hub. It represents the current occupant and contact information at a given address. Used as Lead, Opportunity, and ongoing Customer record throughout the lifecycle. Status picklist tracks where in the lifecycle a record is.

To preserve historical accuracy, each project record (Sundial_Solar__c, Sundial_Roofing__c, Sundial_Commercial__c, Sundial_Service__c) snapshots customer name, address, primary phone, and primary email at the time the project is created. The lookup to Sundial_Customer__c remains for current-state queries; the snapshot fields preserve "who was here when this work was done."

**Alternatives Considered:**
- Separate Site/Property object with a child Occupant History object — More technically pure but introduces additional objects and makes portal queries more complex. The snapshot pattern achieves the same goal with simpler architecture.
- Standard Lead → Account/Contact → Opportunity pattern — Familiar to SF veterans but requires three or four objects to model the same data, increases lead conversion friction, and doesn't fit the solar industry mental model.

**Rationale:** "Customer" is how solar companies talk about this concept and how the Harmon team will read the portal. The snapshot pattern gives us historical accuracy without an extra object. Single-object lifecycle eliminates the Lead conversion step.

**Implications:**
- Status field on Sundial_Customer__c drives whether a record appears in Lead pipeline, Opportunity pipeline, or Customer views
- Snapshot Flow fires on project creation to populate the at-the-time fields
- Cross-project queries via the Customer hub work cleanly: "show me all projects at this address" joins through Sundial_Customer__c

---

## D-017: Four Separate Project Objects (Not Record Types)

**Date:** 2026-05
**Status:** Decided (closes the D-014 open question from previous version)

**Context:** Project work falls into four categories at Harmon: residential solar, roofing, commercial solar, and service. Need to decide whether to use a single Project object with Record Types or four separate custom objects.

**Decision:** Four separate custom objects: `Sundial_Solar__c`, `Sundial_Roofing__c`, `Sundial_Commercial__c`, `Sundial_Service__c`.

**Alternatives Considered:**
- Single `Sundial_Project__c` with Record Types per category — Would enable cleaner cross-project reporting and shared automations, BUT Salesforce has a 500-field-per-object limit. Each of the four project types has hundreds of fields. Four record types on one object would exceed the field cap.

**Rationale:** The 500-field limit is the dispositive technical constraint. Combined with the genuine differences in workflows, communications, and automations between the four categories, separation is the right architectural call. Cross-project queries are slightly harder (UNION across objects, or query via the Sundial_Customer__c hub) but manageable.

**Implications:**
- Cross-project reporting requires either parent-child reporting through Sundial_Customer__c, or UNION queries
- Automations and communication flows are maintained per object (with shared helper patterns to reduce duplication)
- Each project object has its own page layouts, validation rules, and field set
- Combined work (e.g., residential solar with a reroof) creates two related records: a Sundial_Solar__c and a Sundial_Roofing__c, linked via lookup fields

---

## D-018: Sundial_Service_Visit__c as Child of Sundial_Service__c

**Date:** 2026-05
**Status:** Decided (refines D-003 with final naming)

**Context:** Service tickets often involve multiple visits (initial diagnosis, parts ordered, return visit to complete). Time tracking across paused-and-resumed work was Harmon's biggest HCP pain point.

**Decision:** `Sundial_Service__c` is the parent ticket. `Sundial_Service_Visit__c` is a child object with master-detail (or required lookup) to the parent. Each visit has its own time fields, tech assignment, clock in/out coordinates, geofence verification, notes, and photos. Roll-up summary fields on the parent ticket aggregate total time, total visits, total materials cost.

**Rationale:** Solves the HCP pain point directly. Each visit is a discrete time-tracked entity. Multi-tech jobs handled via multiple visit records under one ticket. Photos and materials live at the visit level where they're captured, with roll-up visibility at the ticket level.

**Implications:**
- Mobile PWA creates a Sundial_Service_Visit__c record on tech clock-in and updates it on clock-out
- GPS coordinates captured at clock-in and clock-out enable geofence verification
- Office review at ticket completion can see all visits as a timeline
- Reporting on tech utilization aggregates Visit records

---

## D-019: Sundial_Solar__c → Solar_Project__c Mirror via Flow

**Date:** 2026-05
**Status:** Decided

**Context:** Constructive Operations' existing `Solar_Project__c` object is used by the CO internal team for back-office services. When Harmon hands a residential solar project to CO for ops services, the CO team needs the data in their familiar Solar_Project__c object.

**Decision:** Salesforce Flow mirrors data from Sundial_Solar__c to Solar_Project__c when a flag or stage transition indicates handoff to CO. Mirror is primarily one-way (Sundial → Solar_Project__c) with specific operational fields flowing back (install date confirmations, document approvals).

**Alternatives Considered:**
- Bidirectional sync — More complex, requires field-level source-of-truth rules and conflict resolution. Probably overkill.
- Use Sundial_Solar__c as the only object and retire Solar_Project__c — Would require migrating CO's existing tooling and workflows. Out of scope for this engagement.

**Rationale:** Decouples Sundial functionality from CO ops handoff (Sundial works whether or not the project goes to CO). Preserves CO's existing tooling. Flow is configurable and maintainable.

**Implications:**
- Field-by-field source-of-truth map needs to be defined and documented (will live in docs/integrations/co-ops-sync.md)
- Mirror failures must not block Sundial functionality
- Audit log captures every sync event

---

## D-020: Standard Asset for Installed Systems

**Date:** 2026-05
**Status:** Decided

**Context:** Need a Salesforce object to represent installed solar systems (and other equipment) at customer sites. Service tickets need to relate to specific installed systems; warranty queries need to query against them.

**Decision:** Use standard Salesforce `Asset` with custom fields added. Each installed system gets one Asset record. Asset is linked to `Sundial_Customer__c` via a custom lookup field, and to the originating `Sundial_Solar__c` or `Sundial_Commercial__c` via custom lookup fields.

**Rationale:** Standard Asset is purpose-built for this exact use case (equipment installed at customer locations with serial numbers, warranties, and service history). Don't reinvent.

---

## D-021: Standard Pricebook2/Product2/PricebookEntry for Service Catalog

**Date:** 2026-05
**Status:** Decided

**Context:** The HCP price book is a feature Harmon's service team specifically values. Office staff add products and pricing; service tickets reference them.

**Decision:** Use standard `Pricebook2`, `Product2`, and `PricebookEntry` for the service price book.

**Rationale:** Standard objects do exactly what's needed. Salesforce-native reporting works out of the box. Updates by office staff use familiar Salesforce UI patterns (we'll surface this in the portal).

---

## D-022: Sundial Platform Branding

**Date:** 2026-05
**Status:** Decided

**Context:** The platform needs a name for client-facing documents and the portal UI itself.

**Decision:** Platform name is **Sundial**. Used in SOW, terms documents, and the portal UI. Referenced sparingly in formal documents (not as a marketing campaign, just as the product name where it belongs). Custom Salesforce objects use `Sundial_` prefix.

---

## D-023: Three-Phase Delivery Model

**Date:** 2026-05
**Status:** Decided (revised from earlier two-phase and three-phase variants during SOW iteration)

**Context:** Need a phasing model that lets Harmon adopt the platform at a sustainable pace, evaluate outcomes between phases, and prioritize the modules that matter most to their operation first.

**Decision:** Three phases:
- **Phase 1:** Core Platform foundation, Acumatica integration, Residential Solar module, Roofing module ($45,000, 10-14 weeks)
- **Phase 2:** Service Operations module replacing HCP ($30,000, 8-12 weeks)
- **Phase 3:** Commercial Solar module + feature improvements + advanced capabilities ($20,000, 6-10 weeks)

Total: $95,000 across three phases.

**Rationale:** Residential and roofing are Harmon's biggest volume. Service is the biggest pain (no Acumatica integration). Commercial is lower volume and can wait for the platform to mature. Sunbase stays alive through Phases 1 and 2 for modules not yet migrated; fully decommissioned at Phase 3 go-live. HCP decommissioned at Phase 2 go-live.

---

## D-024: Dropbox Retained as Document Mirror

**Date:** 2026-05
**Status:** Decided

**Context:** Originally planned to replace Dropbox entirely with AWS S3. Harmon expressed preference for retaining Dropbox so they have direct access to their document set outside the Sundial platform.

**Decision:** AWS S3 is the primary document storage and manipulation layer for Sundial. Documents are automatically copy-synced to Harmon's existing Dropbox in the background so Harmon retains a familiar, accessible mirror of every document.

**Rationale:** Addresses the data ownership comfort directly. Costs little (Dropbox already paid for; sync logic is straightforward). Mitigates lock-in concern.

**Implications:**
- Lambda function handles the AWS-to-Dropbox sync
- Sync is one-way (AWS → Dropbox); Sundial does not pull changes from Dropbox back into AWS
- Migration moves existing Dropbox documents into S3 as the source of truth, then continues to sync new uploads back

---

## D-025: Multi-Client Deployment Architecture (Shared Backend, Forked Frontend)

**Date:** 2026-06
**Status:** Decided (the `Client__c` tenant-isolation anchor is refined by D-034, which gives the tenant a dedicated `Sundial_Tenant__c` object as its target; the shared-backend/forked-frontend pattern itself is unchanged)

**Context:** Sundial is being built first for Harmon but is intended as a platform that can serve multiple clients over time. Need a deployment architecture that supports scaling to additional clients without rebuilding the platform per client.

**Decision:** Shared backend, forked frontend pattern.

- **Shared across all Sundial deployments:** Salesforce org, Sundial_* custom objects, Sundial Integration User, Connected App, Lambda code (in a shared NPM package), all third-party integrations, AWS infrastructure
- **Forked per client:** React/Vite repo, Vercel deployment, Supabase project, branding, custom field configurations, module enablement, custom layouts

The Harmon repo evolves into a canonical `sundial-template` repo. New clients fork from the template. Customization defaults to a `client-config.ts` file; code-level forking only when configuration cannot express the customization.

**Alternatives Considered:**
- True multi-tenant single frontend — More architecturally pure but requires upfront investment in tenant context propagation throughout the React tree, branding theming engine, and feature-flag-driven UI rendering. Overkill for the target client count.
- Per-client everything (separate SF orgs, separate Lambda functions, fully independent) — Maximum isolation but unmaintainable economics for a solo dev.

**Rationale:** Right-sized for the target scale (under 10 clients in the first two years per Tim's direction). Salesforce-side sharing via `Client__c` lookup keeps tenant data isolated. Forked frontend gives each client room for genuine customization without polluting the shared layer. Past 10 clients, revisit toward true multi-tenant.

**Implications:**
- Every Lambda query must enforce `Client__c` filtering based on authenticated user's tenant context. Hard rule.
- Lambda code lives in a shared NPM package (`@constructiveops/sundial-core`) consumed by each client's Lambda deployment.
- Frontend customization defaults to config; code-fork is the escape hatch with explicit `CLIENT_DIVERGENCE.md` documentation.
- New client onboarding follows a documented checklist (1-2 days target).

Full pattern documented in `docs/multi-client-deployment.md`.

---

## D-026: Commercial Gantt Milestones via Direct Fields, Not Child Object

**Date:** 2026-06
**Status:** Decided

**Context:** Commercial solar projects need a Gantt-style visualization of milestones (Site Assessment, Design, Permitting, Procurement, Construction, Commissioning, PTO, Closeout) with start/end dates and percent complete. Considered using a child Milestone object versus direct fields on `Sundial_Commercial__c`.

**Decision:** Direct fields on `Sundial_Commercial__c`. Each milestone gets four fields: `{Milestone}_Start__c`, `{Milestone}_End__c`, `{Milestone}_Status__c`, `{Milestone}_Percent_Complete__c`. Eight milestones × four fields = 32 fields, well within the 500-field budget for the object.

**Alternatives Considered:**
- Child `Sundial_Project_Milestone__c` object — More flexible (variable milestone count, custom milestones per project) but adds another object to maintain and queries become parent-child. Overkill for Commercial's relatively fixed lifecycle.

**Rationale:** Commercial projects follow predictable milestone phases. Field-based approach keeps the data model flat, reportable, and easy to query for Gantt rendering. Per Tim's direction to minimize object count.

**Implications:**
- Gantt visualization queries flat fields on a single object, no joins
- This pattern is Commercial-only; Residential Solar and Roofing use the standard `Stage__c` picklist
- If a future client needs variable milestones per project, we revisit toward a child object pattern

---

## D-027: Sundial_Service_Visit__c Serves Multiple Work Types via Visit_Type__c Picklist

**Date:** 2026-06
**Status:** Decided (refines D-018)

**Context:** The mobile PWA needs to support not just service techs but also field solar installers, roofing crews, and (future) commercial install crews. All need GPS, clock in/out with geofencing, notes, and photo capture. Considered universal `Sundial_Work_Session__c` object versus parallel `Sundial_Install_Visit__c`, versus extending the existing `Sundial_Service_Visit__c`.

**Decision:** Extend `Sundial_Service_Visit__c` with a `Visit_Type__c` picklist (Service, Solar Install, Roofing Install, Commercial Install) and add lookup fields for each project object. The relationship to the parent becomes a lookup (rather than master-detail), with a validation rule enforcing that exactly one of the four parent lookups is populated and matches the Visit_Type.

The PWA displays different fields based on context: service techs see service-related fields under a Service tab; solar installers see solar project fields under a Solar tab. Same underlying object, same GPS/clock functions, different UI display.

**Alternatives Considered:**
- Universal `Sundial_Work_Session__c` (recommended initially) — Cleanest data model but Tim prefers to keep object count low.
- Separate `Sundial_Install_Visit__c` (parallel objects) — Maintains master-detail relationships but doubles maintenance for fundamentally similar code paths.

**Rationale:** Per Tim's direction, this approach keeps the SF object count flat while still supporting multiple work types. The PWA's UI variation handles display differences; the underlying object captures the universal data points.

**Implications:**
- We lose master-detail roll-up summaries to the parent ticket/project. Roll-ups are rebuilt via Apex trigger or Flow on visit close.
- Validation rules enforce data integrity (exactly one parent lookup populated, matching Visit_Type)
- The PWA has conditional rendering based on Visit_Type
- Same object queried by service reports and install reports with appropriate filters

---

## D-028: Salesforce Data Caching in Supabase

**Date:** 2026-06
**Status:** Decided

**Context:** Salesforce API limits are shared across all uses of the org, including multiple Sundial clients, Zapier automations, admin work, and other integrations. Direct queries to Salesforce on every portal page load would exhaust the API budget under realistic load.

**Decision:** Cache key Salesforce data in the per-client Supabase project. Reads hit cache first; writes go to Salesforce then update cache. Cache invalidation via Supabase Realtime broadcasts and Salesforce Platform Events.

Estimated API call reduction: 80-95 percent versus a no-cache design.

**Alternatives Considered:**
- In-memory caching at the Lambda layer — Doesn't persist across cold starts, fragments across Lambda instances
- Redis/ElastiCache — Adds infrastructure cost and complexity; Supabase Postgres performs adequately

**Rationale:** Supabase is already in the stack for auth, chat, and file metadata. Reusing it as the cache layer adds no new infrastructure. Postgres performance is more than adequate for the read volume.

**Implications:**
- Every Sundial_* object has a corresponding cache table in Supabase
- Lambda read path: cache check → SF fallback on miss
- Lambda write path: SF write → cache update → Realtime broadcast
- Salesforce Platform Events propagate out-of-band changes to the cache
- Critical operations (payments, scheduling commits, Acumatica writes) bypass cache and read fresh

Full pattern documented in `docs/caching-architecture.md`.

---

## D-029: File Storage Architecture (S3 Folder Per Salesforce Record ID)

**Date:** 2026-06
**Status:** Decided (significant departure from the TAG portal's URL-field-per-document pattern)

**Context:** Need a file storage pattern that scales beyond a fixed set of document types, supports tagging/categorization, integrates with Salesforce-native file access, and syncs to Harmon's Dropbox.

**Decision:** Files live in S3 at the path `{tenant_id}/{object_type}/{sf_record_id}/{filename}`. File metadata (filename, uploader, upload date, category, etc.) lives in Supabase, not Salesforce, to avoid API consumption on file listings.

Each Sundial record has a Files tab in the portal showing all files in its folder, with upload, download, search, and related-files navigation. Lambda functions handle list/upload/download/delete with tenant-isolated presigned URLs.

**Alternatives Considered:**
- URL field per document type on Salesforce (TAG portal pattern) — Limits to predefined document types, hits field count limits, doesn't scale across modules
- File metadata in Salesforce — Higher API consumption on every file list
- Salesforce native Files / Content — Storage limits, per-file costs, doesn't align with Dropbox or XFiles Pro

**Rationale:** The folder-per-record pattern is unbounded, supports any file category without schema changes, and aligns cleanly with how XFiles Pro and Dropbox expect to organize files. Salesforce record ID as folder name is the keystone choice.

**Implications:**
- S3 versioning enabled for safety
- Presigned URLs with 15-minute expiration enforce tenant isolation
- Soft delete with configurable retention; hard delete via scheduled cleanup
- Files Tab on every Sundial record (Phase 1 deliverable across all four modules' records)

Full architecture documented in `docs/file-storage.md`.

---

## D-030: XFiles Pro Integration for Salesforce-Native File Access

**Date:** 2026-06
**Status:** Decided

**Context:** Tim uses XFiles Pro (Salesforce AppExchange app) to view S3 files inside Salesforce as if they were native attachments. Want Sundial files to be visible in Salesforce without additional sync logic.

**Decision:** Configure XFiles Pro to read from the same S3 bucket and folder structure that Sundial writes to. Because both use Salesforce record ID as the folder name, XFiles Pro automatically finds the right files for each Sundial_* record without any sync between Sundial and Salesforce.

**Rationale:** Single source of truth (S3), multiple read surfaces (Sundial portal, Salesforce via XFiles Pro, Dropbox mirror). No data duplication, no sync overhead, no risk of drift.

**Implications:**
- Files uploaded via the portal are immediately accessible in Salesforce via XFiles Pro
- Tim has full file visibility in Salesforce without logging into the portal
- IAM configuration: XFiles Pro gets a read role for the bucket; write role optional if Tim wants Salesforce-side uploads
- The folder naming convention (SF record ID) becomes architecturally load-bearing across three systems

---

## D-031: Cross-Module Project Ties (Service Carries Originating Project Lookups)

**Date:** 2026-06
**Status:** Decided

**Context:** Solar, Roofing, and Commercial projects flow into Service after PTO for warranty and future service work. Service techs need context from the original install.

**Decision:** `Sundial_Service__c` carries lookup fields back to the originating project:
- `Originating_Solar_Project__c` → Sundial_Solar__c
- `Originating_Commercial_Project__c` → Sundial_Commercial__c
- `Originating_Roofing_Project__c` → Sundial_Roofing__c

These lookups are populated automatically when a service ticket is created for a system installed by Harmon (via the `Installed_System__c` Asset link, which itself references the originating project), or manually when context is added later.

**Implications:**
- Service Ticket Detail UI surfaces "Original install completed on [date] by [crew]" context
- File system's "Related Files" feature pulls install photos and contracts from the originating project to the service ticket view
- Service tech PWA can show install history and system specs without leaving the ticket

---

## D-032: Aurora and Roofr Integrations via Zapier (Out of Sundial Build Scope)

**Date:** 2026-06
**Status:** ~~Decided~~ — **SUPERSEDED by D-047 (2026-08-03) for the Aurora half.** Aurora is now a first-class, in-build Sundial integration (`sundial-aurora-push`, `sundial-aurora-webhook`, `docs/integrations/aurora-api-reference.md`), not a Zapier flow. The Roofr half of this decision still stands.

**Context:** The signed SOW mentions Aurora integration for project creation and Roofr for roofing budget generation. Need to clarify whether these are built into Sundial or handled externally.

**Decision:** Both Aurora and Roofr integrations are handled by Zapier webhooks that create Salesforce records directly. The Sundial build does not include Aurora or Roofr integration code. Tim manages these Zaps independently.

**Rationale:** Zapier already handles this well for similar use cases at Constructive Operations. No reason to duplicate the work in Sundial Lambda.

**Implications:**
- Salesforce records created by Zapier carry the appropriate `Client__c` value (Harmon) so they appear in the Sundial portal
- Sundial caching layer picks up Zapier-created records via Platform Events the same way it picks up any other out-of-band change
- No Aurora or Roofr documentation needed in the Sundial workspace

---

## D-033: Shared S3 Bucket with XFiles Pro (sfsolproj) and SUNDIAL Prefix

**Date:** 2026-06
**Status:** Decided (refines D-029)

**Context:** D-029 specified a dedicated `sundial-files` S3 bucket with paths formatted as `{tenant_id}/{object_type}/{sf_record_id}/{filename}`. Tim's existing XFiles Pro installation in Salesforce is bound to a single bucket (`sfsolproj`) and cannot point to a separate bucket. To achieve the goal of unified file access across Sundial and Salesforce, both systems must use the same bucket.

**Decision:** Sundial uses the existing `sfsolproj` S3 bucket. All Sundial files live under the top-level prefix `SUNDIAL/`, keeping them clearly separated from XFiles Pro's other files. Path format becomes `SUNDIAL/{sf_record_id}/{filename}`. Full URLs look like `https://sfsolproj.s3.us-west-1.amazonaws.com/SUNDIAL/a01XX000003ABCD/proposal.pdf`.

**Alternatives Considered:**
- Separate Sundial bucket with sync logic between Sundial and XFiles Pro — Defeats the architectural keystone of "one source of truth, three views" and adds sync complexity.
- Reconfigure XFiles Pro to point at a Sundial bucket — XFiles Pro instances are bound to a single bucket and reconfiguring would disrupt the existing Salesforce file workflow.

**Rationale:** A shared bucket with a clear path prefix achieves the unified-access goal with minimum complexity. IAM policy on the Lambda execution role scopes Sundial's permissions to the `SUNDIAL/` prefix only, preventing accidental interference with XFiles Pro's other files.

**Implications:**
- The `{tenant_id}` path segment is dropped. Tenant isolation moves entirely into Lambda code (every Lambda must enforce tenant filtering by checking the SF record's `Client__c` value before granting file access). Acceptable for the under-10-clients scale targeted.
- The `{object_type}` path segment is dropped. Tim's existing XFiles Pro install (Solar_Project__c at `OPS/{record_id}/`) confirms that SF record ID alone is sufficient; Sundial mirrors this pattern as `SUNDIAL/{record_id}/`. XFiles Pro requires manual per-object setup in Salesforce; see CLAUDE.md XFiles Pro Configuration Tasks for the per-object checklist.
- Lambda execution role IAM policy scopes S3 actions to `arn:aws:s3:::sfsolproj/SUNDIAL/*` to prevent Lambda from accessing non-Sundial files in the bucket.
- The `sundial-dropbox-sync` Lambda's S3 trigger is filtered to the `SUNDIAL/` prefix so it does not fire on XFiles Pro's other uploads.
- Lifecycle rules (Glacier transition after 365 days) are scoped to the `SUNDIAL/` prefix to leave XFiles Pro's lifecycle behavior unchanged.

**Future Multi-Client Considerations:**
- If a second Sundial client is onboarded, paths could become `SUNDIAL/{client_id}/{sf_record_id}/` to add some path-level separation, but XFiles Pro for that second client would need its own bucket (since XFiles Pro is single-bucket per instance). Cross-bucket federation in Sundial Lambda code would handle the multi-client read/write.
- Alternative: each future client gets its own bucket and XFiles Pro instance; Sundial Lambda code routes by tenant context.

---

## D-034: Dedicated Sundial_Tenant__c Object as Tenant Anchor

**Date:** 2026-06
**Status:** Decided (refines D-025)

**Context:** The multi-client model isolates tenant data via a `Client__c` lookup on every Sundial object (D-025). That lookup originally targeted the top-level `Sundial_User__c` record (the one with `Hierarchy_Level__c` = "Client") — effectively treating the tenant as a user record. As the model matured, conflating "the tenant" with "a user" became awkward: a tenant is an organization, not a person, and tenant-level metadata had no clean home that wasn't a user record. We needed a stable, dedicated identity for each tenant that maps cleanly to the application-layer tenant identifier (`VITE_TENANT_ID`, the S3 tenant prefix, and `client-config.ts`).

**Decision:** Create a dedicated Salesforce object, `Sundial_Tenant__c`, as the tenant anchor for the multi-client model. Its standard `Name` field holds the tenant slug; the first record is named `harmon`, matching `VITE_TENANT_ID`, the S3 tenant prefix, and `client-config.ts`. The `Client__c` lookup (API name unchanged: `Client__c`) now targets `Sundial_Tenant__c` instead of a `Sundial_User__c` record. `Client__c` still lives on every Sundial object as the per-tenant isolation anchor.

The object is intentionally minimal — no fields beyond `Name` for now. Additional tenant metadata can be added later if a need arises.

The "Client" `Hierarchy_Level__c` value on `Sundial_User__c` still exists as a user permission tier; that is now a separate concept from tenant ownership. The prior "tenant is effectively the top-level Client user" approach is superseded by this ADR for the purpose of tenant anchoring.

**Alternatives Considered:**
- **Top-level Client user as the tenant (prior approach)** — Overloads a user record with organization-level identity. A tenant is not a person; tenant metadata does not belong on a user record. Superseded by this decision.
- **Overload the standard `Account` object as the tenant** — Standard `Account` is already used in the shared Constructive Operations org for customers and vendors. Reusing it for tenant identity risks semantic collision and accidental cross-contamination in an org shared with Constructive's own operations. Rejected.
- **Plain text slug only (no object, just a string field)** — A bare `Client__c` text field would carry the slug but give nothing to look up to, no referential integrity, and no place to hang future tenant metadata. Rejected in favor of a real lookup target.

**Rationale:** A tenant is an organization, not a person — it deserves its own object. A dedicated `Sundial_Tenant__c` keeps tenant identity and metadata off user records, avoids overloading the standard `Account` object in an org shared with Constructive Operations, and gives a clean slug-to-tenant mapping that lines up with the application-layer tenant identifier across the frontend (`VITE_TENANT_ID`, `client-config.ts`) and S3 (tenant prefix).

**Zero-Code-Change Confirmation:** `GET /auth/me` returns `Client__c` as `tenant.clientId`. Because the handler treats that value as an opaque ID and does not depend on what object it points to, repointing `Client__c` from `Sundial_User__c` to `Sundial_Tenant__c` required zero code changes to the auth handler.

**Implications:**
- Each Sundial client gets exactly one `Sundial_Tenant__c` record, named with the tenant slug.
- `Client__c` continues to be the hard per-tenant isolation anchor on every Sundial object; every Lambda query still enforces `Client__c` filtering (per D-025).
- The "Client" hierarchy level on `Sundial_User__c` is retained strictly as a user permission tier, decoupled from tenant ownership.
- Schema reference updated in `docs/salesforce-schema.md`.

---

## D-035: Tenant Isolation Key Is the Salesforce Client Record ID (Client__c), Not the Slug

**Date:** 2026-06
**Status:** Decided (refines D-025 and D-034; cross-references D-034's `Sundial_Tenant__c` anchor)

**Context:** Tenant isolation is the hard architectural rule for the multi-client model (D-025): every Lambda query must filter by tenant. As the first read Lambda (`sundial-sf-query`) was built and proven end to end against the live org, the exact isolation key had to be pinned down precisely. Two candidate values exist for "the tenant": the human-readable slug (`harmon`) and the Salesforce `Sundial_Tenant__c` record ID that `Client__c` points to. Using the wrong one — or letting a request influence it — would be a tenant-isolation defect, not a cosmetic bug.

**Decision:** The canonical tenant isolation key is the **Salesforce Client record ID** (the `Sundial_Tenant__c` record ID held in `Client__c`). All isolation filters use it:
- On the Supabase cache, filter on the `client_sf_id` column.
- On Salesforce, filter with `Client__c = '<tenantId>'`.

The tenant **slug** (e.g. `harmon`, sourced from `Client__r.Name` and stored in the cache `tenant_id` column) is a **human label only** and is NEVER used for isolation.

`resolveIdentity` (in `lib/identity.js`) returns both values: `tenantId` (the Salesforce Client record ID — the isolation key) and `tenantSlug` (the label). The tenant value is derived **only** from the verified Supabase token. No request input — path, query string, body, or header — can set or override it.

**Object allowlist (the security spine).** `sundial-sf-query` resolves a short, public object name to a Salesforce object and its cache table through a fixed allowlist. Anything not on the list is rejected with `400 OBJECT_NOT_ALLOWED`. Phase 1 allowlist:

| Public name | Salesforce object | Cache table |
|---|---|---|
| `solar` | `Sundial_Solar__c` | `sundial_solar_cache` |
| `customer` | `Sundial_Customer__c` | `sundial_customer_cache` |
| `roofing` | `Sundial_Roofing__c` | `sundial_roofing_cache` |
| `po` | `Sundial_PO__c` | `sundial_po_cache` |
| `user` | `Sundial_User__c` | `sundial_user_cache` |

**Proving implementation — `sundial-sf-query`.** A cache-first, tenant-isolated **read** Lambda serving two shapes: `GET /sf/{object}` (list) and `GET /sf/{object}/{id}` (single record). It reuses `lib/identity.js` (`resolveIdentity`), `lib/salesforce.js`, and `lib/supabase.js`. Verified end to end against the live org:
- Cache miss falls through to Salesforce and writes the result back to the cache.
- An immediate repeat of the same read serves `source: "cache"`.
- Both `solar` and `customer` objects work.
- An off-allowlist object is rejected with `400 OBJECT_NOT_ALLOWED`.
- A cross-tenant / cross-object ID returns `404 RECORD_NOT_FOUND` (isolation holds — a record outside the caller's tenant is indistinguishable from one that does not exist).

**Alternatives Considered:**
- **Use the slug as the isolation key** — Human-readable but unstable and weak: slugs can be renamed, are not referentially guaranteed, and reading the slug from `Client__r.Name` couples isolation to a mutable label. The record ID is immutable and referentially exact. Rejected.
- **Accept a tenant value from the request** (e.g. a header or query param) — Any request-supplied tenant is an isolation bypass waiting to happen. The tenant must come only from the verified token. Rejected outright.

**Rationale:** The Salesforce record ID is immutable, referentially exact against `Client__c = '<id>'`, and unambiguous across the cache (`client_sf_id`) and Salesforce. Deriving it solely from the verified token closes the request-tampering hole. The allowlist gives a small, auditable surface and turns "unknown object" into a clean 400 rather than an attempted query against an arbitrary object.

**Implications:**
- Isolation filters everywhere key on `client_sf_id` (cache) / `Client__c` (Salesforce); the slug is presentation only.
- New objects become reachable only by adding them to the allowlist with their cache-table mapping.
- The 404-on-cross-tenant behavior is the intended contract: out-of-tenant records are not distinguishable from nonexistent ones.

---

## D-036: Verb-Split Routing for /sf/{object}/{id} (GET → query, PATCH/DELETE → update)

**Date:** 2026-06
**Status:** Decided (clarifies the routing recorded in `docs/api-endpoints.md`)

**Context:** The single-record resource `/sf/{object}/{id}` carries both a read (`GET`) and writes (`PATCH`, `DELETE`). Reads are now served by the proven `sundial-sf-query` Lambda (D-035); writes belong to a separate `sundial-sf-update` Lambda. An earlier draft of `docs/api-endpoints.md` mapped the single-record `GET` to `sundial-sf-update`, which is incorrect now that the read Lambda exists.

**Decision:** Route the `/sf/{object}/{id}` resource by HTTP verb across two Lambdas:
- `GET /sf/{object}/{id}` → **`sundial-sf-query`** (cache-first read; built and proven).
- `PATCH /sf/{object}/{id}` and `DELETE /sf/{object}/{id}` → **`sundial-sf-update`** (writes; not yet built).

`GET /sf/{object}` (list) also routes to `sundial-sf-query`.

**Rationale:** Reads and writes have different cache semantics, different risk profiles, and a different build status. Splitting by verb keeps the read path (cache-first, already verified) cleanly separated from the write path (Salesforce-first, cache update, Realtime broadcast — still to be built) without introducing a sibling-path-variable conflict in API Gateway.

**Implications:**
- `docs/api-endpoints.md` is corrected to show `GET → sundial-sf-query`, `PATCH`/`DELETE` → `sundial-sf-update`.
- Until `sundial-sf-update` is built, `PATCH`/`DELETE` on this resource are not yet functional; `GET` (list and single) is live.

---

## D-037: Sundial Co-Branding Standard for Client Portals

**Date:** 2026-07
**Status:** Decided as a platform standard; **implementation deferred** (post-Friday-demo). Not yet built. Relates to D-025 (shared backend, forked frontend) and D-014/D-022 (Sundial platform naming/branding).

**Context:** Sundial is a white-label-leaning platform: each client portal (harmon-crm is the first) is forked per client and dressed in that client's branding — logo, colors, company name (e.g. Harmon's red `#b92e33` / yellow `#ffc637` and logos). As the platform grows to multiple client forks, we want the Sundial product identity to be consistently present to the daily users of every portal, without competing with the dominant client brand. We need a single, standard co-branding pattern rather than ad-hoc per-client treatments.

**Decision:** Every Sundial-powered client portal uses **client branding as dominant** (client logo, colors, and name lead the experience) **and carries a subtle, consistent Sundial platform signature as co-branding**. The client brand is primary; the platform provider is present but understated.

Two specific, standard placements:

1. **Login page** — a small Sundial mark centered at the bottom of the page, beneath the existing "Harmon Electric · Powered by Sundial" footer text.
2. **Application shell** — a persistent footer on every authenticated page showing the Sundial logo/mark, as a subtle "Powered by Sundial" treatment, so it appears on every shell page automatically.

Both placements must stay visually subtle (muted, small) so they never compete with client branding.

**Alternatives Considered:**
- **Client branding only, no platform signature** — Cleanest for the client but erases Sundial's product identity with the people who use it every day. Rejected; we want understated platform presence.
- **Prominent Sundial branding (header/sidebar co-lockup)** — Too assertive; competes with the client brand and undercuts the white-label feel. Rejected.
- **Per-client, ad-hoc placement** — Inconsistent across forks and easy to drop. Rejected in favor of one standard applied everywhere.

**Rationale:** A co-branding pattern — client brand dominant, platform provider present but understated — reinforces the Sundial product identity to daily users, stays consistent across all current and future client forks, and respects that the portal is first and foremost the client's tool.

**Implementation Notes (for later):**
- This is **frontend work in each client repo** (starting with harmon-crm). It touches the login page and the app shell only.
- **Asset dependency (blocking):** requires a **Sundial mark asset** (transparent-background SVG or small PNG) added to `src/assets/branding/`. This asset is **not yet present in the repo** and must be supplied before implementation. (Client brand assets already live in `src/assets/branding/`; the Sundial mark is the missing piece.)
- The shell footer should be a **shared layout component** so it renders on every authenticated page automatically (single source of truth, not repeated per page).
- Keep it muted and small (e.g. low-emphasis text + small mark) so it never competes with client branding.
- As a forked-frontend standard, this belongs in the `sundial-template` so every new client fork inherits it by default (see D-025 and `docs/multi-client-deployment.md`).

**Implications:**
- New client onboarding inherits the Sundial signature automatically from the template; no per-client branding decision required for the platform mark.
- Until the Sundial mark asset is supplied and the components are built, this remains a documented standard only — the current LoginPage and AppLayout do not yet render the Sundial mark/footer.

---

## D-038: Budget Calculation Runs in a Lambda, Not Salesforce Flow/Formula Fields

**Date:** 2026-07-21
**Status:** Decided

**Context:** The Sundial_Solar__c budget (ported cell-for-cell from Harmon's Sunbase Budget Sheet, verified against the HOLLAND project) requires ~33 interdependent steps AND a filled, datestamped .xlsx snapshot per calculation. Salesforce cannot author an .xlsx natively, and the GP chain would blow the 5,000-byte formula-field compile limit.

**Decision:** All budget math lives in one place — `lambdas/sundial-budget/budgetCalc.js` (a pure function, record fields in → output fields + workbook cell map out). Salesforce stores inputs/outputs and *requests* recalculation (button or platform event); the Lambda computes, writes outputs back, and drops the snapshot to S3.

**Alternatives considered:** (a) Before-save Flow for the math + Lambda only for the workbook — rejected: two implementations of the same 33-step calc that silently drift (two-sources-of-truth bug). (b) Formula fields — rejected: byte-limit, no history tracking, and a budget that silently re-derives after being pushed to Acumatica is the wrong shape for a financial record.

**Rationale:** One module, three consumers (system-of-record calc, React live-preview import, test suite pinned to HOLLAND — 32 assertions). Trade-off: outputs are eventually consistent; `Budget_Calc_Status__c` (Pending → Calculated/Error) surfaces the window, and anything consuming budget outputs (Acumatica push, reports) requires status = Calculated. Full rationale in `docs/budget-calculator-design.md` §3.

---

## D-039: Budget Workbook Template Embedded as Base64 at Deploy Time

**Date:** 2026-07-21
**Status:** Decided

**Context:** The snapshot writer fills a binary template (`template/budget-template.xlsx`). The org-standard deploy (`deploy.ps1` + esbuild) produces ONE self-contained `index.mjs`; a binary asset addressed by `__dirname` is not present in that single-file bundle.

**Decision:** Keep `template/budget-template.xlsx` as the source of record. A deploy-time `prebuild.mjs` hook (wired into `deploy.ps1`) base64-encodes it into a transient `template.generated.js` that esbuild inlines; a `postbuild.mjs` hook removes it. `npm test` reads the source `.xlsx` directly (artifact absent during tests), so the tested and shipped template are the same bytes by construction. No hand-maintained base64, no runtime S3 GET on the synchronous recalc path.

**Alternatives:** (a) Load template from S3 at runtime — rejected: out-of-band state that could change snapshots without code review, plus a GET on the sync path. (b) Hand-maintained base64 constant — rejected: drift + un-reviewable. (c) Folder-zip deploy with node_modules — rejected: a second deploy mechanism.

**Rationale:** Co-versions template with code (atomic deploy/rollback), keeps the HOLLAND-verified bytes in prod. `deploy.ps1` gained generic `prebuild.mjs`/`postbuild.mjs` hooks (guarded — other functions unaffected).

---

## D-040: Single Shared Salesforce Write Path — `lib/salesforce.js » sfUpdateRecord`

**Date:** 2026-07-21
**Status:** Decided

**Context:** `sundial-sf-update` is an HTTP handler, not a reusable function. As more Lambdas needed to write back to Salesforce (Aurora push, Acumatica push, budget), each was inlining its own REST PATCH helper.

**Decision:** A shared `sfUpdateRecord(sfObject, id, fields)` in `lib/salesforce.js` — REST PATCH with the same token/instance the reads use and one forced-refresh retry on 401. Every Lambda uses this one write path; tenant scoping remains the caller's responsibility (prove ownership before calling).

**Rationale:** One audited write path instead of N copies. The budget Lambda uses it for the output+control-field writeback. (Pre-existing inline `sfPatch` helpers in aurora/acumatica push are candidates to migrate onto this later.)

---

## D-041: Budget Lambda Uses `lib/salesforce.js` (JWT Bearer), Not jsforce

**Date:** 2026-07-21
**Status:** Decided

**Context:** The delivered budget package used jsforce + a stubbed auth block. Every other Sundial Lambda authenticates via `lib/salesforce.js` (Connected App JWT bearer for the integration user, key from Secrets Manager, module-scope token cache).

**Decision:** Rewrite the handler to the org-standard path — reads via `sfQuery`, writes via `sfUpdateRecord` — and remove jsforce entirely.

**Rationale:** One SF auth/client pattern across the whole backend; smaller bundle (6.2 MB → 3.6 MB before other libs); no second SF client to maintain. Also means the budget Lambda needs no `SF_LOGIN_URL`/JWT env vars — the shared helper + the secret provide them.

---

## D-042: Budget Recalc Endpoint — `POST /projects/{recordId}/budget/recalc`

**Date:** 2026-07-21
**Status:** Decided

**Context:** The portal "Recalculate Budget" button needs a synchronous recalc that returns fresh numbers in the same request; field edits need an async path too.

**Decision:** One Lambda, two entry points. HTTP `POST /projects/{recordId}/budget/recalc` (synchronous, Supabase-JWT verified via `resolveIdentity`, tenant-scoped on `Client__c` per D-035) returns the computed fields. The same Lambda also consumes the `Sundial_Budget_Recalc__e` platform event (field-change Flow) via the EventBridge/SQS relay. Documented in `docs/api-endpoints.md`; gateway wiring in `scripts/wire-budget-recalc-route.ps1`.

**Rationale:** Same code path for button and trigger; the button path is authenticated like every other portal endpoint (in-Lambda verification), the internal event path is integration-trusted.

---

## D-043: Portal Access Model — Access_Level__c + Super_Admin__c (UI-Tier Gating)

**Date:** 2026-07-22
**Status:** Decided

**Context:** Sundial needs a portal access model: who sees which tabs/sections/fields/reports, and who can manage users. The hierarchy fields (`Hierarchy_Level__c`, `Parent_User__c`) exist but conflate "org position" with "permission tier," and dealer-based record visibility is a later phase. A simple, explicit tier that the frontend can gate on now — without building record-level authorization yet — is what's needed to ship.

**Decision:** Two new `Sundial_User__c` fields, surfaced on the portal identity (`GET /auth/me` via `lib/identity.js`):
- **`Access_Level__c`** — restricted picklist (Executive, Manager, Admin, Sales Dealer, Sales Rep, Technician). Drives **UI-tier gating**: which tabs/sections/fields and which reports a user sees. Frontend enforcement.
- **`Super_Admin__c`** — checkbox (default false). Gates **only** the upcoming Manage Users surface. **Set exclusively by hand in Salesforce; never writable through any Sundial endpoint.** Surfaced as a strict boolean (`=== true`, fail closed).
- **`Default_Department__c`** — landing page only, not an access restriction.

Reserved / out of scope for now:
- **`Hierarchy_Level__c` + `Parent_User__c`** — reserved for the future dealer-visibility phase (record-level scoping), not used for gating today.
- **No module-level restrictions** — all four departments are visible to all users; access differences are tier-based, not module-based.

**Enforcement:** For now, **UI gating** (frontend reads `accessLevel`/`superAdmin`) plus **server-side checks on the future user-admin endpoints only**. The read/write Lambdas (`sf-query`/`sf-update`) get **no** new authorization/filtering from this decision — tenant isolation via `Client__c` (D-034/D-035) remains the only server-side access control until the dealer-visibility phase.

**Alternatives:** Gate on `Hierarchy_Level__c` — rejected: it's an org-position concept, and overloading it with permissions blocks the clean dealer-visibility model later. Module-enablement flags — rejected: all departments are visible to all users; tiers, not modules, differentiate access.

**Notes:** `public.profiles` does not carry `access_level`/`is_super_admin` columns, so `upsertProfile` is unchanged (Supabase schema changes out of scope). The stale `/auth/me` doc (fictional `roles`/`enabledModules`) was corrected to the real shape in the same change.

---

## D-044: User Provisioning Model — sundial-user-admin (Super-Admin-Gated)

**Date:** 2026-07-23
**Status:** Decided

**Context:** D-043 defined `Super_Admin__c` as the gate for user management. The admin surface needs to create/list/update/deactivate portal users, which means coordinating **two** systems per user — a Supabase auth user (the login) and a `Sundial_User__c` record (the identity/tenant). Two-system writes risk orphans (auth user with no SF record, or vice versa), and a live Supabase session must not outlive a deactivation.

**Decision:** A dedicated `sundial-user-admin` Lambda (`GET/POST /admin/users`, `PATCH /admin/users/{id}`), gated on `Super_Admin__c === true` (fail closed) and tenant-scoped on `Client__c` from the verified token. Specific choices:
- **Credential mode is caller's choice per user:** `invite` (Supabase emails a set-password link) or `password` (admin sets a `tempPassword`, `email_confirm: true`, `must_change_password` flag). Supports both "let them set it" and "read it to them" onboarding.
- **Create order is fail-safe (mirrors the aurora-push philosophy):** duplicate-guard → Supabase auth user → `Sundial_User__c`. If the SF create fails after a **fresh** auth user was made, the auth user is **deleted (compensating action)** so no orphan login survives. An existing auth user (same email) is **reused, not recreated**, so a retry after a partial failure re-links cleanly.
- **Deactivate = SF `Active__c=false` + Supabase ban** (`ban_duration ~100y`), reactivate unbans. Salesforce is the source of truth; the ban is **defense-in-depth** to kill live supabase-direct sessions (comments RLS) — a ban failure is reported (`supabaseBanFailed`) but does not fail the SF change.
- **Email is not editable via PATCH** (deliberate non-feature: an email change would desync the Supabase login and SF record; revisit if needed).
- **Self-deactivation is blocked** (`CANNOT_DEACTIVATE_SELF`) so a Super Admin can't lock the tenant out of user management.
- **Never writable from request input:** `Super_Admin__c` (Salesforce-set only, per D-043), `Client__c`, `Supabase_User_Id__c`. `Super_Admin__c` may appear in list responses; the raw `Supabase_User_Id__c` value is never returned (only a `hasLogin` boolean).

**Enforcement:** This is the **only** server-side enforcement of the D-043 model — `sf-query`/`sf-update` get no new authorization from this decision. Tenant isolation remains `Client__c` (D-034/D-035).

**Alternatives:** Create SF first then Supabase — rejected: a failed auth create would leave a Sundial_User__c that can never log in, and there's no clean compensating "un-create" for the login the user might already be mid-invite on. Hard-delete on deactivate — rejected: loses history and breaks record references; deactivate + ban preserves the audit trail.

---

## D-045: Salesforce describe cache gets a TTL (FLS/schema-change propagation)

**Date:** 2026-07-30
**Status:** Decided

**Context:** `sundial-sf-update` and `sundial-sf-query` cache the Salesforce object `describe` in Lambda module scope and only refreshed it on a 401. The describe carries each field's **per-integration-user FLS** (`updateable`/`createable`) and the field set. When FLS was granted this week (the budget permission set assigned to all users, which added edit access to fields like `Utility_Password__c`), warm containers that had cached the describe **before** the grant kept seeing those fields as non-writable. Because `sundial-sf-update`'s `validateWritableFields` **rejects the entire PATCH if any one field is non-writable** (fail-closed, by design), a single stale field blocked the **whole record save** — an intermittent, un-reproducible failure (per container) that self-healed only when the container recycled. Reproduction confirmed every direct/deployed write path *succeeds* once a container has a fresh describe; the failure was purely stale-cache.

**Decision:** Cache the raw describe with a **5-minute TTL** in both Lambdas (`DESCRIBE_TTL_MS`). On expiry the describe is refetched; in `sundial-sf-query` the derived trimmed-field cache is invalidated on refresh so newly-added fields also appear. A 401 still forces an immediate refresh (auth change). This bounds FLS/schema-change staleness to ≤5 min without a redeploy. A redeploy on 2026-07-30 flushed the then-stale containers immediately.

**Consequences:** One extra describe call per object per 5-min window per warm container — negligible vs. the API budget, and describe is not tenant-scoped so it's shared across all callers. Does not change the fail-closed whole-PATCH rejection (that stays — it's correct; the fix is keeping the writability data fresh, not weakening the gate).

**Note (security, related):** `Utility_Password__c` is a **plaintext** SF string field (not encrypted, not mirrored into the Supabase cache). Storing real utility-portal passwords in the clear is a posture worth revisiting (Shield Platform Encryption or off-platform secret storage) — tracked separately, not part of this ADR.

---

## D-046: Auth email via Supabase Custom SMTP (Amazon SES); invite-first provisioning

**Date:** 2026-08-03
**Status:** Decided (config steps pending Tim; frontend flip staged behind them)

**Context:** The provisioning incident (D-044 surface, incident 2026-07-29) was root-caused to Supabase's **built-in** email sender not delivering to external recipients and being hard rate-limited. That broke both `inviteUserByEmail` (invites) and `resetPasswordForEmail` (resets). As a stopgap the create UI defaulted to a temp-password mode (no email) and disabled the invite radio.

Re-investigation on 2026-08-03 with **live data** established what was NOT broken, correcting the incident's working hypothesis:
- **Tenant binding is intact for every user, including invite-created ones.** `sundial-user-admin` force-stamps `Client__c = identity.tenantId` (fail-closed `NO_TENANT`) since its first commit. Live query of `tmurphy5213+inviteuser1` and all invite users showed `Client__c = harmon`. The reported "invite users miss their tenant binding → can't load Sales" was disproven.
- `scripts/verify-provisioning-e2e.mjs` proves the whole chain green against prod: create → temp-password login → `/auth/me` resolves tenant=harmon → `GET /sf/customer` returns 200 with 31,576 tenant-scoped records → forced change → re-login → old password rejected.
- The one genuinely broken class was **email delivery** (invites + resets) plus a few stray records (orphan auth users, one never-onboarded user) — see recovery.

SES is now verified and out of sandbox for `sundialcrm.com` (us-west-1), sender `harmon@sundialcrm.com`.

**Decision:**
1. **Point Supabase Auth at SES via Custom SMTP** (`email-smtp.us-west-1.amazonaws.com`, port 465, SES SMTP credentials, sender `harmon@sundialcrm.com`). This fixes invite AND reset delivery in one move. Steps + exact values: `docs/integrations/auth-email-ses.md`. This is distinct from `lib/email.js` (SES SDK), which remains for *application* transactional email — the two do not overlap.
2. **Invite-first provisioning.** With delivery working, the create UI defaults to **Send email invite** (invited users set their own password on `/reset-password`); the temp-password path stays as an explicit fallback. Invite links land on `PORTAL_BASE_URL/reset-password` (defaults to `https://harmon-crm.vercel.app`, the real prod URL); resets land on `window.location.origin/reset-password`. Both must be in the Supabase redirect allowlist (Site URL + Redirect URLs).

**Consequences:**
- **Deployment ordering is load-bearing:** the frontend invite-default flip must ship only *after* the SMTP + redirect-allowlist config is live and the manual invite test passes, or new users get undeliverable invites.
- Recovery is email-independent (`scripts/recover-provisioning.mjs`, fix-in-place temp passwords), so it does not block on the SMTP work.
- No backend code change is required for auth email (it's Supabase config); the only backend addition is `sfDeleteRecord` in `lib/salesforce.js` for e2e-verify teardown.

---

## D-047: Aurora Design Request runs on the Customer module, not the Solar module

**Date:** 2026-08-03
**Status:** Decided — **supersedes D-032 (Aurora half)** and the 2026-07-30 solar-route decision recorded in PROGRESS.md ("Aurora 'Submit Design Request' (built + wired)" / TASKS.md), which specified `POST /projects/{solarId}/design-request/submit` with server-side Solar→Customer resolution.

**Context:** The design-request route shipped on 2026-07-30 took a `Sundial_Solar__c` id in the path and resolved the record's linked customer server-side. That route is **unusable in the real business flow**: at design-request time **no `Sundial_Solar__c` record exists**. A Solar project is created only *after* the proposal comes back and the documents are signed — the design request is precisely the step that produces the proposal. The route was wired and verified end-to-end against a hand-made Solar record, which is why the gap wasn't caught: the test data existed, the business precondition did not. Nothing in the frontend ever referenced it, so no client was ever exposed to it.

Two other things forced the shape of this decision:
1. **Aurora accepts almost none of the form.** A live read of Aurora's documented request surface (`docs/integrations/aurora-api-reference.md`) confirms project-create takes only `external_provider_id`, `name`, `status`, `location.property_address`, and the optional `customer_*` identity fields; the consumption endpoint takes the 12 monthly values. There is **no Aurora endpoint that accepts a design request** — panel SKU, inverter SKU, turnaround, battery, financing, offset, notes have no API home at all, and our key is provisioned for none.
2. **A live describe of `Sundial_Customer__c` (2026-08-03)** confirmed all 19 Design Request fields exist on the Customer object with one exception: **`Design_Notes__c` does not exist yet**. `Term__c` is a *multi*-select picklist, and `Design_Turnaround__c`'s first value is "In Home" (not "In House").

**Decision:**
1. **All Aurora integration operates on `Sundial_Customer__c`.** The route is `POST /customers/{recordId}/design-request/submit`, where `{recordId}` is a Customer id. The `/projects/{recordId}/design-request/...` route is **deleted** from API Gateway (`scripts/wire-design-request-route.ps1 -RemoveLegacy`), along with its Lambda invoke permission. `/projects/{recordId}/budget/recalc` is untouched.
2. **Server-side sourcing.** Nothing but the record id is taken from the caller. Every value pushed to Aurora or shown in the email is read fresh from Salesforce at submit time, tenant-scoped on `Client__c` (D-035); a missing or cross-tenant id is an indistinguishable 404.
3. **Project creation is once-only; notification delivery is independently retryable.** Two markers, not one:
   - `Sent_to_Aurora__c` (DATETIME) / `Aurora_Project_ID__c` — an Aurora project exists. Either one means **never create a second**, full stop.
   - `Design_Request_Email_Sent__c` (DATETIME, **new field**) — a notification actually **landed**. Only this suppresses the email.

   On a re-submit: if a notification previously succeeded → `already_pushed` + `email.sent: false, reason: "already_submitted"` (today's behavior, plus `notifiedAt`). If it never succeeded → **send it now** (same payload, fields re-read fresh) and return `email.sent: true, resend: true`, with **no Aurora calls on either path**.
4. **The email IS the delivery channel for the form.** Since Aurora accepts none of the 19 Design Request fields, the notification to the design manager carries the *complete* field set (Aurora-accepted or not) and is how that data reaches Aurora at all — a human keys it in. Recipients are env-driven: `DESIGN_REQUEST_NOTIFY_TO` (required) and `DESIGN_REQUEST_NOTIFY_CC` (optional; no Cc header when unset), matching `lib/email.js`'s existing `EMAIL_FROM` pattern.
5. **Email is best-effort, never fatal — and never self-sealing.** A missing recipient, unconfigured SES, or a rejected send leaves the push at `status: "pushed"` with `email.sent: false` and a reason, and leaves `Design_Request_Email_Sent__c` **unstamped** so a re-submit recovers it. It is still sent when the Salesforce write-back fails — the request *was* submitted, and the design team shouldn't pay for a Salesforce hiccup.
6. **The email field list is describe-filtered** (5-min TTL cache, per D-045). A field the org doesn't have — `Design_Notes__c` and `Design_Request_Email_Sent__c` today — is dropped from the SELECT rather than 400-ing the whole submit, and starts flowing automatically once created. No code change needed. While the tracking field is absent, delivery cannot be recorded, so the route resolves the ambiguity toward **re-sending** (reported as `email.tracking: "unavailable"`): silence is the failure mode being guarded against, and a duplicate notification is the cheaper error.

**Alternatives considered:**
- *Keep the Solar route and create a stub Solar record at design-request time* — rejected: it inverts the real pipeline, pollutes the Solar pipeline with records that may never become projects, and makes Solar stage metrics meaningless.
- *Accept the form values in the request body* — rejected: it would let a caller submit values that don't match the record of truth, and the email would document a design request that Salesforce disagrees with.
- *Re-send the email on every duplicate submit* — rejected: once a notification has landed, a re-submit is a double click, not a new request, and a second copy sends the design manager chasing work they already have. Hence the marker: re-send only when nothing ever landed.
- *One marker for both facts (`Sent_to_Aurora__c` alone)* — **rejected as a trap** (caught in review before first deploy). It couples "the project exists" to "someone was told", so a first submit whose email failed would stamp the customer as submitted with nobody notified, and every re-submit would short-circuit to `already_submitted` forever: an Aurora project with no design request behind it and no in-product recovery. The extra field is the cheapest way to keep the two guarantees independent.
- *Reuse an existing field to track delivery* — rejected after checking the live describe: `Confirmation_Sent__c` (boolean) and `Proposal_Sent_Date__c` both carry unrelated business meaning, and overloading either would corrupt whatever reads them.

**Consequences:**
- The frontend "Submit Design Request" button belongs on the **Customer** record's Design Request Form tab, and posts a Customer id. (Separate harmon-crm task; nothing referenced the old route, so there is no migration.)
- The email step is **live but inert** until `EMAIL_FROM` + `DESIGN_REQUEST_NOTIFY_TO` are set on `sundial-aurora-push` and the role has `ses:SendEmail` — it logs and reports `email_not_configured` in the meantime. Vars documented in `docs/api-endpoints.md`.
- Two fields to create on `Sundial_Customer__c`: **`Design_Notes__c`** (long textarea) so notes reach the design manager, and **`Design_Request_Email_Sent__c`** (datetime, writable by the integration user) so delivery can be recorded. Until the latter exists, a re-submit re-sends the notification every time — correct but chatty.
- If Aurora ever provisions a design-ordering API, fields move from the email block to the payload in `designRequest.js` — the route contract does not change.

---

## D-048: Aurora inbound is doorbell + queue + worker; signed agreements land on the Customer

**Date:** 2026-08-04
**Status:** Decided (built + tested; not deployed, Aurora subscription not created)
**Related:** extends D-047 (all Aurora integration runs on `Sundial_Customer__c`), follows the D-007 Acumatica queue pattern.

**Context:** Aurora's `agreement_status_changed` webhook is the trigger for pulling a signed contract's data into Sundial (design results, financing, proposal link, and the signed PDF). Three constraints in Aurora's contract shape the design:
1. **A 10-second response deadline.** A slower response counts as a failed delivery and enters a retry ladder (30s, 5m, 30m, 3h, 20h); ~48h of consistent failure **auto-disables the subscription**. Four retrievals plus PDF generation and download cannot fit in that budget.
2. **Duplicates are possible and ordering is NOT guaranteed** — a `signed` can arrive before a `viewed`.
3. **403 means "not provisioned for our API key"**, not an auth bug — permanent until Aurora's account team changes it.

**Decision:**
1. **Doorbell + SQS + worker.** `sundial-aurora-webhook` authenticates (shared secret, constant-time compare, no Supabase JWT — the caller is a machine), validates minimally, enqueues to `sundial-aurora-inbound`, and acks. It performs **no** Salesforce or Aurora I/O. `sundial-aurora-inbound` (SQS-triggered) does everything slow. **A failed enqueue returns 5xx on purpose** — that is what drives Aurora's retry ladder; a 200 there would silently drop a signed contract.
2. **Everything writes to `Sundial_Customer__c`.** No `Sundial_Solar__c` exists at signature time and this pipeline must never create one (D-047).
3. **Two idempotency layers.** Status writes dedupe on `(agreement_id, status)` and obey a precedence rank (`sent`<`viewed`<`cancel-pending`<`declined`/`canceled`/`error`<`signed`), so a late `viewed` cannot regress a `signed`. The signed work is gated on `Aurora_Signed_Email_Sent__c`: set means fully processed (a duplicate does nothing), unset means a partial run is **resumed**. Each step is independently idempotent — the field PATCH replays harmlessly, the PDF key is deterministic (overwrite, not duplicate), the email is marker-gated.
4. **Customer resolution is by Aurora project id, cross-checked.** `Aurora_Project_ID__c` finds the record; the design's `external_provider_id` (our SF id) is compared against it. No match, multiple matches, or a mismatch is **permanent** — dead-letter rather than write a signed contract onto a guessed customer.
5. **Error classification drives the DLQ.** Permanent (no/ambiguous customer match, provider-id mismatch, missing `design_id` on signed, any Aurora 403) is logged with a `PERMANENT` marker; retryable is everything else. Both report `batchItemFailures` so SQS redrives to `sundial-aurora-inbound-dlq` per `maxReceiveCount=5` — bounded, not an infinite loop.
6. **New Salesforce fields behind the describe guard.** `Aurora_Agreement_ID__c`, `Aurora_Agreement_Status__c`, `Aurora_Agreement_Status_At__c`, `Aurora_Proposal_Link__c`, `Aurora_Signed_Email_Sent__c` don't exist yet; the worker drops absent fields from every SELECT and PATCH and reports the gap in the notification email. Same pattern as `Design_Notes__c` (D-047). Existing fields carrying other business meaning were **not** overloaded.
7. **Receipt time is the signing timestamp.** The agreement object has no `signed_at` and the webhook carries none, so `Contract_Signed_Date__c` / `Sold_Date__c` come from webhook receipt time, converted to the **America/Phoenix** calendar date (a UTC date would file an evening signature a day late). Stamped at the doorbell so a queue backlog can't drift it.
8. **Unmappable picklist values are reported, never guessed.** `ppa`/`levelized_ppa` have no honest match in `Financing_Type__c` (Cash|Loan|Lease), and an unknown `financier.provider` is not coerced to "Other" — that would erase which lender it actually was. Both are left unset and surfaced in the email.

**Alternatives considered:**
- *Do the retrievals inline in the webhook handler* — rejected: it cannot fit in 10 seconds, and the failure mode is Aurora disabling our subscription.
- *Filter the subscription to `signed` only* (what the reference previously said) — rejected: every status is cheap and makes the pipeline observable; only `signed` triggers retrieval anyway. The stale line is corrected in `aurora-api-reference.md`.
- *Overload an existing field for agreement status* — rejected per the explicit instruction and general principle: `Confirmation_Sent__c` / `Proposal_Sent_Date__c` mean other things.
- *Trust the webhook's status blindly* — rejected for `signed`: the worker re-reads the agreement, and if Aurora says it is no longer signed it records **Aurora's** status and skips the signed-only work.

**Known limitation — RESOLVED 2026-08-04, see the amendment below.** ~~A genuine post-signature cancellation is indistinguishable from an out-of-order delivery (no status timestamp anywhere in Aurora's contract), so a `canceled` after `signed` is ignored by the precedence rule and needs manual handling.~~

**Consequences:**
- New infrastructure Tim must create by hand: the SQS queue + DLQ (redrive `maxReceiveCount=5`, visibility 180s), the `sundial-aurora-inbound` Lambda (60s/512MB), the event-source mapping **with `ReportBatchItemFailures`** (without it SQS ignores partial-batch failures and deletes the batch), and `AURORA_INBOUND_QUEUE_URL` on the doorbell. Runbook: `docs/integrations/aurora-inbound.md`.
- The doorbell's shared-secret cache gained a 5-minute TTL so the token can be rotated without a redeploy — previously it was cached for the container's life.
- `lib/aurora.js` (retrieval client) and `lib/sqs.js` (enqueue/parse) are new shared modules; `lib/salesforce.js` gained `describeObject` so the describe guard isn't copy-pasted per Lambda.

### Amendment (2026-08-04): post-signature cancellations are confirmed with Aurora, not inferred

The limitation above is closed. Ordering could never settle "genuinely canceled after signing" vs. "stale `canceled` delivered late", so the worker **stops inferring and asks**.

On any **negative terminal** status — `canceled`, `cancel-pending`, `declined` — the worker re-reads the agreement from Aurora *before* applying precedence:
- **Aurora reports the negative status** → it is real. Applied **even over a recorded `signed`** (precedence bypassed, because order is no longer what we're reasoning from), `Aurora_Agreement_Status_At__c` stamped, and a **cancellation notification** sent to the same recipients as the signed one — subject flagged `AFTER SIGNING` when it contradicts a recorded signature, since downstream work may already be moving on a dead contract. Aurora's value wins even when it differs from the webhook's (a `cancel-pending` event on an agreement Aurora has already moved to `canceled` records `canceled`).
- **Aurora still reports `signed`** → the event really was stale. Dropped exactly as before: nothing written, nothing sent.
- Any other current status falls through to the ordinary precedence rules.

The **`signed` path is unified with this**: that path already re-read the agreement to confirm the signature, so when the re-read shows a dead agreement it records Aurora's status *and* sends the same cancellation notification, with the same `AFTER SIGNING` flag when it contradicts a recorded signature. A dead contract is announced however Sundial found out about it — via a `canceled` event or via the re-read on a `signed` one. Both paths gate the email on the status actually changing, so a redelivered event on an already-canceled record does not re-alarm.

**Deliberately narrow:** `error` is **not** in the set — it signals a delivery/processing fault, not that the contract is dead, so it stays rank-governed and triggers no re-read. Exact duplicates short-circuit *before* the re-read, so a redelivered `canceled` costs no Aurora call and sends no second email. The notification is gated on the status actually changing, which is what prevents repeats — no additional marker field was needed.

**Cost:** one extra Aurora `GET /agreements/{id}` per non-duplicate negative terminal event — rare, and the correctness it buys is a contract that cannot silently stay "signed" in Sundial after being canceled in Aurora. A 403 while confirming is treated like any other 403: permanent, dead-lettered, never guessed.

---

## D-049 — Budget push triggered by a direct portal API call (relay/SQS dropped from this path)

**Date:** 2026-08-07
**Status:** Accepted

**Context:** Budget Layer 2 (`lambdas/sundial-acumatica-budget-push`) writes the calculated budget onto a project's existing Acumatica `ProjectBudget` lines. The original Layer-2 sketch triggered via the general outbound pattern — a Salesforce record-triggered Flow → Platform Event → relay → SQS → consumer.

**Decision:** For the budget push, trigger the write **directly** from the portal **"Update Budget"** button via `POST /projects/{recordId}/budget/push` on the Sundial REST API. The Flow → Platform Event → relay → SQS chain is **dropped from this path**. The HTTP request validates the gates and returns **202** immediately; the actual write runs in an **async self-invoke** of the same Lambda (`InvocationType: Event`), because a fresh scaffold read plus up to ~15 PUTs with retry can exceed API Gateway's ~29 s synchronous ceiling.

**Rationale:**
- The push is a **user action on one record**, not a data-change reaction — a synchronous request/ack fits better than an eventual queue drain, and gives the user immediate gate feedback (`409` with a reason code) instead of a silent enqueue.
- One fewer moving part (no Flow, no Platform Event, no relay/SQS wiring) for a path that must be hand-proven per project during rollout.
- Re-push is idempotent (update-by-GUID), so SQS's at-least-once delivery guarantee buys nothing here.

**Consequences:**
- The execution role needs `lambda:InvokeFunction` on its own ARN (`SelfInvokeBudgetPush`) for the self-invoke.
- There is **no janitor** for a worker hard-death mid-run, so status can stick on `Pushing`; the UI must treat `Pushing` as non-blocking and rely on idempotent re-push to clear it (see the runbook in `docs/integrations/acumatica-budget-push.md`).
- The relay/SQS pattern **may return** for a future *recalc-triggered* push (a data-change reaction) — a different trigger from this user-action path, not a reversal of this decision.

---

## D-049: Dealer-originated Aurora deals auto-create the Customer on `signed`

**Date:** 2026-08-07
**Status:** Decided (built + tested; not deployed, no live Aurora calls made)
**Supersedes:** the flat `NO_CUSTOMER_MATCH` dead-letter rule in D-048 §4. Customer resolution by Aurora project id is unchanged; what happens when it finds *nothing* is what changed.

**Context:** Harmon works with third-party dealers who originate deals **entirely inside Aurora**, in Harmon's own tenant. Their `agreement_status_changed` events already reach our webhook, but no `Sundial_Customer__c` exists — the Sundial design request that normally creates the Aurora project never happened. Under D-048 every one of those dead-lettered, so a dealer's *sold contract* landed in the DLQ instead of the CRM, and their pre-sale traffic filled the DLQ with noise.

**Verification first (Aurora's public reference, 2026-08-07)** — three findings shaped the design:
1. **Retrieve Project** (`GET /tenants/{t}/projects/{id}`) returns everything needed to build a customer: `customer_first_name` / `_last_name` / `_email` / `_phone` / `_salutation`, `name`, `external_provider_id`, `status`, `tags[]`, `project_type`, `created_at`, and `location.property_address` + `location.property_address_components.{street_address, city, region, postal_code, country}`. **The components are nested under `location`**, not top-level as first assumed.
2. **Dealer attribution is resolvable to a NAME**, contrary to the "maybe only ids" expectation. The project carries `partner_id`, `owner_id`, and `team_id`; Aurora **partners are external business user groups** — users assigned to one see only that partner's projects — which is exactly Harmon's dealer concept. `GET /tenants/{t}/partners` returns `{ id, name }` (no single-partner GET, so we list and cache), and `GET /tenants/{t}/users/{id}` names the owning person as a fallback.
3. `Aurora_Project_ID__c` is **already flagged External ID** (`externalId: true`, `idLookup: true`) — so an atomic upsert is available.

**Decision:**
1. **Branch on `external_provider_id`, not on absence alone.** Unmatched **signed** → Retrieve Project, then: absent provider id = genuine dealer origination → **CREATE**; present and resolves (in-tenant) = our own deal whose design-request write-back failed → **REPAIR** the link and continue, creating nothing; present but unresolvable = `PROVIDER_ID_MISMATCH` → DLQ. Never guess.
2. **Only `signed` creates.** Harmon wants customers for deals that actually sell. Unmatched non-signed events are **dropped quietly** (info log, no DLQ, no retry) — they are normal dealer pipeline traffic. The exception: an unmatched non-signed event that *does* carry a provider id is our own broken deal and still dead-letters.
3. **Idempotent by construction — upsert, not select-then-create.** The create is a Salesforce upsert keyed on `Aurora_Project_ID__c`. A SELECT-then-create has a race window that duplicate deliveries and concurrent workers *will* eventually hit, producing two customers for one Aurora project; the external id makes Salesforce the uniqueness authority instead. Ambiguity (300 Multiple Choices) dead-letters rather than looping.
4. **Every mapped field is describe-guarded, and nothing retrieved is discarded.** A missing optional value never fails the creation of a customer who has just signed. `State__c` is written only on a real picklist match (case-insensitively, in the org's canonical casing — the org's list contains the typo "Il"); the `Lead_Source__c` value `Aurora - Third-Party Dealer` does not exist in the org's ~200-value picklist, so it is skipped with a warning. Both the unmatched state and the skipped lead source, plus raw address, country, salutation, mailing address, tags, and all attribution ids, land in `Aurora_Import_Notes__c`.
5. **Attribution never blocks an import.** 403 on List Partners / Retrieve User degrades to the raw id in `Aurora_Dealer_Name__c` plus a warning. A 403 on **Retrieve Project**, by contrast, is fatal to the feature and dead-letters loudly as `AURORA_NOT_PROVISIONED`.
6. **Tenant comes from configuration, not a hardcoded id.** `SUNDIAL_TENANT_SLUG` (default `harmon`) resolves to the `Sundial_Tenant__c` record id, matching the slug identity already used by `VITE_TENANT_ID`, the S3 prefix, and `client-config.ts` (D-034). Owner stays the integration user — no `OwnerId` write.
7. **The record is marked as machine-built.** The signed-agreement email leads with "This customer was AUTO-CREATED from a dealer-originated Aurora project (dealer: …)" so nobody mistakes it for a qualified Sundial lead.

**Alternatives considered:**
- *Create on any status* — rejected per Harmon: it would fill the CRM with dealers' unsold pipeline.
- *SELECT then create* — rejected: the race is real under duplicate delivery, and the External ID flag was already there.
- *Backfill the earlier statuses after creating* — rejected: the events were already dropped and Aurora exposes no status history. Auto-created records simply start at `signed`; documented, not hidden.
- *Default `Lead_Source__c` to an existing value like "Other"* — rejected: it would misattribute a dealer sale. Skipped and reported instead.
- *Leave `Status__c` / `Stage__c` to the org defaults* — this was the initial position (they are required-with-a-default, so the insert succeeds either way, and the pipeline position is a business call). **Tim decided 2026-08-07:** `Status__c` = `Customer`, `Stage__c` = `Sold - Pending Review`. `Status__c` turned out to be load-bearing rather than cosmetic — the org default is **`Lead`**, so leaving it would have parked closed dealer sales in the CRM as leads. `Stage__c` gives the review these records need an actual queue. Both go through the same match-or-skip picklist guard as everything else, so a renamed value degrades to a warning instead of failing a signed contract's import.

**Consequences:**
- Three Salesforce to-dos (TASKS.md): `Aurora_Dealer_Name__c` (Text 255), `Aurora_Import_Notes__c` (Long Text 32768), and the `Lead_Source__c` picklist value. Until they exist the import still succeeds and reports the gap.
- Auto-created customers carry only what Aurora knows — no Sundial design request, no Harmon qualification — so they need review. The email says so.
- The post-signature cancellation logic (D-048 amendment) works on these records with no special-casing: by the time a cancellation arrives the customer exists like any other.
- ### Amendment (2026-08-10): the signed pipeline position applies to every signed agreement

The `Status__c` = `Customer` / `Stage__c` = `Sold - Pending Review` decision above was originally scoped to **auto-created** dealer customers. It now applies to **every** `signed` event, including a pre-existing customer matched by `Aurora_Project_ID__c`. Aurora's `signed` means exactly that in Sundial regardless of how the customer got there, and the split was arbitrary from the business's point of view.

**This makes the Stage write the notification mechanism, not a status flag.** Harmon has Salesforce alerts triggering off `Sold - Pending Review`, which is why the SES email channel is being left unconfigured on purpose. Two consequences follow:
- A renamed or removed picklist value doesn't just lose a field — **the alerts silently stop firing**. The skip warning says so in those words.
- Both paths now build these fields from one shared helper (`customerCreate.js » buildSignedPipelineFields`) so the auto-create and matched-customer paths cannot drift apart.

Deliberately unchanged: non-signed statuses don't move the pipeline, a confirmed cancellation does not promote a dead contract, and a `signed` event Aurora contradicts on re-read records Aurora's status only. **Also unchanged and worth knowing:** a cancellation *after* signing records `canceled` but does **not** roll `Status__c`/`Stage__c` back — the alert has already fired and the unwind is a human job (tracked in TASKS.md).

**Known edge:** if the project reports no `external_provider_id` but the *design* reports one, Aurora's own objects disagree. Since the customer has been created by then, dead-lettering would strand it — the worker warns loudly (email + log) and flags a possible duplicate instead.

---

## D-050: List page size is capped at 5000 on the cache path, with paging pushed down into the Lambda

**Date:** 2026-08-10
**Context:** punchlist G2 — the Sales list threw intermittent 500s under concurrent paged loads.

**The 500s were not ours.** The AWS account's Lambda **"Concurrent executions" quota in us-west-1 is 10** (the unraised new-account limit; AWS default is 1000), shared across all 32 functions. Throttled invocations are rejected before the function starts and API Gateway renders that as `500 {"message": "Internal server error"}`. Recorded here because the failure signature is genuinely misleading and will otherwise be re-diagnosed as a code bug: **no CloudWatch log line, `Errors` metric flat at 0, ~65 ms response, and a body that is not the one this Lambda emits** (`{"error":"server_error"}`). Diagnose with `ConcurrentExecutions` (Max) + `Throttles`, and `service-quotas get-service-quota --quota-code L-B99A9384`.

**Decision:** the list endpoint's cache-path page cap goes **500 → 5000**, default 500 when `limit` is absent.

**Why a cap raise is the right response to a concurrency ceiling.** The old cap forced 64 round trips to sweep 31.6k customers. Page size and concurrency pressure are the same variable seen from two ends — cutting the sweep to 7 requests removes the burst that collided with the ceiling, and it is the half we control. Raising the quota is the other half, and it is Tim's console action, not a code change. Neither substitutes for the other.

**5000 is bounded by Lambda's 6 MB response limit**, not by preference: 5000 customer rows is ~4.4 MB of JSON. That is the number to re-derive against if the cap is ever revisited or a wider cache table is added.

**Paging is pushed down into the Lambda rather than delegated to a dashboard setting.** Supabase's PostgREST "Max Rows" is **1000 and silently truncates** — a 5000-row request returns `206` with 1000 rows and no error. A clamp raise alone would therefore have advertised a page size the cache layer quietly ignored, which is a worse failure than the one being fixed because it is invisible. `fetchCacheRange()` splits any page over 1000 into consecutive `.range()` sub-requests (exact count on the first only). **The endpoint is correct at any "Max Rows" value**; raising it in the dashboard is a performance optimization that collapses 5 sub-requests to 1, never a correctness prerequisite.

**The raise is cache-path only.** The live-Salesforce list paths — cold-cache fallback and the TEMP Sales-Rep restrict (D-035 lineage) — keep the original 500 cap via `SF_LIVE_MAX_LIMIT`. SOQL `OFFSET` is hard-capped at 2000 and those paths write back every row they return, so a 5000-row page there buys nothing and risks the timeout.

**Consequences that a 10x page forced, each measured rather than assumed:**
- A fully-stale 5000-row page is 25 `IN()` chunks against Salesforce. Sequentially that measured **~35s, past the 30s function timeout**. Chunks now run 5 at a time (`REFETCH_CONCURRENCY`) — 13.2s worst case. **This coupling is load-bearing: raising the cap further without revisiting the refresh fan-out reintroduces the timeout.**
- That fan-out let a cold container fire 5 simultaneous JWT bearer requests for one integration user, so `getSalesforceToken` coalesces concurrent refreshes onto a single in-flight request. It is **cleared on settle, both success and failure** — a rejected promise left in module scope would turn one transient auth blip into a permanently broken warm container.
- Cache upsert and delete-detection are batched, so a max-size page is never one ~4 MB PostgREST write or an over-length `.in()` URL.

**Rejected:** raising "Max Rows" in Supabase and relying on it (silent truncation returns the moment the setting is changed back or a new project is stood up from this base — and sundial-core is copied to stand up tenants). Reserving concurrency for `sundial-sf-query` (with only 10 account-wide it would starve the other 31 functions).

---

## D-051: Cache deletes are reconciled on demand, not propagated

**Date:** 2026-08-11
**Context:** five deleted `Sundial_Solar__c` records kept appearing in the portal.

**The blind spot, stated plainly:** both `sundial-cache-sync` modes are **upsert-only**, so a record deleted in Salesforce is never removed from the cache. A deleted record just stops appearing in the SOQL result, which an upsert cannot distinguish from "unchanged". There is no tombstone and nothing subscribes to Salesforce delete events. The row lingers as a **ghost** — listed in the portal and counted in `total` — until someone opens it and the read path 404s. Worth recording because the instinct when a cache looks wrong is to run a **full resync, and that does nothing here**: re-upserting every live record leaves the ghost exactly where it was.

**Decision: reconcile on demand.** A third mode, `{ "mode": "reconcile" }`, reads the cache's id set, asks Salesforce which of those ids still exist, and deletes the rest.

**Rejected — propagating deletes properly.** Salesforce can emit delete events (Change Data Capture, or a Flow writing tombstones), and that would keep the cache correct continuously. It needs org configuration, a new consumer, and a tombstone table, and deletions in this system are rare and operator-driven. Revisit if deletes ever become routine.

**The check runs cache → Salesforce in batches, NOT "pull all Ids and diff."** The diff is cheaper in API calls and was rejected on failure mode: an incomplete or errored Salesforce result reads as "every row is a ghost" and would empty the cache. Asking "do THESE ids still exist" fails safe — an errored batch leaves its ids untouched and reports them as `unverified`. **For a destructive job, the cheaper algorithm with the catastrophic failure mode is the wrong one.**

**Batch size 400** is set by the REST query endpoint being a `GET`: the SOQL rides in the URL against Salesforce's ~16 KB cap, and URL-encoding inflates each id to ~24 bytes. Cost is one SOQL per 400 cached rows (~79 queries for the 31.6k customer cache).

**Safety rail:** ≥25 ghosts AND >20% of rows checked ⇒ refuse and delete nothing, overridable with `force: true`. **Both conditions are required.** A ratio alone was the first implementation and its own tests killed it: one ghost out of two rows is 50%, and the roofing cache holds a single row where any ghost is 100% — so a ratio-only rail blocks exactly the ordinary small purges this feature exists to serve, while the mass-wipeout case it is actually guarding against is always high-volume.

**Manual invoke only, deliberately not scheduled.** It is the only destructive path in the Lambda and its API cost scales with cache size. Putting it on EventBridge is a decision to be made explicitly.

**Id normalization is on the first 15 characters, case-SENSITIVE.** Those 15 are the unique key; the 18-char suffix is a checksum derived from them. Case sensitivity is load-bearing — two distinct records can differ only by case in the 15-char form, which is the entire reason the 18-char form exists. Deletes target the exact stored value so rows in either form are removed.

**Known limitation, accepted:** a purge is **invisible to open portal sessions**. There is no Realtime signal for a cache deletion — the invalidation triggers all cover changes, not removals — so a user with the list already on screen keeps seeing the ghost until their next fetch or reload.

---

## Open Decisions (Pending Information)

These are decisions we will make after upcoming meetings or as Phase 1 development proceeds:

- **Vendor data model.** Custom Sundial_Vendor__c or standard Account with Vendor record type. Leaning toward Account record type for simplicity.
- **Aurora replacement timing and approach.** Deferred per Harmon; revisit after Phase 3.
- **Customer self-service appointment booking scope.** Deferred to Phase 3.
- **Marketing/campaign feature scope.** Available as post-launch add-on service, not part of build phases.
- **Acumatica API exact concurrent call limit and other integration coordination.** Awaiting Harmon confirmation in upcoming finance meeting.
- **Commercial AR billing pattern (progress, AIA, single-invoice).** Awaiting finance meeting.
- **Service plan e-commerce structure.** Awaiting service department meeting; planned for Phase 3.
- **Custom PO field name and content.** Awaiting finance discovery.
- **Acumatica template IDs and required field maps.** Awaiting finance discovery.
- **Multi-tech visit junction object vs parallel visits.** Decide during service module build.

---

## D-052: Auth email runs on a dedicated SES SMTP IAM user, and SES metrics are the delivery oracle

**Date:** 2026-08-12
**Status:** Accepted

### Context

Supabase auth email (invites, password resets) never delivered. The failure resisted
diagnosis for weeks because every *visible* signal looked healthy: the SMTP host, port,
and sender in Supabase were all correct, and `/auth/v1/recover` returned 200.

The actual cause was the SMTP **username**: Supabase held
`aW5wLWt1NnhraHhzbjdmcTZ1cG9ybXNpbHQ3Nw==` (base64 for `inp-ku6xkhxsn7fq6upormsilt77`),
which is not an SES credential in either form — an SES SMTP username is always the
20-character `AKIA…` access key ID. It matched none of the five access keys in AWS
account 891377232720, and no `ses-smtp-user` existed there at all.

Two false signals extended the outage:

1. **`200` from `/recover` was treated as proof of sending.** It only proves Supabase
   accepted the request. With custom SMTP off, the built-in sender returns 200 and
   then fails to deliver externally. The observed `535 → 200` transition was a toggle
   flip between two broken paths, not an auth fix.
2. **"No sends in SES metrics" was nearly dismissed as metric lag.** It is not lag:
   `SentLast24Hours` and CloudWatch `AWS/SES` both update within ~2 minutes, confirmed
   by watching a known-good send appear.

### Decision

1. **Auth email sends through a dedicated IAM user**, `sundial-ses-smtp`, with inline
   policy `SesSmtpSending` (`ses:SendRawEmail` + `ses:SendEmail` only) — not a shared
   admin key, and not a credential of unknown provenance. The SMTP password is
   *derived* from the IAM secret (region-salted SigV4 chain), never the raw secret.
2. **SES is the only accepted evidence of delivery.** `SentLast24Hours` plus CloudWatch
   `Send`/`Delivery`/`Bounce` in the identity's region. A 2xx from Supabase is not
   evidence and must not be recorded as such.
3. **Diagnose email failures by bisecting around Supabase first** — an SDK send via
   `lib/email.js`, then a raw SMTP session — before touching Supabase config. Each
   isolates a distinct layer; together they localize the fault in two steps.
4. **Verify the SMTP username is `AKIA`-shaped and belongs to the expected account**
   as part of tenant setup. This one check would have caught the whole incident.

### Consequences

- New tenants get their own scoped SMTP user; rotation re-derives the password rather
  than pasting a raw secret.
- The credential can only send email, so exposure via Supabase config is bounded.
- Costs one extra IAM user per tenant — acceptable against the diagnosis time lost here.

### Addendum (same day): auth links must be redeemed on submit, not on load

Once mail delivered, invite/reset links reported "expired" when clicked within
seconds. Cause: recovery links are single-use and mail security scanners prefetch
URLs, so the scanner spends the token before the human clicks. Reproduced directly.

**Decision:** auth emails link to *our* `/reset-password` carrying
`?token_hash=…&type=…`, and the page redeems via `verifyOtp` **on form submit only**.
Loading the page must never redeem — that is what makes it immune, including to
scanners that execute JavaScript. Auth emails must not link to Supabase's
`/auth/v1/verify`, which spends the token on GET. The legacy hash-session path stays
for links already in flight.

**Consequence:** the email templates are now load-bearing. A template reverted to
`{{ .ConfirmationURL }}` silently reintroduces the bug, and it presents as "expired
link", not as a template problem.

**Also fixed:** custom MAIL FROM on `sundialcrm.com` was
`mail.sundialcrm.com.sundialcrm.com` (doubled suffix, never resolvable), so SPF passed
on `amazonses.com` but did not align with the From domain. Repointed at
`mail.sundialcrm.com`, whose DNS was already correct → `SUCCESS`; SPF now aligns and
DMARC is satisfied on SPF and DKIM both. Still outstanding: `_dmarc.sundialcrm.com`
publishes **two** conflicting records (`p=quarantine` and `p=none`), which receivers
treat as no policy at all. Needs one deleted in GoDaddy DNS.

### Related

`docs/integrations/auth-email-ses.md` (setup + the two traps), D-046 (provisioning
incident), `scripts/verify-provisioning-e2e.mjs`.

---

## D-053: The portal's canonical domain is `sundial.harmonelectric.net`; the Vercel URL is retained as a redirect

**Date:** 2026-08-13
**Status:** Accepted

### Context

The portal was reached at `https://harmon-crm.vercel.app`, the Vercel-assigned
production URL. Harmon moved it to a branded domain on their own DNS,
`https://sundial.harmonelectric.net`, keeping the Vercel URL alive as a redirect so
existing links and bookmarks do not break.

Two backend surfaces are domain-aware and do not follow a redirect:

1. **CORS.** The API echoes the caller's `Origin` only if it is allowlisted, and
   otherwise falls back to `http://localhost:5173` — so an unlisted production origin
   fails *every* API call, not just some. A redirect does not help: the browser sends
   the new origin.
2. **Invite links.** `sundial-user-admin` builds the set-password URL server-side from
   `PORTAL_BASE_URL`, so invites keep pointing wherever that variable says.

### Decision

`sundial.harmonelectric.net` is the canonical portal origin.

- It is added to the CORS static allowlist **alongside** `localhost:5173` and the
  `*.vercel.app` host rule, which are retained. The vercel.app origin therefore still
  passes CORS on its own, independent of the redirect.
- `PORTAL_BASE_URL` is set explicitly on `sundial-user-admin`, and the **in-code
  default is changed to match**. Previously the default was the vercel.app URL, so a
  lost env var would silently regress invites to the retired domain; now the fallback
  is the same working link.

### Consequences

- The allowlist lives in **six** files: `lib/http.js` (bundled into seven Lambdas) and
  five inline copies (`sundial-auth-proxy`, `sundial-sf-query`, `sundial-sf-update`,
  `sundial-acumatica-push`, `sundial-aurora-push`). Adding one origin meant editing six
  files and redeploying twelve Lambdas. Consolidating the inline copies into
  `lib/http.js` is logged as tech debt in TASKS.md — this cutover is the argument for it.
- **Preflight does not exercise this.** API Gateway answers `OPTIONS` itself with
  `Access-Control-Allow-Origin: *`, so a preflight probe passes for *any* origin,
  including one the Lambda would reject. Verify a domain change with a real
  `GET`/`POST` carrying an `Origin` header, never with `OPTIONS`.
- **Supabase's redirect allowlist is a dashboard change and is not covered by a repo
  deploy.** Password resets redirect to `window.location.origin + /reset-password`, so
  they break the moment a user lands on the new domain until the origin is allowlisted
  (Site URL + Redirect URLs). Same for the Vercel domain attachment and DNS.
- The domain is now hardcoded per-tenant in shared backend code. `PORTAL_BASE_URL` is
  env-overridable; the CORS allowlist is not. Logged under multi-tenant readiness.

### Related

`docs/integrations/auth-email-ses.md` (Parts C and D), `docs/api-endpoints.md` (CORS
section + env var table), D-046 (provisioning), D-052 (auth email delivery).

---

## D-054: Welcome calls trigger through ONE platform event over Event Relay; the Retell webhook fans out Lambda-first to the Zapier billing ledger

**Date:** 2026-08-17
**Status:** Accepted

### Context

Harmon's back office calls every sold customer to verify the contract terms before the
project moves into design. Retell AI's voice agent can make that call if it is handed
the customer's terms as dynamic variables. Three questions had to be settled:

1. **What starts a call?** A sold-stage transition needs to start one, and a no-answer
   needs to start another later. Both are Salesforce-side facts.
2. **Does the portal get a button?** Every other integration in Sundial has one.
3. **Who hears the result?** Two consumers want it: Salesforce (the verification
   status) and a Zapier Zap that maintains the billing ledger for the calls.

### Decision

**One platform event, two publishers, no button, and a Lambda-first fan-out.**

1. **`Sundial_Welcome_Call_Request__e` (field `Customer_Id__c`) is the only trigger**,
   published by two Flows — a record-triggered Flow on the `Stage__c` change, and a
   scheduled retry Flow for `No Answer` records under the attempt ceiling. It reaches
   the Lambda via Salesforce **Event Relay → Amazon EventBridge**.
2. **No portal UI and no portal-authenticated route.** The only HTTP surface the
   feature adds is `POST /webhooks/retell`.
3. **The eligibility guard lives in the Lambda, not in the Flows.** Status, attempt
   ceiling, phone validity, calling hours and financing mapping are all checked in one
   place, immediately before dialing, against a **fresh Salesforce read**.
4. **Retell's webhook hits the Lambda, and the Lambda forwards to Zapier** — first,
   unconditionally, before Salesforce is touched.

### Why

**One event, not two.** A separate "retry" event would double the Salesforce metadata,
the relay config, the EventBridge rules and the Lambda's parsing, to express a
difference the Lambda does not act on: a retry and a first call run identical code. The
attempt number lives on the record, so the event does not need to carry it.

**Event Relay, not a portal endpoint or a scheduled poll.** The trigger is a Salesforce
state change, so Salesforce should announce it. A poll would burn API budget on a
question that is almost always "no", and a portal endpoint would need a signed-in user
for something no user initiates. This also reuses the relay pattern already documented
for budget recalc (`docs/integrations/budget-recalc-relay.md`) — and, as there, the
Lambda parses both the EventBridge and SQS-wrapped envelopes, so the relay mechanism
can change without a code change.

**No button, deliberately.** A "Call now" button reads as harmless and is not: it puts
the decision to dial a customer in the hands of whoever is looking at the record, at
whatever hour, bypassing the attempt ceiling and the calling-hours check unless those
are duplicated on the UI path. The guard is only trustworthy if there is exactly one
way in. Harmon can still force a call by moving the stage, or by letting the retry Flow
pick the record up.

**Guard in the Lambda, not the Flows.** Flow entry criteria are edited by an admin in a
browser; a mistake there dials real customers. Keeping the guard in one tested place
means a Flow that fires too eagerly is *harmless* — publishing for a record already
`Calling`, or at attempt 5, is a logged no-op. It also means the check runs against
data read seconds before the dial, not whenever the Flow evaluated.

**Fresh read, never the cache.** These values are spoken to a customer as the terms of
a contract they signed. The cache has a documented TTL and a documented deletion blind
spot (D-051); a stale monthly payment on a recorded call is a trust and compliance
problem, not a rendering glitch. This is squarely the always-fresh class in
`docs/caching-architecture.md`.

**Lambda-first fan-out, not Zapier-first.** Retell can only call one webhook URL, so
one consumer has to relay to the other. Pointing Retell at Zapier and having the Zap
call our API would put a third party in the path of the Salesforce writeback, and would
mean authenticating a Zap into the API. Pointing Retell at the Lambda keeps the
signature check at the edge and makes the Salesforce write a first-class step.

**And within that, the ledger is forwarded FIRST.** The Zap bills for calls — including
rep-initiated calls that carry no `sf_record_id` and may have no Salesforce record at
all. Forwarding before the Salesforce work means a Salesforce outage costs a
verification status (recoverable — Retell retries on our deliberate 500) rather than a
billing row (not recoverable — Retell will not redeliver once we 200). A forward
failure is retried twice, then logged at ERROR with the payload for manual replay, and
never blocks the writeback.

### Consequences

- **The Zap must dedupe on `call_id`.** Because the forward is unconditional and comes
  first, a Retell redelivery posts to the ledger twice even though the Salesforce side
  is idempotent. Moving the idempotency check ahead of the forward was rejected: it
  would put a Salesforce read in front of billing.
- **Idempotency is carried by the log field**, not a dedicated one: a
  `Welcome_Call_Log__c` line containing both the `call_id` and the marker `Result:`
  means the call is already recorded. Matching the `call_id` alone would misfire,
  because the "Call placed" line carries the same id.
- **`No Answer` is the only non-terminal outcome**, which is what makes the retry Flow
  meaningful, and the 5-attempt ceiling (which rewrites it to `Failed - Max Attempts`)
  is what makes it terminate. An **unrecognized** outcome resolves to
  `Verified - Exceptions`, not `No Answer` — parking it for a human rather than
  silently queueing another call on a result we did not understand.
- **A skip is a success.** The eligibility guard logs and returns; only the unmappable
  financing partner writes to Salesforce, because it is the only skip a human must
  change data to clear.
- **`finance_source` is derived from `Financing_Partner__c` alone**, not combined with
  `Financing_Type__c`, so there is exactly one field to look at when a mapping is
  wrong. Seven of the org's thirteen partner values are intentionally unmapped and will
  skip until a mapping is agreed. Partner comparison **folds dash variants**: the live
  picklist mixes an EN DASH (`Participate Prepaid Lease – Cash`) with an ASCII hyphen
  (`… - Financed`), and a literal compare would silently skip half of them.
- **Tim owns the platform event, both Flows, the Event Relay and the EventBridge rule.**
  None are built in code. `Sundial_Welcome_Call_Request__e` does not exist in the org
  yet.
- **Credentials resolve secret-first, config env-first** (`sundial/retell/api` vs. the
  three env vars). Consistent with D-045's rotation argument and with
  `docs/api-endpoints.md`'s rule that credentials never live in a Lambda env var.
- The webhook is the **second** public, non-JWT route in the API (after the Aurora
  doorbell). Both are gated solely by a shared secret in a header; both fail closed
  when the secret is unreadable.
- **New shared code: `lib/realtime.js`** — the first actual Supabase Realtime *sender*
  in the backend. The caching doc has described this broadcast since Phase 1 but no
  Lambda implemented it; `sundial-sf-update` only flags `is_stale`. It uses Supabase's
  stateless HTTP broadcast endpoint rather than a WebSocket channel, because a socket
  whose Lambda container may freeze mid-handshake is a silently dropped message.

### Related

`docs/integrations/retell-welcome-call.md` (runbook, finance table, state machine, log
format), `docs/api-endpoints.md` (`POST /webhooks/retell`, env var table),
`docs/integrations/budget-recalc-relay.md` (the platform-event relay pattern), D-045
(secret/describe TTL and rotation), D-048 (the other public webhook), D-051 (cache
deletion blind spot — part of why this read is always fresh).

### D-054 addendum (2026-08-17): call recordings are archived into the normal file convention, and rep-form orphans get a holding prefix

**Status:** Accepted, same day as D-054.

**Context.** Retell's `recording_url` expires. The base design put it in
`Welcome_Call_Log__c`, which means the link works today and 404s exactly when someone
needs it — when a customer disputes what they agreed to. And a rep-form call has no
Salesforce record to attach a recording to, sometimes not yet and sometimes not ever.

**Decision.**

1. **The recording is archived into the ordinary Sundial file convention** —
   `SUNDIAL/{customerId}/welcome-call-{YYYY-MM-DD}-attempt-{n}.mp3` in `sfsolproj`,
   with a `sundial_file_metadata` row (category `Welcome Call Recording`, uploader
   `Wattson (system)`). Not a recordings bucket, not a new prefix: the existing
   convention is what makes it appear on the portal Files tab, in XFiles Pro, and in
   the Dropbox mirror with **no additional code** (docs/file-storage.md). The date is
   **America/Phoenix** and the attempt number is in the filename, so a file is never
   dated to a day the office did not dial on and attempt 2 never clobbers attempt 1.
2. **Rep-form orphans park at `SUNDIAL/_orphan-welcome-calls/{call_id}.mp3`** with **no
   metadata row**, and the key is forwarded to the billing ledger as
   `s3_recording_key`. A new endpoint, `POST /welcome-call/orphan-match`, promotes the
   file onto a record once the Zapier sweep identifies the customer.
3. **The orphan path forwards to the ledger AFTER archiving; the attached path forwards
   before.** This inverts D-054's "ledger first, always" — for the orphan case only.

**Why.**

**The leading underscore on `_orphan-welcome-calls` is deliberate.** It is not a valid
Salesforce id, so the prefix can never collide with a record folder and XFiles Pro
never resolves a record to it.

**No metadata row for orphans.** Every file list query is scoped by `sf_record_id`. A
row with a null one is unreachable by any surface — worse than no row, because it looks
registered.

**The ordering inversion is forced, not stylistic.** For a rep-form call the ledger row
is the *only* trace of the call, and the sweep needs the recording's key. There is
nothing to put in the payload unless the upload has already happened. The key is
technically derivable from `call_id`, but a derived key cannot tell the sweep whether
the upload *succeeded*; an explicit field can, and its absence means "nothing to match".
The cost is bounded (a 20 s download cap) and the step cannot throw or skip the forward.

**Idempotency had to be built backwards, because the match operation deletes its own
input.** A retry cannot re-derive the destination key: that key embeds the holding
object's `LastModified`, and the holding object is gone. So the retry path **searches**
`SUNDIAL/{recordId}/` for `welcome-call-*-{call_id}.mp3` and reports `already_matched`.
It also re-attempts the metadata row and the log line, each a no-op when present —
without that, a run whose log append failed would have deleted the holding object and
the note could never be written.

**The destination is dated from the holding object, not from `now()`.** The sweep may
run days after the call; the file should be named for the conversation it contains.

**Consequences.**

- **A second shared-secret gate** (`X-Sundial-Zap-Secret` / `ZAP_ORPHAN_MATCH_SECRET`),
  fail-closed, credential-resolution identical to the Retell secret. The constant-time
  compare is now a shared helper so the two gates cannot drift apart.
- **`s3:DeleteObject` on `sfsolproj/SUNDIAL/*` is newly required** (orphan-match removes
  the holding object). `AmazonS3FullAccess` covers it today; it matters only if the role
  is ever tightened.
- **A failed holding-object delete is not a failed match** — the bytes are attached and
  registered. The response reports `holdingDeleted: false` and a retry cleans up.
- **`findFileMetadataByKey` added to `lib/file-access.js`.** Deterministic keys mean a
  re-run overwrites the S3 object harmlessly but would INSERT a second metadata row,
  showing the file twice in the Files tab with no way to tell the rows apart. Shared, so
  the other best-effort writers (copy-to-solar, budget snapshots, Aurora signed PDFs)
  can close the same trap.
- **Nothing accumulates in the holding prefix on its own, and there is no lifecycle
  rule** — auto-deleting an unmatched recording of a contract conversation is the wrong
  default. It needs periodic eyeballing instead.
- **The Lambda's timeout floor rises to 60 s** (Zapier retries + a 20 s download + the
  Salesforce round trips), and it now buffers a file in memory — capped at 50 MB, far
  above any real phone recording.
- The archived key is appended to the result log line as `archived=<key>`, so its
  presence in Salesforce is also the record that archival succeeded.

---

## D-055: Salesforce is the system of record for call RESULTS regardless of origin; the ledger is billing only

**Date:** 2026-08-19
**Status:** Accepted
**Extends:** D-054

### Context

Welcome Calls arrive two ways. A Salesforce-initiated call carries `sf_record_id` in
its Retell metadata and writes its result back to the customer. A **rep-form** call —
started by a rep for a customer who may not exist in Salesforce yet — carries no record
id, so the webhook parks its recording and forwards the payload to the Zapier billing
ledger, and that was the end of it.

The orphan sweep then attached the audio and wrote one line: `rep-form call <id>
matched, recording attached`. It said a call happened and nothing about what was said.

The first three live calls were **all** rep-form. So in practice the analysis Harmon
actually needs — which contract values the customer disputed, what they asked for,
whether identity was confirmed — existed only in a Zapier ledger built for billing.
Anyone asking "what went wrong on this call?" had to leave Salesforce to find out, and
the answer lived in a system nobody in operations opens.

### Decision

**Salesforce holds the result of every Welcome Call, however it started.** The Zapier
ledger is for billing and stays exactly as it was — it still receives every call. This
is additive on the Salesforce side.

1. **`POST /welcome-call/orphan-match` backfills the full result.** It re-reads the
   call from Retell (`GET /v2/get-call/{call_id}`) rather than having Zapier re-send
   the analysis: same data, same authority the webhook used, and no new contract with
   Zapier.
2. **One formatter, both origins.** `mapOutcomeToStatus` and `buildResultLogEntry` are
   shared, so a backfilled entry and a webhook-written entry are structurally identical
   — only the origin segment and the recording filename differ. A test asserts this
   byte-for-byte. A reader, or an email alert merging the field, must never have to
   know which path produced an entry.
3. **A terminal status is never overwritten by a backfill.** A rep-form call is a
   second conversation with a customer whose verification may already be settled, and a
   sweep running days later must not reopen it. The entry is still appended, marked so
   the reader can see why the status doesn't match that line's result. `Calling` is
   explicitly NOT terminal — it means a call is in flight, not that a result exists.
4. **`Welcome_Call_Attempts__c` is never incremented by a backfill.** That counter is
   the retry ceiling for Salesforce-initiated dials; counting a rep-form call against
   it would silently consume a customer's retry budget.
5. **Nothing from a call is truncated.** Segments were clipped at 200/300/400 chars to
   protect a 32k field. That traded away the wrong thing: this text is merged into
   email alerts and read by a human deciding what went wrong, and a mismatch
   description cut at 200 characters is exactly the half they needed. Entries are now
   multi-line blocks carrying every analysis field in full.
6. **Capacity is read from the describe, never hardcoded**, and overflow drops WHOLE
   OLDEST ENTRIES with a visible `… older entries trimmed …` marker. Character-level
   clipping could leave a header with no analysis under it, or analysis lines with no
   header naming the call — both worse than a missing entry, because they read as real
   data.

### Consequences

- The sweep now depends on Retell being reachable. It degrades rather than fails: the
  recording is attached first, and an unreachable Retell falls back to the old one-line
  note without inventing a status from a call it could not read.
- One extra Retell API call per swept call. Negligible against the sweep's daily cadence.
- Entries are ~1 kB instead of ~300 chars, so a 32,768-char field holds roughly 30 of
  them before trimming (and ~130 once the field is raised to 131,072). Trimming is now
  a normal, marked event rather than a pathological one.
- The log format changed. Anything parsing it — an email template, a report formula —
  should key on the `── ` marker and the `Label: value` lines rather than the old
  ` · `-delimited single line.

### Related

`docs/integrations/retell-welcome-call.md` (backfill flow, entry format, capacity),
D-054 (the trigger and ledger-first fan-out), `lambdas/sundial-welcome-call/`.

---

## D-056: @-mention alerts are triggered by the database, and user preferences live in their own table

**Date:** 2026-08-18
**Status:** Accepted

### Context

Comments are **not a backend feature**. harmon-crm's `CommentThread.tsx` inserts into
`comments` and then into `comment_mentions` **directly from the browser** under RLS.
There is no server anywhere in that path, no Lambda, and no code in this repo. The
mention insert is explicitly best-effort in that component.

Two things then had to be decided to add email alerts:

1. **Who fires the notification** — the client that already writes the mention, or
   something server-side.
2. **Where the "email me on mentions" toggle is stored.** The obvious home is
   `public.profiles`, which already has a row per user.

### Decision

1. **An `AFTER INSERT` trigger on `comment_mentions` posts to a Lambda via `pg_net`**
   (`sql/sundial_comment_mention_notify.sql` → `POST /webhooks/comment-mention` →
   `sundial-comment-notify`). The client is not involved.
2. **Preferences live in a new `user_preferences` table**, not on `profiles`.
3. The trigger **can never block or fail the insert**, and the Lambda treats every
   business reason not to send as a **success**.
4. Idempotency is a `notified_at` column on `comment_mentions`, stamped **only after a
   successful send**.

### Why the database and not the client

**Because the person who loses the notification is not the person who caused it.** A
client-driven alert dies with the tab: close it, navigate away, or drop the network a
second after posting, and *somebody else's* notification is silently gone. Neither
party ever finds out. The mention insert is already best-effort for the same structural
reason, and that was tolerable when the only consequence was a missing highlight in the
UI — it is not tolerable when the consequence is a colleague never learning they were
asked a question.

Once the mention row is **committed**, the notification becomes the database's problem,
and a database cannot navigate away.

Three alternatives were rejected:

- **Have the client call the Lambda.** Same failure mode, plus it would need the client
  to hold a shared secret, or the route to accept a portal JWT and then re-derive
  everything it was told — at which point it may as well read the row itself.
- **Poll for unnotified mentions on a schedule.** Works, but adds a scheduled Lambda and
  a minutes-long delay to something that should feel immediate, to solve a problem the
  trigger solves at insert time.
- **A Supabase Dashboard Database Webhook.** Two clicks, same behaviour, and it lives
  nowhere in this repo. **We were already burned once by a load-bearing untracked
  dashboard setting** (the Supabase auth email templates). A SQL file is reviewable,
  diffable, and re-runnable; a dashboard toggle is none of those.

`pg_net` posts **after the transaction commits** (its worker drains a transactional
queue), which is both what makes the call non-blocking and what guarantees the Lambda
can read the row it was told about.

### Why preferences are their own table

`profiles` is **server-owned**. `sundial-auth-proxy` upserts `tenant_id` / `role` /
`email` into it on every `/auth/me`, and RLS on the cache tables resolves tenancy from
it. It is the row that decides what data a session can see.

The toggle is self-serve — written straight from the browser, like the comments
themselves. Putting it on `profiles` therefore means granting the client `UPDATE` on
that row, and **Postgres RLS is row-level, not column-level**: a policy that permits
"update your preferences" permits `update profiles set tenant_id = '<another client>',
role = 'admin'` in the same statement. That is privilege escalation and a
tenant-isolation break in one, and no amount of client-side care closes it, because in
that threat model the client *is* the attacker.

Column-level `GRANT`s can narrow it, but they are a second, independent mechanism that
must stay in sync with the policy forever, and a future column added to `profiles` is
writable-by-default under that scheme unless someone remembers. A separate table has no
such edge to keep sharp: **every column in `user_preferences` is safe for its owner to
write**, and the worst a malicious user can do is turn off their own alerts.

### Why absence means "alerts on", with no backfill

Every existing user has no row, and that is the intended steady state for anyone who
never opens Settings. **Reading a missing row as `comment_email_alerts = true`** means
nobody has to opt in to keep working the way they do today. Backfilling rows would
create a row per user to encode the default that the *absence* already encodes, and
would then need re-running for every new user.

The cost is that the default lives in two readers (the Lambda and the Settings page)
rather than in the schema. That is stated in the migration header, in the runbook, and
pinned by a test named for it.

### Consequences

- **A third public, non-JWT route.** Same discipline as the Aurora doorbell and the
  Retell webhook: a shared secret in a header, constant-time compared, failing closed
  when unreadable. `constantTimeEquals` moved to **`lib/secure-compare.js`** so all three
  gates share one comparison and none can drift into a `===`.
- **The URL and secret are database settings** (`sundial.comment_notify_url`,
  `sundial.comment_notify_secret`), not literals in the migration — so the file is safe
  to commit and the secret rotates without a repo edit. They are set with
  `ALTER DATABASE ... SET`, which **applies to new connections only**. An unset setting
  makes the trigger `RAISE WARNING` on every mention rather than no-op silently, because
  a quiet notification path is exactly the kind that rots unnoticed.
- **Vault was not used**, though it is the better home for a secret. It is a second
  extension dependency and its read path inside a `SECURITY DEFINER` trigger is fiddlier;
  the exposure is bounded because a database setting is readable by the `postgres`
  superuser role, which can already read every comment directly. Swapping to vault is a
  change to one function.
- **The feature ships before SES.** `EMAIL_FROM` is unset everywhere today, so the
  Lambda returns `email_not_configured` as a degraded success (mirroring the Design
  Request email). Because nothing stamps `notified_at` on a skip, the backlog is
  replayable once SES lands.
- **`'list'` is stored, not `'table'`.** harmon-crm's `ViewMode` union happens to be
  `'table' | 'board'`, but that is a detail of one component. The stored value is the
  cross-repo contract and matches the user-facing word; harmon-crm maps it in one place.
  Renaming a React type must never require a data migration.
- **An unknown `record_object` links to `/dashboard`**, never a guessed path. A 404 from
  a notification email reads as "the portal is broken", and the reader cannot tell that
  apart from "we don't support that link yet". The Service module gets one entry in
  `RECORD_PATHS` when it lands.
- **A tenant guard was added beyond the specified skip list.** This path emails a
  comment body, so a cross-tenant mention would be a data leak nobody ever sees. It
  skips only when both tenants are known and differ, so a user who has never hit
  `/auth/me` still gets their alerts.
- **Deploy order is load-bearing:** wire and verify the route *before* applying the
  trigger migration. The trigger swallows post failures by design, so an unwired route
  loses notifications silently.

### Related

`docs/integrations/comment-mention-alerts.md` (runbook), `docs/api-endpoints.md`
(`POST /webhooks/comment-mention`, env vars), `sql/sundial_user_preferences.sql`,
`sql/sundial_comment_mention_notify.sql`, D-043 (the access model `profiles` backs),
D-045 (secret TTL / rotation), D-046 and D-052 (the auth-email templates that were the
untracked dashboard state this decision avoids repeating), D-054 (the previous public
webhook and its fail-closed gate).

### Amendment (2026-08-19): trigger config lives in `private.app_config`, not database settings

The original decision put the notification URL and shared secret in **database
settings** (`alter database postgres set sundial.*`, read with `current_setting()`).
**That is impossible on managed Supabase** and the first apply proved it:

```
ERROR: 42501: permission denied to set parameter "sundial.comment_notify_url"
```

Setting a custom parameter at database scope requires superuser or database ownership.
Supabase's `postgres` role is not a superuser and `supabase_admin` owns the database.
It is not grantable, so there is no request to make — the option simply does not exist
on this platform. The original reasoning (settings vs. Vault) was sound in the abstract
and irrelevant in practice, and has been removed from the SQL file rather than left to
mislead.

**Replacement:** a `private.app_config (key, value, updated_at)` table read by the
`SECURITY DEFINER` trigger function.

- `private` is **not** in PostgREST's exposed-schema list and must stay out of it —
  adding it would publish the table, secret included, to the REST API.
- RLS enabled with **no policies** (deny by default), plus an explicit `revoke all`
  from `anon` and `authenticated`. Two independent locks, because either alone is a
  single point of failure for a table holding a shared secret.
- The function reads it because `SECURITY DEFINER` runs as the table owner and an owner
  bypasses RLS. The table is therefore deliberately **not** `force row level security`,
  which would apply RLS to the owner too and silently break every notification.
- Reads are **schema-qualified** (`private.app_config`) and `private` is **not** added
  to the function's `set search_path`. Widening a `SECURITY DEFINER` function's
  search_path is exactly what that hardening prevents.

**Explicitly rejected:** `alter role authenticator set sundial.*`. It may work today,
it depends on Supabase internals, and a notification path that silently stops working
after a platform change is the failure mode this design avoids everywhere else. A
config mechanism that is *documented* to be unavailable is better than one that
*happens* to work.

**Incidental improvement:** the old approach applied to new connections only, so a
pooled deployment could take a minute to see a change. A table read per invocation
takes effect immediately — which also makes "pause notifications during a mail
incident" (`delete from private.app_config where key = 'comment_notify_url'`) actually
instant.

**Generalises beyond this feature:** any future `SECURITY DEFINER` function on Supabase
needing server-side config should use `private.app_config` rather than rediscovering
this. That is the reason it is a shared table with a generic name and not
`private.comment_notify_config`.

## D-057: Both commission POs are raised on the first budget push; the milestone dates are cargo, not gates

**Date:** 2026-08-24
**Status:** Accepted
**Cross-reference:** D22/D23 in `docs/integrations/acumatica-budget-rework-v2.md` (that
document keeps its own D-number series for budget-rework decisions; this is the ADR).

### Context

§6 of the budget rework described the two dealer commission purchase orders as firing at
milestones — M1 "at Site Audit Complete", M2 "at Glass on Roof". Read that way, the engine
needed to know *which Salesforce field means each milestone* before it could run at all,
and neither existed under those names. That became Q13, and it blocked the PO engine
alongside the missing §4f write-back fields.

Two describes and a live probe turned out to be answering the wrong question.

### Decision

1. **Both POs are created on the first budget push**, and updated by every later push
   until Acumatica freezes them. Nothing waits on a date. A job with neither milestone
   date set still gets both POs.
2. **The two dates are what each PO carries, not when it is raised.**
   `Audit_Date_and_DateTime__c` → M1, `Scheduled_Install_Date__c` → M2 — the same two
   fields that already feed the `AUDITDATE` and `INCOMDATE` Acumatica attributes.
3. They are written to the PO **line's `Requested` and `Promised`** (both, because the
   specimen keeps them equal). **A blank date sends nothing**, and never clears a date
   already on the PO.
4. **`Terms` is recorded, not asserted.** It came out of `SPECIMEN_DEFAULTS`.

### Why the workflow reading mattered more than the field names

Had the trigger design been implemented, it would have been implemented correctly against
a description of a process Harmon does not follow — and the failure mode is silent. A
dealer's M1 would simply never be raised on any job where the audit date field was not the
one we picked, and nothing anywhere would say so; the record would look normal, the budget
would look normal, and the first symptom would be a dealer asking where their money was.
Reading `Days_to_Glass_on_Roof__c`'s formula, which is what Q13 asked for, would have
produced a confident wrong answer faster.

The engine already did the right thing. `planMilestone()` has always keyed on "is there a
stored OrderNbr" and never on a date. Closing Q13 was therefore mostly a **deletion** — of
a trigger design that was never built — plus the date wiring above.

### Why the dates go on Requested/Promised despite the specimen

A live probe (`scripts/probe-po-date-fields.mjs`, 2026-08-24) found the header exposes
`Date` / `PromisedOn` and the line `Requested` / `Promised`. On specimen PO 016102 all four
equal the order date, and the same is true of the hand-proof PO — because nobody typing a
PO by hand changes them. **So the specimen records the default, not a preference**, and it
cannot tell us what Harmon wants there.

Carrying the milestone date makes the document say when the payment is actually expected,
which is what those fields are for. The two guards are what make it safe rather than a
silent divergence: a blank date reproduces the specimen exactly, and a date we do send is
**verified on re-read** as something we asked for rather than accepted as derived — so if
Acumatica ignores or rewrites it, we find out on the create instead of never.

### Why `Terms` stopped being a verified specimen value

The specimen (vendor 02118) has `Terms: 30D`. The hand-proof PO on vendor 01736 came back
`DOR`. **Both are right** — Terms derives from the vendor's payment terms, so it is a fact
about whoever is being paid, not a constant of "a commission PO".

Left as it was, `verifyCommissionPo` would have rejected a perfectly good Blue Sky Solar
purchase order on the first live job, reported it as a specimen mismatch, and pointed
whoever investigated at entirely the wrong thing. The D4 map has 35 resolvable dealers and
they will not share payment terms.

The distinction now drawn: a derived value is **asserted** when it is a property of the
document (Branch, CurrencyID, Location, Type, and the whole line-level set including
Account and Subaccount) and **recorded** when it is a property of the vendor (Terms). This
is the same lesson as the earlier `Status` mistake — asserting mutable or
externally-owned state under a message about the specimen — arrived at from live evidence
rather than in review.

### Consequence for the write-back

Storing the OrderNbr is now possible (the §4f fields are approved and packaged), so
`syncCommissionPos()` exists. **Its write ORDER is load-bearing:** M1's number is persisted
before M2 is attempted, so an M2 failure — or a Lambda dying between the two — cannot lose
the fact that M1 was raised. Batching all eight fields into one update at the end would be
neater code and a duplicate payment the first time anything went wrong halfway.

`PO_GATE.enabled` stays `false`. The remaining blocker is the hand-proof, whose duplicate
check and freeze test did not land on 2026-08-24 — see the runbook's §Results.

## D-058: The Acumatica secret is a pointer, not a tenant — and no doc may name the tenant it holds

**Date:** 2026-08-24
**Status:** Accepted

### Context

Two hand-proof runbooks each opened with a mandatory "prove which tenant you are on" step.
Both called `GET /entity/Default/25.200.001/Company`, which does not exist — it returns
`Entity Company not found` — so neither step had ever run, and neither run could certify
where its writes had landed. One of those runbooks creates purchase orders.

Chasing that turned up a second, worse problem. `acumatica-budget-push.md` described
`sundial/acumatica/connected-app` as the **sandbox**; §1 of `acumatica-budget-rework-v2.md`
described the same secret as **"(live-tenant)"**. Both were written in good faith and both
were wrong in the same way.

### Decision

1. **`sundial/acumatica/connected-app` is a POINTER whose contents change** — it holds
   BizRun (the sandbox) through the rework and is repointed at live at the end of the
   release window. **No document may describe it as "the live secret" or "the sandbox
   secret."**
2. **The tenant is read from the credential**, because Acumatica suffixes the ROPC
   `client_id` with the tenant the grant is scoped to: `client_id.Split('@')[-1]`.
   `BizRun Tenant` is the sandbox.
3. **Every runbook's step 2 uses that check, and says why it is not skippable** — the
   answer changes over the life of the project, so "I saw it pass last time" is not
   evidence.

### Why the pointer is right and naming the tenant is wrong

The repointing is the feature: at cutover, nothing in the repo, no Lambda environment
variable and no runbook needs editing. That is exactly why a doc that names the tenant is
dangerous rather than merely inaccurate — **it goes stale silently.** Nothing fails, no
test goes red, and the sentence keeps reading as authoritative while quietly describing
last quarter's configuration. The two contradictory descriptions were not a mistake anyone
made; they were the predictable result of writing down a moving value.

Reading the tenant from the credential has the opposite property: it cannot disagree with
reality, because it *is* the thing that determines reality. A grant scoped to BizRun cannot
write to live no matter what any document says.

### Consequence

Both 2026-08-24 hand-proof runs are retroactively certified — BizRun, confirmed in both
UIs. The check itself moves from "a formality at the top of a runbook" to the one step that
cannot be skipped, and it is now one line instead of a call to a nonexistent entity.

## D-059: Attribute writes are verified by re-read, and match Harmon's number formatting

**Date:** 2026-08-24
**Status:** Accepted
**Cross-reference:** D24 in `docs/integrations/acumatica-budget-rework-v2.md`;
`acumatica-attribute-sync-runbook.md` §Results.

### Context

The attribute hand-proof answered its one dangerous question — a partial `Attributes` PUT
**merges**, so the omit-blanks builder is safe as designed. It also turned up two things
nobody had asked about.

### Decision

1. **The sync verifies every write by re-reading** (`verifyAttributeWrite`), separating
   `missing` from `mismatched`, and **comparing dates by date part**.
2. **Numbers match Harmon's existing convention** (`ATTRIBUTE_DECIMALS`): money to two
   decimals, `KW` to three. Per-attribute, not one rule for all numbers.
3. **The silent-200 is documented as a standing hazard**, not a finding.
4. **On integration-managed jobs the sync is authoritative** and overwrites hand-entered
   commission attributes. Intended; **flagged to Harmon as a behaviour change** rather than
   left to be discovered.

### Why verification is mandatory here rather than prudent

An unknown `AttributeID` returns **200 and is silently discarded** — proved with
`NOTAREALATTR`. Combined with the merge behaviour, the failure mode is invisible: if a
template change ever drops an attribute, the sync keeps sending it, keeps getting 200, and
that value simply stops updating. No error, no log line, no red test — just a reporting
field that quietly stopped tracking reality, discovered whenever someone next reconciles a
commission by hand. A status code cannot distinguish "written" from "thrown away"; only a
re-read can.

This is the same conclusion as the referral line and the commission PO, reached from the
same premise, and it is worth noting that all three arrived independently: **an HTTP 200
from Acumatica is an acknowledgement of receipt, not evidence of effect.**

### Why the date comparison is load-bearing, not lenient

We send `2026-07-14`; Acumatica echoes `2026-07-14 00:00:00.000`. A strict string
comparison would report **all five** lifecycle dates as failed writes on **every single
run**. The practical consequence is not noise, it is abandonment — a verification that
always fires gets ignored, then switched off, and the check that was meant to catch the
silent discard catches nothing because nobody reads it any more. Being right about dates is
what makes the rest of the verification survivable.

### Why formatting was Harmon's call and not a tidy-up

Attributes are string-valued and Acumatica stores exactly what it is given, so `String(2500)`
really does land in a reporting field as `2500` beside a hand-entered `1538.00`. That is a
formatting difference, not a rounding one, and which one is *correct* depends on whether
Harmon's reporting parses the string or displays it — a fact about their reports, not about
our code. Harmon ruled: match what is already there. Note the convention is not uniform
(money 2, KW 3), which is why the implementation is a per-attribute map rather than a single
`toFixed(2)`.

### The hand-entered values, and why they are recorded

`R261065` carried `SLSCOM1 = 1538.00` / `SLSCOM2 = 2138.00` — a total matching neither the
third-party rule nor the internal 75/25 one, while the manager and overhead pairs checked
out to the cent. Harmon confirmed these are hand-entered today.

Two things follow. It is direct evidence that the omit-blanks rule and the merge answer
matter — those are precisely the fields a REPLACE would have wiped, and they demonstrably
contain values no rule in this repo produces. And it makes the authority question real
rather than theoretical: once the sync runs on a job, it wins. That is the right design, and
it is the kind of change that generates a support call if the first person to notice is
whoever typed the old number.

## D-060: Both Acumatica write gates open; the PO freeze rule is the only freeze there is

**Date:** 2026-08-24
**Status:** Accepted
**Supersedes in part:** the gated-off status of D22/D24.

### Context

Three things had to be true before the commission PO engine could raise a real purchase
order: the §4f write-back fields deployed with FLS, the milestone dates named (D23), and
the sandbox hand-proof clean. The first two landed earlier the same day. The hand-proof was
re-run, and the attribute sync's own hand-proof had already come back MERGE (D24).

### Decision

1. **`PO_GATE.enabled = true`** — the commission PO engine raises real purchase orders.
2. **`ATTR_GATE.enabled = true`** — the attribute sync writes real project attributes.
3. **Both stages are wired into the budget push worker**, after a successful budget write,
   in `runDownstreamStages`.
4. **A downstream failure does not fail the budget push**, but is never silent.
5. Both gates remain repo constants with tests pinning the committed value, so **closing
   them is also a reviewed diff.**

### The finding that matters most: Acumatica does not enforce the freeze

Step 8 of the re-run put a PUT into a **Canceled** purchase order. It returned **200 and
the change persisted.**

`UPDATABLE_STATUSES` is therefore not the integration agreeing with a rule the ERP
enforces. **It is the entire rule.** Nothing else, at any layer, prevents a silent edit to
a released document that somebody downstream has already worked from. Three consequences,
all now in code:

- The check is **deny-by-default** — `!UPDATABLE_STATUSES.includes(status)` — so an
  unrecognised, empty, null or absent status is frozen. A future Acumatica release adding
  a status we have never heard of fails safe rather than open.
- Tests assert it is unbypassable, including the "no `Status` field at all" response shape
  and casing variants, because the allow-list is case-sensitive.
- **Only `Canceled` was tested.** `Completed` and `Closed` were not, and the decision is
  that this does not matter: every status off the allow-list is never-touch whether or not
  the API happens to refuse it. We do not want the code's safety to depend on which
  statuses somebody got round to probing.

**A spelling bug surfaced while pinning this.** Acumatica returns `Canceled`, one L;
`FROZEN_STATUSES` said `Cancelled` and had never matched anything. It was harmless *only*
because that list is documentation and the guard is the allow-list. Had anyone ever written
the guard the tidier-looking way — `FROZEN_STATUSES.includes(status)` — a canceled PO would
have sailed through it. That is the argument for deny-by-default stated as a near miss
rather than a principle.

### What was NOT proven, and why the gate opened anyway

**Step 7's duplicate probe is buggy.** Both runs returned 28 — the vendor's entire PO
history on that project — so the description-scoped filter is not comparing what it claims.
Ruled a runbook defect to fix separately rather than a gate blocker, on three grounds:
idempotency in the engine is the **stored OrderNbr and never a scan**, so the probe does not
measure what the engine relies on; the first run's guid and OrderNbr were unchanged across
an update that moved the amount; and the behaviour is covered by tests.

That reasoning is sound and it is still **an accepted residual risk rather than a proven
negative.** Recording it as such is the point: the first-live-job watch — *exactly one PO
per milestone per project, ever* — is not boilerplate, it is the compensating control for
the one check that never ran. If a project grows a second M1, close `PO_GATE` before
anything else.

### Why a downstream failure leaves the budget push "Pushed"

The budget lines are written. Reporting that as `Failed` would be untrue, would leave
`Budget_Finalized__c` false, and would make the next re-push redo work that had succeeded.
The PO stage also owns its own reporting — `Commission_PO_Status__c` /
`Commission_PO_Error__c` exist precisely so a refusal is not a log line nobody reads.

So the status stays `Pushed` and the problem still surfaces, through a note on
`Budget_Push_Error__c`. **`Pushed` with a non-null error is a deliberate combination**
meaning exactly what it says: the budget pushed, and something after it needs a human.

Two supporting rules. An **internal deal or a zero commission is not a problem** — the PO
engine has already recorded `None`, and surfacing that as a push failure would train people
to ignore the field. And **neither stage may throw past `runDownstreamStages`**: an escaping
exception would land in the worker's catch and mark a genuinely successful budget push as
failed.

### Known gap accepted at ship

The attribute stage has **no status/error fields of its own** — only the §4f PO fields were
deployed — so a failed attribute verification lives in the shared note and in CloudWatch.
That is thinner than the PO side and is the next field package. It is recorded here rather
than left implicit because it is the same weakness the §4f document argued against, and
shipping it knowingly is a different thing from shipping it by accident.

## D-061: An attribute-only sync path, gated on nothing but a linked Acumatica project

**Date:** 2026-08-24
**Status:** Accepted
**Cross-reference:** D26 in `docs/integrations/acumatica-budget-rework-v2.md`.

### Context

Harmon has projects that will never go through the budget push: jobs predating the
integration, jobs budgeted by hand, jobs calculated by the v1 engine. Their Acumatica
attributes — the lifecycle dates and system size — still need to be current, because that
is what the accounting reporting reads. The budget push cannot serve them: every one of its
gates would refuse, correctly.

### Decision

1. **A new mode on the budget-push Lambda**, not a new function:
   `POST /projects/{recordId}/budget/attributes-sync` plus a direct-invoke equivalent.
2. **The only gate is a linked `Acumatica_Project_ID__c`.**
3. **It writes `NON_COMMISSION_ATTRIBUTES` only** — five dates, `KW`, `SALESPERSO`.
4. **Synchronous**, not the async self-invoke the budget push uses.
5. **Verify-by-re-read is mandatory**, exactly as on the push path.
6. **No gate constant.** It writes only attributes, the proven-safe mechanic.

### Why the push's gates are the wrong gates here

`Budget_Calc_Status__c = 'Calculated'` and the `Commission_Deal_Type__c` v2-rollout guard
both exist to stop a **wrong budget** being posted. This path posts no budget, so neither
protects anything — and both would fire on exactly the records the path exists to serve,
because a legacy record legitimately has a blank calc status and a blank deal type. Reusing
them out of consistency would have produced a feature that refuses its own use case.

The one gate that survives is the one that is about capability rather than correctness:
without a project id there is nothing to write to.

### Why the commission attributes are excluded, and why that needed three mechanisms

Legacy projects carry commission attributes **Harmon typed in**. `R261065` held
`SLSCOM1 = 1538.00` / `SLSCOM2 = 2138.00` — a total matching neither the third-party rule
(1,838) nor the internal 75/25 one (2,757), while the manager and overhead pairs checked out
to the cent. That is what hand-entry looks like, and it is the strongest argument against
letting a path that knows nothing about a job write numbers onto it.

Three independent things prevent it:

1. **Scope** — the commission attributes never enter the request body. The filter lives
   inside `buildProjectAttributes` via `opts.only`, so the restriction travels with the
   build rather than depending on each caller remembering it.
2. **Merge** — a partial `Attributes` PUT leaves what it did not send alone (D24).
3. **Omit-blanks** — a field with no value is omitted, not sent as `""`.

Any one would be sufficient. Specifying all three is not belt-and-braces theatre: they fail
in different ways. Scope fails if someone adds an id to a list; merge fails if Acumatica
changes semantics; omit-blanks fails if someone "helpfully" normalises blanks to empty
strings. Depending on one would make an unrelated future edit capable of overwriting
Harmon's data.

`JOBTYPE` is excluded for a different reason — RS vs RSDC is authoritative at Layer-1
creation and nothing here can do better than infer it. Inference is not authority.

### Why synchronous, when the budget push is not

The budget push self-invokes because it writes ~20 budget lines with retries and can
genuinely approach API Gateway's ~29s cap. This does one SOQL, one Acumatica read, one PUT,
one verifying re-read and one Salesforce update. Async would buy nothing and cost the caller
an immediate answer, forcing a UI to poll a status field to learn what a single PUT did.

The inconsistency is deliberate and worth naming, because "match the neighbouring route" is
otherwise a reasonable instinct. If this ever grows — batching many records, say — the
worker pattern next door is the template.

### Why no gate constant

`CREATE_GATE`, `PO_GATE` and `ATTR_GATE` each guarded a write mechanic that had never been
proved: creating a budget line, raising a purchase order, writing attributes at all. This
path uses a mechanic that is now hand-proved and running in production, on a strictly
smaller attribute set, with a strictly smaller blast radius. A fourth gate would be
ceremony — and `ATTR_GATE` already stops this path too, since it runs through the same
`syncProjectAttributes`.

Verification, by contrast, is **not** ceremony and stays mandatory: the silent-200 hazard is
a property of the API, not of the caller, and it is exactly as true here.

### Closing the D-060 gap, deliberately, as part of this

D-060 shipped the attribute stage knowing it had nowhere of its own to report. A second
writer made that untenable — the attribute-only path has no budget push to borrow an error
field from — so the deferred package is built here:
`Attribute_Sync_Status__c` / `Attribute_Sync_Error__c` / `Attribute_Synced_At__c`.

**Both paths write them from one function** (`buildAttributeSyncWriteback`). Two callers
each building their own field map would eventually disagree about the same outcome, and a
status field two systems disagree about is worse than no status field.

Two details that are decisions rather than defaults: `Unverified` is a separate value from
`Failed`, because a write that may have partly happened needs a different response from one
that did not happen — collapsing them would hide the case the verification exists to
surface. And `Attribute_Synced_At__c` means *last known good* and does not move on a failed
run, so a stale record cannot look fresh because we tried and could not.


---

## D-062: Storage is priced as an adder outside the redline, and per-watt prices above $10/W are a hard error

**Date:** 2026-08-24 · **Decided by:** Tim
**Amends:** D19 (the redline commission model) as recorded in
`docs/integrations/acumatica-budget-rework-v2.md` — see **D27** and **D28** in that doc's
decision table, and §4h / §4j for the implementation. Recorded here because it changes what
a rep is paid.

### Storage is an adder (D27)

Batteries and Tesla expansion packs are sold **outside** the `Redline × watts` model.
Nothing in `Redline × watts` accounts for them, so unless their price is deducted from the
commission base the rep is paid commission on the full battery revenue as though it were
margin. It was not being deducted anywhere: **every battery deal's commission was overpaid
by the full battery + expansion price.**

Two terms are added to the `Total_Adder_Price__c` formula on both objects:

| Object | Battery | Expansion pack |
|---|---|---|
| `Sundial_Customer__c` | `Battery_Unit_Price__c × Battery_Qty__c` | `Tesla_Expansion_Pack_Unit_Price__c × Tesla_Expansion_Pack_Qty__c` |
| `Sundial_Solar__c` | `Battery_Unit_Price__c × Battery_Qty__c` | `Tesla_Expansion_Pack_Unit_Price__c × **Gateway_Qty__c**` |

**The mismatched Solar pair is the decision, not an accident.** `Gateway_*` IS the Tesla
expansion pack on Solar — the group was reused for it, its label reads "Tesla Expansion Pack
Qty", `budgetCalc` reads `Gateway_Qty__c`, and the Create Project map writes it. Solar's
`Tesla_Expansion_Pack_Quantity__c` (note `_Quantity__c`, not `_Qty__c`) is an orphan that
nothing maintains. Renaming the pair into agreement would repoint the formula at a
permanently blank field and price every expansion pack at **zero**, so the mismatch is
documented and asserted rather than tidied.

**Three places have to agree** — the Salesforce formula, `budgetCalc.js`, and the fixture —
because the documented joint of the budget fixture is that the workbook and the formula land
on the same adder total. The Lambda change is **price-side only**; the cost side was already
complete and adding cost there would double-count.

**Existing records needed a backfill, and that is not a detail.** A Salesforce field default
only applies to records created after the field existed, so every pre-existing
battery/expansion record had a null price — and a null price contributes 0. The formula
change alone fixes nothing for history. 29 records were backfilled (null-only, never
overwriting a human-entered price), **before** the formula deploy, so the commission shift
lands atomically rather than record by record.

### Per-watt prices above $10/W are an ERROR (D28)

The four per-watt adder prices multiply by **watts**. A flat dollar total typed into one is
not a rounding error, it is a factor-of-thousands error — and it is the root cause of the
$2.5M incident on `a1P7y00000AlufJEAR`, where a flat amount sat in
`Adder_Roof_Tile_Price__c`. **The formula was right; the data was wrong.**

`budgetCalc` now throws `BudgetInputError` / `PPW_PRICE_IMPLAUSIBLE` naming the field and
the value, before any adder maths runs, gated on the price alone rather than on quantity.

**Deliberately an error rather than a warning**, which is where this differs from the Aurora
escalation-fraction case it is otherwise modelled on. There the ambiguity is genuine and the
value is merely suspicious, so a warning is honest. Here a recalc that carried on would post
a commission nobody can defend — refusing is the correct answer, and the fix is always on the
record rather than in the code.

The guard covers all four fields even though they span two lists in the calc
(`Bird_Blocking` is a SUBCON adder with `priceKind: 'ppw'`). Deriving the list from
`PPW_ADDERS` alone would have left `Bird_Blocking` unguarded — the one shape of this bug the
guard must not miss.


---

## D-063: Salesforce Percent fields have THREE domains — metadata defaults are decimal, the API is display, formulas are decimal

**Date:** 2026-08-24 · **Decided by:** Tim (root-caused), measured empirically
**Recorded here because this WILL recur on the next Percent field anyone creates.**

### The finding

Salesforce does not use one representation for a Percent field. It uses three, and they do
not agree. These rows were **measured on a live record** by
`scripts/probe-percent-field-domain.mjs` — written through `sfUpdateRecord`, read back raw,
and cross-checked against a dependent formula field — not taken from documentation:

| Layer | Domain | A true **25%** is |
|---|---|---|
| metadata `<defaultValue>` | **decimal** | `0.25` |
| REST API / SOQL, read *and* write | **display** | `25` |
| formula field referencing it | **decimal** | `0.25` |

### What went wrong

`<defaultValue>25</defaultValue>` is a formula expression evaluated in the decimal domain,
so it never meant 25%. It meant **2500%**, and every record created since carried a stored
API value of `2500`. **Setup renders the default expression back as `"25"`**, so the bug is
invisible in the UI — which is the part that makes it worth an ADR rather than a code
comment.

The formula domain is the same trap wearing different clothes: `Markup/100` inside a
formula divides a value that has *already* been divided. `Total_Adder_Price__c` had exactly
that.

### Why it survived: two errors cancelled

| | data `2500` | data `25` (correct) |
|---|---|---|
| **formula `/100`** (old) | `1.25` ✔ *by accident* | `1.0025` ✗ |
| **formula no `/100`** (new) | `26` ✗ | `1.25` ✔ |

The only correct cell is the bottom-right, and reaching it requires changing both. Fixing
either alone is worse than fixing neither — which is why the data fix and the formula
package are a pair, and why the data fix runs **first** (its window understates a deduction;
the other direction is a 26x multiplier).

### The rules that follow

1. **A Percent field's `<defaultValue>` is written as a decimal.** 25% is `0.25`.
2. **REST/SOQL is the display domain.** Code reading Salesforce through the API divides by
   100 itself — `budgetCalc.js` does, and that is correct.
3. **A Salesforce formula must NOT divide by 100.** It already received the decimal.
4. **Points 2 and 3 look inconsistent and are not.** Do not "align" them. Both land on the
   same multiplier because they start from different domains.
5. **Assert the domain in tests, in the units of the layer being tested.** `verify.mjs`
   evaluates formula text so it uses `0.25`; `lambdas/sundial-budget/test.js` feeds the calc
   through the REST domain so it uses `25`. The literals differ on purpose.
6. **Measure, do not reason.** Tim's report of "`25` saved, `.25` read back" did not fit the
   2500 theory and would have been easy to dismiss. It was real — it was the formula domain
   — and probing settled in one run what argument would not have.

### Blast radius, for the record

Nil, and worth stating so the severity is not overstated later. Only **7 records** carried
`2500`, all `Sundial_Customer__c`, and **all had zero NS material cost** — the markup
multiplied nothing. Org-wide only 5 records have any NS material at all. This was a loaded
gun, not a wound: the first person to enter a material cost on one of those records would
have posted a 26x markup through budgetCalc.

Guarded going forward by `NS_MARKUP_IMPLAUSIBLE` (>100%), the same shape as
`PPW_PRICE_IMPLAUSIBLE` in D-062.

### Two incidental fixes this uncovered

- **The MODIFY generator was not idempotent.** `v2-field-alignments` re-reads live labels
  and applies a delta, but its `225 Upgrade` relabel used a blind `.replace()`. Regenerating
  against an org where it had already deployed produced `225 Upgrade-Overhead-Overhead`, and
  it would have shipped in this deploy. **Any transformation in a read-live-and-re-emit
  generator has to be safe to run twice.**
- **Zipping is now `scripts/zip-package.mjs`.** The standing rule was "Explorer only, never
  `Compress-Archive`" (PS 5.1 writes backslash entry paths the ZIP spec forbids). A rule
  people must remember is worse than a script that cannot get it wrong — and the script also
  prints each entry's mtime, because we shipped a **stale zip** once, and excludes
  `generate.mjs` / `README.md`, which Explorer had been uploading to Harmon's org.


---

## D-063a (amendment to D-063): the percent-domain class, audited to extinction

**Date:** 2026-08-24 · **Decided by:** Tim
**Amends:** [D-063](#d-063-salesforce-percent-fields-have-three-domains--metadata-defaults-are-decimal-the-api-is-display-formulas-are-decimal). Same defect, six more instances, plus the audit that makes the class closed rather than open.

### Two more fields found the same way the first two were — by eye

`Labor_Burden_Rate__c` and `Commission_Burden_Rate__c` on `Sundial_Solar__c` were created
with `<defaultValue>75</defaultValue>`, so they stored **7500**. **4,473 of 4,474 Solar
records** carried it.

**This instance had no cancelling error.** The NS markup bug survived undetected because a
matching `/100` in the Salesforce formula happened to undo it. Nothing undid this one:
these fields are read only through SOQL, `budgetCalc` divides by 100 once and correctly,
and 7500 becomes a **75.0 multiplier** — every burden figure 100× too large.

It never bit for a reason worth writing down: **exactly one `Sundial_Solar__c` record has
ever completed a budget calc** (`SOL-10014`, a test clone), and that record holds the
correct 75. Not a control — luck.

Also found, and deliberately **not** touched: `Commission_Burden_Rate__c = 0.75` on two
Solar records and `0.75` / `1.75` on two Customer records. Those are the **mirror-image
error** — someone writing the *decimal* form into the *display* domain, yielding a 0.75%
burden. Human-set, listed for review.

### The class audit — `scripts/audit-percent-field-defaults.mjs`

Chasing this field by field is how it took three rounds to find. The audit sweeps **every
Percent field on every Sundial object**, checks the default literal against the decimal
rule *and* the stored data, and exits non-zero on any suspect. Run it before any deploy
that adds a Percent field.

| Object | Field | Default | Stores | Verdict |
|---|---|---|---|---|
| Customer | `NS_Adder_1..5_Markup_Percent__c` | `0.25` | 25% | ✅ fixed (D-063) |
| Solar | `NS_Adder_1..5_Markup_Percent__c` | `0.25` | 25% | ✅ fixed (D-063) |
| Solar | `Labor_Burden_Rate__c` | `75` → **`0.75`** | 7500% → 75% | ✅ fixed here |
| Solar | `Commission_Burden_Rate__c` | `75` → **`0.75`** | 7500% → 75% | ✅ fixed here |
| Roofing | `Burden_Rate__c` | `20` → **`0.20`** | 2000% → 20% | ✅ **found by the audit**, fixed by Tim in Setup |
| Roofing | `Commission_Markup_Percent__c` | `20` → **`0.20`** | 2000% → 20% | ✅ found by the audit, fixed by Tim |
| Roofing | `Commission_Rate_Percent__c` | `2.5` → **`0.025`** | 250% → 2.5% | ✅ found by the audit, fixed by Tim |
| Roofing | `Labor_Markup_Percent__c` | `35` → **`0.35`** | 3500% → 35% | ✅ found by the audit, fixed by Tim |
| Roofing | `Material_Markup_Percent__c` | `30` → **`0.30`** | 3000% → 30% | ✅ found by the audit, fixed by Tim |
| Roofing | `Other_Markup_Percent__c` | `30` → **`0.30`** | 3000% → 30% | ✅ found by the audit, fixed by Tim |
| Roofing | `City_Tax_Rate__c` | `0` | 0% | ✅ correct either way |

**Six of the ten instances were found by the audit, not by anyone noticing.** That is the
argument for the audit existing. The Roofing six carried one bad record each; Tim corrected
both the defaults and the six records directly in Setup.

**Roofing has no calc engine yet.** Nothing reads those fields today, which is why one bad
record each sat there unnoticed. **When the Roofing budget work starts, the burden and
markup guards come with it** — the equivalents of `BURDEN_RATE_IMPLAUSIBLE` and
`NS_MARKUP_IMPLAUSIBLE`, in the same shape, from day one rather than after an incident.

**One documented false positive.** `Customer.Proposed_Offset__c` has 1,563 records above
100%, and that is *correct* — a solar system routinely produces more than a customer's
usage. Fractional values (104.76, 113.03, 151.92) confirm real measurements; a 100×-inflated
1% would read as a round 100. It is exempted by name in `STORED_EXEMPT`, with the reasoning
inline, because an unexplained exemption is how a real defect eventually hides.

### Guard

`BURDEN_RATE_IMPLAUSIBLE` throws above **100%** on both burden fields, before either is
read into a multiplier — they feed almost every cost line, so an implausible one does not
produce a localised wrong number, it moves the whole budget.

### The automation lesson — we were safe by sequencing, not by design

`salesforce/flows/Sundial_Budget_Recalc_Trigger.flow-meta.xml` lists both burden fields as
`ISCHANGED` inputs. On paper, 4,473 writes meant 4,473 platform events. **That flow was
never deployed** (TASKS.md still lists activating it and wiring the relay as open), and the
SF→AWS relay was never wired, so nothing could fan out.

Two things follow:

1. **The repo is not the org.** The integration user cannot read `FlowDefinitionView` or
   `ApexTrigger` (both `INVALID_TYPE` — no View Setup), so a metadata check was not
   available. `scripts/fix-burden-rate-percent-domain.mjs` therefore writes **one record
   first**, re-reads it, and aborts if any field it did not write has changed. It passed,
   and `Budget_Calc_Status__c = 'Pending'` stayed at 0 across the whole run — empirical
   proof rather than an assumption. Every future bulk fix should carry the same canary.
2. ⚠️ **When the recalc Flow IS activated, bulk data fixes must deactivate it first.**
   Today's safety is an accident of sequencing. Written into CLAUDE.md as a standing rule
   so it does not have to be rediscovered.

### Addendum, 2026-08-25 — the zip builder validated everything except the thing that mattered

The `v2-field-alignments.zip` produced for this fix failed Workbench Check with five
"Not in package.xml" errors. The MODIFY generator only writes an `.object` for objects with
pending changes, so once the NS markup fix deployed it stopped writing Customer — and left
the **previous run's file on disk** while rewriting `package.xml` without it.

The builder had been reporting both files' mtimes, six minutes apart, on every run. Nobody
noticed, because **a report a human has to read carefully is not a check**. It verified
CRCs and printed timestamps — neither of which can express "the manifest and the contents
disagree about what is being deployed".

`zip-package.mjs` now compares `package.xml` members against the field list in every
`.object`, both directions, and **refuses to write** on a mismatch. The generator deletes
object files for objects that drop out. Two ends of the same defect: the tool cannot emit
it, and the source cannot create it.

The general rule, worth carrying to any future build step: **if a build tool prints
something a person is expected to notice, that thing should be an assertion instead.**

---

## D-064: Sales-rep and dealer access model (row + field security in the Lambda layer and RLS)

**Date:** 2026-08-26 · **Status:** **Accepted** — Phase 0 and **Phase 1 shipped 2026-08-27**; **amended 2026-08-27 (A1-A6, below)**; Phase 1b next
**Supersedes:** enforcement scope of D-043; the TEMP restrict (TASKS "Sales Rep visibility", shipped 2026-08-03); harmon-crm D-048
**Refines:** D-015 (dealer modeled as an object, not a `Parent_User__c` tree), D-035 (rowFilter composes like tenant scope), D-056 (scope materialized into server-owned `profiles` columns; no client update grant)
**Full design:** [`docs/access-model.md`](docs/access-model.md) — this entry is the ADR; the document is the spec.

**Context.** One Salesforce integration user serves every portal session, so Salesforce profiles, roles and sharing rules are inert per user. The only server-side access control is tenant scope plus a TEMP guard that name-matches one hardcoded rep on two objects, bypasses the cache, keys on a field D-043 reserved for something else, and defaults **open**. Manage Users stamps that key on every new user. Field visibility is a client-side rail-id list that has leaked twice. Harmon is onboarding outside dealers, each with reps and a manager.

**Decision.**

1. Role comes from `Access_Level__c` alone and resolves to a scope: `tenant` / `dealer` / `own` / `none`; unknown is `none`.
2. Dealers are `Sundial_Dealer__c` rows; users and deals carry `Dealer__c`; reps are `Sales_Rep__c`. The server stamps and maintains both on deals; sales roles can never write them.
3. `lib/access.js` is the single authority; every read/write/action Lambda calls it. Row filters are id equalities on cached, indexed columns and are applied before any caller filter.
4. Field visibility is a per-role column in the field-design workbooks, generated into a server manifest and the client layout by one script in sundial-core; the server selects only visible fields and returns the editable set; the client renders what it is given.
5. Roofing, Service, Commercial, PO and all action endpoints are denied to sales roles. Customer files are read/upload only on visible records; Solar files are denied.
6. Browser-direct tables get RLS built on `security definer` helpers over server-owned scope columns on `profiles` and the rep/dealer columns on the cache tables; cache tables are RLS-denied to clients.
7. Cutover runs shadow → enforce-with-overlap → remove, gated by a scripted per-user diff that must show no widening for the live rep.

**Consequences.** Two new SF fields per deal object, one new object, five cache columns, a backfill, a manifest loader that fails cold start on a bad manifest, cross-repo generation with a version check, and `Hierarchy_Level__c` / `Roles__c` / `Parent_User__c` retired from code. Deals with a blank sales company remain invisible to dealers until attributed — by design. The client keeps no authorization tables. Adding a role is a sheet column plus one row in the scope table.

**Alternatives rejected.** `Parent_User__c` tree walk (D-015) · name-string filtering (the current jank) · Salesforce sharing (inert under one integration user) · client-side field hiding (the current jank) · a `record_access` join table maintained by sync (more state to keep consistent than two columns; revisit if per-record sharing overrides are ever needed).

### Phase 0 findings that amend the design before it is built (2026-08-27)

Phase 0 was discovery and hardening only — no behaviour changed for any user. Four things it measured contradict assumptions the design was written on, and are recorded here because they change Phase 1's work, not just its documentation:

1. **`Sales_Representative__c` is a PICKLIST**, not the REFERENCE the solar sheet claims nor the plain string `sf-query/test.js` assumes. Not a lookup, so it can never be filtered by id — name-resolution is the only backfill route. Same for `Sunbase_Sales_Rep__c`. (§2.4a)
2. **The two dealer picklists do not match.** Customer `Dealer_Name__c` has 110 active values, Solar `Sales_Company_Harmon_Solar_or_Third__c` has 56, and only 36 match exactly — with near-misses (`ReFract Solar`/`Refract Solar`, `Sky's the Limit Solar`/`Skys the Limit Solar`) that an exact join drops silently. **`Sales_Company_Value__c` therefore cannot be one unique string per dealer**; `Sundial_Dealer__c` needs a value per object or an alias child, and the backfill needs the normalize-and-match step the vendor map already uses (D-060).
3. **`Harmon Solar` is not a value on Customer `Dealer_Name__c` at all**, and that field is populated on 13 of 31,637 customers. Deriving a customer's dealer from it would leave essentially every customer with a null `Dealer__c` and therefore invisible to dealer scope. The workable derivation is `Sales_Rep__r.Dealer__c`, with the deal's own `Dealer__c` as the exception path.
4. **The §7.2 cutover gate already passes for the live restricted user, before any backfill.** For Dennis Alessandro the legacy name match and the `Sales_Rep__c` id match return **identical id sets** — 3,534 on Customer, 777 on Solar, `onlyInOld` and `onlyInNew` both zero. The Phase 1 deal-ownership backfill has no work to do for him, and Phase 3's enforce step cannot change what he sees.

Two further facts about the *current* system, measured by `scripts/verify-access-matrix.mjs` against ZZ TEST users:

- The TEMP guard filters on a hardcoded rep **name**, so **any** user carrying `Hierarchy_Level__c = "Sales Rep"` is served Dennis's book of business — not their own records, which 404.
- A `Technician` sees **everything** (all 31,638 customers, all solar, roofing, PO, and Solar files), because their hierarchy value does not match the guard and the guard's default is "no match → unrestricted". §1.2's note that this default is inverted, made concrete.

### Amended 2026-08-27 — six decisions taken before Phase 1 was built

The findings above are measurements. These are the **decisions** taken in response, before a line of Phase 1 existed. They amend the numbered Decision list, and `docs/access-model.md` applies each one in place in the section it touches — the amendments are not a separate layer of caveats sitting on top of a spec that still says something else.

**A1 — a deal's dealer is derived from its rep, and from nothing else.** `Dealer__c := Sales_Rep__r.Dealer__c`, stamped by the server on create and **re-stamped on any `Sales_Rep__c` change**. The sales-company picklists (Customer `Dealer_Name__c` / `Sales_Company__c`, Solar `Sales_Company_Harmon_Solar_or_Third__c`) stay the **commission discriminator only** (D19) and are not an ownership source on any path. This resolves the contradiction the design shipped with — §2.2 preferred rep-derivation while §2.4 specified the picklist — in favour of the rep, on evidence: `Dealer_Name__c` is populated on **13 of 31,637** customers and does not contain "Harmon Solar", so a picklist-derived `Dealer__c` would be null almost everywhere, and null is invisible to every dealer-scope user. `Sales_Rep__c` is a real `Sundial_User__c` lookup on both objects, populated on 14,124 customers and 3,262 solar projects. The re-stamp half is the one that is easy to omit and expensive to omit: stamping only on create leaves a reassigned deal shared with the *losing* dealer, and nothing ever notices, because the record looks correct to everyone except the people who should no longer see it.

**A2 — `Sundial_Dealer__c.Sales_Company_Value__c` is dropped.** Finding 2 above said the column "cannot be one unique string per dealer" and proposed a value-per-object or an alias child. Both keep the picklist as the source; A1 removes it as the source, so neither is needed. What remains is one backfill's worth of name matching, and it lives in a reviewed CSV — `docs/integrations/dealer-aliases.csv` (`DealerName,Alias,Object,Note`) — used **only** by the Solar-side backfill, for deals that carry a dealer picklist value but **no** `Sales_Rep__c`. Exact matches auto-map; near-misses (case, punctuation, whitespace) are listed for approval and **never** auto-applied; unmatched stay null. Same rule as `dealer-vendor-map.csv` under D-060, for the same reason: which two spellings are one organization is a judgement, and judgements belong in a file someone diffed rather than in normalization code that will later be "improved".

**A3 — Dennis needs no rep backfill, and the backfill checks anyway.** Finding 4 measured `Sales_Rep__c` as already equal to the legacy name match — 3,534 Customer, 777 Solar, zero difference. `scripts/backfill-deal-ownership.mjs` still runs that set comparison on every run and **aborts** if it is no longer true. The Phase 0 number is a point-in-time snapshot of a live org; one record created or reassigned since breaks the equality, and the failure would be silent — a completed backfill, an ordinary-looking report, and the one live restricted user quietly missing records. An abort makes that arrive as a question instead of as a support ticket.

**A4 — the cache-table `REVOKE` moves from Phase 6 to the first SQL of Phase 1.** `anon` and `authenticated` hold `arwdDxtm` on all six `sundial_*_cache` tables and always have; the only thing between a browser session and 31,640 customer rows is an RLS policy that denies **by accident** (it filters on `public.portal_users`, which holds zero rows). **`public.portal_users` and `current_user_tenant_id()` are load-bearing accidents: populating that table or repointing that helper at `profiles` would expose the entire cache to any authenticated session, and neither may be "fixed" before the revoke is applied.** Both edits read as obvious housekeeping, which is exactly why this sentence exists. The revoke costs nothing — nothing reads a cache table from a browser, verified file-by-file (§5.1c). RLS stays enabled and **no policy is touched**, so Phase 6's diff shows the policy drop alone.

**A5 — the comments/mentions RLS (§5.3) becomes Phase 1b**, immediately after Phase 1. Phase 0 measured a Sales Rep reading **all 485 comments in the tenant**, none of them their own, on records they cannot open. That is a live cross-user leak, not a hardening item. It needs `record_visible()`, which needs Phase 1's cache columns, so Phase 1b is the earliest it can run — and there is no argument for carrying it through four phases of unrelated work.

**A6 — the mis-stamped users are repaired through the endpoint, not by direct field writes.** `scripts/repair-mis-stamped-users.mjs` re-PATCHes each affected user's **current** `accessLevel` through the live `/admin/users` endpoint as `tim+zz-admin`, so the server's own derivation runs and produces the value. Writing `Hierarchy_Level__c` directly would fix the data while leaving the derivation untested against the live restricted picklist — the failure mode Phase 0's e2e assertion was built to catch. Report-only by default, `--apply` to run, canary-first, and it **skips Dennis and any user whose `Access_Level__c` is `Sales Rep`**. The scope is small and worth stating so nobody looks for a bigger list: exactly **one** live user qualifies (`Temp Passtwo`, a test account, `Manager` stored as `Sales Rep`). The 13 users the Phase 0 audit calls "derivation differs" are **not** in scope — they store `Manager`/`Client`, which the old default never wrote, and PATCHing them would rewrite `Manager → Client` for no behavioural gain.

**Consequences of the amendments.** One fewer field on `Sundial_Dealer__c`. One new reviewed CSV. The `Sales_Rep__c` name-resolution backfill is **not built** — records with no rep and no alias match stay visibly unowned in the report, which is a better input to a human decision than a guessed rep. Phase 6 shrinks to a policy drop. Phase 1 grows by one SQL file, applied first.

### Phase 1 outcome (2026-08-27) — and one thing the amendments missed

Phase 1 shipped: `Sundial_Dealer__c` with 57 rows (5 active), `Dealer__c` on 4,312 customers and 1,203 solar projects, the cache filter columns populated and reconciled against SOQL rep-by-rep, `lib/access.js` behind 112 unit tests, and the `access` block live on `/auth/me`. All six §8 gates pass; the evidence table is in `docs/access-model.md` §8. Nothing any live user sees changed, measured twice — the shadow report shows 20 of 34 active users with `no change`, and `verify-access-matrix.mjs` shows the TEMP guard behaving identically after the deploy.

**A4 was right about the pattern and wrong about its extent.** It pulled the cache-table REVOKE forward because `anon`/`authenticated` held full privileges there, protected only by a policy that denies by accident. Applying it exposed the same shape one table over: `public.profiles` also held `arwdDxtm` for both roles, with a single SELECT policy — and Phase 1 is what put `access_scope` in that table. So the wide grant that had been guarding a display name became the wide grant guarding an authorization decision, and the only thing between them was the absence of an UPDATE policy that a reasonable person might add without a second thought.

`sql/sundial_access_p1_profiles_revoke.sql` closes it, on `profiles` alone: `comments`, `comment_mentions` and `user_preferences` carry the identical grant and are deliberately left, because unlike `profiles` their write grants are used by the browser and constrained by real policies.

The generalisation worth carrying into Phase 1b and Phase 6: **in this project a wide grant is the default and a narrow one is the exception, so "RLS denies it" is never a complete answer to "who can write this".** Ask what the grant is, then ask what the policy is. Every table this design newly depends on needs both questions answered before it is depended on, not after.

---

## Numbering note (2026-08-27): D-045…D-050 collide across the two repos, and D-049 collides inside this one

**Across repos.** `D-045` through `D-050` name **six entirely different decisions** in sundial-core and in harmon-crm. They were assigned independently after the 2026-07-21 split, before the provenance note's "coordinate before reusing a number" rule had teeth:

| # | sundial-core (backend) | harmon-crm (product/frontend) |
|---|---|---|
| D-045 | Salesforce describe cache gets a TTL | Frontend user-admin pattern, must-change-password gate |
| D-046 | Auth email via Supabase Custom SMTP (SES) | Harmon feedback batch — persistent notes/comments |
| D-047 | Aurora Design Request runs on the Customer module | Create Project — config-driven field map |
| D-048 | Aurora inbound is doorbell + queue + worker | TEMP client-side role tab hiding |
| D-049 | Dealer-originated Aurora deals auto-create the Customer | Customer config generated from the field-design sheet |
| D-050 | List page size capped at 5000 on the cache path | "Send to Aurora" submits behind a confirm |

**A bare "D-047" is therefore ambiguous and must always be qualified with its repo.** Note that access-model.md §11 (D-064) cites *harmon-crm's* D-048 as superseded, not this repo's.

**Inside this repo.** `D-049` is additionally used **twice** here: "Budget push triggered by a direct portal API call (relay/SQS dropped from this path)" and "Dealer-originated Aurora deals auto-create the Customer on `signed`". Deliberately **not renumbered** — inbound references in PROGRESS, TASKS and the integration docs would silently point at the wrong decision, which is worse than a duplicate that is documented. Cite this one by title, not by number.

Neither collision is being repaired retroactively. New backend decisions continue from the highest number in **this** file (D-064 as of today), and the coordination rule in the provenance note above stands.

---
