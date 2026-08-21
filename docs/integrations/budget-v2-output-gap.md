# budgetCalc v2 — output field gap list

> **STOP / REVIEW ITEM.** budgetCalc v2 computes values that have nowhere to land on
> `Sundial_Solar__c`. This is the list. **No fields were invented** — the values are
> returned in the calc's `extras` object so nothing is lost, and nothing is written.
>
> Produced 2026-08-20 against the live describe. Reference:
> `acumatica-budget-rework-v2.md` §4, D9/D10/D11/D12/D13/D16.

---

## Summary

| | Count |
|---|---|
| v1 output fields still written, unchanged meaning | 48 |
| v1 output fields still written, **meaning changed** ⚠️ | 4 |
| v2 values with **no field** — decision needed | 13 |
| Milestone/attribute splits — **not computed by this task** | 6 |

All 55 pre-existing budget output fields still exist in the org and are still written.
Nothing was dropped.

---

## A. Fields whose MEANING changed — read before wiring any UI

These four keep their API name and their value type, but no longer mean what they
meant in v1. A consumer that was not updated will be quietly wrong rather than broken.

| Field | v1 meaning | v2 meaning | Risk if unchanged |
|---|---|---|---|
| `Sales_Rep_Commission_Amt__c` | the only rep commission | the **third-party** rep amount (`Sales_Rep_Commission_PPW__c` is being relabelled "3rd Party Rep Commission PPW", §4d) | On an internal deal this is **0** and the real commission is in the un-homed `internalCommissionAmt`. A UI showing "Sales Rep Commission" would report zero commission on a real deal. |
| `Total_Other_Budget__c` | `Material_Other` + standard-adder material | **GENO line J16** = Material Other + CO fee + permit + Active Monitoring + LR Battery Warranty (D12) | **Double-count trap:** `Constructive_Ops_Total__c` (CO fee + permit) is now a SUBSET of this. Anything summing both over-reports by that amount. |
| `Audit_Labor_Cost__c` | audit labor only | the **GENA line** = audit + QA labor (sheet J21) | Adding it to `QA_Labor_Cost__c` now double-counts QA. |
| `Total_Labor_Budget__c` | labor + burden | **labor ONLY** (sheet J26). Labor+burden is `Total_Labor_And_Burden__c` (sheet N12) | Differ by 1,953.75 in the fixture. The GP formula uses N12. |

`Gateway_Cost__c` also now holds the **Tesla Expansion Pack** cost — the `Gateway_*`
input fields are reused (§3), relabel pending. Same number, different product.

---

## B. v2 values with NO field — the actual decision list

Every one of these is computed and available in `extras`. Grouped by why you might
want it stored.

### B1 — Commission amounts (needed by the PO engine and the portal)

| Value | `extras` key | Fixture | Why it needs a home |
|---|---|---|---|
| Internal rep commission | `internalCommissionAmt` | 0 | The counterpart to `Sales_Rep_Commission_Amt__c`. Without it an internal deal shows no commission anywhere on the record. **Highest-value gap.** |
| Management combined (the SLMC line) | `managementCommissionAmt` | 484 | The components are stored (`Sales_Mgr_Commission_Amt__c` 352 + `Overhead_Commission_Amt__c` 132) but the line that actually posts to Acumatica is their sum. Derivable, but every consumer re-deriving it is how the two drift. |
| Setter commission applied | `setterCommissionAmt` | 70 | `Geo_Commission_Amount__c` is the **input** ($70 always). This is whether it **applied** — 0 when the Customer has no `Setter__c` (D17). You cannot tell one from the other today. |
| Deal type | `dealType` | `third_party` | `third_party` / `internal` / `none`. D16 makes this the switch for PO creation. The PO engine needs it on the record, not recomputed. Suggest a restricted picklist. |

### B2 — Budget lines that push to Acumatica but aren't stored

D11 made all four of these part of Total Job Cost. They post to their own Acumatica
lines, so a reconcile or a "why did the budget change" question has nothing to read.

| Value | `extras` key | Fixture | Acumatica line |
|---|---|---|---|
| Engineer stamps | `engineerStampsCost` | 250 | `SUBCON · ENGINEERING COSTS` |
| Subcontractor | `subcontractorCost` | 528 | `SUBCON · SUBCONTRACTOR` |
| Software | `softwareCost` | 30 | `SOFTWARE · AUDIT SOFTWARE` |
| Referral | `referralCost` | 500 | `REFERRAL · OTHER · REFERRAL FEE` (D13 — new task code) |

### B3 — Revenue and summary

| Value | `extras` key | Fixture | Note |
|---|---|---|---|
| DC rebate amount | `dcRebateAmount` | 0 | 0.45 × watts when domestic content is on (D2). A **third income line** on RSDC projects — it changes Balance of Revenue and GP, and there is no record of it. |
| Summary "Total Other*" (N13) | `summaryTotalOther` | 3858 | GENO + stamps + subcontractor + software + referral. This is the figure the GP formula nets, and it is **not** `Total_Other_Budget__c` (2550). |
| GENO adder portion | `genoAdderCost` | 700 | Active Monitoring + LR Warranty inside GENO. Only useful if someone needs to explain the GENO number. Low value. |

### B4 — NS blocks 4 and 5

| Value | `extras` key | Note |
|---|---|---|
| `nsAdder4Total`, `nsAdder5Total` | both | `NS_Adder_1/2/3_Total__c` exist and are written. Blocks 4 and 5 shipped in the field package **without** matching `_Total__c` fields, so the pattern is now inconsistent. Either add two fields or drop the three (they are all derivable). |
| `stdAdderPriceTotal` | 3110 | Sheet K39, the commission-side adder total. `Total_Adder_Cost__c` holds the COST side. Only matters once §4e per-adder commission formulas land. |

---

## C. Milestone / attribute splits — NOT computed here, deliberately

The live attribute pull (project R251282) shows six commission attributes:
`SLSCOM1` / `SLSCOM2`, `MGRCOM1` / `MGRCOM2`, `MGMTOR1` / `MGMTOR2`.

**budgetCalc v2 does not compute these, and should not.** They are a *payment-schedule*
split of amounts the calc already produces, and the split rule is PO-engine logic that
is still gated on open questions:

- third-party: `M1 = min(50% × total, $2,500)` at Site Audit Complete, `M2 = balance`
  at Glass on Roof — the live pull corroborates (SLSCOM1 exactly 2500, SLSCOM2 4814)
- internal: 75 / 25, payroll only, **no POs** (D16)
- MGRCOM* derives from the .04 component, MGMTOR* from the .015 (D10) — which is
  precisely why the calc keeps them separate rather than only emitting the 0.055 sum

Putting a capped-milestone rule inside a pure math function would also make the
regression fixture depend on PO policy. Recommend they live in the PO/attribute stage
(§6/§7) and, if stored, in the §4f PO-tracking field set.

Listed here only so the gap is visible in one place.

---

## D. Recommended shape (for review — NOT built)

If you want these stored, the minimum set that removes real ambiguity is **eight**
fields on `Sundial_Solar__c`:

| Suggested API name | Type | Source |
|---|---|---|
| `Internal_Rep_Commission_Amt__c` | Currency(16,2) | `internalCommissionAmt` |
| `Management_Commission_Amt__c` | Currency(16,2) | `managementCommissionAmt` |
| `Setter_Commission_Amt__c` | Currency(16,2) | `setterCommissionAmt` |
| `Commission_Deal_Type__c` | Picklist (restricted): `3rd Party` / `Internal` / `None` | `dealType` |
| `DC_Rebate_Amount__c` | Currency(16,2) | `dcRebateAmount` |
| `Engineer_Stamps_Cost__c` | Currency(16,2) | `engineerStampsCost` |
| `Subcontractor_Cost__c` | Currency(16,2) | `subcontractorCost` |
| `Total_Other_Summary__c` | Currency(16,2) | `summaryTotalOther` (the GP figure) |

Deliberately **not** in that eight: `softwareCost` and `referralCost` (trivially
`price × qty` off fields already on the record), `genoAdderCost`, `stdAdderPriceTotal`,
and the NS 4/5 totals — all cheap to derive and none of them answer a question the
others don't.

**Nothing is blocked on this.** The calc runs, the fixture passes, and the push worker
can read `extras` directly. Storing them matters for the portal, for reconcile, and for
anyone asking "why did this job's margin move" three months from now.
