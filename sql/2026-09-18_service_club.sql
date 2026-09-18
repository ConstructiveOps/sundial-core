-- 2026-09-18 Service Club (D-073): the two pointer columns on EXISTING cache tables.
-- Run after the Salesforce package deploys. Idempotent.

alter table sundial_customer_cache add column if not exists active_membership_sf_id text; -- Active_Membership__c
alter table sundial_estimate_cache add column if not exists membership_sf_id text;        -- Membership__c

create index if not exists idx_sundial_customer_cache_active_membership
  on sundial_customer_cache (client_sf_id, active_membership_sf_id) where active_membership_sf_id is not null;

-- The Stripe ledger learns which membership an event was about (subscription events).
alter table sundial_stripe_events add column if not exists membership_sf_id text;
create index if not exists idx_sundial_stripe_events_membership
  on sundial_stripe_events (client_sf_id, membership_sf_id) where membership_sf_id is not null;

-- SolarFax ids (revised 2026-09-18, their API): on a membership cache table created before the revision.
alter table sundial_membership_cache add column if not exists solarfacts_account_id text; -- SolarFacts_Account_Id__c
alter table sundial_membership_cache add column if not exists solarfacts_user_id text;    -- SolarFacts_User_Id__c
