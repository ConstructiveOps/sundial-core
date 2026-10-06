-- sundial_solar_pipeline.sql — the Solar Projects page's stage counts and dropdown
-- options AND the Dashboard's stat cards, in ONE small answer (D-080 amendment 1,
-- 2026-10-06). Served by GET /sf/solar/pipeline (sundial-sf-query), so neither page
-- downloads every solar record to count it.
--
--   select public.sundial_solar_pipeline(
--     'a1W7y000007AszBEAS',                                   -- the tenant (client_sf_id)
--     '{"eq": {"sales_rep_sf_id": "a1O..."}}'::jsonb,         -- the ACCESS filter
--     '{"stage": {"values": ["Permitting"], "blank": false}}'::jsonb,  -- the CALLER's narrowing
--     array['complete','cancel','pto','closed','archive'],     -- terminal stage TERMS
--     array['Billing Complete - Pending Closeout']             -- stages that are NEVER terminal
--   );
--
-- Returns jsonb, every count a GROUP BY over public.sundial_solar_cache:
--   by_stage  { stage: n }                    -- blank stage under ""; the Solar page has
--                                                no Status tabs, stage IS the grouping
--   pms       [[project_manager, n], ...]     -- tuples, n desc (the PM dropdown)
--   reps      [[sales_rep_name, n], ...]      -- tuples, n desc (the Sales Rep dropdown;
--                                                the page intersects with active users)
--   stats     { total_projects, in_progress, contract_total, system_size_kw_total,
--               recent: [[sf_id, project_name, customer_name, stage, last_synced_at], ...6] }
--
-- STATS (the Dashboard's four cards and Recent Projects):
--   in_progress           stage not blank AND not terminal. TERMINAL = the stage contains
--                         one of p_terminal_terms (case-insensitive substring — the rule
--                         the Dashboard's isTerminalStage() used), UNLESS the stage is
--                         exactly one of p_not_terminal. The two lists are passed by the
--                         Lambda (TERMINAL_STAGE_TERMS / NOT_TERMINAL_STAGES in
--                         sundial-sf-query) so the rule has ONE home; this function only
--                         applies it. NULL lists = nothing is terminal.
--   contract_total        sum(contract_amount); NULL when no row has one (the card's "—")
--   system_size_kw_total  sum(system_size) — the column the Dashboard summed. It IS kW
--                         (System_Size__c). system_size_kw is empty on every Harmon row
--                         (0 of 4,522, 2026-10-06); if it is ever populated, revisit.
--                         NULL when no row has one.
--   recent                the 6 most recently synced rows (last_synced_at desc, sf_id);
--                         customer_name = first + last, else customer_name_at_creation —
--                         the page's customerName() rule.
-- Everything — counts AND stats — covers the SAME rows: the access filter AND the
-- caller's narrowing. The Dashboard sends no narrowing; a rep's dashboard is a rep's book.
--
-- TWO FILTERS, KEPT APART ON PURPOSE (same as sundial_customer_pipeline):
--   p_filters  the ACCESS row filter — built by the Lambda from lib/access.js rowFilter(),
--              never from request input. {"eq": {col: value}}; only sales_rep_sf_id and
--              dealer_sf_id. Anything else RAISES (fail closed).
--   p_narrow   the CALLER's f[stage|project_manager|sales_rep_name]:
--              {col: {"values": [...], "blank": bool}}. Anything else RAISES.
--
-- STATIC SQL ONLY. Column names are never built from input.
--
-- WHO MAY CALL IT: the service role only. SECURITY DEFINER reads the cache past the
-- browser-role revokes, and Postgres grants EXECUTE on a new function to PUBLIC (which
-- anon / authenticated inherit) — hence the revoke below. Re-runnable.

create or replace function public.sundial_solar_pipeline(
  p_client_sf_id   text,
  p_filters        jsonb  default '{}'::jsonb,
  p_narrow         jsonb  default null,
  p_terminal_terms text[] default null,
  p_not_terminal   text[] default null
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
  terms text[] := coalesce(p_terminal_terms, '{}'::text[]);
  keep  text[] := coalesce(p_not_terminal, '{}'::text[]);
  bad text;
  result jsonb;
begin
  if p_client_sf_id is null or btrim(p_client_sf_id) = '' then
    raise exception 'sundial_solar_pipeline: p_client_sf_id is required';
  end if;
  if jsonb_typeof(f) <> 'object' or jsonb_typeof(eqf) <> 'object' or jsonb_typeof(n) <> 'object' then
    raise exception 'sundial_solar_pipeline: filters must be json objects';
  end if;

  -- Fail closed on anything this function does not know how to apply.
  select k into bad from jsonb_object_keys(f) k where k <> 'eq' limit 1;
  if bad is not null then
    raise exception 'sundial_solar_pipeline: unsupported access filter form %', bad;
  end if;
  select k into bad from jsonb_object_keys(eqf) k where k not in ('sales_rep_sf_id', 'dealer_sf_id') limit 1;
  if bad is not null then
    raise exception 'sundial_solar_pipeline: unsupported access filter column %', bad;
  end if;
  select k into bad from jsonb_object_keys(n) k where k not in ('stage', 'project_manager', 'sales_rep_name') limit 1;
  if bad is not null then
    raise exception 'sundial_solar_pipeline: unsupported narrowing column %', bad;
  end if;

  with c as (
    select sf_id, stage, project_manager, sales_rep_name, contract_amount, system_size,
           project_name, first_name, last_name, customer_name_at_creation, last_synced_at
    from public.sundial_solar_cache
    where client_sf_id = p_client_sf_id
      -- The access filter (equalities, ANDed).
      and (not (eqf ? 'sales_rep_sf_id') or sales_rep_sf_id = eqf ->> 'sales_rep_sf_id')
      and (not (eqf ? 'dealer_sf_id')    or dealer_sf_id    = eqf ->> 'dealer_sf_id')
      -- The caller's narrowing: any of the values, or blank when asked.
      and (not (n ? 'stage') or
           stage in (select jsonb_array_elements_text(coalesce(n -> 'stage' -> 'values', '[]'::jsonb)))
           or (coalesce((n -> 'stage' ->> 'blank')::boolean, false) and coalesce(stage, '') = ''))
      and (not (n ? 'project_manager') or
           project_manager in (select jsonb_array_elements_text(coalesce(n -> 'project_manager' -> 'values', '[]'::jsonb)))
           or (coalesce((n -> 'project_manager' ->> 'blank')::boolean, false) and coalesce(project_manager, '') = ''))
      and (not (n ? 'sales_rep_name') or
           sales_rep_name in (select jsonb_array_elements_text(coalesce(n -> 'sales_rep_name' -> 'values', '[]'::jsonb)))
           or (coalesce((n -> 'sales_rep_name' ->> 'blank')::boolean, false) and coalesce(sales_rep_name, '') = ''))
  ),
  sg as (select coalesce(stage, '') g, count(*) cnt from c group by 1),
  pm as (select project_manager v, count(*) cnt from c group by 1),
  rp as (select sales_rep_name v, count(*) cnt from c group by 1),
  -- Terminal per DISTINCT stage (a couple of dozen), not per row.
  term as (
    select g, cnt,
           g <> '' and not (g = any(keep))
             and exists (select 1 from unnest(terms) t where btrim(t) <> '' and position(lower(t) in lower(g)) > 0) as terminal
    from sg
  ),
  rc as (
    select sf_id, project_name,
           coalesce(nullif(btrim(concat_ws(' ', nullif(btrim(first_name), ''), nullif(btrim(last_name), ''))), ''),
                    nullif(btrim(customer_name_at_creation), '')) customer_name,
           stage, last_synced_at
    from c
    order by last_synced_at desc nulls last, sf_id
    limit 6
  )
  select jsonb_build_object(
    'by_stage', coalesce((select jsonb_object_agg(g, cnt) from sg), '{}'::jsonb),
    'pms',      coalesce((select jsonb_agg(jsonb_build_array(v, cnt) order by cnt desc, v) from pm), '[]'::jsonb),
    'reps',     coalesce((select jsonb_agg(jsonb_build_array(v, cnt) order by cnt desc, v) from rp), '[]'::jsonb),
    'stats', jsonb_build_object(
      'total_projects',       (select count(*) from c),
      'in_progress',          coalesce((select sum(cnt) from term where g <> '' and not terminal), 0),
      'contract_total',       (select sum(contract_amount) from c),
      'system_size_kw_total', (select sum(system_size) from c),
      'recent', coalesce((select jsonb_agg(jsonb_build_array(sf_id, project_name, customer_name, stage, last_synced_at)
                                           order by last_synced_at desc nulls last, sf_id) from rc), '[]'::jsonb)
    )
  ) into result;

  return result;
end;
$$;

-- See the header: PUBLIC first, or anon / authenticated keep EXECUTE through it.
revoke all on function public.sundial_solar_pipeline(text, jsonb, jsonb, text[], text[]) from public, anon, authenticated;
grant execute on function public.sundial_solar_pipeline(text, jsonb, jsonb, text[], text[]) to service_role;

-- Check (in the SQL editor) — this must return false for both:
select has_function_privilege('anon', 'public.sundial_solar_pipeline(text, jsonb, jsonb, text[], text[])', 'execute') as anon_can_execute,
       has_function_privilege('authenticated', 'public.sundial_solar_pipeline(text, jsonb, jsonb, text[], text[])', 'execute') as authenticated_can_execute;
