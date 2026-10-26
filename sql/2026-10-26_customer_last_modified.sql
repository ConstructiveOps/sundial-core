-- 2026-10-26: Salesforce LastModifiedDate on the customer cache, for the dealer list's
-- "last updated" (lambdas/sundial-dealer, list rows' `updatedAt`).
--
-- WHY A NEW COLUMN. The cache had no Salesforce modification time: `last_synced_at` is when
-- WE last wrote the row (a full resync makes every row "updated now"), and `created_date`
-- is creation. cache-sync, sf-query's refresh and the write-through select a Salesforce
-- field only when its column exists (lib/cache-row.js sfFieldToColumn: LastModifiedDate ->
-- `lastmodifieddate`), so this column is what turns the field on — no Lambda change for
-- the sync. LastModifiedDate, not SystemModstamp: SystemModstamp also moves on system-only
-- writes; "last updated" means someone changed the deal.
--
-- Idempotent. After running it, in this order:
--   1. Re-run sql/sundial_dealer_customer_view.sql — the view's `c.*` was expanded when it
--      was created, so the new column is not in the dealer list until the view is re-run
--      (CREATE OR REPLACE appends it at the end, which is all Postgres allows).
--   2. ONE full resync of the customer cache (Lambda sundial-cache-sync → Test):
--        { "object": "customer", "mode": "full" }
--      The incremental sync fills only rows that change afterwards.
-- Until both are done, sundial-dealer returns `updatedAt: null` and logs a warning.

alter table sundial_customer_cache add column if not exists lastmodifieddate timestamptz;  -- LastModifiedDate

notify pgrst, 'reload schema';
