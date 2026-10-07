// sql/2026-10-07_company_customers.sql (D-081) against a REAL Postgres (PGlite), loading the
// actual file: it applies (twice — it must be idempotent), the generated display_name_sort
// agrees with lib/customer-name.js customerDisplayName on the shared fixture table, and the
// Customer header sorts a company among the people by its company name.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { customerDisplayName } from "../lib/customer-name.js";

const { cases } = JSON.parse(await readFile(new URL("../lib/customer-name.fixtures.json", import.meta.url), "utf8"));
const sql = await readFile(new URL("./2026-10-07_company_customers.sql", import.meta.url), "utf8");

const db = new PGlite();
await db.exec(`
  create table public.sundial_customer_cache (sf_id text primary key, client_sf_id text, name text, first_name text, last_name text);
  create table public.sundial_service_job_cache (sf_id text primary key, client_sf_id text);
  create table public.sundial_service_invoice_cache (sf_id text primary key, client_sf_id text);
`);

test("applies, and applies again (idempotent)", async () => {
  await db.exec(sql);
  await db.exec(sql);
  const cols = async (t) => (await db.query(`select column_name from information_schema.columns where table_name = $1`, [t])).rows.map((r) => r.column_name);
  for (const c of ["is_company", "company_name", "warranty_notes", "display_name_sort"]) assert.ok((await cols("sundial_customer_cache")).includes(c), c);
  assert.ok((await cols("sundial_service_job_cache")).includes("bill_to_customer_sf_id"));
  for (const c of ["bill_to_customer_sf_id", "bill_to_address"]) assert.ok((await cols("sundial_service_invoice_cache")).includes(c), c);
});

test("display_name_sort = customerDisplayName, case by case (the shared fixtures)", async () => {
  let i = 0;
  for (const c of cases) {
    const r = c.record;
    const id = `f${++i}`;
    await db.query(
      `insert into sundial_customer_cache (sf_id, client_sf_id, name, first_name, last_name, is_company, company_name) values ($1,'T',$2,$3,$4,$5,$6)`,
      [id, r.name ?? null, r.first_name ?? null, r.last_name ?? null, r.is_company ?? null, r.company_name ?? null]
    );
    const got = (await db.query(`select display_name_sort from sundial_customer_cache where sf_id = $1`, [id])).rows[0].display_name_sort;
    assert.equal(got, c.expected, c.label);
    assert.equal(got, customerDisplayName(r), `SQL and JS agree: ${c.label}`);
  }
});

test("a writer never names the generated column, and it follows every update", async () => {
  await db.query(`insert into sundial_customer_cache (sf_id, client_sf_id, first_name, last_name) values ('u1','T','Zed','Adams')`);
  await db.query(`update sundial_customer_cache set is_company = true, company_name = 'Acme Solar' where sf_id = 'u1'`);
  assert.equal((await db.query(`select display_name_sort from sundial_customer_cache where sf_id = 'u1'`)).rows[0].display_name_sort, "Acme Solar");
  await assert.rejects(db.query(`update sundial_customer_cache set display_name_sort = 'x' where sf_id = 'u1'`), /generated|can only be updated to DEFAULT/i);
});

// (Names that order the same under PGlite's C collation and Supabase's en_US — mixed-case
// names like "APS" vs "Ann" order differently between the two.)
test("the Customer header sorts companies by company name among the people", async () => {
  await db.exec(`delete from sundial_customer_cache`);
  await db.exec(`
    insert into sundial_customer_cache (sf_id, client_sf_id, first_name, last_name, is_company, company_name) values
      ('a','T','Mark','Haughn',null,null),
      ('b','T','Dana','Ruiz',true,'SunRun'),
      ('c','T','Ann','Lee',null,null),
      ('d','T',null,null,true,'Desert Roofing');
  `);
  const order = (await db.query(`select display_name_sort from sundial_customer_cache where client_sf_id = 'T' order by display_name_sort nulls last, sf_id`)).rows.map((r) => r.display_name_sort);
  assert.deepEqual(order, ["Ann Lee", "Desert Roofing", "Mark Haughn", "SunRun"]);
});
