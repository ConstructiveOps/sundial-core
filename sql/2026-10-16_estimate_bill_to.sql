-- 2026-10-16 (D-081 amendment 2): the estimate has its own Bill To. Three Setup fields Tim
-- created in the org — Sundial_Estimate__c.Bill_To_Type__c / Bill_To_Customer__c /
-- Bill_To_Name__c — reach the cache as these columns. cache-sync / sf-query select a
-- Salesforce field only when its column exists (lib/cache-row.js maps by describe), so this
-- file is what turns them on; no Lambda change is needed for the sync to fill them.
-- Idempotent. Run it in the Supabase SQL editor, then ONE full resync of the estimates
-- (Lambda sundial-cache-sync → Test):
--   { "object": "estimate", "mode": "full" }

alter table sundial_estimate_cache add column if not exists bill_to_type text;              -- Bill_To_Type__c
alter table sundial_estimate_cache add column if not exists bill_to_customer_sf_id text;    -- Bill_To_Customer__c
alter table sundial_estimate_cache add column if not exists bill_to_name text;              -- Bill_To_Name__c (derived from the payer)
