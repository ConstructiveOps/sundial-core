# Sundial — Field PWA Architecture (Offline, GPS, Sync)

> How the tech-facing mobile app keeps working in a driveway with no bars, and how its
> data gets home safely. Covers offline strategy, the sync engine and conflict policy,
> clock/GPS/geofence mechanics, photos, and the failure-mode catalog.
>
> **References:** `docs/service-workflows.md` §8–§9 (field-work contract),
> `docs/dispatch-board-design.md` (board interplay), DECISIONS.md D-065 (esp. .2
> visit/clock model, .10 time-edit and geofence policy), D-004 (PWA choice).
> Frontend lands in harmon-crm (`/field` route, installable PWA); the sync API lands
> in sundial-core.

**Design principle (from Tim's brief):** *a tech standing in a customer's driveway
with no bars still has to be able to work.* Every field capability below is
offline-first; connectivity improves freshness, never gates capture.

---

## 1. Shape of the app

- Installable PWA (manifest + service worker), Safari Add-to-Home-Screen on the
  techs' iPhones. Same harmon-crm codebase, dedicated `/field` shell (bottom-nav,
  big-target UI — "the more basic it is, the better").
- Serves **all visit types** (Service / Solar Install / Roofing Install / Commercial
  Install) off `Visit_Type__c` per D-027; Phase 2 ships the Service experience, and
  install crews inherit the shell later.
- Tech sees: today + upcoming assigned visits ("Service Calls"), each with customer
  info, maps link (Apple/Google), other techs on the job, Harmon install context
  (linked Solar project), **service-plan badge**, card-on-file status, notes, photos,
  checklist, and the estimate builder.

## 2. Offline strategy

### 2.1 The day pack (reads)

On login/refresh (and on push-triggered schedule changes), the app prefetches into
IndexedDB a **day pack**: the tech's visits for today + next N days (default 3) with
their tickets, customer contact/address, linked-project context, checklist templates,
notes, photo manifests, and a **price-book subset** (for offline estimate building).
The service worker caches the app shell (versioned, update-on-reload).

Staleness is displayed, not hidden: each visit card shows "updated 7:42 AM"; a pack
older than a per-tenant threshold shows an offline banner. The PWA reads through the
normal portal API (cache-backed) — no special read path.

### 2.2 The outbox (writes)

Every field mutation is a **command**: `{ commandId (client UUID), visitId,
type, payload, occurredAt (device time), gps }`. Commands are appended to an
IndexedDB outbox, applied **optimistically** to local state immediately, and synced
FIFO when connectivity allows (Background Sync where available; foreground retry
loop otherwise).

Command types (Phase 2): `clock_in`, `clock_out`, `on_my_way`, `add_work_note`,
`add_private_note`, `edit_own_note`, `checklist_set`, `photo_meta`,
`add_estimate_line`, `send_estimate`, `complete_visit`.

**Techs never create visits or tickets offline** — dispatch creates visits
server-side. Everything the field writes is a child of an ID the day pack already
holds, which is what makes offline creation safe without client-generated Salesforce
IDs. (Offline-built estimate lines carry client UUIDs; the server returns the SF id
mapping at sync.)

### 2.3 The sync endpoint — `POST /field/sync` (new Lambda `sundial-field-sync`)

Batched, authenticated (Supabase JWT), tenant-scoped. For each command:

1. **Idempotency check** on `commandId` (Supabase `field_sync_commands` table:
   commandId PK, result, applied_at). Seen before → return the stored result, apply
   nothing. Retries and double-taps are free.
2. Apply in order (per visit): validate → write Salesforce (shared write path) →
   cache → Realtime broadcast (board sees En Route / In Progress live).
3. Return per-command `{ commandId, status: applied | duplicate | rejected,
   reason?, state? }` plus the fresh visit state; the app reconciles local state and
   clears applied commands.

A rejected command (see §4) moves to a visible **"needs attention"** list in the app
— never silently dropped, never blocking the commands behind it unless they depend
on it.

## 3. Clock, GPS, geofence

- **Clock events are timestamped at the moment of tap** (`occurredAt`, device time),
  not at sync time — a clock-out queued for two hours still records 4:30. The server
  flags device-vs-server skew beyond a threshold (per-tenant, default 10 min) for
  office review rather than rewriting times.
- Intervals append to `Clock_Intervals__c` (Lambda-written JSON, append-only);
  `Actual_Start__c` = first in, `Actual_End__c` = last out, `Duration_Minutes__c` =
  interval sum. Server validates monotonicity (out after in; no overlapping open
  interval for the same tech across visits — "on my way" closes the previous visit's
  interval first, matching the drive-time pay convention).
- **GPS capture:** `navigator.geolocation` with a 10s timeout at every clock event.
  No fix / permission denied / airplane mode → **the event still succeeds** with
  `gps: null`; geofence result becomes `no_gps`. Location never gates work.
- **Geofence is computed server-side at sync** (never on-device): haversine against
  the ticket's geocoded service address or any per-tenant shop location, within the
  per-tenant radius → `verified` / `out_of_fence` / `no_gps` per event;
  `Geofence_Verified__c` = all events verified. Tag, not blocker (D-065.10) —
  out-of-fence is visible to the office, nothing is refused.
- **Geocoding dependency:** service addresses geocode at ticket creation
  (`Geocode_Lat__c` / `Geocode_Lon__c` / `Geocode_Status__c` on the ticket —
  best-effort side effect, never fails intake). Provider: AWS Location Service
  (fits the stack; also feeds future travel-time hints). **[OPEN]** confirm provider
  + pricing before build.
- **Completion gate runs locally first** (required notes/photos/checklist before
  `on_my_way`/`complete_visit` is even enqueued) and is re-validated server-side —
  the gate can't be bypassed by a stale client, and offline techs get instant
  feedback instead of a sync rejection an hour later.
- **No time-edit surface in the PWA.** Corrections are office/desktop, appended with
  actor + reason (D-065.10).

## 4. Conflict policy (what happens when two truths meet)

Most field data is **append-only by construction**, which removes conflict classes
rather than resolving them:

| Data | Policy | Why it can't lose data |
|---|---|---|
| Clock intervals | Append-only; server validates ordering | Two devices can't produce overlapping intervals for one tech without the server seeing both |
| Notes | Append-only entries keyed by commandId; `edit_own_note` targets the author's own entry, last-write-wins on that entry only | Entries never merge into a mutable blob |
| Checklist items | Item-level set events, idempotent | Re-setting done = done |
| Photos | New objects, deterministic keys | Duplicate upload overwrites the same bytes |
| Estimate lines | Client-UUID keyed inserts | Duplicates dedupe on commandId |

Office and field write **disjoint surfaces** (office: ticket fields, scheduling,
invoicing; field: visit children), so field-vs-office conflicts reduce to state
races, handled explicitly:

- **Visit cancelled/rescheduled while tech offline:** sync rejects the command with
  `VISIT_CANCELLED` / `VISIT_RESCHEDULED`; the app surfaces "this call changed —
  contact the office," and the captured data (time, notes, photos) is **still
  written** to the visit — reality wins over the schedule; the office reconciles.
- **Ticket closed under an open visit:** commands apply, ticket flagged for office
  review (`Awaiting Office Review` reopened by Flow). Never discard field truth.
- **Same tech, two devices:** FIFO per commandId ordering on the server; second
  device's duplicate clock-in returns `duplicate`.

## 5. Photos

- Capture in-app or from camera roll; stored as IndexedDB blobs while offline
  (soft cap ~200 MB with oldest-synced eviction; the app warns near cap).
- Sync order: `photo_meta` command registers the file (name, visit, EXIF/device
  timestamp, category) → server returns a presigned PUT (standard
  `sundial-upload-file` flow, key `SUNDIAL/{visitId}/…`) → browser PUTs bytes
  directly → confirmation command completes the metadata row. An interrupted upload
  retries from the presign step (keys deterministic, overwrite-safe).
- Uploads trickle on cellular (concurrency 2, backoff) and never block clock
  commands — the outbox prioritizes small state commands over blobs.
- Timestamps: display and store the **capture** time (EXIF/device), matching HCP
  behavior techs rely on ("photos are time stamped for that day").

## 6. Push notifications (Web Push, iOS 16.4+)

Assignment/schedule changes ("you were added to 2:00 PM at Miller"), end-of-day /
next-morning "finish your work order" reminder for open single-day visits, and
(later) the geofence-departure clock-out nudge. Permission requested during tech
onboarding, not first launch. Push is a freshness signal — payloads trigger a day
pack refresh, they don't carry state.

## 7. Auth offline

Supabase session tokens refresh opportunistically. If the token expires while
offline, the app **keeps capturing** (outbox is local); sync waits for re-auth and
tells the tech plainly ("sign in again to send your work"). Local data at rest:
IndexedDB on a personal device — scope the day pack to the minimum (no card data
ever; customer contact only for assigned visits) and purge visits > N days old.

## 8. Failure-mode catalog (the driveway test)

| Scenario | Behavior |
|---|---|
| Clock-out with no signal | Queued with tap-time timestamp + last GPS try; syncs later; board catches up via Realtime on sync |
| No GPS fix / permission denied | Clock event succeeds, `no_gps` flag; office sees the gap |
| Phone dies mid-visit | Interval left open; end-of-day reminder next morning; office closes it with a correction (appended, attributed) |
| Visit cancelled while offline | Commands write anyway, tech alerted, office reconciles — no captured work lost |
| Photo too large / storage full | Warn, keep metadata command, retry upload; never blocks completion (photo requirement checks capture, not upload) |
| Token expired offline | Capture continues; sync after re-auth |
| Sync command rejected | Lands in visible "needs attention"; office notified after per-tenant threshold |
| App updated mid-shift | Service worker activates new shell on next launch; outbox schema versioned + migrated |

## 9. Build order (within this workstream)

1. Read-only field view (day pack, no offline writes) — techs see their day.
2. Clock in/out + intervals + GPS + board Realtime surfacing (online-only first).
3. Outbox + `POST /field/sync` + idempotency table → offline everything above.
4. Notes, checklists, completion gate.
5. Photos (offline queue + presigned flow).
6. Estimate builder + send.
7. Web Push.

Pilot gate: **two techs (Larry + one) run a full week dual-entry** (Sundial +
HCP); payroll totals from Sundial's visit time must match HCP's within corrections.
That match is the field go/no-go — see `docs/phase2-build-sequence.md`.

## 10. Open items **[OPEN]**

- Geocoding provider confirmation (AWS Location Service assumed).
- Per-tenant thresholds: day-pack depth, skew tolerance, photo cap, geofence radius,
  shop coordinates.
- iOS storage-eviction behavior for installed PWAs under pressure — verify on a real
  device during build; the outbox must survive (persist `navigator.storage.persist()`).
- Whether install crews (solar/roofing) onboard during Phase 2 or wait — the shell
  supports it; scope call is Tim's.
