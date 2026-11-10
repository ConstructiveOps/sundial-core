// node --experimental-test-module-mocks --test lambdas/sundial-reports/assist.test.js
//
// POST /reports/assist through the REAL handler (D-092), with a fake identity, an in-memory
// Supabase (the claim / release RPCs + the log table) and a fake model client injected through
// assist.js's seam; lib/report-assist.js, the schema, the prompt and the validator run unmocked.
//
// Pinned:
//   - reports.ai: Executive / Admin / Manager in; Sales Rep / Sales Dealer / Technician 403
//     MODULE_FORBIDDEN before any claim or model call;
//   - a bad body is a 400 that never claims a turn or calls the model; not configured = 503, no turn;
//   - the claim comes BEFORE the model, keyed on the identity's tenant + profile (never the body);
//     refused = 429 ASSIST_BUDGET_EXHAUSTED { scope, limit, resetsAt } and no model call;
//   - an upstream failure RELEASES the claim with the claimed periods (502 ASSIST_UPSTREAM);
//     a refusal or a question does not;
//   - the log row: the request text, the validated definition, the outcome, the tokens;
//   - the 90-day cleanup the tick runs.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { randomUUID } from "node:crypto";
import { resolveScope, accessBlock } from "../../lib/access.js";

const TENANT = "a1W7y000007AszBEAS";
const DEALER = "a2D000000000DLRAAA";
const USERS = {
  Executive: { id: "a0U0000000000EXEC", accessLevel: "Executive", dealer: null, profile: "e0000000-0000-4000-8000-000000000001" },
  Admin: { id: "a0U00000000000ADM", accessLevel: "Admin", dealer: null, profile: "a0000000-0000-4000-8000-000000000002" },
  Manager: { id: "a0U00000000000MGR", accessLevel: "Manager", dealer: null, profile: "b0000000-0000-4000-8000-000000000003" },
  "Sales Rep": { id: "a0U00000000000REP", accessLevel: "Sales Rep", dealer: { id: DEALER, active: true, isInternal: false }, profile: "c0000000-0000-4000-8000-000000000005" },
  "Sales Dealer": { id: "a0U00000000000DLR", accessLevel: "Sales Dealer", dealer: { id: DEALER, active: true, isInternal: false }, profile: "c0000000-0000-4000-8000-000000000006" },
  Technician: { id: "a0U00000000000TEC", accessLevel: "Technician", dealer: null, profile: "c0000000-0000-4000-8000-000000000007" },
};

const ctx = {};
function reset(level = "Admin") {
  ctx.level = level;
  ctx.rpcCalls = [];
  ctx.claim = { ok: true, tenant_used: 3, tenant_limit: 500, user_used: 1, user_limit: 40, month_start: "2026-11-01", day: "2026-11-10" };
  ctx.tables = { sundial_report_assist_log: [], sundial_report_assist_usage: [] };
  ctx.modelCalls = [];
  ctx.script = [];
  ctx.notConfigured = false;
}

mock.module("../../lib/identity.js", {
  namedExports: {
    resolveIdentityForProfile: async () => { throw new Error("not used"); },
    resolveIdentity: async () => {
      const user = USERS[ctx.level];
      return { tenantId: TENANT, tenantSlug: "harmon", authUserId: user.profile, user, access: accessBlock(resolveScope(user, TENANT)) };
    },
  },
});

function builder(name) {
  const st = { op: "select", filters: [] };
  const b = {
    select() { return b; },
    insert(rows) { st.op = "insert"; st.rows = Array.isArray(rows) ? rows : [rows]; return b; },
    delete() { st.op = "delete"; return b; },
    eq(c, v) { st.filters.push((r) => r[c] === v); return b; },
    lt(c, v) { st.filters.push((r) => r[c] < v); return b; },
    then(resolve, reject) { return Promise.resolve().then(exec).then(resolve, reject); },
  };
  function exec() {
    const rows = (ctx.tables[name] ??= []);
    if (st.op === "insert") {
      const out = st.rows.map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...r }));
      rows.push(...out);
      return { data: out, error: null };
    }
    const hit = rows.filter((r) => st.filters.every((f) => f(r)));
    if (st.op === "delete") for (const r of hit) rows.splice(rows.indexOf(r), 1);
    return { data: structuredClone(hit), error: null };
  }
  return b;
}
mock.module("../../lib/supabase.js", {
  namedExports: {
    getSupabaseClient: async () => ({
      rpc: async (name, args) => {
        ctx.rpcCalls.push({ name, args: structuredClone(args) });
        if (name === "sundial_report_assist_claim") return { data: ctx.claim, error: null };
        if (name === "sundial_report_assist_release") return { data: null, error: null };
        throw new Error(`unexpected rpc ${name}`);
      },
      from: (t) => builder(t),
    }),
  },
});

const { handler } = await import("./index.js");
const { _setAssistDeps, cleanupAssist, LOG_RETENTION_DAYS } = await import("./assist.js");
const { AssistNotConfiguredError, keyFromSecret, getAnthropicClient, _resetAnthropicClient, assistModel, ASSIST_MODEL } = await import("../../lib/anthropic.js");
const { _resetStrictMemory } = await import("../../lib/report-assist.js");

const fakeClient = {
  beta: {
    messages: {
      create: async (req) => {
        ctx.modelCalls.push(req);
        const step = ctx.script.shift();
        if (!step) throw new Error("script ran out");
        if (step.throw) throw step.throw;
        return step;
      },
    },
  },
};
_setAssistDeps({
  getAnthropicClient: async () => {
    if (ctx.notConfigured) throw new AssistNotConfiguredError("sundial/anthropic has no api_key");
    return fakeClient;
  },
  now: () => new Date("2026-11-10T17:00:00Z"),
});

const usage = { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 };
const proposal = (input) => ({ stop_reason: "tool_use", model: "claude-sonnet-5-5", usage, content: [{ type: "tool_use", id: "tu_1", name: "propose_report", input }] });
const CUSTOMERS_NO_DEALER = {
  summary: "Customers who have no dealer.", type: "customers", columns: ["customer.name", "customer.city", "customer.stage"],
  filters: [{ field: "customer.dealer_sf_id", op: "is_blank", value: null }], groupBy: [], aggregates: [], sort: [], limit: 5000,
};

const ev = (body, { method = "POST", path = "/reports/assist" } = {}) => ({
  httpMethod: method, path, headers: { Origin: "http://localhost:5173", Authorization: "Bearer x" },
  body: body === undefined ? null : JSON.stringify(body),
});
const call = async (body, opts) => {
  const res = await handler(ev(body, opts));
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const BUILD = { mode: "build", type: "customers", messages: [{ role: "user", content: "customers with no dealer" }] };

test.beforeEach(() => _resetStrictMemory());

test("route: POST only", async () => {
  reset();
  assert.equal((await call(undefined, { method: "GET" })).status, 405);
  assert.equal((await handler(ev(undefined, { method: "OPTIONS" }))).statusCode, 204);
});

test("reports.ai: sales and tech levels are 403 before any claim or model call", async () => {
  for (const level of ["Sales Rep", "Sales Dealer", "Technician"]) {
    reset(level);
    const r = await call(BUILD);
    assert.equal(r.status, 403, level);
    assert.equal(r.body.code, "MODULE_FORBIDDEN");
    assert.equal(ctx.rpcCalls.length, 0);
    assert.equal(ctx.modelCalls.length, 0);
  }
});

test("a bad body is a 400: no turn claimed, no model call", async () => {
  reset();
  const r = await call({ mode: "build", messages: [] });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "BAD_ASSIST_REQUEST");
  assert.equal(ctx.rpcCalls.length, 0);
  const r2 = await call({ mode: "explain", currentDefinition: { type: "solar", columns: ["solar.nope"] } });
  assert.equal(r2.status, 400);
  assert.equal(r2.body.field, "currentDefinition.columns[0]");
  assert.equal(ctx.rpcCalls.length, 0);
});

test("not configured (no sundial/anthropic key): 503, no turn", async () => {
  reset();
  ctx.notConfigured = true;
  const r = await call(BUILD);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "ASSIST_NOT_CONFIGURED");
  assert.equal(ctx.rpcCalls.length, 0);
});

test("budget exhausted: 429 with scope / limit / resetsAt, and the model is never called", async () => {
  reset();
  ctx.claim = { ok: false, scope: "user", limit: 40, used: 40, resets_at: "2026-11-11T07:00:00+00:00" };
  const r = await call(BUILD);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, "ASSIST_BUDGET_EXHAUSTED");
  assert.equal(r.body.scope, "user");
  assert.equal(r.body.limit, 40);
  assert.equal(r.body.resetsAt, "2026-11-11T07:00:00+00:00");
  assert.match(r.body.message, /build reports by hand/);
  assert.equal(ctx.modelCalls.length, 0);
  assert.equal(ctx.tables.sundial_report_assist_log.length, 0);
});

test("a turn: claim (identity's tenant + profile) → model → the validated definition; the log row has the tokens", async () => {
  for (const level of ["Executive", "Admin", "Manager"]) {
    reset(level);
    ctx.script = [proposal(CUSTOMERS_NO_DEALER)];
    const r = await call(BUILD);
    assert.equal(r.status, 200, level);
    assert.deepEqual(ctx.rpcCalls, [{ name: "sundial_report_assist_claim", args: { p_client_sf_id: TENANT, p_profile_id: USERS[level].profile } }]);
    assert.equal(r.body.outcome, "definition");
    assert.deepEqual(r.body.definition, {
      type: "customers", columns: ["customer.name", "customer.city", "customer.stage"],
      filters: [{ field: "customer.dealer_sf_id", op: "is_blank" }],
    });
    assert.equal(r.body.reply, "Customers who have no dealer.");
    assert.equal(r.body.usage.inputTokens, 900);
    assert.equal(r.body.usage.cacheReadTokens, 40_000);
    assert.deepEqual(r.body.budget, { tenantUsed: 3, tenantLimit: 500, userUsed: 1, userLimit: 40 });
    const [log] = ctx.tables.sundial_report_assist_log;
    assert.equal(log.client_sf_id, TENANT);
    assert.equal(log.profile_id, USERS[level].profile);
    assert.equal(log.mode, "build");
    assert.equal(log.request_text, "customers with no dealer");
    assert.equal(log.outcome, "definition");
    assert.deepEqual(log.definition, r.body.definition);
    assert.equal(log.input_tokens, 900);
    assert.equal(log.output_tokens, 300);
    assert.equal(log.cache_read_tokens, 40_000);
    assert.equal(log.model, "claude-sonnet-5-5");
    assert.equal(log.strict, true);
  }
});

test("an upstream failure releases the turn with the claimed periods: 502 ASSIST_UPSTREAM, logged as error", async () => {
  reset();
  ctx.script = [{ throw: Object.assign(new Error("Overloaded"), { status: 529 }) }];
  const r = await call(BUILD);
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "ASSIST_UPSTREAM");
  assert.deepEqual(ctx.rpcCalls.map((c) => c.name), ["sundial_report_assist_claim", "sundial_report_assist_release"]);
  assert.deepEqual(ctx.rpcCalls[1].args, { p_client_sf_id: TENANT, p_profile_id: USERS.Admin.profile, p_month_start: "2026-11-01", p_day: "2026-11-10" });
  assert.equal(ctx.tables.sundial_report_assist_log[0].outcome, "error");
  assert.deepEqual(ctx.tables.sundial_report_assist_log[0].codes, ["UPSTREAM_529"]);
});

test("a refusal or a question still counts: no release", async () => {
  reset();
  ctx.script = [{ stop_reason: "refusal", model: "claude-sonnet-5-5", usage, content: [] }];
  const r = await call(BUILD);
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, "refused");
  assert.deepEqual(ctx.rpcCalls.map((c) => c.name), ["sundial_report_assist_claim"]);
  reset();
  ctx.script = [{ stop_reason: "tool_use", model: "m", usage, content: [{ type: "tool_use", id: "q", name: "ask_question", input: { question: "Which period?" } }] }];
  const q = await call(BUILD);
  assert.equal(q.body.outcome, "question");
  assert.equal(q.body.question, "Which period?");
  assert.deepEqual(ctx.rpcCalls.map((c) => c.name), ["sundial_report_assist_claim"]);
});

test("explain: no request text logged; a paragraph back", async () => {
  reset();
  ctx.script = [{ stop_reason: "end_turn", model: "m", usage, content: [{ type: "text", text: "This report lists customers with no dealer." }] }];
  const r = await call({ mode: "explain", currentDefinition: { type: "customers", columns: ["customer.name"], filters: [{ field: "customer.dealer_sf_id", op: "is_blank" }] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, "explained");
  assert.equal(ctx.tables.sundial_report_assist_log[0].request_text, null);
});

test("cleanup: log rows and per-user day counters older than 90 days go; month counters stay", async () => {
  reset();
  const now = new Date("2026-11-10T17:00:00Z");
  const old = new Date(now.getTime() - (LOG_RETENTION_DAYS + 1) * 86_400_000).toISOString();
  ctx.tables.sundial_report_assist_log = [{ id: "a", created_at: old }, { id: "b", created_at: now.toISOString() }];
  ctx.tables.sundial_report_assist_usage = [
    { period_kind: "day", period_start: "2026-07-01" }, { period_kind: "day", period_start: "2026-11-09" },
    { period_kind: "month", period_start: "2026-01-01" },
  ];
  const { getSupabaseClient } = await import("../../lib/supabase.js");
  const out = await cleanupAssist(await getSupabaseClient(), now);
  assert.deepEqual(out, { logs: 1, days: 1 });
  assert.deepEqual(ctx.tables.sundial_report_assist_log.map((r) => r.id), ["b"]);
  assert.equal(ctx.tables.sundial_report_assist_usage.length, 2);
});

test("lib/anthropic.js: api_key first, apiKey second; a missing key never echoes a value; the model is config", async () => {
  assert.equal(keyFromSecret({ api_key: " sk-a ", apiKey: "sk-b" }), "sk-a");
  assert.equal(keyFromSecret({ apiKey: "sk-b" }), "sk-b");
  assert.equal(keyFromSecret({ api_key: "" }), null);
  assert.equal(keyFromSecret(null), null);
  _resetAnthropicClient();
  await assert.rejects(getAnthropicClient({ readSecret: async () => ({ other: "sk-secret-value" }) }), (e) => e.code === "ASSIST_NOT_CONFIGURED" && !e.message.includes("sk-secret-value"));
  _resetAnthropicClient();
  await assert.rejects(getAnthropicClient({ readSecret: async () => { throw Object.assign(new Error("AccessDenied sk-x"), { name: "AccessDeniedException" }); } }), (e) => e.code === "ASSIST_NOT_CONFIGURED" && !e.message.includes("sk-x"));
  _resetAnthropicClient();
  const c = await getAnthropicClient({ readSecret: async () => ({ api_key: "sk-test" }) });
  assert.equal(typeof c.beta.messages.create, "function");
  _resetAnthropicClient();
  assert.equal(assistModel({}), ASSIST_MODEL);
  assert.equal(ASSIST_MODEL, "claude-sonnet-5-5");
  assert.equal(assistModel({ REPORT_ASSIST_MODEL: "claude-sonnet-5" }), "claude-sonnet-5");
});
