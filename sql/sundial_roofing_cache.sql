-- sundial_roofing_cache — Supabase cache table for the Roofing list/board views.
--
-- Mirrors sundial_solar_cache: a NARROW display subset of Sundial_Roofing__c (the
-- fields the list table + Kanban board actually render), plus the standard control
-- columns every Sundial cache table carries. The DETAIL view does NOT read this
-- table — it uses GET /sf/roofing/{id}?full=true (describe-driven, all FLS-visible
-- fields live from Salesforce), so the 116 material/input + 36 output budget fields
-- deliberately stay OUT of the cache.
--
-- HOW THIS POPULATES (no new code): the column NAMES here match sundial-sf-query /
-- sundial-cache-sync's sfFieldToColumn() mapping (strip __c, lowercase; reference
-- fields get a _sf_id suffix). Those Lambdas select ONLY Salesforce fields whose
-- mapped column exists in this table, so simply creating this table makes roofing
-- records populate — via read-through on GET /sf/roofing and via the scheduled
-- sundial-cache-sync job. Add a column here later and it starts caching that field;
-- nothing else changes.
--
-- TENANT ISOLATION: client_sf_id is the isolation key the read Lambda filters on
-- (.eq("client_sf_id", tenantId)); it is NOT NULL. tenant_id holds the human slug
-- (label only). Both are written from the record's own Client__c / Client__r.Name.

create table if not exists sundial_roofing_cache (
  -- Control / identity (mirrors every Sundial cache table)
  sf_id                        text primary key,          -- Salesforce record Id
  client_sf_id                 text not null,             -- Client__c (tenant isolation key)
  tenant_id                    text,                      -- Client__r.Name slug (label only)

  -- Display subset for the list table + Kanban board:
  name                         text,    -- Name (auto-number record id, shown as the handle)
  project_name                 text,    -- Project_Name__c
  sundial_customer_sf_id       text,    -- Sundial_Customer__c (parent lookup)
  customer_name_at_creation    text,    -- Customer_Name_at_Creation__c (snapshot, card title)
  address_at_creation          text,    -- Address_at_Creation__c (snapshot, card subtitle)
  primary_phone_at_creation    text,    -- Primary_Phone_at_Creation__c
  primary_email_at_creation    text,    -- Primary_Email_at_Creation__c
  stage                        text,    -- Stage__c (Kanban COLUMN grouping)
  sales_rep_sf_id              text,    -- Sales_Rep__c (assignment chip)
  project_manager_sf_id        text,    -- Project_Manager__c (assignment chip)
  acumatica_project_id         text,    -- Acumatica_Project_Id__c
  contract_presented_amount    numeric, -- Contract_Presented_Amount__c (headline $ on the card, input)
  total_proposal_cost          numeric, -- Total_Proposal_Cost__c (computed headline $, null until calc runs)

  -- Control (freshness / versioning) — identical to sundial_solar_cache
  last_synced_at               timestamptz not null default now(),
  cache_version                integer not null default 1,
  is_stale                     boolean not null default false
);

-- Indexes mirror the queries the read path actually runs (all tenant-scoped on
-- client_sf_id): list read filters + orders by last_synced_at; board groups by stage;
-- stale rows are refreshed on read.
create index if not exists idx_sundial_roofing_cache_tenant
  on sundial_roofing_cache (client_sf_id);
create index if not exists idx_sundial_roofing_cache_stage
  on sundial_roofing_cache (client_sf_id, stage);
create index if not exists idx_sundial_roofing_cache_synced
  on sundial_roofing_cache (client_sf_id, last_synced_at desc);
create index if not exists idx_sundial_roofing_cache_stale
  on sundial_roofing_cache (client_sf_id, is_stale) where is_stale = true;
