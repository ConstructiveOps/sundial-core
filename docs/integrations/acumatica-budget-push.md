# Acumatica ProjectBudget Push (Budget Layer 2)

> Consumer: `lambdas/sundial-acumatica-budget-push/`. Populates the values on a
> project's **existing** template-scaffolded `ProjectBudget` lines from the Sundial
> budget outputs. **Status: read + reconcile scaffolding only — the write path is
> hard-guarded off pending two confirmations (see Blockers).**

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

## 🚧 Remaining blocker — resolve at Gate 5a before any write

- **The mapping tab has NO `InventoryID` column** (columns: Budget Line, ProjectTaskID,
  AccountGroup, Type, Amount Source, Qty Source, Notes). Without `InventoryID` the
  4-part key is not unique — `SLPC` (Sales Rep + Overhead) and `BURDENEXR` (by account
  group) collide, and the sum-grouping can't tell "same line, sum" (GENO) from
  "different lines" (SLPC). **InventoryID (and the income account groups / amount
  splits) must be read from the live scaffold and filled in** before the write path is
  safe. Until then `matchMappingToLines` flags every row missing a key part.

## Still unconfirmed (config map, never guessed)

- **Geo commission task code** — the sheet shows none (`UNCONFIRMED.geoCommissionTaskId = null`).

## Gate 5a reconciliation (read-only, run first)

Invoke the consumer in reconcile mode with `{ "recordId": "<Sundial_Solar__c Id>" }`
(or `{ "acumaticaProjectId": "<id>" }`). It returns every existing scaffolded line
keyed by the full natural key + its GUID `id`, plus the mapping-match result
(matched vs problems). Confirm all 17 mapping rows each resolve to exactly one line —
**no writes happen in this mode.**
