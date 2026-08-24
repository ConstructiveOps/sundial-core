# Attribute-Sync Fields — Sundial_Solar__c

Three fields that record what the last Acumatica **attribute** sync did. They close the
Stage E observability gap that was shipped knowingly on 2026-08-24 (D-060).

**3 new custom fields. Additive only — no existing field is modified.** Metadata API v62.0.

| API name | Type | Purpose |
|---|---|---|
| `Attribute_Sync_Status__c` | Picklist, **restricted**: `Synced` / `Nothing to Sync` / `Unverified` / `Failed` | Where the attribute sync stands. **Blank = never run.** |
| `Attribute_Sync_Error__c` | LongTextArea(4000) | Why it failed or could not be verified; cleared on a clean run. |
| `Attribute_Synced_At__c` | DateTime | When the attributes were last known **good**. |

## Why these exist

Until now a silently-discarded attribute surfaced only in the budget push's shared
`Budget_Push_Error__c` note and in CloudWatch — the "log line nobody reads" problem the
§4f document argued against. That got worse the moment a **second** path started writing
attributes: the attribute-only sync for legacy projects has no budget push to borrow an
error field from at all.

### Written by TWO paths, from ONE mapping

Both the budget push worker's Stage E and
`POST /projects/{recordId}/budget/attributes-sync` write these, via
`buildAttributeSyncWriteback()` in `lib/acumatica-attributes.js`. That is deliberate: a
record reading `Synced` after one path and `Failed` after the other for the same outcome
would be worse than having no field.

### Three choices worth re-reading

**`Unverified` is not `Failed`.** Acumatica returns **200 and silently discards** an
`AttributeID` the project's template does not define (D-060). So an unverified run means
the write *may* have partly happened and was not confirmed — a different problem, needing a
different response, from a write that did not happen. Collapsing them would hide the one
the verification exists to surface.

**`Attribute_Synced_At__c` does not move on failure.** It means "last known good". Stamping
it on a failed run would make a stale record look fresh. It *is* stamped on
`Nothing to Sync`, because the sync ran and had nothing to say — which is a different fact
from never having run, and blank status is what carries that.

**Blank rather than a `None` value.** "Never attempted" is genuinely different from all
four outcomes, and an absent value says so without adding a fifth that would need
explaining.

## Collision check

Live describe 2026-08-24, 498 fields on `Sundial_Solar__c`: **none of the 3 names exists**,
and every field the attribute-only path reads is present and readable. Re-run before
deploying:

```powershell
node scripts/probe-attribute-sync-fields.mjs
```

---

## ⚠️ Zipping — Explorer only, never `Compress-Archive`

**Zip with Windows Explorer: select the files → right-click → *Send to* → *Compressed
(zipped) folder*.**

**Do NOT use PowerShell 5.1's `Compress-Archive`.** It writes **backslash** path separators
(`objects\Sundial_Solar__c.object`); the ZIP spec requires forward slashes and Workbench
cannot read those entries, failing with a confusing "no components" error. This has bitten
this repo before. (7-Zip and `git archive` are fine.)

---

## Deploy (Workbench)

1. Zip the **contents** of this folder so `package.xml` is at the zip root:
   ```
   package.xml
   objects/Sundial_Solar__c.object
   ```
2. Workbench → **Migration → Deploy** → choose the zip → tick **Single Package**.
3. **"Check Only" first.** Leave "Rollback on Error" ticked. Expect `Components: 3/3`.
4. Re-run without Check Only.
5. **Grant FLS.**

## Post-deploy — FLS

**Integration user: Read + Edit on all 3.** Without Edit the sync still writes attributes
to Acumatica and then fails to record what happened — which is precisely the blindness
these fields exist to remove. Less costly than the §4f case (nothing raises a duplicate
payment), but it makes the deploy pointless.

**Everyone else: Read-only.** These are written outputs; a user editing them is editing a
report of what the integration did.

```sql
SELECT Parent.Profile.Name, Parent.Name, Field, PermissionsRead, PermissionsEdit
FROM FieldPermissions
WHERE Field LIKE 'Sundial_Solar__c.Attribute_%'
ORDER BY Field, Parent.Name
```

## Verify

```sql
SELECT Attribute_Sync_Status__c, Attribute_Sync_Error__c, Attribute_Synced_At__c
FROM Sundial_Solar__c LIMIT 1
```

A clean run (no `INVALID_FIELD`) proves the fields exist and are readable. They stay blank
until the next budget push or attribute-only sync runs on a record.

## Layout

Sensible home is beside `Budget_Push_Status__c` — they answer adjacent questions about the
same project, and the pairing makes the distinction visible: one describes the **budget
lines**, the other the **attributes**. A project can legitimately have a perfectly pushed
budget and a failed attribute sync. That is a **harmon-crm** sheet edit, after this
deploys; nothing in this repo does it.
