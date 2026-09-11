// sundial-service-board tests — the real router + handlers over an in-memory
// Salesforce (with the two relationship joins the board reads) and a PostgREST-shaped
// Supabase stub. No module mocking; every dependency goes in through createHandler.
//
// What is pinned: the board read (window, tray order, tech pick), scheduling from the
// tray with the job status follow-up + customer email, the optimistic-concurrency 409,
// the "already started" refusal, status progression settling the job, cancel with a
// reason (and the job dropping back to Ready to Schedule), tenant isolation (404), and
// the access gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHandler,
  matchRoute,
  pickTechs,
  sortTray,
  formatWindow,
  soqlDateTime,
  UNSCHEDULED_JOB_STATUSES,
} from "./index.js";

const TENANT = "a1W7y000007AszBEAS";
const OTHER = "a1W7y000007OTHERAS";
const NOW = new Date("2026-09-14T15:00:00Z"); // Monday 8:00 Phoenix

function fakeWorld() {
  const store = {
    Sundial_User__c: [
      { Id: "USR000000000000001", Client__c: TENANT, Active__c: true, First_Name__c: "Jake", Last_Name__c: "Dorsey", Access_Level__c: "Technician", Default_Department__c: "Service" },
      { Id: "USR000000000000002", Client__c: TENANT, Active__c: true, First_Name__c: "Larry", Last_Name__c: "Ng", Access_Level__c: "Manager", Default_Department__c: "Service" },
      { Id: "USR000000000000003", Client__c: TENANT, Active__c: true, First_Name__c: "Beth", Last_Name__c: "Office", Access_Level__c: "Admin", Default_Department__c: "Office" },
      { Id: "USR000000000000009", Client__c: OTHER, Active__c: true, First_Name__c: "Not", Last_Name__c: "Ours", Access_Level__c: "Technician" },
    ],
    Sundial_Service_Job__c: [
      { Id: "SVC000000000000001", Client__c: TENANT, Name: "SVC-00001", Status__c: "Ready to Schedule", Priority__c: "Standard", Service_Type__c: "Paid Service", Customer_Name_at_Creation__c: "Ann Lee", Address_at_Creation__c: "1 Main St, Phoenix", Primary_Email_at_Creation__c: "ann@example.com", Sundial_Customer__c: "CUS000000000000001", Estimate__c: "EST000000000000001", CreatedDate: "2026-09-10T12:00:00Z", SystemModstamp: "2026-09-10T12:00:00Z" },
      { Id: "SVC000000000000002", Client__c: TENANT, Name: "SVC-00002", Status__c: "New", Priority__c: "Emergency", Service_Type__c: "Warranty", Customer_Name_at_Creation__c: "Bo Chen", Sundial_Customer__c: "CUS000000000000002", CreatedDate: "2026-09-13T12:00:00Z", SystemModstamp: "2026-09-13T12:00:00Z" },
      { Id: "SVC000000000000003", Client__c: TENANT, Name: "SVC-00003", Status__c: "Scheduled", Priority__c: "High", Customer_Name_at_Creation__c: "Cy Diaz", Sundial_Customer__c: "CUS000000000000003", CreatedDate: "2026-09-01T12:00:00Z", SystemModstamp: "2026-09-01T12:00:00Z" },
      { Id: "SVC000000000000004", Client__c: TENANT, Name: "SVC-00004", Status__c: "Closed", Customer_Name_at_Creation__c: "Done Deal", CreatedDate: "2026-08-01T12:00:00Z", SystemModstamp: "2026-08-01T12:00:00Z" },
      { Id: "SVC000000000000099", Client__c: OTHER, Name: "SVC-99999", Status__c: "Ready to Schedule", CreatedDate: "2026-09-01T12:00:00Z", SystemModstamp: "2026-09-01T12:00:00Z" },
    ],
    Sundial_Service_Call__c: [
      { Id: "SC0000000000000001", Client__c: TENANT, Name: "SC-00001", Visit_Type__c: "Service", Sundial_Service_Job__c: "SVC000000000000003", Tech__c: "USR000000000000001", Scheduled_Start__c: "2026-09-14T16:00:00.000Z", Scheduled_End__c: "2026-09-14T18:00:00.000Z", Status__c: "Scheduled", SystemModstamp: "2026-09-12T10:00:00Z", CreatedDate: "2026-09-12T10:00:00Z" },
      { Id: "SC0000000000000002", Client__c: TENANT, Name: "SC-00002", Visit_Type__c: "Service", Sundial_Service_Job__c: "SVC000000000000003", Tech__c: "USR000000000000002", Scheduled_Start__c: "2026-09-20T16:00:00.000Z", Scheduled_End__c: "2026-09-20T18:00:00.000Z", Status__c: "Scheduled", SystemModstamp: "2026-09-12T10:00:00Z", CreatedDate: "2026-09-12T10:00:00Z" },
    ],
    Sundial_Customer__c: [{ Id: "CUS000000000000002", Client__c: TENANT, Primary_Email__c: "bo@example.com" }],
  };
  let seq = 10;
  let clock = 0;
  const calls = { creates: [], updates: [], queries: [] };
  const activity = [];
  const stale = [];
  const emails = [];
  const broadcasts = [];

  function cond(rec, c) {
    c = c.trim();
    let m;
    if ((m = c.match(/^([\w.]+) = '(.*)'$/))) return String(rec[m[1]] ?? "") === m[2];
    if ((m = c.match(/^(\w+) = (true|false)$/))) return (rec[m[1]] === true) === (m[2] === "true");
    if ((m = c.match(/^(\w+) IN \((.*)\)$/))) return m[2].split(",").map((x) => x.trim().replace(/^'|'$/g, "")).includes(String(rec[m[1]] ?? ""));
    if ((m = c.match(/^(\w+) (>=|<) (\S+)$/))) {
      const v = Date.parse(rec[m[1]] ?? "");
      const lit = Date.parse(m[3]);
      return m[2] === ">=" ? v >= lit : v < lit;
    }
    throw new Error(`fake SOQL cannot evaluate: ${c}`);
  }
  const join = (obj, r) => {
    const out = { ...r };
    if (obj === "Sundial_Service_Call__c") {
      const t = store.Sundial_User__c.find((u) => u.Id === r.Tech__c);
      out.Tech__r = t ? { First_Name__c: t.First_Name__c, Last_Name__c: t.Last_Name__c } : null;
      const j = store.Sundial_Service_Job__c.find((x) => x.Id === r.Sundial_Service_Job__c);
      out.Sundial_Service_Job__r = j ? { ...j } : null;
    }
    return out;
  };
  const sfQuery = async (soql) => {
    calls.queries.push(soql);
    const obj = soql.match(/FROM (\w+)/)[1];
    let where = (soql.split(" WHERE ")[1] || "").replace(/\s+(ORDER BY|LIMIT).*$/, "").trim();
    let rows = store[obj].filter((r) => (where ? where.split(" AND ").every((c) => cond(r, c)) : true));
    const order = soql.match(/ORDER BY (\w+)/);
    if (order) rows = [...rows].sort((a, b) => String(a[order[1]] ?? "").localeCompare(String(b[order[1]] ?? "")));
    const lim = soql.match(/LIMIT (\d+)/);
    if (lim) rows = rows.slice(0, Number(lim[1]));
    return rows.map((r) => join(obj, r));
  };
  const stamp = () => new Date(NOW.getTime() + ++clock * 1000).toISOString();
  const sfCreateRecord = async (obj, fields) => {
    calls.creates.push({ obj, fields: { ...fields } });
    const rec = { Id: `${obj.slice(8, 10).toUpperCase()}${String(++seq).padStart(16, "0")}`.slice(0, 18), Name: `${obj === "Sundial_Service_Call__c" ? "SC" : "X"}-${seq}`, SystemModstamp: stamp(), CreatedDate: stamp(), ...fields };
    store[obj].push(rec);
    return { ok: true, id: rec.Id };
  };
  const sfUpdateRecord = async (obj, id, fields) => {
    calls.updates.push({ obj, id, fields: { ...fields } });
    const rec = store[obj].find((r) => r.Id === id);
    if (!rec) throw Object.assign(new Error("not found"), { sfStatus: 404 });
    Object.assign(rec, fields, { SystemModstamp: stamp() });
    return { ok: true, id };
  };
  const getSupabaseClient = async () => ({
    from: (table) => ({
      insert: async (row) => { if (table === "sundial_service_activity") activity.push(row); return { error: null }; },
      update: (patch) => ({ in: (col, ids) => ({ eq: async () => { stale.push({ table, ids, patch }); return { error: null }; } }) }),
    }),
  });
  return {
    store, calls, activity, stale, emails, broadcasts,
    deps: {
      sfQuery, sfCreateRecord, sfUpdateRecord, getSupabaseClient,
      sendEmail: async (m) => { emails.push(m); return { ok: true, messageId: "m" }; },
      isEmailConfigured: () => true,
      broadcast: async (channel, event, payload) => { broadcasts.push({ channel, event, payload }); return { ok: true }; },
      now: () => NOW,
    },
  };
}

function makeHandler(world, overrides = {}) {
  const identity = {
    tenantId: TENANT,
    tenantSlug: "harmon",
    user: { id: "USR000000000000003", firstName: "Beth", lastName: "Office" },
    access: { scope: "tenant", level: "Admin", tenantId: TENANT, userId: "USR000000000000003" },
    ...overrides,
  };
  return createHandler({ ...world.deps, resolveIdentity: async () => identity });
}
const call = async (h, method, path, body, query) => {
  const r = await h({ requestContext: { http: { method } }, rawPath: path, headers: { authorization: "Bearer t", origin: "https://x" }, body: body ? JSON.stringify(body) : undefined, queryStringParameters: query });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

// ---------------------------------------------------------------------------

test("pure helpers: routes, tech pick, tray order, SOQL datetimes, the customer's window", () => {
  assert.equal(matchRoute("GET", "/prod/service/board").name, "board");
  assert.deepEqual(matchRoute("POST", "/service/jobs/SVC1/calls"), { name: "createCall", params: ["SVC1"] });
  assert.deepEqual(matchRoute("POST", "/service/calls/SC1/cancel"), { name: "cancelCall", params: ["SC1"] });
  assert.equal(matchRoute("DELETE", "/service/calls/SC1"), null);

  const users = fakeWorld().store.Sundial_User__c.filter((u) => u.Client__c === TENANT);
  const picked = pickTechs(users);
  assert.equal(picked.source, "technicians");
  assert.deepEqual(picked.techs.map((t) => t.name), ["Jake Dorsey", "Larry Ng"]); // Technician + Service dept; Beth (Office) excluded
  const none = pickTechs(users.map((u) => ({ ...u, Access_Level__c: "Admin", Default_Department__c: "Office" })));
  assert.equal(none.source, "all-users");
  assert.equal(none.techs.length, 3);

  const tray = sortTray([{ priority: "Low", ageDays: 30 }, { priority: "Emergency", ageDays: 0 }, { priority: "Standard", ageDays: 9 }, { priority: "Standard", ageDays: 2 }]);
  assert.deepEqual(tray.map((t) => `${t.priority}/${t.ageDays}`), ["Emergency/0", "Standard/9", "Standard/2", "Low/30"]);

  assert.equal(soqlDateTime("2026-09-14T07:00:00.000Z"), "2026-09-14T07:00:00Z");
  assert.equal(formatWindow("2026-09-14T16:00:00Z", "2026-09-14T18:00:00Z", "America/Phoenix"), "Monday, September 14, 9:00 AM – 11:00 AM");
});

test("GET /service/board: calls in the window only, the tray in priority/age order, tenant-scoped", async () => {
  const w = fakeWorld();
  const h = makeHandler(w);
  const r = await call(h, "GET", "/service/board", null, { from: "2026-09-14T07:00:00.000Z", to: "2026-09-15T07:00:00.000Z" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.techs.map((t) => t.name), ["Jake Dorsey", "Larry Ng"]);
  assert.equal(r.body.calls.length, 1); // SC-00002 is next week
  const c = r.body.calls[0];
  assert.equal(c.jobNumber, "SVC-00003");
  assert.equal(c.customerName, "Cy Diaz");
  assert.equal(c.techName, "Jake Dorsey");
  assert.equal(c.modstamp, "2026-09-12T10:00:00Z");
  // Tray: Emergency SVC-00002 first, then Ready-to-Schedule SVC-00001; Scheduled + Closed excluded; other tenant excluded.
  assert.deepEqual(r.body.unscheduled.map((j) => j.jobNumber), ["SVC-00002", "SVC-00001"]);
  assert.equal(r.body.unscheduled[1].ageDays, 4);
  assert.equal(r.body.defaults.callMinutes, 120);
  assert.ok(w.calls.queries.some((q) => q.includes(`Status__c IN (${UNSCHEDULED_JOB_STATUSES.map((s) => `'${s}'`).join(", ")})`)));
  assert.ok(w.calls.queries.some((q) => q.includes("Scheduled_Start__c >= 2026-09-14T07:00:00Z")));

  const bad = await call(h, "GET", "/service/board", null, { from: "2026-09-14T07:00:00Z", to: "2026-11-14T07:00:00Z" });
  assert.equal(bad.body.code, "WINDOW_TOO_WIDE");
  const bad2 = await call(h, "GET", "/service/board", null, { from: "nope" });
  assert.equal(bad2.body.code, "WINDOW_INVALID");
});

test("POST /service/jobs/{id}/calls: schedules, moves the job to Scheduled, logs, stales, broadcasts, emails the customer", async () => {
  const w = fakeWorld();
  const h = makeHandler(w);
  const r = await call(h, "POST", "/service/jobs/SVC000000000000001/calls", { techId: "USR000000000000001", start: "2026-09-15T16:00:00Z", notifyCustomer: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.call.status, "Scheduled");
  assert.equal(r.body.call.end, "2026-09-15T18:00:00.000Z"); // default 120 min
  assert.equal(r.body.call.techName, "Jake Dorsey");
  assert.equal(r.body.jobStatus, "Scheduled");
  assert.equal(r.body.jobStatusChanged, "Scheduled");
  assert.equal(r.body.notified, true);
  assert.equal(r.body.recipient, "ann@example.com");
  const created = w.calls.creates[0];
  assert.equal(created.fields.Client__c, TENANT);
  assert.equal(created.fields.Visit_Type__c, "Service");
  assert.equal(created.fields.Visit_Sub_Type__c, "On-Site");
  assert.deepEqual(w.activity.map((a) => a.event), ["service_call_created", "job_updated"]);
  assert.equal(w.activity[0].actor_name, "Beth Office");
  assert.equal(w.activity[1].details.fields.Status__c.to, "Scheduled");
  assert.ok(w.stale.some((s) => s.table === "sundial_service_job_cache") && w.stale.some((s) => s.table === "sundial_service_call_cache"));
  assert.equal(w.broadcasts.length, 1);
  assert.equal(w.broadcasts[0].channel, `tenant:${TENANT}:sundial_service:list`);
  assert.equal(w.broadcasts[0].payload.action, "created");
  assert.equal(w.emails.length, 1);
  assert.ok(w.emails[0].subject.includes("Tuesday, September 15, 9:00 AM – 11:00 AM"));
  assert.ok(w.emails[0].text.includes("Jake is scheduled"));

  // Customer email falls back to the customer record when the job snapshot has none.
  const r2 = await call(h, "POST", "/service/jobs/SVC000000000000002/calls", { techId: "USR000000000000002", start: "2026-09-15T20:00:00Z", end: "2026-09-15T21:00:00Z", notifyCustomer: true });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.recipient, "bo@example.com");

  // Validation + guards.
  assert.equal((await call(h, "POST", "/service/jobs/SVC000000000000001/calls", { start: "2026-09-15T16:00:00Z" })).body.code, "TECH_REQUIRED");
  assert.equal((await call(h, "POST", "/service/jobs/SVC000000000000001/calls", { techId: "USR000000000000009", start: "2026-09-15T16:00:00Z" })).body.code, "TECH_INVALID"); // other tenant's tech
  assert.equal((await call(h, "POST", "/service/jobs/SVC000000000000001/calls", { techId: "USR000000000000001", start: "2026-09-15T16:00:00Z", end: "2026-09-15T15:00:00Z" })).body.code, "WINDOW_INVALID");
  assert.equal((await call(h, "POST", "/service/jobs/SVC000000000000004/calls", { techId: "USR000000000000001", start: "2026-09-15T16:00:00Z" })).body.code, "JOB_CLOSED");
  assert.equal((await call(h, "POST", "/service/jobs/SVC000000000000099/calls", { techId: "USR000000000000001", start: "2026-09-15T16:00:00Z" })).status, 404); // other tenant's job
});

test("PATCH /service/calls/{id}: move with baseModstamp; 409 on a stale stamp; refuses once started; status progression settles the job", async () => {
  const w = fakeWorld();
  const h = makeHandler(w);
  const id = "SC0000000000000001";

  // Stale stamp → 409 with the current state, nothing written.
  const stale = await call(h, "PATCH", `/service/calls/${id}`, { start: "2026-09-14T17:00:00Z", end: "2026-09-14T19:00:00Z", baseModstamp: "2026-01-01T00:00:00Z" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "CALL_CONFLICT");
  assert.equal(stale.body.call.start, "2026-09-14T16:00:00.000Z");
  assert.equal(w.calls.updates.length, 0);

  // Correct stamp → moved + reassigned, activity carries old → new, customer told.
  const ok = await call(h, "PATCH", `/service/calls/${id}`, { start: "2026-09-14T17:00:00Z", end: "2026-09-14T19:00:00Z", techId: "USR000000000000002", baseModstamp: "2026-09-12T10:00:00Z", notifyCustomer: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.changed.sort(), ["Scheduled_End__c", "Scheduled_Start__c", "Tech__c"]);
  assert.equal(ok.body.call.techName, "Larry Ng");
  assert.notEqual(ok.body.call.modstamp, "2026-09-12T10:00:00Z");
  const row = w.activity.find((a) => a.event === "service_call_updated");
  assert.equal(row.details.fields.Tech__c.toName, "Larry Ng");
  assert.equal(row.details.fields.Scheduled_Start__c.from, "2026-09-14T16:00:00.000Z");
  assert.equal(ok.body.notified, false); // job SVC-00003 has no email on file
  assert.ok(ok.body.detail.includes("no email"));

  // No-op patch is a 200 that says so.
  const noop = await call(h, "PATCH", `/service/calls/${id}`, { techId: "USR000000000000002" });
  assert.equal(noop.body.unchanged, true);

  // Status: In Progress stamps Actual_Start and moves the job Scheduled → In Progress.
  const prog = await call(h, "PATCH", `/service/calls/${id}`, { status: "In Progress" });
  assert.equal(prog.status, 200);
  assert.equal(prog.body.jobStatusChanged, "In Progress");
  assert.equal(w.store.Sundial_Service_Call__c[0].Actual_Start__c, NOW.toISOString());
  assert.equal(w.store.Sundial_Service_Job__c[2].Status__c, "In Progress");

  // Started → cannot be moved.
  const moved = await call(h, "PATCH", `/service/calls/${id}`, { start: "2026-09-14T18:00:00Z" });
  assert.equal(moved.body.code, "CALL_ALREADY_STARTED");

  // Complete: another call on the job is still open, so the job stays In Progress…
  const done = await call(h, "PATCH", `/service/calls/${id}`, { status: "Complete", workNotes: "Replaced the disconnect." });
  assert.equal(done.status, 200);
  assert.equal(done.body.jobStatusChanged, null);
  assert.equal(w.store.Sundial_Service_Call__c[0].Actual_End__c, NOW.toISOString());
  // …and once the last open call completes, the job goes to Awaiting Office Review.
  const done2 = await call(h, "PATCH", "/service/calls/SC0000000000000002", { status: "Complete" });
  assert.equal(done2.body.jobStatusChanged, "Awaiting Office Review");

  assert.equal((await call(h, "PATCH", `/service/calls/${id}`, { status: "Cancelled" })).body.code, "USE_CANCEL");
  assert.equal((await call(h, "PATCH", `/service/calls/${id}`, { status: "Bogus" })).body.code, "STATUS_INVALID");
  assert.equal((await call(h, "PATCH", "/service/calls/SC0000000000009999", { status: "Complete" })).status, 404);
});

test("POST /service/calls/{id}/cancel: needs a reason; last open call cancelled drops the job back to Ready to Schedule; idempotent", async () => {
  const w = fakeWorld();
  // Make SVC-00003 have exactly one open call so the cancel flips it back.
  w.store.Sundial_Service_Call__c[1].Status__c = "Complete";
  const h = makeHandler(w);
  assert.equal((await call(h, "POST", "/service/calls/SC0000000000000001/cancel", {})).body.code, "REASON_REQUIRED");
  const r = await call(h, "POST", "/service/calls/SC0000000000000001/cancel", { reason: "Customer asked to push a week", notifyCustomer: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.call.status, "Cancelled");
  assert.equal(r.body.call.cancelReason, "Customer asked to push a week");
  assert.equal(r.body.jobStatusChanged, "Ready to Schedule");
  assert.equal(w.activity.find((a) => a.event === "service_call_cancelled").details.reason, "Customer asked to push a week");
  assert.equal(w.broadcasts.at(-1).payload.action, "cancelled");
  const again = await call(h, "POST", "/service/calls/SC0000000000000001/cancel", { reason: "x" });
  assert.equal(again.body.alreadyCancelled, true);
});

test("GET /service/jobs/{id}/calls returns the job's calls + techs; access gate denies a Technician / sales scope", async () => {
  const w = fakeWorld();
  const h = makeHandler(w);
  const r = await call(h, "GET", "/service/jobs/SVC000000000000003/calls");
  assert.equal(r.status, 200);
  assert.equal(r.body.calls.length, 2);
  assert.equal(r.body.techs.length, 2);
  assert.equal((await call(h, "GET", "/service/jobs/SVC000000000000099/calls")).status, 404);

  const tech = makeHandler(w, { access: { scope: "none", level: "Technician", tenantId: TENANT, userId: "USR000000000000001" } });
  assert.equal((await call(tech, "GET", "/service/board", null, { from: "2026-09-14T07:00:00Z", to: "2026-09-15T07:00:00Z" })).status, 403);
  const rep = makeHandler(w, { access: { scope: "own", level: "Sales Rep", tenantId: TENANT, userId: "USR000000000000003" } });
  assert.equal((await call(rep, "POST", "/service/jobs/SVC000000000000001/calls", { techId: "USR000000000000001", start: "2026-09-15T16:00:00Z" })).status, 403);
});
