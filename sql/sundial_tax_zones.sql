-- sundial_tax_zones.sql — the Service module's sales-tax tables, copied from Acumatica (D-083, 2026-10-15).
--
-- Acumatica is the source of truth. scripts/seed-tax-zones.mjs loads the first copy from the
-- Part A pull, and sundial-cache-sync refreshes it once a day ({ "task": "taxzones" }, its own
-- EventBridge rule, one cache_sync_runs row per run with object = 'taxzones'). Nothing here is
-- corrected by hand: a wrong zone is fixed in Acumatica and arrives with the next refresh.
-- The one exception is sundial_tax_zone_aliases, which only ever POINTS a city spelling at a
-- zone Acumatica already has (the CFO's four are seeded below).
--
-- The tax on a line (lib/tax-zones.js — Acumatica's rule):
--   Σ rates of the taxes in BOTH the zone's tax_ids AND the line's category's tax_ids,
--   each rate read from sundial_tax_rates.schedule as of the invoice date.
--
-- Service role only: RLS on, NO policies, browser roles revoked. Only the Lambdas read these.
-- Re-runnable (IF NOT EXISTS / ON CONFLICT DO NOTHING) — safe to run twice.

-- One row per Acumatica tax zone (retail AND contracting; the office picker shows is_retail).
create table if not exists public.sundial_tax_zones (
  tenant          text          not null,               -- the tenant slug (Sundial_Tenant__c.Name), e.g. 'harmon'
  zone_code       text          not null,               -- Acumatica TaxZoneID, e.g. '08PHOENIXR'
  description     text,                                 -- Acumatica's own words, e.g. 'Phoenix - Retail'
  city_key        text,                                 -- normalized city (lib/acumatica-tax-zones.js); null for county-only zones
  county          text,                                 -- 'Maricopa', 'Pinal', …
  state           text          not null default 'AZ',
  combined_rate   numeric(7,5),                         -- the rate a taxed line pays TODAY (highest category rate); display only — the math reads the schedules
  components      jsonb         not null default '[]',  -- [{ taxId, rate, start }] each tax's rate in force at the sync
  tax_ids         text[]        not null default '{}',  -- Acumatica ApplicableTaxes — what the math intersects with a category
  effective_from  date,                                 -- the latest start date among those rates
  is_retail       boolean       not null default false,
  synced_at       timestamptz   not null default now(),
  primary key (tenant, zone_code)
);
create index if not exists sundial_tax_zones_city_idx on public.sundial_tax_zones (tenant, city_key) where is_retail;

-- One row per Acumatica tax, with its FULL rate schedule (a rate change is a new row there,
-- so an invoice is taxed at the rate of its own date — Nov 1 2026 has ten of them).
create table if not exists public.sundial_tax_rates (
  tenant       text        not null,
  tax_id       text        not null,                    -- Acumatica TaxID, e.g. '08PHXRT'
  description  text,
  schedule     jsonb       not null default '[]',       -- [{ start: 'YYYY-MM-DD', rate: 2.8 }] ascending; rate is a PERCENT
  synced_at    timestamptz not null default now(),
  primary key (tenant, tax_id)
);

-- One row per Acumatica tax category (LABSERV, RETAIL, SOLAR, WARRANTY, RESALE, CONTRACTING, …).
create table if not exists public.sundial_tax_categories (
  tenant          text        not null,
  category_id     text        not null,                 -- Acumatica TaxCategoryID = the Tax_Category__c picklist value
  description     text,
  tax_ids         text[]      not null default '{}',    -- Acumatica Details
  active          boolean     not null default true,
  exclude_listed  boolean     not null default false,   -- Acumatica ExcludeListedTaxes (all false at Harmon: "only these taxes")
  synced_at       timestamptz not null default now(),
  primary key (tenant, category_id)
);

-- A city spelling → a zone. normalized like lib/acumatica-tax-zones.js normalizeCity
-- (uppercase, punctuation → space, spaces collapsed). The refresh adds the map's extra
-- spellings; it never deletes a row here.
create table if not exists public.sundial_tax_zone_aliases (
  tenant     text not null,
  alias_key  text not null,
  zone_code  text not null,
  note       text,
  primary key (tenant, alias_key)
);

alter table public.sundial_tax_zones        enable row level security;
alter table public.sundial_tax_rates        enable row level security;
alter table public.sundial_tax_categories   enable row level security;
alter table public.sundial_tax_zone_aliases enable row level security;
revoke all on public.sundial_tax_zones, public.sundial_tax_rates, public.sundial_tax_categories, public.sundial_tax_zone_aliases from anon, authenticated;

-- Julie's call (CFO, 2026-10-06): unincorporated places that are not their own Acumatica zone.
insert into public.sundial_tax_zone_aliases (tenant, alias_key, zone_code, note) values
  ('harmon', 'SUN CITY',      '08MARICOPR', 'from CFO 2026-10-06'),
  ('harmon', 'SUN CITY WEST', '08MARICOPR', 'from CFO 2026-10-06'),
  ('harmon', 'ANTHEM',        '08PHOENIXR', 'from CFO 2026-10-06'),
  ('harmon', 'LAVEEN',        '08PHOENIXR', 'from CFO 2026-10-06')
on conflict (tenant, alias_key) do nothing;

-- The cache tables learn the new Salesforce fields (D-083) so the lists can show them.
-- Guarded: a cache table that does not exist yet is skipped.
do $$
begin
  if to_regclass('public.sundial_service_job_cache') is not null then
    alter table public.sundial_service_job_cache add column if not exists tax_zone_code text;
    alter table public.sundial_service_job_cache add column if not exists tax_zone_label text;
  end if;
  if to_regclass('public.sundial_service_line_cache') is not null then
    alter table public.sundial_service_line_cache add column if not exists tax_category text;
  end if;
  if to_regclass('public.sundial_price_book_item_cache') is not null then
    alter table public.sundial_price_book_item_cache add column if not exists tax_category text;
  end if;
end $$;

-- Check (after the seed):
--   select zone_code, description, city_key, county, combined_rate, effective_from
--   from public.sundial_tax_zones where tenant = 'harmon' and is_retail order by zone_code;
--   select * from public.sundial_tax_zone_aliases where tenant = 'harmon' order by alias_key;
