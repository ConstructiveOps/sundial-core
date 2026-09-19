// job-notes.js — one block per call on the job's two notes fields: append, replace, remove, cap.
import test from "node:test";
import assert from "node:assert/strict";
import { blockHeader, jobNotesFieldsFor, mergeCallBlock, splitBlocks, JOB_NOTES_MAX } from "./job-notes.js";

const TZ = "America/Phoenix";

test("header: call number · date · tech", () => {
  assert.equal(blockHeader({ callNumber: "SC-00012", techName: "Larry Ng", at: "2026-09-18T23:30:00Z", timeZone: TZ }), "— SC-00012 · Sep 18, 2026 · Larry Ng");
  assert.equal(blockHeader({ callNumber: "SC-00012" }), "— SC-00012");
});

test("blocks: the office's own text stays first; calls are found by number", () => {
  const s = "Office typed this.\n\n— SC-00001 · Sep 1, 2026 · Jake\nfirst\nvisit\n\n— SC-00002 · Sep 2, 2026 · Larry\nsecond";
  assert.deepEqual(splitBlocks(s).map((b) => [b.callNumber, b.text.split("\n")[0]]), [[null, "Office typed this."], ["SC-00001", "— SC-00001 · Sep 1, 2026 · Jake"], ["SC-00002", "— SC-00002 · Sep 2, 2026 · Larry"]]);
  assert.deepEqual(splitBlocks(""), []);
  assert.deepEqual(splitBlocks("— SC-00003\nonly").map((b) => b.callNumber), ["SC-00003"]);
});

test("merge: append, then replace the same call's block, then remove it when the notes are emptied; nothing to do → undefined", () => {
  const h1 = "— SC-00001 · Sep 1, 2026 · Jake";
  let v = mergeCallBlock(null, { callNumber: "SC-00001", header: h1, body: "── Jake · Sep 1\nReplaced breaker​n-1" });
  assert.equal(v, `${h1}\n── Jake · Sep 1\nReplaced breaker`, "zero-width replay ids are stripped");
  const h2 = "— SC-00002 · Sep 2, 2026 · Larry";
  v = mergeCallBlock(v, { callNumber: "SC-00002", header: h2, body: "Cleaned panels" });
  assert.equal(v, `${h1}\n── Jake · Sep 1\nReplaced breaker\n\n${h2}\nCleaned panels`);
  // the office edited SC-00001's notes after completion → its block is replaced in place
  v = mergeCallBlock(v, { callNumber: "SC-00001", header: h1, body: "Replaced breaker AND the bus bar" });
  assert.equal(v, `${h1}\nReplaced breaker AND the bus bar\n\n${h2}\nCleaned panels`);
  assert.equal(mergeCallBlock(v, { callNumber: "SC-00001", header: h1, body: "Replaced breaker AND the bus bar" }), undefined, "same again → no write");
  // emptied → removed; office text ahead of the blocks is kept
  v = mergeCallBlock("Office note.\n\n" + v, { callNumber: "SC-00002", header: h2, body: "" });
  assert.equal(v, `Office note.\n\n${h1}\nReplaced breaker AND the bus bar`);
  assert.equal(mergeCallBlock(null, { callNumber: "SC-00009", header: "— SC-00009", body: "  " }), undefined, "nothing on the call, nothing on the job");
});

test("merge: a block that would overflow the field is cut with a marker", () => {
  const v = mergeCallBlock("x".repeat(JOB_NOTES_MAX - 100), { callNumber: "SC-00001", header: "— SC-00001", body: "y".repeat(500) });
  assert.equal(v.length, JOB_NOTES_MAX);
  assert.ok(v.endsWith("[… cut — the call's own notes hold the full text]"));
});

test("fields: work notes → Notes_for_Summary__c, private → Notes_From_Service_Calls__c; only what changed", () => {
  const call = { Name: "SC-00007", Work_Notes__c: "Fixed it.", Private_Notes__c: null };
  const f = jobNotesFieldsFor({ Notes_for_Summary__c: null, Notes_From_Service_Calls__c: "— SC-00007 · Sep 1, 2026 · Jake\nold private" }, call, { techName: "Jake", at: "2026-09-01T18:00:00Z", timeZone: TZ });
  assert.deepEqual(f, { Notes_for_Summary__c: "— SC-00007 · Sep 1, 2026 · Jake\nFixed it.", Notes_From_Service_Calls__c: null });
  assert.equal(jobNotesFieldsFor({ Notes_for_Summary__c: "— SC-00007 · Sep 1, 2026 · Jake\nFixed it." }, call, { techName: "Jake", at: "2026-09-01T18:00:00Z", timeZone: TZ }), null);
  assert.equal(jobNotesFieldsFor({}, { Name: null }), null);
});
