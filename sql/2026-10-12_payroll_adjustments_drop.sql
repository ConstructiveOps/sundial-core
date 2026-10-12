-- 2026-10-12 (evening): the weekly Time Outside Calls override lasted one afternoon.
--
-- The morning's sql/2026-10-12_payroll_adjustments.sql created sundial_payroll_adjustments —
-- one typed number per tech per week over the arithmetic. Harmon then asked for the day's
-- clock-in / clock-out to be fixable instead (POST /service/payroll/day — a `correction`
-- entry on the day's own Day_Log__c, Time Outside Calls recomputed from the corrected span,
-- so the report is right BY DAY). The table has no reader or writer any more; drop it.
-- Idempotent. Safe to run whether or not the morning's file was ever run.

drop table if exists public.sundial_payroll_adjustments;
