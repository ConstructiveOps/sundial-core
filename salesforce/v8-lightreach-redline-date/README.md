# v8-lightreach-redline-date

Modifies (does NOT add) `Commission_Redline_PPW__c` on Sundial_Customer__c and
Sundial_Solar__c. Reference: rework doc D19, amended **D36 (2026-09-16)**.

## The change

Harmon revised the External + Lightreach redline for deals sold on/after Sept 4 2026:

| Leg                  | Before Sep 4 2026 | On/after Sep 4 2026 |
|----------------------|-------------------|---------------------|
| External + Lightreach| 1.75              | **1.65**            |
| External + other     | 1.85              | 1.85 (unchanged)    |
| Internal + Lightreach| 2.10              | 2.10 (unchanged)    |
| Internal + other     | 2.20              | 2.20 (unchanged)    |

The cutoff date is the **Customer record's CreatedDate** on BOTH objects — the Solar
formula reads it through `Sundial_Customer__r.CreatedDate`, because Solar records are
created later (at Create Project) and one deal must get one redline. A Solar record
with no Customer linked gets the pre-change 1.75 (conservative).

Object-specific spellings preserved from v3: Customer tests `Financing_Partner__c =
"Lightreach"`, Solar tests `Sales_Type_Partner__c = "LightReach"`.

## Effects to be aware of

- Formula fields recalculate live: any already-pushed Lightreach deal created on/after
  Sep 4 drops from 1.75 to 1.65 immediately, which RAISES its Commission_Total__c
  (lower redline deduction). Its budget/POs move on the next Recalculate + Update
  Budget — that repricing is the point of the change, per Harmon.
- Deals created the evening of Sep 3 (AZ time) may sit on the GMT date boundary;
  if any real Lightreach deal was created Sep 3, spot-check which rate it shows.

## Deploy

1. Workbench -> Migration -> Deploy -> `v8-lightreach-redline-date.zip` ->
   **Check Only first** (compiles the formulas), then deploy for real.
2. No FLS/layout work — the fields already exist everywhere; only formula +
   description change. No Lambda changes: the calc reads Commission_Total__c,
   which follows the redline automatically.
3. Spot-check after deploy: one external Lightreach deal created before Sep 4
   (expect 1.75), one on/after (expect 1.65), one internal Lightreach (expect 2.10
   regardless of date), and the same deal's Customer and Solar records agreeing.
