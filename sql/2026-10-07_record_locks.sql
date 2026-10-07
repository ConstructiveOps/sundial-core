-- 2026-10-07 (D-082): per-record write locks — one writer at a time per Salesforce record.
--
-- WHY. Two Welcome Call orphan-match invocations for the same customer ran concurrently on
-- 2026-10-07 (Dora Tolle, a1P7y00000BOqojEAD — requests e1909751… and ccd211a7…, both
-- 15:15:17 → 15:15:22 UTC, separate containers). Each read the record, merged its own call
-- into Welcome_Call_Log__c / Welcome_Call_Status__c and wrote the whole field back; the
-- voicemail's write landed last and erased the Verified one. Zapier loop iterations have no
-- ordering or non-overlap guarantee, so the Lambda serialises its own writes.
--
-- THE PRIMITIVE: a lock ROW with a TTL, taken and released by two service-role-only
-- functions. Not a Postgres advisory lock: PostgREST hands each request a pooled connection
-- and ends its transaction, so a session advisory lock would leak onto another request and
-- a transaction-scoped one would be released before the caller's Salesforce write.
--
--   sundial_record_lock_acquire(key, holder, ttl_seconds) → true when this holder now holds
--     it: one INSERT … ON CONFLICT DO UPDATE … WHERE the existing lock has EXPIRED — atomic,
--     so two callers can never both get true for the same key.
--   sundial_record_lock_release(key, holder) → deletes the row only if THIS holder owns it
--     (a holder whose lock expired and was taken over cannot release the new owner's).
--
-- The TTL (lib/record-lock.js: 90 s) is longer than the Lambda's 60 s timeout, so an
-- expired lock always means its holder is gone. Callers re-read the record AFTER acquiring.
--
-- Idempotent. Run it in the Supabase SQL editor BEFORE deploying sundial-welcome-call; the
-- last query must print false, false, false, false (browser roles cannot touch any of it).

create table if not exists public.sundial_record_locks (
  lock_key    text primary key,
  holder      text not null,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);
alter table public.sundial_record_locks enable row level security; -- no policies: service role only
revoke all on table public.sundial_record_locks from public, anon, authenticated;
grant select, insert, update, delete on table public.sundial_record_locks to service_role;

create or replace function public.sundial_record_lock_acquire(p_key text, p_holder text, p_ttl_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_got text;
begin
  if p_key is null or p_key = '' or p_holder is null or p_holder = '' then
    raise exception 'sundial_record_lock_acquire: key and holder are required';
  end if;
  insert into public.sundial_record_locks as l (lock_key, holder, acquired_at, expires_at)
  values (p_key, p_holder, now(), now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 90), 1)))
  on conflict (lock_key) do update
    set holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
    where l.expires_at < now()
  returning l.holder into v_got;
  return v_got is not distinct from p_holder;
end;
$$;

create or replace function public.sundial_record_lock_release(p_key text, p_holder text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  with gone as (
    delete from public.sundial_record_locks where lock_key = p_key and holder = p_holder returning 1
  )
  select exists (select 1 from gone);
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC, which anon and authenticated inherit:
-- revoke from all three, grant to the service role alone (the D-080 lesson).
revoke all on function public.sundial_record_lock_acquire(text, text, integer) from public, anon, authenticated;
revoke all on function public.sundial_record_lock_release(text, text) from public, anon, authenticated;
grant execute on function public.sundial_record_lock_acquire(text, text, integer) to service_role;
grant execute on function public.sundial_record_lock_release(text, text) to service_role;

-- Check: must print false, false, false, false.
select
  has_function_privilege('anon', 'public.sundial_record_lock_acquire(text, text, integer)', 'execute') as anon_acquire,
  has_function_privilege('authenticated', 'public.sundial_record_lock_acquire(text, text, integer)', 'execute') as auth_acquire,
  has_table_privilege('anon', 'public.sundial_record_locks', 'select') as anon_table,
  has_table_privilege('authenticated', 'public.sundial_record_locks', 'select') as auth_table;
