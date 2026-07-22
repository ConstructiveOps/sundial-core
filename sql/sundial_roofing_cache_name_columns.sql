-- Column-compatibility for the roofing UI (cloned from Solar), which reads
-- first_name/last_name/address/sales_rep_name/project_manager_name off cache rows.
-- Run AFTER deploying the two roofing name formula fields (salesforce/roofing-name-fields/).
--
-- Population once both are in place (generic sync — no Lambda change):
--   * sales_rep_name / project_manager_name  <- the new Sales_Rep_Name__c /
--       Project_Manager_Name__c formula fields (First + Last), exactly like Solar.
--   * first_name / last_name / address        <- STAY NULL on roofing (the roofing
--       object has no such direct fields, only the *_at_creation snapshots). The
--       cloned record-display falls back to customer_name_at_creation /
--       address_at_creation (already cached), so the name + address still render.

alter table sundial_roofing_cache
  add column if not exists sales_rep_name       text,
  add column if not exists project_manager_name text,
  add column if not exists first_name           text,
  add column if not exists last_name            text,
  add column if not exists address              text;

-- Optional: let the board/list filter by rep/PM without scanning (mirrors Solar usage).
create index if not exists idx_sundial_roofing_cache_rep
  on sundial_roofing_cache (client_sf_id, sales_rep_name);
create index if not exists idx_sundial_roofing_cache_pm
  on sundial_roofing_cache (client_sf_id, project_manager_name);
