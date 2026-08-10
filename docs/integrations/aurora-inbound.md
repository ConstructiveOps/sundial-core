# Aurora Inbound — agreement webhook → queue → worker

**Status:** built and tested; **not deployed**, and the Aurora subscription is **not
created**. Everything below marked **Tim** is a manual console step.

> **Reconstruction note (2026-08-07):** this file was lost in a working-tree deletion
> before it had ever been committed, and was rebuilt from the session transcript.
> Commit it so that can't happen again.

Pipeline:

```
Aurora  --GET (5 query params + shared-secret header)-->  sundial-aurora-webhook   (doorbell)
                                                              |  SendMessage
                                                              v
                                                    SQS sundial-aurora-inbound  --(DLQ after 5)--> ...-dlq
                                                              |
                                                              v
                                                    sundial-aurora-inbound       (worker)
                                                      ├─ Salesforce  Sundial_Customer__c (write-back)
                                                      ├─ S3          SUNDIAL/{customerId}/<agreement>-signed-agreement.pdf
                                                      └─ SES         design-manager notification
```

**Why the split:** Aurora counts a delivery as failed if we don't answer within **10
seconds**, and failures enter a retry ladder (30s, 5m, 30m, 3h, 20h) that
**auto-disables the subscription** after ~48h of consistent failure. The four
retrievals + PDF generation + download cannot fit in that budget, so the doorbell
does nothing but authenticate, validate, enqueue, and ack. See D-048.

Everything writes to **`Sundial_Customer__c`**. No `Sundial_Solar__c` exists at this
point in the lifecycle and this pipeline must never create one (D-047).

---

## Part A — Secrets (Tim)

The doorbell reads the shared secret from a **dedicated** secret first, then falls
back to the API secret. Today only the fallback exists, and that is fine.

| Secret | Key | Used by |
|---|---|---|
| `sundial/aurora/api` | `base_url`, `tenant_id`, `api_key` | worker (all retrievals) |
| `sundial/aurora/api` | `webhook_token` | doorbell (current source) |
| `sundial/aurora/webhook` *(optional)* | `webhook_token` or `token` | doorbell (takes precedence if created) |

Create the dedicated one only if you want the webhook token rotatable independently
of the API credentials:

```powershell
# Generate a long random token and store it (PowerShell 5.1)
$tok = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | % {[char]$_})
aws secretsmanager create-secret --name sundial/aurora/webhook --region us-west-1 `
  --secret-string "{`"webhook_token`":`"$tok`"}"
# ...then paste $tok into Aurora's subscription header (Part C). Print it once:
$tok
```

The doorbell caches the token for **5 minutes**, so a rotation takes effect without a
redeploy — but during that window old and new containers disagree. Rotate by adding
the new token to Aurora **after** updating the secret, and expect up to 5 minutes of
401s if you do it the other way round.

## Part B — Queue + worker plumbing (Tim)

Queues, Lambda functions, and event-source mappings are hand-created infrastructure
in this project (`deploy.ps1` only ever *updates code*).

```powershell
$R = "us-west-1"; $ACCT = "891377232720"

# 1. DLQ first, then the main queue with a redrive policy pointing at it.
aws sqs create-queue --queue-name sundial-aurora-inbound-dlq --region $R
$dlqArn = aws sqs get-queue-attributes --region $R `
  --queue-url "https://sqs.$R.amazonaws.com/$ACCT/sundial-aurora-inbound-dlq" `
  --attribute-names QueueArn --query "Attributes.QueueArn" --output text

# VisibilityTimeout must exceed the worker's timeout (60s) — 180s gives headroom
# for the PDF poll loop. maxReceiveCount=5 bounds retries before the DLQ.
$redrive = "{\"deadLetterTargetArn\":\"$dlqArn\",\"maxReceiveCount\":\"5\"}"
aws sqs create-queue --queue-name sundial-aurora-inbound --region $R `
  --attributes "VisibilityTimeout=180,MessageRetentionPeriod=1209600,RedrivePolicy=$redrive"

# 2. Create the worker Lambda (Node 22 / arm64 / role sundial-lambda-execution-role).
#    60s timeout + 512 MB: the download-url job is polled for up to ~15s and the PDF
#    is buffered in memory.
aws lambda create-function --function-name sundial-aurora-inbound --region $R `
  --runtime nodejs22.x --architectures arm64 --handler index.handler `
  --role "arn:aws:iam::$ACCT:role/sundial-lambda-execution-role" `
  --timeout 60 --memory-size 512 --zip-file fileb://placeholder.zip

# 3. Env: notification recipients (shared with the design-request email) + SES.
#    SUNDIAL_TENANT_SLUG defaults to "harmon"; set it explicitly for a new tenant.
aws lambda update-function-configuration --function-name sundial-aurora-inbound --region $R `
  --environment "Variables={EMAIL_FROM=Sundial <no-reply@sundialcrm.com>,DESIGN_REQUEST_NOTIFY_TO=designmanager@harmonelectric.net,SUNDIAL_TENANT_SLUG=harmon}"

# 4. Point the doorbell at the queue.
aws lambda update-function-configuration --function-name sundial-aurora-webhook --region $R `
  --environment "Variables={AURORA_INBOUND_QUEUE_URL=https://sqs.$R.amazonaws.com/$ACCT/sundial-aurora-inbound}"

# 5. Event-source mapping. ReportBatchItemFailures is REQUIRED — the worker returns
#    partial-batch failures, and without this SQS ignores them and deletes the batch.
aws lambda create-event-source-mapping --region $R `
  --function-name sundial-aurora-inbound `
  --event-source-arn "arn:aws:sqs:${R}:${ACCT}:sundial-aurora-inbound" `
  --batch-size 5 --function-response-types ReportBatchItemFailures
```

> ⚠️ `update-function-configuration` **replaces** the whole Variables map — include
> every var the function needs in one command.

**IAM:** the execution role needs `sqs:SendMessage` on the queue (doorbell) and
`sqs:ReceiveMessage`/`DeleteMessage`/`GetQueueAttributes` (worker), plus the S3 and
SES permissions it already has. Check before deploying:
`aws iam list-attached-role-policies --role-name sundial-lambda-execution-role`.

Then deploy the code: `.\deploy.ps1 sundial-aurora-webhook` and
`.\deploy.ps1 sundial-aurora-inbound`, and wire the route with
`.\scripts\wire-aurora-webhook-route.ps1` (already live for Harmon; idempotent).

## Part C — The Aurora subscription (Tim, in Aurora's console)

Create ONE webhook subscription on the **agreement_status_changed** event.

| Setting | Value |
|---|---|
| Event | `agreement_status_changed` |
| Statuses | **ALL** — `sent`, `viewed`, `signed`, `cancel-pending`, `canceled`, `declined`, `error` |
| Method | GET (Aurora's webhooks are GET with query params) |
| Custom header | `X-Aurora-Webhook-Token: <the token from Part A>` |
| `url_template` | see below |

```
https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod/webhooks/aurora/agreement-status?project_id=<PROJECT_ID>&design_id=<DESIGN_ID>&agreement_id=<AGREEMENT_ID>&financing_id=<FINANCING_ID>&status=<STATUS>
```

All **five** attributes must be present:
- `<DESIGN_ID>` is required for the signed path (design summary, proposal, financing).
  A signed event without it is dead-lettered.
- `<FINANCING_ID>` is **empty when no financing option was selected** — that is normal,
  and the worker skips the financing retrieval entirely rather than 404-ing.

**Subscribe to ALL statuses, not just `signed`.** Every status updates the agreement
tracking fields, which is what makes the pipeline observable — and only the `signed`
event triggers retrieval, so the extra deliveries are cheap.

**Verify after creating:** send/preview an agreement, then check CloudWatch
`/aws/lambda/sundial-aurora-webhook` for `aurora-webhook enqueued:` and
`/aws/lambda/sundial-aurora-inbound` for `aurora-inbound: processed`.

## Part D — Salesforce fields (Tim)

Seven new fields on `Sundial_Customer__c` plus one picklist value — see TASKS.md.
Until they exist the pipeline still runs: the describe guard drops them from every
query and PATCH, the signed write-back still lands, and the worker logs which fields
it could not write. Without `Aurora_Signed_Email_Sent__c` in particular, the
duplicate-email guard cannot persist, so a duplicate `signed` delivery re-sends the
notification.

---

## Dealer origination — unmatched Aurora projects (D-049)

Harmon works with third-party dealers who originate deals **entirely inside Aurora**,
in Harmon's own tenant. Their agreement events reach our webhook with a `project_id`
no `Sundial_Customer__c` carries. What happens next depends on the project's
`external_provider_id` (fetched with Retrieve Project):

| Event | `external_provider_id` | Outcome |
|---|---|---|
| **signed** | absent | **CREATE** the customer from Aurora data (upsert on `Aurora_Project_ID__c`), then run normal signed processing on it |
| **signed** | present, resolves | **REPAIR** — this is *our* deal whose design-request write-back failed; write the missing `Aurora_Project_ID__c` and continue. Nothing is created. |
| **signed** | present, resolves to nothing / another tenant | `PROVIDER_ID_MISMATCH` → DLQ. Never guessed. |
| sent / viewed / … | absent | **Dropped quietly** (info log, no DLQ) — normal dealer traffic before the sale |
| sent / viewed / … | present | `UNMATCHED_WITH_PROVIDER_ID` → DLQ (our own broken deal) |

**Only signed deals create customers.** Harmon wants records for deals that actually
sell, not for every dealer's pipeline.

**Ordering consequence, accepted:** a dealer deal's `sent`/`viewed` events arrive
*before* the customer exists and are dropped, so the created record starts life at
`signed`. Earlier statuses are **not** backfilled.

**Idempotency** is structural: the create is a Salesforce **upsert keyed on
`Aurora_Project_ID__c`** (an External ID field), so duplicate deliveries and
concurrent workers converge on exactly one record — no select-then-insert race. If
two records already carry the same value, Salesforce answers 300 and the event
dead-letters rather than looping.

**Dealer attribution:** `partner_id` → the partner's name via List Partners (Aurora
"partner" = external dealer org); failing that, `owner_id` → the user's name via
Retrieve User; failing that, the raw id. Attribution never fails an import — a 403 on
those endpoints degrades to raw ids plus a warning.

**Where the record lands (Tim, 2026-08-07; widened 2026-08-10):** `Status__c` =
**`Customer`** and `Stage__c` = **`Sold - Pending Review`** — on **every** signed
agreement, not just auto-created ones. A pre-existing customer matched by
`Aurora_Project_ID__c` gets the same two values on its signed write-back, from the
same shared helper, so the dealer and non-dealer paths cannot drift.

The first matters more than it looks — the org default for `Status__c` is **`Lead`**,
so without it a closed sale would sit in the CRM as a lead. **The second is the
notification mechanism:** Harmon's Salesforce alerts fire off that Stage, which is
why the SES email channel is deliberately left unconfigured. If `Sold - Pending
Review` is ever renamed in the org, the write is skipped with a warning **and the
alerts silently stop firing**.

No other status moves the pipeline: a `sent`/`viewed` event doesn't, a confirmed
cancellation doesn't promote a dead contract, and a `signed` event that Aurora
contradicts on re-read records Aurora's status only.

Every picklist the import writes (`State__c`, `Lead_Source__c`, `Status__c`,
`Stage__c`) goes through the same match-or-skip guard — matched case-insensitively,
written in the **org's** canonical casing, and if the value has been renamed or
removed, left unset with a warning and the intended value recorded in the import
notes. An invalid picklist value fails the entire insert, and a signed contract is
not worth losing over a renamed picklist entry.

**Everything retrieved but not mapped** goes into `Aurora_Import_Notes__c` as
`key: value` lines under an `Auto-created from Aurora signed agreement … on …`
header: raw property address, country, salutation, mailing address, partner/owner/
team ids, tags, an out-of-picklist state, a missing lead-source value. Nothing Aurora
told us is silently dropped.

**Review these records.** They are built from Aurora data alone — no Sundial design
request, no Harmon-side qualification. The signed-agreement email flags them
("This customer was AUTO-CREATED…") and names the dealer. `Sold - Pending Review` is
the queue that review should work from.

**Two fields and one picklist value are still missing** (TASKS.md):
`Aurora_Dealer_Name__c`, `Aurora_Import_Notes__c`, and the `Lead_Source__c` value
`Aurora - Third-Party Dealer`. Until they exist the import still succeeds — the
values are simply not written, and the gap is reported in the email.

## Operating notes

**Reading the DLQ.** Anything in `sundial-aurora-inbound-dlq` needs a human. Search
CloudWatch for the agreement id; the log line says which class it was:
- `PERMANENT AURORA_NOT_PROVISIONED (403)` — our API key isn't provisioned for that
  endpoint. **Contact Aurora's account team**; no amount of retrying will fix it.
  On Retrieve Project this disables dealer origination entirely.
- `PERMANENT UNMATCHED_WITH_PROVIDER_ID` — a **non-signed** event for a project with
  no matching customer but which *does* carry an `external_provider_id`: a
  Sundial-originated deal with a broken `Aurora_Project_ID__c` link. Repair the link
  on the customer, then redrive. (The equivalent **signed** event repairs itself
  automatically — see the dealer-origination table above. `NO_CUSTOMER_MATCH` no
  longer exists; D-049 replaced it.)
- `PERMANENT AMBIGUOUS_CUSTOMER_MATCH` — two customers carry the same
  `Aurora_Project_ID__c`. Merge or clear one, then redrive.
- `PERMANENT PROVIDER_ID_MISMATCH` — Aurora's `external_provider_id` disagrees with
  the customer we resolved. Do not "fix" this by editing ids until you know which one
  is wrong.
- `PERMANENT MISSING_DESIGN_ID` — the subscription's `url_template` is missing
  `design_id` (Part C).
- `RETRYABLE ...` — transient. Redrive the queue.

**Redrive:** `aws sqs start-message-move-task --source-arn <dlq-arn> --region us-west-1`.

**Post-signature cancellations (D-048 amendment, 2026-08-04).** Neither the webhook
nor the agreement object carries a status timestamp, so delivery order cannot tell a
real cancellation from a stale one. For `canceled`, `cancel-pending`, and `declined`
the worker therefore **re-reads the agreement from Aurora** and uses its current
status as the authority:

- Aurora confirms the negative status → it is applied **even over a recorded
  `signed`**, and the design manager gets a cancellation email (subject flagged
  `AFTER SIGNING` when it contradicts a recorded signature). Log line:
  `was recorded as SIGNED and Aurora now reports "..."`.
- Aurora still says `signed` → the event is dropped as stale. Log line:
  `dropping stale "canceled" ... Aurora still reports "signed"`.

The **`signed` path behaves the same way**: it already re-reads the agreement to
confirm the signature, so if that re-read shows `canceled` / `cancel-pending` /
`declined` it records Aurora's status and sends the same cancellation email (with the
`AFTER SIGNING` flag when the record already said `signed`). A dead contract is
announced however we found out about it.

`error` is deliberately excluded (it is a fault signal, not "the contract is dead")
and stays governed by precedence. Exact duplicates short-circuit before the re-read,
so a redelivered cancellation costs no Aurora call and sends no second email; both
paths gate the email on the status actually changing.

**A cancellation after signing needs a human** even though it is now recorded
automatically: anything already started off the signed contract (project creation,
scheduling, commissions) still has to be unwound by hand.
