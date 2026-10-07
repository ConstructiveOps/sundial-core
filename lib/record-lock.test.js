// D-082: withRecordLock — serialises, waits a bounded time, fails closed, releases only its own lock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withRecordLock, RecordLockTimeout } from "./record-lock.js";

/** An in-memory sundial_record_lock_acquire / _release, same semantics as the SQL. */
function fakeSupabase({ failRpc = false } = {}) {
  const locks = new Map();
  const calls = [];
  return {
    locks,
    calls,
    async rpc(fn, a) {
      calls.push(fn);
      if (failRpc) return { data: null, error: { message: "function public.sundial_record_lock_acquire does not exist" } };
      if (fn === "sundial_record_lock_acquire") {
        const cur = locks.get(a.p_key);
        if (cur && cur.expiresAt > Date.now()) return { data: false, error: null };
        locks.set(a.p_key, { holder: a.p_holder, expiresAt: Date.now() + a.p_ttl_seconds * 1000 });
        return { data: true, error: null };
      }
      const cur = locks.get(a.p_key);
      if (cur && cur.holder === a.p_holder) locks.delete(a.p_key);
      return { data: !!cur, error: null };
    },
  };
}
const deps = (sb, extra = {}) => ({ getSupabaseClient: async () => sb, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), ...extra });

test("two workers on one key never overlap; both run", async () => {
  const sb = fakeSupabase();
  let inside = 0;
  let maxInside = 0;
  const order = [];
  const work = (name) => async () => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    await new Promise((r) => setTimeout(r, 20));
    order.push(name);
    inside--;
    return name;
  };
  const [a, b] = await Promise.all([withRecordLock("k", work("a"), deps(sb)), withRecordLock("k", work("b"), deps(sb))]);
  assert.deepEqual([a, b], ["a", "b"]);
  assert.equal(maxInside, 1, "never two inside at once");
  assert.equal(order.length, 2);
  assert.equal(sb.locks.size, 0, "released");
});

test("different keys do not wait on each other", async () => {
  const sb = fakeSupabase();
  let inside = 0;
  let maxInside = 0;
  const work = async () => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    await new Promise((r) => setTimeout(r, 20));
    inside--;
  };
  await Promise.all([withRecordLock("k1", work, deps(sb)), withRecordLock("k2", work, deps(sb))]);
  assert.equal(maxInside, 2);
});

test("a lock held past the wait → RecordLockTimeout, and the work never runs", async () => {
  const sb = fakeSupabase();
  sb.locks.set("k", { holder: "someone-else", expiresAt: Date.now() + 60000 });
  let ran = false;
  let t = 0;
  const err = await withRecordLock("k", async () => (ran = true), deps(sb, { waitMs: 1000, now: () => (t += 300) })).catch((e) => e);
  assert.ok(err instanceof RecordLockTimeout);
  assert.equal(err.code, "RECORD_LOCKED");
  assert.equal(ran, false);
  assert.equal(sb.locks.get("k").holder, "someone-else", "another holder's lock is never released");
});

test("an expired lock (a dead holder) is taken over", async () => {
  const sb = fakeSupabase();
  sb.locks.set("k", { holder: "dead", expiresAt: Date.now() - 1 });
  assert.equal(await withRecordLock("k", async () => "ok", deps(sb)), "ok");
});

test("fails CLOSED when the lock cannot be asked for (SQL not applied): the work does not run", async () => {
  const sb = fakeSupabase({ failRpc: true });
  let ran = false;
  let t = 0;
  const err = await withRecordLock("k", async () => (ran = true), deps(sb, { waitMs: 500, now: () => (t += 200) })).catch((e) => e);
  assert.ok(err instanceof RecordLockTimeout);
  assert.match(err.message, /does not exist/);
  assert.equal(ran, false);
});

test("the lock is released even when the work throws, and the error propagates", async () => {
  const sb = fakeSupabase();
  await assert.rejects(withRecordLock("k", async () => { throw new Error("salesforce down"); }, deps(sb)), /salesforce down/);
  assert.equal(sb.locks.size, 0);
});
