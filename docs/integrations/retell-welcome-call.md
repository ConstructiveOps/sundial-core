# Retell — Welcome Call

> The automated post-sale verification call. An AI voice agent phones the customer,
> reads back the contract terms they signed, and records what they confirmed.
>
> Lambda: `lambdas/sundial-welcome-call` · Routes: `POST /webhooks/retell`,
> `POST /welcome-call/orphan-match` · Decision: **D-054** ·
> **There is no portal UI for this feature.**

---

## Why it exists

Harmon's back office calls every sold customer to confirm the deal before the project
moves into design: the right person, the right address, the right system size, the
right money. It is a script read off the record, the same way every time, and it is
the single most repetitive call the office makes. Retell's agent makes it, using
values read fresh from Salesforce, and writes the answer back.

Two consequences shape the whole design:

1. **The values are read aloud as contract terms.** Everything the agent says comes
   from a fresh Salesforce read, never the cache, and is formatted for speech before
   it leaves the Lambda.
2. **A wrong call is worse than no call.** Every ambiguity — an unparseable phone
   number, a financing partner we can't map, a call already in flight — resolves to
   *don't dial*, with the reason recorded where a human will see it.

---

## Architecture

```
Salesforce                                AWS                          Retell / Zapier
──────────                                ───                          ───────────────
Stage__c change on Sundial_Customer__c
  └─ Flow ─┐
Retry Flow ─┴─► Sundial_Welcome_Call_Request__e   (ONE platform event, Customer_Id__c)
                     │
                     └─ Event Relay ─► EventBridge partner bus ─► rule
                                                                   │
                                                    sundial-welcome-call (entry 1)
                                                       │ fresh SOQL read
                                                       │ eligibility guard
                                                       └─────────────────────► POST /v2/create-phone-call
                                                                                        │
                                                                                   (call happens)
                                                                                        │
       Sundial_Customer__c ◄── SF update ── sundial-welcome-call (entry 2) ◄── POST /webhooks/retell
              │                                  │
       Supabase cache ◄── best effort ───────────┤
       Realtime broadcast ◄───────────────────── ├──────────────────────────► Zapier Catch Hook
                                                 │   (FIRST, always)            billing ledger
       S3 sfsolproj ◄── recording ───────────────┘                                   │
         SUNDIAL/{customerId}/…mp3                                                    │ orphan sweep
         SUNDIAL/_orphan-welcome-calls/…mp3 ◄─── promote ─── (entry 3) ◄──────────────┘
                                                POST /welcome-call/orphan-match
```

One Lambda, three entry points. The first split is **by the shape of the event**: an
HTTP event carries `requestContext.http.method` (or `httpMethod`); nothing else does.
That test is stable across every relay envelope, which matters because the relay is
configured by hand and its exact shape is not fixed in code (same reasoning as
[`budget-recalc-relay.md`](./budget-recalc-relay.md)). The two HTTP entry points are
then split by **path**, and each carries its own shared-secret gate.

### Files

| File | Role |
|---|---|
| `index.js` | Routing (event shape, then path), HTTP concerns, both auth gates |
| `placeCall.js` | Entry point 1: fresh read, eligibility guard, dial, writeback |
| `webhook.js` | Entry point 2: signature, ledger forward, outcome mapping, idempotency |
| `recording.js` | Download, S3 archival, file-metadata registration, key construction |
| `orphanMatch.js` | Entry point 3: promote a parked rep-form recording onto a record |
| `format.js` | Pure: speech formatting, finance mapping, phone, Phoenix clock |
| `fields.js` | Describe guard + logical-name → API-name candidates |
| `writeback.js` | Salesforce → cache → Realtime, and the log-field read-modify-write |
| `retell.js` | The `create-phone-call` client |
| `config.js` | Env var / Secrets Manager resolution |
| `test.js` | 76 tests (`npm test`) |

---

## Entry point 1 — placing the call

**Trigger:** the `Sundial_Welcome_Call_Request__e` platform event, field
`Customer_Id__c`, relayed via Salesforce Event Relay → Amazon EventBridge.

**Read:** `Sundial_Customer__c`, **always fresh from Salesforce**. This is an
always-fresh operation in the sense of
[`caching-architecture.md`](../caching-architecture.md) — the cache has a documented
TTL and a documented deletion blind spot, and a stale monthly payment read aloud on a
recorded call is a customer-trust problem, not a rendering glitch.

The read is **not tenant-filtered by a caller** — there is no caller. The record's own
`Client__c` scopes every write that follows, exactly as `sundial-aurora-inbound` does.

### The eligibility guard

Checked in this order. The first hit skips the call. **A skip is a success** — it
logs and returns; it never throws and never retries.

| # | Condition | Why dialing would be wrong |
|---|---|---|
| 1 | `Welcome_Call_Status__c` ∈ {`Calling`, `Verified`, `Verified - Exceptions`, `Refused`, `Failed - Max Attempts`} | `Calling` = a call is already in flight (double-dial). The rest are settled outcomes; re-calling a `Refused` customer is a complaint. |
| 2 | `Welcome_Call_Attempts__c` ≥ **5** | The harassment ceiling. |
| 3 | No parseable US phone in `Primary_Phone__c` | We would dial a stranger and read them someone else's contract. |
| 4 | Current time outside **08:00–20:00 America/Phoenix** | Calling-hours compliance. End is exclusive; Phoenix has no DST. |
| 5 | `Financing_Partner__c` doesn't map (below) | We cannot say *which* set of terms is real. |

Only #5 writes to Salesforce: it prepends
`… · Skipped · unmappable financing partner: <value>` to `Welcome_Call_Log__c` and
changes nothing else — **no status change, no attempt burned**. It is the only skip
that requires a human to change data, and nobody is watching CloudWatch for it. The
other four are transient or self-evident from the record.

Phone parsing is deliberately strict: 10 digits, or 11 starting with `1`, with valid
NANP area and exchange prefixes (2–9). An appended extension, a short number, or
placeholder junk (`0000000000`) is rejected rather than guessed at.

### `finance_source` mapping

Derived from **`Financing_Partner__c` alone** — deliberately not combined with
`Financing_Type__c`, so there is exactly one field to look at when a mapping is wrong.

| `Financing_Partner__c` | `finance_source` | `was_a_loan_used` |
|---|---|---|
| `Lightreach` | `Lightreach_lease` | `No` |
| `Cash` | `cash` | `No` |
| `ICCU` | `loan` | `No` |
| `Credit Human` | `loan` | `No` |
| `Participate Prepaid Lease - Cash` | `Participate_prepaid_lease` | `No` |
| `Participate Prepaid Lease - Financed` | `Participate_prepaid_lease` | **`Yes`** |
| anything else, or blank | — **skip the call**, log the reason | — |

Comparison is trim + collapse-whitespace + **fold every dash variant to `-`** +
lowercase.

> ⚠️ **The dash fold is load-bearing, not cosmetic.** The live picklist holds
> `Participate Prepaid Lease – Cash` with an **EN DASH (U+2013)** and
> `Participate Prepaid Lease - Financed` with an ASCII hyphen. A literal comparison
> matches one and silently misses the other, sending a real prepaid-lease customer
> down the "unmappable" path. The other partner values in the org
> (`Aurora`, `Enfin`, `GoodLeap`, `Mosaic`, `Other`, `Sungage`, `Sunlight`) are
> **intentionally unmapped** and will skip until a mapping is agreed.

### Dynamic variables

`POST https://api.retellai.com/v2/create-phone-call`, `Authorization: Bearer <api key>`:

```json
{
  "from_number": "<RETELL_FROM_NUMBER>",
  "to_number": "+16025550134",
  "override_agent_id": "<RETELL_AGENT_ID>",
  "metadata": { "source": "sundial", "sf_record_id": "a1P…", "tenant": "a1W…", "attempt_no": 1 },
  "retell_llm_dynamic_variables": { }
}
```

**Every value is a string, formatted for speech.** A blank source becomes the literal
string **`not provided`** — the agent prompt branches on that exact spelling, so it is
a contract, not a placeholder. **Zero is not blank**: a `$0` down payment is a real,
sayable fact and renders as `$0`.

| Variable | Source field | Example |
|---|---|---|
| `customer_name` | `Name` | `Dana Whitfield` |
| `property_address` | `Street__c`, `City__c`, `State__c` + `Postal_Code__c` | `123 Main St, Phoenix, AZ 85032` |
| `customer_email` | `Primary_Email__c` | `dana@example.com` |
| `system_size` | `Final_System_Size_kW__c` | `7.2 kilowatts` |
| `estimated_production` | `First_Year_kW_Production__c` | `11,450 kilowatt-hours` |
| `finance_source` | derived (table above) | `loan` |
| `monthly_payment` | `Monthly_Payment__c` | `$142.50 per month` |
| `energy_rate` | `Energy_Rate__c` | `$0.089 per kilowatt-hour` |
| `escalator` | `Escalator__c` | `1.9% per year` |
| `total_price` | `Contract_Amount__c` | `$45,900` |
| `amount_due_signing` | `Down_Payment_Amount__c` | `$0` |
| `amount_due_design` | `Due_at_Audit_Amount__c` | `$5,000` |
| `amount_due_install` | `Due_at_Greentag_Amount__c` * | `$20,900` |
| `loan_amount` | `Contract_Amount__c` | `$45,900` |
| `loan_term` | `Loan_Term_Years__c` | `25 years` |
| `interest_rate` | `APR__c` | `3.99%` |
| `prepaid_lease_amount` | `Prepaid_Lease_Amount__c` | `not provided` |
| `was_a_loan_used` | derived | `No` |
| `ppl_loan_payment` | `Monthly_Payment__c` | `$142.50 per month` |
| `ppl_loan_interest_rate` | `APR__c` | `3.99%` |
| `ppl_loan_term` | `Loan_Term_Years__c` | `25 years` |

There is deliberately **no `rep_name` variable**.

Two things in that table look like mistakes and are not:

- **`estimated_production` reads a field named `..._kW_Production__c` but is spoken as
  kilowatt-HOURS.** The value is annual energy, not power; the field label is simply
  wrong. Saying "kilowatts" would make the number meaningless.
- **`loan_amount` and `total_price` read the same field.** For a financed deal the
  amount financed *is* the contract amount. Two names, one fact, because the agent
  prompt uses them in different scripts.

`energy_rate` gets its own formatter: at two decimals `$0.089` would round to `$0.09`
and misstate the contract, so a $/kWh rate keeps up to four decimals.

> ⚠️ **Field-name drift, handled:** the spec names `Due_at_Greentag_Amount__c`; the
> live org has **`Due_at_Green_Tag_Amount__c`**. `fields.js` lists both as candidates
> and takes whichever exists, so it reads correctly today and keeps working if the
> field is renamed. **A field missing from the org is never an error** — it drops out
> of the SOQL select and renders as `not provided`.

### On success (any 2xx with a `call_id`; Retell documents 201)

| Field | Value |
|---|---|
| `Welcome_Call_Status__c` | `Calling` |
| `Welcome_Call_Attempts__c` | previous + 1 |
| `Welcome_Call_Log__c` | new line prepended (below) |

Then the Supabase cache row and a Realtime broadcast — see **Write path**.

**On a Retell failure, nothing is written.** No status change, no attempt increment:
we never established that a call was placed, and burning one of five attempts on our
own outage would be wrong. The Lambda throws so the relay retries.

---

## Entry point 2 — `POST /webhooks/retell`

**Auth:** `X-Retell-Signature`, an HMAC-SHA256 of the **raw request body** keyed with
`RETELL_WEBHOOK_SECRET`, hex-encoded. Retell sends `v=<hex>`; a bare hex value is
accepted too. Constant-time compared via fixed-length digests, so neither the secret
nor the expected value leaks through timing or a length check.

- **No Supabase JWT and no API Gateway authorizer.** The caller is a machine with no
  portal user; `resolveIdentity` has nothing to verify and must not be used.
- **An unset secret fails CLOSED (401).** Treating "not configured" as "accept
  everything" would let anyone set a customer's verification status.
- The HMAC is computed over the **exact bytes** Retell sent (base64-decoded first when
  API Gateway flags the body). Re-serializing the parsed JSON changes key order and
  whitespace and will never match.

**Events:** `call_started` and `call_ended` are acked and dropped (200, no ledger row,
no Salesforce). Only `call_analyzed` is processed. An unrecognized event is acked so
Retell stops retrying it.

### The order of operations is the design

1. **Forward the full payload to the Zapier Catch Hook FIRST**, before Salesforce is
   touched. That Zap is the **billing ledger**, and it records every analyzed call —
   including calls this Lambda never placed. **3 attempts** (initial + 2 retries, 500 ms
   then 2 s backoff, 8 s timeout each). The raw body is forwarded byte-for-byte.
2. **On final failure, the payload is logged at ERROR for manual replay** and
   processing continues. **A forward failure never blocks the Salesforce writeback** —
   losing a ledger row is a billing correction; losing the verification result means a
   customer never gets called again.
3. **Archive the recording** (next section) — after the forward, before the writeback,
   so the archived key can ride along in the log line the writeback is about to save.
   One Salesforce write, not two.
4. **If `call.metadata.sf_record_id` is absent, the forward was the whole job.** That
   is the rep-form case: a rep starts a call from a form, possibly for a customer with
   no Salesforce record yet. Ack 200, Salesforce is never even queried.

> **The orphan path inverts steps 1 and 3, and only the orphan path.** For a rep-form
> call the ledger row is the *only* trace of the call, and the sweep that later matches
> it to a customer needs the recording's key — so there is nothing to put in the payload
> unless the upload has already happened. The cost is that an orphan's ledger row waits
> on a download bounded at 20 s. That is acceptable because the step cannot throw and
> cannot skip the forward: a failed archival simply forwards without
> `s3_recording_key`, which the sweep reads as "no recording to attach".


> **Redelivery double-forwards.** Because the forward is unconditional and comes
> first, a Retell redelivery posts to the Zap twice even though the Salesforce side is
> idempotent. **Dedupe on `call_id` inside the Zap.** Moving the idempotency check
> ahead of the forward was rejected: it would put a Salesforce read in front of the
> ledger, so a Salesforce outage would lose billing rows.

### Analysis → status

Read from `call.call_analysis.custom_analysis_data`: `verification_result`,
`identity_confirmed`, `email_confirmed`, `system_details_confirmed`,
`financial_terms_confirmed`, `utility_bill_understood`, `usage_change_understood`,
`mismatched_items`, `unconfirmed_items`, `follow_up_notes` — plus `recording_url`,
`call_summary` and `in_voicemail` from the call.

| `verification_result` | `Welcome_Call_Status__c` |
|---|---|
| `passed` | `Verified` |
| `partial` / `failed` / `callback_requested` | `Verified - Exceptions` |
| `refusal` | `Refused` |
| `wrong_person` / `voicemail` / `no answer` | `No Answer` — **`Failed - Max Attempts`** when `Welcome_Call_Attempts__c` ≥ 5 |
| unrecognized | `Verified - Exceptions` (see below) |

Values are normalized (lowercase, spaces and hyphens → `_`), so `no answer`,
`no-answer` and `no_answer` are the same thing.

- **The attempt ceiling rewrites only the No Answer bucket**, because it is the only
  one that would otherwise be retried. A `Verified` or `Refused` call is finished no
  matter how many attempts it took.
- **An unrecognized outcome goes to `Verified - Exceptions`, not `No Answer`.** That is
  the fail-safe direction: Exceptions parks the record for a human, while No Answer
  would silently queue another call on a result we did not understand. The one
  exception: an empty result with `in_voicemail: true` really is a no-answer and is
  treated as one.
- Two statuses in the org picklist — **`Contact Info Mismatch`** and
  **`Contract Values Mismatch`** — are **not currently produced** by this mapping.
  Mismatches land in `Verified - Exceptions` with the detail in the log. Splitting
  them out is a mapping change in `webhook.js` if Harmon wants it.

### Idempotency

Retell may redeliver. Before writing, the Lambda checks `Welcome_Call_Log__c` for a
line containing **both** `call_id=<this id>` **and** the marker `Result:`. If found,
it acks and skips.

Matching on the `call_id` alone would be wrong: the `Call placed` line carries the
same id, so the very first legitimate result would be discarded as a duplicate. The
`Result:` marker is what makes a log line terminal.

### Response codes

| Code | When | Effect on Retell |
|---|---|---|
| 200 | processed, duplicate, ack-only event, no `sf_record_id`, record deleted, schema incomplete | done |
| 401 | missing/invalid signature, or no secret configured | — |
| **500** | **Salesforce writeback failed** | **deliberate** — Retell retries; the ledger already has the call and the idempotency guard makes redelivery safe |

---

## Recording archival

**Retell's `recording_url` expires.** That single fact is why this exists: without
archiving, the URL in the Salesforce log works today and 404s exactly when someone
needs it — when a customer disputes what they agreed to.

The recording is downloaded server-side and written into the ordinary Sundial file
convention in the `sfsolproj` bucket, which buys three surfaces with no extra code (see
[`file-storage.md`](../file-storage.md)):

- the portal **Files tab** on the customer record (it lists that prefix from S3)
- **Salesforce**, via XFiles Pro reading the same prefix
- **Harmon's Dropbox**, via the S3 PUT event on the same bucket

Getting the key right *is* the integration.

| Case | S3 key | Supabase metadata |
|---|---|---|
| `sf_record_id` present | `SUNDIAL/{sf_record_id}/welcome-call-{YYYY-MM-DD}-attempt-{n}.mp3` | row: category `Welcome Call Recording`, uploader `Wattson (system)`, mime `audio/mpeg`, size, `sf_object_type` `Sundial_Customer__c`, `tenant_id` = the record's `Client__c` |
| absent (rep-form orphan) | `SUNDIAL/_orphan-welcome-calls/{call_id}.mp3` | **none** |
| no `recording_url` | *skipped silently* | — |

- **The date is America/Phoenix**, not UTC. A call placed at 6pm Phoenix is already
  tomorrow in UTC, and a UTC-named file would sit in the Files tab under a date the
  office never dialed on.
- **`attempt_no` comes from `call.metadata` and falls back to the literal `x`.** A
  rep-form call has no attempt number; `…-attempt-x.mp3` says that honestly instead of
  growing an `undefined`. Because the attempt number is in the name, attempt 2 does not
  clobber attempt 1 — a customer who was called three times keeps three recordings.
- **No recording is not a failure.** A call that never connected has no
  `recording_url`, which is the common case for a no-answer. It must stay silent or
  every unanswered call logs an error.
- **No metadata row for orphans, deliberately.** Every list query is scoped by
  `sf_record_id`; a row with a null one is unreachable — worse than no row, because it
  looks registered.

**Download safety.** https only, no credentials attached, 20 s timeout, 50 MB cap
(checked against `content-length` before buffering *and* against the actual bytes).
The URL arrives inside the request body; even though that body is HMAC-verified,
attaching the Retell API key to a URL taken from a payload would hand the key to
whatever host it names.

**Nothing here can fail the call result.** Every path resolves rather than throwing,
and a failure logs at ERROR with the `call_id` and the still-live `recording_url` so
the file can be fetched by hand.

**Idempotency.** Keys are deterministic, so a redelivery overwrites the object in
place. The metadata insert is the part that would duplicate — a second row means the
file shows twice in the Files tab with no way to tell them apart — so it is skipped
when `findFileMetadataByKey` already finds one. The archival step sits *after* the
duplicate check, so a redelivery does not re-download a few MB to rewrite an identical
object; the trade is that a first delivery which stored the status but failed the
recording will not retry the audio. The Retell URL is in the log line and the ledger
row for exactly that case.

When archival succeeds, the result log line gains an `archived=<key>` segment. The
expiring Retell URL stays alongside it; the key is the durable one.

---

## `POST /welcome-call/orphan-match`

The other half of the rep-form story. Once the Zapier sweep works out which customer a
parked recording belonged to, it calls this endpoint to promote the file.

**Auth:** `X-Sundial-Zap-Secret` vs `ZAP_ORPHAN_MATCH_SECRET`, constant-time compared.
Not a portal JWT — the caller is a Zap. **An unset secret rejects everything (401).**
This endpoint moves files into a customer folder on the strength of a caller-supplied
record id, so it is the last place to be lenient.

**Body:** `{ "call_id": "call_abc123", "sf_record_id": "a1P7y00000AUo6TEAT" }`

**Sequence:**

1. Resolve the customer from Salesforce — proves the target exists (404 if not) and
   supplies the `Client__c` stamped on the metadata row. There is no caller tenant
   here, so the record scopes itself, the same model `sundial-aurora-inbound` uses.
2. `HEAD SUNDIAL/_orphan-welcome-calls/{call_id}.mp3`.
3. Copy to `SUNDIAL/{sf_record_id}/welcome-call-{YYYY-MM-DD}-{call_id}.mp3`, **dated
   from the holding object's `LastModified`** in Phoenix time — the sweep may run days
   after the call, and the file should be named for the conversation, not the sweep.
4. Register Supabase file metadata (skipped if a row for that key exists).
5. Prepend `rep-form call {call_id} matched, recording attached` to
   `Welcome_Call_Log__c`, then cache + Realtime.
6. **Delete the holding object last**, only after the copy is confirmed.

**Idempotency has to work backwards, because the operation deletes its own input.** A
retry cannot re-derive the destination key — that key embeds the `LastModified` of an
object that no longer exists. So the retry path **searches** `SUNDIAL/{sf_record_id}/`
for any `welcome-call-*-{call_id}.mp3` and reports `already_matched: true`. It also
re-attempts the metadata row and the log line, each a no-op when already present, so a
partially-failed run **converges** instead of silently losing the note. (Without that,
a run whose log append failed would delete the holding object and the note could never
be written.)

**A failed holding-object delete is not a failed match.** The bytes are attached and
registered, which is the point; the response says `holdingDeleted: false` and a later
retry cleans up the duplicate.

**Responses:**

| Code | When |
|---|---|
| 200 | promoted (`already_matched: false`), or already done (`already_matched: true`) |
| 400 | `MISSING_FIELDS`, `INVALID_RECORD_ID`, `INVALID_CALL_ID`, `INVALID_BODY` |
| 401 | missing/invalid `X-Sundial-Zap-Secret`, or none configured |
| 404 | `RECORD_NOT_FOUND`, or `RECORDING_NOT_FOUND` (nothing parked and nothing matched) |

```json
{ "already_matched": false,
  "key": "SUNDIAL/a1P7y00000AUo6TEAT/welcome-call-2026-08-15-call_abc123.mp3",
  "recordId": "a1P7y00000AUo6TEAT", "callId": "call_abc123", "sizeBytes": 184320,
  "metadata": "registered", "log": "appended", "holdingDeleted": true }
```

---

## Log format — `Welcome_Call_Log__c`

**Newest line first.** The field is read by a human in a Salesforce field viewer that
shows the first few lines, and the last thing that happened is what they need. It also
means truncation at the 32,768-char cap discards the **oldest** history, which is the
half you can afford to lose. Truncation trims to a line boundary, so the log never
ends mid-record.

```
2026-08-17 14:32 MST · Attempt 1 · Result: passed · Status: Verified · mismatches: none · recording=https://… · archived=SUNDIAL/a1P…/welcome-call-2026-08-17-attempt-1.mp3 · call_id=call_abc123
2026-08-17 14:19 MST · Attempt 1 · Call placed · call_id=call_abc123
2026-08-17 09:02 MST · Skipped · unmappable financing partner: GoodLeap
```

Line shapes:

| Kind | Shape |
|---|---|
| Placed | `<stamp> · Attempt <n> · Call placed · call_id=<id>` |
| Result | `<stamp> · Attempt <n> · Result: <outcome> · Status: <status> [· not confirmed: <…>] · mismatches: <…> [· unconfirmed: <…>] [· notes: <…>] [· voicemail: yes] [· recording=<url>] [· archived=<s3 key>] · call_id=<id>` |
| Matched | `<stamp> · rep-form call <call_id> matched, recording attached` |
| Skip | `<stamp> · Skipped · unmappable financing partner: <value>` |

`not confirmed:` lists only the confirmation flags that came back anything other than
`true` (identity / email / system / financials / utility bill / usage change) — the
actionable half; listing six `true`s on every good call would bury the exceptions. It
is **not** redundant with `mismatches:`: a mismatch is "the customer gave a different
value", an unpassed check is "we never got an answer", and they point at different
follow-ups. `call_summary` is not put in the log (it is prose and would dominate the
field) — it reaches the ledger in the forwarded payload and the Realtime broadcast.
`recording=` is Retell's URL, which **expires**; `archived=` is the permanent S3 key,
and its presence is also the record that archival succeeded.

`<stamp>` is `YYYY-MM-DD HH:mm MST`, local Phoenix time. Phoenix does not observe DST,
so the abbreviation is MST year-round. Mismatch/unconfirmed/notes segments are clipped
(200/200/300 chars) so one pathological analysis payload cannot eat the field — and
take the status update down with it, since Salesforce rejects the whole PATCH on
overflow.

---

## Status state machine

```
                    ┌──────────────────────────────────────────┐
                    │  Not Started / Queued / No Answer        │  ← eligible
                    └───────────────────┬──────────────────────┘
                                        │ place call (attempts +1)
                                        ▼
                                    ┌─────────┐
                                    │ Calling │  ← NOT eligible (in flight)
                                    └────┬────┘
                                         │ call_analyzed
             ┌───────────────┬───────────┼─────────────┬─────────────────┐
             ▼               ▼           ▼             ▼                 ▼
        ┌──────────┐  ┌──────────────┐ ┌─────────┐ ┌───────────┐ ┌────────────────────┐
        │ Verified │  │  Verified -  │ │ Refused │ │ No Answer │ │ Failed - Max       │
        │          │  │  Exceptions  │ │         │ │ (retry)   │ │ Attempts (≥5)      │
        └──────────┘  └──────────────┘ └─────────┘ └─────┬─────┘ └────────────────────┘
          terminal        terminal       terminal        │              terminal
                                                         └──► back to eligible
```

`No Answer` is the **only** non-terminal outcome — it is what makes the retry Flow
meaningful, and the attempt ceiling is what makes it terminate.

---

## Write path

Identical to `sundial-sf-update`, in the same order and with the same failure
semantics ([`caching-architecture.md`](../caching-architecture.md) → "Write Path"):

1. **Salesforce first**, and it is the only step allowed to fail the operation. No
   partial writes.
2. **Supabase cache, best effort, tenant-scoped** (`sf_id` + `client_sf_id`). Flags
   `is_stale = true` (what `sundial-sf-update` does), and additionally writes
   `welcome_call_status` / `welcome_call_attempts` / `welcome_call_log` **when the
   cache table has those columns** — checked against PostgREST's OpenAPI document,
   the same introspection `sundial-cache-sync` uses. Sending an unknown column would
   make PostgREST reject the *entire* update and drop the `is_stale` flag with it. A
   cache failure is logged and swallowed.
3. **Realtime broadcast, best effort**, on
   `tenant:{Client__c}:sundial_customer:{sf_id}`, event `welcome_call_updated`,
   carrying the changed fields so a subscribed client can apply them without a round
   trip. Sent over Supabase's stateless HTTP broadcast endpoint (`lib/realtime.js`)
   rather than a WebSocket channel — a socket whose container may freeze mid-handshake
   is a silently dropped message.

The cache columns are optional. If `sundial_customer_cache` doesn't have them, the
row is still flagged stale and the next read refreshes it from Salesforce.

---

## Salesforce fields

**Read** (all describe-guarded): `Name`, `Street__c`, `City__c`, `State__c`,
`Postal_Code__c`, `Primary_Phone__c`, `Primary_Email__c`, `Final_System_Size_kW__c`,
`First_Year_kW_Production__c`, `Financing_Partner__c`, `Monthly_Payment__c`,
`Energy_Rate__c`, `Escalator__c`, `Contract_Amount__c`, `Down_Payment_Amount__c`,
`Due_at_Audit_Amount__c`, `Due_at_Greentag_Amount__c` (→ `Due_at_Green_Tag_Amount__c`),
`Loan_Term_Years__c`, `APR__c`, `Prepaid_Lease_Amount__c`, `Welcome_Call_Status__c`,
`Welcome_Call_Attempts__c`, `Welcome_Call_Log__c`, `Client__c`.

**Written:** `Welcome_Call_Status__c`, `Welcome_Call_Attempts__c`,
`Welcome_Call_Log__c`. Nothing else.

**Required.** `Welcome_Call_Status__c`, `Welcome_Call_Attempts__c` and
`Welcome_Call_Log__c` must exist or the Lambda **refuses to place calls** — without a
status there is no state machine, without attempts there is no ceiling, and without a
log there is nowhere to explain a skip. Every other field degrades to `not provided`.

All three exist in the live org today, with this `Welcome_Call_Status__c` picklist:
`Not Started`, `Queued`, `Calling`, `No Answer`, `Verified`, `Verified - Exceptions`,
`Contact Info Mismatch`, `Contract Values Mismatch`, `Refused`, `Failed - Max Attempts`.

---

## Configuration

### Precedence — and why it differs by kind

| Variable | Kind | Resolution order | Secret field candidates |
|---|---|---|---|
| `RETELL_API_KEY` | credential | **secret**, then env | `api_key`, `apiKey`, `retell_api_key`, `key` |
| `RETELL_WEBHOOK_SECRET` | credential | **secret**, then env | `webhook_secret`, `webhookSecret`, `signing_secret`, `webhook_token` |
| `ZAP_ORPHAN_MATCH_SECRET` | credential | **secret**, then env | `zap_orphan_match_secret`, `orphan_match_secret`, `zap_secret` |
| `RETELL_FROM_NUMBER` | config | **env**, then secret | `from_number`, `fromNumber` |
| `RETELL_AGENT_ID` | config | **env**, then secret | `agent_id`, `agentId`, `override_agent_id` |
| `ZAPIER_RESULTS_HOOK_URL` | config | **env**, then secret | `zapier_results_hook_url`, `zapier_hook_url`, `results_hook_url` |

Credentials resolve **secret-first** because that is what makes rotation work: change
the secret and every warm container picks it up within the 5-minute TTL, with no
redeploy. If the env var won, a stale value baked into the function config would
silently shadow the rotated secret — the failure mode D-045 exists to bound.
`docs/api-endpoints.md` is also explicit that credentials never live in a Lambda env
var. Config values are addresses, not credentials, so the env var is the natural
per-tenant knob. Both sources are accepted for all five, so nothing breaks if an
operator sets a value in the other place.

The secret (`sundial/retell/api`) **not existing is not an error** — a deployment that
puts everything in env vars is valid.

```powershell
# Secret (credentials)
aws secretsmanager create-secret --name sundial/retell/api --region us-west-1 `
  --secret-string '{"api_key":"key_…","webhook_secret":"whsec_…","zap_orphan_match_secret":"…"}'

# Env vars (config). NOTE: update-function-configuration REPLACES the whole map.
aws lambda get-function-configuration --function-name sundial-welcome-call `
  --region us-west-1 --query 'Environment.Variables'

aws lambda update-function-configuration --function-name sundial-welcome-call --region us-west-1 `
  --environment "Variables={RETELL_FROM_NUMBER=+16025550000,RETELL_AGENT_ID=agent_…,ZAPIER_RESULTS_HOOK_URL=https://hooks.zapier.com/hooks/catch/…/…/}"
```

**IAM:** `sundial-lambda-execution-role` already carries `secretsmanager:GetSecretValue`
for the `sundial/*` secrets used by the other Lambdas; confirm the new secret is
covered by that policy's resource pattern before go-live.

S3 is also needed now: `ListBucket` on `sfsolproj` plus `GetObject` / `PutObject` /
**`DeleteObject`** on `sfsolproj/SUNDIAL/*`. The role carries `AmazonS3FullAccess`
today (verified 2026-08-03 for copy-to-solar), so no change is expected — but
`DeleteObject` is new for Sundial with this feature (orphan-match removes the holding
object), so re-check it if the role is ever tightened to a least-privilege policy.

---

## What Tim configures (not built in code)

### 1. The platform event

`Sundial_Welcome_Call_Request__e` with one field, `Customer_Id__c` (Text, 18).
**It does not exist in the org yet** (verified against the live describe).

### 2. The Flows that publish it

One event, two publishers (D-054):

- **Trigger Flow** — record-triggered on `Sundial_Customer__c`, after save, on the
  `Stage__c` change that means "sold". Publishes the event with
  `Customer_Id__c = {!$Record.Id}`.
- **Retry Flow** — scheduled, selects customers with
  `Welcome_Call_Status__c = 'No Answer'` and `Welcome_Call_Attempts__c < 5`, publishes
  the same event.

Neither Flow needs any guard logic of its own. The Lambda's eligibility guard is the
single authority on whether a call happens, so a Flow that fires too eagerly is
harmless. Publishing on `Calling` is a no-op; publishing at attempt 5 is a no-op.

### 3. Event Relay → EventBridge

Named Credential + Event Relay config pointing `Sundial_Welcome_Call_Request__e` at an
EventBridge partner event bus, then a rule on that bus targeting
`sundial-welcome-call`. Expected rule shape:

```json
{
  "Name": "sundial-welcome-call-request",
  "EventBusName": "aws.partner/salesforce.com/<org-id>/<relay-name>",
  "EventPattern": { "detail-type": ["Sundial_Welcome_Call_Request__e"] },
  "Targets": [{ "Arn": "arn:aws:lambda:us-west-1:891377232720:function:sundial-welcome-call" }]
}
```

plus the invoke permission:

```powershell
aws lambda add-permission --function-name sundial-welcome-call --region us-west-1 `
  --statement-id events-welcome-call-request --action lambda:InvokeFunction `
  --principal events.amazonaws.com `
  --source-arn arn:aws:events:us-west-1:891377232720:rule/sundial-welcome-call-request
```

The Lambda parses the EventBridge shape (`event.detail.payload.Customer_Id__c`), the
SQS-wrapped shape (`event.Records[].body`, which may itself wrap an EventBridge
envelope), and a direct `{ "Customer_Id__c": "…" }` invoke — so an SQS relay works
instead, with no code change.

### 4. Retell

- The Welcome Call agent, with `RETELL_AGENT_ID` as its id. Its prompt must branch on
  `finance_source` and must treat the literal string `not provided` as "this value is
  unavailable, don't say it".
- The webhook URL → `https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod/webhooks/retell`,
  with the signing secret matching `RETELL_WEBHOOK_SECRET`.
- The post-call analysis schema must emit the `custom_analysis_data` keys listed above.

### 5. The Zapier billing-ledger Zap

A Catch Hook whose URL goes in `ZAPIER_RESULTS_HOOK_URL`. **Dedupe on
`call.call_id`** — see the redelivery note above.

### 6. The Zapier orphan sweep

The other half of the rep-form story. For ledger rows with no `sf_record_id`, work out
which customer the call belonged to (by the phone number the rep dialed, the name in
`call_summary`, whatever the Zap can key on) and then:

```
POST https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod/welcome-call/orphan-match
X-Sundial-Zap-Secret: <ZAP_ORPHAN_MATCH_SECRET>
{ "call_id": "call_abc123", "sf_record_id": "a1P7y00000AUo6TEAT" }
```

- Only worth calling when the ledger row carries **`s3_recording_key`** — its absence
  means the archival failed and there is nothing parked to promote (the endpoint will
  answer `404 RECORDING_NOT_FOUND`).
- **Safe to retry.** Repeat calls return `already_matched: true` and heal anything the
  first run failed to finish.
- Nothing expires on our side, so the sweep can run on whatever cadence suits — daily
  is plenty.

### 7. Watch `SUNDIAL/_orphan-welcome-calls/`

Objects should not pile up here. Anything more than a few weeks old is a call the
sweep never matched. **No lifecycle rule is configured, deliberately** — auto-deleting
an unmatched recording of a contract conversation is the wrong default. Check it
periodically and either match it or delete it by hand.

---

## Deploy

```powershell
# 1. Create the function in the console (Node.js 22.x, handler index.handler,
#    role sundial-lambda-execution-role, timeout 60s, memory 512 MB), then:
.\deploy.ps1 sundial-welcome-call

# 2. Env vars + secret (above)

# 3. Both API routes
.\scripts\wire-welcome-call-routes.ps1
```

Timeout guidance: the webhook path can spend up to ~10 s on Zapier retries, ~20 s on
the recording download, plus a Salesforce read and write — so **60 s** is the floor,
not headroom. Memory **512 MB** matches the other integration Lambdas and holds a
buffered recording comfortably (the download is capped at 50 MB, which is far above any
real call; a phone recording is a few MB).

> ⚠️ **Account concurrency quota is 10 in us-west-1**, shared by every function (see
> the G2 note in `docs/api-endpoints.md`). The platform-event path processes a batch
> **sequentially** for that reason — fanning out buys nothing and risks throttles. A
> large retry-Flow batch will be slow rather than parallel; that is intentional.

---

## Testing

`npm test` — 76 tests in `lambdas/sundial-welcome-call/test.js`, covering every
eligibility branch, every finance-partner value (including the EN DASH), the spoken
formatting of each variable, signature verification (including base64 bodies and the
fail-closed unset secret), the forward-first ordering and its retry ladder, the full
outcome→status table with the attempt ceiling, idempotency on redelivery, log
truncation, and shape-based routing.

Recording and orphan-match run against an **in-memory S3** (a stubbed
`@aws-sdk/client-s3` with a real key→object map) and a PostgREST-shaped Supabase stub
whose metadata select reads back what its inserts recorded — so "skip the insert if a
row exists" is genuinely exercised rather than asserted. Covered: key construction on
all three shapes, a hostile `call_id` failing to escape the holding prefix, the
`attempt_no` fallback, Phoenix-vs-UTC dating, the download guards (non-https, 404,
empty), archival failure not blocking the writeback, redelivery producing one object
and one metadata row, the orphan payload enrichment (and its absence on failure), and
the orphan-match idempotency path including a retry that heals a failed log append.

**Not yet verified against live Retell, live S3, or a live Salesforce record** — that
needs the platform event created, the agent provisioned, and a real phone number.
