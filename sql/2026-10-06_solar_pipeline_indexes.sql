-- 2026-10-06_solar_pipeline_indexes.sql — the one index the Solar page's server-side
-- reads earn (D-080 amendment 1). Re-runnable.
--
--   (client_sf_id, stage, created_date desc nulls last, sf_id)
--       A board column's page: f[stage]=… in the list's default order (created_date
--       DESC NULLS LAST, sf_id ASC), read straight off the index: no tenant filter, no
--       sort step. Measured BEFORE it (live, 2026-10-06, warm):
--         stage = 'Archive' (2,913 rows), first 500 — walks idx_solar_cache_client_created
--           and filters out the other stages: 1.4 ms (257 ms on a cold buffer cache);
--         stage = 'Permitting' (15 rows) — idx_solar_cache_stage, which is keyed on
--           tenant_id (the slug), not client_sf_id, then filters the tenant and sorts.
--       At 4.5k rows the gain is small, honestly; it is here so a rare stage never walks
--       the whole tenant's created_date index, and so the plan stays flat as the table
--       grows. (The Supabase MCP connection is read-only, so the AFTER plan is the check
--       at the bottom — run it once the index exists.)
--
-- NOT ADDED, on measurement (EXPLAIN ANALYZE on the live table, 2026-10-06, 4,522 Harmon
-- rows):
--   - nothing for sundial_solar_pipeline's GROUP BY: it reads the whole tenant, and a
--     sequential scan of 4.5k rows is the right plan for that;
--   - nothing per sort column (project_name, utility_company, …): a sorted page sorts at
--     most one stage's rows (Archive, 2,913, is the largest) with a top-N heapsort in
--     well under a millisecond of CPU; eleven indexes would cost every cache write more
--     than they save. Revisit if a tenant's solar cache grows past ~50k rows.
--
-- `create index if not exists` without CONCURRENTLY: the build takes well under a
-- second, and CONCURRENTLY cannot run inside the SQL editor's transaction anyway.

create index if not exists sundial_solar_cache_stage_created_idx
  on public.sundial_solar_cache (client_sf_id, stage, created_date desc nulls last, sf_id);

-- Check — the index exists, and (optional) the plan now names it:
--   explain analyze select sf_id from public.sundial_solar_cache
--    where client_sf_id = 'a1W7y000007AszBEAS' and stage = 'Permitting'
--    order by created_date desc nulls last, sf_id limit 500;
select indexname from pg_indexes where tablename = 'sundial_solar_cache' and indexname = 'sundial_solar_cache_stage_created_idx';
