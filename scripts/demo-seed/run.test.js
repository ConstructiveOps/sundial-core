// The whole seed, end to end, against the fake org / Supabase / Secrets Manager / S3
// (fakes.js — built from the captured live metadata and as strict as Salesforce).
//
//   node --experimental-test-module-mocks --test scripts/demo-seed/plan.test.js scripts/demo-seed/run.test.js scripts/demo-seed/freshen.test.js
//   (the file-list form: on Node 22 `node --test <folder>` does not run the folder's tests)

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIntervals, liveIntervals } from "../../lambdas/sundial-service-board/tech.js";
import { buildPayroll, weekBounds, weekMonday } from "../../lambdas/sundial-service-board/day.js";
import { splitBlocks } from "../../lambdas/sundial-service-board/job-notes.js";
import { createFakeIo } from "./fakes.js";
import { runSeed } from "./run.js";
import { loadProbe } from "./test-helpers.js";
import { OBJ, FORBIDDEN_OBJECTS, DEMO_OWNED_PICKLISTS, DEMO_USERS_SECRET, FAKE_PHONE_RE, FAKE_EMAIL_RE } from "./policy.js";
import { PERSONAS, TECH_KEYS } from "./catalog.js";
import { PHOENIX_TZ } from "./dates.js";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import * as realFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localFiles, RENAME_ATTEMPTS } from "./local-files.js";
import { Writer, MODIFIED_TOLERANCE_MS } from "./writer.js";
import { IdMap } from "./idmap.js";
import { schemaFromProbe } from "./schema.js";
import { SOQL_HARD_LIMIT } from "./canary.js";
import { RUN_RECORD_KEY } from "./run-record.js";
import { CACHE_SYNC_COMMAND } from "./run.js";

const probe = loadProbe();
const world = (opts) => createFakeIo(loadProbe(), opts);
const demoTenant = (w) => w.org.all(OBJ.tenant).find((t) => t.Name === "conops-demo");
const mine = (w, sfObject) => w.org.all(sfObject).filter((r) => r.Client__c === demoTenant(w).Id);

/** One clean, complete run — several tests look at its result. */
async function seeded(args = [], opts) {
  const w = world(opts);
  const code = await runSeed(["--apply", ...args], w.io);
  assert.equal(code, 0, w.output().split("\n").slice(-25).join("\n"));
  return w;
}

test("a dry run reads the org and writes nothing", async () => {
  const w = world();
  const code = await runSeed([], w.io);
  assert.equal(code, 0, w.output());
  assert.equal(w.org.calls.creates.length, 0);
  assert.equal(w.org.calls.updates.length, 0);
  assert.equal(w.supabase.inserts.length, 0);
  assert.equal(w.supabase.users.length, 0);
  assert.equal(w.secretWrites.length, 0);
  assert.equal(w.s3.size, 0);
  // The only thing left behind is the local preview file — and no id-map.
  assert.deepEqual([...w.files.keys()].sort(), ["plan.json", "probe.json"]);
  assert.match(w.output(), /Nothing was written to Salesforce, Supabase, Secrets Manager or S3/);
  assert.match(w.output(), /Preflight passed/);
  assert.equal(w.org.calls.describes.length, 14, "every seeded object is described LIVE");
  const plan = JSON.parse(w.files.get("plan.json"));
  assert.equal(plan.ops.filter((o) => o.op === "create" && o.object === OBJ.customer).length, 100);
});

test("(b) a full --apply succeeds and the org holds the intended records", async () => {
  const w = await seeded();
  const t = demoTenant(w);
  assert.ok(t, "the demo tenant exists");
  const n = (o) => mine(w, o).length;
  assert.deepEqual(
    { dealers: n(OBJ.dealer), users: n(OBJ.user), customers: n(OBJ.customer), solar: n(OBJ.solar), roofing: n(OBJ.roofing), items: n(OBJ.item), estimates: n(OBJ.estimate), jobs: n(OBJ.job), invoices: n(OBJ.invoice) },
    { dealers: 3, users: 11, customers: 100, solar: 50, roofing: 10, items: 28, estimates: 51, jobs: 45, invoices: 10 }
  );
  // 33 of the 34 solar stages: "Sold - Pending Review" is only used when asked for (see the test below).
  assert.equal(new Set(mine(w, OBJ.solar).map((s) => s.Stage__c)).size, 33, "33 of the 34 solar stages");
  assert.match(w.output(), /Solar pipeline: 33 of 34 live stages covered/);
  assert.equal(new Set(mine(w, OBJ.job).map((j) => j.Status__c)).size, 12, "all 12 job statuses");
  assert.ok(n(OBJ.call) >= 78 && n(OBJ.call) <= 130, `${n(OBJ.call)} calls`);
  assert.ok(n(OBJ.line) >= 102 && n(OBJ.line) <= 306);
  assert.ok(n(OBJ.day) >= 15);
  assert.match(w.output(), /all records verified/);
  assert.match(w.output(), /WRITTEN IN THIS RUN/);

  // Things only knowable after the insert: numbers, ids, cross-links.
  const jobs = mine(w, OBJ.job);
  for (const inv of mine(w, OBJ.invoice)) {
    const job = w.org.get(inv.Service_Job__c);
    assert.equal(inv.Name, job.Name, "an invoice is named after its job number");
    assert.match(inv.Name, /^SVC-\d{5}$/);
  }
  for (const job of jobs) {
    const est = w.org.get(job.Estimate__c);
    assert.equal(est.Service_Job__c, job.Id, "estimate and job point at each other");
    assert.equal(est.Sundial_Customer__c, job.Sundial_Customer__c);
    const calls = mine(w, OBJ.call).filter((c) => c.Sundial_Service_Job__c === job.Id);
    const done = calls.filter((c) => c.Status__c === "Complete");
    // The notes roll-up: one block per completed call, headed by the call's own number.
    const blocks = splitBlocks(job.Notes_for_Summary__c);
    assert.deepEqual(blocks.map((b) => b.callNumber).sort(), done.map((c) => c.Name).sort(), `${job.Name} notes roll-up`);
    for (const b of blocks) assert.match(b.text, /^— SC-\d{5} · \w{3} \d{1,2}, \d{4} · \w+ \w+\n/);
  }
  for (const est of mine(w, OBJ.estimate).filter((e) => e.Version_Log__c)) {
    for (const entry of JSON.parse(est.Version_Log__c)) {
      assert.equal(w.org.objectOfId.get(entry.sentBy), OBJ.user);
      for (const l of entry.lines) if (l.itemId) assert.equal(w.org.objectOfId.get(l.itemId), OBJ.item);
      assert.equal(entry.pdfKey, null);
    }
  }
  for (const s of mine(w, OBJ.solar)) assert.equal(w.org.get(s.Sundial_Customer__c).Linked_Solar_Project__c, s.Id);
  const tied = mine(w, OBJ.solar).filter((s) => s.Roofing_Job_Number__c);
  assert.equal(tied.length, 3);
  for (const s of tied) assert.ok(mine(w, OBJ.roofing).some((r) => r.Name === s.Roofing_Job_Number__c && r.Sundial_Customer__c === s.Sundial_Customer__c));
  for (const d of mine(w, OBJ.day)) assert.equal(d.Day_Key__c, `${d.Tech__c}:${d.Work_Date__c}`);
  for (const u of mine(w, OBJ.user)) {
    assert.ok(w.supabase.users.some((a) => a.id === u.Supabase_User_Id__c && a.email === u.Email__c && a.email_confirmed), "each Sundial user is bound to its own login");
  }
  const casey = mine(w, OBJ.user).find((u) => u.First_Name__c === "Casey");
  for (const r of mine(w, OBJ.roofing)) assert.equal(r.Project_Manager__c, casey.Id);
});

test("(c) isolation: only the demo tenant is written, nothing forbidden, nothing real", async () => {
  const w0 = world();
  const before = JSON.stringify([w0.org.get(w0.org.harmonCustomerId), w0.org.get(w0.org.harmonJobUserId), w0.org.get(w0.org.harmonTenantId)]);
  const w = await seeded(["--with-files"]);
  const t = demoTenant(w);
  assert.equal(JSON.stringify([w.org.get(w.org.harmonCustomerId), w.org.get(w.org.harmonJobUserId), w.org.get(w.org.harmonTenantId)]), before, "Harmon's records are untouched");

  const createdIds = new Set(w.org.calls.creates.map((c) => c.id));
  for (const c of w.org.calls.creates) {
    assert.ok(!FORBIDDEN_OBJECTS.includes(c.sfObject), `wrote ${c.sfObject}`);
    if (c.sfObject !== OBJ.tenant) assert.equal(c.fields.Client__c, t.Id, `${c.sfObject} ${c.id} is not stamped with the demo tenant`);
    for (const f of Object.keys(c.fields)) assert.ok(!/HCP_Id|Acumatica|Aurora|Sunbase|Dropbox|Stripe|^Solar_Project__c$/.test(f), `wrote ${f}`);
  }
  // Every update went to a record this run created.
  for (const u of w.org.calls.updates) assert.ok(createdIds.has(u.id), `updated ${u.id}, which this run did not create`);
  for (const o of FORBIDDEN_OBJECTS) assert.equal(w.org.all(o).length, 0);
  // Exactly the demo-owned picklists received new values, and only the agreed names.
  const allowed = new Set(Object.entries(DEMO_OWNED_PICKLISTS).flatMap(([o, fs]) => fs.map((f) => `${o}.${f}`)));
  const names = new Set(["Constructive Solar", "Saguaro Ridge Solar", "Copperline Energy", "Third-Party Dealer", "Sam Whitaker", "Elena Marsh", "Tyler Brooks", "Nadia Flores", "Jordan Reyes", "Casey Tran"]);
  for (const v of w.org.addedPicklistValues) {
    const [field, value] = v.split("=");
    assert.ok(allowed.has(field), `added a picklist value to ${field}`);
    assert.ok(names.has(value), `unexpected new picklist value ${v}`);
  }
  // Contact details, as they landed in the org.
  for (const sfObject of [OBJ.customer, OBJ.solar, OBJ.roofing, OBJ.estimate, OBJ.job, OBJ.user]) {
    const defs = probe.salesforce[sfObject].fields;
    for (const r of mine(w, sfObject)) {
      for (const [f, v] of Object.entries(r)) {
        if (v === null || v === undefined || !defs[f]) continue;
        if (defs[f].type === "phone") assert.match(v, FAKE_PHONE_RE, `${sfObject}.${f}`);
        if (defs[f].type === "email" && sfObject !== OBJ.user) assert.match(v, FAKE_EMAIL_RE, `${sfObject}.${f}`);
        if (typeof v === "string") assert.ok(!/harmon/i.test(v), `${sfObject}.${f} mentions Harmon`);
      }
    }
  }
  // Supabase: every row the seed added carries the demo tenant; comment_mentions untouched.
  for (const ins of w.supabase.inserts) {
    assert.notEqual(ins.table, "comment_mentions");
    assert.ok(ins.row.client_sf_id === t.Id || ins.row.tenant_id === t.Id, `${ins.table} row without the demo tenant`);
    assert.ok(!ins.table.endsWith("_cache"), "the cache belongs to sundial-cache-sync");
  }
  for (const r of w.supabase.rowsFor("sundial_sms_messages", t.Id)) { assert.match(r.provider_sid, /^DEMO-/); assert.match(r.from_number, /^\+1(602|480|623)55501\d\d$/); assert.match(r.to_number, /^\+1(602|480|623)55501\d\d$/); }
  const authIds = new Set(w.supabase.users.map((u) => u.id));
  for (const r of w.supabase.rowsFor("comments", t.Id)) { assert.ok(authIds.has(r.author_id)); assert.ok(createdIds.has(r.record_id)); assert.ok(["customer", "solar", "job"].includes(r.record_object)); }
  // Notifications as they landed: a real category / kind, a real portal path to a record of this run.
  const bell = w.supabase.rowsFor("sundial_notifications", t.Id);
  assert.equal(bell.length, 10);
  for (const r of bell) {
    assert.ok(authIds.has(r.profile_id));
    assert.equal(r.read_at, undefined);
    assert.ok(["tech_activity/complete", "tech_activity/clock_in", "money/estimate_approved", "money/deposit_paid", "customer_message/text"].includes(`${r.category}/${r.kind}`), `${r.category}/${r.kind}`);
    const m = /^\/service\/(jobs|estimates)\/(a\w{17})$/.exec(r.url);
    assert.ok(m && createdIds.has(m[2]), r.url);
    assert.equal(w.org.objectOfId.get(m[2]), m[1] === "jobs" ? OBJ.job : OBJ.estimate);
    assert.equal(w.org.objectOfId.get(r.record_sf_id), { servicecall: OBJ.call, job: OBJ.job, estimate: OBJ.estimate }[r.record_type]);
    // The record's own number is in the title, as the real emitters write it (no marker left behind).
    assert.ok(typeof r.title === "string" && /(SVC|EST)-\d{5}/.test(r.title) && !/\$name|\$ref|\[object/.test(`${r.title}${r.body}${r.url}`), r.title);
  }
  for (const r of w.supabase.rowsFor("sundial_service_activity", t.Id)) { assert.ok(createdIds.has(r.record_sf_id)); assert.equal(typeof r.details, "object"); assert.ok(!JSON.stringify(r).includes("$ref") && !JSON.stringify(r).includes("$name")); }
  const profiles = w.supabase.rowsFor("profiles", t.Id);
  assert.equal(profiles.length, 11);
  assert.deepEqual(Object.keys(profiles[0]).sort(), ["access_level", "access_scope", "dealer_sf_id", "email", "full_name", "id", "sundial_user_id", "tenant_id", "updated_at"]);
  assert.deepEqual([...new Set(profiles.map((p) => p.access_scope))].sort(), ["dealer", "own", "tech", "tenant"]);
  // Files: PDFs at SUNDIAL/{record id}/{name}, one metadata row each.
  assert.equal(w.s3.size, 25);
  for (const [key, obj] of w.s3) {
    const m = /^SUNDIAL\/(a\w{17})\/[A-Za-z0-9_().-]+\.pdf$/.exec(key);
    assert.ok(m && createdIds.has(m[1]), key);
    assert.equal(obj.head, "%PDF-");
  }
  assert.equal(w.supabase.rowsFor("sundial_file_metadata", t.Id).length, 25);
});

test("the seeded clocks make sense to the board's own code: payroll has hours for every tech", async () => {
  const w = await seeded();
  const t = demoTenant(w);
  const techs = TECH_KEYS.map((k) => mine(w, OBJ.user).find((u) => u.Email__c === PERSONAS.find((p) => p.key === k).email)).map((u) => ({ id: u.Id, name: `${u.First_Name__c} ${u.Last_Name__c}` }));
  const calls = mine(w, OBJ.call).map((c) => ({ ...c, Sundial_Service_Job__r: w.org.get(c.Sundial_Service_Job__c) }));
  for (const c of calls.filter((x) => x.Clock_Intervals__c)) assert.ok(liveIntervals(parseIntervals(c.Clock_Intervals__c)).length >= 1);
  // Last week (a full Mon–Sun before the run) and this week.
  for (const day of ["2026-09-22", "2026-09-29"]) {
    const week = weekBounds(weekMonday(day), PHOENIX_TZ);
    const report = buildPayroll({ techs, days: mine(w, OBJ.day), calls, week, timeZone: PHOENIX_TZ, now: w.io.now().toISOString() });
    assert.equal(report.techs.length, 3);
    for (const row of report.techs) {
      const name = row.tech.name;
      assert.ok(row.totals.callMinutes > 60, `${name} has ${row.totals.callMinutes} call minutes in the week of ${day}`);
      assert.ok(row.jobs.length >= 1 && row.jobs.every((j) => /^SVC-\d{5}$/.test(j.jobNumber)));
      assert.ok(row.days.length >= 1);
      for (const d of row.days) {
        assert.notEqual(d.flag, "no_day_clock", `${name} ${d.date}: call time without a day row`);
        if (d.date < "2026-09-29") assert.equal(d.flag, null, `${name} ${d.date}: ${d.flag}`);
        assert.ok(d.outsideMinutes >= 0 && d.spanMinutes >= d.callMinutes - 1, `${name} ${d.date}: the day is shorter than its calls`);
      }
      // Today is still open for every tech (they are working).
      if (day === "2026-09-29") assert.ok(row.days.find((d) => d.date === "2026-09-29")?.open, `${name}: today's day clock is open`);
    }
  }
  void t;
});

test("a second --apply changes nothing (idempotent)", async () => {
  const w = await seeded(["--with-files"]);
  const snapshot = JSON.stringify(w.org.snapshot());
  const counts = { creates: w.org.calls.creates.length, updates: w.org.calls.updates.length, inserts: w.supabase.inserts.length, users: w.supabase.users.length, s3: w.s3.size, secrets: w.secretWrites.length };
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply", "--with-files"], w.io), 0, w.output());
  assert.equal(JSON.stringify(w.org.snapshot()), snapshot);
  assert.deepEqual({ creates: w.org.calls.creates.length, updates: w.org.calls.updates.length, inserts: w.supabase.inserts.length, users: w.supabase.users.length, s3: w.s3.size, secrets: w.secretWrites.length }, counts);
  assert.match(w.output(), /already done/);
  assert.match(w.output(), /comments: 0 added \(76 already there\)|comments: 0 added/);
});

test("the anchor and seed of the first --apply are kept: a later run rebuilds the identical plan", async () => {
  const w = await seeded();
  const first = JSON.parse(w.files.get("plan.json"));
  assert.deepEqual(w.idmap().anchor, { date: "2026-09-29", now: "2026-09-29T17:40:00.000Z" });
  w.setNow("2026-10-20T20:00:00.000Z"); // three weeks later
  assert.equal(await runSeed([], w.io), 0, w.output());
  assert.deepEqual(JSON.parse(w.files.get("plan.json")).ops, first.ops);
  // …and once the live-demo customers exist, an option of the first apply cannot be changed:
  // the message names the three customers to edit by hand.
  w.lines.length = 0;
  const creates = w.org.calls.creates.length;
  const updates = w.org.calls.updates.length;
  assert.equal(await runSeed(["--apply", "--demo-phone", "+16025550123"], w.io), 1);
  assert.match(w.output(), /--demo-phone differs from the first --apply \(not set\), and the live-demo customers already exist/);
  const live = JSON.parse(w.files.get("plan.json")).meta.liveDemo;
  assert.equal(live.length, 3);
  for (const d of live) assert.ok(w.output().includes(`${d.name} (${d.key}, ${w.idmap().ids[d.key]})`), `the message names ${d.name} and its record id`);
  assert.match(w.output(), /Change the Primary Phone by hand in the portal on these three customers/);
  assert.deepEqual([w.org.calls.creates.length, w.org.calls.updates.length], [creates, updates], "nothing was written");
  assert.equal(w.idmap().options.demoPhone, null, "the stored option did not change");
});

test("(e) resumable: a crash after N writes, then the same command again, ends in the identical state", async () => {
  const clean = await seeded();
  const want = JSON.stringify(clean.org.snapshot());
  const total = clean.org.calls.creates.length + clean.org.calls.updates.length;
  // Crash before the write lands, and AFTER it lands (Salesforce has the record, the id-map does not).
  const points = [[1, "after"], [2, "before"], [9, "after"], [16, "after"], [120, "before"], [121, "after"], [260, "after"], [400, "before"], [555, "after"], [total - 1, "after"]];
  for (const [at, mode] of points) {
    const w = world();
    w.org.crash = { at, mode };
    assert.equal(await runSeed(["--apply"], w.io), 1, `crash at write ${at} should stop the run`);
    assert.match(w.output(), /STOPPED:/);
    assert.match(w.output(), /run the same command again/);
    w.org.crash = null;
    w.lines.length = 0;
    const code = await runSeed(["--apply"], w.io);
    assert.equal(code, 0, `resume after crash at ${at} (${mode}):\n${w.output().split("\n").slice(-15).join("\n")}`);
    if (mode === "after" && /recovered 1 record/.test(w.output()) === false) {
      // An "after" crash on an UPDATE needs no recovery (the update is simply repeated).
      assert.ok(true);
    }
    assert.equal(JSON.stringify(w.org.snapshot()), want, `state after resuming from a crash at write ${at} (${mode})`);
    const ids = Object.values(w.idmap().ids);
    assert.equal(new Set(ids).size, ids.length, "no two keys share a record");
    assert.equal(ids.length, clean.org.calls.creates.length, "no duplicates, nothing missing");
  }
});

test("(e) a record that landed but was never recorded is found again by its natural key, not created twice", async () => {
  const w = world();
  w.org.crash = { at: 130, mode: "after" };
  assert.equal(await runSeed(["--apply"], w.io), 1);
  const orphaned = w.org.calls.creates[w.org.calls.creates.length - 1];
  assert.ok(!Object.values(w.idmap().ids).includes(orphaned.id), "the id-map did not get to record it");
  w.org.crash = null;
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply"], w.io), 0, w.output());
  assert.match(w.output(), /recovered 1 record\(s\) a previous run created/);
  assert.ok(Object.values(w.idmap().ids).includes(orphaned.id));
  assert.equal(mine(w, orphaned.sfObject).length, w.org.calls.creates.filter((c) => c.sfObject === orphaned.sfObject).length);
});

test("(f) the canary stops the run when the org changes a demo record behind the script's back", async () => {
  // 1. A record-triggered Flow on Solar (the draft budget-recalc Flow) stamps a field nobody wrote.
  {
    const w = world();
    w.org.afterCreate = (o, r) => { if (o === OBJ.solar) r.Budget_Calc_Status__c = "Pending"; };
    assert.equal(await runSeed(["--apply"], w.io), 1);
    assert.match(w.output(), /CANARY FAILED on Sundial_Solar__c/);
    assert.match(w.output(), /Budget_Calc_Status__c: holds "Pending" but this script never wrote it/);
    assert.equal(mine(w, OBJ.solar).length, 1, "only the canary record was written");
    assert.equal(mine(w, OBJ.estimate).length, 0, "and nothing after it");
    // Running again does not slip past it …
    w.lines.length = 0;
    assert.equal(await runSeed(["--apply"], w.io), 1);
    assert.match(w.output(), /CANARY FAILED on Sundial_Solar__c/);
    assert.equal(mine(w, OBJ.solar).length, 1);
    // … until the owner has looked and says so.
    w.org.afterCreate = null;
    assert.equal(await runSeed(["--apply", "--accept-canary", "Sundial_Solar__c"], w.io), 0, w.output().split("\n").slice(-12).join("\n"));
    assert.equal(mine(w, OBJ.solar).length, 50);
  }
  // 2. A stage-driven automation on Customer overwrites a field the script DID write.
  {
    const w = world();
    w.org.afterCreate = (o, r) => { if (o === OBJ.customer) r.Welcome_Call_Status__c = "Queued"; };
    assert.equal(await runSeed(["--apply"], w.io), 1);
    assert.match(w.output(), /CANARY FAILED on Sundial_Customer__c/);
    assert.match(w.output(), /Welcome_Call_Status__c: wrote "Verified", read back "Queued"/);
    assert.equal(mine(w, OBJ.customer).length, 1);
    assert.equal(mine(w, OBJ.solar).length, 0);
  }
  // 3. Something ticks a box on the first Service Job.
  {
    const w = world();
    w.org.afterCreate = (o, r) => { if (o === OBJ.job) r.Needs_Intake_Review__c = true; };
    assert.equal(await runSeed(["--apply"], w.io), 1);
    assert.match(w.output(), /CANARY FAILED on Sundial_Service_Job__c/);
    assert.equal(mine(w, OBJ.job).length, 1);
    assert.equal(mine(w, OBJ.call).length, 0);
  }
  // A field the org fills from its own DEFAULT is not a surprise (it is listed instead).
  {
    const w = await seeded([], { formulaDefaults: { Sundial_Customer__c: { Dealer_Fee__c: 0, Commission_Burden_Rate__c: 75 } } });
    assert.match(w.output(), /Fields the ORG filled with its own default/);
    assert.match(w.output(), /Sundial_Customer__c: .*Commission_Burden_Rate__c/);
  }
});

test("(g) the real client's tenant is refused, by name and by id", async () => {
  for (const [args, env] of [[["--tenant", "harmon"], {}], [["--tenant", "harmon", "--apply"], {}], [["--tenant", "acme-solar", "--apply"], { SUNDIAL_PRIMARY_TENANT: "acme-solar" }]]) {
    const w = world({ env });
    assert.equal(await runSeed(args, w.io), 1);
    assert.match(w.output(), /REFUSED: .* is a real client's tenant/);
    assert.equal(w.org.calls.creates.length + w.org.calls.updates.length + w.org.calls.queries.length, 0, "refused before touching the org");
    assert.match(w.output(), /Nothing was written/);
  }
  // A demo slug that somehow names Harmon's tenant RECORD is refused too.
  const w = world();
  w.org.get(w.org.harmonTenantId).Name = "conops-demo";
  assert.equal(await runSeed(["--apply"], w.io), 1);
  assert.match(w.output(), /REFUSED: tenant "conops-demo" resolves to Harmon's tenant record/);
  assert.equal(w.org.calls.creates.length, 0);
});

test("a tenant that already holds records the id-map does not know is refused", async () => {
  const w = world();
  const tenantId = w.org.insertRaw(OBJ.tenant, { Name: "conops-demo" });
  const stray = w.org.insertRaw(OBJ.customer, { Name: "Somebody Real", Street__c: "1 Real St", Client__c: tenantId });
  assert.equal(await runSeed(["--apply"], w.io), 1);
  assert.match(w.output(), /holds records the id-map does not account for: 1 x Sundial_Customer__c/);
  assert.equal(w.org.calls.creates.length, 0, "nothing written");
  // With the explicit override it goes ahead and leaves the stranger alone.
  const before = JSON.stringify(w.org.get(stray));
  assert.equal(await runSeed(["--apply", "--allow-unaccounted"], w.io), 0, w.output().split("\n").slice(-12).join("\n"));
  assert.equal(JSON.stringify(w.org.get(stray)), before);
  assert.equal(mine(w, OBJ.customer).length, 101);
});

test("logins: passwords go to Secrets Manager only; an existing login is reused only when it is safe", async () => {
  const w = await seeded();
  const secret = JSON.parse(w.secrets.get(DEMO_USERS_SECRET));
  // Eleven logins, plus the run record — which is not a login and is never shown as one.
  assert.deepEqual(Object.keys(secret).sort(), [RUN_RECORD_KEY, ...PERSONAS.map((p) => p.email)].sort());
  for (const u of w.supabase.users) assert.equal(u.password, secret[u.email], "the secret opens every login");
  assert.equal(w.supabase.users.length, 11, "the run record did not become a login");
  assert.ok(!w.output().includes("fake-password"), "no password in the output");
  for (const f of ["plan.json", "id-map.json"]) assert.ok(!w.files.get(f).includes("fake-password"), `no password in ${f}`);
  w.lines.length = 0;
  assert.equal(await runSeed(["--show-passwords"], w.io), 0);
  assert.match(w.output(), /tim\+demo-avery@constructiveoperations\.com\s+fake-password-1-aA1!/);
  assert.equal(w.lines.filter((l) => l.includes("@")).length, 11, "--show-passwords prints the eleven logins and nothing else");
  assert.ok(!w.output().includes(RUN_RECORD_KEY) && !w.output().includes("anchor"), "--show-passwords never prints the run record");

  // An unbound login with one of the demo emails is reused and its password reset to the stored one.
  const w2 = world();
  await w2.supabase.auth.admin.createUser({ email: PERSONAS[1].email, password: "old", email_confirm: true });
  assert.equal(await runSeed(["--apply", "--phase", "tenant"], w2.io), 0);
  assert.equal(await runSeed(["--apply", "--phase", "dealers"], w2.io), 0);
  assert.equal(await runSeed(["--apply", "--phase", "users"], w2.io), 0, w2.output());
  assert.equal(w2.supabase.users.length, 11);
  assert.equal(w2.supabase.users.find((u) => u.email === PERSONAS[1].email).password, JSON.parse(w2.secrets.get(DEMO_USERS_SECRET))[PERSONAS[1].email]);

  // A login that belongs to a Sundial user in ANOTHER tenant is never taken over.
  const w3 = world();
  const { data } = await w3.supabase.auth.admin.createUser({ email: PERSONAS[0].email, password: "theirs", email_confirm: true });
  w3.org.get(w3.org.harmonJobUserId).Supabase_User_Id__c = data.user.id;
  assert.equal(await runSeed(["--apply"], w3.io), 1);
  assert.match(w3.output(), /already belongs to a Sundial user in another tenant/);
  assert.equal(w3.org.calls.creates.length, 0);
  assert.equal(w3.supabase.users[0].password, "theirs");
});

test("the preflight stops a run the org would reject — and says everything that is wrong at once", async () => {
  const broken = loadProbe();
  delete broken.salesforce.Sundial_Solar__c.fields.System_Size__c; // required for the demo
  broken.salesforce.Sundial_Customer__c.fields.Stage__c.values = broken.salesforce.Sundial_Customer__c.fields.Stage__c.values.filter((v) => v !== "Sold");
  broken.salesforce.Sundial_Customer__c.fields.Stage__c.dependentValues.Customer = broken.salesforce.Sundial_Customer__c.fields.Stage__c.dependentValues.Customer.filter((v) => v !== "Sold");
  broken.salesforce.Sundial_Service_Job__c.fields.Estimate__c.createable = false;
  delete broken.supabase.comments.columns.author_name;
  const w = createFakeIo(broken);
  assert.equal(await runSeed(["--apply"], w.io), 1);
  const out = w.output();
  assert.match(out, /PREFLIGHT FAILED/);
  assert.match(out, /Sundial_Solar__c\.System_Size__c: REQUIRED for the demo, but the org has no such field/);
  assert.match(out, /Stage__c "Sold" is not a live value/);
  assert.match(out, /Sundial_Service_Job__c\.Estimate__c: REQUIRED for the demo, but it is not createable/);
  assert.match(out, /Supabase table comments: no column "author_name"/);
  assert.equal(w.org.calls.creates.length, 0, "nothing was written");
  assert.equal(w.supabase.users.length, 0);
  assert.match(out, /Nothing was written/);

  // An OPTIONAL field the org lacks is dropped with a warning and the run goes ahead.
  const lean = loadProbe();
  delete lean.salesforce.Sundial_Solar__c.fields.Azimuth__c;
  lean.salesforce.Sundial_Customer__c.fields.Roof_Condition__c.values = ["Good"];
  lean.salesforce.Sundial_Customer__c.fields.Roof_Condition__c.restricted = true;
  const w2 = createFakeIo(lean);
  assert.equal(await runSeed(["--apply"], w2.io), 0, w2.output().split("\n").slice(-12).join("\n"));
  assert.match(w2.output(), /Sundial_Solar__c\.Azimuth__c: the org has no such field/);
  assert.match(w2.output(), /Picklist value not live, left blank on \d+ record\(s\): Sundial_Customer__c\.Roof_Condition__c/);
});

test("the roofing stages are read from the live org: with the revamp package deployed the jobs spread over them", async () => {
  const revamped = loadProbe();
  const R = revamped.salesforce.Sundial_Roofing__c.fields;
  R.Stage__c.values = ["New", "Inspection Scheduled", "Budget In Progress", "Proposal Sent", "Sold", "Scheduled", "In Progress", "Complete", "Invoiced", "Paid", "Cancelled"];
  R.Notes__c = { label: "Notes", type: "textarea", createable: true, updateable: true, required: false, length: 32768 };
  const w = createFakeIo(revamped);
  assert.equal(await runSeed(["--apply", "--phase", "tenant"], w.io), 0);
  for (const phase of ["dealers", "users", "customers", "solar", "roofing"]) assert.equal(await runSeed(["--apply", "--phase", phase], w.io), 0, `${phase}: ${w.output().split("\n").slice(-10).join("\n")}`);
  const roofs = mine(w, OBJ.roofing);
  assert.equal(new Set(roofs.map((r) => r.Stage__c)).size, 10);
  assert.ok(roofs.every((r) => r.Notes__c.startsWith("DEMO DATA")));
  assert.ok(roofs.filter((r) => r.Contract_Presented_Amount__c).length < 10, "an unsold roofing job has no contract amount yet");
});

test("--phase runs one phase, and refuses one whose prerequisites are missing", async () => {
  const w = world();
  assert.equal(await runSeed(["--apply", "--phase", "customers"], w.io), 1);
  assert.match(w.output(), /"tenant" has not been created yet — run the "tenant" phase first/);
  assert.equal(w.org.calls.creates.length, 0);
});

test("errors never print a Salesforce error body or a secret", async () => {
  const w = world();
  const real = w.io.sf.sfCreateRecord;
  w.io.sf.sfCreateRecord = async (o, f) => {
    if (o === OBJ.dealer) {
      const e = new Error("Salesforce create failed (400)");
      e.sfStatus = 400;
      e.sfBody = JSON.stringify([{ message: "bad value", errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION", fields: ["Name"], leaked: "RECORD-DATA-THAT-MUST-NOT-PRINT" }]);
      throw e;
    }
    return real(o, f);
  };
  assert.equal(await runSeed(["--apply"], w.io), 1);
  assert.match(w.output(), /dealer:constructive \(Sundial_Dealer__c\) could not be created: HTTP 400 — FIELD_CUSTOM_VALIDATION_EXCEPTION \[Name\]: bad value/);
  assert.ok(!w.output().includes("RECORD-DATA-THAT-MUST-NOT-PRINT"));
});

// =============================================================================================
// Follow-up fixes (adversarial review, 2026-09-30). One test per finding.
// =============================================================================================

const idOf = (w, key) => w.idmap().ids[key];
const secretOf = (w) => JSON.parse(w.secrets.get(DEMO_USERS_SECRET));
const writes = (w) => ({ creates: w.org.calls.creates.length, updates: w.org.calls.updates.length, inserts: w.supabase.inserts.length });
const tail = (w, n = 14) => w.output().split("\n").slice(-n).join("\n");
/** The org's records without Salesforce's own timestamps — for comparing two worlds that ran at different times. */
const bare = (w) => JSON.stringify(w.org.snapshot(), (k, v) => (["CreatedDate", "LastModifiedDate", "SystemModstamp"].includes(k) ? undefined : v));

test("(1) logins: a lost secret — or one lost entry — is rebuilt AND set on the logins that already exist", async () => {
  const w = await seeded();
  const before = secretOf(w);
  const sfWrites = writes(w);

  // (a) One entry is gone. Only that login gets a new password; every other one is untouched.
  const lost = PERSONAS[3].email;
  const partial = { ...before };
  delete partial[lost];
  w.secrets.set(DEMO_USERS_SECRET, JSON.stringify(partial));
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply", "--phase", "users"], w.io), 0, tail(w));
  const after = secretOf(w);
  assert.notEqual(after[lost], before[lost], "a new password was generated for the lost entry");
  for (const p of PERSONAS) if (p.email !== lost) assert.equal(after[p.email], before[p.email], `${p.email} kept its password`);
  for (const u of w.supabase.users) assert.equal(u.password, after[u.email], `the secret still opens ${u.email}`);
  assert.match(w.output(), new RegExp(`login ${lost.replace(/[+.]/g, "\\$&")}: password reset to the newly stored one`));
  assert.equal(w.supabase.users.length, 11, "no login was created twice");
  assert.ok(!w.output().includes("fake-password"), "no password in the output");

  // (b) The whole secret is gone (passwords and run record). Both come back, and all eleven logins open.
  w.secrets.delete(DEMO_USERS_SECRET);
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply", "--phase", "users"], w.io), 0, tail(w));
  const rebuilt = secretOf(w);
  for (const u of w.supabase.users) {
    assert.equal(u.password, rebuilt[u.email], `the rebuilt secret opens ${u.email}`);
    assert.notEqual(rebuilt[u.email], after[u.email]);
  }
  assert.deepEqual(rebuilt[RUN_RECORD_KEY]["conops-demo"].anchor, w.idmap().anchor, "the run record was put back too");
  assert.equal(w.supabase.users.length, 11);
  assert.deepEqual({ creates: w.org.calls.creates.length, updates: w.org.calls.updates.length }, { creates: sfWrites.creates, updates: sfWrites.updates }, "Salesforce was not written to");

  // (c) Nothing lost: a re-run resets nobody.
  const stable = JSON.stringify(w.supabase.users);
  assert.equal(await runSeed(["--apply", "--phase", "users"], w.io), 0);
  assert.equal(JSON.stringify(w.supabase.users), stable);
});

test("(2) the run record: anchor, seed, tenant id and options are copied into the secret before the first record is written", async () => {
  const w = world();
  // The slow path's first command. The secret is created here — with the run record and no login yet.
  assert.equal(await runSeed(["--apply", "--phase", "tenant"], w.io), 0, tail(w));
  const rec = secretOf(w)[RUN_RECORD_KEY]["conops-demo"];
  assert.deepEqual(rec.anchor, { date: "2026-09-29", now: "2026-09-29T17:40:00.000Z" });
  assert.equal(rec.seed, w.idmap().seed);
  assert.equal(rec.tenantId, demoTenant(w).Id);
  assert.deepEqual(rec.options, { demoPhone: null, demoEmail: null, withSoldPendingReview: false });
  assert.deepEqual(Object.keys(secretOf(w)), [RUN_RECORD_KEY]);
  // Even a run that dies on its very first write has left the anchor behind.
  const w2 = world();
  w2.org.crash = { at: 1, mode: "before" };
  assert.equal(await runSeed(["--apply"], w2.io), 1);
  assert.equal(w2.org.calls.creates.length, 0);
  assert.deepEqual(secretOf(w2)[RUN_RECORD_KEY]["conops-demo"].anchor, { date: "2026-09-29", now: "2026-09-29T17:40:00.000Z" });
  // The id-map and the secret must agree: a record that says otherwise stops an --apply before it writes.
  const w3 = await seeded();
  const s3 = secretOf(w3);
  s3[RUN_RECORD_KEY]["conops-demo"].anchor = { date: "2026-08-01", now: "2026-08-01T17:00:00.000Z" };
  w3.secrets.set(DEMO_USERS_SECRET, JSON.stringify(s3));
  const before = writes(w3);
  w3.lines.length = 0;
  assert.equal(await runSeed(["--apply"], w3.io), 1);
  assert.match(w3.output(), /STOPPED: the run record in "sundial\/demo-users" says the seed was anchored to 2026-08-01 .* the id-map says 2026-09-29/);
  assert.deepEqual(writes(w3), before);
});

test("(2) id-map lost after a complete seed: anchor and seed come back from the secret and EVERY record is re-adopted — nothing is created twice", async () => {
  const w = await seeded();
  const before = w.idmap();
  const snapshot = JSON.stringify(w.org.snapshot());
  const counts = writes(w);
  const firstPlan = JSON.parse(w.files.get("plan.json")).ops;
  w.files.delete("id-map.json");
  w.setNow("2026-10-20T20:00:00.000Z"); // three weeks later: a plan built "today" would be a different plan

  // A dry run says what it found and saves nothing.
  w.lines.length = 0;
  assert.equal(await runSeed([], w.io), 0, tail(w, 30));
  assert.match(w.output(), /id-map: NOT FOUND in migration\/demo, but tenant "conops-demo" exists/);
  assert.match(w.output(), /Anchor 2026-09-29, seed \d+ and the options of the first --apply were restored from Secrets Manager/);
  assert.match(w.output(), new RegExp(`id-map rebuilt: ${Object.keys(before.ids).length - 1} record\\(s\\) recognised`));
  assert.match(w.output(), /Dry run: the rebuilt id-map was not saved/);
  assert.ok(!w.files.has("id-map.json"));
  assert.deepEqual(JSON.parse(w.files.get("plan.json")).ops, firstPlan, "the ORIGINAL plan was rebuilt");

  // --apply saves the rebuilt id-map and writes nothing to Salesforce or Supabase.
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply"], w.io), 0, tail(w, 30));
  const after = w.idmap();
  assert.deepEqual(after.ids, before.ids, "every key maps to the very same record");
  assert.deepEqual(after.anchor, before.anchor);
  assert.equal(after.seed, before.seed);
  assert.deepEqual(after.options, before.options);
  assert.deepEqual(after.supabase.authUsers, before.supabase.authUsers, "the logins were re-linked from the user records");
  assert.deepEqual(after.steps, before.steps, "every follow-up update was found already made");
  assert.ok(after.recovered?.at);
  assert.deepEqual(writes(w), counts, "no create, no update, no Supabase row");
  assert.equal(w.supabase.users.length, 11);
  assert.equal(JSON.stringify(w.org.snapshot()), snapshot);
  for (const o of [OBJ.call, OBJ.payment, OBJ.day, OBJ.line, OBJ.invoice]) assert.equal(mine(w, o).length, w.org.calls.creates.filter((c) => c.sfObject === o).length, `${o}: none duplicated`);
  // No record of a rebuilt id-map is put through a canary again (they were edited since, quite legitimately).
  assert.ok(!w.lines.some((l) => /^\s+canary /.test(l)));
  // And from here on it is an ordinary id-map.
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply"], w.io), 0);
  assert.ok(!w.output().includes("NOT FOUND"));
  assert.deepEqual(writes(w), counts);
});

test("(2) id-map lost half-way through a seed: the rebuild picks the run up where it stopped and ends in the identical state", async () => {
  const clean = await seeded();
  const want = bare(clean);
  for (const [at, mode] of [[1, "after"], [40, "before"], [300, "after"], [520, "after"]]) {
    const w = world();
    w.org.crash = { at, mode };
    assert.equal(await runSeed(["--apply"], w.io), 1);
    w.org.crash = null;
    w.files.delete("id-map.json");
    w.setNow("2026-10-03T19:00:00.000Z");
    w.lines.length = 0;
    assert.equal(await runSeed(["--apply"], w.io), 0, `resume without an id-map after a crash at ${at} (${mode}):\n${tail(w)}`);
    assert.equal(bare(w), want, `state after rebuilding from a crash at write ${at} (${mode})`);
    const ids = Object.values(w.idmap().ids);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, clean.org.calls.creates.length, "no duplicates, nothing missing");
    assert.deepEqual(w.idmap().anchor, clean.idmap().anchor, "the anchor is the first run's, not the day of the rebuild");
  }
});

test("(2) id-map lost AND no run record: refused — --allow-unaccounted can no longer seed a second copy", async () => {
  const w = await seeded();
  const counts = writes(w);
  w.files.delete("id-map.json");
  w.secrets.delete(DEMO_USERS_SECRET);
  w.setNow("2026-10-20T20:00:00.000Z");
  for (const args of [["--apply"], ["--apply", "--allow-unaccounted"], ["--apply", "--allow-unaccounted", "--phase", "service"]]) {
    w.lines.length = 0;
    assert.equal(await runSeed(args, w.io), 1, args.join(" "));
    assert.match(w.output(), /has been seeded before \(3 demo dealer\(s\), 11 demo user\(s\), 28 price-book item\(s\)\), but there is no id-map .* AND no run record/);
    assert.match(w.output(), /Nothing is written — not even with --allow-unaccounted/);
    assert.deepEqual(writes(w), counts, `${args.join(" ")} wrote something`);
    assert.ok(!w.files.has("id-map.json"));
    assert.ok(!w.secrets.has(DEMO_USERS_SECRET), "no new run record was invented");
  }
  // A run record for a DIFFERENT tenant record is no better than none.
  const w2 = await seeded();
  w2.files.delete("id-map.json");
  const s = secretOf(w2);
  s[RUN_RECORD_KEY]["conops-demo"].tenantId = "aAZ000000009999AAA";
  w2.secrets.set(DEMO_USERS_SECRET, JSON.stringify(s));
  const before = writes(w2);
  assert.equal(await runSeed(["--apply", "--allow-unaccounted"], w2.io), 1);
  assert.match(w2.output(), /run record .* is for a DIFFERENT tenant record/);
  assert.deepEqual(writes(w2), before);
});

test("(2) id-map lost and a record's identifying field was edited since: refused with the record named, flag or no flag — then recoverable", async () => {
  const w = await seeded();
  const counts = writes(w);
  const ids = w.idmap().ids;
  const customer = w.org.get(ids["customer:080"]);
  const realName = customer.Name;
  customer.Name = "Renamed In The Portal";
  const payment = w.org.get(ids["payment:001-1"]);
  const realAmount = payment.Amount__c;
  payment.Amount__c = realAmount + 1;
  w.files.delete("id-map.json");
  for (const args of [["--apply"], ["--apply", "--allow-unaccounted"]]) {
    w.lines.length = 0;
    assert.equal(await runSeed(args, w.io), 1, args.join(" "));
    const out = w.output();
    assert.match(out, /The id-map cannot be rebuilt for Sundial_Customer__c: 1 planned record\(s\) were not found/);
    assert.ok(out.includes(`customer:080 (expected Name = ${JSON.stringify(realName)}`) && out.includes(`${customer.Id} "Renamed In The Portal"`), "the planned key, the expected value and the unrecognised record are all named");
    assert.match(out, /The id-map cannot be rebuilt for Sundial_Service_Payment__c/);
    assert.ok(out.includes("payment:001-1") && out.includes(payment.Id));
    assert.match(out, /--allow-unaccounted does not override this/);
    assert.match(out, /The id-map was NOT rebuilt \(nothing was saved\)/);
    assert.deepEqual(writes(w), counts, `${args.join(" ")} wrote something`);
    assert.ok(!w.files.has("id-map.json"));
  }
  // Put the two fields back, as the message says: the rebuild goes through, with nothing created.
  customer.Name = realName;
  payment.Amount__c = realAmount;
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply"], w.io), 0, tail(w));
  assert.deepEqual(w.idmap().ids, ids);
  assert.deepEqual(writes(w), counts);
});

test("(2) a run record left over from a removed demo tenant is replaced by a fresh seed; a tenant made by hand is still usable", async () => {
  const w = world();
  w.secrets.set(DEMO_USERS_SECRET, JSON.stringify({ [RUN_RECORD_KEY]: { "conops-demo": { tenantId: "aAZ000000009999AAA", anchor: { date: "2026-06-01", now: "2026-06-01T17:00:00.000Z" }, seed: 5, options: null, freshen: [] } } }));
  assert.equal(await runSeed(["--apply", "--phase", "tenant"], w.io), 0, tail(w));
  assert.match(w.output(), /replacing a run record left over from an earlier demo tenant \(2026-06-01\)/);
  assert.deepEqual(secretOf(w)[RUN_RECORD_KEY]["conops-demo"].anchor, { date: "2026-09-29", now: "2026-09-29T17:40:00.000Z" });
  assert.equal(secretOf(w)[RUN_RECORD_KEY]["conops-demo"].tenantId, demoTenant(w).Id);
  // A tenant record created by hand, never seeded, no run record: seeded normally.
  const w2 = world();
  w2.org.insertRaw(OBJ.tenant, { Name: "conops-demo" });
  assert.equal(await runSeed(["--apply", "--phase", "tenant"], w2.io), 0, tail(w2));
  assert.match(w2.output(), /already exists \(a\w{17}\) and has never been seeded; using it/);
  assert.equal(w2.org.all(OBJ.tenant).filter((t) => t.Name === "conops-demo").length, 1);
});

test("(3) --demo-phone / --demo-email on a LATER run: accepted until the three live-demo customers exist, refused afterwards", async () => {
  const w = world();
  const phone = "+16025550142";
  const email = "owner@example.org";
  // The docs' slow path: the first --apply is the tenant phase, without the flags.
  assert.equal(await runSeed(["--apply", "--phase", "tenant"], w.io), 0);
  assert.equal(await runSeed(["--apply", "--phase", "dealers"], w.io), 0);
  assert.equal(w.idmap().options.demoPhone, null);
  // Now the owner remembers. The customers do not exist yet, so the flags are taken.
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply", "--phase", "users", "--demo-phone", phone, "--demo-email", email], w.io), 0, tail(w));
  assert.match(w.output(), /--demo-phone accepted: the three live-demo customers have not been created yet \(it was not set on the first --apply\)/);
  assert.match(w.output(), /--demo-email accepted/);
  assert.deepEqual([w.idmap().options.demoPhone, w.idmap().options.demoEmail], [phone, email]);
  assert.deepEqual(secretOf(w)[RUN_RECORD_KEY]["conops-demo"].options, w.idmap().options, "the run record follows");
  // Later runs need not repeat them: the stored values stand.
  assert.equal(await runSeed(["--apply", "--phase", "customers"], w.io), 0, tail(w));
  const live = mine(w, OBJ.customer).filter((c) => c.Primary_Phone__c === phone);
  assert.equal(live.length, 3);
  for (const c of live) assert.equal(c.Primary_Email__c, email);
  // Once they exist a DIFFERENT value is refused, and the message names the three records.
  w.lines.length = 0;
  const before = writes(w);
  assert.equal(await runSeed(["--apply", "--phase", "solar", "--demo-phone", "+16025550143"], w.io), 1);
  assert.match(w.output(), /--demo-phone differs from the first --apply \("\+16025550142"\), and the live-demo customers already exist/);
  for (const c of live) assert.ok(w.output().includes(`${c.Name} (`) && w.output().includes(c.Id), `${c.Name} is named with its id`);
  assert.deepEqual(writes(w), before);
  assert.equal(w.idmap().options.demoPhone, phone);
  // The same value again is no change at all.
  assert.equal(await runSeed(["--apply", "--phase", "solar", "--demo-phone", phone], w.io), 0, tail(w));

  // --with-sold-pending-review follows the same rule, for its one customer and one project.
  const w2 = world();
  for (const phase of ["tenant", "dealers", "users"]) assert.equal(await runSeed(["--apply", "--phase", phase], w2.io), 0);
  assert.equal(await runSeed(["--apply", "--phase", "customers", "--with-sold-pending-review"], w2.io), 0, tail(w2));
  assert.equal(mine(w2, OBJ.customer).filter((c) => c.Stage__c === "Sold - Pending Review").length, 1);
  const w3 = world();
  for (const phase of ["tenant", "dealers", "users", "customers"]) assert.equal(await runSeed(["--apply", "--phase", phase], w3.io), 0);
  w3.lines.length = 0;
  assert.equal(await runSeed(["--apply", "--phase", "solar", "--with-sold-pending-review"], w3.io), 1);
  assert.match(w3.output(), /--with-sold-pending-review was not given on the first --apply, and customer:\d{3} \(a\w{17}\) already exists/);
  assert.equal(mine(w3, OBJ.solar).length, 0);
});

test("(4) --phase files without --with-files uploads nothing", async () => {
  const w = await seeded();
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply", "--phase", "files"], w.io), 1);
  assert.match(w.output(), /--phase files uploads the sample PDFs to S3, so it must be asked for explicitly: add --with-files/);
  assert.equal(w.s3.size, 0);
  assert.equal(w.supabase.rowsFor("sundial_file_metadata", demoTenant(w).Id).length, 0);
  assert.equal(await runSeed(["--apply", "--phase", "files", "--with-files"], w.io), 0, tail(w));
  assert.equal(w.s3.size, 25);
});

test("(5) files: a run that stopped between the upload and its metadata row resumes with the real size, never null", async () => {
  const w = await seeded(["--with-files"]);
  const t = demoTenant(w);
  const table = w.supabase.tables.get("sundial_file_metadata");
  const rows = w.supabase.rowsFor("sundial_file_metadata", t.Id);
  for (const r of rows) assert.equal(r.file_size_bytes, w.s3.get(r.s3_key).size);
  // Take three rows away — exactly what a stop after the S3 put leaves behind (the id-map already has the key).
  const gone = rows.slice(0, 3).map((r) => r.s3_key);
  for (const key of gone) table.splice(table.findIndex((r) => r.s3_key === key), 1);
  const uploads = w.s3.size;
  assert.equal(await runSeed(["--apply", "--phase", "files", "--with-files"], w.io), 0, tail(w));
  assert.equal(w.s3.size, uploads);
  const again = w.supabase.rowsFor("sundial_file_metadata", t.Id);
  assert.equal(again.length, 25);
  for (const key of gone) {
    const row = again.find((r) => r.s3_key === key);
    assert.ok(Number.isInteger(row.file_size_bytes) && row.file_size_bytes > 500, `${key}: size ${row.file_size_bytes}`);
    assert.equal(row.file_size_bytes, w.s3.get(key).size, "the size of the bytes that were uploaded");
  }
});

test("(5) an update is refused unless its target is in the id-map AND Salesforce says it carries the demo tenant", async () => {
  const w = world();
  for (const phase of ["tenant", "dealers", "users", "customers"]) assert.equal(await runSeed(["--apply", "--phase", phase], w.io), 0);
  const plan = JSON.parse(w.files.get("plan.json"));
  const schema = schemaFromProbe(probe);
  const make = async (mutate) => {
    const data = w.idmap();
    mutate(data);
    const idmap = new IdMap({ read: async () => data, write: async () => {} }, data);
    const lines = [];
    const writer = new Writer({ sf: w.io.sf, idmap, schema, ops: plan.ops, log: (l) => lines.push(l), counters: { created: {}, updated: {}, skipped: {} }, now: w.io.now });
    return { writer, idmap, lines };
  };
  const update = { op: "update", key: "customer:001#test", target: "customer:001", object: OBJ.customer, phase: "solar", fields: { Notes__c: "DEMO DATA - fictional customer. Touched by the test." } };
  const updates = () => w.org.calls.updates.length;
  const n = updates();

  // 1. The id-map points the key at a record of ANOTHER tenant (a corrupted or hand-edited file).
  const harmonBefore = JSON.stringify(w.org.get(w.org.harmonCustomerId));
  let x = await make((d) => { d.ids["customer:001"] = w.org.harmonCustomerId; });
  await assert.rejects(x.writer.update(update), (e) => e.code === "NOT_OWNED" && /its Client__c is not the demo tenant/.test(e.message));
  assert.equal(JSON.stringify(w.org.get(w.org.harmonCustomerId)), harmonBefore, "Harmon's customer was not touched");
  // 2. The id does not exist.
  x = await make((d) => { d.ids["customer:001"] = "aCZ000000099999AAA"; });
  await assert.rejects(x.writer.update(update), (e) => e.code === "NOT_OWNED" && /Salesforce has no such record/.test(e.message));
  // 3. The key is in the id-map, but for another object.
  x = await make(() => {});
  await assert.rejects(x.writer.update({ ...update, target: "dealer:saguaro" }), (e) => e.code === "NOT_OWNED" && /is not a Sundial_Customer__c recorded in the id-map/.test(e.message));
  // 4. A target that is not in the id-map at all never reaches Salesforce either.
  await assert.rejects(x.writer.update({ ...update, target: "customer:999" }), (e) => e.code === "MISSING_REFERENCE");
  assert.equal(updates(), n, "no update was sent");

  // A genuine target: ONE query verifies every customer this run will update, then the update goes through.
  x = await make(() => {});
  const q = w.org.calls.queries.length;
  await x.writer.update(update);
  assert.equal(updates(), n + 1);
  const asked = w.org.calls.queries.slice(q);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^SELECT Id, Client__c FROM Sundial_Customer__c WHERE Id IN \(/);
  const solarTargets = new Set(plan.ops.filter((o) => o.op === "update" && o.object === OBJ.customer).map((o) => o.target));
  assert.equal(asked[0].match(/'a\w{17}'/g).length, solarTargets.size, "every customer the plan updates was checked in that one query");
  await x.writer.update({ ...update, key: "customer:002#test", target: "customer:002" });
  assert.equal(w.org.calls.queries.length, q + 1, "the second update of the same object needs no second query");
  // In a full run the same question is asked once per updated object — even about records the run has just created.
  const full = await seeded();
  const asks = full.org.calls.queries.map((soql) => /^SELECT Id, Client__c FROM (\w+) WHERE Id IN \(/.exec(soql)?.[1]).filter(Boolean);
  assert.deepEqual(asks.sort(), [OBJ.customer, OBJ.estimate, OBJ.job, OBJ.solar].sort(), "one verification query for each object the seed updates");
  // A record of the run's own tenant that turns out to belong elsewhere AMONG the batch stops the first update too.
  x = await make((d) => { d.ids["customer:050"] = w.org.harmonCustomerId; });
  await assert.rejects(x.writer.update(update), (e) => e.code === "NOT_OWNED");
  assert.equal(updates(), n + 2);
});

test("(6) a Flow that only fires in ONE stage is caught by that stage's canary, not missed by the first record's", async () => {
  // Solar: automation on "Install Scheduled" only. The first solar record (another stage) reads back clean.
  const w = world();
  w.org.afterCreate = (o, r) => { if (o === OBJ.solar && r.Stage__c === "Install Scheduled") r.Budget_Calc_Status__c = "Pending"; };
  assert.equal(await runSeed(["--apply"], w.io), 1);
  assert.match(w.output(), /canary Sundial_Solar__c \[first record, stage: \w[^\]]*\]: solar:001 read back exactly as written/);
  assert.match(w.output(), /CANARY FAILED on Sundial_Solar__c \(solar:\d{3}, a\w{17}\) — stage: Install Scheduled\./);
  assert.match(w.output(), /Budget_Calc_Status__c: holds "Pending" but this script never wrote it/);
  const solar = mine(w, OBJ.solar);
  assert.equal(solar.filter((s) => s.Stage__c === "Install Scheduled").length, 1, "exactly one record was written in the stage that misbehaves");
  assert.ok(solar.length > 1 && solar.length < 50);
  assert.equal(mine(w, OBJ.roofing).length, 0, "and nothing after it");
  const stopped = solar.length;
  // Running again does not slip past it.
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply"], w.io), 1);
  assert.match(w.output(), /CANARY FAILED on Sundial_Solar__c/);
  assert.equal(mine(w, OBJ.solar).length, stopped);
  // Accepting it accepts THAT field on that object — the Flow is still there, and the run now completes…
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply", "--accept-canary", "Sundial_Solar__c"], w.io), 0, tail(w));
  assert.match(w.output(), /--accept-canary Sundial_Solar__c: accepting the difference found on solar:\d{3} in Budget_Calc_Status__c/);
  assert.match(w.output(), /accepted difference\(s\): Budget_Calc_Status__c/);
  assert.equal(mine(w, OBJ.solar).length, 50);
  assert.deepEqual(w.idmap().canaryAccepted, { [OBJ.solar]: ["Budget_Calc_Status__c"] });

  // …but an acceptance covers nothing else: a different field in a later stage still stops the run.
  const w2 = world();
  w2.org.afterCreate = (o, r) => {
    if (o !== OBJ.solar) return;
    r.Budget_Calc_Status__c = "Pending"; // every stage
    if (r.Stage__c === "Green Tagged") r.Stage_Notes__c = "Rewritten by a Flow";
  };
  assert.equal(await runSeed(["--apply"], w2.io), 1);
  assert.equal(mine(w2, OBJ.solar).length, 1);
  w2.lines.length = 0;
  assert.equal(await runSeed(["--apply", "--accept-canary", "Sundial_Solar__c"], w2.io), 1);
  assert.match(w2.output(), /CANARY FAILED on Sundial_Solar__c \(solar:\d{3}, a\w{17}\) — stage: Green Tagged\./);
  assert.match(w2.output(), /Stage_Notes__c: wrote .*, read back "Rewritten by a Flow"/);
  assert.ok(!w2.output().includes("Budget_Calc_Status__c: holds"), "the accepted field is not reported as a surprise again");
  assert.match(w2.output(), /accepted difference\(s\): Budget_Calc_Status__c/, "…it is listed as accepted on the canaries that passed");
  assert.equal(mine(w2, OBJ.solar).filter((s) => s.Stage__c === "Green Tagged").length, 1);
  // An --accept-canary with nothing to accept says so, and changes nothing.
  const w3 = world();
  assert.equal(await runSeed(["--apply", "--phase", "tenant", "--accept-canary", "Sundial_Customer__c"], w3.io), 0);
  assert.match(w3.output(), /--accept-canary Sundial_Customer__c: no failed canary is recorded for it — nothing to accept/);
  assert.deepEqual(w3.idmap().canaryAccepted, {});

  // Customers: a stage-driven Flow on the sales pipeline, and one on the Service pipeline.
  for (const [label, flow, expect] of [
    ["sales stage", (r) => { if (r.Stage__c === "Verbal Yes") r.Follow_Up_Needed__c = true; }, /CANARY FAILED on Sundial_Customer__c \(customer:\d{3}, a\w{17}\) — stage: Opportunity \/ Verbal Yes\./],
    ["status without a stage", (r) => { if (r.Status__c === "Lead" && !r.Stage__c) r.In_Nurture_Campaign__c = true; }, /CANARY FAILED on Sundial_Customer__c \(customer:\d{3}, a\w{17}\) — .*status: Lead/],
    ["service stage", (r) => { if (r.Service_Stage__c === "Waiting on Customer") r.Call_Attempts__c = 9; }, /CANARY FAILED on Sundial_Customer__c \(customer:\d{3}, a\w{17}\) — .*service stage: Waiting on Customer/],
  ]) {
    const wc = world();
    wc.org.afterCreate = (o, r) => { if (o === OBJ.customer) flow(r); };
    assert.equal(await runSeed(["--apply"], wc.io), 1, label);
    assert.match(wc.output(), expect, label);
    assert.equal(mine(wc, OBJ.solar).length, 0, `${label}: nothing after the customers`);
    assert.ok(mine(wc, OBJ.customer).length < 100, label);
  }
});

test("(6) a crash between a stage canary's write and its read-back: the read-back is done first thing on the next run", async () => {
  const w = world();
  const real = w.io.sf.sfQuery;
  let armed = true;
  // The network drops on the read-back of the first "Install Scheduled" project.
  w.io.sf.sfQuery = async (soql) => {
    const m = /FROM Sundial_Solar__c WHERE Id = '(a\w{17})'/.exec(soql);
    if (armed && m && !/^SELECT Id, Name FROM/.test(soql) && w.org.get(m[1]).Stage__c === "Install Scheduled") { armed = false; throw new Error("fetch failed (simulated)"); }
    return real(soql);
  };
  assert.equal(await runSeed(["--apply"], w.io), 1);
  const open = w.idmap().canaryOpen[OBJ.solar];
  assert.deepEqual([open.state, open.tags], ["pending", ["stage: Install Scheduled"]]);
  const n = mine(w, OBJ.solar).length;
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply"], w.io), 0, tail(w));
  assert.match(w.output(), new RegExp(`canary Sundial_Solar__c \\[stage: Install Scheduled\\]: ${open.key} read back exactly as written`));
  assert.deepEqual(w.idmap().canaryOpen, {});
  assert.equal(mine(w, OBJ.solar).length, 50);
  assert.ok(n < 50);
});

test("(6) the final check reports — and does not stop for — records modified after this script's own last write", async () => {
  const w = await seeded();
  assert.match(w.output(), /no record was modified after this script's own last write to it \(\d+ compared\)/);
  const ids = w.idmap().ids;
  assert.equal(Object.keys(w.idmap().lastWrite).length, Object.keys(ids).length, "every record has a last-write time");
  assert.deepEqual(w.idmap().pendingWrites, {});
  // Something else touches two records: one a minute later, one within the tolerance.
  const later = (key, ms) => { const r = w.org.get(ids[key]); r.LastModifiedDate = new Date(Date.parse(r.LastModifiedDate) + ms).toISOString(); r.SystemModstamp = r.LastModifiedDate; return r; };
  const touched = later("customer:017", 61000);
  later("customer:018", MODIFIED_TOLERANCE_MS - 1000);
  const before = writes(w);
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply"], w.io), 0, "a modified record is reported, never a reason to stop");
  assert.match(w.output(), /NOTE — 1 demo record\(s\) were modified by something OTHER than this script \(more than 5 seconds after its own last write\)/);
  assert.ok(w.lines.some((l) => l.includes("customer:017") && l.includes(touched.Id) && /61 s after/.test(l)));
  assert.ok(!w.lines.some((l) => l.includes("customer:018 ")));
  assert.match(w.output(), /all records verified/);
  assert.deepEqual(writes(w), before);
  // Reported once: the next run has nothing new to say about it.
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply"], w.io), 0);
  assert.match(w.output(), /no record was modified after this script's own last write/);

  // The script's own later writes are not "something else": a PC clock that is 3 minutes off
  // Salesforce's makes no difference, because the offset is measured from the records just created.
  const w2 = world();
  const orgNow = w2.io.now;
  w2.io.now = () => new Date(orgNow().getTime() - 180000);
  assert.equal(await runSeed(["--apply"], w2.io), 0, tail(w2));
  assert.match(w2.output(), /no record was modified after this script's own last write to it/);
  // --freshen runs the same check, over its own writes too.
  w2.setNow("2026-10-15T16:50:00.000Z");
  w2.io.now = () => new Date(Date.parse("2026-10-15T16:50:00.000Z") - 180000 + 90000);
  w2.lines.length = 0;
  assert.equal(await runSeed(["--freshen", "--apply"], w2.io), 0, tail(w2));
  assert.match(w2.output(), /no record was modified after this script's own last write to it/);
});

test("(6) no SOQL string the tool ever sends is longer than a safe length — seed, re-run, rebuild and freshen", async () => {
  const w = await seeded(["--with-files", "--with-sold-pending-review"]);
  assert.equal(await runSeed(["--apply", "--phase", "solar"], w.io), 0); // a resumed phase: the update targets are verified in bulk
  w.files.delete("id-map.json");
  assert.equal(await runSeed(["--apply"], w.io), 0, tail(w)); // the rebuild and its extra reads
  w.setNow("2026-10-15T16:50:00.000Z");
  assert.equal(await runSeed(["--freshen", "--apply"], w.io), 0, tail(w));
  const queries = w.org.calls.queries;
  assert.ok(queries.length > 400);
  const longest = queries.reduce((a, b) => (b.length > a.length ? b : a));
  assert.ok(longest.length <= SOQL_HARD_LIMIT, `a ${longest.length}-character query: ${longest.slice(0, 80)}…`);
  // lib/salesforce.js sends the query URL-encoded in the request line; Salesforce refuses one much over 16,000.
  const encoded = Math.max(...queries.map((q) => encodeURIComponent(q).length));
  assert.ok(encoded <= 8000, `${encoded} characters once URL-encoded`);
  // The full read-back really is in pieces: 510 fields do not fit one query.
  const solarReads = queries.filter((q) => /FROM Sundial_Solar__c WHERE Id = /.test(q) && !/^SELECT Id, Name FROM/.test(q));
  assert.equal(solarReads.length, 34 * 3, "34 stage canaries x 3 queries");
  assert.ok(queries.filter((q) => / IN \(/.test(q)).every((q) => (q.match(/'a\w{17}'/g) || q.match(/'[^']+'/g)).length <= 150), "ids go in chunks of at most 150");
});

test("(9) the id-map's atomic write: a locked rename is retried, then overwritten in place — and a real failure is never called success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "demo-seed-files-"));
  try {
    const flaky = (failures, code = "EPERM") => {
      let left = failures;
      const calls = { rename: 0, sleeps: [] };
      const fs = { ...realFs, rename: async (a, b) => { calls.rename++; if (left-- > 0) { const e = new Error(`${code}: operation not permitted, rename`); e.code = code; throw e; } return realFs.rename(a, b); } };
      return { calls, files: localFiles(dir, { fs, sleep: async (ms) => { calls.sleeps.push(ms); }, onFallback: (name, c) => { calls.fallback = [name, c]; } }) };
    };
    // Antivirus holds the file for two renames: the third goes through.
    let t = flaky(2);
    await t.files.writeJsonAtomic("id-map.json", { n: 1 });
    assert.deepEqual(await t.files.readJson("id-map.json"), { n: 1 });
    assert.equal(t.calls.rename, 3);
    assert.deepEqual(t.calls.sleeps, [40, 80], "a short, growing pause between attempts");
    assert.equal(t.calls.fallback, undefined);
    // EBUSY and EACCES are the same situation.
    for (const code of ["EBUSY", "EACCES"]) { t = flaky(1, code); await t.files.writeJsonAtomic("id-map.json", { code }); assert.deepEqual(await t.files.readJson("id-map.json"), { code }); }
    // Locked for every attempt: the file is overwritten in place, and no .tmp is left behind.
    t = flaky(99);
    await t.files.writeJsonAtomic("id-map.json", { n: 2 });
    assert.equal(t.calls.rename, RENAME_ATTEMPTS);
    assert.equal(t.calls.sleeps.length, RENAME_ATTEMPTS - 1);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "id-map.json"), "utf8")), { n: 2 });
    assert.deepEqual(t.calls.fallback, ["id-map.json", "EPERM"]);
    assert.deepEqual((await readdir(dir)).sort(), ["id-map.json"]);
    // Any other error is not retried; and if even the overwrite fails, the error reaches the caller.
    t = flaky(1, "ENOSPC");
    await assert.rejects(t.files.writeJsonAtomic("id-map.json", { n: 3 }), /ENOSPC/);
    assert.equal(t.calls.rename, 1);
    const dead = localFiles(dir, { sleep: async () => {}, fs: { ...realFs, rename: async () => { const e = new Error("EPERM"); e.code = "EPERM"; throw e; }, writeFile: async (p, ...rest) => { if (!String(p).endsWith(".tmp")) { const e = new Error("EPERM: locked"); e.code = "EPERM"; throw e; } return realFs.writeFile(p, ...rest); } } });
    await assert.rejects(dead.writeJsonAtomic("id-map.json", { n: 4 }), /EPERM/);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "id-map.json"), "utf8")), { n: 2 }, "the last good file is still there");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // In a run: when the id-map cannot be saved, the run stops and does NOT claim the id-map is up to date.
  const w = world();
  const write = w.io.files.writeJsonAtomic;
  let saves = 0;
  w.io.files.writeJsonAtomic = async (name, obj) => {
    if (name === "id-map.json" && ++saves === 40) { const e = new Error("EPERM: operation not permitted, open"); e.code = "EPERM"; throw e; }
    return write(name, obj);
  };
  assert.equal(await runSeed(["--apply"], w.io), 1);
  assert.match(w.output(), /STOPPED: the id-map could not be saved \(EPERM\)/);
  assert.match(w.output(), /The id-map could NOT be saved, so it is BEHIND what was written/);
  assert.ok(!w.output().includes("The id-map is up to date"), "never claimed when the write failed");
  // …and the record that was written but not recorded is re-found on the next run, not created twice.
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply"], w.io), 0, tail(w));
  const ids = Object.values(w.idmap().ids);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, w.org.calls.creates.length);
  // A run that stops for another reason still says the id-map is up to date — because it is.
  const w2 = world();
  w2.org.crash = { at: 30, mode: "before" };
  assert.equal(await runSeed(["--apply"], w2.io), 1);
  assert.match(w2.output(), /The id-map is up to date with everything that was written/);
});

test("(10) the printed cache-sync command cannot time out and retry: --cli-read-timeout 0, still one PowerShell line", async () => {
  assert.equal(CACHE_SYNC_COMMAND, 'aws lambda invoke --function-name sundial-cache-sync --region us-west-1 --cli-binary-format raw-in-base64-out --cli-read-timeout 0 --payload "{}" out-cache-sync.json');
  const w = await seeded();
  const commands = w.lines.filter((l) => l.includes("aws lambda invoke"));
  assert.equal(commands.length, 2);
  for (const c of commands) {
    assert.match(c, /--cli-read-timeout 0 /);
    assert.ok(!/[`;|&<>^]|\$\(/.test(c), "nothing PowerShell would interpret");
    assert.equal((c.match(/"/g) || []).length % 2, 0, "quotes are balanced");
  }
  assert.ok(commands[0].trim() === CACHE_SYNC_COMMAND);
  // --freshen prints the same command.
  w.setNow("2026-10-15T16:50:00.000Z");
  w.lines.length = 0;
  assert.equal(await runSeed(["--freshen", "--apply"], w.io), 0);
  assert.ok(w.lines.some((l) => l.trim() === CACHE_SYNC_COMMAND));
});

test("(7) --with-sold-pending-review: 34 of 34 solar stages, and the stage on exactly one customer and one project", async () => {
  const plain = await seeded();
  const stagesOf = (w) => new Set(mine(w, OBJ.solar).map((s) => s.Stage__c));
  assert.equal(stagesOf(plain).size, 33);
  assert.ok(!stagesOf(plain).has("Sold - Pending Review"));
  assert.ok(!mine(plain, OBJ.customer).some((c) => c.Stage__c === "Sold - Pending Review"));
  assert.match(plain.output(), /Not covered on purpose: "Sold - Pending Review"/);
  assert.match(plain.output(), /solar:\d{3} sits in the next stage,\s+"Audit", and its customer customer:\d{3} in "Processing Documents"/);
  const w = await seeded(["--with-sold-pending-review"]);
  assert.equal(stagesOf(w).size, 34, "all 34 solar stages");
  assert.match(w.output(), /Solar pipeline: 34 of 34 live stages covered/);
  assert.match(w.output(), /"Sold - Pending Review" IS used \(--with-sold-pending-review\): on customer customer:\d{3} and on project solar:\d{3}/);
  const project = mine(w, OBJ.solar).filter((s) => s.Stage__c === "Sold - Pending Review");
  const customer = mine(w, OBJ.customer).filter((c) => c.Stage__c === "Sold - Pending Review");
  assert.deepEqual([project.length, customer.length], [1, 1]);
  assert.equal(project[0].Sundial_Customer__c, customer[0].Id, "the project's own customer");
  // That stage got its own canary on both objects.
  assert.match(w.output(), /canary Sundial_Solar__c \[stage: Sold - Pending Review\]/);
  assert.match(w.output(), /canary Sundial_Customer__c \[stage: Customer \/ Sold - Pending Review\]/);
});
