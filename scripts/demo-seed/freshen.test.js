// `--freshen`: weeks after the seed, the dispatch board, the tech app and payroll must
// look alive again — without touching anything the seed did not create, and without
// breaking the rule that a job's status follows its calls.
//
//   node --experimental-test-module-mocks --test scripts/demo-seed/plan.test.js scripts/demo-seed/run.test.js scripts/demo-seed/freshen.test.js
//   (the file-list form: on Node 22 `node --test <folder>` does not run the folder's tests)

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIntervals, openIntervalIndex } from "../../lambdas/sundial-service-board/tech.js";
import { buildPayroll, weekBounds, weekMonday } from "../../lambdas/sundial-service-board/day.js";
import { splitBlocks } from "../../lambdas/sundial-service-board/job-notes.js";
import { createFakeIo } from "./fakes.js";
import { runSeed } from "./run.js";
import { loadProbe } from "./test-helpers.js";
import { planFreshen } from "./freshen.js";
import { OBJ } from "./policy.js";
import { TECH_KEYS, PERSONAS } from "./catalog.js";
import { PHOENIX_TZ, phxDateOf, phxMinutesOf, addDays, isWeekday } from "./dates.js";
import { DEMO_USERS_SECRET } from "./policy.js";
import { RUN_RECORD_KEY } from "./run-record.js";

const OPEN = ["Scheduled", "En Route", "In Progress"];
const iso = (v) => new Date(v).toISOString();

async function seededWorld() {
  const w = createFakeIo(loadProbe()); // Tuesday 2026-09-29, 10:40 in Phoenix
  assert.equal(await runSeed(["--apply"], w.io), 0, w.output().split("\n").slice(-15).join("\n"));
  const tenant = w.org.all(OBJ.tenant).find((t) => t.Name === "conops-demo");
  const mine = (o) => w.org.all(o).filter((r) => r.Client__c === tenant.Id);
  return { w, tenant, mine };
}

function checkBoard({ w, mine }, today, nowIso) {
  const calls = mine(OBJ.call);
  const techIds = TECH_KEYS.map((k) => w.idmap().ids[k]);
  // Every open call is in today … +7, and nothing still "Scheduled" lies in the past.
  for (const c of calls.filter((x) => OPEN.includes(x.Status__c))) {
    const day = phxDateOf(iso(c.Scheduled_Start__c));
    assert.ok(day >= today && day <= addDays(today, 7), `${c.Name} (${c.Status__c}) is scheduled on ${day}`);
    if (c.Status__c === "Scheduled") assert.ok(iso(c.Scheduled_Start__c) > nowIso, `${c.Name} is Scheduled in the past`);
  }
  // Today's picture: one tech clocked in (open interval), one on the way.
  const inProgress = calls.filter((c) => c.Status__c === "In Progress");
  const enRoute = calls.filter((c) => c.Status__c === "En Route");
  assert.equal(inProgress.length, 1);
  assert.equal(enRoute.length, 1);
  for (const c of [...inProgress, ...enRoute]) {
    assert.equal(phxDateOf(iso(c.Scheduled_Start__c)), today);
    const log = parseIntervals(c.Clock_Intervals__c);
    assert.ok(openIntervalIndex(log) >= 0, `${c.Name}: the clock is open`);
    assert.equal(phxDateOf(log[0].in), today);
    assert.equal(!!log[0].arrived, c.Status__c === "In Progress");
  }
  // No tech is double-booked, and the working hours hold.
  for (const techId of techIds) {
    const windows = calls.filter((c) => c.Tech__c === techId && c.Scheduled_Start__c && c.Status__c !== "Cancelled")
      .map((c) => [iso(c.Scheduled_Start__c), iso(c.Scheduled_End__c), c.Name]).sort();
    for (let i = 0; i < windows.length; i++) {
      assert.ok(phxMinutesOf(windows[i][0]) >= 7 * 60 && phxMinutesOf(windows[i][1]) <= 16 * 60, `${windows[i][2]} is outside working hours`);
      if (i > 0) assert.ok(windows[i - 1][1] <= windows[i][0], `${windows[i - 1][2]} and ${windows[i][2]} overlap`);
    }
    // Today the tech has 2–4 calls; each later working day at most four.
    const todays = windows.filter(([s]) => phxDateOf(s) === today).length;
    assert.ok(todays >= 2 && todays <= 4, `tech has ${todays} calls today`);
  }
  // Every job still agrees with its calls (the settleJobStatus outcomes).
  for (const job of mine(OBJ.job)) {
    const mineCalls = calls.filter((c) => c.Sundial_Service_Job__c === job.Id);
    const open = mineCalls.filter((c) => OPEN.includes(c.Status__c)).length;
    const complete = mineCalls.filter((c) => c.Status__c === "Complete").length;
    if (job.Status__c === "Scheduled") { assert.ok(open >= 1, `${job.Name} Scheduled without an open call`); assert.equal(complete, 0, `${job.Name} Scheduled with completed work`); assert.ok(!mineCalls.some((c) => c.Status__c === "In Progress")); }
    else if (job.Status__c === "In Progress") assert.ok(mineCalls.some((c) => c.Status__c === "In Progress") || (complete >= 1 && open >= 1), `${job.Name} In Progress`);
    else assert.equal(open, 0, `${job.Name} (${job.Status__c}) has an open call`);
  }
}

test("--freshen needs a seeded tenant", async () => {
  const w = createFakeIo(loadProbe());
  assert.equal(await runSeed(["--freshen", "--apply"], w.io), 1);
  assert.match(w.output(), /nothing to freshen/);
  assert.equal(w.org.calls.creates.length + w.org.calls.updates.length, 0);
});

test("--freshen, sixteen days after the seed: the board, today's picture and payroll are current again", async () => {
  const s = await seededWorld();
  const { w, mine } = s;
  const harmon = JSON.stringify([w.org.get(w.org.harmonCustomerId), w.org.get(w.org.harmonJobUserId)]);
  const jobsBefore = new Map(mine(OBJ.job).map((j) => [j.Id, j.Status__c]));
  const before = { creates: w.org.calls.creates.length, updates: w.org.calls.updates.length, calls: mine(OBJ.call).length, days: mine(OBJ.day).length, inserts: w.supabase.inserts.length };
  const seedCreated = new Set(w.org.calls.creates.map((c) => c.id));

  const nowIso = "2026-10-15T16:50:00.000Z"; // Thursday 09:50 in Phoenix
  w.setNow(nowIso);
  const today = "2026-10-15";

  // Dry run first: says what it would do, writes nothing.
  w.lines.length = 0;
  assert.equal(await runSeed(["--freshen"], w.io), 0, w.output());
  assert.match(w.output(), /the board is anchored to 2026-09-29; today is 2026-10-15/);
  assert.match(w.output(), /Dry run: pass --freshen --apply/);
  assert.equal(w.org.calls.creates.length, before.creates);
  assert.equal(w.org.calls.updates.length, before.updates);

  w.lines.length = 0;
  assert.equal(await runSeed(["--freshen", "--apply"], w.io), 0, w.output());
  checkBoard(s, today, nowIso);

  // Only records of the demo were touched, and only the demo tenant grew.
  const owned = new Set(w.org.calls.creates.map((c) => c.id));
  for (const u of w.org.calls.updates.slice(before.updates)) assert.ok(owned.has(u.id), `freshen updated ${u.id}, which the demo did not create`);
  for (const c of w.org.calls.creates.slice(before.creates)) {
    assert.ok([OBJ.call, OBJ.day].includes(c.sfObject), `freshen created a ${c.sfObject}`);
    assert.equal(c.fields.Client__c, s.tenant.Id);
    assert.ok(Object.values(w.idmap().ids).includes(c.id), "every new record is in the id-map");
  }
  assert.equal(JSON.stringify([w.org.get(w.org.harmonCustomerId), w.org.get(w.org.harmonJobUserId)]), harmon);
  assert.equal(w.supabase.inserts.length, before.inserts, "freshen leaves Supabase alone");

  // Job statuses: NOTHING moved. The added calls went onto jobs that were already In Progress.
  for (const j of mine(OBJ.job)) assert.equal(j.Status__c, jobsBefore.get(j.Id), `${j.Name} changed status`);

  // History: Complete calls with clock data for this week's working days (Monday … today), each with a day row.
  const added = mine(OBJ.call).filter((c) => !seedCreated.has(c.Id));
  assert.ok(added.length >= 18 && added.length <= 48, `${added.length} calls added`);
  for (const c of added) {
    assert.equal(c.Status__c, "Complete");
    const day = phxDateOf(iso(c.Scheduled_Start__c));
    assert.ok(day >= "2026-10-12" && day <= today, `added call on ${day}`);
    assert.equal(w.org.get(c.Sundial_Service_Job__c).Status__c, "In Progress");
    assert.ok(day === today || isWeekday(day));
    assert.ok(c.Duration_Minutes__c > 0 && openIntervalIndex(parseIntervals(c.Clock_Intervals__c)) < 0);
    assert.ok(iso(c.Actual_End__c) <= nowIso);
    // Its notes are rolled up onto the job under its own call number, exactly once.
    const job = w.org.get(c.Sundial_Service_Job__c);
    assert.equal(splitBlocks(job.Notes_for_Summary__c).filter((b) => b.callNumber === c.Name).length, 1, `${job.Name}: roll-up of ${c.Name}`);
  }
  const days = mine(OBJ.day);
  assert.ok(!days.some((d) => d.Status__c === "Open" && d.Work_Date__c < today), "the old open days were closed");
  assert.equal(days.filter((d) => d.Work_Date__c === today && d.Status__c === "Open").length, 3, "each tech has started today");
  assert.equal(new Set(days.map((d) => d.Day_Key__c)).size, days.length);

  // Payroll for the CURRENT week, computed by the board's own code.
  const techs = TECH_KEYS.map((k) => ({ id: w.idmap().ids[k], name: PERSONAS.find((p) => p.key === k).name }));
  const calls = mine(OBJ.call).map((c) => ({ ...c, Sundial_Service_Job__r: w.org.get(c.Sundial_Service_Job__c) }));
  const report = buildPayroll({ techs, days, calls, week: weekBounds(weekMonday(today), PHOENIX_TZ), timeZone: PHOENIX_TZ, now: nowIso });
  for (const row of report.techs) {
    assert.ok(row.totals.callMinutes > 120, `${row.tech.name}: ${row.totals.callMinutes} minutes this week`);
    for (const d of row.days) assert.ok(d.flag === null, `${row.tech.name} ${d.date}: ${d.flag}`);
  }
  assert.deepEqual(w.idmap().freshen.map((f) => f.date), [today]);

  // The same command again on the same day does nothing.
  const after = { creates: w.org.calls.creates.length, updates: w.org.calls.updates.length };
  w.lines.length = 0;
  assert.equal(await runSeed(["--freshen", "--apply"], w.io), 0);
  assert.match(w.output(), /already anchored to 2026-10-15; nothing to freshen/);
  assert.deepEqual({ creates: w.org.calls.creates.length, updates: w.org.calls.updates.length }, after);

  // And it can be done again later — on a Monday, after a weekend.
  const later = "2026-10-26T20:10:00.000Z";
  w.setNow(later);
  w.lines.length = 0;
  assert.equal(await runSeed(["--freshen", "--apply"], w.io), 0, w.output());
  checkBoard(s, "2026-10-26", later);

  // The seed itself still sees a consistent tenant afterwards (nothing unaccounted, nothing to redo).
  w.lines.length = 0;
  const n = w.org.calls.creates.length;
  assert.equal(await runSeed(["--apply"], w.io), 0, w.output().split("\n").slice(-12).join("\n"));
  assert.equal(w.org.calls.creates.length, n);
});

test("--freshen the very next day only moves the board forward (one day of history)", async () => {
  const s = await seededWorld();
  const nowIso = "2026-09-30T15:30:00.000Z"; // Wednesday 08:30
  s.w.setNow(nowIso);
  const callsBefore = s.mine(OBJ.call).length;
  assert.equal(await runSeed(["--freshen", "--apply"], s.w.io), 0, s.w.output());
  checkBoard(s, "2026-09-30", nowIso);
  const added = s.mine(OBJ.call).length - callsBefore;
  assert.ok(added >= 0 && added <= 6, `${added} calls added for one morning`);
});

test("planFreshen (pure): with no open call left it changes nothing and says why", () => {
  const state = {
    calls: [{ key: "call:001-1", status: "Complete", techKey: TECH_KEYS[0], jobKey: "job:001", start: "2026-09-22T15:00:00.000Z", end: "2026-09-22T17:00:00.000Z", intervals: [] }],
    jobs: [{ key: "job:001", status: "Paid", lat: 33.4, lng: -112, callCount: 1, minutes: 110 }],
    days: [],
  };
  const r = planFreshen(state, { boardDate: "2026-09-29", newDate: "2026-10-15", nowIso: "2026-10-15T17:00:00.000Z", seed: 1 });
  assert.deepEqual(r.ops, []);
  assert.match(r.notes[0], /No demo call is still open/);
});

test("planFreshen (pure): if nobody is clocked in any more, the tech's next call is promoted and its job starts", () => {
  const mk = (n, techKey, status, day) => ({ key: `call:00${n}-1`, status, techKey, jobKey: `job:00${n}`, start: `${day}T16:00:00.000Z`, end: `${day}T18:00:00.000Z`, intervals: [] });
  const state = {
    calls: [mk(1, TECH_KEYS[0], "Scheduled", "2026-09-30"), mk(2, TECH_KEYS[1], "Scheduled", "2026-09-30"), mk(3, TECH_KEYS[2], "Scheduled", "2026-10-01"), mk(4, TECH_KEYS[0], "Scheduled", "2026-10-02")],
    jobs: [1, 2, 3, 4].map((n) => ({ key: `job:00${n}`, status: "Scheduled", lat: 33.45, lng: -112.07, callCount: 1, minutes: 0 })),
    days: [{ key: "day:marcus:2026-09-29", techKey: TECH_KEYS[0], date: "2026-09-29", status: "Open", start: "2026-09-29T14:00:00.000Z", log: [{ kind: "start", at: "2026-09-29T14:00:00.000Z", gps: null, via: "tech" }] }],
  };
  const r = planFreshen(state, { boardDate: "2026-09-29", newDate: "2026-10-06", nowIso: "2026-10-06T17:00:00.000Z", seed: 1 });
  const today = r.ops.filter((o) => o.key.endsWith("#today"));
  assert.deepEqual(today.map((o) => o.fields.Status__c).sort(), ["En Route", "In Progress"]);
  assert.equal(r.summary.promoted, 2);
  // The promoted In Progress call belongs to tech 1, and its job moves Scheduled -> In Progress.
  const started = today.find((o) => o.fields.Status__c === "In Progress");
  assert.equal(started.target, "call:001-1");
  assert.ok(r.ops.some((o) => o.target === "job:001" && o.fields.Status__c === "In Progress"));
  // Every update targets a record from the state (the demo's own), every create is a call or a day.
  const known = new Set([...state.calls.map((c) => c.key), ...state.jobs.map((j) => j.key), ...state.days.map((d) => d.key)]);
  for (const o of r.ops) {
    if (o.op === "update") assert.ok(known.has(o.target), o.key);
    else assert.ok([OBJ.call, OBJ.day].includes(o.object));
  }
  // The day left open on the old "today" is closed.
  assert.ok(r.ops.some((o) => o.target === "day:marcus:2026-09-29" && o.fields.Status__c === "Closed"));
  // Deterministic.
  assert.deepEqual(planFreshen(state, { boardDate: "2026-09-29", newDate: "2026-10-06", nowIso: "2026-10-06T17:00:00.000Z", seed: 1 }).ops, r.ops);
});

// =============================================================================================
// Follow-up fixes (adversarial review, 2026-09-30)
// =============================================================================================

test("(5) --freshen is refused BEFORE it reads or changes anything when the tenant checks fail", async () => {
  const count = (w) => ({ creates: w.org.calls.creates.length, updates: w.org.calls.updates.length });
  // 1. The id-map's tenant is not the tenant Salesforce has under that name.
  {
    const s = await seededWorld();
    const { w } = s;
    w.setNow("2026-10-15T16:50:00.000Z");
    const data = w.idmap();
    data.ids.tenant = "aAZ000000009999AAA";
    w.files.set("id-map.json", JSON.stringify(data));
    const before = count(w);
    const queries = w.org.calls.queries.length;
    w.lines.length = 0;
    assert.equal(await runSeed(["--freshen", "--apply"], w.io), 1);
    assert.match(w.output(), /REFUSED — 1 problem\(s\)\. --freshen changes nothing until every one is resolved/);
    assert.match(w.output(), /The id-map says the demo tenant is aAZ000000009999AAA, but Salesforce has a\w{17} under that name/);
    assert.ok(!w.output().includes("FRESHEN —"), "freshen never started");
    assert.deepEqual(count(w), before);
    assert.equal(w.org.calls.queries.length, queries + 1, "only the tenant lookup was made — no call, job or day was even read");
    assert.deepEqual(w.idmap().freshen, []);
  }
  // 2. The tenant is gone from Salesforce (renamed or removed).
  {
    const s = await seededWorld();
    const { w } = s;
    w.setNow("2026-10-15T16:50:00.000Z");
    s.tenant.Name = "renamed-by-an-admin";
    const before = count(w);
    w.lines.length = 0;
    assert.equal(await runSeed(["--freshen", "--apply"], w.io), 1);
    assert.match(w.output(), /Salesforce has no tenant of that name/);
    assert.deepEqual(count(w), before);
  }
  // 3. Two tenants carry the slug.
  {
    const s = await seededWorld();
    const { w } = s;
    w.setNow("2026-10-15T16:50:00.000Z");
    w.org.insertRaw(OBJ.tenant, { Name: "conops-demo" });
    const before = count(w);
    w.lines.length = 0;
    assert.equal(await runSeed(["--freshen", "--apply"], w.io), 1);
    assert.match(w.output(), /2 tenants are named "conops-demo"/);
    assert.deepEqual(count(w), before);
  }
  // 4. The id-map is missing: freshen does not guess — it says how to rebuild it first.
  {
    const s = await seededWorld();
    const { w } = s;
    w.setNow("2026-10-15T16:50:00.000Z");
    w.files.delete("id-map.json");
    const before = count(w);
    w.lines.length = 0;
    assert.equal(await runSeed(["--freshen", "--apply"], w.io), 1);
    assert.match(w.output(), /--freshen needs the id-map, and it is missing\. Rebuild it first/);
    assert.match(w.output(), /node scripts\/seed-demo-tenant\.mjs --apply/);
    assert.deepEqual(count(w), before);
    assert.ok(!w.files.has("id-map.json"));
  }
});

test("(2) id-map lost after --freshen and a demo: rebuilt from the secret — moved calls by their order under the job, freshen's records by their own log", async () => {
  const s = await seededWorld();
  const { w, mine, tenant } = s;
  const day1 = "2026-10-15T16:50:00.000Z"; // Thursday 09:50 in Phoenix
  w.setNow(day1);
  assert.equal(await runSeed(["--freshen", "--apply"], w.io), 0, w.output().split("\n").slice(-12).join("\n"));
  const before = w.idmap();
  assert.deepEqual(JSON.parse(w.secrets.get(DEMO_USERS_SECRET))[RUN_RECORD_KEY]["conops-demo"].freshen, [{ date: "2026-10-15", at: day1 }], "the freshen date is in the run record");
  assert.ok(Object.keys(before.ids).some((k) => k.startsWith("fresh:2026-10-15:call:")) && Object.keys(before.ids).some((k) => k.startsWith("fresh:2026-10-15:day:")));

  // A demo happens: a tech completes a call, the office reschedules another, someone adds a
  // call to a seeded job and a customer of their own.
  const seedCalls = Object.entries(before.ids).filter(([k]) => k.startsWith("call:"));
  const scheduled = seedCalls.map(([k, id]) => [k, w.org.get(id)]).filter(([, r]) => r.Status__c === "Scheduled");
  assert.ok(scheduled.length >= 10);
  scheduled[0][1].Status__c = "Complete";
  scheduled[1][1].Scheduled_Start__c = "2026-10-21T16:00:00.000Z";
  scheduled[1][1].Scheduled_End__c = "2026-10-21T18:00:00.000Z";
  w.setNow("2026-10-16T18:00:00.000Z");
  const strayCall = w.org.insertRaw(OBJ.call, { Name: "SC-09001", Client__c: tenant.Id, Sundial_Service_Job__c: scheduled[2][1].Sundial_Service_Job__c, Tech__c: scheduled[2][1].Tech__c, Status__c: "Scheduled", Scheduled_Start__c: "2026-10-22T16:00:00.000Z", Scheduled_End__c: "2026-10-22T17:00:00.000Z" });
  const strayCustomer = w.org.insertRaw(OBJ.customer, { Name: "Made In A Demo", Street__c: "1 Demo Way", Client__c: tenant.Id });
  const jobNotes = new Map(mine(OBJ.job).map((j) => [j.Id, j.Notes_for_Summary__c]));
  const counts = { creates: w.org.calls.creates.length, updates: w.org.calls.updates.length, calls: mine(OBJ.call).length, days: mine(OBJ.day).length, payments: mine(OBJ.payment).length };

  // The PC is replaced. No id-map.
  w.files.delete("id-map.json");
  w.setNow("2026-10-19T17:00:00.000Z");
  // The two records made by hand are strangers: without the flag the run stops, as it always did.
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply"], w.io), 1);
  assert.match(w.output(), /holds records the id-map does not account for: 1 x Sundial_Customer__c, 1 x Sundial_Service_Call__c/);
  assert.ok(!/cannot be rebuilt/.test(w.output()), "every planned record WAS found; only the strangers are left over");
  assert.ok(!w.files.has("id-map.json"), "a refused rebuild saves nothing");
  // With it, the rebuild goes through — and creates nothing.
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply", "--allow-unaccounted"], w.io), 0, w.output().split("\n").slice(-14).join("\n"));
  assert.match(w.output(), /id-map rebuilt: \d+ record\(s\) recognised in Salesforce \(\d+ service call\(s\) by their order under the job\) \(\d+ added by --freshen\)/);
  const after = w.idmap();
  assert.deepEqual(after.ids, before.ids, "every key — the seed's and freshen's — maps to the very same record");
  assert.deepEqual(after.objects, before.objects);
  assert.deepEqual(after.freshen.map((f) => f.date), ["2026-10-15"], "the board's date was restored");
  assert.deepEqual({ creates: w.org.calls.creates.length, updates: w.org.calls.updates.length, calls: mine(OBJ.call).length, days: mine(OBJ.day).length, payments: mine(OBJ.payment).length }, counts, "nothing created, nothing updated");
  for (const j of mine(OBJ.job)) assert.equal(j.Notes_for_Summary__c, jobNotes.get(j.Id), `${j.Name}: the notes roll-up was not re-sent over what freshen added`);
  assert.ok(!Object.values(after.ids).includes(strayCall) && !Object.values(after.ids).includes(strayCustomer), "the strangers were left alone");

  // Freshen works again from the rebuilt id-map, from the RIGHT board date (no second copy of last week's history).
  const later = "2026-10-20T17:30:00.000Z"; // Tuesday
  w.setNow(later);
  w.lines.length = 0;
  assert.equal(await runSeed(["--freshen", "--apply"], w.io), 0, w.output().split("\n").slice(-12).join("\n"));
  assert.match(w.output(), /the board is anchored to 2026-10-15; today is 2026-10-20/);
  for (const c of w.org.calls.creates.slice(counts.creates).filter((x) => x.sfObject === OBJ.call)) {
    const day = phxDateOf(iso(c.fields.Scheduled_Start__c));
    assert.ok(day >= "2026-10-19", `freshen added history for ${day}, a day the earlier freshen already covered`);
  }
  const days = mine(OBJ.day);
  assert.equal(new Set(days.map((d) => d.Day_Key__c)).size, days.length, "no tech day twice");
  assert.ok(!days.some((d) => d.Status__c === "Open" && d.Work_Date__c < "2026-10-20"), "the days freshen opened on the 15th were closed — they are in the rebuilt id-map");
});

test("(2) id-map lost and a job's calls no longer add up: refused for that object, never guessed", async () => {
  const s = await seededWorld();
  const { w, tenant } = s;
  const ids = w.idmap().ids;
  // A seeded job with two calls: its first call is moved (natural key changed) AND an older-looking stranger sits under the job.
  const job = Object.keys(ids).find((k) => k.startsWith("job:") && ids[`call:${k.split(":")[1]}-2`] && w.org.get(ids[`call:${k.split(":")[1]}-1`]).Clock_Intervals__c && w.org.get(ids[`call:${k.split(":")[1]}-2`]).Clock_Intervals__c);
  const n = job.split(":")[1];
  const second = w.org.get(ids[`call:${n}-2`]);
  // The clock log of the second call says it is call …-2; make the record OLDER than the first, so the order contradicts it.
  second.CreatedDate = "2026-09-01T00:00:00.000Z";
  second.Status__c = "Cancelled";
  const counts = { creates: w.org.calls.creates.length, updates: w.org.calls.updates.length };
  w.files.delete("id-map.json");
  for (const args of [["--apply"], ["--apply", "--allow-unaccounted"]]) {
    w.lines.length = 0;
    assert.equal(await runSeed(args, w.io), 1, args.join(" "));
    assert.match(w.output(), /The id-map cannot be rebuilt for Sundial_Service_Call__c: 1 planned record\(s\) were not found/);
    assert.ok(w.output().includes(`call:${n}-2`) && w.output().includes(second.Id));
    assert.match(w.output(), /unrecognised under the same Sundial_Service_Job__c/);
    assert.deepEqual({ creates: w.org.calls.creates.length, updates: w.org.calls.updates.length }, counts);
    assert.ok(!w.files.has("id-map.json"));
  }
  void tenant;
});
