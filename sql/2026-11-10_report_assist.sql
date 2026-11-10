-- sql/2026-11-10_report_assist.sql — the report assistant's log and budget (D-092, R4).
-- Run in the Supabase SQL editor, once (re-runnable). Before deploying sundial-reports with
-- POST /reports/assist.
--
-- PREREQUISITE: private.app_config exists (created by sql/sundial_comment_mention_notify.sql,
-- which has run). The limits live there and are read ONLY inside the claim function below:
-- `private` is never exposed through the API, so the Lambda cannot read it directly.
--
--   report_assist_tenant_month_limit   turns per tenant per Arizona calendar month (default 500)
--   report_assist_user_day_limit       turns per user per Arizona day              (default 40)
--
-- To change one (no deploy needed — the next claim reads it):
--   insert into private.app_config (key, value) values ('report_assist_tenant_month_limit', '800')
--     on conflict (key) do update set value = excluded.value, updated_at = now();
-- A missing or non-numeric value means the default. 0 turns the assistant off.
--
-- A TURN is one POST /reports/assist that reaches the model (however many calls it makes
-- inside). It is claimed BEFORE the model is called; an upstream failure (5xx, timeout, the
-- API refusing the request) releases it. A refusal or a question still counts.
--
-- Everything here is service-role only: RLS on with no policies, and every privilege revoked
-- from anon / authenticated. The browser never reads the log or the counters.

-- --- the turn log (90 days; the sundial-reports tick deletes older rows) --------------------
create table if not exists public.sundial_report_assist_log (
  id                  uuid primary key default gen_random_uuid(),
  client_sf_id        text not null,
  profile_id          uuid not null,
  mode                text not null check (mode in ('build', 'refine', 'explain')),
  report_type         text,
  request_text        text,            -- the user's LAST message (or null for explain)
  messages_count      integer not null default 0,
  reply               text,
  question            text,
  definition          jsonb,           -- the validated definition returned, if any — never rows
  outcome             text not null check (outcome in ('definition', 'question', 'explained', 'invalid', 'refused', 'error')),
  attempts            integer not null default 0,
  codes               text[] not null default '{}',   -- validation codes of refused proposals
  strict              boolean,
  model               text,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  cache_read_tokens   integer not null default 0,
  cache_write_tokens  integer not null default 0,
  calls               jsonb not null default '[]'::jsonb,  -- per API call: kind, ms, tokens, stop reason
  ms                  integer,
  created_at          timestamptz not null default now()
);
create index if not exists idx_sundial_report_assist_log_created on public.sundial_report_assist_log (created_at);
create index if not exists idx_sundial_report_assist_log_tenant on public.sundial_report_assist_log (client_sf_id, created_at desc);

-- --- the counters --------------------------------------------------------------------------
-- One row per tenant per month (profile_key '') and per user per day (profile_key = profile id).
create table if not exists public.sundial_report_assist_usage (
  client_sf_id  text not null,
  profile_key   text not null,
  period_kind   text not null check (period_kind in ('month', 'day')),
  period_start  date not null,
  turns         integer not null default 0 check (turns >= 0),
  updated_at    timestamptz not null default now(),
  primary key (client_sf_id, profile_key, period_kind, period_start),
  check ((period_kind = 'month') = (profile_key = ''))
);

alter table public.sundial_report_assist_log enable row level security;
alter table public.sundial_report_assist_usage enable row level security;
revoke all on public.sundial_report_assist_log from public, anon, authenticated;
revoke all on public.sundial_report_assist_usage from public, anon, authenticated;
grant select, insert, update, delete on public.sundial_report_assist_log to service_role;
grant select, insert, update, delete on public.sundial_report_assist_usage to service_role;

-- --- a limit from private.app_config (default when absent / not a whole number ≥ 0) --------
create or replace function public.sundial_report_assist_limit(p_key text, p_default integer)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v text;
begin
  if to_regclass('private.app_config') is null then
    return p_default;
  end if;
  execute 'select value from private.app_config where key = $1' into v using p_key;
  if v is null or btrim(v) !~ '^\d{1,9}$' then
    return p_default;
  end if;
  return btrim(v)::integer;
end;
$$;

-- --- claim one turn: both counters, atomically, or neither --------------------------------
-- Returns { ok, scope?, limit, used, ... , month_start, day } — scope 'tenant' or 'user' when
-- refused; resets_at = when that counter starts over (Arizona midnight, as an instant).
create or replace function public.sundial_report_assist_claim(
  p_client_sf_id text,
  p_profile_id   uuid,
  p_now          timestamptz default now()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  az_day     date := (p_now at time zone 'America/Phoenix')::date;
  az_month   date := date_trunc('month', (p_now at time zone 'America/Phoenix'))::date;
  t_limit    integer := public.sundial_report_assist_limit('report_assist_tenant_month_limit', 500);
  u_limit    integer := public.sundial_report_assist_limit('report_assist_user_day_limit', 40);
  t_used     integer;
  u_used     integer;
  pkey       text;
begin
  if p_client_sf_id is null or btrim(p_client_sf_id) = '' or p_profile_id is null then
    raise exception 'sundial_report_assist_claim: tenant and profile are required';
  end if;
  pkey := p_profile_id::text;

  insert into public.sundial_report_assist_usage (client_sf_id, profile_key, period_kind, period_start)
  values (p_client_sf_id, '', 'month', az_month)
  on conflict do nothing;
  insert into public.sundial_report_assist_usage (client_sf_id, profile_key, period_kind, period_start)
  values (p_client_sf_id, pkey, 'day', az_day)
  on conflict do nothing;

  -- Lock in one fixed order (month row, then day row): two claims never deadlock.
  select turns into t_used from public.sundial_report_assist_usage
   where client_sf_id = p_client_sf_id and profile_key = '' and period_kind = 'month' and period_start = az_month
   for update;
  select turns into u_used from public.sundial_report_assist_usage
   where client_sf_id = p_client_sf_id and profile_key = pkey and period_kind = 'day' and period_start = az_day
   for update;

  if t_used >= t_limit then
    return jsonb_build_object('ok', false, 'scope', 'tenant', 'limit', t_limit, 'used', t_used,
      'resets_at', ((az_month + interval '1 month')::timestamp at time zone 'America/Phoenix'));
  end if;
  if u_used >= u_limit then
    return jsonb_build_object('ok', false, 'scope', 'user', 'limit', u_limit, 'used', u_used,
      'resets_at', ((az_day + 1)::timestamp at time zone 'America/Phoenix'));
  end if;

  update public.sundial_report_assist_usage set turns = turns + 1, updated_at = now()
   where client_sf_id = p_client_sf_id and profile_key = '' and period_kind = 'month' and period_start = az_month;
  update public.sundial_report_assist_usage set turns = turns + 1, updated_at = now()
   where client_sf_id = p_client_sf_id and profile_key = pkey and period_kind = 'day' and period_start = az_day;

  return jsonb_build_object('ok', true,
    'tenant_used', t_used + 1, 'tenant_limit', t_limit,
    'user_used', u_used + 1, 'user_limit', u_limit,
    'month_start', az_month, 'day', az_day);
end;
$$;

-- --- release a claimed turn (the model never answered) ------------------------------------
-- Takes the periods the claim returned, so a release just after midnight lands on the right rows.
create or replace function public.sundial_report_assist_release(
  p_client_sf_id text,
  p_profile_id   uuid,
  p_month_start  date,
  p_day          date
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  update public.sundial_report_assist_usage set turns = turns - 1, updated_at = now()
   where client_sf_id = p_client_sf_id and profile_key = '' and period_kind = 'month' and period_start = p_month_start and turns > 0;
  update public.sundial_report_assist_usage set turns = turns - 1, updated_at = now()
   where client_sf_id = p_client_sf_id and profile_key = p_profile_id::text and period_kind = 'day' and period_start = p_day and turns > 0;
end;
$$;

-- PUBLIC first, or anon / authenticated keep EXECUTE through it.
revoke all on function public.sundial_report_assist_limit(text, integer) from public, anon, authenticated;
revoke all on function public.sundial_report_assist_claim(text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.sundial_report_assist_release(text, uuid, date, date) from public, anon, authenticated;
grant execute on function public.sundial_report_assist_limit(text, integer) to service_role;
grant execute on function public.sundial_report_assist_claim(text, uuid, timestamptz) to service_role;
grant execute on function public.sundial_report_assist_release(text, uuid, date, date) to service_role;

-- Check (must return false, false):
select has_function_privilege('anon', 'public.sundial_report_assist_claim(text, uuid, timestamptz)', 'execute') as anon_can_claim,
       has_table_privilege('authenticated', 'public.sundial_report_assist_log', 'select') as authenticated_can_read_log;
