// Growing the data set (`--customers 150`, batches.js): the plan of the original 100
// customers is byte for byte what was applied, the new batch is new keys only, a fake
// --apply on top of a seeded tenant writes exactly the new records, and --freshen then
// moves every batch's calls.
//
//   node --experimental-test-module-mocks --test scripts/demo-seed/*.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIntervals, liveIntervals } from "../../lambdas/sundial-service-board/tech.js";
import { loadProbe, planFor, ANCHORS, creates, byKey } from "./test-helpers.js";
import { lintPlan, naturalKeyClashes } from "./preflight.js";
import { OBJ, objectOfKey } from "./policy.js";
import { replayJobStatus, OPEN_CALL_STATUSES, UNSCHEDULED_JOB_STATUSES } from "./plan-service.js";
import { GROWTH_SKIPPED_STAGES } from "./plan-solar.js";
import { batchesFor, validCustomerCount, GROWTH, GROWTH_JOBS, BASE_CUSTOMERS, GROWTH_STEP } from "./batches.js";
import { parseArgs } from "./args.js";
import { phxDateOf, phxMinutesOf, addDays } from "./dates.js";
import { TECH_KEYS, PERSONAS } from "./catalog.js";
import { createFakeIo } from "./fakes.js";
import { runSeed } from "./run.js";
import { FRESHEN_WIDE_HORIZON_DAYS } from "./freshen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = resolve(HERE, "..", "..", "migration", "demo");
const readDemo = (name) => (existsSync(resolve(DEMO_DIR, name)) ? JSON.parse(readFileSync(resolve(DEMO_DIR, name), "utf8")) : null);
/** JSON with every object's keys sorted — two records with the same fields in a different order read the same. */
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const DELETED_SOLAR_FIELDS = JSON.parse(readFileSync(resolve(HERE, "..", "..", "salesforce", "solar-field-cleanup-2026-11", "fields.json"), "utf8")).fields;
const GROWN = BASE_CUSTOMERS + GROWTH_STEP;
const customerNo = (key) => Number(key.split(":")[1]);

/**
 * Is this id-map / plan key part of batch 0 (the first 100 customers)? The real
 * migration/demo files grow with every `--customers` apply, so the tests below compare
 * only the batch-0 part of them — which must stay exactly what was applied on day one.
 */
function inBatch0(key, anchorDate) {
  const [kind, rest] = key.split(":");
  const no = Number(String(rest ?? "").split(/[-#]/)[0]); // "line:001-3", "customer:001#solar"
  if (kind === "customer" || kind === "solar") return no <= 100;
  if (kind === "roofing") return no <= 10;
  if (["estimate", "job", "invoice", "line", "call", "payment"].includes(kind)) return no <= 51;
  if (kind === "day") {
    const d = key.split(":")[2];
    const days = Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${anchorDate}T00:00:00Z`)) / 86400000);
    return days >= -10 && days <= 7;
  }
  return true; // tenant, dealers, users, price-book items
}
const batch0Options = (options) => Object.fromEntries(Object.entries(options || {}).filter(([k]) => k !== "customers"));
const countBy = (list, f) => list.reduce((m, x) => m.set(f(x), (m.get(f(x)) || 0) + 1), new Map());

test("batches: 100 is one batch, 150 two, 200 three; anything else is refused on the command line", () => {
  assert.equal(batchesFor(100).length, 1);
  assert.equal(batchesFor(150).length, 2);
  assert.equal(batchesFor(200).length, 3);
  for (const n of [99, 101, 120, 149, 175, 0, -50, 1.5]) assert.equal(validCustomerCount(n), false, String(n));
  assert.throws(() => batchesFor(120), /--customers must be 100 or 100 plus a multiple of 50/);
  for (const bad of ["120", "0", "abc"]) assert.match(parseArgs(["--customers", bad]).problems.join("\n"), /--customers must be 100/);
  assert.deepEqual(parseArgs(["--customers", "150"]).problems, []);
  assert.equal(parseArgs(["--customers", "150"]).customers, 150);
  assert.equal(parseArgs([]).customers, null);
  // Key numbering continues: the second batch's keys start after the first batch's last.
  const [b0, b1, b2] = batchesFor(200);
  assert.deepEqual([b0.firstCustomer, b1.firstCustomer, b2.firstCustomer], [1, 101, 151]);
  assert.deepEqual([b0.roofing.firstNo, b1.roofing.firstNo, b2.roofing.firstNo], [1, 11, 17]);
  assert.deepEqual([b0.service.firstNo, b1.service.firstNo, b2.service.firstNo], [1, 52, 77]);
  // Each batch's calls take a slice of the board no other batch uses (batch 0: -10 … +7).
  assert.deepEqual(b1.service.windows, { past: [-17, -11], future: [8, 14] });
  assert.deepEqual(b2.service.windows, { past: [-24, -18], future: [15, 21] });
});

test("(a) at the old setting the plan is what was applied: migration/demo/plan.json, record for record", () => {
  const applied = readDemo("plan.json");
  const idmap = readDemo("id-map.json");
  if (!applied || !idmap) { console.log("    (migration/demo/plan.json or id-map.json not present — skipped)"); return; }
  const anchor = { date: idmap.anchor.date, now: idmap.anchor.now };
  // The local files may since have been grown (--customers 150 rewrites both): only their
  // batch-0 part is compared, against a plan built at the original setting.
  const { pre, plan } = planFor(anchor, { seed: idmap.seed, options: batch0Options(idmap.options) });
  const appliedOps = applied.ops.filter((o) => inBatch0(o.key, idmap.anchor.date));
  // Every applied operation is in today's plan, with the same fields and values. (The only
  // difference since the apply is the ORDER of the keys inside Service Line records — the
  // estimate Lambda's lineFromItem() now derives Taxable__c last (D-083); the writer sends
  // the same fields either way.)
  // A plan.json written by a later `--customers` run was built against the LIVE describe
  // (picklists change — a stage added or removed shifts which customer lands where), while
  // this test plans from the September probe. Field values are compared only while the
  // file is the original one; afterwards the keys and the op count must still match
  // exactly (the writer skipped every one of them on the later run, so the live records
  // are untouched — test (b) proves the values at the same schema).
  // The live describe can also add or drop a follow-up UPDATE (e.g. a solar project's
  // roofing link when the Roofing stage list changed), so after a growth run only the
  // CREATES are compared — they are what the id-map records and what the writer skips.
  const strict = !applied.meta?.options?.customers;
  const compared = strict ? appliedOps : appliedOps.filter((o) => o.op === "create");
  const mine = strict ? pre.ops : pre.ops.filter((o) => o.op === "create");
  const now = new Map(mine.map((o) => [`${o.op}:${o.key}`, o]));
  assert.equal(mine.length, compared.length);
  for (const o of compared) {
    const n = now.get(`${o.op}:${o.key}`);
    assert.ok(n, `${o.key} is no longer planned`);
    if (strict) assert.equal(canon(n), canon(o), `${o.key} differs from what was applied`);
  }
  if (!(applied.meta?.batches?.length > 1)) {
    assert.equal(canon({ meta: plan.meta, supabase: plan.supabase, files: plan.files }), canon({ meta: applied.meta, supabase: applied.supabase, files: applied.files }));
  }
  // And the id-map's batch-0 keys (620 on day one) are exactly the plan's creates.
  const planned = new Set(pre.ops.filter((o) => o.op === "create").map((o) => o.key));
  assert.deepEqual(Object.keys(idmap.ids).filter((k) => inBatch0(k, idmap.anchor.date)).sort(), [...planned].sort());
});

test("(b) --customers 150: the first 100 customers' records are identical, the new keys are new and continue the numbering", () => {
  for (const anchor of ANCHORS) {
    const base = planFor(anchor);
    const grown = planFor(anchor, { options: { customers: GROWN } });
    assert.deepEqual(grown.pre.errors, [], `${anchor.label}: preflight`);
    assert.deepEqual(lintPlan(grown.plan), [], `${anchor.label}: lint`);
    assert.deepEqual(naturalKeyClashes(grown.ops), [], `${anchor.label}: natural keys`);
    for (const w of grown.pre.warnings) assert.match(w, /Sundial_Roofing__c\.(Deposit_|Notes__c)|Linked_Roofing_Project__c/, `${anchor.label}: unexpected drop — ${w}`);

    // Identical: every op of the 100-customer plan, field for field (ops are compared in plan order too).
    const grownByKey = new Map(grown.ops.map((o) => [`${o.op}:${o.key}`, o]));
    for (const o of base.ops) assert.deepEqual(grownByKey.get(`${o.op}:${o.key}`), o, `${anchor.label}: ${o.key} changed`);
    const baseKeys = new Set(base.ops.map((o) => `${o.op}:${o.key}`));
    const baseOrder = grown.ops.filter((o) => baseKeys.has(`${o.op}:${o.key}`));
    assert.deepEqual(baseOrder.map((o) => o.key), base.ops.map((o) => o.key), `${anchor.label}: the original records keep their write order`);
    // The Supabase rows and the sample files of the first batch are unchanged too (new activity rows are appended after them).
    for (const part of ["profiles", "comments", "sms", "notifications"]) assert.deepEqual(grown.plan.supabase[part], base.plan.supabase[part], `${anchor.label}: supabase ${part}`);
    assert.deepEqual(grown.plan.supabase.activity.slice(0, base.plan.supabase.activity.length), base.plan.supabase.activity, `${anchor.label}: activity rows of the first batch`);
    assert.ok(grown.plan.supabase.activity.length > base.plan.supabase.activity.length);
    assert.deepEqual(grown.plan.files, base.plan.files);
    assert.deepEqual(grown.plan.meta.liveDemo, base.plan.meta.liveDemo, "the live-demo customers are the original three");
    assert.deepEqual(grown.plan.meta.soldPendingReview, base.plan.meta.soldPendingReview);
    assert.equal(grown.plan.meta.options.customers, GROWN);
    assert.equal(base.plan.meta.options.customers, undefined, "the original plan's meta does not change");

    // New: keys the base plan does not have, numbered after it.
    const fresh = grown.ops.filter((o) => !baseKeys.has(`${o.op}:${o.key}`));
    const newCreates = fresh.filter((o) => o.op === "create");
    const n = (o) => newCreates.filter((x) => x.object === o).length;
    assert.deepEqual(
      { customers: n(OBJ.customer), solar: n(OBJ.solar), roofing: n(OBJ.roofing), estimates: n(OBJ.estimate), jobs: n(OBJ.job), invoices: n(OBJ.invoice), tenant: n(OBJ.tenant), dealers: n(OBJ.dealer), users: n(OBJ.user), items: n(OBJ.item) },
      { customers: GROWTH_STEP, solar: GROWTH.solar, roofing: GROWTH.roofingOnly, estimates: GROWTH_JOBS + GROWTH.jobless.length, jobs: GROWTH_JOBS, invoices: 5, tenant: 0, dealers: 0, users: 0, items: 0 },
      anchor.label
    );
    assert.ok(n(OBJ.line) >= 44 && n(OBJ.line) <= 150, `${anchor.label}: ${n(OBJ.line)} lines`);
    assert.ok(n(OBJ.call) >= 40 && n(OBJ.call) <= 100, `${anchor.label}: ${n(OBJ.call)} calls`);
    assert.ok(n(OBJ.payment) >= 4, `${anchor.label}: ${n(OBJ.payment)} payments`);
    assert.ok(n(OBJ.day) >= 10, `${anchor.label}: ${n(OBJ.day)} tech days`);
    assert.equal(newCreates.length, fresh.filter((o) => o.op === "create").length);
    for (const o of newCreates.filter((x) => x.object === OBJ.customer)) assert.ok(customerNo(o.key) > BASE_CUSTOMERS && customerNo(o.key) <= GROWN, o.key);
    for (const o of newCreates.filter((x) => x.object === OBJ.solar)) assert.ok(customerNo(o.key) > BASE_CUSTOMERS, o.key);
    for (const o of newCreates.filter((x) => x.object === OBJ.roofing)) assert.ok(customerNo(o.key) > 10, o.key);
    for (const o of newCreates.filter((x) => [OBJ.job, OBJ.estimate].includes(x.object))) assert.ok(customerNo(o.key) >= 52, o.key);
    for (const o of newCreates.filter((x) => x.object === OBJ.item)) assert.fail(`a second price book item ${o.key}`);
    // Updates of the new batch only ever target records of the new batch.
    for (const o of fresh.filter((x) => x.op === "update")) assert.ok(!baseKeys.has(`create:${o.target}`), `${anchor.label}: ${o.key} updates an original record`);

    // Every new record is the demo tenant's, and every lookup points at a demo record of the plan.
    const planned = new Set(grown.ops.filter((o) => o.op === "create").map((o) => o.key));
    const refsIn = (v, out = []) => { if (v && typeof v === "object") { if ("$ref" in v) out.push(v.$ref); else for (const x of Object.values(v)) refsIn(x, out); } return out; };
    for (const o of newCreates) {
      assert.deepEqual(o.fields.Client__c, { $ref: "tenant" }, `${o.key}: tenant stamp`);
      for (const k of refsIn(o.fields)) assert.ok(planned.has(k), `${o.key} points at ${k}`);
      // New service records hang off NEW customers only — an estimate on an original customer would change that customer's service summary.
      if (o.fields.Sundial_Customer__c) assert.ok(customerNo(o.fields.Sundial_Customer__c.$ref) > BASE_CUSTOMERS, `${o.key} hangs off ${o.fields.Sundial_Customer__c.$ref}`);
    }
    // No field the D-090 cleanup deleted, anywhere on Solar.
    for (const o of grown.ops.filter((x) => x.object === OBJ.solar)) for (const f of Object.keys(o.fields)) assert.ok(!DELETED_SOLAR_FIELDS.includes(f), `${o.key} writes the deleted field ${f}`);

    // The dealer follows the rep on every new customer, solar project and roofing job.
    const dealerOf = Object.fromEntries(PERSONAS.map((p) => [p.key, p.dealer ?? null]));
    for (const o of newCreates.filter((x) => [OBJ.customer, OBJ.solar, OBJ.roofing].includes(x.object))) {
      assert.equal(o.fields.Dealer__c.$ref, dealerOf[o.fields.Sales_Rep__c.$ref], `${o.key}: the dealer is not the rep's`);
    }

    // New solar projects: spread over the active pipeline, never the gated stage, never Archive, no new canary stage.
    const stages = countBy(newCreates.filter((x) => x.object === OBJ.solar), (o) => o.fields.Stage__c);
    assert.ok(stages.size >= 12, `${anchor.label}: only ${stages.size} stages among the new projects`);
    for (const s of GROWTH_SKIPPED_STAGES) assert.equal(stages.get(s), undefined, `${anchor.label}: a new project in "${s}"`);
    const baseStages = new Set(creates(base.ops, OBJ.solar).map((o) => o.fields.Stage__c));
    for (const s of stages.keys()) assert.ok(baseStages.has(s), `${anchor.label}: "${s}" is a stage the first batch never canaried`);
    const baseCustomerTags = new Set(creates(base.ops, OBJ.customer).flatMap((o) => [`${o.fields.Status__c}/${o.fields.Stage__c}`, `svc:${o.fields.Service_Stage__c}`]));
    for (const o of newCreates.filter((x) => x.object === OBJ.customer)) {
      assert.ok(baseCustomerTags.has(`${o.fields.Status__c}/${o.fields.Stage__c}`), `${o.key}: ${o.fields.Status__c} / ${o.fields.Stage__c} was never canaried`);
      assert.ok(baseCustomerTags.has(`svc:${o.fields.Service_Stage__c}`), `${o.key}: service stage ${o.fields.Service_Stage__c} was never canaried`);
    }
    assert.equal(grown.ops.filter((o) => o.canary && !baseKeys.has(`create:${o.key}`)).length, 0, `${anchor.label}: a new record is a canary`);

    // New service jobs: every status the board shows except the two "a tech is on it right now" ones, and each follows its calls.
    const jobStatuses = countBy(newCreates.filter((x) => x.object === OBJ.job), (o) => o.fields.Status__c);
    for (const [status, count] of Object.entries(GROWTH.jobCounts)) assert.equal(jobStatuses.get(status), count || undefined, `${anchor.label}: ${status}`);
    const { serviceBatches } = grown.plan.models;
    assert.equal(serviceBatches.length, 2);
    const newCalls = newCreates.filter((x) => x.object === OBJ.call).map((o) => o.fields);
    for (const job of serviceBatches[1].jobs) {
      const label = `${anchor.label} ${job.key} (${job.status})`;
      assert.equal(replayJobStatus("New", job.calls, job.officeSteps), job.status, label);
      const statuses = job.calls.map((c) => c.fields.Status__c);
      const open = statuses.filter((s) => OPEN_CALL_STATUSES.includes(s)).length;
      if (UNSCHEDULED_JOB_STATUSES.includes(job.status)) assert.equal(open, 0, label);
      if (job.status === "In Progress") assert.ok(statuses.includes("Complete") && open >= 1, `${label}: a growth batch's In Progress job is "worked once, another visit booked"`);
      assert.ok(!statuses.includes("In Progress") && !statuses.includes("En Route"), `${label}: today's picture belongs to the first batch`);
    }
    // The new calls sit in the batch's own window — never on the original board's days, never on a weekend —
    // and no tech is double-booked across the two batches.
    for (const c of newCalls.filter((x) => x.Scheduled_Start__c)) {
      const day = phxDateOf(c.Scheduled_Start__c);
      const off = Math.round((Date.parse(day) - Date.parse(anchor.date)) / 86400000);
      assert.ok((off >= -17 && off <= -11) || (off >= 8 && off <= 14), `${anchor.label}: a new call on day ${off}`);
    }
    const allCalls = creates(grown.ops, OBJ.call).map((o) => o.fields).filter((c) => c.Scheduled_Start__c);
    for (const techKey of TECH_KEYS) {
      const mine = allCalls.filter((c) => c.Tech__c.$ref === techKey).sort((a, b) => a.Scheduled_Start__c.localeCompare(b.Scheduled_Start__c));
      for (let i = 1; i < mine.length; i++) assert.ok(mine[i - 1].Scheduled_End__c <= mine[i].Scheduled_Start__c, `${anchor.label} ${techKey}: calls overlap at ${mine[i].Scheduled_Start__c}`);
      for (const c of mine) assert.ok(phxMinutesOf(c.Scheduled_Start__c) >= 7 * 60 && phxMinutesOf(c.Scheduled_End__c) <= 16 * 60);
      const spans = mine.flatMap((c) => liveIntervals(parseIntervals(c.Clock_Intervals__c))).sort((a, b) => a.in.localeCompare(b.in));
      for (let i = 1; i < spans.length; i++) assert.ok(spans[i - 1].out && spans[i - 1].out <= spans[i].in, `${anchor.label} ${techKey}: two calls on the clock at once`);
    }
    // Tech days: one per tech per worked day across both batches, no two for the same day.
    const days = creates(grown.ops, OBJ.day).map((o) => `${o.fields.Tech__c.$ref}|${o.fields.Work_Date__c}`);
    assert.equal(new Set(days).size, days.length, `${anchor.label}: a tech has two day rows for one date`);
    // The new customers: the mix.
    const newCustomers = newCreates.filter((x) => x.object === OBJ.customer);
    const type = (c) => c.fields.Customer_Type__c;
    assert.equal(newCustomers.filter((c) => type(c).split(";").includes("Solar")).length, GROWTH.solar);
    assert.equal(newCustomers.filter((c) => type(c) === "Roofing").length, GROWTH.roofingOnly);
    assert.equal(newCustomers.filter((c) => type(c) === "Service").length, GROWTH.service);
    assert.ok(newCustomers.some((c) => type(c) === "Solar;Service"));
    assert.ok(new Set(newCustomers.filter((c) => type(c) === "Service").map((c) => c.fields.Service_Stage__c)).size >= 5, "the Service board gets new cards in several columns");
    // Nobody shares a name, a street or a phone with an original customer.
    const all = creates(grown.ops, OBJ.customer);
    for (const f of ["Name", "Street__c", "Primary_Phone__c", "Primary_Email__c"]) assert.equal(new Set(all.map((c) => c.fields[f])).size, all.length, `${anchor.label}: duplicate ${f}`);
    assert.equal(grown.plan.meta.batches.length, 2);
    assert.equal(grown.plan.solarStageMap.reduce((s, x) => s + x.count, 0), 75);
  }
});

test("(c) --apply --customers 150 on a tenant seeded with 100: every existing key is skipped, exactly the new records are created", async () => {
  // The fake org is seeded the way the real one was: same anchor minute, same options — so the
  // fake tenant holds exactly the 620 keys of migration/demo/id-map.json before it is grown.
  const realIdmap = readDemo("id-map.json");
  const w = createFakeIo(loadProbe(), realIdmap ? { now: realIdmap.anchor.now } : {});
  const firstArgs = ["--apply", ...(realIdmap?.options?.demoPhone ? ["--demo-phone", realIdmap.options.demoPhone] : []), ...(realIdmap?.options?.demoEmail ? ["--demo-email", realIdmap.options.demoEmail] : [])];
  assert.equal(await runSeed(firstArgs, w.io), 0, w.output().split("\n").slice(-15).join("\n"));
  const flat = (snap) => Object.fromEntries(Object.values(snap).flat().map((r) => [r.Id, r]));
  const before = flat(JSON.parse(JSON.stringify(w.org.snapshot())));
  const idmapBefore = w.idmap();
  const existing = new Set(Object.keys(idmapBefore.ids));
  if (realIdmap) {
    assert.equal(realIdmap.seed, idmapBefore.seed);
    assert.deepEqual([...existing].sort(), Object.keys(realIdmap.ids).filter((k) => inBatch0(k, realIdmap.anchor.date)).sort(), "the fake seed has exactly the batch-0 keys of the real id-map");
  }
  const creates0 = w.org.calls.creates.length;
  const updates0 = w.org.calls.updates.length;
  const tenant = w.org.all(OBJ.tenant).find((t) => t.Name === "conops-demo");

  // Dry run: says what would grow, writes nothing.
  w.lines.length = 0;
  assert.equal(await runSeed(["--customers", "150"], w.io), 0, w.output());
  assert.match(w.output(), /--customers 150: the data set grows from 100 to 150 customers/);
  assert.match(w.output(), /Data set: 150 customers in 2 batches/);
  assert.match(w.output(), /batch 1: customer:101 … customer:150 — 25 solar, 5 roofing, 22 jobs \/ 25 estimates/);
  // 619: the 620 keys minus the tenant row itself, which the reconcile does not count.
  assert.match(w.output(), /Already in Salesforce for this tenant and recorded in the id-map: 619 record\(s\)/);
  assert.match(w.output(), /Preflight passed/);
  assert.equal(w.org.calls.creates.length, creates0);
  assert.equal(w.idmap().options.customers ?? null, null, "a dry run stores nothing");

  // A smaller number than what exists is refused.
  w.lines.length = 0;
  w.files.set("id-map.json", JSON.stringify({ ...w.idmap(), options: { ...w.idmap().options, customers: 150 } }));
  assert.equal(await runSeed(["--apply", "--customers", "100"], w.io), 1);
  assert.match(w.output(), /--customers 100 is smaller than the data set already seeded \(150 customers\)/);
  assert.equal(w.org.calls.creates.length, creates0);
  w.files.set("id-map.json", JSON.stringify(idmapBefore));

  // Apply the growth.
  w.lines.length = 0;
  assert.equal(await runSeed(["--apply", "--customers", "150"], w.io), 0, w.output().split("\n").slice(-25).join("\n"));
  const out = w.output();
  assert.match(out, /all records verified/);
  const after = flat(w.org.snapshot());
  // Nothing that existed changed (the follow-up updates of the first batch are "already done" and not repeated).
  for (const [id, rec] of Object.entries(before)) assert.deepEqual(after[id], rec, `${id} changed`);
  const newCreates = w.org.calls.creates.slice(creates0);
  const byObject = countBy(newCreates, (c) => c.sfObject);
  assert.deepEqual(
    Object.fromEntries([OBJ.customer, OBJ.solar, OBJ.roofing, OBJ.estimate, OBJ.job, OBJ.invoice].map((o) => [o, byObject.get(o) ?? 0])),
    { [OBJ.customer]: 50, [OBJ.solar]: 25, [OBJ.roofing]: 5, [OBJ.estimate]: 25, [OBJ.job]: 22, [OBJ.invoice]: 5 }
  );
  for (const o of [OBJ.tenant, OBJ.dealer, OBJ.user, OBJ.item]) assert.equal(byObject.get(o), undefined, `${o} created again`);
  for (const c of newCreates) assert.equal(c.fields.Client__c, tenant.Id);
  for (const u of w.org.calls.updates.slice(updates0)) assert.ok(!Object.values(idmapBefore.ids).includes(u.id), `an original record (${u.id}) was updated`);
  // The id-map: the old keys unchanged, the new ones new.
  const idmap = w.idmap();
  for (const k of existing) assert.equal(idmap.ids[k], idmapBefore.ids[k], `${k} points elsewhere`);
  const added = Object.keys(idmap.ids).filter((k) => !existing.has(k));
  assert.equal(added.length, newCreates.length);
  for (const k of added) {
    assert.ok(/^(customer|solar|roofing|estimate|line|job|call|invoice|payment|day):/.test(k), k);
    if (/^(customer|solar):/.test(k)) assert.ok(customerNo(k) > 100, k);
    if (/^(job|estimate):/.test(k)) assert.ok(customerNo(k) >= 52, k);
  }
  assert.equal(idmap.options.customers, 150, "the setting is stored with the apply");
  assert.deepEqual(idmap.anchor, idmapBefore.anchor);
  assert.equal(idmap.seed, idmapBefore.seed);
  // The run record in the secret carries the new setting (a lost id-map rebuilds the 150-customer plan).
  const secret = JSON.parse(w.secrets.get("sundial/demo-users"));
  assert.equal(secret._run["conops-demo"].options.customers, 150);
  // "already done" counts the skipped creates AND the skipped follow-up updates of the first batch.
  assert.match(out, /Sundial_Customer__c\s+created\s+50\s+updated\s+25\s+already done\s+150/);
  assert.match(out, /Sundial_Solar__c\s+created\s+25\s+updated\s+0\s+already done\s+53/);
  assert.match(out, /Sundial_Service_Job__c\s+created\s+22/);
  // No canary was needed: every stage the new records sit in had been read back on the first seed.
  assert.ok(!/canary Sundial_(Customer|Solar)__c \[stage/.test(out.slice(out.indexOf("=== phase: customers"))), "a new record was canaried in a stage already settled");

  // The same command again, and the command without --customers, change nothing.
  for (const args of [["--apply", "--customers", "150"], ["--apply"]]) {
    const n = w.org.calls.creates.length;
    w.lines.length = 0;
    assert.equal(await runSeed(args, w.io), 0, w.output().split("\n").slice(-15).join("\n"));
    assert.equal(w.org.calls.creates.length, n, args.join(" "));
    assert.match(w.output(), /Data set: 150 customers in 2 batches/);
  }

  // (d) --freshen covers both batches: every open call — the original board's and the new batch's — lands in the new window.
  const jobsByBatch = new Map(w.org.all(OBJ.job).filter((j) => j.Client__c === tenant.Id).map((j) => [j.Id, Object.values(idmapBefore.ids).includes(j.Id) ? 0 : 1]));
  const openBefore = w.org.all(OBJ.call).filter((c) => c.Client__c === tenant.Id && OPEN_CALL_STATUSES.includes(c.Status__c));
  assert.ok(openBefore.some((c) => jobsByBatch.get(c.Sundial_Service_Job__c) === 1), "the new batch has open calls to move");
  const nowIso = "2026-10-22T16:50:00.000Z"; // Thursday 09:50 in Phoenix
  w.setNow(nowIso);
  const today = "2026-10-22";
  w.lines.length = 0;
  assert.equal(await runSeed(["--freshen", "--apply"], w.io), 0, w.output().split("\n").slice(-15).join("\n"));
  assert.doesNotMatch(w.output(), /no free slot/, "every open call found a slot");
  const horizon = Number(/open calls moved into \S+ … \+(\d+) days/.exec(w.output())[1]);
  assert.ok(horizon === 7 || horizon === FRESHEN_WIDE_HORIZON_DAYS);
  const calls = w.org.all(OBJ.call).filter((c) => c.Client__c === tenant.Id);
  const moved = new Set(openBefore.map((c) => c.Id));
  let movedNew = 0;
  for (const c of calls.filter((x) => OPEN_CALL_STATUSES.includes(x.Status__c) && moved.has(x.Id))) {
    const day = phxDateOf(new Date(c.Scheduled_Start__c).toISOString());
    assert.ok(day >= today && day <= addDays(today, horizon), `${c.Name} (batch ${jobsByBatch.get(c.Sundial_Service_Job__c)}) is on ${day}`);
    if (jobsByBatch.get(c.Sundial_Service_Job__c) === 1) movedNew++;
  }
  assert.ok(movedNew >= 10, `${movedNew} of the new batch's calls were moved`);
  // Nothing double-booked afterwards either.
  for (const techKey of TECH_KEYS) {
    const techId = idmap.ids[techKey];
    const windows = calls.filter((c) => c.Tech__c === techId && c.Scheduled_Start__c && c.Status__c !== "Cancelled").map((c) => [new Date(c.Scheduled_Start__c).toISOString(), new Date(c.Scheduled_End__c).toISOString(), c.Name]).sort();
    for (let i = 1; i < windows.length; i++) assert.ok(windows[i - 1][1] <= windows[i][0], `${windows[i - 1][2]} and ${windows[i][2]} overlap`);
  }
  // Every job still agrees with its calls.
  for (const job of w.org.all(OBJ.job).filter((j) => j.Client__c === tenant.Id)) {
    const mine = calls.filter((c) => c.Sundial_Service_Job__c === job.Id);
    const open = mine.filter((c) => OPEN_CALL_STATUSES.includes(c.Status__c)).length;
    if (UNSCHEDULED_JOB_STATUSES.includes(job.Status__c) || ["Awaiting Office Review", "Ready to Bill", "Invoiced", "Paid", "Closed"].includes(job.Status__c)) assert.equal(open, 0, `${job.Name} (${job.Status__c}) has an open call`);
    if (job.Status__c === "Scheduled") assert.ok(open >= 1, `${job.Name} Scheduled without an open call`);
  }
  // The seed afterwards still sees a consistent tenant.
  w.lines.length = 0;
  const n = w.org.calls.creates.length;
  assert.equal(await runSeed(["--apply"], w.io), 0, w.output().split("\n").slice(-12).join("\n"));
  assert.equal(w.org.calls.creates.length, n);
  assert.ok(Object.keys(w.idmap().ids).every((k) => objectOfKey(k, w.idmap().objects)), "every key names its object");
});

test("(c) a fresh seed straight at 150 and a seed grown 100 -> 150 hold the same records", async () => {
  const a = createFakeIo(loadProbe());
  assert.equal(await runSeed(["--apply", "--customers", "150"], a.io), 0, a.output().split("\n").slice(-15).join("\n"));
  const b = createFakeIo(loadProbe());
  assert.equal(await runSeed(["--apply"], b.io), 0);
  assert.equal(await runSeed(["--apply", "--customers", "150"], b.io), 0, b.output().split("\n").slice(-15).join("\n"));
  assert.deepEqual(Object.keys(a.idmap().ids).sort(), Object.keys(b.idmap().ids).sort());
  const strip = (w) => { const t = w.org.all(OBJ.tenant).find((x) => x.Name === "conops-demo"); return Object.values(w.org.snapshot()).flat().filter((r) => r.Client__c === t.Id).map((r) => { const { Id, Client__c, CreatedDate, LastModifiedDate, SystemModstamp, ...rest } = r; return rest; }); };
  // Same records, apart from the ids / numbers Salesforce hands out and the id-markers inside text fields.
  const scrub = (rows) => canon(rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k, v]) => typeof v !== "string" || !/a[0-9A-Za-z]{14,17}|SVC-|SC-|EST-/.test(v)).filter(([k]) => k !== "Name"))));
  assert.equal(scrub(strip(a)), scrub(strip(b)));
});
