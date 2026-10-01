-- Events on the dispatch board (2026-10-01): two columns on the service-call cache so the
-- cache-sync Lambda carries them (the board itself reads Salesforce directly). Re-runnable.
alter table sundial_service_call_cache add column if not exists event_name    text;  -- Event_Name__c
alter table sundial_service_call_cache add column if not exists event_details text;  -- Event_Details__c
