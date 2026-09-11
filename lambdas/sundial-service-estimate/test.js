// Tests for sundial-service-estimate — pure modules with exact cents, then the real
// router driven through createHandler() with an in-memory Salesforce. No mock.module:
// every dependency is injected, so this runs the same on Windows and Linux.
//
// Run:  node --test lambdas/sundial-service-estimate/test.js   (also in `npm test`)

import test from "node:test";
import assert from "node:assert/strict";
import { computeTotals, cents } from "./totals.js";
import {
  normalizePhone, streetKey, normalizeNewCustomer, candidateSoql, matchCandidates,
  unionProjectTypes, matchPicklist, buildNewCustomerFields,
} from "./customer.js";
import {
  itemFieldsFromBody, newVersionFields, lineFromItem, adHocLine, linePatchFields, inPlaceEditable,
} from "./pricebook.js";
import { createHandler, matchRoute, PROJECT_TYPE_TAG } from "./index.js";
import { renderEstimateDocument } from "../../lib/estimate-document.js";

const TENANT = "a1W7y000007AszBEAS";
const OTHER_TENANT = "a1W7y000007OTHER00";
const USER = "a1O7y00000CallerAA";

// ---------------------------------------------------------------------------
// totals.js
// ---------------------------------------------------------------------------
test("cents rounds half away from zero without float drift", () => {
  assert.equal(cents(1.005), 1.01);
  assert.equal(cents(2.675), 2.68);
  assert.equal(cents(-1.005), -1.01);
  assert.equal(cents("abc"), 0);
});

test("computeTotals: kind buckets, labor-only discount, hidden markup, proportional tax, percent deposit", () => {
  const lines = [
    { kind: "Labor", quantity: 1.5, unitPrice: 200, taxable: false },        // 300 labor, not taxable
    { kind: "Material", quantity: 2, unitPrice: 49.99, taxable: true },     // 99.98 material, taxable
    { kind: "Fee", quantity: 1, unitPrice: 25, taxable: false },            // 25 fee
    { kind: "Product", quantity: 1, unitPrice: 1000, unitLaborPrice: 400, unitMaterialPrice: 600, taxable: true }, // split
    { kind: "Labor", quantity: 1, unitPrice: 999, stage: "Removed" },       // ignored
  ];
  const t = computeTotals(lines, {
    discountScope: "Labor", discountType: "Percent", discountValue: 10,
    markupType: "Amount", markupValue: 50,
    taxRate: 8.6,
    depositRequired: true, depositType: "Percent", depositValue: 25,
  });
  assert.equal(t.laborSubtotal, 700);          // 300 + 400
  assert.equal(t.materialSubtotal, 699.98);    // 99.98 + 600
  assert.equal(t.feeSubtotal, 25);
  assert.equal(t.subtotal, 1424.98);
  assert.equal(t.discountAmount, 70);          // 10% of labor 700
  assert.equal(t.markupAmount, 50);
  // taxable value 1099.98, scaled by net/subtotal = 1404.98/1424.98
  const net = 1424.98 - 70 + 50;
  const expectedTax = cents(((1099.98 * net) / 1424.98) * 0.086);
  assert.equal(t.taxAmount, expectedTax);
  assert.equal(t.total, cents(net + expectedTax));
  assert.equal(t.depositAmount, cents(t.total * 0.25));
  assert.equal(t.fields.Total__c, t.total);
});

test("computeTotals: unsplit Product is reachable only by a Both-scoped discount; amount discount caps at base", () => {
  const lines = [{ kind: "Product", quantity: 1, unitPrice: 500, taxable: false }];
  assert.equal(computeTotals(lines, { discountScope: "Labor", discountType: "Percent", discountValue: 50 }).discountAmount, 0);
  assert.equal(computeTotals(lines, { discountScope: "Both", discountType: "Percent", discountValue: 50 }).discountAmount, 250);
  assert.equal(computeTotals(lines, { discountScope: "Both", discountType: "Amount", discountValue: 9999 }).discountAmount, 500);
});

test("computeTotals: fees are never discounted; flat deposit caps at total; no deposit unless required", () => {
  const lines = [{ kind: "Fee", quantity: 1, unitPrice: 100, taxable: false }];
  const t = computeTotals(lines, { discountScope: "Both", discountType: "Percent", discountValue: 50, depositType: "Flat", depositValue: 500 });
  assert.equal(t.discountAmount, 0);
  assert.equal(t.total, 100);
  assert.equal(t.depositAmount, 0);
  const t2 = computeTotals(lines, { depositRequired: true, depositType: "Flat", depositValue: 500 });
  assert.equal(t2.depositAmount, 100);
});

test("computeTotals: empty estimate is all zeros (the $0 warranty estimate is legal)", () => {
  const t = computeTotals([], { taxRate: 8.6, depositRequired: true, depositType: "Percent", depositValue: 50 });
  assert.deepEqual(Object.values(t.fields), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

// ---------------------------------------------------------------------------
// customer.js
// ---------------------------------------------------------------------------
test("phone / street normalization", () => {
  assert.equal(normalizePhone("+1 (602) 555-1234"), "6025551234");
  assert.equal(normalizePhone("602.555.1234"), "6025551234");
  assert.equal(streetKey("123 N. Main St"), "123 n");
  assert.equal(streetKey("  123   Main"), "123 main");
});

test("normalizeNewCustomer requires a name and an email-or-phone", () => {
  assert.equal(normalizeNewCustomer({}).ok, false);
  assert.deepEqual(normalizeNewCustomer({ firstName: "A" }).missing, ["email|phone"]);
  assert.equal(normalizeNewCustomer({ firstName: "A", email: "bad" }).ok, false);
  const ok = normalizeNewCustomer({ firstName: " Ann ", lastName: "Lee", phone: "602-555-0000" });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.firstName, "Ann");
});

test("candidateSoql is tenant-scoped and escapes input; matchCandidates matches exactly", () => {
  const c = { email: "o'brien@x.com", phone: "(602) 555-1234", street: "123 N Main St", postalCode: "85001-1234" };
  const soql = candidateSoql(TENANT, c);
  assert.ok(soql.includes(`Client__c = '${TENANT}'`));
  assert.ok(soql.includes("o\\'brien@x.com"));
  assert.ok(soql.includes("LIKE '%1234'"));
  assert.ok(soql.includes("Postal_Code__c LIKE '85001%'"));
  const rows = [
    { Id: "1", Name: "A", Primary_Email__c: "O'Brien@X.com" },                       // email (case-insensitive)
    { Id: "2", Name: "B", Primary_Phone__c: "602.555.1234" },                        // phone
    { Id: "3", Name: "C", Street__c: "123 N Main", Postal_Code__c: "85001" },        // address
    { Id: "4", Name: "D", Primary_Phone__c: "480-555-1234", Street__c: "999 Main", Postal_Code__c: "85001" }, // tail-only
  ];
  const m = matchCandidates(rows, c);
  assert.deepEqual(m.map((x) => [x.id, x.reasons]), [["1", ["email"]], ["2", ["phone"]], ["3", ["address"]]]);
});

test("unionProjectTypes adds once and returns null when nothing changes", () => {
  assert.equal(unionProjectTypes("", "Service"), "Service");
  assert.equal(unionProjectTypes("Solar;Roofing", "Service"), "Solar;Roofing;Service");
  assert.equal(unionProjectTypes("Solar;Service", "Service"), null);
});

test("matchPicklist: value or label, active only, case-insensitive", () => {
  const vals = [{ value: "AZ", label: "Arizona", active: true }, { value: "Old", label: "Old", active: false }];
  assert.equal(matchPicklist("arizona", vals), "AZ");
  assert.equal(matchPicklist("az", vals), "AZ");
  assert.equal(matchPicklist("Old", vals), null);
  assert.equal(matchPicklist("Service", ["Solar", "Service"]), "Service");
});

test("buildNewCustomerFields: Name is First Last, blanks dropped, state via picker", () => {
  const f = buildNewCustomerFields({ firstName: "Ann", lastName: "Lee", email: "a@b.co", state: "arizona" }, { pickState: () => "AZ" });
  assert.equal(f.Name, "Ann Lee");
  assert.equal(f.State__c, "AZ");
  assert.equal("Street__c" in f, false);
});

// ---------------------------------------------------------------------------
// pricebook.js
// ---------------------------------------------------------------------------
test("itemFieldsFromBody: unknown keys rejected, code normalized, create requires the basics", () => {
  const r = itemFieldsFromBody({ name: "Standard Service Call", itemCode: "svc call std", kind: "Labor", laborPrice: "275", hacker: 1 }, { requireAll: true });
  assert.deepEqual(r.rejected, ["hacker"]);
  assert.deepEqual(r.problems, []);
  assert.equal(r.fields.Item_Code__c, "SVC-CALL-STD");
  assert.equal(r.fields.Labor_Price__c, 275);
  const bad = itemFieldsFromBody({ name: "X", itemCode: "X", kind: "Weird" }, { requireAll: true });
  assert.ok(bad.problems.some((p) => p.startsWith("kind must be")));
  assert.ok(bad.problems.some((p) => p.includes("laborPrice or materialPrice")));
});

test("newVersionFields: same code, version+1, active, tenant stamped, edits win", () => {
  const cur = { Item_Code__c: "SVC-CALL-STD", Version__c: 2, Name: "Std", Kind__c: "Labor", Labor_Price__c: 275, Taxable__c: false };
  const f = newVersionFields(cur, { Labor_Price__c: 300 }, TENANT);
  assert.equal(f.Item_Code__c, "SVC-CALL-STD");
  assert.equal(f.Version__c, 3);
  assert.equal(f.Is_Active__c, true);
  assert.equal(f.Labor_Price__c, 300);
  assert.equal(f.Client__c, TENANT);
  assert.equal(inPlaceEditable(0), true);
  assert.equal(inPlaceEditable(3), false);
});

test("lineFromItem snapshots price/split/cost and flags an override", () => {
  const item = { Id: "PBI1", Name: "Std", Kind__c: "Product", Description__c: "Desc", Price__c: 1000, Labor_Price__c: 400, Material_Price__c: 600, Labor_Cost__c: 100, Material_Cost__c: 300, Default_Quantity__c: 1.5, Taxable__c: true, Unit_of_Measure__c: "Hour" };
  const f = lineFromItem(item, {}, { estimateId: "EST1", tenantId: TENANT });
  assert.equal(f.Unit_Price__c, 1000);
  assert.equal(f.Quantity__c, 1.5);
  assert.equal(f.Unit_Labor_Price__c, 400);
  assert.equal(f.Unit_Material_Cost__c, 300);
  assert.equal(f.Price_Overridden__c, false);
  const o = lineFromItem(item, { unitPrice: 1100, quantity: 2 }, { estimateId: "EST1", tenantId: TENANT });
  assert.equal(o.Price_Overridden__c, true);
  assert.equal(o.Quantity__c, 2);
});

test("adHocLine requires description + unitPrice; linePatchFields refuses unknown/invalid", () => {
  assert.ok(adHocLine({ kind: "Labor" }, { estimateId: "E", tenantId: TENANT }).problems.length >= 2);
  const ok = adHocLine({ description: "Misc part", kind: "Material", unitPrice: "12.5", taxable: true }, { estimateId: "E", tenantId: TENANT });
  assert.equal(ok.fields.Unit_Price__c, 12.5);
  assert.equal(ok.fields.Source__c, "Ad hoc");
  assert.deepEqual(linePatchFields({ quantity: 3, nope: 1 }).rejected, ["nope"]);
  assert.deepEqual(linePatchFields({ stage: "Bogus" }).problems, ["invalid stage"]);
});

// ---------------------------------------------------------------------------
// Router + handler with an in-memory Salesforce
// ---------------------------------------------------------------------------
test("matchRoute strips a stage prefix and captures ids", () => {
  assert.deepEqual(matchRoute("POST", "/prod/service/estimates/abc/lines"), { name: "addLine", params: ["abc"] });
  assert.deepEqual(matchRoute("DELETE", "/service/estimates/a/lines/b"), { name: "deleteLine", params: ["a", "b"] });
  assert.equal(matchRoute("GET", "/service/nope"), null);
});

function fakeSalesforce() {
  const store = { Sundial_Customer__c: [], Sundial_Estimate__c: [], Sundial_Service_Job__c: [], Sundial_Price_Book_Item__c: [], Sundial_Service_Line__c: [] };
  let seq = 0;
  const calls = { creates: [], updates: [], deletes: [], queries: [] };
  const newId = (obj) => `${obj.slice(8, 11).toUpperCase()}${String(++seq).padStart(15, "0")}`.slice(0, 18);

  function evalCond(rec, cond) {
    cond = cond.trim().replace(/^\(|\)$/g, "");
    let m;
    if ((m = cond.match(/^(\w+) = '(.*)'$/))) return String(rec[m[1]] ?? "").toLowerCase() === m[2].replace(/\\'/g, "'").toLowerCase();
    if ((m = cond.match(/^(\w+) = (true|false)$/))) return (rec[m[1]] === true) === (m[2] === "true");
    if ((m = cond.match(/^(\w+) LIKE '(.*)'$/))) {
      const v = String(rec[m[1]] ?? "").toLowerCase();
      const pat = m[2].toLowerCase();
      if (pat.startsWith("%")) return v.endsWith(pat.slice(1));
      if (pat.endsWith("%")) return v.startsWith(pat.slice(0, -1));
      return v === pat;
    }
    throw new Error(`fake SOQL cannot evaluate: ${cond}`);
  }
  function evalWhere(rec, where) {
    // Supports: A AND B AND (C OR D OR (E AND F))
    const orGroup = where.match(/\((.+)\)\s*(LIMIT|ORDER|$)/);
    let andPart = where;
    let orPart = null;
    if (where.includes(" OR ")) {
      const idx = where.indexOf(" AND (");
      andPart = where.slice(0, idx);
      orPart = where.slice(idx + 6).replace(/\)\s*$/, "");
    }
    const ands = andPart.split(" AND ").filter(Boolean).every((c) => evalCond(rec, c));
    if (!ands) return false;
    if (!orPart) return true;
    return orPart.split(" OR ").some((c) => {
      c = c.trim();
      if (c.startsWith("(")) return c.replace(/^\(|\)$/g, "").split(" AND ").every((x) => evalCond(rec, x));
      return evalCond(rec, c);
    });
    void orGroup;
  }
  const sfQuery = async (soql) => {
    calls.queries.push(soql);
    const obj = soql.match(/FROM (\w+)/)[1];
    let where = (soql.split(" WHERE ")[1] || "").replace(/\s+(ORDER BY|LIMIT).*$/, "").trim();
    const rows = store[obj].filter((r) => (where ? evalWhere(r, where) : true));
    return rows.map((r) => ({ ...r }));
  };
  const sfCreateRecord = async (obj, fields) => {
    calls.creates.push({ obj, fields: { ...fields } });
    const rec = { Id: newId(obj), ...fields };
    if (obj === "Sundial_Price_Book_Item__c") rec.Price__c = (Number(fields.Labor_Price__c) || 0) + (Number(fields.Material_Price__c) || 0);
    store[obj].push(rec);
    return { ok: true, id: rec.Id };
  };
  const sfUpdateRecord = async (obj, id, fields) => {
    calls.updates.push({ obj, id, fields: { ...fields } });
    const rec = store[obj].find((r) => r.Id === id);
    if (!rec) throw Object.assign(new Error("not found"), { sfStatus: 404 });
    Object.assign(rec, fields);
    return { ok: true, id };
  };
  const sfDeleteRecord = async (obj, id) => {
    calls.deletes.push({ obj, id });
    const i = store[obj].findIndex((r) => r.Id === id);
    if (i >= 0) store[obj].splice(i, 1);
    return { ok: true };
  };
  const describeObject = async (obj) => ({
    fields: obj === "Sundial_Customer__c"
      ? [
          { name: "Requested_Project_Types__c", picklistValues: [{ value: "Solar", active: true }, { value: "Service", active: true }] },
          { name: "State__c", picklistValues: [{ value: "AZ", label: "Arizona", active: true }] },
        ]
      : [],
  });
  // A PostgREST-shaped stub over three things: stale flags, the activity table, and
  // the file-metadata table (the estimate PDF registers a row there on send).
  const stale = [];
  const activity = [];
  const files = [];
  store.sundial_file_metadata = files;
  const tableRows = (table) => (table === "sundial_service_activity" ? activity : table === "sundial_file_metadata" ? files : null);
  function chain(table, op, patch) {
    const filters = [];
    const q = {
      eq(col, val) { filters.push((r) => r[col] === val); return q; },
      is(col, val) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return q; },
      lt(col, val) { filters.push((r) => r[col] < val); return q; },
      in(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
      order(col, { ascending } = {}) { q._order = { col, ascending }; return q; },
      limit(n) { q._limit = n; return q; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      then(resolve) { resolve(run()); },
    };
    function run() {
      const src = tableRows(table);
      if (!src) {
        if (op === "update") stale.push({ table, patch });
        return { data: [], error: null };
      }
      let rows = src.filter((r) => filters.every((f) => f(r)));
      if (op === "update") { rows.forEach((r) => Object.assign(r, patch)); return { error: null }; }
      if (q._order) rows = [...rows].sort((a, b) => (a[q._order.col] < b[q._order.col] ? 1 : -1) * (q._order.ascending ? -1 : 1));
      if (q._limit) rows = rows.slice(0, q._limit);
      return { data: rows, error: null };
    }
    return q;
  }
  const getSupabaseClient = async () => ({
    from: (table) => ({
      insert: (row) => {
        const src = tableRows(table);
        const stored = src ? { id: src.length + 1, ...row } : null;
        if (src) src.push(stored);
        // Both shapes the code uses: `await insert(row)` and `insert(row).select("id").maybeSingle()`.
        return {
          then: (resolve) => resolve({ error: null }),
          select: () => ({ maybeSingle: async () => ({ data: stored ? { id: stored.id } : null, error: null }) }),
        };
      },
      update: (patch) => chain(table, "update", patch),
      select: () => chain(table, "select"),
    }),
  });
  return { store, calls, stale, activity, emails: [], puts: [], deps: { sfQuery, sfCreateRecord, sfUpdateRecord, sfDeleteRecord, describeObject, getSupabaseClient } };
}

function makeHandler(fake, identityOverrides = {}) {
  const identity = {
    tenantId: TENANT,
    tenantSlug: "harmon",
    user: { id: USER, firstName: "Paige", lastName: "King" },
    access: { level: "Admin", scope: "tenant", userId: USER, tenantId: TENANT },
    ...identityOverrides,
  };
  return createHandler({
    ...fake.deps,
    resolveIdentity: async () => identity,
    now: () => new Date("2026-09-10T12:00:00Z"),
    randomToken: () => "TOKEN123",
    sendEmail: async (msg) => {
      fake.emails.push(msg);
      return fake.emailFails ? { ok: false, error: "boom" } : { ok: true, messageId: "m1" };
    },
    isEmailConfigured: () => fake.emailConfigured !== false,
    publicBaseUrl: fake.publicBaseUrl ?? "https://portal.example.com",
    brandName: "Test Electric",
    // The PDF is rendered for real (pdf-lib) — only the S3 put is recorded.
    putObject: async ({ key, body, contentType }) => {
      if (fake.putFails) throw new Error("s3 down");
      fake.puts.push({ key, bytes: body.byteLength, contentType });
    },
  });
}
const call = (h, method, path, body) =>
  h({ requestContext: { http: { method } }, rawPath: path, headers: { authorization: "Bearer x", origin: "http://localhost:5173" }, body: body ? JSON.stringify(body) : undefined })
    .then((r) => ({ status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }));

test("quick-create job with a NEW customer: customer tagged Service, estimate + job linked 1:1, lines snapshotted, totals stored", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Price_Book_Item__c", { Client__c: TENANT, Name: "Standard Service Call", Item_Code__c: "SVC-CALL-STD", Version__c: 1, Is_Active__c: true, Kind__c: "Labor", Labor_Price__c: 275, Default_Quantity__c: 1, Taxable__c: false, Description__c: "Truck roll + 1.5h diagnosis" });
  const item = fake.store.Sundial_Price_Book_Item__c[0];
  const h = makeHandler(fake);
  const r = await call(h, "POST", "/service/jobs", {
    customer: { new: { firstName: "Ann", lastName: "Lee", email: "ann@example.com", phone: "602-555-0100", street: "123 N Main St", city: "Phoenix", state: "Arizona", postalCode: "85001" } },
    job: { issueDescription: "Inverter fault", priority: "High" },
    lines: [{ priceBookItemId: item.Id }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.customerCreated, true);
  const cust = fake.store.Sundial_Customer__c[0];
  assert.equal(cust.Requested_Project_Types__c, "Service");
  assert.equal(cust.State__c, "AZ");
  assert.equal(cust.Client__c, TENANT);
  const est = fake.store.Sundial_Estimate__c[0];
  const job = fake.store.Sundial_Service_Job__c[0];
  assert.equal(job.Estimate__c, est.Id);
  assert.equal(est.Service_Job__c, job.Id);
  assert.equal(job.Sundial_Customer__c, cust.Id);
  assert.equal(job.Customer_Name_at_Creation__c, "Ann Lee");
  assert.equal(job.Issue_Description__c, "Inverter fault");
  assert.equal(job.Bill_To_Type__c, "Customer");
  const line = fake.store.Sundial_Service_Line__c[0];
  assert.equal(line.Estimate__c, est.Id);
  assert.equal(line.Unit_Price__c, 275);
  assert.equal(line.Source__c, "Price Book");
  assert.equal(est.Total__c, 275);
  assert.equal(est.Labor_Subtotal__c, 275);
  assert.equal(r.body.totals.Total__c, 275);
  // Activity tracker: customer created, job created — every row stamped with the actor.
  const events = fake.activity.map((a) => a.event);
  assert.deepEqual(events, ["customer_created", "job_created"]);
  assert.ok(fake.activity.every((a) => a.actor_name === "Paige King" && a.actor_user_sf_id === USER && a.client_sf_id === TENANT));
  assert.equal(fake.activity[1].job_sf_id, job.Id);
  assert.equal(fake.activity[1].estimate_sf_id, est.Id);
  assert.equal(fake.activity[1].details.linesCreated, 1);
  const feed = await call(h, "GET", `/service/jobs/${job.Id}/activity`);
  assert.equal(feed.status, 200);
  assert.equal(feed.body.activity.length, 2);
  assert.equal(feed.body.activity[0].event, "job_created", "newest first");
});

test("new customer that looks like an existing one → 409 with candidates; confirmNew creates anyway; existing id gets Service union-added", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Bob Ray", Primary_Email__c: "bob@x.com", Requested_Project_Types__c: "Solar" });
  const existing = fake.store.Sundial_Customer__c[0];
  const h = makeHandler(fake);
  const dup = await call(h, "POST", "/service/estimates", { customer: { new: { firstName: "Robert", lastName: "Ray", email: "BOB@x.com" } } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "DUPLICATE_CANDIDATES");
  assert.deepEqual(dup.body.candidates[0].reasons, ["email"]);
  assert.equal(fake.store.Sundial_Estimate__c.length, 0);

  const forced = await call(h, "POST", "/service/estimates", { customer: { new: { firstName: "Robert", lastName: "Ray", email: "BOB@x.com" }, confirmNew: true } });
  assert.equal(forced.status, 201);
  assert.equal(fake.store.Sundial_Customer__c.length, 2);

  const picked = await call(h, "POST", "/service/estimates", { customer: { id: existing.Id } });
  assert.equal(picked.status, 201);
  assert.equal(existing.Requested_Project_Types__c, "Solar;Service");
  // A second pick does not rewrite the field.
  const before = fake.calls.updates.length;
  await call(h, "POST", "/service/estimates", { customer: { id: existing.Id } });
  const tagWrites = fake.calls.updates.slice(before).filter((u) => u.fields.Requested_Project_Types__c);
  assert.equal(tagWrites.length, 0);
});

test("cross-tenant customer id is a 404, never a create", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: OTHER_TENANT, Name: "Not Yours" });
  const h = makeHandler(fake);
  const r = await call(h, "POST", "/service/estimates", { customer: { id: fake.store.Sundial_Customer__c[0].Id } });
  assert.equal(r.status, 404);
  assert.equal(fake.store.Sundial_Estimate__c.length, 0);
});

test("estimate lifecycle: add ad-hoc + catalog lines, patch discount, send versions + token, approve stages lines, create-job once", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Cy", Primary_Phone__c: "602-555-0001" });
  await fake.deps.sfCreateRecord("Sundial_Price_Book_Item__c", { Client__c: TENANT, Name: "Disconnect", Item_Code__c: "MAT-DISC", Version__c: 1, Is_Active__c: true, Kind__c: "Material", Material_Price__c: 120, Material_Cost__c: 60, Taxable__c: true });
  const cust = fake.store.Sundial_Customer__c[0];
  const item = fake.store.Sundial_Price_Book_Item__c[0];
  const h = makeHandler(fake);

  const c = await call(h, "POST", "/service/estimates", { customer: { id: cust.Id }, estimate: { taxRate: 8.6 } });
  assert.equal(c.status, 201);
  const estId = c.body.id;

  const l1 = await call(h, "POST", `/service/estimates/${estId}/lines`, { description: "Labor", kind: "Labor", unitPrice: 275 });
  assert.equal(l1.status, 201);
  const l2 = await call(h, "POST", `/service/estimates/${estId}/lines`, { priceBookItemId: item.Id, quantity: 2 });
  assert.equal(l2.status, 201);
  // labor 275 (not taxable) + material 240 (taxable) = 515; tax 8.6% of 240 = 20.64
  assert.equal(l2.body.totals.Subtotal__c, 515);
  assert.equal(l2.body.totals.Tax_Amount__c, 20.64);
  assert.equal(l2.body.totals.Total__c, 535.64);

  const p = await call(h, "PATCH", `/service/estimates/${estId}`, { discountScope: "Material", discountType: "Percent", discountValue: 10, bogus: 1 });
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.rejectedFields, ["bogus"]);
  assert.equal(p.body.totals.Discount_Amount__c, 24);
  // net 491; taxable 240 scaled 240*491/515 = 228.815... * .086 = 19.68
  assert.equal(p.body.totals.Tax_Amount__c, 19.68);
  assert.equal(p.body.totals.Total__c, 510.68);

  const s1 = await call(h, "POST", `/service/estimates/${estId}/send`, {});
  assert.equal(s1.status, 200);
  assert.equal(s1.body.version, 1);
  assert.equal(s1.body.publicToken, "TOKEN123");
  assert.equal(s1.body.validUntil, "2026-10-10");
  const s2 = await call(h, "POST", `/service/estimates/${estId}/send`, { via: "SMS" });
  assert.equal(s2.body.version, 2);
  const est = fake.store.Sundial_Estimate__c[0];
  const log = JSON.parse(est.Version_Log__c);
  assert.equal(log.length, 2);
  assert.equal(log[1].sentVia, "SMS");
  assert.equal(log[1].lines.length, 2);
  assert.equal(est.Status__c, "Sent");

  const a = await call(h, "POST", `/service/estimates/${estId}/approve`, { method: "Online", name: "Cy Customer" });
  assert.equal(a.status, 200);
  assert.equal(a.body.approvedVersion, 2);
  assert.equal(a.body.approvedAmount, 510.68);
  assert.ok(fake.store.Sundial_Service_Line__c.every((l) => l.Stage__c === "Approved"));

  const j = await call(h, "POST", `/service/estimates/${estId}/create-job`, { job: { priority: "Emergency" } });
  assert.equal(j.status, 201);
  const job = fake.store.Sundial_Service_Job__c[0];
  assert.equal(job.Intake_Channel__c, "Estimate Conversion");
  assert.equal(job.Priority__c, "Emergency");
  assert.equal(fake.store.Sundial_Estimate__c[0].Service_Job__c, job.Id);
  const again = await call(h, "POST", `/service/estimates/${estId}/create-job`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "ESTIMATE_HAS_JOB");

  // Lines stay editable after they are added (Tim, 9/11): a description-only edit on an
  // approved line keeps it Approved; a price edit drops it to Proposed for re-approval and
  // flags the override against the catalog.
  const catalogLine = fake.store.Sundial_Service_Line__c.find((l) => l.Price_Book_Item__c);
  const d1 = await call(h, "PATCH", `/service/estimates/${estId}/lines/${catalogLine.Id}`, { description: "Square D disconnect, 60A, as discussed on site" });
  assert.equal(d1.status, 200);
  assert.equal(d1.body.needsReapproval, false);
  assert.equal(catalogLine.Stage__c, "Approved");
  const d2 = await call(h, "PATCH", `/service/estimates/${estId}/lines/${catalogLine.Id}`, { unitPrice: 135 });
  assert.equal(d2.status, 200);
  assert.equal(d2.body.needsReapproval, true);
  assert.equal(catalogLine.Stage__c, "Proposed");
  assert.equal(catalogLine.Price_Overridden__c, true);
  assert.equal(catalogLine.Unit_Price__c, 135);
  const noop = await call(h, "PATCH", `/service/estimates/${estId}/lines/${catalogLine.Id}`, { unitPrice: 135 });
  assert.equal(noop.body.unchanged, true);

  // The estimate's pre-job history was re-keyed to the job when the job was created, so
  // the job feed starts at the first quote.
  const feed = await call(h, "GET", `/service/jobs/${job.Id}/activity`);
  const evs = feed.body.activity.map((a) => a.event).reverse();
  assert.deepEqual(evs, ["customer_tagged", "estimate_created", "line_added", "line_added", "estimate_updated", "estimate_sent", "estimate_sent", "estimate_approved", "job_created", "line_updated", "line_updated"]);
  const priceEdit = feed.body.activity[0];
  assert.deepEqual(priceEdit.details.fields.Unit_Price__c, { from: 120, to: 135 });
  assert.equal(priceEdit.details.needsReapproval, true);

  // After the price edit: labor 275 + material 2 x 135 = 545; 10% material discount 27;
  // net 518; tax on 270 scaled by 518/545 at 8.6% = 22.07 → 540.07.
  const g = await call(h, "GET", `/service/estimates/${estId}`);
  assert.equal(g.status, 200);
  assert.equal(g.body.lines.length, 2);
  assert.equal(g.body.totals.total, 540.07);
});

test("save an ad-hoc line to the price book: PATCH priceBookItemId links the line, adopts the item's split, keeps the price", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "L" });
  const h = makeHandler(fake);
  const e = await call(h, "POST", "/service/estimates", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Replace 200A main breaker", kind: "Material", unitPrice: 340, quantity: 1 }] });
  assert.equal(e.status, 201);
  const line = fake.store.Sundial_Service_Line__c[0];
  assert.equal(line.Source__c, "Ad hoc");
  assert.equal(line.Price_Book_Item__c, undefined);

  // The portal creates the item from the line, then links the line to it.
  const item = await call(h, "POST", "/service/price-book-items", { name: "Replace 200A main breaker", itemCode: "MAT-MAIN-200", kind: "Material", materialPrice: 340, materialCost: 190, taxable: true });
  assert.equal(item.status, 201);
  const link = await call(h, "PATCH", `/service/estimates/${e.body.id}/lines/${line.Id}`, { priceBookItemId: item.body.id });
  assert.equal(link.status, 200);
  assert.equal(link.body.priceBookItemId, item.body.id);
  assert.equal(line.Price_Book_Item__c, item.body.id);
  assert.equal(line.Source__c, "Price Book");
  assert.equal(line.Unit_Price__c, 340, "the line's own price is kept");
  assert.equal(line.Unit_Material_Price__c, 340);
  assert.equal(line.Unit_Material_Cost__c, 190);
  assert.equal(line.Taxable__c, true, "taxability comes from the item");
  assert.equal(line.Price_Overridden__c, false, "saved at the item's own price → not an override");
  assert.equal(line.Description__c, "Replace 200A main breaker");
  const feed = fake.store.Sundial_Service_Line__c.length; // unchanged: no new line was created
  assert.equal(feed, 1);

  // Linking to a superseded version is refused; an unknown id too.
  await call(h, "POST", `/service/price-book-items/${item.body.id}/new-version`, { materialPrice: 360 });
  const stale = await call(h, "PATCH", `/service/estimates/${e.body.id}/lines/${line.Id}`, { priceBookItemId: item.body.id });
  assert.equal(stale.status, 400);
  assert.equal(stale.body.code, "ITEM_NOT_ACTIVE");
  const missing = await call(h, "PATCH", `/service/estimates/${e.body.id}/lines/${line.Id}`, { priceBookItemId: "a0X000000000000AAA" });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "ITEM_NOT_FOUND");
});

test("templates: add-template re-snapshots from the ACTIVE version, keeps quantity", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "T" });
  await fake.deps.sfCreateRecord("Sundial_Price_Book_Item__c", { Client__c: TENANT, Name: "Inverter", Item_Code__c: "INV-7", Version__c: 1, Is_Active__c: true, Kind__c: "Product", Labor_Price__c: 500, Material_Price__c: 2000, Taxable__c: true });
  const v1 = fake.store.Sundial_Price_Book_Item__c[0];
  const h = makeHandler(fake);
  const t = await call(h, "POST", "/service/estimates", { isTemplate: true, estimate: { templateName: "Fronius 7.7" }, lines: [{ priceBookItemId: v1.Id, quantity: 1 }, { description: "Permit", kind: "Fee", unitPrice: 150 }] });
  assert.equal(t.status, 201);
  assert.equal(fake.store.Sundial_Estimate__c[0].Status__c, "Template");
  // Price goes up via new-version
  const nv = await call(h, "POST", `/service/price-book-items/${v1.Id}/new-version`, { materialPrice: 2200 });
  assert.equal(nv.status, 201);
  assert.equal(nv.body.version, 2);
  assert.equal(v1.Is_Active__c, false);
  assert.equal(v1.Superseded_By__c, nv.body.id);
  // Working estimate from the template
  const e = await call(h, "POST", "/service/estimates", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, templateId: t.body.id });
  assert.equal(e.status, 201);
  assert.equal(e.body.linesCreated, 2);
  const lines = fake.store.Sundial_Service_Line__c.filter((l) => l.Estimate__c === e.body.id);
  const inv = lines.find((l) => l.Price_Book_Item__c);
  assert.equal(inv.Price_Book_Item__c, nv.body.id, "points at v2, not the superseded v1");
  assert.equal(inv.Unit_Price__c, 2700);
  assert.equal(inv.Source__c, "Template");
  assert.equal(e.body.totals.Subtotal__c, 2850);
});

test("price book: duplicate active code 409; in-place edit blocked once referenced; deactivate", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "P" });
  const h = makeHandler(fake);
  const c1 = await call(h, "POST", "/service/price-book-items", { name: "Std", itemCode: "svc-call-std", kind: "Labor", laborPrice: 275 });
  assert.equal(c1.status, 201);
  const c2 = await call(h, "POST", "/service/price-book-items", { name: "Std again", itemCode: "SVC-CALL-STD", kind: "Labor", laborPrice: 300 });
  assert.equal(c2.status, 409);
  assert.equal(c2.body.code, "ITEM_CODE_IN_USE");
  const edit = await call(h, "PATCH", `/service/price-book-items/${c1.body.id}`, { laborPrice: 280, itemCode: "HACK" });
  assert.equal(edit.status, 200);
  assert.equal(fake.store.Sundial_Price_Book_Item__c[0].Item_Code__c, "SVC-CALL-STD");
  const e = await call(h, "POST", "/service/estimates", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ priceBookItemId: c1.body.id }] });
  assert.equal(e.status, 201);
  const locked = await call(h, "PATCH", `/service/price-book-items/${c1.body.id}`, { laborPrice: 999 });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, "ITEM_IN_USE");
  const off = await call(h, "POST", `/service/price-book-items/${c1.body.id}/deactivate`, {});
  assert.equal(off.status, 200);
  assert.equal(fake.store.Sundial_Price_Book_Item__c[0].Is_Active__c, false);
  const stale = await call(h, "POST", `/service/price-book-items/${c1.body.id}/new-version`, { laborPrice: 1 });
  assert.equal(stale.body.code, "ITEM_NOT_ACTIVE");
});

test("access: a sales-scope or none-scope caller is refused before any Salesforce call", async () => {
  for (const access of [{ level: "Sales Rep", scope: "own", userId: USER, tenantId: TENANT, dealerId: "D1" }, { level: "Technician", scope: "none", userId: USER, tenantId: TENANT }]) {
    const fake = fakeSalesforce();
    const h = makeHandler(fake, { access });
    const r = await call(h, "POST", "/service/estimates", { customer: { new: { firstName: "X", email: "x@y.z" } } });
    assert.equal(r.status, 403, access.level);
    assert.equal(fake.calls.queries.length, 0);
  }
});

test("job create failure after the estimate was created compensates and reports", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Q" });
  const realCreate = fake.deps.sfCreateRecord;
  fake.deps.sfCreateRecord = async (obj, fields) => {
    if (obj === "Sundial_Service_Job__c") throw Object.assign(new Error("boom"), { sfStatus: 400, sfBody: "REQUIRED_FIELD_MISSING" });
    return realCreate(obj, fields);
  };
  const h = makeHandler(fake);
  const r = await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id } });
  assert.equal(r.status, 502);
  assert.equal(r.body.estimateRemoved, true);
  assert.equal(fake.store.Sundial_Estimate__c.length, 0);
});

test("renderEstimateDocument: escapes, hides markup, shows discount/tax/deposit rows, preview watermark", () => {
  const { html, title } = renderEstimateDocument({
    estimate: { Name: "EST-00007", Version__c: 2, Customer_Name_at_Creation__c: "O'Brien <Bob>", Scope_Summary__c: "Replace inverter", Discount_Source__c: "Service Plan", Deposit_Required__c: true, Tax_Jurisdiction__c: "Phoenix" },
    lines: [
      { Description__c: "Labor <b>", Quantity__c: 1.5, Unit_of_Measure__c: "Hour", Unit_Price__c: 200, Line_Total__c: 300, Stage__c: "Approved" },
      { Description__c: "Gone", Quantity__c: 1, Unit_Price__c: 999, Line_Total__c: 999, Stage__c: "Removed" },
    ],
    totals: { subtotal: 300, discountAmount: 30, markupAmount: 50, taxAmount: 10, total: 330, depositAmount: 82.5 },
    brand: { companyName: "Acme Solar", licenseLine: "ROC #1" },
    options: { mode: "preview" },
  });
  assert.equal(title, "EST-00007 v2");
  assert.ok(html.includes("O&#39;Brien &lt;Bob&gt;"));
  assert.ok(html.includes("Labor &lt;b&gt;"));
  assert.ok(!html.includes("Gone"), "removed lines are not printed");
  assert.ok(!/markup/i.test(html), "markup is never printed");
  assert.ok(html.includes("Service plan discount"));
  assert.ok(html.includes("Tax (Phoenix)"));
  assert.ok(html.includes("Deposit due to schedule"));
  assert.ok(html.includes("PREVIEW"));
  assert.ok(html.includes("1.50 Hour"));
  assert.ok(html.includes("Acme Solar") && html.includes("ROC #1"));
});

test("GET …/preview returns the rendered document for a tenant-owned estimate, 404 otherwise", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Pv" });
  const h = makeHandler(fake);
  const c = await call(h, "POST", "/service/estimates", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Truck roll", kind: "Labor", unitPrice: 275 }] });
  const p = await call(h, "GET", `/service/estimates/${c.body.id}/preview`);
  assert.equal(p.status, 200);
  assert.ok(p.body.html.includes("Truck roll"));
  assert.ok(p.body.html.includes("$275.00"));
  assert.equal(p.body.title, fake.store.Sundial_Estimate__c[0].Name ?? "Estimate");
  const nf = await call(h, "GET", "/service/estimates/000000000000000000/preview");
  assert.equal(nf.status, 404);
});

test("send: emails the customer the link, records delivery; degrades honestly with no email / no base URL / SES failure", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Em", Primary_Email__c: "em@example.com" });
  const h = makeHandler(fake);
  const c = await call(h, "POST", "/service/estimates", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Truck roll", kind: "Labor", unitPrice: 275 }] });
  const s1 = await call(h, "POST", `/service/estimates/${c.body.id}/send`, {});
  assert.equal(s1.status, 200);
  assert.equal(s1.body.delivery, "email");
  assert.equal(s1.body.recipient, "em@example.com");
  assert.equal(s1.body.publicUrl, "https://portal.example.com/estimate/TOKEN123");
  assert.equal(fake.emails.length, 1);
  assert.ok(fake.emails[0].subject.includes("$275.00"));
  assert.ok(fake.emails[0].html.includes("https://portal.example.com/estimate/TOKEN123"));
  assert.ok(fake.emails[0].text.includes("/estimate/TOKEN123"));
  const sentRow = fake.activity.find((a) => a.event === "estimate_sent");
  assert.equal(sentRow.details.delivery, "email");

  // The PDF of this version: rendered, stored with the estimate's files, attached to
  // the email, recorded in the version log and the activity row.
  const estId = c.body.id;
  assert.equal(s1.body.pdfKey, `SUNDIAL/${estId}/estimate-v1.pdf`);
  assert.ok(s1.body.pdfUrl.endsWith(`/SUNDIAL/${estId}/estimate-v1.pdf`));
  assert.equal(fake.puts.length, 1);
  assert.equal(fake.puts[0].contentType, "application/pdf");
  assert.ok(fake.puts[0].bytes > 1000);
  assert.equal(fake.emails[0].attachments.length, 1);
  assert.ok(fake.emails[0].attachments[0].fileName.endsWith("-v1.pdf"));
  assert.equal(Buffer.from(fake.emails[0].attachments[0].content.slice(0, 5)).toString(), "%PDF-");
  const rec = fake.store.Sundial_Estimate__c.find((r) => r.Id === estId);
  assert.equal(JSON.parse(rec.Version_Log__c)[0].pdfKey, `SUNDIAL/${estId}/estimate-v1.pdf`);
  assert.equal(sentRow.details.pdfKey, `SUNDIAL/${estId}/estimate-v1.pdf`);
  const metaRows = fake.store.sundial_file_metadata || [];
  assert.equal(metaRows.length, 1);
  assert.equal(metaRows[0].category, "Estimate");
  assert.equal(metaRows[0].sf_record_id, estId);

  // Explicit recipient override wins; SMS is recorded only.
  const s2 = await call(h, "POST", `/service/estimates/${c.body.id}/send`, { to: "other@example.com", via: "Both" });
  assert.equal(s2.body.recipient, "other@example.com");
  assert.ok(s2.body.deliveryDetail.includes("SMS is not live"));

  // SES failure: version still bumps, delivery says recorded + why.
  fake.emailFails = true;
  const s3 = await call(h, "POST", `/service/estimates/${c.body.id}/send`, {});
  assert.equal(s3.body.version, 3);
  assert.equal(s3.body.delivery, "recorded");
  assert.ok(s3.body.deliveryDetail.includes("boom"));

  // No base URL configured: nothing goes out, and it says so.
  fake.emailFails = false;
  fake.publicBaseUrl = "";
  const h2 = makeHandler(fake);
  const s4 = await call(h2, "POST", `/service/estimates/${c.body.id}/send`, {});
  assert.equal(s4.body.delivery, "recorded");
  assert.ok(s4.body.deliveryDetail.includes("SERVICE_PUBLIC_BASE_URL"));
  assert.equal(s4.body.publicUrl, null);

  // S3 down: the send still goes through — email without the attachment, pdfKey null,
  // and the office is told.
  fake.publicBaseUrl = "https://portal.example.com";
  fake.putFails = true;
  const h3 = makeHandler(fake);
  const s5 = await call(h3, "POST", `/service/estimates/${c.body.id}/send`, {});
  assert.equal(s5.status, 200);
  assert.equal(s5.body.version, 5);
  assert.equal(s5.body.delivery, "email");
  assert.equal(s5.body.pdfKey, null);
  assert.ok(s5.body.deliveryDetail.includes("PDF could not be generated"));
  assert.equal(fake.emails.at(-1).attachments.length, 0);
});

