-- sundial_service_cache — Supabase cache table for the Service Ticket list/board + My Queue.
--
-- Mirrors the sundial_roofing_cache pattern: a NARROW display subset (what the
-- portal's list/board/dispatch surfaces actually render) plus the standard control
-- columns every Sundial cache table carries. Detail views use
-- GET /sf/service/{id}?full=true (describe-driven, live) and do NOT read this table.
--
-- HOW THIS POPULATES (no new code beyond the allowlist entries): column NAMES match
-- sfFieldToColumn() (strip __c, lowercase; reference fields get _sf_id). The read
-- and sync Lambdas select ONLY Salesforce fields whose mapped column exists here,
-- so creating this table makes service records populate via read-through and the
-- scheduled sundial-cache-sync job. Add a column later and it starts caching.
--
-- TENANT ISOLATION: client_sf_id is the isolation key (D-035), NOT NULL;
-- tenant_id is the human slug (label only).

create table if not exists sundial_service_cache (
  -- Control / identity (mirrors every Sundial cache table)
  sf_id                        text primary key,          -- Salesforce record Id
  client_sf_id                 text not null,             -- Client__c (tenant isolation key)
  tenant_id                    text,                      -- Client__r.Name slug (label only)

  -- Display subset:
  name                         text,        -- Name (auto-number SVC-xxxxx, the ticket handle)
  sundial_customer_sf_id       text,        -- Sundial_Customer__c (parent lookup)
  customer_name_at_creation    text,        -- snapshot, card title
  address_at_creation          text,        -- snapshot, card subtitle
  primary_phone_at_creation    text,        -- snapshot
  primary_email_at_creation    text,        -- snapshot
  status                       text,        -- Status__c (board/list grouping, My Queue)
  resolution                   text,        -- Resolution__c (terminal disposition)
  priority                     text,        -- Priority__c (tray/queue ordering)
  service_type                 text,        -- Service_Type__c
  intake_channel               text,        -- Intake_Channel__c
  needs_intake_review          boolean,     -- Needs_Intake_Review__c (email-intake review queue)
  assigned_to_sf_id            text,        -- Assigned_To__c (My Queue filter)
  status_changed_at            timestamptz, -- Status_Changed_At__c (sat-too-long alerts)
  bill_to_type                 text,        -- Bill_To_Type__c (ticket billing default)
  bill_to_name                 text,        -- Bill_To_Name__c
  billing_reference            text,        -- Billing_Reference__c (partner WO number - SEARCHABLE)
  estimated_cost               numeric,     -- Estimated_Cost__c
  final_cost                   numeric,     -- Final_Cost__c
  payment_status               text,        -- Payment_Status__c
  total_visit_count            numeric,     -- Total_Visit_Count__c (roll-up)
  total_time_minutes           numeric,     -- Total_Time_Minutes__c (roll-up)
  geocode_lat                  numeric,     -- Geocode_Lat__c (board later: travel hints)
  geocode_lon                  numeric,       -- Geocode_Lon__c,

  created_date                 timestamptz, -- CreatedDate (list ordering, newest first)
  last_synced_at               timestamptz not null default now(),
  cache_version                integer not null default 1,
  is_stale                     boolean not null default false
);

create index if not exists idx_sundial_service_cache_tenant
  on sundial_service_cache (client_sf_id);
create index if not exists idx_sundial_service_cache_status
  on sundial_service_cache (client_sf_id, status);
create index if not exists idx_sundial_service_cache_assigned
  on sundial_service_cache (client_sf_id, assigned_to_sf_id, status);
-- Billing_Reference__c must be searchable (partner calls in with THEIR number):
create index if not exists idx_sundial_service_cache_billref
  on sundial_service_cache (client_sf_id, billing_reference);
create index if not exists idx_sundial_service_cache_created
  on sundial_service_cache (client_sf_id, created_date desc nulls last, sf_id);
create index if not exists idx_sundial_service_cache_stale
  on sundial_service_cache (client_sf_id, is_stale) where is_stale = true;
