# Sundial — Progress Log

## 2026-07-28 — Fix: list views capped at 50 + cache holding only a fraction of a bulk load

Priority bug: after a ~40k-record bulk load, Customers and Solar list views showed exactly 50 each. Traced the whole pipeline — the "50" was TWO stacked defects plus an incomplete cache.

- **Root cause A — `sfQuery` never followed `nextRecordsUrl`** (`lib/salesforce.js`). Salesforce REST returns ≤2000 rows per page; the helper returned only page 1, silently truncating every large read. Fixed to page the query locator to exhaustion (optional `maxRecords` cap). This is the linchpin — it capped cache-sync and any SF fallback.
- **Root cause B — list endpoint page-size cap** (`sundial-sf-query`): `DEFAULT_LIMIT=50`, and the cache query did `.limit(50)` with **no offset and no total**. Rewrote `handleListRead` as real server-side pagination: `?limit`(≤500)+`?offset`, `count:"exact"` → `total`, stable `ORDER BY sf_id` (pages don't shift on re-sync), per-page freshness refresh only (never scans the 32k table), `{ total, limit, offset, hasMore }` in the response. Page-aware cold-cache SF fallback added. Generic across all allowlisted objects.
- **Root cause C — cache incomplete**: incremental sync pulled one 2000-row batch per run (watermark chipping), so the customer cache held 12,450 of 31,948. Added a **full-resync mode** to `sundial-cache-sync` (`{ "mode": "full" }`, optional `object`) that ignores the watermark window and pulls every record via the now-paginating `sfQuery`; removed the per-run `LIMIT` (also fixes a SystemModstamp-tie page-split bug). Bumped the function to **900 s / 1024 MB**.
- **Backfill run + verified:** customer 12,450→**31,948** and solar 4,017→**4,545** — both now **match Salesforce exactly**. Paginated API verified live with a real token: `offset=0`/`offset=100` return distinct pages, every response carries `total=31948`, `limit=999999` caps at 500.
- Deployed: `sundial-cache-sync`, `sundial-sf-query`. Docs: `api-endpoints.md` (paged shape), `caching-architecture.md` (full-resync runbook).
- **Frontend (harmon-crm) — NOT changed here; report handed off:** the list pages fetch once with no params (→50) and group all rows client-side; boards would try to render 40k cards. They need to send `limit`/`offset`, read `total`, add a pager/load-more, and switch boards to per-stage counts+lazy loading. Full change list in the bug report.

## 2026-07-23 — sundial-user-admin: invite redirect + unban hardening

Two fixes on `feature/user-admin`, both deployed (`CodeSha256 xvyFLarP…`).

- **Invite redirect:** `inviteUserByEmail` now passes `redirectTo` → `<PORTAL_BASE_URL>/reset-password`, so invited users land on the set-password page. `PORTAL_BASE_URL` is a Lambda **env var** (defaults to `https://harmon-crm.vercel.app`); at go-live, set it to Harmon's real domain — a config change, no code edit/redeploy.
- **Unban hardening:** investigated a reported "reactivated but still banned" case. The unban primitive and the exact flow logic both work end to end (ban → fresh login `400 user_banned` → unban → fresh login `200`); the earlier verify only checked `/auth/me` with a *cached* JWT (reflects SF `Active__c`, not the ban), so it never exercised login. Root-cause hypothesis: a transient `updateUserById` failure flagged-but-swallowed, leaving the ban stuck. Fix: `setSupabaseBan()` retries the ban/unban 3× with backoff; still non-fatal (SF `Active__c` is source of truth), still surfaced via `supabaseBanFailed`. Commits `c849fa5` (unban), redirect + docs follow.
- Docs: `api-endpoints.md` POST (redirect + `PORTAL_BASE_URL`) and PATCH (retry) notes updated. Deployed-API end-to-end re-verify skipped per Tim; flow logic proven locally.

## 2026-07-23 — User management backend: sundial-user-admin (D-044)

Built the D-043 admin surface: a new `sundial-user-admin` Lambda for Super Admins to list/create/update/deactivate portal users. On `feature/user-admin`.

- **Auth:** every route runs `resolveIdentity` then requires `user.superAdmin === true` (fail closed → 403 `NOT_SUPER_ADMIN`); tenant-scoped on `Client__c` from the token. `Super_Admin__c`/`Client__c`/`Supabase_User_Id__c` never writable from input; email not PATCH-editable; self-deactivation blocked.
- **POST** = duplicate-guard (409) → Supabase auth (`invite`|`password`, reuses an existing auth user by email) → `Sundial_User__c` create (force-stamped `Client__c`), with a **compensating auth-user delete** if the SF create fails after a fresh auth user was made (`orphanAuthUser: true` if the delete also fails).
- **PATCH** = whitelisted fields; `active` toggles the Supabase **ban** (defense-in-depth, non-fatal → `supabaseBanFailed`). Salesforce `Active__c` is the source of truth.
- Reuses existing libs only (`lib/identity`, `lib/supabase` service-role, `lib/salesforce` `sfCreateRecord`/`sfUpdateRecord`, `lib/http`). No new npm deps. Bundles clean (2.0 MB).
- **`scripts/wire-user-admin-routes.ps1`** written (AWS_PROXY GET/POST on `/admin/users`, PATCH on `/admin/users/{id}`, + OPTIONS; ASCII/`Continue`/exit-code-checked, mirroring the corrected budget wire script). Committed `6c06f77`.
- Docs: `api-endpoints.md` "Admin — User Management" section; DECISIONS.md **D-044**.
- **Pending (needs Tim):** create the `sundial-user-admin` Lambda function; explicit go-ahead to run the wire script (live prod gateway) + `deploy.ps1`; a Super-Admin token to run the end-to-end verify (GET/POST/PATCH + 403 for non-super-admin + `USER_INACTIVE` on the deactivated user's `/auth/me`).

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
