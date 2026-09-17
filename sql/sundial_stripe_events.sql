-- sundial_stripe_events — the Stripe webhook ledger (D-072 amendment 8, 2026-09-17;
-- lambdas/sundial-service-estimate/stripe.js; docs/integrations/stripe.md).
--
-- One row per Stripe event the webhook accepted, keyed by Stripe's own event id, so a
-- redelivered event is a no-op (Stripe retries on any non-2xx and can deliver twice).
-- The row records what Sundial DID with it:
--   applied   — a Payment row was written / updated and the money settled
--   deferred  — the money arrived before the job existed (a deposit paid on an
--               estimate that has no job yet); Create Job picks these up and writes
--               the Payment row then
--   ignored   — an event type we do not act on, or one for another tenant
--   error     — Sundial failed while applying it (the message is in `error`); the
--               event is answered 500 so Stripe retries it
--
-- TENANT ISOLATION: client_sf_id is the isolation key (D-035). The webhook resolves the
-- tenant from the URL's slug + the event's metadata and refuses a mismatch.
--
-- NOT a cache table: nothing here mirrors Salesforce.

create table if not exists sundial_stripe_events (
  id                 text primary key,                    -- Stripe event id (evt_…)
  client_sf_id       text not null,                       -- Client__c (tenant isolation key)
  tenant_id          text,                                -- tenant slug (label)
  type               text not null,                       -- payment_intent.succeeded, checkout.session.completed, …
  kind               text,                                -- setup | deposit | balance | charge (from our metadata)
  mode               text,                                -- test | live (which keys signed it)
  estimate_sf_id     text,
  job_sf_id          text,
  invoice_sf_id      text,
  payment_sf_id      text,                                -- the Sundial_Service_Payment__c row it produced / touched
  payment_intent_id  text,                                -- pi_…
  amount             numeric(12,2),                       -- dollars, as Stripe reported
  status             text not null,                       -- applied | deferred | ignored | error
  error              text,
  payload            jsonb not null default '{}'::jsonb,  -- the event's data.object, for the office / for replay
  received_at        timestamptz not null default now(),
  applied_at         timestamptz
);

-- Deferred deposits waiting for their job; the office's "what happened to that card" lookup.
create index if not exists idx_sundial_stripe_events_estimate
  on sundial_stripe_events (client_sf_id, estimate_sf_id, status);
create index if not exists idx_sundial_stripe_events_job
  on sundial_stripe_events (client_sf_id, job_sf_id, received_at desc);
create index if not exists idx_sundial_stripe_events_pi
  on sundial_stripe_events (client_sf_id, payment_intent_id);

-- Browser access: none. Only the Lambdas (service role) read or write this table.
alter table sundial_stripe_events enable row level security;
revoke all on sundial_stripe_events from anon, authenticated;
