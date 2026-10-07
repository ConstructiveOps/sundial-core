-- 2026-10-07 — where a comment was written (Harmon: "@-mention links from Service open
-- the Sales customer view").
--
-- A Customer's comment thread is ONE thread shared by the Sales page (/customers/{id})
-- and the Service page (/service/customers/{id}) — on purpose, both departments see one
-- conversation. That left the mention alert no way to know which page the comment came
-- from, so every customer link went to Sales. `context` is the module the composer was
-- on when it posted: the link follows the comment's origin, not the reader's department.
--
--   null      an older comment, or a composer that does not say → the old link (Sales)
--   sales     /customers/{id}
--   service   /service/customers/{id}  (jobs are Service-only already)
--   solar     /projects/solar/{id}
--   roofing   /projects/roofing/{id}
--
-- RLS is untouched: the row is inserted by its author under the existing insert policy,
-- and `context` is a plain column on it. Run in the Supabase SQL editor (idempotent).

alter table public.comments
  add column if not exists context text
  check (context is null or context in ('sales', 'service', 'solar', 'roofing'));

comment on column public.comments.context is
  'The module the composer was on (sales | service | solar | roofing); the mention link follows it. Null = unknown (links as Sales).';
