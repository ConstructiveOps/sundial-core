-- 2026-10-07 (D-081): "the payer is a Customer record". Six Setup fields Tim created in the
-- org — Sundial_Customer__c.Is_Company__c / Company_Name__c / Warranty_Notes__c,
-- Sundial_Service_Job__c.Bill_To_Customer__c, Sundial_Service_Invoice__c.Bill_To_Customer__c /
-- Bill_To_Address__c — reach the cache as these columns. cache-sync / sf-query select a
-- Salesforce field only when its column exists, so this file is what turns them on.
-- Idempotent. Run it in the Supabase SQL editor, then ONE full resync of each object
-- (Lambda sundial-cache-sync → Test):
--   { "object": "customer",       "mode": "full" }
--   { "object": "job",            "mode": "full" }
--   { "object": "serviceinvoice", "mode": "full" }

alter table sundial_customer_cache        add column if not exists is_company boolean;              -- Is_Company__c
alter table sundial_customer_cache        add column if not exists company_name text;               -- Company_Name__c
alter table sundial_customer_cache        add column if not exists warranty_notes text;             -- Warranty_Notes__c
alter table sundial_service_job_cache     add column if not exists bill_to_customer_sf_id text;     -- Bill_To_Customer__c
alter table sundial_service_invoice_cache add column if not exists bill_to_customer_sf_id text;     -- Bill_To_Customer__c
alter table sundial_service_invoice_cache add column if not exists bill_to_address text;            -- Bill_To_Address__c

-- The Bill To picker lists a tenant's companies first.
create index if not exists idx_sundial_customer_cache_company
  on sundial_customer_cache (client_sf_id, is_company);

-- The Customer header's sort (?sort=display_name_sort): the name the customer is SHOWN by —
-- lib/customer-name.js customerDisplayName, in SQL: the company name for a company, else
-- "first last", else the record name. A GENERATED column because PostgREST can order by a
-- column but not by an expression; no Salesforce field maps to it, so the cache writers
-- never send it and Postgres keeps it current on every write. (`||` rather than concat_ws:
-- a generated column may only use immutable functions, and concat_ws is not one.)
alter table sundial_customer_cache
  add column if not exists display_name_sort text
  generated always as (
    coalesce(
      case when is_company is true then nullif(btrim(company_name), '') end,
      nullif(btrim(coalesce(btrim(first_name), '') || ' ' || coalesce(btrim(last_name), '')), ''),
      nullif(btrim(name), '')
    )
  ) stored;

create index if not exists idx_sundial_customer_cache_display_name_sort
  on sundial_customer_cache (client_sf_id, display_name_sort);
