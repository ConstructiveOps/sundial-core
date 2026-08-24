// Generates salesforce/v4-commission-po-fields/{package.xml,objects/Sundial_Solar__c.object}
//
// §4f of the budget rework — the eight commission-PO tracking fields, approved as
// proposed 2026-08-24. Reference: docs/integrations/commission-po-field-gap.md.
//
// SOLAR ONLY, and ADDITIVE ONLY. All eight are written by
// lambdas/sundial-acumatica-commission-po; none is a rep input, none belongs on
// Sundial_Customer__c, and none goes in the Create Project mapping.
//
// Collision-checked against the live describe 2026-08-24 (490 fields on the object):
// none of these eight API names exists. Re-check with
//   node scripts/probe-commission-po-fields.mjs
//
// THE ONE CHOICE WORTH RE-READING IS Text(20) FOR THE ORDER NUMBERS. Acumatica order
// numbers are zero-padded strings — `016102`, `016442` — and a Number field silently
// drops the leading zero, at which point the stored value matches nothing in Acumatica
// and the idempotency key is dead. Same trap as the `01926`-shaped vendor ids.
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("salesforce/v4-commission-po-fields");
fs.mkdirSync(path.join(OUT, "objects"), { recursive: true });

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const WRITTEN_BY =
  "WRITTEN by the commission PO engine (lambdas/sundial-acumatica-commission-po) — do not " +
  "edit manually.";

const IDEMPOTENCY =
  "THIS IS THE IDEMPOTENCY KEY. \"Have we already raised this PO for this job?\" is answered " +
  "by this field and nothing else — the rejected alternative was scanning Acumatica for a PO " +
  "whose description looks right, which matches a hand-typed PO and misses a renamed one, and " +
  "both failure modes are Harmon paying a dealer twice. Clearing it by hand will cause a " +
  "SECOND purchase order on the next budget push.";

const TEXT_NOT_NUMBER =
  "Text, not Number: Acumatica order numbers are zero-padded (016102) and a Number field drops " +
  "the leading zero.";

const M_NOTE = (m, other) =>
  `M1 and M2 are separate documents with separate lifecycles — ${m} can be Completed and frozen ` +
  `while ${other} has not been raised at all — which is why they have their own fields rather ` +
  "than one field plus a milestone flag.";

const FIELDS = [
  {
    api: "Commission_PO_M1_Number__c",
    label: "Commission PO M1 Number",
    type: "Text", length: 20,
    description:
      `${WRITTEN_BY} The Acumatica OrderNbr of the M1 commission purchase order — the first ` +
      "milestone payment to the third-party dealer, min(50% of commission, $2,500). " +
      `${IDEMPOTENCY} ${TEXT_NOT_NUMBER} ${M_NOTE("M1", "M2")}`,
    help: "Acumatica PO number for the M1 dealer commission payment. Do not edit — clearing it causes a duplicate PO.",
  },
  {
    api: "Commission_PO_M2_Number__c",
    label: "Commission PO M2 Number",
    type: "Text", length: 20,
    description:
      `${WRITTEN_BY} The Acumatica OrderNbr of the M2 commission purchase order — the balance ` +
      `of the dealer commission after M1. ${IDEMPOTENCY} ${TEXT_NOT_NUMBER} ${M_NOTE("M2", "M1")}`,
    help: "Acumatica PO number for the M2 dealer commission payment. Do not edit — clearing it causes a duplicate PO.",
  },
  {
    api: "Commission_PO_M1_Amount__c",
    label: "Commission PO M1 Amount",
    type: "Currency", precision: 18, scale: 2,
    description:
      `${WRITTEN_BY} What the M1 purchase order was actually raised for. Strictly speaking ` +
      "redundant — the amount is on the PO in Acumatica — but it lets the portal show what was " +
      "raised without an Acumatica round trip, and it makes \"the commission has changed since we " +
      "raised M1\" answerable from the Salesforce record alone. Nothing in the engine depends on it.",
    help: "The amount the M1 commission PO was raised for.",
  },
  {
    api: "Commission_PO_M2_Amount__c",
    label: "Commission PO M2 Amount",
    type: "Currency", precision: 18, scale: 2,
    description:
      `${WRITTEN_BY} What the M2 purchase order was actually raised for. See ` +
      "Commission_PO_M1_Amount__c for why it is stored rather than read back from Acumatica.",
    help: "The amount the M2 commission PO was raised for.",
  },
  {
    api: "Commission_PO_M1_Created__c",
    label: "Commission PO M1 Created",
    type: "DateTime",
    description:
      `${WRITTEN_BY} When the M1 purchase order was RAISED. Stamped on creation only and never ` +
      "on a later update, so it keeps meaning \"when this PO came into existence\" rather than " +
      "drifting into \"when we last touched it\". NOT the milestone date — the site audit date " +
      "the PO carries is Audit_Date_and_DateTime__c (Q13).",
    help: "When the M1 commission PO was created in Acumatica. Not the site audit date.",
  },
  {
    api: "Commission_PO_M2_Created__c",
    label: "Commission PO M2 Created",
    type: "DateTime",
    description:
      `${WRITTEN_BY} When the M2 purchase order was RAISED. Creation only, never updated. NOT ` +
      "the milestone date — the install date the PO carries is Scheduled_Install_Date__c (Q13).",
    help: "When the M2 commission PO was created in Acumatica. Not the scheduled install date.",
  },
  {
    api: "Commission_PO_Status__c",
    label: "Commission PO Status",
    type: "Picklist",
    // Order matters here only for the layout; the engine's precedence is
    // Failed > Frozen > raised-count and lives in commissionPoStatus().
    picklist: ["None", "M1 Raised", "Both Raised", "Failed", "Frozen"],
    description:
      `${WRITTEN_BY} Where this job's commission POs stand. None = nothing raised, which is the ` +
      "CORRECT resting state for an internal deal (commission is payroll, D16) and for a job with " +
      "no third-party commission. M1 Raised / Both Raised = the ordinary progression. Failed = " +
      "something needs a human. Frozen = a released PO could not be changed and the difference " +
      "belongs in M2 (§6) — an EXPECTED state, deliberately not filed under Failed, because " +
      "filing expected outcomes under failure is how people learn to ignore failures. " +
      "RESTRICTED: the engine only ever writes these five literals.",
    help: "Where the dealer commission POs stand. 'None' is correct for internal deals; 'Frozen' is expected, not an error.",
  },
  {
    api: "Commission_PO_Error__c",
    label: "Commission PO Error",
    type: "LongTextArea", length: 4000, visibleLines: 5,
    description:
      `${WRITTEN_BY} The refusal or failure message from the last run, and CLEARED on a clean ` +
      "one. This is where a frozen PO says which two amounts it is between, where an unmapped " +
      "dealer names the CSV row it needs, and where a create that half-succeeded says so — " +
      "without it those outcomes are a CloudWatch line nobody reads.",
    help: "Why the last commission PO run refused or failed. Blank when everything succeeded.",
  },
];

function fieldXml(f) {
  const L = ["    <fields>", `        <fullName>${f.api}</fullName>`];
  L.push(`        <description>${esc(f.description)}</description>`);
  L.push("        <externalId>false</externalId>");
  L.push(`        <inlineHelpText>${esc(f.help)}</inlineHelpText>`);
  L.push(`        <label>${esc(f.label)}</label>`);
  if (f.length !== undefined) L.push(`        <length>${f.length}</length>`);
  if (f.precision !== undefined) L.push(`        <precision>${f.precision}</precision>`);
  L.push("        <required>false</required>");
  if (f.scale !== undefined) L.push(`        <scale>${f.scale}</scale>`);
  L.push("        <trackTrending>false</trackTrending>");
  L.push(`        <type>${f.type}</type>`);
  if (f.type === "Text") {
    // Not unique: two jobs could in principle carry the same number only if something has
    // gone wrong, and a uniqueness constraint would turn that into a save failure that
    // loses the OrderNbr entirely — the one thing worse than a duplicate we can see.
    L.push("        <unique>false</unique>");
  }
  if (f.visibleLines !== undefined) L.push(`        <visibleLines>${f.visibleLines}</visibleLines>`);
  if (f.picklist) {
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
  §4f — commission PO tracking fields for Sundial_Solar__c.
  Reference: docs/integrations/commission-po-field-gap.md (approved as proposed 2026-08-24).

  ${FIELDS.length} NEW fields, ADDITIVE ONLY — no existing field is touched.

  ALL WRITTEN BY lambdas/sundial-acumatica-commission-po. The integration user needs
  READ + EDIT on all ${FIELDS.length}: without Edit the purchase order is still created and the
  OrderNbr is lost, which is the single failure mode in this engine that costs money.

  Collision-checked against the live describe 2026-08-24: none of these ${FIELDS.length} API names
  exists on Sundial_Solar__c (490 fields).

  NOT the same thing as the pre-existing Bill_Out_in_Acumatica_Requested__c / _2__c
  ("M1 / M2 Bill Out in Acumatica Requested", both Date). Those are Harmon's manual AR
  request markers; these track the AP purchase orders this engine raises. Confirmed
  unrelated 2026-08-24.

  NO Commission_PO_Vendor__c: the vendor is derivable from
  Sales_Company_Harmon_Solar_or_Third__c through the D4 dealer map at any time, and a
  stored copy would go stale the moment the map changed. If it needs to be visible on the
  layout, a formula field is the right shape.
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
  Workbench deploy: §4f commission PO tracking fields.
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

console.log(`wrote ${FIELDS.length} fields -> ${OUT}\n`);
for (const f of FIELDS) {
  const t = f.picklist
    ? `Picklist(${f.picklist.length}, restricted)`
    : f.type === "Currency"
      ? `Currency(${f.precision - f.scale},${f.scale})`
      : f.length !== undefined
        ? `${f.type}(${f.length})`
        : f.type;
  console.log(`  ${f.api.padEnd(30)} ${t}`);
}
console.log("\n  FLS: the integration user needs Read + Edit on all of them.");
