-- 2026-10-12 (Harmon): the office's weekly correction to a tech's Time Outside Calls.
--
-- WHY. Payroll's Time Outside Calls is arithmetic over the clock logs (the day's span minus
-- the union of its call intervals — D-076). Harmon finds it wrong often enough — a day
-- started at the wrong moment, a forgotten tap, a lunch nobody clocked — that fixing it
-- day by day on the dispatch board was too slow when the week is already on the payroll
-- screen. Tim (2026-10-12): Admins / Executives type the hours the week SHOULD show, with
-- a reason, from the Payroll tab. The computed number stays visible next to it, nothing
-- in Salesforce's clock logs is touched, and clearing the row brings the arithmetic back.
--
-- One row per tenant × tech × week (Monday). Written only by the board Lambda through the
-- service role (lib/payroll-adjustments.js); the browser never reads or writes it.
--
-- Idempotent. Run it in the Supabase SQL editor BEFORE deploying sundial-service-board;
-- the last query must print false, false (browser roles cannot touch it).

create table if not exists public.sundial_payroll_adjustments (
  id               bigint generated always as identity primary key,
  client_sf_id     text        not null,
  tech_sf_id       text        not null,
  week_monday      date        not null,
  outside_minutes  integer     not null check (outside_minutes >= 0 and outside_minutes <= 10080),
  computed_minutes integer,                      -- what the arithmetic said when the office set it
  reason           text        not null,
  set_by_sf_id     text,
  set_by_name      text,
  set_at           timestamptz not null default now(),
  unique (client_sf_id, tech_sf_id, week_monday)
);
alter table public.sundial_payroll_adjustments enable row level security; -- no policies: service role only
revoke all on table public.sundial_payroll_adjustments from public, anon, authenticated;
grant select, insert, update, delete on table public.sundial_payroll_adjustments to service_role;

select
  has_table_privilege('anon', 'public.sundial_payroll_adjustments', 'SELECT')          as anon_can_read,
  has_table_privilege('authenticated', 'public.sundial_payroll_adjustments', 'SELECT') as authenticated_can_read;
