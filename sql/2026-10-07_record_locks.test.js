// sql/2026-10-07_record_locks.sql (D-082) on a REAL Postgres (PGlite), loading the actual file:
// one holder at a time, an expired lock is taken over, only the holder releases, the
// browser roles cannot touch it, and the file is idempotent.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const sql = await readFile(new URL("./2026-10-07_record_locks.sql", import.meta.url), "utf8");
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;`);

const acquire = async (key, holder, ttl = 90) => (await db.query(`select public.sundial_record_lock_acquire($1, $2, $3) as ok`, [key, holder, ttl])).rows[0].ok;
const release = async (key, holder) => (await db.query(`select public.sundial_record_lock_release($1, $2) as ok`, [key, holder])).rows[0].ok;

test("applies, and applies again; the check row says the browser roles are locked out", async () => {
  await db.exec(sql);
  await db.exec(sql);
  const check = (await db.query(`
    select has_function_privilege('anon', 'public.sundial_record_lock_acquire(text, text, integer)', 'execute') as a,
           has_function_privilege('authenticated', 'public.sundial_record_lock_acquire(text, text, integer)', 'execute') as b,
           has_table_privilege('anon', 'public.sundial_record_locks', 'select') as c,
           has_table_privilege('authenticated', 'public.sundial_record_locks', 'select') as d,
           has_function_privilege('service_role', 'public.sundial_record_lock_acquire(text, text, integer)', 'execute') as svc`)).rows[0];
  assert.deepEqual(check, { a: false, b: false, c: false, d: false, svc: true });
});

test("one holder at a time; only the holder releases", async () => {
  assert.equal(await acquire("welcome-call:a1P7y00000BOqoj", "h1"), true);
  assert.equal(await acquire("welcome-call:a1P7y00000BOqoj", "h2"), false, "a second holder waits");
  assert.equal(await acquire("welcome-call:other", "h2"), true, "another record is independent");
  assert.equal(await release("welcome-call:a1P7y00000BOqoj", "h2"), false, "h2 cannot release h1's lock");
  assert.equal(await acquire("welcome-call:a1P7y00000BOqoj", "h2"), false);
  assert.equal(await release("welcome-call:a1P7y00000BOqoj", "h1"), true);
  assert.equal(await acquire("welcome-call:a1P7y00000BOqoj", "h2"), true, "free once released");
});

test("an expired lock is taken over (a dead holder never blocks for longer than the TTL)", async () => {
  await db.query(`insert into public.sundial_record_locks (lock_key, holder, expires_at) values ('k-expired', 'dead', now() - interval '1 second')`);
  assert.equal(await acquire("k-expired", "alive"), true);
  assert.equal((await db.query(`select holder from public.sundial_record_locks where lock_key = 'k-expired'`)).rows[0].holder, "alive");
  assert.equal(await release("k-expired", "dead"), false, "the dead holder's late release does not free the new owner's lock");
});

test("a blank key or holder is refused", async () => {
  await assert.rejects(acquire("", "h"), /required/);
  await assert.rejects(acquire("k", ""), /required/);
});
