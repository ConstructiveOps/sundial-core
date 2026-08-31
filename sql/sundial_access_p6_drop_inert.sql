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
-- ⚠️ AND `portal_users` IS NOT DROPPED. IT IS NOT AN ABANDONED TABLE.
-- ============================================================================
--
-- The first run of this file failed here, and the error is the finding:
--
--   ERROR: cannot drop table portal_users because other objects depend on it
--   DETAIL: constraint chat_messages_author_user_id_fkey ...
--           constraint notifications_recipient_user_id_fkey ...
--           constraint audit_log_actor_user_id_fkey ...
--           constraint sundial_file_metadata_uploaded_by_user_id_fkey ...
--           constraint sundial_file_metadata_deleted_by_user_id_fkey ...
--
-- SIX foreign keys point at it (corrected 2026-08-30 by catalog query; the five listed
-- above are the cross-table ones, and `portal_users_parent_user_id_fkey` — its own
-- self-lookup — was missed). It holds zero ROWS, but it is a
-- referenced parent in the schema — which is a different thing from abandoned, and the
-- whole transaction rolled back rather than half-applying. That is the `begin`/`commit`
-- doing its job.
--
-- DROPPING IT IS NOT NECESSARY TO REMOVE THE TRAP, and that is the deciding argument.
-- The hazard was never the empty table by itself; it was that the table plus the
-- function made ten policies LOOK like tenant isolation while denying by accident, so
-- that "populate portal_users" or "fix current_user_tenant_id() to read profiles" would
-- silently open 31,600+ customer rows. After steps 1-3 below, the policies are gone and
-- the function does not exist. Populating portal_users then does nothing at all.
--
-- What dropping it WOULD cost: five FK constraints removed from four tables, one of
-- which (`sundial_file_metadata`) is live with 35 rows. That is a schema change with its
-- own review, not an 11pm CASCADE — which is exactly what step 3's own comment says
-- about bulldozing dependencies nobody looked at.
--
-- MEASURED WHILE DECIDING (2026-08-28), because "it is empty so nothing uses it" is the
-- kind of claim that deserves a query:
--
--   portal_users                                    0 rows
--   chat_messages / notifications / audit_log       0 rows  (features not built)
--   sundial_file_metadata                          35 rows
--     uploaded_by_user_id  (uuid, FK -> portal_users)   0 non-null
--     uploaded_by_user_name (text)                     35 non-null
--
-- So file uploads ARE attributed — via the text column, which is what the Lambdas
-- write. The uuid column is vestigial and CANNOT be populated while its parent is
-- empty: any non-null value would violate the constraint. Not a live bug (nothing reads
-- it), but it means `uploaded_by_user_id` is dead weight, and the tidy-up below should
-- decide its fate together with the table's.
--
-- An OPTIONAL follow-up block at the end of this file drops the table properly, with the
-- five constraints named. It is commented out and is Tim's call, another day.
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
-- STEP 3 — the function. (The table stays; see the header.)
-- ============================================================================
-- NOT CASCADE. Every policy that referenced it was dropped in step 2, so a failure here
-- means something ELSE references it — a finding to investigate, not something to
-- bulldoze.
--
-- This is the step that actually disarms the trap: with the function gone, no future
-- edit to `portal_users` can turn a policy back on, because there are no policies and
-- nothing to read it.
drop function if exists public.current_user_tenant_id();

-- portal_users is deliberately LEFT IN PLACE. It is now: empty, un-granted (step 1),
-- policy-free (step 2), and referenced only by five FK constraints. Inert.

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

-- 3. The FUNCTION is gone. ZERO ROWS is the pass.
--    (portal_users is expected to REMAIN — see the header. Its own state is checked by
--    query 3b.)
select p.proname as name
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'current_user_tenant_id';

-- 3b. portal_users is inert: RLS on, zero policies, zero anon/authenticated privileges.
--     EXPECT one row: rls_enabled = true, policies = 0, anon_auth_privs = 0.
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
       (select count(*) from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
         where pg_get_userbyid(acl.grantee) in ('anon','authenticated')) as anon_auth_privs
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


-- ============================================================================
-- OPTIONAL FOLLOW-UP — dropping portal_users properly. NOT PART OF PHASE 6.
-- ============================================================================
-- Commented out deliberately. Nothing above depends on this, and after the block above
-- the table is inert. Run it only as a considered schema tidy-up, and decide the fate of
-- the two dead `sundial_file_metadata` columns in the same pass rather than leaving a
-- uuid column whose parent no longer exists.
--
-- ⚠️ Before running it, confirm the FK columns are still all-null. If a future Lambda
-- has started writing `uploaded_by_user_id`, dropping the constraint silently removes
-- the guarantee that the value points at a real user:
--
--   select count(uploaded_by_user_id) + count(deleted_by_user_id) from public.sundial_file_metadata;
--   -- must be 0
--
-- begin;
--   alter table public.chat_messages          drop constraint chat_messages_author_user_id_fkey;
--   alter table public.notifications          drop constraint notifications_recipient_user_id_fkey;
--   alter table public.audit_log              drop constraint audit_log_actor_user_id_fkey;
--   alter table public.sundial_file_metadata  drop constraint sundial_file_metadata_uploaded_by_user_id_fkey;
--   alter table public.sundial_file_metadata  drop constraint sundial_file_metadata_deleted_by_user_id_fkey;
--
--   -- The two dead columns. `uploaded_by_user_name` is the one the Lambdas actually
--   -- write and MUST be kept.
--   -- alter table public.sundial_file_metadata drop column uploaded_by_user_id;
--   -- alter table public.sundial_file_metadata drop column deleted_by_user_id;
--
--   drop table public.portal_users;
-- commit;
