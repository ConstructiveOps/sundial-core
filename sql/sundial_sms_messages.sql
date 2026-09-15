-- sundial_sms_messages — customer text messages, both directions (D-072 amendment 6,
-- 2026-09-15; lambdas/sundial-sms; docs/integrations/sms-twilio.md).
--
-- One row per SMS: OUT rows are written by POST /service/jobs/{id}/sms the moment
-- Twilio accepts the message (status "queued"), then updated by Twilio's status
-- callback (sent -> delivered / undelivered / failed). IN rows are written by the
-- inbound webhook (POST /sms/inbound) after the Twilio signature checks out, matched to
-- the customer's most recent open job by phone number; a text nobody can be matched to
-- is still stored (job_sf_id null) so it is never lost.
--
-- The office reads the thread through GET /service/jobs/{id}/sms — never straight from
-- the browser. The service-role key bypasses RLS; the Lambda filters on client_sf_id
-- every time (D-035). No browser policy exists on purpose.
--
-- NOT a cache table: nothing here mirrors Salesforce, so there are no control columns
-- and the scheduled sync never touches it.

create table if not exists sundial_sms_messages (
  id                 bigint generated always as identity primary key,
  client_sf_id       text not null,                       -- Client__c (tenant isolation key)
  tenant_id          text,                                -- Client__r.Name slug (label only)
  direction          text not null check (direction in ('in', 'out')),
  job_sf_id          text,                                -- Sundial_Service_Job__c (null = inbound text we could not match)
  customer_sf_id     text,                                -- Sundial_Customer__c when known
  from_number        text not null,                       -- E.164
  to_number          text not null,                       -- E.164
  body               text not null default '',
  media              jsonb not null default '[]'::jsonb,  -- inbound MMS: [{ url, contentType }]
  status             text not null default 'queued',      -- queued | sent | delivered | undelivered | failed | received
  error_code         text,                                -- Twilio error code on failure (e.g. 30003)
  provider_sid       text unique,                         -- Twilio MessageSid (idempotency for webhooks)
  sent_by_user_sf_id text,                                -- Sundial_User__c who pressed Send (out only)
  sent_by_name       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- The job thread (oldest first on screen; the index serves either order).
create index if not exists idx_sundial_sms_messages_job
  on sundial_sms_messages (client_sf_id, job_sf_id, created_at desc);
-- Inbound texts nobody could be matched to — the office's "unmatched" list.
create index if not exists idx_sundial_sms_messages_unmatched
  on sundial_sms_messages (client_sf_id, created_at desc)
  where job_sf_id is null;
-- Conversation lookup by phone (matching a reply to the thread it belongs to).
create index if not exists idx_sundial_sms_messages_from
  on sundial_sms_messages (client_sf_id, from_number, created_at desc);

-- Browser access is closed: reads and writes go through the Lambda (service role).
alter table sundial_sms_messages enable row level security;
revoke all on sundial_sms_messages from anon, authenticated;
