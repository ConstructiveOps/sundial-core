-- sundial_cache_sync_runs.sql — the run log that makes the cache authoritative (D-079, 2026-10-05).
--
-- sundial-cache-sync writes ONE row per object per run (ok or not). sundial-sf-query reads
-- the latest ok INCREMENTAL row per object (once per request, memoised 60 s per warm
-- container) and decides:
--   finished within 3 × expected_interval_s (or CACHE_SYNC_HEALTHY_MS, default 15 min, when
--   no interval was recorded)  →  the cache is authoritative: a row is fresh iff not is_stale
--   otherwise                  →  the old rule: is_stale false AND last_synced_at < 10 min
--
-- Service role only: RLS on, NO policies, and browser roles revoked — the browser never
-- reads this; only the two Lambdas do, with the service-role key.
-- The sync Lambda prunes rows older than 14 days on every run. Re-runnable.

create table if not exists public.cache_sync_runs (
  id                  bigint generated always as identity primary key,
  object              text        not null,             -- customer | solar | job | … (the Lambdas' object key)
  mode                text        not null,             -- incremental | full | reconcile
  started_at          timestamptz not null,
  finished_at         timestamptz,
  ok                  boolean     not null default false,
  rows_upserted       int         not null default 0,
  watermark           timestamptz,                      -- the SystemModstamp cursor after the run
  error               text,                             -- short reason when not ok (never record data)
  expected_interval_s int                               -- the schedule this run belongs to (300 hot / 1800 cold); null = manual
);

-- The freshness lookup: latest ok incremental run for one object.
create index if not exists cache_sync_runs_health_idx
  on public.cache_sync_runs (object, finished_at desc)
  where ok and mode = 'incremental';

-- The prune.
create index if not exists cache_sync_runs_started_idx
  on public.cache_sync_runs (started_at);

alter table public.cache_sync_runs enable row level security;
revoke all on public.cache_sync_runs from anon, authenticated;

-- Check: the newest run per object, and whether it would count as healthy right now.
--   select distinct on (object) object, mode, ok, finished_at, expected_interval_s,
--          now() - finished_at as age
--   from public.cache_sync_runs where mode = 'incremental'
--   order by object, finished_at desc;
