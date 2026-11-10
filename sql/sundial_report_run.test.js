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
//   - anon and authenticated cannot execute any of the functions.
// R1b (D-089), on a second fixture set (tenant RB, every object seeded):
//   - EVERY report type runs with its default columns, and every join of every type matches
//     a seeded row at least once (no join is dead);
//   - latest = the newest child (created_date desc nulls last, sf_id), narrowed by its where;
//     a customer with no solar keeps its row; tenant isolation inside latest and rollup;
//   - rollup = Succeeded payments only, a refund subtracts, deposits / refunds / count / last
//     paid; a job with no payments reads 0 paid, 0 count, blank last-paid; rollup measures
//     filter, group and aggregate;
//   - offset pages partition the result exactly; totals:false skips the grand totals;
//   - the new join shapes RAISE on anything malformed.

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
  await raises({ ...w, joins: [{ ...w.joins[0], kind: "inner" }] }, /join kind must be lookup, latest or rollup/);
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
    for (const fn of ["public.sundial_report_run(text, jsonb)", "public.sundial_report_column(jsonb, text, text, text[], boolean)",
      "public.sundial_report_join_where(text, jsonb, text[])", "public.sundial_report_ref(jsonb, text, text)"]) {
      const r = await db.query(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn]);
      assert.equal(r.rows[0].ok, false, `${role} ${fn}`);
    }
  }
  const r = await db.query(`select has_function_privilege('service_role', 'public.sundial_report_run(text, jsonb)', 'execute') as ok`);
  assert.equal(r.rows[0].ok, true);
});

// =============================================================================================
// R1b (D-089): every report type, the latest and rollup joins, offset paging, totals:false.
// A separate tenant (RB) so the R1a fixtures above keep their exact counts.
// =============================================================================================
import { REPORT_TYPES, aliasesOf } from "../lib/report-types.js";

const RB = "a0Xrb";
const rb = (table, row) => insert(table, { client_sf_id: RB, ...row });
await rb("sundial_dealer_cache", { sf_id: "D1", name: "Desert Dealer", active: true, is_internal: false });
await insert("sundial_dealer_cache", { sf_id: "DX", client_sf_id: OTHER, name: "Other Dealer" });
await rb("sundial_user_cache", { sf_id: "RU1", name: "Rhea Rep" });
await rb("sundial_user_cache", { sf_id: "RU2", name: "Tom Tech" });
await rb("sundial_user_cache", { sf_id: "RU3", name: "Pam PM" });
await rb("sundial_customer_cache", { sf_id: "RC1", name: "Cara One", dealer_sf_id: "D1", sales_rep_sf_id: "RU1", assigned_to_sf_id: "RU2", created_date: "2026-01-01T12:00:00Z" });
await rb("sundial_customer_cache", { sf_id: "RC2", name: "Bo Two", dealer_sf_id: "DX", created_date: "2026-02-01T12:00:00Z" }); // DX is another tenant's dealer
await rb("sundial_customer_cache", { sf_id: "RC3", name: "Biller Co", created_date: "2026-03-01T12:00:00Z" });
// RC1's solar: RS2 is the newest of RB's; RS4 has no created date (nulls last); RS3 is newer
// still but belongs to ANOTHER tenant and must never be picked.
await rb("sundial_solar_cache", { sf_id: "RS1", project_name: "Old Solar", sundial_customer_sf_id: "RC1", created_date: "2026-01-05T12:00:00Z", stage: "Closed" });
await rb("sundial_solar_cache", { sf_id: "RS2", project_name: "New Solar", sundial_customer_sf_id: "RC1", created_date: "2026-06-01T12:00:00Z", stage: "Permitting", dealer_sf_id: "D1", sales_rep_sf_id: "RU1", contract_amount: 25000 });
await rb("sundial_solar_cache", { sf_id: "RS4", project_name: "Undated Solar", sundial_customer_sf_id: "RC1", created_date: null });
await insert("sundial_solar_cache", { sf_id: "RS3", client_sf_id: OTHER, project_name: "Other tenant solar", sundial_customer_sf_id: "RC1", created_date: "2026-12-01T12:00:00Z" });
await rb("sundial_roofing_cache", { sf_id: "RR1", name: "ROOF-1", project_name: "Roof One", sundial_customer_sf_id: "RC1", dealer_sf_id: "D1", sales_rep_sf_id: "RU1", project_manager_sf_id: "RU3" });
await rb("sundial_estimate_cache", { sf_id: "RE1", name: "EST-1", sundial_customer_sf_id: "RC1", service_job_sf_id: "RJ1", sold_by_sf_id: "RU1", total: 500, status: "Approved" });
await rb("sundial_service_job_cache", { sf_id: "RJ1", name: "SVC-1", sundial_customer_sf_id: "RC1", bill_to_customer_sf_id: "RC3", estimate_sf_id: "RE1", assigned_to_sf_id: "RU2", status: "Invoiced" });
await rb("sundial_service_job_cache", { sf_id: "RJ2", name: "SVC-2", sundial_customer_sf_id: "RC2", status: "New" });
// RJ1's invoices: RI1 is the newest but Void; RI2 is the newest NON-void; RI3 older; RIX is
// another tenant's row pointing at RJ1.
await rb("sundial_service_invoice_cache", { sf_id: "RI1", name: "SVC-1-INV", service_job_sf_id: "RJ1", status: "Void", total: 100, created_date: "2026-10-10T12:00:00Z" });
await rb("sundial_service_invoice_cache", { sf_id: "RI2", name: "SVC-1-INV-2", service_job_sf_id: "RJ1", status: "Paid", total: 200, created_date: "2026-10-01T12:00:00Z", bill_to_customer_sf_id: "RC3" });
await rb("sundial_service_invoice_cache", { sf_id: "RI3", name: "SVC-1-OLD", service_job_sf_id: "RJ1", status: "Sent", total: 300, created_date: "2026-09-01T12:00:00Z" });
await insert("sundial_service_invoice_cache", { sf_id: "RIX", client_sf_id: OTHER, name: "Other inv", service_job_sf_id: "RJ1", status: "Sent", total: 9, created_date: "2026-11-01T12:00:00Z" });
// RJ1's payments: a job-level deposit, a payment and a refund on RI2, a FAILED payment, and
// another tenant's row keyed to RJ1.
await rb("sundial_service_payment_cache", { sf_id: "RP1", name: "PAY-1", service_job_sf_id: "RJ1", type: "Deposit", status: "Succeeded", amount: 50, received_at: "2026-09-20T12:00:00Z" });
await rb("sundial_service_payment_cache", { sf_id: "RP2", name: "PAY-2", service_job_sf_id: "RJ1", invoice_sf_id: "RI2", type: "Payment", status: "Succeeded", amount: 200, received_at: "2026-10-05T12:00:00Z", method: "Check" });
await rb("sundial_service_payment_cache", { sf_id: "RP3", name: "PAY-3", service_job_sf_id: "RJ1", invoice_sf_id: "RI2", type: "Refund", status: "Succeeded", amount: 30, received_at: "2026-10-07T12:00:00Z" });
await rb("sundial_service_payment_cache", { sf_id: "RP4", name: "PAY-4", service_job_sf_id: "RJ1", invoice_sf_id: "RI2", type: "Payment", status: "Failed", amount: 999, received_at: "2026-10-30T12:00:00Z" });
await insert("sundial_service_payment_cache", { sf_id: "RPX", client_sf_id: OTHER, name: "Other pay", service_job_sf_id: "RJ1", invoice_sf_id: "RI2", type: "Payment", status: "Succeeded", amount: 5000 });
await rb("sundial_service_call_cache", { sf_id: "RSC1", name: "SC-1", sundial_service_job_sf_id: "RJ1", tech_sf_id: "RU2", visit_type: "Service", status: "Complete" });
await rb("sundial_service_call_cache", { sf_id: "RSC2", name: "SC-2", visit_type: "Event", tech_sf_id: "RU2", status: "Scheduled" }); // an event: no job
await rb("sundial_price_book_item_cache", { sf_id: "RPB1", name: "Panel", item_code: "PNL" });
await rb("sundial_service_line_cache", { sf_id: "RL1", name: "Panel x2", estimate_sf_id: "RE1", price_book_item_sf_id: "RPB1", quantity: 2, unit_price: 100, line_total: 200 });

const rbRun = (def, opts = {}) => run(def, { tenant: RB, ...opts });

test("R1b: every report type runs with its default columns on seeded rows", async () => {
  for (const t of Object.values(REPORT_TYPES)) {
    const r = await rbRun({ type: t.key });
    assert.ok(r.rows.length > 0, `${t.key}: no rows`);
    assert.equal(r.rows[0].length, t.defaultColumns.length, t.key);
    assert.equal(r.truncated, false);
  }
});

test("R1b: every join of every type matches a seeded row (no dead join)", async () => {
  for (const t of Object.values(REPORT_TYPES)) {
    for (const j of t.joins) {
      const probe = j.kind === "rollup" ? `${j.alias}.payment_count` : `${j.alias}.${j.object === "solar" ? "project_name" : "name"}`;
      const r = await rbRun({ type: t.key, columns: [probe] });
      const hit = r.rows.some((row) => row[0] !== null && row[0] !== 0 && row[0] !== "0");
      assert.ok(hit, `${t.key}.${j.alias} (${j.kind}) never matched`);
    }
  }
});

test("R1b: the joins are tenant-isolated too (another tenant's dealer / child rows never appear)", async () => {
  const c = await rbRun({ type: "customers", columns: ["customer.name", "dealer.name"], sort: [{ field: "customer.name" }] });
  assert.deepEqual(c.rows, [["Biller Co", null], ["Bo Two", null], ["Cara One", "Desert Dealer"]]);
});

test("R1b latest: the newest child, nulls last, never another tenant's; no child keeps the row", async () => {
  const r = await rbRun({ type: "customers_solar", columns: ["customer.name", "solar.project_name", "dealer.name", "rep.name"], sort: [{ field: "customer.name" }] });
  assert.deepEqual(r.rows, [
    ["Biller Co", null, null, null],
    ["Bo Two", null, null, null],
    ["Cara One", "New Solar", "Desert Dealer", "Rhea Rep"],
  ]);
  // filter on the latest child's columns
  const f = await rbRun({ type: "customers_solar", columns: ["customer.name"], filters: [{ field: "solar.stage", op: "eq", value: "Permitting" }] });
  assert.deepEqual(f.rows, [["Cara One"]]);
});

test("R1b latest + where: service_jobs shows the newest NON-void invoice", async () => {
  const r = await rbRun({ type: "service_jobs", columns: ["job.name", "invoice.name", "invoice.total", "invoice.status"], sort: [{ field: "job.name" }] });
  assert.deepEqual(r.rows, [["SVC-1", "SVC-1-INV-2", 200, "Paid"], ["SVC-2", null, null, null]]);
});

test("R1b rollup: Succeeded only, refunds subtract, 0 when there are none", async () => {
  const cols = ["payments.payment_count", "payments.amount_paid", "payments.deposits_paid", "payments.refunds", "payments.last_paid_at"];
  const j = await rbRun({ type: "service_jobs", columns: ["job.name", ...cols], sort: [{ field: "job.name" }] });
  assert.deepEqual(j.rows.map((r) => r.map((v) => (typeof v === "string" && v.includes("T") ? v.slice(0, 10) : v))), [
    ["SVC-1", 3, 220, 50, 30, "2026-10-07"], // 50 + 200 − 30; the Failed 999 and the other tenant's 5000 do not count
    ["SVC-2", 0, 0, 0, 0, null],
  ]);
  // by invoice: the deposit is the job's, not the invoice's
  const i = await rbRun({ type: "invoices_payments", columns: ["invoice.name", "payments.payment_count", "payments.amount_paid"], sort: [{ field: "invoice.name" }] });
  assert.deepEqual(i.rows, [["SVC-1-INV", 0, 0], ["SVC-1-INV-2", 2, 170], ["SVC-1-OLD", 0, 0]]);
});

test("R1b rollup measures filter, group and aggregate (0, not blank, for none)", async () => {
  const f = await rbRun({ type: "service_jobs", columns: ["job.name"], filters: [{ field: "payments.amount_paid", op: "eq", value: 0 }] });
  assert.deepEqual(f.rows, [["SVC-2"]]);
  const blank = await rbRun({ type: "service_jobs", columns: ["job.name"], filters: [{ field: "payments.last_paid_at", op: "is_blank" }] });
  assert.deepEqual(blank.rows, [["SVC-2"]]);
  const g = await rbRun({ type: "invoices_payments", groupBy: ["payments.payment_count"], aggregates: [{ fn: "count" }, { fn: "sum", field: "payments.amount_paid" }], sort: [{ field: "payments.payment_count" }] });
  assert.deepEqual(g.rows, [[0, 2, 0], [2, 1, 170]]);
  assert.deepEqual(g.aggregates, { count: 3, sum_payments_amount_paid: 170 });
});

test("R1b offset: pages partition the result exactly; totals:false skips the grand totals", async () => {
  const all = await run({ type: "solar", columns: ["solar.project_name"], aggregates: [{ fn: "count" }], limit: 5000 }, { tenant: BIG });
  const n = normalizeDefinition({ type: "solar", columns: ["solar.project_name"], aggregates: [{ fn: "count" }] }, { now: NOW, mode: "csv" });
  assert.equal(n.wire.totals, false);
  const pages = [];
  for (let offset = 0; ; offset += n.wire.limit) {
    const page = await runWire({ ...n.wire, offset }, BIG);
    assert.deepEqual(page.aggregates, {}, "a CSV page carries no totals");
    pages.push(...page.rows);
    if (!page.truncated) break;
  }
  assert.equal(pages.length, 5001);
  assert.equal(new Set(pages.map((r) => r[0])).size, 5001, "no row twice, none missed");
  assert.deepEqual(pages.slice(0, 5000), all.rows);
  await raises({ ...n.wire, offset: 50000 }, /offset must be 0\.\.49999/, BIG);
  await raises({ ...n.wire, offset: "10" }, /offset must be a number/, BIG);
  await raises({ ...n.wire, totals: "no" }, /totals must be true or false/, BIG);
});

test("R1b: malformed latest / rollup joins RAISE", async () => {
  const sj = normalizeDefinition({ type: "service_jobs", columns: ["job.name"] }, { now: NOW }).wire;
  const swap = (alias, patch) => ({ ...sj, joins: sj.joins.map((j) => (j.alias === alias ? { ...j, ...patch } : j)) });
  const inv = sj.joins.find((j) => j.alias === "invoice");
  const pay = sj.joins.find((j) => j.alias === "payments");
  await raises(swap("invoice", { where: [{ column: "nope", op: "in", value: ["x"] }] }), /unknown column sundial_service_invoice_cache\.nope/, RB);
  await raises(swap("invoice", { where: [{ column: "total", op: "in", value: ["1"] }] }), /needs a text column/, RB);
  await raises(swap("invoice", { where: [{ column: "status", op: "like", value: ["x"] }] }), /op must be in or not_in/, RB);
  await raises(swap("invoice", { where: [{ column: "status", op: "in", value: "Void" }] }), /list of 1\.\.500 strings/, RB);
  await raises(swap("invoice", { measures: pay.measures }), /latest join takes no measures/, RB);
  await raises(swap("customer", { where: inv.where }), /lookup join takes no where/, RB);
  await raises(swap("payments", { measures: [] }), /1\.\.20 measures/, RB);
  await raises(swap("payments", { measures: [{ name: "x", fn: "string_agg", column: "name" }] }), /unknown measure function/, RB);
  await raises(swap("payments", { measures: [{ name: "x", fn: "sum", column: "type" }] }), /sum measure needs a number column/, RB);
  await raises(swap("payments", { measures: [{ name: "x", fn: "count", column: "amount" }] }), /count measure takes no column/, RB);
  await raises(swap("payments", { measures: [{ name: "Bad Name", fn: "count" }] }), /bad measure name/, RB);
  await raises(swap("payments", { measures: [{ name: "x", fn: "count" }, { name: "x", fn: "count" }] }), /bad measure name x/, RB);
  await raises(swap("payments", { measures: [{ name: "x", fn: "max", column: "amount", negate_when: { column: "type", value: ["Refund"] } }] }), /negate_when is for a sum/, RB);
  // a rollup's measures are its only columns
  await raises({ ...sj, columns: [{ alias: "payments", column: "amount" }] }, /unknown column payments\.amount/, RB);
  await raises({ ...sj, columns: [{ alias: "payments", column: "__key" }] }, /unknown column payments\.__key/, RB);
  // and a latest still checks its child table
  await raises(swap("invoice", { table: "profiles" }), /unknown table profiles/, RB);
  await raises(swap("invoice", { right_column: "nope" }), /unknown column invoice\.nope/, RB);
});

test("R1b: the aliases the types declare are the ones the wire carries", () => {
  for (const t of Object.values(REPORT_TYPES)) {
    const n = normalizeDefinition({ type: t.key }, { now: NOW });
    assert.deepEqual([n.wire.base.alias, ...n.wire.joins.map((j) => j.alias)], [...aliasesOf(t).keys()]);
  }
});

// =============================================================================================
// D-089 amendment 1 (2026-11-09): record links on ungrouped runs; sundial_report_values.
// =============================================================================================
await db.exec(await readFile(new URL("./sundial_report_values.sql", import.meta.url), "utf8"));

test("records: per row, every record alias's { sfId, name } in row order; null for a left-join miss; no rollup", async () => {
  const r = await rbRun({ type: "service_jobs", columns: ["job.name"], sort: [{ field: "job.name" }] });
  assert.deepEqual(r.rows, [["SVC-1"], ["SVC-2"]]);
  assert.deepEqual(r.records, [
    {
      job: { sfId: "RJ1", name: "SVC-1" },
      customer: { sfId: "RC1", name: "Cara One" },
      bill_to: { sfId: "RC3", name: "Biller Co" },
      estimate: { sfId: "RE1", name: "EST-1" },
      invoice: { sfId: "RI2", name: "SVC-1-INV-2" }, // the latest join's chosen child
      assignee: { sfId: "RU2", name: "Tom Tech" },
    },
    { job: { sfId: "RJ2", name: "SVC-2" }, customer: { sfId: "RC2", name: "Bo Two" }, bill_to: null, estimate: null, invoice: null, assignee: null },
  ]);
  assert.ok(!("payments" in r.records[0]), "a rollup has no record");
  // Not columns: the output and the rows are exactly what was asked for.
  assert.equal(r.n.output.length, 1);
});

test("records: a cross-tenant join key is a miss here too; solar's name is its project name; desc order kept", async () => {
  const c = await rbRun({ type: "customers", columns: ["customer.name"], sort: [{ field: "customer.name", dir: "desc" }] });
  assert.deepEqual(c.rows, [["Cara One"], ["Bo Two"], ["Biller Co"]]);
  assert.deepEqual(c.records.map((x) => x.customer.sfId), ["RC1", "RC2", "RC3"]);
  assert.equal(c.records[1].dealer, null, "RC2's dealer DX is another tenant's");
  assert.deepEqual(c.records[0].dealer, { sfId: "D1", name: "Desert Dealer" });
  const s = await rbRun({ type: "customers_solar", columns: ["customer.name"], filters: [{ field: "customer.name", op: "eq", value: "Cara One" }] });
  assert.deepEqual(s.records[0].solar, { sfId: "RS2", name: "New Solar" });
});

test("records: absent on a grouped run; parallel to rows when truncated; [] when only aggregates", async () => {
  const g = await rbRun({ type: "customers", groupBy: ["customer.name"], aggregates: [{ fn: "count" }] });
  assert.ok(!("records" in g), "grouped: no records key");
  assert.ok(!("records" in normalizeDefinition({ type: "customers", groupBy: ["customer.name"], aggregates: [{ fn: "count" }] }, { now: NOW }).wire));
  const big = await run({ type: "solar", columns: ["solar.project_name"] }, { tenant: BIG });
  assert.equal(big.truncated, true);
  assert.equal(big.records.length, big.rows.length);
  assert.ok(big.rows.every((row, i) => big.records[i].solar.name === row[0]));
  const aggOnly = await rbRun({ type: "customers", aggregates: [{ fn: "count" }] });
  assert.deepEqual(aggOnly.records, []);
});

test("records: a malformed records list RAISES", async () => {
  const sj = normalizeDefinition({ type: "service_jobs", columns: ["job.name"] }, { now: NOW }).wire;
  await raises({ ...sj, records: [{ alias: "payments" }] }, /payments is not a record alias/, RB);
  await raises({ ...sj, records: [{ alias: "nope" }] }, /nope is not a record alias/, RB);
  await raises({ ...sj, records: [{ alias: "job" }, { alias: "job" }] }, /job is listed twice/, RB);
  await raises({ ...sj, records: [{ alias: "job", column: "nope" }] }, /unknown column job\.nope/, RB);
  await raises({ ...sj, records: "job" }, /records is a list/, RB);
  await raises({ ...sj, grouped: true, records: [{ alias: "job" }] }, /grouped report has no records/, RB);
  const el = normalizeDefinition({ type: "estimate_lines", columns: ["line.name"] }, { now: NOW }).wire;
  await raises({ ...el, records: [{ alias: "item", column: "labor_cost" }] }, /item\.labor_cost needs service\.costing\.read/, RB);
  // No column: the id alone.
  const ok = await runWire({ ...sj, records: [{ alias: "job" }] }, RB);
  assert.deepEqual(ok.records.map((x) => x.job), [{ sfId: "RJ1", name: null }, { sfId: "RJ2", name: null }]);
});

// --- sundial_report_values ---------------------------------------------------------------
async function values(table, column, search = null, tenant = T) {
  const r = await db.query(`select public.sundial_report_values($1, $2, $3, $4) as r`, [tenant, table, column, search]);
  return r.rows[0].r;
}
async function valuesRaise(table, column, re) {
  await assert.rejects(() => values(table, column), (e) => {
    assert.match(String(e.message), re);
    return true;
  });
}

test("values: the tenant's distinct non-blank values, most frequent first, then by value", async () => {
  // T's solar stages: Permitting x2, Archive, Install, (null) — OTHER's Permitting never counts.
  assert.deepEqual(await values("sundial_solar_cache", "stage"), {
    values: [{ value: "Permitting", count: 2 }, { value: "Archive", count: 1 }, { value: "Install", count: 1 }],
    total_distinct: 3,
  });
  // project_manager: "  " is blank and never offered.
  const pm = await values("sundial_solar_cache", "project_manager");
  assert.ok(pm.values.every((v) => v.value.trim() !== ""));
  assert.deepEqual(await values("sundial_customer_cache", "city", null, OTHER), { values: [{ value: "Nowhere", count: 1 }], total_distinct: 1 });
});

test("values: search is a case-insensitive contains with % and _ taken literally", async () => {
  assert.deepEqual((await values("sundial_solar_cache", "stage", "PERM")).values, [{ value: "Permitting", count: 2 }]);
  assert.deepEqual(await values("sundial_solar_cache", "project_name", "_"), { values: [{ value: "Under_score", count: 1 }], total_distinct: 1 });
  assert.deepEqual((await values("sundial_solar_cache", "project_name", "50%")).values, [{ value: "50% Off Roof", count: 1 }]);
  assert.equal((await values("sundial_solar_cache", "project_name", "   ")).total_distinct, 5, "a blank search narrows nothing");
  assert.deepEqual(await values("sundial_solar_cache", "stage", "zzz"), { values: [], total_distinct: 0 });
});

test("values: at most 200, total_distinct counts them all", async () => {
  const r = await values("sundial_solar_cache", "project_name", null, BIG);
  assert.equal(r.values.length, 200);
  assert.equal(r.total_distinct, 5001);
  // every count is 1, so the tiebreak (the value) decides the order
  const got = r.values.map((v) => v.value);
  assert.deepEqual(got, [...got].sort());
});

test("values: refuses what a value list must never show", async () => {
  await valuesRaise("sundial_solar_cache", "nope", /unknown column sundial_solar_cache\.nope/);
  await valuesRaise("profiles", "email", /unknown column profiles\.email/);
  await valuesRaise("sundial_solar_cache", "sf_id", /is not reportable/);
  await valuesRaise("sundial_solar_cache", "sales_rep_sf_id", /is an id/);
  await valuesRaise("sundial_solar_cache", "contract_amount", /is numeric, not text/);
  await valuesRaise("sundial_price_book_item_cache", "labor_cost", /is gated/);
  const lt = (await db.query(`select table_name, column_name from public.sundial_report_catalog where long_text and reportable and gate is null and data_type = 'text' limit 1`)).rows[0];
  assert.ok(lt, "the seed flags long text");
  await valuesRaise(lt.table_name, lt.column_name, /is long text/);
  await assert.rejects(() => values("sundial_solar_cache", "stage", null, ""), /p_client_sf_id is required/);
  await assert.rejects(() => values("sundial_solar_cache", "stage", "x".repeat(201)), /longer than 200/);
});

test("values: anon and authenticated cannot execute it", async () => {
  for (const role of ["anon", "authenticated"]) {
    const r = await db.query(`select has_function_privilege($1, 'public.sundial_report_values(text, text, text, text)', 'execute') as ok`, [role]);
    assert.equal(r.rows[0].ok, false, role);
  }
  const s = await db.query(`select has_function_privilege('service_role', 'public.sundial_report_values(text, text, text, text)', 'execute') as ok`);
  assert.equal(s.rows[0].ok, true);
});

// --- D-091: group by period (dateTrunc) ---------------------------------------------------
const TR = "a0Xtrunc";
await insert("sundial_solar_cache", { sf_id: "TR1", client_sf_id: TR, project_name: "T1", contract_amount: 100, contract_date: "2026-10-31", created_date: "2026-11-01T06:30:00Z" }); // Oct 31, 11:30 PM in Arizona
await insert("sundial_solar_cache", { sf_id: "TR2", client_sf_id: TR, project_name: "T2", contract_amount: 200, contract_date: "2026-11-01", created_date: "2026-11-01T07:30:00Z" }); // Nov 1, 12:30 AM in Arizona
await insert("sundial_solar_cache", { sf_id: "TR3", client_sf_id: TR, project_name: "T3", contract_amount: 400, contract_date: "2026-11-15", created_date: "2026-11-15T19:00:00Z" });
await insert("sundial_solar_cache", { sf_id: "TR4", client_sf_id: TR, project_name: "T4", contract_amount: 800, contract_date: null, created_date: null });

const byPeriod = async (field, dateTrunc) => {
  const r = await run({ type: "solar", groupBy: [{ field, dateTrunc }], aggregates: [{ fn: "count" }, { fn: "sum", field: "solar.contract_amount" }] }, { tenant: TR });
  return r.rows;
};

test("D-091 dateTrunc: a datetime is bucketed by its ARIZONA date (11:30 PM Oct 31 in Phoenix is October)", async () => {
  assert.deepEqual(await byPeriod("solar.created_date", "month"), [
    ["2026-10-01", 1, 100], ["2026-11-01", 2, 600], [null, 1, 800],
  ]);
  assert.deepEqual(await byPeriod("solar.created_date", "day"), [
    ["2026-10-31", 1, 100], ["2026-11-01", 1, 200], ["2026-11-15", 1, 400], [null, 1, 800],
  ]);
});

test("D-091 dateTrunc: a date field by month / quarter / year; weeks start Monday", async () => {
  assert.deepEqual(await byPeriod("solar.contract_date", "month"), [["2026-10-01", 1, 100], ["2026-11-01", 2, 600], [null, 1, 800]]);
  assert.deepEqual(await byPeriod("solar.contract_date", "quarter"), [["2026-10-01", 3, 700], [null, 1, 800]]);
  assert.deepEqual(await byPeriod("solar.contract_date", "year"), [["2026-01-01", 3, 700], [null, 1, 800]]);
  // Sat Oct 31 → week of Mon Oct 26; Sun Nov 1 → still Mon Oct 26; Sun Nov 15 → Mon Nov 9.
  assert.deepEqual(await byPeriod("solar.contract_date", "week"), [["2026-10-26", 2, 300], ["2026-11-09", 1, 400], [null, 1, 800]]);
});

test("D-091 dateTrunc: sorted by the period desc; the output column is a date labelled with the period", async () => {
  const r = await run({ type: "solar", groupBy: [{ field: "solar.contract_date", dateTrunc: "month" }], aggregates: [{ fn: "count" }], sort: [{ field: "solar.contract_date", dir: "desc" }] }, { tenant: TR });
  assert.deepEqual(r.rows.map((x) => x[0]), ["2026-11-01", "2026-10-01", null]);
  assert.equal(r.n.output[0].type, "date");
  assert.equal(r.n.output[0].dateTrunc, "month");
  assert.match(r.n.output[0].label, /\(month\)$/);
  assert.deepEqual(r.n.wire.columns, [{ alias: "solar", column: "contract_date", trunc: "month" }]);
});

test("D-091 dateTrunc: a plain string groupBy is unchanged; the function RAISES on a bad trunc", async () => {
  const plain = normalizeDefinition({ type: "solar", groupBy: ["solar.stage"], aggregates: [{ fn: "count" }] }, { now: NOW });
  assert.deepEqual(plain.wire.columns, [{ alias: "solar", column: "stage" }]);
  const g = normalizeDefinition({ type: "solar", groupBy: [{ field: "solar.contract_date", dateTrunc: "month" }], aggregates: [{ fn: "count" }] }, { now: NOW }).wire;
  await raises({ ...g, columns: [{ alias: "solar", column: "contract_date", trunc: "decade" }] }, /bad trunc decade/, TR);
  await raises({ ...g, columns: [{ alias: "solar", column: "stage", trunc: "month" }] }, /trunc needs a date column/, TR);
  const ungrouped = normalizeDefinition({ type: "solar", columns: ["solar.contract_date"] }, { now: NOW }).wire;
  await raises({ ...ungrouped, columns: [{ alias: "solar", column: "contract_date", trunc: "month" }] }, /grouped report only/, TR);
});
