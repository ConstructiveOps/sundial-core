// lib/hcp-disposition.js — what the HCP import archives and what it leaves on the board
// (2026-10-02). Shapes are the real ones from the 2026-09-26 pull; `now` is pinned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LEAD_RESET_REASON, claimedEstimates, closedLeadOutcome, customerDisposition, estimateDisposition, hasInvoicedTag, jobDisposition, leadConversions, openLeadStage } from "./hcp-disposition.js";

const NOW = new Date("2026-10-04T12:00:00Z");
const opts = { now: NOW, staleDays: 90 };
const paid = { invoiced: true, fullyPaid: true };
const unpaid = { invoiced: true, fullyPaid: false };
const none = { invoiced: false, fullyPaid: false };

test("jobs: cancelled / paid / $0 / invoiced+tagged are archived; invoiced-untagged, in progress and fresh open ones stay", () => {
  assert.deepEqual(jobDisposition({ work_status: "pro canceled", deleted_at: "2026-05-01T00:00:00Z" }, { st: none, ...opts }), { archived: true, reason: "cancelled in HCP (deleted)", stale: false });
  assert.equal(jobDisposition({ work_status: "user canceled" }, { st: none, ...opts }).reason, "cancelled in HCP");
  assert.equal(jobDisposition({ work_status: "complete rated", total_amount: 45000 }, { st: paid, ...opts }).reason, "complete and paid in HCP");
  assert.equal(jobDisposition({ work_status: "complete unrated", total_amount: 0 }, { st: none, ...opts }).reason, "complete in HCP, nothing to bill");
  assert.equal(jobDisposition({ work_status: "complete unrated", total_amount: 20000 }, { st: none, ...opts }).archived, true, "complete with no invoice at all: nothing to chase");
  // Harmon's "invoiced 7/23/26" tag = handed to Acumatica (Tim, 2026-10-02: archive only the tagged ones)
  assert.deepEqual(jobDisposition({ work_status: "complete unrated", total_amount: 20000, tags: ["invoiced 7/23/26"] }, { st: unpaid, ...opts }), { archived: true, reason: "complete; invoice handed to Acumatica (HCP tag)", stale: false });
  assert.deepEqual(jobDisposition({ work_status: "complete unrated", total_amount: 20000, tags: ["Pipeline Automation"] }, { st: unpaid, ...opts }), { archived: false, reason: null, stale: false }, "untagged: the office checks it");
  assert.ok(hasInvoicedTag({ tags: ["Invoiced"] }));
  assert.ok(!hasInvoicedTag({ tags: ["not invoiced"] }));
  assert.equal(jobDisposition({ work_status: "in progress", updated_at: "2025-01-01T00:00:00Z" }, { st: none, ...opts }).archived, false, "in progress is never stale");
  // scheduled: the start date decides, not the last edit
  assert.deepEqual(jobDisposition({ work_status: "scheduled", schedule: { scheduled_start: "2025-12-02T15:00:00Z" }, work_timestamps: {}, updated_at: "2026-09-30T00:00:00Z" }, { st: none, ...opts }), { archived: true, reason: "scheduled for 2025-12-02 in HCP and never started", stale: true });
  assert.equal(jobDisposition({ work_status: "scheduled", schedule: { scheduled_start: "2026-07-05T15:00:00Z" } }, { st: none, ...opts }).archived, true, "91 days back: past the 90-day cutoff (2026-07-06)");
  assert.equal(jobDisposition({ work_status: "scheduled", schedule: { scheduled_start: "2026-07-07T15:00:00Z" } }, { st: none, ...opts }).archived, false, "89 days back: inside it");
  assert.equal(jobDisposition({ work_status: "scheduled", schedule: { scheduled_start: "2026-07-05T15:00:00Z" } }, { st: none, now: NOW, staleDays: 120 }).archived, false, "--stale-days moves the cutoff");
  assert.equal(jobDisposition({ work_status: "scheduled", schedule: { scheduled_start: "2025-12-02T15:00:00Z" }, work_timestamps: { started_at: "2025-12-02T15:10:00Z" } }, { st: none, ...opts }).archived, false, "a started visit is not abandoned");
  assert.equal(jobDisposition({ work_status: "scheduled", schedule: { scheduled_start: "2026-10-10T15:00:00Z" } }, { st: none, ...opts }).archived, false);
  assert.equal(jobDisposition({ work_status: "scheduled", schedule: {} }, { st: none, ...opts }).archived, false, "no start date: not judged");
  // needs scheduling: the last touch decides
  assert.deepEqual(jobDisposition({ work_status: "needs scheduling", updated_at: "2026-06-01T00:00:00Z" }, { st: none, ...opts }), { archived: true, reason: "needs scheduling in HCP, untouched since 2026-06-01", stale: true });
  assert.equal(jobDisposition({ work_status: "needs scheduling", updated_at: "2026-09-01T00:00:00Z" }, { st: none, ...opts }).archived, false);
  assert.equal(jobDisposition({ work_status: "unscheduled", created_at: "2026-01-01T00:00:00Z" }, { st: none, ...opts }).archived, true, "created_at when never updated");
});

test("estimates: converted / cancelled / declined / expired / untouched are archived; a live one stays", () => {
  assert.deepEqual(estimateDisposition({ work_status: "needs scheduling", updated_at: "2026-09-30T00:00:00Z" }, { convertedTo: { id: "job_1", invoice_number: "1042" }, ...opts }), { archived: true, reason: "converted to HCP job #1042" });
  assert.equal(estimateDisposition({ work_status: "pro canceled", updated_at: "2026-09-30T00:00:00Z" }, opts).reason, "cancelled in HCP");
  assert.equal(estimateDisposition({ work_status: "complete unrated", updated_at: "2026-09-30T00:00:00Z" }, { status: "Declined", ...opts }).reason, "declined in HCP");
  assert.equal(estimateDisposition({ work_status: "needs scheduling", updated_at: "2026-09-30T00:00:00Z" }, { status: "Expired", ...opts }).reason, "expired in HCP");
  assert.deepEqual(estimateDisposition({ work_status: "needs scheduling", updated_at: "2026-03-01T00:00:00Z" }, { status: "Sent", ...opts }), { archived: true, reason: "untouched in HCP since 2026-03-01" });
  assert.deepEqual(estimateDisposition({ work_status: "needs scheduling", updated_at: "2026-09-01T00:00:00Z" }, { status: "Approved", ...opts }), { archived: false, reason: null });
});

test("customers: no job in HCP = a Lead = archived (the clean pipeline, 2026-10-02), open lead or not; with jobs: live work keeps it, else quiet for the cutoff", () => {
  const quiet = { created_at: "2025-03-01T00:00:00Z", updated_at: "2025-03-01T00:00:00Z" };
  const reset = { archived: true, reason: LEAD_RESET_REASON, open: null, leadReset: true };
  assert.deepEqual(customerDisposition(quiet, opts), reset, "the address book");
  assert.deepEqual(customerDisposition({ created_at: "2026-09-20T00:00:00Z" }, opts), reset, "added to HCP last month, still no job: a Lead, archived");
  assert.deepEqual(customerDisposition(quiet, { leads: [{ status: "open" }], ...opts }), reset, "an OPEN HCP lead is still a Lead — Harmon starts clean; its stage is written, hidden");
  assert.deepEqual(customerDisposition(quiet, { estimates: [{ est: { updated_at: "2026-09-01T00:00:00Z" }, disposition: { archived: false } }], ...opts }), reset, "a live estimate with no job: the estimate stays on its list, the customer is a Lead");
  // --keep-leads: the earlier rules
  const keep = { ...opts, cleanLeadPipeline: false };
  assert.deepEqual(customerDisposition(quiet, keep), { archived: true, reason: "no job, estimate or lead in HCP; last activity 2025-03-01", open: null });
  assert.equal(customerDisposition({ created_at: "2026-09-20T00:00:00Z" }, keep).archived, false, "a customer added to HCP last month is left alone");
  assert.deepEqual(customerDisposition(quiet, { leads: [{ status: "open" }], ...keep }), { archived: false, reason: null, open: "lead" });
  assert.equal(customerDisposition(quiet, { leads: [{ status: "open", lost_at: "2026-01-01T00:00:00Z" }], ...keep }).archived, true, "open with a lost_at is lost");
  assert.deepEqual(customerDisposition(quiet, { estimates: [{ est: { updated_at: "2025-06-01T00:00:00Z" }, disposition: { archived: false } }], ...keep }), { archived: false, reason: null, open: "estimate" });
  // a customer WITH jobs (Status Customer): the live-work / 90-day rules, with or without the reset
  const job = (archived, updated_at = "2025-06-01T00:00:00Z") => ({ job: { updated_at }, disposition: { archived } });
  assert.deepEqual(customerDisposition(quiet, { jobs: [job(false)], ...opts }), { archived: false, reason: null, open: "job" });
  assert.deepEqual(customerDisposition(quiet, { jobs: [job(true)], leads: [{ status: "open" }], ...opts }), { archived: false, reason: null, open: "lead" }, "a job in the past + an open lead now: visible");
  assert.deepEqual(customerDisposition(quiet, { jobs: [job(true)], estimates: [{ est: { updated_at: "2026-09-01T00:00:00Z" }, disposition: { archived: false } }], ...opts }), { archived: false, reason: null, open: "estimate" });
  assert.equal(customerDisposition(quiet, { jobs: [job(true)], leads: [{ status: "lost", lost_at: "2026-08-20T00:00:00Z" }], ...opts }).archived, false, "lost six weeks ago: still in the recent list");
  assert.deepEqual(customerDisposition(quiet, { leads: [{ status: "lost", lost_at: "2026-06-10T00:00:00Z" }], jobs: [job(true, "2026-05-01T00:00:00Z")], ...opts }), { archived: true, reason: "nothing open in HCP; last activity 2026-06-10", open: null });
  assert.equal(customerDisposition(quiet, { jobs: [job(true, "2026-09-15T00:00:00Z")], ...opts }).archived, false, "a job finished last month: still visible");
  assert.equal(customerDisposition({}, { jobs: [job(true, "")], ...opts }).archived, true, "no dates at all: archived (reason says unknown)");
  assert.match(customerDisposition({}, { jobs: [job(true, "")], ...opts }).reason, /last activity unknown/);
});

test("the lead's pipeline → stage, attempts, and the gap when the org lacks the value", () => {
  const stages = ["New", "Contact Attempt Made", "In Progress", "Waiting on Customer", "Waiting on Other Department", "Estimate Created", "Resolved", "Closed"];
  const st = (ps, s = stages) => openLeadStage({ pipeline_status: ps }, { stages: s });
  assert.deepEqual(st("New Lead"), { stage: "New", attempts: 0, known: true, missingValue: null });
  assert.equal(st("Unassigned").stage, "New");
  assert.equal(st("Assigned").stage, "New", "handed to someone, not yet worked");
  assert.deepEqual(st("First Contact"), { stage: "Contact Attempt Made", attempts: 1, known: true, missingValue: null });
  assert.equal(st("Second Contact").attempts, 2);
  assert.equal(st("Third Contact").attempts, 3);
  assert.equal(st("Working On - Waiting on Customer").stage, "Waiting on Customer");
  assert.equal(st("Working On - Waiting on Service/Quote").stage, "In Progress");
  assert.deepEqual(st("On Hold"), { stage: "Waiting on Customer", attempts: 0, known: true, missingValue: "On Hold" }, "no On Hold in the org yet → the nearest, reported");
  assert.deepEqual(st("On Hold", [...stages, "On Hold"]), { stage: "On Hold", attempts: 0, known: true, missingValue: null }, "once Tim adds it, it is used");
  assert.deepEqual(st("Qualifying"), { stage: "New", attempts: 0, known: false, missingValue: null }, "a pipeline status we never saw: New, flagged unmapped");
  assert.equal(st("", null).stage, "New");
  assert.equal(st("First Contact", ["New", "Closed"]).stage, "New", "an org with neither value falls all the way back to New");
});

test("closed leads: lost → Closed·Lost (Not Interested until the org has Lost); won → Resolved·Job/Estimate Created; open → null", () => {
  assert.deepEqual(closedLeadOutcome({ status: "lost", lost_at: "2026-06-10T19:00:00Z" }, { resolutions: ["Not Interested"] }), { stage: "Closed", resolution: "Not Interested", resolvedAt: "2026-06-10", missingValue: "Lost" });
  assert.deepEqual(closedLeadOutcome({ status: "lost", lost_at: "2026-06-10T19:00:00Z" }, { resolutions: ["Lost"] }), { stage: "Closed", resolution: "Lost", resolvedAt: "2026-06-10", missingValue: null });
  assert.equal(closedLeadOutcome({ status: "lost" }, {}).resolution, "Lost", "no picklist known → the intended value");
  assert.deepEqual(closedLeadOutcome({ status: "won", conversions: [{ type: "Job", id: "job_1" }] }, { resolutions: ["Job Created", "Estimate Created"], convertedAt: "2026-07-04T15:00:00Z" }), { stage: "Resolved", resolution: "Job Created", resolvedAt: "2026-07-04", missingValue: null });
  assert.equal(closedLeadOutcome({ status: "won", conversions: [{ type: "Estimate", id: "csr_1" }] }, {}).resolution, "Estimate Created");
  assert.equal(closedLeadOutcome({ status: "won", conversions: [] }, {}).resolution, "Estimate Created", "won with no conversion listed: the quote exists somewhere");
  assert.equal(closedLeadOutcome({ status: "won", lost_at: "2026-01-01T00:00:00Z" }, {}).stage, "Closed", "a lost_at wins (the one won+lost lead in the pull)");
  assert.equal(closedLeadOutcome({ status: "open", conversions: [] }, {}), null);
  assert.deepEqual(leadConversions({ conversions: [{ type: "Job", id: "job_1" }, { type: "Estimate", id: "" }] }), [{ type: "job", id: "job_1" }]);
});

test("claimedEstimates: a job names its estimate by the OPTION id (est_…), the estimate's own id is csr_…", () => {
  const estimates = [{ id: "csr_1", options: [{ id: "est_a" }, { id: "est_b" }] }, { id: "csr_2", options: [{ id: "est_c" }] }, { id: "csr_3", options: [] }];
  const jobs = [
    { id: "job_1", original_estimate_id: "est_b", original_estimate_uuids: ["est_b"] },
    { id: "job_2", original_estimate_id: "est_b" }, // a second job from the same quote: the first keeps it
    { id: "job_3", original_estimate_uuids: ["est_c"] },
    { id: "job_4", original_estimate_id: "csr_3" }, // an estimate id straight: also fine
    { id: "job_5", original_estimate_id: "est_zz" }, // unknown: ignored
    { id: "job_6" },
  ];
  const claimed = claimedEstimates(jobs, estimates);
  assert.deepEqual([...claimed.entries()].map(([k, j]) => [k, j.id]), [["csr_1", "job_1"], ["csr_2", "job_3"], ["csr_3", "job_4"]]);
});
