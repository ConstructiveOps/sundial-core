-- sundial_service_call_cache — Supabase cache table for Sundial_Service_Call__c (Service Call, D-072).
--
-- Mirrors the sundial_roofing_cache pattern: the display subset the portal's list/board/
-- grid surfaces render, plus the standard control columns every Sundial cache table
-- carries. Detail views use GET /sf/servicecall/{id}?full=true (describe-driven, live).
--
-- HOW THIS POPULATES: column NAMES match sfFieldToColumn() (strip __c, lowercase;
-- reference fields get _sf_id). The read and sync Lambdas select ONLY Salesforce fields
-- whose mapped column exists here, so creating this table makes servicecall records populate via
-- read-through and the scheduled sundial-cache-sync job. Add a column later and it starts
-- caching. GENERATED from the same spec as the .object files - edit the spec, not this.
--
-- TENANT ISOLATION: client_sf_id is the isolation key (D-035), NOT NULL;
-- tenant_id is the human slug (label only).

create table if not exists sundial_service_call_cache (
  -- Control / identity
  sf_id                       text primary key,          -- Salesforce record Id
  client_sf_id                text not null,             -- Client__c (tenant isolation key)
  tenant_id                   text,                      -- Client__r.Name slug (label only)

  -- Display subset
  name                        text,        -- Name (auto-number)
  visit_type                  text,        -- Visit_Type__c (Drives which parent lookup must be populated and which PWA t...)
  sundial_service_job_sf_id   text,        -- Sundial_Service_Job__c (Parent job - required (via validation) when Visit Type = Ser...)
  sundial_solar_sf_id         text,        -- Sundial_Solar__c (Parent when Visit Type = Solar Install.)
  sundial_roofing_sf_id       text,        -- Sundial_Roofing__c (Parent when Visit Type = Roofing Install.)
  sundial_commercial_sf_id    text,        -- Sundial_Commercial__c (Parent when Visit Type = Commercial Install. REMOVE from the...)
  tech_sf_id                  text,        -- Tech__c (ONE tech per call. A multi-tech job is parallel records unde...)
  visit_sub_type              text,        -- Visit_Sub_Type__c
  scheduled_start             timestamptz, -- Scheduled_Start__c (Set by the dispatch board (block drop / resize).)
  scheduled_end               timestamptz, -- Scheduled_End__c (Default length = sum of the estimate's labor Estimated_Hours...)
  status                      text,        -- Status__c (Unscheduled = created without a window (sits in the dispatch...)
  actual_start                timestamptz, -- Actual_Start__c (FIRST clock-in (device tap-time, not sync-time).)
  actual_end                  timestamptz, -- Actual_End__c (LAST clock-out; re-clock-in reopens the call.)
  duration_minutes            numeric,     -- Duration_Minutes__c (Sum of the intervals in Clock Intervals - NOT end minus star...)
  clock_in_latitude           numeric,     -- Clock_In_Latitude__c (GPS at first clock-in (null when no fix - never blocks).)
  clock_in_longitude          numeric,     -- Clock_In_Longitude__c
  clock_out_latitude          numeric,     -- Clock_Out_Latitude__c
  clock_out_longitude         numeric,     -- Clock_Out_Longitude__c
  geofence_verified           boolean,     -- Geofence_Verified__c (All clock events within the per-tenant radius of the service...)
  checklist_template_key      text,        -- Checklist_Template_Key__c (Per-tenant config key assigned at scheduling (D-065.9).)
  photos_count                numeric,     -- Photos_Count__c (Count of photos at SUNDIAL/{jobId}/photos/{callId}/ (metadat...)
  billable_to_customer        boolean,     -- Billable_to_Customer__c (Office opt-in: bill this call's hours to the customer as a L...)
  billable_hours              numeric,     -- Billable_Hours__c (Hours billed. Blank = derived from the clock (Duration Minut...)
  bill_rate                   numeric,     -- Bill_Rate__c (Hourly rate billed for this call. Blank = the tech's Hourly ...)

  created_date                timestamptz, -- CreatedDate (list ordering)
  last_synced_at              timestamptz not null default now(),
  cache_version               integer not null default 1,
  is_stale                    boolean not null default false
);

create index if not exists idx_sundial_service_call_cache_tenant
  on sundial_service_call_cache (client_sf_id);
create index if not exists idx_sundial_service_call_cache_window
  on sundial_service_call_cache (client_sf_id, scheduled_start);
create index if not exists idx_sundial_service_call_cache_tech_window
  on sundial_service_call_cache (client_sf_id, tech_sf_id, scheduled_start);
create index if not exists idx_sundial_service_call_cache_job
  on sundial_service_call_cache (client_sf_id, sundial_service_job_sf_id);
create index if not exists idx_sundial_service_call_cache_recent
  on sundial_service_call_cache (client_sf_id, created_date desc nulls last, sf_id);
create index if not exists idx_sundial_service_call_cache_stale
  on sundial_service_call_cache (client_sf_id, is_stale) where is_stale = true;
