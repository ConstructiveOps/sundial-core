-- sundial_service_job_cache — Supabase cache table for Sundial_Service_Job__c (Service Job, D-072).
--
-- Mirrors the sundial_roofing_cache pattern: the display subset the portal's list/board/
-- grid surfaces render, plus the standard control columns every Sundial cache table
-- carries. Detail views use GET /sf/job/{id}?full=true (describe-driven, live).
--
-- HOW THIS POPULATES: column NAMES match sfFieldToColumn() (strip __c, lowercase;
-- reference fields get _sf_id). The read and sync Lambdas select ONLY Salesforce fields
-- whose mapped column exists here, so creating this table makes job records populate via
-- read-through and the scheduled sundial-cache-sync job. Add a column later and it starts
-- caching. GENERATED from the same spec as the .object files - edit the spec, not this.
--
-- TENANT ISOLATION: client_sf_id is the isolation key (D-035), NOT NULL;
-- tenant_id is the human slug (label only).

create table if not exists sundial_service_job_cache (
  -- Control / identity
  sf_id                                  text primary key,          -- Salesforce record Id
  client_sf_id                           text not null,             -- Client__c (tenant isolation key)
  tenant_id                              text,                      -- Client__r.Name slug (label only)

  -- Display subset
  name                                   text,        -- Name (auto-number)
  sundial_customer_sf_id                 text,        -- Sundial_Customer__c (Required - every job belongs to a customer (D-065.1: no Asse...)
  estimate_sf_id                         text,        -- Estimate__c (REQUIRED: the job's living estimate (D-072.2). Quick-create ...)
  customer_name_at_creation              text,        -- Customer_Name_at_Creation__c (Snapshot at record creation (standard snapshot pattern).)
  address_at_creation                    text,        -- Address_at_Creation__c (Snapshot at record creation.)
  primary_phone_at_creation              text,        -- Primary_Phone_at_Creation__c (Snapshot at record creation.)
  primary_email_at_creation              text,        -- Primary_Email_at_Creation__c (Snapshot at record creation.)
  intake_channel                         text,        -- Intake_Channel__c (Which door the request came in.)
  intake_date                            timestamptz, -- Intake_Date__c (When the request arrived (not record creation).)
  needs_intake_review                    boolean,     -- Needs_Intake_Review__c (Set by the AI email-intake worker; office confirms the custo...)
  assigned_to_sf_id                      text,        -- Assigned_To__c (Current owner; feeds My Queue and the assignment notificatio...)
  status                                 text,        -- Status__c (Job pipeline (service-workflows.md 2.1 minus the estimate st...)
  resolution                             text,        -- Resolution__c (Terminal disposition; required (in code) when Status = Close...)
  status_changed_at                      timestamptz, -- Status_Changed_At__c (Stamped on every transition; feeds sat-too-long alerts.)
  priority                               text,        -- Priority__c
  service_type                           text,        -- Service_Type__c
  system_ownership                       text,        -- System_Ownership__c (Leased / third-party steers the Bill To default.)
  issue_description                      text,        -- Issue_Description__c (Customer-reported issue at intake (board tooltip reads the f...)
  originating_solar_project_sf_id        text,        -- Originating_Solar_Project__c (Installed system: specs, install date, photos read from here...)
  originating_roofing_project_sf_id      text,        -- Originating_Roofing_Project__c
  originating_commercial_project_sf_id   text,        -- Originating_Commercial_Project__c (Phase 3 object - REMOVE from the package if Sundial_Commerci...)
  bill_to_type                           text,        -- Bill_To_Type__c (THE payer for this job (D-072.6). No customer default, no pe...)
  bill_to_name                           text,        -- Bill_To_Name__c (Payer name when not the customer (leasing partner, manufactu...)
  billing_reference                      text,        -- Billing_Reference__c (Partner PO / work-order number. External ID (indexed) - 'Sun...)
  payment_status                         text,        -- Payment_Status__c (Derived from Service Payments vs invoice total (Lambda/Flow)...)
  customer_card_on_file                  boolean,     -- Customer_Card_on_File__c (A SetupIntent completed for this customer (mirror of the cus...)
  estimate_status                        text,        -- Estimate_Status__c (Cross-object formula - the job list shows it as a column.)
  estimate_total                         numeric,     -- Estimate_Total__c (Cross-object formula onto the living estimate - no sync, no ...)
  estimate_approved_amount               numeric,     -- Estimate_Approved_Amount__c (What the customer last approved.)
  estimate_deposit_amount                numeric,     -- Estimate_Deposit_Amount__c
  total_call_count                       numeric,     -- Total_Call_Count__c (Roll-up via record-triggered Flow on Service Call change (D-...)
  total_time_minutes                     numeric,     -- Total_Time_Minutes__c (Sum of Service Call durations across all techs (roll-up Flow...)
  first_scheduled_start                  timestamptz, -- First_Scheduled_Start__c (Earliest Service Call Scheduled_Start (roll-up Flow) - list ...)
  geocode_lat                            numeric,     -- Geocode_Lat__c (Service-address geocode, best-effort at intake; feeds geofen...)
  geocode_lon                            numeric,     -- Geocode_Lon__c
  geocode_status                         text,        -- Geocode_Status__c (Failed/Manual rows fall back to no geofence rather than bloc...)

  created_date                           timestamptz, -- CreatedDate (list ordering)
  last_synced_at                         timestamptz not null default now(),
  cache_version                          integer not null default 1,
  is_stale                               boolean not null default false
);

create index if not exists idx_sundial_service_job_cache_tenant
  on sundial_service_job_cache (client_sf_id);
create index if not exists idx_sundial_service_job_cache_customer
  on sundial_service_job_cache (client_sf_id, sundial_customer_sf_id);
create index if not exists idx_sundial_service_job_cache_status
  on sundial_service_job_cache (client_sf_id, status);
create index if not exists idx_sundial_service_job_cache_queue
  on sundial_service_job_cache (client_sf_id, assigned_to_sf_id, status);
create index if not exists idx_sundial_service_job_cache_billing_ref
  on sundial_service_job_cache (client_sf_id, billing_reference);
create index if not exists idx_sundial_service_job_cache_estimate
  on sundial_service_job_cache (client_sf_id, estimate_sf_id);
create index if not exists idx_sundial_service_job_cache_recent
  on sundial_service_job_cache (client_sf_id, created_date desc nulls last, sf_id);
create index if not exists idx_sundial_service_job_cache_stale
  on sundial_service_job_cache (client_sf_id, is_stale) where is_stale = true;
