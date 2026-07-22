# Sundial — Multi-Client Deployment Architecture

> How Sundial scales from one client (Harmon) to multiple clients without rebuilding the platform each time.

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

Lambda code lives in a shared private NPM package (`@constructiveops/sundial-core`) consumed by each client's Lambda deployment. Bug fixes and feature additions in the shared package propagate to all clients by version-bumping.

### Cross-Cutting Infrastructure
- AWS account (single, shared across clients)
- S3 bucket (`sundial-files`, with per-client prefixes)
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
- `harmon-crm` (Harmon Solar)
- `clientB-crm`
- `clientC-crm`

### Vercel Project
Each client's frontend deploys to its own Vercel project, with its own domain or subdomain.

### Supabase Project
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

These are **hard rules** enforced at every layer:

1. **Every Sundial_* Salesforce record has a `Client__c` lookup** pointing to the top-level Sundial_User__c record representing the client organization.

2. **Every Lambda query against Salesforce filters by Client__c** based on the authenticated portal user's client scope. No exceptions. Tenant filtering is a code-level enforcement, not a configuration option.

3. **Every Supabase project is single-tenant.** No cross-client data ever lives in one Supabase project.

4. **Lambda functions accept a tenant context** (derived from the authenticated user's Sundial_User__c.Client__c) and reject any operation where the requested data doesn't match the tenant context.

5. **S3 file paths include the tenant ID** as the first path segment (`{tenant_id}/{object_type}/{sf_record_id}/{filename}`). Lambda enforces tenant ID match before generating presigned URLs.

---

## Spinning Up a New Client (Checklist)

The goal is for this to take a day or two, not weeks. The shared infrastructure is already in place; new client setup is configuration and forking.

### Salesforce Setup (1-2 hours)
1. Create the top-level `Sundial_User__c` record for the client organization (Hierarchy_Level = Client, no Parent_User)
2. Create initial `Sundial_User__c` records for the client's portal users (Hierarchy_Level = Sales Manager, Sales Rep, etc., with appropriate Parent_User links and Client lookup)
3. Configure any sharing rules specific to the new client (criteria-based on Client__c)
4. Identify any client-specific custom fields needed beyond the shared schema; add to the relevant Sundial_* object(s) noting the client's name in the field description for traceability

### Repo and Frontend Setup (2-4 hours)
1. Fork `sundial-template` to a new repo (e.g., `https://github.com/ConstructiveOps/clientB-crm`)
2. Update `client-config.ts` with the new client's configuration
3. Add the new client's branding assets to `/src/assets/branding/`
4. Adjust field visibility, module enablement, and pipeline stage definitions per the new client's needs
5. Run locally to verify the configuration

### Supabase Setup (30 minutes)
1. Create new Supabase project named for the client
2. Apply the schema migrations from `sundial-template`'s `supabase/migrations/` directory
3. Configure auth providers (email/password and optionally magic links)
4. Capture URL and keys to the new repo's `.env.local`

### Vercel Setup (15 minutes)
1. Create new Vercel project from the forked GitHub repo
2. Add environment variables (Supabase URL, anon key, Lambda API base URL, tenant ID)
3. Deploy to Vercel default subdomain to verify
4. Configure custom domain when ready

### Lambda Setup (30 minutes)
1. Deploy a new Lambda function set for this client (or use a shared function with tenant context routing; choice depends on isolation preferences)
2. If using shared Lambdas, no new deployment is needed; the client's frontend just authenticates with its tenant scope
3. Configure any client-specific environment variables (Acumatica tenant URL if they use Acumatica, Stripe account if applicable, etc.)

### Initial Data Migration
Per client, based on their starting state. Sunbase or HCP migration scripts can be reused with new field mappings.

### Verification
1. A test portal user can log in to the new client's portal
2. The login resolves to the right `Sundial_User__c` record
3. SOQL queries return only records with the correct `Client__c`
4. File uploads go to the right S3 prefix
5. The client's Supabase project sees expected auth and chat traffic

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

- **Lambda deployment model:** shared functions with tenant context routing, or per-client function deployments? Shared is simpler but couples failures; per-client is more isolated but more deployments to manage. Defer until we have 2+ clients in production.
- **Per-client custom Salesforce fields:** when a client needs a field no one else uses, add it to the shared Sundial_* object with a clear naming convention (`ClientName_Field__c`), or hold them in a separate object? Defer until the second client requires it.
