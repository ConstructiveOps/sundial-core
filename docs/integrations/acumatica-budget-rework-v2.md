# Acumatica Budget Integration — v2 Rework Plan
**Status: PLANNING→BUILD — living document. Update as decisions land.**
Drafted 2026-08-15 from the BRADS workbook. **REVISED 2026-08-20: `Harmon Budget Revised 82026.xlsx` ("REVISED") supersedes BRADS as the final source of truth** — same 2-sheet shape but a shifted cell layout (watts at E7, mods at E9, material rows in F, summary block in I/J) and materially changed commission + cost-rollup mechanics. All cell references below are REVISED-layout. Also received 2026-08-20: the live Vendor list export (Acumatica Dealer Codes.csv) and the live attribute enumeration (project R251282, completed) — both incorporated below.

---

## 0. Decisions already made (do not re-litigate)

| # | Decision | Source |
|---|---|---|
| D1 | **REVISED workbook** replaces HOLLAND (and BRADS) as the pinned regression fixture AND the S3 snapshot template. Fixture expectations from its cached example: contract 36,502 · watts 8,800 · commissions 3,169.50 (3rd-party 2,200 + mgmt 484 + geo 70 + burden 415.50) · Total Material 16,140.73 · GENO Other 2,550 · Engineer Stamps 250 · Subcontractor 528 · Software 30 · Referral 500 · Total Labor 2,605 · Labor Burden 1,953.75 · Job Cost (no comm) 24,557.48 · with comm 27,726.98 · Hours 63 (GENA 4 / S1 26.67 / S2 13.33 / S3 19) · Balance of Revenue 33,332.50 · GP$ 8,775.02 · GP% 24.04/26.33. | REVISED teardown |
| D2 | DC rebate = **$0.45/W** (LightReach), NOT 30%. YES/NO toggle → revenue line `DC REBATE` on the RSDC template. | Tim, confirmed |
| D3 | RSDC template exists in live Acumatica, built by Harmon. Code `RSDC`. Selected when Domestic Content = true at creation. | Tim, confirmed |
| D4 | Dealer→Vendor resolution: **config map** built from the delivered Vendor export, matched to Dealer picklist values by Tim. Lives in code beside the tax-zone map pattern; flagged for config externalization. NOTE from the export: dealers AND individual salespeople exist as vendors (many individuals Inactive); map only what the picklist actually offers, prefer Active vendors, fail loudly on unmapped or Inactive. | Tim + vendor export |
| D5 | Attributes are BOTH lifecycle dates and commission milestone amounts — confirmed by live pull (§7). Attribute sync ties into the budget/PO update path. | Live pull, confirmed |
| D6 | Existing adder Price/Qty fields on Customer + Solar are PRICE (commission-side). New COST fields (Solar only) feed the budget. Quantities shared. | Tim, confirmed |
| D7 | After a Solar record exists, SOLAR is the source of truth for adders + commissions; Customer page shows read-only Solar values, editable Customer fields hidden. | Tim, confirmed |
| D8 | Connection/auth/infra unchanged and proven. Mapping + math + field-model rework. | Tim |
| D9 | **Commission model v3 (from REVISED sheet):** two separate rep inputs — 3rd-Party Rep PPW → `SLPC OUT · OTHER · M1&M2COM`, Internal Rep PPW → `SLPC · LABOR · SALESCOMM`. Management (Ralph & Daniel) COMBINED at 0.055 PPW → `SLMC · LABOR · SALESCOMM`. Geo $70 flat → `APPT COM`. Burden 75% × (internal + mgmt + geo); 3rd-party NOT burdened. This resolves old Q1 and the Ralph/Daniel routing suspicion. | REVISED sheet |
| D10 | **CONFIRMED (Tim 2026-08-20). Management PPW stays as TWO stored inputs** (Sales_Mgr .04 + Overhead .015); the calc sums them to the single SLMC cost line (0.055), while attributes break them apart (MGRCOM* from .04, MGMTOR* from .015). | Tim + attribute pull |
| D15 | **Cost fields get STATIC DEFAULT VALUES in SF** (supersedes the null-=derive design): more visible and admin-editable. The calc ALWAYS reads the Cost field (never derives). Semantics: flat adders = per-UNIT cost (calc × qty); per-watt adders = per-watt cost (calc × watts when selected). Consequence: changing a job's PRICE does not auto-move its COST — the user adjusts both if needed. Defaults computed from the sheet derivation, see §4c. | Tim, 2026-08-20 |
| D16 | **Internal deals: payroll only, NO POs** (resolves Q2). They share the SAME attributes as 3rd-party deals (SLSCOM1/2 filled with the internal 75/25 split) but hit the SLPC·SALESCOMM cost line. Deal type determined by which rep PPW is populated: 3rd-party PPW > 0 → 3rd-party (POs, capped M1 split); Internal PPW > 0 → internal (no PO, 75/25). Both populated = validation error, fail loudly. | Tim, 2026-08-20 |
| D17 | **Setter commission rule (resolves Q9):** applies when `Setter__c` is populated (any setter — Geovanna today, others possible). Amount from Geo_Commission_Amount__c (default 70). Empty Setter__c → 0. **⚠️ NOT YET IMPLEMENTABLE — `Setter__c` exists on Customer only (Lookup → Sundial_User__c, plus `Setter_Name__c` Text(120)); `Sundial_Solar__c` has NO setter field, and the create-mapping deliberately excludes it. The calc is Solar-side. Needs a Solar field + mapping entry before this rule can fire (see §4d addendum / TASKS).** | Tim, 2026-08-20; describe-verified 2026-08-20 |
| D11 | **All cost lines now roll into totals** — REVISED fixes the BRADS anomaly: Job Cost J28 = SUM(J15:J25,J27) includes SUBCON Engineering (E55), SUBCON Subcontractor (E56), SOFTWARE (E60), REFERRAL (E63). GP nets them too (N13 "Total Other*" = GENO+stamps+subcon+software+referral). Resolves old Q3/Q4. | REVISED sheet |
| D12 | **GENO now includes Active Monitoring + LightReach Battery Warranty** (J16 = Material Other + CO fee + permit + E61 + E62). They are cost lines, not revenue-only. Resolves old Q5(a). | REVISED sheet |
| D13 | **REFERRAL is its own budget line**: `REFERRAL - OTHER - REFERRAL FEE` ← Referral Fee adder (500 × qty). NEW task code — the v1 sandbox scaffold (38 lines) had NO REFERRAL line; the live template must be re-harvested and MUST contain it or push fails. | REVISED sheet |
| D14 | Small System 10-12 / 13-15 remain the ONLY revenue-only adders (price affects commission side; no cost line). | REVISED sheet |

## 1. What survives from v1 (do not rebuild)

- lib/acumatica.js (auth, GET/PUT helpers), secret `sundial/acumatica/connected-app` (live-tenant), API Gateway routes, CORS.
- ProjectBudget write machinery: fresh filter-read → 4-part-key match → PUT-by-guid; sum-into-one-line; skip-zero on expense lines; income always written; fail-loud on 0 lines or ambiguous key; backoff; per-PUT logging; dryRun.
- Async push pattern (202 → self-invoke worker → SF status write-back). Re-push idempotent.
- Unified Create Project button (3-state), recalc button, Update Budget button, snapshot→S3→Files/XFiles/Dropbox chain, Supabase metadata registration.
- Layer-1 push incl. tax zones, skip-guards, RESIDENT. Only change: RS/RSDC template selection.
- Standing facts: GET-by-guid empty (never use); `RESIDENTAL` misspelling; API GW 29s cap on the synchronous /acumatica/push.

## 2. What is rebuilt / net-new

| Area | Action |
|---|---|
| budgetCalc.js | REWRITE to REVISED math; test.js re-pinned to REVISED cached values (D1). HOLLAND retired. |
| budget-template.xlsx | REPLACE with REVISED workbook; cell map targets REVISED layout. |
| MAPPING_ROWS | REWRITE per §5. Re-harvest live RS + RSDC scaffolds (must contain REFERRAL, SOFTWARE, ENGR/SUBCON lines) before any push. |
| SF field model | §4 (package built) + §4d addendum (1 new field pair). Old strictly-budget Customer fields drop out of create-mapping. |
| Portal Budget UI | Commissions v3 inputs, COST adders, Customer read-only tabs (D7), PO status. |
| PO engine | NET-NEW stage in push worker. §6. |
| Attribute sync | NET-NEW, two triggers. §7. |
| resolveProjectTemplate | RS / RSDC by Domestic Content. |

## 3. REVISED sheet mechanics (final)

### Inputs (complete list — these define the Solar-side input model)
- **Project/contract:** Contract Amount (N6) · Dealer Fee (N8) · DC Rebate toggle (D3 YES/NO → $0.45/W) · System Size kW (D7) · Module type (B7) · Module STC wattage (B8).
- **Cost parameters (defaulted, per-job overridable):** Module cost/DC-watt 0.6 · Combiner 604.81 + qty · Tesla Expansion Pack 6,009.03 + qty (reuses Gateway_* fields, relabel) · Enphase micro 109.93 + qty · Powerwall III 7,383.33 + qty · BOS Solar 0.17 · BOS Electrical 0.10 · Roof material/pen 24 · Pens/module 1.75 · Blended labor rate 28.25 · Burden 75% · Audit hrs 2 · QA hrs 2 · Roofing cost/pen 21 · Roofing pens/mod 1.75 · Hours/module 2 · Material Other 250 · CO fee 850 · Permit 750 · Powerwall labor rate 33 · **Hours/Battery 16 (was 20 in BRADS — existing field default change, follow-up package)**.
- **Commissions (4 inputs):** 3rd-Party Rep PPW (per-job) · Internal Rep PPW (per-job) · Management PPW (stored as .04 + .015 per D10, summed) · Geo flat ($70 Geovanna rule).
- **Adders:** Price + Qty per catalog row (§4a + existing) · COST overrides (§4c, null = derive) · NS blocks 1-5 (markup dflt 25%, materials, hours, description).

### Calc mechanics
- Burden J12 = 75% × (internal + mgmt + geo commissions). 3rd-party excluded.
- Adder cost derivation unchanged: Price×Qty − labor − burden → Balance ÷ 1.25 = material cost (COST field overrides when populated). Per-watt adders (Conduit/Flat Roof/Roof Tile/Bird Blocking) work in per-watt terms; labor 0.02×W (0.005×W roof tile).
- Adder labor at Powerwall rate except Site Audit + Travel (blended). Adder labor+hours → S3; burden → BURDENEXR·RESIDENTAL; material → GENM.
- NS blocks ×5: labor at Powerwall rate, burden 75%, markup on materials; material → GENM, labor → S3.
- Structural renamed "Structural-Electrical Engineer Stamp": cost E55 = 250 if selected → SUBCON Engineering. Bird Blocking cost E56 = 0.06×W → SUBCON Subcontractor.
- Battery labor still B29×rate flat (NOT ×qty) — preserved quirk. ⚠ Q6 still open (+4/+16 hrs notes are manual today).
- Summary rollups per D1/D11.

## 4. Field inventory

> **§4a + §4b + §4c + §4d: PACKAGE BUILT AND AMENDED (`salesforce/v2-budget-adder-fields/`), PENDING DEPLOY — 2026-08-20.** **58 fields** (Customer 23 / Solar 35), collision-checked clean including `Internal_Rep_Commission_PPW__c`. REVISED sheet re-checked: the adder catalog is UNCHANGED from BRADS, so §4a/§4b remain as built.
> **Amendment applied 2026-08-20 (D15 + §4d):** the 12 Cost fields now carry the STATIC DEFAULTS in the §4c table below; all null-=derive language is gone from the field descriptions, replaced with the per-UNIT vs per-WATT semantic and the "price changes do not auto-move cost" note. `Internal_Rep_Commission_PPW__c` added to both objects — type cloned from `Sales_Rep_Commission_PPW__c`, which is a **Number** despite its "$/W" label: `Number(4,3)` on Customer, `Number(15,3)` on Solar, default 0.
> Type findings + follow-ups (NS divergence, per-watt Number(15,3), NS 1-3 markup default alignment, Upgrade_225 relabel) recorded in the package README; per-watt 3dp CONFIRMED (all four D15 defaults land within 3dp).
> **⚠️ D17 BLOCKER — `Setter__c` does not exist on `Sundial_Solar__c`.** Verified against the live describe 2026-08-20: Customer has `Setter__c` (Lookup → `Sundial_User__c`) plus `Setter_Name__c` Text(120); **Solar has no setter field of any kind**, and `customer-to-solar-map.ts` explicitly excludes it (*"Sundial_Solar__c has no corresponding field"*). The calc runs Solar-side, so D17's rule cannot fire until a Solar setter field exists and is mapped. Not a package item — see TASKS.md.
> **Follow-up existing-field package additions:** Battery hours default 20→16; Structural label → "Structural-Electrical Engineer Stamp"; `Sales_Rep_Commission_PPW__c` relabel → "3rd Party Rep Commission PPW" (§4d); Gateway_* relabel → Tesla Expansion Pack; NS 1-3 markup default → 25.

### 4a. NEW adders — Price + Qty, BOTH objects (28) — AS BUILT
Upgrade_225_UG 2500 · Gateway3 2950 · Site_Audit 350 · Travel 750 · Active_Monitoring 100 · LR_Battery_Warranty 600 · Referral_Fee 500.

### 4b. NS blocks 4 + 5, BOTH objects (16) — AS BUILT.

### 4c. COST fields, SOLAR only (12) — **AMEND PACKAGE BEFORE DEPLOY (D15): add static defaults, drop null-=derive**
Defaults derived from the sheet (per-unit: (price − hours×rate×1.75) ÷ 1.25; rate 33 except Site Audit/Travel n/a):
| Field | Default | Basis |
|---|---|---|
| Adder_Sub_Panel_Cost__c | 261.40 | 500, 3h |
| Adder_Derate_Cost__c | 341.40 | 600, 3h |
| Adder_Heat_Detector_Cost__c | 175.20 | 450, 4h |
| Adder_Upgrade_225_Cost__c | 1540.80 | 2850, 16h |
| Adder_Upgrade_400_Cost__c | 3220.80 | 4950, 16h |
| Adder_Upgrade_225_UG_Cost__c | 1260.80 | 2500, 16h |
| Adder_Gateway3_Cost__c | 2175.20 | 2950, 4h |
| Adder_Structural_Cost__c | 250.00 | direct (engineer stamp, SUBCON) |
| Adder_Conduit_Attic_Cost__c | 0.052 /W | (0.1−0.02×1.75)÷1.25 |
| Adder_Flat_Roof_Cost__c | 0.052 /W | same |
| Adder_Roof_Tile_Cost__c | 0.009 /W | (0.02−0.005×1.75)÷1.25 |
| Adder_Bird_Blocking_Cost__c | 0.06 /W | direct (SUBCON) |
Field descriptions must state the per-unit / per-watt semantic and that price changes don't auto-move cost.

### 4d. Commission inputs — **UPDATED for REVISED sheet**
- **NEW FIELD (addendum package): `Internal_Rep_Commission_PPW__c`** — Number/Currency-per-watt, default 0, on BOTH objects (rep-entered at sale, copied by Create Project).
- `Sales_Rep_Commission_PPW__c` → RELABEL "3rd Party Rep Commission PPW" (repurposed; per-job value like 0.25).
- `Sales_Mgr_Commission_PPW__c` (.04) + `Overhead_Commission_PPW__c` (.015) RETAINED per D10; calc sums → SLMC line.
- `Geo_Commission_Amount__c` ($70 rule) + `Commission_Burden_Rate__c` (75) unchanged.

### 4e. Per-adder commission FORMULA fields — BOTH objects (⚠ Q7 pending). Never mapped (self-computing).

### 4f. PO tracking fields — SOLAR only (draft, pending Q2/Q5b).

### 4g. Create Project mapping deltas
ADD: §4a ×14 Customer pairs, §4b ×8 Customer NS fields, `Internal_Rep_Commission_PPW__c`.
REMOVE: strictly-budget Customer fields (exact list = CC diff of customer-to-solar-map.ts vs v3 input model, Tim-reviewed). `Overhead_Commission_PPW__c`/`Sales_Mgr_Commission_PPW__c` REMAIN mapped (still inputs per D10).
NEVER MAP: formula fields, COST fields.

## 5. MAPPING_ROWS v3 (freeze after live re-harvest)
| Budget element | Task · AG · INV · Type | Amount source (v3) |
|---|---|---|
| Income — Balance of Contract | BALANCE · BILLING · <N/A> · Income | contract (+rebate?) − material income — confirm at re-harvest |
| Income — Solar Material | GENM · BILLING · <N/A> · Income | Total material |
| Income — DC Rebate (RSDC only) | re-harvest RSDC scaffold · Income | 0.45 × watts when DC true |
| 3rd-party rep commission | SLPC OUT · OTHER · M1&M2COM | 3rdPartyPPW × watts |
| Internal rep commission | SLPC · LABOR · SALESCOMM | InternalPPW × watts |
| Management commission | SLMC · LABOR · SALESCOMM | (.04+.015) × watts |
| Setter commission | APPT COM · LABOR · SALESCOMM | $70 Geovanna rule (⚠ Q9 source field) |
| Commission burden | BURDENEXR · LABOR · SALESCOMM | 75% × (internal+mgmt+geo) |
| Audit+QA labor/hours | GENA · LABOR · RESIDENTAL | J21 / 4 hrs |
| Roofing labor | ROOFCOM · LABOR · RESIDENTAL | piece rate |
| S1 / S2 labor+hours | S1 / S2 · LABOR · RESIDENTAL | splits |
| S3 labor+hours | S3 · LABOR · RESIDENTAL | battery + adder + NS labor |
| Labor burden | BURDENEXR · LABOR · RESIDENTAL | J27 |
| Total material | GENM · MATERIAL · <N/A> | J15 |
| Other | GENO · OTHER · <N/A> | MaterialOther + CO + permit + ActiveMonitoring + LRWarranty (J16) |
| Engineer stamps | ENGR? · SUBCON · <N/A> — v1 scaffold had ENGR "Engineering Costs"; confirm at re-harvest | E55 |
| Subcontractor | SUBCON · SUBCON · <N/A> | E56 |
| Audit software | SOFTWARE · OTHER · <N/A> | E60 |
| Referral fees | REFERRAL · OTHER · ? — **NOT in v1 scaffold; must exist in live template (D13)** | E63 |

## 6. PO engine spec (pending Q2/Q5b)
Unchanged from prior draft: 3rd-party M1 = min(50%, $2500) at Site Audit Complete, M2 = balance at Glass on Roof; internal 75/25 (⚠ Q2 PO-vs-payroll); vendor via D4 config map; freeze rule on released POs; SF write-back per §4f; sandbox hand-proof first. Live attribute pull CORROBORATES: R251282 shows SLSCOM1 = exactly 2500 (cap hit), SLSCOM2 = 4814 balance.

## 7. Attribute map (live enumeration, project R251282 — now concrete)
| AttributeID | Description | Fed by | When |
|---|---|---|---|
| AUDITDATE | Audit Date | **Audit_Date_and_DateTime__c** | portal-save trigger |
| INDESIGN | In Design Date | **Approved_for_Design_Date__c** | portal-save |
| INCOMDATE | Install Complete Date | **Scheduled_Install_Date__c** | portal-save |
| GREENTAG | Green Tag Date | **Inspection_Pass_Date__c** | portal-save |
| COMDATE | Commissioning Date | **Commission_of_System__c** | portal-save |
| JOBTYPE | Job Type (RS / RSDC value observed "RS") | template code at creation | Layer-1 push |
| KW | Kilowatts | System_Size__c | Layer-1 / budget push |
| SALESPERSO | Sales Person (name) | rep/dealer name field (Tim to name) | Layer-1 / budget push |
| SLSCOM1 / SLSCOM2 | Salesperson commission M1/M2 | PO engine amounts | budget/PO push |
| MGRCOM1 / MGRCOM2 | Manager comm M1/M2 (75/25 of .04×W — verified 382.80/127.60 @12.76kW) | calc (mgr component) | budget/PO push |
| MGMTOR1 / MGMTOR2 | Mgmt override M1/M2 (75/25 of .015×W — verified 143.55/47.85) | calc (overhead component) | budget/PO push |
⚠ Q10: Tim supplies the five date-field API names + SALESPERSO source. Mechanism: PUT Project with Attributes array (id/AttributeID + Value); hand-prove once in sandbox.

## 8. Template selection (RS / RSDC) — unchanged from prior draft; JOBTYPE attribute should carry the same code.

## 9. Open questions (updated 2026-08-20)
| # | Status | Question |
|---|---|---|
| Q1 | **RESOLVED (D9)** | Internal→SLPC·SALESCOMM, 3rd-party→SLPC OUT·M1&M2COM, mgmt combined→SLMC. |
| Q2 | **RESOLVED (D16)** | Internal = payroll, no PO; same attributes (75/25), SLPC·SALESCOMM cost line. |
| Q3 | **RESOLVED (D11)** | SUBCON lines contribute to totals + push. |
| Q4 | **RESOLVED (D11)** | Software = SOFTWARE cost line, contributes. |
| Q5 | **(a) RESOLVED (D12)**; (b) OPEN | LR Warranty → GENO cost. (b) Example live commission PO to clone shape. |
| Q6 | OPEN | Expansion Pack +4h / Powerwall +16h — auto or manual? (Sheet: manual.) |
| Q7 | OPEN | Per-adder commission formula for §4e formula fields. |
| Q8 | **RESOLVED** | Setter line = APPT COM (sheet label "APPT COMM"). |
| Q9 | **RESOLVED (D17)** | Setter__c populated → apply Geo_Commission_Amount__c ($70 dflt). |
| Q10 | **RESOLVED (dates)** / SALESPERSO source still open | Five date fields mapped (§7); confirm SALESPERSO source (dealer/rep name field). |
| Q11 | **RESOLVED (D10, Tim-confirmed)** | Two stored fields (.04/.015), summed for the SLMC line, split for attributes. |
| Q12 | OPEN (re-harvest) | Live RS template contains REFERRAL + SOFTWARE + ENGR/SUBCON lines? BALANCE income treatment of rebate? |

## 10. Execution plan
**A — SF metadata:** deploy built package now + addendum (Internal_Rep_Commission_PPW__c ×2) + follow-up existing-field package (defaults/relabels). Then FLS.
**B — calc v2:** build to REVISED workbook (template file: `lambdas/sundial-budget/template/budget-template-v2.xlsx` = REVISED, not BRADS). Gated only on Q6 (TODO-flagged).
**C — mapping+push:** MAPPING_ROWS v3; live RS re-harvest (must show REFERRAL etc. — Q12); RSDC harvest; template selection.
**D — PO engine:** after Q2/Q5b + vendor map + sandbox hand-proof.
**E — attribute sync:** after Q10; sandbox hand-proof.
**F — frontend:** commissions v3 inputs, COST adders, D7 read-only tabs, mapping deltas, PO/attribute status display.
**Gates:** REVISED fixture green → deploy calc; reconcile 0-problems live RS + RSDC → enable push; sandbox PO proof → enable PO stage; supervised live end-to-end (one 3rd-party + one RSDC job).

## 11. Field-change log for Create Project button
- 2026-08-20 — §4a/4b/4c package BUILT, not deployed. Mapping additions pending.
- 2026-08-20 — REVISED sheet: +`Internal_Rep_Commission_PPW__c` to create AND map; Overhead/Mgr PPW fields RETAINED in mapping (D10).
- (pending) ADD to mapping: §4a ×14 + §4b ×8 Customer fields + Internal_Rep_Commission_PPW__c.
- (pending) REMOVE from mapping: CC diff list, Tim-reviewed.
- NEVER MAP: formula fields; §4c Cost fields (null = derive semantic would be destroyed by a copy).
