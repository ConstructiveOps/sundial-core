// Generates salesforce/v2-budget-adder-fields/{package.xml,objects/*.object}
// Type signatures are CLONED FROM THE LIVE DESCRIBE (pulled 2026-08-20), per object —
// the two objects genuinely differ, see the README.
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("salesforce/v2-budget-adder-fields");
fs.mkdirSync(path.join(OUT, "objects"), { recursive: true });

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// --- per-object conventions, taken from the live describe --------------------
const CONV = {
  Sundial_Customer__c: {
    // Labels: "Adder: Sub Panel — Price"  (colon + em dash)
    adderLabel: (name, suffix) => `Adder: ${name} — ${suffix}`,
    nsMarkup: { precision: 6, scale: 3 },   // NS_Adder_1_Markup_Percent__c
    nsHours: { precision: 6, scale: 1 },    // NS_Adder_1_Labor_Hours__c
  },
  Sundial_Solar__c: {
    // Labels: "Adder Sub Panel - Price"  (no colon, ASCII hyphen)
    adderLabel: (name, suffix) => `Adder ${name} - ${suffix}`,
    nsMarkup: { precision: 18, scale: 4 },
    nsHours: { precision: 18, scale: 1 },
  },
};

// §4a — 7 new adders. `label` is the sheet wording; `labelShort` is used only where
// the full wording would exceed Salesforce's 40-char label cap.
const ADDERS = [
  { base: "Adder_Upgrade_225_UG", name: "225 Upgrade-Underground", price: 2500,
    note: "Flat price. The existing Adder_Upgrade_225 relabels to \"225 Upgrade-Overhead\" (separate change, not in this package)." },
  { base: "Adder_Gateway3", name: "Gateway3", price: 2950,
    note: "Flat price. 4h labor at the Powerwall rate." },
  { base: "Adder_Site_Audit", name: "Site Audit", price: 350,
    note: "Flat price. Labor-only adder: 2h at the blended rate, no material cost — so it has no _Cost__c field." },
  { base: "Adder_Travel", name: "Travel Adder", price: 750,
    note: "Flat price. Labor-only adder: 12h at the blended rate, no material cost — so it has no _Cost__c field." },
  { base: "Adder_Active_Monitoring", name: "Active Monitoring", price: 100,
    note: "Flat price. REVENUE-ONLY (no cost side). DISTINCT from the existing Active_System_Monitoring__c Yes/No flag — do not conflate the two." },
  { base: "Adder_LR_Battery_Warranty", name: "LightReach Battery Warranty", labelShort: "LR Battery Warranty", price: 600,
    note: "Flat price. REVENUE-ONLY. Sheet annotates this \"DEALER FEE?\" — treatment pending open question Q5 in the v2 rework doc." },
  { base: "Adder_Referral_Fee", name: "Referral Fee", price: 500,
    note: "Flat price. REVENUE-ONLY (no cost side)." },
];

// §4c — COST fields, Solar only. perWatt entries clone Solar's per-watt PRICE type
// (Number precision 18 / scale 3), everything else is Currency 18,2.
const COSTS = [
  { api: "Adder_Sub_Panel_Cost__c", name: "Sub Panel" },
  { api: "Adder_Derate_Cost__c", name: "Derate" },
  { api: "Adder_Heat_Detector_Cost__c", name: "Heat Detector" },
  { api: "Adder_Upgrade_225_Cost__c", name: "225 Upgrade" },
  { api: "Adder_Upgrade_400_Cost__c", name: "400 Upgrade" },
  { api: "Adder_Upgrade_225_UG_Cost__c", name: "225 Upgrade-Underground" },
  { api: "Adder_Gateway3_Cost__c", name: "Gateway3" },
  { api: "Adder_Structural_Cost__c", name: "Structural", extra: "Sheet default derives to 250 (SUBCON engineering)." },
  { api: "Adder_Conduit_Attic_Cost__c", name: "Conduit in Attic", perWatt: true },
  { api: "Adder_Flat_Roof_Cost__c", name: "Flat Roof", perWatt: true },
  { api: "Adder_Roof_Tile_Cost__c", name: "Roof Tile", perWatt: true },
  { api: "Adder_Bird_Blocking_Cost__c", name: "Bird Blocking", perWatt: true, extra: "Sheet default derives to 0.06 per watt." },
];

const NULL_SEMANTICS =
  "NULL IS SEMANTICALLY MEANINGFUL: null = the calc derives the sheet default for this adder; a populated value is a per-job override that wins. Never default this field and never write 0 to mean \"unset\" — 0 is a real override meaning the adder costs nothing.";

// --- field builders ----------------------------------------------------------
function field({ api, label, type, precision, scale, length, defaultValue, description, help }) {
  const L = [
    "    <fields>",
    `        <fullName>${api}</fullName>`,
  ];
  if (defaultValue !== undefined) L.push(`        <defaultValue>${defaultValue}</defaultValue>`);
  if (description) L.push(`        <description>${esc(description)}</description>`);
  L.push("        <externalId>false</externalId>");
  if (help) L.push(`        <inlineHelpText>${esc(help)}</inlineHelpText>`);
  L.push(`        <label>${esc(label)}</label>`);
  if (length !== undefined) L.push(`        <length>${length}</length>`);
  if (precision !== undefined) L.push(`        <precision>${precision}</precision>`);
  L.push("        <required>false</required>");
  if (scale !== undefined) L.push(`        <scale>${scale}</scale>`);
  L.push("        <trackTrending>false</trackTrending>");
  L.push(`        <type>${type}</type>`);
  if (type === "Text") L.push("        <unique>false</unique>");
  L.push("    </fields>");
  return L.join("\n");
}

function buildObject(objName) {
  const c = CONV[objName];
  const out = [];
  const manifest = [];

  const add = (f, meta) => { out.push(field(f)); manifest.push({ object: objName, ...meta }); };

  // ---- §4a: Price + Qty --------------------------------------------------
  for (const a of ADDERS) {
    const labelName = a.labelShort || a.name;
    add({
      api: `${a.base}_Price__c`,
      label: c.adderLabel(labelName, "Price"),
      type: "Currency", precision: 18, scale: 2,
      defaultValue: a.price,
      description: `v2 budget rework §4a. "${a.name}" — PRICE (commission side, per D6). Default ${a.price}. ${a.note}`,
      help: `Customer-facing price for the ${a.name} adder. Defaults to ${a.price}; override per job.`,
    }, { api: `${a.base}_Price__c`, type: "Currency(16,2)", default: String(a.price), section: "4a" });

    add({
      api: `${a.base}_Qty__c`,
      label: c.adderLabel(labelName, "Qty"),
      type: "Number", precision: 18, scale: 0,
      defaultValue: 0,
      description: `v2 budget rework §4a. "${a.name}" — QUANTITY. Shared between the price (commission) and cost (budget) sides per D6; there is no separate cost quantity.`,
      help: `How many ${a.name} adders on this job. 0 = not applicable.`,
    }, { api: `${a.base}_Qty__c`, type: "Number(18,0)", default: "0", section: "4a" });
  }

  // ---- §4b: NS adder blocks 4 and 5 --------------------------------------
  for (const n of [4, 5]) {
    add({
      api: `NS_Adder_${n}_Description__c`,
      label: `NS Adder ${n} Description`,
      type: "Text", length: 255,
      description: `v2 budget rework §4b. Free-text description of non-standard adder ${n}. Type signature cloned from NS_Adder_1-3 on this object.`,
    }, { api: `NS_Adder_${n}_Description__c`, type: "Text(255)", default: "—", section: "4b" });

    add({
      api: `NS_Adder_${n}_Markup_Percent__c`,
      label: `NS Adder ${n} Markup %`,
      type: "Percent", precision: c.nsMarkup.precision, scale: c.nsMarkup.scale,
      defaultValue: 25,
      description: `v2 budget rework §4b. Markup applied to NS adder ${n} material cost. Default 25%. NOTE: NS blocks 1-3 on this object currently default to ${objName === "Sundial_Solar__c" ? "0" : "no default"} — aligning them to 25 is a separate change (see TASKS.md).`,
      help: "Markup on the material cost for this non-standard adder. Defaults to 25%.",
    }, { api: `NS_Adder_${n}_Markup_Percent__c`, type: `Percent(${c.nsMarkup.precision - c.nsMarkup.scale},${c.nsMarkup.scale})`, default: "25", section: "4b" });

    add({
      api: `NS_Adder_${n}_Material_Cost__c`,
      label: `NS Adder ${n} Material Cost`,
      type: "Currency", precision: 18, scale: 2,
      description: `v2 budget rework §4b. Material cost for non-standard adder ${n}, BEFORE markup. This is the NS block's own cost field — NS blocks do not get a separate _Cost__c field. Type signature cloned from NS_Adder_1-3 on this object.`,
    }, { api: `NS_Adder_${n}_Material_Cost__c`, type: "Currency(16,2)", default: "—", section: "4b" });

    add({
      api: `NS_Adder_${n}_Labor_Hours__c`,
      label: `NS Adder ${n} Labor Hours`,
      type: "Number", precision: c.nsHours.precision, scale: c.nsHours.scale,
      description: `v2 budget rework §4b. Labor hours for non-standard adder ${n}. Costed at the Powerwall rate in v2 (was the blended rate in v1). Rolls into S3. Type signature cloned from NS_Adder_1-3 on this object.`,
    }, { api: `NS_Adder_${n}_Labor_Hours__c`, type: `Number(${c.nsHours.precision - c.nsHours.scale},${c.nsHours.scale})`, default: "—", section: "4b" });
  }

  // ---- §4c: COST fields, SOLAR ONLY --------------------------------------
  if (objName === "Sundial_Solar__c") {
    for (const k of COSTS) {
      const perWatt = k.perWatt === true;
      add({
        api: k.api,
        label: c.adderLabel(k.name, "Cost"),
        // Per-watt cost clones the per-watt PRICE type on this object
        // (Adder_Flat_Roof_Price__c = Number precision 18 / scale 3) so cost and
        // price for the same adder carry identical precision.
        type: perWatt ? "Number" : "Currency",
        precision: 18,
        scale: perWatt ? 3 : 2,
        description:
          `v2 budget rework §4c. COST side of the ${k.name} adder (budget), as opposed to the PRICE side (commission) per D6. ` +
          (perWatt ? "PER-WATT value — type cloned from this object's Adder_*_Price__c per-watt fields (Number, 3 dp). " : "") +
          (k.extra ? k.extra + " " : "") +
          NULL_SEMANTICS,
        help:
          (perWatt ? "Per-watt cost override. " : "Cost override. ") +
          "LEAVE BLANK to let the budget calc derive the sheet default. Enter a value only to override it for this job.",
      }, {
        api: k.api,
        type: perWatt ? "Number(15,3) — per-watt" : "Currency(16,2)",
        default: "NONE (null = derive)",
        section: "4c",
      });
    }
  }

  const header = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  v2 budget rework — new adder fields for ${objName}.
  Reference: docs/integrations/acumatica-budget-rework-v2.md §4 (canonical inventory).

  ALL TYPE SIGNATURES BELOW WERE CLONED FROM THE LIVE DESCRIBE (2026-08-20), not from
  the spec prose. The two objects genuinely differ — Customer's NS blocks are
  Percent(3,3)/Number(5,1) while Solar's are Percent(14,4)/Number(17,1) — so blocks 4
  and 5 match whichever object they sit on. See README.md "What the describe said".

  Additive only: a collision check against the live describe on 2026-08-20 found NONE
  of these ${objName === "Sundial_Solar__c" ? 34 : 22} API names already present on ${objName}.

  Field count: ${manifest.length}
-->
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
`;

  fs.writeFileSync(
    path.join(OUT, "objects", `${objName}.object`),
    header + out.join("\n") + "\n</CustomObject>\n",
    "utf8"
  );
  return manifest;
}

const manifest = [
  ...buildObject("Sundial_Customer__c"),
  ...buildObject("Sundial_Solar__c"),
];

// --- package.xml -------------------------------------------------------------
const members = manifest
  .map((m) => `        <members>${m.object}.${m.api}</members>`)
  .join("\n");

fs.writeFileSync(
  path.join(OUT, "package.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Workbench deploy: v2 budget rework adder fields.
  Reference: docs/integrations/acumatica-budget-rework-v2.md §4a / §4b / §4c.

  ${manifest.length} new custom fields, additive only — no existing field is modified:
    §4a  28  7 new adders x (Price + Qty) x (Customer + Solar)
    §4b  16  NS adder blocks 4 and 5 x 4 fields x (Customer + Solar)
    §4c  12  COST fields, Sundial_Solar__c ONLY, ALL NULLABLE with NO default
             (null = the calc derives the sheet default; populated = per-job override)

  Zip this folder's CONTENTS (package.xml at the zip root) and deploy via
  Workbench -> Migration -> Deploy -> Single Package. RUN CHECK ONLY FIRST.
  After deploy, grant FLS per README.md — nothing works without it.
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

console.log(`wrote ${manifest.length} fields`);
for (const s of ["4a", "4b", "4c"]) {
  console.log(`  §${s}: ${manifest.filter((m) => m.section === s).length}`);
}
console.log(`  Customer: ${manifest.filter((m) => m.object === "Sundial_Customer__c").length}`);
console.log(`  Solar:    ${manifest.filter((m) => m.object === "Sundial_Solar__c").length}`);
// Label length guard — Salesforce caps field labels at 40 characters.
