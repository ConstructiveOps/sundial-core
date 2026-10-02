-- 2026-10-02: Archived__c on the Service module's three list objects — the checkbox Tim adds
-- in Setup on Sundial_Customer__c, Sundial_Estimate__c and Sundial_Service_Job__c (default
-- unchecked; the integration user's permission set gets read + edit). The cache carries it as
-- `archived`; cache-sync / sf-query select a Salesforce field only when its column exists, so
-- these columns are what turns the field on. Idempotent. After running it, ONE full resync
-- of each object (Lambda sundial-cache-sync → Test):
--   { "object": "customer",    "mode": "full" }
--   { "object": "estimate",    "mode": "full" }
--   { "object": "job",         "mode": "full" }
-- (the HCP import's re-run writes the flag on ~9,000 customers, 2,200 jobs, 2,500 estimates;
-- the incremental sync carries only what changes afterwards).
--
-- What the portal does with it: every Service list / board hides archived rows until "Show
-- archived" is ticked; search never hides them; Archive / Unarchive sits on the record pages.
-- The HCP import sets it from HCP's own signals (lib/hcp-disposition.js).

alter table sundial_customer_cache    add column if not exists archived boolean;  -- Archived__c
alter table sundial_estimate_cache    add column if not exists archived boolean;  -- Archived__c
alter table sundial_service_job_cache add column if not exists archived boolean;  -- Archived__c

-- The lists will filter on it server-side next (the background-refresh work): a partial
-- index per tenant on the live rows keeps that cheap.
create index if not exists idx_sundial_customer_cache_live
  on sundial_customer_cache (client_sf_id) where archived is distinct from true;
create index if not exists idx_sundial_estimate_cache_live
  on sundial_estimate_cache (client_sf_id) where archived is distinct from true;
create index if not exists idx_sundial_service_job_cache_live
  on sundial_service_job_cache (client_sf_id) where archived is distinct from true;
