# D19 Redline Commission Fields — formula fields, both objects

**8 new FORMULA fields (4 × 2 objects). Additive only.** Metadata API v62.0.
Reference: [`acumatica-budget-rework-v2.md`](../../docs/integrations/acumatica-budget-rework-v2.md) **D19**.

```
Total Commission ($) = Contract Amount − (Redline × system watts) − Total Adder Price
```

| Deal type | Finance | Redline $/W |
|---|---|---|
| External | Lightreach | **1.75** |
| External | other | **1.85** |
| Internal | Lightreach | **2.10** |
| Internal | other | **2.20** |

This **supersedes the PPW-input commission model**. `Sales_Rep_Commission_PPW__c` and
`Internal_Rep_Commission_PPW__c` stop being calc inputs in Stage 2 (the fields stay on
the objects for history).

**All four are formulas** — nothing writes them, they cannot drift from their inputs, and
they are safe to put on a page layout so a rep sees the commission before the calc ever
runs.

---

## Manifest

| API name | Label | Type | Formula |
|---|---|---|---|
| `Commission_Redline_PPW__c` | Commission Redline $/W | Currency(14,4) | the redline table above |
| `Total_Adder_Price__c` | Total Adder Price | Currency(16,2) | every priced adder |
| `Commission_Total__c` | Commission Total | Currency(16,2) | Contract − Redline×W − Adders |
| `Commission_Total_PPW__c` | Commission Total $/W | Currency(14,4) | Commission Total ÷ watts |

**Collision check (live describe, 2026-08-21): NONE on either object.**

> ⚠️ **`Commission_PPW__c` already exists on BOTH objects and is a different thing** — a
> budget-calc *output* covering **all** commissions (rep + management + setter + burden)
> ÷ watts. The new `Commission_Total_PPW__c` is the **rep commission only**, and it is a
> formula. They will sit near each other on a layout, so label them apart if that turns
> out to confuse anyone.

### Object-appropriate sources (verified against the live describe)

| | `Sundial_Customer__c` | `Sundial_Solar__c` |
|---|---|---|
| Deal type | `Sales_Company__c` — 2 values: `Harmon Solar` / `Third-Party Dealer` | `Sales_Company_Harmon_Solar_or_Third__c` — `Harmon Solar` or one of ~55 dealer names |
| Finance | `Financing_Partner__c` = **`Lightreach`** | `Sales_Type_Partner__c` = **`LightReach`** |
| Watts | `Final_System_Size_kW__c` × 1000 | `System_Size__c` × 1000 |

Two things worth knowing about that table:

1. **The Lightreach casing differs between the objects** — `Lightreach` on Customer,
   `LightReach` on Solar. Harmless, because Salesforce formula `=` on text is
   case-insensitive (that is why `EXACT()` exists), but each formula uses its own
   object's exact spelling so nobody has to know that to read it.
2. **`Sales_Type_Partner__c` on Customer is an unconfigured placeholder** holding only
   `"Value 1"`. The Customer formulas use `Financing_Partner__c` instead. Do not "fix"
   this by pointing Customer at `Sales_Type_Partner__c`.

Since INTERNAL is an equality test against `"Harmon Solar"` and EXTERNAL is everything
else, **a new dealer added to the Solar picklist is automatically external** — no
formula change needed.

---

## What `Total_Adder_Price__c` includes

Every **priced** adder, at price (never cost):

- **16 flat adders** at `Price × Qty` — Sub Panel, Derate, Heat Detector, 225 Upgrade,
  400 Upgrade, 225 Upgrade-UG, Gateway3, Site Audit, Travel, Structural, both Small
  Systems, Software Fee, Active Monitoring, LR Battery Warranty, **Referral Fee**.
- **4 per-watt adders** at `Price × Watts × Qty` — Conduit in Attic, Flat Roof, Roof
  Tile, Bird Blocking.
- **NS blocks 1-5** at their **marked-up** total:
  `Material × (1 + Markup) + Hours × 33 × 1.75`. **No `/100`** — see below.
- **Storage** at `Unit Price × Qty` — batteries and Tesla expansion packs. Added
  2026-08-24; see below.

### ⚠️ The markup has NO `/100`, and that is the fix

A Salesforce **formula** receives a Percent field **already in the decimal domain**: a
field storing a true 25% (API value `25`) reads as **`0.25`** inside a formula. So the
original `(1 + Markup/100)` divided twice and produced a ~0% markup.

This is not a guess. `scripts/probe-percent-field-domain.mjs` wrote values through REST on
a live record and read `Total_Adder_Price__c` back:

| Written via REST | Formula saw | `Total_Adder_Price__c` on 1000 material |
|---|---|---|
| `25` | `0.25` | **1002.50** ← the old `/100` formula |
| `0.25` | `0.0025` | 1000.03 |
| `1` | `0.01` | 1000.10 |
| `100` | `1.00` | 1010.00 |

`verify.mjs` pins those numbers directly, so the regression cannot come back quietly.

**`budgetCalc.js` keeps its `/100`.** It reads through SOQL, where the domain is *display*
(`25` means 25%). The two layers are not inconsistent — they read different domains, and
both land on a `1.25` multiplier for a true 25%.

> ⚠️ **This ships WITH the data fix, not before or after it.** Two bugs used to cancel:
> records carried `2500` (from `<defaultValue>25</defaultValue>`, which Salesforce
> evaluates in the decimal domain), the formula saw `25`, and `25/100` gave the right
> `1.25` by accident.
>
> | | data `2500` | data `25` (fixed) |
> |---|---|---|
> | **formula `/100`** (old) | `1.25` ✔ by accident | `1.0025` ✗ markup vanishes |
> | **formula no `/100`** (new) | `26` ✗ catastrophic | `1.25` ✔ correct |
>
> Run `scripts/fix-ns-markup-percent-domain.mjs` first (done, 7 records), then deploy this.
> Data-first is the harmless window.

> ⚠️ **Percent values in `verify.mjs` are in the FORMULA domain** — `0.25` means 25%.
> `lambdas/sundial-budget/test.js` writes `25` for the same 25%, because it feeds the calc
> through the REST domain. The two files disagreeing on the literal is correct.

### Storage: batteries and Tesla expansion packs

Batteries and expansion packs are sold **outside** the redline × watts model. Nothing in
`Redline × watts` accounts for them, so unless their price is deducted here the rep is
paid commission on the full battery revenue as though it were margin. Before this was
added, **every battery deal was overpaid by the full battery + expansion price.**

| Object | Battery term | Expansion-pack term |
|---|---|---|
| `Sundial_Customer__c` | `Battery_Unit_Price__c × Battery_Qty__c` | `Tesla_Expansion_Pack_Unit_Price__c × Tesla_Expansion_Pack_Qty__c` |
| `Sundial_Solar__c` | `Battery_Unit_Price__c × Battery_Qty__c` | `Tesla_Expansion_Pack_Unit_Price__c × **Gateway_Qty__c**` |

Both price fields are Currency(16,2) with static defaults of **9,950** and **7,900**,
created via the Setup UI on both objects.

#### ⚠️ The mismatched `Tesla_*` × `Gateway_*` pair on Solar — leave it alone

On `Sundial_Solar__c` the formula multiplies `Tesla_Expansion_Pack_Unit_Price__c` by
`Gateway_Qty__c`. The names do not match, and that is **deliberate**, not an oversight:

- **`Gateway_*` IS the Tesla expansion pack on Solar.** The `Gateway_*` group was reused
  for it (§3). Its label is literally *"Tesla Expansion Pack Qty"*, `Gateway_Cost__c` is
  labelled *"Tesla Expansion Pack Cost"*, `budgetCalc.js` reads `Gateway_Qty__c` as the
  expansion-pack quantity, and the Create Project map writes it.
- **Solar's `Tesla_Expansion_Pack_Quantity__c` is an orphan.** Nothing maintains it.
  Note it is also spelled `_Quantity__c`, not `_Qty__c` — a different field from
  Customer's `Tesla_Expansion_Pack_Qty__c`, which *is* maintained.

So the tempting tidy-up — "the price says Tesla, the qty should say Tesla too" — would
repoint the formula at a field that is always blank, and **every expansion pack would
silently price at zero**. `verify.mjs` asserts both halves of this (the `Gateway_Qty__c`
path works, the `Tesla_Expansion_Pack_Quantity__c` path is ignored), and `test.js` in the
budget Lambda does the same, so the tidy-up fails loudly instead of quietly.

Customer keeps its own `Tesla_Expansion_Pack_Qty__c`. Customer *also* carries a
`Gateway_Qty__c` with the same label, but its intake maintains the `Tesla_*` one.

#### Where the snapshot workbook and the sheet intentionally differ

The REVISED workbook has battery/gateway **cost** parameters (B11/C11, B13/C13) but **no
adder price row** for storage — the storage price is a commission-model concept that the
spreadsheet never had. So in `budgetCalc.js` the two terms are added straight into the
**K39** adder-price rollup without a matching `B`/`C`/`D` row of their own.

That is the one place the snapshot and the sheet layout diverge. K39 in a Sundial snapshot
can therefore exceed the sum of the adder rows above it, by exactly
`battery + expansion price`. `extras.storagePriceTotal` (plus `batteryPriceTotal` /
`expansionPriceTotal`) breaks the figure out so it never has to be reverse-engineered.

The **cost** side is untouched: `Battery_Unit_Cost__c × Qty` and
`Gateway_Unit_Cost__c × Qty` already flow to material (F16 / F14) and battery labor and
burden already flow through F32/F33. Adding cost here would double-count.

#### Existing records needed a backfill

A Salesforce field default only applies to records created **after** the field existed, so
every pre-existing battery/expansion record had a **null** price — and a null price
contributes 0, which means the formula change alone fixes nothing for history.
`scripts/backfill-storage-adder-prices.mjs` covers that (null-only, never overwriting a
human-entered price). It ran against production on **2026-08-24**, touching 29 records.

### Why 33 is hardcoded

`33` is the Powerwall labor rate and `1.75` is labor + 75% burden. Both are hardcoded
**exactly like the redlines themselves**, and for the same reason: they are constants of
the *commission model*, not per-job parameters.

Reading `Battery_Labor_Rate__c` here instead would mean a per-job override — a legitimate
thing to do to a *budget* — silently changing what a rep is paid. The commission model
has to be the same for everyone or it is not a model. If Harmon re-rates either number,
this formula and the redline table change together, in one deliberate edit.

---

## Blank-input behaviour

Every input is wrapped in `BLANKVALUE(...,0)`, and all four fields are set
`formulaTreatBlanksAs = BlankAsBlank` so blanks propagate rather than silently becoming
zero.

| Input state | Redline | Total Adder Price | Commission Total | Commission $/W |
|---|---|---|---|---|
| normal | rate | sum | number | number |
| **blank sales company** | **blank** | sum | **blank** | **blank** |
| **zero / blank watts** | rate | sum (per-watt terms 0) | **blank** | **blank** |
| blank finance source | treated as "other" (1.85 / 2.20) | — | number | number |
| no adders at all | rate | **0** | number | number |

**A blank sales company yields no redline, not the external one.** That is the important
line in the table: defaulting an unset company to "external" would quietly pay the wrong
commission on every record where somebody forgot to set it, and a blank field is a
question someone answers whereas a wrong number is one nobody asks.

A blank *finance source* does fall through to the "other" rate. That is deliberate and
different — "not Lightreach" is the common case and a genuine default, whereas "not any
sales company" is missing data.

> **This design leans on `BlankAsBlank` propagation** (a blank `Commission_Total` divided
> by watts stays blank). That is documented Salesforce behaviour, but **confirm it on a
> real record** — the post-deploy check below takes 30 seconds and removes the assumption.

---

## Compiled size — measured, not assumed

Salesforce compiles a referenced formula **inline**, so `Commission_Total` carries copies
of `Commission_Redline_PPW` *and* `Total_Adder_Price`, and `Commission_Total_PPW` carries
a copy of all three. `Total_Adder_Price` alone is ~40 field references. Limits are
**3,900 characters** of source and **5,000 bytes** compiled.

`generate.mjs` prints both figures on every run:

| Object | Field | Source | Inlined | Headroom |
|---|---|---|---|---|
| Customer | `Commission_Redline_PPW__c` | 190 | 190 | 4,810 |
| Customer | `Total_Adder_Price__c` | 2,543 | 2,543 | 2,457 |
| Customer | `Commission_Total__c` | 233 | 3,092 | 1,908 |
| Customer | `Commission_Total_PPW__c` | 120 | 3,195 | 1,805 |
| Solar | `Commission_Redline_PPW__c` | 236 | 236 | 4,764 |
| Solar | `Total_Adder_Price__c` | 2,521 | 2,521 | 2,479 |
| Solar | `Commission_Total__c` | 215 | 3,144 | 1,856 |
| Solar | `Commission_Total_PPW__c` | 102 | 3,229 | 1,771 |

**Worst case 3,229 bytes — 65% of the limit.** (Was 3,086 / 62% before the two storage
terms; they cost ~143 bytes at the worst point because the inlining carries them three
times over.)

### Metadata length is now guarded at build time too

`generate.mjs` calls `assertFieldLimits()` from `salesforce/field-limits.mjs` — the guard
added after the v5 package failed a Workbench deploy on a 1,137-character description.
v3 predated it, and the storage sentence promptly pushed `Total_Adder_Price__c`'s
description to 1,082 characters, over the 1,000 limit. The build failed locally instead of
after a zip-and-upload round trip, which is the entire point.

The descriptions now sit at **936** (Customer) and **970** (Solar) of 1,000 and the
generator prints them as `(tight)`. That is deliberate — there is not room for another
sentence, and the build will say so rather than the deploy.

### It did not fit on the first attempt

The obvious `Commission_Total_PPW` —

```
IF(OR(ISBLANK(Commission_Total__c), watts=0), NULL, Commission_Total__c/watts)
```

— names `Commission_Total__c` **twice**, so Salesforce inlines the whole ~2,900-byte
expansion twice and the field compiles to **~6,000 bytes: over the limit**. Two
restructures fixed it:

1. **Reference `Commission_Total__c` exactly once.** The `ISBLANK` branch is redundant
   under `BlankAsBlank` — a blank numerator divided by anything is blank — so dropping
   it costs nothing and halves the field.
2. **Factor the watts expression** out of the four per-watt adder terms rather than
   repeating it, and keep the explicit `ISBLANK(redline)` guard only on
   `Commission_Total`, where it is the field the calc actually reads.

If a future edit pushes something over, those are the two levers: fewer repeated
references, and inline the terms rather than chaining another formula field.

---

## Offline validation

`node salesforce/v3-redline-commission-fields/verify.mjs` — **35 checks, all passing.**

It reads the **actual `<formula>` text out of the generated `.object` files**, transpiles
the small subset of the formula language they use into JavaScript, and evaluates it. That
is deliberately not the same as re-implementing the maths and comparing: the thing under
test is the text that gets deployed, so a typo'd field name, a missing adder, a per-watt
adder in the flat group or a forgotten `/100` fails here rather than after a deploy.

It earned its keep immediately. The first run caught a **precedence bug**:
`Commission_Total__c/BLANKVALUE(System_Size__c,0)*1000` parses left-to-right as
`(Total / kW) × 1000` — out by a factor of a million. The watts expression is now
parenthesised everywhere.

Covered: the D19 worked example on both objects, all four redlines, the Lightreach casing
difference, blank company, zero watts, blank finance, no adders, per-watt × qty, and NS
markup + labour.

Plus the **percent domain** block (2026-08-24), pinned to the live numbers
`scripts/probe-percent-field-domain.mjs` returned: a true 25% giving `1.25`, a true 100%
giving `2.00`, the old `/100` result of `1002.50` being gone, and the legacy `2500` data
producing `26x` — which is what makes the data fix load-bearing rather than cosmetic.

Plus the storage block (added 2026-08-24): the 27,800 worked example on both objects
(2 batteries at 9,950 + 1 expansion pack at 7,900 — adder total **up** 27,800, commission
**down** 27,800), zero-qty-with-default-price changing nothing, a blank price contributing
0 rather than blanking the total, and — the important one — that Solar reads
`Gateway_Qty__c` and **ignores** `Tesla_Expansion_Pack_Quantity__c`.

**It does not validate Salesforce's compiled-size limit or its parser.** Only Check Only
can, which is why that is step 1 below.

---

## Zipping — use the builder

```
node scripts/zip-package.mjs salesforce/v3-redline-commission-fields
```

Writes `salesforce/v3-redline-commission-fields.zip` with `package.xml` at the root,
forward-slash entry names, and only `package.xml` + `objects/`. It prints every entry with
its last-modified time so a **stale zip** is visible before the upload — we shipped one
already, and nothing about a zip's filename says how old it is.

It also replaces the old "Explorer only, never `Compress-Archive`" rule: PowerShell 5.1's
cmdlet writes **backslash** entry paths, which the ZIP spec forbids and Workbench cannot
read. The builder always writes forward slashes.

---

## Deploy

0. **Run the data fix first if it has not run** —
   `node scripts/fix-ns-markup-percent-domain.mjs --apply`. Already done (7 records,
   2026-08-24). See the two-bugs-cancelled table above for why the order matters.
1. **Regenerate and rebuild the zip:**
   ```
   node salesforce/v3-redline-commission-fields/generate.mjs
   node salesforce/v3-redline-commission-fields/verify.mjs
   node scripts/zip-package.mjs salesforce/v3-redline-commission-fields
   ```
2. Workbench → **Migration → Deploy** → choose
   `salesforce/v3-redline-commission-fields.zip` → **Single Package**.
3. **"Check Only" FIRST.** This is not the usual formality — it is the only thing that
   compiles the formulas and proves they fit. Expect `Components: 8/8`. A
   `FIELD_INTEGRITY_EXCEPTION` mentioning "formula is too big" means the compiled limit
   was hit despite the estimate above; see the two levers in the previous section.
4. Re-run without Check Only.
5. **FLS: Read for everyone who should see commission; the integration user needs Read**
   (Stage 2's calc reads `Commission_Total__c`). Formula fields are read-only by
   definition, so there is no Edit to grant.
6. **Then deploy `salesforce/v2-field-alignments.zip`** — the matching metadata fix that
   changes the five NS markup defaults from `25` to `0.25` and widens Customer's fields to
   `Percent(18,4)`. Order between these two does not matter (one is defaults for NEW
   records, the other is the formula); order against the DATA fix does.

## Post-deploy verification — 30 seconds, and worth it

On a real Solar record:

1. Set Sales Company to a dealer, finance to something other than LightReach, and confirm
   **Commission Redline $/W = 1.85**. Switch Sales Company to **Harmon Solar** → **2.20**.
   Switch finance to **LightReach** → **2.10**.
2. Check `Total Adder Price` against the adders on the record.
3. Check `Commission Total` = Contract − Redline×W − Total Adder Price.
4. **Blank the Sales Company.** Redline, Commission Total and Commission $/W must all go
   **blank** — not 0, not a number. This is the `BlankAsBlank` assumption; if any of them
   shows a value instead, stop and tell me before Stage 2.
5. **The markup check (2026-08-24).** On a scratch record set `NS Adder 1 Material Cost`
   = **1000**, `NS Adder 1 Labor Hours` = **0**, and `NS Adder 1 Markup %` = **25%**.
   `Total Adder Price` must rise by **1,250** — a 25% markup on 1,000.

   | What you see | What it means |
   |---|---|
   | **+1,250** | ✅ correct |
   | +1,002.50 | the `/100` is still in the formula — this package did not land |
   | +26,000 | the record holds `2500`, so the data fix did not run on it |

   Then clear the fields you set.

## Then

**Stage 2 does not start until you confirm this is deployed.** It rewires budgetCalc's
commission section to read `Commission_Total__c`, retires the two PPW input fields, and
re-pins the fixture to the redline worked example.
