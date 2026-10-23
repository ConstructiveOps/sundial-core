-- Sundial access model, Phase 11 — PER-COMMENT PRIVACY, and the dealer feed's
-- visibility rules. DECISIONS.md D-086 (amends D-064 A11 and D-084);
-- docs/access-model.md §5.3 / §5.4. Dealer module step 1 of 9.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR (project qfsdpkwxahakegjnyijj), as Tim.
-- Applies AFTER p1b, p8, p9, p10, 2026-10-07_comment_context.sql and
-- 2026-10-22_job_report_dates.sql. Idempotent: every statement is `if not exists`,
-- `create or replace`, or `drop … if exists` + `create`. Re-running converges.
--
-- =============================================================================
-- WHAT HARMON ASKED FOR
-- =============================================================================
-- On the Customer and Solar comment threads, Harmon staff can mark an individual
-- comment PRIVATE so dealers and reps never see it. Comments default to PUBLIC.
-- Dealers and reps read the public comments of a Customer they can see AND of the
-- Solar project linked to that Customer, in one merged feed, and post and @mention
-- Harmon staff from it.
--
-- =============================================================================
-- WHAT CHANGES
-- =============================================================================
--   1. comments.is_private  boolean not null default false. `context` may now be
--      'dealer' (the dealer portal's composer).
--   2. record_visible_for() v4 — A11 REVERSED FOR SOLAR, through the customer: at
--      `dealer` / `own` scope a solar record is visible when its CUSTOMER passes that
--      scope's existing customer rule (the customer's dealer_sf_id / sales_rep_sf_id),
--      not the solar row's own rep or dealer. One deal, one owner: the customer.
--      Tenant and tech branches are unchanged, verbatim from p10.
--   3. comment_readable_for(profile, object, id, is_private) — record_visible_for()
--      AND (public OR the profile is tenant / tech scope). THE one predicate for
--      "may this person read this comment".
--   4. comments SELECT uses it; comments INSERT lets only tenant / tech write a
--      private comment. Both policies are now `to authenticated` (see ANON below).
--   5. mentions_insert_scoped and mentionable_users() use it, so nobody can be
--      mentioned on a comment they could not read — a staffer cannot tag a rep onto
--      a private comment, which is what keeps the notify email inside its scope.
--   6. set_comment_private(comment, private) — the ONE write path for is_private.
--      Still no UPDATE policy on comments (p1b divergence: an UPDATE policy would let
--      an author move a comment onto another record).
--   7. comments replica identity full, so a Realtime UPDATE carries the new is_private.
--
-- WHY A11 IS SAFE TO REVERSE NOW. A11 closed solar comments to sales roles because
-- staff prose about engineering, budget and scheduling routed around the field
-- manifest. The private flag answers that per comment instead of per object: the
-- staffer who writes the sentence quoting the numbers marks it private.
--
-- ⚠️ EXISTING SOLAR COMMENTS. Every comment written before this file was written
-- under A11's promise that solar threads were staff-only, and every one of them
-- becomes is_private = FALSE by the column default. Once Part A commits, a rep can
-- read the existing staff comments on THEIR OWN solar projects. V5 counts exactly how
-- many. PART B (optional, commented out) marks them all private instead — it is
-- Tim's / Harmon's call, not this file's. Customer threads are unaffected: sales
-- roles could already read every comment on a customer they can see.
--
-- ANON. p1b's comments policies apply to role {public}, and Part C kept
-- record_visible()'s anon grant ONLY so an anonymous SELECT on comments stays
-- "200, 0 rows" rather than a 42501. comment_readable_for() takes its subject as an
-- argument (the record_visible_for() oracle shape), so anon must NOT execute it.
-- The two comments policies that call it are therefore scoped `to authenticated`:
-- for anon no policy applies and RLS returns 0 rows with no error — the same
-- surface Phase 0 baselined. V8 proves it. comments_delete_own is untouched.
--
-- GRANTS. Supabase's default privileges grant every NEW function in `public` to
-- anon directly (p1b Part C). Every function created here is revoked from PUBLIC
-- AND anon explicitly. `create or replace` keeps an existing ACL; never `drop` one
-- of these — re-run this file and re-check V2 if you ever do.


-- #############################################################################
-- ##  PART A — schema, helpers, policies. ONE TRANSACTION.                   ##
-- #############################################################################
-- Drops and creates of each policy sit in one transaction so there is never an
-- instant with two permissive SELECT paths (p1b, Part B header).

begin;

-- ---------------------------------------------------------------------------
-- 1. The column, and 'dealer' as a context.
-- ---------------------------------------------------------------------------
alter table public.comments
  add column if not exists is_private boolean not null default false;

comment on column public.comments.is_private is
  'D-086. TRUE = staff only: readable by tenant- and tech-scope users, never by a dealer '
  'or a rep (comment_readable_for). Default FALSE. Written at insert (only tenant / tech '
  'may insert TRUE) and afterwards ONLY by public.set_comment_private().';

-- The context check was declared inline by 2026-10-07_comment_context.sql, so its
-- name is Postgres's choice. Drop whichever check constraint guards `context`, then
-- add a named one. Re-running drops and re-adds the named one.
do $$
declare
  r record;
begin
  for r in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'public.comments'::regclass
       and con.contype  = 'c'
       and pg_get_constraintdef(con.oid) ilike '%context%'
  loop
    execute format('alter table public.comments drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.comments
  add constraint comments_context_check
  check (context is null or context in ('sales', 'service', 'solar', 'roofing', 'dealer'));

comment on column public.comments.context is
  'The module the composer was on (sales | service | solar | roofing | dealer); the '
  'mention link follows it. Null = unknown (links as Sales).';

-- INDEX: none added. idx_comments_tenant_record (tenant_id, record_object, record_id)
-- already narrows a thread read to one record's rows — a handful — and is_private is
-- a cheap filter on those. A fourth column would only pay on a thread of thousands.

-- ---------------------------------------------------------------------------
-- 2. record_visible_for() v4. Tenant and tech: verbatim from p10.
--    Dealer and own: customer verbatim; solar THROUGH ITS CUSTOMER.
-- ---------------------------------------------------------------------------
create or replace function public.record_visible_for(
  p_profile_id uuid,
  p_object     text,
  p_id         text
)
returns boolean
language sql
stable
security definer
set search_path = private, public, pg_catalog
as $$
  select coalesce((
    select case
      when a.scope = 'tenant' then true

      when p_id is null or p_id = '' then false

      -- TECH (D-072 amendment 7, p10): unchanged.
      when a.scope = 'tech' then
        case lower(coalesce(p_object, ''))
          when 'job' then exists (
            select 1 from public.sundial_service_job_cache j
             where j.sf_id = p_id and j.client_sf_id = a.tenant_id)
          when 'estimate' then exists (
            select 1 from public.sundial_estimate_cache e
             where e.sf_id = p_id and e.client_sf_id = a.tenant_id)
          when 'customer' then exists (
            select 1 from public.sundial_customer_cache c
             where c.sf_id = p_id and c.client_sf_id = a.tenant_id)
          else false
        end

      when a.scope = 'dealer' then
        case lower(coalesce(p_object, ''))
          when 'customer' then exists (
            select 1 from public.sundial_customer_cache c
             where c.sf_id = p_id
               and c.client_sf_id = a.tenant_id
               and a.dealer_sf_id is not null
               and c.dealer_sf_id = a.dealer_sf_id)
          -- D-086 (reverses A11's `false`): a solar record is visible when ITS
          -- CUSTOMER passes the customer rule above. Both rows must be this tenant's.
          when 'solar' then exists (
            select 1
              from public.sundial_solar_cache s
              join public.sundial_customer_cache c
                on c.sf_id = s.sundial_customer_sf_id
               and c.client_sf_id = a.tenant_id
             where s.sf_id = p_id
               and s.client_sf_id = a.tenant_id
               and a.dealer_sf_id is not null
               and c.dealer_sf_id = a.dealer_sf_id)
          else false
        end

      when a.scope = 'own' then
        case lower(coalesce(p_object, ''))
          when 'customer' then exists (
            select 1 from public.sundial_customer_cache c
             where c.sf_id = p_id
               and c.client_sf_id = a.tenant_id
               and a.sundial_user_id is not null
               and c.sales_rep_sf_id = a.sundial_user_id)
          -- D-086: the solar's customer is the rep's.
          when 'solar' then exists (
            select 1
              from public.sundial_solar_cache s
              join public.sundial_customer_cache c
                on c.sf_id = s.sundial_customer_sf_id
               and c.client_sf_id = a.tenant_id
             where s.sf_id = p_id
               and s.client_sf_id = a.tenant_id
               and a.sundial_user_id is not null
               and c.sales_rep_sf_id = a.sundial_user_id)
          else false
        end

      else false
    end
    from private.resolve_access(p_profile_id) a
  ), false);   -- no row from resolve_access (unknown user) -> false, never NULL
$$;

-- ---------------------------------------------------------------------------
-- 3. comment_readable_for() — may THAT person read a comment with THIS privacy on
--    THAT record? The only rule for comment reads, mentions, the picker and the
--    notify Lambda's question about a private comment.
-- ---------------------------------------------------------------------------
-- A NULL p_is_private is treated as PRIVATE: an unknown answer fails closed.
create or replace function public.comment_readable_for(
  p_profile_id uuid,
  p_object     text,
  p_id         text,
  p_is_private boolean
)
returns boolean
language sql
stable
security definer
set search_path = private, public, pg_catalog
as $$
  select public.record_visible_for(p_profile_id, p_object, p_id)
     and (
       not coalesce(p_is_private, true)
       or coalesce((select a.scope in ('tenant', 'tech')
                      from private.resolve_access(p_profile_id) a), false)
     );
$$;

comment on function public.comment_readable_for(uuid, text, text, boolean) is
  'D-086. record_visible_for(profile, object, id) AND (not private OR the profile is '
  'tenant / tech scope). Used by comments_select_visible, mentions_insert_scoped and '
  'mentionable_users. Never granted to anon: it takes its subject as an argument.';

revoke all     on function public.comment_readable_for(uuid, text, text, boolean) from public, anon;
grant  execute on function public.comment_readable_for(uuid, text, text, boolean) to authenticated, service_role;

-- record_visible_for keeps p1b Part C's ACL (create or replace preserves it); say so.
revoke all     on function public.record_visible_for(uuid, text, text) from public, anon;
grant  execute on function public.record_visible_for(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Policies — public.comments
-- ---------------------------------------------------------------------------
drop policy if exists comments_select_visible on public.comments;
drop policy if exists comments_insert_visible on public.comments;

-- SELECT: my tenant, AND I may read THIS comment (record + privacy).
create policy comments_select_visible
  on public.comments for select
  to authenticated
  using (
    tenant_id = public.current_user_tenant()
    and public.comment_readable_for(auth.uid(), record_object, record_id, is_private)
  );

-- INSERT: as p1b, plus — only tenant / tech scope may write a PRIVATE comment. A rep
-- or dealer posts is_private = false or nothing. The client's .insert().select()
-- read-back passes the SELECT policy by construction (the author can read their own).
create policy comments_insert_visible
  on public.comments for insert
  to authenticated
  with check (
    tenant_id = public.current_user_tenant()
    and author_id = auth.uid()
    and public.record_visible(record_object, record_id)
    and (
      is_private = false
      or exists (select 1 from public.current_profile() cp
                  where cp.access_scope in ('tenant', 'tech'))
    )
  );

-- comments_delete_own: unchanged from p1b (own row, own tenant; not visibility-gated).
--
-- STILL NO UPDATE POLICY. `authenticated` holds UPDATE on this table and the absence
-- of a policy is what keeps it inert (p1b). is_private is written after insert ONLY
-- by public.set_comment_private() below, which runs as its owner.

-- ---------------------------------------------------------------------------
-- 5. Mentions: nobody can be mentioned on a comment they could not read.
-- ---------------------------------------------------------------------------
drop policy if exists mentions_insert_scoped on public.comment_mentions;

create policy mentions_insert_scoped
  on public.comment_mentions for insert
  with check (
    exists (
      select 1
        from public.comments c
       where c.id = comment_mentions.comment_id
         and c.author_id = auth.uid()
         and c.tenant_id = public.current_user_tenant()
         and public.comment_readable_for(
               comment_mentions.mentioned_user_id, c.record_object, c.record_id, c.is_private)
    )
    and public.user_visible(comment_mentions.mentioned_user_id)
  );
-- Role stays {public}, as p1b: an anon insert was already a 42501 (p1b Part C note),
-- and anon can never satisfy the EXISTS on comments.

-- The picker's question, now including the privacy of the comment being composed.
-- A NEW 4-argument overload; the 3-argument one stays (the portal calls it today)
-- and becomes "a public comment". No DEFAULT on p_is_private: with one, a 3-argument
-- PostgREST call would match both overloads and fail as ambiguous.
create or replace function public.mentionable_users(
  p_object     text,
  p_id         text,
  p_user_ids   uuid[],
  p_is_private boolean
)
returns setof uuid
language sql
stable
security definer
set search_path to 'private', 'public', 'pg_catalog'
as $$
  select u
    from unnest(coalesce(p_user_ids, '{}'::uuid[])) as u
   -- 1. The CALLER must be able to read such a comment (p9's oracle gate, now with
   --    privacy: a rep asking about a private comment gets zero rows — they cannot
   --    write one).
   where public.comment_readable_for(auth.uid(), p_object, p_id, p_is_private)
   -- 2. The two conjuncts of mentions_insert_scoped, same order, same functions.
     and public.user_visible(u)
     and public.comment_readable_for(u, p_object, p_id, p_is_private);
$$;

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
  select * from public.mentionable_users(p_object, p_id, p_user_ids, false);
$$;

comment on function public.mentionable_users(text, text, uuid[], boolean) is
  'D-064 §3.5 / D-086. Subset of p_user_ids that could be @-mentioned on a comment with '
  'this privacy on (p_object, p_id): mirrors mentions_insert_scoped. Zero rows if the '
  'CALLER could not read such a comment. A UI hint, never a control.';
comment on function public.mentionable_users(text, text, uuid[]) is
  'D-064 §3.5. The public-comment form of mentionable_users(…, p_is_private => false).';

revoke all     on function public.mentionable_users(text, text, uuid[], boolean) from public, anon;
grant  execute on function public.mentionable_users(text, text, uuid[], boolean) to authenticated;
revoke all     on function public.mentionable_users(text, text, uuid[])          from public, anon;
grant  execute on function public.mentionable_users(text, text, uuid[])          to authenticated;

-- ---------------------------------------------------------------------------
-- 6. set_comment_private() — the ONE write path for is_private after insert.
-- ---------------------------------------------------------------------------
-- TRUE only when ALL hold:
--   * the caller is tenant or tech scope (private.resolve_access, both sources);
--   * the comment is in the caller's tenant, on a record the caller can see;
--   * the comment's AUTHOR is tenant or tech scope — a dealer's or rep's own words
--     can never be hidden from them. A comment with no author (the author's user was
--     deleted — author_id SET NULL — or a system line written with no signed-in
--     person) is therefore not toggleable.
-- Updates is_private and nothing else. FALSE for every refusal, never an error, so
-- the portal can treat it as one yes/no.
create or replace function public.set_comment_private(
  p_comment_id uuid,
  p_private    boolean
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant text;
  v_scope  text;
  v_rows   integer;
begin
  if p_comment_id is null or p_private is null then
    return false;
  end if;

  select a.tenant_id, a.scope
    into v_tenant, v_scope
    from private.resolve_access(auth.uid()) a;

  if v_tenant is null or v_scope is null or v_scope not in ('tenant', 'tech') then
    return false;
  end if;

  update public.comments c
     set is_private = p_private
   where c.id = p_comment_id
     and c.tenant_id = v_tenant
     and public.record_visible_for(auth.uid(), c.record_object, c.record_id)
     and c.author_id is not null
     and exists (select 1 from private.resolve_access(c.author_id) au
                  where au.scope in ('tenant', 'tech'));

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

comment on function public.set_comment_private(uuid, boolean) is
  'D-086. The only writer of comments.is_private after insert. Caller tenant / tech scope, '
  'comment in the caller''s tenant on a record they can see, author tenant / tech scope. '
  'Returns true when the row was updated, false for every refusal.';

revoke all     on function public.set_comment_private(uuid, boolean) from public, anon;
grant  execute on function public.set_comment_private(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Realtime: UPDATE events carry the row.
-- ---------------------------------------------------------------------------
-- The thread subscribes to postgres_changes on comments. Until now only INSERT
-- mattered; set_comment_private() makes UPDATE matter too: an open thread must learn
-- a comment's NEW is_private (staff see the badge move; a public flip reaches a rep's
-- open feed as a row RLS now lets them read). With the default replica identity the
-- WAL carries only the key for the old row; FULL makes the change record whole, so
-- Realtime can evaluate RLS on it and hand the client the full new row.
-- Residual (D-086): a row flipped to PRIVATE is not delivered to a rep — RLS refuses
-- the new row — so a rep's open tab keeps the comment until it reloads. They had
-- already read it; the flag protects what is written next, not what was seen.
alter table public.comments replica identity full;

commit;


-- #############################################################################
-- ##  PART B — OPTIONAL. Make every EXISTING solar comment private.           ##
-- #############################################################################
-- Run V5 first. It counts the existing comments Part A just made readable to a rep
-- or dealer. If Harmon wants A11's promise kept for everything written under it,
-- uncomment and run this block; new comments still default to public.
--
-- The kind = 'system' line is the same idea for D-084's intake / assignment lines
-- already on customers (sales roles could read those before; lib/intake-comment.js
-- writes new ones private). It needs comments.kind (2026-10-22_job_report_dates.sql).
--
-- begin;
--   update public.comments set is_private = true
--    where record_object = 'solar' and is_private = false;
--   update public.comments set is_private = true
--    where kind = 'system' and is_private = false;
-- commit;


-- #############################################################################
-- ##  VERIFICATION — one at a time, after Part A commits.                    ##
-- #############################################################################
-- V1–V7 run as `postgres` and BYPASS RLS: they check the catalog and the helper
-- arithmetic. V8–V10 are **TIM ONLY** (`set role`, which Claude's read-only MCP role
-- cannot do) and prove the POLICIES. The end-to-end proof as real ZZ sessions is
-- `node scripts/verify-comment-scope.mjs` and `node scripts/verify-comment-rls.mjs`.
-- In every `set role` block: SET THE CLAIMS BEFORE SWITCHING ROLE (p1b, above V10),
-- and assert `uid` is non-null before believing any count beside it.


-- ---------------------------------------------------------------------------
-- V1 — the column and the context check.
-- EXPECT: is_private | boolean | NO | false ; one constraint comments_context_check
--         whose definition lists 'dealer'.
-- ---------------------------------------------------------------------------
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'comments' and column_name = 'is_private';

select conname, pg_get_constraintdef(oid) as def
  from pg_constraint
 where conrelid = 'public.comments'::regclass and contype = 'c'
   and pg_get_constraintdef(oid) ilike '%context%';


-- ---------------------------------------------------------------------------
-- V2 — functions: D-056 properties and narrow grants.
-- EXPECT every row security_definer = true, search_path_pinned = true, owner postgres;
--   record_visible           anon TRUE  (deliberate, p1b Part C) / auth true / svc true
--   record_visible_for       anon false / auth true / svc true
--   comment_readable_for     anon false / auth true / svc true
--   mentionable_users (x2)   anon false / auth true / svc —
--   set_comment_private      anon false / auth true / svc —
--   volatility 's' for all but set_comment_private ('v').
-- ---------------------------------------------------------------------------
select p.proname                                           as function,
       pg_get_function_identity_arguments(p.oid)           as args,
       p.prosecdef                                         as security_definer,
       p.provolatile                                       as volatility,
       (p.proconfig is not null
        and exists (select 1 from unnest(p.proconfig) c
                     where c like 'search\_path=%'))       as search_path_pinned,
       pg_get_userbyid(p.proowner)                         as owner,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') as svc_exec
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('record_visible', 'record_visible_for', 'comment_readable_for',
                     'mentionable_users', 'set_comment_private')
 order by 1, 2;


-- ---------------------------------------------------------------------------
-- V3 — the policy set.
-- EXPECT exactly 5 rows —
--   comment_mentions | mentions_insert_scoped  | INSERT | {public}        | check names comment_readable_for AND user_visible
--   comment_mentions | mentions_select_own     | SELECT | {public}
--   comments         | comments_delete_own     | DELETE | {public}
--   comments         | comments_insert_visible | INSERT | {authenticated} | check names record_visible AND is_private
--   comments         | comments_select_visible | SELECT | {authenticated} | qual names comment_readable_for
-- NO UPDATE row on either table.
-- ---------------------------------------------------------------------------
select tablename, policyname, cmd, roles, qual, with_check
  from pg_policies
 where schemaname = 'public' and tablename in ('comments', 'comment_mentions')
 order by tablename, policyname;


-- ---------------------------------------------------------------------------
-- V4 — the ZZ matrix, straight out of the helpers.
-- Customers: a1 = a1P7y00000AmyXCEAZ (rep-a1, Dealer A) · b1 = a1P7y00000ApR21EAF.
-- Solar: a1 = a1Q7y00000JWmkvEAD (twin of an rep-a1 customer) · b1 = a1Q7y00000JWmo9EAD.
-- EXPECT:
--   viewer        scope  | a1_cust a1_solar b1_solar | a1_cust_priv a1_solar_priv
--   zz-admin      tenant |   t       t        t      |   t            t
--   zz-exec       tenant |   t       t        t      |   t            t
--   zz-mgr-a      dealer |   t       t        f      |   f            f
--   zz-rep-a1     own    |   t       t        f      |   f            f      <-- solar t is D-086
--   zz-rep-a2     own    |   f       f        f      |   f            f
--   zz-rep-b1     own    |   f       f        t      |   f            f
--   zz-tech       tech   |   t       f        f      |   t            f
--   zz-rep-nodealer / zz-rep-inactive-dealer   none  |  all f
-- If zz-rep-a1 a1_solar is FALSE, check the twin's sundial_customer_sf_id in the
-- solar cache: the rule now reads the CUSTOMER's rep, not the solar row's.
-- ---------------------------------------------------------------------------
with viewer as (
  select p.id, split_part(p.email, '@', 1) as who
    from public.profiles p
   where p.email like 'tim+zz-%@constructiveoperations.com'
)
select v.who,
       (select r.scope from private.resolve_access(v.id) r)                                as scope,
       public.record_visible_for(v.id, 'customer', 'a1P7y00000AmyXCEAZ')                    as a1_cust,
       public.record_visible_for(v.id, 'solar',    'a1Q7y00000JWmkvEAD')                    as a1_solar,
       public.record_visible_for(v.id, 'solar',    'a1Q7y00000JWmo9EAD')                    as b1_solar,
       public.comment_readable_for(v.id, 'customer', 'a1P7y00000AmyXCEAZ', true)            as a1_cust_priv,
       public.comment_readable_for(v.id, 'solar',    'a1Q7y00000JWmkvEAD', true)            as a1_solar_priv
  from viewer v
 order by v.who;


-- ---------------------------------------------------------------------------
-- V5 — WHAT PART A OPENED. Existing comments now readable by a sales-role user that
-- were not before (A11 hid every solar comment from them), and — the control —
-- customer comments they could read before and cannot now.
-- EXPECT: solar_newly_readable = the existing staff comments on that user's own
-- solar projects — the number Part B would close. customer_now_hidden = 0 on every
-- row straight after Part A (every existing comment is public); after Part B it
-- counts the system lines Part B made private, and nothing else.
-- ---------------------------------------------------------------------------
select p.email,
       (select r.scope from private.resolve_access(p.id) r)                                 as scope,
       count(*) filter (where c.record_object = 'solar'
                          and public.comment_readable_for(p.id, c.record_object, c.record_id, c.is_private))
                                                                                            as solar_newly_readable,
       count(*) filter (where c.record_object = 'customer'
                          and public.record_visible_for(p.id, c.record_object, c.record_id)
                          and not public.comment_readable_for(p.id, c.record_object, c.record_id, c.is_private))
                                                                                            as customer_now_hidden
  from public.profiles p
  join public.comments c on c.tenant_id = p.tenant_id
 where (select r.scope from private.resolve_access(p.id) r) in ('own', 'dealer')
 group by p.email, p.id
 order by solar_newly_readable desc, p.email;


-- ---------------------------------------------------------------------------
-- V6 — staff lost nothing. EXPECT verdict 'unchanged' on every tenant / tech row:
-- comment_readable_for agrees with record_visible_for for them on every comment,
-- private or not.
-- ---------------------------------------------------------------------------
select p.email,
       (select r.scope from private.resolve_access(p.id) r)                                 as scope,
       count(*) filter (where public.record_visible_for(p.id, c.record_object, c.record_id)) as record_visible,
       count(*) filter (where public.comment_readable_for(p.id, c.record_object, c.record_id, c.is_private))
                                                                                            as comment_readable,
       case when count(*) filter (where public.record_visible_for(p.id, c.record_object, c.record_id))
               = count(*) filter (where public.comment_readable_for(p.id, c.record_object, c.record_id, c.is_private))
            then 'unchanged' else 'NARROWED  <-- STOP' end                                  as verdict
  from public.profiles p
  join public.comments c on c.tenant_id = p.tenant_id
 where (select r.scope from private.resolve_access(p.id) r) in ('tenant', 'tech')
 group by p.email, p.id
 order by verdict desc, p.email;


-- ---------------------------------------------------------------------------
-- V7 — replica identity. EXPECT relreplident = 'f' (full).
-- ---------------------------------------------------------------------------
select relname, relreplident from pg_class where oid = 'public.comments'::regclass;


-- ---------------------------------------------------------------------------
-- V8 — **TIM ONLY**. Anon still reads "0 rows, no error" — the comments policies
-- are `to authenticated` now, so for anon none applies. An ERROR here means an
-- anonymous visitor gets a 500 where they used to get an empty list.
-- EXPECT: 0 and 0, no error.
-- ---------------------------------------------------------------------------
begin;
  set local role anon;
  select count(*) as comments_readable_as_anon from public.comments;
  select count(*) as mentions_readable_as_anon from public.comment_mentions;
rollback;


-- ---------------------------------------------------------------------------
-- V9 — **TIM ONLY**. The write refusals and the toggle, as zz-rep-a1 then
-- zz-admin. Everything rolls back.
-- EXPECT:
--   (a) zz-rep-a1 inserts a PRIVATE comment on own customer  -> 42501
--   (b) zz-rep-a1 set_comment_private(<any comment>, true)   -> false
-- Run (a) alone first (the error aborts the transaction), then (b).
-- ---------------------------------------------------------------------------
begin;
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id from public.profiles
               where email = 'tim+zz-rep-a1@constructiveoperations.com'),
      'role', 'authenticated')::text, true);
  set local role authenticated;
  select auth.uid() as uid;   -- MUST be non-null
  -- (a) EXPECT 42501
  insert into public.comments (tenant_id, record_object, record_id, author_id, author_name, body, is_private)
  values ('a1W7y000007AszBEAS', 'customer', 'a1P7y00000AmyXCEAZ', auth.uid(),
          'ZZ P11 PROBE', 'V9(a) — private from a rep, expected to FAIL', true);
rollback;

begin;
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id from public.profiles
               where email = 'tim+zz-rep-a1@constructiveoperations.com'),
      'role', 'authenticated')::text, true);
  set local role authenticated;
  select auth.uid() as uid,
         -- (b) EXPECT false
         public.set_comment_private(
           (select id from public.comments
             where record_id = 'a1P7y00000AmyXCEAZ' order by created_at desc limit 1),
           true) as rep_toggle;
rollback;


-- ---------------------------------------------------------------------------
-- V10 — **TIM ONLY**. Staff writes a public comment, makes it private, and the rep
-- can no longer be mentioned on it. Rolls back.
-- EXPECT: uid non-null; staff_toggle = true; rep_could_read = false; the final
-- mention insert raises 42501. (The rep's own READ of it is proved as a real
-- session by scripts/verify-comment-scope.mjs — one transaction cannot become a
-- second user after `set local role`.)
-- Separate statements on purpose: a data-modifying CTE's row is not visible to the
-- rest of its own statement, so set_comment_private would find nothing to update.
-- ---------------------------------------------------------------------------
begin;
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id from public.profiles
               where email = 'tim+zz-admin@constructiveoperations.com'),
      'role', 'authenticated')::text, true);
  -- The rep's uuid, resolved as postgres BEFORE the role switch (p1b's V10 warning).
  select set_config('p11.rep_id',
    (select id::text from public.profiles
      where email = 'tim+zz-rep-a1@constructiveoperations.com'), true);
  set local role authenticated;
  select auth.uid() as uid, current_setting('p11.rep_id') as rep_id;   -- BOTH non-null

  insert into public.comments (tenant_id, record_object, record_id, author_id, author_name, body)
  values ('a1W7y000007AszBEAS', 'customer', 'a1P7y00000AmyXCEAZ', auth.uid(),
          'ZZ P11 PROBE', 'V10 — staff comment, made private');

  select public.set_comment_private(
           (select id from public.comments where body = 'V10 — staff comment, made private'),
           true)                                                                    as staff_toggle,
         public.comment_readable_for(current_setting('p11.rep_id')::uuid,
                                     'customer', 'a1P7y00000AmyXCEAZ', true)        as rep_could_read;

  -- EXPECT 42501: mentioning the rep on the now-private comment.
  insert into public.comment_mentions (comment_id, mentioned_user_id)
  select c.id, current_setting('p11.rep_id')::uuid
    from public.comments c
   where c.body = 'V10 — staff comment, made private';
rollback;


-- ---------------------------------------------------------------------------
-- V11 — the one-line gate set. EXPECT every pass = true.
-- ---------------------------------------------------------------------------
select 'comments SELECT policy names comment_readable_for' as gate,
       exists (select 1 from pg_policies
                where schemaname = 'public' and tablename = 'comments'
                  and cmd = 'SELECT' and qual like '%comment_readable_for%') as pass
union all
select 'comments INSERT policy restricts is_private',
       exists (select 1 from pg_policies
                where schemaname = 'public' and tablename = 'comments'
                  and cmd = 'INSERT' and with_check like '%is_private%')
union all
select 'mentions INSERT names comment_readable_for AND user_visible',
       exists (select 1 from pg_policies
                where schemaname = 'public' and tablename = 'comment_mentions'
                  and cmd = 'INSERT' and with_check like '%comment_readable_for%'
                  and with_check like '%user_visible%')
union all
select 'no UPDATE policy on comments or comment_mentions',
       not exists (select 1 from pg_policies
                    where schemaname = 'public'
                      and tablename in ('comments', 'comment_mentions')
                      and cmd = 'UPDATE')
union all
select 'set_comment_private is the definer write path, not anon',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'set_comment_private'
                  and p.prosecdef
                  and not has_function_privilege('anon', p.oid, 'EXECUTE'))
union all
select 'comment_readable_for not executable by anon',
       not has_function_privilege('anon',
         'public.comment_readable_for(uuid, text, text, boolean)', 'EXECUTE')
union all
select 'comments replica identity full',
       (select relreplident = 'f' from pg_class where oid = 'public.comments'::regclass);
