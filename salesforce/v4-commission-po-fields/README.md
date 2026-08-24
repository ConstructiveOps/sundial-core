# §4f Commission PO Fields — Sundial_Solar__c

The eight fields from [`docs/integrations/commission-po-field-gap.md`](../../docs/integrations/commission-po-field-gap.md),
**approved as proposed 2026-08-24**.

**8 new custom fields. Additive only — no existing field is modified.** Metadata API v62.0.

All eight are written by `lambdas/sundial-acumatica-commission-po`. None is a rep input,
none belongs on `Sundial_Customer__c`, and **none goes in the Create Project mapping**.

| API name | Type | Purpose |
|---|---|---|
| `Commission_PO_M1_Number__c` | **Text(20)** | Acumatica `OrderNbr` for the M1 PO. **The idempotency key.** |
| `Commission_PO_M2_Number__c` | **Text(20)** | Same, for M2. |
| `Commission_PO_M1_Amount__c` | Currency(16,2) | What M1 was raised for. |
| `Commission_PO_M2_Amount__c` | Currency(16,2) | Same, for M2. |
| `Commission_PO_M1_Created__c` | DateTime | When M1 was raised. Stamped on create only. |
| `Commission_PO_M2_Created__c` | DateTime | Same, for M2. |
| `Commission_PO_Status__c` | Picklist, **restricted**: `None` / `M1 Raised` / `Both Raised` / `Failed` / `Frozen` | Where the two POs stand. |
| `Commission_PO_Error__c` | LongTextArea(4000) | The refusal or failure message; cleared on success. |

### Three choices worth re-reading

**`Text(20)`, not Number, for the order numbers.** Acumatica order numbers are zero-padded
strings — `016102`, `016442`. A Number field silently drops the leading zero and the stored
value stops matching anything in Acumatica, which kills the idempotency key. Same trap as
the `01926`-shaped vendor ids.

**`Frozen` is a status, not an error.** A released PO cannot be changed and the difference
lands in M2 (§6). That is an expected resting state; filing it under `Failed` is how people
learn to ignore failures. The engine's precedence is `Failed` > `Frozen` > raised-count, in
`commissionPoStatus()`.

**No `Commission_PO_Vendor__c`.** The vendor is derivable from
`Sales_Company_Harmon_Solar_or_Third__c` through the D4 dealer map at any time, and a
stored copy would go stale the moment the map changed. A formula field is the right shape
if Harmon wants it on the layout.

## Collision check

Live describe 2026-08-24, 490 fields on `Sundial_Solar__c`: **none of the 8 names exists.**
Re-run before deploying:

```powershell
node scripts/probe-commission-po-fields.mjs
```

It also confirms the two Q13 date fields (`Audit_Date_and_DateTime__c`,
`Scheduled_Install_Date__c`) and re-checks that the pre-existing
`Bill_Out_in_Acumatica_Requested__c` / `_2__c` pair is the unrelated **AR** request marker
it was taken to be — these eight track the **AP** purchase orders.

---

## ⚠️ Zipping — Explorer only, never `Compress-Archive`

**Zip with Windows Explorer: select the files → right-click → *Send to* → *Compressed
(zipped) folder*.**

**Do NOT use PowerShell 5.1's `Compress-Archive`.** It writes entry paths with
**backslash** separators (`objects\Sundial_Solar__c.object`). The ZIP spec requires forward
slashes, and Workbench cannot read those entries — the deploy fails with a confusing "no
components" error rather than anything naming the real cause. This has bitten this repo
before.

(7-Zip and `git archive` are fine too. Only PS 5.1's built-in cmdlet is the problem.)

---

## Deploy (Workbench)

1. Zip the **contents** of this folder so `package.xml` is at the zip root:
   ```
   package.xml
   objects/Sundial_Solar__c.object
   ```
   Zip those two items, not the folder.
2. Workbench → **Migration → Deploy** → choose the zip → tick **Single Package**.
3. **"Check Only" first.** Leave "Rollback on Error" ticked. Expect `Components: 8/8`.
4. Re-run without Check Only.
5. **Grant FLS — see below. Nothing works without it.**

## Post-deploy — FLS

**Integration user: Read + Edit on all 8.** This is not the usual "otherwise the value
doesn't land" note. Without **Edit** on `Commission_PO_M1_Number__c`, the engine still
creates a real purchase order in Acumatica and then silently fails to store its number —
and the next budget push, seeing an empty field, raises a **second purchase order**. That
is the only failure mode in this engine that costs money.

**Everyone else: Read-only.** A user editing `Commission_PO_M1_Number__c` by hand is
editing the idempotency key.

The exact profile list needs a `FieldPermissions` query run as yourself (the integration
user lacks *View Setup and Configuration*):

```sql
SELECT Parent.Profile.Name, Parent.Name, Parent.IsOwnedByProfile,
       Field, PermissionsRead, PermissionsEdit
FROM FieldPermissions
WHERE Field LIKE 'Sundial_Solar__c.Commission_PO_%'
ORDER BY Field, Parent.Name
```

## Verify

```sql
SELECT Commission_PO_M1_Number__c, Commission_PO_M2_Number__c,
       Commission_PO_M1_Amount__c, Commission_PO_M2_Amount__c,
       Commission_PO_M1_Created__c, Commission_PO_M2_Created__c,
       Commission_PO_Status__c, Commission_PO_Error__c
FROM Sundial_Solar__c LIMIT 1
```

A clean run (no `INVALID_FIELD`) proves the fields exist and are readable.

## These fields stay blank until the gate opens

Deploying them does not populate them. `PO_GATE.enabled` is still `false` — the hand-proof
([`acumatica-commission-po-runbook.md`](../../docs/integrations/acumatica-commission-po-runbook.md))
has two steps outstanding. That ordering is deliberate: the metadata and the FLS should be
settled and boring before anything is allowed to raise a payment document.

## Layout (not this package)

The eight render read-only at the bottom of the Budget tab — a **harmon-crm** sheet edit,
after this deploys. Nothing in this repo does it.
