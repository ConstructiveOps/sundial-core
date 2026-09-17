-- ============================================================================
-- Sundial access model — Phase 10: the `tech` scope reaches the comments RLS
-- (D-072 amendment 7 follow-up, 2026-09-16)
-- ============================================================================
--
-- WHAT THIS DOES. `lib/access.js` gives a Technician the scope `tech` (amendment 7).
-- The database's copy of the scope table — `private.resolve_access()` — did not know
-- the word, so a tech resolved to `none` and every comments / mentions policy said no:
-- the tech app could not show the job's team notes, and nobody could @-mention a tech.
-- This phase teaches the three helpers the new scope, and NOTHING else changes:
--
--   resolve_access      a `tech` lane: profile says 'tech' OR the user cache says an
--                       active Technician → 'tech'. Either source saying 'none'
--                       (deactivated) still wins — the narrower-of-two rule holds.
--   record_visible_for  tech: `job`, `estimate`, `customer` are visible TENANT-WIDE
--                       (a tech at a house needs the customer's history whether or not
--                       today's call is theirs — Tim, 2026-09-16); `solar`, `roofing`
--                       and everything else stay false. Existence in the cache is the
--                       tenant check, exactly as the dealer/own branches do it.
--   user_visible        a tech is staff: they see everyone in the tenant, and everyone
--                       in the tenant sees them (so a dispatcher can tag a tech).
--
-- The policies themselves (comments_select_visible, comments_insert_visible,
-- comments_delete_own, mentions_select_own, mentions_insert_scoped) and
-- mentionable_users() are untouched — they call these helpers, so they move together.
--
-- HOW TO APPLY (Tim): Supabase SQL editor → paste the whole file → Run. Then the
-- verification block at the bottom, one statement at a time. Idempotent.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- private.resolve_access(uuid) — adds the `tech` lane. Body otherwise identical to
-- sundial_access_p1b_comment_rls.sql.
-- ---------------------------------------------------------------------------
create or replace function private.resolve_access(p_uid uuid)
returns table (
  tenant_id       text,
  scope           text,   -- tenant | dealer | own | tech | none
  sundial_user_id text,
  dealer_sf_id    text,
  access_level    text
)
language sql
stable
security definer
set search_path = private, public, pg_catalog
as $$
  with p as (
    select pr.tenant_id, pr.sundial_user_id, pr.dealer_sf_id, pr.access_scope
      from public.profiles pr
     where pr.id = p_uid
     limit 1
  ),
  u_by_profile as (
    select uc.* from public.sundial_user_cache uc
     where uc.sf_id = (select sundial_user_id from p)
     limit 1
  ),
  u_by_uuid as (
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
      -- Source A (the profile). 'tech' is "no opinion" for the ordered ranks below and
      -- is read separately as tech_a.
      (select case pr.access_scope
                when 'tenant' then 3
                when 'dealer' then 2
                when 'own'    then 1
                when 'none'   then 0
                else null
              end
         from p pr) as rank_a,
      (select pr.access_scope = 'tech' from p pr) as tech_a,
      -- Source B (the user cache). An active Technician is "tech"; for the ordered
      -- ranks it is 0 (none) exactly as before, so a stale profile can never widen it.
      (select case
                when uu.active is not true then 0
                when uu.access_level in ('Executive','Admin','Manager') then 3
                when uu.access_level = 'Sales Dealer' and uu.dealer_sf_id is not null then 2
                when uu.access_level = 'Sales Rep'    and uu.dealer_sf_id is not null then 1
                else 0
              end
         from u uu) as rank_b,
      (select uu.active is true and uu.access_level = 'Technician' from u uu) as tech_b
  )
  select
    coalesce((select p.tenant_id from p), (select uu.client_sf_id from u uu)),
    case
      -- THE TECH LANE. The cache (Salesforce, current) says active Technician — or the
      -- profile says 'tech' and the cache has no row to disagree — and the profile does
      -- not say 'none'. A profile that still says 'own' from before amendment 7 does not
      -- block it (the cache is current); a cache that says Sales Rep does (it wins).
      when (coalesce(r.tech_b, false) or (coalesce(r.tech_a, false) and r.rank_b is null))
       and coalesce(r.rank_a, 99) <> 0
        then 'tech'
      else case least(coalesce(r.rank_a, 99), coalesce(r.rank_b, 99))
             when 3 then 'tenant'
             when 2 then 'dealer'
             when 1 then 'own'
             else        'none'
           end
    end,
    coalesce((select p.sundial_user_id from p), (select uu.sf_id from u uu)),
    coalesce((select uu.dealer_sf_id from u uu), (select p.dealer_sf_id from p)),
    (select uu.access_level from u uu)
  from ranked r
  where r.rank_a is not null or r.rank_b is not null or coalesce(r.tech_a, false);
$$;

-- ---------------------------------------------------------------------------
-- public.record_visible_for(uuid, text, text) — adds the `tech` branch. The tenant /
-- dealer / own branches are verbatim from sundial_access_p8_comments_customer_only.sql.
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

      -- TECH (amendment 7): the Service module's three hubs, tenant-wide, read through
      -- the cache so the tenant check is the row's own client_sf_id.
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
          when 'solar' then false   -- A11
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
          when 'solar' then false   -- A11
          else false
        end

      else false
    end
    from private.resolve_access(p_profile_id) a
  ), false);
$$;

-- ---------------------------------------------------------------------------
-- public.user_visible(uuid) — a tech is staff.
-- ---------------------------------------------------------------------------
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
      when me.tenant_id <> them.tenant_id then false
      when me.scope in ('tenant', 'tech') then true         -- staff see everyone
      when them.scope in ('tenant', 'tech') then true       -- everyone sees staff (a dispatcher tags a tech)
      when me.dealer_sf_id is not null
       and me.dealer_sf_id = them.dealer_sf_id then true
      else false
    end
    from private.resolve_access(auth.uid())   me,
         private.resolve_access(p_profile_id) them
  ), false);
$$;

-- Grants are unchanged by CREATE OR REPLACE, but say so explicitly (the p1b rule:
-- "ask what the grant is, THEN ask what the policy is").
revoke all on function private.resolve_access(uuid)                from public;
revoke all on function public.record_visible_for(uuid, text, text) from public, anon;
revoke all on function public.user_visible(uuid)                   from public, anon;
grant execute on function public.record_visible_for(uuid, text, text) to authenticated, service_role;
grant execute on function public.user_visible(uuid)                   to authenticated, service_role;

commit;

-- ============================================================================
-- VERIFICATION — **TIM ONLY**, after the commit above (each as a separate run).
-- ============================================================================
-- V1. The tech test user resolves to scope 'tech' (replace the email if needed).
--   select r.* from auth.users u, private.resolve_access(u.id) r
--    where u.email = 'tim+zz-tech-2@constructiveoperations.com';
--   -- expect: scope = 'tech', tenant_id = Harmon's Sundial_Tenant__c id
--
-- V2. That tech can see the ZZ test job, and NOT a solar record:
--   select public.record_visible_for(u.id, 'job',   '<a Sundial_Service_Job__c id>'),
--          public.record_visible_for(u.id, 'solar', '<any Sundial_Solar__c id>')
--     from auth.users u where u.email = 'tim+zz-tech-2@constructiveoperations.com';
--   -- expect: true, false
--
-- V3. Nobody else moved: a Sales Rep fixture still resolves to 'own', a deactivated
--     fixture to 'none' (the seed script's zz-inactive user).
--   select u.email, r.scope from auth.users u, private.resolve_access(u.id) r
--    where u.email like 'tim+zz-%' order by 1;
--
-- V4. End to end, as the tech, over supabase-js: node scripts/verify-comment-rls.mjs
--     (the ZZ users) — the existing 44 checks must still pass; the tech user reads and
--     writes a comment on record_object = 'job' and is refused on 'solar'.
