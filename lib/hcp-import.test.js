// lib/hcp-import.js — the HCP import's decisions (2026-09-25): customer matching (hcp id →
// email → address, ambiguity never guessed), the three customer write modes, leads, lines,
// estimates, jobs, calls (Arizona times), invoices and payments. Pure; no Salesforce.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  indexExisting, decideCustomer, customerFields, leadStage, leadFields, lineKind, lineFields, lineTotals,
  pickOption, estimateStatus, estimateFields, jobEstimateFields, invoiceState, jobStatus, paymentStatus, jobFields,
  apptTimes, callFields, callStatusFor, invoiceStatus, invoiceFields, paymentMethod, paymentFields, techResolver, dollars, writable, FORMULA_FIELDS, callKey, cut,
} from "./hcp-import.js";

const T = "a0Tenant";
const existing = [
  { Id: "c-solar", Primary_Email__c: "Cy.Diaz@Example.com", Street__c: "9 Elm St", Postal_Code__c: "85201", Customer_Type__c: "Solar", Requested_Project_Types__c: "Solar", First_Name__c: "Cy", Last_Name__c: "Diaz", Primary_Phone__c: "" },
  { Id: "c-known", HCP_Id__c: "cus_known", Primary_Email__c: "k@example.com", Street__c: "1 A St", Postal_Code__c: "85001" },
  { Id: "c-dup1", Primary_Email__c: "dup@example.com", Street__c: "2 B St", Postal_Code__c: "85002" },
  { Id: "c-dup2", Primary_Email__c: "dup@example.com", Street__c: "3 C St", Postal_Code__c: "85003" },
  { Id: "c-addr", Primary_Email__c: "someone.else@example.com", Street__c: "77 Palm Ln", Postal_Code__c: "85301" },
  { Id: "c-noemail", Primary_Email__c: "", Street__c: "5 Oak Ave Unit 2", Postal_Code__c: "85999" },
];
const index = indexExisting(existing);
const hcp = (over) => ({ id: "cus_1", first_name: "Cy", last_name: "Diaz", email: "cy.diaz@example.com", mobile_number: "(602) 555-0100", addresses: [{ type: "service", street: "9 Elm St.", city: "Mesa", state: "AZ", zip: "85201" }], lead_source: "Web", ...over });

test("decideCustomer: hcp id first, then exact email, then street+zip; ambiguity creates + reviews", () => {
  assert.deepEqual(decideCustomer({ id: "cus_known", email: "x@y.z" }, index), { action: "known", sfId: "c-known", by: "hcp_id" });
  const byEmail = decideCustomer(hcp(), index);
  assert.equal(byEmail.action, "link");
  assert.equal(byEmail.sfId, "c-solar");
  assert.equal(byEmail.by, "email");
  const dup = decideCustomer(hcp({ id: "cus_2", email: "DUP@example.com", addresses: [] }), index);
  assert.equal(dup.action, "create");
  assert.match(dup.review, /email matches 2/);
  const byAddr = decideCustomer(hcp({ id: "cus_3", email: "", addresses: [{ type: "service", street: "5 Oak Avenue #2", zip: "85999-1234" }] }), index);
  assert.equal(byAddr.action, "link");
  assert.equal(byAddr.sfId, "c-noemail");
  assert.equal(byAddr.by, "address");
  assert.match(byAddr.review, /address only/);
  const newOccupant = decideCustomer(hcp({ id: "cus_4", email: "new.person@example.com", addresses: [{ type: "service", street: "77 Palm Ln", zip: "85301" }] }), index);
  assert.equal(newOccupant.action, "create");
  assert.match(newOccupant.review, /email differs/);
  assert.deepEqual(decideCustomer(hcp({ id: "cus_5", email: "nobody@example.com", addresses: [{ street: "1000 Nowhere Rd", zip: "85000" }] }), index), { action: "create" });
  // a second HCP record for the same household links to the same Sundial customer, flagged shared
  const again = decideCustomer(hcp({ id: "cus_6" }), index, new Set(["c-solar"]));
  assert.equal(again.sfId, "c-solar");
  assert.equal(again.shared, true);
});

test("customerFields: create writes everything + Service tags + Lead/Customer status; fillBlanks touches only empty fields and unions the types; refresh rewrites", () => {
  const c = hcp({ notes: "gate 1234" });
  const created = customerFields(c, { mode: "create", tenantId: T, hasJobs: true, leadSources: ["Web", "Referral"] });
  assert.equal(created.HCP_Id__c, "cus_1");
  assert.equal(created.Name, "Cy Diaz");
  assert.equal(created.Street__c, "9 Elm St.");
  assert.equal(created.Primary_Email__c, "cy.diaz@example.com");
  assert.equal(created.Status__c, "Customer");
  assert.equal(created.Customer_Type__c, "Service");
  assert.equal(created.Lead_Source__c, "Web");
  assert.equal(created.Description__c, "gate 1234");
  assert.equal(created.Client__c, T);
  assert.equal(created.Service_Stage__c, undefined, "a customer with jobs is not a pipeline entry");
  const lead = customerFields(c, { mode: "create", tenantId: T, hasJobs: false, leadSources: ["Referral"] });
  assert.equal(lead.Status__c, "Lead");
  assert.equal(lead.Service_Stage__c, undefined, "the import never stamps New (2026-09-29) — the office sets the stage on the customers it is working");
  assert.equal(lead.Lead_Source__c, undefined, "an unknown lead source is left blank, never an invalid picklist value");
  const fill = customerFields(c, { mode: "fillBlanks", existing: existing[0], tenantId: T });
  assert.deepEqual(fill, { HCP_Id__c: "cus_1", City__c: "Mesa", State__c: "AZ", Primary_Phone__c: "(602) 555-0100", Lead_Source__c: "Web", Customer_Type__c: "Solar;Service", Requested_Project_Types__c: "Solar;Service" }, "email / name / street already there stay Sales's; the blanks are filled");
  const refresh = customerFields(c, { mode: "refresh", tenantId: T });
  assert.equal(refresh.Name, "Cy Diaz");
  assert.equal(refresh.Client__c, undefined);
  assert.equal(refresh.Status__c, undefined, "a refresh never moves the lifecycle");
  assert.equal(refresh.Archived__c, undefined, "no disposition, no flag");
  // the archive flag (2026-10-02): on created / refreshed customers only, never a linked one
  const arch = customerFields(c, { mode: "create", tenantId: T, disposition: { archived: true, reason: "no job, estimate or lead in HCP; last activity 2025-03-01" } });
  assert.equal(arch.Archived__c, true);
  assert.equal(arch.Description__c, "gate 1234\nArchived by the HCP import: no job, estimate or lead in HCP; last activity 2025-03-01", "the reason is the trailing line of Description__c");
  assert.equal(customerFields(hcp({ notes: "" }), { mode: "refresh", tenantId: T, disposition: { archived: true, reason: "nothing open in HCP; last activity 2026-06-10" } }).Description__c, "Archived by the HCP import: nothing open in HCP; last activity 2026-06-10", "no HCP notes: the line alone");
  assert.equal(customerFields(hcp({ notes: "" }), { mode: "refresh", tenantId: T, disposition: { archived: false } }).Description__c, undefined, "active and no notes: Description__c is left alone");
  assert.equal(customerFields(c, { mode: "refresh", tenantId: T, disposition: { archived: false } }).Archived__c, false);
  assert.equal(customerFields(c, { mode: "fillBlanks", existing: existing[0], tenantId: T, disposition: { archived: true } }).Archived__c, undefined, "Sales's record is never archived by the import");
  const cleared = customerFields(c, { mode: "refresh", tenantId: T, blankStage: true });
  assert.equal(cleared.Service_Stage__c, null, "an explicit null clears the first import's New");
  assert.ok("Service_Stage__c" in cleared);
  assert.ok(!("Service_Stage__c" in customerFields(c, { mode: "create", tenantId: T, blankStage: true })), "only on a refresh");
});

test("leads: an open lead's stage from HCP's pipeline; won → Resolved, lost → Closed; the fields and the gaps", () => {
  assert.equal(leadStage({ status: "open" }), "New");
  assert.equal(leadStage({ status: "open", pipeline_status: "Second Contact" }), "Contact Attempt Made");
  assert.equal(leadStage({ status: "open", lost_at: "2026-09-01T00:00:00Z" }), "Closed");
  assert.equal(leadStage({ status: "won", conversions: [{ type: "Job", id: "job_1" }] }), "Resolved");
  const gaps = [];
  const onGap = (f, v) => gaps.push(`${f}=${v}`);
  const stages = ["New", "Contact Attempt Made", "In Progress", "Waiting on Customer", "Resolved", "Closed"];
  const f = leadFields({ id: "lead_1", number: "L-42", status: "open", pipeline_status: "Third Contact", lead_source: "Phone", tags: ["Inverter"], job_fields: { job_type_uuid: "jbt_1" } }, { assignedToId: "u1", leadSources: ["Phone"], stages, requestTypes: ["Inverter Down"], jobTypeName: "Inverter Down ", onGap });
  assert.equal(f.Service_Stage__c, "Contact Attempt Made");
  assert.equal(f.Call_Attempts__c, 3);
  assert.equal(f.Service_Request_Type__c, "Inverter Down", "HCP's job type, trailing space and all");
  assert.equal(f.Lead_Source__c, "Phone");
  assert.equal(f.Assigned_To__c, "u1");
  assert.match(f.Description__c, /HCP lead #L-42 · Third Contact \(open\)/);
  assert.match(f.Description__c, /Tags: Inverter/);
  assert.match(f.Description__c, /Job type: Inverter Down/);
  assert.doesNotMatch(f.Description__c, /job_type_uuid/, "ids are not notes");
  assert.deepEqual(gaps, []);
  // a stage the org lacks: the nearest one, and a gap for Tim
  const hold = leadFields({ status: "open", pipeline_status: "On Hold", lead_source: "Carrier pigeon" }, { stages, leadSources: ["Phone"], onGap });
  assert.equal(hold.Service_Stage__c, "Waiting on Customer");
  assert.deepEqual(gaps, ["Service_Stage__c=On Hold", "Lead_Source__c=Carrier pigeon"]);
  gaps.length = 0;
  assert.equal(leadFields({ status: "open", pipeline_status: "Working On - Waiting on Service/Quote" }, { stages, onGap }).Service_Stage__c, "In Progress");
  assert.equal(leadFields({ status: "open", pipeline_status: "Assigned" }, { stages, onGap }).Service_Stage__c, "New");
  assert.equal(leadFields({ status: "open", pipeline_status: "Something New" }, { stages, onGap }).Service_Stage__c, "New");
  assert.deepEqual(gaps, ["pipeline_status (unmapped → New)=Something New"]);
  gaps.length = 0;
  const lost = leadFields({ id: "lead_2", status: "lost", lost_at: "2026-08-02T10:00:00Z" }, { resolutions: ["Not Interested", "Job Created"], onGap, disposition: { archived: true, reason: "nothing open in HCP; last activity 2026-08-02" } });
  assert.match(lost.Description__c, /HCP lead #lead_2 \(lost\)\nArchived by the HCP import: nothing open in HCP; last activity 2026-08-02$/, "the archive line follows the lead block");
  assert.equal(lost.Service_Stage__c, "Closed");
  assert.equal(lost.Service_Resolution__c, "Not Interested");
  assert.equal(lost.Service_Resolved_Date__c, "2026-08-02");
  assert.deepEqual(gaps, ["Service_Resolution__c=Lost"]);
  assert.equal(leadFields({ status: "lost", lost_at: "2026-08-02T10:00:00Z" }, { resolutions: ["Lost"] }).Service_Resolution__c, "Lost");
  const won = leadFields({ status: "won", conversions: [{ type: "Job", id: "job_9" }] }, { resolutions: ["Job Created", "Estimate Created"], convertedAt: "2026-07-04T15:00:00Z" });
  assert.equal(won.Service_Stage__c, "Resolved");
  assert.equal(won.Service_Resolution__c, "Job Created");
  assert.equal(won.Service_Resolved_Date__c, "2026-07-04");
  assert.equal(leadFields({ status: "won", conversions: [{ type: "Estimate", id: "csr_1" }] }, {}).Service_Resolution__c, "Estimate Created");
});

test("lines: kind from the price-book item else HCP's kind; dollars from cents; cost on the right side; totals by kind", () => {
  const items = new Map([["svc_1", { Id: "pb1", Kind__c: "Product" }]]);
  const li = { id: "li_1", name: "Inverter, 7.6 kW", description: "SolarEdge", unit_price: 210000, unit_cost: 150000, quantity: 1, kind: "materials", taxable: true, order_index: 3, unit_of_measure: "each", service_item_id: "svc_9" };
  const row = lineFields(li, { estimateSfId: "e1", itemsByHcpId: items, tenantId: T, stage: "Completed" });
  assert.equal(row.Kind__c, "Material");
  assert.equal(row.Unit_Price__c, 2100);
  assert.equal(row.Unit_Material_Cost__c, 1500);
  assert.equal(row.Line_Total__c, 2100, "derived when HCP omits amount");
  assert.equal(row.Description__c, "Inverter, 7.6 kW — SolarEdge");
  assert.equal(row.Source__c, "Migration");
  assert.equal(row.Stage__c, "Completed");
  assert.equal(row.Sort_Order__c, 3);
  assert.equal(row.Price_Book_Item__c, undefined);
  const matched = lineFields({ ...li, service_item_id: "svc_1", kind: "labor", unit_cost: 5000, amount: 4200 }, { estimateSfId: "e1", itemsByHcpId: items, tenantId: T });
  assert.equal(matched.Kind__c, "Product", "the price-book item's kind wins");
  assert.equal(matched.Price_Book_Item__c, "pb1");
  assert.equal(matched.Unit_Labor_Cost__c, 50);
  assert.equal(matched.Line_Total__c, 42);
  assert.equal(lineKind({ kind: "discount" }), "Fee");
  assert.equal(lineKind({ kind: "service" }), "Labor");
  assert.deepEqual(lineTotals([row, { Kind__c: "Labor", Line_Total__c: 150.5 }, { Kind__c: "Fee", Line_Total__c: -20 }, { Kind__c: "Product", Line_Total__c: 10 }]), { Labor_Subtotal__c: 150.5, Material_Subtotal__c: 2100, Fee_Subtotal__c: -20, Subtotal__c: 2240.5 });
});

test("estimates: the approved option else the first; status; the standalone and the job-carried shapes", () => {
  const est = { id: "est_1", estimate_number: "E-7", work_status: "pending", customer: { id: "cus_1", first_name: "Cy", last_name: "Diaz", email: "cy@example.com" }, address: { street: "9 Elm St", city: "Mesa", state: "AZ", zip: "85201" }, created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-03T10:00:00Z",
    options: [{ id: "o1", name: "Good", total_amount: 99000, approval_status: "pending" }, { id: "o2", name: "Better", total_amount: 150000, approval_status: "customer_approved" }] };
  assert.equal(pickOption(est).id, "o2");
  assert.equal(estimateStatus(est, pickOption(est)), "Approved");
  assert.equal(estimateStatus({ options: [{ approval_status: "declined" }] }, { approval_status: "declined" }), "Declined");
  const lines = [{ Kind__c: "Labor", Line_Total__c: 1000 }, { Kind__c: "Material", Line_Total__c: 400 }];
  const f = estimateFields(est, { customerSfId: "c1", tenantId: T, lineRows: lines });
  assert.equal(f.HCP_Id__c, "est_1");
  assert.equal(f.Status__c, "Approved");
  assert.equal(f.Total__c, 1500);
  assert.equal(f.Subtotal__c, 1400);
  assert.equal(f.Tax_Amount__c, 100);
  assert.equal(f.Approved_Amount__c, 1500);
  assert.equal(f.Approved_At__c, "2026-09-03T10:00:00.000Z");
  assert.equal(f.Customer_Name_at_Creation__c, "Cy Diaz");
  assert.equal(f.Address_at_Creation__c, "9 Elm St, Mesa, AZ, 85201");
  const log = JSON.parse(f.Version_Log__c);
  assert.match(log[0].note, /option "Better"/);
  assert.match(log[0].note, /other options: Good: \$990 \(pending\)/);
  const job = { id: "job_1", invoice_number: "1042", description: "Breaker trips", total_amount: 45000, subtotal: 42000, customer: est.customer, address: est.address, created_at: "2026-09-01T10:00:00Z" };
  const je = jobEstimateFields(job, { customerSfId: "c1", tenantId: T, lineRows: [{ Kind__c: "Labor", Line_Total__c: 420 }], jobState: { invoiced: true } });
  assert.equal(je.HCP_Id__c, "job:job_1:estimate");
  assert.equal(je.Status__c, "Invoiced");
  assert.equal(je.Total__c, 450);
  assert.equal(je.Tax_Amount__c, 30);
  assert.equal(je.Scope_Summary__c, "Breaker trips");
  assert.equal(je.Archived__c, false);
  assert.equal(jobEstimateFields(job, { customerSfId: "c1", tenantId: T, jobState: { invoiced: false }, archived: true }).Archived__c, true, "the job's estimate follows the job");
  assert.equal(estimateStatus({ work_status: "needs scheduling", options: [{ approval_status: "expired" }] }, { approval_status: "expired" }), "Expired");
  const archived = estimateFields(est, { customerSfId: "c1", tenantId: T, disposition: { archived: true, reason: "converted to HCP job #1042" } });
  assert.equal(archived.Archived__c, true);
  assert.match(archived.Internal_Notes__c, /estimate #E-7\nArchived by the HCP import: converted to HCP job #1042/);
  assert.equal(estimateFields(est, { customerSfId: "c1", tenantId: T }).Archived__c, undefined, "no disposition, no flag (an org without the field)");
});

test("invoice state → job status / payment status", () => {
  const paid = invoiceState([{ id: "i1", status: "paid", amount: 45000, due_amount: 0, invoice_date: "2026-09-02", payments: [{ amount: 45000 }], refunds: [] }]);
  assert.equal(paid.fullyPaid, true);
  assert.equal(paid.paid, 45000);
  assert.deepEqual(jobStatus({ work_status: "complete", total_amount: 45000 }, paid), { Status__c: "Paid", Resolution__c: "Completed" });
  assert.equal(paymentStatus(paid), "Paid");
  const part = invoiceState([{ id: "i1", status: "sent", amount: 45000, due_amount: 20000, payments: [{ amount: 25000 }] }]);
  assert.deepEqual(jobStatus({ work_status: "complete", total_amount: 45000 }, part), { Status__c: "Invoiced" });
  assert.equal(paymentStatus(part), "Partially Paid");
  const none = invoiceState([]);
  assert.deepEqual(jobStatus({ work_status: "complete", total_amount: 0 }, none), { Status__c: "Closed", Resolution__c: "Completed" });
  assert.deepEqual(jobStatus({ work_status: "complete", total_amount: 5000 }, none), { Status__c: "Ready to Bill" });
  assert.deepEqual(jobStatus({ work_status: "pro_canceled" }, none), { Status__c: "Closed", Resolution__c: "Cancelled" });
  assert.deepEqual(jobStatus({ work_status: "scheduled" }, none), { Status__c: "Scheduled" });
  assert.deepEqual(jobStatus({ work_status: "unscheduled" }, none), { Status__c: "Ready to Schedule" });
  const voided = invoiceState([{ id: "i1", status: "voided", amount: 100 }, { id: "i2", status: "draft", amount: 5000, invoice_date: "2026-09-05" }]);
  assert.equal(voided.live.id, "i2");
  assert.equal(voided.invoiced, false, "a draft is not an issued invoice");
  const refunded = invoiceState([{ id: "i1", status: "paid", amount: 5000, payments: [{ amount: 5000 }], refunds: [{ amount: 5000 }] }]);
  assert.equal(paymentStatus(refunded), "Refunded");
});

test("jobs + calls: snapshot, notes header, first scheduled start; Arizona appointment times; one call per tech", () => {
  const job = { id: "job_1", invoice_number: "1042", work_status: "complete", description: "Breaker trips", notes: "gate 1234", tags: ["Warranty"], lead_source: "Web", total_amount: 45000, created_at: "2026-08-30T10:00:00Z", updated_at: "2026-09-02T10:00:00Z",
    customer: { first_name: "Cy", last_name: "Diaz", email: "cy@example.com", mobile_number: "6025550100" }, address: { street: "9 Elm St", city: "Mesa", state: "AZ", zip: "85201" },
    work_timestamps: { started_at: "2026-09-01T15:05:00Z", completed_at: "2026-09-01T16:50:00Z" }, schedule: { scheduled_start: "2026-09-01T15:00:00Z" } };
  const appt = { id: "ap_1", start_date: "2026-09-01", start_time: "08:00", end_time: "10:00", arrival_window_minutes: 60, dispatched_employees_ids: ["e1", "e2"] };
  assert.deepEqual(apptTimes(appt), { start: "2026-09-01T15:00:00.000Z", end: "2026-09-01T17:00:00.000Z" }, "08:00 Arizona = 15:00Z, no DST");
  assert.deepEqual(apptTimes({ start_date: "2026-09-01", start_time: "2026-09-01T15:00:00Z", end_time: "2026-09-01T17:00:00Z" }).start, "2026-09-01T15:00:00.000Z");
  assert.deepEqual(apptTimes({ start_date: "2026-09-01", anytime: true }), { start: "2026-09-01T15:00:00.000Z", end: "2026-09-02T00:00:00.000Z" });
  assert.equal(apptTimes({ start_date: "2026-09-01", start_time: "09:00", end_time: "09:00" }).end, "2026-09-01T18:00:00.000Z", "a zero-length window becomes two hours");
  const st = invoiceState([{ id: "i1", status: "paid", amount: 45000, due_amount: 0, payments: [{ amount: 45000 }] }]);
  const jf = jobFields(job, { customerSfId: "c1", estimateSfId: "e1", tenantId: T, st, appointments: [appt] });
  assert.equal(jf.Status__c, "Paid");
  assert.equal(jf.Payment_Status__c, "Paid");
  assert.equal(jf.Primary_Phone_at_Creation__c, "6025550100");
  assert.equal(jf.Issue_Description__c, "Breaker trips");
  assert.match(jf.Office_Notes__c, /^Migrated from Housecall Pro — HCP job #1042\nTags: Warranty\nLead source: Web\ngate 1234$/);
  assert.equal(jf.First_Scheduled_Start__c, "2026-09-01T15:00:00.000Z");
  assert.equal(jf.Intake_Date__c, "2026-08-30");
  assert.equal(jf.Estimate_Total__c, 450);
  assert.equal(callStatusFor(job), "Complete");
  assert.equal(callStatusFor({ work_status: "scheduled" }), "Scheduled");
  const cf = callFields(job, appt, { jobSfId: "j1", techSfId: "u1", techName: "Jake Dorsey", tenantId: T, hcpId: "ap_1:e1", status: "Complete" });
  assert.equal(cf.HCP_Id__c, "ap_1:e1");
  assert.equal(cf.Tech__c, "u1");
  assert.equal(cf.Actual_Start__c, "2026-09-01T15:05:00.000Z", "a single complete appointment takes the job's real clock");
  assert.equal(cf.Duration_Minutes__c, 105);
  assert.match(cf.Private_Notes__c, /Arrival window 60 min/);
  assert.doesNotMatch(cf.Private_Notes__c, /no matching Sundial user/);
  const noTech = callFields(job, appt, { jobSfId: "j1", techSfId: null, techName: "Old Tech", tenantId: T, hcpId: "ap_1:e9", status: "Scheduled" });
  assert.equal(noTech.Tech__c, undefined);
  assert.match(noTech.Private_Notes__c, /HCP tech: Old Tech \(no matching Sundial user\)/);
  assert.equal(noTech.Actual_Start__c, undefined);
});

test("invoices + payments: status, money in dollars, refunds as their own rows; the method map", () => {
  const inv = { id: "inv_1", invoice_number: "1042", status: "paid", amount: 45000, subtotal: 42000, due_amount: 0, invoice_date: "2026-09-02T00:00:00Z", sent_at: "2026-09-02T01:00:00Z", paid_at: "2026-09-03T00:00:00Z", due_at: "2026-10-02T00:00:00Z",
    taxes: [{ amount: 3000 }], discounts: [{ amount: -500 }], payments: [{ id: "p1", amount: 45000, payment_method: "credit_card", paid_at: "2026-09-03T00:00:00Z", status: "succeeded" }], refunds: [{ id: "r1", amount: 5000, payment_method: "credit_card", refunded_at: "2026-09-04T00:00:00Z" }] };
  const f = invoiceFields(inv, { jobSfId: "j1", tenantId: T });
  assert.equal(f.Name, "1042");
  assert.equal(f.Status__c, "Paid");
  assert.equal(f.Total__c, 450);
  assert.equal(f.Tax_Amount__c, 30);
  assert.equal(f.Discount_Amount__c, 5);
  assert.equal(f.Paid_Amount__c, 400, "payments less refunds");
  assert.equal(f.Balance__c, 0);
  assert.equal(f.Due_Date__c, "2026-10-02");
  assert.equal(invoiceStatus({ status: "sent", amount: 100, due_amount: 40 }), "Partially Paid");
  assert.equal(invoiceStatus({ status: "sent", amount: 100, due_amount: 100 }), "Sent");
  assert.equal(invoiceStatus({ status: "voided" }), "Void");
  assert.equal(invoiceFields({ id: "i9", invoice_number: "9", status: "voided", amount: 100, updated_at: "2026-09-09T00:00:00Z" }, { jobSfId: "j1", tenantId: T }).Voided_At__c, "2026-09-09T00:00:00.000Z");
  const pay = paymentFields(inv.payments[0], "payment", { inv, jobSfId: "j1", invoiceSfId: "si1", tenantId: T });
  assert.equal(pay.Type__c, "Payment");
  assert.equal(pay.Method__c, "Card");
  assert.equal(pay.Amount__c, 450);
  assert.equal(pay.Received_At__c, "2026-09-03T00:00:00.000Z");
  const ref = paymentFields(inv.refunds[0], "refund", { inv, jobSfId: "j1", invoiceSfId: "si1", tenantId: T });
  assert.equal(ref.Type__c, "Refund");
  assert.equal(ref.Amount__c, 50);
  assert.equal(ref.Received_At__c, "2026-09-04T00:00:00.000Z");
  assert.equal(paymentMethod({ payment_method: "check" }), "Check");
  assert.equal(paymentMethod({ payment_method: "bank_transfer" }), "ACH");
  assert.equal(paymentMethod({ payment_method: "cash" }), "Other");
  assert.equal(dollars(null), null);
  assert.equal(dollars(1), 0.01);
});

test("techResolver: the mapping file first (by id or email, to a user id or email), then the employee's email", () => {
  const resolve = techResolver({
    employees: [{ id: "e1", first_name: "Jake", last_name: "Dorsey", email: "jake@harmon.test" }, { id: "e2", first_name: "Old", last_name: "Tech", email: "old@harmon.test" }, { id: "e3", first_name: "Sam", last_name: "Lee", email: "sam.personal@example.com" }],
    users: [{ Id: "u1", Email__c: "Jake@Harmon.test" }, { Id: "u3", Email__c: "sam@harmon.test" }],
    map: { "sam.personal@example.com": "sam@harmon.test" },
  });
  assert.deepEqual(resolve("e1"), { sfId: "u1", name: "Jake Dorsey" });
  assert.deepEqual(resolve("e2"), { sfId: null, name: "Old Tech" });
  assert.deepEqual(resolve("e3"), { sfId: "u3", name: "Sam Lee" });
  assert.deepEqual(resolve("e404"), { sfId: null, name: "e404" });
});

test("writable(): the formula fields never reach an upsert (2026-09-28: Line_Total__c refused on the first canary)", () => {
  const line = writable("Sundial_Service_Line__c", { HCP_Id__c: "li", Quantity__c: 2, Unit_Price__c: 10, Line_Total__c: 20 });
  assert.equal(line.Line_Total__c, undefined);
  assert.equal(line.Unit_Price__c, 10);
  const job = writable("Sundial_Service_Job__c", { HCP_Id__c: "j", Status__c: "Paid", Estimate_Total__c: 450, Estimate_Status__c: "Invoiced", Estimate_Approved_Amount__c: 450 });
  assert.deepEqual(Object.keys(job).sort(), ["HCP_Id__c", "Status__c"]);
  const inv = writable("Sundial_Service_Invoice__c", { HCP_Id__c: "i", Total__c: 5, Balance__c: 0 });
  assert.equal(inv.Balance__c, undefined);
  assert.equal(writable("Sundial_Customer__c", { a: 1 }).a, 1, "objects without formulas pass through");
  assert.deepEqual(Object.keys(FORMULA_FIELDS).sort(), ["Sundial_Service_Invoice__c", "Sundial_Service_Job__c", "Sundial_Service_Line__c"]);
});

test("callKey + cut: a multi-tech call key fits Text(64) and is stable; a long value is cut with an ellipsis", () => {
  const a = "app_faf5dfb16e524ab5be3637052e2b3f87";
  const e = "pro_0123456789abcdef0123456789abcdef";
  assert.equal(callKey(a, e, false), a);
  const k = callKey(a, e, true);
  assert.ok(k.length <= 64 && k.startsWith(`${a}:`) && /:[0-9a-f]{8}$/.test(k), k);
  assert.equal(callKey(a, e, true), k, "deterministic — a re-run finds the same call");
  assert.notEqual(callKey(a, "pro_other", true), k);
  assert.equal(cut("short", 255), "short");
  assert.equal(cut("x".repeat(300), 255).length, 255);
  assert.ok(cut("x".repeat(300), 255).endsWith("…"));
});
