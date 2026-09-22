-- 2026-09-21 — let a login be deleted without losing the team's notes.
--
-- Two foreign keys pointed at auth.users with no delete rule, so Supabase's
-- Authentication → Users → Delete failed with "Database error deleting user" for anyone
-- who had ever written a comment or been @-mentioned.
--
--   comments.author_id            → SET NULL: the note outlives its author (author_name
--                                   is snapshotted on the row, so the feed still reads)
--   comment_mentions.mentioned_user_id → CASCADE: a mention of nobody means nothing
--
-- Re-runnable. Everything else that references a user already cascades (profiles,
-- user_preferences); the notification tables carry no foreign key on purpose.

alter table public.comments
  drop constraint if exists comments_author_id_fkey;
alter table public.comments
  alter column author_id drop not null;
alter table public.comments
  add constraint comments_author_id_fkey
    foreign key (author_id) references auth.users(id) on delete set null;

alter table public.comment_mentions
  drop constraint if exists comment_mentions_mentioned_user_id_fkey;
alter table public.comment_mentions
  add constraint comment_mentions_mentioned_user_id_fkey
    foreign key (mentioned_user_id) references auth.users(id) on delete cascade;
