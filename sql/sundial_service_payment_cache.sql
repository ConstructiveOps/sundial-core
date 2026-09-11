-- sundial_service_payment_cache — Supabase cache table for Sundial_Service_Payment__c (Service Payment, D-072).
--
-- Mirrors the sundial_roofing_cache pattern: the display subset the portal's list/board/
-- grid surfaces render, plus the standard control columns every Sundial cache table
-- carries. Detail views use GET /sf/servicepayment/{id}?full=true (describe-driven, live).
--
-- HOW THIS POPULATES: column NAMES match sfFieldToColumn() (strip __c, lowercase;
-- reference fields get _sf_id). The read and sync Lambdas select ONLY Salesforce fields
-- whose mapped column exists here, so creating this table makes servicepayment records populate via
-- read-through and the scheduled sundial-cache-sync job. Add a column later and it starts
-- caching. GENERATED from the same spec as the .object files - edit the spec, not this.
--
-- TENANT ISOLATION: client_sf_id is the isolation key (D-035), NOT NULL;
-- tenant_id is the human slug (label only).

create table if not exists sundial_service_payment_cache (
  -- Control / identity
  sf_id                      text primary key,          -- Salesforce record Id
  client_sf_id               text not null,             -- Client__c (tenant isolation key)
  tenant_id                  text,                      -- Client__r.Name slug (label only)

  -- Display subset
  name                       text,        -- Name (auto-number)
  service_job_sf_id          text,        -- Service_Job__c (Required.)
  invoice_sf_id              text,        -- Invoice__c (Optional - deposits pre-date the invoice; the Lambda back-fi...)
  type                       text,        -- Type__c
  method                     text,        -- Method__c
  amount                     numeric,     -- Amount__c (Positive for money in; Refund rows are also positive (Type s...)
  status                     text,        -- Status__c
  stripe_payment_intent_id   text,        -- Stripe_Payment_Intent_Id__c (UNIQUE external ID - webhook idempotency key.)
  received_at                timestamptz, -- Received_At__c (When the money actually landed (webhook time, or the check d...)
  reference                  text,        -- Reference__c (Check number / partner remittance id.)
  recorded_by_sf_id          text,        -- Recorded_By__c (Office user for manual entries; blank for webhook rows.)
  acumatica_applied_at       timestamptz, -- Acumatica_Applied_At__c (When Heather applied it against the AR invoice (bridge) / wh...)

  created_date               timestamptz, -- CreatedDate (list ordering)
  last_synced_at             timestamptz not null default now(),
  cache_version              integer not null default 1,
  is_stale                   boolean not null default false
);

create index if not exists idx_sundial_service_payment_cache_tenant
  on sundial_service_payment_cache (client_sf_id);
create index if not exists idx_sundial_service_payment_cache_job
  on sundial_service_payment_cache (client_sf_id, service_job_sf_id);
create index if not exists idx_sundial_service_payment_cache_invoice
  on sundial_service_payment_cache (client_sf_id, invoice_sf_id);
create index if not exists idx_sundial_service_payment_cache_received
  on sundial_service_payment_cache (client_sf_id, received_at desc);
create index if not exists idx_sundial_service_payment_cache_recent
  on sundial_service_payment_cache (client_sf_id, created_date desc nulls last, sf_id);
create index if not exists idx_sundial_service_payment_cache_stale
  on sundial_service_payment_cache (client_sf_id, is_stale) where is_stale = true;
