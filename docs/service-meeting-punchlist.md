# Harmon Service Meeting Punchlist — answers that unblock the Phase 2 build

> **UPDATED 2026-09-01 after the Paige + Beth meeting** — [x] answered · [~] promised, awaiting delivery · [ ] still open.
> New scope from the meeting (service-club e-commerce pull-forward, member portal, invoice/receipt split, line-scoped plan discounts) is in `docs/service-discovery-2026-08.md` addendum.

> Take into the service-team meeting. Items 1–4 can be DONE live on the call.
> Sources: open items in docs/service-workflows.md, dispatch-board-design.md,
> pwa-architecture.md, phase2-build-sequence.md (Stage 0), D-065.

## Do LIVE on the call
1. [x] ~~Admin generates a read-only HCP API key~~ — Ben's login confirmed as top admin; Tim creating keys (My Apps → All Apps → API Key Management) → unblocks migration inventory.
2. [x] Customers + Jobs CSV exports running (test pass; re-run at go-live). Price book comes via API query (admin-only, emailed ~1 hr) and the **price book export**.
3. [~] Beth to SEND sample partner work-order emails (agreed on call) (AI intake parser is built against these).
4. [~] Paige to SEND EIN + legal name (Harmon Electric) + address; new 623 number OK: legal name, EIN, address, website (longest lead-time item in the phase).

## Beth — dispatch board + billing
5. [ ] Board working hours, granularity, default durations by service type (standard call = 2h; what else is known?).
6. [x] Notify-customer default = OFF, opt-in per action (Beth): off-with-opt-in per change, or on-for-new / off-for-moves?
7. [~] Beth to SEND the recurring-partner list (pullable from AR; partners live in HCP as ordinary customers) (SunRun + which leasing partners/manufacturers) → seeds picklist + partner invoicing.
8. [x] Warranty = layered + era-dependent (5yr labor/10yr workmanship current; 2yr on service work; ~20-25yr roof/stanchions) → informational on ticket, office decides; no automated determination: labor vs manufacturer determination; when does Harmon's own warranty expire (years by job type?).
9. [x] Invoice # = job # (one sequential series, no prefixes); ticket-number scheme approved expectations downstream (partner portals, Heather's AR)? Is 110/110-1 style expected?
10. [x] Estimate reminders: +3d and +5d then stop → hand off to Nonstop Automation drip; internal CC rejected. Cadence: every N days, stop after how many?

## Larry — PWA
11. [ ] Completion gate, exactly: notes + minimum photos (how many?) + checklist — any exempt job types?
12. [ ] Hand over the **actual checklists** (inverter RMA etc.) + which job type gets which → launch templates.
13. [ ] Geofence radius comfort (~500 ft proposed) + official shop address(es) valid for clock-in.
14. [ ] Confirm: multi-day job = each tech clocks a separate appointment per day (gives per-day time reporting).

## Paige / office
15. [x] solarservice@harmonelectric.net (M365 shared mailbox, Paige + team); Ryan (IT) will forward to Sundial intake; **who staffs the intake review queue**?
16. [x] Migrate as-is; Beth ticks removals on an exported sheet first; solar side + EV items only (electrical side is unused boilerplate)? Who owns it going forward?
17. [x] AZ only, statewide (every city); office needs self-serve add-a-city on the tax table (tax table scope)?
18. [~] Upgrade CONFIRMED done. Beth to SEND template→job-type mapping. Integration via Zapier, NOT direct API (Tim's call — no API creds needed); API credentials from the upgraded plan.

## Julie / Heather
19. [ ] Julie: Stripe **restricted keys + webhook signing secret**; account live for card-not-present.
20. [ ] Heather: OK hand-entering service AR into Acumatica for the bridge weeks? Partner-payment recording cadence (is twice-daily checking enough?).
21. [ ] Agree the card-on-file campaign starts at G2 pass — ask on every inbound call.

## Dates & people (book while everyone's in the room)
22. [ ] Beth's full **shadow week** on the dispatch board (the go/no-go — G2).
23. [ ] Second **pilot tech** alongside Larry for the payroll-parity week (G3).
24. [ ] Ben confirms he migrates the ~24 service-club members' cards/subscriptions personally.
25. [ ] Ralph: service-sales commission structure doc (shapes pipeline fields; not core-blocking).

## Still to chase (from the 2026-09-01 meeting)
- [~] Beth: partner list · SiteCapture template mapping · sample partner invoices · sample work-order emails.
- [~] Paige: EIN/legal/address (Twilio) · SolarFacts programmer intro (they have a Zapier catch-hook ready for the plan-purchase trigger).
- [ ] Ryan (IT): forwarding rule on solarservice@harmonelectric.net when Sundial intake is ready to receive.
- [ ] Items 5, 11-14, 19-25 remain open (Larry + Julie/Heather + gate dates were not on this call).
