# Acumatica ProjectBudget Push (Budget Layer 2)

> Consumer: `lambdas/sundial-acumatica-budget-push/`. Populates the values on a
> project's **existing** template-scaffolded `ProjectBudget` lines from the Sundial
> budget outputs. **Status: write path BUILT (Stages 1–5, 2026-08-07). Gate 5a (data)
> and Gate 5b (sign-off) are satisfied. Remaining before production is the live
> proof-out in the runbook below (deploy + wire + FLS + IAM + end-to-end test).**

## Trigger — direct portal call (relay dropped from this path)

The portal **"Update Budget"** button calls `POST /projects/{recordId}/budget/push`
on the Sundial REST API directly. There is **no** Salesforce Flow → Platform Event →
relay → SQS chain on this path — see **ADR D-049**. The request validates the gates,
returns **202** immediately, and hands the work to an **async self-invoke** of the same
Lambda (`InvocationType: Event`), because API Gateway caps a synchronous call at ~29s
while the write (fresh read + up to 15 PUTs with retry) needs the full function budget.

```
Portal button ──POST /projects/{id}/budget/push──▶ Lambda (HTTP mode)
                                                     ├─ gates pass → set Budget_Push_Status__c='Pushing'
                                                     ├─ self-invoke (Event) ──▶ Lambda (worker mode)
                                                     └─ return 202
                                          worker: read values → writeBudgetLines → SF write-back (one PATCH)
```

## The pattern: read → match-by-full-key → update-by-GUID (NOT insert)

These lines are **UPDATES to existing scaffolded rows**, never new inserts. The RS
template already created the budget lines when the project was created.

1. **Read existing lines FRESH** in the same run: `GET /entity/Default/25.200.001/ProjectBudget?$filter=ProjectID eq '{Acumatica_Project_ID__c}'`.
   Guids come only from this live read — never cached/stale. Encode the filter with
   `URLSearchParams` (see `lib/acumatica.js » getAcumaticaEntity`).
2. **Zero lines → ABORT** (`aborted:"no_scaffolded_lines"`). The project wasn't created
   or the scaffold failed. Never create budget lines from scratch.
3. **Match each mapping row to EXACTLY ONE line by the FULL natural key:**
   `ProjectTaskID + AccountGroup + InventoryID + Type`. A row matching 0 or >1 lines
   **aborts loudly** (`aborted:"match_problems"`) before any PUT, with the offending key.
4. **Update by GUID:** `PUT /entity/Default/25.200.001/ProjectBudget/{id}` setting
   `OriginalBudgetedAmount` (`{ id, OriginalBudgetedAmount:{value} }`); labor lines
   (scaffold `UOM = HOUR`) also set `OriginalBudgetedQty`. Address by the line's own
   GUID, not a key-field upsert.

### Write semantics (per matched group)

- **Amount** = sum of the mapping row(s)' `amountField`(s). Composites split on `+`
  (`Audit_Labor_Cost__c+QA_Labor_Cost__c`) and **`-`** for the computed income line.
- **Skip-zero:** expense lines whose amount is 0 are **left as-is** (not written).
  **Income lines are ALWAYS written.**
- **Labor qty:** `OriginalBudgetedQty` is written only for HOUR lines with a real hours
  source (GENA / S1 / S2 / S3). HOUR lines without one (ROOFCOM piece-rate, Labor
  Burden) get amount only — we never overwrite the scaffold qty with a bogus 0.
- **Retry:** each PUT retries on 429 / 5xx with exponential backoff (0.5/1/2s, 4
  attempts). A non-429 4xx is a real rejection — not retried.

### Income sources (resolved 2026-08-07)

Income is **two** lines. The verified contract field is **`Contract_Amount__c`** (chosen
over the look-alike `Contract_Amount_2__c` — `Contract_Amount__c` is what `budgetCalc.js`,
the budget handler, the test fixture, and the mapping sheet all use).

| Income line | Key | Amount source |
|---|---|---|
| Balance of Contract | `BALANCE / BILLING / <N/A>` | **computed:** `Contract_Amount__c - Total_Material_Budget__c` |
| Solar Material | `GENM / BILLING / <N/A>` | `Total_Material_Budget__c` |

The two sum to `Contract_Amount__c` (material billed at cost; balance is the remainder).

### Re-push semantics — safe by construction

Every write is an **idempotent update-by-GUID** of an existing line with a deterministic
value; there are no inserts. Re-running a push (same or updated numbers) simply
overwrites the same lines. **The "Update Budget" button is re-runnable at will.**
`Budget_Finalized__c` is set `true` on the first success and **left true** on
subsequent pushes.

## Gates (HTTP mode, before the worker fires) → 409 unless all pass

1. `Budget_Calc_Status__c = 'Calculated'` — never push Pending/Error/blank numbers.
2. The linked customer's `Synced_to_Acumatica__c = true` — the Acumatica project +
   budget scaffold must already exist (Layer 1 done). Finalize realistically only
   follows project creation.
3. `Acumatica_Project_ID__c` is set — needed to target the ProjectBudget.

A record the caller's tenant doesn't own is `404` (indistinguishable from missing).

## Status fields on `Sundial_Solar__c` (deploy: `salesforce/budget-push-fields/`)

| Field | Type | Set when |
|---|---|---|
| `Budget_Push_Status__c` | Restricted picklist `Pushing`/`Pushed`/`Failed` | `Pushing` on request; `Pushed`/`Failed` by the worker |
| `Budget_Pushed_At__c` | DateTime | on success |
| `Budget_Push_Error__c` | LongTextArea | abort/fail reason (cleared on success) |

## Dry-run (read-only, no PUT, no SF write-back)

Direct-invoke the Lambda with `dryRunWrite`. It reads the record's budget values and
returns every computed per-line amount/qty exactly as a real push would, writing
nothing:

```powershell
'{ "dryRunWrite": true, "recordId": "<Sundial_Solar__c Id>" }' | Out-File -FilePath payload.json -Encoding ascii -NoNewline
aws lambda invoke --function-name sundial-acumatica-budget-push --region us-west-1 `
  --cli-binary-format raw-in-base64-out --payload file://payload.json out.json
Get-Content out.json
```

`{ "acumaticaProjectId": "R269999" }` also works (values default to 0 — useful only to
prove matching). Expect `mode:"dry_run_write"`, `ok:true`, and `results[]` with
`action:"would_write"` / `"skip_zero"`, income `BALANCE` flagged `computed:true`.

## Gate 5a — RESOLVED (live harvest of R269999, 2026-08-07)

The mapping sheet's "AccountGroup" column actually held the InventoryID. A read-only
reconcile of the canonical sandbox project **R269999** (38 scaffolded lines) gave the
true 4-part key per line.

- **Real `AccountGroup` is `BILLING` / `LABOR` / `OTHER` / `MATERIAL`.** Commission lines
  are `AccountGroup=LABOR`, `InventoryID=SALESCOMM`. `InventoryID` separates the two
  `BURDENEXR` lines: `SALESCOMM` (Commission Burden) vs `RESIDENTAL` (Labor Burden).
- **⚠️ `RESIDENTAL` is the Acumatica-side spelling** (missing the second "I"). Kept
  misspelled in `MAPPING_ROWS` and here — **do not "correct" it**. `<N/A>` is a
  **literal** `InventoryID` value.

### Reconciliation table (all code rows → full 4-part key)

| Mapping row(s) | ProjectTaskID | AccountGroup | InventoryID | Type |
|---|---|---|---|---|
| Income – Balance of Contract | BALANCE | BILLING | `<N/A>` | Income |
| Income – Solar Material | GENM | BILLING | `<N/A>` | Income |
| Dealer Fee | DLR | OTHER | `<N/A>` | Expense |
| Sales Rep + Overhead Commission (sum) | SLPC | LABOR | SALESCOMM | Expense |
| Sales Manager Commission | SLMC | LABOR | SALESCOMM | Expense |
| **Geo Commission** | **APPT COM** | LABOR | SALESCOMM | Expense |
| Commission Burden | BURDENEXR | LABOR | SALESCOMM | Expense |
| **Audit + QA Labor** | **GENA** | LABOR | RESIDENTAL | Expense |
| Roofing Labor | ROOFCOM | LABOR | RESIDENTAL | Expense |
| S1 / S2 / S3 Install Labor | S1 / S2 / S3 | LABOR | RESIDENTAL | Expense |
| Labor Burden | BURDENEXR | LABOR | RESIDENTAL | Expense |
| Total Material | GENM | MATERIAL | `<N/A>` | Expense |
| Other Material + CO Fee + Permit (sum) | GENO | OTHER | `<N/A>` | Expense |

Clean matched-run against R269999: **18 rows → 15 groups → 0 problems** (SLPC 2→1 and
GENO 3→1 sums collapse into one scaffold line each).

## Gate 5b — SATISFIED (2026-08-07)

1. Reconcile run against R269999 shows all rows matched, 0 problems ✔.
2. Harmon finance signed off on Geo → `APPT COM` (`LABOR/SALESCOMM`) ✔.
3. Tim approved the hand-proven write plan (skip-zero, income handling, computed
   BALANCE) ✔ — the write path was then built in reviewable stages.

## Canonical sandbox test pair

- **ProjectID `R269999`** (Acumatica BizRun sandbox) with customer **`C001311112`**.
  Reference project for reconcile + the first hand-proven write. Full harvest kept at
  `scratchpad/R269999-reconcile.json`.

---

## LIVE TEST RUNBOOK (Tim — run in order; each step says what to verify)

**Prereqs (once):**
- **IAM:** the `SelfInvokeBudgetPush` statement (`lambda:InvokeFunction` on this
  function's own ARN) is on `sundial-lambda-execution-role` — the async worker fails
  `AccessDenied` without it.
- **SF fields + FLS:** deploy `salesforce/budget-push-fields/` via Workbench, then grant
  the integration-user profile **Read + Edit** on the three `Budget_Push_*` fields
  (see that folder's README). Without Edit FLS the worker's write-back silently drops
  the fields and status sticks on `Pushing`.
- A **ZZ TEST** `Sundial_Solar__c` record whose `Acumatica_Project_ID__c` points at a
  scaffolded sandbox project (e.g. R269999), `Budget_Calc_Status__c='Calculated'`, and
  whose linked customer is `Synced_to_Acumatica__c=true`.

### 1. Deploy the Lambda
```powershell
.\deploy.ps1 sundial-acumatica-budget-push
```
Verify: `SUCCESS ... code updated`. (deploy.ps1 only updates code — timeout/memory/env
and the IAM/route are untouched.)

### 2. Wire the route (creates + deploys the API Gateway route — LIVE)
```powershell
.\scripts\wire-budget-push-route.ps1        # prompts before the prod deploy
```
Verify: prints `SUCCESS: route live at .../prod/projects/{recordId}/budget/push`.
Idempotent — safe to re-run.

### 3. Dry-run against the ZZ TEST record (read-only — writes NOTHING)
```powershell
'{ "dryRunWrite": true, "recordId": "<ZZ_TEST_SOLAR_ID>" }' | Out-File -FilePath payload.json -Encoding ascii -NoNewline
aws lambda invoke --function-name sundial-acumatica-budget-push --region us-west-1 `
  --cli-binary-format raw-in-base64-out --payload file://payload.json out.json
Get-Content out.json
```
Verify: `mode:"dry_run_write"`, `ok:true`, `summary.failed=0`, and the per-line
`results[]` amounts/qty look right (income `BALANCE` shows `computed:true`; expense
zeros show `skip_zero`). **Nothing is written to Acumatica or Salesforce in this step.**

### 4. Real push via the HTTP route (the live write)
Needs a valid **Supabase JWT** for a Harmon user in the tenant (grab it from the portal
session — browser dev tools → the `Authorization` header, or your test-token helper).
```powershell
$JWT = "<paste Supabase access token>"
curl.exe -s -X POST "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod/projects/<ZZ_TEST_SOLAR_ID>/budget/push" `
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json"
```
Verify **immediately**: HTTP body is `202` `{ "status":"Pushing", ... }`. A `409` means a
gate failed (read the `code`: `BUDGET_NOT_CALCULATED` / `CUSTOMER_NOT_SYNCED` /
`NO_ACUMATICA_PROJECT`); `404` means the JWT's tenant doesn't own the record.

Then verify the async worker finished (a few seconds):
- **Salesforce** (SOQL in Workbench, on the ZZ TEST record):
  ```sql
  SELECT Budget_Push_Status__c, Budget_Pushed_At__c, Budget_Finalized__c, Budget_Push_Error__c
  FROM Sundial_Solar__c WHERE Id = '<ZZ_TEST_SOLAR_ID>'
  ```
  Expect `Pushed`, a fresh `Budget_Pushed_At__c`, `Budget_Finalized__c=true`, error blank.
- **Acumatica R269999 budget tabs:** open the project → the ProjectBudget lines now carry
  the pushed `OriginalBudgetedAmount` (and `OriginalBudgetedQty` on the labor lines).
- **CloudWatch** `/aws/lambda/sundial-acumatica-budget-push`: one `budget-push PUT <key>
  guid=<id> amount=<n>` line per written line; no unhandled errors.

### 5. Re-push (prove idempotency)
Re-run step 4. Verify the amounts don't double, `Budget_Finalized__c` stays `true`, and
status returns to `Pushed`. Re-push is safe by construction (update-by-GUID).

### ⚠️ Stuck-on-`Pushing` (worker hard-death)

If the worker hard-dies (OOM, timeout, cold-start crash) **after** the HTTP leg set
`Pushing` but **before** the write-back, the status stays `Pushing` — there is no
janitor. This is expected and recoverable:

- **The UI must NOT treat `Pushing` as a lock.** The "Update Budget" button stays
  **enabled** (or the record stays actionable) even while `Pushing`; do not gate the
  button on `!= Pushing`.
- **Re-push clears it.** Because every write is idempotent, simply pressing "Update
  Budget" again runs the full push and resets the status to `Pushed` (or `Failed` with a
  reason). No manual Acumatica cleanup is needed.
- If it recurs, check CloudWatch for the worker's exit cause before re-pushing.
