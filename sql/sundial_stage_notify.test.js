// sql/sundial_stage_notify.sql (dealer module step 6) on a REAL Postgres (PGlite), loading
// the actual file. pg_net is not in PGlite, so `net.http_post` is a stub that records each
// call. Pins: unconfigured = no post (the write still lands), a real stage change posts the
// documented body + secret header, an unchanged stage and an unrelated column post nothing,
// a new solar posts op insert with old_stage null, a new customer posts nothing, the modstamp
// falls back to last_synced_at, push subscriptions accept app 'dealer', and the file re-runs.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const raw = await readFile(new URL("./sundial_stage_notify.sql", import.meta.url), "utf8");
// The only line PGlite cannot run; the stub below stands in for the extension.
const sql = raw.replace(/^create extension if not exists pg_net;$/m, "");
assert.notEqual(sql, raw, "the pg_net line moved — update this test");

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema private;
  create table private.app_config (key text primary key, value text not null, updated_at timestamptz not null default now());
  create schema net;
  create table net.posts (id serial primary key, url text, body jsonb, headers jsonb);
  create function net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds int) returns bigint
    language sql as $$ insert into net.posts (url, body, headers) values (url, body, headers) returning id::bigint $$;
  create table public.sundial_customer_cache (sf_id text primary key, client_sf_id text, stage text, notes text, last_synced_at timestamptz not null default now());
  create table public.sundial_solar_cache (sf_id text primary key, client_sf_id text, stage text, notes text, last_synced_at timestamptz not null default now());
  create table public.sundial_push_subscriptions (id serial primary key, endpoint text unique, app text not null default 'office' check (app in ('office', 'tech')));
`);

const posts = async () => (await db.query(`select url, body, headers from net.posts order by id`)).rows;
const clear = () => db.exec(`delete from net.posts`);

test("applies, and applies again", async () => {
  await db.exec(sql);
  await db.exec(sql);
  const cols = (await db.query(`select table_name from information_schema.columns where column_name = 'lastmodifieddate' order by table_name`)).rows.map((r) => r.table_name);
  assert.deepEqual(cols, ["sundial_customer_cache", "sundial_solar_cache"]);
});

test("unconfigured: the write lands, nothing is posted", async () => {
  await db.exec(`insert into sundial_customer_cache (sf_id, client_sf_id, stage) values ('C0', 'T1', 'New')`);
  await db.exec(`update sundial_customer_cache set stage = 'Appointment Set' where sf_id = 'C0'`);
  assert.equal((await db.query(`select stage from sundial_customer_cache where sf_id = 'C0'`)).rows[0].stage, "Appointment Set");
  assert.equal((await posts()).length, 0);
});

test("configured: a customer stage change posts the body and the secret header; nothing else does", async () => {
  await db.exec(`insert into private.app_config (key, value) values ('stage_notify_url', 'https://api.example/prod/webhooks/stage-change'), ('stage_notify_secret', 'shh')`);
  await clear();
  await db.exec(`insert into sundial_customer_cache (sf_id, client_sf_id, stage, lastmodifieddate) values ('C1', 'T1', 'New', '2026-10-26T17:59:00Z')`);
  assert.equal((await posts()).length, 0, "a new customer is not a stage change");
  await db.exec(`update sundial_customer_cache set stage = 'Verbal Yes' where sf_id = 'C1'`);
  const p = await posts();
  assert.equal(p.length, 1);
  assert.equal(p[0].url, "https://api.example/prod/webhooks/stage-change");
  assert.deepEqual(p[0].body, { object: "customer", sf_id: "C1", client_sf_id: "T1", old_stage: "New", new_stage: "Verbal Yes", modstamp: "2026-10-26T17:59:00.000Z", op: "update" });
  assert.equal(p[0].headers["X-Sundial-Stage-Secret"], "shh");
  await clear();
  await db.exec(`update sundial_customer_cache set stage = 'Verbal Yes', notes = 'resync' where sf_id = 'C1'`);
  await db.exec(`update sundial_customer_cache set notes = 'other' where sf_id = 'C1'`);
  await db.exec(`insert into sundial_customer_cache (sf_id, client_sf_id, stage) values ('C1', 'T1', 'Verbal Yes') on conflict (sf_id) do update set stage = excluded.stage`);
  assert.equal((await posts()).length, 0, "same stage re-written (the sync's upsert) and an unrelated column post nothing");
});

test("solar: a new project posts op insert, old_stage null; a stage change posts; modstamp falls back to last_synced_at", async () => {
  await clear();
  await db.exec(`insert into sundial_solar_cache (sf_id, client_sf_id, stage, last_synced_at) values ('S1', 'T1', 'Audit', '2026-10-26T18:00:00Z')`);
  await db.exec(`update sundial_solar_cache set stage = 'Permitting' where sf_id = 'S1'`);
  const p = await posts();
  assert.equal(p.length, 2);
  assert.deepEqual(p[0].body, { object: "solar", sf_id: "S1", client_sf_id: "T1", old_stage: null, new_stage: "Audit", modstamp: "2026-10-26T18:00:00.000Z", op: "insert" });
  assert.equal(p[1].body.op, "update");
  assert.equal(p[1].body.old_stage, "Audit");
  assert.equal(p[1].body.new_stage, "Permitting");
});

test("a stage cleared to null is a change too", async () => {
  await clear();
  await db.exec(`update sundial_solar_cache set stage = null where sf_id = 'S1'`);
  const p = await posts();
  assert.equal(p.length, 1);
  assert.equal(p[0].body.new_stage, null);
});

test("push subscriptions take app 'dealer'; anything else is still refused", async () => {
  await db.exec(`insert into sundial_push_subscriptions (endpoint, app) values ('https://push/d', 'dealer')`);
  await assert.rejects(db.exec(`insert into sundial_push_subscriptions (endpoint, app) values ('https://push/x', 'nope')`), /check/);
});

test("the browser roles cannot call the trigger function", async () => {
  const r = (await db.query(`select has_function_privilege('authenticated', 'public.notify_stage_change()', 'execute') as a, has_function_privilege('anon', 'public.notify_stage_change()', 'execute') as b`)).rows[0];
  assert.deepEqual(r, { a: false, b: false });
});
