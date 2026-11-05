# solar-field-cleanup-2026-11 — delete 24 Sundial_Solar__c fields (D-090)

**DESTRUCTIVE.** `destructiveChanges.xml` deletes 24 custom fields on `Sundial_Solar__c`.
`package.xml` is empty on purpose (a destructive deploy needs one). The list is
`fields.json` — the single source the sheet edit, this package and the drop SQL were
built from.

## Why

`Sundial_Solar__c` is at Salesforce's 500 custom-field cap (Enterprise Edition), so no
new field can be created. `docs/audits/solar-fields-2026-11.md` audited all 500. These 24
are its buckets A + B **minus** the seven Tim kept (`Attribute_Sync_Error__c` — the
Acumatica attribute sync writes it — the six NS Adder 4/5 Description / Labor Hours /
Material Cost fields, and `Sales_Rep_Email__c`, which Salesforce would not let go cleanly).

15 of the 24 hold no data at all. The other 9 (the Permit 3/4 set and
`Web_Inspection_Key_Code_3__c`) hold 38 values between them; every one is saved in
`docs/audits/solar-fields-2026-11-backup.csv` (record Id, Name, field, value).

## Before you run this — the order matters

Nothing may still **select** a field when it is deleted. In order:

1. Backend Lambdas deployed from `master` (the regenerated field manifest — `sundial-sf-query`,
   `sundial-sf-update`, `sundial-dealer`, `sundial-auth-proxy`, `sundial-reports`).
2. The portal (harmon-crm `feature/solar-field-cleanup`, merged to `main`) deployed on Vercel,
   so no page asks for these fields.
3. **Setup → each field → "Where is this used?"** — the audit could not see Flows,
   formulas, validation rules, layouts, reports or email templates (the integration user
   has no Tooling API). A Flow or formula that uses a field makes the Check Only fail (good —
   fix it and re-run); a **report or list view does not**, it just loses the column, so
   look at those yourself.
4. `Sundial_Sales_Rep_ID__c` is a lookup to `Sundial_User__c`: if its related list is on a
   Sundial User page layout, Check Only will tell you; remove it from the layout.

## Deploy

1. Use the prebuilt `solar-field-cleanup-2026-11.zip` (`package.xml` and
   `destructiveChanges.xml` at the zip root, nothing else).
2. Workbench → Migration → Deploy → choose the zip → tick **Check Only** and
   **Single Package**; leave **Purge On Delete UNticked** (that keeps the fields
   restorable). Deploy. It must say **Success** with 24 components.
3. Same zip, same settings, **Check Only unticked** → Deploy for real.

Or with the Salesforce CLI, from this folder:

```powershell
# 1. Check Only — validates, changes nothing
sf project deploy validate --metadata-dir . --target-org <your-org-alias> --wait 30

# 2. The real delete
sf project deploy start --metadata-dir . --target-org <your-org-alias> --wait 30
```

## After the delete

- Salesforce keeps a deleted custom field **restorable for 15 days** (Setup → Object
  Manager → Sundial Solar → Fields & Relationships → **Deleted Fields** → Undelete). After
  15 days it is erased for good. **A deleted field still counts against the 500 until it is
  erased** — to create new fields at once, **Erase** the deleted ones from that same list
  (that is the point of no return; the backup CSV is the only copy of the 38 values after it).
- Then `sql/2026-11-04_drop_solar_columns.sql`, the catalog regeneration and a full solar
  cache sync — the steps are in TASKS.md (D-090).

If you ever rebuild the zip, in PowerShell: `C:\Windows\System32\tar.exe -a -c -f solar-field-cleanup-2026-11.zip package.xml destructiveChanges.xml`
from this folder (Windows' own `tar` writes a real zip with forward-slash entries; Git Bash's `tar` writes a TAR file with a .zip name). NEVER PowerShell 5.1
Compress-Archive.
