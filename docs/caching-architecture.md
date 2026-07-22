# Sundial — Data Caching Architecture

> How Sundial minimizes Salesforce API consumption by caching reads in Supabase and broadcasting invalidations via Supabase Realtime.

---

## Why Caching

Salesforce API limits are a real constraint. Constructive Operations' Sales Cloud Enterprise org has a per-24-hour API call ceiling shared across all uses of the org, including Zapier automations, Lambda functions, manual admin work, and other clients running on Sundial. Direct queries to Salesforce on every portal page load would exhaust the daily API budget under any realistic user load.

Caching the data in Supabase reduces API consumption by an estimated 80-95 percent in normal operation. The portal's read load is served from cache; only writes and explicit cache misses hit Salesforce.

This pattern also makes the portal faster, since Supabase Postgres queries are dramatically lower latency than Salesforce REST API calls.

---

## Architecture

### Cache Layer in Supabase

Each Sundial custom object has a corresponding cache table in the client's Supabase project. Cache tables mirror the structure of the Salesforce object with the fields the portal actually displays:

- `sundial_user_cache`
- `sundial_customer_cache`
- `sundial_solar_cache`
- `sundial_roofing_cache`
- `sundial_commercial_cache`
- `sundial_service_cache`
- `sundial_service_visit_cache`
- `sundial_po_cache`
- `sundial_po_credit_cache`
- `asset_cache` (for installed systems)

Each cache table includes:
- `sf_id` — Salesforce record ID (primary key)
- `tenant_id` — `Client__c` value (single-tenant Supabase per client means this is effectively always the same value, but it stays for defense-in-depth)
- Mirrored fields from the SF object (the subset the portal cares about)
- `last_synced_at` — Timestamp of the last successful sync from Salesforce
- `cache_version` — Incremented on each update (helps with conflict detection)
- `is_stale` — Boolean flag set when an out-of-band change is detected but not yet refreshed

### Read Path

1. Portal makes a read request via Lambda
2. Lambda queries the Supabase cache table for the requested records
3. If cache hit and not stale:
   - Return cached data immediately
   - Optionally trigger an async refresh if `last_synced_at` is older than a configurable threshold (e.g., one hour for hot objects, longer for cold ones)
4. If cache miss or marked stale:
   - Lambda queries Salesforce via JSforce
   - Updates the cache table with fresh data
   - Returns the fresh data

The portal frontend never knows whether a response came from cache or Salesforce. The contract is identical.

> **Implemented by `sundial-sf-query`.** The read path above is implemented and verified end to end by the `sundial-sf-query` Lambda (serving `GET /sf/{object}` and `GET /sf/{object}/{id}`). Tenant isolation is enforced on the cache via the `client_sf_id` column (the Salesforce Client record ID) and on Salesforce via `Client__c = '<tenantId>'`, both derived solely from the verified token. See DECISIONS.md D-035. Note: the contract is "identical" in field meaning, not yet byte-identical — a `source: "cache"` row currently returns all cache columns (including nulls) while a `source: "salesforce"` row returns only describe-selected fields; treat fields as nullable until shapes are normalized.

### Write Path

1. Portal initiates a write via Lambda
2. Lambda writes to Salesforce via JSforce
3. On successful Salesforce write:
   - Lambda updates the cache table with the new field values (including `last_synced_at` and incrementing `cache_version`)
   - Lambda publishes an invalidation event via Supabase Realtime on the relevant channel
4. Other portal sessions subscribed to that channel receive the invalidation and either refetch or apply the broadcast payload to their local state

If the Salesforce write fails, the cache is not updated and the user sees the error. No partial writes.

### Salesforce Platform Events for Out-of-Band Changes

The cache stays in sync with Salesforce when changes happen outside the portal (via Salesforce Flow, admin edits, Zapier integrations, the Acumatica integration writing back). The mechanism:

1. Salesforce Flow on key field changes publishes a `Sundial_Cache_Invalidation__e` Platform Event with the record ID and object type
2. Lambda subscribes to the Platform Event stream (via CometD or by polling)
3. Lambda fetches the changed record from Salesforce and updates the cache
4. Lambda broadcasts the change via Supabase Realtime to subscribed clients

Platform Event volume is much lower than API call volume since events only fire on meaningful changes, not on every read. This is sustainable within the Platform Event allocation.

### EventBridge for Batch Operations

For non-real-time cache maintenance:

- **Scheduled refreshes:** Nightly Lambda triggered by EventBridge does a full refresh of slowly-changing data (customer records, asset records, user records). Catches any drift from missed Platform Events.
- **Cross-tenant operations:** When a schema change requires cache rebuild across all clients, EventBridge orchestrates the rollout.
- **Retry queue:** Failed cache updates land in an SQS dead-letter queue; EventBridge triggers retry Lambdas on a schedule.

---

## Cache Invalidation Strategy

Three triggers invalidate cache entries:

1. **Event-driven:** Portal writes (immediate update + Realtime broadcast)
2. **Platform Event-driven:** Out-of-band Salesforce changes (Lambda-mediated update + Realtime broadcast)
3. **TTL-based:** Each cache entry has a configurable max-age; entries older than the TTL are marked stale and refresh on next read

TTL defaults:
- Hot objects (Sundial_Customer, Sundial_User, Asset): 24 hours
- Project objects (Sundial_Solar, Sundial_Roofing, Sundial_Commercial): 1 hour
- Service objects (Sundial_Service, Sundial_Service_Visit): 15 minutes (more change activity)
- Financial objects (Sundial_PO, Sundial_PO_Credit): 5 minutes (highest sensitivity)

TTLs are tunable per object per client in `client-config.ts`.

---

## Always-Fresh-From-Salesforce Operations

Some operations bypass the cache entirely and read directly from Salesforce:

- **Payment processing.** Before charging a card via Stripe, read the current state of the invoice from Salesforce. Stale data here can mean double-charging a customer.
- **Scheduling commits.** When a dispatcher confirms a job assignment, read fresh from Salesforce to detect conflicts that might have been written by another dispatcher in the last few minutes.
- **Acumatica writes.** Before pushing data to Acumatica, read fresh from Salesforce to ensure the data being synced is current.
- **Financial reports for accounting use.** Where dollar amounts must be precisely correct as of right now, query Salesforce directly.
- **Audit queries.** Compliance-relevant reads bypass cache.

These operations are wrapped in a `readFreshFromSalesforce()` Lambda helper that explicitly bypasses the cache layer.

---

## Real-Time Updates in the Portal

Portal clients subscribe to Supabase Realtime channels for the objects they're viewing. Channel naming convention:

- `tenant:{tenant_id}:sundial_solar:{sf_id}` — Updates to a specific solar project
- `tenant:{tenant_id}:sundial_service:list` — Updates to any service ticket (used by the dispatch board)
- `tenant:{tenant_id}:user:{user_id}:notifications` — User-specific notifications

When Lambda broadcasts an invalidation, the message payload includes the updated record (not just an invalidation flag), so subscribed clients can update local state without a round trip back to Lambda.

---

## Cache Table Schema Pattern

Generic structure for a cache table:

```sql
create table sundial_solar_cache (
  sf_id text primary key,
  tenant_id text not null,
  project_name text,
  sundial_customer_sf_id text,
  customer_name_at_creation text,
  address_at_creation text,
  stage text,
  sales_rep_sf_id text,
  project_manager_sf_id text,
  system_size_kw numeric,
  project_budget numeric,
  -- ... other displayed fields
  last_synced_at timestamptz not null default now(),
  cache_version integer not null default 1,
  is_stale boolean not null default false
);

create index idx_sundial_solar_cache_tenant on sundial_solar_cache(tenant_id);
create index idx_sundial_solar_cache_stage on sundial_solar_cache(tenant_id, stage);
create index idx_sundial_solar_cache_stale on sundial_solar_cache(tenant_id, is_stale) where is_stale = true;
```

Indexes mirror the queries the portal actually runs. Add or drop indexes as portal patterns emerge.

### `sundial_roofing_cache` (Roofing list/board)

Mirrors the Solar pattern: a narrow display subset for the list table + Kanban board, plus the standard control columns. Full SQL: **`sql/sundial_roofing_cache.sql`**. The detail view does **not** read this table (it uses `GET /sf/roofing/{id}?full=true`, describe-driven), so the 116 material/input + 36 output budget fields stay out of the cache.

Display columns (names match `sfFieldToColumn()` so `sundial-sf-query`/`sundial-cache-sync` populate them with no code change): `name`, `project_name`, `sundial_customer_sf_id`, `customer_name_at_creation`, `address_at_creation`, `primary_phone_at_creation`, `primary_email_at_creation`, `stage` (board grouping), `sales_rep_sf_id`, `project_manager_sf_id`, `acumatica_project_id`, `contract_presented_amount` (headline $), `total_proposal_cost` (computed $, null until the budget calc runs). Control columns are identical to `sundial_solar_cache` (`sf_id`, `client_sf_id` isolation key, `tenant_id` slug, `last_synced_at`, `cache_version`, `is_stale`).

**No new sync mechanism:** roofing is already registered in the `OBJECT_ALLOWLIST` of `sundial-sf-query` (read/list/full), `sundial-sf-update` (write), and `sundial-cache-sync` (scheduled populate). Creating the table is the only step — records then populate via read-through and the sync job. Until the table exists, `sundial-cache-sync` gracefully skips roofing.

---

## Operational Concerns

### Cache Storage Growth
For Harmon's expected volume (thousands of projects, ~70 new customers/month, ~150-230 service tickets/month), the cache will stay small (low GB range) for the foreseeable future. Supabase's default plan accommodates this comfortably.

### Cache Consistency on Lambda Cold Starts
Lambda cold starts shouldn't affect cache consistency since the cache lives in Supabase, not Lambda memory. Every Lambda invocation queries Supabase fresh.

### Realtime Connection Limits
Supabase Realtime has per-project connection limits. The portal opens one connection per active session, so 100 concurrent users equals 100 connections. Comfortable within the standard tier.

### Monitoring
CloudWatch metrics to track:
- Cache hit rate (target: 80%+)
- Salesforce API call count (per Lambda function and total)
- Cache update latency (Salesforce write to cache update)
- Realtime broadcast volume

Alerts on:
- Cache hit rate dropping below 70%
- Salesforce API consumption approaching 50% of daily limit
- DLQ messages indicating failed cache updates

---

## Implementation Phasing

Phase 1 implementation includes:
- Cache tables for all Sundial_* objects
- Read path with cache check + Salesforce fallback
- Write path with cache update + Realtime broadcast
- Basic TTL configuration

Phase 2 and beyond can add:
- Platform Event integration for out-of-band changes
- EventBridge scheduled refresh jobs
- More sophisticated cache warming for predictable access patterns
- Per-user cache personalization (if needed)
