-- sundial_service_line_cache — Supabase cache table for Sundial_Service_Line__c (Service Line, D-072).
--
-- Mirrors the sundial_roofing_cache pattern: the display subset the portal's list/board/
-- grid surfaces render, plus the standard control columns every Sundial cache table
-- carries. Detail views use GET /sf/serviceline/{id}?full=true (describe-driven, live).
--
-- HOW THIS POPULATES: column NAMES match sfFieldToColumn() (strip __c, lowercase;
-- reference fields get _sf_id). The read and sync Lambdas select ONLY Salesforce fields
-- whose mapped column exists here, so creating this table makes serviceline records populate via
-- read-through and the scheduled sundial-cache-sync job. Add a column later and it starts
-- caching. GENERATED from the same spec as the .object files - edit the spec, not this.
--
-- TENANT ISOLATION: client_sf_id is the isolation key (D-035), NOT NULL;
-- tenant_id is the human slug (label only).

create table if not exists sundial_service_line_cache (
  -- Control / identity
  sf_id                         text primary key,          -- Salesforce record Id
  client_sf_id                  text not null,             -- Client__c (tenant isolation key)
  tenant_id                     text,                      -- Client__r.Name slug (label only)

  -- Display subset
  name                          text,        -- Name (auto-number)
  estimate_sf_id                text,        -- Estimate__c (Parent estimate (required).)
  price_book_item_sf_id         text,        -- Price_Book_Item__c (The specific item VERSION this line was added from. Blank = ...)
  kind                          text,        -- Kind__c (Copied from the item; required for ad-hoc lines. Scopes disc...)
  description                   text,        -- Description__c (Customer-facing line text (snapshot of the item description,...)
  quantity                      numeric,     -- Quantity__c
  unit_of_measure               text,        -- Unit_of_Measure__c
  unit_price                    numeric,     -- Unit_Price__c (Snapshot of the item Price at add time; editable per line (P...)
  unit_labor_price              numeric,     -- Unit_Labor_Price__c (Snapshot split - lets a labor-only discount act on Product l...)
  unit_material_price           numeric,     -- Unit_Material_Price__c (Snapshot split.)
  unit_labor_cost               numeric,     -- Unit_Labor_Cost__c (Snapshot for margin reporting.)
  unit_material_cost            numeric,     -- Unit_Material_Cost__c (Snapshot for margin reporting.)
  price_overridden              boolean,     -- Price_Overridden__c (Lambda-set when Unit Price differs from the item's price at ...)
  line_total                    numeric,     -- Line_Total__c (Quantity x Unit Price. Live formula.)
  taxable                       boolean,     -- Taxable__c (Snapshot from the item; feeds tax at totals time.)
  stage                         text,        -- Stage__c (Proposed = added but not yet in an approved version (field e...)
  sort_order                    numeric,     -- Sort_Order__c (Grid order.)
  show_unit_price               boolean,     -- Show_Unit_Price__c (Per-line display toggle; default from tenant config.)
  source                        text,        -- Source__c (Time = a billable service call's hours (Added By Service Cal...)
  added_by_service_call_sf_id   text,        -- Added_By_Service_Call__c (Set for field-added lines: which visit the tech was on.)

  created_date                  timestamptz, -- CreatedDate (list ordering)
  last_synced_at                timestamptz not null default now(),
  cache_version                 integer not null default 1,
  is_stale                      boolean not null default false
);

create index if not exists idx_sundial_service_line_cache_tenant
  on sundial_service_line_cache (client_sf_id);
create index if not exists idx_sundial_service_line_cache_estimate
  on sundial_service_line_cache (client_sf_id, estimate_sf_id, sort_order);
create index if not exists idx_sundial_service_line_cache_item
  on sundial_service_line_cache (client_sf_id, price_book_item_sf_id);
create index if not exists idx_sundial_service_line_cache_recent
  on sundial_service_line_cache (client_sf_id, created_date desc nulls last, sf_id);
create index if not exists idx_sundial_service_line_cache_stale
  on sundial_service_line_cache (client_sf_id, is_stale) where is_stale = true;
