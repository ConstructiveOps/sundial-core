// Generates salesforce/v2-budget-output-fields/{package.xml,objects/Sundial_Solar__c.object}
//
// The §D minimum set from docs/integrations/budget-v2-output-gap.md: the eight
// budgetCalc v2 outputs that have no home on Sundial_Solar__c. ADDITIVE ONLY.
//
// Solar-only by construction: these are calc OUTPUTS and the calc is Solar-side. None
// of them is a rep input, so none belongs on Customer and none goes in the create-map.
//
// Currency(16,2) throughout = precision 18 / scale 2, matching every other budget
// output field on the object (Total_Job_Cost__c, GP_Dollars__c, …).
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("salesforce/v2-budget-output-fields");
fs.mkdirSync(path.join(OUT, "objects"), { recursive: true });

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const WRITTEN_BY =
  "CALCULATED by the budget Lambda (lambdas/sundial-budget) — do not edit manually; " +
  "the next recalc overwrites it.";

const FIELDS = [
  {
    api: "Internal_Rep_Commission_Amt__c",
    label: "Internal Rep Commission Amt",
    type: "Currency", precision: 18, scale: 2,
    description:
      `${WRITTEN_BY} Internal (Harmon) rep commission = Internal_Rep_Commission_PPW__c × watts. ` +
      "Posts to SLPC · LABOR · SALESCOMM and IS burdened (75%). The counterpart to " +
      "Sales_Rep_Commission_Amt__c, which holds the THIRD-PARTY amount — on an internal deal " +
      "that field is 0 and this one carries the commission (D9/D16).",
    help: "Internal Harmon rep commission for this job. Zero on a third-party dealer deal.",
    extra: "internalCommissionAmt",
  },
  {
    api: "Management_Commission_Amt__c",
    label: "Management Commission Amt",
    type: "Currency", precision: 18, scale: 2,
    description:
      `${WRITTEN_BY} The single SLMC · LABOR · SALESCOMM line = ` +
      "(Sales_Mgr_Commission_PPW__c + Overhead_Commission_PPW__c) × watts. " +
      "The two components stay stored separately (D10) because the Acumatica attribute sync " +
      "splits them again — MGRCOM* from the .04, MGMTOR* from the .015. This is their sum, " +
      "stored so every consumer reads one number instead of re-deriving it and drifting.",
    help: "Combined Ralph + Daniel commission (the SLMC budget line). Components are in Sales Mgr / Overhead Commission Amt.",
    extra: "managementCommissionAmt",
  },
  {
    api: "Setter_Commission_Amt__c",
    label: "Setter Commission Amt",
    type: "Currency", precision: 18, scale: 2,
    description:
      `${WRITTEN_BY} The setter commission that ACTUALLY APPLIED, posting to APPT COM. ` +
      "Distinct from Geo_Commission_Amount__c, which is the INPUT rate ($70) and is always " +
      "populated: this is 0 when the linked Customer has no Setter__c (D17). Without it there " +
      "is no way to tell a job that paid a setter from one that did not.",
    help: "Setter commission applied to this job. Zero when the Customer record has no Setter.",
    extra: "setterCommissionAmt",
  },
  {
    api: "Commission_Deal_Type__c",
    label: "Commission Deal Type",
    type: "Picklist",
    picklist: ["3rd Party", "Internal", "None"],
    description:
      `${WRITTEN_BY} Which rep commission input is populated, and therefore how this deal is ` +
      "treated (D16): 3rd Party → SLPC OUT · OTHER · M1&M2COM plus commission POs; Internal → " +
      "SLPC · LABOR · SALESCOMM, payroll only, NO POs; None → neither PPW is set. " +
      "The PO engine reads this rather than re-deriving it. Both PPWs populated is a hard calc " +
      "error, so this can never be ambiguous.",
    help: "Set by the budget calc from which rep PPW is populated. Drives whether commission POs are created.",
    extra: "dealType",
  },
  {
    api: "DC_Rebate_Amount__c",
    label: "DC Rebate Amount",
    type: "Currency", precision: 18, scale: 2,
    description:
      `${WRITTEN_BY} LightReach domestic-content rebate = $0.45 × watts when ` +
      "Domestic_Content__c is affirmative, else 0 (D2). A THIRD income line on RSDC projects — " +
      "it raises Balance of Revenue and GP, so without it there is no record on the job of why " +
      "the margin differs from a non-DC one.",
    help: "Domestic-content rebate revenue ($0.45/W). Zero unless Domestic Content is set.",
    extra: "dcRebateAmount",
  },
  {
    api: "Engineer_Stamps_Cost__c",
    label: "Engineer Stamps Cost",
    type: "Currency", precision: 18, scale: 2,
    description:
      `${WRITTEN_BY} The SUBCON · ENGINEERING COSTS line, from the ` +
      "Structural-Electrical Engineer Stamp adder (Adder_Structural_Cost__c × qty). " +
      "Inside Total Job Cost since D11 fixed the BRADS anomaly that excluded it.",
    help: "Engineer stamp cost pushed to the SUBCON Engineering budget line.",
    extra: "engineerStampsCost",
  },
  {
    api: "Subcontractor_Cost__c",
    label: "Subcontractor Cost",
    type: "Currency", precision: 18, scale: 2,
    description:
      `${WRITTEN_BY} The SUBCON · SUBCONTRACTOR line, from the Bird Blocking adder ` +
      "(Adder_Bird_Blocking_Cost__c × watts, selection-gated). Inside Total Job Cost since D11.",
    help: "Subcontractor cost pushed to the SUBCON budget line.",
    extra: "subcontractorCost",
  },
  {
    api: "Total_Other_Summary__c",
    label: "Total Other (GP Summary)",
    type: "Currency", precision: 18, scale: 2,
    description:
      `${WRITTEN_BY} Sheet N13 "Total Other*" = GENO + engineer stamps + subcontractor + ` +
      "software + referral. THIS is the figure the GP calculation nets, and it is NOT " +
      "Total_Other_Budget__c, which holds only the GENO line (J16). They differ by the four " +
      "D11 lines — 2,550 vs 3,858 in the pinned fixture. Stored so a margin question can be " +
      "answered from the record.",
    help: "The 'other' total the GP figure nets. Larger than Total Other Budget, which is GENO only.",
    extra: "summaryTotalOther",
  },
];

function fieldXml(f) {
  const L = ["    <fields>", `        <fullName>${f.api}</fullName>`];
  L.push(`        <description>${esc(f.description)}</description>`);
  L.push("        <externalId>false</externalId>");
  L.push(`        <inlineHelpText>${esc(f.help)}</inlineHelpText>`);
  L.push(`        <label>${esc(f.label)}</label>`);
  if (f.precision !== undefined) L.push(`        <precision>${f.precision}</precision>`);
  L.push("        <required>false</required>");
  if (f.scale !== undefined) L.push(`        <scale>${f.scale}</scale>`);
  L.push("        <trackTrending>false</trackTrending>");
  L.push(`        <type>${f.type}</type>`);
  if (f.picklist) {
    // RESTRICTED: the calc only ever writes these three literals, so restricting the
    // set turns a future typo into a save error instead of silent bad data — the same
    // reasoning as Budget_Push_Status__c.
    L.push("        <valueSet>");
    L.push("            <restricted>true</restricted>");
    L.push("            <valueSetDefinition>");
    L.push("                <sorted>false</sorted>");
    for (const v of f.picklist) {
      L.push("                <value>");
      L.push(`                    <fullName>${esc(v)}</fullName>`);
      L.push("                    <default>false</default>");
      L.push(`                    <label>${esc(v)}</label>`);
      L.push("                </value>");
    }
    L.push("            </valueSetDefinition>");
    L.push("        </valueSet>");
  }
  L.push("    </fields>");
  return L.join("\n");
}

const header = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  v2 budget rework — the §D output-field set for Sundial_Solar__c.
  Reference: docs/integrations/budget-v2-output-gap.md §D (reviewed + approved 2026-08-20).

  ${FIELDS.length} NEW fields, ADDITIVE ONLY — no existing field is touched. Every one is a
  budgetCalc v2 output that currently has nowhere to land and is returned only in the
  calc's \`extras\` object.

  ALL WRITTEN BY THE BUDGET LAMBDA. None is a user input, none belongs on
  Sundial_Customer__c, and none goes in the Create Project mapping.

  Collision-checked against the live describe 2026-08-20: none of these ${FIELDS.length} API names
  exists on Sundial_Solar__c.

  Deliberately NOT included (derivable from fields already on the record, see §D):
  softwareCost, referralCost, genoAdderCost, stdAdderPriceTotal, nsAdder4Total, nsAdder5Total.
-->
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
`;

fs.writeFileSync(
  path.join(OUT, "objects", "Sundial_Solar__c.object"),
  header + FIELDS.map(fieldXml).join("\n") + "\n</CustomObject>\n",
  "utf8"
);

fs.writeFileSync(
  path.join(OUT, "package.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Workbench deploy: v2 budget output fields (§D of budget-v2-output-gap.md).
  ${FIELDS.length} new custom fields on Sundial_Solar__c, additive only.

  Zip this folder's CONTENTS (package.xml at the zip root) and deploy via
  Workbench -> Migration -> Deploy -> Single Package. RUN CHECK ONLY FIRST.

  ⚠️ ZIP WITH WINDOWS EXPLORER "Send to > Compressed (zipped) folder".
  NEVER PowerShell 5.1 Compress-Archive — it writes BACKSLASH path separators into
  the zip and Workbench cannot read the entries. See README.md.
-->
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
${FIELDS.map((f) => `        <members>Sundial_Solar__c.${f.api}</members>`).join("\n")}
        <name>CustomField</name>
    </types>
    <version>62.0</version>
</Package>
`,
  "utf8"
);

console.log(`wrote ${FIELDS.length} fields -> ${OUT}`);
for (const f of FIELDS) {
  console.log(
    `  ${f.api.padEnd(32)} ${(f.picklist ? `Picklist(${f.picklist.join('/')})` : `Currency(${f.precision - f.scale},${f.scale})`).padEnd(34)} <- extras.${f.extra}`
  );
}
