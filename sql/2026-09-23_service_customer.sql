-- 2026-09-23 (D-075): the Customer in the Service module — the columns the Service
-- Customers list / board read from the customer cache. Run AFTER the Salesforce package
-- salesforce/service-customer-2026-09-23/ is deployed (the four Service_* fields). Idempotent.
-- cache-sync / sf-query select a Salesforce field only when its column exists, so these
-- columns are what turns the fields on — then run one FULL resync of `customer`:
--   Lambda sundial-cache-sync → Test → { "object": "customer", "mode": "full" }
-- (30k+ rows; the incremental sync only carries rows that change afterwards).

-- The four new fields.
alter table sundial_customer_cache add column if not exists service_stage         text;  -- Service_Stage__c (the board columns)
alter table sundial_customer_cache add column if not exists service_request_type  text;  -- Service_Request_Type__c
alter table sundial_customer_cache add column if not exists service_resolution    text;  -- Service_Resolution__c
alter table sundial_customer_cache add column if not exists service_resolved_date date;  -- Service_Resolved_Date__c

-- Existing fields the Service list needs that the cache did not carry.
alter table sundial_customer_cache add column if not exists assigned_to_sf_id     text;  -- Assigned_To__c (lookup → Sundial_User__c; the browser joins the name)
alter table sundial_customer_cache add column if not exists assigned_date         date;  -- Assigned_Date__c
alter table sundial_customer_cache add column if not exists last_contact_date     date;  -- Last_Contact_Date__c
alter table sundial_customer_cache add column if not exists next_follow_up_date   date;  -- Next_Follow_Up_Date__c
alter table sundial_customer_cache add column if not exists follow_up_needed      boolean; -- Follow_Up_Needed__c
alter table sundial_customer_cache add column if not exists description           text;  -- Description__c (the request, in the customer's words)

-- The board and the "Open" filter read stage; the assignee filter reads the lookup.
create index if not exists idx_sundial_customer_cache_service_stage
  on sundial_customer_cache (client_sf_id, service_stage) where service_stage is not null;
create index if not exists idx_sundial_customer_cache_assigned_to
  on sundial_customer_cache (client_sf_id, assigned_to_sf_id) where assigned_to_sf_id is not null;
