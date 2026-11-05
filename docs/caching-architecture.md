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

### A create that writes its own row — `lib/cache-row.js` (2026-09-29, D-077)

The portal's `POST /sf/customer` writes no cache row (a known limitation in `sundial-sf-update`), so a new record normally reaches the cache through `sundial-cache-sync` or the list read's cold-cache fallback. `sundial-lead-intake` does better, because a TCD lead must be in Sales straight away. After the create it reads the record back (tenant-filtered) and upserts its row through `lib/cache-row.js`. That module is the SF-record → cache-row mapper moved out of `sundial-sf-query`. Only the intake uses it so far: sf-query and cache-sync keep their own copies until they are switched over (TASKS.md), and `lib/cache-row.test.js` fails if the lib and sf-query's copy ever map a record differently. The write is best-effort; a failure leaves the record to the sync.

### A null from Salesforce is a value (2026-10-14)

When a Salesforce record is the source of a cache row — `sundial-cache-sync` (incremental and full), `sundial-sf-query`'s read-time refresh / single read / cold-cache fill, and `lib/cache-row.js` — **every mapped column is written, null included**. A field cleared in Salesforce comes back as `null` and clears the column. Until 2026-10-14 all three copies of `mapSfRecordToCacheRow` skipped nulls, so a cleared field (Harmon: a removed `Next_Follow_Up_Date__c`, the overdue flag still lit) kept its old value until a full resync — and a bulk upsert only cleared it by accident when another row in the same batch had a value for that column.

The one exception is explicit in the mapper: a field the SELECT did not fetch is absent from the record (`undefined`) and its column is left alone — "not fetched" is not "empty". A column with no field in the SELECT is never in the row at all. `sundial-sf-update` does not write the cache; it PATCHes Salesforce (a `null` in `fields` clears the field there) and flags the row `is_stale`, so the next read refreshes it through the same mapper and the cleared value arrives as null. The list response still drops null keys (`projectListRow`, the 6 MB cap) — that is the response only, never what is stored.

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

### `sundial-cache-sync` — incremental sync, manual full resync, manual reconcile

The `sundial-cache-sync` Lambda keeps the cache current. Three modes:

- **Incremental (default):** queries `WHERE SystemModstamp > <per-object watermark>` (bounded first-run lookback of 24h), ordered ascending, and advances the watermark to the batch's max modstamp. **On a schedule since 2026-10-05 (D-079)** — two EventBridge rules, see "Freshness is the sync job's health" below. Accepts `{}` (all objects), `{ "object": "solar" }` (one) or `{ "objects": [...], "intervalMinutes": 5 }` (what the rules send). For an object with a cached **cross-object formula** column, the WHERE also takes rows whose parent changed (`OR Estimate__r.SystemModstamp > <watermark>`, derived by `lib/formula-parents.js`), because a formula changing value does not move the child's own `SystemModstamp`. A run that finds nothing is one SOQL and no cache write. Every run writes a row to `public.cache_sync_runs` (ok or not).
- **Full resync:** `{ "mode": "full" }` (optionally `+ "object"`) ignores the watermark window and pulls **every** record for the object(s). Use it to **backfill after a bulk data load** whose records fall outside the incremental window, or whenever a cache count has drifted below Salesforce. Idempotent (upsert on `sf_id`) — safe to re-run.
  - **Also after a formula field's DEFINITION changes** (a package redeploys it). That changes the value on every record without touching `SystemModstamp`/`LastModifiedDate`, so neither the incremental window nor the parent-modstamp OR sees it. 2026-10-23: v9's `Sales_Rep_Name__c` — `{"objects":["customer","solar"],"mode":"full"}`, ~90 s; Harmon's blank `sales_rep_name` went 25,151 → 25,115 (customer) and 1,218 → 1,197 (solar), equal to Salesforce's own counts.
  - It is cross-tenant (no tenant filter, by design); every row keeps its own `Client__c`.
- **Reconcile:** `{ "mode": "reconcile" }` — **deletes** cache rows whose Salesforce record no longer exists. Closes the deletion blind spot below. **Manual invoke only; not on any schedule.** See its own section.

### ⚠️ The deletion blind spot — deletes never propagate

**Neither sync mode ever removes a cache row, by construction.** Both are **upsert-only**, and a deleted Salesforce record simply stops appearing in the SOQL result — which is indistinguishable from "unchanged" to an upsert. There is no tombstone, and nothing subscribes to Salesforce delete events.

A record deleted in Salesforce therefore lingers in the cache as a **ghost**: it stays in list and board views, and stays counted in the `total` a pager renders, until someone opens it and the read path 404s. Deleting the Salesforce record is *not* enough to make it disappear from the portal.

Two things follow, and both matter operationally:

1. **A full resync does not fix ghosts.** It is the natural instinct ("just re-pull everything") and it does nothing here — re-upserting every live record leaves the ghost row exactly where it is. Only reconcile removes it.
2. **A purge is silent to open sessions.** There is no Realtime signal for a cache deletion — the invalidation triggers (portal write, Platform Event, TTL) all cover *changes*, not removals. Anyone with the list already on screen keeps seeing the ghost until their next fetch or reload. Purges are not user-visible in real time; plan comms accordingly if a purge matters to someone mid-session.

### `mode: "reconcile"` — bulk ghost removal

Reads every `sf_id` in an object's cache table, asks Salesforce **which of those ids still exist**, and deletes the rows it doesn't get back.

```
aws lambda invoke --function-name sundial-cache-sync --region us-west-1 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"mode":"reconcile","object":"solar","dryRun":true}' out.json
```

| Input | Effect |
|---|---|
| `object` | One object key; omit to reconcile all five |
| `dryRun: true` | Report ghosts (with up to 20 sample ids) and delete **nothing** — always run this first |
| `force: true` | Override the mass-purge safety rail (below) |

Returns per object: `{ cacheRows, checked, unverified, liveInSalesforce, ghosts, deleted, soqlQueries, status }`.

**Design decisions worth not re-litigating:**

- **The check runs cache → Salesforce, in batches, not "pull all Ids and diff."** The diff would cost fewer API calls, but it fails **catastrophically**: an incomplete or errored Salesforce result reads as "every row is a ghost" and empties the cache. Asking "do THESE ids still exist" fails safe — a batch that errors leaves its ids untouched and is reported as `unverified`, never deleted.
- **Batch size is 400 ids.** The REST query endpoint is a `GET`, so the SOQL travels in the URL against Salesforce's ~16 KB cap; URL-encoding inflates each id to ~24 bytes, so 400 ≈ 9.6 KB with deliberate margin. Raising it risks a malformed query, not a slow one.
- **API cost scales with cache size:** one SOQL per 400 cached rows — roughly **79 queries for the 31.6k customer cache**, ~12 for solar. That cost is the main reason this is manual-only.
- **Plain `query`, not `queryAll`.** A soft-deleted record sitting in the Recycle Bin is gone from every read path, so it is correctly treated as a ghost.
- **15- vs 18-char ids are normalized on the first 15 characters**, which are the unique key (the 18-char suffix is a checksum derived from them). The comparison stays **case-sensitive** — two distinct records can differ only by case in the 15-char form, which is precisely why the 18-char form exists. Deletes target the **exact stored value**, so rows in either form are removed correctly.
- **Existence is the only test.** A record that still exists under a *different* `Client__c` is not a ghost; tenant moves are the upsert path's job.
- **The watermark is never touched.** Reconcile is orthogonal to the incremental cursor and must never cause a window to be skipped.

**Safety rail.** If **≥25 ghosts** are found **and** they exceed **20%** of the rows checked, reconcile refuses with `status: "refused_ghost_ratio"` and deletes nothing — that shape means something systemic (lost integration-user access, wrong object, changed permission set), not a real cleanup. Both conditions are required: a ratio alone would block ordinary small purges, since one ghost out of two rows is 50%. Re-run with `force: true` once the count has been eyeballed.

**Not scheduled — deliberately.** This is the only destructive path in the Lambda and its API cost scales with cache size. Adding it to EventBridge should be an explicit decision, not a side effect of it existing.

Both modes follow the Salesforce query locator (`nextRecordsUrl`) to exhaustion via the shared `sfQuery`, so a single run captures the whole result set — there is **no** 2000-row-per-run cap, and records that share a `SystemModstamp` can't be split across a REST page boundary and partially skipped.

**Run a full resync (AWS CLI):**
```
aws lambda invoke --function-name sundial-cache-sync --region us-west-1 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"object":"customer","mode":"full"}' out.json
```
The function is provisioned at **900 s / 1024 MB** so a large object (tens of thousands of rows) completes in one invoke. The response reports `{ processed, fetched, newWatermark, mode }` per object. (Verified 2026-07-28: a 31,948-row customer backfill completed in ~27 s — when the table had ~45 columns. Since R0 it is ~7 minutes; see below.)

### Running a full resync — the checklist (2026-11-02)

Learned on the R0 resync (PROGRESS.md 2026-11-02). Every full resync, one object or all:

1. **Pause the 5-minute rule** so an incremental run never writes the same table mid-resync:
   ```
   aws events disable-rule --name sundial-cache-sync-incremental --region us-west-1
   ```
   (Pausing a cold-tier object too? Same command with `sundial-cache-sync-incremental-cold`.)
2. **The Test event(s)** — `{ "object": "<key>", "mode": "full" }`, one at a time, waiting for each.
3. **Vacuum each table the resync rewrote**, in the Supabase SQL editor:
   ```sql
   vacuum (analyze) public.sundial_customer_cache;   -- one line per rewritten table
   ```
   A full resync upserts every row, and Postgres keeps the old copy of each row until a
   vacuum. The pipeline functions (`sundial_customer_pipeline`, `sundial_solar_pipeline`)
   read the whole tenant, dead copies included: on 2026-11-02 the solar pipeline went
   22 → **179 ms** minutes after its resync and back to **32 ms** after `vacuum (analyze)`.
   Autovacuum gets there eventually; do not leave it to chance.
4. **Re-enable the rule:**
   ```
   aws events enable-rule --name sundial-cache-sync-incremental --region us-west-1
   ```
   The next incremental run picks up whatever changed during the pause (the watermark only
   moves forward from what the full run saw).

**How long it takes.** Salesforce returns ~200-record pages for the wide customer and solar
queries (it shrinks the page as the SELECT widens), so a full customer run is ~180 pages and
**about 7 minutes**; solar is shorter (fewer rows). Inside the 15-minute limit, but not by a
lot — see the TASKS.md Later line on retry / resume.

**The statement timeout.** The first R0 customer run failed with `cache_upsert_failed` —
"canceling statement due to statement timeout". `service_role` (every Lambda's Supabase
role) had no settings of its own and inherited `authenticator`'s `statement_timeout = 8s` /
`lock_timeout = 8s`, so every Lambda write had always had an 8-second ceiling; one 200-row ×
330-column page upsert crossed it. Fixed by `sql/2026-11-02_service_role_timeouts.sql`
(120 s / 30 s, service_role only; idempotent). **A new Supabase project needs the same file**
(`docs/multi-client-deployment.md`). Today a timed-out page fails the whole run and the next
run starts from page one.

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

### The row-filter columns (D-064 Phase 1)

`sql/sundial_access_p1_cache_columns.sql` adds the columns the access model filters on:

| Table | Columns added | Salesforce source |
|---|---|---|
| `sundial_customer_cache` | `sales_rep_sf_id`, `dealer_sf_id` | `Sales_Rep__c`, `Dealer__c` |
| `sundial_solar_cache` | `dealer_sf_id` (rep column already existed) | `Dealer__c` |
| `sundial_roofing_cache` | `dealer_sf_id` (rep column already existed) | `Dealer__c` |
| `sundial_user_cache` | `dealer_sf_id`, `access_level` | `Dealer__c`, `Access_Level__c` |

Plus eight `(client_sf_id, <col>)` indexes — **always** with the tenant key leading, because
`rowFilter()` puts `client_sf_id` in every branch it builds, tenant scope included.

**No Lambda change was needed, and that is by construction.** `sfFieldToColumn()` derives a
column name from the Salesforce field — name minus `__c`, lowercased, plus `_sf_id` when the
field type is `reference` — and `buildCacheSelect()` selects exactly the fields whose derived
name exists as a column. Creating the column *is* the wiring. Same pattern as
`sql/sundial_roofing_cache_name_columns.sql`.

> ⚠️ **The column names are not a free choice.** A column called `dealer_id` instead of
> `dealer_sf_id` would never be populated — silently. The sync would not error, the resync
> would report success, and the result would be a column of nulls, a row filter matching
> nothing, and a sales rep seeing an empty portal. The verification query in the SQL file
> counts `non_null` per column for exactly this reason: "the column exists" and "the column
> has data in it" are different questions, and only the second one matters.

**Why this kills the cache bypass.** The TEMP guard filters on a Salesforce field that is not
cached (`sales_rep_name` is a different, formula-derived field), so a restricted rep's reads
bypass the cache and go live to Salesforce — where SOQL `OFFSET` caps at 2000 and the deep
pages of a 3,511-row book are simply unreachable. With an indexed id column on the row, the
cache serves the filter and the whole book comes back in one request under the 5000-row page
cap (D-050).

**Until the column exists and is populated, a sales-role read must DENY, not fall back to
unfiltered.** `lib/access.js` does this: `rowFilter()` returns `MODULE_FORBIDDEN` when its
filter column is missing, and `rowMatchesFilter()` returns `false` for a row that lacks it.
That is the opposite of the `created_date` tolerance ("column absent → fall back to a stable
order") and deliberately so — there, absence degrades ordering; here it would remove a
security filter.

---

## Who may read a cache table — nobody with a browser

**`sql/sundial_access_p1_cache_hardening.sql` (D-064 A4, 2026-08-27).** Every
`sundial_*_cache` table has **ALL privileges revoked from `anon` and `authenticated`**.
The cache is service-role-only, and now structurally so rather than by convention.

Before that file was applied, `anon` and `authenticated` held `arwdDxtm` — the full
privilege set, INSERT/UPDATE/DELETE included — on all six tables. That was never a
decision; it is the Supabase default for a table created through the dashboard, and
nothing had ever narrowed it. The only thing standing between a logged-in browser session
and 31,640 customer rows was one RLS policy per table:

```sql
USING (tenant_id = current_user_tenant_id())
```

**and that policy denied by accident.** `current_user_tenant_id()` reads
`public.portal_users`, which holds zero rows, so it returns NULL for every session and
nothing matches. Three independent accidents were stacked, all failing closed, none
designed: the table was never populated, the grants were never narrowed, and
`profiles.tenant_id` holds the Salesforce record id while the cache tables' `tenant_id`
holds the slug — so even repointing the helper at `profiles` would have compared an id to
a slug and still denied, for a reason nobody had written down.

> ⚠️ **`public.portal_users` and `current_user_tenant_id()` were load-bearing accidents.**
> Populating that table, or repointing that helper at `profiles`, would have exposed the
> entire cache to any authenticated session with no per-rep scoping. Both edits read as
> obvious housekeeping — an abandoned empty table, and a helper whose near-namesake
> `current_user_tenant()` reads a different table, which looks exactly like a copy-paste
> bug someone should tidy. After the revoke both are harmless, because the grant they
> depended on is gone. **If the revoke has not been applied in some environment, apply it
> before tidying anything in that area.**

The revoke costs the portal nothing: no browser code reads a cache table. The single
browser Supabase client (`harmon-crm/src/lib/supabase.ts`, anon key) issues `.from()`
against exactly `comments`, `comment_mentions` and `user_preferences`. Every backend
reader — `sundial-sf-query`, `sundial-cache-sync`, `sundial-sf-update`,
`sundial-comment-notify`, the welcome-call writeback — sends the service-role key, and the
service role bypasses RLS. Verified file-by-file, 2026-08-27 (`access-model.md` §5.1c).

**The RLS policies were deliberately left in place.** The six `*_cache_select_tenant`
policies still exist and RLS is still enabled; the file changes grants only. Dropping the
policies is Phase 6, kept separate so its diff shows one thing. The order matters:
revoking while the policy still stands is belt *and* braces, whereas dropping the policy
while the grant stands would be neither.

**When a new cache table is created** — `sundial_commercial_cache`,
`sundial_service_cache`, `sundial_service_visit_cache` are all named above and do not
exist yet — it arrives with the same wide-open default. The hardening file also revokes
the schema's `default privileges` for `anon` and `authenticated`, which covers the next
table automatically, but add the explicit `revoke` line for each new table anyway so the
file stays a complete statement of what is closed.

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

---

## Corrections and additions — D-064 (2026-08-28)

This document predates the access model. Three things it says, or omits, are now wrong.

### 1. The isolation key is `client_sf_id`, not `tenant_id`

Both columns exist on every cache table and they are NOT interchangeable:

- **`client_sf_id`** — the Salesforce `Client__c` record id. **This is the isolation
  key.** Every cache query filters on it, and `rowFilter()` puts it in every branch.
- **`tenant_id`** — the human-readable slug (`harmon`). A label. Never used for
  isolation.

⚠️ Confusing them is a live hazard, not a style point: the inert RLS policies retired in
Phase 6 filtered `tenant_id = current_user_tenant_id()` where the function returned a
`client_sf_id`-shaped value from an empty table — which is exactly why they denied
everything by accident.

### 2. Freshness is the sync job's health, not a per-row TTL (D-079, 2026-10-05)

*Until 2026-10-05 this section read "The TTL is a flat 10 minutes": a row was trustworthy
only if `is_stale` was false AND `last_synced_at` was under 10 minutes old. With the sync
on no schedule, every Sales load after a quiet gap re-fetched all ~39k customers from
Salesforce — see PROGRESS.md 2026-10-05 for the measurements.*

**The rule** (`lambdas/sundial-sf-query/freshness.js`, used by the list read and the
single-record cache read alike):

1. Once per request, read the latest **ok incremental** run for the object from
   `public.cache_sync_runs` (memoised 60 s per warm Lambda container).
2. **Healthy** — it finished within **3 × the interval that run recorded**
   (`expected_interval_s`), or within `CACHE_SYNC_HEALTHY_MS` (default 15 min) for a run
   with no interval (a manual invoke). Then the cache is **authoritative**: a row is fresh
   iff `is_stale` is not true. The read only goes back to Salesforce for rows something
   explicitly flagged (a service Lambda's `markStale`, a write-through failure).
3. **Not healthy** — no run, an old run, a failed run, the table missing, the lookup
   erroring. Then the **old rule exactly**: `is_stale` false AND `last_synced_at` within
   `CACHE_TTL_MS` (default 10 min, now an env var). A dead schedule degrades to
   slow-but-correct, never to stale-and-silent.

Each request logs one JSON line `{"freshness":"sync"|"ttl", object, lastRunAt, barMs,
stale, soql, refetchMs, fields, …}` — CloudWatch Logs Insights:
`filter freshness = "ttl" | stats count(*) by object` shows any object the sync has
stopped covering.

**The schedule — two tiers** (`scripts/wire-cache-sync-schedule.ps1`):

| Rule | Rate | Objects | Healthy bar |
|---|---|---|---|
| `sundial-cache-sync-incremental` | 5 min | customer, solar, job, estimate, servicecall, serviceinvoice | 15 min |
| `sundial-cache-sync-incremental-cold` | 30 min | roofing, po, user, pricebookitem, serviceline, servicepayment, serviceplan, membership, dealer | 90 min |

Each rule passes `{ "objects": [...], "intervalMinutes": N }`; the interval rides on the
run row, so each object is judged by its own schedule. **Pause the hot rule during a full
resync** (`aws events disable-rule --name sundial-cache-sync-incremental --region us-west-1`,
`enable-rule` after) — the checklist is "Running a full resync" above. While it is paused the
freshness check falls back to the 10-minute TTL once the last run is over 15 minutes old;
that is slow-but-correct, by design. **Lag:** a change made directly
in Salesforce shows in the portal within one interval (≤5 min hot, ≤30 min cold) — the
old TTL allowed up to 10 minutes for everything.

**API cost.** A zero-change run is one SOQL per object: 6 × 288 + 9 × 48 = **~2,160
queries a day**, plus whatever actually changed (paged at 2,000 rows per query). Before:
the customer list alone re-fetched ~197 queries per stale Sales load — **~2,300 a day**
on the 2026-09-21 → 10-05 average, plus every other list. The win is latency and
predictability more than budget: the cost moves off the user's screen into a job.

**Formula columns.** `node scripts/check-cache-formula-coverage.mjs` lists every cached
formula column and the parent it is covered through, and exits 1 on any the sync cannot
keep fresh (TODAY()/NOW(), `$` globals, polymorphic lookups). On 2026-10-05: job's four
`estimate_*` columns via `Estimate__r`, customer/solar `sales_rep_name` via
`Sales_Rep__r`, nothing uncoverable. Re-run it after adding a formula column to a cache.

**Narrow list rows — `?fields=list`.** `LIST_PROJECTION` in `sundial-sf-query` names, per
object, the cache columns the list screens render; with `?fields=list` the SELECT and the
response carry only those (applied after the access projection, so it can only narrow).
Customer: 767 → 391 bytes/row. `pricebookitem` is deliberately absent: its edit modal
saves the list row back. `list-projection.test.js` holds each screen's column list with
file evidence — a screen that starts reading a new column must add it there and to the
registry, or the column renders blank.

**Compression.** API Gateway (`5sktfwldh1`) → Settings → Content encoding, minimum
1,024 bytes, then Deploy API to `prod`. API Gateway gzips any response over 1 KB for a
browser that sends `Accept-Encoding: gzip` (all of them). `sundial-sf-query` returns
plain JSON and never sets `isBase64Encoded`, so nothing in the Lambda changes. Measured
on customer: 767 → 77 bytes/row gzipped; with `?fields=list`, 40.

### 3. The row-filter columns, and what they replaced

Phase 1 added, per `sfFieldToColumn()`:

| Table | Columns |
|---|---|
| `sundial_customer_cache` | `sales_rep_sf_id`, `dealer_sf_id` |
| `sundial_solar_cache` | `sales_rep_sf_id`, `dealer_sf_id` |
| `sundial_roofing_cache` | `sales_rep_sf_id`, `dealer_sf_id` |
| `sundial_user_cache` | `dealer_sf_id`, `access_level`, `supabase_user_id` |

with `(client_sf_id, <column>)` indexes — tenant key first, because it leads every
predicate `rowFilter()` builds.

**This is what killed the live-SOQL bypass.** The TEMP guard filtered on a field that was
not cached, so a restricted rep's reads went live to Salesforce — where SOQL's OFFSET cap
of 2000 left roughly 1,500 of Dennis's 3,536 customers unreachable on deep pages. An id
equality on an indexed cache column has no such cap: his whole book is ONE request inside
the 5,000-row page (D-050).

### 4. Reads are now access-filtered before anything else

Under `ACCESS_MODEL_MODE=enforce`, `rowFilter()` is ANDed into the cache query **first**,
and every caller filter (`?q=`, `?parentId=`, `?field/value`) is ANDed after it. The
COUNT comes from the same builder as the page, so `total` is scoped by construction
rather than by a second thing somebody has to remember. No request input can widen it.

Cache rows are additionally **projected** to the caller's manifest columns before they
leave the Lambda (§4.3), so a column a role may not read never reaches the browser even
though it is stored.

## Reporting-grade cache (R0, 2026-10-30)

Reports run on the cache, never on Salesforce (D-087, `docs/reporting-module.md`). R0 makes
the cache wide enough to report on: **every field a detail layout shows is a cache column.**
What each table carries, and what was refused, is `docs/reporting-cache-coverage.md`.

### The rule (§4.1)

For each cached object, every field on its field-design workbook (any section) gets a cache
column, plus every field already cached. Objects with no workbook (`po`, `user`,
`membership`, `serviceplan`) get every field the integration user can read.

| Object key | Cache table | Field list |
|---|---|---|
| customer | `sundial_customer_cache` | `docs/Sundial_Customer__c_Field_Design.xlsx` (*Fields by Section*) |
| solar | `sundial_solar_cache` | `docs/Sundial_Solar_Fields_by_Section.xlsx` (*Fields by Section*) |
| roofing | `sundial_roofing_cache` | `docs/Sundial_Roofing_Fields_by_Section.xlsx` (*Field List (Module)*) |
| job / serviceinvoice / servicepayment | their cache tables | `docs/Sundial_Service_Job_Fields_by_Section.xlsx` (*Service Job / Invoice / Payment Fields*) |
| estimate / serviceline / pricebookitem | their cache tables | `docs/Sundial_Estimate_Fields_by_Section.xlsx` (*Estimate / Service Line / Price Book Item Fields*) |
| servicecall | `sundial_service_call_cache` | `docs/Sundial_Service_Call_Fields_by_Section.xlsx` (*Service Call Fields*) |
| po, user, membership, serviceplan | their cache tables | every readable describe field |

Column names come **only** from `sfFieldToColumn()` in `lib/cache-row.js` (lowercase, `__c`
stripped, reference fields suffixed `_sf_id`). That is why no code changes when a column is
added: `buildCacheSelect` selects every field whose column exists, so `sundial-cache-sync`
and `sundial-sf-query` fill it on the next sync.

**How a column is added.** `node scripts/generate-report-columns.mjs` reads the workbooks, a
live describe as the integration user (`lib/sf-describe.js` `getQueryableFields`), and the
live cache columns (PostgREST's OpenAPI document, the method the sync's `getCacheColumns`
uses). It writes `sql/2026-10-30_report_columns.sql` (one `alter table … add column if not
exists` per column, commented with the Salesforce API name and label) and the coverage
report. It never runs the SQL. Both files are deterministic: an unchanged state is an empty
diff, and `--check` exits 1 when either would change. The decisions are in
`lib/report-columns.js`, unit-tested with fixtures in `lib/report-columns.test.js`.

### The type map (§4.2)

| Salesforce describe type | Postgres |
|---|---|
| string, textarea, picklist, multipicklist, phone, email, url, id, encryptedstring | `text` |
| reference | `text` (column `<name>_sf_id`) |
| boolean | `boolean` |
| int | `integer` |
| double, currency, percent | `numeric` |
| date | `date` |
| datetime | `timestamptz` |
| formula | its result type (the describe reports it) |
| address, location, base64, anyType, anything else | **refused** |

### What the generator refuses, and reports (§4.3)

Nothing is guessed. Each of these is listed in the coverage report with its reason:

- **Name over 63 characters.** Postgres would truncate it and the sync would never match it.
- **Column collision.** Two Salesforce fields map to one column (`Name` / `Name__c`), or a
  field maps onto a control column the sync writes itself (`sf_id`, `created_date`,
  `is_stale` …). No new column; an existing one is left as it is.
- **Not readable.** The field is not in the integration user's describe. It becomes a
  **TIM: grant Read FLS** line and gets no column until it is readable. (A field that has
  not been created yet looks the same.)
- **Existing column, different type.** Left alone and reported (e.g. `sundial_solar_cache`
  `number_of_panels` is `integer`; the describe says double).
- **Unmapped type** (address, location, base64, anyType).
- **A new formula the sync cannot keep fresh** (TODAY() / NOW(), a `$` global, an
  unresolvable parent — the `lib/formula-parents.js` rules). A stale number in a report is a
  wrong number. Added 2026-10-30.
- **Sensitive.** Credentials (any API name ending in Password / Secret / Token, e.g.
  `Utility_Password__c`, an estimate's `Public_Token__c`) and `Sundial_User__c.Hourly_Cost_Rate__c`
  (a pay rate with no cache-read gate — `lib/cost-gate.js` covers only price-book and line
  costs). A cache column comes back on every cache read of its row, and a report never needs
  these. Added 2026-10-30.

Long-text fields **are** included (they are on the layouts). They stay out of
`LIST_PROJECTION` and out of list responses.

### The sync streams

`sundial-cache-sync` writes each Salesforce page (up to 2,000 records) before it fetches the
next (`lib/salesforce.js` `sfQueryPages`), in full and incremental mode. A full resync of a
470-column object no longer holds the whole object in memory. The rules it already had stay:

- The watermark moves **once**, after the last page, and only if every page's upsert
  succeeded. A failed page stops the run and leaves the watermark alone. The next run
  re-reads the window; pages already written are upserts, so writing them again is harmless.
- A zero-change run is still **one SOQL and no cache write** (`sync-runs.test.js`).
- Each row's tenant comes from **its own record's** `Client__c`, on every page. A record with
  no `Client__c` is skipped but still counts toward the watermark.

**The query-length ceiling.** `sfQuery` / `sfQueryPages` send the SOQL as a GET, and
Salesforce refuses a URI over 16,384 bytes. Every selected field adds its name to that URI.
The generator reports each table's incremental-sync URI length once its new columns exist.
After R0, solar is the widest at 14,278 bytes (13,725 after the D-090 field cleanup, 2026-11-04). A future wide addition to solar must be
checked against that column of the coverage report; past the limit, the sync has to split its
SELECT before the column can be added.

The Lambda runs at **1,024 MB / 15 min** from R0 on (it was sized for a ~50-column table).

### Running the resync (§4.5)

Once the SQL has run, the new columns are empty until a full resync. Wrap the whole
sequence in "Running a full resync — the checklist" above: **pause** the 5-minute rule
first, `vacuum (analyze)` every rewritten table after, **re-enable** the rule last — and
make sure `sql/2026-11-02_service_role_timeouts.sql` has run on the project.

1. **Delete `private.app_config` `stage_notify_url` first** and put it back after the
   customer / solar resyncs (D-074 am. 3). A full resync is upserts and moves no stage, but
   the design does not rely on that.
2. One object per Test event, `{ "object": "<key>", "mode": "full" }`, in this order:
   customer, solar, roofing, job, estimate, servicecall, serviceinvoice, servicepayment,
   serviceline, pricebookitem, then po, user, membership, serviceplan.
3. After customer: re-run `sql/sundial_dealer_customer_view.sql` (the dealer list reads that
   view; new customer columns reach it only when it is rebuilt).
4. After customer and solar: `node scripts/check-cache-formula-coverage.mjs`.
5. Then `{ "object": "<key>", "mode": "reconcile" }` per object, so records deleted in
   Salesforce do not inflate report counts (D-051).

Before the SQL and again after the resync, time both pipeline functions with `explain analyze`
(they are the only portal paths that scan whole tables). A regression over ~50 ms moves the
wide columns into a sibling `sundial_<object>_report` table keyed on `sf_id`. **Measure after
the vacuum**, never straight after the resync.

**Result (run 2026-11-02):** customer 85 → 85 ms; solar 22 → 179 ms right after the resync
(dead tuples), 32 ms after `vacuum (analyze)`. No sibling table — the wide tables stand.

## The dealer cache — reports only (D-089, 2026-11-04)

`sundial_dealer_cache` (`sql/sundial_dealer_cache.sql`) holds every readable
`Sundial_Dealer__c` field: name, active, internal, the two Acumatica vendor fields and the two
redline rates. It syncs on the cold 30-minute rule like any other object
(`OBJECT_ALLOWLIST.dealer`, created date = `CreatedDate`). **It exists so report types can join
the dealer** (customers, customers_solar, solar, roofing). It is **not** in `sundial-sf-query`'s
allowlist: the dealer roster stays an admin lookup served by `sundial-user-admin` from
Salesforce. **Seed it once** after the table exists with a full run of
`{ "object": "dealer", "mode": "full" }` (TASKS.md, Reporting R1b). After that the schedule
keeps it current.
