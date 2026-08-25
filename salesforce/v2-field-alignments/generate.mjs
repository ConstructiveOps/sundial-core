// Generates salesforce/v2-field-alignments/{package.xml,objects/*.object}
//
// ⚠️ THIS IS A **MODIFY** PACKAGE. A <CustomField> in a deploy REPLACES the whole field
// definition — every attribute you omit reverts to its default. Omit <description> and
// the description is GONE; omit <defaultValue> and the default is GONE.
//
// So this generator does NOT hand-write field XML. It READS EACH FIELD'S CURRENT
// DEFINITION FROM THE LIVE ORG and re-emits it verbatim with exactly ONE attribute
// changed. Run it against the org immediately before deploying; the output is a
// snapshot of production plus the intended delta, not a reconstruction from memory.
//
// WHERE THE CURRENT DEFINITION COMES FROM (the Metadata API is NOT reachable — the JWT
// bearer session is rejected by /services/Soap/m with INVALID_SESSION_ID, and the
// Tooling API's CustomField is not exposed to the integration user):
//   REST describe      -> type, precision, scale, length, defaultValueFormula,
//                         inlineHelpText, nillable, externalId, unique, caseSensitive
//   FieldDefinition    -> label, description, IsFieldHistoryTracked
//   NOT READABLE       -> trackTrending (see the note where it is written)
//
// Usage:  node salesforce/v2-field-alignments/generate.mjs
import fs from "node:fs";
import path from "node:path";
import { describeObject, sfQuery } from "../../lib/salesforce.js";

const OUT = path.resolve("salesforce/v2-field-alignments");
fs.mkdirSync(path.join(OUT, "objects"), { recursive: true });

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * ⚠️ PERCENT_DOMAIN — READ BEFORE SETTING A DEFAULT ON ANY Percent FIELD.
 *
 * Salesforce uses THREE domains for a Percent field and they do not agree. Measured
 * empirically by `scripts/probe-percent-field-domain.mjs` on a live record, not inferred:
 *
 *   | layer                        | domain  | a TRUE 25% is |
 *   |------------------------------|---------|---------------|
 *   | metadata <defaultValue>      | DECIMAL | 0.25          |
 *   | REST API / SOQL read + write | DISPLAY | 25            |
 *   | FORMULA field reference      | DECIMAL | 0.25          |
 *
 * So `<defaultValue>25</defaultValue>` does NOT mean 25%. It means 25.0 as a decimal
 * fraction — **2500%** — and every record created since carries a stored API value of
 * 2500. Setup renders the default expression back as "25", so nothing looks wrong.
 *
 * That is the bug this package now fixes. The default must be written **0.25**.
 *
 * The formula-domain row is the other half of the same trap: a formula referencing a
 * Percent field sees it ALREADY divided by 100, so `Markup/100` in a formula divides
 * twice. budgetCalc reads through REST and its `/100` is correct; the Salesforce formula
 * must NOT have one.
 */

/**
 * "225 Upgrade" -> "225 Upgrade-Overhead", applied at most once.
 *
 * This generator re-reads the LIVE label and re-emits it with the delta applied, so any
 * transformation it performs has to be safe to run against an org where it already ran.
 */
const relabel225 = (label) =>
  label.includes("225 Upgrade-Overhead") ? label : label.replace("225 Upgrade", "225 Upgrade-Overhead");

/**
 * The intended deltas. `change` receives the CURRENT values and returns ONLY the keys
 * to override — anything it does not return is carried through untouched.
 *
 * Per-object entries because the two objects diverge in both type and label style.
 */
const CHANGES = {
  Sundial_Solar__c: [
    // ---- Default-value corrections -------------------------------------
    {
      api: "Battery_Install_Hours__c",
      why: "§3: Hours/Battery is 16 in the REVISED sheet (was 20 in BRADS). The org has 0, so a fresh record gets ZERO battery labor until someone types it.",
      change: () => ({ defaultValue: "16" }),
    },
    // ⚠️ PERCENT DEFAULTS ARE EVALUATED IN THE DECIMAL DOMAIN. `0.25`, not `25`.
    // See PERCENT_DOMAIN above and scripts/probe-percent-field-domain.mjs. All FIVE
    // blocks are listed here, not just 1-3: blocks 4-5 were created by
    // v2-budget-adder-fields with the same wrong `25`, and fixing them through this
    // MODIFY package avoids redeploying that whole create-package for two fields.
    ...[1, 2, 3, 4, 5].map((n) => ({
      api: `NS_Adder_${n}_Markup_Percent__c`,
      why: "§3 + the percent-domain fix: NS markup defaults to a TRUE 25%, which as a decimal-domain default expression is 0.25. The previous `25` meant 2500%.",
      change: () => ({ defaultValue: "0.25" }),
    })),

    // ---- Burden rates: the SAME percent-domain defect (D-063 amendment) ---
    // `<defaultValue>75</defaultValue>` means 75.0 as a decimal fraction — 7500% — and
    // 4,473 of 4,474 Solar records carry a stored API value of 7500.
    //
    // These two fields were NEVER created by a package in this repo; they predate it and
    // were made in Setup. This MODIFY package is the only vehicle we have for them, which
    // is precisely what it is for.
    //
    // ⚠️ WORSE THAN THE MARKUP CASE. budgetCalc divides these by 100 (`/100` is correct on
    // the REST domain), so 7500 becomes a 75.0 multiplier — every burden figure 100x too
    // large. No second error cancels it. The only saving grace is that exactly one Solar
    // record has ever completed a budget calc, and it holds the correct 75.
    //
    // Sundial_Customer__c is NOT listed: its copies of both fields have no default at all,
    // and their narrower Percent(5,2) (max 999.99) makes 7500 structurally unstorable.
    ...["Labor_Burden_Rate__c", "Commission_Burden_Rate__c"].map((api) => ({
      api,
      why: "Percent-domain fix (D-063): a Percent defaultValue is evaluated in the DECIMAL domain, so `75` meant 7500%. A true 75% is written 0.75.",
      change: () => ({ defaultValue: "0.75" }),
    })),

    // ---- Relabels --------------------------------------------------------
    {
      api: "Adder_Upgrade_225_Price__c",
      why: '§4a: disambiguated from the new Underground variant.',
      // IDEMPOTENT ON PURPOSE. A blind .replace() re-applies every time this generator
      // runs against an org where the relabel already landed, producing
      // "225 Upgrade-Overhead-Overhead". Caught when regenerating for the percent-domain
      // fix — the relabel had deployed, and the diff showed the doubled label. Returning
      // the label unchanged makes the "already at target value" check skip the field.
      change: (cur) => ({ label: relabel225(cur.label) }),
    },
    {
      api: "Adder_Upgrade_225_Qty__c",
      why: "§4a: same.",
      // IDEMPOTENT ON PURPOSE. A blind .replace() re-applies every time this generator
      // runs against an org where the relabel already landed, producing
      // "225 Upgrade-Overhead-Overhead". Caught when regenerating for the percent-domain
      // fix — the relabel had deployed, and the diff showed the doubled label. Returning
      // the label unchanged makes the "already at target value" check skip the field.
      change: (cur) => ({ label: relabel225(cur.label) }),
    },
    {
      api: "Gateway_Unit_Cost__c",
      why: "§3: the Gateway_* fields are REUSED for the Tesla Expansion Pack; the sheet row is gone.",
      change: () => ({ label: "Tesla Expansion Pack Unit Cost" }),
    },
    { api: "Gateway_Qty__c", why: "§3: same.", change: () => ({ label: "Tesla Expansion Pack Qty" }) },
    { api: "Gateway_Cost__c", why: "§3: same (calc output).", change: () => ({ label: "Tesla Expansion Pack Cost" }) },

    // ---- NOT IN THE BRIEF — see the README, delete this block to drop it --
    {
      api: "Internal_Rep_Commission_PPW__c",
      optional: true,
      why: 'CONSISTENCY ONLY: Sales_Rep_Commission_PPW__c was relabelled in the UI to "3rd Party Rep Commission $/W". This field shipped as "…PPW", so the two commission inputs now read differently side by side.',
      change: () => ({ label: "Internal Rep Commission $/W" }),
    },
  ],

  Sundial_Customer__c: [
    {
      api: "Battery_Install_Hours__c",
      why: "Same as Solar AND load-bearing: this field is COPIED to Solar by Create Project (customer-to-solar-map.ts line 83). Leaving Customer blank would overwrite Solar's new 16 default on every new project.",
      change: () => ({ defaultValue: "16" }),
    },
    // Same decimal-domain default as Solar, PLUS a widening. Customer's markup fields are
    // Percent(6,3) — max 999.999 — while Solar's are Percent(18,4). That divergence is
    // why re-entering the broken 2500 errors on Customer and succeeds on Solar, and it
    // means the two objects disagree about what fits in the same logical field. Widened
    // to match Solar. Widening precision/scale is a non-destructive metadata change; no
    // existing value is at risk because nothing on Customer exceeds 999.999 today.
    ...[1, 2, 3, 4, 5].map((n) => ({
      api: `NS_Adder_${n}_Markup_Percent__c`,
      why: "Same as Solar (NS_Adder_1_Markup_Percent__c is likewise in the create-map), plus widening Percent(6,3) -> Percent(18,4) so the two objects stop disagreeing about what fits.",
      change: () => ({ defaultValue: "0.25", precision: 18, scale: 4 }),
    })),
    {
      api: "Adder_Upgrade_225_Price__c",
      why: "§4a.",
      // IDEMPOTENT ON PURPOSE. A blind .replace() re-applies every time this generator
      // runs against an org where the relabel already landed, producing
      // "225 Upgrade-Overhead-Overhead". Caught when regenerating for the percent-domain
      // fix — the relabel had deployed, and the diff showed the doubled label. Returning
      // the label unchanged makes the "already at target value" check skip the field.
      change: (cur) => ({ label: relabel225(cur.label) }),
    },
    {
      api: "Adder_Upgrade_225_Qty__c",
      why: "§4a.",
      // IDEMPOTENT ON PURPOSE. A blind .replace() re-applies every time this generator
      // runs against an org where the relabel already landed, producing
      // "225 Upgrade-Overhead-Overhead". Caught when regenerating for the percent-domain
      // fix — the relabel had deployed, and the diff showed the doubled label. Returning
      // the label unchanged makes the "already at target value" check skip the field.
      change: (cur) => ({ label: relabel225(cur.label) }),
    },
    { api: "Gateway_Unit_Cost__c", why: "§3.", change: () => ({ label: "Tesla Expansion Pack Unit Cost" }) },
    { api: "Gateway_Qty__c", why: "§3.", change: () => ({ label: "Tesla Expansion Pack Qty" }) },
    { api: "Gateway_Cost__c", why: "§3.", change: () => ({ label: "Tesla Expansion Pack Cost" }) },
    {
      api: "Internal_Rep_Commission_PPW__c",
      optional: true,
      why: "CONSISTENCY ONLY — see the Solar entry.",
      change: () => ({ label: "Internal Rep Commission $/W" }),
    },
  ],
};

/**
 * Fields the brief listed that are ALREADY DONE in the org. Verified, reported, and
 * deliberately left out of the package — re-deploying an unchanged definition is pure
 * risk for zero gain.
 */
const ALREADY_DONE = [
  { api: "Sales_Rep_Commission_PPW__c", expectLabel: "3rd Party Rep Commission $/W" },
];

/** Metadata type name for a describe type. */
function metaType(f) {
  switch (f.type) {
    case "currency": return "Currency";
    case "percent": return "Percent";
    case "double": return "Number";
    case "string": return "Text";
    case "textarea": return f.length > 255 ? "LongTextArea" : "TextArea";
    case "boolean": return "Checkbox";
    case "date": return "Date";
    case "datetime": return "DateTime";
    case "email": return "Email";
    case "phone": return "Phone";
    case "url": return "Url";
    case "picklist": return "Picklist";
    default: throw new Error(`unmapped describe type "${f.type}" on ${f.name}`);
  }
}

function buildFieldXml(cur, overrides) {
  const v = { ...cur, ...overrides };
  const L = ["    <fields>", `        <fullName>${v.api}</fullName>`];

  // Order matches the Metadata API's own alphabetical emission so a retrieved file and
  // this one diff cleanly.
  if (v.caseSensitive !== undefined && v.type === "Text") {
    L.push(`        <caseSensitive>${v.caseSensitive}</caseSensitive>`);
  }
  if (v.defaultValue !== null && v.defaultValue !== undefined) {
    L.push(`        <defaultValue>${esc(v.defaultValue)}</defaultValue>`);
  }
  if (v.description) L.push(`        <description>${esc(v.description)}</description>`);
  L.push(`        <externalId>${v.externalId}</externalId>`);
  if (v.help) L.push(`        <inlineHelpText>${esc(v.help)}</inlineHelpText>`);
  L.push(`        <label>${esc(v.label)}</label>`);
  if (v.length !== undefined) L.push(`        <length>${v.length}</length>`);
  if (v.precision !== undefined) L.push(`        <precision>${v.precision}</precision>`);
  L.push(`        <required>${v.required}</required>`);
  if (v.scale !== undefined) L.push(`        <scale>${v.scale}</scale>`);
  L.push(`        <trackHistory>${v.trackHistory}</trackHistory>`);
  // NOT READABLE from any API available to the integration user. Every field in this
  // package is a plain number/currency/percent created by us with the default (false),
  // and trackTrending only affects historical-trending reports, which this org does not
  // use. Stated in the README so it is a known assumption rather than a silent one.
  L.push("        <trackTrending>false</trackTrending>");
  L.push(`        <type>${v.type}</type>`);
  if (v.type === "Text") L.push(`        <unique>${v.unique}</unique>`);
  L.push("    </fields>");
  return L.join("\n");
}

const run = async () => {
  const manifest = [];
  const skipped = [];

  for (const [objName, entries] of Object.entries(CHANGES)) {
    const d = await describeObject(objName);
    const byName = new Map(d.fields.map((f) => [f.name, f]));

    // FieldDefinition supplies label + description + history flag (the describe has
    // neither label-with-fidelity concerns nor description at all).
    const list = entries.map((e) => `'${e.api}'`).join(",");
    const defs = await sfQuery(
      `SELECT QualifiedApiName, Label, Description, IsFieldHistoryTracked FROM FieldDefinition ` +
        `WHERE EntityDefinition.QualifiedApiName = '${objName}' AND QualifiedApiName IN (${list})`
    );
    const byDef = new Map(defs.map((r) => [r.QualifiedApiName, r]));

    const out = [];
    for (const e of entries) {
      const f = byName.get(e.api);
      const def = byDef.get(e.api);
      if (!f || !def) throw new Error(`${objName}.${e.api} not found in the org — refusing to guess.`);
      if (f.calculated) throw new Error(`${objName}.${e.api} is a FORMULA field; this generator does not handle formulas.`);

      const cur = {
        api: f.name,
        label: def.Label,
        description: def.Description || null,
        help: f.inlineHelpText || null,
        type: metaType(f),
        precision: ["Currency", "Percent", "Number"].includes(metaType(f)) ? f.precision : undefined,
        scale: ["Currency", "Percent", "Number"].includes(metaType(f)) ? f.scale : undefined,
        length: ["Text", "TextArea", "LongTextArea"].includes(metaType(f)) ? f.length : undefined,
        defaultValue: f.defaultValueFormula ?? null,
        externalId: f.externalId === true,
        required: f.nillable === false,
        unique: f.unique === true,
        caseSensitive: f.caseSensitive === true,
        trackHistory: def.IsFieldHistoryTracked === true,
      };

      const overrides = e.change(cur);
      const changedKeys = Object.keys(overrides).filter((k) => String(cur[k]) !== String(overrides[k]));

      if (changedKeys.length === 0) {
        // Already matches the target — leave it out rather than redeploy a no-op.
        skipped.push({ object: objName, api: e.api, reason: "already at target value" });
        continue;
      }

      out.push(buildFieldXml(cur, overrides));
      manifest.push({
        object: objName,
        api: e.api,
        attribute: changedKeys.join(","),
        from: changedKeys.map((k) => JSON.stringify(cur[k])).join(","),
        to: changedKeys.map((k) => JSON.stringify(overrides[k])).join(","),
        optional: e.optional === true,
        why: e.why,
      });
    }

    if (out.length === 0) continue;
    const header = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  ⚠️ MODIFY PACKAGE — these fields ALREADY EXIST. Deploying REPLACES their full
  definition, so every attribute below was READ FROM THE LIVE ORG (${new Date().toISOString().slice(0, 10)}) and is
  reproduced verbatim; exactly one attribute per field differs. Regenerate with
  \`node salesforce/v2-field-alignments/generate.mjs\` immediately before deploying so
  the carried-over attributes match production at deploy time, not at authoring time.

  ${objName} — ${out.length} field(s). See README.md for the change table.

  NOT reproducible from any API the integration user can reach: trackTrending
  (assumed false — see README). Everything else is live-sourced.
-->
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
`;
    fs.writeFileSync(
      path.join(OUT, "objects", `${objName}.object`),
      header + out.join("\n") + "\n</CustomObject>\n",
      "utf8"
    );
  }

  // Verify the already-done relabels really are done.
  for (const objName of Object.keys(CHANGES)) {
    const defs = await sfQuery(
      `SELECT QualifiedApiName, Label FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objName}' ` +
        `AND QualifiedApiName IN (${ALREADY_DONE.map((a) => `'${a.api}'`).join(",")})`
    );
    for (const a of ALREADY_DONE) {
      const got = defs.find((r) => r.QualifiedApiName === a.api);
      skipped.push({
        object: objName,
        api: a.api,
        reason:
          got && got.Label === a.expectLabel
            ? `already relabelled in the UI ("${got.Label}") — excluded`
            : `⚠️ EXPECTED "${a.expectLabel}" BUT FOUND "${got?.Label ?? "(absent)"}" — CHECK BEFORE DEPLOY`,
      });
    }
  }

  const members = manifest.map((m) => `        <members>${m.object}.${m.api}</members>`).join("\n");
  fs.writeFileSync(
    path.join(OUT, "package.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!--
  ⚠️ MODIFY PACKAGE — v2 field alignments. These ${manifest.length} fields ALREADY EXIST and this
  deploy REPLACES their definitions. Generated from the live org; see README.md.

  Run CHECK ONLY first, then deploy. Zip with Windows Explorer "Send to > Compressed
  (zipped) folder" — NEVER PowerShell 5.1 Compress-Archive (backslash entries break
  Workbench).
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

  console.log(`\n=== v2-field-alignments: ${manifest.length} field(s) modified ===`);
  for (const m of manifest) {
    console.log(
      `  ${m.optional ? "[OPT] " : "      "}${(m.object.replace("Sundial_", "").replace("__c", "") + "." + m.api).padEnd(52)} ${m.attribute.padEnd(13)} ${m.from} -> ${m.to}`
    );
  }
  console.log(`\n=== skipped (${skipped.length}) ===`);
  for (const s of skipped) console.log(`  ${s.object}.${s.api}: ${s.reason}`);
};

run().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
