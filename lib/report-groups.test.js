// node --test lib/report-groups.test.js — D-093: group labels, page sections.
import test from "node:test";
import assert from "node:assert/strict";
import { groupLabel, labelGroups, sameKey, sections, BLANK_GROUP_LABEL } from "./report-groups.js";

test("labels: periods by their period, a blank as (blank), types as people read them", () => {
  assert.equal(groupLabel("2026-11-03", { type: "date", dateTrunc: "day" }), "Nov 3, 2026");
  assert.equal(groupLabel("2026-11-02", { type: "date", dateTrunc: "week" }), "Week of Nov 2, 2026");
  assert.equal(groupLabel("2026-11-01", { type: "date", dateTrunc: "month" }), "November 2026");
  assert.equal(groupLabel("2026-10-01", { type: "date", dateTrunc: "quarter" }), "Q4 2026");
  assert.equal(groupLabel("2026-01-01", { type: "date", dateTrunc: "year" }), "2026");
  assert.equal(groupLabel(null, { type: "text" }), BLANK_GROUP_LABEL);
  assert.equal(groupLabel("", { type: "text" }), BLANK_GROUP_LABEL);
  assert.equal(groupLabel(true, { type: "boolean" }), "Yes");
  assert.equal(groupLabel(false, { type: "boolean" }), "No");
  assert.equal(groupLabel("2026-11-05", { type: "date" }), "Nov 5, 2026");
  assert.equal(groupLabel("2026-11-01T06:30:00+00:00", { type: "datetime" }), "2026-10-31 23:30");
  assert.equal(groupLabel(1500, { type: "number" }), "1500");
  assert.equal(groupLabel("Ann", { type: "text" }), "Ann");
});

test("labelGroups / sameKey / sections", () => {
  const g = labelGroups([{ key: "Ann", first: 0, shown: 2, count: 5, aggregates: { count: 5 } }, { key: null, first: 2, shown: 1, count: 1 }], { type: "text" });
  assert.deepEqual(g, [
    { key: "Ann", label: "Ann", count: 5, aggregates: { count: 5 }, first: 0, shown: 2 },
    { key: null, label: "(blank)", count: 1, aggregates: {}, first: 2, shown: 1 },
  ]);
  assert.equal(sameKey(null, undefined), true);
  assert.equal(sameKey("1", 1), false);
  assert.equal(sameKey("2026-11-01", "2026-11-01"), true);
  const s = sections([["a"], ["b"], ["c"]], g, [{ x: 1 }, { x: 2 }, { x: 3 }]);
  assert.deepEqual(s.map((x) => [x.group.label, x.rows, x.records]), [["Ann", [["a"], ["b"]], [{ x: 1 }, { x: 2 }]], ["(blank)", [["c"]], [{ x: 3 }]]]);
  assert.deepEqual(labelGroups(undefined, {}), []);
});
