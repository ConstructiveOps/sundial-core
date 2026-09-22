// node --test lib/notify.test.js
//
// Drives createNotifier with a fake multi-table Supabase, a recorded broadcast and a
// recorded push transport. Pins: Sundial user id → profile translation (tenant-bound),
// the office audience minus the actor, a missing preference row = ON and an explicit
// false = OFF, the dedupe key (a replay inserts nothing and rings nobody), push fan-out
// per device with dead (410) subscriptions removed, and that nothing here ever throws.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createNotifier, prefAllows, pushPayload, pushConfigFrom, userChannel, recordPath, fmtTime, jobLabel, CATEGORIES } from "./notify.js";
import { fakeSupabase } from "./notify.test-fakes.js";

const TENANT = "a1W7y000007AszBEAS";
const OTHER_TENANT = "a1W7y000007OTHER";

function setup() {
  const store = {
    profiles: [
      { id: "uuid-beth", tenant_id: TENANT, sundial_user_id: "a0U-beth", access_scope: "tenant" },
      { id: "uuid-paige", tenant_id: TENANT, sundial_user_id: "a0U-paige", access_scope: "tenant" },
      { id: "uuid-larry", tenant_id: TENANT, sundial_user_id: "a0U-larry", access_scope: "tech" },
      { id: "uuid-rep", tenant_id: TENANT, sundial_user_id: "a0U-rep", access_scope: "own" },
      { id: "uuid-elsewhere", tenant_id: OTHER_TENANT, sundial_user_id: "a0U-larry", access_scope: "tech" }, // same SF id, other tenant — must never match
    ],
    user_preferences: [{ user_id: "uuid-paige", notify_prefs: { money: false } }],
    sundial_notifications: [],
    sundial_push_subscriptions: [
      { id: "s1", profile_id: "uuid-larry", endpoint: "https://push.example/larry-phone", p256dh: "k", auth: "a" },
      { id: "s2", profile_id: "uuid-larry", endpoint: "https://push.example/larry-old", p256dh: "k", auth: "a" },
      { id: "s3", profile_id: "uuid-beth", endpoint: "https://push.example/beth-desktop", p256dh: "k", auth: "a" },
    ],
  };
  const broadcasts = [];
  const pushes = [];
  const supabase = fakeSupabase(store);
  const n = createNotifier({
    getSupabaseClient: async () => supabase,
    getSecret: async () => ({ publicKey: "PUB", privateKey: "PRIV", subject: "mailto:ops@example.com" }),
    broadcast: async (channel, event, payload) => (broadcasts.push({ channel, event, payload }), { ok: true }),
    sendPush: async (sub, payload) => {
      pushes.push({ endpoint: sub.endpoint, payload });
      return sub.endpoint.endsWith("larry-old") ? { ok: false, status: 410, gone: true } : { ok: true };
    },
    now: () => new Date("2026-09-21T15:00:00Z"),
    env: {},
  });
  return { store, broadcasts, pushes, n };
}

test("pure helpers", () => {
  assert.equal(prefAllows(undefined, "money"), true);
  assert.equal(prefAllows({}, "money"), true);
  assert.equal(prefAllows({ money: false }, "money"), false);
  assert.equal(prefAllows({ money: true }, "schedule"), true);
  assert.equal(userChannel("abc"), "user:abc:notify");
  assert.equal(recordPath("job", "J1"), "/service/jobs/J1");
  assert.equal(recordPath("servicecall", "C1", { jobId: "J1" }), "/service/jobs/J1");
  assert.equal(recordPath("nope", "X"), "/");
  assert.equal(pushConfigFrom(null).configured, false);
  assert.equal(pushConfigFrom({ publicKey: "a", privateKey: "b" }).configured, true);
  assert.equal(fmtTime("2026-09-21T15:00:00Z", "America/Phoenix"), "8:00 AM");
  assert.equal(jobLabel({ Name: "SVC-00012", Customer_Name_at_Creation__c: "Ann Lee" }), "SVC-00012 · Ann Lee");
  assert.equal(jobLabel(null), "a job");
  const p = pushPayload({ id: "n1", title: "T", body: null, url: "/x", dedupe_key: "k", category: "schedule", kind: "moved", created_at: "now" });
  assert.deepEqual(p, { id: "n1", title: "T", body: "", url: "/x", tag: "k", category: "schedule", kind: "moved", at: "now" });
});

test("toUsers: translates Sundial user ids to profiles in THIS tenant, rows + broadcast + push per device, dead device removed", async () => {
  const { store, broadcasts, pushes, n } = setup();
  const r = await n.toUsers({
    tenantId: TENANT,
    userSfIds: ["a0U-larry", "a0U-nobody"],
    category: CATEGORIES.SCHEDULE,
    kind: "scheduled",
    title: "New call: SVC-00012 · Ann Lee",
    body: "Tue, Sep 22, 8:00 AM",
    url: "/tech/calls/C1",
    recordType: "servicecall",
    recordSfId: "C1",
    dedupeKey: "schedule:C1:1",
  });
  assert.deepEqual(r, { inserted: 1, skipped: 0, pushed: 1 });
  const rows = store.sundial_notifications;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].profile_id, "uuid-larry"); // not uuid-elsewhere
  assert.equal(rows[0].user_sf_id, "a0U-larry");
  assert.equal(rows[0].client_sf_id, TENANT);
  assert.ok(rows[0].pushed_at, "pushed_at stamped");
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].channel, "user:uuid-larry:notify");
  assert.equal(broadcasts[0].event, "notification");
  assert.equal(broadcasts[0].payload.title, "New call: SVC-00012 · Ann Lee");
  assert.equal(pushes.length, 2, "both of Larry's devices tried");
  assert.equal(pushes[0].payload.url, "/tech/calls/C1");
  assert.deepEqual(store.sundial_push_subscriptions.map((s) => s.id).sort(), ["s1", "s3"], "the 410 subscription is gone");
});

test("toOffice: everyone with tenant scope, minus the actor; an explicit false preference skips that person", async () => {
  const { store, n } = setup();
  const r = await n.toOffice({
    tenantId: TENANT,
    exceptUserSfId: "a0U-beth",
    category: CATEGORIES.MONEY,
    kind: "estimate_approved",
    title: "Approved online: EST-00031",
    dedupeKey: "money:approved:E1",
  });
  // Beth is the actor (excluded), Paige has money:false, Larry and the rep are not office.
  assert.deepEqual(r, { inserted: 0, skipped: 1, pushed: 0, reason: "opted_out" });
  assert.equal(store.sundial_notifications.length, 0);

  const r2 = await n.toOffice({ tenantId: TENANT, category: CATEGORIES.CUSTOMER_MESSAGE, kind: "text", title: "Text from Ann Lee", body: "Running late", dedupeKey: "sms:SM1" });
  assert.deepEqual(r2, { inserted: 2, skipped: 0, pushed: 1 });
  assert.deepEqual(store.sundial_notifications.map((x) => x.profile_id).sort(), ["uuid-beth", "uuid-paige"]);
});

test("dedupe: the same key for the same person inserts nothing and rings nobody the second time", async () => {
  const { store, broadcasts, pushes, n } = setup();
  const send = () => n.toProfile({ tenantId: TENANT, profileId: "uuid-beth", category: CATEGORIES.TECH_ACTIVITY, kind: "late", title: "Larry hasn't started SC-00040", dedupeKey: "late:C40" });
  assert.equal((await send()).inserted, 1);
  assert.equal((await send()).inserted, 0);
  assert.equal(store.sundial_notifications.length, 1);
  assert.equal(broadcasts.length, 1);
  assert.equal(pushes.length, 1);
  // A different person with the same key is their own row.
  await n.toProfile({ tenantId: TENANT, profileId: "uuid-paige", category: CATEGORIES.TECH_ACTIVITY, kind: "late", title: "x", dedupeKey: "late:C40" });
  assert.equal(store.sundial_notifications.length, 2);
});

test("no key = always inserted; push:false skips the phones; incomplete input is a no-op, never a throw", async () => {
  const { store, pushes, n } = setup();
  await n.toProfile({ tenantId: TENANT, profileId: "uuid-beth", category: "mention", kind: "comment", title: "Paige mentioned you", push: false });
  await n.toProfile({ tenantId: TENANT, profileId: "uuid-beth", category: "mention", kind: "comment", title: "Paige mentioned you", push: false });
  assert.equal(store.sundial_notifications.length, 2);
  assert.equal(pushes.length, 0);
  assert.deepEqual(await n.toProfile({ tenantId: TENANT, profileId: "uuid-beth", category: "mention", kind: "comment", title: "" }), { inserted: 0, skipped: 0, pushed: 0, reason: "incomplete" });
  assert.deepEqual(await n.toUsers({ tenantId: TENANT, userSfIds: [], category: "schedule", kind: "x", title: "y" }), { inserted: 0, skipped: 0, pushed: 0, reason: "no_recipients" });
});

test("push not configured: rows + broadcast still land, no push attempted", async () => {
  const { store, pushes, n } = setup();
  const quiet = createNotifier({
    getSupabaseClient: async () => fakeSupabase(store),
    getSecret: async () => {
      throw new Error("ResourceNotFoundException");
    },
    broadcast: async () => ({ ok: true }),
    sendPush: async (...a) => (pushes.push(a), { ok: true }),
    now: () => new Date(),
    env: {},
  });
  const r = await quiet.toProfile({ tenantId: TENANT, profileId: "uuid-larry", category: "schedule", kind: "moved", title: "Moved" });
  assert.deepEqual(r, { inserted: 1, skipped: 0, pushed: 0 });
  assert.equal(pushes.length, 0);
  assert.equal((await quiet.pushConfig()).configured, false);
  assert.equal(n.absoluteUrl("/service/jobs/J1"), "https://sundial.harmonelectric.net/service/jobs/J1");
  assert.equal(n.absoluteUrl("https://x.example/y"), "https://x.example/y");
});
