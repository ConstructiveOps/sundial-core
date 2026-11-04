-- sundial_report_run.sql — the report engine's executor (D-088, R1a; docs/reporting-module.md §6.4).
-- Served by POST /reports/run (lambdas/sundial-reports). Reads the Supabase cache only —
-- Salesforce is never the report engine (D-087).
--
--   select public.sundial_report_run('a1W7y000007AszBEAS', '<wire definition>'::jsonb);
--
-- THE WIRE DEFINITION is what lib/report-def.js normalizeDefinition() produces — never the
-- browser's JSON. By the time it gets here the Lambda has already checked every field
-- against the catalog, removed every gated column the caller may not see, resolved relative
-- dates in Arizona time and capped the limit. This function trusts NONE of that and checks
-- it again: every identifier it puts into SQL is looked up in public.sundial_report_catalog
-- (sql/2026-11-03_report_catalog.sql, GENERATED) and anything not there RAISES.
--   {
--     "base":   { "table": "sundial_solar_cache", "alias": "solar" },
--     "joins":  [{ "table", "alias", "kind": "left", "left_alias", "left_column", "right_column" }],
--     "grouped": false,                       true = GROUP BY the one column in "columns"
--     "columns": [{ "alias", "column" }],     ≤ 50 (exactly 1 when grouped)
--     "filters": [{ "alias", "column", "op", "value" }],   ANDed, ≤ 50
--     "aggregates": [{ "fn", "alias"?, "column"?, "name" }],  ≤ 10
--     "sort":   [{ "position": 1-based output position, "dir": "asc"|"desc" }],  ≤ 5
--     "limit":  1..5000,
--     "allowedGates": ["service.costing.read"]   the gates the caller holds
--   }
--
-- RETURNS jsonb { rows, aggregates, truncated }:
--   rows        [[v1, v2, ...], ...] in output order — the columns, or (grouped) the group
--               value then each aggregate. Arrays, not objects: 5,000 rows must fit the
--               Lambda's 6 MB response.
--   aggregates  { name: value } — GRAND TOTALS over every matching row, not just the rows
--               returned ({} when none were asked for).
--   truncated   true when more than `limit` rows matched; `rows` then holds the first `limit`.
--
-- HOW THE SQL IS BUILT. Mechanically: identifiers only through format('%I'), values only
-- through %L / quote_literal. The TENANT CLAUSE (`<alias>.client_sf_id = p_client_sf_id`) is
-- the first predicate on the base table and is inside EVERY join's ON — a joined row from
-- another tenant is never matched, whatever the join key says. `client_sf_id` is the one
-- column name this function writes itself; it is the isolation key on every cache table.
--
-- OPERATORS (wire), by the column's Postgres type:
--   text (incl. picklist / reference)  eq neq in not_in contains starts_with is_blank not_blank
--   numeric / integer                  eq neq gt gte lt lte between is_blank
--   date                               eq gt lt gte lte between is_blank   (before → lt, after → gt)
--   timestamptz                        eq gt gte lt lte between is_blank   (days → [gte, lt))
--   boolean                            eq is_blank
--   neq / not_in include NULLs (IS DISTINCT FROM); contains / starts_with are ILIKE with the
--   value's own % _ \ escaped; is_blank on text is NULL or only spaces.
--
-- WHO MAY CALL IT: the service role only (SECURITY DEFINER reads the caches past the
-- browser-role revokes; Postgres grants EXECUTE to PUBLIC by default — hence the revokes at
-- the bottom). Re-runnable.

-- One column of one aliased table, checked against the catalog. Returns its Postgres type.
-- p_aliases: { alias: table }. p_reportable: the column must be selectable (false = a join key).
create or replace function public.sundial_report_column(
  p_aliases    jsonb,
  p_alias      text,
  p_column     text,
  p_gates      text[],
  p_reportable boolean
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  t   text := p_aliases ->> p_alias;
  rec record;
begin
  if p_alias is null or t is null then
    raise exception 'sundial_report_run: unknown alias %', coalesce(p_alias, '(null)');
  end if;
  select c.data_type, c.gate, c.reportable into rec
    from public.sundial_report_catalog c
   where c.table_name = t and c.column_name = p_column;
  if not found then
    raise exception 'sundial_report_run: unknown column %.%', p_alias, coalesce(p_column, '(null)');
  end if;
  if p_reportable and not rec.reportable then
    raise exception 'sundial_report_run: column %.% is not reportable', p_alias, p_column;
  end if;
  if rec.gate is not null and not (rec.gate = any(coalesce(p_gates, '{}'::text[]))) then
    raise exception 'sundial_report_run: column %.% needs %', p_alias, p_column, rec.gate;
  end if;
  return rec.data_type;
end;
$$;

create or replace function public.sundial_report_run(
  p_client_sf_id text,
  p_def          jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  d        jsonb := coalesce(p_def, '{}'::jsonb);
  gates    text[];
  aliases  jsonb := '{}'::jsonb;
  base_t   text;
  base_a   text;
  grouped  boolean;
  lim      int;
  from_sql text;
  where_sql text;
  outs     text[] := '{}';
  ord      text[] := '{}';
  ord_q    text[] := '{}';
  aggs_sql text[] := '{}';
  j        jsonb;
  f        jsonb;
  a        jsonb;
  s        jsonb;
  dt       text;
  col      text;
  op       text;
  v        jsonb;
  pos      int;
  n_out    int;
  is_text  boolean;
  is_num   boolean;
  pred     text;
  rows_json jsonb;
  totals   jsonb := '{}'::jsonb;
  truncated boolean := false;
  sql      text;
  alias_re constant text := '^[a-z][a-z0-9_]{0,30}$';
  name_re  constant text := '^[a-z][a-z0-9_]{0,62}$';
begin
  if p_client_sf_id is null or btrim(p_client_sf_id) = '' then
    raise exception 'sundial_report_run: p_client_sf_id is required';
  end if;
  if jsonb_typeof(d) <> 'object' then
    raise exception 'sundial_report_run: the definition must be a json object';
  end if;
  select coalesce(array_agg(x), '{}'::text[]) into gates
    from jsonb_array_elements_text(coalesce(d -> 'allowedGates', '[]'::jsonb)) x;

  -- limit: 1..5000. Fetch one more to know whether the result was cut.
  if jsonb_typeof(d -> 'limit') <> 'number' then
    raise exception 'sundial_report_run: limit is required';
  end if;
  lim := (d ->> 'limit')::int;
  if lim < 1 or lim > 5000 then
    raise exception 'sundial_report_run: limit must be 1..5000, got %', lim;
  end if;
  grouped := coalesce((d ->> 'grouped')::boolean, false);

  -- The base table: a catalog table, a well-formed alias, the tenant clause first.
  base_t := d -> 'base' ->> 'table';
  base_a := d -> 'base' ->> 'alias';
  if base_a is null or base_a !~ alias_re then
    raise exception 'sundial_report_run: bad base alias %', coalesce(base_a, '(null)');
  end if;
  if not exists (select 1 from public.sundial_report_catalog where table_name = base_t) then
    raise exception 'sundial_report_run: unknown table %', coalesce(base_t, '(null)');
  end if;
  aliases := jsonb_build_object(base_a, base_t);
  from_sql := format('public.%I as %I', base_t, base_a);
  where_sql := format('%I.client_sf_id = %L', base_a, p_client_sf_id);

  -- Joins: left joins only, onto a catalog table, keyed on catalog columns, tenant inside ON.
  for j in select * from jsonb_array_elements(coalesce(d -> 'joins', '[]'::jsonb)) loop
    if coalesce(j ->> 'kind', '') <> 'left' then
      raise exception 'sundial_report_run: join kind must be left';
    end if;
    if (j ->> 'alias') is null or (j ->> 'alias') !~ alias_re or aliases ? (j ->> 'alias') then
      raise exception 'sundial_report_run: bad join alias %', coalesce(j ->> 'alias', '(null)');
    end if;
    if not exists (select 1 from public.sundial_report_catalog where table_name = j ->> 'table') then
      raise exception 'sundial_report_run: unknown table %', coalesce(j ->> 'table', '(null)');
    end if;
    perform public.sundial_report_column(aliases, j ->> 'left_alias', j ->> 'left_column', gates, false);
    aliases := aliases || jsonb_build_object(j ->> 'alias', j ->> 'table');
    perform public.sundial_report_column(aliases, j ->> 'alias', j ->> 'right_column', gates, false);
    from_sql := from_sql || format(
      ' left join public.%I as %I on %I.%I = %I.%I and %I.client_sf_id = %L',
      j ->> 'table', j ->> 'alias',
      j ->> 'alias', j ->> 'right_column', j ->> 'left_alias', j ->> 'left_column',
      j ->> 'alias', p_client_sf_id);
  end loop;

  -- Filters, ANDed.
  if jsonb_array_length(coalesce(d -> 'filters', '[]'::jsonb)) > 50 then
    raise exception 'sundial_report_run: too many filters';
  end if;
  for f in select * from jsonb_array_elements(coalesce(d -> 'filters', '[]'::jsonb)) loop
    dt := public.sundial_report_column(aliases, f ->> 'alias', f ->> 'column', gates, true);
    col := format('%I.%I', f ->> 'alias', f ->> 'column');
    op := f ->> 'op';
    v := f -> 'value';
    is_text := dt in ('text', 'character varying');
    is_num := dt in ('numeric', 'integer', 'bigint', 'double precision', 'real', 'smallint');
    if not (
         (is_text and op in ('eq', 'neq', 'in', 'not_in', 'contains', 'starts_with', 'is_blank', 'not_blank'))
      or (is_num and op in ('eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_blank'))
      or (dt in ('date', 'timestamp with time zone') and op in ('eq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_blank'))
      or (dt = 'boolean' and op in ('eq', 'is_blank'))
    ) then
      raise exception 'sundial_report_run: operator % is not allowed on %.% (%)', coalesce(op, '(null)'), f ->> 'alias', f ->> 'column', dt;
    end if;
    -- The value's shape for the operator.
    if op in ('is_blank', 'not_blank') then
      if v is not null and jsonb_typeof(v) <> 'null' then
        raise exception 'sundial_report_run: % takes no value', op;
      end if;
    elsif op in ('in', 'not_in') then
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) < 1 or jsonb_array_length(v) > 500
         or exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string') then
        raise exception 'sundial_report_run: % takes a list of 1..500 strings', op;
      end if;
    elsif op = 'between' then
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) <> 2
         or jsonb_typeof(v -> 0) <> 'string' or jsonb_typeof(v -> 1) <> 'string' then
        raise exception 'sundial_report_run: between takes [from, to]';
      end if;
    elsif v is null or jsonb_typeof(v) <> 'string' then
      raise exception 'sundial_report_run: % takes one string value', op;
    end if;

    pred := case op
      when 'eq'          then format('%s = %L', col, v #>> '{}')
      when 'neq'         then format('%s is distinct from %L', col, v #>> '{}')
      when 'gt'          then format('%s > %L', col, v #>> '{}')
      when 'gte'         then format('%s >= %L', col, v #>> '{}')
      when 'lt'          then format('%s < %L', col, v #>> '{}')
      when 'lte'         then format('%s <= %L', col, v #>> '{}')
      when 'between'     then format('%s between %L and %L', col, v ->> 0, v ->> 1)
      when 'in'          then format('%s in (%s)', col, (select string_agg(quote_literal(x), ', ') from jsonb_array_elements_text(v) x))
      when 'not_in'      then format('(%s is null or %s not in (%s))', col, col, (select string_agg(quote_literal(x), ', ') from jsonb_array_elements_text(v) x))
      when 'contains'    then format('%s ilike %L', col,
                                     '%' || replace(replace(replace(v #>> '{}', '\', '\\'), '%', '\%'), '_', '\_') || '%')
      when 'starts_with' then format('%s ilike %L', col,
                                     replace(replace(replace(v #>> '{}', '\', '\\'), '%', '\%'), '_', '\_') || '%')
      when 'is_blank'    then case when is_text then format('(%s is null or btrim(%s) = %L)', col, col, '') else format('%s is null', col) end
      when 'not_blank'   then format('(%s is not null and btrim(%s) <> %L)', col, col, '')
    end;
    where_sql := where_sql || ' and ' || pred;
  end loop;

  -- Output columns.
  if jsonb_array_length(coalesce(d -> 'columns', '[]'::jsonb)) > 50 then
    raise exception 'sundial_report_run: too many columns';
  end if;
  if grouped and jsonb_array_length(coalesce(d -> 'columns', '[]'::jsonb)) <> 1 then
    raise exception 'sundial_report_run: a grouped report has exactly one group column';
  end if;
  for f in select * from jsonb_array_elements(coalesce(d -> 'columns', '[]'::jsonb)) loop
    perform public.sundial_report_column(aliases, f ->> 'alias', f ->> 'column', gates, true);
    outs := outs || format('%I.%I', f ->> 'alias', f ->> 'column');
  end loop;

  -- Aggregates: per group (grouped) and always as grand totals.
  if jsonb_array_length(coalesce(d -> 'aggregates', '[]'::jsonb)) > 10 then
    raise exception 'sundial_report_run: too many aggregates';
  end if;
  for a in select * from jsonb_array_elements(coalesce(d -> 'aggregates', '[]'::jsonb)) loop
    if coalesce(a ->> 'name', '') !~ name_re then
      raise exception 'sundial_report_run: bad aggregate name %', coalesce(a ->> 'name', '(null)');
    end if;
    if a ->> 'fn' = 'count' then
      if a ? 'column' then
        raise exception 'sundial_report_run: count takes no column';
      end if;
      col := 'count(*)';
    elsif a ->> 'fn' in ('sum', 'avg', 'min', 'max') then
      dt := public.sundial_report_column(aliases, a ->> 'alias', a ->> 'column', gates, true);
      if a ->> 'fn' in ('sum', 'avg') and dt not in ('numeric', 'integer', 'bigint', 'double precision', 'real', 'smallint') then
        raise exception 'sundial_report_run: % needs a number column', a ->> 'fn';
      end if;
      if dt not in ('numeric', 'integer', 'bigint', 'double precision', 'real', 'smallint', 'date', 'timestamp with time zone') then
        raise exception 'sundial_report_run: % is not allowed on %', a ->> 'fn', dt;
      end if;
      col := format('%s(%I.%I)', a ->> 'fn', a ->> 'alias', a ->> 'column');
    else
      raise exception 'sundial_report_run: unknown aggregate %', coalesce(a ->> 'fn', '(null)');
    end if;
    aggs_sql := aggs_sql || format('%L, %s', a ->> 'name', col);
    if grouped then
      outs := outs || col;
    end if;
  end loop;

  n_out := coalesce(array_length(outs, 1), 0);
  if not grouped and n_out = 0 and coalesce(array_length(aggs_sql, 1), 0) = 0 then
    raise exception 'sundial_report_run: nothing to return';
  end if;

  -- Rows.
  if n_out > 0 then
    if jsonb_array_length(coalesce(d -> 'sort', '[]'::jsonb)) > 5 then
      raise exception 'sundial_report_run: too many sorts';
    end if;
    for s in select * from jsonb_array_elements(coalesce(d -> 'sort', '[]'::jsonb)) loop
      if jsonb_typeof(s -> 'position') <> 'number' then
        raise exception 'sundial_report_run: sort position must be a number';
      end if;
      pos := (s ->> 'position')::int;
      if pos < 1 or pos > n_out then
        raise exception 'sundial_report_run: sort position % is outside 1..%', pos, n_out;
      end if;
      if coalesce(s ->> 'dir', 'asc') not in ('asc', 'desc') then
        raise exception 'sundial_report_run: sort dir must be asc or desc';
      end if;
      ord   := ord   || format('%I %s nulls last', '__o' || pos, coalesce(s ->> 'dir', 'asc'));
      ord_q := ord_q || format('q.%I %s nulls last', '__o' || pos, coalesce(s ->> 'dir', 'asc'));
    end loop;
    -- A deterministic tiebreak: the record id, or (grouped) the group value.
    if grouped then
      ord := ord || '__o1 asc nulls last'::text;
      ord_q := ord_q || 'q.__o1 asc nulls last'::text;
    else
      ord := ord || '__k asc'::text;
      ord_q := ord_q || 'q.__k asc'::text;
    end if;

    sql := format(
      'select coalesce(jsonb_agg(jsonb_build_array(%s) order by %s), %L::jsonb) from ('
      || 'select %s%s from %s where %s%s order by %s limit %s'
      || ') q',
      (select string_agg(format('q.%I', '__o' || i), ', ' order by i) from generate_series(1, n_out) i),
      array_to_string(ord_q, ', '),
      '[]',
      (select string_agg(format('%s as %I', outs[i], '__o' || i), ', ' order by i) from generate_series(1, n_out) i),
      case when grouped then '' else format(', %I.sf_id as __k', base_a) end,
      from_sql,
      where_sql,
      case when grouped then ' group by 1' else '' end,
      array_to_string(ord, ', '),
      lim + 1);
    execute sql into rows_json;
    if jsonb_array_length(rows_json) > lim then
      truncated := true;
      rows_json := rows_json - lim; -- drop the (limit+1)th row
    end if;
  else
    rows_json := '[]'::jsonb;
  end if;

  -- Grand totals over every matching row.
  if coalesce(array_length(aggs_sql, 1), 0) > 0 then
    execute format('select jsonb_build_object(%s) from %s where %s', array_to_string(aggs_sql, ', '), from_sql, where_sql)
      into totals;
  end if;

  return jsonb_build_object('rows', rows_json, 'aggregates', totals, 'truncated', truncated);
end;
$$;

-- See the header: PUBLIC first, or anon / authenticated keep EXECUTE through it.
revoke all on function public.sundial_report_column(jsonb, text, text, text[], boolean) from public, anon, authenticated;
grant execute on function public.sundial_report_column(jsonb, text, text, text[], boolean) to service_role;
revoke all on function public.sundial_report_run(text, jsonb) from public, anon, authenticated;
grant execute on function public.sundial_report_run(text, jsonb) to service_role;

-- Check (in the SQL editor) — all four must be false:
select has_function_privilege('anon', 'public.sundial_report_run(text, jsonb)', 'execute') as anon_can_run,
       has_function_privilege('authenticated', 'public.sundial_report_run(text, jsonb)', 'execute') as authenticated_can_run,
       has_function_privilege('anon', 'public.sundial_report_column(jsonb, text, text, text[], boolean)', 'execute') as anon_can_check,
       has_function_privilege('authenticated', 'public.sundial_report_column(jsonb, text, text, text[], boolean)', 'execute') as authenticated_can_check;
