-- sundial_service_visit_cache — Supabase cache table for the dispatch board window + tech day views.
--
-- Mirrors the sundial_roofing_cache pattern: a NARROW display subset (what the
-- portal's list/board/dispatch surfaces actually render) plus the standard control
-- columns every Sundial cache table carries. Detail views use
-- GET /sf/visit/{id}?full=true (describe-driven, live) and do NOT read this table.
--
-- HOW THIS POPULATES (no new code beyond the allowlist entries): column NAMES match
-- sfFieldToColumn() (strip __c, lowercase; reference fields get _sf_id). The read
-- and sync Lambdas select ONLY Salesforce fields whose mapped column exists here,
-- so creating this table makes visit records populate via read-through and the
-- scheduled sundial-cache-sync job. Add a column later and it starts caching.
--
-- TENANT ISOLATION: client_sf_id is the isolation key (D-035), NOT NULL;
-- tenant_id is the human slug (label only).

create table if not exists sundial_service_visit_cache (
  -- Control / identity (mirrors every Sundial cache table)
  sf_id                        text primary key,          -- Salesforce record Id
  client_sf_id                 text not null,             -- Client__c (tenant isolation key)
  tenant_id                    text,                      -- Client__r.Name slug (label only)

  -- Display subset:
  name                         text,        -- Name (auto-number SC-xxxxx)
  visit_type                   text,        -- Visit_Type__c (Service / installs - D-027 dual purpose)
  sundial_service_sf_id        text,        -- Sundial_Service__c (parent ticket; board join key)
  sundial_solar_sf_id          text,        -- Sundial_Solar__c (install visits)
  sundial_roofing_sf_id        text,        -- Sundial_Roofing__c (install visits)
  tech_sf_id                   text,        -- Tech__c (board ROW key)
  visit_sub_type               text,        -- Visit_Sub_Type__c
  status                       text,        -- Status__c (Scheduled/En Route/In Progress/... - board colors)
  scheduled_start              timestamptz, -- Scheduled_Start__c (board window filter)
  scheduled_end                timestamptz, -- Scheduled_End__c
  actual_start                 timestamptz, -- Actual_Start__c (first clock-in)
  actual_end                   timestamptz, -- Actual_End__c (last clock-out)
  duration_minutes             numeric,     -- Duration_Minutes__c (interval sum - payroll AND billing)
  geofence_verified            boolean,     -- Geofence_Verified__c (tag, not blocker)
  bill_to_type                 text,          -- Bill_To_Type__c (per-visit override; blank = inherit ticket

  created_date                 timestamptz, -- CreatedDate (list ordering, newest first)
  last_synced_at               timestamptz not null default now(),
  cache_version                integer not null default 1,
  is_stale                     boolean not null default false
);

create index if not exists idx_sundial_service_visit_cache_tenant
  on sundial_service_visit_cache (client_sf_id);
-- THE board query: visits in a time window, grouped into tech rows:
create index if not exists idx_sundial_service_visit_cache_window
  on sundial_service_visit_cache (client_sf_id, scheduled_start);
create index if not exists idx_sundial_service_visit_cache_tech
  on sundial_service_visit_cache (client_sf_id, tech_sf_id, scheduled_start);
create index if not exists idx_sundial_service_visit_cache_ticket
  on sundial_service_visit_cache (client_sf_id, sundial_service_sf_id);
create index if not exists idx_sundial_service_visit_cache_created
  on sundial_service_visit_cache (client_sf_id, created_date desc nulls last, sf_id);
create index if not exists idx_sundial_service_visit_cache_stale
  on sundial_service_visit_cache (client_sf_id, is_stale) where is_stale = true;
