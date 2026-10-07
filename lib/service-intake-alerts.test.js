// lib/service-intake-alerts.js — who hears about an unowned Service customer and an assignment (2026-10-02).

import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVICE_INTAKE_CATEGORY, alertAssigned, alertUnassignedCustomer, customerLabel, isServiceCustomer, serviceManagerIds } from "./service-intake-alerts.js";
import { CATEGORIES, OFFICE_CATEGORIES, TECH_CATEGORIES, prefAllows } from "./notify.js";

const T = "a1WTENANT000000001";
const NOW = new Date("2026-10-02T17:30:00Z");
const fakeNotifier = () => {
  const sent = [];
  return { sent, toUsers: async (n) => (sent.push(n), { inserted: n.userSfIds.length, skipped: 0, pushed: 0 }) };
};
const users = [
  { Id: "U-admin", Access_Level__c: "Admin", Default_Department__c: "Service", Active__c: true },
  { Id: "U-mgr", Access_Level__c: "Manager", Default_Department__c: "Service", Active__c: true },
  { Id: "U-exec", Access_Level__c: "Executive", Default_Department__c: "Service", Active__c: true },
  { Id: "U-sales-mgr", Access_Level__c: "Manager", Default_Department__c: "Residential Solar", Active__c: true },
  { Id: "U-gone", Access_Level__c: "Admin", Default_Department__c: "Service", Active__c: false },
  { Id: "U-tech", Access_Level__c: "Technician", Default_Department__c: "Service", Active__c: true },
];
/** A SOQL fake just good enough for the one query this module makes. */
const sfQuery = async (soql) => {
  assert.match(soql, /FROM Sundial_User__c WHERE Client__c = '/);
  assert.match(soql, /Active__c = true/);
  assert.match(soql, /Access_Level__c IN \('Admin', 'Manager', 'Executive'\)/);
  assert.match(soql, /Default_Department__c = 'Service'/);
  return users.filter((u) => u.Active__c && ["Admin", "Manager", "Executive"].includes(u.Access_Level__c) && u.Default_Department__c === "Service").map((u) => ({ Id: u.Id }));
};

test("the category is always on: not in either Settings list, and a missing pref means ON", () => {
  assert.equal(SERVICE_INTAKE_CATEGORY, "service_intake");
  assert.equal(CATEGORIES.SERVICE_INTAKE, "service_intake");
  assert.ok(!TECH_CATEGORIES.includes("service_intake"));
  assert.ok(!OFFICE_CATEGORIES.includes("service_intake"));
  assert.equal(prefAllows({ money: false }, "service_intake"), true);
});

test("serviceManagerIds: active Admin / Manager / Executive in the Service department, nobody else", async () => {
  assert.deepEqual(await serviceManagerIds(sfQuery, T), ["U-admin", "U-mgr", "U-exec"]);
  assert.deepEqual(await serviceManagerIds(sfQuery, null), []);
});

test("isServiceCustomer + customerLabel", () => {
  assert.equal(isServiceCustomer({ Customer_Type__c: "Solar;Service" }), true);
  assert.equal(isServiceCustomer({ Customer_Type__c: "Solar" }), false);
  assert.equal(isServiceCustomer({}), false);
  assert.equal(customerLabel({ Name: "Ivy Intake" }), "Ivy Intake");
  assert.equal(customerLabel({ First_Name__c: "Ivy", Last_Name__c: "Intake" }), "Ivy Intake");
  assert.equal(customerLabel({}), "A customer");
});

test("alert 1: an unowned customer → the managers minus the actor; nothing when assigned, when no managers, or when the notifier throws", async () => {
  const n = fakeNotifier();
  const r = await alertUnassignedCustomer({ notifier: n, sfQuery, tenantId: T, customer: { Id: "C1", Name: "Ivy Intake" }, reason: "created", actorUserSfId: "U-admin", now: NOW });
  assert.equal(r.inserted, 2);
  assert.equal(n.sent.length, 1);
  const sent = n.sent[0];
  assert.deepEqual(sent.userSfIds, ["U-mgr", "U-exec"], "the admin who created it is left out");
  assert.equal(sent.category, "service_intake");
  assert.equal(sent.kind, "customer_unassigned");
  assert.equal(sent.title, "New Service customer — nobody assigned");
  assert.equal(sent.body, "Ivy Intake was added with no one in Assigned To.");
  assert.equal(sent.url, "/service/customers/C1", "the Service view, whatever the reader's department (2026-10-07)");
  assert.equal(sent.recordType, "customer");
  assert.equal(sent.recordSfId, "C1");
  assert.equal(sent.dedupeKey, "service_intake:unassigned:C1:created:2026-10-02T17:30", "one alert per customer per reason per minute");
  const back = await alertUnassignedCustomer({ notifier: n, sfQuery, tenantId: T, customer: { Id: "C1", Name: "Ivy Intake" }, reason: "unarchived", now: NOW });
  assert.equal(back.inserted, 3, "nobody did it from the office → all three");
  assert.equal(n.sent[1].title, "Ivy Intake is back in Service — nobody assigned");
  assert.match(n.sent[1].body, /was un-archived and has no one in Assigned To/);
  // assigned already → nothing
  assert.equal((await alertUnassignedCustomer({ notifier: n, sfQuery, tenantId: T, customer: { Id: "C2", Assigned_To__c: "U-tech" }, now: NOW })).reason, "assigned");
  // no managers in the tenant → nothing
  assert.equal((await alertUnassignedCustomer({ notifier: n, sfQuery: async () => [], tenantId: T, customer: { Id: "C3" }, now: NOW })).reason, "no_managers");
  // the notifier blowing up never reaches the caller
  const boom = { toUsers: async () => { throw new Error("supabase down"); } };
  assert.equal((await alertUnassignedCustomer({ notifier: boom, sfQuery, tenantId: T, customer: { Id: "C4" }, now: NOW })).reason, "threw");
  assert.equal((await alertUnassignedCustomer({ notifier: n, sfQuery: async () => { throw new Error("soql"); }, tenantId: T, customer: { Id: "C5" }, now: NOW })).reason, "threw");
  assert.equal(n.sent.length, 2);
});

test("alert 2: the assignee hears it with the actor's name; assigning yourself is silent; no assignee → nothing", async () => {
  const n = fakeNotifier();
  const r = await alertAssigned({ notifier: n, tenantId: T, customer: { Id: "C1", Name: "Ivy Intake" }, assignedToSfId: "U-tech", actorUserSfId: "U-admin", actorName: "Paige King", now: NOW });
  assert.equal(r.inserted, 1);
  const sent = n.sent[0];
  assert.deepEqual(sent.userSfIds, ["U-tech"]);
  assert.equal(sent.kind, "customer_assigned");
  assert.equal(sent.title, "Ivy Intake was assigned to you");
  assert.equal(sent.body, "Paige King put you in Assigned To on this Service customer.");
  assert.equal(sent.url, "/service/customers/C1", "the Service view, whatever the reader's department (2026-10-07)");
  assert.equal(sent.dedupeKey, "service_intake:assigned:C1:U-tech:2026-10-02T17:30");
  assert.equal((await alertAssigned({ notifier: n, tenantId: T, customer: { Id: "C1" }, assignedToSfId: "U-admin", actorUserSfId: "U-admin", now: NOW })).reason, "self");
  assert.equal((await alertAssigned({ notifier: n, tenantId: T, customer: { Id: "C1" }, assignedToSfId: "", now: NOW })).reason, "no_assignee");
  const noName = await alertAssigned({ notifier: n, tenantId: T, customer: { Id: "C9", First_Name__c: "Bo", Last_Name__c: "Ng" }, assignedToSfId: "U-mgr", now: NOW });
  assert.equal(noName.inserted, 1);
  assert.equal(n.sent[1].body, "You are now in Assigned To on this Service customer.");
  assert.equal(n.sent[1].title, "Bo Ng was assigned to you");
});
