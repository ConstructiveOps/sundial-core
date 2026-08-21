# Harvested ProjectBudget scaffolds

Raw `reconcile` output from two **live** Acumatica projects, captured 2026-08-20. These
are committed on purpose: `test.js` runs the v3 mapping against them, which is the
closest thing to the live reconcile that can run offline, and it is what will notice if
the Acumatica template changes under us.

| File | Project | Template | Lines |
|---|---|---|---|
| `R261077-rs.json` | R261077 | RS | 38 |
| `R261066-rsdc.json` | R261066 | RSDC | 39 |

**The RSDC scaffold is the RS scaffold plus exactly one line** —
`DCREBATE | BILLING | <N/A> | Income` ("Domestic Content Rebate"). That is asserted by a
test, because it is the entire practical difference between the two templates.

## What this harvest settled

| Question | Answer |
|---|---|
| `SLPC OUT` spacing | **One space.** Both scaffolds agree. The REVISED sheet's H7 label shows two — a typo in the sheet, not the Acumatica task id. |
| Does `ENGR` exist, or is it the SUBCON line? | **`ENGR \| SUBCON \| <N/A> \| Expense` exists**, distinct from `SUBCON \| SUBCON \| <N/A>`. §5's "ENGR?" guess was right. |
| `SOFTWARE` | Exists: `SOFTWARE \| OTHER \| <N/A> \| Expense`. |
| `REFERRAL` (Q12a / D13) | **ABSENT from both.** D13 predicted it. Harmon must add it to the template before any job can push a referral fee. |
| DC rebate key | `DCREBATE \| BILLING \| <N/A> \| Income`. |
| Q12b — does BALANCE include the rebate? | **No.** Settled by the live math; the BALANCE row is unchanged. |

## Refreshing these

Re-run the reconcile (payloads in
`docs/integrations/acumatica-budget-push.md` → "v3 RE-HARVEST RUNBOOK") and drop the
output here under the same names. If the line count or a key changes, the tests fail —
which is the point. Do not hand-edit them.
