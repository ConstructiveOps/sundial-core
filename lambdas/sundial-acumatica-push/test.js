// Tests for sundial-acumatica-push.
//
// Run with:  npm test
//
// The phone normaliser is tested hardest because it is the thing that broke a real
// production Create Project: Acumatica enforces a `(999) 999-9999` input mask
// server-side and 422s the whole customer when a value does not match. Salesforce
// imposes no phone format, so anything that is not already in that exact shape fails.

import test from "node:test";
import assert from "node:assert/strict";

const { normalizeAcumaticaPhone } = await import("../../lib/acumatica.js");

// ===========================================================================
// Phone normalisation
// ===========================================================================

test("the exact value that broke production is normalised", () => {
  // Gary Rayfield, 2026-08-19. Acumatica rejected this verbatim.
  const r = normalizeAcumaticaPhone("623 703-2778");
  assert.equal(r.phone, "(623) 703-2778");
  assert.equal(r.reason, null);
  assert.equal(r.extension, null);
});

test("every common Salesforce phone shape reaches the mask", () => {
  for (const raw of [
    "623 703-2778",
    "(623) 703-2778",
    "6237032778",
    "623-703-2778",
    "623.703.2778",
    "  623 703 2778  ",
    "+1 623-703-2778",
    "1-623-703-2778",
    "+1 (623) 703-2778",
  ]) {
    assert.equal(normalizeAcumaticaPhone(raw).phone, "(623) 703-2778", `failed on ${raw}`);
  }
});

test("an already-masked value is returned unchanged, not double-formatted", () => {
  assert.equal(normalizeAcumaticaPhone("(623) 703-2778").phone, "(623) 703-2778");
});

test("a NANP country code is stripped rather than read as an 11th digit", () => {
  // Without this, "+1..." is 11 digits and would be rejected as unusable.
  assert.equal(normalizeAcumaticaPhone("+1 623 703 2778").phone, "(623) 703-2778");
  assert.equal(normalizeAcumaticaPhone("16237032778").phone, "(623) 703-2778");
});

test("extensions are separated, not merged into the digits", () => {
  // The bug this prevents: the extension's digits join the number, giving 13 digits,
  // and a perfectly good phone reads as unusable.
  for (const [raw, ext] of [
    ["623.703.2778 x123", "123"],
    ["623-703-2778 ext 45", "45"],
    ["623-703-2778 ext. 45", "45"],
    ["(623) 703-2778 extension 9", "9"],
    ["6237032778 #22", "22"],
  ]) {
    const r = normalizeAcumaticaPhone(raw);
    assert.equal(r.phone, "(623) 703-2778", `phone failed on ${raw}`);
    assert.equal(r.extension, ext, `extension failed on ${raw}`);
  }
});

test("empty input is not an error — there is simply nothing to send", () => {
  for (const raw of ["", "   ", null, undefined]) {
    const r = normalizeAcumaticaPhone(raw);
    assert.equal(r.phone, null);
    assert.equal(r.reason, null, "an absent phone must not be reported as a problem");
  }
});

test("an unusable value yields null AND a reason — never a guess", () => {
  // The caller omits Phone1 and warns. Inventing digits to satisfy the mask would put
  // a fabricated phone number on a customer record.
  const short = normalizeAcumaticaPhone("555-1234");
  assert.equal(short.phone, null);
  assert.match(short.reason, /expected 10 digits, found 7/);

  const intl = normalizeAcumaticaPhone("+44 20 7946 0958");
  assert.equal(intl.phone, null);
  assert.match(intl.reason, /expected 10 digits, found 12/);

  const junk = normalizeAcumaticaPhone("not a phone");
  assert.equal(junk.phone, null);
  assert.match(junk.reason, /no digits found/);
});

test("output always matches Acumatica's mask exactly", () => {
  // The mask is literal: 3 digits in parens, space, 3 digits, hyphen, 4 digits.
  const MASK = /^\(\d{3}\) \d{3}-\d{4}$/;
  for (const raw of ["6237032778", "623 703-2778", "+1 (623) 703-2778", "623.703.2778 x9"]) {
    const { phone } = normalizeAcumaticaPhone(raw);
    assert.match(phone, MASK, `mask violated for ${raw}`);
  }
});

test("a non-string input does not throw", () => {
  // Salesforce can hand back a number for a phone-shaped field.
  assert.equal(normalizeAcumaticaPhone(6237032778).phone, "(623) 703-2778");
  assert.doesNotThrow(() => normalizeAcumaticaPhone({}));
  assert.equal(normalizeAcumaticaPhone({}).phone, null);
});
