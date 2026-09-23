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
import { paidSummary, invoiceStatusFor, jobPaymentStatusFor, nextInvoiceName, paymentFieldsFromBody, invoicePdfKey } from "./invoice.js";
import { clockMinutes, roundUpQuarterHours, laborRow, parseLaborEntry } from "./labor.js";
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
test("matchRoute: the club's public routes strip the stage prefix too and never need a token (D-073)", () => {
  assert.deepEqual(matchRoute("GET", "/prod/public/club/harmon/plans"), { name: "clubPlans", params: ["harmon"] });
  assert.deepEqual(matchRoute("POST", "/public/club/harmon/join"), { name: "clubJoin", params: ["harmon"] });
  assert.equal(matchRoute("GET", "/public/club/harmon/memberships"), null, "the office list is not public");
});

test("matchRoute strips a stage prefix and captures ids", () => {
  assert.deepEqual(matchRoute("POST", "/prod/service/estimates/abc/lines"), { name: "addLine", params: ["abc"] });
  assert.deepEqual(matchRoute("DELETE", "/service/estimates/a/lines/b"), { name: "deleteLine", params: ["a", "b"] });
  assert.equal(matchRoute("GET", "/service/nope"), null);
});

function fakeSalesforce() {
  const store = { Sundial_Customer__c: [], Sundial_Estimate__c: [], Sundial_Service_Job__c: [], Sundial_Price_Book_Item__c: [], Sundial_Service_Line__c: [], Sundial_Service_Invoice__c: [], Sundial_Service_Payment__c: [], Sundial_Service_Call__c: [], Sundial_User__c: [], Sundial_Service_Plan__c: [], Sundial_Membership__c: [], Sundial_Tenant__c: [{ Id: TENANT, Name: "harmon" }] };
  let seq = 0;
  const calls = { creates: [], updates: [], deletes: [], queries: [] };
  const fetches = [];
  const newId = (obj) => `${obj.slice(8, 11).toUpperCase()}${String(++seq).padStart(15, "0")}`.slice(0, 18);

  function evalCond(rec, cond) {
    cond = cond.trim().replace(/^\(|\)$/g, "");
    let m;
    if ((m = cond.match(/^(\w+) = '(.*)'$/))) return String(rec[m[1]] ?? "").toLowerCase() === m[2].replace(/\\'/g, "'").toLowerCase();
    if ((m = cond.match(/^(\w+) != '(.*)'$/))) return String(rec[m[1]] ?? "").toLowerCase() !== m[2].toLowerCase();
    if ((m = cond.match(/^(\w+) != null$/))) return rec[m[1]] != null;
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
    // The one relationship the labor routes read: a call's Tech__r (name + bill rate).
    return rows.map((r) => (obj === "Sundial_Service_Call__c" && r.Tech__c ? { ...r, Tech__r: store.Sundial_User__c.find((u) => u.Id === r.Tech__c) ?? null } : { ...r }));
  };
  const sfCreateRecord = async (obj, fields) => {
    calls.creates.push({ obj, fields: { ...fields } });
    const rec = { Id: newId(obj), ...fields };
    if (obj === "Sundial_Price_Book_Item__c") rec.Price__c = (Number(fields.Labor_Price__c) || 0) + (Number(fields.Material_Price__c) || 0);
    // Autonumber names the org assigns (the invoice number is the job number).
    if (obj === "Sundial_Service_Job__c" && !rec.Name) rec.Name = `SVC-${String(store[obj].length + 1).padStart(5, "0")}`;
    if (obj === "Sundial_Service_Payment__c" && !rec.Name) rec.Name = `PAY-${String(store[obj].length + 1).padStart(5, "0")}`;
    if (obj === "Sundial_Membership__c" && !rec.Name) rec.Name = `MEM-${String(store[obj].length + 1).padStart(5, "0")}`;
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
  const flags = {}; // test switches read by the fakes below (fake.flags.*)
  const describeObject = async (obj) => ({
    fields: obj === "Sundial_Customer__c"
      ? [
          { name: "Requested_Project_Types__c", picklistValues: [{ value: "Solar", active: true }, { value: "Service", active: true }] },
          { name: "Customer_Type__c", picklistValues: [{ value: "Solar", active: true }, { value: "Roofing", active: true }, { value: "Commercial", active: true }, { value: "Service", active: true }] },
          { name: "State__c", picklistValues: [{ value: "AZ", label: "Arizona", active: true }] },
          // D-075 (2026-09-23): the Service pipeline fields. `fake.noServiceFields` hides them
          // to pin the "org without the package" path.
          ...(flags.noServiceFields ? [] : [
            { name: "Service_Stage__c", picklistValues: ["New", "Contact Attempt Made", "In Progress", "Waiting on Customer", "Waiting on Other Department", "Estimate Created", "Resolved", "Closed"].map((value) => ({ value, active: true })) },
            { name: "Service_Request_Type__c", picklistValues: ["System Not Producing", "Monitoring Offline", "Roof Leak", "General Question", "Other"].map((value) => ({ value, active: true })) },
            { name: "Lead_Source__c", picklistValues: ["Web", "Referral", "Previous Customer", "Harmon Direct"].map((value) => ({ value, active: true })) },
          ]),
        ]
      : [],
  });
  // A PostgREST-shaped stub over three things: stale flags, the activity table, and
  // the file-metadata table (the estimate PDF registers a row there on send).
  const stale = [];
  const activity = [];
  const files = [];
  const stripeEvents = []; // the Stripe webhook ledger (sundial_stripe_events)
  store.sundial_file_metadata = files;
  store.sundial_stripe_events = stripeEvents;
  const tableRows = (table) => (table === "sundial_service_activity" ? activity : table === "sundial_file_metadata" ? files : table === "sundial_stripe_events" ? stripeEvents : null);
  function chain(table, op, patch) {
    const filters = [];
    const q = {
      eq(col, val) { filters.push((r) => r[col] === val); return q; },
      is(col, val) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return q; },
      lt(col, val) { filters.push((r) => r[col] < val); return q; },
      gte(col, val) { filters.push((r) => r[col] >= val); return q; },
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
      // upsert on the primary key (the ledger's Stripe event id).
      upsert: (row) => {
        const src = tableRows(table);
        if (src) {
          const cur = src.find((r) => r.id === row.id);
          if (cur) Object.assign(cur, row);
          else src.push({ ...row });
        }
        return { then: (resolve) => resolve({ error: null }) };
      },
    }),
  });
  // Notifications (D-074): recorded, never delivered.
  const notes = [];
  const notifier = {
    toOffice: async (n) => (notes.push({ to: "office", ...n }), { inserted: 1, skipped: 0, pushed: 0 }),
    toUsers: async (n) => (notes.push({ to: "users", ...n }), { inserted: 1, skipped: 0, pushed: 0 }),
    toProfile: async (n) => (notes.push({ to: "profile", ...n }), { inserted: 1, skipped: 0, pushed: 0 }),
  };
  return { store, calls, stale, activity, stripeEvents, notes, flags, emails: [], puts: [], fetches, deps: { sfQuery, sfCreateRecord, sfUpdateRecord, sfDeleteRecord, describeObject, getSupabaseClient, notifier } };
}

const JPG_1x1 = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");

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
    deleteObject: async ({ key }) => {
      (fake.deletes = fake.deletes || []).push(key);
    },
    // The job report (D-072 am. 10): the job's S3 folder and the photo bytes for the PDF.
    listFiles: async (recordId) => (fake.files || []).filter((f) => f.key.startsWith(`SUNDIAL/${recordId}/`)),
    getObject: async ({ key }) => {
      (fake.gets = fake.gets || []).push(key);
      if (fake.getFails) throw new Error("s3 read failed");
      return { bytes: JPG_1x1, contentType: "image/jpeg" };
    },
    sms: fake.sms ?? null,
    getSecret: async (name) => {
      if (name === "sundial/google-maps" && fake.googleKey) return { apiKey: fake.googleKey };
      if (name === "sundial/stripe" && fake.stripeSecret) return fake.stripeSecret;
      if (name === "sundial/service-club" && fake.clubSecret) return fake.clubSecret;
      const e = new Error("not found");
      e.name = "ResourceNotFoundException";
      throw e;
    },
    fetchUrl: async (url, init) => {
      fake.fetches.push(url);
      if (url.startsWith("https://api.stripe.com/") && fake.stripe) return fake.stripe(url, init);
      if (url.startsWith("https://hooks.zapier.com/")) {
        fake.hookBodies = fake.hookBodies || [];
        fake.hookBodies.push({ url, body: JSON.parse(init.body) });
        return { ok: !fake.hookFails, status: fake.hookFails ? 500 : 200, json: async () => ({}) };
      }
      if (url.startsWith("https://api.solardatapros.com/")) {
        fake.solarFaxCalls = fake.solarFaxCalls || [];
        const body = JSON.parse(init.body);
        fake.solarFaxCalls.push({ url, headers: init.headers, body });
        if (fake.solarFaxFails) return { ok: true, status: 200, json: async () => ({ success: false, message: "Invalid Api-Key" }) };
        const action = body.disconnect === "1" ? "disconnected" : "created";
        return { ok: true, status: 200, json: async () => ({ success: true, message: `User '${body.user.firstName} ${body.user.lastName}' ${action}`, action, account_id: "SFA-1", user_id: "SFU-1" }) };
      }
      if (url.startsWith("https://places.googleapis.com/v1/places:autocomplete")) {
        fake.placesCalls = fake.placesCalls || [];
        fake.placesCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        if (fake.placesFails) return { ok: false, status: 403, json: async () => ({ error: { message: "This API project is not authorized" } }) };
        return { ok: true, status: 200, json: async () => ({ suggestions: [
          { placePrediction: { placeId: "PID1", text: { text: "1 Palm Ln, Mesa, AZ 85201, USA" }, structuredFormat: { mainText: { text: "1 Palm Ln" }, secondaryText: { text: "Mesa, AZ 85201, USA" } } } },
          { placePrediction: { placeId: "PID2", text: { text: "1 Palm Ln #4, Mesa, AZ 85201, USA" }, structuredFormat: { mainText: { text: "1 Palm Ln #4" }, secondaryText: { text: "Mesa, AZ 85201, USA" } } } },
          { queryPrediction: { text: { text: "palm lane" } } },
        ] }) };
      }
      if (url.startsWith("https://places.googleapis.com/v1/places/")) {
        fake.placesCalls = fake.placesCalls || [];
        fake.placesCalls.push({ url, headers: init.headers });
        return { ok: true, status: 200, json: async () => ({ id: "PID2", formattedAddress: "1 Palm Ln #4, Mesa, AZ 85201, USA", location: { latitude: 33.41, longitude: -111.83 }, addressComponents: [
          { longText: "4", shortText: "4", types: ["subpremise"] },
          { longText: "1", shortText: "1", types: ["street_number"] },
          { longText: "Palm Lane", shortText: "Palm Ln", types: ["route"] },
          { longText: "Mesa", shortText: "Mesa", types: ["locality", "political"] },
          { longText: "Maricopa County", shortText: "Maricopa County", types: ["administrative_area_level_2", "political"] },
          { longText: "Arizona", shortText: "AZ", types: ["administrative_area_level_1", "political"] },
          { longText: "United States", shortText: "US", types: ["country", "political"] },
          { longText: "85201", shortText: "85201", types: ["postal_code"] },
          { longText: "1234", shortText: "1234", types: ["postal_code_suffix"] },
        ] }) };
      }
      if (url.includes("/streetview/metadata")) {
        const status = fake.streetViewStatus ?? "OK";
        return { ok: true, json: async () => (status === "OK" ? { status, pano_id: "PANO1", location: { lat: 33.4, lng: -112.0 } } : { status }) };
      }
      return { ok: true, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer };
    },
  });
}
const call = (h, method, path, body, query) =>
  h({ requestContext: { http: { method } }, rawPath: path, headers: { authorization: "Bearer x", origin: "http://localhost:5173" }, body: body ? JSON.stringify(body) : undefined, queryStringParameters: query })
    .then((r) => ({ status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }));

test("POST /service/customers (D-075): a NEW customer is tagged Service and opened at Service_Stage New with the request; an existing customer is tagged without losing its stage; the duplicate guard still applies; an org without the fields still gets its customer", async () => {
  const fake = fakeSalesforce();
  const h = makeHandler(fake);
  const r = await call(h, "POST", "/service/customers", {
    customer: { new: { firstName: "Nora", lastName: "Quinn", phone: "602-555-0177", street: "9 Ash Ct", city: "Mesa", state: "AZ", postalCode: "85201" } },
    request: { requestType: "Roof Leak", description: "Water stain under the array after the storm", assignedTo: "a0U000000000001AAA", nextFollowUp: "2026-09-25", leadSource: "Web" },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.customerCreated, true);
  assert.equal(r.body.serviceStage, "New");
  const cust = fake.store.Sundial_Customer__c.find((c) => c.Id === r.body.customerId);
  assert.equal(cust.Customer_Type__c, "Service");
  assert.equal(cust.Requested_Project_Types__c, "Service");
  assert.equal(cust.Service_Stage__c, "New");
  assert.equal(cust.Service_Request_Type__c, "Roof Leak");
  assert.equal(cust.Description__c, "Water stain under the array after the storm");
  assert.equal(cust.Assigned_To__c, "a0U000000000001AAA");
  assert.ok(cust.Assigned_Date__c, "assigning stamps the date");
  assert.equal(cust.Next_Follow_Up_Date__c, "2026-09-25");
  assert.equal(cust.Lead_Source__c, "Web");
  assert.ok(fake.activity.some((a) => a.event === "customer_created" && a.record_sf_id === cust.Id));
  assert.ok(fake.activity.some((a) => a.event === "customer_tagged" && a.details.service === true));
  assert.deepEqual(r.body.warnings, []);

  // The same phone again → the duplicate guard (409), unless confirmNew.
  const dup = await call(h, "POST", "/service/customers", { customer: { new: { firstName: "N", lastName: "Q", phone: "(602) 555-0177" } } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "DUPLICATE_CANDIDATES");

  // An old solar customer who calls in: tagged, stage opened at New — once.
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Old Solar", Primary_Email__c: "old@x.com", Customer_Type__c: "Solar", Requested_Project_Types__c: "Solar", Service_Stage__c: "In Progress" });
  const oldId = fake.store.Sundial_Customer__c.at(-1).Id;
  const add = await call(h, "POST", "/service/customers", { customer: { id: oldId } });
  assert.equal(add.status, 200);
  assert.equal(add.body.customerCreated, false);
  assert.equal(add.body.serviceStage, "In Progress", "a stage already set is never overwritten");
  const old = fake.store.Sundial_Customer__c.find((c) => c.Id === oldId);
  assert.equal(old.Customer_Type__c, "Solar;Service");
  assert.equal(old.Service_Stage__c, "In Progress");
  const plain = await call(h, "POST", "/service/customers", { customer: { id: oldId }, request: { requestType: "Not a type" } });
  assert.match(plain.body.warnings.join(" "), /Request type "Not a type"/);

  // The org without the package: the customer is created and the reason is said.
  fake.flags.noServiceFields = true;
  const h2 = makeHandler(fake);
  const bare = await call(h2, "POST", "/service/customers", { customer: { new: { firstName: "Bare", lastName: "Org", email: "bare@x.com" } } });
  assert.equal(bare.status, 201);
  assert.equal(bare.body.serviceStage, null);
  assert.match(bare.body.warnings.join(" "), /Service_Stage__c is not in this org yet/);
});

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
  assert.equal(cust.Customer_Type__c, "Service", "the department tag (2026-09-19) is set the same way");
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
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Bob Ray", Primary_Email__c: "bob@x.com", Requested_Project_Types__c: "Solar", Customer_Type__c: "Solar" });
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
  assert.equal(existing.Customer_Type__c, "Solar;Service", "a Solar customer who books service is both");
  // A second pick does not rewrite the fields.
  const before = fake.calls.updates.length;
  await call(h, "POST", "/service/estimates", { customer: { id: existing.Id } });
  const tagWrites = fake.calls.updates.slice(before).filter((u) => u.fields.Requested_Project_Types__c || u.fields.Customer_Type__c);
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


test("address lookup (2026-09-22): unconfigured without the secret; suggestions via Google Places with the key server-side and the session passed through; a pick resolves to the four form fields", async () => {
  const fake = fakeSalesforce();
  const h = makeHandler(fake);
  // No key → the form just types; never an error in the office's face.
  const u = await call(h, "GET", "/service/address/suggest", null, { q: "1 palm", session: "sess-0123456789" });
  assert.equal(u.status, 200);
  assert.deepEqual(u.body, { status: "unconfigured", suggestions: [] });
  assert.equal(fake.fetches.length, 0);

  fake.googleKey = "K";
  // Too short → nothing asked of Google.
  const short = await call(h, "GET", "/service/address/suggest", null, { q: "1 " });
  assert.deepEqual(short.body, { status: "ok", suggestions: [] });
  assert.equal(fake.fetches.length, 0);

  const s = await call(h, "GET", "/service/address/suggest", null, { q: "1 palm ln", session: "sess-0123456789" });
  assert.equal(s.status, 200);
  assert.equal(s.body.status, "ok");
  assert.deepEqual(s.body.suggestions, [
    { placeId: "PID1", main: "1 Palm Ln", secondary: "Mesa, AZ 85201, USA", text: "1 Palm Ln, Mesa, AZ 85201, USA" },
    { placeId: "PID2", main: "1 Palm Ln #4", secondary: "Mesa, AZ 85201, USA", text: "1 Palm Ln #4, Mesa, AZ 85201, USA" },
  ], "query predictions (not places) are dropped");
  const ac = fake.placesCalls[0];
  assert.equal(ac.headers["X-Goog-Api-Key"], "K", "the key rides in the header, server-side");
  assert.equal(ac.body.sessionToken, "sess-0123456789");
  assert.deepEqual(ac.body.includedRegionCodes, ["us"]);
  assert.equal(ac.body.locationBias, undefined, "no bias unless the secret carries one");
  assert.ok(!ac.url.includes("K"), "never the key in a URL");

  const p = await call(h, "GET", "/service/address/place/PID2", null, { session: "sess-0123456789" });
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.address, { street: "1 Palm Ln #4", city: "Mesa", state: "AZ", postalCode: "85201", formatted: "1 Palm Ln #4, Mesa, AZ 85201, USA", lat: 33.41, lng: -111.83 });
  const pc = fake.placesCalls[1];
  assert.equal(pc.headers["X-Goog-FieldMask"], "id,formattedAddress,addressComponents,location");
  assert.ok(pc.url.endsWith("/places/PID2?sessionToken=sess-0123456789"));

  // A bad place id is a 400, never a Google call; Google refusing is a 502 with a plain message.
  const badId = await call(h, "GET", "/service/address/place/no%20way!");
  assert.equal(badId.status, 400);
  fake.placesFails = true;
  const down = await call(h, "GET", "/service/address/suggest", null, { q: "1 palm ln" });
  assert.equal(down.status, 502);
  assert.equal(down.body.code, "ADDRESS_LOOKUP_FAILED");
});

test("street view: unconfigured without the secret; fetched once by pano id, cached in S3 + on the job; NONE remembered; refresh re-asks", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Sv", Primary_Phone__c: "602-555-0009", Street__c: "1 Palm Ln", City__c: "Mesa", State__c: "AZ", Postal_Code__c: "85201" });
  const h = makeHandler(fake);
  const j = await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id } });
  assert.equal(j.status, 201);
  const jobId = fake.store.Sundial_Service_Job__c[0].Id;
  const job = fake.store.Sundial_Service_Job__c[0];
  assert.ok(job.Address_at_Creation__c, "the job carries the snapshot address the lookup uses");

  // No Google key in Secrets Manager yet → the page shows the setup hint, nothing written.
  const u = await call(h, "GET", `/service/jobs/${jobId}/street-view`);
  assert.equal(u.status, 200);
  assert.equal(u.body.status, "unconfigured");
  assert.equal(fake.fetches.length, 0);

  fake.googleKey = "K";
  const first = await call(h, "GET", `/service/jobs/${jobId}/street-view`);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "ready");
  assert.equal(first.body.cached, false);
  assert.equal(fake.fetches.length, 2, "metadata, then the still");
  assert.ok(fake.fetches[0].includes("/streetview/metadata?location="));
  assert.ok(fake.fetches[0].includes("source=outdoor"));
  assert.ok(fake.fetches[1].includes("/streetview?") && fake.fetches[1].includes("location=") && fake.fetches[1].includes("source=outdoor"), "the still is asked for by ADDRESS so Google aims the camera at the house");
  assert.ok(!fake.fetches[1].includes("pano="), "never by panorama id — that shows the camera car's heading, i.e. the house across the street");
  // The key is stamped so a re-fetch lands at a NEW URL (the browser caches the old one).
  assert.match(fake.puts.at(-1).key, new RegExp(`^SUNDIAL/${jobId}/street-view-\\d{8}T\\d{6}Z-[0-9a-f]{4}\\.jpg$`));
  assert.equal(fake.puts.at(-1).contentType, "image/jpeg");
  assert.equal(job.Street_View_Image_Key__c, fake.puts.at(-1).key);
  assert.ok(first.body.url.endsWith(`/${fake.puts.at(-1).key}`));
  const firstKey = fake.puts.at(-1).key;

  // Second read: served from the job, Google not asked again.
  const second = await call(h, "GET", `/service/jobs/${jobId}/street-view`);
  assert.equal(second.body.cached, true);
  assert.equal(fake.fetches.length, 2);

  // The address changes (the job page clears the pointer): the next read re-asks Google,
  // writes a NEW key (a new URL — the browser's cache of the old one cannot hide it) and
  // removes the old file. The deletes are best-effort.
  fake.deletes = [];
  job.Street_View_Image_Key__c = null;
  job.Address_at_Creation__c = "77 New Rd, Tempe, AZ, 85281";
  const moved = await call(h, "GET", `/service/jobs/${jobId}/street-view`);
  assert.equal(moved.body.cached, false);
  assert.notEqual(job.Street_View_Image_Key__c, firstKey, "a fresh key, so a fresh URL");
  assert.ok(fake.fetches.at(-1).includes(encodeURIComponent("77 New Rd")), "asked for the NEW address");
  assert.deepEqual(fake.deletes, [], "nothing to delete when the pointer was already cleared — the old file stays until a refresh replaces it");
  const refreshed = await call(h, "GET", `/service/jobs/${jobId}/street-view`, null, { refresh: "1" });
  assert.equal(refreshed.body.cached, false);
  assert.equal(fake.deletes.length, 1, "a refresh removes the file it replaced");

  // No imagery → NONE remembered; the next read does not ask Google either.
  fake.streetViewStatus = "ZERO_RESULTS";
  const none = await call(h, "GET", `/service/jobs/${jobId}/street-view`, null, { refresh: "1" });
  assert.equal(none.body.status, "none");
  assert.equal(job.Street_View_Image_Key__c, "NONE");
  const fetchesAfterNone = fake.fetches.length;
  const noneAgain = await call(h, "GET", `/service/jobs/${jobId}/street-view`);
  assert.equal(noneAgain.body.status, "none");
  assert.equal(fake.fetches.length, fetchesAfterNone);

  // Cross-tenant / unknown job is a 404, never a Google call.
  const nf = await call(h, "GET", `/service/jobs/a0X000000000000AAA/street-view`);
  assert.equal(nf.status, 404);
  assert.equal(fake.fetches.length, fetchesAfterNone);
});

test("invoice helpers: money summary, statuses, numbering, payment validation", () => {
  const rows = [
    { Type__c: "Deposit", Amount__c: 100, Status__c: "Succeeded" },
    { Type__c: "Payment", Amount__c: 300.5, Status__c: "Succeeded" },
    { Type__c: "Refund", Amount__c: 50, Status__c: "Succeeded" },
    { Type__c: "Payment", Amount__c: 999, Status__c: "Failed" },
  ];
  assert.deepEqual(paidSummary(rows), { paid: 350.5, deposits: 100, refunds: 50 });
  assert.equal(invoiceStatusFor("Issued", 500, 0), "Issued");
  assert.equal(invoiceStatusFor("Issued", 500, 350.5), "Partially Paid");
  assert.equal(invoiceStatusFor("Sent", 500, 500), "Paid");
  assert.equal(invoiceStatusFor("Paid", 500, 450), "Partially Paid", "a refund reopens it");
  assert.equal(invoiceStatusFor("Paid", 500, 0), "Issued", "a full refund goes back to Issued");
  assert.equal(invoiceStatusFor("Void", 500, 500), "Void");
  assert.equal(jobPaymentStatusFor({ paid: 0, deposits: 0, refunds: 0 }, 500, true), "None");
  assert.equal(jobPaymentStatusFor({ paid: 100, deposits: 100, refunds: 0 }, 0, false), "Deposit Paid");
  assert.equal(jobPaymentStatusFor({ paid: 350.5, deposits: 100, refunds: 50 }, 500, true), "Partially Paid");
  assert.equal(jobPaymentStatusFor({ paid: 500, deposits: 0, refunds: 0 }, 500, true), "Paid");
  assert.equal(jobPaymentStatusFor({ paid: -50, deposits: 0, refunds: 50 }, 500, true), "Refunded");
  assert.equal(nextInvoiceName("SVC-00012", 0), "SVC-00012");
  assert.equal(nextInvoiceName("SVC-00012", 1), "SVC-00012-2");
  assert.equal(invoicePdfKey("a0J1", "SVC-00012-2"), "SUNDIAL/a0J1/SVC-00012-2.pdf");
  const ctx = { jobId: "J", invoiceId: "I", tenantId: TENANT, userId: USER, now: new Date("2026-09-12T00:00:00Z") };
  assert.deepEqual(paymentFieldsFromBody({ amount: -5 }, ctx).problems, ["amount must be a positive number (Refund rows are positive too — the type says the direction)"]);
  assert.ok(paymentFieldsFromBody({ amount: 5, type: "Bribe" }, ctx).problems[0].startsWith("type must be"));
  const ok = paymentFieldsFromBody({ amount: "125.129", method: "Check", reference: "1044", receivedAt: "2026-09-11" }, ctx).fields;
  assert.equal(ok.Amount__c, 125.13);
  assert.equal(ok.Status__c, "Succeeded");
  assert.equal(ok.Recorded_By__c, USER);
  assert.equal(ok.Received_At__c, "2026-09-11T00:00:00.000Z");
  assert.equal(ok.Reference__c, "1044");
});

test("invoice lifecycle: issue freezes the estimate, deposits back-fill, payments settle job + invoice, send emails the PDF, void reopens and reissues as -2", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Ivy", Primary_Email__c: "ivy@example.com", Street__c: "5 Fir", City__c: "Mesa", State__c: "AZ", Postal_Code__c: "85201" });
  const h = makeHandler(fake);
  const j = await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, estimate: { taxRate: 8.6 }, lines: [{ description: "Labor", kind: "Labor", unitPrice: 275 }, { description: "Breaker", kind: "Material", unitPrice: 100, taxable: true }] });
  assert.equal(j.status, 201);
  const job = fake.store.Sundial_Service_Job__c[0];
  const est = fake.store.Sundial_Estimate__c[0];

  // Before: nothing to show, but the job can be invoiced.
  const before = await call(h, "GET", `/service/jobs/${job.Id}/invoice`);
  assert.equal(before.status, 200);
  assert.equal(before.body.invoice, null);
  assert.equal(before.body.canIssue, true);

  // A deposit taken before the invoice exists (no Invoice__c yet).
  await fake.deps.sfCreateRecord("Sundial_Service_Payment__c", { Client__c: TENANT, Service_Job__c: job.Id, Type__c: "Deposit", Method__c: "Card", Amount__c: 100, Status__c: "Succeeded", Received_At__c: "2026-09-09T00:00:00Z" });

  // Issue: labor 275 + material 100 = 375; tax 8.6% of 100 = 8.60 → 383.60
  const iss = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, { netDays: 30 });
  assert.equal(iss.status, 201, JSON.stringify(iss.body));
  const inv = fake.store.Sundial_Service_Invoice__c[0];
  assert.equal(inv.Name, job.Name, "invoice number = job number");
  assert.equal(inv.Status__c, "Partially Paid", "the deposit already counts");
  assert.equal(inv.Total__c, 383.6);
  assert.equal(inv.Tax_Amount__c, 8.6);
  assert.equal(inv.Paid_Amount__c, 100);
  assert.equal(inv.Due_Date__c, "2026-10-10");
  assert.equal(inv.Bill_To_Type__c, "Customer");
  assert.equal(iss.body.balance, 283.6);
  assert.equal(fake.store.Sundial_Service_Payment__c[0].Invoice__c, inv.Id, "the deposit was back-filled onto the invoice");
  assert.equal(est.Status__c, "Invoiced");
  assert.equal(job.Status__c, "Invoiced");
  assert.equal(job.Payment_Status__c, "Partially Paid");
  assert.equal(inv.PDF_S3_Key__c, `SUNDIAL/${job.Id}/${job.Name}.pdf`);
  assert.ok(fake.puts.some((p) => p.key === inv.PDF_S3_Key__c && p.contentType === "application/pdf"));
  assert.ok(iss.body.warnings.some((w) => /never approved/.test(w)), "Proposed lines are flagged, not refused");

  // The estimate is now locked; a second issue is refused.
  const locked = await call(h, "PATCH", `/service/estimates/${est.Id}`, { taxRate: 9 });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, "ESTIMATE_INVOICED");
  const again = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "INVOICE_EXISTS");

  // Preview reads as an invoice, not an estimate.
  const pv = await call(h, "GET", `/service/invoices/${inv.Id}/preview`);
  assert.equal(pv.status, 200);
  assert.ok(pv.body.html.includes("<div>Invoice</div>"));
  assert.ok(pv.body.html.includes("Bill to"));
  assert.ok(pv.body.html.includes("Balance due"));
  assert.ok(pv.body.html.includes("$283.60"));

  // Send: emails the customer with the PDF attached; Issued → Sent.
  const sent = await call(h, "POST", `/service/invoices/${inv.Id}/send`, {});
  assert.equal(sent.status, 200);
  assert.equal(sent.body.delivery, "email");
  assert.equal(sent.body.recipient, "ivy@example.com");
  assert.equal(fake.emails.at(-1).attachments[0].fileName, `${job.Name}.pdf`);
  assert.ok(/283\.60 due/.test(fake.emails.at(-1).subject));
  assert.equal(inv.Status__c, "Partially Paid", "money status wins over Sent");
  assert.ok(inv.Sent_At__c);

  // A check for the balance: invoice Paid, job Paid.
  const pay = await call(h, "POST", `/service/invoices/${inv.Id}/payments`, { method: "Check", amount: 283.6, reference: "1044" });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.balance, 0);
  assert.equal(inv.Status__c, "Paid");
  assert.ok(inv.Paid_At__c);
  assert.equal(job.Status__c, "Paid");
  assert.equal(job.Payment_Status__c, "Paid");
  // A refund reopens it.
  const ref = await call(h, "POST", `/service/invoices/${inv.Id}/payments`, { type: "Refund", method: "Check", amount: 83.6 });
  assert.equal(ref.status, 201);
  assert.equal(inv.Status__c, "Partially Paid");
  assert.equal(inv.Paid_At__c, null);
  assert.equal(job.Status__c, "Invoiced");
  assert.equal(ref.body.balance, 83.6);
  const badPay = await call(h, "POST", `/service/invoices/${inv.Id}/payments`, { amount: 0 });
  assert.equal(badPay.status, 400);

  // Void: reason required; payments unhook; estimate reopens (Approved? no — Draft, never sent); job back to Ready to Bill.
  const noReason = await call(h, "POST", `/service/invoices/${inv.Id}/void`, {});
  assert.equal(noReason.body.code, "REASON_REQUIRED");
  const v = await call(h, "POST", `/service/invoices/${inv.Id}/void`, { reason: "Wrong tax rate" });
  assert.equal(v.status, 200);
  assert.equal(inv.Status__c, "Void");
  assert.equal(inv.Void_Reason__c, "Wrong tax rate");
  assert.ok(fake.store.Sundial_Service_Payment__c.every((p) => !p.Invoice__c), "money stays on the job, unhooked");
  assert.equal(est.Status__c, "Draft");
  assert.equal(job.Status__c, "Ready to Bill");
  assert.equal(job.Payment_Status__c, "Partially Paid");
  const onVoid = await call(h, "POST", `/service/invoices/${inv.Id}/payments`, { amount: 5 });
  assert.equal(onVoid.status, 409);

  // Fix the estimate, reissue as -2; the money rides along.
  const fix = await call(h, "PATCH", `/service/estimates/${est.Id}`, { taxRate: 0 });
  assert.equal(fix.status, 200);
  const re = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {});
  assert.equal(re.status, 201);
  const inv2 = fake.store.Sundial_Service_Invoice__c[1];
  assert.equal(inv2.Name, `${job.Name}-2`);
  assert.equal(inv2.Total__c, 375);
  assert.equal(inv2.Paid_Amount__c, 300, "100 deposit + 283.60 − 83.60 refund");
  assert.equal(re.body.balance, 75);
  const cur = await call(h, "GET", `/service/jobs/${job.Id}/invoice`);
  assert.equal(cur.body.invoice.Id, inv2.Id);
  assert.equal(cur.body.history.length, 2);
  assert.equal(cur.body.payments.length, 3);

  const evs = fake.activity.map((a) => a.event);
  assert.ok(evs.includes("invoice_issued") && evs.includes("invoice_sent") && evs.includes("payment_recorded") && evs.includes("invoice_voided"));
});

test("labor helpers: clock → quarter hours, row sources, entry validation", () => {
  assert.equal(clockMinutes({ Duration_Minutes__c: 95 }), 95);
  assert.equal(clockMinutes({ Actual_Start__c: "2026-09-14T15:00:00Z", Actual_End__c: "2026-09-14T16:37:00Z" }), 97);
  assert.equal(clockMinutes({ Actual_Start__c: "2026-09-14T15:00:00Z" }), null);
  assert.equal(roundUpQuarterHours(97), 1.75);
  assert.equal(roundUpQuarterHours(60), 1);
  assert.equal(roundUpQuarterHours(61), 1.25);
  assert.equal(roundUpQuarterHours(null), null);
  const call = { Id: "C1", Name: "SC-1", Status__c: "Complete", Tech__c: "U1", Tech__r: { First_Name__c: "Jake", Last_Name__c: "Dorsey", Hourly_Bill_Rate__c: 120 }, Actual_Start__c: "2026-09-14T15:00:00Z", Actual_End__c: "2026-09-14T16:37:00Z", Billable_to_Customer__c: true };
  const row = laborRow(call, null);
  assert.equal(row.hours, 1.75);
  assert.equal(row.hoursSource, "clock");
  assert.equal(row.rate, 120);
  assert.equal(row.rateSource, "tech");
  assert.equal(row.amount, 210);
  const over = laborRow({ ...call, Billable_Hours__c: 2, Bill_Rate__c: 150 }, { Id: "L1", Quantity__c: 2, Unit_Price__c: 150 });
  assert.equal(over.hours, 2);
  assert.equal(over.hoursSource, "office");
  assert.equal(over.rate, 150);
  assert.equal(over.rateSource, "call");
  assert.equal(over.amount, 300);
  assert.equal(over.lineId, "L1");
  const none = laborRow({ ...call, Actual_End__c: null, Tech__r: { First_Name__c: "New", Last_Name__c: "Guy" } }, null);
  assert.equal(none.hours, null);
  assert.equal(none.rate, null);
  assert.equal(none.amount, 0);
  assert.deepEqual(parseLaborEntry({ id: "a0K000000000001AAA", billable: true, hours: "1.5", rate: 99.999 }), { id: "a0K000000000001AAA", billable: true, hours: 1.5, rate: 100, problems: [] });
  assert.ok(parseLaborEntry({ id: "nope", hours: -1 }).problems.length === 2);
});

test("labor billing: billable calls become Labor lines (Source Time), edits rewrite them, unbilling removes them, the invoice locks them", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Lab" });
  await fake.deps.sfCreateRecord("Sundial_User__c", { Client__c: TENANT, First_Name__c: "Jake", Last_Name__c: "Dorsey", Hourly_Bill_Rate__c: 120 });
  await fake.deps.sfCreateRecord("Sundial_User__c", { Client__c: TENANT, First_Name__c: "New", Last_Name__c: "Guy" });
  const [jake, newGuy] = fake.store.Sundial_User__c;
  const h = makeHandler(fake);
  const j = await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Diagnostic", kind: "Labor", unitPrice: 275 }] });
  const jobId = fake.store.Sundial_Service_Job__c[0].Id;
  const estId = fake.store.Sundial_Estimate__c[0].Id;
  // Three calls: two complete (one clocked 1h37, one with no clock), one still scheduled.
  await fake.deps.sfCreateRecord("Sundial_Service_Call__c", { Client__c: TENANT, Name: "SC-1", Sundial_Service_Job__c: jobId, Tech__c: jake.Id, Status__c: "Complete", Scheduled_Start__c: "2026-09-14T15:00:00Z", Actual_Start__c: "2026-09-14T15:00:00Z", Actual_End__c: "2026-09-14T16:37:00Z" });
  await fake.deps.sfCreateRecord("Sundial_Service_Call__c", { Client__c: TENANT, Name: "SC-2", Sundial_Service_Job__c: jobId, Tech__c: newGuy.Id, Status__c: "Complete", Scheduled_Start__c: "2026-09-15T15:00:00Z" });
  await fake.deps.sfCreateRecord("Sundial_Service_Call__c", { Client__c: TENANT, Name: "SC-3", Sundial_Service_Job__c: jobId, Tech__c: jake.Id, Status__c: "Scheduled", Scheduled_Start__c: "2026-09-16T15:00:00Z" });
  const [c1, c2] = fake.store.Sundial_Service_Call__c;

  const g = await call(h, "GET", `/service/jobs/${jobId}/labor`);
  assert.equal(g.status, 200);
  assert.equal(g.body.calls.length, 2, "only completed calls are offered");
  assert.equal(g.body.calls[0].hours, 1.75);
  assert.equal(g.body.calls[0].rate, 120);
  assert.equal(g.body.calls[0].billable, false, "off by default — most jobs are priced from the book");
  assert.equal(g.body.calls[1].hours, null);
  assert.equal(g.body.calls[1].rate, null);
  assert.equal(g.body.summary.billableAmount, 0);

  // Bill Jake's call as clocked; New Guy's with typed hours and a typed rate.
  const s1 = await call(h, "POST", `/service/jobs/${jobId}/labor`, { calls: [{ id: c1.Id, billable: true }, { id: c2.Id, billable: true, hours: 2, rate: 95 }] });
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  assert.deepEqual(s1.body.applied.map((a) => a.action), ["created", "created"]);
  assert.equal(s1.body.totals.Subtotal__c, 275 + 210 + 190);
  assert.equal(c1.Billable_to_Customer__c, true);
  assert.equal(c2.Billable_Hours__c, 2);
  assert.equal(c2.Bill_Rate__c, 95);
  const timeLines = fake.store.Sundial_Service_Line__c.filter((l) => l.Source__c === "Time");
  assert.equal(timeLines.length, 2);
  assert.equal(timeLines[0].Added_By_Service_Call__c, c1.Id);
  assert.equal(timeLines[0].Quantity__c, 1.75);
  assert.equal(timeLines[0].Unit_Price__c, 120);
  assert.equal(timeLines[0].Unit_of_Measure__c, "Hour");
  assert.ok(timeLines[0].Description__c.startsWith("Labor — Jake Dorsey"));
  assert.equal(timeLines[0].Taxable__c, false);

  // Standardize: Jake's call at 100/h and 2 hours → the same line is rewritten, not duplicated.
  const s2 = await call(h, "POST", `/service/jobs/${jobId}/labor`, { calls: [{ id: c1.Id, billable: true, hours: 2, rate: 100 }] });
  assert.deepEqual(s2.body.applied.map((a) => a.action), ["updated"]);
  assert.equal(fake.store.Sundial_Service_Line__c.filter((l) => l.Source__c === "Time").length, 2);
  assert.equal(timeLines[0].Quantity__c, 2);
  assert.equal(timeLines[0].Unit_Price__c, 100);
  assert.equal(s2.body.totals.Subtotal__c, 275 + 200 + 190);

  // Unbill New Guy's: the line goes, the call remembers "not billable", the hours stay typed.
  const s3 = await call(h, "POST", `/service/jobs/${jobId}/labor`, { calls: [{ id: c2.Id, billable: false }] });
  assert.deepEqual(s3.body.applied.map((a) => a.action), ["removed"]);
  assert.equal(fake.store.Sundial_Service_Line__c.filter((l) => l.Source__c === "Time").length, 1);
  assert.equal(c2.Billable_to_Customer__c, false);
  assert.equal(c2.Billable_Hours__c, 2);
  assert.equal(s3.body.totals.Subtotal__c, 475);
  assert.equal(s3.body.summary.billableCalls, 1);
  assert.equal(s3.body.calls.find((c) => c.id === c2.Id).billable, false);

  // A call that is not on the job / not complete is refused; the scheduled one is not offered.
  const badCall = await call(h, "POST", `/service/jobs/${jobId}/labor`, { calls: [{ id: fake.store.Sundial_Service_Call__c[2].Id, billable: true }] });
  assert.equal(badCall.body.code, "CALL_INVALID");

  // A tech's default rate.
  const dr = await call(h, "POST", "/service/labor/default-rate", { userId: newGuy.Id, rate: 110 });
  assert.equal(dr.status, 200);
  assert.equal(newGuy.Hourly_Bill_Rate__c, 110);
  const g2 = await call(h, "GET", `/service/jobs/${jobId}/labor`);
  assert.equal(g2.body.calls.find((c) => c.id === c2.Id).techDefaultRate, 110);
  assert.equal(g2.body.calls.find((c) => c.id === c2.Id).rate, 95, "the call's own rate still wins");

  // Once invoiced, billed labor is frozen with everything else.
  const inv = await call(h, "POST", `/service/jobs/${jobId}/invoice`, {});
  assert.equal(inv.status, 201);
  assert.equal(inv.body.invoice.Total__c, 475);
  const locked = await call(h, "POST", `/service/jobs/${jobId}/labor`, { calls: [{ id: c1.Id, billable: false }] });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, "ESTIMATE_INVOICED");
  const g3 = await call(h, "GET", `/service/jobs/${jobId}/labor`);
  assert.equal(g3.body.estimateLocked, true);
  assert.ok(fake.activity.some((a) => a.event === "labor_billed"));
  void estId; void j;
});

test("tech app: POST /service/tech/calls/{id}/estimate-lines adds Proposed 'Field' lines tagged with the call; only the call's own tech (or the office) may", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Field" });
  await fake.deps.sfCreateRecord("Sundial_User__c", { Client__c: TENANT, First_Name__c: "Jake", Last_Name__c: "Dorsey" });
  await fake.deps.sfCreateRecord("Sundial_User__c", { Client__c: TENANT, First_Name__c: "Larry", Last_Name__c: "Ng" });
  await fake.deps.sfCreateRecord("Sundial_Price_Book_Item__c", { Client__c: TENANT, Name: "Breaker 20A", Item_Code__c: "BRK-20", Version__c: 1, Is_Active__c: true, Kind__c: "Material", Material_Price__c: 45, Default_Quantity__c: 1, Taxable__c: true });
  const [jake, larry] = fake.store.Sundial_User__c;
  const item = fake.store.Sundial_Price_Book_Item__c[0];
  const office = makeHandler(fake);
  await call(office, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Diagnostic", kind: "Labor", unitPrice: 275 }] });
  const jobId = fake.store.Sundial_Service_Job__c[0].Id;
  const estId = fake.store.Sundial_Estimate__c[0].Id;
  await fake.deps.sfCreateRecord("Sundial_Service_Call__c", { Client__c: TENANT, Name: "SC-1", Sundial_Service_Job__c: jobId, Tech__c: jake.Id, Status__c: "In Progress" });
  const callId = fake.store.Sundial_Service_Call__c[0].Id;
  const asTech = (u) => makeHandler(fake, { user: { id: u.Id, firstName: u.First_Name__c, lastName: u.Last_Name__c }, access: { level: "Technician", scope: "tech", userId: u.Id, tenantId: TENANT } });

  // Jake adds a catalog item (qty 2) and an ad-hoc line in one go
  const r = await call(asTech(jake), "POST", `/service/tech/calls/${callId}/estimate-lines`, { lines: [{ priceBookItemId: item.Id, quantity: 2 }, { description: "Extra conduit run", kind: "Labor", unitPrice: 120, stage: "Approved", source: "Ad hoc" }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.estimateId, estId);
  assert.equal(r.body.lines.length, 2);
  assert.deepEqual(r.body.lines.map((l) => l.stage), ["Proposed", "Proposed"], "a tech can never approve; stage/source in the body are ignored");
  const lines = fake.store.Sundial_Service_Line__c.filter((l) => l.Estimate__c === estId);
  assert.equal(lines.length, 3);
  const field = lines.filter((l) => l.Source__c === "Field");
  assert.equal(field.length, 2);
  assert.ok(field.every((l) => l.Added_By_Service_Call__c === callId && l.Stage__c === "Proposed"));
  assert.ok(field.every((l) => l.Sort_Order__c > 10), "appended after the office's lines");
  assert.equal(field[0].Quantity__c, 2);
  assert.equal(field[0].Unit_Price__c, 45);
  assert.equal(r.body.totals.Total__c, 275 + 90 + 120 + 0, JSON.stringify(r.body.totals)); // no tax rate on this estimate
  assert.ok(fake.activity.some((a) => a.event === "line_added" && a.details.source === "Field" && a.details.callId === callId && a.details.via === "tech"));

  // Larry has no call on this job → 404; the office may act
  const larryR = await call(asTech(larry), "POST", `/service/tech/calls/${callId}/estimate-lines`, { description: "x", kind: "Labor", unitPrice: 1 });
  assert.equal(larryR.status, 404);
  const officeR = await call(office, "POST", `/service/tech/calls/${callId}/estimate-lines`, { description: "Office-added on behalf", kind: "Fee", unitPrice: 10 });
  assert.equal(officeR.status, 201);
  // a bad line is reported, not silently dropped
  const badR = await call(asTech(jake), "POST", `/service/tech/calls/${callId}/estimate-lines`, { description: "", kind: "Labor" });
  assert.equal(badR.status, 400);
  assert.equal(badR.body.code, "LINE_INVALID");
  // an invoiced estimate is locked
  await fake.deps.sfUpdateRecord("Sundial_Estimate__c", estId, { Status__c: "Invoiced" });
  const locked = await call(asTech(jake), "POST", `/service/tech/calls/${callId}/estimate-lines`, { description: "late", kind: "Labor", unitPrice: 1 });
  assert.equal(locked.body.code, "ESTIMATE_INVOICED");
});

// ---------------------------------------------------------------------------
// Stripe (D-072 amendment 8, 2026-09-17): the webhook, the office's charge, deferred money
// ---------------------------------------------------------------------------
import { createHmac } from "node:crypto";
import { paymentFieldsFromIntent, refundFields, rawBodyOf, STRIPE_EVENT_TYPES } from "./stripe.js";

const STRIPE_SECRET = { tenants: { harmon: { secretKey: "sk_test_h", webhookSecret: "whsec_h" } } };
/** A signed webhook delivery, the way API Gateway hands it over (base64 body). */
function stripeDelivery(evt, { secret = "whsec_h", at = new Date("2026-09-10T12:00:00Z"), slug = "harmon", tamper = false } = {}) {
  const raw = JSON.stringify(evt);
  const t = Math.floor(at.getTime() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return {
    requestContext: { http: { method: "POST" } },
    rawPath: `/prod/webhooks/stripe/${slug}`,
    headers: { "stripe-signature": `t=${t},v1=${sig}`, "content-type": "application/json" },
    body: Buffer.from(tamper ? raw + " " : raw).toString("base64"),
    isBase64Encoded: true,
  };
}
const send = (h, delivery) => h(delivery).then((r) => ({ status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }));
const evt = (id, type, object, extra = {}) => ({ id, type, livemode: false, data: { object }, ...extra });

test("stripe pure helpers: the Payment / Refund rows an intent becomes, the raw body", () => {
  const pi = { id: "pi_1", amount: 40532, amount_received: 40532, created: 1_789_000_000, latest_charge: "ch_1", metadata: { kind: "deposit" } };
  const f = paymentFieldsFromIntent(pi, { tenantId: TENANT, jobId: "J1", invoiceId: null, mode: "test", now: "2026-09-10T12:00:00.000Z" });
  assert.equal(f.Type__c, "Deposit");
  assert.equal(f.Amount__c, 405.32);
  assert.equal(f.Received_At__c, new Date(1_789_000_000 * 1000).toISOString());
  assert.equal(f.Stripe_Payment_Intent_Id__c, "pi_1");
  assert.equal(f.Stripe_Charge_Id__c, "ch_1");
  assert.equal(f.Invoice__c, undefined);
  assert.equal(paymentFieldsFromIntent({ ...pi, metadata: { kind: "charge" } }, { tenantId: TENANT, jobId: "J1", invoiceId: "I1", mode: "live", now: "x" }).Type__c, "Payment");
  const r = refundFields({ id: "re_1", amount: 5000, created: 1_789_000_100, reason: "requested_by_customer" }, { tenantId: TENANT, jobId: "J1", invoiceId: "I1", paymentIntentId: "pi_1", mode: "test", now: "x" });
  assert.equal(r.Type__c, "Refund");
  assert.equal(r.Amount__c, 50);
  assert.equal(r.Stripe_Refund_Id__c, "re_1");
  assert.equal(r.Invoice__c, "I1");
  assert.equal(rawBodyOf({ body: Buffer.from("abc").toString("base64"), isBase64Encoded: true }).toString(), "abc");
  assert.equal(rawBodyOf({ body: "abc" }), "abc");
  // The endpoint's subscription list in the Stripe dashboard: payments + the Service Club (D-073).
  assert.deepEqual([...STRIPE_EVENT_TYPES], ["checkout.session.completed", "payment_intent.succeeded", "payment_intent.payment_failed", "charge.refunded", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"]);
});

test("stripe webhook: signature is the gate (bad / tampered / unknown tenant / not configured); a deposit lands as a Payment row exactly once; the card goes on file", async () => {
  const fake = fakeSalesforce();
  fake.stripeSecret = STRIPE_SECRET;
  const stripeCalls = [];
  fake.stripe = async (url, init) => {
    stripeCalls.push({ url, init });
    if (url.endsWith("/setup_intents/seti_1")) return { ok: true, status: 200, json: async () => ({ id: "seti_1", payment_method: "pm_card" }) };
    if (url.endsWith("/payment_intents/pi_dep")) return { ok: true, status: 200, json: async () => ({ id: "pi_dep", payment_method: "pm_card" }) };
    if (url.includes("/customers/cus_1") && init.method === "POST") return { ok: true, status: 200, json: async () => ({ id: "cus_1" }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Ivy", Primary_Email__c: "ivy@example.com", Street__c: "5 Fir", City__c: "Mesa", State__c: "AZ", Postal_Code__c: "85201" });
  const h = makeHandler(fake);
  const j = await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, estimate: { taxRate: 8.6, depositRequired: true, depositType: "Flat", depositValue: 100 }, lines: [{ description: "Labor", kind: "Labor", unitPrice: 275 }] });
  assert.equal(j.status, 201, JSON.stringify(j.body));
  const job = fake.store.Sundial_Service_Job__c[0];
  const est = fake.store.Sundial_Estimate__c[0];
  const customer = fake.store.Sundial_Customer__c[0];
  const meta = { tenant: "harmon", tenantId: TENANT, estimateId: est.Id, jobId: job.Id, customerId: customer.Id, invoiceId: "", kind: "deposit" };

  // The gate.
  const good = evt("evt_dep", "payment_intent.succeeded", { id: "pi_dep", object: "payment_intent", amount: 10000, amount_received: 10000, created: 1_789_000_000, latest_charge: "ch_dep", metadata: meta });
  assert.equal((await send(h, stripeDelivery(good, { secret: "whsec_wrong" }))).status, 400);
  assert.equal((await send(h, stripeDelivery(good, { tamper: true }))).status, 400);
  assert.equal((await send(h, stripeDelivery(good, { at: new Date("2026-09-10T11:00:00Z") }))).status, 400, "10 minutes old");
  assert.equal((await send(h, stripeDelivery(good, { slug: "nobody" }))).status, 503, "no keys for that tenant");
  const off = makeHandler({ ...fake, stripeSecret: null });
  assert.equal((await send(off, stripeDelivery(good))).status, 503);
  assert.equal(fake.store.Sundial_Service_Payment__c.length, 0, "nothing written by a refused event");

  // The card on file (a setup Checkout): hub remembers the Stripe customer, job flags the card, Stripe's default card is set.
  const session = evt("evt_cs", "checkout.session.completed", { id: "cs_1", object: "checkout.session", mode: "setup", customer: "cus_1", setup_intent: "seti_1", metadata: { ...meta, kind: "setup" } });
  let r = await send(h, stripeDelivery(session));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "applied");
  assert.equal(customer.Stripe_Customer_Id__c, "cus_1");
  assert.equal(job.Customer_Card_on_File__c, true);
  const setDefault = stripeCalls.find((c) => c.url.endsWith("/customers/cus_1") && c.init.method === "POST");
  assert.equal(new URLSearchParams(setDefault.init.body).get("invoice_settings[default_payment_method]"), "pm_card");
  assert.ok(fake.activity.some((a) => a.event === "job_updated" && a.details.via === "stripe" && a.details.fields.Customer_Card_on_File__c.to === true));

  // The deposit: one Payment row, the estimate stamped, the job Deposit Paid (no invoice yet).
  r = await send(h, stripeDelivery(good));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "applied");
  assert.equal(fake.store.Sundial_Service_Payment__c.length, 1);
  const row = fake.store.Sundial_Service_Payment__c[0];
  assert.equal(row.Type__c, "Deposit");
  assert.equal(row.Amount__c, 100);
  assert.equal(row.Status__c, "Succeeded");
  assert.equal(row.Service_Job__c, job.Id);
  assert.equal(row.Stripe_Payment_Intent_Id__c, "pi_dep");
  assert.equal(row.Invoice__c, undefined);
  assert.ok(est.Deposit_Paid_At__c);
  assert.equal(job.Payment_Status__c, "Deposit Paid");
  const paid = fake.activity.find((a) => a.event === "payment_recorded");
  assert.equal(paid.details.via, "stripe");
  assert.equal(paid.actor_name, "Stripe");
  const ledger = fake.stripeEvents.find((e) => e.id === "evt_dep");
  assert.equal(ledger.status, "applied");
  assert.equal(ledger.payment_sf_id, row.Id);
  assert.equal(ledger.amount, 100);

  // Redelivered (same event id) and re-sent under a new id (same intent): still one row.
  r = await send(h, stripeDelivery(good));
  assert.equal(r.body.duplicate, true);
  r = await send(h, stripeDelivery(evt("evt_dep2", "payment_intent.succeeded", good.data.object)));
  assert.equal(r.body.duplicate, true);
  assert.equal(fake.store.Sundial_Service_Payment__c.length, 1);
  assert.equal(fake.activity.filter((a) => a.event === "payment_recorded").length, 1);

  // Another tenant's metadata, a live event on test keys, an unhandled type: ignored, 200, nothing written.
  r = await send(h, stripeDelivery(evt("evt_x1", "payment_intent.succeeded", { ...good.data.object, id: "pi_other", metadata: { ...meta, tenantId: "a1W7y000007OTHERAS" } })));
  assert.equal(r.body.status, "ignored");
  r = await send(h, stripeDelivery(evt("evt_x2", "payment_intent.succeeded", { ...good.data.object, id: "pi_live" }, { livemode: true })));
  assert.equal(r.body.status, "ignored");
  r = await send(h, stripeDelivery(evt("evt_x3", "customer.updated", { id: "cus_1", object: "customer" })));
  assert.equal(r.body.status, "ignored");
  assert.equal(fake.store.Sundial_Service_Payment__c.length, 1);

  // Issue the invoice: the deposit rides onto it; the balance is charged off-session by the office.
  fake.stripe = async (url, init) => {
    stripeCalls.push({ url, init });
    if (url.endsWith("/customers/cus_1") && (!init.method || init.method === "GET")) return { ok: true, status: 200, json: async () => ({ id: "cus_1", invoice_settings: { default_payment_method: "pm_card" } }) };
    if (url.endsWith("/payment_intents") && init.method === "POST") return { ok: true, status: 200, json: async () => ({ id: "pi_bal", status: "requires_confirmation" }) };
    if (url.endsWith("/payment_intents/pi_bal/confirm")) {
      if (fake.decline) return { ok: false, status: 402, json: async () => ({ error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." } }) };
      return { ok: true, status: 200, json: async () => ({ id: "pi_bal", status: "succeeded", created: 1_789_000_500, latest_charge: "ch_bal" }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const iss = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {});
  assert.equal(iss.status, 201, JSON.stringify(iss.body));
  assert.equal(iss.body.cardOnFile, undefined);
  const inv = fake.store.Sundial_Service_Invoice__c[0];
  assert.equal(inv.Paid_Amount__c, 100);
  assert.equal(inv.Total__c, 275);
  assert.equal((await call(h, "GET", `/service/jobs/${job.Id}/invoice`)).body.cardOnFile, true);

  // Declined: a Failed row with Stripe's words, a 402, the invoice untouched.
  fake.decline = true;
  r = await call(h, "POST", `/service/invoices/${inv.Id}/charge`, {});
  assert.equal(r.status, 402, JSON.stringify(r.body));
  assert.equal(r.body.code, "insufficient_funds");
  assert.match(r.body.message, /insufficient funds/);
  const failed = fake.store.Sundial_Service_Payment__c.find((p) => p.Stripe_Payment_Intent_Id__c === "pi_bal");
  assert.equal(failed.Status__c, "Failed");
  assert.equal(failed.Failure_Reason__c, "Your card has insufficient funds.");
  assert.equal(failed.Amount__c, 175);
  assert.equal(inv.Paid_Amount__c, 100);
  // The failed webhook for the same intent just confirms the row.
  r = await send(h, stripeDelivery(evt("evt_fail", "payment_intent.payment_failed", { id: "pi_bal", object: "payment_intent", amount: 17500, last_payment_error: { message: "Your card has insufficient funds." }, metadata: { ...meta, kind: "charge", invoiceId: inv.Id } })));
  assert.equal(r.body.status, "ignored"); // the office's confirm already recorded the decline
  assert.equal(failed.Status__c, "Failed");

  // The office tries again once the customer fixed the card: PaymentIntent → Pending row → confirm → Succeeded → settled.
  fake.decline = false;
  const created = { pi: "pi_bal2" };
  fake.stripe = async (url, init) => {
    stripeCalls.push({ url, init });
    if (url.endsWith("/customers/cus_1")) return { ok: true, status: 200, json: async () => ({ id: "cus_1", invoice_settings: { default_payment_method: "pm_card" } }) };
    if (url.endsWith("/payment_intents") && init.method === "POST") return { ok: true, status: 200, json: async () => ({ id: created.pi, status: "requires_confirmation" }) };
    if (url.endsWith(`/payment_intents/${created.pi}/confirm`)) return { ok: true, status: 200, json: async () => ({ id: created.pi, status: "succeeded", created: 1_789_000_500, latest_charge: "ch_bal2" }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  r = await call(h, "POST", `/service/invoices/${inv.Id}/charge`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "succeeded");
  assert.equal(r.body.amount, 175);
  const piCreate = new URLSearchParams(stripeCalls.find((c) => c.url.endsWith("/payment_intents") && c.init.method === "POST" && c.init.body.includes("17500")).init.body);
  assert.equal(piCreate.get("customer"), "cus_1");
  assert.equal(piCreate.get("payment_method"), "pm_card");
  assert.equal(piCreate.get("off_session"), "true");
  assert.equal(piCreate.get("confirm"), "false");
  assert.equal(piCreate.get("metadata[kind]"), "charge");
  assert.equal(piCreate.get("metadata[invoiceId]"), inv.Id);
  assert.equal(piCreate.get("receipt_email"), "ivy@example.com");
  const ok = fake.store.Sundial_Service_Payment__c.find((p) => p.Stripe_Payment_Intent_Id__c === "pi_bal2");
  assert.equal(ok.Status__c, "Succeeded");
  assert.equal(ok.Stripe_Charge_Id__c, "ch_bal2");
  assert.equal(inv.Paid_Amount__c, 275);
  assert.equal(inv.Status__c, "Paid");
  assert.equal(job.Status__c, "Paid");
  assert.equal(job.Payment_Status__c, "Paid");
  // Stripe's own webhook for that intent arrives later: nothing doubles.
  r = await send(h, stripeDelivery(evt("evt_bal2", "payment_intent.succeeded", { id: "pi_bal2", object: "payment_intent", amount: 17500, amount_received: 17500, created: 1_789_000_500, latest_charge: "ch_bal2", metadata: { ...meta, kind: "charge", invoiceId: inv.Id } })));
  assert.equal(r.body.duplicate, true);
  assert.equal(inv.Paid_Amount__c, 275);
  // Charging a paid invoice is refused; so is a partner-billed one.
  assert.equal((await call(h, "POST", `/service/invoices/${inv.Id}/charge`, {})).body.code, "NOTHING_DUE");

  // A refund made in the Stripe dashboard mirrors as a Refund row and reopens the balance.
  r = await send(h, stripeDelivery(evt("evt_ref", "charge.refunded", { id: "ch_bal2", object: "charge", payment_intent: "pi_bal2", amount_refunded: 5000, refunds: { data: [{ id: "re_1", amount: 5000, status: "succeeded", created: 1_789_000_900, reason: "requested_by_customer" }] } })));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.refunds, 1);
  const refund = fake.store.Sundial_Service_Payment__c.find((p) => p.Type__c === "Refund");
  assert.equal(refund.Amount__c, 50);
  assert.equal(refund.Invoice__c, inv.Id);
  assert.equal(inv.Paid_Amount__c, 225);
  assert.equal(inv.Status__c, "Partially Paid");
  assert.equal(job.Status__c, "Invoiced");
  r = await send(h, stripeDelivery(evt("evt_ref2", "charge.refunded", { id: "ch_bal2", object: "charge", payment_intent: "pi_bal2", refunds: { data: [{ id: "re_1", amount: 5000, status: "succeeded", created: 1_789_000_900 }] } })));
  assert.equal(r.body.duplicate, true);
  assert.equal(fake.store.Sundial_Service_Payment__c.filter((p) => p.Type__c === "Refund").length, 1);
});

test("stripe: a deposit paid before the job exists is deferred, then lands when the office creates the job; issue with chargeCard charges the balance", async () => {
  const fake = fakeSalesforce();
  fake.stripeSecret = STRIPE_SECRET;
  fake.stripe = async (url, init) => {
    if (url.endsWith("/customers/cus_1")) return { ok: true, status: 200, json: async () => ({ id: "cus_1", invoice_settings: { default_payment_method: "pm_card" } }) };
    if (url.endsWith("/payment_intents") && init.method === "POST") return { ok: true, status: 200, json: async () => ({ id: "pi_auto", status: "requires_confirmation" }) };
    if (url.endsWith("/payment_intents/pi_auto/confirm")) return { ok: true, status: 200, json: async () => ({ id: "pi_auto", status: "succeeded", created: 1_789_001_000, latest_charge: "ch_auto" }) };
    if (url.endsWith("/payment_intents/pi_early")) return { ok: true, status: 200, json: async () => ({ id: "pi_early", payment_method: "pm_card" }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Ivy", Primary_Email__c: "ivy@example.com", Street__c: "5 Fir", City__c: "Mesa", State__c: "AZ", Postal_Code__c: "85201" });
  const h = makeHandler(fake);
  const customer = fake.store.Sundial_Customer__c[0];
  // An estimate with no job (the office quotes first, converts on acceptance).
  const c = await call(h, "POST", "/service/estimates", { customer: { id: customer.Id }, estimate: { taxRate: 0, depositRequired: true, depositType: "Flat", depositValue: 50 }, lines: [{ description: "Labor", kind: "Labor", unitPrice: 200 }] });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const est = fake.store.Sundial_Estimate__c[0];
  assert.equal(est.Service_Job__c, undefined);
  const meta = { tenant: "harmon", tenantId: TENANT, estimateId: est.Id, jobId: "", customerId: customer.Id, invoiceId: "", kind: "deposit" };

  // Deposit paid on the hosted page: no job → deferred; the estimate is stamped; no Payment row.
  let r = await send(h, stripeDelivery(evt("evt_early_cs", "checkout.session.completed", { id: "cs_e", object: "checkout.session", mode: "payment", customer: "cus_1", payment_intent: "pi_early", metadata: meta })));
  assert.equal(r.body.status, "deferred", JSON.stringify(r.body));
  assert.equal(customer.Stripe_Customer_Id__c, "cus_1");
  r = await send(h, stripeDelivery(evt("evt_early", "payment_intent.succeeded", { id: "pi_early", object: "payment_intent", amount: 5000, amount_received: 5000, created: 1_789_000_000, latest_charge: "ch_early", metadata: meta })));
  assert.equal(r.body.status, "deferred");
  assert.ok(est.Deposit_Paid_At__c);
  assert.equal(fake.store.Sundial_Service_Payment__c.length, 0);
  assert.equal(fake.stripeEvents.filter((e) => e.status === "deferred").length, 2);

  // Create Job: the deposit lands as a Payment row on the new job, the card flag is set, the ledger says applied.
  const cj = await call(h, "POST", `/service/estimates/${est.Id}/create-job`, { job: {} });
  assert.equal(cj.status, 201, JSON.stringify(cj.body));
  assert.equal(cj.body.stripeApplied, 2);
  const job = fake.store.Sundial_Service_Job__c[0];
  assert.equal(fake.store.Sundial_Service_Payment__c.length, 1);
  const dep = fake.store.Sundial_Service_Payment__c[0];
  assert.equal(dep.Service_Job__c, job.Id);
  assert.equal(dep.Type__c, "Deposit");
  assert.equal(dep.Amount__c, 50);
  assert.equal(job.Customer_Card_on_File__c, true);
  assert.equal(job.Payment_Status__c, "Deposit Paid");
  assert.ok(fake.stripeEvents.every((e) => e.status === "applied"), JSON.stringify(fake.stripeEvents.map((e) => [e.id, e.status, e.error])));
  assert.equal(fake.stripeEvents.find((e) => e.id === "evt_early").job_sf_id, job.Id);

  // Issue with chargeCard: the 150 balance is charged in the same request.
  const iss = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, { chargeCard: true });
  assert.equal(iss.status, 201, JSON.stringify(iss.body));
  assert.equal(iss.body.charge.ok, true);
  assert.equal(iss.body.charge.amount, 150);
  const inv = fake.store.Sundial_Service_Invoice__c[0];
  assert.equal(inv.Paid_Amount__c, 200);
  assert.equal(inv.Status__c, "Paid");
  assert.equal(iss.body.paymentStatus, "Paid");
  assert.ok(!iss.body.warnings.some((w) => /not charged/.test(w)), JSON.stringify(iss.body.warnings));
});

// ---------------------------------------------------------------------------
// Service Club (D-073, 2026-09-18): the catalog, the join, the webhook's subscription
// branch, plan discounts, the office's memberships
// ---------------------------------------------------------------------------
import { clubConfigFor, publicPlans, statusFromSubscription, summarizeMemberships, normalizeJoin, planDiscountFields, monthlyEquivalent } from "./club.js";

const CLUB_SECRET = { tenants: { harmon: { solarFactsHookUrl: "https://hooks.zapier.com/catch/1/on", solarFactsCancelHookUrl: "https://hooks.zapier.com/catch/1/off", teamEmail: "service-team@example.com" } } };
const PLAN_ROWS = (tenantId) => [
  { Client__c: tenantId, Name: "Monitor Plan", Plan_Code__c: "monitor", Kind__c: "Subscription", Availability__c: "Available", Sort_Order__c: 10, Tagline__c: "Monthly monitoring and support.", Features__c: "Proactive system monitoring\nRemote troubleshooting", Monthly_Price__c: 8.99, Yearly_Price__c: 99.99, Stripe_Product_Id__c: "prod_mon", Stripe_Monthly_Price_Id__c: "price_mon_m", Stripe_Yearly_Price_Id__c: "price_mon_y", Discount_Scope__c: "Labor", Discount_Type__c: "Percent", Discount_Value__c: 10, Discount_Description__c: "10% off repair labor", Includes_Tune_Up__c: false, Includes_Cleaning__c: false },
  { Client__c: tenantId, Name: "Maintain Plan", Plan_Code__c: "maintain", Kind__c: "Subscription", Availability__c: "Available", Sort_Order__c: 20, Highlight__c: "Most Popular", Monthly_Price__c: 19.99, Yearly_Price__c: 219.99, Stripe_Product_Id__c: "prod_mai", Stripe_Monthly_Price_Id__c: "price_mai_m", Stripe_Yearly_Price_Id__c: "price_mai_y", Discount_Scope__c: "Labor", Discount_Type__c: "Percent", Discount_Value__c: 10, Includes_Tune_Up__c: true, Includes_Cleaning__c: false },
  { Client__c: tenantId, Name: "Protect Plan", Plan_Code__c: "protect", Kind__c: "Subscription", Availability__c: "Coming Soon", Sort_Order__c: 40, Monthly_Price__c: 39.99, Yearly_Price__c: 439.99, Includes_Tune_Up__c: true, Includes_Cleaning__c: true },
  { Client__c: tenantId, Name: "Old Plan", Plan_Code__c: "old", Kind__c: "Subscription", Availability__c: "Retired", Sort_Order__c: 90, Monthly_Price__c: 5 },
  { Client__c: tenantId, Name: "Service Call", Plan_Code__c: "truck-roll", Kind__c: "One-time", Availability__c: "Available", Sort_Order__c: 100, Price__c: 275, Features__c: "A technician at your home" },
];
/** A public call: no Authorization header at all. */
const pub = (h, method, path, body, query) =>
  h({ requestContext: { http: { method } }, rawPath: path, headers: { origin: "https://portal.example.com" }, body: body ? JSON.stringify(body) : undefined, queryStringParameters: query })
    .then((r) => ({ status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }));
function clubStripe(fake, stripeCalls, { subStatus = () => "active" } = {}) {
  let sessions = 0;
  return async (url, init) => {
    stripeCalls.push({ url, init, params: init.body ? new URLSearchParams(init.body) : null });
    const method = init.method;
    if (url.endsWith("/customers") && method === "POST") return { ok: true, status: 200, json: async () => ({ id: "cus_club" }) };
    if (/\/customers\/cus_/.test(url) && method === "GET") return { ok: true, status: 200, json: async () => ({ id: url.split("/").pop(), deleted: false }) };
    if (url.endsWith("/checkout/sessions") && method === "POST") {
      sessions += 1;
      return { ok: true, status: 200, json: async () => ({ id: `cs_test_${sessions}`, url: `https://checkout.stripe.com/c/pay/cs_test_${sessions}` }) };
    }
    if (/\/subscriptions\/sub_/.test(url) && method === "GET") return { ok: true, status: 200, json: async () => ({ id: url.split("/").pop(), status: subStatus(), start_date: 1_789_000_000, current_period_end: 1_791_600_000, cancel_at_period_end: false }) };
    if (/\/subscriptions\/sub_/.test(url) && method === "POST") return { ok: true, status: 200, json: async () => ({ id: url.split("/").pop(), status: "active", cancel_at_period_end: true }) };
    if (/\/subscriptions\/sub_/.test(url) && method === "DELETE") return { ok: true, status: 200, json: async () => ({ id: url.split("/").pop(), status: "canceled" }) };
    if (url.endsWith("/billing_portal/sessions")) return { ok: true, status: 200, json: async () => ({ id: "bps_1", url: "https://billing.stripe.com/p/session/x" }) };
    if (url.endsWith("/products") && method === "POST") return { ok: true, status: 200, json: async () => ({ id: "prod_new" }) };
    if (/\/products\/prod_/.test(url) && method === "GET") return { ok: true, status: 200, json: async () => ({ id: url.split("/").pop() }) };
    if (url.endsWith("/prices") && method === "POST") return { ok: true, status: 200, json: async () => ({ id: `price_new_${stripeCalls.length}` }) };
    if (/\/prices\/price_/.test(url) && method === "GET") {
      const id = url.split("/").pop();
      return { ok: true, status: 200, json: async () => ({ id, active: true, unit_amount: id.endsWith("_m") ? 899 : 9999, recurring: { interval: id.endsWith("_m") ? "month" : "year" }, product: "prod_mon" }) };
    }
    if (/\/prices\/price_/.test(url) && method === "POST") return { ok: true, status: 200, json: async () => ({ id: url.split("/").pop(), active: false }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

test("club pure helpers: config per tenant, the public catalog, Stripe status mapping, MRR, the join form, the plan discount", () => {
  assert.deepEqual(clubConfigFor(CLUB_SECRET, "harmon"), { solarFacts: null, solarFactsHookUrl: "https://hooks.zapier.com/catch/1/on", solarFactsCancelHookUrl: "https://hooks.zapier.com/catch/1/off", teamEmail: "service-team@example.com" });
  assert.equal(clubConfigFor(CLUB_SECRET, "nobody"), null);
  assert.equal(clubConfigFor({ tenants: { harmon: { solarFactsHookUrl: "https://h" } } }, "harmon").solarFactsCancelHookUrl, "https://h", "cancel hook falls back to the main hook");
  const plans = publicPlans(PLAN_ROWS(TENANT).map((r, i) => ({ Id: `P${i}`, ...r })));
  assert.deepEqual(plans.map((p) => [p.code, p.purchasable]), [["monitor", true], ["maintain", true], ["protect", false], ["truck-roll", true]], "Retired is hidden, Coming Soon is shown but not purchasable");
  assert.equal(plans[0].monthly, 8.99);
  assert.deepEqual(plans[0].features, ["Proactive system monitoring", "Remote troubleshooting"]);
  assert.equal(plans[0].discountDescription, "10% off repair labor");
  assert.equal(plans[3].price, 275);
  assert.equal(statusFromSubscription({ status: "active", cancel_at_period_end: false, current_period_end: 1_791_600_000 }).status, "Active");
  assert.equal(statusFromSubscription({ status: "past_due" }).status, "Past Due");
  assert.equal(statusFromSubscription({ status: "canceled", ended_at: 1_790_000_000 }).endedAt, new Date(1_790_000_000 * 1000).toISOString());
  assert.equal(statusFromSubscription({ status: "trialing" }).status, "Active");
  assert.equal(monthlyEquivalent(99.99, "Yearly"), 8.33);
  const sum = summarizeMemberships([
    { Status__c: "Active", Service_Plan__c: "P0", Price__c: 8.99, Billing_Interval__c: "Monthly" },
    { Status__c: "Active", Service_Plan__c: "P1", Price__c: 219.99, Billing_Interval__c: "Yearly" },
    { Status__c: "Past Due", Service_Plan__c: "P0", Price__c: 8.99, Billing_Interval__c: "Monthly" },
    { Status__c: "Cancelled", Service_Plan__c: "P0", Price__c: 8.99, Billing_Interval__c: "Monthly" },
    { Status__c: "Pending", Service_Plan__c: "P1", Price__c: 19.99, Billing_Interval__c: "Monthly" },
  ], [{ Id: "P0", Name: "Monitor Plan" }, { Id: "P1", Name: "Maintain Plan" }]);
  assert.equal(sum.total, 5);
  assert.equal(sum.active, 3, "Active + Past Due are live");
  assert.equal(sum.mrr, 36.31, "8.99 + 219.99/12 + 8.99");
  assert.deepEqual(sum.byStatus, { Active: 2, "Past Due": 1, Cancelled: 1, Pending: 1 });
  assert.equal(sum.byPlan.find((p) => p.planId === "P0").Cancelled, 1);
  const bad = normalizeJoin({ planCode: "", interval: "weekly", customer: { firstName: "A" } });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems, ["planCode is required", "interval must be monthly or yearly", "customer: email|phone"]);
  const good = normalizeJoin({ planCode: "Monitor", interval: "Yearly", customer: { firstName: "Ann", lastName: "Lee", email: "ann@example.com" } });
  assert.equal(good.ok, true);
  assert.equal(good.value.planCode, "monitor");
  assert.equal(good.value.interval, "Yearly");
  assert.deepEqual(planDiscountFields({ Discount_Scope__c: "Both", Discount_Type__c: "Percent", Discount_Value__c: 10 }, "M1"), { Discount_Scope__c: "Both", Discount_Type__c: "Percent", Discount_Value__c: 10, Discount_Source__c: "Service Plan", Membership__c: "M1" });
  assert.equal(planDiscountFields({ Discount_Value__c: 0 }, "M1"), null);
});

test("club: the public catalog, a join → Pending row + subscription Checkout, the webhook activates it (pointer, SolarFacts, team email), a member's new estimate carries the discount, renewals and cancellation follow Stripe", async () => {
  const fake = fakeSalesforce();
  fake.stripeSecret = STRIPE_SECRET;
  fake.clubSecret = CLUB_SECRET;
  for (const r of PLAN_ROWS(TENANT)) await fake.deps.sfCreateRecord("Sundial_Service_Plan__c", r);
  const stripeCalls = [];
  fake.stripe = clubStripe(fake, stripeCalls);
  const h = makeHandler(fake);
  const monitor = fake.store.Sundial_Service_Plan__c[0];

  // The catalog, no login.
  let r = await pub(h, "GET", "/prod/public/club/harmon/plans");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.configured, true);
  assert.deepEqual(r.body.plans.map((p) => p.code), ["monitor", "maintain", "protect"]);
  assert.equal(r.body.plans[2].purchasable, false);
  assert.deepEqual(r.body.oneTime.map((p) => p.code), ["truck-roll"]);
  assert.equal(r.body.brand, "Test Electric");
  assert.equal((await pub(h, "GET", "/public/club/nobody/plans")).status, 404);

  // A Coming Soon plan cannot be joined; a bad form is a 400 with the problems.
  const customer = { firstName: "Ann", lastName: "Lee", email: "ann@example.com", phone: "602-555-0101", street: "9 Oak St", city: "Mesa", state: "AZ", postalCode: "85201" };
  r = await pub(h, "POST", "/public/club/harmon/join", { planCode: "protect", interval: "monthly", customer });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "PLAN_NOT_AVAILABLE");
  r = await pub(h, "POST", "/public/club/harmon/join", { planCode: "monitor", interval: "monthly", customer: { firstName: "Ann" } });
  assert.equal(r.status, 400);

  // The join: customer created + tagged, Pending membership, a subscription Checkout on the monthly price.
  r = await pub(h, "POST", "/public/club/harmon/join", { planCode: "monitor", interval: "monthly", customer });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.url, "https://checkout.stripe.com/c/pay/cs_test_1");
  assert.equal(r.body.price, 8.99);
  const cust = fake.store.Sundial_Customer__c[0];
  assert.equal(cust.Name, "Ann Lee");
  assert.equal(cust.Requested_Project_Types__c, "Service");
  assert.equal(cust.Stripe_Customer_Id__c, "cus_club");
  const m = fake.store.Sundial_Membership__c[0];
  assert.equal(m.Status__c, "Pending");
  assert.equal(m.Service_Plan__c, monitor.Id);
  assert.equal(m.Billing_Interval__c, "Monthly");
  assert.equal(m.Price__c, 8.99);
  assert.equal(m.Source__c, "Online");
  assert.equal(m.Stripe_Checkout_Session_Id__c, "cs_test_1");
  assert.equal(m.Customer_Name_at_Creation__c, "Ann Lee");
  const session = stripeCalls.find((c) => c.url.endsWith("/checkout/sessions"));
  assert.equal(session.params.get("mode"), "subscription");
  assert.equal(session.params.get("line_items[0][price]"), "price_mon_m");
  assert.equal(session.params.get("customer"), "cus_club");
  assert.equal(session.params.get("metadata[membershipId]"), m.Id);
  assert.equal(session.params.get("subscription_data[metadata][kind]"), "membership");
  assert.ok(session.params.get("success_url").startsWith("https://portal.example.com/club/joined?session="));
  assert.ok(fake.activity.some((a) => a.event === "membership_started" && a.record_sf_id === m.Id && a.details.note === "new customer"));

  // The success page's read: Pending until the webhook.
  r = await pub(h, "GET", "/public/club/harmon/joined", null, { session: "cs_test_1" });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "Pending");
  assert.equal(r.body.plan.name, "Monitor Plan");
  assert.equal(r.body.firstName, "Ann");
  assert.equal((await pub(h, "GET", "/public/club/harmon/joined", null, { session: "cs_nope" })).status, 404);

  // Stripe's checkout.session.completed in subscription mode → Active, the pointer set, SolarFacts told, the team emailed.
  const meta = { tenant: "harmon", tenantId: TENANT, kind: "membership", membershipId: m.Id, customerId: cust.Id, planId: monitor.Id, planCode: "monitor", interval: "Monthly", source: "Online" };
  const done = evt("evt_join", "checkout.session.completed", { id: "cs_test_1", object: "checkout.session", mode: "subscription", customer: "cus_club", subscription: "sub_1", created: 1_789_000_000, metadata: meta });
  r = await send(h, stripeDelivery(done));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "applied");
  assert.equal(r.body.membershipId, m.Id);
  assert.equal(m.Status__c, "Active");
  assert.equal(m.Stripe_Subscription_Id__c, "sub_1");
  assert.ok(m.Started_At__c);
  assert.equal(m.Current_Period_End__c, new Date(1_791_600_000 * 1000).toISOString());
  assert.equal(cust.Active_Membership__c, m.Id);
  assert.equal(m.SolarFacts_Status__c, "Sent");
  const hook = fake.hookBodies[0];
  assert.equal(hook.url, "https://hooks.zapier.com/catch/1/on");
  assert.equal(hook.body.event, "member.activated");
  assert.equal(hook.body.customer.email, "ann@example.com");
  assert.equal(hook.body.plan.code, "monitor");
  assert.equal(hook.body.membershipNumber, "MEM-00001");
  const teamMail = fake.emails.find((e) => e.to === "service-team@example.com");
  assert.match(teamMail.subject, /New Service Club member: Ann Lee — Monitor Plan/);
  const joinBell = fake.notes.find((n) => n.kind === "club_join");
  assert.deepEqual([joinBell.to, joinBell.category, joinBell.url, joinBell.dedupeKey], ["office", "money", `/service/club?membership=${m.Id}`, `club:join:${m.Id}`]);
  assert.equal(joinBell.title, teamMail.subject);
  assert.match(teamMail.text, /SolarFax has been sent the connect invite/);
  assert.equal(fake.stripeEvents.find((e) => e.id === "evt_join").membership_sf_id, m.Id);
  // Redelivered: nothing changes, no second hook.
  r = await send(h, stripeDelivery(done));
  assert.equal(r.body.duplicate, true);
  assert.equal(fake.hookBodies.length, 1);
  // The success page now says Active.
  r = await pub(h, "GET", "/public/club/harmon/joined", null, { session: "cs_test_1" });
  assert.equal(r.body.status, "Active");

  // Joining again while a member is a 409 — the same person, matched by email.
  r = await pub(h, "POST", "/public/club/harmon/join", { planCode: "maintain", interval: "yearly", customer: { ...customer, phone: "" } });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "ALREADY_MEMBER");
  assert.equal(fake.store.Sundial_Customer__c.length, 1, "no duplicate customer");

  // The member's NEW estimate carries the plan discount; the office's own discount is not overridden.
  r = await call(h, "POST", "/service/estimates", { customer: { id: cust.Id }, lines: [{ description: "Repair labor", kind: "Labor", unitPrice: 200 }, { description: "Part", kind: "Material", unitPrice: 100 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const est = fake.store.Sundial_Estimate__c[0];
  assert.equal(est.Discount_Source__c, "Service Plan");
  assert.equal(est.Discount_Scope__c, "Labor");
  assert.equal(est.Discount_Value__c, 10);
  assert.equal(est.Membership__c, m.Id);
  assert.equal(est.Discount_Amount__c, 20, "10% of the labor only");
  assert.equal(est.Total__c, 280);
  r = await call(h, "POST", "/service/estimates", { customer: { id: cust.Id }, estimate: { discountValue: 25, discountScope: "Both" }, lines: [{ description: "Labor", kind: "Labor", unitPrice: 100 }] });
  assert.equal(fake.store.Sundial_Estimate__c[1].Discount_Value__c, 25);
  assert.equal(fake.store.Sundial_Estimate__c[1].Discount_Source__c, undefined);
  // …and can be put on an existing estimate on demand.
  r = await call(h, "POST", `/service/estimates/${fake.store.Sundial_Estimate__c[1].Id}/apply-plan-discount`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(fake.store.Sundial_Estimate__c[1].Discount_Value__c, 10);
  assert.equal(fake.store.Sundial_Estimate__c[1].Discount_Source__c, "Service Plan");
  assert.equal(r.body.totals.Total__c, 90);

  // The office's views.
  r = await call(h, "GET", `/service/club/customers/${cust.Id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.active.number, "MEM-00001");
  assert.equal(r.body.active.plan.name, "Monitor Plan");
  assert.equal(r.body.discount.Discount_Value__c, 10);
  r = await call(h, "GET", "/service/club/memberships", null, { status: "Active" });
  assert.equal(r.body.memberships.length, 1);
  assert.equal(r.body.memberships[0].customerName, "Ann Lee");
  r = await call(h, "GET", "/service/club/memberships", null, { q: "nobody" });
  assert.equal(r.body.memberships.length, 0);
  r = await call(h, "GET", "/service/club/report");
  assert.equal(r.body.active, 1);
  assert.equal(r.body.mrr, 8.99);
  assert.deepEqual(r.body.owedVisits, [], "Monitor owes no visit");

  // A renewal paid: last payment + lifetime; a failed one: Past Due + a team email; paid again: Active.
  r = await send(h, stripeDelivery(evt("evt_inv1", "invoice.paid", { id: "in_1", object: "invoice", subscription: "sub_1", amount_paid: 899, amount_due: 899, created: 1_789_000_000, billing_reason: "subscription_create", status_transitions: { paid_at: 1_789_000_100 } })));
  assert.equal(r.body.status, "applied");
  assert.equal(m.Lifetime_Revenue__c, 8.99);
  assert.equal(m.Last_Payment_Amount__c, 8.99);
  assert.equal(fake.stripeEvents.find((e) => e.id === "evt_inv1").amount, 8.99);
  r = await send(h, stripeDelivery(evt("evt_inv2", "invoice.payment_failed", { id: "in_2", object: "invoice", subscription: "sub_1", amount_due: 899, created: 1_791_600_000 })));
  assert.equal(m.Status__c, "Past Due");
  assert.equal(m.Payment_Failures__c, 1);
  assert.match(fake.emails.at(-1).subject, /past due/);
  assert.equal(fake.notes.filter((n) => n.kind === "club_past_due").length, 1, "the team hears once");
  const pastDueMails = fake.emails.length;
  r = await send(h, stripeDelivery(evt("evt_sub_pd", "customer.subscription.updated", { id: "sub_1", object: "subscription", status: "past_due", current_period_end: 1_794_000_000, cancel_at_period_end: false, metadata: meta })));
  assert.equal(fake.emails.length, pastDueMails, "the team hears about a past-due renewal once");
  r = await send(h, stripeDelivery(evt("evt_inv3", "invoice.paid", { id: "in_3", object: "invoice", subscription: "sub_1", amount_paid: 899, created: 1_791_700_000 })));
  assert.equal(m.Status__c, "Active");
  assert.equal(m.Lifetime_Revenue__c, 17.98);
  r = await call(h, "GET", "/service/club/report");
  assert.equal(r.body.revenue.yearToDate, 17.98);
  // An unknown subscription is ignored, never created.
  r = await send(h, stripeDelivery(evt("evt_sub_x", "customer.subscription.updated", { id: "sub_other", object: "subscription", status: "active" })));
  assert.equal(r.body.status, "ignored");
  assert.equal(fake.store.Sundial_Membership__c.length, 1);

  // The office cancels at period end: Stripe is told, the row stays Active with the flag.
  r = await call(h, "POST", `/service/club/memberships/${m.Id}/cancel`, { reason: "Sold the house" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cancelCall = stripeCalls.find((c) => c.url.endsWith("/subscriptions/sub_1") && c.init.method === "POST");
  assert.equal(cancelCall.params.get("cancel_at_period_end"), "true");
  assert.equal(m.Status__c, "Active");
  assert.equal(m.Cancel_At_Period_End__c, true);
  assert.equal(m.Cancel_Reason__c, "Sold the house");
  assert.equal(cust.Active_Membership__c, m.Id, "still a member until the period ends");
  // Stripe confirms the schedule (no second team email for the same cancellation), then ends it.
  r = await send(h, stripeDelivery(evt("evt_sub_c", "customer.subscription.updated", { id: "sub_1", object: "subscription", status: "active", cancel_at_period_end: true, canceled_at: 1_791_800_000, current_period_end: 1_794_000_000 })));
  assert.equal(r.body.status, "applied");
  const emailsBefore = fake.emails.length;
  r = await send(h, stripeDelivery(evt("evt_sub_d", "customer.subscription.deleted", { id: "sub_1", object: "subscription", status: "canceled", ended_at: 1_794_000_000, canceled_at: 1_791_800_000 })));
  assert.equal(r.body.status, "applied");
  assert.equal(m.Status__c, "Cancelled");
  assert.equal(m.Ended_At__c, new Date(1_794_000_000 * 1000).toISOString());
  assert.equal(cust.Active_Membership__c, null, "pointer cleared");
  assert.equal(m.SolarFacts_Status__c, "Cancel Sent");
  assert.equal(fake.hookBodies.at(-1).url, "https://hooks.zapier.com/catch/1/off");
  assert.equal(fake.hookBodies.at(-1).body.event, "member.cancelled");
  assert.equal(fake.emails.length, emailsBefore + 1);
  assert.match(fake.emails.at(-1).subject, /membership ended/);
  assert.equal(fake.notes.at(-1).kind, "club_ended");
  assert.equal((await call(h, "POST", `/service/club/memberships/${m.Id}/cancel`, {})).status, 409, "already ended");
  // No longer a member: the discount route says so, and the customer can join again.
  r = await call(h, "POST", `/service/estimates/${est.Id}/apply-plan-discount`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "NOT_A_MEMBER");
  r = await pub(h, "POST", "/public/club/harmon/join", { planCode: "maintain", interval: "yearly", customer });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(fake.store.Sundial_Membership__c.length, 2);
  assert.equal(fake.store.Sundial_Membership__c[1].Price__c, 219.99);
  assert.equal(fake.store.Sundial_Customer__c.length, 1, "matched the same customer by email");
});

test("club: the SolarFacts hook failing never fails the webhook; the office resends; the manage link emails a portal session and never leaks whether the email is known", async () => {
  const fake = fakeSalesforce();
  fake.stripeSecret = STRIPE_SECRET;
  fake.clubSecret = CLUB_SECRET;
  fake.hookFails = true;
  for (const r of PLAN_ROWS(TENANT)) await fake.deps.sfCreateRecord("Sundial_Service_Plan__c", r);
  const stripeCalls = [];
  fake.stripe = clubStripe(fake, stripeCalls);
  const h = makeHandler(fake);
  let r = await pub(h, "POST", "/public/club/harmon/join", { planCode: "monitor", interval: "yearly", customer: { firstName: "Bo", lastName: "Ng", email: "bo@example.com" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = fake.store.Sundial_Membership__c[0];
  const cust = fake.store.Sundial_Customer__c[0];
  r = await send(h, stripeDelivery(evt("evt_j2", "checkout.session.completed", { id: "cs_test_1", object: "checkout.session", mode: "subscription", customer: "cus_club", subscription: "sub_9", metadata: { tenantId: TENANT, membershipId: m.Id } })));
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "applied");
  assert.equal(m.Status__c, "Active");
  assert.equal(m.SolarFacts_Status__c, "Failed");
  assert.match(m.SolarFacts_Last_Error__c, /500/);
  assert.match(fake.emails.find((e) => e.to === "service-team@example.com").text, /SolarFax was NOT told \(hook answered 500\)/);
  fake.hookFails = false;
  r = await call(h, "POST", `/service/club/memberships/${m.Id}/solarfacts`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.event, "member.activated");
  assert.equal(m.SolarFacts_Status__c, "Sent");
  assert.equal(m.SolarFacts_Last_Error__c, null);
  // Manage: a known member's email gets the portal link; an unknown one gets the same 200.
  r = await pub(h, "POST", "/public/club/harmon/manage", { email: "bo@example.com" });
  assert.equal(r.status, 200);
  const portal = stripeCalls.find((c) => c.url.endsWith("/billing_portal/sessions"));
  assert.equal(portal.params.get("customer"), "cus_club");
  assert.equal(portal.params.get("return_url"), "https://portal.example.com/club");
  const mail = fake.emails.find((e) => e.to === "bo@example.com");
  assert.match(mail.subject, /Manage your Test Electric Service Club membership/);
  assert.match(mail.html, /https:\/\/billing\.stripe\.com\/p\/session\/x/);
  assert.equal(r.body.message.includes("If that email"), true);
  const before = fake.emails.length;
  r = await pub(h, "POST", "/public/club/harmon/manage", { email: "stranger@example.com" });
  assert.equal(r.status, 200);
  assert.equal(fake.emails.length, before, "nothing sent, nothing said");
  assert.equal(cust.Active_Membership__c, m.Id);
});

test("club: with SolarFax's API configured the activation creates the member + sends the connect invite, the end of the membership disconnects them, and a refusal is stamped for a resend", async () => {
  const fake = fakeSalesforce();
  fake.stripeSecret = STRIPE_SECRET;
  fake.clubSecret = { tenants: { harmon: { solarFacts: { apiKey: "key-1", accessToken: "tok-1", inviteTemplate: "Harmon Connect" }, solarFactsHookUrl: "https://hooks.zapier.com/catch/1/on", teamEmail: "service-team@example.com" } } };
  for (const r of PLAN_ROWS(TENANT)) await fake.deps.sfCreateRecord("Sundial_Service_Plan__c", r);
  const stripeCalls = [];
  fake.stripe = clubStripe(fake, stripeCalls);
  const h = makeHandler(fake);
  let r = await pub(h, "POST", "/public/club/harmon/join", { planCode: "monitor", interval: "monthly", customer: { firstName: "Ann", lastName: "Lee", email: "ann@example.com", phone: "602-555-0101", street: "9 Oak St", city: "Mesa", state: "AZ", postalCode: "85201" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = fake.store.Sundial_Membership__c[0];
  r = await send(h, stripeDelivery(evt("evt_x1", "checkout.session.completed", { id: "cs_test_1", object: "checkout.session", mode: "subscription", customer: "cus_club", subscription: "sub_x", metadata: { tenantId: TENANT, membershipId: m.Id } })));
  assert.equal(r.body.status, "applied");
  assert.equal(m.Status__c, "Active");
  // The API was used, not the hook; both auth headers; the invite body carries the member, the address and the template.
  assert.equal(fake.solarFaxCalls.length, 1);
  assert.equal(fake.hookBodies, undefined, "the Zapier hook is only the fallback");
  const inv = fake.solarFaxCalls[0];
  assert.equal(inv.url, "https://api.solardatapros.com/api/v1/users");
  assert.equal(inv.headers["Api-Key"], "key-1");
  assert.equal(inv.headers["Access-Token"], "tok-1");
  assert.deepEqual(inv.body.user, { firstName: "Ann", lastName: "Lee", email: "ann@example.com", enableAccess: "1", enableEmails: "1" });
  assert.deepEqual(inv.body.account, { phone: "602-555-0101", addressOne: "9 Oak St", city: "Mesa", state: "AZ", zip: "85201", isLead: "0" });
  assert.deepEqual(inv.body.sendEmailTemplate, { Name: "Harmon Connect" });
  assert.equal(inv.body.disconnect, undefined);
  assert.equal(inv.body.test, undefined);
  assert.equal(m.SolarFacts_Status__c, "Sent");
  assert.equal(m.SolarFacts_Account_Id__c, "SFA-1");
  assert.equal(m.SolarFacts_User_Id__c, "SFU-1");
  assert.match(fake.emails.find((e) => e.to === "service-team@example.com").text, /SolarFax has been sent the connect invite/);
  // The key and token never reach a log line or an email.
  assert.ok(!fake.emails.some((e) => /key-1|tok-1/.test(e.text + e.html)));
  // The subscription ends → full disconnect.
  r = await send(h, stripeDelivery(evt("evt_x2", "customer.subscription.deleted", { id: "sub_x", object: "subscription", status: "canceled", ended_at: 1_794_000_000, canceled_at: 1_791_800_000 })));
  assert.equal(r.body.status, "applied");
  assert.equal(m.Status__c, "Cancelled");
  assert.equal(fake.solarFaxCalls.length, 2);
  const off = fake.solarFaxCalls[1];
  assert.equal(off.body.disconnect, "1");
  assert.equal(off.body.user.email, "ann@example.com");
  assert.equal(off.body.sendEmailTemplate, undefined, "no invite on the way out");
  assert.equal(m.SolarFacts_Status__c, "Cancel Sent");
  assert.match(fake.emails.at(-1).text, /SolarFax has disconnected the member's monitoring/);
  // SolarFax refusing (success:false) is stamped, never fatal; the office resends once it is fixed.
  fake.solarFaxFails = true;
  r = await pub(h, "POST", "/public/club/harmon/join", { planCode: "monitor", interval: "monthly", customer: { firstName: "Bo", lastName: "Ng", email: "bo@example.com" } });
  const m2 = fake.store.Sundial_Membership__c[1];
  r = await send(h, stripeDelivery(evt("evt_x3", "checkout.session.completed", { id: "cs_test_2", object: "checkout.session", mode: "subscription", customer: "cus_club2", subscription: "sub_y", metadata: { tenantId: TENANT, membershipId: m2.Id } })));
  assert.equal(r.status, 200);
  assert.equal(m2.Status__c, "Active");
  assert.equal(m2.SolarFacts_Status__c, "Failed");
  assert.match(m2.SolarFacts_Last_Error__c, /Invalid Api-Key/);
  assert.match(fake.emails.find((e) => e.to === "service-team@example.com" && /Bo Ng/.test(e.text)).text, /SolarFax was NOT told \(Invalid Api-Key\)/);
  fake.solarFaxFails = false;
  r = await call(h, "POST", `/service/club/memberships/${m2.Id}/solarfacts`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.via, "api");
  assert.equal(m2.SolarFacts_Status__c, "Sent");
  assert.equal(m2.SolarFacts_Account_Id__c, "SFA-1");
});

test("club: the office records a member and sends the join link; a plan price change makes a new Stripe price; a tech is refused", async () => {
  const fake = fakeSalesforce();
  fake.stripeSecret = STRIPE_SECRET;
  fake.clubSecret = CLUB_SECRET;
  for (const r of PLAN_ROWS(TENANT)) await fake.deps.sfCreateRecord("Sundial_Service_Plan__c", r);
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Cy Diaz", First_Name__c: "Cy", Last_Name__c: "Diaz", Primary_Email__c: "cy@example.com", Street__c: "3 Elm", City__c: "Phoenix", State__c: "AZ", Postal_Code__c: "85001" });
  const stripeCalls = [];
  fake.stripe = clubStripe(fake, stripeCalls);
  const h = makeHandler(fake);
  const cust = fake.store.Sundial_Customer__c[0];
  let r = await call(h, "POST", "/service/club/memberships", { customerId: cust.Id, planCode: "maintain", interval: "yearly", source: "Migrated", email: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.emailed, true);
  assert.equal(r.body.price, 219.99);
  const m = fake.store.Sundial_Membership__c[0];
  assert.equal(m.Source__c, "Migrated");
  assert.equal(m.Status__c, "Pending");
  const mail = fake.emails.find((e) => e.to === "cy@example.com");
  assert.match(mail.subject, /Complete your Test Electric Service Club membership/);
  assert.match(mail.html, /checkout\.stripe\.com/);
  // A second link for the same customer while the first is Pending is fine (Pending is not live); an Active one is refused.
  assert.equal((await call(h, "POST", "/service/club/memberships", { customerId: cust.Id, planCode: "monitor", interval: "monthly" })).status, 201);
  assert.equal((await call(h, "POST", "/service/club/memberships", { customerId: cust.Id, planCode: "old", interval: "monthly" })).status, 409, "retired plan");
  assert.equal((await call(h, "POST", "/service/club/memberships", { customerId: "a1Pnope0000000000A", planCode: "monitor" })).status, 400);
  // A Pending membership cancelled by the office is Expired, nothing asked of Stripe.
  r = await call(h, "POST", `/service/club/memberships/${m.Id}/cancel`, { reason: "never finished" });
  assert.equal(r.body.status, "Expired");
  assert.ok(!stripeCalls.some((c) => c.url.includes("/subscriptions/")));

  // Plans: the office view, and a price edit that mints a new Stripe price and archives the old.
  r = await call(h, "GET", "/service/club/plans");
  assert.equal(r.body.plans.length, 5);
  assert.equal(r.body.stripeMode, "test");
  const monitor = fake.store.Sundial_Service_Plan__c[0];
  r = await call(h, "PATCH", `/service/club/plans/${monitor.Id}`, { monthlyPrice: 9.99, availability: "Available", features: ["A", "B"], bogus: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.rejectedFields, ["bogus"]);
  assert.equal(monitor.Monthly_Price__c, 9.99);
  assert.equal(monitor.Features__c, "A\nB");
  const newPrice = stripeCalls.find((c) => c.url.endsWith("/prices") && c.init.method === "POST");
  assert.equal(newPrice.params.get("unit_amount"), "999");
  assert.equal(newPrice.params.get("recurring[interval]"), "month");
  assert.ok(stripeCalls.some((c) => c.url.endsWith("/prices/price_mon_m") && c.init.method === "POST" && c.params.get("active") === "false"), "old monthly price archived");
  assert.ok(!stripeCalls.some((c) => c.url.endsWith("/prices/price_mon_y") && c.init.method === "POST"), "the yearly price still matches — untouched");
  assert.notEqual(monitor.Stripe_Monthly_Price_Id__c, "price_mon_m");
  assert.equal(r.body.plan.monthly, 9.99);

  // A tech (service.tech.self / .read only) is refused before any Salesforce call.
  const tech = makeHandler(fake, { user: { id: "a1O7y00000TechAAAA", firstName: "Jake" }, access: { level: "Technician", scope: "tech", userId: "a1O7y00000TechAAAA", tenantId: TENANT } });
  assert.equal((await call(tech, "GET", "/service/club/memberships")).status, 403);
  assert.equal((await call(tech, "POST", "/service/club/memberships", { customerId: cust.Id, planCode: "monitor" })).status, 403);
});

test("club: a truck roll bought online is an approved estimate + a job paid as the deposit through the existing webhook; 'call me' is a job for the office", async () => {
  const fake = fakeSalesforce();
  fake.stripeSecret = STRIPE_SECRET;
  fake.clubSecret = CLUB_SECRET;
  for (const r of PLAN_ROWS(TENANT)) await fake.deps.sfCreateRecord("Sundial_Service_Plan__c", r);
  const stripeCalls = [];
  fake.stripe = clubStripe(fake, stripeCalls);
  const h = makeHandler(fake);
  const customer = { firstName: "Dee", lastName: "Fox", email: "dee@example.com", phone: "602-555-0199", street: "12 Pine", city: "Tempe", state: "AZ", postalCode: "85281" };
  let r = await pub(h, "POST", "/public/club/harmon/truck-roll", { customer, issue: "Inverter shows a red light" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.amount, 275);
  assert.equal(r.body.url, "https://checkout.stripe.com/c/pay/cs_test_1");
  const est = fake.store.Sundial_Estimate__c[0];
  const job = fake.store.Sundial_Service_Job__c[0];
  const line = fake.store.Sundial_Service_Line__c[0];
  assert.equal(est.Status__c, "Approved");
  assert.equal(est.Approval_Method__c, "Online");
  assert.equal(est.Approved_By_Name__c, "Dee Fox");
  assert.equal(est.Deposit_Required__c, true);
  assert.equal(est.Deposit_Amount__c, 275);
  assert.equal(est.Total__c, 275);
  assert.equal(est.Service_Job__c, job.Id);
  assert.equal(line.Description__c, "Service Call");
  assert.equal(line.Kind__c, "Fee");
  assert.equal(line.Stage__c, "Approved");
  assert.equal(job.Intake_Channel__c, "Web Form");
  assert.equal(job.Issue_Description__c, "Inverter shows a red light");
  assert.equal(job.Needs_Intake_Review__c, true);
  assert.equal(job.Service_Type__c, "Paid Service");
  const session = stripeCalls.find((c) => c.url.endsWith("/checkout/sessions"));
  assert.equal(session.params.get("mode"), "payment");
  assert.equal(session.params.get("line_items[0][price_data][unit_amount]"), "27500");
  assert.equal(session.params.get("payment_intent_data[metadata][kind]"), "deposit");
  assert.equal(session.params.get("payment_intent_data[metadata][jobId]"), job.Id);
  assert.equal(session.params.get("payment_intent_data[setup_future_usage]"), "off_session");
  assert.match(fake.emails.at(-1).subject, /Online booking started: Dee Fox — Service Call/);
  // The payment lands through the payments branch, untouched: a Deposit row, the job Deposit Paid.
  const meta = { tenant: "harmon", tenantId: TENANT, estimateId: est.Id, jobId: job.Id, customerId: fake.store.Sundial_Customer__c[0].Id, invoiceId: "", kind: "deposit" };
  r = await send(h, stripeDelivery(evt("evt_tr", "payment_intent.succeeded", { id: "pi_tr", object: "payment_intent", amount: 27500, amount_received: 27500, created: 1_789_000_000, latest_charge: "ch_tr", metadata: meta })));
  assert.equal(r.body.status, "applied", JSON.stringify(r.body));
  assert.equal(fake.store.Sundial_Service_Payment__c[0].Amount__c, 275);
  assert.equal(fake.store.Sundial_Service_Payment__c[0].Type__c, "Deposit");
  assert.equal(job.Payment_Status__c, "Deposit Paid");
  assert.ok(est.Deposit_Paid_At__c);
  // The office's bell (D-074): the booking, then the deposit — each keyed so a replay is silent.
  const booking = fake.notes.find((n) => n.kind === "booking");
  assert.deepEqual([booking.to, booking.category, booking.url, booking.dedupeKey], ["office", "customer_message", `/service/jobs/${job.Id}`, `club:booking:${job.Id}`]);
  assert.match(booking.title, /^Online booking started: Dee Fox/);
  const dep = fake.notes.find((n) => n.kind === "deposit_paid");
  assert.equal(dep.title, `Deposit received: $275.00 on ${job.Name} · Dee Fox`);
  assert.equal(dep.dedupeKey, "money:paid:pi_tr");

  // "Call me": a job in intake review, the team emailed, the same customer matched by phone.
  r = await pub(h, "POST", "/public/club/harmon/request", { customer: { firstName: "Dee", lastName: "Fox", phone: "(602) 555-0199" }, message: "Not sure what's wrong, the bill went up" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.jobNumber, "SVC-00002");
  const callMe = fake.notes.find((n) => n.kind === "call_me");
  assert.equal(callMe.title, "Website service request: Dee Fox (SVC-00002)");
  assert.equal(callMe.body, "Dee Fox asked for a call from the website.");
  assert.equal(fake.store.Sundial_Customer__c.length, 1);
  const req = fake.store.Sundial_Service_Job__c[1];
  assert.equal(req.Needs_Intake_Review__c, true);
  assert.equal(req.Issue_Description__c, "Not sure what's wrong, the bill went up");
  assert.match(fake.emails.at(-1).subject, /Website service request: Dee Fox \(SVC-00002\)/);
  assert.match(fake.emails.at(-1).text, /They wrote: Not sure/);
  // With Stripe off, the truck roll is a 503 with a phone-us message; the request still works.
  const off = makeHandler({ ...fake, stripeSecret: null });
  r = await pub(off, "POST", "/public/club/harmon/truck-roll", { customer, issue: "x" });
  assert.equal(r.status, 503);
  assert.equal((await pub(off, "GET", "/public/club/harmon/plans")).body.configured, false);
});

// ---------------------------------------------------------------------------
// The customer's job report + receipt (D-072 amendment 10)
// ---------------------------------------------------------------------------
test("job report: photos to pick from, save (a stranger's photo refused), preview, send = PDF + email with the link, edit after send + resend, partner payer gets no receipt, a text goes out", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Ivy", Primary_Email__c: "ivy@example.com", Primary_Phone__c: "602-555-0101", Street__c: "5 Fir", City__c: "Mesa", State__c: "AZ", Postal_Code__c: "85201" });
  const texts = [];
  fake.sms = { sendText: async (args) => { texts.push(args); return { ok: true, code: null, error: null, to: "+16025550101", message: { id: "m1" } }; } };
  const h = makeHandler(fake);
  const j = await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Labor", kind: "Labor", unitPrice: 275 }] });
  assert.equal(j.status, 201);
  const job = fake.store.Sundial_Service_Job__c[0];
  job.Customer_Summary__c = "Replaced the failed breaker; the array is producing again.";
  fake.store.Sundial_User__c.push({ Id: USER, Client__c: TENANT, First_Name__c: "Paige", Last_Name__c: "King" });
  await fake.deps.sfCreateRecord("Sundial_Service_Call__c", { Client__c: TENANT, Sundial_Service_Job__c: job.Id, Name: "SC-00001", Status__c: "Complete", Scheduled_Start__c: "2026-09-08T16:00:00Z", Tech__c: USER });
  const callId = fake.store.Sundial_Service_Call__c[0].Id;
  fake.files = [
    { key: `SUNDIAL/${job.Id}/photos/${callId}/before.jpg`, publicUrl: "https://s3/before.jpg", size: 100, lastModified: "2026-09-08T17:00:00Z" },
    { key: `SUNDIAL/${job.Id}/photos/${callId}/after.jpg`, publicUrl: "https://s3/after.jpg", size: 100, lastModified: "2026-09-08T18:00:00Z" },
    { key: `SUNDIAL/${job.Id}/photos/office.png`, publicUrl: "https://s3/office.png", size: 100, lastModified: "2026-09-09T09:00:00Z" },
    { key: `SUNDIAL/${job.Id}/estimate-v1.pdf`, publicUrl: "https://s3/e.pdf", size: 100, lastModified: "2026-09-07T09:00:00Z" },
    { key: `SUNDIAL/OTHERJOB0000000001/photos/x.jpg`, publicUrl: "https://s3/x.jpg", size: 100, lastModified: "2026-09-08T17:00:00Z" },
  ];

  // 1. Nothing yet: the photos to pick from, the summary, no invoice.
  let r = await call(h, "GET", `/service/jobs/${job.Id}/report`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.sections, []);
  assert.equal(r.body.sentCount, 0);
  assert.deepEqual(r.body.photos.map((p) => [p.fileName, p.visitLabel]), [["before.jpg", "Paige King · Sep 8, 2026"], ["after.jpg", "Paige King · Sep 8, 2026"], ["office.png", "Office"]]);
  assert.match(r.body.summary, /producing again/);
  assert.equal(r.body.invoice, null);

  // 2. Save: a photo from another job is refused; then two sections + a text-only one.
  r = await call(h, "PUT", `/service/jobs/${job.Id}/report`, { sections: [{ photoKey: "SUNDIAL/OTHERJOB0000000001/photos/x.jpg", caption: "nope" }] });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "PHOTO_NOT_ON_JOB");
  r = await call(h, "PUT", `/service/jobs/${job.Id}/report`, { sections: [{ id: "a", photoKey: fake.files[0].key, caption: "The failed breaker — arc marks on the bus." }, { id: "b", photoKey: fake.files[1].key, caption: "New breaker installed and tested." }, { id: "c", caption: "We also torqued every lug." }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sectionCount, 3);
  assert.ok(job.Report_Updated_At__c);
  assert.equal(JSON.parse(job.Report_Sections__c).sections.length, 3);
  assert.equal(r.body.editedSinceSent, false);

  // 3. Preview: the document with the summary, the photos and no receipt (no invoice yet).
  r = await call(h, "GET", `/service/jobs/${job.Id}/report/preview`);
  assert.equal(r.status, 200);
  assert.ok(r.body.html.includes("Summary of work"));
  assert.ok(r.body.html.includes('src="https://s3/before.jpg"'));
  assert.ok(r.body.html.includes("torqued every lug"));
  assert.equal(r.body.receipt, false);
  assert.ok(r.body.html.includes("PREVIEW"));

  // 4. Invoice + pay, then send: the PDF is rendered with the photo bytes, stored under the job,
  //    the email carries the link + the PDF, the token + stamps land on the job.
  assert.equal((await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {})).status, 201);
  const inv = fake.store.Sundial_Service_Invoice__c[0];
  assert.equal((await call(h, "POST", `/service/invoices/${inv.Id}/payments`, { method: "Check", amount: 275, reference: "1044" })).status, 201);
  assert.equal(inv.Status__c, "Paid");
  r = await call(h, "POST", `/service/jobs/${job.Id}/report/send`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.delivery, "email");
  assert.equal(r.body.recipient, "ivy@example.com");
  assert.equal(r.body.sentCount, 1);
  assert.equal(r.body.publicUrl, "https://portal.example.com/report/TOKEN123");
  assert.equal(job.Report_Public_Token__c, "TOKEN123");
  assert.ok(job.Report_Token_Expires_At__c > "2027-09-01");
  assert.equal(job.Report_PDF_S3_Key__c, `SUNDIAL/${job.Id}/job-report-1.pdf`);
  assert.ok(fake.puts.some((p) => p.key === job.Report_PDF_S3_Key__c && p.contentType === "application/pdf" && p.bytes > 1000));
  assert.deepEqual(fake.gets.sort(), [fake.files[1].key, fake.files[0].key].sort(), "both photos were read for the PDF");
  const mail = fake.emails.at(-1);
  assert.equal(mail.to, "ivy@example.com");
  assert.match(mail.subject, /^Receipt and job report for SVC-/);
  assert.ok(mail.text.includes("https://portal.example.com/report/TOKEN123"));
  assert.equal(mail.attachments[0].fileName, `${job.Name}-report.pdf`);
  assert.ok(fake.activity.some((a) => a.event === "job_report_sent" && a.details.sentCount === 1 && a.details.receipt === true));
  assert.equal(texts.length, 0);

  // 5. Edited after the send → flagged; send again (via Both) → a second PDF, count 2, a text with the link.
  r = await call(h, "PUT", `/service/jobs/${job.Id}/report`, { sections: [{ id: "a", photoKey: fake.files[0].key, caption: "The failed breaker." }] });
  assert.equal(r.body.editedSinceSent, false, "same-second stamps: not later than the send"); // now() is frozen in tests
  r = await call(h, "GET", `/service/jobs/${job.Id}/report`);
  assert.equal(r.body.sentCount, 1);
  assert.equal(r.body.sections.length, 1);
  r = await call(h, "POST", `/service/jobs/${job.Id}/report/send`, { via: "Both", message: "Thanks again for having us out." });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.delivery, "both");
  assert.equal(r.body.sentCount, 2);
  assert.equal(job.Report_PDF_S3_Key__c, `SUNDIAL/${job.Id}/job-report-2.pdf`);
  assert.equal(job.Report_Public_Token__c, "TOKEN123", "the link stays the same across sends");
  assert.ok(fake.emails.at(-1).text.includes("Thanks again for having us out."));
  assert.equal(texts.length, 1);
  assert.match(texts[0].body, /Your receipt and job report from Test Electric for SVC-.*: https:\/\/portal\.example\.com\/report\/TOKEN123/);
  assert.equal(r.body.textedTo, "+16025550101");

  // 6. A partner-billed job: the customer's copy has no receipt; the email subject says "Job report".
  job.Bill_To_Type__c = "Leasing Partner";
  r = await call(h, "GET", `/service/jobs/${job.Id}/report/preview`);
  assert.equal(r.body.receipt, false);
  assert.ok(!r.body.html.includes("Receipt ·"));
  r = await call(h, "POST", `/service/jobs/${job.Id}/report/send`, {});
  assert.match(fake.emails.at(-1).subject, /^Job report for SVC-/);

  // 7. Empty report → refused; unknown job → 404; a tech is refused.
  job.Report_Sections__c = JSON.stringify({ sections: [] });
  job.Customer_Summary__c = null;
  r = await call(h, "POST", `/service/jobs/${job.Id}/report/send`, {});
  assert.equal(r.body.code, "REPORT_EMPTY");
  assert.equal((await call(h, "GET", "/service/jobs/a1Xnope0000000000A/report")).status, 404);
  const tech = makeHandler(fake, { access: { level: "Technician", scope: "tech", userId: USER, tenantId: TENANT } });
  assert.equal((await call(tech, "GET", `/service/jobs/${job.Id}/report`)).status, 403);
});
