-- sundial_reports.sql — saved reports and CSV export jobs (D-089, Reporting R1b;
-- docs/reporting-module.md §6.6–6.7). Served by lambdas/sundial-reports (saved.js, csv.js).
--
-- public.sundial_reports — a saved report definition.
--   definition  the report definition as the OWNER could see it when they saved it (their
--               gated columns already stripped). It is re-validated for whoever RUNS it, so a
--               Manager running an Admin's shared report never sees a cost column.
--   sharing     'private' (the owner only) | 'tenant' (everyone in the owner's tenant who has
--               reports.read). Only reports.share (Admin / Executive) may set 'tenant'; the
--               owner may always set their own back to 'private'.
--   VISIBLE to a caller = same client_sf_id AND (owner OR sharing = 'tenant'). Anything else
--   is 404 RECORD_NOT_FOUND — the same answer as a report that does not exist.
--   owner_profile_id / created_by / updated_by are profiles.id (= auth.users.id, the JWT sub).
--   No foreign key: a deleted login must not delete the reports others rely on, and the
--   service role is the only writer (it takes the id from the verified JWT, never a body).
--
-- public.sundial_report_exports — one CSV export (POST /reports/csv, GET /reports/{id}/csv).
--   The POST validates the definition, writes a 'queued' row and starts the export in the
--   background (the Lambda invokes itself with { task: "csv", exportId }); the worker claims
--   the row (queued → running, so a retried invoke never runs it twice), pages
--   sundial_report_run into S3 and marks it 'done' (s3_key, row_count, truncated) or
--   'failed' (error_code). GET /reports/csv/{exportId} reads it: VISIBLE to its owner in its
--   tenant only (exports are never shared) — anything else 404.
--   job  { type, wire, output, rowLimit, stripped, objects } — what normalizeDefinition()
--        produced for the caller at POST time; the worker runs exactly that.
--   The CSV itself is in sfsolproj under REPORTS/<client_sf_id>/<date>/<id>.csv and expires
--   after 7 days (the bucket lifecycle rule, scripts/add-reports-lifecycle.ps1).
--
-- WHO MAY READ THEM: the service role only (RLS on, no policies, browser roles revoked) —
-- every read and write goes through sundial-reports. Re-runnable.

create table if not exists public.sundial_reports (
  id               uuid primary key default gen_random_uuid(),
  client_sf_id     text not null,
  owner_profile_id uuid not null,
  name             text not null check (char_length(btrim(name)) between 1 and 120),
  description      text check (description is null or char_length(description) <= 2000),
  definition       jsonb not null check (jsonb_typeof(definition) = 'object'),
  sharing          text not null default 'private' check (sharing in ('private', 'tenant')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid not null,
  updated_by       uuid not null
);

create index if not exists idx_sundial_reports_owner
  on public.sundial_reports (client_sf_id, owner_profile_id, created_at desc);
create index if not exists idx_sundial_reports_shared
  on public.sundial_reports (client_sf_id, created_at desc) where sharing = 'tenant';

alter table public.sundial_reports enable row level security;
revoke all privileges on table public.sundial_reports from public, anon, authenticated;
grant all privileges on table public.sundial_reports to service_role;

create table if not exists public.sundial_report_exports (
  id               uuid primary key default gen_random_uuid(),
  client_sf_id     text not null,
  owner_profile_id uuid not null,
  report_id        uuid,                       -- the saved report it came from (no FK: a deleted report keeps its exports)
  report_type      text not null,
  status           text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  job              jsonb not null check (jsonb_typeof(job) = 'object'),
  s3_key           text check (s3_key is null or s3_key like 'REPORTS/%'),
  row_count        integer,
  truncated        boolean,
  error_code       text,
  as_of            timestamptz,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

create index if not exists idx_sundial_report_exports_owner
  on public.sundial_report_exports (client_sf_id, owner_profile_id, created_at desc);

alter table public.sundial_report_exports enable row level security;
revoke all privileges on table public.sundial_report_exports from public, anon, authenticated;
grant all privileges on table public.sundial_report_exports to service_role;

-- Check (in the SQL editor) — two rows; rls true and both privilege columns false on each:
select c.relname as table_name,
       c.relrowsecurity as rls,
       has_table_privilege('anon', c.oid, 'select') as anon_can_read,
       has_table_privilege('authenticated', c.oid, 'select') as authenticated_can_read
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('sundial_reports', 'sundial_report_exports')
 order by 1;
