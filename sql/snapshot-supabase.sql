-- =============================================================================
-- snapshot-supabase.sql — read-only introspection of the live Supabase schema
-- =============================================================================
--
-- WHY THIS FILE EXISTS
--
-- The live policies, grants and table definitions for the browser-direct tables
-- (`profiles`, `comments`, `comment_mentions`) are NOT in this repo — they were
-- applied by hand in the Supabase dashboard (D-056). The access-model work
-- (docs/access-model.md §5) rewrites those policies. A change you cannot diff is a
-- change you cannot review, so Phase 0 captures the current state FIRST and commits
-- it as sql/live-snapshot-<date>.sql.
--
-- This file is the QUERY SET. It is committed and re-runnable so every later phase
-- re-snapshots the same way and the two outputs diff cleanly. Do not edit a query
-- to chase a one-off question — add a new numbered block instead, or the next
-- snapshot stops being comparable to this one.
--
-- STRICTLY READ-ONLY. Every statement is a SELECT. Nothing here creates, alters or
-- drops anything, which is what makes it safe to run against production and what
-- lets it run through a read_only=true connection.
--
-- HOW TO RUN
--
--   Preferred — the project's Supabase MCP server (.mcp.json, read_only=true):
--     run each numbered block through execute_sql and paste the results into
--     sql/live-snapshot-<date>.sql under the matching heading.
--
--   Fallback — the Supabase dashboard SQL editor (how D-056 was applied):
--     paste a block, run, export the result.
--
-- Blocks are numbered and independent; they can be run in any order and none
-- depends on another. Postgres has no `pg_get_tabledef()`, so block 2 reconstructs
-- the column list from the catalog rather than dumping DDL text — the
-- reconstruction is the diffable artifact.
--
-- SCOPE — the tables this file cares about:
--   public.profiles, public.comments, public.comment_mentions,
--   every public.sundial_*_cache, and everything in the `private` schema
--   (which today is just app_config, D-056).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. THE TARGET SET — which tables exist, is RLS on, how many policies
-- -----------------------------------------------------------------------------
-- Run this first. It is the inventory every other block is scoped to, and it
-- answers the Phase 6 precondition on its own: a table with rls_enabled = true and
-- policy_count = 0 is DENIED to every non-service role, which is the target state
-- for the cache tables (access-model.md §3.3).
select
  n.nspname                                as schema_name,
  c.relname                                as table_name,
  c.relrowsecurity                         as rls_enabled,
  c.relforcerowsecurity                    as rls_forced,
  (select count(*) from pg_policy p where p.polrelid = c.oid) as policy_count,
  pg_catalog.obj_description(c.oid, 'pg_class') as table_comment
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r'
  and (
    (n.nspname = 'public' and c.relname in ('profiles', 'comments', 'comment_mentions'))
    or (n.nspname = 'public' and c.relname like 'sundial%cache')
    or (n.nspname = 'private')
  )
order by n.nspname, c.relname;


-- -----------------------------------------------------------------------------
-- 2. COLUMNS — the reconstructed table definition
-- -----------------------------------------------------------------------------
-- Ordinal position is included deliberately: a column ADDED by a later phase
-- (sales_rep_sf_id, dealer_sf_id on the cache tables; access_scope, access_level,
-- dealer_sf_id on profiles) appears at the end, and the diff should show exactly
-- that rather than reordering everything.
select
  n.nspname                                       as schema_name,
  c.relname                                       as table_name,
  a.attnum                                        as ordinal,
  a.attname                                       as column_name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
  a.attnotnull                                    as not_null,
  pg_get_expr(d.adbin, d.adrelid)                 as column_default,
  pg_catalog.col_description(c.oid, a.attnum)     as column_comment
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
where a.attnum > 0
  and not a.attisdropped
  and c.relkind = 'r'
  and (
    (n.nspname = 'public' and c.relname in ('profiles', 'comments', 'comment_mentions'))
    or (n.nspname = 'public' and c.relname like 'sundial%cache')
    or (n.nspname = 'private')
  )
order by n.nspname, c.relname, a.attnum;


-- -----------------------------------------------------------------------------
-- 3. CONSTRAINTS — PK / FK / UNIQUE / CHECK
-- -----------------------------------------------------------------------------
select
  n.nspname                     as schema_name,
  c.relname                     as table_name,
  con.conname                   as constraint_name,
  case con.contype
    when 'p' then 'PRIMARY KEY' when 'f' then 'FOREIGN KEY'
    when 'u' then 'UNIQUE'      when 'c' then 'CHECK'
    when 'x' then 'EXCLUDE'     else con.contype::text
  end                           as constraint_type,
  pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where (
    (n.nspname = 'public' and c.relname in ('profiles', 'comments', 'comment_mentions'))
    or (n.nspname = 'public' and c.relname like 'sundial%cache')
    or (n.nspname = 'private')
  )
order by n.nspname, c.relname, con.contype, con.conname;


-- -----------------------------------------------------------------------------
-- 4. INDEXES
-- -----------------------------------------------------------------------------
-- The access model adds (client_sf_id, sales_rep_sf_id) and (client_sf_id,
-- dealer_sf_id) indexes per cache table (§3.3). This block is the before-picture
-- that proves they were not already there.
select
  schemaname as schema_name,
  tablename  as table_name,
  indexname  as index_name,
  indexdef   as definition
from pg_indexes
where (
    (schemaname = 'public' and tablename in ('profiles', 'comments', 'comment_mentions'))
    or (schemaname = 'public' and tablename like 'sundial%cache')
    or (schemaname = 'private')
  )
order by schemaname, tablename, indexname;


-- -----------------------------------------------------------------------------
-- 5. RLS POLICIES — the whole point of the snapshot
-- -----------------------------------------------------------------------------
-- `qual` is the USING clause, `with_check` the WITH CHECK clause. Both are shown
-- in full: the Phase 6 review is a text diff of these expressions, so truncating
-- them would defeat the file.
select
  schemaname as schema_name,
  tablename  as table_name,
  policyname as policy_name,
  permissive,
  roles,
  cmd        as command,
  qual       as using_expr,
  with_check as with_check_expr
from pg_policies
where (
    (schemaname = 'public' and tablename in ('profiles', 'comments', 'comment_mentions'))
    or (schemaname = 'public' and tablename like 'sundial%cache')
    or (schemaname = 'private')
  )
order by schemaname, tablename, policyname;


-- -----------------------------------------------------------------------------
-- 6. TABLE GRANTS to anon / authenticated (service_role shown for contrast)
-- -----------------------------------------------------------------------------
-- RLS is only half the story. A table with RLS enabled and no policies is denied
-- to anon/authenticated; a table with RLS DISABLED but a SELECT grant is wide open
-- to any browser session holding the publishable key. §3.3 requires BOTH the RLS
-- deny and the REVOKE, so both halves are snapshotted.
select
  table_schema   as schema_name,
  table_name,
  grantee,
  privilege_type as privilege,
  is_grantable
from information_schema.role_table_grants
where grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
  and (
    (table_schema = 'public' and table_name in ('profiles', 'comments', 'comment_mentions'))
    or (table_schema = 'public' and table_name like 'sundial%cache')
    or (table_schema = 'private')
  )
order by table_schema, table_name, grantee, privilege_type;


-- -----------------------------------------------------------------------------
-- 6b. SCHEMA-level USAGE grants
-- -----------------------------------------------------------------------------
-- A revoked table grant does not help if USAGE on the schema was granted anyway —
-- and USAGE on `private` for anon/authenticated would be a finding in itself.
select
  n.nspname as schema_name,
  r.rolname as grantee,
  has_schema_privilege(r.rolname, n.nspname, 'USAGE')  as has_usage,
  has_schema_privilege(r.rolname, n.nspname, 'CREATE') as has_create
from pg_namespace n
cross join (select unnest(array['anon', 'authenticated', 'service_role']) as rolname) r
where n.nspname in ('public', 'private')
order by n.nspname, r.rolname;


-- -----------------------------------------------------------------------------
-- 7. FUNCTIONS in public / private, with the SECURITY DEFINER flag
-- -----------------------------------------------------------------------------
-- §5.2 adds four security-definer helpers (current_profile, record_visible,
-- record_visible_for, user_visible). A security-definer function runs with its
-- OWNER's rights and bypasses RLS, so the set of them is a security-relevant
-- inventory in its own right — this block is what makes an unexpected one visible.
-- `proconfig` carries the search_path setting: a definer function WITHOUT a pinned
-- search_path is a known privilege-escalation shape, which is why §5.2 specifies
-- `set search_path = public` on all four.
select
  n.nspname                                 as schema_name,
  p.proname                                 as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid)             as returns,
  p.prosecdef                               as security_definer,
  case p.provolatile
    when 'i' then 'immutable' when 's' then 'stable' else 'volatile'
  end                                       as volatility,
  pg_get_userbyid(p.proowner)               as owner,
  p.proconfig                               as config,
  has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'private')
order by n.nspname, p.proname;


-- -----------------------------------------------------------------------------
-- 8. WHICH SCHEMAS POSTGREST EXPOSES
-- -----------------------------------------------------------------------------
-- Supabase sets this per-role on `authenticator` (ALTER ROLE ... SET pgrst.*).
-- This is the authoritative answer to "can a browser session reach these tables at
-- all" — if a schema is not in db_schemas, nothing in it is routable over PostgREST
-- regardless of grants. An empty result means it was never set at the role level;
-- fall back to the dashboard's API settings and to the empirical probe in
-- scripts/probe-cache-reachability.mjs.
select
  coalesce(r.rolname, '<database-wide>') as role_name,
  d.datname                              as database_name,
  s.setconfig                            as settings
from pg_db_role_setting s
left join pg_roles r    on r.oid = s.setrole
left join pg_database d on d.oid = s.setdatabase
where array_to_string(s.setconfig, ',') like '%pgrst%'
order by 1, 2;


-- -----------------------------------------------------------------------------
-- 8b. The same settings as the CURRENT session sees them
-- -----------------------------------------------------------------------------
-- Second opinion on block 8. The `true` argument makes these return null rather
-- than erroring when the setting is not present.
select
  current_setting('pgrst.db_schemas',           true) as db_schemas,
  current_setting('pgrst.db_anon_role',         true) as db_anon_role,
  current_setting('pgrst.db_extra_search_path', true) as db_extra_search_path;


-- -----------------------------------------------------------------------------
-- 9. TRIGGERS on the target tables
-- -----------------------------------------------------------------------------
-- D-056 put the @-mention notify on a database trigger, so the trigger set is part
-- of the behaviour this snapshot exists to preserve across the policy rewrite.
select
  n.nspname                as schema_name,
  c.relname                as table_name,
  t.tgname                 as trigger_name,
  pg_get_triggerdef(t.oid) as definition,
  t.tgenabled              as enabled_flag
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where not t.tgisinternal
  and (
    (n.nspname = 'public' and c.relname in ('profiles', 'comments', 'comment_mentions'))
    or (n.nspname = 'public' and c.relname like 'sundial%cache')
    or (n.nspname = 'private')
  )
order by n.nspname, c.relname, t.tgname;


-- -----------------------------------------------------------------------------
-- 10. ROW COUNTS (planner estimate — deliberately not count(*))
-- -----------------------------------------------------------------------------
-- Estimates only. An exact count(*) over the 31.9k customer cache proves nothing
-- this file needs, and the file must stay cheap enough to run against production
-- without thinking about it.
select
  n.nspname           as schema_name,
  c.relname           as table_name,
  c.reltuples::bigint as estimated_rows,
  pg_size_pretty(pg_total_relation_size(c.oid)) as total_size
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r'
  and (
    (n.nspname = 'public' and c.relname in ('profiles', 'comments', 'comment_mentions'))
    or (n.nspname = 'public' and c.relname like 'sundial%cache')
    or (n.nspname = 'private')
  )
order by n.nspname, c.relname;
