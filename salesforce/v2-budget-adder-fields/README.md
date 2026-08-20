# v2 Budget Adder Fields — Sundial_Customer__c + Sundial_Solar__c

Workbench metadata package for the v2 budget rework field inventory.
Reference: [`docs/integrations/acumatica-budget-rework-v2.md`](../../docs/integrations/acumatica-budget-rework-v2.md) §4a / §4b / §4c.

**56 new custom fields. Additive only — no existing field is modified or deleted.**
Metadata API v62.0.

| Section | Count | What |
|---|---|---|
| §4a | 28 | 7 new adders × (Price + Qty) × (Customer + Solar) |
| §4b | 16 | NS adder blocks 4 and 5 × 4 fields × (Customer + Solar) |
| §4c | 12 | COST fields, **Sundial_Solar__c only**, all nullable with **no default** |

Per-object totals: **Customer 22**, **Solar 34**.

---

## ⚠️ Read this before deploying: null is load-bearing on the Cost fields

Every §4c `Adder_*_Cost__c` field is **nullable with no default value, deliberately**:

> **Null = the budget calc derives the sheet default for that adder. A populated value
> is a per-job override that wins.**

This is design decision D6/§3 in the rework doc, and it is why there is no
constant-maintenance of adder cost defaults in Salesforce — the sheet formula is the
default, and Salesforce only ever stores the exception.

Two things follow, and both will silently corrupt budgets if ignored:

1. **Never add a default value to a Cost field.** A default of 0 would mean "this adder
   costs nothing" on every job, which the calc cannot distinguish from a deliberate
   zero override.
2. **Never write 0 to mean "unset"** from the portal, a Flow, or a data load. Blank the
   field instead. `0` is a real, meaningful override.

The sentence above is repeated in each Cost field's `description` and `inlineHelpText`
so it is visible in Setup and on the record page, not only here.

---

## What the describe said

Type signatures in this package were **cloned from the live describe on 2026-08-20**,
not taken from the spec prose. Three findings changed what got built — please sanity
check them before deploying:

### 1. The two objects genuinely diverge on the NS blocks

The task brief specified `Percent(3,4)` and `Number(16,2)` for the NS fields. **Neither
object matches that**, and they do not match each other:

| Field | `Sundial_Customer__c` (NS 1-3) | `Sundial_Solar__c` (NS 1-3) |
|---|---|---|
| `NS_Adder_n_Description__c` | Text(255) | Text(255) |
| `NS_Adder_n_Markup_Percent__c` | **Percent(3,3)** | **Percent(14,4)** |
| `NS_Adder_n_Material_Cost__c` | Currency(16,2) | Currency(16,2) |
| `NS_Adder_n_Labor_Hours__c` | **Number(5,1)** | **Number(17,1)** |

Blocks 4 and 5 **clone whichever object they sit on**, per the "match the existing
types exactly" instruction. Within one object all five blocks now behave identically,
which is what the calc and the UI need. The cross-object divergence is pre-existing and
harmless in the direction it is used: Customer → Solar is the only copy that happens
(Create Project), and every Customer signature widens into its Solar counterpart.

### 2. Existing per-watt price fields are `Number` with **3** decimals, not 4

The brief offered `Number(10,4)` or `Currency(12,4)` for the four per-watt Cost fields.
The live per-watt **price** fields are:

| Field | Customer | Solar |
|---|---|---|
| `Adder_Flat_Roof_Price__c` | Number(6,3) | **Number(15,3)** |
| `Adder_Conduit_Attic_Price__c` | Number(6,3) | Number(15,3) |
| `Adder_Roof_Tile_Price__c` | Number(6,3) | Number(15,3) |
| `Adder_Bird_Blocking_Price__c` | Number(6,3) | Number(15,3) |

So: **`Number`, not Currency** — that part of the question is settled — but **scale 3,
not 4**. The four per-watt Cost fields are built as `Number(15,3)` (precision 18,
scale 3) to match the price side of the same adder exactly.

> **This is the one judgement call worth overriding if you disagree.** Three decimals
> resolves to 0.001/W; on a 10 kW job a rounding error of 0.0004/W is about **$4**.
> Since these fields only ever hold a *hand-entered override* (null means "derive"),
> and since a cost with finer precision than its own price is an odd asymmetry, 3 dp
> matching the price side is the better default. If you want 4 dp, change `<scale>3</scale>`
> to `4` on the four `*_Conduit_Attic_*`, `*_Flat_Roof_*`, `*_Roof_Tile_*`,
> `*_Bird_Blocking_*` Cost fields **before deploying** — widening scale after data
> exists is a harder conversation.

### 3. Existing defaults differ by object, and NS markup defaults to 0 today

| | Customer | Solar |
|---|---|---|
| `Adder_Sub_Panel_Price__c` | **no default** | default `500` |
| `Adder_Sub_Panel_Qty__c` | **no default** | default `0` |
| `NS_Adder_1_Markup_Percent__c` | **no default** | default **`0`** |
| `NS_Adder_1_Material_Cost__c` | no default | default `0` |

Two consequences:

- **New §4a Price/Qty fields carry defaults on BOTH objects**, per the brief. On
  Customer that is new behaviour — the existing Customer adder prices have no default.
  This is an improvement, not a divergence to fix: a defaulted price with a `0` default
  quantity contributes nothing until someone sets a quantity, and it saves the rep
  typing the price book from memory.
- **New NS blocks 4 and 5 default their markup to 25%, while blocks 1-3 default to 0
  (Solar) or nothing (Customer).** That is what the doc asks for (§3: "Markup default
  25% (editable)"), but it means the five blocks will not behave alike until 1-3 are
  aligned. **Logged in TASKS.md as a follow-up** — it is a change to existing fields, so
  it is deliberately not in this additive package.

### 4. Qty precision

Existing Qty fields are `Number(3,0)` on Customer and `Number(18,0)` on Solar. The brief
specified `Number(18,0)`, so new Qty fields are `Number(18,0)` on **both**. Strictly more
permissive than Customer's existing `Number(3,0)`; no adder quantity approaches either
cap, so this is invisible in practice.

### 5. Labels follow each object's existing style

Customer uses `Adder: <name> — Price` (colon, em dash); Solar uses
`Adder <name> - Price` (no colon, ASCII hyphen). The package matches each. The adder
names are the sheet wording as specified, with **one exception**: Salesforce caps field
labels at 40 characters, and `Adder: LightReach Battery Warranty — Price` is 42. That
one field is labelled **`LR Battery Warranty`** (matching its API name
`Adder_LR_Battery_Warranty_*`); the full sheet wording is in its description and inline
help.

---

## Collision check

Run against the live describe on **2026-08-20**, all 56 API names against both objects:

```
Sundial_Customer__c : 22 names checked → COLLISIONS: NONE
Sundial_Solar__c    : 34 names checked → COLLISIONS: NONE
```

Re-run before deploying if the org has changed hands since:

```js
// from repo root
node -e "import('./lib/salesforce.js').then(async (sf)=>{ /* see PROGRESS.md entry */ })"
```

or in Workbench → Info → Standard & Custom Objects → pick the object → scan the field
list for `Adder_Upgrade_225_UG`, `NS_Adder_4`, `_Cost__c`.

---

## Deploy (Workbench)

1. Zip the **contents** of this folder so `package.xml` sits at the zip root:
   ```
   package.xml
   objects/Sundial_Customer__c.object
   objects/Sundial_Solar__c.object
   ```
   (Zip those three items, **not** the `v2-budget-adder-fields` folder itself. This
   README and `generate.mjs` may be included or left out — the Metadata API ignores
   anything not named in `package.xml`.)

   > `generate.mjs` is the script the two `.object` files were emitted from. 56 fields ×
   > ~10 XML elements each is exactly where a transposed `<precision>` hides for weeks,
   > so the per-object conventions live in one place and the XML is generated from them.
   > Edit the script and re-run it (`node salesforce/v2-budget-adder-fields/generate.mjs`
   > from the repo root) rather than hand-patching the objects — e.g. if you decide on
   > 4 dp for the per-watt Cost fields.

2. Workbench → **Migration → Deploy** → choose the zip → tick **Single Package**.

3. **Run with "Check Only" ticked first.** Leave "Rollback on Error" ticked. A check-only
   run validates all 56 fields against the org without writing anything — this is where
   a label-length or precision problem shows up, and it costs nothing.

4. Read the check-only result. Expect `Components: 56/56`, zero failures. If anything
   fails, fix it here and re-check; do not deploy a partial package.

5. Re-run **without** Check Only to deploy.

6. **Grant FLS (below). Nothing works without it** — a field with no FLS is invisible to
   the API and to every user, and the integration user's write silently drops it.

---

## Post-deploy — FLS

New fields deploy with **no field-level security for anyone** (Salesforce does not
inherit FLS from neighbouring fields). Three audiences, three different answers:

### a. The Sundial integration user — Edit on ALL 34 Solar fields, and all 22 Customer fields

The budget calc and the Create Project copy both run as the integration user. Verified
2026-08-20 that it holds `updateable = true` on the existing adder Price/Qty and NS
fields on both objects, so **mirror that same grant onto the new fields**.

Without Edit FLS the write-back PATCH drops the field **silently** — no error, just a
value that never lands. That is the failure mode the budget-push package README warns
about, and it is the single most likely thing to go wrong here.

### b. Rep-facing profiles — Edit on the Customer Price/Qty + NS fields

Reps enter adders on the Customer record before a Solar project exists.

> **⚠️ The exact profile list could not be read from this session.** The integration
> user lacks *View Setup and Configuration*, so `SELECT ... FROM FieldPermissions`
> returns `INVALID_TYPE` for it. Run this in **Workbench → Query as yourself** to get
> the authoritative list of who currently has Edit on an existing adder field, then
> mirror exactly that set onto the new ones:
>
> ```sql
> SELECT Parent.Profile.Name, Parent.Name, Parent.IsOwnedByProfile,
>        Field, PermissionsRead, PermissionsEdit
> FROM FieldPermissions
> WHERE Field IN ('Sundial_Customer__c.Adder_Sub_Panel_Price__c',
>                 'Sundial_Customer__c.Adder_Sub_Panel_Qty__c',
>                 'Sundial_Customer__c.NS_Adder_1_Material_Cost__c')
> ORDER BY Field, Parent.Name
> ```
>
> Mirroring is the rule, not a suggestion: the new adders sit in the same page-layout
> section as the existing ones, so any profile that can edit `Adder_Sub_Panel_Price__c`
> and not `Adder_Site_Audit_Price__c` gets a half-greyed-out section and files a bug.

The fastest way to apply it: add all 56 to a permission set and assign it to the same
profiles/users the existing adder fields are granted through.

### c. The §4c Cost fields — back-office edit only, pending your call

The 12 Solar `_Cost__c` fields are **budget inputs, not sales inputs**. A rep changing a
cost override changes the job's margin without changing what the customer pays.

Recommended for now: **integration user Edit; back-office/PM profiles Edit; rep profiles
Read-only or hidden.** That is a recommendation, not a decision — flagged in TASKS.md as
yours to make. Whatever you choose, apply it consistently across all 12, because the
portal renders them as one section.

---

## Verify

After deploy + FLS:

```sql
-- Customer (22)
SELECT Adder_Upgrade_225_UG_Price__c, Adder_Gateway3_Qty__c, NS_Adder_4_Markup_Percent__c,
       NS_Adder_5_Labor_Hours__c
FROM Sundial_Customer__c LIMIT 1

-- Solar (34), including the Cost fields
SELECT Adder_Upgrade_225_UG_Price__c, NS_Adder_5_Material_Cost__c,
       Adder_Sub_Panel_Cost__c, Adder_Bird_Blocking_Cost__c
FROM Sundial_Solar__c LIMIT 1
```

A clean run (no `INVALID_FIELD`) proves the fields exist and the querying user can read
them. **Read FLS is not Edit FLS** — the write path is only proven by an actual calc or
Create Project run.

Spot-check one default and one null in the UI: a new Solar record should show
`Adder Site Audit - Price` pre-filled at **350** with Qty **0**, and every `- Cost` field
**blank**. A Cost field showing `0.00` instead of blank means a default crept in — stop
and fix it before anyone enters data.

---

## Not in this package

Deliberately, so this stays additive and deployable today:

- **§4d** commission inputs — reuse existing fields, semantics change only, 0 new fields.
- **§4e** per-adder commission formula fields (~21 per object) — gated on Q7.
- **§4f** PO tracking fields — gated on Q2/Q5b.
- **Relabelling `Adder_Upgrade_225` to "225 Upgrade-Overhead"** — a change to an existing
  field, and only meaningful once the Underground variant exists. Do it after this
  deploys.
- **Aligning NS blocks 1-3 markup default to 25%** — a change to existing fields.
- **§4g Create Project mapping additions** and the portal config-sheet additions — code,
  not metadata. Both are logged in TASKS.md; the fields are useless until the mapping
  copies them.
