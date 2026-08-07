# Budget Push Fields — Sundial_Solar__c

Adds the three status fields the Acumatica budget-push write path
(`lambdas/sundial-acumatica-budget-push`) writes back after a push.

| Field | Type | Written by | Meaning |
|---|---|---|---|
| `Budget_Push_Status__c` | Restricted picklist: `Pushing` / `Pushed` / `Failed` | HTTP handler sets `Pushing`; worker sets `Pushed`/`Failed` | Current push state (UI polls this) |
| `Budget_Pushed_At__c` | DateTime | Worker, on success | When the last successful push completed |
| `Budget_Push_Error__c` | Long Text Area (32768) | Worker, on failure (cleared on success) | Abort reason / failed-line summary |

Additive only — no existing field is modified. The existing
`Budget_Calc_Status__c`, `Budget_Finalized__c`, and `Acumatica_Project_ID__c`
are already present (verified on the live describe) and are **not** in this package.

## Deploy (Workbench)

1. Zip the **contents** of this folder so `package.xml` sits at the zip root:
   ```
   package.xml
   objects/Sundial_Solar__c.object
   ```
   (Zip the two items, not the `budget-push-fields` folder itself.)
2. Workbench → **Migration → Deploy** → choose the zip → check **Single Package** →
   Next → Deploy. Leave "Rollback on Error" checked; "Check Only" for a dry run first.

## Post-deploy — FLS (your step)

The Sundial **integration user** writes these fields via the API, so its profile
needs field-level security. On the integration user's profile (or a permission set
assigned to it), grant **Read + Edit** on all three fields:

- Budget Push Status
- Budget Pushed At
- Budget Push Error

Without Edit FLS the worker's write-back PATCH silently drops the fields and the
status never leaves `Pushing`.

## Verify

After deploy + FLS, confirm the fields resolve (any of):

- **Workbench** → Info → Standard & Custom Objects → `Sundial_Solar__c` → the three
  fields are listed.
- **SOQL** (Workbench Query or the reconcile Lambda's SF creds):
  ```sql
  SELECT Budget_Push_Status__c, Budget_Pushed_At__c, Budget_Push_Error__c
  FROM Sundial_Solar__c LIMIT 1
  ```
  A clean run (no `INVALID_FIELD`) means the fields exist and the integration user
  can read them. The end-to-end push test (Stage 4+) proves Edit FLS.
