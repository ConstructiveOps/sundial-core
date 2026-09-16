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
import { identityFields, identityColumns } from "../lib/field-manifest/identity.js";

const API_BASE = (process.env.API_BASE_URL ||
  "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod").replace(/\/+$/, "");
const TENANT_ID = "a1W7y000007AszBEAS";
const ONLY_USER = (() => {
  const i = process.argv.indexOf("--user");
  return i === -1 ? null : process.argv[i + 1];
})();

const MANIFESTS = { customer: customerManifest, solar: solarManifest };

/**
 * The field(s) and column(s) that tell a user WHICH RECORD they are looking at.
 *
 * ⚠️ IMPORTED, NOT RESTATED — `lib/field-manifest/identity.js` is the one list, and this
 * script asserting a private copy of it is how a third spelling would appear.
 *
 * Asserted PRESENT, which is the opposite of every other check in this file. The rest
 * assert nothing LEAKS -- that a role receives no column it should not. A manifest that
 * hid every single field would pass all of them.
 *
 * That is not hypothetical, and it has now happened TWICE:
 *
 *   2026-09-01 — solar board cards and the list "Project" column were blank for both
 *     sales roles, because `Project_Name__c` had no row in the workbook and so never
 *     reached `listColumns`.
 *   2026-09-15 — the Solar DETAIL header rendered "—" for both sales roles, for the same
 *     root cause on the other surface: the first fix was expressed in cache columns, and
 *     the `?full=true` SELECT is built from Salesforce field names.
 *
 * Every leak assertion here was green throughout both: the rows were narrow, not wide.
 * Narrow is the failure mode a leak test cannot see — and a surface with no assertion at
 * all is the failure mode the FIRST fix could not see. Hence both halves below.
 *
 * The rule: the identity of a record a role may SEE is a `read` field by definition. A
 * row you may have but cannot name is not a narrower answer, it is a broken one.
 *
 * ANY-OF, not all-of: customer resolves through a fallback chain (first+last, else
 * `Name`), so one populated element suffices to render a name. Requiring all three would
 * fail on a correct manifest.
 */
const IDENTITY_LIST_COLUMNS = {
  customer: identityColumns("customer"),
  solar: identityColumns("solar"),
  roofing: identityColumns("roofing"),
};
const IDENTITY_FIELDS = {
  customer: identityFields("customer"),
  solar: identityFields("solar"),
  roofing: identityFields("roofing"),
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
    // The identity fields are part of the read set at runtime even when the sheet has
    // no row for them (lib/field-manifest/identity.js), so they belong in `allowed` --
    // otherwise the "returns ONLY manifest-readable fields" check and the "arrives
    // NAMED" check below would contradict each other on the same response.
    const allowed = new Set([
      ...customerManifest.roles[u.role].read,
      ...IDENTITY_FIELDS.customer,
      "Id",
      "Client__c",
    ]);
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

// The live half, on BOTH surfaces. The manifest check above is the reliable regression
// guard (it is deterministic and cannot be confused by null values); this proves the
// deployed Lambda actually honours it, on real rows, for a real sales-role token.
//
// TWO ASSERTIONS PER OBJECT PER USER, because the 2026-09-15 bug lived in the gap
// between them: list rows arrived NAMED (the 2026-09-01 fix) while `?full=true` on the
// very same record arrived NAMELESS. One assertion on one surface is how that survived a
// green gate for two weeks.
//
//   1. LIST   — the row the board and the list render from carries a name column.
//   2. DETAIL — `?full=true` on that same record carries the identity FIELD, populated,
//               and names it in `access.visible` so the client will actually draw it.
//
// ⚠️ A LIST ROW OMITS BOTH STRIPPED AND NULL COLUMNS (projectListRow drops nulls for the
// payload cap), so "absent" alone proves nothing. Both assertions are therefore made only
// against records where the value is actually populated, established by reading the SAME
// record as tenant scope first. Skipping is honest; a false pass is not.
const tenantToken = await tokenFor("admin");
for (const object of ["customer", "solar", "roofing"]) {
  const identity = IDENTITY_LIST_COLUMNS[object] ?? [];
  const identityApi = IDENTITY_FIELDS[object] ?? [];
  const asTenant = await get(tenantToken, `/sf/${object}?limit=50`);
  const tenantRows = new Map(
    (asTenant.body?.records ?? []).map((r) => [r.sf_id, r]),
  );

  for (const u of USERS) {
    if (!u.role) continue;
    if (ONLY_USER && u.slug !== ONLY_USER) continue;
    const token = await tokenFor(u.slug);
    const res = await get(token, `/sf/${object}?limit=50`);
    // §3.1: roofing is denied to both sales scopes today, so there is nothing to name.
    // Reported rather than skipped silently — the day the module opens, this line stops
    // saying "closed" and the assertions below start running with no edit here.
    if (res.status === 403) {
      check(true, `${object} / ${u.slug}: module CLOSED to this role (nothing to name)`);
      continue;
    }
    const rows = res.body?.records ?? [];
    if (rows.length === 0) continue;

    // Rows where tenant scope proves at least one identity value is POPULATED.
    const testable = rows.filter((r) => {
      const t = tenantRows.get(r.sf_id);
      return t && identity.some((c) => t[c] != null && String(t[c]).trim() !== "");
    });

    // ---- 1. LIST rows arrive named ------------------------------------------
    if (testable.length === 0) {
      check(true, `${object} / ${u.slug}: no LIST row with a proven name to test (skipped)`);
    } else {
      const blank = testable.filter(
        (r) => !identity.some((c) => r[c] != null && String(r[c]).trim() !== ""),
      );
      check(
        blank.length === 0,
        `${object} / ${u.slug}: all ${testable.length} named LIST row(s) arrive NAMED`,
        blank.length
          ? `${blank.length} row(s) lost their name in projection, e.g. ${blank[0].sf_id}`
          : "",
      );
    }

    // ---- 2. The DETAIL read arrives named ------------------------------------
    // THE 2026-09-15 REGRESSION, stated live. One record is enough: the SELECT is built
    // once per role from the manifest, so it is right for every record or wrong for every
    // record.
    //
    // ⚠️ "POPULATED" IS ESTABLISHED ON THE SAME RECORD, NOT FROM THE LIST PAGE. The list
    // half above can only test a row that happens to appear in BOTH the role's first 50
    // and tenant scope's first 50, and on customer those two windows do not overlap at
    // all -- 31.6k rows, and the role sees two of them. Relying on that overlap here
    // would silently skip the customer detail assertion forever, which is how a surface
    // ends up with no coverage while the report says PASS. So the probe record is read
    // ONCE AS TENANT with ?full=true: same record, no projection, no window.
    const probe = testable[0] ?? rows[0];
    const asTenantFull = await get(tenantToken, `/sf/${object}/${probe.sf_id}?full=true`);
    const tenantRec = asTenantFull.body?.record ?? {};
    const provenPopulated = identityApi.filter(
      (f) => tenantRec[f] != null && String(tenantRec[f]).trim() !== "",
    );
    if (asTenantFull.status !== 200 || provenPopulated.length === 0) {
      // Honest skip: if tenant scope cannot show a name either, a blank answer from the
      // sales role proves nothing about projection. A false pass is worse than a skip.
      check(
        true,
        `${object} / ${u.slug}: ${probe.sf_id} has no name even at tenant scope (skipped)`
      );
      continue;
    }
    const detail = await get(token, `/sf/${object}/${probe.sf_id}?full=true`);
    if (detail.status !== 200) {
      check(false, `${object} / ${u.slug}: ?full=true on ${probe.sf_id} returned ${detail.status}`);
      continue;
    }
    const rec = detail.body?.record ?? {};
    const named = identityApi.filter((f) => rec[f] != null && String(rec[f]).trim() !== "");
    check(
      named.length > 0,
      `${object} / ${u.slug}: ?full=true record arrives NAMED (the detail header)`,
      named.length
        ? `via ${named.join(", ")}`
        : `tenant scope shows [${provenPopulated.join(", ")}] on ${probe.sf_id}, this role ` +
          `gets none of [${identityApi.join(", ")}] — the detail page header renders "—"`,
    );

    // The client renders from `access.visible` (§4.3), not from key presence — a field
    // that arrives on the record but is missing from `visible` is still not drawn.
    const visible = detail.body?.access?.visible;
    if (Array.isArray(visible)) {
      const declared = identityApi.filter((f) => visible.includes(f));
      check(
        declared.length > 0,
        `${object} / ${u.slug}: access.visible DECLARES the identity field`,
        declared.length ? `via ${declared.join(", ")}` : `visible omits [${identityApi.join(", ")}]`,
      );
    }
  }
}
console.log("\n" + "=".repeat(100));
console.log(
  failures === 0
    ? `ALL ${results.length} ASSERTIONS PASS — the deployed endpoint matches the sheet.`
    : `** ${failures} of ${results.length} ASSERTIONS FAILED **`
);
process.exit(failures === 0 ? 0 : 1);
