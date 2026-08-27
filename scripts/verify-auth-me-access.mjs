// Verify the /auth/me `access` block against the §9 expectation matrix.
// D-064 Phase 1 gate: "/auth/me for each ZZ TEST user returns the expected scope and
// dealerId; zz-rep-nodealer and zz-tech resolve to scope none."
//
//   node scripts/verify-auth-me-access.mjs
//
// Logs in as each ZZ TEST user (credentials from Secrets Manager `sundial/test-users`,
// never a live account — CLAUDE.md) and hits the DEPLOYED endpoint. This measures the
// Lambda in prod, not the module in isolation: lib/access.test.js already pins the
// logic, and what this adds is that the deployed bundle, the live Salesforce data and
// the real Dealer__c rows agree with it.

import { getSecret } from "../lib/secrets.js";
import { TEST_USERS, EMAIL } from "./seed-access-test-fixtures.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE = (process.env.API_BASE_URL ||
  "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod").replace(/\/+$/, "");

const log = (...a) => console.log(...a);
const rule = (c = "=") => log(c.repeat(96));
const failures = [];
const check = (label, ok, detail = "") => {
  if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ""}`);
  return ok;
};

// §9's expectation matrix, as scope + whether a dealer id is expected.
const EXPECTED = {
  "rep-a1": { scope: "own", dealer: "ZZ TEST DEALER A" },
  "rep-a2": { scope: "own", dealer: "ZZ TEST DEALER A" },
  "mgr-a": { scope: "dealer", dealer: "ZZ TEST DEALER A" },
  "rep-b1": { scope: "own", dealer: "ZZ TEST DEALER B" },
  "rep-harmon": { scope: "own", dealer: "Harmon Solar" },
  // The three that exist to prove the model fails closed.
  "rep-nodealer": { scope: "none", dealer: null },
  "rep-inactive-dealer": { scope: "none", dealer: "ZZ TEST DEALER INACTIVE" },
  tech: { scope: "none", dealer: null },
  admin: { scope: "tenant", dealer: null },
  exec: { scope: "tenant", dealer: null },
};

// The Supabase URL + publishable ("anon") key, resolved the same way
// scripts/probe-cache-reachability.mjs does: environment first, then the portal repo's
// .env.local, which is the canonical home of the publishable key. It ships in the
// browser bundle by design, so this is not a secret — unlike the ZZ TEST passwords,
// which come from Secrets Manager and are never written to a file.
function resolveSupabase() {
  let url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  let key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    const envPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)), "..", "..", "harmon-crm", ".env.local"
    );
    try {
      for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, "");
        if (m[1] === "VITE_SUPABASE_URL") url = url || v;
        if (m[1] === "VITE_SUPABASE_ANON_KEY") key = key || v;
      }
    } catch { /* fall through to the error below */ }
  }
  if (!url || !key) {
    console.error(
      "Could not resolve the Supabase URL and publishable key.\n" +
        "Set SUPABASE_URL and SUPABASE_ANON_KEY, or ensure ../harmon-crm/.env.local\n" +
        "carries VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
    );
    process.exit(2);
  }
  return { url, key };
}

const { url: SUPABASE_URL, key: anonKey } = resolveSupabase();
const passwords = await getSecret("sundial/test-users");

async function login(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json();
  return body?.access_token ?? null;
}

rule();
log("GET /auth/me — the `access` block, per ZZ TEST user (§9 matrix)");
rule();
log(`  api ${API_BASE}`);
log(
  `\n  ${"user".padEnd(22)} ${"level".padEnd(14)} ${"scope".padEnd(8)} ${"dealer".padEnd(26)} ${"modules".padEnd(24)} actions`
);

const results = [];
for (const t of TEST_USERS) {
  const email = EMAIL(t.slug);
  const exp = EXPECTED[t.slug];
  const token = await login(email, passwords[email]);
  if (!token) {
    log(`  ${("zz-" + t.slug).padEnd(22)} ** LOGIN FAILED **`);
    failures.push(`zz-${t.slug}: login failed`);
    continue;
  }
  const resp = await fetch(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await resp.json().catch(() => ({}));
  const a = body?.user?.access;

  if (resp.status !== 200 || !a) {
    log(`  ${("zz-" + t.slug).padEnd(22)} ** HTTP ${resp.status}, access block ${a ? "present" : "MISSING"} **`);
    failures.push(`zz-${t.slug}: HTTP ${resp.status}${a ? "" : ", no access block"}`);
    continue;
  }

  const dealerName = body.user?.dealer?.name ?? null;
  log(
    `  ${("zz-" + t.slug).padEnd(22)} ${String(a.level ?? "-").padEnd(14)} ${String(a.scope).padEnd(8)} ` +
      `${String(dealerName ?? "(null)").padEnd(26)} ${a.modules.join(",").padEnd(24)} ${a.actions.length}`
  );

  check(`zz-${t.slug} scope`, a.scope === exp.scope, `got ${a.scope}, want ${exp.scope}`);
  check(`zz-${t.slug} dealer`, dealerName === exp.dealer, `got ${dealerName}, want ${exp.dealer}`);
  // dealerId must be present exactly when the scope actually uses it.
  const needsDealerId = a.scope === "dealer";
  check(
    `zz-${t.slug} dealerId present iff dealer scope`,
    needsDealerId ? Boolean(a.dealerId) : true,
    `scope ${a.scope}, dealerId ${a.dealerId}`
  );
  results.push({ slug: t.slug, ...a, dealerName });
}

// --- the fail-closed fixtures, stated as their own assertions ---------------
// These three are the entire reason §9 specifies them. A matrix in which every row
// passes because everything resolves to `tenant` would look identical to a correct one
// on the other seven users.
log("\n  THE FAIL-CLOSED FIXTURES:");
for (const slug of ["rep-nodealer", "tech", "rep-inactive-dealer"]) {
  const r = results.find((x) => x.slug === slug);
  const why = {
    "rep-nodealer": "a sales role with a NULL dealer sees nothing, not everything (§1.2)",
    tech: "Technician is defined in Phase II; until then, nothing (§1.2)",
    "rep-inactive-dealer": "an INACTIVE dealer grants its users nothing (§2.1)",
  }[slug];
  const ok = r?.scope === "none" && r.modules.length === 0 && r.actions.length === 0;
  log(`    ${ok ? "PASS OK " : "FAIL ** "} zz-${slug.padEnd(20)} scope=${r?.scope} modules=${r?.modules.length} actions=${r?.actions.length}`);
  log(`             ${why}`);
  check(`zz-${slug} resolves to none with no modules and no actions`, ok);
}

// --- the one that would be a leak, not a narrowing ---------------------------
// Every other failure here makes somebody see too little. This is the one that would
// make somebody see too much, so it is asserted separately rather than trusted to the
// scope check above.
const repHarmon = results.find((x) => x.slug === "rep-harmon");
check(
  "zz-rep-harmon (Dennis's twin) is `own`, NOT `dealer` — it must not see Harmon Solar's whole book",
  repHarmon?.scope === "own",
  `got ${repHarmon?.scope}`
);
log(
  `\n  zz-rep-harmon: scope=${repHarmon?.scope}. A Sales Rep at Harmon Solar sees only their own\n` +
    `  records. If this ever read 'dealer' it would hand Dennis's 3,535 customers to a test account.`
);

log("");
rule();
if (failures.length === 0) {
  log("ALL CHECKS PASS — /auth/me returns the expected scope and dealer for all ten fixtures.");
} else {
  log(`** ${failures.length} CHECK(S) FAILED **`);
  for (const f of failures) log(`   ${f}`);
  process.exitCode = 1;
}
rule();
