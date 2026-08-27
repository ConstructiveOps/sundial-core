-- Sundial access model, Phase 1 item 1 — REVOKE the cache tables from the browser roles.
-- D-064 amendment A4 (2026-08-27). docs/access-model.md §3.3, §5.1b.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR (project qfsdpkwxahakegjnyijj), as Tim, the way
-- D-056's SQL was applied. It is not run by any script or Lambda.
--
-- ============================================================================
-- WHY THIS EXISTS, AND WHY IT IS THE FIRST THING PHASE 1 DOES
-- ============================================================================
--
-- `anon` and `authenticated` hold `arwdDxtm` on all six `sundial_*_cache` tables --
-- the FULL privilege set, INSERT/UPDATE/DELETE included. Nothing has ever been
-- revoked; this is the Supabase default for tables created through the dashboard.
-- Measured 2026-08-26/27 via pg_class.relacl and recorded in
-- sql/live-snapshot-2026-08-27.sql section A.1.
--
-- The only thing standing between a logged-in browser session and 31,640 customer
-- rows is one RLS policy per table:
--
--     USING (tenant_id = current_user_tenant_id())
--
-- and that policy DENIES BY ACCIDENT. `current_user_tenant_id()` reads
-- `public.portal_users`, which holds ZERO ROWS, so it returns NULL for every session,
-- `tenant_id = NULL` is NULL, and nothing matches. Three independent accidents are
-- stacked here, all failing closed, none of them designed:
--
--   1. `public.portal_users` was never populated.
--   2. The grants were never narrowed.
--   3. `profiles.tenant_id` holds the Salesforce record id (a1W7y000007AszBEAS) while
--      the cache tables' `tenant_id` holds the slug (`harmon`) -- so even repointing
--      the helper at `profiles` would compare an id to a slug and still deny, for a
--      reason nobody wrote down.
--
-- ⚠️ `public.portal_users` AND `current_user_tenant_id()` ARE LOAD-BEARING ACCIDENTS.
--    Populating that table, or repointing that helper at `profiles`, would expose the
--    ENTIRE CACHE -- 31,640 customer rows and 4,481 solar rows -- to any authenticated
--    session in the tenant, with no per-rep scoping whatsoever. NEITHER MAY BE "FIXED"
--    BEFORE THIS FILE IS APPLIED.
--
--    That warning is in this register because both edits read as obvious housekeeping.
--    `portal_users` is an empty table that looks abandoned. `current_user_tenant_id()`
--    reads it while its near-namesake `current_user_tenant()` reads `profiles`, which
--    looks exactly like a copy-paste bug somebody should tidy up. Either one-line
--    change would pass review from anyone who had not read this paragraph, and would
--    turn six deny-everything policies into allow-everything policies in one instant.
--
--    AFTER this revoke, both edits are harmless: the grant is gone, so the policy
--    expression no longer decides anything. Apply this first. Then tidy, if it still
--    seems worth doing.
--
-- ============================================================================
-- WHY IT COSTS NOTHING
-- ============================================================================
--
-- Nothing reads a cache table from a browser. Verified file-by-file across both repos
-- on 2026-08-27 (docs/access-model.md §5.1c, full list in PROGRESS.md): the single
-- browser Supabase client (harmon-crm/src/lib/supabase.ts, anon key) issues `.from()`
-- against exactly three tables -- `comments`, `comment_mentions`, `user_preferences`
-- -- and none of them is here. Every backend reader sends the service-role key
-- (lib/supabase.js reads `sundial/supabase/service-role`; the four raw-PostgREST call
-- sites all pass `apikey: cfg.serviceRoleKey`). No anon or publishable key appears
-- anywhere in lambdas/ or lib/.
--
-- The service role BYPASSES RLS and its grants are not touched below, so the Lambdas
-- (sundial-sf-query, sundial-cache-sync, sundial-sf-update, comment-notify,
-- welcome-call writeback) are unaffected. `postgres` and the Supabase internal roles
-- are likewise untouched.
--
-- ============================================================================
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ============================================================================
--
-- NO POLICY IS ADDED, CHANGED OR DROPPED. The six accidental `*_cache_select_tenant`
-- policies are left exactly as the Phase 0 snapshot found them, and RLS stays ENABLED
-- on every table.
--
-- That is a deliberate scope line, not an oversight. Dropping the policies is Phase 6
-- work, and keeping it separate means Phase 6's diff shows the policy drop ALONE --
-- reviewable as one thing, against a snapshot whose only other change is this revoke.
-- Bundling them would produce a single diff in which "we removed the thing that was
-- protecting us" and "we removed the thing that only appeared to be protecting us"
-- look identical.
--
-- Order also matters for safety: revoke first, drop second. Revoking while the policy
-- still stands is belt AND braces. Dropping the policy while the grant still stands
-- would be neither.
--
-- `private.app_config` is already in the target shape (RLS on, zero policies, no
-- grants to anon/authenticated) and is not touched.

begin;

-- The six live cache tables, as enumerated by sql/live-snapshot-2026-08-27.sql
-- section 1. `sundial_commercial_cache`, `sundial_service_cache` and
-- `sundial_service_visit_cache` are named in docs/caching-architecture.md but DO NOT
-- EXIST yet (Phase 2/3 objects) -- REVOKE on a missing table is a hard error, so they
-- are not listed. Add them to this file when their tables are created, or the new
-- table ships with the same wide-open default this file exists to close.

revoke all privileges on table public.sundial_customer_cache  from anon, authenticated;
revoke all privileges on table public.sundial_solar_cache     from anon, authenticated;
revoke all privileges on table public.sundial_roofing_cache   from anon, authenticated;
revoke all privileges on table public.sundial_user_cache      from anon, authenticated;
revoke all privileges on table public.sundial_po_cache        from anon, authenticated;
revoke all privileges on table public.sundial_po_credit_cache from anon, authenticated;

-- Stop the DEFAULT PRIVILEGES from re-granting on the next table. Without this, a
-- future `create table sundial_commercial_cache` in the dashboard arrives with
-- `arwdDxtm` for anon and authenticated all over again, and this file's protection
-- covers only the tables that happened to exist on the day it ran.
--
-- `postgres` owns these tables (relacl reads `postgres=arwdDxtm/postgres` on every
-- one), so it is the grantor whose defaults matter.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

commit;


-- ============================================================================
-- VERIFICATION -- run this AFTER the block above, in the same editor.
-- ============================================================================
--
-- EXPECTED: six rows, every privilege column FALSE, `rls_enabled` true, `policy_count`
-- 1, and `relacl` showing no `anon=` or `authenticated=` entry.
--
-- ⚠️ DO NOT verify this with information_schema.role_table_grants. That view is
-- MEMBER-FILTERED -- it only shows grants involving a role the querying user belongs
-- to -- so it returns zero rows whether or not anything is granted. That is exactly
-- how block 6 of sql/snapshot-supabase.sql produced a clean-looking empty result over
-- a set of wide-open tables (PROGRESS.md 2026-08-27). has_table_privilege() and
-- pg_class.relacl are not member-filtered, which is why they are used here.

select
  c.relname                                                   as table_name,
  has_table_privilege('anon',          c.oid, 'SELECT')       as anon_select,
  has_table_privilege('anon',          c.oid, 'INSERT')       as anon_insert,
  has_table_privilege('authenticated', c.oid, 'SELECT')       as auth_select,
  has_table_privilege('authenticated', c.oid, 'INSERT')       as auth_insert,
  has_table_privilege('authenticated', c.oid, 'UPDATE')       as auth_update,
  has_table_privilege('authenticated', c.oid, 'DELETE')       as auth_delete,
  c.relrowsecurity                                            as rls_enabled,
  (select count(*) from pg_policy p where p.polrelid = c.oid) as policy_count,
  array_to_string(c.relacl, E'\n')                            as relacl
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname like 'sundial\_%\_cache'
order by c.relname;

-- Two things to check in that output, not one:
--
--   * every anon_* / auth_* column is FALSE            -> the revoke landed
--   * rls_enabled is TRUE and policy_count is 1 on each -> nothing else moved
--
-- A policy_count of 0 means the policies were dropped as well, which this file does
-- not do. That is Phase 6's change arriving early, and it should be explained before
-- it is accepted rather than read as success.
