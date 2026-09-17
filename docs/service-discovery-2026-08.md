# Service Operations — Discovery Digest (HCP Scoping Meetings, July–Aug 2026)

> Distilled from three recorded scoping meetings with Harmon's service department.
> This is the primary requirements input to `docs/service-workflows.md`, the service
> field designs, the dispatch board design, and the PWA architecture note.
> Attribution notes who said it, so follow-ups have an owner.
>
> Sources:
> - **2026-07-29** (1h04) — Ben Wollschlager (service club, monitoring, bill evaluations), Ralph Romano (service dept leadership), Tim + Matt Murphy
> - **2026-08-03** (1h00) — Paige King + Beth (in-house service manager: dispatch, invoicing, price book), Tim + Matt
> - **2026-08-07** (54m) — Larry Aegerter (field service manager, tech app walkthrough), Paige, Tim + Matt

---

## Who does what (roles map)

| Person | Role | Systems touched |
|---|---|---|
| Beth | In-house service manager. Owns the schedule, dispatch, invoicing, quoting authority, truck-roll authority, price book, collections | HCP desktop, Acumatica (POs) |
| Larry Aegerter | Field service manager. Runs the techs, uses the tech app daily, does field estimates | HCP mobile app, SiteCapture |
| Paige King | Ops/admin lead. Invoice/price-book admin, SiteCapture account (recently upgraded), reporting (uses Claude) | HCP desktop |
| Ben Wollschlager | Service club + monitoring + bill evaluations. Handles solarserviceclub.com signups manually (on call 24/7 for them) | HCP, SolarFacts, utility portals |
| Giovanna ("Geo") | Front-line intake / call center | HCP + Sunbase (only rep with Sunbase access) |
| Ellen / Alan | Back-end HCP admin | HCP |
| Heather | AR — records partner payments | Acumatica |
| Julie | Owns Harmon's Stripe account; tax topics | Stripe |
| Ralph Romano | Service dept leadership. Wants sales/ops split with commissioned service sales reps | — |
| Dan (owner) | Wants techs to be more sales-forward in the field | — |
| Techs | Jake, Vinny, Chad, Mario, Dalton/Benny + others (7 on HCP) | HCP mobile app, SiteCapture (commercial) |

**Key structural fact:** two service managers — Beth (in-house) and Larry (field). Beth is the dispatcher.

---

## Current state — how a service call flows through HCP today

1. **Intake.** Call comes in → intake Q&A (own or lease? background info) → entered as a **Lead** in the HCP pipeline. Call center reps other than Geo have no Sunbase access, so history questions ("did we install this?") often go unanswered or unasked.
2. **Lead → Job or Estimate.** Standard calls are quoted verbally from known rates (truck roll = **$275**) and go straight to a job. Complex quotes become an **Estimate** (goes to a separate board), sent by text + email with **automated reminders every 2–3 days** until accepted — a feature they love and credit with saving jobs ("before, things were written on paper and never followed up").
3. **Scheduling.** Jobs land in an unscheduled list; Beth drags them onto a multi-tech schedule (view-by-employee). Block size comes from the services on the job (standard call ≈ 2-hr window). Every schedule change offers **notify / don't-notify customer**.
4. **Field.** Tech sees assigned work orders in the app. "On my way" texts the customer and *stops the clock on the previous job / starts the next* (drive time bills to the destination job). Start time → work → notes (Summary of Work = customer-facing; Private Notes = internal) → photos → checklist (office-assigned per job type; required items gate job completion) → finish. SiteCapture used on **all commercial** service/O&M; skipped on most residential (two-app friction).
5. **Post-field.** Office (Beth) reviews notes, builds the invoice (summary of work merges onto it, toggles for line/unit/materials detail), sends by email with PDF + Stripe pay link — or, for partners, **downloads the PDF and uploads it to the partner's portal**. Payment via HCP's built-in Stripe.
6. **Multi-visit jobs.** HCP "appointments" within one job (job 110 → invoice 110-1 per appointment). Techs clock per appointment. Appointments can be **billed to different parties** and invoiced separately or combined.

---

## Requirements by area

Legend: **[MUST]** = day-one or the module fails · **[WANT]** = strongly requested, ship in Phase 2 if cheap · **[LATER]** = acknowledged future scope.

### Intake & pipeline

- **[MUST]** Lead-like intake record with the standard Q&A fields; convertible to ticket or estimate without re-entry. Minimum required fields to save a customer: first name, last name, address, phone (email optional — some customers have none). *(Paige/Beth 8/3)*
- **[MUST]** Third disposition beyond won/lost: **"Resolved — no opportunity"** (helped over the phone). Won/lost-only wrecks their KPIs. *(Beth 8/3)*
- **[MUST]** Show Harmon history at intake: "this address has a Harmon solar project" with specs/photos — enables troubleshooting without a truck roll and stops flying blind. *(Ben 7/29 — direct payoff of the Customer + Solar link on tickets)*
- **[MUST]** **Internal assignment notifications.** HCP has none and it's a constant failure ("I never know Beth assigned me something"). Want a notification + a personal to-do/queue view ("you have 4 things in the pipeline"). *(Beth/Paige 8/3)*
- **[WANT]** Estimates with **automated customer reminders** (every N days until accepted) — keep the one HCP feature they love. Email first (SES live); SMS when Twilio lands. Later: suppress auto-follow-up if a sales rep touched it within X days; alert a manager when items sit too long. *(Ben/Ralph 7/29)*
- **[LATER]** Ralph is splitting service **sales** from ops with commissioned service sales reps working the pipeline. Commission structure TBD from Ralph. Design the pipeline so a rep can own an estimate/lead.

### Billing model (the deepest structural findings)

- **[MUST] `Bill_To` is a first-class, changeable field** — homeowner vs Harmon warranty (internal) vs manufacturer (RMA) vs leasing partner (SunRun etc.). Parent/child billing relationships. It changes mid-ticket ("service call billed to customer, inverter swap billed to manufacturer"). *(Paige/Beth 8/3)*
- **[MUST] Billing party can differ PER VISIT under one ticket.** Larry: appointment 1 billed to the customer, appointment 2 to the manufacturer; HCP invoices per appointment (110-1) or combined, selectable. → Bill-To default on the ticket, overridable per visit; invoice = one visit, several, or the whole ticket. *(Larry 8/7)*
- **[MUST] `Billing_Reference__c`** — partner's PO/work-order number (SunRun sends 10 work orders/week with their numbers). Must print on the invoice **and be searchable**. *(Paige/Beth 8/3)*
- **[MUST]** Partner invoices are **not emailed** — PDF download for upload to partner portals. *(Beth 8/3)*
- **[MUST]** Wrong-party invoicing is a named failure mode: leasing-partner customers receiving direct invoices causes "freak-out moments." Bill-To must drive who receives what.
- **[MUST]** Payment status reconciliation:
  - Stripe payments (direct customers) mark the invoice paid automatically (webhook).
  - Partner payments are recorded by Heather **in Acumatica** and never flow back — HCP shows ~800 phantom open invoices. Want a scheduled Acumatica payment check (start/end of day) against open partner invoices, plus a **bulk mark-paid grid** for AR. *(Beth/Paige 8/3 — fits the "AR sync after go-live" decision; the scheduled payment-check GET may come earlier since it's read-only)*
  - Never dun a customer who just paid.
- Warranty determination: labor warranty vs manufacturer warranty → customer pays nothing, appropriate party billed (RMA flow). "Harmon warranty" billed internally until warranty period lapses.

### Price book, estimates & line items

- **[MUST]** Categorized price book (electrical/solar → install/repair → solar/EV/other), office-editable, **add-ad-hoc-line-then-save-to-price-book** flow preserved (they build it as they go and love that). Mass import/export. *(Beth/Paige 8/3; export of current HCP price book planned via Ben's login)*
- **[MUST]** Tickets/estimates/invoices carry **line items** from the price book (services + materials), with show/hide toggles on the customer-facing invoice (unit prices, materials detail, tech name).
- **[MUST] Tax rate defaults from the service address city (AHJ)** — HCP defaults to Apache Junction and they hand-fix every invoice. City rate table already exists in the roofing budget work; make it per-tenant config. *(Beth — "please make that happen")*
- **[WANT]** Field estimates: techs build an estimate from the same price book **in the app** and send it on-site ("do you want us to come back and fix this?"). Explicitly wanted **sooner than** field invoicing. *(Larry 8/7)*
- **[LATER]** AI-assisted line descriptions (HCP's "write it for me"), deeper category taxonomy, AI-quoted standard repairs at intake.

### Dispatch board

- **[MUST]** Multi-tech day/week timeline, drag-and-drop from an **unscheduled jobs list**, block length from the job's services, view-by-employee. *(Beth's daily surface)*
- **[MUST] Notify / don't-notify customer toggle on every scheduling action.** HCP texts the customer on every 5-minute nudge; suppression per-action is non-negotiable. *(Beth 8/3)*
- **[MUST]** Multiple appointments (visits) per ticket, scheduled days/weeks apart (awaiting parts, RMA returns) — ticket pauses without nagging, resumes cleanly.
- Concurrency reality: **Beth is effectively the single dispatcher** (Paige/Larry secondary). Read-fresh-on-commit + last-write-wins with a conflict toast is sufficient; no need for heavier locking. *(Confirms Tim's "1–2 dispatchers" answer)*
- **[LATER]** Route optimization (asked by Beth via Paige; explicitly deferred in the meeting — scheduling windows are tight, so it would have to move appointments). Truck GPS map (Quartix — check API) or phone-location map of techs; per-clock-in location tags cover most of the need day one.

### Tech PWA

- **[MUST] Per-tech clock in/out.** THE three-year pain point, on every app they've used: one tech ending a job stops everyone's clock. Each tech clocks their own time per visit; ticket totals = sum. *(Larry 8/7, Beth 8/3 — confirms the parallel-visits model)*
- **[MUST]** Time is **payroll AND billing** — per-tech, per-visit, per-day granularity (HCP lumps a 3-day job into "20 hours" with no per-day split; drives Beth nuts).
- Drive-time convention: first clock-in of the day at first job (or shop if picking up material); "on my way" ends the previous job's clock and starts the next (drive time bills to the destination job); day ends when tires roll away from the last job; >1hr out-of-town handled ad hoc.
- **[MUST] Completion gate:** can't start the next job until the current one has required notes, photos, and checklist complete ("finish your work order" — hounding techs for paperwork is a daily failure). Multi-day jobs pause without triggering the gate. End-of-day / next-morning reminder for unclosed single-day jobs.
- **[MUST] No tech self-edit of time logs.** HCP lets techs edit their own hours (a tech discovered it). Corrections go through a manager/office role on desktop. *(Larry + Paige aligned)*
- **[WANT]** Geofence as **tag, not blocker**: record location at clock in/out so the office can see where the tech actually was; shop counts as a valid start location; "looks like you left the job — clock out?" push reminder if feasible.
- **[MUST]** Notes model:
  - **Work notes** (customer-facing candidates) vs **private notes** (internal: "angry customer, mean dog") — two feeds.
  - **Append-only entries, auto-stamped with user + date/time** (Larry manually types "LA 8/7" today). Authors may edit their own entries only.
  - **AI summarization at invoice time:** compile the tech note entries into one clean customer-facing paragraph on the invoice; Beth reviews/edits before send. *(Paige asked for exactly this, enthusiastically)*
- **[MUST]** Photos: capture in-app or from camera roll, timestamped, tied to the visit/ticket.
- **[MUST]** Checklists: office-assigned templates per job type at ticket/visit creation (e.g. inverter RMA: photo old serial, photo new serial, internet check, call Tesla), required items gate completion. Simple generic checklist when no template fits ("pick up your tools").
- **[MUST]** Show on the job card: which techs are assigned (they rely on it), customer info, address with a maps link (Apple + Google), **service plan status badge** (color-coded, "front and center").
- **[WANT]** Manager view: all techs' schedules layered (Larry uses this; permission-gated).
- Keep it simple — "the more basic it is, the better. My guys live in this world." Job fields/tags/etc. unused.

### SiteCapture

- Used on **all commercial** service; skipped on residential because it's a second app. Paige **upgraded the SiteCapture plan** (API access now available — this changes the Phase 1 "no API on basic plan" assumption, D-013).
- **[WANT]** Day one: deep-link the ticket's SiteCapture project from the PWA. **[LATER]** Real integration: auto-create SiteCapture project per ticket from a template by job type, pull the report PDF back onto the ticket's files. *(Paige is keen; report currently lives only in SiteCapture and office can't find it from the job)*

### Payments & Stripe

- Harmon **already has its own Stripe account** (Julie owns it) — separate from HCP's embedded Stripe where today's cards live. Card re-onboarding at cutover confirmed as expected by Harmon.
- **[MUST]** Card on file per customer (Stripe-vaulted, SetupIntent; hosted/iframe entry — office keys it on the phone with the customer, or customer receives a "add your card" link). Charge off-session after office review. Show card-on-file status to office AND tech.
- **[MUST]** Invoice email = summary + PDF + pay link (Stripe hosted). Customer can view past invoices (HCP has a mini customer portal; nice-to-match, not day one).
- **Techs do not collect payment** near-term ("our techs are not bill collectors" — Beth/Paige; Larry's techs don't use invoice/pay buttons at all). Field **estimates** first; field invoicing/payment later behind a flag (Dan wants techs more sales-forward eventually).
- **[LATER]** Service-plan subscriptions through Harmon's Stripe (see below).

### Service plans & monitoring (mostly Phase 3 / add-on, but shapes Phase 2 schema)

- Service club today: ~24 members, monthly or yearly. Signup flow is a manual nightmare Ben handles 24/7 (website → HCP text → find customer → attach plan → send invite → customer finally pays). Monitoring provisioning in SolarFacts is fully manual; payment lapses/cancellations aren't detected; Ben manually reconciles.
- **Phase 2 must carry:** service-plan status on the customer (badge in portal + PWA), plan as a factor in triage/billing, Stripe customer + subscription IDs on the customer record.
- **[LATER]** Self-serve plan purchase (website + tech-sent SMS link with optional discount), Stripe subscription automation (dunning, decline → notify → auto-cancel monitoring), SolarFacts API integration (SolarFacts = Solar Data Pros, Leroy Kaufman / Brad Hurtle, ~4 people, open-ish API, intro promised by Ralph), monitoring alert digest → auto-ticket (SolarFacts emails a daily 2pm at-risk report to a distro only Ben reads), review/referral/plan-upsell follow-up emails after every closed ticket, Ben's bill-evaluation worksheet as a structured tool.
- Ben's estimate: **~89% of inbound service calls are real issues** (sales opportunity), not billing complaints — utility bill redesigns (APS/SRP) cut the high-bill call volume.

### Migration & access notes

- Matt has **Ben's HCP login** (account is at its seat limit; Harmon fine with shared use for read/export). Price book export planned. Use it for: price book, customers, jobs history, and to inventory what the MAX-plan API exposes (attachments especially).
- Manufacturer/inverter mix for asset context: SolarEdge era → Enphase era → now Tesla-heavy. Matters for warranty/RMA flows and monitoring portals.

---

## Design implications for Sundial (deltas against prior decisions)

1. **Bill-To moves into the schema at both levels.** Ticket: `Bill_To_Type__c` (Customer / Harmon Warranty / Manufacturer / Leasing Partner / Other) + `Bill_To_Account__c` (or name fields) + `Billing_Reference__c` (indexed). Visit: optional override of the ticket default. Invoicing selects visits.
2. **Line items are a new object** (`Sundial_Service_Line__c` or similar): child of ticket, optional link to visit, product lookup (Pricebook), qty/price/taxable, `Usage__c` = Estimate vs Invoice (or separate status), show-on-invoice toggle. This also carries the estimate flow — no separate Estimate object needed.
3. **Estimate is a ticket state, not a new module:** intake → (optional) Estimate Sent → Approved → Scheduled. Automated estimate reminders = the notification engine's first customer-facing job.
4. **Tickets need an intake disposition** (`Resolution__c`: Completed / Resolved Remotely — No Charge / Lost / Cancelled) so phone-resolved calls don't pollute won/lost.
5. **Assignment notifications + "my queue"** in the portal are Phase 2 scope (extends the existing notification/comment infra; assignment lookup on ticket + estimate).
6. **Dispatch board contract** gains: unscheduled-jobs tray, per-action notify toggle, block duration from line items/service type. Concurrency: single-dispatcher reality → fresh-read on commit + conflict toast.
7. **Visit completion gate + append-only stamped notes + manager-only time corrections** go into the PWA spec. Notes = child records (or structured JSON), never one mutable text blob.
8. **AI invoice summary** (tech notes → customer paragraph, office-editable) — flag as Phase 2 stretch or first add-on service; Harmon explicitly wants it.
9. **Tax-by-city** from per-tenant rate table at invoice build.
10. **PO-from-ticket** is cheap and high-value: `Sundial_PO__c` already has `Linked_Service_Ticket__c` and the Acumatica PO push exists from Phase 1. Beth's double-entry pain disappears almost for free.
11. **Twilio becomes a Phase 2 prerequisite** (4th blocker alongside FullCalendar/Stripe/HCP export): on-my-way texts, schedule notifications, estimate reminders. Email fallback via SES until provisioned.
12. **SiteCapture**: D-013's "no API" premise is stale — plan upgraded. Keep integration out of core scope but design ticket file/checklist surfaces so the deep-link lands day one and the API integration can bolt on.

## Open items to chase

- [ ] Ralph: service-sales commission structure (affects pipeline/rep fields, not core build).
- [ ] Julie: Stripe account access/keys (restricted keys → Secrets Manager).
- [ ] Heather/Julie: how partner payments should reconcile (Acumatica polling cadence, invoice numbering across per-visit invoices).
- [ ] HCP via Ben's login: price book export; API inventory (customers, jobs, invoices, estimates, **attachments**); volume counts for migration.
- [ ] Quartix (truck GPS) API — later map integration.
- [ ] SolarFacts (Leroy Kaufman) intro — later monitoring integration.
- [ ] Twilio provisioning (Constructive-owned, per cost-absorption model) + A2P 10DLC registration lead time.
- [ ] SiteCapture upgraded-plan API docs.

---

## Addendum — 2026-09-01 punchlist meeting (Paige + Beth, 1h17)

Fourth scoping call, run against `docs/service-meeting-punchlist.md`. Answers below are settled unless marked pending.

### Punchlist answers

- **HCP access:** Ben's login IS the top admin level — API key + full exports are unblocked. Customers/jobs CSV exports being run now to test field mapping (re-run at go-live for current data).
- **Notify-customer default: OFF, opt-in per action.** *(Beth — confirmed)*
- **Bill-To partners:** partners live in HCP as ordinary customers with a "bills to" field — no way to filter them out of the dump. **Beth emails the recurring-partner list** (she can pull it from AR). *(pending Beth)*
- **Warranty:** era-dependent and layered — current installs: **5-yr labor + 10-yr workmanship**; Harmon-installed roof ≈ 25 yr; stanchions/penetrations ≈ 20 yr even on non-Harmon roofs; **service work carries a 2-yr warranty**; older installs had shorter terms. → Warranty is **informational context on the ticket, not an automated determination**; office decides, defaults shown from the linked project where known.
- **Invoice numbers:** HCP invoice # = job # (one sequential series, no per-department prefixes). Sequential ticket numbers with invoice = ticket number (suffix -2, -3 for additional per-visit invoices) is approved.
- **Estimate reminders: follow-ups at +3 days and +5 days, then stop** (HCP's 1-day option judged too pushy; they never had any toggled on). After the 5-day reminder with no response, **hand the estimate off to Nonstop Automation's drip campaign** as a recycled lead (NSA is building service-side drips). Internal CC on reminders was considered and **rejected** (inbox flooding).
- **Partner work-order inbox:** `solarservice@harmonelectric.net` — Microsoft 365 **shared mailbox** (Paige + team). **Ryan (IT)** sets up forwarding to the Sundial intake address. SolarFacts' daily monitoring digests will also route here (currently go to Ben personally).
- **Price book:** migrate as-is; we export to a spreadsheet first and **Beth ticks rows to drop** before import. The HCP "electrical/home services" side is unused boilerplate **except the EV items Paige added** — migrate solar side + EV only.
- **Tax scope:** Arizona only, but statewide — every city. Office needs a way to add a missing city rate themselves.
- **SiteCapture:** upgrade confirmed done (2 weeks ago). Few service-side templates; **Beth sends the template → job-type mapping**. *(pending Beth)* Tim's call on the integration: **Zapier, not direct API** — no API credentials needed.
- **Twilio:** new number is fine (aim for the 623 area code — Harmon's is 623); **Paige sends EIN + legal name (Harmon Electric) + legal address** for A2P. They've been burned by spam-flagging before, so registration is understood and valued. *(pending Paige)*
- **Partner invoice samples:** **Beth sends real SunRun-style partner invoices + the triggering work-order emails.** *(pending Beth)*
- **SolarFacts:** **Paige makes the intro to their programmer.** SolarFacts already built a **Zapier catch-hook** for exactly this flow (it died only because HCP has no service-plan webhook). White-labeled as Harmon; monitoring alert = no reporting for 48h → SolarFacts + Harmon + customer all alerted. *(intro pending Paige)*

### New/changed scope out of this meeting

1. **Service-plan e-commerce is pulled forward — "immediately."** This was the reason Harmon bought HCP and it never worked (booking widget only creates estimates; buyers can't pay). Committed shape, kept deliberately simple: solarserviceclub.com button → Sundial-owned pages → pick plan (Monitor / Maintain / Clean; Protect coming) → pay (Stripe subscription, monthly or yearly) → customer + subscription created, **team pinged**, and a **webhook fired to SolarFacts' Zapier** so the customer immediately gets the monitoring-signup link (they self-enter APS/SRP creds + optional inverter details). **Cancellation/decline fires the same trigger in reverse** (stop SolarFacts, stop paying). Also wanted on the same pages: **buy a truck roll online** ($275, includes ~1.5h tech time — pay now, office calls to schedule) and an "I don't know what I need — call me" service-request option. Online *scheduling* stays out (Phase 3). Key architecture note: **this workstream is nearly independent of the HCP cutover** — Stripe + pages + webhooks + a customer record — so it can ship early and win goodwill (Ralph: "he could sell thousands").
2. **Member self-service portal — new future-scope item, ranked top-2** by Matt: members view subscription/receipts, update card, cancel. Day-one bridge: cancel/change = a request form that emails the team. (Design note: Stripe's hosted **customer portal** may cover card-update + cancel + receipts nearly for free — evaluate before building anything custom.)
3. **Invoice philosophy sharpened (customer vs partner):**
   - **Customers rarely want invoices.** The real flow: pretty **estimate/quote** up front → pay (link or card on file) → **receipt + job report** (photos + tech-notes summary — HCP has this and they use it). Customer-facing "invoice" is effectively the receipt.
   - **Partners require an invoice document** uploaded to their portal — and it doesn't need to be pretty. Matt's direction: once the Acumatica AR push exists, **generate the partner invoice IN Acumatica and pull its PDF back onto the ticket's Files tab** for Beth to download/upload — killing the "fake invoice in HCP + real invoice re-keyed into Acumatica" double-entry that exists today (every HCP invoice is manually duplicated into Acumatica; payments are received only in Acumatica; hence 505 phantom open invoices in HCP).
   - **Mark-paid-without-collecting confirmed** as a requirement (partner ACH payments), plus reporting on that revenue.
   - Edge: occasional **deposits** (e.g. $10k up front on removal/reinstall, work months later) are opened directly in Acumatica today — handle as a billing edge case in the AR design.
4. **Plan discounts must be line-kind-scoped.** HCP discounts the whole job (forcing 20% markups to give 10% off). Requirement: discount **labor only, materials only, or both, selectable** — maps directly onto `Sundial_Service_Line__c.Kind__c`.
5. **Plan reporting:** Beth reports on plan revenue/active/sent counts — the e-commerce workstream needs a small plans dashboard (or report) from day one.
6. **Price book "electrical side"**: unused except EV; commercial EV charger O&M plans exist (1–2 customers) — commercial plans stay out of the residential e-commerce flow.

### Their to-dos (chase list)

Beth: partner/bill-to company list · SiteCapture template → job-type mapping · sample partner invoices · sample partner work-order emails. Paige: EIN/legal name/address (Twilio A2P) · SolarFacts programmer intro. Ryan (IT): forward `solarservice@harmonelectric.net` to the Sundial intake address (when we're ready to receive).
