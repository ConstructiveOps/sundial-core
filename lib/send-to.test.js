// lib/send-to.js — who an estimate / invoice goes to: the box, else the payer, else the
// customer, else the snapshot; a via that needs a missing address is RECIPIENT_REQUIRED.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRecipients, sendDefaults, viaFrom, isEmail } from "./send-to.js";

const homeowner = { Id: "a1P000000HOMEOWNAA", First_Name__c: "Mark", Last_Name__c: "Haughn", Primary_Email__c: "mark@example.com", Primary_Phone__c: "623-555-0142" };
const company = { Id: "a1P000000SUNRUNXAA", Is_Company__c: true, Company_Name__c: "SunRun", First_Name__c: "Dana", Last_Name__c: "Ruiz", Primary_Email__c: "ap@sunrun.example.com", Primary_Phone__c: "(602) 555-0100" };

test("sendDefaults: the payer when a company pays, else the customer, else the snapshot; source + name say whose", () => {
  assert.deepEqual(sendDefaults({ payer: company, customer: homeowner }), { email: "ap@sunrun.example.com", phone: "+16025550100", source: "billTo", name: "SunRun" });
  assert.deepEqual(sendDefaults({ payer: null, customer: homeowner }), { email: "mark@example.com", phone: "+16235550142", source: "customer", name: "Mark Haughn" });
  // A payer with no email of its own falls back to the customer's, per field.
  assert.deepEqual(sendDefaults({ payer: { ...company, Primary_Email__c: null }, customer: homeowner }).email, "mark@example.com");
  // No records at all: the document's snapshot.
  assert.deepEqual(sendDefaults({ snapshot: { email: "snap@example.com", phone: "6025550111", name: "Snap" } }), { email: "snap@example.com", phone: "+16025550111", source: "customer", name: "Snap" });
  assert.deepEqual(sendDefaults({}), { email: null, phone: null, source: "customer", name: null });
});

test("resolveRecipients: the box wins, per field; only the fields the via uses are returned", () => {
  const r = resolveRecipients({ via: "Both", to: " typed@example.com ", toPhone: "602.555.0199", payer: company, customer: homeowner });
  assert.deepEqual(r, { ok: true, email: "typed@example.com", phone: "+16025550199", source: "billTo", name: "SunRun" });
  assert.deepEqual(resolveRecipients({ via: "Email", payer: company, customer: homeowner }), { ok: true, email: "ap@sunrun.example.com", phone: null, source: "billTo", name: "SunRun" });
  assert.deepEqual(resolveRecipients({ via: "SMS", customer: homeowner }), { ok: true, email: null, phone: "+16235550142", source: "customer", name: "Mark Haughn" });
});

test("resolveRecipients: nothing to send to → RECIPIENT_REQUIRED naming what is missing; a bad typed value → RECIPIENT_INVALID", () => {
  const noEmail = { ...homeowner, Primary_Email__c: null };
  assert.deepEqual(resolveRecipients({ via: "Email", customer: noEmail }), {
    ok: false, status: 400, code: "RECIPIENT_REQUIRED", missing: ["email"], message: "There is no email on file to send to — type one in the send box.",
  });
  const r = resolveRecipients({ via: "Both", customer: { Id: "x" } });
  assert.equal(r.code, "RECIPIENT_REQUIRED");
  assert.deepEqual(r.missing, ["email", "phone"]);
  // An SMS send needs no email, so a customer without one is fine.
  assert.equal(resolveRecipients({ via: "SMS", customer: noEmail }).ok, true);
  const bad = resolveRecipients({ via: "Email", to: "nope", toPhone: "555-01", customer: homeowner });
  assert.equal(bad.code, "RECIPIENT_INVALID");
  assert.deepEqual(bad.invalid, ["email", "phone"]);
});

test("viaFrom: Email by default; Manual only where allowed (the estimate's record-only send)", () => {
  assert.equal(viaFrom({}), "Email");
  assert.equal(viaFrom({ via: "SMS" }), "SMS");
  assert.equal(viaFrom({ via: "Both" }), "Both");
  assert.equal(viaFrom({ via: "Manual" }), "Email");
  assert.equal(viaFrom({ via: "Manual" }, { allowManual: true }), "Manual");
  assert.equal(viaFrom({ via: "fax" }), "Email");
  assert.equal(isEmail("a@b.co"), true);
  assert.equal(isEmail("a@b"), false);
});
