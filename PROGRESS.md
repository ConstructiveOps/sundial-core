# Sundial — Progress Log

## 2026-08-02 — Chore: purge stale "BILL" income-task references

Docs/comments only — no functional or logic changes. Gate 5a confirmed the ProjectBudget income is TWO lines (`BALANCE` = Balance of Contract + `GENM/BILLING` = Solar Material); there is no `BILL` task. `MAPPING_ROWS` and `docs/integrations/acumatica-budget-push.md` already reflected this; three stale spots did not, and are now corrected:

- `lambdas/sundial-acumatica-budget-push/index.js`: header comment (B) now states the confirmed two-line income model and cites the real second blocker (geo commission task code) instead of "confirm BILL vs BALANCE/GENM"; the `writeBudgetLines` throw message and the reconcile `blockers[]` entry now cite InventoryIDs + geo commission task code (income removed as a blocker). The write path is still hard-guarded (throw unchanged in behavior).
- Added a one-line note at the `MAPPING_ROWS` definition explaining the 18-code-rows vs 17-sheet-rows count (income split = 2 code rows from 1 sheet row).
- `PROGRESS.md` (2026-07-21 Task 5 entry) corrected: income is no longer described as unconfirmed `BILL`.

`DECISIONS.md` untouched (no decision made); no InventoryIDs resolved; no logic touched.

## 2026-07-30 — Harmon feedback batch: describe-cache TTL, Aurora design-request route, SES scaffold

Three items from Harmon feedback.

**1. Utility Password save failure (fixed, D-045).** Root cause: `sundial-sf-update` and `sundial-sf-query` cached the SF describe forever (refresh only on 401). The describe carries per-integration-user FLS; when the budget permission set was assigned this week (granting edit FLS on fields like `Utility_Password__c`), warm containers with a pre-grant describe kept rejecting the field — and the write Lambda rejects the WHOLE PATCH if any one field is non-writable, so the entire save failed intermittently. No SF error and no reproducible failure once containers had a fresh describe (verified: every direct + deployed write path returns 200). Fix: 5-minute TTL on the describe cache in both Lambdas (a 401 still forces an immediate refresh; sf-query also clears its derived field cache on refresh). Redeployed both to flush stale containers. Security note: `Utility_Password__c` is plaintext (not encrypted, not mirrored to the Supabase cache) — flagged for a Shield/off-platform decision.

**2. Aurora "Submit Design Request" (built + wired).** The `sundial-aurora-push` Lambda (already built: JWT auth, tenant-scoped, idempotent) gained a Solar-triggered entry: `POST /projects/{solarId}/design-request/submit` resolves the Solar record's linked customer server-side (tenant-scoped) and pushes THAT customer to Aurora. Route wired via `scripts/wire-design-request-route.ps1` (budget/recalc treatment: AWS_PROXY + MOCK OPTIONS CORS + invoke permission), deployed to prod. Handler structured with a marked seam so the future "email the sales manager" step (post-SES) is additive — no route/contract reshape. Verified end to end (CORS preflight, full Solar→Customer→Aurora push + writeback, 401/400 guards); the one real Aurora project created during verification was deleted and its SF writeback cleared. Docs: `docs/api-endpoints.md`.

**3. SES groundwork (scaffold only, not wired).** Added `lib/email.js` — a shared SES v2 `sendEmail()` wrapper (env-driven `EMAIL_FROM`/`SES_REGION`/…, best-effort by default, `isEmailConfigured()` for graceful degradation). Added `@aws-sdk/client-sesv2` dependency. NOT imported by any feature yet. This is the shared sender for the design-request notify, @-mention alerts, and (optionally) Supabase Auth emails. DNS/prod-access steps handed to Tim; the `solar-portal-api` IAM user lacks `ses:*` so the domain identity must be created in-console (or grant SES perms).

## 2026-07-29 — Incident: user provisioning "broken in prod" — root cause = email delivery

Reported: newly created users can't log in, no set-password redirect, reset emails don't work. Traced the full flow; **the fast-forwarded feature/user-admin work (invite redirect + unban) is NOT the cause** — its diff only touched the `invite` branch + the ban helper, not the password path.

**Root cause: Supabase's built-in email does not deliver** to external (harmonelectric.net) recipients — so every email-dependent step silently fails. Confirmed by isolating each piece:
- **Password path works.** Replicating the Lambda's `createUser({password, email_confirm:true, must_change_password:true})` then a real anon `signInWithPassword` → **HTTP 200**, with an `email` identity. Temp-password login is fine.
- **Redirect is honored.** `admin.generateLink({type:'recovery'})` mints a valid link with `redirect_to=harmon-crm…/reset-password` — so `/reset-password` IS allowlisted; the link just never gets emailed.
- **The failures are all delivery:** invite emails (7 of this morning's 10 users were created in the frontend's *default* `invite` mode → no password set), the `/reset-password` landing (only reachable via the emailed link), and `resetPasswordForEmail`.
- Not the cause: unconfirmed users (`mailer_autoconfirm=true`), bans (none), project mismatch (frontend + backend both `qfsdpkwxahakegjnyijj`), the user-admin diff.

**Fix (email-independent, ships today):** frontend now defaults to the **temporary-password** path (proven working) and disables the invite option until real email exists; login's forgot-password copy routes users to their admin. Backend needed no change.

**Recovery (fix in place, no delete/recreate):** `scripts/recover-provisioned-users.mjs` reset a fresh temp password + `must_change_password:true` on all 10 of this morning's `@harmonelectric.net` accounts (the linked `Sundial_User__c` records are untouched). Credentials written to a local file for secure hand-off; spot-checked one live login (HTTP 200, force-change flag set).

**Verification:** `scripts/verify-provisioning.mjs` — create → temp-password login → force-change gate fires → set new password + clear flag → re-login with new password → old password rejected. All 7 checks PASS against the live project.

**Follow-up (confirmed, NOT built here): wire real transactional email (AWS SES)** for Supabase Auth (invite + reset) — also needed for mention emails. Until then, invite/self-service-reset stay disabled and provisioning is temp-password only. See TASKS.

## 2026-07-28 — List/board ordering by record created date (newest first)

Lists/boards were ordered by `last_synced_at`, meaningless after a bulk backfill (all rows synced at once). Switched to record created date so the ~500 rendered are the most recent.

- **Schema (Tim ran in Supabase):** added `created_date timestamptz` to `sundial_customer_cache`, `sundial_solar_cache`, `sundial_roofing_cache` + a tenant-scoped index `(client_sf_id, created_date DESC NULLS LAST, sf_id)`.
- **Mapping (`sundial-cache-sync` + `sundial-sf-query`):** `created_date` = first non-empty of an ordered source list — `CreatedDate` for most objects, **`COALESCE(Contract_Date__c, CreatedDate)` for Solar** (3,025/4,545 solar rows have no `Contract_Date__c`, so they fall back to `CreatedDate`). Source fields are force-selected; written only when the column exists.
- **List endpoint ORDER BY:** `created_date` DESC NULLS LAST, then `sf_id` (stable tiebreaker). **Resilient:** orders by `created_date` only when the cache actually has the column (introspected), else stable `sf_id` — so a missing column can't error the query and dump lists onto the slow Salesforce cold path.
- **Backfilled + verified:** created_date 0 nulls on all three caches; solar COALESCE confirmed (contract-date row vs created-date fallback); live API returns `source=cache`, newest-first, correct totals, paged. Deployed `sundial-cache-sync` + `sundial-sf-query`.
- **Gotcha logged:** a first backfill wrote nothing because the `ALTER TABLE` hadn't landed on the backend project (`qfsdpkwxahakegjnyijj`); a direct `SELECT created_date` returned Postgres `42703`. Fixed once the column was added; the resilient ORDER BY meant prod never errored in the interim.
- **Frontend:** no change needed — tables default to no client sort (preserve incoming order) and boards preserve order within each stage column, so the backend order flows straight through (confirmed by read-only review).

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

**Task 5 — Acumatica ProjectBudget:** built read + reconcile scaffolding only (`lambdas/sundial-acumatica-budget-push/`, `lib/acumatica.js » getAcumaticaEntity`). **Write path hard-guarded off** — the mapping tab has no `InventoryID` column (match key not unique). Income is confirmed as TWO lines — `BALANCE` (Balance of Contract) + `GENM/BILLING` (Solar Material), no `BILL` task (Gate 5a; corrected 2026-08-02). Documented in `docs/integrations/acumatica-budget-push.md`.

**Housekeeping:** moved `budget-lambda.zip` + `sundial-budget-deploy.zip` into git-tracked `artifacts/`; added `exceljs` to root deps.

**Pending:** AWS function `sundial-budget` creation (Tim) → deploy → Gate 2 smoke test; prod API Gateway route deploy; relay wiring; the blocked-on-Harmon items in TASKS.md.
