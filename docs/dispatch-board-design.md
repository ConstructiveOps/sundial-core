# Sundial — Dispatch Board Technical Design

> The multi-tech drag-and-drop schedule for Service Operations. This is the crux risk
> of Phase 2: HCP's scheduler is a real dispatch board, and Sundial must match what the
> service team actually uses daily or the module fails on adoption.
>
> **References:** `docs/service-workflows.md` §5 (workflow contract),
> `docs/service-discovery-2026-08.md` (what Beth/Larry actually use),
> `docs/caching-architecture.md` (cache + realtime + always-fresh rules), DECISIONS.md
> D-065. Frontend work lands in harmon-crm; the API surface below lands in sundial-core.

---

## 1. What we are building (and honestly, what we are not)

### Day-one parity with what Harmon uses

From the walkthroughs, the parts of HCP's scheduler in daily use:

| Capability | Day one? | Notes |
|---|---|---|
| Multi-tech timeline (rows = techs), day + week views | ✅ | FullCalendar `resourceTimelineDay` / `resourceTimelineWeek` |
| Drag-and-drop from an unscheduled-jobs tray | ✅ | External-draggable tray, exactly Beth's flow |
| Proportional time blocks, edge-drag resize | ✅ | Native FullCalendar interaction |
| Duration defaulting from the job's services | ✅ | From service lines / per-tenant service-type defaults (standard call ≈ 2h) |
| Notify / don't-notify customer per action | ✅ | Modal on every create/move/resize; default per tenant. Email until Twilio, then SMS |
| Multiple appointments per job, weeks apart | ✅ | Visits under one ticket; tray shows return-visit-needed tickets |
| View-by-employee filter, manager layered view | ✅ | Resource filtering |
| Live board updates across viewers | ✅ | Supabase Realtime broadcast (see §5) |
| Travel-time suggestions | ❌ later | Requires geocoding + routing; see §8. Not observed in Harmon's daily use |
| Live GPS map of techs | ❌ later | Quartix (truck GPS) API investigation; techs use Find-My today |
| Route optimization | ❌ deferred | Explicitly deferred with Harmon in the 8/7 meeting |

The honest line for Harmon: **the board they touch every day is matched at go-live;
the map-and-routing extras follow.** Discovery supports this — neither Beth nor Larry
demonstrated or asked for travel-time suggestions; they did hammer per-action notify,
the tray, and per-tech blocks.

### Explicit non-goals

No auto-assignment, no capacity balancing (that's the Phase 3 install scheduler's
domain, D-006), no customer-facing booking (Phase 3).

---

## 2. Frontend composition (harmon-crm)

- **FullCalendar Premium** (license: Phase 2 blocker; key via `schedulerLicenseKey`,
  stored in frontend env — it is not a secret in the credential sense but comes from
  config, not code). Plugins: `resource-timeline`, `interaction`, `scrollgrid`,
  React connector.
- Views: `resourceTimelineDay` (default) and `resourceTimelineWeek`.
  `slotDuration` 00:30, `snapDuration` 00:15, business hours + visible range from
  per-tenant config.
- **Resources** = active techs: `Sundial_User__c` where role/access level marks them a
  technician (from `GET /sf/user`, cached). Row order per tenant config, then name.
- **Events** = visits in the visible window, colored by visit status
  (Scheduled/En Route/In Progress/Complete/Cancelled/No-Show) with priority accent
  (Emergency = red edge). Event render shows ticket number, customer name, city,
  service type; hover card adds address, phone, Bill-To, plan badge, other techs on
  the same ticket.
- **Unscheduled tray** (left rail): tickets in `Ready to Schedule` + tickets flagged
  needing a return visit, sorted by priority then age. Tray cards are FullCalendar
  external draggables; dropping one opens the confirm modal (tech, window, duration
  default, notify toggle) and creates a visit.
- **Multi-tech placement:** alt-drag (or "add tech" on the event menu) clones the
  block to another tech row as a sibling visit on the same ticket — windows may
  differ (techs arrive/leave independently).

---

## 3. API surface (new Lambda: `sundial-service-board`)

Portal-authenticated (Supabase JWT via `resolveIdentity`, tenant-scoped per D-035).
Routes follow existing API Gateway conventions; wire script per the `wire-*.ps1`
pattern.

### `GET /service/board?from=<iso>&to=<iso>`

One read for the whole board. **Cache-backed** (visits + tickets from Supabase cache,
15-min TTL per caching-architecture.md), joined server-side:

```json
{
  "techs":       [{ "id": "a0X...", "name": "Jake D", "order": 1 }],
  "visits":      [{ "id": "a1V...", "ticketId": "a1S...", "ticketNumber": "SVC-00123",
                    "techId": "a0X...", "start": "...", "end": "...",
                    "status": "Scheduled", "serviceType": "Paid Service",
                    "priority": "Standard", "customerName": "...", "city": "...",
                    "address": "...", "billToType": "Customer",
                    "modstamp": "2026-09-01T17:22:04Z" }],
  "unscheduled": [{ "ticketId": "a1S...", "ticketNumber": "SVC-00124", "priority": "High",
                    "ageDays": 2, "serviceType": "Warranty", "customerName": "...",
                    "city": "...", "defaultDurationMin": 120, "returnVisit": false }]
}
```

`modstamp` (Salesforce `SystemModstamp`) is the concurrency baseline (§4). Window is
capped (≤ 31 days) — at 150–230 tickets/month the payload is trivially small.

### `POST /service/visits`

Create from a tray drop: `{ ticketId, techId, start, end, notifyCustomer }`. The
Lambda **reads the ticket fresh from Salesforce** (always-fresh rule for scheduling
commits), validates state (`Ready to Schedule` / `Awaiting Parts` / already
`Scheduled` for sibling adds), creates the visit, advances ticket status, updates
cache, broadcasts, and (if `notifyCustomer`) enqueues the notification. Returns the
created visit with its `modstamp`.

### `PATCH /service/visits/{id}`

Move / resize / reassign: `{ start?, end?, techId?, status?, notifyCustomer,
baseModstamp }`. Behavior:

1. Fresh read of the visit from Salesforce.
2. If `SystemModstamp ≠ baseModstamp` → **`409 VISIT_CONFLICT`** with the current
   server state in the body. Nothing is written.
3. Otherwise write (shared `sfUpdateRecord`), update cache, broadcast, notify.

Guards: no rescheduling a visit that is `In Progress`/`Complete` (409
`VISIT_ALREADY_STARTED`); cancelling requires a reason; cross-tenant ids are 404 per
the standing contract.

### `POST /service/visits/{id}/cancel` — status → `Cancelled` (+ reason, notify
option); if it was the ticket's only open visit, ticket returns to
`Ready to Schedule` (or `Awaiting Parts` if flagged).

**Allowlist additions** (`sundial-sf-query` / `sundial-sf-update` /
`sundial-cache-sync` / `PARENT_FILTER`):

| Public name | Object | Cache table | parentId |
|---|---|---|---|
| `service` | `Sundial_Service__c` | `sundial_service_cache` | `Sundial_Customer__c` |
| `visit` | `Sundial_Service_Visit__c` | `sundial_service_visit_cache` | `Sundial_Service__c` |
| `serviceline` | `Sundial_Service_Line__c` | `sundial_service_line_cache` | `Sundial_Service__c` |
| `serviceinvoice` | `Sundial_Service_Invoice__c` | `sundial_service_invoice_cache` | `Sundial_Service__c` |

Cache tables follow the standard pattern (`sf_id`, `client_sf_id`, `tenant_id`,
display columns via `sfFieldToColumn()`, control columns); SQL files go in `sql/`.
Service-object TTL is already specified at **15 minutes** in caching-architecture.md.

---

## 4. Concurrency model

**Optimistic, with the server as referee.** Rationale: Harmon has one primary
dispatcher (Beth) with occasional secondary users — conflicts are rare, so locking or
reservation protocols buy nothing and cost UX. What matters is that a conflicting
write is *detected*, never silently clobbered:

- Every board mutation carries the `baseModstamp` it was rendered from.
- The Lambda's fresh Salesforce read (mandatory for scheduling commits, cache
  explicitly bypassed) is the arbiter; mismatch → 409 + current state.
- On 409 the board updates the affected event/tray card from the response and toasts
  *"This visit changed since you loaded it — take another look."* The dispatcher
  re-drops. No merge logic, no lost work beyond one drag.
- Realtime keeps second viewers current (§5), which is what makes 409s rare in
  practice even with two dispatchers.

This is deliberately simpler than a booking system's pessimistic locks. If Harmon
ever runs 3+ concurrent dispatchers over a dense board, revisit — the 409 contract
stays; only the client ergonomics would change.

## 5. Cache, realtime, and freshness

- **Reads** (board load, pan, refetch): cache-first via `GET /service/board`. A stale
  board can only cause a 409, never a bad write.
- **Writes:** Salesforce first → cache update → **Realtime broadcast** on
  `tenant:{tenantId}:sundial_service:list` (the channel caching-architecture.md
  reserved for exactly this), payload = the changed visit/ticket in board shape, so
  other viewers patch local state without a round trip. Sender: `lib/realtime.js`
  (built for Welcome Call, D-054 — the board is its second consumer; note
  `sundial-sf-update` still only flags `is_stale`, so board writes go through the
  board Lambda, not generic `PATCH /sf/...`).
- **PWA events surface on the board:** the field sync worker broadcasts on the same
  channel when a clock event changes visit status — the dispatcher sees En Route /
  In Progress in near-real-time, which replaces most of the "where is everyone" value
  of a GPS map on day one.
- **Fallbacks:** refetch on window focus + on Realtime reconnect; 15-min TTL bounds
  staleness if the socket silently dies. A cache ghost (deleted visit, D-051 blind
  spot) self-corrects on the next board commit touching it; the reconcile runbook
  covers bulk cases.

## 6. Notifications from the board

Create/move/resize/cancel with `notifyCustomer: true` enqueues (SQS, best-effort,
never fails the scheduling write — standing convention) a message through the
notification worker: SMS via Twilio when live, SES email fallback until then.
Templates per tenant; contents: window, tech first name, manage/contact line. The
default toggle state is per-tenant config; the dispatcher's last choice is sticky per
session.

## 7. Performance and limits

Volumes are small (7 techs, ~10 visits/day, 31-day window ≈ low hundreds of events)
— FullCalendar and the Lambda layer are nowhere near limits, and the concurrency
quota is confirmed at 1000 (2026-09-01). The board polls nothing; it is
Realtime + refetch-on-focus. One caution inherited from G2: keep board reads to the
single aggregate endpoint rather than N per-object calls.

## 8. Later increments (explicitly out of day-one scope)

1. **Travel-time hints:** needs geocoded service addresses (geocode at ticket
   creation — AWS Location Service fits the stack; also feeds geofence, see PWA doc)
   + a routing call between consecutive blocks per tech. Render as gap badges.
2. **Tech map:** Quartix API (truck GPS) or last-clock-event pins.
3. **Density features:** week heat view, capacity counters — revisit after real use.

## 9. Build order (within this workstream)

1. Allowlist + cache tables + `GET /service/board` → **read-only board** in portal.
2. Tray + `POST /service/visits` + confirm modal (notify stubbed to email).
3. Move/resize/reassign + 409 handling.
4. Realtime broadcast + PWA status surfacing.
5. Notify pipeline (email → Twilio swap when provisioned).

Gate for go-live sign-off: **Beth schedules a full real week in Sundial while HCP
still runs**, and the parity table in §1 is walked line-by-line with her. Her
sign-off is the go/no-go — see `docs/phase2-build-sequence.md`.
