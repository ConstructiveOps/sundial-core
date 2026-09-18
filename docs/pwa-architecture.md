# The technician app (PWA) — as built

**Status:** built 2026-09-16 (D-072 amendment 7). Lives **inside the portal at `/tech`** — same login, same Vercel deploy, its own phone-first shell. A user whose access level is **Technician** lands there from every office route; the office can open it too (and look at any tech's day).

The original design brief is `docs/pwa-architecture-design.md` (its header lists where the build diverged). This page is the architecture as it exists, written for the next person who touches it. `docs/service-workflows.md` §8 is the workflow contract it implements.

## Where things live

| Piece | Where | What it is |
|---|---|---|
| Routes | `sundial-core/lambdas/sundial-service-board/tech.js` (mounted by `index.js`) | Everything under `/service/tech/*`, one file, action `service.tech.self` |
| Field estimate lines | `sundial-core/lambdas/sundial-service-estimate/index.js` → `techAddLines` | `POST /service/tech/calls/{id}/estimate-lines` (the money math stays in the estimate Lambda) |
| The text | `sundial-core/lib/sms-send.js` | The ONE way Sundial sends a customer text; `sundial-sms` and the board Lambda both use it |
| Access | `sundial-core/lib/access.js` | scope `tech` (Technician): `service.tech.self` (writes on own calls), `service.tech.read` (the module, read-only) and `service.sms.send`; the user directory; no other `/sf` reads, no modules |
| App | `harmon-crm/src/tech/` | `TechLayout`, `TechTodayPage`, `TechCallPage`, `TechListPages`, `TechDetailPages`, `techApi.ts`, `offline.ts`, `photoStore.ts`, `techView.ts`, `gps.ts`, `registerSw.ts` |
| PWA | `harmon-crm/public/manifest.webmanifest`, `public/sw.js`, `public/icons/tech-*.png` | Installable; opens offline |

## The menu (2026-09-16)

Five slots on the bottom bar — **Today · Jobs · Estimates · Customers · More** — and a More sheet (refresh, sign out, room for the price book / time sheet / settings as they come). Jobs, Estimates and Customers are **read-only and tenant-wide** (`service.tech.read`): searchable lists (50 newest, `q` on number / name / address / phone) and record pages — a job with its visits (the tech's own link into the visit page), its estimate and the job's **Communications**; an estimate with its lines and stored totals; a customer with their jobs and estimates. The last answer to every list and record is cached on the phone.

**Communications on the job and on the visit page** is the office's own `CommunicationsPanel` (team notes with @-mentions, customer texts both ways, the feed-worthy events), rendered inside a `.dark` wrapper — no copy. What that took: `service.tech.read` on the sms thread and job activity reads, `service.sms.send` for a tech, the user directory (`/sf/users`) open to a tech for the mention list, and **`sql/sundial_access_p10_tech_scope.sql`**, which teaches the comments/mentions RLS the `tech` scope (`private.resolve_access` tech lane; `record_visible_for`: job / estimate / customer tenant-wide, nothing else; `user_visible`: a tech is staff). Until that SQL is applied, a tech's Communications shows "Couldn't load the team notes" — texts and events still work.

**Photos** come from the camera (one input with `capture`) or the library (a second input without it — iOS hides the library when `capture` is set).

## The shape of a day

`GET /service/tech/day?date=YYYY-MM-DD` (tenant timezone; default today) returns the tech's calls with a window that day **plus** anything they are mid-way through (`En Route` / `In Progress`, any date) and their `Unscheduled` assignments. Every call carries the board shape plus `issue`, `estimateId`, `geocode`, `geofenceVerified`, `photosCount`, `clock { state: idle|en_route|on_site, since, openSince, minutes }`, `intervals[]` and `checklist`. The office passes `techId=` to see someone else's day.

`GET /service/tech/calls/{id}` adds `otherTechs` (the job's other calls), `photos` (S3 listing of `SUNDIAL/{jobId}/photos/{callId}/`), a read-only `estimate` (number, status, total, lines with `addedByThisCall`), and `geofenceMeters`.

## The clock

One append-only log per call in `Clock_Intervals__c`:

```json
[{ "in": "…Z", "out": "…Z"|null, "kind": "en_route"|"on_site", "arrived": "…Z", "in_gps": {lat,lng,accuracy}, "arrived_gps": {…}, "out_gps": {…}, "ids": ["<eventId>", …] }]
```

| Tap (`POST …/status`) | From | What happens |
|---|---|---|
| `En Route` | Scheduled, En Route, No-Show | Closes whatever the tech has open on **another** call (an En Route one goes back to Scheduled — they never arrived; an In Progress one stays In Progress, paused), opens an `en_route` interval here (drive time belongs to the destination), status → En Route, and **texts the customer** through `lib/sms-send.js` unless `textCustomer:false` (a custom `message` replaces the default). No mobile number = no text, reported as `text.reason = NO_PHONE`, never an error. |
| `In Progress` | Scheduled, En Route, In Progress, Complete, No-Show | Closes other clocks; continues the open `en_route` interval (stamps `arrived`) or opens an `on_site` one; `Actual_Start__c` = first `in`; `Actual_End__c` / `Duration_Minutes__c` cleared (open again); **geofence** below; job `Scheduled → In Progress` (or `Awaiting Office Review → In Progress` on a reopen). |
| `Complete` | In Progress only (`409 CALL_NOT_STARTED`) | The **completion gate**: every required checklist item must be done or `409 CHECKLIST_INCOMPLETE { missing }` (tenant scope may pass `override:true`). Closes the interval, `Actual_End__c` = last `out`, `Duration_Minutes__c` = the sum of all intervals, GPS snapshots, job settles as before. |
| `No-Show` | Scheduled, En Route | Needs `note` (stamped into private notes as "No-show: …"); closes the interval without an end/duration; job settles like Complete. |

Every tap carries `at` (the phone's tap time — refused if in the future, more than a week old, or **before the last event on this call**: `400 AT_OUT_OF_ORDER`; time corrections are the board's job — see below) and `eventId` (the queue's action id): a replayed request whose id is already in the log is `200 { duplicate: true }`, so a lost response never doubles an interval or a text.

**Geofence — a tag, never a gate.** On clock-in with GPS, the job is geocoded lazily (Google Geocoding, key in `sundial/google-maps`, written to `Geocode_Lat/Lon/Status__c` once; `Failed` is remembered, a Google error is retried next time) and the fix is compared with the job **or** the shop (`SERVICE_SHOP_LATLNG`) within `SERVICE_GEOFENCE_METERS` (default 250). Within → `Geofence_Verified__c = true`. No GPS, no key, no geocode → simply unverified.

### The office's corrections (2026-09-17)

The phone appends; the office corrects on the dispatch board (**Fix time** on the call dialog → `GET` / `POST /service/calls/{id}/clock`, `docs/api-endpoints.md`). The dialog shows every live interval as a row (day, start — or left / arrived on a drive — and end), lets the dispatcher fix a time, give an open interval its end, remove a double tap or add a stretch that was never clocked, and sends the whole list back with a **reason**. The log keeps everything: a changed row gains `corrections: [{ at, by, reason, from }]`, an added row `added: {…}`, a removed row stays in the array with `removed: {…}` and counts for nothing afterwards (its event ids still make a replayed tap a duplicate — `hasClockEvent` looks at every row, everything else only at live ones). Nothing reopens from the office: a closed interval stays closed, the tech clocks in again instead. `Actual_Start/End__c` and `Duration_Minutes__c` are re-derived — end and duration only once the call is Complete, so closing an In Progress call's open interval pauses it rather than finishing it; **Mark this call Complete** in the dialog finishes it (job settles as usual). The board's own status menu moves the same log (In Progress opens, Complete / No-Show closes), so the phone, the board and the actuals never disagree. A call billed from its clock (Labor billing, amendment 6) needs the job's Labor card re-saved afterwards — the dialog says so.

## Notes, checklist, photos

- **Notes** (`POST …/notes { body, private? }`) are append-only and stamped `── Jake Dorsey · Sep 14, 2026, 9:20 AM` into `Work_Notes__c` (customer may see) or `Private_Notes__c` (office). The `eventId` rides along as an invisible zero-width marker so a replay does not double the entry.
- **Checklist**: one generic default today (`DEFAULT_CHECKLIST` in `tech.js`: work notes ✓auto, a photo ✓auto, walk the customer through, pick up your tools; "ask for a review" optional). Manual ticks go to `Checklist_State__c` JSON; the two automatic items are read off the record. `Checklist_Template_Key__c` is set to `default` on first tick — a per-tenant template library keyed by it is the follow-up.
- **Photos**: presign (`POST …/photos { fileName, contentType }`, images only, 25 MB) → the phone PUTs to S3 → confirm (`POST …/photos/confirm { key }`) registers the `sundial_file_metadata` row (`category: photo`, `subfolder: photos/{callId}`, under the **job** so the Files tab and XFiles Pro see it) and sets `Photos_Count__c` from the listing. Keys are `SUNDIAL/{jobId}/photos/{callId}/{timestamp}-{name}` and a confirm for a key outside that prefix is refused.
- **The job's photos and files (2026-09-18)**: the job page in the app has a read-only **Photos** section — every visit's photos in the one job folder, grouped by call (`GET /service/tech/jobs/{id}/photos`, "Office" for what the office added straight under `photos/`), so a tech sees what the last tech saw — and a read-only **Files** section (`GET /service/tech/jobs/{id}/files`: the job's folder minus the photos, plus the estimate's folder with the sent PDFs). Both are `service.tech.read` routes on the board Lambda (the file-list Lambda still denies techs; `lib/access.js` is unchanged). Taking and adding photos stays on the tech's own call page — the app never uploads at the job level; the office does that from the job page (`POST /service/jobs/{id}/photos` → `/confirm`).

## Offline — online-first with a queue (`src/tech/offline.ts`)

A tap is sent straight away when there is signal. Otherwise — or when the request dies on the way (network error, 5xx, 429, 401) — it is stored in `localStorage` (`sundial-tech-queue`) with **its tap time and its own id**, painted onto the local copy at once (`techView.withPending`), and replayed **in order, one at a time** on the next `online` event, app open, or tab focus. Photo bytes wait in IndexedDB (`photoStore.ts`); a photo replays as presign → PUT → confirm and re-presigns if the URL expired mid-way. A tap the server refuses (any other 4xx — out of order, the checklist gate, a cancelled call) is kept as **failed** with the server's message, replay continues with the next one, and the header shows it with a Discard button. Anything already waiting for a call forces the next tap on that call to queue behind it, so the clock never sees events out of order.

The last good copy of the day and of each call is cached in `localStorage` so the app opens with no signal; the service worker (`public/sw.js`) caches only the app shell (network-first for navigations, cache-first for hashed assets) and never an API response. It is registered from `/tech` only — the office portal has no worker.

## Staying signed in

Supabase issues an access token that lives **one hour** by default; a healthy client renews it silently with the refresh token (supabase-js does this on a timer, and since 2026-09-16 `AuthContext` also calls `getSession()` whenever the app comes back to the foreground or the network returns, so a phone that sat in a pocket resumes with a live token). Being sent to the login page means a renewal was *refused* by Supabase, not that the hour ran out — the refresh token was revoked. The two Supabase settings that do that: **Authentication → Sessions → "Single session per user"** (a second login as the same account, e.g. the office checking a tech's day on a desktop with the tech's credentials, kills the phone's session) and **"Time-box user sessions" / "Inactivity timeout"**. Both should be off for Harmon. Independently, raising **Authentication → Sessions → "Access token (JWT) expiry"** from 3600 to **86400** (24 h) makes each token itself last a day, so even a phone whose refresh fails keeps working for the shift. Tokens are verified by signature and `exp` in `lib/supabase-auth.js`, so a longer expiry needs no backend change.

## Setup (Tim)

1. Deploy: `.\deploy.ps1 sundial-service-board`, `.\deploy.ps1 sundial-service-estimate`, `.\deploy.ps1 sundial-sms`, `.\deploy.ps1 sundial-auth-proxy`.
2. Google Cloud → the `sundial/google-maps` key → enable the **Geocoding API** alongside Street View Static.
3. Optional env on `sundial-service-board`: `SERVICE_GEOFENCE_METERS`, `SERVICE_SHOP_LATLNG`.
4. The board Lambda's role needs `s3:PutObject` + `s3:ListBucket` on `sfsolproj` under `SUNDIAL/*` (what `sundial-upload-file` / `sundial-list-files` have).
5. `.\scripts\wire-service-tech-routes.ps1` (re-run after 2026-09-16: it adds the jobs / estimates / customers routes).
6. Supabase SQL editor: `sql/sundial_access_p10_tech_scope.sql`, then its verification block. Supabase → Authentication → Sessions: JWT expiry 86400; single-session / time-box / inactivity off.
7. Portal deploys with `main`. On a phone: open `https://sundial.harmonelectric.net/tech`, sign in as a Technician, "Add to Home Screen".

Test with the ZZ tech users (`zz-tech-2`, `zz-tech-3`) on the ZZ test job, never a live tech.
