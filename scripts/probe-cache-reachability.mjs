// Probes what a BROWSER can actually reach over PostgREST — empirically.
//
// WHY THIS EXISTS ALONGSIDE sql/snapshot-supabase.sql
//
// The catalog snapshot tells you what the policies and grants SAY. This script
// tells you what the API actually DOES. They can disagree, and when they do the
// API is the one that matters: PostgREST will not route a schema that is not in
// `db_schemas` no matter how permissive its grants are, and conversely a table
// with RLS disabled and a stale SELECT grant is readable by anyone holding the
// publishable key regardless of what anybody intended.
//
// access-model.md §3.3 asks one question this script answers directly:
//
//     "Phase 0 verifies whether PostgREST exposes [the cache tables] to
//      `authenticated`; if it does, RLS is enabled with no policies plus revoke."
//
// STRICTLY READ-ONLY. Every request is a GET with `limit=1`. Nothing is written.
//
// THE TWO HALVES OF THE ANSWER
//
//   anon          — runnable today. Uses the publishable key alone, i.e. exactly
//                   what a logged-OUT browser (or anyone who read the JS bundle)
//                   can do.
//   authenticated — needs a real logged-in session. The access-model test users do
//                   not exist until Phase 0 deliverable D, so until then this half
//                   reports SKIPPED rather than guessing. Do NOT substitute a live
//                   user's credentials to fill it in — CLAUDE.md forbids exactly
//                   that, and a ZZ TEST user answers the same question.
//
// Usage:
//   node scripts/probe-cache-reachability.mjs
//   node scripts/probe-cache-reachability.mjs --email zz-rep-a1@... --password ...
//   node scripts/probe-cache-reachability.mjs --json > out.json
//
// Credentials, in precedence order:
//   SUPABASE_URL / SUPABASE_ANON_KEY from the environment, else
//   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from ../harmon-crm/.env.local
// The anon key is a PUBLISHABLE key — it ships in the browser bundle by design.
// It is read at runtime and never written to any file this repo commits.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const JSON_OUT = process.argv.includes("--json");
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

// The tables Phase 0 cares about.
const ALWAYS_PROBE = ["profiles", "comments", "comment_mentions", "user_preferences"];

// The cache tables, as the code knows them (the `cacheTable` registry in
// sundial-sf-query and sundial-cache-sync). Discovery from the OpenAPI spec is
// attempted too and the two are UNIONed — but the spec request needs a privileged
// key on this project and answers 401 to the publishable one, so discovery alone
// would silently probe nothing. A hardcoded list that is wrong shows up as a 404;
// a discovery that returns nothing looks like success. Prefer the loud failure.
const KNOWN_CACHE_TABLES = [
  "sundial_customer_cache",
  "sundial_solar_cache",
  "sundial_roofing_cache",
  "sundial_po_cache",
  "sundial_user_cache",
];

function loadEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function resolveCredentials() {
  let url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  let key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  let from = "environment";
  if (!url || !key) {
    // The portal repo is the canonical home of the publishable key.
    const envPath = join(REPO, "..", "harmon-crm", ".env.local");
    const env = loadEnvFile(envPath);
    url = url || env.VITE_SUPABASE_URL;
    key = key || env.VITE_SUPABASE_ANON_KEY;
    from = envPath;
  }
  if (!url || !key) {
    console.error(
      "Could not resolve the Supabase URL and anon key.\n" +
        "Set SUPABASE_URL and SUPABASE_ANON_KEY, or ensure ../harmon-crm/.env.local carries\n" +
        "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
    );
    process.exit(2);
  }
  return { url: url.replace(/\/+$/, ""), key, from };
}

// The service role bypasses RLS, so an exact count through it is the TRUE row
// count. That number is what disambiguates the probe: anon seeing 0 rows in a
// table that genuinely holds 31,948 is a denial; anon seeing 0 rows in a table
// that holds 0 proves nothing at all. Without this baseline every empty result
// reads as "safe" and a real hole in an empty table would pass unnoticed.
async function trueRowCount(base, table, serviceKey) {
  try {
    const res = await fetch(`${base}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: "count=exact",
        Range: "0-0",
      },
    });
    // PostgREST reports the count in Content-Range as "0-0/<total>".
    const cr = res.headers.get("content-range");
    const total = cr && cr.includes("/") ? cr.split("/")[1] : null;
    if (!res.ok) return { count: null, note: `service-role read returned ${res.status}` };
    return { count: total === "*" ? null : Number(total), note: null };
  } catch (err) {
    return { count: null, note: err.message };
  }
}

// One GET, limit=1. Returns how PostgREST answered and what that MEANS, because
// the status code alone is ambiguous: 200 with zero rows is the RLS-denies-you
// answer, and it looks nothing like the 401/404 people expect.
async function probeTable(base, table, apikey, bearer) {
  const url = `${base}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`;
  const headers = { apikey, Authorization: `Bearer ${bearer}` };
  let res, bodyText;
  try {
    res = await fetch(url, { headers });
    bodyText = await res.text();
  } catch (err) {
    return { table, status: null, reachable: null, verdict: `REQUEST FAILED: ${err.message}` };
  }

  let rows = null;
  try {
    const parsed = JSON.parse(bodyText);
    if (Array.isArray(parsed)) rows = parsed.length;
  } catch {
    /* not JSON — leave rows null and let the verdict fall through to the raw status */
  }

  // The interpretation table. `reachable` means "this session got DATA back",
  // which is the only thing that matters for the §3.3 decision.
  let verdict;
  let reachable;
  if (res.status === 200 && rows !== null && rows > 0) {
    verdict = "READABLE — returned a row";
    reachable = true;
  } else if (res.status === 200 && rows === 0) {
    // 200 means the ROUTE resolved and a SELECT grant exists — a missing grant
    // answers 401, a missing route 404. So zero rows here is the database
    // filtering, not the API refusing. `truth` (the service-role count) says
    // whether there was anything to filter.
    verdict = "ROUTABLE, 0 rows returned — grant exists, rows filtered (see baseline)";
    reachable = false;
  } else if (res.status === 401 || res.status === 403) {
    verdict = "DENIED — not authorized";
    reachable = false;
  } else if (res.status === 404) {
    verdict = "not exposed — no such route (schema not in db_schemas, or no grant)";
    reachable = false;
  } else {
    verdict = `unexpected ${res.status}: ${bodyText.slice(0, 200)}`;
    reachable = null;
  }
  return { table, status: res.status, rows, reachable, verdict };
}

// PostgREST's OpenAPI root lists every table it routes for the calling role.
// This is the direct answer to "which schemas/tables does PostgREST expose".
async function fetchExposedTables(base, apikey) {
  try {
    const res = await fetch(`${base}/rest/v1/`, {
      headers: {
        apikey,
        Authorization: `Bearer ${apikey}`,
        Accept: "application/openapi+json",
      },
    });
    if (!res.ok) return { ok: false, note: `spec request returned ${res.status}`, tables: [] };
    const spec = await res.json();
    const tables = Object.keys(spec.definitions || {}).sort();
    return { ok: true, tables, info: spec.info?.title || null };
  } catch (err) {
    return { ok: false, note: err.message, tables: [] };
  }
}

async function main() {
  const { url, key, from } = resolveCredentials();
  const email = argOf("--email");
  const password = argOf("--password");

  const report = {
    generatedAt: new Date().toISOString(),
    supabaseUrl: url,
    credentialSource: from,
    anon: { probes: [] },
    authenticated: { status: "SKIPPED", probes: [] },
  };

  // --- What does PostgREST route at all? ------------------------------------
  const exposed = await fetchExposedTables(url, key);
  report.exposedTables = exposed.tables;
  report.exposedTablesNote = exposed.ok ? null : exposed.note;

  const discoveredCache = exposed.tables.filter((t) => /^sundial_.*_cache$/.test(t));
  const cacheTables = [...new Set([...KNOWN_CACHE_TABLES, ...discoveredCache])].sort();
  const targets = [...new Set([...ALWAYS_PROBE, ...cacheTables])];
  report.probedTables = targets;
  report.cacheTablesDiscovered = discoveredCache;
  report.cacheTablesProbed = cacheTables;

  // --- baseline: the true row counts, via the service role (bypasses RLS) ----
  // Read from Secrets Manager, never from a file. Optional: if the secret is not
  // reachable the probe still runs, it just cannot disambiguate a 0-row answer.
  report.baseline = {};
  try {
    const { getSecret } = await import("../lib/secrets.js");
    const secret = await getSecret("sundial/supabase/service-role");
    const serviceKey = secret.service_role_key;
    for (const t of targets) {
      report.baseline[t] = await trueRowCount(url, t, serviceKey);
    }
    report.baselineSource = "Secrets Manager sundial/supabase/service-role";
  } catch (err) {
    report.baselineSource = `UNAVAILABLE (${err.message}) — 0-row results cannot be disambiguated`;
  }

  // --- anon: what a logged-out browser can do -------------------------------
  for (const t of targets) {
    report.anon.probes.push(await probeTable(url, t, key, key));
  }

  // --- authenticated: only with a REAL session, and only a ZZ TEST one -------
  if (email && password) {
    const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      report.authenticated.status = `LOGIN FAILED (${res.status}) ${body.error_description || body.msg || ""}`.trim();
    } else {
      report.authenticated.status = `logged in as ${email}`;
      for (const t of targets) {
        report.authenticated.probes.push(await probeTable(url, t, key, body.access_token));
      }
    }
  } else {
    report.authenticated.status =
      "SKIPPED — no --email/--password. The access-model test users are created by " +
      "scripts/seed-access-test-fixtures.mjs (Phase 0 deliverable D). Never substitute " +
      "a live user's credentials here (CLAUDE.md).";
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Fold the service-role baseline into each line so the reader never has to
  // cross-reference two tables to interpret a zero.
  const line = (r) => {
    const b = report.baseline?.[r.table];
    let suffix = "";
    if (b && typeof b.count === "number") {
      suffix =
        r.status === 200 && r.rows === 0 && b.count > 0
          ? `  [DENIED: table truly holds ${b.count.toLocaleString()} rows]`
          : `  [true rows: ${b.count.toLocaleString()}]`;
    } else if (b?.note) {
      suffix = `  [baseline unavailable: ${b.note}]`;
    }
    return `  ${r.table.padEnd(34)} ${String(r.status ?? "-").padEnd(5)} ${r.verdict}${suffix}`;
  };

  console.log(`\nSupabase PostgREST reachability probe`);
  console.log(`  url          : ${url}`);
  console.log(`  credentials  : ${from}`);
  console.log(`  generated    : ${report.generatedAt}`);

  console.log(`\nEXPOSED TABLES (from the PostgREST OpenAPI spec, as anon)`);
  if (!exposed.ok) {
    console.log(`  spec unavailable: ${exposed.note}`);
  } else {
    console.log(`  ${exposed.tables.length} routed table(s); ${discoveredCache.length} match sundial_*_cache`);
  }
  console.log(`  cache tables probed (known list ∪ discovered): ${cacheTables.join(", ")}`);

  console.log(`\nANON (publishable key only — a logged-out browser)`);
  report.anon.probes.forEach((r) => console.log(line(r)));

  console.log(`\nAUTHENTICATED`);
  console.log(`  ${report.authenticated.status}`);
  report.authenticated.probes.forEach((r) => console.log(line(r)));

  const anonReadable = report.anon.probes.filter((r) => r.reachable === true);
  console.log(`\nVERDICT (anon): ${anonReadable.length === 0
    ? "no probed table returned data to the publishable key alone."
    : `${anonReadable.length} table(s) RETURNED DATA to the publishable key: ${anonReadable.map((r) => r.table).join(", ")}`}`);
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
