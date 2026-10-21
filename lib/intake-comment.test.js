// lib/intake-comment.js — the server's intake / assignment lines in a customer's feed (D-084).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  INTAKE_COMMENT_FIELDS,
  assignmentCommentBody,
  changedIntakeFields,
  commentOnCustomerWrite,
  commentTime,
  intakeCommentBody,
  insertSystemComment,
} from "./intake-comment.js";
import { INTAKE_FIELDS as ESTIMATE_INTAKE_FIELDS } from "../lambdas/sundial-service-estimate/index.js";
import { fakeSupabase } from "./notify.test-fakes.js";

const AT = new Date("2026-10-22T22:05:00Z"); // 3:05 PM Arizona

test("commentTime is Arizona's clock", () => {
  assert.equal(commentTime(AT), "Oct 22, 2026 3:05 PM");
});

test("a PATCH changing two intake fields → one comment naming both; an unchanged PATCH → none", () => {
  const before = { System_Ownership__c: "Lease", Inverter_Manufacturer__c: "SMA", Next_Step__c: "Schedule" };
  const changes = changedIntakeFields(before, { System_Ownership__c: "Own", Inverter_Manufacturer__c: "Enphase", Next_Step__c: "Schedule", First_Name__c: "Ann" });
  assert.deepEqual(changes.map((c) => c.apiName), ["System_Ownership__c", "Inverter_Manufacturer__c"]);
  assert.equal(
    intakeCommentBody({ changes, actorName: "Beth Office", at: AT }),
    "Intake updated by Beth Office on Oct 22, 2026 3:05 PM (Arizona): Do you own or lease the system? — Own; What brand is your solar inverter? — Enphase"
  );
  assert.equal(intakeCommentBody({ changes: changedIntakeFields(before, { System_Ownership__c: "Lease" }), actorName: "Beth", at: AT }), null);
  assert.equal(intakeCommentBody({ changes: changedIntakeFields(before, { First_Name__c: "Ann" }), actorName: "Beth", at: AT }), null);
});

test("a cleared answer says so; long free text is cut in the comment only", () => {
  const changes = changedIntakeFields({ Description__c: "Old" , Warranty_Notes__c: "" }, { Description__c: "", warranty_notes__c: "x".repeat(500) });
  const body = intakeCommentBody({ changes, actorName: "Beth", at: AT });
  assert.match(body, /Tell us more about your issue\. — \(cleared\)/);
  assert.match(body, /Warranty notes — x{199}…; /);
});

test("assignment lines", () => {
  assert.equal(assignmentCommentBody({ assigneeName: "Paige Ng", actorName: "Beth Office", at: AT }), "Assigned to Paige Ng by Beth Office on Oct 22, 2026 3:05 PM (Arizona)");
  assert.equal(assignmentCommentBody({ assigneeName: null, actorName: "Beth Office", at: AT }), "Unassigned by Beth Office on Oct 22, 2026 3:05 PM (Arizona)");
});

test("commentOnCustomerWrite: intake + assignment → two system rows, no mentions; nothing changed → none", async () => {
  const store = { comments: [], comment_mentions: [] };
  const sb = fakeSupabase(store);
  const args = { getSupabaseClient: async () => sb, loadUserName: async (id) => (id === "USR1" ? "Paige Ng" : null), tenantId: "T1", customerId: "C1", actor: { name: "Beth Office", profileId: "uuid-beth" }, at: AT };
  const n = await commentOnCustomerWrite({ ...args, before: { Assigned_To__c: null }, written: { Type_of_Service__c: "Repair", Assigned_To__c: "USR1" } });
  assert.equal(n, 2);
  assert.equal(store.comments.length, 2);
  for (const c of store.comments) {
    assert.equal(c.kind, "system");
    assert.equal(c.record_object, "customer");
    assert.equal(c.record_id, "C1");
    assert.equal(c.tenant_id, "T1");
    assert.equal(c.author_id, "uuid-beth");
  }
  assert.match(store.comments[1].body, /^Assigned to Paige Ng by Beth Office/);
  assert.equal(store.comment_mentions.length, 0);
  assert.equal(await commentOnCustomerWrite({ ...args, before: { Type_of_Service__c: "Repair", Assigned_To__c: "USR1" }, written: { Type_of_Service__c: "Repair", Assigned_To__c: "USR1" } }), 0);
});

test("insertSystemComment: retries without `kind` until the SQL adds it; a failure never throws", async () => {
  const rows = [];
  let first = true;
  const sb = { from: () => ({ insert: async (row) => { if (first && "kind" in row) { first = false; return { error: { message: 'column "kind" of relation "comments" does not exist' } }; } rows.push(row); return { error: null }; } }) };
  assert.equal(await insertSystemComment(async () => sb, { tenantId: "T", customerId: "C", body: "x" }), true);
  assert.equal("kind" in rows[0], false);
  assert.equal(await insertSystemComment(async () => { throw new Error("down"); }, { tenantId: "T", customerId: "C", body: "x" }), false);
});

test("the labels mirror the portal's INTAKE_FIELDS, and cover exactly the estimate Lambda's intake fields", () => {
  assert.deepEqual(INTAKE_COMMENT_FIELDS.map((f) => f.apiName).sort(), Object.values(ESTIMATE_INTAKE_FIELDS).sort());
  const here = dirname(fileURLToPath(import.meta.url));
  const portal = join(here, "..", "..", "harmon-crm", "src", "config", "service-customer-config.ts");
  if (!existsSync(portal)) return; // CI without the portal checkout: the field-set pin above still runs
  const src = readFileSync(portal, "utf8");
  const block = src.slice(src.indexOf("export const INTAKE_FIELDS"), src.indexOf("] as const", src.indexOf("export const INTAKE_FIELDS")));
  const portalFields = [...block.matchAll(/apiName: '([^']+)', label: (['"])(.*?)\2/g)].map((m) => ({ apiName: m[1], label: m[3] }));
  assert.deepEqual(portalFields, INTAKE_COMMENT_FIELDS.map((f) => ({ apiName: f.apiName, label: f.label })));
});
