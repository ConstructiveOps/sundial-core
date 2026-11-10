-- 2026-11-10_report_schedules.sql — scheduled delivery of saved reports (D-091, Reporting R3;
-- docs/reporting-module.md §7). Served by lambdas/sundial-reports (schedule.js, deliver.js).
-- Run in the Supabase SQL editor AFTER sql/sundial_reports.sql (R1b). Re-runnable.
--
-- 1. public.sundial_reports gains its schedule and its run history:
--      schedule              jsonb { cadence, time, days?, dayOfMonth?, recipients, format, enabled }
--                            — validated by lib/report-schedule.js; null = not scheduled
--      next_run_at           the next slot (Arizona wall time → UTC); the tick claims a row by
--                            moving this forward WHERE it is still what the tick read
--      last_run_at           when the last delivery started
--      last_run_status       running | ok | partial | failed | disabled
--      last_run_error        a code (FAILURE_WORDS in lib/report-schedule.js), never an address
--      consecutive_failures  3 in a row turns the schedule off (and emails the owner once)
--      last_export_id        the export row of the delivery in flight — an outcome for any other
--                            export never overwrites it
--    Index: the tick's one read — enabled schedules by next_run_at.
-- 2. public.sundial_report_exports gains `delivery` jsonb: what a delivery did (status, sent,
--    failed, per-recipient SES message id). Recipient addresses stay in `job`, never in logs.
-- 3. public.sundial_report_downloads: one row per emailed download link (a file of 8 MB or
--    more). Only the token's SHA-256 is stored; the token is in the recipient's email alone.
--    expires_at = 7 days; download_count is the per-link limit (20).
--
-- WHO MAY READ THEM: the service role only, like the rest of the reports tables.

alter table public.sundial_reports
  add column if not exists schedule             jsonb check (schedule is null or jsonb_typeof(schedule) = 'object'),
  add column if not exists next_run_at          timestamptz,
  add column if not exists last_run_at          timestamptz,
  add column if not exists last_run_status      text check (last_run_status is null or last_run_status in ('running', 'ok', 'partial', 'failed', 'disabled')),
  add column if not exists last_run_error       text,
  add column if not exists consecutive_failures integer not null default 0,
  add column if not exists last_export_id       uuid;

create index if not exists idx_sundial_reports_due
  on public.sundial_reports (next_run_at)
  where (schedule ->> 'enabled') = 'true';

-- The lost-delivery sweep (a run still "running" 15 minutes on).
create index if not exists idx_sundial_reports_running
  on public.sundial_reports (last_run_at)
  where last_run_status = 'running';

alter table public.sundial_report_exports
  add column if not exists delivery jsonb;

create table if not exists public.sundial_report_downloads (
  token_hash       text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  export_id        uuid not null,
  client_sf_id     text not null,
  expires_at       timestamptz not null,
  download_count   integer not null default 0,
  last_download_at timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists idx_sundial_report_downloads_export on public.sundial_report_downloads (export_id);

alter table public.sundial_report_downloads enable row level security;
revoke all privileges on table public.sundial_report_downloads from public, anon, authenticated;
grant all privileges on table public.sundial_report_downloads to service_role;

-- Check (in the SQL editor): the two new columns exist and the browser roles see nothing.
select
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'sundial_reports'
     and column_name in ('schedule', 'next_run_at', 'last_run_at', 'last_run_status', 'last_run_error', 'consecutive_failures', 'last_export_id')) as report_columns_7,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'sundial_report_exports' and column_name = 'delivery') as export_delivery_1,
  has_table_privilege('anon', 'public.sundial_report_downloads', 'select') as anon_can_read_downloads_false,
  has_table_privilege('authenticated', 'public.sundial_report_downloads', 'select') as authenticated_can_read_downloads_false;
