# v2 Budget Output Fields — Sundial_Solar__c

The §D minimum set from [`docs/integrations/budget-v2-output-gap.md`](../../docs/integrations/budget-v2-output-gap.md),
reviewed and approved 2026-08-20.

**8 new custom fields. Additive only — no existing field is modified.** Metadata API v62.0.

Every one is a **budgetCalc v2 output** that currently has nowhere to land and is
returned only in the calc's `extras` object. All are written by the budget Lambda; none
is a user input, none belongs on `Sundial_Customer__c`, and **none goes in the Create
Project mapping**.

| API name | Type | From `extras.` |
|---|---|---|
| `Internal_Rep_Commission_Amt__c` | Currency(16,2) | `internalCommissionAmt` |
| `Management_Commission_Amt__c` | Currency(16,2) | `managementCommissionAmt` |
| `Setter_Commission_Amt__c` | Currency(16,2) | `setterCommissionAmt` |
| `Commission_Deal_Type__c` | Picklist, **restricted**: `3rd Party` / `Internal` / `None` | `dealType` |
| `DC_Rebate_Amount__c` | Currency(16,2) | `dcRebateAmount` |
| `Engineer_Stamps_Cost__c` | Currency(16,2) | `engineerStampsCost` |
| `Subcontractor_Cost__c` | Currency(16,2) | `subcontractorCost` |
| `Total_Other_Summary__c` | Currency(16,2) | `summaryTotalOther` |

`Commission_Deal_Type__c` is a **restricted** picklist: the calc only ever writes those
three literals, so restricting turns a future typo into a save error instead of silent
bad data — same reasoning as `Budget_Push_Status__c`.

**Deliberately not included** (all derivable from fields already on the record, per §D):
`softwareCost`, `referralCost`, `genoAdderCost`, `stdAdderPriceTotal`, `nsAdder4Total`,
`nsAdder5Total`. They stay `extras`-only.

## Collision check

Live describe, 2026-08-20: **none of the 8 names exists** on `Sundial_Solar__c` (or on
`Sundial_Customer__c`).

---

## ⚠️ Zipping — Explorer only, never `Compress-Archive`

**Zip with Windows Explorer: select the files → right-click → *Send to* → *Compressed
(zipped) folder*.**

**Do NOT use PowerShell 5.1's `Compress-Archive`.** It writes entry paths with
**backslash** separators (`objects\Sundial_Solar__c.object`). The ZIP spec requires
forward slashes, and Workbench/the Metadata API cannot read those entries — the deploy
fails with a confusing "no components" or an empty-package error rather than anything
naming the real cause. This has bitten this repo before.

(7-Zip and `git archive` are fine too. Only PS 5.1's built-in cmdlet is the problem.)

---

## Deploy (Workbench)

1. Zip the **contents** of this folder so `package.xml` is at the zip root:
   ```
   package.xml
   objects/Sundial_Solar__c.object
   ```
   Zip those two items, not the folder. (`README.md` / `generate.mjs` are ignored by the
   Metadata API — include or omit, it makes no difference.)
2. Workbench → **Migration → Deploy** → choose the zip → tick **Single Package**.
3. **"Check Only" first.** Leave "Rollback on Error" ticked. Expect `Components: 8/8`.
4. Re-run without Check Only.
5. **Grant FLS — nothing works without it.**

## Post-deploy — FLS

- **Integration user: Edit on all 8.** The budget Lambda writes them; without Edit FLS
  the PATCH silently drops the field and the value never lands.
- **Everyone else: Read-only.** These are calculated outputs — the next recalc
  overwrites anything a user types, so an editable field here is a trap. Mirror whatever
  the existing budget outputs (`Total_Job_Cost__c`, `GP_Dollars__c`) grant; the exact
  profile list needs a `FieldPermissions` query run as yourself (the integration user
  lacks *View Setup and Configuration*):

  ```sql
  SELECT Parent.Profile.Name, Parent.Name, Parent.IsOwnedByProfile,
         Field, PermissionsRead, PermissionsEdit
  FROM FieldPermissions
  WHERE Field IN ('Sundial_Solar__c.Total_Job_Cost__c','Sundial_Solar__c.GP_Dollars__c')
  ORDER BY Field, Parent.Name
  ```

## After FLS — the calc still has to write them

**Deploying these fields does not populate them.** `budgetCalc.js` currently returns
them in `extras` and `handler.js` writes only the `fields` map. Promoting the eight from
`extras` into `fields` is a small follow-up change on the calc side — tracked in
TASKS.md, and deliberately not bundled here so the metadata can land first.

## Verify

```sql
SELECT Internal_Rep_Commission_Amt__c, Management_Commission_Amt__c,
       Setter_Commission_Amt__c, Commission_Deal_Type__c, DC_Rebate_Amount__c,
       Engineer_Stamps_Cost__c, Subcontractor_Cost__c, Total_Other_Summary__c
FROM Sundial_Solar__c LIMIT 1
```

A clean run (no `INVALID_FIELD`) proves the fields exist and are readable. They will all
be blank until the calc-side follow-up ships and a recalc runs.
