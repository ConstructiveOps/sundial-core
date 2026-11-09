// lib/salesforce.js — the upstream budgets (2026-11-09): a call that does not answer in time
// fails with an error that names it, instead of hanging until Lambda kills the container.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithTimeout, sfFetchTimeoutMs, SF_TOKEN_TIMEOUT_MS } from "./salesforce.js";

test("fetchWithTimeout: a hung fetch becomes a named UPSTREAM_TIMEOUT error within the budget", async () => {
  const realFetch = globalThis.fetch;
  // A real socket keeps the event loop alive; the fake needs a timer to stand in for it
  // (AbortSignal.timeout's own timer is unref'd, so without this the process would just end).
  globalThis.fetch = (_url, init) => new Promise((_, reject) => {
    const keepAlive = setTimeout(() => {}, 5000);
    init.signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })); });
  });
  try {
    const t0 = Date.now();
    await assert.rejects(fetchWithTimeout("Salesforce token request", "https://login.example", { method: "POST" }, 50), (e) => e.code === "UPSTREAM_TIMEOUT" && /Salesforce token request timed out after 0 s/.test(e.message));
    assert.ok(Date.now() - t0 < 1000, "failed fast");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchWithTimeout: a normal response passes through; any other error is untouched", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "{}" });
  try {
    assert.equal((await fetchWithTimeout("x", "https://example", {}, 1000)).status, 200);
    globalThis.fetch = async () => { throw new Error("ENOTFOUND"); };
    await assert.rejects(fetchWithTimeout("x", "https://example", {}, 1000), /ENOTFOUND/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the query budget is SF_FETCH_TIMEOUT_MS, 60 s when unset; the token budget is fixed", () => {
  const prev = process.env.SF_FETCH_TIMEOUT_MS;
  delete process.env.SF_FETCH_TIMEOUT_MS;
  assert.equal(sfFetchTimeoutMs(), 60_000);
  process.env.SF_FETCH_TIMEOUT_MS = "25000";
  assert.equal(sfFetchTimeoutMs(), 25_000);
  process.env.SF_FETCH_TIMEOUT_MS = "nope";
  assert.equal(sfFetchTimeoutMs(), 60_000);
  if (prev === undefined) delete process.env.SF_FETCH_TIMEOUT_MS; else process.env.SF_FETCH_TIMEOUT_MS = prev;
  assert.equal(SF_TOKEN_TIMEOUT_MS, 15_000);
});
