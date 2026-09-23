// ?op=includes (2026-09-23, D-075): the PostgREST expression for "multi-select column
// INCLUDES value" on a cache column holding Salesforce's "A;B;C" string. No module mocks —
// runs anywhere (`node --test lambdas/sundial-sf-query/includes.test.js`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { includesOrExpr } from "./index.js";

test("matches the value alone, first, last and in the middle — never as a substring of another value", () => {
  const expr = includesOrExpr("customer_type", "Service");
  assert.equal(expr, 'customer_type.eq."Service",customer_type.like."Service;*",customer_type.like."*;Service",customer_type.like."*;Service;*"');
  // A local evaluator with PostgREST's `*` wildcard: what the four patterns admit.
  const admits = (cell) => {
    if (cell === "Service") return true;
    return [/^Service;/, /;Service$/, /;Service;/].some((re) => re.test(cell));
  };
  assert.equal(admits("Service"), true);
  assert.equal(admits("Solar;Service"), true);
  assert.equal(admits("Service;Roofing"), true);
  assert.equal(admits("Solar;Service;Roofing"), true);
  assert.equal(admits("Solar"), false);
  assert.equal(admits("Full Service Plan"), false, "a value that merely contains the word");
});

test("values with commas, parentheses and an apostrophe stay literal (quoted)", () => {
  const expr = includesOrExpr("service_request_type", "Add-On (Battery, EV Charger, Panels)");
  assert.ok(expr.startsWith('service_request_type.eq."Add-On (Battery, EV Charger, Panels)",'));
  assert.ok(expr.includes('like."*;Add-On (Battery, EV Charger, Panels);*"'));
  assert.ok(includesOrExpr("x", "O'Neil").includes(`x.eq."O'Neil"`));
});
