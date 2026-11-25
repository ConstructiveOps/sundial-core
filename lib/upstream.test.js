// lib/upstream.js (2026-11-25): the Supabase budget, the per-request in-flight list, and the
// Salesforce describe on a budget.
// Run with:  node --experimental-test-module-mocks --test lib/upstream.test.js

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import {
  createTimedFetch,
  supabaseFetchTimeoutMs,
  supabaseCallLabel,
  newRequestStore,
  runWithRequest,
  trackUpstream,
  inflightSnapshot,
  isUpstreamTimeout,
  upstreamTimeoutError,
} from "./upstream.js";

/** A fetch that never answers until aborted (with a ref'd timer standing in for the socket). */
function hangingFetch(calls) {
  return (_url, init) => new Promise((_, reject) => {
    calls.push(String(_url));
    const keepAlive = setTimeout(() => {}, 5000);
    init.signal.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      reject(init.signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });
}

test("the Supabase budget is SUPABASE_FETCH_TIMEOUT_MS, 60 s when unset or nonsense", () => {
  const prev = process.env.SUPABASE_FETCH_TIMEOUT_MS;
  delete process.env.SUPABASE_FETCH_TIMEOUT_MS;
  assert.equal(supabaseFetchTimeoutMs(), 60_000);
  process.env.SUPABASE_FETCH_TIMEOUT_MS = "10000";
  assert.equal(supabaseFetchTimeoutMs(), 10_000);
  process.env.SUPABASE_FETCH_TIMEOUT_MS = "soon";
  assert.equal(supabaseFetchTimeoutMs(), 60_000);
  if (prev === undefined) delete process.env.SUPABASE_FETCH_TIMEOUT_MS; else process.env.SUPABASE_FETCH_TIMEOUT_MS = prev;
});

test("a stalled Supabase call fails within its budget as a named AbortError with code UPSTREAM_TIMEOUT", async () => {
  const calls = [];
  const timed = createTimedFetch(50, hangingFetch(calls));
  const t0 = Date.now();
  await assert.rejects(timed("https://x.supabase.co/rest/v1/sundial_job_cache?select=*", { method: "GET" }), (e) =>
    e.name === "AbortError" && e.code === "UPSTREAM_TIMEOUT" && /^Supabase request timed out after 0 s$/.test(e.message) && e.upstream === "Supabase GET sundial_job_cache");
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(isUpstreamTimeout(upstreamTimeoutError("x", 1000)));
});

test("through the real supabase-js client: ONE attempt (no retries), and { error } names Supabase", async () => {
  const calls = [];
  const client = createClient("https://x.supabase.co", "svc", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: createTimedFetch(50, hangingFetch(calls)) },
  });
  const t0 = Date.now();
  const { error } = await client.from("sundial_job_cache").select("sf_id").eq("client_sf_id", "T");
  assert.ok(error, "an error, not a hang");
  assert.match(error.message, /Supabase request timed out after 0 s/);
  assert.ok(isUpstreamTimeout(new Error(`job: ${error.message}`)), "a rethrown message is still recognised");
  assert.equal(calls.length, 1, "postgrest-js does not retry an AbortError (it would retry any other GET failure 3 more times)");
  assert.ok(Date.now() - t0 < 1000);
});

test("a caller's own abort signal still works alongside the budget; other errors pass through untouched", async () => {
  const ac = new AbortController();
  const timed = createTimedFetch(10_000, hangingFetch([]));
  const p = timed("https://x.supabase.co/rest/v1/t", { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => e.code !== "UPSTREAM_TIMEOUT");
  const failing = createTimedFetch(10_000, async () => { throw new Error("ENOTFOUND"); });
  await assert.rejects(failing("https://x.supabase.co/rest/v1/t"), /ENOTFOUND/);
  const ok = createTimedFetch(10_000, async () => ({ status: 200 }));
  assert.equal((await ok("https://x.supabase.co/rest/v1/t")).status, 200);
});

test("labels name the table or function, never the query string or an id", () => {
  assert.equal(supabaseCallLabel("https://x.supabase.co/rest/v1/sundial_customer_cache?sf_id=eq.a1P7y00000AmyXCEAZ", { method: "GET" }), "Supabase GET sundial_customer_cache");
  assert.equal(supabaseCallLabel("https://x.supabase.co/rest/v1/rpc/sundial_solar_pipeline", { method: "POST" }), "Supabase POST rpc sundial_solar_pipeline");
  assert.equal(supabaseCallLabel("https://x.supabase.co/rest/v1/", {}), "Supabase GET (schema)");
  assert.equal(supabaseCallLabel("https://x.supabase.co/auth/v1/user", {}), "Supabase auth");
  assert.equal(supabaseCallLabel("not a url", {}), "Supabase request");
});

test("the in-flight list is per request: a late finish or a late call from an earlier request never touches a later one", async () => {
  const r1 = newRequestStore();
  const r2 = newRequestStore();
  let finishOld;
  let lateWork;
  await runWithRequest(r1, async () => {
    finishOld = trackUpstream("Salesforce query");
    // Work that will resume later, still inside request 1's async context.
    lateWork = new Promise((resolve) => setTimeout(resolve, 20)).then(() => trackUpstream("Salesforce describe"));
  });
  assert.deepEqual(inflightSnapshot(r1).map((c) => c.call), ["Salesforce query"]);
  await runWithRequest(r2, async () => {
    const done = trackUpstream("Supabase GET sundial_job_cache");
    finishOld(); // request 1's call finishes during request 2
    await lateWork; // request 1's work starts a NEW call during request 2
    assert.deepEqual(inflightSnapshot(r2).map((c) => c.call), ["Supabase GET sundial_job_cache"], "only request 2's own call");
    done();
  });
  assert.deepEqual(inflightSnapshot(r2), []);
  assert.deepEqual(inflightSnapshot(r1).map((c) => c.call), ["Salesforce describe"], "the late call is on request 1's own store");
  // Outside any request (cache-sync, scripts): tracking is a no-op.
  const noop = trackUpstream("x");
  noop();
});

// --- the Salesforce describes on a budget (were a bare fetch) ---------------------------

mock.module("./secrets.js", {
  namedExports: {
    getSecret: async () => ({ consumer_key: "ck", username: "u", private_key: "pk", login_url: "https://login.example" }),
    SECRET_TIMEOUT_MS: 10_000,
    clearSecretCache: () => {},
  },
});
mock.module("./supabase.js", {
  namedExports: { getSupabaseConfig: async () => ({ url: "https://x.supabase.co", serviceRoleKey: "svc" }) },
});

test("cache-read: a FAILED schema read is forgotten, so the next request retries instead of failing for the container's life", async () => {
  const prevFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ definitions: { sundial_job_cache: { properties: { sf_id: {}, name: {} } } } }) };
  };
  try {
    const { getCacheColumns } = await import("./cache-read.js");
    await assert.rejects(getCacheColumns("sundial_job_cache"), /OpenAPI fetch failed \(503\)/);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([...(await getCacheColumns("sundial_job_cache"))], ["sf_id", "name"]);
    assert.equal(n, 2);
  } finally {
    globalThis.fetch = prevFetch;
  }
});
mock.module("jsonwebtoken", { defaultExport: { sign: () => "signed.jwt" } });

test("describeObject (lib/salesforce.js) and getRawDescribe (lib/sf-describe.js) time out by name", async () => {
  const prevFetch = globalThis.fetch;
  const prevBudget = process.env.SF_FETCH_TIMEOUT_MS;
  process.env.SF_FETCH_TIMEOUT_MS = "50";
  globalThis.fetch = (url, init) => {
    if (String(url).includes("/oauth2/token")) {
      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: "t", instance_url: "https://org.example" }), json: async () => ({ access_token: "t", instance_url: "https://org.example" }) });
    }
    return hangingFetch([])(url, init);
  };
  try {
    const { describeObject } = await import("./salesforce.js");
    const { getRawDescribe } = await import("./sf-describe.js");
    const store = newRequestStore();
    await runWithRequest(store, async () => {
      await assert.rejects(describeObject("Sundial_Estimate__c", { forceRefresh: true }), (e) => e.code === "UPSTREAM_TIMEOUT" && /Salesforce describe timed out/.test(e.message));
      await assert.rejects(getRawDescribe("Sundial_Job__c"), (e) => e.code === "UPSTREAM_TIMEOUT" && /Salesforce describe timed out/.test(e.message));
    });
    assert.deepEqual(store.timedOut, ["Salesforce describe", "Salesforce describe"]);
    assert.deepEqual(inflightSnapshot(store), [], "finished calls leave the list");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevBudget === undefined) delete process.env.SF_FETCH_TIMEOUT_MS; else process.env.SF_FETCH_TIMEOUT_MS = prevBudget;
  }
});
