// lib/report-def.js — validate and normalize a report definition (D-088, R1a;
// docs/reporting-module.md §6.3). PURE: no I/O. The sundial-reports Lambda calls
// normalizeDefinition() on every POST /reports/run body; what comes back is either a 400 that
// names the offending field, or the "wire" definition public.sundial_report_run executes.
//
// WHAT THIS DECIDES (and the database re-checks — two locks, one key):
//   - every field is "<alias>.<column>", the alias is one of the report type's, and the column
//     is a REPORTABLE column of that object's catalog (lib/report-catalog/<object>.json);
//   - the operator is one §6.3 allows for the column's type, and the value has its shape;
//   - relative dates (this_month, last_month, this_quarter, ytd, last_n_days:N) become real
//     dates in ARIZONA time — the server's clock, never the browser's — so a saved report is
//     re-runnable;
//   - one group level; aggregates count / sum / avg / min / max; sort only on what the report
//     shows; limit ≤ 5,000; ≤ 50 columns;
//   - a column a gate protects (catalog `gate`, i.e. lib/cost-gate.js) is REMOVED for a caller
//     who does not hold the gate's action — from columns, filters, groupBy, aggregates and sort
//     — and named in `stripped`. Removed, not refused: the same rule as every other cost read.
//
// WHAT IT NEVER DOES: build SQL. The wire definition names tables, aliases and columns as
// data; sundial_report_run quotes them (%I / %L) after looking each one up in
// public.sundial_report_catalog.
//
// Operators per catalog type (§6.3 exactly, plus the types §6.3 did not name — D-088):
//   text, picklist, multipicklist  eq neq in not_in contains starts_with is_blank not_blank
//   reference                      eq neq in not_in is_blank not_blank
//   number                         eq neq gt gte lt lte between is_blank
//   date, datetime                 eq before after between is_blank  (+ relative tokens)
//   boolean                        eq is_blank
// `neq` and `not_in` INCLUDE blank rows (IS DISTINCT FROM — most columns are mostly blank,
// and "stage is not Archive" must not silently drop every row with no stage; the D-080 rule).
// `contains` / `starts_with` are case-insensitive. A multipicklist is its stored "A;B;C"
// text, so `contains` on it matches one value inside the list.

import { CATALOG } from "./report-catalog/index.js";
import { reportType, aliasesOf } from "./report-types.js";

export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 50;
export const MAX_FILTERS = 50;
export const MAX_IN_VALUES = 500;
export const MAX_AGGREGATES = 10;
export const MAX_SORT = 5;
export const MAX_TEXT_VALUE = 500;
export const MAX_LAST_N_DAYS = 3660;

// Arizona does not observe daylight saving time: it is UTC-07:00 all year, so a local
// midnight is always "T00:00:00-07:00". The tenant's zone (§6.3) — Harmon's, and the only
// tenant zone today; a tenant setting when a second zone exists.
export const REPORT_TIME_ZONE = "America/Phoenix";
export const REPORT_UTC_OFFSET = "-07:00";

const TEXT_OPS = ["eq", "neq", "in", "not_in", "contains", "starts_with", "is_blank", "not_blank"];
export const OPERATORS = Object.freeze({
  text: TEXT_OPS,
  picklist: TEXT_OPS,
  multipicklist: TEXT_OPS,
  reference: ["eq", "neq", "in", "not_in", "is_blank", "not_blank"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_blank"],
  date: ["eq", "before", "after", "between", "is_blank"],
  datetime: ["eq", "before", "after", "between", "is_blank"],
  boolean: ["eq", "is_blank"],
});

export const AGGREGATE_FNS = Object.freeze(["count", "sum", "avg", "min", "max"]);
const AGG_TYPES = { sum: ["number"], avg: ["number"], min: ["number", "date", "datetime"], max: ["number", "date", "datetime"] };
const AGG_LABEL = { count: "Count", sum: "Sum of", avg: "Average", min: "Min", max: "Max" };

const DEF_KEYS = new Set(["type", "columns", "filters", "groupBy", "aggregates", "sort", "limit", "chart"]);
const NO_VALUE_OPS = new Set(["is_blank", "not_blank"]);
const LIST_OPS = new Set(["in", "not_in"]);

// --- errors ------------------------------------------------------------------------
class DefError extends Error {
  constructor(code, field, message) {
    super(message);
    this.code = code;
    this.field = field;
  }
}
const fail = (code, field, message) => {
  throw new DefError(code, field, message);
};

// --- dates (Arizona) -----------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in Arizona, "YYYY-MM-DD". */
export function arizonaToday(now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const toUtc = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fromUtc = (dt) => dt.toISOString().slice(0, 10);
const addDays = (ymd, n) => {
  const dt = toUtc(ymd);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUtc(dt);
};
const monthStart = (y, m) => fromUtc(new Date(Date.UTC(y, m, 1)));
const monthEnd = (y, m) => fromUtc(new Date(Date.UTC(y, m + 1, 0)));

/** Is this a real calendar date (2026-02-30 is not)? */
function isDate(v) {
  return typeof v === "string" && DATE_RE.test(v) && fromUtc(toUtc(v)) === v;
}

/**
 * A relative token → [start, end] dates, both INCLUSIVE, in Arizona; null when `v` is not a
 * token. last_n_days:N is N days ending today (today included): last_n_days:1 = today.
 */
export function resolveRelative(v, now = new Date()) {
  if (typeof v !== "string") return null;
  const today = arizonaToday(now);
  const [y, m] = today.split("-").map(Number);
  switch (v) {
    case "this_month":
      return [monthStart(y, m - 1), monthEnd(y, m - 1)];
    case "last_month":
      return [monthStart(y, m - 2), monthEnd(y, m - 2)];
    case "this_quarter": {
      const q0 = Math.floor((m - 1) / 3) * 3;
      return [monthStart(y, q0), monthEnd(y, q0 + 2)];
    }
    case "ytd":
      return [`${y}-01-01`, today];
  }
  const n = /^last_n_days:(\d{1,4})$/.exec(v);
  if (n) {
    const days = Number(n[1]);
    if (days < 1 || days > MAX_LAST_N_DAYS) return undefined; // a token, but out of range
    return [addDays(today, -(days - 1)), today];
  }
  return null;
}

/** Arizona local midnight at the start of a date, as a timestamptz literal. */
const startOf = (ymd) => `${ymd}T00:00:00${REPORT_UTC_OFFSET}`;

// --- field resolution ------------------------------------------------------------------
function makeResolver(type, catalog) {
  const aliases = aliasesOf(type);
  const index = new Map();
  for (const [alias, objectKey] of aliases) {
    const cat = catalog[objectKey];
    if (!cat) throw new Error(`report type ${type.key}: no catalog for object ${objectKey}`);
    index.set(alias, { objectKey, table: cat.table, byColumn: new Map(cat.fields.map((f) => [f.column, f])) });
  }
  return (ref, where) => {
    if (typeof ref !== "string" || !ref.includes(".")) fail("UNKNOWN_FIELD", where, `${where}: expected "<alias>.<column>", got ${JSON.stringify(ref)}.`);
    const dot = ref.indexOf(".");
    const alias = ref.slice(0, dot);
    const column = ref.slice(dot + 1);
    const a = index.get(alias) ?? null; // a Map: no prototype keys to trip over
    if (!a) fail("UNKNOWN_FIELD", where, `${where}: "${alias}" is not part of the ${type.key} report type (${[...aliases.keys()].join(", ")}).`);
    const entry = a.byColumn.get(column);
    if (!entry) fail("UNKNOWN_FIELD", where, `${where}: ${ref} is not a field of ${a.objectKey}.`);
    if (!entry.reportable) fail("FIELD_NOT_REPORTABLE", where, `${where}: ${ref} cannot be used in a report.`);
    return { ref, alias, column, entry };
  };
}

// --- values ------------------------------------------------------------------------------
function scalarFor(type, v, where) {
  switch (type) {
    case "number": {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      if (!Number.isFinite(n)) fail("BAD_VALUE", where, `${where}: expected a number.`);
      return String(n);
    }
    case "boolean":
      if (v !== true && v !== false) fail("BAD_VALUE", where, `${where}: expected true or false.`);
      return String(v);
    case "date":
    case "datetime":
      if (!isDate(v)) fail("BAD_VALUE", where, `${where}: expected a date (YYYY-MM-DD) or a relative date.`);
      return v;
    default:
      if (typeof v !== "string" || v.length === 0 || v.length > MAX_TEXT_VALUE) {
        fail("BAD_VALUE", where, `${where}: expected text of 1–${MAX_TEXT_VALUE} characters.`);
      }
      return v;
  }
}

/** A date range [a, b] (inclusive) from a token or a pair of dates. */
function dateRange(value, where, now) {
  if (typeof value === "string") {
    const r = resolveRelative(value, now);
    if (r === undefined) fail("BAD_VALUE", where, `${where}: last_n_days must be 1–${MAX_LAST_N_DAYS}.`);
    if (!r) fail("BAD_VALUE", where, `${where}: ${JSON.stringify(value)} is not a relative date (this_month, last_month, this_quarter, ytd, last_n_days:N).`);
    return r;
  }
  if (!Array.isArray(value) || value.length !== 2 || !isDate(value[0]) || !isDate(value[1])) {
    fail("BAD_VALUE", where, `${where}: expected [from, to] dates (YYYY-MM-DD) or a relative date.`);
  }
  if (value[0] > value[1]) fail("BAD_VALUE", where, `${where}: the first date is after the second.`);
  return value;
}

/** One filter → one or more wire filters ({alias, column, op, value}). */
function normalizeFilter(f, i, resolve, now) {
  const where = `filters[${i}]`;
  if (!f || typeof f !== "object" || Array.isArray(f)) fail("BAD_FILTER", where, `${where}: expected { field, op, value }.`);
  const fld = resolve(f.field, `${where}.field`);
  const type = fld.entry.type;
  const op = f.op;
  if (typeof op !== "string" || !OPERATORS[type].includes(op)) {
    fail("BAD_OPERATOR", `${where}.op`, `${where}.op: ${JSON.stringify(op)} is not allowed on ${fld.ref} (${type}: ${OPERATORS[type].join(", ")}).`);
  }
  const w = (wop, value) => ({ alias: fld.alias, column: fld.column, op: wop, value });
  const vWhere = `${where}.value`;
  if (NO_VALUE_OPS.has(op)) {
    if (f.value !== undefined && f.value !== null) fail("BAD_VALUE", vWhere, `${vWhere}: ${op} takes no value.`);
    return { field: fld, wire: [w(op, null)] };
  }
  if (type === "date" || type === "datetime") {
    let range;
    if (op === "between" || (op === "eq" && typeof f.value === "string" && !isDate(f.value))) range = dateRange(f.value, vWhere, now);
    else if (op === "eq") range = [scalarFor("date", f.value, vWhere), f.value];
    if (type === "date") {
      if (range) return { field: fld, wire: [range[0] === range[1] ? w("eq", range[0]) : w("between", range)] };
      const d = scalarFor("date", f.value, vWhere);
      return { field: fld, wire: [w(op === "before" ? "lt" : "gt", d)] };
    }
    // datetime: whole Arizona days, as [start-of-first-day, start-of-day-after-last).
    if (range) return { field: fld, wire: [w("gte", startOf(range[0])), w("lt", startOf(addDays(range[1], 1)))] };
    const d = scalarFor("date", f.value, vWhere);
    return { field: fld, wire: [op === "before" ? w("lt", startOf(d)) : w("gte", startOf(addDays(d, 1)))] };
  }
  if (LIST_OPS.has(op)) {
    if (!Array.isArray(f.value) || f.value.length === 0 || f.value.length > MAX_IN_VALUES) {
      fail("BAD_VALUE", vWhere, `${vWhere}: ${op} takes a list of 1–${MAX_IN_VALUES} values.`);
    }
    return { field: fld, wire: [w(op, [...new Set(f.value.map((v, k) => scalarFor(type, v, `${vWhere}[${k}]`)))])] };
  }
  if (op === "between") {
    if (!Array.isArray(f.value) || f.value.length !== 2) fail("BAD_VALUE", vWhere, `${vWhere}: between takes [from, to].`);
    const a = scalarFor(type, f.value[0], `${vWhere}[0]`);
    const b = scalarFor(type, f.value[1], `${vWhere}[1]`);
    if (Number(a) > Number(b)) fail("BAD_VALUE", vWhere, `${vWhere}: the first number is larger than the second.`);
    return { field: fld, wire: [w("between", [a, b])] };
  }
  return { field: fld, wire: [w(op, scalarFor(type, f.value, vWhere))] };
}

const asList = (v, where) => {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) fail("BAD_DEFINITION", where, `${where}: expected a list.`);
  return v;
};

/**
 * Validate + normalize. Never throws for a bad definition — returns the 400.
 *
 * @param {object} def           the request body
 * @param {object} opts
 * @param {string[]} opts.heldGates  the gate actions the caller holds (e.g. ["service.costing.read"])
 * @param {Date}     [opts.now]      the clock (tests)
 * @param {object}   [opts.catalog]  the catalog (tests); default lib/report-catalog
 * @returns {{ ok:true, wire:object, output:Array<{field,label,type}>, totals:Array<{field,label,type}>,
 *             stripped:string[], objects:string[] }
 *   output = what each position of a returned row is; totals = the grand-total aggregates
 *   (computed over EVERY matching row, not just the ≤ 5,000 returned), by name.
 *          | { ok:false, status:400, body:{ error, code, field, message } }}
 */
export function normalizeDefinition(def, { heldGates = [], now = new Date(), catalog = CATALOG } = {}) {
  try {
    return { ok: true, ...normalize(def, { heldGates, now, catalog }) };
  } catch (e) {
    if (!(e instanceof DefError)) throw e;
    return { ok: false, status: 400, body: { error: "invalid_report", code: e.code, field: e.field, message: e.message } };
  }
}

function normalize(def, { heldGates, now, catalog }) {
  if (!def || typeof def !== "object" || Array.isArray(def)) fail("BAD_DEFINITION", "", "The report definition must be a JSON object.");
  for (const k of Object.keys(def)) if (!DEF_KEYS.has(k)) fail("BAD_DEFINITION", k, `${k}: not a report definition key (${[...DEF_KEYS].join(", ")}).`);
  const type = reportType(def.type);
  if (!type) fail("UNKNOWN_TYPE", "type", `type: ${JSON.stringify(def.type)} is not a report type.`);
  const resolve = makeResolver(type, catalog);
  const held = new Set(heldGates);
  const stripped = new Set();
  /** Resolve, then drop it (recording why) when its gate is not held. Returns null when dropped. */
  const visible = (fld) => {
    if (fld.entry.gate && !held.has(fld.entry.gate)) {
      stripped.add(fld.ref);
      return null;
    }
    return fld;
  };
  const selectable = (fld, where) => {
    if (fld.entry.longText) fail("LONG_TEXT_NOT_SELECTABLE", where, `${where}: ${fld.ref} is long text — it can be filtered on, not shown, grouped or sorted (R1b: CSV only).`);
    return fld;
  };

  // groupBy — one level.
  const groupIn = asList(def.groupBy, "groupBy") ?? [];
  if (groupIn.length > 1) fail("TOO_MANY_GROUPS", "groupBy", "groupBy: one group level in v1.");
  const group = groupIn.map((r, i) => visible(resolve(r, `groupBy[${i}]`))).filter(Boolean).map((f, i) => selectable(f, `groupBy[${i}]`));
  const grouped = groupIn.length === 1; // asked for, even if the gate removed it

  // aggregates
  const aggIn = asList(def.aggregates, "aggregates") ?? [];
  if (aggIn.length > MAX_AGGREGATES) fail("TOO_MANY_AGGREGATES", "aggregates", `aggregates: at most ${MAX_AGGREGATES}.`);
  const aggs = [];
  const aggNames = new Set();
  const strippedAggs = new Set(); // names of aggregates removed by a gate (their sort goes too)
  aggIn.forEach((a, i) => {
    const where = `aggregates[${i}]`;
    if (!a || typeof a !== "object" || !AGGREGATE_FNS.includes(a.fn)) {
      fail("BAD_AGGREGATE", `${where}.fn`, `${where}.fn: expected one of ${AGGREGATE_FNS.join(", ")}.`);
    }
    let fld = null;
    if (a.fn === "count") {
      if (a.field !== undefined && a.field !== null) fail("BAD_AGGREGATE", `${where}.field`, `${where}.field: count counts rows and takes no field.`);
    } else {
      fld = resolve(a.field, `${where}.field`);
      if (!visible(fld)) {
        strippedAggs.add(`${a.fn}_${fld.alias}_${fld.column}`);
        return;
      }
      if (!AGG_TYPES[a.fn].includes(fld.entry.type)) {
        fail("BAD_AGGREGATE", `${where}.field`, `${where}.field: ${a.fn} needs a ${AGG_TYPES[a.fn].join(" / ")} field; ${fld.ref} is ${fld.entry.type}.`);
      }
    }
    const name = fld ? `${a.fn}_${fld.alias}_${fld.column}` : "count";
    if (aggNames.has(name)) fail("BAD_AGGREGATE", where, `${where}: ${name} is asked for twice.`);
    aggNames.add(name);
    aggs.push({ fn: a.fn, fld, name });
  });

  // columns
  const colIn = asList(def.columns, "columns");
  let cols;
  if (grouped) {
    if (colIn) {
      colIn.forEach((r, i) => {
        if (!groupIn.includes(r)) fail("COLUMN_NOT_GROUPED", `columns[${i}]`, `columns[${i}]: ${r} is not the groupBy field; a grouped report shows the group and its aggregates.`);
      });
    }
    cols = group;
  } else {
    const refs = colIn ?? (aggIn.length ? [] : [...type.defaultColumns]);
    if (refs.length > MAX_COLUMNS) fail("TOO_MANY_COLUMNS", "columns", `columns: at most ${MAX_COLUMNS}.`);
    const seen = new Set();
    cols = [];
    refs.forEach((r, i) => {
      if (seen.has(r)) fail("DUPLICATE_COLUMN", `columns[${i}]`, `columns[${i}]: ${r} is listed twice.`);
      seen.add(r);
      const f = visible(resolve(r, `columns[${i}]`));
      if (f) cols.push(selectable(f, `columns[${i}]`));
    });
  }
  if (!grouped && cols.length === 0 && aggs.length === 0) {
    fail("NO_COLUMNS", "columns", stripped.size ? "columns: every column asked for needs a permission you do not have." : "columns: a report needs at least one column or aggregate.");
  }
  if (grouped && group.length === 0) fail("NO_COLUMNS", "groupBy", "groupBy: the group field needs a permission you do not have.");

  // filters
  const filtIn = asList(def.filters, "filters") ?? [];
  if (filtIn.length > MAX_FILTERS) fail("TOO_MANY_FILTERS", "filters", `filters: at most ${MAX_FILTERS}.`);
  const filters = [];
  filtIn.forEach((f, i) => {
    const n = normalizeFilter(f, i, resolve, now);
    if (visible(n.field)) filters.push(...n.wire);
  });

  // output columns: the group + aggregates, or the columns. Positions are 1-based.
  const output = grouped
    ? [...cols.map(outCol), ...aggs.map(outAgg)]
    : cols.map(outCol);

  // sort — only what the report shows.
  const sortIn = asList(def.sort, "sort") ?? [];
  if (sortIn.length > MAX_SORT) fail("TOO_MANY_SORTS", "sort", `sort: at most ${MAX_SORT}.`);
  const sort = [];
  sortIn.forEach((s, i) => {
    const where = `sort[${i}]`;
    if (!s || typeof s !== "object") fail("BAD_SORT", where, `${where}: expected { field, dir }.`);
    const dir = s.dir === undefined ? "asc" : s.dir;
    if (dir !== "asc" && dir !== "desc") fail("BAD_SORT", `${where}.dir`, `${where}.dir: asc or desc.`);
    const pos = output.findIndex((o) => o.field === s.field);
    if (pos < 0 && strippedAggs.has(s.field)) return;
    if (pos < 0 && typeof s.field === "string" && s.field.includes(".")) {
      // A gated column the caller cannot see was removed above — its sort goes with it.
      const fld = resolve(s.field, `${where}.field`);
      if (!visible(fld)) return;
    }
    if (pos < 0) fail("BAD_SORT", `${where}.field`, `${where}.field: ${JSON.stringify(s.field)} is not one of the report's ${grouped ? "group / aggregate" : "columns"}.`);
    if (sort.some((x) => x.position === pos + 1)) fail("BAD_SORT", `${where}.field`, `${where}.field: sorted twice.`);
    sort.push({ position: pos + 1, dir });
  });

  // limit
  let limit = MAX_ROWS;
  if (def.limit !== undefined && def.limit !== null) {
    if (!Number.isInteger(def.limit) || def.limit < 1 || def.limit > MAX_ROWS) fail("BAD_LIMIT", "limit", `limit: a whole number from 1 to ${MAX_ROWS}.`);
    limit = def.limit;
  }

  const aliases = aliasesOf(type);
  const tableOf = (alias) => catalog[aliases.get(alias)].table;
  const wire = {
    base: { table: tableOf(type.base.alias), alias: type.base.alias },
    joins: type.joins.map((j) => {
      const [leftAlias, leftColumn] = j.on.left.split(".");
      return { table: tableOf(j.alias), alias: j.alias, kind: j.kind, left_alias: leftAlias, left_column: leftColumn, right_column: j.on.right };
    }),
    grouped,
    columns: cols.map((f) => ({ alias: f.alias, column: f.column })),
    filters,
    aggregates: aggs.map((a) => (a.fld ? { fn: a.fn, alias: a.fld.alias, column: a.fld.column, name: a.name } : { fn: a.fn, name: a.name })),
    sort,
    limit,
    allowedGates: [...held].sort(),
  };
  return { wire, output, totals: aggs.map(outAgg), stripped: [...stripped], objects: [...new Set(aliases.values())] };
}

function outCol(f) {
  return { field: f.ref, label: f.entry.label, type: f.entry.type, object: f.alias };
}
function outAgg(a) {
  if (!a.fld) return { field: a.name, label: AGG_LABEL.count, type: "number", aggregate: "count" };
  const type = a.fn === "min" || a.fn === "max" ? a.fld.entry.type : "number";
  return { field: a.name, label: `${AGG_LABEL[a.fn]} ${a.fld.entry.label}`, type, aggregate: a.fn };
}
