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
-- Both are read from database settings, so this file is safe to commit and the secret
-- can be rotated without editing the repo. Set them ONCE per project:
--
--   alter database postgres set sundial.comment_notify_url =
--     'https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod/webhooks/comment-mention';
--   alter database postgres set sundial.comment_notify_secret = '<the shared secret>';
--
-- ⚠️ ALTER DATABASE ... SET only applies to NEW connections. Supabase pools
-- connections, so it can take a minute (or a pooler restart) before the trigger sees
-- the values. Verify with:
--
--   select current_setting('sundial.comment_notify_url', true) as url,
--          coalesce(nullif(current_setting('sundial.comment_notify_secret', true), ''), null)
--            is not null as secret_set;
--
-- The same secret must be reachable by the Lambda as COMMENT_NOTIFY_SECRET (Secrets
-- Manager `sundial/comment-notify` first, env var second — see the Lambda's config.js).
--
-- WHY SETTINGS AND NOT SUPABASE VAULT: vault is the better home for a secret, but it is
-- a second extension to depend on and its read path inside a SECURITY DEFINER trigger
-- is fiddlier. The exposure here is bounded — a database setting is readable by the
-- `postgres` superuser role, which can already read every comment in the database
-- directly, so the secret grants that role nothing it did not already have. Moving to
-- vault is a drop-in change to notify_comment_mention() alone if that ever stops being
-- true.
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
-- INSERT that fires this comes from a browser session. search_path is pinned so a
-- caller cannot shadow `net` or `pg_catalog` with a schema of their own — the standard
-- hardening for any SECURITY DEFINER function.
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
  -- Read config. `true` = missing_ok, so an unset setting is NULL rather than an error.
  v_url    := nullif(current_setting('sundial.comment_notify_url', true), '');
  v_secret := nullif(current_setting('sundial.comment_notify_secret', true), '');

  -- LOUD about being unconfigured. A silent no-op here is exactly how a notification
  -- path rots unnoticed — the comments keep working, so nobody investigates. A WARNING
  -- lands in the Postgres logs on every mention until someone sets the values.
  if v_url is null or v_secret is null then
    raise warning
      'notify_comment_mention: sundial.comment_notify_url and/or sundial.comment_notify_secret is not set - mention % not notified. See sql/sundial_comment_mention_notify.sql.',
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
-- To disable notifications without dropping anything (e.g. during a mail incident),
-- unset the URL — the trigger then warns and returns:
--
--   alter database postgres reset sundial.comment_notify_url;
