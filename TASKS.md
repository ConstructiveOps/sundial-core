# Sundial — Tasks

Status markers: `[ ]` TODO · `[x]` DONE · `[~]` IN PROGRESS · `[!]` BLOCKED

## Sales Rep visibility (proper feature — replaces the TEMP guard below)

- [ ] **Build per-user record visibility** (the real feature the TEMP guard stands in for). Model: roles on `Sundial_User__c` (`Hierarchy_Level__c`, `Parent_User__c`), records carry `Sales_Rep__c`/`Sunbase_Sales_Rep__c` (customer) and `Sales_Representative__c`/`Sales_Rep__c` (solar). Needs the rep field mirrored into the cache tables so filtering is cache-side (paginatable) instead of the live-SF bypass below.
- [~] **TEMP Sales Rep hard-restrict (shipped 2026-08-03)** — Harmon has ONE Sales Rep (Dennis Alessandro). Server-side, a caller with `Hierarchy_Level__c === "Sales Rep"`:
  - `sundial-sf-query`: `customer`/`solar` list + single + `?full=true` reads are filtered to `Sunbase_Sales_Rep__c`/`Sales_Representative__c` = `Dennis Alessandro`. **Rep reads BYPASS the cache and go live to Salesforce** (the authoritative field isn't cached; `sales_rep_name` is a different formula field). **Known jank:** SOQL `OFFSET` caps at 2000, so on the customer list a rep can page the first ~2000 of Dennis's 3,511 (SAFE — never another rep's records — but incomplete on deep pages). **Roofing NOT gated** (no rep field in scope; ~1 record; revisit with the real feature).
  - `sundial-list-files`: Sales Rep is blocked (403) from Solar file list/download; Customer files allowed.
  - Rep NAME is hardcoded (single rep). Remove all `TEMP` / `repRestrict` markers when the real feature ships.

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
- [x] **Provisioning re-diagnosis + e2e fix (2026-08-03, D-046):** live data disproved the "invite users miss tenant binding" theory (all have `Client__c=harmon`); `scripts/verify-provisioning-e2e.mjs` proves the full chain green in prod (login → `/auth/me` tenant → `GET /sf/customer` 200 w/ 31,576 rows → forced change → re-login). Added `scripts/recover-provisioning.mjs` (classify + fix-in-place + guarded orphan delete) and `lib/salesforce.js » sfDeleteRecord`. See `docs/integrations/auth-email-ses.md`.
- [~] **Auth email via Supabase Custom SMTP (SES)** — setup guide written (`docs/integrations/auth-email-ses.md`) with exact console/dashboard steps + values. **Tim to do:** (a) create SES SMTP credentials (us-west-1); (b) enable Supabase Custom SMTP (host `email-smtp.us-west-1.amazonaws.com:465`, sender `harmon@sundialcrm.com`); (c) add Site URL + `/reset-password` redirect allowlist; (d) raise the auth email rate limit; then manual invite/reset test. This unblocks both invites and resets.
- [ ] **Deploy the harmon-crm invite-default flip** (`UserFormModal.tsx`, branch `fix/provisioning-auth-email`) — **only after** the SMTP steps above pass the manual invite test (ordering per D-046).
- [ ] **Apply recovery** (after review): `APPLY=1 OUT=<path> node scripts/recover-provisioning.mjs` for `davidcoleman` (NEVER_ONBOARDED); decide orphans — delete `troyjohnson` (typo-dup) via `DELETE_ORPHANS=1`, confirm intent for `team+5069@nonstopautomation.com` and the `harmon@constructiveoperations.com` ORPHAN_SF.
- [!] **Wire AWS SES** (shared `lib/email.js` scaffolded 2026-07-30; `@aws-sdk/client-sesv2` added; NOT wired to any feature). Blockers/steps: (a) create + verify the sending domain identity — recommended `mail.constructiveoperations.com` — and add the DKIM CNAMEs + SPF/DMARC; (b) request SES production access (out of sandbox); (c) grant the Lambda role `ses:SendEmail` and set `EMAIL_FROM`/`SES_REGION` env vars on senders. Consumers waiting on this: **Design Request → email the design manager** (now BUILT in `sundial-aurora-push`, D-047 — it degrades to `email.sent: false, reason: "email_not_configured"` until `EMAIL_FROM` + `DESIGN_REQUEST_NOTIFY_TO` are set) and **@-mention alerts**. NOTE: **Supabase Auth invite/reset no longer waits on this SDK path** — it goes through Supabase Custom SMTP → SES instead (D-046, `docs/integrations/auth-email-ses.md`), which is independent of `lib/email.js`.
- [x] **Utility Password save failure (D-045):** describe-cache TTL (5 min) in sundial-sf-update + sundial-sf-query; redeployed. Root cause was stale FLS in the cached describe after the budget perm set assignment.
- [x] ~~**Aurora "Submit Design Request" endpoint:** `POST /projects/{solarId}/design-request/submit`~~ — **superseded 2026-08-03 (D-047):** no `Sundial_Solar__c` exists at design-request time, so that route was unusable. Re-plumbed to `POST /customers/{recordId}/design-request/submit` on `Sundial_Customer__c`.
- [x] **Aurora Design Request on the Customer module (D-047):** customer-id route as the mainline, Solar resolution removed, idempotency on `Sent_to_Aurora__c`, describe-filtered field set, design-manager notification email carrying the full form (Aurora accepts none of it). 15 tests green (`npm test`). **Built + tested, NOT deployed.**
- [ ] **Deploy the Design Request re-route:** `.\deploy.ps1 sundial-aurora-push` → `.\scripts\wire-design-request-route.ps1` (also deletes the legacy `/projects/.../design-request` resource) → set `EMAIL_FROM`, `DESIGN_REQUEST_NOTIFY_TO`, optional `DESIGN_REQUEST_NOTIFY_CC` on the Lambda + `ses:SendEmail` on the role (see `docs/api-endpoints.md` → Lambda Environment Variables).
- [ ] **Create `Design_Notes__c`** (long textarea) on `Sundial_Customer__c` — it's the one Design Request field the object doesn't have (live describe 2026-08-03). The Lambda drops it from the SELECT until it exists and picks it up automatically after (no redeploy).
- [ ] Frontend (harmon-crm, separate): "Submit Design Request" button on the **Customer** record's Design Request Form tab, posting the Customer id to `/customers/{recordId}/design-request/submit`.
- [ ] **Design Request Form fields (new SF fields):** Workbench package pending Tim's field-existence markup of `Fields_by_Section.xlsx` (picklists, multiselect Sales Type, datetime, text/number) + FLS on integration + user perm sets. Note the Design Request set itself now lives on **`Sundial_Customer__c`** (verified present 2026-08-03), not `Sundial_Solar__c`.

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
