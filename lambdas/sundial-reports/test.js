// node --experimental-test-module-mocks --test lambdas/sundial-reports/test.js
//
// Drives the real handler with a fake identity, an in-memory Supabase, a fake S3 and a fake
// Lambda client; lib/access.js, lib/report-def.js, lib/report-types.js, lib/saved-reports.js,
// lib/report-csv.js and the GENERATED catalog run unmocked.
//
// Pinned (R1a):
//   - routes and methods (OPTIONS 204, wrong method 405, unknown 404, stage prefix tolerated);
//   - reports.read: Executive / Admin / Manager in; Sales Rep, Sales Dealer, Technician and a
//     no-dealer rep get 403 MODULE_FORBIDDEN on EVERY route, before any database call;
//     no tenant = 403 NO_TENANT; identity errors map as everywhere else;
//   - run: the tenant from the identity (never the body), the wire definition to the rpc, a 400
//     never reaches the rpc, gates per caller; the response shape; asOf; RAISE → 500
//     REPORT_CATALOG_MISMATCH; catalog projected per caller.
// Pinned (R1b, D-089):
//   - CSV: POST validates in CSV mode, writes a queued export row OWNED by the caller and
//     invokes this Lambda with { task: "csv", exportId } — nothing else; a bad definition never
//     queues; a failed invoke marks the row failed (502);
//   - the worker claims the row once (a second invoke is a no-op), pages the rpc with offset /
//     totals:false until not truncated, stops at rowLimit (truncated), writes ONE object under
//     REPORTS/<tenant>/<date>/<id>.csv (BOM + header first), multipart past 8 MB, marks done;
//     an rpc RAISE fails it REPORT_CATALOG_MISMATCH, a short clock CSV_TOO_SLOW (multipart
//     aborted);
//   - status: the owner gets a 15-minute presigned GET of that key; another user, another
//     tenant, a bad id → 404 RECORD_NOT_FOUND; a stuck row reads CSV_EXPORT_LOST;
//   - saved reports: a Manager's private report is invisible (404 on read / edit / delete /
//     run / csv) to an Admin until the Manager shares it through the API (Managers share —
//     D-089) and visible after; the owner can unshare; a report someone else owns is
//     read-only to everyone, Admins included (403 REPORT_READ_ONLY — managing others' reports
//     is R2's reports.admin); the owner is the JWT's, never the body's;
//     a saved report runs with the RUNNER's gates; the list is mine + shared, newest first.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { randomUUID } from "node:crypto";
import { resolveScope, accessBlock } from "../../lib/access.js";

const TENANT = "a1W7y000007AszBEAS";
const OTHER_TENANT = "a1W7y000008UvsHEAS";
const DEALER = "a2D000000000DLRAAA";
const USERS = {
  Executive: { id: "a0U0000000000EXEC", accessLevel: "Executive", dealer: null, profile: "e0000000-0000-4000-8000-000000000001" },
  Admin: { id: "a0U00000000000ADM", accessLevel: "Admin", dealer: null, profile: "a0000000-0000-4000-8000-000000000002" },
  Manager: { id: "a0U00000000000MGR", accessLevel: "Manager", dealer: null, profile: "b0000000-0000-4000-8000-000000000003" },
  Manager2: { id: "a0U0000000000MGR2", accessLevel: "Manager", dealer: null, profile: "b0000000-0000-4000-8000-000000000004" },
  "Sales Rep": { id: "a0U00000000000REP", accessLevel: "Sales Rep", dealer: { id: DEALER, active: true, isInternal: false }, profile: "c0000000-0000-4000-8000-000000000005" },
  "Sales Dealer": { id: "a0U00000000000DLR", accessLevel: "Sales Dealer", dealer: { id: DEALER, active: true, isInternal: false }, profile: "c0000000-0000-4000-8000-000000000006" },
  Technician: { id: "a0U00000000000TEC", accessLevel: "Technician", dealer: null, profile: "c0000000-0000-4000-8000-000000000007" },
  NoDealerRep: { id: "a0U00000000000NDR", accessLevel: "Sales Rep", dealer: null, profile: "c0000000-0000-4000-8000-000000000008" },
};

const ctx = {};
function reset(level = "Admin") {
  ctx.level = level;
  ctx.describe = null; // the live picklist overlay (D-089 am. 2): null = the describe fails → the JSON values
  ctx.tenant = TENANT;
  ctx.slug = "harmon";
  ctx.secretReads = 0;
  ctx.identityError = null;
  ctx.rpcCalls = [];
  ctx.rpcResult = { data: { rows: [["A", 1]], aggregates: { count: 7 }, truncated: false }, error: null };
  ctx.rpcPages = null; // when set: the rpc answers from these pages by offset
  ctx.tables = {
    cache_sync_runs: [
      { object: "solar", ok: true, finished_at: "2026-11-03T17:05:00Z" },
      { object: "customer", ok: true, finished_at: "2026-11-03T17:04:00Z" },
      { object: "solar", ok: true, finished_at: "2026-11-03T17:00:00Z" },
      { object: "user", ok: true, finished_at: "2026-11-03T16:45:00Z" },
      { object: "dealer", ok: true, finished_at: "2026-11-03T16:50:00Z" },
    ],
    sundial_reports: [],
    sundial_report_exports: [],
    profiles: [],
  };
  ctx.failTables = new Set(); // a table named here answers every read with an error
  ctx.dbCalls = [];
  ctx.s3 = [];
  ctx.invokes = [];
  ctx.invokeFails = false;
}
const as = (level) => { ctx.level = level; };

mock.module("../../lib/identity.js", {
  namedExports: {
    // D-091: the scheduled delivery resolves the OWNER by profile id (schedule.test.js drives it).
    resolveIdentityForProfile: async () => {
      throw Object.assign(new Error("not used here"), { code: "NO_SUNDIAL_USER" });
    },
    resolveIdentity: async () => {
      if (ctx.identityError) {
        const e = new Error("nope");
        e.code = ctx.identityError;
        throw e;
      }
      const user = USERS[ctx.level];
      return { tenantId: ctx.tenant, tenantSlug: ctx.slug ?? "harmon", authUserId: user.profile, user, access: accessBlock(resolveScope(user, ctx.tenant)) };
    },
  },
});

// Secrets Manager: only `sundial/brand` is read here (a non-primary tenant's portalUrl for CSV
// links, through lib/tenant-settings.js). The primary tenant never reads it (D-078).
mock.module("../../lib/secrets.js", {
  namedExports: {
    getSecret: async (name) => {
      ctx.secretReads = (ctx.secretReads ?? 0) + 1;
      if (name !== "sundial/brand") throw new Error(`unexpected secret ${name}`);
      return { "conops-demo": { portalUrl: "https://demo.sundial.example/" } };
    },
    clearSecretCache: () => {},
    SECRET_TIMEOUT_MS: 10_000,
  },
});

// --- an in-memory PostgREST builder: exactly the calls the Lambda makes ----------------------
function builder(name) {
  const st = { op: "select", filters: [], single: null, order: null, limit: null };
  const b = {
    select() { return b; },
    insert(rows) { st.op = "insert"; st.rows = Array.isArray(rows) ? rows : [rows]; return b; },
    update(patch) { st.op = "update"; st.patch = patch; return b; },
    delete() { st.op = "delete"; return b; },
    eq(c, v) { st.filters.push((r) => r[c] === v); return b; },
    in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return b; },
    not(c) { st.filters.push((r) => r[c] !== null && r[c] !== undefined); return b; },
    order(c, { ascending = true } = {}) { st.order = [c, ascending]; return b; },
    limit(n) { st.limit = n; return b; },
    single() { st.single = "one"; return b; },
    maybeSingle() { st.single = "maybe"; return b; },
    then(resolve, reject) { return Promise.resolve().then(exec).then(resolve, reject); },
  };
  function exec() {
    ctx.dbCalls.push({ table: name, op: st.op });
    if (ctx.failTables.has(name)) return { data: null, error: { message: `${name} unavailable` } };
    const rows = (ctx.tables[name] ??= []);
    let out;
    if (st.op === "insert") {
      out = st.rows.map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...r }));
      rows.push(...out);
    } else {
      const hit = rows.filter((r) => st.filters.every((f) => f(r)));
      if (st.op === "update") { hit.forEach((r) => Object.assign(r, st.patch)); out = hit; }
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
        if (ctx.rpcPages) {
          const off = args.p_def.offset ?? 0;
          const all = ctx.rpcPages.rows;
          const slice = all.slice(off, off + args.p_def.limit);
          const page = { rows: slice, aggregates: {}, truncated: off + args.p_def.limit < all.length };
          if (ctx.rpcPages.records) page.records = ctx.rpcPages.records.slice(off, off + args.p_def.limit);
          // A summary (D-093): the page's groups, and the grand totals when asked for.
          if (ctx.rpcPages.groupsFor) {
            page.groups = ctx.rpcPages.groupsFor(off, slice.length);
            if (args.p_def.totals) Object.assign(page, { aggregates: ctx.rpcPages.grand ?? {}, totalRows: all.length });
          }
          return { data: page, error: ctx.rpcPages.error ?? null };
        }
        return ctx.rpcResult;
      },
      from: (t) => builder(t),
    }),
  },
});

// --- S3, the presigner, Lambda ----------------------------------------------------------
const cmd = (kind) => class { constructor(input) { this.kind = kind; this.input = input; } };
mock.module("@aws-sdk/client-s3", {
  namedExports: {
    S3Client: class {
      async send(c) {
        ctx.s3.push({ kind: c.kind, input: c.input });
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
  namedExports: { getSignedUrl: async (_c, command, { expiresIn }) => `https://signed.example/${command.input.Bucket}/${command.input.Key}?ttl=${expiresIn}` },
});
mock.module("@aws-sdk/client-lambda", {
  namedExports: {
    LambdaClient: class {
      async send(c) {
        if (ctx.invokeFails) throw new Error("AccessDenied");
        ctx.invokes.push({ ...c.input, Payload: JSON.parse(Buffer.from(c.input.Payload).toString("utf8")) });
        return { StatusCode: 202 };
      }
    },
    InvokeCommand: cmd("Invoke"),
  },
});

// --- The Salesforce describe (live picklist values, D-089 am. 2) -----------------------------
mock.module("../../lib/sf-describe.js", {
  namedExports: {
    getRawDescribe: async (sfObject) => {
      if (!ctx.describe) throw new Error("describe unavailable (test)");
      return ctx.describe(sfObject);
    },
  },
});

process.env.AWS_LAMBDA_FUNCTION_NAME = "sundial-reports";
const { handler, matchRoute, catalogFor, CATALOG_GATES } = await import("./index.js");
const { S3CsvWriter, PART_BYTES } = await import("./csv.js");

const ev = (path, { method = "GET", body, qs } = {}) => ({
  httpMethod: method,
  path,
  headers: { Origin: "http://localhost:5173", Authorization: "Bearer x" },
  queryStringParameters: qs ?? null,
  body: body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body),
});
const call = async (...a) => {
  const res = await handler(ev(...a));
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, raw: res };
};
const GROUPED = {
  type: "solar",
  groupBy: ["solar.stage"],
  aggregates: [{ fn: "count" }],
  filters: [{ field: "solar.contract_date", op: "between", value: "this_quarter" }],
  sort: [{ field: "count", dir: "desc" }],
};
const SIMPLE = { type: "customers", columns: ["customer.name", "customer.city"] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// =========================================================================================
// R1a
// =========================================================================================
test("routes and methods", async () => {
  reset();
  assert.equal((await handler(ev("/reports/run", { method: "OPTIONS" }))).statusCode, 204);
  assert.equal((await call("/reports/run")).status, 405);
  assert.equal((await call("/reports/types", { method: "POST", body: {} })).status, 405);
  assert.equal((await call("/elsewhere")).status, 404);
  assert.equal((await call("/reports/a/b/c")).status, 404);
  assert.deepEqual(matchRoute("/prod/reports/types"), { name: "types", methods: ["GET"], id: null });
  assert.equal(matchRoute("/reports").name, "saved");
  assert.equal(matchRoute("/prod/reports").name, "saved");
  assert.equal(matchRoute("/reports/csv").name, "csv");
  assert.deepEqual(matchRoute("/reports/csv/abc"), { name: "csvStatus", methods: ["GET"], id: "abc" });
  assert.deepEqual(matchRoute("/reports/abc"), { name: "savedOne", methods: ["GET", "PATCH", "DELETE"], id: "abc" });
  assert.equal(matchRoute("/reports/abc/run").name, "savedRun");
  assert.equal(matchRoute("/reports/abc/csv").name, "savedCsv");
  assert.equal(matchRoute("/reports/run").name, "run", "a fixed word is never an id");
  assert.equal((await call("/reports/csv")).status, 405);
  assert.equal((await call("/reports", { method: "DELETE" })).status, 405);
});

test("reports.read: tenant levels in; sales, tech and none get 403 MODULE_FORBIDDEN on EVERY route, before any read", async () => {
  for (const level of ["Executive", "Admin", "Manager"]) {
    reset(level);
    assert.equal((await call("/reports/types")).status, 200, level);
  }
  const id = "33333333-3333-4333-8333-333333333333";
  const routes = [
    ["/reports/types"], ["/reports/catalog", { qs: { type: "solar" } }], ["/reports/run", { method: "POST", body: GROUPED }],
    ["/reports/csv", { method: "POST", body: SIMPLE }], [`/reports/csv/${id}`],
    ["/reports"], ["/reports", { method: "POST", body: { name: "x", definition: SIMPLE } }],
    [`/reports/${id}`], [`/reports/${id}`, { method: "PATCH", body: { name: "y" } }], [`/reports/${id}`, { method: "DELETE" }],
    [`/reports/${id}/run`], [`/reports/${id}/csv`],
  ];
  for (const level of ["Sales Rep", "Sales Dealer", "Technician", "NoDealerRep"]) {
    for (const [path, opts] of routes) {
      reset(level);
      const r = await call(path, opts);
      assert.equal(r.status, 403, `${level} ${opts?.method ?? "GET"} ${path}`);
      assert.deepEqual(r.body, { error: "forbidden", code: "MODULE_FORBIDDEN" });
      assert.equal(ctx.rpcCalls.length + ctx.dbCalls.length + ctx.invokes.length + ctx.s3.length, 0, `${level} ${path}: touched something`);
    }
  }
});

test("no tenant, and identity errors", async () => {
  reset();
  ctx.tenant = null;
  assert.deepEqual((await call("/reports/types")).body, { error: "no_tenant", code: "NO_TENANT" });
  reset();
  ctx.identityError = "AUTH_INVALID_TOKEN";
  assert.equal((await call("/reports/types")).status, 401);
});

test("run: the tenant from the identity, the wire definition to the rpc, the response shape", async () => {
  reset("Admin");
  const r = await call("/reports/run", { method: "POST", body: { ...GROUPED, client_sf_id: "x" } });
  assert.equal(r.status, 400, "an unknown body key is refused, so no tenant can be smuggled in");
  assert.equal(r.body.field, "client_sf_id");
  assert.equal(ctx.rpcCalls.length, 0);

  reset("Admin");
  const ok = await call("/reports/run", { method: "POST", body: GROUPED });
  assert.equal(ok.status, 200);
  assert.equal(ctx.rpcCalls.length, 1);
  const { name, args } = ctx.rpcCalls[0];
  assert.equal(name, "sundial_report_run");
  assert.equal(args.p_client_sf_id, TENANT);
  assert.equal(args.p_def.base.table, "sundial_solar_cache");
  assert.equal(args.p_def.grouped, true);
  assert.equal(args.p_def.totals, true);
  assert.equal(args.p_def.offset, 0);
  assert.equal(args.p_def.filters[0].op, "between");
  assert.match(args.p_def.filters[0].value[0], /^\d{4}-(01|04|07|10)-01$/);
  assert.deepEqual(ok.body.columns.map((c) => c.field), ["solar.stage", "count"]);
  assert.deepEqual(ok.body.rows, [["A", 1]]);
  assert.deepEqual(ok.body.aggregates, [{ field: "count", label: "Count", type: "number", format: null, aggregate: "count", value: 7 }]);
  assert.equal(ok.body.truncated, false);
  assert.equal(ok.body.limit, 5000);
  assert.deepEqual(ok.body.stripped, []);
  // solar 17:05, customer 17:04, user 16:45, dealer 16:50 → the oldest newest run
  assert.equal(ok.body.asOf, "2026-11-03T16:45:00Z");
});

test("run: asOf is null when an object has no ok run on record", async () => {
  reset("Admin");
  ctx.tables.cache_sync_runs = ctx.tables.cache_sync_runs.filter((r) => r.object !== "dealer");
  assert.equal((await call("/reports/run", { method: "POST", body: GROUPED })).body.asOf, null);
});

test("run: a bad definition is a 400 that never reaches the database", async () => {
  for (const body of [{ type: "solar", columns: ["solar.nope"] }, "not json", undefined]) {
    reset("Admin");
    const r = await call("/reports/run", { method: "POST", body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, "invalid_report");
    assert.equal(ctx.rpcCalls.length, 0);
  }
});

test("run: the gates the caller holds ride on the wire", async () => {
  assert.deepEqual(CATALOG_GATES, ["service.costing.read"]);
  reset("Manager");
  await call("/reports/run", { method: "POST", body: GROUPED });
  assert.deepEqual(ctx.rpcCalls[0].args.p_def.allowedGates, []);
  reset("Admin");
  await call("/reports/run", { method: "POST", body: GROUPED });
  assert.deepEqual(ctx.rpcCalls[0].args.p_def.allowedGates, ["service.costing.read"]);
  // a Manager's cost column is stripped and named
  reset("Manager");
  const r = await call("/reports/run", { method: "POST", body: { type: "estimate_lines", columns: ["line.name", "line.unit_labor_cost"] } });
  assert.deepEqual(r.body.stripped, ["line.unit_labor_cost"]);
  assert.deepEqual(ctx.rpcCalls[0].args.p_def.columns, [{ alias: "line", column: "name" }]);
});

test("run: a function RAISE is REPORT_CATALOG_MISMATCH; another rpc error a plain 500", async () => {
  reset("Admin");
  ctx.rpcResult = { data: null, error: { message: "sundial_report_run: unknown column solar.x" } };
  const r = await call("/reports/run", { method: "POST", body: GROUPED });
  assert.equal(r.status, 500);
  assert.equal(r.body.code, "REPORT_CATALOG_MISMATCH");
  reset("Admin");
  ctx.rpcResult = { data: null, error: { message: "connection reset" } };
  const r2 = await call("/reports/run", { method: "POST", body: GROUPED });
  assert.deepEqual(r2.body, { error: "server_error" });
});

test("types: all ten, no table names", async () => {
  reset("Manager");
  const r = await call("/reports/types");
  assert.equal(r.body.types.length, 10);
  assert.ok(r.body.types.some((t) => t.key === "solar"));
  assert.doesNotMatch(r.raw.body, /_cache/);
});

test("catalog: per caller — gated and non-reportable fields are absent; rollup measures; operators per field", async () => {
  reset("Manager");
  const r = await call("/reports/catalog", { qs: { type: "solar" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.aliases.map((a) => a.alias), ["solar", "customer", "rep", "dealer"]);
  const solar = r.body.aliases[0].fields;
  assert.ok(!solar.some((f) => f.field === "solar.sf_id"));
  const stage = solar.find((f) => f.field === "solar.stage");
  assert.equal(stage.type, "picklist");
  assert.ok(stage.operators.includes("in"));
  assert.ok(Array.isArray(stage.picklistValues));
  assert.doesNotMatch(r.raw.body, /_cache/);
  assert.equal((await call("/reports/catalog", { qs: { type: "nope" } })).status, 400);
  assert.equal((await call("/reports/catalog")).status, 400);

  const fields = (type, held) => catalogFor(type, held).aliases.flatMap((a) => a.fields.map((f) => f.field));
  assert.ok(!fields("estimate_lines", []).includes("line.unit_labor_cost"), "a Manager never sees the cost column");
  assert.ok(fields("estimate_lines", ["service.costing.read"]).includes("line.unit_labor_cost"));
  const pay = catalogFor("service_jobs", []).aliases.find((a) => a.alias === "payments");
  assert.deepEqual(pay.fields.map((f) => f.field), ["payments.payment_count", "payments.amount_paid", "payments.deposits_paid", "payments.refunds", "payments.last_paid_at"]);
  assert.ok(pay.fields.every((f) => f.operators.length > 0));
});

test("format: the catalog passes it through; a run's columns and aggregates carry it", async () => {
  reset("Manager");
  const cat = (await call("/reports/catalog", { qs: { type: "customers" } })).body;
  const cf = (ref) => cat.aliases.flatMap((a) => a.fields).find((f) => f.field === ref);
  assert.equal(cf("customer.referral_fee").format, "currency");
  assert.equal(cf("customer.apr").format, "percent");
  assert.equal(cf("customer.city").format, null);
  assert.ok(cat.aliases.every((a) => a.fields.every((f) => f.format === null || f.format === "currency" || f.format === "percent")));
  // A rollup: a count is a plain number, a sum or max keeps its column's format.
  const pay = catalogFor("service_jobs", []).aliases.find((a) => a.alias === "payments").fields;
  assert.deepEqual(pay.map((f) => [f.field, f.format]), [
    ["payments.payment_count", null], ["payments.amount_paid", "currency"], ["payments.deposits_paid", "currency"],
    ["payments.refunds", "currency"], ["payments.last_paid_at", null],
  ]);

  const run = await call("/reports/run", { method: "POST", body: { type: "customers", columns: ["customer.name", "customer.referral_fee", "customer.apr"] } });
  assert.equal(run.status, 200);
  assert.deepEqual(run.body.columns.map((c) => [c.field, c.format]), [["customer.name", null], ["customer.referral_fee", "currency"], ["customer.apr", "percent"]]);

  const grouped = await call("/reports/run", { method: "POST", body: {
    type: "customers", groupBy: ["customer.city"],
    aggregates: [{ fn: "count" }, { fn: "sum", field: "customer.referral_fee" }, { fn: "avg", field: "customer.apr" }],
  } });
  assert.equal(grouped.status, 200);
  assert.deepEqual(grouped.body.columns.map((c) => c.format), [null, null, "currency", "percent"]);

  // A saved report's run carries it too.
  const saved = await call("/reports", { method: "POST", body: { name: "Fees", definition: { type: "customers", columns: ["customer.referral_fee"] } } });
  const savedRun = await call(`/reports/${saved.body.id}/run`);
  assert.deepEqual(savedRun.body.columns.map((c) => c.format), ["currency"]);
});

// =========================================================================================
// R1b — CSV
// =========================================================================================
const lastExport = () => ctx.tables.sundial_report_exports.at(-1);

test("csv POST: validates in CSV mode, queues a row owned by the caller, invokes the worker — nothing else", async () => {
  reset("Manager");
  const r = await call("/reports/csv", { method: "POST", body: { ...SIMPLE, limit: 20000 } });
  assert.equal(r.status, 202);
  assert.match(r.body.exportId, UUID_RE);
  assert.equal(r.body.status, "queued");
  const row = lastExport();
  assert.equal(row.id, r.body.exportId);
  assert.equal(row.client_sf_id, TENANT);
  assert.equal(row.owner_profile_id, USERS.Manager.profile);
  assert.equal(row.status, "queued");
  assert.equal(row.report_type, "customers");
  assert.equal(row.job.rowLimit, 20000);
  assert.equal(row.job.wire.limit, 5000);
  assert.equal(row.job.wire.totals, false);
  assert.deepEqual(ctx.invokes, [{ FunctionName: "sundial-reports", InvocationType: "Event", Payload: { task: "csv", exportId: r.body.exportId } }]);
  assert.equal(ctx.rpcCalls.length, 0, "the POST runs no report");
  assert.equal(ctx.s3.length, 0);

  // long text is allowed in a CSV, and a CSV may ask for up to 50,000 rows
  reset("Manager");
  const lt = await call("/reports/csv", { method: "POST", body: { type: "service_jobs", columns: ["job.name", "job.office_notes"], limit: 50000 } });
  assert.equal(lt.status, 202);
  assert.equal(lastExport().job.wire.limit, 2000);
  // a bad definition never queues
  reset("Manager");
  const bad = await call("/reports/csv", { method: "POST", body: { ...SIMPLE, limit: 50001 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "BAD_LIMIT");
  assert.equal(ctx.tables.sundial_report_exports.length + ctx.invokes.length, 0);
});

test("csv POST: a failed self-invoke marks the row failed and answers 502", async () => {
  reset("Admin");
  ctx.invokeFails = true;
  const r = await call("/reports/csv", { method: "POST", body: SIMPLE });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "WORKER_INVOKE_FAILED");
  assert.equal(lastExport().status, "failed");
  assert.equal(lastExport().error_code, "WORKER_INVOKE_FAILED");
});

const worker = (exportId, remaining = 250_000) => handler({ task: "csv", exportId }, { getRemainingTimeInMillis: () => remaining });
const fakeRows = (n) => Array.from({ length: n }, (_, i) => [`Name ${i}`, i % 2 ? "Mesa" : "=cmd"]);

test("csv worker: pages until not truncated, one object under REPORTS/, BOM + header first, marks done", async () => {
  reset("Admin");
  const q = await call("/reports/csv", { method: "POST", body: SIMPLE });
  ctx.rpcPages = { rows: fakeRows(12001) };
  const res = await worker(q.body.exportId);
  assert.equal(res.ok, true);
  // 5,000 + 5,000 + 2,001: offsets 0 / 5000 / 10000, never the grand totals
  assert.deepEqual(ctx.rpcCalls.map((c) => [c.args.p_def.offset, c.args.p_def.limit, c.args.p_def.totals, c.args.p_client_sf_id]), [
    [0, 5000, false, TENANT], [5000, 5000, false, TENANT], [10000, 5000, false, TENANT],
  ]);
  const put = ctx.s3.filter((s) => s.kind === "PutObject");
  assert.equal(put.length, 1);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix" }).format(new Date(lastExport().created_at));
  assert.equal(put[0].input.Bucket, "sfsolproj");
  assert.equal(put[0].input.Key, `REPORTS/${TENANT}/${day}/${q.body.exportId}.csv`);
  assert.equal(put[0].input.ServerSideEncryption, "AES256");
  const text = put[0].input.Body.toString("utf8");
  assert.ok(text.startsWith("﻿Customer: "), "the BOM and the header come first");
  const lines = text.split("\r\n");
  assert.equal(lines.length, 1 + 12001 + 1); // header, rows, the empty string after the last CRLF
  // the formula guard ran; the trailing cell is the (empty: no records on this page) link column
  assert.equal(lines[1], "Name 0,'=cmd,", "the formula guard ran");
  const row = lastExport();
  assert.equal(row.status, "done");
  assert.equal(row.row_count, 12001);
  assert.equal(row.truncated, false);
  assert.equal(row.s3_key, put[0].input.Key);
  assert.equal(row.as_of, "2026-11-03T16:45:00Z"); // customers joins customer 17:04, dealer 16:50, user 16:45 → the oldest
});

test("csv worker: claims once; stops at the row limit (truncated); a RAISE fails it; a short clock is CSV_TOO_SLOW", async () => {
  reset("Admin");
  const q = await call("/reports/csv", { method: "POST", body: { ...SIMPLE, limit: 7000 } });
  ctx.rpcPages = { rows: fakeRows(9000) };
  await worker(q.body.exportId);
  assert.deepEqual(ctx.rpcCalls.map((c) => [c.args.p_def.offset, c.args.p_def.limit]), [[0, 5000], [5000, 2000]]);
  assert.equal(lastExport().row_count, 7000);
  assert.equal(lastExport().truncated, true);
  const again = await worker(q.body.exportId);
  assert.equal(again.skipped, "not queued", "a retried invoke never runs twice");
  assert.equal(ctx.rpcCalls.length, 2);

  reset("Admin");
  const q2 = await call("/reports/csv", { method: "POST", body: SIMPLE });
  ctx.rpcPages = { rows: [], error: { message: "sundial_report_run: unknown column customer.x" } };
  await worker(q2.body.exportId);
  assert.equal(lastExport().status, "failed");
  assert.equal(lastExport().error_code, "REPORT_CATALOG_MISMATCH");

  reset("Admin");
  const q3 = await call("/reports/csv", { method: "POST", body: SIMPLE });
  ctx.rpcPages = { rows: fakeRows(10) };
  await worker(q3.body.exportId, 5_000);
  assert.equal(lastExport().error_code, "CSV_TOO_SLOW");
  assert.equal(ctx.rpcCalls.length, 0);
  assert.equal(ctx.s3.filter((s) => s.kind === "PutObject").length, 0, "nothing half-written");

  reset("Admin");
  assert.equal((await worker("not-a-uuid")).skipped, "bad id");
});

test("csv writer: multipart past 8 MB, parts in order; abort on failure", async () => {
  reset();
  const { S3Client } = await import("@aws-sdk/client-s3");
  const w = new S3CsvWriter(new S3Client(), { key: `REPORTS/${TENANT}/2026-11-04/x.csv`, fileName: "x.csv" });
  const chunk = "x".repeat(1024 * 1024);
  for (let i = 0; i < 9; i++) await w.write(chunk);
  await w.write("tail");
  await w.finish();
  assert.deepEqual(ctx.s3.map((s) => s.kind), ["CreateMultipartUpload", "UploadPart", "UploadPart", "CompleteMultipartUpload"]);
  assert.equal(ctx.s3[1].input.Body.length, PART_BYTES);
  assert.deepEqual(ctx.s3[3].input.MultipartUpload.Parts, [{ ETag: "etag-1", PartNumber: 1 }, { ETag: "etag-2", PartNumber: 2 }]);
  reset();
  const w2 = new S3CsvWriter(new S3Client(), { key: "REPORTS/k.csv", fileName: "k.csv" });
  for (let i = 0; i < 9; i++) await w2.write(chunk);
  await w2.abort();
  assert.equal(ctx.s3.at(-1).kind, "AbortMultipartUpload");
});

test("csv status: the owner gets a 15-minute link; anyone else, another tenant or a bad id is 404", async () => {
  reset("Manager");
  const q = await call("/reports/csv", { method: "POST", body: SIMPLE });
  const queued = await call(`/reports/csv/${q.body.exportId}`);
  assert.equal(queued.status, 200);
  assert.equal(queued.body.status, "queued");
  assert.equal(queued.body.url, null);
  ctx.rpcPages = { rows: fakeRows(3) };
  await worker(q.body.exportId);
  const done = await call(`/reports/csv/${q.body.exportId}`);
  assert.equal(done.body.status, "done");
  assert.equal(done.body.rowCount, 3);
  assert.equal(done.body.truncated, false);
  assert.match(done.body.url, new RegExp(`^https://signed\\.example/sfsolproj/REPORTS/${TENANT}/\\d{4}-\\d{2}-\\d{2}/${q.body.exportId}\\.csv\\?ttl=900$`));
  assert.ok(Date.parse(done.body.expiresAt) - Date.now() <= 900_000);

  for (const level of ["Manager2", "Admin", "Executive"]) {
    as(level);
    const r = await call(`/reports/csv/${q.body.exportId}`);
    assert.equal(r.status, 404, level);
    assert.deepEqual(r.body, { error: "not_found", code: "RECORD_NOT_FOUND" });
  }
  as("Manager");
  ctx.tenant = OTHER_TENANT;
  assert.equal((await call(`/reports/csv/${q.body.exportId}`)).status, 404);
  ctx.tenant = TENANT;
  assert.equal((await call("/reports/csv/not-a-uuid")).status, 404);
  assert.equal((await call(`/reports/csv/${randomUUID()}`)).status, 404);

  // a row nobody finished is reported lost after 10 minutes
  lastExport().status = "running";
  lastExport().created_at = new Date(Date.now() - 11 * 60_000).toISOString();
  const lost = await call(`/reports/csv/${q.body.exportId}`);
  assert.equal(lost.body.status, "failed");
  assert.equal(lost.body.code, "CSV_EXPORT_LOST");
});

// =========================================================================================
// R1b — saved reports
// =========================================================================================
test("saved: a Manager's private report is invisible to an Admin until the Manager shares it", async () => {
  reset("Manager");
  const created = await call("/reports", { method: "POST", body: { name: "My pipeline", definition: SIMPLE } });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.sharing, "private");
  assert.equal(created.body.mine, true);
  const row = ctx.tables.sundial_reports[0];
  assert.equal(row.owner_profile_id, USERS.Manager.profile);
  assert.equal(row.created_by, USERS.Manager.profile);
  assert.equal(row.client_sf_id, TENANT);

  as("Admin");
  assert.deepEqual((await call("/reports")).body.reports, []);
  for (const [path, opts] of [[`/reports/${id}`], [`/reports/${id}`, { method: "PATCH", body: { name: "mine now" } }], [`/reports/${id}`, { method: "DELETE" }], [`/reports/${id}/run`], [`/reports/${id}/csv`]]) {
    const r = await call(path, opts);
    assert.equal(r.status, 404, `${opts?.method ?? "GET"} ${path}`);
    assert.deepEqual(r.body, { error: "not_found", code: "RECORD_NOT_FOUND" });
  }
  assert.equal(ctx.tables.sundial_reports[0].name, "My pipeline");
  assert.equal(ctx.rpcCalls.length + ctx.invokes.length, 0);

  // the Manager shares it, through the API
  as("Manager");
  const share = await call(`/reports/${id}`, { method: "PATCH", body: { sharing: "tenant" } });
  assert.equal(share.status, 200);
  assert.equal(share.body.sharing, "tenant");
  as("Admin");
  const list = await call("/reports");
  assert.deepEqual(list.body.reports.map((r) => [r.id, r.mine, r.canEdit]), [[id, false, false]], "visible, read-only to the Admin");
  assert.equal((await call(`/reports/${id}`, { method: "PATCH", body: { name: "taken" } })).body.code, "REPORT_READ_ONLY");
  assert.equal((await call(`/reports/${id}`)).status, 200);
  const run = await call(`/reports/${id}/run`);
  assert.equal(run.status, 200);
  assert.deepEqual(run.body.report, { id, name: "My pipeline" });
  // and the owner may always take it back to private
  as("Manager");
  const unshare = await call(`/reports/${id}`, { method: "PATCH", body: { sharing: "private" } });
  assert.equal(unshare.status, 200);
  assert.equal(unshare.body.sharing, "private");
  as("Admin");
  assert.equal((await call(`/reports/${id}`)).status, 404);
  // another tenant never sees it, shared or not
  ctx.tables.sundial_reports[0].sharing = "tenant";
  ctx.tenant = OTHER_TENANT;
  assert.equal((await call(`/reports/${id}`)).status, 404);
  assert.deepEqual((await call("/reports")).body.reports, []);
});

test("saved: a shared report is read-only to everyone but its owner (Admins too, until reports.admin)", async () => {
  reset("Admin");
  const c = await call("/reports", { method: "POST", body: { name: "Team", description: "everyone", definition: SIMPLE, sharing: "tenant" } });
  assert.equal(c.status, 201);
  const id = c.body.id;
  as("Manager");
  const seen = await call(`/reports/${id}`);
  assert.equal(seen.body.canEdit, false);
  assert.equal((await call(`/reports/${id}`, { method: "PATCH", body: { name: "x" } })).body.code, "REPORT_READ_ONLY");
  assert.equal((await call(`/reports/${id}`, { method: "DELETE" })).status, 403);
  as("Executive");
  assert.equal((await call(`/reports/${id}`, { method: "PATCH", body: { name: "x" } })).body.code, "REPORT_READ_ONLY");
  assert.equal((await call(`/reports/${id}`, { method: "DELETE" })).status, 403);
  as("Admin");
  const e = await call(`/reports/${id}`, { method: "PATCH", body: { name: "Team v2" } });
  assert.equal(e.status, 200);
  assert.equal(e.body.name, "Team v2");
  assert.equal(ctx.tables.sundial_reports[0].updated_by, USERS.Admin.profile);
  assert.equal(ctx.tables.sundial_reports[0].owner_profile_id, USERS.Admin.profile, "an edit never moves ownership");
  assert.equal((await call(`/reports/${id}`, { method: "DELETE" })).status, 204);
  assert.equal(ctx.tables.sundial_reports.length, 0);
});

test("saved: the owner is the JWT's; a bad body is a 400 naming the field; the list is mine + shared, newest first", async () => {
  reset("Manager");
  const smuggle = await call("/reports", { method: "POST", body: { name: "x", definition: SIMPLE, owner_profile_id: USERS.Admin.profile } });
  assert.equal(smuggle.status, 400);
  assert.equal(smuggle.body.field, "owner_profile_id");
  assert.equal((await call("/reports", { method: "POST", body: { name: "x", definition: { type: "nope" } } })).body.field, "definition.type");
  assert.equal(ctx.tables.sundial_reports.length, 0);

  const mk = (name, sharing, profile, created_at) => ctx.tables.sundial_reports.push({
    id: randomUUID(), client_sf_id: TENANT, owner_profile_id: profile, name, description: null, definition: SIMPLE, sharing, created_at, updated_at: created_at, created_by: profile, updated_by: profile,
  });
  mk("old mine", "private", USERS.Manager.profile, "2026-11-01T00:00:00Z");
  mk("shared by admin", "tenant", USERS.Admin.profile, "2026-11-03T00:00:00Z");
  mk("admin private", "private", USERS.Admin.profile, "2026-11-04T00:00:00Z");
  mk("new mine shared", "tenant", USERS.Manager.profile, "2026-11-02T00:00:00Z");
  ctx.tables.sundial_reports.push({ ...ctx.tables.sundial_reports[1], id: randomUUID(), client_sf_id: OTHER_TENANT, name: "other tenant" });
  const list = await call("/reports");
  assert.deepEqual(list.body.reports.map((r) => r.name), ["shared by admin", "new mine shared", "old mine"]);
  assert.doesNotMatch(JSON.stringify(list.body), new RegExp(TENANT));
});

test("saved: the list names each owner from profiles.full_name in ONE lookup; a gone profile is \"former user\"", async () => {
  reset("Manager");
  const GONE = "d0000000-0000-4000-8000-000000000009";
  ctx.tables.profiles.push(
    { id: USERS.Manager.profile, full_name: "Maggie Manager" },
    { id: USERS.Admin.profile, full_name: "  Ada Admin " },
  );
  const mk = (name, profile, created_at) => ctx.tables.sundial_reports.push({
    id: randomUUID(), client_sf_id: TENANT, owner_profile_id: profile, name, description: null, definition: SIMPLE, sharing: "tenant", created_at, updated_at: created_at, created_by: profile, updated_by: profile,
  });
  mk("mine", USERS.Manager.profile, "2026-11-01T00:00:00Z");
  mk("admin's", USERS.Admin.profile, "2026-11-02T00:00:00Z");
  mk("admin's again", USERS.Admin.profile, "2026-11-03T00:00:00Z");
  mk("orphan", GONE, "2026-11-04T00:00:00Z");
  ctx.dbCalls = [];
  const list = await call("/reports");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.reports.map((r) => [r.name, r.ownerName]), [
    ["orphan", "former user"], ["admin's again", "Ada Admin"], ["admin's", "Ada Admin"], ["mine", "Maggie Manager"],
  ]);
  assert.equal(ctx.dbCalls.filter((c) => c.table === "profiles").length, 1, "one profiles read for the whole list, not one per row");

  // A failed lookup never fails the list: the names are null (unknown), not "former user".
  ctx.failTables.add("profiles");
  const degraded = await call("/reports");
  assert.equal(degraded.status, 200);
  assert.equal(degraded.body.reports.length, 4);
  assert.ok(degraded.body.reports.every((r) => r.ownerName === null));

  // No reports: no profiles read at all.
  ctx.failTables.clear();
  ctx.tables.sundial_reports.length = 0;
  ctx.dbCalls = [];
  assert.deepEqual((await call("/reports")).body.reports, []);
  assert.equal(ctx.dbCalls.filter((c) => c.table === "profiles").length, 0);
});

test("saved: runs with the RUNNER's gates; its CSV queues an export tied to the report", async () => {
  reset("Admin");
  const c = await call("/reports", { method: "POST", body: { name: "Costs", definition: { type: "estimate_lines", columns: ["line.name", "line.unit_labor_cost"] }, sharing: "tenant" } });
  assert.deepEqual(ctx.tables.sundial_reports[0].definition.columns, ["line.name", "line.unit_labor_cost"], "an Admin's report keeps the cost column");
  as("Manager");
  const run = await call(`/reports/${c.body.id}/run`);
  assert.equal(run.status, 200);
  assert.deepEqual(run.body.stripped, ["line.unit_labor_cost"], "a Manager running it never sees the cost");
  assert.deepEqual(ctx.rpcCalls[0].args.p_def.columns, [{ alias: "line", column: "name" }]);
  const csv = await call(`/reports/${c.body.id}/csv`);
  assert.equal(csv.status, 202);
  assert.equal(lastExport().report_id, c.body.id);
  assert.equal(lastExport().owner_profile_id, USERS.Manager.profile, "the export is the runner's");
  assert.deepEqual(lastExport().job.wire.columns, [{ alias: "line", column: "name" }]);
  // a Manager's own save of the same definition stores it WITHOUT the cost column
  const mine = await call("/reports", { method: "POST", body: { name: "Mine", definition: { type: "estimate_lines", columns: ["line.name", "line.unit_labor_cost"] } } });
  assert.deepEqual(mine.body.stripped, ["line.unit_labor_cost"]);
  assert.deepEqual(ctx.tables.sundial_reports.at(-1).definition.columns, ["line.name"]);
});

// =========================================================================================
// D-089 amendment 1 (2026-11-09): record links; distinct values for filters
// =========================================================================================
const CUST_RECORDS = [{ alias: "customer", column: "name" }, { alias: "dealer", column: "name" }, { alias: "rep", column: "name" }, { alias: "assignee", column: "name" }];

test("run: an ungrouped run carries records parallel to rows; a grouped one has none; not columns", async () => {
  reset("Admin");
  const recs = [{ customer: { sfId: "a1P000000000001AAA", name: "Ada" }, dealer: null, rep: null, assignee: null }];
  ctx.rpcResult = { data: { rows: [["Ada", "Mesa"]], aggregates: {}, truncated: false, records: recs }, error: null };
  const r = await call("/reports/run", { method: "POST", body: SIMPLE });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.records, recs);
  assert.deepEqual(ctx.rpcCalls[0].args.p_def.records, CUST_RECORDS, "every record alias, each with its name column");
  assert.equal(r.body.columns.length, 2, "records are not columns");
  // 50 columns plus the records is still allowed: they never count against the cap.
  const solar50 = catalogFor("solar", []).aliases[0].fields.filter((f) => f.selectable).slice(0, 50).map((f) => f.field);
  reset("Admin");
  assert.equal((await call("/reports/run", { method: "POST", body: { type: "solar", columns: solar50 } })).status, 200);

  reset("Admin");
  const g = await call("/reports/run", { method: "POST", body: GROUPED });
  assert.ok(!("records" in g.body), "grouped: no records key");
  assert.ok(!("records" in ctx.rpcCalls[0].args.p_def));

  // A saved report's run passes them through the same way.
  reset("Admin");
  ctx.rpcResult = { data: { rows: [["Ada", "Mesa"]], aggregates: {}, truncated: false, records: recs }, error: null };
  const saved = await call("/reports", { method: "POST", body: { name: "Mine", definition: SIMPLE } });
  const run = await call(`/reports/${saved.body.id}/run`);
  assert.deepEqual(run.body.records, recs);
});

test("types: each alias says which page its record opens — recordPath, linkVia (an alias of the same type), or neither", async () => {
  reset("Manager");
  const r = await call("/reports/types");
  const t = (key) => r.body.types.find((x) => x.key === key);
  const link = (key) => Object.fromEntries([t(key).base, ...t(key).joins].map((a) => [a.alias, [a.object, a.recordPath, a.linkVia]]));
  assert.deepEqual(link("service_jobs"), {
    job: ["job", "/service/jobs/{id}", null],
    customer: ["customer", "/customers/{id}", null],
    bill_to: ["customer", "/customers/{id}", null],
    estimate: ["estimate", "/service/estimates/{id}", null],
    invoice: ["serviceinvoice", null, "job"],
    payments: ["servicepayment", null, null], // a rollup has no record
    assignee: ["user", null, null],
  });
  assert.deepEqual(link("payments").payment, ["servicepayment", null, "job"]);
  assert.deepEqual(link("service_calls").call, ["servicecall", null, "job"]);
  assert.deepEqual(link("estimate_lines").line, ["serviceline", null, "estimate"]);
  assert.deepEqual(link("estimate_lines").item, ["pricebookitem", null, null]);
  assert.deepEqual(link("solar").solar, ["solar", "/projects/solar/{id}", null]);
  assert.deepEqual(link("solar").dealer, ["dealer", null, null]);
  assert.deepEqual(link("roofing").roofing, ["roofing", "/projects/roofing/{id}", null]);
  // every linkVia names an alias of the same type that has a page of its own
  for (const type of r.body.types) {
    const all = [type.base, ...type.joins];
    for (const a of all.filter((x) => x.linkVia)) {
      assert.ok(all.find((x) => x.alias === a.linkVia)?.recordPath, `${type.key}.${a.alias} → ${a.linkVia}`);
    }
  }
});

test("catalog: the name field is flagged; text fields that qualify carry valuesLookup", async () => {
  reset("Manager");
  const cat = catalogFor("service_jobs", []);
  const fld = (ref) => cat.aliases.flatMap((a) => a.fields).find((f) => f.field === ref);
  assert.equal(fld("job.name").nameField, true);
  assert.equal(fld("customer.name").nameField, true);
  assert.equal(fld("job.status").nameField, undefined);
  assert.equal(catalogFor("solar", []).aliases[0].fields.find((f) => f.nameField).field, "solar.project_name");
  assert.equal(fld("job.status").valuesLookup, true, "a picklist");
  assert.equal(fld("customer.city").valuesLookup, true, "text");
  assert.equal(fld("job.office_notes").valuesLookup, undefined, "long text never");
  assert.equal(fld("job.sundial_customer_sf_id").valuesLookup, undefined, "an id never");
  assert.equal(fld("job.created_date").valuesLookup, undefined, "a date never");
  assert.equal(fld("payments.amount_paid").valuesLookup, undefined, "a rollup measure never");
});

test("values: resolved through the type's aliases; the tenant, table and column to the rpc; partial when more exist", async () => {
  reset("Manager");
  ctx.rpcResult = { data: { values: [{ value: "Mesa", count: 3 }, { value: "Mesquite", count: 1 }], total_distinct: 250 }, error: null };
  const r = await call("/reports/values", { qs: { type: "customers", field: "customer.city", q: "  mes " } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { type: "customers", field: "customer.city", values: [{ value: "Mesa", count: 3 }, { value: "Mesquite", count: 1 }], totalDistinct: 250, partial: true });
  assert.deepEqual(ctx.rpcCalls, [{ name: "sundial_report_values", args: { p_client_sf_id: TENANT, p_table: "sundial_customer_cache", p_column: "city", p_search: "mes" } }]);
  assert.doesNotMatch(r.raw.body, /_cache/);

  // a joined alias reads ITS object's table; no q = no search; all of them = not partial
  reset("Manager");
  ctx.rpcResult = { data: { values: [{ value: "Ann Rep", count: 9 }], total_distinct: 1 }, error: null };
  const j = await call("/reports/values", { qs: { type: "customers", field: "rep.name" } });
  assert.equal(j.body.partial, false);
  assert.equal(j.body.totalDistinct, 1);
  assert.deepEqual(ctx.rpcCalls[0].args, { p_client_sf_id: TENANT, p_table: "sundial_user_cache", p_column: "name", p_search: null });
});

test("values: 400 before any read for an unknown type / field, a field that offers no values, a long search", async () => {
  const cases = [
    [{ field: "customer.city" }, "UNKNOWN_TYPE"],
    [{ type: "nope", field: "customer.city" }, "UNKNOWN_TYPE"],
    [{ type: "customers" }, "UNKNOWN_FIELD"],
    [{ type: "customers", field: "city" }, "UNKNOWN_FIELD"],
    [{ type: "customers", field: "nope.city" }, "UNKNOWN_FIELD"],
    [{ type: "customers", field: "customer.nope" }, "UNKNOWN_FIELD"],
    [{ type: "customers", field: "customer.sf_id" }, "UNKNOWN_FIELD"], // not reportable
    [{ type: "customers", field: "customer.dealer_sf_id" }, "VALUES_NOT_AVAILABLE"], // an id
    [{ type: "customers", field: "customer.created_date" }, "VALUES_NOT_AVAILABLE"], // a date
    [{ type: "service_jobs", field: "job.office_notes" }, "VALUES_NOT_AVAILABLE"], // long text
    [{ type: "service_jobs", field: "payments.amount_paid" }, "VALUES_NOT_AVAILABLE"], // a rollup
    [{ type: "customers", field: "customer.city", q: "x".repeat(101) }, "BAD_VALUE"],
  ];
  for (const [qs, code] of cases) {
    reset("Admin");
    const r = await call("/reports/values", { qs });
    assert.equal(r.status, 400, JSON.stringify(qs));
    assert.equal(r.body.code, code, JSON.stringify(qs));
    assert.equal(ctx.rpcCalls.length, 0, JSON.stringify(qs));
  }
  // A gated field the caller does not hold does not exist for them (the catalog's rule).
  reset("Manager");
  const g = await call("/reports/values", { qs: { type: "estimate_lines", field: "line.unit_labor_cost" } });
  assert.equal(g.body.code, "UNKNOWN_FIELD");
  reset("Admin"); // holds the gate, but a number never offers values
  assert.equal((await call("/reports/values", { qs: { type: "estimate_lines", field: "line.unit_labor_cost" } })).body.code, "VALUES_NOT_AVAILABLE");
});

test("values: reports.read like every route; a function RAISE is REPORT_CATALOG_MISMATCH; every valuesLookup field is accepted", async () => {
  for (const level of ["Sales Rep", "Sales Dealer", "Technician", "NoDealerRep"]) {
    reset(level);
    const r = await call("/reports/values", { qs: { type: "customers", field: "customer.city" } });
    assert.equal(r.status, 403, level);
    assert.equal(r.body.code, "MODULE_FORBIDDEN");
    assert.equal(ctx.rpcCalls.length + ctx.dbCalls.length, 0);
  }
  reset("Admin");
  ctx.rpcResult = { data: null, error: { message: "sundial_report_values: column sundial_customer_cache.city is long text" } };
  const bad = await call("/reports/values", { qs: { type: "customers", field: "customer.city" } });
  assert.equal(bad.status, 500);
  assert.equal(bad.body.code, "REPORT_CATALOG_MISMATCH");

  // the catalog's flag and the route agree, for every alias of every type
  for (const t of ["customers", "service_jobs", "estimate_lines"]) {
    for (const a of catalogFor(t, []).aliases) {
      for (const f of a.fields.filter((x) => x.valuesLookup)) {
        reset("Manager");
        ctx.rpcResult = { data: { values: [], total_distinct: 0 }, error: null };
        assert.equal((await call("/reports/values", { qs: { type: t, field: f.field } })).status, 200, `${t} ${f.field}`);
      }
    }
  }
});

const PAY_RECORDS = [
  { payment: { sfId: "a3P000000000001AAA", name: "PAY-1" }, invoice: { sfId: "a3I000000000001AAA", name: "INV-1" }, job: { sfId: "a3J000000000001AAA", name: "SVC-1" }, customer: { sfId: "a1P000000000001AAA", name: "Ada" } },
  { payment: { sfId: "a3P000000000002AAA", name: "PAY-2" }, invoice: null, job: null, customer: null },
];

test("csv: an ungrouped export ends each row with the link columns — full URLs on the tenant's portal", async () => {
  reset("Admin");
  const q = await call("/reports/csv", { method: "POST", body: { type: "payments", columns: ["payment.name", "payment.amount"] } });
  assert.equal(lastExport().job.portalOrigin, "https://sundial.harmonelectric.net");
  assert.equal(ctx.secretReads, 0, "the primary tenant reads no secret for its origin");
  ctx.rpcPages = { rows: [["PAY-1", 10], ["PAY-2", 20]], records: PAY_RECORDS };
  await worker(q.body.exportId);
  const lines = ctx.s3.find((s) => s.kind === "PutObject").input.Body.toString("utf8").split("\r\n");
  assert.equal(lines[0], "﻿Payment: Payment Number,Payment: Amount,Payment link,Invoice link,Service job link,Customer link");
  const J = "https://sundial.harmonelectric.net/service/jobs/a3J000000000001AAA";
  assert.equal(lines[1], `PAY-1,10,${J},${J},${J},https://sundial.harmonelectric.net/customers/a1P000000000001AAA`);
  assert.equal(lines[2], "PAY-2,20,,,,", "no parent record, no link");
});

test("csv: grouped exports, old exports and tenants with no portal address get no link columns; another tenant gets its own origin", async () => {
  reset("Admin");
  const g = await call("/reports/csv", { method: "POST", body: { type: "customers", groupBy: ["customer.city"], aggregates: [{ fn: "count" }] } });
  assert.equal(lastExport().job.portalOrigin, null);
  ctx.rpcPages = { rows: [["Mesa", 3]] };
  await worker(g.body.exportId);
  assert.equal(ctx.s3.find((s) => s.kind === "PutObject").input.Body.toString("utf8"), "﻿Customer: City,Count\r\nMesa,3\r\n");

  // queued before the amendment: its job has no portalOrigin
  reset("Admin");
  const old = await call("/reports/csv", { method: "POST", body: SIMPLE });
  delete lastExport().job.portalOrigin;
  ctx.rpcPages = { rows: [["Ada", "Mesa"]], records: [{ customer: { sfId: "a1P000000000001AAA", name: "Ada" } }] };
  await worker(old.body.exportId);
  assert.equal(ctx.s3.find((s) => s.kind === "PutObject").input.Body.toString("utf8").split("\r\n")[1], "Ada,Mesa");

  // PORTAL_BASE_URL is the primary tenant's, trailing slash dropped
  reset("Admin");
  process.env.PORTAL_BASE_URL = "https://portal.harmon.example/";
  try {
    await call("/reports/csv", { method: "POST", body: SIMPLE });
    assert.equal(lastExport().job.portalOrigin, "https://portal.harmon.example");
  } finally {
    delete process.env.PORTAL_BASE_URL;
  }

  // another tenant: its own sundial/brand portalUrl — never the primary tenant's
  reset("Admin");
  ctx.slug = "conops-demo";
  await call("/reports/csv", { method: "POST", body: SIMPLE });
  assert.equal(lastExport().job.portalOrigin, "https://demo.sundial.example");
  reset("Admin");
  ctx.slug = "acme"; // no brand block: not configured
  const none = await call("/reports/csv", { method: "POST", body: SIMPLE });
  assert.equal(none.status, 202, "the export still runs");
  assert.equal(lastExport().job.portalOrigin, null);
});

test("saved: GET /reports/{id} and GET /reports/{id}/schedule name the owner as the list does — one lookup, \"former user\", null on failure", async () => {
  reset("Manager");
  const GONE = "d0000000-0000-4000-8000-000000000009";
  ctx.tables.profiles.push({ id: USERS.Admin.profile, full_name: "  Ada Admin " });
  const mk = (profile, schedule = null) => {
    const id = randomUUID();
    ctx.tables.sundial_reports.push({
      id, client_sf_id: TENANT, owner_profile_id: profile, name: "r", description: null, definition: SIMPLE, sharing: "tenant",
      created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", created_by: profile, updated_by: profile, schedule,
    });
    return id;
  };
  const admins = mk(USERS.Admin.profile, { cadence: "daily", time: "07:00", recipients: [{ userId: USERS.Admin.id }], format: "csv", enabled: true });
  const orphan = mk(GONE);

  ctx.dbCalls = [];
  const one = await call(`/reports/${admins}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.ownerName, "Ada Admin");
  assert.equal(ctx.dbCalls.filter((c) => c.table === "profiles").length, 1, "one profiles read");
  assert.equal((await call(`/reports/${orphan}`)).body.ownerName, "former user");

  const sched = await call(`/reports/${admins}/schedule`);
  assert.equal(sched.status, 200);
  assert.equal(sched.body.ownerName, "Ada Admin");
  assert.equal(sched.body.schedule.recipients, undefined, "still not shown to a non-owner");
  const none = await call(`/reports/${orphan}/schedule`);
  assert.equal(none.body.ownerName, "former user");
  assert.equal(none.body.schedule, null);

  // A failed lookup never fails the read: null (unknown), not "former user".
  ctx.failTables.add("profiles");
  const degraded = await call(`/reports/${admins}`);
  assert.equal(degraded.status, 200);
  assert.equal(degraded.body.ownerName, null);
  const degradedSched = await call(`/reports/${admins}/schedule`);
  assert.equal(degradedSched.status, 200);
  assert.equal(degradedSched.body.ownerName, null);
});

// =========================================================================================
// D-093 — summary reports (showDetails)
// =========================================================================================
const SUMMARY = { type: "customers", showDetails: true, groupBy: ["customer.city"], columns: ["customer.name"], aggregates: [{ fn: "count" }] };

test("D-093 run: a summary answers rows + records + labelled page groups + groupCount + the grand totals", async () => {
  reset("Admin");
  ctx.rpcResult = { data: {
    rows: [["Ada"], ["Bo"], ["Cy"]], aggregates: { count: 9 }, truncated: true,
    records: [{ customer: { sfId: "a1", name: "Ada" } }, { customer: { sfId: "a2", name: "Bo" } }, { customer: { sfId: "a3", name: "Cy" } }],
    groups: [{ key: "Mesa", first: 0, shown: 2, count: 2, aggregates: { count: 2 } }, { key: null, first: 2, shown: 1, count: 5, aggregates: { count: 5 } }],
    groupCount: 4, totalRows: 9,
  }, error: null };
  const r = await call("/reports/run", { method: "POST", body: SUMMARY });
  assert.equal(r.status, 200);
  const w = ctx.rpcCalls[0].args.p_def;
  assert.equal(w.grouped, false);
  assert.equal(w.details, true);
  assert.deepEqual(w.group, { alias: "customer", column: "city" });
  assert.deepEqual(r.body.columns.map((c) => c.field), ["customer.name"]);
  assert.equal(r.body.group.field, "customer.city");
  assert.deepEqual(r.body.groups, [
    { key: "Mesa", label: "Mesa", count: 2, aggregates: { count: 2 }, first: 0, shown: 2 },
    { key: null, label: "(blank)", count: 5, aggregates: { count: 5 }, first: 2, shown: 1 },
  ]);
  assert.equal(r.body.groupCount, 4);
  assert.equal(r.body.totalRows, 9);
  assert.equal(r.body.records.length, 3);
  assert.deepEqual(r.body.aggregates.map((a) => [a.field, a.value]), [["count", 9]]);
  assert.equal(r.body.truncated, true);
  // an ordinary run carries none of the summary keys
  reset("Admin");
  const plain = await call("/reports/run", { method: "POST", body: SIMPLE });
  assert.equal("groups" in plain.body, false);
});

test("D-093 run: a database function older than D-093 (no groups) is 500 REPORT_ENGINE_OUTDATED; an aggregate sort is a 400", async () => {
  reset("Admin");
  ctx.rpcResult = { data: { rows: [["Ada"]], aggregates: {}, truncated: false, records: [{}] }, error: null };
  const r = await call("/reports/run", { method: "POST", body: SUMMARY });
  assert.equal(r.status, 500);
  assert.equal(r.body.code, "REPORT_ENGINE_OUTDATED");
  reset("Admin");
  const s = await call("/reports/run", { method: "POST", body: { ...SUMMARY, sort: [{ field: "count", dir: "desc" }] } });
  assert.equal(s.status, 400);
  assert.equal(s.body.code, "BAD_SORT");
  assert.equal(ctx.rpcCalls.length, 0);
});

test("D-093 csv worker: group first, a subtotal after each group (one, across a page break), a grand total last; totals on page 1 only", async () => {
  reset("Admin");
  const q = await call("/reports/csv", { method: "POST", body: SUMMARY });
  assert.equal(q.status, 202);
  assert.deepEqual(lastExport().job.group.field, "customer.city");
  assert.deepEqual(lastExport().job.totals.map((t) => t.field), ["count"]);
  // 6,000 rows: the first 5,500 are Mesa, the rest Tempe — Mesa runs across the page break.
  const keyOf = (i) => (i < 5500 ? "Mesa" : "Tempe");
  const full = { Mesa: 5500, Tempe: 500 };
  ctx.rpcPages = {
    rows: Array.from({ length: 6000 }, (_, i) => [`Name ${i}`]),
    grand: { count: 6000 },
    groupsFor: (off, len) => {
      const out = [];
      for (let k = 0; k < len; k++) {
        const key = keyOf(off + k);
        const last = out[out.length - 1];
        if (last && last.key === key) last.shown += 1;
        else out.push({ key, first: k, shown: 1, count: full[key], aggregates: { count: full[key] } });
      }
      return out;
    },
  };
  const res = await worker(q.body.exportId);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(ctx.rpcCalls.map((c) => [c.args.p_def.offset, c.args.p_def.totals, c.args.p_def.details]), [[0, true, true], [5000, false, true]]);
  const text = ctx.s3.filter((x) => x.kind === "PutObject")[0].input.Body.toString("utf8");
  const lines = text.split("\r\n");
  assert.match(lines[0], /^﻿Customer: City,Customer: Customer Name,Count/);
  assert.match(lines[1], /^Mesa,Name 0,,/);
  assert.match(lines[5500], /^Mesa,Name 5499,,/);
  assert.match(lines[5501], /^Subtotal: Mesa \(5500 records\),,5500/);
  assert.match(lines[5502], /^Tempe,Name 5500,,/);
  assert.match(lines[6002], /^Subtotal: Tempe \(500 records\),,500/);
  assert.match(lines[6003], /^Grand total \(6000 records\),,6000/);
  assert.equal(lines.length, 6005);
  assert.equal(text.split("Subtotal: Mesa").length - 1, 1, "one subtotal for the split group");
  assert.equal(lastExport().row_count, 6000);
});

test("D-093 csv worker: a SQL older than D-093 fails the summary export REPORT_ENGINE_OUTDATED", async () => {
  reset("Admin");
  const q = await call("/reports/csv", { method: "POST", body: SUMMARY });
  ctx.rpcPages = { rows: [["Ada"]] };
  const res = await worker(q.body.exportId);
  assert.equal(res.ok, false);
  assert.equal(res.code, "REPORT_ENGINE_OUTDATED");
});

test("catalog: picklist values come from the live describe; the generated ones when it fails (D-089 am. 2)", async () => {
  reset("Manager");
  const stageOf = (r) => r.body.aliases[0].fields.find((f) => f.field === "solar.stage");
  // The describe fails (the default here): the generated values.
  const snapshot = stageOf(await call("/reports/catalog", { qs: { type: "solar" } })).picklistValues;
  assert.ok(snapshot.length > 0);

  ctx.describe = (sfObject) => ({
    fields: sfObject === "Sundial_Solar__c"
      ? [{ name: "Stage__c", type: "picklist", picklistValues: [
          { value: snapshot[0], active: true },
          { value: "Brand New Stage", active: true },
          { value: snapshot[1], active: false },
        ] }]
      : [],
  });
  const r = await call("/reports/catalog", { qs: { type: "solar" } });
  assert.equal(r.status, 200);
  const stage = stageOf(r);
  assert.deepEqual(stage.picklistValues, [snapshot[0], "Brand New Stage"], "a new value appears, an inactive one is dropped");
  // Nothing else about the field changes.
  assert.equal(stage.type, "picklist");
  assert.ok(stage.operators.includes("in"));
  // A picklist the describe does not carry keeps its generated values.
  const customerAlias = r.body.aliases.find((a) => a.alias === "customer");
  const before = catalogFor("solar", []).aliases.find((a) => a.alias === "customer");
  const picks = (fields) => fields.filter((f) => f.picklistValues).map((f) => [f.field, f.picklistValues]);
  assert.ok(picks(before.fields).length > 0);
  assert.deepEqual(picks(customerAlias.fields), picks(before.fields));
});
