// Generates salesforce/v6-access-model/{package.xml,objects/*.object,permissionsets/*.permissionset}
//
// D-064 Phase 1 item 2 (docs/access-model.md §2.1, §2.2, §8). ADDITIVE ONLY:
// one new custom object and one new lookup field on each of five existing objects.
// No existing field is modified.
//
//   Sundial_Dealer__c            NEW object — Name, Client__c, Is_Internal__c, Active__c
//   Sundial_User__c.Dealer__c    NEW lookup -> Sundial_Dealer__c
//   Sundial_Customer__c.Dealer__c
//   Sundial_Solar__c.Dealer__c
//   Sundial_Roofing__c.Dealer__c
//   Sundial_Commercial__c.Dealer__c
//
// Collision-checked against the live describe — re-run before deploying:
//   node scripts/probe-access-model-fields.mjs
//
// WHAT THE PROBE FOUND ON 2026-08-27, and how it shaped what is written below:
//   * No collisions. Sundial_Dealer__c does not exist; Dealer__c is absent on all five.
//   * Sundial_Tenant__c exists and holds exactly one row (a1W7y000007AszBEAS "harmon"),
//     so the Client__c lookup target is real.
//   * Client__c is REQUIRED (nillable=false) on User, Customer and Solar, and OPTIONAL
//     on Roofing. The new Sundial_Dealer__c.Client__c follows the majority and is
//     required — see the note on FLS below, which that choice forces.
//   * Sundial_Commercial__c has NO Client__c AT ALL and holds ZERO records: it is a
//     14-field Phase 3 stub. Dealer__c is added there for shape, exactly as §2.2 says,
//     and is not load-bearing. The missing tenant key is a real gap and is recorded in
//     TASKS.md rather than fixed here — this package is about the access model, and a
//     tenant key on an object with no rows is a separate decision.
import fs from "node:fs";
import path from "node:path";
import { assertFieldLimits, reportFieldLimitHeadroom } from "../field-limits.mjs";

const OUT = path.resolve("salesforce/v6-access-model");
fs.mkdirSync(path.join(OUT, "objects"), { recursive: true });
fs.mkdirSync(path.join(OUT, "permissionsets"), { recursive: true });

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const API_VERSION = "62.0";
const PERMSET = "Sundial_Access_Model";
const DEALER = "Sundial_Dealer__c";

const SERVER_OWNED =
  "SERVER-OWNED. Written by the Sundial Lambda layer and by the one-time backfill " +
  "(scripts/backfill-deal-ownership.mjs). A sales-role user can never write it: it is on " +
  "the protected-field list in docs/access-model.md §3.4, so a PATCH naming it is rejected " +
  "outright rather than ignored.";

// ---------------------------------------------------------------------------
// Sundial_Dealer__c — the new object's own fields
// ---------------------------------------------------------------------------
// `Name` is the object's nameField, not a <fields> entry, so it is defined in the
// CustomObject header below and does not appear here.
const DEALER_FIELDS = [
  {
    api: "Client__c",
    label: "Client",
    type: "Lookup",
    referenceTo: "Sundial_Tenant__c",
    relationshipLabel: "Sundial Dealers",
    relationshipName: "Sundial_Dealers",
    required: true,
    deleteConstraint: "Restrict",
    description:
      "Tenant isolation key (D-034/D-035), identical in role to Client__c on every other " +
      "Sundial object: it holds the Sundial_Tenant__c record id and every query filters on " +
      "it. REQUIRED, matching Sundial_User__c / Sundial_Customer__c / Sundial_Solar__c, " +
      "because a dealer row with no tenant is a row that leaks across tenants the moment a " +
      "second tenant exists. Delete constraint is RESTRICT: a tenant with dealers cannot be " +
      "deleted out from under them.",
    help: "Which Sundial client this dealer belongs to. Required.",
  },
  {
    api: "Is_Internal__c",
    label: "Is Internal",
    type: "Checkbox",
    defaultValue: "false",
    description:
      "TRUE for Harmon Solar, the tenant's own selling organization. INFORMATIONAL ONLY - it " +
      "grants nothing and is read by no access decision. Scope comes from Access_Level__c " +
      "alone (docs/access-model.md §1.1), so an internal dealer's rep is an `own`-scope user " +
      "exactly like an external dealer's rep. It exists to label the row for reporting and to " +
      "match the internal/external split the commission model already makes (D19, D16: " +
      "internal deals are payroll, not POs).",
    help: "Ticked for Harmon Solar itself. A label, not a permission - it grants nothing.",
  },
  {
    api: "Active__c",
    label: "Active",
    type: "Checkbox",
    defaultValue: "false",
    description:
      "Whether this dealer's users may see anything. An INACTIVE dealer's users resolve to " +
      "scope `none` and see NO records (docs/access-model.md §1.2, §2.1) - the same answer as " +
      "a null dealer, and deliberately so: fail closed. DEFAULTS TO FALSE so a dealer created " +
      "by hand in Salesforce, or by a future import, starts with no access and is switched on " +
      "as a decision rather than by omission. Only Harmon Solar, Heavenly Power and Property " +
      "Upgrades LLC are active at launch (§12.4); every other backfilled row is inactive.",
    help: "Unticked means this dealer's users see nothing at all. Defaults to unticked.",
  },
];

// ---------------------------------------------------------------------------
// Dealer__c — one lookup per existing object
// ---------------------------------------------------------------------------
// relationshipName must be UNIQUE on the Sundial_Dealer__c side (they all become child
// relationships of the same object), which is why each carries its own.
const DEALER_LOOKUP_TARGETS = [
  {
    object: "Sundial_User__c",
    relationshipLabel: "Sundial Users",
    relationshipName: "Sundial_Users",
    description:
      "The dealer this user sells for. THE ONLY SOURCE OF A SALES USER'S DEALER SCOPE " +
      "(docs/access-model.md §1.2): a `Sales Dealer` sees their dealer's records, a " +
      "`Sales Rep` sees their own. A NULL Dealer__c on a sales-role user resolves to scope " +
      "`none` - NOT to 'all dealers'. Tenant-wide roles (Executive/Admin/Manager) do not read " +
      "it, so it is correctly left null on Harmon staff. Written by sundial-user-admin only; " +
      "never writable by the user themselves. A person selling for two dealers gets two " +
      "Sundial_User__c records, so this is single-valued by design.",
    help: "Which dealer this user sells for. Blank on Harmon staff. Blank on a sales user means they see nothing.",
  },
  {
    object: "Sundial_Customer__c",
    relationshipLabel: "Sundial Customers",
    relationshipName: "Sundial_Customers",
    description:
      `${SERVER_OWNED} DERIVED FROM THE REP (D-064 A1): Dealer__c := Sales_Rep__r.Dealer__c, ` +
      "stamped on create and RE-STAMPED on every Sales_Rep__c change. It is NOT derived from " +
      "Dealer_Name__c or Sales_Company__c - those stay the commission discriminator only " +
      "(D19). Dealer_Name__c is populated on 13 of 31,637 rows and does not even contain " +
      "'Harmon Solar', so deriving from it would leave almost every customer invisible to " +
      "dealer scope. A blank value is left NULL, never defaulted.",
    help: "The dealer that owns this deal, set from the sales rep. Blank until a rep with a dealer is assigned.",
  },
  {
    object: "Sundial_Solar__c",
    relationshipLabel: "Sundial Solar Projects",
    relationshipName: "Sundial_Solar_Projects",
    description:
      `${SERVER_OWNED} DERIVED FROM THE REP (D-064 A1): Dealer__c := Sales_Rep__r.Dealer__c, ` +
      "stamped on create and RE-STAMPED on every Sales_Rep__c change; Create Project copies it " +
      "from the Customer. The ONE exception is the one-time backfill, which for a record with " +
      "NO Sales_Rep__c may resolve Sales_Company_Harmon_Solar_or_Third__c through the reviewed " +
      "alias CSV (docs/integrations/dealer-aliases.csv, D-064 A2). That runs once, offline, " +
      "and never in a Lambda. A blank value is left NULL, never defaulted to Harmon.",
    help: "The dealer that owns this project, set from the sales rep. Blank until a rep with a dealer is assigned.",
  },
  {
    object: "Sundial_Roofing__c",
    relationshipLabel: "Sundial Roofing Projects",
    relationshipName: "Sundial_Roofing_Projects",
    description:
      `${SERVER_OWNED} Added for consistency with the other project objects. NOT LOAD-BEARING ` +
      "YET: the Roofing module is denied to every sales scope outright (docs/access-model.md " +
      "§3.1), so no read is filtered on this column today. It exists so that the day roofing is " +
      "opened to a dealer, the column and its cache index are already there and populated " +
      "rather than being a migration.",
    help: "The dealer that owns this project. Not used for access today - the Roofing module is closed to sales roles.",
  },
  {
    object: "Sundial_Commercial__c",
    relationshipLabel: "Sundial Commercial Projects",
    relationshipName: "Sundial_Commercial_Projects",
    description:
      `${SERVER_OWNED} Added for consistency. NOT LOAD-BEARING: the Commercial module is denied ` +
      "to every sales scope (docs/access-model.md §3.1), and as of 2026-08-27 this object is a " +
      "14-field Phase 3 stub holding ZERO records and carrying no Client__c tenant key at all. " +
      "Adding Dealer__c here changes nothing and costs nothing; the missing tenant key is a " +
      "separate gap, recorded in TASKS.md.",
    help: "The dealer that owns this project. Placeholder - the Commercial module is not built yet.",
  },
];

const DEALER_LOOKUP_FIELDS = DEALER_LOOKUP_TARGETS.map((t) => ({
  api: "Dealer__c",
  object: t.object,
  label: "Dealer",
  type: "Lookup",
  referenceTo: DEALER,
  relationshipLabel: t.relationshipLabel,
  relationshipName: t.relationshipName,
  required: false,
  // RESTRICT, not SetNull. SetNull would let deleting a dealer silently unshare every
  // deal it owned - the records would stay, look normal, and quietly become invisible to
  // the people who were selling them. Restrict makes that arrive as an error.
  deleteConstraint: "Restrict",
  description: t.description,
  help: t.help,
}));

// Fail HERE, not in Workbench. The v5 package was rejected for a 1,137-character
// description after a full zip-and-upload round trip.
const ALL_FIELDS = [
  ...DEALER_FIELDS.map((f) => ({ ...f, api: `${DEALER}.${f.api}` })),
  ...DEALER_LOOKUP_FIELDS.map((f) => ({ ...f, api: `${f.object}.${f.api}` })),
];
assertFieldLimits(ALL_FIELDS, "v6-access-model");

// ---------------------------------------------------------------------------
// XML emitters
// ---------------------------------------------------------------------------
/**
 * Refuse to write XML whose tags do not balance.
 *
 * WHY THIS EXISTS: the first run of this generator emitted every <fields> block WITHOUT
 * its closing </fields>. The file looked right in a diff, `assertFieldLimits` passed, and
 * scripts/zip-package.mjs built the archive happily — its manifest check matches
 * `<fields>...<fullName>` with a regex and never needs the close tag. The first thing that
 * would have noticed was Workbench, after a zip and an upload, with a parse error naming a
 * line number rather than the missing tag.
 *
 * A stack walk over the tag stream is about fifteen lines and catches the whole family:
 * missing close, stray close, mismatched nesting, unclosed root. It is not a full XML
 * parser and does not need to be — this generator emits a known shape from a template, so
 * the only realistic defect is an unbalanced edit to that template.
 */
function assertWellFormed(xml, what) {
  const stack = [];
  // Tags only: skip the <?xml …?> declaration, <!-- comments --> and <… /> self-closers.
  const body = xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w.-]*)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m;
    if (selfClosing) continue;
    if (closing) {
      const open = stack.pop();
      if (open !== name) {
        throw new Error(
          `${what}: XML is not well formed — </${name}> closes <${open ?? "nothing"}>.`
        );
      }
    } else {
      stack.push(name);
    }
  }
  if (stack.length) {
    throw new Error(`${what}: XML is not well formed — unclosed <${stack.join(">, <")}>.`);
  }
}

/**
 * Re-read every file this generator wrote and assert it parses. Runs at the END, over
 * the bytes actually on disk, so it covers the write path as well as the templates.
 */
function assertPackageWellFormed() {
  const files = [];
  for (const dir of ["", "objects", "permissionsets"]) {
    const abs = path.join(OUT, dir);
    for (const name of fs.readdirSync(abs)) {
      if (!/\.(object|permissionset|xml)$/.test(name)) continue;
      files.push(path.join(dir, name));
    }
  }
  for (const rel of files.sort()) {
    assertWellFormed(fs.readFileSync(path.join(OUT, rel), "utf8"), rel);
  }
  return files.length;
}

function fieldXml(f) {
  const L = ["    <fields>", `        <fullName>${f.api.split(".").pop()}</fullName>`];
  L.push(`        <description>${esc(f.description)}</description>`);
  if (f.type === "Checkbox") L.push(`        <defaultValue>${f.defaultValue}</defaultValue>`);
  if (f.deleteConstraint) L.push(`        <deleteConstraint>${f.deleteConstraint}</deleteConstraint>`);
  L.push("        <externalId>false</externalId>");
  L.push(`        <inlineHelpText>${esc(f.help)}</inlineHelpText>`);
  L.push(`        <label>${esc(f.label)}</label>`);
  if (f.referenceTo) {
    L.push(`        <referenceTo>${f.referenceTo}</referenceTo>`);
    L.push(`        <relationshipLabel>${esc(f.relationshipLabel)}</relationshipLabel>`);
    L.push(`        <relationshipName>${f.relationshipName}</relationshipName>`);
  }
  L.push(`        <required>${f.required === true}</required>`);
  L.push("        <trackTrending>false</trackTrending>");
  L.push(`        <type>${f.type}</type>`);
  L.push("    </fields>");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// 1. Sundial_Dealer__c — the whole object
// ---------------------------------------------------------------------------
const dealerHeader = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  ${DEALER} — NEW custom object. D-064 (docs/access-model.md §2.1).

  A selling organization WITHIN a tenant. Harmon Solar is itself a dealer, the internal
  one. This is the object that replaces string matching on a sales-company picklist with
  an id equality on an indexed column.

  FOUR FIELDS, and Name is the only string anything ever matches on - once, in the
  one-time backfill (scripts/backfill-dealers.mjs). No read path resolves a dealer by
  name.

  ⚠️ Sales_Company_Value__c IS DELIBERATELY ABSENT. The approved design specified it as
  "Text(255), unique per tenant - the exact picklist value this dealer corresponds to".
  Phase 0 proved it cannot exist: the two dealer picklists carry 110 and 56 values with
  only 36 exact matches, plus near-miss spellings an exact join drops SILENTLY. D-064
  amendment A1 then removed the need for it entirely by deriving a deal's dealer from its
  rep. Do not add it back; see docs/integrations/dealer-aliases.csv for what replaced it.

  The integration user needs Read + Create + Edit on the object and Read + Edit on
  Is_Internal__c and Active__c (permissionsets/${PERMSET}.permissionset).
-->
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <description>A selling organization within a Sundial tenant (D-064). Users and deals carry a Dealer__c lookup to this object; row visibility for a Sales Dealer is an id equality against it. Harmon Solar is the internal dealer. Inactive dealers grant their users nothing.</description>
    <enableActivities>false</enableActivities>
    <enableHistory>false</enableHistory>
    <enableReports>true</enableReports>
    <enableSearch>true</enableSearch>
    <label>Sundial Dealer</label>
    <nameField>
        <label>Dealer Name</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>Sundial Dealers</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>
`;

fs.writeFileSync(
  path.join(OUT, "objects", `${DEALER}.object`),
  dealerHeader + DEALER_FIELDS.map(fieldXml).join("\n") + "\n</CustomObject>\n",
  "utf8"
);

// ---------------------------------------------------------------------------
// 2. Dealer__c on each existing object — one .object file each, ADDITIVE
// ---------------------------------------------------------------------------
for (const f of DEALER_LOOKUP_FIELDS) {
  const header = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  ${f.object} — ONE new lookup field, Dealer__c -> ${DEALER}. D-064 (docs/access-model.md §2.2).

  ADDITIVE: this file declares only the new field. Nothing existing on ${f.object} is
  touched, and the Metadata API leaves unlisted fields alone.

  ${f.help}
-->
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
`;
  fs.writeFileSync(
    path.join(OUT, "objects", `${f.object}.object`),
    header + fieldXml(f) + "\n</CustomObject>\n",
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// 3. Permission set for the integration user
// ---------------------------------------------------------------------------
// ⚠️ Client__c IS DELIBERATELY OMITTED from fieldPermissions. Salesforce REFUSES field
// permissions on a universally-required field ("field is required and cannot be given
// permissions") - and Client__c is required here, matching User/Customer/Solar. A required
// field is always visible and editable to anyone with object access, so omitting it costs
// nothing; including it would fail the deploy with a message that does not obviously
// point back to <required>true</required>.
const flsFields = [
  ...DEALER_FIELDS.filter((f) => f.required !== true).map((f) => `${DEALER}.${f.api}`),
  ...DEALER_LOOKUP_FIELDS.map((f) => `${f.object}.Dealer__c`),
];

const permset = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Object + field permissions on everything v6-access-model creates, so the Sundial
  integration user can read and write it. Assign this to the integration user, OR merge
  its entries into the existing Sundial integration permission set.

  WHY CREATE BUT NOT DELETE on ${DEALER}: scripts/backfill-dealers.mjs creates the rows and
  sundial-user-admin will create them from a future Dealers tab. NOTHING deletes a dealer -
  a dealer with deals attached must not be removable, which is also why every Dealer__c
  lookup carries deleteConstraint Restrict. Leaving allowDelete false means a mistake in a
  future script fails rather than unshares records.

  viewAllRecords / modifyAllRecords are false: the integration user owns the rows it
  creates and the org-wide default is ReadWrite, so it needs neither, and "View All" on an
  object is exactly the blanket grant this whole design exists to avoid.

  Client__c is absent from fieldPermissions ON PURPOSE - see generate.mjs.
-->
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Sundial Access Model</label>
    <description>D-064 Phase 1: object and field access for Sundial_Dealer__c and the Dealer__c lookups, for the Sundial integration user.</description>
    <objectPermissions>
        <allowCreate>true</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>${DEALER}</object>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>
${flsFields
  .map(
    (f) =>
      `    <fieldPermissions>\n        <editable>true</editable>\n        <field>${f}</field>\n        <readable>true</readable>\n    </fieldPermissions>`
  )
  .join("\n")}
</PermissionSet>
`;
fs.writeFileSync(path.join(OUT, "permissionsets", `${PERMSET}.permissionset`), permset, "utf8");

// ---------------------------------------------------------------------------
// 4. package.xml
// ---------------------------------------------------------------------------
// EVERY field inside every .object file must also appear as a CustomField member, the
// new object's own fields included. Two reasons, and the second is not optional:
// Workbench rejects an undeclared field with "Not in package.xml", and
// scripts/zip-package.mjs refuses to build a zip whose manifest and .object files
// disagree - a check added after that exact deploy failure on 2026-08-24.
//
// `Name` is the nameField, not a <fields> entry, so it is covered by the CustomObject
// member and is correctly not listed as a CustomField.
const customFieldMembers = [
  ...DEALER_FIELDS.map((f) => `${DEALER}.${f.api}`),
  ...DEALER_LOOKUP_FIELDS.map((f) => `${f.object}.Dealer__c`),
];

fs.writeFileSync(
  path.join(OUT, "package.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Workbench deploy: the D-064 access-model data model.
  1 new custom object + ${DEALER_LOOKUP_FIELDS.length} new lookup fields + 1 permission set. ADDITIVE ONLY.

  Build the zip with the builder, never by hand:
      node scripts/zip-package.mjs salesforce/v6-access-model

  Then Workbench -> Migration -> Deploy -> Single Package, CHECK ONLY FIRST.
  See README.md for the full steps and what to verify afterwards.
-->
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>${DEALER}</members>
        <name>CustomObject</name>
    </types>
    <types>
${customFieldMembers.map((m) => `        <members>${m}</members>`).join("\n")}
        <name>CustomField</name>
    </types>
    <types>
        <members>${PERMSET}</members>
        <name>PermissionSet</name>
    </types>
    <version>${API_VERSION}</version>
</Package>
`,
  "utf8"
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`wrote v6-access-model -> ${OUT}\n`);
console.log(`  NEW OBJECT  ${DEALER}`);
console.log(`    ${"Name".padEnd(20)} Text (nameField, "Dealer Name")`);
for (const f of DEALER_FIELDS) {
  const t = f.type === "Lookup" ? `Lookup -> ${f.referenceTo}` : f.type;
  console.log(`    ${f.api.padEnd(20)} ${t}${f.required ? "  REQUIRED" : ""}`);
}
console.log(`\n  NEW LOOKUPS (all -> ${DEALER}, optional, deleteConstraint Restrict)`);
for (const f of DEALER_LOOKUP_FIELDS) console.log(`    ${f.object}.Dealer__c`);
console.log(`\n  PERMISSION SET  ${PERMSET}`);
console.log(`    object: ${DEALER} — read + create + edit, NO delete`);
console.log(`    fields: ${flsFields.length} (Client__c omitted: required fields cannot take FLS)`);
console.log(`\n  package.xml: 1 CustomObject + ${customFieldMembers.length} CustomField + 1 PermissionSet`);
reportFieldLimitHeadroom(ALL_FIELDS);
const xmlCount = assertPackageWellFormed();
console.log(`\n  ${xmlCount} metadata file(s) re-read from disk and parsed OK.`);
console.log("\n  Next: node scripts/probe-access-model-fields.mjs   (collision re-check)");
console.log("        node scripts/zip-package.mjs salesforce/v6-access-model");
