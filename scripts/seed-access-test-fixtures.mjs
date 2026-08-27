// Phase 0 deliverable D — seed the access-model test fixtures (access-model.md §9).
//
// WHY THESE EXIST
//
// CLAUDE.md already forbids testing saves against a live CUSTOMER. Access-model work
// needs the same rule one level up: you cannot test "what can a Sales Rep see" without
// BEING a Sales Rep, and the only live one is Dennis Alessandro. Logging in as him,
// re-levelling him, or reassigning his records to find out would be testing in
// production on a real person's account. So: designated test USERS, designated test
// RECORDS, and a matrix script that logs in as each of them.
//
//   Never log in as, re-level, or reassign the records of a real user to test
//   visibility. Use these fixtures.
//
// WHAT IT CREATES
//
//   - 10 Supabase auth users + matching Sundial_User__c records (§9), passwords
//     generated here and stored in Secrets Manager under `sundial/test-users`
//   - 3 new ZZ PORTAL TEST customers, plus a rep stamp on the existing designated one
//   - one Solar twin per test customer, and one ZZ PORTAL TEST ROOFING
//
// SAFETY
//
//   - Dry run by DEFAULT. `--apply` is the only thing that writes.
//   - IDEMPOTENT. Everything is looked up by a stable key (email / Name) first;
//     re-running updates rather than duplicating, and existing passwords are
//     preserved so already-working logins keep working.
//   - CANARY FIRST (CLAUDE.md). The first Sundial_User__c is created alone, re-read,
//     and compared field-by-field against what was sent. Anything the script did NOT
//     write that came back different means automation is active on the object, and
//     the run aborts before touching the other nine.
//   - Every Salesforce record it writes is named `ZZ ...`. It refuses to touch a
//     record whose Name does not start with the ZZ prefix, including on update.
//
// Usage:
//   node scripts/seed-access-test-fixtures.mjs                 # dry run, prints the plan
//   node scripts/seed-access-test-fixtures.mjs --apply         # create / re-seed
//   node scripts/seed-access-test-fixtures.mjs --apply --users-only
//   node scripts/seed-access-test-fixtures.mjs --show-passwords # print the stored map

import {
  sfQuery,
  sfCreateRecord,
  sfUpdateRecord,
  soqlEscapeString,
} from "../lib/salesforce.js";
import { getSupabaseClient } from "../lib/supabase.js";
import { getSecret } from "../lib/secrets.js";
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { randomBytes } from "node:crypto";

const APPLY = process.argv.includes("--apply");
const USERS_ONLY = process.argv.includes("--users-only");
const SHOW_PASSWORDS = process.argv.includes("--show-passwords");

const TENANT_ID = "a1W7y000007AszBEAS"; // Sundial_Tenant__c "harmon" — Client__c is required
const TEST_USER_SECRET = "sundial/test-users";
const ZZ_PREFIX = "ZZ ";

// The existing designated portal test record (CLAUDE.md). It is NOT created here —
// only stamped with a rep — and its adder/commission baseline is deliberately left
// alone. `create-portal-test-record.mjs --apply` re-seeds that baseline and does not
// touch Sales_Rep__c, so the two scripts do not fight over this record.
const EXISTING_TEST_CUSTOMER = "a1P7y00000AmyXCEAZ";

// Emails are PLUS-ADDRESSED on a real mailbox Tim controls, not a fake domain: a
// Supabase invite or password-reset for a test user then lands somewhere real and
// bounces nowhere. The `zz-` local part keeps them obvious in any user list.
const EMAIL = (slug) => `tim+zz-${slug}@constructiveoperations.com`;

// §9's fixture table. `dealer` is recorded for Phase 1 and is NOT written today:
// Sundial_User__c has no Dealer__c field yet (confirmed by describe, 2026-08-27), so
// there is nothing to leave unset. TODO(Phase 1): scripts/backfill-dealers.mjs
// creates Sundial_Dealer__c rows and a follow-up pass stamps Dealer__c from the
// `dealer` key below. Until then every sales user resolves to scope `none` under the
// new model's null-dealer rule — which is the correct fail-closed answer, and is
// itself worth asserting in the matrix.
const TEST_USERS = [
  { slug: "rep-a1", first: "ZZ Rep", last: "A One", accessLevel: "Sales Rep", dealer: "ZZ TEST DEALER A" },
  { slug: "rep-a2", first: "ZZ Rep", last: "A Two", accessLevel: "Sales Rep", dealer: "ZZ TEST DEALER A" },
  { slug: "mgr-a", first: "ZZ Mgr", last: "A", accessLevel: "Sales Dealer", dealer: "ZZ TEST DEALER A" },
  { slug: "rep-b1", first: "ZZ Rep", last: "B One", accessLevel: "Sales Rep", dealer: "ZZ TEST DEALER B" },
  { slug: "rep-harmon", first: "ZZ Rep", last: "Harmon", accessLevel: "Sales Rep", dealer: "Harmon Solar",
    note: "Dennis's twin — same shape as the one live restricted user, without being him" },
  { slug: "rep-nodealer", first: "ZZ Rep", last: "No Dealer", accessLevel: "Sales Rep", dealer: null,
    note: "null dealer must resolve to scope `none` (§1.2), not to 'all dealers'" },
  { slug: "rep-inactive-dealer", first: "ZZ Rep", last: "Inactive Dealer", accessLevel: "Sales Rep",
    dealer: "ZZ TEST DEALER INACTIVE", note: "inactive dealer -> scope `none` (§2.1)" },
  { slug: "tech", first: "ZZ Tech", last: "One", accessLevel: "Technician",
    note: "Technician -> `none` until Phase II (§12.3)" },
  { slug: "admin", first: "ZZ Admin", last: "One", accessLevel: "Admin",
    note: "Super_Admin__c is NOT set here — D-043 says Salesforce-only. Tick it by hand to unblock the endpoint assertion in verify-provisioning-e2e." },
  { slug: "exec", first: "ZZ Exec", last: "One", accessLevel: "Executive" },
];

// Test customers and their rep. The Solar twin inherits the same rep.
const TEST_CUSTOMERS = [
  { name: "ZZ PORTAL TEST — DO NOT USE", existingId: EXISTING_TEST_CUSTOMER, repSlug: "rep-a1" },
  { name: "ZZ PORTAL TEST 2", repSlug: "rep-a2" },
  { name: "ZZ PORTAL TEST B", repSlug: "rep-b1" },
  { name: "ZZ PORTAL TEST HARMON", repSlug: "rep-harmon" },
];

const log = (...a) => console.log(...a);
const plan = (what) => log(`  ${APPLY ? "APPLY " : "would "} ${what}`);

// 24 chars of base64url plus a fixed suffix, so every generated password satisfies
// any plausible complexity rule without a retry loop.
const makePassword = () => `${randomBytes(18).toString("base64url")}aA1!`;

// --- Secrets Manager ---------------------------------------------------------
// The passwords are the only NEW secret material this work creates. They live in
// Secrets Manager for the same reason every other credential does, and are never
// written to a file this repo commits.
async function loadPasswords() {
  try {
    return await getSecret(TEST_USER_SECRET);
  } catch (err) {
    if (/ResourceNotFound/i.test(err?.name || err?.message || "")) return null;
    throw err;
  }
}

async function savePasswords(map, existed) {
  const client = new SecretsManagerClient({});
  const SecretString = JSON.stringify(map, null, 2);
  if (existed) {
    await client.send(new PutSecretValueCommand({ SecretId: TEST_USER_SECRET, SecretString }));
  } else {
    await client.send(
      new CreateSecretCommand({
        Name: TEST_USER_SECRET,
        Description:
          "Passwords for the ZZ TEST access-model users (docs/access-model.md §9). " +
          "Test accounts only — never a live user.",
        SecretString,
      })
    );
  }
}

// --- Salesforce helpers ------------------------------------------------------
const guardZZ = (name, what) => {
  if (!name || !name.startsWith(ZZ_PREFIX)) {
    throw new Error(
      `REFUSING to ${what}: "${name}" does not start with "${ZZ_PREFIX}". This script only ` +
        `ever touches ZZ TEST records.`
    );
  }
};

async function findUserByEmail(email) {
  const rows = await sfQuery(
    `SELECT Id, First_Name__c, Last_Name__c, Email__c, Access_Level__c, Hierarchy_Level__c, ` +
      `Active__c, Super_Admin__c, Supabase_User_Id__c FROM Sundial_User__c ` +
      `WHERE Email__c = '${soqlEscapeString(email)}' AND Client__c = '${soqlEscapeString(TENANT_ID)}' LIMIT 1`
  );
  return rows?.[0] ?? null;
}

// Solar/Roofing have autonumber Names, so the parent lookup is the stable key.
async function findSolarForCustomer(customerId) {
  const rows = await sfQuery(
    `SELECT Id, Name, Project_Name__c FROM Sundial_Solar__c ` +
      `WHERE Sundial_Customer__c = '${soqlEscapeString(customerId)}' ` +
      `AND Client__c = '${soqlEscapeString(TENANT_ID)}' LIMIT 1`
  );
  return rows?.[0] ?? null;
}

async function findByName(sfObject, name) {
  const rows = await sfQuery(
    `SELECT Id, Name FROM ${sfObject} WHERE Name = '${soqlEscapeString(name)}' ` +
      `AND Client__c = '${soqlEscapeString(TENANT_ID)}' LIMIT 1`
  );
  return rows?.[0] ?? null;
}

// The derivation `sundial-user-admin` applies. Duplicated deliberately: this script
// writes to Salesforce directly rather than through the endpoint (it needs to run
// before any super admin exists), so it must produce the SAME hierarchy the endpoint
// would. lambdas/sundial-user-admin/test.js pins the values.
const HIERARCHY_BY_ACCESS_LEVEL = { "Sales Rep": "Sales Rep", "Sales Dealer": "Sales Manager" };
const deriveHierarchy = (lvl) => HIERARCHY_BY_ACCESS_LEVEL[lvl] ?? "Client";

/**
 * CANARY (CLAUDE.md). Write ONE record, read it back, and compare every field we
 * sent. Then check that nothing we did NOT send came back populated in a way that
 * suggests a Flow or trigger rewrote the row.
 *
 * This is the only empirical check available: the integration user cannot read
 * FlowDefinitionView or ApexTrigger, so there is no way to ASK the org what
 * automation is live on Sundial_User__c.
 */
async function canaryCreateUser(fields) {
  const created = await sfCreateRecord("Sundial_User__c", fields);
  // Select EXACTLY the fields being compared, derived from what was sent. Hardcoding
  // the select list is how the first version of this produced a false positive: it
  // compared Supabase_User_Id__c without selecting it, so the field read back
  // `undefined` and the canary reported the org had changed it. A canary that cries
  // wolf gets disabled, so the query and the comparison must come from one list.
  const compared = [...Object.keys(fields), "Super_Admin__c"];
  const rows = await sfQuery(
    `SELECT Id, ${compared.join(", ")} FROM Sundial_User__c ` +
      `WHERE Id = '${soqlEscapeString(created.id)}' LIMIT 1`
  );
  const back = rows?.[0];
  if (!back) throw new Error(`CANARY FAILED: created ${created.id} but could not read it back.`);

  const mismatches = [];
  for (const [k, v] of Object.entries(fields)) {
    if (back[k] !== v) mismatches.push(`${k}: sent ${JSON.stringify(v)}, got ${JSON.stringify(back[k])}`);
  }
  // Super_Admin__c is never sent by this script. If it came back true, something
  // else set it, and that is exactly the kind of surprise the canary exists for.
  if (back.Super_Admin__c === true) {
    mismatches.push(`Super_Admin__c: never sent, came back true`);
  }
  if (mismatches.length) {
    throw new Error(
      `CANARY FAILED on ${created.id} — the org changed fields under us:\n    ` +
        mismatches.join("\n    ") +
        `\n  Aborting before the remaining ${TEST_USERS.length - 1} users are written. ` +
        `Investigate active automation on Sundial_User__c first.`
    );
  }
  log(`  canary OK — ${created.id} read back exactly as written`);
  return created.id;
}

// --- Users -------------------------------------------------------------------
async function seedUsers() {
  log(`\n=== USERS (${TEST_USERS.length}) ===`);
  const existingSecret = await loadPasswords();
  const passwords = { ...(existingSecret || {}) };
  const supabase = APPLY ? await getSupabaseClient() : null;
  const results = [];
  let canaryDone = false;

  for (const u of TEST_USERS) {
    const email = EMAIL(u.slug);
    const hierarchy = deriveHierarchy(u.accessLevel);
    const sfRow = await findUserByEmail(email);

    // Password: reuse a stored one so an existing login keeps working; generate only
    // when there is none. A re-run must never silently invalidate credentials the
    // matrix script is mid-way through using.
    if (!passwords[email]) passwords[email] = makePassword();

    log(`\n  ${email}`);
    log(`    ${u.accessLevel} -> Hierarchy_Level__c "${hierarchy}"${u.dealer ? `  | dealer (Phase 1): ${u.dealer}` : "  | dealer: none"}`);
    if (u.note) log(`    note: ${u.note}`);

    if (!APPLY) {
      plan(sfRow ? `update Sundial_User__c ${sfRow.Id}` : `create Supabase auth user + Sundial_User__c`);
      results.push({ ...u, email, hierarchy, sfId: sfRow?.Id ?? null });
      continue;
    }

    // 1. Supabase auth user — create, or reuse by email (mirrors user-admin's
    //    fail-safe ordering so a retry after a partial failure re-links cleanly).
    let authUserId = sfRow?.Supabase_User_Id__c ?? null;
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password: passwords[email],
      email_confirm: true,
      user_metadata: { zz_test_user: true, access_model_fixture: u.slug },
    });
    if (createErr) {
      if (/already/i.test(createErr.message)) {
        // Reuse, and RESET the password to the stored one so the secret is always
        // the truth about how to log in.
        const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const found = list?.users?.find((x) => x.email?.toLowerCase() === email);
        if (!found) throw new Error(`Supabase says ${email} exists but it was not in the list.`);
        authUserId = found.id;
        await supabase.auth.admin.updateUserById(found.id, { password: passwords[email] });
        log(`    supabase: reused ${authUserId} (password reset to the stored value)`);
      } else {
        throw new Error(`Supabase create failed for ${email}: ${createErr.message}`);
      }
    } else {
      authUserId = created?.user?.id ?? null;
      log(`    supabase: created ${authUserId}`);
    }

    // 2. Sundial_User__c
    const fields = {
      First_Name__c: u.first,
      Last_Name__c: u.last,
      Email__c: email,
      Access_Level__c: u.accessLevel,
      Hierarchy_Level__c: hierarchy,
      Active__c: true,
      Supabase_User_Id__c: authUserId,
      Client__c: TENANT_ID,
    };
    if (sfRow) {
      await sfUpdateRecord("Sundial_User__c", sfRow.Id, fields);
      log(`    salesforce: updated ${sfRow.Id}`);
      results.push({ ...u, email, hierarchy, sfId: sfRow.Id, authUserId });
    } else if (!canaryDone) {
      const id = await canaryCreateUser(fields);
      canaryDone = true;
      log(`    salesforce: created ${id}`);
      results.push({ ...u, email, hierarchy, sfId: id, authUserId });
    } else {
      const c = await sfCreateRecord("Sundial_User__c", fields);
      log(`    salesforce: created ${c.id}`);
      results.push({ ...u, email, hierarchy, sfId: c.id, authUserId });
    }
  }

  if (APPLY) {
    await savePasswords(passwords, Boolean(existingSecret));
    log(`\n  passwords stored in Secrets Manager: ${TEST_USER_SECRET} (${Object.keys(passwords).length} entries)`);
  }
  return results;
}

// --- Records -----------------------------------------------------------------
async function seedRecords(users) {
  const bySlug = new Map(users.map((u) => [u.slug, u]));
  log(`\n=== CUSTOMERS + SOLAR TWINS ===`);

  for (const c of TEST_CUSTOMERS) {
    const rep = bySlug.get(c.repSlug);
    const repName = rep ? `${rep.first} ${rep.last}` : null;
    log(`\n  ${c.name}  ->  rep ${c.repSlug} (${rep?.sfId ?? "unresolved"})`);

    // 1. Customer
    let customerId = c.existingId ?? null;
    if (customerId) {
      // The designated record already exists; only the rep is stamped. Its
      // adder/commission baseline (CLAUDE.md) is deliberately untouched.
      guardZZ(c.name, "stamp a rep on");
      plan(`stamp Sales_Rep__c on the EXISTING designated record ${customerId} (baseline untouched)`);
      if (APPLY && rep?.sfId) {
        await sfUpdateRecord("Sundial_Customer__c", customerId, { Sales_Rep__c: rep.sfId });
      }
    } else {
      const found = await findByName("Sundial_Customer__c", c.name);
      const fields = {
        Name: c.name,
        Client__c: TENANT_ID,
        Sales_Rep__c: rep?.sfId ?? null,
        // The LEGACY name field the TEMP guard filters on. Set so the matrix can show
        // old-vs-new behaviour on the same record. Unrestricted picklist, so an
        // arbitrary string is accepted (confirmed by describe).
        Sunbase_Sales_Rep__c: repName,
      };
      if (found) {
        guardZZ(found.Name, "update customer");
        customerId = found.Id;
        plan(`update customer ${customerId}`);
        if (APPLY) await sfUpdateRecord("Sundial_Customer__c", customerId, fields);
      } else {
        plan(`create customer "${c.name}"`);
        if (APPLY) {
          const created = await sfCreateRecord("Sundial_Customer__c", fields);
          customerId = created.id;
          log(`      created ${customerId}`);
        }
      }
    }

    // 2. Solar twin.
    //
    // DEVIATION from §9, stated plainly: §9 asks for the twin to be created "through
    // Create Project". That path is a CLIENT-side TypeScript function in harmon-crm
    // (src/lib/create-solar-from-customer.ts) driven by a ~600-line field map. Calling
    // it from here is not possible without duplicating that map into this repo, which
    // would create a second source of truth that silently drifts from the first.
    //
    // What §9 actually needs from the twin is the ACCESS-relevant outcome: a Solar
    // record linked to its customer, carrying both the id rep field (what rowFilter
    // will use) and the legacy name field (what the TEMP guard uses today). That is
    // what is written here. The full field map is not exercised, and the twin is not
    // a fixture for Create Project's own correctness.
    //
    // TODO(Phase 4): once Create Project moves server-side and copies rep/dealer
    // itself, re-create these twins through it and delete this note.
    // Sundial_Solar__c.Name is an AUTONUMBER (createable: false) — it cannot be set,
    // so it is useless both as a label and as an idempotency key. The human-readable
    // label goes in Project_Name__c, and the stable key is the CUSTOMER lookup: one
    // twin per test customer, found by its parent.
    const solarLabel = `${c.name} SOLAR`;
    const foundSolar = customerId ? await findSolarForCustomer(customerId) : null;
    const solarFields = {
      Project_Name__c: solarLabel,
      Client__c: TENANT_ID,
      Sundial_Customer__c: customerId,
      Sales_Rep__c: rep?.sfId ?? null,
      Sales_Representative__c: repName,
    };
    if (foundSolar) {
      // The ZZ guard is on the PARENT here: Name cannot carry the prefix, so the
      // thing being asserted is that this twin hangs off a ZZ test customer.
      guardZZ(c.name, "update the solar twin of");
      plan(`update solar twin ${foundSolar.Id} (${foundSolar.Name})`);
      if (APPLY) await sfUpdateRecord("Sundial_Solar__c", foundSolar.Id, solarFields);
    } else {
      plan(`create solar twin for "${c.name}"`);
      if (APPLY && customerId) {
        const created = await sfCreateRecord("Sundial_Solar__c", solarFields);
        log(`      created ${created.id}`);
        // Link back, the way Create Project does.
        await sfUpdateRecord("Sundial_Customer__c", customerId, {
          Linked_Solar_Project__c: created.id,
        });
      }
    }
  }

  // 3. Roofing — exists only so the module-deny assertion (§3.1: roofing is denied to
  //    every sales scope) has a record to be denied ON, rather than passing because
  //    the table happened to be empty.
  log(`\n=== ROOFING ===`);
  // Name is an autonumber here too, and Sundial_Customer__c is REQUIRED — so the
  // roofing fixture hangs off the first test customer and is keyed by that parent.
  const roofLabel = "ZZ PORTAL TEST ROOFING";
  const anchor = await findByName("Sundial_Customer__c", TEST_CUSTOMERS[1].name);
  if (!anchor) {
    plan(`SKIP roofing — anchor customer "${TEST_CUSTOMERS[1].name}" not found yet`);
    return;
  }
  const existingRoof = await sfQuery(
    `SELECT Id, Name FROM Sundial_Roofing__c WHERE Sundial_Customer__c = '${soqlEscapeString(anchor.Id)}' LIMIT 1`
  );
  if (existingRoof?.length) {
    plan(`roofing already present: ${existingRoof[0].Id} (${existingRoof[0].Name})`);
  } else {
    plan(`create "${roofLabel}" under ${anchor.Id}`);
    if (APPLY) {
      const created = await sfCreateRecord("Sundial_Roofing__c", {
        Project_Name__c: roofLabel,
        Sundial_Customer__c: anchor.Id,
        Client__c: TENANT_ID,
      });
      log(`      created ${created.id}`);
    }
  }
}

async function main() {
  if (SHOW_PASSWORDS) {
    const p = await loadPasswords();
    if (!p) { log(`No secret "${TEST_USER_SECRET}" yet — run with --apply first.`); return; }
    for (const [k, v] of Object.entries(p)) log(`  ${k.padEnd(48)} ${v}`);
    return;
  }

  log(APPLY ? "\n*** APPLY MODE — this WRITES ***" : "\n--- DRY RUN (pass --apply to write) ---");
  log(`tenant ${TENANT_ID}`);

  const users = await seedUsers();
  if (!USERS_ONLY) await seedRecords(users);

  log(`\n--- next steps ---`);
  log(`  1. TICK Super_Admin__c BY HAND in Salesforce on ${EMAIL("admin")} (D-043: Salesforce-set only).`);
  log(`     Until then the endpoint-level assertion in verify-provisioning-e2e.mjs stays skipped.`);
  log(`  2. node scripts/verify-access-matrix.mjs      # current (TEMP) behaviour`);
  log(`  3. node scripts/probe-cache-reachability.mjs --email ${EMAIL("rep-a1")} --password <from secret>`);
  log(`  TODO(Phase 1): Sundial_Dealer__c does not exist, so no user carries a dealer.`);
  log(`     backfill-dealers.mjs creates the rows; a follow-up pass stamps Dealer__c.\n`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}\n`);
  process.exit(1);
});
