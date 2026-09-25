# Sundial Roofing Budget Lambda

Computes the Harmon roofing project budget (ported cell-for-cell from the Roofing Budget
sheet), writes outputs back to `Sundial_Roofing__c`, and drops a filled, datestamped
workbook snapshot into `SUNDIAL/{record_id}/` in S3 — identical architecture to the
solar budget Lambda.

## Files

| File | Purpose |
|---|---|
| `budgetCalc.js` | Pure calculation module — single source of truth. Importable by the React portal for live previews. 46-item material catalog keyed to field API names. |
| `budgetWorkbook.js` | Fills the template with all input + computed values (values-only snapshot on NEW BUDGET SHEET; CITY TAX RATES and ROOFING COMMISSIONS tabs ride along unchanged). |
| `handler.js` | Lambda entry (API Gateway + platform-event relay). Wire the JWT auth to the org pattern. |
| `template/roofing-budget-template.xlsx` | **Harmon's original workbook**, untouched — original formatting, formulas, and tax table intact. |
| `test.js` | `npm test` — 30 assertions against the Mills example. |

## Merging with the solar Lambda (recommended)

Deploy as ONE budget function. `Sundial_Budget_Recalc__e` is already object-agnostic —
route on `Record_Id__c`'s key prefix: `Sundial_Solar__c` records → solar calc/template,
`Sundial_Roofing__c` records → this calc/template. Same S3 bucket, same status-field
protocol (`Budget_Calc_Status__c` Pending → Calculated/Error), same snapshot naming.
The trigger Flow on `Sundial_Roofing__c` mirrors the solar one: ISCHANGED on budget
inputs (see `INPUT_FIELDS` in handler.js) + Harmon's milestone fields → status Pending →
publish the event. Add a loop guard (skip when `Budget_Last_Calculated__c` changed).

## City tax rates

`City_Tax_Rate__c` is an input; the portal auto-fills it from the city→rate table
(93 AZ cities, in `docs/Sundial_Roofing_Budget_Fields.xlsx` "City Tax Rates" tab —
build it into the portal config). Keeping the rate as a field means rate changes never
require metadata changes, and any job can override.

## Deliberate deviations from the sheet (confirm with Harmon; each is one line)

1. Cost-per-square divides by TOTAL squares — the sheet divides by tile squares only (breaks on non-tile jobs).
2. Burden is one input (`Burden_Rate__c`, default 20) — sheet hardcodes 20% in three places.
3. Commission rate applies to the marked-up cost subtotal (as the sheet's formula does), though the sheet's tier legend says contract price. Tier guide: margin ≥30% → 2.5%, 25–30% → 2%, 20–25% → 1.5%, <20% → none (manual entry for now; portal could auto-suggest from computed margin).

Percent fields (`Burden_Rate__c`, markups, commission rate, `City_Tax_Rate__c`) are stored
as whole numbers in Salesforce (20 = 20%); `budgetCalc.js` divides by 100 — don't do it twice.
