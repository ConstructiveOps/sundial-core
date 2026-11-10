// node --test sql/2026-11-10_report_assist.test.js — the assistant's budget and log (D-092) on
// a real Postgres (PGlite): re-runnable; the claim counts both counters or neither; the limits
// come from private.app_config (defaults otherwise); Arizona days and months; release; the
// browser roles see nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema private;
  create table private.app_config (key text primary key, value text not null, updated_at timestamptz not null default now());
`);
const migration = await readFile(new URL("./2026-11-10_report_assist.sql", import.meta.url), "utf8");
await db.exec(migration);
await db.exec(migration); // re-runnable

const T = "a1W7y000007AszBEAS";
const T2 = "a1W7y000008UvsHEAS";
const P1 = "a0000000-0000-4000-8000-000000000002";
const P2 = "b0000000-0000-4000-8000-000000000003";
// 2026-11-10 10:00 in Arizona (17:00 UTC).
const NOON = "2026-11-10T17:00:00Z";

const claim = async (tenant, profile, at = NOON) => (await db.query(`select public.sundial_report_assist_claim($1, $2::uuid, $3::timestamptz) c`, [tenant, profile, at])).rows[0].c;
const setLimit = (key, value) => db.query(`insert into private.app_config (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [key, value]);
const clearLimits = () => db.exec(`delete from private.app_config`);
const usage = async (tenant, key, kind) => (await db.query(`select coalesce(sum(turns), 0)::int n from public.sundial_report_assist_usage where client_sf_id = $1 and profile_key = $2 and period_kind = $3`, [tenant, key, kind])).rows[0].n;
const reset = () => db.exec(`delete from public.sundial_report_assist_usage; delete from private.app_config;`);

test("defaults 500 / 40; a claim counts the tenant's month and the user's day", async () => {
  await reset();
  const c = await claim(T, P1);
  assert.equal(c.ok, true);
  assert.equal(c.tenant_limit, 500);
  assert.equal(c.user_limit, 40);
  assert.equal(c.tenant_used, 1);
  assert.equal(c.user_used, 1);
  assert.equal(c.month_start, "2026-11-01");
  assert.equal(c.day, "2026-11-10");
  await claim(T, P2);
  assert.equal(await usage(T, "", "month"), 2);
  assert.equal(await usage(T, P1, "day"), 1);
  assert.equal(await usage(T, P2, "day"), 1);
});

test("the user's daily limit refuses (scope user) and counts NOTHING", async () => {
  await reset();
  await setLimit("report_assist_user_day_limit", "2");
  assert.equal((await claim(T, P1)).ok, true);
  assert.equal((await claim(T, P1)).ok, true);
  const no = await claim(T, P1);
  assert.equal(no.ok, false);
  assert.equal(no.scope, "user");
  assert.equal(no.limit, 2);
  assert.equal(no.used, 2);
  // Arizona midnight Nov 11 = 07:00 UTC.
  assert.equal(Date.parse(no.resets_at), Date.parse("2026-11-11T07:00:00Z"));
  assert.equal(await usage(T, "", "month"), 2, "the refused claim did not touch the tenant counter");
  assert.equal((await claim(T, P2)).ok, true, "another user still has their own day");
});

test("the tenant's monthly limit refuses (scope tenant) for everyone in that tenant only", async () => {
  await reset();
  await setLimit("report_assist_tenant_month_limit", "1");
  assert.equal((await claim(T, P1)).ok, true);
  const no = await claim(T, P2);
  assert.equal(no.ok, false);
  assert.equal(no.scope, "tenant");
  assert.equal(Date.parse(no.resets_at), Date.parse("2026-12-01T07:00:00Z"));
  assert.equal(await usage(T, P2, "day"), 0);
  assert.equal((await claim(T2, P2)).ok, true, "another tenant has its own month");
});

test("a limit of 0 turns it off; a junk value means the default", async () => {
  await reset();
  await setLimit("report_assist_tenant_month_limit", "0");
  assert.equal((await claim(T, P1)).ok, false);
  await setLimit("report_assist_tenant_month_limit", "lots");
  assert.equal((await claim(T, P1)).tenant_limit, 500);
  await setLimit("report_assist_tenant_month_limit", "-5");
  assert.equal((await claim(T, P1)).tenant_limit, 500);
  await clearLimits();
});

test("Arizona days: 06:59 UTC is still yesterday in Phoenix; month rolls on Arizona time", async () => {
  await reset();
  const late = await claim(T, P1, "2026-11-01T06:59:00Z"); // Oct 31, 11:59 PM in Phoenix
  assert.equal(late.day, "2026-10-31");
  assert.equal(late.month_start, "2026-10-01");
  const early = await claim(T, P1, "2026-11-01T07:00:00Z");
  assert.equal(early.day, "2026-11-01");
  assert.equal(early.month_start, "2026-11-01");
  assert.equal(early.user_used, 1, "a new day starts a new count");
});

test("release gives the turn back to both counters, never below zero", async () => {
  await reset();
  const c = await claim(T, P1);
  await db.query(`select public.sundial_report_assist_release($1, $2::uuid, $3::date, $4::date)`, [T, P1, c.month_start, c.day]);
  assert.equal(await usage(T, "", "month"), 0);
  assert.equal(await usage(T, P1, "day"), 0);
  await db.query(`select public.sundial_report_assist_release($1, $2::uuid, $3::date, $4::date)`, [T, P1, c.month_start, c.day]);
  assert.equal(await usage(T, "", "month"), 0);
});

test("the claim requires a tenant and a profile", async () => {
  await assert.rejects(() => db.query(`select public.sundial_report_assist_claim('', $1::uuid)`, [P1]), /required/);
  await assert.rejects(() => db.query(`select public.sundial_report_assist_claim($1, null)`, [T]), /required/);
});

test("the log: outcomes constrained; 90-day cleanup is a plain delete by created_at", async () => {
  await db.query(`insert into public.sundial_report_assist_log (client_sf_id, profile_id, mode, outcome, created_at) values ($1, $2, 'build', 'definition', now() - interval '91 days'), ($1, $2, 'explain', 'explained', now())`, [T, P1]);
  await assert.rejects(() => db.query(`insert into public.sundial_report_assist_log (client_sf_id, profile_id, mode, outcome) values ($1, $2, 'build', 'weird')`, [T, P1]), /check constraint/);
  await assert.rejects(() => db.query(`insert into public.sundial_report_assist_log (client_sf_id, profile_id, mode, outcome) values ($1, $2, 'chat', 'question')`, [T, P1]), /check constraint/);
  await db.query(`delete from public.sundial_report_assist_log where created_at < now() - interval '90 days'`);
  assert.equal((await db.query(`select count(*)::int n from public.sundial_report_assist_log`)).rows[0].n, 1);
});

test("browser roles: no table privilege, no execute", async () => {
  for (const role of ["anon", "authenticated"]) {
    for (const table of ["sundial_report_assist_log", "sundial_report_assist_usage"]) {
      const r = await db.query(`select has_table_privilege($1, $2, 'select') ok`, [role, `public.${table}`]);
      assert.equal(r.rows[0].ok, false, `${role} ${table}`);
    }
    for (const fn of ["sundial_report_assist_claim(text, uuid, timestamptz)", "sundial_report_assist_release(text, uuid, date, date)", "sundial_report_assist_limit(text, integer)"]) {
      const r = await db.query(`select has_function_privilege($1, $2, 'execute') ok`, [role, `public.${fn}`]);
      assert.equal(r.rows[0].ok, false, `${role} ${fn}`);
    }
  }
  const s = await db.query(`select has_function_privilege('service_role', 'public.sundial_report_assist_claim(text, uuid, timestamptz)', 'execute') ok`);
  assert.equal(s.rows[0].ok, true);
});

test("no private.app_config at all: the defaults", async () => {
  const db2 = new PGlite();
  await db2.exec(`create role anon; create role authenticated; create role service_role;`);
  await db2.exec(migration);
  const r = await db2.query(`select public.sundial_report_assist_claim($1, $2::uuid) c`, [T, P1]);
  assert.equal(r.rows[0].c.tenant_limit, 500);
  assert.equal(r.rows[0].c.user_limit, 40);
});
