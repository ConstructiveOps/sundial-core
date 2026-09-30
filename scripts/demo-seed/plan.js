// plan.js — builds the whole demo plan. PURE: the same schema, anchor and seed always
// give the same plan, and nothing here talks to Salesforce, Supabase or AWS.
//
// The plan is a list of OPERATIONS in the order they must be written:
//
//   { op: "create", key, object, phase, fields }            a new record; `key` is its
//                                                          stable name ("customer:017")
//   { op: "update", key, target, object, phase, fields }    a follow-up on a record the
//                                                          plan itself created (`target`)
//
// plus the Supabase rows and the sample files. Values that only exist after a write
// (ids, auto-numbers) are markers — see tokens.js.

import { deriveHierarchyLevel } from "../../lambdas/sundial-user-admin/index.js";
import { createRng } from "./prng.js";
import { ref, authId, nameOf } from "./tokens.js";
import { OBJ, PHASES } from "./policy.js";
import { DEALERS, PERSONAS, persona, STAFF_PHONE_FROM } from "./catalog.js";
import { buildProfiles, assignPipelineStages, applyLiveDemo, customerFields } from "./plan-customers.js";
import { designSolarProjects, solarFields } from "./plan-solar.js";
import { designRoofing, roofingFields } from "./plan-roofing.js";
import { planService, priceBookOps } from "./plan-service.js";
import { planSupabase } from "./plan-supabase.js";
import { planFiles } from "./plan-files.js";

export const DEFAULT_SEED = 20260929;

const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/**
 * Picklist helper. The plan only ever writes a picklist value the org has TODAY; a value
 * that is not live is left out (and counted, so the dry run can say so) rather than sent
 * and rejected.
 */
export function createPicker(schema, missed = new Map()) {
  const miss = (sfObject, field, value) => {
    // A field the org does not have at all is reported by the preflight, not here.
    if (!schema.hasField(sfObject, field)) return;
    const id = `${sfObject}.${field} = "${value}"`;
    missed.set(id, (missed.get(id) || 0) + 1);
  };
  return {
    missed,
    /** the value if it is live, else undefined */
    one(sfObject, field, value) {
      if (value === undefined || value === null) return undefined;
      if (schema.isLive(sfObject, field, value)) return value;
      miss(sfObject, field, value);
      return undefined;
    },
    /** one of the preferred values that are live, chosen by a number */
    any(sfObject, field, preferred, n = 0) {
      const live = schema.liveSubset(sfObject, field, preferred);
      if (!live.length) {
        miss(sfObject, field, preferred.join(" / "));
        return undefined;
      }
      return live[Math.abs(n) % live.length];
    },
    /** a multi-select value: the live ones joined with ";" */
    multi(sfObject, field, values) {
      const live = values.filter((v) => schema.isLive(sfObject, field, v));
      for (const v of values) if (!live.includes(v)) miss(sfObject, field, v);
      return live.length ? live.join(";") : undefined;
    },
  };
}

function peopleOps(tenantSlug, cast) {
  const ops = [];
  ops.push({ op: "create", key: "tenant", object: OBJ.tenant, phase: "tenant", fields: { Name: tenantSlug } });
  for (const d of DEALERS) {
    ops.push({
      op: "create", key: d.key, object: OBJ.dealer, phase: "dealers",
      // Active__c defaults to FALSE in the org, and an inactive dealer's users see nothing — so it is explicit.
      fields: { Name: d.name, Client__c: ref("tenant"), Active__c: true, Is_Internal__c: d.internal },
    });
  }
  for (const p of PERSONAS) {
    ops.push({
      op: "create", key: p.key, object: OBJ.user, phase: "users",
      fields: compact({
        Name: p.name,
        First_Name__c: p.first,
        Last_Name__c: p.last,
        Email__c: p.email,
        Phone__c: cast[p.key],
        Access_Level__c: p.accessLevel,
        // Derived exactly the way the Manage Users endpoint derives it.
        Hierarchy_Level__c: deriveHierarchyLevel(p.accessLevel),
        Default_Department__c: p.department,
        Active__c: true,
        Supabase_User_Id__c: authId(p.key),
        Client__c: ref("tenant"),
        Dealer__c: p.dealer ? ref(p.dealer) : undefined,
        Super_Admin__c: p.superAdmin ? true : undefined,
        Dispatch_Board__c: p.dispatchOrder ? true : undefined,
        Dispatch_Order__c: p.dispatchOrder ?? undefined,
        Hourly_Bill_Rate__c: p.hourlyBillRate ?? undefined,
      }),
    });
  }
  return ops;
}

/**
 * @param {object} p
 *   schema       Schema (live describes, or the probe for tests / --offline)
 *   tenantSlug   "conops-demo"
 *   anchorDate   YYYY-MM-DD in Phoenix — every date in the plan hangs off it
 *   anchorNow    ISO instant of the run (decides today's picture on the dispatch board)
 *   seed         number
 *   options      { demoPhone?, demoEmail?, withSoldPendingReview? }
 */
export function buildPlan({ schema, tenantSlug, anchorDate, anchorNow, seed = DEFAULT_SEED, options = {} }) {
  const rng = createRng(seed, tenantSlug);
  const pick = createPicker(schema);
  const warnings = [];
  const ctx = { rng, schema, pick, anchorDate, anchorNow, options };

  const profiles = buildProfiles({ rng: rng.fork("customers"), schema, pick });
  assignPipelineStages(profiles, { schema });
  const solar = designSolarProjects(profiles, { rng: rng.fork("solar"), schema, anchorDate, options });
  warnings.push(...solar.warnings);
  const roofing = designRoofing(profiles, { rng: rng.fork("roofing"), schema, anchorDate });
  for (const s of roofing.stageMap) if (!s.known && s.count) warnings.push(`Roofing stage "${s.stage}" is not one this script knows; its ${s.count} job(s) are filled like a sold roofing job.`);
  // The three live-demo customers: the first opportunity waiting for a proposal, the job a
  // tech is driving to, and the first job ready to bill (the last two are picked inside
  // planService, which tells us before it builds any record).
  const pipelineDemo = profiles.find((p) => p.kind === "pipeline" && p.pipeline.stage === "Proposal Pending") ?? profiles.find((p) => p.kind === "pipeline" && p.pipeline.status === "Opportunity");
  const liveDemoKeys = [];
  const markLive = (keys) => {
    liveDemoKeys.push(...keys);
    applyLiveDemo(profiles, keys, options);
  };
  const service = planService({ profiles, rng: rng.fork("service"), schema, pick, anchorDate, anchorNow, onLiveDemo: markLive });
  if (pipelineDemo) markLive([pipelineDemo.key]);

  // Service summary on each customer that has service history (the Service > Customers board).
  summariseService(profiles, service, anchorDate);

  // --- operations, in write order ---------------------------------------------------------
  // Staff numbers: the top of the fictional range, which the customer list never uses (catalog.js).
  const phones = {};
  PERSONAS.forEach((p, i) => { phones[p.key] = `(${["602", "480", "623"][i % 3]}) 555-01${String(STAFF_PHONE_FROM + Math.floor(i / 3)).padStart(2, "0")}`; });
  const ops = [...peopleOps(tenantSlug, phones)];

  for (const p of profiles) ops.push({ op: "create", key: p.key, object: OBJ.customer, phase: "customers", fields: compact(customerFields(p, ctx)) });

  for (const p of profiles.filter((x) => x.solar)) {
    ops.push({ op: "create", key: p.solar.key, object: OBJ.solar, phase: "solar", fields: compact(solarFields(p, ctx)) });
    // Link back, the way the portal's Create Project does after it makes the project.
    ops.push({ op: "update", key: `${p.key}#solar`, target: p.key, object: OBJ.customer, phase: "solar", fields: { Linked_Solar_Project__c: ref(p.solar.key) } });
  }
  for (const p of roofing.owners) {
    ops.push({ op: "create", key: p.roofing.key, object: OBJ.roofing, phase: "roofing", fields: compact(roofingFields(p, ctx)) });
    // The customer -> roofing lookup belongs to a package that is not deployed yet (optional).
    ops.push({ op: "update", key: `${p.key}#roofing`, target: p.key, object: OBJ.customer, phase: "roofing", fields: { Linked_Roofing_Project__c: ref(p.roofing.key) } });
    // A re-roof tied to a solar project: the solar record carries the roofing job's number.
    if (p.solar) ops.push({ op: "update", key: `${p.solar.key}#roofing`, target: p.solar.key, object: OBJ.solar, phase: "roofing", fields: { Roofing_Job_Number__c: nameOf(p.roofing.key) } });
  }
  ops.push(...priceBookOps());
  ops.push(...service.ops);

  for (const [what, count] of pick.missed) warnings.push(`Picklist value not live, left blank on ${count} record(s): ${what}`);

  const supabase = planSupabase({ profiles, service, anchorDate, tenantSlug, rng: rng.fork("supabase"), liveDemoKeys });
  const files = planFiles({ profiles, service });

  const plan = {
    meta: {
      tenantSlug, anchorDate, anchorNow, demoNow: service.demoNow, seed,
      options: { demoPhone: options.demoPhone ?? null, demoEmail: options.demoEmail ?? null, withSoldPendingReview: !!options.withSoldPendingReview },
      liveDemo: liveDemoKeys.map((k) => {
        const p = profiles.find((x) => x.key === k);
        return { key: k, name: p.person.name, what: p.kind === "pipeline" ? `sales opportunity (${p.pipeline.stage})` : "service customer" };
      }),
      // The one customer + project that --with-sold-pending-review is about (plan-solar.js).
      soldPendingReview: solar.gated,
    },
    ops,
    supabase,
    files,
    warnings,
    solarStageMap: solar.stageMap,
    roofingStageMap: roofing.stageMap,
  };
  // Models the tests (and --freshen) look at. Not part of plan.json.
  Object.defineProperty(plan, "models", { value: { profiles, service, roofing }, enumerable: false });
  return plan;
}

/** What the Service > Customers board shows for a customer, from their latest estimate / job. */
function summariseService(profiles, service, anchorDate) {
  const byCustomer = new Map();
  for (const est of service.estimates) {
    if (!byCustomer.has(est.profileKey)) byCustomer.set(est.profileKey, []);
    byCustomer.get(est.profileKey).push(est);
  }
  const dayOf = (iso) => (iso ? iso.slice(0, 10) : null);
  for (const p of profiles) {
    const ests = byCustomer.get(p.key);
    if (p.kind === "service" && !ests) {
      // The five service customers who have only called in so far.
      const i = p.n % 5;
      const stage = ["New", "Contact Attempt Made", "New", "Contact Attempt Made", "Waiting on Customer"][i];
      p.service = {
        stage, jobs: [],
        requestType: ["System Not Producing", "Monitoring Offline", "Warranty Question", "General Question", "Billing or Finance Question"][i],
        description: ["Says production dropped sharply last week. Wants someone to look.", "App shows offline. Not sure how long.", "Asking whether the inverter is still under warranty.", "New owner of the house, wants to know what the system is.", "Asked for a copy of last year's service invoice."][i],
        nextFollowUp: stage === "New" ? null : anchorDate,
        lastContact: stage === "New" ? null : dayOf(new Date(Date.parse(`${anchorDate}T12:00:00Z`) - 86400000).toISOString()),
      };
      continue;
    }
    if (!ests) continue;
    const latest = ests[ests.length - 1];
    const job = latest.jobKey ? service.jobs.find((j) => j.key === latest.jobKey) : null;
    const jobs = ests.filter((e) => e.jobKey).map((e) => e.jobKey);
    let stage;
    let resolution = null;
    let resolvedDate = null;
    if (!job) {
      stage = latest.status === "Draft" ? "Estimate Created" : latest.status === "Sent" ? "Waiting on Customer" : "Closed";
      if (stage === "Closed") { resolution = latest.status === "Declined" ? "Not Interested" : "No Response"; resolvedDate = anchorDate; }
    } else if (["Paid", "Closed"].includes(job.status)) {
      stage = job.status === "Closed" ? "Closed" : "Resolved";
      resolution = "Job Created";
      resolvedDate = dayOf(job.invoice?.paidAt ?? job.statusChangedAt);
    } else if (job.status === "Awaiting Parts") stage = "Waiting on Other Department";
    else if (["New", "Triaging", "Remote Investigation"].includes(job.status)) stage = "Estimate Created";
    else stage = "In Progress";
    p.service = {
      stage, jobs, resolution, resolvedDate,
      requestType: latest.scenario.requestType,
      description: latest.scenario.issue,
      nextFollowUp: stage === "Waiting on Customer" ? anchorDate : null,
      lastContact: dayOf(latest.times.sentAt ?? latest.times.createdAt),
    };
  }
}

/** Counts for the summary table: records per object, per stage / status. */
export function summarisePlan(plan) {
  const perObject = new Map();
  const breakdown = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const o of plan.ops) {
    if (o.op !== "create") continue;
    bump(perObject, o.object);
    const by = o.object === OBJ.customer ? `${o.fields.Status__c ?? "(none)"} / ${o.fields.Stage__c ?? "(no stage)"}`
      : o.fields.Stage__c ?? o.fields.Status__c ?? null;
    if (by && [OBJ.customer, OBJ.solar, OBJ.roofing, OBJ.estimate, OBJ.job, OBJ.call, OBJ.invoice].includes(o.object)) {
      if (!breakdown.has(o.object)) breakdown.set(o.object, new Map());
      bump(breakdown.get(o.object), by);
    }
  }
  return {
    perObject: Object.fromEntries(perObject),
    breakdown: Object.fromEntries([...breakdown].map(([k, v]) => [k, Object.fromEntries(v)])),
    updates: plan.ops.filter((o) => o.op === "update").length,
    // How many records are read back in full (set by the preflight; zero before it).
    canaries: {
      total: plan.ops.filter((o) => o.canary).length,
      customer: plan.ops.filter((o) => o.canary && o.object === OBJ.customer).length,
      solar: plan.ops.filter((o) => o.canary && o.object === OBJ.solar).length,
    },
    supabase: Object.fromEntries(Object.entries(plan.supabase).map(([k, v]) => [k, v.length])),
    files: plan.files.length,
    phases: PHASES,
  };
}

export { persona };
