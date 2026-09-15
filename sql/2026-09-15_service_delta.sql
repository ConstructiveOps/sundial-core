-- 2026-09-15 service delta (D-072 amendment 6) — the cache columns for the fields
-- salesforce/service-delta-2026-09-15 adds. The generated create-table files use
-- "create table if not exists", which does NOT add columns to a table that already
-- exists, so this ALTER is the step that makes the new fields cache. Re-runnable.
--
-- cache-sync is describe-driven: a column whose name matches the Salesforce field
-- (strip __c, lowercase) starts syncing the moment it exists. No registry edit needed.

alter table sundial_price_book_item_cache
  add column if not exists job_type     text,   -- Job_Type__c     (filter #1: Solar / Electrical / EV / Commercial)
  add column if not exists service_type text;   -- Service_Type__c (filter #2: Installation / Repair / ...)

create index if not exists idx_sundial_price_book_item_cache_filters
  on sundial_price_book_item_cache (client_sf_id, job_type, service_type, category) where is_active = true;

alter table sundial_service_call_cache
  add column if not exists billable_to_customer boolean,  -- Billable_to_Customer__c
  add column if not exists billable_hours       numeric,  -- Billable_Hours__c
  add column if not exists bill_rate            numeric;  -- Bill_Rate__c

-- Sundial_User__c.Hourly_Bill_Rate__c: the user cache table gets the column too so the
-- Users page and the labor screen can show it without a live read.
alter table sundial_user_cache
  add column if not exists hourly_bill_rate numeric;
