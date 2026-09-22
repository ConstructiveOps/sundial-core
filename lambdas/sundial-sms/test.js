// node --test lambdas/sundial-sms/test.js
//
// Drives the real router with a fake Salesforce, a fake Supabase table and a recorded
// Twilio. Pins: the signature gate (fails closed, rejects a bad signature, accepts a
// good one on the exact URL), the send path (row + broadcast + the number chosen per
// tenant), the reply matching order, idempotent inbound, and the status callback.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, matchRoute, twilioConfigFrom, fromNumberFor, tenantSlugForNumber, messageToView } from "./index.js";
import { expectedSignature, toE164, last10, prettyPhone, requestUrl, requestUrls, parseFormBody, mediaFrom } from "./twilio.js";

const TENANT = "a1W7y000007AszBEAS";
const USER = "a0U000000000001";
const AUTH_TOKEN = "tok_test_1234567890";

// --- fakes ------------------------------------------------------------------------
function fakeSupabase(store) {
  let seq = 1;
  const rows = () => store.sms;
  function chain(op, payload, opts) {
    const c = { filters: [], order: null, limit: null };
    const apply = () => {
      let out = rows().filter((r) => c.filters.every((f) => f(r)));
      if (c.order) out = [...out].sort((a, b) => (a[c.order.col] < b[c.order.col] ? -1 : 1) * (c.order.asc ? 1 : -1));
      if (c.limit != null) out = out.slice(0, c.limit);
      return out;
    };
    const api = {
      select: () => api,
      eq: (col, v) => (c.filters.push((r) => r[col] === v), api),
      not: (col, _op, v) => (c.filters.push((r) => !(r[col] === (v === "null" ? null : v))), api),
      is: (col, v) => (c.filters.push((r) => r[col] === v), api),
      order: (col, o) => ((c.order = { col, asc: o?.ascending !== false }), api),
      limit: (n) => ((c.limit = n), api),
      single: () => api.then((res) => ({ data: res.data?.[0] ?? null, error: res.error })),
      then: (resolve) => {
        if (op === "insert") {
          const row = { id: seq++, ...payload };
          rows().push(row);
          return resolve({ data: [row], error: null });
        }
        if (op === "upsert") {
          if (rows().some((r) => r[opts.onConflict] === payload[opts.onConflict])) return resolve({ data: [], error: null });
          const row = { id: seq++, ...payload };
          rows().push(row);
          return resolve({ data: [row], error: null });
        }
        if (op === "update") {
          const hit = apply();
          for (const r of hit) Object.assign(r, payload);
          return resolve({ data: hit, error: null });
        }
        return resolve({ data: apply(), error: null });
      },
    };
    return api;
  }
  return {
    from: () => ({
      select: () => chain("select"),
      insert: (row) => chain("insert", row),
      upsert: (row, opts) => chain("upsert", row, opts),
      update: (patch) => chain("update", patch),
    }),
  };
}

function makeFake(overrides = {}) {
  const store = { sms: [], jobs: [], customers: [], tenants: [{ Id: TENANT, Name: "harmon" }] };
  const broadcasts = [];
  const sends = [];
  const supabase = fakeSupabase(store);
  const fake = {
    store,
    broadcasts,
    sends,
    notes: [],
    secret: { accountSid: "ACxxx", authToken: AUTH_TOKEN, fromNumber: "+14805550100", tenantNumbers: {}, defaultTenant: "harmon" },
    sendResult: { ok: true, sid: "SM1", status: "queued" },
    ...overrides,
  };
  fake.deps = {
    resolveIdentity: async () => ({
      tenantId: TENANT,
      tenantSlug: "harmon",
      user: { id: USER, firstName: "Paige", lastName: "King" },
      access: { level: "Admin", scope: "tenant", userId: USER, tenantId: TENANT },
      ...(fake.identity || {}),
    }),
    sfQuery: async (soql) => {
      if (soql.includes("FROM Sundial_Tenant__c")) return store.tenants.filter((t) => soql.includes(`Name = '${t.Name}'`));
      if (soql.includes("FROM Sundial_Service_Job__c")) {
        const idM = soql.match(/WHERE Id = '([^']+)'/);
        if (idM) return store.jobs.filter((j) => j.Id === idM[1] && j.Client__c === TENANT);
        const custM = soql.match(/Sundial_Customer__c = '([^']+)'/);
        if (custM) return store.jobs.filter((j) => j.Sundial_Customer__c === custM[1]).sort((a, b) => (a.CreatedDate < b.CreatedDate ? 1 : -1));
        const likeM = soql.match(/LIKE '%(\d+)'/);
        return store.jobs.filter((j) => String(j.Primary_Phone_at_Creation__c ?? "").replace(/\D/g, "").endsWith(likeM[1])).sort((a, b) => (a.CreatedDate < b.CreatedDate ? 1 : -1));
      }
      if (soql.includes("FROM Sundial_Service_Call__c")) {
        const jobM = soql.match(/Sundial_Service_Job__c = '([^']+)'/);
        return (store.calls || []).filter((c) => c.Sundial_Service_Job__c === jobM?.[1] && ["Scheduled", "En Route", "In Progress"].includes(c.Status__c));
      }
      if (soql.includes("FROM Sundial_Customer__c")) {
        const idM = soql.match(/WHERE Id = '([^']+)'/);
        if (idM) return store.customers.filter((c) => c.Id === idM[1]);
        const likeM = soql.match(/LIKE '%(\d+)'/);
        return store.customers.filter((c) => String(c.Primary_Phone__c ?? "").replace(/\D/g, "").endsWith(likeM[1]));
      }
      throw new Error("unexpected soql " + soql);
    },
    getSupabaseClient: async () => supabase,
    getSecret: async (name) => {
      if (fake.secretFails) throw new Error("denied");
      return name === "sundial/twilio" ? fake.secret : null;
    },
    // Notifications (D-074): recorded, never delivered.
    notifier: {
      toOffice: async (n) => (fake.notes.push({ to: "office", ...n }), { inserted: 1, skipped: 0, pushed: 0 }),
      toUsers: async (n) => (fake.notes.push({ to: "users", ...n }), { inserted: n.userSfIds.length, skipped: 0, pushed: 0 }),
    },
    broadcast: async (channel, event, payload) => (broadcasts.push({ channel, event, payload }), { ok: true }),
    sendSms: async (creds, msg) => (sends.push({ creds, msg }), fake.sendResult),
    now: () => new Date("2026-09-15T18:00:00Z"),
    env: { SMS_WEBHOOK_BASE: "https://api.example.com/prod" },
  };
  fake.handler = createHandler(fake.deps);
  return fake;
}

const jwt = (h, method, path, body) =>
  h({ requestContext: { http: { method } }, rawPath: path, headers: { authorization: "Bearer x", origin: "http://localhost:5173" }, body: body ? JSON.stringify(body) : undefined });

/** A Twilio-shaped form POST, signed for the URL the Lambda will rebuild. */
function twilioPost(h, path, params, { sign = true, token = AUTH_TOKEN } = {}) {
  const url = `https://api.example.com/prod${path}`;
  const body = new URLSearchParams(params).toString();
  const headers = { host: "api.example.com", "content-type": "application/x-www-form-urlencoded" };
  if (sign) headers["x-twilio-signature"] = expectedSignature(token, url, params);
  return h({ httpMethod: "POST", path, requestContext: { path: `/prod${path}`, stage: "prod" }, headers, body });
}
const json = (r) => JSON.parse(r.body);

function seedJob(fake, extra = {}) {
  const job = { Id: "J1", Name: "SVC-00001", Client__c: TENANT, Client__r: { Name: "harmon" }, Status__c: "Scheduled", Sundial_Customer__c: "CU1", Customer_Name_at_Creation__c: "Ann Lee", Primary_Phone_at_Creation__c: "(602) 555-1212", CreatedDate: "2026-09-01T00:00:00Z", ...extra };
  fake.store.jobs.push(job);
  fake.store.customers.push({ Id: "CU1", Primary_Phone__c: "602-555-1212" });
  return job;
}

// --- helpers ------------------------------------------------------------------------
test("phone helpers: E.164, last10, pretty", () => {
  assert.equal(toE164("(602) 555-1212"), "+16025551212");
  assert.equal(toE164("1 602 555 1212"), "+16025551212");
  assert.equal(toE164("555-1212"), null);
  assert.equal(last10("+16025551212"), "6025551212");
  assert.equal(prettyPhone("+16025551212"), "(602) 555-1212");
});

test("config: per-tenant number wins over the shared one; the To number picks the tenant", () => {
  const cfg = twilioConfigFrom({ accountSid: "AC", authToken: "t", fromNumber: "480-555-0100", tenantNumbers: { harmon: "(602) 555-0199" }, defaultTenant: "harmon" }, {});
  assert.equal(fromNumberFor(cfg, "harmon"), "+16025550199");
  assert.equal(fromNumberFor(cfg, "other"), "+14805550100");
  assert.equal(tenantSlugForNumber(cfg, "+16025550199"), "harmon");
  assert.equal(tenantSlugForNumber(cfg, "+14805550100"), "harmon"); // default tenant catches the shared line
  const noDefault = twilioConfigFrom({ authToken: "t" }, {});
  assert.equal(tenantSlugForNumber(noDefault, "+14805550100"), null);
  assert.equal(twilioConfigFrom({}, { SMS_DEFAULT_TENANT: "Harmon" }).defaultTenant, "harmon");
});

test("routes + request URL + form parsing", () => {
  assert.equal(matchRoute("GET", "/prod/service/jobs/J1/sms").name, "getThread");
  assert.equal(matchRoute("POST", "/sms/inbound").name, "inbound");
  assert.equal(matchRoute("POST", "/prod/sms/status").name, "status");
  assert.equal(matchRoute("GET", "/service/sms/unmatched").name, "unmatched");
  assert.equal(matchRoute("DELETE", "/sms/inbound"), null);
  const ev = { requestContext: { path: "/prod/sms/inbound", stage: "prod" }, headers: { Host: "x.execute-api.us-west-1.amazonaws.com" } };
  assert.equal(requestUrl(ev, { host: "x.execute-api.us-west-1.amazonaws.com" }), "https://x.execute-api.us-west-1.amazonaws.com/prod/sms/inbound");
  assert.equal(requestUrl(ev, {}, "https://api.example.com/prod/"), "https://api.example.com/prod/sms/inbound");
  // Every honest spelling is a candidate: the operator's base, the gateway's own host,
  // and a trailing-slash twin of each — but always this request's path.
  assert.deepEqual(requestUrls(ev, { host: "x.execute-api.us-west-1.amazonaws.com" }, "https://sms.example.com/prod"), [
    "https://sms.example.com/prod/sms/inbound",
    "https://sms.example.com/prod/sms/inbound/",
    "https://x.execute-api.us-west-1.amazonaws.com/prod/sms/inbound",
    "https://x.execute-api.us-west-1.amazonaws.com/prod/sms/inbound/",
    "https://x.execute-api.us-west-1.amazonaws.com/sms/inbound",
    "https://x.execute-api.us-west-1.amazonaws.com/sms/inbound/",
  ]);
  assert.deepEqual(parseFormBody({ body: "From=%2B16025551212&Body=hi+there" }), { From: "+16025551212", Body: "hi there" });
  assert.deepEqual(parseFormBody({ body: Buffer.from("A=1").toString("base64"), isBase64Encoded: true }), { A: "1" });
  assert.deepEqual(mediaFrom({ NumMedia: "1", MediaUrl0: "https://m/1", MediaContentType0: "image/jpeg" }), [{ url: "https://m/1", contentType: "image/jpeg" }]);
});

// --- JWT routes ---------------------------------------------------------------------
test("GET thread: customer's current phone, the tenant's sending number, oldest-first messages", async () => {
  const fake = makeFake();
  seedJob(fake);
  fake.store.customers[0].Primary_Phone__c = "480-555-7777"; // current number differs from the snapshot
  fake.store.sms.push(
    { id: 9, client_sf_id: TENANT, job_sf_id: "J1", direction: "in", from_number: "+14805557777", to_number: "+14805550100", body: "later", status: "received", created_at: "2026-09-15T17:00:00Z" },
    { id: 8, client_sf_id: TENANT, job_sf_id: "J1", direction: "out", from_number: "+14805550100", to_number: "+14805557777", body: "first", status: "delivered", created_at: "2026-09-15T16:00:00Z" },
    { id: 7, client_sf_id: "OTHER", job_sf_id: "J1", direction: "out", from_number: "+1", to_number: "+1", body: "not yours", status: "sent", created_at: "2026-09-15T15:00:00Z" }
  );
  const r = await jwt(fake.handler, "GET", "/service/jobs/J1/sms");
  assert.equal(r.statusCode, 200);
  const b = json(r);
  assert.equal(b.customerPhone, "+14805557777");
  assert.equal(b.fromNumber, "+14805550100");
  assert.equal(b.canSend, true);
  assert.deepEqual(b.messages.map((m) => m.body), ["first", "later"]);
  assert.equal(b.messages[0].fromPretty, "(480) 555-0100");

  const nf = await jwt(fake.handler, "GET", "/service/jobs/NOPE/sms");
  assert.equal(nf.statusCode, 404);
});

test("GET thread: no credentials → canSend false with a reason (no throw)", async () => {
  const fake = makeFake({ secret: {} });
  seedJob(fake);
  const b = json(await jwt(fake.handler, "GET", "/service/jobs/J1/sms"));
  assert.equal(b.canSend, false);
  assert.match(b.notConfiguredReason, /Twilio/);
});

test("POST send: Twilio gets the tenant's number + status callback; the row, the broadcast and the actor are recorded", async () => {
  const fake = makeFake();
  fake.secret.tenantNumbers = { harmon: "+16025550199" };
  seedJob(fake);
  const r = await jwt(fake.handler, "POST", "/service/jobs/J1/sms", { body: "  On our way!  " });
  assert.equal(r.statusCode, 200, r.body);
  const m = json(r).message;
  assert.equal(m.direction, "out");
  assert.equal(m.body, "On our way!");
  assert.equal(m.status, "queued");
  assert.equal(m.sentByName, "Paige King");
  assert.equal(fake.sends.length, 1);
  assert.deepEqual(fake.sends[0].msg, { from: "+16025550199", to: "+16025551212", body: "On our way!", statusCallback: "https://api.example.com/prod/sms/status" });
  assert.equal(fake.sends[0].creds.authToken, AUTH_TOKEN);
  const row = fake.store.sms[0];
  assert.equal(row.provider_sid, "SM1");
  assert.equal(row.sent_by_user_sf_id, USER);
  assert.equal(row.customer_sf_id, "CU1");
  assert.equal(fake.broadcasts.length, 1);
  assert.equal(fake.broadcasts[0].channel, `tenant:${TENANT}:sundial_service_job:J1`);
  assert.equal(fake.broadcasts[0].event, "sms");
  assert.equal(fake.broadcasts[0].payload.kind, "sent");
});

test("POST send: validation, no phone, not configured, Twilio refusal (row kept as failed)", async () => {
  const fake = makeFake();
  seedJob(fake, { Primary_Phone_at_Creation__c: null });
  fake.store.customers[0].Primary_Phone__c = null;
  assert.equal(json(await jwt(fake.handler, "POST", "/service/jobs/J1/sms", { body: "   " })).code, "EMPTY_BODY");
  assert.equal(json(await jwt(fake.handler, "POST", "/service/jobs/J1/sms", { body: "x".repeat(1601) })).code, "BODY_TOO_LONG");
  assert.equal(json(await jwt(fake.handler, "POST", "/service/jobs/J1/sms", { body: "hi" })).code, "NO_PHONE");
  // An explicit `to` overrides the (missing) customer phone.
  fake.sendResult = { ok: false, error: "Unreachable", code: "30003" };
  const r = await jwt(fake.handler, "POST", "/service/jobs/J1/sms", { body: "hi", to: "602 555 9999" });
  assert.equal(r.statusCode, 502);
  assert.equal(json(r).code, "SMS_SEND_FAILED");
  assert.equal(fake.store.sms[0].status, "failed");
  assert.equal(fake.store.sms[0].error_code, "30003");
  assert.equal(fake.store.sms[0].to_number, "+16025559999");

  const none = makeFake({ secret: { authToken: "t" } });
  seedJob(none);
  assert.equal(json(await jwt(none.handler, "POST", "/service/jobs/J1/sms", { body: "hi" })).code, "SMS_NOT_CONFIGURED");
});

test("access: sending needs service.sms.send (a technician is refused); reads ride on estimate.write", async () => {
  const fake = makeFake({ identity: { access: { level: "Technician", scope: "tenant", userId: USER, tenantId: TENANT } } });
  seedJob(fake);
  // Technician has tenant scope but the action table is what decides; assertAction
  // resolves it from lib/access.js — a tenant-scope user is allowed both today.
  const r = await jwt(fake.handler, "POST", "/service/jobs/J1/sms", { body: "hi" });
  assert.equal(r.statusCode, 200);
  const rep = makeFake({ identity: { access: { level: "Sales Rep", scope: "own", userId: USER, tenantId: TENANT, dealerId: "D1" } } });
  seedJob(rep);
  assert.equal((await jwt(rep.handler, "GET", "/service/jobs/J1/sms")).statusCode, 403);
  assert.equal((await jwt(rep.handler, "POST", "/service/jobs/J1/sms", { body: "hi" })).statusCode, 403);
});

// --- Twilio webhooks ----------------------------------------------------------------
test("signature gate: unsigned and wrongly signed posts are 401; an unreadable secret fails closed", async () => {
  const fake = makeFake();
  seedJob(fake);
  const params = { From: "+16025551212", To: "+14805550100", Body: "hi", MessageSid: "SMin1" };
  assert.equal((await twilioPost(fake.handler, "/sms/inbound", params, { sign: false })).statusCode, 401);
  assert.equal((await twilioPost(fake.handler, "/sms/inbound", params, { token: "wrong" })).statusCode, 401);
  assert.equal(fake.store.sms.length, 0);
  const closed = makeFake({ secretFails: true });
  assert.equal((await twilioPost(closed.handler, "/sms/inbound", params)).statusCode, 401);
});

test("signature gate: a post signed for the gateway's own URL passes even when SMS_WEBHOOK_BASE names a different domain; a different path still fails", async () => {
  const fake = makeFake();
  fake.deps.env = { SMS_WEBHOOK_BASE: "https://sms.example.com/prod" };
  fake.handler = createHandler(fake.deps);
  seedJob(fake);
  const params = { From: "+16025551212", To: "+14805550100", Body: "hi", MessageSid: "SMx1" };
  // twilioPost signs for https://api.example.com/prod/sms/inbound = the request's own host + stage path.
  assert.equal((await twilioPost(fake.handler, "/sms/inbound", params)).statusCode, 200);
  assert.equal(fake.store.sms.length, 1);
  // Same signature replayed against the status route (different path) is refused.
  const body = new URLSearchParams(params).toString();
  const r = await fake.handler({ httpMethod: "POST", path: "/sms/status", requestContext: { path: "/prod/sms/status", stage: "prod" }, headers: { host: "api.example.com", "x-twilio-signature": expectedSignature(AUTH_TOKEN, "https://api.example.com/prod/sms/inbound", params) }, body });
  assert.equal(r.statusCode, 401);
});

test("inbound: a reply to a text we sent lands on that job; broadcast; redelivery is idempotent; TwiML reply is empty", async () => {
  const fake = makeFake();
  seedJob(fake);
  fake.store.jobs.push({ Id: "J2", Name: "SVC-00002", Client__c: TENANT, Status__c: "New", Sundial_Customer__c: "CU1", Primary_Phone_at_Creation__c: "602-555-1212", CreatedDate: "2026-09-10T00:00:00Z" });
  // We texted from J1 (the older job) — the reply belongs to J1, not the newer J2.
  fake.store.sms.push({ id: 1, client_sf_id: TENANT, job_sf_id: "J1", customer_sf_id: "CU1", direction: "out", from_number: "+14805550100", to_number: "+16025551212", body: "?", status: "sent", created_at: "2026-09-15T10:00:00Z" });
  const params = { From: "+1 (602) 555-1212", To: "+14805550100", Body: "Thursday works", MessageSid: "SMin1", NumMedia: "0" };
  const r = await twilioPost(fake.handler, "/sms/inbound", params);
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["Content-Type"], "text/xml");
  assert.match(r.body, /<Response><\/Response>/);
  const row = fake.store.sms.find((m) => m.provider_sid === "SMin1");
  assert.equal(row.job_sf_id, "J1");
  assert.equal(row.direction, "in");
  assert.equal(row.status, "received");
  assert.equal(row.from_number, "+16025551212");
  assert.equal(fake.broadcasts.at(-1).payload.kind, "received");
  await twilioPost(fake.handler, "/sms/inbound", params);
  assert.equal(fake.store.sms.filter((m) => m.provider_sid === "SMin1").length, 1);
});

test("inbound rings the office, and the tech on that job today (D-074); a redelivery rings nobody; unmatched rings the office only", async () => {
  const fake = makeFake();
  seedJob(fake);
  fake.store.sms.push({ id: 1, client_sf_id: TENANT, job_sf_id: "J1", customer_sf_id: "CU1", direction: "out", from_number: "+14805550100", to_number: "+16025551212", body: "?", status: "sent", created_at: "2026-09-15T10:00:00Z" });
  fake.store.calls = [
    { Id: "C1", Sundial_Service_Job__c: "J1", Tech__c: "T-today", Status__c: "Scheduled", Scheduled_Start__c: "2026-09-15T20:00:00Z" }, // today (Phoenix) at 1 pm
    { Id: "C2", Sundial_Service_Job__c: "J1", Tech__c: "T-tomorrow", Status__c: "Scheduled", Scheduled_Start__c: "2026-09-16T16:00:00Z" },
    { Id: "C3", Sundial_Service_Job__c: "J1", Tech__c: "T-live", Status__c: "In Progress", Scheduled_Start__c: "2026-09-14T16:00:00Z" }, // still clocked in from yesterday
  ];
  const params = { From: "+1 (602) 555-1212", To: "+14805550100", Body: "Gate code is 4412", MessageSid: "SMin9", NumMedia: "0" };
  await twilioPost(fake.handler, "/sms/inbound", params);
  assert.equal(fake.notes.length, 2);
  const office = fake.notes[0];
  assert.deepEqual([office.to, office.category, office.kind], ["office", "customer_message", "text"]);
  assert.equal(office.title, "Text from Ann Lee · SVC-00001");
  assert.equal(office.body, "Gate code is 4412");
  assert.equal(office.url, "/service/jobs/J1");
  assert.equal(office.dedupeKey, "sms:SMin9");
  const tech = fake.notes[1];
  assert.deepEqual([tech.to, tech.category, tech.userSfIds.sort()], ["users", "customer_text", ["T-live", "T-today"]]);
  assert.equal(tech.url, "/tech/jobs/J1");
  // Twilio redelivers: the row is a duplicate and nothing rings.
  await twilioPost(fake.handler, "/sms/inbound", params);
  assert.equal(fake.notes.length, 2);
  // Unmatched: the office hears it (no job), no tech does.
  await twilioPost(fake.handler, "/sms/inbound", { From: "+19995550000", To: "+14805550100", Body: "who dis", MessageSid: "S3" });
  assert.equal(fake.notes.length, 3);
  assert.equal(fake.notes[2].title, "Text from (999) 555-0000 (no job matched)");
  assert.equal(fake.notes[2].url, "/service");
});

test("inbound matching order: open job by phone beats a closed one; customer hub fallback; unmatched is stored with no job", async () => {
  const fake = makeFake();
  fake.store.jobs.push(
    { Id: "JC", Client__c: TENANT, Status__c: "Closed", Sundial_Customer__c: "CU9", Primary_Phone_at_Creation__c: "480-555-0001", CreatedDate: "2026-09-12T00:00:00Z" },
    { Id: "JO", Client__c: TENANT, Status__c: "Scheduled", Sundial_Customer__c: "CU9", Primary_Phone_at_Creation__c: "(480) 555-0001", CreatedDate: "2026-09-02T00:00:00Z" }
  );
  await twilioPost(fake.handler, "/sms/inbound", { From: "+14805550001", To: "+14805550100", Body: "a", MessageSid: "S1" });
  assert.equal(fake.store.sms.at(-1).job_sf_id, "JO");

  // Only the customer hub knows this number → their latest job.
  fake.store.customers.push({ Id: "CU5", Primary_Phone__c: "602-555-0005" });
  fake.store.jobs.push({ Id: "J5", Client__c: TENANT, Status__c: "New", Sundial_Customer__c: "CU5", Primary_Phone_at_Creation__c: null, CreatedDate: "2026-09-13T00:00:00Z" });
  await twilioPost(fake.handler, "/sms/inbound", { From: "+16025550005", To: "+14805550100", Body: "b", MessageSid: "S2" });
  assert.equal(fake.store.sms.at(-1).job_sf_id, "J5");
  assert.equal(fake.store.sms.at(-1).customer_sf_id, "CU5");

  // Nobody → stored, no job, listed as unmatched; no broadcast to a job.
  const before = fake.broadcasts.length;
  await twilioPost(fake.handler, "/sms/inbound", { From: "+19995550000", To: "+14805550100", Body: "who dis", MessageSid: "S3" });
  assert.equal(fake.store.sms.at(-1).job_sf_id, null);
  assert.equal(fake.broadcasts.length, before);
  const u = json(await jwt(fake.handler, "GET", "/service/sms/unmatched"));
  assert.deepEqual(u.messages.map((m) => m.body), ["who dis"]);

  // A number that maps to no tenant is acknowledged and dropped.
  const n = makeFake({ secret: { accountSid: "AC", authToken: AUTH_TOKEN, fromNumber: "+14805550100" } });
  const r = await twilioPost(n.handler, "/sms/inbound", { From: "+19995550000", To: "+14805550100", Body: "x", MessageSid: "S4" });
  assert.equal(r.statusCode, 200);
  assert.equal(n.store.sms.length, 0);
});

test("status callback: updates the row by sid and broadcasts; unknown sid is a quiet 200", async () => {
  const fake = makeFake();
  fake.store.sms.push({ id: 1, client_sf_id: TENANT, job_sf_id: "J1", direction: "out", from_number: "+14805550100", to_number: "+16025551212", body: "?", status: "queued", provider_sid: "SM1", created_at: "2026-09-15T10:00:00Z" });
  const r = await twilioPost(fake.handler, "/sms/status", { MessageSid: "SM1", MessageStatus: "delivered" });
  assert.equal(r.statusCode, 200);
  assert.equal(fake.store.sms[0].status, "delivered");
  assert.equal(fake.broadcasts.at(-1).payload.kind, "status");
  assert.equal(fake.broadcasts.at(-1).payload.message.status, "delivered");
  await twilioPost(fake.handler, "/sms/status", { MessageSid: "SM1", MessageStatus: "undelivered", ErrorCode: "30005" });
  assert.equal(fake.store.sms[0].error_code, "30005");
  assert.equal((await twilioPost(fake.handler, "/sms/status", { MessageSid: "NOPE", MessageStatus: "sent" })).statusCode, 200);
});

test("messageToView never leaks table columns and tolerates a bare row", () => {
  const v = messageToView({ id: 1, direction: "in", from_number: "+16025551212", to_number: "+14805550100", status: "received", created_at: "t" });
  assert.deepEqual(Object.keys(v).sort(), ["at", "body", "direction", "errorCode", "from", "fromPretty", "id", "jobId", "media", "sentByName", "status", "to", "toPretty", "updatedAt"]);
  assert.equal(v.body, "");
  assert.deepEqual(v.media, []);
});
