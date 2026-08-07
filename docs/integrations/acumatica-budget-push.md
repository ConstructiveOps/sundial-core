# Acumatica ProjectBudget Push (Budget Layer 2)

> Consumer: `lambdas/sundial-acumatica-budget-push/`. Populates the values on a
> project's **existing** template-scaffolded `ProjectBudget` lines from the Sundial
> budget outputs. **Status: read + reconcile scaffolding only. Gate 5a (data) is
> DONE — mapping keys reconciled to the live R269999 scaffold (2026-08-07). The
> write path stays hard-guarded, now gated on Gate 5b sign-off (see below).**

## Trigger chain (per CLAUDE.md queue pattern)

`Budget_Finalized__c = true` (record-triggered Flow on `Sundial_Solar__c`) →
Platform Event → SQS (`sundial-acumatica-outbound` pattern) → this consumer Lambda →
Acumatica REST.

- **Gate:** only push when `Budget_Calc_Status__c = 'Calculated'`. If `Pending`/`Error`,
  requeue with backoff or fail to the DLQ — never push stale numbers.
- **Ordering:** `Budget_Finalized__c` realistically only becomes true **after**
  `Synced_to_Acumatica__c = true` (Layer 1), because the project must already exist
  in Acumatica with its RS template budget scaffolded (~38 lines) before we can
  populate it. Do not build a path that assumes finalize can precede project creation.
- Rate limits: exponential backoff on 429/`Retry-After`; all outbound via SQS.

## The pattern: read → match-by-full-key → update-by-GUID (NOT insert)

These 17 lines are **UPDATES to existing scaffolded rows**, never new inserts. The
RS template already created the budget lines when the project was created.

1. **Read existing lines:** `GET /entity/Default/25.200.001/ProjectBudget?$filter=ProjectID eq '{Acumatica_Project_ID__c}'`.
   Encode the filter with `URLSearchParams` (spaces → `%20`, quotes → `%27`) — see
   `lib/acumatica.js » getAcumaticaEntity`. Raw string filters mangle in PowerShell.
2. **Zero lines → STOP for that project** (fail to DLQ). The project wasn't created
   or the scaffold failed. Do **not** create budget lines from scratch.
3. **Match each mapping row to EXACTLY ONE line by the FULL natural key:**
   `ProjectTaskID + AccountGroup + InventoryID + Type`. Task-code alone (or
   task+group+type) is **not unique** — e.g. `BURDENEXR`/LABOR/Expense recurs with
   different `InventoryID`. A row matching 0 or >1 lines **fails loudly** with the
   ProjectID + offending key. Never guess, never insert a fallback.
4. **Update by GUID:** `PUT /entity/Default/25.200.001/ProjectBudget/{id}` setting
   `OriginalBudgetedAmount`; labor lines also set `OriginalBudgetedQty` (hours) with
   `UOM = HOUR`. Address by the line's own GUID `id`, not a key-field upsert.

**Skip-zero rule:** leave a scaffolded line at its current value rather than writing
`0`, **except** the income line(s), which are always written.

## Mapping corrections (from the scaffold reference)

- **Income is TWO lines, not one.** There is **no `BILL` task** — it has been removed.
  Income maps to `BALANCE` (Balance of Contract) and `GENM`/BILLING (Solar Material),
  both `Type = Income`. `GENM/BILLING/Income` is distinct from `GENM/MATERIAL/Expense`
  (the material cost line) — the 4-part key separates them.
- **Sum-into-one-line.** Where several mapping rows share one scaffold line (e.g. the
  three `GENO`/OTHER rows: Other Material, CO Fee, Permit), the amounts **sum into
  that single line** — never create duplicates. `matchMappingToLines` groups complete
  keys and sums.
- **Dealer fee** — `DLR` is the Dealer-fee line (confirmed; resolves one "(confirm)").
  Send only when > 0.

## ✅ Gate 5a — RESOLVED (live harvest of R269999, 2026-08-07)

The blocker was that the mapping sheet's **"AccountGroup" column actually held the
InventoryID.** A read-only reconcile of the canonical sandbox project **R269999**
(38 scaffolded lines) gave the true 4-part key per line. Two corrections fell out:

- **The REAL `AccountGroup` is `BILLING` / `LABOR` / `OTHER` / `MATERIAL`** — the
  commission lines are `AccountGroup=LABOR` with `InventoryID=SALESCOMM` (not
  `AccountGroup=SALESCOMM`). `InventoryID` is what separates the two `BURDENEXR`
  lines: `SALESCOMM` (Commission Burden) vs `RESIDENTAL` (Labor Burden).
- **⚠️ `RESIDENTAL` is the Acumatica-side spelling** (missing the second "I"). It is
  intentionally kept misspelled in `MAPPING_ROWS` and this sheet — **do not
  "correct" it** or every `RESIDENTAL` line fails to match. `<N/A>` is a **literal**
  `InventoryID` value (compared as the literal string).

### Reconciliation table (all 18 code rows → full 4-part key)

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

A clean matched-run against R269999: **18 rows → 15 groups → 0 problems** (the SLPC
2→1 and GENO 3→1 sums collapse into one scaffold line each).

### Two resolutions (with rationale)

- **`GENA` "Audit + QA Labor" → `LABOR · RESIDENTAL · Expense`.** `GENA` matched two
  scaffold lines: the internal-labor line (`LABOR·RESIDENTAL`, UOM=HOUR) and an
  outside-services line (`OTHER·AUDIT SVCS`). Resolved to the **labor** line —
  internal employee audit/QA labor, qty from `GENA_Hours__c`, UOM=HOUR, consistent
  with the other labor lines. Confirmed.
- **Geo commission → `APPT COM` (`LABOR · SALESCOMM · Expense`).** Confirmed from
  role semantics: `APPT COM` = appointment-setter flat commission (Geo's role).
  **⏳ Harmon finance sign-off required before the first PRODUCTION push** (Gate 5b;
  `PENDING_HARMON_SIGNOFF` in the code).

## Canonical sandbox test pair

- **ProjectID `R269999`** (Acumatica BizRun sandbox) with customer **`C001311112`** —
  created via the proven Layer-1 push. This is the reference project for reconcile
  runs and, later, the first hand-proven write. Full harvest kept at
  `scratchpad/R269999-reconcile.json`.

## Reconcile invoke (read-only — run before any write; no writes happen in this mode)

The Lambda takes the event **as the payload directly** (not an API Gateway body) and
requires **no JWT** — it's an internal, unauthenticated read. Payload:
`{ "acumaticaProjectId": "R269999" }` (or `{ "recordId": "<Sundial_Solar__c Id>" }`,
which resolves `Acumatica_Project_ID__c`). Per repo convention (payload via file):

```powershell
'{ "acumaticaProjectId": "R269999" }' | Out-File -FilePath payload.json -Encoding ascii -NoNewline
aws lambda invoke --function-name sundial-acumatica-budget-push --region us-west-1 `
  --cli-binary-format raw-in-base64-out --payload file://payload.json out.json
Get-Content out.json
```

Response carries every scaffold line keyed by the full natural key + GUID `id`, the
`mappingMatch` (matched vs problems), and a `gate5b` checklist. **Confirm all rows
match with 0 problems.**

## Gate 5b — sign-off before the write path is built

The write path (`writeBudgetLines`) stays hard-guarded. Before it is implemented:
1. A reconcile run against R269999 shows **all rows matched, 0 problems** (done ✔).
2. **Harmon finance signs off** on the Geo → `APPT COM` mapping.
3. **Tim approves the hand-proven write plan** (which line each amount/qty targets,
   the skip-zero rule, income-line handling) before any code writes to Acumatica.
