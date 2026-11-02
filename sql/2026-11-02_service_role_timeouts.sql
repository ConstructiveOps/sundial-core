-- sql/2026-11-02_service_role_timeouts.sql — give service_role its own statement / lock timeouts.
--
-- WHY. Every Lambda writes to Supabase through PostgREST with the service-role key, so its
-- statements run as `service_role`. That role had no settings of its own, and PostgREST
-- switches into it from `authenticator`, which carries Supabase's defaults
-- statement_timeout = 8s and lock_timeout = 8s. So every Lambda write had always had an
-- 8-second ceiling. Nobody noticed until R0 (D-087) widened the cache tables: on 2026-11-02 the
-- first full customer resync failed with `cache_upsert_failed` — "canceling statement due to
-- statement timeout" — because one page upsert (200 rows × ~330 columns) took longer than 8 s.
--
-- 120 s covers the widest page upsert with room to spare and is still far under the Lambda's
-- 15-minute limit; 30 s for locks keeps a write that waits on another from hanging a run.
-- `anon` / `authenticated` (the browser) keep the 8 s defaults — this touches service_role only.
--
-- Idempotent: `alter role … set` replaces the value; run it as often as you like.
-- A NEW Supabase project (a new client's, docs/multi-client-deployment.md) needs it too.
--
-- Check afterwards:
--   select rolname, rolconfig from pg_roles where rolname in ('service_role', 'authenticator');

alter role service_role set statement_timeout = '120s';
alter role service_role set lock_timeout = '30s';

-- PostgREST caches role settings; tell it to reload so the next request uses them.
notify pgrst, 'reload config';
