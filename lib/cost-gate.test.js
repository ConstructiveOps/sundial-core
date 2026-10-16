// lib/cost-gate.js — cost is Admin / Executive; a blank cost key from anyone else is "not
// sent", a value is a 403 (2026-10-16, Harmon).

import { test } from "node:test";
import assert from "node:assert/strict";
import { costWriteGate, stripCost, isCostKey, isBlankCost, COST_FIELDS, COSTING_FORBIDDEN } from "./cost-gate.js";

test("isCostKey: every spelling of the four cost fields, and nothing else (sell prices are not cost)", () => {
  for (const k of ["Labor_Cost__c", "material_cost", "laborCost", "MATERIALCOST"]) assert.equal(isCostKey("pricebookitem", k), true, k);
  for (const k of ["Unit_Labor_Cost__c", "unit_material_cost", "unitLaborCost"]) assert.equal(isCostKey("serviceline", k), true, k);
  for (const k of ["Price__c", "Labor_Price__c", "Material_Price__c", "laborPrice", "materialPrice", "Name"]) assert.equal(isCostKey("pricebookitem", k), false, k);
  for (const k of ["Unit_Price__c", "Unit_Labor_Price__c", "Line_Total__c"]) assert.equal(isCostKey("serviceline", k), false, k);
  assert.equal(isCostKey("customer", "Labor_Cost__c"), false, "only the two Service objects");
  assert.equal(isCostKey("pricebookitem", null), false);
  assert.deepEqual(Object.keys(COST_FIELDS).sort(), ["pricebookitem", "serviceline"]);
});

test("stripCost removes the keys (not nulls them) and leaves the input alone", () => {
  const row = { sf_id: "a", name: "Disconnect", price: 120, labor_price: 0, material_price: 120, labor_cost: 10, material_cost: 60 };
  const out = stripCost("pricebookitem", row);
  assert.deepEqual(out, { sf_id: "a", name: "Disconnect", price: 120, labor_price: 0, material_price: 120 });
  assert.ok(!("labor_cost" in out));
  assert.equal(row.labor_cost, 10, "input untouched");
  const line = stripCost("serviceline", { Id: "l", Unit_Price__c: 5, Unit_Labor_Cost__c: 1, Unit_Material_Cost__c: 2 });
  assert.deepEqual(line, { Id: "l", Unit_Price__c: 5 });
  assert.equal(stripCost("customer", row), row, "another object is unchanged");
  assert.equal(stripCost("pricebookitem", null), null);
});

test("write rule: a costing user writes anything; anyone else — blank = dropped, a value = 403 naming it", () => {
  const body = { name: "X", laborPrice: 100, laborCost: 40 };
  assert.deepEqual(costWriteGate("pricebookitem", body, true), { ok: true, fields: body, dropped: [] });

  for (const blank of [null, undefined, "", "   "]) {
    assert.equal(isBlankCost(blank), true);
    const r = costWriteGate("pricebookitem", { name: "X", laborPrice: 100, laborCost: blank, materialCost: blank }, false);
    assert.equal(r.ok, true);
    assert.deepEqual(r.fields, { name: "X", laborPrice: 100 }, "blank cost keys are not sent");
    assert.deepEqual(r.dropped, ["laborCost", "materialCost"]);
  }
  for (const value of [12, 0, "12", "0"]) {
    assert.equal(isBlankCost(value), false, `${JSON.stringify(value)} is a value`);
    const r = costWriteGate("pricebookitem", { name: "X", laborCost: value, materialCost: "" }, false);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.code, COSTING_FORBIDDEN);
    assert.deepEqual(r.fields, ["laborCost"]);
  }
  // The generic route's API names, on a line.
  assert.equal(costWriteGate("serviceline", { Unit_Labor_Cost__c: 5 }, false).ok, false);
  assert.deepEqual(costWriteGate("serviceline", { Quantity__c: 2, Unit_Labor_Cost__c: null }, false).fields, { Quantity__c: 2 });
  // Another object is never touched by the rule.
  assert.deepEqual(costWriteGate("customer", { Labor_Cost__c: 5 }, false).fields, { Labor_Cost__c: 5 });
});

test("markup (2026-10-16): stripMarkup removes every spelling at any depth; markupWriteGate drops blank and refuses a value", async () => {
  const { stripMarkup, markupWriteGate, isMarkupKey } = await import("./cost-gate.js");
  const resp = { estimate: { Id: "e", Markup_Type__c: "Percent", Markup_Value__c: 10, Markup_Amount__c: 20, Total__c: 220 }, totals: { total: 220, markupAmount: 20, fields: { Total__c: 220, Markup_Amount__c: 20 } }, rows: [{ markup_value: 1, name: "x" }] };
  assert.deepEqual(stripMarkup(resp), { estimate: { Id: "e", Total__c: 220 }, totals: { total: 220, fields: { Total__c: 220 } }, rows: [{ name: "x" }] });
  assert.equal(resp.estimate.Markup_Value__c, 10, "input untouched");
  assert.equal(stripMarkup(null), null);
  assert.equal(isMarkupKey("Discount_Value__c"), false);
  assert.deepEqual(markupWriteGate({ markupType: "", markupValue: null, scopeSummary: "s" }, false), { ok: true, fields: { scopeSummary: "s" }, dropped: ["markupType", "markupValue"] });
  const r = markupWriteGate({ markupValue: 10 }, false);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.code, "COSTING_FORBIDDEN");
  assert.deepEqual(r.fields, ["markupValue"]);
  assert.deepEqual(markupWriteGate({ markupValue: 10 }, true).fields, { markupValue: 10 });
});
