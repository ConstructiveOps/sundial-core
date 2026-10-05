-- 2026-10-05_sales_pipeline_indexes.sql — indexes for the Sales page's server-side reads
-- (D-080). Re-runnable.
--
--   (client_sf_id, status, stage)
--       GET /sf/customer/pipeline's GROUP BY (sundial_customer_pipeline), and a board
--       column's page: f[status]=…&f[stage]=….
--   (client_sf_id, status, created_date desc, sf_id)
--       The table: f[status]=… newest first, 500 at a time — the list's default order is
--       created_date DESC NULLS LAST, sf_id ASC, which this index serves without a sort.
--
-- `create index if not exists` without CONCURRENTLY: the customer cache is ~39k rows and
-- each build takes well under a second; CONCURRENTLY cannot run inside the SQL editor's
-- transaction anyway.

create index if not exists sundial_customer_cache_status_stage_idx
  on public.sundial_customer_cache (client_sf_id, status, stage);

create index if not exists sundial_customer_cache_status_created_idx
  on public.sundial_customer_cache (client_sf_id, status, created_date desc nulls last, sf_id);

-- Check:
--   select indexname from pg_indexes where tablename = 'sundial_customer_cache' and indexname like '%status%';
