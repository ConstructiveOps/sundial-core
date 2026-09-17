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
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createHandler,
  matchRoute,
  pickTechs,
  sortTray,
  formatWindow,
  soqlDateTime,
  UNSCHEDULED_JOB_STATUSES,
} from "./index.js";
import {
  TECH_CUSTOMER_SELECT,
  TECH_ESTIMATE_SELECT,
  TECH_JOB_SELECT,
  annotateLog,
  applyClockEvent,
  applyCorrection,
  clockFields,
  clockState,
  hasClockEvent,
  lastClockTime,
  liveIntervals,
  openIntervalIndex,
  sumMinutes,
  checklistFor,
  appendStamped,
  dayBounds,
  localDate,
  geofenceCheck,
  haversineMeters,
  onMyWayText,
  parseIntervals,
  photoPrefix,
  DEFAULT_CHECKLIST,
} from "./tech.js";

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
    Sundial_Customer__c: [
      { Id: "CUS000000000000002", Client__c: TENANT, Primary_Email__c: "bo@example.com" },
      { Id: "CUS000000000000003", Client__c: TENANT, Name: "Cy Diaz", First_Name__c: "Cy", Last_Name__c: "Diaz", Street__c: "3 Elm St", City__c: "Phoenix", State__c: "AZ", Postal_Code__c: "85001", Primary_Phone__c: "(602) 555-0100", CreatedDate: "2026-06-01T12:00:00Z" },
      { Id: "CUS000000000000099", Client__c: OTHER, Name: "Cy Other", Primary_Phone__c: "(602) 555-0100" },
    ],
    Sundial_Estimate__c: [
      { Id: "EST000000000000003", Client__c: TENANT, Name: "EST-00003", Status__c: "Approved", Total__c: 450, Subtotal__c: 450, Is_Template__c: false, Customer_Name_at_Creation__c: "Cy Diaz", Sundial_Customer__c: "CUS000000000000003", Service_Job__c: "SVC000000000000003", CreatedDate: "2026-09-01T12:00:00Z" },
      { Id: "EST000000000000008", Client__c: TENANT, Name: "EST-TPL", Status__c: "Draft", Is_Template__c: true, Customer_Name_at_Creation__c: "Template", CreatedDate: "2026-08-01T12:00:00Z" },
    ],
    Sundial_Service_Line__c: [
      { Id: "LIN000000000000001", Client__c: TENANT, Estimate__c: "EST000000000000003", Description__c: "Diagnostic", Kind__c: "Labor", Quantity__c: 1, Unit_Price__c: 150, Line_Total__c: 150, Stage__c: "Approved", Sort_Order__c: 10 },
      { Id: "LIN000000000000002", Client__c: TENANT, Estimate__c: "EST000000000000003", Description__c: "Breaker 20A", Kind__c: "Material", Quantity__c: 2, Unit_Price__c: 150, Line_Total__c: 300, Stage__c: "Proposed", Sort_Order__c: 20, Added_By_Service_Call__c: "SC0000000000000001" },
    ],
    Sundial_Price_Book_Item__c: [
      { Id: "PBI000000000000001", Client__c: TENANT, Name: "Breaker 20A single pole", Item_Code__c: "BRK-20", Kind__c: "Material", Is_Active__c: true, Price__c: 45, Unit_of_Measure__c: "Each", Default_Quantity__c: 1 },
      { Id: "PBI000000000000002", Client__c: TENANT, Name: "Diagnostic hour", Item_Code__c: "LAB-DIAG", Kind__c: "Labor", Is_Active__c: true, Price__c: 150, Unit_of_Measure__c: "Hour" },
      { Id: "PBI000000000000003", Client__c: TENANT, Name: "Breaker 20A (old)", Item_Code__c: "BRK-20", Kind__c: "Material", Is_Active__c: false, Price__c: 40 },
      { Id: "PBI000000000000009", Client__c: OTHER, Name: "Breaker 20A theirs", Item_Code__c: "BRK-20", Kind__c: "Material", Is_Active__c: true, Price__c: 1 },
    ],
  };
  store.Sundial_Service_Job__c[2].Estimate__c = "EST000000000000003"; // SVC-00003 has an estimate
  store.Sundial_Service_Job__c[2].Address_at_Creation__c = "3 Elm St, Phoenix";
  store.Sundial_Service_Job__c[2].Primary_Phone_at_Creation__c = "602-555-0100";
  let seq = 10;
  let clock = 0;
  const calls = { creates: [], updates: [], queries: [] };
  const activity = [];
  const stale = [];
  const emails = [];
  const broadcasts = [];
  const texts = [];
  const smsRows = [];
  const fileRows = [];
  const photos = []; // { key, fileName, publicUrl, size, lastModified }
  const fetches = [];

  function cond(rec, c) {
    c = c.trim();
    let m;
    if ((m = c.match(/^([\w.]+) = '(.*)'$/))) return String(rec[m[1]] ?? "") === m[2];
    if ((m = c.match(/^(\w+) = (true|false)$/))) return (rec[m[1]] === true) === (m[2] === "true");
    if ((m = c.match(/^(\w+) NOT IN \((.*)\)$/))) return !m[2].split(",").map((x) => x.trim().replace(/^'|'$/g, "")).includes(String(rec[m[1]] ?? ""));
    if ((m = c.match(/^(\w+) IN \((.*)\)$/))) return m[2].split(",").map((x) => x.trim().replace(/^'|'$/g, "")).includes(String(rec[m[1]] ?? ""));
    if ((m = c.match(/^\((.*)\)$/)) && m[1].includes(" OR ")) return m[1].split(" OR ").some((sub) => cond(rec, sub));
    if ((m = c.match(/^([\w.]+) LIKE '%(.*)%'$/))) return String(rec[m[1]] ?? "").toLowerCase().includes(m[2].toLowerCase());
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
      insert: (row) => {
        if (table === "sundial_service_activity") activity.push(row);
        if (table === "sundial_sms_messages") smsRows.push({ id: `sms-${smsRows.length + 1}`, ...row });
        if (table === "sundial_file_metadata") fileRows.push({ id: `file-${fileRows.length + 1}`, ...row });
        const last = table === "sundial_sms_messages" ? smsRows[smsRows.length - 1] : table === "sundial_file_metadata" ? fileRows[fileRows.length - 1] : null;
        const p = Promise.resolve({ error: null, data: last });
        p.select = () => ({ single: async () => ({ data: last, error: null }), maybeSingle: async () => ({ data: last ? { id: last.id } : null, error: null }) });
        return p;
      },
      select: () => ({ eq: (col, v) => ({ limit: () => ({ maybeSingle: async () => ({ data: fileRows.find((r) => r[col] === v) ?? null, error: null }) }) }) }),
      update: (patch) => ({ in: (col, ids) => ({ eq: async () => { stale.push({ table, ids, patch }); return { error: null }; } }) }),
    }),
  });
  const world = {
    store, calls, activity, stale, emails, broadcasts, texts, smsRows, fileRows, photos, fetches,
    now: NOW,
    geocode: { status: "OK", results: [{ geometry: { location: { lat: 33.4484, lng: -112.074 } } }] },
    deps: {
      sfQuery, sfCreateRecord, sfUpdateRecord, getSupabaseClient,
      sendEmail: async (m) => { emails.push(m); return { ok: true, messageId: "m" }; },
      isEmailConfigured: () => true,
      broadcast: async (channel, event, payload) => { broadcasts.push({ channel, event, payload }); return { ok: true }; },
      now: () => world.now,
      env: { SERVICE_SHOP_LATLNG: "33.6,-111.9", SERVICE_GEOFENCE_METERS: "250", SMS_WEBHOOK_BASE: "https://api.example.com/prod" },
      getSecret: async (name) => (name === "sundial/twilio" ? { accountSid: "AC1", authToken: "tok", fromNumber: "+16025550000" } : name === "sundial/google-maps" ? { apiKey: "gkey" } : {}),
      fetchUrl: async (url) => { fetches.push(url); return { json: async () => world.geocode }; },
      sendSms: async (creds, msg) => { texts.push({ creds, msg }); return { ok: true, sid: `SM${texts.length}`, status: "queued" }; },
      presignPut: async ({ key, contentType }) => `https://s3.example/${key}?ct=${encodeURIComponent(contentType)}`,
      listPhotos: async (prefix) => photos.filter((p) => p.key.startsWith(prefix)),
    },
  };
  return world;
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

  // Status: In Progress opens the SAME clock the phone writes (Actual_Start derived from it)
  // and moves the job Scheduled → In Progress.
  const prog = await call(h, "PATCH", `/service/calls/${id}`, { status: "In Progress" });
  assert.equal(prog.status, 200);
  assert.equal(prog.body.jobStatusChanged, "In Progress");
  assert.equal(w.store.Sundial_Service_Call__c[0].Actual_Start__c, NOW.toISOString());
  assert.equal(w.store.Sundial_Service_Job__c[2].Status__c, "In Progress");
  const opened = parseIntervals(w.store.Sundial_Service_Call__c[0].Clock_Intervals__c);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].kind, "on_site");
  assert.equal(opened[0].out, null);

  // Started → cannot be moved.
  const moved = await call(h, "PATCH", `/service/calls/${id}`, { start: "2026-09-14T18:00:00Z" });
  assert.equal(moved.body.code, "CALL_ALREADY_STARTED");

  // Complete: another call on the job is still open, so the job stays In Progress…
  w.now = new Date(NOW.getTime() + 45 * 60000);
  const done = await call(h, "PATCH", `/service/calls/${id}`, { status: "Complete", workNotes: "Replaced the disconnect." });
  assert.equal(done.status, 200);
  assert.equal(done.body.jobStatusChanged, null);
  assert.equal(w.store.Sundial_Service_Call__c[0].Actual_End__c, w.now.toISOString());
  assert.equal(w.store.Sundial_Service_Call__c[0].Duration_Minutes__c, 45); // closed the interval the office opened
  w.now = NOW;
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

test("unscheduled calls: created without a window, own tray card (the job's card steps aside), scheduled by PATCH which settles the job", async () => {
  const w = fakeWorld();
  const h = makeHandler(w);
  // No start, no tech → Unscheduled. The job does not move.
  const c = await call(h, "POST", "/service/jobs/SVC000000000000001/calls", { unscheduled: true, privateNotes: "Bring the 200A breaker", notifyCustomer: true });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.call.status, "Unscheduled");
  assert.equal(c.body.call.start, null);
  assert.equal(c.body.call.techId, null);
  assert.equal(c.body.jobStatusChanged, null);
  assert.equal(c.body.notified, false, "nothing to tell the customer yet");
  assert.equal(w.store.Sundial_Service_Job__c[0].Status__c, "Ready to Schedule");
  const created = w.calls.creates.at(-1).fields;
  assert.ok(!("Scheduled_Start__c" in created) && !("Tech__c" in created), "no blank window / tech sent to Salesforce");

  // The tray: SVC-00001 now appears as its CALL, not as a job; SVC-00002 is still a job card.
  const b = await call(h, "GET", "/service/board", null, { from: "2026-09-14T07:00:00.000Z", to: "2026-09-15T07:00:00.000Z" });
  assert.deepEqual(b.body.unscheduled.map((j) => j.jobNumber), ["SVC-00002"]);
  assert.equal(b.body.unscheduledCalls.length, 1);
  assert.equal(b.body.unscheduledCalls[0].jobNumber, "SVC-00001");
  assert.equal(b.body.unscheduledCalls[0].privateNotes, "Bring the 200A breaker");
  assert.equal(b.body.calls.length, 1, "an unscheduled call is never on the grid");

  // Past Unscheduled without a start is refused; scheduling needs a tech.
  const noStart = await call(h, "PATCH", `/service/calls/${c.body.call.id}`, { status: "En Route" });
  assert.equal(noStart.body.code, "CALL_NOT_SCHEDULED");
  const noTech = await call(h, "PATCH", `/service/calls/${c.body.call.id}`, { start: "2026-09-16T16:00:00Z" });
  assert.equal(noTech.body.code, "TECH_REQUIRED");

  // Drop on the board: start + tech → Scheduled, default length, job → Scheduled, customer emailed as a NEW appointment.
  const s = await call(h, "PATCH", `/service/calls/${c.body.call.id}`, { start: "2026-09-16T16:00:00Z", techId: "USR000000000000001", notifyCustomer: true });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.call.status, "Scheduled");
  assert.equal(s.body.call.end, "2026-09-16T18:00:00.000Z");
  assert.equal(s.body.call.techName, "Jake Dorsey");
  assert.equal(s.body.jobStatusChanged, "Scheduled");
  assert.equal(s.body.notified, true);
  assert.ok(w.emails.at(-1).text.includes("Jake is scheduled"), "worded as a new appointment, not a change");
  const b2 = await call(h, "GET", "/service/board", null, { from: "2026-09-14T07:00:00.000Z", to: "2026-09-21T07:00:00.000Z" });
  assert.equal(b2.body.unscheduledCalls.length, 0);
  assert.ok(b2.body.unscheduled.every((j) => j.jobNumber !== "SVC-00001"), "the job left the tray");
});

// ---------------------------------------------------------------------------
// The technician app (tech.js)
// ---------------------------------------------------------------------------
const JAKE = { tenantId: TENANT, tenantSlug: "harmon", user: { id: "USR000000000000001", firstName: "Jake", lastName: "Dorsey" }, access: { scope: "tech", level: "Technician", tenantId: TENANT, userId: "USR000000000000001" } };
const LARRY = { tenantId: TENANT, tenantSlug: "harmon", user: { id: "USR000000000000002", firstName: "Larry", lastName: "Ng" }, access: { scope: "tech", level: "Technician", tenantId: TENANT, userId: "USR000000000000002" } };

test("tech helpers: the clock log, day bounds, stamped notes, the checklist gate, the geofence", () => {
  // routes
  assert.equal(matchRoute("GET", "/prod/service/tech/day").name, "techDay");
  assert.deepEqual(matchRoute("POST", "/service/tech/calls/SC1/photos/confirm"), { name: "techPhotoConfirm", params: ["SC1"] });
  assert.deepEqual(matchRoute("POST", "/service/tech/calls/SC1/photos"), { name: "techPhotoPresign", params: ["SC1"] });
  assert.equal(matchRoute("GET", "/service/tech/price-book").name, "techPriceBook");

  // the clock: on my way → arrive → out; duplicates and no-ops
  let log = parseIntervals(null);
  let r = applyClockEvent(log, { kind: "en_route", at: "2026-09-14T15:00:00.000Z", gps: { lat: 1, lng: 2 }, eventId: "e1" });
  assert.equal(r.changed, true);
  assert.equal(clockState(r.intervals).state, "en_route");
  r = applyClockEvent(r.intervals, { kind: "en_route", at: "2026-09-14T15:01:00.000Z", eventId: "e1" });
  assert.equal(r.duplicate, true);
  r = applyClockEvent(r.intervals, { kind: "clock_in", at: "2026-09-14T15:20:00.000Z", gps: { lat: 3, lng: 4 }, eventId: "e2" });
  assert.equal(r.intervals.length, 1, "arriving continues the en_route interval");
  assert.equal(r.intervals[0].arrived, "2026-09-14T15:20:00.000Z");
  assert.equal(clockState(r.intervals).state, "on_site");
  assert.equal(clockState(r.intervals, "2026-09-14T15:30:00.000Z").minutes, 30);
  r = applyClockEvent(r.intervals, { kind: "clock_out", at: "2026-09-14T16:00:00.000Z", gps: { lat: 3, lng: 4 }, eventId: "e3" });
  const f = clockFields(r.intervals);
  assert.equal(f.Actual_Start__c, "2026-09-14T15:00:00.000Z");
  assert.equal(f.Actual_End__c, "2026-09-14T16:00:00.000Z");
  assert.equal(f.Duration_Minutes__c, 60);
  assert.equal(f.Clock_In_Latitude__c, 3); // the arrival fix, not the departure
  assert.equal(f.Clock_Out_Longitude__c, 4);
  assert.deepEqual(JSON.parse(f.Clock_Intervals__c)[0].ids, ["e1", "e2", "e3"]);
  // reopen: a second interval, Actual_End moves
  r = applyClockEvent(r.intervals, { kind: "clock_in", at: "2026-09-14T16:30:00.000Z" });
  assert.equal(r.intervals.length, 2);
  assert.equal(clockFields(r.intervals).Actual_End__c, null);
  r = applyClockEvent(r.intervals, { kind: "clock_out", at: "2026-09-14T16:45:00.000Z" });
  assert.equal(clockFields(r.intervals).Duration_Minutes__c, 75);
  assert.equal(applyClockEvent(r.intervals, { kind: "clock_out", at: "2026-09-14T17:00:00.000Z" }).changed, false);

  // days in Phoenix (no DST): 2026-09-14 is 07:00Z → 07:00Z next day
  assert.deepEqual(dayBounds("2026-09-14", "America/Phoenix"), { from: "2026-09-14T07:00:00.000Z", to: "2026-09-15T07:00:00.000Z" });
  assert.equal(dayBounds("2026-13-40", "America/Phoenix"), null);
  assert.equal(localDate(new Date("2026-09-15T05:00:00Z"), "America/Phoenix"), "2026-09-14");
  // and a DST-crossing day in New York is 25 hours long
  const ny = dayBounds("2026-11-01", "America/New_York");
  assert.equal((Date.parse(ny.to) - Date.parse(ny.from)) / 3600000, 25);

  // notes are append-only and stamped
  const n1 = appendStamped(null, { name: "Jake Dorsey", at: "2026-09-14T16:05:00Z", timeZone: "America/Phoenix", body: "Replaced the breaker." });
  assert.equal(n1, "── Jake Dorsey · Sep 14, 2026, 9:05 AM\nReplaced the breaker.");
  const n2 = appendStamped(n1, { name: "Jake Dorsey", at: "2026-09-14T16:30:00Z", timeZone: "America/Phoenix", body: "Tested." });
  assert.ok(n2.startsWith(n1 + "\n\n── Jake Dorsey"));

  // the checklist: auto items follow the record; the gate lists what is missing
  const empty = checklistFor({ Work_Notes__c: null, Photos_Count__c: 0, Checklist_State__c: null });
  assert.deepEqual(empty.missing, ["work_notes", "photos", "walkthrough", "tools"]);
  const ready = checklistFor({ Work_Notes__c: "did things", Photos_Count__c: 2, Checklist_State__c: JSON.stringify({ walkthrough: { done: true, at: "x" }, tools: true }) });
  assert.equal(ready.complete, true);
  assert.equal(ready.items.find((i) => i.key === "review").done, false); // optional, not blocking
  assert.equal(DEFAULT_CHECKLIST.items.filter((i) => i.required).length, 4);

  // geofence: within 250 m of the job OR the shop; a tag, never a gate
  assert.equal(haversineMeters({ lat: 33.4484, lng: -112.074 }, { lat: 33.4484, lng: -112.074 }), 0);
  const near = geofenceCheck({ lat: 33.4490, lng: -112.074 }, [{ label: "job", point: { lat: 33.4484, lng: -112.074 } }, { label: "shop", point: { lat: 33.6, lng: -111.9 } }], 250);
  assert.equal(near.verified, true);
  assert.equal(near.against, "job");
  assert.ok(near.distanceMeters > 50 && near.distanceMeters < 100);
  const far = geofenceCheck({ lat: 34, lng: -112 }, [{ label: "job", point: { lat: 33.4484, lng: -112.074 } }], 250);
  assert.equal(far.verified, false);
  assert.equal(geofenceCheck(null, [{ label: "job", point: { lat: 1, lng: 1 } }], 250).verified, false);
  assert.equal(geofenceCheck({ lat: 1, lng: 1 }, [{ label: "job", point: null }], 250).distanceMeters, null);

  assert.equal(onMyWayText({ customerName: "Cy Diaz", techFirstName: "Jake", brandName: "Harmon Electric", jobNumber: "SVC-00003" }), "Hi Cy, Jake from Harmon Electric is on the way to you now. (Job SVC-00003) Reply to this text if anything changes.");
  assert.equal(photoPrefix("SVC1", "SC1"), "SUNDIAL/SVC1/photos/SC1/");
});

test("GET /service/tech/day: only my calls that day (+ anything I'm mid-way through); the board itself is off limits to a tech", async () => {
  const w = fakeWorld();
  const h = makeHandler(w, JAKE);
  const r = await call(h, "GET", "/service/tech/day", null, { date: "2026-09-14" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.tech.name, "Jake Dorsey");
  assert.deepEqual(r.body.calls.map((c) => c.number), ["SC-00001"]);
  assert.equal(r.body.calls[0].customerName, "Cy Diaz");
  assert.equal(r.body.calls[0].clock.state, "idle");
  assert.equal(r.body.calls[0].checklist.missing.length, 4);
  assert.equal(r.body.calls[0].estimateId, "EST000000000000003");
  assert.equal(r.body.activeCallId, null);
  // defaults to today in the tenant's zone
  const today = await call(h, "GET", "/service/tech/day");
  assert.equal(today.body.date, "2026-09-14");
  // Larry sees his own (next week, so nothing today)
  const larry = await call(makeHandler(w, LARRY), "GET", "/service/tech/day", null, { date: "2026-09-14" });
  assert.deepEqual(larry.body.calls, []);
  // the dispatch board is not a tech route
  const board = await call(h, "GET", "/service/board", null, { from: "2026-09-14T07:00:00Z", to: "2026-09-15T07:00:00Z" });
  assert.equal(board.status, 403);
  // the office can look at a tech's day
  const office = await call(makeHandler(w), "GET", "/service/tech/day", null, { date: "2026-09-14", techId: "USR000000000000001" });
  assert.deepEqual(office.body.calls.map((c) => c.number), ["SC-00001"]);
  const badDate = await call(h, "GET", "/service/tech/day", null, { date: "yesterday" });
  assert.equal(badDate.body.code, "DATE_INVALID");
});

test("GET /service/tech/calls/{id}: the whole call page; another tech's call is a 404, the office may read it", async () => {
  const w = fakeWorld();
  w.photos.push({ key: "SUNDIAL/SVC000000000000003/photos/SC0000000000000001/a.jpg", fileName: "a.jpg", publicUrl: "https://x/a.jpg", size: 10, lastModified: "2026-09-14T15:00:00Z" });
  const r = await call(makeHandler(w, JAKE), "GET", "/service/tech/calls/SC0000000000000001");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.call.address, "3 Elm St, Phoenix");
  assert.equal(r.body.call.phone, "602-555-0100");
  assert.deepEqual(r.body.otherTechs.map((t) => t.techName), ["Larry Ng"]);
  assert.equal(r.body.photos.length, 1);
  assert.equal(r.body.estimate.number, "EST-00003");
  assert.equal(r.body.estimate.lines.length, 2);
  assert.equal(r.body.estimate.lines[1].addedByThisCall, true);
  assert.equal(r.body.geofenceMeters, 250);
  const notMine = await call(makeHandler(w, LARRY), "GET", "/service/tech/calls/SC0000000000000001");
  assert.equal(notMine.status, 404);
  const office = await call(makeHandler(w), "GET", "/service/tech/calls/SC0000000000000001");
  assert.equal(office.status, 200);
  const otherTenant = await call(makeHandler(w, { ...JAKE, tenantId: OTHER, access: { ...JAKE.access, tenantId: OTHER } }), "GET", "/service/tech/calls/SC0000000000000001");
  assert.equal(otherTenant.status, 404);
});

test("the day in the field: on my way (texts, closes the other clock) → clock in (geofence, job In Progress) → complete gated by the checklist → complete", async () => {
  const w = fakeWorld();
  // Jake is still on the clock at another job from earlier (In Progress, one open interval).
  w.store.Sundial_Service_Call__c.push({ Id: "SC0000000000000005", Client__c: TENANT, Name: "SC-00005", Visit_Type__c: "Service", Sundial_Service_Job__c: "SVC000000000000001", Tech__c: "USR000000000000001", Scheduled_Start__c: "2026-09-14T13:00:00.000Z", Scheduled_End__c: "2026-09-14T15:00:00.000Z", Status__c: "In Progress", Actual_Start__c: "2026-09-14T13:05:00.000Z", Clock_Intervals__c: JSON.stringify([{ in: "2026-09-14T13:05:00.000Z", out: null, kind: "on_site", arrived: "2026-09-14T13:05:00.000Z", ids: [] }]), SystemModstamp: "2026-09-14T13:05:00Z", CreatedDate: "2026-09-12T10:00:00Z" });
  const h = makeHandler(w, JAKE);
  const id = "SC0000000000000001";

  // 1. On my way (the phone's tap time is a minute ago; queued offline and replayed)
  let r = await call(h, "POST", `/service/tech/calls/${id}/status`, { status: "En Route", at: "2026-09-14T14:59:00Z", gps: { lat: 33.6, lng: -111.9, accuracy: 12 }, eventId: "ev-1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.call.status, "En Route");
  assert.equal(r.body.call.clock.state, "en_route");
  assert.equal(r.body.text.sent, true);
  assert.equal(r.body.text.to, "(602) 555-0100");
  assert.equal(w.texts.length, 1);
  assert.equal(w.texts[0].msg.to, "+16025550100");
  assert.equal(w.texts[0].msg.body, "Hi Cy, Jake from harmon is on the way to you now. (Job SVC-00003) Reply to this text if anything changes.");
  assert.equal(w.smsRows[0].job_sf_id, "SVC000000000000003");
  assert.equal(w.smsRows[0].sent_by_name, "Jake Dorsey");
  // the earlier job's clock was closed, its status left In Progress (paused, not finished)
  assert.deepEqual(r.body.closedOthers, [{ id: "SC0000000000000005", status: "In Progress" }]);
  const prev = w.store.Sundial_Service_Call__c.find((c) => c.Id === "SC0000000000000005");
  assert.equal(JSON.parse(prev.Clock_Intervals__c)[0].out, "2026-09-14T14:59:00.000Z");
  assert.equal(prev.Actual_End__c, undefined);
  // replaying the same event is a no-op
  r = await call(h, "POST", `/service/tech/calls/${id}/status`, { status: "En Route", at: "2026-09-14T14:59:00Z", eventId: "ev-1" });
  assert.equal(r.body.duplicate, true);
  assert.equal(w.texts.length, 1);
  // a tap from before the last event is refused (the office corrects time, not the app)
  r = await call(h, "POST", `/service/tech/calls/${id}/status`, { status: "In Progress", at: "2026-09-14T14:00:00Z" });
  assert.equal(r.body.code, "AT_OUT_OF_ORDER");

  // 2. Clock in at the door: geocoded lazily, within the fence
  w.now = new Date("2026-09-14T15:20:00Z");
  r = await call(h, "POST", `/service/tech/calls/${id}/status`, { status: "In Progress", at: "2026-09-14T15:19:30Z", gps: { lat: 33.4486, lng: -112.0741 }, eventId: "ev-2" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.call.status, "In Progress");
  assert.equal(r.body.call.clock.state, "on_site");
  assert.equal(r.body.geofence.verified, true);
  assert.equal(r.body.geofence.against, "job");
  assert.equal(r.body.jobStatusChanged, "In Progress");
  assert.equal(w.fetches.length, 1);
  assert.ok(w.fetches[0].includes("3%20Elm%20St"));
  const job = w.store.Sundial_Service_Job__c.find((j) => j.Id === "SVC000000000000003");
  assert.equal(job.Geocode_Status__c, "Geocoded");
  assert.equal(job.Geocode_Lat__c, 33.4484);
  const rec = () => w.store.Sundial_Service_Call__c.find((c) => c.Id === id);
  assert.equal(rec().Geofence_Verified__c, true);
  assert.equal(rec().Actual_Start__c, "2026-09-14T14:59:00.000Z"); // drive time counts toward this call
  assert.equal(rec().Clock_In_Latitude__c, 33.4486);

  // 3. Complete is gated: nothing is done yet
  w.now = new Date("2026-09-14T16:30:00Z");
  r = await call(h, "POST", `/service/tech/calls/${id}/status`, { status: "Complete", eventId: "ev-3" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "CHECKLIST_INCOMPLETE");
  assert.deepEqual(r.body.missing, ["work_notes", "photos", "walkthrough", "tools"]);
  assert.equal(rec().Status__c, "In Progress");

  // notes (stamped, appended), a photo (presign → confirm), two ticks
  r = await call(h, "POST", `/service/tech/calls/${id}/notes`, { body: "Replaced the 20A breaker; tested under load.", at: "2026-09-14T16:20:00Z", eventId: "n-1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(rec().Work_Notes__c.startsWith("── Jake Dorsey · Sep 14, 2026, 9:20 AM\nReplaced the 20A breaker"));
  r = await call(h, "POST", `/service/tech/calls/${id}/notes`, { body: "Replaced the 20A breaker; tested under load.", at: "2026-09-14T16:20:00Z", eventId: "n-1" });
  assert.equal(r.body.duplicate, true);
  r = await call(h, "POST", `/service/tech/calls/${id}/notes`, { body: "Customer's dog bites.", private: true });
  assert.ok(rec().Private_Notes__c.includes("Customer's dog bites."));
  assert.ok(!rec().Work_Notes__c.includes("dog"));
  assert.equal(w.activity.filter((a) => a.event === "service_call_note").length, 2);

  r = await call(h, "POST", `/service/tech/calls/${id}/photos`, { fileName: "IMG 0042.jpg", contentType: "image/jpeg", size: 1200 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.key.startsWith("SUNDIAL/SVC000000000000003/photos/SC0000000000000001/"), r.body.key);
  assert.ok(r.body.key.endsWith("-IMG_0042.jpg"));
  assert.ok(r.body.uploadUrl.includes("image%2Fjpeg"));
  const notImage = await call(h, "POST", `/service/tech/calls/${id}/photos`, { fileName: "notes.pdf", contentType: "application/pdf" });
  assert.equal(notImage.body.code, "NOT_AN_IMAGE");
  w.photos.push({ key: r.body.key, fileName: r.body.key.split("/").pop(), publicUrl: r.body.publicUrl, size: 1200, lastModified: "2026-09-14T16:25:00Z" });
  r = await call(h, "POST", `/service/tech/calls/${id}/photos/confirm`, { key: r.body.key, size: 1200, contentType: "image/jpeg", caption: "New breaker" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.photosCount, 1);
  assert.equal(r.body.checklist.items.find((i) => i.key === "photos").done, true);
  assert.equal(w.fileRows.length, 1);
  assert.equal(w.fileRows[0].subfolder, "photos/SC0000000000000001");
  assert.equal(w.fileRows[0].sf_record_id, "SVC000000000000003");
  assert.equal(w.fileRows[0].category, "photo");
  const badKey = await call(h, "POST", `/service/tech/calls/${id}/photos/confirm`, { key: "SUNDIAL/SVC000000000000001/photos/SC0000000000000001/x.jpg" });
  assert.equal(badKey.body.code, "KEY_INVALID");

  r = await call(h, "POST", `/service/tech/calls/${id}/checklist`, { key: "walkthrough", done: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.checklist.items.find((i) => i.key === "walkthrough").by, "Jake Dorsey");
  r = await call(h, "POST", `/service/tech/calls/${id}/checklist`, { key: "tools", done: true });
  assert.deepEqual(r.body.checklist.missing, []);
  const auto = await call(h, "POST", `/service/tech/calls/${id}/checklist`, { key: "photos", done: true });
  assert.equal(auto.body.code, "ITEM_AUTOMATIC");

  // 4. Complete
  r = await call(h, "POST", `/service/tech/calls/${id}/status`, { status: "Complete", at: "2026-09-14T16:29:00Z", gps: { lat: 33.4486, lng: -112.0741 }, eventId: "ev-3" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.call.status, "Complete");
  assert.equal(r.body.call.clock.state, "idle");
  assert.equal(r.body.call.durationMinutes, 90); // 14:59 → 16:29, drive time included
  assert.equal(rec().Actual_End__c, "2026-09-14T16:29:00.000Z");
  assert.equal(rec().Clock_Out_Latitude__c, 33.4486);
  assert.equal(r.body.jobStatusChanged, null); // Larry's SC-00002 is still open on the job
  assert.equal(w.activity.filter((a) => a.event === "service_call_clock").length, 4); // other-closed, en route, in, out
  assert.ok(w.broadcasts.some((b) => b.event === "board" && b.payload.via === "tech" && b.payload.call.id === id));
  assert.ok(w.stale.some((s) => s.ids.includes(id)));

  // 5. Reopen: clock in again on a Complete call (a new interval; the log never edits)
  w.now = new Date("2026-09-14T16:40:00Z");
  r = await call(h, "POST", `/service/tech/calls/${id}/status`, { status: "In Progress", eventId: "ev-4" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.call.intervals.length, 2);
  assert.equal(rec().Actual_End__c, null);
  // can't complete from Scheduled; can't go en route from In Progress
  const larryH = makeHandler(w, LARRY);
  const notStarted = await call(larryH, "POST", "/service/tech/calls/SC0000000000000002/status", { status: "Complete" });
  assert.equal(notStarted.body.code, "CALL_NOT_STARTED");
  const noShow = await call(larryH, "POST", "/service/tech/calls/SC0000000000000002/status", { status: "No-Show" });
  assert.equal(noShow.body.code, "NOTE_REQUIRED");
  const noShowOk = await call(larryH, "POST", "/service/tech/calls/SC0000000000000002/status", { status: "No-Show", note: "Nobody home, no answer." });
  assert.equal(noShowOk.body.call.status, "No-Show");
  assert.ok(w.store.Sundial_Service_Call__c.find((c) => c.Id === "SC0000000000000002").Private_Notes__c.includes("No-show: Nobody home"));
});

test("on my way without a mobile number skips the text silently; textCustomer:false skips it on purpose; a custom message is used", async () => {
  const w = fakeWorld();
  // SC-00002 (Larry) is on the same job — use Jake's, but strip the phone
  const job = w.store.Sundial_Service_Job__c.find((j) => j.Id === "SVC000000000000003");
  delete job.Primary_Phone_at_Creation__c;
  w.store.Sundial_Customer__c = w.store.Sundial_Customer__c.filter((c) => c.Id !== "CUS000000000000003");
  const h = makeHandler(w, JAKE);
  let r = await call(h, "POST", "/service/tech/calls/SC0000000000000001/status", { status: "En Route" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.call.status, "En Route");
  assert.deepEqual(r.body.text, { sent: false, reason: "NO_PHONE", detail: "No mobile number on this job." });
  assert.equal(w.texts.length, 0);

  const w2 = fakeWorld();
  const h2 = makeHandler(w2, JAKE);
  r = await call(h2, "POST", "/service/tech/calls/SC0000000000000001/status", { status: "En Route", textCustomer: false });
  assert.deepEqual(r.body.text, { sent: false, reason: "SKIPPED" });
  // back to Scheduled via the board, then en route with a custom message
  await call(makeHandler(w2), "PATCH", "/service/calls/SC0000000000000001", { status: "Scheduled" });
  r = await call(h2, "POST", "/service/tech/calls/SC0000000000000001/status", { status: "En Route", message: "Running 10 min late, on my way now." });
  assert.equal(w2.texts[0].msg.body, "Running 10 min late, on my way now.");
});

test("clock-in without GPS or without a geocode is simply unverified; a failed geocode is remembered, a Google error is not", async () => {
  const w = fakeWorld();
  const h = makeHandler(w, JAKE);
  let r = await call(h, "POST", "/service/tech/calls/SC0000000000000001/status", { status: "In Progress" });
  assert.equal(r.status, 200);
  assert.equal(r.body.geofence.verified, false);
  assert.equal(w.fetches.length, 0); // no GPS → no reason to geocode

  const w2 = fakeWorld();
  w2.geocode = { status: "ZERO_RESULTS", results: [] };
  r = await call(makeHandler(w2, JAKE), "POST", "/service/tech/calls/SC0000000000000001/status", { status: "In Progress", gps: { lat: 33.4486, lng: -112.0741 } });
  assert.equal(r.body.geofence.verified, false);
  assert.equal(w2.store.Sundial_Service_Job__c[2].Geocode_Status__c, "Failed");

  const w3 = fakeWorld();
  w3.geocode = { status: "REQUEST_DENIED" };
  r = await call(makeHandler(w3, JAKE), "POST", "/service/tech/calls/SC0000000000000001/status", { status: "In Progress", gps: { lat: 33.6001, lng: -111.9 } });
  assert.equal(r.body.geofence.verified, true); // the shop is 250 m away at most
  assert.equal(r.body.geofence.against, "shop");
  assert.equal(w3.store.Sundial_Service_Job__c[2].Geocode_Status__c, undefined); // still pending, tried again next time
});

test("GET /service/tech/price-book?q=: active items of this tenant matching name / code / description", async () => {
  const w = fakeWorld();
  const h = makeHandler(w, JAKE);
  let r = await call(h, "GET", "/service/tech/price-book", null, { q: "brk" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.items.map((i) => i.code), ["BRK-20"]);
  assert.equal(r.body.items[0].price, 45);
  r = await call(h, "GET", "/service/tech/price-book", null, { q: "20a" });
  assert.deepEqual(r.body.items.map((i) => i.name), ["Breaker 20A single pole"]);
  r = await call(h, "GET", "/service/tech/price-book");
  assert.equal(r.body.items.length, 2);
});

test("read-only lists for the tech app: jobs (open by default, searchable), estimates (no templates), customers — tenant-wide, action service.tech.read", async () => {
  const w = fakeWorld();
  const h = makeHandler(w, JAKE);
  // Jobs: open ones only unless searching or asked for a status; Closed SVC-00004 hidden; other tenant never.
  let r = await call(h, "GET", "/service/tech/jobs");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.jobs.map((j) => j.number).sort(), ["SVC-00001", "SVC-00002", "SVC-00003"]);
  r = await call(h, "GET", "/service/tech/jobs", null, { q: "cy" });
  assert.deepEqual(r.body.jobs.map((j) => j.number), ["SVC-00003"]);
  r = await call(h, "GET", "/service/tech/jobs", null, { status: "Closed" });
  assert.deepEqual(r.body.jobs.map((j) => j.number), ["SVC-00004"]);
  // One job: header + calls (mine flagged) + estimate with lines.
  r = await call(h, "GET", "/service/tech/jobs/SVC000000000000003");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.job.customerName, "Cy Diaz");
  assert.equal(r.body.job.address, "3 Elm St, Phoenix");
  assert.deepEqual(r.body.calls.map((c) => [c.techName, c.isMine]), [["Jake Dorsey", true], ["Larry Ng", false]]);
  assert.equal(r.body.estimate.number, "EST-00003");
  assert.equal(r.body.estimate.lines.length, 2);
  assert.equal((await call(h, "GET", "/service/tech/jobs/SVC000000000000099")).status, 404); // other tenant
  // Estimates: templates never listed; a template id is a 404.
  r = await call(h, "GET", "/service/tech/estimates");
  assert.deepEqual(r.body.estimates.map((e) => e.number), ["EST-00003"]);
  r = await call(h, "GET", "/service/tech/estimates/EST000000000000003");
  assert.equal(r.body.estimate.total, 450);
  assert.equal(r.body.estimate.lines[1].description, "Breaker 20A");
  assert.equal((await call(h, "GET", "/service/tech/estimates/EST000000000000008")).status, 404);
  // Customers: search, then the hub with their jobs + estimates.
  r = await call(h, "GET", "/service/tech/customers", null, { q: "555-0100" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.customers.map((c) => c.name), ["Cy Diaz"]); // the other tenant's Cy is not ours
  assert.equal(r.body.customers[0].address, "3 Elm St, Phoenix, AZ, 85001");
  r = await call(h, "GET", "/service/tech/customers/CUS000000000000003");
  assert.deepEqual(r.body.jobs.map((j) => j.number), ["SVC-00003"]);
  assert.deepEqual(r.body.estimates.map((e) => e.number), ["EST-00003"]);
  // A sales rep (own scope) has none of this.
  const rep = makeHandler(w, { user: { id: "USR000000000000003" }, access: { scope: "own", level: "Sales Rep", tenantId: TENANT, userId: "USR000000000000003", dealerId: "DLR000000000000001" } });
  assert.equal((await call(rep, "GET", "/service/tech/jobs")).status, 403);
});

// ---------------------------------------------------------------------------
// The office's time corrections (2026-09-17)
// ---------------------------------------------------------------------------

test("applyCorrection: edits stamp who/when/why, removed rows stay in the log but count for nothing, nothing reopens", () => {
  const by = { id: "USR000000000000003", name: "Beth Office" };
  const now = "2026-09-14T20:00:00.000Z";
  let log = applyClockEvent([], { kind: "en_route", at: "2026-09-14T15:00:00.000Z", eventId: "e1" }).intervals;
  log = applyClockEvent(log, { kind: "clock_in", at: "2026-09-14T15:20:00.000Z", eventId: "e2" }).intervals;
  log = applyClockEvent(log, { kind: "clock_out", at: "2026-09-14T16:00:00.000Z", eventId: "e3" }).intervals;
  log = applyClockEvent(log, { kind: "clock_in", at: "2026-09-14T16:30:00.000Z", eventId: "e4" }).intervals; // forgot to clock out
  assert.equal(sumMinutes(log, now), 60 + 210);

  // The dialog sends the rows back: close the forgotten one at 17:00, trim the first one's arrival.
  const rows = annotateLog(log).map((r) => ({ index: r.index, in: r.in, arrived: r.arrived, out: r.out }));
  rows[0].arrived = "2026-09-14T15:25:00.000Z";
  rows[1].out = "2026-09-14T17:00:00.000Z";
  const r = applyCorrection(log, rows, { now, by, reason: "forgot to clock out" });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.changed, true);
  assert.deepEqual([r.changes.corrected.length, r.changes.added, r.changes.removed], [2, 0, 0]);
  assert.equal(r.intervals[1].out, "2026-09-14T17:00:00.000Z");
  assert.equal(r.intervals[1].corrections[0].by.name, "Beth Office");
  assert.equal(r.intervals[1].corrections[0].from.out, null);
  assert.equal(r.intervals[0].corrections[0].from.arrived, "2026-09-14T15:20:00.000Z");
  assert.deepEqual(r.intervals[1].ids, ["e4"]); // the phone's event ids survive a correction
  const f = clockFields(r.intervals);
  assert.equal(f.Actual_End__c, "2026-09-14T17:00:00.000Z");
  assert.equal(f.Duration_Minutes__c, 90);

  // Remove the second interval entirely: it stays in the JSON, flagged, and stops counting.
  const rm = applyCorrection(r.intervals, [{ index: 0, in: rows[0].in, arrived: rows[0].arrived, out: rows[0].out }], { now, by, reason: "double tap" });
  assert.equal(rm.changes.removed, 1);
  assert.equal(rm.intervals.length, 2);
  assert.equal(rm.intervals[1].removed.reason, "double tap");
  assert.equal(liveIntervals(rm.intervals).length, 1);
  assert.equal(clockFields(rm.intervals).Duration_Minutes__c, 60);
  assert.equal(openIntervalIndex(rm.intervals), -1);
  assert.equal(hasClockEvent(rm.intervals, "e4"), true); // a replay of the removed tap is still a duplicate
  assert.equal(lastClockTime(rm.intervals), "2026-09-14T16:00:00.000Z");
  assert.deepEqual(parseIntervals(JSON.stringify(rm.intervals)).map((i) => !!i.removed), [false, true]);

  // Add a missed interval (office-added rows carry no ids and an `added` stamp).
  const add = applyCorrection(rm.intervals, [{ index: 0, in: rows[0].in, arrived: rows[0].arrived, out: rows[0].out }, { in: "2026-09-14T17:30:00.000Z", out: "2026-09-14T18:00:00.000Z" }], { now, by, reason: "second visit not clocked" });
  assert.equal(add.changes.added, 1);
  assert.equal(liveIntervals(add.intervals).length, 2);
  assert.equal(add.intervals[add.intervals.length - 1].added.by.id, by.id);
  assert.equal(add.intervals[add.intervals.length - 1].kind, "on_site");
  assert.equal(clockFields(add.intervals).Duration_Minutes__c, 90);

  // Same rows back = nothing to do.
  const same = applyCorrection(add.intervals, annotateLog(add.intervals).filter((i) => !i.removed).map((i) => ({ index: i.index, in: i.in, arrived: i.arrived, out: i.out })), { now, by, reason: "x" });
  assert.equal(same.changed, false);
  assert.equal(same.intervals, add.intervals);

  // Refusals.
  const bad = (rows2, code) => assert.equal(applyCorrection(add.intervals, rows2, { now, by, reason: "x" }).error?.[0], code, code);
  bad("nope", "INTERVALS_REQUIRED");
  bad([{ index: 9, in: now }], "INDEX_INVALID");
  bad([{ index: 1, in: now }], "INDEX_INVALID"); // the removed row cannot be edited
  bad([{ index: 0, in: rows[0].in, out: rows[0].out }, { index: 0, in: rows[0].in, out: rows[0].out }], "INDEX_DUPLICATE");
  bad([{ index: 0, in: "when?", out: rows[0].out }], "TIME_INVALID");
  bad([{ index: 0, in: rows[0].in, out: "2026-09-15T20:00:00.000Z" }], "TIME_FUTURE");
  bad([{ index: 0, out: rows[0].out }], "IN_REQUIRED");
  bad([{ in: "2026-09-14T18:30:00.000Z" }], "OUT_REQUIRED");
  bad([{ index: 0, in: rows[0].in, out: null }], "NO_REOPEN");
  bad([{ index: 0, in: rows[0].out, out: rows[0].in }], "ORDER_INVALID");
  bad([{ index: 0, in: rows[0].in, arrived: "2026-09-14T14:00:00.000Z", out: rows[0].out }], "ORDER_INVALID");
  bad([{ index: 0, in: rows[0].in, out: rows[0].out }, { in: "2026-09-14T15:30:00.000Z", out: "2026-09-14T15:45:00.000Z" }], "OVERLAP");
  const open = applyClockEvent([], { kind: "clock_in", at: "2026-09-14T18:30:00.000Z" }).intervals;
  assert.equal(applyCorrection(open, [{ index: 0, in: "2026-09-14T18:30:00.000Z", out: null }, { in: "2026-09-14T19:00:00.000Z", out: "2026-09-14T19:30:00.000Z" }], { now, by, reason: "x" }).error[0], "OPEN_NOT_LAST");
});

test("GET/POST /service/calls/{id}/clock: the office closes a forgotten clock, the actuals follow the log, complete:true finishes the call and settles the job", async () => {
  const w = fakeWorld();
  const office = makeHandler(w);
  const techH = makeHandler(w, { user: { id: "USR000000000000001", firstName: "Jake", lastName: "Dorsey" }, access: { scope: "tech", level: "Technician", tenantId: TENANT, userId: "USR000000000000001" } });
  const id = "SC0000000000000001";
  // Jake clocks in at 9:05 and never clocks out.
  w.now = new Date("2026-09-14T16:05:00Z");
  let r = await call(techH, "POST", `/service/tech/calls/${id}/status`, { status: "In Progress", eventId: "t1", textCustomer: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(w.store.Sundial_Service_Job__c[2].Status__c, "In Progress");

  // Next morning the office opens the dialog: the log is numbered, GPS rides along, it came from the phone.
  w.now = new Date("2026-09-15T14:00:00Z");
  r = await call(office, "GET", `/service/calls/${id}/clock`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.log.length, 1);
  assert.deepEqual([r.body.log[0].index, r.body.log[0].out, r.body.log[0].fromPhone, r.body.log[0].kind], [0, null, true, "on_site"]);
  assert.equal(r.body.call.clock.state, "on_site");
  assert.equal(r.body.timeZone, "America/Phoenix");
  // A tech cannot reach the office's route.
  assert.equal((await call(techH, "GET", `/service/calls/${id}/clock`)).status, 403);
  assert.equal((await call(techH, "POST", `/service/calls/${id}/clock`, { reason: "x", intervals: [] })).status, 403);

  // A reason is required; a stale stamp is a 409; the tech's rules apply (no future times).
  assert.equal((await call(office, "POST", `/service/calls/${id}/clock`, { intervals: [] })).body.code, "REASON_REQUIRED");
  assert.equal((await call(office, "POST", `/service/calls/${id}/clock`, { reason: "x", intervals: [], baseModstamp: "2000-01-01T00:00:00Z" })).body.code, "CALL_CONFLICT");
  assert.equal((await call(office, "POST", `/service/calls/${id}/clock`, { reason: "x", intervals: [{ index: 0, in: "2026-09-14T16:05:00.000Z", out: "2026-09-16T00:00:00.000Z" }] })).body.code, "TIME_FUTURE");
  // Completing with the interval still open is refused.
  assert.equal((await call(office, "POST", `/service/calls/${id}/clock`, { reason: "x", intervals: [{ index: 0, in: "2026-09-14T16:05:00.000Z", out: null }], complete: true })).body.code, "STILL_OPEN");

  // Close it at 11:00 yesterday and mark the call complete.
  const before = w.calls.updates.length;
  r = await call(office, "POST", `/service/calls/${id}/clock`, { reason: "Jake forgot to clock out", intervals: [{ index: 0, in: "2026-09-14T16:05:00.000Z", out: "2026-09-14T18:00:00.000Z" }], complete: true, baseModstamp: w.store.Sundial_Service_Call__c[0].SystemModstamp });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.changes, { corrected: [{ index: 0, from: { in: "2026-09-14T16:05:00.000Z", arrived: "2026-09-14T16:05:00.000Z", out: null }, to: { in: "2026-09-14T16:05:00.000Z", arrived: "2026-09-14T16:05:00.000Z", out: "2026-09-14T18:00:00.000Z" } }], added: 0, removed: 0 });
  const rec = w.store.Sundial_Service_Call__c[0];
  assert.equal(rec.Status__c, "Complete");
  assert.equal(rec.Actual_Start__c, "2026-09-14T16:05:00.000Z");
  assert.equal(rec.Actual_End__c, "2026-09-14T18:00:00.000Z");
  assert.equal(rec.Duration_Minutes__c, 115);
  assert.equal(r.body.call.clock.state, "idle");
  assert.equal(r.body.log[0].corrections[0].reason, "Jake forgot to clock out");
  assert.equal(r.body.log[0].corrections[0].by.name, "Beth Office");
  assert.equal(r.body.laborFromClock, false); // not billable
  assert.equal(r.body.jobStatusChanged, null); // Larry's SC-00002 is still open on the job
  assert.equal(w.calls.updates.length, before + 1);
  const row = w.activity.filter((a) => a.event === "service_call_clock").pop();
  assert.equal(row.details.via, "dispatch");
  assert.equal(row.details.reason, "Jake forgot to clock out");
  assert.deepEqual(row.details.fields.Duration_Minutes__c, { from: null, to: 115 });
  assert.equal(w.broadcasts.at(-1).payload.call.status, "Complete");
  assert.ok(w.stale.some((s) => s.ids.includes(id)));

  // The phone's view of the call agrees, and the tech never sees a removed row.
  r = await call(office, "POST", `/service/calls/${id}/clock`, { reason: "double tap", intervals: [{ index: 0, in: "2026-09-14T16:05:00.000Z", out: "2026-09-14T18:00:00.000Z" }, { in: "2026-09-14T19:00:00.000Z", out: "2026-09-14T19:30:00.000Z" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.changes.added, 1);
  assert.equal(w.store.Sundial_Service_Call__c[0].Duration_Minutes__c, 145);
  r = await call(office, "POST", `/service/calls/${id}/clock`, { reason: "never happened", intervals: [{ index: 0, in: "2026-09-14T16:05:00.000Z", out: "2026-09-14T18:00:00.000Z" }] });
  assert.equal(r.body.changes.removed, 1);
  assert.equal(r.body.log.length, 2);
  assert.equal(r.body.log[1].removed.reason, "never happened");
  assert.equal(w.store.Sundial_Service_Call__c[0].Duration_Minutes__c, 115);
  const phone = await call(techH, "GET", `/service/tech/calls/${id}`);
  assert.equal(phone.body.call.intervals.length, 1);
  assert.equal(phone.body.call.clock.minutes, 115);
  // Nothing changed → says so, writes nothing.
  const n = w.calls.updates.length;
  r = await call(office, "POST", `/service/calls/${id}/clock`, { reason: "x", intervals: [{ index: 0, in: "2026-09-14T16:05:00.000Z", out: "2026-09-14T18:00:00.000Z" }] });
  assert.equal(r.body.unchanged, true);
  assert.equal(w.calls.updates.length, n);
  // A completed call cannot be completed again from here; a cancelled one is untouchable.
  assert.equal((await call(office, "POST", `/service/calls/${id}/clock`, { reason: "x", complete: true })).body.code, "CALL_STATE");
  assert.equal((await call(office, "POST", "/service/calls/SC0000000000009999/clock", { reason: "x", intervals: [] })).status, 404);

  // An En Route call whose drive is closed off without an arrival goes back to Scheduled.
  const id2 = "SC0000000000000002";
  const larry = makeHandler(w, { user: { id: "USR000000000000002", firstName: "Larry", lastName: "Ng" }, access: { scope: "tech", level: "Technician", tenantId: TENANT, userId: "USR000000000000002" } });
  w.now = new Date("2026-09-20T15:30:00Z");
  r = await call(larry, "POST", `/service/tech/calls/${id2}/status`, { status: "En Route", eventId: "t2", textCustomer: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  w.now = new Date("2026-09-20T20:00:00Z");
  r = await call(office, "POST", `/service/calls/${id2}/clock`, { reason: "truck broke down, rescheduling", intervals: [{ index: 0, in: "2026-09-20T15:30:00.000Z", out: "2026-09-20T15:50:00.000Z" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(w.store.Sundial_Service_Call__c[1].Status__c, "Scheduled");
  assert.equal(w.store.Sundial_Service_Call__c[1].Actual_End__c, null);
  assert.equal(w.store.Sundial_Service_Call__c[1].Duration_Minutes__c, null);
  // Completing a call with no clocked time at all is sent to the status menu instead.
  r = await call(office, "POST", `/service/calls/${id2}/clock`, { reason: "x", intervals: [], complete: true });
  assert.equal(r.body.code, "NO_CLOCK");
});

// ---------------------------------------------------------------------------
// Every field a tech route SELECTs must exist in the deployed object metadata.
// 2026-09-17: `Job_Type__c` (a price-book field) and `Sent_At__c` (it is
// `Last_Sent_At__c`) were in the jobs / estimates SELECTs; Salesforce refused both
// queries, the Lambda answered 502, and the phone showed "Loading…" forever. The fake
// SOQL in these tests cannot catch a bad column — this reads the repo's own .object
// files instead, so the next typo fails here, not on a phone.
// ---------------------------------------------------------------------------
test("tech SELECTs only name fields that exist in the object metadata", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..", "salesforce");
  const dirs = ["service-objects", "service-delta-2026-09-15"].map((d) => join(root, d, "objects"));
  const fieldsOf = (obj) => {
    const found = new Set();
    for (const d of dirs) {
      const p = join(d, `${obj}.object`);
      if (!existsSync(p)) continue;
      for (const m of readFileSync(p, "utf8").matchAll(/<fullName>([A-Za-z0-9_]+__c)<\/fullName>/g)) found.add(m[1]);
    }
    return found;
  };
  const custom = (select) => select.split(",").map((f) => f.trim()).filter((f) => /^[A-Za-z0-9_]+__c$/.test(f));
  for (const [obj, select] of [
    ["Sundial_Service_Job__c", TECH_JOB_SELECT],
    ["Sundial_Estimate__c", TECH_ESTIMATE_SELECT],
  ]) {
    const have = fieldsOf(obj);
    assert.ok(have.size > 10, `${obj}: metadata not found under salesforce/`);
    const missing = custom(select).filter((f) => !have.has(f));
    assert.deepEqual(missing, [], `${obj}: SELECT names fields the org does not have`);
  }
  // The customer hub predates the service package (its metadata lives in the org, not
  // this folder) — pin the exact list instead, so a change here is a deliberate one.
  assert.equal(TECH_CUSTOMER_SELECT, "Id, Name, First_Name__c, Last_Name__c, Street__c, City__c, State__c, Postal_Code__c, Primary_Email__c, Primary_Phone__c, Requested_Project_Types__c, CreatedDate");
});
