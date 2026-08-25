// READ-ONLY incident triage: blank Adders / Budget Inputs tabs on a Customer record.
//
// Two hypotheses, and this script is built to separate them rather than to confirm either:
//
//   H1  THE RECORD WAS NULLED — a write cleared the fields.
//   H2  THE READ PATH HIDES THEM — the describe-driven SELECT is dropping fields, so the
//       portal renders blanks over data that is still there.
//
// H2 cannot be tested by looking at the subject record alone, because "all null" looks
// identical either way from one row. So the same query runs against a KNOWN-GOOD control
// record. If the control shows populated values through the identical SELECT, the read
// path works and H2 is dead.
//
// The field list is built from the LIVE DESCRIBE by pattern, not hand-typed, so a field
// that exists on the object cannot be missed by the triage the way it might be missed by
// a hand-written SELECT. That matters: if the bug IS a dropped field, a hand-written list
// would reproduce the same blind spot.
//
//   node scripts/triage-blank-adders.mjs <subjectId> [controlId]
//
// WRITES NOTHING. There is no --apply.

import { describeObject, sfQuery } from "../lib/salesforce.js";

const SUBJECT = process.argv[2] || "a1P7y00000AmMy9EAF"; // Doug Malde
const CONTROL = process.argv[3] || null;

const OBJ = "Sundial_Customer__c";

const d = await describeObject(OBJ);
const all = d.fields.map((f) => f.name);

/** Field groups, matched against the live describe by pattern. */
const GROUPS = {
  "Adder prices": all.filter((n) => /^Adder_.*_Price__c$/.test(n)),
  "Adder qtys": all.filter((n) => /^Adder_.*_Qty__c$/.test(n)),
  "Adder costs": all.filter((n) => /^Adder_.*_Cost__c$/.test(n)),
  "NS adder blocks": all.filter((n) => /^NS_Adder_\d_/.test(n)),
  // "Budget Inputs" in the portal = the equipment / rate / cost parameters the budget
  // calc reads. Matched by name rather than by a copied list so nothing is missed.
  "Budget inputs — equipment": all.filter((n) =>
    /^(Module_|Combiner_|Gateway_|Microinverter_|Battery_|Tesla_Expansion)/.test(n) &&
    !/^Battery_(Interest|Type)__c$/.test(n)
  ),
  "Budget inputs — rates & costs": all.filter((n) =>
    /^(BOS_|Roof_Material_|Penetrations_|Blended_Labor_|Labor_Burden_|Audit_Hours|QA_|Roofing_|Install_Hours_|Material_Other_|Constructive_Ops_|Permit_)/.test(n)
  ),
  "Commission inputs": all.filter((n) =>
    /^(Sales_Rep_Commission|Internal_Rep_Commission|Sales_Mgr_Commission|Overhead_Commission|Geo_Commission|Commission_Burden)/.test(n)
  ),
  "Contract / system": all.filter((n) =>
    /^(Contract_Amount|Dealer_Fee|Final_System_Size|Domestic_Content|Sales_Company|Financing_Partner)/.test(n)
  ),
};

const AUDIT = ["Id", "Name", "CreatedDate", "CreatedById", "LastModifiedDate", "LastModifiedById"];
const fieldList = [...new Set([...AUDIT, ...Object.values(GROUPS).flat()])];

console.log(`${OBJ}: ${all.length} fields visible; triaging ${fieldList.length - AUDIT.length} in ${Object.keys(GROUPS).length} groups\n`);

async function load(id) {
  const rows = await sfQuery(`SELECT ${fieldList.join(", ")} FROM ${OBJ} WHERE Id = '${id}'`);
  return rows[0] ?? null;
}

/** Resolve the user behind a LastModifiedById so "who" is a name, not an 18-char id. */
async function whois(ids) {
  const clean = [...new Set(ids.filter(Boolean))];
  if (clean.length === 0) return new Map();
  const rows = await sfQuery(
    // No Profile.Name — the integration user cannot traverse that relationship.
    `SELECT Id, Name, Username FROM User WHERE Id IN (${clean.map((i) => `'${i}'`).join(",")})`
  );
  return new Map(rows.map((r) => [r.Id, r]));
}

const isNull = (v) => v === null || v === undefined || v === "";

function report(label, rec) {
  console.log("=".repeat(78));
  console.log(`${label}  ${rec ? `${rec.Id}  "${rec.Name}"` : "(NOT FOUND)"}`);
  console.log("=".repeat(78));
  if (!rec) return null;

  const summary = [];
  for (const [group, fields] of Object.entries(GROUPS)) {
    if (fields.length === 0) continue;
    const populated = fields.filter((f) => !isNull(rec[f]));
    summary.push({ group, total: fields.length, populated: populated.length });
    console.log(`\n  ${group} — ${populated.length}/${fields.length} populated`);
    if (populated.length === 0) {
      console.log("     ** ALL NULL **");
    } else if (populated.length === fields.length) {
      console.log(`     all populated, e.g. ${populated.slice(0, 3).map((f) => `${f}=${rec[f]}`).join(", ")}`);
    } else {
      for (const f of populated) console.log(`     ${f.padEnd(42)} ${rec[f]}`);
      const nulls = fields.filter((f) => isNull(rec[f]));
      console.log(`     -- null (${nulls.length}): ${nulls.slice(0, 6).join(", ")}${nulls.length > 6 ? " …" : ""}`);
    }
  }
  return summary;
}

const subject = await load(SUBJECT);
const subjectSummary = report("SUBJECT", subject);

let control = null;
let controlSummary = null;
if (CONTROL) {
  control = await load(CONTROL);
  controlSummary = report("CONTROL", control);
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------
const users = await whois([
  subject?.LastModifiedById, subject?.CreatedById,
  control?.LastModifiedById, control?.CreatedById,
]);
const who = (id) => {
  const u = users.get(id);
  return u ? `${u.Name} <${u.Username}>` : id ?? "(none)";
};

console.log("\n" + "=".repeat(78));
console.log("AUDIT TRAIL — who last touched it, and when");
console.log("=".repeat(78));
for (const [label, rec] of [["SUBJECT", subject], ["CONTROL", control]]) {
  if (!rec) continue;
  console.log(`\n  ${label} ${rec.Id}`);
  console.log(`     created      ${rec.CreatedDate}  by ${who(rec.CreatedById)}`);
  console.log(`     lastModified ${rec.LastModifiedDate}  by ${who(rec.LastModifiedById)}`);
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("READ-PATH TEST (H2) — does the SAME SELECT return data on the control?");
console.log("=".repeat(78));
if (!controlSummary) {
  console.log("  no control record supplied — pass one as argv[3] to complete this test.");
} else {
  console.log("\n  group                              subject      control");
  for (let i = 0; i < subjectSummary.length; i++) {
    const s = subjectSummary[i];
    const c = controlSummary[i];
    console.log(`  ${s.group.padEnd(34)} ${String(s.populated).padStart(3)}/${String(s.total).padEnd(3)}    ${String(c.populated).padStart(3)}/${String(c.total)}`);
  }
  const controlHasData = controlSummary.some((c) => c.populated > 0);
  const subjectEmpty = subjectSummary.every((s) => s.populated === 0);
  console.log("");
  if (controlHasData && subjectEmpty) {
    console.log("  => The identical SELECT returns data on the control and nothing on the subject.");
    console.log("     H2 (read path hides fields) is DEAD. The subject's fields are REALLY NULL.");
  } else if (!controlHasData) {
    console.log("  => The control is empty too. Either the control is a poor choice (also blank),");
    console.log("     or the read path really is dropping these fields. Pick a control known to");
    console.log("     have adder data before concluding anything.");
  } else {
    console.log("  => The subject is NOT uniformly empty — see the per-group detail above.");
  }
}
console.log("");
