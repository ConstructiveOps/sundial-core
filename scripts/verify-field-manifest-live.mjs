// Phase 4 gate — the field manifest, asserted against the DEPLOYED endpoint.
// D-064, docs/access-model.md §4.3, §4.4.
//
//   node scripts/verify-field-manifest-live.mjs
//   node scripts/verify-field-manifest-live.mjs --user rep-a1
//
// READ-ONLY. Logs in as ZZ TEST users only (CLAUDE.md: never a live user) and reads.
// Writes nothing.
//
// The matrix answers "what STATUS does each surface return". This answers the question
// Phase 4 adds: "which FIELDS came back, and are they exactly the ones the sheet says".
// A status-only check would pass a 200 that carried every commission rate in the org.

import { getSecret } from "../lib/secrets.js";
import customerManifest from "../lib/field-manifest/customer.json" with { type: "json" };
import solarManifest from "../lib/field-manifest/solar.json" with { type: "json" };
import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";

const API_BASE = (process.env.API_BASE_URL ||
  "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod").replace(/\/+$/, "");
const TENANT_ID = "a1W7y000007AszBEAS";
const ONLY_USER = (() => {
  const i = process.argv.indexOf("--user");
  return i === -1 ? null : process.argv[i + 1];
})();

const MANIFESTS = { customer: customerManifest, solar: solarManifest };

/** Which ZZ users to run, and which manifest role each one resolves to. */
const USERS = [
  { slug: "rep-a1", role: "Sales Rep" },
  { slug: "mgr-a", role: "Sales Dealer" },
  { slug: "admin", role: null }, // tenant scope: unprojected
];

const results = [];
let failures = 0;

function check(ok, label, detail = "") {
  results.push({ ok, label, detail });
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "** FAIL **"}  ${label}${detail ? `\n           ${detail}` : ""}`);
}

// --- auth ---------------------------------------------------------------------
const secret = await getSecret("sundial/test-users");
const passwords = typeof secret === "string" ? JSON.parse(secret) : secret;
// Same resolution verify-access-matrix.mjs uses: env first, then harmon-crm's
// .env.local. The anon key is the publishable one the browser already ships.
const { SUPABASE_URL, ANON } = await (async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  let url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  let key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const envPath = new URL("../../harmon-crm/.env.local", import.meta.url).pathname.replace(
    /^\//,
    ""
  );
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
  return { SUPABASE_URL: url.replace(/\/+$/, ""), ANON: key };
})();

async function tokenFor(slug) {
  const email = `tim+zz-${slug}@constructiveoperations.com`;
  const pw = passwords[email];
  if (!pw) throw new Error(`no password for ${email} in sundial/test-users`);
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pw }),
  });
  if (!resp.ok) throw new Error(`login failed for ${slug}: ${resp.status}`);
  return (await resp.json()).access_token;
}

async function get(token, path) {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

// The ZZ customer each rep owns, so ?full=true has a record to return.
const fixtures = await sfQuery(
  `SELECT Id, Name, Sales_Rep__c FROM Sundial_Customer__c ` +
    `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND Name LIKE 'ZZ PORTAL TEST%'`
);
const zzUsers = await sfQuery(
  `SELECT Id, Email__c FROM Sundial_User__c WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' ` +
    `AND Email__c LIKE 'tim+zz-%'`
);
const idByEmail = new Map(zzUsers.map((u) => [u.Email__c?.toLowerCase(), u.Id]));

console.log("=".repeat(100));
console.log("FIELD MANIFEST — LIVE ASSERTION against the deployed endpoint");
console.log("=".repeat(100));
console.log(`  ${API_BASE}`);
console.log(`  manifest customer ${customerManifest.version}`);
console.log(`  manifest solar    ${solarManifest.version}\n`);

for (const u of USERS) {
  if (ONLY_USER && u.slug !== ONLY_USER) continue;
  const sfUserId = idByEmail.get(`tim+zz-${u.slug}@constructiveoperations.com`);
  const own = fixtures.find((c) => c.Sales_Rep__c === sfUserId) ?? fixtures[0];
  console.log(`\n--- ${u.slug} (${u.role ?? "tenant scope"}) ---`);

  const token = await tokenFor(u.slug);

  // ---- ?full=true: exactly the manifest's read set, and nothing else -----------
  const full = await get(token, `/sf/customer/${own.Id}?full=true`);
  if (full.status !== 200) {
    check(false, `GET ?full=true returned ${full.status}`, JSON.stringify(full.body));
    continue;
  }
  const returned = Object.keys(full.body.record ?? {});

  if (u.role) {
    const allowed = new Set([...customerManifest.roles[u.role].read, "Id", "Client__c"]);
    const leaked = returned.filter((f) => !allowed.has(f));
    check(
      leaked.length === 0,
      `?full=true returns ONLY manifest-readable fields (${returned.length} fields)`,
      leaked.length ? `LEAKED: ${leaked.slice(0, 12).join(", ")}` : ""
    );


    check(
      Array.isArray(full.body.access?.editable),
      "the response carries access.editable"
    );
    const editable = full.body.access?.editable ?? [];
    check(
      JSON.stringify(editable) ===
        JSON.stringify([...customerManifest.roles[u.role].edit].sort()),
      "access.editable equals the sheet's edit set exactly",
      `server ${editable.length} vs manifest ${customerManifest.roles[u.role].edit.length}`
    );
    for (const p of ["Sales_Rep__c", "Dealer__c", "Client__c", "Stage__c"]) {
      check(!editable.includes(p), `${p} is NOT editable (protected, §3.4)`);
    }
    check(
      full.body.access?.manifestVersion?.includes(customerManifest.version.slice(7, 15)),
      "manifestVersion matches the deployed manifest"
    );
  } else {
    check(
      returned.length > customerManifest.roles["Sales Rep"].read.length,
      "tenant scope is UNPROJECTED (more fields than any sales role)",
      `${returned.length} fields returned`
    );
    check(full.body.access?.editable === null, "access.editable is null for tenant scope");
  }

  // ---- list rows: projected on the same rule ---------------------------------
  const list = await get(token, "/sf/customer?limit=5");
  if (list.status === 200 && (list.body.records ?? []).length > 0) {
    const cols = new Set(Object.keys(list.body.records[0]));
    if (u.role) {
      const allowedCols = new Set(customerManifest.listColumns[u.role]);
      const leaked = [...cols].filter((c) => !allowedCols.has(c));
      check(
        leaked.length === 0,
        `list rows carry ONLY manifest listColumns (${cols.size} columns)`,
        leaked.length ? `LEAKED: ${leaked.slice(0, 12).join(", ")}` : ""
      );
    } else {
      check(true, `tenant list rows unprojected (${cols.size} columns)`);
    }
  } else if (list.status === 403) {
    check(u.role === null ? false : true, `list is 403 for this role (module closed)`);
  }

  // ---- picklist metadata: only the role's fields (§4.4) -----------------------
  const meta = await get(token, "/sf/meta/customer/picklists");
  if (meta.status === 200) {
    const names = Object.keys(meta.body.picklists ?? {});
    if (u.role) {
      const readable = new Set(customerManifest.roles[u.role].read);
      const leaked = names.filter((n) => !readable.has(n));
      check(
        leaked.length === 0,
        `picklist meta limited to the role's fields (${names.length} picklists)`,
        leaked.length ? `LEAKED: ${leaked.slice(0, 12).join(", ")}` : ""
      );
    } else {
      check(true, `tenant picklist meta unfiltered (${names.length} picklists)`);
    }
  } else {
    check(false, `picklist meta returned ${meta.status}`);
  }
}

console.log("\n" + "=".repeat(100));
console.log(
  failures === 0
    ? `ALL ${results.length} ASSERTIONS PASS — the deployed endpoint matches the sheet.`
    : `** ${failures} of ${results.length} ASSERTIONS FAILED **`
);
process.exit(failures === 0 ? 0 : 1);
