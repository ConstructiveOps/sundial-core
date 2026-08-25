# v2 Field Alignments — **MODIFY** package

Existing-field changes for the v2 budget rework: three default-value corrections and
several relabels. `Sundial_Solar__c` + `Sundial_Customer__c`, Metadata API v62.0.

> ## ⚠️ This package MODIFIES existing fields
>
> A `<CustomField>` in a deploy **REPLACES the whole field definition**. Every attribute
> omitted from the XML reverts to its default — omit `<description>` and the description
> is **gone**; omit `<defaultValue>` and the default is **gone**. This is not like the
> additive packages.
>
> **So the XML was not hand-written.** `generate.mjs` **reads each field's current
> definition out of the live org** and re-emits it verbatim with exactly **one**
> attribute changed. The files are a snapshot of production plus the intended delta.
>
> **Regenerate immediately before deploying:**
> ```
> node salesforce/v2-field-alignments/generate.mjs
> ```
> It prints the full change table and re-reads the org, so the carried-over attributes
> match production *at deploy time* rather than at authoring time. If someone edited one
> of these fields in Setup since 2026-08-20, regenerating is what stops this package
> reverting their change.

---

## What changes — 10 fields (everything else is already at target and skipped)

### Default values (10)

Both objects, because **`Battery_Install_Hours__c` and `NS_Adder_1_Markup_Percent__c`
are copied Customer → Solar by Create Project** (`customer-to-solar-map.ts`). Setting
only Solar would let a blank Customer value overwrite the new default on every new
project — the fix would appear to work and then quietly not.

| Object | Field | From | To | Why |
|---|---|---|---|---|
| Solar | `Battery_Install_Hours__c` | `0` | **`16`** | §3: 16 in the REVISED sheet (20 in BRADS). At 0 a fresh record gets **zero battery labor**. |
| Customer | `Battery_Install_Hours__c` | *(none)* | **`16`** | Same, and it feeds Solar via the create-map. |
| Solar | `NS_Adder_1..5_Markup_Percent__c` | `25` | **`0.25`** | The percent-domain fix — see below. `25` meant **2500%**. |
| Customer | `NS_Adder_1..5_Markup_Percent__c` | `25` | **`0.25`** | Same, **plus a widening** `Percent(6,3)` → `Percent(18,4)`. |
| Solar | `Labor_Burden_Rate__c` | `75` | **`0.75`** | Same defect, found 2026-08-24 (D-063a). `75` meant **7500%**, on 4,473 of 4,474 records. |
| Solar | `Commission_Burden_Rate__c` | `75` | **`0.75`** | Same. |

> The two burden fields were **never created by a package in this repo** — they predate it
> and were made in Setup. A MODIFY package is the only vehicle we have for them, which is
> precisely what this one is for. Customer's copies are not listed: they carry no default
> at all, and their narrower `Percent(5,2)` (max 999.99) makes 7500 structurally unstorable.
>
> ⚠️ **The burden case had no cancelling error.** The markup bug survived because a matching
> `/100` in the Salesforce formula undid it; nothing undid this one. `budgetCalc` divides by
> 100 once and correctly, so 7500 became a **75.0 multiplier** — every burden figure 100×
> too large. It never bit only because exactly one Solar record has ever completed a budget
> calc, and it holds the correct 75.

---

## ⚠️ The percent-domain trap — read this before setting a default on ANY Percent field

**This is why the markup defaults change, and it will recur on the next Percent field
anyone creates.**

Salesforce uses **three** domains for a Percent field, and they do not agree. These rows
were *measured on a live record* by `scripts/probe-percent-field-domain.mjs`, not inferred
from documentation:

| Layer | Domain | A true **25%** is |
|---|---|---|
| metadata `<defaultValue>` | **decimal** | `0.25` |
| REST API / SOQL, read *and* write | **display** | `25` |
| formula field referencing it | **decimal** | `0.25` |

So `<defaultValue>25</defaultValue>` never meant 25%. It is a formula expression evaluated
in the decimal domain, so it means 25.0 as a fraction — **2500%** — and every record
created since carried a stored API value of **2500**. Setup renders the default expression
back as `"25"`, so nothing looked wrong anywhere in the UI.

**The two symptoms that finally exposed it:**

- Re-entering `2500` on a **Customer** record errors, while the same value is fine on
  **Solar**. Not a mystery once you see the types: Customer's fields were `Percent(6,3)`
  (max `999.999`), Solar's `Percent(18,4)`. This package widens Customer to match, so the
  two objects stop disagreeing about what fits in the same logical field.
- A save of `25` appearing to read back as `.25`. That is the **formula** domain showing
  through, not the API: the probe confirms the REST layer echoes `25` unchanged, and it is
  a *formula* referencing the field that sees `0.25`.

**The formula half of the same trap.** Because a formula already receives the decimal,
`Markup/100` inside a formula divides *twice*. `Total_Adder_Price__c` had exactly that, and
it is fixed in `salesforce/v3-redline-commission-fields/` — the NS term is now
`Material × (1 + Markup)` with no `/100`.

`budgetCalc.js` **keeps** its `/100`, and that is correct rather than inconsistent: it
reads through SOQL, where the domain is display. Two layers, two domains, one answer —
both land on a `1.25` multiplier for a true 25%.

> ⚠️ **Until now two bugs cancelled.** Records held `2500`, the formula saw `25`, and
> `25/100` gave the right `1.25` by accident. Fixing either side alone breaks it: data-only
> leaves the formula at `1.0025`, formula-only leaves it at `26`. **Ship the data fix
> (`scripts/fix-ns-markup-percent-domain.mjs`) and the v3 formula package together** —
> data first, because that window is the harmless one.
>
> In this org the actual exposure was nil: all 7 affected records had zero NS material, so
> the markup multiplied nothing. It was a loaded gun, not a wound.

> **Defaults apply to NEW records only.** Salesforce does not backfill. Every existing
> Solar record keeps whatever it has now — including `Battery_Install_Hours__c = 0`,
> which will keep producing zero battery labor on those jobs until someone sets them.
> If that matters, it is a data fix, not a metadata one.

### Relabels (12)

| Object | Field | From | To |
|---|---|---|---|
| Solar | `Adder_Upgrade_225_Price__c` | `Adder 225 Upgrade - Price` | `Adder 225 Upgrade-Overhead - Price` |
| Solar | `Adder_Upgrade_225_Qty__c` | `Adder 225 Upgrade - Qty` | `Adder 225 Upgrade-Overhead - Qty` |
| Customer | `Adder_Upgrade_225_Price__c` | `Adder: 225 Upgrade — Price` | `Adder: 225 Upgrade-Overhead — Price` |
| Customer | `Adder_Upgrade_225_Qty__c` | `Adder: 225 Upgrade — Qty` | `Adder: 225 Upgrade-Overhead — Qty` |
| both | `Gateway_Unit_Cost__c` | `Gateway Unit Cost` | `Tesla Expansion Pack Unit Cost` |
| both | `Gateway_Qty__c` | `Gateway Qty` | `Tesla Expansion Pack Qty` |
| both | `Gateway_Cost__c` | `Gateway Cost` | `Tesla Expansion Pack Cost` |

Each object keeps its own label style (Solar `Adder X - Y`, Customer `Adder: X — Y`) —
the generator does a substring replace on the live label rather than rewriting it.

### ⚠️ Not in the brief — one optional entry, marked `[OPT]`

| Object | Field | From | To |
|---|---|---|---|
| both | `Internal_Rep_Commission_PPW__c` | `Internal Rep Commission PPW` | `Internal Rep Commission $/W` |

**Consistency only.** You relabelled `Sales_Rep_Commission_PPW__c` in the UI to
**"3rd Party Rep Commission $/W"** — the `$/W` form, not `PPW`. This field shipped with
`PPW` (that was the spec), so the two commission inputs now read differently sitting
next to each other on the same layout.

**To drop it:** delete the two entries with `optional: true` from `generate.mjs` and
re-run. It is flagged rather than silently included because you didn't ask for it.

### Already done — excluded, not skipped silently

`Sales_Rep_Commission_PPW__c` on **both** objects is already
`3rd Party Rep Commission $/W`. Verified against the live describe; the generator
asserts the expected label and would print a warning if it had found anything else.
It is left out of the package entirely — redeploying an unchanged definition is pure
risk for zero gain.

---

## What could NOT be read from the org

The Metadata API is unreachable with the integration user's JWT session
(`/services/Soap/m` → `INVALID_SESSION_ID`) and the Tooling API's `CustomField` object
is not exposed to it. Everything in these files therefore comes from:

- **REST describe** → type, precision, scale, length, `defaultValueFormula`,
  `inlineHelpText`, nillable, externalId, unique, caseSensitive
- **`FieldDefinition`** → label, description, `IsFieldHistoryTracked`

**One attribute is not readable anywhere: `trackTrending`.** It is written as `false`.
Every field here is a plain number/currency/percent we created (which defaults to
false), and `trackTrending` only affects historical-trending reports, which this org
does not use. Stated so it is a known assumption rather than a silent one — if any of
these has trending enabled, this deploy turns it off.

**Descriptions and inline help text ARE preserved.** Spot-check after deploy: e.g.
`Battery_Install_Hours__c` should still carry its "CAUTION: … NOT multiplied by battery
qty" description.

Also unchanged and worth knowing: the `Gateway_*` **descriptions still say "Gateway"**
(e.g. *"Unit cost of Tesla Gateway (or equivalent)"*). Only the label was in scope, so
only the label changed. Updating them is a one-line follow-up.

---

## Zipping — use the builder, not Explorer

```
node scripts/zip-package.mjs salesforce/v2-field-alignments
```

Writes `salesforce/v2-field-alignments.zip` with `package.xml` at the root, forward-slash
entry names, and **only the metadata** — `package.xml` plus `objects/`. It prints every
entry with its size and last-modified time, so a stale input is visible *before* the
upload.

This replaces the old manual Explorer step, which had two failure modes we hit:

- **`Compress-Archive` (PowerShell 5.1) writes BACKSLASH entry paths**
  (`objects\Sundial_Solar__c.object`). The ZIP spec requires forward slashes, so Workbench
  finds no `package.xml` at the root and fails with a confusing "no components" error that
  names nothing real. (7-Zip and `git archive` were always fine; only the built-in cmdlet
  is broken.)
- **The zip goes stale.** Regenerating the `.object` files does not rebuild the archive,
  and nothing about the filename says how old it is. We shipped a stale zip once already.

Explorer also swept `generate.mjs` and `README.md` into the archive — uploading generator
source to Harmon's org on every deploy. The builder excludes them.

---

## Deploy (Workbench)

1. **Regenerate first** — `node salesforce/v2-field-alignments/generate.mjs`. This reads
   the LIVE definitions, so it must run against the org you are about to deploy to. Read
   the printed change table; every line should be one attribute, and the `from` values
   should match what you expect production to hold. Anything already at target is listed
   under **skipped** and left out of the package.
2. **Build the zip** — `npm run build-zips` (all packages), or
   `node scripts/zip-package.mjs salesforce/v2-field-alignments` for just this one.
3. Workbench → **Migration → Deploy** → choose `salesforce/v2-field-alignments.zip` →
   tick **Single Package**.
4. **"Check Only" first**, "Rollback on Error" ticked. The component count is whatever
   the generator just printed as *modified* — everything already at target is skipped, so
   the number shrinks as fixes land. As of 2026-08-24 it is **`Components: 2/2`** (the two
   burden defaults; the markup fields are now deployed and skip).
5. Re-run without Check Only.
6. **Then deploy `salesforce/v3-redline-commission-fields.zip`** the same way — it carries
   the matching formula fix (`Material × (1 + Markup)`, no `/100`). The data fix has
   already run; see the two-bugs-cancelled note above for why these belong together.

**No FLS step.** These fields already exist with their permissions; a modify deploy of a
`CustomField` does not touch `FieldPermissions`.

## Verify

After deploy, in Setup → Object Manager, confirm on a couple of fields that **the
description survived** (that is the attribute a bad modify package would silently eat):

- `Sundial_Solar__c.Battery_Install_Hours__c` → default **16**, description still starts
  *"TOTAL battery install hours (S3). CAUTION: …"*
- `Sundial_Solar__c.Gateway_Unit_Cost__c` → label **Tesla Expansion Pack Unit Cost**,
  default still **878.64**, description still *"Unit cost of Tesla Gateway…"*
- `Sundial_Customer__c.NS_Adder_1_Markup_Percent__c` → default expression **`0.25`**, type
  now **Percent(18,4)** (widened from 6,3 to match Solar)

Then create a **new** Customer record and confirm the five NS markup fields display as
**25%** — *not* 2500%, and *not* 0.25%. If they show 2500% the default is still the old
expression; if they show 0.25% something has written `0.25` through the API instead of as
a default expression.

Confirm via SOQL too, because the display and the API are different domains and this is
exactly the bug:

```sql
SELECT Id, NS_Adder_1_Markup_Percent__c FROM Sundial_Customer__c ORDER BY CreatedDate DESC LIMIT 1
```

**Expect `25`.** That is a true 25% in the REST domain.

Existing records are unchanged by a default — they were fixed separately by
`scripts/fix-ns-markup-percent-domain.mjs`.

---

## Explicitly out of scope

**`Domestic_Content__c` text → checkbox is NOT in this package.** A type conversion is a
different risk class from a default or a label: it rewrites stored data, can fail
partway on rows whose text does not convert, and is not cleanly reversible. The calc
handles the text field with a permissive affirmative parse (`YES`/`Y`/`true`/`1`,
case-insensitive, defaulting to NO), so nothing is blocked. Logged as its own TASKS
item.
