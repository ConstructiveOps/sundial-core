-- sundial_report_values.sql — the distinct values of one report column, for a filter's value
-- picker (D-089 amendment 1, 2026-11-09; docs/reporting-module.md §6.4). Served by
-- lambdas/sundial-reports (GET /reports/values). Reads the Supabase cache only (D-087).
--
--   select public.sundial_report_values('a1W7y000007AszBEAS', 'sundial_customer_cache', 'city', 'mes');
--
-- RETURNS jsonb { values: [{ value, count }], total_distinct }:
--   values          the distinct non-blank values of the column FOR THIS TENANT, narrowed by
--                   p_search (case-insensitive "contains"; null / blank = no narrowing),
--                   most frequent first, then by value; at most 200.
--   total_distinct  how many distinct values matched in all (> 200 means the list is partial).
--
-- THE SAME RULES AS sundial_report_run (sql/sundial_report_run.sql): the table and column
-- must be a row of public.sundial_report_catalog (sql/2026-11-03_report_catalog.sql) or this
-- RAISES; identifiers only through %I, values only through bind parameters; the tenant clause
-- is the first predicate. And it refuses, by RAISE, everything a value list must never show:
--   - a non-reportable column (sf_id, credentials, bookkeeping);
--   - a GATED column (cost / markup) — always, whoever calls: a value list has no gate check;
--   - an id column (sf_id, *_sf_id) — a list of record ids means nothing to a person;
--   - a long-text column (catalog long_text — a textarea > 255);
--   - anything that is not text (numbers / dates / booleans filter by range or a tick).
-- The Lambda refuses all of these first (lib/report-def.js valuesLookupAllowed); a RAISE here
-- means the deployed catalog and the database disagree.
--
-- WHO MAY CALL IT: the service role only (SECURITY DEFINER reads the caches past the
-- browser-role revokes; Postgres grants EXECUTE to PUBLIC by default — hence the revokes at
-- the bottom). Needs the long_text catalog column: run the catalog seed of 2026-11-09 first.
-- Re-runnable (create or replace).

create or replace function public.sundial_report_values(
  p_client_sf_id text,
  p_table        text,
  p_column       text,
  p_search       text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  rec     record;
  pattern text;
  result  jsonb;
begin
  if p_client_sf_id is null or btrim(p_client_sf_id) = '' then
    raise exception 'sundial_report_values: p_client_sf_id is required';
  end if;
  select c.data_type, c.gate, c.reportable, c.long_text into rec
    from public.sundial_report_catalog c
   where c.table_name = p_table and c.column_name = p_column;
  if not found then
    raise exception 'sundial_report_values: unknown column %.%', coalesce(p_table, '(null)'), coalesce(p_column, '(null)');
  end if;
  if not rec.reportable then
    raise exception 'sundial_report_values: column %.% is not reportable', p_table, p_column;
  end if;
  if rec.gate is not null then
    raise exception 'sundial_report_values: column %.% is gated (%)', p_table, p_column, rec.gate;
  end if;
  if p_column = 'sf_id' or p_column like '%\_sf\_id' then
    raise exception 'sundial_report_values: column %.% is an id', p_table, p_column;
  end if;
  if rec.long_text then
    raise exception 'sundial_report_values: column %.% is long text', p_table, p_column;
  end if;
  if rec.data_type not in ('text', 'character varying') then
    raise exception 'sundial_report_values: column %.% is %, not text', p_table, p_column, rec.data_type;
  end if;
  if p_search is not null and length(p_search) > 200 then
    raise exception 'sundial_report_values: the search is longer than 200 characters';
  end if;

  -- "contains", case-insensitive, with the search's own % _ \ escaped (as sundial_report_run).
  if p_search is not null and btrim(p_search) <> '' then
    pattern := '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  execute format(
    'with d as ('
    || ' select t.%1$I as v, count(*) as n from public.%2$I as t'
    || ' where t.client_sf_id = $1 and t.%1$I is not null and btrim(t.%1$I) <> %3$L'
    || ' and ($2::text is null or t.%1$I ilike $2)'
    || ' group by 1'
    || ')'
    || ' select jsonb_build_object('
    || '   %4$L, coalesce((select jsonb_agg(jsonb_build_object(%5$L, x.v, %6$L, x.n) order by x.n desc, x.v)'
    || '              from (select v, n from d order by n desc, v limit 200) x), %7$L::jsonb),'
    || '   %8$L, (select count(*) from d))',
    p_column, p_table, '', 'values', 'value', 'count', '[]', 'total_distinct')
    into result
    using p_client_sf_id, pattern;
  return result;
end;
$$;

-- See the header: PUBLIC first, or anon / authenticated keep EXECUTE through it.
revoke all on function public.sundial_report_values(text, text, text, text) from public, anon, authenticated;
grant execute on function public.sundial_report_values(text, text, text, text) to service_role;

-- Check (in the SQL editor) — both must be false:
select has_function_privilege('anon', 'public.sundial_report_values(text, text, text, text)', 'execute') as anon_can_values,
       has_function_privilege('authenticated', 'public.sundial_report_values(text, text, text, text)', 'execute') as authenticated_can_values;
