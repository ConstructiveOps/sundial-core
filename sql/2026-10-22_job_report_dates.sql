-- 2026-10-22 (Harmon, the October 22 batch). Two things, both idempotent. Run in the
-- Supabase SQL editor.
--
-- 1) THE JOB'S THREE REPORT DATES (D-081 amendment 3). Tim added three Date fields to
--    Sundial_Service_Job__c in Setup (describe-confirmed 2026-10-21):
--      Report_Uploaded_to_Partner_Portal__c, Report_Sent_to_Customer__c, Notes_Reported__c
--    Any one going from blank to a date moves a job that is still before Ready to Bill to
--    Ready to Bill (sundial-sf-update, lib/job-status.js). The cache carries them below;
--    lib/cache-row.js maps a field to its column by NAME, so nothing needs registering —
--    the column existing is what turns the field on. NOT in the list projection.
--    After running this, ONE full resync of jobs (Lambda sundial-cache-sync → Test):
--      { "object": "job", "mode": "full" }

alter table sundial_service_job_cache add column if not exists report_uploaded_to_partner_portal date; -- Report_Uploaded_to_Partner_Portal__c
alter table sundial_service_job_cache add column if not exists report_sent_to_customer           date; -- Report_Sent_to_Customer__c
alter table sundial_service_job_cache add column if not exists notes_reported                    date; -- Notes_Reported__c

-- 2) THE SERVER'S OWN LINES IN A CUSTOMER'S FEED (D-084). sundial-sf-update and
--    sundial-service-estimate insert ONE `comments` row when a customer's intake answers
--    change ("Intake updated by … : Q — A; …") and one when Assigned To changes ("Assigned
--    to … by …"). They are written with the service role (no RLS change), carry no
--    @-mentions — so no comment_mentions row and nothing for sundial-comment-notify, whose
--    trigger is on comment_mentions — and are marked here so the portal can show them muted.
--      null      a person's comment (every row before today, every composer)
--      system    written by the server
--    Until this runs, the Lambdas retry the insert without `kind` (lib/intake-comment.js),
--    so the lines land either way; they are just not styled.

alter table public.comments
  add column if not exists kind text
  check (kind is null or kind in ('system'));

comment on column public.comments.kind is
  'null = a person''s comment; system = a line the server wrote (intake answers changed, Assigned To changed — D-084). System lines have no mentions and notify nobody.';
