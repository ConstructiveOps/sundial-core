-- Sundial access model, Phase 6 — retire current_user_tenant_id() and the policies
-- that depend on it. D-064, docs/access-model.md §8 Phase 6.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR (project qfsdpkwxahakegjnyijj), as Tim.
--
-- ============================================================================
-- ⚠️ THIS FILE IS BIGGER THAN THE PHASE 6 PLAN, AND HERE IS WHY
-- ============================================================================
--
-- The plan said: drop the six inert `*_cache_select_tenant` policies, then
-- current_user_tenant_id(), then portal_users. Measured on the live database
-- (2026-08-28), that is not safe as written, because the function is referenced by TEN
-- policies, not six:
--
--   sundial_customer_cache    customer_cache_select_tenant     <- the six from the plan
--   sundial_solar_cache       solar_cache_select_tenant
--   sundial_roofing_cache     roofing_cache_select_tenant
--   sundial_po_cache          po_cache_select_tenant
--   sundial_po_credit_cache   po_credit_cache_select_tenant
--   sundial_user_cache        user_cache_select_tenant
--   asset_cache               asset_cache_select_tenant        <- NOT in the plan
--   chat_messages             chat_messages_select_tenant      <- NOT in the plan
--   sundial_file_metadata     file_metadata_select_tenant      <- NOT in the plan
--   portal_users              portal_users_select_tenant       <- self-referential
--
-- Dropping the function without CASCADE therefore FAILS. Dropping it WITH CASCADE takes
-- those four extra policies with it — and that is the dangerous outcome, because the
-- last four tables are NOT in the same state as the six:
--
--   the six cache tables      anon/authenticated privileges: NONE (A4 revoked them)
--   asset_cache               anon/authenticated privileges: ALL 16, writes included
--   chat_messages             anon/authenticated privileges: ALL 16
--   sundial_file_metadata     anon/authenticated privileges: ALL 16
--   portal_users              anon/authenticated privileges: ALL 16
--
-- On the six, the policy is decoration: the REVOKE is what protects them, which is why
-- dropping their policies changes nothing. On the other four, THE INERT POLICY IS THE
-- ONLY THING IN THE WAY. Drop it and a browser session with the anon key can read — and
-- write — every row. `sundial_file_metadata` is the file index for every record in the
-- tenant; `chat_messages` is user conversation.
--
-- This is the Phase 0 finding (§5.1b) unchanged, on four tables nobody revisited when A4
-- moved the cache revoke forward. The plan's "this removes a misleading artefact, not a
-- control" is TRUE for the six and FALSE for these four.
--
-- So this file does what A4 did: REVOKE FIRST, THEN DROP. At no point is a table left
-- protected only by a policy that is about to disappear.
--
-- ============================================================================
-- WHY THE POLICIES ARE INERT IN THE FIRST PLACE
-- ============================================================================
-- Every one of them filters `tenant_id = current_user_tenant_id()`, and that function
-- reads `public.portal_users` — a table holding ZERO rows. The predicate is false for
-- everybody, so the policies deny by ACCIDENT. Two obvious tidy-ups would each turn six
-- (now ten) deny-everything policies into allow-everything policies:
--
--   1. populating or dropping `portal_users`, which looks like an abandoned table;
--   2. "fixing" current_user_tenant_id() to read `profiles`, which is what its
--      near-namesake current_user_tenant() does and looks like a copy-paste bug.
--
-- After this file runs, neither edit is possible: the function and the table are gone,
-- and the grants they were accidentally standing in for are revoked.
--
-- ⚠️ NOTHING HERE TOUCHES THE PHASE 1b COMMENT LAYER. current_user_tenant() (no `_id`),
-- current_profile(), record_visible(), record_visible_for() and user_visible() are a
-- DIFFERENT, LIVE set — they are what stops one rep reading another's comments.
-- Verification 5 proves they survived.

begin;

-- ============================================================================
-- STEP 1 — REVOKE, on the four tables that are still exposed.
-- ============================================================================
-- Exactly the A4 treatment (sql/sundial_access_p1_cache_hardening.sql).
--
-- VERIFIED, not assumed (2026-08-28, the same file-by-file check §5.1c ran for the cache
-- tables). Every direct Supabase table read in the harmon-crm client:
--
--     4 x .from('comments')
--     3 x .from('comment_mentions')
--
-- and nothing else. asset_cache, chat_messages, sundial_file_metadata and portal_users
-- appear ZERO times anywhere in src/. File metadata is served by the file Lambdas,
-- asset_cache by the cache read path, and chat_messages by a feature that is not built
-- (CLAUDE.md, Phase 2). Comments are the one browser-direct table (D-056) and are NOT
-- touched here.
--
-- So this revoke is a no-op for the portal today and a wall tomorrow — the same trade
-- A4 took. Re-run that grep before adding a browser-direct read of any of them.
--
-- This is the load-bearing step. If it fails, the transaction rolls back and the drops
-- below never run — which is the correct outcome, because the drops are only safe once
-- this has succeeded.
revoke all on public.asset_cache            from anon, authenticated;
revoke all on public.chat_messages          from anon, authenticated;
revoke all on public.sundial_file_metadata  from anon, authenticated;
revoke all on public.portal_users           from anon, authenticated;

-- ============================================================================
-- STEP 2 — the ten policies that depend on current_user_tenant_id().
-- ============================================================================
-- Now inert AND redundant: RLS stays enabled on every one of these tables, and a table
-- with RLS enabled and no policy denies every non-superuser read outright. Belt (the
-- revoke) and braces (RLS deny-by-default), with the misleading middle layer removed.
drop policy if exists customer_cache_select_tenant  on public.sundial_customer_cache;
drop policy if exists solar_cache_select_tenant     on public.sundial_solar_cache;
drop policy if exists roofing_cache_select_tenant   on public.sundial_roofing_cache;
drop policy if exists po_cache_select_tenant        on public.sundial_po_cache;
drop policy if exists po_credit_cache_select_tenant on public.sundial_po_credit_cache;
drop policy if exists user_cache_select_tenant      on public.sundial_user_cache;
drop policy if exists asset_cache_select_tenant     on public.asset_cache;
drop policy if exists chat_messages_select_tenant   on public.chat_messages;
drop policy if exists file_metadata_select_tenant   on public.sundial_file_metadata;
drop policy if exists portal_users_select_tenant    on public.portal_users;

-- chat_messages carries a second policy that does NOT use the function. It is dropped
-- too: an INSERT policy on a table nothing may insert into is the same misleading
-- artefact as the rest of this file, and the chat feature is unbuilt (CLAUDE.md Phase 2).
drop policy if exists chat_messages_insert_own on public.chat_messages;

-- ============================================================================
-- STEP 3 — the function, then the table it read.
-- ============================================================================
-- NOT CASCADE, on either. Every known dependent was dropped in step 2, so a failure
-- here means something ELSE references them — which is a finding to investigate, not
-- something to bulldoze.
drop function if exists public.current_user_tenant_id();
drop table if exists public.portal_users;

commit;


-- ============================================================================
-- VERIFICATION — run AFTER the block above. Five checks; all five must hold.
-- ============================================================================

-- 1. Every affected table: zero policies, RLS still ENABLED.
--    RLS on + no policies = deny every non-superuser read. That is the intent.
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('sundial_customer_cache','sundial_solar_cache','sundial_roofing_cache',
                    'sundial_po_cache','sundial_po_credit_cache','sundial_user_cache',
                    'asset_cache','chat_messages','sundial_file_metadata')
order by c.relname;
-- EXPECT: 9 rows, rls_enabled = true, policies = 0.

-- 2. No anon/authenticated privileges remain on any of them. ZERO ROWS is the pass.
--    Reads relacl directly: information_schema.role_table_grants is member-filtered and
--    returned zero rows regardless of the real grants for the MCP user — the defect
--    Phase 0 found in block 6 of sql/snapshot-supabase.sql. A check that passes either
--    way is not a check.
select c.relname as table_name,
       pg_get_userbyid(acl.grantee) as grantee,
       acl.privilege_type
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
where n.nspname = 'public'
  and c.relname in ('sundial_customer_cache','sundial_solar_cache','sundial_roofing_cache',
                    'sundial_po_cache','sundial_po_credit_cache','sundial_user_cache',
                    'asset_cache','chat_messages','sundial_file_metadata')
  and pg_get_userbyid(acl.grantee) in ('anon','authenticated')
order by c.relname, grantee, acl.privilege_type;

-- 3. The function and the table are gone. ZERO ROWS is the pass.
select 'function' as kind, p.proname as name
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'current_user_tenant_id'
union all
select 'table', c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'portal_users';

-- 4. NOTHING anywhere still references current_user_tenant_id(). ZERO ROWS is the pass.
--    Catches a policy on a table this file did not think about.
select c.relname as on_table, p.polname
from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') like '%current_user_tenant_id%'
    or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%current_user_tenant_id%');

-- 5. THE PHASE 1b COMMENT LAYER IS UNTOUCHED — the check that matters most, because
--    everything above removes something and this proves the removal stopped where it
--    was meant to. EXPECT 3 comments policies, 2 comment_mentions policies, and all
--    five definer helpers.
select 'policy' as kind, c.relname as on_object, p.polname as name
from pg_policy p
join pg_class c on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('comments','comment_mentions')
union all
select 'function', '-', p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('current_profile','current_user_tenant','record_visible',
                    'record_visible_for','user_visible')
order by kind, on_object, name;
