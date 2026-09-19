-- 2026-09-19: Customer_Type__c on the customer hub; the two call-notes roll-up fields on the job.
-- Run after the Salesforce fields exist (Tim created them in Setup on 2026-09-19; the
-- service-objects package now carries them too). Idempotent. cache-sync / sf-query select a
-- Salesforce field only when its column exists, so these columns are what turns the fields on.

alter table sundial_customer_cache add column if not exists customer_type text;            -- Customer_Type__c (multi-select: "Solar;Service")
create index if not exists idx_sundial_customer_cache_customer_type
  on sundial_customer_cache (client_sf_id, customer_type) where customer_type is not null;

alter table sundial_service_job_cache add column if not exists notes_for_summary text;        -- Notes_for_Summary__c
alter table sundial_service_job_cache add column if not exists notes_from_service_calls text; -- Notes_From_Service_Calls__c
