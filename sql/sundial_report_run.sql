-- sundial_report_run.sql — the report engine's executor (D-088 R1a, D-089 R1b;
-- docs/reporting-module.md §6.4). Served by lambdas/sundial-reports (POST /reports/run, the
-- CSV export, saved reports). Reads the Supabase cache only — Salesforce is never the report
-- engine (D-087).
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
--     "joins":  [{ "table", "alias", "kind", "left_alias", "left_column", "right_column",
--                  "where"?: [{ "column", "op": "in"|"not_in", "value": [text, ...] }],
--                  "measures"?: [{ "name", "fn": "count"|"sum"|"max", "column"?,
--                                  "where"?: [...], "negate_when"?: { "column", "value": [...] } }] }],
--     "grouped": false,                       true = GROUP BY the one column in "columns"
--     "columns": [{ "alias", "column" }],     ≤ 50 (exactly 1 when grouped)
--     "filters": [{ "alias", "column", "op", "value" }],   ANDed, ≤ 50
--     "aggregates": [{ "fn", "alias"?, "column"?, "name" }],  ≤ 10
--     "sort":   [{ "position": 1-based output position, "dir": "asc"|"desc" }],  ≤ 5
--     "limit":  1..5000,
--     "offset": 0..49999                      (R1b: the CSV export pages with it; default 0)
--     "totals": true|false                    (R1b: false skips the grand totals; default true)
--     "allowedGates": ["service.costing.read"]   the gates the caller holds
--   }
--
-- THE JOIN KINDS (R1b, D-089). Each yields AT MOST ONE row per base row, so a report has
-- exactly its base object's rows — a join never multiplies or drops one:
--   lookup  (R1a's "left", still accepted) LEFT JOIN T AS a ON a.<right> = l.<left>.
--   latest  the NEWEST child: one DISTINCT ON pass over the child table's narrow columns
--           (key, sf_id — ORDER BY created_date DESC NULLS LAST, sf_id ASC, the dealer shell's
--           "leading solar" order), optionally narrowed by `where`, then the child row by
--           primary key. One pass + hash joins, not a subquery per base row: the per-row
--           LATERAL took 14 s for 39,431 customers × solar (2026-11-04), this takes < 1 s.
--   rollup  one GROUP BY pass over the children → one row of MEASURES per key, hash-joined.
--           A measure is count(*) / sum(col) / max(col), each with an optional `where`
--           (FILTER) and `negate_when` (sum: subtract the rows whose column is in the list —
--           a Refund is stored positive). The join's `where` narrows every measure. The
--           measures are the alias's only "columns"; a count or a sum over NO children reads
--           as 0 (coalesced wherever it is referenced), a max as blank.
--   `where` items: in = "column is one of", not_in = "column is blank or not one of" (the
--   D-080 IS DISTINCT FROM rule), on text columns only.
--
-- RETURNS jsonb { rows, aggregates, truncated }:
--   rows        [[v1, v2, ...], ...] in output order — the columns, or (grouped) the group
--               value then each aggregate. Arrays, not objects: 5,000 rows must fit the
--               Lambda's 6 MB response.
--   aggregates  { name: value } — GRAND TOTALS over every matching row, not just the rows
--               returned ({} when none were asked for, or "totals": false).
--   truncated   true when more than `limit` rows matched past `offset`; `rows` then holds
--               the first `limit` (the CSV export reads the next page while it is true).
--
-- HOW THE SQL IS BUILT. Mechanically: identifiers only through format('%I'), values only
-- through %L / quote_literal. The TENANT CLAUSE (`client_sf_id = p_client_sf_id`) is the
-- first predicate on the base table and is inside EVERY join — in a lookup's ON, in a latest's
-- and a rollup's inner WHERE, and on a latest's primary-key join — so a joined row from
-- another tenant is never matched, whatever the join key says. `client_sf_id`, and for a
-- latest `created_date` / `sf_id` (checked against the catalog first), are the only column
-- names this function writes itself; every cache table has them.
--
-- OPERATORS (wire), by the column's Postgres type:
--   text (incl. picklist / reference)  eq neq in not_in contains starts_with is_blank not_blank
--   numeric / integer / bigint         eq neq gt gte lt lte between is_blank
--   date                               eq gt lt gte lte between is_blank   (before → lt, after → gt)
--   timestamptz                        eq gt gte lt lte between is_blank   (days → [gte, lt))
--   boolean                            eq is_blank
--   neq / not_in include NULLs (IS DISTINCT FROM); contains / starts_with are ILIKE with the
--   value's own % _ \ escaped; is_blank on text is NULL or only spaces.
--
-- WHO MAY CALL IT: the service role only (SECURITY DEFINER reads the caches past the
-- browser-role revokes; Postgres grants EXECUTE to PUBLIC by default — hence the revokes at
-- the bottom). Re-runnable (create or replace; same signatures as R1a).

-- One column of one alias, checked against the catalog. Returns its Postgres type.
-- p_aliases: { alias: table } for a table alias, { alias: { measure: { t, z } } } for a rollup
-- (t = the measure's type, z = reads as 0 when there are no children).
-- p_reportable: the column must be selectable (false = a join key).
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
  t   text;
  rec record;
begin
  if p_alias is null or not (p_aliases ? p_alias) then
    raise exception 'sundial_report_run: unknown alias %', coalesce(p_alias, '(null)');
  end if;
  if jsonb_typeof(p_aliases -> p_alias) = 'object' then
    -- A rollup: its measures are its only columns (their source columns were checked, gate
    -- included, when the join was built).
    if p_column is null or not ((p_aliases -> p_alias) ? p_column) then
      raise exception 'sundial_report_run: unknown column %.%', p_alias, coalesce(p_column, '(null)');
    end if;
    return p_aliases -> p_alias -> p_column ->> 't';
  end if;
  t := p_aliases ->> p_alias;
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

-- A join's `where` items → ' and (…)' predicates on the child table aliased "__r".
-- Each column is checked against the catalog (a join key need not be reportable) and must be
-- text; values are a list of 1..500 strings.
create or replace function public.sundial_report_join_where(
  p_table text,
  p_items jsonb,
  p_gates text[]
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  w   jsonb;
  dt  text;
  lst text;
  out text := '';
begin
  if p_items is null or jsonb_typeof(p_items) = 'null' then
    return '';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 10 then
    raise exception 'sundial_report_run: a join where is a list of at most 10 items';
  end if;
  for w in select * from jsonb_array_elements(p_items) loop
    dt := public.sundial_report_column(jsonb_build_object(p_table, p_table), p_table, w ->> 'column', p_gates, false);
    if dt not in ('text', 'character varying') then
      raise exception 'sundial_report_run: a join where needs a text column, %.% is %', p_table, w ->> 'column', dt;
    end if;
    if jsonb_typeof(w -> 'value') <> 'array' or jsonb_array_length(w -> 'value') < 1 or jsonb_array_length(w -> 'value') > 500
       or exists (select 1 from jsonb_array_elements(w -> 'value') e where jsonb_typeof(e) <> 'string') then
      raise exception 'sundial_report_run: a join where takes a list of 1..500 strings';
    end if;
    select string_agg(quote_literal(x), ', ') into lst from jsonb_array_elements_text(w -> 'value') x;
    if w ->> 'op' = 'in' then
      out := out || format(' and __r.%I in (%s)', w ->> 'column', lst);
    elsif w ->> 'op' = 'not_in' then
      out := out || format(' and (__r.%I is null or __r.%I not in (%s))', w ->> 'column', w ->> 'column', lst);
    else
      raise exception 'sundial_report_run: a join where op must be in or not_in, got %', coalesce(w ->> 'op', '(null)');
    end if;
  end loop;
  return out;
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
  off      int := 0;
  want_totals boolean := true;
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
  m        jsonb;
  jk       text;
  ja       text;
  jt       text;
  jw       text;
  mw       text;
  mexpr    text;
  mval     text;
  msel     text[];
  mtypes   jsonb;
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
  num_types constant text[] := array['numeric', 'integer', 'bigint', 'double precision', 'real', 'smallint'];
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
  if jsonb_typeof(d -> 'limit') is distinct from 'number' then
    raise exception 'sundial_report_run: limit is required';
  end if;
  lim := (d ->> 'limit')::int;
  if lim < 1 or lim > 5000 then
    raise exception 'sundial_report_run: limit must be 1..5000, got %', lim;
  end if;
  -- offset: 0..49999 (the CSV export's pages).
  if d ? 'offset' and jsonb_typeof(d -> 'offset') <> 'null' then
    if jsonb_typeof(d -> 'offset') <> 'number' then
      raise exception 'sundial_report_run: offset must be a number';
    end if;
    off := (d ->> 'offset')::int;
    if off < 0 or off > 49999 then
      raise exception 'sundial_report_run: offset must be 0..49999, got %', off;
    end if;
  end if;
  if d ? 'totals' and jsonb_typeof(d -> 'totals') <> 'null' then
    if jsonb_typeof(d -> 'totals') <> 'boolean' then
      raise exception 'sundial_report_run: totals must be true or false';
    end if;
    want_totals := (d ->> 'totals')::boolean;
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

  -- Joins: onto a catalog table, keyed on catalog columns, tenant inside every one.
  if jsonb_array_length(coalesce(d -> 'joins', '[]'::jsonb)) > 10 then
    raise exception 'sundial_report_run: too many joins';
  end if;
  for j in select * from jsonb_array_elements(coalesce(d -> 'joins', '[]'::jsonb)) loop
    jk := coalesce(j ->> 'kind', '');
    ja := j ->> 'alias';
    jt := j ->> 'table';
    if jk not in ('left', 'lookup', 'latest', 'rollup') then
      raise exception 'sundial_report_run: join kind must be lookup, latest or rollup, got %', jk;
    end if;
    if ja is null or ja !~ alias_re or aliases ? ja then
      raise exception 'sundial_report_run: bad join alias %', coalesce(ja, '(null)');
    end if;
    if not exists (select 1 from public.sundial_report_catalog where table_name = jt) then
      raise exception 'sundial_report_run: unknown table %', coalesce(jt, '(null)');
    end if;
    perform public.sundial_report_column(aliases, j ->> 'left_alias', j ->> 'left_column', gates, false);
    perform public.sundial_report_column(jsonb_build_object(ja, jt), ja, j ->> 'right_column', gates, false);
    if jk in ('left', 'lookup') then
      if j ? 'where' or j ? 'measures' then
        raise exception 'sundial_report_run: a lookup join takes no where / measures';
      end if;
      aliases := aliases || jsonb_build_object(ja, jt);
      from_sql := from_sql || format(
        ' left join public.%I as %I on %I.%I = %I.%I and %I.client_sf_id = %L',
        jt, ja, ja, j ->> 'right_column', j ->> 'left_alias', j ->> 'left_column', ja, p_client_sf_id);

    elsif jk = 'latest' then
      if j ? 'measures' then
        raise exception 'sundial_report_run: a latest join takes no measures';
      end if;
      perform public.sundial_report_column(jsonb_build_object(ja, jt), ja, 'created_date', gates, false);
      perform public.sundial_report_column(jsonb_build_object(ja, jt), ja, 'sf_id', gates, false);
      jw := public.sundial_report_join_where(jt, j -> 'where', gates);
      aliases := aliases || jsonb_build_object(ja, jt);
      -- The newest child's id per key, in one narrow pass; then the child row by primary key.
      from_sql := from_sql || format(
        ' left join (select distinct on (__r.%1$I) __r.%1$I as __key, __r.sf_id as __id'
        || ' from public.%2$I as __r where __r.client_sf_id = %3$L and __r.%1$I is not null%4$s'
        || ' order by __r.%1$I, __r.created_date desc nulls last, __r.sf_id asc) as %5$I on %5$I.__key = %6$I.%7$I'
        || ' left join public.%2$I as %8$I on %8$I.sf_id = %5$I.__id and %8$I.client_sf_id = %3$L',
        j ->> 'right_column', jt, p_client_sf_id, jw, '__l_' || ja, j ->> 'left_alias', j ->> 'left_column', ja);

    else -- rollup
      if jsonb_typeof(j -> 'measures') is distinct from 'array'
         or jsonb_array_length(j -> 'measures') < 1 or jsonb_array_length(j -> 'measures') > 20 then
        raise exception 'sundial_report_run: a rollup join takes 1..20 measures';
      end if;
      jw := public.sundial_report_join_where(jt, j -> 'where', gates);
      mtypes := '{}'::jsonb;
      msel := '{}';
      for m in select * from jsonb_array_elements(j -> 'measures') loop
        if coalesce(m ->> 'name', '') !~ name_re or mtypes ? (m ->> 'name') then
          raise exception 'sundial_report_run: bad measure name %', coalesce(m ->> 'name', '(null)');
        end if;
        mw := public.sundial_report_join_where(jt, m -> 'where', gates);
        if m ->> 'fn' = 'count' then
          if m ? 'column' or m ? 'negate_when' then
            raise exception 'sundial_report_run: a count measure takes no column';
          end if;
          mexpr := case when mw = '' then 'count(*)' else format('count(*) filter (where true%s)', mw) end;
          mtypes := mtypes || jsonb_build_object(m ->> 'name', jsonb_build_object('t', 'bigint', 'z', true));
        elsif m ->> 'fn' in ('sum', 'max') then
          dt := public.sundial_report_column(jsonb_build_object(ja, jt), ja, m ->> 'column', gates, true);
          if m ->> 'fn' = 'sum' and not (dt = any(num_types)) then
            raise exception 'sundial_report_run: a sum measure needs a number column';
          end if;
          if not (dt = any(num_types) or dt in ('date', 'timestamp with time zone')) then
            raise exception 'sundial_report_run: % is not allowed on %', m ->> 'fn', dt;
          end if;
          mval := format('__r.%I', m ->> 'column');
          if m ? 'negate_when' then
            if m ->> 'fn' <> 'sum' then
              raise exception 'sundial_report_run: negate_when is for a sum';
            end if;
            -- Reuse the where checker for the condition's column and values.
            perform public.sundial_report_join_where(jt,
              jsonb_build_array(jsonb_build_object('column', m -> 'negate_when' ->> 'column', 'op', 'in', 'value', m -> 'negate_when' -> 'value')), gates);
            mval := format('case when __r.%I in (%s) then -__r.%I else __r.%I end',
              m -> 'negate_when' ->> 'column',
              (select string_agg(quote_literal(x), ', ') from jsonb_array_elements_text(m -> 'negate_when' -> 'value') x),
              m ->> 'column', m ->> 'column');
          end if;
          mexpr := format('%s(%s)', m ->> 'fn', mval) || case when mw = '' then '' else format(' filter (where true%s)', mw) end;
          mtypes := mtypes || jsonb_build_object(m ->> 'name', jsonb_build_object(
            't', case when m ->> 'fn' = 'sum' then 'numeric' else dt end,
            'z', m ->> 'fn' = 'sum'));
        else
          raise exception 'sundial_report_run: unknown measure function %', coalesce(m ->> 'fn', '(null)');
        end if;
        msel := msel || format('%s as %I', mexpr, m ->> 'name');
      end loop;
      aliases := aliases || jsonb_build_object(ja, mtypes);
      from_sql := from_sql || format(
        ' left join (select __r.%1$I as __key, %2$s from public.%3$I as __r'
        || ' where __r.client_sf_id = %4$L and __r.%1$I is not null%5$s group by 1) as %6$I on %6$I.__key = %7$I.%8$I',
        j ->> 'right_column', array_to_string(msel, ', '), jt, p_client_sf_id, jw, ja, j ->> 'left_alias', j ->> 'left_column');
    end if;
  end loop;

  -- Filters, ANDed.
  if jsonb_array_length(coalesce(d -> 'filters', '[]'::jsonb)) > 50 then
    raise exception 'sundial_report_run: too many filters';
  end if;
  for f in select * from jsonb_array_elements(coalesce(d -> 'filters', '[]'::jsonb)) loop
    dt := public.sundial_report_column(aliases, f ->> 'alias', f ->> 'column', gates, true);
    col := public.sundial_report_ref(aliases, f ->> 'alias', f ->> 'column');
    op := f ->> 'op';
    v := f -> 'value';
    is_text := dt in ('text', 'character varying');
    is_num := dt = any(num_types);
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
    outs := outs || public.sundial_report_ref(aliases, f ->> 'alias', f ->> 'column');
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
      if a ->> 'fn' in ('sum', 'avg') and not (dt = any(num_types)) then
        raise exception 'sundial_report_run: % needs a number column', a ->> 'fn';
      end if;
      if not (dt = any(num_types) or dt in ('date', 'timestamp with time zone')) then
        raise exception 'sundial_report_run: % is not allowed on %', a ->> 'fn', dt;
      end if;
      col := format('%s(%s)', a ->> 'fn', public.sundial_report_ref(aliases, a ->> 'alias', a ->> 'column'));
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
    -- A deterministic tiebreak: the record id, or (grouped) the group value. It is what makes
    -- the CSV export's pages (offset) partition the result exactly.
    if grouped then
      ord := ord || '__o1 asc nulls last'::text;
      ord_q := ord_q || 'q.__o1 asc nulls last'::text;
    else
      ord := ord || '__k asc'::text;
      ord_q := ord_q || 'q.__k asc'::text;
    end if;

    sql := format(
      'select coalesce(jsonb_agg(jsonb_build_array(%s) order by %s), %L::jsonb) from ('
      || 'select %s%s from %s where %s%s order by %s limit %s offset %s'
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
      lim + 1,
      off);
    execute sql into rows_json;
    if jsonb_array_length(rows_json) > lim then
      truncated := true;
      rows_json := rows_json - lim; -- drop the (limit+1)th row
    end if;
  else
    rows_json := '[]'::jsonb;
  end if;

  -- Grand totals over every matching row.
  if want_totals and coalesce(array_length(aggs_sql, 1), 0) > 0 then
    execute format('select jsonb_build_object(%s) from %s where %s', array_to_string(aggs_sql, ', '), from_sql, where_sql)
      into totals;
  end if;

  return jsonb_build_object('rows', rows_json, 'aggregates', totals, 'truncated', truncated);
end;
$$;

-- How a checked column is referenced in SQL: "alias"."column", or for a rollup's count / sum
-- coalesce("alias"."column", 0) — a job with no payments has paid 0, not "blank".
-- Call only AFTER sundial_report_column has accepted the pair.
create or replace function public.sundial_report_ref(
  p_aliases jsonb,
  p_alias   text,
  p_column  text
)
returns text
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select case
    when jsonb_typeof(p_aliases -> p_alias) = 'object'
         and coalesce((p_aliases -> p_alias -> p_column ->> 'z')::boolean, false)
      then format('coalesce(%I.%I, 0)', p_alias, p_column)
    else format('%I.%I', p_alias, p_column)
  end;
$$;

-- See the header: PUBLIC first, or anon / authenticated keep EXECUTE through it.
revoke all on function public.sundial_report_column(jsonb, text, text, text[], boolean) from public, anon, authenticated;
grant execute on function public.sundial_report_column(jsonb, text, text, text[], boolean) to service_role;
revoke all on function public.sundial_report_join_where(text, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.sundial_report_join_where(text, jsonb, text[]) to service_role;
revoke all on function public.sundial_report_ref(jsonb, text, text) from public, anon, authenticated;
grant execute on function public.sundial_report_ref(jsonb, text, text) to service_role;
revoke all on function public.sundial_report_run(text, jsonb) from public, anon, authenticated;
grant execute on function public.sundial_report_run(text, jsonb) to service_role;

-- Check (in the SQL editor) — all eight must be false:
select has_function_privilege('anon', 'public.sundial_report_run(text, jsonb)', 'execute') as anon_can_run,
       has_function_privilege('authenticated', 'public.sundial_report_run(text, jsonb)', 'execute') as authenticated_can_run,
       has_function_privilege('anon', 'public.sundial_report_column(jsonb, text, text, text[], boolean)', 'execute') as anon_can_check,
       has_function_privilege('authenticated', 'public.sundial_report_column(jsonb, text, text, text[], boolean)', 'execute') as authenticated_can_check,
       has_function_privilege('anon', 'public.sundial_report_join_where(text, jsonb, text[])', 'execute') as anon_can_where,
       has_function_privilege('authenticated', 'public.sundial_report_join_where(text, jsonb, text[])', 'execute') as authenticated_can_where,
       has_function_privilege('anon', 'public.sundial_report_ref(jsonb, text, text)', 'execute') as anon_can_ref,
       has_function_privilege('authenticated', 'public.sundial_report_ref(jsonb, text, text)', 'execute') as authenticated_can_ref;
