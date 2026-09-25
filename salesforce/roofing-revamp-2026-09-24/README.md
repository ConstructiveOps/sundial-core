# roofing-revamp-2026-09-24

Workbench deploy package for the Roofing module revamp. Full context, field rationale, deploy
steps and the follow-on Claude Code prompts live in **`docs/roofing-revamp-plan.md`** — read that
first. This README is the one-screen version.

## What is in the zip (`../roofing-revamp-2026-09-24.zip`, 68 components)

| Object | Change | Count |
|---|---|---|
| `Sundial_Roofing__c` | NEW fields from the layout sheet + Sold With Solar + Acumatica push control + per-type cost/sq | 19 |
| `Sundial_Roofing__c` | `Stage__c` value set replaced ("Stage 1" → 11-stage pipeline) | 1 |
| `Sundial_Roofing__c` | Existing fields redeployed with the 2026-09-24 budget master defaults (4 labor rates, roll-off/misc, 38 material prices) | 45 |
| `Sundial_Customer__c` | `Roofing_Stage__c`, `Roofing_Request_Type__c` (D-075 pattern for Roofing) | 2 |
| PermissionSet | `Sundial_Roofing_Revamp` — assign to the integration user | 1 |

The 45 redeployed fields are the July-22 definitions (`harmon-crm/sundial-roofing-budget-deploy.zip`,
confirmed live) with only `defaultValue` / `description` changed, so nothing else about them moves.

`../roofing-revamp-2026-09-24-linked-lookup/` is a separate, optional package for
`Sundial_Customer__c.Linked_Roofing_Project__c` — deploy it only if Setup shows the field missing.

## Deploy

1. Workbench → Migration → Deploy → `roofing-revamp-2026-09-24.zip` → **Check Only** + Rollback On Error → expect 68/68.
2. Deploy for real.
3. Setup → Permission Sets → Sundial Roofing Revamp → Manage Assignments → Sundial Integration User.
4. Supabase SQL editor → `sql/2026-09-24_roofing_revamp.sql`.
5. `sundial-cache-sync` Test → `{ "object": "customer", "mode": "full" }` then `{ "object": "roofing", "mode": "full" }`.

The zip was built with Linux `zip` (package.xml at the root). If you rebuild it, do NOT use
PowerShell 5.1 `Compress-Archive` (it writes backslash paths Workbench rejects).
