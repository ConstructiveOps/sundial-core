# Roofing module revamp — plan, field package, and Claude Code prompts (2026-09-24)

> Written by Claude (Cowork) after reading both repos, the July-22 roofing budget package
> (`harmon-crm/sundial-roofing-budget-deploy.zip`, confirmed LIVE in the org — `Budget_Calc_Status__c`
> and `Job_City__c` describe on `Sundial_Roofing__c`), the July-22 `roofing-budget-lambda.zip`
> (never merged into sundial-core), Harmon's **RoofingBudgetMaster.xlsx** (2026-09-24) and
> **RoofingLayout.xlsx**. Both sheets are saved in `docs/roofing/`.

## 0. What exists today (the short version)

| Piece | State |
|---|---|
| `Sundial_Roofing__c` | 168 fields: identity/snapshot, `Stage__c` (**only value: "Stage 1"**), Sales Rep / PM lookups (+ `_Name__c` formulas), `Dealer__c`, 24 budget inputs, 46 × (Qty + Cost) material fields, 41 budget outputs, `Budget_Calc_Status__c / Error__c / Last_Calculated__c / Finalized__c`, `Latest_Budget_File_Path__c`, `Acumatica_Project_Id__c` (note lowercase `Id`) |
| Roofing calc engine | **None deployed.** A finished cell-for-cell port of the OLD sheet sits in `harmon-crm/roofing-budget-lambda.zip` (budgetCalc.js / budgetWorkbook.js / handler.js / test.js) — reuse it |
| Roofing → Acumatica | None. Solar's budget push (`sundial-acumatica-budget-push`), Layer-1 customer/project push (`sundial-acumatica-push`) and calc (`sundial-budget`) are all hard-coded to `Sundial_Solar__c` |
| Portal | `/projects/roofing` list/board (4 columns, no create button) and a Solar-clone detail page (no budget actions). No Roofing customer views, no "New Roofing Project" |
| Backend | `GET/PATCH /sf/roofing[…]` generic; `POST /sf/roofing` exists generically but nobody calls it (no snapshot, no stage, no customer tagging) |
| Customer hub | `Customer_Type__c` already has **Roofing**; `Requested_Project_Types__c` already has **Roofing**; `Roof_Type__c` exists on the customer (Asphalt Shingle / Clay Tile / Concrete Tile / Flat/Foam / Metal / Other / Wood Shake); `Linked_Roofing_Project__c` is designed in `docs/salesforce-schema.md` but **unverified in the org** |
| Service pattern to clone (D-075) | `POST /service/customers` (select-or-create + tag + `Service_Stage__c = New`), `GET /sf/customer?field=Customer_Type__c&value=Service&op=includes`, `ServiceCustomersPage` / `ServiceCustomerDetailPage` / `NewServiceCustomerModal`, `service-customer-config.ts`, `lib/service-customers.ts` |

## 1. Decisions (Tim, 2026-09-24)

1. **Markup model:** one input, `Sold_With_Solar__c` (Yes/No). The engine derives everything from it — Yes → 35 % markup on labor / material / other / commission and 2.5 % commission rate; No → 20 % and 1.5 % — and **writes** those numbers into the existing `Labor/Material/Other/Commission_Markup_Percent__c` and `Commission_Rate_Percent__c` on every recalc. No per-project override.
2. **Roofing customer pipeline on the hub:** `Roofing_Stage__c` + `Roofing_Request_Type__c` only (no Resolution / Resolved Date).
3. **Layout-sheet picklists:** `Sourced_From__c` = Resi Job / Service Job / Direct; `Roof_Type__c` (multi) = Asphalt Shingle / Clay Tile / Concrete Tile / Flat Built Up / Foam / Metal / Wood Shake / Other; `Payment_Type__c` (unrestricted) = Cash / Check / Credit Card / Financed / Insurance Claim; `Final_Payment_Status__c` = Not Billed / Billed / Invoiced / Received; `Lead_Source__c` on the project is a **formula read-through** to the customer's `Lead_Source__c`.
4. **Acumatica mapping** comes straight from columns F–H of the budget master (see §4).
5. Access: reuse the tenant-only keys `project.create`, `budget.recalc`, `budget.push`, `acumatica.sync`; add ONE new key `roofing.customer.write`. (Every `lib/access.js` change means redeploying `sundial-auth-proxy` too — TASKS.md:67.)

## 2. Salesforce deploy package — `salesforce/roofing-revamp-2026-09-24/`

Prebuilt zip: `salesforce/roofing-revamp-2026-09-24.zip` (68 components: 65 `Sundial_Roofing__c` fields, 2 `Sundial_Customer__c` fields, 1 permission set).

**Sundial_Roofing__c — new (19):** `Sold_With_Solar__c`, `Sourced_From__c`, `Lead_Source__c` (formula), `Roof_Type__c` (multi), `Payment_Type__c`, `Deposit_Received__c`, `Deposit_Amount__c`, `Deposit_Received_Date__c`, `Final_Payment_Status__c`, `Final_Payment_Received_Date__c`, `Notes__c`, `Budget_Push_Status__c` (Pushing/Pushed/Failed), `Budget_Pushed_At__c`, `Budget_Push_Error__c`, `Project_Created_in_Acumatica__c`, `Cost_Per_Square_Shingle_All_In__c`, `Cost_Per_Square_Shingle_No_Tax__c`, `Cost_Per_Square_Tile_All_In__c`, `Cost_Per_Square_Tile_No_Tax__c`.

**Sundial_Roofing__c — `Stage__c` value set replaced:** New → Inspection Scheduled → Budget In Progress → Proposal Sent → Sold → Scheduled → In Progress → Complete → Invoiced → Paid → Cancelled. ("Stage 1" becomes an inactive value; ROOF-1000 and the ZZ test record keep showing it until moved. Edit the list in `objects/Sundial_Roofing__c.object` before deploying if Harmon wants different stages.)

**Sundial_Roofing__c — 45 defaults refreshed from the 2026-09-24 budget master** (fields redeployed verbatim from the July package, only `defaultValue` / description changed): labor rates 168 / 224 / 112 / 140 (were 124 / 217 / 93 / 124), `Roll_Off_Qty__c` 0 (was 1), `Misc_Other_Qty__c` 0 (was 1), `Misc_Other_Cost__c` 350 (was 250), and 38 material unit prices. ⚠️ Five prices are **0** on the new sheet — GAF Felt Buster, 18" W-Valley Galv, 1.5" Jack Aluminum, 3" Jack Aluminum, .75 EG Nails. The package carries 0 as the sheet says; confirm with Harmon whether that means "no longer stocked" or "price unknown".

**Sundial_Customer__c — new (2):** `Roofing_Stage__c` (New / Contact Attempt Made / Inspection Scheduled / Quoted / Project Created / Lost / Closed), `Roofing_Request_Type__c` (Reroof / Repair / Reroof with Solar / Inspection Only / Other).

**Permission set:** `Sundial_Roofing_Revamp` — read+edit on all of the above for the integration user (formula field read-only).

**Companion (optional):** `salesforce/roofing-revamp-2026-09-24-linked-lookup/` + `.zip` adds `Sundial_Customer__c.Linked_Roofing_Project__c` (lookup → `Sundial_Roofing__c`). Deploy ONLY if Setup → Object Manager → Sundial Customer → Fields does not already list it.

### Deploy steps

1. Setup → Object Manager → **Sundial Customer** → Fields & Relationships → search `Linked_Roofing`. Note whether it exists.
2. Workbench → Migration → Deploy → choose `salesforce/roofing-revamp-2026-09-24.zip` → tick **Check Only** and **Rollback On Error** → Deploy. Expect **68/68**. (Most likely failure: a `Stage__c` attribute the org has that the package does not — e.g. `trackHistory` — deploy still succeeds; a real failure would be a picklist value in use that cannot be deactivated, which cannot happen here because we replace only "Stage 1".)
3. Same again without Check Only.
4. If step 1 said "missing": deploy `salesforce/roofing-revamp-2026-09-24-linked-lookup.zip` the same way (2/2).
5. Setup → Permission Sets → **Sundial Roofing Revamp** → Manage Assignments → add the **Sundial Integration User**. (Same for **Sundial Roofing Linked Lookup** if deployed.)
6. Supabase → SQL editor → run `sql/2026-09-24_roofing_revamp.sql`.
7. AWS Lambda → `sundial-cache-sync` → Test with `{ "object": "customer", "mode": "full" }`, then `{ "object": "roofing", "mode": "full" }`.

## 3. Budget engine spec (the 2026-09-24 sheet, cell by cell)

Percent fields arrive from SOQL in display domain (20 = 20 %) — divide by 100 once (D-063). Every money output is rounded to 2 dp.

```
markup     = Sold_With_Solar__c == "Yes" ? 0.35 : 0.20          (B100)   → write 35|20 to Labor/Material/Other/Commission_Markup_Percent__c
commRate   = Sold_With_Solar__c == "Yes" ? 0.025 : 0.015        (B114)   → write 2.5|1.5 to Commission_Rate_Percent__c
burden     = Burden_Rate__c / 100                                (20 %)

shingleLabor  = Labor_Rate_Shingle__c  * Squares_Shingle__c      (D9)   → Shingle_Labor_Total__c
tileLabor     = Labor_Rate_Tile__c     * Squares_Tile__c         (D10)  → Tile_Labor_Total__c
modifiedLabor = Labor_Rate_Modified__c * Squares_Modified__c     (D11)  → Modified_Labor_Total__c
recoatLabor   = Labor_Rate_Recoat__c   * Squares_Recoat__c       (D12)  → Recoat_Labor_Total__c
totalLabor    = sum of the four                                  (D98/E98) → Total_Labor_Budget__c
laborBurden   = totalLabor * burden                              (D99/E99) → Labor_Burden_Budget__c
laborMarkup   = (totalLabor + laborBurden) * markup              (D100) → Labor_Markup_Amt__c
laborTotal    = totalLabor + laborBurden + laborMarkup           (D101) → Labor_Total_With_Markup__c

totalMaterial = Σ Mat_<X>_Qty__c * Mat_<X>_Cost__c (46 items)    (D103/E103) → Total_Material_Budget__c
materialMarkup = totalMaterial * markup                          (D104) → Material_Markup_Amt__c
materialTotal  = totalMaterial + materialMarkup                  (D105) → Material_Total_With_Markup__c

rollOff   = Roll_Off_Qty__c * Roll_Off_Cost__c                   (D13)  → Roll_Off_Total__c
miscOther = Misc_Other_Qty__c * Misc_Other_Cost__c               (D14)  → Misc_Other_Total__c
otherBudget = rollOff + miscOther                                (D107/E107) → Other_Budget__c
otherMarkup = otherBudget * markup                               (D108) → Other_Markup_Amt__c
otherTotal  = otherBudget + otherMarkup                          (D109) → Other_Total_With_Markup__c

costSubtotal = laborTotal + materialTotal + otherTotal           (D111) → Cost_Subtotal__c
commission   = costSubtotal * commRate                           (D114/E114) → Commission_Amt__c
commBurden   = commission * burden                               (D115/E115) → Commission_Burden_Amt__c
commMarkup   = (commission + commBurden) * markup                (D116) → Commission_Markup_Amt__c
geo          = Geo_Commission_Amount__c                          (D117/E117)
geoBurden    = geo * burden                                      (D118/E118) → Geo_Burden_Amt__c
commTotal    = commission + commBurden + commMarkup + geo + geoBurden   (D119) → Commission_Total__c

totalJobCostClient   = laborTotal + materialTotal + otherTotal + commTotal            (D120) → Total_Job_Cost_Client__c
acumaticaBudgetTotal = totalLabor + laborBurden + totalMaterial + otherBudget
                     + commission + commBurden + geo + geoBurden                      (E120) → Acumatica_Budget_Total__c
profitDollars        = totalJobCostClient - acumaticaBudgetTotal                      (E121) → Markup_Profit_Dollars__c

taxable   = materialTotal                                        (D122) → Taxable_Amount__c
taxRate   = Job_City__c ? CITY_TAX[Job_City__c] : City_Tax_Rate__c/100   (C128; when the city is set, WRITE the table rate back to City_Tax_Rate__c)
cityTax   = taxRate * taxable                                    (D128) → City_Tax_Amount__c
warrantyDelta = Warranty_Line_Item_Amount__c - Warranty_Cost__c  (C125) → Warranty_Delta__c
totalProposal = totalJobCostClient + cityTax + Warranty_Line_Item_Amount__c   (D131) → Total_Proposal_Cost__c
proposalLessTax = totalProposal - cityTax                        (D133) → Proposal_Cost_Less_Taxes__c
Contract_Presented_Amount__c is INPUT (D132), never written.

totalSquares  = Σ squares                                        → Total_Squares__c
budgetedHours = totalLabor / 28   (was /29 in July)              (B135) → Budgeted_Hours__c (1 dp)
daysOnJob     = budgetedHours / 32                               (B136) → Days_On_Job__c (1 dp)
profitPct     = totalJobCostClient > 0 ? profitDollars / totalJobCostClient : 0   (A139) → Profit_After_Commission_Pct__c (whole number)
Cost_Per_Square_All_In__c  = totalSquares > 0 ? totalProposal / totalSquares : null    (July deviation, keep)
Cost_Per_Square_No_Tax__c  = totalSquares > 0 ? proposalLessTax / totalSquares : null
Cost_Per_Square_Shingle_All_In__c = Squares_Shingle__c > 0 ? totalProposal   / Squares_Shingle__c : null   (A142)
Cost_Per_Square_Shingle_No_Tax__c = Squares_Shingle__c > 0 ? proposalLessTax / Squares_Shingle__c : null   (A146)
Cost_Per_Square_Tile_All_In__c    = Squares_Tile__c    > 0 ? totalProposal   / Squares_Tile__c    : null   (A150)
Cost_Per_Square_Tile_No_Tax__c    = Squares_Tile__c    > 0 ? proposalLessTax / Squares_Tile__c    : null   (A154)
```

Input errors (422 `invalid_input`, `Budget_Calc_Status__c = Error`, mirror `sundial-budget`): `SOLD_WITH_SOLAR_MISSING`, `BURDEN_RATE_IMPLAUSIBLE` (> 100), `CITY_TAX_RATE_IMPLAUSIBLE` (> 20 %), `NEGATIVE_INPUT` (any square / qty / cost < 0).

Material rows on the NEW sheet (Qty = B, Cost = C, Total = D) are the July `MATERIALS` map **plus one** (row 4 "SOLD WITH SOLAR" was inserted): OC_Oakridge 17, Ridge_Shingles 19, GAF_ProStart 22, OC_Starter_Strip 23, Boral_Ply_40 26, Fontana_G40 27, ABC_Proguard 30, GAF_Felt_Buster 31, Mulehide_SA_Nail_Base 34, Mulehide_SA_Base_Sheet 35, Mulehide_SA_APP_Cap 36, Mulehide_A200_Flashing 39, Mulehide_A310_White 40, Mulehide_A310_Tan 41, Mulehide_210_Cement 42, Foam_Pack 43, Furring_Strip 46, Drip_Edge_Galv 49, Drip_Edge_Painted 50, Valley_18_W_Galv 53, Valley_24_3Rib 54, Tile_Pan_Galv 57, Jack_15_Alum_Sleeve 60, Jack_2_Alum_Sleeve 61, Jack_15_Alum 62, Jack_2_Alum 63, Jack_3_Alum 64, Jack_4_Alum 65, Jack_15_Galv 66, Jack_2_Galv 67, Jack_3_Galv 68, TTop_4_Alum 71, TTop_4_Galv 72, TTop_7_Alum 73, TTop_7_Galv 74, Nails_125_Coil 77, Nails_75_EG 78, Staples 79, Nails_1_Simplex 80, WB_Flat 83, WB_Ridge 84, WB_Hips 85, Birdstop_Metal 88, Tile_Piece 91, Tile_Pallet 92, OHagen_Vent 95. Every other cell in the July `cells` map also shifts **+1 row** (D97→D98 … A145→A146; the new A150/A154 tile cells are additional). City tax table = the `CITY TAX RATES` tab, column G (`=city+county+state`), keyed by the city name before " - " (the picklist values in `Job_City__c` are title-case city names).

## 4. Acumatica mapping (budget master columns F–H)

| Line | ProjectTaskID | AccountGroup | InventoryID | Type | Amount | Notes |
|---|---|---|---|---|---|---|
| Roofing labor | `R1` | `LABOR` | `ROOF LABOR` | Expense | `Total_Labor_Budget__c` | send `Budgeted_Hours__c` as Qty **only if** the harvested scaffold line has UOM `HOUR` |
| Labor burden | `BURDENEXR` | `LABOR` | `ROOF LABOR` | Expense | `Labor_Burden_Budget__c` | `BURDENEXR` appears twice — InventoryID disambiguates (same trick Solar uses) |
| Materials | `GENM` | `MATERIAL` | `<N/A>` | Expense | `Total_Material_Budget__c` | no markup |
| Other | `GENO` | `OTHER` | `<N/A>` | Expense | `Other_Budget__c` | no markup |
| Sales commission | `SALES COMM` | `LABOR` | `SALESCOMM` | Expense | `Commission_Amt__c + Geo_Commission_Amount__c` | one line for both commission rows on the sheet |
| Commission burden | `BURDENEXR` | `LABOR` | `SALESCOMM` | Expense | `Commission_Burden_Amt__c + Geo_Burden_Amt__c` | |
| Income | **(confirm)** | `BILLING` | `<N/A>` | Income | `Contract_Presented_Amount__c` | not on the sheet; Solar splits income into `BALANCE` + `GENM`; the roofing template decides |

Sum of the six expense lines = `Acumatica_Budget_Total__c` (E120). Markups never reach Acumatica (profit = E121).

### ⚠️ Four things only Harmon finance / the Acumatica tenant can answer — ask before Phase 3

1. **Roofing `ProjectTemplateID`** (Solar uses `RS` / `RSDC`). The template scaffolds the tasks + ProjectBudget lines the push updates by GUID; without it there is nothing to match.
2. **Income line(s)** on that template (task / account group / inventory), and whether contract-presented or total-proposal is the billing figure.
3. **`JOBTYPE` attribute value** for roofing (Solar = `RS`; allowed values seen: CE CS EV RE RS SE — `RE` is the obvious candidate, verify).
4. **Project ID scheme:** for Solar, Harmon types the Acumatica project id on the CUSTOMER (`Acumatica_Project_ID__c`, "Harmon Project ID") before sync. A customer with solar AND roofing needs two ids, so the plan stores the roofing one on **`Sundial_Roofing__c.Acumatica_Project_Id__c`** (typed on the roofing record before "Sync to Acumatica"). Confirm Harmon numbers roofing jobs the same manual way.

Once 1 is known: **harvest first** — invoke `sundial-acumatica-budget-push` directly with `{ "acumaticaProjectId": "<an existing roofing project id>" }` (read-only reconcile) and save the JSON as `lambdas/sundial-acumatica-budget-push/harvest/<id>-roofing.json`; the runbook is `docs/integrations/acumatica-budget-push.md` §Harvest. The mapping rows above are then checked against real scaffold keys, not assumed.

## 5. Build phases — paste each block into Claude Code, in order

Each prompt is self-contained; run them in the repo they name. Do Phase 1 and 2 (backend) before Phase 4 and 5 (frontend). Phase 3 waits on §4.

### Phase 1 — `sundial-core`: Roofing customers + roofing project create (`sundial-roofing` Lambda)

```
Read CLAUDE.md, docs/roofing-revamp-plan.md (§0, §1, §5 Phase 1), docs/service-customer-layout.md and
DECISIONS.md D-072 amendment (customer select-or-create) + D-075 before writing anything.

Goal: the Roofing module gets its own customer entry points, cloned from the Service pattern, in a NEW
Lambda `lambdas/sundial-roofing/` (one function per resource; the Service estimate Lambda must not grow
roofing routes).

1. Share the customer select-or-create helpers instead of copying them:
   - Move the pure helpers in `lambdas/sundial-service-estimate/customer.js` to `lib/customer-resolve.js`
     and make `lambdas/sundial-service-estimate/customer.js` a one-line re-export so nothing in the
     Service Lambda changes.
   - Move `resolveCustomer()` (currently `sundial-service-estimate/index.js` ~592-680) into
     `lib/customer-resolve.js` as `resolveCustomer(body, ctx, cors, { tag })` where `tag` is the
     Customer_Type__c / Requested_Project_Types__c value to union-add ("Service" | "Roofing" | "Commercial").
     The Service Lambda calls it with `{ tag: "Service" }` (PROJECT_TYPE_TAG). Behaviour, warnings, 409
     DUPLICATE_CANDIDATES, activity events: unchanged. Its dependencies (`picklistValues`,
     `loadCustomer`, `sfCreateRecord`, `markStale`, service-activity) are passed in through a `deps`
     object so both Lambdas can supply their own; default to the existing implementations.
   - Run the existing `sundial-service-estimate` tests; they must stay green.

2. New Lambda `lambdas/sundial-roofing/` (esbuild bundle via deploy.ps1 like the others), routes:
   - `POST /roofing/customers` — `createRoofingCustomer`: exact clone of `createServiceCustomer`
     (D-075) with tag "Roofing", stage field `Roofing_Stage__c` (New), request-type field
     `Roofing_Request_Type__c`, optional `request: { requestType, description, assignedTo,
     nextFollowUp, leadSource }`; describe-guarded (an org without
     salesforce/roofing-revamp-2026-09-24/ still gets the customer + a warning naming the package);
     never overwrite an existing Roofing_Stage__c; activity `customer_created` / `customer_tagged`
     with `details.roofing = true`; 201 created / 200 existing / 409 duplicates. Action key
     `roofing.customer.write`.
   - `POST /roofing/projects` — `createRoofingProject`: body `{ customer: {id}|{new,confirmNew},
     project: { projectName?, soldWithSolar: "Yes"|"No", sourcedFrom?, roofType?: string[],
     stage? } }`. Steps: resolveCustomer with tag "Roofing" → create ONE `Sundial_Roofing__c` with
     `Client__c` = tenant (server-stamped), `Sundial_Customer__c`, the four snapshot fields
     (`Customer_Name_at_Creation__c` = "First Last" else Name, `Address_at_Creation__c` = street,
     city, state zip, `Primary_Phone_at_Creation__c`, `Primary_Email_at_Creation__c`),
     `Project_Name__c` (default = customer name + " Roof"), `Stage__c` = stage or "New",
     `Sold_With_Solar__c`, `Sourced_From__c`, `Roof_Type__c` (join with ";"), `Sales_Rep__c` =
     customer `Sales_Rep__c` if present (Dealer__c derivation happens like sf-update's create) →
     then PATCH the customer: `Roofing_Stage__c = "Project Created"`, `Roofing_Project_Created__c =
     true`, and `Linked_Roofing_Project__c` = new id ONLY if the describe says that field exists
     (it is an optional package). Snapshot pattern per CLAUDE.md. markStale both caches. Activity
     `roofing_project_created`. Action key `project.create`. Response 201 `{ success, roofingId,
     customerId, customerCreated, warnings }`.
   - `GET /roofing/address/suggest` / `GET /roofing/address/place/{placeId}` — re-export the Service
     address handlers (`sundial-service-estimate/address.js` → move to `lib/address-lookup.js`, same
     re-export trick) gated by `roofing.customer.write`, so the New Customer popup in Roofing gets
     Google Places without needing `service.estimate.write`.
   - Dispatcher = copy of the Service Lambda's (`resolveIdentity`, tenant required, `assertAction`,
     JSON body, CORS). Prefix-strip regex must accept `/roofing/`.

3. `lib/access.js` ACTION_SCOPES: add `"roofing.customer.write": Object.freeze([SCOPES.TENANT])`.
   Update `lib/access.test.js`. Note in the commit that `sundial-auth-proxy` must be redeployed.

4. `scripts/wire-roofing-routes.ps1` modelled on `wire-service-estimate-routes.ps1`: resources
   `/roofing`, `/roofing/customers`, `/roofing/projects`, `/roofing/address`, `/roofing/address/suggest`,
   `/roofing/address/place/{placeId}` (POST/GET + OPTIONS, AWS_PROXY → sundial-roofing), a Lambda
   invoke permission for `/roofing/*`, deploy to stage prod. Leave room for
   `/roofing/{recordId}/budget/recalc` and `/roofing/{recordId}/budget/push` (Phase 2/3) — note API GW
   forbids sibling path variables with different names.

5. Tests: `lambdas/sundial-roofing/test.js` with the fake-describe pattern from the Service tests
   (`Requested_Project_Types__c` values include Roofing; a `noRoofingFields` flag proves the
   describe guard). Cover: new customer → roofing project; existing customer union-add; duplicate
   409; missing Sold_With_Solar → 400; cross-tenant customer id → 404.

6. Docs: `docs/api-endpoints.md` (new routes), `docs/roofing-customer-layout.md` (clone of
   service-customer-layout.md with the Roofing fields), DECISIONS.md new D-0xx "Roofing customer +
   project creation live in sundial-roofing; customer resolve is shared in lib", PROGRESS.md,
   TASKS.md, CLAUDE.md bullet under a new "Roofing Module" heading. End with the exact git commands.
```

### Phase 2 — `sundial-core`: Roofing budget engine (recalc + workbook snapshot)

```
Read CLAUDE.md, docs/roofing-revamp-plan.md §3 (the cell-by-cell spec — implement it EXACTLY),
lambdas/sundial-budget/handler.js + budgetCalc.js + budgetWorkbook.js (the Solar engine to mirror),
and DECISIONS.md D-063 (percent domain). The July port of the OLD sheet is unpacked at
lambdas/sundial-roofing/budget-src-july/ (budgetCalc.js, budgetWorkbook.js, handler.js, test.js) —
start from it, do not start from scratch. The NEW template workbook is
lambdas/sundial-roofing/template/roofing-budget-master.xlsx (Harmon's 2026-09-24 sheet, untouched).

Goal: `POST /roofing/{recordId}/budget/recalc` in the `sundial-roofing` Lambda (Phase 1), action
`budget.recalc`, identical protocol to Solar: tenant-scoped SOQL of every input field on
Sundial_Roofing__c → pure `calculateRoofingBudget(rec)` → fill the template (values-only snapshot on
"NEW BUDGET SHEET"; "CITY TAX RATES" and "MARK UPS WITH OR WITHOUT SOLAR" tabs ride along) → S3
`sfsolproj` key `SUNDIAL/{recordId}/Budget_{Name}_{YYYYMMDD-HHMMSS}.xlsx` → ONE sfUpdateRecord with
all outputs + `Budget_Last_Calculated__c` + `Budget_Calc_Status__c = Calculated` +
`Budget_Calc_Error__c = null` + `Latest_Budget_File_Path__c` → registerFileMetadata (category
"Budget"). Errors: BudgetInputError → 422 invalid_input + `Budget_Calc_Status__c = Error`.

Specifics that differ from the July code:
- Sold_With_Solar__c drives markup and commission rate (§3 first two lines) and the engine WRITES
  Labor/Material/Other/Commission_Markup_Percent__c and Commission_Rate_Percent__c (display domain:
  35 / 20 / 2.5 / 1.5) on every recalc. Blank Sold_With_Solar__c → SOLD_WITH_SOLAR_MISSING.
- Commission = costSubtotal × rate; markup applied to (commission + burden) — as §3.
- Budgeted hours divide by 28 (not 29).
- Four new per-type cost-per-square outputs; null (not 0) when the divisor is 0. Keep the two
  total-squares outputs.
- City tax: `lib/roofing-city-tax.js` generated ONCE from the template's CITY TAX RATES tab (column G,
  key = city name before " - ", title-cased to match Job_City__c) — a checked-in JS table, not a
  runtime xlsx read. When Job_City__c is set, the engine uses the table and writes the rate back to
  City_Tax_Rate__c (display domain, e.g. 9.10); when blank it uses City_Tax_Rate__c as typed.
- Guards: SOLD_WITH_SOLAR_MISSING, BURDEN_RATE_IMPLAUSIBLE (>100), CITY_TAX_RATE_IMPLAUSIBLE (>20),
  NEGATIVE_INPUT. (D-063: "the burden and markup guards ship with the roofing engine".)
- Cell map: every July cell shifts +1 row (row 4 "SOLD WITH SOLAR" was inserted); B4 = Sold With
  Solar; new cells A150/A154 (tile per-square). Write B100 / B114 as the derived fractions so the
  workbook's own formulas agree with the stored outputs.
- Percent domain exactly like Solar: SOQL gives 20 for 20 %; divide by 100 once; write whole numbers.

Tests (`lambdas/sundial-roofing/budget.test.js`): (a) a worked example with Sold With Solar = Yes and
one with No, asserting every output in §3 against numbers you compute by hand in the test file
(show the arithmetic in comments); (b) every guard; (c) the +1 row shift for three material rows and
for D98/E120/A146. Then wire the route in scripts/wire-roofing-routes.ps1 (POST + OPTIONS on
/roofing/{recordId}/budget/recalc), add the S3 + Secrets permissions the Solar budget Lambda has to
this function's role if they are per-function, update docs/api-endpoints.md, docs/budget-calculator-
design.md (Roofing section), PROGRESS.md, TASKS.md (close "When Roofing's budget/calc work starts,
its burden + markup guards ship with it"). End with the exact git commands.
```

### Phase 3 — `sundial-core`: Acumatica for roofing (Layer 1 project + budget push) — **after §4 is answered and the template harvested**

```
Read CLAUDE.md, docs/roofing-revamp-plan.md §4 (mapping + the four Harmon answers, which I will paste
below this prompt), docs/integrations/acumatica-budget-push.md, lambdas/sundial-acumatica-budget-push/
index.js, lambdas/sundial-acumatica-push/index.js, lib/acumatica*.js. The harvested roofing scaffold is
at lambdas/sundial-acumatica-budget-push/harvest/<id>-roofing.json.

HARMON ANSWERS: ProjectTemplateID = ____ ; JOBTYPE = ____ ; income line(s) = ____ ; project id is
typed on Sundial_Roofing__c.Acumatica_Project_Id__c = yes/no.

Goal A — Layer 1 for a roofing job. Make `sundial-acumatica-push` object-aware instead of writing a
sibling: body `{ recordId: <customerId>, project: "roofing", roofingId }` (default `project: "solar"`
keeps today's behaviour byte-for-byte). Customer stage: unchanged (existence via
Acumatica_Customer_ID__c). Project stage for roofing: read `Sundial_Roofing__c` (Id,
Acumatica_Project_Id__c, Project_Created_in_Acumatica__c, Project_Manager__r.Name via
Project_Manager_Name__c, Project_Name__c, Job_City__c, Client__c) tenant-scoped; ProjectID =
Acumatica_Project_Id__c (409 NO_ACUMATICA_PROJECT_ID when blank); ProjectTemplateID = the roofing
template from a `PROJECT_TEMPLATE_MAP.roofing` entry; Attributes JOBTYPE = the roofing value;
ProjectManager via `lib/acumatica-project-manager.js` (it takes names — pass the formula name);
Description = Project_Name__c; verify by re-read; write back `Project_Created_in_Acumatica__c =
today` on the ROOFING record (idempotency marker, skip when already set). Do not touch
Sundial_Customer__c.Synced_to_Acumatica__c semantics for solar. Route stays `POST /acumatica/push`,
action `acumatica.sync`. Add an INFO log line like the solar create.

Goal B — budget push. Refactor `sundial-acumatica-budget-push` around an `OBJECT_CONFIGS` table:
`solar` = today's constants (SOLAR_SF_OBJECT, MAPPING_ROWS, GUARD_FIELDS, the Commission_Deal_Type
guards, downstream stages) and `roofing` = `{ sfObject: "Sundial_Roofing__c", projectIdField:
"Acumatica_Project_Id__c", mappingRows: ROOFING_MAPPING_ROWS (plan §4, income row from the Harmon
answer), guards: [], downstream: [] }`. Dispatch on the route: `/projects/{id}/budget/push` → solar,
`/roofing/{id}/budget/push` → roofing (same way isAttributesSyncRoute dispatches). Gates for roofing
(409): BUDGET_NOT_CALCULATED, NO_ACUMATICA_PROJECT (blank Acumatica_Project_Id__c),
PROJECT_NOT_CREATED (blank Project_Created_in_Acumatica__c), CONTRACT_AMOUNT_MISSING if the income
row needs it. ADD the `assertAction("budget.push", …)` gate the solar path is missing (plan §0 notes
it). Same 202 + self-invoke worker, same three-state write-back into the roofing
Budget_Push_Status__c / Budget_Pushed_At__c / Budget_Push_Error__c / Budget_Finalized__c. Solar
behaviour must not change — run its tests. Add roofing tests against the harvested fixture (every
mapping row matches exactly one scaffold line; skip-zero; Qty only when UOM=HOUR).

Wire `/roofing/{recordId}/budget/push` (POST+OPTIONS → sundial-acumatica-budget-push) in
scripts/wire-roofing-routes.ps1. Docs: docs/integrations/acumatica-budget-push.md (Roofing section:
mapping table, gates, harvest), docs/api-endpoints.md, DECISIONS.md (D-0xx "budget push is object-
configured"), PROGRESS.md, TASKS.md, CLAUDE.md. End with the exact git commands.
```

### Phase 4 — `harmon-crm`: Roofing Customers views + New Customer / New Roofing Project popups

```
Read CLAUDE.md, ../sundial-core/docs/roofing-revamp-plan.md (§0, §1, §5 Phase 1 for the API shapes),
src/pages/service/ServiceCustomersPage.tsx, ServiceCustomerDetailPage.tsx, ServiceListShell.tsx,
src/components/service/NewServiceCustomerModal.tsx, CustomerPicker.tsx, NewServiceModal.tsx,
src/config/service-customer-config.ts, src/lib/service-customers.ts, and the Roofing pages.
The backend routes exist (Phase 1): POST /roofing/customers, POST /roofing/projects,
GET /roofing/address/suggest|place/{id}; GET /sf/customer?field=Customer_Type__c&value=Roofing&op=includes
already works.

Build the Service D-075 pattern for Roofing, importing the shared helpers rather than copying them:
1. `src/config/roofing-customer-config.ts` — ROOFING_STAGES (New, Contact Attempt Made, Inspection
   Scheduled, Quoted, Project Created, Lost, Closed), ROOFING_CLOSED_STAGES = {Lost, Closed},
   ROOFING_REQUEST_TYPES (Reroof, Repair, Reroof with Solar, Inspection Only, Other),
   `roofingCustomerSections` = Request tab (Roofing_Request_Type__c, Roofing_Stage__c, Assigned_To__c,
   Description__c, Next_Follow_Up_Date__c, Last_Contact_Date__c, Lead_Source__c, Customer_Type__c
   read-only "Departments") + the Contact and Property tabs copied from the Service config (Property
   already carries Roof_Type__c / Stories__c / Year_Built__c). No System & Accounts tab.
2. `src/lib/roofing-customers.ts` — ROOFING_TAG, isTaggedRoofing, isOpenStage, RoofingCustomerRecord
   (roofing_stage, roofing_request_type), `roofingCustomersApi.listTagged()` (listAllRecords with
   op:'includes'), `.create(body)` / `.addToRoofing(id)` → POST /roofing/customers; re-export
   customerDisplayName / customerAddress / assigneeName / followUpState / compareFollowUp from
   service-customers.ts. Tests cloned from service-customers.test.ts.
3. `src/components/roofing/RoofingListShell.tsx` — clone of ServiceListShell with tabs Projects
   (/projects/roofing) · Customers (/projects/roofing/customers); make RoofingProjectsPage render
   inside it too.
4. `src/pages/roofing/RoofingCustomersPage.tsx` (table + board by Roofing_Stage__c, search = whole hub
   via useServerSearch('customer'), untagged search hits show "Not in Roofing yet"; filters stage /
   status / assignee / request type; localStorage key sundial.roofing.customers.view; toolbar buttons
   New Customer + New Roofing Project) and `src/pages/roofing/RoofingCustomerDetailPage.tsx` (same
   record as Sales, Roofing subset, StageChip field="Roofing_Stage__c", "Add to Roofing" when
   untagged, "Create Roofing Project" button that opens the popup with presetCustomer, back link to
   /projects/roofing/customers; no MemberBadge, no estimate/job buttons).
5. `src/components/roofing/NewRoofingCustomerModal.tsx` — clone of NewServiceCustomerModal on
   roofingCustomersApi.create with ROOFING_REQUEST_TYPES and copy "tagged Roofing and starts at stage
   New". `CustomerPicker` / `AddressLookup` must take the address-route prefix as a prop (default
   '/service/address') so Roofing passes '/roofing/address'.
6. `src/components/roofing/NewRoofingProjectModal.tsx` — CustomerPicker (select-or-create, duplicate
   409 handling) + Project Name (prefilled "<customer> Roof"), Sold With Solar (Yes/No, required),
   Sourced From, Roof Type (multi-checkbox); POSTs /roofing/projects; on success navigate to
   /projects/roofing/{roofingId}. Offer it from RoofingProjectsPage's toolbar AND from the customer
   detail page AND from the Sales CustomerDetailPage's Project Routing section as a "Create Roofing
   Project" action next to the Solar one (ProjectSetupAction stays Solar-only).
7. Routes in App.tsx: /projects/roofing/customers and /projects/roofing/customers/:id placed BEFORE
   /projects/roofing/:id; update the header comment. nav.ts needs no change (prefix match, module
   'roofing').
8. Tests cloned from ServiceCustomersPage.test.tsx / ServiceCustomerDetailPage.test.tsx; access
   fixtures if they assert visible fields. PROGRESS.md, TASKS.md, DECISIONS.md (front-end D-0xx),
   CLAUDE.md. End with the exact git commands.
```

### Phase 5 — `harmon-crm`: Roofing project list + detail revamp (layout fields, budget tab, actions)

```
Read CLAUDE.md, ../sundial-core/docs/roofing-revamp-plan.md (§2 field list, §3 outputs, §5 Phases 2-3
for the routes), src/pages/RoofingProjectDetailPage.tsx, src/config/roofing-detail-config.ts,
src/components/roofing/*, src/components/solar/BudgetRecalcAction.tsx, BudgetPushAction.tsx,
src/components/solar/DetailField.tsx and src/lib/api.ts (recalcBudget / pushBudget /
pushCustomerToAcumatica).

1. `roofing-detail-config.ts` (hand-edit; it is generated from docs/Sundial_Roofing_Fields_by_Section.xlsx
   — also add the new rows to that workbook in ../sundial-core/docs so a regenerate does not drop
   them): new section `details` "Job Details" FIRST after Customer: Sold_With_Solar__c (picklist),
   Sourced_From__c, Lead_Source__c (readOnly), Roof_Type__c (multipicklist), Payment_Type__c,
   Deposit_Received__c, Deposit_Amount__c, Deposit_Received_Date__c, Final_Payment_Status__c,
   Final_Payment_Received_Date__c, Notes__c (longtext). Sale section: Stage__c options come from the
   live picklist (11 stages now). Budget section: DROP the four *_Markup_Percent__c and
   Commission_Rate_Percent__c from the editable inputs (they are engine-written now; show them
   readOnly in Outputs with a note "derived from Sold With Solar"). Outputs: add the four per-type
   cost/sq fields, Budget_Push_Status__c, Budget_Pushed_At__c, Budget_Push_Error__c,
   Project_Created_in_Acumatica__c. Type every percent field as 'percent'.
2. `src/components/roofing/DetailField.tsx` — bring it level with Solar's (percent formatting via
   formatPercent, help text).
3. Actions on the detail page header (mirror SolarProjectDetailPage 644-655): `RoofingBudgetRecalcAction`
   → `api.recalcRoofingBudget(id)` = POST /roofing/{id}/budget/recalc; `RoofingBudgetPushAction`
   ("Update Budget") → `api.pushRoofingBudget(id)` = POST /roofing/{id}/budget/push (202 + amber
   three-state rendering exactly like Solar's BudgetPushAction); "Sync to Acumatica" →
   `api.pushCustomerToAcumatica(customerId, { project: 'roofing', roofingId })` shown when
   Acumatica_Project_Id__c is set and Project_Created_in_Acumatica__c is blank. Disable Update Budget
   until Budget_Calc_Status__c = Calculated AND Project_Created_in_Acumatica__c is set, with the
   reason as help text. Never treat Pushing as a lock.
4. Budget snapshot link: show Latest_Budget_File_Path__c as a "Download latest budget workbook" link
   through the existing presigned-download API (same as Solar).
5. `RoofingProjectsPage` / `ProjectsTable` / `ProjectsBoard` / `types.ts`: columns Project · Customer ·
   Stage · Sold With Solar · Roof Type · Contract Presented · Total Proposal · Budget · Push; filters
   Stage + PM + Sales Rep (the comment already promises them); board card shows Sold With Solar chip
   and the headline $; the cache columns come from sql/2026-09-24_roofing_revamp.sql.
6. Customer detail (Sales) Related Records: the roofing chip already exists — make sure the new
   Linked_Roofing_Project__c (when present) renders like Linked_Solar_Project__c in Project Routing.
7. Tests for the config shape, the action gating, and the list columns. PROGRESS.md, TASKS.md,
   HARMON_PHASE1_PUNCHLIST.md (close B15 "New Roofing fields from Budget"), CLAUDE.md. End with the
   exact git commands.
```

## 6. Things I could not verify (read-only limits) — check in Setup before Phase 1

- Whether `Sundial_Customer__c.Linked_Roofing_Project__c` exists (§2 step 1).
- The exact `Stage__c` attributes on `Sundial_Roofing__c` beyond the value list (label "Stage", not required, unrestricted?) — the package declares `restricted = true`; if the org's field is unrestricted and Harmon wants to keep typing free-form stages, flip that line before deploying.
- `Sundial_Customer__c.Roofing_Project_Created__c` is a real checkbox in the org (it is in the generated customer config; nothing writes it today). Phase 1 writes it.
