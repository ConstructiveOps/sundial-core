-- comment_mentions -> sundial-comment-notify: the @-mention email trigger.
--
-- WHY THIS IS A DATABASE TRIGGER AND NOT A CLIENT CALL
-- ----------------------------------------------------
-- Comments are not a backend feature. harmon-crm's CommentThread.tsx inserts into
-- `comments` and then into `comment_mentions` DIRECTLY FROM THE BROWSER under RLS —
-- there is no server anywhere in that path, and the mention insert is explicitly
-- best-effort in that component.
--
-- So if the browser were also responsible for firing the notification, then closing a
-- tab, a flaky network, or a mid-flight navigation would silently lose SOMEBODY ELSE'S
-- notification. The person who suffers is not the person who caused it and neither of
-- them ever finds out. That is the failure this trigger exists to remove: once the
-- mention row is COMMITTED, the notification is the database's problem, not the
-- client's.
--
-- THE INSERT MUST ALWAYS WIN
-- --------------------------
-- Everything below is wrapped so that no notification problem can fail or slow the
-- INSERT. A pg_net queue error, an unset setting, a bad URL — all swallowed and logged.
-- Posting a comment is the user's actual job; alerting somebody about it is not.
-- (Same philosophy as the Aurora write-back and the Supabase ban retry.)
--
-- CONFIGURATION — the URL and the shared secret are NOT hardcoded here
-- --------------------------------------------------------------------
-- Both live in `private.app_config`, a table with no API surface, read by the
-- SECURITY DEFINER trigger function. This file stays safe to commit and the secret
-- rotates with an UPDATE, not a code edit.
--
--   insert into private.app_config (key, value) values
--     ('comment_notify_url', 'https://.../prod/webhooks/comment-mention'),
--     ('comment_notify_secret', '<the shared secret>')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
--
-- WHY A TABLE AND NOT DATABASE SETTINGS — this is a PLATFORM CONSTRAINT, not taste
-- ------------------------------------------------------------------------------
-- The first version of this file used `alter database postgres set sundial.*` and
-- `current_setting()`. That CANNOT WORK ON MANAGED SUPABASE. Setting a custom
-- parameter at database scope requires superuser or database ownership; Supabase's
-- `postgres` role is not a superuser and `supabase_admin` owns the database, so the
-- statement fails outright:
--
--   ERROR: 42501: permission denied to set parameter "sundial.comment_notify_url"
--
-- It is not grantable, so there is nothing to request. Do NOT "fix" this with
-- `alter role authenticator set ...`: it may work today, it depends on Supabase
-- internals, and a notification path that silently stops after a platform change is
-- precisely the failure mode this design avoids everywhere else.
--
-- The old reasoning about settings-vs-vault is deliberately NOT preserved below,
-- because it argued for an option that does not exist here.
--
-- The same secret must be reachable by the Lambda as COMMENT_NOTIFY_SECRET (Secrets
-- Manager `sundial/comment-notify` first, env var second — see the Lambda's config.js).
--
-- WHY NOT SUPABASE VAULT: still a reasonable home for the secret, and still a second
-- extension to depend on with a fiddlier read path inside a SECURITY DEFINER trigger.
-- The exposure here is bounded the same way it always was — anything that can read
-- `private.app_config` is already the table owner or a superuser, and both can read
-- every comment in the database directly, so the secret grants them nothing new.
-- Moving to vault remains a change to notify_comment_mention() alone.
--
-- WHY NOT A SUPABASE DASHBOARD DATABASE WEBHOOK: it would do the same job in about two
-- clicks and live nowhere in this repo. We have already been burned once by a
-- load-bearing untracked dashboard setting (the Supabase auth email templates). This
-- file is reviewable, diffable and re-runnable; a dashboard toggle is none of those.
--
-- Applied by hand against the Supabase SQL editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- pg_net — the async HTTP client the trigger posts through
-- ---------------------------------------------------------------------------
-- pg_net queues the request in net.http_request_queue and a BACKGROUND WORKER sends it
-- after the transaction commits. That is what makes the post non-blocking, and it is
-- also why the Lambda can safely SELECT the mention row it was told about: by the time
-- the request goes out, the INSERT is committed and visible.
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- private.app_config — configuration with no API surface
-- ---------------------------------------------------------------------------
-- A schema PostgREST does not expose. Supabase exposes `public` (and
-- `graphql_public`); `private` is absent from that list and MUST STAY ABSENT — adding
-- it in Settings → API would publish this table, secret included, to the REST API.
create schema if not exists private;

create table if not exists private.app_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

comment on table private.app_config is
  'Server-side configuration read by SECURITY DEFINER functions. NOT exposed via PostgREST - `private` must never be added to the API exposed-schema list. Rows: comment_notify_url, comment_notify_secret.';

-- Defence in depth. Two independent locks, because either one alone is a single point
-- of failure for a table holding a shared secret:
--
--   1. RLS enabled with NO POLICIES. Postgres denies by default when RLS is on and
--      nothing matches, so any role subject to RLS reads zero rows.
--   2. Explicit REVOKE from the API roles, so even a future policy added by mistake
--      has no privilege to act on.
--
-- NOTE: deliberately NOT `force row level security`. The trigger function is
-- SECURITY DEFINER and runs as this table's OWNER, and an owner bypasses RLS —
-- that bypass is exactly how the function reads its config. FORCE would apply RLS to
-- the owner too and silently break every notification.
alter table private.app_config enable row level security;

revoke all on schema  private            from anon, authenticated;
revoke all on table   private.app_config from anon, authenticated;

-- ---------------------------------------------------------------------------
-- notified_at — the idempotency marker, owned by the Lambda
-- ---------------------------------------------------------------------------
-- pg_net can deliver more than once (its worker retries on some transport failures),
-- and a human can replay a request while debugging. The Lambda stamps this after a
-- SUCCESSFUL send and refuses to send again for a row that already has it.
--
-- It is deliberately NULLABLE with NO default: null means "not yet notified", which is
-- the correct reading for every row that already exists.
--
-- The client never writes this (its RLS insert policy lists the columns it may set);
-- the Lambda writes it with the service role, which bypasses RLS.
alter table comment_mentions
  add column if not exists notified_at timestamptz;

comment on column comment_mentions.notified_at is
  'Set by sundial-comment-notify after a mention email is successfully sent. NULL = not yet notified. Idempotency marker for pg_net redelivery.';

-- Partial index: the only query that reads this column looks for rows still awaiting a
-- notification (a backfill sweep, or a human checking what got missed). Indexing the
-- null side keeps it tiny — the steady state is that almost every row is stamped.
create index if not exists idx_comment_mentions_unnotified
  on comment_mentions (created_at) where notified_at is null;

-- ---------------------------------------------------------------------------
-- The trigger function
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because net.http_post is not granted to `authenticated`, and the
-- INSERT that fires this comes from a browser session. Running as the owner is also
-- what lets it read private.app_config, which every other role is denied.
--
-- search_path is pinned so a caller cannot shadow `net` or `pg_catalog` with a schema
-- of their own — the standard hardening for any SECURITY DEFINER function.
--
-- ⚠️ `private` is deliberately NOT in that search_path. The config reads below are
-- schema-qualified instead, which needs no search_path entry. Widening the search_path
-- of a SECURITY DEFINER function is the exact thing this hardening exists to prevent,
-- so do not "tidy" the qualification away.
create or replace function notify_comment_mention()
returns trigger
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $$
declare
  v_url    text;
  v_secret text;
begin
  -- Read config. SELECT ... INTO leaves the variable NULL when no row matches, so a
  -- missing key behaves exactly like the old missing_ok current_setting() did.
  select nullif(c.value, '') into v_url
    from private.app_config c where c.key = 'comment_notify_url';
  select nullif(c.value, '') into v_secret
    from private.app_config c where c.key = 'comment_notify_secret';

  -- LOUD about being unconfigured. A silent no-op here is exactly how a notification
  -- path rots unnoticed — the comments keep working, so nobody investigates. A WARNING
  -- lands in the Postgres logs on every mention until someone sets the values.
  if v_url is null or v_secret is null then
    raise warning
      'notify_comment_mention: private.app_config is missing comment_notify_url and/or comment_notify_secret - mention % not notified. See sql/sundial_comment_mention_notify.sql.',
      new.id;
    return new;
  end if;

  begin
    perform net.http_post(
      url     := v_url,
      body    := jsonb_build_object(
                   'mention_id',        new.id,
                   'comment_id',        new.comment_id,
                   'mentioned_user_id', new.mentioned_user_id
                 ),
      headers := jsonb_build_object(
                   'Content-Type',            'application/json',
                   'X-Sundial-Comment-Secret', v_secret
                 ),
      -- Short: we are only waiting for the Lambda to ACCEPT the request. Anything
      -- slower than this and the queue is better off moving on.
      timeout_milliseconds := 5000
    );
  exception when others then
    -- SWALLOW. The comment is already saved and that is what the user was doing.
    -- SQLERRM is logged so a broken queue is diagnosable; the insert still returns.
    raise warning
      'notify_comment_mention: net.http_post failed for mention % (%): %',
      new.id, sqlstate, sqlerrm;
  end;

  return new;
end;
$$;

comment on function notify_comment_mention() is
  'AFTER INSERT trigger on comment_mentions: posts { mention_id, comment_id, mentioned_user_id } to the sundial-comment-notify Lambda via pg_net. Never blocks or fails the insert.';

-- AFTER INSERT, FOR EACH ROW: one post per mentioned user. A comment that @-mentions
-- three people inserts three rows and fires three times, which is right — each
-- recipient has their own preference, their own email, and their own notified_at.
--
-- AFTER (not BEFORE) so the row is final and NEW.id is the committed value.
drop trigger if exists trg_comment_mention_notify on comment_mentions;
create trigger trg_comment_mention_notify
  after insert on comment_mentions
  for each row execute function notify_comment_mention();

-- ---------------------------------------------------------------------------
-- Verifying / operating
-- ---------------------------------------------------------------------------
-- Recent pg_net attempts and what came back (the response table is what tells you a
-- 401 from a rotated secret apart from a queue that never drained):
--
--   select id, status_code, error_msg, created
--     from net._http_response order by created desc limit 20;
--
-- Mentions still awaiting a notification:
--
--   select id, comment_id, mentioned_user_id, created_at
--     from comment_mentions where notified_at is null order by created_at desc;
--
-- Confirm the config the trigger will actually read (the secret's VALUE is never
-- printed — only that it is set, and how long it is, which is enough to spot a
-- truncated paste):
--
--   select key,
--          case when key like '%secret%'
--               then '(set, ' || length(value) || ' chars)'
--               else value end as value,
--          updated_at
--     from private.app_config
--    where key in ('comment_notify_url', 'comment_notify_secret')
--    order by key;
--
-- Rotating the secret — update here and in Secrets Manager. Between the two writes
-- the Lambda returns 401 and pg_net records it, so rotate deliberately, not casually:
--
--   update private.app_config set value = '<new secret>', updated_at = now()
--    where key = 'comment_notify_secret';
--
-- To disable notifications without dropping anything (e.g. during a mail incident),
-- remove the URL row — the trigger then warns and returns, and comments keep saving:
--
--   delete from private.app_config where key = 'comment_notify_url';
--
-- Unlike the old ALTER DATABASE approach, this takes effect IMMEDIATELY: the value is
-- read per-invocation from a table, not from a connection's startup parameters, so
-- there is no pooled-connection lag to wait out.
