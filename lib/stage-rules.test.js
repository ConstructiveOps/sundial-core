// node --test lib/stage-rules.test.js — the explicit terminal list (D-092).

import test from "node:test";
import assert from "node:assert/strict";
import { CATALOG } from "./report-catalog/index.js";
import {
  SOLAR_TERMINAL_STAGES, SOLAR_ACTIVE_DESPITE_TERM, LEGACY_TERMINAL_TERMS, isTerminalSolarStage,
} from "./stage-rules.js";

const picklist = () => CATALOG.solar.fields.find((f) => f.column === "stage").picklistValues.map((p) => (typeof p === "string" ? p : p.value));

test("the explicit list = the old substring result over the live picklist, minus the active exceptions", () => {
  const substring = picklist().filter((s) => LEGACY_TERMINAL_TERMS.some((t) => s.toLowerCase().includes(t)));
  const expected = substring.filter((s) => !SOLAR_ACTIVE_DESPITE_TERM.includes(s));
  // A NEW stage containing an old term fails here: decide which side it is on, on purpose.
  assert.deepEqual([...SOLAR_TERMINAL_STAGES].sort(), expected.sort());
});

test("every listed stage is a real picklist value", () => {
  const values = new Set(picklist());
  for (const s of [...SOLAR_TERMINAL_STAGES, ...SOLAR_ACTIVE_DESPITE_TERM]) assert.ok(values.has(s), s);
});

test("D-092: Inspection Completed and Go Back Items Complete are active", () => {
  assert.equal(isTerminalSolarStage("Inspection Completed"), false);
  assert.equal(isTerminalSolarStage("Go Back Items Complete"), false);
  assert.equal(isTerminalSolarStage("Billing Complete - Pending Closeout"), false);
  assert.equal(isTerminalSolarStage("Archive"), true);
  assert.equal(isTerminalSolarStage("archive"), false, "exact match, not case-folded");
  assert.equal(isTerminalSolarStage(""), false);
  assert.equal(isTerminalSolarStage(null), false);
});
