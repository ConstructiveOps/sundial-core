# Migration — Housecall Pro (Phase 2), Sunbase and Dropbox

> Started 2026-09-25 with the HCP section. Sunbase (Phase 1 / 3) and Dropbox (Phase 1) are
> still to be written here; their working notes live in the punchlist and DISCOVERY.md.

## Housecall Pro → Sundial Service

Harmon runs the service department on HCP MAX (Ben's login is the top admin; Matt and Tim
share it for read / export). The goal is one clean pull of everything Harmon owns in HCP,
re-runnable at cutover for the delta, then an upsert into the Sundial service objects
(D-072) and the S3 file tree, so the office opens a job in Sundial and sees the history it
had in HCP.

### What comes from where

| Data | HCP's Excel exports | `scripts/hcp-pull.mjs` (the API) | Neither — see "the attachments gap" |
|---|---|---|---|
| Customers (name, phones, email, addresses, lead source, tags) | yes | yes (`raw/customers.json`, `csv/customers.csv`) | |
| Jobs — header (status, schedule, totals, assigned techs, the job's own *notes* field) | yes | yes (`raw/jobs.json`, `csv/jobs.csv`) | |
| Job **line items** (service / material, qty, unit price, unit cost) | no | yes (`raw/jobs/<id>.json`, `csv/job-line-items.csv`) | |
| Job **notes feed** (each note, author, time) | no | **no** — `/jobs/{id}/notes` is a 404 on this account; only the job's single `notes` text field comes back (`notes_field` in `jobs.csv`) | **yes** |
| Job **appointments** (each visit: start / end, which techs) | no | yes (`csv/appointments.csv`) | |
| Estimates — header + options | yes | yes (`csv/estimates.csv`) | |
| Estimate **option line items** | no | yes (`csv/estimate-line-items.csv`) | |
| Invoices — header (subtotal, amount, due, tax / discount totals, dates) | yes | yes (`csv/invoices.csv` — the list record carries the whole invoice) | |
| Invoice **line items** | no | yes (`csv/invoice-line-items.csv`) | |
| Invoice **payments / refunds** (method, amount, date) | no | yes (`csv/payments.csv`; refunds written negative) | |
| **Leads** (HCP's pre-estimate pipeline — Harmon's incoming calls) | no | yes, `/leads` (`raw/leads.json`, `csv/leads.csv`; added 2026-09-25 after the first probe, shape confirmed by the second) | |
| Employees, tags, job types, lead sources, company profile | no | yes (`csv/employees.csv`, `tags.csv`, …) | |
| Price book | export done 2026-09-15 → `salesforce/pricebook-import/` (imported on `HCP_Id__c`) | — | |
| **Photos and attachments** on jobs / estimates / customers | no | **no** — the API has "add an attachment", nothing to list or download one | **yes** |
| Checklists, the tech's own clock-in / clock-out times | no | no (the job's `work_timestamps` give on-my-way / started / completed for the job as a whole) | maybe |

Probed against Harmon's account 2026-09-25: 9,505 customers · 2,220 jobs · 269 estimates ·
2,074 invoices · 16 employees · 91 tags · 12 job types · 24 lead sources. `/jobs/{id}/notes`
and `/invoices/{id}` are 404s; `/jobs/{id}/line_items`, `/jobs/{id}/appointments`
(`start_date`, `start_time`, `end_time`, `anytime`, `arrival_window_minutes`,
`dispatched_employees_ids` — ids only, names joined from the employee list) and
`/estimates/{id}/options/{opt}/line_items` answer.

### Running the pull

1. **The key** (an HCP admin, in the web app): *My Apps → All Apps → API Key Management →
   Generate API Key* — name it `Sundial migration`, permission **Read-only**. API keys exist
   only on the MAX plan and only admins see the card.
2. **Secrets Manager** → Store a new secret → *Other type* → Plaintext →
   `{ "apiKey": "<the key>" }` → name **`sundial/hcp`**. Never in a file, never in an env var.
3. In `sundial-core`:
   ```powershell
   node scripts/hcp-pull.mjs --probe      # one page of everything + one job's / estimate's / invoice's children
   ```
   The probe prints one line per endpoint — status, count, the field names — and writes
   `migration\hcp\probe-report.json` (keys and counts only, no customer data). This is the
   moment we learn which sub-resources HCP really offers this account; send the printout
   back and the CSV flatteners get adjusted to the real field names before the full run.
4. ```powershell
   node scripts/hcp-pull.mjs              # the full pull; Ctrl-C and run again to resume
   ```
   Roughly 4 requests a second (`--fast` for 10; a 429 slows it down either way). Harmon's
   account is about 5,000 requests ≈ 20–25 minutes. `state.json` remembers each record's
   `updated_at`, so a second run re-walks the lists (fast) and re-reads only the records that
   changed — that IS the cutover delta. `--refresh` re-reads everything; `--only jobs,invoices`
   narrows it.
5. Everything lands in `migration\hcp\` (git-ignored — it is customer data): `raw/` as HCP
   returned it, `csv/` for Excel, `SUMMARY.txt` with the counts and the endpoints that were
   not offered.

A child endpoint that answers 404 / 403 twenty times in a row is marked "not offered" and
skipped for the rest of the run rather than costing 5,000 wasted calls.

### The attachments gap

HCP's public API lets an integration *add* a photo or document to a job; it does not list or
serve the ones already there. Two routes, in order of preference:

1. **Ask HCP support for a bulk attachment export.** Accounts that leave are sometimes given
   their media as a download; the request goes from Ben's admin login. Worth one email while
   the API pull runs.
2. **The signed-in web app.** Everything the HCP web app shows is fetched from HCP's own
   (undocumented) endpoints with the browser's session. A one-time migration script can call
   the same endpoints for each job id from the API pull and download the files into
   `migration\hcp\files\<job_id>\…`. It is written *after* a short reconnaissance with the
   Claude-in-Chrome extension on Ben's session: open one job's photos, read the network
   calls the page makes (URL shape, how the file URLs are served, whether they are signed and
   expiring), then build the script against that. Undocumented endpoints change without
   notice, so the script lives only as long as the migration, and Harmon should be
   comfortable with it (it is their data, on their login, read-only).

### The import into Sundial — `scripts/hcp-import.mjs`

Upsert-only, on `HCP_Id__c`, re-runnable: the go-live delta is "pull again, import again".

**Before the first run (Tim):** deploy `salesforce/hcp-migration-2026-09-25/` (Workbench, Check
Only expect 8/8: `HCP_Id__c` on customer, estimate, service job, service call, service line,
service invoice, service payment + the permission set), run `sql/2026-09-25_hcp_id.sql` in the
Supabase SQL editor, and make sure the seven techs exist as Sundial users (Manage Users,
Technician / Service department) — the dry run's `tech-map.template.csv` shows which HCP
employees matched a user by email, which have a same-name Sundial user (SUGGESTED — the
suggestions are written to `tech-map.suggested.json`; check it, copy it to
`migration\hcp\tech-map.json`), and which have no Sundial user at all (former techs: their
calls carry the name in `Private_Notes__c` and no `Tech__c`, unless you create an inactive
user for them and map it). The map is `{ "<hcp email or employee id>": "<Sundial user email or id>" }`.

```powershell
node scripts/hcp-import.mjs --tenant harmon                # dry run: counts, review.csv, tech-map.template.csv — nothing written
node scripts/hcp-import.mjs --tenant harmon --apply --limit 25    # a trial: the first 25 HCP customers and everything hanging off them
node scripts/hcp-import.mjs --tenant harmon --apply        # the lot (≈ 27,000 rows in batches of 200; 15–20 minutes)
```

Reports land in `migration\hcp\import\`: `SUMMARY.txt`, `review.csv` (every customer match
worth a note; `needs_action = YES` marks the ones a person must decide — an ambiguous match
created new, a lead with no customer — the rest are notes on how a customer was matched),
`errors.csv` (rows Salesforce refused, with its message), `id-map.json`
(HCP id → Sundial id, and whether the import created the customer or linked it — the file that
makes a re-run treat each customer the right way; keep it).

**Matching, first run vs every run.** A customer already carrying `HCP_Id__c` is found by it
alone. Otherwise: exact email (normalised) → link; else normalised street + zip → link, unless
the Sundial record has a *different* email (a new occupant more often than a typo → create +
review); two Sundial hits either way → create + review. Two HCP customers for one household:
both point their jobs at the same Sundial customer, only the first stamps `HCP_Id__c` (review
notes the second). A LINKED customer (prior solar / roofing) only has blank fields filled and
`Customer_Type__c` / `Requested_Project_Types__c` unioned with `Service` — Sales owns that record.
A customer the import CREATED is refreshed from HCP on every run until cutover.

| HCP | Sundial | Notes |
|---|---|---|
| customer | `Sundial_Customer__c` | `Status__c` = Customer when it has a job, else Lead — **no `Service_Stage__c`** (2026-09-29: the first run stamped ~7,400 of them `New` and buried the office's pipeline; `scripts/clear-new-service-stage.mjs` cleared it, the office sets the stage by hand); `Lead_Source__c` only when HCP's value is a picklist value; `notes` → `Description__c` |
| lead | the customer's hub record | `Service_Stage__c` Estimate Created (converted) / Closed (`lost_at`, resolution Not Interested) — an open lead gets **no stage** (2026-09-29); `Description__c` gets `HCP lead #… · pipeline status`, tags, job fields; `Assigned_To__c` by the tech map; a stage the office already set is never overwritten |
| estimate (not claimed by a job) | `Sundial_Estimate__c` + `Sundial_Service_Line__c` per line of the approved option, else option 1 (other options in `Version_Log__c`) | Approved / Declined / Sent; `Tax_Amount__c` = option total − lines |
| job | `Sundial_Service_Job__c` + its one estimate (the claimed HCP estimate via `original_estimate_id`, else `job:{id}:estimate`) + lines from the job's line items (else the invoice's items) | status: canceled → Closed/Cancelled; complete → Paid / Invoiced / Closed ($0) / Ready to Bill; scheduled → Scheduled; in progress → In Progress; unscheduled → Ready to Schedule. `Office_Notes__c` starts `Migrated from Housecall Pro — HCP job #1042` + tags + lead source + the job's notes field |
| appointment | `Sundial_Service_Call__c`, one per tech (`{appointment}:{employee}` when several) | Arizona times (fixed −07:00); Complete calls get `Actual_*` from the job's clock (single appointment) else the window; a tech without a Sundial user is named in `Private_Notes__c` |
| invoice | `Sundial_Service_Invoice__c`, `Name` = the HCP invoice number | Paid / Partially Paid / Sent / Issued / Draft / Void; tax, discount, paid, balance from the list record |
| payment / refund | `Sundial_Service_Payment__c` | Payment / Refund, method Card / Check / ACH / Other, Succeeded |

Not carried: HCP's notes feed and photos (the web-app route), `job_fields` beyond the lead's
description, the service-plan memberships (D-073 rows are born from Sundial's own join).
`settleMoney()` is not involved — the import writes the settled fields directly, once, from
HCP's own paid / due numbers.

**Clearing a stage the import should not have set** (2026-09-29): `node scripts/clear-new-service-stage.mjs --tenant harmon` lists every customer of the tenant at `Service_Stage__c = New` and writes `migration/service-stage-new-harmon.csv` (`Id, Service_Stage__c` blank — DataLoader *Update* with "Insert null values" ticked); `--apply` blanks them through the API instead, canary first, then batches of 200 by `Id`. Only the value `New`, only that tenant, idempotent. Then a full `customer` cache resync. (`POST /service/customers` — the office's own New Customer / Add to Service — still opens a customer at `New`: that one is deliberate.)

**After an apply (Tim):** a FULL cache resync for `customer`, `estimate`, `service_line`,
`service_job`, `service_call`, `service_invoice`, `service_payment` (the cache-sync Lambda,
`{ "object": "…", "mode": "full" }`), then open a migrated job in the portal.

## Sunbase → Sundial Sales (Phase 1 / Phase 3 commercial)

Not yet written here.

## Dropbox → S3 (Phase 1)

Not yet written here — see `docs/file-storage.md` for the target tree.
