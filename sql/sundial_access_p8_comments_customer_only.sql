-- Sundial access model — SALES-ROLE COMMENTS ARE CUSTOMER-ONLY.
-- D-064 amendment A11 (2026-08-28). Amends the answer-9 comment scope.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR (project qfsdpkwxahakegjnyijj), as Tim.
--
-- ============================================================================
-- WHAT CHANGES, AND WHAT DOES NOT
-- ============================================================================
--
--   BEFORE: a sales role could read, write and be mentioned in comments on any
--           CUSTOMER **or SOLAR** record they could see.
--   AFTER:  customer only. Solar comments are closed to `own` and `dealer` scope
--           entirely — including on their OWN solar projects.
--
--   TENANT SCOPE IS UNTOUCHED. Harmon staff keep full comments on both objects, and
--   the `when a.scope = 'tenant' then true` branch is not edited at all.
--
-- This is ONE function. `record_visible(p_object, p_id)` is a one-line wrapper that
-- calls `record_visible_for(auth.uid(), ...)`, so it inherits the change and is
-- deliberately NOT re-created here: re-declaring an unchanged function is a chance for
-- it to drift from the copy in sundial_access_p1b_comment_rls.sql. V4 proves the
-- inheritance rather than assuming it.
--
-- Both comments policies and both comment_mentions policies call these two functions,
-- so read, insert AND mention-insert all move together. That is the point of the
-- Phase 1b shape: there is one predicate, and this file changes it once.
--
-- ============================================================================
-- WHY SOLAR, WHEN A REP CAN SEE THE SOLAR RECORD ITSELF
-- ============================================================================
-- Because a comment is not a field, and the field manifest already answered the
-- underlying question: the Solar sheet gives a sales role READ on 115 of 473 fields and
-- EDIT on NONE. A Solar project is, to a rep, a record they may look at and not touch.
--
-- A comment thread on it is neither. It is free text written by staff about
-- engineering, permitting, budget and scheduling — the parts of the record the manifest
-- hides — and it is written on the assumption that only staff read it. Leaving comments
-- open on Solar would let the prose route around the field rules: the numbers are
-- hidden, the sentence quoting the numbers is not.
--
-- ⚠️ THE MENTION HALF IS THE SHARPER ONE. `comment_mentions` insert is gated on
-- `record_visible_for(mentioned_user, ...)`, so after this change a staff member simply
-- CANNOT mention a rep onto a solar comment — the insert is refused at the database.
-- That is what stops `sundial-comment-notify` emailing a rep the body of a comment they
-- would then be unable to open. No Lambda change is needed for that: the notify
-- re-check calls the same RPC (§3.7), so it inherits this and skips.

begin;

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
      -- TENANT: unchanged. No cache lookup, no module gate. See divergence (a) in
      -- sundial_access_p1b_comment_rls.sql -- 28 live comments sit on 18 records the
      -- cache no longer holds, and staff must keep reading them.
      when a.scope = 'tenant' then true

      when p_id is null or p_id = '' then false

      -- DEALER: CUSTOMER ONLY as of A11.
      when a.scope = 'dealer' then
        case lower(coalesce(p_object, ''))
          when 'customer' then exists (
            select 1 from public.sundial_customer_cache c
             where c.sf_id = p_id
               and c.client_sf_id = a.tenant_id
               and a.dealer_sf_id is not null
               and c.dealer_sf_id = a.dealer_sf_id)
          -- A11: solar comments are closed to sales roles, including on records they
          -- can otherwise SEE. Written as an explicit `false` rather than left to the
          -- `else` so the intent is unmissable: the next person to read this must not
          -- conclude the branch was forgotten and "restore" it.
          when 'solar' then false
          else false
        end

      -- OWN: CUSTOMER ONLY as of A11. Same reasoning; see the header.
      when a.scope = 'own' then
        case lower(coalesce(p_object, ''))
          when 'customer' then exists (
            select 1 from public.sundial_customer_cache c
             where c.sf_id = p_id
               and c.client_sf_id = a.tenant_id
               and a.sundial_user_id is not null
               and c.sales_rep_sf_id = a.sundial_user_id)
          when 'solar' then false   -- A11
          else false
        end

      -- scope 'none'.
      else false
    end
    from private.resolve_access(p_profile_id) a
  ), false);   -- no row from resolve_access (unknown user) -> false, never NULL
$$;

commit;


-- ============================================================================
-- VERIFICATION. EVERY BLOCK BELOW IS TIM ONLY -- run them in the SQL editor.
--
-- Claude cannot run ANY of them, including V1 and V2, and that is worth stating
-- because the first draft of this file said otherwise: Part C of Phase 1b revoked
-- anon EXECUTE on record_visible_for(), so the read-only MCP connection gets
-- 42501: permission denied for function record_visible_for before it evaluates
-- anything at all. V3-V8 additionally need set role, which that connection also
-- cannot do.
--
-- That is the control working rather than an obstacle: the function is SECURITY
-- DEFINER over the grant-revoked cache tables, so a connection that could call it
-- freely would be a way around the revoke.
-- ============================================================================
--
-- ⚠️ ORDER IS LOAD-BEARING IN EVERY `set role` BLOCK BELOW, and this is the trap that
-- produced a FALSE GREEN on 2026-08-27: if you `set local role authenticated` BEFORE
-- resolving the test user's uuid, the `select id from public.profiles ...` subquery
-- runs as `authenticated`, where `own_profile_select` (auth.uid() = id) hides every row
-- while auth.uid() is still NULL. The claims then carry a NULL `sub`, and every count
-- is measured for a session that is nobody -- which returns 0, exactly like a correct
-- pass. ALWAYS CHECK THE `uid` COLUMN IS NON-NULL BEFORE BELIEVING ANY COUNT BESIDE IT.

-- ---------------------------------------------------------------------------
-- V1 — the function's own answer, without impersonation. Runs as postgres.
-- EXPECT exactly this:
--   rep_customer  t     (a rep still sees their own customer)
--   rep_solar     f     <- THE CHANGE
--   exec_customer t
--   exec_solar    t     (staff unchanged, both objects)
-- ---------------------------------------------------------------------------
select
  public.record_visible_for(
    (select id from public.profiles where email='tim+zz-rep-a1@constructiveoperations.com'),
    'customer','a1P7y00000AmyXCEAZ')                              as rep_customer,
  public.record_visible_for(
    (select id from public.profiles where email='tim+zz-rep-a1@constructiveoperations.com'),
    'solar','a1Q7y00000JWmkvEAD')                                 as rep_solar,
  public.record_visible_for(
    (select id from public.profiles where email='tim+zz-exec@constructiveoperations.com'),
    'customer','a1P7y00000AmyXCEAZ')                              as exec_customer,
  public.record_visible_for(
    (select id from public.profiles where email='tim+zz-exec@constructiveoperations.com'),
    'solar','a1Q7y00000JWmkvEAD')                                 as exec_solar;

-- ---------------------------------------------------------------------------
-- V2 — the dealer-scope half. zz-mgr-a manages Dealer A, which owns that solar
-- project, so this is the case where "they can see the record but not its comments"
-- is most visible.
-- EXPECT: mgr_customer t, mgr_solar f
-- ---------------------------------------------------------------------------
select
  public.record_visible_for(
    (select id from public.profiles where email='tim+zz-mgr-a@constructiveoperations.com'),
    'customer','a1P7y00000AmyXCEAZ')                              as mgr_customer,
  public.record_visible_for(
    (select id from public.profiles where email='tim+zz-mgr-a@constructiveoperations.com'),
    'solar','a1Q7y00000JWmkvEAD')                                 as mgr_solar;

-- ---------------------------------------------------------------------------
-- V3 — **TIM ONLY**. READ, as zz-rep-a1's real session.
-- EXPECT: uid NON-NULL (see the warning above), solar_comments_visible = 0,
--         and customer_comments_visible unchanged from before this file.
-- ---------------------------------------------------------------------------
begin;
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id from public.profiles
               where email = 'tim+zz-rep-a1@constructiveoperations.com'),
      'role','authenticated')::text, true);
  set local role authenticated;

  select auth.uid()                                    as uid,
         (select count(*) from public.comments
           where record_object = 'solar')              as solar_comments_visible,
         (select count(*) from public.comments
           where record_object = 'customer')           as customer_comments_visible;
rollback;

-- ---------------------------------------------------------------------------
-- V4 — **TIM ONLY**. record_visible() (the session wrapper) INHERITS the change.
-- This is why the wrapper is not re-created above: it is proven, not assumed.
-- EXPECT: uid NON-NULL, own_customer t, own_solar f
-- ---------------------------------------------------------------------------
begin;
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id from public.profiles
               where email = 'tim+zz-rep-a1@constructiveoperations.com'),
      'role','authenticated')::text, true);
  set local role authenticated;

  select auth.uid()                                                     as uid,
         public.record_visible('customer','a1P7y00000AmyXCEAZ')         as own_customer,
         public.record_visible('solar','a1Q7y00000JWmkvEAD')            as own_solar;
rollback;

-- ---------------------------------------------------------------------------
-- V5 — **TIM ONLY**. THE WRITE REFUSAL. A rep commenting on their OWN solar project.
-- EXPECT: the INSERT raises `42501 new row violates row-level security policy`.
--         If it returns an id instead, STOP — the insert policy is not using
--         record_visible().
-- Ends in rollback; the id is a ZZ fixture. DO NOT point this at a live record.
-- ---------------------------------------------------------------------------
begin;
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id from public.profiles
               where email = 'tim+zz-rep-a1@constructiveoperations.com'),
      'role','authenticated')::text, true);
  set local role authenticated;

  insert into public.comments (tenant_id, record_object, record_id, author_id, body)
  values ('a1W7y000007AszBEAS','solar','a1Q7y00000JWmkvEAD', auth.uid(),
          'A11 verification — must be refused')
  returning id;
rollback;

-- ---------------------------------------------------------------------------
-- V6 — **TIM ONLY**. THE MENTION REFUSAL, and the one that stops the email.
-- Staff (zz-exec) comment on a solar record — allowed — and try to mention a REP.
-- EXPECT: the comment INSERT succeeds (staff are unchanged), and the
--         comment_mentions INSERT raises 42501, because the mention policy asks
--         record_visible_for(MENTIONED USER, ...) and that is now false.
--
-- This is what guarantees sundial-comment-notify never emails a rep the body of a
-- solar comment they cannot open: the mention row cannot exist to trigger it.
-- ---------------------------------------------------------------------------
begin;
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id from public.profiles
               where email = 'tim+zz-exec@constructiveoperations.com'),
      'role','authenticated')::text, true);
  set local role authenticated;

  with c as (
    insert into public.comments (tenant_id, record_object, record_id, author_id, body)
    values ('a1W7y000007AszBEAS','solar','a1Q7y00000JWmkvEAD', auth.uid(),
            'A11 verification — staff comment, should SUCCEED')
    returning id
  )
  insert into public.comment_mentions (comment_id, mentioned_user_id)
  select c.id,
         (select id from public.profiles
           where email='tim+zz-rep-a1@constructiveoperations.com')
    from c
  returning comment_id;
rollback;

-- ---------------------------------------------------------------------------
-- V7 — **TIM ONLY**. CUSTOMER IS UNCHANGED, for the same rep. The control: if this
-- also refuses, the change went too far and reps have lost comments entirely.
-- EXPECT: the INSERT SUCCEEDS and returns an id (then rolls back).
-- ---------------------------------------------------------------------------
begin;
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id from public.profiles
               where email = 'tim+zz-rep-a1@constructiveoperations.com'),
      'role','authenticated')::text, true);
  set local role authenticated;

  insert into public.comments (tenant_id, record_object, record_id, author_id, body)
  values ('a1W7y000007AszBEAS','customer','a1P7y00000AmyXCEAZ', auth.uid(),
          'A11 verification — customer comment, should SUCCEED')
  returning id;
rollback;

-- ---------------------------------------------------------------------------
-- V8 — **TIM ONLY**. Staff on SOLAR are unchanged. The other control.
-- EXPECT: SUCCEEDS and returns an id.
-- ---------------------------------------------------------------------------
begin;
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id from public.profiles
               where email = 'tim+zz-exec@constructiveoperations.com'),
      'role','authenticated')::text, true);
  set local role authenticated;

  insert into public.comments (tenant_id, record_object, record_id, author_id, body)
  values ('a1W7y000007AszBEAS','solar','a1Q7y00000JWmkvEAD', auth.uid(),
          'A11 verification — staff on solar, should SUCCEED')
  returning id;
rollback;
