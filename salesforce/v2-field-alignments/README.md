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

## What changes — 20 fields, one attribute each

### Default values (8)

Both objects, because **`Battery_Install_Hours__c` and `NS_Adder_1_Markup_Percent__c`
are copied Customer → Solar by Create Project** (`customer-to-solar-map.ts`). Setting
only Solar would let a blank Customer value overwrite the new default on every new
project — the fix would appear to work and then quietly not.

| Object | Field | From | To | Why |
|---|---|---|---|---|
| Solar | `Battery_Install_Hours__c` | `0` | **`16`** | §3: 16 in the REVISED sheet (20 in BRADS). At 0 a fresh record gets **zero battery labor**. |
| Customer | `Battery_Install_Hours__c` | *(none)* | **`16`** | Same, and it feeds Solar via the create-map. |
| Solar | `NS_Adder_1/2/3_Markup_Percent__c` | `0` | **`25`** | §3: NS markup defaults to 25%. Blocks 4-5 shipped at 25, so 1-3 are the odd ones out. |
| Customer | `NS_Adder_1/2/3_Markup_Percent__c` | *(none)* | **`25`** | Same. |

Types are **preserved per object** — Solar's markup fields are `Percent(14,4)`,
Customer's are `Percent(3,3)`, and the generator carries each through untouched.

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

## ⚠️ Zipping — Explorer only, never `Compress-Archive`

**Zip with Windows Explorer: select the files → right-click → *Send to* → *Compressed
(zipped) folder*.**

**Do NOT use PowerShell 5.1's `Compress-Archive`.** It writes entry paths with
**backslash** separators (`objects\Sundial_Solar__c.object`). The ZIP spec requires
forward slashes, and Workbench/the Metadata API cannot read those entries — the deploy
fails with a confusing "no components"/empty-package error rather than anything naming
the real cause.

(7-Zip and `git archive` are fine. Only PS 5.1's built-in cmdlet is the problem.)

---

## Deploy (Workbench)

1. **Regenerate first** — `node salesforce/v2-field-alignments/generate.mjs`. Read the
   printed change table; every line should be one attribute, and the `from` values
   should match what you expect production to hold.
2. Zip the **contents** so `package.xml` is at the zip root:
   ```
   package.xml
   objects/Sundial_Solar__c.object
   objects/Sundial_Customer__c.object
   ```
3. Workbench → **Migration → Deploy** → tick **Single Package**.
4. **"Check Only" first**, "Rollback on Error" ticked. Expect `Components: 20/20`.
5. Re-run without Check Only.

**No FLS step.** These fields already exist with their permissions; a modify deploy of a
`CustomField` does not touch `FieldPermissions`.

## Verify

After deploy, in Setup → Object Manager, confirm on a couple of fields that **the
description survived** (that is the attribute a bad modify package would silently eat):

- `Sundial_Solar__c.Battery_Install_Hours__c` → default **16**, description still starts
  *"TOTAL battery install hours (S3). CAUTION: …"*
- `Sundial_Solar__c.Gateway_Unit_Cost__c` → label **Tesla Expansion Pack Unit Cost**,
  default still **878.64**, description still *"Unit cost of Tesla Gateway…"*
- `Sundial_Customer__c.NS_Adder_1_Markup_Percent__c` → default **25**, type still
  **Percent(3,3)** (not Solar's 14,4)

Then create a **new** Solar record and confirm `Battery Install Hours` pre-fills at
**16** and the three NS markup fields at **25**. Existing records are unchanged by
design.

---

## Explicitly out of scope

**`Domestic_Content__c` text → checkbox is NOT in this package.** A type conversion is a
different risk class from a default or a label: it rewrites stored data, can fail
partway on rows whose text does not convert, and is not cleanly reversible. The calc
handles the text field with a permissive affirmative parse (`YES`/`Y`/`true`/`1`,
case-insensitive, defaulting to NO), so nothing is blocked. Logged as its own TASKS
item.
