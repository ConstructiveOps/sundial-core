# Sundial Service Module — Data Model (Phase 2, v2)

> **Status: source of truth for the service object model as of 2026-09-09 (D-072).**
> This supersedes the object layout in `docs/service-workflows.md` §4/§7 and the two
> field workbooks where they differ; those get regenerated from this doc. The
> workflow/state descriptions in `service-workflows.md` still apply unless contradicted
> here. Naming convention, tenant isolation, and every other CLAUDE.md rule apply
> unchanged.
>
> Origin: Tim's proposal after the 2026-09-09 meeting (Paige + Beth + Matt), which
> settled three things the previous design didn't have: estimates exist as records that
> can pre-date a job, every job has exactly one estimate, and pricing comes from a
> versioned price book instead of typed-in line fields. Sections marked **[Tim]** are
> his calls; **[Recommended]** are Claude's additions that close a gap in the proposal
> and are adopted unless Tim overrides; **[Get from Harmon]** are not ours to decide.

---

## 1. The seven objects and how they relate

```
Sundial_Customer__c  (hub — unchanged)
   │
   ├──< Sundial_Estimate__c            EST-#   the quote AND the living bill of work
   │       │  1:1 once converted
   │       ├──< Sundial_Service_Line__c SL-#   junction: estimate × price-book item (+qty, snapshots)
   │       │        └──> Sundial_Price_Book_Item__c   versioned catalog (tenant-scoped)
   │       │
   │       └──  Sundial_Service_Job__c  SVC-#  the work (was Sundial_Service__c)
   │                │
   │                ├──< Sundial_Service_Call__c   SC-#   one tech × one appointment: clock, GPS, notes, photos
   │                │                                     (was Sundial_Service_Visit__c)
   │                ├──   Sundial_Service_Invoice__c      one per job (reissue = -2); the billing record
   │                └──< Sundial_Service_Payment__c PAY-#  deposit / payment / refund — one per Stripe event or check
   │
   └──> Sundial_Solar__c / Roofing / Commercial  (originating project, optional lookups on job + estimate)
```

Cardinality rules the Lambdas enforce (validation rules added where cheap):

| Rule | Why |
|---|---|
| Every **job has exactly one estimate**; an estimate has **0 or 1 job**. **[Tim]** | "Every job has an estimate" protocol; quick-create makes the estimate for you. |
| **Lines belong to the estimate**, never to the job. **[Recommended]** | One living set of lines (Matt's "the estimate grows until it becomes the invoice"). Copying lines to the job would create two truths. See §3. |
| **One job = one payer.** Bill-To lives on the **job** (not the customer, not the estimate). A second payer at an address = a second job. | 9/9 meeting (Matt/Paige/Beth). Kills HCP "segments". |
| A line references a **specific price-book item version** (or nothing, for ad-hoc lines), and snapshots price/cost/description at add time. | History survives price-book updates two ways (versioning + snapshot). |
| Price-book items are **never deleted or edited in place after first use** — only *Updated* (clone → new version, old one inactive). **[Tim]** | Old jobs keep their pricing. |
| Invoice is created from the estimate's lines at billing time and **freezes** amounts. Payments attach to the job (and to the invoice once it exists). | Deposits are taken before an invoice exists. |

Objects that do **not** exist, on purpose: Asset (D-065.1 stands), Estimate Version (versions are a JSON log + PDF, §3.4), Estimate Template (templates are estimates, §4.3), Bundle Component (a Product item carries labor+material on itself; multi-item kits are templates).

---

## 2. Why not "just associate price-book items to the estimate"

Tim's proposal: "we need not add line-item fields … just associate the right price book items." Right instinct, but a Salesforce lookup is one-directional: a price-book item can point at *one* estimate, and "Standard Service Call" is on hundreds of them. The association has to be a row of its own — the **line**. That row is also where three things live that the price-book item can't hold:

1. **Quantity** (3× Square D disconnect, 40 ft of wire, 1.5 hours).
2. **Per-use price override** (Paige: "sell the standard service call at 350 instead of 275") and the **snapshot** of what the item said at the time.
3. **Ad-hoc lines** with no catalog item (Tim's "description plus estimated cost, very basic" — HCP's non-standard adders).

So `Sundial_Service_Line__c` (already built, re-parented) is the junction. The user never sees it as a separate thing — the estimate screen is a line grid, "add from price book" writes a line and snapshots the item onto it. Practically unlimited lines per estimate, standardized pricing via the catalog — both of Tim's goals hold.

---

## 3. Estimate ↔ Job lifecycle

### 3.1 Two entry points, one shape **[Tim]**

| Path | What gets created | When |
|---|---|---|
| **New Estimate** (from a Customer, or from the Estimates list with customer search) | Estimate (Draft) + lines (from a template or price book) | Proposal work, anything with a non-standard price (Paige: "almost always send an estimate and ask them to approve"). |
| **New Job / quick-create** (from Customer, Jobs list, or intake) | Estimate (Draft, optionally pre-loaded from the tenant's default template — e.g. Standard Service Call) **+ Job (New)** in one transaction | Customer on the phone: "275, fine, come Tuesday." Partner work orders (RMA/lease) with no proposal step. |
| **Create Job** button on an estimate that has none | Job (New), `Estimate__c` set; estimate ↔ job linked 1:1 | Customer accepted the proposal (or the office decides to schedule before approval — never blocked). |

Nothing in this model blocks scheduling, sending, or invoicing on the state of anything else. Paige's HCP complaint ("can't copy to job unless approved") is explicitly designed out; restrictions come later as per-tenant validation rules if Harmon ever asks.

### 3.1a The customer is part of the same popup — never a detour through Sales **[Tim, 2026-09-09]**

*New Estimate* and *New Job* (and, when they exist, *New Roofing Project* / *New Commercial
Project*) open one popup that starts with a customer search (name / email / phone / address
against the 31.6k hub). Pick an existing customer, **or** switch to "New customer" and type the
basics only — first name, last name, street/city/state/zip, email, phone — and the customer is
created in the same request as the estimate/job. Nobody goes to the Sales module to make a
customer first.

`Requested_Project_Types__c` (multi-select picklist on `Sundial_Customer__c`, already in the
org) is the product-history tag and is **never shown in the popup**: a new customer created
from Service gets it set to `Service`; an existing customer gets `Service` **added** to
whatever is already selected (read → union → write, semicolon-joined). Roofing and Commercial
do the same with their own value when those buttons are built. Customers, leads, and
opportunities then sort by what Harmon has done for them.

Rules the Lambda enforces:
- **Soft duplicate guard before any create.** Exact email, phone (digits-only) or normalized
  street+zip match returns `409 DUPLICATE_CANDIDATES` with the matches; the popup shows them
  ("is it one of these?"). Creating anyway requires `confirmNew: true`. The hub is the
  dedupe surface for HCP migration too, so this is the same key set (email primary).
- The customer create goes through the **same validated path as `POST /sf/customer`**
  (describe-driven field check, `Client__c` stamped from the token, blocklist) — the
  estimate Lambda calls that helper, it does not hand-roll a second customer writer.
- **Atomic from the user's view:** if the estimate/job create fails after the customer was
  created, the response says so (`customerCreated: true, id`) rather than silently leaving
  an orphan the user will re-create.
- **[Get from Tim/Harmon]** the *Lead & Source* defaults for a service-originated customer:
  `Stage__c` / `Status__c` / `Lead_Source__c` values. Not guessed — the Lambda sets only what
  is configured per tenant.

### 3.2 After conversion, the estimate is the job's "Estimate" tab

Adding work from the job screen writes lines to the same estimate. Field estimates from the PWA write lines with `Stage__c = Proposed` and `Added_By_Service_Call__c` set, so the office sees what the tech added and what the customer has and hasn't approved.

### 3.3 Estimate statuses (separate from job status)

`Sundial_Estimate__c.Status__c`: `Draft` → `Sent` → (`Viewed`) → `Approved` | `Declined` | `Expired`; plus `Invoiced` (terminal, set when the job's invoice is issued) and `Template` (never sent, §4.3). Re-sending after changes returns Sent→Approved cycle; the last approved version number and amount are kept (`Approved_Version__c`, `Approved_Amount__c`) so a living estimate can show "approved v2 for $412; v3 pending +$180".

Job status therefore **drops** `Estimate Sent` / `Estimate Approved` (those were D-065.4's states-as-estimate approach). Job `Status__c`: `New` → `Triaging` → `Remote Investigation` → `Ready to Schedule` → `Scheduled` → `In Progress` → `Awaiting Parts` → `Awaiting Office Review` → `Ready to Bill` → `Invoiced` → `Paid` → `Closed`. `Resolution__c` unchanged. The job list shows the estimate status as a column, not as part of its own status.

### 3.4 Versions **[Tim: "latest estimate amounts"; Recommended shape]**

Each **Send** increments `Version__c`, renders the PDF to `SUNDIAL/{estimateId}/estimate-v{n}.pdf`, and appends one entry to `Version_Log__c` (append-only JSON, same discipline as `Clock_Intervals__c`): `{version, sentAt, sentBy, total, lineCount, lines:[{itemCode, itemVersion, desc, qty, unitPrice, kind}], pdfKey}`. That is the whole version system — no Version object, and line deletes stay allowed because the log already holds what each sent version contained.

### 3.5 Hosted estimate page = the payment link **[9/9 meeting]**

The customer-facing URL (`Public_Token__c`, unguessable, expiring) shows the estimate and carries the accept action **and** the card-authorization form (Stripe SetupIntent, D-065.6) at the bottom. The office never sends a bare "enter your card" link. Sending the estimate is therefore also how the pre-appointment card capture happens — the flow Paige asked for ("as soon as the job opens"). Deposit-to-accept (`Deposit_Required__c`) turns the same form into a charge + card save.

### 3.6 Billing

`Ready to Bill` → **Issue Invoice** creates `Sundial_Service_Invoice__c` from the estimate's non-removed lines, freezing subtotal/discount/tax/total and Bill-To, `Name` = job number (reissue after void = `-2`). Customer-pay: charge the card on file (off-session), send **receipt + job report**; the "invoice" document is for partners. Partner: PDF for portal upload; Acumatica generation later per D-065 amendment 3. Two send buttons on the job, per Tim: *Send estimate with deposit/authorization link* and *Send invoice with pay link / receipt*.

---

## 4. Price book

### 4.1 Object: `Sundial_Price_Book_Item__c` **[Tim, with additions]**

Name is a Text field (the item's display name). Not the standard Salesforce Price Book (`Pricebook2`/`Product2`) — those are org-wide and can't be tenant-isolated; ours carries `Client__c` like every Sundial object, and each tenant has its own catalog. The API name says `_Item` to avoid confusion with the standard object.

| Field | Type | Note |
|---|---|---|
| `Item_Code__c` | Text(40), indexed | **The stable line-item ID** shared by every version of the item. Human-readable, office-assigned (e.g. `SVC-CALL-STD`). Migration fills it from HCP's export. |
| `Version__c` | Number | 1, 2, 3… per Item_Code. |
| `Is_Active__c` | Checkbox | Exactly one active version per Item_Code (Lambda-enforced — SF can't do conditional uniqueness). Portal Price Book list = active only. |
| `Superseded_By__c` | Lookup(self) | Set on the old version when *Update* creates the new one. |
| `Kind__c` | Picklist | `Labor` / `Material` / `Product` (labor+material combined) / `Fee`. Drives kind-scoped discounts and taxability. |
| `Category__c` | Picklist | Service Call, Inverter, Panel, EV, Electrical, Roofing, Inspection, Plan… **[Get from Harmon: final list; seed from HCP export categories]** |
| `Description__c` | LongText | Customer-facing text printed on estimate/invoice. |
| `Internal_Notes__c` | LongText | Never printed. |
| `Unit_of_Measure__c` | Picklist | Each / Hour / Foot / Lot. |
| `Default_Quantity__c` | Number | e.g. 1.5 for the standard service call hours. |
| `Estimated_Hours__c` | Number | On labor/product items → default appointment duration when the job is scheduled (a cheap dispatch-board win). |
| `Labor_Cost__c`, `Material_Cost__c` | Currency | Tim's cost fields (margin reporting). |
| `Labor_Price__c`, `Material_Price__c` | Currency | **[Recommended]** the sell-side split. Required because plan/manual discounts are labor-only / material-only / both (9/1 amendment 4) — a `Product` item needs a labor portion for a labor discount to bite. Labor items fill only Labor_Price, material items only Material_Price. |
| `Price__c` | Formula (Currency) | `Labor_Price + Material_Price`. One number for the grid. |
| `Taxable__c` | Checkbox | Materials default true; labor per tenant tax config. **[Get from Harmon/Heather: how HCP taxed labor vs materials — do not guess AZ TPT rules.]** |
| `HCP_Id__c` | Text, external ID | Migration key. |
| `Client__c` | Lookup | Tenant. |

### 4.2 "Update", not edit **[Tim]**

The portal offers *Update* on an active item. It clones the record with the same `Item_Code__c`, `Version__c + 1`, `Is_Active__c = true`, opens the clone for editing; on save it flips the old version to inactive and sets `Superseded_By__c`. The user sees one item; the org keeps every version. Existing lines keep pointing at the version they were created from.

Two guardrails, because the whole point is protecting history:
- **No delete**, ever, on a price-book item — the permission set grants none. "Remove from the price book" = deactivate (`Is_Active__c = false` with no successor).
- **In-place edit is allowed only while a version has never been referenced by a line** (typo fixes right after creation). Once any line points at it, the portal shows *Update* only. The Lambda checks `COUNT(lines)` before allowing a PATCH.

### 4.3 Templates are estimates **[Recommended]**

Paige's "bread and butter": the Fronius 7.7 template, the removal/reinstall template, the EV ribbon template — a named set of lines pulled in at once. Model: an estimate with `Is_Template__c = true`, no customer, a `Template_Name__c`, and its lines. "Add from template" clones those lines (re-snapshotting from the current active item version) onto the working estimate. Zero new objects, and the office maintains templates in the same line grid they already use. The tenant config names which template quick-create loads by default (Harmon: Standard Service Call).

---

## 5. Field groups on the estimate and job **[Tim's list, placed]**

### 5.1 `Sundial_Estimate__c` (EST-#)

- **Links:** `Sundial_Customer__c` (required), `Service_Job__c` (nullable; the 1:1 pair), `Originating_Solar__c` / `_Roofing__c` / `_Commercial__c` (optional), `Sold_By__c` (Sundial_User — commission attribution), `Client__c`.
- **Customer snapshot:** name, service address, phone, email (snapshot pattern, CLAUDE.md).
- **Status/versions:** `Status__c`, `Version__c`, `Version_Log__c`, `Last_Sent_At__c`, `Last_Sent_Via__c` (Email/SMS), `Last_Viewed_At__c`, `Approved_At__c`, `Approved_Version__c`, `Approved_Amount__c`, `Approval_Method__c` (Online / Verbal by office / Signed / Deposit paid), `Approved_By_Name__c`, `Declined_Reason__c`, `Valid_Until__c`, `Reminder_1_Sent_At__c`, `Reminder_2_Sent_At__c`, `Public_Token__c`, `Public_Token_Expires_At__c`.
- **Money (computed by the line-write Lambda, stored — see §6):** `Labor_Subtotal__c`, `Material_Subtotal__c`, `Fee_Subtotal__c`, `Subtotal__c`; `Discount_Scope__c` (Labor / Material / Both), `Discount_Type__c` (Percent / Amount), `Discount_Value__c`, `Discount_Amount__c`, `Discount_Source__c` (Manual / Service Plan); `Markup_Type__c` (Percent / Amount), `Markup_Value__c`, `Markup_Amount__c` (customer sees only the total — Tim's commission mechanism); `Tax_Rate__c`, `Tax_Jurisdiction__c`, `Tax_Amount__c`; `Total__c`.
- **Deposit:** `Deposit_Required__c`, `Deposit_Type__c` (Flat / Percent), `Deposit_Value__c`, `Deposit_Amount__c`, `Deposit_Paid_At__c` (mirrors the Payment).
- **Text:** `Scope_Summary__c` (customer-facing paragraph, AI-drafted from notes, office-edited), `Internal_Notes__c` (append-only stamped).
- **Templates:** `Is_Template__c`, `Template_Name__c`.
- **Field origin:** `Created_In_Field__c`, `Created_By_Service_Call__c`.

### 5.2 `Sundial_Service_Job__c` (SVC-#) — was `Sundial_Service__c`

Everything already in the ticket workbook **minus** the estimate states and the per-visit Bill-To, **plus**:
- `Estimate__c` (required lookup, the 1:1 pair). Money on the job = **cross-object formulas** to the estimate (`Estimate__r.Total__c` etc.) — no sync, no drift.
- **Bill-To (job-level only):** `Bill_To_Type__c` (Customer / Internal Warranty / Manufacturer / Leasing Partner / Other), `Bill_To_Partner__c`, `Billing_Reference__c` (partner WO#, indexed, printed). Removed from the service call.
- **Notes (9/9 meeting):** `Office_Notes__c` (append-only stamped, internal) and `Customer_Summary__c` (the paragraph for receipt/report). Tech notes are read from the service calls' `Work_Notes__c` and shown on the job — not duplicated.
- `Street_View_Image_Key__c` (9/9 ask; S3 key, fetched once at geocode time) — **[Recommended, cheap]**.
- Time roll-ups from service calls (Flow, D-065.3 stands for **time**).

### 5.3 `Sundial_Service_Call__c` (SC-#) — was `Sundial_Service_Visit__c`

As built (clock intervals, GPS, geofence tag, `Work_Notes__c` / `Private_Notes__c`, checklist snapshot), parent lookup renamed `Sundial_Service_Job__c`; `Bill_To_Override__c` removed. Multi-purpose `Visit_Type__c` + project lookups unchanged (D-027).

### 5.4 `Sundial_Service_Line__c` (SL-#) — re-parented

`Estimate__c` (required — **replaces** the ticket lookup), `Price_Book_Item__c` (optional), `Kind__c`, `Description__c` (snapshot, editable), `Quantity__c`, `Unit_of_Measure__c`, `Unit_Price__c` (snapshot, editable), `Unit_Labor_Price__c`, `Unit_Material_Price__c`, `Unit_Labor_Cost__c`, `Unit_Material_Cost__c` (snapshots for margin), `Price_Overridden__c` (Lambda-set when Unit_Price ≠ item price at add), `Line_Total__c` (formula), `Taxable__c` (snapshot), `Stage__c` (Proposed / Approved / Completed / Removed), `Sort_Order__c`, `Show_Unit_Price__c`, `Source__c` (Price Book / Template / Ad hoc / Field / Migration), `Added_By_Service_Call__c`, `Client__c`. Delete permitted (only object with delete, as before).

### 5.5 `Sundial_Service_Invoice__c` — one per job

`Service_Job__c` (required), `Name` = job number (`-2` on reissue), `Status__c` (Draft / Issued / Sent / Partially Paid / Paid / Void), Bill-To snapshot (type, partner, reference), frozen amounts (`Subtotal__c`, `Discount_Amount__c`, `Tax_Amount__c`, `Total__c`), `Paid_Amount__c` (Flow roll-up from payments), `Balance__c` (formula), `Issued_At__c`, `Sent_At__c`, `Due_Date__c`, `PDF_S3_Key__c`, `Acumatica_Ref__c`, `Acumatica_Entered_At__c` (the bridge-period hand-entry stamp; Heather's weekly digest = invoices where this is null), `Voided_At__c`, `Void_Reason__c`. Stripe fields leave this object — they belong on payments.

### 5.6 `Sundial_Service_Payment__c` (PAY-#) **[Recommended — new]**

Why: a job can have a deposit, a final charge, and a refund; partner jobs get paid by check or remittance months later; Stripe webhooks must be idempotent per PaymentIntent; Heather's digest and Beth's reports need "money received" as rows, not as fields scattered on an invoice. `Service_Job__c` (required), `Invoice__c` (optional — deposits pre-date the invoice), `Type__c` (Deposit / Payment / Refund / Adjustment), `Method__c` (Card / Check / ACH / Partner Remittance / Other), `Amount__c`, `Status__c` (Pending / Succeeded / Failed / Refunded), `Stripe_Payment_Intent_Id__c` (external ID, unique — the idempotency key), `Stripe_Charge_Id__c`, `Received_At__c`, `Reference__c` (check #), `Recorded_By__c`, `Acumatica_Applied_At__c`, `Client__c`.

Card-on-file identity: **`Stripe_Customer_Id__c` belongs on `Sundial_Customer__c`** (one field; it also serves Workstream S subscriptions). Matt flagged the customer object's spare-field budget in the meeting — **[Tim: confirm one field is available; fallback is keeping it on the job as built, which means re-capturing the card per job].**

---

## 6. Where the math runs **[Recommended — amends D-065.3 for money]**

Every line write goes through one Lambda route (`sundial-service-estimate`), so that Lambda recomputes the estimate's stored totals on each write (subtotal by kind → scoped discount → markup → tax on taxable lines → total → deposit amount) and writes them in the same call. Reasons over a Flow: the discount/markup/tax sequence has ordering and rounding rules that belong in tested code, offline PWA syncs replay through the same route, and the invoice freeze reuses the same function. A nightly reconcile recomputes from lines and reports drift. **Time** roll-ups (service call → job) stay on the Flow per D-065.3 — different shape, no rounding rules.

---

## 7. Photos and files **[Tim: "Files section and separate Photos section"]**

Same storage pattern as the Solar module, nothing stored in Salesforce: every file lives in
S3 at `sfsolproj/SUNDIAL/{sf_record_id}/…`, XFiles Pro reads the same prefix, Dropbox
mirrors it, and the portal lists from `sundial_file_metadata` in Supabase
(`docs/file-storage.md`). The Files/Photos split is a **subfolder**, which that table
already models (`subfolder` column):

| What | Key | Notes |
|---|---|---|
| Job files (partner WO PDF, invoice PDF, report PDF, anything uploaded) | `SUNDIAL/{jobId}/{filename}` | Root of the job folder, like every other module. |
| Photos | `SUNDIAL/{jobId}/photos/{serviceCallId}/{filename}` | Under the **job**, not the service call, so one job report sees every visit's photos; the service-call segment keeps them attributable. |
| Estimate PDFs (one per sent version) | `SUNDIAL/{estimateId}/estimate-v{n}.pdf` | Estimate is its own record → its own folder (XFiles Pro configured for it too). |
| Service-call files (rare) | `SUNDIAL/{serviceCallId}/…` | Allowed by the pattern; the PWA writes photos to the job path above. |

Per-photo bookkeeping the report builder needs — service call, tech, taken-at, GPS,
caption, **customer-visible flag**, before/after pair — is a small Supabase side table
`sundial_service_photo` keyed to the `sundial_file_metadata` row (photo-only columns stay
out of the shared table). **[Recommended]** It is registered by the PWA sync route with
the same best-effort `registerFileMetadata` discipline as every other writer: the photo is
visible in S3/XFiles the moment it lands, the row adds the flags. Default flag direction:
photos are **internal until marked customer-visible** (9/9: "default in, X out" applies to
the report *draft*, where the tech/office unchecks; the stored flag starts false and the
report builder pre-checks). The Dropbox mirror path for service becomes
`/Sundial/Service/{Customer} – {Job#}/…` (naming check already tracked in TASKS.md).

---

## 8. Portal surface (Service module) **[Tim]**

Three list views with search: **Jobs**, **Estimates**, **Price Book** (active only; "show inactive versions" toggle for admins). Buttons: *New Estimate*, *New Job* (auto-creates the estimate), *New Price Book Item*; on an estimate without a job: *Create Job*; on a job: *Send estimate + authorization link*, *Send invoice / receipt*, *Issue Invoice*, *Record Payment* (check/partner), *Build Customer Report*. Dispatch board and PWA designs (`dispatch-board-design.md`, `pwa-architecture.md`) are unaffected except for the object renames.

---

## 9. Migration shape (Stage 5 preview)

Each HCP job becomes Estimate + Job + Lines (from HCP invoice items; matched to price-book items by HCP id, else ad-hoc with `Source = Migration`) + Invoice + Payment(s). Every HCP price-book item becomes version 1 of a `Sundial_Price_Book_Item__c` after Beth's removal pass. Roughly 2× the record count of the old model; well within limits.

---

## 10. Decided / recommended / open — the honest ledger

**Decided (Tim, 2026-09-09):** seven-object shape; customer select-or-create inside the New Estimate / New Job popup with `Requested_Project_Types__c` tagged silently (§3.1a); estimate can exist without a job, job never without an estimate; quick-create makes the estimate; price book is the source of standardized pricing; *Update* = clone with same Item_Code, old version inactive; kind-scoped discounts; markup % or amount hidden from the customer; deposit flat or %; two send buttons; Files + Photos sections; customer photo report module.

**Recommended (adopted unless Tim says otherwise):** lines live on the estimate (§3); version log instead of a version object (§3.4); templates as estimates (§4.3); split sell prices on items (§4.1); no-delete + reference-count edit lock on items (§4.2); Payment object (§5.6); job money as cross-object formulas (§5.2); money math in the Lambda, time in the Flow (§6); photo bookkeeping in the existing Supabase file-metadata pattern (§7); Bill-To on job only.

**Get from Harmon:** category list and item codes for the price book (seeded from HCP export — Beth); how HCP taxed labor vs materials (Heather); which template is the quick-create default and its lines (Paige); estimate validity days; whether any estimate needs manager sign-off before sending; deposit rule of thumb (Paige said "quoted work with material" — ask for the threshold if any).

**Confirmed by Tim (2026-09-09):** `Stripe_Customer_Id__c` goes on `Sundial_Customer__c` (~100 spare fields); the Stage 1 package was never deployed, so the renames cost nothing. Built as `scripts/gen-service-objects.py` → `salesforce/service-objects/` v2 (7 objects, 201 fields), 7 cache tables, 3 workbooks.
