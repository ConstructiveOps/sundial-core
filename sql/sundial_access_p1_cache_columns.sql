-- Sundial access model, Phase 1 item 5 — the row-filter columns on the cache tables.
-- D-064, docs/access-model.md §3.3. Apply AFTER salesforce/v6-access-model/ is deployed
-- and AFTER scripts/backfill-deal-ownership.mjs --apply has run.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR (project qfsdpkwxahakegjnyijj), as Tim.
-- Then Claude runs `sundial-cache-sync {"mode":"full"}` per object and reconciles the
-- counts by sales_rep_sf_id against SOQL.
--
-- ============================================================================
-- WHAT THIS IS FOR: killing the cache bypass
-- ============================================================================
--
-- Today a restricted rep's list, single and full reads BYPASS the cache entirely and go
-- live to Salesforce, because the field the TEMP guard filters on is not cached (the
-- cache's `sales_rep_name` is a different, formula-derived field that is blank or wrong
-- for Dennis's 3,511 customers). That bypass carries a real cost: SOQL OFFSET caps at
-- 2000, so on the customer list a rep can page the first ~2000 of 3,511 rows and the
-- rest are simply unreachable. Safe, but incomplete.
--
-- With `sales_rep_sf_id` and `dealer_sf_id` on the row, the filter becomes an id
-- equality on an indexed column and the cache serves it: Dennis's 3,511 customers come
-- back in ONE request under the 5000-row page cap (D-050), and the OFFSET clamp stops
-- mattering because nothing pages live SOQL any more.
--
-- ============================================================================
-- NO LAMBDA CHANGE IS NEEDED, AND THAT IS BY CONSTRUCTION
-- ============================================================================
--
-- `sfFieldToColumn()` (lambdas/sundial-cache-sync/index.js:172, mirrored in
-- sundial-sf-query) derives a cache column name from the Salesforce field:
--
--     name minus the __c, lowercased, plus "_sf_id" when the field type is `reference`
--
--     Sales_Rep__c    reference -> sales_rep_sf_id
--     Dealer__c       reference -> dealer_sf_id
--     Access_Level__c picklist  -> access_level
--
-- The sync then selects exactly the fields whose derived name EXISTS as a column
-- (`buildCacheSelect`), so creating the column is the entire wiring. This is the same
-- pattern sql/sundial_roofing_cache_name_columns.sql used, and the reason the column
-- names below are not a free choice: a column named `dealer_id` would simply never be
-- populated, silently, and the filter would match nothing.
--
-- ⚠️ UNTIL THESE COLUMNS EXIST AND ARE POPULATED, A SALES-ROLE READ MUST **DENY**, NOT
-- fall back to unfiltered. lib/access.js already does this -- rowFilter() returns
-- MODULE_FORBIDDEN when the filter column is missing, and rowMatchesFilter() returns
-- false for a row that lacks it. That is the OPPOSITE of the `created_date` tolerance
-- ("column absent -> fall back to a stable order"), and deliberately: there, absence
-- degrades ordering; here, absence would remove a security filter.
--
-- ============================================================================
-- CURRENT STATE, from sql/live-snapshot-2026-08-27.sql section 2
-- ============================================================================
--
--   sundial_customer_cache   NEITHER column. Only `sales_rep_name` (a display string).
--   sundial_solar_cache      HAS sales_rep_sf_id (ordinal 10). No dealer_sf_id.
--   sundial_roofing_cache    HAS sales_rep_sf_id (ordinal 11). No dealer_sf_id.
--   sundial_user_cache       Neither dealer_sf_id nor access_level.
--
-- Every statement below is `add column if not exists` / `create index if not exists`,
-- so re-running is a no-op and the two tables that already carry a rep column are left
-- exactly as they are.
--
-- Roofing gets the columns even though the module is DENIED to every sales scope
-- (§3.1). That is not inconsistency: the module gate and the data model are separate
-- decisions, and the day roofing opens to a dealer the column is already there and
-- populated rather than being a migration under time pressure. lib/access.js encodes
-- the same split -- OBJECT_ACCESS.roofing carries both filter columns AND
-- `salesScopes: false`, with a unit test asserting the two do not get conflated.

begin;

-- --- Customer ---------------------------------------------------------------
alter table public.sundial_customer_cache
  add column if not exists sales_rep_sf_id text,   -- Sales_Rep__c
  add column if not exists dealer_sf_id    text;   -- Dealer__c

-- --- Solar ------------------------------------------------------------------
alter table public.sundial_solar_cache
  add column if not exists sales_rep_sf_id text,   -- already present; kept for completeness
  add column if not exists dealer_sf_id    text;

-- --- Roofing ----------------------------------------------------------------
alter table public.sundial_roofing_cache
  add column if not exists sales_rep_sf_id text,   -- already present
  add column if not exists dealer_sf_id    text;

-- --- User -------------------------------------------------------------------
-- §3.5: `GET /sf/users` for a sales role returns "my own dealer's people UNION Harmon
-- staff". Both halves of that predicate are columns here, so the mentions picker and
-- the rep dropdown can be cache-served and can agree with the Lambda.
--
-- access_level is the RAW Access_Level__c string, not the derived scope. The scope is
-- computed by lib/access.js from the level; storing the derived value here as well
-- would create a second place for the mapping to live, and the two would disagree the
-- first time the scope table changed.
alter table public.sundial_user_cache
  add column if not exists dealer_sf_id text,      -- Dealer__c
  add column if not exists access_level text;      -- Access_Level__c

-- --- Indexes ----------------------------------------------------------------
-- ALWAYS (client_sf_id, <col>), never <col> alone. The tenant key leads because it is
-- the first term of every filter rowFilter() builds -- it is present in EVERY branch,
-- including tenant scope (lib/access.js). A single-column index on the rep would not
-- serve the composite predicate nearly as well, and the two-column form also serves
-- tenant-only queries as a prefix scan.
--
-- client_sf_id is the isolation key (the Salesforce Client record id). NOT tenant_id,
-- which holds the slug. Both exist on these tables and confusing them is a live hazard
-- here: it is exactly the mismatch that makes current_user_tenant_id() deny (§5.1b).
create index if not exists idx_customer_cache_rep
  on public.sundial_customer_cache (client_sf_id, sales_rep_sf_id);
create index if not exists idx_customer_cache_dealer
  on public.sundial_customer_cache (client_sf_id, dealer_sf_id);

create index if not exists idx_solar_cache_rep
  on public.sundial_solar_cache (client_sf_id, sales_rep_sf_id);
create index if not exists idx_solar_cache_dealer
  on public.sundial_solar_cache (client_sf_id, dealer_sf_id);

create index if not exists idx_roofing_cache_rep
  on public.sundial_roofing_cache (client_sf_id, sales_rep_sf_id);
create index if not exists idx_roofing_cache_dealer
  on public.sundial_roofing_cache (client_sf_id, dealer_sf_id);

create index if not exists idx_user_cache_dealer
  on public.sundial_user_cache (client_sf_id, dealer_sf_id);
create index if not exists idx_user_cache_access_level
  on public.sundial_user_cache (client_sf_id, access_level);

commit;


-- ============================================================================
-- VERIFICATION 1 — the columns and indexes exist. Run right after the block above.
-- ============================================================================
-- EXPECTED: 10 column rows (2 per cache table, 2 on user_cache) and 8 index rows.
-- The columns will all be EMPTY at this point; the full resync populates them.

select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('sundial_customer_cache','sundial_solar_cache',
                     'sundial_roofing_cache','sundial_user_cache')
  and column_name in ('sales_rep_sf_id','dealer_sf_id','access_level')
order by table_name, column_name;

select tablename, indexname
from pg_indexes
where schemaname = 'public'
  and indexname in ('idx_customer_cache_rep','idx_customer_cache_dealer',
                    'idx_solar_cache_rep','idx_solar_cache_dealer',
                    'idx_roofing_cache_rep','idx_roofing_cache_dealer',
                    'idx_user_cache_dealer','idx_user_cache_access_level')
order by tablename, indexname;


-- ============================================================================
-- VERIFICATION 2 — the columns are POPULATED. Run AFTER Claude's full resync.
-- ============================================================================
-- The one that matters is Dennis: 3,534 customers and 777 solar projects under
-- sales_rep_sf_id = 'a1O7y00000s5sK1EAI'. Those two numbers are the Phase 1 gate, and
-- they are checked against SOQL rather than against this query alone -- a cache that
-- agrees with itself proves nothing.
--
-- ⚠️ A COLUMN THAT IS STILL ALL-NULL AFTER A RESYNC IS THE FAILURE MODE TO WATCH FOR,
-- and it is silent: the sync selects only fields whose derived column name exists, so a
-- misspelled column is not an error anywhere -- it is a column of nulls, a filter that
-- matches nothing, and a rep who sees an empty portal at Phase 3. `non_null` below is
-- what catches it.

select 'customer' as object,
       count(*)                                             as rows,
       count(sales_rep_sf_id)                               as rep_non_null,
       count(dealer_sf_id)                                  as dealer_non_null,
       count(*) filter (where sales_rep_sf_id = 'a1O7y00000s5sK1EAI') as dennis
from public.sundial_customer_cache
union all
select 'solar',
       count(*), count(sales_rep_sf_id), count(dealer_sf_id),
       count(*) filter (where sales_rep_sf_id = 'a1O7y00000s5sK1EAI')
from public.sundial_solar_cache
union all
select 'roofing',
       count(*), count(sales_rep_sf_id), count(dealer_sf_id), 0
from public.sundial_roofing_cache
union all
select 'user',
       count(*), 0, count(dealer_sf_id), count(access_level)
from public.sundial_user_cache;

-- Expected after the resync (the `user` row reads: rows, -, dealer_non_null, access_level_non_null):
--
--   object    rows     rep_non_null  dealer_non_null  dennis
--   customer  31,640         ~14,124           ~4,312   3,534
--   solar      4,481          ~3,262           ~1,203     777
--   roofing        2               ?                ?       0
--   user         133               -              ~44     ~24
--
-- rep_non_null tracks Sales_Rep__c populated in Salesforce (14,124 / 3,262 as of the
-- Phase 0 describe); dealer_non_null tracks what backfill-deal-ownership.mjs wrote.
-- Exact numbers drift by a row or two on a live org — the shapes do not, and `dennis`
-- must be exactly 3,534 / 777.
