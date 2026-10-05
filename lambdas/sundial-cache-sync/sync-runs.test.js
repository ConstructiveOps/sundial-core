// Tests for sundial-cache-sync's D-079 behaviour (sync modes, not reconcile — that is
// test.js).
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// Pinned:
//   - a cache_sync_runs row is written per object per run, on success AND on failure,
//     with the schedule's interval when the rule passed one;
//   - a ZERO-CHANGE incremental run is exactly ONE SOQL and ZERO cache-table writes
//     (what makes a 5-minute schedule cheap);
//   - { objects: [...] } syncs exactly that list;
//   - the incremental query also asks for rows whose formula-feeding PARENT changed,
//     and the watermark includes the parent's modstamp but never moves backwards.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const TENANT = "a0Xharmon";
const ctx = { soql: [], writes: [], tables: {}, sfAnswer: () => [], sfThrows: false };
function resetCtx() {
  ctx.soql = [];
  ctx.writes = [];
  ctx.tables = { sundial_sync_state: [], cache_sync_runs: [] };
  ctx.sfAnswer = () => [];
  ctx.sfThrows = false;
}

// Chainable + thenable fake covering what the sync path uses.
class Q {
  constructor(table) { this.table = table; this.op = "select"; this.filters = []; }
  select() { if (this.op === "select") this.op = "select"; return this; }
  eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
  in(c, vals) { this.filters.push((r) => vals.includes(r[c])); return this; }
  lt(c, v) { this.filters.push((r) => r[c] < v); return this; }
  limit() { return this; }
  order() { return this; }
  maybeSingle() { this.single = true; return this; }
  upsert(rows) { this.op = "upsert"; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  insert(row) { this.op = "insert"; this.rows = [row]; return this; }
  delete() { this.op = "delete"; return this; }
  then(res, rej) { return this.run().then(res, rej); }
  async run() {
    const rows = ctx.tables[this.table] || (ctx.tables[this.table] = []);
    const match = (r) => this.filters.every((f) => f(r));
    if (this.op === "select") {
      const out = rows.filter(match);
      return { data: this.single ? out[0] ?? null : out, error: null };
    }
    ctx.writes.push({ table: this.table, op: this.op, n: this.rows?.length ?? 0 });
    if (this.op === "upsert") {
      for (const row of this.rows) {
        const i = rows.findIndex((r) => r.sf_id === row.sf_id || (row.object_key && r.object_key === row.object_key));
        if (i >= 0) rows[i] = { ...rows[i], ...row }; else rows.push(row);
      }
    } else if (this.op === "insert") rows.push(...this.rows);
    else if (this.op === "delete") ctx.tables[this.table] = rows.filter((r) => !match(r));
    return { data: null, error: null };
  }
}

mock.module("../../lib/supabase.js", {
  namedExports: {
    getSupabaseClient: async () => ({ from: (t) => new Q(t) }),
    getSupabaseConfig: async () => ({ url: "https://x.supabase.co", serviceRoleKey: "k" }),
  },
});
mock.module("../../lib/salesforce.js", {
  namedExports: {
    getSalesforceToken: async () => ({ access_token: "t", instance_url: "https://i" }),
    sfQuery: async (soql) => {
      ctx.soql.push(soql);
      if (ctx.sfThrows) throw new Error("SF unavailable");
      return ctx.sfAnswer(soql);
    },
    soqlEscapeString: (v) => String(v),
  },
});

// Cache columns (OpenAPI) and describes. The job has a cross-object formula column.
const COLS = ["sf_id", "client_sf_id", "tenant_id", "created_date", "last_synced_at", "is_stale", "cache_version", "name", "estimate_total"];
const DESCRIBES = {
  Sundial_Service_Job__c: [
    { name: "Id", type: "id" },
    { name: "Client__c", type: "reference", relationshipName: "Client__r", referenceTo: ["Sundial_Tenant__c"] },
    { name: "Name", type: "string" },
    { name: "Estimate__c", type: "reference", relationshipName: "Estimate__r", referenceTo: ["Sundial_Estimate__c"] },
    { name: "Estimate_Total__c", type: "currency", calculated: true, calculatedFormula: "Estimate__r.Total__c" },
    { name: "CreatedDate", type: "datetime" },
  ],
  Sundial_Customer__c: [
    { name: "Id", type: "id" },
    { name: "Client__c", type: "reference", relationshipName: "Client__r", referenceTo: ["Sundial_Tenant__c"] },
    { name: "Name", type: "string" },
    { name: "CreatedDate", type: "datetime" },
  ],
  Sundial_Estimate__c: [{ name: "Id", type: "id" }],
};
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/rest/v1/")) {
    const properties = Object.fromEntries(COLS.map((c) => [c, {}]));
    return { ok: true, status: 200, json: async () => ({ definitions: { sundial_service_job_cache: { properties }, sundial_customer_cache: { properties } } }) };
  }
  const obj = u.match(/sobjects\/([^/]+)\/describe/)?.[1];
  return { ok: true, status: 200, json: async () => ({ fields: DESCRIBES[obj] || [] }) };
};

const { handler } = await import("./index.js");
const WM = "2026-10-05T10:00:00.000Z";
const runsFor = (o) => ctx.tables.cache_sync_runs.filter((r) => r.object === o);

test.beforeEach(() => {
  resetCtx();
  ctx.tables.sundial_sync_state = [
    { object_key: "customer", last_synced_modstamp: WM },
    { object_key: "job", last_synced_modstamp: WM },
  ];
});

test("zero-change incremental run: ONE SOQL and ZERO cache-table writes", async () => {
  const res = await handler({ objects: ["customer"], intervalMinutes: 5 });
  assert.equal(res.objects.customer.status, "ok");
  assert.equal(ctx.soql.length, 1, "one query per object");
  const cacheWrites = ctx.writes.filter((w) => w.table.endsWith("_cache"));
  assert.deepEqual(cacheWrites, [], "nothing written to the cache table");
  // The only writes are bookkeeping: sync state, the run row, the prune.
  assert.deepEqual([...new Set(ctx.writes.map((w) => w.table))].sort(), ["cache_sync_runs", "sundial_sync_state"]);
});

test("a run row is written on success, with the schedule interval and the watermark", async () => {
  ctx.sfAnswer = () => [{ Id: "a1P000000000001AAA", Client__c: TENANT, Name: "N", SystemModstamp: "2026-10-05T10:03:00.000Z", Client__r: { Name: "harmon" } }];
  await handler({ objects: ["customer"], intervalMinutes: 5 });
  const [r] = runsFor("customer");
  assert.equal(r.mode, "incremental");
  assert.equal(r.ok, true);
  assert.equal(r.rows_upserted, 1);
  assert.equal(r.expected_interval_s, 300);
  assert.equal(r.watermark, "2026-10-05T10:03:00.000Z");
  assert.equal(r.error, null);
  assert.ok(r.started_at <= r.finished_at);
});

test("a run row is written on failure too (ok=false, reason recorded, interval kept)", async () => {
  ctx.sfThrows = true;
  await handler({ objects: ["customer"], intervalMinutes: 30 });
  const [r] = runsFor("customer");
  assert.equal(r.ok, false);
  assert.equal(r.expected_interval_s, 1800);
  assert.match(r.error, /SF unavailable/);
  assert.equal(r.watermark, null);
});

test("a manual invoke records no interval", async () => {
  await handler({ object: "customer" });
  assert.equal(runsFor("customer")[0].expected_interval_s, null);
});

test("{ objects: [...] } syncs exactly that list, one run row each", async () => {
  await handler({ objects: ["customer", "job"], intervalMinutes: 5 });
  assert.equal(ctx.soql.length, 2);
  assert.deepEqual(ctx.tables.cache_sync_runs.map((r) => r.object).sort(), ["customer", "job"]);
});

test("an unknown object in the list is refused before anything runs", async () => {
  const res = await handler({ objects: ["customer", "nope"] });
  assert.equal(res.ok, false);
  assert.equal(res.error, "OBJECT_NOT_ALLOWED");
  assert.equal(ctx.soql.length, 0);
});

test("job: the incremental query also asks for jobs whose ESTIMATE changed", async () => {
  await handler({ objects: ["job"], intervalMinutes: 5 });
  assert.match(ctx.soql[0], /Estimate__r\.SystemModstamp/, "selected");
  assert.match(ctx.soql[0], new RegExp(`\\(SystemModstamp > ${WM.replace(/\./g, "\\.")} OR Estimate__r\\.SystemModstamp > `), "and in the WHERE");
});

test("full mode keeps the plain query (no parent OR)", async () => {
  await handler({ objects: ["job"], mode: "full" });
  assert.doesNotMatch(ctx.soql[0], /Estimate__r/);
});

test("watermark takes the parent's modstamp and never moves backwards", async () => {
  // Returned only because its estimate changed: own modstamp is OLD.
  ctx.sfAnswer = () => [{
    Id: "a1S000000000001AAA", Client__c: TENANT, Name: "SVC-1", Estimate_Total__c: 500,
    SystemModstamp: "2026-09-01T00:00:00.000Z", Estimate__r: { SystemModstamp: "2026-10-05T10:04:00.000Z" }, Client__r: { Name: "harmon" },
  }];
  await handler({ objects: ["job"], intervalMinutes: 5 });
  const state = ctx.tables.sundial_sync_state.find((s) => s.object_key === "job");
  assert.equal(state.last_synced_modstamp, "2026-10-05T10:04:00.000Z");
  const cached = ctx.tables.sundial_service_job_cache.find((r) => r.sf_id === "a1S000000000001AAA");
  assert.equal(cached.estimate_total, 500, "the formula column was refreshed");

  // A run whose only row is older than the stored watermark keeps the watermark.
  ctx.sfAnswer = () => [{ Id: "a1S000000000002AAA", Client__c: TENANT, Name: "SVC-2", SystemModstamp: "2026-09-02T00:00:00.000Z", Estimate__r: null }];
  await handler({ objects: ["job"], intervalMinutes: 5 });
  assert.equal(ctx.tables.sundial_sync_state.find((s) => s.object_key === "job").last_synced_modstamp, "2026-10-05T10:04:00.000Z");
});

test("old run rows are pruned (14-day retention)", async () => {
  ctx.tables.cache_sync_runs.push({ object: "customer", mode: "incremental", started_at: "2026-01-01T00:00:00.000Z", ok: true });
  await handler({ objects: ["customer"], intervalMinutes: 5 });
  assert.ok(!ctx.tables.cache_sync_runs.some((r) => r.started_at === "2026-01-01T00:00:00.000Z"));
  assert.equal(runsFor("customer").length, 1, "today's row stays");
});
