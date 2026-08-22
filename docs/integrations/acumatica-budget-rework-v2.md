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
| D17 | **Setter commission rule (resolves Q9):** applies when the CUSTOMER's `Setter__c` (lookup → Sundial_User__c) is populated — any setter, Geovanna today. Amount from Geo_Commission_Amount__c (default 70); empty → 0. **AMENDED 2026-08-20: Setter__c does not exist on Solar and is NOT mirrored — the calc reads through via `Sundial_Customer__r.Setter__c` in its input SOQL.** Later setter changes on the Customer flow into the next recalc automatically. | Tim + describe findings |
| D11 | **All cost lines now roll into totals** — REVISED fixes the BRADS anomaly: Job Cost J28 = SUM(J15:J25,J27) includes SUBCON Engineering (E55), SUBCON Subcontractor (E56), SOFTWARE (E60), REFERRAL (E63). GP nets them too (N13 "Total Other*" = GENO+stamps+subcon+software+referral). Resolves old Q3/Q4. | REVISED sheet |
| D12 | **GENO now includes Active Monitoring + LightReach Battery Warranty** (J16 = Material Other + CO fee + permit + E61 + E62). They are cost lines, not revenue-only. Resolves old Q5(a). | REVISED sheet |
| D13 | **REFERRAL is its own budget line**: `REFERRAL - OTHER - REFERRAL FEE` ← Referral Fee adder (500 × qty). NEW task code — the v1 sandbox scaffold (38 lines) had NO REFERRAL line; the live template must be re-harvested and MUST contain it or push fails. | REVISED sheet |
| D14 | Small System 10-12 / 13-15 remain the ONLY revenue-only adders (price affects commission side; no cost line). | REVISED sheet |
| D18 | **Live harvest results (2026-08-20, projects R261077 RS / R261066 RSDC).** (a) `SLPC OUT` has ONE space — the sheet's two-space H7 label is a typo. (b) `ENGR`, `SUBCON` and `SOFTWARE` all exist in the live template exactly as §5 guessed. (c) **`REFERRAL` does NOT exist** (D13 predicted it) — Harmon must add it before any job can push a referral fee. (d) DC rebate key is `DCREBATE · BILLING · <N/A> · Income`, and it is **the only difference between the RS and RSDC templates** (38 vs 39 lines). (e) Q12b settled by live math: **BALANCE excludes the rebate**, so the BALANCE row is unchanged. Both scaffolds are committed at `lambdas/sundial-acumatica-budget-push/harvest/` and the mapping is regression-tested against them. | Live reconcile |
| D19 | **REDLINE COMMISSION MODEL — supersedes the PPW-input model entirely.** `Total Commission ($) = Contract_Amount__c − (Redline × system watts) − Total Adder Price`. Redline by deal type × finance source: External+Lightreach **1.75**, External+other **1.85**, Internal+Lightreach **2.10**, Internal+other **2.20**. **Deal type** = INTERNAL when the sales-company field is "Harmon Solar", EXTERNAL otherwise (Customer `Sales_Company__c`, Solar `Sales_Company_Harmon_Solar_or_Third__c`) — this also **replaces D16's which-PPW-is-populated discriminator**. **Finance** = Lightreach via Customer `Financing_Partner__c` / Solar `Sales_Type_Partner__c` (note the casing differs per object: `Lightreach` vs `LightReach`; formula `=` is case-insensitive so both resolve). **Total Adder Price** = every priced adder: flat at Price×Qty, per-watt at Price×Watts×Qty, NS blocks 1-5 at the marked-up total `Material×(1+Markup/100) + Hours×33×1.75`; Referral included. Implemented as four FORMULA fields per object (`salesforce/v3-redline-commission-fields/`, **deployed 2026-08-21**) plus the Stage 2 calc rewrite (**built 2026-08-21**, §4i). **`Sales_Rep_Commission_PPW__c` and `Internal_Rep_Commission_PPW__c` are RETIRED as calc inputs** — fields stay on the objects for history, and a test pins that repopulating one changes nothing. Blank sales company **throws** (`SALES_COMPANY_MISSING`, HTTP 422) rather than defaulting to external — see the 83%-blank rollout note in §4i. | Tim, 2026-08-21 |

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
| budgetCalc.js | ✅ **DONE 2026-08-20** (branch `feat/budget-calc-v2`, build+fixture only, not deployed). Rewritten to REVISED math; test.js re-pinned to the REVISED cached values — 166 checks (86 cells / 48 fields / 14 extras / 18 behaviours), all green. HOLLAND template + fixture DELETED. |
| budget-template.xlsx | ✅ **DONE** — `template/budget-template-v2.xlsx` committed and wired into `budgetWorkbook.js` + `prebuild.mjs`; cell map rebuilt to the REVISED layout. Old template deleted. |
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

> **§4a + §4b + §4c: PACKAGE BUILT (`salesforce/v2-budget-adder-fields/`), PENDING DEPLOY — 2026-08-20.** Collision-checked clean. REVISED sheet re-checked 2026-08-20: the adder catalog is UNCHANGED from BRADS, so the built package remains fully valid. Type findings + follow-ups (NS divergence, per-watt Number(15,3), NS 1-3 markup default alignment, Upgrade_225 relabel) recorded in the package README; per-watt 3dp CONFIRMED (all real defaults land within 3dp).
> **Follow-up existing-field package additions:** Battery hours default 20→16; Structural label → "Structural-Electrical Engineer Stamp"; Sales_Rep relabel (§4d); Gateway_* relabel → Tesla Expansion Pack.

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

### 4d. Commission inputs — **REP INPUTS RETIRED BY D19 (2026-08-21)**

> ⚠️ **The two rep-PPW fields are no longer calc inputs.** Struck through below, kept for
> the record. The fields still EXIST on both objects (history), but as of Stage 2 nothing
> reads them: `handler.js` does not select them and `budgetCalc.js` does not reference
> them. A test (`the retired PPW fields are inert`) pins that — repopulating one out of
> habit changes no output.

- ~~**NEW FIELD (addendum package): `Internal_Rep_Commission_PPW__c`** — Number/Currency-per-watt, default 0, on BOTH objects (rep-entered at sale, copied by Create Project).~~ **RETIRED as an input (D19).**
- ~~`Sales_Rep_Commission_PPW__c` → RELABEL "3rd Party Rep Commission PPW" (repurposed; per-job value like 0.25).~~ **RETIRED as an input (D19).** The relabel row in `salesforce/v2-field-alignments/` is now cosmetic-only; harmless if deployed, pointless if not.
- **REPLACED BY:** `Commission_Total__c` (dollars, formula — §4h) routed by
  `Sales_Company_Harmon_Solar_or_Third__c`. See §4i for what the calc now reads.
- `Sales_Mgr_Commission_PPW__c` (.04) + `Overhead_Commission_PPW__c` (.015) RETAINED per D10; calc sums → SLMC line. **Unchanged by D19.**
- `Geo_Commission_Amount__c` ($70 rule) + `Commission_Burden_Rate__c` (75) unchanged.

**Stale field DESCRIPTIONS in already-deployed packages** (cosmetic, no behaviour):
`Internal_Rep_Commission_Amt__c` was deployed describing itself as
"`Internal_Rep_Commission_PPW__c` × watts", which is no longer how it is computed. Worth a
description-only alignment pass at some point; not worth a deploy on its own.

### 4e. Per-adder commission FORMULA fields — **CANCELLED (D19)**
The redline model makes per-adder commission rates meaningless: adders now reduce the
commission pool in aggregate (`− Total Adder Price`), so there is nothing per-adder to
compute. Q7 is obsoleted. **Replaced by §4h.**

### 4h. D19 REDLINE commission formula fields — BOTH objects (8) — **DEPLOYED 2026-08-21**
`salesforce/v3-redline-commission-fields/`, additive, collision-checked clean 2026-08-21.
All four fields verified present and readable by the integration user on both objects
after deploy; a live SOQL read returned the expected blank-propagation shape on records
with no sales company set, which is the `BlankAsBlank` post-deploy check the README asked
for, answered by real data.

| Field | Type | Meaning |
|---|---|---|
| `Commission_Redline_PPW__c` | Currency(14,4) | the $/W redline for this deal |
| `Total_Adder_Price__c` | Currency(16,2) | every priced adder, at price |
| `Commission_Total__c` | Currency(16,2) | **the rep commission in dollars** — what the calc reads |
| `Commission_Total_PPW__c` | Currency(14,4) | the derived per-watt rate |

All four are FORMULAS, so nothing writes them and they cannot drift. Object-appropriate
sources per D19. **Blank sales company ⇒ NULL, never the external rate.** `33` (Powerwall
labor rate) and `1.75` (labor + burden) are hardcoded in the NS term like the redlines
themselves — they are constants of the commission MODEL, and reading a per-job override
there would let one job's budget change what a rep is paid.

⚠️ **Do not confuse `Commission_Total_PPW__c` with the pre-existing `Commission_PPW__c`**
on both objects: that one is a calc OUTPUT covering all commissions (rep + management +
setter + burden) ÷ watts.

Compiled size was the real constraint — Salesforce inlines referenced formulas, and the
first draft of `Commission_Total_PPW__c` compiled to ~6,000 bytes (limit 5,000) because it
named `Commission_Total__c` twice. Restructured to one reference; worst case is now 3,086
bytes (62%). Figures printed by `generate.mjs`; formulas validated offline by
`verify.mjs` (20 checks), which caught a watts precedence bug on its first run.

### 4i. D19 in budgetCalc — **BUILT 2026-08-21 (Stage 2)**

The calc no longer computes the rep commission. It reads it.

**Two new inputs, two retired.** `handler.js` `INPUT_FIELDS` gains
`Commission_Total__c` and `Sales_Company_Harmon_Solar_or_Third__c`, and drops
`Sales_Rep_Commission_PPW__c` / `Internal_Rep_Commission_PPW__c`.

**Routing, by sales company alone:**

| Sales company | Deal type | Line | Burdened? |
|---|---|---|---|
| `Harmon Solar` (case-insensitive, trimmed) | Internal | SLPC · LABOR · SALESCOMM | **yes** |
| anything else non-blank | External | SLPC OUT · OTHER · M1&M2COM | no |
| **blank** | — | — | **throws `SALES_COMPANY_MISSING`** |

Case-insensitive on purpose: SF formula `=` on text ignores case, and a calc stricter
than the formula could give a record the INTERNAL redline and the EXTERNAL routing — the
right commission on the wrong line.

**Two fail-loud validations.**

| Code | When | Why not a default |
|---|---|---|
| `SALES_COMPANY_MISSING` | sales-company field blank | Defaulting to external would quietly pay the external redline on every unfilled record. The formula already returns NULL here; the calc matches it. |
| `COMMISSION_TOTAL_UNAVAILABLE` | `Commission_Total__c` blank with a non-blank company | Should be impossible from the formula, so the realistic cause is the **integration user missing Read FLS** — SOQL then omits the field silently and a $0 commission looks entirely plausible. Zero is explicitly NOT blank: a redline that eats the contract is a legitimate answer. |

Both surface as **HTTP 422 `invalid_input`** from the recalc button (added in Stage 2 —
previously any `BudgetInputError` fell through to a 500 `server_error`) and are still
written to `Budget_Calc_Error__c` by `markError`.

> ⚠️ **ROLLOUT: 3,697 of 4,474 `Sundial_Solar__c` records (83%) have a blank sales
> company**, so recalc will refuse on all of them until the field is populated. This is
> survivable only because **exactly 1 record currently has a calculated budget** — nothing
> in production depends on recalc today. Populating the field is a data task that has to
> happen before any bulk recalc.

**What did NOT change:** management (.04 + .015 summed into one SLMC line, D10), setter
(gated on `Sundial_Customer__r.Setter__c`, D17), the 75% burden and the rule about which
components it applies to. One consequence of leaving the burden rule alone is worth
stating: an **internal** deal now carries 75% burden on the whole redline commission,
which is a much bigger number than the old PPW model produced. Correct, but do not
compare a v2 figure to a v3 one and assume a bug.

**Snapshot self-consistency.** Sheet cells J7/J8 used to hold the input PPW; they now hold
the **derived** rate (`Commission_Total__c ÷ watts`) on whichever side the deal routed to,
zero on the other. Otherwise the snapshot would show a rate that does not multiply out to
the amount beside it. A test asserts `J7 × watts = K7` and `J8 × watts = K8`.

**Push-lambda guards re-verified, no code change needed.** `Commission_Deal_Type__c` is
still the v2/v3 marker and the calc still always sets it (a test pins that, since D19
changed *what* sets it). Note the marker guard tests **emptiness**, not membership: a
record calculated under the old rule can legitimately hold `None`, and it is still a v2
record. Under D19 the calc emits only `3rd Party` or `Internal`, because blank throws.
Guard 1a (both rep amounts non-zero) is now purely stale/foreign-data defence — the calc
can no longer produce that state itself. Both comments updated to say so.

**Fixture.** Non-commission cells stay pinned to the REVISED workbook's cached values;
the commission block and everything downstream is re-pinned to the D19 worked example
(contract 36502, 8,800 W, external non-Lightreach, adders 3,110 → commission **17,112**,
**$1.9445/W**). The two halves combine legitimately because the workbook and the
`Total_Adder_Price__c` formula agree on the 3,110.

> ⚠️ **GP goes NEGATIVE in the fixture (−6,136.98) and that is expected.** It is the
> workbook's COST example bolted onto the D19 COMMISSION model, and the two were never
> priced against each other: a 17,112 commission on a 36,502 contract leaves 18,420.50 to
> cover 24,557.48 of job cost. Both halves are individually correct. Do **not** tune the
> fixture's contract until GP goes positive — that unpins the cost cells from the workbook
> they came from. GP plausibility gets checked on a real record with real numbers.

Test suite: **186 checks** (88 cells / 55 fields / 16 extras / 27 behaviours), up from 175.
All old 2,200-based commission expectations removed — grep for `2200`, `2754`, `3169.5`,
`33332.5`, `8775.02` returns nothing.

### 4f. PO tracking fields — SOLAR only (draft, pending Q2/Q5b).

### 4g. Create Project mapping deltas
ADD: §4a ×14 Customer pairs, §4b ×8 Customer NS fields, `Internal_Rep_Commission_PPW__c`.
REMOVE: strictly-budget Customer fields (exact list = CC diff of customer-to-solar-map.ts vs v3 input model, Tim-reviewed). `Overhead_Commission_PPW__c`/`Sales_Mgr_Commission_PPW__c` REMAIN mapped (still inputs per D10).
NEVER MAP: formula fields, COST fields.

## 5. MAPPING_ROWS v3 — **HARVEST-VERIFIED 2026-08-20 (D18)** (`lambdas/sundial-acumatica-budget-push/index.js`)

Status per row. `harvested` = key confirmed against a live scaffold. **Every key is now
harvested (D18)** — the 2026-08-20 reconcile of R261077 (RS) and R261066 (RSDC) settled
all five that were provisional, and confirmed one line simply does not exist.

| Budget element | Task · AG · INV · Type | Amount source (v3, as coded) | Key |
|---|---|---|---|
| Income — Balance of Contract | BALANCE · BILLING · &lt;N/A&gt; · Income | `Contract_Amount__c - Total_Material_Budget__c` — **excludes the rebate**, which has its own line (Q12b) | harvested |
| Income — Solar Material | GENM · BILLING · &lt;N/A&gt; · Income | `Total_Material_Budget__c` | harvested |
| Income — DC Rebate (RSDC only) | DCREBATE · BILLING · &lt;N/A&gt; · Income | `DC_Rebate_Amount__c` | harvested — **conditional**, see below |
| 3rd-party rep commission | SLPC OUT · OTHER · M1&M2COM · Expense (**ONE space**) | `Sales_Rep_Commission_Amt__c` (third-party only now) | harvested |
| Internal rep commission | SLPC · LABOR · SALESCOMM · Expense | `Internal_Rep_Commission_Amt__c` | harvested |
| Management commission | SLMC · LABOR · SALESCOMM · Expense | `Management_Commission_Amt__c` (the .04+.015 **sum** — do not also map the components) | harvested |
| Setter commission | APPT COM · LABOR · SALESCOMM · Expense | `Setter_Commission_Amt__c` — what **applied**, not the always-70 input | harvested |
| Commission burden | BURDENEXR · LABOR · SALESCOMM · Expense | `Commission_Burden_Amt__c` | harvested |
| Audit+QA labor / hours | GENA · LABOR · RESIDENTAL · Expense | `Audit_Labor_Cost__c` (**already audit+QA**) / `GENA_Hours__c` | harvested |
| Roofing labor | ROOFCOM · LABOR · RESIDENTAL · Expense | `Roofing_Labor_Cost__c` (piece rate, no hours) | harvested |
| S1 / S2 labor + hours | S1 / S2 · LABOR · RESIDENTAL · Expense | `S1_/S2_Labor_Cost__c` + `_Hours__c` | harvested |
| S3 labor + hours | S3 · LABOR · RESIDENTAL · Expense | `S3_Labor_Cost__c` / `S3_Hours__c` | harvested |
| Labor burden | BURDENEXR · LABOR · RESIDENTAL · Expense | `Total_Labor_Burden_Budget__c` | harvested |
| Total material | GENM · MATERIAL · &lt;N/A&gt; · Expense | `Total_Material_Budget__c` | harvested |
| Other (GENO) | GENO · OTHER · &lt;N/A&gt; · Expense | `Total_Other_Budget__c` — **ONE row**, J16 group | harvested |
| Dealer fee | DLR · OTHER · &lt;N/A&gt; · Expense | `Dealer_Fee__c` — carried from v1, **not in this table before** (Q12c) | harvested |
| Engineer stamps | ENGR · SUBCON · &lt;N/A&gt; · Expense | `Engineer_Stamps_Cost__c` | harvested |
| Subcontractor | SUBCON · SUBCON · &lt;N/A&gt; · Expense | `Subcontractor_Cost__c` | harvested |
| Audit software | SOFTWARE · OTHER · &lt;N/A&gt; · Expense | `Adder_Software_Fee_Price__c * Adder_Software_Fee_Qty__c` | harvested |
| Referral fees | REFERRAL · OTHER · &lt;N/A&gt; · Expense | `Adder_Referral_Fee_Price__c * Adder_Referral_Fee_Qty__c` | **absent from the template** — conditional, see below |

### Three v1 rows that would now DOUBLE-COUNT — collapsed

The v2 field-meaning changes (`budget-v2-output-gap.md` §A) land directly on the mapping,
and each of these would have posted a silently inflated number rather than failing:

1. **GENO was three rows** (Total_Other + CO fee + permit). `Total_Other_Budget__c` is now
   the whole J16 group including CO fee and permit → **one row**.
2. **GENA summed Audit + QA.** `Audit_Labor_Cost__c` is now the whole GENA line → **one field**.
3. **SLMC + the SLPC overhead row** are now the single `Management_Commission_Amt__c`.

And GENO is deliberately **not** `Total_Other_Summary__c` (N13): that figure also contains
the four standalone lines below it, so using it would double-count those instead.

### Guards added with v3

- **`budget_calculated_by_previous_engine`** — the **rollout guard**, and it runs first.
  `Budget_Calc_Status__c = 'Calculated'` does not say WHICH engine calculated it, so a
  record last recalculated before the v2 rollout would push v1 numbers through the v3
  mapping — and do it *silently*, because every key still matches. It would post GENO
  without CO fee and permit (those lived in separate v1 fields v3 no longer reads), zero
  to the four D11 standalone lines, and nothing to SLPC OUT. `Commission_Deal_Type__c` is
  the marker: only budgetCalc v2 writes it. **`'None'` is a valid v2 value** (the calc ran
  and found neither rep PPW populated), so the test is emptiness, not "one of the three
  labels". Enforced in **two** places: `handleHttp` Gate 1b returns
  **409 `BUDGET_CALCULATED_BY_PREVIOUS_ENGINE`** — *"Budget was calculated with the
  previous engine — run Recalculate Budget first."* — so the Update Budget button fails
  immediately instead of returning 202 and failing asynchronously; and `writeBudgetLines`
  aborts as well, covering the worker, dry-run and direct-invoke paths.
- **`commission_deal_type_ambiguous`** — both rep amounts non-zero aborts before any PUT.
  Since D19 the calc routes one amount to one line and **cannot** produce this state, so
  the guard is now purely about *stored* amounts being stale or foreign (a record
  calculated under the old D16 rule, a half-finished migration, something other than the
  calc writing the fields). Skip-zero cannot catch it because neither is zero.
- **`pending_harvest_line_has_value`** — a non-zero `DC_Rebate_Amount__c` with no harvested
  key aborts rather than dropping thousands in income silently.

### Where SOFTWARE and REFERRAL amounts come from at push time

Confirmed: **price × qty, read straight off the adder fields on `Sundial_Solar__c`** —
`Adder_Software_Fee_Price__c * Adder_Software_Fee_Qty__c` and
`Adder_Referral_Fee_Price__c * Adder_Referral_Fee_Qty__c`. All four fields are in the
push's SOQL. Neither line has a dedicated output field (both were left `extras`-only in
the gap review as "trivially price × qty"), and the push reads *fields off the record*
rather than the calc's return value, so it does the multiplication itself — which is why
`*` exists in the amount-expression grammar. The product is identical to what
budgetCalc computes for a pass-through row (`cost = priceTotal = price × qty`), so the
two cannot disagree.

### Two CONDITIONAL rows (new after the harvest)

Both are `scaffoldOptional`: the line may legitimately be missing, and the row's own
`missingLineMessage` is what the abort says when it matters.

| Row | Present | Absent + amount 0 | Absent + amount > 0 |
|---|---|---|---|
| **DC rebate** (`DCREBATE`) | income-always — written even at 0 | inactive (a normal RS project) | **ABORT**: "Domestic Content is set on a project built from the RS template… must be created from the RSDC template" |
| **Referral fees** (`REFERRAL`) | n/a today | inactive (almost every job) | **ABORT**: "Acumatica template has no REFERRAL line — Harmon must add it before pushing referral fees." |

### Skip-zero now runs BEFORE the match, and that ordering is the fix

An expense row whose amount is 0 has nothing to write, so whether a line exists for it is
irrelevant. Under the old order (match, *then* skip) the missing REFERRAL line failed
**every** push — including the overwhelming majority of jobs with no referral fee.
Requiring a line you are not going to write to is not a safety property.

Applied generally to any zero expense row, with two deliberate exemptions:

- **Income is exempt.** Income-always means an income line must match or the push fails,
  even at 0 — except a `scaffoldOptional` income row (the DC rebate), which genuinely
  does not exist on RS.
- **Reconcile stays strict.** With no amounts supplied the check is purely structural, so
  every non-optional row must still match. The leniency exists only where there is
  nothing to write, and reconcile is the run whose job is to catch a broken key.

A third bucket, `inactive`, now sits alongside `matched` and `problems`: rows correctly
doing nothing on this project. Surfaced rather than swallowed, so "why is REFERRAL not in
the output" has an answer.

### Verification status

Re-verified offline against the two committed live scaffolds
(`lambdas/sundial-acumatica-budget-push/harvest/`):

| Project | Scaffold lines | Matched | Inactive | Problems |
|---|---|---|---|---|
| R261077 (RS) | 38 | **19** | DC rebate, Referral fees | **0** |
| R261066 (RSDC) | 39 | **20** (incl. `DCREBATE`) | Referral fees | **0** |

> The task brief predicted 18 / 19. The extra one is the `SLPC OUT` fix: it was one of
> the two harvest problems, so correcting the spacing moves it from `problems` into
> `matched`. 21 mapping rows = 19 matched + 2 inactive (RS), 20 + 1 (RSDC).

**Still to do before a live push:** Tim re-runs the live reconcile after merge/deploy to
confirm against the org rather than the saved dumps; Q12c (the `DLR` line); Harmon
sign-off on APPT COM; and Harmon adding a REFERRAL line if referral fees are to be pushed
at all.

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
| Q7 | **OBSOLETED by D19** | The per-adder commission question disappears: commission is now Contract − Redline×W − Total Adder Price, so adders reduce commission in aggregate rather than each earning a per-adder rate. §4e per-adder commission formula fields are **not needed and will not be built**. |
| Q8 | **RESOLVED** | Setter line = APPT COM (sheet label "APPT COMM"). |
| Q9 | **RESOLVED (D17)** | Setter__c populated → apply Geo_Commission_Amount__c ($70 dflt). |
| Q10 | **RESOLVED (dates)** / SALESPERSO source still open | Five date fields mapped (§7); confirm SALESPERSO source (dealer/rep name field). |
| Q11 | **RESOLVED (D10, Tim-confirmed)** | Two stored fields (.04/.015), summed for the SLMC line, split for attributes. |
| Q12a | **RESOLVED (D18)** | SOFTWARE + ENGR + SUBCON exist in the live template. **REFERRAL does NOT** — the mapping treats it as `scaffoldOptional`, so a job with no referral fee is unaffected, but one that HAS a referral fee aborts loudly. **Harmon action: add a REFERRAL line to the RS/RSDC templates.** |
| Q12b | **RESOLVED (D18)** | BALANCE income **excludes** the DC rebate — confirmed by the live math. The rebate posts to its own `DCREBATE` income line. No change to the BALANCE row. |
| Q12c | OPEN (Harmon) | Is the `DLR` dealer-fee expense line correct, given the calc already nets the dealer fee out of Balance of Revenue? Carried over from v1 rather than dropped, because the line exists in the live scaffold. |

## 10. Execution plan
**A — SF metadata:** deploy built package now + addendum (Internal_Rep_Commission_PPW__c ×2) + follow-up existing-field package (defaults/relabels). Then FLS.
**B — calc v2: ✅ BUILT 2026-08-20** (branch `feat/budget-calc-v2`, **build + fixture only — not deployed**, no MAPPING_ROWS or push-lambda changes). Rewritten to the REVISED workbook (`lambdas/sundial-budget/template/budget-template-v2.xlsx`, committed); cell map rebuilt to the REVISED layout; HOLLAND template + fixture deleted; `handler.js` INPUT_FIELDS updated to 112 fields incl. `Internal_Rep_Commission_PPW__c`, `Domestic_Content__c`, the 12 Cost fields, NS 4-5, and the `Sundial_Customer__r.Setter__c` read-through. **166 checks green** (86 workbook cells / 48 SF fields / 14 un-homed extras / 18 behaviours) and now wired into `npm test`. Q6 left manual, TODO-flagged in code, mirroring the sheet.
  - **DC source resolved: `Sundial_Solar__c.Domestic_Content__c`** — the only domestic-content field on the object the calc reads. ⚠️ It is an unrestricted TEXT field; parsed permissively for affirmatives and defaulting to NO. Sheet D3 is a YES/NO validation list — a picklist or checkbox would model it properly (follow-up).
  - **Gap list REVIEWED + APPROVED 2026-08-20** (`docs/integrations/budget-v2-output-gap.md`). The §D set of 8 is built as `salesforce/v2-budget-output-fields/` (additive, collision-checked, pending deploy); the other 7 values stay `extras`-only by decision. **Deploying the fields does not make the calc write them** — promoting the 8 from `extras` into the `fields` map is a small calc-side follow-up in TASKS.md.
  - **Existing-field changes packaged separately** as `salesforce/v2-field-alignments/` (**MODIFY** package, 20 fields, pending deploy): Battery hours default 0→16 and NS 1-3 markup →25 on BOTH objects (both are create-mapped, so Solar-only would be overwritten by a blank Customer value), plus the Upgrade_225 / Gateway_* relabels. `Sales_Rep_Commission_PPW__c` was **already relabelled in the UI** to "3rd Party Rep Commission $/W" and is excluded. Generated by reading each field's live definition and changing one attribute — regenerate before deploying.
  - **Field package is LIVE:** all 111 INPUT_FIELDS resolve against the org and every §4c Cost default landed (261.40 … 0.06), verified 2026-08-20.
  - **Follow-up still open:** `Battery_Install_Hours__c` default is **0** in the org, not 16 — a fresh record gets zero battery labor until someone sets it.
**C — mapping+push: 🔶 IN PROGRESS 2026-08-20** (branch `feat/mapping-v3`, build + report only, **no deploy, no live push**).
  - **MAPPING_ROWS v3 written** — 20 active rows replacing v1's 18. Four commission lines (SLPC OUT / SLPC / SLMC / APPT COM) each with ONE source; the four D11 standalone lines (ENGR / SUBCON / SOFTWARE / REFERRAL); GENM material; GENO as a **single** row; both income lines; Dealer Fee carried over. Every v1 safety rule preserved: exact literals, `RESIDENTAL` misspelling, `<N/A>` literal, sum-into-one machinery, skip-zero on expense only, income-always, fail-loud on ≠1 match.
  - **Three v1 rows would now DOUBLE-COUNT and were collapsed:** GENO was 3 rows (Total_Other + CO fee + permit) but v2's `Total_Other_Budget__c` already contains CO fee and permit; GENA was `Audit + QA` summed but v2's `Audit_Labor_Cost__c` is already both; SLMC + the SLPC overhead row are now the single `Management_Commission_Amt__c`. Each is pinned by a test named for the double-count it prevents.
  - **Setter source changed** from `Geo_Commission_Amount__c` (the input rate, always 70) to `Setter_Commission_Amt__c` (what applied — 0 with no setter). v1 would have posted 70 on every job.
  - **`*` added to the amount-expression grammar** — SOFTWARE and REFERRAL have no dedicated output field (extras-only per the gap doc), so their rows read `Price__c*Qty__c`, which is what the calc computes for a pass-through row.
  - **Two new fail-loud guards:** both rep commission amounts non-zero → `commission_deal_type_ambiguous` (D16 defense in depth — skip-zero cannot catch it because neither is zero); and a non-zero `DC_Rebate_Amount__c` with no harvested key → `pending_harvest_line_has_value` rather than silently dropping the income.
  - **HARVEST DONE 2026-08-20 (D18)** — all five provisional keys resolved against live scaffolds R261077 (RS, 38 lines) and R261066 (RSDC, 39). `SLPC OUT` has ONE space (the sheet's two-space label is a typo); ENGR / SUBCON / SOFTWARE exist as guessed; **REFERRAL does not exist at all**; DC rebate is `DCREBATE · BILLING · <N/A> · Income` and is the only RS↔RSDC difference. Both dumps are committed and regression-tested.
  - **Skip-zero now runs BEFORE the ≠1-match check** for expense rows, so a template that lacks a line no job needs cannot fail every push. Income stays exempt, and reconcile stays structurally strict. Two rows are `scaffoldOptional` (DC rebate, Referral) — absent + zero is inactive; absent + non-zero aborts with a message naming the actual fix.
  - Offline re-verify: **RS 19 matched / 2 inactive / 0 problems; RSDC 20 matched / 1 inactive / 0 problems.**
  - **23 tests added** (the Lambda had none); suite 316 green.
  - **GATE: the harvest has run and both scaffolds reconcile clean offline.** Remaining before a live push: Tim re-runs the live reconcile after merge/deploy (to confirm against the org, not the saved dumps), Q12c on the `DLR` line, Harmon sign-off on APPT COM, and Harmon adding a REFERRAL line if referral fees are ever to be pushed.
**C (remaining):** RSDC template selection; MAPPING_ROWS freeze after the harvest.
**D — PO engine:** after Q2/Q5b + vendor map + sandbox hand-proof.
**E — attribute sync:** after Q10; sandbox hand-proof.
**F — frontend:** commissions v3 inputs, COST adders, D7 read-only tabs, mapping deltas, PO/attribute status display.
  - **⚠️ PREREQUISITE — four existing output fields CHANGED MEANING in v2** (`budget-v2-output-gap.md` §A/§E). A Budget UI still on v1 semantics shows **zero commission on every internal deal**, **double-counts CO fee + permit** (`Constructive_Ops_Total__c` is now a *subset* of `Total_Other_Budget__c`), **double-counts QA** (`Audit_Labor_Cost__c` is now audit+QA), and understates labor (`Total_Labor_Budget__c` excludes burden; use `Total_Labor_And_Burden__c`). None of these throws — they all render a plausible wrong number on a margin screen. Read §A before touching the Budget UI.
**Gates:** REVISED fixture green → deploy calc; reconcile 0-problems live RS + RSDC → enable push; sandbox PO proof → enable PO stage; supervised live end-to-end (one 3rd-party + one RSDC job).

## 11. Field-change log for Create Project button
- 2026-08-20 — §4a/4b/4c package BUILT, not deployed. Mapping additions pending.
- 2026-08-20 — REVISED sheet: +`Internal_Rep_Commission_PPW__c` to create AND map; Overhead/Mgr PPW fields RETAINED in mapping (D10).
- (pending) ADD to mapping: §4a ×14 + §4b ×8 Customer fields + Internal_Rep_Commission_PPW__c.
- (pending) REMOVE from mapping: CC diff list, Tim-reviewed.
- NEVER MAP: formula fields; §4c Cost fields (null = derive semantic would be destroyed by a copy).
