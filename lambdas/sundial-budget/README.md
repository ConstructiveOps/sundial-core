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

- Percent fields (`Labor_Burden_Rate__c`, `Commission_Burden_Rate__c`, NS markup) are stored
  as whole numbers in Salesforce (75 = 75%); `budgetCalc.js` divides by 100 — don't do it twice.
- The snapshot is **values-only** on purpose: it's the frozen record copy of what was
  calculated. The template (with live formulas) stays the working calculator.
- File metadata registration in Supabase (per `docs/file-storage.md`) is marked TODO in
  `handler.js` — wire it to the existing file-metadata helper when integrating.
