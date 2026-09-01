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
import roofingManifest from "../lib/field-manifest/roofing.json" with { type: "json" };
import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";

const API_BASE = (process.env.API_BASE_URL ||
  "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod").replace(/\/+$/, "");
const TENANT_ID = "a1W7y000007AszBEAS";
const ONLY_USER = (() => {
  const i = process.argv.indexOf("--user");
  return i === -1 ? null : process.argv[i + 1];
})();

const MANIFESTS = { customer: customerManifest, solar: solarManifest };

/**
 * The column(s) that tell a user WHICH RECORD a list row is.
 *
 * Asserted PRESENT, which is the opposite of every other check in this file. The rest
 * assert nothing LEAKS -- that a role receives no column it should not. A manifest that
 * hid every single field would pass all of them.
 *
 * That is not hypothetical. On 2026-09-01 solar board cards and the list "Project"
 * column were blank for both sales roles, because `Project_Name__c` had no row in the
 * workbook and so never reached `listColumns`. Every leak assertion here was green
 * throughout: the rows were narrow, not wide. Narrow is the failure mode a leak test
 * cannot see.
 *
 * The rule these encode (see IDENTITY_LIST_COLUMNS in generate-field-configs.mjs):
 * the identity of a record a role may SEE is a `read` field by definition. A row you
 * may have but cannot name is not a narrower answer, it is a broken one.
 *
 * Customer lists ANY-OF: the client renders first+last, falling back to `name`
 * (salesCustomerName in src/components/sales/helpers.ts), so one of the three suffices.
 * Solar and roofing name the record directly.
 */
const IDENTITY_LIST_COLUMNS = {
  customer: ["first_name", "last_name", "name"],
  solar: ["project_name"],
  roofing: ["project_name"],
};

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


// ---------------------------------------------------------------------------
// IDENTITY COLUMNS — every role must be able to NAME the rows it receives
// ---------------------------------------------------------------------------
console.log("\n--- identity columns (list rows must be legible) ---");

const ALL_MANIFESTS = {
  customer: customerManifest,
  solar: solarManifest,
  roofing: roofingManifest,
};

for (const [object, manifest] of Object.entries(ALL_MANIFESTS)) {
  const identity = IDENTITY_LIST_COLUMNS[object] ?? [];
  for (const role of Object.keys(manifest.roles)) {
    const cols = new Set(manifest.listColumns[role] ?? []);
    const have = identity.filter((c) => cols.has(c));
    // ANY-OF, not all: customer resolves through a fallback chain, and one is enough
    // to render a name. Requiring all three would fail on a correct manifest.
    check(
      have.length > 0,
      `${object} / ${role}: listColumns can NAME the row`,
      have.length
        ? `via ${have.join(", ")}`
        : `NONE of [${identity.join(", ")}] is in listColumns — every row renders blank`,
    );
  }
}

// The live half. The manifest check above is the reliable regression guard (it is
// deterministic and cannot be confused by null values); this proves the deployed
// Lambda actually honours it, on real rows, for a real sales-role token.
//
// ⚠️ A LIST ROW OMITS BOTH STRIPPED AND NULL COLUMNS (projectListRow drops nulls for
// the payload cap), so "absent" alone proves nothing. The assertion is therefore made
// only against rows where the value is actually populated, established by reading the
// SAME record as tenant scope first. Skipping is honest; a false pass is not.
const tenantToken = await tokenFor("admin");
for (const object of ["customer", "solar"]) {
  const identity = IDENTITY_LIST_COLUMNS[object] ?? [];
  const asTenant = await get(tenantToken, `/sf/${object}?limit=50`);
  const tenantRows = new Map(
    (asTenant.body?.records ?? []).map((r) => [r.sf_id, r]),
  );

  for (const u of USERS) {
    if (!u.role) continue;
    if (ONLY_USER && u.slug !== ONLY_USER) continue;
    const token = await tokenFor(u.slug);
    const res = await get(token, `/sf/${object}?limit=50`);
    if (res.status === 403) continue; // module closed for this role; nothing to name
    const rows = res.body?.records ?? [];
    if (rows.length === 0) continue;

    // Rows where tenant scope proves at least one identity value is POPULATED.
    const testable = rows.filter((r) => {
      const t = tenantRows.get(r.sf_id);
      return t && identity.some((c) => t[c] != null && String(t[c]).trim() !== "");
    });
    if (testable.length === 0) {
      check(true, `${object} / ${u.slug}: no row with a populated name to test (skipped)`);
      continue;
    }
    const blank = testable.filter(
      (r) => !identity.some((c) => r[c] != null && String(r[c]).trim() !== ""),
    );
    check(
      blank.length === 0,
      `${object} / ${u.slug}: all ${testable.length} named row(s) arrive NAMED`,
      blank.length
        ? `${blank.length} row(s) lost their name in projection, e.g. ${blank[0].sf_id}`
        : "",
    );
  }
}
console.log("\n" + "=".repeat(100));
console.log(
  failures === 0
    ? `ALL ${results.length} ASSERTIONS PASS — the deployed endpoint matches the sheet.`
    : `** ${failures} of ${results.length} ASSERTIONS FAILED **`
);
process.exit(failures === 0 ? 0 : 1);
