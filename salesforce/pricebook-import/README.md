# Price book import (Housecall Pro → Sundial_Price_Book_Item__c)

Two HCP exports (`source_*.csv`, as Harmon sent them on 2026-09-15) become one Data Loader
file. `scripts/build-pricebook-import.mjs` is the whole transform — every rule it applies is
written in its header, and `review.csv` shows, item by item, what it decided and why, so
Beth / Paige can overrule any row before or after the load.

| File | What |
|---|---|
| `Sundial_Price_Book_Item__c.csv` | **The upload.** 219 rows (125 services + 94 materials). |
| `Sundial_Price_Book_Item__c.sdl` | The Data Loader field mapping (column = field, same names). |
| `review.csv` | Same rows minus the plumbing columns, plus a `Why` column. Open in Excel to review. |
| `source_*.csv` | HCP's exports, untouched. |

Rebuild after editing the source files or the rules: `node scripts/build-pricebook-import.mjs`.

## What the load does

- **Upsert on `HCP_Id__c`** (HCP's uuid). Running it twice updates rather than duplicates, and
  the later HCP job-history migration matches invoice lines to these items by the same id.
- Every row is **version 1**; `Item_Code__c` is generated (`SVC-ELEC-0012`, `MAT-INV-0003`).
  Codes never change after this — a price change later is *Update* on the Price Book page,
  which clones a version 2 with the same code.
- **57 rows come in inactive**: everything priced $0.00 with $0.00 cost (HCP's stock
  Electrical catalog Harmon never priced, and the $0 placeholder materials). They stay out of
  the estimate picker until someone prices and activates them from the Price Book page.
- Kind: 113 Labor, 93 Material, 13 Fee (plans, trip / service charges, disposal, permit &
  design, engineering — fees are never discounted).
- Job Type / Service Type / Category are the three list-view filters. Job Type: Solar 73,
  Electrical 50, EV 17, Commercial 42 (the AES parts), blank 37 (wire, conduit, misc
  materials). Category values that did not exist in the picklist (e.g. `RMA`, `Quoted Work`,
  `Commercial Parts`) are accepted because the picklist is unrestricted.

## Before you load

1. Deploy `salesforce/service-delta-2026-09-15` (Workbench, Check Only first) and run
   `sql/2026-09-15_service_delta.sql` in Supabase — `Job_Type__c` / `Service_Type__c` must
   exist or the mapping will fail on those two columns.
2. Optional: hand the `review.csv` to Beth. Edits go in the **source** CSVs (or straight in
   `Sundial_Price_Book_Item__c.csv` if it's a one-off), then rebuild.

## Data Loader steps (Windows)

1. Open **Data Loader** → log in as the integration user or your admin user (either can write
   `Sundial_Price_Book_Item__c`; the permission set covers the integration user).
2. **Settings** (top-left menu) → tick **Read all CSVs with UTF-8 encoding** and **Write all
   CSVs with UTF-8 encoding**; set **Batch size** to 50 (descriptions are long). Save.
3. Click **Upsert**.
4. Object: **Sundial_Price_Book_Item__c** (it may show as "Price Book Item"). Tick *Show all
   Salesforce objects* if it is not in the short list.
5. Browse to `C:\Users\TimMurphy\Projects\sundial-core\salesforce\pricebook-import\Sundial_Price_Book_Item__c.csv` → Next.
6. **Select the field to use for matching:** `HCP_Id__c`. Next.
7. **Client__c** is a lookup: on the "select the lookup match field" screen, leave it as
   `Id` (the CSV carries the 18-character tenant id `a1W7y000007AszBEAS`). Next.
8. Mapping: **Choose an Existing Map** → `Sundial_Price_Book_Item__c.sdl` (same folder). Every
   column should show as mapped. Next.
9. Pick the folder for the success / error files (the same `pricebook-import` folder is
   fine — they are git-ignored) → Finish → Yes.
10. Expect **219 successes, 0 errors**. If a row errors, the error file names the field and
    the reason; the usual ones are a picklist value Salesforce rejected (tell me — the
    `Category__c` picklist is unrestricted, so it should not) or a description over 4,000
    characters (already capped).

## After the load

- In the portal: **Service → Price Book** should list 162 active items with the three filter
  dropdowns populated. Inactive ones appear under the "show inactive" toggle.
- `sundial-cache-sync` picks the rows up on its next run; to see them immediately, open the
  Price Book page (read-through) or trigger the sync Lambda once.
- Re-running the upsert later (after Beth's edits to the source files) is safe: same
  `HCP_Id__c`, updated fields, no new rows — but note that a re-run overwrites Name /
  Description / prices on version 1 only; versions the office has since created are untouched.
