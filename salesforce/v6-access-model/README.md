# v6 Access Model — `Sundial_Dealer__c` and the `Dealer__c` lookups

**1 new custom object + 5 new lookup fields + 1 permission set. Additive only.**
Metadata API v62.0. Reference: **D-064** and [`docs/access-model.md`](../../docs/access-model.md)
§2.1, §2.2, §8 (Phase 1, item 2).

This is the data model the whole access design rests on. It replaces *"filter records by
matching a rep's name against a picklist string"* with *"filter records by an id equality on an
indexed column"*.

---

## Manifest

### New object — `Sundial_Dealer__c`

A selling organization **within** a tenant. Harmon Solar is itself a dealer, the internal one.

| API name | Type | Notes |
|---|---|---|
| `Name` | Text (nameField, label "Dealer Name") | The display name. The **only** string anything matches on, and only once, in the backfill. |
| `Client__c` | Lookup → `Sundial_Tenant__c`, **required**, delete Restrict | Tenant isolation key (D-034/D-035), same as every Sundial object. |
| `Is_Internal__c` | Checkbox, default false | True for Harmon Solar. **Informational — grants nothing.** |
| `Active__c` | Checkbox, **default false** | Inactive means this dealer's users resolve to scope `none` and see nothing. |

### New lookups — `Dealer__c` → `Sundial_Dealer__c`

All optional, all `deleteConstraint = Restrict`.

| Object | Load-bearing? |
|---|---|
| `Sundial_User__c` | **Yes** — the only source of a sales user's dealer scope |
| `Sundial_Customer__c` | **Yes** — the deal's dealer, derived from the rep (A1) |
| `Sundial_Solar__c` | **Yes** — same |
| `Sundial_Roofing__c` | Not yet — the module is denied to sales roles (§3.1) |
| `Sundial_Commercial__c` | Not yet — see the probe note below |

### Permission set — `Sundial_Access_Model`

Object access on `Sundial_Dealer__c` (**read + create + edit, no delete**) plus field access on
all seven non-required new fields. Assign it to the Sundial integration user, **or** merge its
entries into the integration permission set that user already holds.

---

## Three things in here that look like mistakes and are not

### 1. `Sales_Company_Value__c` is absent

The approved design specified it — "Text(255), unique per tenant, the exact picklist value this
dealer corresponds to". **Do not add it back.**

Phase 0 proved it cannot exist. The two dealer picklists carry **110** values (Customer
`Dealer_Name__c`) and **56** (Solar `Sales_Company_Harmon_Solar_or_Third__c`) with only **36**
exact matches, plus near-miss spellings — `ReFract Solar`/`Refract Solar`, `Sky's the Limit
Solar`/`Skys the Limit Solar` — that an exact join drops **silently** rather than failing on. A
single unique column would have to pick one spelling and quietly lose the other.

D-064 **A1** then removed the need for it entirely: a deal's dealer comes from
`Sales_Rep__r.Dealer__c`, so no read path ever resolves a dealer by name. What is left is one
backfill's worth of matching, on Solar, for records with no rep at all, and it lives in
[`docs/integrations/dealer-aliases.csv`](../../docs/integrations/dealer-aliases.csv).

### 2. `Client__c` is missing from the permission set

**Salesforce refuses field permissions on a universally-required field** — the deploy comes back
with *"field is required and cannot be given permissions"*. `Client__c` is `required` here,
matching `Sundial_User__c` / `Sundial_Customer__c` / `Sundial_Solar__c`.

A required field is always visible and editable to anyone with object access, so omitting it
costs nothing. Including it would fail the deploy with a message that does not obviously point
back at `<required>true</required>`. `generate.mjs` filters it out on purpose.

### 3. `deleteConstraint` is `Restrict` everywhere, not `SetNull`

`SetNull` would let deleting a dealer **silently unshare every deal it owned**. The records
would stay, look completely normal, and quietly become invisible to the people selling them —
surfacing weeks later as "where did my pipeline go". `Restrict` turns that into an error at the
moment of deletion. Same reasoning on `Client__c`: a tenant with dealers cannot be deleted out
from under them.

That is also why the permission set grants **create and edit but not delete**. Nothing in
Sundial deletes a dealer, so a future script that tries has a bug, and failing is the correct
response to it.

---

## What the pre-deploy probe found

`node scripts/probe-access-model-fields.mjs` (read-only) on **2026-08-27**:

- **No collisions.** `Sundial_Dealer__c` does not exist; `Dealer__c` is absent on all five objects.
- `Sundial_Tenant__c` exists and holds exactly one row — `a1W7y000007AszBEAS` / `harmon` — so the
  `Client__c` lookup target is real.
- `Client__c` is **required** on User, Customer and Solar, and **optional** on Roofing. The new
  one follows the majority.
- ⚠️ **`Sundial_Commercial__c` has no `Client__c` at all** and holds **zero** records — it is a
  14-field Phase 3 stub. Adding `Dealer__c` there changes nothing and costs nothing, which is what
  §2.2 anticipated. The **missing tenant key is a real gap** and is recorded in TASKS.md rather
  than fixed here: this package is about the access model, and putting an isolation key on an
  empty object is a separate decision that belongs with the Commercial build.

Re-run the probe immediately before deploying. It exits non-zero on any collision.

---

## Deploy — the steps Tim runs

```
node scripts/probe-access-model-fields.mjs          # collision re-check, exits 1 on any hit
node salesforce/v6-access-model/generate.mjs        # regenerate from the source of truth
node scripts/zip-package.mjs salesforce/v6-access-model
```

The generator re-reads every file it wrote **off disk** and parses it before reporting success
(`8 metadata file(s) re-read from disk and parsed OK`). That check exists because the first run
of this generator emitted every `<fields>` block without its closing `</fields>`: the diff looked
fine, the field-limit check passed, and `zip-package.mjs` built the archive happily — its
manifest check matches `<fields>…<fullName>` with a regex and never needs the close tag. The
first thing that would have noticed was Workbench, after a zip and an upload.

Then:

1. Workbench → **Migration → Deploy** → choose `salesforce/v6-access-model.zip` → **Single Package**.
2. **"Check Only" FIRST.** Expect `Components: 10/10` — 1 CustomObject, 8 CustomField, 1 PermissionSet.
3. Re-run **without** Check Only.
4. **Assign the `Sundial Access Model` permission set to the Sundial integration user** — or merge
   its entries into the permission set that user already has. Nothing in Phase 1 works without
   this: `backfill-dealers.mjs` creates `Sundial_Dealer__c` rows as the integration user, and
   `backfill-deal-ownership.mjs` writes `Dealer__c` as the same user.
5. Tell Claude it is live. Steps 3–9 of Phase 1 all block on this package.

### If Check Only fails

| Message | Cause |
|---|---|
| `INVALID_CROSS_REFERENCE_KEY` naming `Sundial_Tenant__c` | The lookup target moved or was renamed. Re-run the probe. |
| `duplicate value found` / `already exists` on `Dealer__c` | Somebody added the field by hand. Re-run the probe and reconcile before deploying. |
| *field is required and cannot be given permissions* | Something re-added `Client__c` to the permission set. See note 2 above. |
| `relationshipName` conflict | Two lookups landed on the same child-relationship name. They are unique per object in `generate.mjs`; check nothing was hand-edited. |

---

## Post-deploy verification — 60 seconds

Run the probe again. It should report the **opposite** of what it reported before, and that is
the whole check:

```
node scripts/probe-access-model-fields.mjs
```

- `Sundial_Dealer__c` → **PRESENT**, `Name` + 3 custom fields
- `Dealer__c` → **PRESENT** on all five objects, each `reference -> Sundial_Dealer__c`

It exits **1** once the object exists, because it is written as a *pre-deploy* gate. A non-zero
exit after a successful deploy is expected and is not a failure — read the lines, not the code.

Then, in Salesforce, create one dealer by hand and delete it again. This is the only thing that
proves the permission set landed on the integration user rather than merely deploying:

1. **Sundial Dealers → New.** `Client__c` should be **required** in the UI, and `Active__c`
   should default to **unticked**. A ticked default means the wrong metadata deployed — and every
   backfilled dealer would then come up live, which is the one mistake here that hands out access
   rather than withholding it.
2. Delete it. (Deleting a dealer with no children is allowed; `Restrict` only bites once
   something points at it.)

---

## Then

**`scripts/backfill-dealers.mjs` does not run until you confirm this is deployed** and the
permission set is assigned. It creates one `Sundial_Dealer__c` per distinct picklist value, sets
`Active__c` on exactly three, and stamps `Dealer__c` on the ten ZZ TEST users and on Dennis.
Report-only until you approve it.
