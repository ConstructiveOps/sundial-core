// Phase 0 deliverable B — describe the rep/dealer fields against the LIVE org.
//
// WHY: docs/access-model.md §2 plans to filter row visibility on Sales_Rep__c and
// a new Dealer__c, and to backfill both from the legacy name/company fields. Every
// one of those moves rests on assumptions about field TYPE that the repo cannot
// settle on its own — §2.4 flags one outright:
//
//     "Phase 0 must confirm Sales_Representative__c's actual type by describe —
//      the solar sheet says REFERENCE, sf-query/test.js treats it as a string."
//
// A backfill that reads a lookup as if it were text (or the reverse) writes
// garbage into the field row-level security will later depend on. So: ask the org.
//
// It also produces the four counts that gate the Phase 1 backfill (§2.4, "Dennis
// specifically"): for Dennis, on both objects, how many rows the LEGACY name field
// matches versus how many the AUTHORITATIVE id field matches. The gap between
// those numbers IS the backfill's workload, and after the backfill they must agree
// or Dennis silently loses records at cutover.
//
// STRICTLY READ-ONLY. Describes and COUNT() queries. Writes nothing.
//
// Usage:
//   node scripts/describe-access-fields.mjs
//   node scripts/describe-access-fields.mjs --json > out.json
//   node scripts/describe-access-fields.mjs --markdown   # §2.4 table, paste-ready

import { describeObject, sfQuery, soqlEscapeString } from "../lib/salesforce.js";

const JSON_OUT = process.argv.includes("--json");
const MD_OUT = process.argv.includes("--markdown");

const TENANT_ID = "a1W7y000007AszBEAS"; // Sundial_Tenant__c "harmon" — every count is tenant-scoped
const DENNIS_NAME = "Dennis Alessandro"; // the one live restricted user (TEMP guard, sf-query)

// The fields named in the Phase 0 brief, per object. A field that does NOT exist
// on an object is reported as ABSENT rather than skipped — "the field isn't there"
// is itself an answer the design depends on (e.g. Dealer_Name__c on Solar).
const TARGETS = {
  Sundial_Customer__c: [
    "Sales_Rep__c",
    "Sunbase_Sales_Rep__c",
    "Sales_Company__c",
    "Dealer_Name__c",
    "Sales_Representative__c",
    "Third_Party_Sales_Representative__c",
    "Sales_Company_Harmon_Solar_or_Third__c",
    "Domestic_Content_Eligible__c", // unrelated to access; confirms the D-064 sibling fix's field
  ],
  Sundial_Solar__c: [
    "Sales_Rep__c",
    "Sunbase_Sales_Rep__c",
    "Sales_Company__c",
    "Dealer_Name__c",
    "Sales_Representative__c",
    "Third_Party_Sales_Representative__c",
    "Sales_Company_Harmon_Solar_or_Third__c",
  ],
};

// Fields whose picklist values we want enumerated in full (the dealer lists that
// Sundial_Dealer__c rows get generated from, §2.4).
const ENUMERATE_VALUES = new Set([
  "Dealer_Name__c",
  "Sales_Company__c",
  "Sales_Company_Harmon_Solar_or_Third__c",
]);

// NOTE: `SELECT COUNT()` (no field) answers with totalSize and an EMPTY records
// array, so reading rows[0] silently yields 0 for every query — which looks exactly
// like "this field is populated nowhere". Use COUNT(Id), which comes back as a real
// aggregate row carrying expr0.
const count = async (soql) => {
  const rows = await sfQuery(soql);
  const v = rows?.[0]?.expr0;
  if (typeof v !== "number") {
    throw new Error(`COUNT query returned no aggregate row — check the SOQL: ${soql}`);
  }
  return v;
};

// Populated = not null AND (for strings) not the empty string. Salesforce treats
// '' and null differently on text fields and the distinction matters for a
// backfill that keys on "is this attributed yet".
async function populatedCount(sfObject, field, isString) {
  const blankClause = isString
    ? `${field} != null AND ${field} != ''`
    : `${field} != null`;
  return count(
    `SELECT COUNT(Id) FROM ${sfObject} WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND ${blankClause}`
  );
}

async function describeTargets() {
  const out = {};
  for (const [sfObject, fields] of Object.entries(TARGETS)) {
    const desc = await describeObject(sfObject);
    const byName = new Map(desc.fields.map((f) => [f.name.toLowerCase(), f]));

    const total = await count(
      `SELECT COUNT(Id) FROM ${sfObject} WHERE Client__c = '${soqlEscapeString(TENANT_ID)}'`
    );

    const rows = [];
    for (const name of fields) {
      const f = byName.get(name.toLowerCase());
      if (!f) {
        rows.push({ field: name, present: false });
        continue;
      }
      const isString = ["string", "textarea", "picklist", "multipicklist", "email", "phone", "url"].includes(f.type);
      const row = {
        field: f.name,
        present: true,
        type: f.type,
        length: f.length || null,
        // A lookup's target object is the thing §2.4 needs: rowFilter compares ids,
        // so a "rep field" that is text cannot be filtered on without a backfill.
        referenceTo: f.referenceTo && f.referenceTo.length ? f.referenceTo : null,
        relationshipName: f.relationshipName || null,
        updateable: f.updateable,
        createable: f.createable,
        calculated: f.calculated,
        restrictedPicklist: f.restrictedPicklist ?? null,
        populated: await populatedCount(sfObject, f.name, isString),
        total,
      };
      row.blank = total - row.populated;
      if (ENUMERATE_VALUES.has(f.name) && Array.isArray(f.picklistValues)) {
        row.picklistValues = f.picklistValues.map((v) => ({
          value: v.value,
          label: v.label,
          active: v.active,
        }));
      }
      rows.push(row);
    }
    out[sfObject] = { total, fields: rows };
  }
  return out;
}

// The Phase 1 backfill gate. Four numbers, and the two comparisons between them.
async function dennisCounts() {
  // Find Dennis's Sundial_User__c. Name match is acceptable HERE (a read, to
  // resolve an id) in a way it is not acceptable as a security filter.
  const users = await sfQuery(
    `SELECT Id, First_Name__c, Last_Name__c, Email__c, Active__c, Access_Level__c, Hierarchy_Level__c ` +
      `FROM Sundial_User__c WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' ` +
      `AND First_Name__c = 'Dennis' AND Last_Name__c = 'Alessandro'`
  );

  const result = {
    matchedUsers: users.map((u) => ({
      id: u.Id,
      name: `${u.First_Name__c} ${u.Last_Name__c}`,
      email: u.Email__c,
      active: u.Active__c,
      accessLevel: u.Access_Level__c,
      hierarchyLevel: u.Hierarchy_Level__c,
    })),
  };

  if (users.length !== 1) {
    // Ambiguity here is itself a finding: the TEMP guard matches on a NAME STRING,
    // so two users with this name would both be restricted to the same records.
    result.warning =
      `Expected exactly 1 Sundial_User__c named "${DENNIS_NAME}", found ${users.length}. ` +
      `The counts below are omitted because the authoritative id is ambiguous.`;
    return result;
  }

  const userId = users[0].Id;
  result.userId = userId;
  const t = soqlEscapeString(TENANT_ID);
  const n = soqlEscapeString(DENNIS_NAME);
  const u = soqlEscapeString(userId);

  result.customer = {
    // What the TEMP guard serves him today.
    legacyNameMatch: await count(
      `SELECT COUNT(Id) FROM Sundial_Customer__c WHERE Client__c = '${t}' AND Sunbase_Sales_Rep__c = '${n}'`
    ),
    // What rowFilter would serve him after the migration.
    authoritativeIdMatch: await count(
      `SELECT COUNT(Id) FROM Sundial_Customer__c WHERE Client__c = '${t}' AND Sales_Rep__c = '${u}'`
    ),
    legacyField: "Sunbase_Sales_Rep__c",
    authoritativeField: "Sales_Rep__c",
  };
  result.solar = {
    legacyNameMatch: await count(
      `SELECT COUNT(Id) FROM Sundial_Solar__c WHERE Client__c = '${t}' AND Sales_Representative__c = '${n}'`
    ),
    authoritativeIdMatch: await count(
      `SELECT COUNT(Id) FROM Sundial_Solar__c WHERE Client__c = '${t}' AND Sales_Rep__c = '${u}'`
    ),
    legacyField: "Sales_Representative__c",
    authoritativeField: "Sales_Rep__c",
  };

  // EQUAL COUNTS ARE NOT EQUAL SETS. §2.4 makes the gate set equality — "any record
  // in the old set and not the new one is a backfill defect" — so compare the actual
  // id sets, not the two totals. Two disjoint sets of 3,534 rows would pass a count
  // check and lose him every record he has.
  const idSet = async (sfObject, where) => {
    const rows = await sfQuery(`SELECT Id FROM ${sfObject} WHERE ${where}`);
    return new Set(rows.map((r) => r.Id.slice(0, 15))); // 15 vs 18-char ids compare equal
  };
  for (const [k, obj] of [["customer", "Sundial_Customer__c"], ["solar", "Sundial_Solar__c"]]) {
    const c = result[k];
    const oldSet = await idSet(obj, `Client__c = '${t}' AND ${c.legacyField} = '${n}'`);
    const newSet = await idSet(obj, `Client__c = '${t}' AND ${c.authoritativeField} = '${u}'`);
    const onlyInOld = [...oldSet].filter((id) => !newSet.has(id));
    const onlyInNew = [...newSet].filter((id) => !oldSet.has(id));
    c.setComparison = {
      oldSetSize: oldSet.size,
      newSetSize: newSet.size,
      onlyInOldCount: onlyInOld.length,
      onlyInNewCount: onlyInNew.length,
      onlyInOldSample: onlyInOld.slice(0, 10),
      onlyInNewSample: onlyInNew.slice(0, 10),
      // The §7.2 gate, evaluated now rather than at cutover.
      gatePasses: onlyInOld.length === 0 && onlyInNew.length === 0,
    };
  }

  for (const k of ["customer", "solar"]) {
    const c = result[k];
    c.backfillGap = c.legacyNameMatch - c.authoritativeIdMatch;
    // §2.4: after backfill the new set must be a SUPERSET of the old, with
    // onlyInOld empty. A positive gap is the work; a negative gap means the id
    // field already matches rows the name field does not, which needs explaining
    // before cutover rather than after.
    c.note =
      c.backfillGap > 0
        ? `${c.backfillGap} record(s) the TEMP guard shows him today would NOT be matched by ${c.authoritativeField}. This is the backfill's workload.`
        : c.backfillGap === 0
          ? `The two fields agree on count. Set equality still needs the shadow report (§7.2) — equal counts are not the same as the same rows.`
          : `${-c.backfillGap} record(s) match ${c.authoritativeField} but NOT the legacy name. Enforcing today would WIDEN his access — investigate before cutover.`;
  }
  return result;
}

function markdown(desc, dennis) {
  const L = [];
  L.push("| Object | Field | Type | Lookup target | Updateable | Populated | Blank | Total |");
  L.push("|---|---|---|---|---|---:|---:|---:|");
  for (const [obj, data] of Object.entries(desc)) {
    for (const f of data.fields) {
      if (!f.present) {
        L.push(`| \`${obj}\` | \`${f.field}\` | **ABSENT** | — | — | — | — | — |`);
        continue;
      }
      L.push(
        `| \`${obj}\` | \`${f.field}\` | ${f.type}${f.calculated ? " (formula)" : ""} | ` +
          `${f.referenceTo ? "`" + f.referenceTo.join(", ") + "`" : "—"} | ${f.updateable ? "yes" : "no"} | ` +
          `${f.populated.toLocaleString()} | ${f.blank.toLocaleString()} | ${f.total.toLocaleString()} |`
      );
    }
  }
  L.push("");
  for (const [obj, data] of Object.entries(desc)) {
    for (const f of data.fields) {
      if (f.picklistValues) {
        const active = f.picklistValues.filter((v) => v.active);
        L.push(`**\`${obj}.${f.field}\`** — ${active.length} active value(s):`);
        L.push("");
        L.push(active.map((v) => `\`${v.value}\``).join(" · "));
        L.push("");
      }
    }
  }
  if (dennis.userId) {
    L.push("**Dennis Alessandro — the Phase 1 backfill gate (§2.4)**");
    L.push("");
    L.push(`Sundial_User__c: \`${dennis.userId}\``);
    L.push("");
    L.push("| Object | Legacy name field | matches | Authoritative id field | matches | Gap |");
    L.push("|---|---|---:|---|---:|---:|");
    for (const k of ["customer", "solar"]) {
      const c = dennis[k];
      L.push(
        `| ${k} | \`${c.legacyField}\` | ${c.legacyNameMatch.toLocaleString()} | ` +
          `\`${c.authoritativeField}\` | ${c.authoritativeIdMatch.toLocaleString()} | ${c.backfillGap.toLocaleString()} |`
      );
    }
  }
  return L.join("\n");
}

// Section 2.4 asserts "the values are identical across objects" for the two dealer
// picklists, and plans one Sundial_Dealer__c row per distinct value with
// Sales_Company_Value__c as the join key. If the two lists disagree, that key
// cannot be a single string and the backfill needs an alias map - so the claim is
// worth checking rather than inheriting.
function compareDealerLists(desc) {
  const pick = (obj, field) =>
    desc[obj]?.fields.find((f) => f.field === field)?.picklistValues?.filter((v) => v.active).map((v) => v.value) || [];

  const customer = pick("Sundial_Customer__c", "Dealer_Name__c");
  const solar = pick("Sundial_Solar__c", "Sales_Company_Harmon_Solar_or_Third__c");
  const cSet = new Set(customer);
  const sSet = new Set(solar);

  // Case/punctuation-insensitive comparison catches the near-misses an exact join
  // would drop on the floor - those are the dangerous ones, because they look like
  // two different dealers and are actually one.
  const norm = (v) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const cNorm = new Map(customer.map((v) => [norm(v), v]));
  const sNorm = new Map(solar.map((v) => [norm(v), v]));

  const nearMiss = [];
  for (const [k, cv] of cNorm) {
    const sv = sNorm.get(k);
    if (sv && sv !== cv) nearMiss.push({ customer: cv, solar: sv });
  }
  return {
    customerCount: customer.length,
    solarCount: solar.length,
    exactMatchCount: customer.filter((v) => sSet.has(v)).length,
    onlyOnCustomer: customer.filter((v) => !sSet.has(v) && !sNorm.has(norm(v))),
    onlyOnSolar: solar.filter((v) => !cSet.has(v) && !cNorm.has(norm(v))),
    nearMisses: nearMiss,
    launchDealers: ["Harmon Solar", "Heavenly Power", "Property Upgrades LLC"].map((d) => ({
      dealer: d,
      onCustomer: cSet.has(d),
      onSolar: sSet.has(d),
    })),
  };
}

async function main() {
  const desc = await describeTargets();
  const dennis = await dennisCounts();
  const dealers = compareDealerLists(desc);

  if (JSON_OUT) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), tenantId: TENANT_ID, describe: desc, dennis, dealers }, null, 2));
    return;
  }
  if (MD_OUT) {
    console.log(markdown(desc, dennis));
    return;
  }

  for (const [obj, data] of Object.entries(desc)) {
    console.log(`\n=== ${obj} (${data.total.toLocaleString()} rows in tenant) ===`);
    for (const f of data.fields) {
      if (!f.present) {
        console.log(`  ${f.field.padEnd(42)} ABSENT — no such field on this object`);
        continue;
      }
      const ref = f.referenceTo ? ` -> ${f.referenceTo.join(",")}` : "";
      const calc = f.calculated ? " [formula]" : "";
      console.log(
        `  ${f.field.padEnd(42)} ${(f.type + ref + calc).padEnd(34)} ` +
          `populated ${String(f.populated).padStart(6)} / blank ${String(f.blank).padStart(6)}`
      );
      if (f.picklistValues) {
        const active = f.picklistValues.filter((v) => v.active);
        console.log(`      ${active.length} active value(s): ${active.map((v) => v.value).join(" | ")}`);
      }
    }
  }

  console.log(`
=== Dealer picklists - cross-object comparison (section 2.4) ===`);
  console.log(`  Customer.Dealer_Name__c                      ${dealers.customerCount} active values`);
  console.log(`  Solar.Sales_Company_Harmon_Solar_or_Third__c ${dealers.solarCount} active values`);
  console.log(`  exact matches on both objects:               ${dealers.exactMatchCount}`);
  console.log(`  only on Customer: ${dealers.onlyOnCustomer.length}   only on Solar: ${dealers.onlyOnSolar.length}`);
  if (dealers.nearMisses.length) {
    console.log(`  NEAR MISSES (same dealer, different spelling) - an exact join would MISS these:`);
    dealers.nearMisses.forEach((m) => console.log(`      Customer "${m.customer}"  vs  Solar "${m.solar}"`));
  }
  console.log(`  launch dealers:`);
  dealers.launchDealers.forEach((d) =>
    console.log(`      ${d.dealer.padEnd(24)} Customer:${d.onCustomer ? "yes" : "NO "}  Solar:${d.onSolar ? "yes" : "NO "}`)
  );

  console.log(`\n=== Dennis Alessandro — Phase 1 backfill gate ===`);
  if (dennis.warning) {
    console.log(`  WARNING: ${dennis.warning}`);
  }
  dennis.matchedUsers.forEach((u) =>
    console.log(`  user ${u.id}  active=${u.active}  Access_Level__c=${u.accessLevel}  Hierarchy_Level__c=${u.hierarchyLevel}`)
  );
  for (const k of ["customer", "solar"]) {
    const c = dennis[k];
    if (!c) continue;
    console.log(`\n  ${k}:`);
    console.log(`    ${c.legacyField} = "${DENNIS_NAME}"  -> ${c.legacyNameMatch.toLocaleString()}   (what he sees TODAY)`);
    console.log(`    ${c.authoritativeField} = ${dennis.userId}  -> ${c.authoritativeIdMatch.toLocaleString()}   (what rowFilter would serve)`);
    console.log(`    gap: ${c.backfillGap.toLocaleString()} — ${c.note}`);
    const sc = c.setComparison;
    if (sc) {
      console.log(
        `    SET COMPARISON: onlyInOld=${sc.onlyInOldCount}  onlyInNew=${sc.onlyInNewCount}  ` +
          `-> §7.2 gate ${sc.gatePasses ? "PASSES (identical sets)" : "FAILS"}`
      );
      if (sc.onlyInOldSample.length) console.log(`      onlyInOld sample: ${sc.onlyInOldSample.join(", ")}`);
      if (sc.onlyInNewSample.length) console.log(`      onlyInNew sample: ${sc.onlyInNewSample.join(", ")}`);
    }
  }
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
