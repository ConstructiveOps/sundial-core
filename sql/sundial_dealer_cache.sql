-- sundial_dealer_cache — Supabase cache table for Sundial_Dealer__c (D-064 dealers, D-085 terms).
-- Reporting R1b (D-089): so report types can join the dealer (customers, customers_solar,
-- solar, roofing). Filled by sundial-cache-sync (the 30-minute schedule) — a REPORTS-ONLY
-- cache: deliberately NOT in sundial-sf-query's allowlist (sundial-user-admin's
-- /admin/dealers note: the dealer roster is an admin lookup, not a read surface every
-- portal user reaches).
--
-- COLUMNS: every field the integration user can read (describe, 2026-11-04 — no workbook,
-- the docs/reporting-module.md §4.1 rule for the small objects), named by sfFieldToColumn()
-- (lib/cache-row.js: strip __c, lowercase, reference fields get _sf_id) and typed by the
-- §4.2 map, so the sync fills them with no code change and
-- `node scripts/generate-report-columns.mjs --check` finds nothing missing.
--
-- TENANT ISOLATION: client_sf_id is the isolation key (D-035), NOT NULL.
--
-- WHO MAY READ IT: the service role only, like every cache table (RLS on, no policies,
-- browser roles revoked). Re-runnable: every statement is "if not exists" / idempotent.

create table if not exists public.sundial_dealer_cache (
  -- Control / identity
  sf_id                     text primary key,          -- Salesforce record Id
  client_sf_id              text not null,             -- Client__c (tenant isolation key)
  tenant_id                 text,                      -- Client__r.Name slug (label only)

  -- Every readable field
  name                      text,        -- Name (string)
  active                    boolean,     -- Active__c (an inactive dealer's users resolve to scope none)
  is_internal               boolean,     -- Is_Internal__c (D-085: internal vs external dealer)
  acumatica_vendor_id       text,        -- Acumatica_Vendor_ID__c (D-085: the commission-PO vendor)
  acumatica_vendor_name     text,        -- Acumatica_Vendor_Name__c
  redline_ppw               numeric,     -- Redline_PPW__c (currency; D-085 commission redline)
  redline_lightreach_ppw    numeric,     -- Redline_LightReach_PPW__c (currency; the Lightreach redline)
  ownerid_sf_id             text,        -- OwnerId (reference)
  isdeleted                 boolean,     -- IsDeleted
  createddate               timestamptz, -- CreatedDate
  createdbyid_sf_id         text,        -- CreatedById (reference)
  lastmodifieddate          timestamptz, -- LastModifiedDate
  lastmodifiedbyid_sf_id    text,        -- LastModifiedById (reference)
  systemmodstamp            timestamptz, -- SystemModstamp
  lastvieweddate            timestamptz, -- LastViewedDate
  lastreferenceddate        timestamptz, -- LastReferencedDate

  created_date              timestamptz, -- CreatedDate (list ordering)
  last_synced_at            timestamptz not null default now(),
  cache_version             integer not null default 1,
  is_stale                  boolean not null default false
);

create index if not exists idx_sundial_dealer_cache_tenant
  on public.sundial_dealer_cache (client_sf_id);
create index if not exists idx_sundial_dealer_cache_name
  on public.sundial_dealer_cache (client_sf_id, name);
create index if not exists idx_sundial_dealer_cache_recent
  on public.sundial_dealer_cache (client_sf_id, created_date desc nulls last, sf_id);
create index if not exists idx_sundial_dealer_cache_stale
  on public.sundial_dealer_cache (client_sf_id, is_stale) where is_stale = true;

alter table public.sundial_dealer_cache enable row level security;
revoke all privileges on table public.sundial_dealer_cache from public, anon, authenticated;
grant all privileges on table public.sundial_dealer_cache to service_role;

-- Check (in the SQL editor) — rls must be true, the two privilege columns false, columns 23:
select c.relrowsecurity as rls,
       has_table_privilege('anon', c.oid, 'select') as anon_can_read,
       has_table_privilege('authenticated', c.oid, 'select') as authenticated_can_read,
       (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'sundial_dealer_cache') as columns
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'sundial_dealer_cache';
