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
  `Material × (1 + Markup/100) + Hours × 33 × 1.75`.

`Markup` is a Percent field, which a formula reads as a whole number (25 = 25%), hence
the `/100` — the same conversion budgetCalc does.

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
| Customer | `Total_Adder_Price__c` | 2,387 | 2,387 | 2,613 |
| Customer | `Commission_Total__c` | 233 | 2,936 | 2,064 |
| Customer | `Commission_Total_PPW__c` | 120 | 3,039 | 1,961 |
| Solar | `Commission_Redline_PPW__c` | 236 | 236 | 4,764 |
| Solar | `Total_Adder_Price__c` | 2,378 | 2,378 | 2,622 |
| Solar | `Commission_Total__c` | 215 | 3,001 | 1,999 |
| Solar | `Commission_Total_PPW__c` | 102 | 3,086 | 1,914 |

**Worst case 3,086 bytes — 62% of the limit.**

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

`node salesforce/v3-redline-commission-fields/verify.mjs` — **20 checks, all passing.**

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

**It does not validate Salesforce's compiled-size limit or its parser.** Only Check Only
can, which is why that is step 1 below.

---

## ⚠️ Zipping — Explorer only, never `Compress-Archive`

**Zip with Windows Explorer: select the files → right-click → *Send to* → *Compressed
(zipped) folder*.**

**Do NOT use PowerShell 5.1's `Compress-Archive`** — it writes **backslash** path
separators and Workbench cannot read the entries, failing with a misleading "no
components" error.

---

## Deploy

1. Zip the **contents** so `package.xml` is at the zip root:
   ```
   package.xml
   objects/Sundial_Customer__c.object
   objects/Sundial_Solar__c.object
   ```
2. Workbench → **Migration → Deploy** → **Single Package**.
3. **"Check Only" FIRST.** This is not the usual formality — it is the only thing that
   compiles the formulas and proves they fit. Expect `Components: 8/8`. A
   `FIELD_INTEGRITY_EXCEPTION` mentioning "formula is too big" means the compiled limit
   was hit despite the estimate above; see the two levers in the previous section.
4. Re-run without Check Only.
5. **FLS: Read for everyone who should see commission; the integration user needs Read**
   (Stage 2's calc reads `Commission_Total__c`). Formula fields are read-only by
   definition, so there is no Edit to grant.

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

## Then

**Stage 2 does not start until you confirm this is deployed.** It rewires budgetCalc's
commission section to read `Commission_Total__c`, retires the two PPW input fields, and
re-pins the fixture to the redline worked example.
