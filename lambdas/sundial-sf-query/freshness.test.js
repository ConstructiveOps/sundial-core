// Tests for freshness.js — the D-079 read-time freshness rule.
//
// Run with:  npm test
//
// The two branches are the whole point: HEALTHY sync → the cache is authoritative (no
// per-row clock); NOT healthy → exactly the pre-D-079 10-minute TTL. A bug in either
// direction is silent in production (stale data shown, or the slow path forever), so
// both are pinned, plus the per-object bar (a 30-minute object is not judged by the
// 5-minute bar) and the 60-second memo.

import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveFreshness,
  isRowFresh,
  healthyBarMs,
  cacheTtlMs,
  defaultHealthyMs,
  _resetFreshnessMemo,
  MEMO_MS,
} from "./freshness.js";

const NOW = Date.parse("2026-10-05T17:00:00Z");
const ago = (min) => new Date(NOW - min * 60 * 1000).toISOString();

/** A fake supabase whose cache_sync_runs query answers `run` (or an error / a throw). */
function fakeSupabase({ run = null, error = null, throws = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = { table, filters: [] };
      calls.push(q);
      const b = {
        select() { return b; },
        eq(c, v) { q.filters.push([c, v]); return b; },
        order() { return b; },
        limit() { return b; },
        async maybeSingle() {
          if (throws) throw new Error("boom");
          return { data: error ? null : run, error: error ? { message: error } : null };
        },
      };
      return b;
    },
  };
}

test.beforeEach(() => {
  _resetFreshnessMemo();
  delete process.env.CACHE_TTL_MS;
  delete process.env.CACHE_SYNC_HEALTHY_MS;
});

// --- the healthy branch -------------------------------------------------------

test("a recent ok incremental run makes the cache authoritative", async () => {
  const sb = fakeSupabase({ run: { finished_at: ago(4), expected_interval_s: 300 } });
  const rule = await resolveFreshness(sb, "customer", NOW);
  assert.equal(rule.mode, "sync");
  // The lookup asked for exactly the right row: this object, incremental, ok.
  assert.deepEqual(sb.calls[0].filters, [["object", "customer"], ["mode", "incremental"], ["ok", true]]);
  assert.equal(sb.calls[0].table, "cache_sync_runs");
});

test("healthy: a row synced HOURS ago is fresh — no per-row clock", async () => {
  const rule = await resolveFreshness(fakeSupabase({ run: { finished_at: ago(1), expected_interval_s: 300 } }), "customer", NOW);
  assert.equal(isRowFresh({ sf_id: "a", last_synced_at: ago(600), is_stale: false }, rule, NOW), true);
  assert.equal(isRowFresh({ sf_id: "a", last_synced_at: null }, rule, NOW), true, "even a missing timestamp");
});

test("healthy: an explicitly flagged row is still stale", async () => {
  const rule = await resolveFreshness(fakeSupabase({ run: { finished_at: ago(1), expected_interval_s: 300 } }), "customer", NOW);
  assert.equal(isRowFresh({ sf_id: "a", last_synced_at: ago(0), is_stale: true }, rule, NOW), false);
});

// --- the fallback branch -------------------------------------------------------

test("an old run falls back to the 10-minute row TTL exactly", async () => {
  const rule = await resolveFreshness(fakeSupabase({ run: { finished_at: ago(16), expected_interval_s: 300 } }), "customer", NOW);
  assert.equal(rule.mode, "ttl");
  assert.equal(isRowFresh({ last_synced_at: ago(9) }, rule, NOW), true);
  assert.equal(isRowFresh({ last_synced_at: ago(11) }, rule, NOW), false);
  assert.equal(isRowFresh({ last_synced_at: null }, rule, NOW), false, "missing timestamp is stale (fail closed)");
  assert.equal(isRowFresh({ last_synced_at: ago(1), is_stale: true }, rule, NOW), false);
});

test("no run at all, a read error, or a throw → fallback, never an exception", async () => {
  for (const sb of [fakeSupabase({ run: null }), fakeSupabase({ error: "relation does not exist" }), fakeSupabase({ throws: true })]) {
    _resetFreshnessMemo();
    const rule = await resolveFreshness(sb, "customer", NOW);
    assert.equal(rule.mode, "ttl");
  }
});

test("a null rule (no cache row case) behaves as the TTL rule", () => {
  assert.equal(isRowFresh({ last_synced_at: ago(1) }, null, NOW), true);
  assert.equal(isRowFresh({ last_synced_at: ago(20) }, null, NOW), false);
  assert.equal(isRowFresh(null, { mode: "sync" }, NOW), false);
});

// --- per-object bar -----------------------------------------------------------

test("a 30-minute object is judged by its own bar (3 × 30 min), not the 5-minute one", async () => {
  const cold = await resolveFreshness(fakeSupabase({ run: { finished_at: ago(40), expected_interval_s: 1800 } }), "roofing", NOW);
  assert.equal(cold.mode, "sync", "40 min old is healthy for a 30-minute schedule");
  assert.equal(cold.barMs, 90 * 60 * 1000);

  const coldDead = await resolveFreshness(fakeSupabase({ run: { finished_at: ago(95), expected_interval_s: 1800 } }), "po", NOW);
  assert.equal(coldDead.mode, "ttl");

  const hot = await resolveFreshness(fakeSupabase({ run: { finished_at: ago(20), expected_interval_s: 300 } }), "customer", NOW);
  assert.equal(hot.mode, "ttl", "20 min old is NOT healthy for a 5-minute schedule");
});

test("a manual run (no interval) is judged by CACHE_SYNC_HEALTHY_MS, default 15 min", async () => {
  assert.equal(healthyBarMs({ finished_at: ago(1) }), 15 * 60 * 1000);
  assert.equal((await resolveFreshness(fakeSupabase({ run: { finished_at: ago(14) } }), "a", NOW)).mode, "sync");
  _resetFreshnessMemo();
  assert.equal((await resolveFreshness(fakeSupabase({ run: { finished_at: ago(16) } }), "a", NOW)).mode, "ttl");
});

test("env overrides: CACHE_TTL_MS and CACHE_SYNC_HEALTHY_MS; junk keeps the default", () => {
  process.env.CACHE_TTL_MS = "60000";
  process.env.CACHE_SYNC_HEALTHY_MS = "120000";
  assert.equal(cacheTtlMs(), 60000);
  assert.equal(defaultHealthyMs(), 120000);
  process.env.CACHE_TTL_MS = "banana";
  assert.equal(cacheTtlMs(), 10 * 60 * 1000);
});

// --- the 60-second memo ----------------------------------------------------------

test("the run lookup is memoised for 60 s per object, then re-read", async () => {
  const sb = fakeSupabase({ run: { finished_at: ago(1), expected_interval_s: 300 } });
  const a = await resolveFreshness(sb, "customer", NOW);
  const b = await resolveFreshness(sb, "customer", NOW + MEMO_MS - 1);
  assert.equal(sb.calls.length, 1, "second request inside 60 s does not query");
  assert.equal(a.memo, false);
  assert.equal(b.memo, true);

  await resolveFreshness(sb, "solar", NOW);
  assert.equal(sb.calls.length, 2, "the memo is per object");

  await resolveFreshness(sb, "customer", NOW + MEMO_MS + 1);
  assert.equal(sb.calls.length, 3, "after 60 s it is read again");
});

test("a memoised healthy run still ages out by the clock (memo is the run, not the verdict)", async () => {
  const sb = fakeSupabase({ run: { finished_at: ago(14), expected_interval_s: 300 } });
  assert.equal((await resolveFreshness(sb, "customer", NOW)).mode, "sync");
  // 59 s later the same memoised run is now 14m59s old: still healthy at a 15-min bar.
  assert.equal((await resolveFreshness(sb, "customer", NOW + 59_000)).mode, "sync");
  // A run 14.5 min old memoised, checked 59 s later = 15.5 min: unhealthy without re-reading.
  _resetFreshnessMemo();
  const sb2 = fakeSupabase({ run: { finished_at: new Date(NOW - 14.5 * 60_000).toISOString(), expected_interval_s: 300 } });
  await resolveFreshness(sb2, "customer", NOW);
  assert.equal((await resolveFreshness(sb2, "customer", NOW + 59_000)).mode, "ttl");
  assert.equal(sb2.calls.length, 1);
});

test("a failed lookup is memoised too (a missing table costs one query a minute)", async () => {
  const sb = fakeSupabase({ error: "relation does not exist" });
  await resolveFreshness(sb, "customer", NOW);
  await resolveFreshness(sb, "customer", NOW + 1000);
  assert.equal(sb.calls.length, 1);
});
