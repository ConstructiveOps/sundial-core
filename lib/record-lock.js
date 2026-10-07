// lib/record-lock.js — one writer at a time per record (D-082, 2026-10-07).
//
// A read → merge → write of a Salesforce field (Welcome_Call_Log__c is a 131k textarea
// written whole) is only safe if nobody else does the same in between. Two Lambda
// invocations for one record can run in parallel — Zapier loop iterations have no ordering
// or non-overlap guarantee, and Retell can deliver two calls' results seconds apart — so
// the merge runs inside withRecordLock():
//
//   await withRecordLock(`welcome-call:${recordId}`, async () => {
//     const fresh = await readRecord();      // re-read AFTER the lock, never before
//     await write(merge(fresh));
//   });
//
// The lock is a row in public.sundial_record_locks taken by sundial_record_lock_acquire
// (sql/2026-10-07_record_locks.sql): atomic, expires after TTL_SECONDS (longer than the
// Lambda timeout, so an expired lock means a dead holder). Waiting is bounded: after
// WAIT_MS of retries the call throws RecordLockTimeout, which the handlers turn into a 409 —
// a retried request beats a write merged from stale data. The release is best-effort (the
// TTL is the backstop) and only ever removes THIS holder's row.
//
// FAILS CLOSED. If the lock cannot be asked for at all (the SQL not applied, Supabase
// down), the work does not run and the caller answers 409 / 5xx: an unguarded merge is the
// bug this exists to prevent.

import crypto from "node:crypto";

export const TTL_SECONDS = 90;
export const WAIT_MS = 30000;
const FIRST_BACKOFF_MS = 150;
const MAX_BACKOFF_MS = 2000;

export class RecordLockTimeout extends Error {
  constructor(key, waitedMs, cause = null) {
    super(`could not acquire the write lock on ${key} within ${waitedMs} ms${cause ? ` (${cause})` : ""}`);
    this.name = "RecordLockTimeout";
    this.code = "RECORD_LOCKED";
    this.lockKey = key;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `work` while holding the lock on `key`.
 *
 * @param {string} key
 * @param {() => Promise<T>} work
 * @param {object} deps
 * @param {() => Promise<object>} deps.getSupabaseClient
 * @param {number} [deps.waitMs]
 * @param {number} [deps.ttlSeconds]
 * @param {() => number} [deps.now]
 * @param {(ms:number) => Promise<void>} [deps.sleep]
 * @param {string} [deps.holder]
 * @returns {Promise<T>}
 * @throws {RecordLockTimeout} when the lock is not acquired within waitMs (work never runs)
 */
export async function withRecordLock(key, work, deps) {
  const {
    getSupabaseClient,
    waitMs = WAIT_MS,
    ttlSeconds = TTL_SECONDS,
    now = () => Date.now(),
    sleep = defaultSleep,
    holder = crypto.randomUUID(),
  } = deps || {};
  const supabase = await getSupabaseClient();
  const started = now();
  let backoff = FIRST_BACKOFF_MS;
  let lastError = null;
  let attempts = 0;
  for (;;) {
    attempts++;
    const { data, error } = await supabase.rpc("sundial_record_lock_acquire", { p_key: key, p_holder: holder, p_ttl_seconds: ttlSeconds });
    if (!error && data === true) break;
    lastError = error ? error.message || String(error) : null;
    const waited = now() - started;
    if (waited + backoff > waitMs) {
      console.warn(JSON.stringify({ recordLock: "timeout", key, waitedMs: waited, attempts, error: lastError }));
      throw new RecordLockTimeout(key, waited, lastError);
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
  if (attempts > 1) console.log(JSON.stringify({ recordLock: "acquired_after_wait", key, waitedMs: now() - started, attempts }));
  try {
    return await work();
  } finally {
    try {
      const { error } = await supabase.rpc("sundial_record_lock_release", { p_key: key, p_holder: holder });
      if (error) console.warn(JSON.stringify({ recordLock: "release_failed", key, error: error.message || String(error) }));
    } catch (e) {
      console.warn(JSON.stringify({ recordLock: "release_threw", key, error: e?.message || String(e) }));
    }
  }
}
