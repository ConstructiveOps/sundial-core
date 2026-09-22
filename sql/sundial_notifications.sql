-- sundial_notifications.sql — in-app + push notifications (D-074, 2026-09-21).
--
-- Two tables and one preferences column:
--   sundial_notifications        one row per person per event: the bell's list. The browser
--                                READS its own rows and marks them read under RLS; only the
--                                Lambdas (service role) insert.
--   sundial_push_subscriptions   one row per browser / phone that turned push on (the Web
--                                Push endpoint + keys). Written by sundial-notify from the
--                                caller's verified identity, never by the browser directly.
--   user_preferences.notify_prefs  jsonb of category → boolean; a missing key means ON.
--
-- The recipient key is the Supabase auth uuid (profiles.id), so the read policy is the
-- plainest possible `profile_id = auth.uid()` — no helper function, nothing to drift. The
-- Lambdas translate a Sundial_User__c id (Tech__c, Assigned_To__c) to it through
-- public.profiles.sundial_user_id, which sundial-auth-proxy keeps current on every /auth/me.
--
-- Realtime: every insert is ALSO broadcast on channel `user:{profile_id}:notify` by the
-- Lambda (lib/notify.js) so an open tab rings at once; the table is the truth the tab
-- re-reads on focus. Re-runnable.

create table if not exists public.sundial_notifications (
  id            uuid primary key default gen_random_uuid(),
  client_sf_id  text not null,                    -- tenant (Sundial_Tenant__c id)
  profile_id    uuid not null,                    -- the recipient (auth.users.id / profiles.id)
  user_sf_id    text,                             -- the recipient's Sundial_User__c id, when known
  category      text not null,                    -- schedule | mention | customer_text | reminder | tech_activity | money | customer_message
  kind          text not null,                    -- finer event name (call_scheduled, estimate_approved, …)
  title         text not null,
  body          text,
  url           text,                             -- where the click goes (portal path)
  record_type   text,                             -- job | servicecall | estimate | customer | membership | comment
  record_sf_id  text,
  dedupe_key    text,                             -- unique per recipient: a replayed event never rings twice
  created_at    timestamptz not null default now(),
  read_at       timestamptz,
  pushed_at     timestamptz,                      -- when at least one push went out
  push_error    text
);
-- Full (not partial) unique index on purpose: the Lambda inserts with
-- ON CONFLICT (profile_id, dedupe_key) DO NOTHING, which Postgres can only match to a
-- non-partial index. NULL dedupe keys never collide (NULLs are distinct), so an
-- un-keyed notification is always inserted.
create unique index if not exists idx_sundial_notifications_dedupe
  on public.sundial_notifications (profile_id, dedupe_key);
create index if not exists idx_sundial_notifications_inbox
  on public.sundial_notifications (profile_id, created_at desc);
create index if not exists idx_sundial_notifications_unread
  on public.sundial_notifications (profile_id) where read_at is null;

alter table public.sundial_notifications enable row level security;
drop policy if exists notifications_select_own on public.sundial_notifications;
create policy notifications_select_own on public.sundial_notifications
  for select to authenticated using (profile_id = auth.uid());
drop policy if exists notifications_update_own on public.sundial_notifications;
create policy notifications_update_own on public.sundial_notifications
  for update to authenticated using (profile_id = auth.uid()) with check (profile_id = auth.uid());
revoke all on public.sundial_notifications from anon;
grant select, update (read_at) on public.sundial_notifications to authenticated;

-- Realtime on the table is NOT enabled: the Lambda broadcasts on the user's channel
-- instead (no replication slot, no per-row RLS evaluation on the socket).

create table if not exists public.sundial_push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  client_sf_id  text not null,
  profile_id    uuid not null,
  user_sf_id    text,
  endpoint      text not null unique,             -- the push service URL (one per browser install)
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  app           text not null default 'office'    -- office | tech (which shell registered it)
                check (app in ('office', 'tech')),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  failed_at     timestamptz,                      -- 404 / 410 from the push service → removed next sweep
  fail_reason   text
);
create index if not exists idx_sundial_push_subscriptions_profile
  on public.sundial_push_subscriptions (profile_id);
alter table public.sundial_push_subscriptions enable row level security;
-- No browser policy at all: subscribe / unsubscribe go through sundial-notify (service role),
-- which stamps the recipient from the verified JWT. The browser cannot read anyone's endpoints.
revoke all on public.sundial_push_subscriptions from anon, authenticated;

-- Per-user switches, read by the browser (own row) and by the Lambdas (service role).
-- { "schedule": true, "mention": true, "customer_text": true, "reminder": true,
--   "tech_activity": true, "money": true, "customer_message": true,
--   "browser": true }   ← "browser" = show native browser notifications while a tab is open
alter table public.user_preferences add column if not exists notify_prefs jsonb not null default '{}'::jsonb;
