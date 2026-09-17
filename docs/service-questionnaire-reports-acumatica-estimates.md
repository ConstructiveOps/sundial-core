# Phase 2 Questionnaire — Customer Reports · Acumatica (Service) · Estimate Formatting

> Fill-in capture sheet for the meeting. Blanks `______` are answers to write down;
> ☐ items are yes/no or pick-one; 📎 marks an artifact to collect (screen-share is
> fine, but get the file/export afterward). Answers feed: the customer-report generator,
> the AR/PO integration design (D-065.6 + 2026-09-01 amendment — partner invoices
> eventually generated IN Acumatica), and the estimate template.
>
> Likely people: customer reports → Paige + Beth (+ Larry on photo flags); Acumatica →
> Heather + Julie (+ Beth); estimates → Beth + Paige (+ Larry for field estimates).

---

## Part 1 — Customer Reports (the work-completion report with photos)

> Context to hold: today this is HCP's "photo report" — Paige builds it from the
> tech's uploaded photos and notes and sends it with the receipt ("they pay it,
> then we send them a report"). It is deliberately DIFFERENT from the SiteCapture
> report, which is internal ("I'm not sending a 16-page report to a customer —
> they don't care"). We're designing the Sundial replacement, which pairs with the
> receipt-not-invoice model and the AI notes summary.

### 1.1 Samples first

- 📎 2–3 real HCP photo reports they've actually sent (a simple truck-roll one and
  a bigger repair). Ask what they like / what customers have commented on.
- 📎 One internal SiteCapture report for the same kind of job — so we capture the
  line between "internal detail" and "what the customer sees."

### 1.2 When it's sent, and by whom

- Which jobs get a report: every completed job ☐ · paid jobs only ☐ · office
  judgment call ☐ · certain job types only (which): ______
- Timing: with the receipt after payment ☐ · at job completion before payment ☐ ·
  other: ______
- Who assembles/sends it today: ______ · Time it takes per report: ______
- Target for Sundial: auto-generated draft on visit completion, office reviews +
  sends ☐ · fully manual build ☐ · auto-send with no review ☐ (recommend
  auto-draft + office review — confirm they agree)
- Warranty jobs / partner-billed jobs: does the HOMEOWNER still get a report even
  when a partner pays? ☐ Notes: ______

### 1.3 Content blocks (walk one report and check each off)

- Header: job/ticket number ☐ · service date(s) ☐ · tech name(s) ☐ · address ☐ ·
  what else: ______
- Work summary text: source is the tech's Work Notes — same AI-summarized,
  office-edited paragraph as the invoice/receipt ☐, or written separately ☐?
- Photos: how are they chosen — tech flags customer-visible photos in the app ☐ ·
  office picks at review ☐ · all job photos included ☐. Typical count: ______ ·
  max: ______ · captions wanted? ☐ Before/after pairing wanted? ☐
- ⚠ Confirm the flag direction: photos default INTERNAL until marked customer-
  visible ☐, or default visible until hidden ☐? (Wrong default = a customer sees
  something they shouldn't.)
- Checklist results shown to the customer (e.g. "system tested, production
  verified")? ☐ Which items, in what wording: ______
- Findings/recommendations section ("we noticed your panels are dirty") — wanted? ☐
  Who writes it (tech / office / AI-drafted): ______
- Workmanship statement: print the 2-yr service-work warranty on the report? ☐
  Exact wording + who owns it: ______
- Receipt/payment summary on the report itself ☐, or separate receipt document ☐?
- Footer asks (they said "on every invoice"): service-plan opt-in link ☐ ·
  review request ☐ · referral ask ☐ — order/priority: ______

### 1.4 Format + delivery

- Same identity block as the estimate (entity, ROC #s, logo, contact) ☐ —
  anything different for reports? ______
- Delivery: email with PDF attached ☐ · link to a web page ☐ · both ☐ ·
  SMS with link (when Twilio lands) ☐
- Photo handling in the PDF: full-resolution ☐ or web-sized ☐ (a 30-photo report
  at full res is a huge attachment — recommend web-sized in PDF, originals
  available on request/link)
- Does a copy land anywhere for Harmon's records beyond the ticket's Files tab
  (it will be at SUNDIAL/{ticketId}/ automatically → XFiles Pro + Dropbox)? ______
- Commercial service/O&M: does the customer report replace, accompany, or defer to
  the SiteCapture deliverable there? ______

## Part 2 — Acumatica integration for Service

> Context to hold: today every HCP invoice is **manually re-keyed** into Acumatica
> (AR lives there; payments are received ONLY there). The agreed direction is
> Sundial→Acumatica AR automation landing shortly AFTER service go-live, with a
> manual bridge period. These questions size that build precisely.

### 2.1 The manual entry we're automating (watch Heather/Beth do one)

- 📎 **Screen-share one real service invoice being entered into Acumatica,
  start to finish.** Capture:
  - Which screen/entity: AR Invoice ☐ · Sales Order ☐ · Project + billing ☐ ·
    other: ______
  - Every field they key: customer, amount(s), line detail or lump sum?,
    account/subaccount, tax category/zone, terms, reference numbers: ______
  - Is the HCP job/invoice number stored in Acumatica? Which field? ______
  - Time per invoice: ______ · Who does it (Heather? Beth?): ______
- Are service jobs ever Acumatica **Projects**? (Paige: only a few, for
  deposits.) When exactly does a service job rate a Project vs plain AR? ______
- **Deposits** (e.g. $10k removal/reinstall paid months ahead): exact current
  handling — prepayment on AR? Project? How is it applied at final invoice? ______

### 2.2 Customer + partner records in Acumatica

- How do Acumatica customer accounts map to service customers — one per homeowner,
  or generic cash-sale customer(s)? Customer class for service: ______
- Partners (SunRun etc.): each a real Acumatica customer account? 📎 List of
  partner customer IDs (pairs with Beth's Bill-To partner list).
- When Sundial creates a new service customer, should it create an Acumatica
  customer too (Phase 1 existence-check flow exists) — always, or only when
  invoiced? ______

### 2.3 GL / coding (the part only finance knows)

- Which income account(s)/subaccounts should service revenue book to?
  Split by anything (service vs materials vs plans vs EV/commercial)? ______
- Materials cost side: booked via the PO only, or also on the invoice? ______
- Tax: which tax zones/categories for service AR (we hold the AZ city table —
  does Acumatica compute tax again, and must the two agree to the penny)? ______
- Cash-basis sales tax reporting (flagged at discovery): does service AR feed that
  manual inquiry, and what does it need from us? ______
- **Service-plan subscription revenue** (Stripe, monthly/yearly): how should it
  book — monthly journal/summary invoice, per-member, deferred? Who decides? ______

### 2.4 Payments + reconciliation

- Heather's partner-payment flow: applied against the AR invoice by ______ ;
  cadence ______ . Is a twice-daily Sundial check against open invoices enough
  to mark tickets paid, or does she want a different trigger? ______
- Stripe payouts: who reconciles today's HCP-Stripe deposits (gross vs fees)?
  How should the NEW Stripe account's payouts/fees be booked? ______
- **Bridge period**: confirm Heather is OK hand-entering service AR for the first
  weeks post-go-live (punchlist #20). Weeks she'll tolerate: ______

### 2.5 The partner invoice document (2026-09-01 direction)

- 📎 A partner invoice as **Acumatica prints it today** — is that form acceptable
  for SunRun-style portal uploads as-is? What's missing (their WO number where?): ______
- Invoice numbering when Acumatica generates: keep Sundial's ticket-number scheme
  in a reference field, or adopt Acumatica's AR numbering as the number of record?
  (This decides how our invoice `Name` maps.) ______

### 2.6 Service POs + logistics

- Service material POs: same template-driven PO flow as Phase 1, or ad-hoc PO
  with vendor + lines? Must the PO reference the service job — where, given most
  service jobs won't be Acumatica Projects? ______
- Typical service PO vendors — same vendor set as solar, or service-specific? ______
- The **concurrent API call limit** (open since discovery — ask Julie/their VAR
  once more): ______ · Any OTHER integrations hitting Acumatica on a schedule we
  must avoid (times of day)? ______

---

## Part 3 — Estimate formatting

### 3.1 Samples first

- 📎 2–3 real HCP estimates: one simple (truck roll), one multi-line repair,
  one commercial. Ask: "what do you like / hate about each?"
- 📎 Any competitor's or dream example they admire.

### 3.2 Identity block

- Issued under which entity: Harmon Electric ☐ · Harmon Solar ☐ · depends on
  job type ☐ (rule: ______)
- AZ ROC license number(s) to print: ______ (required on AZ contractor docs)
- Logo file (SVG preferred) + brand colors — do we have finals? ☐
- Contact block: phone ______ · email ______ · reply-to for estimate emails ______
- Physical address to show: ______

### 3.3 Body content

- Line display DEFAULTS (per-line toggles exist, but what's the default?):
  unit prices shown ☐/hidden ☐ · quantities shown ☐ · materials itemized ☐ or
  as one "Materials" line ☐ · labor as hours ☐ or flat ☐
- Tax: shown as its own line ☐ · included in totals ☐ — and city rate visible? ☐
- Plan-member discount: shown as a labeled discount line ("Service Club –10%
  labor")? ☐ Wording: ______
- Scope/summary text: who writes it — office ☐ / tech ☐ / AI-drafted +
  office-edited ☐
- Photos on the estimate (e.g. the cracked panel)? ☐ How many max: ______
- Terms & conditions: printed in full ☐ · link ☐ — 📎 current T&C text + owner.
- Validity: "estimate valid for ______ days." What happens after — auto-expire
  status, or just stale?
- Deposit line: do any estimates require deposit-to-accept? Rule: ______
- Good/better/best options on one estimate — ever wanted? ☐ (changes the data
  model if yes — push on whether it's real)

### 3.4 Acceptance + delivery

- Customer accepts by: online Accept button ☐ · typed name/signature ☐ ·
  pay-deposit-to-accept ☐ · verbal logged by office ☐ (multiple OK — which
  combination and when?)
- After acceptance, the customer should see/receive: ______
- Email subject + body copy for the send and for the +3d/+5d reminders — draft
  live in the meeting or get Paige to own it: ______
- SMS copy (for when Twilio lands, ~160 chars): ______
- Internal approval: does any estimate need manager sign-off before sending
  (over $X? commercial?): ______

### 3.5 Variants

- Field estimates from the tech app: same template, or simplified? Anything a
  tech must NOT be able to change (prices? discounts?): ______
- Commercial estimates (Larry's world): same template or its own? ______
- Does the estimate become the invoice VISUALLY too (same layout, "Invoice"
  header), so customers see continuity? ☐

---

## End-of-meeting capture (2 minutes, every meeting)

- Decisions made (list): ______
- Artifacts promised, owner + date: ______
- Anything that changes existing design docs (flag for DECISIONS.md): ______
- Punchlist items closed while everyone's here (#5 board defaults, #19–21
  Julie/Heather, #22–23 gate dates): ______
