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
`stale-jobs.csv` and `picklist-gaps.csv` (see *What is active*),
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
| customer | `Sundial_Customer__c` | `Status__c` = Customer when it has a job, else Lead; no stage of its own (the lead sets it — see below; a `New` left by the first run is cleared on a refresh when HCP has no open lead); **`Archived__c`** from the rules under *What is active* (created / refreshed customers only — a linked Sales record is never archived), the reason as the trailing line of `Description__c` (`Archived by the HCP import: …`); `Lead_Source__c` only when HCP's value is a picklist value; `notes` → `Description__c` |
| lead | the customer's hub record | **open** → the stage HCP's `pipeline_status` means (New Lead / Unassigned / Assigned → New; First / Second / Third Contact → Contact Attempt Made with `Call_Attempts__c` 1 / 2 / 3; Working On – Waiting on Customer → Waiting on Customer; Working On – Waiting on Service/Quote → In Progress; On Hold → **On Hold** once the org has it, Waiting on Customer until then), `Service_Request_Type__c` from the lead's HCP job type when the org has that value; **won** → Resolved · Job Created / Estimate Created, resolved on the day the job / estimate was made; **lost** → Closed · **Lost** (Not Interested until the org has it), resolved on `lost_at`. `Description__c` gets `HCP lead #… · pipeline status`, tags, job type; `Assigned_To__c` by the tech map. A stage Sales set on a LINKED customer is never overwritten; a customer the import created takes HCP's state on every run |
| estimate | `Sundial_Estimate__c` + `Sundial_Service_Line__c` per line of the approved option, else option 1 (other options in `Version_Log__c`) | Approved / Declined / Expired / Sent; `Tax_Amount__c` = option total − lines; `Archived__c` per *What is active*. An estimate a job came from (matched on the **option** id — a job's `original_estimate_id` is `est_…`, the estimate's own id `csr_…`; 0 of 77 matched by estimate id before 2026-10-02) is its own record, archived "converted to HCP job #…" — never the job's estimate |
| job | `Sundial_Service_Job__c` + its one estimate (`job:{id}:estimate`, always made for the job) + lines from the job's line items (else the invoice's items) | status: canceled → Closed/Cancelled; complete → Paid / Invoiced / Closed ($0) / Ready to Bill; scheduled → Scheduled; in progress → In Progress; unscheduled → Ready to Schedule. `Archived__c` per *What is active* (the job's estimate follows it). `Office_Notes__c` starts `Migrated from Housecall Pro — HCP job #1042` + tags + lead source + `Archived by the HCP import: <reason>` when archived + the job's notes field |
| appointment | `Sundial_Service_Call__c`, one per tech (`{appointment}:{employee}` when several) | Arizona times (fixed −07:00); Complete calls get `Actual_*` from the job's clock (single appointment) else the window; a tech without a Sundial user is named in `Private_Notes__c` |
| invoice | `Sundial_Service_Invoice__c`, `Name` = the HCP invoice number | Paid / Partially Paid / Sent / Issued / Draft / Void; tax, discount, paid, balance from the list record |
| payment / refund | `Sundial_Service_Payment__c` | Payment / Refund, method Card / Check / ACH / Other, Succeeded |

Not carried: HCP's notes feed and photos (the web-app route), `job_fields` beyond the lead's
description, the service-plan memberships (D-073 rows are born from Sundial's own join).
`settleMoney()` is not involved — the import writes the settled fields directly, once, from
HCP's own paid / due numbers.

### What is active (2026-10-02)

Harmon's feedback after the first import: ~9,500 customers in the Service list, a board
full of "New", and the real work buried. HCP has no archived flag on its API; it has signals,
and `lib/hcp-disposition.js` turns them into `Archived__c` (a plain checkbox, added in Setup on
`Sundial_Customer__c`, `Sundial_Estimate__c`, `Sundial_Service_Job__c`; `sql/2026-10-02_archived.sql`
gives the cache its `archived` column; the import refuses to run until the three fields exist).
Every Service list and board hides archived rows until **Show archived** is ticked; search never
hides them; **Archive / Unarchive** sits on the customer, job and estimate pages; a popup that
reuses an archived customer (New Estimate / New Job / Add to Service) un-archives it. The
cutoff for "abandoned" is `--stale-days` (default **90**).

| | archived when | stays visible |
|---|---|---|
| job | cancelled in HCP (`deleted_at` = HCP's own archive); complete and paid, or $0; complete + unpaid **and tagged `invoiced …`** (Harmon's "handed to Acumatica" tag); **stale**: `scheduled` with a start more than 90 days back and never started, or `needs scheduling` untouched for 90 days | in progress; scheduled ahead; needs scheduling touched this season; complete + unpaid + **untagged** (shown as Invoiced so the office can check it was billed) |
| estimate | converted to a job; cancelled / declined / expired; untouched for 90 days | a live quote |
| customer | **every customer with no job in HCP** — the import's `Status__c` rule makes those Leads, and Harmon opens Sundial with a clean Lead / Opportunity pipeline (the 11th-hour ask, 2026-10-02): open HCP lead or not, live estimate or not (the estimate stays on its own list). Its stage is still written, for Show archived. `--keep-leads` restores the older rule (archive only when nothing is open and nothing happened in 90 days). A customer **with** jobs: archived when nothing is open (no open HCP lead, no live job, no live estimate) **and** no activity across the household for 90 days | a customer with a live job, or a job in the past plus an open lead / live estimate, or anyone with jobs touched this season |

The reason is written next to the flag: jobs in `Office_Notes__c` (its own line, before the
job's HCP notes — the job page shows the field under Initial remote diagnosis), standalone
estimates in `Internal_Notes__c` (the estimate page shows it under Scope summary), customers as
the trailing line of `Description__c`; the job's own estimate carries the flag only. Stale jobs
keep their HCP status (Scheduled / Ready to Schedule) — only the flag and the
`Office_Notes__c` line say abandoned — and are listed in `migration\hcp\import\stale-jobs.csv`
for Monday's review; Unarchive on the job page brings one back. `picklist-gaps.csv` lists
every HCP value the org's picklists lack (an `On Hold` stage, a `Lost` resolution, lead
sources, the lead's job types as request types) with counts: add them in Setup, re-run, and
the exact value lands instead of the nearest one. On the 2026-09-26 pull with the 90-day
cutoff: **209 of 2,222 jobs**, **64 of 272 estimates** and **~340 of 9,600 customers** stay
visible — every one of them a Customer with a job; zero Leads (52 jobs listed as abandoned,
76 estimates archived as converted). Sales's own Leads / Opportunities that HCP also knows
(linked records) are never archived by the import; the dry run counts them
(`customers:linked-lead-or-opportunity-left-alone`) for Tim to archive by hand if wanted.

A re-run re-stamps `Archived__c` from HCP's state on every HCP-origin record (it is HCP's
view until cutover); an archive the office sets by hand on a Sundial-born record is never
touched, and a linked Sales customer never is either.

**Clearing a stage the import should not have set** (2026-09-29): `node scripts/clear-new-service-stage.mjs --tenant harmon` lists every customer of the tenant at `Service_Stage__c = New` and writes `migration/service-stage-new-harmon.csv` (`Id, Service_Stage__c` blank — DataLoader *Update* with "Insert null values" ticked); `--apply` blanks them through the API instead, canary first, then batches of 200 by `Id`. Only the value `New`, only that tenant, idempotent. Then a full `customer` cache resync. (`POST /service/customers` — the office's own New Customer / Add to Service — still opens a customer at `New`: that one is deliberate.)

**After an apply (Tim):** a FULL cache resync for `customer`, `estimate`, `service_line`,
`service_job`, `service_call`, `service_invoice`, `service_payment` (the cache-sync Lambda,
`{ "object": "…", "mode": "full" }`), then open a migrated job in the portal.

## Sunbase → Sundial Sales (Phase 1 / Phase 3 commercial)

Not yet written here.

## Dropbox → S3 (Phase 1)

Not yet written here — see `docs/file-storage.md` for the target tree.
