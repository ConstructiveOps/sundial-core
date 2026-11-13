// lib/report-live-picklists.test.js — the catalog's picklist values read live (D-089 am. 2).
// A fake describe stands in for Salesforce.

import test from "node:test";
import assert from "node:assert/strict";
import { overlayPicklists, liveCatalog } from "./report-live-picklists.js";
import { catalogBlock, typeSystem } from "./report-assist-prompt.js";
import { CATALOG } from "./report-catalog/index.js";

const OBJ = {
  objectKey: "thing",
  sfObject: "Thing__c",
  table: "sundial_thing_cache",
  fields: [
    { column: "status", sfField: "Status__c", type: "picklist", picklistValues: ["Open", "Closed"] },
    { column: "tags", sfField: "Tags__c", type: "multipicklist", picklistValues: ["A", "B"] },
    { column: "name", sfField: "Name", type: "text" },
  ],
};
const CAT = Object.freeze({ thing: OBJ });
const pv = (value, active = true) => ({ value, label: value, active });
const meta = (fields) => ({ fields });
const silent = { warn: () => {} };

test("overlay: a value added in Salesforce appears; an inactive one is dropped; order is Salesforce's", () => {
  const out = overlayPicklists(OBJ, meta([
    { name: "Status__c", type: "picklist", picklistValues: [pv("New"), pv("Open"), pv("Closed", false)] },
  ]));
  assert.deepEqual(out.fields[0].picklistValues, ["New", "Open"]);
  assert.deepEqual(out.fields[1].picklistValues, ["A", "B"], "a field the describe lacks keeps its generated values");
  assert.equal(out.fields[2], OBJ.fields[2], "a non-picklist field is untouched");
  assert.deepEqual(OBJ.fields[0].picklistValues, ["Open", "Closed"], "the generated catalog is never mutated");
  // Everything but the values is the generated entry's.
  assert.deepEqual({ ...out.fields[0], picklistValues: null }, { ...OBJ.fields[0], picklistValues: null });
});

test("overlay: the field name matches case-insensitively; a field no longer a picklist keeps the snapshot", () => {
  const out = overlayPicklists(OBJ, meta([
    { name: "status__C", type: "picklist", picklistValues: [pv("Open"), pv("Closed"), pv("Parked")] },
    { name: "Tags__c", type: "string" },
  ]));
  assert.deepEqual(out.fields[0].picklistValues, ["Open", "Closed", "Parked"]);
  assert.deepEqual(out.fields[1].picklistValues, ["A", "B"]);
});

test("overlay: nothing changed → the same object (an unchanged catalog stays shared)", () => {
  const same = overlayPicklists(OBJ, meta([{ name: "Status__c", type: "picklist", picklistValues: [pv("Open"), pv("Closed")] }]));
  assert.equal(same, OBJ);
  assert.equal(overlayPicklists(OBJ, null), OBJ);
});

test("liveCatalog: the describe's values for the asked objects, through the describe reader", async () => {
  const asked = [];
  const describe = async (sfObject) => {
    asked.push(sfObject);
    return meta([{ name: "Status__c", type: "picklist", picklistValues: [pv("Open"), pv("Waiting"), pv("Closed", false)] }]);
  };
  const out = await liveCatalog(["thing", "thing"], { catalog: CAT, describe, log: silent });
  assert.deepEqual(asked, ["Thing__c"], "one describe per object");
  assert.deepEqual(out.thing.fields[0].picklistValues, ["Open", "Waiting"]);
  assert.deepEqual(CAT.thing.fields[0].picklistValues, ["Open", "Closed"]);
});

test("liveCatalog: the describe fails → the generated values, and no throw", async () => {
  const warned = [];
  const out = await liveCatalog(["thing"], {
    catalog: CAT,
    describe: async () => { throw new Error("describe Thing__c failed (503)"); },
    log: { warn: (m) => warned.push(m) },
  });
  assert.equal(out, CAT);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /Thing__c/);
});

test("liveCatalog: a describe that hangs times out → the generated values", async () => {
  const out = await liveCatalog(["thing"], { catalog: CAT, describe: () => new Promise(() => {}), timeoutMs: 20, log: silent });
  assert.equal(out, CAT);
});

test("liveCatalog: an object with no picklist fields, or an unknown key, is never described", async () => {
  let calls = 0;
  const cat = { plain: { ...OBJ, sfObject: "Plain__c", fields: [OBJ.fields[2]] } };
  const out = await liveCatalog(["plain", "nope"], { catalog: cat, describe: async () => { calls++; return meta([]); }, log: silent });
  assert.equal(calls, 0);
  assert.equal(out, cat);
});

test("assistant: the prompt block lists the live values, so its bytes (the prompt cache's key) change with them", async () => {
  const stage = CATALOG.solar.fields.find((f) => f.column === "stage");
  const live = await liveCatalog(["solar"], {
    describe: async (sfObject) => meta(sfObject === "Sundial_Solar__c"
      ? [{ name: "Stage__c", type: "picklist", picklistValues: [...stage.picklistValues.slice(1).map((v) => pv(v)), pv("Brand New Stage"), pv(stage.picklistValues[0], false)] }]
      : []),
    log: silent,
  });
  const before = catalogBlock("solar", []);
  const after = catalogBlock("solar", [], live);
  assert.notEqual(after, before);
  const stageLine = (text) => text.split("\n").find((l) => l.startsWith("- solar.stage |"));
  assert.match(stageLine(after), /Brand New Stage/);
  assert.ok(!stageLine(after).includes(`values: ${stage.picklistValues[0]};`), "the now-inactive first value is gone");
  assert.ok(stageLine(before).includes(`values: ${stage.picklistValues[0]};`));
  assert.match(stageLine(before), /values: /);
  // The cached system block is the one carrying the values.
  const sys = typeSystem("solar", [], live);
  assert.equal(sys[1].text, after);
  assert.ok(sys[1].cache_control);
  // With no live catalog (or an unchanged one) the block is byte-identical to the generated one.
  assert.equal(catalogBlock("solar", [], CATALOG), before);
});
