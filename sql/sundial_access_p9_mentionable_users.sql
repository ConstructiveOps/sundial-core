-- Sundial access model, Phase 9 — `mentionable_users()`, so the @-mention picker can
-- grey out a target RLS would refuse. D-064 §3.5 / §5.3.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR (project qfsdpkwxahakegjnyijj), as Tim.
--
-- ============================================================================
-- WHY AN RPC AND NOT A RULE IN THE CLIENT
-- ============================================================================
-- The picker needs to answer "would a mention of this person be refused?". That is
-- exactly the `mentions_insert_scoped` WITH CHECK, which is:
--
--   record_visible_for(mentioned_user_id, c.record_object, c.record_id)
--     AND user_visible(mentioned_user_id)
--
-- Reimplementing that in TypeScript would need each user's access level, dealer and
-- Sundial id shipped to the browser, plus the record's sales rep and dealer — which a
-- Sales Rep cannot even see (`Sales_Rep__c` is not in their manifest read set). It would
-- also be a SECOND copy of an authorization rule, quietly free to diverge from the
-- policy it is meant to mirror. That is the precise failure D-064 was written to end,
-- and A11 already has one instance of getting it right by calling the same predicate
-- from `sundial-comment-notify` rather than restating it.
--
-- So the client asks the database the same question the policy asks, and gets the same
-- answer by construction.
--
-- ============================================================================
-- ⚠️ THE CALLER-VISIBILITY GATE IS NOT OPTIONAL
-- ============================================================================
-- `record_visible_for(u, …)` asks whether *u* can see a record. It says nothing about
-- whether the CALLER can. Without the first conjunct below, any authenticated user could
-- pass an arbitrary record id and learn which staff can see it — an enumeration oracle
-- over records they have no access to, built out of a function whose whole job is to
-- protect them.
--
-- `record_visible(p_object, p_id)` is the session wrapper (it calls
-- `record_visible_for(auth.uid(), …)`), so the caller must be able to see the record
-- before they learn anything about anyone else's access to it. On a record they cannot
-- see, the function returns ZERO ROWS rather than an error — the picker then greys out
-- everyone, which is the correct outcome for a record they should not be commenting on.
--
-- ============================================================================
-- WHAT IT IS NOT
-- ============================================================================
-- This is a HINT for the UI. It is not a control and must never be treated as one: the
-- RLS policy still refuses the insert, and it remains the only thing that does. If this
-- function is wrong, a user sees a name greyed out that should not be (or the reverse
-- and the insert is refused) — nobody gains access either way.

begin;

create or replace function public.mentionable_users(
  p_object   text,
  p_id       text,
  p_user_ids uuid[]
)
returns setof uuid
language sql
stable
security definer
set search_path to 'private', 'public', 'pg_catalog'
as $$
  select u
    from unnest(coalesce(p_user_ids, '{}'::uuid[])) as u
   -- 1. The CALLER must be able to see the record. See the header: without this the
   --    function is an enumeration oracle over records the caller has no access to.
   where public.record_visible(p_object, p_id)
   -- 2. …and then the two conjuncts of `mentions_insert_scoped`, in the same order and
   --    calling the same functions, so this cannot answer differently from the policy.
     and public.user_visible(u)
     and public.record_visible_for(u, p_object, p_id);
$$;

comment on function public.mentionable_users(text, text, uuid[]) is
  'D-064 §3.5. Subset of p_user_ids that could be @-mentioned on (p_object, p_id): '
  'mirrors the mentions_insert_scoped WITH CHECK by calling the same predicates. '
  'Returns zero rows if the CALLER cannot see the record. A UI hint, never a control.';

-- The browser calls this directly (comments are browser-direct, D-056). `anon` is NOT
-- granted: an unauthenticated caller has no auth.uid(), so every predicate would be
-- false anyway, and not granting it keeps the surface honest.
revoke all on function public.mentionable_users(text, text, uuid[]) from public, anon;
grant execute on function public.mentionable_users(text, text, uuid[]) to authenticated;

commit;

-- ============================================================================
-- VERIFICATION — **TIM ONLY**, run these after the commit above.
-- ============================================================================
-- These run as YOU (tenant scope), so they check the FUNCTION. The end-to-end proof that
-- the picker and the policy agree is `node scripts/verify-comment-scope.mjs`, which runs
-- as zz-rep-a1 on the browser's own path — run that too.

-- V1 — the function exists, is SECURITY DEFINER, and is granted to authenticated only.
select p.proname,
       p.prosecdef                       as security_definer,
       pg_get_function_identity_arguments(p.oid) as args,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_may_execute,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_may_execute
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'mentionable_users';
-- EXPECT: security_definer = true, authenticated = true, anon = FALSE.

-- V2 — as tenant scope, every ZZ user comes back for the ZZ customer record.
--      (Tenant callers see the record; tenant targets pass record_visible_for outright.)
select count(*) as mentionable_for_tim
  from public.mentionable_users(
         'customer', 'a1P7y00000AmyXCEAZ',
         array(select id from public.profiles where tenant_id = 'a1W7y000007AszBEAS'));
-- EXPECT: > 0, and specifically every tenant-scope staffer.

-- V3 — THE ORACLE GATE. A record id that does not exist returns ZERO rows even though
--      the user ids are perfectly valid. Proves conjunct 1 runs before the others.
select count(*) as must_be_zero
  from public.mentionable_users(
         'customer', 'a1PZZZZZZZZZZZZZZZ',
         array(select id from public.profiles where tenant_id = 'a1W7y000007AszBEAS'));
-- EXPECT: 0.

-- V4 — A11 still holds here: SOLAR yields nothing for a sales-role target, because
--      record_visible_for returns false for solar at own/dealer scope. Run it against a
--      rep's profile id and confirm they are absent from the result.
select coalesce(string_agg(u::text, ', '), '(none)') as sales_targets_on_solar
  from public.mentionable_users(
         'solar', 'a1Q7y00000JWmkvEAD',
         array(select id from public.profiles
                where tenant_id = 'a1W7y000007AszBEAS'
                  and access_scope in ('own', 'dealer'))) u;
-- EXPECT: (none) — no sales-role user may be tagged on a Solar record.
