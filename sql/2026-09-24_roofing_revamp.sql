-- 2026-09-24 (Roofing revamp): the cache columns the revamped Roofing module reads.
-- Run AFTER salesforce/roofing-revamp-2026-09-24/ is deployed and the Sundial_Roofing_Revamp
-- permission set is assigned to the integration user. Idempotent.
-- cache-sync / sf-query select a Salesforce field only when its column exists, so these
-- columns are what turns the fields on — then run one FULL resync of BOTH objects:
--   Lambda sundial-cache-sync → Test → { "object": "customer", "mode": "full" }
--   Lambda sundial-cache-sync → Test → { "object": "roofing",  "mode": "full" }

-- ---------------------------------------------------------------------------
-- Sundial_Customer__c: the Roofing module's own pipeline on the hub (D-075 pattern).
-- assigned_to_sf_id / *_date / follow_up_needed / description / customer_type already
-- exist from 2026-09-19 and 2026-09-23.
alter table sundial_customer_cache add column if not exists roofing_stage         text;  -- Roofing_Stage__c (the board columns)
alter table sundial_customer_cache add column if not exists roofing_request_type  text;  -- Roofing_Request_Type__c
alter table sundial_customer_cache add column if not exists linked_roofing_project_sf_id text; -- Linked_Roofing_Project__c (only populates once the lookup exists)

create index if not exists idx_sundial_customer_cache_roofing_stage
  on sundial_customer_cache (client_sf_id, roofing_stage) where roofing_stage is not null;

-- ---------------------------------------------------------------------------
-- Sundial_Roofing__c: the list / board / customer-chip columns the revamp renders.
-- Budget inputs, the 92 material fields and the line-item outputs stay OUT of the cache
-- (the detail page reads ?full=true) — only headline money + status + layout-sheet fields.
alter table sundial_roofing_cache add column if not exists sold_with_solar          text;    -- Sold_With_Solar__c
alter table sundial_roofing_cache add column if not exists sourced_from             text;    -- Sourced_From__c
alter table sundial_roofing_cache add column if not exists lead_source              text;    -- Lead_Source__c (formula read-through)
alter table sundial_roofing_cache add column if not exists roof_type                text;    -- Roof_Type__c (multi: "A;B")
alter table sundial_roofing_cache add column if not exists payment_type             text;    -- Payment_Type__c
alter table sundial_roofing_cache add column if not exists deposit_received         boolean; -- Deposit_Received__c
alter table sundial_roofing_cache add column if not exists final_payment_status     text;    -- Final_Payment_Status__c
alter table sundial_roofing_cache add column if not exists job_city                 text;    -- Job_City__c
alter table sundial_roofing_cache add column if not exists budget_calc_status       text;    -- Budget_Calc_Status__c
alter table sundial_roofing_cache add column if not exists budget_last_calculated   timestamptz; -- Budget_Last_Calculated__c
alter table sundial_roofing_cache add column if not exists budget_push_status       text;    -- Budget_Push_Status__c
alter table sundial_roofing_cache add column if not exists budget_pushed_at         timestamptz; -- Budget_Pushed_At__c
alter table sundial_roofing_cache add column if not exists project_created_in_acumatica date; -- Project_Created_in_Acumatica__c
alter table sundial_roofing_cache add column if not exists total_job_cost_client    numeric; -- Total_Job_Cost_Client__c
alter table sundial_roofing_cache add column if not exists acumatica_budget_total   numeric; -- Acumatica_Budget_Total__c
alter table sundial_roofing_cache add column if not exists markup_profit_dollars    numeric; -- Markup_Profit_Dollars__c
alter table sundial_roofing_cache add column if not exists total_squares            numeric; -- Total_Squares__c

-- Board / list filters the revamp adds (sold-with-solar chip, push status, payment tracking).
create index if not exists idx_sundial_roofing_cache_push_status
  on sundial_roofing_cache (client_sf_id, budget_push_status) where budget_push_status is not null;
create index if not exists idx_sundial_roofing_cache_final_payment
  on sundial_roofing_cache (client_sf_id, final_payment_status) where final_payment_status is not null;
