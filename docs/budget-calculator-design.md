# Sundial — Solar Project Budget Calculator Design (v2)

> Replaces Harmon's per-project "Sunbase Budget Sheet" workbook with native fields on `Sundial_Solar__c`, a Lambda-based calculation engine, and datestamped workbook snapshots in S3 — producing Acumatica-ready budget lines.
> Source of truth for the numbers: `Sunbase Budget Sheet Example.xlsx` (HOLLAND project). Every calculation was reimplemented from the workbook's formulas and verified to reproduce all 34 output cells exactly.
> Companions: `docs/Sundial_Solar_Budget_Fields.xlsx` (field catalog + Acumatica mapping), `sundial-budget-deploy.zip` (Workbench metadata package), `budget-lambda/` (calculation engine code).
>
> **v2 (2026-07-21):** calculation moved from a before-save Flow to an AWS Lambda; added S3 workbook snapshots, recalc button + field-change triggers, control/status fields, and the Workbench deployment package. v1's field model and calculation math are unchanged.

---

## 1. What the workbook actually does

One sheet, four functional zones:

1. **Cost Parameters (A6:B29)** — per-project unit rates: module cost/W, equipment unit costs & quantities, BOS $/W, labor rates, burden rate, hours assumptions, CO fee, permit pass-through. These are the blue-cell inputs; each project's copy of the workbook carries its own rates.
2. **Commissions (H6:K13)** — four commission rows (Sales Person, Sales Manager "Ralph", "Geo", Overhead "Daniel"), three $/W and one flat, with burden applied to only three of the four rows.
3. **Adders (A35:G76)** — 13 standard adders from a price catalog (flat $, $/W, or all-in), plus 3 free-form non-standard adder blocks (description, markup %, materials, labor hours).
4. **Budget rollup (I22:K36) and Summary (L6:N16)** — the outputs: material/labor/burden/other totals, job cost, $/W, GP, and labor hours split by crew stage. Almost every rollup line is annotated with an Acumatica task code (`GENM`, `GENO`, `GENA`, `S1`–`S3`, `ROOFCOM`, `BURDENEXR`, `SLMC`, `SLPC`, `DLR`) matching the `ProjectTaskID` values in the `acu_budget.json` ProjectBudget export. The sheet was already designed to feed Acumatica; we're formalizing that.

## 2. Field model

One field per input, one field per output, plus a small set of control/status fields:

| Group | Count | Notes |
|---|---|---|
| Inputs | 72 (70 new + 2 reused) | Reuse `Contract_Amount__c` and `System_Size__c` — do not create duplicates |
| Outputs — Tier 1 | ~32 | Feed Acumatica ProjectBudget lines or the management summary |
| Outputs — Tier 2 | ~24 | Line-item detail for PM visibility in the portal |
| Control / Status | 5 | `Budget_Calc_Status__c`, `Budget_Last_Calculated__c`, `Budget_Calc_Error__c`, `Budget_Finalized__c`, `Latest_Budget_File_Path__c` |

All 131 new fields ship in the Workbench deploy package (§7). `Sundial_Solar__c` currently has ~284 planned fields; this keeps it well inside the 800-per-object limit.

Two modeling decisions worth calling out:

- **Rates are per-project input fields with org defaults, not global constants.** Each project snapshots the rates in effect when it was budgeted, and a PM can override any of them on one job — exactly the workbook's behavior. When Harmon updates a catalog rate, update the field default (or set it in the portal's create flow); existing projects are untouched.
- **Adder hours-per-unit stay as constants in the calculator** (Sub Panel 3 h, Derate 3 h, Heat Detector 4 h, 225/400 Upgrade 16 h). They're structural to how the sheet prices adders. If Harmon wants them adjustable, promote them to defaulted fields later — a one-line change per adder in `budgetCalc.js`.

## 3. Calculation mechanism — Lambda engine

**The calculation runs in an AWS Lambda (`budget-lambda/`), not in a Salesforce Flow or formula fields.** Salesforce's role is to store inputs and outputs and to *request* recalculation; the Lambda is the only place the math lives.

Why this beats the alternatives:

- **The workbook snapshot forces a Lambda anyway.** Salesforce cannot author an .xlsx natively, so the moment a filled spreadsheet copy per calculation is a requirement, a Lambda is in the loop. Splitting the math (Flow) from the workbook writer (Lambda) would mean two implementations of the same 33-step calculation that can silently drift — the classic two-sources-of-truth bug. One Lambda does both from one code path.
- **One module, three consumers.** `budgetCalc.js` is a pure function (record fields in → output fields + spreadsheet cell map out). The Lambda uses it for the system-of-record calc; the React portal can import the very same module for live what-if previews while the PM types; the test suite pins it to the HOLLAND workbook (32 assertions, all passing).
- **No tedious Flow authoring.** ~55 interdependent formula resources in Flow Builder versus ~200 lines of commented JavaScript that your project conventions (JS everywhere, plain-English comments) already prefer.
- **Formula fields remain off the table** for the same reasons as v1: the GP chain would blow the 5,000-byte compile limit, formula fields can't be history-tracked, and a budget that silently re-derives after being pushed to Acumatica is the wrong shape for a financial record.

The trade-off to be aware of: outputs are now **eventually consistent** — there's a brief window between an input change and the Lambda's writeback. That's handled by `Budget_Calc_Status__c`: the trigger Flow sets it to `Pending` when it requests a recalc, the Lambda sets `Calculated` (or `Error` + `Budget_Calc_Error__c`) when done. The portal shows the status chip next to the budget section, and anything that consumes budget outputs (Acumatica push, reports) should require status = `Calculated`. The button path is synchronous through API Gateway, so the UI gets fresh numbers in the same request.

## 4. Recalculation triggers

Three ways in, one code path (see `budget-lambda/handler.js` and its README):

1. **Portal button ("Recalculate Budget")** — `POST /projects/{recordId}/budget/recalc` via API Gateway → Lambda, synchronous. Response carries the computed outputs so the UI refreshes instantly. Add the route to `docs/api-endpoints.md` when deployed.
2. **Field-change triggers** — one after-save record-triggered Flow on `Sundial_Solar__c`:
   - Entry: OR of `ISCHANGED()` on the milestone fields Harmon wants driving recalcs (Audit Completed, Design Review Finalized, etc. — final list from Harmon) **plus** the budget input fields, so direct Salesforce edits recalc too.
   - Actions: set `Budget_Calc_Status__c = 'Pending'`; publish **`Sundial_Budget_Recalc__e`** (ships in the deploy package: `Record_Id__c`, `Source__c`, `Requested_By__c`).
   - The event reaches the Lambda through the existing Platform Event → EventBridge relay, same as the Acumatica queue triggers. Multiple rapid edits simply produce a later snapshot that supersedes the earlier one.
   - This Flow is deliberately tiny — entry conditions and one publish action. All math stays in the Lambda.
3. **Admin/manual** — fire the same Flow or publish the event from anywhere (e.g., a quick action) without touching the portal.

Each successful run: reads inputs → calculates → updates all output fields + status/timestamp → writes the workbook snapshot to S3 → stamps `Latest_Budget_File_Path__c`.

## 5. Workbook snapshots in S3

Every calculation produces a filled copy of the budget sheet at
**`SUNDIAL/{record_id}/Budget_{ProjectName}_{YYYYMMDD-HHMMSS}.xlsx`** — the project's standard S3 folder, so it appears automatically in the portal Files tab, in Salesforce via XFiles Pro, and in Harmon's Dropbox via the copy-back sync. The datestamp makes every recalc a new revision; nothing is overwritten, giving a complete budget history per project.

Snapshots are **values-only by design**: every input and computed cell is written as a literal into the template layout, so the archived copy can never drift from what Salesforce showed at that moment. The bundled template (`budget-lambda/template/budget-template.xlsx`) is a cell-faithful reconstruction of the Sunbase sheet with live formulas — verified to recalculate to the HOLLAND example exactly — and doubles as the "working calculator" for anyone who wants to play with numbers in Excel. Since the writer addresses cells by reference, you can swap in Harmon's pristine original file as the template at any time for pixel-perfect branding.

`Latest_Budget_File_Path__c` always points at the newest snapshot. TODO in `handler.js`: register each snapshot's metadata in Supabase per `docs/file-storage.md` (category "Budget").

## 6. Calculation sequence (verified against the workbook)

The authoritative implementation is `budget-lambda/budgetCalc.js` (commented cell-by-cell). Summary, ordered so every step references only inputs or earlier steps; `Burden` = `Labor_Burden_Rate__c` (75%):

**Basics** — `Watts = System_Size__c × 1000` (F7); `Mods = Watts ÷ Module_STC_Wattage__c` (F9)

**Commissions** — rep/mgr/overhead = rate × watts (K7/K8/K10); Geo flat (K9); subtotal (J11); burden = (mgr+geo+overhead) × `Commission_Burden_Rate__c` — **rep row excluded** (J12); total = subtotal + burden (J13/N8)

**Materials** — modules = watts × cost/W (G12); combiner/gateway/microinverter/battery = unit × qty (G13–G16); BOS solar/electrical = $/W × watts (G17/G18); roofing material = pens/mod × $/pen × mods (G19)

**Labor** — audit & QA = rate × hours (G21/G23); roofing piece rate = $/pen × pens/mod × mods (G25); install = rate × hrs/mod × mods (G27), split S1 = 2/3, S2 = 1/3 (G28/G30); battery = total hours × battery rate (G32 — see quirk #1)

**Standard adders** — $/W adders: material = price × watts × qty; flat adders: material = price × qty, hours = qty × hrs/unit, labor = hours × **battery rate**, burden = 75%; Heat Detector (all-in): material = price − labor − burden (D43); totals D49/D50/D51

**Non-standard adders ×3** — labor = **blended rate** × hours; burden 75%; block total = materials × (1+markup) + labor + burden (D56/D64/D72); NS materials sum without markup (J40); combined adder labor/burden/hours (J41/J42/K42)

**Budget lines** — `TotalMaterial` = system materials + NS materials (K24 → GENM); `TotalOther` = Material Other + std adder materials (K25 → GENO); `TotalLabor` (K26); `TotalBurden` (K27 → BURDENEXR); `S3Labor` = battery + adder labor; job cost without/with commissions (K28/K29); $/W (K30/K31); hours GENA/S1/S2/S3/total (K33–K36, K32)

**Summary** — `BalanceOfRevenue` = contract − dealer fee − commissions (N9); `GP_Dollars` (N14); GP% with/without commissions (N15/N16)

**Verification:** `npm test` in `budget-lambda/` asserts 32 output fields against the HOLLAND workbook's cached values, and the generated snapshot was independently cross-checked cell-by-cell (no stale formulas, all checkpoints match).

## 7. Salesforce deployment package (Workbench)

`sundial-budget-deploy.zip` deploys everything in one shot — no clicking through Setup 131 times:

| Component | Contents |
|---|---|
| `objects/Sundial_Solar__c.object` | All 131 new fields (inputs with catalog defaults, outputs, control/status) with descriptions |
| `objects/Sundial_Budget_Recalc__e.object` | The recalc platform event (`Record_Id__c`, `Source__c`, `Requested_By__c`) |
| `permissionsets/Sundial_Budget_Integration.permissionset` | Read+Edit FLS on all 131 fields; object CRUD on `Sundial_Solar__c`; Read+Create on the platform event |
| `package.xml` | API v62.0 manifest |

**To deploy:** Workbench → Migration → Deploy → choose the zip → check **Single Package** → deploy (run with default options; add "Check Only" first if you want a dry run). Then assign the **Sundial Budget Integration** permission set to the integration user (Setup → Permission Sets → Manage Assignments — or one `PermissionSetAssignment` insert via Workbench).

Notes:
- Field-level security has no "create/delete" — that's object-level CRUD, which the permission set grants on `Sundial_Solar__c`. Read/Edit FLS on every field is the maximum field-level grant.
- The package intentionally excludes `Contract_Amount__c` and `System_Size__c` (reused, assumed to exist from your main field build). Make sure the integration user has FLS on those two through your existing permission set — they're calculator inputs.
- Deployed fields aren't added to page layouts automatically; add the Budget section to the layout/portal page when convenient. If the deploy errors on the platform-event `objectPermissions` block, remove that block from the permission set and grant event access via the integration user's profile instead.

## 8. Acumatica mapping

Unchanged from v1 — target is the `ProjectBudget` entity (`ProjectID` + `ProjectTaskID` + `AccountGroup` + `Type` + `OriginalBudgetedAmount`, hours as `OriginalBudgetedQty`/UOM=HOUR on labor lines). Full 17-line table in the field workbook's **Acumatica Mapping** tab. Push trigger: `Budget_Finalized__c` (or stage transition) → Platform Event → SQS → Acumatica consumer Lambda. Require `Budget_Calc_Status__c = 'Calculated'` before pushing.

| ProjectTaskID | AccountGroup | Amount source | Hours (Qty) |
|---|---|---|---|
| BILL | BILLING (Income) | `Contract_Amount__c` | — |
| SLPC / SLMC | SALESCOMM | commission amount fields | — |
| BURDENEXR | SALESCOMM | `Commission_Burden_Amt__c` | — |
| GENA | LABOR | Audit + QA labor | `GENA_Hours__c` |
| ROOFCOM | LABOR | `Roofing_Labor_Cost__c` | — (piece rate) |
| S1 / S2 / S3 | LABOR | `S1/S2/S3_Labor_Cost__c` | `S1/S2/S3_Hours__c` |
| BURDENEXR | (residential) | `Total_Labor_Burden_Budget__c` | — |
| GENM | MATERIAL | `Total_Material_Budget__c` | — |
| GENO | OTHER | `Total_Other_Budget__c`, CO fee, permit | — |

## 9. Workbook quirks — confirm with Harmon before building

The Lambda faithfully reproduces the sheet; these formula behaviors deserve a yes/no from Harmon finance:

1. **Battery hours don't scale with battery count.** B29 is labeled "Hours / Battery" (64) but G32 uses it as a flat total — the HOLLAND job has 4 Powerwalls and still books 64 hours, not 256. If per-battery is intended, it's a one-line change in `budgetCalc.js`.
2. **Commission burden skips the Sales Rep row** (`SUM(K8:K10×0.75)`) — presumably W-2 vs. paid-out-at-M1/M2. Confirm.
3. **Non-standard adder markup was inconsistent** — block 1's total excluded its markup row; blocks 2–3 included it. Markup was $0 in block 1 so it never mattered. Standardized: markup included for all three blocks.
4. **Standard adder materials go to GENO "Other"; non-standard adder materials go to GENM "Material."** Consistently coded on the sheet, but asymmetric — confirm it matches how finance wants the coding.
5. **Standard adder labor is priced at the $33 battery rate; non-standard at the $28.25 blended rate.** Both roll into S3. Confirm.
6. **Adder markup is revenue-side only** — appears in "Total Adders" (J39) but in no cost budget line. Kept as an informational field.
7. **Geo commission is a flat $70** despite sitting in the PPW column, and its row carries no Acumatica code on the sheet — need the right task code.
8. **Microinverter qty equaled module count (45)** on this job — the portal UI defaults `Microinverter_Qty__c` from `Calculated_Module_Count__c`, editable.

## 10. Implementation checklist

- [ ] Deploy `sundial-budget-deploy.zip` via Workbench; assign the **Sundial Budget Integration** permission set to the integration user; verify FLS on the two reused fields
- [ ] Get Harmon's answers on the §9 quirks; adjust `budgetCalc.js` if needed (each is a one-line change)
- [ ] Deploy `budget-lambda/` (npm install, wire the org-standard JWT auth in `handler.js`, env vars per its README); run `npm test`
- [ ] API Gateway route `POST /projects/{recordId}/budget/recalc` → Lambda; document in `docs/api-endpoints.md`
- [ ] Build the trigger Flow (entry conditions + set status Pending + publish `Sundial_Budget_Recalc__e`); wire the EventBridge relay to the Lambda; get Harmon's list of milestone trigger fields
- [ ] Wire the Supabase file-metadata registration for snapshots (TODO in `handler.js`)
- [ ] Portal: budget section (inputs + computed summary + status chip + Recalculate button + link to latest snapshot); optionally import `budgetCalc.js` for live preview
- [ ] End-to-end test with the HOLLAND numbers (expected: job cost 82,023.15 / GP 21,968.60 / 268 hours; snapshot appears in Files tab, XFiles Pro, and Dropbox)
- [ ] Wire `Budget_Finalized__c` → Acumatica ProjectBudget push (17 lines per the mapping tab), gated on status = Calculated
