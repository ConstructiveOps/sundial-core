-- Sundial access model, PHASE 1b — row-level security for `comments` and
-- `comment_mentions`.
--
-- D-064 / docs/access-model.md §5.2–§5.3, amendment A5. Applies AFTER Phase 1
-- (`sql/sundial_access_p1_cache_columns.sql`, `..._cache_hardening.sql`,
-- `..._profiles_columns.sql`, `..._profiles_revoke.sql`) is live, because every
-- helper below reads the rep/dealer columns Phase 1 added to the cache tables.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR (project qfsdpkwxahakegjnyijj), as Tim.
-- It is in TWO PARTS with a hard stop between them — see RUN ORDER.
--
--
-- =============================================================================
-- WHAT CHANGES FOR A LIVE USER — the whole answer, measured 2026-08-27
-- =============================================================================
--
-- Every count below is a point-in-time measurement of a live table and DRIFTS as
-- people comment (it went 510 -> 511 during the hour this file was written). The
-- INVARIANTS do not drift, and V6 re-measures both sides rather than trusting these
-- numbers. Read "510" as "all of them".
--
-- ONE INTENDED CHANGE, for the one live restricted user:
--
--   Dennis Alessandro (azsolarexpert@live.com, Access_Level__c = Sales Rep)
--   reads ALL 510 tenant comments today, on records he cannot open in the portal,
--   none of them his own. After this file: 79 — the threads on the records where
--   he is the Sales_Rep__c. ALL 26 COMMENTS HE AUTHORED HIMSELF REMAIN VISIBLE
--   (checked: 26 of 26).
--
-- Plus THREE TEST ACCOUNTS correctly zeroed, which is a hole closing rather than
-- collateral:
--
--   bradtest@harmonelectric.net           all -> 0   Active__c = FALSE in Salesforce
--   tim+uatest@constructiveoperations.com all -> 0   Active__c = FALSE in Salesforce
--   tmurphy5213+inviteuser1@gmail.com     all -> 0   active Sales Rep, NULL Dealer__c
--
--   The first two are deactivated in Salesforce and STILL HAVE WORKING LOGINS —
--   they were reading every comment in the tenant this morning. §1.2's "a dealer
--   or own user with a null Dealer__c resolves to none" covers the third.
--   Follow-up in TASKS.md: ban bradtest/uatest through the deactivate path, and
--   deactivate-or-attribute inviteuser1. This file does not need that done first.
--
-- NOTHING CHANGES FOR ANYONE ELSE. All 23 tenant-scope users (Executive / Admin /
-- Manager) keep every comment, and all 14 of 14 existing mention rows stay readable by
-- the user they mention — every one of those eight recipients is tenant scope, so
-- the "For You" feed loses nothing. Verification query V6 re-measures both halves
-- against the live table and prints a per-user verdict; it is not a claim.
--
--
-- =============================================================================
-- RUN ORDER
-- =============================================================================
--
--   1. TIM   — run PART A below (one ALTER, one index). Tell Claude.
--   2. CLAUDE— `sundial-cache-sync {"object":"user","mode":"full"}`; populates
--              supabase_user_id on ~132 rows. Seconds. No Lambda change (why: §2).
--   3. TIM   — run PART B below (one BEGIN..COMMIT: helpers + policies).
--   4. TIM   — run the VERIFICATION queries, one at a time. V1–V9 run as anyone;
--              V10–V13 are marked TIM ONLY because they need `set role`, which the
--              read-only MCP user cannot do (it answers 42501).
--   5. CLAUDE— `node scripts/verify-comment-rls.mjs` as the ZZ TEST users.
--   6. TIM   — approve the sundial-comment-notify diff; then Claude deploys it.
--
-- PART A MUST PRECEDE PART B. A `language sql` function body is parsed and
-- validated at CREATE time, so `create function` in Part B fails outright if
-- `sundial_user_cache.supabase_user_id` does not exist yet. That ordering is a
-- hard dependency, not a preference.
--
-- Safe to re-run. Every statement is `if not exists` / `create or replace` /
-- `drop policy if exists` + `create policy`.
--
--
-- =============================================================================
-- 1. WHOSE SCOPE, AND FROM WHERE — the decision this file turns on
-- =============================================================================
--
-- RLS cannot call a Lambda, so `lib/access.js` cannot be asked at query time. The
-- scope has to be MATERIALIZED somewhere the database can read. §5.2 named one
-- place: `profiles.access_scope`, written by sundial-auth-proxy on every /auth/me.
--
-- THAT COLUMN IS NULL FOR 21 OF 35 PROFILES TODAY, and reading it alone with
-- "null denies" would have hidden every comment from 17 real Harmon staff —
-- including 11 of 14 Executives and 6 of 8 Managers, i.e. the people who actually
-- use comments — until each of them happened to log in again. Measured:
--
--   profile scope | cache-derived scope | users | who
--   --------------+---------------------+-------+---------------------------------
--   NULL          | tenant              |    17 | arnoldyazzie, benwollschlager,
--                 |                     |       | bradleyyant, brian, cameronlabonte,
--                 |                     |       | danking, davidcoleman, jake,
--                 |                     |       | johnheckert, julieking,
--                 |                     |       | lindsaymccormack, marjoriekopp,
--                 |                     |       | ralphromano, ryanking, tim,
--                 |                     |       | temppass1, troyjohnston
--   tenant        | tenant              |     6 | danielreese, geovannamacedo, matt + ZZ
--   NULL          | own                 |     1 | azsolarexpert  (Dennis)
--   none          | own                 |     1 | zz-rep-inactive-dealer
--   NULL          | none                |     3 | bradtest, uatest, inviteuser1
--   own/dealer/none (matching)          |     7 | the ZZ fixtures
--
-- §1.2's "null scope = deny" is right as a POLICY. It is wrong as a LOOKUP, because
-- the value has to come from somewhere that is true for everyone rather than only
-- for whoever logged in most recently.
--
-- THE RULE: TAKE THE NARROWER OF TWO SOURCES, IGNORING NULLS.
-- ----------------------------------------------------------
-- Ordering `none(0) < own(1) < dealer(2) < tenant(3)`, and the effective scope is
-- `least()` of whichever of these two has an opinion:
--
--   A. `profiles.access_scope` — computed by lib/access.js at that user's last
--      /auth/me. It is the SINGLE AUTHORITY (D-064 decision 3) and the only source
--      that knows `Sundial_Dealer__c.Active__c`. It can be stale, NULL, or absent.
--
--   B. `sundial_user_cache` — `access_level` + `dealer_sf_id` + `active`, synced
--      from Salesforce on the cache-sync schedule, INDEPENDENT OF LOGIN. Populated
--      for all 34 active users today. It cannot see dealer inactivity.
--
-- Neither is sufficient alone and `least()` is safe in both directions: a stale
-- profile cannot widen past a demotion Salesforce already knows about, and a cache
-- row cannot widen past a narrowing only lib/access.js can compute. The two rows
-- that would otherwise be wrong are exactly the two the rule fixes:
--
--   17 Harmon staff        profile NULL, cache tenant  ->  tenant   (they keep everything)
--   zz-rep-inactive-dealer profile none, cache own     ->  none     (Active__c wins)
--
-- FAIL CLOSED ON GENUINELY UNKNOWN USERS ONLY. `private.resolve_access()` returns
-- NO ROW — and every caller then answers false — when a uuid has NEITHER a
-- `profiles` row NOR a `sundial_user_cache` row. A staffer who was provisioned and
-- has never once logged in HAS a cache row (Salesforce made it), so they resolve
-- correctly and can be @-mentioned. That is the case §5.2 could not have handled,
-- and it is why Part A exists.
--
-- THE RESIDUAL, STATED PLAINLY
-- ----------------------------
-- Source B cannot see `Sundial_Dealer__c.Active__c`. There is no
-- `sundial_dealer_cache` and `sundial_user_cache` carries no dealer-active flag.
-- So a sales user whose dealer was deactivated AND who has no `profiles` row at all
-- is scoped by their access level rather than to `none`.
--
-- What that can actually cost: only whether they can be @-MENTIONED. Their own
-- reads resolve through the same function and `record_visible_for` still requires
-- the record to carry their rep or dealer id, so they never see a record that is
-- not attributed to them. It self-corrects at their first login, when
-- sundial-auth-proxy writes the authoritative `none` into `profiles` and source A
-- takes over. It affects ZERO users today. If it ever needs closing, the fix is a
-- `dealer_active` column on `sundial_user_cache` from a formula field on
-- `Sundial_User__c`, not more logic here.
--
--
-- =============================================================================
-- 2. WHY `supabase_user_id` ON THE USER CACHE, AND WHY NO LAMBDA CHANGES
-- =============================================================================
--
-- `sundial_user_cache`'s primary key is `sf_id` (the Sundial_User__c Id). Nothing
-- on it maps a SUPABASE AUTH UUID to a row, so the only route from `auth.uid()` —
-- or from `comment_mentions.mentioned_user_id`, which is an auth uuid — to a cache
-- row runs through `profiles.sundial_user_id`. That is precisely the row that may
-- not exist for a user who has never logged in.
--
-- `Sundial_User__c.Supabase_User_Id__c` is a TEXT field, and `sundial-user-admin`
-- writes it AT CREATE TIME (lambdas/sundial-user-admin/index.js:374), before the
-- invited user has ever signed in. So it is the right key, and it is already there.
--
-- No code changes because of how cache-sync derives its columns:
--   sfFieldToColumn()   (lambdas/sundial-cache-sync/index.js:172) — strip `__c`,
--                       lowercase, append `_sf_id` only for `reference` fields.
--                       `Supabase_User_Id__c` is text -> `supabase_user_id`.
--   buildCacheSelect()  (same file, :185) — SELECTs every describe field whose
--                       derived name is a column on the cache table, read live from
--                       the PostgREST OpenAPI spec.
-- Adding the column is therefore the entire change; the next full user sync fills
-- it. Same mechanism `sql/sundial_roofing_cache_name_columns.sql` relies on.
--
-- IT IS NOT HYPOTHETICAL. Applied and synced 2026-08-27: 34 of 34 active users got a
-- uuid, and exactly ONE of them — an active Executive, provisioned with a working
-- Supabase login, who has never once signed in — has NO `profiles` row. Under a
-- profiles-only lookup she would have been unmentionable and invisible to
-- `user_visible()` for as long as she never logged in. Through the `u_by_uuid`
-- branch she resolves to `tenant`, from the cache alone (verified: rank_a NULL,
-- rank_b 3). One live user is the whole population of this case today, and would
-- have been a silent, permanent bug.
--
-- IS PUTTING AUTH UUIDs IN A CACHE TABLE A LEAK? No. Phase 1's A4 revoke removed
-- ALL privileges on every `sundial_*_cache` table from `anon` and `authenticated`,
-- so no browser session can read this column at all — and the value is not secret
-- in any case: `GET /sf/users` already returns `supabaseUserId` to every logged-in
-- user, because CommentThread.tsx needs it to key a mention.
--
--
-- =============================================================================
-- 3. THREE PLACES THIS FILE DELIBERATELY DIVERGES FROM §5.2/§5.3
-- =============================================================================
--
-- (a) THE `tenant` BRANCH DOES NOT CONSULT THE CACHE.
--     §5.2's pseudocode writes all three branches as `exists(select 1 from <cache>
--     …)`, tenant included. Applied literally that hides comments on any record
--     missing from the cache FROM EVERYONE, ADMINS INCLUDED — and 18 commented
--     records are missing right now:
--
--       solar     187 records commented, 15 absent from sundial_solar_cache    -> 25 comments
--       customer   29 records commented,  3 absent from sundial_customer_cache ->  3 comments
--
--     All 28 comments date from July 2026; the records were almost certainly
--     deleted in Salesforce and swept by the cache reconcile. §5.2's own PROSE one
--     paragraph later says "a record absent from the cache is invisible TO SALES
--     SCOPES" — the prose is right and the pseudocode was stricter than it meant.
--     So: `tenant` returns TRUE unconditionally. The policy's own
--     `tenant_id = current_user_tenant()` is the whole control for staff, which is
--     exactly what §3.1's "tenant | all" row says. A side benefit: a module that
--     ships later cannot silently hide its comments from staff by not being in the
--     object map below.
--
-- (b) THE `comment_mentions` SELECT POLICY HAS NO "OR AUTHOR IS ME" BRANCH.
--     §5.3 offers it as "own outgoing, IF THE UI NEEDS IT". It does not:
--     MentionsFeed.tsx queries `.eq('mentioned_user_id', myId)` and nothing else,
--     and CommentThread.tsx inserts mention rows WITHOUT `.select()`, so no
--     read-back is required. D-064's Phase 1 outcome block: "a wide grant is the
--     default and a narrow one is the exception". A permissive branch nothing calls
--     is a permissive branch.
--
-- (c) THERE IS NO `comment_mentions` UPDATE POLICY, AND THIS IS THE POINT.
--     §5.3 sketches `update : mentioned_user_id = auth.uid() (read/ack columns
--     only)`. There is no read/ack column — the only nullable column is
--     `notified_at`, which sundial-comment-notify stamps through the service role
--     AFTER a successful send, as its idempotency marker.
--
--     `anon` and `authenticated` hold `arwdDxtm` on `comment_mentions` — the full
--     privilege set, UPDATE included (Phase 1 revoked the cache tables and
--     `profiles`, and deliberately left `comments`/`comment_mentions`/
--     `user_preferences`, whose write grants the browser actually uses). With no
--     UPDATE POLICY that grant is inert. ADD ONE AND IT STOPS BEING INERT: a user
--     could set `notified_at` on their own pending mention and suppress their own
--     alert email, and the send path would report a clean skip. The absence is the
--     control. Do not "complete" the policy set here.
--
-- The DELETE policy keeps its existing `and tenant_id = current_user_tenant()`
-- clause, which §5.3's shorthand drops. Keeping it is strictly narrower and leaves
-- today's delete behaviour byte-identical; there was no reason to widen anything in
-- a file whose job is to narrow.
--
--
-- =============================================================================
-- 4. WHAT AN ANON SESSION SEES — unchanged, and worth stating
-- =============================================================================
-- Every policy here applies to role `{public}`, so `anon` is in scope for all of
-- them, exactly as the Phase 0 snapshot found. For anon, `auth.uid()` is NULL:
-- `private.resolve_access(NULL)` matches no profile and no cache row, returns no
-- row, and every helper answers false. `current_user_tenant()` returns NULL and the
-- tenant comparison is NULL, not TRUE. Denied on every path, as today.


-- #############################################################################
-- ##  PART A — the user-cache key. RUN THIS FIRST, THEN TELL CLAUDE.         ##
-- #############################################################################

alter table public.sundial_user_cache
  add column if not exists supabase_user_id text;   -- Supabase_User_Id__c (text)

comment on column public.sundial_user_cache.supabase_user_id is
  'Supabase auth.users uuid, mirrored from Sundial_User__c.Supabase_User_Id__c by '
  'sundial-cache-sync. Written by sundial-user-admin at user-CREATE time, so it is '
  'populated before a user has ever logged in — which is what lets Phase 1b resolve '
  'a mentioned user who has no public.profiles row yet. See D-064 / access-model.md 5.2.';

create index if not exists idx_user_cache_supabase_user
  on public.sundial_user_cache (supabase_user_id);

-- ---------------------------------------------------------------------------
-- STOP. Tell Claude, who runs:  sundial-cache-sync {"object":"user","mode":"full"}
-- Then confirm with V5 below before running Part B. Part B is CORRECT without the
-- sync (every mentionable user has a profiles row today, so source A covers them);
-- the sync is what makes it stay correct for the next person hired.
-- ---------------------------------------------------------------------------


-- #############################################################################
-- ##  PART B — helpers and policies. ONE TRANSACTION.                        ##
-- #############################################################################
--
-- The drops and the creates are in the same transaction ON PURPOSE: there must
-- never be an instant in which the old tenant-only SELECT policy and a new one are
-- both present, because RLS policies are OR-ed and two permissive paths means the
-- wider one wins for as long as the window lasts.

begin;

-- ---------------------------------------------------------------------------
-- private.resolve_access(uuid) — the one place the narrower-of-two rule lives.
-- ---------------------------------------------------------------------------
-- Lives in `private` (no PostgREST route, and neither `anon`, `authenticated` nor
-- `service_role` holds USAGE on the schema — verified in the Phase 0 snapshot,
-- block 6b). The public helpers reach it through their OWNER, `postgres`, not
-- through the calling role, exactly as notify_comment_mention() reaches
-- private.app_config.
--
-- Returns AT MOST ONE ROW, and NO ROW for a uuid neither source knows. Every
-- caller wraps it in `coalesce(..., false)`, so "no row" is a deny and not a NULL
-- leaking into a policy expression.
create or replace function private.resolve_access(p_uid uuid)
returns table (
  tenant_id       text,   -- Sundial_Tenant__c record id (profiles' vocabulary,
                          -- == the cache tables' client_sf_id, NOT their tenant_id slug)
  scope           text,   -- tenant | dealer | own | none
  sundial_user_id text,   -- Sundial_User__c Id — the `own` row filter's right-hand side
  dealer_sf_id    text,   -- Sundial_Dealer__c Id — the `dealer` filter's
  access_level    text    -- Access_Level__c verbatim, for diagnostics
)
language sql
stable
security definer
set search_path = private, public, pg_catalog
as $$
  with p as (
    -- SOURCE A. Server-owned, written only by sundial-auth-proxy's service-role
    -- upsert on /auth/me. May be absent (never logged in) or carry a NULL
    -- access_scope (last logged in before the Phase 1 deploy).
    select pr.tenant_id, pr.sundial_user_id, pr.dealer_sf_id, pr.access_scope
      from public.profiles pr
     where pr.id = p_uid
     limit 1
  ),
  u_by_profile as (
    -- SOURCE B, preferred join: through the profile's Sundial_User__c id.
    select uc.* from public.sundial_user_cache uc
     where uc.sf_id = (select sundial_user_id from p)
     limit 1
  ),
  u_by_uuid as (
    -- SOURCE B, fallback join: straight from the auth uuid. This is the branch
    -- that answers "can this never-logged-in staffer be mentioned", and the only
    -- reason Part A exists. Only consulted when the profile join found nothing.
    select uc.* from public.sundial_user_cache uc
     where not exists (select 1 from u_by_profile)
       and uc.supabase_user_id = p_uid::text
     limit 1
  ),
  u as (
    select * from u_by_profile
    union all
    select * from u_by_uuid
  ),
  ranked as (
    select
      -- Source A's opinion, or NULL for "no opinion". An unrecognised string is
      -- NULL rather than 0 so a typo cannot silently deny someone; source B still
      -- decides, and V6 would show it.
      (select case pr.access_scope
                when 'tenant' then 3
                when 'dealer' then 2
                when 'own'    then 1
                when 'none'   then 0
                else null
              end
         from p pr) as rank_a,
      -- Source B's opinion. This is §1.2's scope table, and the ONLY duplication of
      -- lib/access.js in SQL. Deliberately conservative at every edge: inactive ->
      -- none, null dealer -> none, unknown level -> none. It can never be wider
      -- than lib/access.js, only narrower, which is why least() below is safe.
      (select case
                when uu.active is not true then 0
                when uu.access_level in ('Executive','Admin','Manager') then 3
                when uu.access_level = 'Sales Dealer' and uu.dealer_sf_id is not null then 2
                when uu.access_level = 'Sales Rep'    and uu.dealer_sf_id is not null then 1
                else 0
              end
         from u uu) as rank_b
  )
  select
    coalesce((select p.tenant_id from p), (select uu.client_sf_id from u uu)),
    case least(coalesce(r.rank_a, 99), coalesce(r.rank_b, 99))
      when 3 then 'tenant'
      when 2 then 'dealer'
      when 1 then 'own'
      else        'none'
    end,
    coalesce((select p.sundial_user_id from p), (select uu.sf_id from u uu)),
    -- Cache first: Salesforce is where Dealer__c actually lives, and the cache row
    -- was stamped from the same field the deals' dealer_sf_id was stamped from.
    coalesce((select uu.dealer_sf_id from u uu), (select p.dealer_sf_id from p)),
    (select uu.access_level from u uu)
  from ranked r
  -- NO ROW when neither source has an opinion. This is the fail-closed boundary,
  -- and it is the ONLY one: not "has not logged in", not "profile is stale".
  where r.rank_a is not null or r.rank_b is not null;
$$;

-- ---------------------------------------------------------------------------
-- public.current_profile() — §5.2. The resolved scope of the CURRENT session.
-- ---------------------------------------------------------------------------
-- Returns only the caller's own resolution, so it is safe to expose; it exists
-- because debugging an RLS deny without it means guessing.
create or replace function public.current_profile()
returns table (
  tenant_id       text,
  access_scope    text,
  sundial_user_id text,
  dealer_sf_id    text
)
language sql
stable
security definer
set search_path = private, public, pg_catalog
as $$
  select r.tenant_id, r.scope, r.sundial_user_id, r.dealer_sf_id
    from private.resolve_access(auth.uid()) r;
$$;

-- ---------------------------------------------------------------------------
-- public.record_visible_for(uuid, text, text) — §5.2. Can THAT user see THAT record?
-- ---------------------------------------------------------------------------
-- The whole row-visibility rule, for any user, in one function. record_visible()
-- below is this function applied to auth.uid(); there is no second implementation
-- to drift.
--
-- Reads the cache tables, which are RLS-denied AND grant-revoked to `anon` and
-- `authenticated` since Phase 1 (A4). SECURITY DEFINER is what lets this function
-- read them on a browser session's behalf without giving the browser the table.
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
      -- TENANT: no cache lookup, no module gate. See divergence (a) in the header —
      -- 28 live comments sit on 18 records the cache no longer holds, and staff must
      -- keep reading them. The caller's policy has already matched tenant_id.
      when a.scope = 'tenant' then true

      when p_id is null or p_id = '' then false

      -- DEALER: customer + solar only. Roofing, Commercial, Service, PO and every
      -- unknown object deny — the §3.1 module gate, in SQL.
      when a.scope = 'dealer' then
        case lower(coalesce(p_object, ''))
          when 'customer' then exists (
            select 1 from public.sundial_customer_cache c
             where c.sf_id = p_id
               and c.client_sf_id = a.tenant_id
               and a.dealer_sf_id is not null
               and c.dealer_sf_id = a.dealer_sf_id)
          when 'solar' then exists (
            select 1 from public.sundial_solar_cache c
             where c.sf_id = p_id
               and c.client_sf_id = a.tenant_id
               and a.dealer_sf_id is not null
               and c.dealer_sf_id = a.dealer_sf_id)
          else false
        end

      -- OWN: same two objects, filtered on the rep instead of the dealer.
      when a.scope = 'own' then
        case lower(coalesce(p_object, ''))
          when 'customer' then exists (
            select 1 from public.sundial_customer_cache c
             where c.sf_id = p_id
               and c.client_sf_id = a.tenant_id
               and a.sundial_user_id is not null
               and c.sales_rep_sf_id = a.sundial_user_id)
          when 'solar' then exists (
            select 1 from public.sundial_solar_cache c
             where c.sf_id = p_id
               and c.client_sf_id = a.tenant_id
               and a.sundial_user_id is not null
               and c.sales_rep_sf_id = a.sundial_user_id)
          else false
        end

      -- scope 'none'.
      else false
    end
    from private.resolve_access(p_profile_id) a
  ), false);   -- no row from resolve_access (unknown user) -> false, never NULL
$$;

-- ---------------------------------------------------------------------------
-- public.record_visible(text, text) — §5.2. The current session's own visibility.
-- ---------------------------------------------------------------------------
create or replace function public.record_visible(p_object text, p_id text)
returns boolean
language sql
stable
security definer
set search_path = private, public, pg_catalog
as $$
  select public.record_visible_for(auth.uid(), p_object, p_id);
$$;

-- ---------------------------------------------------------------------------
-- public.user_visible(uuid) — §3.5/§5.2. Can I even see this person exists?
-- ---------------------------------------------------------------------------
-- The §3.5 predicate: tenant scope sees everyone in the tenant; a dealer or own
-- user sees their own dealer's people PLUS Harmon staff, and NEVER another
-- dealer's reps. Materialized here so the mentions picker and the Lambda agree.
--
-- A deactivated user resolves to scope `none` in resolve_access, so they are
-- neither "tenant-wide staff" nor dealer-matched, and cannot be mentioned. That
-- falls out of the derivation rather than needing its own clause.
create or replace function public.user_visible(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = private, public, pg_catalog
as $$
  select coalesce((
    select case
      when me.scope = 'none' then false
      when me.tenant_id is null or them.tenant_id is null then false
      when me.tenant_id <> them.tenant_id then false       -- cross-tenant, never
      when me.scope = 'tenant' then true                   -- staff see everyone
      when them.scope = 'tenant' then true                 -- everyone sees staff
      when me.dealer_sf_id is not null
       and me.dealer_sf_id = them.dealer_sf_id then true    -- same dealer
      else false
    end
    from private.resolve_access(auth.uid())   me,
         private.resolve_access(p_profile_id) them
  ), false);   -- either side unknown -> the cross join is empty -> false
$$;

-- ---------------------------------------------------------------------------
-- EXECUTE grants. "Ask what the grant is, THEN ask what the policy is."
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC on every new function by default, which for a
-- SECURITY DEFINER function that reads revoked cache tables is the same shape of
-- accident A4 found on the cache tables themselves. Revoke, then grant narrowly.
--
-- `authenticated` genuinely needs EXECUTE: an RLS policy expression runs as the
-- INVOKING role, so a browser session that cannot execute record_visible() cannot
-- read its own comments. `anon` needs nothing — it resolves to no row anyway, but
-- there is no reason to let it ask.
revoke all on function private.resolve_access(uuid)                  from public;
revoke all on function public.current_profile()                      from public;
revoke all on function public.record_visible(text, text)             from public;
revoke all on function public.record_visible_for(uuid, text, text)   from public;
revoke all on function public.user_visible(uuid)                     from public;

grant execute on function public.current_profile()                    to authenticated, service_role;
grant execute on function public.record_visible(text, text)           to authenticated, service_role;
grant execute on function public.record_visible_for(uuid, text, text) to authenticated, service_role;
grant execute on function public.user_visible(uuid)                   to authenticated, service_role;

-- sundial-comment-notify calls record_visible_for through the service role (the
-- §3.7 re-check). private.resolve_access stays owner-only — nothing outside these
-- four functions has any business calling it.

-- ---------------------------------------------------------------------------
-- Indexes the new predicates need.
-- ---------------------------------------------------------------------------
-- The Phase 0 snapshot flagged the first one: `comments` has NO index on the exact
-- tuple every thread read filters on. Free at 510 rows and not free later, and the
-- new SELECT policy evaluates record_visible() per surviving row.
create index if not exists idx_comments_tenant_record
  on public.comments (tenant_id, record_object, record_id);

-- The mentions feed's only filter, and now its whole SELECT policy.
create index if not exists idx_comment_mentions_user
  on public.comment_mentions (mentioned_user_id);

-- ---------------------------------------------------------------------------
-- POLICIES — public.comments
-- ---------------------------------------------------------------------------
-- Old (dropped): select/insert/delete keyed on tenant_id alone. That is the leak
-- A5 exists to close: tenant match is true for every user in Harmon, so every user
-- read every comment in Harmon.
drop policy if exists comments_select_own_tenant on public.comments;
drop policy if exists comments_insert_own_tenant on public.comments;
drop policy if exists comments_delete_own        on public.comments;
-- Idempotency: drop the new names too, so re-running this file converges rather
-- than erroring on a duplicate (the sundial_user_preferences.sql convention).
drop policy if exists comments_select_visible    on public.comments;
drop policy if exists comments_insert_visible    on public.comments;

-- SELECT: still in my tenant, AND on a record I can actually open.
create policy comments_select_visible
  on public.comments for select
  using (
    tenant_id = public.current_user_tenant()
    and public.record_visible(record_object, record_id)
  );

-- INSERT: same visibility test, and the author must be me. The tenant_id
-- comparison is what FORCES the tenant — an insert naming any other tenant is
-- rejected, so the client's `tenantIdFromProfile()` cannot be talked into forging
-- one. Note CommentThread.tsx does `.insert(...).select().single()`, so the SELECT
-- policy above must also pass on the new row; it does, by construction.
create policy comments_insert_visible
  on public.comments for insert
  with check (
    tenant_id = public.current_user_tenant()
    and author_id = auth.uid()
    and public.record_visible(record_object, record_id)
  );

-- DELETE: your own comment. Unchanged from today, tenant clause and all — see
-- divergence note in the header. Deliberately NOT gated on record_visible: a rep
-- whose record was reassigned can still tidy up their own words, and they cannot
-- reach anyone else's row to try.
create policy comments_delete_own
  on public.comments for delete
  using (
    author_id = auth.uid()
    and tenant_id = public.current_user_tenant()
  );

-- NO UPDATE POLICY, as today. `authenticated` holds UPDATE on this table; with no
-- policy it is inert. An update policy would let an author rewrite a comment's
-- record_id and move it onto a record they can see. Do not add one.

-- ---------------------------------------------------------------------------
-- POLICIES — public.comment_mentions
-- ---------------------------------------------------------------------------
drop policy if exists mentions_select_visible_comment on public.comment_mentions;
drop policy if exists mentions_insert_own_tenant      on public.comment_mentions;
drop policy if exists mentions_select_own             on public.comment_mentions;
drop policy if exists mentions_insert_scoped          on public.comment_mentions;

-- SELECT: mentions OF me. Nothing else — see divergence (b). This alone takes a
-- Sales Rep from 14 mention rows (none of them theirs) to their own.
create policy mentions_select_own
  on public.comment_mentions for select
  using (mentioned_user_id = auth.uid());

-- INSERT: five conditions, and the last is the one that matters.
--
--   1. the comment exists, 2. I wrote it, 3. it is in my tenant — all via the
--      subquery, which is ITSELF filtered by comments_select_visible above (RLS
--      applies inside a policy's subquery), so I must be able to SEE the comment
--      I am attaching a mention to;
--   4. user_visible(mentioned)          — I cannot mention another dealer's rep;
--   5. record_visible_for(mentioned, …) — NOBODY can mention ANYONE onto a record
--      that person cannot see. This is the clause that keeps the notification email
--      inside its scope: sundial-comment-notify mails the comment BODY, so a
--      mention is a data-export primitive and has to be scoped like one.
create policy mentions_insert_scoped
  on public.comment_mentions for insert
  with check (
    exists (
      select 1
        from public.comments c
       where c.id = comment_mentions.comment_id
         and c.author_id = auth.uid()
         and c.tenant_id = public.current_user_tenant()
         and public.record_visible_for(
               comment_mentions.mentioned_user_id, c.record_object, c.record_id)
    )
    and public.user_visible(comment_mentions.mentioned_user_id)
  );

-- NO UPDATE POLICY and NO DELETE POLICY — see divergence (c). Deleting a comment
-- still removes its mentions, through the ON DELETE CASCADE on
-- comment_mentions_comment_id_fkey; referential actions run as the constraint
-- owner and are not subject to RLS, so no delete policy is needed for that path.

commit;


-- #############################################################################
-- ##  VERIFICATION — run these ONE AT A TIME, after Part B commits.          ##
-- #############################################################################
--
-- READ THIS BEFORE TRUSTING ANY RESULT BELOW.
--
-- V1–V9 run as `postgres` or through the service role, BOTH OF WHICH BYPASS RLS.
-- They verify THE HELPER FUNCTIONS AND THE CATALOG — that the right functions
-- exist with the right properties, that the grants are narrow, and that the
-- visibility ARITHMETIC produces the intended per-user numbers. They do NOT prove
-- the policies are attached or effective, because nothing they run is subject to
-- a policy.
--
-- V10–V13 are the ones that prove the POLICIES, by impersonating a real session
-- (`set local role authenticated` + `request.jwt.claims`). They are marked
-- **TIM ONLY**: the read-only MCP role Claude uses answers
-- `ERROR: 42501: permission denied to set role "authenticated"`, so Claude
-- cannot run them and must not claim to have. Claude's equivalent is step 5,
-- `scripts/verify-comment-rls.mjs`, which logs in as the ZZ TEST users for real.
--
-- Counts below are live and drift as people comment. Where a count could drift,
-- the query computes BOTH sides and prints a verdict instead of asserting a
-- number, so it stays a test rather than becoming a stale claim.


-- ---------------------------------------------------------------------------
-- V1 — the five functions exist, and every one has the D-056 safety properties.
-- EXPECT: exactly 5 rows. Every row: security_definer = true, volatility = 's',
--         search_path_pinned = true, owner = postgres. A false anywhere is a stop.
-- ---------------------------------------------------------------------------
select n.nspname                                        as schema,
       p.proname                                        as function,
       pg_get_function_identity_arguments(p.oid)        as args,
       p.prosecdef                                      as security_definer,
       p.provolatile                                    as volatility,   -- 's' = stable
       (p.proconfig is not null
        and exists (select 1 from unnest(p.proconfig) c
                     where c like 'search\_path=%'))    as search_path_pinned,
       pg_get_userbyid(p.proowner)                      as owner
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname, p.proname) in (
         ('private','resolve_access'), ('public','current_profile'),
         ('public','record_visible'),  ('public','record_visible_for'),
         ('public','user_visible'))
 order by 1, 2;


-- ---------------------------------------------------------------------------
-- V2 — EXECUTE grants are narrow. This is the D-064 "ask what the grant is" check.
-- EXPECT: the four public helpers -> anon FALSE, authenticated TRUE, service_role TRUE.
--         private.resolve_access                -> all three FALSE.
-- ---------------------------------------------------------------------------
select n.nspname || '.' || p.proname                                as function,
       has_function_privilege('anon',          p.oid, 'EXECUTE')    as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE')    as auth_exec,
       has_function_privilege('service_role',  p.oid, 'EXECUTE')    as svc_exec
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname, p.proname) in (
         ('private','resolve_access'), ('public','current_profile'),
         ('public','record_visible'),  ('public','record_visible_for'),
         ('public','user_visible'))
 order by 1;


-- ---------------------------------------------------------------------------
-- V3 — the policy set is exactly what this file intends, and the old names are gone.
-- EXPECT: exactly 5 rows —
--   comment_mentions | mentions_insert_scoped   | INSERT | qual NULL, check set
--   comment_mentions | mentions_select_own      | SELECT | qual = mentioned_user_id = auth.uid()
--   comments         | comments_delete_own      | DELETE
--   comments         | comments_insert_visible  | INSERT
--   comments         | comments_select_visible  | SELECT | qual names record_visible
-- NO row named comments_select_own_tenant, comments_insert_own_tenant,
-- mentions_select_visible_comment or mentions_insert_own_tenant. No UPDATE row on
-- either table.
-- ---------------------------------------------------------------------------
select tablename, policyname, cmd, permissive, roles, qual, with_check
  from pg_policies
 where schemaname = 'public'
   and tablename in ('comments','comment_mentions')
 order by tablename, policyname;


-- ---------------------------------------------------------------------------
-- V4 — table grants, asked the way that actually works.
-- DO NOT use information_schema.role_table_grants here: it is MEMBER-FILTERED and
-- returns zero rows whether or not anything is granted (Phase 0 snapshot block 6).
-- EXPECT: comments + comment_mentions still TRUE across the board — Phase 1
--         deliberately left these grants, and the policies are the control. The
--         six cache tables + profiles must still be FALSE for anon/authenticated,
--         i.e. Phase 1's revokes are intact and this file did not disturb them.
-- ---------------------------------------------------------------------------
select c.relname                                              as "table",
       has_table_privilege('anon',          c.oid, 'SELECT')  as anon_sel,
       has_table_privilege('authenticated', c.oid, 'SELECT')  as auth_sel,
       has_table_privilege('authenticated', c.oid, 'UPDATE')  as auth_upd,
       has_table_privilege('service_role',  c.oid, 'SELECT')  as svc_sel
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('comments','comment_mentions','profiles','user_preferences',
                     'sundial_customer_cache','sundial_solar_cache',
                     'sundial_roofing_cache','sundial_user_cache',
                     'sundial_po_cache','sundial_po_credit_cache')
 order by 1;


-- ---------------------------------------------------------------------------
-- V5 — Part A landed and the sync ran. RUN THIS BETWEEN PART A AND PART B.
-- EXPECT: active_users 34 (or current), with_supabase_uuid EQUAL to it,
--         matched_to_a_profile 33–34, orphan_profiles 0.
-- If with_supabase_uuid is 0, the cache-sync in step 2 has not run — Part B is
-- still safe to run, but the never-logged-in mention path is not live until it does.
-- ---------------------------------------------------------------------------
select count(*) filter (where active)                                      as active_users,
       count(*) filter (where active and supabase_user_id is not null)     as with_supabase_uuid,
       count(*) filter (where active and supabase_user_id is not null
                          and exists (select 1 from public.profiles p
                                       where p.id::text = u.supabase_user_id)) as matched_to_a_profile,
       (select count(*) from public.profiles p
         where not exists (select 1 from public.sundial_user_cache uc
                            where uc.sf_id = p.sundial_user_id))            as orphan_profiles
  from public.sundial_user_cache u;


-- ---------------------------------------------------------------------------
-- V6 — THE ONE THAT MATTERS. Per-user comment visibility, before vs after, using
-- the REAL record_visible_for(). Self-checking: it recomputes both sides live.
-- EXPECT, by SCOPE rather than by a count that drifts (measured 2026-08-27, when
-- the tenant held 511 comments):
--   * 23 rows  scope=tenant  verdict 'unchanged'   before = after, whatever the total is
--   * 1  row   scope=own     azsolarexpert@live.com  511 -> 79   'NARROWED'
--   * 6  rows  scope=none    -> 0  'NARROWED'   — bradtest, uatest, inviteuser1,
--              and the three ZZ fixtures (tech, rep-nodealer, rep-inactive-dealer)
--   * 4  rows  scope=own     the ZZ reps -> 0 until the test script seeds comments
--   * 1  row   scope=dealer  zz-mgr-a    -> 0 likewise
-- ANY row with verdict = 'WIDENED' is a stop-everything result. There must be none.
-- ---------------------------------------------------------------------------
select p.email,
       (select r.scope from private.resolve_access(p.id) r)                as scope,
       (select count(*) from public.comments c
         where c.tenant_id = p.tenant_id)                                  as before_visible,
       (select count(*) from public.comments c
         where c.tenant_id = p.tenant_id
           and public.record_visible_for(p.id, c.record_object, c.record_id)) as after_visible,
       case
         when (select count(*) from public.comments c
                where c.tenant_id = p.tenant_id
                  and public.record_visible_for(p.id, c.record_object, c.record_id))
            > (select count(*) from public.comments c where c.tenant_id = p.tenant_id)
              then 'WIDENED  <-- STOP'
         when (select count(*) from public.comments c
                where c.tenant_id = p.tenant_id
                  and public.record_visible_for(p.id, c.record_object, c.record_id))
            = (select count(*) from public.comments c where c.tenant_id = p.tenant_id)
              then 'unchanged'
         else 'NARROWED'
       end                                                                 as verdict
  from public.profiles p
 order by verdict, after_visible desc, p.email;


-- ---------------------------------------------------------------------------
-- V7 — Dennis keeps every comment he wrote. EXPECT: authored = still_visible on
-- every row (26 = 26 for azsolarexpert@live.com).
-- Losing sight of your own words is the failure mode a scope narrowing produces
-- most easily and apologises for least well.
-- ---------------------------------------------------------------------------
select p.email,
       count(*)                                                          as authored,
       count(*) filter (where public.record_visible_for(
                                p.id, c.record_object, c.record_id))      as still_visible
  from public.profiles p
  join public.comments c on c.author_id = p.id
 group by p.email
 order by authored desc;


-- ---------------------------------------------------------------------------
-- V8 — the mentions feed loses nothing. EXPECT: mentions = still_readable on every
-- row, 14 of 14 in total as of 2026-08-27.
-- A mention row stays visible to its recipient under mentions_select_own, but
-- MentionsFeed.tsx renders it through an EMBEDDED JOIN to comments — so a mention
-- whose comment is no longer readable silently vanishes from the feed. This is the
-- query that would catch that.
-- ---------------------------------------------------------------------------
select p.email,
       count(*)                                                          as mentions,
       count(*) filter (where public.record_visible_for(
                                p.id, c.record_object, c.record_id))      as still_readable
  from public.comment_mentions m
  join public.comments  c on c.id = m.comment_id
  join public.profiles  p on p.id = m.mentioned_user_id
 group by p.email
 order by mentions desc;


-- ---------------------------------------------------------------------------
-- V9 — the ZZ fixture matrix, straight out of the helpers. §9's expected-outcome
-- table, asked of the database.
-- Dealer A = a1X7y00001ASRILEA5 · Dealer B = a1X7y00001ARRAkEAP ·
-- Harmon Solar = a1X7y00001ASQpJEAX.
-- EXPECT:
--   viewer                 scope  | a1_cust a2_cust b1_cust a1_solar roofing bogus_object bogus_record
--   zz-admin               tenant |   t       t       t       t        t        t            t
--   zz-exec                tenant |   t       t       t       t        t        t            t
--   zz-mgr-a               dealer |   t       t       f       t        f        f            f
--   zz-rep-a1              own    |   t       f       f       t        f        f            f
--   zz-rep-a2              own    |   f       t       f       f        f        f            f
--   zz-rep-b1              own    |   f       f       t       f        f        f            f
--   zz-rep-harmon          own    |   f       f       f       f        f        f            f
--   zz-rep-nodealer        none   |   f       f       f       f        f        f            f
--   zz-rep-inactive-dealer none   |   f       f       f       f        f        f            f
--   zz-tech                none   |   f       f       f       f        f        f            f
--
-- The rows carrying the most weight: zz-rep-a1 x b1_cust = FALSE is cross-dealer
-- denial; zz-rep-inactive-dealer = none is the narrower-of-two rule doing the one
-- thing only source A can do; the two `bogus_*` columns are the module gate and the
-- absent-record deny, and they are TRUE for tenant scope by design (divergence (a)).
-- ---------------------------------------------------------------------------
with viewer as (
  select p.id, split_part(p.email,'@',1) as who
    from public.profiles p
   where p.email like 'tim+zz-%@constructiveoperations.com'
)
select v.who,
       (select r.scope from private.resolve_access(v.id) r)                       as scope,
       public.record_visible_for(v.id,'customer','a1P7y00000AmyXCEAZ')            as a1_cust,
       public.record_visible_for(v.id,'customer','a1P7y00000ApR0PEAV')            as a2_cust,
       public.record_visible_for(v.id,'customer','a1P7y00000ApR21EAF')            as b1_cust,
       public.record_visible_for(v.id,'solar',   'a1Q7y00000JWmkvEAD')            as a1_solar,
       public.record_visible_for(v.id,'roofing', 'a1R7y00000yBU9DEAW')            as roofing,
       public.record_visible_for(v.id,'po',      'a1P7y00000AmyXCEAZ')            as bogus_object,
       public.record_visible_for(v.id,'customer','a1P000000000000AAA')            as bogus_record
  from viewer v
 order by v.who;


-- ---------------------------------------------------------------------------
-- V9b — the target half of user_visible(). user_visible() reads auth.uid() for the
-- VIEWER, so the viewer half cannot be driven from here — that is V12 and the ZZ
-- test script. This shows what each ZZ user looks like AS A MENTION TARGET.
-- EXPECT: zz-admin/zz-exec target_scope = tenant (mentionable by everyone);
--         zz-rep-a1/a2 + zz-mgr-a share Dealer A; zz-rep-b1 is Dealer B (which is
--         why zz-rep-a1 -> zz-rep-b1 must fail); zz-rep-nodealer, zz-tech and
--         zz-rep-inactive-dealer are `none` and mentionable by nobody.
-- ---------------------------------------------------------------------------
select split_part(p.email,'@',1)                                   as target,
       (select r.scope        from private.resolve_access(p.id) r) as target_scope,
       (select r.dealer_sf_id from private.resolve_access(p.id) r) as target_dealer,
       (select r.access_level from private.resolve_access(p.id) r) as target_level
  from public.profiles p
 where p.email like 'tim+zz-%@constructiveoperations.com'
 order by 1;


-- ---------------------------------------------------------------------------
-- ⚠️ V10–V12: SET THE CLAIMS BEFORE SWITCHING ROLE, NEVER AFTER.
--
-- The first draft of these blocks did `set local role authenticated` FIRST and then
-- resolved the test user's uuid with `(select id from public.profiles where email
-- = ...)`. That subquery then runs AS `authenticated`, where `own_profile_select`
-- (`auth.uid() = id`) hides every row — and `auth.uid()` is still NULL at that
-- point, so it hides ALL of them. The subquery returns NULL, the claims carry a
-- NULL `sub`, and every subsequent count is measured for a session that is nobody.
--
-- V10 THEN RETURNS `uid null / 0 / 0` AND LOOKS LIKE A PASS. That is the danger: a
-- zero is exactly what a correctly-scoped rep with no seeded comments also returns,
-- so the broken query and the working one are indistinguishable by their output.
-- Caught by Tim on 2026-08-27, running Part B's verification for real.
--
-- The fix below is an ordering swap only: `set_config` runs as `postgres` (RLS
-- bypassed, the profile is visible), and `set local role` comes after. Both are
-- transaction-local and switching role does not reset a GUC, so the claims survive.
-- ALWAYS ASSERT THE `uid` COLUMN IS NON-NULL BEFORE BELIEVING ANY COUNT BESIDE IT.
--
-- V10 — **TIM ONLY** (needs `set role`). THE POLICY, not the arithmetic.
-- Impersonates zz-rep-a1's real session. Read-only, wrapped in a rollback.
-- EXPECT: uid = zz-rep-a1's uuid; comments_visible = only their own records'
--         threads (0 until the ZZ test script seeds some, 1+ after);
--         mentions_visible = mentions OF zz-rep-a1 only (0 today).
-- The last statement MUST raise 42501 on sundial_customer_cache. If it returns a
-- count instead, STOP: Phase 1's A4 revoke has been undone, and the helpers above
-- are reading a table the browser can read too.
-- ---------------------------------------------------------------------------
begin;
  -- ORDER IS LOAD-BEARING: resolve the uuid and set the claims FIRST, as postgres,
  -- then switch role. See the warning above V10.
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id from public.profiles
               where email = 'tim+zz-rep-a1@constructiveoperations.com'),
      'role','authenticated')::text, true);
  set local role authenticated;

  select auth.uid()                                       as uid,
         (select count(*) from public.comments)           as comments_visible,
         (select count(*) from public.comment_mentions)   as mentions_visible;

  select count(*) as cache_denied_should_error from public.sundial_customer_cache;
rollback;


-- ---------------------------------------------------------------------------
-- V11 — **TIM ONLY**. Same, as a tenant-scope user. The assertion is the EQUALITY,
-- not the number: comments_visible_as_exec must EQUAL tenant_total, whatever the
-- tenant total has drifted to. Staff are untouched.
-- ---------------------------------------------------------------------------
begin;
  -- ORDER IS LOAD-BEARING: resolve the uuid and set the claims FIRST, as postgres,
  -- then switch role. See the warning above V10.
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id from public.profiles
               where email = 'tim+zz-exec@constructiveoperations.com'),
      'role','authenticated')::text, true);
  set local role authenticated;

  select (select count(*) from public.comments)             as comments_visible_as_exec,
         (select count(*) from public.comments
           where tenant_id = 'a1W7y000007AszBEAS')          as tenant_total;
rollback;


-- ---------------------------------------------------------------------------
-- V12 — **TIM ONLY**. The WRITE refusals. Run block (a)+(b) first, then (c)+(d).
-- Both blocks end in ROLLBACK, so no row survives, and every id is a ZZ fixture.
-- DO NOT point these at a live record.
-- EXPECT:
--   (a) SUCCEEDS — zz-rep-a1 commenting on their own record, returns an id.
--   (b) RAISES   — 42501 "new row violates row-level security policy for table
--                  \"comments\"" — commenting on zz-rep-a2's record.
--   (c) RAISES   — 42501 on comment_mentions: mentioning zz-rep-b1. user_visible
--                  fails, because b1 is another dealer's rep.
--   (d) RAISES   — 42501 on comment_mentions: mentioning zz-rep-a2 onto zz-rep-a1's
--                  OWN record. user_visible PASSES (same dealer) and it still fails,
--                  on record_visible_for. This is the clause that stops a mention
--                  being used to export a comment body past its scope, and it is the
--                  single most important refusal in this file.
-- ---------------------------------------------------------------------------
begin;
  -- ORDER IS LOAD-BEARING: resolve the uuid and set the claims FIRST, as postgres,
  -- then switch role. See the warning above V10.
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id from public.profiles
               where email = 'tim+zz-rep-a1@constructiveoperations.com'),
      'role','authenticated')::text, true);
  set local role authenticated;

  -- (a) own record — EXPECT SUCCESS
  insert into public.comments (tenant_id, record_id, record_object, author_id, author_name, body)
  values ('a1W7y000007AszBEAS','a1P7y00000AmyXCEAZ','customer',
          auth.uid(),'ZZ RLS PROBE','V12(a) — expected to succeed')
  returning id;

  -- (b) another rep's record — EXPECT 42501
  insert into public.comments (tenant_id, record_id, record_object, author_id, author_name, body)
  values ('a1W7y000007AszBEAS','a1P7y00000ApR0PEAV','customer',
          auth.uid(),'ZZ RLS PROBE','V12(b) — expected to FAIL');
rollback;

-- (c) and (d): the mention refusals. Comment out (c) to reach (d), or run twice.
begin;
  -- ORDER IS LOAD-BEARING: resolve the uuid and set the claims FIRST, as postgres,
  -- then switch role. See the warning above V10.
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id from public.profiles
               where email = 'tim+zz-rep-a1@constructiveoperations.com'),
      'role','authenticated')::text, true);
  set local role authenticated;

  insert into public.comments (tenant_id, record_id, record_object, author_id, author_name, body)
  values ('a1W7y000007AszBEAS','a1P7y00000AmyXCEAZ','customer',
          auth.uid(),'ZZ RLS PROBE','V12(c/d) — carrier comment');

  -- (c) mention another dealer's rep — EXPECT 42501 (user_visible)
  insert into public.comment_mentions (comment_id, mentioned_user_id)
  select c.id, (select id from public.profiles
                 where email='tim+zz-rep-b1@constructiveoperations.com')
    from public.comments c
   where c.body = 'V12(c/d) — carrier comment';

  -- (d) mention a SAME-DEALER rep onto a record they cannot see — EXPECT 42501
  --     (user_visible passes, record_visible_for fails)
  insert into public.comment_mentions (comment_id, mentioned_user_id)
  select c.id, (select id from public.profiles
                 where email='tim+zz-rep-a2@constructiveoperations.com')
    from public.comments c
   where c.body = 'V12(c/d) — carrier comment';
rollback;


-- ---------------------------------------------------------------------------
-- V13 — **TIM ONLY** is not required for this one; it reads the catalog. §8's
-- Phase-6 gate set, re-pointed at these tables per A5. The one-line summary of
-- everything above. EXPECT all six verdicts TRUE.
-- ---------------------------------------------------------------------------
select 'comments SELECT policy names record_visible' as gate,
       exists (select 1 from pg_policies
                where schemaname='public' and tablename='comments'
                  and cmd='SELECT' and qual like '%record_visible%')       as pass
union all
select 'comments INSERT policy names record_visible',
       exists (select 1 from pg_policies
                where schemaname='public' and tablename='comments'
                  and cmd='INSERT' and with_check like '%record_visible%')
union all
select 'mentions SELECT is mentioned_user_id = auth.uid() only',
       exists (select 1 from pg_policies
                where schemaname='public' and tablename='comment_mentions'
                  and cmd='SELECT' and qual like '%mentioned_user_id%'
                  and qual not like '%tenant%')
union all
select 'mentions INSERT names user_visible AND record_visible_for',
       exists (select 1 from pg_policies
                where schemaname='public' and tablename='comment_mentions'
                  and cmd='INSERT' and with_check like '%user_visible%'
                  and with_check like '%record_visible_for%')
union all
select 'no UPDATE policy on comments or comment_mentions',
       not exists (select 1 from pg_policies
                    where schemaname='public'
                      and tablename in ('comments','comment_mentions')
                      and cmd='UPDATE')
union all
select 'cache tables still revoked from authenticated (A4 intact)',
       not has_table_privilege('authenticated','public.sundial_customer_cache','SELECT');


-- =============================================================================
-- END. Next: scripts/verify-comment-rls.mjs as the ZZ TEST users (step 5), then
-- the sundial-comment-notify §3.7 re-check (step 6).
-- =============================================================================


-- #############################################################################
-- ##  PART C — the anon EXECUTE revoke that Part B's `from public` missed.    ##
-- ##  Found by V2 on 2026-08-27, AFTER Part B was applied. Run this.          ##
-- #############################################################################
--
-- V2 was written expecting `anon_exec = false` on the four public helpers. It came
-- back TRUE on all four, and the reason is the same shape of accident A4 documented
-- on the cache tables — a default that re-grants what you just revoked.
--
--   select proacl from pg_proc ... ->  public.record_visible_for:
--     postgres=X/postgres
--     anon=X/postgres            <-- a DIRECT grant, not one held via PUBLIC
--     authenticated=X/postgres
--     service_role=X/postgres
--
-- Supabase ships `alter default privileges in schema public grant all on functions
-- to anon, authenticated, service_role`. So at CREATE time each function got a
-- direct grant to each of the three roles. Part B's `revoke all ... from public`
-- removed the PUBLIC entry — which was not the entry doing the work. The tell is
-- `private.resolve_access`, which came back correctly locked down: those default
-- privileges are scoped `in schema public`, so nothing re-granted it.
--
-- THIS IS THE D-064 LESSON REPEATING, ONE LAYER DOWN. "Ask what the grant is, then
-- ask what the policy is" — and then ask what re-grants it. A revoke from PUBLIC is
-- not a revoke from a role that holds the privilege directly.
--
-- WHAT WAS ACTUALLY EXPOSED, AND WHAT WAS NOT
-- -------------------------------------------
-- Three of the four are inert for anon, because they resolve the CALLER through
-- auth.uid(), which is NULL for an anonymous session:
--   current_profile()            -> no rows
--   user_visible(uuid)           -> false always (the `me` side is empty)
--   record_visible(text,text)    -> false always
--
-- `record_visible_for(uuid, text, text)` is the exception and the reason this part
-- exists: it takes the subject as an ARGUMENT, so it never consults auth.uid(). Any
-- holder of the publishable key — which ships in the browser bundle by design —
-- could POST /rest/v1/rpc/record_visible_for with an arbitrary uuid and an
-- arbitrary Salesforce id and get back a boolean. That is an oracle over "does this
-- record exist in the cache" and "can this user see it", unauthenticated. It is a
-- weak oracle (both arguments have to be guessed) and it leaks no field values, but
-- it is free to close and it should never have been open.
--
-- WHY `record_visible` KEEPS ITS anon GRANT
-- -----------------------------------------
-- An RLS policy expression executes as the INVOKING role. `comments_select_visible`
-- and `comments_insert_visible` both call `record_visible()`, and policies apply to
-- role {public}, anon included. Revoke it from anon and an anonymous SELECT on
-- `comments` raises `42501: permission denied for function record_visible` instead
-- of returning an empty set — a behaviour change on the anon surface, and one that
-- would make scripts/probe-cache-reachability.mjs report an error where Phase 0
-- recorded "200, 0 rows". It is also pointless: the function takes no uuid, so for
-- an anonymous caller it answers `false` and nothing else. Keep it, deliberately.
--
-- Revoking the other three does NOT break policy evaluation for anon:
--   * mentions_select_own calls no function at all — anon still gets 200 / 0 rows.
--   * mentions_insert_scoped calls the two revoked ones, so an anon INSERT now
--     raises 42501 rather than being denied by the policy. Both are a refusal, and
--     anon could never satisfy the EXISTS on `comments` regardless.
--   * record_visible() calls record_visible_for() INTERNALLY, and that inner call
--     is unaffected: record_visible is SECURITY DEFINER owned by postgres, so its
--     body runs as postgres, which keeps EXECUTE. Verify this with V14.

revoke execute on function public.record_visible_for(uuid, text, text) from anon;
revoke execute on function public.user_visible(uuid)                   from anon;
revoke execute on function public.current_profile()                    from anon;

-- NOTE FOR ANY FUTURE EDIT OF THESE FUNCTIONS: `create or replace function`
-- PRESERVES the existing ACL, so re-running Part B will not undo Part C. A `drop`
-- followed by a `create` WILL re-apply the default privileges and silently re-open
-- anon. If you ever drop one of these, re-run Part C afterwards and re-check V2.


-- ---------------------------------------------------------------------------
-- V2b — re-run V2 after Part C.
-- EXPECT: private.resolve_access      false / false / false
--         public.current_profile      false / true  / true
--         public.record_visible       TRUE  / true  / true   <-- deliberate, see above
--         public.record_visible_for   false / true  / true
--         public.user_visible         false / true  / true
-- ---------------------------------------------------------------------------
select n.nspname || '.' || p.proname                                as function,
       has_function_privilege('anon',          p.oid, 'EXECUTE')    as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE')    as auth_exec,
       has_function_privilege('service_role',  p.oid, 'EXECUTE')    as svc_exec
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname, p.proname) in (
         ('private','resolve_access'), ('public','current_profile'),
         ('public','record_visible'),  ('public','record_visible_for'),
         ('public','user_visible'))
 order by 1;


-- ---------------------------------------------------------------------------
-- V14 — **TIM ONLY**. Proof that revoking record_visible_for from anon did not
-- break record_visible() for anon, i.e. that the SECURITY DEFINER inner call runs
-- as the owner rather than the caller. This is the one thing Part C could have
-- broken, so it is checked rather than assumed.
-- EXPECT: comments_readable = 0 with NO error raised. An error here means an
--         anonymous visitor now gets a 500 where they used to get an empty list.
-- ---------------------------------------------------------------------------
begin;
  set local role anon;
  select count(*) as comments_readable_as_anon from public.comments;
  select count(*) as mentions_readable_as_anon from public.comment_mentions;
rollback;
