// The ?q= search's term and OR-group (2026-09-29): phone, email and address reach the
// search, an email keeps its @, a phone matches on its digits however it was stored.

import { test } from "node:test";
import assert from "node:assert/strict";
import { phonePattern, searchOrExpr } from "./index.js";

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

test("searchOrExpr: every column ILIKE the term; phone columns also ILIKE the digit pattern", () => {
  const cols = ["name", "primary_email", "primary_phone"];
  assert.equal(searchOrExpr(cols, "ann@example.com", ["primary_phone"]), 'name.ilike."%ann@example.com%",primary_email.ilike."%ann@example.com%",primary_phone.ilike."%ann@example.com%"');
  assert.equal(
    searchOrExpr(cols, "(602) 555-0100", ["primary_phone"]),
    'name.ilike."%(602) 555-0100%",primary_email.ilike."%(602) 555-0100%",primary_phone.ilike."%(602) 555-0100%",primary_phone.ilike."%602%555%0100%"'
  );
  // a phone column the cache does not have is skipped
  assert.equal(searchOrExpr(["name"], "6025550100", ["primary_phone"]), 'name.ilike."%6025550100%"');
});
