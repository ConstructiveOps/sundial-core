// The ?q= search's term and OR-group (2026-09-29): phone, email and address reach the
// search, an email keeps its @, a phone matches on its digits however it was stored.

import { test } from "node:test";
import assert from "node:assert/strict";
import { phonePattern, searchOrExpr, searchWords } from "./index.js";

test("phonePattern: any formatting of a 10-digit number → %AAA%BBB%CCCC%; 7 digits → %BBB%CCCC%; not a phone → null", () => {
  for (const t of ["(602) 555-0100", "602-555-0100", "602.555.0100", "6025550100", "+1 602 555 0100", "1-602-555-0100"]) {
    assert.equal(phonePattern(t), "%602%555%0100%", t);
  }
  assert.equal(phonePattern("555-0100"), "%555%0100%");
  assert.equal(phonePattern("Ann Lee"), null);
  assert.equal(phonePattern("85201"), null, "a zip is not a phone");
  assert.equal(phonePattern("ann@example.com"), null);
  assert.equal(phonePattern("123456789012"), "%123%456%789%012%");
});

test("searchWords: split on spaces, one-character words dropped, at most six", () => {
  assert.deepEqual(searchWords("123 N Main St Phoenix"), ["123", "Main", "St", "Phoenix"]);
  assert.deepEqual(searchWords("Ann Lee"), ["Ann", "Lee"]);
  assert.deepEqual(searchWords("ann@example.com"), ["ann@example.com"]);
  assert.deepEqual(searchWords("a b c"), ["a b c"], "nothing survives the filter → the whole term");
  assert.equal(searchWords("10 11 12 13 14 15 16 17 18").length, 6);
});

test("searchOrExpr: several words → every word must match SOME column (and(or(…),or(…))); the phone pattern is an alternative beside it", () => {
  const cols = ["first_name", "street", "city"];
  assert.equal(searchOrExpr(cols, "Main Phoenix"), 'and(or(first_name.ilike."%Main%",street.ilike."%Main%",city.ilike."%Main%"),or(first_name.ilike."%Phoenix%",street.ilike."%Phoenix%",city.ilike."%Phoenix%"))');
  assert.equal(
    searchOrExpr(["name", "primary_phone"], "602 555-0100", ["primary_phone"]),
    'and(or(name.ilike."%602%",primary_phone.ilike."%602%"),or(name.ilike."%555-0100%",primary_phone.ilike."%555-0100%")),primary_phone.ilike."%602%555%0100%"'
  );
});

test("searchOrExpr: every column ILIKE the term; phone columns also ILIKE the digit pattern", () => {
  const cols = ["name", "primary_email", "primary_phone"];
  assert.equal(searchOrExpr(cols, "ann@example.com", ["primary_phone"]), 'name.ilike."%ann@example.com%",primary_email.ilike."%ann@example.com%",primary_phone.ilike."%ann@example.com%"');
  // a formatted phone splits into words, and the digit pattern rides beside the word group
  assert.equal(
    searchOrExpr(cols, "6025550100", ["primary_phone"]),
    'name.ilike."%6025550100%",primary_email.ilike."%6025550100%",primary_phone.ilike."%6025550100%",primary_phone.ilike."%602%555%0100%"'
  );
  assert.ok(searchOrExpr(cols, "(602) 555-0100", ["primary_phone"]).endsWith(',primary_phone.ilike."%602%555%0100%"'));
  // a phone column the cache does not have is skipped
  assert.equal(searchOrExpr(["name"], "6025550100", ["primary_phone"]), 'name.ilike."%6025550100%"');
});
