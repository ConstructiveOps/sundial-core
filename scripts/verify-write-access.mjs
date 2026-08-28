// Phase 4 gate — the WRITE path, asserted against the deployed sundial-sf-update.
// D-064, docs/access-model.md §3.4 and §2.3 invariants 1 and 2.
//
//   node scripts/verify-write-access.mjs
//
// ⚠️ THIS SCRIPT WRITES. Every write targets a ZZ PORTAL TEST record or a record it
// created itself, per CLAUDE.md — never a live customer, and it never authenticates as a
// live user. The reassignment probe RESTORES the original owner before it exits, and
// re-reads to prove it.
//
// The read matrix cannot cover this: a write gate that is too loose returns 200 and
// looks identical to a write gate that is correct. The only way to tell them apart is to
// attempt the write that must fail and then confirm the record did not move.

import { getSecret } from "../lib/secrets.js";
import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";

const API_BASE = (process.env.API_BASE_URL ||
  "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod").replace(/\/+$/, "");
const TENANT_ID = "a1W7y000007AszBEAS";

const secret = await getSecret("sundial/test-users");
const passwords = typeof secret === "string" ? JSON.parse(secret) : secret;

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
    console.error("Could not resolve the Supabase URL/anon key.");
    process.exit(2);
  }
  return { SUPABASE_URL: url.replace(/\/+$/, ""), ANON: key };
})();

async function tokenFor(slug) {
  const email = `tim+zz-${slug}@constructiveoperations.com`;
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: passwords[email] }),
  });
  if (!resp.ok) throw new Error(`login failed for ${slug}: ${resp.status}`);
  return (await resp.json()).access_token;
}

async function call(token, method, path, fields) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: fields === undefined ? undefined : JSON.stringify({ fields }),
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

let failures = 0;
let count = 0;
function check(ok, label, detail = "") {
  count++;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "** FAIL **"}  ${label}${detail ? `\n           ${detail}` : ""}`);
}

// --- fixtures ---------------------------------------------------------------
const users = await sfQuery(
  `SELECT Id, Email__c, Dealer__c FROM Sundial_User__c ` +
    `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND Email__c LIKE 'tim+zz-%'`
);
const byEmail = new Map(users.map((u) => [u.Email__c?.toLowerCase(), u]));
const repA = byEmail.get("tim+zz-rep-a1@constructiveoperations.com");
const repB = byEmail.get("tim+zz-rep-b1@constructiveoperations.com");

const customers = await sfQuery(
  `SELECT Id, Name, Sales_Rep__c, Dealer__c FROM Sundial_Customer__c ` +
    `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND Name LIKE 'ZZ PORTAL TEST%'`
);
const ownA = customers.find((c) => c.Sales_Rep__c === repA?.Id);
const ownB = customers.find((c) => c.Sales_Rep__c === repB?.Id);

console.log("=".repeat(100));
console.log("WRITE ACCESS — LIVE ASSERTION against the deployed sundial-sf-update");
console.log("=".repeat(100));
console.log(`  ${API_BASE}`);
console.log(`  rep-a1 ${repA?.Id} dealer ${repA?.Dealer__c}`);
console.log(`  rep-b1 ${repB?.Id} dealer ${repB?.Dealer__c}`);
console.log(`  ZZ record under rep-a1: ${ownA?.Id} (${ownA?.Name})`);
console.log(`  ZZ record under rep-b1: ${ownB?.Id} (${ownB?.Name})\n`);

const repToken = await tokenFor("rep-a1");
const adminToken = await tokenFor("admin");

// --- 1. a rep's own record, an editable field -------------------------------
console.log("--- rep-a1 (own scope) ---");
{
  const r = await call(repToken, "PATCH", `/sf/customer/${ownA.Id}`, {
    Sales_Rep_Notes__c: `write probe ${new Date().toISOString()}`,
  });
  // The field must be in the sheet's edit set; if it is not, that is the finding.
  check(
    r.status === 200 || r.status === 403,
    `PATCH an editable field -> ${r.status}`,
    r.status === 403 ? `FIELD_FORBIDDEN: ${JSON.stringify(r.body.fields)}` : ""
  );
}

// --- 2. a HIDDEN field ------------------------------------------------------
// Commission_Total__c is a FORMULA, so Salesforce would refuse it for everyone. That is
// what makes it a good probe rather than a bad one: the rep must be stopped by the
// ACCESS gate (403 FIELD_FORBIDDEN) and never reach the describe check (400
// FIELD_NOT_WRITABLE), which is the field-authorization ordering §3.4 step 3 specifies.
// The same field returns 400 for an admin below — the two codes on one field are the
// clearest possible evidence the layers are in the right order.
{
  const r = await call(repToken, "PATCH", `/sf/customer/${ownA.Id}`, {
    Commission_Total__c: 1,
  });
  check(r.status === 403, `PATCH a hidden field -> ${r.status} (expect 403, NOT 400)`);
  check(r.body?.code === "FIELD_FORBIDDEN", `  code is FIELD_FORBIDDEN`, JSON.stringify(r.body));
}

// --- 2b. a hidden field that IS writable — the asymmetry, on one field -------
// Dealer_Fee__c is hidden from Sales Rep in the sheet and updateable in Salesforce, so
// it isolates the access gate from the describe: the rep is refused, staff are not.
{
  const r = await call(repToken, "PATCH", `/sf/customer/${ownA.Id}`, {
    Dealer_Fee__c: 1,
  });
  check(r.status === 403, `PATCH a hidden-but-writable field as a rep -> ${r.status}`);
  check(r.body?.code === "FIELD_FORBIDDEN", "  refused by the ACCESS gate, not the describe");
}

// --- 3. THE ONE THAT MATTERS: self-reassignment -----------------------------
{
  const before = (await sfQuery(
    `SELECT Sales_Rep__c FROM Sundial_Customer__c WHERE Id = '${soqlEscapeString(ownB.Id)}'`
  ))[0];
  const r = await call(repToken, "PATCH", `/sf/customer/${ownB.Id}`, {
    Sales_Rep__c: repA.Id,
  });
  const after = (await sfQuery(
    `SELECT Sales_Rep__c FROM Sundial_Customer__c WHERE Id = '${soqlEscapeString(ownB.Id)}'`
  ))[0];
  // 404 (not visible) or 403 (field forbidden) are both correct refusals; what must NOT
  // happen is the record moving.
  check([403, 404].includes(r.status), `a rep reassigning another rep's record -> ${r.status}`);
  check(
    before.Sales_Rep__c === after.Sales_Rep__c,
    "  and the record did NOT move",
    `${before.Sales_Rep__c} -> ${after.Sales_Rep__c}`
  );
}

// --- 4. another rep's record ------------------------------------------------
{
  const r = await call(repToken, "PATCH", `/sf/customer/${ownB.Id}`, {
    Sales_Rep_Notes__c: "should not land",
  });
  check(r.status === 404, `PATCH a record outside the row filter -> ${r.status} (expect 404)`);
}

// --- 5. create stamps ownership --------------------------------------------
let createdId = null;
{
  const r = await call(repToken, "POST", "/sf/customer", {
    First_Name__c: "ZZ WRITE",
    Last_Name__c: `PROBE ${Date.now()}`,
  });
  check(r.status === 201, `POST /sf/customer as a rep -> ${r.status} (expect 201)`);
  createdId = r.body?.id ?? null;
  if (createdId) {
    const row = (await sfQuery(
      `SELECT Sales_Rep__c, Dealer__c, Client__c FROM Sundial_Customer__c ` +
        `WHERE Id = '${soqlEscapeString(createdId)}'`
    ))[0];
    check(row.Sales_Rep__c === repA.Id, "  Sales_Rep__c stamped from the token");
    check(row.Dealer__c === repA.Dealer__c, "  Dealer__c stamped with it (§2.3 inv 1)");
    check(row.Client__c === TENANT_ID, "  Client__c stamped, as before");
  }
}

// --- 6. create naming another rep is refused --------------------------------
{
  const r = await call(repToken, "POST", "/sf/customer", {
    First_Name__c: "ZZ WRITE",
    Last_Name__c: "SHOULD NOT EXIST",
    Sales_Rep__c: repB.Id,
  });
  check(r.status === 403, `POST naming another rep -> ${r.status} (expect 403)`);
}

// --- 7. sales role may create ONLY customer ---------------------------------
{
  const r = await call(repToken, "POST", "/sf/solar", { Project_Name__c: "ZZ NOPE" });
  check(r.status === 403, `POST /sf/solar as a rep -> ${r.status} (expect 403)`);
}

// --- 8. §2.3 INVARIANT 2 — reassignment re-stamps the dealer ----------------
console.log("\n--- admin (tenant scope): §2.3 invariant 2 ---");
{
  const before = (await sfQuery(
    `SELECT Sales_Rep__c, Dealer__c FROM Sundial_Customer__c ` +
      `WHERE Id = '${soqlEscapeString(ownA.Id)}'`
  ))[0];
  console.log(`  before: rep ${before.Sales_Rep__c} dealer ${before.Dealer__c}`);
  check(
    repA.Dealer__c !== repB.Dealer__c,
    "  the two reps are in DIFFERENT dealers (or this probe proves nothing)",
    `${repA.Dealer__c} vs ${repB.Dealer__c}`
  );

  const r = await call(adminToken, "PATCH", `/sf/customer/${ownA.Id}`, {
    Sales_Rep__c: repB.Id,
  });
  check(r.status === 200, `  admin reassigns rep-a1 -> rep-b1 -> ${r.status}`);

  const after = (await sfQuery(
    `SELECT Sales_Rep__c, Dealer__c FROM Sundial_Customer__c ` +
      `WHERE Id = '${soqlEscapeString(ownA.Id)}'`
  ))[0];
  console.log(`  after:  rep ${after.Sales_Rep__c} dealer ${after.Dealer__c}`);
  check(after.Sales_Rep__c === repB.Id, "  Sales_Rep__c moved");
  check(
    after.Dealer__c === repB.Dealer__c,
    "  Dealer__c moved WITH it — the deal is not stranded outside the new manager's view",
    `expected ${repB.Dealer__c}, got ${after.Dealer__c}`
  );

  // --- 9. a PATCH that does not touch the rep leaves the dealer alone -------
  const r2 = await call(adminToken, "PATCH", `/sf/customer/${ownA.Id}`, {
    Sales_Rep_Notes__c: `unrelated edit ${Date.now()}`,
  });
  const after2 = (await sfQuery(
    `SELECT Sales_Rep__c, Dealer__c FROM Sundial_Customer__c ` +
      `WHERE Id = '${soqlEscapeString(ownA.Id)}'`
  ))[0];
  check(r2.status === 200, `  an unrelated PATCH -> ${r2.status}`);
  check(
    after2.Dealer__c === after.Dealer__c && after2.Sales_Rep__c === after.Sales_Rep__c,
    "  leaves Sales_Rep__c and Dealer__c untouched"
  );

  // --- RESTORE. The fixtures the read matrix depends on must go back. -------
  const restore = await call(adminToken, "PATCH", `/sf/customer/${ownA.Id}`, {
    Sales_Rep__c: before.Sales_Rep__c,
  });
  const restored = (await sfQuery(
    `SELECT Sales_Rep__c, Dealer__c FROM Sundial_Customer__c ` +
      `WHERE Id = '${soqlEscapeString(ownA.Id)}'`
  ))[0];
  check(restore.status === 200, `  RESTORE reassign back -> ${restore.status}`);
  check(
    restored.Sales_Rep__c === before.Sales_Rep__c &&
      restored.Dealer__c === before.Dealer__c,
    "  fixture restored to its original rep AND dealer",
    `rep ${restored.Sales_Rep__c} dealer ${restored.Dealer__c}`
  );
}

// --- 10. tenant scope is unchanged ------------------------------------------
console.log("\n--- tenant scope: unchanged ---");
{
  // The SAME field the rep was refused at 403. Staff write it normally: the access gate
  // does not run for tenant scope at all.
  const r = await call(adminToken, "PATCH", `/sf/customer/${ownA.Id}`, {
    Dealer_Fee__c: 0,
  });
  check(r.status === 200, `admin PATCH of a rep-hidden field -> ${r.status} (expect 200)`);
}
{
  // And a FORMULA field still returns the pre-existing 400 FIELD_NOT_WRITABLE for staff
  // — unchanged by this phase, and proof the describe layer is still doing its job
  // underneath the new one.
  const r = await call(adminToken, "PATCH", `/sf/customer/${ownA.Id}`, {
    Commission_Total__c: 0,
  });
  check(
    r.status === 400 && r.body?.code === "FIELD_NOT_WRITABLE",
    `admin PATCH of a FORMULA field -> ${r.status} ${r.body?.code} (pre-existing, unchanged)`
  );
}

// --- cleanup: the probe record ----------------------------------------------
if (createdId) {
  console.log(`\n  NOTE: probe record ${createdId} was created and is left in place`);
  console.log("        (DELETE is 501 by design). It is named ZZ WRITE PROBE.");
}

console.log("\n" + "=".repeat(100));
console.log(
  failures === 0
    ? `ALL ${count} WRITE ASSERTIONS PASS.`
    : `** ${failures} of ${count} WRITE ASSERTIONS FAILED **`
);
process.exit(failures === 0 ? 0 : 1);
