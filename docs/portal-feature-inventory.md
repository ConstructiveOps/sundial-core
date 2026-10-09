# Sundial — Portal Feature Inventory

> **The manifest of what the Sundial portal platform includes.** A new client's portal is a
> fork of `harmon-crm` (D-025; harmon-crm is the template). This file is what that fork is
> checked against: every row below is either **present and working** in the fork, or
> **listed in the fork's `CLIENT_DIVERGENCE.md`** as deliberately removed or changed. A row
> that is neither is a missing improvement.
>
> **Standing rule (CLAUDE.md → Documentation Requirements):** any PROGRESS entry — here or in
> harmon-crm — that adds a platform-level portal feature adds its row here in the same change.
>
> Built 2026-10-09 from harmon-crm's git log and PROGRESS.md, 2026-09-10 (`7dcab07`, the
> Service module's first screens) through 2026-10-07 (`a9abd1e`). Everything before that is
> summarised at feature-area grain in [Baseline](#baseline--before-2026-09-10). How to stand
> a client up: `docs/multi-client-deployment.md` → *Spinning Up a New Client*.

---

## How to read a row

| Column | Meaning |
|---|---|
| **Feature** | What a person can do, in the words they'd use. |
| **Since** | harmon-crm commit and date. A fork copied before that commit does not have it. |
| **harmon-crm files** | The main files under `src/` (tests omitted; `svc/` = `src/components/service/`, `pages/` = `src/pages/`, `tech/` = `src/tech/`). |
| **sundial-core dependency** | What must be live on the shared backend. Route → Lambda, SQL file, Secrets Manager block, EventBridge rule, S3 CORS — or *client-side only*. |
| **Kind** | **Platform** — the same for every client, nothing to change. **Config** — differs per client through `client-config.ts`, a `sundial/*` secret block, a `Sundial_Tenant__c` / `Sundial_User__c` field or an org picklist, no code edit. **Code** — Harmon's choice is written into a component; a new client edits code and records it in `CLIENT_DIVERGENCE.md`. |
| **New-client step** | What must be repeated for a new tenant. `—` = nothing: the backend is shared and already serves every tenant (D-078), and the code arrives with the fork. Codes in CAPITALS are defined just below. |

### New-client step codes

Each code is one line of the checklist in `docs/multi-client-deployment.md`.

| Code | What it means for the new tenant |
|---|---|
| **ORIGIN** | The portal's origin is (1) in the API CORS allowlist — six files, `lib/http.js` + five inline copies, `lib/http.test.js` pins them — and every Lambda that bundles them redeployed; (2) in Supabase Auth → URL Configuration (redirect allowlist); (3) allowed by the `sfsolproj` **bucket's own CORS** for `GET`, `PUT`, `HEAD` (today `AllowedOrigins: ["*"]`, so nothing to do — but if that is ever narrowed, every browser upload, download, zip and photo view breaks for an origin not on it). |
| **BRAND** | A block keyed by the tenant slug in Secrets Manager `sundial/brand`. Keys named in the row. `companyName` + `portalUrl` are the minimum for anything customer-facing (D-078). |
| **BRAND-ASSETS** | Logo / mark PNGs in `src/assets/branding/` and the 14 sites that import them (`AppLayout`, `LoginPage`, `ResetPasswordPage`, `ComingSoonPage`, `DashboardPage`, `SalesPage`, `SolarProjectsPage`, `RoofingProjectsPage`, `settings/UsersPage`, `service/ServiceListShell`, `PublicEstimatePage`, `PublicReportPage`, `club/ClubPublicPages`), `index.html` title, `public/icons/*`. Code today; `conops-demo` shows the `Brand.tsx` pattern that makes it one file. |
| **TWILIO** | `sundial/twilio.tenantNumbers[slug]` = a Twilio number on the Constructive Ops account, with that number's Messaging webhooks pointed at `POST /sms/inbound` and `/sms/status` (`docs/integrations/sms-twilio.md`). Without it: "Texting isn't set up". The shared line is the primary tenant's. |
| **STRIPE** | `sundial/stripe.tenants[slug]` (secret key + webhook signing secret) and a webhook endpoint in that Stripe account at `POST /webhooks/stripe/{slug}` (`docs/integrations/stripe.md`). Without it the money buttons say Stripe is not set up. |
| **CLUB** | `sundial/service-club.tenants[slug]` (SolarFax credentials, team email), `Sundial_Service_Plan__c` rows, then `node scripts/seed-service-club.mjs` to mint the Stripe Products / Prices (`docs/integrations/service-club.md`). Needs STRIPE. |
| **PUSH** | Nothing per tenant: one VAPID pair (`sundial/push`) serves every portal. The fork must serve `public/sw.js` at its own root. |
| **GMAPS-B** | The browser Maps JavaScript key (`VITE_GOOGLE_MAPS_BROWSER_KEY` in Vercel) must allow the new origin in its HTTP-referrer restriction, or use a new key. Without it the dispatch map is a list with Maps links. The server key (`sundial/google-maps`) is shared and needs nothing. |
| **TENANT-ROW** | Fields on the tenant's `Sundial_Tenant__c` record: `Default_Tax_Rate__c`, `Default_Tax_Jurisdiction__c`, `Labor_Burden_Percent__c`. |
| **USERS** | Per-person fields set in Manage Users: `Dispatch_Board__c` + `Dispatch_Order__c`, `Hourly_Bill_Rate__c`, `Hourly_Cost_Rate__c`, Access level (Technician → the tech app), default department. |
| **PICKLIST** | The values come from the org's picklist, which is **org-wide** (shared with every tenant). A client that needs different values either shares the list or adds a client-side override (`conops-demo`'s `picklist-overrides.ts`) and records it in `CLIENT_DIVERGENCE.md`. |
| **PRIMARY-ONLY** | A single-credential integration that serves the primary tenant only (D-078). Another tenant gets `403 INTEGRATION_NOT_ENABLED` unless its slug is in that Lambda's `SUNDIAL_<NAME>_TENANTS`; a fork that will never have it removes the UI (as `conops-demo` did). |

---

## 1. Service module — office screens

| # | Feature | Since | harmon-crm files | sundial-core dependency | Kind | New-client step |
|---|---|---|---|---|---|---|
| S1 | Service nav + Jobs list, Estimates list (with Templates filter / New Template), Price Book page | `7dcab07` 09-10 | `pages/service/ServiceJobsPage.tsx`, `ServiceEstimatesPage.tsx`, `PriceBookPage.tsx`, `ServiceListShell.tsx`, `config/nav.ts`, `lib/service-api.ts` | `GET /sf/{job,estimate,pricebookitem}` → `sundial-sf-query` (cache tables `sql/sundial_service_job_cache.sql`, `sundial_estimate_cache.sql`, `sundial_price_book_item_cache.sql`); `/service/*` → `sundial-service-estimate` (`wire-service-estimate-routes.ps1`) | Platform | Load the tenant's price book (`salesforce/pricebook-import/`, `Client__c` on every item) |
| S2 | New Estimate / New Job popup: customer select-or-create, soft duplicate guard ("Create anyway"), template seeds lines, quick-create makes estimate + job | `7dcab07` 09-10 | `svc/NewServiceModal.tsx`, `CustomerPicker.tsx`, `ModalShell.tsx` | `POST /service/estimates`, `POST /service/jobs` → `sundial-service-estimate` | Platform | — |
| S3 | Estimate editor: lines editable in place, kind select, remove, price-book typeahead, ad-hoc lines, add template; discount scope/type/value, hidden markup, tax rate + jurisdiction, deposit; server totals | `7dcab07` 09-10 | `pages/service/EstimateDetailPage.tsx`, `svc/PriceBookSearch.tsx` | `GET/PATCH /service/estimates/{id}`, `/lines` routes → `sundial-service-estimate`; `lib/http.js` must list `PATCH` | Platform | — |
| S4 | Preview the document read-only (sandboxed iframe) with Send beside Close; Send / Mark approved / Declined / Create job | `7dcab07` 09-10 | `svc/PreviewModal.tsx`, `EstimateDetailPage.tsx` | `GET /service/estimates/{id}/preview`, `POST …/{send,approve,decline,create-job}`; SES (`EMAIL_FROM` etc. on `sundial-service-estimate`) | Platform | BRAND (`companyName`, `publicUrl`/`portalUrl`; primary tenant: `SERVICE_PUBLIC_BASE_URL`) |
| S5 | Activity feed on job and estimate (old → new in plain words), collapsed by default | `7dcab07` 09-10 | `svc/ActivityFeed.tsx` | `GET /service/{jobs,estimates}/{id}/activity`; `sql/sundial_service_activity.sql` | Platform | — |
| S6 | Job page: status + facts edited through the generic record PATCH, estimate card with Open / Preview | `7dcab07` 09-10 | `pages/service/ServiceJobDetailPage.tsx` | `PATCH /sf/job/{id}` → `sundial-sf-update` | Platform | — |
| S7 | Send delivery feedback ("emailed to …" vs "recorded, no email — why"); **Copy customer link** | `f1c9887` 09-11 | `EstimateDetailPage.tsx`, `lib/service-api.ts` | `POST /service/estimates/{id}/send` | Platform | BRAND (`publicUrl`) |
| S8 | Files panels on the estimate and job pages ("Estimate documents" on the job); every Send drops `estimate-v{n}.pdf` | `4ff173a` 09-11 | `EstimateDetailPage.tsx`, `ServiceJobDetailPage.tsx` (shared `components/files/FilesPanel.tsx`) | `/files/by-record/*` → `sundial-list-files`, `sundial-upload-file`, `sundial-delete-file`; `sql` `sundial_file_metadata` (snapshot); S3 `sfsolproj/SUNDIAL/{id}/` | Platform | ORIGIN (bucket CORS) |
| S9 | Create a price-book item from the picker or from an ad-hoc line ("Save to price book" links the line) | `bec294c` 09-11 | `svc/PriceBookItemModal.tsx`, `PriceBookSearch.tsx` | `POST /service/price-book-items`, `PATCH …/lines/{lineId}` | Platform | — |
| S10 | Invoice card: Issue (due-in-days), Send invoice / Send receipt, Record payment, Void with reason, Issue again, history | `bed52d4` 09-11 | `svc/JobInvoiceCard.tsx`, `PaymentModal.tsx` | `GET /service/jobs/{id}/invoice`, invoice routes in `invoice.js` (`sundial-service-estimate`); `sql/sundial_service_invoice_cache.sql`, `sundial_service_payment_cache.sql` | Platform | BRAND (`paymentTerms`, `companyName`) |
| S11 | Invoices tab: Open by default, every status, search by number / partner ref | `bed52d4` 09-11 | `pages/service/ServiceInvoicesPage.tsx` | `GET /sf/serviceinvoice` → `sundial-sf-query` | Platform | — |
| S11a | Invoices tab **Not in Acumatica** filter + column (bridge-period digest) | `bed52d4` 09-11 | `ServiceInvoicesPage.tsx` | `acumatica_entered_at` cache column | **Code** (Harmon's Acumatica) | Remove if the client has no Acumatica (`conops-demo` did) |
| S12 | Street View of the house on the job page (fetched once server-side, refreshed when the address changes) | `bed52d4` 09-11, `5e3363a` 09-18 | `svc/StreetViewCard.tsx` | `GET /service/jobs/{id}/street-view`; `sundial/google-maps` (shared server key); S3 `SUNDIAL/{jobId}/street-view.jpg` | Platform | — |
| S13 | Communications panel on the job: team notes with @-mentions + customer texts both ways + key events, one timeline; "Note to team / Text customer" toggle | `91f1c62` 09-15 | `svc/CommunicationsPanel.tsx`, `communicationsFeed.ts`, `components/comments/{comments-data.ts,useMentionComposer.ts,MentionUi.tsx}` | `GET/POST /service/jobs/{id}/sms` → `sundial-sms` (`wire-sms-routes.ps1`); `sql/sundial_sms_messages.sql`; Supabase `comments`; Realtime `tenant:{id}:sundial_service_job:{jobId}` | Platform | TWILIO |
| S14 | Labor billing card: per-call Bill tick, hours + rate, apply to all, save as the tech's default, one Save | `91f1c62` 09-15 | `svc/JobLaborCard.tsx` | `labor.js` in `sundial-service-estimate` | Platform | USERS (`Hourly_Bill_Rate__c`) |
| S15 | Schedule later: a call created `Unscheduled`, listed on the job and as a dashed tray card | `91f1c62` 09-15 | `svc/CallModals.tsx`, `JobCallsCard.tsx`, `pages/service/DispatchBoardPage.tsx` | `POST /service/jobs/{id}/calls`, `PATCH /service/calls/{id}` → `sundial-service-board` | Platform | — |
| S16 | Price-book filters (Job Type / Service Type / Category) and the item popup's selects | `91f1c62` 09-15 | `PriceBookPage.tsx`, `PriceBookItemModal.tsx` | `GET /sf/pricebookitem` | Platform | PICKLIST (Category is unrestricted) |
| S17 | Summary of work on the job (`Customer_Summary__c`, printed on the invoice) | `91f1c62` 09-15 | `ServiceJobDetailPage.tsx` | `PATCH /sf/job/{id}` | Platform | — |
| S18 | **Fix time**: the office corrects a tech's clock (edit / remove / add interval, reason, mark Complete, history) with GPS links per tap | `f1d0158` 09-17, `ac68809` 09-17 | `svc/ClockCorrectionPanel.tsx`, `CallModals.tsx` | `GET/POST /service/calls/{id}/clock` → `sundial-service-board` | Platform | — |
| S19 | Service address editable inline on job and estimate (re-geocodes, re-fetches Street View) | `ac68809` 09-17 | `ServiceJobDetailPage.tsx` (`AddressText`), `EstimateDetailPage.tsx` | `PATCH /sf/job/{id}`, `PATCH /service/estimates/{id}` (`address`) | Platform | — |
| S20 | "Service Jobs (n)" on the customer's related-records bar; empty groups hidden | `ac68809` 09-17 | `config/related-records.ts`, `components/detail/RelatedRecordsBar.tsx` | `GET /sf/job?parent…` | Platform | — |
| S21 | Job Photos card: every visit's photos grouped by call, Add photos (presign → S3 PUT → confirm) | `ac68809` 09-17 | `svc/JobPhotosCard.tsx` | `GET/POST /service/jobs/{id}/photos[/confirm]` → `sundial-service-board`; S3 `SUNDIAL/{jobId}/photos/` | Platform | ORIGIN (bucket CORS: `PUT`) |
| S22 | Clock strip per call on the job: On the way → Arrived → Clocked out, map pin per tap, distance from the house, geofence tag | `a650b05` 09-18 | `svc/CallClockStrip.tsx`, `geo.ts`, `JobCallsCard.tsx` | `GET /service/jobs/{id}/calls` | Platform | — (geofence: `SERVICE_SHOP_LATLNG`, `SERVICE_GEOFENCE_METERS` are **one value per Lambda** — see the checklist) |
| S23 | Job notes fields: Notes for summary, Notes from service calls (filled per completed call) | `a650b05` 09-18 | `ServiceJobDetailPage.tsx` | `job-notes.js` in `sundial-service-board`; `sql/2026-09-19_customer_type_job_notes.sql` | Platform | — |
| S24 | Job report + receipt: card, section builder (photo + caption, text-only), Preview, Send / Send again (email, email + text, text only) | `80a232f` 09-21 | `svc/JobReportCard.tsx`, `JobReportModal.tsx`, `PreviewModal.tsx` | `GET/PUT /service/jobs/{id}/report`, `…/report/preview`, `…/report/send` (`report.js`) | Platform | BRAND (`companyName`, `logoUrl`, `publicUrl`); TWILIO for the text |
| S25 | Jobs list **Report** column ("Not sent" / sent date / nothing for a partner payer) | `f1b110b` 09-22 | `svc/reportMarker.ts`, `ServiceJobsPage.tsx` | `GET /sf/job` | Platform | — |
| S26 | Address lookup (Google suggestions) on New Customer in the Service popups — key stays server-side | `5c4e091` 09-22 | `svc/AddressLookup.tsx`, `lib/address-api.ts` | `GET /service/address/suggest`, `/service/address/place/{placeId}` (`wire-address-lookup-routes.ps1`); `sundial/google-maps` (Places API (New)) | Platform | — (`bias` in `sundial/google-maps` is one value for all tenants) |
| S27 | **Service → Customers** (D-075): table or board by `Service_Stage__c`, Open requests / by follow-up, assignee / status / request-type filters; customer page with the Service subset; Create Estimate / Job pre-picked; Add to Service; New Customer | `a2e83d2` 09-23 | `pages/service/ServiceCustomersPage.tsx`, `ServiceCustomerDetailPage.tsx`, `svc/NewServiceCustomerModal.tsx`, `config/service-customer-config.ts`, `lib/service-customers.ts` | `GET /sf/customer?…&op=includes`, `POST /service/customers` (`wire-service-customers-route.ps1`); `sql/2026-09-23_service_customer.sql`; SF package `service-customer-2026-09-23` | Platform | PICKLIST (`Service_Stage__c`, `Service_Request_Type__c`) |
| S28 | Price-book results list rendered through a portal (never clipped by the Lines card) | `3cdb035` 09-24 | `svc/PriceBookSearch.tsx` | client-side only | Platform | — |
| S29 | **Sortable columns + List / Board** on Jobs, Estimates, Invoices; the view remembered per screen; Service → Customers sorts every column (Assigned to by name) | `9f57488` 09-28, `3282e22` 09-28 | `svc/ListView.tsx`, `listViewState.ts` (`useSortedRows`, `SortableHead`, `ViewToggle`, `StatusBoard`), the three list pages | client-side only (sorts the loaded rows) | Platform | — |
| S30 | **Payroll** (Admin / Executive): Mon–Sun, hours by job, Time Outside Calls, day strip + flags, CSV | `9f57488` 09-28 | `pages/service/PayrollPage.tsx`, `payroll.ts` | `GET /service/payroll?week=` (`day.js`, `wire-tech-day-routes.ps1`); action `service.payroll.read`; SF package `tech-day-2026-09-28` | Platform | — |
| S31 | **Card on file** on the job: card as Stripe knows it, Enter card (Stripe page, new tab), Text / Email link, **Charge card** (Admin / Executive, any amount up to what is owed) | `3282e22` 09-28 | `svc/JobCardOnFileCard.tsx`, `JobInvoiceCard.tsx` | `GET /service/jobs/{id}/card`, `POST …/card-session`, `…/card-link`, `…/charge` (`stripe.js`); action `service.card.charge` | Platform | STRIPE; BRAND (`publicUrl` — else `PORTAL_URL_NOT_CONFIGURED`) |
| S32 | Delete a photo on the desktop job page (hover trash, confirm over the page) | `7647e2e` 09-29, `a9abd1e` 10-07 | `JobPhotosCard.tsx`, `components/photos/DeletePhotoConfirm.tsx` | `DELETE /service/jobs/{id}/photos` | Platform | — |
| S33 | Service tabs on the job, estimate and customer detail pages | `7647e2e` 09-29 | `ServiceListShell.tsx` (`ServiceTabs`) | client-side only | Platform | — |
| S34 | **Edit anyway** on an invoiced estimate (warning, a PDF of the live invoice kept in Files) | `5a17839` 09-30 | `EstimateDetailPage.tsx` | `POST /service/estimates/{id}/unlock` | Platform | — |
| S35 | Invoice card **Download PDF** (a real file save) | `5a17839` 09-30 | `JobInvoiceCard.tsx` | invoice PDF in S3 via the invoice read | Platform | ORIGIN (bucket CORS) |
| S36 | Invoices → **Export week (CSV)** | `d932d21` 10-01 | `pages/service/invoiceExport.ts`, `ServiceInvoicesPage.tsx` | `GET /service/invoices/report?from=&to=` → `sundial-service-estimate` | Platform | — |
| S37 | **Archived records** (D-072, 2026-10-02): every Service list / board hides archived until **Show archived** (with count); archived chip; Archive / Unarchive on customer, job, estimate; search never hides them | `9c533ed` 10-02 | `svc/ListView.tsx` (`ArchivedToggle`, `ArchivedChip`, `ArchiveButton`), the list + detail pages | `Archived__c` (Setup field, org-wide); `sql/2026-10-02_archived.sql` (cache column `archived`) | Platform | — |
| S38 | A blank `Service_Stage__c` is not an open request; **No stage** is its own filter / column | `9c533ed` 10-02 | `lib/service-customers.ts` (`isOpenStage`), `ServiceCustomersPage.tsx` | — | Platform | — |
| S39 | Office notes (job) and Internal notes (estimate), never printed | `9c533ed` 10-02 | `ServiceJobDetailPage.tsx`, `EstimateDetailPage.tsx` | `PATCH /sf/{job,estimate}/{id}` | Platform | — |
| S40 | **Intake**: popups open on *Existing customer*; eight intake questions under the customer block; the customer page's **Intake** tab | `9c533ed` 10-02 | `svc/IntakeSection.tsx`, `intake.ts`, `config/service-customer-config.ts` (`INTAKE_FIELDS`) | `intake` on `POST /service/{customers,estimates,jobs}`; `lib/service-intake-alerts.js` | **Code** — the eight questions and the label "Did Harmon install this system?" are Harmon's | Edit `INTAKE_FIELDS`; PICKLIST for each picklist |
| S41 | **Issue invoice** from the estimate header (creates the job first when there is none) | `ddc32b8` 10-05 | `EstimateDetailPage.tsx` | `POST …/create-job`, invoice issue route | Platform | — |
| S42 | Taxable / not taxable toggle per line; new estimates take the tenant's default rate + jurisdiction | `ddc32b8` 10-05 | `EstimateDetailPage.tsx` | `PATCH …/lines/{lineId}` (`taxable`); `tenantSettings()` | **Config** | TENANT-ROW (`Default_Tax_Rate__c`, `Default_Tax_Jurisdiction__c`) |
| S43 | Line source labels (Price book / Billed time / Migrated from HCP / From template / Added by the tech / Service Club / Ad hoc) | `ddc32b8` 10-05 | `EstimateDetailPage.tsx` (`lineSourceLabel`) | `Source__c` on the line | Platform | — |
| S44 | **Job costing** card (Admin / Executive): revenue, material / price-book labor / tech labor at burdened cost, margin; "bill at cost" on the Labor card; **Tech rates** on Payroll | `ddc32b8` 10-05 | `svc/JobCostingCard.tsx`, `TechRatesCard.tsx`, `JobLaborCard.tsx`, `PayrollPage.tsx` | `labor.js` `jobCosting()`; actions `service.costing.read/write` | **Config** | TENANT-ROW (`Labor_Burden_Percent__c`); USERS (`Hourly_Cost_Rate__c`) |
| S45 | **Company customers + Bill To** (D-081): Bill To customer picker (search finds companies), plain **New company…**, company toggle on the customer, Companies filter, `CompanyChip`, one display-name rule everywhere, warranty notes highlight + intake question | `9a730d7` 10-07 | `svc/BillToPicker.tsx`, `NewCompanyModal.tsx`, `customer-pick.ts`, `WarrantyHighlight.tsx`, `components/customers/CompanyChip.tsx`, `lib/customer-name.ts`, `components/sales/NewCustomerModal.tsx` | `lib/bill-to.js` on `sundial-service-estimate` + `sundial-sf-update`; `sql/2026-10-07_company_customers.sql` (`display_name_sort`); Setup fields `Is_Company__c`, `Company_Name__c`, `Warranty_Notes__c`, `Bill_To_Customer__c` (job + invoice), `Bill_To_Address__c`; `lib/customer-name.fixtures.json` (TS copy must match) | Platform | — (Harmon-only: the `backfill-bill-to-customers.mjs` run over imported jobs) |
| S46 | Job header phone and email inline-editable | `bf70bf4` 10-06 | `ServiceJobDetailPage.tsx` | `PATCH /sf/job/{id}` (`Primary_Phone/Email_at_Creation__c`); Tim's Flow mirrors to the estimate | Platform | Org Flow is shared — nothing |
| S47 | List search shows **every status** while a term is typed, "N matches — every status, archived included" / 200-row cap notice | `708e4b7` 10-06 | `ServiceListShell.tsx`, `ServiceJobsPage.tsx`, `ServiceEstimatesPage.tsx` | `sundial-sf-query` `searchOrExpr` (AND of words + phone digits) | Platform | — |
| S48 | Customer picker on every Service popup: up to 50 matches with the server's count ("Showing 50 of 73 — add a word"), full address + ZIP, both phones, email, tags, "archived" | `708e4b7` 10-06 | `svc/CustomerPicker.tsx` | `GET /sf/customer?q=` count | Platform | — (default state `AZ` in `CustomerPicker.tsx` / `NewCompanyModal.tsx` is **Code**) |

## 2. Dispatch board and events

| # | Feature | Since | harmon-crm files | sundial-core dependency | Kind | New-client step |
|---|---|---|---|---|---|---|
| D1 | Dispatch board, Day view: tech columns, 30-min slots 6a–7p, blocks by status, tray (emergencies first), drag tray → Schedule, drag block → move with modstamp (409 → toast + refetch), call dialog (progress, notes, reschedule, cancel, add a tech) | `7d875a2` 09-11 | `pages/service/DispatchBoardPage.tsx`, `svc/CallModals.tsx`, `callTime.ts`, `JobCallsCard.tsx` | `GET /service/board`, call routes → `sundial-service-board` (`wire-service-board-routes.ps1`); Realtime `tenant:{id}:sundial_service:list` | Platform | USERS (`Dispatch_Board__c` / order; else Technician / Service department); board hours 6a–7p are **Code** |
| D2 | Week (default) and Month views; drop on any view; view remembered per browser | `bec294c` 09-11 | `svc/BoardViews.tsx`, `boardDates.ts` | `GET /service/board` (42-day window cap) | Platform | — |
| D3 | Taller week rows with two-line chips | `bed52d4` 09-11 | `BoardViews.tsx` | client-side only | Platform | — |
| D4 | Invoice-status **border** on call cards (red / amber / green); **hover card** (customer, job · call, Job status, invoice, time + tech, address, phone, issue) | `3e2c2a8` 09-23 | `svc/callCardInfo.ts`, `CallHoverCard.tsx` | `GET /service/board` (`issueDescription`, `paymentStatus`, `invoiceStatus`) | Platform | — |
| D5 | **Dispatch map** of each tech's last clocked spot (solid on the clock, faded off), refreshed each minute | `9f57488` 09-28 | `svc/TechMap.tsx`, `techMapText.ts`, `lib/google-maps.ts` | `GET /service/techs/locations` (`day.js`) | Platform | GMAPS-B (default centre Phoenix is **Code**, re-centred by the pins) |
| D6 | Drag a call onto the Unscheduled tray, or **Remove from schedule** | `4d9498a` 09-29 | `DispatchBoardPage.tsx`, `CallModals.tsx` | `POST /service/calls/{id}/unschedule` | Platform | — |
| D7 | Overlapping calls side by side (day) / one row (week) | `7647e2e` 09-29 | `BoardViews.tsx`, `tech/scheduleLayout.ts` (`layoutDay`) | client-side only | Platform | — |
| D8 | Call card shows the **job's** status; progress buttons kept after Complete (Re-open, Back to Scheduled) | `5a17839` 09-30 | `CallModals.tsx`, `CallHoverCard.tsx` | `PATCH /service/calls/{id}` | Platform | — |
| D9 | **New event** (name, details, window, attending techs; Through date + Weekdays / Every day / Weekly → one block per tech per day); event blocks, card, hover card; cancelled calls off the board | `d932d21` 10-01, `ddc32b8` 10-05 | `CallModals.tsx` (`EventModal`), `BoardViews.tsx`, `CallHoverCard.tsx`, `DispatchBoardPage.tsx` | `POST /service/events` (`events.js`, `untilDate` + `repeat`); SF package `service-events-2026-10-01`; `sql/2026-10-01_service_events.sql` | Platform | — |
| D10 | Schedule / reschedule **email boxes default off**; a drag never emails | `d932d21` 10-01 | `CallModals.tsx` | `notifyCustomer` on call routes | Platform (Harmon's choice, applied to all) | — |
| D11 | Board membership + order in **Manage users**, Board column | `ebadca8` 09-29 | `pages/settings/UserFormModal.tsx`, `UsersPage.tsx` | SF package `dispatch-board-2026-09-30`; `sundial-user-admin` | Platform | USERS |

## 3. Technician app (`/tech`)

| # | Feature | Since | harmon-crm files | sundial-core dependency | Kind | New-client step |
|---|---|---|---|---|---|---|
| T1 | `/tech` inside the portal; a Technician login is sent there from every office route | `7da10ab` 09-15 | `App.tsx` (`OfficeOrTech`), `tech/TechLayout.tsx`, `hooks/useAccess.ts` | `GET /auth/me` scope `tech` (`lib/access.js`); action `service.tech.self` | Platform | USERS (Access level Technician) |
| T2 | **Today** (cards by time, on-the-clock pinned, prev / next day, Directions + Call links, cached copy offline); empty day points at the next day with work | `7da10ab` 09-15, `19d26ec` 09-28 | `tech/TechTodayPage.tsx` | `GET /service/tech/day` | Platform | — |
| T3 | **The call page**: status buttons for the moment, On my way with "text the customer", live clock, checklist gate on Complete, work vs private notes, camera + library photos, read-only estimate with **Add something I found** | `7da10ab` 09-15, `fe7ceca` 09-16 | `tech/TechCallPage.tsx`, `techView.ts`, `gps.ts` | `/service/tech/calls/{id}/*` (`wire-service-tech-routes.ps1`), `POST …/estimate-lines` (estimate Lambda); `lib/sms-send.js` | Platform | TWILIO (for "on my way"); BRAND (`companyName` in the text) |
| T4 | **Offline queue**: send now or queue with tap time + id, replay in order, failed taps shown with Discard; photos in IndexedDB, re-presign on expiry | `7da10ab` 09-15 | `tech/offline.ts`, `photoStore.ts`, `useTechOffline.ts` | server treats `eventId` as idempotent | Platform | — |
| T5 | **PWA**: manifest (`start_url /tech`), service worker (app shell only, never an API response), icons | `7da10ab` 09-15 | `public/manifest.webmanifest`, `public/sw.js`, `public/icons/tech-*`, `tech/registerSw.ts` | none | **Code** (icons, `VERSION` cache name) | BRAND-ASSETS (icons); bump `sw.js` `VERSION` |
| T6 | Menu + read-only lists and records (Jobs, Estimates, Customers with Customer Type chips), job page with visits + estimate + **Communications** | `fe7ceca` 09-16, `a650b05` 09-18 | `tech/TechListPages.tsx`, `TechDetailPages.tsx` | action `service.tech.read`; `sql/sundial_access_p10_tech_scope.sql` (comments RLS for `tech`) | Platform | — |
| T7 | Staying signed in (session renewed on foreground / network back) | `fe7ceca` 09-16 | `contexts/AuthContext.tsx` | Supabase Auth session settings (`docs/pwa-architecture.md` → *Staying signed in*) — **shared project** | Platform | — |
| T8 | "Couldn't load" message instead of Loading… forever when there is no cached copy | `b93799b` 09-17 | `tech/offline.ts` (`loadError`) | — | Platform | — |
| T9 | Job page: everyone's Photos (grouped by call) and Files (minus photos, plus estimate PDFs) | `ac68809` 09-17 | `TechDetailPages.tsx`, `techApi.ts` | `GET /service/tech/jobs/{id}/{photos,files}` | Platform | ORIGIN (bucket CORS) |
| T10 | The house (cached Street View) on call + job pages; Remote diagnosis (office) under the issue | `a650b05` 09-18 | `tech/HouseImage.tsx` | tech Street View route; `sundial/google-maps` | Platform | — |
| T11 | Price-book search says when nothing matches or the request fails | `63d3828` 09-21 | `TechCallPage.tsx` | `GET /service/tech/price-book` | Platform | — |
| T12 | Push banner ("Turn on") and Notification Settings from the More sheet | `f1b110b` 09-22 | `tech/PushBanner.tsx` | see N3 | Platform | PUSH |
| T13 | Link from the call to its job ("Open the job") | `5c4e091` 09-22 | `TechCallPage.tsx` | — | Platform | — |
| T14 | **My day** card: Start my day, Clock out for the day (note on time outside calls; disabled while on a call) | `9f57488` 09-28 | `tech/TechDayCard.tsx`, `offline.ts` (kind `day`) | `GET /service/tech/day`, `POST /service/tech/day/{start,end,note}`; SF package `tech-day-2026-09-28` | Platform | — |
| T15 | **Inbox** (every notification, unread badge), **Schedule** (every tech's day, side-by-side, swipe, week strip), **Timecard** (my week, read-only); bottom bar Today · Inbox · Schedule · Jobs · More | `d91104e` 09-29 | `tech/TechInboxPage.tsx`, `TechSchedulePage.tsx`, `TechTimecardPage.tsx`, `scheduleLayout.ts` | `sundial_notifications` (RLS), board read, payroll read for self | Platform | — |
| T16 | **One call on the clock**: On my way / Clock in greyed while clocked in elsewhere, banner links the other call | `ebadca8` 09-29 | `TechCallPage.tsx` | `409 CLOCKED_IN_ELSEWHERE`, `onTheClock` on the call read | Platform | — |
| T17 | **Field app / Office view** links for office logins; sign-in returns to the requested page | `ebadca8` 09-29 | `components/settings/SettingsControls.tsx`, `TechLayout.tsx`, `LoginPage.tsx`, `ProtectedRoute.tsx` | — | Platform | — |
| T18 | Delete a photo on the phone (own visits), Summary of work on the tech job page | `7647e2e` 09-29 | `tech/PhotoTile.tsx`, `TechDetailPages.tsx` | photo delete route; `POST /service/tech/jobs/{id}/summary` | Platform | — |
| T19 | Event calls on the phone (name + details; no house, checklist, photos; Complete not gated) | `d932d21` 10-01 | `TechCallPage.tsx` | `Visit_Type__c = Event` | Platform | — |

## 4. Photos and files

| # | Feature | Since | harmon-crm files | sundial-core dependency | Kind | New-client step |
|---|---|---|---|---|---|---|
| P1 | **Full-screen photo viewer**: swipe, ←/→ keys + arrows on every screen, pinch / double-tap zoom with pan, counter, caption, neighbours preloaded, Download, Delete (in place), Escape closes — on the job page, the tech call page and the tech job page | `bf70bf4` 10-06, `1b71997` 10-07 | `components/photos/PhotoLightbox.tsx`, `tech/PhotoTile.tsx` (`onOpen`), `JobPhotosCard.tsx`, `TechCallPage.tsx`, `TechDetailPages.tsx` | **client-side only** — reads the presigned URLs the photo routes already return | Platform | ORIGIN (bucket CORS `GET` — Download is a `fetch()`, not a link) |
| P2 | **Download all** as one zip (one folder per visit, "7 of 38…" progress), on all three Photos widgets | `bf70bf4` 10-06 | `components/photos/DownloadAllButton.tsx`, `lib/zip.ts` (store-only ZIP writer) | **client-side only — but every photo is `fetch()`ed from S3 in the browser, so the `sfsolproj` bucket's CORS must allow the portal origin for `GET`.** Nobody had written this down before; it is the ORIGIN step's third part | Platform | ORIGIN (bucket CORS) |
| P3 | Downloads bypass the browser's image cache (`cache: 'no-store'`, `mode: 'cors'`) — the fix for "0 photos zipped" when a thumbnail had cached S3's reply without `Access-Control-Allow-Origin` | `a9abd1e` 10-07 | `lib/zip.ts` (`fetchForDownload`), `components/files/FilesPanel.tsx` | client-side only; depends on the bucket CORS above | Platform | — |
| P4 | Delete confirm as a small card over the page (Escape / backdrop = Keep) | `a9abd1e` 10-07 | `components/photos/DeletePhotoConfirm.tsx` | client-side only | Platform | — |

## 5. Hosted customer pages (no login)

| # | Feature | Since | harmon-crm files | sundial-core dependency | Kind | New-client step |
|---|---|---|---|---|---|---|
| H1 | **`/estimate/:token`**: the server-rendered estimate in a sandboxed iframe, Approve (typed name), Decline, Download PDF; 404 / 410 / approved states | `f1c9887` 09-11, `4ff173a` 09-11 | `pages/PublicEstimatePage.tsx` | `GET /public/estimates/{token}`, `POST …/{accept,decline}` → `sundial-service-public` (`wire-service-public-routes.ps1`) | Platform; header logo is **Code** | BRAND (`logoUrl`, `companyName`, footer keys); BRAND-ASSETS (header logo); BRAND `publicUrl` or the links point nowhere |
| H2 | Pay on the estimate page: deposit / keep a card / pay the invoice through **Stripe Checkout**, thank-you that waits for the webhook, cancel message, "not set up" state, partner-billed never asked | `5661ca6` 09-17 | `PublicEstimatePage.tsx` | `POST /public/estimates/{token}/checkout`; `POST /webhooks/stripe/{tenant}`; `sql/sundial_stripe_events.sql` | Platform | STRIPE |
| H3 | **`/report/:token`**: the job report + receipt, Download PDF, missing / expired states | `80a232f` 09-21 | `pages/PublicReportPage.tsx` | `GET /public/reports/{token}` | Platform; header logo is **Code** | BRAND; BRAND-ASSETS |
| H4 | **HCP-style documents** (D-081): estimate, invoice and job report share one frame — logo with company name under it, payer top-left, meta box (PAYMENT TERMS, AMOUNT DUE), SERVICE ADDRESS only when someone else pays, CONTACT US, `name | license · website · n of N` footer; page and PDF identical | backend 2026-10-07 (no portal file — the pages show the server's HTML) | `PublicEstimatePage.tsx`, `PublicReportPage.tsx`, `svc/PreviewModal.tsx` (display only) | `lib/document-html.js`, `lib/document-pdf.js`, `lib/estimate-document.js`, `lib/job-report-document.js`, `lib/brand.js` in `sundial-service-estimate` + `sundial-service-public` | **Config** | BRAND (`companyName`, `logoUrl`, `addressLine`, `phone`, `email`, `licenseLine`, `websiteUrl`, `paymentTerms`, `termsUrl`/`termsBlurb`, `clubUrl`/`clubBlurb`, `tagline`, `footerNote`, `accentColor`) |

## 6. Service Club

| # | Feature | Since | harmon-crm files | sundial-core dependency | Kind | New-client step |
|---|---|---|---|---|---|---|
| C1 | Public pages `/club`, `/club/join`, `/club/joined`, `/club/service`, `/club/booked`, `/club/manage` (plans, join → Stripe Checkout, book a paid visit, customer-portal link) | `5e3363a` 09-18 | `pages/club/ClubPublicPages.tsx`, `publicClub.ts`, `config/client-config.ts` (`serviceClub`, `features.servicePlanEcommerce`) | `/public/club/{tenant}/…` (`club.js` in `sundial-service-estimate`, `wire-service-club-routes.ps1`) | **Config** (phone, site, service area, terms in `client-config.ts`) + **Code** (header logo, page copy) | CLUB; STRIPE; BRAND-ASSETS; `clientConfig.serviceClub` |
| C2 | **Service → Service Club**: tiles, memberships table, membership dialog (cancel through Stripe, resend to SolarFax), Add member (join link), Plans editor, members owed a visit | `5e3363a` 09-18 | `pages/service/ServiceClubPage.tsx`, `lib/club-api.ts` | `/service/club/*`; `sql/2026-09-18_service_club.sql`, `sundial_service_plan_cache.sql`, `sundial_membership_cache.sql`; SF package `service-club`; `lib/solarfacts.js` | Platform | CLUB |
| C3 | Member chips on job and estimate, **Apply member discount**, "Service Club" on the customer's related-records bar | `5e3363a` 09-18 | `svc/MemberBadge.tsx`, `config/related-records.ts` | `POST /service/estimates/{id}/apply-plan-discount` | Platform | CLUB |

A client with no club removes C1–C3 and records it (`conops-demo` § 3 is the worked example).

## 7. Notifications and mentions

| # | Feature | Since | harmon-crm files | sundial-core dependency | Kind | New-client step |
|---|---|---|---|---|---|---|
| N1 | **Bell** in the office header: unread badge, newest rows, Mark all read, opens the row's path | `f1b110b` 09-22 | `components/notifications/NotificationBell.tsx`, `contexts/NotificationsContext.tsx` | `sql/sundial_notifications.sql` (RLS own rows); Realtime `user:{profile_id}:notify`; `lib/notify.js` in every emitter | Platform | — |
| N2 | Native browser pop-up when the tab is open but not in front | `f1b110b` 09-22 | `NotificationsContext.tsx` | — | Platform | — |
| N3 | **Settings → Notifications**: push on this device, Send me a test, category switches, browser pop-ups | `f1b110b` 09-22 | `components/notifications/NotificationSettingsModal.tsx`, `lib/push.ts`, `lib/notify-api.ts`, `contexts/UserPreferencesContext.tsx`, `public/sw.js` (`push`, `notificationclick`) | `GET /notify/config`, `POST/DELETE /notify/subscriptions`, `POST /notify/test` → `sundial-notify` (`wire-notify-routes.ps1`); `sundial/push` (VAPID); `sql/sundial_user_preferences.sql` | Platform | PUSH |
| N4 | Reminders to techs (day-before digest, upcoming / late) | backend D-074 | — | EventBridge **`sundial-notify-sweep`** (rate 5 min) → `sundial-notify`; `REMINDER_HOUR`, `SERVICE_TIMEZONE` | Platform | — (one rule serves every tenant; the hour and timezone are one value per Lambda) |
| N5 | `service_intake` alerts nobody can switch off (unassigned Service customer → Service Admins / Managers / Executives; assigned → that person) | `9c533ed` 10-02 | `lib/notify-api.ts` | `lib/service-intake-alerts.js` in `sundial-service-estimate` + `sundial-sf-update` | Platform | USERS (default department Service) |
| N6 | **Mention links follow the comment's origin**: `comments.context` (sales / service / solar / roofing) decides which view the alert and the Mentions feed open; a reader without the module lands on Sales with a banner | `708e4b7` 10-06 | `components/comments/{CommentsPanel,CommentThread,MentionsFeed}.tsx`, `comments-data.ts`, `CustomerDetailPage.tsx` (`?from=service`) | `sql/2026-10-07_comment_context.sql`; `sundial-comment-notify` `CONTEXT_PATHS` (POST `/webhooks/comment-mention`, called by Postgres `pg_net`; `sundial/comment-notify` + `private.app_config.comment_notify_secret`) | Platform | BRAND (`portalUrl` for the email link; primary tenant: `PORTAL_BASE_URL`) |

## 8. Lists, search and the Sales / Solar / Dashboard pages

| # | Feature | Since | harmon-crm files | sundial-core dependency | Kind | New-client step |
|---|---|---|---|---|---|---|
| L1 | Sales leaves Service-only customers out; board caps per column | `6af9357` 09-28 | `pages/SalesPage.tsx`, `components/sales/CustomersBoard.tsx`, `lib/service-customers.ts` (`isServiceOnly`) | now server-side: `not[customer_type]=Service` (D-080) | Platform | — |
| L2 | **Narrow list rows** (`?fields=list`) on every list screen | `9dee07d` 10-04 | `lib/api.ts`, every list page | `sundial-sf-query` `LIST_PROJECTION` (D-079) | Platform | — |
| L3 | **Sales page server-side** (D-080): pipeline header (badges, Stage / Rep / Source options with counts) from one call, paged table of 100 with Load more, every header sorted on the server (INVALID_SORT → plain header), board = one request per stage column (6 in flight), search with the full filter set | `cf4ae4f` 10-05 | `pages/SalesPage.tsx`, `components/sales/{sales-pipeline,table-sort}.ts`, `CustomersTable.tsx`, `CustomersBoard.tsx`, `hooks/{usePagedList,useServerSearch}.ts` | `GET /sf/{object}/pipeline` (`wire-sales-pipeline-route.ps1`); `sql/sundial_customer_pipeline.sql` (EXECUTE revoked from PUBLIC), `2026-10-05_sales_pipeline_indexes.sql`; `f[col]` / `not[col]` / `sort` read from `multiValueQueryStringParameters` | Platform | — |
| L4 | **60-second list cache**: a key answered in the last minute renders with no request; writes invalidate it; cleared on sign-out | `cf4ae4f` 10-05 | `lib/list-cache.ts`, `lib/api.ts`, `contexts/AuthContext.tsx` | client-side only | Platform | — |
| L5 | **Solar Projects + Dashboard server-side** (D-080 am. 1): Solar header (Stage / PM / Rep counts) and Dashboard tiles from one `solar:pipeline` call shared by both pages; paged + sorted table; per-column board; Dashboard "Active" from the server's terminal-stage rule | `1aa6ad8` 10-06 | `pages/SolarProjectsPage.tsx`, `DashboardPage.tsx`, `components/solar/{solar-pipeline.ts,ProjectsTable.tsx,ProjectsBoard.tsx}`, `components/board/{PagedBoardColumn.tsx,group-locally.ts}` | `GET /sf/solar/pipeline`; `sql/sundial_solar_pipeline.sql`, `2026-10-06_solar_pipeline_indexes.sql`; `TERMINAL_STAGE_TERMS` / `NOT_TERMINAL_STAGES` in `sundial-sf-query` | Platform | PICKLIST (Solar stages; the terminal-stage terms are org-wide code) |
| L6 | **Global search by phone digits / every word / every status**: header search covers customers, solar, roofing, **Service jobs and estimates**; a Service-only customer opens in the Service view; phone / email / address named in the search boxes | `4d9498a` 09-29, `708e4b7` 10-06 | `components/GlobalSearch.tsx`, the list pages | `sundial-sf-query` `searchOrExpr` / `searchWords` (AND of words, phone-digit alternative); tech app `searchWhere` | Platform | — |
| L7 | Customer Type on Sales → New Customer (defaults Solar); tech Customers chips | `a650b05` 09-18 | `components/sales/NewCustomerModal.tsx` | `Customer_Type__c` | Platform | PICKLIST |
| L8 | Companies filter + company display names in Sales lists | `9a730d7` 10-07 | `components/sales/{CustomersTable,CustomersBoard,helpers,table-sort}.ts(x)` | `display_name_sort` (see S45) | Platform | — |

## 9. Users, sign-in and settings

| # | Feature | Since | harmon-crm files | sundial-core dependency | Kind | New-client step |
|---|---|---|---|---|---|---|
| U1 | Manage Users **Send invite / Resend link** | `6184863` 09-22 | `pages/settings/UsersPage.tsx`, `lib/api.ts` | `PATCH /admin/users/{id} { resendInvite }` → `sundial-user-admin`; `lib/auth-email.js`; SES | Platform | BRAND (`portalUrl`; else `PORTAL_URL_NOT_CONFIGURED`); ORIGIN (Supabase redirect allowlist) |
| U2 | **Forgot password** through Sundial, Supabase fallback; never reveals whether an account exists | `6184863` 09-22 | `lib/forgot-password.ts`, `pages/LoginPage.tsx` | `POST /auth/forgot` → `sundial-auth-proxy` (`wire-auth-forgot-route.ps1`) | Platform | BRAND (`portalUrl`); ORIGIN |
| U3 | Default department values are the Salesforce API names | `02ff309` 09-23 | `pages/settings/departments.ts`, `UserFormModal.tsx` | `Default_Department__c` picklist | Platform | PICKLIST |
| U4 | Request types from the org picklist (`useActivePicklistValues`) | `ebadca8` 09-29 | `NewServiceCustomerModal.tsx`, `ServiceCustomersPage.tsx` | `GET` picklist describe | Platform | PICKLIST |

---

## Baseline — before 2026-09-10

Summarised at feature-area grain; each was built before this inventory existed. Full detail
in harmon-crm PROGRESS.md and this repo's DECISIONS.md.

| Area | What a user gets | Main harmon-crm files | sundial-core dependency | Kind | New-client step |
|---|---|---|---|---|---|
| Sign-in, reset, shell | Login, reset password, sidebar + mobile bottom nav, light / dark | `LoginPage.tsx`, `ResetPasswordPage.tsx`, `components/{AppLayout,MobileNav,ProtectedRoute}.tsx`, `contexts/AuthContext.tsx` | `GET /auth/me` → `sundial-auth-proxy`; Supabase Auth (shared project) | Platform; logos are Code | BRAND-ASSETS; ORIGIN |
| Access model | What each level / dealer / rep may see and do (D-064) | `hooks/useAccess.ts`, `useRecordAccess.ts` | `lib/access.js`, `ACCESS_MODEL_MODE`; `sql/sundial_access_p*.sql` | Platform | USERS |
| Sales (customer hub) | Lead / Opportunity / Customer pipeline, table + board, customer detail with sectioned tabs, edit engine, New Customer | `SalesPage.tsx`, `CustomerDetailPage.tsx`, `config/customer-detail-config.ts` (generated from the field workbook) | `/sf/customer` → `sundial-sf-query` / `sundial-sf-update` | **Code** (generated config carries Harmon labels and help text) | Regenerate or hand-edit the detail config; PICKLIST |
| Residential Solar | Projects list + board, project detail, Budget tab + Recalculate, Create Project from customer | `SolarProjectsPage.tsx`, `SolarProjectDetailPage.tsx`, `config/solar-detail-config.ts`, `config/customer-to-solar-map.ts` | `/sf/solar`; `POST /projects/{id}/budget/recalc` → `sundial-budget` | **Code** (labels such as "Harmon Job #"; budget cost groups) | Detail config; in-house sales-company rule |
| Roofing | Projects list, project detail | `RoofingProjectsPage.tsx`, `RoofingProjectDetailPage.tsx`, `config/roofing-detail-config.ts` | `/sf/roofing`, `sundial-roofing`; `sql/sundial_roofing_cache*.sql` | Code (generated config) | Detail config |
| Acumatica | Update Budget, attribute sync, Sync customer / project to Acumatica | `components/solar/BudgetPushAction.tsx`, `lib/attribute-sync.ts`, `components/sales/ProjectSetupAction.tsx` | `sundial-acumatica-budget-push`, `sundial-acumatica-push` | PRIMARY-ONLY | Remove the UI or allowlist the slug |
| Aurora | Send to Aurora (design request) | `components/sales/DesignRequestAurora.tsx` | `sundial-aurora-push` | PRIMARY-ONLY | Remove the UI or allowlist the slug |
| Files on every record | Upload, download, search, categories, Related Files, copy customer files to a new Solar project | `components/files/FilesPanel.tsx` | `/files/*` Lambdas; S3 `sfsolproj/SUNDIAL/{id}/`; `sundial_file_metadata` | Platform | ORIGIN (bucket CORS) |
| Comments + @-mentions | Per-record comments, mentions, Mentions feed, mention email | `components/comments/*` | Supabase `comments` + RLS; `sundial-comment-notify` | Platform | BRAND (`portalUrl`) |
| Related records bar | Chips between a customer and its projects | `components/detail/RelatedRecordsBar.tsx`, `config/related-records.ts` | parent filters in `sundial-sf-query` | Platform | — |
| Self-serve settings | Mention alerts on / off, default list view | `components/settings/*`, `contexts/UserPreferencesContext.tsx` | `sql/sundial_user_preferences.sql` | Platform | — |
| Manage Users | Create, edit, deactivate users; dealers | `pages/settings/UsersPage.tsx`, `UserFormModal.tsx` | `/admin/users`, `/admin/dealers` → `sundial-user-admin` | Platform | — |

## Backend-only capabilities (no portal screen)

Not inventory rows — there is nothing in the fork to check — but a new client asks about
them: the Retell **Welcome Call** (PRIMARY-ONLY, D-054 / D-082), **direct lead webhooks**
(`sundial-lead-intake`, D-077: a per-tenant slug in `sundial/lead-webhooks`), the **cache
sync** (EventBridge `sundial-cache-sync-incremental` every 5 min and `…-cold` every 30 min —
shared, nothing per tenant), **Dropbox copy-back**, and the **Housecall Pro import**
(`scripts/hcp-*.mjs`, per client and only if they come from HCP).

## Known Harmon leftovers in the template

What a new fork has to touch even though no row above is "Harmon's feature":
the 14 logo imports (BRAND-ASSETS); `index.html` title; `clientConfig` (most of harmon-crm's
copy is unread — `conops-demo` rewrote it so every key is read); the generated detail
configs' Harmon labels and help text; `INTAKE_FIELDS`' "Did Harmon install this system?";
default state `AZ` in the Service popups; the Phoenix map centre; board hours 6a–7p;
`SERVICE_TIMEZONE`, `SERVICE_SHOP_LATLNG`, `EMAIL_REPLY_TO` and `REMINDER_HOUR`, which are
**one value per Lambda** and therefore Harmon's for every tenant until they move into the
brand / tenant settings.
