-- sundial_service_activity — the Service module's activity tracker (D-072 amendment 2,
-- 2026-09-11; lib/service-activity.js; docs/service-data-model.md §11).
--
-- One append-only row per thing that happened to a job / estimate / line / invoice /
-- price-book item: the EVENT, the ACTOR (Sundial user), a TIMESTAMP, and a small JSON
-- `details` object (fields changed with old -> new, version numbers, line ids).
-- Written best-effort by sundial-service-estimate and sundial-sf-update AFTER the
-- Salesforce write succeeds. Read by GET /service/jobs/{id}/activity and
-- GET /service/estimates/{id}/activity (tenant-scoped, newest first).
--
-- Keyed by BOTH job and estimate: an estimate that pre-dates its job logs with a null
-- job_sf_id, and Create Job back-fills job_sf_id on those rows so the job's feed starts
-- at the first quote.
--
-- TENANT ISOLATION: client_sf_id is the isolation key (D-035), NOT NULL, and every read
-- filters on it. The service-role key bypasses RLS; the Lambdas filter explicitly.
--
-- NOT a cache table: nothing here mirrors Salesforce, so there are no control columns
-- (last_synced_at / is_stale) and the scheduled sync never touches it.

create table if not exists sundial_service_activity (
  id                bigint generated always as identity primary key,
  client_sf_id      text not null,                       -- Client__c (tenant isolation key)
  tenant_id         text,                                -- Client__r.Name slug (label only)
  event             text not null,                       -- lib/service-activity.js EVENTS
  record_type       text,                                -- job | estimate | serviceline | servicecall | serviceinvoice | servicepayment | pricebookitem | customer
  record_sf_id      text,                                -- the record the event is about
  job_sf_id         text,                                -- Sundial_Service_Job__c id (null until the estimate has a job)
  estimate_sf_id    text,                                -- Sundial_Estimate__c id
  actor_user_sf_id  text,                                -- Sundial_User__c id (null for system / webhook events)
  actor_name        text,                                -- display name at the time (users get renamed; history should not)
  details           jsonb not null default '{}'::jsonb,  -- { fields: { F: { from, to } }, version, lineId, ... }
  at                timestamptz not null default now()
);

-- The job feed (newest first) and the estimate feed.
create index if not exists idx_sundial_service_activity_job
  on sundial_service_activity (client_sf_id, job_sf_id, at desc);
create index if not exists idx_sundial_service_activity_estimate
  on sundial_service_activity (client_sf_id, estimate_sf_id, at desc);
-- "What did this person do today" — manager view, later.
create index if not exists idx_sundial_service_activity_actor
  on sundial_service_activity (client_sf_id, actor_user_sf_id, at desc);
-- Per-record history (a line, an invoice, a price-book item).
create index if not exists idx_sundial_service_activity_record
  on sundial_service_activity (client_sf_id, record_sf_id, at desc);

-- Realtime: enable in the Supabase dashboard (Database -> Replication -> add this
-- table) so an open job page receives new rows without polling. Optional.
