// Phase 0 deliverable C — audit every active portal user's access/hierarchy levels.
//
// WHY: `sundial-user-admin` stamps Hierarchy_Level__c = "Sales Rep" on EVERY user it
// creates (DEFAULT_HIERARCHY_LEVEL), regardless of the access level the admin chose.
// The TEMP guard in sundial-sf-query keys on exactly that value. So every user ever
// created through Manage Users and not hand-corrected in Salesforce afterwards is
// being served a Sales Rep's restricted view of Customer and Solar, whatever their
// real role. This script finds them.
//
// It is the input to two things: the Phase 0 report (who is mis-levelled today) and
// the Phase 2 shadow gate ("for every other user the report shows what they will
// lose ... so you can set Access_Level__c before the flip", access-model.md §7.2).
//
// STRICTLY READ-ONLY. One SOQL SELECT. Changes nothing — deliberately, because
// fixing a user's level changes what they can see, and that is Tim's call per user,
// not a side effect of running an audit.
//
// Usage:
//   node scripts/audit-user-levels.mjs
//   node scripts/audit-user-levels.mjs --markdown > docs/access-model-phase0-user-audit.md
//   node scripts/audit-user-levels.mjs --all       # include inactive users too

import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";

const MD = process.argv.includes("--markdown");
const INCLUDE_INACTIVE = process.argv.includes("--all");
const TENANT_ID = "a1W7y000007AszBEAS"; // Sundial_Tenant__c "harmon"

// The value the TEMP guard keys on. A user carrying this is restricted TODAY.
const TEMP_GUARD_VALUE = "Sales Rep";

// access-model.md §1.2. `Access_Level__c` is the only input to the new model; this
// is what each level SHOULD resolve to once lib/access.js exists.
const SCOPE_FOR_ACCESS_LEVEL = {
  Executive: "tenant",
  Admin: "tenant",
  Manager: "tenant",
  "Sales Dealer": "dealer",
  "Sales Rep": "own",
  Technician: "none",
};

// The derivation `user-admin` applies going forward. Kept in step with
// HIERARCHY_BY_ACCESS_LEVEL in lambdas/sundial-user-admin/index.js -- this script is
// read-only and standalone, so it carries its own copy rather than importing the
// Lambda; the Lambda's unit tests are what pin the values.
//
// Hierarchy_Level__c is a RESTRICTED picklist. "Sales Manager" did not exist when
// Phase 0 started -- describing the field is what caught it, and Tim added the value
// on 2026-08-27 (along with "Technician") before this mapping was implemented.
const DERIVED_HIERARCHY = {
  "Sales Rep": "Sales Rep",
  "Sales Dealer": "Sales Manager",
};
const DERIVED_HIERARCHY_DEFAULT = "Client";
const deriveHierarchy = (accessLevel) =>
  DERIVED_HIERARCHY[accessLevel] ?? DERIVED_HIERARCHY_DEFAULT;

async function main() {
  const activeClause = INCLUDE_INACTIVE ? "" : " AND Active__c = true";
  const rows = await sfQuery(
    `SELECT Id, First_Name__c, Last_Name__c, Email__c, Active__c, ` +
      `Access_Level__c, Hierarchy_Level__c, Super_Admin__c, Default_Department__c, ` +
      `Parent_User__c, Supabase_User_Id__c, CreatedDate ` +
      `FROM Sundial_User__c WHERE Client__c = '${soqlEscapeString(TENANT_ID)}'${activeClause} ` +
      `ORDER BY Last_Name__c, First_Name__c`
  );

  const users = rows.map((r) => {
    const access = r.Access_Level__c ?? null;
    const hierarchy = r.Hierarchy_Level__c ?? null;
    const derived = deriveHierarchy(access);
    return {
      id: r.Id,
      name: [r.First_Name__c, r.Last_Name__c].filter(Boolean).join(" ") || "(no name)",
      email: r.Email__c ?? null,
      active: r.Active__c === true,
      accessLevel: access,
      hierarchyLevel: hierarchy,
      derivedHierarchy: derived,
      superAdmin: r.Super_Admin__c === true,
      hasLogin: Boolean(r.Supabase_User_Id__c),
      createdDate: r.CreatedDate ? r.CreatedDate.slice(0, 10) : null,
      // The scope this user WILL resolve to under the new model.
      futureScope: access ? (SCOPE_FOR_ACCESS_LEVEL[access] ?? "none") : "none",
      // Restricted TODAY by the TEMP guard, whatever their real role.
      restrictedToday: hierarchy === TEMP_GUARD_VALUE,
      // Stored hierarchy differs from what the derivation would write. On its own
      // this is COSMETIC: nothing reads Hierarchy_Level__c except the TEMP guard,
      // and the guard only cares about one value. A Manager stored as "Manager"
      // differs from the derived "Client" and is entirely harmless.
      derivationDiffers: hierarchy !== derived,
      // The one that MATTERS. Hierarchy says "Sales Rep" -- so the TEMP guard
      // restricts them to Dennis's records today -- while their real access level
      // is not a rep's. This is the user-admin default bug actually biting someone.
      // A narrowing, not a widening, which is why it shows up as "why can this
      // person not see anything" rather than as a security incident.
      wronglyRestricted: hierarchy === TEMP_GUARD_VALUE && access !== "Sales Rep",
      // No access level at all -> fail closed to `none` under the new model, i.e.
      // this user sees NOTHING after Phase 3 unless levelled first.
      missingAccessLevel: !access,
    };
  });

  if (!MD) {
    console.log(`\n${users.length} user(s) in tenant${INCLUDE_INACTIVE ? " (incl. inactive)" : " (active only)"}\n`);
    for (const u of users) {
      const flags = [
        u.wronglyRestricted ? "WRONGLY-RESTRICTED" : "",
        u.derivationDiffers ? "derivation-differs" : "",
        u.restrictedToday ? "RESTRICTED-TODAY" : "",
        u.missingAccessLevel ? "NO-ACCESS-LEVEL" : "",
        u.superAdmin ? "SUPER-ADMIN" : "",
      ].filter(Boolean).join(" ");
      console.log(
        `  ${u.name.padEnd(26)} ${String(u.accessLevel).padEnd(14)} ` +
          `hier=${String(u.hierarchyLevel).padEnd(11)} derived=${u.derivedHierarchy.padEnd(11)} ` +
          `scope=${u.futureScope.padEnd(7)} ${flags}`
      );
    }
    const d = users.filter((u) => u.wronglyRestricted);
    const r = users.filter((u) => u.restrictedToday);
    const m = users.filter((u) => u.missingAccessLevel);
    console.log(`\n  WRONGLY RESTRICTED: ${d.length}   restricted today: ${r.length}   no access level: ${m.length}`);
    console.log();
    return;
  }

  // ---- markdown report ------------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  const wrong = users.filter((u) => u.wronglyRestricted);
  const differs = users.filter((u) => u.derivationDiffers);
  const restricted = users.filter((u) => u.restrictedToday);
  const noLevel = users.filter((u) => u.missingAccessLevel);
  const superAdmins = users.filter((u) => u.superAdmin);
  const conflicted = users.filter((u) => u.superAdmin && ["Sales Rep", "Sales Dealer"].includes(u.accessLevel));

  const L = [];
  L.push(`# Access model — Phase 0 user audit`);
  L.push(``);
  L.push(`**Generated:** ${today} by \`node scripts/audit-user-levels.mjs --markdown\` (read-only).`);
  L.push(`**Tenant:** \`${TENANT_ID}\` (harmon) · **Scope:** ${INCLUDE_INACTIVE ? "all users" : "active users only"} · **${users.length} user(s)**`);
  L.push(``);
  L.push(`Companion to [\`access-model.md\`](access-model.md) §8 Phase 0. This report changes`);
  L.push(`nothing — re-levelling a user changes what they can see, which is a per-user decision,`);
  L.push(`not a side effect of an audit.`);
  L.push(``);
  L.push(`## Why this exists`);
  L.push(``);
  L.push(`\`sundial-user-admin\` stamped \`Hierarchy_Level__c = "Sales Rep"\` on **every** user it`);
  L.push(`created, regardless of the access level chosen in Manage Users. The TEMP guard in`);
  L.push(`\`sundial-sf-query\` keys on exactly that value. So any user created through Manage Users`);
  L.push(`and not hand-corrected in Salesforce afterwards has been served a Sales Rep's restricted`);
  L.push(`view of Customer and Solar — a **narrowing**, not a widening, which is why it presented`);
  L.push(`as "why can't this person see anything" rather than as a security incident.`);
  L.push(``);
  L.push(`## Summary`);
  L.push(``);
  L.push(`| Finding | Count |`);
  L.push(`|---|---:|`);
  L.push(`| Users **wrongly restricted today** (hierarchy \`Sales Rep\`, access level is not) | **${wrong.length}** |`);
  L.push(`| Users whose stored hierarchy differs from the derived value (cosmetic — nothing reads it) | ${differs.length} |`);
  L.push(`| Users restricted **today** by the TEMP guard (\`Hierarchy_Level__c = "Sales Rep"\`) | **${restricted.length}** |`);
  L.push(`| Users with no \`Access_Level__c\` at all (→ scope \`none\` after Phase 3) | **${noLevel.length}** |`);
  L.push(`| Super admins | ${superAdmins.length} |`);
  L.push(`| Super admins holding a **sales** access level (the combination §1.2 says must not exist) | **${conflicted.length}** |`);
  L.push(``);
  L.push(`## Every user`);
  L.push(``);
  L.push(`\`derived\` is what \`user-admin\` will write going forward. \`scope\` is what §1.2 resolves`);
  L.push(`the access level to once \`lib/access.js\` exists.`);
  L.push(``);
  L.push(`| User | Access_Level__c | Hierarchy_Level__c | derived | future scope | flags |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const u of users) {
    const flags = [
      u.wronglyRestricted ? "**WRONGLY RESTRICTED**" : "",
      u.derivationDiffers ? "derivation differs" : "",
      u.restrictedToday ? "restricted today" : "",
      u.missingAccessLevel ? "**no access level**" : "",
      u.superAdmin ? "super admin" : "",
      u.active ? "" : "inactive",
      u.hasLogin ? "" : "no login",
    ].filter(Boolean).join(", ");
    L.push(
      `| ${u.name}${u.email ? ` <br><sub>${u.email}</sub>` : ""} | ${u.accessLevel ?? "_(null)_"} | ` +
        `${u.hierarchyLevel ?? "_(null)_"} | ${u.derivedHierarchy} | \`${u.futureScope}\` | ${flags} |`
    );
  }
  L.push(``);
  L.push(`## The distinction that matters`);
  L.push(``);
  L.push(`Two different things look like "the fields disagree", and only one of them has any`);
  L.push(`effect on what a user can see:`);
  L.push(``);
  L.push(`**Wrongly restricted (${wrong.length})** — \`Hierarchy_Level__c = "Sales Rep"\` while`);
  L.push(`\`Access_Level__c\` is something else. The TEMP guard keys on that exact value, so these`);
  L.push(`users are being served **Dennis's records** on Customer and Solar right now, whatever`);
  L.push(`their real role. This is the user-admin default bug actually biting someone.`);
  L.push(``);
  if (wrong.length) {
    L.push(`| User | Access_Level__c | stored hierarchy | sees today |`);
    L.push(`|---|---|---|---|`);
    for (const u of wrong) {
      L.push(`| ${u.name} | ${u.accessLevel ?? "_(null)_"} | \`${u.hierarchyLevel}\` | Dennis's records only |`);
    }
  } else {
    L.push(`_None._`);
  }
  L.push(``);
  L.push(`**Derivation differs (${differs.length})** — cosmetic. The stored value is not what the new`);
  L.push(`derivation would write, but nothing reads \`Hierarchy_Level__c\` except the TEMP guard and`);
  L.push(`the guard only cares about one value. A \`Manager\` stored as \`Manager\` differs from the`);
  L.push(`derived \`Client\` and is entirely harmless. **No existing record is changed by this work** —`);
  L.push(`the derivation applies to creates and to \`accessLevel\` PATCHes from here on.`);
  L.push(``);
  L.push(`Note the direction of that: PATCHing \`accessLevel\` on one of these users will rewrite`);
  L.push(`their hierarchy from \`Manager\` to \`Client\`, because "anything not a sales role" collapses`);
  L.push(`to \`Client\`. Harmless for the same reason, but it is a real write and worth knowing about.`);
  L.push(``);
  if (noLevel.length) {
    L.push(`## ⚠️ ${noLevel.length} user(s) with no \`Access_Level__c\``);
    L.push(``);
    L.push(`§1.2 fails closed: null or unknown resolves to scope \`none\`, which sees **nothing**.`);
    L.push(`These users must be levelled before Phase 3 enforce or they lose all access.`);
    L.push(``);
    noLevel.forEach((u) => L.push(`- \`${u.id}\` — ${u.name}${u.email ? ` (${u.email})` : ""}${u.hasLogin ? "" : " — no login, so lower urgency"}`));
    L.push(``);
  }
  if (conflicted.length) {
    L.push(`## ⚠️ Super admin holding a sales access level`);
    L.push(``);
    L.push(`§1.2: "a super admin with \`Access_Level__c = Sales Rep\` is an \`own\`-scope user who can`);
    L.push(`manage users — that combination should not exist". \`user-admin\` now refuses to *create*`);
    L.push(`it. Existing records are listed here rather than changed.`);
    L.push(``);
    conflicted.forEach((u) => L.push(`- \`${u.id}\` — ${u.name} (\`${u.accessLevel}\`)`));
    L.push(``);
  }
  console.log(L.join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
