// Phase 0 deliverable D — the access matrix (access-model.md §9).
//
// Logs in as each ZZ TEST user and hits every read surface in §6, printing what the
// server actually answers. It is the instrument the whole migration is measured with:
// Phase 2's shadow gate, Phase 3's enforce gate and Phase 5's action gate all cite
// "the access matrix passes" as their exit condition.
//
// TODAY IT IS A SKELETON, AND DELIBERATELY SO.
//
// Nothing in the new model is built yet — no lib/access.js, no Dealer__c, no module
// gate. So every NEW-model expectation below is marked `pending` and is REPORTED, not
// asserted. Running this today shows the CURRENT (TEMP-guard) behaviour and exits 0.
// It starts failing only when a phase claims to have changed something and has not.
//
// The `pending` list is the specification in executable form: as each phase lands,
// flip its expectations from `pending` to `expect` and the script becomes that
// phase's gate with no other edit.
//
//   THE RULE THIS SCRIPT EXISTS TO KEEP (CLAUDE.md, both repos):
//   Never log in as, re-level, or reassign the records of a REAL user to test
//   visibility. Every credential here comes from Secrets Manager `sundial/test-users`
//   and belongs to a ZZ TEST account created by scripts/seed-access-test-fixtures.mjs.
//
// Usage:
//   node scripts/verify-access-matrix.mjs                # all users, all surfaces
//   node scripts/verify-access-matrix.mjs --user rep-a1  # one user
//   node scripts/verify-access-matrix.mjs --json
//   node scripts/verify-access-matrix.mjs --strict       # fail on a pending mismatch

import { getSecret } from "../lib/secrets.js";
import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";

const JSON_OUT = process.argv.includes("--json");
const STRICT = process.argv.includes("--strict");
const ONLY_USER = (() => {
  const i = process.argv.indexOf("--user");
  return i !== -1 ? process.argv[i + 1] : null;
})();

const API_BASE = (process.env.API_BASE_URL ||
  "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod").replace(/\/+$/, "");
const TENANT_ID = "a1W7y000007AszBEAS";
const TEST_USER_SECRET = "sundial/test-users";
const EMAIL = (slug) => `tim+zz-${slug}@constructiveoperations.com`;

// Access level per §9, so the report can say what each row is supposed to become.
const USERS = [
  { slug: "rep-a1", accessLevel: "Sales Rep", futureScope: "own" },
  { slug: "rep-a2", accessLevel: "Sales Rep", futureScope: "own" },
  { slug: "mgr-a", accessLevel: "Sales Dealer", futureScope: "dealer" },
  { slug: "rep-b1", accessLevel: "Sales Rep", futureScope: "own" },
  { slug: "rep-harmon", accessLevel: "Sales Rep", futureScope: "own" },
  { slug: "rep-nodealer", accessLevel: "Sales Rep", futureScope: "none" },
  { slug: "rep-inactive-dealer", accessLevel: "Sales Rep", futureScope: "none" },
  { slug: "tech", accessLevel: "Technician", futureScope: "none" },
  { slug: "admin", accessLevel: "Admin", futureScope: "tenant" },
  { slug: "exec", accessLevel: "Executive", futureScope: "tenant" },
];

/**
 * The read surfaces of §6.
 *
 * `pending` is what the NEW model must answer, per §3.1 and §6. It is printed beside
 * the live result and compared, but a mismatch is INFORMATIONAL until --strict.
 * `pending` is a function of (user, ctx) so a row can say "200 for tenant scope, 403
 * for a sales role" without duplicating the row.
 */
const SURFACES = [
  {
    key: "auth.me",
    label: "GET /auth/me",
    path: () => "/auth/me",
    pending: () => 200, // everyone authenticated gets their identity, every phase
  },
  {
    key: "customer.list",
    label: "GET /sf/customer",
    path: () => "/sf/customer?limit=5",
    pending: (u) => (u.futureScope === "none" ? 403 : 200),
  },
  {
    key: "customer.single.own",
    label: "GET /sf/customer/{ownRecord}",
    path: (ctx) => (ctx.ownCustomerId ? `/sf/customer/${ctx.ownCustomerId}` : null),
    // The rep's OWN test customer. 200 for its rep and for tenant scope; 404 for a
    // rep it does not belong to (a record you may not see is indistinguishable from
    // one that does not exist, §3.1).
    pending: (u, ctx) =>
      u.futureScope === "tenant" ? 200 : u.futureScope === "none" ? 404 : ctx.ownsRecord ? 200 : 404,
  },
  {
    key: "customer.single.other",
    label: "GET /sf/customer/{otherRepsRecord}",
    path: (ctx) => (ctx.otherCustomerId ? `/sf/customer/${ctx.otherCustomerId}` : null),
    pending: (u) => (u.futureScope === "tenant" ? 200 : 404),
  },
  {
    key: "customer.full",
    label: "GET /sf/customer/{ownRecord}?full=true",
    path: (ctx) => (ctx.ownCustomerId ? `/sf/customer/${ctx.ownCustomerId}?full=true` : null),
    pending: (u, ctx) =>
      u.futureScope === "tenant" ? 200 : u.futureScope === "none" ? 404 : ctx.ownsRecord ? 200 : 404,
  },
  {
    key: "customer.search",
    label: "GET /sf/customer?q=ZZ",
    path: () => "/sf/customer?q=ZZ&limit=5",
    pending: (u) => (u.futureScope === "none" ? 403 : 200),
  },
  {
    key: "solar.list",
    label: "GET /sf/solar",
    path: () => "/sf/solar?limit=5",
    pending: (u) => (u.futureScope === "none" ? 403 : 200),
  },
  {
    key: "roofing.list",
    label: "GET /sf/roofing",
    // §3.1: roofing is denied to EVERY sales scope. Open to everyone today — one of
    // the clearest gaps between the TEMP guard and the designed model.
    path: () => "/sf/roofing?limit=5",
    pending: (u) => (u.futureScope === "tenant" ? 200 : 403),
  },
  {
    key: "po.list",
    label: "GET /sf/po",
    path: () => "/sf/po?limit=5",
    pending: (u) => (u.futureScope === "tenant" ? 200 : 403),
  },
  {
    key: "users.list",
    label: "GET /sf/user",
    // §3.5: dealer/own see their own dealer's people plus Harmon staff; `none` is 403.
    path: () => "/sf/user?limit=5",
    pending: (u) => (u.futureScope === "none" ? 403 : 200),
  },
  {
    key: "files.customer.list",
    label: "GET /files/by-record/{ownRecord}",
    // The route requires an explicit ?object= (fail-closed allowlist in lib/file-access.js).
    path: (ctx) => (ctx.ownCustomerId ? `/files/by-record/${ctx.ownCustomerId}?object=customer` : null),
    pending: (u, ctx) =>
      u.futureScope === "tenant" ? 200 : u.futureScope === "none" ? 404 : ctx.ownsRecord ? 200 : 404,
  },
  {
    key: "files.solar.list",
    label: "GET /files/by-record/{solarTwin}",
    // §3.6: Solar files are denied to sales roles on all four routes.
    path: (ctx) => (ctx.ownSolarId ? `/files/by-record/${ctx.ownSolarId}?object=solar` : null),
    pending: (u) => (u.futureScope === "tenant" ? 200 : 403),
  },
];

// --- plumbing ----------------------------------------------------------------
async function loadCredentials() {
  const secret = await getSecret(TEST_USER_SECRET).catch(() => null);
  if (!secret) {
    console.error(
      `No secret "${TEST_USER_SECRET}". Run: node scripts/seed-access-test-fixtures.mjs --apply`
    );
    process.exit(2);
  }
  return secret;
}

async function loadSupabaseConfig() {
  // The publishable key + URL, the same pair the browser uses to sign in.
  const { readFileSync, existsSync } = await import("node:fs");
  let url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  let key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const envPath = new URL("../../harmon-crm/.env.local", import.meta.url).pathname.replace(/^\//, "");
  if ((!url || !key) && existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      if (m[1] === "VITE_SUPABASE_URL") url = url || m[2].replace(/^["']|["']$/g, "");
      if (m[1] === "VITE_SUPABASE_ANON_KEY") key = key || m[2].replace(/^["']|["']$/g, "");
    }
  }
  if (!url || !key) {
    console.error("Could not resolve the Supabase URL/anon key (env or ../harmon-crm/.env.local).");
    process.exit(2);
  }
  return { url: url.replace(/\/+$/, ""), key };
}

async function login(cfg, email, password) {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: cfg.key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    return { ok: false, error: `${res.status} ${body.error_description || body.msg || "login failed"}` };
  }
  return { ok: true, token: body.access_token };
}

async function call(token, path) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    let count = null;
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      count = Array.isArray(j?.records) ? j.records.length
        : Array.isArray(j?.files) ? j.files.length
        : Array.isArray(j) ? j.length : null;
      if (typeof j?.total === "number") count = `${count ?? "?"}/${j.total}`;
    } catch { /* non-JSON body */ }
    return { status: res.status, count };
  } catch (err) {
    return { status: null, count: null, error: err.message };
  }
}

// The fixture ids, resolved live so the script survives a re-seed.
async function loadFixtureIds() {
  const rows = await sfQuery(
    `SELECT Id, Name, Sales_Rep__c, Linked_Solar_Project__c FROM Sundial_Customer__c ` +
      `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND Name LIKE 'ZZ PORTAL TEST%'`
  );
  const users = await sfQuery(
    `SELECT Id, Email__c FROM Sundial_User__c WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' ` +
      `AND Email__c LIKE 'tim+zz-%'`
  );
  const userIdByEmail = new Map(users.map((u) => [u.Email__c?.toLowerCase(), u.Id]));
  return { customers: rows, userIdByEmail };
}

async function main() {
  const [passwords, cfg, fixtures] = await Promise.all([
    loadCredentials(),
    loadSupabaseConfig(),
    loadFixtureIds(),
  ]);

  const targets = ONLY_USER ? USERS.filter((u) => u.slug === ONLY_USER) : USERS;
  const report = { generatedAt: new Date().toISOString(), apiBase: API_BASE, rows: [] };
  let pendingMismatches = 0;

  for (const u of targets) {
    const email = EMAIL(u.slug);
    const sfUserId = fixtures.userIdByEmail.get(email.toLowerCase()) ?? null;

    // This user's own test customer, and someone else's, so the matrix can show the
    // own-vs-other distinction that is the entire point of `own` scope.
    const own = fixtures.customers.find((c) => c.Sales_Rep__c && c.Sales_Rep__c === sfUserId) ?? null;
    const other = fixtures.customers.find((c) => c.Sales_Rep__c && c.Sales_Rep__c !== sfUserId) ?? null;
    const ctx = {
      ownCustomerId: own?.Id ?? fixtures.customers[0]?.Id ?? null,
      otherCustomerId: other?.Id ?? null,
      ownSolarId: own?.Linked_Solar_Project__c ?? fixtures.customers[0]?.Linked_Solar_Project__c ?? null,
      ownsRecord: Boolean(own),
    };

    const pw = passwords[email];
    if (!pw) {
      report.rows.push({ user: u.slug, login: "NO PASSWORD IN SECRET", surfaces: [] });
      continue;
    }
    const auth = await login(cfg, email, pw);
    if (!auth.ok) {
      report.rows.push({ user: u.slug, login: auth.error, surfaces: [] });
      continue;
    }

    const surfaces = [];
    for (const s of SURFACES) {
      const path = s.path(ctx);
      if (!path) {
        surfaces.push({ key: s.key, label: s.label, status: null, note: "no fixture id" });
        continue;
      }
      const r = await call(auth.token, path);
      const expected = s.pending(u, ctx);
      const matches = r.status === expected;
      if (!matches) pendingMismatches++;
      surfaces.push({
        key: s.key, label: s.label, path,
        status: r.status, count: r.count,
        pendingExpectation: expected, matchesPending: matches,
      });
    }
    report.rows.push({ user: u.slug, accessLevel: u.accessLevel, futureScope: u.futureScope,
      sfUserId, login: "ok", ownsRecord: ctx.ownsRecord, surfaces });
  }

  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log(`\nACCESS MATRIX — current behaviour vs the model in access-model.md §6`);
  console.log(`  api      : ${API_BASE}`);
  console.log(`  generated: ${report.generatedAt}`);
  console.log(`\n  "now" is what the server answers TODAY (TEMP guard + tenant scope).`);
  console.log(`  "then" is what §3.1/§6 require once the model is built. Differences are`);
  console.log(`  EXPECTED right now -- nothing in the new model is implemented yet.\n`);

  for (const row of report.rows) {
    if (row.login !== "ok") {
      console.log(`  ${row.user.padEnd(20)} LOGIN FAILED: ${row.login}`);
      continue;
    }
    console.log(`  ${row.user}  (${row.accessLevel} -> future scope "${row.futureScope}")` +
      `${row.ownsRecord ? "" : "   [no own record assigned]"}`);
    for (const s of row.surfaces) {
      if (s.status === null) {
        console.log(`      ${s.label.padEnd(42)} skipped (${s.note})`);
        continue;
      }
      const flag = s.matchesPending ? "  " : "!=";
      console.log(
        `      ${s.label.padEnd(42)} now ${String(s.status).padEnd(4)}` +
          `${s.count !== null ? `(${s.count})`.padEnd(10) : "".padEnd(10)} ${flag} then ${s.pendingExpectation}`
      );
    }
    console.log();
  }

  console.log(`  ${pendingMismatches} surface(s) differ from the NEW-model expectation.`);
  console.log(`  These are PENDING, not failures: the model is not built. Phase gates flip`);
  console.log(`  each row from pending to asserted as they land (see the file header).`);
  if (STRICT && pendingMismatches > 0) {
    console.log(`\n  --strict: exiting non-zero on ${pendingMismatches} pending mismatch(es).`);
    process.exit(1);
  }
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
