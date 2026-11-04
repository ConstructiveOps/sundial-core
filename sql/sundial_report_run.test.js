// Tests for sql/sundial_report_run.sql — against a REAL Postgres (PGlite, in process),
// loading the actual function file AND the actual generated catalog seed
// (sql/2026-11-03_report_catalog.sql). The cache tables are created from the seed's own
// (table, column, type) rows, so this test cannot drift from the catalog it runs against.
// Definitions are built by the real lib/report-def.js normalizeDefinition(), so the JS that
// writes the wire format and the SQL that reads it are tested as one.
//
// Run with:  npm test
//
// Pinned:
//   - tenant isolation: another tenant's rows never appear, and a join key that only matches
//     another tenant's row joins to nothing (the tenant clause is inside every ON);
//   - every wire operator once, incl. neq / not_in keeping blanks and LIKE wildcards escaped;
//   - group + aggregate, grand totals over ALL matching rows, sort, the deterministic tiebreak;
//   - the 5,000 cap and `truncated`;
//   - a gated column RAISES unless its gate is held; an unknown table / column / alias /
//     operator / aggregate RAISES; a non-reportable column RAISES;
//   - the solar type's join aliases resolve (customer, rep);
//   - anon and authenticated cannot execute either function.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { normalizeDefinition } from "../lib/report-def.js";

const T = "a0Xharmon";
const OTHER = "a0Xother";
const BIG = "a0Xbig";
const NOW = new Date("2026-11-03T17:00:00Z"); // 10:00 AM in Arizona

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;`);
await db.exec(await readFile(new URL("./2026-11-03_report_catalog.sql", import.meta.url), "utf8"));

// Every catalog table, with exactly the catalog's columns (+ the tenant key).
const { rows: catRows } = await db.query(
  `select table_name, column_name, data_type from public.sundial_report_catalog order by table_name, column_name`
);
const byTable = new Map();
for (const r of catRows) {
  if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
  byTable.get(r.table_name).push(r);
}
for (const [table, cols] of byTable) {
  const defs = cols.map((c) => `${JSON.stringify(c.column_name)} ${c.data_type}`).join(", ");
  await db.exec(`create table public.${table} (${defs}, client_sf_id text)`);
}
await db.exec(await readFile(new URL("./sundial_report_run.sql", import.meta.url), "utf8"));

async function insert(table, row) {
  const keys = Object.keys(row);
  await db.query(
    `insert into public.${table} (${keys.map((k) => JSON.stringify(k)).join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
    keys.map((k) => row[k])
  );
}

// --- fixtures -------------------------------------------------------------------------
await insert("sundial_user_cache", { sf_id: "U1", client_sf_id: T, name: "Ann Rep" });
await insert("sundial_user_cache", { sf_id: "U2", client_sf_id: T, name: "Bob Rep" });
await insert("sundial_user_cache", { sf_id: "UX", client_sf_id: OTHER, name: "Other Rep" });
await insert("sundial_customer_cache", { sf_id: "C1", client_sf_id: T, name: "Ada Lee", city: "Mesa" });
await insert("sundial_customer_cache", { sf_id: "C2", client_sf_id: T, name: "O'Brien", city: "Tempe" });
// C9 exists ONLY in the other tenant. A Harmon project pointing at it must join to nothing.
await insert("sundial_customer_cache", { sf_id: "C9", client_sf_id: OTHER, name: "Not Yours", city: "Nowhere" });

const SOLAR = [
  { sf_id: "S1", project_name: "Sunny Acres", stage: "Permitting", contract_amount: 10000, system_size: 5.5, contract_date: "2026-10-05", created_date: "2026-10-20T15:00:00Z", sales_rep_sf_id: "U1", sundial_customer_sf_id: "C1", project_manager: "Breana Evans;Pat Q", battery_only_sale: true },
  { sf_id: "S2", project_name: "50% Off Roof", stage: "Permitting", contract_amount: 20000, system_size: 7, contract_date: "2026-09-15", created_date: "2026-09-01T15:00:00Z", sales_rep_sf_id: "U2", sundial_customer_sf_id: "C2", project_manager: "Pat Q", battery_only_sale: false },
  { sf_id: "S3", project_name: "SUNSET ridge", stage: "Archive", contract_amount: 5000, system_size: 4, contract_date: "2026-11-02", created_date: "2026-11-02T20:00:00Z", sales_rep_sf_id: "U1", sundial_customer_sf_id: "C9", project_manager: null, battery_only_sale: null },
  { sf_id: "S4", project_name: "Plain", stage: null, contract_amount: null, system_size: null, contract_date: null, created_date: "2026-01-10T15:00:00Z", sales_rep_sf_id: null, sundial_customer_sf_id: null, project_manager: "  ", battery_only_sale: null },
  { sf_id: "S5", project_name: "Under_score", stage: "Install", contract_amount: 1000, system_size: 3, contract_date: "2026-10-31", created_date: "2026-10-31T23:30:00Z", sales_rep_sf_id: "UX", sundial_customer_sf_id: "C1", project_manager: "Selena B", battery_only_sale: false },
];
for (const s of SOLAR) await insert("sundial_solar_cache", { client_sf_id: T, ...s });
await insert("sundial_solar_cache", { sf_id: "SX", client_sf_id: OTHER, project_name: "Other tenant", stage: "Permitting", contract_amount: 99999, sales_rep_sf_id: "UX" });
await db.exec(`insert into public.sundial_solar_cache (sf_id, client_sf_id, project_name)
               select 'B' || lpad(g::text, 5, '0'), '${BIG}', 'P' || g from generate_series(1, 5001) g`);
await insert("sundial_price_book_item_cache", { sf_id: "PB1", client_sf_id: T, name: "Panel", labor_cost: 12 });

// --- helpers ----------------------------------------------------------------------------
async function runWire(wire, tenant = T) {
  const r = await db.query(`select public.sundial_report_run($1, $2::jsonb) as r`, [tenant, JSON.stringify(wire)]);
  return r.rows[0].r;
}
async function run(def, { tenant = T, heldGates = [] } = {}) {
  const n = normalizeDefinition(def, { heldGates, now: NOW });
  assert.equal(n.ok, true, JSON.stringify(n.body));
  return { ...(await runWire(n.wire, tenant)), n };
}
const ids = async (filters, extra = {}) => {
  const r = await run({ type: "solar", columns: ["solar.project_name"], filters, sort: [{ field: "solar.project_name" }], ...extra });
  return r.rows.map((x) => x[0]);
};
async function raises(wire, re, tenant = T) {
  await assert.rejects(() => runWire(wire, tenant), (e) => {
    assert.match(String(e.message), re);
    return true;
  });
}
const baseWire = () => normalizeDefinition({ type: "solar", columns: ["solar.project_name"] }, { now: NOW }).wire;

// --- tenant isolation + joins ------------------------------------------------------------
test("tenant isolation: only the tenant's rows, and a cross-tenant join key joins to nothing", async () => {
  const r = await run({ type: "solar", columns: ["solar.project_name", "customer.name", "rep.name"], sort: [{ field: "solar.project_name" }] });
  assert.deepEqual(r.rows, [
    ["50% Off Roof", "O'Brien", "Bob Rep"],
    ["Plain", null, null],
    ["SUNSET ridge", null, "Ann Rep"], // C9 belongs to the other tenant
    ["Sunny Acres", "Ada Lee", "Ann Rep"],
    ["Under_score", "Ada Lee", null], // UX belongs to the other tenant
  ]);
  assert.equal(r.truncated, false);
  const other = await run({ type: "solar", columns: ["solar.project_name", "rep.name"] }, { tenant: OTHER });
  assert.deepEqual(other.rows, [["Other tenant", "Other Rep"]]);
});

test("the default columns of the solar type all resolve", async () => {
  const r = await run({ type: "solar" });
  assert.equal(r.rows.length, 5);
  assert.equal(r.rows[0].length, r.n.output.length);
});

// --- operators -----------------------------------------------------------------------------
test("text / picklist operators", async () => {
  assert.deepEqual(await ids([{ field: "solar.stage", op: "eq", value: "Permitting" }]), ["50% Off Roof", "Sunny Acres"]);
  // neq keeps the blank stage (IS DISTINCT FROM)
  assert.deepEqual(await ids([{ field: "solar.stage", op: "neq", value: "Archive" }]), ["50% Off Roof", "Plain", "Sunny Acres", "Under_score"]);
  assert.deepEqual(await ids([{ field: "solar.stage", op: "in", value: ["Archive", "Install"] }]), ["SUNSET ridge", "Under_score"]);
  assert.deepEqual(await ids([{ field: "solar.stage", op: "not_in", value: ["Permitting", "Archive"] }]), ["Plain", "Under_score"]);
  assert.deepEqual(await ids([{ field: "solar.project_name", op: "contains", value: "sun" }]), ["SUNSET ridge", "Sunny Acres"]);
  assert.deepEqual(await ids([{ field: "solar.project_name", op: "starts_with", value: "sunset" }]), ["SUNSET ridge"]);
  // LIKE wildcards in the VALUE are literal: "50%" is not "50 then anything", "_" is not "any one character".
  assert.deepEqual(await ids([{ field: "solar.project_name", op: "contains", value: "0%" }]), ["50% Off Roof"]);
  // Unescaped, "5%f" would match "50% Of…" and "d_r" would match "Under…"; escaped, neither does.
  assert.deepEqual(await ids([{ field: "solar.project_name", op: "contains", value: "5%f" }]), []);
  assert.deepEqual(await ids([{ field: "solar.project_name", op: "contains", value: "d_r" }]), []);
  assert.deepEqual(await ids([{ field: "solar.project_name", op: "contains", value: "r_s" }]), ["Under_score"]);
  assert.deepEqual(await ids([{ field: "solar.stage", op: "is_blank" }]), ["Plain"]);
  assert.deepEqual(await ids([{ field: "solar.stage", op: "not_blank" }]), ["50% Off Roof", "SUNSET ridge", "Sunny Acres", "Under_score"]);
  // a quote in a value is data, not SQL
  assert.deepEqual(
    (await run({ type: "solar", columns: ["solar.project_name"], filters: [{ field: "customer.name", op: "eq", value: "O'Brien" }] })).rows,
    [["50% Off Roof"]]
  );
});

test("multipicklist: contains finds one value in the list; is_blank counts only-spaces as blank", async () => {
  assert.deepEqual(await ids([{ field: "solar.project_manager", op: "contains", value: "pat q" }]), ["50% Off Roof", "Sunny Acres"]);
  assert.deepEqual(await ids([{ field: "solar.project_manager", op: "is_blank" }]), ["Plain", "SUNSET ridge"]);
});

test("reference operators", async () => {
  assert.deepEqual(await ids([{ field: "solar.sales_rep_sf_id", op: "eq", value: "U1" }]), ["SUNSET ridge", "Sunny Acres"]);
  assert.deepEqual(await ids([{ field: "solar.sales_rep_sf_id", op: "neq", value: "U1" }]), ["50% Off Roof", "Plain", "Under_score"]);
  assert.deepEqual(await ids([{ field: "solar.sales_rep_sf_id", op: "is_blank" }]), ["Plain"]);
});

test("number operators", async () => {
  const f = (op, value) => ids([{ field: "solar.contract_amount", op, value }]);
  assert.deepEqual(await f("eq", 10000), ["Sunny Acres"]);
  assert.deepEqual(await f("neq", 10000), ["50% Off Roof", "Plain", "SUNSET ridge", "Under_score"]);
  assert.deepEqual(await f("gt", 10000), ["50% Off Roof"]);
  assert.deepEqual(await f("gte", 10000), ["50% Off Roof", "Sunny Acres"]);
  assert.deepEqual(await f("lt", 5000), ["Under_score"]);
  assert.deepEqual(await f("lte", 5000), ["SUNSET ridge", "Under_score"]);
  assert.deepEqual(await f("between", [5000, 10000]), ["SUNSET ridge", "Sunny Acres"]);
  assert.deepEqual(await f("is_blank"), ["Plain"]);
});

test("date operators, incl. a relative token resolved in Arizona", async () => {
  const f = (op, value) => ids([{ field: "solar.contract_date", op, value }]);
  assert.deepEqual(await f("eq", "2026-10-05"), ["Sunny Acres"]);
  assert.deepEqual(await f("before", "2026-10-05"), ["50% Off Roof"]);
  assert.deepEqual(await f("after", "2026-10-31"), ["SUNSET ridge"]);
  assert.deepEqual(await f("between", ["2026-10-01", "2026-10-31"]), ["Sunny Acres", "Under_score"]);
  assert.deepEqual(await f("between", "this_month"), ["SUNSET ridge"]); // November 2026
  assert.deepEqual(await f("between", "last_month"), ["Sunny Acres", "Under_score"]);
  assert.deepEqual(await f("is_blank"), ["Plain"]);
});

test("datetime operators are whole ARIZONA days", async () => {
  const f = (op, value) => ids([{ field: "solar.created_date", op, value }]);
  // S5 was created 2026-10-31T23:30Z = 4:30 PM Oct 31 in Arizona; S3 at 2026-11-02T20:00Z = 1 PM Nov 2.
  assert.deepEqual(await f("eq", "2026-10-31"), ["Under_score"]);
  assert.deepEqual(await f("between", "this_month"), ["SUNSET ridge"]);
  assert.deepEqual(await f("eq", "last_n_days:3"), ["SUNSET ridge"]); // Nov 1–3
  assert.deepEqual(await f("before", "2026-09-02"), ["50% Off Roof", "Plain"]);
  assert.deepEqual(await f("after", "2026-10-31"), ["SUNSET ridge"]);
});

test("boolean operators", async () => {
  assert.deepEqual(await ids([{ field: "solar.battery_only_sale", op: "eq", value: true }]), ["Sunny Acres"]);
  assert.deepEqual(await ids([{ field: "solar.battery_only_sale", op: "eq", value: false }]), ["50% Off Roof", "Under_score"]);
  assert.deepEqual(await ids([{ field: "solar.battery_only_sale", op: "is_blank" }]), ["Plain", "SUNSET ridge"]);
});

// --- group, aggregate, sort ------------------------------------------------------------------
test("group + aggregates, sorted by an aggregate; grand totals cover every matching row", async () => {
  const r = await run({
    type: "solar",
    groupBy: ["rep.name"],
    aggregates: [{ fn: "count" }, { fn: "sum", field: "solar.contract_amount" }, { fn: "max", field: "solar.contract_date" }],
    sort: [{ field: "sum_solar_contract_amount", dir: "desc" }],
  });
  assert.deepEqual(r.n.output.map((o) => o.field), ["rep.name", "count", "sum_solar_contract_amount", "max_solar_contract_date"]);
  assert.deepEqual(r.rows, [
    ["Bob Rep", 1, 20000, "2026-09-15"],
    ["Ann Rep", 2, 15000, "2026-11-02"],
    [null, 2, 1000, "2026-10-31"], // no rep + the other tenant's rep: one blank group
  ]);
  assert.deepEqual(r.aggregates, { count: 5, sum_solar_contract_amount: 36000, max_solar_contract_date: "2026-11-02" });
});

test("detail rows with totals, sort desc with blanks last, the record id breaks ties", async () => {
  const r = await run({
    type: "solar",
    columns: ["solar.stage", "solar.project_name"],
    aggregates: [{ fn: "avg", field: "solar.system_size" }, { fn: "min", field: "solar.contract_amount" }],
    sort: [{ field: "solar.stage", dir: "desc" }],
  });
  assert.deepEqual(r.rows, [
    ["Permitting", "Sunny Acres"], // S1 before S2: the tiebreak
    ["Permitting", "50% Off Roof"],
    ["Install", "Under_score"],
    ["Archive", "SUNSET ridge"],
    [null, "Plain"],
  ]);
  assert.equal(r.aggregates.min_solar_contract_amount, 1000);
  assert.equal(Number(r.aggregates.avg_solar_system_size).toFixed(3), "4.875");
});

test("aggregates only: no rows, the totals", async () => {
  const r = await run({ type: "solar", aggregates: [{ fn: "count" }], filters: [{ field: "solar.stage", op: "eq", value: "Permitting" }] });
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.aggregates, { count: 2 });
});

// --- the cap --------------------------------------------------------------------------------
test("5,000 rows at most; truncated says so; the totals still count everything", async () => {
  const r = await run({ type: "solar", columns: ["solar.project_name"], aggregates: [{ fn: "count" }] }, { tenant: BIG });
  assert.equal(r.rows.length, 5000);
  assert.equal(r.truncated, true);
  assert.equal(r.aggregates.count, 5001);
  const small = await run({ type: "solar", columns: ["solar.project_name"], limit: 10 }, { tenant: BIG });
  assert.equal(small.rows.length, 10);
  assert.equal(small.truncated, true);
  const exact = await run({ type: "solar", columns: ["solar.project_name"], limit: 5 });
  assert.equal(exact.rows.length, 5);
  assert.equal(exact.truncated, false);
  await raises({ ...baseWire(), limit: 5001 }, /limit must be 1\.\.5000/);
});

// --- refusals ---------------------------------------------------------------------------------
test("a gated column RAISES unless the caller holds its gate", async () => {
  const wire = {
    base: { table: "sundial_price_book_item_cache", alias: "pb" }, joins: [], grouped: false,
    columns: [{ alias: "pb", column: "labor_cost" }], filters: [], aggregates: [], sort: [], limit: 10, allowedGates: [],
  };
  await raises(wire, /column pb\.labor_cost needs service\.costing\.read/);
  await raises({ ...wire, columns: [{ alias: "pb", column: "name" }], filters: [{ alias: "pb", column: "labor_cost", op: "gt", value: "1" }] }, /needs service\.costing\.read/);
  await raises({ ...wire, columns: [{ alias: "pb", column: "name" }], aggregates: [{ fn: "sum", alias: "pb", column: "labor_cost", name: "s" }] }, /needs service\.costing\.read/);
  const ok = await runWire({ ...wire, allowedGates: ["service.costing.read"] });
  assert.deepEqual(ok.rows, [[12]]);
});

test("unknown identifiers RAISE", async () => {
  const w = baseWire();
  await raises({ ...w, columns: [{ alias: "solar", column: "no_such_column" }] }, /unknown column solar\.no_such_column/);
  await raises({ ...w, columns: [{ alias: "nobody", column: "stage" }] }, /unknown alias nobody/);
  await raises({ ...w, base: { table: "pg_authid", alias: "solar" } }, /unknown table pg_authid/);
  await raises({ ...w, base: { table: "sundial_solar_cache", alias: "s; drop table x" } }, /bad base alias/);
  await raises({ ...w, joins: [{ ...w.joins[0], table: "profiles" }] }, /unknown table profiles/);
  await raises({ ...w, joins: [{ ...w.joins[0], kind: "inner" }] }, /join kind must be left/);
  await raises({ ...w, joins: [{ ...w.joins[0], left_column: "nope" }] }, /unknown column solar\.nope/);
  await raises({ ...w, joins: [{ ...w.joins[0], right_column: "nope" }] }, /unknown column customer\.nope/);
  await raises({ ...w, joins: [w.joins[0], w.joins[0]] }, /bad join alias customer/);
  await raises({ ...w, filters: [{ alias: "solar", column: "stage", op: "regex", value: "x" }] }, /operator regex is not allowed/);
  await raises({ ...w, filters: [{ alias: "solar", column: "contract_amount", op: "contains", value: "1" }] }, /operator contains is not allowed/);
  await raises({ ...w, filters: [{ alias: "solar", column: "stage", op: "in", value: "x" }] }, /in takes a list/);
  await raises({ ...w, aggregates: [{ fn: "string_agg", alias: "solar", column: "stage", name: "x" }] }, /unknown aggregate string_agg/);
  await raises({ ...w, aggregates: [{ fn: "sum", alias: "solar", column: "stage", name: "x" }] }, /sum needs a number column/);
  await raises({ ...w, aggregates: [{ fn: "count", name: "bad name" }] }, /bad aggregate name/);
  await raises({ ...w, columns: [{ alias: "solar", column: "sf_id" }] }, /solar\.sf_id is not reportable/);
  await raises({ ...w, sort: [{ position: 9, dir: "asc" }] }, /sort position 9 is outside/);
  await raises({ ...w, sort: [{ position: 1, dir: "sideways" }] }, /sort dir must be asc or desc/);
  await raises({ ...w, grouped: true, columns: [] }, /exactly one group column/);
});

test("the tenant is required", async () => {
  await raises(baseWire(), /p_client_sf_id is required/, "");
});

test("anon and authenticated cannot execute either function", async () => {
  for (const role of ["anon", "authenticated"]) {
    for (const fn of ["public.sundial_report_run(text, jsonb)", "public.sundial_report_column(jsonb, text, text, text[], boolean)"]) {
      const r = await db.query(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn]);
      assert.equal(r.rows[0].ok, false, `${role} ${fn}`);
    }
  }
  const r = await db.query(`select has_function_privilege('service_role', 'public.sundial_report_run(text, jsonb)', 'execute') as ok`);
  assert.equal(r.rows[0].ok, true);
});
