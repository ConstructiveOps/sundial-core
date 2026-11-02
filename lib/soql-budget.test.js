// Tests for lib/soql-budget.js — the Id IN (…) chunk is sized from the URI budget, so a
// wide cache SELECT (solar after R0) never builds a query Salesforce refuses.
//
// Run with:  node --test lib/soql-budget.test.js

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SOQL_URI, SOQL_URI_SAFETY_MARGIN, soqlUriLength, idChunkSize, buildIdChunkQueries,
} from "./soql-budget.js";

// The same shape sundial-sf-query refetchQueries builds.
const builder = (selectList) => (inList) =>
  `SELECT ${selectList} FROM Sundial_Solar__c WHERE Client__c = 'a1W7y000007AszBEAS' AND Id IN (${inList})`;

// A select list of plausible field names, grown until it is `bytes` long once encoded.
function selectListOf(bytes) {
  const names = [];
  let i = 0;
  while (encodeURIComponent(names.join(", ")).length < bytes) names.push(`Report_Field_${i++}__c`);
  return names.join(", ");
}

const ids = (n) => Array.from({ length: n }, (_, i) => `'a1Q7y00000${String(i).padStart(8, "0")}'`);

test("a 14,000-byte select list gives a chunk well under 200, and every query fits", () => {
  const build = builder(selectListOf(14000));
  const quoted = ids(500);
  const size = idChunkSize(build, quoted);
  assert.ok(size < 100, `chunk ${size} should be well under 200`);
  assert.ok(size >= 1);

  const queries = buildIdChunkQueries(build, quoted);
  assert.equal(queries.length, Math.ceil(500 / size));
  for (const q of queries) assert.ok(soqlUriLength(q) <= MAX_SOQL_URI, `URI ${soqlUriLength(q)} over the limit`);
  // Nothing lost or duplicated.
  const back = queries.flatMap((q) => q.match(/IN \((.*)\)$/)[1].split(", "));
  assert.deepEqual(back, quoted);
});

test("the full chunk uses the budget: one more Id would pass the limit less the margin", () => {
  const build = builder(selectListOf(14000));
  const quoted = ids(500);
  const size = idChunkSize(build, quoted);
  const full = build(quoted.slice(0, size).join(", "));
  const over = build(quoted.slice(0, size + 1).join(", "));
  assert.ok(soqlUriLength(full) <= MAX_SOQL_URI - SOQL_URI_SAFETY_MARGIN);
  assert.ok(soqlUriLength(over) > MAX_SOQL_URI - SOQL_URI_SAFETY_MARGIN);
});

test("a short select list still gives 200", () => {
  const build = builder("Id, Name, Stage__c, SystemModstamp");
  assert.equal(idChunkSize(build, ids(1000)), 200);
  const queries = buildIdChunkQueries(build, ids(450));
  assert.deepEqual(queries.map((q) => q.split("', '").length), [200, 200, 50]);
});

test("a select list with no room left still makes progress, one Id per query", () => {
  const build = builder(selectListOf(MAX_SOQL_URI));
  assert.equal(idChunkSize(build, ids(3)), 1);
  assert.equal(buildIdChunkQueries(build, ids(3)).length, 3);
});

test("no Ids, no queries", () => {
  assert.deepEqual(buildIdChunkQueries(builder("Id"), []), []);
});
