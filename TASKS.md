# Sundial — Tasks

Status markers: `[ ]` TODO · `[x]` DONE · `[~]` IN PROGRESS · `[!]` BLOCKED

Harmon Phase 1 punchlist: see ../harmon-crm/docs/HARMON_PHASE1_PUNCHLIST.md — BE-owned items: G2 (G2b, G2c), E1.

## Portal testing hygiene (2026-08-24)

- [x] **Designated portal test record created**: `Sundial_Customer__c`
      **`a1P7y00000AmyXCEAZ`** — *"ZZ PORTAL TEST — DO NOT USE"*. Rich by design: adder
      prices AND qtys, two adders with no metadata default, NS block 1 with
      material+hours+markup, battery qty 1, and full contract/system data so the commission
      formulas produce real numbers. Baseline 16,387.50 / 3,834.50 / 1.85.
- [x] **Seed + reset script** `scripts/create-portal-test-record.mjs --apply` (idempotent;
      asserts the baseline on every run).
- [x] **CLAUDE.md rule added** — all portal round-trip/save testing uses that record, never
      a live customer, citing the Doug Malde false alarm.
- [ ] **The frontend `record-editing.ts` question is still open.** Doug Malde did NOT
      falsify "sends only changed fields" (7 defaulted currency fields and 4 untouched
      percent fields survived the 22:57:30 save), but he was a weak witness. **Run one
      single-field save from that branch against `a1P7y00000AmyXCEAZ` and re-read** — that
      is the test that can actually fail.
- [ ] **A Solar-side designated record** if/when Solar save testing is needed. Note
      `Sundial_Budget_Recalc_Trigger` fires on Solar writes and publishes a recalc platform
      event; Customer has no such trigger.

## Post-deploy verification (2026-08-24)

- [x] **v3 + v2-field-alignments deployed** (8/8 and 10/10) and verified against the LIVE
      org by `scripts/verify-ns-markup-postdeploy.mjs`: no `/100` in
      `Total_Adder_Price__c`, markup default `0.25`, Customer widened to `Percent(18,4)`,
      and the arithmetic probe returning exactly **+1,250.00**.
- [ ] **TIM: Hugo Quintana `a1P7y00000AbJXNEA3` is still broken.**
      `Adder_Flat_Roof_Price__c` = **220**, commission **-2,123,506**. No edit since this
      session's backfill at 21:16:52. Nicholas Suwyn was fixed; this one was not.
- [ ] Optional: Solar `a1Q7y00000JD2u7EAD` (SOL-9428, TEST) still has
      `Adder_Conduit_Attic_Price__c` = 450 — latent, qty 0 and no system size.

## D-063a percent-domain class audit + burden rates (2026-08-24)

Branch `fix/burden-rate-percent-domain`.

- [x] **Burden rates confirmed as the same defect.** `Labor_Burden_Rate__c` and
      `Commission_Burden_Rate__c` on Solar, `<defaultValue>75</defaultValue>` → stored 7500.
      Neither is in any package here — they predate the repo, so `v2-field-alignments`
      (MODIFY) carries the fix, defaults → **`0.75`**.
- [x] **Customer copies unaffected** — no default at all, and `Percent(5,2)` (max 999.99)
      makes 7500 structurally unstorable. Left alone deliberately.
- [x] **Data fix applied: 4,473 of 4,473 Solar records; 0 remain at 7500.** Canary-gated.
      First pass wrote 4,471 with 2 transient `fetch failed`; the script is idempotent, so a
      second run cleaned them up. Do NOT pipe a real run — the shell reports the pipe's exit
      status, so a partial write looks like success.
- [x] **Automation verified EMPIRICALLY.** The integration user cannot read
      `FlowDefinitionView` or `ApexTrigger`, so the canary write is the only available
      check. Passed; `Budget_Calc_Status__c = 'Pending'` held at 0 throughout.
- [x] **`BURDEN_RATE_IMPLAUSIBLE`** above 100%, before either rate becomes a multiplier.
- [x] **Class audit built** — `scripts/audit-percent-field-defaults.mjs`, every Percent
      field on every Sundial object, metadata AND data, non-zero exit on any suspect.
- [x] **`npm run build-zips`** rebuilds every package zip in one command, so a fixed
      package can no longer ship beside a stale sibling.
- [x] **Two straggler Customer records** (created between the D-063 fix and its deploy)
      swept to 25.
- [x] **Roofing's six fields listed** and fixed by Tim in Setup — defaults to
      0.20 / 0.20 / 0.025 / 0.35 / 0.30 / 0.30, records to 20 / 20 / 2.5 / 35 / 30 / 30.
- [x] **Zip packaging defect found and fixed (2026-08-25).** The zip I handed over failed
      Workbench Check with five "Not in package.xml" errors — a stale
      `objects/Sundial_Customer__c.object` left behind after Customer dropped out of the
      package. `zip-package.mjs` now validates manifest vs contents and refuses to build;
      the generator now deletes object files for objects with nothing left to change.
- [ ] **TIM: the burden defaults are NOT deployed yet.** The org still reads `75` on both
      `Labor_Burden_Rate__c` and `Commission_Burden_Rate__c` (verified with `forceRefresh`
      against a control that correctly shows yesterday's `0.25` markup default). Looks like
      a Check Only that validated and stopped. **Re-run the deploy without Check Only** using
      `salesforce/v2-field-alignments.zip` (rebuilt, validated, content-identical to your
      `v2-burden-defaults-FIXED.zip`). Expect `Components: 2/2`.
      Verify after with: `node scripts/audit-percent-field-defaults.mjs` — it exits 0 only
      when every Percent default is decimal-correct.
      The 4,473-record DATA fix is unaffected; this only governs NEW records.
- [ ] **TIM: four human-set burden values to review** — the mirror-image error (decimal form
      written into the display domain), left untouched:
      - Solar `a1Q7y00000JR27dEAD` (SOL-10027) `Commission_Burden_Rate__c` = **0.75**
      - Solar `a1Q7y00000JRgGLEA1` (SOL-10028) `Commission_Burden_Rate__c` = **0.75**
      - Customer `a1P7y00000AiYeXEAV` (Gary Rayfield) `Commission_Burden_Rate__c` = **1.75**
      - Customer `a1P7y00000Aj9NxEAJ` (Edward Crain) `Commission_Burden_Rate__c` = **0.75**
- [ ] **When Roofing's budget/calc work starts, its burden + markup guards ship with it**
      — the equivalents of `BURDEN_RATE_IMPLAUSIBLE` / `NS_MARKUP_IMPLAUSIBLE`, from day one.
- [ ] **When `Sundial_Budget_Recalc_Trigger` is activated**, bulk data fixes on Solar must
      deactivate it first (CLAUDE.md). Today's zero fan-out was sequencing, not design.
- [ ] **Run the audit before any deploy that adds a Percent field.**
      `node scripts/audit-percent-field-defaults.mjs` — exits non-zero on a suspect.

## D-063 NS markup percent-domain fix (2026-08-24)

Branch `fix/ns-markup-percent-domain` (based on `feature/battery-expansion-adder-commission`,
which is not merged yet). `<defaultValue>25</defaultValue>` on a Percent field means
**2500%**, because Salesforce evaluates a Percent default in the decimal domain.

- [x] **PROBE FIRST, on one test record.** `scripts/probe-percent-field-domain.mjs` wrote
      through `sfUpdateRecord` and read both the raw field and the dependent formula back.
      **Three domains, and they disagree:** metadata default = decimal (`0.25`),
      REST/SOQL = display (`25`), formula = decimal (`0.25`). The API echoes `25`
      unchanged; the `.25` Tim saw was the FORMULA domain.
      - Probed on **Customer** on purpose — `Sundial_Budget_Recalc_Trigger` watches these
        fields on Solar and would fire a platform event per write.
      - The restore itself hit the bug: the record's original `2500` cannot be written
        back through Customer's `Percent(6,3)`. The probe now says so and writes the
        corrected value instead.
- [x] **Metadata fix** — all five blocks, both objects, `25` → **`0.25`**, carried by the
      MODIFY package `v2-field-alignments` (10 fields). `v2-budget-adder-fields`'s
      generator corrected too, so a fresh org never inherits it — but that package does
      **not** need redeploying here.
- [x] **Customer widened `Percent(6,3)` → `Percent(18,4)`** to match Solar.
- [x] **Formula fix** — `Total_Adder_Price__c` NS term is now `Material × (1 + Markup)`.
      The `/100` divided twice. `budgetCalc` KEEPS its `/100` (it reads the display
      domain); both land on `1.25`.
- [x] **Found and fixed, not in the brief: the MODIFY generator was not idempotent.**
      Regenerating produced `225 Upgrade-Overhead-Overhead` on four labels. Would have
      shipped in this deploy.
- [x] **`scripts/zip-package.mjs`** — forward-slash entries, metadata only, prints mtimes
      so a stale zip is visible. Replaces the manual Explorer step and the
      never-use-`Compress-Archive` rule.
- [x] **Data fix applied — 7 records** (all Customer, 0 Solar so no recalc fan-out).
      **Zero financial impact**: every affected record has zero NS material.
- [x] **`NS_MARKUP_IMPLAUSIBLE`** above 100% in budgetCalc, same shape as
      `PPW_PRICE_IMPLAUSIBLE`.
- [x] **`verify.mjs` 30 → 35 checks**, pinned to the probe's real returned numbers.
- [ ] **TIM: deploy, in this order.** The data fix has already run.
      1. `salesforce/v3-redline-commission-fields.zip` — the formula fix (Check Only
         first, expect `Components: 8/8`).
      2. `salesforce/v2-field-alignments.zip` — the defaults + widening (expect
         `Components: 10/10`).
      Both zips are freshly built. Order between them does not matter; order against the
      data fix did, and that one is done.
- [ ] **TIM: decide about the zeros.** 4,474 Solar records hold markup `0` on blocks 1-3.
      That is a legitimate "no markup" and was left alone, but the intended default is now
      25% — whether those should become 25 is a business call, not a bug fix.
- [ ] **TIM: one human-set value to eyeball** — Solar `a1Q7y00000JDFpVEAX` (SOL-10014, the
      test clone) has `NS_Adder_2_Markup_Percent__c = 15.3927` on 2,355 of material. Left
      untouched. Once the formula fix lands it becomes a real 15.39% markup (+358.88 on the
      adder total) instead of the ~0% it computes today.

## D27/D28 storage priced as adders + per-watt sanity guard (2026-08-24)

Branch `feature/battery-expansion-adder-commission`. Batteries and Tesla expansion packs sell
OUTSIDE the redline × watts model, so their price belongs in `Total_Adder_Price__c`. Until
now it was deducted nowhere and **every battery deal was overpaid by the full storage price**.

- [x] **Describe gate first.** `scripts/probe-battery-adder-fields.mjs` — both price fields
      confirmed present on BOTH objects, Currency(16,2), defaults 9,950 / 7,900, and
      **readable by the integration user**. `describe()` only returns FLS-visible fields, so
      "absent" and "no FLS" are the same symptom; the probe distinguishes them.
- [x] **Formula, through the generator (never the Setup UI).** Two terms appended to
      `Total_Adder_Price__c` on both objects. `Commission_Total__c` /
      `Commission_Total_PPW__c` needed no source edit — they inline it.
- [x] **The mismatched pair is documented, not fixed.** Solar uses
      `Tesla_Expansion_Pack_Unit_Price__c × Gateway_Qty__c`. `Gateway_*` IS the expansion
      pack on Solar; `Tesla_Expansion_Pack_Quantity__c` is an orphan. README, D27, and
      assertions in both `verify.mjs` and the Lambda suite guard the tidy-up.
- [x] **Compiled sizes re-checked** — worst 3,086 → **3,229 of 5,000 (65%)**.
- [x] **`assertFieldLimits()` wired into v3's generator** (it predated the guard) — and it
      failed the build immediately on a 1,082-char description. Descriptions now 936 / 970,
      printed as `(tight)`.
- [x] **`verify.mjs` extended — 20 → 30 checks.** Includes the 27,800 worked example on both
      objects, zero-qty-with-default-price, blank-price-contributes-0, and the
      `Gateway_Qty__c` vs `Tesla_Expansion_Pack_Quantity__c` assertion.
- [ ] **TIM: zip and deploy `salesforce/v3-redline-commission-fields/`** (Check Only first).
      Explorer zip only — never `Compress-Archive`. **Commissions shift the moment this
      lands** — the backfill is already done, so the shift is atomic.
- [x] **Lambda price side.** `stdPriceTotal` gains both terms (K39 rollup); `handler.js`
      `INPUT_FIELDS` gains both price fields. **Cost side untouched** — already complete via
      `Battery_Unit_Cost__c` / `Gateway_Unit_Cost__c`, and a test pins that price alone moves
      neither job cost nor material.
- [x] **Snapshot/sheet divergence documented** — the workbook has no storage adder price row,
      so K39 can exceed the sum of the rows above it by exactly the storage price.
      `extras.storagePriceTotal` breaks it out.
- [x] **Backfill run against production (29 records).** Field defaults only reach NEW records,
      so the formula alone fixed nothing for history. Null-only; multi-tenant refused.
      Run **before** the formula deploy so the shift is atomic.
- [x] **Acumatica reconciliation list produced.** Exactly one touched record has real push
      evidence: `SOL-10014 "ZZ TEST HOLLAND CLONE"` (budget pushed 2026-08-07, blank
      commission). No real pushed commission is affected. Customer `Acumatica_Project_ID__c`
      is NOT evidence of a commission push — the script looks through to the Solar children.
- [x] **`PPW_PRICE_IMPLAUSIBLE` guard** — the four per-watt adder prices, > $10/W, an ERROR
      not a warning, before any adder maths, gated on price alone.
- [x] **Production sweep done.** Brian Peters (`a1P7y00000AlufJEAR`) **is already fixed**.
- [ ] **TIM: fix two LIVE records the sweep found** — they carry the same defect as the
      original incident and recalc now refuses them:
      - Customer `a1P7y00000AUk65EAD` (Nicholas Suwyn) — `Adder_Roof_Tile_Price__c` = **246.40**, commission **−3,021,904**
      - Customer `a1P7y00000AbJXNEA3` (Hugo Quintana) — `Adder_Flat_Roof_Price__c` = **220.00**, commission **−2,113,556**
- [ ] Optional: Solar `a1Q7y00000JD2u7EAD` (SOL-9428, a TEST record) —
      `Adder_Conduit_Attic_Price__c` = 450.00, currently latent (qty 0, no system size).

## D19 REDLINE commission model (2026-08-21) — supersedes the PPW-input model

Branch `feat/redline-commissions`. Three stages with a boundary at each; **Stage 1 is package-only and STOPPED for Tim's deploy (done).**

`Total Commission ($) = Contract − (Redline × watts) − Total Adder Price`. Redlines: External+Lightreach 1.75 · External+other 1.85 · Internal+Lightreach 2.10 · Internal+other 2.20.

### Stage 1 — `salesforce/v3-redline-commission-fields/` (8 FORMULA fields, 4 × 2 objects) — **DEPLOYED CLEAN 2026-08-21**
- [x] `Commission_Redline_PPW__c` · `Total_Adder_Price__c` · `Commission_Total__c` · `Commission_Total_PPW__c`, all formulas so nothing writes them and they cannot drift. **Collision-checked clean on both objects.**
- [x] **Name chosen to avoid the existing `Commission_PPW__c`** — which exists on BOTH objects (not just Solar) and is a calc OUTPUT covering all commissions ÷ watts. The new one is rep-only. Flagged in the README since they will sit near each other on a layout.
- [x] **Object-appropriate sources verified live:** Customer `Sales_Company__c` (2 values) + `Financing_Partner__c` = "Lightreach" + `Final_System_Size_kW__c`; Solar `Sales_Company_Harmon_Solar_or_Third__c` (Harmon Solar or ~55 dealers) + `Sales_Type_Partner__c` = "**LightReach**" + `System_Size__c`. **The Lightreach casing differs between objects** — harmless because formula `=` is case-insensitive, but each formula uses its own object's spelling. **Customer's `Sales_Type_Partner__c` is an unconfigured placeholder ("Value 1") and must NOT be used** — Customer uses `Financing_Partner__c`.
- [x] **Compiled size measured, and it did NOT fit on the first attempt.** Salesforce inlines referenced formulas; the natural `Commission_Total_PPW__c` named `Commission_Total__c` twice and compiled to ~6,000 bytes against a 5,000 limit. Restructured to one reference (the ISBLANK branch is redundant under BlankAsBlank) plus factoring the watts term out of the four per-watt adders. **Worst case now 3,086 bytes = 62%.** `generate.mjs` prints source + inlined size every run.
- [x] **Blank handling:** everything BLANKVALUE'd, `formulaTreatBlanksAs = BlankAsBlank`. **Blank sales company ⇒ NULL, never the external rate** — a wrong redline is worse than no redline. Blank finance DOES fall through to "other" (that is a real default, not missing data). Full behaviour table in the README.
- [x] **`verify.mjs` — 20 offline checks against the generated formula TEXT** (transpiled to JS and evaluated, not a reimplementation). Caught a **precedence bug on its first run**: `Total/BLANKVALUE(kW,0)*1000` parses as `(Total/kW)*1000`, out by 10^6. Watts is parenthesised everywhere now.
- [x] Worked example reproduces: contract 36502, 8800 W, external non-Lightreach, adders 3110 → **redline 1.85, commission 17112, $/W 1.9445**.
- [x] **Check Only #1 FAILED and is fixed (2026-08-21).** `formulaTreatBlanksAs` was emitted as `BlankAsBlanks`; the enum is **`BlankAsBlank`** (singular) and all 8 fields were rejected. Fixed in the generator, regenerated, formulas and compiled sizes unchanged, `verify.mjs` still green. **Ready to re-zip and redeploy.** Note this class of error is invisible to `verify.mjs` by construction — it checks formula semantics, not the metadata envelope around them, so Check Only is the only gate for bad enums / attribute names / types.
- [x] **TIM: deployed clean** (Check Only 8/8, then deploy). All four fields verified present, `calculated=true`, and readable by the integration user on both objects.
- [x] **`BlankAsBlank` confirmed on live data.** A SOQL read of real records with no sales company returned blank redline / blank commission / blank $/W — the post-deploy assumption the offline harness could not prove, answered by production records rather than a hand-flipped test record.

### Stage 2 — calc amendment — **DONE 2026-08-21**
- [x] budgetCalc reads `Commission_Total__c` (dollars) off the Solar record and routes it to **SLPC OUT** (external) or **SLPC** (internal) by `Sales_Company_Harmon_Solar_or_Third__c`. Replaces both the PPW×watts computation and D16's which-PPW-populated discriminator. Match is case-insensitive + trimmed, deliberately: SF formula `=` ignores case, and a calc stricter than the formula could hand a record the INTERNAL redline with EXTERNAL routing — right commission, wrong line.
- [x] **Two fail-loud validations.** `SALES_COMPANY_MISSING` on a blank company (never defaults to external); `COMMISSION_TOTAL_UNAVAILABLE` when the formula reads blank with a company set — whose realistic cause is the **integration user missing Read FLS**, which SOQL reports as an absent field and would otherwise post a $0 commission that looks entirely plausible. Zero is explicitly NOT blank.
- [x] **Both now return HTTP 422 `invalid_input` with the message**, not a bare 500 `server_error`. Small addition beyond the brief, and worth it given the next line.
- [!] **ROLLOUT: 3,697 of 4,474 Solar records (83%) have a blank sales company** and will now refuse to recalculate. Survivable only because **exactly 1 record has a calculated budget today** — nothing in production depends on recalc. **Populating that field is a data task that must happen before any bulk recalc.**
- [x] Manager (.04+.015) and setter (Setter__c read-through) unchanged.
- [x] **D21 AMENDMENT (2026-08-22, Harmon ruling): commission burden = 75% × (management + setter) ONLY.** Neither rep line is burdened — not the external one and **not the internal redline commission**, which Stage 2 as first built did burden. Fixture internal-deal burden **10,939.50 → 415.50**, now identical to the same job sold externally. **Supersedes the REVISED sheet's J12**, whose burden array includes the internal rep cell — do not restore it to match the workbook. The external worked example was already 75%×(mgmt+setter), so every cell and field expectation survived untouched.
- [!] **The fixture cannot catch a burden-basis regression** — it is an external deal, so the rep cell is zero and old and new formulas agree to the cent. Three behaviour tests pin D21 instead: internal at 415.50, external==internal, and a 10× rep amount moving burden not at all. **188 checks** (was 186).
- [x] BURDENEXR·SALESCOMM mapping row: amount is the single `Commission_Burden_Amt__c` field so no component arithmetic to change, but its `note` named the old basis and is corrected — that note is what a reader checks the number against.
- [x] Retired `Sales_Rep_Commission_PPW__c` + `Internal_Rep_Commission_PPW__c` from INPUT_FIELDS and every calc read. A test pins that they are **inert** — repopulating one out of habit changes no output and does not resurrect the old ambiguity error.
- [x] Snapshot workbook: J7/J8 now carry the **derived** $/W on whichever side the deal routed to (0 on the other). Test asserts `J7 × watts = K7` and `J8 × watts = K8`, so the snapshot can never show a rate that fails to explain its own total.
- [x] Fixture re-pinned: non-commission cells still the REVISED workbook's cached values, commission block and downstream to the redline example (17112 / $1.9445). All old 2200-based expectations **gone** (grep-verified for 2200, 2754, 3169.5, 33332.5, 8775.02). **188 checks pass**, up from 175 (186 at Stage 2, +2 for D21).
- [x] **GP is negative in the fixture (−6,136.98) and that is expected** — the workbook's COST example combined with the D19 COMMISSION model, which were never priced against each other. Documented at the assertion so nobody "fixes" it by tuning the contract, which would unpin the cost cells from the workbook.
- [x] Push-lambda guards re-verified: `Commission_Deal_Type__c` is still always set (test pins it), the marker guard still tests emptiness not membership (a pre-D19 record can legitimately hold `None`), and guard 1a is now purely stale/foreign-data defence since the calc can no longer produce both amounts. Comments updated; **38/38 push tests still pass, no code change needed.**
- [x] Docs: rework doc §4d (retirement, struck through), §4h (deployed), **new §4i** (the whole Stage 2 change), D19 row, guard note. TASKS/PROGRESS.
- [ ] **Follow-up, cosmetic:** `Internal_Rep_Commission_Amt__c` was deployed with a description saying it equals `Internal_Rep_Commission_PPW__c × watts`, which is no longer true. Worth a description-only alignment pass eventually; not worth a deploy on its own.

### Stage 3 — D20, the referral line the push creates — **BUILT 2026-08-22, SHIPS DISABLED**
- [x] **D20 recorded** (supersedes D13's template-ask). Harmon will NOT add a REFERRAL line to the RS/RSDC templates; the push creates it. Line spec verbatim: `GENO` · `OTHER` · `REFERRAL` · "Referral Fee" · `EA` · USD · no default qty/rate.
- [x] **Mapping key changed** `REFERRAL | OTHER | <N/A>` → **`GENO | OTHER | REFERRAL | Expense`**. Distinct InventoryID, so no collision with the `GENO | OTHER | <N/A>` sum row — two lines under one task. Own test: if those keys ever collapsed, the matcher would **SUM** two rows into one line and post the referral fee into the GENO other-costs total, silently and with a plausible-looking result.
- [x] **Three branches.** Present → update by guid (holds even with the gate open). Absent + 0 → inactive. Absent + non-zero → create → re-read → verify. **Re-push after creation takes branch 1, proven by a test** that creates, then pushes again at a different amount and asserts an update-by-guid, zero creates, and still exactly one referral line.
- [x] **Create-then-verify.** Four checks on the re-read: exactly one line with the key, a guid, the amount we sent, and `AccountGroup`/`Type` as expected. Those last two may be **derived by Acumatica** from the item's posting class — and both are key parts, so a derived value means a real line under a key the mapping never matches again. The verifier looks up a near-match on task+inventory first, so the message names the key part that changed instead of reporting a line that is sitting right there as missing. (That flaw was caught by its own test on the first run.)
- [x] An unverified create **aborts before any other line is written** — creates run first so the one unknown-state case is not buried under twenty successful updates.
- [x] **Guarded to one key**, three redundant conditions (opt-in flag + exact key + gate), re-checked inside the create function. A row that opts in without being the referral line gets the ordinary missing-line abort; tested.
- [x] **GATE: `CREATE_GATE` — a repo constant, NOT an env var.** An env var can be flipped in the AWS console with no commit and no review, and we were burned once by a load-bearing untracked dashboard setting. A test asserts the committed value, so a change in **either** direction is a visible diff.
- [x] **SANDBOX HAND-PROOF PASSED 2026-08-22** (Tim, project `R261065`). PUT-without-id inserts; `AccountGroup`/`Type` come back `OTHER`/`Expense` **derived from the REFERRAL item's posting class** and agreeing with the mapping, so `REFERRAL_LINE_KEY` was already correct and **no mapping change was needed**; update-by-guid updates in place; no duplicate, count 1 throughout. Recorded in the runbook's §Results.
- [x] **GATE OPENED** in a reviewed commit. Test renamed to `the create gate ships OPEN, on the strength of the sandbox hand-proof` and now asserts `true`.
- [x] **Closing the gate remains a complete rollback**, not a half-state — an absent line with a real referral fee reverts to the pre-D20 loud abort before any PUT. Its own test, so "set it back to `false`" stays a real answer.
- [x] **Runbook hardened for the NEXT write-proof: a tenant-identity check (new Step 2) before the first write.** Sandbox and production share a base URL and the sandbox is a refreshed copy of live, so project IDs exist in both and a transcript cannot self-certify which system it hit. Step 2 records `client_id` + `username` + a server-side `/Company` read, and both must agree. Noted honestly in §Results that this run predates the check, so its sandbox attribution is Tim's attestation rather than something the transcript proves.
- [x] Tests: **57** (was 38). All three branches, gate open and closed, four ways a create can go wrong (rejected / 200-but-nothing / 200-but-duplicated / wrong AccountGroup), plus a create resolved against the **real 38-line RS harvest** — which a scaffold built from MAPPING_ROWS cannot prove, since it agrees with the mapping by construction.
- [ ] **WATCH on the first production referral job:** `summary.created` should be `1` on the push that first posts a referral fee for a project and `0` on every push after. Ever `1` twice for the same project → verification is not working; close the gate and inspect.
- [x] Docs: rework doc D20 + **new §5b**, D13/D18/§5 table/conditional-rows table amended, `acumatica-budget-push.md` "never insert" note and Q12a, new runbook.

### Consequences already recorded
- [x] **Q7 OBSOLETED and §4e CANCELLED.** Per-adder commission formula fields are not needed and will not be built — adders now reduce the commission pool in aggregate, so there is no per-adder rate to define.

## PO engine + attribute sync — the three TODOs closed (2026-08-22)

Branch `feat/redline-commissions`. **Build only — nothing deployed, both write paths gated off.**

### Stage A — dealer→vendor map (D4) — DONE
- [x] `docs/integrations/dealer-vendor-map.csv` committed (53 rows) as the **source of truth**; `scripts/generate-dealer-vendors.mjs` emits `lib/acumatica-dealer-vendors.js`, and `--check` fails a stale build (a test runs it, so an un-regenerated CSV is a red suite rather than a stale lookup).
- [x] **Trim, then EXACT match** — deliberately stricter than the tax-zone map. Those are free-text city names a human typed; these are picklist values, so a near-miss is a signal rather than a spelling to forgive.
- [x] **Four distinct refusals, never a guess:** `internal` (Harmon Solar), `inactive` (Derek Anderson → 01863, fails loudly per D4), `unmapped`, `blank`. Each names a different fix, which is why they are not one error.
- [x] The internal exclusion is **belt-and-braces** — the deal-type gate in `planCommissionPos` is the primary defence and doesn't consult the sales company at all. Both are tested, including the "gate bypassed" case.
- [x] Ten dealers carry two picklist spellings each, mapped to one VendorID — including `Residental` / `Residential Solar Brokers`, where deleting the misspelling would break every deal carrying it.
- [!] **⚠ Q14 (Harmon): 19 of 56 active picklist values have NO vendor, and 128 existing Solar records carry one.** Each is a commission PO that will refuse until Harmon supplies the VendorID. `scripts/verify-dealer-vendor-coverage.mjs` lists them with record counts.

### Stage B — commission PO engine (D22/D23, D25/D-057/D-060) — 🟢 LIVE, PO_GATE OPEN
- [x] `lambdas/sundial-acumatica-commission-po/` — **62 tests**. M1 = `min(50%, $2500)`, M2 = balance; **the R251282 live split (2500 / 4814) is the pinned case**. M1 rounded, M2 the remainder, so they always sum to the cent.
- [x] **Create body MINIMAL** per the specimen — Account/Subaccount/TaxCategory/Warehouse/Branch/LineType are all DERIVED and none is sent. Sending them would put a second, silently-drifting copy of Harmon's item configuration in the repo. They are **verified** against the specimen on re-read instead.
- [x] Create-then-verify, freeze rule (`Open`/`On Hold` updatable; frozen statuses report the delta for M2), and **idempotency by stored OrderNbr — never a description scan**, which would match a hand-typed PO and miss a renamed one.
- [x] **Caught in build:** an early version listed `Status: "Open"` among the derived defaults, so verification rejected every On Hold order — and blamed the specimen. Status is lifecycle state; it is now checked only where it means something (the freeze rule, and "a new PO must not arrive already frozen").
- [x] **Caught by the hand-proof: `Terms` had the same bug.** Specimen (vendor 02118) is `30D`, the proof PO (vendor 01736) is `DOR`, and both are right — Terms derives from the VENDOR. It would have rejected a good Blue Sky Solar PO on the first live job. Now **recorded, not asserted** (`RECORDED_HEADER_FIELDS`), and regression-pinned.
- [x] ~~BLOCKER 1 — §4f fields.~~ **Approved as proposed 2026-08-24 and packaged: `salesforce/v4-commission-po-fields/`** (8 fields, Text(20) order numbers, restricted status picklist, collision-checked against 490 live fields).
- [x] ~~BLOCKER 2 — Q13.~~ **Resolved 2026-08-24 (D-057), and it dissolved rather than being answered:** both POs are raised on the first budget push, so there are no triggers. The dates are what each PO CARRIES — M1 `Audit_Date_and_DateTime__c`, M2 `Scheduled_Install_Date__c` → line `Requested`/`Promised`, blank sends nothing.
- [x] **Write-back built** — `syncCommissionPos()`. M1's OrderNbr is stored **before M2 is attempted**, so an M2 failure cannot lose it and cause a duplicate M1 on the next push.
- [ ] **TIM: deploy `salesforce/v4-commission-po-fields/`**, then grant the integration user **Read + Edit on all 8**. Without Edit on `Commission_PO_M1_Number__c` the engine raises a real PO, loses its number, and raises a second one next push.
- [x] ~~TIM: deploy the §4f package + FLS.~~ **DEPLOYED 2026-08-24 with Read + Edit FLS.**
- [x] **BLOCKER 3 — hand-proof re-run 2026-08-24.** Gate opened in a reviewed commit (D25/D-060).
  - [x] **Step 8 re-run: Acumatica ALLOWS a PUT to a Canceled PO** (200, change persisted). **Our freeze rule is the SOLE protection.** Hardened: deny-by-default, unbypassable, tested against unknown/empty/null/missing statuses and casing variants. Only `Canceled` was tested — all frozen statuses treated as never-touch regardless.
  - [x] **Spelling bug found while pinning it:** Acumatica sends `Canceled` (one L); `FROZEN_STATUSES` said `Cancelled` and had never matched. Harmless only because that list is documentation and the guard is the allow-list — the near miss that justifies deny-by-default.
  - [x] **Step 9 cleanup: PO `016442` Canceled**, confirmed through the API.
  - [!] **Step 7's probe is BUGGY — 28 on both runs** (the vendor's whole PO history; the description filter isn't comparing what it claims). Ruled a runbook defect, not a gate blocker: idempotency is the stored OrderNbr and never a scan, guid/OrderNbr were unchanged across the first run's update, behaviour is tested. **Accepted residual risk.**
  - [ ] **FOLLOW-UP: fix the step 7 probe.** Until then the first-live-job watch is the compensating control, not boilerplate.
  - [ ] **⚠ FIRST-LIVE-JOB WATCH: exactly one PO per milestone per project, ever.** A second M1 on any project ⇒ close `PO_GATE` before anything else. That is a duplicate payment, not a reporting glitch.
  - [x] ~~Q15: is `BizRun Tenant` the sandbox or production?~~ **RESOLVED — BizRun IS the sandbox** (original handoff fact); both runs' writes confirmed in both UIs. The contradiction was in the docs: **`sundial/acumatica/connected-app` is a POINTER whose contents change** (BizRun through the rework, repointed at live at the end of the release window), so "the live secret" / "the sandbox secret" is wrong in both directions. §1 of the rework doc now describes it as a pointer; both runbooks' step 2 reads the `client_id` suffix and says why it is not skippable.
  - [x] ~~Q16: should every commission PO be `30D`?~~ **RESOLVED — Terms is per-vendor**, derives from the vendor record. Code assumption stands; `Terms` is out of `SPECIMEN_DEFAULTS` and nothing asserts it. No Acumatica change.

### Stage E — attribute sync (Q10 closed, D24/D-059/D-060) — 🟢 LIVE, ATTR_GATE OPEN
- [x] **SALESPERSO = `Sales_Company_Harmon_Solar_or_Third__c`.** Documented that it therefore carries the selling COMPANY, not a person — "Harmon Solar" on internal deals.
- [x] `lib/acumatica-attributes.js`, 15 tests. Reproduces R251282's live values exactly: SLSCOM 2500/4814, MGRCOM 382.80/127.60, MGMTOR 143.55/47.85.
- [x] **The rep pair follows a different rule from the other two** — third-party is the capped milestone split, **internal is 75/25** (D16), and it reads the internal amount field. Using the capped rule would understate the first payment on every internal job over $5,000, which under D19 is most of them.
- [x] Blanks are **omitted, never sent as `""`** — an unreached milestone is not a cleared one, and blanking would let the sync erase hand-entered values.
- [x] ~~TIM: run `docs/integrations/acumatica-attribute-sync-runbook.md`.~~ **Run 2026-08-24 on R261065 — clean. See §Results.**
- [x] **⚠ THE ONE THAT MATTERED — a partial `Attributes` PUT MERGES** (D24). Writing one attribute left the other ten untouched. The omit-blanks protection works, **no read-modify-write redesign is needed**, and the builder ships unchanged (15 tests). Direct evidence it earns its keep: R261065's `SLSCOM1/2` were `1538.00`/`2138.00`, matching neither commission rule — hand-entered values in exactly the fields a replace would have wiped.
- [x] **A PUT also CREATES an attribute the project does not carry** — 4 of the 14 were absent (not blank) on R261065 and the run added all four. Only works where the project's *template* defines it.
- [x] **ISO dates accepted as sent** (`2026-07-14`), echoed as `2026-07-14 00:00:00.000`. `formatAttributeValue` needs no change — but any comparison must be **by date part**, or every date reads as a failed write.
- [x] **`SALESPERSO` is free text** — `Familia Sicairos` written over `Property Upgrades`. Not a controlled selector, so no second lookup table in the shape of the D4 map.
- [x] **Sending `''` clears** a value, so "omit" and "send empty" really are different things.
- [x] ~~Q17 (Harmon): decimal formatting.~~ **RESOLVED — PAD, and done.** Money to 2 decimals (`2500.00`, `382.80`), KW to 3 (`8.360`), matching the hand-entered convention. `ATTRIBUTE_DECIMALS` + a `decimals` argument on `formatAttributeValue` — per-attribute, since Harmon's convention is not uniform; a non-numeric value passes through rather than becoming `NaN`. The pinned R251282 expectations are now **textually** identical to the live pull.
- [x] **Verify-by-re-read APPROVED and BUILT** — `verifyAttributeWrite` returns `missing` (accepted with a 200, then discarded) and `mismatched`, comparing **dates by date part** because Acumatica echoes `2026-07-14` as `2026-07-14 00:00:00.000` and a string compare would flag all five dates every run. **24 tests, up from 15.**
- [x] **STANDING HAZARD, documented as such:** an unknown `AttributeID` returns `200` and is silently discarded. It is how the API behaves and will not change; anything writing attributes must assume it.
- [x] **WIRED 2026-08-24** — `syncProjectAttributes` (PUT + verifying re-read behind `ATTR_GATE`) runs from the budget push worker after the budget lines are written. JOBTYPE is deliberately not sent: the worker can only infer RS/RSDC from which lines a scaffold has, and inference is not authority, so the merge preserves what Layer-1 wrote.
- [x] ~~⚠ NEXT FIELD PACKAGE: `Attribute_Sync_Status__c` / `Attribute_Sync_Error__c`.~~ **BUILT — `salesforce/v5-attribute-sync-fields/`** (3 fields: status picklist, error, synced-at). Written by **both** the push worker's Stage E and the new attribute-only path, from **one** mapping function, so they cannot disagree about the same outcome. Collision-checked against the live describe (498 fields).
- [ ] **TIM: RE-DEPLOY `salesforce/v5-attribute-sync-fields/`** (re-zip — the `.object` changed) + Read/Edit FLS for the integration user. First attempt failed on one field; fixed below.
- [x] **Deploy failure fixed: `Value too long for field: Description maximum length is:1000`.** `Attribute_Sync_Status__c`'s description was 1,137 chars; trimmed to 929, keeping the part a reader cannot reconstruct from the value names (why `Unverified` is not `Failed`).
- [x] **⚠ NEW BUILD GATE — `salesforce/field-limits.mjs`.** Description 1,000 / inlineHelpText 255, asserted before any generator writes, reporting EVERY offender with length and overage rather than one per deploy. Wired into the v4 and v5 generators; both now print headroom so a near miss is visible. 6 tests, registered in `npm test`. **v4 is at 975/1000 on `Commission_PO_M1_Number__c`** — deployed fine, one sentence from the same failure. v4's generated output is byte-identical (verified), so the deployed package is unaffected.

### Attribute-only sync — legacy / non-budgeted projects (D26/D-061) — BUILT
- [x] **`POST /projects/{recordId}/budget/attributes-sync`** — new mode on the budget-push Lambda (dispatches on the resource path, since both routes carry `{recordId}`), JWT + tenant, plus a direct-invoke equivalent `{ attributesSync: true, recordId }`.
- [x] **ONE gate: a linked `Acumatica_Project_ID__c`.** No calc-status check, no deal-type guard — those stop a wrong *budget* being posted and this posts none; a legacy record legitimately has neither, so gating on them would refuse the exact records this serves.
- [x] **Writes `NON_COMMISSION_ATTRIBUTES` only** — 5 dates + KW + SALESPERSO, populated-only. Never `SLSCOM*`/`MGRCOM*`/`MGMTOR*`, never `JOBTYPE`.
- [x] **Three independent protections for Harmon's hand-entered figures:** scope (never in the body; filter lives inside `buildProjectAttributes`), merge (D24), omit-blanks. They fail in different ways, which is why all three are specified rather than one.
- [x] **Verify-by-re-read mandatory** — the silent-200 hazard is a property of the API, not the caller.
- [x] **Synchronous** — 5 round trips, nowhere near the ~29s cap. Async would cost an immediate answer for nothing. Deliberately unlike the push route next door.
- [x] **No gate constant** — proven-safe mechanic, smaller attribute set, and `ATTR_GATE` already covers this path via `syncProjectAttributes`.
- [x] ~~TIM: run `scripts/wire-attributes-sync-route.ps1`~~ **ROUTE IS LIVE.** First run died at `put-method` having already created resource `4byuka`, leaving a method-less resource and no usable error. Repaired against the live gateway and deployed (`ehwyey`); verified: POST + bad bearer -> **JSON 401** `AUTH_INVALID_TOKEN`, no-auth -> 401 `AUTH_NO_TOKEN`, OPTIONS preflight -> 200 with `OPTIONS,POST`, ACAO echoes the production origin.
- [x] **Root cause: `--api-key-required $false` renders as the bare word `False`.** The CLI has no value-taking form, so it errored `Unknown options: --api-key-required, False` and put-method never ran. **`2>$null` then swallowed that message** — under `$ErrorActionPreference='Stop'` a native command's stderr becomes a terminating `NativeCommandError`, killing the script and discarding the explanation. Both were already documented in `wire-design-request-route.ps1`; the new script had not adopted the pattern.
- [x] **Script rewritten**: `--no-api-key-required`; an `Invoke-Aws` helper that captures stderr, strips PowerShell's ErrorRecord decoration, checks `$LASTEXITCODE` after **every** call, and tolerates named "already exists" outcomes so a partial run is repaired by re-running; MOCK template and CORS response-params via **no-BOM JSON files** (the CLI's shorthand map splits on commas regardless of quoting, and `'Content-Type,Authorization'` contains one); pure ASCII. Verified: parses clean, and a full idempotent re-run tolerated every step.
- [x] **Pre-deploy gate added**: the script now refuses to `create-deployment` if ANY method on the API lacks an integration — that state blocks every deploy on the API, not just its own route, and the symptom points nowhere useful. Currently 66 methods, 0 orphans.
- [ ] **TIM: redeploy `sundial-acumatica-budget-push`** — the route is wired and live, but it dispatches on code that is not deployed yet. Until then the route reaches the OLD bundle, which has no `isAttributesSyncRoute` and will fall through to the budget-push handler.
- [!] **⚠ LATENT: `.ps1` scripts must be pure ASCII (or carry a BOM).** Windows PowerShell 5.1 reads a BOM-less file as ANSI, so a UTF-8 em dash inside a `Write-Host` string breaks the parse. `scripts/wire-attributes-sync-route.ps1` is now ASCII-only and parses clean; **`scripts/wire-budget-push-route.ps1` still has the same em dash and fails `Parser::ParseFile` with 3 errors** — verify it parses before the next run rather than discovering it mid-wiring. Same family as the known `Compress-Archive` / no-BOM `file://` traps.
- [x] **Incidental fix:** `generate-dealer-vendors.mjs --check` compared raw bytes, so it reported STALE after any `git checkout` on Windows (CRLF working copy vs LF generator output) — the guard fired on a checkout artifact instead of real drift. Now compares normalised content.
- [ ] **TIM: restore R261065's attributes** — runbook step 9, pre-filled with the original values. **Status was left unfilled in the ruling message; still assumed outstanding.**
- [ ] **HARMON: flag the behaviour change before this ships.** R261065's `SLSCOM1/2` (`1538.00`/`2138.00`) match neither commission rule — Harmon hand-enters these attributes today. On integration-managed jobs **the sync is authoritative and will overwrite them.** Intended, but they should hear it from us rather than notice it.

## MAPPING_ROWS v3 + re-harvest prep (2026-08-20, Workstream C)

Branch `feat/mapping-v3`. **Build + report only — no deploy, no live push.** Gate discipline: nothing pushes until the re-harvest verifies.

- [!] **BRANCH BASE NOTE: `feat/budget-calc-v2` was NOT merged to master.** This branch is cut from `feat/budget-calc-v2`, not master — master still has the v1 HOLLAND calc, so a branch off it could not have done step 1 at all. Merge `feat/budget-calc-v2` first and this fast-forwards cleanly. (Both SF field packages ARE deployed — verified in the org; it is only the git merge that is outstanding.)
- [x] **Calc follow-up: the 8 §D outputs are now written back.** Promoted into budgetCalc's `fields` map (which is what handler.js PATCHes) and kept in `extras` so existing readers don't break. `Commission_Deal_Type__c` maps the internal token to the **picklist label** — writing `'third_party'` to a restricted picklist would be rejected on every save. Fixture 166 → **175** (7 new field assertions + 2 behaviours).
- [x] **MAPPING_ROWS v3** — 20 active rows. Four commission lines each with ONE source, the four D11 standalone lines, GENM, single-row GENO, both income lines, Dealer Fee. All v1 safety rules preserved (exact literals, `RESIDENTAL`, `<N/A>`, sum-into-one, skip-zero expense-only, income-always, fail-loud on ≠1).
- [x] **Three v1 rows collapsed because v2 field meanings changed them into double-counts:** GENO 3→1 (`Total_Other_Budget__c` already contains CO fee + permit), GENA sum→1 field (`Audit_Labor_Cost__c` is already audit+QA), SLMC + SLPC-overhead → the single `Management_Commission_Amt__c`. Each has a test named for the double-count it prevents.
- [x] **Setter source fixed:** `Geo_Commission_Amount__c` (input rate, always 70) → `Setter_Commission_Amt__c` (what applied, 0 with no setter). v1 would have posted 70 on every job.
- [x] **`*` added to the amount-expression grammar** so SOFTWARE and REFERRAL can read `Price__c*Qty__c` — they have no dedicated output field (extras-only by the gap review) and the push reads fields, not the calc's return value.
- [x] **Two fail-loud guards:** `commission_deal_type_ambiguous` (both rep amounts non-zero — skip-zero can't catch it since neither is zero) and `pending_harvest_line_has_value` (a non-zero DC rebate with no harvested key aborts rather than dropping the income).
- [x] **v2-DATA ROLLOUT GUARD** — `Commission_Deal_Type__c` must be populated before anything is written. Only budgetCalc v2 sets it, so blank = the record's stored numbers came from the v1 engine. Without this, a v1 record pushed through v3 mapping **succeeds silently with a wrong budget** (GENO missing CO fee + permit, zeros to the four D11 lines, nothing to SLPC OUT) — every key still matches, so nothing fails. Enforced twice: `handleHttp` Gate 1b → **409 `BUDGET_CALCULATED_BY_PREVIOUS_ENGINE`** ("Budget was calculated with the previous engine — run Recalculate Budget first.") so the button fails immediately rather than 202-then-async-fail; and in `writeBudgetLines` for the worker / dry-run / direct-invoke paths. **`'None'` is a VALID v2 marker** (calc ran, no rep PPW populated) — the test is emptiness, not label membership.
- [x] **SOFTWARE + REFERRAL amount source confirmed:** price × qty read straight off the adder fields (`Adder_Software_Fee_Price__c * Adder_Software_Fee_Qty__c`, same for Referral). Both have no dedicated output field; the push reads record fields, not the calc's return, so it multiplies itself — identical to what the calc computes for a pass-through row.
- [x] **28 tests** for a Lambda that had none; suite **321** green.
- [!] **⛔ GATE — TIM: run the two reconciles.** Payloads, output-reading commands and the five pass conditions: `docs/integrations/acumatica-budget-push.md` → "v3 RE-HARVEST RUNBOOK". Supply a live **RS** Solar record id and a live **RSDC** one. **No v3 push until both come back with `problems: []`.**
- [ ] **5 of 20 keys are `provisional`** — 3rd-party commission (`SLPC  OUT · OTHER · M1&M2COM`, note the TWO spaces) and the four standalone lines (ENGR / SUBCON / SOFTWARE / REFERRAL). A wrong guess aborts the push loudly rather than mis-posting, but each must be confirmed and flipped to `harvested`.
- [ ] **DC REBATE has no key at all** — declared in `PENDING_HARVEST_ROWS`, deliberately outside the active mapping so RS projects still push. Fill it from the RSDC reconcile and move the row into `MAPPING_ROWS`.
- [ ] **Q12a — does the live RS scaffold contain REFERRAL / SOFTWARE / ENGR / SUBCON?** D13 says REFERRAL is a new task code absent from the v1 sandbox scaffold. If it is missing from live too, that is an **Acumatica template change**, not a code fix.
- [ ] **Q12b (Harmon):** does BALANCE income include the DC rebate, or does the rebate stand alone? v3 assumes stand-alone so the two cannot double-count.
- [ ] **Q12c (Harmon):** is `DLR` genuinely an expense line? The calc already subtracts the dealer fee from Balance of Revenue, so carrying the v1 expense row may be a v1 double-count. Kept for now because dropping a line that exists in the live scaffold would leave it unwritten.
- [ ] **Then:** MAPPING_ROWS freeze and the supervised live end-to-end. ~~RSDC template selection (`resolveProjectTemplate`)~~ **DONE 2026-08-26** — see below.

### RS/RSDC template selection — **BUILT 2026-08-26** (branch `fix/rsdc-template-selection`, NOT deployed)

Production bug: Layer-1 hardcoded `resolveProjectTemplate(DEFAULT_PROJECT_TYPE)` with a map
containing only `RS`, and selected no domestic-content field at all. Every project ever created
was scaffolded RS. Specified in the rework doc since the first draft, never implemented.

- [x] **`sundial-acumatica-push`** — `PROJECT_TEMPLATE_MAP` gains `residential_solar_dc: "RSDC"`;
      new `isDomesticContentEligible(cust)` picks the project type per record;
      `Domestic_Content_Eligible__c` added to `CUSTOMER_FIELDS` (existing SOQL, no second query);
      `summary.project.domesticContentEligible` added next to `summary.project.templateId`.
- [x] **`sundial-budget`** — the DC rebate toggle moved OFF `Sundial_Solar__c.Domestic_Content__c`
      (free text, permissive parse) ONTO `Sundial_Customer__r.Domestic_Content_Eligible__c`, the
      same picklist the template reads. One field drives both, so they cannot disagree —
      which is the exact state the DCREBATE row aborts on. `Domestic_Content__c` is out of
      `INPUT_FIELDS` and **is no longer read by any Lambda**.
- [x] **`sundial-acumatica-budget-push` needs no change** — its DCREBATE row keys off the calc
      output `DC_Rebate_Amount__c` and off which scaffold exists. Verified, nothing there reads
      `Domestic_Content__c`.
- [x] **Tests green** — suite 496 (budget 208 checks incl. both DC branches + the picklist rule).
- [!] **TIM: remediate the one known production project** created RS that should have been RSDC —
      delete-and-recreate in Acumatica. Not fixable by this code change.
- [ ] **Deploy** `sundial-acumatica-push` + `sundial-budget` after review.
- [ ] **Stale metadata:** `salesforce/v2-budget-output-fields/generate.mjs` still describes
      `DC_Rebate_Amount__c` as keyed off `Domestic_Content__c`. Needs a metadata deploy to fix;
      left alone deliberately.

### Harvest applied (2026-08-20, D18) — R261077 RS / R261066 RSDC

- [x] **`SLPC OUT` is ONE space.** Both live scaffolds agree; the REVISED sheet's two-space H7 label is a typo. Key fixed, `keyStatus` → harvested, test asserts the single-space form.
- [x] **ENGR / SUBCON / SOFTWARE confirmed present** exactly as §5 guessed — all three flipped provisional → harvested. **No provisional keys remain.**
- [x] **DCREBATE activated** with the harvested key `DCREBATE | BILLING | <N/A> | Income`, **conditional**: present (RSDC) → income-always, written even at 0; absent (RS) → inactive at 0, but **aborts** when the rebate is non-zero with a message saying the project needs the RSDC template. `PENDING_HARVEST_ROWS` is now empty — kept (not deleted) as the mechanism for the next unkeyed line.
- [x] **Q12b settled by live math: BALANCE excludes the rebate.** No change to the BALANCE row.
- [x] **REFERRAL confirmed ABSENT from the live template** (both projects, as D13 predicted). Marked `scaffoldOptional` with `keyStatus: harvested_absent`.
- [x] **Skip-zero now runs BEFORE the ≠1-match check** for expense rows — the actual fix, and applied generally, not just to REFERRAL. Requiring a scaffold line for a row you are not going to write to is not a safety property, and under the old order the missing REFERRAL line failed **every** push including the ~all jobs with no referral fee. **Income stays exempt** (income-always must match or fail) and **reconcile stays structurally strict** (no amounts = every non-optional row must match), so the leniency exists only where there is genuinely nothing to write.
- [x] **New `inactive` bucket** alongside `matched`/`problems` — rows correctly doing nothing on this project, surfaced rather than swallowed.
- [x] **Reconcile output refreshed** from the v1-era `gate5b` strings to the v3 gates.
- [x] **Harvest dumps committed** at `lambdas/sundial-acumatica-budget-push/harvest/` and regression-tested, so a template change under us fails a test instead of a push. 38 vs 39 lines; the RSDC delta is exactly the one DCREBATE line (asserted).
- [x] **Offline re-verify: RS 19 matched / 2 inactive / 0 problems · RSDC 20 matched / 1 inactive / 0 problems.** (The brief predicted 18/19 — the extra one is the `SLPC OUT` fix moving a row from problems into matched.) 38 tests in this Lambda, suite **331** green.
- [ ] **TIM: re-run the live reconcile after merge/deploy** to confirm against the org rather than the saved dumps.
- [!] **HARMON: add a REFERRAL line to the RS + RSDC templates.** Until then any job carrying a referral fee aborts with "Acumatica template has no REFERRAL line…". Jobs without one are unaffected.
- [ ] **Q12c still open (Harmon):** is the `DLR` dealer-fee expense line correct, given the calc already nets the dealer fee out of Balance of Revenue?
- [ ] **Gate 5b still open:** Harmon sign-off on setter commission → APPT COM.

## v2 budget — output fields + field alignments (2026-08-20, two packages)

Gap list reviewed + approved. **Both packages are PACKAGE-ONLY — Tim deploys.** Then MAPPING_ROWS v3.

### Package 1 — `salesforce/v2-budget-output-fields/` (ADDITIVE, 8 fields, Solar only)
- [x] The §D approved set: `Internal_Rep_Commission_Amt__c`, `Management_Commission_Amt__c`, `Setter_Commission_Amt__c`, `Commission_Deal_Type__c` (restricted picklist `3rd Party`/`Internal`/`None`), `DC_Rebate_Amount__c`, `Engineer_Stamps_Cost__c`, `Subcontractor_Cost__c`, `Total_Other_Summary__c`. All Currency(16,2) except the picklist.
- [x] **Collision check clean** on both objects, live describe 2026-08-20.
- [x] Gap doc updated with the disposition table — 8 got homes, 7 stay `extras`-only (fine for now).
- [ ] **TIM: deploy.** Explorer-zip → Workbench → Check Only (expect 8/8) → deploy → **FLS: integration user Edit, everyone else Read-only** (they are calc outputs; an editable one is a trap the next recalc overwrites).
- [ ] **FOLLOW-UP (calc side, not built): promote the 8 from `extras` into the `fields` map** in `budgetCalc.js` so `handler.js` actually writes them. Deploying the metadata does NOT populate them. Small change; deliberately not bundled so the fields can land first.

### Package 2 — `salesforce/v2-field-alignments/` (⚠️ MODIFY, 20 fields)
- [x] **Generated by reading each field's LIVE definition and changing exactly one attribute.** A modify deploy replaces the whole field definition, so descriptions/help/defaults are carried through verbatim rather than re-typed. `generate.mjs` re-reads the org every run.
- [x] Defaults: `Battery_Install_Hours__c` 0→16 and `NS_Adder_1/2/3_Markup_Percent__c` →25, **on BOTH objects** — both are create-mapped, so Solar-only would be overwritten by a blank Customer value on every new project. Divergent types preserved (Solar `Percent(14,4)` / Customer `Percent(3,3)`).
- [x] Relabels: `Adder_Upgrade_225_Price/Qty` → "225 Upgrade-Overhead" (each object's own label style preserved), `Gateway_Unit_Cost`/`Gateway_Qty`/`Gateway_Cost` → "Tesla Expansion Pack …".
- [x] **`Sales_Rep_Commission_PPW__c` EXCLUDED — already relabelled in the UI** to "3rd Party Rep Commission $/W" (verified both objects). The generator asserts the expected label and warns if it ever finds otherwise.
- [ ] **TIM: decide the one `[OPT]` entry.** `Internal_Rep_Commission_PPW__c` label → "Internal Rep Commission $/W", for consistency with the `$/W` form you chose. **Not in the brief** — delete the two `optional: true` entries from `generate.mjs` and re-run to drop it.
- [ ] **TIM: REGENERATE before deploying** (`node salesforce/v2-field-alignments/generate.mjs`) so carried-over attributes match production at deploy time. Then Explorer-zip → Check Only (expect 20/20) → deploy. **No FLS step** — a CustomField modify does not touch FieldPermissions.
- [ ] **TIM: verify descriptions survived** — that is the attribute a bad modify package silently eats. Spot-check `Battery_Install_Hours__c` (default 16, description still starts "TOTAL battery install hours (S3). CAUTION: …") and `Gateway_Unit_Cost__c` (label changed, default still 878.64, description intact).
- [!] **Defaults do NOT backfill.** Every existing Solar record keeps `Battery_Install_Hours__c = 0` and will keep producing **zero battery labor** until someone sets it. That is a data fix, not a metadata one — decide whether it needs a bulk update.
- [ ] Known cosmetic follow-up: the `Gateway_*` **descriptions still say "Gateway"** (e.g. "Unit cost of Tesla Gateway (or equivalent)"). Only labels were in scope.

### Excluded by decision
- [ ] **`Domestic_Content__c` text → checkbox conversion — SEPARATE TASK, not in either package.** A type conversion is a different risk class from a default or label: it rewrites stored data, can fail partway on rows whose text does not convert, and is not cleanly reversible. The calc parses the text permissively (`YES`/`Y`/`true`/`1`, case-insensitive, defaulting to NO) so nothing is blocked. Worth doing — a free-text field driving a $0.45/W income line is fragile — but on its own, with a data audit first.

### Zip discipline (all three v2 packages)
- [x] READMEs now carry the warning: **Explorer "Send to → Compressed (zipped) folder" only. NEVER PS 5.1 `Compress-Archive`** — it writes backslash path separators and Workbench cannot read the entries, failing with a misleading "no components" error. Added to the adder package README too.

## budgetCalc v2 — REVISED workbook engine (2026-08-20, Workstream B)

Plan: `docs/integrations/acumatica-budget-rework-v2.md` §3/§4, D1/D9-D17. Branch `feat/budget-calc-v2`. **Build + fixture only — NOT deployed. No MAPPING_ROWS, no push-lambda changes.**

- [x] **`template/budget-template-v2.xlsx` committed** (was untracked) and wired into `budgetWorkbook.js` + `prebuild.mjs`. **HOLLAND template + fixture DELETED**, not commented out (D1).
- [x] **`budgetCalc.js` rewritten to the REVISED layout.** Cell map rebuilt (E7 watts, F-column material, I/J summary block, adder rows 40-63, NS blocks 68/76/84/92/100).
- [x] **Commission model v3** (D9/D10/D16/D17): four inputs; management stored as two fields and summed for the SLMC line but kept split in outputs (attributes need MGRCOM*/MGMTOR* apart); setter gated on `Sundial_Customer__r.Setter__c` read-through; burden 75% × (internal + mgmt + setter), third-party excluded. **Both rep PPWs > 0 → hard error** (`COMMISSION_DEAL_TYPE_AMBIGUOUS`).
- [x] **Cost model** (D15): always reads `Adder_<X>_Cost__c`, never derives. Per-UNIT × qty flat; per-WATT × watts for Conduit Attic / Flat Roof / Roof Tile / Bird Blocking. **A blank Cost on a SELECTED adder throws** (`ADDER_COST_MISSING`) rather than costing zero.
- [x] **Full catalog + rollups** (§3, D11/D12/D13/D14): Tesla Expansion Pack on `Gateway_*`; adder labor at the Powerwall rate except Site Audit + Travel (blended); NS ×5 at the Powerwall rate; SUBCON stamps + subcontractor, SOFTWARE, REFERRAL as their own lines and all inside Total Job Cost; GENO absorbs Active Monitoring + LR Warranty; small systems revenue-only.
- [x] **DC rebate** 0.45 × watts. **Source field: `Sundial_Solar__c.Domestic_Content__c`.**
- [x] **`handler.js` INPUT_FIELDS** → 112 (new price/qty, 12 Cost fields, NS 4-5, `Internal_Rep_Commission_PPW__c`, `Domestic_Content__c`, `Sundial_Customer__r.Setter__c`). Nothing else in handler.js changed. Read-through SOQL verified live.
- [x] **166 checks green** (86 workbook cells / 48 SF fields / 14 extras / 18 behaviours), tolerance 0.011 — and the budget fixture is now **inside `npm test`** (it was a standalone script that could rot unnoticed).
- [!] **TIM — REVIEW `docs/integrations/budget-v2-output-gap.md` and decide.** 13 v2 values have no Salesforce field (internal + management + setter commission amounts, deal type, DC rebate, the four SUBCON/SOFTWARE/REFERRAL lines, N13 summary other, NS 4/5 totals). **No fields were invented** — they are returned in the calc's `extras`. A suggested minimum set of 8 is in §D of that doc. **Nothing is blocked on this**; it matters for the portal, reconcile, and post-hoc "why did margin move".
- [!] **TIM — 4 existing output fields CHANGED MEANING.** `Sales_Rep_Commission_Amt__c` is now third-party-only (0 on an internal deal); `Total_Other_Budget__c` is now the GENO line and **contains** `Constructive_Ops_Total__c` (double-count trap for any UI summing both); `Audit_Labor_Cost__c` is now audit+QA; `Total_Labor_Budget__c` is labor WITHOUT burden. Table in §A of the gap doc. The portal must be updated before it shows v2 numbers.
- [ ] **Follow-up: `Battery_Install_Hours__c` default is 0 in the org**, not 16 (§3 wants 16, BRADS had 20). Describe-verified 2026-08-20. A fresh Solar record gets zero battery labor until someone sets it. Belongs in the existing-field follow-up package with the relabels.
- [ ] **Follow-up: `Domestic_Content__c` is unrestricted TEXT.** A free-text field driving a $0.45/W income line is fragile; the calc parses affirmatives permissively and defaults to NO, but a picklist or checkbox is the right shape (sheet D3 is a YES/NO validation list).
- [ ] **NOT deployed.** No `deploy.ps1` run. Deploying replaces the live calc AND the snapshot template in one step, so it should follow the gap-list decision and a portal update, not precede them.
- [ ] **NEXT (Workstream C, separate task):** MAPPING_ROWS v3 + live RS/RSDC re-harvest (Q12). The calc emits every line the mapping needs, including the four D11 lines the v1 scaffold has no home for.

## v2 budget rework — SF field package (2026-08-20, Workstream A)

Plan: `docs/integrations/acumatica-budget-rework-v2.md` §4. Package: `salesforce/v2-budget-adder-fields/` (**58 fields**, Metadata API v62.0). **Package only — nothing deployed, no code changed.** Amended 2026-08-20 for D15 + the §4d addendum.

- [x] **§4a — 28 fields.** 7 new adders × Price + Qty × both objects. Price `Currency(16,2)` defaulted per the sheet catalog (2500 / 2950 / 350 / 750 / 100 / 600 / 500), Qty `Number(18,0)` default 0. All seven are flat-priced.
- [x] **§4b — 16 fields.** NS adder blocks 4 and 5 × 4 fields × both objects. **Types cloned per object from NS 1-3 on the live describe, which diverge:** Customer is `Percent(3,3)`/`Number(5,1)`, Solar is `Percent(14,4)`/`Number(17,1)` — neither matches the `Percent(3,4)`/`Number(16,2)` in the plan text. Markup defaults to 25 on both.
- [x] **§4c — 12 fields, Solar only. AMENDED per D15: every field now carries a STATIC DEFAULT** (261.40 / 341.40 / 175.20 / 1540.80 / 3220.80 / 1260.80 / 2175.20 / 250.00; per-watt 0.052 / 0.052 / 0.009 / 0.06). All null-=derive language removed from descriptions and inline help, replaced with the **per-UNIT (× Qty) vs per-WATT (× watts)** semantic and "changing an adder's PRICE does not auto-move its COST". The calc always reads these and never derives, so **a blank Cost field is now a bug, not a signal**. Every default re-derived from `(price − hours × 33 × 1.75) ÷ 1.25` and matched against the doc table.
- [x] **§4d addendum — 2 fields.** `Internal_Rep_Commission_PPW__c` on both objects, default 0, label "Internal Rep Commission PPW". Type cloned from `Sales_Rep_Commission_PPW__c`, which is a **`Number`, not a Currency**, despite its "$/W" label — `Number(4,3)` on Customer, `Number(15,3)` on Solar. Per D16 this field decides deal type: internal > 0 → payroll only, no POs.
- [x] **Collision check:** all 58 API names vs the live describe, 2026-08-20 — **zero hits** on either object (`Internal_Rep_Commission_PPW__c` re-checked when added).
- [x] **Per-watt 3 dp CONFIRMED, no longer a judgement call.** All four D15 per-watt defaults (0.052 / 0.052 / 0.009 / 0.06) land exactly inside 3 dp, so `Number(15,3)` matching the price side loses nothing.
- [ ] **TIM: deploy the package.** Zip the folder *contents* (package.xml at zip root) → Workbench → Migration → Deploy → Single Package → **Check Only first**, expect **58/58**, then deploy for real.
- [ ] **TIM: FLS — three audiences, and nothing works without it.** (a) integration user Edit on all **35 Solar + 23 Customer** fields (it already holds Edit on the existing adder/NS/PPW fields — mirror that); (b) rep-facing profiles Edit on the Customer Price/Qty + NS fields **and `Internal_Rep_Commission_PPW__c`** (a point-of-sale input), **mirroring whatever the existing equivalents grant** — the exact profile list could NOT be read from this session (the integration user lacks *View Setup and Configuration*, so `FieldPermissions` returns `INVALID_TYPE`); the README carries the SOQL to run as yourself; (c) **Cost fields are back-office-edit-only pending your call** — and now that they carry visible defaults they are *more* inviting to fiddle with, not less.
- [ ] **TIM: decide the Cost-field FLS** (recommendation: integration + back-office/PM Edit, reps read-only or hidden). Apply consistently across all 12 — the portal renders them as one section.
- [ ] **TIM: verify step for Cost fields is INVERTED from the previous build.** A new Solar record must show **every** Cost field PRE-POPULATED (Sub Panel 261.40, Structural 250.00, Bird Blocking 0.060, Roof Tile 0.009). **A blank one means the default did not take** — stop before anyone enters data, because the calc will read it as a zero-cost adder and silently inflate margin.
- [!] **D17 BLOCKER — `Setter__c` does not exist on `Sundial_Solar__c`.** Describe-verified 2026-08-20: Customer has `Setter__c` (Lookup → `Sundial_User__c`) **and** `Setter_Name__c` Text(120); **Solar has no setter field of any kind**; `harmon-crm/src/config/customer-to-solar-map.ts` explicitly excludes it (*"Sundial_Solar__c has no corresponding field"*). The calc runs Solar-side, so D17's setter-commission rule cannot fire. **Decide the shape before the calc work needs it:** a Solar `Setter__c` lookup + mapping entry (matches Customer, supports "any setter"), or a text mirror like `Sales_Rep_Name__c`, or read through `Sundial_Customer__c` from Solar. Not in this package — it is a calc dependency and a design call.
- [ ] **Follow-up (changes to EXISTING fields, deliberately not in the additive package):** relabel `Sales_Rep_Commission_PPW__c` → "3rd Party Rep Commission PPW" (its meaning changes the moment the internal field exists, so this should follow closely behind the deploy); relabel `Adder_Upgrade_225` → "225 Upgrade-Overhead"; relabel `Adder_Structural_*` → "Structural-Electrical Engineer Stamp"; relabel `Gateway_*` → Tesla Expansion Pack; Battery hours default 20 → 16; align `NS_Adder_1-3_Markup_Percent__c` default to 25 (currently 0 on Solar, unset on Customer — so the five NS blocks will not behave alike until this lands).
- [ ] **Minor: label convention.** New field is "Internal Rep Commission PPW" per spec; its siblings are "… Commission $/W". Say the word and it becomes "$/W" — one line in `generate.mjs`, before deploy.
- [ ] **DOWNSTREAM, NOT BUILT — §4g Create Project mapping additions.** The 23 new Customer fields are **inert until `customer-to-solar-map` copies them**; a deployed package alone does nothing for Create Project. Add the 14 §4a Price/Qty pairs, 8 §4b NS 4/5 fields, and `Internal_Rep_Commission_PPW__c`. **Never map the §4c Cost fields** — Solar-only by design.
- [ ] **DOWNSTREAM, NOT BUILT — portal config-sheet additions (harmon-crm).** Budget input sections for the 7 new adders, NS blocks 4/5, the COST adders (now with defaults — the UI hint is "per unit × qty" / "per watt", **not** "blank = use default"), and the two rep-PPW inputs with the D16 both-populated validation error. Per §10 Workstream F.

## @-mention alerts + user preferences (2026-08-18, D-056)

Runbook: `docs/integrations/comment-mention-alerts.md`. **Backend ships first** — harmon-crm's Settings UI cannot read a table that doesn't exist. Nothing here is applied or deployed yet.

- [x] **`sql/sundial_user_preferences.sql`** — `user_preferences` (`comment_email_alerts`, `default_list_view`) with RLS gated on `auth.uid() = user_id` for select/insert/update, no delete policy. **Separate table, not columns on `profiles`** — RLS is row-level, so a self-serve toggle on the server-owned `profiles` row would also let a user rewrite their own `tenant_id`/`role` (D-056).
- [x] **No backfill; absence means alerts ON.** Both readers apply the default. Do not insert rows for existing users.
- [x] **Stored value is `'list'`, not `'table'`** — harmon-crm's `ViewMode` is an implementation detail; the stored word is the cross-repo contract.
- [x] **`sql/sundial_comment_mention_notify.sql`** — `pg_net`, `comment_mentions.notified_at` + partial index, and an `AFTER INSERT` trigger that posts to the Lambda. Wrapped so it can **never block or fail the insert**; `RAISE WARNING`s rather than no-opping silently when unconfigured.
- [x] **`lambdas/sundial-comment-notify`** + `POST /webhooks/comment-mention` — the third public non-JWT route. Shared secret, constant-time compare, fails closed. Every business skip is a 200 with a `reason`; `notified_at` stamped only on a successful send.
- [x] **`lib/secure-compare.js`** — `constantTimeEquals` extracted from `sundial-welcome-call/webhook.js` (which now imports and re-exports it) so all three webhook gates share one comparison.
- [x] 33 tests (suite 284, green); esbuild bundle verified.
- [ ] **TIM: apply `sql/sundial_user_preferences.sql`.** Independent of everything else — this alone unblocks the harmon-crm Settings UI.
- [ ] **TIM: create the Lambda** (Node.js 22.x, arm64, `index.handler`, `sundial-lambda-execution-role`, 30 s / 256 MB is plenty) then `.\deploy.ps1 sundial-comment-notify`.
- [ ] **TIM: secret `sundial/comment-notify`** with `{ "comment_notify_secret": "<long random>" }`, plus env `PORTAL_BASE_URL`. Confirm the role's `secretsmanager:GetSecretValue` pattern covers `sundial/comment-notify`, and that it has `ses:SendEmail`.
- [ ] **TIM: `.\scripts\wire-comment-mention-route.ps1`**, then verify an unsecreted POST returns **401**.
- [ ] **TIM: apply `sql/sundial_comment_mention_notify.sql`, then set the two database settings** (`sundial.comment_notify_url`, `sundial.comment_notify_secret`). **Order matters** — wire and verify the route first; the trigger swallows post failures by design, so an unwired route loses notifications silently. `ALTER DATABASE … SET` only applies to new connections.
- [!] **`pg_net` availability is UNVERIFIED.** This session only had the Supabase service-role key (PostgREST), so `pg_available_extensions` could not be checked. It ships with every Supabase project and the migration does `create extension if not exists pg_net`, but if that line errors: **STOP and say so** — do not fall back to a Dashboard Database Webhook (D-056 explains why).
- [ ] **Waits on SES** (see the SES item below). Until `EMAIL_FROM` is set the Lambda returns `email_not_configured` and stamps nothing, so the whole backlog replays once it lands: `select id, comment_id, mentioned_user_id from comment_mentions where notified_at is null;`
- [ ] **harmon-crm (separate session):** the Settings page reading/writing `user_preferences`, mapping `'list'` ↔ its internal `'table'` in exactly one place, and defaulting a missing row to alerts-on.
- [ ] **When the Service module lands:** one entry in `RECORD_PATHS` (`lambdas/sundial-comment-notify/content.js`). Until then service comments link to `/dashboard` and log a warning naming exactly that.

## Welcome Call — Retell voice verification (2026-08-17, D-054)

Runbook: `docs/integrations/retell-welcome-call.md`. **No portal UI** — do not add one (D-054 explains why a "Call now" button was rejected).

- [x] **`lambdas/sundial-welcome-call`** — one Lambda, two entry points routed by event shape. Platform-event path: fresh Salesforce read → eligibility guard → Retell `create-phone-call` → SF/cache/Realtime writeback. Webhook path: signature → Zapier ledger forward → outcome mapping → writeback.
- [x] Describe guard with **candidate API names** per logical field — the org has `Due_at_Green_Tag_Amount__c`, the spec says `Due_at_Greentag_Amount__c`; both resolve. A missing field renders as `not provided`, never an error.
- [x] `finance_source` from `Financing_Partner__c` alone, with **dash folding** (the live picklist mixes an EN DASH and an ASCII hyphen — a literal compare silently skips half the prepaid-lease customers).
- [x] Route script for **both** routes (`scripts/wire-welcome-call-routes.ps1`) + `docs/api-endpoints.md`.
- [x] **`lib/realtime.js`** — first Supabase Realtime *sender* in the backend (HTTP broadcast endpoint, not a WebSocket channel). Available to any Lambda that wants the write-path broadcast the caching doc describes.
- [x] **Recording archival** — the webhook downloads `recording_url` (https only, no credentials, 20 s / 50 MB caps) and writes it to `SUNDIAL/{customerId}/welcome-call-{YYYY-MM-DD}-attempt-{n}.mp3` in `sfsolproj`, registered in `sundial_file_metadata` (`Welcome Call Recording` / `Wattson (system)`). Retell's URL expires; this one doesn't. Free portal Files tab + XFiles Pro + Dropbox mirror. Non-fatal end to end — a recording failure never blocks the Salesforce writeback.
- [x] **Orphan holding prefix + `POST /welcome-call/orphan-match`** — rep-form calls park at `SUNDIAL/_orphan-welcome-calls/{call_id}.mp3` with the key forwarded to the ledger as `s3_recording_key`; the sweep promotes them. Idempotent *backwards* (the op deletes its own input, so a retry searches for the destination instead of re-deriving it) and self-healing on a failed log append.
- [x] **`findFileMetadataByKey`** in `lib/file-access.js` — closes the duplicate-metadata-row trap for every best-effort writer, not just this one.
- [x] 76 tests (suite 218, green); esbuild bundle verified.
- [x] **DEPLOYED 2026-08-17.** Function created (Node.js 22.x / arm64 / `index.handler` / `sundial-lambda-execution-role` / **60 s / 512 MB**) via CLI rather than the console, code deployed with `deploy.ps1`, and **both routes are LIVE on the prod stage** (`wire-welcome-call-routes.ps1 -Yes`). Verified against the live URLs: an unsigned `POST /webhooks/retell` → **401** `{"error":"unauthorized"}`, a badly-signed one → 401, `POST /welcome-call/orphan-match` with no secret → 401 (fails closed), OPTIONS preflight → 200. Both gates reject before doing anything, which is the correct live behavior. **Note:** the stage deployment was checked first — `budget/recalc` was already live, so only the two new routes went live with it.
- [~] **TIM (Salesforce): create the platform event `Sundial_Welcome_Call_Request__e`** — **IN PROGRESS 2026-08-18:** Tim is configuring the platform event and both Flows now. Flip to `[x]` once a live describe shows the event and a test publish reaches the webhook.
  - (original scope below)
- [ ] **TIM (Salesforce): create the platform event `Sundial_Welcome_Call_Request__e`** with field `Customer_Id__c` (Text 18). **It does not exist in the org yet** — verified against the live describe. Nothing works until it does.
- [!] **TIM (Salesforce): the two publisher Flows** — record-triggered on the `Stage__c` "sold" transition, and a scheduled retry Flow for `Welcome_Call_Status__c = 'No Answer'` AND `Welcome_Call_Attempts__c < 5`. Both publish the same one event with `Customer_Id__c = {!$Record.Id}`. **Neither needs guard logic** — the Lambda's eligibility guard is the single authority, so an over-eager Flow is a logged no-op.
- [!] **TIM (Salesforce + AWS): Event Relay → EventBridge rule** targeting `sundial-welcome-call`, plus the `events.amazonaws.com` invoke permission. Expected rule shape is in the runbook. The Lambda also parses an SQS-wrapped envelope, so an SQS relay works with no code change.
- [!] **TIM (AWS): secret `sundial/retell/api`** (`api_key`, `webhook_secret`, `zap_orphan_match_secret`) + env vars `RETELL_FROM_NUMBER`, `RETELL_AGENT_ID`, `ZAPIER_RESULTS_HOOK_URL`. Credentials resolve **secret-first** so they rotate without a redeploy. Confirm the execution role's `secretsmanager:GetSecretValue` resource pattern covers the new secret.
- [!] **TIM (AWS): confirm the execution role keeps `s3:DeleteObject` on `sfsolproj/SUNDIAL/*`.** New for Sundial with this feature (orphan-match deletes the holding object after copying). `AmazonS3FullAccess` covers it today; this only matters if the role is ever tightened.
- [!] **TIM (Zapier): the orphan sweep.** For ledger rows with no `sf_record_id` but with `s3_recording_key`, identify the customer and `POST /welcome-call/orphan-match` with `{call_id, sf_record_id}` and header `X-Sundial-Zap-Secret`. Safe to retry; daily is plenty. A row *without* `s3_recording_key` has nothing parked — skip it.
- [ ] **Watch `SUNDIAL/_orphan-welcome-calls/` periodically.** Objects should not accumulate; anything weeks old is a call the sweep never matched. **No lifecycle rule, deliberately** — auto-deleting an unmatched recording of a contract conversation is the wrong default.
- [!] **TIM (Retell): the agent + webhook URL.** Prompt must branch on `finance_source` and must treat the literal string `not provided` as "unavailable, don't say it". Post-call analysis must emit the `custom_analysis_data` keys in the runbook. Webhook signing secret must match `RETELL_WEBHOOK_SECRET`.
- [!] **TIM (Zapier): dedupe the billing-ledger Zap on `call.call_id`.** The ledger forward is unconditional and happens before the Salesforce writeback (deliberate — see D-054), so a Retell redelivery posts twice even though the Salesforce side is idempotent.
- [x] **Rep-form call results now reach Salesforce — RESOLVED as option (a), 2026-08-19 (D-055).** `POST /welcome-call/orphan-match` re-reads the call from Retell (`GET /v2/get-call/{call_id}`) and writes the FULL result through the same `mapOutcomeToStatus` + `buildResultLogEntry` the webhook uses, so a backfilled entry and a live one are structurally identical (asserted byte-for-byte). A terminal status is never overwritten — the entry is appended marked `(status unchanged, record already terminal)`; `Calling` counts as non-terminal. `Welcome_Call_Attempts__c` is never incremented by a backfill. Degrades safely: an unreachable Retell falls back to the old one-line note and invents no status. Zapier ledger untouched. 15 new tests, 251 green, deployed.
- [x] **Result entries are no longer truncated (2026-08-19).** The 200/300/400-char clips are gone; entries are multi-line blocks carrying Call Summary / Mismatched Items / Unconfirmed Items / Follow Up / Confirmations (all six, Y/N) / Recording + Duration in full. Capacity is read from the **describe**, and overflow drops whole oldest entries with a `… older entries trimmed …` marker instead of clipping mid-entry.
- [ ] **TIM (Salesforce): raise `Welcome_Call_Log__c` to 131,072.** Still **32,768** in the org as of 2026-08-19 (describe-verified). Nothing breaks at the current size — the code reads the length from the describe and trims to whatever it finds — but at ~1 kB per entry that is roughly 30 calls of history instead of ~130.
- [ ] **Run the sweep against the two parked rep-form recordings** to exercise the backfill end to end against real records. `SUNDIAL/_orphan-welcome-calls/` currently holds `call_35e83f2cce57adea7a5b52344ec` and `call_ced35ad380c4a0fff47c8de58f9` (the Geovanna Macedo call, `verification_result: partial`, which should land as `Verified - Exceptions`).
- [ ] **Decide whether to capture `used_loan_for_prepaid`.** Retell's agent emits it (observed `"not_applicable"`); the Lambda ignores it. Real data with no home — either add it to the log line or confirm it is noise.
- [ ] **Decide whether `Contact Info Mismatch` / `Contract Values Mismatch` should be produced.** Both exist in the org picklist; the current mapping sends every mismatch to `Verified - Exceptions` with the detail in the log. Splitting them out is a small change in `webhook.js`.
- [ ] **Decide mappings for the seven unmapped financing partners** (`Aurora`, `Enfin`, `GoodLeap`, `Mosaic`, `Other`, `Sungage`, `Sunlight`). Until then those customers are skipped with a log line naming the partner — safe, but they never get a Welcome Call.
- [ ] Optional: add `welcome_call_status` / `welcome_call_attempts` / `welcome_call_log` columns to `sundial_customer_cache`. Not required — the Lambda checks for them and falls back to flagging `is_stale`.
- [~] **Verify end to end against a real record and a real phone number.** **The WEBHOOK half is now PROVEN against live Retell (2026-08-18):** a real rep-form call verified its signature, downloaded the recording, archived it to `SUNDIAL/_orphan-welcome-calls/call_f2eb80f1a2574a37a2aeede0754.mp3` (829,278 bytes, `audio/mpeg`), and forwarded to the Zapier ledger with the key — the orphan path working exactly as designed. Getting there took fixing the verifier three ways (see PROGRESS 2026-08-18) and revealed that Retell also streams `transcript_updated`, now a known ack-only event. **Still unexercised: the PLACE-CALL half** — the platform event, the two Flows, the Event Relay rule and the eligibility guard against a real customer. Nothing has dialled a real number from a Salesforce trigger yet.
- [ ] **Run the orphan sweep against the parked recording above.** There is now exactly one real object in `SUNDIAL/_orphan-welcome-calls/`, which makes it the natural first test of the Zapier sweep → `POST /welcome-call/orphan-match` → promote-and-delete path.

## Sales Rep visibility (proper feature — replaces the TEMP guard below)

### The real feature: phased plan (D-064, `docs/access-model.md` §8)

Design approved 2026-08-26. Server first in every phase; the client change of a phase
lands only after its server change is verified in prod. Branch per repo per phase:
`feature/access-model-pN`.

- [x] **Phase 0 — Discovery and hardening (2026-08-27).** No behaviour change for any
      user, verified. Branch `feature/access-model-p0`.
  - [x] `sql/snapshot-supabase.sql` — committed, re-runnable catalog introspection
        (DDL, policies, grants, definer functions, PostgREST schemas, triggers).
  - [x] **`sql/live-snapshot-2026-08-27.sql` — PRODUCED (2026-08-27).** All twelve
        blocks run through the read-only Supabase MCP server. It **corrects** §5.1:
        there are TWO tenant helpers, not one — `current_user_tenant()` reads
        `profiles` (comments/mentions) and `current_user_tenant_id()` reads
        `public.portal_users` (all six cache tables), **which holds zero rows**. The
        cache tables deny by accident, not design.
  - [!] **Block 6 of `sql/snapshot-supabase.sql` is defective** —
        `information_schema.role_table_grants` is member-filtered and returns zero
        rows for the MCP user regardless of the real grants. Re-read via
        `pg_class.relacl`: **anon and authenticated hold `arwdDxtm` (full privileges,
        writes included) on all six cache tables.** Rewrite the block before the next
        snapshot or Phase 6 verifies its revoke against a query that passes either way.
  - [x] **Pull the §3.3 cache-table `revoke` forward into Phase 1.** DECIDED as **A4**
        (D-064, 2026-08-27) and scheduled as Phase 1 item 1. The *policy drop* stays in
        Phase 6 so its diff is reviewable alone; the revoke is what carries the safety.
        Three independent accidents currently fail closed (empty `portal_users`;
        never-narrowed grants; `profiles.tenant_id` = record id vs cache `tenant_id` =
        slug). Populating `portal_users` or repointing the helper at `profiles` —
        either reads as an obvious bug fix — exposes 31,640 customer + 4,481 solar rows
        to any authenticated session with no per-rep scoping. Verified free of cost:
        nothing reads a cache table from a browser (§5.1c).
  - [x] `scripts/probe-cache-reachability.mjs` — **both halves done.** anon
        (2026-08-26): all five `sundial_*_cache` tables ROUTABLE (200, grant exists),
        zero rows. authenticated (2026-08-27, `tim+zz-rep-a1`): cache tables 0 rows,
        but **`comments` returned 485 of 485 with none authored by the rep** and
        **`comment_mentions` 14 of 14 with none mentioning them** — a cross-user leak
        within the tenant, which is what §5.3 closes. No cross-tenant row anywhere
        (weak result: Harmon is the only tenant). Recorded in `docs/access-model.md`
        §5.1a.
  - [x] `scripts/describe-access-fields.mjs` + `docs/access-model.md` §2.4a — field
        types, lookup targets, populated/blank counts, dealer picklist comparison,
        and the Dennis backfill gate measured as SET equality.
  - [x] **`user-admin` fixed** — `Hierarchy_Level__c` derived from `Access_Level__c`
        on create AND on `accessLevel` PATCH; super-admin-with-sales-role refused.
        7 unit tests. **NOT DEPLOYED** — awaiting diff review.
  - [x] `docs/access-model-phase0-user-audit.md` — all 24 active users. Exactly **one**
        is wrongly restricted today (`Temp Passtwo`, a test account).
  - [x] `scripts/seed-access-test-fixtures.mjs` — applied. 10 ZZ TEST users +
        passwords in Secrets Manager `sundial/test-users`, 3 new ZZ customers, 4 Solar
        twins, 1 ZZ Roofing. Idempotent, canary-first, ZZ-prefix guarded.
  - [x] `scripts/verify-access-matrix.mjs` — runs green, 12 surfaces × 10 users, all
        new-model expectations `pending`.
  - [x] D-064 + the D-045…D-050 numbering note appended to `DECISIONS.md`.
  - [x] **TIM: tick `Super_Admin__c`** on `tim+zz-admin@constructiveoperations.com` in
        Salesforce (D-043: Salesforce-set only). Done 2026-08-26 — the derived-hierarchy
        assertion in `verify-provisioning-e2e.mjs` no longer SKIPs.
  - [x] **TIM: review + deploy `sundial-user-admin`.** Deployed from `master`
        2026-08-26; verified live by `verify-provisioning-e2e.mjs` (18/18).
  - [ ] **Unrelated pre-existing drift found:** the designated portal test record
        `a1P7y00000AmyXCEAZ` has `Battery_Qty__c = 4` where the seed script sets `1`,
        inflating `Total_Adder_Price__c` to 46,237.50 (baseline 16,387.50) and
        `Commission_Total__c` to −26,015.50. (4−1) × 9,950 = 29,850, exactly the
        delta. Not caused by Phase 0 — the formulas have zero cross-object refs and
        Phase 0 wrote only `Sales_Rep__c` / `Linked_Solar_Project__c` to it. Fix is
        `node scripts/create-portal-test-record.mjs --apply` when convenient.

- [x] **Phase 1 — Data model and cache — DONE 2026-08-27.** Branch `feature/access-model-p1`. **Amended
      2026-08-27 by A1–A6 (D-064 "Amended 2026-08-27"; `docs/access-model.md` §Amendments).**
      Nothing on Dennis's read path is touched this phase — `sundial-sf-query`,
      `repRestrictFor` and `sundial-list-files` are unchanged.
      **All six §8 gates pass** — evidence table in `docs/access-model.md` §8.
      Nothing any live user sees changed, measured twice: the shadow report shows 20
      of 34 active users with `no change` on both objects, and verify-access-matrix
      shows the TEMP guard behaving identically post-deploy.
  - [x] **1. `sql/sundial_access_p1_cache_hardening.sql` (A4)** — revoke ALL on every
        `sundial_*_cache` table from `anon` and `authenticated`. RLS stays on, **no
        policy change**. **TIM applies** in the Supabase SQL editor; verification query
        in the file. Ships first: pure reduction in exposure, no dependencies.
        **APPLIED 2026-08-27 (cache tables now `postgres | service_role` only).**
  - [x] **2. `salesforce/v6-access-model/`** — `Sundial_Dealer__c` (`Name`, `Client__c`,
        `Is_Internal__c`, `Active__c`) + `Dealer__c` lookup on User / Customer / Solar /
        Roofing / Commercial + permission-set entries for the integration user.
        **TIM deploys** from Workbench. Everything below blocks on it being live.
        **DEPLOYED 10/10 2026-08-27; permission set assigned.**
  - [x] **3. `scripts/backfill-dealers.mjs`** — one dealer row per distinct picklist value
        across BOTH picklists (union, 110 + 56); `Active__c` only on Harmon Solar,
        Heavenly Power, Property Upgrades LLC; `Is_Internal__c` on Harmon Solar; plus the
        three §9 ZZ TEST dealers. Stamps `Dealer__c` on the ten ZZ TEST users and on
        Dennis (Harmon Solar). No other live user. Report-only, `--apply`, canary-first.
        **TIM approves the report.**
        **APPLIED — 57 dealer rows, 5 active, 7 user stamps.**
  - [x] **4. `scripts/backfill-deal-ownership.mjs`** — `Dealer__c` on Customer and Solar
        from the rep (A1), then the Solar-only alias pass for rep-less records (A2), with
        the A3 abort check. Report shows counts by outcome and the FULL near-miss list.
        **TIM approves the report before `--apply`.**
        **APPLIED — 4,312 customer + 1,203 solar.**
  - [x] **5. `sql/sundial_access_p1_cache_columns.sql`** — `sales_rep_sf_id` +
        `dealer_sf_id` on customer/solar/roofing caches (add-if-missing), `dealer_sf_id` +
        `access_level` on `sundial_user_cache`, `(client_sf_id, <col>)` indexes.
        **TIM applies**; then `sundial-cache-sync {"mode":"full"}` per object and counts
        by `sales_rep_sf_id` reconciled against SOQL. No Lambda change needed —
        `sfFieldToColumn()` already maps both references to `*_sf_id`.
        **APPLIED + full resync + reconciled against SOQL.**
  - [x] **6. `lib/access.js`** — `resolveScope`, `rowFilter`, `canReadObject`, `canAction`,
        `assertVisibleRecord` + unit tests: every access level × every object × null
        dealer × inactive dealer × unknown level, all fail-closed cases asserted. **Not
        wired into any Lambda this phase.**
        **112 unit tests; suite 641 green.**
  - [x] **7. `lib/identity.js` + `sundial-auth-proxy`** — `Dealer__c`,
        `Dealer__r.Active__c`, `Dealer__r.Is_Internal__c` in the identity SOQL; `access`
        block on `/auth/me`; `access_scope` / `access_level` / `dealer_sf_id` upserted into
        `profiles` (columns via a small SQL file **TIM applies** — no policy change, no
        client grant). **Deployed LAST**, after the columns exist, on TIM's diff approval.
        **DEPLOYED 2026-08-27 after the profiles columns + revoke.**
  - [x] **8. `scripts/access-shadow-report.mjs`** — per user, per object: old visible id
        set (TEMP rule) vs new (`rowFilter` over the cache), `onlyInOld` / `onlyInNew`.
        **TIM reviews Dennis's row and every user whose `Access_Level__c` is Technician,
        null, or not in the list** — those are the users who lose access at Phase 3.
        **Dennis onlyInOld/onlyInNew = 0; 4 widenings, all EXPECTED.**
  - [x] **9. `scripts/repair-mis-stamped-users.mjs` (A6)** — re-PATCH each mis-stamped
        user's CURRENT `accessLevel` through the live `/admin/users` endpoint as
        `tim+zz-admin` so the derivation runs. Skips Dennis and anyone whose
        `Access_Level__c` IS `Sales Rep`. Exactly **one** live user qualifies
        (`Temp Passtwo`); the 13 "derivation differs" users are NOT in scope.
        Report-only. **TIM approves before `--apply`.**
        **APPLIED — 1 user (Temp Passtwo), Sales Rep -> Client.**
  - **Gate:** Dennis `onlyInOld = ∅` on customer and solar; cache counts by
    `sales_rep_sf_id` match SOQL; unit tests green; `/auth/me` per ZZ TEST user returns
    the expected scope + `dealerId` (§9 matrix); `zz-rep-nodealer` and `zz-tech` → `none`;
    `verify-access-matrix.mjs` still passes against the unchanged TEMP behaviour.
  - [x] ~~**AMENDED BY PHASE 0:** `Sales_Company_Value__c` cannot be one unique string~~
        **RESOLVED by A1 + A2:** the field is dropped. The dealer comes from the rep, so
        no read path resolves a picklist string; the residue is a reviewed CSV,
        `docs/integrations/dealer-aliases.csv`, used only by the Solar backfill.
  - [x] ~~**AMENDED BY PHASE 0:** derive a customer's dealer from `Sales_Rep__r.Dealer__c`~~
        **DECIDED as A1**, for both objects, with a server re-stamp on every rep change.
  - [ ] **FOUND 2026-08-27 by `scripts/probe-access-model-fields.mjs`:
        `Sundial_Commercial__c` HAS NO `Client__c` AT ALL.** Every other Sundial object
        carries the tenant isolation key (required on User/Customer/Solar, optional on
        Roofing); Commercial has none. It holds **zero** records and is a 14-field Phase 3
        stub, so nothing is exposed today and the v6 package adds `Dealer__c` there
        harmlessly. **Not fixed in Phase 1 on purpose** — putting an isolation key on an
        empty object is a Commercial-build decision, not an access-model one. Fix it
        before the first Commercial record exists, or the backfill becomes a migration.
  - [x] Stamp `Dealer__c` on the ZZ TEST users — `seed-access-test-fixtures.mjs` carries
        the intended dealer per user and marks the spot with a TODO. Item 3 fills it.

- [ ] **FOUND 2026-08-27: `user-admin` must require `Dealer__c` when a PATCH moves a
      user INTO a sales role.** §1.2 resolves a sales role with a null dealer to scope
      `none` — sees **nothing**. So re-levelling a Harmon manager down to `Sales Dealer`
      without stamping a dealer in the same edit blanks their portal, and the cause is
      not obvious from the edit that caused it. All six active users in
      `docs/access-model-phase1-unattributed-reps.md` are one such edit away from it.
      Refuse the PATCH the way `SUPER_ADMIN_WITH_SALES_ROLE` is refused. **Phase 4**
      (with the rest of the user-admin work); harmless until Phase 3 enforces.

- [ ] **FOUND 2026-08-27: `lib/salesforce.js` has NO RETRY on any write path.**
      Three bulk scripts have now hit transient write failures: this phase's ownership
      backfill (~600 in a burst that recovered on its own), and
      `fix-burden-rate-percent-domain.mjs` on 2026-08-24 (2 of 4,473 with
      `fetch failed`, and the piped invocation reported success anyway).
      `scripts/backfill-deal-ownership.mjs` now carries a local 3-attempt backoff plus
      first-occurrence error printing; the shared fix belongs in `lib/`, which is bundled
      into EVERY Lambda deploy, so it wants its own reviewed diff rather than a drive-by
      during a backfill.

- [~] **Phase 1b — Comments and mentions RLS (A5, moved up from Phase 6).** Phase 0
      measured a Sales Rep reading **all 485 comments in the tenant** (510 by the time
      1b was built), none of them their own, on records they cannot open.
      `sql/sundial_access_p1b_comment_rls.sql`: the `security definer` helpers
      (`current_profile`, `record_visible`, `record_visible_for`, `user_visible`) and
      the §5.3 policies. Depends on Phase 1's cache columns and nothing else.
      **TIM applies** in the dashboard, in two parts — see the file's RUN ORDER.
  - [ ] Part A: `supabase_user_id` on `sundial_user_cache` (**TIM**), then a full user
        cache-sync (**Claude**), then Part B: helpers + policies (**TIM**).
  - [ ] V1–V13 verification; V10–V12 are TIM-only (`set role` is denied to the
        read-only MCP user).
  - [ ] `node scripts/verify-comment-rls.mjs` as the ZZ TEST users.
  - [ ] Deploy `sundial-comment-notify` with the §3.7 `record_visible_for` re-check
        (diff approved 2026-08-27; 644 unit tests green).
  - [ ] **Follow-up from the Phase 1b impact measurement — three accounts read every
        comment in the tenant today and go to zero under the new policies. That is
        correct, and two of them are a hole worth closing at the source:**
    - [ ] Ban `bradtest@harmonelectric.net` and `tim+uatest@constructiveoperations.com`
          through the deactivate path. Both are `Active__c = false` in Salesforce and
          **still have working Supabase logins** — deactivating a `Sundial_User__c` does
          not ban the auth user, so they authenticate and, until Phase 1b, read all 510
          comments. RLS now scopes them to `none`, but the login itself should go.
    - [ ] Deactivate **or** attribute `tmurphy5213+inviteuser1@gmail.com` — an *active*
          Sales Rep with a null `Dealer__c`, so §1.2 resolves it to `none`. Either give
          it a dealer (if it is still a useful invite fixture) or deactivate it.
- [ ] **Paige King's email address is misspelled in Salesforce** — `Sundial_User__c`
      `a1O7y00000sTY2PEAW` carries `paigeking@harmonelec` **`e`** `tric.net`
      ("harmonelecetric"). Found while verifying Phase 1b's Part A: she is the ONE
      active user with a Supabase login and no `profiles` row, i.e. the only person
      who has never signed in — and a bounced invite is the obvious reason. Not an
      access-model bug and Phase 1b handles her correctly either way (the
      `sundial_user_cache` fallback resolves her to `tenant`), but she has been
      unable to reach the portal since she was provisioned. Fix the address, then
      re-invite through the `/admin/users` path.
- [ ] **Phase 2 — Shadow.** `ACCESS_MODEL_MODE=shadow` in `sf-query`; ≥3 business days
      of logs with zero `onlyInNew` for Dennis; every other user reconciled and
      re-levelled before the flip.
- [ ] **Phase 3 — Enforce reads, retire TEMP.** Enforce-with-overlap, then TEMP removal
      as two separate deploys. Gate: matrix passes; Dennis's counts unchanged.
- [ ] **Phase 4 — Field manifest, writes, client cutover.** Sheets move to
      sundial-core, `generate-field-configs.mjs`, manifest loader, `?full=true`
      projection, `sf-update` row+field+protected rules, delete
      `temp-role-tab-visibility.ts`.
- [ ] **Phase 5 — Actions and files.** `canAction` in budget / acumatica-push /
      aurora-push / all four file Lambdas; `assertVisibleRecord` on customer files.
- [ ] **Phase 6 — Supabase RLS (reduced by A4 + A5).** The cache-table revoke shipped in
      Phase 1; the comments/mentions policies shipped in Phase 1b. What is left:
      `sql/sundial_access_rls.sql` **drops** the six accidental cache-table SELECT
      policies (inert after the revoke — removing a misleading artefact, not a control)
      and `public.portal_users`, plus the `profiles` policy review.
- [ ] **Phase 7 — Cleanup and docs.** `profiles.role` dropped from the upsert;
      `Hierarchy_Level__c` deprecated; `Roles__c` documented unused; api-endpoints and
      caching-architecture corrected.

- [ ] **Build per-user record visibility** (the real feature the TEMP guard stands in for). Model: roles on `Sundial_User__c` (`Hierarchy_Level__c`, `Parent_User__c`), records carry `Sales_Rep__c`/`Sunbase_Sales_Rep__c` (customer) and `Sales_Representative__c`/`Sales_Rep__c` (solar). Needs the rep field mirrored into the cache tables so filtering is cache-side (paginatable) instead of the live-SF bypass below.
- [~] **TEMP Sales Rep hard-restrict (shipped 2026-08-03)** — Harmon has ONE Sales Rep (Dennis Alessandro). Server-side, a caller with `Hierarchy_Level__c === "Sales Rep"`:
  - `sundial-sf-query`: `customer`/`solar` list + single + `?full=true` reads are filtered to `Sunbase_Sales_Rep__c`/`Sales_Representative__c` = `Dennis Alessandro`. **Rep reads BYPASS the cache and go live to Salesforce** (the authoritative field isn't cached; `sales_rep_name` is a different formula field). **Known jank:** SOQL `OFFSET` caps at 2000, so on the customer list a rep can page the first ~2000 of Dennis's 3,511 (SAFE — never another rep's records — but incomplete on deep pages). **Roofing NOT gated** (no rep field in scope; ~1 record; revisit with the real feature).
  - `sundial-list-files`: Sales Rep is blocked (403) from Solar file list/download; Customer files allowed.
  - Rep NAME is hardcoded (single rep). Remove all `TEMP` / `repRestrict` markers when the real feature ships.

## List pagination + cache backfill (fix: "exactly 50" bug, 2026-07-28)

- [x] `sfQuery` follows `nextRecordsUrl` to exhaustion (`lib/salesforce.js`) — removes the silent 2000-row truncation on every read
- [x] `sundial-sf-query` list endpoint: real server-side pagination (`limit`≤500 + `offset`, exact `total`, `hasMore`, stable `sf_id` order, per-page refresh); deployed
- [x] `sundial-cache-sync` full-resync mode (`{ "mode": "full" }`), per-run LIMIT removed; function raised to 900 s / 1024 MB; deployed
- [x] Backfill run + verified: customer 31,948 & solar 4,545 caches now match Salesforce; paginated API verified live
- [x] **List/board ordering by record created date (newest first):** `created_date` cache column (+ tenant index) on customer/solar/roofing; mapped `CreatedDate` (Solar: `COALESCE(Contract_Date__c, CreatedDate)`); endpoint `ORDER BY created_date DESC NULLS LAST, sf_id` (resilient to a missing column); backfilled + verified newest-first. Frontend needs no change (preserves backend order).
- [ ] **Frontend (harmon-crm, separate session):** send `limit`/`offset`, consume `total`/`hasMore`, add pager or load-more; boards fetch per-stage counts + lazy-load cards (must NOT pull 40k); Dashboard use aggregates not a 50-row page. See the bug report for the exact file/line changes.
- [ ] Follow-ups: server-side search/filter across the full set, list virtualization (react-window), optional `orderBy` param, EventBridge schedule for incremental `sundial-cache-sync`

## Cache deletion blind spot + reconcile mode (2026-08-11, D-051)

- [x] **Purged 5 ghost `Sundial_Solar__c` rows** from `sundial_solar_cache` (object resolved from the `a1Q` key prefix via live describe). All 5 verified `IsDeleted = true` in Salesforce first; 5 deleted, 0 remaining. No dependent rows in `asset_cache` / `sundial_po_cache` / `sundial_roofing_cache`.
- [x] **`{ "mode": "reconcile" }` on `sundial-cache-sync`** (+ `object`, `dryRun`, `force`): reads the cache id set, asks Salesforce which ids still exist, deletes the rest. Fails safe — an errored batch leaves its ids alone (`unverified`), never deleted.
- [x] Safety rail: refuse when **≥25 ghosts AND >20%** of rows checked; `force: true` overrides. Both conditions required (a ratio alone blocks ordinary small purges).
- [x] 18 tests (130 total, green); caching-architecture.md documents the blind spot + the mode; D-051.
- [ ] **DEPLOY `sundial-cache-sync`** — code is committed but NOT deployed (operator runs `deploy.ps1`).
- [ ] **Do NOT add reconcile to any EventBridge schedule without asking.** It is the only destructive path in the Lambda, and its API cost scales with cache size (~79 SOQL for the 31.6k customer cache). Manual invoke only, by decision.
- [ ] Always run `{"mode":"reconcile","object":"...","dryRun":true}` first and read the `ghosts` count before a live run.
- [ ] Optional follow-up (not scoped): propagate deletes properly via Change Data Capture / tombstones so ghosts never accumulate. Rejected for now — needs org config + a new consumer, and deletes are rare and operator-driven (D-051).

## G2 — intermittent 500s under concurrent paged loads (root-caused + page cap raised 2026-08-10)

Punchlist: `../harmon-crm/docs/HARMON_PHASE1_PUNCHLIST.md` → G2 / G2b / G2c (the punchlist's numbering is canonical).

- [x] **Root cause: the AWS Lambda "Concurrent executions" quota is 10** (default 1000), us-west-1, shared by all 32 functions. Throttled invokes never reach the function; API Gateway returns `500 {"message": "Internal server error"}` in ~65 ms with no log line and `Errors` = 0. Reproduced deterministically (12 parallel → exactly 10 pass).
- [x] Ruled out: Supabase pool exhaustion and per-invoke client construction. The Lambda talks to Supabase via **PostgREST over HTTPS** (no `pg`, no pool); client/secrets/SF-token/JWKS were already module-scope cached.
- [x] **Cache-path page cap 500 → 5000** (`MAX_LIMIT`), default 500 when `limit` is absent (was 50); over-cap clamps, `0`/negative/absent fall back. Sweep 64 → 7 requests.
- [x] **Internal PostgREST paging** (`fetchCacheRange`) — Supabase "Max Rows" is 1000 and **silently truncates**, so the clamp raise alone would have been a lie. Splits pages >1000 into consecutive `.range()` calls, one exact count.
- [x] **Bounded-parallel stale refresh** (5 concurrent `IN()` chunks) — sequential measured ~35s on a fully-stale 5000-row page, past the 30s timeout; now 13.2s worst case.
- [x] Batched cache upsert/delete; **Salesforce token stampede guard** in `lib/salesforce.js` (concurrent cold callers share one JWT round trip, cleared on settle).
- [x] Live-Salesforce list paths (cold cache, TEMP Sales-Rep restrict) keep the original 500 cap — SOQL `OFFSET` caps at 2000.
- [x] Verified: 5000 rows/5000 unique ids, zero cross-page overlap, 7-wide burst × 2 rounds = 0 failures, all objects under Lambda's 6 MB response limit.
- [ ] **TIM (console, G2b): raise the Lambda concurrency quota 10 → 1000** in Service Quotas (us-west-1, `L-B99A9384`). **This is the actual root cause and it is still live** — >10 simultaneous invocations anywhere in the account still 500.
- [ ] **TIM (console, G2b, same row): raise Supabase "Max Rows" 1000 → 5000** (Settings → API). Optional perf only; the Lambda is correct without it.
- [x] **Frontend (harmon-crm):** `DEFAULT_PAGE_SIZE` in `src/lib/api.ts` is now 5000 (done same day by the frontend session). **This constant and `MAX_LIMIT` must stay in sync** — asking for more than the server serves is silently truncated to the server's cap, not an error.
- [ ] **G2c: `GET /sf/{object}/counts?by=stage`** — server-side status counts so tab badges stay correct during partial loads. **Assessed: not a trivial aggregate.** PostgREST aggregates are disabled on this project (`select=stage,count()` → `PGRST123`), so it needs a tenant-scoped Postgres RPC (`group by`) + an API Gateway route wire (`scripts/wire-*.ps1` pattern). Small but real. **DEFERRED by Tim 2026-08-10** — with the 7-request sweep + retries, partial loads should be rare enough that the banner disclosure is acceptable for Phase 1; build it if Harmon actually hits it. **When we do: it is `stage` that drives the tab badges**, not `status`, and it would be the repo's first RPC.


## Aurora inbound — agreement webhook → queue → worker (built 2026-08-04, D-048)

- [x] **Doorbell** `sundial-aurora-webhook`: all five subscription attributes, shared-secret gate (constant-time, 5-min token TTL so rotation needs no redeploy), enqueue to SQS, **5xx on enqueue failure** to drive Aurora's retry ladder. No SF/Aurora I/O — it must answer inside Aurora's 10s deadline.
- [x] **Worker** `sundial-aurora-inbound` (SQS): all statuses update agreement tracking (deduped, precedence-ranked); `signed` also retrieves agreement/design/proposal/financing, writes the mapping to `Sundial_Customer__c`, stores the signed PDF, and emails the design manager once. Partial-batch failures → DLQ; permanent classes logged with a `PERMANENT` marker.
- [x] `lib/aurora.js`, `lib/sqs.js`, `lib/salesforce.js » describeObject`; 37 tests (14 + 23), all green.
- [x] Docs: `docs/integrations/aurora-inbound.md` (runbook), api-endpoints, salesforce-schema, aurora-api-reference (**corrected** the stale "filters to signed"), D-048.
- [ ] **Create 5 fields on `Sundial_Customer__c`** (the pipeline runs without them — the describe guard drops them and the worker reports the gap — but the data is lost until they exist):
  - `Aurora_Agreement_ID__c` — Text(100)
  - `Aurora_Agreement_Status__c` — Picklist: `sent`, `viewed`, `signed`, `cancel-pending`, `canceled`, `declined`, `error`
  - `Aurora_Agreement_Status_At__c` — Datetime
  - `Aurora_Proposal_Link__c` — URL(255)
  - `Aurora_Signed_Email_Sent__c` — Datetime. **Most important of the five:** it is the "signed processing completed" marker. Without it the duplicate guard can't persist, so a duplicate `signed` delivery re-sends the notification.
  - Grant FLS to the integration user (and the portal perm set for anything users should see).
- [x] **Infrastructure (hand-created, per `docs/integrations/aurora-inbound.md` Part B) — VERIFIED PRESENT 2026-08-17:** both SQS queues exist, the Lambda is Node 22 / arm64 / 60s / 512MB on `sundial-lambda-execution-role`, and the event-source mapping is **Enabled** with `BatchSize 5` and `ReportBatchItemFailures`.
- [x] **Deployed `sundial-aurora-inbound` 2026-08-17** (carrying the lease/PPA financing fields). The doorbell `sundial-aurora-webhook` was already deployed and its route already live.
- [ ] **Create the Aurora subscription** (Tim, Aurora console — `aurora-inbound.md` Part C): `agreement_status_changed`, **ALL** statuses, GET, the five-attribute `url_template`, and the `X-Aurora-Webhook-Token` header.
- [x] **Post-signature cancellation gap CLOSED (2026-08-04, D-048 amendment):** `canceled` / `cancel-pending` / `declined` are now confirmed with a fresh `GET /agreements/{id}` before precedence is applied — Aurora's current status wins over a recorded `signed` (and sends a cancellation email), while an event Aurora contradicts is dropped as stale. `error` stays rank-governed; exact duplicates short-circuit before the re-read. The `signed` path is unified with it: a signed event whose re-read shows a dead agreement records Aurora's status and sends the same notification. 13 tests cover both branches.
- [ ] **Operational note (not a code gap):** a confirmed cancellation after signing is now recorded and emailed automatically, but anything already started off the signed contract (project creation, scheduling, commissions) still has to be unwound by hand.
- [x] **Lease/PPA financing fields mapped (2026-08-17):** `solar_rate` → `Energy_Rate__c`, `escalation` → `Escalator__c`, `monthly_payment` → `Monthly_Payment__c`. All three exist on the org (describe-verified), and all three go through the existing describe guard, so a later rename degrades to a warning rather than a failed write-back. 8 new tests; 150 green. `Monthly_Payment__c` turned out to be **already** implemented for both branches — the doc line claiming it was "NOT mapped in v1" was stale text from 2026-07-23, superseded by the 2026-08-03 round; corrected in `aurora-api-reference.md`.
- [ ] **⚠️ Prove `escalation`'s unit against a real lease/PPA payload.** `Escalator__c` is a Salesforce PERCENT field (stores `2.9` for 2.9%), and Aurora's docs never say whether `escalation` is a percentage or a fraction — Aurora is demonstrably inconsistent here (`energy_production.annual_offset` is the **string** `"87%"`). The value is written **unconverted**, and the worker warns when it is `0 < x < 1` (the fraction tell; real escalations are 1–5%). On the first real lease/PPA agreement, compare `Escalator__c` against the signed proposal: if Aurora sends fractions, add the ×100 in `mapping.js`; either way, delete the warning once it's settled.
- [ ] **Prove `upfront_payment`'s meaning before mapping it.** Aurora lists it as a lease/PPA field with no definition. The plausible readings — a capital-cost reduction / prepayment that lowers the monthly, vs. a due-at-signing fee — belong in different Salesforce fields and mean different things to finance, and `Down_Payment_Amount__c` is the tempting target that would be wrong if it's a prepayment. Deliberately unmapped (comment in `mapping.js`); decide once a real Participate payload shows it alongside the signed proposal.
- [~] **Widen `Energy_Rate__c` to 4 decimal places — REPORTED DONE AGAIN by Tim 2026-08-18; NOT yet re-verified from this session.** NOTE: this was also reported done before 2026-08-17 and the forced-refresh describe still returned scale 2, so **verify before closing** — `describeObject('Sundial_Customer__c', { forceRefresh: true })` must return `currency(18,4)`. Prior finding below, kept until a describe confirms otherwise.
  - (2026-08-17) **REPORTED DONE, BUT NOT IN THE ORG (re-checked 2026-08-17).** A forced-refresh describe in a fresh process still returns `currency(precision 18, scale 2)`, and there is no `Energy_Rate__c` on `Sundial_Solar__c` either, so the edit didn't land on a different object. Until it does, a `$0.1425/kWh` rate stores as `0.14` — ~1.8% off on a number that feeds customer-facing math. Re-check with `describeObject('Sundial_Customer__c', { forceRefresh: true })` after saving; note that changing decimal places on a Currency field is a **Setup → field edit**, and Salesforce silently keeps the old scale if the save is abandoned at the confirmation step.
- [ ] Nice-to-have: migrate `sundial-aurora-push` onto `lib/aurora.js` (it still has its own inline Aurora config/fetch + describe cache) so there's one Aurora client.

## Aurora dealer origination — auto-create the Customer on signed (built 2026-08-07, D-049)

- [x] **Unmatched signed Aurora projects now branch** instead of dead-lettering: no `external_provider_id` → **create** the customer from Retrieve Project (upsert on the `Aurora_Project_ID__c` External ID, so duplicates/concurrency converge on one record); provider id that resolves → **repair** the missing link on our own customer and continue; provider id that doesn't resolve → `PROVIDER_ID_MISMATCH` → DLQ.
- [x] **Unmatched non-signed events dropped quietly** (no DLQ) — dealer pre-sale traffic. Still dead-lettered when they carry a provider id (our own broken deal).
- [x] Dealer attribution: `partner_id` → partner **name** via List Partners, falling back to `owner_id` → user name via Retrieve User, then the raw id. A 403 on either degrades to raw ids — it never fails an import. A 403 on **Retrieve Project** is a loud `AURORA_NOT_PROVISIONED` dead-letter (the feature depends on it).
- [x] `lib/aurora.js » getProject/listPartners/getUser`, `lib/salesforce.js » sfUpsertRecord`, `lambdas/sundial-aurora-inbound/customerCreate.js`; 21 new tests (103 repo-wide, green). Docs: aurora-api-reference (Retrieve Project surface as specced), aurora-inbound (branch table + dealer operating note), salesforce-schema, D-049.
- [ ] **Create 2 fields on `Sundial_Customer__c`** (imports succeed without them; the values are just lost and the gap is reported in the signed email):
  - `Aurora_Dealer_Name__c` — Text(255). Which dealer sold it.
  - `Aurora_Import_Notes__c` — Long Text Area(32768). Everything Aurora returned that has no field of its own (raw address, country, salutation, mailing address, partner/owner/team ids, tags, out-of-picklist values).
  - Grant FLS to the integration user; surface both on the Customer layout so the office can see a record was machine-built.
- [ ] **Add the `Lead_Source__c` picklist value `Aurora - Third-Party Dealer`.** Until it exists, auto-created records have **no lead source** (the code refuses to misattribute the sale to one of the ~200 existing partner values) and the intended value is recorded in the import notes.
- [x] **Pipeline position widened to ALL signed events (Tim, 2026-08-10):** `Status__c` = `Customer` + `Stage__c` = `Sold - Pending Review` are now written on every `signed` agreement — auto-created dealer records **and** pre-existing customers matched by `Aurora_Project_ID__c` — from one shared helper. Harmon's SF alerts fire off that Stage, which is why the SES email channel is deliberately unconfigured. 6 new tests; 112 green. **Needs deploying to take effect.**
- [ ] **⚠️ Duplicate signed deliveries will reprocess indefinitely while email is unconfigured.** `Aurora_Signed_Email_Sent__c` is only stamped when a notification actually sends, and it is the "signed processing complete" marker. With email off it never gets stamped, so every duplicate Aurora delivery re-runs the full signed path: 4 Aurora retrievals, a fresh PDF download + S3 overwrite, and a repeat PATCH. Data stays correct (all idempotent), but it's wasteful and **a repeat PATCH may re-fire the Salesforce alerts**. Fix options: (a) grant `ses:SendEmail` so the marker works as designed, or (b) treat "notifications deliberately disabled" as a terminal state that stamps the marker. Worth deciding before dealer volume picks up.
- [ ] **Grant `ses:SendEmail` to `sundial-lambda-execution-role`** — currently denied, so every signed notification fails with AccessDenied (seen live 2026-08-10). Not urgent while alerts run off the Stage, but it's the reason for the item above.
- [x] ~~**Pipeline position decided (Tim, 2026-08-07):**~~ (superseded by the 08-10 widening above) auto-created dealer customers get `Status__c` = `Customer` and `Stage__c` = `Sold - Pending Review`. Both values verified present in the org; both written through the same match-or-skip picklist guard (if either is ever renamed/removed, it's skipped with a warning and noted in `Aurora_Import_Notes__c` — exactly like `Lead_Source__c`). Note `Status__c` matters: the org default is **`Lead`**, so without this a closed dealer sale would have looked like a lead.
- [ ] **Review process:** auto-created customers carry only what Aurora knows — no Sundial design request, no Harmon qualification. `Stage__c = Sold - Pending Review` is the queue to work from, and the signed email flags them and names the dealer; decide who checks them and when.
- [ ] Note for whoever wires the Aurora subscription: dealer deals' `sent`/`viewed` events arrive **before** the customer exists and are dropped, so auto-created records start at `signed`. Earlier statuses are not backfilled (accepted, D-049).

## Create Project — copy Customer files to the Solar project (shipped 2026-08-03)

- [x] **`POST /projects/{customerId}/files/copy-to-solar`** → `sundial-list-files`. Server-side S3 `CopyObject` of `SUNDIAL/{customerId}/*` → `SUNDIAL/{solarId}/*`; destination read from `Linked_Solar_Project__c` server-side only (empty → 400 `NO_LINKED_PROJECT`; cross-tenant link → 400, fail closed). Zero files = 200, idempotent re-run, per-object failures isolated in `failed[]`. Copy helper: `lib/file-access.js » copyRecordFiles`.
- [x] Deployed: `.\deploy.ps1 sundial-list-files` + `scripts/wire-copy-files-route.ps1` (route live on prod).
- [x] Verified live end-to-end (`scripts/verify-copy-to-solar-e2e.mjs`, 17/17 checks, self-cleaning with verified teardown) + 13 unit tests.
- [x] IAM checked: role has `AmazonS3FullAccess`, so `ListBucket`/`Get`/`PutObject` on `sfsolproj/SUNDIAL/*` are covered — **no IAM change needed**.
- [ ] Frontend (harmon-crm, separate): call this right after the Create Project step succeeds; surface `failed[]` if non-empty.
- [ ] Nice-to-have: tighten the execution role from `AmazonS3FullAccess` to a `sfsolproj/SUNDIAL/*`-scoped policy (unrelated to this endpoint; it's the whole role).
- [ ] Fix the same latent AWS-CLI quoting bugs in `wire-budget-recalc-route.ps1` and `wire-user-admin-routes.ps1` (`--api-key-required $false` → `--no-api-key-required`; comma-containing map values + MOCK template via no-BOM JSON files; add `Assert-LastExitOk`). Their routes are already live, so nothing is broken today — but a re-run would fail confusingly, and the script would print SUCCESS anyway. Already fixed in `wire-copy-files-route.ps1` and `wire-design-request-route.ps1`.

## Cache delete-pruning gap — deleted SF records ghost in the cache (found 2026-08-03)

Deleting a record in Salesforce does **not** reliably remove its cache row. Today the only pruning is opportunistic and read-time; there is no reconciliation job.

What exists now:
- `sundial-sf-query` **list** path only: a row that is BOTH on a page someone actually requests AND already stale (`is_stale === true` or `last_synced_at` older than the 10-min `CACHE_TTL_MS`) gets re-fetched by Id; if Salesforce doesn't return it, the row is deleted (`lambdas/sundial-sf-query/index.js:871`).
- `sundial-cache-sync` has **no** delete detection at all — by design, documented at `lambdas/sundial-cache-sync/index.js:22`. Its SOQL only sees records that still exist, so deletions are invisible to both incremental and full-resync modes. A **full resync does not shrink the cache** — it only upserts.
- `sundial-sf-query` **single-record** path returns 404 when the record is gone but leaves the cache row in place (`index.js:626`).

Why it ghosts:
- A fresh row (synced within the TTL) is served straight from cache and never verified, so a just-deleted record keeps appearing on lists.
- A row on a page nobody ever loads (deep pages, filtered-out stages) is never checked at all.
- Migrated-then-deleted records are the worst case: high volume, rarely viewed individually, so nothing ever triggers the read-time check. Counts (`total`) stay inflated too.

- [ ] **Add delete-pruning to `sundial-cache-sync`.** Options, cheapest first:
  - Salesforce `queryAll` / `/sobjects/{obj}/deleted?start=&end=` (Deleted Records API, 15-day window) on each incremental run → delete matching `sf_id`s. Cheap, but only covers the last 15 days, so it must be paired with the reconciliation pass below.
  - Reconciliation pass on full resync: collect every `Id` returned from Salesforce for the object, then delete cache rows for that `client_sf_id` whose `sf_id` is not in that set. Must be scoped per tenant and must only run when the SF fetch completed cleanly — a partial/failed fetch would otherwise wipe good rows.
  - Do NOT gate on `is_stale`/TTL: the ghost rows are the fresh-looking ones.
- [ ] Delete the cache row on the single-record 404 path (`index.js:626`) — tenant-scoped, best-effort, mirroring the list path.
- [ ] Interim manual remedy: delete by `sf_id` directly in Supabase (done once for solar `a1Q7y00000JD2WxEAL`, 2026-08-03).


## User Management Backend (D-044)

- [x] `sundial-user-admin` Lambda — GET/POST `/admin/users`, PATCH `/admin/users/{id}`; Super-Admin-gated, tenant-scoped, fail-safe create + compensating delete, Supabase ban on deactivate, self-deactivation guard
- [x] `scripts/wire-user-admin-routes.ps1` (mirrors corrected budget wire script)
- [x] Docs: `api-endpoints.md` Admin section; DECISIONS.md D-044
- [x] **Create the `sundial-user-admin` Lambda function** (Node 22 / arm64 / us-west-1 / role `sundial-lambda-execution-role` / 30 s / 256 MB)
- [x] Deploy `sundial-user-admin` (`.\deploy.ps1 sundial-user-admin`)
- [x] Run `scripts/wire-user-admin-routes.ps1` against the prod gateway (routes live)
- [x] Verify end-to-end with a Super-Admin token — GET/POST/PATCH, 403 for non-super-admin, `USER_INACTIVE` on deactivated user's `/auth/me`, self-deactivation + `FIELD_NOT_ALLOWED` guards, compensating auth-user delete on SF failure
- [x] Invite `redirectTo` → `<PORTAL_BASE_URL>/reset-password` (env var). **Done at cutover (2026-08-13, D-053):** `PORTAL_BASE_URL=https://sundial.harmonelectric.net` set on `sundial-user-admin`; in-code default updated to match
- [x] Ban/unban retry-hardened (`setSupabaseBan`, 3× backoff); flow logic re-verified with fresh login (deployed-API re-verify skipped per Tim)
- [ ] Frontend (harmon-crm, separate): the Manage Users surface, gated on `superAdmin`
- [x] **Provisioning incident (2026-07-29):** root-caused to Supabase built-in email non-delivery (not the user-admin work). Fixed email-independent (default to temp-password mode, disable invite); recovered this morning's 10 users in place; verify + recovery scripts added.
- [x] **Provisioning re-diagnosis + e2e fix (2026-08-03, D-046):** live data disproved the "invite users miss tenant binding" theory (all have `Client__c=harmon`); `scripts/verify-provisioning-e2e.mjs` proves the full chain green in prod (login → `/auth/me` tenant → `GET /sf/customer` 200 w/ 31,576 rows → forced change → re-login). Added `scripts/recover-provisioning.mjs` (classify + fix-in-place + guarded orphan delete) and `lib/salesforce.js » sfDeleteRecord`. See `docs/integrations/auth-email-ses.md`.
- [x] **Auth email via Supabase Custom SMTP (SES)** — **CLOSED 2026-08-18.** Delivery was already proven (SES `Delivered`, zero bounces); Tim confirmed the remaining dashboard steps are done, including the **auth email templates emitting `?token_hash={{ .TokenHash }}&type=recovery|invite`**, which is what makes the deferred-redemption fix live rather than inert. **Templates are load-bearing — reverting one to `{{ .ConfirmationURL }}` reintroduces the "expired link" bug.** Original scope: — setup guide written (`docs/integrations/auth-email-ses.md`) with exact console/dashboard steps + values. **Tim to do:** (a) create SES SMTP credentials (us-west-1); (b) enable Supabase Custom SMTP (host `email-smtp.us-west-1.amazonaws.com:465`, sender `harmon@sundialcrm.com`); (c) add Site URL + `/reset-password` redirect allowlist; (d) raise the auth email rate limit; then manual invite/reset test. This unblocks both invites and resets.
- [ ] **Deploy the harmon-crm invite-default flip** (`UserFormModal.tsx`, branch `fix/provisioning-auth-email`) — **only after** the SMTP steps above pass the manual invite test (ordering per D-046).
- [ ] **Apply recovery** (after review): `APPLY=1 OUT=<path> node scripts/recover-provisioning.mjs` for `davidcoleman` (NEVER_ONBOARDED); decide orphans — delete `troyjohnson` (typo-dup) via `DELETE_ORPHANS=1`, confirm intent for `team+5069@nonstopautomation.com` and the `harmon@constructiveoperations.com` ORPHAN_SF.
- [x] **Wire AWS SES — DONE 2026-08-19.** Runbook: `docs/integrations/ses-transactional-email.md`.
  - **(a) Sending identity — DONE, and the old recommendation here was WRONG.** This item used to recommend creating `mail.constructiveoperations.com`. **Do not.** The verified identity is the **domain `sundialcrm.com`** in us-west-1, verified since 2026-08-02, DKIM `SUCCESS`, custom MAIL FROM `mail.sundialcrm.com` at `MailFromDomainStatus: SUCCESS`, single `p=quarantine` DMARC record since the duplicate was removed 2026-08-18. Auth email has been sending through it since 2026-08-12. A second identity would have split reputation across two domains for no gain.
  - **(b) Production access — DONE** 2026-08-03, us-west-1 (case 178572585300376). Re-verified 2026-08-19: `ProductionAccessEnabled: true`, `EnforcementStatus: HEALTHY`, quota 50,000/24h.
  - **(c) IAM — already granted, deliberately left as-is.** `sundial-lambda-execution-role` carries the managed **`AmazonSESFullAccess`**; no inline policy mentions SES. A scoped `ses:SendEmail`-on-the-identity policy was drafted, but adding it changes nothing while the managed policy stays attached, and Tim chose not to detach it (2026-08-19). If it is ever tightened: the ONLY SES call in the codebase is `SESv2 SendEmail` with `Content.Simple` in `lib/email.js`, so `ses:SendEmail` alone suffices — **`ses:SendRawEmail` is never reached**.
  - **(d) Env vars — SET on `sundial-aurora-push` and `sundial-aurora-inbound`:** `EMAIL_FROM`, `EMAIL_REPLY_TO`, `SES_REGION`, `EMAIL_CONFIG_SET`, `DESIGN_REQUEST_NOTIFY_TO`/`_CC`. Note `sundial-aurora-push` had **no environment variables at all** before this, which is precisely why Design Requests degraded.
  - **(e) Bounce/complaint tracking — DONE:** SES configuration set **`sundial-transactional`** with a CloudWatch event destination on BOUNCE / COMPLAINT / DELIVERY / REJECT, dimension `configuration-set`. Look at it in CloudWatch → Metrics → `AWS/SES` → filter `configuration-set = sundial-transactional`.
  - **Proven end to end 2026-08-19:** a direct `lib/email.js` send delivered, AND a real Design Request submit on `A3PROOF TEST Aug12` returned `email: { sent: true, recipients: { to: 1, cc: 1 } }` — the `email_not_configured` degradation is gone on the actual feature path, not just in isolation.
- [ ] **`sundial-comment-notify` env vars at deploy** — the third sender. It is **not deployed yet**, so nothing was set on it. At deploy, set the SES vars *together with* its own credentials in one command (see `docs/integrations/ses-transactional-email.md`); `update-function-configuration` replaces the entire map, and a dropped `COMMENT_NOTIFY_SECRET` fails the webhook closed.
- [x] **Utility Password save failure (D-045):** describe-cache TTL (5 min) in sundial-sf-update + sundial-sf-query; redeployed. Root cause was stale FLS in the cached describe after the budget perm set assignment.
- [x] ~~**Aurora "Submit Design Request" endpoint:** `POST /projects/{solarId}/design-request/submit`~~ — **superseded 2026-08-03 (D-047):** no `Sundial_Solar__c` exists at design-request time, so that route was unusable. Re-plumbed to `POST /customers/{recordId}/design-request/submit` on `Sundial_Customer__c`.
- [x] **Aurora Design Request on the Customer module (D-047):** customer-id route as the mainline, Solar resolution removed, describe-filtered field set, design-manager notification email carrying the full form (Aurora accepts none of it). Project creation once-only (`Sent_to_Aurora__c`/`Aurora_Project_ID__c`); notification separately retryable (`Design_Request_Email_Sent__c`) so a failed email can be recovered by re-submitting. 21 tests green (`npm test`). **Built + tested, NOT deployed.**
- [ ] **Deploy the Design Request re-route:** `.\deploy.ps1 sundial-aurora-push` → `.\scripts\wire-design-request-route.ps1` (also deletes the legacy `/projects/.../design-request` resource) → set `EMAIL_FROM`, `DESIGN_REQUEST_NOTIFY_TO`, optional `DESIGN_REQUEST_NOTIFY_CC` on the Lambda + `ses:SendEmail` on the role (see `docs/api-endpoints.md` → Lambda Environment Variables).
- [ ] **Create two fields on `Sundial_Customer__c`** (live describe 2026-08-03 says neither exists; the Lambda drops each from the SELECT until it does and picks it up automatically after — no redeploy):
  - `Design_Notes__c` — long textarea; the one Design Request form field the object lacks.
  - [x] `Design_Request_Email_Sent__c` — **CREATED (reported by Tim 2026-08-18; confirm on the next live describe).** **datetime**, writable by the integration user. Records that the design-manager notification actually landed. **Until it exists, every re-submit re-sends the notification** (deliberate — see D-047: silence is the worse failure), so create it before the button goes to users.
- [ ] Frontend (harmon-crm, separate): "Submit Design Request" button on the **Customer** record's Design Request Form tab, posting the Customer id to `/customers/{recordId}/design-request/submit`.
- [ ] **Design Request Form fields (new SF fields):** Workbench package pending Tim's field-existence markup of `Fields_by_Section.xlsx` (picklists, multiselect Sales Type, datetime, text/number) + FLS on integration + user perm sets. Note the Design Request set itself now lives on **`Sundial_Customer__c`** (verified present 2026-08-03), not `Sundial_Solar__c`.

## Portal Access Model (D-043)

- [x] Add `Access_Level__c`, `Super_Admin__c`, `Default_Department__c` to the portal identity (`lib/identity.js`) — verified live on `Sundial_User__c`
- [x] `sundial-auth-proxy` returns the new fields (no structural change); deployed
- [x] `upsertProfile` unchanged (`public.profiles` has no `access_level`/`is_super_admin` columns)
- [x] Docs: real `/auth/me` shape in `api-endpoints.md`; DECISIONS.md D-043
- [~] Verify live: `GET /auth/me` with a real portal-user token (Tim to supply one) → confirm `user.accessLevel` + `user.superAdmin`
- [ ] Frontend (harmon-crm, separate): gate tabs/sections/fields/reports on `accessLevel`; gate Manage Users on `superAdmin`
- [ ] Future user-admin endpoints: server-side `superAdmin` checks (the ONLY place these fields are enforced server-side)
- [ ] Other Lambdas pick up the `lib/identity.js` change on their next routine deploy (no action needed now)

## Budget Calculator (feature/budget-calculator)

### Lambda + triggers
- [x] Place `budget-lambda` in repo as `lambdas/sundial-budget/`; `npm test` 32/32 (pinned HOLLAND math)
- [x] Wire org-standard SF auth via `lib/salesforce.js` (dropped jsforce); reads `sfQuery`, writeback shared `sfUpdateRecord`
- [x] Base64-embed the workbook template at deploy time (`prebuild.mjs`/`postbuild.mjs` + `deploy.ps1` hooks); tests read source `.xlsx`
- [x] Task 4: best-effort Supabase file-metadata registration (`lib/file-access.js » registerFileMetadata`, category "Budget")
- [x] Task 2: recalc button auth (Supabase JWT + tenant scoping) in handler; documented in `docs/api-endpoints.md`
- [x] Task 3: record-triggered Flow drafted (`salesforce/flows/Sundial_Budget_Recalc_Trigger.flow-meta.xml`) + relay runbook
- [x] Deploy `sundial-budget` (function created; 256 MB / 30 s). Prerequisites verified — all 73 input fields valid on `Sundial_Solar__c`.
- [x] Gate 2 numeric verify via scripted HOLLAND TEST record (seeded in-Lambda; see PROGRESS.md)
- [ ] Task 2: run `scripts/wire-budget-recalc-route.ps1` against the prod API Gateway (needs go-ahead — live change)
- [ ] Task 3: wire the confirmed Platform-Event relay (EventBridge rule or SQS mapping) + Lambda invoke permission
- [x] Task 5: built the ProjectBudget GUID-write path (`writeBudgetLines`) on `feat/budget-push-write` — Stages 1–5 done; deploy + wire + FLS + IAM + live test pending (runbook in `docs/integrations/acumatica-budget-push.md`).
- [ ] Portal budget UI per `../harmon-crm/docs/Sundial_Solar_Fields_by_Section.xlsx` (FRONTEND — not a backend task; fields render in the portal, not a SF layout)

### Blocked on Harmon / confirmation
- [x] ~~**Acumatica mapping: no `InventoryID` column**~~ → **RESOLVED 2026-08-07 (Gate 5a)** via a live reconcile harvest of ProjectID `R269999`. The sheet's old "AccountGroup" column was actually the InventoryID; real AccountGroup is BILLING/LABOR/OTHER/MATERIAL. `MAPPING_ROWS` + `docs/Sundial_Solar_Budget_Fields.xlsx` + the integration doc now carry the full 4-part key. Clean matched-run: 18 rows → 15 groups → 0 problems. (Note: `RESIDENTAL` is the Acumatica misspelling — kept intentionally.)
- [x] ~~Income code BILL~~ → resolved: income is TWO lines (`BALANCE` + `GENM`/BILLING), `BILL` removed. `DLR` confirmed as the Dealer-fee line.
- [x] ~~**Geo commission task code unconfirmed**~~ → **resolved to `APPT COM`** (LABOR·SALESCOMM) from role semantics, and ~~Audit+QA `GENA`~~ → resolved to the LABOR·RESIDENTAL line (internal labor, UOM=HOUR). Both wired into `MAPPING_ROWS`.
- [x] **Harmon finance sign-off on Geo → `APPT COM`** received (Gate 5b) 2026-08-07 — clears `PENDING_HARMON_SIGNOFF` for the first production write.
- [x] **Gate 5b satisfied 2026-08-07:** clean reconcile vs R269999 ✔ + Harmon APPT COM sign-off ✔ + Tim-approved write plan ✔ — `writeBudgetLines` built (Stages 1–5).
- [!] **Milestone trigger fields** for the recalc Flow (Audit Completed, Design Review Finalized, …) — Harmon's final list; append as formula `fInputChangedC` and Activate the Flow.
- [!] **§9 workbook quirks** (8) in `docs/budget-calculator-design.md` — implemented as the sheet behaves; each a one-line change in `budgetCalc.js` pending a Harmon finance yes/no.
- [ ] **Confirm the Platform-Event relay mechanism** actually deployed (Event Relay vs SQS) — repo has no live SF→AWS relay yet.

## Multi-tenant readiness (pre-second-tenant refactor — NOT now; Harmon runs fine as-is)

Externalize the Harmon-specific values currently baked in shared backend code into
per-tenant config keyed by tenant slug (resolved from `Sundial_Tenant__c`), so the
copy-for-new-tenant base stays tenant-agnostic:
- [ ] **Tax zones** — `lib/acumatica-tax-zones.js` (Arizona retail zones) → per-tenant config.
- [ ] **Acumatica mapping** — `sundial-acumatica-budget-push` `MAPPING_ROWS`/`UNCONFIRMED` + `sundial-acumatica-push` `CUSTOMER_CLASS="RESIDENT"` / template `"RS"` → per-tenant config.
- [ ] **budgetCalc** — accepted as a per-tenant *forked* calc module (a materially different tenant budget sheet = different math, per D-038); optionally lift the adder catalog / hours-per-unit to config if tenants share the calc shape.
- [ ] **Portal origin + invite base URL** — `sundial.harmonelectric.net` is now hardcoded in the CORS allowlist (six files) and as the `PORTAL_BASE_URL` in-code default (D-053). A second tenant needs both per-tenant; `PORTAL_BASE_URL` is already env-overridable, the CORS allowlist is not.
- Already cleanly externalized (no work): secrets/tenant IDs (Secrets Manager), rate/catalog defaults (SF field-default metadata), per-project values (records), tenant isolation (`Client__c → Sundial_Tenant__c`, D-034).

---

## Related records — `?parentId=` on `GET /sf/{object}` (2026-08-13)

- [x] `PARENT_FILTER` registry (per-object parent lookup + cache column); `solar` and `roofing` on `Sundial_Customer__c`
- [x] Enforced on all three read paths: cache paged, cache search (`?q=`), and live SOQL (cold cache + Sales-Rep restrict)
- [x] Composes with the TEMP Sales-Rep restrict (ANDed after the rep clause — intersection only, never widens)
- [x] Cold-cache fallback carries the parent clause (an empty related list must not fall through to the whole table)
- [x] 400 on unsupported object / malformed id — never a silently ignored param
- [x] First test file for `sundial-sf-query` (12 tests, wired into `npm test`); deployed
- [ ] Verify against live data with an authenticated token (deployed but not functionally verified end to end)
- [ ] Add `po` to the registry when a PO related list is needed (one entry: parent lookup + `<name>_sf_id` column)

---

## Portal domain cutover → `sundial.harmonelectric.net` (2026-08-13, D-053)

- [x] Add `https://sundial.harmonelectric.net` to the CORS allowlist — `lib/http.js` + all five inline copies; `*.vercel.app` and `localhost:5173` retained
- [x] Set `PORTAL_BASE_URL=https://sundial.harmonelectric.net` on `sundial-user-admin`; in-code default updated to match
- [x] Redeploy all 12 affected Lambdas; verified live per-origin (new domain and vercel.app echoed, untrusted origin not reflected)
- [x] Docs: `api-endpoints.md` (CORS + env table), `docs/integrations/auth-email-ses.md` (Parts C/D)
- [x] **Tim (Supabase dashboard) — DONE 2026-08-18:** add `https://sundial.harmonelectric.net` to Site URL + Redirect URLs (`/reset-password`, `/**`). Resets use `window.location.origin`, so they break on the new domain until this lands — not covered by any repo deploy
- [ ] **Tim (Vercel):** attach the domain to the project and point DNS; keep `harmon-crm.vercel.app` as a redirect

### Tech debt

- [ ] **Consolidate CORS into `lib/http.js`.** Five Lambdas (`sundial-auth-proxy`, `sundial-sf-query`, `sundial-sf-update`, `sundial-acumatica-push`, `sundial-aurora-push`) carry inline copies of `STATIC_ALLOWED_ORIGINS`/`isAllowedOrigin`/`corsHeaders` instead of importing the shared module. This cutover changed one origin in **six** places; the harmon-crm task tracking it only knew about one of the five inline copies, so a drifted copy would have failed silently for whichever routes it serves. Replace the inline blocks with the `lib/http.js` import (watch the per-Lambda `Access-Control-Allow-Methods` differences — the shared version sends `GET, POST, DELETE, OPTIONS`) and redeploy. **Cleanup only — not urgent, do not bundle into feature work.**
