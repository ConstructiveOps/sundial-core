-- sundial_customer_pipeline.sql — the Sales page's header, badges and filter options in
-- ONE small answer (D-080, 2026-10-05). Served by GET /sf/customer/pipeline
-- (sundial-sf-query), so the Sales page no longer downloads all ~39k customers to count
-- them.
--
--   select public.sundial_customer_pipeline(
--     'a1W7y000007AszBEAS',                                   -- the tenant (client_sf_id)
--     '{"eq": {"sales_rep_sf_id": "a1O..."}}'::jsonb,         -- the ACCESS filter
--     '{"stage": {"values": ["Contact Attempt Made"], "blank": false}}'::jsonb  -- the CALLER's narrowing
--   );
--
-- Returns jsonb, every count a GROUP BY over public.sundial_customer_cache:
--   by_status  { status: n }
--   by_stage   { status: { stage: n } }
--   reps       { status: [[sales_rep_sf_id, sales_rep_name, n], ...] }   -- tuples, n desc
--   sources    { status: [[lead_source, n], ...] }                        -- tuples, n desc
-- A blank status / stage is the key "". Tuples, not objects: the object form measured
-- 33.7 KB on Harmon's data (106 reps, 165 sources across four statuses); tuples 18.3 KB.
--
-- ⚠️ THE SERVICE EXCLUSION IS `customer_type IS DISTINCT FROM 'Service'` — NEVER `<>`.
-- 29,749 of Harmon's 39,216 customers have a NULL customer_type, and `NULL <> 'Service'`
-- is NULL, which a WHERE treats as false: `<>` silently drops three quarters of the
-- pipeline. (The list endpoint's not[customer_type]=Service has the same trap in
-- PostgREST: `neq` returned 21 rows where the answer is 29,770, measured 2026-10-05.)
-- 'Service' exactly is excluded; 'Solar;Service' / 'Service;Solar' stay — the portal's
-- isServiceOnly() rule (2026-09-28).
--
-- TWO FILTERS, KEPT APART ON PURPOSE:
--   p_filters  the ACCESS row filter — what this session may see. Built by the Lambda
--              from lib/access.js rowFilter() (`enforce.cache` minus the tenant), never
--              from request input. Shape {"eq": {col: value}}; the only columns it may
--              name are sales_rep_sf_id and dealer_sf_id. Anything else RAISES (fail
--              closed): an access filter this function cannot apply must not quietly
--              become "no filter".
--   p_narrow   the CALLER's narrowing — the Sales page's Stage / Rep / Source pickers,
--              so the board's column counts follow them (the status badges call with
--              p_narrow NULL). {col: {"values": [...], "blank": bool}}: any of the
--              values, or blank when "blank" is true. Columns: stage, sales_rep_name,
--              lead_source only; anything else RAISES. It can only narrow.
--
-- STATIC SQL ONLY. Column names are never built from input, so neither jsonb can inject
-- anything; unknown keys are refused before the query runs.
--
-- WHO MAY CALL IT: the service role (the Lambdas), nobody else. It is SECURITY DEFINER,
-- so it reads the cache tables with its owner's rights — the browser-role revokes on
-- sundial_customer_cache (sundial_access_p1_cache_hardening.sql) do NOT apply to it.
-- Postgres grants EXECUTE on every new function to PUBLIC by default, and anon /
-- authenticated inherit PUBLIC: without the revoke below, any signed-in browser could
-- call /rest/v1/rpc/sundial_customer_pipeline with ANY tenant's id. Hence `revoke ... from
-- public, anon, authenticated` and an explicit grant to service_role. Re-runnable.

create or replace function public.sundial_customer_pipeline(
  p_client_sf_id text,
  p_filters      jsonb default '{}'::jsonb,
  p_narrow       jsonb default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  f   jsonb := coalesce(p_filters, '{}'::jsonb);
  eqf jsonb := coalesce(p_filters -> 'eq', '{}'::jsonb);
  n   jsonb := coalesce(p_narrow, '{}'::jsonb);
  bad text;
  result jsonb;
begin
  if p_client_sf_id is null or btrim(p_client_sf_id) = '' then
    raise exception 'sundial_customer_pipeline: p_client_sf_id is required';
  end if;
  if jsonb_typeof(f) <> 'object' or jsonb_typeof(eqf) <> 'object' or jsonb_typeof(n) <> 'object' then
    raise exception 'sundial_customer_pipeline: filters must be json objects';
  end if;

  -- Fail closed on anything this function does not know how to apply.
  select k into bad from jsonb_object_keys(f) k where k <> 'eq' limit 1;
  if bad is not null then
    raise exception 'sundial_customer_pipeline: unsupported access filter form %', bad;
  end if;
  select k into bad from jsonb_object_keys(eqf) k where k not in ('sales_rep_sf_id', 'dealer_sf_id') limit 1;
  if bad is not null then
    raise exception 'sundial_customer_pipeline: unsupported access filter column %', bad;
  end if;
  select k into bad from jsonb_object_keys(n) k where k not in ('stage', 'sales_rep_name', 'lead_source') limit 1;
  if bad is not null then
    raise exception 'sundial_customer_pipeline: unsupported narrowing column %', bad;
  end if;

  with c as (
    select status, stage, sales_rep_sf_id, sales_rep_name, lead_source
    from public.sundial_customer_cache
    where client_sf_id = p_client_sf_id
      -- IS DISTINCT FROM, not <>: keeps the NULL customer_type rows (see header).
      and customer_type is distinct from 'Service'
      -- The access filter (equalities, ANDed).
      and (not (eqf ? 'sales_rep_sf_id') or sales_rep_sf_id = eqf ->> 'sales_rep_sf_id')
      and (not (eqf ? 'dealer_sf_id')    or dealer_sf_id    = eqf ->> 'dealer_sf_id')
      -- The caller's narrowing: any of the values, or blank when asked.
      and (not (n ? 'stage') or
           stage in (select jsonb_array_elements_text(coalesce(n -> 'stage' -> 'values', '[]'::jsonb)))
           or (coalesce((n -> 'stage' ->> 'blank')::boolean, false) and coalesce(stage, '') = ''))
      and (not (n ? 'sales_rep_name') or
           sales_rep_name in (select jsonb_array_elements_text(coalesce(n -> 'sales_rep_name' -> 'values', '[]'::jsonb)))
           or (coalesce((n -> 'sales_rep_name' ->> 'blank')::boolean, false) and coalesce(sales_rep_name, '') = ''))
      and (not (n ? 'lead_source') or
           lead_source in (select jsonb_array_elements_text(coalesce(n -> 'lead_source' -> 'values', '[]'::jsonb)))
           or (coalesce((n -> 'lead_source' ->> 'blank')::boolean, false) and coalesce(lead_source, '') = ''))
  ),
  st as (
    select coalesce(status, '') s, count(*) cnt from c group by 1
  ),
  sg as (
    select coalesce(status, '') s, coalesce(stage, '') g, count(*) cnt from c group by 1, 2
  ),
  rp as (
    select coalesce(status, '') s, sales_rep_sf_id id, sales_rep_name nm, count(*) cnt from c group by 1, 2, 3
  ),
  so as (
    select coalesce(status, '') s, lead_source src, count(*) cnt from c group by 1, 2
  )
  select jsonb_build_object(
    'by_status', coalesce((select jsonb_object_agg(s, cnt) from st), '{}'::jsonb),
    'by_stage',  coalesce((select jsonb_object_agg(s, stages) from (
                   select s, jsonb_object_agg(g, cnt) stages from sg group by s) x), '{}'::jsonb),
    'reps',      coalesce((select jsonb_object_agg(s, arr) from (
                   select s, jsonb_agg(jsonb_build_array(id, nm, cnt) order by cnt desc, nm) arr from rp group by s) x), '{}'::jsonb),
    'sources',   coalesce((select jsonb_object_agg(s, arr) from (
                   select s, jsonb_agg(jsonb_build_array(src, cnt) order by cnt desc, src) arr from so group by s) x), '{}'::jsonb)
  ) into result;

  return result;
end;
$$;

-- See the header: PUBLIC first, or anon / authenticated keep EXECUTE through it.
revoke all on function public.sundial_customer_pipeline(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.sundial_customer_pipeline(text, jsonb, jsonb) to service_role;

-- Check (as the service role / in the SQL editor):
--   select public.sundial_customer_pipeline('a1W7y000007AszBEAS', '{}'::jsonb, null) -> 'by_status';
-- And that the browser cannot reach it — this must return false for both:
--   select has_function_privilege('anon', 'public.sundial_customer_pipeline(text, jsonb, jsonb)', 'execute'),
--          has_function_privilege('authenticated', 'public.sundial_customer_pipeline(text, jsonb, jsonb)', 'execute');
