// The demo PLAN, checked offline: what it contains, that it breaks none of the seed's safety
// rules, and that every record is internally consistent. Nothing here talks to anything.
//
//   node --experimental-test-module-mocks --test scripts/demo-seed/plan.test.js scripts/demo-seed/run.test.js scripts/demo-seed/freshen.test.js
//   (the file-list form: on Node 22 `node --test <folder>` does not run the folder's tests)

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTotals, lineFromRecord, estimateFromRecord } from "../../lambdas/sundial-service-estimate/totals.js";
import { parseIntervals, clockFields, liveIntervals, openIntervalIndex } from "../../lambdas/sundial-service-board/tech.js";
import { parseDayLog, dayFields } from "../../lambdas/sundial-service-board/day.js";
import { loadProbe, planFor, ANCHORS, creates, byKey } from "./test-helpers.js";
import { lintPlan, naturalKeyClashes } from "./preflight.js";
import { OBJ, FORBIDDEN_OBJECTS, isForbiddenField, FAKE_PHONE_RE, FAKE_EMAIL_RE, OWNER_EMAIL_RE } from "./policy.js";
import { replayJobStatus, OPEN_CALL_STATUSES, UNSCHEDULED_JOB_STATUSES } from "./plan-service.js";
import { phxMinutesOf, phxDateOf, addDays, isWeekday } from "./dates.js";
import { TECH_KEYS, PERSONAS } from "./catalog.js";
import { BUDGET_RATES, ADDERS } from "./budget-rates.js";
import { CATEGORIES, OFFICE_CATEGORIES } from "../../lib/notify.js";
import { canaryTags, packFields, readRecordInFull, CANARY_URI_CHARS, SOQL_HARD_LIMIT } from "./canary.js";
import { parseArgs } from "./args.js";
import { SEEDED_OBJECTS } from "./policy.js";
import { schemaFromProbe } from "./schema.js";

const probe = loadProbe();
const countBy = (list, f) => list.reduce((m, x) => m.set(f(x), (m.get(f(x)) || 0) + 1), new Map());

test("(a) the full plan passes the preflight against the captured org metadata — on every anchor", () => {
  for (const anchor of ANCHORS) {
    const { pre, plan } = planFor(anchor);
    assert.deepEqual(pre.errors, [], `${anchor.label}: preflight errors`);
    assert.deepEqual(lintPlan(plan), [], `${anchor.label}: safety lint`);
    assert.deepEqual(naturalKeyClashes(pre.ops), [], `${anchor.label}: natural keys`);
    // The only fields dropped are the ones of packages that are not deployed yet.
    for (const w of pre.warnings) assert.match(w, /Sundial_Roofing__c\.(Deposit_|Notes__c)|Linked_Roofing_Project__c/, `${anchor.label}: unexpected drop — ${w}`);
  }
});

test("(h) the plan is deterministic: same seed and anchor give the identical plan, a different seed does not", () => {
  const a = planFor(ANCHORS[0]);
  const b = planFor(ANCHORS[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(a.plan)), JSON.parse(JSON.stringify(b.plan)));
  assert.deepEqual(a.ops, b.ops);
  const c = planFor(ANCHORS[0], { seed: 7 });
  assert.notDeepEqual(JSON.parse(JSON.stringify(a.plan.ops)), JSON.parse(JSON.stringify(c.plan.ops)));
});

test("the plan holds the intended records", () => {
  for (const anchor of ANCHORS) {
    const { ops, plan } = planFor(anchor);
    const n = (o) => creates(ops, o).length;
    assert.equal(n(OBJ.tenant), 1);
    assert.equal(n(OBJ.dealer), 3);
    assert.equal(n(OBJ.user), 11);
    assert.equal(n(OBJ.customer), 100);
    assert.equal(n(OBJ.solar), 50);
    assert.equal(n(OBJ.roofing), 10);
    assert.equal(n(OBJ.item), 28);
    assert.equal(n(OBJ.job), 45);
    assert.equal(n(OBJ.estimate), 51);

    // Solar: every one of the live stages at least once — except "Sold - Pending Review",
    // which is only used when asked for (33 of 34 without the flag, 34 of 34 with it).
    const solarStages = countBy(creates(ops, OBJ.solar), (o) => o.fields.Stage__c);
    for (const stage of probe.salesforce.Sundial_Solar__c.fields.Stage__c.values) {
      if (stage === "Sold - Pending Review") assert.equal(solarStages.get(stage), undefined, `${anchor.label}: a project sits in "${stage}" without the opt-in`);
      else assert.ok(solarStages.get(stage) >= 1, `${anchor.label}: no solar project in "${stage}"`);
    }
    assert.equal(solarStages.size, 33);
    assert.equal(plan.solarStageMap.filter((x) => x.count).length, 33);
    assert.equal(plan.solarStageMap.length, 34);
    const gated = plan.meta.soldPendingReview;
    assert.deepEqual({ stage: gated.stage, used: gated.used, movedTo: gated.movedTo }, { stage: "Sold - Pending Review", used: false, movedTo: "Audit" });
    assert.equal(byKey(ops).get(gated.solarKey).fields.Stage__c, "Audit");
    assert.equal(byKey(ops).get(gated.customerKey).fields.Stage__c, "Processing Documents");
    assert.equal(solarStages.get("Audit"), 2, "the moved project joins the one already in Audit");
    const withFlag = planFor(anchor, { options: { withSoldPendingReview: true } });
    const flagStages = countBy(creates(withFlag.ops, OBJ.solar), (o) => o.fields.Stage__c);
    assert.equal(flagStages.size, 34, `${anchor.label}: 34 of 34 with --with-sold-pending-review`);
    assert.equal(flagStages.get("Sold - Pending Review"), 1);
    assert.equal(withFlag.plan.meta.soldPendingReview.used, true);
    assert.deepEqual([withFlag.plan.meta.soldPendingReview.customerKey, withFlag.plan.meta.soldPendingReview.solarKey], [gated.customerKey, gated.solarKey], "the same customer and project either way");

    // Jobs: all twelve statuses. Estimates: all seven (Template is not a real estimate).
    const jobStatuses = countBy(creates(ops, OBJ.job), (o) => o.fields.Status__c);
    for (const s of probe.salesforce.Sundial_Service_Job__c.fields.Status__c.values) assert.ok(jobStatuses.get(s) >= 1, `no job in "${s}"`);
    const estStatuses = countBy(creates(ops, OBJ.estimate), (o) => o.fields.Status__c);
    for (const s of ["Draft", "Sent", "Viewed", "Approved", "Declined", "Expired", "Invoiced"]) assert.ok(estStatuses.get(s) >= 1, `no estimate "${s}"`);
    const jobless = creates(ops, OBJ.estimate).filter((e) => !ops.some((o) => o.op === "update" && o.target === e.key && o.fields.Service_Job__c));
    assert.deepEqual([...countBy(jobless, (o) => o.fields.Status__c)].sort(), [["Declined", 1], ["Draft", 2], ["Expired", 1], ["Sent", 2]]);
    // Every job has exactly one estimate, and every estimate 2–6 lines.
    const jobEstimates = creates(ops, OBJ.job).map((j) => j.fields.Estimate__c.$ref);
    assert.equal(new Set(jobEstimates).size, 45);
    for (const e of creates(ops, OBJ.estimate)) {
      const lines = creates(ops, OBJ.line).filter((l) => l.fields.Estimate__c.$ref === e.key);
      assert.ok(lines.length >= 2 && lines.length <= 6, `${e.key} has ${lines.length} lines`);
    }

    // Customers: the mix.
    const customers = creates(ops, OBJ.customer);
    const type = (c) => c.fields.Customer_Type__c;
    assert.equal(customers.filter((c) => type(c).split(";").includes("Solar") && c.fields.Status__c !== "Lead" && c.fields.Status__c !== "Opportunity").length, 50);
    assert.equal(customers.filter((c) => ["Lead", "Opportunity"].includes(c.fields.Status__c) && type(c) === "Solar").length, 22);
    assert.equal(customers.filter((c) => type(c).split(";").includes("Roofing")).length, 10);
    assert.equal(customers.filter((c) => type(c) === "Solar;Roofing" || type(c) === "Solar;Roofing;Service").length, 3);
    assert.equal(customers.filter((c) => type(c) === "Service").length, 21);
    assert.ok(customers.some((c) => type(c) === "Solar;Service"), "some solar customers also have service history");
    // The pipeline covers every live Lead and Opportunity stage.
    const dep = probe.salesforce.Sundial_Customer__c.fields.Stage__c.dependentValues;
    for (const status of ["Lead", "Opportunity"]) for (const stage of dep[status]) {
      assert.ok(customers.some((c) => c.fields.Status__c === status && c.fields.Stage__c === stage && type(c) === "Solar"), `no pipeline customer at ${status} / ${stage}`);
    }
    // Service-only customers cover all eight service stages.
    const serviceStages = new Set(customers.filter((c) => type(c) === "Service").map((c) => c.fields.Service_Stage__c));
    for (const s of probe.salesforce.Sundial_Customer__c.fields.Service_Stage__c.values) assert.ok(serviceStages.has(s), `${anchor.label}: no service-only customer at "${s}"`);

    // Roofing follows the live stage list (one placeholder value today).
    const roofStages = new Set(creates(ops, OBJ.roofing).map((r) => r.fields.Stage__c));
    for (const s of roofStages) assert.ok(probe.salesforce.Sundial_Roofing__c.fields.Stage__c.values.includes(s));

    // Users: the eleven personas, techs on the dispatch board in order.
    const users = creates(ops, OBJ.user);
    assert.deepEqual(users.map((u) => u.fields.Email__c), PERSONAS.map((p) => p.email));
    assert.deepEqual(users.filter((u) => u.fields.Dispatch_Board__c).map((u) => u.fields.Dispatch_Order__c), [1, 2, 3]);
    assert.equal(users.filter((u) => u.fields.Super_Admin__c === true).length, 1);
    for (const u of users) {
      const want = { "Sales Rep": "Sales Rep", "Sales Dealer": "Sales Manager" }[u.fields.Access_Level__c] ?? "Client";
      assert.equal(u.fields.Hierarchy_Level__c, want);
      if (["Sales Rep", "Sales Dealer"].includes(u.fields.Access_Level__c)) assert.ok(u.fields.Dealer__c?.$ref, `${u.key} is a sales user without a dealer`);
    }
    assert.equal(plan.meta.liveDemo.length, 3);
  }
});

test("(c) safety: tenant stamp, forbidden objects and fields, fictional contact details", () => {
  for (const anchor of ANCHORS.slice(0, 3)) {
    const { ops, plan } = planFor(anchor);
    for (const op of ops) {
      assert.ok(!FORBIDDEN_OBJECTS.includes(op.object), `${op.key} writes ${op.object}`);
      for (const f of Object.keys(op.fields)) {
        assert.ok(!isForbiddenField(op.object, f), `${op.key} writes ${f}`);
        assert.ok(!/HCP_Id|Acumatica|Aurora|Sunbase|Dropbox|Stripe/i.test(f), `${op.key} writes ${f}`);
      }
      if (op.op === "create" && op.object !== OBJ.tenant) assert.deepEqual(op.fields.Client__c, { $ref: "tenant" }, `${op.key} is not stamped with the demo tenant`);
      // Every update targets a record the plan itself creates.
      if (op.op === "update") assert.ok(ops.some((o) => o.op === "create" && o.key === op.target && o.object === op.object), `${op.key} targets ${op.target}`);
    }
    // Phones and emails on the records themselves.
    const schema = probe.salesforce;
    for (const op of ops) {
      for (const [f, v] of Object.entries(op.fields)) {
        const def = schema[op.object].fields[f];
        if (def.type === "phone") assert.match(v, FAKE_PHONE_RE, `${op.key}.${f}`);
        if (def.type === "email") assert.ok(FAKE_EMAIL_RE.test(v) || (op.object === OBJ.user && OWNER_EMAIL_RE.test(v)), `${op.key}.${f} = ${v}`);
      }
    }
    // Sold customers can never be phoned by the welcome-call automation.
    for (const c of creates(ops, OBJ.customer)) {
      if (["Customer", "Past Customer"].includes(c.fields.Status__c)) assert.equal(c.fields.Welcome_Call_Status__c, "Verified", c.key);
    }
    // The stage Harmon's Salesforce alerts fire on is not used unless asked for — on the
    // customer OR on the solar project.
    assert.ok(!creates(ops, OBJ.customer).some((c) => c.fields.Stage__c === "Sold - Pending Review"));
    assert.ok(!creates(ops, OBJ.solar).some((c) => c.fields.Stage__c === "Sold - Pending Review"));
    assert.ok(!ops.some((o) => Object.values(o.fields).includes("Sold - Pending Review")), "no operation at all writes that stage");
    // Supabase rows all carry the tenant, and nothing is planned for comment_mentions.
    assert.ok(!("comment_mentions" in plan.supabase) && !("mentions" in plan.supabase));
    for (const [table, rows] of Object.entries(plan.supabase)) {
      for (const r of rows) assert.deepEqual(r.client_sf_id ?? r.tenant_id, { $ref: "tenant" }, `${table} row without the tenant`);
    }
    for (const r of plan.supabase.sms) assert.match(r.provider_sid, /^DEMO-/);
    assert.equal(new Set(plan.supabase.sms.map((r) => r.provider_sid)).size, plan.supabase.sms.length);
    assert.equal(new Set(plan.supabase.comments.map((r) => r.id)).size, plan.supabase.comments.length);
    const act = plan.supabase.activity.map((r) => `${r.record_sf_id.$ref}|${r.event}|${r.at}`);
    assert.equal(new Set(act).size, act.length, "activity rows must be tell-apart-able for the idempotent insert");
  }
});

test("--demo-phone / --demo-email land on exactly the three live-demo customers and their snapshots", () => {
  const options = { demoPhone: "+16025550199", demoEmail: "owner@example.org" };
  const { ops, plan, pre } = planFor(ANCHORS[0], { options });
  assert.deepEqual(pre.errors, []);
  assert.deepEqual(lintPlan(plan), []);
  const live = creates(ops, OBJ.customer).filter((c) => c.fields.Primary_Phone__c === options.demoPhone);
  assert.equal(live.length, 3);
  assert.deepEqual(live.map((c) => c.key).sort(), plan.meta.liveDemo.map((d) => d.key).sort());
  for (const c of live) {
    assert.equal(c.fields.Primary_Email__c, options.demoEmail);
    // None of them is a customer at a sold solar stage.
    assert.ok(!["Sold", "Sold - Installed", "Sold - Pending Review", "Sold - Final Review"].includes(c.fields.Stage__c ?? ""), `${c.key} is at ${c.fields.Stage__c}`);
  }
  const keys = new Set(live.map((c) => c.key));
  for (const o of [...creates(ops, OBJ.job), ...creates(ops, OBJ.estimate)]) {
    const mine = keys.has(o.fields.Sundial_Customer__c.$ref);
    assert.equal(o.fields.Primary_Phone_at_Creation__c === options.demoPhone, mine, `${o.key} snapshot`);
  }
  // No canned text thread sits on a live-demo customer's job.
  for (const r of plan.supabase.sms) assert.ok(!keys.has(r.customer_sf_id.$ref));
  // Without the flags the same three get fake details like everyone else.
  const plain = planFor(ANCHORS[0]);
  assert.deepEqual(plain.plan.meta.liveDemo.map((d) => d.key), plan.meta.liveDemo.map((d) => d.key));
});

test("(d) customers: status and stage respect the org's dependent picklist", () => {
  const { ops } = planFor(ANCHORS[0], { options: { withSoldPendingReview: true } });
  const dep = probe.salesforce.Sundial_Customer__c.fields.Stage__c.dependentValues;
  for (const c of creates(ops, OBJ.customer)) {
    if (c.fields.Stage__c) assert.ok(dep[c.fields.Status__c].includes(c.fields.Stage__c), `${c.key}: ${c.fields.Status__c} / ${c.fields.Stage__c}`);
  }
  assert.ok(creates(ops, OBJ.customer).some((c) => c.fields.Stage__c === "Sold - Pending Review"), "--with-sold-pending-review uses the real stage");
  assert.equal(creates(ops, OBJ.solar).filter((c) => c.fields.Stage__c === "Sold - Pending Review").length, 1, "…on the one solar project too");
});

test("--with-sold-pending-review changes exactly one customer and one project — every other record is identical", () => {
  for (const anchor of ANCHORS.slice(0, 3)) {
    const plain = planFor(anchor);
    const flagged = planFor(anchor, { options: { withSoldPendingReview: true } });
    const g = plain.plan.meta.soldPendingReview;
    assert.deepEqual(plain.ops.map((o) => `${o.op}:${o.key}`), flagged.ops.map((o) => `${o.op}:${o.key}`), "the same operations, in the same order");
    // (`canary` is left out: which project is the FIRST in "Audit" does change.)
    const other = (ops) => ops.filter((o) => ![g.customerKey, g.solarKey].includes(o.key)).map(({ canary, ...rest }) => rest);
    assert.deepEqual(other(plain.ops), other(flagged.ops), `${anchor.label}: a record other than ${g.customerKey} / ${g.solarKey} differs`);
    assert.equal(byKey(flagged.ops).get(g.solarKey).fields.Stage__c, "Sold - Pending Review");
    assert.equal(byKey(flagged.ops).get(g.customerKey).fields.Stage__c, "Sold - Pending Review");
  }
});

// --- Solar ---------------------------------------------------------------------------------
// These sets are written out independently of plan-solar.js on purpose: they are the test's
// own statement of "which stages may carry this field".
const PIPELINE = probe.salesforce.Sundial_Solar__c.fields.Stage__c.values;
const from = (stage) => PIPELINE.slice(PIPELINE.indexOf(stage), PIPELINE.indexOf("Hold"));
const ALLOWED = {
  Permit_Applied_Date__c: [...from("Permit Submitted"), "Hold"],
  Permit_Received__c: from("Permitting Received"),
  Utility_Application_Submitted_Date__c: from("Interconnection Submitted"),
  Utility_Application_Approved_Date__c: from("Scheduling"),
  Scheduled_Install_Date__c: from("Install Scheduled"),
  Install_Complete__c: from("Post Installation"),
  Install_End_DateTime__c: from("Post Installation"),
  Inspection_Pass_Date__c: ["Green Tagged", "Awaiting Bird Blocking", "Billing", "Billing Complete - Pending Closeout", "Request to Archive", "Archive"],
  Commission_of_System__c: ["Billing", "Billing Complete - Pending Closeout", "Request to Archive", "Archive"],
  Final_Payment_Received_Date__c: ["Billing Complete - Pending Closeout", "Request to Archive", "Archive"],
  Close_Date__c: ["Archive"],
  Project_on_Hold__c: ["Hold"],
  Project_Cancelled__c: ["Cancelled - Awaiting Sales to Resell", "Cancelled"],
  Go_Back_Needed__c: ["Go Back Items Needed", "Go Back Items Complete"],
  Go_Back_Completed__c: ["Go Back Items Complete"],
};
const MAY_BE_FUTURE = new Set([
  "Audit_Scheduled_Date__c", "Audit_Scheduled__c", "Audit_Date_and_DateTime__c", "Expected_Design_Complete_Date__c", "Tentative_Install_Date__c",
  "Scheduled_Install_Date__c", "Estimated_Install_Complete_Date__c", "Final_Inspection_Date__c", "Credit_Expiration_Date__c",
  "Next_Customer_Update_Date__c", "Service_Entrance_Section_Upgrade_Date__c",
]);
const CHAIN = [
  "Contract_Date__c", "Project_Kickoff_Date_Job__c", "Audit_Date__c", "Audit_Photos_Received__c", "Audit_Finalized_and_Complete__c",
  "Approved_for_Design_Date__c", "Design_Internal_Review__c", "Design_Internal_Review_Completed__c", "Plan_Set_Ready_for_Project_Manager__c",
  "Project_Manager_Reviewed_Plans_and__c", "Homeowner_Approved_Plans__c", "Approved_for_Permitting__c", "Permit_Applied_Date__c",
  "Permit_Received__c", "Utility_Application_Submitted_Date__c", "Utility_Application_Approved_Date__c", "Install_Complete__c",
  "Inspection_Pass_Date__c", "Final_Documents_Uploaded_to_Utility__c", "Meter_Set_Requested_Notification__c", "Commission_of_System__c",
  "Final_Payment_50_Invoiced__c", "Final_Payment_Received_Date__c", "Closeout_Documents_Sent_to_Homeowner__c", "Close_Date__c",
];

test("(d) solar: a project only carries the fields of the stages it has reached, in a believable order", () => {
  for (const anchor of ANCHORS) {
    const { ops } = planFor(anchor);
    const defs = probe.salesforce.Sundial_Solar__c.fields;
    const customers = byKey(ops);
    for (const s of creates(ops, OBJ.solar)) {
      const f = s.fields;
      for (const [field, stages] of Object.entries(ALLOWED)) {
        if (f[field] !== undefined) assert.ok(stages.includes(f.Stage__c), `${anchor.label} ${s.key}: ${field} is set at stage "${f.Stage__c}"`);
      }
      // Nothing dated in the future, except what is a booking.
      for (const [field, v] of Object.entries(f)) {
        const t = defs[field].type;
        if (t !== "date" && t !== "datetime") continue;
        const day = t === "date" ? v : phxDateOf(v);
        if (!MAY_BE_FUTURE.has(field)) assert.ok(day <= anchor.date, `${anchor.label} ${s.key}: ${field} = ${v} is after the anchor`);
      }
      // The milestones that exist are in order.
      const present = CHAIN.filter((c) => f[c] !== undefined);
      for (let i = 1; i < present.length; i++) assert.ok(f[present[i - 1]] <= f[present[i]], `${anchor.label} ${s.key}: ${present[i - 1]} (${f[present[i - 1]]}) is after ${present[i]} (${f[present[i]]})`);
      // System and money are coherent.
      assert.ok(f.System_Size__c >= 4.8 && f.System_Size__c <= 14.4, `${s.key} size ${f.System_Size__c}`);
      assert.ok(f.Price_per_Watt__c >= 2.6 && f.Price_per_Watt__c <= 3.4);
      assert.equal(Math.round(f.System_Size__c * 1000), f.Number_of_Panels__c * f.Module_STC_Wattage__c, `${s.key}: size = panels x wattage`);
      assert.ok(f.Contract_Amount__c >= f.Price_per_Watt__c * f.System_Size__c * 1000 - 0.01);
      // Commission formula (contract - 1.85 x watts - adders) must come out positive.
      assert.ok(f.Contract_Amount__c - 1.85 * f.System_Size__c * 1000 > 0);
      // The four snapshots match the customer.
      const c = customers.get(f.Sundial_Customer__c.$ref).fields;
      assert.equal(f.Customer_Name_at_Creation__c, c.Name);
      assert.equal(f.Primary_Phone_at_Creation__c, c.Primary_Phone__c);
      assert.equal(f.Primary_Email_at_Creation__c, c.Primary_Email__c);
      assert.ok(f.Address_at_Creation__c.startsWith(c.Street__c) && f.Address_at_Creation__c.includes(c.City__c) && f.Address_at_Creation__c.endsWith(c.Postal_Code__c));
      // Sales attribution: the rep, the rep's dealer, and the matching names.
      assert.deepEqual(f.Sales_Rep__c, c.Sales_Rep__c);
      assert.deepEqual(f.Dealer__c, c.Dealer__c);
      const rep = PERSONAS.find((p) => p.key === f.Sales_Rep__c.$ref);
      assert.equal(f.Dealer__c.$ref, rep.dealer);
      assert.equal(f.Sales_Representative__c, rep.name);
      // Budget: every input rate is the invented one; no output field is written.
      for (const [k, v] of Object.entries(BUDGET_RATES)) assert.equal(f[k], v, `${s.key}.${k}`);
      for (const a of ADDERS) assert.equal(f[`Adder_${a.base}_Price__c`], a.price);
      for (const out of ["Budget_Calc_Status__c", "Total_Job_Cost__c", "Total_Labor_Budget__c", "GP_Dollars__c", "Commission_Deal_Type__c", "System_Size_Watts__c"]) assert.equal(f[out], undefined, `${s.key} writes the budget output ${out}`);
      // The customer's status and stage follow the project.
      const stage = f.Stage__c;
      if (stage === "Archive") assert.deepEqual([c.Status__c, c.Stage__c], ["Past Customer", "Sold - Archived"]);
      else if (/^Cancelled/.test(stage)) assert.equal(c.Stage__c, "Cancelled");
      else if (ALLOWED.Install_Complete__c.includes(stage)) assert.equal(c.Stage__c, "Sold - Installed");
      assert.ok(ops.some((o) => o.op === "update" && o.target === f.Sundial_Customer__c.$ref && o.fields.Linked_Solar_Project__c?.$ref === s.key), `${s.key}: customer is not linked back`);
    }
    // "Install Scheduled": sold about two months ago, installing in the next two weeks.
    for (const s of creates(ops, OBJ.solar).filter((x) => x.fields.Stage__c === "Install Scheduled")) {
      const soldDaysAgo = (Date.parse(anchor.date) - Date.parse(s.fields.Contract_Date__c)) / 86400000;
      assert.ok(soldDaysAgo >= 28 && soldDaysAgo <= 95, `${s.key} sold ${soldDaysAgo} days ago`);
      assert.ok(s.fields.Scheduled_Install_Date__c > anchor.date && s.fields.Scheduled_Install_Date__c <= addDays(anchor.date, 14));
    }
  }
});

// --- Service -------------------------------------------------------------------------------
test("(d) estimates: stored totals are exactly what the estimate Lambda's computeTotals gives", () => {
  for (const anchor of ANCHORS.slice(0, 2)) {
    const { ops } = planFor(anchor);
    for (const e of creates(ops, OBJ.estimate)) {
      const lines = creates(ops, OBJ.line).filter((l) => l.fields.Estimate__c.$ref === e.key).map((l) => l.fields);
      const t = computeTotals(lines.map(lineFromRecord), estimateFromRecord(e.fields));
      for (const [k, v] of Object.entries(t.fields)) assert.equal(e.fields[k], v, `${e.key}.${k}`);
      // And by plain arithmetic, independent of the Lambda.
      const live = lines.filter((l) => l.Stage__c !== "Removed");
      const sub = Math.round(live.reduce((s, l) => s + Math.round(l.Quantity__c * l.Unit_Price__c * 100) / 100, 0) * 100) / 100;
      assert.equal(e.fields.Subtotal__c, sub, `${e.key} subtotal`);
      assert.ok(Math.abs(e.fields.Total__c - (sub - e.fields.Discount_Amount__c + e.fields.Markup_Amount__c + e.fields.Tax_Amount__c)) < 0.011, `${e.key} total`);
      assert.ok(e.fields.Total__c > 0);
      // A sent estimate has a version log in the Lambda's shape; a draft has none.
      if (e.fields.Status__c === "Draft") {
        assert.equal(e.fields.Version__c, 0);
        assert.equal(e.fields.Version_Log__c, undefined);
      } else {
        const log = e.fields.Version_Log__c.$json;
        assert.equal(log.length, e.fields.Version__c);
        for (const entry of log) assert.deepEqual(Object.keys(entry), ["version", "sentAt", "sentBy", "sentVia", "total", "lines", "pdfKey"]);
        assert.equal(log[log.length - 1].total, e.fields.Total__c);
        for (const l of log[0].lines) assert.deepEqual(Object.keys(l), ["itemId", "desc", "qty", "unitPrice", "kind", "stage"]);
      }
      if (["Approved", "Invoiced"].includes(e.fields.Status__c)) {
        assert.equal(e.fields.Approved_Amount__c, e.fields.Total__c);
        assert.ok(live.every((l) => l.Stage__c === "Approved"));
      }
    }
  }
});

test("(d) jobs follow their calls (settleJobStatus), and the money settles the way settleMoney does", () => {
  for (const anchor of ANCHORS) {
    const { plan, ops } = planFor(anchor);
    const { service } = plan.models;
    for (const job of service.jobs) {
      const label = `${anchor.label} ${job.key} (${job.status})`;
      // The status the calls imply (plus the office's own steps) is the status that is WRITTEN
      // on the record (the operation's own field, not just the planner's note of it).
      const written = creates(ops, OBJ.job).find((o) => o.key === job.key).fields.Status__c;
      assert.equal(written, job.status, `${label}: written status`);
      assert.equal(replayJobStatus("New", job.calls, job.officeSteps), written, label);
      for (const c of job.calls) assert.equal(creates(ops, OBJ.call).find((o) => o.key === c.key).fields.Sundial_Service_Job__c.$ref, job.key);
      const statuses = job.calls.map((c) => c.fields.Status__c);
      const open = statuses.filter((s) => OPEN_CALL_STATUSES.includes(s)).length;
      const complete = statuses.filter((s) => s === "Complete").length;
      if (UNSCHEDULED_JOB_STATUSES.includes(job.status)) assert.equal(open, 0, `${label}: an unscheduled job has an open call`);
      if (job.status === "Scheduled") { assert.ok(open >= 1, label); assert.equal(complete, 0, label); assert.ok(!statuses.includes("In Progress"), label); }
      if (job.status === "In Progress") assert.ok(statuses.includes("In Progress") || (complete >= 1 && open >= 1), label);
      if (["Awaiting Office Review", "Ready to Bill", "Invoiced", "Paid", "Closed"].includes(job.status)) { assert.equal(open, 0, label); assert.ok(complete >= 1, label); }

      // Money.
      const payments = creates(ops, OBJ.payment).filter((p) => p.fields.Service_Job__c.$ref === job.key).map((p) => p.fields);
      const invoice = creates(ops, OBJ.invoice).find((i) => i.fields.Service_Job__c.$ref === job.key)?.fields ?? null;
      const received = payments.reduce((s, p) => s + (p.Type__c === "Refund" ? -p.Amount__c : p.Amount__c), 0);
      const paid = Math.round(received * 100) / 100;
      assert.ok(payments.every((p) => p.Amount__c > 0 && p.Status__c === "Succeeded" && !Object.keys(p).some((k) => /Stripe/.test(k))), label);
      assert.equal(!!invoice, ["Invoiced", "Paid", "Closed"].includes(job.status), `${label}: invoice presence`);
      const est = job.estimate.fields;
      if (invoice) {
        assert.deepEqual(invoice.Name, { $name: job.key }, "the invoice is named after the job number");
        for (const k of ["Subtotal__c", "Discount_Amount__c", "Tax_Amount__c", "Total__c", "Tax_Rate__c"]) assert.equal(invoice[k], est[k], `${label}: invoice ${k} is frozen from the estimate`);
        assert.equal(est.Status__c, "Invoiced");
        assert.equal(invoice.Paid_Amount__c, paid, `${label}: paid amount = sum of payments`);
        const balance = Math.round((invoice.Total__c - invoice.Paid_Amount__c) * 100) / 100;
        assert.ok(balance >= 0, `${label}: balance ${balance}`);
        const want = balance === 0 ? "Paid" : paid > 0 ? "Partially Paid" : invoice.Sent_At__c ? "Sent" : "Issued";
        assert.equal(invoice.Status__c, want, label);
        assert.equal(!!invoice.Paid_At__c, want === "Paid", label);
        assert.equal(job.fields.Payment_Status__c, balance === 0 ? "Paid" : paid > 0 ? "Partially Paid" : "None", label);
        assert.equal(job.status === "Paid" || job.status === "Closed", want === "Paid", `${label}: a job is Paid exactly when its invoice is`);
        for (const p of payments) assert.deepEqual(p.Invoice__c, { $ref: job.invoice.key }, "money on an invoiced job belongs to the invoice");
        // Issued after the work, paid after it was issued.
        const lastOut = job.calls.filter((c) => c.actualEnd).map((c) => c.actualEnd).sort().pop();
        assert.ok(invoice.Issued_At__c > lastOut, `${label}: invoiced before the work was finished`);
        for (const p of payments.filter((x) => x.Type__c !== "Deposit")) assert.ok(p.Received_At__c > invoice.Issued_At__c, label);
      } else {
        assert.ok(payments.every((p) => p.Type__c === "Deposit" && p.Invoice__c === undefined), label);
        assert.equal(job.fields.Payment_Status__c, paid > 0 ? "Deposit Paid" : "None", label);
        if (paid > 0) assert.equal(paid, est.Deposit_Amount__c, `${label}: the deposit taken is the deposit asked for`);
      }
      // Nothing about the job is dated after "now".
      for (const v of [job.fields.Intake_Date__c, job.fields.Status_Changed_At__c, est.Last_Sent_At__c, est.Approved_At__c, invoice?.Issued_At__c, invoice?.Paid_At__c, ...payments.map((p) => p.Received_At__c)]) {
        if (v) assert.ok(v <= service.demoNow, `${label}: ${v} is after ${service.demoNow}`);
      }
      // One payer per job; the snapshots are the customer's.
      const c = byKey(ops).get(job.fields.Sundial_Customer__c.$ref).fields;
      assert.equal(job.fields.Customer_Name_at_Creation__c, c.Name);
      assert.equal(job.fields.Address_at_Creation__c, [c.Street__c, c.City__c, c.State__c, c.Postal_Code__c].join(", "));
      assert.ok(Math.abs(job.fields.Geocode_Lat__c - 33.5) < 0.6 && Math.abs(job.fields.Geocode_Lon__c + 112) < 0.8, "pin is in the Phoenix area");
    }
    // The demo shows one partial payment and one refund.
    assert.equal(creates(ops, OBJ.invoice).filter((i) => i.fields.Status__c === "Partially Paid").length, 1);
    assert.equal(creates(ops, OBJ.payment).filter((p) => p.fields.Type__c === "Refund").length, 1);
    assert.ok(creates(ops, OBJ.payment).filter((p) => p.fields.Type__c === "Deposit").length >= 2);
  }
});

test("(d) the dispatch board: 2–4 calls per tech per working day, never overlapping, inside working hours", () => {
  for (const anchor of ANCHORS) {
    const { plan, ops } = planFor(anchor);
    const { service } = plan.models;
    const calls = creates(ops, OBJ.call).map((c) => c.fields);
    const windowed = calls.filter((c) => c.Scheduled_Start__c);
    for (const techKey of TECH_KEYS) {
      const mine = windowed.filter((c) => c.Tech__c.$ref === techKey).sort((a, b) => a.Scheduled_Start__c.localeCompare(b.Scheduled_Start__c));
      for (let i = 0; i < mine.length; i++) {
        const c = mine[i];
        const startMin = phxMinutesOf(c.Scheduled_Start__c);
        const endMin = phxMinutesOf(c.Scheduled_End__c);
        assert.equal(phxDateOf(c.Scheduled_Start__c), phxDateOf(c.Scheduled_End__c));
        assert.ok(startMin >= 7 * 60 && endMin <= 16 * 60, `${anchor.label} ${techKey}: ${c.Scheduled_Start__c} is outside 07:00–16:00`);
        assert.ok(endMin - startMin >= 60 && endMin - startMin <= 180, `${anchor.label}: a ${endMin - startMin}-minute call`);
        if (i > 0) assert.ok(mine[i - 1].Scheduled_End__c <= c.Scheduled_Start__c, `${anchor.label} ${techKey}: calls overlap at ${c.Scheduled_Start__c}`);
      }
      // Every working day from ten days back to seven ahead (and the anchor day itself) has 2–4 calls.
      for (let off = -10; off <= 7; off++) {
        const date = addDays(anchor.date, off);
        const n = mine.filter((c) => phxDateOf(c.Scheduled_Start__c) === date).length;
        if (off === 0 || isWeekday(date)) assert.ok(n >= 2 && n <= 4, `${anchor.label} ${techKey} ${date}: ${n} calls`);
        else assert.equal(n, 0, `${anchor.label} ${techKey}: calls on a weekend day ${date}`);
      }
      // The clock: what was actually worked never overlaps either, and stays inside the day.
      const spans = mine.flatMap((c) => liveIntervals(parseIntervals(c.Clock_Intervals__c))).sort((a, b) => a.in.localeCompare(b.in));
      for (let i = 0; i < spans.length; i++) {
        assert.ok(phxMinutesOf(spans[i].in) >= 7 * 60, `${anchor.label} ${techKey}: clocked in before 07:00`);
        if (spans[i].out) assert.ok(phxMinutesOf(spans[i].out) <= 16 * 60, `${anchor.label} ${techKey}: clocked out after 16:00`);
        if (i > 0) assert.ok(spans[i - 1].out && spans[i - 1].out <= spans[i].in, `${anchor.label} ${techKey}: two calls on the clock at once`);
      }
    }
    // Today's picture.
    const now = service.demoNow;
    const status = (s) => calls.filter((c) => c.Status__c === s);
    assert.equal(status("In Progress").length, 1);
    assert.equal(status("En Route").length, 1);
    assert.equal(status("Unscheduled").length, 4);
    assert.notEqual(status("In Progress")[0].Tech__c.$ref, status("En Route")[0].Tech__c.$ref);
    assert.equal(phxDateOf(status("In Progress")[0].Scheduled_Start__c), anchor.date);
    for (const c of windowed) {
      if (c.Status__c === "Scheduled") assert.ok(c.Scheduled_Start__c > now, `${anchor.label}: a Scheduled call in the past would raise "late" alerts (${c.Scheduled_Start__c})`);
      if (c.Status__c === "Complete") assert.ok(c.Actual_End__c <= now, `${anchor.label}: a call completed in the future`);
      if (phxDateOf(c.Scheduled_Start__c) < anchor.date) assert.ok(["Complete", "Cancelled", "No-Show"].includes(c.Status__c));
      if (phxDateOf(c.Scheduled_Start__c) > anchor.date) assert.equal(c.Status__c, "Scheduled");
    }
    for (const c of status("Unscheduled")) { assert.equal(c.Scheduled_Start__c, undefined); assert.equal(c.Clock_Intervals__c, undefined); }
  }
});

test("(d) clock intervals are in the exact shape the board's own parser reads", () => {
  const { ops } = planFor(ANCHORS[0]);
  let clocked = 0;
  for (const c of creates(ops, OBJ.call).map((x) => x.fields)) {
    if (!["Complete", "In Progress", "En Route", "No-Show"].includes(c.Status__c)) { assert.equal(c.Clock_Intervals__c, undefined); continue; }
    clocked++;
    const raw = JSON.parse(c.Clock_Intervals__c);
    const parsed = parseIntervals(c.Clock_Intervals__c);
    assert.equal(parsed.length, raw.length, "the parser dropped an interval (it drops anything without a string `in`)");
    for (const i of parsed) {
      assert.ok(["en_route", "on_site"].includes(i.kind));
      assert.ok(Array.isArray(i.ids) && i.ids.length >= 1);
      for (const k of Object.keys(i)) assert.ok(["in", "out", "kind", "arrived", "in_gps", "arrived_gps", "out_gps", "ids"].includes(k), `unexpected key ${k}`);
      for (const g of [i.in_gps, i.arrived_gps, i.out_gps].filter(Boolean)) assert.deepEqual(Object.keys(g), ["lat", "lng", "accuracy"]);
    }
    // The derived fields are what clockFields() derives from the log.
    const derived = clockFields(parsed);
    assert.equal(c.Actual_Start__c, derived.Actual_Start__c);
    assert.equal(c.Actual_End__c ?? null, derived.Actual_End__c);
    assert.equal(c.Duration_Minutes__c ?? null, derived.Duration_Minutes__c);
    const open = openIntervalIndex(parsed) >= 0;
    assert.equal(open, ["In Progress", "En Route"].includes(c.Status__c), `${c.Status__c} call: open interval = ${open}`);
    if (c.Status__c === "In Progress") assert.ok(parsed[0].arrived, "clocked in = arrived");
    if (c.Status__c === "En Route") assert.ok(!parsed[0].arrived, "on the way = not arrived yet");
    if (c.Status__c === "Complete") { assert.ok(c.Work_Notes__c.startsWith("── ")); assert.ok(c.Duration_Minutes__c > 0); }
  }
  assert.ok(clocked > 30);
});

test("(d) tech days: one per tech per worked day, in the shape day.js writes", () => {
  for (const anchor of ANCHORS.slice(0, 3)) {
    const { ops } = planFor(anchor);
    const calls = creates(ops, OBJ.call).map((c) => c.fields).filter((c) => c.Clock_Intervals__c);
    const days = creates(ops, OBJ.day).map((d) => d.fields);
    const worked = new Set(calls.map((c) => `${c.Tech__c.$ref}|${phxDateOf(JSON.parse(c.Clock_Intervals__c)[0].in)}`));
    assert.equal(days.length, worked.size);
    for (const d of days) {
      assert.ok(worked.has(`${d.Tech__c.$ref}|${d.Work_Date__c}`));
      assert.deepEqual(d.Day_Key__c, { $concat: [{ $ref: d.Tech__c.$ref }, ":", d.Work_Date__c] });
      // Swap the one id marker a log can hold for a real-looking id, then let day.js read it.
      const log = parseDayLog(JSON.stringify(d.Day_Log__c.$json).replace(/\{"\$ref":"[^"]+"\}/g, '"a0X000000000001AAA"'));
      assert.equal(log.length, d.Day_Log__c.$json.length);
      const derived = dayFields(log);
      assert.equal(d.Day_Start__c, derived.Day_Start__c);
      assert.equal(d.Day_End__c ?? null, derived.Day_End__c);
      assert.equal(d.Status__c, derived.Status__c);
      assert.equal(d.Status__c === "Open", d.Work_Date__c === anchor.date, "only today's days are still open");
      if (d.Outside_Minutes__c !== undefined) assert.ok(d.Outside_Minutes__c >= 0 && d.Outside_Minutes__c < 600);
      assert.ok(["Warehouse", "Call"].includes(d.Start_Kind__c));
    }
  }
});

// --- Notifications -------------------------------------------------------------------------
// The test's own statement of what the REAL emitters write (read from the Lambdas, not from
// plan-supabase.js): category / kind -> the url and the record the row points at.
const REAL_OFFICE_NOTIFICATIONS = {
  "tech_activity/complete": { url: /^\/service\/jobs\/job:\d{3}$/, record: "servicecall", key: /^call:/, from: "sundial-service-board/tech.js" },
  "tech_activity/clock_in": { url: /^\/service\/jobs\/job:\d{3}$/, record: "servicecall", key: /^call:/, from: "sundial-service-board/tech.js" },
  "tech_activity/no_show": { url: /^\/service\/jobs\/job:\d{3}$/, record: "servicecall", key: /^call:/, from: "sundial-service-board/tech.js" },
  "tech_activity/late": { url: /^\/service\/jobs\/job:\d{3}$/, record: "servicecall", key: /^call:/, from: "sundial-notify" },
  "money/estimate_approved": { url: /^\/service\/estimates\/estimate:\d{3}$/, record: "estimate", key: /^estimate:/, from: "sundial-service-public" },
  "money/estimate_declined": { url: /^\/service\/estimates\/estimate:\d{3}$/, record: "estimate", key: /^estimate:/, from: "sundial-service-public" },
  "money/deposit_paid": { url: /^\/service\/jobs\/job:\d{3}$/, record: "job", key: /^job:/, from: "sundial-service-estimate/stripe.js" },
  "money/invoice_paid": { url: /^\/service\/jobs\/job:\d{3}$/, record: "job", key: /^job:/, from: "sundial-service-estimate/stripe.js" },
  "customer_message/text": { url: /^\/service\/jobs\/job:\d{3}$/, record: "job", key: /^job:/, from: "sundial-sms" },
};
/** A planned value with its markers written out: { $ref: "job:016" } -> "job:016", { $name: … } -> "<number>". */
const flat = (v) => (typeof v === "string" ? v : v?.$concat ? v.$concat.map(flat).join("") : v?.$ref ?? (v?.$name ? "<number>" : String(v)));

test("(8) seeded bell notifications are rows a real emitter writes: real category / kind, real url, real record", () => {
  for (const anchor of ANCHORS) {
    const { plan } = planFor(anchor);
    const rows = plan.supabase.notifications;
    assert.equal(rows.length, 10, `${anchor.label}: five notifications for each of the two office users`);
    const office = new Set(["user:avery", "user:dana"]);
    for (const r of rows) {
      const pair = `${r.category}/${r.kind}`;
      const real = REAL_OFFICE_NOTIFICATIONS[pair];
      assert.ok(real, `${anchor.label}: "${pair}" is not a category / kind any emitter writes to the office`);
      assert.ok(Object.values(CATEGORIES).includes(r.category), `${r.category} is not in lib/notify.js CATEGORIES`);
      assert.ok(OFFICE_CATEGORIES.includes(r.category), `${r.category} is not a category the office receives (customer_text is the TECH's copy of a text)`);
      assert.match(flat(r.url), real.url, `${pair} url`);
      assert.equal(r.record_type, real.record, `${pair} record_type`);
      assert.match(r.record_sf_id.$ref, real.key, `${pair} record`);
      assert.ok(office.has(r.profile_id.$auth) && r.user_sf_id.$ref === r.profile_id.$auth);
      assert.match(r.dedupe_key, /^demo:conops-demo:\d+$/);
      assert.ok(flat(r.title).length <= 140, "lib/notify.js clips a title at 140 characters");
    }
    // The kinds the old seed invented are gone.
    for (const bad of ["call_complete", "call_started", "inbound_text", "payment_received"]) assert.ok(!rows.some((r) => r.kind === bad), bad);
    assert.ok(!rows.some((r) => r.category === "customer_text"));
    assert.deepEqual([...new Set(rows.map((r) => `${r.category}/${r.kind}`))].sort(), ["customer_message/text", "money/deposit_paid", "money/estimate_approved", "tech_activity/clock_in", "tech_activity/complete"]);
    // Worded like the emitter: "<tech> completed SVC-… · <customer>", "Text from <customer> · SVC-…".
    const title = (kind) => flat(rows.find((r) => r.kind === kind).title);
    assert.match(title("complete"), /^\w+ \w+ completed <number> · \w+ [\w'-]+$/);
    assert.match(title("clock_in"), /^\w+ \w+ clocked in at <number> · /);
    assert.match(title("estimate_approved"), /^Approved online: <number> · .+ — \$\d+\.\d{2}$/);
    assert.match(title("deposit_paid"), /^Deposit received: \$\d+\.\d{2} on <number> · /);
    assert.match(title("text"), /^Text from .+ · <number>$/);
    // The text notification is about a text that IS in the seeded thread of that job.
    const text = rows.find((r) => r.kind === "text");
    assert.ok(plan.supabase.sms.some((m) => m.direction === "in" && m.job_sf_id.$ref === text.record_sf_id.$ref && m.body === text.body && m.created_at === text.created_at));
  }
});

// --- Canary coverage ------------------------------------------------------------------------
test("(6) canaries: the first record of every object, and the first in EVERY customer / solar stage", () => {
  for (const anchor of ANCHORS.slice(0, 3)) {
    for (const options of [{}, { withSoldPendingReview: true }]) {
      const { ops } = planFor(anchor, { options });
      const seen = new Set();
      for (const op of ops.filter((o) => o.op === "create")) {
        const fresh = canaryTags(op.object, op.fields).filter((t) => !seen.has(`${op.object}|${t}`));
        for (const t of fresh) seen.add(`${op.object}|${t}`);
        assert.deepEqual(op.canary ?? [], fresh, `${op.key}: canary flags`);
      }
      const flagged = (o) => creates(ops, o).filter((x) => x.canary);
      // Solar: one canary per distinct stage, and it is the FIRST project written in that stage.
      const solar = creates(ops, OBJ.solar);
      const stages = [...new Set(solar.map((x) => x.fields.Stage__c))];
      assert.equal(flagged(OBJ.solar).length, stages.length);
      assert.equal(stages.length, options.withSoldPendingReview ? 34 : 33);
      for (const stage of stages) assert.ok(solar.find((x) => x.fields.Stage__c === stage).canary.includes(`stage: ${stage}`), stage);
      // Customers: every status / stage pair, every status without a stage, every service stage.
      const customers = creates(ops, OBJ.customer);
      for (const c of customers) {
        const f = c.fields;
        const tag = f.Stage__c ? `stage: ${f.Status__c} / ${f.Stage__c}` : `status: ${f.Status__c}`;
        const first = customers.find((x) => x.fields.Status__c === f.Status__c && (x.fields.Stage__c ?? null) === (f.Stage__c ?? null));
        assert.ok(first.canary?.includes(tag), `${first.key} is the first customer at ${tag} but is not a canary for it`);
        if (f.Service_Stage__c) assert.ok(customers.find((x) => x.fields.Service_Stage__c === f.Service_Stage__c).canary?.includes(`service stage: ${f.Service_Stage__c}`));
      }
      assert.ok(flagged(OBJ.customer).length >= new Set(customers.map((c) => c.fields.Stage__c).filter(Boolean)).size);
      // Every other object: exactly one canary, its first record.
      for (const o of SEEDED_OBJECTS.filter((x) => ![OBJ.customer, OBJ.solar].includes(x))) {
        assert.deepEqual(flagged(o).map((x) => x.key), [creates(ops, o)[0].key], o);
        assert.deepEqual(flagged(o)[0].canary, ["first"]);
      }
    }
  }
});

test("(6) the canary read-back never sends a query the REST API would refuse as too long", async () => {
  const schema = schemaFromProbe(probe);
  // The real field counts (Solar 510, Customer 413): one SELECT of all of them is over the limit.
  assert.equal(Object.keys(probe.salesforce.Sundial_Solar__c.fields).length, 510);
  assert.equal(Object.keys(probe.salesforce.Sundial_Customer__c.fields).length, 413);
  const id = "a1P7y00000AmyXCEAZ";
  for (const sfObject of SEEDED_OBJECTS) {
    const names = Object.keys(schema.object(sfObject).fields);
    const whole = `SELECT Id, ${names.join(", ")} FROM ${sfObject} WHERE Id = '${id}'`;
    const parts = packFields(sfObject, id, names);
    assert.deepEqual(parts.flat().sort(), names.filter((n) => n !== "Id").sort(), `${sfObject}: every field is read exactly once`);
    for (const part of parts) {
      const soql = `SELECT Id, ${part.join(", ")} FROM ${sfObject} WHERE Id = '${id}'`;
      assert.ok(soql.length <= SOQL_HARD_LIMIT, `${sfObject}: a ${soql.length}-character query`);
      // sfQuery() sends it URL-encoded in the request line.
      assert.ok(encodeURIComponent(soql).length <= CANARY_URI_CHARS, `${sfObject}: ${encodeURIComponent(soql).length} characters once encoded`);
    }
    if (sfObject === OBJ.solar) { assert.ok(whole.length > SOQL_HARD_LIMIT, "Solar in ONE query would be too long"); assert.equal(parts.length, 3); }
    if (sfObject === OBJ.customer) assert.equal(parts.length, 2);
  }
  // If Salesforce still refuses a query (414 URI Too Long, or "too complicated"), it is
  // halved and retried — and the smaller size is remembered for the next read-back.
  const names = Object.keys(schema.object(OBJ.solar).fields);
  const sent = [];
  const strict = async (soql) => {
    const n = soql.slice(7, soql.indexOf(" FROM ")).split(", ").length;
    sent.push(n);
    if (n > 61) { const e = new Error("Salesforce query failed (414)"); e.sfStatus = 414; throw e; }
    return [Object.fromEntries(soql.slice(7, soql.indexOf(" FROM ")).split(", ").map((f) => [f, null]))];
  };
  const limits = {};
  const first = await readRecordInFull({ sfQuery: strict, sfObject: OBJ.solar, id, names, limits });
  assert.deepEqual(Object.keys(first.record).sort(), [...new Set(["Id", ...names])].sort(), "every field was read despite the refusals");
  assert.ok(limits.maxFields <= 60, `learned ${limits.maxFields}`);
  sent.length = 0;
  await readRecordInFull({ sfQuery: strict, sfObject: OBJ.solar, id, names, limits });
  assert.ok(sent.every((n) => n <= 61), "the second read-back starts at the size that worked");
  // A query that is simply WRONG is not retried piece by piece.
  const wrong = async () => { const e = new Error("Salesforce query failed (400)"); e.sfStatus = 400; e.sfBody = JSON.stringify([{ errorCode: "INVALID_FIELD", message: "No such column" }]); throw e; };
  await assert.rejects(readRecordInFull({ sfQuery: wrong, sfObject: OBJ.solar, id, names }), /400/);
});

// --- The command line ------------------------------------------------------------------------
test("(4, 5) the command line: --phase files needs --with-files; --accept-canary takes only a seeded object", () => {
  assert.match(parseArgs(["--apply", "--phase", "files"]).problems.join("\n"), /--phase files uploads the sample PDFs to S3.*add --with-files/);
  assert.deepEqual(parseArgs(["--apply", "--phase", "files", "--with-files"]).problems, []);
  assert.deepEqual(parseArgs(["--apply", "--with-files"]).problems, []);
  const bad = parseArgs(["--apply", "--accept-canary", "Sundial_Solar"]).problems.join("\n");
  assert.match(bad, /--accept-canary Sundial_Solar: not an object this script seeds/);
  for (const o of SEEDED_OBJECTS) assert.ok(bad.includes(o), `the error lists ${o}`);
  assert.deepEqual(parseArgs(["--apply", "--accept-canary", "Sundial_Solar__c", "--accept-canary", "Sundial_Customer__c"]).problems, []);
  assert.match(parseArgs(["--apply", "--accept-canary", "sundial_solar__c"]).problems.join("\n"), /not an object this script seeds/, "names are exact");
  assert.match(parseArgs(["--apply", "--accept-canary"]).problems.join("\n"), /--accept-canary needs a value/);
});
