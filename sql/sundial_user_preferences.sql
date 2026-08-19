-- user_preferences — per-user portal settings the USER owns and edits.
--
-- Two settings today: whether @-mention comment alerts arrive by email, and whether
-- list pages open in list or board mode. Both are written directly from the browser
-- under RLS (the Settings page), the same way comments are — there is no server in
-- this path and no Lambda that needs to exist for the toggle to work.
--
-- WHY THIS IS NOT A COLUMN ON public.profiles
-- -------------------------------------------
-- profiles is SERVER-OWNED. sundial-auth-proxy upserts tenant_id / role / email into
-- it on every /auth/me, and the RLS policies on the cache tables resolve tenancy from
-- it (see the current_user_tenant_id() helper). It is the row that decides what data
-- a session can see.
--
-- Making a self-serve toggle live there would mean granting the client UPDATE on that
-- row. POSTGRES RLS IS ROW-LEVEL, NOT COLUMN-LEVEL: a policy that lets a user update
-- "their preferences" on profiles lets them update their tenant_id and role in the
-- same statement. That is a privilege-escalation and a tenant-isolation hole in one,
-- and no amount of client-side care closes it — the client is the attacker in that
-- threat model. (Column-level GRANTs can narrow it, but they are a second,
-- independent mechanism that has to stay in sync with the policy forever; a separate
-- table has no such edge to keep sharp.)
--
-- So: a separate table whose every column is safe for its owner to write. The worst a
-- malicious user can do here is turn off their own email alerts.
--
-- WHY THERE IS NO BACKFILL
-- ------------------------
-- Every existing user has NO ROW, and that is the intended steady state for anyone who
-- never opens Settings. ABSENCE MUST READ AS comment_email_alerts = true. Nobody has to
-- opt in to keep working the way they do today, and a user who never touches Settings
-- costs one row less forever. Every reader — the notify Lambda, the frontend — must
-- apply that default itself; do NOT "fix" this by inserting rows for existing users.
--
-- Applied by hand against the Supabase SQL editor (see docs/integrations/
-- comment-mention-alerts.md). Safe to re-run: everything is IF NOT EXISTS / idempotent.

create table if not exists user_preferences (
  -- The Supabase AUTH uuid, not a Sundial_User__c id. ON DELETE CASCADE because a
  -- preference row has no meaning once the auth user is gone.
  user_id              uuid primary key references auth.users(id) on delete cascade,

  -- @-mention email alerts. DEFAULT TRUE, and a MISSING ROW means true as well — see
  -- the no-backfill note above. Both halves matter: the default covers rows created by
  -- a user who only toggled the other setting.
  comment_email_alerts boolean not null default true,

  -- Landing view for the list pages.
  --
  -- STORE 'list', NOT 'table'. harmon-crm's internal ViewMode union happens to be
  -- 'table' | 'board', but 'table' is a detail of that one component; 'list' is the
  -- word the user sees and the durable cross-repo contract. The frontend maps it in
  -- exactly one place. Renaming a React type must never require a data migration.
  default_list_view    text    not null default 'list'
                               check (default_list_view in ('list','board')),

  updated_at           timestamptz not null default now()
);

-- RLS: a user reads and writes ONLY their own row. This is the whole security model of
-- the table, so it is enabled unconditionally rather than "if not already".
alter table user_preferences enable row level security;

-- Policies are dropped-then-created so re-running this file converges on the intended
-- definition rather than erroring on a duplicate name.
drop policy if exists user_preferences_select_own on user_preferences;
create policy user_preferences_select_own
  on user_preferences for select
  using (auth.uid() = user_id);

-- INSERT needs WITH CHECK (there is no existing row to test with USING). Without it a
-- user could insert a row keyed to somebody else's uuid and turn off THEIR alerts.
drop policy if exists user_preferences_insert_own on user_preferences;
create policy user_preferences_insert_own
  on user_preferences for insert
  with check (auth.uid() = user_id);

-- UPDATE needs BOTH: USING picks the rows that are visible to update, WITH CHECK stops
-- the update from re-keying the row to another user on the way out.
drop policy if exists user_preferences_update_own on user_preferences;
create policy user_preferences_update_own
  on user_preferences for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- NO DELETE POLICY, deliberately. Deleting a row would silently reset the user to
-- alerts-on, which is a surprising way to lose a setting; and there is no product
-- reason to remove one. The auth.users cascade is the only path that deletes here.

-- Keep updated_at honest without trusting the client to send it.
create or replace function set_user_preferences_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_user_preferences_updated_at on user_preferences;
create trigger trg_user_preferences_updated_at
  before update on user_preferences
  for each row execute function set_user_preferences_updated_at();

-- The service role (Lambdas) bypasses RLS, so no grant is needed for the notify path.
-- These are for the browser's authenticated role, which RLS then narrows to own-row.
grant select, insert, update on user_preferences to authenticated;
