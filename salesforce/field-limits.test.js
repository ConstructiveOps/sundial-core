// Tests for the Salesforce field-metadata limit guard.
//
// This is a BUILD GATE: every package generator calls assertFieldLimits() before writing.
// It exists because the v5 attribute-sync package failed its first Workbench deploy with
// "Value too long for field: Description maximum length is:1000" on a 1,137-character
// description — a failure that cost a zip, an upload and a Check Only to discover.
//
// A guard that silently stops guarding is worse than no guard, so it is tested.
import test from "node:test";
import assert from "node:assert/strict";
import { assertFieldLimits, reportFieldLimitHeadroom, FIELD_LIMITS } from "./field-limits.mjs";

const ok = (n) => "x".repeat(n);

test("the limits are the real Salesforce ones", () => {
  assert.equal(FIELD_LIMITS.description, 1000);
  assert.equal(FIELD_LIMITS.inlineHelpText, 255);
});

test("a field at exactly the limit passes; one character over throws", () => {
  // Off-by-one matters here: the deploy error is inclusive, and a guard that rejected
  // exactly-1000 would send someone editing prose that was already fine.
  assert.doesNotThrow(() => assertFieldLimits([{ api: "A__c", description: ok(1000), help: ok(255) }]));
  assert.throws(() => assertFieldLimits([{ api: "A__c", description: ok(1001) }]), /description is 1001/);
  assert.throws(() => assertFieldLimits([{ api: "A__c", help: ok(256) }]), /inlineHelpText is 256/);
});

test("the error names the FIELD, the actual length and the overage", () => {
  // The whole point is that the message is actionable without re-running anything.
  try {
    assertFieldLimits([{ api: "Attribute_Sync_Status__c", description: ok(1137) }], "v5-attribute-sync-fields");
    assert.fail("should have thrown");
  } catch (err) {
    assert.match(err.message, /v5-attribute-sync-fields/);
    assert.match(err.message, /Attribute_Sync_Status__c/);
    assert.match(err.message, /1137/);
    assert.match(err.message, /over by 137/);
    // And it says what Workbench would have said, so the connection is obvious.
    assert.match(err.message, /Value too long for field/);
  }
});

test("EVERY offender is reported, not just the first", () => {
  // A guard that fails one field at a time turns a five-minute fix into five deploys.
  try {
    assertFieldLimits([
      { api: "A__c", description: ok(1200) },
      { api: "B__c", description: ok(50) },
      { api: "C__c", description: ok(1100), help: ok(900) },
    ]);
    assert.fail("should have thrown");
  } catch (err) {
    assert.match(err.message, /3 field\(s\)/, "2 descriptions + 1 help = 3 problems");
    assert.match(err.message, /A__c/);
    assert.match(err.message, /C__c/);
    assert.ok(!/B__c/.test(err.message), "a field within limits must not be reported");
  }
});

test("missing description or help is not a violation", () => {
  // Not every field carries both, and absent is zero-length, not invalid.
  assert.doesNotThrow(() => assertFieldLimits([{ api: "A__c" }, { api: "B__c", description: null }]));
  assert.doesNotThrow(() => assertFieldLimits([]));
  assert.doesNotThrow(() => assertFieldLimits(undefined));
});

test("the headroom report flags a near miss without failing it", () => {
  // v4's Commission_PO_M1_Number__c deployed fine at 975/1000 — one clarifying sentence
  // from the failure v5 actually hit. Visible is the point.
  const lines = [];
  reportFieldLimitHeadroom(
    [{ api: "Near__c", description: ok(975), help: ok(10) }, { api: "Fine__c", description: ok(100), help: ok(10) }],
    (l) => lines.push(l)
  );
  const joined = lines.join("\n");
  assert.match(joined, /Near__c\s+975.*\(tight\)/);
  assert.ok(!/Fine__c.*\(tight\)/.test(joined));
});
