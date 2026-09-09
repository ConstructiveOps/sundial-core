-- sundial_service_invoice_cache — Supabase cache table for Sundial_Service_Invoice__c (Service Invoice, D-072).
--
-- Mirrors the sundial_roofing_cache pattern: the display subset the portal's list/board/
-- grid surfaces render, plus the standard control columns every Sundial cache table
-- carries. Detail views use GET /sf/serviceinvoice/{id}?full=true (describe-driven, live).
--
-- HOW THIS POPULATES: column NAMES match sfFieldToColumn() (strip __c, lowercase;
-- reference fields get _sf_id). The read and sync Lambdas select ONLY Salesforce fields
-- whose mapped column exists here, so creating this table makes serviceinvoice records populate via
-- read-through and the scheduled sundial-cache-sync job. Add a column later and it starts
-- caching. GENERATED from the same spec as the .object files - edit the spec, not this.
--
-- TENANT ISOLATION: client_sf_id is the isolation key (D-035), NOT NULL;
-- tenant_id is the human slug (label only).

create table if not exists sundial_service_invoice_cache (
  -- Control / identity
  sf_id                  text primary key,          -- Salesforce record Id
  client_sf_id           text not null,             -- Client__c (tenant isolation key)
  tenant_id              text,                      -- Client__r.Name slug (label only)

  -- Display subset
  name                   text,        -- Name (text)
  service_job_sf_id      text,        -- Service_Job__c (Parent job (required).)
  status                 text,        -- Status__c
  bill_to_type           text,        -- Bill_To_Type__c (Frozen copy of the job's Bill To at issue.)
  bill_to_name           text,        -- Bill_To_Name__c
  billing_reference      text,        -- Billing_Reference__c (Partner PO/WO number, printed and searchable.)
  subtotal               numeric,     -- Subtotal__c
  discount_amount        numeric,     -- Discount_Amount__c
  tax_rate               numeric,     -- Tax_Rate__c
  tax_amount             numeric,     -- Tax_Amount__c
  total                  numeric,     -- Total__c
  paid_amount            numeric,     -- Paid_Amount__c (Sum of Succeeded Service Payments (Payment - Refund); roll-u...)
  balance                numeric,     -- Balance__c (Total - Paid.)
  issued_at              timestamptz, -- Issued_At__c
  sent_at                timestamptz, -- Sent_At__c (Stamped on send / partner download.)
  due_date               date,        -- Due_Date__c (Partner terms (tenant config); blank for card-on-file jobs.)
  paid_at                timestamptz, -- Paid_At__c (When Balance reached zero.)
  acumatica_ref          text,        -- Acumatica_Ref__c (AR reference once the invoice exists in Acumatica (bridge: h...)
  acumatica_entered_at   timestamptz, -- Acumatica_Entered_At__c (Bridge-period stamp: Heather's weekly digest = invoices wher...)
  voided_at              timestamptz, -- Voided_At__c

  created_date           timestamptz, -- CreatedDate (list ordering)
  last_synced_at         timestamptz not null default now(),
  cache_version          integer not null default 1,
  is_stale               boolean not null default false
);

create index if not exists idx_sundial_service_invoice_cache_tenant
  on sundial_service_invoice_cache (client_sf_id);
create index if not exists idx_sundial_service_invoice_cache_job
  on sundial_service_invoice_cache (client_sf_id, service_job_sf_id);
create index if not exists idx_sundial_service_invoice_cache_status
  on sundial_service_invoice_cache (client_sf_id, status);
create index if not exists idx_sundial_service_invoice_cache_acumatica_pending
  on sundial_service_invoice_cache (client_sf_id, issued_at) where acumatica_entered_at is null;
create index if not exists idx_sundial_service_invoice_cache_recent
  on sundial_service_invoice_cache (client_sf_id, created_date desc nulls last, sf_id);
create index if not exists idx_sundial_service_invoice_cache_stale
  on sundial_service_invoice_cache (client_sf_id, is_stale) where is_stale = true;
