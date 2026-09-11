# v7-ns-adder-price-fields

Five formula fields per object (Sundial_Customer__c + Sundial_Solar__c = 10 total):
`NS_Adder_1_Price__c` … `NS_Adder_5_Price__c` — Currency(18,2), formula, additive only.

## Why

Reps asked to see what each Non-Standard adder contributes to the adder total that
reduces their commission (D19). Each field mirrors — VERBATIM — the corresponding NS
term inside `Total_Adder_Price__c`:

    BLANKVALUE(NS_Adder_n_Material_Cost__c,0) * (1 + BLANKVALUE(NS_Adder_n_Markup_Percent__c,0))
    + BLANKVALUE(NS_Adder_n_Labor_Hours__c,0) * 33 * 1.75

Rules inherited from v3 (do not "fix" them):
- **No /100 on markup** — formulas read Percent fields as decimals (25% = 0.25).
- **33 is hardcoded** — the Powerwall labor rate the commission model is defined
  against, deliberately NOT `Battery_Labor_Rate__c` (a per-job override must not
  change everybody's commission). 1.75 = labor + 75% burden.
- If the NS term in `Total_Adder_Price__c` ever changes, these five must change with it.

Unused blocks show **$0.00** (every input blank ⇒ 0), which matches their contribution
to the commission deduction. Distinct from the calc-written `NS_Adder_n_Total__c`
snapshot fields: these are live formulas and can never be stale.

## Deploy

1. Use the prebuilt `v7-ns-adder-price-fields.zip` (built on Linux — forward-slash
   entries, Workbench-safe; do NOT re-zip unless you change the XML).
2. Workbench → Migration → Deploy → choose the zip → **Check Only first** (compiles
   the formulas), then deploy for real with the same settings.
3. After deploy: FLS for the integration user + portal profiles, then add the fields
   to the Fields-by-Section config sheets (Adders section) and regenerate the portal
   configs (harmon-crm).

If you ever rebuild the zip on Windows: Explorer "Send to → Compressed (zipped)
folder" on this folder's CONTENTS (package.xml at the zip ROOT).
NEVER PowerShell 5.1 Compress-Archive — backslash entries break Workbench.
