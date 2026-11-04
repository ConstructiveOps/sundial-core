// node --test lib/report-def.test.js
//
// Pinned (D-088): every rejection is a 400 that names the field; operators per type exactly
// as §6.3 (+ the D-088 additions); relative dates in ARIZONA time; one group level; aggregate
// type rules; sort only on what the report shows; limit / column caps; gated columns removed
// (never refused) and named in `stripped`; long text filterable but not selectable.

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDefinition, resolveRelative, arizonaToday, OPERATORS, MAX_ROWS, MAX_COLUMNS,
} from "./report-def.js";
import { REPORT_TYPES } from "./report-types.js";

// A tiny catalog, so the gate / long-text / type rules are exercised on fields we control.
const field = (column, type, extra = {}) => ({ column, sfField: column, label: column.toUpperCase(), section: "", type, pgType: "text", description: "", gate: null, reportable: true, longText: false, ...extra });
const CATALOG = {
  solar: {
    objectKey: "solar", table: "sundial_solar_cache", fields: [
      field("project_name", "text"), field("stage", "picklist"), field("project_manager", "multipicklist"),
      field("contract_amount", "number"), field("system_size", "number"), field("contract_date", "date"),
      field("created_date", "datetime"), field("battery_only_sale", "boolean"),
      field("sales_rep_sf_id", "reference"), field("sundial_customer_sf_id", "reference"),
      field("notes", "text", { longText: true }),
      field("secret_cost", "number", { gate: "service.costing.read" }),
      field("sf_id", "text", { reportable: false }),
    ],
  },
  customer: { objectKey: "customer", table: "sundial_customer_cache", fields: [field("name", "text"), field("sf_id", "text", { reportable: false })] },
  user: { objectKey: "user", table: "sundial_user_cache", fields: [field("name", "text"), field("sf_id", "text", { reportable: false })] },
};
const NOW = new Date("2026-11-03T05:30:00Z"); // still Nov 2 in Arizona (10:30 PM)
const norm = (def, opts = {}) => normalizeDefinition(def, { catalog: CATALOG, now: NOW, ...opts });
const ok = (def, opts) => {
  const r = norm(def, opts);
  assert.equal(r.ok, true, JSON.stringify(r.body));
  return r;
};
const bad = (def, code, fieldName, opts) => {
  const r = norm(def, opts);
  assert.equal(r.ok, false, `expected ${code}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, code, r.body.message);
  assert.equal(r.body.field, fieldName, r.body.message);
  assert.match(r.body.message, /\S/);
  return r;
};

test("Arizona time: 'today' follows Phoenix, not UTC", () => {
  assert.equal(arizonaToday(NOW), "2026-11-02");
  assert.equal(arizonaToday(new Date("2026-11-03T07:00:00Z")), "2026-11-03");
});

test("relative tokens", () => {
  assert.deepEqual(resolveRelative("this_month", NOW), ["2026-11-01", "2026-11-30"]);
  assert.deepEqual(resolveRelative("last_month", NOW), ["2026-10-01", "2026-10-31"]);
  assert.deepEqual(resolveRelative("this_quarter", NOW), ["2026-10-01", "2026-12-31"]);
  assert.deepEqual(resolveRelative("ytd", NOW), ["2026-01-01", "2026-11-02"]);
  assert.deepEqual(resolveRelative("last_n_days:1", NOW), ["2026-11-02", "2026-11-02"]);
  assert.deepEqual(resolveRelative("last_n_days:30", NOW), ["2026-10-04", "2026-11-02"]);
  // January: last month is last year's December; Feb ends on the 28th in 2026.
  const jan = new Date("2026-01-15T19:00:00Z");
  assert.deepEqual(resolveRelative("last_month", jan), ["2025-12-01", "2025-12-31"]);
  assert.deepEqual(resolveRelative("this_month", new Date("2026-02-10T19:00:00Z")), ["2026-02-01", "2026-02-28"]);
  assert.equal(resolveRelative("last_n_days:0", NOW), undefined);
  assert.equal(resolveRelative("next_month", NOW), null);
});

test("operators per type are §6.3 plus the D-088 additions", () => {
  assert.deepEqual(OPERATORS.text, ["eq", "neq", "in", "not_in", "contains", "starts_with", "is_blank", "not_blank"]);
  assert.deepEqual(OPERATORS.picklist, OPERATORS.text);
  assert.deepEqual(OPERATORS.number, ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_blank"]);
  assert.deepEqual(OPERATORS.date, ["eq", "before", "after", "between", "is_blank"]);
  assert.deepEqual(OPERATORS.datetime, OPERATORS.date);
  assert.deepEqual(OPERATORS.boolean, ["eq", "is_blank"]);
  assert.deepEqual(OPERATORS.reference, ["eq", "neq", "in", "not_in", "is_blank", "not_blank"]);
  bad({ type: "solar", filters: [{ field: "solar.contract_amount", op: "contains", value: "1" }] }, "BAD_OPERATOR", "filters[0].op");
  bad({ type: "solar", filters: [{ field: "solar.contract_amount", op: "not_blank" }] }, "BAD_OPERATOR", "filters[0].op");
  bad({ type: "solar", filters: [{ field: "solar.sales_rep_sf_id", op: "contains", value: "a" }] }, "BAD_OPERATOR", "filters[0].op");
  bad({ type: "solar", filters: [{ field: "solar.battery_only_sale", op: "neq", value: true }] }, "BAD_OPERATOR", "filters[0].op");
});

test("filters normalize to the wire form", () => {
  const w = (filters) => ok({ type: "solar", columns: ["solar.stage"], filters }).wire.filters;
  assert.deepEqual(w([{ field: "solar.stage", op: "in", value: ["A", "A", "B"] }]), [{ alias: "solar", column: "stage", op: "in", value: ["A", "B"] }]);
  assert.deepEqual(w([{ field: "solar.contract_amount", op: "between", value: [1, "2.5"] }]), [{ alias: "solar", column: "contract_amount", op: "between", value: ["1", "2.5"] }]);
  assert.deepEqual(w([{ field: "solar.battery_only_sale", op: "eq", value: false }]), [{ alias: "solar", column: "battery_only_sale", op: "eq", value: "false" }]);
  assert.deepEqual(w([{ field: "solar.stage", op: "is_blank" }]), [{ alias: "solar", column: "stage", op: "is_blank", value: null }]);
  // date: eq a date stays eq; a token becomes between; before / after become lt / gt
  assert.deepEqual(w([{ field: "solar.contract_date", op: "eq", value: "2026-10-05" }])[0], { alias: "solar", column: "contract_date", op: "eq", value: "2026-10-05" });
  assert.deepEqual(w([{ field: "solar.contract_date", op: "eq", value: "this_month" }])[0].value, ["2026-11-01", "2026-11-30"]);
  assert.equal(w([{ field: "solar.contract_date", op: "before", value: "2026-10-05" }])[0].op, "lt");
  assert.equal(w([{ field: "solar.contract_date", op: "after", value: "2026-10-05" }])[0].op, "gt");
  // datetime: whole Arizona days, [start, start of the day after)
  assert.deepEqual(w([{ field: "solar.created_date", op: "between", value: ["2026-10-01", "2026-10-31"] }]), [
    { alias: "solar", column: "created_date", op: "gte", value: "2026-10-01T00:00:00-07:00" },
    { alias: "solar", column: "created_date", op: "lt", value: "2026-11-01T00:00:00-07:00" },
  ]);
  assert.deepEqual(w([{ field: "solar.created_date", op: "after", value: "2026-10-31" }]), [
    { alias: "solar", column: "created_date", op: "gte", value: "2026-11-01T00:00:00-07:00" },
  ]);
});

test("bad values name the value", () => {
  bad({ type: "solar", filters: [{ field: "solar.contract_amount", op: "eq", value: "lots" }] }, "BAD_VALUE", "filters[0].value");
  bad({ type: "solar", filters: [{ field: "solar.contract_amount", op: "between", value: [5, 1] }] }, "BAD_VALUE", "filters[0].value");
  bad({ type: "solar", filters: [{ field: "solar.contract_date", op: "between", value: ["2026-02-30", "2026-03-01"] }] }, "BAD_VALUE", "filters[0].value");
  bad({ type: "solar", filters: [{ field: "solar.contract_date", op: "between", value: "next_month" }] }, "BAD_VALUE", "filters[0].value");
  bad({ type: "solar", filters: [{ field: "solar.contract_date", op: "eq", value: "last_n_days:9999" }] }, "BAD_VALUE", "filters[0].value");
  bad({ type: "solar", filters: [{ field: "solar.stage", op: "in", value: [] }] }, "BAD_VALUE", "filters[0].value");
  bad({ type: "solar", filters: [{ field: "solar.stage", op: "eq", value: "" }] }, "BAD_VALUE", "filters[0].value");
  bad({ type: "solar", filters: [{ field: "solar.stage", op: "is_blank", value: "x" }] }, "BAD_VALUE", "filters[0].value");
  bad({ type: "solar", filters: [{ field: "solar.battery_only_sale", op: "eq", value: "yes" }] }, "BAD_VALUE", "filters[0].value");
  bad({ type: "solar", filters: ["stage = 1"] }, "BAD_FILTER", "filters[0]");
});

test("unknown things are 400s that name the field", () => {
  bad({ type: "nope" }, "UNKNOWN_TYPE", "type");
  bad({ type: "solar", columns: ["solar.nope"] }, "UNKNOWN_FIELD", "columns[0]");
  bad({ type: "solar", columns: ["dealer.name"] }, "UNKNOWN_FIELD", "columns[0]");
  bad({ type: "solar", columns: ["__proto__.name"] }, "UNKNOWN_FIELD", "columns[0]");
  bad({ type: "solar", columns: ["stage"] }, "UNKNOWN_FIELD", "columns[0]");
  bad({ type: "solar", columns: ["solar.sf_id"] }, "FIELD_NOT_REPORTABLE", "columns[0]");
  bad({ type: "solar", sql: "select 1" }, "BAD_DEFINITION", "sql");
  bad({ type: "solar", columns: "solar.stage" }, "BAD_DEFINITION", "columns");
  bad(null, "BAD_DEFINITION", "");
  bad({ type: "solar", filters: [{ field: "rep.nope", op: "eq", value: "x" }] }, "UNKNOWN_FIELD", "filters[0].field");
});

test("columns: defaults, duplicates, the 50 cap, long text", () => {
  const d = ok({ type: "solar" }, { catalog: undefined }); // the REAL catalog: defaults all exist
  assert.deepEqual(d.output.map((o) => o.field), [...REPORT_TYPES.solar.defaultColumns]);
  bad({ type: "solar", columns: ["solar.stage", "solar.stage"] }, "DUPLICATE_COLUMN", "columns[1]");
  bad({ type: "solar", columns: Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => `solar.c${i}`) }, "TOO_MANY_COLUMNS", "columns");
  bad({ type: "solar", columns: ["solar.notes"] }, "LONG_TEXT_NOT_SELECTABLE", "columns[0]");
  bad({ type: "solar", groupBy: ["solar.notes"] }, "LONG_TEXT_NOT_SELECTABLE", "groupBy[0]");
  // ...but a long-text field can be filtered on.
  ok({ type: "solar", columns: ["solar.stage"], filters: [{ field: "solar.notes", op: "contains", value: "roof" }] });
  bad({ type: "solar", columns: [] }, "NO_COLUMNS", "columns");
});

test("group: one level, columns must be the group, output = group then aggregates", () => {
  bad({ type: "solar", groupBy: ["solar.stage", "rep.name"] }, "TOO_MANY_GROUPS", "groupBy");
  bad({ type: "solar", groupBy: ["solar.stage"], columns: ["solar.project_name"] }, "COLUMN_NOT_GROUPED", "columns[0]");
  const r = ok({ type: "solar", groupBy: ["solar.stage"], columns: ["solar.stage"], aggregates: [{ fn: "count" }, { fn: "avg", field: "solar.contract_amount" }] });
  assert.equal(r.wire.grouped, true);
  assert.deepEqual(r.wire.columns, [{ alias: "solar", column: "stage" }]);
  assert.deepEqual(r.output.map((o) => [o.field, o.type]), [["solar.stage", "picklist"], ["count", "number"], ["avg_solar_contract_amount", "number"]]);
  assert.equal(r.output[2].label, "Average CONTRACT_AMOUNT");
});

test("aggregates: count takes no field; sum / avg numbers; min / max numbers and dates", () => {
  bad({ type: "solar", aggregates: [{ fn: "count", field: "solar.stage" }] }, "BAD_AGGREGATE", "aggregates[0].field");
  bad({ type: "solar", aggregates: [{ fn: "sum", field: "solar.stage" }] }, "BAD_AGGREGATE", "aggregates[0].field");
  bad({ type: "solar", aggregates: [{ fn: "avg", field: "solar.contract_date" }] }, "BAD_AGGREGATE", "aggregates[0].field");
  bad({ type: "solar", aggregates: [{ fn: "median", field: "solar.contract_amount" }] }, "BAD_AGGREGATE", "aggregates[0].fn");
  bad({ type: "solar", aggregates: [{ fn: "count" }, { fn: "count" }] }, "BAD_AGGREGATE", "aggregates[1]");
  const r = ok({ type: "solar", aggregates: [{ fn: "min", field: "solar.contract_date" }, { fn: "max", field: "solar.created_date" }] });
  assert.deepEqual(r.totals.map((t) => [t.field, t.type]), [["min_solar_contract_date", "date"], ["max_solar_created_date", "datetime"]]);
  assert.deepEqual(r.output, []); // aggregates only: no rows
});

test("sort: only on what the report shows; aggregates only when grouped", () => {
  const r = ok({ type: "solar", columns: ["solar.stage", "solar.contract_amount"], sort: [{ field: "solar.contract_amount", dir: "desc" }, { field: "solar.stage" }] });
  assert.deepEqual(r.wire.sort, [{ position: 2, dir: "desc" }, { position: 1, dir: "asc" }]);
  bad({ type: "solar", columns: ["solar.stage"], sort: [{ field: "solar.project_name" }] }, "BAD_SORT", "sort[0].field");
  bad({ type: "solar", columns: ["solar.stage"], aggregates: [{ fn: "count" }], sort: [{ field: "count" }] }, "BAD_SORT", "sort[0].field");
  bad({ type: "solar", columns: ["solar.stage"], sort: [{ field: "solar.stage", dir: "up" }] }, "BAD_SORT", "sort[0].dir");
  bad({ type: "solar", columns: ["solar.stage"], sort: [{ field: "solar.stage" }, { field: "solar.stage" }] }, "BAD_SORT", "sort[1].field");
  const g = ok({ type: "solar", groupBy: ["rep.name"], aggregates: [{ fn: "count" }], sort: [{ field: "count", dir: "desc" }] });
  assert.deepEqual(g.wire.sort, [{ position: 2, dir: "desc" }]);
});

test("limit: default and cap 5,000", () => {
  assert.equal(ok({ type: "solar", columns: ["solar.stage"] }).wire.limit, MAX_ROWS);
  assert.equal(ok({ type: "solar", columns: ["solar.stage"], limit: 25 }).wire.limit, 25);
  bad({ type: "solar", columns: ["solar.stage"], limit: 5001 }, "BAD_LIMIT", "limit");
  bad({ type: "solar", columns: ["solar.stage"], limit: 0 }, "BAD_LIMIT", "limit");
  bad({ type: "solar", columns: ["solar.stage"], limit: 2.5 }, "BAD_LIMIT", "limit");
});

test("a gated column is REMOVED (columns, filters, groupBy, aggregates, sort) and named", () => {
  const def = {
    type: "solar",
    columns: ["solar.stage", "solar.secret_cost"],
    filters: [{ field: "solar.secret_cost", op: "gt", value: 1 }, { field: "solar.stage", op: "eq", value: "A" }],
    aggregates: [{ fn: "sum", field: "solar.secret_cost" }, { fn: "count" }],
    sort: [{ field: "solar.secret_cost", dir: "desc" }],
  };
  const r = ok(def);
  assert.deepEqual(r.wire.columns, [{ alias: "solar", column: "stage" }]);
  assert.deepEqual(r.wire.filters.map((f) => f.column), ["stage"]);
  assert.deepEqual(r.wire.aggregates.map((a) => a.name), ["count"]);
  assert.deepEqual(r.wire.sort, []);
  assert.deepEqual(r.stripped, ["solar.secret_cost"]);
  assert.deepEqual(r.wire.allowedGates, []);
  // grouped on a gated aggregate's sort: removed with it
  const g = ok({ type: "solar", groupBy: ["solar.stage"], aggregates: [{ fn: "sum", field: "solar.secret_cost" }], sort: [{ field: "sum_solar_secret_cost" }] });
  assert.deepEqual(g.wire.sort, []);
  // a holder keeps everything, and the wire says which gates it holds
  const held = ok(def, { heldGates: ["service.costing.read"] });
  assert.deepEqual(held.wire.columns.map((c) => c.column), ["stage", "secret_cost"]);
  assert.deepEqual(held.stripped, []);
  assert.deepEqual(held.wire.allowedGates, ["service.costing.read"]);
  // nothing left to show → a 400 that says why
  const r2 = bad({ type: "solar", columns: ["solar.secret_cost"] }, "NO_COLUMNS", "columns");
  assert.match(r2.body.message, /permission/);
  bad({ type: "solar", groupBy: ["solar.secret_cost"] }, "NO_COLUMNS", "groupBy");
});

test("the wire carries the type's joins, base and every alias's table", () => {
  const r = ok({ type: "solar", columns: ["customer.name", "rep.name"] });
  assert.deepEqual(r.wire.base, { table: "sundial_solar_cache", alias: "solar" });
  assert.deepEqual(r.wire.joins, [
    { table: "sundial_customer_cache", alias: "customer", kind: "left", left_alias: "solar", left_column: "sundial_customer_sf_id", right_column: "sf_id" },
    { table: "sundial_user_cache", alias: "rep", kind: "left", left_alias: "solar", left_column: "sales_rep_sf_id", right_column: "sf_id" },
  ]);
  assert.deepEqual(r.objects, ["solar", "customer", "user"]);
});
