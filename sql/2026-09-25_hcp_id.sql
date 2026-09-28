-- 2026-09-25 — HCP_Id__c on the migrated objects (docs/migration.md). The cache columns so a
-- portal list can show / filter by the HCP key (cache-sync fills them automatically because the
-- column name matches sfFieldToColumn('HCP_Id__c') = hcp_id). Idempotent.
alter table sundial_customer_cache          add column if not exists hcp_id text;
alter table sundial_estimate_cache          add column if not exists hcp_id text;
alter table sundial_service_job_cache       add column if not exists hcp_id text;
alter table sundial_service_call_cache      add column if not exists hcp_id text;
alter table sundial_service_line_cache      add column if not exists hcp_id text;
alter table sundial_service_invoice_cache   add column if not exists hcp_id text;
alter table sundial_service_payment_cache   add column if not exists hcp_id text;
create index if not exists sundial_customer_cache_hcp_id_idx    on sundial_customer_cache (hcp_id);
create index if not exists sundial_service_job_cache_hcp_id_idx on sundial_service_job_cache (hcp_id);
