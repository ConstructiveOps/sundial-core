# Sundial — Progress Log

## 2026-07-22 — Portal identity: access-control fields (Access_Level__c, Super_Admin__c)

Extended the portal identity to carry the new access-control fields (UI gating only; enforcement is a later frontend task + future user-admin endpoints).

- **Verified live** (describe against `Sundial_User__c`): `Access_Level__c` (picklist: Executive, Manager, Admin, Sales Dealer, Sales Rep, Technician), `Super_Admin__c` (boolean), and `Default_Department__c` (picklist: Residential Solar, Roofing, Service, Commercial) all exist. `Default_Department__c` confirmed present, so it's included.
- **`lib/identity.js`**: added the three fields to `USER_FIELDS` and to the returned `user` object — `accessLevel`, `superAdmin` (strict `=== true`, fail closed), `defaultDepartment`; JSDoc updated. Also verified the full `USER_FIELDS` SELECT runs against SF (no `INVALID_FIELD`, so `/auth/me` can't 500 on the new fields).
- **`sundial-auth-proxy`**: no structural change — it returns `identity.user` as-is, so the fields flow automatically. `upsertProfile` left unchanged: confirmed `public.profiles` has **no** `access_level`/`is_super_admin` columns, and Supabase schema changes are out of scope.
- **Deployed only `sundial-auth-proxy`** (CodeSha256 `R20Q4NUY1hqO…`, settled). Other Lambdas bundle `lib/identity.js` but none read the new fields — they pick up the change on their next routine deploy.
- **Docs**: corrected the stale `/auth/me` example in `docs/api-endpoints.md` (removed fictional `roles`/`enabledModules`/`sundialUserId`, the slug `tenantId`, and the "Skeleton deployed" note) to the real `{ user{…, accessLevel, superAdmin, defaultDepartment}, tenant{clientId} }` shape. Added **DECISIONS.md D-043** (the access model).
- **Pending**: live `GET /auth/me` curl needs a valid portal-user Supabase token (Tim to supply). Guardrails honored: no changes to other Lambdas, caching, or API Gateway; `Super_Admin__c`/`Access_Level__c` are read-only everywhere.

## 2026-07-21 — Budget calculator: deployment & integration (parallel build)

Integrated the verified budget calculation engine (`budget-lambda.zip`) into the repo
and built the surrounding wiring. Design unchanged — deployment/integration only.

**Lambda (`lambdas/sundial-budget/`)**
- Placed the package under our `lambdas/<name>/` convention (spec said `lambda/budget/`).
- `npm install` + `npm test` → **32/32** field checks against the HOLLAND workbook. `budgetCalc.js` untouched.
- Rewrote `handler.js` to ESM using `lib/salesforce.js` (org-standard JWT bearer flow); **dropped jsforce**. Reads via `sfQuery`, writeback via a new shared `lib/salesforce.js » sfUpdateRecord`.
- Template: kept `template/budget-template.xlsx` as source of record; `prebuild.mjs` base64-embeds it into the bundle at deploy time, `postbuild.mjs` cleans up; `deploy.ps1` gained generic pre/post-build hooks. Tests read the source `.xlsx`, so tested == shipped bytes.
- Bundle validated via esbuild (3.6 MB after dropping jsforce; 4.5 MB with the added libs).

**Task 2 — recalc endpoint:** handler HTTP path now verifies the Supabase JWT (`resolveIdentity`) and tenant-scopes the record read; documented `POST /projects/{recordId}/budget/recalc` in `docs/api-endpoints.md`; gateway wiring delivered as `scripts/wire-budget-recalc-route.ps1` (not yet run against prod).

**Task 4 — file metadata:** added best-effort `lib/file-access.js » registerFileMetadata`; handler registers each snapshot (category "Budget") in Supabase. Flagged: the deployed Files tab lists from S3, so the snapshot already appears; this aligns with the documented Supabase-backed design.

**Task 3 — triggers:** drafted the after-save Flow `salesforce/flows/Sundial_Budget_Recalc_Trigger.flow-meta.xml` (loop guard on `Budget_Last_Calculated__c`; entry split into two sub-3900-char formulas since 73 `ISCHANGED` terms exceed the formula limit) + `docs/integrations/budget-recalc-relay.md`.

**Task 5 — Acumatica ProjectBudget:** built read + reconcile scaffolding only (`lambdas/sundial-acumatica-budget-push/`, `lib/acumatica.js » getAcumaticaEntity`). **Write path hard-guarded off** — the mapping tab has no `InventoryID` column (match key not unique) and the income code is `BILL` (unconfirmed vs `BALANCE`/`GENM`). Documented in `docs/integrations/acumatica-budget-push.md`.

**Housekeeping:** moved `budget-lambda.zip` + `sundial-budget-deploy.zip` into git-tracked `artifacts/`; added `exceljs` to root deps.

**Pending:** AWS function `sundial-budget` creation (Tim) → deploy → Gate 2 smoke test; prod API Gateway route deploy; relay wiring; the blocked-on-Harmon items in TASKS.md.
