-- sundial_stage_notify.sql — a deal's stage moved → sundial-notify → its dealer and rep
-- (dealer module step 6 of 9, D-074 amendment 3, 2026-10-26).
--
-- WHY A TRIGGER ON THE CACHE
-- --------------------------
-- Nothing in Sundial detects a stage change. Stage__c moves from a portal edit, Tim's
-- Flows, Aurora, Zapier and admins in Salesforce, and the ONE place every one of those
-- lands is the cache: the write-through, the read-time refresh, the 5-minute
-- sundial-cache-sync. So the hook is here, on sundial_customer_cache and
-- sundial_solar_cache, and it posts to sundial-notify through pg_net exactly the way
-- comment_mentions posts to sundial-comment-notify (sql/sundial_comment_mention_notify.sql
-- — read that file's header for the pg_net, private.app_config and SECURITY DEFINER
-- reasoning; it is not repeated here).
--
--   AFTER UPDATE OF stage ON sundial_customer_cache   WHEN the stage really changed
--   AFTER UPDATE OF stage ON sundial_solar_cache      WHEN the stage really changed
--   AFTER INSERT          ON sundial_solar_cache      a new project (old_stage null)
--
-- A cache upsert of an existing row is an UPDATE to Postgres, so the sync re-writing a
-- row whose stage did not move fires nothing (the WHEN clause), and a second path
-- writing the same new stage later fires nothing either: one post per real transition.
--
-- THE POST: { object, sf_id, client_sf_id, old_stage, new_stage, modstamp, op }
--   modstamp = the row's lastmodifieddate (Salesforce LastModifiedDate, added below),
--              else last_synced_at — the Lambda's dedupe key carries it, so a pg_net
--              redelivery rings nobody twice and the same stage reached again later does.
--   op       = insert | update — tells a new solar project from a stage set on an old one.
-- Header X-Sundial-Stage-Secret. Dealers and reps are the only recipients (the Lambda
-- decides who); Harmon staff are never notified by this.
--
-- THE CACHE WRITE MUST ALWAYS WIN. Every failure here is swallowed and logged as a
-- WARNING; a broken notification path must never fail or roll back a sync.
--
-- ⚠️ BULK CHANGES FAN OUT. Every row whose stage moves is one post and one push per
-- recipient. Before a bulk stage fix in Salesforce, a cache TRUNCATE + full resync of
-- the solar cache (every row re-INSERTED = a "new project" alert for every deal), or a
-- data import, TURN IT OFF and back on afterwards:
--
--   delete from private.app_config where key = 'stage_notify_url';      -- off (the trigger warns and returns)
--   insert into private.app_config (key, value) values ('stage_notify_url', '<url>')
--     on conflict (key) do update set value = excluded.value, updated_at = now();  -- on
--
-- A routine full resync ({ "mode": "full" }) is safe: it upserts, and stages do not move.
--
-- CONFIGURATION — two rows in private.app_config (no API surface; created by
-- sql/sundial_comment_mention_notify.sql, which must have run first):
--
--   insert into private.app_config (key, value) values
--     ('stage_notify_url',    'https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod/webhooks/stage-change'),
--     ('stage_notify_secret', '<the shared secret>')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
--
-- The same secret goes in Secrets Manager `sundial/stage-notify` as { "secret": "…" }
-- (or the STAGE_NOTIFY_SECRET env var on sundial-notify). The Lambda FAILS CLOSED: with
-- no secret configured it refuses every post.
--
-- Applied by hand in the Supabase SQL editor. Safe to re-run.

create extension if not exists pg_net;

do $$
begin
  if to_regclass('private.app_config') is null then
    raise exception 'private.app_config is missing — run sql/sundial_comment_mention_notify.sql first.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The modstamp column — Salesforce LastModifiedDate on both cache tables
-- ---------------------------------------------------------------------------
-- Neither table stored a Salesforce modification time (cache-sync uses SystemModstamp
-- only as its watermark). The customer cache got `lastmodifieddate` on 2026-10-26
-- (sql/2026-10-26_customer_last_modified.sql — repeated here, harmless); the solar cache
-- gets it now. The column existing is the whole wiring: the sync selects a field when its
-- derived column exists (lib/cache-row.js sfFieldToColumn). Rows fill as they change, or
-- at once with one full resync per object ({ "object": "solar", "mode": "full" }); until
-- then the trigger sends last_synced_at, which is just as good a dedupe stamp.
alter table public.sundial_customer_cache add column if not exists lastmodifieddate timestamptz;  -- LastModifiedDate
alter table public.sundial_solar_cache    add column if not exists lastmodifieddate timestamptz;  -- LastModifiedDate

-- ---------------------------------------------------------------------------
-- Dealer devices — sundial_push_subscriptions.app gains 'dealer'
-- ---------------------------------------------------------------------------
-- The inline check in sql/sundial_notifications.sql was named by Postgres
-- `sundial_push_subscriptions_app_check`; it is replaced, under the same name.
alter table public.sundial_push_subscriptions drop constraint if exists sundial_push_subscriptions_app_check;
alter table public.sundial_push_subscriptions
  add constraint sundial_push_subscriptions_app_check check (app in ('office', 'tech', 'dealer'));

-- ---------------------------------------------------------------------------
-- The trigger function (one, for both tables)
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER + pinned search_path, `private` schema-qualified and NOT on the path —
-- the same hardening as notify_comment_mention(); do not "tidy" it.
create or replace function notify_stage_change()
returns trigger
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $$
declare
  v_url      text;
  v_secret   text;
  v_object   text;
  v_old      text;
  v_modstamp timestamptz;
begin
  select nullif(c.value, '') into v_url    from private.app_config c where c.key = 'stage_notify_url';
  select nullif(c.value, '') into v_secret from private.app_config c where c.key = 'stage_notify_secret';
  if v_url is null or v_secret is null then
    raise warning
      'notify_stage_change: private.app_config is missing stage_notify_url and/or stage_notify_secret - % % not notified. See sql/sundial_stage_notify.sql.',
      tg_table_name, new.sf_id;
    return new;
  end if;

  v_object   := case tg_table_name when 'sundial_customer_cache' then 'customer' else 'solar' end;
  v_old      := case when tg_op = 'UPDATE' then old.stage else null end;
  v_modstamp := coalesce(new.lastmodifieddate, new.last_synced_at, now());

  begin
    perform net.http_post(
      url     := v_url,
      body    := jsonb_build_object(
                   'object',       v_object,
                   'sf_id',        new.sf_id,
                   'client_sf_id', new.client_sf_id,
                   'old_stage',    v_old,
                   'new_stage',    new.stage,
                   'modstamp',     to_char(v_modstamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                   'op',           lower(tg_op)
                 ),
      headers := jsonb_build_object(
                   'Content-Type',          'application/json',
                   'X-Sundial-Stage-Secret', v_secret
                 ),
      timeout_milliseconds := 5000
    );
  exception when others then
    -- SWALLOW. The cache row is written; that is what the sync was doing.
    raise warning 'notify_stage_change: net.http_post failed for % % (%): %', tg_table_name, new.sf_id, sqlstate, sqlerrm;
  end;

  return new;
end;
$$;

comment on function notify_stage_change() is
  'AFTER UPDATE OF stage / AFTER INSERT trigger on sundial_customer_cache + sundial_solar_cache: posts { object, sf_id, client_sf_id, old_stage, new_stage, modstamp, op } to sundial-notify POST /webhooks/stage-change via pg_net. Never blocks or fails the cache write. D-074 amendment 3.';

-- Not callable from the API: it is a trigger function and only the triggers run it.
revoke all on function notify_stage_change() from public, anon, authenticated;

drop trigger if exists trg_customer_cache_stage_notify on public.sundial_customer_cache;
create trigger trg_customer_cache_stage_notify
  after update of stage on public.sundial_customer_cache
  for each row when (old.stage is distinct from new.stage)
  execute function notify_stage_change();

drop trigger if exists trg_solar_cache_stage_notify on public.sundial_solar_cache;
create trigger trg_solar_cache_stage_notify
  after update of stage on public.sundial_solar_cache
  for each row when (old.stage is distinct from new.stage)
  execute function notify_stage_change();

drop trigger if exists trg_solar_cache_created_notify on public.sundial_solar_cache;
create trigger trg_solar_cache_created_notify
  after insert on public.sundial_solar_cache
  for each row execute function notify_stage_change();

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verifying / operating
-- ---------------------------------------------------------------------------
-- The triggers are in place:
--   select tgname, tgrelid::regclass from pg_trigger where tgname like 'trg_%stage_notify' or tgname = 'trg_solar_cache_created_notify';
--
-- What pg_net got back (401 = the two secrets disagree; 200 with reason no_recipients
-- is normal for a deal with no dealer / rep who has signed in):
--   select id, status_code, left(content::text, 200), created from net._http_response order by created desc limit 20;
--
-- The config, without printing the secret:
--   select key, case when key like '%secret%' then '(set, ' || length(value) || ' chars)' else value end, updated_at
--     from private.app_config where key in ('stage_notify_url', 'stage_notify_secret');
--
-- What was delivered:
--   select profile_id, kind, title, created_at from sundial_notifications where category = 'stage' order by created_at desc limit 20;
