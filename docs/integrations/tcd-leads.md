# The Cool Down (TCD) — inbound leads + the daily report

**Lambda:** `sundial-lead-intake` (Node 22.x, arm64, `index.handler`, role `sundial-lambda-execution-role`, 30 s, 256 MB)
**Decision:** D-077 — inbound lead webhooks are unauthenticated by URL secret, tenant-pinned in Secrets Manager.
**Wiring:** `scripts/wire-lead-intake.ps1` · **Tests:** `lambdas/sundial-lead-intake/test.js`, `lib/cache-row.test.js`

The Cool Down is a Harmon lead vendor. Its website POSTs each lead straight to Sundial (no
Zapier), and every morning Sundial emails TCD a CSV showing how each of their leads is doing.

---

## 1. The webhook

```
POST https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod/webhooks/leads/tcd/<slug>
Content-Type: application/json
```

`<slug>` is a long random string known only to TCD and to Secrets Manager. **It is not in the
repo, the wiring script or any log.** The route is a path parameter (`/webhooks/leads/tcd/{token}`),
so every slug reaches the Lambda and a wrong one gets the same answer as a route that does
not exist.

### The only guard is the URL

TCD cannot sign requests, so there is no header secret and no signature. The Lambda:

1. compares the slug to `sundial/lead-webhooks` → `tcd.token` with `constantTimeEquals`
   (`lib/secure-compare.js`) **before looking at anything else**;
2. answers a wrong, empty or missing slug — and a missing or unreadable secret — with a
   **bare `404` and an empty body**;
3. takes the tenant from the secret (`tcd.tenant`), never from the request.

API Gateway throttles both `POST` methods to **5 requests/second, burst 10** (stage method
settings). The **16 KB** body cap and **JSON only** are enforced in the Lambda (REST API
Gateway cannot cap a body below 10 MB).

### Payload

All strings. Unknown keys are ignored (and kept out of the notes).

| Key | Aliases accepted | Goes to |
|---|---|---|
| `first_name` | | `First_Name__c` |
| `last_name` | | `Last_Name__c` |
| `address1` | `address`, `street` | `Street__c` |
| `city` | | `City__c` |
| `state` | | `State__c` — a 2-letter code or a full name, matched to the org's picklist |
| `zip_code` | `zip`, `postal_code` | `Postal_Code__c` |
| `email` | | `Primary_Email__c` (lowercased) |
| `phone` | | `Primary_Phone__c` (digits only, a leading `+` kept) |

**Required:** `email` **or** `phone`, **and** `first_name` **or** `last_name`. An `email`
that is not an address counts as absent (it would fail the Salesforce insert); it is kept in
the notes instead.

### What gets created

A `Sundial_Customer__c` with the portal's Lead defaults:

| Field | Value |
|---|---|
| `Name` | "First Last" |
| `Status__c` | `Lead` |
| `Stage__c` | the first active stage the org allows under Lead, **read from describe** — `New` on 2026-09-29 |
| `Customer_Type__c` | `Solar` |
| `Country__c` | `United States` |
| `Lead_Source__c` | `TCD` |
| `Lead_Date__c` | today, Arizona |
| `Client__c` | the tenant named in the secret |
| `Outreach_Notes__c` | a short block: "Lead received from The Cool Down (TCD) — date/time", then the payload as `key: value` lines |
| `Sales_Rep__c` | **left empty** — Tim's Salesforce alert to the setter does the routing |

Every picklist goes through the **match-or-skip guard** (the Aurora rule): a value the org
does not have is left unset and written into `Outreach_Notes__c`, and the lead is still
created. A missing `TCD` Lead Source is logged at **error** level because TCD's own report
depends on it. A text value longer than its field is truncated rather than failing the insert.

The new record's **cache row** is written at once (`lib/cache-row.js`), so the lead shows in
Sales straight away. That write is best-effort: if it fails, `sundial-cache-sync` picks the
record up on its next run.

### Duplicates — and the race we accept

If a customer in the tenant was **created in the last 30 days** with the same email, the
Lambda returns that customer instead of creating another. When the payload has **no email**,
it checks the phone instead (a digits-only match, so `(602) 555-0100` equals `6025550100`).

This is **a read followed by a create, not an atomic upsert.** If two copies of the same lead
arrive in the same second (TCD retrying before the first request finished), both can create a
record. Tim accepted that on 2026-09-29: it is rare, and a setter can merge the two. If it
starts happening, the fix is an external-id field (for example a hash of the email) and an
upsert.

### Responses

| Code | Body | When |
|---|---|---|
| 200 | `{ "ok": true, "id": "a1P…" }` | created |
| 200 | `{ "ok": true, "id": "a1P…", "duplicate": true }` | the same lead within 30 days — nothing created |
| 400 | `{ "ok": false, "error": "missing_fields", "missing": ["email or phone"] }` | names the requirement, never a value |
| 400 | `{ "ok": false, "error": "invalid_json" }` | the body is not a JSON object |
| 404 | *(empty)* | wrong or missing slug, wrong method, unknown source |
| 413 | `payload_too_large` | body over 16 KB |
| 415 | `unsupported_media_type` | not `application/json` |
| 502 | `{ "ok": false, "error": "upstream_error" }` | Salesforce failed. TCD should retry. One log line: a masked email (`t***@x.com`) and Salesforce's error code and field names, never the values |

---

## 2. The daily report

EventBridge rule **`sundial-tcd-daily-report`**, `cron(0 13 * * ? *)`, input `{ "report": "tcd" }`.
`wire-lead-intake.ps1` creates it **DISABLED** and enables it only after you answer "y" to the
prod API deploy. A "no" leaves it disabled and prints the command that enables it:
`aws events enable-rule --name sundial-tcd-daily-report --region us-west-1`. To pause the
report, use `disable-rule` with the same arguments. Re-running the script parks the rule as
disabled again until its own "y".
13:00 UTC is **6:00 AM in Arizona**. Arizona is UTC−7 all year (it does not observe daylight
saving time), so the send time never moves.

**Rows:** every `Sundial_Customer__c` in the tenant with `Lead_Source__c = 'TCD'` created on or
after `TCD_REPORT_SINCE` (midnight Arizona), **newest first**. The report is cumulative: every
morning TCD sees the whole cohort's current state. It runs live SOQL, not the cache.

**Test records are never sent.** A row whose `Last_Name__c` or `Name` starts with `ZZ` (the
repo's test convention: the designated `ZZ PORTAL TEST` records and the `ZZ TCD TEST` smoke
lead) is excluded in the query itself. A lead with no last name stays in. SOQL's `LIKE` ignores
case, so `zz…` is excluded too; no real surname starts that way. The webhook still *creates* ZZ
leads, which is how the smoke test works; only the report leaves them out.

| # | Header | From |
|---|---|---|
| 1 | `Email` | `Primary_Email__c` |
| 2 | `Lead Received` | `CreatedDate`, Arizona date |
| 3 | `Contacted Date` | `First_Contact_Date__c` (empty = not yet contacted) |
| 4 | `Contact Disposition` | `Contact_Disposition__c` (Contacted, No Answer, Left Voicemail, Wrong Number, Not Interested, Do Not Contact) |
| 5 | `Appointment Scheduled` | `Yes` when `Appointment_DateTime__c` is set |
| 6 | `Appointment Date` | `Appointment_DateTime__c`, Arizona `YYYY-MM-DD HH:MM` (24-hour) |
| 7 | `Appointment Disposition` | **`Appointment_Outcome__c`** (Sold, Follow Up Needed, Not Interested, No-Show, Reschedule, Disqualified). No new field — Tim, 2026-09-29 |
| 8 | `Contract Signed` | `Yes` when `Contract_Signed_Date__c`, else `Sold_Date__c`, is set |
| 9 | `Contract Signed Date` | that date |
| 10 | `Installed` | `Yes` when the customer's newest `Sundial_Solar__c` has `Install_Complete__c` |
| 11 | `Install Date` | `Install_Complete__c` (a Date field). The install start/end datetimes are schedule fields and are not used |

A column whose field does not exist in the org is sent **empty**, with one warning per run.

**Format:** RFC 4180 CSV, UTF-8 with a BOM (so Excel opens it cleanly), CRLF line endings,
filename `harmon-tcd-leads-YYYY-MM-DD.csv`. A cell starting with `=`, `+`, `-` or `@` gets a `'`
in front so Excel shows it as text instead of running it as a formula (the email comes from a
public form).

**The email:** from `EMAIL_FROM` to `TCD_REPORT_TO`, BCC `TCD_REPORT_BCC`, subject
**"Your Daily Report from Harmon Electric"**, plain-text and HTML bodies. It is **sent even with
zero rows** (header only), so a missing email always means something failed. A failed send
fails the Lambda run, which shows in CloudWatch *Errors* and gets EventBridge's two retries.

**Dry run:** in the Lambda console, Test with `{ "report": "tcd", "dryRun": true }`. It builds
the CSV and returns it (with the row count and any warnings) without sending anything.

---

## 3. Configuration

**Secret `sundial/lead-webhooks`** (Plaintext, JSON):

```json
{ "tcd": { "token": "<the slug handed to TCD>", "tenant": "harmon" } }
```

The Lambda re-reads the secret every 5 minutes, so a rotation takes effect without a
redeploy. **To rotate the slug:** generate a new one (for example
`node -e "console.log(require('crypto').randomBytes(21).toString('base64url').toLowerCase())"`),
give TCD the new URL, then update the secret. The old URL stops working within 5 minutes.

**Lambda environment variables:**

| Var | Value |
|---|---|
| `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_CONFIG_SET`, `SES_REGION` | copied from `sundial-service-estimate` |
| `TCD_REPORT_TO` | `ryan@thecooldown.com` (the default when unset) |
| `TCD_REPORT_BCC` | Harmon's own copy; comma-separated for several; optional |
| `TCD_REPORT_SINCE` | `2026-09-29` — the first day of the cohort (`YYYY-MM-DD`, Arizona) |

**To change the recipient:** Lambda console → `sundial-lead-intake` → Configuration →
Environment variables → edit `TCD_REPORT_TO` (or `TCD_REPORT_BCC`) → Save. It applies from the
next run; nothing needs redeploying.

**To start a new cohort** (for example a new contract period), change `TCD_REPORT_SINCE`.

---

## 4. Adding a second lead vendor

1. Add an entry to `LEAD_SOURCES` in `lambdas/sundial-lead-intake/intake.js` (label + the Lead
   Source picklist value).
2. Add a key to the secret: `{ "tcd": {…}, "newvendor": { "token": "…", "tenant": "harmon" } }`.
3. Wire `/webhooks/leads/newvendor/{token}`: copy `wire-lead-intake.ps1`'s resource block.
