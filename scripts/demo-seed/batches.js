// batches.js — how the demo data set grows without disturbing what was already seeded.
//
// THE PROBLEM: the plan is rebuilt from the same anchor and seed on every run, and the
// id-map's stable keys ("customer:017", "job:031") are what tie a planned record to the
// one in Salesforce. If growing the data set changed the plan of a record that already
// exists, the keys would keep pointing at the right ids but mean something else — the
// writer skips an existing key, so nothing would be rewritten, but a later rebuild of a
// lost id-map (recovery.js matches records by natural key) would no longer find them.
//
// THE RULE: the data set is a list of BATCHES. Batch 0 is the original 100 customers and
// everything that hangs off them, planned exactly as on the first --apply. Every later
// batch is a block of 50 more customers with its own random streams, its own key
// numbers (continuing where the batch before stopped) and its own slice of the dispatch
// board, so the plan of every earlier batch is byte for byte the same whether or not the
// later one exists. `--customers 150` adds one growth batch, `--customers 200` two, and
// so on; a number that is not 100 plus a multiple of 50 is refused.
//
// A growth batch holds: 25 solar projects spread over the active stages, 5 roofing-only
// customers (plus one re-roof tied to a solar project when a project sits in
// "Re-Roof Needed"), and 20 service-only customers — 5 who have only called in, 15 with
// work — carrying 22 service jobs spread over every status the board shows (except the
// live "a tech is clocked in right now" picture, which stays batch 0's) and 3 estimates
// that never became a job. Its calls sit in a window of their own on the board (the week
// before the original board, and the week after it), so no tech is ever double-booked.

import { CUSTOMER_COUNT, PIPELINE_COUNT, ROOFING_ONLY_COUNT } from "./plan-customers.js";
import { SOLAR_COUNT } from "./plan-solar.js";
import { ROOFING_COUNT, ROOFING_WITH_SOLAR } from "./plan-roofing.js";
import { JOB_COUNT, JOBLESS_ESTIMATE_COUNT, JOB_STATUS_COUNTS, JOBLESS_ESTIMATE_STATUSES, SCHEDULE_DAYS_BACK, SCHEDULE_DAYS_AHEAD } from "./plan-service.js";

export const BASE_CUSTOMERS = CUSTOMER_COUNT;
export const GROWTH_STEP = 50;

/** One growth batch: the mix of its 50 customers and what hangs off them. */
export const GROWTH = Object.freeze({
  customers: GROWTH_STEP,
  solar: 25,
  pipeline: 0,
  roofingOnly: 5,
  service: 20,
  /** re-roofs tied to a solar project of the same batch (only when one sits in "Re-Roof Needed") */
  roofingWithSolar: 1,
  /** service customers who have only called in so far (no estimate yet) */
  callInOnly: 5,
  jobCounts: Object.freeze({
    Closed: 1, Paid: 2, Invoiced: 2, "Ready to Bill": 2, "Awaiting Parts": 1, "Awaiting Office Review": 2, "In Progress": 2,
    Scheduled: 6, "Ready to Schedule": 2, "Remote Investigation": 1, Triaging: 0, New: 1,
  }),
  jobless: Object.freeze(["Draft", "Sent", "Declined"]),
});
export const GROWTH_JOBS = Object.values(GROWTH.jobCounts).reduce((s, n) => s + n, 0);

/** The customer total a `--customers` value must be: 100, 150, 200, … */
export function validCustomerCount(n) {
  return Number.isInteger(n) && n >= BASE_CUSTOMERS && (n - BASE_CUSTOMERS) % GROWTH_STEP === 0;
}
export const customerCountHelp = `--customers must be ${BASE_CUSTOMERS} or ${BASE_CUSTOMERS} plus a multiple of ${GROWTH_STEP} (${BASE_CUSTOMERS + GROWTH_STEP}, ${BASE_CUSTOMERS + 2 * GROWTH_STEP}, …)`;

/**
 * The batches a plan of `customers` customers is made of. Batch 0 is the original data set
 * and is described in the terms the planners have always used; each growth batch says
 * where its keys start and which slice of the board its calls take.
 *
 * Service numbering: a job and its estimate share a number (job:031 / estimate:031), and
 * the jobless estimates of a batch take the numbers after its jobs, so the next batch's
 * jobs start after the previous batch's LAST ESTIMATE (batch 0: jobs 1–45, estimates
 * 1–51; batch 1: jobs and estimates 52–73, jobless estimates 74–76; …).
 */
export function batchesFor(customers = BASE_CUSTOMERS) {
  if (!validCustomerCount(customers)) throw new Error(customerCountHelp);
  const out = [{
    index: 0,
    growth: false,
    firstCustomer: 1,
    customers: BASE_CUSTOMERS,
    // customer n (1-based inside the batch) -> its kind
    kindOf: (i) => (i <= SOLAR_COUNT ? "solar" : i <= SOLAR_COUNT + PIPELINE_COUNT ? "pipeline" : i <= SOLAR_COUNT + PIPELINE_COUNT + ROOFING_ONLY_COUNT ? "roofing" : "service"),
    roofing: { firstNo: 1, count: ROOFING_COUNT, withSolar: ROOFING_WITH_SOLAR },
    service: {
      firstNo: 1, jobCounts: JOB_STATUS_COUNTS, jobless: JOBLESS_ESTIMATE_STATUSES, callInOnly: 5, liveDemo: true,
      // null = the original board: ten days back to seven ahead, with today's live picture
      windows: null,
    },
  }];
  let nextRoofing = ROOFING_COUNT + 1;
  let nextService = JOB_COUNT + JOBLESS_ESTIMATE_COUNT + 1;
  for (let k = 1; k <= (customers - BASE_CUSTOMERS) / GROWTH_STEP; k++) {
    const g = GROWTH;
    out.push({
      index: k,
      growth: true,
      firstCustomer: BASE_CUSTOMERS + (k - 1) * GROWTH_STEP + 1,
      customers: g.customers,
      kindOf: (i) => (i <= g.solar ? "solar" : i <= g.solar + g.pipeline ? "pipeline" : i <= g.solar + g.pipeline + g.roofingOnly ? "roofing" : "service"),
      roofing: { firstNo: nextRoofing, count: g.roofingOnly + g.roofingWithSolar, withSolar: g.roofingWithSolar },
      service: {
        firstNo: nextService, jobCounts: g.jobCounts, jobless: g.jobless, callInOnly: g.callInOnly, liveDemo: false,
        // Calls of batch k: the seven days before batch k-1's past window, and the seven days after its future.
        windows: {
          past: [-(SCHEDULE_DAYS_BACK + 7 * k), -(SCHEDULE_DAYS_BACK + 7 * (k - 1) + 1)],
          future: [SCHEDULE_DAYS_AHEAD + 7 * (k - 1) + 1, SCHEDULE_DAYS_AHEAD + 7 * k],
        },
      },
    });
    nextRoofing += g.roofingOnly + g.roofingWithSolar;
    nextService += GROWTH_JOBS + g.jobless.length;
  }
  return out;
}

/** "customer:101" … of one batch, in order. */
export const batchProfiles = (profiles, batch) => profiles.filter((p) => p.n >= batch.firstCustomer && p.n < batch.firstCustomer + batch.customers);
