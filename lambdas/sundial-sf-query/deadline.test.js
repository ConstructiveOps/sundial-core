// 2026-11-25, the second sundial-sf-query-errors alarm: no request dies silently at 30 s.
//   - the request deadline answers 503 UPSTREAM_TIMEOUT with ONE "req":"deadline" line
//     (cause "deadline") naming the route, the phase and the calls still waiting;
//   - a single call that runs out of its budget answers the same 503 with the same line
//     (cause "call"), so one metric filter { $.req = "deadline" } counts both;
//   - the in-flight list is per request: work a deadline cut off, resuming during the NEXT
//     request, never shows up in that request's line, and never writes a line of its own;
//   - the single list filter is typed from the describe (Is_Template__c = true, unquoted)
//     on the Salesforce path, and the cache path filters the boolean the same way.
//
// Run with:  node --experimental-test-module-mocks --test lambdas/sundial-sf-query/deadline.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { trackUpstream, noteUpstreamTimeout, upstreamTimeoutError } from "../../lib/upstream.js";

const TENANT = "a0XharmonTENANT";
const ctx = {
  soql: [],
  queries: [],
  // table -> { data, count, error } for the list query, or a function(rec) returning one / a promise
  answer: {},
  sfQuery: null, // optional override (soql) => Promise
};
function reset() {
  ctx.soql = [];
  ctx.queries = [];
  ctx.answer = {};
  ctx.sfQuery = null;
  delete process.env.ACCESS_MODEL_MODE;
}

mock.module("../../lib/identity.js", {
  namedExports: {
    resolveIdentity: async () => ({
      user: { id: "u1", hierarchyLevel: "Client", accessLevel: "Admin", dealer: null },
      tenantId: TENANT,
      tenantSlug: "harmon",
      access: null,
    }),
  },
});
mock.module("../../lib/salesforce.js", {
  namedExports: {
    soqlEscapeString: (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    getSalesforceToken: async () => ({ access_token: "tok", instance_url: "https://example.my.salesforce.com" }),
    sfQuery: async (soql) => {
      ctx.soql.push(soql);
      if (ctx.sfQuery) return ctx.sfQuery(soql);
      if (/COUNT\(Id\)/.test(soql)) return [{ c: 0 }];
      return [];
    },
  },
});

// A thenable PostgREST stand-in: every builder method records itself and returns the
// builder; awaiting it (or .range()) answers from ctx.answer[table].
function makeBuilder(table) {
  const rec = { table, ops: [] };
  ctx.queries.push(rec);
  const settle = () => {
    const a = ctx.answer[table];
    const v = typeof a === "function" ? a(rec) : a;
    return Promise.resolve(v ?? { data: [], count: 0, error: null });
  };
  const b = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (res, rej) => settle().then(res, rej);
      if (prop === "range") return (...args) => { rec.ops.push(["range", ...args]); return settle(); };
      return (...args) => { rec.ops.push([prop, ...args]); return b; };
    },
  });
  return b;
}
mock.module("../../lib/supabase.js", {
  namedExports: {
    getSupabaseClient: async () => ({ from: (t) => makeBuilder(t) }),
    getSupabaseConfig: async () => ({ url: "https://supa.example.co", serviceRoleKey: "svc" }),
  },
});

const ESTIMATE_COLS = ["sf_id", "client_sf_id", "created_date", "is_stale", "last_synced_at", "cache_version", "name", "is_template", "total", "expires_on", "sundial_customer_sf_id"];
const ESTIMATE_FIELDS = [
  { name: "Id", type: "id" },
  { name: "Name", type: "string" },
  { name: "Is_Template__c", type: "boolean" },
  { name: "Total__c", type: "currency" },
  { name: "Expires_On__c", type: "date" },
  { name: "Client__c", type: "reference" },
  { name: "Sundial_Customer__c", type: "reference" },
  { name: "CreatedDate", type: "datetime" },
];
globalThis.fetch = async (url) => {
  if (String(url).includes("/rest/v1/")) {
    return { ok: true, status: 200, json: async () => ({ definitions: { sundial_estimate_cache: { properties: Object.fromEntries(ESTIMATE_COLS.map((c) => [c, {}])) } } }) };
  }
  return { ok: true, status: 200, json: async () => ({ fields: ESTIMATE_FIELDS }) };
};

const { handler, requestDeadlineMs, REQUEST_DEADLINE_MS } = await import("./index.js");

function listEvent(qs) {
  return {
    requestContext: { http: { method: "GET" } },
    rawPath: "/sf/estimate",
    pathParameters: { object: "estimate" },
    queryStringParameters: qs,
    headers: { authorization: "Bearer test.jwt", origin: "http://localhost:5173" },
  };
}
function singleEvent(id) {
  return {
    requestContext: { http: { method: "GET" } },
    rawPath: `/sf/estimate/${id}`,
    pathParameters: { object: "estimate", id },
    queryStringParameters: {},
    headers: { authorization: "Bearer test.jwt", origin: "http://localhost:5173" },
  };
}
/** A Lambda context with `ms` of budget left before the margin. */
const shortContext = (ms) => ({ getRemainingTimeInMillis: () => 2500 + ms });

/** Capture console.log / console.error lines while `fn` runs. */
async function captureLogs(fn) {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}
const deadlineLines = (lines) => lines.filter((l) => l.startsWith("{") && JSON.parse(l).req === "deadline").map((l) => JSON.parse(l));

/** A call that waits (tracked as `label` on whichever request started it) until released. */
function hangingCall(label) {
  let release;
  const promise = new Promise((resolve, reject) => {
    release = { resolve, reject };
  });
  return {
    run: async () => {
      const done = trackUpstream(label);
      try {
        return await promise;
      } finally {
        done();
      }
    },
    release: (v) => release.resolve(v),
    fail: (e) => release.reject(e),
  };
}

test.beforeEach(reset);

test("the deadline: budget is 26 s, or the Lambda's remaining time less 2.5 s, whichever is sooner", () => {
  assert.equal(REQUEST_DEADLINE_MS, 26_000);
  assert.equal(requestDeadlineMs(undefined), 26_000);
  assert.equal(requestDeadlineMs({ getRemainingTimeInMillis: () => 30_000 }), 26_000);
  assert.equal(requestDeadlineMs({ getRemainingTimeInMillis: () => 10_000 }), 7_500);
  assert.equal(requestDeadlineMs({ getRemainingTimeInMillis: () => 1_000 }), 0);
});

test("a stalled cache read: 503 UPSTREAM_TIMEOUT and ONE deadline line with route, phase and the waiting call — no record id", async () => {
  const stall = hangingCall("Supabase GET sundial_estimate_cache");
  ctx.answer.sundial_estimate_cache = () => stall.run();
  const id = "a1E7y00000ABCDEFGH";
  const { result: res, lines } = await captureLogs(() => handler(singleEvent(id), shortContext(80)));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { error: "upstream_timeout", code: "UPSTREAM_TIMEOUT" });
  const dl = deadlineLines(lines);
  assert.equal(dl.length, 1);
  assert.equal(dl[0].cause, "deadline");
  assert.equal(dl[0].route, "GET /sf/estimate/{id}");
  assert.equal(dl[0].phase, "route:single");
  assert.deepEqual(dl[0].inflight.map((c) => c.call), ["Supabase GET sundial_estimate_cache"]);
  assert.ok(dl[0].inflight[0].ms >= 0);
  assert.deepEqual(dl[0].timedOut, []);
  assert.ok(!lines.some((l) => l.includes(id)), "the log never carries the record id");
  // Left stalled on purpose: released, the cut-off work would resume during the NEXT test
  // (exactly what Lambda does) and its Salesforce call would land in that test's ctx.
});

test("a single call out of budget (thrown): 503 and the same line with cause \"call\"", async () => {
  ctx.answer.sundial_estimate_cache = { data: [], count: 0, error: null };
  ctx.sfQuery = async () => {
    noteUpstreamTimeout("Salesforce query");
    throw upstreamTimeoutError("Salesforce query", 15_000);
  };
  const { result: res, lines } = await captureLogs(() => handler(listEvent({}), shortContext(5_000)));
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).code, "UPSTREAM_TIMEOUT");
  const dl = deadlineLines(lines);
  assert.equal(dl.length, 1);
  assert.equal(dl[0].cause, "call");
  assert.equal(dl[0].route, "GET /sf/estimate");
  assert.equal(dl[0].phase, "route:list");
  assert.deepEqual(dl[0].timedOut, ["Salesforce query"]);
  assert.equal(ctx.soql.length, 1, "a COUNT that timed out stops the request — no second budget spent on the SELECT");
  assert.ok(!lines.some((l) => l.includes("sf-query unexpected error")), "a timeout is not logged as an unexpected error");
});

test("a Supabase {error} a route rethrows after its call timed out is a 503 too (message only, no code)", async () => {
  ctx.answer.sundial_estimate_cache = { data: [], count: 0, error: null };
  ctx.sfQuery = async () => {
    // What a route sees when supabase-js swallowed the AbortError into { error } and the
    // route rethrew its message.
    throw new Error("cache: AbortError: Supabase request timed out after 10 s");
  };
  const { result: res, lines } = await captureLogs(() => handler(listEvent({}), shortContext(5_000)));
  assert.equal(res.statusCode, 503);
  assert.equal(deadlineLines(lines)[0].cause, "call");
});

test("any other error is still a 500 with no deadline line", async () => {
  ctx.answer.sundial_estimate_cache = { data: [], count: 0, error: null };
  ctx.sfQuery = async () => { throw new Error("Salesforce query failed (400)"); };
  const { result: res, lines } = await captureLogs(() => handler(listEvent({}), shortContext(5_000)));
  assert.equal(res.statusCode, 500);
  assert.equal(deadlineLines(lines).length, 0);
});

test("per request: work cut off by the deadline that resumes during the NEXT request never reaches its line, and writes none of its own", async () => {
  // Request 1 stalls on Salesforce and is cut off.
  ctx.answer.sundial_estimate_cache = { data: [], count: 0, error: null };
  const first = hangingCall("Salesforce query");
  let lateCall = null;
  ctx.sfQuery = async () => {
    await first.run();
    // Resumes late: starts ANOTHER call, which then times out.
    lateCall = hangingCall("Salesforce describe");
    const p = lateCall.run();
    noteUpstreamTimeout("Salesforce describe");
    lateCall.fail(upstreamTimeoutError("Salesforce describe", 15_000));
    return p;
  };
  const r1 = await captureLogs(() => handler(listEvent({}), shortContext(60)));
  assert.equal(r1.result.statusCode, 503);
  assert.deepEqual(deadlineLines(r1.lines).map((l) => l.inflight.map((c) => c.call)), [["Salesforce query"]]);

  // Request 2 stalls on Supabase; request 1's work resumes (and fails) DURING it.
  const second = hangingCall("Supabase GET sundial_estimate_cache");
  ctx.sfQuery = null;
  ctx.answer.sundial_estimate_cache = () => {
    setTimeout(() => first.release([]), 10); // the old request wakes up mid-request
    return second.run();
  };
  const r2 = await captureLogs(() => handler(listEvent({}), shortContext(120)));
  assert.equal(r2.result.statusCode, 503);
  assert.ok(lateCall, "the old request really did resume and start its late call during request 2");
  const dl = deadlineLines(r2.lines);
  assert.equal(dl.length, 1, "only request 2's own line — the old work wrote nothing");
  assert.equal(dl[0].cause, "deadline");
  assert.deepEqual(dl[0].inflight.map((c) => c.call), ["Supabase GET sundial_estimate_cache"], "never the old request's calls");
  assert.deepEqual(dl[0].timedOut, [], "never the old request's timeouts");
  assert.ok(!r2.lines.some((l) => l.includes("sf-query unexpected error")), "the old request's late error is silent");
  second.release({ data: [], count: 0, error: null });

  // Request 3 is normal: no line, and the earlier timeouts are not carried in.
  ctx.answer.sundial_estimate_cache = { data: [{ sf_id: "a1E1", client_sf_id: TENANT, name: "EST-1" }], count: 1, error: null };
  const r3 = await captureLogs(() => handler(listEvent({}), shortContext(5_000)));
  assert.equal(r3.result.statusCode, 200);
  assert.equal(deadlineLines(r3.lines).length, 0);
});

// --- the single filter, typed from the describe -----------------------------------------

test("Is_Template__c=true on Sundial_Estimate__c (cold tenant): the COUNT and the SELECT carry it UNQUOTED", async () => {
  // Nothing cached for the tenant at all → the Salesforce path.
  ctx.answer.sundial_estimate_cache = { data: [], count: 0, error: null };
  const res = await handler(listEvent({ field: "Is_Template__c", value: "true" }), shortContext(5_000));
  assert.equal(res.statusCode, 200);
  const count = ctx.soql.find((s) => /COUNT\(Id\)/.test(s));
  const select = ctx.soql.find((s) => /^SELECT (?!COUNT)/.test(s));
  assert.ok(count && select, "both queries ran");
  for (const s of [count, select]) {
    assert.match(s, /FROM Sundial_Estimate__c WHERE/);
    assert.match(s, /AND Is_Template__c = true\b/);
    assert.doesNotMatch(s, /Is_Template__c = 'true'/);
  }
});

test("TRUE is lower-cased; the cache path filters the boolean column with the same value", async () => {
  ctx.answer.sundial_estimate_cache = { data: [{ sf_id: "a1E1", client_sf_id: TENANT, is_template: true, is_stale: false, last_synced_at: new Date().toISOString() }], count: 1, error: null };
  const res = await handler(listEvent({ field: "is_template__c", value: "TRUE" }), shortContext(5_000));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).source, "cache");
  const list = ctx.queries.find((q) => q.table === "sundial_estimate_cache");
  assert.ok(list.ops.some(([op, c, v]) => op === "eq" && c === "is_template" && v === "true"), JSON.stringify(list.ops));
  assert.equal(ctx.soql.length, 0, "a warm cache never asks Salesforce");
});

test("a value that does not fit the field's type is 400 INVALID_FILTER_VALUE before anything runs", async () => {
  for (const [field, value] of [["Is_Template__c", "yes"], ["Total__c", "12abc"], ["Expires_On__c", "next week"]]) {
    reset();
    const res = await handler(listEvent({ field, value }), shortContext(5_000));
    assert.equal(res.statusCode, 400, `${field}=${value}`);
    assert.equal(JSON.parse(res.body).code, "INVALID_FILTER_VALUE");
    assert.equal(ctx.soql.length, 0);
    assert.ok(!ctx.queries.some((q) => q.table === "sundial_estimate_cache"), "no cache query either");
  }
});

test("numbers and dates go unquoted; text stays quoted and escaped", async () => {
  const cases = [
    ["Total__c", "1250.50", "Total__c = 1250.50"],
    ["Expires_On__c", "2026-12-01", "Expires_On__c = 2026-12-01"],
    ["Name", "O'Neil", "Name = 'O\\'Neil'"],
  ];
  for (const [field, value, clause] of cases) {
    reset();
    ctx.answer.sundial_estimate_cache = { data: [], count: 0, error: null };
    const res = await handler(listEvent({ field, value }), shortContext(5_000));
    assert.equal(res.statusCode, 200, field);
    for (const s of ctx.soql) assert.ok(s.includes(` AND ${clause}`), `${field}: ${s}`);
  }
});

test("an empty filtered page on a WARM tenant answers empty from the cache — no Salesforce call (the templates list)", async () => {
  // The filtered page is empty, but the tenant has estimates cached.
  ctx.answer.sundial_estimate_cache = (rec) =>
    rec.ops.some(([op, , opts]) => op === "select" && opts?.head)
      ? { data: null, count: 412, error: null }
      : { data: [], count: 0, error: null };
  const res = await handler(listEvent({ field: "Is_Template__c", value: "true" }), shortContext(5_000));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.source, "cache");
  assert.equal(body.total, 0);
  assert.equal(ctx.soql.length, 0);
});
