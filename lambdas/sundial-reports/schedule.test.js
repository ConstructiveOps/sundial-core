// node --experimental-test-module-mocks --test lambdas/sundial-reports/schedule.test.js
//
// Scheduled delivery (D-091, Reporting R3). Drives the real handler — schedule.js, deliver.js,
// csv.js, lib/report-schedule.js, lib/report-email.js, lib/access.js, lib/report-def.js — with
// a fake identity, an in-memory Supabase, a fake S3 / presigner / Lambda and a capturing email
// sender. Pinned:
//   - the recipient picker = active Executive / Admin / Manager users of THIS tenant with an
//     email; canAddExternal only for Admin / Executive;
//   - PUT: owner only (404 hidden, 403 read-only); a Manager cannot add an outside address
//     (403 EXTERNAL_RECIPIENT_FORBIDDEN), nor a sales rep / tech / another tenant's user
//     (400 BAD_RECIPIENT); an email that IS an eligible user is stored as that user; an Admin
//     may add an outside address; next_run_at is the next Arizona slot;
//   - recipients are shown to the owner only; the list carries the summary + last run;
//   - send-now toMe: one email to the caller, the CSV attached (BASE64 via lib/email.js), the
//     SES message id on the export's delivery, NOTHING on the report;
//   - send-now to the saved recipients: one email each, last_run_* recorded, next_run_at kept;
//   - the tick: claims a due schedule ONCE even with two ticks racing, advances next_run_at,
//     queues one export owned by the report's owner; delivers as the OWNER (their gates);
//     an owner who is gone / not a tenant user turns it off at once (no email);
//     three failures in a row turn it off and email the owner exactly once; a lost run is
//     recorded; an owner no longer allowed outside addresses stops sending to them;
//   - a file of 8 MB or more goes as one link per recipient; the link stores only a hash, 302s
//     to a 15-minute URL, counts, and answers 429 / 410 / 404; nothing logs the token;
//   - a grouped report draws its first rows in the email body.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { resolveScope, accessBlock } from "../../lib/access.js";

const TENANT = "a1W7y000007AszBEAS";
const OTHER_TENANT = "a1W7y000008UvsHEAS";
const DEALER = "a2D000000000DLRAAA";
const USERS = {
  Admin: { id: "a0U000000000000ADM", accessLevel: "Admin", dealer: null, profile: "a0000000-0000-4000-8000-000000000002", email: "admin@harmon.example", firstName: "Ada", lastName: "Admin" },
  Manager: { id: "a0U000000000000MGR", accessLevel: "Manager", dealer: null, profile: "b0000000-0000-4000-8000-000000000003", email: "mgr@harmon.example", firstName: "Max", lastName: "Manager" },
  Executive: { id: "a0U00000000000EXEC", accessLevel: "Executive", dealer: null, profile: "e0000000-0000-4000-8000-000000000001", email: "exec@harmon.example", firstName: "Eve", lastName: "Exec" },
  "Sales Rep": { id: "a0U000000000000REP", accessLevel: "Sales Rep", dealer: { id: DEALER, active: true, isInternal: false }, profile: "c0000000-0000-4000-8000-000000000005", email: "rep@harmon.example" },
};
const byProfile = Object.fromEntries(Object.entries(USERS).map(([level, u]) => [u.profile, level]));

const ctx = {};
function cacheUser(sf_id, access_level, email, extra = {}) {
  return { sf_id, client_sf_id: TENANT, first_name: access_level, last_name: "User", name: `${access_level} User`, email, active: true, access_level, isdeleted: false, ...extra };
}
function reset(level = "Admin") {
  ctx.level = level;
  ctx.ownerOverride = {}; // profile → "gone" | "inactive" | "otherTenant" | level
  ctx.rpcCalls = [];
  ctx.rpcPages = { rows: [["A", "Mesa"], ["B", "Tempe"]] };
  ctx.tables = {
    cache_sync_runs: [],
    sundial_reports: [],
    sundial_report_exports: [],
    sundial_report_downloads: [],
    profiles: [],
    sundial_user_cache: [
      cacheUser(USERS.Admin.id, "Admin", "Admin@Harmon.example"),
      cacheUser(USERS.Manager.id, "Manager", "mgr@harmon.example"),
      cacheUser(USERS.Executive.id, "Executive", "exec@harmon.example"),
      cacheUser(USERS["Sales Rep"].id, "Sales Rep", "rep@harmon.example"),
      cacheUser("a0U000000000000TEC", "Technician", "tech@harmon.example"),
      cacheUser("a0U00000000000GONE", "Manager", "gone@harmon.example", { active: false }),
      cacheUser("a0U000000000NOMAIL", "Manager", null),
      cacheUser("a0U00000000000OTHR", "Admin", "other@else.example", { client_sf_id: OTHER_TENANT }),
    ],
  };
  ctx.s3 = [];
  ctx.objects = new Map();
  ctx.invokes = [];
  ctx.sent = [];
  ctx.sendFails = false;
  ctx.logs = [];
}

function identityOf(level, tenant = TENANT) {
  const user = USERS[level];
  return { tenantId: tenant, tenantSlug: "harmon", authUserId: user.profile, user, access: accessBlock(resolveScope(user, tenant)) };
}

mock.module("../../lib/identity.js", {
  namedExports: {
    resolveIdentity: async () => identityOf(ctx.level),
    resolveIdentityForProfile: async (profileId) => {
      const o = ctx.ownerOverride[profileId];
      if (o === "gone") throw Object.assign(new Error("no user"), { code: "NO_SUNDIAL_USER" });
      if (o === "inactive") throw Object.assign(new Error("inactive"), { code: "USER_INACTIVE" });
      if (o === "down") throw new Error("Salesforce is down");
      if (o === "otherTenant") return identityOf(byProfile[profileId], OTHER_TENANT);
      if (o) return { ...identityOf(o), authUserId: profileId };
      return identityOf(byProfile[profileId]);
    },
  },
});
mock.module("../../lib/secrets.js", {
  namedExports: { getSecret: async () => ({}), clearSecretCache: () => {}, SECRET_TIMEOUT_MS: 10_000 },
});
mock.module("../../lib/email.js", {
  namedExports: {
    isEmailConfigured: () => true,
    sendEmail: async (msg) => {
      ctx.sent.push(msg);
      return ctx.sendFails ? { ok: false, error: "boom" } : { ok: true, messageId: `msg-${ctx.sent.length}` };
    },
  },
});

// --- in-memory PostgREST ---------------------------------------------------------------------
function valueOf(r, c) {
  if (c.includes("->>")) {
    const [col, key] = c.split("->>");
    const v = r[col]?.[key];
    return v === undefined || v === null ? null : String(v);
  }
  return r[c];
}
function builder(name) {
  const st = { op: "select", filters: [], single: null, order: null, limit: null };
  const b = {
    select() { return b; },
    insert(rows) { st.op = "insert"; st.rows = Array.isArray(rows) ? rows : [rows]; return b; },
    update(patch) { st.op = "update"; st.patch = patch; return b; },
    delete() { st.op = "delete"; return b; },
    eq(c, v) { st.filters.push((r) => valueOf(r, c) === v); return b; },
    in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return b; },
    lt(c, v) { st.filters.push((r) => r[c] !== null && r[c] !== undefined && r[c] < v); return b; },
    lte(c, v) { st.filters.push((r) => r[c] !== null && r[c] !== undefined && r[c] <= v); return b; },
    not(c) { st.filters.push((r) => r[c] !== null && r[c] !== undefined); return b; },
    order(c, { ascending = true } = {}) { st.order = [c, ascending]; return b; },
    limit(n) { st.limit = n; return b; },
    single() { st.single = "one"; return b; },
    maybeSingle() { st.single = "maybe"; return b; },
    then(resolve, reject) { return Promise.resolve().then(exec).then(resolve, reject); },
  };
  function exec() {
    const rows = (ctx.tables[name] ??= []);
    let out;
    if (st.op === "insert") {
      out = st.rows.map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...r }));
      rows.push(...out);
    } else {
      const hit = rows.filter((r) => st.filters.every((f) => f(r)));
      if (st.op === "update") { hit.forEach((r) => Object.assign(r, structuredClone(st.patch))); out = hit; }
      else if (st.op === "delete") { for (const r of hit) rows.splice(rows.indexOf(r), 1); out = hit; }
      else {
        out = [...hit];
        if (st.order) { const [c, asc] = st.order; out.sort((x, y) => (x[c] < y[c] ? -1 : x[c] > y[c] ? 1 : 0) * (asc ? 1 : -1)); }
        if (st.limit) out = out.slice(0, st.limit);
      }
    }
    out = structuredClone(out);
    if (st.single === "one") return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: "not one row" } };
    if (st.single === "maybe") return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }
  return b;
}
mock.module("../../lib/supabase.js", {
  namedExports: {
    getSupabaseClient: async () => ({
      rpc: async (name, args) => {
        ctx.rpcCalls.push({ name, args: structuredClone(args) });
        const off = args.p_def.offset ?? 0;
        const all = ctx.rpcPages.rows;
        return { data: { rows: all.slice(off, off + args.p_def.limit), aggregates: {}, truncated: off + args.p_def.limit < all.length }, error: ctx.rpcPages.error ?? null };
      },
      from: (t) => builder(t),
    }),
  },
});

const cmd = (kind) => class { constructor(input) { this.kind = kind; this.input = input; } };
mock.module("@aws-sdk/client-s3", {
  namedExports: {
    S3Client: class {
      async send(c) {
        ctx.s3.push({ kind: c.kind, input: c.input });
        if (c.kind === "PutObject") ctx.objects.set(c.input.Key, Buffer.from(c.input.Body));
        if (c.kind === "GetObject") {
          const b = ctx.objects.get(c.input.Key) ?? Buffer.alloc(0);
          return { Body: { transformToByteArray: async () => new Uint8Array(b) } };
        }
        if (c.kind === "CreateMultipartUpload") return { UploadId: "up-1" };
        if (c.kind === "UploadPart") return { ETag: `etag-${c.input.PartNumber}` };
        return {};
      }
    },
    PutObjectCommand: cmd("PutObject"),
    CreateMultipartUploadCommand: cmd("CreateMultipartUpload"),
    UploadPartCommand: cmd("UploadPart"),
    CompleteMultipartUploadCommand: cmd("CompleteMultipartUpload"),
    AbortMultipartUploadCommand: cmd("AbortMultipartUpload"),
    GetObjectCommand: cmd("GetObject"),
  },
});
mock.module("@aws-sdk/s3-request-presigner", {
  namedExports: { getSignedUrl: async (_c, command, { expiresIn }) => `https://signed.example/${command.input.Key}?ttl=${expiresIn}` },
});
mock.module("@aws-sdk/client-lambda", {
  namedExports: {
    LambdaClient: class {
      async send(c) {
        ctx.invokes.push(JSON.parse(Buffer.from(c.input.Payload).toString("utf8")));
        return { StatusCode: 202 };
      }
    },
    InvokeCommand: cmd("Invoke"),
  },
});

process.env.AWS_LAMBDA_FUNCTION_NAME = "sundial-reports";
const { handler, matchRoute, matchPublicDownload } = await import("./index.js");
const { nextRunAt } = await import("../../lib/report-schedule.js");

const ev = (path, { method = "GET", body } = {}) => ({
  httpMethod: method, path, headers: { Origin: "http://localhost:5173", Authorization: "Bearer x" },
  queryStringParameters: null, body: body === undefined ? null : JSON.stringify(body),
});
const call = async (path, opts) => {
  const res = await handler(ev(path, opts));
  return { status: res.statusCode, body: res.body && res.headers?.["Content-Type"] !== "text/html; charset=utf-8" ? JSON.parse(res.body) : res.body, headers: res.headers };
};
const worker = (exportId) => handler({ task: "csv", exportId }, { getRemainingTimeInMillis: () => 290_000 });
const tick = () => handler({ task: "tick" });
const lastExport = () => ctx.tables.sundial_report_exports.at(-1);
const reportRow = (id) => ctx.tables.sundial_reports.find((r) => r.id === id);

const SIMPLE = { type: "customers", columns: ["customer.name", "customer.city"] };
const GROUPED = { type: "solar", groupBy: [{ field: "solar.contract_date", dateTrunc: "month" }], aggregates: [{ fn: "count" }] };
const DAILY = (recipients, extra = {}) => ({ cadence: "daily", time: "07:00", recipients, ...extra });

async function saveReport(level, def = SIMPLE, sharing = "private") {
  ctx.level = level;
  const r = await call("/reports", { method: "POST", body: { name: "ZZ Daily customers", definition: def, sharing } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}
/** Capture console output during fn (to prove nothing logs a token or an address). */
async function captureLogs(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  try { return { result: await fn(), lines }; } finally { Object.assign(console, orig); }
}

// =========================================================================================
test("routes: recipients / schedule / send-now / the public download", () => {
  assert.equal(matchRoute("/reports/recipients").name, "recipients");
  assert.deepEqual(matchRoute("/reports/abc/schedule"), { name: "schedule", methods: ["GET", "PUT", "DELETE"], id: "abc" });
  assert.deepEqual(matchRoute("/prod/reports/abc/send-now"), { name: "sendNow", methods: ["POST"], id: "abc" });
  assert.equal(matchPublicDownload("/public/reports/download/tok"), "tok");
  assert.equal(matchPublicDownload("/prod/public/reports/download/tok"), "tok");
  assert.equal(matchPublicDownload("/reports/download/tok"), null);
});

test("recipients: active Executive / Admin / Manager users of this tenant with an email; outside addresses only for Admin / Executive", async () => {
  reset("Admin");
  let r = await call("/reports/recipients");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.users.map((u) => u.userId).sort(), [USERS.Admin.id, USERS.Executive.id, USERS.Manager.id].sort());
  assert.equal(r.body.users.find((u) => u.userId === USERS.Admin.id).email, "admin@harmon.example", "lower-cased");
  assert.equal(r.body.canAddExternal, true);
  assert.equal(r.body.maxRecipients, 25);
  ctx.level = "Manager";
  r = await call("/reports/recipients");
  assert.equal(r.body.canAddExternal, false);
  ctx.level = "Sales Rep";
  assert.equal((await call("/reports/recipients")).status, 403);
});

test("PUT schedule: a Manager cannot add an outside address or a non-office user; an eligible user's email becomes that user", async () => {
  reset();
  const id = await saveReport("Manager");
  let r = await call(`/reports/${id}/schedule`, { method: "PUT", body: DAILY([{ email: "someone@example.com" }]) });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "EXTERNAL_RECIPIENT_FORBIDDEN");
  // A sales rep's address is OUTSIDE too (Tim, 2026-11-10).
  r = await call(`/reports/${id}/schedule`, { method: "PUT", body: DAILY([{ email: "rep@harmon.example" }]) });
  assert.equal(r.body.code, "EXTERNAL_RECIPIENT_FORBIDDEN");
  for (const userId of [USERS["Sales Rep"].id, "a0U000000000000TEC", "a0U00000000000GONE", "a0U00000000000OTHR", "a0U000000000NOMAIL"]) {
    r = await call(`/reports/${id}/schedule`, { method: "PUT", body: DAILY([{ userId: USERS.Admin.id }, { userId }]) });
    assert.equal(r.status, 400, userId);
    assert.equal(r.body.code, "BAD_RECIPIENT");
    assert.equal(r.body.field, "recipients[1]");
  }
  assert.equal(reportRow(id).schedule ?? null, null, "nothing saved");
  r = await call(`/reports/${id}/schedule`, { method: "PUT", body: DAILY([{ email: "ADMIN@harmon.example" }, { userId: USERS.Manager.id }]) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(reportRow(id).schedule.recipients, [{ userId: USERS.Admin.id }, { userId: USERS.Manager.id }]);
});

test("PUT schedule: an Admin may add an outside address; next_run_at is the next 7:00 AM Arizona; validation is a 400 naming the field", async () => {
  reset();
  const id = await saveReport("Admin");
  const before = Date.now();
  let r = await call(`/reports/${id}/schedule`, { method: "PUT", body: { cadence: "weekly", days: ["fri", "mon"], time: "07:00", recipients: [{ userId: USERS.Admin.id }, { email: "Partner@Example.com" }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = reportRow(id).schedule;
  assert.deepEqual(s.days, ["mon", "fri"]);
  assert.deepEqual(s.recipients, [{ userId: USERS.Admin.id }, { email: "partner@example.com" }]);
  assert.equal(s.enabled, true);
  assert.equal(s.format, "csv");
  const next = new Date(reportRow(id).next_run_at);
  assert.ok(next.getTime() > before);
  assert.equal(next.getUTCHours(), 14, "07:00 in Arizona is 14:00 UTC, all year");
  assert.ok([1, 5].includes(next.getUTCDay()));
  assert.equal(r.body.schedule.summary, "Weekly on Mon, Fri at 7:00 AM (Arizona time)");
  assert.equal(r.body.schedule.recipients[1].external, true);

  for (const [body, field] of [
    [{ cadence: "hourly", time: "07:00", recipients: [{ userId: USERS.Admin.id }] }, "cadence"],
    [DAILY([{ userId: USERS.Admin.id }], { time: "07:10" }), "time"],
    [{ cadence: "weekly", time: "07:00", recipients: [{ userId: USERS.Admin.id }] }, "days"],
    [{ cadence: "monthly", dayOfMonth: 32, time: "07:00", recipients: [{ userId: USERS.Admin.id }] }, "dayOfMonth"],
    [DAILY([]), "recipients"],
    [DAILY(Array.from({ length: 26 }, (_, i) => ({ email: `p${i}@example.com` }))), "recipients"],
    [DAILY([{ userId: USERS.Admin.id }], { format: "pdf" }), "format"],
    [DAILY([{ userId: USERS.Admin.id }], { cron: "* * *" }), "cron"],
  ]) {
    r = await call(`/reports/${id}/schedule`, { method: "PUT", body });
    assert.equal(r.status, 400, field);
    assert.equal(r.body.field, field);
  }
});

test("schedule: owner only — someone else's private report is 404, a shared one 403 read-only; recipients shown to the owner only", async () => {
  reset();
  const id = await saveReport("Admin", SIMPLE, "tenant");
  await call(`/reports/${id}/schedule`, { method: "PUT", body: DAILY([{ userId: USERS.Admin.id }, { userId: USERS.Manager.id }]) });
  ctx.level = "Manager";
  let r = await call(`/reports/${id}/schedule`, { method: "PUT", body: DAILY([{ userId: USERS.Manager.id }]) });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "REPORT_READ_ONLY");
  assert.equal((await call(`/reports/${id}/schedule`, { method: "DELETE" })).status, 403);
  assert.equal((await call(`/reports/${id}/send-now`, { method: "POST" })).status, 403);
  r = await call(`/reports/${id}/schedule`);
  assert.equal(r.status, 200);
  assert.equal(r.body.schedule.recipientCount, 2);
  assert.equal(r.body.schedule.recipients, undefined, "a viewer is not told who it goes to");
  const list = await call("/reports");
  const mine = list.body.reports.find((x) => x.id === id);
  assert.equal(mine.schedule.summary, "Daily at 7:00 AM (Arizona time)");
  assert.equal(mine.schedule.recipients, undefined);
  ctx.level = "Admin";
  r = await call(`/reports/${id}/schedule`);
  assert.deepEqual(r.body.schedule.recipients.map((x) => x.userId), [USERS.Admin.id, USERS.Manager.id]);

  const priv = await saveReport("Admin");
  ctx.level = "Manager";
  assert.equal((await call(`/reports/${priv}/schedule`)).status, 404);
  assert.equal((await call(`/reports/${priv}/schedule`, { method: "PUT", body: DAILY([{ userId: USERS.Manager.id }]) })).status, 404);
});

test("DELETE schedule: gone, next_run_at cleared, the last run kept", async () => {
  reset();
  const id = await saveReport("Admin");
  await call(`/reports/${id}/schedule`, { method: "PUT", body: DAILY([{ userId: USERS.Admin.id }]) });
  reportRow(id).last_run_at = "2026-11-09T14:00:00.000Z";
  assert.equal((await call(`/reports/${id}/schedule`, { method: "DELETE" })).status, 204);
  assert.equal(reportRow(id).schedule, null);
  assert.equal(reportRow(id).next_run_at, null);
  assert.equal(reportRow(id).last_run_at, "2026-11-09T14:00:00.000Z");
  assert.equal((await call(`/reports/${id}/schedule`)).body.schedule, null);
});

test("send-now toMe: one email to the caller, the CSV attached, the SES id recorded on the export — nothing on the report", async () => {
  reset();
  const id = await saveReport("Admin");
  const r = await call(`/reports/${id}/send-now`, { method: "POST", body: { toMe: true } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.recipients, 1);
  assert.deepEqual(ctx.invokes, [{ task: "csv", exportId: r.body.exportId }]);
  const ex = lastExport();
  assert.equal(ex.owner_profile_id, USERS.Admin.profile);
  assert.equal(ex.report_id, id);
  assert.equal(ex.job.delivery.kind, "to_me");
  await worker(r.body.exportId);
  assert.equal(ctx.sent.length, 1);
  const m = ctx.sent[0];
  assert.equal(m.to, "admin@harmon.example");
  assert.match(m.subject, /^ZZ Daily customers — [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  assert.equal(m.replyTo, "admin@harmon.example", "replies go to the owner");
  assert.equal(m.attachments.length, 1);
  assert.match(m.attachments[0].fileName, /^customers-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.ok(Buffer.from(m.attachments[0].content).toString("utf8").startsWith("﻿Customer: "), "the CSV itself");
  assert.equal(lastExport().delivery.status, "sent");
  assert.deepEqual(lastExport().delivery.results, [{ i: 0, ok: true, messageId: "msg-1", error: null }]);
  const rep = reportRow(id);
  assert.equal(rep.last_run_status ?? null, null);
  assert.equal(rep.last_run_at ?? null, null);
});

test("send-now to the saved recipients: one email each, last_run_* recorded, next_run_at untouched; a recipient no longer eligible is skipped", async () => {
  reset();
  const id = await saveReport("Admin");
  await call(`/reports/${id}/schedule`, { method: "PUT", body: DAILY([{ userId: USERS.Admin.id }, { userId: USERS.Manager.id }, { userId: USERS.Executive.id }, { email: "partner@example.com" }]) });
  const next = reportRow(id).next_run_at;
  ctx.tables.sundial_user_cache.find((u) => u.sf_id === USERS.Executive.id).active = false; // left since
  const r = await call(`/reports/${id}/send-now`, { method: "POST" });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.recipients, 3);
  assert.equal(r.body.skipped, 1);
  assert.equal(reportRow(id).last_run_status, "running");
  assert.equal(reportRow(id).last_export_id, r.body.exportId, "stamped before the worker could start");
  await worker(r.body.exportId);
  assert.deepEqual(ctx.sent.map((m) => m.to), ["admin@harmon.example", "mgr@harmon.example", "partner@example.com"]);
  assert.equal(reportRow(id).last_run_status, "ok");
  assert.equal(reportRow(id).consecutive_failures, 0);
  assert.equal(reportRow(id).next_run_at, next);
  // Nothing to send to: a 400, nothing queued.
  const lone = await saveReport("Admin");
  assert.equal((await call(`/reports/${lone}/send-now`, { method: "POST" })).body.code, "NO_SCHEDULE");
  assert.equal((await call(`/reports/${lone}/send-now`, { method: "POST", body: { toMe: "yes" } })).status, 400);
});

test("tick: two ticks racing claim a due schedule ONCE; next_run_at moves to the next slot; the export is the owner's", async () => {
  reset();
  const id = await saveReport("Admin");
  await call(`/reports/${id}/schedule`, { method: "PUT", body: DAILY([{ userId: USERS.Admin.id }, { userId: USERS.Manager.id }]) });
  reportRow(id).next_run_at = "2026-01-01T14:00:00.000Z"; // long overdue: one send, not a burst
  ctx.invokes = [];
  const exportsBefore = ctx.tables.sundial_report_exports.length;
  const [a, b] = await Promise.all([tick(), tick()]);
  assert.equal(a.claimed + b.claimed, 1, "exactly one tick won the claim");
  assert.equal(ctx.tables.sundial_report_exports.length, exportsBefore + 1);
  assert.equal(ctx.invokes.length, 1);
  const row = reportRow(id);
  assert.ok(Date.parse(row.next_run_at) > Date.now(), "advanced past now");
  assert.equal(row.next_run_at, nextRunAt(row.schedule, new Date(Date.parse(row.last_run_at))).toISOString());
  assert.equal(row.last_run_status, "running");
  assert.equal(row.last_export_id, lastExport().id);
  assert.equal(lastExport().owner_profile_id, USERS.Admin.profile);
  assert.equal(lastExport().job.delivery.kind, "schedule");
  const again = await tick();
  assert.equal(again.claimed, 0, "not due any more");
  await worker(lastExport().id);
  assert.equal(ctx.sent.length, 2);
  assert.equal(reportRow(id).last_run_status, "ok");
});

test("tick: the report runs as its OWNER — their gates; a disabled schedule or one not yet due is left alone", async () => {
  reset();
  const COST = { type: "estimate_lines", columns: ["line.name", "line.unit_labor_cost"] };
  const id = await saveReport("Admin", COST);
  await call(`/reports/${id}/schedule`, { method: "PUT", body: DAILY([{ userId: USERS.Manager.id }]) });
  reportRow(id).next_run_at = new Date(Date.now() - 60_000).toISOString();
  await tick();
  const cols = lastExport().job.wire.columns.map((c) => c.column);
  assert.ok(cols.includes("unit_labor_cost"), "the Admin's cost column is in the Manager's file");
  assert.deepEqual(lastExport().job.wire.allowedGates, ["service.costing.read"]);

  const off = await saveReport("Admin");
  await call(`/reports/${off}/schedule`, { method: "PUT", body: DAILY([{ userId: USERS.Admin.id }], { enabled: false }) });
  reportRow(off).next_run_at = new Date(Date.now() - 60_000).toISOString();
  const later = await saveReport("Admin");
  await call(`/reports/${later}/schedule`, { method: "PUT", body: DAILY([{ userId: USERS.Admin.id }]) });
  const t = await tick();
  assert.equal(t.due, 0);
});

test("tick: an owner who is gone, inactive, in another tenant or no longer office turns the schedule off at once — no email", async () => {
  for (const what of ["gone", "inactive", "otherTenant", "Sales Rep"]) {
    reset();
    const id = await saveReport("Admin");
    await call(`/reports/${id}/schedule`, { method: "PUT", body: DAILY([{ userId: USERS.Admin.id }]) });
    reportRow(id).next_run_at = new Date(Date.now() - 60_000).toISOString();
    ctx.ownerOverride[USERS.Admin.profile] = what;
    ctx.invokes = [];
    const t = await tick();
    assert.equal(t.failed, 1, what);
    const row = reportRow(id);
    assert.equal(row.last_run_status, "disabled", what);
    assert.equal(row.last_run_error, "OWNER_NOT_ALLOWED");
    assert.equal(row.schedule.enabled, false);
    assert.equal(ctx.invokes.length, 0, "nothing queued");
    assert.equal(ctx.sent.length, 0, "no email");
  }
});

test("tick: three failures in a row turn the schedule off and email the owner exactly once; a success resets the count", async () => {
  reset();
  const id = await saveReport("Admin");
  await call(`/reports/${id}/schedule`, { method: "PUT", body: DAILY([{ userId: USERS.Admin.id }]) });
  ctx.sendFails = true;
  const due = () => { reportRow(id).next_run_at = new Date(Date.now() - 60_000).toISOString(); };

  due(); await tick(); await worker(lastExport().id);
  assert.equal(reportRow(id).last_run_status, "failed");
  assert.equal(reportRow(id).consecutive_failures, 1);
  ctx.sendFails = false;
  due(); await tick(); await worker(lastExport().id);
  assert.equal(reportRow(id).consecutive_failures, 0, "a success resets it");
  ctx.sendFails = true;
  due(); await tick(); await worker(lastExport().id);
  due(); await tick(); await worker(lastExport().id);
  assert.equal(reportRow(id).consecutive_failures, 2);
  assert.equal(reportRow(id).schedule.enabled, true);
  ctx.sendFails = false; // the owner's notice must be able to go out
  ctx.rpcPages = { rows: [], error: { message: "sundial_report_run: unknown column customer.city" } };
  ctx.sent = [];
  due(); await tick(); await worker(lastExport().id);
  const row = reportRow(id);
  assert.equal(row.consecutive_failures, 3);
  assert.equal(row.last_run_status, "disabled");
  assert.equal(row.last_run_error, "REPORT_CATALOG_MISMATCH");
  assert.equal(row.schedule.enabled, false);
  assert.equal(ctx.sent.length, 1, "the owner's notice, once");
  assert.equal(ctx.sent[0].to, "admin@harmon.example");
  assert.match(ctx.sent[0].subject, /^Scheduled report turned off: ZZ Daily customers$/);
  assert.match(ctx.sent[0].text, /3 failed deliveries in a row/);
  // Disabled: the tick never picks it up again, so there is never a second notice.
  due();
  assert.equal((await tick()).due, 0);
  // PUT turns it back on with a clean count.
  ctx.rpcPages = { rows: [["A", "Mesa"]] };
  await call(`/reports/${id}/schedule`, { method: "PUT", body: DAILY([{ userId: USERS.Admin.id }]) });
  assert.equal(reportRow(id).consecutive_failures, 0);
  assert.equal(reportRow(id).last_run_status, null);
});

test("tick: an owner no longer allowed outside addresses stops sending to them; a delivery lost mid-way is recorded", async () => {
  reset();
  const id = await saveReport("Admin");
  await call(`/reports/${id}/schedule`, { method: "PUT", body: DAILY([{ userId: USERS.Admin.id }, { email: "partner@example.com" }]) });
  ctx.ownerOverride[USERS.Admin.profile] = "Manager"; // demoted since
  reportRow(id).next_run_at = new Date(Date.now() - 60_000).toISOString();
  await tick();
  assert.deepEqual(lastExport().job.delivery.to, [{ email: "admin@harmon.example", external: false }]);
  assert.equal(lastExport().job.delivery.skipped, 1);

  // The worker never reports back: 15 minutes on, the tick records it lost.
  reportRow(id).last_run_at = new Date(Date.now() - 16 * 60_000).toISOString();
  const t = await tick();
  assert.equal(t.lost, 1);
  assert.equal(reportRow(id).last_run_status, "failed");
  assert.equal(reportRow(id).last_run_error, "DELIVERY_LOST");
  assert.equal(reportRow(id).consecutive_failures, 1);
});

test("8 MB or more: one link per recipient; only the hash is stored; the link 302s, counts, then 429 / 410 / 404; nothing logs the token", async () => {
  reset();
  const id = await saveReport("Admin");
  await call(`/reports/${id}/schedule`, { method: "PUT", body: DAILY([{ userId: USERS.Admin.id }, { userId: USERS.Manager.id }]) });
  const big = Array.from({ length: 9000 }, (_, i) => [`Customer ${i} ${"x".repeat(1000)}`, "Mesa"]);
  ctx.rpcPages = { rows: big };
  const q = await call(`/reports/${id}/send-now`, { method: "POST" });
  const { lines } = await captureLogs(() => worker(q.body.exportId));
  assert.equal(ctx.sent.length, 2);
  assert.equal(ctx.sent[0].attachments, undefined, "not attached");
  const links = ctx.sent.map((m) => /https:\/\/[^\s]+\/public\/reports\/download\/([A-Za-z0-9_-]{43})/.exec(m.text)?.[1]);
  assert.ok(links.every(Boolean));
  assert.notEqual(links[0], links[1], "one link each");
  assert.equal(lastExport().delivery.attached, false);
  const rows = ctx.tables.sundial_report_downloads;
  assert.equal(rows.length, 2);
  const sha = (t) => createHash("sha256").update(t).digest("hex");
  assert.deepEqual(rows.map((r) => r.token_hash).sort(), links.map(sha).sort());
  assert.ok(!JSON.stringify(rows).includes(links[0]), "the token itself is never stored");
  assert.ok(Math.abs(Date.parse(rows[0].expires_at) - (Date.now() + 7 * 24 * 3600_000)) < 60_000);
  assert.match(ctx.sent[0].html, /Download the report \(CSV\)/);
  assert.ok(!lines.some((l) => links.some((t) => l.includes(t)) || l.includes("@harmon.example")), "no token or address in a log");

  const out = await captureLogs(() => handler({ httpMethod: "GET", path: `/prod/public/reports/download/${links[0]}`, headers: {} }));
  const res = out.result;
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.Location, /^https:\/\/signed\.example\/REPORTS\/.+\.csv\?ttl=900$/);
  assert.ok(out.lines.some((l) => l.includes(sha(links[0]).slice(0, 12))), "logged by hash prefix");
  assert.ok(!out.lines.some((l) => l.includes(links[0])), "never the token");
  assert.equal(rows.find((r) => r.token_hash === sha(links[0])).download_count, 1);

  rows.find((r) => r.token_hash === sha(links[0])).download_count = 20;
  assert.equal((await handler({ httpMethod: "GET", path: `/public/reports/download/${links[0]}`, headers: {} })).statusCode, 429);
  rows.find((r) => r.token_hash === sha(links[1])).expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await handler({ httpMethod: "GET", path: `/public/reports/download/${links[1]}`, headers: {} })).statusCode, 410);
  assert.equal((await handler({ httpMethod: "GET", path: `/public/reports/download/${"A".repeat(43)}`, headers: {} })).statusCode, 404);
  assert.equal((await handler({ httpMethod: "GET", path: "/public/reports/download/short", headers: {} })).statusCode, 404);
  assert.equal((await handler({ httpMethod: "POST", path: `/public/reports/download/${links[0]}`, headers: {} })).statusCode, 405);
});

test("a grouped report draws its first rows in the email body (the on-screen wire, capped at 100)", async () => {
  reset();
  const id = await saveReport("Admin", GROUPED);
  ctx.rpcPages = { rows: [["2026-10-01", 3], ["2026-11-01", 5]] };
  const q = await call(`/reports/${id}/send-now`, { method: "POST", body: { toMe: true } });
  await worker(q.body.exportId);
  const body = ctx.rpcCalls.find((c) => c.args.p_def.limit === 100);
  assert.ok(body, "the body table's run");
  assert.equal(body.args.p_def.grouped, true);
  assert.equal(body.args.p_def.totals, false);
  const html = ctx.sent[0].html;
  assert.match(html, /<table/);
  assert.match(html, /Oct 1, 2026/);
  assert.match(html, /Count/);
  assert.equal(ctx.sent[0].attachments.length, 1);
});

test("GET /reports/csv/{exportId} carries a delivery's progress — counts only, never an address", async () => {
  reset();
  const id = await saveReport("Admin");
  const q = await call(`/reports/${id}/send-now`, { method: "POST", body: { toMe: true } });
  let s = await call(`/reports/csv/${q.body.exportId}`);
  assert.deepEqual(s.body.delivery, { status: "pending" });
  await worker(q.body.exportId);
  s = await call(`/reports/csv/${q.body.exportId}`);
  assert.deepEqual(s.body.delivery, { status: "sent", sent: 1, failed: 0, skipped: 0, attached: true, code: null });
  assert.ok(!JSON.stringify(s.body).includes("@harmon.example"));
  // A plain export has no delivery block.
  const plain = await call("/reports/csv", { method: "POST", body: SIMPLE });
  assert.equal((await call(`/reports/csv/${plain.body.exportId}`)).body.delivery, undefined);
});
