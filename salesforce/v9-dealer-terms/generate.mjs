// Generates salesforce/v9-dealer-terms/{package.xml,objects/*.object,permissionsets/*}
//
// D-085 — the dealer's commercial terms live on Sundial_Dealer__c. For a deal created
// on/after 2026-09-04 the redline comes from the deal's DEALER (which comes from its rep,
// D-064 A1); the legacy sales-company picklists are read only for records created before
// that date.
//
//   Sundial_Dealer__c     + Redline_PPW__c, Redline_LightReach_PPW__c,
//                           Acumatica_Vendor_ID__c, Acumatica_Vendor_Name__c   (NEW)
//   Sundial_Customer__c   Commission_Redline_PPW__c   (MODIFIED — replaces v8's formula)
//                         Sales_Rep_Name__c           (MODIFIED — coalesce)
//                         Dealer_Display_Name__c      (NEW formula)
//   Sundial_Solar__c      the same three
//   Sundial_Dealer_Terms  permission set — FLS for the integration user
//
// ⚠️ A CustomField deploy REPLACES THE WHOLE FIELD. For the two modified redline fields
// every attribute except <formula> and <description> is carried over from v8's .object
// files (read off disk below, not retyped), and verify.mjs asserts it.
//
// ⚠️ COMPILED SIZE. Salesforce inlines a referenced formula, across objects too, so the
// Solar redline now carries a copy of the Customer redline, and both objects'
// Commission_Total / Commission_Total_PPW (v3, unchanged here) carry a copy of the
// redline. Those dependants are recompiled by Salesforce when this deploys and are the
// fields that could go over. This script inlines the v3 formula text the same way and
// prints the figure; Check Only is the only thing that can confirm it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertFieldLimits, reportFieldLimitHeadroom } from "../field-limits.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = here;
const V8 = path.join(here, "..", "v8-lightreach-redline-date", "objects");
const V3 = path.join(here, "..", "v3-redline-commission-fields", "objects");
fs.mkdirSync(path.join(OUT, "objects"), { recursive: true });
fs.mkdirSync(path.join(OUT, "permissionsets"), { recursive: true });

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s) =>
  String(s).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** { api: { tag: value } } for every <fields> block of an .object file. */
function readFieldBlocks(file) {
  const xml = fs.readFileSync(file, "utf8");
  const out = {};
  for (const m of xml.matchAll(/<fields>([\s\S]*?)<\/fields>/g)) {
    const tags = {};
    for (const t of m[1].matchAll(/<([A-Za-z]+)>([\s\S]*?)<\/\1>/g)) tags[t[1]] = unesc(t[2]);
    out[tags.fullName] = tags;
  }
  return out;
}

// The cutoff. One constant so the two formulas cannot drift apart.
const CUTOFF = "DATE(2026,9,4)";

// --- Formula bodies ----------------------------------------------------------

/**
 * CUSTOMER REDLINE.
 *
 * Before the cutoff: the v8 formula with its post-cutoff sub-branches removed — they
 * can never be true before 2026-09-04, so removing them changes no pre-cutoff number.
 * That includes the live org's `Sales_Company__c = "Invictus Energy"` branch, which
 * could never be true at all: that picklist holds only "Harmon Solar" / "Third-Party
 * Dealer" (describe, 2026-10-22). Invictus's lower rate now lives on its dealer row.
 *
 * On/after: the dealer's two rates, picked by finance. No dealer ⇒ NULL, never a
 * picklist fallback — the same "blank ⇒ NULL, never the default" rule D19 applies to a
 * blank sales company. A dealer whose rate is blank ⇒ NULL too, by BlankAsBlank.
 */
function customerRedline() {
  const lr = `TEXT(Financing_Partner__c)="Lightreach"`;
  return (
    `IF(DATEVALUE(CreatedDate)<${CUTOFF},` +
    `IF(ISBLANK(TEXT(Sales_Company__c)),NULL,` +
    `IF(TEXT(Sales_Company__c)="Harmon Solar",IF(${lr},2.10,2.20),IF(${lr},1.75,1.85))),` +
    `IF(ISBLANK(Dealer__c),NULL,` +
    `IF(${lr},Dealer__r.Redline_LightReach_PPW__c,Dealer__r.Redline_PPW__c)))`
  );
}

/**
 * SOLAR REDLINE.
 *
 * A linked Solar record whose CUSTOMER was created on/after the cutoff takes the
 * Customer's redline — one deal, one redline, decided by the Customer's dealer and the
 * Customer's Financing_Partner__c. Everything else (pre-cutoff Customer, or no Customer
 * linked) is the v8 formula with its date sub-branch removed: v8 gave 1.65 only when a
 * Customer was linked AND created on/after the cutoff, which is exactly the case now
 * routed to the Customer, so every other record computes what it computes today.
 *
 * "LightReach" here, "Lightreach" on Customer: two different picklists, each spelled as
 * its own API value (describe, 2026-10-22). Formula `=` is case-insensitive anyway.
 */
function solarRedline() {
  const lr = `TEXT(Sales_Type_Partner__c)="LightReach"`;
  const co = "Sales_Company_Harmon_Solar_or_Third__c";
  return (
    `IF(AND(NOT(ISBLANK(Sundial_Customer__c)),DATEVALUE(Sundial_Customer__r.CreatedDate)>=${CUTOFF}),` +
    `Sundial_Customer__r.Commission_Redline_PPW__c,` +
    `IF(ISBLANK(TEXT(${co})),NULL,` +
    `IF(TEXT(${co})="Harmon Solar",IF(${lr},2.10,2.20),IF(${lr},1.75,1.85))))`
  );
}

// The name-joins are copied from the LIVE formulas (describe, 2026-10-22), spacing and
// `+` included — not rewritten with `&`. A rep with a lookup reads exactly as today.
const CUSTOMER_REP_JOIN = `Sales_Rep__r.First_Name__c  + " " +  Sales_Rep__r.Last_Name__c`;
const SOLAR_REP_JOIN = `Sales_Rep__r.First_Name__c + " " +  Sales_Rep__r.Last_Name__c`;

function customerRepName() {
  return (
    `IF(NOT(ISBLANK(Sales_Rep__c)),${CUSTOMER_REP_JOIN},` +
    `IF(NOT(ISBLANK(TEXT(Sunbase_Sales_Rep__c))),TEXT(Sunbase_Sales_Rep__c),TEXT(Dealer_Name__c)))`
  );
}

function solarRepName() {
  return (
    `IF(NOT(ISBLANK(Sales_Rep__c)),${SOLAR_REP_JOIN},` +
    `IF(NOT(ISBLANK(TEXT(Sales_Representative__c))),TEXT(Sales_Representative__c),` +
    `IF(NOT(ISBLANK(Third_Party_Sales_Representative__c)),Third_Party_Sales_Representative__c,` +
    `TEXT(Sales_Company_Harmon_Solar_or_Third__c))))`
  );
}

// --- Field definitions -------------------------------------------------------

const DEALER_FIELDS = [
  {
    api: "Redline_PPW__c",
    label: "Redline $/W",
    type: "Currency", precision: 18, scale: 4,
    description:
      "D-085. This dealer's commission redline in $/W for every financing partner EXCEPT LightReach. " +
      "Read by Commission_Redline_PPW__c on Sundial_Customer__c (and through it on Sundial_Solar__c) for deals " +
      "whose Customer was created on/after 2026-09-04; earlier deals keep the legacy sales-company rates. " +
      "BLANK means no redline: the deal's redline and commission total are blank, never a default. " +
      "Seeded by scripts/backfill-dealer-terms.mjs (Harmon Solar 2.20, Invictus Energy 1.75, everyone else 1.85).",
    help: "Commission redline for every financing partner except LightReach.",
  },
  {
    api: "Redline_LightReach_PPW__c",
    label: "Redline $/W (LightReach)",
    type: "Currency", precision: 18, scale: 4,
    description:
      "D-085. This dealer's commission redline in $/W for LightReach-financed deals (Customer " +
      "Financing_Partner__c = \"Lightreach\"). Same reach and blank rule as Redline_PPW__c. " +
      "Seeded by scripts/backfill-dealer-terms.mjs (Harmon Solar 2.10, Invictus Energy 1.65, everyone else 1.65).",
  },
  {
    api: "Acumatica_Vendor_ID__c",
    label: "Acumatica Vendor ID",
    type: "Text", length: 20,
    description:
      "D-085. The Acumatica VendorID this dealer's commission POs are raised against. Set by Constructive Ops " +
      "once Harmon finance creates the vendor; seeded from docs/integrations/dealer-vendor-map.csv by " +
      "scripts/backfill-dealer-terms.mjs. Blank = no vendor yet: a PO must fail loudly rather than guess (D4). " +
      "Not yet read by sundial-acumatica-commission-po, which still resolves the vendor from the Solar " +
      "sales-company picklist through the CSV.",
    help: "The vendor the commission POs are raised against. Set by Constructive Ops once Harmon finance creates the vendor.",
  },
  {
    api: "Acumatica_Vendor_Name__c",
    label: "Acumatica Vendor Name",
    type: "Text", length: 80,
    description:
      "D-085. The Acumatica vendor's name, for a human checking the vendor ID is the right company. " +
      "Informational only; nothing reads it.",
  },
];

const v8Customer = readFieldBlocks(path.join(V8, "Sundial_Customer__c.object")).Commission_Redline_PPW__c;
const v8Solar = readFieldBlocks(path.join(V8, "Sundial_Solar__c.object")).Commission_Redline_PPW__c;

const REDLINE_TABLE =
  "Legacy rates (unchanged): Internal+Lightreach 2.10, Internal+other 2.20, External+Lightreach 1.75, External+other 1.85.";

function dealerDisplayName(obj) {
  return {
    api: "Dealer_Display_Name__c",
    label: "Dealer (based on Sales Rep)",
    type: "Text", formula: "Dealer__r.Name",
    description:
      `D-085. The name of this ${obj === "Sundial_Customer__c" ? "deal" : "project"}'s Dealer__c, which the server sets from ` +
      "the sales rep (D-064 A1). Blank when no dealer is set. Shown beside the legacy sales-company picklist, " +
      "which is read only for deals created before 2026-09-04.",
    help: "The dealer that owns this deal, from its sales rep. Blank until a rep with a dealer is assigned.",
  };
}

const OBJECTS = {
  Sundial_Dealer__c: DEALER_FIELDS,
  Sundial_Customer__c: [
    {
      api: "Commission_Redline_PPW__c",
      modifiedFrom: v8Customer,
      formula: customerRedline(),
      description:
        "D19 redline, amended D36 and D-085 (2026-10-22). Chosen by the Customer's CreatedDate. " +
        "BEFORE 2026-09-04 the legacy rule: INTERNAL when Sales_Company__c = \"Harmon Solar\", EXTERNAL otherwise; " +
        "Lightreach when Financing_Partner__c = \"Lightreach\". " + REDLINE_TABLE + " Blank Sales_Company__c => NULL. " +
        "ON/AFTER 2026-09-04 the DEALER's terms: Dealer__r.Redline_LightReach_PPW__c when Lightreach, else " +
        "Dealer__r.Redline_PPW__c; the picklists are not read. No Dealer__c, or a blank dealer rate => NULL, never a " +
        "default. Dealer__c comes from the sales rep (D-064 A1). The Solar twin reads THIS field for deals on/after the " +
        "cutoff. Sales_Type_Partner__c on this object is a placeholder and must not be used.",
    },
    {
      api: "Sales_Rep_Name__c",
      label: "Sales Rep Name",
      type: "Text", formula: customerRepName(),
      description:
        "D-085. The rep's name for display and the Sales page's rep filter: the Sales_Rep__c lookup's First + Last " +
        "when set; else the legacy Sunbase_Sales_Rep__c; else the legacy Dealer_Name__c. Display only - ownership " +
        "and access key on Sales_Rep__c / Dealer__c, never on this text.",
    },
    dealerDisplayName("Sundial_Customer__c"),
  ],
  Sundial_Solar__c: [
    {
      api: "Commission_Redline_PPW__c",
      modifiedFrom: v8Solar,
      formula: solarRedline(),
      description:
        "D19 redline, amended D36 and D-085 (2026-10-22). When a Customer is linked and the CUSTOMER was created " +
        "on/after 2026-09-04: Sundial_Customer__r.Commission_Redline_PPW__c - the Customer's dealer terms and the " +
        "Customer's Financing_Partner__c; one deal, one redline. OTHERWISE (earlier Customer, or none linked) the " +
        "legacy rule: INTERNAL when Sales_Company_Harmon_Solar_or_Third__c = \"Harmon Solar\", EXTERNAL otherwise; " +
        "Lightreach when Sales_Type_Partner__c = \"LightReach\" (this object's spelling). " + REDLINE_TABLE +
        " Blank sales company => NULL. Every record on the legacy branch computes exactly what v8 computed.",
    },
    {
      api: "Sales_Rep_Name__c",
      label: "Sales Rep Name",
      type: "Text", formula: solarRepName(),
      description:
        "D-085. The rep's name for display and the Solar page's rep filter: the Sales_Rep__c lookup's First + Last " +
        "when set; else the legacy Sales_Representative__c; else Third_Party_Sales_Representative__c; else the " +
        "legacy Sales_Company_Harmon_Solar_or_Third__c. Display only - ownership keys on Sales_Rep__c / Dealer__c.",
    },
    dealerDisplayName("Sundial_Solar__c"),
  ],
};

// --- XML ---------------------------------------------------------------------

function fieldXml(f) {
  const L = (tag, v) => `        <${tag}>${esc(v)}</${tag}>`;
  const lines = ["    <fields>", L("fullName", f.api)];

  if (f.modifiedFrom) {
    // Carry every v8 attribute across, in v8's order, replacing only these two.
    for (const [tag, v] of Object.entries(f.modifiedFrom)) {
      if (tag === "fullName") continue;
      if (tag === "description") lines.push(L(tag, f.description));
      else if (tag === "formula") lines.push(L(tag, f.formula));
      else lines.push(L(tag, v));
    }
  } else {
    if (f.description) lines.push(L("description", f.description));
    lines.push("        <externalId>false</externalId>");
    if (f.formula) {
      lines.push(L("formula", f.formula));
      // BlankAsBlank, as on every Sundial formula: a blank input stays blank.
      lines.push("        <formulaTreatBlanksAs>BlankAsBlank</formulaTreatBlanksAs>");
    }
    if (f.help) lines.push(L("inlineHelpText", f.help));
    lines.push(L("label", f.label));
    if (f.type === "Text" && !f.formula) lines.push(L("length", f.length));
    if (f.type === "Currency") lines.push(L("precision", f.precision));
    lines.push("        <required>false</required>");
    if (f.type === "Currency") lines.push(L("scale", f.scale));
    lines.push("        <trackTrending>false</trackTrending>");
    lines.push(L("type", f.type));
    if (f.type === "Text") lines.push("        <unique>false</unique>");
  }
  lines.push("    </fields>");
  return lines.join("\n");
}

const HEADERS = {
  Sundial_Dealer__c:
    "4 NEW fields - the dealer's commercial terms (redlines, Acumatica vendor). Additive.",
  Sundial_Customer__c:
    "MODIFIES Commission_Redline_PPW__c (replaces v8) and Sales_Rep_Name__c; ADDS Dealer_Display_Name__c.\n" +
    "  Commission_Redline_PPW__c carries every v8 attribute except <formula> and <description>.",
  Sundial_Solar__c:
    "MODIFIES Commission_Redline_PPW__c (replaces v8) and Sales_Rep_Name__c; ADDS Dealer_Display_Name__c.\n" +
    "  Commission_Redline_PPW__c carries every v8 attribute except <formula> and <description>.",
};

for (const [obj, list] of Object.entries(OBJECTS)) {
  assertFieldLimits(list, `v9-dealer-terms (${obj})`);
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<!--\n  v9 DEALER TERMS (D-085) - ${obj}.\n  ${HEADERS[obj]}\n` +
    `  GENERATED by generate.mjs - edit that, not this file.\n-->\n` +
    `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    list.map(fieldXml).join("\n") +
    "\n</CustomObject>\n";
  fs.writeFileSync(path.join(OUT, "objects", `${obj}.object`), xml, "utf8");
}

// --- Permission set ----------------------------------------------------------
// Read on every new field for the integration user (the cache sync and the Lambdas read
// as it). The four dealer fields are EDITABLE as well: scripts/backfill-dealer-terms.mjs
// writes them as the integration user, and Read alone would fail every write. Formula
// fields cannot be editable. The two MODIFIED fields already have FLS and are not here.
const FLS = [
  ...DEALER_FIELDS.map((f) => ({ field: `Sundial_Dealer__c.${f.api}`, editable: true })),
  { field: "Sundial_Customer__c.Dealer_Display_Name__c", editable: false },
  { field: "Sundial_Solar__c.Dealer_Display_Name__c", editable: false },
];

fs.writeFileSync(
  path.join(OUT, "permissionsets", "Sundial_Dealer_Terms.permissionset"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!--
  D-085: FLS on every field v9-dealer-terms ADDS, for the Sundial integration user.
  Assign this to the integration user, OR merge these entries into the integration
  permission set it already holds.

  The four Sundial_Dealer__c fields are readable AND editable: the terms are seeded by
  scripts/backfill-dealer-terms.mjs, which writes as the integration user. The two
  Dealer_Display_Name__c formulas are read-only by definition.
  The two MODIFIED fields (Commission_Redline_PPW__c, Sales_Rep_Name__c) keep the FLS
  they already have and are deliberately absent.
-->
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Sundial Dealer Terms</label>
    <description>D-085: field access for the dealer's commercial terms (redlines, Acumatica vendor) and the Dealer (based on Sales Rep) formula, for the Sundial integration user.</description>
${FLS.map(
  (p) => `    <fieldPermissions>
        <editable>${p.editable}</editable>
        <field>${p.field}</field>
        <readable>true</readable>
    </fieldPermissions>`
).join("\n")}
</PermissionSet>
`,
  "utf8"
);

// --- package.xml ---------------------------------------------------------------
const members = Object.entries(OBJECTS)
  .flatMap(([o, list]) => list.map((f) => `        <members>${o}.${f.api}</members>`))
  .join("\n");
fs.writeFileSync(
  path.join(OUT, "package.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!--
  v9 DEALER TERMS (D-085). 6 NEW fields + 4 MODIFIED formula fields + 1 permission set.
  NOT purely additive: Commission_Redline_PPW__c and Sales_Rep_Name__c are REPLACED on
  both objects. See README.md for the order (backfill the dealer terms straight after).

  Build the zip with the builder, never by hand:
      node scripts/build-zips.mjs v9-dealer-terms
  Workbench -> Migration -> Deploy -> Single Package. CHECK ONLY FIRST - it compiles the
  formulas and the v3 Commission_Total / Commission_Total_PPW fields that inline them.
-->
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
${members}
        <name>CustomField</name>
    </types>
    <types>
        <members>Sundial_Dealer_Terms</members>
        <name>PermissionSet</name>
    </types>
    <version>62.0</version>
</Package>
`,
  "utf8"
);

// --- Re-read what was written (v6's lesson: a missing </fields> passes everything else) ---
let reread = 0;
for (const obj of Object.keys(OBJECTS)) {
  const xml = fs.readFileSync(path.join(OUT, "objects", `${obj}.object`), "utf8");
  const opens = (xml.match(/<fields>/g) || []).length;
  const closes = (xml.match(/<\/fields>/g) || []).length;
  const parsed = Object.keys(readFieldBlocks(path.join(OUT, "objects", `${obj}.object`))).length;
  if (opens !== closes || parsed !== OBJECTS[obj].length) {
    throw new Error(`${obj}.object re-read: ${opens} <fields>, ${closes} </fields>, ${parsed} parsed, ${OBJECTS[obj].length} expected`);
  }
  reread++;
}

// --- Compiled-size estimate ---------------------------------------------------
// Inline formula references the way Salesforce does: the Customer redline into the Solar
// redline (cross-object), the redline + v3's Total_Adder_Price into v3's
// Commission_Total, and that into Commission_Total_PPW.
const SOURCE_LIMIT = 3900;
const COMPILED_LIMIT = 5000;
const v3 = {
  Sundial_Customer__c: readFieldBlocks(path.join(V3, "Sundial_Customer__c.object")),
  Sundial_Solar__c: readFieldBlocks(path.join(V3, "Sundial_Solar__c.object")),
};
const redline = {
  Sundial_Customer__c: customerRedline(),
  Sundial_Solar__c: solarRedline().replace(
    "Sundial_Customer__r.Commission_Redline_PPW__c",
    `(${customerRedline()})`
  ),
};
function inlined(obj, api) {
  const f = (a) => v3[obj][a].formula;
  const sub = (text, a, body) => text.replace(new RegExp(`(?<![.\\w])${a}`, "g"), `(${body})`);
  const total = sub(sub(f("Commission_Total__c"), "Commission_Redline_PPW__c", redline[obj]), "Total_Adder_Price__c", f("Total_Adder_Price__c"));
  if (api === "Commission_Redline_PPW__c") return redline[obj];
  if (api === "Commission_Total__c") return total;
  return sub(f("Commission_Total_PPW__c"), "Commission_Total__c", total);
}

let worst = 0;
let overSource = false;
console.log(`wrote ${Object.values(OBJECTS).flat().length} fields + 1 permission set -> ${OUT}`);
console.log(`  ${reread} object file(s) re-read from disk and parsed OK\n`);
console.log("  object    field                          source  inlined  headroom");
for (const obj of ["Sundial_Customer__c", "Sundial_Solar__c"]) {
  const src = obj === "Sundial_Customer__c" ? customerRedline() : solarRedline();
  if (src.length > SOURCE_LIMIT) overSource = true;
  for (const api of ["Commission_Redline_PPW__c", "Commission_Total__c", "Commission_Total_PPW__c"]) {
    const n = inlined(obj, api).length;
    worst = Math.max(worst, n);
    const flag = n > COMPILED_LIMIT ? "  ** OVER **" : n > COMPILED_LIMIT * 0.8 ? "  (tight)" : "";
    const source = api === "Commission_Redline_PPW__c" ? src.length : v3[obj][api].formula.length;
    console.log(
      `  ${obj.replace("Sundial_", "").replace("__c", "").padEnd(9)} ${api.padEnd(30)} ${String(source).padStart(6)}  ${String(n).padStart(7)}  ${String(COMPILED_LIMIT - n).padStart(8)}${flag}`
    );
  }
}
for (const [obj, list] of Object.entries(OBJECTS)) {
  console.log(`\n  ${obj} metadata-length headroom:`);
  reportFieldLimitHeadroom(list);
}
console.log(`\n  source limit ${SOURCE_LIMIT} / compiled limit ${COMPILED_LIMIT}`);
console.log(`  worst inlined expansion: ${worst} (${Math.round((worst / COMPILED_LIMIT) * 100)}% of the limit)`);
console.log("  (an ESTIMATE from source text - Check Only is the real compile)");
if (worst > COMPILED_LIMIT || overSource) {
  console.log("\n  ** OVER A LIMIT - split the legacy branch, see README **");
  process.exitCode = 1;
}
