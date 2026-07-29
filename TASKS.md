# Sundial — Tasks

Status markers: `[ ]` TODO · `[x]` DONE · `[~]` IN PROGRESS · `[!]` BLOCKED

## List pagination + cache backfill (fix: "exactly 50" bug, 2026-07-28)

- [x] `sfQuery` follows `nextRecordsUrl` to exhaustion (`lib/salesforce.js`) — removes the silent 2000-row truncation on every read
- [x] `sundial-sf-query` list endpoint: real server-side pagination (`limit`≤500 + `offset`, exact `total`, `hasMore`, stable `sf_id` order, per-page refresh); deployed
- [x] `sundial-cache-sync` full-resync mode (`{ "mode": "full" }`), per-run LIMIT removed; function raised to 900 s / 1024 MB; deployed
- [x] Backfill run + verified: customer 31,948 & solar 4,545 caches now match Salesforce; paginated API verified live
- [x] **List/board ordering by record created date (newest first):** `created_date` cache column (+ tenant index) on customer/solar/roofing; mapped `CreatedDate` (Solar: `COALESCE(Contract_Date__c, CreatedDate)`); endpoint `ORDER BY created_date DESC NULLS LAST, sf_id` (resilient to a missing column); backfilled + verified newest-first. Frontend needs no change (preserves backend order).
- [ ] **Frontend (harmon-crm, separate session):** send `limit`/`offset`, consume `total`/`hasMore`, add pager or load-more; boards fetch per-stage counts + lazy-load cards (must NOT pull 40k); Dashboard use aggregates not a 50-row page. See the bug report for the exact file/line changes.
- [ ] Follow-ups: server-side search/filter across the full set, list virtualization (react-window), optional `orderBy` param, EventBridge schedule for incremental `sundial-cache-sync`


## User Management Backend (D-044)

- [x] `sundial-user-admin` Lambda — GET/POST `/admin/users`, PATCH `/admin/users/{id}`; Super-Admin-gated, tenant-scoped, fail-safe create + compensating delete, Supabase ban on deactivate, self-deactivation guard
- [x] `scripts/wire-user-admin-routes.ps1` (mirrors corrected budget wire script)
- [x] Docs: `api-endpoints.md` Admin section; DECISIONS.md D-044
- [x] **Create the `sundial-user-admin` Lambda function** (Node 22 / arm64 / us-west-1 / role `sundial-lambda-execution-role` / 30 s / 256 MB)
- [x] Deploy `sundial-user-admin` (`.\deploy.ps1 sundial-user-admin`)
- [x] Run `scripts/wire-user-admin-routes.ps1` against the prod gateway (routes live)
- [x] Verify end-to-end with a Super-Admin token — GET/POST/PATCH, 403 for non-super-admin, `USER_INACTIVE` on deactivated user's `/auth/me`, self-deactivation + `FIELD_NOT_ALLOWED` guards, compensating auth-user delete on SF failure
- [x] Invite `redirectTo` → `<PORTAL_BASE_URL>/reset-password` (env var, defaults to `https://harmon-crm.vercel.app`); **at go-live set `PORTAL_BASE_URL` to Harmon's real domain**
- [x] Ban/unban retry-hardened (`setSupabaseBan`, 3× backoff); flow logic re-verified with fresh login (deployed-API re-verify skipped per Tim)
- [ ] Frontend (harmon-crm, separate): the Manage Users surface, gated on `superAdmin`
- [x] **Provisioning incident (2026-07-29):** root-caused to Supabase built-in email non-delivery (not the user-admin work). Fixed email-independent (default to temp-password mode, disable invite); recovered this morning's 10 users in place; verify + recovery scripts added.
- [!] **Wire AWS SES for Supabase Auth email** (invite + password reset; also mention emails). Until done: invite + self-service reset are disabled in the UI; provisioning is temp-password only. Then re-enable the invite radio and the login "forgot password" flow, and confirm `https://harmon-crm.vercel.app/reset-password` (and the real go-live domain) are in Supabase Auth → URL Configuration → Redirect URLs.

## Portal Access Model (D-043)

- [x] Add `Access_Level__c`, `Super_Admin__c`, `Default_Department__c` to the portal identity (`lib/identity.js`) — verified live on `Sundial_User__c`
- [x] `sundial-auth-proxy` returns the new fields (no structural change); deployed
- [x] `upsertProfile` unchanged (`public.profiles` has no `access_level`/`is_super_admin` columns)
- [x] Docs: real `/auth/me` shape in `api-endpoints.md`; DECISIONS.md D-043
- [~] Verify live: `GET /auth/me` with a real portal-user token (Tim to supply one) → confirm `user.accessLevel` + `user.superAdmin`
- [ ] Frontend (harmon-crm, separate): gate tabs/sections/fields/reports on `accessLevel`; gate Manage Users on `superAdmin`
- [ ] Future user-admin endpoints: server-side `superAdmin` checks (the ONLY place these fields are enforced server-side)
- [ ] Other Lambdas pick up the `lib/identity.js` change on their next routine deploy (no action needed now)

## Budget Calculator (feature/budget-calculator)

### Lambda + triggers
- [x] Place `budget-lambda` in repo as `lambdas/sundial-budget/`; `npm test` 32/32 (pinned HOLLAND math)
- [x] Wire org-standard SF auth via `lib/salesforce.js` (dropped jsforce); reads `sfQuery`, writeback shared `sfUpdateRecord`
- [x] Base64-embed the workbook template at deploy time (`prebuild.mjs`/`postbuild.mjs` + `deploy.ps1` hooks); tests read source `.xlsx`
- [x] Task 4: best-effort Supabase file-metadata registration (`lib/file-access.js » registerFileMetadata`, category "Budget")
- [x] Task 2: recalc button auth (Supabase JWT + tenant scoping) in handler; documented in `docs/api-endpoints.md`
- [x] Task 3: record-triggered Flow drafted (`salesforce/flows/Sundial_Budget_Recalc_Trigger.flow-meta.xml`) + relay runbook
- [x] Deploy `sundial-budget` (function created; 256 MB / 30 s). Prerequisites verified — all 73 input fields valid on `Sundial_Solar__c`.
- [x] Gate 2 numeric verify via scripted HOLLAND TEST record (seeded in-Lambda; see PROGRESS.md)
- [ ] Task 2: run `scripts/wire-budget-recalc-route.ps1` against the prod API Gateway (needs go-ahead — live change)
- [ ] Task 3: wire the confirmed Platform-Event relay (EventBridge rule or SQS mapping) + Lambda invoke permission
- [ ] Task 5: build the ProjectBudget GUID-write path (BLOCKED — see below); currently read/reconcile scaffolding only
- [ ] Portal budget UI per `../harmon-crm/docs/Sundial_Solar_Fields_by_Section.xlsx` (FRONTEND — not a backend task; fields render in the portal, not a SF layout)

### Blocked on Harmon / confirmation
- [!] **Acumatica mapping: no `InventoryID` column** — the 4-part match key (ProjectTaskID+AccountGroup+InventoryID+Type) is not unique without it (SLPC×2, GENO×3, BURDENEXR×2 collide). Fill InventoryID (+ income account groups / amount splits) from the live scaffold before the ProjectBudget write path. (Gate 5a)
- [x] ~~Income code BILL~~ → resolved: income is TWO lines (`BALANCE` + `GENM`/BILLING), `BILL` removed. `DLR` confirmed as the Dealer-fee line.
- [!] **One unconfirmed Acumatica task code:** Geo commission (no code on sheet). Held in `UNCONFIRMED`, never guessed.
- [!] **Milestone trigger fields** for the recalc Flow (Audit Completed, Design Review Finalized, …) — Harmon's final list; append as formula `fInputChangedC` and Activate the Flow.
- [!] **§9 workbook quirks** (8) in `docs/budget-calculator-design.md` — implemented as the sheet behaves; each a one-line change in `budgetCalc.js` pending a Harmon finance yes/no.
- [ ] **Confirm the Platform-Event relay mechanism** actually deployed (Event Relay vs SQS) — repo has no live SF→AWS relay yet.

## Multi-tenant readiness (pre-second-tenant refactor — NOT now; Harmon runs fine as-is)

Externalize the Harmon-specific values currently baked in shared backend code into
per-tenant config keyed by tenant slug (resolved from `Sundial_Tenant__c`), so the
copy-for-new-tenant base stays tenant-agnostic:
- [ ] **Tax zones** — `lib/acumatica-tax-zones.js` (Arizona retail zones) → per-tenant config.
- [ ] **Acumatica mapping** — `sundial-acumatica-budget-push` `MAPPING_ROWS`/`UNCONFIRMED` + `sundial-acumatica-push` `CUSTOMER_CLASS="RESIDENT"` / template `"RS"` → per-tenant config.
- [ ] **budgetCalc** — accepted as a per-tenant *forked* calc module (a materially different tenant budget sheet = different math, per D-038); optionally lift the adder catalog / hours-per-unit to config if tenants share the calc shape.
- Already cleanly externalized (no work): secrets/tenant IDs (Secrets Manager), rate/catalog defaults (SF field-default metadata), per-project values (records), tenant isolation (`Client__c → Sundial_Tenant__c`, D-034).
