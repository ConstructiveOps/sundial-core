// lib/upstream.js — time budgets for every call that leaves the Lambda, and a per-request
// list of the calls still waiting.
//
// Why (2026-11-25, the second sundial-sf-query-errors alarm). For about 3.5 minutes every
// sf-query route sat until Lambda killed it at 30 s, and nothing in the logs said which
// upstream had stalled: the Supabase calls had no time limit at all, and the Salesforce
// describe used a bare fetch. Two things follow from that:
//
//   1. Every upstream call has a budget and, when it runs out, fails with an error that
//      NAMES it (`code: "UPSTREAM_TIMEOUT"`).
//   2. While a request runs, the calls it is waiting on are listed (label + start time),
//      so a request that runs out of time can say "still waiting on Supabase GET
//      sundial_job_cache for 24 s" instead of dying silently.
//
// The list is PER REQUEST, carried by AsyncLocalStorage. A request cut off by its
// deadline leaves its work running; on Lambda that work resumes when the container's NEXT
// request arrives. Because each request has its own store — and the async context follows
// the old work wherever it goes — the old request's late calls, late finishes and late
// timeouts land in the OLD store and can never show up in the new request's log line.
// Outside a request (cache-sync, scripts) there is no store and tracking is a no-op.
//
// Value-safety: a label is a fixed name or a table / function name. Never a URL, a query
// string, a record id or a key.

import { AsyncLocalStorage } from "node:async_hooks";

const requestStorage = new AsyncLocalStorage();

/** A fresh, empty per-request store. */
export function newRequestStore() {
  return { calls: new Map(), timedOut: [], phase: "start", settled: false, seq: 0 };
}

/** Run `fn` with `store` as the current request's store (everything it awaits inherits it). */
export function runWithRequest(store, fn) {
  return requestStorage.run(store, fn);
}

/** The current request's store, or null outside a request. */
export function currentRequest() {
  return requestStorage.getStore() ?? null;
}

/**
 * Register an upstream call as in flight on the CURRENT request. Returns the function that
 * marks it finished. The finish deletes from the store the call was registered on, so a
 * late finish from an earlier request never touches a later one.
 */
export function trackUpstream(label) {
  const store = currentRequest();
  if (!store) return () => {};
  const id = ++store.seq;
  store.calls.set(id, { call: label, startedAt: Date.now() });
  return () => { store.calls.delete(id); };
}

/** Remember that a call on the current request ran out of its budget. */
export function noteUpstreamTimeout(label) {
  const store = currentRequest();
  if (store) store.timedOut.push(label);
}

/** The calls still waiting on `store`, oldest first, with how long each has waited. */
export function inflightSnapshot(store, now = Date.now()) {
  if (!store) return [];
  return [...store.calls.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((c) => ({ call: c.call, ms: now - c.startedAt }));
}

/** The error an upstream call throws when it runs out of budget. */
export function upstreamTimeoutError(label, ms) {
  const err = new Error(`${label} timed out after ${Math.round(ms / 1000)} s`);
  err.code = "UPSTREAM_TIMEOUT";
  return err;
}

/** True for an error that is (or wraps) an upstream budget running out. */
export function isUpstreamTimeout(err) {
  if (!err) return false;
  if (err.code === "UPSTREAM_TIMEOUT") return true;
  // supabase-js turns a thrown fetch error into { error: { message: "AbortError: Supabase
  // request timed out after 10 s" } }; a caller that rethrows it keeps only the message.
  return /timed out after \d+ s/.test(String(err.message || ""));
}

// --- Salesforce budgets ----------------------------------------------------------------
// (Moved here from lib/salesforce.js, which re-exports them, so lib/sf-describe.js can use
// them without importing the whole Salesforce module.)

/**
 * The per-call Salesforce budget: env `SF_FETCH_TIMEOUT_MS`, 60 s when unset — a long
 * cache-sync page is legitimate; a request-serving Lambda sets it lower (sf-query: 15000).
 */
export function sfFetchTimeoutMs() {
  const n = Number(process.env.SF_FETCH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/** fetch() with a budget: tracked while in flight, a timeout becomes a named UPSTREAM_TIMEOUT. */
export async function fetchWithTimeout(label, url, init, ms) {
  const done = trackUpstream(label);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      noteUpstreamTimeout(label);
      throw upstreamTimeoutError(label, ms);
    }
    throw e;
  } finally {
    done();
  }
}

// --- Supabase budget -------------------------------------------------------------------

/**
 * The per-call Supabase budget: env `SUPABASE_FETCH_TIMEOUT_MS`, 60 s when unset (so the
 * cache sync's long upserts are not cut short); sf-query sets 10000.
 */
export function supabaseFetchTimeoutMs() {
  const n = Number(process.env.SUPABASE_FETCH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/** "Supabase GET sundial_job_cache" / "Supabase POST rpc sundial_solar_pipeline" / "Supabase auth". */
export function supabaseCallLabel(input, init) {
  const method = String(init?.method || (typeof input === "object" && input?.method) || "GET").toUpperCase();
  let path = "";
  try {
    path = new URL(typeof input === "string" ? input : input?.url ?? String(input)).pathname;
  } catch {
    path = "";
  }
  const rest = path.match(/^\/rest\/v1\/(rpc\/)?([A-Za-z0-9_]*)/);
  if (rest) {
    const name = rest[2] || "(schema)";
    return `Supabase ${method} ${rest[1] ? "rpc " : ""}${name}`;
  }
  const service = path.match(/^\/(auth|storage|realtime|functions)\//);
  return `Supabase ${service ? service[1] : "request"}`;
}

/**
 * A fetch for the Supabase client with a budget. The timeout error is NAMED "AbortError"
 * on purpose: postgrest-js retries a GET up to three more times after any other fetch
 * error (with backoff), which would turn one 10 s budget into ~40 s. An AbortError is
 * never retried, and supabase-js reports it as `{ error: { message: "AbortError: Supabase
 * request timed out after 10 s" } }`.
 */
export function createTimedFetch(ms = supabaseFetchTimeoutMs(), baseFetch = (...a) => fetch(...a)) {
  return async function timedFetch(input, init = {}) {
    const label = supabaseCallLabel(input, init);
    const done = trackUpstream(label);
    const timeout = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      return await baseFetch(input, { ...init, signal });
    } catch (e) {
      if (timeout.aborted) {
        noteUpstreamTimeout(label);
        const err = upstreamTimeoutError("Supabase request", ms);
        err.name = "AbortError";
        err.upstream = label;
        throw err;
      }
      throw e;
    } finally {
      done();
    }
  };
}
