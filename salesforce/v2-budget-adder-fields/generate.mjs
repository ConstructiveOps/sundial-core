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
    ppw: { precision: 7, scale: 3 },        // Sales_Rep_Commission_PPW__c (Number, NOT Currency)
  },
  Sundial_Solar__c: {
    // Labels: "Adder Sub Panel - Price"  (no colon, ASCII hyphen)
    adderLabel: (name, suffix) => `Adder ${name} - ${suffix}`,
    nsMarkup: { precision: 18, scale: 4 },
    nsHours: { precision: 18, scale: 1 },
    ppw: { precision: 18, scale: 3 },       // Sales_Rep_Commission_PPW__c (Number, NOT Currency)
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
//
// D15 (2026-08-20) REPLACED the original null-=-derive design with STATIC DEFAULTS.
// The calc now ALWAYS reads the Cost field and never derives, so every field ships
// with the value the sheet derivation produces. `basis` is that derivation, kept in
// the field description so a future editor can tell a deliberate override from a
// stale default.
//
// Flat: (price − hours × 33 × 1.75) ÷ 1.25   [1.75 = labor + 75% burden; 1.25 strips markup]
// Per-watt: same shape in per-watt terms.
const COSTS = [
  { api: "Adder_Sub_Panel_Cost__c", name: "Sub Panel", dflt: "261.40", basis: "(500 price − 3h × 33 × 1.75) ÷ 1.25" },
  { api: "Adder_Derate_Cost__c", name: "Derate", dflt: "341.40", basis: "(600 price − 3h × 33 × 1.75) ÷ 1.25" },
  { api: "Adder_Heat_Detector_Cost__c", name: "Heat Detector", dflt: "175.20", basis: "(450 price − 4h × 33 × 1.75) ÷ 1.25" },
  { api: "Adder_Upgrade_225_Cost__c", name: "225 Upgrade", dflt: "1540.80", basis: "(2850 price − 16h × 33 × 1.75) ÷ 1.25" },
  { api: "Adder_Upgrade_400_Cost__c", name: "400 Upgrade", dflt: "3220.80", basis: "(4950 price − 16h × 33 × 1.75) ÷ 1.25" },
  { api: "Adder_Upgrade_225_UG_Cost__c", name: "225 Upgrade-Underground", dflt: "1260.80", basis: "(2500 price − 16h × 33 × 1.75) ÷ 1.25" },
  { api: "Adder_Gateway3_Cost__c", name: "Gateway3", dflt: "2175.20", basis: "(2950 price − 4h × 33 × 1.75) ÷ 1.25" },
  { api: "Adder_Structural_Cost__c", name: "Structural", dflt: "250.00", basis: "direct — the engineer stamp cost, posts to SUBCON Engineering" },
  { api: "Adder_Conduit_Attic_Cost__c", name: "Conduit in Attic", perWatt: true, dflt: "0.052", basis: "(0.1 − 0.02 × 1.75) ÷ 1.25" },
  { api: "Adder_Flat_Roof_Cost__c", name: "Flat Roof", perWatt: true, dflt: "0.052", basis: "(0.1 − 0.02 × 1.75) ÷ 1.25" },
  { api: "Adder_Roof_Tile_Cost__c", name: "Roof Tile", perWatt: true, dflt: "0.009", basis: "(0.02 − 0.005 × 1.75) ÷ 1.25" },
  { api: "Adder_Bird_Blocking_Cost__c", name: "Bird Blocking", perWatt: true, dflt: "0.06", basis: "direct — posts to SUBCON Subcontractor" },
];

// The one sentence every Cost field must carry: the defaults are a snapshot of a
// derivation, not a live link to it.
const PRICE_DECOUPLING =
  "Price and cost are INDEPENDENT stored values: changing this adder's PRICE does not automatically move its COST. If a job needs both changed, change both.";

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

  // ---- §4d addendum: the internal-rep commission input -------------------
  // Type cloned from Sales_Rep_Commission_PPW__c on this object — which is a NUMBER
  // (double), not Currency, despite its "$/W" label, and diverges the same way the
  // NS blocks do: Number(4,3) on Customer, Number(15,3) on Solar.
  //
  // D9/D16: this is the second of TWO rep inputs. Which one is populated decides the
  // deal type — 3rd-party PPW > 0 routes to SLPC OUT + POs; internal PPW > 0 routes
  // to SLPC · SALESCOMM, payroll only, no POs. Both populated is a validation error.
  add({
    api: "Internal_Rep_Commission_PPW__c",
    label: "Internal Rep Commission PPW",
    type: "Number",
    precision: c.ppw.precision,
    scale: c.ppw.scale,
    defaultValue: 0,
    description:
      "v2 budget rework §4d / D9 / D16. Internal (Harmon) sales rep commission in dollars per watt. " +
      "The COMPANION to Sales_Rep_Commission_PPW__c, which is being repurposed as the 3rd-party rep input. " +
      "WHICH ONE IS POPULATED DETERMINES THE DEAL TYPE: 3rd-party > 0 posts to SLPC OUT · OTHER · M1&M2COM and generates commission POs; internal > 0 posts to SLPC · LABOR · SALESCOMM and is payroll only, NO POs (D16). Both populated is a validation error — the calc fails loudly rather than guessing. " +
      "Internal commission IS burdened (75%); 3rd-party is not. Type cloned from Sales_Rep_Commission_PPW__c on this object (Number, not Currency).",
    help:
      "Dollars per watt for an INTERNAL Harmon rep. Leave at 0 for a third-party dealer deal and fill 3rd Party Rep Commission PPW instead — never both.",
  }, { api: "Internal_Rep_Commission_PPW__c", type: `Number(${c.ppw.precision - c.ppw.scale},${c.ppw.scale})`, default: "0", section: "4d" });

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
        defaultValue: k.dflt,
        description:
          `v2 budget rework §4c / D15. COST side of the ${k.name} adder (budget), as opposed to the PRICE side (commission) per D6. ` +
          (perWatt
            ? `PER-WATT cost: the calc multiplies this by system watts when the adder is selected. Type cloned from this object's per-watt Adder_*_Price__c fields (Number, 3 dp). `
            : `PER-UNIT cost: the calc multiplies this by the adder's Qty. `) +
          `The calc ALWAYS reads this field and never derives a value, so it must not be left blank. Default ${k.dflt} = ${k.basis}. ` +
          PRICE_DECOUPLING,
        help:
          (perWatt
            ? `Cost PER WATT for this adder (× system watts). `
            : `Cost PER UNIT for this adder (× Qty). `) +
          `Defaults to ${k.dflt}; edit only when this job's cost differs. Changing the adder's price does not change this.`,
      }, {
        api: k.api,
        type: perWatt ? "Number(15,3) — per-watt" : "Currency(16,2)",
        default: k.dflt,
        section: "4c",
      });
    }
  }

  const header = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  v2 budget rework — new adder + commission fields for ${objName}.
  Reference: docs/integrations/acumatica-budget-rework-v2.md §4 (canonical inventory).

  ALL TYPE SIGNATURES BELOW WERE CLONED FROM THE LIVE DESCRIBE (2026-08-20), not from
  the spec prose. The two objects genuinely differ — Customer's NS blocks are
  Percent(3,3)/Number(5,1) vs Solar's Percent(14,4)/Number(17,1), and the commission
  PPW field is Number(4,3) vs Number(15,3) — so every field matches whichever object
  it sits on. See README.md "What the describe said".
${objName === "Sundial_Solar__c" ? `
  D15 (2026-08-20): the 12 Cost fields carry STATIC DEFAULTS. The earlier
  null-means-derive design is GONE — the calc always reads these fields and never
  derives, so a blank Cost field is a bug, not a signal.
` : ""}
  Additive only: a collision check against the live describe on 2026-08-20 found NONE
  of these ${manifest.length} API names already present on ${objName}.

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
  Workbench deploy: v2 budget rework adder + commission fields.
  Reference: docs/integrations/acumatica-budget-rework-v2.md §4a / §4b / §4c / §4d.

  ${manifest.length} new custom fields, additive only — no existing field is modified:
    §4a  28  7 new adders x (Price + Qty) x (Customer + Solar)
    §4b  16  NS adder blocks 4 and 5 x 4 fields x (Customer + Solar)
    §4c  12  COST fields, Sundial_Solar__c ONLY, each with a STATIC DEFAULT (D15).
             Per-UNIT for flat adders (calc x Qty), per-WATT for the four per-watt
             ones (calc x watts). The calc ALWAYS reads these and never derives.
    §4d   2  Internal_Rep_Commission_PPW__c x (Customer + Solar)

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
for (const s of ["4a", "4b", "4c", "4d"]) {
  console.log(`  §${s}: ${manifest.filter((m) => m.section === s).length}`);
}
console.log(`  Customer: ${manifest.filter((m) => m.object === "Sundial_Customer__c").length}`);
console.log(`  Solar:    ${manifest.filter((m) => m.object === "Sundial_Solar__c").length}`);
// Label length guard — Salesforce caps field labels at 40 characters.
