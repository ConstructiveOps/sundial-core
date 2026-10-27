// node --test lambdas/sundial-notify/stage.test.js
//
// POST /webhooks/stage-change (dealer module step 6) through the real handler, with the
// real notifier on the shared fake Supabase. Pins: the secret gate (missing / wrong /
// unconfigured all 401, never a notification), recipients = the rep (own / dealer scope
// only — staff never) + the dealer's people, inside the row's tenant; a solar falls back
// to its parent customer's rep and dealer; the dedupe key makes a replay silent; the
// solar_created kind; the dealer link, the dealer app tag, and that an off-journey stage
// still notifies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./index.js";
import { isStageWebhook, stageDedupeKey, stageKind } from "./stage.js";
import { fakeSupabase } from "../../lib/notify.test-fakes.js";

const TENANT = "a1W7y000007AszBEAS";
const OTHER = "a1W7y000007OTHER";
const SECRET = "s3cret-stage";
const CUST = "a1P7y00000CUST01";
const SOLAR = "a1Q7y00000SOLR01";
const DEALER = "a1D7y00000DEAL01";

function setup(over = {}) {
  const store = {
    profiles: [
      { id: "uuid-rep", tenant_id: TENANT, sundial_user_id: "a0U-rep", access_scope: "own", dealer_sf_id: DEALER },
      { id: "uuid-dealer-boss", tenant_id: TENANT, sundial_user_id: "a0U-boss", access_scope: "dealer", dealer_sf_id: DEALER },
      { id: "uuid-other-dealer", tenant_id: TENANT, sundial_user_id: "a0U-od", access_scope: "dealer", dealer_sf_id: "a1D-other" },
      { id: "uuid-staff-rep", tenant_id: TENANT, sundial_user_id: "a0U-staffrep", access_scope: "tenant", dealer_sf_id: null },
      { id: "uuid-elsewhere", tenant_id: OTHER, sundial_user_id: "a0U-rep", access_scope: "own", dealer_sf_id: DEALER },
      { id: "uuid-elsewhere-dealer", tenant_id: OTHER, sundial_user_id: "a0U-x", access_scope: "dealer", dealer_sf_id: DEALER },
    ],
    user_preferences: [],
    sundial_notifications: [],
    sundial_push_subscriptions: [{ id: "p1", profile_id: "uuid-rep", endpoint: "https://push.example/rep", p256dh: "k", auth: "a" }],
    sundial_customer_cache: [
      { sf_id: CUST, client_sf_id: TENANT, stage: "Verbal Yes", first_name: "Ann", last_name: "Lee", is_company: false, sales_rep_sf_id: "a0U-rep", dealer_sf_id: DEALER },
    ],
    sundial_solar_cache: [{ sf_id: SOLAR, client_sf_id: TENANT, stage: "Permitting", sundial_customer_sf_id: CUST, sales_rep_sf_id: null, dealer_sf_id: null, customer_name_at_creation: "LEE, ANN" }],
    ...(over.store || {}),
  };
  const pushes = [];
  const deps = {
    resolveIdentity: async () => {
      throw new Error("the webhook must never ask for a JWT");
    },
    sfQuery: async () => [],
    getSupabaseClient: async () => fakeSupabase(store),
    getSecret: async (name) => {
      if (name === "sundial/stage-notify") {
        if (over.noSecret) throw new Error("ResourceNotFoundException");
        return { secret: SECRET };
      }
      return { publicKey: "PUB", privateKey: "PRIV", subject: "mailto:x@y.z" };
    },
    broadcast: async () => ({ ok: true }),
    sendPush: async (sub, payload) => (pushes.push({ endpoint: sub.endpoint, payload }), { ok: true }),
    now: () => new Date("2026-10-26T18:00:00Z"),
    env: {},
  };
  const handler = createHandler(deps);
  const post = (body, secret = SECRET, path = "/prod/webhooks/stage-change") =>
    handler({
      requestContext: { http: { method: "POST" } },
      rawPath: path,
      headers: secret == null ? { "Content-Type": "application/json" } : { "Content-Type": "application/json", "X-Sundial-Stage-Secret": secret },
      body: JSON.stringify(body),
    }).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));
  const rows = () => store.sundial_notifications;
  return { store, pushes, post, rows };
}

const customerMove = (over = {}) => ({ object: "customer", sf_id: CUST, client_sf_id: TENANT, old_stage: "Proposal Complete", new_stage: "Verbal Yes", modstamp: "2026-10-26T17:59:00Z", op: "update", ...over });

test("helpers: route, kind, dedupe key", () => {
  assert.equal(isStageWebhook("POST", "/webhooks/stage-change"), true);
  assert.equal(isStageWebhook("POST", "/prod/webhooks/stage-change"), true);
  assert.equal(isStageWebhook("GET", "/webhooks/stage-change"), false);
  assert.equal(isStageWebhook("POST", "/notify/test"), false);
  assert.equal(stageKind("customer", "update", "New"), "customer");
  assert.equal(stageKind("solar", "update", "Audit"), "solar");
  assert.equal(stageKind("solar", "insert", null), "solar_created");
  assert.equal(stageKind("solar", "update", null), "solar", "a stage set on an existing solar is not a new project");
  assert.equal(stageKind("solar", null, null), "solar_created", "no op from an older trigger: old_stage null means created");
  assert.equal(stageDedupeKey({ object: "solar", sfId: "S1", newStage: "Permitting", modstamp: "M" }), "stage:solar:S1:Permitting:M");
});

test("secret gate: missing, wrong and unconfigured are all 401 and ring nobody", async () => {
  const a = setup();
  assert.equal((await a.post(customerMove(), null)).status, 401);
  assert.equal((await a.post(customerMove(), "wrong")).status, 401);
  assert.equal(a.rows().length, 0);
  const b = setup({ noSecret: true });
  assert.equal((await b.post(customerMove(), SECRET)).status, 401, "no secret configured fails closed");
  assert.equal(b.rows().length, 0);
});

test("a bad body is 400; an unknown object is 400", async () => {
  const { post } = setup();
  assert.equal((await post({ object: "customer" })).status, 400);
  assert.equal((await post(customerMove({ object: "roofing" }))).status, 400);
});

test("customer stage change → the rep and the dealer's people, in this tenant only, never staff", async () => {
  const { post, rows, pushes } = setup();
  const r = await post(customerMove());
  assert.equal(r.status, 200);
  assert.equal(r.body.kind, "customer");
  const to = rows().map((n) => n.profile_id).sort();
  assert.deepEqual(to, ["uuid-dealer-boss", "uuid-rep"]);
  const n = rows()[0];
  assert.equal(n.category, "stage");
  assert.equal(n.kind, "customer");
  assert.equal(n.title, "Ann Lee → Verbal Yes");
  assert.equal(n.body, "Previously: Proposal Complete");
  assert.equal(n.url, `/dealer/customers/${CUST}`);
  assert.equal(n.record_type, "dealercustomer");
  assert.equal(n.record_sf_id, CUST);
  assert.equal(n.client_sf_id, TENANT);
  assert.equal(n.dedupe_key, `stage:customer:${CUST}:Verbal Yes:2026-10-26T17:59:00Z`);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].payload.app, "dealer");
});

test("a staff rep on the deal is not told (scope tenant)", async () => {
  const { post, rows, store } = setup();
  store.sundial_customer_cache[0].sales_rep_sf_id = "a0U-staffrep";
  store.sundial_customer_cache[0].dealer_sf_id = null;
  const r = await post(customerMove());
  assert.equal(r.body.reason, "no_recipients");
  assert.equal(rows().length, 0);
});

test("replay: the same post twice inserts nothing and rings nobody the second time", async () => {
  const { post, rows, pushes } = setup();
  await post(customerMove());
  const second = await post(customerMove());
  assert.equal(second.status, 200);
  assert.equal(second.body.inserted, 0);
  assert.equal(rows().length, 2);
  assert.equal(pushes.length, 1);
  // The same stage reached again later (a new modstamp) is news.
  await post(customerMove({ modstamp: "2026-10-27T09:00:00Z" }));
  assert.equal(rows().length, 4);
});

test("solar: no rep / dealer of its own → the parent customer's; linked to the customer; named from the customer", async () => {
  const { post, rows } = setup();
  const r = await post({ object: "solar", sf_id: SOLAR, client_sf_id: TENANT, old_stage: "PM Review", new_stage: "Permitting", modstamp: "M1", op: "update" });
  assert.equal(r.body.kind, "solar");
  assert.deepEqual(rows().map((n) => n.profile_id).sort(), ["uuid-dealer-boss", "uuid-rep"]);
  assert.equal(rows()[0].title, "Ann Lee → Permitting");
  assert.equal(rows()[0].url, `/dealer/customers/${CUST}`);
  assert.equal(rows()[0].dedupe_key, `stage:solar:${SOLAR}:Permitting:M1`);
});

test("solar: its own rep and dealer win over the parent's", async () => {
  const { post, rows, store } = setup();
  Object.assign(store.sundial_solar_cache[0], { sales_rep_sf_id: "a0U-od", dealer_sf_id: "a1D-other" });
  store.profiles.find((p) => p.id === "uuid-other-dealer").access_scope = "dealer";
  await post({ object: "solar", sf_id: SOLAR, client_sf_id: TENANT, old_stage: "PM Review", new_stage: "Permitting", modstamp: "M1", op: "update" });
  assert.deepEqual(rows().map((n) => n.profile_id), ["uuid-other-dealer"], "rep and dealer resolve to the same person, told once");
});

test("solar_created: insert with no previous stage", async () => {
  const { post, rows } = setup();
  const r = await post({ object: "solar", sf_id: SOLAR, client_sf_id: TENANT, old_stage: null, new_stage: "Audit", modstamp: "M0", op: "insert" });
  assert.equal(r.body.kind, "solar_created");
  assert.equal(rows()[0].kind, "solar_created");
  assert.equal(rows()[0].title, "Ann Lee → Audit");
  assert.equal(rows()[0].body, "New solar project");
});

test("a stage on neither the journey nor the off-path list still notifies", async () => {
  const { post, rows } = setup();
  const r = await post(customerMove({ new_stage: "Some Brand New Picklist Value" }));
  assert.equal(r.body.sent, true);
  assert.equal(rows()[0].title, "Ann Lee → Some Brand New Picklist Value");
});

test("tenant mismatch and a missing row are 200 skips, never a notification", async () => {
  const { post, rows } = setup();
  assert.equal((await post(customerMove({ client_sf_id: OTHER }))).body.reason, "tenant_mismatch");
  assert.equal((await post(customerMove({ sf_id: "a1P-gone" }))).body.reason, "record_not_found");
  assert.equal(rows().length, 0);
});

test("a dealer turned stage alerts off is skipped; the rep is still told", async () => {
  const { post, rows, store } = setup();
  store.user_preferences.push({ user_id: "uuid-dealer-boss", notify_prefs: { stage: false } });
  await post(customerMove());
  assert.deepEqual(rows().map((n) => n.profile_id), ["uuid-rep"]);
});
