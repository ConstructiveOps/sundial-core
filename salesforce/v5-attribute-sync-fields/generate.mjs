// Generates salesforce/v5-attribute-sync-fields/{package.xml,objects/Sundial_Solar__c.object}
//
// The three attribute-sync observability fields. SOLAR ONLY, ADDITIVE ONLY.
//
// These close a gap that was shipped KNOWINGLY on 2026-08-24 (D-060): the attribute stage
// had nowhere of its own to report, so a silently-discarded attribute surfaced only in the
// budget push's shared Budget_Push_Error__c note and in CloudWatch. That is the "log line
// nobody reads" problem the §4f document argued against, and it got worse the moment a
// SECOND path started writing attributes — the attribute-only sync for legacy projects has
// no budget push to borrow an error field from at all.
//
// Written by BOTH paths, from ONE mapping function (buildAttributeSyncWriteback in
// lib/acumatica-attributes.js), so the two cannot describe the same outcome differently.
//
// Collision-checked against the live describe — re-run before deploying:
//   node scripts/probe-attribute-sync-fields.mjs
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("salesforce/v5-attribute-sync-fields");
fs.mkdirSync(path.join(OUT, "objects"), { recursive: true });

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const WRITTEN_BY =
  "WRITTEN by the Acumatica attribute sync (lib/acumatica-attributes.js), from BOTH the " +
  "budget push worker's Stage E and the attribute-only route " +
  "(POST /projects/{recordId}/budget/attributes-sync) — do not edit manually.";

const FIELDS = [
  {
    api: "Attribute_Sync_Status__c",
    label: "Attribute Sync Status",
    type: "Picklist",
    picklist: ["Synced", "Nothing to Sync", "Unverified", "Failed"],
    description:
      `${WRITTEN_BY} Where this job's Acumatica project ATTRIBUTES stand — the lifecycle ` +
      "dates, system size, sales company and (on the budget push path only) the commission " +
      "milestone amounts that Harmon's accounting reporting reads. " +
      "BLANK means the sync has never run on this record, which is different from every " +
      "value below and is why there is no 'None'. " +
      "Synced = every attribute sent was confirmed present by a re-read. " +
      "Nothing to Sync = the sync ran and the record had no populated values to send " +
      "(blanks are omitted, never written as empty). " +
      "UNVERIFIED IS NOT A FAILURE and is deliberately separate from it: Acumatica returns " +
      "200 and SILENTLY DISCARDS an AttributeID the project's template does not define, so " +
      "the write may have partly happened and was not confirmed. Failed = the write did not " +
      "happen. The two need different responses, which is why they are different values. " +
      "RESTRICTED: the sync only ever writes these four literals.",
    help: "Where the Acumatica attribute sync stands. Blank = never run. 'Unverified' means Acumatica accepted the write but did not confirm it.",
  },
  {
    api: "Attribute_Sync_Error__c",
    label: "Attribute Sync Error",
    type: "LongTextArea", length: 4000, visibleLines: 5,
    description:
      `${WRITTEN_BY} Why the last attribute sync failed or could not be verified, and ` +
      "CLEARED on a clean run. This is where an attribute that Acumatica accepted with a 200 " +
      "and then discarded gets named — without it, that outcome is invisible, because " +
      "nothing about the response distinguishes 'written' from 'thrown away'.",
    help: "Why the last attribute sync failed or could not be verified. Blank when it succeeded.",
  },
  {
    api: "Attribute_Synced_At__c",
    label: "Attribute Synced At",
    type: "DateTime",
    description:
      `${WRITTEN_BY} When the attributes were last known GOOD. Stamped on a successful sync ` +
      "and on 'Nothing to Sync' (the sync ran and had nothing to say), but deliberately NOT " +
      "moved on a failure or an unverified run — a stale record must not look fresh because " +
      "we tried and could not. Read it together with Attribute_Sync_Status__c: a recent " +
      "timestamp beside 'Failed' means the failure came after a good run.",
    help: "When this project's Acumatica attributes were last confirmed good. Does not move on a failed sync.",
  },
];

function fieldXml(f) {
  const L = ["    <fields>", `        <fullName>${f.api}</fullName>`];
  L.push(`        <description>${esc(f.description)}</description>`);
  L.push("        <externalId>false</externalId>");
  L.push(`        <inlineHelpText>${esc(f.help)}</inlineHelpText>`);
  L.push(`        <label>${esc(f.label)}</label>`);
  if (f.length !== undefined) L.push(`        <length>${f.length}</length>`);
  L.push("        <required>false</required>");
  L.push("        <trackTrending>false</trackTrending>");
  L.push(`        <type>${f.type}</type>`);
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
  Attribute-sync observability fields for Sundial_Solar__c.
  Reference: D-060 (the gap, shipped knowingly) and D-061 (the attribute-only path).

  ${FIELDS.length} NEW fields, ADDITIVE ONLY — no existing field is touched.

  WRITTEN BY TWO PATHS, ONE MAPPING. Both the budget push worker's Stage E and the
  attribute-only route write these, via buildAttributeSyncWriteback() in
  lib/acumatica-attributes.js. That is deliberate: a record reading 'Synced' after one
  path and 'Failed' after the other for the same outcome would be worse than no field.

  The integration user needs READ + EDIT on all ${FIELDS.length}.

  NOT the same as Budget_Push_Status__c / Budget_Push_Error__c, which describe the BUDGET
  LINES. A project can have a perfectly pushed budget and a failed attribute sync, and
  before these fields existed that combination was only visible in CloudWatch.
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
  Workbench deploy: attribute-sync observability fields.
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
    : f.length !== undefined
      ? `${f.type}(${f.length})`
      : f.type;
  console.log(`  ${f.api.padEnd(28)} ${t}`);
}
console.log("\n  FLS: the integration user needs Read + Edit on all of them.");
