// node --test lambdas/sundial-notify/test.js
//
// Drives the real router with a fake identity, a fake Salesforce and the shared fake
// Supabase. Pins: the routes and the action gate, subscribe stamps the CALLER (never the
// body) and re-subscribing the same endpoint replaces the row, unsubscribe only removes
// the caller's own row, /test rings the caller, and the sweep: one-hour reminders to the
// tech, the day-before digest only at the reminder hour and once per tech per day,
// late calls to the office, overrun calls to the tech — all deduped across runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, matchRoute, isSweepEvent, localParts, nextDay, overrunTitle, stillOnClock } from "./index.js";
import { fakeSupabase } from "../../lib/notify.test-fakes.js";

const TENANT = "a1W7y000007AszBEAS";
const ME = "uuid-beth";

function setup(over = {}) {
  const store = {
    profiles: [
      { id: "uuid-beth", tenant_id: TENANT, sundial_user_id: "a0U-beth", access_scope: "tenant" },
      { id: "uuid-paige", tenant_id: TENANT, sundial_user_id: "a0U-paige", access_scope: "tenant" },
      { id: "uuid-larry", tenant_id: TENANT, sundial_user_id: "a0U-larry", access_scope: "tech" },
    ],
    user_preferences: [],
    sundial_notifications: [],
    sundial_push_subscriptions: [],
  };
  const calls = over.calls || [];
  const pushes = [];
  const updates = [];
  const supabase = fakeSupabase(store);
  const deps = {
    resolveIdentity: async () => ({
      tenantId: TENANT,
      tenantSlug: "harmon",
      authUserId: over.authUserId ?? ME,
      user: { id: "a0U-beth", firstName: "Beth", lastName: "Ortiz" },
      access: { level: over.level ?? "Admin", scope: over.scope ?? "tenant", userId: "a0U-beth", tenantId: TENANT },
    }),
    sfQuery: async (soql) => {
      // The overrun query: In Progress, clocked in, not out, Scheduled_End__c in its window.
      if (soql.includes("Actual_Start__c != null")) {
        const ge = soql.match(/Scheduled_End__c >= ([\dT:.Z-]+)/)?.[1];
        const le = soql.match(/Scheduled_End__c <= ([\dT:.Z-]+)/)?.[1];
        return calls.filter((c) => c.Status__c === "In Progress" && c.Tech__c && c.Actual_Start__c && !c.Actual_End__c && c.Scheduled_End__c >= ge && c.Scheduled_End__c <= le);
      }
      const ge = soql.match(/Scheduled_Start__c >= ([\dT:.Z-]+)/)?.[1];
      const le = soql.match(/Scheduled_Start__c <= ([\dT:.Z-]+)/)?.[1];
      return calls.filter((c) => c.Status__c === "Scheduled" && (!soql.includes("Tech__c != null") || c.Tech__c) && (!ge || c.Scheduled_Start__c >= ge) && (!le || c.Scheduled_Start__c <= le));
    },
    getSupabaseClient: async () => supabase,
    sfUpdateRecord: async (obj, id, fields) => { updates.push({ obj, id, fields }); for (const c of calls) if (c.Sundial_Service_Job__c === id && c.Sundial_Service_Job__r) c.Sundial_Service_Job__r = { ...c.Sundial_Service_Job__r, ...fields }; return { ok: true, id }; },
    getSecret: async () => (over.noPush ? {} : { publicKey: "PUB", privateKey: "PRIV", subject: "mailto:x@y.z" }),
    broadcast: async () => ({ ok: true }),
    sendPush: async (sub, payload) => (pushes.push({ endpoint: sub.endpoint, payload }), { ok: true }),
    now: () => over.now ?? new Date("2026-09-21T15:00:00Z"), // 8:00 AM Phoenix
    env: { SERVICE_TIMEZONE: "America/Phoenix", ...(over.env || {}) },
  };
  const handler = createHandler(deps);
  const call = (method, path, body, headers = {}) =>
    handler({ requestContext: { http: { method } }, rawPath: path, headers: { authorization: "Bearer t", origin: "https://sundial.harmonelectric.net", "user-agent": "TestBrowser/1", ...headers }, body: body == null ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }));
  return { store, pushes, updates, handler, call };
}

const SUB = { endpoint: "https://push.example/abc", keys: { p256dh: "P", auth: "A" } };

test("routes + sweep detection + local-day helpers", () => {
  assert.equal(matchRoute("GET", "/prod/notify/config").name, "config");
  assert.equal(matchRoute("POST", "/notify/subscriptions").name, "subscribe");
  assert.equal(matchRoute("DELETE", "/notify/subscriptions").name, "unsubscribe");
  assert.equal(matchRoute("POST", "/notify/test").name, "test");
  assert.equal(matchRoute("GET", "/notify/nope"), null);
  assert.equal(isSweepEvent({ source: "aws.events", "detail-type": "Scheduled Event" }), true);
  assert.equal(isSweepEvent({ sweep: true }), true);
  assert.equal(isSweepEvent({ rawPath: "/notify/config" }), false);
  assert.deepEqual(localParts(new Date("2026-09-22T00:30:00Z"), "America/Phoenix"), { day: "2026-09-21", hour: 17 });
  assert.equal(nextDay("2026-09-30"), "2026-10-01");
  assert.equal(nextDay("2026-12-31"), "2027-01-01");
});

test("config exposes only the public key; not configured is honest", async () => {
  const { call } = setup();
  const r = await call("GET", "/notify/config");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { pushConfigured: true, publicKey: "PUB" });
  const q = setup({ noPush: true });
  assert.deepEqual((await q.call("GET", "/notify/config")).body, { pushConfigured: false, publicKey: null });
});

test("subscribe: stamps the caller from the JWT, replaces on the same endpoint; a bad body is 400; tech app tag", async () => {
  const { store, call } = setup();
  let r = await call("POST", "/notify/subscriptions", { ...SUB, profile_id: "uuid-attacker", app: "tech" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, app: "tech", devices: 1 });
  assert.equal(store.sundial_push_subscriptions.length, 1);
  const row = store.sundial_push_subscriptions[0];
  assert.equal(row.profile_id, ME, "the recipient is the verified caller, never the body");
  assert.equal(row.user_sf_id, "a0U-beth");
  assert.equal(row.client_sf_id, TENANT);
  assert.equal(row.user_agent, "TestBrowser/1");
  // The browser re-subscribes with new keys: same endpoint → the row is replaced, not doubled.
  r = await call("POST", "/notify/subscriptions", { subscription: { ...SUB, keys: { p256dh: "P2", auth: "A2" } } });
  assert.equal(r.body.devices, 1);
  assert.equal(store.sundial_push_subscriptions[0].p256dh, "P2");
  assert.equal(store.sundial_push_subscriptions[0].app, "office");
  assert.equal((await call("POST", "/notify/subscriptions", { endpoint: "https://x" })).status, 400);
  assert.equal((await call("POST", "/notify/subscriptions", { endpoint: "http://insecure", keys: { p256dh: "a", auth: "b" } })).status, 400);
  const q = setup({ noPush: true });
  assert.equal((await q.call("POST", "/notify/subscriptions", SUB)).status, 503);
});

test("unsubscribe removes only the caller's own row", async () => {
  const { store, call } = setup();
  store.sundial_push_subscriptions.push({ id: "x", profile_id: "uuid-paige", endpoint: SUB.endpoint, p256dh: "P", auth: "A" });
  let r = await call("DELETE", "/notify/subscriptions", { endpoint: SUB.endpoint });
  assert.deepEqual(r.body, { success: true, removed: 0 });
  assert.equal(store.sundial_push_subscriptions.length, 1, "Paige's device is untouched");
  await call("POST", "/notify/subscriptions", { ...SUB, endpoint: "https://push.example/mine" });
  r = await call("DELETE", "/notify/subscriptions", { endpoint: "https://push.example/mine" });
  assert.deepEqual(r.body, { success: true, removed: 1 });
  assert.equal((await call("DELETE", "/notify/subscriptions", {})).status, 400);
});

test("test rings the caller: a bell row and a push to each of their devices", async () => {
  const { store, pushes, call } = setup();
  await call("POST", "/notify/subscriptions", SUB);
  const r = await call("POST", "/notify/test");
  assert.equal(r.status, 200);
  assert.equal(r.body.inserted, 1);
  assert.equal(r.body.pushed, 1);
  assert.equal(store.sundial_notifications[0].profile_id, ME);
  assert.equal(store.sundial_notifications[0].kind, "test");
  assert.equal(pushes[0].payload.title, "Sundial notifications are on");
});

test("action gate: a Sales Rep may manage their own device; scope none may not", async () => {
  const rep = setup({ level: "Sales Rep", scope: "own" });
  assert.equal((await rep.call("GET", "/notify/config")).status, 200);
  const none = setup({ level: "Sales Rep", scope: "none" });
  assert.equal((await none.call("GET", "/notify/config")).status, 403);
});

const JOB = { Name: "SVC-00012", Customer_Name_at_Creation__c: "Ann Lee", Address_at_Creation__c: "1 Main St, Phoenix" };
const mkCall = (Id, start, Tech__c = "a0U-larry", Status__c = "Scheduled") => ({
  Id, Name: `SC-${Id}`, Client__c: TENANT, Tech__c, Status__c, Scheduled_Start__c: start, Sundial_Service_Job__c: "J1", Sundial_Service_Job__r: JOB, Tech__r: { First_Name__c: "Larry", Last_Name__c: "Ng" },
});

test("sweep: one-hour reminder to the tech, late call to the office, both deduped across runs", async () => {
  const calls = [
    mkCall("C1", "2026-09-21T15:45:00Z"), // 45 min out → one_hour
    mkCall("C2", "2026-09-21T17:00:00Z"), // 2 h out → nothing yet
    mkCall("C3", "2026-09-21T14:15:00Z"), // 45 min ago, still Scheduled → late
    mkCall("C4", "2026-09-21T14:45:00Z"), // 15 min ago → not late yet
    mkCall("C5", "2026-09-21T15:30:00Z", "a0U-larry", "In Progress"), // not Scheduled → ignored
  ];
  const { store, handler } = setup({ calls });
  let r = await handler({ source: "aws.events", "detail-type": "Scheduled Event" });
  assert.deepEqual(r, { ok: true, oneHour: 1, dayBefore: 0, late: 2, overrun: 0, techsReminded: 0, dayOf: 0 }); // late → Beth + Paige
  const rows = store.sundial_notifications;
  const oneHour = rows.find((x) => x.kind === "one_hour");
  assert.equal(oneHour.profile_id, "uuid-larry");
  assert.equal(oneHour.title, "Up next at 8:45 AM: SVC-00012 · Ann Lee");
  assert.equal(oneHour.body, "1 Main St, Phoenix");
  assert.equal(oneHour.url, "/tech/calls/C1");
  assert.equal(oneHour.dedupe_key, "reminder:one_hour:C1");
  const late = rows.filter((x) => x.kind === "late");
  assert.deepEqual(late.map((x) => x.profile_id).sort(), ["uuid-beth", "uuid-paige"]);
  assert.equal(late[0].title, "Larry Ng hasn't started SC-C3 (7:15 AM)");
  assert.equal(late[0].url, "/service/jobs/J1");
  // Five minutes later: the same calls are found again and nobody is rung twice.
  r = await handler({ sweep: true });
  assert.deepEqual(r, { ok: true, oneHour: 0, dayBefore: 0, late: 0, overrun: 0, techsReminded: 0, dayOf: 0 });
  assert.equal(store.sundial_notifications.length, 3);
});

test("sweep: the day-before digest fires only at the reminder hour, once per tech, for the LOCAL next day", async () => {
  const calls = [
    mkCall("T1", "2026-09-22T15:00:00Z"), // tomorrow 8:00 AM Phoenix
    mkCall("T2", "2026-09-22T20:00:00Z"), // tomorrow 1:00 PM
    mkCall("T3", "2026-09-23T15:00:00Z"), // the day after — not in the digest
    mkCall("T4", "2026-09-22T16:00:00Z", "a0U-paige"), // another tech's day
  ];
  // 5:10 PM Phoenix on Sep 21 = 00:10Z Sep 22.
  const at5pm = setup({ calls, now: new Date("2026-09-22T00:10:00Z") });
  let r = await at5pm.handler({ sweep: true });
  assert.equal(r.dayBefore, 2);
  assert.equal(r.techsReminded, 2);
  const larry = at5pm.store.sundial_notifications.find((x) => x.profile_id === "uuid-larry" && x.kind === "day_before");
  assert.equal(larry.title, "Tomorrow: 2 calls, first at 8:00 AM");
  assert.equal(larry.body, "8:00 AM SVC-00012 · Ann Lee · 1:00 PM SVC-00012 · Ann Lee");
  assert.equal(larry.dedupe_key, "reminder:day_before:a0U-larry:2026-09-22");
  assert.equal(larry.url, "/tech");
  // 5:40 PM, the next sweep: nothing new.
  r = await at5pm.handler({ sweep: true });
  assert.equal(r.dayBefore, 0);
  // 8:00 AM: not the reminder hour, no digest at all.
  const morning = setup({ calls });
  r = await morning.handler({ sweep: true });
  assert.equal(r.dayBefore, 0);
});

// --- overrun (2026-10-21, Harmon): "are you still at the job?" to the TECH ---------------
const open = (inAt) => JSON.stringify([{ in: inAt, ids: [] }]);
const closed = (inAt, outAt) => JSON.stringify([{ in: inAt, out: outAt, ids: [] }]);
const mkRunning = (Id, end, over = {}) => ({
  ...mkCall(Id, "2026-09-21T11:00:00Z", "a0U-larry", "In Progress"),
  Scheduled_End__c: end, Actual_Start__c: "2026-09-21T11:02:00Z", Actual_End__c: null, Clock_Intervals__c: open("2026-09-21T11:02:00Z"),
  ...over,
});

test("sweep: overrun — a call still on the clock 2h+ past its scheduled end rings its tech once; never the office", async () => {
  // now = 15:00Z (8:00 AM Phoenix)
  const calls = [
    mkRunning("O1", "2026-09-21T12:55:00Z"), // 2h05m past, still clocked in → push
    mkRunning("O2", "2026-09-21T12:55:00Z", { Actual_End__c: "2026-09-21T13:00:00Z", Clock_Intervals__c: closed("2026-09-21T11:02:00Z", "2026-09-21T13:00:00Z") }), // clocked out → none
    { ...mkCall("O3", "2026-09-21T11:00:00Z"), Scheduled_End__c: "2026-09-21T12:55:00Z", Actual_Start__c: null, Actual_End__c: null }, // never clocked in → the late kind's business
    mkRunning("O4", "2026-09-21T02:00:00Z"), // 13 h past → too old
    mkRunning("O5", "2026-09-21T12:55:00Z", { Clock_Intervals__c: closed("2026-09-21T11:02:00Z", "2026-09-21T12:30:00Z") }), // paused (left for the next job): end blank, clock closed → none
    mkRunning("O6", "2026-09-21T13:10:00Z"), // 1h50m past → not yet
  ];
  const { store, handler } = setup({ calls });
  let r = await handler({ sweep: true });
  assert.equal(r.overrun, 1);
  assert.equal(r.late, 2, "the never-clocked-in call is the office's late alert, not an overrun");
  const rows = store.sundial_notifications.filter((x) => x.kind === "overrun");
  assert.equal(rows.length, 1);
  const o = rows[0];
  assert.equal(o.profile_id, "uuid-larry", "the tech only");
  assert.equal(o.category, "reminder");
  assert.equal(o.title, "SVC-00012 was scheduled to end 2 hours ago");
  assert.equal(o.body, "Are you still at Ann Lee, 1 Main St, Phoenix? Tap to clock out or keep going.");
  assert.equal(o.url, "/tech/calls/O1");
  assert.equal(o.dedupe_key, "overrun:O1");
  assert.equal(calls[0].Status__c, "In Progress", "nothing here changes the call");
  // The next sweep finds the same call and rings nobody.
  r = await handler({ sweep: true });
  assert.equal(r.overrun, 0);
  assert.equal(store.sundial_notifications.filter((x) => x.kind === "overrun").length, 1);
});

test("overrun: the title says the whole hours past 3, and the clock decides who is still there", async () => {
  assert.equal(overrunTitle("SVC-01234", 125), "SVC-01234 was scheduled to end 2 hours ago");
  assert.equal(overrunTitle("SVC-01234", 179), "SVC-01234 was scheduled to end 2 hours ago");
  assert.equal(overrunTitle("SVC-01234", 185), "SVC-01234 was scheduled to end 3 hours ago");
  assert.equal(overrunTitle("SVC-01234", 5 * 60 + 59), "SVC-01234 was scheduled to end 5 hours ago");
  assert.equal(stillOnClock({ Actual_Start__c: "x", Clock_Intervals__c: open("2026-09-21T11:02:00Z") }), true);
  assert.equal(stillOnClock({ Actual_Start__c: "x", Clock_Intervals__c: closed("a", "b") }), false);
  assert.equal(stillOnClock({ Actual_Start__c: "x", Clock_Intervals__c: JSON.stringify([{ in: "a", ids: [], removed: { at: "b" } }]) }), false, "an interval the office removed is not the clock");
  assert.equal(stillOnClock({ Actual_Start__c: "x", Clock_Intervals__c: null }), true, "no log: the blank end decides");
  // A 3h40m overrun through the sweep says 3.
  const { store, handler } = setup({ calls: [mkRunning("O7", "2026-09-21T11:20:00Z")] });
  await handler({ sweep: true });
  assert.equal(store.sundial_notifications.find((x) => x.kind === "overrun").title, "SVC-00012 was scheduled to end 3 hours ago");
});

test("sweep: day-of (2026-10-22) — a Scheduled job whose call is today goes In Progress once, logged and staled, ringing nobody; tomorrow's / an already-moved job / before DAY_OF_HOUR stay", async () => {
  const job = (id, Status__c) => ({ Name: `SVC-${id}`, Status__c, Estimate__c: `EST-${id}`, Customer_Name_at_Creation__c: "Ann Lee" });
  const day = (Id, jobId, start, jobStatus) => ({ ...mkCall(Id, start), Sundial_Service_Job__c: jobId, Sundial_Service_Job__r: job(jobId, jobStatus) });
  const calls = [
    day("D1", "JA", "2026-09-21T23:00:00Z", "Scheduled"), // 4 pm Phoenix today → moves
    day("D2", "JA", "2026-09-21T20:00:00Z", "Scheduled"), // same job, second call → still one move
    day("D3", "JB", "2026-09-22T16:00:00Z", "Scheduled"), // tomorrow → stays
    day("D4", "JC", "2026-09-21T18:00:00Z", "In Progress"), // already moved (the tech clocked in) → stays
  ];
  const { store, updates, handler } = setup({ calls });
  const r = await handler({ sweep: true });
  assert.equal(r.dayOf, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].obj, "Sundial_Service_Job__c");
  assert.equal(updates[0].id, "JA");
  assert.equal(updates[0].fields.Status__c, "In Progress");
  assert.ok(updates[0].fields.Status_Changed_At__c);
  const act = store.sundial_service_activity.filter((a) => a.event === "job_updated");
  assert.equal(act.length, 1);
  assert.equal(act[0].details.via, "day_of");
  assert.deepEqual(act[0].details.fields.Status__c, { from: "Scheduled", to: "In Progress" });
  assert.equal(act[0].client_sf_id, TENANT);
  assert.equal(act[0].job_sf_id, "JA");
  assert.equal(store.sundial_notifications.filter((n) => n.kind === "day_of").length, 0);
  // Five minutes later: the job is In Progress now, nothing to do.
  assert.equal((await handler({ sweep: true })).dayOf, 0);
  assert.equal(updates.length, 1);

  // Before DAY_OF_HOUR (8 am local now, hour set to 9): nothing moves yet.
  const early = setup({ calls: [day("E1", "JE", "2026-09-21T23:00:00Z", "Scheduled")], env: { DAY_OF_HOUR: "9" } });
  assert.equal((await early.handler({ sweep: true })).dayOf, 0);
  assert.equal(early.updates.length, 0);
});
