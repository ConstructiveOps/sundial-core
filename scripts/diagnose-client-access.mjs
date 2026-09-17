// Diagnostic for the client reflection layer (D-064 §4.3/§4.5). READ-ONLY.
//
//   node scripts/diagnose-client-access.mjs
//
// Answers question (a): what EXACTLY does production return to a sales role on
// ?full=true — is the access block present, under what key, and what does the record
// contain? Everything else the client does is downstream of this, so it is diagnosed
// first and separately.
//
// Logs in as ZZ TEST users only (CLAUDE.md). Writes nothing.

import { getSecret } from "../lib/secrets.js";
import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";
import customerManifest from "../lib/field-manifest/customer.json" with { type: "json" };
import solarManifest from "../lib/field-manifest/solar.json" with { type: "json" };

const API_BASE = (process.env.API_BASE_URL ||
  "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod").replace(/\/+$/, "");
const TENANT_ID = "a1W7y000007AszBEAS";

const secret = await getSecret("sundial/test-users");
const passwords = typeof secret === "string" ? JSON.parse(secret) : secret;

const { SUPABASE_URL, ANON } = await (async () => {
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
  if (!url || !key) { console.error("no Supabase url/key"); process.exit(2); }
  return { SUPABASE_URL: url.replace(/\/+$/, ""), ANON: key };
})();

async function tokenFor(slug) {
  const email = `tim+zz-${slug}@constructiveoperations.com`;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: passwords[email] }),
  });
  if (!r.ok) throw new Error(`login ${slug}: ${r.status}`);
  return (await r.json()).access_token;
}
const get = async (token, path) => {
  const r = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// Fixtures: the ZZ customer each rep owns, and its linked solar twin.
const users = await sfQuery(
  `SELECT Id, Email__c FROM Sundial_User__c WHERE Client__c='${soqlEscapeString(TENANT_ID)}' AND Email__c LIKE 'tim+zz-%'`
);
const idByEmail = new Map(users.map((u) => [u.Email__c?.toLowerCase(), u.Id]));
const repAId = idByEmail.get("tim+zz-rep-a1@constructiveoperations.com");
const customers = await sfQuery(
  `SELECT Id, Name, Sales_Rep__c, Linked_Solar_Project__c FROM Sundial_Customer__c ` +
  `WHERE Client__c='${soqlEscapeString(TENANT_ID)}' AND Name LIKE 'ZZ PORTAL TEST%'`
);
const own = customers.find((c) => c.Sales_Rep__c === repAId) ?? customers[0];

console.log("=".repeat(100));
console.log("(a) WHAT PRODUCTION ACTUALLY RETURNS ON ?full=true");
console.log("=".repeat(100));
console.log(`  ${API_BASE}`);
console.log(`  customer ${own?.Id}   linked solar ${own?.Linked_Solar_Project__c}\n`);

for (const slug of ["rep-a1", "admin"]) {
  const token = await tokenFor(slug);
  console.log(`\n########## ${slug} ##########`);

  for (const [objectKey, id, manifest] of [
    ["customer", own?.Id, customerManifest],
    ["solar", own?.Linked_Solar_Project__c, solarManifest],
  ]) {
    if (!id) { console.log(`  ${objectKey}: no fixture id`); continue; }
    const res = await get(token, `/sf/${objectKey}/${id}?full=true`);
    console.log(`\n  --- GET /sf/${objectKey}/${id}?full=true -> ${res.status} ---`);
    if (res.status !== 200) { console.log("      " + JSON.stringify(res.body)); continue; }

    console.log(`  TOP-LEVEL KEYS: ${JSON.stringify(Object.keys(res.body))}`);
    const acc = res.body.access;
    console.log(`  access present: ${acc !== undefined}`);
    if (acc !== undefined) {
      console.log(`    access keys        : ${JSON.stringify(Object.keys(acc))}`);
      console.log(`    access.editable    : ${
        acc.editable === null ? "null (tenant scope -> unrestricted)" : `${acc.editable.length} field(s)`
      }`);
      if (Array.isArray(acc.editable)) {
        console.log(`      sample           : ${JSON.stringify(acc.editable.slice(0, 4))}`);
      }
      console.log(`    manifestVersion    : ${acc.manifestVersion}`);
    }
    const rec = res.body.record ?? {};
    const keys = Object.keys(rec);
    console.log(`  record field count   : ${keys.length}`);
    const roleRead = manifest.roles["Sales Rep"].read;
    const leaked = keys.filter((k) => k !== "Id" && k !== "Client__c" && !roleRead.includes(k));
    console.log(`  fields OUTSIDE the Sales Rep read set: ${leaked.length}${
      leaked.length ? " -> " + leaked.slice(0, 6).join(", ") : ""
    }`);
  }
}
console.log("\n" + "=".repeat(100));
