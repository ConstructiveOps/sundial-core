// lib/hcp-lead-notes.js — the repair plan for lead customers whose HCP notes the import
// replaced with the lead block (2026-10-14). `node --test lib/hcp-lead-notes.test.js`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isImportText, planLeadNotesRestore, DESCRIPTION_MAX } from "./hcp-lead-notes.js";
import { appendLeadBlock, leadBlock, leadDescription, leadFields } from "./hcp-import.js";

const LEAD = { id: "lead_1", number: "L-42", status: "open", pipeline_status: "Third Contact", tags: ["Inverter"], customer: { id: "cus_1" }, job_fields: { job_type_uuid: "jbt_1" } };
const JOB_TYPES = new Map([["jbt_1", "Inverter Down"]]);
const BLOCK = leadBlock(LEAD, "Inverter Down");
const ARCHIVE = "Archived by the HCP import: nothing open in HCP; last activity 2026-08-02";
const NOTES = "Gate code 1234.\nDog in the yard — call first.";

const base = (over = {}) => ({
  records: [{ Id: "a1P000000000001AAA", Name: "Ellen Smith", HCP_Id__c: "cus_1", Description__c: BLOCK }],
  customersHcp: [{ id: "cus_1", notes: NOTES }],
  leadsHcp: [LEAD],
  jobTypes: JOB_TYPES,
  idMapCustomers: { cus_1: { sfId: "a1P000000000001AAA", created: true } },
  ...over,
});

test("the import now keeps the customer's notes above the lead block", () => {
  const f = leadFields(LEAD, { jobTypeName: "Inverter Down", customerNotes: NOTES, disposition: { archived: true, reason: "nothing open in HCP; last activity 2026-08-02" } });
  assert.equal(f.Description__c, `${NOTES}\n\n${BLOCK}\n${ARCHIVE}`);
  assert.equal(leadFields(LEAD, { jobTypeName: "Inverter Down" }).Description__c, BLOCK, "no notes: the block alone, as before");
});

test("isImportText: the block, or the block + archive line — nothing else", () => {
  assert.equal(isImportText(BLOCK, BLOCK), true);
  assert.equal(isImportText(`${BLOCK}\n${ARCHIVE}`, BLOCK), true);
  assert.equal(isImportText(`${BLOCK}\r\n${ARCHIVE}`, BLOCK), true, "CRLF from Salesforce is the same text");
  assert.equal(isImportText(`${BLOCK}\nCalled back 10/9, wants a quote`, BLOCK), false);
  assert.equal(isImportText(`${BLOCK}\n${ARCHIVE}\nextra line`, BLOCK), false);
  assert.equal(isImportText(`Spoke to Ellen.\n${BLOCK}`, BLOCK), false);
});

test("a lead block the import wrote gets the notes prepended, block and archive line kept", () => {
  const p = planLeadNotesRestore(base({ records: [{ Id: "a1P000000000001AAA", Name: "Ellen Smith", HCP_Id__c: "cus_1", Description__c: `${BLOCK}\n${ARCHIVE}` }] }));
  assert.equal(p.counts.restore, 1);
  assert.equal(p.writes[0].after, `${NOTES}\n\n${BLOCK}\n${ARCHIVE}`);
  assert.equal(p.writes[0].after, leadDescription(NOTES, BLOCK, { archived: true, reason: "nothing open in HCP; last activity 2026-08-02" }), "the same shape a re-run of the fixed import writes");
  assert.equal(p.writes[0].lead, "L-42");
});

test("a hand-edited description is listed, never written", () => {
  const p = planLeadNotesRestore(base({ records: [{ Id: "a1P000000000001AAA", Name: "Ellen Smith", HCP_Id__c: "cus_1", Description__c: `${BLOCK}\nBen: called 10/9, wants a quote` }] }));
  assert.equal(p.writes.length, 0);
  assert.equal(p.counts.edited, 1);
  assert.equal(p.edited[0].id, "a1P000000000001AAA");
});

test("idempotent: notes already present → skipped", () => {
  const p = planLeadNotesRestore(base({ records: [{ Id: "a1P000000000001AAA", Name: "Ellen Smith", HCP_Id__c: "cus_1", Description__c: `${NOTES}\n\n${BLOCK}` }] }));
  assert.equal(p.writes.length, 0);
  // starts with the notes, not "HCP lead #" — so it is not a lead block any more
  assert.equal(p.counts.notLeadBlock, 1);
  const q = planLeadNotesRestore(base({ customersHcp: [{ id: "cus_1", notes: "Inverter" }] }));
  assert.equal(q.counts.alreadyRestored, 1, "notes text already inside the block");
});

test("nothing to restore: blank / null notes, not a lead block, no HCP id", () => {
  assert.equal(planLeadNotesRestore(base({ customersHcp: [{ id: "cus_1", notes: null }] })).counts.noNotes, 1);
  assert.equal(planLeadNotesRestore(base({ customersHcp: [{ id: "cus_1", notes: "   " }] })).counts.noNotes, 1);
  assert.equal(planLeadNotesRestore(base({ records: [{ Id: "x", HCP_Id__c: "cus_1", Description__c: "Gate code 1234" }] })).counts.notLeadBlock, 1);
  assert.equal(planLeadNotesRestore(base({ records: [{ Id: "x", HCP_Id__c: null, Description__c: BLOCK }] })).counts.scanned, 0);
});

test("a linked (Sales) record is listed and left alone", () => {
  const p = planLeadNotesRestore(base({ idMapCustomers: { cus_1: { sfId: "a1P000000000001AAA", created: false, by: "email" } } }));
  assert.equal(p.writes.length, 0);
  assert.equal(p.counts.linked, 1);
  assert.deepEqual(p.linked[0], { id: "a1P000000000001AAA", name: "Ellen Smith", hcp_id: "cus_1" });
});

test("a shared household's second HCP record's lead block is recognised", () => {
  const lead2 = { ...LEAD, id: "lead_2", number: "L-77", customer: { id: "cus_2" }, tags: [] };
  const p = planLeadNotesRestore(base({
    records: [{ Id: "a1P000000000001AAA", Name: "Ellen Smith", HCP_Id__c: "cus_1", Description__c: leadBlock(lead2, "Inverter Down") }],
    leadsHcp: [LEAD, lead2],
    idMapCustomers: { cus_1: { sfId: "a1P000000000001AAA", created: true }, cus_2: { sfId: "a1P000000000001AAA", created: false } },
  }));
  assert.equal(p.counts.restore, 1);
  assert.equal(p.writes[0].lead, "L-77");
});

test("notes embedded only on the lead's customer (not in customers.json) are used", () => {
  const p = planLeadNotesRestore(base({ customersHcp: [], leadsHcp: [{ ...LEAD, customer: { id: "cus_1", notes: NOTES } }] }));
  assert.equal(p.counts.restore, 1);
});

test("too long for the field → skipped and listed, never truncated", () => {
  const p = planLeadNotesRestore(base({ customersHcp: [{ id: "cus_1", notes: "x".repeat(DESCRIPTION_MAX) }] }));
  assert.equal(p.writes.length, 0);
  assert.equal(p.counts.tooLong, 1);
  assert.match(p.edited[0].reason, /32000/);
});

// A LINKED (Sales) record: the lead block goes below Sales's text, never over it (2026-10-14).
test("appendLeadBlock: Sales's text kept, the block below it after a blank line", () => {
  assert.equal(appendLeadBlock("Sunbase: 8.2 kW, PTO 2021", BLOCK, ["L-42"]), `Sunbase: 8.2 kW, PTO 2021\n\n${BLOCK}`);
  assert.equal(appendLeadBlock("", BLOCK, ["L-42"]), BLOCK, "blank: the block alone");
  assert.equal(appendLeadBlock(null, BLOCK, ["L-42"]), BLOCK);
});

test("appendLeadBlock: a re-run swaps its own trailing block, never stacks one", () => {
  const once = appendLeadBlock("Sunbase: 8.2 kW", BLOCK, ["L-42"]);
  assert.equal(appendLeadBlock(once, BLOCK, ["L-42"]), once, "same block → unchanged");
  const moved = leadBlock({ ...LEAD, pipeline_status: "Won", status: "won" }, "Inverter Down");
  assert.equal(appendLeadBlock(once, moved, ["L-42"]), `Sunbase: 8.2 kW\n\n${moved}`, "status changed in HCP → the block is replaced");
  assert.equal(appendLeadBlock(`${once}\r\n`, BLOCK, ["L-42"]), once, "CRLF / trailing whitespace from Salesforce");
  // today's 209: the whole field IS an old block (Sales's text already gone) → the block alone
  assert.equal(appendLeadBlock(BLOCK, moved, ["L-42"]), moved);
});

test("appendLeadBlock: anything typed after the block, or another customer's block, is kept", () => {
  const typed = `Sunbase: 8.2 kW\n\n${BLOCK}\n\nBen 10/14: called, wants a quote`;
  assert.equal(appendLeadBlock(typed, BLOCK, ["L-42"]), `${typed}\n\n${BLOCK}`, "typed text after it → append, nothing lost");
  const foreign = `Notes\n\n${BLOCK}`;
  assert.equal(appendLeadBlock(foreign, BLOCK, ["L-99"]), `${foreign}\n\n${BLOCK}`, "a block naming a lead that is not this customer's is text");
  const inline = `Customer said: HCP lead #L-42 was a dupe`;
  assert.equal(appendLeadBlock(inline, BLOCK, ["L-42"]), `${inline}\n\n${BLOCK}`, "mid-line mention is not a block");
});
