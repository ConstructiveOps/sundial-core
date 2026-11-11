// node --test lib/report-assist-schema.test.js — the assistant's tools are the definition rules
// (D-092): every field / operator / value the schema allows is one normalizeDefinition accepts.

import test from "node:test";
import assert from "node:assert/strict";
import { CATALOG } from "./report-catalog/index.js";
import { REPORT_TYPES } from "./report-types.js";
import { normalizeDefinition, OPERATORS, DATE_TRUNCS, MAX_ROWS } from "./report-def.js";
import {
  proposeTool, visibleFields, withStrict, definitionFromInput, chooseTypeTool, ASK_QUESTION, PROPOSE_TOOL, resolveRef,
} from "./report-assist-schema.js";

const COST = "service.costing.read";
const NOW = new Date("2026-11-10T17:00:00Z");

/** Walk every object schema and check the strict-mode shape: closed, everything required. */
function assertClosed(schema, path = "") {
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, `${path}: additionalProperties false`);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path}: all required`);
    for (const [k, v] of Object.entries(schema.properties)) assertClosed(v, `${path}.${k}`);
  }
  if (schema.items) assertClosed(schema.items, `${path}[]`);
  for (const b of schema.anyOf ?? []) assertClosed(b, `${path}|`);
  if (schema.enum) assert.ok(schema.enum.length > 0, `${path}: empty enum`);
  for (const bad of ["minimum", "maximum", "maxItems", "minItems", "pattern"]) assert.equal(schema[bad], undefined, `${path}: ${bad}`);
}

for (const typeKey of Object.keys(REPORT_TYPES)) {
  for (const gates of [[], [COST]]) {
    test(`${typeKey} ${gates.length ? "(cost)" : "(no cost)"}: closed schema; every field and filter branch is valid to the validator`, () => {
      const tool = proposeTool(typeKey, gates);
      assert.equal(tool.name, PROPOSE_TOOL);
      const root = tool.input_schema;
      const { $defs, ...body } = root;
      assertClosed(body);
      for (const d of Object.values($defs)) assert.ok(d.enum.length > 0);
      const R = (node) => resolveRef(root, node);
      const p = root.properties;
      assert.deepEqual(p.type.enum, [typeKey]);

      // Every selectable column runs as a column.
      const cols = R(p.columns.items).enum;
      for (let i = 0; i < cols.length; i += 50) {
        const n = normalizeDefinition({ type: typeKey, columns: cols.slice(i, i + 50) }, { heldGates: gates, now: NOW });
        assert.equal(n.ok, true, n.body?.message);
        assert.deepEqual(n.stripped, [], "nothing the schema offers is stripped");
      }
      // Every filter branch × field × op is accepted with a value of the branch's shape.
      const sample = (value, op, type) => {
        if (value.type === "null") return null;
        if (value.type === "boolean") return true;
        if (value.type === "number") return 5;
        if (value.type === "array" && value.items?.type === "number") return [1, 2];
        if (value.type === "array") return ["A"];
        if (value.anyOf) return op === "between" ? "this_quarter" : "today";
        if (type === "date") return "2026-11-01";
        return "A";
      };
      for (const branch of p.filters.items.anyOf) {
        const { field, op, value } = branch.properties;
        for (const f of R(field).enum) {
          const entry = visibleFields(typeKey, gates).find((x) => x.ref === f).entry;
          const fam = entry.type === "datetime" ? "date" : entry.type;
          for (const o of op.enum) {
            assert.ok(OPERATORS[entry.type].includes(o), `${f} (${entry.type}) offered ${o}`);
            const n = normalizeDefinition({ type: typeKey, columns: [cols[0]], filters: [{ field: f, op: o, value: sample(value, o, fam) }] }, { heldGates: gates, now: NOW });
            assert.equal(n.ok, true, `${f} ${o}: ${n.body?.message}`);
          }
        }
      }
      // Group by period: date fields only, the D-091 truncs.
      const period = p.groupBy.items.anyOf.find((b) => b.type === "object");
      if (period) {
        assert.deepEqual(period.properties.dateTrunc.enum, [...DATE_TRUNCS]);
        const n = normalizeDefinition({ type: typeKey, groupBy: [{ field: R(period.properties.field).enum[0], dateTrunc: "week" }], aggregates: [{ fn: "count" }] }, { heldGates: gates, now: NOW });
        assert.equal(n.ok, true, n.body?.message);
      }
      // Aggregates: sum / avg numbers, min / max numbers and dates.
      for (const branch of p.aggregates.items.anyOf.filter((b) => b.properties.field)) {
        const fieldNodes = branch.properties.field.anyOf ?? [branch.properties.field];
        for (const fn of branch.properties.fn.enum) {
          for (const node of fieldNodes) {
            for (const f of R(node).enum) {
              const n = normalizeDefinition({ type: typeKey, aggregates: [{ fn, field: f }] }, { heldGates: gates, now: NOW });
              assert.equal(n.ok, true, `${fn} ${f}: ${n.body?.message}`);
            }
          }
        }
      }
    });
  }
}

test("gates: a Manager's schema has no cost / markup field; an Admin's does", () => {
  const gated = Object.values(CATALOG).flatMap((c) => c.fields.filter((f) => f.gate).map((f) => f.column));
  assert.ok(gated.length > 0);
  const noCost = JSON.stringify(proposeTool("estimates", []));
  const withCost = JSON.stringify(proposeTool("estimates", [COST]));
  assert.ok(!noCost.includes("estimate.markup_amount"));
  assert.ok(withCost.includes("estimate.markup_amount"));
  assert.ok(!JSON.stringify(proposeTool("estimate_lines", [])).includes("line.unit_labor_cost"));
});

test("long text: filterable, never a column or a group", () => {
  const fields = visibleFields("customers", []);
  const lt = fields.find((f) => f.entry.longText);
  assert.ok(lt, "customers has a long-text field");
  const root = proposeTool("customers", []).input_schema;
  const p = root.properties;
  assert.ok(!resolveRef(root, p.columns.items).enum.includes(lt.ref));
  assert.ok(!resolveRef(root, p.groupBy.items.anyOf[0]).enum.includes(lt.ref));
  assert.ok(p.filters.items.anyOf.some((b) => resolveRef(root, b.properties.field).enum.includes(lt.ref)));
});

test("withStrict adds or removes strict without touching the original", () => {
  const tools = [proposeTool("payments"), ASK_QUESTION];
  const s = withStrict(tools, true);
  assert.ok(s.every((t) => t.strict === true));
  assert.ok(tools.every((t) => t.strict === undefined));
  assert.ok(withStrict(s, false).every((t) => !("strict" in t)));
});

test("chooseType offers exactly the ten types", () => {
  assert.deepEqual(chooseTypeTool().input_schema.properties.type.enum, Object.keys(REPORT_TYPES));
});

test("definitionFromInput: summary dropped, empty lists and the default limit left out, no-value nulls removed", () => {
  const d = definitionFromInput({
    summary: "x", type: "service_jobs", columns: ["job.name"], groupBy: [], aggregates: [], sort: [],
    filters: [{ field: "job.archived", op: "is_blank", value: null }, { field: "job.created_date", op: "between", value: "this_quarter" }],
    limit: MAX_ROWS,
  });
  assert.deepEqual(d, {
    type: "service_jobs", columns: ["job.name"],
    filters: [{ field: "job.archived", op: "is_blank" }, { field: "job.created_date", op: "between", value: "this_quarter" }],
  });
  assert.equal(definitionFromInput({ type: "payments", limit: 10 }).limit, 10);
});

test("D-093: propose_report offers showDetails (a required boolean); a summary proposal validates for every type", () => {
  for (const typeKey of Object.keys(REPORT_TYPES)) {
    const root = proposeTool(typeKey).input_schema;
    assert.deepEqual(root.properties.showDetails.type, "boolean");
    assert.ok(root.required.includes("showDetails"));
    const cols = resolveRef(root, root.properties.columns.items).enum;
    const def = definitionFromInput({ summary: "x", type: typeKey, showDetails: true, columns: cols.slice(0, 3), filters: [], groupBy: [cols[0]], aggregates: [{ fn: "count" }], sort: [{ field: cols[1] ?? cols[0], dir: "asc" }], limit: 5000 });
    assert.equal(def.showDetails, true);
    const n = normalizeDefinition(def, { now: new Date() });
    assert.equal(n.ok, true, `${typeKey}: ${JSON.stringify(n.body)}`);
    assert.equal(n.summary, true);
  }
  assert.equal("showDetails" in definitionFromInput({ type: "solar", showDetails: false, columns: ["solar.project_name"] }), false);
});
