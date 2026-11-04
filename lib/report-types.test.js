// node --test lib/report-types.test.js
//
// Pinned (D-088): every report type is consistent with the GENERATED catalog — each alias's
// object has a catalog, every `on` column exists there (the left one reportable or a join
// key, the right one a join key), every default column is reportable and selectable; joins
// are left joins; aliases are unique and well-formed (the SQL function's alias rule); and
// the solar type is exactly solar ⟕ customer ⟕ rep (no dealer, no PM — D-088).

import test from "node:test";
import assert from "node:assert/strict";
import { REPORT_TYPES, reportType, aliasesOf, describeTypes } from "./report-types.js";
import { CATALOG } from "./report-catalog/index.js";

const ALIAS_RE = /^[a-z][a-z0-9_]{0,30}$/; // sql/sundial_report_run.sql alias_re

test("every type agrees with the catalog", () => {
  for (const t of Object.values(REPORT_TYPES)) {
    const aliases = aliasesOf(t);
    assert.equal(aliases.size, 1 + t.joins.length, `${t.key}: duplicate alias`);
    for (const [alias, objectKey] of aliases) {
      assert.match(alias, ALIAS_RE, `${t.key}: alias ${alias}`);
      assert.ok(CATALOG[objectKey], `${t.key}: no catalog for ${objectKey}`);
    }
    const col = (alias, column) => CATALOG[aliases.get(alias)].fields.find((f) => f.column === column);
    for (const j of t.joins) {
      assert.equal(j.kind, "left", `${t.key}.${j.alias}`);
      const [la, lc] = j.on.left.split(".");
      assert.ok(aliases.has(la), `${t.key}.${j.alias}: left alias ${la}`);
      assert.ok(col(la, lc), `${t.key}.${j.alias}: ${j.on.left} is not in the catalog`);
      assert.ok(col(j.alias, j.on.right), `${t.key}.${j.alias}: ${j.alias}.${j.on.right} is not in the catalog`);
    }
    for (const ref of t.defaultColumns) {
      const [a, c] = ref.split(".");
      const f = aliases.has(a) ? col(a, c) : null;
      assert.ok(f, `${t.key}: default column ${ref} is not in the catalog`);
      assert.ok(f.reportable && !f.longText && !f.gate, `${t.key}: default column ${ref} must be reportable, short and ungated`);
    }
  }
});

test("solar = solar ⟕ customer ⟕ user as rep (no dealer join, no PM join — D-088)", () => {
  const t = reportType("solar");
  assert.deepEqual([...aliasesOf(t)], [["solar", "solar"], ["customer", "customer"], ["rep", "user"]]);
  assert.deepEqual(t.joins.map((j) => [j.alias, j.on.left, j.on.right]), [
    ["customer", "solar.sundial_customer_sf_id", "sf_id"],
    ["rep", "solar.sales_rep_sf_id", "sf_id"],
  ]);
});

test("reportType is an own-property lookup", () => {
  assert.equal(reportType("__proto__"), null);
  assert.equal(reportType("constructor"), null);
  assert.equal(reportType(undefined), null);
});

test("describeTypes carries no table names (the browser never needs one)", () => {
  const d = describeTypes();
  assert.equal(d.length, Object.keys(REPORT_TYPES).length);
  assert.doesNotMatch(JSON.stringify(d), /_cache/);
  assert.deepEqual(d[0].joins.map((j) => j.alias), ["customer", "rep"]);
});
