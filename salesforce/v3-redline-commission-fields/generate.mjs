// Generates salesforce/v3-redline-commission-fields/{package.xml,objects/*.object}
//
// D19 — the REDLINE commission model. Four FORMULA fields per object:
//
//   Commission_Redline_PPW__c   the $/W redline, by deal type x finance source
//   Total_Adder_Price__c        every priced adder, at price (not cost)
//   Commission_Total__c         Contract - (Redline x watts) - Total Adder Price
//   Commission_Total_PPW__c     Commission_Total / watts
//
// Everything is object-appropriate: the two objects use DIFFERENT source fields for
// deal type, finance source and watts, and the generator carries that in SRC below.
//
// ⚠️ COMPILED SIZE IS THE RISK HERE. Salesforce compiles a referenced formula INLINE,
// so Commission_Total carries copies of Redline + Total_Adder_Price, and
// Commission_Total_PPW carries a copy of all three. Total_Adder_Price alone is ~40 field
// references. This script prints the source size of every field and of the fully
// inlined expansion, so the risk is measured rather than hoped about. The limits are
// 3,900 characters of source and 5,000 bytes compiled; Check Only is the only thing
// that can confirm the compiled figure, and it is step 1 of the deploy checklist.
import fs from "node:fs";
import path from "node:path";
// Description <= 1,000 chars / help <= 255. v3 predated this guard, and the battery +
// expansion terms push Total_Adder_Price__c description length up, so it is wired in
// here too rather than trusting a Workbench round trip to find an overflow.
import { assertFieldLimits, reportFieldLimitHeadroom } from "../field-limits.mjs";

const OUT = path.resolve("salesforce/v3-redline-commission-fields");
fs.mkdirSync(path.join(OUT, "objects"), { recursive: true });

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// --- Priced adder catalog (identical on both objects) ------------------------
// FLAT: price x qty. PER-WATT: price x watts x qty (watts factored out once).
const FLAT_ADDERS = [
  "Sub_Panel", "Derate", "Heat_Detector", "Upgrade_225", "Upgrade_400",
  "Upgrade_225_UG", "Gateway3", "Site_Audit", "Travel", "Structural",
  "Small_System_10_12", "Small_System_13_15", "Software_Fee",
  "Active_Monitoring", "LR_Battery_Warranty", "Referral_Fee",
];
const PPW_ADDERS = ["Conduit_Attic", "Flat_Roof", "Roof_Tile", "Bird_Blocking"];
const NS_BLOCKS = [1, 2, 3, 4, 5];

/**
 * Per-object source fields. Verified against the live describe 2026-08-21.
 *
 * The two objects diverge on all three inputs, and one divergence is a trap:
 * `Lightreach` on Customer vs `LightReach` on Solar. Salesforce formula `=` on text is
 * case-INsensitive (that is why EXACT() exists), so either spelling would in fact match
 * either field — but each formula uses its own object's exact picklist value so nobody
 * has to know that to read it.
 */
const SRC = {
  Sundial_Customer__c: {
    company: "Sales_Company__c",
    // Two clean values: "Harmon Solar" / "Third-Party Dealer".
    internalValue: "Harmon Solar",
    finance: "Financing_Partner__c",
    lightreachValue: "Lightreach",
    kw: "Final_System_Size_kW__c",
    // Expansion-pack qty. Customer keeps its own Tesla_Expansion_Pack_Qty__c — the
    // object also carries a Gateway_Qty__c labelled "Tesla Expansion Pack Qty", but the
    // Customer-side intake writes the Tesla_* one, so that is the one priced here.
    expansionQty: "Tesla_Expansion_Pack_Qty__c",
    expansionQtyShort:
      "Customer also carries a Gateway_Qty__c with the same label; the Tesla_* field is the one its intake maintains.",
    expansionQtyNote:
      "Tesla_Expansion_Pack_Qty__c is the expansion-pack quantity on Customer (this object ALSO has a Gateway_Qty__c with the same label; the Customer intake maintains the Tesla_* field, so that is the one used).",
    companyNote:
      'Sales_Company__c is a two-value picklist ("Harmon Solar" / "Third-Party Dealer").',
    financeNote:
      "Financing_Partner__c is the finance source on Customer (Sales_Type_Partner__c on this object is an unconfigured placeholder holding only \"Value 1\" and must NOT be used).",
  },
  Sundial_Solar__c: {
    company: "Sales_Company_Harmon_Solar_or_Third__c",
    internalValue: "Harmon Solar",
    finance: "Sales_Type_Partner__c",
    lightreachValue: "LightReach",
    kw: "System_Size__c",
    // ⚠️ MISMATCHED PAIR ON PURPOSE: Tesla_Expansion_Pack_Unit_Price__c x Gateway_Qty__c.
    // Gateway_* IS the expansion pack on Solar (§3 reuse) — its label is literally
    // "Tesla Expansion Pack Qty", the budget engine reads Gateway_Qty__c, and the Create
    // Project map writes it. Solar's Tesla_Expansion_Pack_Quantity__c is an orphan that
    // nothing maintains; "tidying" this to the matching name would price every expansion
    // pack at zero. See README "The mismatched Tesla x Gateway pair".
    expansionQty: "Gateway_Qty__c",
    expansionQtyShort:
      "Tesla_* price x Gateway_* qty is DELIBERATE - Gateway_* IS the expansion pack here; Tesla_Expansion_Pack_Quantity__c is unmaintained. See the package README.",
    expansionQtyNote:
      "Gateway_Qty__c is the expansion-pack quantity on Solar (the Gateway_* group is REUSED for the Tesla Expansion Pack, §3 — its label is \"Tesla Expansion Pack Qty\" and budgetCalc reads it). Solar's identically-themed Tesla_Expansion_Pack_Quantity__c is NOT maintained by anything and is deliberately not used here.",
    companyNote:
      'Sales_Company_Harmon_Solar_or_Third__c holds "Harmon Solar" or one of ~55 dealer names, so INTERNAL is an equality test and EXTERNAL is everything else.',
    financeNote:
      "Sales_Type_Partner__c is the finance source on Solar (this object has no Financing_Partner__c).",
  },
};

const B = (f) => `BLANKVALUE(${f},0)`;
// PARENTHESISED, and that is load-bearing. Unbracketed, `Commission_Total__c/` +
// `BLANKVALUE(System_Size__c,0)*1000` parses left-to-right as (Total / kW) * 1000 —
// off by a factor of a million. Caught by verify.mjs, which is exactly why it exists.
const wattsExpr = (o) => `(${B(SRC[o].kw)}*1000)`;

// --- Formula bodies ----------------------------------------------------------

/**
 * REDLINE. Blank company -> NULL, deliberately: an unset sales company must never fall
 * through to the external rate. A null redline makes Commission_Total null too, which
 * shows up as an empty field rather than a plausible wrong number.
 */
function redlineFormula(o) {
  const s = SRC[o];
  const isLightreach = `TEXT(${s.finance})="${s.lightreachValue}"`;
  return (
    `IF(ISBLANK(TEXT(${s.company})),NULL,` +
    `IF(TEXT(${s.company})="${s.internalValue}",` +
    `IF(${isLightreach},2.10,2.20),` +
    `IF(${isLightreach},1.75,1.85)))`
  );
}

/**
 * TOTAL ADDER PRICE — every priced adder at PRICE (the commission side), never cost.
 *
 * The four per-watt adders share one `* watts` factor rather than repeating the watts
 * expression four times; that is purely a compiled-size measure and changes no result.
 *
 * NS blocks use the MARKED-UP total: Material x (1 + Markup) + Hours x 33 x 1.75.
 *
 * ⚠️ NO /100 on the markup — see the long note inside the function. A FORMULA reads a
 * Percent field already in the decimal domain (a true 25% reads as 0.25), unlike the REST
 * API which reads it as 25. budgetCalc keeps its /100 because it reads through SOQL.
 */
function totalAdderPriceFormula(o) {
  const flat = FLAT_ADDERS.map(
    (b) => `${B(`Adder_${b}_Price__c`)}*${B(`Adder_${b}_Qty__c`)}`
  ).join("+");
  const ppw =
    "(" +
    PPW_ADDERS.map((b) => `${B(`Adder_${b}_Price__c`)}*${B(`Adder_${b}_Qty__c`)}`).join("+") +
    `)*${wattsExpr(o)}`;
  // ⚠️ NO `/100` ON THE MARKUP, and that is the fix rather than an omission.
  //
  // A Salesforce FORMULA sees a Percent field ALREADY in the decimal domain: a field
  // storing a true 25% (API/SOQL value 25) reads as 0.25 inside a formula. Measured on a
  // live record by scripts/probe-percent-field-domain.mjs — writing 25 through REST and
  // reading Total_Adder_Price__c back showed the formula multiplying by 1.0025, i.e. it
  // saw 0.0025 after the old `/100`.
  //
  // So `(1 + Markup/100)` divided twice and produced a ~0% markup. The correct formula
  // term is `(1 + Markup)`.
  //
  // budgetCalc.js keeps ITS `/100` — it reads through SOQL, where the domain is DISPLAY
  // (25 means 25%). The two layers are not inconsistent; they read different domains.
  //
  // ⚠️ THIS MUST SHIP WITH THE DATA FIX. Until now two bugs cancelled: records carried
  // 2500 (from the decimal-domain default), the formula saw 25, and `25/100` gave the
  // right 1.25 by accident. Correcting the DATA alone would leave this formula computing
  // 1.0025; correcting THIS alone would leave it computing 26. Deploy them together.
  const ns = NS_BLOCKS.map(
    (n) =>
      `${B(`NS_Adder_${n}_Material_Cost__c`)}*(1+${B(`NS_Adder_${n}_Markup_Percent__c`)})` +
      `+${B(`NS_Adder_${n}_Labor_Hours__c`)}*33*1.75`
  ).join("+");
  // Batteries and Tesla expansion packs are sold OUTSIDE the redline x watts model, so
  // their PRICE has to be deducted here like any other adder. Without these two terms a
  // battery deal's commission is overpaid by the full battery + expansion price.
  // Note the qty field differs per object — see SRC[o].expansionQty and its note.
  const storage =
    `${B("Battery_Unit_Price__c")}*${B("Battery_Qty__c")}` +
    `+${B("Tesla_Expansion_Pack_Unit_Price__c")}*${B(SRC[o].expansionQty)}`;
  return `${flat}+${ppw}+${ns}+${storage}`;
}

/** COMMISSION TOTAL. Null redline or zero watts -> NULL, never a number. */
function commissionTotalFormula(o) {
  return (
    `IF(OR(ISBLANK(Commission_Redline_PPW__c),${wattsExpr(o)}=0),NULL,` +
    `${B("Contract_Amount__c")}-Commission_Redline_PPW__c*${wattsExpr(o)}-BLANKVALUE(Total_Adder_Price__c,0))`
  );
}

/**
 * COMMISSION PPW.
 *
 * ⚠️ REFERENCES Commission_Total__c EXACTLY ONCE, and that is a hard constraint, not a
 * style choice. The obvious form —
 *   IF(OR(ISBLANK(Commission_Total__c), watts=0), NULL, Commission_Total__c/watts)
 * — names the field twice, so Salesforce inlines the whole ~2,900-byte Commission_Total
 * expansion TWICE and the field compiles to ~6,000 bytes, over the 5,000 limit. Measured,
 * not guessed; the generator prints both figures.
 *
 * Dropping the ISBLANK costs nothing because `formulaTreatBlanksAs = BlankAsBlank`
 * propagates: a blank Commission_Total divided by anything is blank. The zero-watts guard
 * has to stay to avoid a division by zero.
 */
function commissionPpwFormula(o) {
  return `IF(${wattsExpr(o)}=0,NULL,Commission_Total__c/${wattsExpr(o)})`;
}

// --- Field definitions -------------------------------------------------------
const REDLINE_TABLE =
  "Redlines (D19): External+Lightreach 1.75, External+other 1.85, Internal+Lightreach 2.10, Internal+other 2.20.";

const BLANK_BEHAVIOUR =
  "BLANK HANDLING: every input is wrapped in BLANKVALUE(...,0), and a blank sales company or zero watts makes this field NULL rather than producing a number. A wrong redline is worse than no redline, so the formula refuses rather than defaulting.";

function fields(o) {
  const s = SRC[o];
  return [
    {
      api: "Commission_Redline_PPW__c",
      label: "Commission Redline $/W",
      type: "Currency", precision: 18, scale: 4,
      formula: redlineFormula(o),
      description:
        `D19 REDLINE model. The dollars-per-watt redline for this deal, chosen by deal type x finance source. ${REDLINE_TABLE} ` +
        `Deal type: INTERNAL when ${s.company} = "${s.internalValue}", EXTERNAL otherwise. ${s.companyNote} ` +
        `Finance: Lightreach when ${s.finance} = "${s.lightreachValue}". ${s.financeNote} ` +
        `BLANK ${s.company} => NULL (never falls through to the external rate).`,
      help: "The $/W redline used to work out commission. Blank if the sales company is not set.",
    },
    {
      api: "Total_Adder_Price__c",
      label: "Total Adder Price",
      type: "Currency", precision: 18, scale: 2,
      formula: totalAdderPriceFormula(o),
      description:
        "D19. Every priced adder at PRICE (the commission side), never cost: 16 flat at Price x Qty, " +
        "4 per-watt at Price x Watts x Qty, NS blocks 1-5 at Material x (1 + Markup) + Hours x 33 x 1.75, " +
        "and storage. Referral Fee IS included. " +
        "MARKUP HAS NO /100: a formula reads a Percent field as a decimal already (25% = 0.25 here, 25 via " +
        "the API), so dividing would divide twice. " +
        "THE 33 IS HARDCODED, like the redlines: the Powerwall labor rate the model is defined against, not " +
        "a per-job parameter - reading Battery_Labor_Rate__c would let one job's override change everybody's " +
        "commission. 1.75 is labor + 75% burden. " +
        "STORAGE: batteries (Battery_Unit_Price__c x Battery_Qty__c) and Tesla expansion packs " +
        `(Tesla_Expansion_Pack_Unit_Price__c x ${s.expansionQty}) sell OUTSIDE the redline x watts model, ` +
        "so their price is deducted here too. " + s.expansionQtyShort,
      help: "Sum of every priced adder on this job, used as a deduction in the commission calculation.",
    },
    {
      api: "Commission_Total__c",
      label: "Commission Total",
      type: "Currency", precision: 18, scale: 2,
      formula: commissionTotalFormula(o),
      description:
        "D19. Contract Amount - (Redline x system watts) - Total Adder Price. This is the REP commission in " +
        "DOLLARS and it supersedes the old PPW-input model entirely: Sales_Rep_Commission_PPW__c and " +
        "Internal_Rep_Commission_PPW__c are retired as calc inputs (the fields remain for history). " +
        "The budget calc reads THIS field and routes it to SLPC OUT (external) or SLPC (internal) by the " +
        "sales-company field. " + BLANK_BEHAVIOUR,
      help: "Total rep commission in dollars. Blank if the sales company is not set or the system size is zero.",
    },
    {
      api: "Commission_Total_PPW__c",
      label: "Commission Total $/W",
      type: "Currency", precision: 18, scale: 4,
      formula: commissionPpwFormula(o),
      description:
        "D19. Commission Total / system watts — the DERIVED per-watt rate, i.e. what the redline model works " +
        "out to for this job. " +
        "NOT to be confused with the pre-existing Commission_PPW__c on this object, which is a budget-calc " +
        "OUTPUT covering ALL commissions (rep + management + setter + burden) divided by watts. This one is " +
        "the rep commission only, and it is a formula. " + BLANK_BEHAVIOUR,
      help: "The rep commission expressed per watt. Derived, not an input.",
    },
  ];
}

function fieldXml(f) {
  return [
    "    <fields>",
    `        <fullName>${f.api}</fullName>`,
    `        <description>${esc(f.description)}</description>`,
    "        <externalId>false</externalId>",
    `        <formula>${esc(f.formula)}</formula>`,
    // BlankAsBlank so a blank input stays blank instead of silently becoming 0 — the
    // whole null-propagation design above depends on it.
    "        <formulaTreatBlanksAs>BlankAsBlank</formulaTreatBlanksAs>",
    `        <inlineHelpText>${esc(f.help)}</inlineHelpText>`,
    `        <label>${esc(f.label)}</label>`,
    `        <precision>${f.precision}</precision>`,
    "        <required>false</required>",
    `        <scale>${f.scale}</scale>`,
    "        <trackTrending>false</trackTrending>",
    `        <type>${f.type}</type>`,
    "    </fields>",
  ].join("\n");
}

// --- Compiled-size estimation ------------------------------------------------
// Salesforce inlines a referenced formula field's own formula. Expand ours the same way
// so the reported figure reflects what actually gets compiled.
function expand(formula, byApi, depth = 0) {
  if (depth > 5) return formula;
  let out = formula;
  for (const [api, f] of Object.entries(byApi)) {
    if (out.includes(api)) {
      out = out.split(api).join(`(${expand(f.formula, byApi, depth + 1)})`);
    }
  }
  return out;
}

const SOURCE_LIMIT = 3900;
const COMPILED_LIMIT = 5000;
let worst = 0;
const report = [];

for (const objName of Object.keys(SRC)) {
  const list = fields(objName);
  assertFieldLimits(list, `v3-redline-commission-fields (${objName})`);
  const byApi = Object.fromEntries(list.map((f) => [f.api, f]));

  const header = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  D19 REDLINE commission model — FORMULA fields for ${objName}.
  Reference: docs/integrations/acumatica-budget-rework-v2.md D19.

  Total Commission ($) = Contract Amount - (Redline x system watts) - Total Adder Price.
  ${REDLINE_TABLE}

  ALL FOUR ARE FORMULA FIELDS: nothing writes them, they cannot drift from their inputs,
  and they are safe to add to a page layout for reps to see before the calc ever runs.

  Object-appropriate sources (verified against the live describe 2026-08-21):
    deal type : ${SRC[objName].company} = "${SRC[objName].internalValue}" => INTERNAL
    finance   : ${SRC[objName].finance} = "${SRC[objName].lightreachValue}" => Lightreach
    watts     : ${SRC[objName].kw} x 1000

  Additive: collision-checked against the live describe, none of these four API names
  exists on ${objName}. NOTE the pre-existing Commission_PPW__c on this object is a
  different thing (a calc OUTPUT covering all commissions) and is untouched.
-->
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
`;

  fs.writeFileSync(
    path.join(OUT, "objects", `${objName}.object`),
    header + list.map(fieldXml).join("\n") + "\n</CustomObject>\n",
    "utf8"
  );

  for (const f of list) {
    const compiled = expand(f.formula, byApi);
    worst = Math.max(worst, compiled.length);
    report.push({
      object: objName.replace("Sundial_", "").replace("__c", ""),
      api: f.api,
      source: f.formula.length,
      inlined: compiled.length,
      type: `${f.type}(${f.precision - f.scale},${f.scale})`,
    });
  }
}

const members = Object.keys(SRC)
  .flatMap((o) => fields(o).map((f) => `        <members>${o}.${f.api}</members>`))
  .join("\n");

fs.writeFileSync(
  path.join(OUT, "package.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!--
  D19 REDLINE commission model — 8 FORMULA fields (4 x 2 objects), additive only.

  Zip this folder's CONTENTS (package.xml at the zip root) and deploy via
  Workbench -> Migration -> Deploy -> Single Package. RUN CHECK ONLY FIRST — that is
  what compiles the formulas and proves they fit inside Salesforce's 5,000-byte
  compiled limit. See README.md.

  ⚠️ ZIP WITH WINDOWS EXPLORER "Send to > Compressed (zipped) folder".
  NEVER PowerShell 5.1 Compress-Archive — it writes BACKSLASH path separators and
  Workbench cannot read the entries.
-->
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
${members}
        <name>CustomField</name>
    </types>
    <version>62.0</version>
</Package>
`,
  "utf8"
);

console.log(`wrote ${report.length} formula fields -> ${OUT}\n`);
console.log("  object   field                        type            source  inlined  headroom");
for (const r of report) {
  const flag = r.inlined > COMPILED_LIMIT ? "  ** OVER **" : r.inlined > COMPILED_LIMIT * 0.8 ? "  (tight)" : "";
  console.log(
    `  ${r.object.padEnd(8)} ${r.api.padEnd(28)} ${r.type.padEnd(15)} ${String(r.source).padStart(5)}  ${String(r.inlined).padStart(7)}  ${String(COMPILED_LIMIT - r.inlined).padStart(7)}${flag}`
  );
}
for (const objName of Object.keys(SRC)) {
  console.log(`\n  ${objName} metadata-length headroom:`);
  reportFieldLimitHeadroom(fields(objName));
}

console.log(`\n  source limit ${SOURCE_LIMIT} / compiled limit ${COMPILED_LIMIT}`);
console.log(`  worst inlined expansion: ${worst} bytes (${Math.round((worst / COMPILED_LIMIT) * 100)}% of the limit)`);
if (worst > COMPILED_LIMIT) {
  console.log("\n  ** RESTRUCTURE REQUIRED — see the README's fallback plan. **");
  process.exitCode = 1;
}
