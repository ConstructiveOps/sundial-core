# Sundial — Service Workflows

> **⚠ Object model revised 2026-09-09 — read `docs/service-data-model.md` (D-072) first.**
> Where this doc and that one differ, the data-model doc wins. The material changes:
> "ticket" is now the **Service Job** (`Sundial_Service_Job__c`), "visit" is the
> **Service Call** (`Sundial_Service_Call__c`); estimates are a record
> (`Sundial_Estimate__c`) that can pre-date a job and that every job has exactly one of
> (§2's `Estimate Sent` / `Estimate Approved` job states are gone — they are estimate
> statuses now); lines hang off the estimate and price from a versioned
> `Sundial_Price_Book_Item__c`; §7's multi-payer / per-visit Bill-To override is replaced by
> **one job = one payer** (Bill-To on the job; a second payer is a second job); and a
> `Sundial_Service_Payment__c` record exists per deposit/payment/refund. Everything about
> intake, triage, dispatch, field work, notifications, and per-tenant config still applies.
>
> Ticket lifecycle, intake patterns, triage, dispatch logic, field work, and post-field
> billing for the Service Operations module (Phase 2). This is the workflow-layer design;
> the object schema lives in `docs/salesforce-schema.md`, the dispatch board's technical
> design and the PWA architecture are separate docs (referenced below).
>
> **Inputs:** `docs/service-discovery-2026-08.md` (three HCP scoping meetings — Ben,
> Beth/Paige, Larry), CLAUDE.md Service Operations section, Phase 2 design conversation
> with Tim (2026-09-01).
>
> **Marking discipline:** **[DECIDED]** = settled in design review with Tim.
> **[PROPOSED]** = this doc's recommendation, needs Tim's sign-off before build.
> **[HARMON]** = fact or requirement sourced from Harmon's team (attributed in the
> discovery digest). **[OPEN]** = needs an answer before the affected piece is built.

---

## 1. Terminology and object map

Harmon's mental model maps directly onto the schema:

| Harmon says | Sundial object | Notes |
|---|---|---|
| **Service Ticket** — the customer's issue | `Sundial_Service__c` | One per issue. Holds description, customer link, billing, status, notes, accumulated totals. |
| **Service Call** — one tech's trip (or remote session) | `Sundial_Service_Visit__c` | One per tech per scheduled appointment. Own clock, own GPS. UI label: "Service Call". |
| Line item / price book entry | `Sundial_Service_Line__c` **[PROPOSED — new object]** | Child of ticket; carries estimate AND invoice lines. See §6. |
| Invoice | `Sundial_Service_Invoice__c` **[PROPOSED — new object]** | Child of ticket; groups lines; carries Bill-To, Stripe refs, status. Needed because one ticket can produce several invoices to different payers (§7). |
| Price book | Standard `Pricebook2` / `Product2` / `PricebookEntry` | Per D-021. |

**[DECIDED] No Asset object in Phase 2.** Tickets link `Sundial_Customer__c` (required)
plus optional `Originating_Solar_Project__c` / `Originating_Roofing_Project__c`. System
specs come from the linked Solar record; a customer Harmon didn't install links only the
Customer, with any known equipment noted on the ticket. Supersedes the Asset linkage in
D-020/D-031 (ADR to be appended on doc approval). If equipment-level history is ever
needed, Asset can be introduced later without disturbing this model.

**[DECIDED] Multi-tech = parallel visits.** Each tech on a job gets their own visit
record under the ticket, with independent clock in/out ([HARMON] — per-tech time is
their #1 pain across three years of apps, and visit time feeds **payroll** as well as
billing). Ticket totals are the sum across visits.

**[DECIDED] Roll-ups via record-triggered Flow** on the visit (fires on clock events /
status change; recalculates `Total_Visit_Count__c`, `Total_Time_Minutes__c`,
`Total_Materials_Cost__c` on the ticket). The HCP migration writes totals directly —
bulk loads must not lean on Flow firings. A nightly reconciliation (extend
`sundial-cache-sync` or a small scheduled job) recomputes totals as a drift net.

---

## 2. Ticket lifecycle and state model

### 2.1 `Status__c` (pipeline position — extends the draft in salesforce-schema.md)

```
                          ┌────────────────────────────────────┐
New ──► Triaging ──► Remote Investigation                      │
  │        │              │                                    ▼
  │        │              ├──────────► Resolved Remotely ──► Closed
  │        │              ▼
  │        ├──► Estimate Sent ──► Estimate Approved ─┐
  │        │         │                               │
  │        │         └──► (Declined) ──► Closed      │
  │        ▼                                         ▼
  └──► Ready to Schedule ◄───────────────────────────┘
              │
              ▼
        Scheduled ◄──────────────┐
              │                  │ (return visit)
              ▼                  │
        In Progress ──► Awaiting Parts
              │
              ▼
     Awaiting Office Review
              │
              ▼
        Ready to Bill ──► Invoiced ──► Paid ──► Closed
```

Status values: `New`, `Triaging`, `Remote Investigation`, `Estimate Sent`,
`Estimate Approved`, `Ready to Schedule`, `Scheduled`, `In Progress`, `Awaiting Parts`,
`Awaiting Office Review`, `Ready to Bill`, `Invoiced`, `Paid`, `Closed`.

Changes vs. the schema draft: adds `Estimate Sent`, `Estimate Approved`,
`Ready to Schedule`. **The estimate flow is a ticket state, not a separate module**
**[DECIDED]** — HCP's lead → estimate → job chain collapses into one ticket whose
early states are the sales-ish part. This keeps one record per issue from first call
to payment, which is exactly the visibility Harmon lacks today.

### 2.2 `Resolution__c` (terminal disposition — new field)

**[HARMON]** HCP only offers won/lost, which forces "helped them over the phone" to be
recorded as a lost lead and wrecks their KPIs. On `Closed`, `Resolution__c` is required:

`Completed` · `Resolved Remotely – No Charge` · `Estimate Declined` · `Cancelled` ·
`Duplicate` · `Referred Out`

### 2.3 Transition rules

- **Who moves what:** intake/triage states move manually (office). `Scheduled` is set by
  the dispatch board when the first visit is placed. `In Progress` sets automatically on
  the first tech clock-in. `Awaiting Office Review` sets automatically when the last
  open visit completes (Flow). Billing states move from the invoicing surface (§7).
- **`Awaiting Parts` is the ticket-level pause** [HARMON — RMA returns run 1–2+ weeks].
  The ticket sits with no open visit and no paperwork nagging; scheduling the return
  visit moves it back to `Scheduled`.
- **`Paid` means every non-void invoice on the ticket is settled** — a ticket with a
  customer invoice paid and a manufacturer invoice outstanding stays `Invoiced`.
- **Guard in code, not in the picklist:** Lambdas validate transitions (e.g. `Closed`
  requires `Resolution__c`; `Ready to Bill` requires zero open visits). Admin edits in
  Salesforce stay possible for repair; the portal enforces the happy path.

---

## 3. Intake

Four paths in Phase 2 scope, plus two future ones. Every path lands the same shape: a
`Sundial_Service__c` in `New` with `Intake_Channel__c` set, linked to a
`Sundial_Customer__c` (found or created).

### 3.1 Phone (primary path — office staff)

- **Customer lookup first.** Search by phone/name/address against the 31.6k-record
  customer hub. **[HARMON] The intake screen must surface Harmon history**: linked
  Solar/Roofing projects, system specs, install date, prior tickets, service-plan badge,
  card-on-file status. This is the single cheapest trust-builder — today only one rep
  (Giovanna) can see Sunbase history, so reps ask customers questions Harmon already
  knows the answers to, and remote troubleshooting starts blind.
- **Minimum fields to save a new customer** [HARMON]: first name, last name, address,
  phone. Email optional (some customers have none) but prompted.
- Intake Q&A fields on the ticket: own/lease (`System_Ownership__c`), Harmon install?,
  issue description, priority. `Bill_To` defaults to `Customer` (§7).
- No separate Lead object: a phone call that dies immediately is a ticket closed
  `Resolved Remotely – No Charge` (or `Cancelled`) — cheap to create, honest to report.

### 3.2 Email (manufacturer referrals, leasing-company work orders — AI parsing)

- **Pattern: doorbell → SQS → worker**, same as Aurora inbound (D-048). A dedicated
  intake address (e.g. `service@…`) forwards into SES inbound → S3 → SQS → worker
  Lambda parses sender, referenced customer/address, work-order number, and drafts a
  ticket. **[PROPOSED]** Parsing output is a ticket in `New` flagged
  `Needs_Intake_Review__c = true` — **AI never auto-schedules and never auto-matches a
  customer silently**; the office confirms the match in a review queue. A misfiled
  work order is worse than a manually-typed one.
- **[HARMON] These are exactly the tickets that carry a partner's PO/work-order
  number** → parsed into `Billing_Reference__c` (§7) and `Bill_To` preset to the
  partner. SunRun-style batches (10/week) make this path worth automating early.
- Attachment handling: source email + attachments land in `SUNDIAL/{ticketId}/` via the
  standard file convention.

### 3.3 Portal web form

- Authenticated portal users (office, and later Harmon's public site posting through a
  shared-secret-gated public route, fail-closed per convention) submit a structured
  form → same ticket shape, `Intake_Channel__c = Web Form`.

### 3.4 Online booking — **Phase 3** (placeholder; state model already accommodates it).

### 3.5 Monitoring alerts — future

[HARMON] SolarFacts emails a daily 2pm at-risk digest to a distro only Ben reads. The
long-term design (from the meetings): threshold alert → auto-create ticket
(`Intake_Channel__c = Monitoring Alert`, already in the picklist). Requires SolarFacts
API work (intro to their CEO promised) — **not Phase 2 scope**, but intake and triage
are designed so these tickets need nothing special when they arrive.

### 3.6 After-hours

[HARMON] Today: voicemail, called back in the morning. Phase 2 changes nothing here.
The Retell-based after-hours intake remains a separately-sold add-on; when it lands it
becomes another writer of the same ticket shape.

---

## 4. Triage and remote-first

1. **Confirm identity/history** (intake screen already surfaced it).
2. **Remote troubleshooting first** [HARMON — their explicit flow]: check the inverter
   portal (Enphase / SolarEdge / Tesla per system era), errors, production. High-bill
   complaints route to the bill-evaluation path (Ben) — usually resolved without a
   truck. Findings go in `Initial_Remote_Diagnosis__c`; resolved-remotely tickets close
   with the honest disposition and **count as wins, not losses**.
3. **Quote.** Standard work is quoted verbally from the price book (truck roll ≈ $275
   [HARMON — value lives in the price book, never in code]). Complex work becomes an
   estimate (§6). Quoting authority today: Beth (in-house) / Larry (field, commercial).
4. **Card on file (optional, encouraged).** Office requests a card via emailed link or
   keys it on the phone (Stripe-hosted element either way; §8). Not a gate on
   scheduling — [HARMON] reps vary in comfort asking; the flow nudges, never blocks.
5. **Assign + schedule.** Ticket moves to `Ready to Schedule` and appears in the
   dispatch board's unscheduled tray.

**[HARMON] Internal assignment notifications are required.** Ticket and estimate carry
`Assigned_To__c` (Sundial_User__c). Assignment fires an in-portal notification plus the
existing email channel, and a "My Queue" view lists everything assigned to the current
user by state age. HCP's total lack of internal notifications is a named daily failure
("I never know Beth assigned me something"). Manager escalation ("this sat 3 days
untouched") is a report/alert on state-entry timestamps — cheap once the timestamps
exist, so every status change stamps `Status_Changed_At__c` + a status history line.

---

## 5. Dispatch logic (workflow contract — full technical design in `docs/dispatch-board-design.md`)

- **Board:** multi-tech day/week timeline (FullCalendar Premium Scheduler), tech rows,
  drag-and-drop from an **unscheduled tray** (tickets in `Ready to Schedule` + return
  visits needed). Block length defaults from the ticket's service lines (standard call
  ≈ 2h [HARMON]); edge-drag resize adjusts `Scheduled_Start/End`.
- **Placing a block creates a visit** (`Sundial_Service_Visit__c`, `Scheduled`) for that
  tech + window. Multi-tech jobs: one block per tech (copy-drag), possibly different
  windows [HARMON — techs arrive/leave independently].
- **[HARMON] Every scheduling action carries a notify / don't-notify choice.** HCP
  texts the customer on every 5-minute nudge unless suppressed; Beth suppresses
  constantly. **[DECIDED 2026-09-01, Beth]: default is OFF, opt-in per action**
  (per-tenant config; OFF is Harmon's value).
- **Concurrency [DECIDED]:** Beth is effectively the sole dispatcher (Paige/Larry
  secondary). Commits re-read fresh from Salesforce (caching-architecture.md's
  always-fresh rule) and detect a conflicting write since board load; on conflict the
  board refreshes the affected row and asks the dispatcher to re-drop. No locks, no
  reservation protocol. Realtime broadcast keeps a second viewer current.
- **Return visits:** scheduling a visit on an `Awaiting Parts` ticket returns it to
  `Scheduled`. A ticket can hold visits weeks apart; the board only renders the window
  in view.
- **Deferred [HARMON-acknowledged]:** route optimization (asked, explicitly deferred —
  their arrival windows are tight, so optimization would move appointments), live truck
  GPS map (Quartix API — investigate later; per-clock-in location tags cover the
  day-one need).

---

## 6. Estimates and line items

### 6.1 `Sundial_Service_Line__c` **[PROPOSED — new object]**

Child of ticket. One row per service/material line. Key fields:

- `Sundial_Service__c` (lookup, required) · `Sundial_Service_Visit__c` (lookup,
  optional — ties a line to the visit that used it)
- `Product2__c` (lookup, optional — ad-hoc lines allowed) · `Description__c` ·
  `Quantity__c` · `Unit_Price__c` · `Line_Total__c` (formula) · `Taxable__c`
- `Kind__c`: `Service` | `Material` | `Fee` | `Discount`
- `Stage__c`: `Estimate` | `Approved` | `Invoiced` — an approved estimate's lines
  *become* the work order and later the invoice lines; nothing is retyped.
- `Show_On_Invoice__c` (checkbox) — [HARMON] they toggle unit prices / material detail
  off per line ("just show a lump sum", "don't show the part number").
- `Sundial_Service_Invoice__c` (lookup, set when billed)

**Ad-hoc line → price book** [HARMON — loved in HCP]: entering a line not in the price
book offers "save to price book" (creates Product2 + PricebookEntry). The price book
grows from real work; office manages it in a portal surface (list/edit/import/export).

### 6.2 Estimate flow

1. Office (or tech in the field — see §9) assembles lines with `Stage__c = Estimate`,
   ticket → `Estimate Sent`. Customer receives email (SES, live today) with a clean
   estimate summary; SMS when Twilio lands.
2. **Automated reminders** [HARMON — the HCP feature they'd miss most]. **[DECIDED
   2026-09-01, Beth/Paige]:** follow-ups at **+3 days and +5 days**, then stop —
   and the stale estimate is **handed off to Nonstop Automation's drip campaign**
   as a recycled lead (webhook/Zap to NSA; they are building service-side drips).
   Internal CC on reminders was considered and rejected (inbox flooding). Cadence
   stays per-tenant config with 3/5 as Harmon's values. Rep-activity suppression
   (Ralph's future commissioned-rep model) lands with the rep model.
3. Acceptance: portal link (customer clicks Accept — public shared-secret-gated route,
   fail closed) or office marks verbally accepted. Ticket → `Estimate Approved` →
   `Ready to Schedule`, lines flip to `Approved`.
4. Declined → `Closed` / `Estimate Declined`.

### 6.3 Tax

**[HARMON — must-fix]** Tax rate resolves from the **service address city** (AHJ), not
a default. The Arizona city/county/state rate table already exists (roofing budget
work); it becomes **per-tenant config** (multi-tenant readiness list) consulted at
estimate/invoice build. Unknown city → flag for office, never silently zero.

---

## 7. Billing model

### 7.1 Bill-To — first-class and per-visit

**[HARMON — structural]** Who pays changes by ticket AND by visit: diagnosis visit
billed to the customer, the inverter-swap return visit billed to the manufacturer
(RMA); leasing-partner customers (SunRun etc.) are never billed directly — the partner
is, referencing the partner's own work-order number.

- Ticket: `Bill_To_Type__c` (`Customer` | `Harmon Warranty` | `Manufacturer` |
  `Leasing Partner` | `Other`) + `Bill_To_Name__c` (+ optional partner account lookup
  once the vendor-model decision lands) + `Billing_Reference__c` (partner's PO/WO
  number — **indexed/searchable** and printed on the invoice).
- Visit: same fields as an optional **override** of the ticket default.
- `Bill_To_Type__c = Harmon Warranty` → internal booking, customer pays nothing
  [HARMON: labor warranty and most manufacturer-warranty visits from the customer's
  point of view].
- **Wrong-party invoicing is a named failure mode** (leasing customers "freaking out"
  at direct invoices). The invoice builder derives the recipient from Bill-To and warns
  when a partner-billed invoice has a customer email target.

### 7.2 `Sundial_Service_Invoice__c` **[PROPOSED — new object]**

One ticket → 0..n invoices (HCP's 110 / 110-1 pattern, selectable per visit or
combined [HARMON]). Fields: ticket lookup; `Invoice_Number__c` (auto:
`{Ticket_Number}-{n}`); Bill-To copy (frozen at issue); line linkage (lines point at
the invoice); totals + tax; `Status__c`: `Draft` | `Sent` | `Uploaded to Partner` |
`Paid` | `Void`; `Stripe_Invoice_Id__c` / `Stripe_Payment_Intent_Id__c`;
`Acumatica_Invoice_Id__c` (populated when the AR push lands); `Sent_At__c` /
`Paid_At__c`; `Customer_Facing_Summary__c` (§7.3). PDF stored at
`SUNDIAL/{ticketId}/` per the file convention (visible in XFiles Pro + Dropbox mirror
for free).

Delivery per Bill-To: **customer** → email with summary + PDF + Stripe pay link;
**partner** → PDF download for upload to the partner's portal (no email) [HARMON].

> The ticket-level Stripe/payment fields in the schema draft
> (`Stripe_Payment_Intent_Id__c`, `Payment_Status__c`, `Acumatica_Invoice_Id__c`)
> move to the invoice object; the ticket keeps `Customer_Card_on_File__c` /
> `Stripe_Customer_Id__c` (customer-scoped) and derives `Paid` from its invoices.

### 7.3 Invoice text — AI summary of tech notes **[PROPOSED, Harmon-requested]**

[HARMON — Paige asked for exactly this] At invoice build, the visit work-note entries
are summarized into one customer-friendly paragraph (`Customer_Facing_Summary__c`),
which Beth reviews/edits before send. Raw notes stay internal. Implementation is a
single LLM call in the invoice-build Lambda — modest scope, high delight; if it slips,
the fallback is "concatenate work notes, office edits", same field, no schema change.

### 7.4 Payments

- **[DECIDED] Save-card-then-charge, not auth-and-capture.** Card on file =
  Stripe **SetupIntent** ($0, Stripe-hosted element — keyed by office on the phone or
  by the customer via emailed link). After office review sets the final amount, the
  charge runs **off-session** against the saved card, or the customer pays the emailed
  Stripe-hosted invoice link. Card-network auth holds expire in 5–7 days — shorter
  than an `Awaiting Parts` ticket — so holds are not used.
- Stripe webhook (`payment_intent.succeeded` / invoice paid) → doorbell → SQS → worker
  marks the invoice `Paid`, stamps the ticket, cache + Realtime. Shared-secret/signature
  gated, fail closed, same discipline as the other public webhooks.
- **Partner payments** land in Acumatica (Heather), not Stripe. **[DECIDED]** The full
  AR push comes after service go-live; in the bridge period the office marks partner
  invoices paid via a **bulk mark-paid grid** [HARMON — today ~800 phantom "open"
  invoices in HCP]. A read-only scheduled Acumatica payment check (start/end of day)
  against open partner invoices is cheap and can land earlier than the AR push —
  it only reads. Never send a reminder on an invoice whose payment check is pending.
- Refunds/credits: office-initiated in Stripe dashboard for Phase 2; in-portal refund
  is a later increment.

### 7.4a Refinements from the 2026-09-01 meeting (Paige + Beth)

- **Customers get a receipt + job report, not an invoice.** In practice customers pay
  up front or on completion and "very rarely ask for the invoice" — what they receive
  is a **receipt** and a **job report** (photos + tech-notes summary; HCP has this and
  Harmon uses it). The pretty customer-facing document is the **estimate/quote**; the
  invoice object remains the internal billing record and the partner deliverable.
- **Partner invoices don't need to be pretty — and should eventually come from
  Acumatica.** Today every HCP invoice is manually re-keyed into Acumatica (AR lives
  there; payments are received only there), which is the double-entry to kill. Once
  the AR push lands, the partner invoice document is **generated in Acumatica and its
  PDF pulled back onto the ticket's Files tab** for upload to the partner portal.
  Until then, Sundial renders the PDF.
- **Invoice numbering [DECIDED]:** ticket numbers are one sequential series (no
  per-department prefixes), invoice number = ticket number (suffix -2, -3… for
  additional per-visit invoices) — matches how HCP numbers jobs/invoices today.
- **Plan discounts are line-kind-scoped.** HCP can only discount the whole job
  (forcing inflated markups). Discounts must target **Service (labor) lines,
  Material lines, or both, selectable** — implemented against
  `Sundial_Service_Line__c.Kind__c`.
- **Deposits edge case:** occasional up-front deposits (e.g. removal/reinstall paid
  months ahead) are opened directly in Acumatica today — handled explicitly in the
  AR-push design, not by the standard invoice flow.
- **Warranty is informational, not automated.** Terms are layered and era-dependent
  (current installs 5-yr labor / 10-yr workmanship; ~20–25-yr roof/stanchion terms;
  **2-yr warranty on service work itself**; older installs shorter). The ticket
  surfaces known terms from the linked project as context; the office makes the
  billable-vs-warranty call.

### 7.5 POs from tickets

[HARMON — Beth's double-entry pain] `Sundial_PO__c` already carries
`Linked_Service_Ticket__c` and the Acumatica PO push shipped in Phase 1. Phase 2 adds
the portal affordance: "Create PO" from the ticket's materials context → standard PO
flow → PO number lands back on the ticket. Near-zero backend cost, retires a manual
Acumatica round-trip per materials job.

---

## 8. Field work (workflow contract — full offline/GPS design in `docs/pwa-architecture.md`)

### 8.1 Visit lifecycle

`Scheduled` → `En Route` ("on my way" — texts the customer when notify is on) →
`In Progress` (clock-in) → `Complete` (clock-out + completion gate) · terminal
alternates `Cancelled`, `No-Show`.

- **Clock semantics** [HARMON — drive-time convention, also payroll]:
  - Day starts at first job arrival, or at the shop when picking up material (shop is
    a valid clock-in location).
  - "On my way" to the next job **ends the previous visit's clock and starts drive
    time attributed to the destination visit** — matching how techs are paid today.
  - Day ends at last clock-out ("when the tires roll away").
  - Re-clock-in on the same visit (parts run, lunch) **reopens** it: intervals append
    to `Clock_Intervals__c` (JSON, Lambda-written, append-only);
    `Actual_Start__c` = first in, `Actual_End__c` = last out,
    `Duration_Minutes__c` = sum of intervals. Endless in/out per appointment
    [HARMON] without extra objects; per-day reporting holds because a multi-day job
    is one visit per tech per scheduled day.
- **GPS + geofence [DECIDED: tag, not blocker].** Every clock event records
  coordinates; `Geofence_Verified__c` = within per-tenant radius of the service
  address **or the shop**. Outside-fence clock-ins are recorded and flagged, never
  refused (Home Depot runs are legitimate). Optional later: "looks like you left the
  job — clock out?" push.
- **Completion gate** [HARMON]: a tech cannot go `En Route` to the next visit while
  the current one is missing required notes / photos / checklist items. Multi-day
  visits pause without the gate; single-day visits left open trigger an end-of-day /
  next-morning push ("finish your work order").
- **Time corrections are office/manager-only, on desktop** [HARMON — techs can
  currently edit their own hours in HCP and both managers want that gone]. The PWA
  has no time-edit surface; corrections append to the interval log with actor + reason.

### 8.2 Notes

Two feeds on the visit, both **append-only entries auto-stamped with user +
date/time** (the Welcome-Call log entry format precedent — `── ` blocks, describe-read
capacity, whole-entry trimming):

- `Work_Notes__c` — customer-facing candidates; source for the invoice AI summary.
- `Private_Notes__c` — internal only ("angry customer", "mean dog"); never merges
  anywhere customer-visible.

Authors may edit **their own** entries (Lambda rewrites the entry in place, stamps
`edited`); nobody edits anyone else's. [HARMON — Larry hand-types "LA 8/7" today.]

### 8.3 Photos, checklists, SiteCapture

- Photos: in-app capture or camera-roll upload, queued offline, landing at
  `SUNDIAL/{visitId}/` (and surfaced on the ticket via related-files) — XFiles Pro +
  Dropbox mirroring free per the file convention.
- **Checklists** [HARMON]: office assigns a template at ticket/visit creation by job
  type (e.g. inverter RMA: photo old serial, photo new serial, internet check, call
  Tesla), items flagged required gate completion; a generic default template
  ("pick up your tools") applies when none is chosen. **[PROPOSED]** templates are
  per-tenant config (JSON in `client-config.ts` / Supabase), instances stored on the
  visit — not a Salesforce object pair, to keep object count flat. Sign-off needed.
- **SiteCapture:** used on all commercial service [HARMON]; plan upgraded → API now
  available (updates D-013's premise). Phase 2 ships a **deep link** from the
  visit/ticket to the SiteCapture project; real integration (auto-create project per
  ticket, pull report PDF onto the ticket) is a later increment.

### 8.4 What the tech sees

Assigned visits (today + upcoming), other techs on the same job [HARMON — they rely on
it], customer info + maps link (Apple/Google), Harmon install context (from the linked
Solar project), **service-plan badge front and center** [HARMON], card-on-file status,
notes/photos/checklist, estimate builder (§9). Manager permission adds the layered
all-techs schedule view. Deliberately minimal beyond that — "the more basic it is, the
better" (Larry).

---

## 9. Techs and money

**[DECIDED — revises the earlier assumption]** Techs do **not** collect payment in
Phase 2 ("our techs are not bill collectors" — office, and Larry's techs never touch
the invoice/pay buttons). What ships instead, in priority order:

1. **Field estimates** [HARMON — wanted sooner]: tech assembles lines from the same
   price book in the PWA and sends the estimate on-site ("want us to come back and fix
   this?"). Same object, same reminder automation.
2. **Service-plan offer**: plan badge + "offer a plan" action that texts/emails the
   customer a signup link (full self-serve purchase arrives with the Phase 3
   e-commerce work; until then the link can open the existing signup flow).
3. **Field invoicing/collection — built behind a per-tenant flag, off at launch.**
   The plumbing (invoice object + Stripe link) is identical to the office flow, so
   enabling it later for Dan's sales-forward push is config, not construction.

---

## 10. Post-field review and closeout

1. Last visit completes → ticket `Awaiting Office Review` (Flow) + notification to the
   office queue.
2. Office reviews: notes, photos, checklist, time (corrections here), materials/lines
   (tech-added lines reconciled against the price book), warranty/RMA determination
   finalized (Bill-To per visit).
3. Manufacturer follow-up when needed (RMA paperwork; return visit → new visit under
   the same ticket, `Awaiting Parts` in between).
4. `Ready to Bill` → invoice(s) built per §7 → sent/uploaded → paid → `Closed` with
   `Resolution__c`.
5. Post-close follow-ups (review request, referral ask, service-plan upsell email)
   [HARMON — wanted] are the notification engine's post-close hooks — **later
   increment**, but the hook point (ticket → Closed event) is part of the design.

---

## 11. Notifications summary (who hears what, when)

| Event | Audience | Channel | Phase |
|---|---|---|---|
| Ticket/estimate assigned to me | Office user | In-portal + email ("My Queue") | 2 |
| Estimate reminder (every N days, unaccepted) | Customer | Email now, SMS w/ Twilio | 2 |
| Schedule created/changed (notify toggle ON) | Customer | SMS (Twilio) / email fallback | 2 |
| Tech "on my way" | Customer | SMS / email fallback | 2 |
| Visit left open (single-day) | Tech | Push (PWA) | 2 |
| Ticket sat in state > threshold | Manager | Report/alert | 2 (report) |
| Invoice sent / payment received | Office | In-portal | 2 |
| Post-close review/referral/plan ask | Customer | Email | later |

**Twilio is a Phase 2 prerequisite** (4th blocker: FullCalendar, Stripe, HCP export,
Twilio + A2P 10DLC registration — lead time applies). Every SMS above degrades to
email until it's live; the notify toggle governs both.

---

## 12. Per-tenant configuration introduced by this module

Nothing below is hardcoded for Harmon (multi-tenant rule; keeps the "needs
externalizing" list from growing):

geofence radius + shop location(s) · service business hours + board granularity ·
default visit duration by service type · notify-customer defaults · estimate reminder
cadence (N days) + rep-activity suppression window · tax rate table (city/county/state)
· `Bill_To_Type__c` partner list · checklist templates · Stripe account reference
(Secrets Manager, per tenant) · price book (data, per tenant via `Client__c` scoping)
· completion-gate required items · drive-time attribution rule.

---

## 13. Decisions recorded — see DECISIONS.md **D-065** (Service Operations Phase 2 design baseline)

1. Asset object deferred; tickets link Customer + originating projects directly
   (supersedes the Asset linkage in D-020/D-031).
2. Multi-tech = parallel visit records; visit = one tech × one scheduled appointment;
   interval-log clock model.
3. Roll-ups via record-triggered Flow + migration writes totals + nightly reconcile.
4. Estimate flow as ticket states + `Sundial_Service_Line__c` (new object).
5. `Sundial_Service_Invoice__c` (new object); Bill-To at ticket + visit; per-visit
   or combined invoicing; `Billing_Reference__c`.
6. Payments = SetupIntent + off-session charge (no auth-and-capture); Stripe webhook
   doorbell; AR push post-go-live with bulk mark-paid bridge.
7. Techs: field estimates yes, field collection behind a flag, off at launch.
8. Notes as append-only stamped entries in two long-text fields (Welcome-Call log
   format precedent), edit-own-only.

## 14. Open items **[OPEN]**

- Sign-off: the two proposed objects (`Sundial_Service_Line__c`,
  `Sundial_Service_Invoice__c`) and checklist-as-config (§8.3).
- Partner/vendor representation for Bill-To (ties into the open vendor-model decision
  in salesforce-schema.md).
- Invoice numbering expectations with Acumatica AR (Heather/Julie) before the AR push.
- Harmon: exact required checklist templates; estimate reminder cadence; geofence
  radius; who staffs the email-intake review queue.
- HCP export inventory (price book, jobs, invoices, **attachments**) via Ben's login —
  drives `docs/migration.md`, next after the dispatch and PWA docs.
