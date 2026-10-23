// node --test lib/dealer-journey.test.js
//
// Pins the dealer shell's journey rule (lib/dealer-journey.js): the order of the path, the
// keys, the Solar stage leading whenever there is a solar, every OFF_PATH group landing
// where the plan put it, the floor for "current" / unknown / blank, the once-per-cold-start
// log, and stageFilterValues agreeing with journeyFor on every value it names.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JOURNEY, OFF_PATH, CURRENT, journeyFor, journeyStep, stageFilterValues, _resetUnknownLog } from "./dealer-journey.js";

const idx = (value) => JOURNEY.findIndex((s) => s.value === value);
const keyOf = (value) => JOURNEY[idx(value)].key;

test("the path: nine customer steps then nineteen solar steps, in the plan's order", () => {
  assert.equal(JOURNEY.length, 28);
  assert.deepEqual(JOURNEY.slice(0, 9).map((s) => s.object), Array(9).fill("customer"));
  assert.deepEqual(JOURNEY.slice(9).map((s) => s.object), Array(19).fill("solar"));
  assert.equal(JOURNEY[0].value, "New");
  assert.equal(JOURNEY[8].value, "Sold - Pending Review");
  assert.equal(JOURNEY[9].value, "Audit");
  assert.equal(JOURNEY[27].value, "Billing Complete - Pending Closeout");
  assert.ok(Object.isFrozen(JOURNEY) && JOURNEY.every(Object.isFrozen));
});

test("keys are unique, URL-safe slugs of the value", () => {
  const keys = JOURNEY.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of keys) assert.match(k, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.equal(keyOf("Sold - Pending Review"), "sold-pending-review");
  assert.equal(keyOf("PM Review"), "pm-review");
  assert.equal(journeyStep("sent-ho-design").value, "Sent HO Design");
  assert.equal(journeyStep("nope"), null);
});

test("every OFF_PATH anchor is a step or CURRENT, and no value is both on and off the path", () => {
  for (const [value, o] of Object.entries(OFF_PATH)) {
    assert.ok(o.anchor === CURRENT || idx(o.anchor) >= 0, `${value} → ${o.anchor}`);
    assert.ok(["info", "warn", "stop"].includes(o.tone), value);
    assert.equal(idx(value), -1, `${value} is on the path`);
  }
});

test("no solar: the customer stage places the deal", () => {
  assert.deepEqual(journeyFor("Appointment Set", null), { stage: "appointment-set", source: "customer", index: 2, offPath: null });
  assert.deepEqual(journeyFor("Sold - Pending Review", null, { hasSolar: false }).index, 8);
});

test("with a solar, the SOLAR stage leads and the customer stage is never consulted", () => {
  const j = journeyFor("Contact Attempt Made", "Permitting", { hasSolar: true });
  assert.deepEqual(j, { stage: "permitting", source: "solar", index: idx("Permitting"), offPath: null });
  // The Sold group is ignored when a solar exists: the solar's step, no flag.
  for (const sold of ["Sold - Final Review", "Sold", "Sold - Installed", "Sold - Archived"]) {
    assert.deepEqual(journeyFor(sold, "Scheduling", { hasSolar: true }), { stage: "scheduling", source: "solar", index: idx("Scheduling"), offPath: null });
  }
  // Without the opt, a non-blank solar stage still means "there is a solar".
  assert.equal(journeyFor("New", "Audit").source, "solar");
});

test("a solar with a BLANK stage still leads: the deal is at the install floor, on no step", () => {
  assert.deepEqual(journeyFor("Sold", null, { hasSolar: true }), { stage: null, source: "solar", index: idx("Audit"), offPath: null });
  assert.deepEqual(journeyFor("Sold", "   ", { hasSolar: true }).source, "solar");
});

test("no solar and no stage: the customer floor, on no step", () => {
  assert.deepEqual(journeyFor(null, null), { stage: null, source: "customer", index: 0, offPath: null });
  assert.deepEqual(journeyFor("", undefined, { hasSolar: false }), { stage: null, source: "customer", index: 0, offPath: null });
});

test("each OFF_PATH group lands where the plan put it", () => {
  const cases = [
    // [customer, solar, hasSolar, anchorValue|null, tone]
    ...["Follow Up", "Reschedule Needed", "Rescheduled Appointment", "10 Day Revive", "Reset"].map((v) => [v, null, false, "Appointment Set", "info"]),
    ...["Sold - Final Review", "Sold", "Sold - Installed", "Sold - Archived"].map((v) => [v, null, false, "Sold - Pending Review", "info"]),
    [null, "Site survey scheduled", true, "Audit", "info"],
    [null, "Utility Input", true, "Design Ordered", "info"],
    [null, "Re-Roof Needed", true, "Design Received", "warn"],
    [null, "HOA Pending", true, "Sent HO Design", "warn"],
    [null, "Post Install/Pending MPU", true, "Post Installation", "warn"],
    [null, "Post Install/Pending BUS/MSA", true, "Post Installation", "warn"],
    ...["Go Back Items Needed", "Go Back Items Complete", "Awaiting Bird Blocking"].map((v) => [null, v, true, "Inspection Completed", "warn"]),
    [null, "Request to Archive", true, "Billing Complete - Pending Closeout", "info"],
    [null, "Archive", true, "Billing Complete - Pending Closeout", "info"],
  ];
  for (const [c, s, hasSolar, anchor, tone] of cases) {
    const j = journeyFor(c, s, { hasSolar });
    const value = hasSolar ? s : c;
    assert.deepEqual(j, { stage: keyOf(anchor), source: hasSolar ? "solar" : "customer", index: idx(anchor), offPath: { value, anchor: keyOf(anchor), tone } }, value);
  }
});

test("'current' anchors (Hold, the stop group) are drawn at the deal's floor, on no step", () => {
  assert.deepEqual(journeyFor("Hold", null), { stage: null, source: "customer", index: 0, offPath: { value: "Hold", anchor: null, tone: "warn" } });
  assert.deepEqual(journeyFor(null, "Hold", { hasSolar: true }), { stage: null, source: "solar", index: idx("Audit"), offPath: { value: "Hold", anchor: null, tone: "warn" } });
  for (const v of ["Not Interested", "DNQ", "Wants for Free", "Closed Lost", "Cancelled", "Cancelled - Awaiting Sales to Resell"]) {
    assert.deepEqual(journeyFor(v, null).offPath, { value: v, anchor: null, tone: "stop" });
    assert.deepEqual(journeyFor("New", v, { hasSolar: true }).offPath, { value: v, anchor: null, tone: "stop" });
  }
});

test("an unknown value is an info flag at the floor, logged ONCE per cold start", () => {
  _resetUnknownLog();
  const warn = console.warn;
  const lines = [];
  console.warn = (m) => lines.push(m);
  try {
    const a = journeyFor("Brand New Value", null);
    const b = journeyFor("Brand New Value", null);
    journeyFor(null, "Another One", { hasSolar: true });
    assert.deepEqual(a, { stage: null, source: "customer", index: 0, offPath: { value: "Brand New Value", anchor: null, tone: "info" } });
    assert.deepEqual(b, a);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /unknown customer stage "Brand New Value"/);
    assert.match(lines[1], /unknown solar stage "Another One"/);
  } finally {
    console.warn = warn;
  }
});

test("a step's value placed by the OTHER object still lands on its step (a solar left at a sales stage)", () => {
  assert.equal(journeyFor(null, "Sold - Pending Review", { hasSolar: true }).stage, "sold-pending-review");
});

test("stageFilterValues agrees with journeyFor: every value it names puts the deal on that step", () => {
  for (const s of JOURNEY) {
    const values = stageFilterValues(s.key);
    assert.equal(values[0], s.value);
    for (const v of values) {
      // Either side may lead; the value maps to the same step on both.
      assert.equal(journeyFor(v, null, { hasSolar: false }).stage, s.key, `${v} (customer)`);
      assert.equal(journeyFor(null, v, { hasSolar: true }).stage, s.key, `${v} (solar)`);
    }
  }
  assert.deepEqual(stageFilterValues("appointment-set"), ["Appointment Set", "Follow Up", "Reschedule Needed", "Rescheduled Appointment", "10 Day Revive", "Reset"]);
  assert.deepEqual(stageFilterValues("billing-complete-pending-closeout"), ["Billing Complete - Pending Closeout", "Request to Archive", "Archive"]);
  assert.equal(stageFilterValues("hold"), null);
  // No "current" value is in any step's filter.
  const all = JOURNEY.flatMap((s) => stageFilterValues(s.key));
  for (const [v, o] of Object.entries(OFF_PATH)) if (o.anchor === CURRENT) assert.ok(!all.includes(v), v);
});
