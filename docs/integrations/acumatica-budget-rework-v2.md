# Acumatica Budget Integration — v2 Rework Plan
**Status: PLANNING — living document. Commit to sundial-core docs/integrations/ and update as decisions land.**
Drafted 2026-08-15 from the new Harmon workbook `BUDGET BRADS 7292026adders added 8.14.26.xlsx` ("BRADS"), which supersedes the HOLLAND workbook as the source of truth for budget math.

---

## 0. Decisions already made (do not re-litigate)

| # | Decision | Source |
|---|---|---|
| D1 | BRADS workbook replaces HOLLAND as the pinned regression fixture AND the S3 snapshot template. Its cached values are the expected outputs: contract 36,502 → Total Job Cost (no comm) 28,354.86 · Commissions 847 · GP$ 7,300.14 · Total Hours 64. | Workbook teardown |
| D2 | DC rebate = **$0.45/W** (LightReach), NOT 30%. YES/NO toggle → revenue line `DC REBATE` on the RSDC template. | Tim, confirmed |
| D3 | RSDC template already exists in live Acumatica, built by Harmon. Code `RSDC`. Selected when Domestic Content = true at project creation. | Tim, confirmed |
| D4 | Dealer→Vendor resolution: **config map** (Dealer is a bare SF picklist, no backing object). Map built from a live Vendor list pull (VendorID + VendorName) matched to picklist values by Tim. Lives in code beside the tax-zone map pattern (`lib/acumatica-vendors.js` or similar), flagged for future config externalization like tax zones. | Tim, confirmed |
| D5 | Attributes: fed from Sundial fields as they populate/update — date fields from the project lifecycle PLUS commission-payment fields that line up with POs and cost-budget lines. Attribute sync is therefore tied into the budget/PO update path, not a standalone feature. Enumeration comes from a live project `$expand=Attributes` pull. | Tim, confirmed |
| D6 | Existing adder Price/Qty fields on Customer + Solar are REPURPOSED as PRICE (commission-side) fields. New COST fields (Solar only) feed the budget. Quantities are shared — no duplication. | Tim, confirmed |
| D7 | After a Solar record exists, the SOLAR record is the source of truth for adders + commissions, including on the Customer page (read-only display of Solar values; editable Customer fields hidden). | Tim, confirmed |
| D8 | All connection/auth/infra is unchanged and proven. This is a mapping + math + field-model rework. | Tim |

## 1. What survives from v1 (do not rebuild)

- lib/acumatica.js (auth, GET/PUT helpers), secret `sundial/acumatica/connected-app` (now live-tenant), API Gateway routes, CORS.
- ProjectBudget write machinery: fresh filter-read → 4-part-key match (ProjectTaskID+AccountGroup+InventoryID+Type) → PUT-by-guid; sum-into-one-line; skip-zero on expense lines; income always written; fail-loud on 0 scaffold lines or ambiguous key; 429/5xx backoff; per-PUT logging; dryRun mode.
- Async push pattern: HTTP 202 → self-invoke worker → SF status write-back (Budget_Push_Status__c / Pushed_At / Error / Finalized). Re-push idempotent by construction.
- Unified Create Project button (3-state), recalc button, Update Budget button, snapshot→S3→Files-tab→XFiles→Dropbox chain, Supabase file metadata registration.
- Layer-1 customer/project push incl. tax-zone map, skip-guards, RESIDENT class. Only change: template selection RS vs RSDC.
- Known facts that still hold: GET-by-guid returns empty (never use); Acumatica misspells `RESIDENTAL`; income lines always written; API GW 29s cap on the synchronous /acumatica/push call.

## 2. What is rebuilt / net-new

| Area | Action |
|---|---|
| budgetCalc.js | REWRITE to BRADS math; re-pin test.js to BRADS cached values. HOLLAND fixture retired. |
| budget-template.xlsx | REPLACE with BRADS workbook (writer only addresses cells — cell map must be rebuilt to BRADS layout). |
| MAPPING_ROWS | REWRITE (new line set, see §5). Re-harvest keys from a live RS scaffold + first RSDC scaffold via reconcile read before any push. |
| SF field model | New fields per §4. Old strictly-budget Customer fields drop OUT of the create-mapping (fields not deleted — data safety). |
| Portal Budget UI | New input sections (commissions v2, COST adders), Customer read-only Adder/Commission tabs per D7. |
| PO engine | NET-NEW: stage in push worker after budget lines. See §6. |
| Attribute sync | NET-NEW: tied to budget/PO path + portal-save trigger for date fields. See §7. |
| resolveProjectTemplate | RS / RSDC by Domestic Content. |

## 3. New sheet mechanics (teardown findings)

### Commissions (inputs → 4 values)
- J7 Total salesperson commission PPW (per-job input) → sheet maps to `SLPC OUT | OTHER | M1&M2COM` (label H7)
- J8 Manager (Ralph) PPW, default 0.04 → `SLMC | LABOR | SALESCOMM`
- J10 Overhead (Daniel) PPW, default 0.015 → `SLPC | LABOR | SALESCOMM`
- J9 Setter (Geo) flat, $70 when Geovanna Macedo is Setter, else 0 → line label not shown on sheet (v1 used APPT COM — confirm)
- Burden = 75% × (manager + geo + overhead). Salesperson total NOT burdened. → `BURDENEXR | SALESCOMM`
- ⚠ OPEN (Q1/Q2 §9): Tim suspects the sheet's Daniel/Ralph treatment and the internal-vs-outside salesperson routing may be wrong. Do not freeze commission mapping until Harmon answers.

### Materials/labor changes vs HOLLAND
- Equipment rows: Combiner (604.81) · **Tesla Expansion Pack 6,009.03 (replaces Gateway row — reuse Gateway_* fields, relabel; note "*Add 4 Hrs Labor")** · Enphase micro (109.93) · Powerwall III (7,383.33, "*Add 16 Hrs Labor"). ⚠ OPEN Q6: are the +4/+16 hrs meant to be automatic in the calc, or manual? Sheet formulas do NOT add them automatically.
- Module cost/W default 0.6. QA hours default 2 (was 6). Hours/Battery = 20 — but formula G32=B29×rate does NOT multiply by battery qty (same flat-total quirk as v1; preserved unless Harmon says otherwise).
- S1/S2 split unchanged (S2 = install/3, S1 = rest). Roofing piece-rate unchanged.
- Material Other default 250 (was 890.15 in HOLLAND example — that was a value, not a default). CO fee 850, permit 750.

### Adders — PRICE vs COST model
Sheet computes per adder: `Price×Qty → minus labor (hours×rate) → minus burden (75%) → Balance → Material COST = Balance ÷ 1.25` (strips 25% markup). Adder labor rate is Powerwall rate (B28=33) for most rows; Site Audit + Travel use blended rate (B18).
- COST OVERRIDE SEMANTICS (design decision, pending Tim veto): new `Adder_<X>_Cost__c` fields are NULLABLE. Null → calc derives cost per sheet formula (the "default"). Populated → override wins. No constant-maintenance of defaults in SF.
- PPW-style adders (Conduit in Attic, Flat Roof, Roof Tile, Bird Blocking): price and cost are per-watt values; labor formulas are watt-based (e.g. 0.02×W). Cost fields for these hold per-watt values.
- REVENUE-ONLY adders (no cost side): Small System 10-12 (1250), Small System 13-15 (1000), Active Monitoring (100), LightReach Battery Warranty (600, "DEALER FEE?" ⚠ Q5), Referral Fee (500), Software Fee (30 — ⚠ contradicts its own SOFTWARE budget label, Q4).
- Labor-only adders (no material cost): Site Audit (350, 2h blended), Travel (750, 12h blended).
- NS adders: now FIVE blocks (was 3). Markup default 25% (editable). Labor at Powerwall rate (was blended in v1). Materials→GENM, labor→S3, burden→BURDENEXR.

### Confirmed sheet anomalies (⚠ Harmon must answer — Q3/Q4)
1. `SUBCON - ENGINEERING COSTS` (Structural, E55=250) and `SUBCON - SUBCONTRACTOR` (Bird Blocking, E56=0.06×W) are labeled as budget lines but feed NO summary cell — Total Job Cost (K28) excludes them entirely.
2. Software Fee: marked REVENUE ONLY in col E but labeled `SOFTWARE - AUDIT SOFTWARE` (a cost-budget task) in col F. Both cannot be true.
3. Income side: sheet shows Contract (N6) + DC Rebate (N7) revenue lines; v1's BALANCE/GENM-BILLING income split is not restated on this sheet — assume unchanged (BALANCE = contract − material income; GENM/BILLING = material) unless Harmon corrects. DC Rebate is a THIRD income line on RSDC projects.

### Summary rollups (new expected-output set for test.js)
K24 Total Material = equipment+BOS+roofing material + std-adder material + NS material. K25 Other = Material Other only. K26 Total Labor (incl. adder+NS labor). K27 Total Burden. K22/K23 CO fee + permit. K28 = SUM(K22:K27). K29 = K28 + commissions. Hours: GENA=audit+QA, S1, S2, S3=battery hrs+adder hrs+NS hrs. GP = Balance of Revenue − material − other − labor − burden − CO/permit, where Balance of Revenue = contract + DC rebate − dealer fee − commissions.

## 4. Field inventory (the buildable list)

Naming follows existing convention (`Adder_<Base>_Price__c` / `_Qty__c` / new `_Cost__c`).

> **§4a + §4b + §4c: PACKAGE BUILT, PENDING DEPLOY — 2026-08-20.**
> All 56 fields are in `salesforce/v2-budget-adder-fields/` (Metadata API v62.0,
> package.xml + two `.object` files + README). Collision-checked against the live
> describe on 2026-08-20: **none of the 56 API names already exist** on either object.
> Tim deploys (Check Only first) + grants FLS — see TASKS.md.
>
> **Three type findings from the live describe changed what got built** (full detail in
> the package README, "What the describe said"):
> 1. **The two objects diverge on the NS blocks.** Customer NS 1-3 are
>    `Percent(3,3)` / `Number(5,1)`; Solar NS 1-3 are `Percent(14,4)` / `Number(17,1)`.
>    Neither matches the `Percent(3,4)` / `Number(16,2)` written below. Blocks 4-5 clone
>    whichever object they sit on, so all five blocks behave alike within an object.
> 2. **Per-watt price fields are `Number` with 3 decimals, not 4** —
>    `Adder_Flat_Roof_Price__c` is `Number(15,3)` on Solar. The four per-watt Cost fields
>    match at `Number(15,3)` so cost and price for the same adder carry identical
>    precision. Overridable before deploy if 4 dp is wanted.
> 3. **`NS_Adder_1-3_Markup_Percent__c` defaults to 0 on Solar and has no default on
>    Customer.** New blocks 4-5 default to 25 per §3, so the five blocks will not behave
>    alike until 1-3 are aligned — logged as a follow-up, not in the additive package.
>
> Also not in the package (all changes to *existing* fields, so they stay out of an
> additive deploy): relabelling `Adder_Upgrade_225` to "225 Upgrade-Overhead", and the
> NS 1-3 markup default alignment.

### 4a. NEW adders — Price + Qty on BOTH Customer and Solar (7 adders × 2 fields × 2 objects = 28 fields)
| Base | Default price | Notes |
|---|---|---|
| Adder_Upgrade_225_UG | 2500 | "225 Upgrade-Underground" (existing Upgrade_225 relabels to "225 Upgrade-Overhead") |
| Adder_Gateway3 | 2950 | 4h labor |
| Adder_Site_Audit | 350 | 2h blended labor, no material |
| Adder_Travel | 750 | 12h blended labor, no material |
| Adder_Active_Monitoring | 100 | revenue-only. Distinct from existing Active_System_Monitoring__c Yes/No — do not conflate |
| Adder_LR_Battery_Warranty | 600 | revenue-only / "DEALER FEE?" pending Q5 |
| Adder_Referral_Fee | 500 | revenue-only |

### 4b. NS adder blocks 4 and 5 — BOTH objects (2 blocks × 4 fields × 2 objects = 16 fields)
`NS_Adder_4_Description__c` (Text 255), `NS_Adder_4_Markup_Percent__c` (Percent, default 25), `NS_Adder_4_Material_Cost__c` (Currency), `NS_Adder_4_Labor_Hours__c` (Number) — and the same ×5.

### 4c. COST adder fields — SOLAR ONLY (12 fields, all Currency except noted, all NULLABLE = "use sheet-derived default")
Adder_Sub_Panel_Cost__c · Adder_Derate_Cost__c · Adder_Heat_Detector_Cost__c · Adder_Upgrade_225_Cost__c · Adder_Upgrade_400_Cost__c · Adder_Upgrade_225_UG_Cost__c · Adder_Gateway3_Cost__c · Adder_Structural_Cost__c (default derives to 250 engineering) · Adder_Conduit_Attic_Cost__c (per-watt) · Adder_Flat_Roof_Cost__c (per-watt) · Adder_Roof_Tile_Cost__c (per-watt) · Adder_Bird_Blocking_Cost__c (per-watt, default derives to 0.06)
(No cost fields for: Site Audit, Travel (labor-only) or the revenue-only adders. NS blocks' Material_Cost inputs ARE their cost fields.)

### 4d. Commission inputs — reuse existing fields, semantics change (0 new fields, pending Q1/Q2)
- Sales_Rep_Commission_PPW__c → REPURPOSED: total salesperson commission PPW (relabel "Salesperson Commission PPW")
- Sales_Mgr_Commission_PPW__c (default .04), Overhead_Commission_PPW__c (default .015), Geo_Commission_Amount__c ($70 Geovanna rule), Commission_Burden_Rate__c (75) — unchanged.

### 4e. Per-adder commission FORMULA fields — BOTH objects (pending formula confirmation)
One formula field per priced adder: `Adder_<Base>_Comm_Amt__c` = Price × Qty (flat adders) or Price × Watts × Qty (per-watt adders — needs watts source on Customer: Final_System_Size_kW__c × 1000), plus rollup `Total_Adder_Comm_Amt__c`. ~21 per object. NOTE: formula fields are NOT mapped by Create Project (they self-compute on Solar because price+qty are mapped); they are excluded from the mapping table by design. ⚠ Q7: confirm the commission formula per adder type before building.

### 4f. PO tracking fields — SOLAR ONLY (draft, pending §6 answers)
Commission_PO_M1_Number__c · Commission_PO_M1_Amount__c · Commission_PO_M2_Number__c · Commission_PO_M2_Amount__c · Commission_PO_Status__c (picklist) · Commission_PO_Error__c · Commission_PO_Synced_At__c

### 4g. Create Project mapping deltas (documented as they land — keep current)
ADD to mapping: all §4a Price+Qty fields, §4b NS 4/5 sets. ALREADY MAPPED: existing adder price/qty, NS 1-3, commission PPW fields.
REMOVE from mapping (fields stay on Customer, dropped from the copy + hidden per D7): strictly-budget parameters that now live Solar-side with defaults — Commission_Burden_Rate (if on Customer), labor rates, burden, module cost/W, BOS costs, hours params, Material_Other, CO fee, permit, and any Budget_*/Total_*/GP_* output fields currently in the ~133-field identity block. EXACT LIST: to be produced by CC by diffing customer-to-solar-map.ts against the v2 input model — reviewed by Tim before shipping.
NEVER MAP: formula fields (4e), COST fields (4c — Solar-only, defaulted).

## 5. MAPPING_ROWS v2 (draft — freeze only after Q1-Q4 + live re-harvest)
| Budget element | Task · AG · INV · Type | Amount source (v2) |
|---|---|---|
| Income — Balance of Contract | BALANCE · BILLING · <N/A> · Income | contract − material income (assumed unchanged) |
| Income — Solar Material | GENM · BILLING · <N/A> · Income | Total material |
| Income — DC Rebate (RSDC only) | (re-harvest from RSDC scaffold) · Income | 0.45 × watts when DC=true |
| Salesperson commission | SLPC OUT · OTHER · M1&M2COM (⚠ Q1: internal vs third-party routing) | Total salesperson PPW × watts |
| Manager commission | SLMC · LABOR · SALESCOMM | .04 dflt × watts |
| Overhead commission | SLPC · LABOR · SALESCOMM (⚠ was rep+overhead sum in v1) | .015 dflt × watts |
| Setter commission | APPT COM · LABOR · SALESCOMM (v1 answer — reconfirm) | $70 Geovanna rule |
| Commission burden | BURDENEXR · LABOR · SALESCOMM | 75% × (mgr+geo+overhead) |
| Audit+QA labor / hours | GENA · LABOR · RESIDENTAL | hours-bearing |
| Roofing labor | ROOFCOM · LABOR · RESIDENTAL | piece rate |
| S1 / S2 labor | S1 / S2 · LABOR · RESIDENTAL | hours-bearing |
| S3 labor | S3 · LABOR · RESIDENTAL | battery + ALL adder + NS labor + hours |
| Labor burden | BURDENEXR · LABOR · RESIDENTAL | total burden |
| Total material | GENM · MATERIAL · <N/A> | incl. adder + NS material |
| Other | GENO · OTHER · <N/A> | Material Other (+CO fee, permit — v1 summed 3 rows; sheet now shows CO/permit under GENO labels K22/K23 — keep sum) |
| Engineering (Structural) | SUBCON · SUBCON(?) · ENGR? (⚠ Q3 + re-harvest: v1 scaffold had ENGR·SUBCON and SUBCON·SUBCON lines) | E55 |
| Subcontractor (Bird Blocking) | SUBCON · SUBCON · <N/A> (⚠ Q3) | E56 |
| Audit software | SOFTWARE · OTHER · <N/A> (⚠ Q4) | Software fee? |

## 6. PO engine spec (net-new; runs as a stage in the push worker AFTER budget lines succeed)
- Scope: salesperson/dealer commission ONLY. Manager, overhead, setter = payroll, never POs.
- Total commission for PO purposes = salesperson total (M1&M2COM number).
- Third-party dealer: M1 = min(50% × total, $2,500) at "Site Audit Complete"; M2 = total − M1 at "Glass on Roof".
- Internal Harmon sales: M1 = 75%, M2 = 25%. ⚠ Q2: do internal deals get POs at all (vendor = whom?) or payroll-only?
- Vendor = config map Dealer picklist value → Acumatica VendorID (D4). Missing mapping → fail loudly, no PO.
- Lifecycle: first push creates both POs; every budget re-push recomputes and UPDATES them. FREEZE RULE: a PO already released/completed/closed in Acumatica is never modified; the delta lands in M2 (that is why M2 is "balance"). If M2 itself is closed and totals changed → fail loudly for human decision.
- SF write-back: PO numbers/amounts/status per §4f, same one-PATCH pattern.
- Hand-proof plan: PO create + update mechanics proven by hand against the BizRun SANDBOX first (hand-minted sandbox token — sandbox connected app still valid; live secret untouched), Gate-5a style: create PO, read it, update amount, verify no duplication. Need from Harmon: one example commission PO from live (screen or PO number) to clone the shape — PO Type, vendor, line inventory (M1&M2COM?), project/task references, description conventions (⚠ Q5b).

## 7. Attribute sync spec (net-new)
- Content: project-lifecycle DATE fields + commission-payment fields aligned with POs/cost lines (D5). Exact field→AttributeID map: from live `$expand=Attributes` pull + Tim's mapping.
- Mechanism: PUT Project (and/or Customer) with Attributes array. Hand-prove once in sandbox.
- Triggers (two paths, same idempotent sync function):
  1. Budget/PO push worker updates the commission-payment attributes as part of its run.
  2. Portal save path: after a save that changed any watched date field → async attribute-sync invoke for that record.
- Attributes may be pre-created blank by the template (Harmon says same attributes on every job) — sync only fills values.

## 8. Template selection (RS / RSDC)
- resolveProjectTemplate: Domestic_Content (Customer/Solar boolean — confirm exact source field) true → RSDC, else RS.
- RSDC = RS + one revenue line (DC rebate, $0.45/W). Everything else identical (per Harmon).
- Re-harvest an RSDC scaffold with the reconcile read before first RSDC push; add the rebate line's 4-part key to MAPPING_ROWS.
- Edge (fail loudly): project created RS, Domestic Content later set true → scaffold lacks rebate line → push must abort with explicit message (add line manually in Acumatica or recreate project).
- Edge: DC=true but project pushed with rebate 0 — income lines are always written; rebate line written at 0.45×W only when DC=true (confirm behavior when toggled off after creation on an RSDC project: write 0? income-always rule says write; confirm with Harmon).

## 9. Open questions (gate map)
| # | Question | Gates |
|---|---|---|
| Q1 | Internal vs third-party salesperson commission: which budget line does each go to (SLPC OUT · M1&M2COM vs SLPC · SALESCOMM)? Sheet shows overhead on SLPC — Tim suspects wrong. | MAPPING_ROWS freeze, calc commission section |
| Q2 | Do INTERNAL sales generate POs (to what vendor) or payroll-only? (75/25 split given for internal.) | PO engine |
| Q3 | SUBCON engineering/subcontractor lines: should they roll into Total Job Cost (sheet currently excludes them) — and should they push to Acumatica? | calc totals, MAPPING_ROWS |
| Q4 | Software Fee: revenue-only or SOFTWARE cost line (sheet says both)? | calc, MAPPING_ROWS |
| Q5 | LightReach Battery Warranty "DEALER FEE?" — how is it treated? (b) One example live commission PO to clone shape. | calc; PO engine |
| Q6 | Tesla Expansion Pack +4hrs / Powerwall +16hrs — automatic in calc or manual entry? | calc labor/hours |
| Q7 | Per-adder commission formula: Price×Qty (flat) & Price×Watts×Qty (per-watt) — confirm, incl. which adders count toward commission. | formula fields (§4e) |
| Q8 | Setter commission budget line still APPT COM? | MAPPING_ROWS |
| Q9 | Geovanna rule: is Setter a field on Customer/Solar the calc can read to auto-apply $70? Field name? | calc |

## 10. Execution plan (2 days)
**Workstream A — SF metadata (Tim + CC package):** §4a-4c fields (56 confirmed) now; 4e/4f when Q7/Q2 answer. Workbench package(s), Tim deploys + FLS.
**Workstream B — calc v2 (CC, sundial-core):** BRADS cell map + math + new template embed + re-pinned test fixture. Gated only on Q3/Q4/Q6 (can build with flags/TODOs and BRADS-example values immediately).
**Workstream C — mapping + push (CC, sundial-core):** MAPPING_ROWS v2 after Q1-Q4; live RS re-harvest reconcile; RSDC harvest; template selection change.
**Workstream D — PO engine (CC, sundial-core):** after Q2/Q5b + vendor config map + sandbox hand-proof.
**Workstream E — attribute sync (CC, sundial-core):** after live attribute pull + Tim's field map; sandbox hand-proof.
**Workstream F — frontend (CC, harmon-crm):** Budget input rework (commissions v2, COST adders w/ null-=default hint), Customer read-only Adder/Commission tabs sourced from linked Solar + hide editable Customer fields when Linked_Solar_Project__c set (D7), Create Project mapping additions (§4g), PO status display.
**Verification gates:** BRADS fixture green → deploy calc; reconcile 0-problems on live RS + RSDC scaffolds → enable push; sandbox PO hand-proof → enable PO stage; one supervised live end-to-end incl. an RSDC + third-party-dealer job.

## 11. Field-change log for Create Project button (append as work lands)
- **2026-08-20 — fields BUILT (package, not deployed):** §4a ×28 + §4b ×16 + §4c ×12 in
  `salesforce/v2-budget-adder-fields/`. The mapping additions below are **still pending** —
  the Customer-side fields are inert until `customer-to-solar-map` copies them, so a
  deployed package alone does nothing for Create Project.
- (pending) ADD to mapping: §4a ×14 Customer Price/Qty pairs, §4b ×8 Customer NS 4/5 fields
- (pending) REMOVE from mapping: exact list from customer-to-solar-map.ts diff, Tim-reviewed
- Formula fields: never mapped (self-computing)
- NEVER MAP: §4c Cost fields — Solar-only by design, and their whole semantic is
  "null means derive", which a copy would destroy by writing an explicit value
