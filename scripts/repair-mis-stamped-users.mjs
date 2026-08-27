// D-064 amendment A6 — repair users mis-stamped Hierarchy_Level__c = "Sales Rep".
//
//   node scripts/repair-mis-stamped-users.mjs           # REPORT ONLY. Default.
//   node scripts/repair-mis-stamped-users.mjs --apply   # writes
//
// THE BUG BEING REPAIRED
//
// Until 2026-08-27, sundial-user-admin stamped DEFAULT_HIERARCHY_LEVEL = "Sales Rep" on
// every user it created, whatever access level the admin picked. The TEMP guard in
// sundial-sf-query keys on exactly that string and restricts the caller to one hardcoded
// rep's records -- so a user created through Manage Users and not hand-corrected in
// Salesforce afterwards has been served DENNIS'S book of business instead of their own
// view. A NARROWING, not a leak, which is why it surfaced as "why can this person not
// see anything" rather than as an incident.
//
// The endpoint was fixed in Phase 0 (derive on create AND on accessLevel PATCH). This
// script repairs the users created BEFORE that fix.
//
// ---------------------------------------------------------------------------
// IT REPAIRS THROUGH THE ENDPOINT, NOT BY WRITING THE FIELD
// ---------------------------------------------------------------------------
// For each affected user it PATCHes their CURRENT accessLevel -- the value they already
// have -- back through the live /admin/users endpoint, which re-derives
// Hierarchy_Level__c server-side and writes both fields in one patch.
//
// Writing Hierarchy_Level__c directly would be one line and would fix the data. It would
// also leave the derivation untested against the live picklist, which is the exact
// failure Phase 0 built an e2e assertion for: Hierarchy_Level__c is a RESTRICTED
// picklist, so a derived value it does not contain fails at the INSERT with
// INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST -- a failure that lives outside any unit test
// and only appears when a real record is written. Going through the endpoint means this
// repair exercises the same path Manage Users will use forever after.
//
// It also means the repair cannot drift from the endpoint: if deriveHierarchyLevel
// changes, this script produces the new value automatically, because it never knew the
// old one.
//
// ---------------------------------------------------------------------------
// WHO IS IN SCOPE, AND WHO IS DELIBERATELY NOT
// ---------------------------------------------------------------------------
// IN:  active users where Hierarchy_Level__c === "Sales Rep" AND Access_Level__c is
//      something else. These are being wrongly restricted RIGHT NOW.
//
// OUT: Dennis Alessandro, by id. Explicitly, not incidentally -- he is the one live user
//      the guard is supposed to restrict, and he would be excluded by the rule below
//      anyway. Belt and braces on the one account where a mistake is expensive.
//
// OUT: anyone whose Access_Level__c IS "Sales Rep". Their hierarchy is correct.
//
// OUT: the 13 users the Phase 0 audit calls "derivation differs". They store
//      Manager/Client -- values the old default never wrote -- so they were never
//      mis-stamped. PATCHing them would rewrite Manager -> Client for no behavioural
//      gain, because nothing reads Hierarchy_Level__c except the guard and the guard
//      only cares about one value. They are REPORTED here so the distinction is visible,
//      and never touched.
//
// OUT: inactive users. The audit was scoped to active users and so is this: an inactive
//      user cannot log in (resolveIdentity refuses them before any guard runs), so
//      nothing about their hierarchy has any effect. 59 of them carry the string; none
//      of them is affected by it.

import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";
import { getSecret } from "../lib/secrets.js";
import { EMAIL } from "./seed-access-test-fixtures.mjs";

const APPLY = process.argv.includes("--apply");
const TENANT_ID = "a1W7y000007AszBEAS";
const DENNIS_ID = "a1O7y00000s5sK1EAI";
const TEMP_GUARD_VALUE = "Sales Rep";
const API_BASE = (process.env.API_BASE_URL ||
  "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod").replace(/\/+$/, "");
const ZZ_ADMIN_EMAIL = EMAIL("admin");
const SUPABASE_URL_DEFAULT = "https://qfsdpkwxahakegjnyijj.supabase.co";

const log = (...a) => console.log(...a);
const rule = (c = "=") => log(c.repeat(94));

rule();
log("REPAIR MIS-STAMPED USERS (D-064 A6)");
rule();
log(`  tenant ${TENANT_ID}`);
log(`  mode   ${APPLY ? "APPLY (this PATCHes through the live endpoint)" : "REPORT ONLY (pass --apply to write)"}`);
log(`  api    ${API_BASE}`);

const users = await sfQuery(
  `SELECT Id, First_Name__c, Last_Name__c, Email__c, Access_Level__c, Hierarchy_Level__c, ` +
    `Super_Admin__c, Active__c FROM Sundial_User__c ` +
    `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND Active__c = true`
);

const nameOf = (u) => `${u.First_Name__c ?? ""} ${u.Last_Name__c ?? ""}`.trim() || u.Email__c || u.Id;

// The repair set: wrongly restricted RIGHT NOW.
const misStamped = users.filter(
  (u) =>
    u.Hierarchy_Level__c === TEMP_GUARD_VALUE &&
    u.Access_Level__c !== TEMP_GUARD_VALUE &&
    u.Id !== DENNIS_ID
);

// Correctly stamped reps — the guard is doing what it is supposed to for them.
const correctlyRestricted = users.filter(
  (u) => u.Hierarchy_Level__c === TEMP_GUARD_VALUE && u.Access_Level__c === TEMP_GUARD_VALUE
);

// The "derivation differs" set: stored hierarchy is not what the endpoint would derive,
// but it is not the guard's key either, so it changes nothing.
const DERIVED = { "Sales Rep": "Sales Rep", "Sales Dealer": "Sales Manager" };
const derivationDiffers = users.filter(
  (u) =>
    u.Hierarchy_Level__c !== TEMP_GUARD_VALUE &&
    u.Hierarchy_Level__c !== (DERIVED[u.Access_Level__c] ?? "Client")
);

rule("-");
log(`WRONGLY RESTRICTED TODAY — ${misStamped.length} user(s). THIS IS THE REPAIR SET.`);
rule("-");
log(
  "  Hierarchy_Level__c is \"Sales Rep\" while Access_Level__c is not. The TEMP guard keys\n" +
    "  on that exact string, so these users are being served Dennis's records right now,\n" +
    "  whatever their real role.\n"
);
if (misStamped.length === 0) {
  log("  none.");
} else {
  log(`  ${"user".padEnd(26)} ${"email".padEnd(38)} ${"Access_Level__c".padEnd(15)} ${"stored".padEnd(11)} -> will become`);
  for (const u of misStamped) {
    const derived = DERIVED[u.Access_Level__c] ?? "Client";
    log(
      `  ${nameOf(u).slice(0, 25).padEnd(26)} ${String(u.Email__c ?? "").slice(0, 37).padEnd(38)} ` +
        `${String(u.Access_Level__c ?? "(blank)").padEnd(15)} ${String(u.Hierarchy_Level__c).padEnd(11)} -> ${derived}`
    );
  }
  log(
    `\n  Effect of the repair: each stops being restricted to Dennis's records and gets the\n` +
      `  view their real access level implies. That is a WIDENING relative to today — and the\n` +
      `  correct one, because the narrowing was a bug. It is the same +31,821 the shadow\n` +
      `  report classifies as EXPECTED for these users.`
  );
}

rule("-");
log(`CORRECTLY RESTRICTED — ${correctlyRestricted.length} user(s). NOT TOUCHED.`);
rule("-");
for (const u of correctlyRestricted) {
  const isDennis = u.Id === DENNIS_ID;
  log(
    `  ${nameOf(u).slice(0, 25).padEnd(26)} ${String(u.Access_Level__c).padEnd(15)} ` +
      `${u.Hierarchy_Level__c}${isDennis ? "   <- Dennis, excluded by id AND by the rule" : ""}`
  );
}

rule("-");
log(`DERIVATION DIFFERS — ${derivationDiffers.length} user(s). NOT TOUCHED, DELIBERATELY.`);
rule("-");
log(
  "  Their stored hierarchy is not what the endpoint would derive, but it is not the\n" +
    "  guard's key either, so it has NO effect on what they see. PATCHing them would\n" +
    "  rewrite Manager -> Client for no behavioural gain. Listed so the distinction between\n" +
    "  'wrongly restricted' and 'merely inconsistent' stays visible.\n"
);
log(`  ${"user".padEnd(26)} ${"Access_Level__c".padEnd(15)} ${"stored".padEnd(11)} would derive`);
for (const u of derivationDiffers) {
  log(
    `  ${nameOf(u).slice(0, 25).padEnd(26)} ${String(u.Access_Level__c ?? "(blank)").padEnd(15)} ` +
      `${String(u.Hierarchy_Level__c ?? "-").padEnd(11)} ${DERIVED[u.Access_Level__c] ?? "Client"}`
  );
}

rule();
log(APPLY ? "APPLYING" : "REPORT ONLY — nothing written (pass --apply)");
log(`  ${misStamped.length} user(s) to PATCH through ${API_BASE}/admin/users/{id}`);
rule();

if (!APPLY) {
  log("\n  Review the repair set above, then re-run with --apply.\n");
  process.exit(0);
}
if (misStamped.length === 0) {
  log("\n  nothing to do.\n");
  process.exit(0);
}

// --- log in as the ZZ super admin -------------------------------------------
// CLAUDE.md: never a live account. Harmon's real super admins are working accounts, and
// logging in as one to run a repair is the exact thing that rule forbids.
const passwords = await getSecret("sundial/test-users");
const anonKey =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || null;
const supabaseUrl = process.env.SUPABASE_URL || SUPABASE_URL_DEFAULT;
if (!anonKey) {
  log("\n  ** SUPABASE_ANON_KEY not set. Export it (it is a publishable key) and re-run. **\n");
  process.exit(2);
}
const tokenResp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: anonKey, "Content-Type": "application/json" },
  body: JSON.stringify({ email: ZZ_ADMIN_EMAIL, password: passwords[ZZ_ADMIN_EMAIL] }),
});
const token = (await tokenResp.json())?.access_token;
if (!token) {
  log(`\n  ** could not log in as ${ZZ_ADMIN_EMAIL} (HTTP ${tokenResp.status}). **\n`);
  process.exit(1);
}
log(`\n  authenticated as ${ZZ_ADMIN_EMAIL} (ZZ TEST super admin, never a live account)`);

// --- CANARY: one user, then re-read from Salesforce -------------------------
// The PATCH goes through the endpoint, so what has to be verified is not "did the write
// land" but "did the SERVER derive the right value" -- and that can only be read back
// from Salesforce, never from the endpoint's own response body. Asserting on the
// response would test the response.
async function patchUser(u) {
  const resp = await fetch(`${API_BASE}/admin/users/${u.Id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    // The user's CURRENT level, unchanged. The only reason to send it is that
    // handleUpdate re-derives Hierarchy_Level__c whenever accessLevel is present.
    body: JSON.stringify({ accessLevel: u.Access_Level__c }),
  });
  const body = await resp.json().catch(() => ({}));
  return { status: resp.status, body };
}

async function readBack(id) {
  const [r] = await sfQuery(
    `SELECT Id, Access_Level__c, Hierarchy_Level__c, Active__c, Super_Admin__c, Email__c ` +
      `FROM Sundial_User__c WHERE Id = '${soqlEscapeString(id)}'`
  );
  return r ?? null;
}

const failures = [];
let applied = 0;

for (const [i, u] of misStamped.entries()) {
  const expected = DERIVED[u.Access_Level__c] ?? "Client";
  const isCanary = i === 0;
  if (isCanary) log(`\n  CANARY — ${nameOf(u)} (${u.Id}) alone first`);

  const before = await readBack(u.Id);
  const res = await patchUser(u);
  if (res.status !== 200) {
    const msg = `HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`;
    failures.push({ name: nameOf(u), id: u.Id, error: msg });
    log(`     ** PATCH FAILED: ${msg} **`);
    if (isCanary) {
      log(`\n  Stopping after the canary. The other ${misStamped.length - 1} are untouched.\n`);
      process.exit(1);
    }
    continue;
  }

  const after = await readBack(u.Id);
  // The value the SERVER derived, read from Salesforce.
  const ok = after?.Hierarchy_Level__c === expected;
  // Nothing else may move. Access_Level__c must be what we sent (i.e. unchanged), and
  // Active__c / Super_Admin__c must be untouched -- this endpoint can ban a user and can
  // refuse a super-admin-with-sales-role, so both are worth asserting rather than assuming.
  const sideEffects = [];
  if (after?.Access_Level__c !== before?.Access_Level__c) {
    sideEffects.push(`Access_Level__c ${before?.Access_Level__c} -> ${after?.Access_Level__c}`);
  }
  if (after?.Active__c !== before?.Active__c) {
    sideEffects.push(`Active__c ${before?.Active__c} -> ${after?.Active__c}`);
  }
  if (after?.Super_Admin__c !== before?.Super_Admin__c) {
    sideEffects.push(`Super_Admin__c ${before?.Super_Admin__c} -> ${after?.Super_Admin__c}`);
  }

  log(
    `     ${ok && sideEffects.length === 0 ? "OK  " : "** "} ${nameOf(u).padEnd(24)} ` +
      `Hierarchy_Level__c ${JSON.stringify(before?.Hierarchy_Level__c)} -> ${JSON.stringify(after?.Hierarchy_Level__c)} (expected ${JSON.stringify(expected)})`
  );
  for (const s of sideEffects) log(`         ** UNEXPECTED SIDE EFFECT: ${s} **`);

  if (!ok || sideEffects.length > 0) {
    failures.push({
      name: nameOf(u),
      id: u.Id,
      error: !ok ? `derived ${after?.Hierarchy_Level__c}, expected ${expected}` : sideEffects.join("; "),
    });
    if (isCanary) {
      log(`\n  Stopping after the canary. The other ${misStamped.length - 1} are untouched.\n`);
      process.exit(1);
    }
    continue;
  }
  applied++;
  if (isCanary) log(`     -> the server derived the right value and nothing else moved. Proceeding.`);
}

log(`\n  ${applied} of ${misStamped.length} user(s) repaired.`);
if (failures.length) {
  log(`\n  ** ${failures.length} FAILURE(S) **`);
  for (const f of failures) log(`     ${f.name} (${f.id}): ${f.error}`);
  log(`\n  This script is IDEMPOTENT — it re-reads the org and selects only users still`);
  log(`  carrying the wrong value. Re-running is the correct recovery.`);
  process.exitCode = 1;
} else {
  log(`\n  Re-run scripts/access-shadow-report.mjs — the repaired users should drop out of`);
  log(`  the WIDENINGS list, because the guard is no longer wrongly narrowing them.\n`);
}
