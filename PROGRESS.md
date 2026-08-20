# Sundial — Progress Log

## 2026-08-20 — v2 budget field package amended for D15 + §4d (58 fields, still not deployed)

Second pass on `salesforce/v2-budget-adder-fields/` against the REVISED-workbook update
to the rework doc. Still package-only, still additive, still not deployed. 56 → 58.

**D15 inverted the Cost fields, and the inversion is the whole change.** They shipped
yesterday as nullable-with-no-default, where null meant "the calc derives the sheet
value". D15 replaced that with static defaults on all 12, because a number sitting in
Salesforce is visible and admin-editable in a way a number buried in calc code is not.
So the semantic flipped end to end: **the calc now always reads the field and never
derives, which makes a blank Cost field a bug rather than a signal.** Every trace of the
old wording is gone from the descriptions and inline help — replaced with the per-UNIT
(× Qty) vs per-WATT (× watts) distinction, and the consequence that matters operationally:
**changing an adder's price does not move its cost.** The defaults are a snapshot of a
derivation, not a live link to one, so an org-wide re-price means re-deriving the cost
default by hand.

**Every default was re-derived rather than transcribed.** `(price − hours × 33 × 1.75)
÷ 1.25` for the eight flat ones, per-watt equivalents for the four others — all twelve
reproduce the doc's §4c table exactly, so the table and the package agree because they
were computed independently, not because one was copied from the other.

**That also settled yesterday's open judgement call.** The per-watt fields were built at
`Number(15,3)` to match the price side, flagged as overridable if 4 dp was wanted. The
D15 defaults are 0.052 / 0.052 / 0.009 / 0.06 — all exactly inside 3 dp. Nothing is lost,
so it is now confirmed rather than a trade-off, and the TASKS item is closed.

**§4d addendum: `Internal_Rep_Commission_PPW__c` on both objects.** Type cloned from
`Sales_Rep_Commission_PPW__c`, which turns out to be a **`Number`, not a Currency**,
despite being labelled "Sales Rep Commission $/W" — and it diverges across objects the
same way everything else does: `Number(4,3)` on Customer, `Number(15,3)` on Solar.
Default 0 on both. Per D16 this field is not just another input: which of the two rep
PPW fields is populated *decides the deal type* (3rd-party → SLPC OUT + commission POs;
internal → SLPC · SALESCOMM, payroll only, no POs), and both populated is a validation
error. That is in the field description so it survives away from the doc.

Collision check re-run for the new name: absent from both objects.

**The find worth acting on: D17 cannot be implemented as written.** D17 says the setter
commission "applies when `Setter__c` is populated". The describe says:

- `Sundial_Customer__c.Setter__c` — Lookup → `Sundial_User__c`, updateable, plus a
  separate `Setter_Name__c` Text(120)
- **`Sundial_Solar__c` — no setter field of any kind.** Nothing matching /setter/ at all.
- `harmon-crm/src/config/customer-to-solar-map.ts` explicitly excludes it, with the
  comment *"Setter__c — Sundial_Solar__c has no corresponding field"* sitting in its
  deliberate-non-mapping list.

The calc runs Solar-side, so the rule has nothing to read. Reported, not fixed: the task
scoped it as report-only, and the fix is a design call (Solar lookup + mapping entry,
versus a text mirror like the existing `Sales_Rep_Name__c` pattern, versus reading
through to the Customer). Logged as a `[!]` blocker in TASKS and against D17 itself in
the doc, so it surfaces when the calc work reaches the commission section rather than
during it.

**One inconsistency shipped deliberately.** The new field is labelled "Internal Rep
Commission PPW" per the brief, while its siblings read "… Commission $/W". Flagged in
the README and TASKS as a one-line change before deploy rather than silently
"corrected" — the brief was explicit.

The README's verify step is now **inverted**, and says so in as many words, because a
stale checklist is worse than none here: a new Solar record must show every Cost field
pre-populated, and a blank one means the default did not take. Under the previous build
blank was the correct answer.

Regenerated from `generate.mjs` (58 fields), re-verified: XML well-formedness on all
three files, `<fields>` tag balance, 58 `<members>` in package.xml, all 58 labels under
Salesforce's 40-char cap, zero occurrences of the retired null-=derive wording, and a
printed manifest of every field's final type and default.

## 2026-08-20 — v2 budget rework: SF field package (56 fields, PACKAGE ONLY — not deployed)

Workstream A of `docs/integrations/acumatica-budget-rework-v2.md`. `salesforce/v2-budget-adder-fields/`
— package.xml + two `.object` files + README, Metadata API v62.0. No code changed, nothing
deployed. §4a 28 + §4b 16 + §4c 12 = 56; Customer 22, Solar 34.

**Collision check first, as asked: zero hits.** All 56 API names against the live describe
on both objects — none already exist.

**The describe contradicted the spec in three places, and reading it first is the only
reason the package is right.** Every type signature was cloned from the live org rather
than typed from the plan text:

1. **The two objects diverge on the NS blocks.** Customer NS 1-3 are `Percent(3,3)` /
   `Number(5,1)`; Solar NS 1-3 are `Percent(14,4)` / `Number(17,1)`. The brief said
   `Percent(3,4)` / `Number(16,2)` — which matches *neither*. Blocks 4 and 5 clone
   whichever object they sit on, so all five blocks behave alike within an object. The
   cross-object divergence is pre-existing and harmless in the one direction it is used:
   Customer → Solar (Create Project) widens every signature.

2. **The per-watt price fields are `Number` with 3 decimals, not 4.**
   `Adder_Flat_Roof_Price__c` is `Number(15,3)` on Solar, `Number(6,3)` on Customer. That
   settles the Number-vs-Currency question the brief left open, but at 3 dp rather than
   the suggested 4. The four per-watt Cost fields match at `Number(15,3)`, so cost and
   price for the same adder carry identical precision — a cost expressible more finely
   than its own price is an odd asymmetry. Flagged as the one judgement call worth
   overriding: 0.001/W granularity is ~$4 of rounding on a 10 kW job, and it is a
   one-character change per field *before* deploy.

3. **`NS_Adder_1-3_Markup_Percent__c` defaults to 0 on Solar and has no default on
   Customer** — not 25. New blocks 4/5 default to 25 per §3, so the five blocks will not
   behave alike until 1-3 are aligned. That is a change to *existing* fields, so it stays
   out of an additive package and is logged as a follow-up instead.

A fourth, smaller one: Customer's adder Price fields carry **no defaults at all** while
Solar's do (`Adder_Sub_Panel_Price__c` defaults to 500 on Solar, nothing on Customer). The
brief asked for defaults on both, which is right — a defaulted price with a 0 default
quantity contributes nothing until a quantity is set, and it saves the rep typing the
price book from memory. Noted so it does not read as an accident later.

**Null is the whole point of §4c, so it is stated three times.** Every `Adder_*_Cost__c`
is nullable with no default: null = the calc derives the sheet default, populated = a
per-job override. The sentence is in each field's `description`, in its `inlineHelpText`
(so it is on the record page, not just in Setup), and in the README — plus the corollary
that nothing may ever write `0` to mean "unset", because 0 is a real override meaning the
adder costs nothing. The README's verify step includes "a Cost field showing 0.00 instead
of blank means a default crept in — stop before anyone enters data".

**One label could not carry the sheet wording.** Salesforce caps field labels at 40 chars
and `Adder: LightReach Battery Warranty — Price` is 42. That field is labelled
`LR Battery Warranty`, matching its API name `Adder_LR_Battery_Warranty_*`, with the full
wording in the description and inline help. All 56 labels were length-checked
programmatically; that was the only one over. Labels otherwise follow each object's own
style — Customer `Adder: <name> — Price` (colon, em dash), Solar `Adder <name> - Price`
(no colon, ASCII hyphen).

**FLS could not be enumerated from here, and the README says so rather than guessing.**
The integration user lacks *View Setup and Configuration*, so `SELECT ... FROM
FieldPermissions` returns `INVALID_TYPE` for it. What *was* verifiable: the integration
user holds `updateable = true` on the existing adder Price/Qty and NS fields on both
objects, so the "mirror that grant" instruction is grounded. For the rep-facing profile
list the README carries the exact SOQL for Tim to run as himself. Mirroring matters more
than it sounds: the new adders land in the same page-layout section as the existing ones,
so a profile that can edit Sub Panel but not Site Audit gets a half-greyed section and
files a bug.

**Generated, not hand-typed.** 56 fields × ~10 XML elements is exactly the kind of thing
where a transposed precision hides for weeks; the package is emitted from a small script
holding the per-object conventions in one place, then verified: XML well-formedness on all
three files, `<fields>` tag balance, 56 members in package.xml, and every label under 40
chars.

**Downstream reminders logged, not built:** §4g Create Project mapping additions (the 22
new Customer fields are **inert until `customer-to-solar-map` copies them** — a deployed
package alone does nothing for Create Project), and the harmon-crm portal config-sheet
additions. Both in TASKS.md.

## 2026-08-18 — @-mention email alerts + user preferences (D-056, NOT APPLIED / NOT DEPLOYED)

Backend half of two features harmon-crm is waiting on. **Nothing is live** — the
migrations have not been run and the Lambda has not been created, deliberately (live
changes, handed over as steps rather than executed).

**The load-bearing fact is that comments have no backend at all.** `CommentThread.tsx`
inserts `comments` and then `comment_mentions` straight from the browser under RLS, and
that second insert is already explicitly best-effort. So a client-driven email would die
with the tab — and **the person who loses the notification is not the person who caused
it.** Neither of them ever finds out. Hence an `AFTER INSERT` trigger on
`comment_mentions` that posts to a new Lambda through `pg_net`: once the row is
committed, the notification is the database's problem, and a database cannot navigate
away. A Supabase Dashboard Database Webhook would have done the same job in two clicks
and lived nowhere in this repo — explicitly rejected, since we were already burned by
one load-bearing untracked dashboard setting (the auth email templates).

**Preferences are their own table, and the reason is a Postgres detail worth writing
down: RLS is row-level, not column-level.** The obvious home was `public.profiles` —
there's already a row per user. But `profiles` is server-owned (auth-proxy upserts
tenant/role into it; RLS on the cache tables resolves tenancy *from* it), and a
self-serve toggle means granting the client UPDATE on that row. A policy that allows
"update your preferences" allows `set tenant_id = '<another client>', role = 'admin'` in
the same statement. Column GRANTs can narrow it, but they're a second mechanism that has
to stay in sync forever, and a column added to `profiles` later is writable-by-default
unless someone remembers. `user_preferences` has no such edge — every column is safe for
its owner to write, and the worst a malicious user can do is turn off their own alerts.

**Absence means alerts ON, with no backfill.** Every existing user has no row and that's
the intended steady state. A missing row reads as `comment_email_alerts = true` in both
readers, so nobody opts in to keep today's behaviour. The cost — the default lives in
readers rather than the schema — is stated in the migration header, the runbook, and a
test named for it.

**Stored value is `'list'`, not `'table'`.** harmon-crm's `ViewMode` union is
`'table' | 'board'`, but that's a detail of one component; the stored value is the
cross-repo contract and matches the user-facing word. Renaming a React type must never
require a data migration.

**Every business reason not to send is a 200.** Alerts off, self-mention, no address,
SES not wired, already notified — all successes with a `reason`, because pg_net doesn't
retry a 200 and redelivering a mention whose recipient has alerts off achieves nothing
but log noise. **Nothing stamps `notified_at` except a successful send**, so a recipient
who re-enables alerts, or an SES that comes online later, is still reachable by a
replay. That last point is what lets the whole feature deploy *before* SES exists:
`EMAIL_FROM` is unset everywhere today, so it returns `email_not_configured` as a
degraded success, mirroring the Design Request email.

**An unknown `record_object` links to `/dashboard`, never a guessed path.** A 404 from a
notification email reads as "the portal is broken", and the reader can't tell that apart
from "we don't support that link yet". Service gets one entry in `RECORD_PATHS` when it
lands; until then it warns by name.

**Two things added beyond the spec, both flagged.** A tenant guard (this path emails a
comment body, so a cross-tenant mention would be a leak nobody sees — it only skips when
both tenants are known and differ, so a user who's never hit `/auth/me` still gets
alerts), and a best-effort subject label read from the Supabase cache, so the subject
says "mentioned you on HOLLAND, DANA" rather than "on a1P7y00000AUo6TEAT". The label is
never worth a Salesforce call and a cache miss falls back to `object id`.

`constantTimeEquals` moved out of `sundial-welcome-call/webhook.js` into
**`lib/secure-compare.js`** — three public non-JWT routes now gate on a shared-secret
header and they must not each grow their own comparison. webhook.js imports and
re-exports it, so its surface and tests are unchanged (proven: 251 still green before
the new tests landed). The deployed welcome-call bundle still carries the inline copy
and is behaviourally identical; no redeploy is required for correctness.

**Real schema was read before writing any of it** rather than assumed: `comments` is
`{id, tenant_id, record_id, record_object, author_id, author_name, body, created_at}`
and `comment_mentions` is `{id, comment_id, mentioned_user_id, created_at}`. Worth
noting `profiles` already carries an `email` column — the Lambda deliberately does NOT
use it and reads `auth.users` instead, because `profiles.email` is only populated once a
user has hit `/auth/me`, so a freshly-invited user mentioned before their first sign-in
would silently get nothing.

33 new tests, 284 green, bundle builds.

**⚠️ `pg_net` availability is UNVERIFIED from this environment.** The only Supabase
credentials here are the service-role key, which reaches PostgREST and nothing else —
there is no arbitrary-SQL path and no management token, so `pg_available_extensions`
could not be checked. The migration includes `create extension if not exists pg_net;`
and it ships with every Supabase project, but that is an assumption, not a verification.
If step 6 of the deploy order errors, stop there rather than reaching for a dashboard
webhook.

## 2026-08-17 — Welcome Call: recording archival + orphan-match endpoint (D-054 addendum, NOT DEPLOYED)

**Retell's `recording_url` expires.** Without archiving, the link written into
`Welcome_Call_Log__c` works today and 404s exactly when someone needs it — when a
customer disputes what they agreed to. The webhook now downloads the mp3 server-side
and writes it into the ordinary Sundial file convention
(`SUNDIAL/{customerId}/welcome-call-{YYYY-MM-DD}-attempt-{n}.mp3` in `sfsolproj`),
which buys the portal Files tab, XFiles Pro, and the Dropbox mirror with **zero
additional code** — that is the whole reason to use the existing key convention instead
of inventing a recordings bucket. Registered in `sundial_file_metadata` as category
`Welcome Call Recording`, uploader `Wattson (system)`.

**The date is Phoenix, not UTC, and that is not pedantry.** A call placed at 6pm
Phoenix is already tomorrow in UTC, so a UTC-named file lands in the Files tab under a
date the office never dialed on. Same reasoning puts `attempt_no` in the filename:
attempt 2 must not clobber attempt 1, because a customer called three times has three
different conversations worth keeping.

**The orphan case forced an ordering inversion, and it is the one interesting decision
here.** D-054 says the Zapier billing forward goes first, before anything that can
fail. But a rep-form call has no Salesforce record, so its ledger row is the *only*
trace of it — and the sweep that later matches it to a customer needs the recording's
S3 key, which does not exist until the upload has happened. So the orphan path runs
the recording step *before* the forward and enriches the payload with
`s3_recording_key`; the attached path keeps the original order. Two orderings in one
handler is a smell, so it is commented at both sites and in the runbook. The key is
technically derivable from `call_id` alone, but a derived key can't tell the sweep
whether the upload actually *succeeded* — its absence is the signal that there is
nothing to match.

**Orphans get no metadata row, deliberately.** Every file list query is scoped by
`sf_record_id`; a row with a null one is unreachable by any surface. That is worse than
no row, because it looks registered.

**`POST /welcome-call/orphan-match` has to be idempotent while deleting its own
input.** The Zap posts `{call_id, sf_record_id}`; the endpoint copies the holding
object to `SUNDIAL/{recordId}/welcome-call-{date}-{call_id}.mp3`, dating it from the
holding object's `LastModified` (the sweep may run days later — name the file for the
conversation, not the sweep), registers metadata, appends the log line, then deletes
the holding object last. A retry therefore **cannot re-derive the destination key**,
because the `LastModified` it embeds belongs to an object that no longer exists. So the
retry path *searches* the record folder for `welcome-call-*-{call_id}.mp3` instead and
returns `already_matched: true`. It also re-attempts the metadata row and the log line,
each a no-op when present — without that, a run whose log append failed would have
deleted the holding object and the note could never be written. There is a test that
fails the SF update on the first call and asserts the second one heals it.

**A failed holding-object delete is not a failed match** — the bytes are attached and
registered, which is the point; the response says `holdingDeleted: false` and the next
retry cleans up.

**Auth is a second shared secret** (`X-Sundial-Zap-Secret` / `ZAP_ORPHAN_MATCH_SECRET`),
not a portal JWT — the caller is a Zap. Fails closed when unset, same as the Retell
signature gate; the constant-time compare is now a shared helper so the two gates can't
drift apart. A test asserts each route rejects the *other* route's credential.

**Nothing in the recording path can cost us the call result.** Every path resolves
rather than throwing; a failure logs at ERROR with the `call_id` and the still-live
`recording_url` for manual retrieval, and the Salesforce writeback runs regardless.
Download is https-only with no credentials attached (the URL comes from the request
body — even signed, we don't hand the Retell API key to whatever host it names), 20 s
timeout, 50 MB cap checked against `content-length` before buffering.

**Duplicate-row trap, now closed for everyone:** deterministic keys mean a redelivery
overwrites the S3 object harmlessly, but a second `registerFileMetadata` would insert a
second row and show the file twice in the Files tab with no way to tell them apart.
Added `findFileMetadataByKey` to `lib/file-access.js` — shared, so the other
best-effort writers (copy-to-solar, budget snapshots, Aurora signed PDFs) can use it
too.

24 new tests (76 in this Lambda, suite 218, green) against an in-memory S3 stub and a
PostgREST-shaped Supabase stub whose metadata select reads back its own inserts, so the
dedupe is genuinely exercised. `wire-retell-webhook-route.ps1` is now
`wire-welcome-call-routes.ps1` and wires both routes (it had never been run, so no
operational history was lost).

**Still not deployed.** Same blockers as the base feature, plus: the orphan-sweep Zap,
`ZAP_ORPHAN_MATCH_SECRET`, and a check that the execution role keeps `s3:DeleteObject`
on `sfsolproj/SUNDIAL/*` (new for Sundial with this change — `AmazonS3FullAccess`
covers it today).

## 2026-08-17 — Welcome Call backend: Retell voice verification (D-054, NOT YET DEPLOYED)

`lambdas/sundial-welcome-call` — one Lambda, two entry points, told apart by the shape
of the event. An EventBridge relay of `Sundial_Welcome_Call_Request__e` places the
call; `POST /webhooks/retell` receives the result. **No portal UI, no
portal-authenticated route** — the webhook is the only route added.

**The interesting bug was one nobody would ever have reproduced by hand: an EN DASH.**
The live `Financing_Partner__c` picklist holds `Participate Prepaid Lease – Cash` with
U+2013 and `Participate Prepaid Lease - Financed` with an ASCII hyphen. The spec spells
both with a hyphen. A literal comparison matches one and silently misses the other — so
half the prepaid-lease customers would have fallen into the "unmappable partner" path
and never been called, with a log line blaming their data. Partner matching now folds
every dash variant before comparing. Same class of drift, found the same way: the spec
names `Due_at_Greentag_Amount__c`; the org has `Due_at_Green_Tag_Amount__c`. The
describe guard now takes a **candidate list** per logical field, so it reads the right
value today and survives a rename. Both were caught by describing the live object
before writing the mapping, not by testing.

**Every ambiguity resolves to *don't dial*.** The eligibility guard skips on a
non-eligible status, attempts ≥ 5, an unparseable US phone, a time outside 08:00–20:00
America/Phoenix, or a financing partner that doesn't map — and a skip is a *success*,
not a retry. Phone parsing is deliberately strict (valid NANP prefixes, no appended
extensions): a wrong-but-plausible number reads a stranger someone else's contract.
Only the unmappable-partner skip writes to Salesforce, because it is the only one a
human must fix data to clear; the rest would just churn the log. **A Retell failure
writes nothing at all** — no `Calling`, no attempt increment — because we never
established that a call was placed and burning one of five attempts on our own outage
would be wrong.

**The guard lives in the Lambda, not the Flows, and that is what lets the Flows be
dumb.** Tim's trigger Flow and retry Flow both publish the same one event with no entry
logic of their own; a Flow that fires too eagerly is a logged no-op. One event, not
two: a retry and a first call run identical code, and the attempt number is on the
record.

**Read is always fresh from Salesforce, never the cache.** These values are read aloud
to a customer as the terms of a contract they signed. Formatting is for speech, not for
a screen — `$142.50 per month`, `11,450 kilowatt-hours`, `1.9% per year` — and a blank
source becomes the literal string `not provided`, which the agent prompt branches on.
Zero is not blank: a `$0` down payment renders as `$0`. Two things that look like bugs
and aren't: `estimated_production` reads a field named `..._kW_Production__c` but is
spoken as kilowatt-**hours** (the label is wrong, the value is energy), and
`energy_rate` gets its own formatter because at two decimals `$0.089` rounds to `$0.09`
and misstates the contract.

**Webhook ordering is the design.** The Zapier billing-ledger forward happens FIRST,
before Salesforce is touched, with two retries and an ERROR-level payload dump for
manual replay on final failure — and it never blocks the writeback. The Zap bills for
*every* analyzed call, including rep-initiated ones that carry no `sf_record_id` and
may have no Salesforce record at all; for those, the forward is the whole job and
Salesforce is never even queried. A Salesforce outage therefore costs a verification
status (recoverable — we return a deliberate 500 and Retell retries) rather than a
billing row (not recoverable once we 200). **Consequence Tim needs to act on: dedupe on
`call_id` inside the Zap**, since a redelivery double-forwards.

**Idempotency rides on the log field**, with a subtlety worth not re-deriving: matching
the `call_id` alone would discard the *first* legitimate result, because the "Call
placed" line carries the same id. The guard requires both the `call_id` and the literal
marker `Result:`.

**`No Answer` is the only non-terminal outcome** — that is what makes the retry Flow
meaningful, and the attempt ceiling rewriting it to `Failed - Max Attempts` is what
makes it terminate. An **unrecognized** outcome goes to `Verified - Exceptions`, not
`No Answer`: parking it for a human beats silently queueing another call on a result we
did not understand.

**New shared code: `lib/realtime.js`** — the first actual Supabase Realtime *sender* in
this backend. The caching doc has described this broadcast since Phase 1, but no Lambda
implemented it (`sundial-sf-update` only flags `is_stale`). It posts to Supabase's
stateless HTTP broadcast endpoint rather than opening a channel: a WebSocket whose
Lambda container can freeze mid-handshake is a silently dropped message. The cache
write follows `sundial-sf-update` exactly — best effort, tenant-scoped, never fails a
write Salesforce accepted — and additionally writes the three welcome-call columns
*when the cache table has them*, checked against PostgREST's OpenAPI document, because
an unknown column would make PostgREST reject the whole update and drop the `is_stale`
flag with it.

52 tests (suite now 194, green). Bundle builds clean.

**Not deployed and not verified end to end.** Blocked on Tim: create
`Sundial_Welcome_Call_Request__e` (it does not exist in the org yet), the two Flows, the
Event Relay + EventBridge rule, the Retell agent, and the `sundial/retell/api` secret.
Runbook with the expected rule shape: `docs/integrations/retell-welcome-call.md`.

## 2026-08-13 — Related-records filter: `?parentId=` on the generic list endpoint (DEPLOYED)

`GET /sf/solar?parentId=<customerSfId>` returns one customer's solar projects.
Registry-style: `PARENT_FILTER` names the parent lookup and its cache column per
object (solar and roofing today, both on `Sundial_Customer__c`), so a future child
object is one entry. Response shape untouched.

**The interesting bug was the one that never fired in testing: zero rows.** The list
read falls back to a live Salesforce query when the cache returns no rows, on the
assumption that an empty result means a cold cache. With a parent filter that
assumption is wrong — *a customer with no projects is supposed to return nothing*, and
it is indistinguishable from a cold cache at that point in the code. Left alone, an
empty related list would have fallen through to the live path and returned the
tenant's **entire table** — the worst possible answer, and one that looks like working
software. The parent clause is now carried into the fallback's SOQL, so it re-asks
Salesforce for that parent's children and correctly returns empty.

**Composition with the TEMP Sales-Rep restrict** was the other requirement. That path
already bypasses the cache (the authoritative rep field isn't cached), so the parent
clause is ANDed onto the rep clause in SOQL — the rep clause is applied first and is
never relaxed. A restricted rep opening a customer's related list gets the
intersection: their own projects for that customer. Covered by a test that asserts no
` OR ` ever appears in the generated WHERE.

**Unsupported object → 400, not a silently ignored param.** `customer`/`po`/`user`
have no parent registered. Ignoring `?parentId=` there would answer a related-list
request with the whole table and the caller could not tell — same failure shape as the
zero-row bug, so it fails loudly. Malformed ids are rejected before any query runs.

**`sundial-sf-query` had no test file.** Added one (12 tests, now in `npm test`): the
cache builder mock applies real filter semantics, so a dropped filter shows up as
leaked rows rather than a passing assertion. Suite is 142.

Deployed. **Not verified against live data** — that needs an authenticated token this
session doesn't have; the deployed route answers and CORS is intact.

## 2026-08-13 — Portal domain cutover to `sundial.harmonelectric.net` (D-053, DEPLOYED)

**Two backend surfaces are domain-aware and neither follows a redirect:** the CORS
allowlist and the invite-link base URL. Both are updated; `harmon-crm.vercel.app` and
`localhost:5173` are retained, so nothing that worked before stopped working.

**The allowlist lives in six files, not one.** `lib/http.js` is bundled into seven
Lambdas, and five more carry their own inline copy of `STATIC_ALLOWED_ORIGINS` /
`isAllowedOrigin` / `corsHeaders` — `sundial-auth-proxy`, `sundial-sf-query`,
`sundial-sf-update`, `sundial-acumatica-push`, `sundial-aurora-push`. One origin, six
edits, twelve redeploys. The harmon-crm task tracking this knew about **one** of the
five inline copies, so following it would have left four Lambdas rejecting the new
domain. Consolidation is now logged as tech debt.

**`PORTAL_BASE_URL` set on `sundial-user-admin`, and the in-code default changed to
match.** The function had **no `Environment` block at all** beforehand — worth knowing,
because `update-function-configuration --environment` replaces the whole map and would
have silently dropped any existing vars. Changing the default too means a lost env var
now degrades to the same working link instead of the retired Vercel URL.

**Preflight is a false oracle here.** `OPTIONS` is answered by API Gateway itself with
`Access-Control-Allow-Origin: *`, so it passes for *any* origin — including one the
Lambda rejects. Verification had to use real `GET`s carrying an `Origin` header, on both
the inline path (`/auth/me`) and the shared-lib path (`/admin/users`,
`/files/by-record/…`): new domain echoed, vercel.app echoed, localhost echoed, and
`evil.example.com` falling back to localhost rather than being reflected.

**A deploy-loop trap worth not repeating:** piping `deploy.ps1` through
`*>&1 | Select-String` reported three false `FAILURE`s. Under
`$ErrorActionPreference = "Stop"`, redirecting a native command's stderr in PowerShell
5.1 wraps npm's ordinary funding/audit notices as `NativeCommandError` and terminates.
The deploys had never reached AWS. Re-running without the redirection: 12/12 clean.

**Still outside the repos (Tim):** Supabase Site URL + Redirect URLs must include the
new origin — password resets use `window.location.origin`, so they break on the new
domain until that lands — and the Vercel domain attachment + DNS.

## 2026-08-11 — Five cache ghosts purged; cache-sync gains a reconcile mode (NOT DEPLOYED)

**The five ids were `Sundial_Solar__c`** — resolved from the `a1Q` key prefix via live global describe rather than assumed (`a1P` is Customer, `a1R` Roofing, `a1S` Commercial, `a1T` Service, `a1U` PO, `a1V` PO Credit, `a1O` User, `a1W` Tenant). Target table: `sundial_solar_cache`.

Verified against Salesforce before deleting anything: all five return **`IsDeleted = true` via `queryAll`** and are absent from a normal query — deleted into the Recycle Bin, none still live, so all five were safe to purge. Nothing was skipped. All five cache rows were stored in **18-char** form (checked both forms). Rows backed up to the session scratchpad before deletion; **5 deleted, 0 remaining**.

**Dependent references: none.** Three columns could point at a Solar record — `asset_cache.originating_solar_project_sf_id`, `sundial_po_cache.linked_solar_project_sf_id`, `sundial_roofing_cache.linked_solar_project_sf_id` — and all returned zero matches. The first two tables are empty entirely; roofing's single row references something else. Nothing cascaded.

**Open portal sessions will not see this.** There is no Realtime signal for a cache purge — the invalidation triggers cover *changes*, not removals — so anyone with the Solar list already on screen keeps seeing the five until their next fetch or reload.

**Made repeatable: `{ "mode": "reconcile" }` on `sundial-cache-sync`** (+ optional `object`, `dryRun`, `force`). It reads the cache's id set, asks Salesforce which of those ids still exist, and deletes the rest. **Manual invoke only — deliberately not scheduled** (see TASKS before anyone adds it).

**Why it asks cache → Salesforce in batches rather than pulling all Ids and diffing:** the diff costs fewer API calls and fails catastrophically — an incomplete or errored Salesforce result reads as "every row is a ghost" and empties the cache. The batched existence check fails safe: a batch that errors leaves its ids alone and reports them as `unverified`. For a destructive job that trade is worth 79 queries on the 31.6k customer cache. Batch size is 400 because the REST query endpoint is a GET and the SOQL rides in the URL against Salesforce's ~16 KB cap.

**The tests killed my first safety rail, which is the useful part of this entry.** I gated a mass purge on ghosts exceeding 20% of rows checked — and half the suite went red, because one ghost out of two rows is 50%. The roofing cache holds exactly one row, where any ghost is 100%. A ratio-only rail blocks precisely the ordinary small purges the feature exists for, while the mass-wipeout case it guards against is always high-volume. The rail now needs **both** ≥25 ghosts and >20%, with `force: true` to override.

Also documented: the **deletion blind spot** in caching-architecture.md, including that a **full resync does not fix ghosts** — the natural instinct, and a no-op here, since re-upserting live records leaves the ghost untouched.

18 new tests (130 total, all green) covering ghost removal, live rows untouched, 15-char cache id vs 18-char SF id in both directions, case-sensitive comparison, errored batches leaving ids alone, the rail refusing and `force` overriding, dry run, batching arithmetic, watermark untouched, and an unqualified invoke never deleting. D-051.

**Not deployed — the operator runs `deploy.ps1`.**

## 2026-08-10 — LIST reads blew Lambda's 6 MB response cap; rows are now projected (NOT DEPLOYED)

`GET /sf/solar?limit=5000` was returning **502** on every attempt. CloudWatch showed nine `RequestEntityTooLarge` events — `LAMBDA_RUNTIME Failed to post handler success response. Http response code: 413. {"errorMessage":"Exceeded maximum allowed payload size (6291556 bytes)"}`. Fallout from raising `MAX_LIMIT` to 5000 earlier the same day; the 6 MB cap was always that decision's real ceiling (D-050) and solar crossed it.

**Two things made this hard to see, both worth remembering.** The cap applies to the **serialized response object, not the body string** — the body is a JSON string nested inside `{statusCode, headers, body}`, so every quote is escaped a second time (~9% on solar). And **the same request passes or fails depending on cache freshness**: a stale page's rows are rebuilt from Salesforce by `mapSfRecordToCacheRow`, which omits null fields, while a fresh page serves cache rows with `"column":null` spelled out. My first test of `solar?limit=5000` returned 200 at 3.65 MB precisely *because* it was stale and refreshing; once those rows were fresh the identical request 502'd three times running.

**The obvious fix does not work, and measuring said so before any code was written.** Excluding long-text columns takes solar from 6.14 MB to **6.02 MB — still over the 6.00 MB cap**. `notes` is only ~1.4% of that payload. What actually carries it is dropping **null-valued keys**, which were **34.8%** of the solar payload: 6.14 MB → **4.04 MB**. The premise that individual columns run 10–30 KB per row did not hold either — the fattest column in the customer cache averages ~105 bytes/row, and the cache tables have no `*_notes` or `*findings*` columns at all, only `notes`.

Both reductions shipped, applied to **LIST and SEARCH only**: an explicit PostgREST select (`buildListSelect`) that keeps every control column, plus `projectListRow` dropping nulls and excluded columns. The projection runs **after** the freshness partition has read `is_stale`/`last_synced_at`/`cache_version` and **after** the full refreshed rows are upserted, so the cache still stores `notes` for the detail view — only the response drops it. Refreshed rows are projected too; they come from Salesforce and would otherwise smuggle long text back into a list.

Untouched by design: the single-record read (the detail view needs every column) and the live-Salesforce fallback paths.

**Null omission is not a new response shape** — every `source: "cache+salesforce"` page has served null-omitted rows since the cache was built, so callers already handle absent keys. It is now consistent across all list rows. Documented in api-endpoints.md as a contract, with the `??`/`||`/`?.` caveat.

Guard checks before excluding anything: grepped the harmon-crm frontend — the only `notes` references are in `customer-detail-config.ts`, `solar-detail-config.ts` and `SolarProjectDetailPage.tsx`, all detail-path readers. No list, board, table or filter component touches it. Generated select lists verified against live PostgREST for all five cache tables (200, control columns intact). 112 tests green.

**Not deployed — the operator runs `deploy.ps1`.**

## 2026-08-10 — G2 intermittent 500s: the root cause was an AWS quota, not our code; list page cap 500 → 5000

**The Sales list's intermittent 500s under concurrent paged loads were AWS Lambda throttling.** This account's **"Concurrent executions" quota in us-west-1 is 10**, not the AWS default of 1000 — the unraised new-account limit, shared across all 32 functions. The 11th simultaneous invocation is rejected with `TooManyRequestsException` *before the function starts*, and API Gateway renders that as `500 {"message": "Internal server error"}`.

The tell was in the body all along: that text is API Gateway's, and `sundial-sf-query` returns `{"error":"server_error"}`. The 500s were never ours. Confirming metrics: `ConcurrentExecutions` Max pegged at exactly **10.0**, `Throttles` at 20/16/41/14 per minute under real frontend traffic, **`Errors` flat 0.0**, and zero matching log lines. Reproduced deterministically — 12 parallel `limit=500` at varied offsets, **exactly 10 succeed and 2 fail, every round**. That also explains the frontend's 63–71 ms failures (no DB work happens), random failing offsets, and success on retry.

**Both connection hypotheses in the handoff were wrong, and worth recording so nobody re-opens them.** The Lambda reaches Supabase through `@supabase/supabase-js` — **PostgREST over HTTPS**. There is no `pg` connection and no pool to exhaust. The client, the Secrets Manager parse, the Salesforce token and the JWKS set were already module-scope cached and reused across warm invokes.

**The page cap was the disease, and it is now 5000** (default 500 when `limit` is absent; was 50). At 500 the frontend needed 64 round trips to sweep 31.6k customers, which is what pushed it past a ceiling of 10 in the first place. At 5000 the sweep is **7 requests**.

Raising the clamp alone would not have worked. **Supabase's "Max Rows" is 1000 and silently truncates** — PostgREST answers a 5000-row request with `206`, 1000 rows, and no error, so the endpoint would have advertised a page size the cache layer quietly ignored. The list read now splits any page over 1000 into consecutive `.range()` sub-requests (exact count on the first only). It is correct whatever the dashboard setting is; raising "Max Rows" just collapses it to one round trip.

Three consequences of a 10x page also had to be handled, all found by measuring rather than guessing:
- A fully-stale 5000-row page is 25 `IN()` chunks against Salesforce. Sequentially that measured **~35s — past the 30s timeout**. Chunks now run 5 at a time; worst case measured **13.2s**.
- That fan-out meant a cold container could fire 5 simultaneous JWT bearer requests for the same integration user, so `getSalesforceToken` now coalesces concurrent refreshes onto one in-flight request — cleared on settle, so a transient auth failure can't poison a warm container.
- The cache write-back is batched, so a max-size page isn't one ~4 MB PostgREST upsert or an over-length `.in()` delete URL.

**The live-Salesforce list paths deliberately keep the old 500 cap** (cold-cache fallback, TEMP Sales-Rep restrict): SOQL `OFFSET` is hard-capped at 2000 and those paths write back every row they return. The raise is cache-path only.

Verified end to end: `limit=5000` → 5000 rows / 5000 unique ids; `limit=9999` clamps to 5000; `0`/negative/absent → 500; `offset=0` vs `offset=5000` overlap **zero** ids. Full sweep = 7 requests (5000×6 + 1600 = 31,600), and a **7-wide burst × 2 rounds ran 14 requests with 0 failures**. Every object fits Lambda's 6 MB response limit — customer ~4.4 MB worst case, solar's whole 4,476-row set in one 3.65 MB request. Deployed to prod.

**Not fixed by this work, and it should not be mistaken for fixed:** the quota is still 10. A 12-wide burst still loses 2 requests, confirmed after deploy. The 7-request sweep fits under 10 with headroom so the Sales list is safe, but the ceiling is real and shared with every other Lambda. Raising it is a Service Quotas request Tim files (punchlist **G2b**, which also covers the optional Supabase "Max Rows" bump).

**Assessed, not built:** server-side status counts for the frontend's tab badges. It is *not* the trivial aggregate it looks like — PostgREST aggregates are **disabled** on this project (`select=stage,count()` → `PGRST123 "Use of aggregate functions is not allowed"`), so it needs a tenant-scoped Postgres RPC plus a route wire. Logged as punchlist **G2c** and **deferred by Tim** — the banner disclosure is acceptable for Phase 1. When it is built, it is `stage` that drives the tab badges, not `status`.

## 2026-08-10 — Signed = Customer / Sold - Pending Review on every path; lost agreement replayed

**Manual replay of a lost signed agreement** (`4b65bf63…`, project `e46b9ccd…`). Two recoveries changed the result:
- **The real receipt time.** The original doorbell log still held it: `2026-08-07T16:56:40.736Z`. Injected straight to SQS rather than curling the doorbell, because the doorbell stamps `received_at = now` — which would have dated the contract 08-10. `Contract_Signed_Date__c` / `Sold_Date__c` are correctly 2026-08-07.
- **The financing_id**, which the agreement object does not carry. Aurora has a **List Financings** endpoint (`GET /tenants/{t}/designs/{id}/financings`) our reference never documented; it returned the `selected_in_sales_mode: true` option, so the financing mapping ran instead of being skipped.

**Premise correction:** this was *not* a dealer agreement. The customer (Nicholas Suwyn) was created 08-03 via the normal flow with Lead Source "Referral"; it dead-lettered on 08-05 only because `Aurora_Project_ID__c` hadn't been linked yet. It took the ordinary matched path — no auto-create.

Written: 9 fields + a 1.47 MB signed PDF to S3. Skipped and reported: `Financing_Type__c` (Aurora says `levelized_ppa`; org picklist is Cash|Loan|Lease — refused to guess), `Financing_Partner__c` (`financier.provider` = **palmetto**, not in the picklist, though the financing is *named* "Lightreach Solar Lease" — worth resolving which is the real partner), and `Aurora_Agreement_ID__c` (field still doesn't exist). `Proposal_Amount__c` and `Contract_Price_Per_Watt__c` both wrote **0** — faithful to Aurora's `system_price: 0` on a $0-down levelized PPA, but it will read as a zero-dollar sale in any report keyed off that field; `Monthly_Payment__c` = 207.72 is the real economics. **The notification failed**: the Lambda role lacks `ses:SendEmail`.

**Signed now sets the pipeline position on every path (Tim's call).** `Status__c` = `Customer` and `Stage__c` = `Sold - Pending Review` were previously written only on auto-created dealer records; they now apply to any `signed` event, including a pre-existing customer matched by `Aurora_Project_ID__c`. Both paths build the fields from one shared helper so they cannot drift. **This makes the Stage write the notification mechanism** — Harmon's Salesforce alerts trigger off it, which is why SES is being left unconfigured; the skip warning now says outright that a renamed picklist value stops those alerts firing. Non-signed statuses, confirmed cancellations, and Aurora-contradicted signed events deliberately do **not** move the pipeline. 6 new tests, 112 green, bundle clean — **not deployed**.

**Flagged for a decision:** with email unconfigured, `Aurora_Signed_Email_Sent__c` never gets stamped, and that field is the "signed processing complete" marker. Every duplicate Aurora delivery will therefore re-run the whole signed path (4 retrievals, PDF re-download, repeat PATCH) — idempotent, so the data stays right, but wasteful and it may re-fire the SF alerts. See TASKS.md for the two fix options.

## 2026-08-07 — Dealer imports land as Customer / Sold - Pending Review; docs/ deletion recovered

**Tim's decision on the flagged item:** auto-created dealer customers now get `Status__c` = `Customer` and `Stage__c` = `Sold - Pending Review`. Both values were describe-checked and exist in the org. `Status__c` turned out to matter more than it looked — **the org default is `Lead`**, so without setting it a closed dealer sale would have sat in the CRM as a lead. Both go through the same match-or-skip guard as `Lead_Source__c`/`State__c`: matched case-insensitively, written in the org's canonical casing, and if a value is ever renamed or removed it's skipped with a warning and recorded in `Aurora_Import_Notes__c` rather than failing a signed contract's import. Three new tests (both values missing, one missing, org-casing wins); 106 green.

**⚠️ The `docs/` folder was hard-deleted mid-turn** by something outside this session — not moved, not renamed, and not in the Recycle Bin. Recovery:
- **11 tracked files** restored with `git checkout -- docs/` (nothing was on disk to overwrite, so this was pure gain).
- **`docs/api-endpoints.md` and `docs/salesforce-schema.md`** came back at **HEAD**, losing every uncommitted edit from the last several sessions — the design-request customer route, the Lambda env-var table, the copy-to-solar endpoint, the Aurora doorbell route, and the Design Request / Aurora inbound / dealer-origination schema sections. All re-applied from the session transcript.
- **`docs/integrations/aurora-api-reference.md` and `docs/integrations/aurora-inbound.md`** had **never been committed**, so git had nothing. Both rebuilt in full from the transcript and marked with a reconstruction note at the top.

**Caveat worth knowing:** the reconstruction is faithful to what I wrote and read, but any edit made to those four files by someone else that I never saw is not in it. **Commit the docs/ tree** — two integration docs living permanently untracked is what turned a routine deletion into unrecoverable loss. The untracked scratch JSON at the repo root (`auth.json`, `worker-env.json`, `sqs-policy.json`, `doorbell-env.json`, `queue-attrs.json`) is exposed to the same risk and `auth.json` may hold credentials.

## 2026-08-07 — Dealer-originated Aurora deals auto-create the Customer (D-049; built + tested, NOT deployed)

Harmon's third-party dealers originate deals entirely inside Aurora, in Harmon's tenant. Their agreement events already reach our webhook, but no `Sundial_Customer__c` exists — so under D-048 every one of them dead-lettered, putting a dealer's *sold contract* in the DLQ instead of the CRM. A **signed** agreement for an unmatched Aurora project now creates the customer from Aurora data and continues normal signed processing.

**Step 0 — verified the retrieval surface before writing code.** The 2024.05.0 OpenAPI file Tim supplied isn't in this repo (only the distilled `aurora-api-reference.md`, which never covered Retrieve Project), so I verified against Aurora's public reference instead. Three findings changed the plan:
1. **`property_address_components` is nested under `location`**, not top-level as the brief assumed. Mapping the flat shape would have silently produced address-less customers.
2. **Dealer attribution resolves to a real NAME**, which the brief expected might be impossible. The project carries `partner_id` / `owner_id` / `team_id`, and Aurora **partners are external business user groups** (users assigned to one see only that partner's projects) — literally Harmon's dealer concept. `GET /tenants/{t}/partners` returns `{id, name}` (no single-partner GET, so list + cache 30 min); `GET /tenants/{t}/users/{id}` names the owning person as a fallback.
3. `Aurora_Project_ID__c` is **already flagged External ID**, so the create could be an atomic upsert.

**The new branch** (replaces the flat `NO_CUSTOMER_MATCH`): on an unmatched **signed** event, fetch Retrieve Project and branch on `external_provider_id` — **absent** → create (dealer origination); **present and resolves in-tenant** → *repair* the missing `Aurora_Project_ID__c` on our own customer (the `pushed_writeback_failed` case) and continue, creating nothing; **present but unresolvable** → `PROVIDER_ID_MISMATCH`, never guessed. Unmatched **non-signed** events create nothing and are **dropped quietly** — dealer pre-sale traffic was pure DLQ noise — unless they carry a provider id, which means our own broken deal and still dead-letters.

**Idempotent by construction:** a Salesforce **upsert keyed on the external id**, not select-then-create. The race in select-then-create is real under duplicate delivery and concurrent workers, and would produce two customers for one Aurora project. Ambiguity (300) dead-letters rather than looping.

**Refusing to fabricate, three times:** `State__c` is written only on a real picklist match (case-insensitive, in the org's canonical casing — their list contains the typo "Il"), else the raw value goes to the notes; the `Lead_Source__c` value `Aurora - Third-Party Dealer` doesn't exist in the org's ~200-value picklist, so it's skipped with a warning rather than misattributed to an existing partner value; and `Status__c` is deliberately left to the org default, because `Customer` vs `Opportunity` for a dealer-originated signed deal is Harmon's call. Everything retrieved but unmapped lands in `Aurora_Import_Notes__c` under an `Auto-created from…` header.

**Bug the tests caught:** after auto-creating, the existing design-vs-customer `external_provider_id` guard fired against the brand-new record id and dead-lettered the very deal it had just created. Provenance is settled from the *project* on that path, so the check is now advisory there — and if the design contradicts the project, it warns loudly (email + log, "possible duplicate") instead of stranding the customer.

**Not deployed, no live Aurora calls made.** New `lambdas/sundial-aurora-inbound/customerCreate.js`, `lib/salesforce.js » sfUpsertRecord`, `lib/aurora.js » getProject/listPartners/getUser`. 21 new tests (55 in the worker suite, **103 repo-wide**, all green); bundle clean. Tim's Salesforce to-dos in TASKS.md: two fields + one picklist value.

## 2026-08-07 — Acumatica ProjectBudget: WRITE PATH built (Gate 5b satisfied), Stages 1–5

Built the Layer-2 write path on `feat/budget-push-write` in reviewable stages (Gate 5a data + Gate 5b sign-off both satisfied). Not yet deployed — live proof-out per the runbook in `docs/integrations/acumatica-budget-push.md` is Tim's next step.

- **Stage 1 — `writeBudgetLines`:** replaced the hard guard. FRESH scaffold read (guids never cached), re-match, then abort-before-any-PUT on 0 lines / match problems / unresolved income. Per group: sum `amountField`(s) (composites via `+`, computed BALANCE income via `-`), skip-zero for expense lines, income always written, `OriginalBudgetedQty` only for HOUR lines with a real hours source. 429/5xx exponential-backoff retry; `dryRun` computes without any PUT.
- **Income sources resolved:** `GENM/BILLING` ← `Total_Material_Budget__c`; `BALANCE` ← computed `Contract_Amount__c − Total_Material_Budget__c`. Contract field verified as `Contract_Amount__c` (used by `budgetCalc.js`, the budget handler, the test fixture, and the mapping sheet) — not the look-alike `Contract_Amount_2__c`. Dry-run vs R269999: both income lines resolve (BALANCE flagged computed), 15 groups, 0 problems.
- **Stage 2 — handler modes:** HTTP `POST /projects/{recordId}/budget/push` (JWT → tenant-scoped load, gates → 409, set `Budget_Push_Status__c='Pushing'`, async self-invoke, return 202) + async worker (read values → `writeBudgetLines` → one SF write-back PATCH: `Pushed`/`Failed`, `Budget_Pushed_At__c`, `Budget_Finalized__c=true` on success only). Reconcile mode unchanged. Added a read-only `dryRunWrite` direct-invoke mode for the runbook.
- **Stage 3 — SF metadata:** `salesforce/budget-push-fields/` Workbench package adds `Budget_Push_Status__c` (restricted picklist Pushing/Pushed/Failed), `Budget_Pushed_At__c` (DateTime), `Budget_Push_Error__c` (LongTextArea). Existing `Budget_Calc_Status__c` / `Budget_Finalized__c` / `Acumatica_Project_ID__c` verified present on the live describe.
- **Stage 4 — route:** `scripts/wire-budget-push-route.ps1`, cloned from the recalc wire script (idempotent; only the `push` resource is new). Unrun.
- **Stage 5 — docs:** ADR **D-049** (direct-call trigger, relay dropped), this log, TASKS, the integration doc (write path + gates + dry-run + re-push + **live-test runbook**), and the budget fields added to `docs/salesforce-schema.md`.
- **Dependency:** `@aws-sdk/client-lambda` (self-invoke) committed via selective staging (`package.json` + `package-lock.json`, client-lambda hunks only); concurrent foreign WIP left uncommitted. **IAM:** `SelfInvokeBudgetPush` (`lambda:InvokeFunction` on self) required before the worker can self-invoke — Tim adding.

## 2026-08-07 — Acumatica ProjectBudget: InventoryID blocker RESOLVED (Gate 5a) via live R269999 harvest

Corrected `MAPPING_ROWS` from the live scaffold of the canonical sandbox project **R269999** (customer `C001311112`) — read-only reconcile, no writes. Branch `feat/budget-mapping-inventoryids`; not deployed (draft for review).

- **Root correction:** the mapping sheet's "AccountGroup" column actually held the **InventoryID**. The real AccountGroup is `BILLING`/`LABOR`/`OTHER`/`MATERIAL`. So commission lines are `LABOR·SALESCOMM`; the two `BURDENEXR` lines differ by InventoryID (`SALESCOMM` commission-burden vs `RESIDENTAL` labor-burden).
- **`MAPPING_ROWS`** now carry the full 4-part key verbatim from the harvest. **Verified clean matched-run against R269999: 18 rows → 15 groups → 0 problems** (SLPC 2→1 and GENO 3→1 sums collapse correctly).
- **`RESIDENTAL`** is the Acumatica-side misspelling — kept intentionally (a "correction" to RESIDENTIAL would break every match). `<N/A>` is a literal InventoryID value; matcher compares raw literals (confirmed — no trim/normalize).
- **Resolutions:** Geo commission → `APPT COM` (`LABOR·SALESCOMM`, appointment-setter flat commission) — **pending Harmon finance sign-off before first production write** (`PENDING_HARMON_SIGNOFF`). Audit+QA `GENA` → the `LABOR·RESIDENTAL` internal-labor line (UOM=HOUR, `GENA_Hours__c`).
- **Moved together (one commit):** `MAPPING_ROWS` (`lambdas/sundial-acumatica-budget-push/index.js`), `docs/Sundial_Solar_Budget_Fields.xlsx` (added real `AccountGroup` column, renamed the mislabeled one to `InventoryID`, filled both for all 17 rows), `docs/integrations/acumatica-budget-push.md` (reconciliation table + RESIDENTAL warning + resolutions + canonical test pair + reconcile invoke procedure + Gate 5b), TASKS.md.
- **Write path stays hard-guarded.** Throw message updated: no remaining data blockers; gated on **Gate 5b** (clean matched-run ✔ + Harmon APPT COM sign-off + Tim-approved write plan).

## 2026-08-04 — Aurora inbound: post-signature cancellation gap closed (D-048 amendment)

Yesterday's build documented a real gap: delivery order can't distinguish "genuinely canceled after signing" from "stale `canceled` delivered late", so precedence ignored the event and a canceled contract could sit in Sundial as `signed` indefinitely. Implemented the documented fix — **stop inferring from order, ask Aurora.**

On `canceled` / `cancel-pending` / `declined`, the worker now re-reads the agreement *before* applying precedence:
- **Aurora confirms it** → applied **even over a recorded `signed`** (precedence deliberately bypassed — we're no longer reasoning from order), `Aurora_Agreement_Status_At__c` stamped, and a cancellation email sent to the same recipients as the signed notification. The subject is flagged **`AFTER SIGNING`** when it contradicts a recorded signature, because downstream work may already be moving on a dead contract. Aurora's value wins even when it differs from the webhook's — a `cancel-pending` event on an agreement Aurora has already moved to `canceled` records `canceled`.
- **Aurora still says `signed`** → dropped as stale, exactly as before: nothing written, nothing sent, no false alarm.

**Kept narrow on purpose:** `error` is *not* in the set — it signals a delivery/processing fault, not that the contract is dead, so it stays rank-governed and triggers no re-read. Exact duplicates short-circuit *before* the re-read, so a redelivered cancellation costs no Aurora call and sends no second email. The notification is gated on the status actually changing, so no extra marker field was needed. A 403 while confirming is treated like every other 403: permanent, dead-lettered, never guessed.

**Cost:** one extra `GET /agreements/{id}` per non-duplicate negative terminal event — rare, and it buys a contract that cannot silently stay "signed" in Sundial after being canceled in Aurora.

**Signed path unified (same day).** The `signed` path already re-read the agreement to confirm the signature, but when that re-read showed a dead agreement it recorded Aurora's status silently — so a cancellation discovered that way was invisible while one discovered via a `canceled` event emailed. Both now send the same notification, with the same `AFTER SIGNING` flag when the record already said `signed`, gated on the status actually changing so a redelivered event on an already-canceled record doesn't re-alarm. The one test whose contract this changed was updated, plus three new cases (no-contradiction, already-canceled no-repeat, non-terminal re-read stays silent).

13 new tests (both branches, plus `declined`/`cancel-pending`, Aurora-differs-from-event, `error` exclusion, duplicate suppression, describe-guard, email failure, the 403 path, and the four unified signed-path cases); 84 across the repo, all green. Docs updated: D-048 amendment, `aurora-inbound.md`, `api-endpoints.md`, `salesforce-schema.md`, TASKS.md. Still not deployed.

## 2026-08-04 — Aurora inbound: agreement webhook → queue → worker (D-048; built + tested, NOT deployed)

Receives Aurora's `agreement_status_changed` webhook and, on `signed`, pulls the design/financing/proposal data and the signed PDF into Sundial. **Everything writes to `Sundial_Customer__c`** — no `Sundial_Solar__c` exists at signature time and this pipeline never creates one (D-047).

**Doorbell + queue + worker**, because Aurora fails a delivery that takes over **10 seconds** and auto-disables the subscription after ~48h of failures — four retrievals plus PDF generation can't fit in that budget.
- `sundial-aurora-webhook` (already existed as a log-and-ack receiver) now validates all five subscription attributes and **enqueues to SQS**, doing no Salesforce or Aurora I/O. A failed enqueue returns **5xx on purpose** — that's what drives Aurora's retry ladder; acking an event we failed to queue would silently drop a signed contract.
- `sundial-aurora-inbound` (new, SQS-triggered) does the slow work and returns partial-batch failures so only bad messages redrive to the DLQ.

**Route/secret deviations from the brief, both deliberate:** the doorbell stays at the **existing, already-deployed** `/webhooks/aurora/agreement-status` rather than a new `/webhooks/aurora/agreement` — same endpoint, more precise name, and renaming it would break the subscription URL for no gain. The shared secret still resolves from `sundial/aurora/api » webhook_token` (what the deployed doorbell has always read), with an **optional** dedicated `sundial/aurora/webhook` secret taking precedence if Tim creates one — so the token can be separated later without a code change.

**Idempotency, two layers.** Status writes dedupe on `(agreement_id, status)` and obey a precedence rank, so a late `viewed` can't regress a `signed`. The signed work is gated on `Aurora_Signed_Email_Sent__c`: set = fully processed (a duplicate does nothing at all — no retrievals, no writes, no re-download, no second email); unset = a partial run is **resumed**. Each step is independently idempotent (field PATCH replays harmlessly, PDF key is deterministic so it overwrites, email is marker-gated).

**Refusing to guess, in three places:** an unknown or ambiguous `Aurora_Project_ID__c`, or a design whose `external_provider_id` disagrees with the customer we resolved, is **permanent** → dead-letter rather than write a signed contract onto the wrong customer. `ppa`/`levelized_ppa` have no honest match in `Financing_Type__c` (Cash|Loan|Lease) and an unknown `financier.provider` is not coerced to "Other" (that would erase which lender it was) — both left unset and surfaced in the email. And on `signed` the worker re-reads the agreement: if Aurora says it's no longer signed, it records **Aurora's** status and skips the signed-only work.

**Also found/fixed:** the doorbell cached the shared secret for the container's lifetime, so **rotating the token would have required a redeploy** — and worse, would 401 Aurora once Aurora was switched to the new value. Now a 5-minute TTL (same reasoning as D-045), and a failed lookup is not cached so a fixed secret takes effect on the next delivery.

**Known limitation (documented, not solved):** neither the webhook nor the agreement object carries a status timestamp, so a genuine post-signature `canceled` is indistinguishable from an out-of-order delivery. Precedence ignores it and it needs manual handling — silently un-signing a contract on a possibly-stale event is the worse failure. In TASKS.md.

**New code:** `lib/aurora.js` (retrieval client + the 403 "not provisioned" classification + the 15-minute `file_url` rule), `lib/sqs.js`, `lib/salesforce.js » describeObject` (shared describe guard, 5-min TTL, so it isn't copy-pasted per Lambda), `lambdas/sundial-aurora-inbound/{index,mapping,notify}.js`, `scripts/wire-aurora-webhook-route.ps1`, `docs/integrations/aurora-inbound.md` (runbook: secrets, queue/DLQ/event-source-mapping commands, the exact Aurora subscription settings, DLQ triage).

**Docs:** `aurora-api-reference.md` — corrected the stale "our subscription filters to `signed`" line (it takes **all** statuses) and added the design-results mapping. `api-endpoints.md`, `salesforce-schema.md`, `DECISIONS.md` **D-048**, TASKS.md (5 new SF fields + the infrastructure Tim must create).

**Verification:** 37 new tests (14 doorbell + 23 worker), 71 across the repo, all passing; both Lambdas bundle cleanly. No deploy, no live Aurora calls, no webhook subscription created.

## 2026-08-03 — Copy Customer files to the new Solar project (DEPLOYED)

New endpoint behind the "Create Project" button: **`POST /projects/{customerId}/files/copy-to-solar`** → `sundial-list-files`. Server-side S3 `CopyObject` of `SUNDIAL/{customerId}/*` → `SUNDIAL/{solarId}/*` — bytes never pass through the Lambda. Destination is read from the customer's `Linked_Solar_Project__c` **server-side only**; empty → 400 `NO_LINKED_PROJECT`, and a link pointing outside the tenant → 400 `LINKED_PROJECT_NOT_ACCESSIBLE` (fail closed, so bad data can't write into another tenant's folder). Zero files is a 200. Idempotent (deterministic destination keys → re-run overwrites in place). Per-object failures land in `failed[]` without aborting the batch.

**Where it lives:** `sundial-list-files` (already had the S3 + tenant-gate context), rather than a new Lambda — new functions are hand-created infrastructure here, and reusing one kept this deployable today. Copy logic itself is in `lib/file-access.js » copyRecordFiles` with bounded concurrency (8 in flight).

**Files-tab question, verified not assumed:** the deployed list path is **S3-direct** (`listRecordFiles`) — confirmed in `sundial-list-files`, and `sundial-upload-file` writes no metadata either — so copied files appear immediately with no registration needed. Supabase `sundial_file_metadata` rows are still written **best-effort** (category `Copied from Customer`), matching the budget-snapshot precedent and the documented D-029 design. A Supabase outage cannot fail the copy (proven by test).

**IAM:** no change needed — `sundial-lambda-execution-role` already has `AmazonS3FullAccess` (so `ListBucket` + `Get/PutObject` on `sfsolproj/SUNDIAL/*` are covered). Worth tightening to a scoped policy someday; noted in TASKS.

**Two latent bugs found in the route-wiring scripts** (they'd have bitten every future route):
1. `--api-key-required $false` renders as `False`, which the AWS CLI rejects — and because the call was suppressed with `2>$null`, `put-method` silently no-op'd and the next `put-integration` failed with "Invalid Method identifier". Now `--no-api-key-required`.
2. The CLI's shorthand map parser splits on commas regardless of quoting, so `'OPTIONS,POST'` and the MOCK request template blew up. Now passed as JSON files — written **without a BOM**, since PS 5.1's `Out-File -Encoding utf8` adds one the CLI can't parse (same BOM trap as the `.mjs` bundle).
Also added `Assert-LastExitOk` so a script can no longer print `SUCCESS: route live` over a broken route — which is exactly what it did on the first run. Fixed in `wire-copy-files-route.ps1` **and** the not-yet-run `wire-design-request-route.ps1`; the same flaw is still latent in `wire-budget-recalc-route.ps1` / `wire-user-admin-routes.ps1` (their routes are already live, so nothing is broken today).

**Verification:** `lambdas/sundial-list-files/test.js` — 13 unit tests (mocked S3/SF/Supabase). Live: `scripts/verify-copy-to-solar-e2e.mjs` creates a throwaway customer + linked solar project + portal user + 3 S3 objects (including a name with spaces/parens and a nested path), runs the real endpoint, and asserts the copy, filename/nested-path preservation, idempotent re-run, `NO_LINKED_PROJECT`, and 401 — then deletes everything. **All 17 checks pass.** The first run left an orphaned Supabase auth user because `deleteUser` returns `{ error }` instead of throwing and the result went unchecked — the exact ORPHAN_AUTH class from the provisioning incident. Cleaned up, and teardown is now *verified* (two extra checks) rather than assumed.

## 2026-08-03 — Aurora Design Request re-plumbed onto the Customer module (D-047)

**The 2026-07-30 design-request route was unusable in the real flow.** It took a `Sundial_Solar__c` id, but **no Solar record exists at design-request time** — a Solar project is created only after the proposal comes back and docs are signed, and the design request is the step that *produces* the proposal. It verified green on 2026-07-30 only because the test used a hand-made Solar record. Nothing in the frontend ever called it, so no client was exposed.

**Now:** `POST /customers/{recordId}/design-request/submit`, `{recordId}` = `Sundial_Customer__c` id. The dormant customer path in `sundial-aurora-push` became the mainline; the Solar-resolution step is gone. **All Aurora integration operates on `Sundial_Customer__c`.**

**Live describe of `Sundial_Customer__c` (218 fields) checked every field in the spec.** All present except **`Design_Notes__c`, which does not exist yet**. Also: `Term__c` is a *multi*-select picklist (semicolon-joined), `Design_Turnaround__c`'s first value is "In Home" (not "In House"), and `Financing_Partner__c` also carries "Lightreach". Per Tim, code follows the live values; the email's field list is **describe-filtered** (5-min TTL, D-045 pattern) so a not-yet-created field is dropped from the SELECT instead of 400-ing the whole submit — `Design_Notes__c` starts flowing automatically when created, no redeploy.

**Aurora accepts almost none of the form.** Against `docs/integrations/aurora-api-reference.md`: project-create takes `external_provider_id`, `name`, `status`, `location.property_address`, and optional `customer_*`; consumption takes the 12 monthly values. **There is no Aurora endpoint that accepts a design request at all** — panel/inverter SKU, turnaround, battery, financing, offset, notes have no API home. So the notification email is not a nicety, it's the delivery channel: it carries the **full** field set and a human keys it into Aurora.

**Design correction caught in review, before first deploy: notification delivery is now separately retryable.** The original cut treated "email is always non-fatal" and "a re-submit never emails" as independent choices; together they were a trap. Since the email *is* the design request, a first submit whose email failed (SES error, env not yet configured) would leave `Sent_to_Aurora__c` stamped, the Aurora project created, nobody notified — and every re-submit returning `already_submitted` forever, with no recovery path inside the product. Fixed by splitting the markers: `Sent_to_Aurora__c`/`Aurora_Project_ID__c` mean "a project exists" (never create a second, ever); a **new `Design_Request_Email_Sent__c` DATETIME** means "a notification actually landed" and is the only thing that suppresses the email. A re-submit whose notification never landed re-sends it (`email.sent: true, resend: true`) making **no Aurora calls**. Checked the live describe for a field to reuse first — `Confirmation_Sent__c` and `Proposal_Sent_Date__c` both mean something else, so a new field it is. Describe-guarded like `Design_Notes__c`: until it exists, delivery can't be recorded and re-submits keep re-sending (`email.tracking: "unavailable"`) — silence is the failure being guarded against, and a duplicate is the cheaper error.

**Changes:**
- `lambdas/sundial-aurora-push/index.js` — customer-id route; Solar resolution and its `NO_LINKED_CUSTOMER` error removed; project-creation idempotency on `Sent_to_Aurora__c` (DATETIME) **or** `Aurora_Project_ID__c`, notification idempotency on `Design_Request_Email_Sent__c` (stamped only on a landed email, best-effort); describe cache gained a 5-min TTL; email step replaces the old "future SES" seam.
- `lambdas/sundial-aurora-push/designRequest.js` (new) — the Aurora-vs-email field split, value formatting (boolean → Yes/No, multipicklist → comma list, percent → `6.99%`, datetime → Phoenix local), the HTML/text email, and env-driven recipients.
- `lambdas/sundial-aurora-push/test.js` (new, `npm test`) — 21 tests, all passing: happy path (payload/consumption/writeback/email contents/tracking stamp), re-submit after a **successful** notification (silent) vs. after a **failed** one (re-sends, no Aurora call, stamps on success) vs. failing again (stays re-sendable), missing customer, cross-tenant rejection, `NO_TENANT`, bad id, CC set/unset, multi-recipient lists, missing `NOTIFY_TO`, SES failure, tracking-write failure, missing address, write-back failure still notifies, describe guard when the tracking field is absent (fresh module instance so it builds its own describe cache), and the old `/projects/...` route no longer resolving. Mocks at the module boundary — no network, AWS, or Salesforce.
- `scripts/wire-design-request-route.ps1` — wires `/customers/{recordId}/design-request/submit` and **deletes** the legacy `/projects/{recordId}/design-request` subtree + its invoke permission (`-RemoveLegacy`, default on). `/projects/{recordId}/budget/recalc` untouched.
- Docs: `docs/api-endpoints.md` (route rewritten, field-destination table, new **Lambda Environment Variables** section), `docs/integrations/aurora-api-reference.md` (new outbound section documenting Aurora's actual request surface + the field split), `DECISIONS.md` **D-047** (D-032's Aurora half marked superseded).

**Not deployed** — build + test only, per Tim. Deploy needs: `.\deploy.ps1 sundial-aurora-push`, `.\scripts\wire-design-request-route.ps1`, and the env vars `EMAIL_FROM` + `DESIGN_REQUEST_NOTIFY_TO` (+ optional `DESIGN_REQUEST_NOTIFY_CC`) with `ses:SendEmail` on the role. Until those are set the push works and the response reports `email.sent: false` with a reason — the email is never fatal.

## 2026-08-03 — Provisioning: end-to-end fix + live re-diagnosis (auth email via SES, D-046)

Re-opened the provisioning breakage with **live diagnostics** against prod Supabase + Salesforce. Key correction to the incident's working hypothesis:

- **Invite users are NOT missing their tenant binding.** Queried `tmurphy5213+inviteuser1` and every invite-created user directly: all have `Client__c = harmon`, `Active__c = true`, and a matching `Supabase_User_Id__c`. `sundial-user-admin` force-stamps the tenant (fail-closed `NO_TENANT`) since its first commit — there is no gap. inviteuser1's earlier "Couldn't load sales records" dated to 2026-07-23, *before* the pagination/cache-backfill fixes (5cead0b/0b7498a); it is not reproducible now.
- **Live e2e proof (`scripts/verify-provisioning-e2e.mjs`, all green):** create → temp-password login → `/auth/me` tenant=harmon → `GET /sf/customer` 200 with **31,576** tenant-scoped records → forced change → re-login → old password rejected. The temp-password chain works end-to-end today.
- **The real breakage is email delivery** — Supabase's built-in mailer doesn't deliver invites or resets. Fix = Supabase Custom SMTP via SES (now out of sandbox for `sundialcrm.com`). See `docs/integrations/auth-email-ses.md` for the exact console/dashboard steps and values (Tim runs these — Claude can't reach those consoles).

**Changes made (branch `fix/provisioning-auth-email`, backend; `fix/provisioning-auth-email` in harmon-crm, frontend):**
- `docs/integrations/auth-email-ses.md` — SES SMTP credential creation + Supabase Custom SMTP config + redirect-allowlist values + deployment-ordering warning.
- `scripts/verify-provisioning-e2e.mjs` — true end-to-end check (proves tenant scope via the live `sf-query` customer endpoint). Self-cleaning.
- `scripts/recover-provisioning.mjs` — discovers + classifies all portal users (OK / NEVER_ONBOARDED / ORPHAN_AUTH / ORPHAN_SF / NO_TENANT / INACTIVE); fix-in-place temp-password recovery (`APPLY=1`) and guarded orphan deletion (`DELETE_ORPHANS=1`). Supersedes the name-listed `recover-provisioned-users.mjs`.
- `lib/salesforce.js` — added `sfDeleteRecord` (teardown for the e2e verify; no Lambda write path uses it).
- **harmon-crm** `src/pages/settings/UserFormModal.tsx` — default credential mode flipped to **invite**; invite radio re-enabled. Deploy only AFTER SES SMTP is live (see ordering note).

**Current user state (dry-run classification):** 16 OK; 1 NEVER_ONBOARDED (`davidcoleman@harmonelectric.net`); 2 ORPHAN_AUTH (`troyjohnson@harmonelectric.net` — signed-in typo-dup of `troyjohnston`; `team+5069@nonstopautomation.com`); 1 ORPHAN_SF (`harmon@constructiveoperations.com`); 2 INACTIVE/BANNED test users. No changes applied — awaiting Tim's go.

**Also captured (Step 6 discovery, no build):** role/visibility model — roles live on `Sundial_User__c` (`Access_Level__c`, `Hierarchy_Level__c`, `Super_Admin__c`, `Parent_User__c`, `Roles__c`), mirrored subset into `public.profiles.role` for RLS. Only enforced check anywhere is `superAdmin` (gates Manage Users); **no rep/dealer record-visibility filtering exists** — reads are tenant-scoped only. Records carry `Sales_Rep__c`; user hierarchy is `Parent_User__c`. Feeds the separate visibility spec.

## 2026-08-02 — Chore: purge stale "BILL" income-task references

Docs/comments only — no functional or logic changes. Gate 5a confirmed the ProjectBudget income is TWO lines (`BALANCE` = Balance of Contract + `GENM/BILLING` = Solar Material); there is no `BILL` task. `MAPPING_ROWS` and `docs/integrations/acumatica-budget-push.md` already reflected this; three stale spots did not, and are now corrected:

- `lambdas/sundial-acumatica-budget-push/index.js`: header comment (B) now states the confirmed two-line income model and cites the real second blocker (geo commission task code) instead of "confirm BILL vs BALANCE/GENM"; the `writeBudgetLines` throw message and the reconcile `blockers[]` entry now cite InventoryIDs + geo commission task code (income removed as a blocker). The write path is still hard-guarded (throw unchanged in behavior).
- Added a one-line note at the `MAPPING_ROWS` definition explaining the 18-code-rows vs 17-sheet-rows count (income split = 2 code rows from 1 sheet row).
- `PROGRESS.md` (2026-07-21 Task 5 entry) corrected: income is no longer described as unconfirmed `BILL`.

`DECISIONS.md` untouched (no decision made); no InventoryIDs resolved; no logic touched.

## 2026-07-30 — Harmon feedback batch: describe-cache TTL, Aurora design-request route, SES scaffold

Three items from Harmon feedback.

**1. Utility Password save failure (fixed, D-045).** Root cause: `sundial-sf-update` and `sundial-sf-query` cached the SF describe forever (refresh only on 401). The describe carries per-integration-user FLS; when the budget permission set was assigned this week (granting edit FLS on fields like `Utility_Password__c`), warm containers with a pre-grant describe kept rejecting the field — and the write Lambda rejects the WHOLE PATCH if any one field is non-writable, so the entire save failed intermittently. No SF error and no reproducible failure once containers had a fresh describe (verified: every direct + deployed write path returns 200). Fix: 5-minute TTL on the describe cache in both Lambdas (a 401 still forces an immediate refresh; sf-query also clears its derived field cache on refresh). Redeployed both to flush stale containers. Security note: `Utility_Password__c` is plaintext (not encrypted, not mirrored to the Supabase cache) — flagged for a Shield/off-platform decision.

**2. Aurora "Submit Design Request" (built + wired).** — ⚠️ **SUPERSEDED 2026-08-03 by D-047:** the Solar-id route described below was unusable (no `Sundial_Solar__c` exists at design-request time) and has been replaced by `POST /customers/{recordId}/design-request/submit`. Kept for history. — The `sundial-aurora-push` Lambda (already built: JWT auth, tenant-scoped, idempotent) gained a Solar-triggered entry: `POST /projects/{solarId}/design-request/submit` resolves the Solar record's linked customer server-side (tenant-scoped) and pushes THAT customer to Aurora. Route wired via `scripts/wire-design-request-route.ps1` (budget/recalc treatment: AWS_PROXY + MOCK OPTIONS CORS + invoke permission), deployed to prod. Handler structured with a marked seam so the future "email the sales manager" step (post-SES) is additive — no route/contract reshape. Verified end to end (CORS preflight, full Solar→Customer→Aurora push + writeback, 401/400 guards); the one real Aurora project created during verification was deleted and its SF writeback cleared. Docs: `docs/api-endpoints.md`.

**3. SES groundwork (scaffold only, not wired).** Added `lib/email.js` — a shared SES v2 `sendEmail()` wrapper (env-driven `EMAIL_FROM`/`SES_REGION`/…, best-effort by default, `isEmailConfigured()` for graceful degradation). Added `@aws-sdk/client-sesv2` dependency. NOT imported by any feature yet. This is the shared sender for the design-request notify, @-mention alerts, and (optionally) Supabase Auth emails. DNS/prod-access steps handed to Tim; the `solar-portal-api` IAM user lacks `ses:*` so the domain identity must be created in-console (or grant SES perms).

## 2026-07-29 — Incident: user provisioning "broken in prod" — root cause = email delivery

Reported: newly created users can't log in, no set-password redirect, reset emails don't work. Traced the full flow; **the fast-forwarded feature/user-admin work (invite redirect + unban) is NOT the cause** — its diff only touched the `invite` branch + the ban helper, not the password path.

**Root cause: Supabase's built-in email does not deliver** to external (harmonelectric.net) recipients — so every email-dependent step silently fails. Confirmed by isolating each piece:
- **Password path works.** Replicating the Lambda's `createUser({password, email_confirm:true, must_change_password:true})` then a real anon `signInWithPassword` → **HTTP 200**, with an `email` identity. Temp-password login is fine.
- **Redirect is honored.** `admin.generateLink({type:'recovery'})` mints a valid link with `redirect_to=harmon-crm…/reset-password` — so `/reset-password` IS allowlisted; the link just never gets emailed.
- **The failures are all delivery:** invite emails (7 of this morning's 10 users were created in the frontend's *default* `invite` mode → no password set), the `/reset-password` landing (only reachable via the emailed link), and `resetPasswordForEmail`.
- Not the cause: unconfirmed users (`mailer_autoconfirm=true`), bans (none), project mismatch (frontend + backend both `qfsdpkwxahakegjnyijj`), the user-admin diff.

**Fix (email-independent, ships today):** frontend now defaults to the **temporary-password** path (proven working) and disables the invite option until real email exists; login's forgot-password copy routes users to their admin. Backend needed no change.

**Recovery (fix in place, no delete/recreate):** `scripts/recover-provisioned-users.mjs` reset a fresh temp password + `must_change_password:true` on all 10 of this morning's `@harmonelectric.net` accounts (the linked `Sundial_User__c` records are untouched). Credentials written to a local file for secure hand-off; spot-checked one live login (HTTP 200, force-change flag set).

**Verification:** `scripts/verify-provisioning.mjs` — create → temp-password login → force-change gate fires → set new password + clear flag → re-login with new password → old password rejected. All 7 checks PASS against the live project.

**Follow-up (confirmed, NOT built here): wire real transactional email (AWS SES)** for Supabase Auth (invite + reset) — also needed for mention emails. Until then, invite/self-service-reset stay disabled and provisioning is temp-password only. See TASKS.

## 2026-07-28 — List/board ordering by record created date (newest first)

Lists/boards were ordered by `last_synced_at`, meaningless after a bulk backfill (all rows synced at once). Switched to record created date so the ~500 rendered are the most recent.

- **Schema (Tim ran in Supabase):** added `created_date timestamptz` to `sundial_customer_cache`, `sundial_solar_cache`, `sundial_roofing_cache` + a tenant-scoped index `(client_sf_id, created_date DESC NULLS LAST, sf_id)`.
- **Mapping (`sundial-cache-sync` + `sundial-sf-query`):** `created_date` = first non-empty of an ordered source list — `CreatedDate` for most objects, **`COALESCE(Contract_Date__c, CreatedDate)` for Solar** (3,025/4,545 solar rows have no `Contract_Date__c`, so they fall back to `CreatedDate`). Source fields are force-selected; written only when the column exists.
- **List endpoint ORDER BY:** `created_date` DESC NULLS LAST, then `sf_id` (stable tiebreaker). **Resilient:** orders by `created_date` only when the cache actually has the column (introspected), else stable `sf_id` — so a missing column can't error the query and dump lists onto the slow Salesforce cold path.
- **Backfilled + verified:** created_date 0 nulls on all three caches; solar COALESCE confirmed (contract-date row vs created-date fallback); live API returns `source=cache`, newest-first, correct totals, paged. Deployed `sundial-cache-sync` + `sundial-sf-query`.
- **Gotcha logged:** a first backfill wrote nothing because the `ALTER TABLE` hadn't landed on the backend project (`qfsdpkwxahakegjnyijj`); a direct `SELECT created_date` returned Postgres `42703`. Fixed once the column was added; the resilient ORDER BY meant prod never errored in the interim.
- **Frontend:** no change needed — tables default to no client sort (preserve incoming order) and boards preserve order within each stage column, so the backend order flows straight through (confirmed by read-only review).

## 2026-07-28 — Fix: list views capped at 50 + cache holding only a fraction of a bulk load

Priority bug: after a ~40k-record bulk load, Customers and Solar list views showed exactly 50 each. Traced the whole pipeline — the "50" was TWO stacked defects plus an incomplete cache.

- **Root cause A — `sfQuery` never followed `nextRecordsUrl`** (`lib/salesforce.js`). Salesforce REST returns ≤2000 rows per page; the helper returned only page 1, silently truncating every large read. Fixed to page the query locator to exhaustion (optional `maxRecords` cap). This is the linchpin — it capped cache-sync and any SF fallback.
- **Root cause B — list endpoint page-size cap** (`sundial-sf-query`): `DEFAULT_LIMIT=50`, and the cache query did `.limit(50)` with **no offset and no total**. Rewrote `handleListRead` as real server-side pagination: `?limit`(≤500)+`?offset`, `count:"exact"` → `total`, stable `ORDER BY sf_id` (pages don't shift on re-sync), per-page freshness refresh only (never scans the 32k table), `{ total, limit, offset, hasMore }` in the response. Page-aware cold-cache SF fallback added. Generic across all allowlisted objects.
- **Root cause C — cache incomplete**: incremental sync pulled one 2000-row batch per run (watermark chipping), so the customer cache held 12,450 of 31,948. Added a **full-resync mode** to `sundial-cache-sync` (`{ "mode": "full" }`, optional `object`) that ignores the watermark window and pulls every record via the now-paginating `sfQuery`; removed the per-run `LIMIT` (also fixes a SystemModstamp-tie page-split bug). Bumped the function to **900 s / 1024 MB**.
- **Backfill run + verified:** customer 12,450→**31,948** and solar 4,017→**4,545** — both now **match Salesforce exactly**. Paginated API verified live with a real token: `offset=0`/`offset=100` return distinct pages, every response carries `total=31948`, `limit=999999` caps at 500.
- Deployed: `sundial-cache-sync`, `sundial-sf-query`. Docs: `api-endpoints.md` (paged shape), `caching-architecture.md` (full-resync runbook).
- **Frontend (harmon-crm) — NOT changed here; report handed off:** the list pages fetch once with no params (→50) and group all rows client-side; boards would try to render 40k cards. They need to send `limit`/`offset`, read `total`, add a pager/load-more, and switch boards to per-stage counts+lazy loading. Full change list in the bug report.

## 2026-07-23 — sundial-user-admin: invite redirect + unban hardening

Two fixes on `feature/user-admin`, both deployed (`CodeSha256 xvyFLarP…`).

- **Invite redirect:** `inviteUserByEmail` now passes `redirectTo` → `<PORTAL_BASE_URL>/reset-password`, so invited users land on the set-password page. `PORTAL_BASE_URL` is a Lambda **env var** (defaults to `https://harmon-crm.vercel.app`); at go-live, set it to Harmon's real domain — a config change, no code edit/redeploy.
- **Unban hardening:** investigated a reported "reactivated but still banned" case. The unban primitive and the exact flow logic both work end to end (ban → fresh login `400 user_banned` → unban → fresh login `200`); the earlier verify only checked `/auth/me` with a *cached* JWT (reflects SF `Active__c`, not the ban), so it never exercised login. Root-cause hypothesis: a transient `updateUserById` failure flagged-but-swallowed, leaving the ban stuck. Fix: `setSupabaseBan()` retries the ban/unban 3× with backoff; still non-fatal (SF `Active__c` is source of truth), still surfaced via `supabaseBanFailed`. Commits `c849fa5` (unban), redirect + docs follow.
- Docs: `api-endpoints.md` POST (redirect + `PORTAL_BASE_URL`) and PATCH (retry) notes updated. Deployed-API end-to-end re-verify skipped per Tim; flow logic proven locally.

## 2026-07-23 — User management backend: sundial-user-admin (D-044)

Built the D-043 admin surface: a new `sundial-user-admin` Lambda for Super Admins to list/create/update/deactivate portal users. On `feature/user-admin`.

- **Auth:** every route runs `resolveIdentity` then requires `user.superAdmin === true` (fail closed → 403 `NOT_SUPER_ADMIN`); tenant-scoped on `Client__c` from the token. `Super_Admin__c`/`Client__c`/`Supabase_User_Id__c` never writable from input; email not PATCH-editable; self-deactivation blocked.
- **POST** = duplicate-guard (409) → Supabase auth (`invite`|`password`, reuses an existing auth user by email) → `Sundial_User__c` create (force-stamped `Client__c`), with a **compensating auth-user delete** if the SF create fails after a fresh auth user was made (`orphanAuthUser: true` if the delete also fails).
- **PATCH** = whitelisted fields; `active` toggles the Supabase **ban** (defense-in-depth, non-fatal → `supabaseBanFailed`). Salesforce `Active__c` is the source of truth.
- Reuses existing libs only (`lib/identity`, `lib/supabase` service-role, `lib/salesforce` `sfCreateRecord`/`sfUpdateRecord`, `lib/http`). No new npm deps. Bundles clean (2.0 MB).
- **`scripts/wire-user-admin-routes.ps1`** written (AWS_PROXY GET/POST on `/admin/users`, PATCH on `/admin/users/{id}`, + OPTIONS; ASCII/`Continue`/exit-code-checked, mirroring the corrected budget wire script). Committed `6c06f77`.
- Docs: `api-endpoints.md` "Admin — User Management" section; DECISIONS.md **D-044**.
- **Pending (needs Tim):** create the `sundial-user-admin` Lambda function; explicit go-ahead to run the wire script (live prod gateway) + `deploy.ps1`; a Super-Admin token to run the end-to-end verify (GET/POST/PATCH + 403 for non-super-admin + `USER_INACTIVE` on the deactivated user's `/auth/me`).

## 2026-07-22 — Portal identity: access-control fields (Access_Level__c, Super_Admin__c)

Extended the portal identity to carry the new access-control fields (UI gating only; enforcement is a later frontend task + future user-admin endpoints).

- **Verified live** (describe against `Sundial_User__c`): `Access_Level__c` (picklist: Executive, Manager, Admin, Sales Dealer, Sales Rep, Technician), `Super_Admin__c` (boolean), and `Default_Department__c` (picklist: Residential Solar, Roofing, Service, Commercial) all exist. `Default_Department__c` confirmed present, so it's included.
- **`lib/identity.js`**: added the three fields to `USER_FIELDS` and to the returned `user` object — `accessLevel`, `superAdmin` (strict `=== true`, fail closed), `defaultDepartment`; JSDoc updated. Also verified the full `USER_FIELDS` SELECT runs against SF (no `INVALID_FIELD`, so `/auth/me` can't 500 on the new fields).
- **`sundial-auth-proxy`**: no structural change — it returns `identity.user` as-is, so the fields flow automatically. `upsertProfile` left unchanged: confirmed `public.profiles` has **no** `access_level`/`is_super_admin` columns, and Supabase schema changes are out of scope.
- **Deployed only `sundial-auth-proxy`** (CodeSha256 `R20Q4NUY1hqO…`, settled). Other Lambdas bundle `lib/identity.js` but none read the new fields — they pick up the change on their next routine deploy.
- **Docs**: corrected the stale `/auth/me` example in `docs/api-endpoints.md` (removed fictional `roles`/`enabledModules`/`sundialUserId`, the slug `tenantId`, and the "Skeleton deployed" note) to the real `{ user{…, accessLevel, superAdmin, defaultDepartment}, tenant{clientId} }` shape. Added **DECISIONS.md D-043** (the access model).
- **Pending**: live `GET /auth/me` curl needs a valid portal-user Supabase token (Tim to supply). Guardrails honored: no changes to other Lambdas, caching, or API Gateway; `Super_Admin__c`/`Access_Level__c` are read-only everywhere.

## 2026-07-21 — Budget calculator: deployment & integration (parallel build)

Integrated the verified budget calculation engine (`budget-lambda.zip`) into the repo
and built the surrounding wiring. Design unchanged — deployment/integration only.

**Lambda (`lambdas/sundial-budget/`)**
- Placed the package under our `lambdas/<name>/` convention (spec said `lambda/budget/`).
- `npm install` + `npm test` → **32/32** field checks against the HOLLAND workbook. `budgetCalc.js` untouched.
- Rewrote `handler.js` to ESM using `lib/salesforce.js` (org-standard JWT bearer flow); **dropped jsforce**. Reads via `sfQuery`, writeback via a new shared `lib/salesforce.js » sfUpdateRecord`.
- Template: kept `template/budget-template.xlsx` as source of record; `prebuild.mjs` base64-embeds it into the bundle at deploy time, `postbuild.mjs` cleans up; `deploy.ps1` gained generic pre/post-build hooks. Tests read the source `.xlsx`, so tested == shipped bytes.
- Bundle validated via esbuild (3.6 MB after dropping jsforce; 4.5 MB with the added libs).

**Task 2 — recalc endpoint:** handler HTTP path now verifies the Supabase JWT (`resolveIdentity`) and tenant-scopes the record read; documented `POST /projects/{recordId}/budget/recalc` in `docs/api-endpoints.md`; gateway wiring delivered as `scripts/wire-budget-recalc-route.ps1` (not yet run against prod).

**Task 4 — file metadata:** added best-effort `lib/file-access.js » registerFileMetadata`; handler registers each snapshot (category "Budget") in Supabase. Flagged: the deployed Files tab lists from S3, so the snapshot already appears; this aligns with the documented Supabase-backed design.

**Task 3 — triggers:** drafted the after-save Flow `salesforce/flows/Sundial_Budget_Recalc_Trigger.flow-meta.xml` (loop guard on `Budget_Last_Calculated__c`; entry split into two sub-3900-char formulas since 73 `ISCHANGED` terms exceed the formula limit) + `docs/integrations/budget-recalc-relay.md`.

**Task 5 — Acumatica ProjectBudget:** built read + reconcile scaffolding only (`lambdas/sundial-acumatica-budget-push/`, `lib/acumatica.js » getAcumaticaEntity`). **Write path hard-guarded off** — the mapping tab has no `InventoryID` column (match key not unique). Income is confirmed as TWO lines — `BALANCE` (Balance of Contract) + `GENM/BILLING` (Solar Material), no `BILL` task (Gate 5a; corrected 2026-08-02). Documented in `docs/integrations/acumatica-budget-push.md`.

**Housekeeping:** moved `budget-lambda.zip` + `sundial-budget-deploy.zip` into git-tracked `artifacts/`; added `exceljs` to root deps.

**Pending:** AWS function `sundial-budget` creation (Tim) → deploy → Gate 2 smoke test; prod API Gateway route deploy; relay wiring; the blocked-on-Harmon items in TASKS.md.

## 2026-08-12 — Auth email delivery fixed (E1/E2 closed); secure password change wired

**Root cause of the email outage:** the Supabase custom-SMTP **username** was never an
SES credential. It held `aW5wLWt1NnhraHhzbjdmcTZ1cG9ybXNpbHQ3Nw==` — base64 for
`inp-ku6xkhxsn7fq6upormsilt77` — where SES requires the 20-character `AKIA…` access key
ID. Host, port, and sender were correct throughout, which is why repeated inspection
kept missing it. SES itself was healthy the entire time.

**Bisect that found it.** Sent around Supabase entirely before touching its config:
a direct `lib/email.js` SDK send **delivered** (SES identity, production access, and
delivery all fine; suppression list empty), then a raw SMTP session with a freshly
minted credential authenticated and sent on **both** 465/implicit-TLS and
587/STARTTLS. Everything below Supabase worked, which localized the fault to the one
field nobody had checked against what SES actually expects.

Two signals had been misread and cost weeks:
- `200` from `/auth/v1/recover` was taken as proof of sending. It only means Supabase
  accepted the request; with custom SMTP off, the built-in sender 200s and then fails
  to deliver. The earlier `535 → 200` was a toggle flip between two broken paths.
- "Zero sends in SES metrics" was nearly written off as lag. It isn't —
  `SentLast24Hours` and CloudWatch update within ~2 min, confirmed against a
  known-good send.

**Fix.** Created IAM user `sundial-ses-smtp` (inline `SesSmtpSending`:
`ses:SendRawEmail` + `ses:SendEmail`), derived the region-salted SMTP password, and
verified it over real SMTP *before* it went into Supabase. After the swap,
`/recover` went **500 → 200** with a matching SES Send + Delivery datapoint.

**Second bug, found while verifying the first.** Supabase secure password change
(`GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD`) is ON, so
`updateUser({ password })` returned 400 `current_password_required`. This broke the
settings-menu change and — worse — the **mandatory first-login change**, dead-ending
every user provisioned by the temp-password fallback. `/reset-password` was unaffected:
recovery-token sessions are exempt, verified by minting and redeeming a real recovery
link rather than trusting the docs. `ChangePasswordModal` now collects and sends
`current_password`, with error mapping keyed on `AuthError.code` — GoTrue returns
identical text for a *missing* vs an *incorrect* current password, so message matching
would have told users who mistyped to retype what they already typed.

**Verification.**
- `verify-provisioning-e2e.mjs` — 12/12 PASS, including a new negative check that the
  update is still rejected *without* `current_password` (so the control can't be
  switched off silently).
- Full invite loop through the deployed API: `POST /admin/users` (invite mode) → 201 →
  auth user created → link redeems → password set with no current password → login →
  `/auth/me` resolves harmon → Sales list loads (total=3526). Invite email confirmed
  **Delivered** in SES, zero bounces. All test records torn down; provisioning census
  back to its exact baseline.

**Shipped.** harmon-crm `main`: `ChangePasswordModal` fix + the gated invite-default
flip (`ef97e61`), ungated now that delivery is proven. sundial-core `master`: e2e
verifier update. Docs: D-052, `docs/integrations/auth-email-ses.md` rewritten with the
root cause and the two traps, punchlist E1/E2 closed with E2a added.

**Known, deliberately not fixed:** custom MAIL FROM on `sundialcrm.com` is
`mail.sundialcrm.com.sundialcrm.com` (doubled suffix, `HOST_NOT_FOUND`). SES falls back
to `amazonses.com` so mail flows, but SPF alignment is broken. Revisit if inbox
placement suffers.

### 2026-08-13 — Auth links reported "expired" on arrival; deliverability fixed

Delivery worked, but invite/reset links failed on click — one at 5 minutes, one under
a minute. **Not expiry:** a link redeemed at t=0 works and carries `expires_in=3600`.
Recovery links are **single use**, and mail security scanners prefetch every URL in a
message, so the scanner's GET spends the token and the human then gets
`#error=access_denied&error_code=otp_expired`. Reproduced exactly by GETting a link
once and then "clicking" it. Elapsed time was never the variable — which is why both
attempts failed identically at very different delays.

**Fix — deferred redemption.** `/reset-password` now accepts
`?token_hash=…&type=recovery|invite` and redeems it (`verifyOtp`) **only on form
submit**. Loading the page redeems nothing, so a fetch-only scanner *or* one that
executes the JS cannot burn the link; only a human who types a password and clicks
can. Verified: the token survived three prefetches, then verified (200) and set a
password (200). Legacy hash-session arrivals still work for links already in inboxes.
The token is stripped from the address bar after capture, and a spent token now lands
on the invalid state rather than leaving the user retyping into a doomed form.

**This is inert until the Supabase email templates emit the new shape** —
`{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery|invite` — which is Tim's
dashboard step. Templates are now load-bearing: reverting one to
`{{ .ConfirmationURL }}` reintroduces the bug and presents as "expired link".

**Deliverability.** Mail was landing in Junk. The apex SPF is Outlook-only
(`-all`, no SES), and the custom MAIL FROM was `mail.sundialcrm.com.sundialcrm.com` —
a doubled suffix that could never resolve — so SES fell back to `amazonses.com` and
SPF passed without *aligning*. The DNS for `mail.sundialcrm.com` was already correct
(MX → `feedback-smtp.us-west-1.amazonses.com`, TXT `v=spf1 include:amazonses.com
~all`); only the SES side was wrong. Repointed → `MailFromDomainStatus: SUCCESS`. SPF
now aligns, DKIM already passed, DMARC satisfied on both.

**Outstanding (Tim): RESOLVED 2026-08-18** — the duplicate DMARC record was deleted; `_dmarc.sundialcrm.com` now publishes a single policy. (Original finding below.)

**Outstanding (Tim):** `_dmarc.sundialcrm.com` publishes **two** conflicting DMARC
records (`p=quarantine` and `p=none`). More than one is invalid — receivers treat the
domain as having no policy. One must be deleted in GoDaddy DNS.

**Corrections to the previous entry:** `PORTAL_BASE_URL` on `sundial-user-admin` was
already set to `https://sundial.harmonelectric.net` (checked before touching it; no
change made). That custom domain — not `harmon-crm.vercel.app` — is prod; both are
live and serving.

## 2026-08-17 — Aurora signed-agreement mapping: lease/PPA financing fields

Extended `buildSignedFieldMap`'s financing mapping with the three lease/PPA fields
that were coming back from Retrieve Financing and going nowhere.

| Aurora | Salesforce | Notes |
|---|---|---|
| `solar_rate` | `Energy_Rate__c` | the customer's $/kWh energy rate |
| `escalation` | `Escalator__c` | annual escalation on that rate |
| `monthly_payment` | `Monthly_Payment__c` | **was already implemented** — see below |

All three are lease/PPA-only in Aurora's response, so they sit on the non-loan branch
and are simply absent for cash and loans. All three exist on the org (describe-verified
2026-08-17) and all three pass through the worker's existing describe guard
(`filterToExisting`), so a later rename drops the field from the PATCH and names it in
the notification email instead of failing the write-back.

**Doc/code reconciliation.** The task flagged a contradiction and it was real:
`aurora-api-reference.md` said both "`Monthly_Payment__c` ← `monthly_payment_first_month`
(loans) or `monthly_payment` (lease/ppa)" **and** "Everything else (monthly payments,
savings, incentives) is NOT mapped in v1." The second was stale text from the
2026-07-23 round, superseded by the 2026-08-03 design-results approval; the code has
written `Monthly_Payment__c` on both branches since then. Corrected the doc rather
than the code — no behaviour change for that field. Savings and incentives really are
still unmapped.

**`solar_rate` is not price-per-watt.** It is $/kWh; `Solar_Price_per_Watt__c` is
contract amount ÷ system watts, which this pipeline already writes as
`Contract_Price_Per_Watt__c` from `system_price / system_size_stc`. Conflating them
would put a ~$3 figure in a ~$0.14 field, so the distinction is called out in the code
comment, the API reference, and the schema doc.

**`escalation`'s unit is unverified, and that is deliberate.** `Escalator__c` is a
Salesforce PERCENT field, which stores the percentage itself (`2.9` = 2.9%). Aurora's
docs never say whether `escalation` is a percentage or a fraction, and Aurora is
demonstrably inconsistent — `energy_production.annual_offset` comes back as the
**string** `"87%"`. Rather than invent a ×100, the value is written through unchanged
and the worker warns when it is `0 < x < 1`, which is the fraction tell (real
escalations are 1–5%). The warning fires never if Aurora sends percentages, and once
per lease deal if it sends fractions — self-resolving either way. TASKS.md carries the
follow-up to settle it against the first real payload and then delete the warning.

**`upfront_payment` deliberately not mapped**, per the task: Aurora defines it nowhere,
and "prepayment that lowers the monthly" vs. "due at signing" belong in different
fields. `Down_Payment_Amount__c` is the tempting target and the wrong one if it's a
prepayment. Code comment + TASKS.md entry record why.

**Flagged for Tim (not fixed here):** `Energy_Rate__c` is Currency with **scale 2**, so
a `$0.1425/kWh` rate stores as `0.14` — ~1.8% off on a customer-facing number. Widening
it to 4 decimals is a one-field Setup change; noted in TASKS.md and the schema doc.

**Tests:** 8 new (lease writes all three; loan writes none of them; PPA still gets them
even though `Financing_Type__c` can't map; absent keys write nothing without blanking
the rest; `upfront_payment` reaches no field; the fraction warning fires and a normal
percentage raises none; missing-from-org fields are dropped, reported, and non-fatal).
150 green across the repo. Also added a `ctx.describeExclude` hook to the test harness
so the describe guard can be exercised on fields that *do* exist today.

No deployment yet — `sundial-aurora-inbound` is still undeployed and its subscription
uncreated (unchanged by this work).

## 2026-08-17 — Go-live: aurora-inbound + welcome-call deployed, routes wired

**Merged and pushed** `feature/aurora-financing-fields` and `feature/welcome-call-lambda`
into `master` (this repo's mainline), then deployed — merge, push and deploy in one
pass, per CLAUDE.md.

**Caught on merge: two red tests the branch recorded as green.** The welcome-call suite
was 74/76, not 76/76. Both failures were the platform-event path through `handler`,
which takes no clock injection and reads `new Date()` inside the eligibility guard —
so they pass during Phoenix business hours and fail every evening, because the guard
correctly refuses to dial at 22:00 (the customer is skipped, no call is placed, nothing
throws). The **product code was right**; the tests were reading the wall clock. Fixed by
freezing the clock at `IN_WINDOW` via `mock.timers` with a try/finally so a failure
can't leak a frozen clock into the rest of the suite. 226/226 green — verified at 22:00
local, the hour that used to fail.

**Deployed:**
- `sundial-aurora-inbound` — infrastructure verified present first (both SQS queues,
  event-source mapping **Enabled** with `ReportBatchItemFailures`, 60s/512MB/arm64), so
  this was a code push only. Now carries the lease/PPA financing fields.
- `sundial-welcome-call` — **did not exist in AWS**, and `deploy.ps1` deliberately never
  creates functions, so the shell was created first (Node 22 / arm64 / `index.handler` /
  `sundial-lambda-execution-role` / 60s / 512MB) and the code deployed onto it.

**Routes live.** `wire-welcome-call-routes.ps1` needs `-Yes` in a non-interactive shell —
without it the routes are created but never deployed, and it says so rather than
pretending. Before deploying the stage I checked what else would ride along, since a
REST API deployment snapshots the **whole** API: `budget/recalc` was already live, so
only the two new routes went live. Verified against the live URLs:

| Request | Result |
|---|---|
| `POST /webhooks/retell` unsigned | **401** `{"error":"unauthorized"}` |
| `POST /webhooks/retell` bad signature | 401 |
| `POST /welcome-call/orphan-match` no secret | 401 (fails closed) |
| `OPTIONS /webhooks/retell` | 200 |

Both gates reject before doing anything. The first unsigned probe returned API Gateway's
403 `Missing Authentication Token` for ~a minute after `create-deployment` — stage
propagation lag, not a wiring fault; it settled to 401 on retry.

**`Energy_Rate__c` is still `currency(18,2)`.** The widening to 4 decimal places was
reported done but has **not** taken effect: a forced-refresh describe in a fresh process
(so no in-process cache) still returns scale 2, and there is no `Energy_Rate__c` on
`Sundial_Solar__c`, so it didn't land on another object either. TASKS.md and the schema
doc record the real state rather than the intended one. Until it's changed, a
`$0.1425/kWh` rate stores as `0.14`.

**Still gated on Tim, nothing flows without them:** the `sundial/retell/api` secret and
the three config env vars; the `Sundial_Welcome_Call_Request__e` platform event and its
two publisher Flows; the Event Relay → EventBridge rule; the Retell agent + webhook
secret; and the Aurora `agreement_status_changed` subscription. Aurora's pipeline is
deployed and idle until that subscription exists.

### 2026-08-17 — Welcome Call signature verification: sign with the API key, and say why a rejection happened

Two changes after Tim flagged that **Retell signs webhooks with the API key**, not a
separate signing secret.

**1. The signing key is now the API key.** `retellWebhookSecret` resolves
`RETELL_API_KEY` first, falling back to `RETELL_WEBHOOK_SECRET` only when no API key is
configured (a webhook-only deployment). The old order wasn't causing a live failure —
Harmon's secret carries the *same* key in both `api_key` and `webhook_secret`, so either
resolution verifies today. That coincidence was the whole problem: rotate the API key
while updating only `api_key` and webhook-secret-first would have started rejecting
every delivery with no obvious cause. Note the fallback is deliberately *not* an
override — if Retell signs with the API key, honouring a different configured
webhook_secret would break verification rather than customise it.

The test fixtures encoded the old assumption, so they were reconciled rather than
patched around: `signedWebhookEvent` now signs with `API_KEY` by default, and the
fixture keeps `webhook_secret` at a **different** value on purpose — the entire
signed-webhook suite now passes only if the API key is the key actually used. Three
tests pin the precedence explicitly, including one asserting a payload signed with the
legacy secret is **rejected**. `an unconfigured webhook secret fails CLOSED` was fixed
too: an `api_key` alone is no longer "unconfigured", so it now sets an empty secret.

**2. A rejected webhook logs the header's SHAPE.** Key names and value lengths only,
plus body byte count — never a value:

```
... rejected: missing or invalid x-retell-signature. shape: parts=1 [v=len64] bodyBytes=1234
```

The gate was deliberately silent about values, which is right for security and useless
when a real delivery is rejected. The failure mode this is aimed at: if Retell sends a
compound `t=<ts>,v=<hex>` header, the parser strips only a leading `v=` and would reject
**100% of deliveries** — while all 81 tests still pass, because the suite generates the
header it expects. `parts=2 [t=len10, v=len64]` in the log names that instantly.

**Still unverified, and deliberately so:** there is no timestamp in the HMAC and no
replay window. Adding a 5-minute check against a guessed header format would break
verification outright, so it stays a follow-up until a real Retell header is observed.
The test suite validates the implementation against its own assumption — only a live
delivery settles the wire format.

231 green. Deployed to `sundial-welcome-call`.

### 2026-08-18 — Retell signature verification was wrong three ways; a real delivery proved it

The first real Retell webhook was rejected, and the shape diagnostic added hours
earlier named the cause on its first line:

```
welcome-call webhook rejected: missing or invalid x-retell-signature.
  shape: parts=2 [v=len13, d=len64] bodyBytes=1347
```

A 13-character `v` is a millisecond epoch. That identified the real header format and,
with [Retell's spec](https://docs.retellai.com/features/secure-webhook), the whole bug:

```
header  = v={unix_ms},d={hex_digest}
digest  = HMAC-SHA256(raw_body + timestamp, RETELL_API_KEY)
window  = ±5 minutes
```

**Our implementation was wrong on all three counts**, exactly as Tim suspected: it
HMAC'd the **body alone**, keyed with a separate **webhook_secret**, and read **`v=`
as the digest** when `v=` is the timestamp and `d=` is the digest. Any one of those
alone rejects every delivery. Retell had retried ~25 times across `call_started`,
`call_ended` and `call_analyzed` (bodies 1347→11770 bytes) before we looked.

**Why 81 passing tests missed it:** the suite generated the header its own verifier
expected. A test that signs the way the code reads proves the code is self-consistent,
not that it matches the wire. The fixtures now build a genuine Retell signature
(`retellSignature()`), and a regression test asserts the old body-only `v=<hex>` and
bare-hex forms are **rejected** — accepting them would also sidestep the replay window,
since neither carries a timestamp.

**Also masked by the org config:** `api_key` and `webhook_secret` hold the same value
in Harmon's secret, so the key error was invisible from the outside. Two independent
faults, one of them hidden by a coincidence.

`verifySignature` now returns `{ ok, reason }` and the timestamp is checked **before**
the HMAC (in both directions — a clock ahead is as suspect as one behind), so a
stale-but-validly-signed replay cannot pass on digest alone. Rejections log the reason
(`no_secret` / `no_header` / `malformed_header` / `stale_timestamp` / `digest_mismatch`)
alongside the shape.

234 green. Deployed.

**Lesson worth keeping:** the value-safe shape diagnostic cost about fifteen lines and
turned an unexplainable 401 into a solved problem on the first real request. Worth
having on every signed webhook before go-live, not after.

### 2026-08-18 — First live Retell webhook processed end to end

The corrected verifier passed a real delivery on the first attempt. Full run, no
rejection:

```
WARN  unrecognized event "transcript_updated" — acking.   (x3, now fixed)
INFO  orphan recording stored at
        SUNDIAL/_orphan-welcome-calls/call_f2eb80f1a2574a37a2aeede0754.mp3 (829278 bytes)
INFO  call_analyzed with no sf_record_id — forwarded to the ledger only
        (forwarded=true, recording=SUNDIAL/_orphan-welcome-calls/…)
```

Verified in S3: 829,278 bytes, `audio/mpeg`, and **exactly one** object in the holding
prefix — the ~25 rejected retries from the broken verifier never reached the archival
step, so there are no duplicates to clean up.

This exercised the **rep-form orphan path** precisely as designed: a call with no
`sf_record_id` parks its recording under the holding prefix and forwards the key to the
billing ledger, leaving the sweep to promote it onto a customer later. Retell's URL
expires; ours doesn't.

**`transcript_updated` added to the ack-only set.** Retell streams it repeatedly during
a call, and each one was logging a WARN about an unrecognized event — a long call would
have buried the real lines. It is a known event we deliberately ignore, not a surprise.
Unknown events are still acked rather than 4xx'd, so a genuinely new event type can
never push Retell into its retry ladder over something we don't care about.

**What is now proven vs. not.** The webhook half is real: signature, recording
download, S3 archival, ledger forward. The place-call half — platform event, the two
Flows, the Event Relay rule, and the eligibility guard against a live customer — has
still never run. Nothing has dialled a real number from a Salesforce trigger.

234 green. Deployed.


## 2026-08-18 — Tim's console/org backlog cleared; Welcome Call platform event in progress

Status update logged from the Chief-of-Staff session. **These are external-system
changes reported by Tim. Nothing here was independently verified against the org, AWS,
Supabase or DNS from this session** — each carries its verification step so the next
thread can close it cheaply rather than assume it.

**Reported DONE (2026-08-18):**

| Item | Was | Verify by |
|---|---|---|
| Duplicate `_dmarc.sundialcrm.com` record deleted | two conflicting policies = no policy at receivers | `dig TXT _dmarc.sundialcrm.com` returns exactly one record |
| Supabase auth email templates emit `?token_hash={{ .TokenHash }}&type=recovery\|invite` | deferred-redemption fix was **inert** without it | send a real invite; the link must survive a prefetch and still set a password |
| Supabase Site URL + Redirect allowlist includes `https://sundial.harmonelectric.net` | resets broke on the new domain | request a reset from the custom domain and complete it |
| AWS Lambda concurrency quota raised 10 → 1000 (us-west-1) | root cause of the G2 500s | 12-wide `limit=500` burst returns 12/12 (it lost 2 before) |
| `Design_Request_Email_Sent__c` created on `Sundial_Customer__c` | every re-submit re-sent the design-manager email | live describe shows the datetime field, writable by the integration user |
| `Energy_Rate__c` widened to 4 decimals | `$0.1425` stored as `0.14` | **see caution below** |

**Caution on `Energy_Rate__c`.** This is the *second* time it has been reported done. On
2026-08-17 a forced-refresh describe in a fresh process still returned
`currency(18, 2)`, and the field was absent from `Sundial_Solar__c` too — so the earlier
edit never landed anywhere. TASKS.md keeps it at `[~]`, not `[x]`, until
`describeObject('Sundial_Customer__c', { forceRefresh: true })` returns scale 4.
Salesforce silently keeps the old scale if a Currency field edit is abandoned at the
confirmation step, which is the likely explanation for the first miss.

**SES production access — confirmed, and narrower than it sounds.** AWS moved the
account out of the SES sandbox on **2026-08-03**, effective immediately in us-west-1
(support case 178572585300376). That closes step (b) of the *Wire AWS SES* task. It does
**not** close step (c): `ses:SendEmail` on the Lambda role plus `EMAIL_FROM` /
`SES_REGION` / `DESIGN_REQUEST_NOTIFY_TO` env vars are still unset, and that — not
sandbox status — is why Design Request notifications still degrade to
`email.sent: false, reason: "email_not_configured"`. The auth-email path is unaffected
either way; it goes through Supabase Custom SMTP, independent of `lib/email.js`.

**In progress:** Tim is configuring the `Sundial_Welcome_Call_Request__e` platform event
and both Flows. Until the event exists in the org and a test publish reaches the
webhook, the Welcome Call retry loop cannot run.

**Users provisioned (Harmon):** the exec users and **Brian** are created. **Jake does not
need access** — punchlist H1 is closed on that basis, not deferred.

### 2026-08-18 — Real call analysis inspected; call_summary added to the log, in_voicemail bug found

Pulled a real completed call from Retell (`GET /v2/get-call`, using the API key we
already hold) rather than reasoning from the payload we *expected* — the same check
that would have caught the signature bug days earlier.

**Good news: all ten `custom_analysis_data` keys came back exactly as named.** The
agent's post-call schema matches what the Lambda reads, so nothing is being silently
dropped for a naming reason.

Three shape facts the fixtures had wrong:

1. **`in_voicemail` is on `call_analysis`, not on the call.** The code read
   `call.in_voicemail` and got `undefined` every time. Two consequences: the log never
   recorded a voicemail, and `mapOutcomeToStatus` never saw the one signal that turns
   an empty verification result into **No Answer** — which is the status the scheduled
   retry Flow selects on. A voicemail-only call would neither read as a voicemail nor
   ever be retried. The test fixture put it at the call level, which is exactly why 76
   tests never noticed. Both paths are now accepted; the fixture matches reality.
2. **`mismatched_items` / `unconfirmed_items` arrive as STRINGS, not arrays.**
   `listToText` already handled both, so no bug — but the fixtures only ever exercised
   the array form. Tests now pin the string shape.
3. **`used_loan_for_prepaid`** is emitted by the agent and ignored by the Lambda. Real
   data with no home; TASKS.md carries the decision.

**`call_summary` now goes in the log** (`summary:`, clipped to 400 chars), per Tim. It
was deliberately omitted as "prose that would dominate the field", but it is the only
segment that says what actually *happened* rather than which checks passed, and making
someone open the Zapier ledger to find that out is the worse trade.

**The bigger finding, not yet fixed:** `mismatched_items` and `follow_up_notes` were
already captured — but **none of it reaches Salesforce for rep-form calls**, which is
all three live calls so far. They arrive with no `sf_record_id`, so the entire writeback
is skipped, and the orphan-match sweep appends only `rep-form call <id> matched,
recording attached` — it attaches the audio and backfills nothing. The analysis exists
only in the ledger. Logged as a blocked decision in TASKS.md with three options; the
self-contained one is to have the sweep re-fetch the call from Retell, since we already
hold the API key.

238 green. Deployed.

## 2026-08-19 — Rep-form call results reach Salesforce; result entries stop being truncated (D-055)

Implements option (a) from the blocked decision logged on 2026-08-18.

**The problem.** All three live Welcome Calls were rep-form: started by a rep, no
`sf_record_id`, so the entire Salesforce writeback was skipped. The orphan sweep
attached the audio and wrote one line — `rep-form call <id> matched, recording
attached` — which said a call happened and nothing about what was said. The analysis
Harmon actually needs (disputed contract values, follow-up requests, whether identity
was confirmed) lived only in a Zapier ledger built for billing.

**The fix.** `POST /welcome-call/orphan-match` now backfills the full result. The sweep
sends only `{call_id, sf_record_id}`, so the analysis is re-read from Retell
(`GET /v2/get-call/{call_id}`) rather than re-sent by Zapier — same data, same
authority the webhook used, and no new contract with Zapier. Crucially it goes through
the SAME `mapOutcomeToStatus` and `buildResultLogEntry` as the live path: a test
asserts a backfilled entry and a webhook-written one are structurally identical
line-for-line, normalising only the three things that legitimately differ (timestamp,
origin segment, recording filename). A reader — or an email alert merging the field —
must never have to know which path produced an entry.

Rules that took the most thought:
- **A terminal status is never overwritten.** A rep-form call is a *second*
  conversation with a customer whose verification may already be settled, and a sweep
  running days later must not reopen it. The entry is still appended, marked
  `(status unchanged, record already terminal)` so the reader can see why the status
  doesn't match that line's result. `Calling` is deliberately NOT terminal — it means a
  call is in flight, not that a result exists — so a new `TERMINAL_STATUSES` set was
  split out from the existing `TERMINAL_OR_IN_FLIGHT_STATUSES`.
- **`Welcome_Call_Attempts__c` is never incremented.** That counter is the retry
  ceiling for Salesforce-initiated dials; counting a rep-form call against it would
  silently consume a customer's retry budget.
- **Degrades rather than fails.** The recording is attached before the backfill runs,
  so an unreachable Retell falls back to the old one-line note and invents no status
  from a call it could not read.

**Truncation removed.** Segments were clipped at 200/300/400 chars to protect a 32k
field. That traded away the wrong thing — this text is merged into email alerts and
read by a human deciding what went wrong, and a mismatch description cut at 200
characters is exactly the half they needed. Entries are now multi-line blocks:

```
── 2026-08-19 14:32 MST · rep-form call · Result: Verified - Exceptions · call_id=…
Call Summary: <full>
Mismatched Items: <full, or "none">
Unconfirmed Items: <full, or "none">
Follow Up: <full, or "none">
Confirmations: identity=N email=N system=Y financial=Y utility=Y usage=Y
Recording: <s3 key> · Duration: 2:52
```

`Confirmations:` now shows all six flags rather than only the failures — in a block
this wide the full row is readable at a glance and answers "was this even asked?".
Empty values are written as `none` rather than omitted, so "nothing to report" is
distinguishable from "this entry predates the field". Whitespace collapsing became
load-bearing rather than cosmetic: entries are parsed back apart on the `── ` marker
when trimming, so a raw newline in a call summary would fabricate a block boundary —
there is a test that feeds a forged header through `follow_up_notes`.

**Capacity is read from the describe, not hardcoded**, and overflow drops WHOLE OLDEST
ENTRIES with a visible `… older entries trimmed …` marker. The previous
character-clipping could leave a header with no analysis under it, or analysis lines
with no header naming the call — both worse than a missing entry, because they read as
real data. A test asserts retained headers and `Confirmations:` lines stay balanced, so
no entry is ever cut in half.

**Reading the length from the describe turned out to matter immediately:**
`Welcome_Call_Log__c` is **still 32,768** in the org, not the 131,072 the change
assumed. Nothing breaks — the code trims to whatever the describe reports — and it will
pick up the larger ceiling the moment the field is saved. A hardcoded 131,072 would
have started rejecting PATCHes today.

**Fixtures rebuilt from the real Geovanna Macedo `get-call` response**, including the
two shapes that hid bugs before: `mismatched_items` as a STRING and `in_voicemail` on
`call_analysis`.

15 new tests, 251 green across the repo. Deployed.

**Outstanding:** raise the log field to 131,072 (Tim), and run the sweep against the
two recordings currently parked in `SUNDIAL/_orphan-welcome-calls/` to exercise the
backfill against real records.

## 2026-08-19 — SES wired for application email; Design Request stops degrading

Config and IAM work, not a feature build. Runbook:
`docs/integrations/ses-transactional-email.md`.

**The stale premise, corrected.** TASKS.md still recommended creating
`mail.constructiveoperations.com` as the sending identity. That text predated the
auth-email work and would have been actively harmful: `sundialcrm.com` has been a
verified SES domain in us-west-1 since 2026-08-02, out of the sandbox since 08-03, with
DKIM `SUCCESS`, custom MAIL FROM `mail.sundialcrm.com` at `MailFromDomainStatus:
SUCCESS`, and a single `p=quarantine` DMARC record since the duplicate was removed on
08-18. A second domain would have split sending reputation for no gain. Verified all of
it before touching anything; the TASKS entry and the `lib/email.js` header comment are
both corrected so the next session isn't misled.

**IAM: already granted, and left alone.** `ses:SendEmail` was NOT missing — the
execution role carries the managed `AmazonSESFullAccess`, with no inline policy
mentioning SES. A scoped `ses:SendEmail`-on-the-identity policy was drafted, but adding
it alone would change nothing (an Allow doesn't restrict) and detaching the managed
policy from a shared role was Tim's call to make — he chose to leave it. Recorded in
the runbook with the exact JSON, so tightening later is a two-command job.

Worth noting for whoever does tighten it: the ONLY SES call in the entire codebase is
`SESv2 SendEmail` with `Content.Simple` in `lib/email.js`. **`ses:SendRawEmail` is
never reached** — there is no raw-MIME path — so it does not belong in the policy, even
though the *auth* email SMTP credential does need it. Different principal, different
requirement.

**Env vars set on `sundial-aurora-push` and `sundial-aurora-inbound`:** `EMAIL_FROM`,
`EMAIL_REPLY_TO`, `SES_REGION`, `EMAIL_CONFIG_SET`, plus the notify recipients.
`sundial-aurora-push` had **no environment variables at all**, which is precisely why
Design Requests reported `email_not_configured`. Applied via JSON files rather than the
`Variables={...}` shorthand (the From value contains spaces and angle brackets, and the
shorthand treats `,` and `=` as delimiters), then re-read and diffed key-by-key against
the intended map — both matched exactly, nothing dropped.

**`EMAIL_REPLY_TO` is a per-tenant value, and that is the point.**
`no-reply@sundialcrm.com` sends fine but has no mailbox behind it, so a reply would
bounce silently. It now points at `tim@constructiveoperations.com`. The From is
correctly tenant-neutral; the reply target is not, and a second tenant must override it
or their customers' replies land in Constructive Operations' inbox. Flagged in both docs.

**Bounce/complaint tracking:** configuration set `sundial-transactional` with a
CloudWatch event destination on BOUNCE / COMPLAINT / DELIVERY / REJECT. Already
receiving data — `Delivery: 3`, `Bounce: 0`, `Complaint: 0` under the
`configuration-set` dimension. This matters more than it looks: these emails go to real
Harmon employees from a domain that **also carries auth email**, so a complaint problem
here degrades the login flow, not just notifications. No SNS→Lambda pipeline,
deliberately — the requirement was that the signal exists and someone can look at it.

**Proven on the feature path, not just in isolation.** A direct `lib/email.js` send
delivered, and a **real Design Request submit** on `A3PROOF TEST Aug12` returned:

```
"email": { "sent": true, "messageId": "011101a018ba8b73-…", "recipients": { "to": 1, "cc": 1 } }
```

Those are different claims. Every consumer is deliberately best-effort — a missing
`EMAIL_FROM` logs and continues rather than failing an Aurora push — which is the right
design and exactly why this degraded unnoticed for weeks. The runbook says to check the
feature response, not just SES.

### Found while proving it — NOT an SES problem, needs Tim

The same Design Request submit surfaced a pre-existing Salesforce fault. The Aurora push
succeeded and the email sent, but the **writeback failed**:

```
status: "pushed_writeback_failed"
CANNOT_EXECUTE_FLOW_TRIGGER — "Sundial Customer Update Flow" failed:
INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field:
"Proposal Pending"
```

`Stage__c` **does** have `Proposal Pending`; `Status__c` does **not**. So the Flow is
writing a Stage value into a Status field. Consequence: **Aurora project
`3f31d168-8847-49d6-b22f-92ae758d9efc` now exists with no link recorded in Salesforce** —
`Aurora_Project_ID__c` and `Sent_to_Aurora__c` are both still null on
`a1P7y00000AbTenEAF`. Under D-049, a signed agreement on an Aurora project no customer
carries and with no `external_provider_id` **auto-creates a customer**, so this orphan
would produce a duplicate rather than an error. Fix the Flow, then either backfill the
link or delete the Aurora project.

Docs: new `ses-transactional-email.md`; `auth-email-ses.md` and `api-endpoints.md`
cross-reference it and state explicitly that auth email and application email are two
independent paths sharing one domain. No DECISIONS entry — nothing architectural was
decided here; the identity, the two-path split and the notification design are already
D-046 / D-047 / D-056.

**Open:** `sundial-comment-notify` is the third sender and is not deployed, so nothing
was set on it; TASKS.md and the runbook carry the one-command hand-off for its deploy.

## 2026-08-19 — @-mention trigger config moved to `private.app_config` (D-056 amendment)

`sql/sundial_comment_mention_notify.sql` applied cleanly through the trigger, then
failed at the config step:

```
ERROR: 42501: permission denied to set parameter "sundial.comment_notify_url"
```

**`alter database … set` on a custom parameter is not available on managed Supabase.**
It needs superuser or database ownership; the `postgres` role is not a superuser and
`supabase_admin` owns the database. Not grantable, so there was nothing to request —
the design had to change, not the permissions.

**Rejected the tempting workaround.** `alter role authenticator set sundial.*` would
likely work, and depends on Supabase internals. A notification path that silently stops
after a platform change is the exact failure this feature exists to prevent — the whole
reason it is a database trigger rather than a browser call is that nobody notices when
somebody *else's* notification goes missing. A config mechanism documented to be
unavailable beats one that happens to work.

**Replacement:** `private.app_config (key, value, updated_at)`, read by the
`SECURITY DEFINER` trigger function.

- `private` is not in PostgREST's exposed-schema list and must stay out of it —
  adding it would publish the table, secret included.
- RLS on with **no policies** (deny by default) *and* an explicit `revoke all` from
  `anon` / `authenticated`. Two locks, because one is a single point of failure for a
  table holding a shared secret.
- The function reads it because `SECURITY DEFINER` runs as the owner and owners bypass
  RLS. So the table is deliberately **not** `force row level security` — FORCE applies
  RLS to the owner as well and would silently break every notification. That one is
  worth remembering; it looks like a hardening improvement and is a breakage.
- Reads are schema-qualified and `private` is **not** added to the function's
  `set search_path`, because widening a `SECURITY DEFINER` search_path is precisely
  what that hardening line prevents.

**Everything already right was preserved:** missing config still `RAISE WARNING`s
rather than no-oping silently (a `select … into` with no matching row leaves NULL,
exactly like `missing_ok` `current_setting()` did); the `exception when others` swallow
around `net.http_post` is untouched; trigger definition, payload shape, header name and
5s timeout are unchanged. The file remains safely re-runnable over an existing
install — `create schema/table if not exists`, `create or replace function`,
`drop trigger if exists`.

**Incidental improvement:** database settings applied to new connections only, so a
pooled deployment could lag a minute behind a change. A table read per invocation is
immediate — which makes the "pause notifications during a mail incident" operation
(`delete from private.app_config where key = 'comment_notify_url'`) actually instant.

Docs corrected rather than appended to: the SQL header's settings-vs-Vault argument is
**gone**, not annotated — it argued for an option that does not exist here.
`comment-mention-alerts.md` has the new config/verify/operate SQL and a reordered
deploy list (the migration is now inert until the config rows land, so it can be
applied early), and `api-endpoints.md` no longer tells the reader to set a database
setting. Nothing applied to the database by me — Tim runs the SQL.
