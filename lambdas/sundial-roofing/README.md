# sundial-roofing (scaffold — 2026-09-24)

Placeholder folder for the Roofing module Lambda that `docs/roofing-revamp-plan.md` Phase 1 and 2
build (POST /roofing/customers, POST /roofing/projects, roofing address lookup,
POST /roofing/{recordId}/budget/recalc).

- `budget-src-july/` — the July-22 cell-for-cell port of Harmon's OLD roofing budget sheet
  (from `harmon-crm/roofing-budget-lambda.zip`). Phase 2 starts from it; every cell shifts +1 row
  and the Sold With Solar model replaces the four independent markups (see the plan §3).
- `template/roofing-budget-master.xlsx` — Harmon's 2026-09-24 budget master, untouched. The
  recalc fills a values-only snapshot of it per project (same pattern as `sundial-budget`).
