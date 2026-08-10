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
- **Known edge:** if the project reports no `external_provider_id` but the *design* reports one, Aurora's own objects disagree. Since the customer has been created by then, dead-lettering would strand it — the worker warns loudly (email + log) and flags a possible duplicate instead.

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
