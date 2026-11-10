// node --test sql/2026-11-10_report_schedules.test.js — the D-091 migration on a real Postgres
// (PGlite): runs after sql/sundial_reports.sql, twice (re-runnable), the constraints hold, the
// tick's partial index is the one its query can use, and the browser roles see nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;`);
await db.exec(await readFile(new URL("./sundial_reports.sql", import.meta.url), "utf8"));
const migration = await readFile(new URL("./2026-11-10_report_schedules.sql", import.meta.url), "utf8");
await db.exec(migration);
await db.exec(migration); // re-runnable

const OWNER = "a0000000-0000-4000-8000-000000000002";
async function report(extra = {}) {
  const cols = { client_sf_id: "a1W7y000007AszBEAS", owner_profile_id: OWNER, name: "R", definition: { type: "customers" }, created_by: OWNER, updated_by: OWNER, ...extra };
  const keys = Object.keys(cols);
  const r = await db.query(
    `insert into public.sundial_reports (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    keys.map((k) => (typeof cols[k] === "object" && cols[k] !== null ? JSON.stringify(cols[k]) : cols[k]))
  );
  return r.rows[0];
}

test("the schedule columns exist with their defaults; an existing report is unscheduled", async () => {
  const r = await report();
  assert.equal(r.schedule, null);
  assert.equal(r.next_run_at, null);
  assert.equal(r.consecutive_failures, 0);
  assert.equal(r.last_run_status, null);
});

test("constraints: schedule is an object; last_run_status is one of the five", async () => {
  await assert.rejects(() => report({ schedule: [1, 2] }), /check constraint/);
  await assert.rejects(() => report({ last_run_status: "weird" }), /check constraint/);
  for (const s of ["running", "ok", "partial", "failed", "disabled"]) await report({ last_run_status: s });
});

test("the tick's partial index covers enabled schedules only", async () => {
  const idx = await db.query(`select indexdef from pg_indexes where indexname = 'idx_sundial_reports_due'`);
  assert.match(idx.rows[0].indexdef, /\(next_run_at\) WHERE \(\(schedule ->> 'enabled'::text\) = 'true'::text\)/);
});

test("download links: a hash only (64 hex), the browser roles see nothing", async () => {
  await db.query(`insert into public.sundial_report_downloads (token_hash, export_id, client_sf_id, expires_at) values ($1, gen_random_uuid(), 'x', now())`, ["a".repeat(64)]);
  await assert.rejects(
    () => db.query(`insert into public.sundial_report_downloads (token_hash, export_id, client_sf_id, expires_at) values ('not-a-hash', gen_random_uuid(), 'x', now())`),
    /check constraint/
  );
  for (const role of ["anon", "authenticated"]) {
    const r = await db.query(`select has_table_privilege($1, 'public.sundial_report_downloads', 'select') as ok`, [role]);
    assert.equal(r.rows[0].ok, false, role);
  }
  const d = await db.query(`select column_name from information_schema.columns where table_name = 'sundial_report_exports' and column_name = 'delivery'`);
  assert.equal(d.rows.length, 1);
});
