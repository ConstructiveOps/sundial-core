// Tests for sql/sundial_dealer_customer_view.sql — against a REAL Postgres (PGlite, in
// process), loading the actual SQL file. The bugs this view can have are SQL bugs (the
// wrong solar leading, a cross-tenant join, a grant), and only Postgres can show them.
//
// Pinned:
//   - one row per customer, customers without a solar included (journey columns null, count 0);
//   - the leading solar is created_date DESC NULLS LAST, then sf_id DESC; the count is all of them;
//   - the join ignores the solar's own dealer / rep (seen THROUGH the customer, D-086);
//   - a solar of another tenant pointing at the same customer id never joins;
//   - the journey columns come first, so re-running the file after a new customer column works;
//   - anon and authenticated cannot select from it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const T = "a0Xharmon";
const OTHER = "a0Xother";
const SQL = await readFile(new URL("./sundial_dealer_customer_view.sql", import.meta.url), "utf8");

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.sundial_customer_cache (
    sf_id text primary key, client_sf_id text, tenant_id text, name text, stage text,
    sales_rep_sf_id text, dealer_sf_id text, created_date timestamptz
  );
  create table public.sundial_solar_cache (
    sf_id text primary key, client_sf_id text, tenant_id text, sundial_customer_sf_id text,
    stage text, project_name text, sales_rep_sf_id text, dealer_sf_id text, created_date timestamptz
  );
  grant usage on schema public to anon, authenticated, service_role;
  grant select on all tables in schema public to anon, authenticated, service_role;
`);
await db.exec(SQL);

await db.exec(`
  insert into public.sundial_customer_cache values
    ('c1', '${T}', 'harmon', 'One solar',   'Sold',        'rep-a', 'dealer-a', '2026-01-01'),
    ('c2', '${T}', 'harmon', 'Two solars',  'Sold',        'rep-a', 'dealer-a', '2026-01-02'),
    ('c3', '${T}', 'harmon', 'No solar',    'New',         'rep-a', 'dealer-a', '2026-01-03'),
    ('c4', '${T}', 'harmon', 'Null dates',  'Sold',        'rep-b', 'dealer-b', '2026-01-04'),
    ('c5', '${OTHER}', 'other', 'Other tenant', 'New',     'rep-x', 'dealer-x', '2026-01-05');
  insert into public.sundial_solar_cache values
    -- c1: one project, owned by ANOTHER dealer and rep — still c1's (seen through the customer)
    ('s1', '${T}', 'harmon', 'c1', 'Permitting', 'P1', 'rep-z', 'dealer-z', '2026-02-01'),
    -- c2: the newer one leads
    ('s2a', '${T}', 'harmon', 'c2', 'Archive',   'P2 old', 'rep-a', 'dealer-a', '2025-05-01'),
    ('s2b', '${T}', 'harmon', 'c2', 'Audit',     'P2 new', 'rep-a', 'dealer-a', '2026-03-01'),
    -- c4: a dated project beats an undated one; between undated ones sf_id DESC decides
    ('s4a', '${T}', 'harmon', 'c4', 'Billing',   'P4 dated', null, null, '2024-01-01'),
    ('s4b', '${T}', 'harmon', 'c4', 'Hold',      'P4 undated', null, null, null),
    -- another tenant's solar claiming c1: must not join
    ('sX', '${OTHER}', 'other', 'c1', 'Scheduling', 'Intruder', null, null, '2027-01-01');
`);

async function rows(where = "true") {
  const r = await db.query(`select * from public.sundial_dealer_customer_view where ${where} order by sf_id`);
  return r.rows;
}

test("one row per customer; a customer with no solar has null journey columns and count 0", async () => {
  const all = await rows();
  assert.deepEqual(all.map((r) => r.sf_id), ["c1", "c2", "c3", "c4", "c5"]);
  const c3 = all.find((r) => r.sf_id === "c3");
  assert.equal(c3.journey_solar_sf_id, null);
  assert.equal(c3.journey_solar_stage, null);
  assert.equal(c3.journey_solar_count, 0);
});

test("the solar is joined through the customer, whoever the solar's own dealer and rep are", async () => {
  const [c1] = await rows("sf_id = 'c1'");
  assert.equal(c1.journey_solar_sf_id, "s1");
  assert.equal(c1.journey_solar_stage, "Permitting");
  assert.equal(c1.journey_solar_project_name, "P1");
  assert.equal(c1.journey_solar_count, 1, "the other tenant's solar is not counted");
  assert.equal(c1.dealer_sf_id, "dealer-a", "the row filter columns are the CUSTOMER's");
});

test("the most recently created project leads; the count is all of them", async () => {
  const [c2] = await rows("sf_id = 'c2'");
  assert.equal(c2.journey_solar_sf_id, "s2b");
  assert.equal(c2.journey_solar_stage, "Audit");
  assert.equal(c2.journey_solar_count, 2);
  const [c4] = await rows("sf_id = 'c4'");
  assert.equal(c4.journey_solar_sf_id, "s4a", "NULLS LAST: a dated project beats an undated one");
});

test("the customer's own columns follow the journey columns unchanged", async () => {
  const [c1] = await rows("sf_id = 'c1'");
  for (const [k, v] of Object.entries({ client_sf_id: T, tenant_id: "harmon", name: "One solar", stage: "Sold", sales_rep_sf_id: "rep-a" })) {
    assert.equal(c1[k], v, k);
  }
  const cols = (await db.query(`select column_name from information_schema.columns where table_name = 'sundial_dealer_customer_view' order by ordinal_position`)).rows.map((r) => r.column_name);
  assert.deepEqual(cols.slice(0, 5), ["journey_solar_sf_id", "journey_solar_stage", "journey_solar_project_name", "journey_solar_count", "sf_id"]);
});

test("re-running the file after a customer cache column is added appends it (CREATE OR REPLACE works)", async () => {
  await db.exec(`alter table public.sundial_customer_cache add column service_stage text`);
  await db.exec(SQL);
  const cols = (await db.query(`select column_name from information_schema.columns where table_name = 'sundial_dealer_customer_view' order by ordinal_position`)).rows.map((r) => r.column_name);
  assert.equal(cols.at(-1), "service_stage");
});

test("the browser roles cannot read the view; the service role can", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query(`select 1 from public.sundial_dealer_customer_view limit 1`), /permission denied/);
    await db.exec(`reset role`);
  }
  await db.exec(`set role service_role`);
  const r = await db.query(`select count(*)::int as n from public.sundial_dealer_customer_view`);
  await db.exec(`reset role`);
  assert.equal(r.rows[0].n, 5);
});
