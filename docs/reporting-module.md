# Reporting Module — design (2026-10-30)

> Status: DESIGN, agreed with Tim 2026-10-30. R0 built and run 2026-11-02; R1a (the engine, solar type) built 2026-11-03 — D-088; R1b 2026-11-04 — D-089; R3 2026-11-10 — D-091; R4 (the report assistant) 2026-11-10 — D-092; summary reports (`showDetails`) 2026-11-11 — D-093.
> Decision to record in DECISIONS.md: **D-087 — reports run on the Supabase cache; Salesforce is never the report engine.** Supersedes CLAUDE.md "Key UI Components" item 11 ("Reporting — Salesforce reports surfaced in portal UI").

## 1. What Harmon needs

1. **Recurring reports** delivered on a schedule (set up ahead of time by Constructive Ops).
2. **A fixed dashboard per department / access level** ("My Dashboard"): the relevant reports, charts and numbers, shown on arrival, not editable by the user.
3. **Custom reports** the office can create and run themselves, with CSV download.
4. Existing access rules apply: tenant isolation, the cost / payroll gates, module gating.

## 2. Decisions

- **D-087.** Every report is a query against the Supabase cache tables. Salesforce is the source of truth and the sync keeps the cache current (D-079: every 5 min for the hot objects); it is never queried by a report run. Native Salesforce reports, the Analytics REST API and SF dashboards are out of scope permanently (API budget, no per-user scoping, and Harmon holds no SF licenses).
- **v1 scope is the office portal, tenant-scope roles only** (Admin / Executive / Manager and the other `TENANT_ACCESS_LEVELS`). Sales Rep / Sales Dealer are excluded from v1 — they have the dealer app and the manifests; the reporting routes answer them `403 MODULE_FORBIDDEN` like any other module they lack (D-088; `404` once a route names a saved report). Nothing in the engine assumes this forever: the row filter and the field manifest plug in at the same point the list reads use them.
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

## 6. R1 — the engine (D-088 R1a built 2026-11-03, `feature/reports-engine`; D-089 R1b built 2026-11-04, `feature/reports-r1b`)

R1 is split. **R1a (built):** the catalog, the report-type shape, the definition validator, the executor, and `POST /reports/run` / `GET /reports/types` / `GET /reports/catalog` for the `solar` type only. **R1b (built):** the dealer cache table (`sundial_dealer_cache`, reports-only), the three join kinds (lookup / latest / rollup), all ten report types, the CSV export (asynchronous, to S3) and saved reports with private / tenant sharing.

### 6.1 Field catalog (built)
`scripts/generate-report-catalog.mjs` (decisions in `lib/report-catalog-build.js`) writes `lib/report-catalog/<object>.json` for all 15 cached objects (R1b added `dealer`: 18 catalog rows from the live `sundial_dealer_cache`; the seed now holds 1,372), plus `lib/report-catalog/index.js`, plus **`sql/2026-11-03_report_catalog.sql`**, which creates and seeds `public.sundial_report_catalog (object_key, table_name, column_name, data_type, gate, reportable)`. JSON and SQL come from the same entries; a test pins that they agree.
- **Columns come only from `lib/report-columns.js` `planTable()`.** That means its `existing` columns plus `type_mismatch` ones (with the live type), plus the two control columns `sf_id` (a join key, `reportable: false`) and `created_date`. A cache column with no Salesforce field behind it is not in the catalog. `client_sf_id` never is: the tenant clause belongs to the function. Workbooks, `OBJECTS` and the live-column reader are shared with R0's generator (`scripts/lib/report-sources.mjs`).
- **Each entry:** `column`, `sfField`, `label` (workbook, else describe), `section`, `type` (text | number | boolean | date | datetime | picklist | multipicklist | reference), `pgType` (live), `picklistValues` (active, from describe), `description` (the workbook's description / help text column, else describe help text — also what the R4 AI reads), `gate`, `reportable`, `longText` (textarea > 255).
- **Gates:** `service.costing.read` on the `lib/cost-gate.js` columns (price-book `labor_cost` / `material_cost`, line `unit_labor_cost` / `unit_material_cost`, estimate `markup_type` / `markup_value` / `markup_amount`). There is **no payroll-gated column**: `Hourly_Cost_Rate__c` is not cached (R0 refused it as sensitive).
- **`reportable: false`:** `sf_id`, credentials (`sensitiveReason`), and the bookkeeping fields `IsDeleted` / `LastViewedDate` / `LastReferencedDate`.
- **Re-run the generator after any new cache column**, then run its SQL and redeploy `sundial-reports`. Until then the column is not reportable.
- **Name field (D-089 am. 1, 2026-11-09):** the column holding the describe's `nameField` carries **`nameField: true`** — exactly one per object (pinned by the test). `Sundial_Solar__c.Name` is not cached, so `NAME_FIELD_FALLBACK` in `lib/report-catalog-build.js` names `Project_Name__c` instead (solar's name field is `project_name`). `GET /reports/catalog` passes it through.
- **`long_text` in the SQL seed (D-089 am. 1):** the seed now carries each column's long-text flag (`alter table … add column if not exists long_text`), because `sundial_report_values` must refuse long text and the database had no other way to know it.

### 6.2 Report types (all ten built)
Shape (`lib/report-types.js`): `{ key, label, base: { object, alias, label }, joins: [{ object, alias, label, kind, on: { left: "<alias>.<column>", right: "<column>" }, where?, measures? }], defaultColumns }`. `on` is data; the function builds the join (with the tenant clause inside it) after checking each part against the catalog.

**Join kinds (D-089).** Each yields at most one row per base row, so **a report always has exactly its base object's rows**. No join ever repeats a customer.
- **lookup** — a lookup field to the one record it names (`right` = `sf_id`). R1a's `"left"` is the same thing and is still accepted.
- **latest** — the newest child: `ORDER BY created_date DESC NULLS LAST, sf_id ASC`, the dealer shell's "leading solar" order, optionally narrowed by `where`. It is built as one narrow `DISTINCT ON` pass over the child table and then a primary-key join. A per-row `LATERAL … LIMIT 1` took **14 s** for 39,431 customers × solar (the solar customer index is keyed on `tenant_id`, not `client_sf_id`); this takes **0.7 s**.
- **rollup** — one `GROUP BY` pass over the children, giving one row of **measures** per parent. The measures are declared in the type: `count`, `sum` (optionally `negateWhen`, so a positive Refund subtracts) and `max`, each with an optional `where`; the join's `where` narrows them all. **A rollup alias's only fields are its measures**: `payments.amount_paid`, never `payments.amount`. **A count or a sum over no children reads as 0** (coalesced wherever it is referenced), and a max reads as blank.

| # | Type | Base ⟕ joins (alias = object on key) | Live join coverage (2026-11-04) |
|---|---|---|---|
| 1 | `customers` | customer ⟕ `dealer` (dealer_sf_id) ⟕ `rep` = user (sales_rep_sf_id) ⟕ `assignee` = user (assigned_to_sf_id) | dealer 7,109 of 39,528 · rep 14,365 · assignee 669 |
| 2 | `customers_solar` | customer ⟕ **latest** `solar` (sundial_customer_sf_id) ⟕ `dealer` ⟕ `rep` (the customer's) | 113 customers have > 1 solar; the newest leads |
| 3 | `solar` | solar ⟕ `customer` ⟕ `rep` ⟕ `dealer` (solar.dealer_sf_id — R1b) | customer 4,595 · dealer 2,970 · rep 3,386 |
| 4 | `roofing` | roofing ⟕ `customer` ⟕ `dealer` ⟕ `rep` ⟕ `pm` = user (project_manager_sf_id — a real lookup on roofing) | 12 rows: 12 / 10 / 11 / 11 |
| 5 | `service_jobs` | job ⟕ `customer` ⟕ `bill_to` = customer ⟕ `estimate` ⟕ **latest** `invoice` (status not Void) ⟕ **rollup** `payments` by job ⟕ `assignee` = user | invoice: 111 jobs have > 1, 76 have > 1 non-Void (HCP, max 3), 344 have none |
| 6 | `service_calls` | call ⟕ `job` ⟕ `customer` (through the job) ⟕ `tech` = user | 45 Event calls have no job (blank job / customer) |
| 7 | `estimates` | estimate ⟕ `customer` ⟕ `job` ⟕ `sold_by` = user | customer 2,955 · job 2,636 · sold_by 51 |
| 8 | `estimate_lines` | line ⟕ `estimate` ⟕ `customer` (through the estimate) ⟕ `item` = price-book item | estimate 6,103 · item 2,693 |
| 9 | `invoices_payments` | invoice ⟕ `job` ⟕ `customer` (through the job) ⟕ `bill_to` = customer ⟕ **rollup** `payments` by invoice | one row per invoice |
| 10 | `payments` | payment ⟕ `invoice` ⟕ `job` ⟕ `customer` (through the job) | job 1,019 · invoice 1,011 |

**The payments rollup** is shared by #5 (keyed on the job, so a deposit taken before the invoice counts) and #9 (keyed on the invoice). Only **Succeeded** rows count; all 1,019 live rows are Succeeded today. The measures are `payment_count`, `amount_paid` (net: Refunds subtract), `deposits_paid`, `refunds` and `last_paid_at` (max `received_at`).
**How #5 fits one group level:** both the invoice and the payments are single-row joins, so "jobs by status with invoice total and amount paid" is an ordinary grouped report: `groupBy job.status`, `sum invoice.total`, `sum payments.amount_paid`.
**Not joined, on purpose:** a user as PM on solar (`Project_Manager__c` is a multipicklist; use `solar.project_manager`); servicecall → solar / roofing (0 rows set); customer setter / sat-by / appointment (37 / 0 / 0 rows). **No new gate on dealer redlines or vendor ids** (Tim, 2026-11-04): they are ordinary reportable columns for tenant scope.

**Record pages (D-089 am. 1, 2026-11-09)** live once, in `lib/report-types.js`: `RECORD_PATHS` (customer `/customers/{id}`, solar `/projects/solar/{id}`, roofing `/projects/roofing/{id}`, job `/service/jobs/{id}`, estimate `/service/estimates/{id}`) and `LINK_VIA` (serviceinvoice / servicepayment / servicecall → the `job` alias, serviceline → the `estimate` alias). `recordLinkOf(type, alias)` answers `{ recordPath }`, `{ linkVia }` or null (user, dealer, price book item, any rollup); `GET /reports/types` returns `recordPath` / `linkVia` on every alias, so the portal keeps no map of its own. A test pins that every `linkVia` names an alias of the same type with a page.

### 6.3 Report definition (JSON) — `lib/report-def.js`
```json
{
  "type": "solar",
  "columns": ["solar.project_name", "customer.name", "solar.stage", "rep.name", "solar.contract_amount"],
  "filters": [
    { "field": "solar.stage", "op": "in", "value": ["Sold", "Sold - Pending Review"] },
    { "field": "solar.contract_date", "op": "between", "value": "this_quarter" }
  ],
  "groupBy": ["rep.name"],
  "aggregates": [{ "fn": "sum", "field": "solar.contract_amount" }, { "fn": "count" }],
  "sort": [{ "field": "sum_solar_contract_amount", "dir": "desc" }],
  "limit": 5000,
  "chart": { "kind": "bar", "x": "rep.name", "y": "sum_solar_contract_amount" }
}
```
- **Fields** are `<alias>.<column>`. The alias must be the type's, and the column a reportable catalog column. Any other top-level key is refused, so a tenant cannot be smuggled in.
- **Operators:**
  - text / picklist / multipicklist: `eq, neq, in, not_in, contains, starts_with, is_blank, not_blank`
  - reference: `eq, neq, in, not_in, is_blank, not_blank`
  - number: `eq, neq, gt, gte, lt, lte, between, is_blank`
  - date / datetime: `eq, before, after, between, is_blank`
  - boolean: `eq, is_blank`

  `neq` / `not_in` include blank rows. `contains` / `starts_with` are case-insensitive, with wildcards in the value taken literally.
- **Relative dates** (`today`, `this_week`, `last_week`, `this_month`, `last_month`, `this_quarter`, `last_quarter`, `this_year`, `last_year`, `ytd`, `last_n_days:N` = N days ending today) are resolved on the server in **America/Phoenix** (UTC-07:00 all year), as a value of `eq` or `between`. Weeks start **Monday**; quarters and years are calendar ones; `this_*` periods run to the period's end, `ytd` to today. The list is `RELATIVE_TOKENS` in `lib/report-def.js` (D-092 added `today`, the weeks, `last_quarter` and the years). A datetime filter means whole Arizona days. This is what makes a saved report re-runnable.
- **Shape:**
  - One group level. When grouped without details, the columns are the group, then the aggregates.
  - **Summary reports (D-093, 2026-11-11):** `"showDetails": true` (only with a `groupBy`, else `400 DETAILS_NEED_GROUP`) lists each record UNDER its group, the way a Salesforce summary report does. The columns are the user's own (default: the type's default columns), and the group field may or may not be among them. Aggregates, `dateTrunc`, `limit` and `chart` keep their meaning. The rows are ordered by the group value (ascending, blanks last), then the sort, then the record id. **Sort is on shown columns only**: an aggregate or the group field is `400 BAD_SORT` (ordering the groups by a total is a later item). A group field the caller's gate removes leaves a plain detail report. Example: `{ "type": "solar", "showDetails": true, "groupBy": ["rep.name"], "columns": ["solar.project_name", "solar.contract_amount"], "aggregates": [{ "fn": "sum", "field": "solar.contract_amount" }], "sort": [{ "field": "solar.contract_amount", "dir": "desc" }] }`.
  - **Group by period (D-091):** a `groupBy` entry may be `{ "field": "solar.contract_date", "dateTrunc": "month" }` — `day` | `week` | `month` | `quarter` | `year`, on a date or datetime field only (`400 BAD_GROUP` otherwise). The group's value is the period's first day (`"2026-11-01"`), the output column is a `date` labelled "Contract Signed Date (month)". A datetime is bucketed by its **Arizona** date (11:30 PM on Oct 31 in Phoenix is October); weeks start **Monday**. The wire column carries `trunc`; `sundial_report_run` re-checks it and RAISES on anything else. A plain string group is unchanged.
  - Aggregates are `count` (no field), `sum` / `avg` (numbers) and `min` / `max` (numbers, dates). Each is named `<fn>_<alias>_<column>`, or `count`.
  - Sort only on what the report shows, with aggregates only when grouped.
  - Limits: `limit` ≤ 5,000 on screen and ≤ 50,000 for a CSV (where it is also the default); ≤ 50 columns, 50 filters, 10 aggregates, 5 sorts.
- **Long text** can be filtered on everywhere and **selected only in a CSV** (`normalizeDefinition(def, { mode: "csv" })`; the screen's 6 MB response is why). It is never grouped or sorted.
- **Gated columns** are removed for a caller without the gate (`stripped` names them), never refused.
- Every rejection is a **400 that names the field** (`{ error: "invalid_report", code, field, message }`).

### 6.4 Execution — plpgsql (D-088)
`public.sundial_report_run(p_client_sf_id text, p_def jsonb)` (`sql/sundial_report_run.sql`, with the helper `sundial_report_column`). SECURITY DEFINER; EXECUTE revoked from public / anon / authenticated.
- **It receives the normalized "wire" definition.** That is the base table, the resolved joins (with a latest's `where` and a rollup's `measures`), the columns, the filters (already in Arizona dates), the aggregates, the sort as output positions, the limit, `offset` (0–49,999, the CSV pages) and `totals` (false skips the grand totals), and `allowedGates`.
- **Helpers** (same file, same revokes): `sundial_report_column` (one identifier vs the catalog; a rollup alias's columns are its measures), `sundial_report_join_where` (a join's `in` / `not_in` items, text columns only), and `sundial_report_ref` (how a column is written: `coalesce(…, 0)` for a rollup count / sum).
- **It re-checks every identifier** against `sundial_report_catalog` and **RAISES** on an unknown table / alias / column / operator / aggregate, a non-reportable column, or a gated column whose gate is not in `allowedGates`. It builds SQL with `%I` / `%L` only.
- **The tenant clause** `client_sf_id = p_client_sf_id` is the first predicate on the base table and is inside every join: a lookup's ON, a latest's and a rollup's inner WHERE, and a latest's primary-key join.
- **Sort and cap.** Rows are sorted with a deterministic tiebreak (the record id, or the group value) and fetched `limit + 1` for `truncated`.
- **It returns** `{ rows: [[…]], aggregates: { name: value }, truncated }`. The aggregates are grand totals over **every** matching row.
- **Record links (D-089 am. 1).** An UNGROUPED wire carries `records: [{ alias, column }]` — every record alias of the type (base, lookups, latest; never a rollup) with its catalog name column (`normalizeDefinition` builds it; not a column, not filterable, not counted against the 50). The function checks each alias is a TABLE alias and each column a reportable, ungated catalog column, then returns **`records`** parallel to `rows`: `[{ "<alias>": { sfId, name } | null }]`, null where the left join found nothing. They are read from the rows already joined, so the tenant clause covers them. A grouped wire with `records` RAISES; a grouped response has no `records` key.
- **Summary runs (D-093, 2026-11-11).** The wire is ungrouped (`grouped: false`, `records` kept) plus `group: { alias, column, trunc? }` and `details: true`; the group is re-checked like any column (its `trunc` like a grouped column's) and the function RAISES on `grouped` + `group`, on a group without `details` and on `details` without a group. Rows are ordered `group asc nulls last`, then the sort, then the record id. **One call** returns, besides `rows` / `records` / `aggregates` / `truncated`:
  - **`groups`** — one entry per group with a row ON THIS PAGE, in page order: `{ key, first, shown, count, aggregates }`. `first` / `shown` = the group's rows on the page (one unbroken run); `count` and `aggregates` (`{ name: value }`) cover ALL its matching rows. `key` is the group value as JSON (null = blank). Built by one `GROUP BY` pass narrowed to the page's group values. Only the page's groups: a group per customer name is ~37,000 groups, too many for the response.
  - **`groupCount`** / **`totalRows`** — all the groups and all the matching rows (only when `totals` is true; null otherwise).

  Measured on the live cache (Harmon, 39,470 customers ⟕ rep, 2026-11-11): the 5,000-row detail page **231 ms**, a group pass **31 ms** (**187 ms** when it must sort and spill) — ~0.3–0.45 s in the database. One call, not two: the same work without a second round trip, and the groups read the same snapshot as the rows (a second call could straddle a cache sync). The Lambda labels each group (`lib/report-groups.js` `groupLabel`) and answers `500 REPORT_ENGINE_OUTDATED` if the function returned no `groups` (the SQL was not re-run).
- **`public.sundial_report_values(p_client_sf_id, p_table, p_column, p_search)`** (`sql/sundial_report_values.sql`, D-089 am. 1) → `{ values: [{ value, count }], total_distinct }`: the tenant's distinct non-blank values of one column, narrowed by a case-insensitive contains (`%` `_` `\` taken literally), most frequent first then by value, at most 200. Same rules: SECURITY DEFINER, EXECUTE revoked from public / anon / authenticated, table + column re-checked against the catalog. It RAISES on a non-reportable, gated (always — a value list has no gate check), id (`sf_id`, `*_sf_id`), long-text or non-text column.
- **Tests:** `sql/sundial_report_run.test.js` (PGlite) loads the real function and the real catalog seed and builds its definitions with the real `normalizeDefinition`.

Option (b) (`pg` from the Lambda) is not used. The CSV export pages the same function with `offset` (§6.7); the deterministic tiebreak is what makes the pages partition the result exactly.

### 6.5 Routes and actions (`sundial-reports` Lambda)
**Built (R1a):**
- `POST /reports/run` → `{ type, columns: [{ field, label, type }], rows, aggregates: [{ field, label, type, aggregate, value }], truncated, limit, stripped, asOf }`
- `GET /reports/types`
- `GET /reports/catalog?type=solar` (the type's fields per alias, projected for the caller: gated and non-reportable removed, with each field's operators)

Action **`reports.read`** = tenant scope (Executive / Admin / Manager), always enforced. Anyone else gets **403 `MODULE_FORBIDDEN`** on every route. `asOf` = the oldest of the joined objects' newest successful sync (`cache_sync_runs`), shown on every report ("data as of 2:35 PM"). A RAISE from the function is `500 REPORT_CATALOG_MISMATCH` (the database's catalog is older than the Lambda's).
**Built (D-089 am. 1, 2026-11-09):**
- `POST /reports/run` and `GET /reports/{id}/run` return **`records`** on an ungrouped run (§6.4), parallel to `rows`; `GET /reports/types` adds `recordPath` / `linkVia` per alias; `GET /reports/catalog` adds `nameField: true` and **`valuesLookup: true`** (a reportable, ungated, short text / picklist / multipicklist column of a table, never an id — `lib/report-def.js` `valuesLookupAllowed`, the one rule the route and the catalog share).
- **`GET /reports/values?type=&field=<alias.column>&q=`** → `{ type, field, values: [{ value, count }], totalDistinct, partial }` (`partial` = more than the 200 returned). Same identity, `reports.read` and gate handling as the catalog: a gated field the caller does not hold is `400 UNKNOWN_FIELD`; a field `valuesLookupAllowed` refuses is `400 VALUES_NOT_AVAILABLE`; `q` ≤ 100 characters (`400 BAD_VALUE`). The field resolves through the type's aliases (a joined alias reads its own object's table). A RAISE is `500 REPORT_CATALOG_MISMATCH`.

**Built (R1b, D-089):**
- `POST /reports/csv` → **202** `{ exportId, status: "queued", stripped }`; `GET /reports/csv/{exportId}` → `{ status: queued | running | done | failed, url, rowCount, truncated, stripped, asOf, expiresAt, code? }` (§6.7).
- `GET /reports` (mine + shared with my tenant, newest first) · `POST /reports` → 201 · `GET` / `PATCH` / `DELETE /reports/{id}` · `GET /reports/{id}/run` (the run response + `report: { id, name }`) · `GET /reports/{id}/csv` → 202 `{ exportId }`.

Actions:
- **`reports.write`** = every tenant level: create a report, and edit / delete your own.
- **`reports.share`** = every tenant level, Managers included (Tim, 2026-11-04; no `ACTION_LEVELS` row): **the owner** sets their report's sharing to `tenant`.
- **The owner may always set their own report back to private.**
- **Only the owner edits or deletes a report.** A report someone else shared is read-only to everyone, Admins included, until `reports.admin` (R2).

**The 404 rule:** a saved report or an export the caller may not see (another tenant's, someone else's private one, someone else's export) answers **404 `RECORD_NOT_FOUND`**, the same as one that does not exist. `reports.read` is checked first, so a sales user gets 403 `MODULE_FORBIDDEN` on every route.
Error codes: editing or deleting a report someone else owns (and shared) is **403 `REPORT_READ_ONLY`**. A share without `reports.share` is **403 `SHARE_FORBIDDEN`**; no office level hits it today.

**R2+:** `GET /dashboards/me`. Actions **`reports.admin`** (Admin / Executive): **see and manage every report in the tenant**, anyone's, shared or private, plus the dashboards.

**Built (R4, D-092):** `POST /reports/assist`, action **`reports.ai`** (every tenant level). Its budget — turns per tenant per month and per user per day — lives in **`private.app_config`**, read inside `sundial_report_assist_claim` (§7.2); `sundial/anthropic` holds only the API key. (This sketch had said the budget would be in `sundial/anthropic`.)

### 6.6 Storage — saved reports (built, R1b) / dashboards (R2)
`sql/sundial_reports.sql`: **`public.sundial_reports`** (id uuid, client_sf_id, owner_profile_id, name ≤ 120, description ≤ 2,000, definition jsonb, **sharing `private` | `tenant`**, created_at / updated_at / created_by / updated_by). There is no foreign key on the owner: a deleted login must not delete reports others rely on, and the id always comes from the verified JWT. `schedule` is R3. Rules in `lib/saved-reports.js`:
- **Visible** = same tenant AND (owner OR `sharing = 'tenant'`).
- **The stored definition is what the saver could see.** Columns the saver's gates strip are removed before saving. It must be a valid on-screen definition. **Whoever runs it gets it re-validated with their own gates**, so a Manager running an Admin's shared cost report never sees a cost.

`public.sundial_dashboards` (R2) is keyed on **`Default_Department__c`** (D-088), with a layout jsonb of report ids + sizes. Everything is service-role only, like the caches; the browser talks to the Lambda.

### 6.7 CSV export (built, R1b — `lambdas/sundial-reports/csv.js`, `lib/report-csv.js`)
**Asynchronous, because the measurements said so** (2026-11-04, Tim's decision 9):
- A 5,000-row page of customers takes **0.4–0.8 s** end to end (12 → 50 columns, ~1.9 MB of JSON → ~1 MB of CSV).
- **The cost of an offset grows**: Postgres re-sorts everything before the page. The page at offset 34,000 with 50 columns took **2.1 s** in the database alone, and 19 s with every column.
- A 50,000-row export is 10 such pages, and a long-text export is 25 pages of 2,000, so it cannot be promised inside API Gateway's 29 s.

How it runs:
1. `POST /reports/csv` validates in CSV mode, writes a `queued` row to **`public.sundial_report_exports`** (owner, tenant, the normalized `job`) and invokes the Lambda **itself** (`InvocationType: Event`, payload `{ task: "csv", exportId }`). It answers 202 at once.
2. **The worker** claims the row (`queued → running`, so a retried invoke never runs twice; async retries are 0 anyway). It pages `sundial_report_run` (`limit` 5,000 or 2,000 with long text, `offset`, `totals: false`) until a page is not truncated or `rowLimit` is reached (then `truncated: true`). Each page is appended to an **8 MB part buffer**, and a full buffer is uploaded as one S3 multipart part, so memory peaks at one page + one part (~20 MB). A file under 8 MB is one PutObject. The worker stops itself 20 s before the 300 s timeout with **`CSV_TOO_SLOW`** (the multipart upload is aborted). A function RAISE is **`REPORT_CATALOG_MISMATCH`**.
3. **`GET /reports/csv/{exportId}`** returns the status. When `done`, it signs a **presigned GET valid 15 minutes** from that read, with a download name of `<type>-<date>.csv`. A row still queued / running after 10 minutes reads **`CSV_EXPORT_LOST`**.

The S3 object:
- **Location:** `sfsolproj` **`REPORTS/<client_sf_id>/<yyyy-mm-dd>/<exportId>.csv`**, **never `SUNDIAL/`**. That tree holds the Salesforce-record folders XFiles Pro and the Dropbox copy-back read, and these files hold contact details.
- **Encryption and expiry:** SSE-S3. A **7-day lifecycle rule scoped to `REPORTS/`** deletes the file (`scripts/add-reports-lifecycle.ps1` merges it into the bucket's existing rules, never replacing them).

The file format:
- UTF-8 with a BOM, CRLF, RFC 4180 quoting.
- Headers are `<object label>: <field label>` ("Customer: Customer Name", "Sales rep: User Name"); aggregate headers keep their own labels.
- **A text value starting with `= + - @` TAB or CR gets a leading `'`**, so a spreadsheet does not run it as a formula. Numbers are never changed this way.
- Datetimes are in **Arizona** time (`YYYY-MM-DD HH:MM`), booleans `Yes` / `No`, blanks empty.
- **A summary export (D-093):** the group value first, then the columns, then **one trailing column per aggregate** (blank on a detail row), then the link columns. After each group's last row comes `Subtotal: <group label> (n records)` with the group's aggregates over ALL its rows; the file ends with `Grand total (n records)` and the grand totals. The first page asks for the totals; the writer (`lib/report-csv.js` `createSummaryCsv`) remembers the open group across pages, so a group split by a page break gets one subtotal. A group cut by the 50,000-row cap still gets its subtotal, with its full count.
- **Link columns (D-089 am. 1):** an UNGROUPED export ends each row with one column per record alias that has a page (`lib/report-csv.js` `linkColumns`), titled **`<alias label> link`** ("Customer link", "Payment link"), holding the full URL — the tenant's portal origin + the record path. A `linkVia` alias keeps its own label and opens its parent ("Payment link" → the job). The origin is **`lib/tenant-settings.js` `portalUrlFor`**, the one the invite and mention emails use: the primary tenant's `PORTAL_BASE_URL` (default `https://sundial.harmonelectric.net`, no secret read), any other tenant's `sundial/brand` `portalUrl` (conops-demo: `https://sundial.constructiveoperations.com`). It is resolved once, when the export is queued, and stored in the job. No address → the export has no link columns, never another tenant's. Grouped exports have none.

**Lambda:** 1,024 MB (for CPU; the memory is not needed for space), 300 s.
**IAM:** inline policy `sundial-reports-export`: self-invoke + `sfsolproj/REPORTS/*` objects.
**Logs:** counts, pages, bytes and ms. Never a row, a value or the URL.

## 7. R2–R4
- **R2** (deferred, sketch) — Tim authors the starter set as saved definitions (pipeline by stage / rep, solar by PM and stage with contract totals, service jobs by status and payer, invoices + balances, estimates sent / approved, calls per tech per week) and pins them per department in `sundial_dashboards`. The Dashboard page gains a "My Dashboard" built from `GET /dashboards/me`; the existing stat cards stay.
- **R4** — the report assistant. Built 2026-11-10 (D-092, `feature/reports-r4`) — §7.2. The Reports page's "Describe the report you want" box, the plain-English summary and the editable chips are harmon-crm's (not built yet).

### 7.1 R3 — scheduled delivery (built 2026-11-10, D-091, `feature/reports-r3`)
A saved report goes out by email on a schedule. The sketch said `cron`, format `csv | pdf` and `{ task: "deliver" }`; as built it is cadences, CSV only, and `{ task: "tick" }`.

**The schedule** is on the report row (`sql/2026-11-10_report_schedules.sql`): `schedule` jsonb, validated by `lib/report-schedule.js` `validateSchedule` —
```json
{ "cadence": "weekly", "time": "07:00", "days": ["mon", "thu"], "recipients": [{ "userId": "a0U…" }, { "email": "partner@example.com" }], "format": "csv", "enabled": true }
```
- `cadence` daily | weekly (`days`, at least one of mon…sun) | monthly (`dayOfMonth` 1–31; past a shorter month's end, its last day). `time` on the quarter hour (:00 :15 :30 :45), **Arizona time**. `format` is `csv` (no report PDF exists).
- `next_run_at` = the first slot strictly after the later of now and the slot just run (`nextRunAt`). America/Phoenix is UTC−07:00 all year (no daylight saving), so 07:00 is always 14:00 UTC; a missed tick sends once, never a burst.
- Also on the row: `last_run_at`, `last_run_status` (running / ok / partial / failed / disabled), `last_run_error` (a code), `consecutive_failures`, `last_export_id`.

**Recipients** (≤ 25). The picker, `GET /reports/recipients`, is the tenant's **active Executive / Admin / Manager users with an email** (`sundial_user_cache`), stored by user id. **Anyone else is an outside address** (a sales rep, a tech, anyone outside) and needs **`reports.schedule.external`** (Admin / Executive) — `403 EXTERNAL_RECIPIENT_FORBIDDEN`. An email typed that is an eligible user's is stored as the user. Each send re-checks: a user no longer eligible, or an outside address the owner may no longer send to, is skipped (`skipped`).

**The owner is the sender.** Every delivery re-reads the owner (`lib/identity.js` `resolveIdentityForProfile`, the login's own code) and runs the report with **the owner's** gates, so a Manager on an Admin's cost report receives the costs. An owner who is gone, inactive, in another tenant or no longer tenant-level turns the schedule off at once (`OWNER_NOT_ALLOWED`).

**The tick.** EventBridge `sundial-reports-tick`, `cron(0/15 * * * ? *)` → `{ task: "tick" }` (`scripts/wire-reports-schedule.ps1`):
1. A run still `running` 15 minutes on is recorded (its export's delivery if it got that far, else `DELIVERY_LOST`).
2. At most **5** due schedules are read (`schedule->>enabled = 'true' and next_run_at <= now`, partial index `idx_sundial_reports_due`).
3. **Claim before run:** one conditional update per row moves `next_run_at` to the next slot WHERE it is still what was read; a racing tick updates nothing and skips it.
4. Each claimed schedule is queued down the CSV export path (`csv.js` `queueExport`) with a `delivery` block — **one background worker per delivery**, each with the Lambda's 300 s. The export id is stamped on the report before the worker starts.

**The delivery** (`deliver.js`, the worker's `onFinished` hook, after the CSV is written):
- One email per recipient, from `EMAIL_FROM`, Reply-To the owner, subject `<report name> — Nov 10, 2026` (Arizona date) — `lib/report-email.js`.
- **Under 8 MB: the CSV attached.** **8 MB or more: a link per recipient**, `GET /public/reports/download/{token}`, valid **7 days** — a random token whose SHA-256 alone is stored (`sundial_report_downloads`); following it 302s to a fresh 15-minute S3 link. 20 follows per link (then 429), 410 when expired; logged by the hash's first 12 characters only. (A presigned URL straight from the Lambda dies with its short-lived credentials, hours not days.)
- **A grouped report also draws its first 100 rows in the body** (the on-screen wire, `limit` 100). **A summary report (D-093)** draws its first 100 detail rows under their group headings (each with the group's full record count), each group's subtotal and the grand total.
- What happened — per recipient, the SES message id — is the export row's `delivery`; `GET /reports/csv/{exportId}` shows the counts.
- The outcome lands on the report: ok / partial / failed. **Three failures in a row** set `enabled: false`, status `disabled`, and email the owner once.

**Routes:** `GET` / `PUT` / `DELETE /reports/{id}/schedule` (owner), `POST /reports/{id}/send-now` (owner; `{ toMe: true }` = to the caller only, recorded nowhere), `GET /reports/recipients`, and `GET /reports` carries each report's schedule summary (never its recipients). Details: `docs/api-endpoints.md`.

**Proof:** `node scripts/verify-report-schedule.mjs` (ZZ users; send-now to zz-admin checked by the SES result, a Manager's outside address refused, a forced-due schedule ticked twice at once runs once and advances).

### 7.2 R4 — the report assistant (built 2026-11-10, D-092, `feature/reports-r4`)

**What it is.** `POST /reports/assist`: plain English → a report DEFINITION, or ONE question; or a definition → a paragraph. The model never sees a row and never writes SQL. **Everything it proposes goes through `normalizeDefinition` with the caller's gates**, exactly like a hand-built definition, and what is returned is `stripDefinition(def, n.stripped)` — the object the editor holds, relative tokens kept. A saved report never consults the model again (D-087).

**Three modes.**
- **build** — messages (+ `type`?). With no type, a small router call picks one of the ten from one-line descriptions (or asks).
- **refine** — messages + `currentDefinition` (validated first; its type is the type). The current definition rides in the last user message.
- **explain** — `currentDefinition` → one paragraph. Same cached prefix, `tool_choice: none`.

**The tool IS the definition rules** (`lib/report-assist-schema.js`). `propose_report`'s JSON schema is generated per report type and per caller:
- every field is an enum of that type's `alias.column` names, defined once under `$defs` and referenced, minus non-reportable and gated fields (for a caller without the gate, a cost column does not exist);
- a filter is one of ~14 branches, one per field family × operator group, so an operator a field does not allow, or a value of the wrong shape, cannot be written;
- groupBy is a field or `{ field, dateTrunc }` on a date; aggregates are count / sum-avg of numbers / min-max of numbers and dates.

A test runs every field × operator × value shape the schema offers through `normalizeDefinition`, for all ten types with and without the cost gate. What the schema cannot express (one group level, the 50 / 10 / 5 limits, sort naming a shown column) is in the descriptions and enforced by the validator. `ask_question` takes one question.

**The call.**
- Model `REPORT_ASSIST_MODEL` (default `claude-sonnet-5-5`), adaptive thinking at effort `low`, the server-side refusal fallback on (`fallbacks: "default"`).
- Sonnet 5.5 refuses forced tool use, so `tool_choice: auto` (one call at most) plus `strict: true`. If the API refuses the strict schema, the same call goes again without strict, remembered for that type and gate set. A turn that ends in text is the question.
- `maxRetries: 0`; the turn has a 26 s budget inside API Gateway's 29 s.

**Two attempts.** A proposal the validator refuses goes back once as an error `tool_result` naming the code and the field (append-only: the assistant turn exactly as returned). A second refusal, or less than 10 s left, becomes a question that names the problem (`outcome: invalid`).

**Prompt caching.** The cached prefix is tools → system: the rules + `docs/reporting-glossary.md` (`lib/report-glossary.js`, generated) + the type's catalog block (one line per field: `alias.column | label | type | picklist values | notes`). Its breakpoint is on the last system block with a 1-hour TTL. It is a pure function of (type, gate set): ≤ 20 variants plus the router's. Today's date rides on the last user message, after the cache.

Size, measured from the generated text at about 3.6 characters a token (the verify script prints the API's real counts):

| Type | Approximate cached prefix |
|---|---|
| customers | ~25k |
| service_calls / estimates / estimate_lines / payments | ~28–30k |
| roofing | ~35k |
| invoices_payments | ~44k |
| service_jobs | ~48k |
| solar / customers_solar | ~53k |

At Sonnet 5.5 prices ($2 / $10 per million in / out, $0.10 cache read, $4 cache write at 1 h), a warm turn costs about $0.01–0.03 and the first turn of an hour adds about $0.10–0.21 for the cache write.

**The budget.**
- `sql/2026-11-10_report_assist.sql`: `sundial_report_assist_usage` holds one counter per tenant per Arizona month and per user per Arizona day. `sundial_report_assist_claim` checks and increments both atomically, or neither, BEFORE the model is called; `_release` gives the turn back after an upstream failure.
- The limits are `private.app_config` `report_assist_tenant_month_limit` (500) / `report_assist_user_day_limit` (40), read inside the function. A missing or junk value means the default; 0 turns it off. Over a limit: `429 ASSIST_BUDGET_EXHAUSTED { scope, limit, resetsAt }`. The editor never needs this route.
- A refusal or a question counts; an upstream 5xx / timeout / API error is released. The key (`sundial/anthropic` `api_key`, `apiKey` accepted) is one shared Constructive Ops key, a platform service like SES — not a D-078 single-credential integration.

**The log.** `sundial_report_assist_log`, 90 days: the last user message, the reply / question, the validated definition, outcome, attempts, validation codes, strict, model, tokens, per-call kinds and ms. Never a row. The 15-minute tick (`schedule.js` `runTick`) deletes older rows and old per-user day counters, best effort.

**The glossary** (`docs/reporting-glossary.md`) is the business meaning of words — sold, active, open job, unpaid, paid, revenue (ask), the stage families, the status lists. Tests pin that every `alias.column` it names is a real field, its terminal stage line is exactly `lib/stage-rules.js`, every relative token is listed and every job / invoice / solar / customer status value appears. **Editing it needs `node scripts/generate-report-glossary.mjs` and a redeploy** of `sundial-reports`.

**"Active" was corrected on the way (D-092).** The Dashboard's terminal rule was a substring match that called "Inspection Completed" and "Go Back Items Complete" finished. It is now the explicit list `SOLAR_TERMINAL_STAGES` in `lib/stage-rules.js`, used by the Dashboard (`sundial_solar_pipeline` `p_terminal_stages`) and the glossary alike.

**Proof:** `node scripts/verify-report-assist.mjs` (ZZ users): five canned requests that must come back as definitions that run, an ambiguous one that must come back as a question, refine, explain, a sales rep's 403, and the 429 by filling zz-admin's own daily counter (restored after). It prints tokens and latency per turn.

## 8. Open items
- ~~Business definitions for the AI~~ — `docs/reporting-glossary.md` (D-092), Tim to review the draft.
- **A second group level** ("calls per tech per week") — a later engine item (TASKS). The assistant asks or builds one level today.
- Harmon's own wish list (not yet available): changes which saved reports exist, not the architecture.
- Commercial (`Sundial_Commercial__c`) is not cached today; it joins the catalog when Phase 3 lands.
