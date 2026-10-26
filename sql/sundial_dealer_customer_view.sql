-- sundial_dealer_customer_view — the dealer shell's customer list, one row per customer
-- with the solar project that LEADS its journey (dealer module step 3, 2026-10-23).
--
-- WHY A VIEW. The dealer shell lists customers by journey stage, and a customer's journey
-- stage is its SOLAR's stage when it has one (lib/dealer-journey.js). Filtering, counting
-- and paging on a value that lives in another table cannot be done from the Lambda without
-- passing id lists between two queries — and the sets are large (2,915 Archive and 1,185
-- Cancelled solars, 4,695 New customers on Harmon, measured 2026-10-23). One view puts the
-- leading solar's id / stage / name beside every customer, so sundial-dealer runs ONE
-- PostgREST query with the same row filter, search, sort and range as the Sales list.
--
-- WHICH SOLAR LEADS: the customer's most recently created project — created_date (the
-- cache's COALESCE of Sunbase_Created_Date__c, Contract_Date__c, CreatedDate; see
-- CREATED_DATE_SOURCE.solar in sundial-sf-query) DESC NULLS LAST, then sf_id DESC.
-- sundial-dealer's detail read picks with the SAME rule from Salesforce (pickLeadingSolar);
-- lambdas/sundial-dealer/test.js pins the two together. 113 of Harmon's customers have
-- more than one project (2026-10-23).
--
-- THE SOLAR IS SEEN THROUGH ITS CUSTOMER (D-086): the join is on the customer id and the
-- tenant only — never on the solar's own Dealer__c / Sales_Rep__c. The row filter the
-- Lambda applies is the CUSTOMER's (lib/access.js rowFilter("customer")).
--
-- ⚠️ COLUMN ORDER IS LOAD-BEARING. The journey columns come FIRST and the customer
-- columns (c.*) after them, so a column later added to sundial_customer_cache is appended
-- at the END when this file is re-run — which is the only change CREATE OR REPLACE VIEW
-- allows. `c.*` is expanded when the view is created: a new customer cache column is NOT
-- in the dealer list until this file is re-run. Dropping a customer cache column needs this
-- view dropped first (Postgres refuses, naming it).
-- Re-run after: sql/2026-10-26_customer_last_modified.sql (`lastmodifieddate`, the list
-- rows' `updatedAt`).
--
-- ACCESS: service_role only. security_invoker so it never runs with its owner's rights,
-- and every privilege revoked from the browser roles — the cache tables themselves are
-- revoked from them since access-model §3.3 A4, and this view must not be a way around
-- that. Re-runnable.

-- SHAPE, MEASURED (2026-10-23, live cache, read-only EXPLAIN ANALYZE): the solar side is
-- ranked ONCE (DISTINCT ON over ~4.6k rows) and hash-joined, ~200 ms for Harmon's whole
-- 39k-customer tenant and ~290 ms with a stage filter. A per-customer LATERAL lookup
-- was 12.4 s on the same data (39k index probes) — do not "simplify" it back.

create or replace view public.sundial_dealer_customer_view
with (security_invoker = true) as
select
  s.sf_id        as journey_solar_sf_id,
  s.stage        as journey_solar_stage,
  s.project_name as journey_solar_project_name,
  coalesce(s.solar_count, 0)::int as journey_solar_count,
  c.*
from public.sundial_customer_cache c
left join (
  select distinct on (x.client_sf_id, x.sundial_customer_sf_id)
    x.client_sf_id,
    x.sundial_customer_sf_id,
    x.sf_id,
    x.stage,
    x.project_name,
    count(*) over (partition by x.client_sf_id, x.sundial_customer_sf_id) as solar_count
  from public.sundial_solar_cache x
  where x.sundial_customer_sf_id is not null
  order by x.client_sf_id, x.sundial_customer_sf_id, x.created_date desc nulls last, x.sf_id desc
) s on s.client_sf_id = c.client_sf_id and s.sundial_customer_sf_id = c.sf_id;

revoke all on public.sundial_dealer_customer_view from public, anon, authenticated;
grant select on public.sundial_dealer_customer_view to service_role;
