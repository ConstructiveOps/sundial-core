# Reporting Module — design (2026-10-30)

> Status: DESIGN, agreed with Tim 2026-10-30. R0 is the first build increment.
> Decision to record in DECISIONS.md: **D-087 — reports run on the Supabase cache; Salesforce is never the report engine.** Supersedes CLAUDE.md "Key UI Components" item 11 ("Reporting — Salesforce reports surfaced in portal UI").

## 1. What Harmon needs

1. **Recurring reports** delivered on a schedule (set up ahead of time by Constructive Ops).
2. **A fixed dashboard per department / access level** ("My Dashboard"): the relevant reports, charts and numbers, shown on arrival, not editable by the user.
3. **Custom reports** the office can create and run themselves, with CSV download.
4. Existing access rules apply: tenant isolation, the cost / payroll gates, module gating.

## 2. Decisions

- **D-087.** Every report is a query against the Supabase cache tables. Salesforce is the source of truth and the sync keeps the cache current (D-079: every 5 min for the hot objects); it is never queried by a report run. Native Salesforce reports, the Analytics REST API and SF dashboards are out of scope permanently (API budget, no per-user scoping, and Harmon holds no SF licenses).
- **v1 scope is the office portal, tenant-scope roles only** (Admin / Executive / Manager and the other `TENANT_ACCESS_LEVELS`). Sales Rep / Sales Dealer are excluded from v1 — they have the dealer app and the manifests; the reporting routes answer them `404 RECORD_NOT_FOUND` / module denial like any other module they lack. Nothing in the engine assumes this forever: the row filter and the field manifest plug in at the same point the list reads use them.
- **The cache becomes reporting-grade (R0):** every field a detail layout shows is a cache column. Width does not change what the portal reads (§4).
- **The engine has no per-field code.** What a report may select, filter or group on comes only from the generated field catalog and the report-type definitions. A column name hard-coded in the engine or the UI is a review rejection.
- **The AI front door generates definitions, never data or SQL.** The same validated definition is what the engine runs; a saved report never consults the model again.

## 3. Architecture

```
field catalog (generated JSON, per object)   report types (JSON: base table + joins)
                 \                                   /
                  v                                 v
          report definition (JSON, saved in sundial_reports)
                              |
                              v
            sundial-reports Lambda: validate -> compile -> run -> rows / aggregates / CSV
                              |
         +--------------------+--------------------+
         v                    v                    v
   fixed dashboards     scheduled delivery     custom reports
   (config: role ->     (EventBridge rule ->   (AI chat -> definition preview
    report ids)          run -> CSV/PDF -> SES)  with editable chips; builder-lite)
```

Build sequence: **R0** reporting-grade cache → **R1** engine + report types + catalog + CSV + permissions → **R2** curated reports + role/department dashboards → **R3** scheduled delivery → **R4** custom reports (AI front door first; a full builder only on demand).

## 4. R0 — the reporting-grade cache

### 4.1 Rule
For each cached object, **every field listed in its field-design workbook (any section) gets a cache column**, plus every field already cached. For the small money / service objects that have no workbook section list of their own, every field the integration user can read gets a column.

| Object key | Cache table | Source of the field list |
|---|---|---|
| customer | `sundial_customer_cache` | `docs/Sundial_Customer__c_Field_Design.xlsx` (sheet *Fields by Section*, column *API Name*) |
| solar | `sundial_solar_cache` | `docs/Sundial_Solar_Fields_by_Section.xlsx` (*Fields by Section*, *API Name*) |
| roofing | `sundial_roofing_cache` | `docs/Sundial_Roofing_Fields_by_Section.xlsx` (*Field List (Module)*, *API Name*) |
| job | `sundial_service_job_cache` | `docs/Sundial_Service_Job_Fields_by_Section.xlsx` (*Service Job Fields*) |
| serviceinvoice | `sundial_service_invoice_cache` | same workbook (*Service Invoice Fields*) |
| servicepayment | `sundial_service_payment_cache` | same workbook (*Service Payment Fields*) |
| estimate | `sundial_estimate_cache` | `docs/Sundial_Estimate_Fields_by_Section.xlsx` (*Estimate Fields*) |
| serviceline | `sundial_service_line_cache` | same workbook (*Service Line Fields*) |
| pricebookitem | `sundial_price_book_item_cache` | same workbook (*Price Book Item Fields*) |
| servicecall | `sundial_service_call_cache` | `docs/Sundial_Service_Call_Fields_by_Section.xlsx` |
| po, user, membership, serviceplan | their cache tables | every readable describe field (no workbook) |

Column names follow `sfFieldToColumn()` exactly (`lib/cache-row.js`): lowercase, `__c` stripped, reference fields suffixed `_sf_id`. That is what lets `sundial-cache-sync` and `sundial-sf-query` fill a new column with **no code change** — `buildCacheSelect` selects by cache column.

### 4.2 Type map (Salesforce describe type → Postgres)
`string / textarea / picklist / multipicklist / phone / email / url / id / encryptedstring` → `text` · `reference` → `text` (`_sf_id`) · `boolean` → `boolean` · `int` → `integer` · `double / currency / percent` → `numeric` · `date` → `date` · `datetime` → `timestamptz` · formula fields take their result type · `address / location / base64 / anyType` → **skipped** (compound; `getQueryableFields` already excludes them).

### 4.3 What the generator must refuse or report (never silently)
- A mapped column name longer than **63 characters** (Postgres truncates; the sync would never match it). Report it; skip it in v1.
- Two SF fields mapping to the **same column** (e.g. `Name` and `Name__c`). Report; keep the one already cached; skip the other.
- A field the integration user **cannot read** (absent from describe). Report it as a **TIM: grant Read FLS** item; it gets no column until it is readable.
- A column that already exists with a **different type** than the map says. Leave it alone; report it.
- Long-text fields ARE included (they are on the layouts). They stay out of `LIST_PROJECTION` and out of list responses (`docs/api-endpoints.md`: long-text columns are excluded from lists), so lists do not carry them.

### 4.4 Deliverables
1. `scripts/generate-report-columns.mjs` — reads the workbooks + a live describe per object + the live cache columns (same OpenAPI-spec method as `getCacheColumns` in the sync), writes **one idempotent SQL file** `sql/2026-10-30_report_columns.sql` (`alter table … add column if not exists …`, one statement per column, grouped by table, commented with the SF API name and label) and a coverage report `docs/reporting-cache-coverage.md` (per table: existing, added, skipped-and-why, FLS-missing). Re-runnable; an unchanged state is an empty diff.
2. **The sync streams.** `sundial-cache-sync` full mode currently `sfQuery`s the whole object into memory and upserts after; at ~340 columns × 39k customers that is hundreds of MB. Change `runObject` to upsert **per SOQL page** (2,000 records) in both modes, advancing nothing until the page's upsert succeeds, and keep the zero-change-run invariant (one SOQL, no cache write — `sync-runs.test.js`). Raise the Lambda to **1,024 MB / 15 min** in `deploy.ps1` / the console as part of the deploy step.
3. **Measurement.** Before the SQL runs and again after the full resync, `explain analyze` both pipeline functions in the Supabase SQL editor (`select public.sundial_customer_pipeline('<harmon client sf id>', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)` and the solar one with their real signatures) and record the two timings in PROGRESS.md. These are the only portal paths that scan whole tables (§5). A regression over ~50 ms moves the wide columns to a sibling `sundial_<object>_report` table keyed on `sf_id` (same sync entry, zero portal change) — decide then, not now.
4. **Docs.** D-087 in DECISIONS.md; CLAUDE.md item 11 replaced and the harmon-crm copy re-synced; a "Reporting-grade cache" section in `docs/caching-architecture.md`; TASKS.md + PROGRESS.md entries with the Tim steps (FLS grants, run the SQL, memory bump, deploy, full resync order, formula-coverage check, the dealer view re-run).

### 4.5 Operational rules for the resync
- **Delete `private.app_config` `stage_notify_url` before the full resync of customer / solar and put it back after** (D-074 am. 3: a full resync re-inserts rows and every one would push).
- Resync order: customer, solar, roofing, job, estimate, servicecall, serviceinvoice, servicepayment, serviceline, pricebookitem, then the rest. One object per Test event, `{ "object": "<key>", "mode": "full" }`.
- After customer: re-run `sql/sundial_dealer_customer_view.sql` (the dealer list reads that view).
- After solar / customer: `node scripts/check-cache-formula-coverage.mjs` (a cross-object formula column needs the parent-modstamp OR).
- Then `{ "mode": "reconcile" }` per object so deleted SF records do not inflate counts (D-051).

## 5. Why width does not slow the portal (checked 2026-10-30)
- List screens pass `?fields=list`; `LIST_PROJECTION` narrows the PostgREST `select` itself, so a Sales / Solar / Jobs list fetches the same ~20 columns regardless of table width.
- Detail pages read `?full=true`, live from Salesforce (`lib/full-read.js`); cache width is irrelevant to them.
- The single-record cache read is `select *` by `sf_id` — one indexed row.
- The pipeline count functions scan the tenant's rows; blank fields cost a null-bitmap bit, not storage, so growth is far below the column count. Measured in R0 (§4.4 item 3).
- The sync costs no extra Salesforce API calls (same SOQL, same row counts); only payload size grows, which the page-wise upsert absorbs.
- The cache tables are not in a Realtime publication; invalidations are broadcasts.

## 6. R1 — the engine (for the next session; R0 does not depend on it)

### 6.1 Field catalog
`scripts/generate-report-catalog.mjs` → `lib/report-catalog/<object>.json`: for every cache column of a reportable object — `column`, `sfField`, `label` (workbook label), `section`, `type` (text | number | boolean | date | datetime | picklist | multipicklist | reference), `picklistValues` (from describe), `description` (workbook description / help text — this is also what the AI reads), `gate` (`service.costing.read` for the price-book / line cost columns and markup, `service.payroll.read` for pay rates — reuse `lib/cost-gate.js`'s lists), `reportable: true|false`. The engine allowlists against this file; the picker and the AI prompt are generated from it; nothing else is a source of column names.

### 6.2 Report types (v1)
Fixed joins, named like Salesforce report types; each is `{ key, label, base: { table, alias }, joins: [{ table, alias, on, kind: "left" }], defaultColumns }`:
1. `customers` — customer
2. `customers_solar` — customer ⟕ solar (`sundial_customer_sf_id`), most recent solar leads
3. `solar` — solar ⟕ customer ⟕ dealer (`dealer_sf_id`) ⟕ user as rep (`sales_rep_sf_id`) ⟕ user as PM
4. `roofing` — roofing ⟕ customer
5. `service_jobs` — job ⟕ customer ⟕ estimate ⟕ invoice (one per job) ⟕ payments (aggregated)
6. `service_calls` — service call ⟕ job ⟕ user as tech
7. `estimates` — estimate ⟕ customer ⟕ job
8. `estimate_lines` — line ⟕ estimate ⟕ price-book item
9. `invoices_payments` — invoice ⟕ job ⟕ payment rows

### 6.3 Report definition (JSON)
```json
{
  "type": "solar",
  "columns": ["solar.project_name", "customer.name", "solar.stage", "rep.name", "solar.contract_amount"],
  "filters": [
    { "field": "solar.stage", "op": "in", "value": ["Sold", "Sold - Pending Review"] },
    { "field": "solar.contract_date", "op": "between", "value": ["2026-09-01", "2026-09-30"] }
  ],
  "groupBy": ["rep.name"],
  "aggregates": [{ "fn": "sum", "field": "solar.contract_amount" }, { "fn": "count" }],
  "sort": [{ "field": "sum_solar_contract_amount", "dir": "desc" }],
  "limit": 5000,
  "chart": { "kind": "bar", "x": "rep.name", "y": "sum_solar_contract_amount" }
}
```
Operators per type: text/picklist `eq, neq, in, not_in, contains, starts_with, is_blank, not_blank`; number `eq, neq, gt, gte, lt, lte, between, is_blank`; date/datetime `eq, before, after, between, is_blank` plus relative tokens (`this_month`, `last_month`, `this_quarter`, `ytd`, `last_n_days:30`) resolved on the server in the tenant's zone (Arizona). One group level in v1; aggregates `count, sum, avg, min, max`. Relative dates are what make a saved report re-runnable.

### 6.4 Execution
Two viable paths; decide at the start of R1 after a spike on the first report type:
- **(a) plpgsql** `public.sundial_report_run(p_client_sf_id text, p_def jsonb)` — dynamic SQL with `format('%I')`, re-validating every identifier against a `sundial_report_catalog` table seeded from the catalog JSON; SECURITY DEFINER, `revoke execute from public`, like `sundial_customer_pipeline`. No new dependency. Harder to unit-test.
- **(b) `pg` from the Lambda** over the Supabase session pooler (connection string in Secrets Manager `sundial/supabase-db`), SQL compiled and parameterised in JS against the catalog (unit-testable like everything else in `lib/`). One new dependency; the first direct Postgres connection in the codebase.
Either way: the tenant clause `client_sf_id = $1` is always the first predicate on the base table and every joined table; identifiers only from the catalog; values only as parameters; `limit` capped (5,000 rows on screen, 50,000 in a CSV, streamed).

### 6.5 Routes and actions (`sundial-reports` Lambda)
`GET /reports` (saved, visible to the caller: own + shared-to-department + tenant), `POST /reports` / `PATCH /reports/{id}` (save a definition, name, description, sharing, schedule), `POST /reports/run` (ad hoc definition → `{ columns, rows, aggregates, asOf }`), `GET /reports/{id}/run`, `GET /reports/{id}/csv`, `GET /reports/catalog` (the catalog projected for the caller — gated columns removed), `GET /reports/types`, `GET /dashboards/me` (the caller's department / level → its report ids + layout). Actions: `reports.read`, `reports.write` (tenant scope), `reports.admin` (dashboard config, Admin / Executive), `reports.ai` (R4, with a per-tenant monthly budget in `sundial/anthropic`). `asOf` = the object's last ok sync run (`cache_sync_runs`), shown on every report ("data as of 2:35 PM").

### 6.6 Storage
`public.sundial_reports` (id, client_sf_id, owner profile_id, name, description, definition jsonb, sharing: private | department | tenant, department text, schedule jsonb, created/updated), `public.sundial_dashboards` (client_sf_id, department, access_level, layout jsonb of report ids + sizes). Service-role only, like the caches; the browser talks to the Lambda.

## 7. R2–R4 (sketch)
- **R2** — Tim authors the starter set as saved definitions (pipeline by stage / rep, solar by PM and stage with contract totals, service jobs by status and payer, invoices + balances, estimates sent / approved, calls per tech per week) and pins them per department in `sundial_dashboards`. The Dashboard page gains a "My Dashboard" built from `GET /dashboards/me`; the existing stat cards stay.
- **R3** — `schedule` on a report (`cron`, recipients, format csv | pdf) → one EventBridge rule → `sundial-reports` `{ task: "deliver" }` → run → SES through `lib/email.js` (BASE64 attachment rule).
- **R4** — Reports page: "Describe the report you want" → the model (tool-use, the catalog + report types + business definitions in a cached prompt) returns a definition → shown as plain English + editable filter chips / column list → Run → Save. The model never sees rows. A `reports.ai` refusal (budget exhausted) leaves the chips editable by hand.

## 8. Open items
- Business definitions for the AI and the picker: "Active" = `NOT_TERMINAL_STAGES` (`sundial-sf-query`), "sold" = which stage values, "contract date" = `Contract_Date__c`, "revenue" = `contract_amount` vs invoice `total`. Collect as `docs/reporting-glossary.md` during R2 while authoring the starter set.
- Harmon's own wish list (not yet available): changes which saved reports exist, not the architecture.
- Commercial (`Sundial_Commercial__c`) is not cached today; it joins the catalog when Phase 3 lands.
