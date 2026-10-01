// The demo-isolation check, end to end, against a SEEDED fake org (the seed's own fakes,
// built from migration/demo/probe.json), a fake Supabase project and a fake portal API —
// clean, and then with one fault injected at a time. Every fault must produce a FAIL that
// names the record.
//
//   node --test scripts/demo-seed/verify-isolation.test.js
//
// Nothing here touches anything real. What these tests prove: the checks find what they
// are meant to find, the script writes nothing, its queries are valid against the live
// metadata captured in probe.json. What they cannot prove: that the deployed Lambdas and
// the live tables behave the way the code in this repo says (see the script's header).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeIo } from "./fakes.js";
import { runSeed } from "./run.js";
import { loadProbe } from "./test-helpers.js";
import { OBJ, DEMO_USERS_SECRET } from "./policy.js";
import {
  verify, parseVerifyArgs, findDemoIds, sampleIds, id15, CACHE_OBJECTS, RECORD_TABLES, KNOWN_OBJECTS, MAX_SOQL_CHARS,
  TEST_USERS_SECRET, C2_EVERY, C2_SAMPLED,
} from "./verify-isolation.js";
import { soqlShim, describeShim, readOnlySupabase, simulateCacheSync, createFakeApi, cacheRowOf } from "./verify-fakes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PRIMARY = "a1W7y000007AszBEAS";
const zzEmail = (slug) => `tim+zz-${slug}@constructiveoperations.com`;
const AVERY = "tim+demo-avery@constructiveoperations.com";

/**
 * A seeded fake world plus the primary tenant's test fixtures, and the read-only `io` the
 * check is given. `inject(world)` runs after the seed (and after the simulated sync).
 */
async function buildWorld({ sync = false, supabase: supabaseOpts = {}, seedArgs = ["--with-files"] } = {}) {
  const w = createFakeIo(loadProbe());
  const code = await runSeed(["--apply", ...seedArgs], w.io);
  assert.equal(code, 0, w.output().split("\n").slice(-20).join("\n"));
  const org = w.org;
  const db = w.supabase;
  const idmap = w.idmap();
  const demoTenant = idmap.ids.tenant;

  // --- the primary tenant: its ZZ TEST users and records, and a little ordinary data --------
  const logins = new Map(db.users.map((u) => [u.email, { uuid: u.id, password: u.password }]));
  const zz = {};
  for (const [slug, level, n] of [["exec", "Executive", 1], ["admin", "Admin", 2]]) {
    const uuid = `aaaaaaaa-0000-4000-8000-00000000000${n}`;
    const password = `zz-${slug}-secret-pw-${n}-Zq9!`;
    zz[slug] = org.insertRaw(OBJ.user, { First_Name__c: "ZZ", Last_Name__c: `Test ${slug}`, Email__c: zzEmail(slug), Access_Level__c: level, Hierarchy_Level__c: "Client", Active__c: true, Client__c: PRIMARY, Supabase_User_Id__c: uuid });
    logins.set(zzEmail(slug), { uuid, password });
    db.tables.get("profiles").push({ id: uuid, tenant_id: PRIMARY, sundial_user_id: zz[slug], role: level, email: zzEmail(slug), full_name: `ZZ Test ${slug}`, updated_at: null, access_scope: "tenant", access_level: level, dealer_sf_id: null });
  }
  const zzCustomer = org.insertRaw(OBJ.customer, { Name: "ZZ PORTAL TEST 2", First_Name__c: "ZZ", Last_Name__c: "PORTAL TEST 2", Client__c: PRIMARY, Status__c: "Customer", Primary_Phone__c: "(602) 555-0199" });
  const zzSolar = org.insertRaw(OBJ.solar, { Name: "SOL-ZZ", Project_Name__c: "ZZ PORTAL TEST 2", Sundial_Customer__c: zzCustomer, Client__c: PRIMARY });
  const zzRoofing = org.insertRaw(OBJ.roofing, { Name: "ROOF-ZZ", Project_Name__c: "ZZ PORTAL TEST ROOFING", Sundial_Customer__c: zzCustomer, Client__c: PRIMARY });
  const harmonDealer = org.insertRaw(OBJ.dealer, { Name: "A Harmon Dealer", Client__c: PRIMARY, Active__c: true });
  const harmonItem = org.insertRaw(OBJ.item, { Name: "Harmon labor hour", Item_Code__c: "H-LAB", Client__c: PRIMARY, Is_Active__c: true });
  const harmonEstimate = org.insertRaw(OBJ.estimate, { Name: "EST-H1", Client__c: PRIMARY, Sundial_Customer__c: org.harmonCustomerId, Status__c: "Draft" });
  const harmonJob = org.insertRaw(OBJ.job, { Name: "SVC-H1", Client__c: PRIMARY, Sundial_Customer__c: org.harmonCustomerId, Estimate__c: harmonEstimate, Status__c: "New" });
  org.insertRaw(OBJ.call, { Name: "SC-H1", Client__c: PRIMARY, Sundial_Service_Job__c: harmonJob, Tech__c: org.harmonJobUserId, Status__c: "Scheduled", Scheduled_Start__c: "2026-09-29T20:00:00.000Z" });

  // The primary tenant's lists are in daily use, so its cache is warm. The demo's records
  // reach the cache only when the sync runs.
  simulateCacheSync(org, db, sync ? {} : { onlyTenant: PRIMARY });

  const testSecret = Object.fromEntries(["exec", "admin"].map((slug) => [zzEmail(slug), logins.get(zzEmail(slug)).password]));
  const tokens = new Map();
  const issued = [];
  const loginCalls = [];
  const loginAs = async (email, password) => {
    loginCalls.push(email);
    const l = logins.get(email);
    if (!l || l.password !== password) return { token: null, status: 400 };
    const token = `eyJhbGciOiJFUzI1NiJ9.fake${issued.length + 1}x${Math.random().toString(36).slice(2)}.sig`;
    tokens.set(token, l.uuid);
    issued.push(token);
    return { token, status: 200 };
  };
  const api = createFakeApi({ org, db, tokens });
  const ro = readOnlySupabase(db, supabaseOpts);
  const soql = [];
  const lines = [];
  const secretReads = [];
  // Anything that could write to Salesforce is a trap: it throws, and the attempt is recorded.
  const trapped = [];
  const trap = (name) => async () => {
    trapped.push(name);
    throw new Error(`WRITE ATTEMPTED: ${name}`);
  };
  const io = {
    sfQuery: soqlShim(org, soql),
    describeObject: describeShim(org),
    sfCreateRecord: trap("sfCreateRecord"),
    sfUpdateRecord: trap("sfUpdateRecord"),
    sfDeleteRecord: trap("sfDeleteRecord"),
    sfUpsertRecord: trap("sfUpsertRecord"),
    secrets: { save: trap("secrets.save") },
    s3: { putObject: trap("s3.putObject") },
    files: { writeJsonAtomic: trap("files.writeJsonAtomic") },
    getSupabase: async () => ro.client,
    getSecret: async (name) => {
      secretReads.push(name);
      if (name === TEST_USERS_SECRET) return testSecret;
      if (name === DEMO_USERS_SECRET) return JSON.parse(w.secrets.get(DEMO_USERS_SECRET));
      throw new Error(`ResourceNotFoundException: ${name}`);
    },
    fetch: api.fetch,
    loginAs,
    // The contract of scripts/portal-login.mjs loginAsTestUser.
    loginAsTestUser: async (slug, passwords) => {
      const email = zzEmail(slug);
      if (!passwords[email]) throw new Error(`No password for ${email} in sundial/test-users.`);
      return { email, ...(await loginAs(email, passwords[email])) };
    },
    resolveSupabasePublic: () => ({ url: "https://project.supabase.example", key: "sb_publishable_FAKE-KEY-0001" }),
    readIdMap: async () => JSON.parse(JSON.stringify(idmap)),
    now: () => new Date("2026-09-29T19:00:00.000Z"),
    log: (line) => lines.push(String(line)),
  };
  const mine = (sfObject) => org.all(sfObject).filter((r) => r.Client__c === demoTenant);
  const secrets = [...logins.values()].map((l) => l.password);
  return {
    w, org, db, idmap, demoTenant, io, api, ro, soql, lines, tokens, issued, loginCalls, secretReads, secrets, mine, logins, trapped,
    zz: { ...zz, customer: zzCustomer, solar: zzSolar, roofing: zzRoofing },
    harmon: { dealer: harmonDealer, item: harmonItem, estimate: harmonEstimate, job: harmonJob, customer: org.harmonCustomerId },
    output: () => lines.join("\n"),
    /** Everything a write would change: the org, every Supabase table, the auth users. */
    snapshot: () => JSON.stringify({ org: org.snapshot(), tables: [...db.tables].map(([t, rows]) => [t, rows]), users: db.users, secrets: [...w.secrets], files: [...w.files] }),
    run: (opts = {}) => verify(io, { apiBase: api.apiBase, delayMs: 0, retryDelayMs: 0, ...opts }),
  };
}

const levelLines = (x, level) => x.lines.filter((l) => l.startsWith(`${level} `));
const of = (report, check, level) => report.results.filter((r) => r.check === check && (!level || r.level === level));
function assertClean(x, report) {
  assert.deepEqual(levelLines(x, "FAIL"), [], "no FAIL line");
  assert.deepEqual(levelLines(x, "ERROR"), [], "no ERROR line");
  assert.equal(report.exitCode, 0);
}
/** The run failed, check `check` said FAIL, and the FAIL names `id`. */
function assertFails(x, report, check, id) {
  assert.equal(report.exitCode, 1, "the run must fail");
  const fails = of(report, check, "FAIL");
  assert.ok(fails.length > 0, `${check} must FAIL — got:\n${x.lines.filter((l) => /^(FAIL|ERROR)/.test(l)).join("\n") || "(no FAIL or ERROR line)"}`);
  const text = fails.map((f) => [f.message, ...f.details].join("\n")).join("\n");
  assert.ok(text.includes(id), `the ${check} failure must name ${id}:\n${text}`);
  assert.ok(x.output().includes(id), "and the id is printed");
  assert.match(x.output(), /VERDICT[\s\S]*FAILED:/);
}

// ---------------------------------------------------------------------------------------
// (1) the clean org
// ---------------------------------------------------------------------------------------
test("(1) a clean seeded org, BEFORE the cache sync: every check passes, exit 0, and the demo user's lists are not read", async () => {
  const x = await buildWorld();
  const report = await x.run();
  assertClean(x, report);
  for (const check of ["A1", "A2", "A3", "A4", "A5", "A6a", "A6b", "B4a", "B1", "B3", "B4", "C1", "C2", "C3", "C4"]) {
    assert.ok(of(report, check, "PASS").length >= 1, `${check} passes:\n${x.output()}`);
  }
  assert.equal(of(report, "B2", "INFO").length, 1, "before the sync the cache count is information");
  assert.match(of(report, "B2", "INFO")[0].message, /^0 of \d+ cacheable demo records/);
  assert.equal(of(report, "C5", "SKIP").length, 1);
  assert.match(of(report, "C5", "SKIP")[0].message, /fill the demo tenant's cache/);
  // The numbers are the seed's own.
  const seeded = Object.keys(x.idmap.ids).length;
  assert.match(of(report, "A3", "PASS")[0].message, new RegExp(`all ${seeded - 1} seeded records exist`));
  assert.match(of(report, "A2", "PASS")[0].message, new RegExp(`all ${seeded} ids`));
  assert.deepEqual(of(report, "A2", "PASS")[0].details.find((d) => d.startsWith(OBJ.customer)), `${OBJ.customer} 100`);
  // Every demo customer, project, roofing job, estimate, job and user was asked for as the Harmon user.
  const asked = (key) => x.api.requests.filter((r) => r.tenant === PRIMARY && new RegExp(`^/sf/${key}/[^/]+$`).test(r.path) && !r.query).length;
  assert.equal(asked("customer"), 100);
  assert.equal(asked("solar"), 50);
  assert.equal(asked("roofing"), 10);
  assert.equal(asked("estimate"), 51);
  assert.equal(asked("job"), 45);
  assert.equal(asked("user"), 11);
  for (const key of C2_SAMPLED) assert.equal(asked(key), 10, key);
  assert.equal(x.api.requests.filter((r) => r.tenant === PRIMARY && r.query === "?full=true" && /^\/sf\/(customer|solar)\//.test(r.path)).length, 10 + 1, "5 + 5 full reads of demo records, and the control read");
  assert.ok(x.api.requests.some((r) => r.path === "/service/board" && r.tenant === PRIMARY));
  assert.ok(x.api.requests.filter((r) => r.path === "/sf/customer" && /^\?q=/.test(r.query) && r.tenant === PRIMARY).length >= 11, "10 names and the phones");
  // BEFORE the sync the demo login makes no list call — it would fill the cache.
  assert.deepEqual(x.api.requests.filter((r) => r.tenant === x.demoTenant && /^\/sf\/[a-z]+$/.test(r.path)), []);
  assert.deepEqual(x.api.coldFills, [], "no list read made the portal fill a cache");
  assert.equal(x.db.tables.get("sundial_customer_cache").filter((r) => r.client_sf_id === x.demoTenant).length, 0);
  // Only the two test logins were used, and only the two secrets read.
  assert.deepEqual(x.loginCalls, [zzEmail("exec"), AVERY]);
  assert.deepEqual([...new Set(x.secretReads)].sort(), [DEMO_USERS_SECRET, TEST_USERS_SECRET].sort());
  assert.match(x.output(), /READ-ONLY/);
  assert.match(x.output(), /It is safe to run the cache sync\. Run this again afterwards with --after-sync\./);
  assert.match(x.output(), /does not cover: Salesforce's own screens and XFiles/);
  assert.match(x.output(), /section A issued \d+ Salesforce queries and \d+ describes/);
});

test("(1) a clean seeded org, AFTER a cache sync (--after-sync): every check passes, the cache and the demo lists hold exactly the demo's records", async () => {
  const x = await buildWorld({ sync: true });
  const report = await x.run({ afterSync: true });
  assertClean(x, report);
  for (const check of ["A3", "A4", "A6a", "A6b", "B1", "B2", "B3", "B4", "B4a", "C1", "C2", "C3", "C4", "C5"]) {
    assert.ok(of(report, check, "PASS").length >= 1, `${check} passes:\n${x.output()}`);
  }
  // (probe.json does not carry sundial_po_cache, so the fake project has no such table — the one SKIP.)
  assert.deepEqual(report.results.filter((r) => r.level === "SKIP").map((r) => `${r.check} ${r.message}`), ["B2 cache table(s) not there, not counted: sundial_po_cache (PGRST205)"]);
  const cacheable = Object.values(CACHE_OBJECTS).reduce((n, c) => n + x.mine(c.sfObject).length, 0);
  assert.match(of(report, "B1", "PASS")[0].message, new RegExp(`^${cacheable} cache rows exist`));
  assert.ok(x.api.requests.some((r) => r.tenant === x.demoTenant && r.path === "/sf/customer"), "the demo user's lists are read");
  assert.deepEqual(x.api.coldFills, [], "and they came from the cache");
  assert.match(x.output(), /This run was made after the cache sync/);
  // The same org without the flag also passes: rows already cached are information.
  const y = await buildWorld({ sync: true });
  assertClean(y, await y.run());
  assert.match(y.output(), /INFO {2}B2 .*cacheable demo records are in the cache/);
});

test("(1) records made by hand in the demo tenant are reported as information, and checked like the rest", async () => {
  const x = await buildWorld();
  const extra = x.org.insertRaw(OBJ.customer, { Name: "Made In The Portal", Client__c: x.demoTenant, Status__c: "Lead" });
  const report = await x.run();
  assertClean(x, report);
  const info = of(report, "A4", "INFO")[0];
  assert.ok(info.details.some((d) => d.includes(extra)));
  assert.ok(x.api.requests.some((r) => r.tenant === PRIMARY && r.path === `/sf/customer/${extra}`), "the Harmon user is refused the extra record too");
});

// ---------------------------------------------------------------------------------------
// (2)–(9) one fault each
// ---------------------------------------------------------------------------------------
test("(2) a seeded customer that carries the PRIMARY tenant -> A3 and A4 fail and name it", async () => {
  const x = await buildWorld();
  const victim = x.idmap.ids["customer:007"];
  x.org.get(victim).Client__c = PRIMARY;
  const report = await x.run({ skipApi: true });
  assertFails(x, report, "A3", victim);
  assert.match(of(report, "A3", "FAIL")[0].details.join("\n"), /carries tenant a1W7y000007AszBEAS \(harmon\)/);
  assertFails(x, report, "A4", victim);
  assert.match(x.output(), /NOT verified as isolated\. Do not run the cache sync until this is understood/);
  assert.doesNotMatch(x.output(), /It is safe to run the cache sync/);
});

test("(3) a seeded record that was deleted -> A3 fails and names it", async () => {
  const x = await buildWorld();
  const victim = x.idmap.ids["solar:003"];
  x.org.records.get(OBJ.solar).delete(victim);
  const report = await x.run({ skipApi: true });
  assertFails(x, report, "A3", victim);
  assert.match(of(report, "A3", "FAIL")[0].details.join("\n"), /not in Salesforce/);
});

test("(4) a tenant-less roofing record created after the anchor -> A5 fails and names it; an old one does not", async () => {
  const x = await buildWorld();
  x.org.insertRaw(OBJ.roofing, { Name: "ROOF-OLD", Sundial_Customer__c: x.harmon.customer, CreatedDate: "2026-06-01T00:00:00.000Z" });
  assertClean(x, await x.run({ skipApi: true }));
  const y = await buildWorld();
  const orphan = y.org.insertRaw(OBJ.roofing, { Name: "ROOF-LOST", Sundial_Customer__c: y.harmon.customer, CreatedDate: "2026-09-29T18:30:00.000Z" });
  const report = await y.run({ skipApi: true });
  assertFails(y, report, "A5", orphan);
  assert.ok(y.soql.some((s) => /^SELECT COUNT\(Id\) c FROM Sundial_Roofing__c WHERE Client__c = null AND CreatedDate >= 2026-09-28T00:00:00Z$/.test(s)), "the day before the anchor, as an unquoted SOQL date-time");
});

test("(5) a demo job whose customer lookup points to a primary-tenant customer -> A6a fails and names both", async () => {
  const x = await buildWorld();
  const job = x.idmap.ids["job:004"];
  x.org.get(job).Sundial_Customer__c = x.harmon.customer;
  const report = await x.run({ skipApi: true });
  assertFails(x, report, "A6a", job);
  const line = of(report, "A6a", "FAIL")[0].details.find((d) => d.includes(job));
  assert.ok(line.includes(`${x.harmon.customer} (${OBJ.customer})`), "the other tenant's record is named by id and object only");
  assert.doesNotMatch(x.output(), /A Real Harmon Customer|867-5309/, "never its name or phone");
});

test("(6) a primary-tenant estimate that points at a demo customer -> A6b fails and names it", async () => {
  const x = await buildWorld();
  const demoCustomer = x.idmap.ids["customer:011"];
  const estimate = x.org.insertRaw(OBJ.estimate, { Name: "EST-H2", Client__c: PRIMARY, Sundial_Customer__c: demoCustomer, Status__c: "Draft" });
  const report = await x.run({ skipApi: true });
  assertFails(x, report, "A6b", estimate);
  assert.ok(of(report, "A6b", "FAIL")[0].details[0].includes(demoCustomer));
  assert.ok(x.soql.some((s) => s.startsWith(`SELECT Id, Sundial_Customer__c FROM ${OBJ.estimate} WHERE (Client__c != '${x.demoTenant}' OR Client__c = null) AND Sundial_Customer__c IN (`)), "the real query shape was used");
});

test("(6) a record with NO tenant, and a record of an object that has no tenant field, pointing at a demo record -> A6b fails", async () => {
  const x = await buildWorld();
  const demoCustomer = x.idmap.ids["customer:020"];
  const commercial = x.org.insertRaw("Sundial_Commercial__c", { Name: "COM-0001", Sundial_Customer__c: demoCustomer });
  const orphanRoof = x.org.insertRaw(OBJ.roofing, { Name: "ROOF-X", Sundial_Customer__c: demoCustomer, CreatedDate: "2026-01-01T00:00:00.000Z" });
  const report = await x.run({ skipApi: true });
  assertFails(x, report, "A6b", commercial);
  assertFails(x, report, "A6b", orphanRoof);
  assert.ok(x.soql.some((s) => s.startsWith("SELECT Id, Sundial_Customer__c FROM Sundial_Commercial__c WHERE Sundial_Customer__c IN (")), "no tenant clause on an object without a tenant");
});

test("(7) a cache row for a demo customer stamped with the primary tenant -> B1 fails and names it (and the API section sees the leak)", async () => {
  // before the sync: one stray row
  const x = await buildWorld();
  // (the first demo customer by id is one of the ten whose names the Harmon user searches for)
  const victim = x.mine(OBJ.customer).map((c) => c.Id).sort()[0];
  x.db.tables.get("sundial_customer_cache").push(cacheRowOf(x.org, x.db, "customer", x.org.get(victim), PRIMARY, "harmon", "2026-09-29T18:00:00.000Z"));
  const report = await x.run();
  assertFails(x, report, "B1", victim);
  assertFails(x, report, "C2", victim); // the fake API serves the cache by its stamp, as the real one does
  assertFails(x, report, "C3", victim); // …and the Harmon user's search finds it
  // after the sync: a row re-stamped, and one that holds the 15-character id
  const y = await buildWorld({ sync: true });
  const v2 = y.idmap.ids["solar:010"];
  const row = y.db.tables.get("sundial_solar_cache").find((r) => r.sf_id === v2);
  row.client_sf_id = PRIMARY;
  const v3 = y.idmap.ids["customer:040"];
  y.db.tables.get("sundial_customer_cache").push({ ...cacheRowOf(y.org, y.db, "customer", y.org.get(v3), PRIMARY, "harmon", "x"), sf_id: id15(v3) });
  const r2 = await y.run({ afterSync: true, skipApi: true });
  assertFails(y, r2, "B1", v2);
  assertFails(y, r2, "B1", id15(v3));
  assertFails(y, r2, "B2", v2); // and the demo's own count is now one short
});

test("(7) a cache row whose tenant SLUG is wrong, and a primary-tenant record cached under the demo tenant -> B1 / B2 fail", async () => {
  const x = await buildWorld({ sync: true });
  const v = x.idmap.ids["customer:002"];
  x.db.tables.get("sundial_customer_cache").find((r) => r.sf_id === v).tenant_id = "harmon";
  x.db.tables.get("sundial_customer_cache").find((r) => r.sf_id === x.harmon.customer).client_sf_id = x.demoTenant;
  const report = await x.run({ afterSync: true });
  assertFails(x, report, "B1", v);
  assertFails(x, report, "B2", x.harmon.customer);
  assertFails(x, report, "C5", x.harmon.customer); // the demo user's customer list now shows a Harmon customer
  assert.doesNotMatch(x.output(), /A Real Harmon Customer|867-5309/);
});

test("(7) after the sync, a demo record missing from the cache -> B2 and C5 fail and name it", async () => {
  const x = await buildWorld({ sync: true });
  const v = x.idmap.ids["job:009"];
  const table = x.db.tables.get("sundial_service_job_cache");
  table.splice(table.findIndex((r) => r.sf_id === v), 1);
  const report = await x.run({ afterSync: true });
  assertFails(x, report, "B2", v);
  assertFails(x, report, "C5", v);
  assert.match(of(report, "B2", "FAIL")[0].message, /not a leak/);
});

test("(8) an activity row for a demo job under the primary tenant -> B3 fails and names it; so do a text, a note, a notification and a file row", async () => {
  const x = await buildWorld();
  const job = x.idmap.ids["job:002"];
  const customer = x.idmap.ids["customer:050"];
  const avery = x.idmap.supabase.authUsers["user:avery"];
  x.db.tables.get("sundial_service_activity").push({ id: 900001, client_sf_id: PRIMARY, tenant_id: "harmon", event: "job.updated", record_type: "job", record_sf_id: job, job_sf_id: job, estimate_sf_id: null, actor_user_sf_id: null, actor_name: null, details: {}, at: "2026-09-29T18:00:00Z" });
  x.db.tables.get("sundial_sms_messages").push({ id: 900002, client_sf_id: PRIMARY, tenant_id: "harmon", direction: "out", job_sf_id: null, customer_sf_id: customer, provider_sid: "SMx" });
  x.db.tables.get("comments").push({ id: "c0000000-0000-4000-8000-000000000001", tenant_id: PRIMARY, record_id: customer, record_object: "customer", author_id: "11111111-1111-4111-8111-111111111111", author_name: "x", body: "x", created_at: "2026-09-29T18:00:00Z" });
  x.db.tables.get("sundial_notifications").push({ id: "d0000000-0000-4000-8000-000000000001", client_sf_id: PRIMARY, profile_id: avery, user_sf_id: null, record_sf_id: null, dedupe_key: "k1" });
  x.db.tables.get("sundial_file_metadata").push({ id: "e0000000-0000-4000-8000-000000000001", tenant_id: PRIMARY, s3_key: `SUNDIAL/${id15(job)}/x.pdf`, sf_record_id: id15(job), file_name: "x.pdf" });
  const report = await x.run({ skipApi: true });
  assertFails(x, report, "B3", job);
  const text = of(report, "B3", "FAIL")[0].details.join("\n");
  assert.match(text, /sundial_service_activity row 900001: record_sf_id = demo record .*, job_sf_id = demo record .* but client_sf_id = a1W7y000007AszBEAS \(harmon\)/);
  assert.match(text, /sundial_sms_messages row 900002/);
  assert.match(text, /comments row c0000000/);
  assert.match(text, /sundial_notifications row d0000000.*profile_id = a demo login/);
  assert.match(text, /sundial_file_metadata row e0000000/, "found by the 15-character form of the id");
});

test("(8) a row under the DEMO tenant that is about a primary-tenant record -> B3 fails", async () => {
  const x = await buildWorld();
  x.db.tables.get("sundial_service_activity").push({ id: 900003, client_sf_id: x.demoTenant, tenant_id: "conops-demo", event: "job.updated", record_type: "job", record_sf_id: x.harmon.job, job_sf_id: x.harmon.job, at: "2026-09-29T18:00:00Z" });
  const report = await x.run({ skipApi: true });
  assertFails(x, report, "B3", x.harmon.job);
});

test("(9) the API returns 200 for a demo customer to the Harmon user -> C2 fails and names it", async () => {
  const x = await buildWorld();
  const victim = x.idmap.ids["customer:064"];
  x.api.serveAnyway.add(victim);
  const report = await x.run();
  assertFails(x, report, "C2", victim);
  assert.equal(of(report, "C2", "PASS").length, 0);
  assert.match(x.output(), /WAS SERVED 1 demo record/);
});

test("(9) the Harmon user's customer search returns a demo id -> C3 fails and names it", async () => {
  const x = await buildWorld();
  const victim = x.idmap.ids["customer:077"];
  x.api.addToSearch.push(victim);
  const report = await x.run();
  assertFails(x, report, "C3", victim);
  assert.match(of(report, "C3", "FAIL")[0].details[0], /in the answer to GET \/sf\/customer\?q=/);
});

test("(9) a demo login's uuid is also on a primary-tenant Sundial_User__c -> B4a fails and names that user record", async () => {
  const x = await buildWorld();
  const avery = x.idmap.supabase.authUsers["user:avery"];
  const intruder = x.org.insertRaw(OBJ.user, { Last_Name__c: "Twin", Email__c: "twin@harmon.example", Client__c: PRIMARY, Active__c: true, Supabase_User_Id__c: avery });
  const report = await x.run({ skipApi: true });
  assertFails(x, report, "B4a", intruder);
  assert.doesNotMatch(x.output(), /twin@harmon\.example/);
});

test("(9) a demo login's profile row carries the primary tenant, or another login's carries the demo tenant -> B4 fails", async () => {
  const x = await buildWorld();
  const dana = x.idmap.supabase.authUsers["user:dana"];
  x.db.tables.get("profiles").find((p) => p.id === dana).tenant_id = PRIMARY;
  x.db.tables.get("profiles").find((p) => p.email === zzEmail("admin")).tenant_id = x.demoTenant;
  const report = await x.run({ skipApi: true });
  assertFails(x, report, "B4", dana);
  assertFails(x, report, "B4", "aaaaaaaa-0000-4000-8000-000000000002");
});

test("(9) the demo login is served a primary-tenant ZZ TEST record -> C4 fails, naming it by id and object only", async () => {
  const x = await buildWorld();
  x.api.serveAnyway.add(x.zz.solar);
  const report = await x.run();
  assertFails(x, report, "C4", x.zz.solar);
  assert.match(of(report, "C4", "FAIL")[0].details[0], new RegExp(`^${x.zz.solar} \\(${OBJ.solar}\\) — GET /sf/solar/`));
  // Only the designated test records were ever asked for as the demo user.
  const askedAsDemo = x.api.requests.filter((r) => r.tenant === x.demoTenant && /^\/sf\/[a-z]+\/./.test(r.path)).map((r) => r.path.split("/")[3]);
  const allowed = new Set([x.zz.customer, x.zz.solar, x.zz.roofing, ...Object.values(x.idmap.ids)]);
  for (const id of askedAsDemo) assert.ok(allowed.has(id), `${id} is neither a ZZ test record nor a demo record`);
  assert.ok(!askedAsDemo.includes(x.harmon.customer), "never a live customer");
});

test("a demo record deleted in Salesforce leaves rows behind: reported as leftovers (INFO), not as another tenant's record", async () => {
  const x = await buildWorld();
  const extra = x.org.insertRaw(OBJ.customer, { Name: "Made Then Deleted", Client__c: x.demoTenant, Status__c: "Lead" });
  simulateCacheSync(x.org, x.db);
  x.db.tables.get("sundial_service_activity").push({ id: 900010, client_sf_id: x.demoTenant, tenant_id: "conops-demo", event: "customer.updated", record_type: "customer", record_sf_id: extra, at: "2026-09-29T18:00:00Z" });
  x.db.tables.get("sundial_notifications").push({ id: "d0000000-0000-4000-8000-000000000009", client_sf_id: x.demoTenant, profile_id: x.idmap.supabase.authUsers["user:dana"], record_sf_id: "001000000000999AAA", dedupe_key: "k9" });
  x.org.records.get(OBJ.customer).delete(extra);
  const report = await x.run({ afterSync: true });
  assertClean(x, report);
  assert.ok(of(report, "B2", "INFO").some((r) => r.details.some((d) => d.includes(extra) && /deleted in Salesforce/.test(d))));
  assert.ok(of(report, "B3", "INFO").some((r) => /no longer exists in Salesforce/.test(r.message) && r.details.some((d) => d.includes(extra))));
  assert.ok(of(report, "B3", "INFO").some((r) => /not the id of any Sundial object/.test(r.message) && r.details.some((d) => d.includes("001000000000999AAA"))));
  assert.ok(of(report, "C5", "INFO").some((r) => r.details.some((d) => d.includes(extra))));
  assert.ok(x.soql.some((s) => s.startsWith(`SELECT Id, Client__c FROM ${OBJ.customer} WHERE Id IN ('${extra}')`)), "Salesforce was asked what the id is");
});

test("a search that returns only its first 200 matches is said so (the demo row would be among the newest)", async () => {
  const x = await buildWorld();
  const first = x.org.get(x.mine(OBJ.customer).map((c) => c.Id).sort()[0]);
  for (let i = 0; i < 230; i++) x.org.insertRaw(OBJ.customer, { Name: first.Name, Client__c: PRIMARY, Status__c: "Lead" });
  simulateCacheSync(x.org, x.db, { onlyTenant: PRIMARY });
  const report = await x.run({ quick: true });
  assertClean(x, report);
  const info = of(report, "C3", "INFO").find((r) => /only part of what matched/.test(r.message));
  assert.match(info.details[0], /the first 200 of 23\d matches were returned and scanned/);
});

// ---------------------------------------------------------------------------------------
// a wrong assumption must end as SKIP or ERROR — never as PASS
// ---------------------------------------------------------------------------------------
test("a cache table that does not exist is SKIPPED and named in the verdict; a table that errors is an ERROR and fails the run", async () => {
  const x = await buildWorld({ supabase: { missingTables: ["sundial_membership_cache", "sundial_service_job_cache"] } });
  const report = await x.run({ skipApi: true });
  assert.equal(report.exitCode, 0);
  assert.match(of(report, "B1", "SKIP")[0].message, /sundial_service_job_cache \(PGRST205\)/);
  assert.match(x.output(), /NOT CHECKED in this run:[\s\S]*B1: cache table\(s\) not there/);
  const y = await buildWorld({ supabase: { brokenTables: ["sundial_customer_cache"] } });
  const r2 = await y.run({ skipApi: true });
  assert.equal(r2.exitCode, 1);
  assert.match(of(r2, "B1", "ERROR")[0].message, /sundial_customer_cache could not be read: 57014/);
  assert.match(y.output(), /COULD NOT BE COMPLETED/);
});

test("a Supabase project with a low Max Rows setting is still read in full", async () => {
  const x = await buildWorld({ sync: true, supabase: { maxRows: 37 } });
  const report = await x.run({ afterSync: true, skipApi: true });
  assertClean(x, report);
  const activity = x.db.tables.get("sundial_service_activity").filter((r) => r.client_sf_id === x.demoTenant).length;
  assert.ok(activity > 700);
  assert.ok(of(report, "B3", "PASS")[0].details.some((d) => d.includes("sundial_service_activity") && d.includes(String(activity))), "every activity row was read");
  assert.ok(x.ro.state.longestInList < 8000, "and no filter list is too long for a URL");
});

test("an answer that is not the portal's own 'not found' is an ERROR, not a refusal: gateway 404, 5xx, a dead login", async () => {
  // API Gateway's 404 for a route it does not have
  const x = await buildWorld();
  x.api.failWith = (method, path) => (/^\/sf\/solar\//.test(path) ? 404 : null);
  const report = await x.run({ quick: true });
  assert.equal(report.exitCode, 1);
  assert.equal(of(report, "C2", "PASS").length, 0);
  assert.match(of(report, "C2", "ERROR")[0].message, /did not get a clear answer/);
  assert.equal(of(report, "C2", "FAIL").length, 0, "and it is not called a leak either");
  // a 500 is retried once, then reported
  const y = await buildWorld();
  const victim = y.idmap.ids["customer:001"];
  y.api.failWith = (method, path, u) => (path === `/sf/customer/${victim}` && !u.search ? 500 : null);
  const r2 = await y.run({ quick: true });
  assert.equal(r2.exitCode, 1);
  assert.ok(of(r2, "C2", "ERROR")[0].details.some((d) => d.includes(victim) && d.includes("HTTP 500")));
  assert.equal(y.api.requests.filter((r) => r.path === `/sf/customer/${victim}` && !r.query).length, 2, "one retry");
  // a login whose user record is gone: every read answers 403 NO_SUNDIAL_USER — that is not a refusal of the record
  const z = await buildWorld();
  z.api.failWith = null;
  const realFetch = z.io.fetch;
  let broken = false;
  z.io.fetch = async (url, init) => {
    if (broken && /\/sf\/estimate\//.test(url)) return { status: 403, text: async () => JSON.stringify({ error: "no_portal_user", code: "NO_SUNDIAL_USER" }) };
    return realFetch(url, init);
  };
  broken = true;
  const r3 = await z.run({ quick: true });
  assert.equal(r3.exitCode, 1);
  assert.ok(of(r3, "C2", "ERROR")[0].details.some((d) => /\/sf\/estimate\/.*HTTP 403 NO_SUNDIAL_USER/.test(d)));
});

test("C1: a test user that is not a primary-tenant user stops the API checks with a FAIL; a failed control read is an ERROR; no login is an ERROR", async () => {
  const x = await buildWorld();
  const other = x.org.insertRaw(OBJ.tenant, { Name: "somebody-else" });
  x.org.get(x.zz.exec).Client__c = other;
  const report = await x.run();
  assert.equal(report.exitCode, 1);
  assert.match(of(report, "C1", "FAIL")[0].message, /test user is not a Harmon tenant-scope user/);
  for (const check of ["C2", "C3", "C4", "C5"]) assert.equal(of(report, check).length, 0, `${check} is not run`);
  assert.match(of(report, "C", "SKIP")[0].message, /C2–C5 were not run/);
  assert.deepEqual(x.loginCalls, [zzEmail("exec")], "section C is aborted: the demo login is not even signed in");
  assert.equal(x.api.requests.filter((r) => r.path !== "/auth/me").length, 0);
  // wrong password for exec -> falls back to admin
  const y = await buildWorld();
  y.logins.get(zzEmail("exec")).password = "changed-Zq9!";
  assertClean(y, await y.run({ quick: true }));
  assert.deepEqual(y.loginCalls.slice(0, 2), [zzEmail("exec"), zzEmail("admin")]);
  assert.match(y.output(), /signed in as the harmon ZZ TEST user tim\+zz-admin@/);
  // nobody can sign in
  const z = await buildWorld();
  for (const slug of ["exec", "admin"]) z.logins.get(zzEmail(slug)).password = "changed-Zq9!";
  const r3 = await z.run({ quick: true });
  assert.equal(r3.exitCode, 1);
  assert.match(of(r3, "C1", "ERROR")[0].message, /could not sign in/);
  // the publishable key cannot be resolved
  const k = await buildWorld();
  k.io.resolveSupabasePublic = () => { throw new Error("Could not resolve the Supabase URL and publishable key."); };
  const r4 = await k.run();
  assert.equal(r4.exitCode, 1);
  assert.equal(k.loginCalls.length, 0);
  assert.match(of(r4, "C1", "ERROR")[0].message, /section C was not run/);
});

test("--after-sync on a cache that was never filled: B2 fails, and the demo login's lists are NOT read (reading them would fill the cache)", async () => {
  const x = await buildWorld(); // the demo's cache is empty
  const before = x.snapshot();
  const report = await x.run({ afterSync: true, quick: true });
  assert.equal(report.exitCode, 1);
  assert.match(of(report, "B2", "FAIL")[0].message, /does not hold every demo record/);
  assert.equal(of(report, "C5", "SKIP")[0].details.length, 5);
  assert.match(of(report, "C5", "SKIP")[0].details[0], /the cache holds no demo row for it \(see B2\) — reading the list would make the portal fill it/);
  assert.equal(of(report, "C5", "PASS").length, 0);
  assert.deepEqual(x.api.requests.filter((r) => r.tenant === x.demoTenant && /^\/sf\/[a-z]+$/.test(r.path)), []);
  assert.deepEqual(x.api.coldFills, []);
  assert.equal(x.snapshot(), before);
});

test("an answer that is 200 but not shaped as expected is an ERROR, not 'nothing found'", async () => {
  const x = await buildWorld();
  const realFetch = x.io.fetch;
  x.io.fetch = async (url, init) => {
    if (/\/sf\/users$/.test(url)) return { status: 200, text: async () => "<html>maintenance</html>" };
    if (/\/service\/board\?/.test(url)) return { status: 200, text: async () => JSON.stringify({ ok: true }) };
    return realFetch(url, init);
  };
  const report = await x.run({ quick: true });
  assert.equal(report.exitCode, 1);
  assert.equal(of(report, "C3", "PASS").length, 0);
  const details = of(report, "C3", "ERROR")[0].details.join("\n");
  assert.match(details, /users lookup: the answer has no "users" list/);
  assert.match(details, /dispatch board .*: the answer has no "calls" list/);
});

test("C4: a demo login that resolves into another tenant is a FAIL; with no ZZ record the check is SKIPPED", async () => {
  const x = await buildWorld();
  x.org.get(x.idmap.ids["user:avery"]).Client__c = PRIMARY;
  const report = await x.run({ quick: true });
  assert.equal(report.exitCode, 1);
  assert.match(of(report, "C4", "FAIL")[0].message, /NOT the demo tenant/);
  const y = await buildWorld();
  for (const [o, id] of [[OBJ.customer, y.zz.customer], [OBJ.solar, y.zz.solar], [OBJ.roofing, y.zz.roofing]]) y.org.records.get(o).delete(id);
  const r2 = await y.run({ quick: true });
  assert.equal(r2.exitCode, 0);
  assert.match(of(r2, "C4", "SKIP")[0].message, /a live customer is never used/);
  assert.match(y.output(), /no control read for this login/);
});

test("the run is REFUSED when the id-map names the primary tenant, is missing, or its tenant does not exist", async () => {
  const x = await buildWorld();
  x.io.readIdMap = async () => ({ ...x.idmap, ids: { ...x.idmap.ids, tenant: PRIMARY } });
  const report = await x.run();
  assert.equal(report.exitCode, 1);
  assert.match(report.refused, /primary tenant/);
  assert.equal(x.soql.length, 0, "nothing was queried");
  assert.equal(x.api.requests.length, 0);
  assert.match(x.output(), /NOT RUN/);
  const y = await buildWorld();
  y.io.readIdMap = async () => ({ ...y.idmap, tenantSlug: "harmon" });
  assert.match((await y.run()).refused, /primary tenant/);
  const z = await buildWorld();
  z.io.readIdMap = async () => null;
  const r3 = await z.run();
  assert.equal(r3.exitCode, 1);
  assert.match(r3.refused, /no usable id-map/);
  const v = await buildWorld();
  v.org.records.get(OBJ.tenant).delete(v.demoTenant);
  const r4 = await v.run();
  assert.equal(r4.exitCode, 1);
  assert.match(of(r4, "A1", "FAIL")[0].details[0], /does not exist/);
  assert.equal(v.api.requests.length, 0);
});

test("A2: an id whose prefix belongs to no Sundial object fails; the key NAME is not trusted", async () => {
  const x = await buildWorld();
  const solarId = x.idmap.ids["solar:001"];
  x.io.readIdMap = async () => ({ ...x.idmap, ids: { ...x.idmap.ids, "customer:999": "001000000000123AAA", "customer:998": solarId } });
  const report = await x.run({ skipApi: true });
  assertFails(x, report, "A2", "001000000000123AAA");
  assert.ok(of(report, "A2", "INFO").some((r) => r.details.some((d) => d.includes("customer:998") && d.includes(OBJ.solar))), "a key that names the wrong object is said, and the id decides");
});

// ---------------------------------------------------------------------------------------
// (10) no write · (11) SOQL length · (12) no secret in the output
// ---------------------------------------------------------------------------------------
test("(10) the script writes nothing: the fakes throw on any write, and the world is byte-identical after a run", async () => {
  for (const mode of [{ sync: false, opts: {} }, { sync: true, opts: { afterSync: true } }]) {
    const x = await buildWorld({ sync: mode.sync });
    const before = x.snapshot();
    const creates = x.org.calls.creates.length;
    const updates = x.org.calls.updates.length;
    const report = await x.run(mode.opts);
    assertClean(x, report);
    assert.equal(x.snapshot(), before, "org, Supabase tables, logins, secrets and local files are unchanged");
    assert.equal(x.org.calls.creates.length, creates);
    assert.equal(x.org.calls.updates.length, updates);
    assert.deepEqual(x.ro.state.writes, [], "no Supabase write was attempted");
    assert.deepEqual(x.trapped, [], "no Salesforce / Secrets Manager / S3 / file write was attempted");
    assert.deepEqual(x.api.violations, [], "no request other than GET reached the API");
    assert.ok(x.api.requests.every((r) => r.method === "GET"));
    assert.ok(x.soql.every((s) => /^SELECT /.test(s)));
  }
  // The guards themselves work.
  const g = await buildWorld();
  await assert.rejects(() => g.api.fetch(`${g.api.apiBase}/sf/customer/x`, { method: "PATCH" }), /WRITE ATTEMPTED/);
  assert.equal(g.api.violations.length, 1);
  for (const m of ["insert", "upsert", "update", "delete"]) assert.throws(() => g.ro.client.from("comments")[m]({}), /WRITE ATTEMPTED/);
  assert.throws(() => g.ro.client.auth, /WRITE ATTEMPTED/);
  assert.equal(g.ro.state.writes.length, 5);
  await assert.rejects(() => g.io.sfCreateRecord("Sundial_Customer__c", {}), /WRITE ATTEMPTED/);
  await assert.rejects(() => g.io.sfUpdateRecord("Sundial_Customer__c", "x", {}), /WRITE ATTEMPTED/);
  assert.deepEqual(g.trapped, ["sfCreateRecord", "sfUpdateRecord"]);
});

test("(10) neither file of the script names a write function or a write verb", () => {
  for (const file of ["scripts/verify-demo-isolation.mjs", "scripts/demo-seed/verify-isolation.js"]) {
    const code = readFileSync(resolve(REPO, file), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    assert.doesNotMatch(code, /sfCreateRecord|sfUpdateRecord|sfDeleteRecord|sfUpsert/, file);
    assert.doesNotMatch(code, /\.(insert|upsert|update|delete|rpc)\(/, file);
    assert.doesNotMatch(code, /["'`](POST|PUT|PATCH|DELETE)["'`]/, file);
    assert.doesNotMatch(code, /writeFile|appendFile|createWriteStream|PutSecretValue|PutObject/, file);
  }
  const cli = readFileSync(resolve(REPO, "scripts/verify-demo-isolation.mjs"), "utf8");
  assert.match(cli, /import \{ sfQuery, describeObject \} from "\.\.\/lib\/salesforce\.js";/);
});

test("(11) no SOQL string is longer than 10,000 characters, and the number of queries stays sane", async () => {
  const x = await buildWorld({ sync: true });
  const report = await x.run({ afterSync: true });
  assertClean(x, report);
  const longest = Math.max(...x.soql.map((s) => s.length));
  assert.ok(longest <= MAX_SOQL_CHARS, `longest SOQL ${longest}`);
  assert.ok(longest < 4000, `longest SOQL ${longest}`);
  assert.equal(x.soql.length, report.stats.salesforceQueries);
  assert.ok(report.stats.salesforceQueries < 170, `${report.stats.salesforceQueries} queries`);
  assert.ok(report.stats.salesforceDescribes <= 20, `${report.stats.salesforceDescribes} describes`);
  assert.ok(report.stats.apiRequests < 420, `${report.stats.apiRequests} API requests`);
  // A much larger tenant still chunks: 400 extra demo customers.
  const y = await buildWorld();
  for (let i = 0; i < 400; i++) y.org.insertRaw(OBJ.customer, { Name: `Extra ${i}`, Client__c: y.demoTenant, Status__c: "Lead" });
  const r2 = await y.run({ skipApi: true });
  assertClean(y, r2);
  assert.ok(Math.max(...y.soql.map((s) => s.length)) <= MAX_SOQL_CHARS);
});

test("(12) no password, token or key appears in the output — lines, results or verdict, clean run or failing", async () => {
  for (const fault of [false, true]) {
    const x = await buildWorld({ sync: true });
    if (fault) {
      x.api.serveAnyway.add(x.idmap.ids["customer:005"]);
      x.logins.get(zzEmail("exec")).password = "changed-Zq9!"; // a refused sign-in is reported too
    }
    const report = await x.run({ afterSync: true });
    const everything = `${x.output()}\n${JSON.stringify(report)}`;
    assert.ok(x.issued.length >= 2);
    for (const secret of [...x.secrets, ...x.issued, "changed-Zq9!", "sb_publishable_FAKE-KEY-0001", "fake-password"]) {
      assert.ok(!everything.includes(secret), `the output contains a secret (${secret.slice(0, 6)}…)`);
    }
    assert.doesNotMatch(everything, /Bearer |eyJ/);
    // …nor any data of a record that is not the demo's.
    assert.doesNotMatch(everything, /A Real Harmon Customer|867-5309|someone@harmon\.example|Realperson/);
  }
});

// ---------------------------------------------------------------------------------------
// the script's copies of what the Lambdas and the tables are called
// ---------------------------------------------------------------------------------------
test("CACHE_OBJECTS is the OBJECT_ALLOWLIST of both Lambdas, and every table and column the script reads is in probe.json and sql/", () => {
  const probe = loadProbe();
  for (const lambda of ["sundial-sf-query", "sundial-cache-sync"]) {
    const src = readFileSync(resolve(REPO, "lambdas", lambda, "index.js"), "utf8");
    const block = /const OBJECT_ALLOWLIST = \{([\s\S]*?)\n\};/.exec(src)[1];
    const found = {};
    for (const m of block.matchAll(/(\w+):\s*\{\s*sfObject:\s*"(\w+)",\s*cacheTable:\s*"(\w+)",?\s*\}/g)) found[m[1]] = { sfObject: m[2], cacheTable: m[3] };
    assert.deepEqual(found, { ...CACHE_OBJECTS }, lambda);
  }
  const snapshot = readFileSync(resolve(REPO, "sql", "live-snapshot-2026-08-27.sql"), "utf8");
  for (const { sfObject, cacheTable } of Object.values(CACHE_OBJECTS)) {
    assert.ok(probe.salesforce[sfObject], sfObject);
    const cols = probe.supabase[cacheTable]?.columns;
    if (!cols) {
      // The probe did not look at this table; the live snapshot in sql/ has it.
      assert.equal(cacheTable, "sundial_po_cache");
      const start = snapshot.indexOf(`-- ---- public.${cacheTable} -`);
      assert.ok(start > 0, `${cacheTable} is in sql/live-snapshot-2026-08-27.sql`);
      const block = snapshot.slice(start, snapshot.indexOf("-- ---- public.", start + 20));
      for (const c of ["sf_id", "client_sf_id", "tenant_id"]) assert.match(block, new RegExp(`\\| ${c} +\\|`), `${cacheTable}.${c}`);
      continue;
    }
    for (const c of ["sf_id", "client_sf_id", "tenant_id"]) assert.ok(c in cols, `${cacheTable}.${c}`);
  }
  for (const t of RECORD_TABLES) {
    const cols = probe.supabase[t.table]?.columns;
    assert.ok(cols, `${t.table} is in probe.json`);
    for (const c of [t.pk, t.tenantCol, ...(t.slugCol ? [t.slugCol] : []), ...t.refs, ...t.auth]) assert.ok(c in cols, `${t.table}.${c}`);
  }
  for (const c of ["id", "tenant_id", "sundial_user_id"]) assert.ok(c in probe.supabase.profiles.columns);
  for (const o of KNOWN_OBJECTS) assert.ok(probe.salesforce[o], `${o} is in probe.json`);
  // The API keys the script asks for one by one are real keys.
  for (const key of [...C2_EVERY, ...C2_SAMPLED]) assert.ok(CACHE_OBJECTS[key], key);
  // The response shapes and route details the script relies on are still in the Lambdas' source.
  const query = readFileSync(resolve(REPO, "lambdas/sundial-sf-query/index.js"), "utf8");
  assert.match(query, /code: "RECORD_NOT_FOUND"/);
  assert.match(query, /String\(qs\.full\)\.toLowerCase\(\) === "true"/);
  assert.match(query, /hasMore: offset \+ records\.length < adjustedTotal/);
  assert.match(query, /phone: \["primary_phone", "alternate_contact_phone"\]/);
  const auth = readFileSync(resolve(REPO, "lambdas/sundial-auth-proxy/index.js"), "utf8");
  assert.match(auth, /tenant: \{ clientId: identity\.tenantId, slug: identity\.tenantSlug \?\? null \}/);
  const board = readFileSync(resolve(REPO, "lambdas/sundial-service-board/index.js"), "utf8");
  assert.match(board, /const from = isoOrNull\(query\?\.from\);/);
  assert.match(board, /maxWindowDays: 42/);
});

test("the live org's odd corners are handled from the describe: a PO's Client__c is a user lookup, Commercial has no tenant", async () => {
  const x = await buildWorld();
  const report = await x.run({ skipApi: true });
  const info = of(report, "A6b", "INFO")[0].message;
  assert.match(info, /Sundial_Commercial__c/);
  assert.match(info, /Sundial_PO__c \(its Client__c points to Sundial_User__c\)/);
  assert.ok(x.soql.some((s) => s.startsWith("SELECT Id, Client__c FROM Sundial_PO__c WHERE Client__c IN (")), "so it is checked as an ordinary link to a demo user");
  assert.ok(!x.soql.some((s) => /FROM Sundial_PO__c WHERE Client__c = /.test(s)), "and never as a tenant");
  assert.match(of(report, "A2", "INFO").map((r) => r.message).join("\n"), /not in this org \(skipped\): Sundial_Service__c/);
  // A PO that points at a demo user is found.
  const y = await buildWorld();
  const po = y.org.insertRaw("Sundial_PO__c", { Name: "PO-00001", Client__c: y.idmap.ids["user:dana"] });
  assertFails(y, await y.run({ skipApi: true }), "A6b", po);
});

// ---------------------------------------------------------------------------------------
// small things
// ---------------------------------------------------------------------------------------
test("--quick asks for 5 records per object; the sample is the same on every run", async () => {
  const x = await buildWorld();
  const report = await x.run({ quick: true });
  assertClean(x, report);
  const single = x.api.requests.filter((r) => r.tenant === PRIMARY && /^\/sf\/[a-z]+\/[^/]+$/.test(r.path) && !r.query);
  assert.equal(single.length, 11 * 5);
  const y = await buildWorld();
  await y.run({ quick: true });
  const paths = (z) => z.api.requests.filter((r) => r.tenant === PRIMARY && /^\/sf\/customer\//.test(r.path)).map((r) => r.path).sort();
  assert.deepEqual(paths(x), paths(y));
  assert.deepEqual(sampleIds(["d", "a", "c", "b", "e"], 3), ["a", "c", "e"]);
  assert.deepEqual(sampleIds(["b", "a"], 5), ["a", "b"]);
});

test("findDemoIds finds an id in its 15- and 18-character form, inside a URL or a longer token, and nothing else", () => {
  const demo = new Set(["a0BZ00000000042"]);
  assert.deepEqual(findDemoIds('{"sf_id":"a0BZ00000000042AAA"}', demo), ["a0BZ00000000042"]);
  assert.deepEqual(findDemoIds('{"url":"/service/jobs/a0BZ00000000042"}', demo), ["a0BZ00000000042"]);
  assert.deepEqual(findDemoIds('{"key":"xx9a0BZ00000000042AAAzz"}', demo), ["a0BZ00000000042"]);
  assert.deepEqual(findDemoIds('{"sf_id":"a0BZ00000000043AAA","n":"a0bz00000000042aaa"}', demo), [], "ids are case-sensitive");
  assert.deepEqual(findDemoIds("", demo), []);
});

test("the command line: the switches, an unknown option, and the script file loads without running", async () => {
  assert.deepEqual(parseVerifyArgs(["--after-sync", "--quick", "--skip-api", "--json"]), { afterSync: true, quick: true, skipApi: true, json: true, help: false, idMapPath: null, problems: [] });
  assert.deepEqual(parseVerifyArgs(["--apply"]).problems, ["unknown option --apply"]);
  assert.deepEqual(parseVerifyArgs(["--id-map"]).problems, ["--id-map needs a path"]);
  assert.equal(parseVerifyArgs(["--id-map", "x.json"]).idMapPath, "x.json");
  const cli = await import("../verify-demo-isolation.mjs");
  assert.equal(cli.verify, verify);
  const io = cli.createRealIo({ idMapPath: resolve(REPO, "migration", "demo", "no-such-id-map.json") });
  assert.deepEqual(Object.keys(io).sort(), ["describeObject", "fetch", "getSecret", "getSupabase", "log", "loginAs", "loginAsTestUser", "now", "readIdMap", "resolveSupabasePublic", "sfQuery"]);
  assert.equal(await io.readIdMap(), null, "a missing id-map is null, which the check refuses to run on");
});
