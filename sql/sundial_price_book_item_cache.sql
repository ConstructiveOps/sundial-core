-- sundial_price_book_item_cache — Supabase cache table for Sundial_Price_Book_Item__c (Price Book Item, D-072).
--
-- Mirrors the sundial_roofing_cache pattern: the display subset the portal's list/board/
-- grid surfaces render, plus the standard control columns every Sundial cache table
-- carries. Detail views use GET /sf/pricebookitem/{id}?full=true (describe-driven, live).
--
-- HOW THIS POPULATES: column NAMES match sfFieldToColumn() (strip __c, lowercase;
-- reference fields get _sf_id). The read and sync Lambdas select ONLY Salesforce fields
-- whose mapped column exists here, so creating this table makes pricebookitem records populate via
-- read-through and the scheduled sundial-cache-sync job. Add a column later and it starts
-- caching. GENERATED from the same spec as the .object files - edit the spec, not this.
--
-- TENANT ISOLATION: client_sf_id is the isolation key (D-035), NOT NULL;
-- tenant_id is the human slug (label only).

create table if not exists sundial_price_book_item_cache (
  -- Control / identity
  sf_id                 text primary key,          -- Salesforce record Id
  client_sf_id          text not null,             -- Client__c (tenant isolation key)
  tenant_id             text,                      -- Client__r.Name slug (label only)

  -- Display subset
  name                  text,        -- Name (text)
  item_code             text,        -- Item_Code__c (Stable line-item ID shared across versions (e.g. SVC-CALL-ST...)
  version               numeric,     -- Version__c (1, 2, 3... per Item Code.)
  is_active             boolean,     -- Is_Active__c (Portal Price Book list = active only. One active per Item Co...)
  superseded_by_sf_id   text,        -- Superseded_By__c (Set on the old version when Update creates the new one.)
  kind                  text,        -- Kind__c (Product = labor + material on one item (both price splits fi...)
  job_type              text,        -- Job_Type__c (List-view filter #1 (2026-09-15): which department's work th...)
  service_type          text,        -- Service_Type__c (List-view filter #2 (2026-09-15): Installation / Repair (+ w...)
  category              text,        -- Category__c (List-view filter #3. GET FROM HARMON: final list, seeded fro...)
  description           text,        -- Description__c (Customer-facing text printed on estimates/invoices.)
  unit_of_measure       text,        -- Unit_of_Measure__c
  default_quantity      numeric,     -- Default_Quantity__c (e.g. 1.5 hours for the standard service call.)
  estimated_hours       numeric,     -- Estimated_Hours__c (Labor/Product items: default appointment duration when the j...)
  labor_cost            numeric,     -- Labor_Cost__c (Internal cost (margin reporting).)
  material_cost         numeric,     -- Material_Cost__c (Internal cost.)
  labor_price           numeric,     -- Labor_Price__c (Sell-side labor portion. Labor items fill only this; Product...)
  material_price        numeric,     -- Material_Price__c (Sell-side material portion.)
  price                 numeric,     -- Price__c (Labor Price + Material Price - the one number the grid shows...)
  taxable               boolean,     -- Taxable__c (Materials default true; labor per tenant tax config. GET FRO...)

  created_date          timestamptz, -- CreatedDate (list ordering)
  last_synced_at        timestamptz not null default now(),
  cache_version         integer not null default 1,
  is_stale              boolean not null default false
);

create index if not exists idx_sundial_price_book_item_cache_tenant
  on sundial_price_book_item_cache (client_sf_id);
create index if not exists idx_sundial_price_book_item_cache_active
  on sundial_price_book_item_cache (client_sf_id, is_active) where is_active = true;
create index if not exists idx_sundial_price_book_item_cache_code
  on sundial_price_book_item_cache (client_sf_id, item_code, version desc);
create index if not exists idx_sundial_price_book_item_cache_recent
  on sundial_price_book_item_cache (client_sf_id, created_date desc nulls last, sf_id);
create index if not exists idx_sundial_price_book_item_cache_stale
  on sundial_price_book_item_cache (client_sf_id, is_stale) where is_stale = true;
