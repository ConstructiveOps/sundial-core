-- Sundial access model, Phase 1 item 7 (addendum) — revoke WRITE on public.profiles.
-- D-064. Apply AFTER sql/sundial_access_p1_profiles_columns.sql.
--
-- APPLY IN THE SUPABASE SQL EDITOR. Small, and it closes something the previous file
-- got wrong.
--
-- ============================================================================
-- WHAT THE PREVIOUS FILE CALLED A BASELINE IS ACTUALLY THE SAME ACCIDENT AGAIN
-- ============================================================================
--
-- sundial_access_p1_profiles_columns.sql printed
--
--     has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
--
-- and described the result as a pre-existing grant "recorded here so the next snapshot
-- has a baseline". It came back TRUE, and that is not a baseline worth recording -- it
-- is the finding.
--
-- Measured 2026-08-27 via pg_class.relacl:
--
--   public.profiles   anon=arwdDxtm | authenticated=arwdDxtm   1 policy (SELECT only)
--
-- `authenticated` holds INSERT, UPDATE and DELETE on profiles. The ONLY thing stopping a
-- logged-in session from rewriting its own profile row is that no UPDATE **policy**
-- exists -- RLS denies a command with no permissive policy. That is precisely the shape
-- §5.1b documents on the cache tables: a wide-open grant, protected by the absence of a
-- policy rather than by the absence of permission.
--
-- ⚠️ AND IT NOW GUARDS access_scope. Before today, a hypothetical UPDATE policy on
-- profiles would have let a session edit its own display name. As of the previous file
-- it would let a session set its own `access_scope` to 'tenant' -- the column Phase 1b's
-- record_visible() reads to decide what that session may see. The two edits that would
-- do it are both things a reasonable person might ship:
--
--     create policy "users can edit their own profile" on public.profiles
--       for update using (auth.uid() = id);
--
-- ...which reads as obviously correct, and would be, if the row held only a name.
--
-- After this revoke, that policy is inert: RLS grants nothing the underlying privilege
-- does not already allow. The grant is the outer wall and the policy is the inner one,
-- and the outer wall should not be missing on the table that stores authorization state.
--
-- ============================================================================
-- WHY ONLY profiles, AND NOT comments / comment_mentions / user_preferences
-- ============================================================================
--
-- Those three carry the SAME wide grant (anon and authenticated both arwdDxtm), and they
-- are deliberately NOT touched here, because unlike profiles their write grants are
-- actually USED: the browser inserts comments and mentions and upserts preferences
-- directly (D-056, and the file list in §5.1c). They have 3, 2 and 3 real policies
-- respectively doing the constraining. Revoking their writes would break the portal.
--
-- profiles is different in exactly the way that matters: **nothing in any browser writes
-- it.** Its only writer is sundial-auth-proxy's upsert under the SERVICE ROLE, which
-- bypasses both grants and RLS. So this revoke is a no-op for every code path that
-- exists, and a wall against one that does not exist yet.
--
-- SELECT is deliberately KEPT: own_profile_select (USING auth.uid() = id) is a real
-- policy serving a real read, and revoking the privilege under it would break it.

begin;

revoke insert, update, delete, truncate, references, trigger
  on table public.profiles from anon, authenticated;

commit;


-- ============================================================================
-- VERIFICATION — run immediately after.
-- ============================================================================
-- EXPECTED: auth_select TRUE (the read policy still works), every write column FALSE,
-- policy_count still 1, and relacl showing anon/authenticated with `r` only.

select has_table_privilege('authenticated', 'public.profiles', 'SELECT') as auth_select,
       has_table_privilege('authenticated', 'public.profiles', 'INSERT') as auth_insert,
       has_table_privilege('authenticated', 'public.profiles', 'UPDATE') as auth_update,
       has_table_privilege('authenticated', 'public.profiles', 'DELETE') as auth_delete,
       has_table_privilege('anon',          'public.profiles', 'UPDATE') as anon_update,
       (select count(*) from pg_policy where polrelid = 'public.profiles'::regclass) as policy_count,
       array_to_string((select relacl from pg_class where oid = 'public.profiles'::regclass), E'\n') as relacl;

-- A LOGIN MUST STILL WORK after this. sundial-auth-proxy writes profiles under the
-- service role, which is unaffected -- but that is the claim, and the check is to log in
-- as a ZZ TEST user and confirm /auth/me still returns 200 with the profile refreshed:
--   node scripts/verify-access-matrix.mjs --user rep-a1
