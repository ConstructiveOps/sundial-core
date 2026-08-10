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

## G2 — intermittent 500s under concurrent paged loads (root-caused + page cap raised 2026-08-10)

Punchlist: `../harmon-crm/docs/HARMON_PHASE1_PUNCHLIST.md` → G2 / G2a–G2d.

- [x] **Root cause: the AWS Lambda "Concurrent executions" quota is 10** (default 1000), us-west-1, shared by all 32 functions. Throttled invokes never reach the function; API Gateway returns `500 {"message": "Internal server error"}` in ~65 ms with no log line and `Errors` = 0. Reproduced deterministically (12 parallel → exactly 10 pass).
- [x] Ruled out: Supabase pool exhaustion and per-invoke client construction. The Lambda talks to Supabase via **PostgREST over HTTPS** (no `pg`, no pool); client/secrets/SF-token/JWKS were already module-scope cached.
- [x] **Cache-path page cap 500 → 5000** (`MAX_LIMIT`), default 500 when `limit` is absent (was 50); over-cap clamps, `0`/negative/absent fall back. Sweep 64 → 7 requests.
- [x] **Internal PostgREST paging** (`fetchCacheRange`) — Supabase "Max Rows" is 1000 and **silently truncates**, so the clamp raise alone would have been a lie. Splits pages >1000 into consecutive `.range()` calls, one exact count.
- [x] **Bounded-parallel stale refresh** (5 concurrent `IN()` chunks) — sequential measured ~35s on a fully-stale 5000-row page, past the 30s timeout; now 13.2s worst case.
- [x] Batched cache upsert/delete; **Salesforce token stampede guard** in `lib/salesforce.js` (concurrent cold callers share one JWT round trip, cleared on settle).
- [x] Live-Salesforce list paths (cold cache, TEMP Sales-Rep restrict) keep the original 500 cap — SOQL `OFFSET` caps at 2000.
- [x] Verified: 5000 rows/5000 unique ids, zero cross-page overlap, 7-wide burst × 2 rounds = 0 failures, all objects under Lambda's 6 MB response limit.
- [ ] **TIM (console, G2a): raise the Lambda concurrency quota 10 → 1000** in Service Quotas (us-west-1, `L-B99A9384`). **This is the actual root cause and it is still live** — >10 simultaneous invocations anywhere in the account still 500.
- [ ] **TIM (console, G2b): raise Supabase "Max Rows" 1000 → 5000** (Settings → API). Optional perf only; the Lambda is correct without it.
- [ ] **Frontend (harmon-crm, separate session, G2d):** bump the `pageSize` constant to 5000 — `listAllRecords` already accepts it. One line.
- [ ] **G2c: `GET /sf/{object}/counts?by=stage`** — server-side status counts so tab badges stay correct during partial loads. **Assessed: not a trivial aggregate.** PostgREST aggregates are disabled on this project (`select=stage,count()` → `PGRST123`), so it needs a tenant-scoped Postgres RPC (`group by`) + an API Gateway route wire (`scripts/wire-*.ps1` pattern). Small but real — awaiting Tim's green light.


## Aurora inbound — agreement webhook → queue → worker (built 2026-08-04, D-048)

- [x] **Doorbell** `sundial-aurora-webhook`: all five subscription attributes, shared-secret gate (constant-time, 5-min token TTL so rotation needs no redeploy), enqueue to SQS, **5xx on enqueue failure** to drive Aurora's retry ladder. No SF/Aurora I/O — it must answer inside Aurora's 10s deadline.
- [x] **Worker** `sundial-aurora-inbound` (SQS): all statuses update agreement tracking (deduped, precedence-ranked); `signed` also retrieves agreement/design/proposal/financing, writes the mapping to `Sundial_Customer__c`, stores the signed PDF, and emails the design manager once. Partial-batch failures → DLQ; permanent classes logged with a `PERMANENT` marker.
- [x] `lib/aurora.js`, `lib/sqs.js`, `lib/salesforce.js » describeObject`; 37 tests (14 + 23), all green.
- [x] Docs: `docs/integrations/aurora-inbound.md` (runbook), api-endpoints, salesforce-schema, aurora-api-reference (**corrected** the stale "filters to signed"), D-048.
- [ ] **Create 5 fields on `Sundial_Customer__c`** (the pipeline runs without them — the describe guard drops them and the worker reports the gap — but the data is lost until they exist):
  - `Aurora_Agreement_ID__c` — Text(100)
  - `Aurora_Agreement_Status__c` — Picklist: `sent`, `viewed`, `signed`, `cancel-pending`, `canceled`, `declined`, `error`
  - `Aurora_Agreement_Status_At__c` — Datetime
  - `Aurora_Proposal_Link__c` — URL(255)
  - `Aurora_Signed_Email_Sent__c` — Datetime. **Most important of the five:** it is the "signed processing completed" marker. Without it the duplicate guard can't persist, so a duplicate `signed` delivery re-sends the notification.
  - Grant FLS to the integration user (and the portal perm set for anything users should see).
- [ ] **Infrastructure (hand-created, per `docs/integrations/aurora-inbound.md` Part B):** SQS `sundial-aurora-inbound` + `-dlq` (redrive `maxReceiveCount=5`, visibility 180s ≥ the worker's 60s timeout); Lambda `sundial-aurora-inbound` (Node 22 / arm64 / 60s / 512MB / `sundial-lambda-execution-role`); event-source mapping **with `ReportBatchItemFailures`** (without it SQS ignores partial-batch failures and deletes the whole batch); `AURORA_INBOUND_QUEUE_URL` on the doorbell; `EMAIL_FROM` + `DESIGN_REQUEST_NOTIFY_TO` on the worker. Verify the role has `sqs:SendMessage` / `ReceiveMessage` / `DeleteMessage` / `GetQueueAttributes`.
- [ ] **Deploy:** `.\deploy.ps1 sundial-aurora-webhook` and `.\deploy.ps1 sundial-aurora-inbound`; the route is already live (`scripts/wire-aurora-webhook-route.ps1` is idempotent).
- [ ] **Create the Aurora subscription** (Tim, Aurora console — `aurora-inbound.md` Part C): `agreement_status_changed`, **ALL** statuses, GET, the five-attribute `url_template`, and the `X-Aurora-Webhook-Token` header.
- [x] **Post-signature cancellation gap CLOSED (2026-08-04, D-048 amendment):** `canceled` / `cancel-pending` / `declined` are now confirmed with a fresh `GET /agreements/{id}` before precedence is applied — Aurora's current status wins over a recorded `signed` (and sends a cancellation email), while an event Aurora contradicts is dropped as stale. `error` stays rank-governed; exact duplicates short-circuit before the re-read. The `signed` path is unified with it: a signed event whose re-read shows a dead agreement records Aurora's status and sends the same notification. 13 tests cover both branches.
- [ ] **Operational note (not a code gap):** a confirmed cancellation after signing is now recorded and emailed automatically, but anything already started off the signed contract (project creation, scheduling, commissions) still has to be unwound by hand.
- [ ] Nice-to-have: migrate `sundial-aurora-push` onto `lib/aurora.js` (it still has its own inline Aurora config/fetch + describe cache) so there's one Aurora client.

## Aurora dealer origination — auto-create the Customer on signed (built 2026-08-07, D-049)

- [x] **Unmatched signed Aurora projects now branch** instead of dead-lettering: no `external_provider_id` → **create** the customer from Retrieve Project (upsert on the `Aurora_Project_ID__c` External ID, so duplicates/concurrency converge on one record); provider id that resolves → **repair** the missing link on our own customer and continue; provider id that doesn't resolve → `PROVIDER_ID_MISMATCH` → DLQ.
- [x] **Unmatched non-signed events dropped quietly** (no DLQ) — dealer pre-sale traffic. Still dead-lettered when they carry a provider id (our own broken deal).
- [x] Dealer attribution: `partner_id` → partner **name** via List Partners, falling back to `owner_id` → user name via Retrieve User, then the raw id. A 403 on either degrades to raw ids — it never fails an import. A 403 on **Retrieve Project** is a loud `AURORA_NOT_PROVISIONED` dead-letter (the feature depends on it).
- [x] `lib/aurora.js » getProject/listPartners/getUser`, `lib/salesforce.js » sfUpsertRecord`, `lambdas/sundial-aurora-inbound/customerCreate.js`; 21 new tests (103 repo-wide, green). Docs: aurora-api-reference (Retrieve Project surface as specced), aurora-inbound (branch table + dealer operating note), salesforce-schema, D-049.
- [ ] **Create 2 fields on `Sundial_Customer__c`** (imports succeed without them; the values are just lost and the gap is reported in the signed email):
  - `Aurora_Dealer_Name__c` — Text(255). Which dealer sold it.
  - `Aurora_Import_Notes__c` — Long Text Area(32768). Everything Aurora returned that has no field of its own (raw address, country, salutation, mailing address, partner/owner/team ids, tags, out-of-picklist values).
  - Grant FLS to the integration user; surface both on the Customer layout so the office can see a record was machine-built.
- [ ] **Add the `Lead_Source__c` picklist value `Aurora - Third-Party Dealer`.** Until it exists, auto-created records have **no lead source** (the code refuses to misattribute the sale to one of the ~200 existing partner values) and the intended value is recorded in the import notes.
- [x] **Pipeline position widened to ALL signed events (Tim, 2026-08-10):** `Status__c` = `Customer` + `Stage__c` = `Sold - Pending Review` are now written on every `signed` agreement — auto-created dealer records **and** pre-existing customers matched by `Aurora_Project_ID__c` — from one shared helper. Harmon's SF alerts fire off that Stage, which is why the SES email channel is deliberately unconfigured. 6 new tests; 112 green. **Needs deploying to take effect.**
- [ ] **⚠️ Duplicate signed deliveries will reprocess indefinitely while email is unconfigured.** `Aurora_Signed_Email_Sent__c` is only stamped when a notification actually sends, and it is the "signed processing complete" marker. With email off it never gets stamped, so every duplicate Aurora delivery re-runs the full signed path: 4 Aurora retrievals, a fresh PDF download + S3 overwrite, and a repeat PATCH. Data stays correct (all idempotent), but it's wasteful and **a repeat PATCH may re-fire the Salesforce alerts**. Fix options: (a) grant `ses:SendEmail` so the marker works as designed, or (b) treat "notifications deliberately disabled" as a terminal state that stamps the marker. Worth deciding before dealer volume picks up.
- [ ] **Grant `ses:SendEmail` to `sundial-lambda-execution-role`** — currently denied, so every signed notification fails with AccessDenied (seen live 2026-08-10). Not urgent while alerts run off the Stage, but it's the reason for the item above.
- [x] ~~**Pipeline position decided (Tim, 2026-08-07):**~~ (superseded by the 08-10 widening above) auto-created dealer customers get `Status__c` = `Customer` and `Stage__c` = `Sold - Pending Review`. Both values verified present in the org; both written through the same match-or-skip picklist guard (if either is ever renamed/removed, it's skipped with a warning and noted in `Aurora_Import_Notes__c` — exactly like `Lead_Source__c`). Note `Status__c` matters: the org default is **`Lead`**, so without this a closed dealer sale would have looked like a lead.
- [ ] **Review process:** auto-created customers carry only what Aurora knows — no Sundial design request, no Harmon qualification. `Stage__c = Sold - Pending Review` is the queue to work from, and the signed email flags them and names the dealer; decide who checks them and when.
- [ ] Note for whoever wires the Aurora subscription: dealer deals' `sent`/`viewed` events arrive **before** the customer exists and are dropped, so auto-created records start at `signed`. Earlier statuses are not backfilled (accepted, D-049).

## Create Project — copy Customer files to the Solar project (shipped 2026-08-03)

- [x] **`POST /projects/{customerId}/files/copy-to-solar`** → `sundial-list-files`. Server-side S3 `CopyObject` of `SUNDIAL/{customerId}/*` → `SUNDIAL/{solarId}/*`; destination read from `Linked_Solar_Project__c` server-side only (empty → 400 `NO_LINKED_PROJECT`; cross-tenant link → 400, fail closed). Zero files = 200, idempotent re-run, per-object failures isolated in `failed[]`. Copy helper: `lib/file-access.js » copyRecordFiles`.
- [x] Deployed: `.\deploy.ps1 sundial-list-files` + `scripts/wire-copy-files-route.ps1` (route live on prod).
- [x] Verified live end-to-end (`scripts/verify-copy-to-solar-e2e.mjs`, 17/17 checks, self-cleaning with verified teardown) + 13 unit tests.
- [x] IAM checked: role has `AmazonS3FullAccess`, so `ListBucket`/`Get`/`PutObject` on `sfsolproj/SUNDIAL/*` are covered — **no IAM change needed**.
- [ ] Frontend (harmon-crm, separate): call this right after the Create Project step succeeds; surface `failed[]` if non-empty.
- [ ] Nice-to-have: tighten the execution role from `AmazonS3FullAccess` to a `sfsolproj/SUNDIAL/*`-scoped policy (unrelated to this endpoint; it's the whole role).
- [ ] Fix the same latent AWS-CLI quoting bugs in `wire-budget-recalc-route.ps1` and `wire-user-admin-routes.ps1` (`--api-key-required $false` → `--no-api-key-required`; comma-containing map values + MOCK template via no-BOM JSON files; add `Assert-LastExitOk`). Their routes are already live, so nothing is broken today — but a re-run would fail confusingly, and the script would print SUCCESS anyway. Already fixed in `wire-copy-files-route.ps1` and `wire-design-request-route.ps1`.

## Cache delete-pruning gap — deleted SF records ghost in the cache (found 2026-08-03)

Deleting a record in Salesforce does **not** reliably remove its cache row. Today the only pruning is opportunistic and read-time; there is no reconciliation job.

What exists now:
- `sundial-sf-query` **list** path only: a row that is BOTH on a page someone actually requests AND already stale (`is_stale === true` or `last_synced_at` older than the 10-min `CACHE_TTL_MS`) gets re-fetched by Id; if Salesforce doesn't return it, the row is deleted (`lambdas/sundial-sf-query/index.js:871`).
- `sundial-cache-sync` has **no** delete detection at all — by design, documented at `lambdas/sundial-cache-sync/index.js:22`. Its SOQL only sees records that still exist, so deletions are invisible to both incremental and full-resync modes. A **full resync does not shrink the cache** — it only upserts.
- `sundial-sf-query` **single-record** path returns 404 when the record is gone but leaves the cache row in place (`index.js:626`).

Why it ghosts:
- A fresh row (synced within the TTL) is served straight from cache and never verified, so a just-deleted record keeps appearing on lists.
- A row on a page nobody ever loads (deep pages, filtered-out stages) is never checked at all.
- Migrated-then-deleted records are the worst case: high volume, rarely viewed individually, so nothing ever triggers the read-time check. Counts (`total`) stay inflated too.

- [ ] **Add delete-pruning to `sundial-cache-sync`.** Options, cheapest first:
  - Salesforce `queryAll` / `/sobjects/{obj}/deleted?start=&end=` (Deleted Records API, 15-day window) on each incremental run → delete matching `sf_id`s. Cheap, but only covers the last 15 days, so it must be paired with the reconciliation pass below.
  - Reconciliation pass on full resync: collect every `Id` returned from Salesforce for the object, then delete cache rows for that `client_sf_id` whose `sf_id` is not in that set. Must be scoped per tenant and must only run when the SF fetch completed cleanly — a partial/failed fetch would otherwise wipe good rows.
  - Do NOT gate on `is_stale`/TTL: the ghost rows are the fresh-looking ones.
- [ ] Delete the cache row on the single-record 404 path (`index.js:626`) — tenant-scoped, best-effort, mirroring the list path.
- [ ] Interim manual remedy: delete by `sf_id` directly in Supabase (done once for solar `a1Q7y00000JD2WxEAL`, 2026-08-03).


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
- [x] **Aurora Design Request on the Customer module (D-047):** customer-id route as the mainline, Solar resolution removed, describe-filtered field set, design-manager notification email carrying the full form (Aurora accepts none of it). Project creation once-only (`Sent_to_Aurora__c`/`Aurora_Project_ID__c`); notification separately retryable (`Design_Request_Email_Sent__c`) so a failed email can be recovered by re-submitting. 21 tests green (`npm test`). **Built + tested, NOT deployed.**
- [ ] **Deploy the Design Request re-route:** `.\deploy.ps1 sundial-aurora-push` → `.\scripts\wire-design-request-route.ps1` (also deletes the legacy `/projects/.../design-request` resource) → set `EMAIL_FROM`, `DESIGN_REQUEST_NOTIFY_TO`, optional `DESIGN_REQUEST_NOTIFY_CC` on the Lambda + `ses:SendEmail` on the role (see `docs/api-endpoints.md` → Lambda Environment Variables).
- [ ] **Create two fields on `Sundial_Customer__c`** (live describe 2026-08-03 says neither exists; the Lambda drops each from the SELECT until it does and picks it up automatically after — no redeploy):
  - `Design_Notes__c` — long textarea; the one Design Request form field the object lacks.
  - `Design_Request_Email_Sent__c` — **datetime**, writable by the integration user. Records that the design-manager notification actually landed. **Until it exists, every re-submit re-sends the notification** (deliberate — see D-047: silence is the worse failure), so create it before the button goes to users.
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
- [x] Task 5: built the ProjectBudget GUID-write path (`writeBudgetLines`) on `feat/budget-push-write` — Stages 1–5 done; deploy + wire + FLS + IAM + live test pending (runbook in `docs/integrations/acumatica-budget-push.md`).
- [ ] Portal budget UI per `../harmon-crm/docs/Sundial_Solar_Fields_by_Section.xlsx` (FRONTEND — not a backend task; fields render in the portal, not a SF layout)

### Blocked on Harmon / confirmation
- [x] ~~**Acumatica mapping: no `InventoryID` column**~~ → **RESOLVED 2026-08-07 (Gate 5a)** via a live reconcile harvest of ProjectID `R269999`. The sheet's old "AccountGroup" column was actually the InventoryID; real AccountGroup is BILLING/LABOR/OTHER/MATERIAL. `MAPPING_ROWS` + `docs/Sundial_Solar_Budget_Fields.xlsx` + the integration doc now carry the full 4-part key. Clean matched-run: 18 rows → 15 groups → 0 problems. (Note: `RESIDENTAL` is the Acumatica misspelling — kept intentionally.)
- [x] ~~Income code BILL~~ → resolved: income is TWO lines (`BALANCE` + `GENM`/BILLING), `BILL` removed. `DLR` confirmed as the Dealer-fee line.
- [x] ~~**Geo commission task code unconfirmed**~~ → **resolved to `APPT COM`** (LABOR·SALESCOMM) from role semantics, and ~~Audit+QA `GENA`~~ → resolved to the LABOR·RESIDENTAL line (internal labor, UOM=HOUR). Both wired into `MAPPING_ROWS`.
- [x] **Harmon finance sign-off on Geo → `APPT COM`** received (Gate 5b) 2026-08-07 — clears `PENDING_HARMON_SIGNOFF` for the first production write.
- [x] **Gate 5b satisfied 2026-08-07:** clean reconcile vs R269999 ✔ + Harmon APPT COM sign-off ✔ + Tim-approved write plan ✔ — `writeBudgetLines` built (Stages 1–5).
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
