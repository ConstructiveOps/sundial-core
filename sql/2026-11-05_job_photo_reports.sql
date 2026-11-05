-- sql/2026-11-05_job_photo_reports.sql — the Service module's PHOTO REPORT (D-072 amendment 17).
--
-- A customer-facing document modelled on Housecall Pro's photo report: a cover (title, Scope of
-- Work, cover photo), then sections that each hold many of the job's photos. It sits BESIDE the
-- old job report (Report_Sections__c on the job, D-072 amendment 10), which is untouched.
--
-- WHY SUPABASE, NOT SALESFORCE. The report is portal content (photo keys + the office's words),
-- up to 60 sections / 300 photos — far past what a long-text field should carry — and nothing
-- in Salesforce reports on it. The job keeps its one link to it by id (job_sf_id).
--
--   sundial_job_photo_reports         ONE row per job (job_sf_id unique): the report, its public
--                                     token, the last sent PDF, the send count.
--   sundial_job_photo_report_renders  one row per PDF made in the BACKGROUND (a send or a
--                                     download that does not fit API Gateway's 29 s): the Lambda
--                                     invokes itself, the row carries the status, the portal polls.
--
-- WHO MAY READ THEM: the service role only. RLS on, no policies, browser roles revoked — every
-- read and write goes through sundial-service-estimate (office) or sundial-service-public (the
-- customer's page, by token). Idempotent: safe to run again.

create table if not exists public.sundial_job_photo_reports (
  id               uuid primary key default gen_random_uuid(),
  client_sf_id     text not null,                    -- the job's Client__c (the Lambda's tenantId)
  job_sf_id        text not null unique,             -- ONE report per job
  cover            jsonb not null default '{}'::jsonb,
  sections         jsonb not null default '[]'::jsonb,
  receipt          boolean not null default false,   -- off until ticked (the old report defaults on)
  public_token     text unique,
  token_expires_at timestamptz,
  pdf_key          text,                             -- SUNDIAL/{jobId}/photo-report-{n}.pdf of the last send
  sent_at          timestamptz,
  sent_count       integer not null default 0,
  sent_by_name     text,                             -- "Prepared by" on the customer's page
  sent_report      jsonb,                            -- the report AS SENT: what the customer's link shows
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- A table made by an earlier run of this file gets the later column.
alter table public.sundial_job_photo_reports add column if not exists sent_report jsonb;
create index if not exists idx_sundial_job_photo_reports_client on public.sundial_job_photo_reports (client_sf_id);

create table if not exists public.sundial_job_photo_report_renders (
  id            uuid primary key default gen_random_uuid(),
  client_sf_id  text not null,
  job_sf_id     text not null,
  kind          text not null check (kind in ('send', 'download')),
  status        text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  request       jsonb not null default '{}'::jsonb,  -- the send box / who asked; never logged
  result        jsonb,                               -- delivery, recipient, pdfKey, sentCount …
  error_code    text,
  pdf_key       text,                                -- send: SUNDIAL/…; download: REPORTS/…
  hops          integer not null default 0,          -- how many times the worker handed itself on
  created_by    uuid,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
create index if not exists idx_sundial_job_photo_report_renders_job on public.sundial_job_photo_report_renders (job_sf_id, created_at desc);

-- updated_at follows every write to the report.
create or replace function public.sundial_job_photo_reports_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_sundial_job_photo_reports_touch on public.sundial_job_photo_reports;
create trigger trg_sundial_job_photo_reports_touch before update on public.sundial_job_photo_reports
  for each row execute function public.sundial_job_photo_reports_touch();

alter table public.sundial_job_photo_reports enable row level security;
alter table public.sundial_job_photo_report_renders enable row level security;
revoke all privileges on table public.sundial_job_photo_reports from public, anon, authenticated;
revoke all privileges on table public.sundial_job_photo_report_renders from public, anon, authenticated;
revoke all on function public.sundial_job_photo_reports_touch() from public, anon, authenticated;
grant all privileges on table public.sundial_job_photo_reports to service_role;
grant all privileges on table public.sundial_job_photo_report_renders to service_role;
