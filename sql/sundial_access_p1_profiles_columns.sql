-- Sundial access model, Phase 1 item 7 — server-owned scope columns on public.profiles.
-- D-064, docs/access-model.md §5.2. Apply BEFORE deploying sundial-auth-proxy.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR (project qfsdpkwxahakegjnyijj), as Tim.
--
-- ============================================================================
-- COLUMNS ONLY. NO POLICY CHANGE. NO NEW GRANT.
-- ============================================================================
--
-- Three columns, written by exactly one thing: sundial-auth-proxy's existing
-- service-role upsert, on every successful GET /auth/me. Nothing else writes them and
-- nothing in the browser can.
--
-- ⚠️ NO `update` POLICY IS ADDED ON profiles, AND THAT IS THE WHOLE POINT.
-- RLS is ROW-level. A policy permissive enough to let a session update its own profile
-- row would let that session rewrite its own `access_scope` -- from 'own' to 'tenant' --
-- and the RLS helpers in Phase 1b read exactly that column to decide what the session
-- may see. The one grant that looks harmless ("let people edit their own profile") is
-- the one that hands out the whole tenant. This is D-056's argument, restated because
-- these three columns are what make it load-bearing rather than theoretical.
--
-- The existing policy set is untouched: `own_profile_select` (USING auth.uid() = id)
-- stays exactly as the Phase 0 snapshot found it, and there is still no insert, update
-- or delete policy for any client role.
--
-- ============================================================================
-- WHY THESE COLUMNS EXIST AT ALL
-- ============================================================================
--
-- Comments and mentions are browser-direct (D-056), so their RLS runs in Postgres and
-- cannot call a Lambda to ask "what may this user see". The scope has to be MATERIALIZED
-- somewhere Postgres can read, and `profiles` is the row Supabase RLS already keys on
-- via auth.uid(). Phase 1b's `record_visible()` reads these three columns.
--
--   access_scope  tenant | dealer | own | none  -- the resolved scope (lib/access.js)
--   access_level  the RAW Access_Level__c string
--   dealer_sf_id  Sundial_Dealer__c id, or null
--
-- ⚠️ BOTH access_scope AND access_level ARE STORED, and that is not redundancy.
-- `access_scope` is the derived answer RLS acts on. `access_level` is what Salesforce
-- actually said, kept so the shadow report can tell "Technician" (a real level that
-- resolves to none) apart from "nobody ever set a level" (also none) -- two situations
-- that need different conversations with Harmon and are indistinguishable from the scope
-- alone. Storing only the level would put the scope derivation in SQL as well as in
-- lib/access.js, and the two would drift.
--
-- ⚠️ A NULL access_scope MEANS "auth-proxy has not run since this column existed",
-- NOT "tenant". Phase 1b's helpers must treat NULL as deny. Every profile row is
-- refreshed on its user's next /auth/me, so the nulls drain as people log in -- but a
-- helper written to read NULL as "no restriction" would hand the tenant to anyone who
-- had not logged in recently, which is the inverse of what a stale row should do.

begin;

alter table public.profiles
  add column if not exists access_scope text,
  add column if not exists access_level text,
  add column if not exists dealer_sf_id text;

comment on column public.profiles.access_scope is
  'D-064: resolved row-visibility scope (tenant|dealer|own|none). SERVER-OWNED - written only by sundial-auth-proxy under the service role. NULL means auth-proxy has not run for this user since the column was added; RLS helpers must treat NULL as DENY, never as unrestricted.';
comment on column public.profiles.access_level is
  'D-064: raw Sundial_User__c.Access_Level__c. Kept alongside access_scope so a real level that resolves to `none` (Technician) can be told apart from a user who has no level at all. SERVER-OWNED.';
comment on column public.profiles.dealer_sf_id is
  'D-064: Sundial_Dealer__c id for dealer-scope filtering, or NULL. SERVER-OWNED.';

commit;


-- ============================================================================
-- VERIFICATION 1 — the columns exist and NOTHING ELSE MOVED. Run immediately.
-- ============================================================================
-- EXPECTED: three rows below, and the policy/grant queries UNCHANGED from the Phase 0
-- snapshot -- one SELECT policy named own_profile_select, and no write privilege for
-- anon or authenticated beyond whatever they already held.

select ordinal_position, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'
order by ordinal_position;
-- Expect the original 7 columns at 1-7 and the new three at 8, 9, 10, exactly as
-- sql/live-snapshot-2026-08-27.sql section 2 predicted ("the Phase 5 ALTER adds them at
-- ordinals 8, 9, 10 and the next snapshot's diff should show exactly that and nothing
-- else"). Anything at another position means something else altered this table.

select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr,
       pg_get_expr(polwithcheck, polrelid) as with_check
from pg_policy where polrelid = 'public.profiles'::regclass
order by polname;
-- Expect EXACTLY ONE row: own_profile_select, SELECT, USING (auth.uid() = id),
-- WITH CHECK null. A second row -- especially one with polcmd 'u' (UPDATE) -- means a
-- write policy appeared, and a session that can update its own profile can rewrite its
-- own access_scope. That is the failure this file's header is about.

select has_table_privilege('authenticated', 'public.profiles', 'UPDATE') as auth_update,
       has_table_privilege('authenticated', 'public.profiles', 'INSERT') as auth_insert,
       has_table_privilege('anon',          'public.profiles', 'UPDATE') as anon_update;
-- These reflect the pre-existing grants, which this file does not change. Recorded here
-- so the next snapshot has a baseline: if any of them flips later, it happened elsewhere.


-- ============================================================================
-- VERIFICATION 2 — the columns are POPULATED. Run AFTER auth-proxy is deployed
-- and at least one user has hit /auth/me.
-- ============================================================================

select access_scope,
       count(*)                          as profiles,
       count(dealer_sf_id)               as with_dealer,
       min(updated_at)                   as oldest_refresh
from public.profiles
group by access_scope
order by access_scope nulls last;

-- Reading it:
--   'tenant' rows      Harmon staff. dealer_sf_id is expected to be NULL on these --
--                      tenant scope never reads it, so a null is correct, not missing.
--   'own' / 'dealer'   sales roles. dealer_sf_id MUST be non-null on every one of
--                      these: a sales scope with a null dealer should have resolved to
--                      'none', so this combination means resolveScope() was bypassed.
--   'none'             Technician, no level, or a null/inactive dealer. Expected to be
--                      small; cross-check against scripts/access-shadow-report.mjs.
--   NULL               auth-proxy has not run for this user since deploy. Drains as
--                      people log in. NEVER read as "unrestricted".
