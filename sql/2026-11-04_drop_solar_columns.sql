-- D-090 (2026-11-04): drop the cache columns of the 24 Sundial_Solar__c fields deleted
-- by salesforce/solar-field-cleanup-2026-11/. 21 of the 24 had a column; the other three
-- (Contract_Utility_Account_Holder_Name_2__c, NSA__c, Sundial_Sales_Rep_ID__c) were never
-- cached. (Sales_Rep_Email__c was taken off the delete list the same day; it was never cached.)
--
-- RUN ONLY AFTER the Salesforce delete has succeeded. Until then the sync still fills
-- these columns. Once the fields are gone the describe-driven sync stops selecting them
-- at once (buildCacheSelect = describe ∩ columns), so this drop races nothing.
--
-- The report catalog rows go in the same transaction. Otherwise a catalog row would name
-- a column that no longer exists, and sundial_report_run would fail on it. Checked
-- 2026-11-04: no saved report (public.sundial_reports) names any of these columns, and no
-- view depends on them. Afterwards, re-run scripts/generate-report-catalog.mjs and
-- scripts/generate-report-columns.mjs, run the regenerated sql/2026-11-03_report_catalog.sql,
-- and redeploy sundial-reports (TASKS.md, D-090).
--
-- Idempotent: IF EXISTS throughout, safe to re-run.

begin;

delete from public.sundial_report_catalog
 where table_name = 'sundial_solar_cache'
   and column_name in (
     'adder_price_per_watt', 'additional_phone', 'change_order_received', 'dealer_fee_amount',
     'inverter_2_quantity', 'job_call_comments',
     'permit_applied_date_3', 'permit_applied_date_4', 'permit_fee_3', 'permit_fee_4',
     'permit_number_3', 'permit_number_4', 'permit_received_3', 'permit_received_4',
     'permit_type_3', 'permit_type_4',
     'project_resold', 're_audit_upload_date', 'second_address',
     'web_inspection_key_code_3', 'web_inspection_key_code_4'
   );

alter table public.sundial_solar_cache
  drop column if exists adder_price_per_watt,
  drop column if exists additional_phone,
  drop column if exists change_order_received,
  drop column if exists dealer_fee_amount,
  drop column if exists inverter_2_quantity,
  drop column if exists job_call_comments,
  drop column if exists permit_applied_date_3,
  drop column if exists permit_applied_date_4,
  drop column if exists permit_fee_3,
  drop column if exists permit_fee_4,
  drop column if exists permit_number_3,
  drop column if exists permit_number_4,
  drop column if exists permit_received_3,
  drop column if exists permit_received_4,
  drop column if exists permit_type_3,
  drop column if exists permit_type_4,
  drop column if exists project_resold,
  drop column if exists re_audit_upload_date,
  drop column if exists second_address,
  drop column if exists web_inspection_key_code_3,
  drop column if exists web_inspection_key_code_4;

commit;

-- Check (expect 0 rows):
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'sundial_solar_cache'
--      and column_name in ('permit_type_3', 'second_address', 'web_inspection_key_code_4');
