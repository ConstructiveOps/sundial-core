# v2 Budget Adder + Commission Fields — Sundial_Customer__c + Sundial_Solar__c

> ## ⚠️ Corrected 2026-08-24 — the NS markup default was wrong
>
> This package created `NS_Adder_4/5_Markup_Percent__c` with
> `<defaultValue>25</defaultValue>`. A Percent field's `defaultValue` is a formula
> expression evaluated in the **decimal** domain, so `25` meant **2500%**, and every
> record created since carried a stored API value of `2500`. Setup renders the expression
> back as `"25"`, so it read as correct everywhere.
>
> The generator now emits **`0.25`**, and Customer's `nsMarkup` type was widened from
> `Percent(6,3)` to `Percent(18,4)` to match Solar — the narrow type is why writing `2500`
> errored on Customer and succeeded on Solar.
>
> **This package does NOT need redeploying to fix the live org.**
> `salesforce/v2-field-alignments/` carries the correction for all five blocks on both
> objects as a MODIFY package, which is a far smaller deploy than re-running this one.
> The change here is so a **fresh org** never inherits the bug.
>
> Full explanation, including the three disagreeing domains and the empirical probe that
> measured them: `salesforce/v2-field-alignments/README.md` → *The percent-domain trap*.


Workbench metadata package for the v2 budget rework field inventory.
Reference: [`docs/integrations/acumatica-budget-rework-v2.md`](../../docs/integrations/acumatica-budget-rework-v2.md) §4a / §4b / §4c / §4d.

**58 new custom fields. Additive only — no existing field is modified or deleted.**
Metadata API v62.0.

| Section | Count | What |
|---|---|---|
| §4a | 28 | 7 new adders × (Price + Qty) × (Customer + Solar) |
| §4b | 16 | NS adder blocks 4 and 5 × 4 fields × (Customer + Solar) |
| §4c | 12 | COST fields, **Sundial_Solar__c only**, each with a **static default** (D15) |
| §4d | 2 | `Internal_Rep_Commission_PPW__c` × (Customer + Solar) |

Per-object totals: **Customer 23**, **Solar 35**.

> **Amended 2026-08-20** for D15 / D16 / D17 and the §4d addendum. The Cost fields
> previously shipped with **no** default under a "null means derive" design; **D15
> replaced that with static defaults** and the semantics are now inverted — see below.
> If you deployed an earlier build of this package, you didn't: it has never been
> deployed.

---

## ⚠️ Read this before deploying: the Cost fields now carry static defaults

Every §4c `Adder_*_Cost__c` field ships with a **static default value**, and:

> **The calc ALWAYS reads the Cost field. It never derives one.**
> A blank Cost field is therefore a **bug**, not a signal.

That is the reverse of the earlier design, where null meant "derive the sheet default".
D15 traded that for something more visible and admin-editable: the number is in
Salesforce where anyone can see and change it, rather than buried in calc code.

Two semantics, and mixing them up silently produces a budget that is wrong by three
orders of magnitude:

| | Meaning | Calc uses |
|---|---|---|
| **Flat adders** (8 of them) | cost **per UNIT** | value **× Qty** |
| **Per-watt adders** (4: Conduit Attic, Flat Roof, Roof Tile, Bird Blocking) | cost **per WATT** | value **× system watts**, when selected |

**Price and cost are independent stored values.** Changing an adder's *price* does
**not** move its *cost* — the defaults below are a snapshot of the sheet derivation, not
a live link to it. If a job needs both changed, change both. Likewise, if Harmon
re-prices an adder org-wide, the matching Cost default has to be re-derived by hand.

Both sentences are in every Cost field's `description` **and** its `inlineHelpText`, so
they are visible in Setup and on the record page, not only here.

### The 12 defaults and where they come from

Flat: `(price − hours × 33 × 1.75) ÷ 1.25` — where `1.75` is labor plus 75% burden and
`÷ 1.25` strips the 25% markup. Per-watt: the same shape in per-watt terms.

| Field | Type | Default | Basis |
|---|---|---|---|
| `Adder_Sub_Panel_Cost__c` | Currency(16,2) | **261.40** | (500 − 3h × 33 × 1.75) ÷ 1.25 |
| `Adder_Derate_Cost__c` | Currency(16,2) | **341.40** | (600 − 3h × 33 × 1.75) ÷ 1.25 |
| `Adder_Heat_Detector_Cost__c` | Currency(16,2) | **175.20** | (450 − 4h × 33 × 1.75) ÷ 1.25 |
| `Adder_Upgrade_225_Cost__c` | Currency(16,2) | **1540.80** | (2850 − 16h × 33 × 1.75) ÷ 1.25 |
| `Adder_Upgrade_400_Cost__c` | Currency(16,2) | **3220.80** | (4950 − 16h × 33 × 1.75) ÷ 1.25 |
| `Adder_Upgrade_225_UG_Cost__c` | Currency(16,2) | **1260.80** | (2500 − 16h × 33 × 1.75) ÷ 1.25 |
| `Adder_Gateway3_Cost__c` | Currency(16,2) | **2175.20** | (2950 − 4h × 33 × 1.75) ÷ 1.25 |
| `Adder_Structural_Cost__c` | Currency(16,2) | **250.00** | direct — engineer stamp, posts to SUBCON Engineering |
| `Adder_Conduit_Attic_Cost__c` | Number(15,3) **/W** | **0.052** | (0.1 − 0.02 × 1.75) ÷ 1.25 |
| `Adder_Flat_Roof_Cost__c` | Number(15,3) **/W** | **0.052** | (0.1 − 0.02 × 1.75) ÷ 1.25 |
| `Adder_Roof_Tile_Cost__c` | Number(15,3) **/W** | **0.009** | (0.02 − 0.005 × 1.75) ÷ 1.25 |
| `Adder_Bird_Blocking_Cost__c` | Number(15,3) **/W** | **0.06** | direct — posts to SUBCON Subcontractor |

Every one of these was re-derived from the formula and matches the doc's §4c table
exactly. All four per-watt values land inside 3 decimal places, which is what confirms
the `Number(15,3)` choice below.

---

## What the describe said

Type signatures were **cloned from the live describe on 2026-08-20**, not taken from the
spec prose. Four findings changed what got built — please sanity check them before
deploying:

### 1. The two objects genuinely diverge, on the NS blocks and on the PPW field

The brief specified `Percent(3,4)` and `Number(16,2)` for the NS fields. **Neither
object matches that**, and they do not match each other:

| Field | `Sundial_Customer__c` | `Sundial_Solar__c` |
|---|---|---|
| `NS_Adder_n_Description__c` | Text(255) | Text(255) |
| `NS_Adder_n_Markup_Percent__c` | **Percent(3,3)** | **Percent(14,4)** |
| `NS_Adder_n_Material_Cost__c` | Currency(16,2) | Currency(16,2) |
| `NS_Adder_n_Labor_Hours__c` | **Number(5,1)** | **Number(17,1)** |
| `Sales_Rep_Commission_PPW__c` | **Number(4,3)** | **Number(15,3)** |

Every new field **clones whichever object it sits on**, per the "match the existing
types exactly" instruction. Within one object everything behaves alike, which is what
the calc and the UI need. The cross-object divergence is pre-existing and harmless in
the direction it is used: Customer → Solar is the only copy that happens (Create
Project), and every Customer signature widens into its Solar counterpart.

### 2. `Sales_Rep_Commission_PPW__c` is a `Number`, not a Currency

Despite its label — **"Sales Rep Commission $/W"** — it is a `double`. So
`Internal_Rep_Commission_PPW__c` is `Number` too: `Number(4,3)` on Customer,
`Number(15,3)` on Solar, default `0` on both. Consistent with the per-watt price fields,
which are also Number.

> **Minor label inconsistency, flagged not fixed.** Its siblings are labelled
> `… Commission $/W`; the brief specified `Internal Rep Commission PPW`, so that is what
> shipped. Side by side a user will see "Sales Rep Commission $/W" and "Internal Rep
> Commission PPW". Say the word and it becomes `Internal Rep Commission $/W`. (Note
> `Sales_Rep_Commission_PPW__c` is separately due a relabel to "3rd Party Rep Commission
> PPW" per §4d — that is a change to an existing field, so it is not in this package.)

### 3. Existing per-watt price fields are `Number` with **3** decimals, not 4

| Field | Customer | Solar |
|---|---|---|
| `Adder_Flat_Roof_Price__c` | Number(6,3) | **Number(15,3)** |
| `Adder_Conduit_Attic_Price__c` | Number(6,3) | Number(15,3) |
| `Adder_Roof_Tile_Price__c` | Number(6,3) | Number(15,3) |
| `Adder_Bird_Blocking_Price__c` | Number(6,3) | Number(15,3) |

So: **`Number`, not Currency**, at **scale 3**. The four per-watt Cost fields match at
`Number(15,3)` so cost and price for the same adder carry identical precision.

**This is now confirmed rather than assumed** — the D15 defaults (0.052, 0.052, 0.009,
0.06) all land exactly inside 3 dp, so nothing is lost. The doc records the same
conclusion.

### 4. NS markup defaults, and Customer's missing price defaults

| | Customer | Solar |
|---|---|---|
| `Adder_Sub_Panel_Price__c` | **no default** | default `500` |
| `NS_Adder_1_Markup_Percent__c` | **no default** | default **`0`** |
| `Sales_Rep_Commission_PPW__c` | **no default** | default `0.100` |

- **New §4a Price/Qty fields carry defaults on BOTH objects**, per the brief. On
  Customer that is new behaviour. It is an improvement, not a divergence to fix: a
  defaulted price with a `0` default quantity contributes nothing until someone sets a
  quantity, and it saves the rep typing the price book from memory.
- **New NS blocks 4 and 5 default their markup to 25%, while blocks 1-3 default to 0
  (Solar) or nothing (Customer).** That is what the doc asks for, but the five blocks
  will not behave alike until 1-3 are aligned. **Logged in TASKS.md** — a change to
  existing fields, so deliberately not in this additive package.

### 5. Qty precision, and labels

Existing Qty fields are `Number(3,0)` on Customer and `Number(18,0)` on Solar; the brief
specified `Number(18,0)`, so new ones are `Number(18,0)` on both. Strictly more
permissive; no adder quantity approaches either cap.

Labels follow each object's own style — Customer `Adder: <name> — Price` (colon, em
dash), Solar `Adder <name> - Price` (no colon, ASCII hyphen). Adder names are the sheet
wording, with **one exception**: Salesforce caps labels at 40 characters and
`Adder: LightReach Battery Warranty — Price` is 42, so that field is labelled
**`LR Battery Warranty`** (matching its API name); the full wording is in its
description and inline help. All 58 labels are length-checked by the generator.

---

## Collision check

Run against the live describe on **2026-08-20**, all 58 API names against both objects:

```
Sundial_Customer__c : 23 names checked → COLLISIONS: NONE
Sundial_Solar__c    : 35 names checked → COLLISIONS: NONE
```

`Internal_Rep_Commission_PPW__c` was re-checked separately when it was added: absent
from both objects.

Re-check before deploying if the org has changed since: Workbench → Info → Standard &
Custom Objects → pick the object → scan for `Adder_Upgrade_225_UG`, `NS_Adder_4`,
`_Cost__c`, `Internal_Rep_Commission_PPW__c`.

---

## ⚠️ Zipping — Explorer only, never `Compress-Archive`

**Zip with Windows Explorer: select the files → right-click → *Send to* → *Compressed
(zipped) folder*.**

**Do NOT use PowerShell 5.1's `Compress-Archive`.** It writes entry paths with
**backslash** separators (`objects\Sundial_Solar__c.object`). The ZIP spec requires
forward slashes, and Workbench/the Metadata API cannot read those entries — the deploy
fails with a confusing "no components"/empty-package error rather than anything naming
the real cause.

(7-Zip and `git archive` are fine too. Only PS 5.1's built-in cmdlet is the problem.)

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

   > `generate.mjs` is the script the two `.object` files were emitted from. 58 fields ×
   > ~10 XML elements each is exactly where a transposed `<precision>` or a fat-fingered
   > default hides for weeks, so the per-object conventions and the whole defaults table
   > live in one place and the XML is generated from them. Edit the script and re-run it
   > (`node salesforce/v2-budget-adder-fields/generate.mjs` from the repo root) rather
   > than hand-patching the objects.

2. Workbench → **Migration → Deploy** → choose the zip → tick **Single Package**.

3. **Run with "Check Only" ticked first.** Leave "Rollback on Error" ticked. A
   check-only run validates all 58 fields against the org without writing anything —
   this is where a label-length, precision, or default-value problem shows up, and it
   costs nothing.

4. Read the check-only result. Expect `Components: 58/58`, zero failures. If anything
   fails, fix it here and re-check; do not deploy a partial package.

5. Re-run **without** Check Only to deploy.

6. **Grant FLS (below). Nothing works without it** — a field with no FLS is invisible to
   the API and to every user, and the integration user's write silently drops it.

---

## Post-deploy — FLS (unchanged by this amendment)

New fields deploy with **no field-level security for anyone** (Salesforce does not
inherit FLS from neighbouring fields). Three audiences, three different answers:

### a. The Sundial integration user — Edit on ALL 35 Solar and all 23 Customer fields

The budget calc and the Create Project copy both run as the integration user. Verified
2026-08-20 that it holds `updateable = true` on the existing adder Price/Qty, NS, and
commission-PPW fields on both objects, so **mirror that same grant onto the new fields**.

Without Edit FLS the write-back PATCH drops the field **silently** — no error, just a
value that never lands. That is the single most likely thing to go wrong here.

### b. Rep-facing profiles — Edit on the Customer Price/Qty + NS + PPW fields

Reps enter adders and commission PPW on the Customer record before a Solar project
exists. `Internal_Rep_Commission_PPW__c` belongs with this set — it is a rep-entered
value at point of sale, and D16 makes it the field that decides whether a deal generates
commission POs at all.

> **⚠️ The exact profile list could not be read from this session.** The integration
> user lacks *View Setup and Configuration*, so `SELECT ... FROM FieldPermissions`
> returns `INVALID_TYPE` for it. Run this in **Workbench → Query as yourself** to get
> the authoritative list of who currently has Edit on the existing equivalents, then
> mirror exactly that set onto the new ones:
>
> ```sql
> SELECT Parent.Profile.Name, Parent.Name, Parent.IsOwnedByProfile,
>        Field, PermissionsRead, PermissionsEdit
> FROM FieldPermissions
> WHERE Field IN ('Sundial_Customer__c.Adder_Sub_Panel_Price__c',
>                 'Sundial_Customer__c.Adder_Sub_Panel_Qty__c',
>                 'Sundial_Customer__c.NS_Adder_1_Material_Cost__c',
>                 'Sundial_Customer__c.Sales_Rep_Commission_PPW__c')
> ORDER BY Field, Parent.Name
> ```
>
> Mirroring is the rule, not a suggestion: the new adders sit in the same page-layout
> section as the existing ones, so any profile that can edit `Adder_Sub_Panel_Price__c`
> and not `Adder_Site_Audit_Price__c` gets a half-greyed-out section and files a bug.

The fastest way to apply it: add the fields to a permission set and assign it to the
same profiles/users the existing equivalents are granted through.

### c. The §4c Cost fields — back-office edit only, pending your call

The 12 Solar `_Cost__c` fields are **budget inputs, not sales inputs**. A rep changing a
cost override changes the job's margin without changing what the customer pays — and now
that they carry visible defaults, they are more inviting to fiddle with, not less.

Recommended: **integration user Edit; back-office/PM profiles Edit; rep profiles
Read-only or hidden.** A recommendation, not a decision — flagged in TASKS.md as yours.
Whatever you choose, apply it consistently across all 12; the portal renders them as one
section.

---

## Verify

After deploy + FLS:

```sql
-- Customer (23)
SELECT Adder_Upgrade_225_UG_Price__c, Adder_Gateway3_Qty__c, NS_Adder_4_Markup_Percent__c,
       NS_Adder_5_Labor_Hours__c, Internal_Rep_Commission_PPW__c
FROM Sundial_Customer__c LIMIT 1

-- Solar (35), including the Cost fields
SELECT Adder_Upgrade_225_UG_Price__c, NS_Adder_5_Material_Cost__c,
       Internal_Rep_Commission_PPW__c,
       Adder_Sub_Panel_Cost__c, Adder_Bird_Blocking_Cost__c
FROM Sundial_Solar__c LIMIT 1
```

A clean run (no `INVALID_FIELD`) proves the fields exist and the querying user can read
them. **Read FLS is not Edit FLS** — the write path is only proven by an actual calc or
Create Project run.

### ⚠️ The Cost-field spot check is INVERTED from the previous build

Create a new Solar record and look at the Cost section. **Every Cost field must be
PRE-POPULATED with its default:**

| Field | Must show |
|---|---|
| `Adder Sub Panel - Cost` | `261.40` |
| `Adder Structural - Cost` | `250.00` |
| `Adder Bird Blocking - Cost` | `0.060` |
| `Adder Roof Tile - Cost` | `0.009` |

**A BLANK Cost field means the default did not take** — stop and fix it before anyone
enters data. Under D15 the calc always reads these fields and never derives, so a blank
one produces a zero-cost adder and a silently inflated margin.

(Under the previous build the check was the exact opposite — blank was correct and a
populated value meant a default had crept in. If you have a stale checklist, this line
is the one that changed.)

Also spot-check the §4a side: a new Solar record should show
`Adder Site Audit - Price` = **350** with Qty **0**, and
`Internal Rep Commission PPW` = **0**.

---

## Not in this package

Deliberately, so this stays additive and deployable today. All of these are changes to
**existing** fields, or code:

- **Relabel `Sales_Rep_Commission_PPW__c` → "3rd Party Rep Commission PPW"** (§4d). Its
  meaning changes the moment `Internal_Rep_Commission_PPW__c` exists, so this should
  follow closely behind the deploy.
- **Relabel `Adder_Upgrade_225` → "225 Upgrade-Overhead"**, now that the Underground
  variant exists.
- **Relabel `Adder_Structural_*` → "Structural-Electrical Engineer Stamp"** and
  `Gateway_*` → Tesla Expansion Pack; **Battery hours default 20 → 16**. (§4 follow-ups.)
- **Align NS blocks 1-3 markup default to 25%.**
- **`Setter__c` on `Sundial_Solar__c` — DOES NOT EXIST, and D17 needs it.** See TASKS.md;
  it is a calc dependency, not a field in this package. Customer has
  `Setter__c` (Lookup → `Sundial_User__c`) plus a `Setter_Name__c` Text(120), Solar has
  neither, and `customer-to-solar-map.ts` explicitly excludes it with the comment
  *"Sundial_Solar__c has no corresponding field"*. D17's rule ("applies when `Setter__c`
  is populated") cannot run Solar-side until this is resolved.
- **§4e** per-adder commission formula fields — gated on Q7.
- **§4f** PO tracking fields — draft, gated on Q5b (Q2 resolved by D16: internal = no POs).
- **§4g Create Project mapping additions** and the portal config-sheet additions — code,
  not metadata. Both in TASKS.md; the Customer fields are inert until the mapping copies
  them.
