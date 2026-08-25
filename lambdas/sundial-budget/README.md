# Sundial Budget Lambda

Computes the Harmon solar project budget (ported cell-for-cell from the Sunbase Budget
Sheet), writes the output fields back to `Sundial_Solar__c`, and drops a filled, datestamped
workbook snapshot into the project's S3 folder (`SUNDIAL/{record_id}/`). The Dropbox mirror
and XFiles Pro pick the file up from S3 automatically — no extra wiring.

## Files

| File | Purpose |
|---|---|
| `budgetCalc.js` | Pure calculation module — the single source of truth for the math. Also importable by the React portal for live what-if previews. |
| `budgetWorkbook.js` | Fills `template/budget-template.xlsx` with all input + computed values (values-only snapshot) and builds the S3 key `SUNDIAL/{id}/Budget_{Name}_{YYYYMMDD-HHMMSS}.xlsx`. |
| `handler.js` | Lambda entry point: API Gateway (portal button) + platform-event relay (field triggers). Wire the JWT auth block to the org-standard pattern used by the other Sundial Lambdas. |
| `template/budget-template.xlsx` | Faithful reconstruction of the Sunbase sheet, formulas intact (verified: recalculates to the HOLLAND example exactly). Swap in the pristine original any time — the writer only addresses cells. |
| `test.js` | `npm test` — verifies the calc against the HOLLAND workbook (32 checks) and builds a sample snapshot. |

## Recalc entry points

1. **Portal button** — `POST /projects/{recordId}/budget/recalc` through API Gateway.
   Synchronous; response includes the computed fields, so the UI can refresh instantly.
2. **Field-change triggers** — ONE record-triggered Flow on `Sundial_Solar__c` (after-save):
   - Entry condition: OR-list of `ISCHANGED()` on the milestone fields Harmon wants to
     drive recalcs (e.g. Audit Completed, Design Review Finalized) **plus** any budget
     input field, so edits made directly in Salesforce also recalc.
   - Actions: set `Budget_Calc_Status__c = 'Pending'`, publish `Sundial_Budget_Recalc__e`
     with `Record_Id__c = {!$Record.Id}`, `Source__c = 'FieldTrigger'`.
   - The event reaches this Lambda through the existing Platform Event → EventBridge relay
     (same pattern as the Acumatica queue triggers).
3. **Admin** — checking a field or firing the Flow manually from Salesforce works the same way.

Status fields tell everyone where things stand: `Budget_Calc_Status__c`
(Pending → Calculated / Error), `Budget_Last_Calculated__c`, `Budget_Calc_Error__c`,
`Latest_Budget_File_Path__c`.

## Environment

| Var | Value |
|---|---|
| `S3_BUCKET` | `sfsolproj` (defaults to this if unset) |

Salesforce access is the org-standard path via `lib/salesforce.js`, which reads the
Connected App consumer key, integration username, private key, and login URL from the
`sundial/salesforce/connected-app` Secrets Manager secret. **No `SF_LOGIN_URL` or JWT
env vars are needed here** — the shared helper (and the execution role's
`SecretsManagerReadWrite`) provide them, same as every other Sundial Lambda.

## Notes

- **Percent fields have THREE domains in Salesforce and they disagree** (D-063, measured by
  `scripts/probe-percent-field-domain.mjs`):

  | Layer | Domain | A true 25% is |
  |---|---|---|
  | metadata `<defaultValue>` | decimal | `0.25` |
  | REST API / SOQL | **display** | `25` |
  | formula field reference | decimal | `0.25` |

  This Lambda reads through SOQL, so `Labor_Burden_Rate__c`, `Commission_Burden_Rate__c` and
  the NS markups all arrive as whole numbers (75 = 75%) and `budgetCalc.js` divides by 100.
  **That is correct — do not remove it**, and do not divide twice.

  The Salesforce `Total_Adder_Price__c` formula does the same job with **no** `/100`,
  because a formula already receives the decimal. The two look inconsistent and are not;
  both land on the same multiplier. `<defaultValue>25</defaultValue>` on the NS markup
  fields is what caused the 2500 incident — it meant 2500%.
- **`BURDEN_RATE_IMPLAUSIBLE`** throws when `Labor_Burden_Rate__c` or
  `Commission_Burden_Rate__c` exceeds **100%**, checked before either becomes a multiplier.
  These two feed almost every cost line, so a bad one moves the whole budget rather than one
  number. `<defaultValue>75</defaultValue>` stored **7500** on 4,473 of 4,474 Solar records
  (D-063a) — and unlike the markup case nothing cancelled it, so the calc would have
  produced burden figures 100x too large. Sweep with
  `node scripts/fix-burden-rate-percent-domain.mjs` (read-only by default).
- **Before adding any Percent field**, run `node scripts/audit-percent-field-defaults.mjs`.
  It checks every Percent field on every Sundial object, metadata *and* data, and exits
  non-zero on a suspect. Six instances of this bug were found by that audit rather than by
  anyone noticing.
- **`NS_MARKUP_IMPLAUSIBLE`** throws when any NS block's markup exceeds **100%**, before any
  adder maths and regardless of whether the block has material. A 2500 is the decimal-domain
  default bug and would be a 26x multiplier on materials. Sweep with
  `node scripts/fix-ns-markup-percent-domain.mjs` (read-only by default).
- The snapshot is **values-only** on purpose: it's the frozen record copy of what was
  calculated. The template (with live formulas) stays the working calculator.
- File metadata registration in Supabase (per `docs/file-storage.md`) is marked TODO in
  `handler.js` — wire it to the existing file-metadata helper when integrating.
- **Storage price terms (D27) have no sheet row.** `Battery_Unit_Price__c × Battery_Qty__c`
  and `Tesla_Expansion_Pack_Unit_Price__c × Gateway_Qty__c` go straight into the **K39**
  adder-price rollup, because the REVISED workbook has battery/gateway *cost* parameters
  (B11/C11, B13/C13) but no adder *price* row for storage. **This is the one place the
  snapshot and the sheet layout intentionally differ** — K39 can exceed the sum of the adder
  rows above it, by exactly the storage price. `extras.batteryPriceTotal` /
  `expansionPriceTotal` / `storagePriceTotal` break it out.
- **`Gateway_Qty__c` is the Tesla expansion-pack quantity**, not a separate gateway (§3
  reuse — its label is literally "Tesla Expansion Pack Qty"). Solar's
  `Tesla_Expansion_Pack_Quantity__c` is an orphan nothing maintains; repointing the calc at
  the matching name would price every expansion pack at zero. The same pairing is used by
  the `Total_Adder_Price__c` formula, and tests pin both halves.
- **Storage is PRICE-side only.** The cost side was already complete
  (`Battery_Unit_Cost__c × Qty` → F16, `Gateway_Unit_Cost__c × Qty` → F14, battery labor and
  burden via F32/F33). Adding cost alongside the price would double-count it.
- **`PPW_PRICE_IMPLAUSIBLE` (D28)** throws when any of the four per-watt adder prices exceeds
  **$10/W**, before any adder maths runs and regardless of qty. These multiply by watts, so a
  flat dollar total typed into one is a factor-of-thousands error — the cause of the $2.5M
  incident on `a1P7y00000AlufJEAR`. Real values are cents. Sweep existing data with
  `node scripts/backfill-storage-adder-prices.mjs` (read-only by default).
