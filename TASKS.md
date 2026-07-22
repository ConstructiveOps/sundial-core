# Sundial — Tasks

Status markers: `[ ]` TODO · `[x]` DONE · `[~]` IN PROGRESS · `[!]` BLOCKED

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
