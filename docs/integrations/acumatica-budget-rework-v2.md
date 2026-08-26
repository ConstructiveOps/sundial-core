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
| D4 | **RESOLVED 2026-08-22 — map delivered.** `docs/integrations/dealer-vendor-map.csv` (53 rows) is the source of truth; `scripts/generate-dealer-vendors.mjs` emits `lib/acumatica-dealer-vendors.js` and `--check` fails a stale build. Lookup **trims then matches EXACTLY** — deliberately stricter than the tax-zone map, because these are picklist values rather than typed free text, so a near-miss is a signal not a spelling. Four distinct refusals, never a guess: `internal` (Harmon Solar — belt-and-braces behind the deal-type gate, D16), `inactive` (Derek Anderson → vendor 01863, fails loudly per the original rule), `unmapped`, `blank`. Ten dealers carry two picklist spellings each, intentionally mapped to one VendorID. **⚠ Coverage: 35 of 56 active picklist values resolve; 19 are unmapped and 128 existing Solar records carry one** — `scripts/verify-dealer-vendor-coverage.mjs` lists them. | Tim + vendor export |
| D5 | Attributes are BOTH lifecycle dates and commission milestone amounts — confirmed by live pull (§7). Attribute sync ties into the budget/PO update path. | Live pull, confirmed |
| D6 | Existing adder Price/Qty fields on Customer + Solar are PRICE (commission-side). New COST fields (Solar only) feed the budget. Quantities shared. | Tim, confirmed |
| D7 | After a Solar record exists, SOLAR is the source of truth for adders + commissions; Customer page shows read-only Solar values, editable Customer fields hidden. | Tim, confirmed |
| D8 | Connection/auth/infra unchanged and proven. Mapping + math + field-model rework. | Tim |
| D9 | **Commission model v3 (from REVISED sheet):** two separate rep inputs — 3rd-Party Rep PPW → `SLPC OUT · OTHER · M1&M2COM`, Internal Rep PPW → `SLPC · LABOR · SALESCOMM`. Management (Ralph & Daniel) COMBINED at 0.055 PPW → `SLMC · LABOR · SALESCOMM`. Geo $70 flat → `APPT COM`. ~~Burden 75% × (internal + mgmt + geo); 3rd-party NOT burdened.~~ **AMENDED BY D21: burden is 75% × (mgmt + geo) only — neither rep line is burdened.** This resolves old Q1 and the Ralph/Daniel routing suspicion. | REVISED sheet |
| D10 | **CONFIRMED (Tim 2026-08-20). Management PPW stays as TWO stored inputs** (Sales_Mgr .04 + Overhead .015); the calc sums them to the single SLMC cost line (0.055), while attributes break them apart (MGRCOM* from .04, MGMTOR* from .015). | Tim + attribute pull |
| D15 | **Cost fields get STATIC DEFAULT VALUES in SF** (supersedes the null-=derive design): more visible and admin-editable. The calc ALWAYS reads the Cost field (never derives). Semantics: flat adders = per-UNIT cost (calc × qty); per-watt adders = per-watt cost (calc × watts when selected). Consequence: changing a job's PRICE does not auto-move its COST — the user adjusts both if needed. Defaults computed from the sheet derivation, see §4c. | Tim, 2026-08-20 |
| D16 | **Internal deals: payroll only, NO POs** (resolves Q2). They share the SAME attributes as 3rd-party deals (SLSCOM1/2 filled with the internal 75/25 split) but hit the SLPC·SALESCOMM cost line. Deal type determined by which rep PPW is populated: 3rd-party PPW > 0 → 3rd-party (POs, capped M1 split); Internal PPW > 0 → internal (no PO, 75/25). Both populated = validation error, fail loudly. | Tim, 2026-08-20 |
| D17 | **Setter commission rule (resolves Q9):** applies when the CUSTOMER's `Setter__c` (lookup → Sundial_User__c) is populated — any setter, Geovanna today. Amount from Geo_Commission_Amount__c (default 70); empty → 0. **AMENDED 2026-08-20: Setter__c does not exist on Solar and is NOT mirrored — the calc reads through via `Sundial_Customer__r.Setter__c` in its input SOQL.** Later setter changes on the Customer flow into the next recalc automatically. | Tim + describe findings |
| D11 | **All cost lines now roll into totals** — REVISED fixes the BRADS anomaly: Job Cost J28 = SUM(J15:J25,J27) includes SUBCON Engineering (E55), SUBCON Subcontractor (E56), SOFTWARE (E60), REFERRAL (E63). GP nets them too (N13 "Total Other*" = GENO+stamps+subcon+software+referral). Resolves old Q3/Q4. | REVISED sheet |
| D12 | **GENO now includes Active Monitoring + LightReach Battery Warranty** (J16 = Material Other + CO fee + permit + E61 + E62). They are cost lines, not revenue-only. Resolves old Q5(a). | REVISED sheet |
| D13 | **REFERRAL is its own budget line** ← Referral Fee adder (500 × qty). ~~`REFERRAL - OTHER - REFERRAL FEE`; the live template must be re-harvested and MUST contain it or push fails.~~ **SUPERSEDED BY D20** on both counts: the key is `GENO · OTHER · REFERRAL`, and Harmon is NOT adding the line to the templates — the push creates it. | REVISED sheet |
| D14 | Small System 10-12 / 13-15 remain the ONLY revenue-only adders (price affects commission side; no cost line). | REVISED sheet |
| D18 | **Live harvest results (2026-08-20, projects R261077 RS / R261066 RSDC).** (a) `SLPC OUT` has ONE space — the sheet's two-space H7 label is a typo. (b) `ENGR`, `SUBCON` and `SOFTWARE` all exist in the live template exactly as §5 guessed. (c) **`REFERRAL` does NOT exist** (D13 predicted it) — ~~Harmon must add it before any job can push a referral fee~~ **and never will: D20 has the push create it instead.** (d) DC rebate key is `DCREBATE · BILLING · <N/A> · Income`, and it is **the only difference between the RS and RSDC templates** (38 vs 39 lines). (e) Q12b settled by live math: **BALANCE excludes the rebate**, so the BALANCE row is unchanged. Both scaffolds are committed at `lambdas/sundial-acumatica-budget-push/harvest/` and the mapping is regression-tested against them. | Live reconcile |
| D19 | **REDLINE COMMISSION MODEL — supersedes the PPW-input model entirely.** `Total Commission ($) = Contract_Amount__c − (Redline × system watts) − Total Adder Price`. Redline by deal type × finance source: External+Lightreach **1.75**, External+other **1.85**, Internal+Lightreach **2.10**, Internal+other **2.20**. **Deal type** = INTERNAL when the sales-company field is "Harmon Solar", EXTERNAL otherwise (Customer `Sales_Company__c`, Solar `Sales_Company_Harmon_Solar_or_Third__c`) — this also **replaces D16's which-PPW-is-populated discriminator**. **Finance** = Lightreach via Customer `Financing_Partner__c` / Solar `Sales_Type_Partner__c` (note the casing differs per object: `Lightreach` vs `LightReach`; formula `=` is case-insensitive so both resolve). **Total Adder Price** = every priced adder: flat at Price×Qty, per-watt at Price×Watts×Qty, NS blocks 1-5 at the marked-up total `Material×(1+Markup/100) + Hours×33×1.75`; Referral included. Implemented as four FORMULA fields per object (`salesforce/v3-redline-commission-fields/`, **deployed 2026-08-21**) plus the Stage 2 calc rewrite (**built 2026-08-21**, §4i). **`Sales_Rep_Commission_PPW__c` and `Internal_Rep_Commission_PPW__c` are RETIRED as calc inputs** — fields stay on the objects for history, and a test pins that repopulating one changes nothing. Blank sales company **throws** (`SALES_COMPANY_MISSING`, HTTP 422) rather than defaulting to external — see the 83%-blank rollout note in §4i. | Tim, 2026-08-21 |
| D20 | **THE REFERRAL LINE IS CREATED BY THE PUSH, NOT ADDED TO THE TEMPLATE — supersedes D13's template-ask.** Harmon will not add a REFERRAL line to the RS/RSDC templates. Authoritative line spec: ProjectTaskID **`GENO`** · AccountGroup **`OTHER`** · InventoryID **`REFERRAL`** · Description **"Referral Fee"** · UOM **`EA`** · Currency USD · no default qty or rate. **The mapping key therefore CHANGES from `REFERRAL · OTHER · <N/A>` to `GENO · OTHER · REFERRAL · Expense`** — a distinct InventoryID, so no collision with the `GENO · OTHER · <N/A>` other-costs sum row; they are two lines under one task. Three branches: present → update by guid; absent + 0 → inactive (the overwhelmingly common case); absent + non-zero → **create, then re-read and VERIFY before reporting success**, after which a re-push is an ordinary update. **This is the ONLY line the integration may ever create**, guarded on the exact key. **Gate OPENED 2026-08-22** after the sandbox hand-proof passed all five checks against project `R261065` (`acumatica-referral-line-create-runbook.md` §Results): PUT-without-id inserts, and `AccountGroup`/`Type` come back `OTHER`/`Expense` **derived from the REFERRAL item's posting class** and agreeing with the mapping — so no key change was needed. `CREATE_GATE.enabled` is a repo constant, not an env var, and a test asserts its committed value so a change in either direction is a visible diff. | Harmon / Tim, 2026-08-22 |
| D21 | **COMMISSION BURDEN = 75% × (management + setter) ONLY.** **Neither rep line is burdened** — not the external one (never was) and **not the internal redline commission** either. This **amends D9 and the D19 Stage 2 implementation**, both of which burdened the internal rep amount, and it **supersedes the REVISED sheet's J12**, whose burden array includes K8 (the internal rep cell). The sheet is not to be "restored" here: under the redline model the internal rep amount is an order of magnitude larger than when that array was written, and Harmon has ruled. Effect on the fixture job: internal-deal burden 10,939.50 → **415.50**, identical to the same job sold externally. Nothing else moves — the external worked example was already 75% × (mgmt + setter). | Harmon / Tim, 2026-08-22 |
| D22 | **COMMISSION PO SHAPE — from the live specimen** (PO 016102 · project R261078 · vendor 02118, 2026-08-22). One PO **per milestone payment**: Type `Normal`, VendorID from the D4 map, and a **single Non-Stock detail line** — InventoryID `M1&M2COM`, OrderQty 1, UOM `EA`, `UnitCost = ExtendedCost =` the payment amount, line-level `Project` + `ProjectTask` `SLPC OUT`, LineDescription `Outside Sales commissions`. **Account 5450 / Subaccount 02 / TaxCategory LABSERV / Warehouse MAIN / Location MAIN / Terms 30D / Branch HARMON are DERIVED** from the item and vendor, so the create body is built MINIMAL and the derived values are VERIFIED against the specimen on re-read — sending them would put a second, silently-drifting copy of Harmon's item configuration in the repo. **M1/M2 identity is the Description** (`Sales Commission M1 — <ProjectID>`), which is a LABEL: idempotency is the OrderNbr stored in Salesforce, **never a description scan**. **Freeze rule reads header Status** — `Open`/`On Hold` updatable by PUT with header guid + line id; `Completed`/`Closed`/`Cancelled` frozen, delta lands in M2 (§6). | Harmon / Tim, 2026-08-22 |

| D23 | **BOTH COMMISSION POs ARE RAISED ON THE FIRST BUDGET PUSH, AND THE TWO MILESTONE DATES ARE CARGO RATHER THAN GATES — resolves Q13 and corrects §6's reading.** §6 originally described M1 as firing "at Site Audit Complete" and M2 "at Glass on Roof", which made naming those fields a gating question. Harmon's actual workflow, confirmed as already-built behaviour: **both POs are created on the first budget push and updated by every later push until Acumatica freezes them.** Nothing waits on a date; a job with neither date set still gets both POs. What Q13 settles is which date each PO **carries**: **M1 → `Audit_Date_and_DateTime__c`, M2 → `Scheduled_Install_Date__c`** — the same two fields that already feed the `AUDITDATE` and `INCOMDATE` attributes (§7), so the PO and the attribute sync cannot disagree about when a milestone happened. Written to the PO's **line-level `Requested` + `Promised`** (both, because the specimen keeps them equal). **A blank date sends nothing**, leaving Acumatica to default them to the order date exactly as on every hand-typed PO — which is the ordinary case on a first push, since the audit is usually not done and the install not scheduled. A blank date also never CLEARS a date already on the PO. Dates we send are **verified on re-read** as something we asked for, not accepted as derived. Live probe 2026-08-24 (`scripts/probe-po-date-fields.mjs`): the header exposes `Date` / `PromisedOn` and the line `Requested` / `Promised`; on specimen 016102 all four equal the order date, so the specimen shows the default, not a Harmon preference. | Harmon / Tim, 2026-08-24 |

| D24 | **A PARTIAL `Attributes` PUT MERGES — the omit-blanks builder stands, and the sync VERIFIES BY RE-READ.** Hand-proof 2026-08-24 on `R261065` (`acumatica-attribute-sync-runbook.md` §Results). Writing one attribute left the other ten untouched, so a sync that omits blanks can never erase a value it has no information about — **no read-modify-write cycle is needed** and `lib/acumatica-attributes.js` is correct as built (15 tests, unchanged). Three further facts: (a) a PUT can **CREATE** an attribute the project does not yet carry — 4 of the 14 were absent, not blank, and the run added all four — but only where the project's template defines it; (b) an **unknown `AttributeID` returns 200 and is silently discarded**, so a template change would quietly stop an attribute updating with nothing in the response saying so — **the sync must therefore re-read and compare what it sent, and compare dates by DATE PART** (`2026-07-14` is echoed as `2026-07-14 00:00:00.000`, so a string comparison would report every date as failed); (c) sending `''` **clears** a value, which is what makes "omit" and "send empty" meaningfully different. `SALESPERSO` accepts free text (`Familia Sicairos` was written over `Property Upgrades`), so it is **not** a controlled selector and needs no value-list mapping. ISO dates are accepted as sent — `formatAttributeValue` needs no change. **Q17 resolved the same day: PAD to Harmon's convention** — money 2dp, KW 3dp (`ATTRIBUTE_DECIMALS`). **The verify-by-re-read is approved and built** (`verifyAttributeWrite`, date-part comparison); the silent-200 is recorded as a **standing hazard**, not a one-off finding. **⚠️ Flag to Harmon before this ships:** R261065's `SLSCOM1/2` held `1538.00`/`2138.00`, matching neither commission rule — Harmon hand-enters these attributes today. On integration-managed jobs **the sync is authoritative and will overwrite them**, which is intended and is a behaviour change they should hear about from us rather than notice. | Live hand-proof, 2026-08-24 |

| D25 | **BOTH WRITE GATES OPEN, STAGES B AND E WIRED INTO THE PUSH WORKER — and the PO freeze rule is the ONLY freeze that exists.** 2026-08-24, reviewed commit (ADR **D-060**). `PO_GATE.enabled = true`, `ATTR_GATE.enabled = true`; `runDownstreamStages` runs commission POs then attributes after a **successful** budget write — a PO raised against a budget that failed to push is a payment authorised for numbers that are not in the plan. **The step 8 re-run put a PUT into a CANCELED purchase order and got `200` with the change PERSISTED**, so `UPDATABLE_STATUSES` is not us mirroring an ERP rule, it is the entire rule: the check is **deny-by-default** (unrecognised/empty/null/missing status ⇒ frozen), tests assert it is unbypassable, and **only `Canceled` was tested** — every status off the allow-list is never-touch regardless. Spelling corrected while pinning it: Acumatica sends **`Canceled`** (one L) and `FROZEN_STATUSES` had said `Cancelled`, matching nothing — harmless only because that list is documentation and never the guard. **Step 7's duplicate probe is buggy** (28 on both runs = the vendor's whole PO history); ruled a runbook defect, not a gate blocker, because idempotency is the stored OrderNbr and never a scan — **an accepted residual risk, so the first-live-job watch is the compensating control: exactly one PO per milestone per project, ever.** A downstream failure leaves `Budget_Push_Status__c = 'Pushed'` (the budget DID push) with the problem in `Budget_Push_Error__c`; internal deals and zero commissions are not problems; neither stage may throw past the wrapper. **Known gap shipped knowingly:** the attribute stage has no status/error fields of its own, so its failures live in that shared note and CloudWatch. | Harmon / Tim, 2026-08-24 |

| D26 | **ATTRIBUTE-ONLY SYNC PATH FOR LEGACY / NON-BUDGETED PROJECTS — one gate, a restricted attribute set, and the deferred observability fields built.** New mode on the budget-push Lambda (ADR **D-061**): `POST /projects/{recordId}/budget/attributes-sync` (JWT + tenant, `scripts/wire-attributes-sync-route.ps1`) plus a direct-invoke equivalent (`{ attributesSync: true, recordId }`). **The ONLY gate is a linked `Acumatica_Project_ID__c`** — no `Budget_Calc_Status__c` check, no `Commission_Deal_Type__c` guard, no deal-type logic, because those exist to stop a wrong BUDGET being posted and this path posts none; a legacy record legitimately has neither, and refusing it for that would refuse exactly the records this serves. **Writes `NON_COMMISSION_ATTRIBUTES` only** — the five lifecycle dates + `KW` + `SALESPERSO`, populated-only. **Never** `SLSCOM*`/`MGRCOM*`/`MGMTOR*`, and never `JOBTYPE`. **Three independent things protect a legacy project's hand-entered figures:** (1) SCOPE — the commission attributes are never in the body, and the filter lives inside `buildProjectAttributes` so a caller cannot forget it; (2) MERGE — a partial PUT leaves what it did not send alone (D24); (3) OMIT-BLANKS — an empty record sends nothing rather than `""`. Any one would do; together the path is incapable of disturbing a figure Harmon typed in. **Verify-by-re-read is mandatory here too** — the silent-200 hazard does not care which path is writing. **SYNCHRONOUS**, unlike the push: five round trips, nowhere near the ~29s cap, and async would cost the caller an immediate answer for nothing. **Closes the D-060 observability gap:** `Attribute_Sync_Status__c` / `Attribute_Sync_Error__c` / `Attribute_Synced_At__c` (`salesforce/v5-attribute-sync-fields/`), written by **both** this path and the push worker's Stage E from **one** mapping function, so they cannot describe the same outcome differently. `Unverified` is deliberately distinct from `Failed`; `Attribute_Synced_At__c` means last-known-good and does not move on failure. **No gate on this path** — it writes only attributes, the proven-safe mechanic. | Harmon / Tim, 2026-08-24 |
| D27 | **BATTERIES AND TESLA EXPANSION PACKS ARE PRICED AS ADDERS, OUTSIDE THE REDLINE — amends D19.** Storage is sold outside the `Redline × watts` model, so nothing in `Redline × watts` accounts for it. Until now its price was not deducted anywhere, and **every battery deal's commission was overpaid by the full battery + expansion price**. Two terms are added to `Total_Adder_Price__c` on BOTH objects: `Battery_Unit_Price__c × Battery_Qty__c`, and `Tesla_Expansion_Pack_Unit_Price__c ×` the **object-appropriate** qty — Customer `Tesla_Expansion_Pack_Qty__c`, **Solar `Gateway_Qty__c`**. ⚠️ **The Solar `Tesla_* price × Gateway_* qty` pairing is deliberate**: `Gateway_*` IS the expansion pack on Solar (§3 reuse — its label is "Tesla Expansion Pack Qty", `budgetCalc` reads it, the Create Project map writes it), while Solar's `Tesla_Expansion_Pack_Quantity__c` is an orphan nothing maintains; repointing the formula at the matching name would price every expansion pack at **zero**. `Commission_Total__c` and `Commission_Total_PPW__c` need no source edit (they inline `Total_Adder_Price`); worst compiled size 3,086 → **3,229 bytes** of 5,000. Price fields are Currency(16,2), defaults **9,950** / **7,900**, created via Setup UI on both objects 2026-08-24. The **cost** side was already complete and is unchanged. Field defaults only apply to NEW records, so existing records were **backfilled** (`scripts/backfill-storage-adder-prices.mjs`, 29 records, 2026-08-24). | Tim, 2026-08-24 |
| D28 | **PER-WATT ADDER PRICES ABOVE $10/W ARE A HARD ERROR IN THE CALC.** The four per-watt adder prices (`Conduit_Attic`, `Flat_Roof`, `Roof_Tile`, `Bird_Blocking`) multiply by **watts**, so a flat dollar total typed into one is a factor-of-thousands error, not a rounding one — the root cause of the $2.5M incident on `a1P7y00000AlufJEAR` (Brian Peters) was exactly that, a flat amount in `Adder_Roof_Tile_Price__c`. **Data, not formula.** `budgetCalc` now throws `BudgetInputError` / `PPW_PRICE_IMPLAUSIBLE` naming the field and value. Deliberately an **ERROR, not a warning** (unlike the Aurora escalation-fraction case, where the ambiguity is genuine): a recalc that carried on would post an indefensible commission. Real values are cents — $0.10/W is typical. The guard covers all four despite them spanning two lists in the calc (`Bird_Blocking` is a SUBCON adder with `priceKind: 'ppw'`); deriving the list from `PPW_ADDERS` alone would leave the one shape it must not miss unguarded. | Tim, 2026-08-24 |
| D29 | **A SALESFORCE Percent FIELD HAS THREE DOMAINS AND THEY DISAGREE — see D-063.** Measured on a live record by `scripts/probe-percent-field-domain.mjs`: metadata `<defaultValue>` is **decimal** (25% = `0.25`), REST/SOQL is **display** (25% = `25`), a **formula** reference is **decimal** again (25% = `0.25`). So `<defaultValue>25</defaultValue>` on the five `NS_Adder_N_Markup_Percent__c` fields meant **2500%**, and every record created since stored `2500` — invisible because Setup renders the expression back as "25". Two errors then cancelled: the `Total_Adder_Price__c` formula's `Markup/100` saw `25` (2500 ÷ 100) and produced the correct `1.25` by accident. **Fixing either side alone is worse than fixing neither** (data-only → `1.0025`; formula-only → `26`), so: the formula's `/100` is REMOVED, `budgetCalc` KEEPS its `/100` (it reads the display domain), the defaults become `0.25`, and the data fix (`scripts/fix-ns-markup-percent-domain.mjs`, 7 records, 2026-08-24) ran FIRST. Customer's markup fields widened `Percent(6,3)` → `Percent(18,4)` to match Solar. Guarded by `NS_MARKUP_IMPLAUSIBLE` (>100%). Exposure was nil — all 7 affected records had zero NS material. | Tim, 2026-08-24 |
| D30 | **THE PERCENT-DOMAIN CLASS IS AUDITED, NOT CHASED — D-063a.** Two more instances of D29 on `Sundial_Solar__c`: `Labor_Burden_Rate__c` and `Commission_Burden_Rate__c` shipped with `<defaultValue>75</defaultValue>` = **7500%**, on **4,473 of 4,474** records. Unlike the markup case **nothing cancelled it** — `budgetCalc` divides by 100 once and correctly, so 7500 becomes a **75.0 multiplier**, every burden figure 100x too large. It never bit only because exactly ONE Solar record has ever completed a budget calc and it holds the correct 75. Fixed: defaults → `0.75` via `v2-field-alignments`, 4,473 records → 75, and `BURDEN_RATE_IMPLAUSIBLE` throws above 100% before either rate becomes a multiplier. **`scripts/audit-percent-field-defaults.mjs` now sweeps every Percent field on every Sundial object** (metadata AND data, non-zero exit on a suspect) — it found **six more instances on `Sundial_Roofing__c`** that nobody was looking for (`Burden_Rate__c` 20→2000%, `Labor_Markup_Percent__c` 35→3500%, `Material_/Other_Markup_Percent__c` 30→3000%, `Commission_Markup_Percent__c` 20→2000%, `Commission_Rate_Percent__c` 2.5→250%), fixed by Tim in Setup. `Customer.Proposed_Offset__c` is an exempted false positive — over-production above 100% is real. Roofing has no calc engine yet; **its burden/markup guards ship with that work**. | Tim, 2026-08-24 |

## 1. What survives from v1 (do not rebuild)

- lib/acumatica.js (auth, GET/PUT helpers), secret `sundial/acumatica/connected-app` (**a POINTER — see below**), API Gateway routes, CORS.

> ### ⚠️ `sundial/acumatica/connected-app` is a pointer, not a tenant (Q15, 2026-08-24)
>
> **Never describe it as "the live secret" or "the sandbox secret".** It is one secret name
> whose *contents* change: it holds **BizRun (the sandbox)** through the rework, and is
> repointed at **live** at the end of the release window. Nothing in the repo needs editing
> when that happens, which is the point — and is also exactly why a doc that names a tenant
> here goes stale silently. This line previously said "(live-tenant)" while
> `acumatica-budget-push.md` called the same secret the sandbox; both were describing a
> moving value as if it were fixed.
>
> **To find out which tenant you are on, read the credential**, which names its own tenant
> because Acumatica suffixes the ROPC `client_id` with it:
>
> ```powershell
> "tenant : $($secret.client_id.Split('@')[-1])"    # "BizRun Tenant" = sandbox
> ```
>
> Every runbook's step 2 does this. **`BizRun Tenant` is the sandbox** — the original
> handoff fact, and the 2026-08-24 hand-proof writes were confirmed in both UIs.
- ProjectBudget write machinery: fresh filter-read → 4-part-key match → PUT-by-guid; sum-into-one-line; skip-zero on expense lines; income always written; fail-loud on 0 lines or ambiguous key; backoff; per-PUT logging; dryRun.
- Async push pattern (202 → self-invoke worker → SF status write-back). Re-push idempotent.
- Unified Create Project button (3-state), recalc button, Update Budget button, snapshot→S3→Files/XFiles/Dropbox chain, Supabase metadata registration.
- Layer-1 push incl. tax zones, skip-guards, RESIDENT. The one outstanding change — RS/RSDC template selection — is now **DONE 2026-08-26** (see §2 and §8).
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
| resolveProjectTemplate | ✅ **DONE 2026-08-26** (branch `fix/rsdc-template-selection`, not deployed). `PROJECT_TEMPLATE_MAP` gains `residential_solar_dc: "RSDC"`; the project type is chosen per record by `isDomesticContentEligible(cust)` — `Sundial_Customer__c.Domestic_Content_Eligible__c` trimmed + case-insensitive `= "Yes"` → **RSDC**, anything else ("No", blank, null) → **RS**. `Domestic_Content_Eligible__c` is added to `CUSTOMER_FIELDS` (the existing customer SOQL — no second query), and the response carries `summary.project.domesticContentEligible` next to `summary.project.templateId` so a wrong template is diagnosable from the button response alone. See §8 for the root cause. |

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
| `Total_Adder_Price__c` | Currency(16,2) | every priced adder, at price — **incl. storage since D27** |
| `Commission_Total__c` | Currency(16,2) | **the rep commission in dollars** — what the calc reads |
| `Commission_Total_PPW__c` | Currency(14,4) | the derived per-watt rate |

**Storage price fields (D27) — created via Setup UI 2026-08-24, both objects, verified
present + readable by the integration user with a live describe before any code changed:**

| Field | Type | Default | Multiplied by |
|---|---|---|---|
| `Battery_Unit_Price__c` | Currency(16,2) | 9,950 | `Battery_Qty__c` (both objects) |
| `Tesla_Expansion_Pack_Unit_Price__c` | Currency(16,2) | 7,900 | Customer `Tesla_Expansion_Pack_Qty__c` · **Solar `Gateway_Qty__c`** |

⚠️ Solar's `Tesla_Expansion_Pack_Quantity__c` is **not** used — orphan field, nothing
maintains it. See D27 and the package README.

All four are FORMULAS, so nothing writes them and they cannot drift. Object-appropriate
sources per D19. **Blank sales company ⇒ NULL, never the external rate.** `33` (Powerwall
labor rate) and `1.75` (labor + burden) are hardcoded in the NS term like the redlines
themselves — they are constants of the commission MODEL, and reading a per-job override
there would let one job's budget change what a rep is paid. **D27 adds the two storage
terms** to `Total_Adder_Price__c` on both objects.

⚠️ **Do not confuse `Commission_Total_PPW__c` with the pre-existing `Commission_PPW__c`**
on both objects: that one is a calc OUTPUT covering all commissions (rep + management +
setter + burden) ÷ watts.

Compiled size was the real constraint — Salesforce inlines referenced formulas, and the
first draft of `Commission_Total_PPW__c` compiled to ~6,000 bytes (limit 5,000) because it
named `Commission_Total__c` twice. Restructured to one reference; worst case is now
**3,229 bytes (65%)** after D27's storage terms (3,086 / 62% before them). Figures printed
by `generate.mjs`; formulas validated offline by `verify.mjs` (**30 checks**), which caught
a watts precedence bug on its first run.

`generate.mjs` also calls `assertFieldLimits()` (`salesforce/field-limits.mjs`) as of
2026-08-24 — v3 predated that guard, and D27's storage sentence immediately pushed
`Total_Adder_Price__c`'s description to 1,082 characters against a 1,000 limit. Caught at
build time rather than by a failed Workbench deploy, which is what the guard exists for.
The descriptions now sit at 936 / 970 and the generator flags them `(tight)`.

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

**What did NOT change:** management (.04 + .015 summed into one SLMC line, D10) and
setter (gated on `Sundial_Customer__r.Setter__c`, D17).

---

### 4j. Storage on the price side + the per-watt sanity guard — **BUILT 2026-08-24**

Two changes to `budgetCalc.js`, implementing D27 and D28.

**D27 — storage in `stdPriceTotal` (the K39 rollup), PRICE SIDE ONLY.**

```
batteryPriceTotal   = Battery_Unit_Price__c            × Battery_Qty__c
expansionPriceTotal = Tesla_Expansion_Pack_Unit_Price__c × Gateway_Qty__c
stdPriceTotal      += batteryPriceTotal + expansionPriceTotal
```

`handler.js` `INPUT_FIELDS` gains the two price fields. The joint this preserves is the
one the fixture documents: **the workbook and the Salesforce `Total_Adder_Price__c`
formula must agree on the adder total**, or the snapshot and the commission actually paid
tell two different stories. A test asserts `cells.K39 === extras.stdAdderPriceTotal` and
that both land on the formula's figure.

> ⚠️ **The cost side is complete and was NOT touched.** `Battery_Unit_Cost__c × Qty` and
> `Gateway_Unit_Cost__c × Qty` already flow to material (F16 / F14), and battery labor and
> burden already flow through F32/F33. Adding cost here would double-count. A test pins
> that setting a storage PRICE alone moves neither `Total_Job_Cost__c` nor
> `Total_Material_Budget__c`.

**Where the snapshot and the sheet intentionally differ.** The REVISED workbook has
battery/gateway **cost** parameters (B11/C11, B13/C13) but **no adder price row** for
storage — the storage price is a commission-model concept the spreadsheet never had. So
the two terms go straight into the **K39** rollup with no matching `B`/`C`/`D` row. K39 in
a Sundial snapshot can therefore exceed the sum of the adder rows above it, by exactly
`battery + expansion price`. `extras.batteryPriceTotal` / `expansionPriceTotal` /
`storagePriceTotal` break the figure out so it never has to be reverse-engineered.

**FLS note.** Unlike `Commission_Total__c`, a missing Read grant on the two price fields
fails **quietly** — SOQL omits the field, the price reads 0, and the adder total merely
understates. `scripts/probe-battery-adder-fields.mjs` is the describe gate that catches it.

**D29 — the NS markup percent domain.** `budgetCalc` reads Salesforce through SOQL, where
a Percent field arrives in the **display** domain (a true 25% is `25`), so its
`markup = g(...) / 100` is correct and must stay. The Salesforce `Total_Adder_Price__c`
formula receives the same field in the **decimal** domain (`0.25`) and therefore has **no**
`/100` — that asymmetry is real and measured, not a discrepancy to tidy. Both layers land
on a `1.25` multiplier for a true 25%, and tests on both sides assert it in their own
layer's units (`0.25` in `verify.mjs`, `25` in `test.js`).

`NS_MARKUP_IMPLAUSIBLE` throws above **100%**, before any adder maths, gated on the markup
alone. 100 rather than something tighter because Harmon does use markups above the 25%
default; 100% is not a pricing judgement, it is "this is not a percentage".

**D30 — `BURDEN_RATE_IMPLAUSIBLE`.** Both burden rates are guarded above **100%**, checked
*before* either is read into a multiplier — they feed almost every cost line, so an
implausible one does not produce a localised wrong number, it moves the whole budget. Same
REST/display domain as everything else the calc reads: a true 75% arrives as `75`, and the
`/100` on both stays.

**D28 — `PPW_PRICE_IMPLAUSIBLE`.**

| | |
|---|---|
| Ceiling | `$10/W`, exclusive (exactly 10 passes, 10.01 throws) |
| Fields | `Adder_{Conduit_Attic,Flat_Roof,Roof_Tile,Bird_Blocking}_Price__c` |
| Runs | **before any adder maths**, so an implausible rate never reaches a commission, a budget line or a snapshot |
| Gated on qty? | **No.** Price alone fires it — bad data is bad data, and a qty of 0 is one edit away from a qty of 1 |

The message names the field and the value, and points at the `a1P7y00000AlufJEAR`
precedent, because the fix is always on the record rather than in the code.

**Production sweep, 2026-08-24.** `scripts/backfill-storage-adder-prices.mjs` also sweeps
both objects for existing violations. Brian Peters (`a1P7y00000AlufJEAR`) is **fixed** —
`Adder_Roof_Tile_Price__c` now 0.02. Three others were **not** known:

| Record | Field | Value | `Commission_Total__c` |
|---|---|---|---|
| Customer `a1P7y00000AUk65EAD` — Nicholas Suwyn | `Adder_Roof_Tile_Price__c` | 246.40 | **−3,021,904** |
| Customer `a1P7y00000AbJXNEA3` — Hugo Quintana | `Adder_Flat_Roof_Price__c` | 220.00 | **−2,113,556** |
| Solar `a1Q7y00000JD2u7EAD` — SOL-9428 "Ralph Romano - TEST" | `Adder_Conduit_Attic_Price__c` | 450.00 | blank (qty 0, no system size) — **latent** |

The first two are live records carrying the same defect that caused the original incident.
Until the values are corrected, recalc on them now refuses rather than posting the number.

**Burden DID change, one day later — see D21.** Stage 2 as originally built kept the old
rule and burdened the internal rep amount, which under the redline model produced
10,939.50 of burden on the fixture job against 415.50 for the same job sold externally.
Harmon ruled on 2026-08-22 that **neither rep line is burdened**, so the basis is now
`75% × (management + setter)` and the two routings burden identically. The external
worked example is unaffected — it was already 75% × (mgmt + setter), which is why every
cell and field expectation in the fixture survived the amendment untouched.

> ⚠️ **The fixture cannot catch a regression in the burden basis.** It is an EXTERNAL
> deal, so the rep cell is zero and the old and new formulas agree to the cent. Three
> behaviour tests pin D21 instead: the internal case at 415.50, an equality assertion
> that external and internal burden match, and a scaling check that a 10× rep amount
> moves burden not at all.

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

Test suite: **188 checks** (88 cells / 55 fields / 16 extras / 29 behaviours), up from 175
(186 at Stage 2 as first built, +2 for D21).
All old 2,200-based commission expectations removed — grep for `2200`, `2754`, `3169.5`,
`33332.5`, `8775.02` returns nothing.

### 4f. PO tracking fields — SOLAR only — **APPROVED AS PROPOSED 2026-08-24, PACKAGED, NOT YET DEPLOYED**

Eight fields, written up in [`commission-po-field-gap.md`](commission-po-field-gap.md) and
approved unchanged — two OrderNbr, two amount, two created-at, plus status and error.
Package: **`salesforce/v4-commission-po-fields/`** (generator + `.object` + `package.xml` +
deploy README). Additive only; re-verified against the live describe 2026-08-24 (490 fields
on `Sundial_Solar__c`, no collisions) by `scripts/probe-commission-po-fields.mjs`.

**Still to do:** deploy the package, then grant the integration user **Read + Edit on all
eight**. That FLS note is sharper than the usual one — without Edit on
`Commission_PO_M1_Number__c` the engine still creates a real purchase order and then fails
to store its number, and the next push raises a second one.

Two things from that document worth surfacing here:

- **The OrderNbr fields are the idempotency key and there is no substitute.** Acumatica
  order numbers are zero-padded strings (`016102`), so they must be **Text, not Number** —
  a Number silently drops the leading zero. The rejected alternative was searching
  Acumatica for a PO whose description looks right; a description scan matches a
  hand-typed PO and misses a renamed one, and both failure modes are Harmon paying a
  dealer twice.
- **`Bill_Out_in_Acumatica_Requested__c` / `_2__c` already exist** and are labelled "M1 /
  M2 Bill Out in Acumatica Requested". They are Harmon's manual **AR** request markers,
  not the **AP** purchase order this engine raises. **Confirmed unrelated 2026-08-24** —
  the eight new fields sit beside them deliberately.


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
| Referral fees | **GENO · OTHER · REFERRAL · Expense** (D20 — was `REFERRAL · OTHER · &lt;N/A&gt;`) | `Adder_Referral_Fee_Price__c * Adder_Referral_Fee_Qty__c` | **never in the template** — the push CREATES it, see §5b |

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
| **Referral fees** (`GENO`/`REFERRAL`) | update by guid, as normal | inactive (almost every job) | **D20: CREATE the line, verify, then continue.** While `CREATE_GATE` is closed: **ABORT** telling the user to add the line by hand and re-push. |

### 5b. D20 — the one line the integration may create — **BUILT 2026-08-22, SHIPS DISABLED**

Harmon will not add a REFERRAL line to the templates, so a job that carries a referral fee
has nowhere to post it. The push creates the line on demand. This is the only insert
anywhere in the integration; everything else is update-by-guid, and stays that way.

**Key change.** `REFERRAL · OTHER · <N/A>` → **`GENO · OTHER · REFERRAL · Expense`**. The
new key shares its task with the other-costs sum row (`GENO · OTHER · <N/A>`) and differs
on InventoryID, so they are two distinct lines under one task. That distinction is
load-bearing and has its own test: if the two keys ever collapsed into one, the matcher
would see two mapping rows for one line and **SUM** them — posting the referral fee into
the GENO other-costs total, silently, with a plausible-looking result.

**Three branches** (`writeBudgetLines`, via `matchMappingToLines`'s new `toCreate` bucket):

| State | Behaviour |
|---|---|
| line PRESENT | update by guid, business as usual — no create, even with the gate open |
| ABSENT, amount 0 | `inactive` row, exactly as before. Every job with no referral fee. |
| ABSENT, amount > 0 | **CREATE → re-read → VERIFY → then continue.** A re-push afterwards takes branch 1, which is tested rather than assumed. |

**Create-then-verify, and why the verify is not paranoia.** An update that half-fails
leaves a wrong amount, which the next push corrects. A create that half-fails leaves either
NOTHING (money silently unposted) or TWO lines — and a duplicate breaks the
exactly-one-match invariant, so *every future push on that project aborts*. Neither is
self-healing, so neither may be reported as success on the strength of a 200. The verifier
re-reads the project and checks four things: exactly one line carries the key, it has a
guid, the amount is what we sent, and `AccountGroup`/`Type` came back as expected.

Those last two are the real question. Acumatica may **derive** them from the inventory
item's posting class rather than taking what we send, and both are part of the natural key
— so a derived value produces a real line under a key the mapping will never match again,
and the next push would try to create a second one. The verifier looks up a near-match on
task + inventory before concluding nothing exists, so the message names the key part that
changed instead of reporting a line that is sitting right there as missing.

An unverified create **aborts the whole push before any other line is written**, so the
one case where the project's state is unknown is not buried under twenty successful
updates.

**The gate — OPEN since 2026-08-22.** `CREATE_GATE = { enabled: true }`, a repo constant
and deliberately **not** an environment variable, because an env var can be flipped in the
AWS console with no commit and no review and this repo has already been burned by a
load-bearing untracked dashboard setting. A test asserts the committed value, so a change
in **either** direction is a visible diff.

It opened on the strength of the hand-proof in
[`acumatica-referral-line-create-runbook.md`](acumatica-referral-line-create-runbook.md)
§Results — sandbox project `R261065`, all five checks. The two real unknowns are settled:
Acumatica **does** derive `AccountGroup` and `Type` from the inventory item's posting
class, and it derives exactly `OTHER`/`Expense`, so `REFERRAL_LINE_KEY` is correct and no
mapping change was needed. (Had it derived anything else, the fix would have been to
re-key the mapping row, not to relax the verifier.) The sandbox is a refreshed copy of
live, so its item posting classes are live's own configuration — which is what makes a
sandbox result evidence about live here.

**Closing the gate is a complete rollback**, not a half-state: an absent line with a real
referral fee reverts to the pre-D20 loud abort before any PUT. Pinned by its own test, so
"set `CREATE_GATE.enabled` back to `false`" stays a real answer if the create path ever
misbehaves. **The trigger to watch for:** `summary.created` should be `1` on the push that
first posts a referral fee for a project and `0` on every push after. Ever `1` twice for
the same project means verification is not doing its job.

**Guarded to one key.** Three redundant conditions must all hold before anything is
created: the row opts in (`createIfMissing`), its key is exactly `REFERRAL_LINE_KEY`, and
the gate is open. A row that opts in without being the referral line falls through to the
ordinary missing-line abort. The check is repeated at the top of the create function and
again in the write loop — redundant on purpose, since this is the boundary of the only
write capability that can add rows to Harmon's books.

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

## 6. PO engine spec — **BUILT 2026-08-22, GATED OFF** (`lambdas/sundial-acumatica-commission-po/`)

Two POs per third-party job, one per milestone payment to the dealer who sold it.
**Internal deals raise no PO at all** — internal commission is payroll (D16).

**WHEN (D23, corrected 2026-08-24): both POs are raised on the FIRST budget push**, and
updated by every later push until Acumatica freezes them. An earlier reading of this
section had M1 waiting for Site Audit Complete and M2 for Glass on Roof; that is not
Harmon's workflow, and nothing in the engine waits on a date.

| Milestone | Amount | Raised | Carries the date from |
|---|---|---|---|
| **M1** | `min(50% of commission, $2,500)` | first budget push | `Audit_Date_and_DateTime__c` (Q13) |
| **M2** | the balance | first budget push | `Scheduled_Install_Date__c` (Q13) |

The dates go on the line's **`Requested` + `Promised`**; a blank one sends nothing and
Acumatica defaults to the order date, which is what happens on most first pushes.

The cap is corroborated by the live attribute pull on R251282: SLSCOM1 = **2500.00
exactly** and SLSCOM2 = **4814.00**, i.e. a 7,314 commission split by the cap biting. A
round 2,500 appearing in live data is the strongest evidence available that the rule is
stated correctly, so it is the pinned regression case.

**M1 is rounded and M2 is the remainder**, never rounded independently — rounding both
lets them miss the total by a cent, and a cent that appears in a report but not a payment
is somebody's afternoon.

**Shape: D22**, from live specimen PO 016102. Body built minimal, derived values verified
against the specimen on re-read — the same create-then-verify discipline as D20, for a
sharper reason: a budget line is a number in a plan, a purchase order instructs a payment.
A wrong derived `Account` posts real cost to the wrong GL account, which nothing
downstream flags.

**Vendor** via the D4 map, which refuses four distinct ways rather than guessing. The
internal exclusion there is belt-and-braces; the deal-type gate in `planCommissionPos` is
the primary defence and does not consult the sales company at all.

**Freeze rule** (D22): `Open`/`On Hold` updatable by PUT with header guid + line id;
`Completed`/`Closed`/`Cancelled` frozen, and the refusal **reports the delta** so it can
land in M2 rather than vanishing.

**Idempotency**: the OrderNbr stored on the Salesforce record. Never a description scan.

**Write-back** goes through the eight §4f fields, and the ORDER is the design:
`syncCommissionPos()` stores M1's OrderNbr before M2 is even attempted, so an M2 failure —
or a Lambda dying between the two — cannot lose the fact that M1 was raised. Batching all
eight into one tidy update at the end would be neater code and a duplicate payment the
first time anything went wrong halfway.

### Blockers — two of three cleared

1. ✅ **§4f fields** — approved and packaged (`salesforce/v4-commission-po-fields/`).
   **Still to deploy, with Read + Edit FLS for the integration user.**
2. ✅ **Q13** — answered. See D23; the milestone dates turned out not to be triggers at all.
3. ❌ **Hand-proof** — [`acumatica-commission-po-runbook.md`](acumatica-commission-po-runbook.md)
   ran 2026-08-24 and is **not clean**. Create, re-read, every derived value and
   update-by-guid all passed on R261065 / PO 016442. Two steps did not land: the
   duplicate count (step 7) counted 28 pre-existing vendor+project POs and never isolated
   ours, and the freeze test (step 8) ran against an `On Hold` PO — an updatable status by
   design — so it tested nothing. Both re-tests are cheap and written up in the runbook's
   §Results.

**Step 6's committed-amount question came back clean:** `OriginalBudgetedAmount` on the
SLPC OUT lines was byte-identical before and after the PO, so the budget push and the PO
engine do not write the same column and there is no ordering constraint between them.
`CommittedAmount` was absent from the ProjectBudget response entirely rather than zero, so
the commitment is not observable through that endpoint — informational, not a gate.

`PO_GATE.enabled` ships `false`, a repo constant rather than an env var, pinned by a test —
same mechanism and same reasoning as D20's `CREATE_GATE`. **60 tests.**

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
| SALESPERSO | Sales Person (name) | **`Sales_Company_Harmon_Solar_or_Third__c`** (Q10 resolved 2026-08-22) | Layer-1 / budget push |
| SLSCOM1 / SLSCOM2 | Salesperson commission M1/M2 | PO engine amounts | budget/PO push |
| MGRCOM1 / MGRCOM2 | Manager comm M1/M2 (75/25 of .04×W — verified 382.80/127.60 @12.76kW) | calc (mgr component) | budget/PO push |
| MGMTOR1 / MGMTOR2 | Mgmt override M1/M2 (75/25 of .015×W — verified 143.55/47.85) | calc (overhead component) | budget/PO push |
**Q10 fully resolved 2026-08-22. Built as `lib/acumatica-attributes.js` (15 tests); the
PUT was hand-proof-gated and the ~~hand-proof passed 2026-08-24 (D24) — the builder needs
no changes.~~**

**Not every project carries all fourteen.** `R261065` had only ten; `GREENTAG`, `COMDATE`,
`INDESIGN` and `INCOMDATE` were **absent, not blank**. A PUT creates them (D24), so this is
not an obstacle — but it means the count on a given project is not evidence of anything,
and an attribute the *template* does not define is silently discarded rather than
rejected. That is why the sync re-reads.

**SALESPERSO carries the selling COMPANY, not a person.** The AttributeID says "Sales
Person", but R251282's value is "Familia Sicairos" — a `Sales_Company_Harmon_Solar_or_Third__c`
picklist value. For an internal deal it reads the literal "Harmon Solar" rather than the
Harmon rep. That matches the live data and Harmon's reporting; it is not a placeholder.

**The rep milestone pair follows a DIFFERENT rule from the other two, and this is the
easiest thing here to get wrong:**

| Pair | Split |
|---|---|
| `SLSCOM1/2` | third-party: `min(50%, $2,500)` then the balance (§6) · **internal: 75/25** (D16) |
| `MGRCOM1/2` | 75/25 of the `.04` component, whichever way the deal was sold |
| `MGMTOR1/2` | 75/25 of the `.015` component, whichever way the deal was sold |

An internal deal raises **no PO** but still gets SLSCOM1/2 — the money goes through
payroll and the attributes still have to show it. Filling them from the third-party
milestone rule would understate the first payment on every internal job over $5,000,
which under D19's redline model is most of them. It also reads the **internal** amount
field, not the third-party one.

MGRCOM and MGMTOR stay **separate** attributes. D10 keeps the two components stored
precisely so this split is possible; the budget's SLMC line sums them, and summing them
here too would collapse the distinction the attributes exist to make.

**Blank values are OMITTED, never sent as `""`.** A milestone that has not happened is not
a milestone someone cleared, and writing `""` to every unreached date would make the sync
capable of erasing a value entered in Acumatica by hand.

⚠ **That protection depends on an unproven assumption**: that a partial `Attributes` array
MERGES rather than REPLACES. If PUT replaces the set, omitting an attribute deletes it and
the sync needs a read-modify-write cycle before it can be wired at all. **Step 5 of
[`acumatica-attribute-sync-runbook.md`](acumatica-attribute-sync-runbook.md) is that
test**, and it is the reason that runbook exists.

## 8. Template selection (RS / RSDC) — **IMPLEMENTED 2026-08-26**; JOBTYPE attribute should carry the same code.

### The rule (single source of truth)

`Sundial_Customer__c.Domestic_Content_Eligible__c` — a **Yes/No picklist on the CUSTOMER** —
decides **both** halves of domestic content. Per the business owner, *eligible IS the election*;
there is no second "elected" decision anywhere in the model.

| `Domestic_Content_Eligible__c` | Acumatica template | DC rebate |
|---|---|---|
| `"Yes"` (trimmed, case-insensitive) | **RSDC** | `DC_Rebate_Amount__c = 0.45 × watts` (D2), pushed to `DCREBATE · BILLING · <N/A> · Income` |
| `"No"`, blank, null, anything else | **RS** | 0 |

Matching is trimmed and case-insensitive so a value/label edit does not break it, but it is
**not permissive** — it is a picklist, so only `"Yes"` wins. `"Y"`, `"true"`, `"1"` do **not**.

Two Lambdas read this field, with the identical rule, from the identical place:

| Lambda | Function | Reads |
|---|---|---|
| `sundial-acumatica-push` (Layer 1) | `isDomesticContentEligible(cust)` | `Domestic_Content_Eligible__c` off the customer record already in hand |
| `sundial-budget` (calc) | `isDomesticContent(rec)` in `budgetCalc.js` | `Sundial_Customer__r.Domestic_Content_Eligible__c` (relationship read-through, same pattern as the D17 setter) |

`sundial-acumatica-budget-push` needs **no change**: its `DCREBATE` row keys off the calc
output `DC_Rebate_Amount__c` and off which scaffold actually exists in Acumatica. With the
template and the rebate driven by one field, the two agree **by construction**.

### Root cause — specified here, never implemented

RS/RSDC selection was written into this document from the first draft and **was never built**.
`lambdas/sundial-acumatica-push/index.js` shipped with the template hardcoded:

```js
const PROJECT_TEMPLATE_MAP = { residential_solar: "RS" };   // RSDC absent entirely
const templateId = resolveProjectTemplate(DEFAULT_PROJECT_TYPE);   // always "RS"
```

No domestic-content field was selected in the customer SOQL either, so the information needed
to decide was never even read. **Every project created by Layer 1, from its first deploy until
this fix, was scaffolded RS** — correct for the overwhelming majority (non-DC jobs), silently
wrong for every domestic-content job. **One known production project was created RS that should
have been RSDC**; it is remediated separately by delete-and-recreate, not by this code change.

This is exactly the failure the `DCREBATE` conditional row (§5, D18) was built to catch: a
non-zero rebate on an RS scaffold **aborts** rather than letting the income silently vanish. The
abort is the safety net; it is not the fix, and it only fires at budget-push time — long after
the wrong project has been created.

`summary.project.domesticContentEligible` now rides alongside `summary.project.templateId` in
the button response specifically so the next such divergence is visible at creation time,
without re-reading Salesforce.

### The calc's DC toggle changed source at the same time

Previously `budgetCalc.js` read **`Sundial_Solar__c.Domestic_Content__c`** — unrestricted free
text, parsed permissively (`yes` / `y` / `true` / `1`, plus boolean `true`). Two independent
fields on two different objects fed one decision, so template and rebate could disagree, which
is precisely the state the `DCREBATE` row aborts on.

The calc now reads the Customer picklist. **`Domestic_Content__c` is retired as an integration
input and is no longer read by any Lambda** — it is gone from `INPUT_FIELDS` in
`handler.js` (and its comment block with it). It still exists on `Sundial_Solar__c` for history;
do not re-add it expecting the calc to read it, because it does not. A test asserts that setting
it to `'YES'` has no effect.

> **Not changed by this fix:** the `JOBTYPE` attribute (§7) is still sourced separately and
> should carry the same `RS`/`RSDC` code the project was scaffolded from. The Salesforce field
> metadata for `DC_Rebate_Amount__c` (`salesforce/v2-budget-output-fields/generate.mjs`) still
> describes the rebate as keyed off `Domestic_Content__c`; that description is now stale and
> needs a metadata deploy to correct, so it is deliberately left alone here.


## 9. Open questions (updated 2026-08-20)
| # | Status | Question |
|---|---|---|
| Q1 | **RESOLVED (D9)** | Internal→SLPC·SALESCOMM, 3rd-party→SLPC OUT·M1&M2COM, mgmt combined→SLMC. |
| Q2 | **RESOLVED (D16)** | Internal = payroll, no PO; same attributes (75/25), SLPC·SALESCOMM cost line. |
| Q3 | **RESOLVED (D11)** | SUBCON lines contribute to totals + push. |
| Q4 | **RESOLVED (D11)** | Software = SOFTWARE cost line, contributes. |
| Q5 | **(a) RESOLVED (D12); (b) RESOLVED 2026-08-22** | LR Warranty → GENO cost. (b) Live specimen supplied: **PO 016102, project R261078, vendor 02118**. Shape recorded as D22 and in §6. |
| Q6 | OPEN | Expansion Pack +4h / Powerwall +16h — auto or manual? (Sheet: manual.) |
| Q7 | **OBSOLETED by D19** | The per-adder commission question disappears: commission is now Contract − Redline×W − Total Adder Price, so adders reduce commission in aggregate rather than each earning a per-adder rate. §4e per-adder commission formula fields are **not needed and will not be built**. |
| Q8 | **RESOLVED** | Setter line = APPT COM (sheet label "APPT COMM"). |
| Q9 | **RESOLVED (D17)** | Setter__c populated → apply Geo_Commission_Amount__c ($70 dflt). |
| Q10 | **FULLY RESOLVED 2026-08-22** | Five date fields mapped (§7), all verified present by live describe. **SALESPERSO = `Sales_Company_Harmon_Solar_or_Third__c`** — consistent with R251282, whose SALESPERSO reads "Familia Sicairos", a value of that picklist. Note the attribute therefore carries the selling COMPANY, not an individual. |
| Q11 | **RESOLVED (D10, Tim-confirmed)** | Two stored fields (.04/.015), summed for the SLMC line, split for attributes. |
| Q12a | **RESOLVED (D18), then SUPERSEDED (D20)** | SOFTWARE + ENGR + SUBCON exist in the live template. **REFERRAL does NOT, and will not** — D20 re-keys it to `GENO · OTHER · REFERRAL` and has the push create the line on demand. No Harmon template action. |
| Q12b | **RESOLVED (D18)** | BALANCE income **excludes** the DC rebate — confirmed by the live math. The rebate posts to its own `DCREBATE` income line. No change to the BALANCE row. |
| Q12c | OPEN (Harmon) | Is the `DLR` dealer-fee expense line correct, given the calc already nets the dealer fee out of Balance of Revenue? Carried over from v1 rather than dropped, because the line exists in the live scaffold. |
| Q13 | **RESOLVED 2026-08-24 (D23)** | ~~§6 fires M1 "at Site Audit Complete" and M2 "at Glass on Roof"; neither exists as a field.~~ The question dissolved rather than being answered as asked: **both POs are raised on the first budget push**, so there are no triggers to identify. The two dates are what each PO **carries** — **M1 = `Audit_Date_and_DateTime__c`, M2 = `Scheduled_Install_Date__c`**, the same fields feeding the `AUDITDATE` / `INCOMDATE` attributes. `Days_to_Glass_on_Roof__c` never had to be read. |
| Q17 | **RESOLVED 2026-08-24 (Harmon) — PAD, and it is done** | Match the existing hand-entered convention: **money to 2 decimals (`2500.00`, `382.80`), KW to 3 (`8.360`)**. Attributes are string-valued and Acumatica stores exactly what it is given, so this was formatting rather than rounding. Implemented as `ATTRIBUTE_DECIMALS` + a `decimals` argument on `formatAttributeValue`, per-attribute rather than one rule for all numbers — a text attribute is passed through rather than turned into `NaN`. The pinned R251282 expectations are now **textually** identical to the live pull, not merely numerically. |
| Q15 | **RESOLVED 2026-08-24 (Tim)** | **`BizRun Tenant` IS the sandbox** — the original handoff fact. Both hand-proof runs (PO 016442 and the attribute writes on R261065) landed in the sandbox; **confirmed in both UIs**. The contradiction was in the docs, not the world: **`sundial/acumatica/connected-app` is a POINTER whose contents change** — BizRun through the rework, repointed at live at the end of the release window — so calling it "the live secret" or "the sandbox secret" is wrong in both directions and goes stale silently. §1 now says so. To find out which tenant you are on, read the `client_id` suffix; every runbook's step 2 does. |
| Q16 | **RESOLVED 2026-08-24 (Harmon)** | **Terms is PER-VENDOR and derives from the vendor record.** The specimen (vendor 02118) is `30D`; the hand-proof PO (vendor 01736) is `DOR`; both are correct. The code assumption stands — `Terms` is out of `SPECIMEN_DEFAULTS` and **nothing asserts it**; it is recorded and returned instead (`RECORDED_HEADER_FIELDS`). No Acumatica change needed. Had it stayed asserted it would have rejected a good Blue Sky Solar PO on the first live job and blamed the specimen. |
| Q14 | **OPEN (Harmon) — blocks 128 records** | 19 active Sales Company picklist values have no Acumatica vendor in the D4 map, and 128 existing Solar records carry one. Each is a commission PO that will refuse (correctly) until Harmon supplies the VendorID. Run `scripts/verify-dealer-vendor-coverage.mjs` for the current list. |

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
**D — PO engine: 🟢 LIVE 2026-08-24, PO_GATE OPEN** (`lambdas/sundial-acumatica-commission-po/`, **65 tests**). Milestone amounts, the D22 body shape, create-then-verify, freeze rule, idempotency-by-stored-OrderNbr, the D23 milestone dates and the §4f write-back (`syncCommissionPos`) are all built and tested. Vendor resolution is `lib/acumatica-dealer-vendors.js`, generated from the CSV (14 tests). **All three blockers cleared 2026-08-24:** §4f fields DEPLOYED with Read + Edit FLS, Q13 answered (D23), hand-proof re-run. `PO_GATE.enabled = true` (D25/D-060), wired into the push worker via `runDownstreamStages`. **Step 8 established that Acumatica ALLOWS editing a Canceled PO, so the freeze rule is the only protection** — deny-by-default, unbypassable, tested. **Step 7's duplicate probe is still buggy**: accepted residual risk, compensated by the first-live-job watch.
**E — attribute sync: 🟢 LIVE 2026-08-24, ATTR_GATE OPEN** (`lib/acumatica-attributes.js`, **32 tests**). Q10 fully resolved. The builder reproduces R251282's live commission attributes **textually** — `2500.00`/`4814.00` · `382.80`/`127.60` · `143.55`/`47.85`, KW `12.760` — since Q17 was resolved as "pad to Harmon's convention". Blanks are omitted rather than blanked. ~~**One unproven assumption gates the wiring:** whether a partial `Attributes` PUT merges or replaces.~~ **Answered by the hand-proof: it MERGES (D24).** `verifyAttributeWrite` is built and approved — the sync must re-read and compare (dates by date part), because an unknown AttributeID returns 200 and is silently discarded. **Wired 2026-08-24** — `syncProjectAttributes` (PUT + verifying re-read, behind `ATTR_GATE`) runs from the push worker after the budget lines are written. **A SECOND path now writes attributes too**: the attribute-only route for legacy/non-budgeted projects (D26/D-061), which sends a restricted set and can never touch a commission attribute. ~~Known gap: no `Attribute_Sync_Status__c`/`_Error__c` pair.~~ **Closed** — `salesforce/v5-attribute-sync-fields/` (3 fields, awaiting Workbench deploy + FLS), written by both paths from one mapping. **45 tests.** Tim's `R261065` restore (runbook step 9) still outstanding.
**F — frontend:** commissions v3 inputs, COST adders, D7 read-only tabs, mapping deltas, PO/attribute status display.
  - **⚠️ PREREQUISITE — four existing output fields CHANGED MEANING in v2** (`budget-v2-output-gap.md` §A/§E). A Budget UI still on v1 semantics shows **zero commission on every internal deal**, **double-counts CO fee + permit** (`Constructive_Ops_Total__c` is now a *subset* of `Total_Other_Budget__c`), **double-counts QA** (`Audit_Labor_Cost__c` is now audit+QA), and understates labor (`Total_Labor_Budget__c` excludes burden; use `Total_Labor_And_Burden__c`). None of these throws — they all render a plausible wrong number on a margin screen. Read §A before touching the Budget UI.
**Gates:** REVISED fixture green → deploy calc; reconcile 0-problems live RS + RSDC → enable push; sandbox PO proof → enable PO stage; supervised live end-to-end (one 3rd-party + one RSDC job).

## 11. Field-change log for Create Project button
- 2026-08-20 — §4a/4b/4c package BUILT, not deployed. Mapping additions pending.
- 2026-08-20 — REVISED sheet: +`Internal_Rep_Commission_PPW__c` to create AND map; Overhead/Mgr PPW fields RETAINED in mapping (D10).
- (pending) ADD to mapping: §4a ×14 + §4b ×8 Customer fields + Internal_Rep_Commission_PPW__c.
- (pending) REMOVE from mapping: CC diff list, Tim-reviewed.
- NEVER MAP: formula fields; §4c Cost fields (null = derive semantic would be destroyed by a copy).
