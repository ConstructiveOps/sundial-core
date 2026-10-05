// scripts/check-cache-formula-coverage.mjs — can the scheduled sync keep every cached
// formula column fresh? Read-only (Salesforce describes + the Supabase column list).
//
//   node scripts/check-cache-formula-coverage.mjs            # every cached object
//   node scripts/check-cache-formula-coverage.mjs --object job
//
// WHY THIS EXISTS (D-079, 2026-10-05): the cache is authoritative while
// sundial-cache-sync is healthy, and the sync only re-reads a row when its
// SystemModstamp moves — which a cross-object FORMULA does not do. The sync covers that
// by also asking for rows whose PARENT changed (lib/formula-parents.js derives the
// parents from the describe). This script prints, per object, which cached formula
// columns are covered through which parent, and FAILS (exit 1) on any column the sync
// cannot keep fresh: a TODAY()/NOW() formula, a $ global, a polymorphic lookup, or an
// unresolvable relationship.
//
// Run it after adding a formula field to a cache table. On a failure, either drop the
// column from the cache table, or have whatever writes the parent flag the child's
// cache row is_stale (the markStale pattern in the service Lambdas).

import { getSalesforceToken } from "../lib/salesforce.js";
import { getSupabaseConfig } from "../lib/supabase.js";
import { parentModstampPaths } from "../lib/formula-parents.js";
import { OBJECT_ALLOWLIST, sfFieldToColumn } from "../lambdas/sundial-cache-sync/index.js";

const args = process.argv.slice(2);
const only = args.includes("--object") ? args[args.indexOf("--object") + 1] : null;
const EXCLUDED = new Set(["address", "location", "base64"]);

const { access_token, instance_url } = await getSalesforceToken();
const describes = new Map();
async function describe(name) {
  if (!describes.has(name)) {
    const r = await fetch(`${instance_url}/services/data/v60.0/sobjects/${name}/describe`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!r.ok) throw new Error(`describe ${name} failed (${r.status})`);
    describes.set(name, await r.json());
  }
  return describes.get(name);
}

const cfg = await getSupabaseConfig();
const spec = await (await fetch(`${cfg.url}/rest/v1/`, {
  headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` },
})).json();
const columnsOf = (table) => {
  const def = spec?.definitions?.[table] || spec?.components?.schemas?.[table];
  return new Set(def?.properties ? Object.keys(def.properties) : []);
};

let problems = 0;
for (const [key, { sfObject, cacheTable }] of Object.entries(OBJECT_ALLOWLIST)) {
  if (only && key !== only) continue;
  const cols = columnsOf(cacheTable);
  if (cols.size === 0) {
    console.log(`${key.padEnd(15)} (no cache table ${cacheTable} — skipped)`);
    continue;
  }
  let meta;
  try {
    meta = await describe(sfObject);
  } catch (e) {
    console.log(`${key.padEnd(15)} describe failed: ${e.message}`);
    problems++;
    continue;
  }
  const r = await parentModstampPaths({
    sfObject,
    fields: meta.fields || [],
    isCached: (f) => !EXCLUDED.has(f.type) && cols.has(sfFieldToColumn(f)),
    describe,
  });
  const head = `${key.padEnd(15)} parents: ${r.paths.length ? r.paths.join(", ") : "(none needed)"}`;
  console.log(head);
  for (const c of r.covered) console.log(`    ok    ${c.field}  via ${c.paths.join(", ")}`);
  for (const u of r.uncoverable) {
    console.log(`    FAIL  ${u.field}  ${u.reason}`);
    problems++;
  }
}

if (problems > 0) {
  console.log(`\n${problems} cached column(s) the sync cannot keep fresh — see the header of this script for the fix.`);
  process.exit(1);
}
console.log("\nEvery cached formula column is covered by the incremental sync.");
