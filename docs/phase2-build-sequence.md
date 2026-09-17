# Sundial — Phase 2 Build Sequence & Go/No-Go Gates

> What ships in what order, what goes live incrementally, and where the explicit
> gates are. Governing constraint (Tim): **Harmon's service team can't be halfway
> between two systems for long** — so the plan runs Sundial in shadow alongside HCP
> per workstream, then cuts the whole team over in one short window, then
> decommissions.
>
> **References:** `docs/service-workflows.md`, `docs/dispatch-board-design.md`,
> `docs/pwa-architecture.md`, DECISIONS.md D-065. Durations are working estimates for
> sequencing, not commitments; stages overlap deliberately.

---

## Stage 0 — Prerequisites (start immediately; everything else queues behind these)

| Item | Owner | Status / lead-time risk |
|---|---|---|
| FullCalendar Premium license | Tim (purchase) | Small $, no negotiation |
| Harmon Stripe account keys (restricted) → Secrets Manager | Tim ↔ Julie | Account exists; keys + webhook secret needed |
| **Twilio account + number + A2P 10DLC registration** | Tim | **Longest lead time** — register now; SMS degrades to SES email until live |
| HCP export inventory (price book, customers, jobs, invoices, **attachments**) via Ben's login + MAX-plan API key (read-only) | Tim/Matt | Do while the account is friendly; gaps found here reshape Stage 5 |
| XFiles Pro config for `Sundial_Service__c` + `Sundial_Service_Visit__c` (`SUNDIAL/{record_id}/`) | Tim (SF console) | Can be done today |
| Salesforce deploy package from the two field workbooks (4 objects, FLS for integration user + portal perm set) | Claude Code → Tim deploys | Workbooks delivered 2026-09-01; verify draft-carried fields against a live describe first |
| Allowlist + cache tables (`service`, `visit`, `serviceline`, `serviceinvoice`) + `PARENT_FILTER` entries | Claude Code | One registry entry each + SQL files |
| Geocoding provider decision (AWS Location Service assumed) | Tim | Needed by Stage 3 (geofence), nice for Stage 2 |

## Stage 1 — Core service records (≈ weeks 1–3)

Objects live → cache → portal list/board/detail via the field-config generator →
phone intake flow → ticket lifecycle states → assignment notifications + My Queue →
price book surface seeded from the HCP export.

**Incremental live use:** office starts creating *real* tickets in Sundial in
**shadow** (HCP remains the system of record). Zero risk; builds familiarity and
seeds real data for the board.

**Gate G1 — office shadow sign-off:** office staff can take a real call end-to-end
(lookup with history, ticket, triage, quote from price book) without touching HCP for
the *intake* half. Blocking issues fixed before Stage 2 ships to users.

## Stage 2 — Dispatch board (≈ weeks 3–6, overlaps Stage 1 hardening)

Per `dispatch-board-design.md` §9: read-only board → tray + create → move/resize +
409 handling → Realtime → notify (email first).

**Gate G2 — THE go/no-go of Phase 2:** Beth schedules a **full real week** in
Sundial while HCP still runs, and the §1 parity table is walked line-by-line with
her. Her sign-off proceeds the cutover plan; her "worse than HCP" verdict stops the
clock and we fix before proceeding. Nothing downstream (PWA rollout, billing cutover)
goes live to the team before G2 passes.

## Stage 3 — Field PWA (≈ weeks 5–8, overlaps Stage 2)

Per `pwa-architecture.md` §9: read-only day view → clock/GPS online → offline
outbox → notes/checklists/gate → photos → field estimates → push.

**Incremental live use:** **two-tech pilot** (Larry + one tech) runs a full week
dual-entry (Sundial + HCP).

**Gate G3 — payroll parity:** the pilot week's per-tech, per-day time from Sundial
matches HCP/Exaktime within explained corrections, and Larry signs off on the daily
flow (gate, notes, photos). Time is payroll — this gate is not skippable.

## Stage 4 — Billing & payments (≈ weeks 7–10)

Lines + estimates (with reminder automation) → invoices (Bill-To, per-visit,
city-tax, PDF, partner download) → Stripe (SetupIntent card-on-file, hosted pay
links, off-session charge, webhook worker) → bulk mark-paid grid → PO-from-ticket
affordance → AI invoice summary (stretch — fallback is concatenated notes).

**Incremental live use:** office runs **parallel invoicing** on a handful of real
completed tickets (invoice built in both systems; Sundial's sent to a test
recipient), then flips small real charges with consenting customers.

**Gate G4 — money parity:** Beth signs off invoice content/totals/tax vs HCP output;
a real card saves and charges end-to-end in production Stripe; a partner PDF passes
the portal-upload check. Heather confirms the bridge process (bulk mark-paid) for
partner payments.

## Stage 5 — Migration & cutover (≈ weeks 9–12)

1. **Data migration** (`docs/migration.md` to be written off the Stage-0 export
   inventory): customers (dedupe against the 31.6k hub — email primary key, phone/
   address secondary, ambiguity queue for the office), job history → closed tickets
   (totals written directly, not via Flow), price book final sync, attachments per
   API availability (else scripted pull / accepted gap — decided at Stage 0, not
   discovered here).
2. **Card re-onboarding campaign:** cards in HCP's embedded Stripe don't transfer.
   Office campaign (email w/ save-card link + ask-on-every-call) starts **at G2
   pass**, so weeks of calls accumulate cards before cutover. Service-club members
   (~24) handled personally by Ben.
3. **Cutover week (one week, whole team):** Monday — intake + dispatch switch
   (HCP stops taking new jobs; open HCP jobs finish there or are re-keyed, office's
   choice per job); mid-week — all 7 techs on the PWA (pilot pair mentors);
   invoicing switches with intake. HCP goes **read-only reference** for 30 days.
4. **Gate G5 — decommission:** after 30 days: no lookups failing that need HCP, all
   in-flight HCP jobs closed, migration spot-checks pass, export archive (full CSV +
   attachment archive) stored in S3/Dropbox. Then the subscription is cancelled.

## Workstream S — Service Club e-commerce (parallel track, PULLED FORWARD 2026-09-01)

Harmon pulled this forward hard in the 9/1 meeting (it is why they bought HCP, it
never worked, and Ralph believes it sells "thousands"). Crucially it is **nearly
independent of the HCP cutover** — Stripe + hosted pages + webhooks + a customer
record — so it runs as a parallel track and can go live **before** the service module
itself:

1. Plan-purchase pages (Sundial-owned, linked from solarserviceclub.com): pick plan
   (Monitor / Maintain / Clean) → pay via Stripe subscription (monthly/yearly) →
   customer + subscription recorded, **team pinged**.
2. **On payment: webhook to SolarFacts' Zapier catch-hook** (they built it already;
   HCP just had no service-plan webhook to feed it) → customer immediately receives
   the white-labeled monitoring-signup link (self-enters APS/SRP creds).
   **On cancel/decline: same trigger in reverse** (stop SolarFacts, stop paying) —
   day one, cancel = request form that emails the team; automation follows.
3. Buy-a-truck-roll online ($275, pay now, office calls to schedule) + an "I don't
   know what I need — call me" service request (creates a ticket when the module is
   live; emails the team until then).
4. Plan discounts on service work: **labor / material / both, selectable** (HCP can
   only discount the whole job).
5. Small plans dashboard/report (active, sent, revenue — Beth reports on this).
6. Dependencies: Stripe keys (Stage 0), SolarFacts intro (Paige), page hosting.
   Ben personally migrates the ~24 existing members onto the new billing.

**Member self-service portal** (view subscription/receipts, update card, cancel) is
the new top-of-future-scope item from the 9/1 meeting — evaluate **Stripe's hosted
customer portal** first; it may cover card-update/cancel/receipts with near-zero
build. Not gate-blocking for Phase 2.

## Post-go-live increments (committed follow-ons, not gate-blocking)

Acumatica AR push (D-065.6 — bridge is the mark-paid grid + optional read-only
payment poll; **raised in priority 2026-09-01**: partner invoices should eventually
be *generated in* Acumatica with the PDF pulled onto the ticket, killing today's
manual double-entry of every invoice) · email AI intake worker (doorbell exists
earlier; AI parse can land here if time is tight — manual entry of emailed work
orders is acceptable at cutover; source mailbox `solarservice@harmonelectric.net`,
forwarding via Ryan/IT) · Twilio swap-in wherever email substituted · SiteCapture
deep link → **Zapier-based** integration (Tim's call 2026-09-01: no direct API) ·
NSA drip hand-off for stale estimates · monitoring-alert auto-tickets · travel-time
hints + tech map · review/referral/plan follow-up emails · member portal (above).

## Sequencing logic (why this order)

Intake/records first because everything renders from them and shadow use is
zero-risk. Board second because it is the crux risk — **G2 is deliberately early**
so a "revolt" verdict arrives with maximum runway. PWA third because it needs real
scheduled visits to be meaningful, and its gate (payroll) needs a calendar week.
Billing fourth because it depends on lines/visits and is the least reversible
(money) — it gets the longest parallel run. Migration last-but-started-early: the
export inventory is Stage 0 precisely so migration surprises can't ambush the
cutover date.

**Standing rule for every stage:** feature completion = PROGRESS.md + TASKS.md +
affected docs/ + DECISIONS.md per CLAUDE.md; nothing Harmon-specific lands in shared
backend code (per-tenant config list in service-workflows.md §12).
