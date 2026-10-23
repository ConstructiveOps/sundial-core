# v9-dealer-terms — the dealer's terms live on `Sundial_Dealer__c` (D-085)

**6 new fields, 4 modified formula fields, 1 permission set. NOT purely additive** — the
redline and the rep name are replaced on both objects. Metadata API v62.0.

From this package on, a deal **created on/after 2026-09-04** takes its commission redline from
its **dealer** (`Dealer__c`, which the server derives from the sales rep — D-064 A1). The
legacy sales-company picklists (`Sales_Company__c` / `Dealer_Name__c` on Customer,
`Sales_Company_Harmon_Solar_or_Third__c` on Solar) are read only for records created before
that date.

## Manifest

| Object | Field | Change | Type |
|---|---|---|---|
| `Sundial_Dealer__c` | `Redline_PPW__c` "Redline $/W" | **new** | Currency(14,4) |
| | `Redline_LightReach_PPW__c` "Redline $/W (LightReach)" | **new** | Currency(14,4) |
| | `Acumatica_Vendor_ID__c` "Acumatica Vendor ID" | **new** | Text(20) |
| | `Acumatica_Vendor_Name__c` "Acumatica Vendor Name" | **new** | Text(80), informational |
| `Sundial_Customer__c` | `Commission_Redline_PPW__c` | **modified** (replaces v8) | formula Currency(14,4) |
| | `Sales_Rep_Name__c` | **modified** (coalesce) | formula Text |
| | `Dealer_Display_Name__c` "Dealer (based on Sales Rep)" | **new** | formula Text: `Dealer__r.Name` |
| `Sundial_Solar__c` | the same three | same | same |
| — | `Sundial_Dealer_Terms` permission set | **new** | FLS for the integration user |

**Collision check (live describe, 2026-10-22): none.** The four dealer fields,
`Dealer_Display_Name__c` and `Commission_Redline_Legacy_PPW__c` are absent on every object.

## The redline

```
Customer  CreatedDate < 2026-09-04   legacy: Harmon Solar 2.10 / 2.20, else 1.75 / 1.85  (LR / other)
          otherwise                  Dealer__r.Redline_LightReach_PPW__c when Lightreach,
                                     else Dealer__r.Redline_PPW__c;  no dealer => NULL

Solar     Customer linked AND the Customer created on/after 2026-09-04
                                     => Sundial_Customer__r.Commission_Redline_PPW__c
          otherwise                  legacy, as above, on Solar's own picklists
```

**No dealer, or a dealer whose rate is blank, means NULL — never a fallback to the picklist**
and never a default. Same rule D19 applies to a blank sales company: a wrong redline is worse
than none.

### What changes for an existing record, and what does not

- **Every pre-cutover record computes exactly what it does today.** `verify.mjs` evaluates
  the LIVE org formulas (captured from the describe) and the new ones over the same input
  grid — 120 Customer and 125 Solar cases, identical. That includes the 55 Customers whose
  `Sales_Company__c` is `"Constructive Solar"`, a value not in the (unrestricted) picklist:
  they stay "external", as today.
- **The live Customer formula is not v8.** It has one more branch,
  `IF(AND(TEXT(Sales_Company__c)="Invictus Energy", …>= 2026-09-04),1.75,1.85)`, that can
  **never be true**: `Sales_Company__c` holds only `Harmon Solar` / `Third-Party Dealer`
  (describe, active and inactive values; no record carries `Invictus Energy`). It was meant
  to give Invictus 1.75; that rate now lives on the Invictus dealer row, where it can work.
- **Post-cutover Solar now follows its Customer completely** — the Customer's dealer *and*
  the Customer's `Financing_Partner__c`, not Solar's `Sales_Type_Partner__c`. The probe found
  **0** of the 39 such records where the two disagree on LightReach.
- **Spellings verified by describe:** Customer `Financing_Partner__c` = `Lightreach`, Solar
  `Sales_Type_Partner__c` = `LightReach`. Both correct as written.

### The cutover probe — run 2026-10-22

`node scripts/probe-dealer-terms-cutover.mjs` (read-only):

| | Count |
|---|---|
| Customers created on/after 2026-09-04 | 7,675 |
| **Customer redline number → BLANK** (sales company set, no `Dealer__c`) | **91** |
| Customer redline blank → number (dealer set, no sales company) | 2 |
| Linked Solar whose Customer is post-cutover | 39 |
| **Solar redline number → BLANK** (Customer has no dealer, Solar sales company set) | **18** |
| (Solar's own `Dealer__c` null with a sales company — informational) | 19 |
| Solar / Customer disagree on LightReach | 0 |

Of the 91 Customers, **none has a `Sales_Rep__c`** — they are rep-less deals (68 marked
`Harmon Solar`, 23 a third-party dealer, many created 2026-10-13 / 10-22 in bulk), so this is
not a missed re-stamp: there is no rep to derive a dealer from. Their redline and
`Commission_Total__c` go blank on deploy and stay blank until a rep is assigned (or
`Dealer__c` is set on a rep-less deal, D-064 invariant 6). The probe lists every Id.

## Sales Rep Name

The lookup's name when `Sales_Rep__c` is set — **the join is copied from the live formula,
spacing and `+` included**, so a rep-attributed record reads exactly as today — otherwise the
legacy text, in order:

- Customer: `Sunbase_Sales_Rep__c` → `Dealer_Name__c`
- Solar: `Sales_Representative__c` → `Third_Party_Sales_Representative__c` →
  `Sales_Company_Harmon_Solar_or_Third__c`

⚠️ The integration user cannot read field metadata (Tooling `CustomField` is `INVALID_TYPE`),
so the live field's **description** could not be read and this deploy writes a new one. The
help text is blank on both (describe), and stays blank.

⚠️ **The cache does not see a formula change.** `sales_rep_name` is a cached column (the Sales
and Solar pages' rep filter). A formula change moves no `SystemModstamp`, so after deploy
run a **full resync** of `customer` and `solar` (`sundial-cache-sync` with
`{ "mode": "full", "object": "customer" }`, then `solar`). Expect the rep filter to gain
name-only groups (no `sales_rep_sf_id`) for rep-less records.

## Compiled size

`generate.mjs` inlines the redline into v3's `Commission_Total__c` / `Commission_Total_PPW__c`
(unchanged here, but Salesforce recompiles them) and the Customer redline into the Solar one:

| Object | Field | Inlined estimate | Headroom |
|---|---|---|---|
| Customer | `Commission_Redline_PPW__c` | 365 | 4,635 |
| Customer | `Commission_Total_PPW__c` | 3,525 | 1,475 |
| Solar | `Commission_Redline_PPW__c` | 706 | 4,294 |
| Solar | `Commission_Total__c` | 4,064 | 936 (tight) |
| Solar | `Commission_Total_PPW__c` | **4,149** | 851 (tight) |

**Under the limit, so there is no `Commission_Redline_Legacy_PPW__c`.** Note that a split
would not have helped the *compiled* figure anyway: Salesforce inlines a referenced formula
field, so moving the legacy branch into its own field moves the bytes, it does not remove
them. A split only helps the 3,900-character *source* limit, which nothing is near. If Check
Only reports "formula is too big" on a Solar `Commission_Total*` field, the lever is
shortening the Solar redline's legacy branch (e.g. dropping it for Solar records that have a
Customer, all of which are pre-cutover) — measure first.

## Permission set — `Sundial_Dealer_Terms`

Read on every new field. **The four dealer fields are Read + Edit**, not Read only:
`scripts/backfill-dealer-terms.mjs` writes them as the integration user, and Read alone would
fail every write. `Dealer_Display_Name__c` is a formula (read-only by definition). The two
modified fields keep the FLS they already have.

## Deploy — the steps Tim runs

```
node salesforce/v9-dealer-terms/generate.mjs
node salesforce/v9-dealer-terms/verify.mjs          # 81 checks
node scripts/build-zips.mjs v9-dealer-terms
node scripts/probe-dealer-terms-cutover.mjs         # re-run: the counts move as deals arrive
```

1. Workbench → Migration → Deploy → `salesforce/v9-dealer-terms.zip` → Single Package →
   **Check Only first**. Expect 11 components. This is the only real compile of the
   formulas and of the v3 fields that inline them.
2. Deploy for real.
3. Assign **Sundial Dealer Terms** to the integration user (or merge its entries).
4. **Straight away:** `node scripts/backfill-dealer-terms.mjs`, read the report, then
   `--apply`. Until it runs every post-cutover deal's redline is blank (the dealers' rates
   are blank). It sets Harmon Solar 2.20 / 2.10, Invictus Energy 1.75 / 1.65, everyone else
   1.85 / 1.65, and the vendor IDs from `docs/integrations/dealer-vendor-map.csv` — only
   where blank.
5. Full cache resync of `customer` and `solar` (above), then
   `node scripts/check-cache-formula-coverage.mjs`.
6. Spot-check: a pre-9/4 external Lightreach Customer (1.75), a post-9/4 Customer with a
   High Desert rep (1.85, or 1.65 if Lightreach), a post-9/4 Invictus deal (1.75), and that
   deal's Solar record showing the same number.

## What this package does NOT change (follow-ups, in TASKS.md)

Three Lambdas still read the Solar picklist for records of any date:
`sundial-budget` (internal vs external budget line), `sundial-acumatica-commission-po`
(vendor via `lookupDealerVendor`) and `lib/acumatica-attributes.js` (`SALESPERSO`). For a
post-cutover deal they should read `Dealer__r.Is_Internal__c` and
`Dealer__r.Acumatica_Vendor_ID__c`. Until then a post-cutover deal's budget and PO still
follow the picklist while its redline follows the dealer.
