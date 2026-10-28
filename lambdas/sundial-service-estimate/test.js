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
import { paidSummary, invoiceStatusFor, jobPaymentStatusFor, nextInvoiceName, paymentFieldsFromBody, depositFieldsFromBody, DEPOSIT_METHODS, invoicePdfKey } from "./invoice.js";
import { clockMinutes, roundUpQuarterHours, laborRow, parseLaborEntry } from "./labor.js";
import { renderEstimateDocument } from "../../lib/estimate-document.js";
import { tablesFromRows } from "../../lib/tax-zones.js";

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

test("normalizeNewCustomer: a company needs its company name; its contact's names are optional (D-081)", () => {
  assert.deepEqual(normalizeNewCustomer({ isCompany: true, phone: "602-555-0000" }).missing, ["companyName"]);
  assert.deepEqual(normalizeNewCustomer({ isCompany: true, companyName: "   ", firstName: "Dana", phone: "602-555-0000" }).missing, ["companyName"], "the contact does not stand in for the company name");
  const co = normalizeNewCustomer({ isCompany: true, companyName: " SunRun ", email: "ap@sunrun.com" });
  assert.equal(co.ok, true);
  assert.equal(co.value.companyName, "SunRun");
  // A company name without the box ticked is not a company — and does not stand in for a person's name.
  assert.deepEqual(normalizeNewCustomer({ companyName: "SunRun", phone: "602-555-0000" }).missing, ["firstName|lastName"]);
});

test("candidateSoql is tenant-scoped and escapes input; matchCandidates matches exactly", () => {
  const c = { email: "o'brien@x.com", phone: "(602) 555-1234", street: "123 N Main St", postalCode: "85001-1234" };
  const soql = candidateSoql(TENANT, c);
  assert.ok(soql.includes(`Client__c = '${TENANT}'`));
  assert.ok(soql.includes("o\\'brien@x.com"));
  assert.ok(soql.includes("Primary_Phone__c LIKE '%555%1234'"), "the last seven digits (2026-10-07), formatting-proof");
  assert.ok(soql.includes("Alternate_Contact_Phone__c LIKE '%555%1234'"));
  assert.ok(soql.includes("Alternate_Contact_Email__c = 'o\\'brien@x.com'"));
  assert.ok(soql.includes("Postal_Code__c LIKE '85001%'"));
  assert.ok(soql.endsWith("ORDER BY CreatedDate DESC LIMIT 200"));
  const rows = [
    { Id: "1", Name: "A", Primary_Email__c: "O'Brien@X.com" },                       // email (case-insensitive)
    { Id: "2", Name: "B", Primary_Phone__c: "602.555.1234" },                        // phone
    { Id: "3", Name: "C", Street__c: "123 N Main", Postal_Code__c: "85001" },        // address
    { Id: "4", Name: "D", Primary_Phone__c: "480-555-1234", Street__c: "999 Main", Postal_Code__c: "85001" }, // tail-only
    { Id: "5", Name: "E", Alternate_Contact_Phone__c: "602 555 1234" },              // the twin under the other phone field
    { Id: "6", Name: "F", Street__c: "123 Main Street", Postal_Code__c: "85001" },   // same house number, street typed differently
    { Id: "7", Name: "G", Street__c: "1234 N Main", Postal_Code__c: "85001" },       // a different house number
  ];
  const m = matchCandidates(rows, c);
  assert.deepEqual(m.map((x) => [x.id, x.reasons]), [["1", ["email"]], ["2", ["phone"]], ["3", ["address"]], ["5", ["phone"]], ["6", ["address"]]]);
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
  assert.equal("Is_Company__c" in f, false, "a person never writes the company fields");
});

test("buildNewCustomerFields: a company's Name is its company name, the contact kept in First / Last (D-081)", () => {
  const f = buildNewCustomerFields({ isCompany: true, companyName: "SunRun", firstName: "Dana", lastName: "Ruiz", email: "ap@sunrun.com" });
  assert.equal(f.Name, "SunRun");
  assert.equal(f.Is_Company__c, true);
  assert.equal(f.Company_Name__c, "SunRun");
  assert.equal(f.First_Name__c, "Dana");
  assert.equal(f.Last_Name__c, "Ruiz");
  const bare = buildNewCustomerFields({ isCompany: true, companyName: "APS", phone: "602-555-0000" });
  assert.equal(bare.Name, "APS");
  assert.equal("First_Name__c" in bare, false);
});

test("matchCandidates names a company candidate by its company name (D-081)", () => {
  const m = matchCandidates([{ Id: "1", Name: "C-0042", Is_Company__c: true, Company_Name__c: "SunRun", Primary_Email__c: "ap@sunrun.com" }], { email: "ap@sunrun.com" });
  assert.equal(m[0].name, "SunRun");
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

test("a line's description is never cut: the org's field length is the limit, and typed text over it is refused, not trimmed (2026-10-16)", () => {
  const long = "Remove existing (45) solar modules and associated racking components as well as all standoffs/flashings. ".repeat(6).trim(); // ~630 chars
  // the fallback (describe unreadable) is the field's original 255: refused, with the count
  const refused = adHocLine({ description: long, kind: "Labor", unitPrice: 8100 }, { estimateId: "E", tenantId: TENANT });
  assert.match(refused.problems[0], /description is \d+ characters; this field holds 255/);
  assert.match(linePatchFields({ description: long }).problems[0], /this field holds 255/);
  // the live length (a Long Text Area): kept whole
  const ok = adHocLine({ description: long, kind: "Labor", unitPrice: 8100 }, { estimateId: "E", tenantId: TENANT, descriptionMax: 32768 });
  assert.equal(ok.fields.Description__c, long);
  assert.equal(linePatchFields({ description: long }, { descriptionMax: 32768 }).fields.Description__c, long);
  // a catalog item's Long Text description is copied whole too
  const item = { Id: "PB1", Description__c: long, Price__c: 10 };
  assert.equal(lineFromItem(item, {}, { estimateId: "E", tenantId: TENANT, descriptionMax: 4000 }).fields?.Description__c ?? lineFromItem(item, {}, { estimateId: "E", tenantId: TENANT, descriptionMax: 4000 }).Description__c, long);
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
  assert.deepEqual(matchRoute("POST", "/prod/service/jobs/j1/payments"), { name: "recordJobDeposit", params: ["j1"] }); // a deposit before the invoice (2026-10-27)
  assert.deepEqual(matchRoute("POST", "/service/invoices/i1/payments"), { name: "recordPayment", params: ["i1"] });
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
    // IN ('a', 'b') — the intake alert's manager query (2026-10-02)
    if ((m = cond.match(/^(\w+) IN \((.*?)\)?$/))) { // the trailing ")" may already be stripped above
      const wanted = m[2].split(",").map((x) => x.trim().replace(/^'|'$/g, "").toLowerCase());
      return wanted.includes(String(rec[m[1]] ?? "").toLowerCase());
    }
    if ((m = cond.match(/^(\w+) LIKE '(.*)'$/))) {
      // SQL's % as a regex, anchored like SQL (no leading % = starts with; no trailing % = ends with)
      const v = String(rec[m[1]] ?? "").toLowerCase();
      const pat = m[2].toLowerCase();
      const re = new RegExp(`^${pat.split("%").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      return re.test(v);
    }
    // datetime bounds (the invoice report, 2026-10-01)
    if ((m = cond.match(/^(\w+) (>=|<) (\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/))) {
      const v = rec[m[1]];
      if (v == null) return false;
      return m[2] === ">=" ? Date.parse(v) >= Date.parse(m[3]) : Date.parse(v) < Date.parse(m[3]);
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
    let rows = store[obj].filter((r) => (where ? evalWhere(r, where) : true));
    // The line order every reader asks for (2026-10-22): Sort_Order__c NULLS LAST, then the
    // store's insertion order standing in for CreatedDate. Other ORDER BYs stay unmodelled.
    if (/ORDER BY Sort_Order__c NULLS LAST/.test(soql)) {
      rows = rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => {
        const x = a.Sort_Order__c == null ? Infinity : Number(a.Sort_Order__c);
        const y = b.Sort_Order__c == null ? Infinity : Number(b.Sort_Order__c);
        return x === y ? i - j : x - y;
      }).map(([r]) => r);
    }
    // The one relationship the labor routes read: a call's Tech__r (name + bill rate).
    return rows.map((r) => {
      if (obj === "Sundial_Service_Call__c" && r.Tech__c) return { ...r, Tech__r: store.Sundial_User__c.find((u) => u.Id === r.Tech__c) ?? null };
      // The invoice report's join (2026-10-01): an invoice's job.
      if (obj === "Sundial_Service_Invoice__c" && r.Service_Job__c) return { ...r, Service_Job__r: store.Sundial_Service_Job__c.find((j) => j.Id === r.Service_Job__c) ?? null };
      return { ...r };
    });
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
            { name: "Archived__c", type: "boolean" }, // 2026-10-02: off the lists; a reuse clears it
            // the intake questions (2026-10-02)
            { name: "System_Ownership__c", picklistValues: ["Own", "Lease", "PPA", "Not sure"].map((value) => ({ value, active: true })) },
            { name: "Property_Type__c", picklistValues: ["Residential", "Commercial"].map((value) => ({ value, active: true })) },
            { name: "Existing_Harmon_System__c", picklistValues: ["Yes", "No", "Not sure"].map((value) => ({ value, active: true })) },
            { name: "Inverter_Manufacturer__c", picklistValues: ["SolarEdge", "Enphase", "SMA", "Fronius", "Tesla", "Other", "Not sure"].map((value) => ({ value, active: true })) },
            { name: "Type_of_Service__c", picklistValues: ["Repair", "Maintenance", "Inspection", "Removal & Reinstall"].map((value) => ({ value, active: true })) },
            { name: "Next_Step__c", picklistValues: ["Schedule a visit", "Get a quote", "Call me back"].map((value) => ({ value, active: true })) },
            { name: "Service_Club_Interest__c", picklistValues: ["Yes", "No", "Maybe later"].map((value) => ({ value, active: true })) },
          ]),
        ]
      : obj === "Sundial_Tenant__c" && flags.tenantSettings
        ? [{ name: "Default_Tax_Rate__c", type: "percent" }, { name: "Default_Tax_Jurisdiction__c", type: "string" }, { name: "Labor_Burden_Percent__c", type: "percent" }]
        : obj === "Sundial_User__c" && flags.costRate
          ? [{ name: "Hourly_Cost_Rate__c", type: "currency" }]
          // 2026-10-16: the line's Description__c is a Long Text Area now; `fake.flags.shortLineDescription`
          // plays the old Text(255) org.
          : obj === "Sundial_Service_Line__c"
            ? [{ name: "Description__c", type: "textarea", length: flags.shortLineDescription ? 255 : 32768 }]
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
  const comments = []; // the customer feed's system lines (D-084)
  const tableRows = (table) => (table === "sundial_service_activity" ? activity : table === "sundial_file_metadata" ? files : table === "sundial_stripe_events" ? stripeEvents : table === "comments" ? comments : null);
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
  return { store, calls, stale, activity, stripeEvents, notes, flags, comments, emails: [], puts: [], fetches, deps: { sfQuery, sfCreateRecord, sfUpdateRecord, sfDeleteRecord, describeObject, getSupabaseClient, notifier } };
}

// The tax tables the tests run on (D-083) — Acumatica's shape, test numbers: Mesa's retail
// rate is 8.6 (the rate these tests always used), Phoenix 9.1 rising to 9.6 on 2026-11-01.
// Labor / Solar / Warranty carry a 0% tax each, as Acumatica's do.
export const TEST_TAX_ROWS = {
  zones: [
    { zone_code: "08MESAR", description: "Mesa - Retail", city_key: "MESA", county: "Maricopa", is_retail: true, tax_ids: ["08MESRT", "08MCORT", "LABSERVE", "SOLAR", "WARRANTY"] },
    { zone_code: "08PHOENIXR", description: "Phoenix - Retail", city_key: "PHOENIX", county: "Maricopa", is_retail: true, tax_ids: ["08PHXRT", "08MCORT", "LABSERVE", "SOLAR", "WARRANTY"] },
    { zone_code: "08PEORIAR", description: "Peoria - Retail", city_key: "PEORIA", county: "Maricopa", is_retail: true, tax_ids: ["08PEORT", "08MCORT", "LABSERVE", "SOLAR", "WARRANTY"] },
    { zone_code: "08TEMPER", description: "Tempe - Retail", city_key: "TEMPE", county: "Maricopa", is_retail: true, tax_ids: ["08TEMRT", "08MCORT", "LABSERVE", "SOLAR", "WARRANTY"] },
    { zone_code: "08MARICOPR", description: "Maricopa County - Retail", city_key: null, county: "Maricopa", is_retail: true, tax_ids: ["08MCORT", "LABSERVE", "SOLAR", "WARRANTY"] },
    { zone_code: "08PHOENIXC", description: "Phoenix - Contracting", city_key: null, county: "Maricopa", is_retail: false, tax_ids: ["08PHXCO"] },
  ],
  rates: [
    { tax_id: "08MESRT", schedule: [{ start: "2021-01-01", rate: 2.3 }] },
    { tax_id: "08PHXRT", schedule: [{ start: "2021-01-01", rate: 2.3 }, { start: "2025-07-01", rate: 2.8 }, { start: "2026-11-01", rate: 3.3 }] },
    { tax_id: "08PEORT", schedule: [{ start: "2021-01-01", rate: 1.8 }] },
    { tax_id: "08TEMRT", schedule: [{ start: "2021-01-01", rate: 1.8 }] },
    { tax_id: "08MCORT", schedule: [{ start: "2021-01-01", rate: 6.3 }] },
    { tax_id: "08PHXCO", schedule: [{ start: "2021-01-01", rate: 1.82 }] },
    { tax_id: "LABSERVE", schedule: [{ start: "2021-01-01", rate: 0 }] },
    { tax_id: "SOLAR", schedule: [{ start: "2021-01-01", rate: 0 }] },
    { tax_id: "WARRANTY", schedule: [{ start: "2021-01-01", rate: 0 }] },
  ],
  categories: [
    { category_id: "RETAIL", tax_ids: ["08MESRT", "08PHXRT", "08PEORT", "08TEMRT", "08MCORT"] },
    { category_id: "LABSERV", tax_ids: ["LABSERVE"] },
    { category_id: "SOLAR", tax_ids: ["SOLAR"] },
    { category_id: "WARRANTY", tax_ids: ["WARRANTY"] },
    { category_id: "RESALE", tax_ids: [] },
    { category_id: "CONTRACTING", tax_ids: ["08PHXCO"] },
  ],
  aliases: [{ alias_key: "SUN CITY", zone_code: "08MARICOPR", note: "from CFO 2026-10-06" }, { alias_key: "LAVEEN", zone_code: "08PHOENIXR", note: "from CFO 2026-10-06" }],
};
const TEST_TAX_TABLES = tablesFromRows(TEST_TAX_ROWS);

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
    ...(fake.resizeImage !== undefined ? { resizeImage: fake.resizeImage } : {}), // the report photo shrink (2026-10-12); null = none
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
      fake.puts.push({ key, bytes: body.byteLength, contentType, body: key.startsWith("SUNDIAL/_cache/") ? body : undefined });
    },
    deleteObject: async ({ key }) => {
      (fake.deletes = fake.deletes || []).push(key);
    },
    // The job report (D-072 am. 10): the job's S3 folder and the photo bytes for the PDF.
    listFiles: async (recordId) => (fake.files || []).filter((f) => f.key.startsWith(`SUNDIAL/${recordId}/`)),
    getObject: async ({ key }) => {
      // The report's shrunk-photo cache (2026-10-12): served from what this run put there, else "no such key".
      if (key.startsWith("SUNDIAL/_cache/")) {
        const hit = (fake.puts || []).find((p) => p.key === key);
        if (!hit) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        return { bytes: hit.body ?? JPG_1x1, contentType: "image/jpeg" };
      }
      (fake.gets = fake.gets || []).push(key);
      if (fake.getFails) throw new Error("s3 read failed");
      return { bytes: fake.photoBytes ?? JPG_1x1, contentType: "image/jpeg" };
    },
    sms: fake.sms ?? null,
    loadTaxTables: async (slug) => (fake.taxTables !== undefined ? fake.taxTables : slug === "harmon" ? TEST_TAX_TABLES : null),
    getSecret: async (name) => {
      if (name === "sundial/google-maps" && fake.googleKey) return { apiKey: fake.googleKey };
      if (name === "sundial/stripe" && fake.stripeSecret) return fake.stripeSecret;
      if (name === "sundial/service-club" && fake.clubSecret) return fake.clubSecret;
      if (name === "sundial/brand" && fake.brandSecret) return fake.brandSecret; // the tenant's logo + footer links (2026-09-24)
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
      if (url.startsWith("https://cdn.example.com/")) {
        // The brand's logo (2026-09-24): a real JPEG so the PDF can embed it.
        return { ok: true, status: 200, arrayBuffer: async () => JPG_1x1.buffer.slice(JPG_1x1.byteOffset, JPG_1x1.byteOffset + JPG_1x1.byteLength) };
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
  assert.equal(old.Archived__c, undefined, "a customer that was never archived is not written to");

  // An ARCHIVED customer (the HCP address book, 2026-10-02) who calls in: the flag comes off with the tag.
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Dusty Book", Primary_Email__c: "dusty@x.com", Customer_Type__c: "Service", Requested_Project_Types__c: "Service", Archived__c: true });
  const dustyId = fake.store.Sundial_Customer__c.at(-1).Id;
  const back = await call(h, "POST", "/service/customers", { customer: { id: dustyId } });
  assert.equal(back.status, 200);
  const dusty = fake.store.Sundial_Customer__c.find((c) => c.Id === dustyId);
  assert.equal(dusty.Archived__c, false, "Add to Service on an archived customer un-archives it");
  assert.equal(dusty.Service_Stage__c, "New");

  // The intake questions + the two always-on alerts (Harmon, 2026-10-02). The office: two Service
  // managers, one Sales manager, one inactive Service manager; Paige (USER) is one of the two.
  await fake.deps.sfCreateRecord("Sundial_User__c", { Client__c: TENANT, First_Name__c: "Paige", Last_Name__c: "King", Access_Level__c: "Admin", Default_Department__c: "Service", Active__c: true });
  const paige = fake.store.Sundial_User__c.at(-1);
  paige.Id = USER; // the signed-in user
  await fake.deps.sfCreateRecord("Sundial_User__c", { Client__c: TENANT, First_Name__c: "Larry", Last_Name__c: "Boss", Access_Level__c: "Manager", Default_Department__c: "Service", Active__c: true });
  const larry = fake.store.Sundial_User__c.at(-1);
  await fake.deps.sfCreateRecord("Sundial_User__c", { Client__c: TENANT, First_Name__c: "Sam", Last_Name__c: "Sales", Access_Level__c: "Manager", Default_Department__c: "Residential Solar", Active__c: true });
  await fake.deps.sfCreateRecord("Sundial_User__c", { Client__c: TENANT, First_Name__c: "Gone", Last_Name__c: "Exec", Access_Level__c: "Executive", Default_Department__c: "Service", Active__c: false });
  await fake.deps.sfCreateRecord("Sundial_User__c", { Client__c: TENANT, First_Name__c: "Jake", Last_Name__c: "Tech", Access_Level__c: "Technician", Default_Department__c: "Service", Active__c: true });
  const jake = fake.store.Sundial_User__c.at(-1);
  fake.notes.length = 0;
  const intake = { systemOwnership: "Lease", propertyType: "Residential", existingHarmonSystem: "Yes", inverterManufacturer: "SolarEdge", typeOfService: "Repair", description: "Inverter shows a red light since Tuesday", nextStep: "Schedule a visit", serviceClubInterest: "Maybe later", warrantyNotes: "Panels: 25 yr SunPower. Inverter: Enphase to 2031.", bogus: "x" };
  const made = await call(h, "POST", "/service/customers", { customer: { new: { firstName: "Ivy", lastName: "Intake", phone: "602-555-0199" } }, intake });
  assert.equal(made.status, 201);
  const ivy = fake.store.Sundial_Customer__c.find((c) => c.Id === made.body.customerId);
  assert.equal(ivy.System_Ownership__c, "Lease");
  assert.equal(ivy.Property_Type__c, "Residential");
  assert.equal(ivy.Existing_Harmon_System__c, "Yes");
  assert.equal(ivy.Inverter_Manufacturer__c, "SolarEdge");
  assert.equal(ivy.Type_of_Service__c, "Repair");
  assert.equal(ivy.Description__c, "Inverter shows a red light since Tuesday");
  assert.equal(ivy.Next_Step__c, "Schedule a visit");
  assert.equal(ivy.Service_Club_Interest__c, "Maybe later");
  assert.equal(ivy.Warranty_Notes__c, "Panels: 25 yr SunPower. Inverter: Enphase to 2031.", "free text, no picklist check (D-081)");
  assert.equal(ivy.Service_Stage__c, "New");
  // alert 1: nobody assigned → the ACTIVE Service managers, minus Paige who did it
  assert.equal(fake.notes.length, 1, JSON.stringify(fake.notes));
  assert.equal(fake.notes[0].category, "service_intake");
  assert.equal(fake.notes[0].kind, "customer_unassigned");
  assert.deepEqual(fake.notes[0].userSfIds, [larry.Id], "Larry only: Paige did it, Sam is Sales, Gone is inactive, Jake is a tech");
  assert.match(fake.notes[0].title, /New Service customer — nobody assigned/);
  assert.equal(fake.notes[0].url, `/service/customers/${ivy.Id}`, "the Service view (2026-10-07)");
  // an unknown picklist value is a warning, never a refusal
  const warned = await call(h, "POST", "/service/customers", { customer: { new: { firstName: "Wal", lastName: "Warn", phone: "602-555-0198" } }, intake: { inverterManufacturer: "Acme" } });
  assert.equal(warned.status, 201);
  assert.match(warned.body.warnings.join(" "), /"Acme" is not a Inverter_Manufacturer__c value/);
  // alert 2: created WITH an assignee → the assignee hears it, the managers do not
  fake.notes.length = 0;
  const assigned = await call(h, "POST", "/service/customers", { customer: { new: { firstName: "Al", lastName: "Assigned", phone: "602-555-0197" } }, request: { assignedTo: jake.Id } });
  assert.equal(assigned.status, 201);
  assert.equal(fake.notes.length, 1);
  assert.equal(fake.notes[0].kind, "customer_assigned");
  assert.deepEqual(fake.notes[0].userSfIds, [jake.Id]);
  assert.match(fake.notes[0].title, /Al Assigned was assigned to you/);
  assert.match(fake.notes[0].body, /Paige King put you in Assigned To/);
  // assigning yourself is silent
  fake.notes.length = 0;
  await call(h, "POST", "/service/customers", { customer: { new: { firstName: "Me", lastName: "Mine", phone: "602-555-0196" } }, request: { assignedTo: USER } });
  assert.equal(fake.notes.length, 0, "self-assignment: no alert");
  // the estimate popup on an EXISTING archived customer: the intake answers land, the un-archive alerts the managers
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Old Archived", Primary_Email__c: "oa@x.com", Customer_Type__c: "Service", Requested_Project_Types__c: "Service", Archived__c: true });
  const oaId = fake.store.Sundial_Customer__c.at(-1).Id;
  fake.notes.length = 0;
  const est = await call(h, "POST", "/service/estimates", { customer: { id: oaId }, intake: { typeOfService: "Inspection", description: "Annual check" } });
  assert.equal(est.status, 201);
  const oa = fake.store.Sundial_Customer__c.find((c) => c.Id === oaId);
  assert.equal(oa.Archived__c, false);
  assert.equal(oa.Type_of_Service__c, "Inspection");
  assert.equal(oa.Description__c, "Annual check");
  assert.equal(fake.notes.length, 1);
  assert.equal(fake.notes[0].kind, "customer_unassigned");
  assert.match(fake.notes[0].title, /Old Archived is back in Service — nobody assigned/);
  // the same existing, already-Service, not-archived customer again: no alert (nothing is new about them)
  fake.notes.length = 0;
  await call(h, "POST", "/service/jobs", { customer: { id: oaId }, job: {} });
  assert.equal(fake.notes.length, 0, "an existing Service customer reused: nobody is told");
  fake.store.Sundial_User__c.length = 0;

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
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Cy", Primary_Phone__c: "602-555-0001", City__c: "Mesa" });
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

  // Cy has a phone and no email: an email send with nothing in the box is refused before
  // anything is recorded (D-072 amendment 12), then goes out to the typed address.
  const s0 = await call(h, "POST", `/service/estimates/${estId}/send`, {});
  assert.equal(s0.status, 400);
  assert.equal(s0.body.code, "RECIPIENT_REQUIRED");
  assert.deepEqual(s0.body.missing, ["email"]);
  assert.equal(fake.store.Sundial_Estimate__c[0].Version__c, 0, "nothing recorded");
  const s1 = await call(h, "POST", `/service/estimates/${estId}/send`, { to: "cy@example.com" });
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
  // 2026-10-16: a long scope line is stored whole (the field is a Long Text Area; the Lambda reads its length from the describe)
  const scope = "Remove existing (45) solar modules and associated racking components as well as all standoffs/flashings for all (45) modules being removed. Store solar modules and related racking material onsite. Upon completion of roof repairs Harmon will return and reinstall the modules and racking, replace any flashings that cannot be reused, and recommission the system.";
  const dLong = await call(h, "PATCH", `/service/estimates/${estId}/lines/${catalogLine.Id}`, { description: scope });
  assert.equal(dLong.status, 200);
  assert.equal(catalogLine.Description__c, scope, "nothing cut off");
  fake.flags.shortLineDescription = true; // the old Text(255) org (a fresh handler: the describe is cached per handler): refused with the count, never trimmed
  const dShort = await call(makeHandler(fake), "PATCH", `/service/estimates/${estId}/lines/${catalogLine.Id}`, { description: `${scope} And more.` });
  delete fake.flags.shortLineDescription;
  assert.equal(dShort.status, 400);
  assert.equal(dShort.body.code, "LINE_INVALID");
  assert.match(dShort.body.message, /this field holds 255/);
  assert.equal(catalogLine.Description__c, scope, "the stored text is untouched by a refused edit");
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
  assert.deepEqual(evs, ["customer_tagged", "estimate_created", "line_added", "line_added", "estimate_updated", "estimate_sent", "estimate_sent", "estimate_approved", "job_created", "line_updated", "line_updated", "line_updated"]); // the third line_updated is the long-scope edit (2026-10-16); the refused one wrote nothing
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
  assert.ok(html.includes("Total tax") && html.includes("Phoenix"), "D-081: the jurisdiction sits under Total tax");
  assert.ok(html.includes("Deposit due to schedule"));
  assert.ok(html.includes("PREVIEW"));
  assert.ok(html.includes("1.50 Hour"));
  assert.ok(html.includes("Acme Solar") && html.includes("ROC #1"));
});

test("the tenant's brand on the documents (2026-09-24): sundial/brand → logo on the preview page and IN the sent PDF, the terms + Service Club links in the footer; an unconfigured tenant still prints a name", async () => {
  const fake = fakeSalesforce();
  fake.brandSecret = {
    default: { termsUrl: "https://club.example.com/terms" },
    harmon: { companyName: "Test Service", logoUrl: "https://cdn.example.com/logo.jpg", tagline: "Solar service, done right", licenseLine: "ROC #000000", clubUrl: "https://club.example.com/", clubBlurb: "Join the club for member pricing." },
  };
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Br", Primary_Email__c: "br@example.com" });
  const h = makeHandler(fake);
  const c = await call(h, "POST", "/service/estimates", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Truck roll", kind: "Labor", unitPrice: 275 }] });
  const p = await call(h, "GET", `/service/estimates/${c.body.id}/preview`);
  assert.equal(p.status, 200);
  assert.ok(p.body.html.includes('<img class="logo" src="https://cdn.example.com/logo.jpg"'), "the page shows the logo");
  assert.ok(p.body.html.includes("Solar service, done right"));
  assert.ok(p.body.html.includes("ROC #000000"));
  assert.ok(p.body.html.includes('href="https://club.example.com/terms"'), "the default block's terms link");
  assert.ok(p.body.html.includes("Join the club for member pricing."), "the tenant's club copy");
  assert.ok(p.body.html.includes('href="https://club.example.com/"'));

  const s1 = await call(h, "POST", `/service/estimates/${c.body.id}/send`, {});
  assert.equal(s1.status, 200);
  const pdf = fake.emails[0].attachments[0].content;
  const raw = Buffer.from(pdf).toString("latin1");
  assert.ok(/\/Subtype\s*\/Image/.test(raw), "the sent PDF embeds the logo");
  assert.ok(fake.fetches.filter((u) => u === "https://cdn.example.com/logo.jpg").length === 1, "fetched once, then cached");

  // The same handler, a tenant with no block: no logo, only the default links — and (D-078)
  // NOT the Lambda's SERVICE_BRAND_NAME, which is the primary tenant's name: it prints its own slug.
  const other = makeHandler(fake, { tenantSlug: "other" });
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Oth" });
  const c2 = await call(other, "POST", "/service/estimates", { customer: { id: fake.store.Sundial_Customer__c[1].Id } });
  const p2 = await call(other, "GET", `/service/estimates/${c2.body.id}/preview`);
  assert.ok(!p2.body.html.includes('class="logo"'));
  assert.ok(!p2.body.html.includes("Test Electric"), "never the primary tenant's env name");
  assert.ok(!p2.body.html.includes("Test Service"), "nor the primary tenant's block");
  assert.ok(p2.body.html.includes("Other"), "its own slug, capitalised, as before");
  assert.ok(p2.body.html.includes('href="https://club.example.com/terms"'));
  assert.ok(!p2.body.html.includes("club.example.com/\""));
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

  // Both with no phone anywhere: refused (the phone is named), nothing recorded.
  const s2x = await call(h, "POST", `/service/estimates/${c.body.id}/send`, { to: "other@example.com", via: "Both" });
  assert.equal(s2x.status, 400);
  assert.equal(s2x.body.code, "RECIPIENT_REQUIRED");
  assert.deepEqual(s2x.body.missing, ["phone"]);
  // A typed address that is not one: RECIPIENT_INVALID.
  const s2y = await call(h, "POST", `/service/estimates/${c.body.id}/send`, { to: "not-an-email", toPhone: "12", via: "Both" });
  assert.equal(s2y.status, 400);
  assert.equal(s2y.body.code, "RECIPIENT_INVALID");
  assert.deepEqual(s2y.body.invalid, ["email", "phone"]);
  // The box wins for both, and SMS is real now (lib/sms-send.js, the job's conversation):
  // Both = the email AND the text, each reported.
  const texts = [];
  fake.sms = { sendText: async (args) => (texts.push(args), { ok: true, code: null, error: null, to: "+16025550199", message: { id: "m1" } }) };
  const hs = makeHandler(fake);
  const s2 = await call(hs, "POST", `/service/estimates/${c.body.id}/send`, { to: "other@example.com", toPhone: "(602) 555-0199", via: "Both" });
  assert.equal(s2.status, 200, JSON.stringify(s2.body));
  assert.equal(s2.body.recipient, "other@example.com");
  assert.equal(s2.body.delivery, "both");
  assert.deepEqual(s2.body.recipients, { email: "other@example.com", phone: "+16025550199" });
  assert.equal(texts.length, 1);
  assert.equal(texts[0].to, "+16025550199");
  assert.ok(texts[0].body.includes("/estimate/TOKEN123"));
  assert.equal(texts[0].sentBy.name, "Paige King");
  assert.equal(s2.body.deliveryDetail, null);
  const sent2 = fake.activity.filter((a) => a.event === "estimate_sent").at(-1);
  assert.equal(sent2.details.via, "Both");
  assert.deepEqual(sent2.details.recipients, { email: "other@example.com", phone: "+16025550199" });
  // One half failing never undoes the other: the email goes, the text failure is reported.
  fake.sms = { sendText: async () => ({ ok: false, code: "SEND_FAILED", error: "The text was not sent (carrier).", to: "+16025550199", message: null }) };
  const s2z = await call(makeHandler(fake), "POST", `/service/estimates/${c.body.id}/send`, { toPhone: "6025550199", via: "Both" });
  assert.equal(s2z.status, 200);
  assert.equal(s2z.body.delivery, "email");
  assert.equal(s2z.body.recipient, "em@example.com");
  assert.ok(s2z.body.deliveryDetail.includes("Text failed"));
  fake.sms = null;

  // SES failure: version still bumps, delivery says recorded + why.
  fake.emailFails = true;
  const s3 = await call(h, "POST", `/service/estimates/${c.body.id}/send`, {});
  assert.equal(s3.body.version, 4);
  assert.equal(s3.body.delivery, "recorded");
  assert.ok(s3.body.deliveryDetail.includes("boom"));

  // No base URL configured: nothing goes out, and it says so.
  fake.emailFails = false;
  fake.publicBaseUrl = "";
  const h2 = makeHandler(fake);
  const s4 = await call(h2, "POST", `/service/estimates/${c.body.id}/send`, {});
  assert.equal(s4.body.version, 5);
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
  assert.equal(s5.body.version, 6);
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

  // The week's invoices for accounting (2026-10-01): issued-date range, the job's details, totals.
  const rep = await call(h, "GET", "/service/invoices/report", null, { from: "2026-09-07", to: "2026-09-13" });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.equal(rep.body.count, 1);
  assert.equal(rep.body.invoices[0].number, inv.Name);
  assert.equal(rep.body.invoices[0].customer, "Ivy");
  assert.equal(rep.body.invoices[0].total, 383.6);
  assert.equal(rep.body.invoices[0].balance, 283.6);
  assert.equal(rep.body.totals.balance, 283.6);
  assert.equal((await call(h, "GET", "/service/invoices/report", null, { from: "2026-08-01", to: "2026-08-07" })).body.count, 0);
  assert.equal((await call(h, "GET", "/service/invoices/report", null, { from: "2026-13-01" })).body.code, "RANGE_INVALID");

  // Harmon (2026-09-30): the office may reopen the estimate anyway. A copy of the invoice as it
  // stands is kept in the job's Files first; the invoice itself is untouched; the estimate goes
  // back to Approved / Sent / Draft (the void rule) and edits work again. A second unlock is a no-op.
  const putsBefore = fake.puts.length;
  const un = await call(h, "POST", `/service/estimates/${est.Id}/unlock`, {});
  assert.equal(un.status, 200, JSON.stringify(un.body));
  assert.equal(un.body.status, "Draft", "never sent or approved in this test → Draft (the void rule)");
  assert.equal(un.body.invoice.number, inv.Name);
  assert.match(un.body.snapshot.key, new RegExp(`^SUNDIAL/${job.Id}/${job.Name}-before-edit-\\d{8}T\\d{6}Z\\.pdf$`));
  assert.equal(fake.puts.length, putsBefore + 1);
  assert.equal(fake.puts.at(-1).contentType, "application/pdf");
  assert.equal(est.Status__c, "Draft");
  assert.equal(inv.Status__c, "Partially Paid", "the invoice is not touched");
  assert.equal(job.Status__c, "Invoiced", "the job is not touched");
  assert.ok(fake.activity.some((a) => a.event === "estimate_updated" && a.details.unlocked && a.details.invoice === inv.Name));
  const edit = await call(h, "PATCH", `/service/estimates/${est.Id}`, { scopeSummary: "Reopened to fix a line" });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal((await call(h, "POST", `/service/estimates/${est.Id}/unlock`, {})).body.unchanged, true);
  // put it back the way the rest of this test expects
  await fake.deps.sfUpdateRecord("Sundial_Estimate__c", est.Id, { Status__c: "Invoiced", Tax_Rate__c: 8.6 });

  // Preview reads as an invoice, not an estimate.
  const pv = await call(h, "GET", `/service/invoices/${inv.Id}/preview`);
  assert.equal(pv.status, 200);
  assert.ok(pv.body.html.includes('<span class="k">Invoice</span>'), "the meta box names the document");
  assert.ok(pv.body.html.includes("Payment terms"), "D-081: the HCP-style meta box (the bill-to block has no label)");
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
  // The pay link (amendment 11): the customer's page, in the email and on the preview, while money is owed.
  assert.ok(fake.emails.at(-1).html.includes("Pay $283.60 online"), fake.emails.at(-1).html);
  assert.ok(fake.emails.at(-1).text.includes("Pay online (card): https://portal.example.com/estimate/"));
  const pv2 = await call(h, "GET", `/service/invoices/${inv.Id}/preview`);
  assert.ok(pv2.body.html.includes("Pay this invoice"), "the invoice document carries the link");

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
  // (D-083: the rate is the zone's, so the fix is the line's category — the breaker was a solar part.)
  const breaker = fake.store.Sundial_Service_Line__c.find((l) => l.Description__c === "Breaker");
  const fix = await call(h, "PATCH", `/service/estimates/${est.Id}/lines/${breaker.Id}`, { taxCategory: "SOLAR" });
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

test("depositFieldsFromBody (2026-10-27): the invoice route's validation, held to Deposit and a non-card method", () => {
  const ctx = { jobId: "SER000000000000001", tenantId: TENANT, userId: USER, now: new Date("2026-10-27T15:00:00Z") };
  const ok = depositFieldsFromBody({ method: "ACH", amount: "125.005", reference: "ACH-77", notes: "first half" }, ctx);
  assert.deepEqual(ok.fields, {
    Service_Job__c: ctx.jobId, Client__c: TENANT, Type__c: "Deposit", Method__c: "ACH", Amount__c: 125.01, Status__c: "Succeeded",
    Received_At__c: "2026-10-27T15:00:00.000Z", Reference__c: "ACH-77", Notes__c: "first half", Recorded_By__c: USER,
  });
  assert.equal("Invoice__c" in ok.fields, false, "no invoice — the row hangs off the job");
  assert.equal(depositFieldsFromBody({ amount: 10 }, ctx).fields.Method__c, "Check", "the invoice route's default method");
  assert.equal(depositFieldsFromBody({ type: "Deposit", method: "Partner Remittance", amount: 10 }, ctx).fields.Type__c, "Deposit");
  assert.match(depositFieldsFromBody({ type: "Payment", amount: 10 }, ctx).problems.join(), /type must be Deposit/);
  assert.match(depositFieldsFromBody({ type: "Refund", amount: 10 }, ctx).problems.join(), /type must be Deposit/);
  assert.match(depositFieldsFromBody({ method: "Card", amount: 10 }, ctx).problems.join(), /Charge card/);
  assert.match(depositFieldsFromBody({ amount: 0 }, ctx).problems.join(), /positive/);
  assert.match(depositFieldsFromBody({ amount: 5, receivedAt: "not a date" }, ctx).problems.join(), /receivedAt/);
  assert.deepEqual(DEPOSIT_METHODS, ["Check", "ACH", "Partner Remittance", "Other"]);
});

test("office deposits before the invoice (2026-10-27, Harmon): a check / ACH lands on the job like a card deposit, counts against what is owed, is adopted at issue, and survives a void", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Ivy", Primary_Email__c: "ivy@example.com", Street__c: "5 Fir", City__c: "Mesa", State__c: "AZ", Postal_Code__c: "85201" });
  const h = makeHandler(fake);
  const j = await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, estimate: { depositRequired: true, depositType: "Flat", depositValue: 150 }, lines: [{ description: "Labor", kind: "Labor", unitPrice: 275 }, { description: "Breaker", kind: "Material", unitPrice: 100 }] });
  assert.equal(j.status, 201, JSON.stringify(j.body));
  const job = fake.store.Sundial_Service_Job__c[0];
  const est = fake.store.Sundial_Estimate__c[0];
  assert.equal(est.Deposit_Amount__c, 150);
  assert.ok(!est.Deposit_Paid_At__c);

  // Nothing yet: the no-invoice view carries a zero total beside its (empty) rows.
  let cur = await call(h, "GET", `/service/jobs/${job.Id}/invoice`);
  assert.equal(cur.body.invoice, null);
  assert.equal(cur.body.depositsTotal, 0);
  assert.deepEqual(cur.body.payments, []);

  // Refused before any write: the wrong type, a card, nothing.
  for (const body of [{ type: "Payment", method: "Check", amount: 50 }, { method: "Card", amount: 50 }, { method: "Check", amount: 0 }]) {
    const r = await call(h, "POST", `/service/jobs/${job.Id}/payments`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, "PAYMENT_INVALID");
  }
  assert.equal(fake.store.Sundial_Service_Payment__c.length, 0);
  assert.equal((await call(h, "POST", "/service/jobs/SER999999999999999/payments", { amount: 50 })).status, 404, "another tenant's (or no) job is a 404");

  // A $100 check: a Deposit row on the JOB, Succeeded, recorded by the caller — the card deposit's shape.
  let r = await call(h, "POST", `/service/jobs/${job.Id}/payments`, { type: "Deposit", method: "Check", amount: 100, reference: "1044", receivedAt: "2026-09-09" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = fake.store.Sundial_Service_Payment__c[0];
  assert.equal(r.body.id, row.Id);
  assert.equal(row.Service_Job__c, job.Id);
  assert.ok(!row.Invoice__c, "no invoice");
  assert.equal(row.Type__c, "Deposit");
  assert.equal(row.Method__c, "Check");
  assert.equal(row.Status__c, "Succeeded");
  assert.equal(row.Recorded_By__c, USER);
  assert.equal(row.Client__c, TENANT);
  assert.equal(row.Received_At__c, "2026-09-09T00:00:00.000Z");
  assert.equal(r.body.depositsTotal, 100);
  assert.equal(r.body.payments.length, 1);
  assert.equal(r.body.paymentStatus, "Deposit Paid", "jobPaymentStatusFor, as for a card deposit");
  assert.equal(job.Payment_Status__c, "Deposit Paid");
  assert.equal(r.body.jobStatus, job.Status__c);
  // Short of the estimate's $150 deposit: the customer's page still asks, and the office is told.
  assert.ok(!est.Deposit_Paid_At__c);
  assert.ok(r.body.warnings.some((w) => /still offers the deposit/.test(w)), JSON.stringify(r.body.warnings));
  const act = fake.activity.find((a) => a.event === "payment_recorded" && a.record_sf_id === row.Id);
  assert.ok(act, "activity row");
  assert.equal(act.details.via, "office-deposit");
  assert.equal(act.details.type, "Deposit");
  assert.equal(act.details.amount, 100);

  // A $50 ACH makes the deposit whole: the estimate is stamped like the card path stamps it.
  r = await call(h, "POST", `/service/jobs/${job.Id}/payments`, { method: "ACH", amount: 50 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.depositsTotal, 150);
  assert.deepEqual(r.body.warnings, []);
  assert.ok(est.Deposit_Paid_At__c, "the customer's page stops offering the deposit");

  // The reads agree: the job's invoice view, and the card page's `owed` (the estimate's total less
  // what was taken — a check subtracts exactly as a card does, because they are the same rows).
  cur = await call(h, "GET", `/service/jobs/${job.Id}/invoice`);
  assert.equal(cur.body.depositsTotal, 150);
  assert.equal(cur.body.payments.length, 2);
  const card = await call(h, "GET", `/service/jobs/${job.Id}/card`);
  assert.equal(card.status, 200, JSON.stringify(card.body));
  assert.equal(card.body.owedBasis, "estimate");
  assert.equal(card.body.estimateTotal, est.Total__c);
  assert.equal(card.body.owed, Math.round((est.Total__c - 150) * 100) / 100);

  // Issue adopts both rows; the invoice shows Paid to date / Balance due.
  const iss = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {});
  assert.equal(iss.status, 201, JSON.stringify(iss.body));
  const inv = fake.store.Sundial_Service_Invoice__c[0];
  assert.ok(fake.store.Sundial_Service_Payment__c.every((p) => p.Invoice__c === inv.Id), "both office deposits adopted");
  assert.equal(inv.Paid_Amount__c, 150);
  assert.equal(inv.Status__c, "Partially Paid");
  assert.equal(iss.body.balance, Math.round((inv.Total__c - 150) * 100) / 100);
  assert.equal(job.Payment_Status__c, "Partially Paid");
  const pv = await call(h, "GET", `/service/invoices/${inv.Id}/preview`);
  assert.ok(pv.body.html.includes("Paid to date"));
  assert.ok(pv.body.html.includes("-$150.00") || pv.body.html.includes("($150.00)") || pv.body.html.includes("−$150.00"), "the deposits shown as paid");
  assert.ok(pv.body.html.includes("Balance due"));

  // With a live invoice the money goes on the invoice — the job route says so, writes nothing.
  const blocked = await call(h, "POST", `/service/jobs/${job.Id}/payments`, { method: "Check", amount: 20 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "INVOICE_EXISTS");
  assert.equal(blocked.body.invoiceId, inv.Id);
  assert.equal(fake.store.Sundial_Service_Payment__c.length, 2);

  // Void never deletes money: the rows stay on the job, unhooked, and count again before the reissue.
  const v = await call(h, "POST", `/service/invoices/${inv.Id}/void`, { reason: "Wrong breaker" });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(fake.store.Sundial_Service_Payment__c.length, 2);
  assert.ok(fake.store.Sundial_Service_Payment__c.every((p) => !p.Invoice__c && p.Service_Job__c === job.Id && p.Status__c === "Succeeded"));
  assert.equal(job.Payment_Status__c, "Deposit Paid");
  cur = await call(h, "GET", `/service/jobs/${job.Id}/invoice`);
  assert.equal(cur.body.depositsTotal, 150);
  assert.equal(cur.body.invoice.Status__c, "Void");
  assert.equal(cur.body.payments.length, 2, "a void invoice's view lists the money waiting for the reissue");
  // …and the office may add to them again before the reissue.
  r = await call(h, "POST", `/service/jobs/${job.Id}/payments`, { method: "Other", amount: 25 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.depositsTotal, 175);
  const re = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {});
  assert.equal(re.status, 201, JSON.stringify(re.body));
  assert.equal(fake.store.Sundial_Service_Invoice__c[1].Paid_Amount__c, 175);
});

test("POST /service/jobs/{id}/payments is service.invoice.write: a tech is refused before any write", async () => {
  const fake = fakeSalesforce();
  const h = makeHandler(fake, { access: { level: "Technician", scope: "tech", userId: USER, tenantId: TENANT } });
  const r = await call(h, "POST", "/service/jobs/SER000000000000001/payments", { method: "Check", amount: 50 });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(fake.store.Sundial_Service_Payment__c.length, 0);
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

const mgrOf = (fake) => makeHandler(fake, { access: { level: "Manager", scope: "tenant", userId: USER, tenantId: TENANT } });
test("costing (2026-10-05): the job zone's rate lands on the estimate (D-083); a tech's cost rate × burden is the job's labor cost; margin = revenue − costs; Admin-only", async () => {
  const fake = fakeSalesforce();
  fake.flags.tenantSettings = true;
  fake.flags.costRate = true;
  fake.store.Sundial_Tenant__c[0] = { Id: TENANT, Name: "harmon", Default_Tax_Rate__c: 8.6, Default_Tax_Jurisdiction__c: "Phoenix, AZ", Labor_Burden_Percent__c: 80 };
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Cost", City__c: "Mesa" });
  await fake.deps.sfCreateRecord("Sundial_User__c", { Client__c: TENANT, Active__c: true, Access_Level__c: "Technician", First_Name__c: "Jake", Last_Name__c: "Dorsey", Hourly_Bill_Rate__c: 120, Hourly_Cost_Rate__c: 40 });
  await fake.deps.sfCreateRecord("Sundial_User__c", { Client__c: TENANT, Active__c: true, Access_Level__c: "Technician", First_Name__c: "New", Last_Name__c: "Guy", Hourly_Bill_Rate__c: 120 });
  const [jake, newGuy] = fake.store.Sundial_User__c;
  const h = makeHandler(fake);
  // A material line at 100 taxable, a flat-rate labor line at 275 whose book cost is 50.
  const j = await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Diagnostic", kind: "Labor", unitPrice: 275 }, { description: "Optimizer", kind: "Material", unitPrice: 100, taxable: true }] });
  assert.equal(j.status, 201, JSON.stringify(j.body));
  const est = fake.store.Sundial_Estimate__c[0];
  const jobId = fake.store.Sundial_Service_Job__c[0].Id;
  assert.equal(est.Tax_Rate__c, 8.6, "Mesa's rate from the tax tables (D-083), not the tenant default");
  assert.equal(est.Tax_Jurisdiction__c, "Mesa");
  assert.equal(est.Tax_Amount__c, 8.6, "8.6% of the taxable 100");
  assert.equal(est.Total__c, 383.6);
  fake.store.Sundial_Service_Line__c[0].Unit_Labor_Cost__c = 50; // the book's internal cost of the flat-rate item
  fake.store.Sundial_Service_Line__c[1].Unit_Material_Cost__c = 60;
  // Jake clocked 1h37 (→ 1.75 h) and is billed; New Guy clocked an hour, not billed, and has no cost rate.
  await fake.deps.sfCreateRecord("Sundial_Service_Call__c", { Client__c: TENANT, Name: "SC-1", Sundial_Service_Job__c: jobId, Tech__c: jake.Id, Status__c: "Complete", Actual_Start__c: "2026-09-14T15:00:00Z", Actual_End__c: "2026-09-14T16:37:00Z" });
  await fake.deps.sfCreateRecord("Sundial_Service_Call__c", { Client__c: TENANT, Name: "SC-2", Sundial_Service_Job__c: jobId, Tech__c: newGuy.Id, Status__c: "Complete", Actual_Start__c: "2026-09-15T15:00:00Z", Actual_End__c: "2026-09-15T16:00:00Z" });
  const [c1] = fake.store.Sundial_Service_Call__c;

  const lab = await call(h, "GET", `/service/jobs/${jobId}/labor`);
  assert.equal(lab.body.burdenPercent, 80);
  assert.equal(lab.body.calls[0].techCostRate, 40);
  assert.equal(lab.body.calls[0].costRate, 72, "40 × 1.8");
  assert.equal(lab.body.calls[0].cost, 126, "1.75 h × 72");
  assert.equal(lab.body.calls[1].costRate, null);
  const bill = await call(h, "POST", `/service/jobs/${jobId}/labor`, { calls: [{ id: c1.Id, billable: true }] });
  assert.equal(bill.status, 200, JSON.stringify(bill.body));
  const timeLine = fake.store.Sundial_Service_Line__c.find((l) => l.Source__c === "Time");
  assert.equal(timeLine.Unit_Labor_Cost__c, 72, "the burdened rate is remembered on the Time line");

  const c = await call(h, "GET", `/service/jobs/${jobId}/costing`);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.revenueSource, "estimate");
  assert.equal(c.body.revenue, cents(275 + 100 + 210 + 8.6));
  assert.equal(c.body.materialCost, 60);
  assert.equal(c.body.laborLineCost, 50, "the flat-rate item's book cost — never the Time line (that is the clock below)");
  assert.equal(c.body.techLaborCost, 126, "Jake's clock; New Guy's hour has no rate");
  assert.equal(c.body.techHours, 2.75);
  assert.equal(c.body.totalCost, 236);
  assert.equal(c.body.margin, cents(593.6 - 236));
  assert.equal(c.body.calls.length, 2);
  assert.equal(c.body.calls[1].billable, false, "an unbilled call still cost the company its hour");
  assert.ok(c.body.warnings.some((w) => w.startsWith("New Guy has no hourly cost rate")));

  // A tech's cost rate is set here (Admin), and clears with null.
  const cr = await call(h, "POST", "/service/labor/cost-rate", { userId: newGuy.Id, rate: 35 });
  assert.equal(cr.status, 200, JSON.stringify(cr.body));
  assert.equal(newGuy.Hourly_Cost_Rate__c, 35);
  const c2 = await call(h, "GET", `/service/jobs/${jobId}/costing`);
  assert.equal(c2.body.techLaborCost, cents(126 + 63));
  assert.equal(c2.body.warnings.length, 0);
  assert.equal((await call(h, "POST", "/service/labor/cost-rate", { userId: newGuy.Id, rate: -1 })).body.code, "RATE_INVALID");

  // The rate sheet: both techs, pay × burden shown.
  const sheet = await call(h, "GET", "/service/labor/rates");
  assert.equal(sheet.status, 200, JSON.stringify(sheet.body));
  assert.equal(sheet.body.burdenPercent, 80);
  assert.deepEqual(sheet.body.techs.map((u) => [u.name, u.billRate, u.costRate, u.burdenedRate]), [["Jake Dorsey", 120, 40, 72], ["New Guy", 120, 35, 63]]);
  assert.equal((await call(mgrOf(fake), "GET", "/service/labor/rates")).status, 403);

  // Once invoiced, the invoice's total is the revenue.
  const inv = await call(h, "POST", `/service/jobs/${jobId}/invoice`, {});
  assert.equal(inv.status, 201);
  const c3 = await call(h, "GET", `/service/jobs/${jobId}/costing`);
  assert.equal(c3.body.revenueSource, "invoice");
  assert.equal(c3.body.revenue, inv.body.invoice.Total__c);

  // A Manager cannot see costs — not on the costing route, and not on the labor rows either; an org without the fields says so.
  const mgr = makeHandler(fake, { access: { level: "Manager", scope: "tenant", userId: USER, tenantId: TENANT } });
  assert.equal((await call(mgr, "GET", `/service/jobs/${jobId}/costing`)).status, 403);
  const mgrLabor = await call(mgr, "GET", `/service/jobs/${jobId}/labor`);
  assert.equal(mgrLabor.status, 200);
  assert.equal(mgrLabor.body.burdenPercent, null);
  assert.ok(mgrLabor.body.calls.every((c) => c.techCostRate === null && c.costRate === null && c.cost === null), "pay rates are an Admin's to see");
  assert.equal(mgrLabor.body.calls[0].rate, 120, "the bill rate is still there");
  assert.equal((await call(mgr, "POST", "/service/labor/cost-rate", { userId: newGuy.Id, rate: 1 })).status, 403);
  const bare = fakeSalesforce();
  await bare.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Bare" });
  const hb = makeHandler(bare);
  await call(hb, "POST", "/service/jobs", { customer: { id: bare.store.Sundial_Customer__c[0].Id }, lines: [{ description: "x", kind: "Material", unitPrice: 10, taxable: true }] });
  assert.equal(bare.store.Sundial_Estimate__c[0].Tax_Rate__c ?? null, null, "no city, no zone → no rate (D-083 never guesses)");
  const cb = await call(hb, "GET", `/service/jobs/${bare.store.Sundial_Service_Job__c[0].Id}/costing`);
  assert.equal(cb.status, 200);
  assert.ok(cb.body.warnings.some((w) => w.includes("Hourly_Cost_Rate__c")));
  assert.equal((await call(hb, "POST", "/service/labor/cost-rate", { userId: USER, rate: 1 })).body.code, "FIELD_MISSING");
});

test("labor billing: billable calls become Labor lines (Source Time), edits rewrite them, unbilling removes them, the invoice locks them", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Lab", City__c: "Mesa" });
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
  assert.equal(piCreate.get("off_session"), null, "never on the create — Stripe refuses off_session without confirm (2026-10-12)");
  assert.equal(piCreate.get("confirm"), "false");
  const piConfirm = new URLSearchParams(stripeCalls.find((c) => c.url.endsWith(`/payment_intents/${created.pi}/confirm`)).init.body);
  assert.equal(piConfirm.get("off_session"), "true", "the stored card is charged off-session on the confirm call");
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

test("stripe: a deposit paid before the job exists is deferred, then lands when the office creates the job; issue NEVER charges the balance (2026-10-19), the Charge card button does", async () => {
  const fake = fakeSalesforce();
  fake.stripeSecret = STRIPE_SECRET;
  const stripeCalls = [];
  fake.stripe = async (url, init) => {
    stripeCalls.push({ url, method: init?.method });
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

  // Issue — even with the old `chargeCard: true` flag — moves no money: the invoice is issued,
  // the deposit alone is applied, the card untouched, and the caller is told (Harmon, 2026-10-19:
  // the portal's ticked-by-default box was charging cards the office never meant to charge).
  const piBefore = stripeCalls.filter((c) => c.url.endsWith("/payment_intents") && c.method === "POST").length;
  const iss = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, { chargeCard: true });
  assert.equal(iss.status, 201, JSON.stringify(iss.body));
  assert.equal(iss.body.charge.ok, false);
  assert.equal(iss.body.charge.code, "NOT_AT_ISSUE");
  assert.ok(iss.body.warnings.some((w) => /never charges the card on file/.test(w)), JSON.stringify(iss.body.warnings));
  assert.equal(stripeCalls.filter((c) => c.url.endsWith("/payment_intents") && c.method === "POST").length, piBefore, "no PaymentIntent was created by the issue");
  const inv = fake.store.Sundial_Service_Invoice__c[0];
  assert.equal(inv.Paid_Amount__c, 50, "only the deposit is applied");
  assert.equal(inv.Status__c, "Partially Paid");
  assert.equal(iss.body.paymentStatus, "Partially Paid");
  assert.equal(fake.store.Sundial_Service_Payment__c.length, 1, "no payment row was written by the issue");
  // Money moves only when a payment is created: the office's Charge card button charges the 150 balance.
  const chg = await call(h, "POST", `/service/invoices/${inv.Id}/charge`);
  assert.equal(chg.status, 200, JSON.stringify(chg.body));
  assert.equal(chg.body.amount, 150);
  assert.equal(inv.Paid_Amount__c, 200);
  assert.equal(inv.Status__c, "Paid");
});

test("stripe (amendment 11): the office's card on file — status from Stripe, the hosted card page, the customer link by text / email, an Admin charge of any amount (deposit before the invoice, the balance after), a Manager allowed (2026-10-16), a level-less user refused, the caps", async () => {
  const fake = fakeSalesforce();
  fake.stripeSecret = STRIPE_SECRET;
  const stripeCalls = [];
  let hasCard = false;
  let piSeq = 0;
  fake.stripe = async (url, init) => {
    stripeCalls.push({ url, method: init?.method, params: init?.body ? new URLSearchParams(init.body) : null });
    if (url.endsWith("/customers") && init.method === "POST") return { ok: true, status: 200, json: async () => ({ id: "cus_office" }) };
    if (/\/customers\/cus_office$/.test(url) && init.method === "GET") return { ok: true, status: 200, json: async () => ({ id: "cus_office", deleted: false, invoice_settings: { default_payment_method: hasCard ? "pm_visa" : null } }) };
    if (url.endsWith("/payment_methods/pm_visa")) return { ok: true, status: 200, json: async () => ({ id: "pm_visa", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } }) };
    if (url.endsWith("/checkout/sessions") && init.method === "POST") return { ok: true, status: 200, json: async () => ({ id: "cs_office_1", url: "https://checkout.stripe.com/c/pay/cs_office_1" }) };
    if (url.endsWith("/setup_intents/seti_1")) return { ok: true, status: 200, json: async () => ({ id: "seti_1", payment_method: "pm_visa" }) };
    if (url.endsWith("/payment_intents") && init.method === "POST") {
      piSeq += 1;
      return { ok: true, status: 200, json: async () => ({ id: `pi_off_${piSeq}`, status: "requires_confirmation" }) };
    }
    if (/\/payment_intents\/pi_off_\d+\/confirm$/.test(url)) {
      const id = url.split("/").slice(-2)[0];
      return { ok: true, status: 200, json: async () => ({ id, status: "succeeded", created: 1_789_002_000, latest_charge: `ch_${id}` }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Ivy", Primary_Email__c: "ivy@example.com", Primary_Phone__c: "602-555-0101", Street__c: "5 Fir", City__c: "Mesa", State__c: "AZ", Postal_Code__c: "85201" });
  const texts = [];
  fake.sms = { sendText: async (args) => { texts.push(args); return { ok: true, code: null, error: null, to: "+16025550101", message: { id: "m1" } }; } };
  const h = makeHandler(fake);
  const customer = fake.store.Sundial_Customer__c[0];
  // A quick-created job (its estimate is a Draft — the office's go-ahead is the job itself).
  const j = await call(h, "POST", "/service/jobs", { customer: { id: customer.Id }, lines: [{ description: "Labor", kind: "Labor", unitPrice: 300 }] });
  assert.equal(j.status, 201, JSON.stringify(j.body));
  const job = fake.store.Sundial_Service_Job__c[0];

  // 1. No card yet: the status says so, what is owed comes from the estimate, the customer link is minted.
  let r = await call(h, "GET", `/service/jobs/${job.Id}/card`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.configured, true);
  assert.equal(r.body.cardOnFile, false);
  assert.equal(r.body.owed, 300);
  assert.equal(r.body.owedBasis, "estimate");
  assert.equal(r.body.customerUrl, "https://portal.example.com/estimate/TOKEN123");
  assert.equal(fake.store.Sundial_Estimate__c[0].Public_Token__c, "TOKEN123");
  // A charge with no card is refused before Stripe is asked for money.
  r = await call(h, "POST", `/service/jobs/${job.Id}/charge`, { amount: 100 });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, "NO_CARD");

  // 2. The office opens Stripe's card page: a setup-mode Checkout on the customer, back to the job page after.
  r = await call(h, "POST", `/service/jobs/${job.Id}/card-session`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.url, "https://checkout.stripe.com/c/pay/cs_office_1");
  const sess = stripeCalls.find((c) => c.url.endsWith("/checkout/sessions"));
  assert.equal(sess.params.get("mode"), "setup");
  assert.equal(sess.params.get("customer"), "cus_office");
  assert.equal(sess.params.get("success_url"), `https://portal.example.com/service/jobs/${job.Id}?card=saved`);
  assert.equal(sess.params.get("metadata[kind]"), "office_setup");
  assert.equal(sess.params.get("metadata[jobId]"), job.Id);
  assert.equal(customer.Stripe_Customer_Id__c, "cus_office");
  // The customer can be sent the link instead — by text (the job's number) or email.
  r = await call(h, "POST", `/service/jobs/${job.Id}/card-link`, { via: "sms" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(texts.length, 1);
  assert.ok(texts[0].body.includes("https://portal.example.com/estimate/TOKEN123"), texts[0].body);
  assert.ok(texts[0].body.includes("Keep a card on file"));
  r = await call(h, "POST", `/service/jobs/${job.Id}/card-link`, { via: "email" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.to, "ivy@example.com");
  assert.ok(fake.emails[fake.emails.length - 1].subject.startsWith("Keep a card on file for SVC-"));

  // 3. Stripe reports the card (the webhook), and the status reads brand / last 4 live from Stripe.
  hasCard = true;
  const meta = { tenant: "harmon", tenantId: TENANT, estimateId: job.Estimate__c, jobId: job.Id, customerId: customer.Id, invoiceId: "", kind: "office_setup" };
  r = await send(h, stripeDelivery(evt("evt_office_cs", "checkout.session.completed", { id: "cs_office_1", object: "checkout.session", mode: "setup", customer: "cus_office", setup_intent: "seti_1", metadata: meta })));
  assert.equal(r.body.status, "applied", JSON.stringify(r.body));
  assert.equal(job.Customer_Card_on_File__c, true);
  r = await call(h, "GET", `/service/jobs/${job.Id}/card`);
  assert.equal(r.body.cardOnFile, true);
  assert.deepEqual(r.body.card, { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 });

  // 4. An Admin charges a $100 deposit before any invoice: a Deposit row, the job reads Deposit Paid.
  r = await call(h, "POST", `/service/jobs/${job.Id}/charge`, { amount: 100, note: "Deposit taken over the phone" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.type, "Deposit");
  assert.equal(r.body.amount, 100);
  const dep = fake.store.Sundial_Service_Payment__c[0];
  assert.equal(dep.Type__c, "Deposit");
  assert.equal(dep.Status__c, "Succeeded");
  assert.equal(dep.Invoice__c, undefined);
  assert.ok(dep.Notes__c.includes("Deposit taken over the phone"));
  assert.equal(job.Payment_Status__c, "Deposit Paid");
  const piCall = stripeCalls.find((c) => c.url.endsWith("/payment_intents") && c.method === "POST");
  assert.equal(piCall.params.get("amount"), "10000");
  assert.equal(piCall.params.get("off_session"), null, "off_session rides on the confirm call, not the create");
  assert.equal(piCall.params.get("metadata[kind]"), "deposit");
  // More than what is left ($200) is refused; a tenant user with no listed level is refused
  // outright (the level gate). A Manager may charge since 2026-10-16 — see step 5.
  r = await call(h, "POST", `/service/jobs/${job.Id}/charge`, { amount: 250 });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "AMOUNT_TOO_HIGH");
  assert.equal(r.body.owed, 200);
  const noLevel = makeHandler(fake, { user: { id: "USR000000000000002" }, access: { level: null, scope: "tenant", userId: "USR000000000000002", tenantId: TENANT } });
  r = await call(noLevel, "POST", `/service/jobs/${job.Id}/charge`, { amount: 50 });
  assert.equal(r.status, 403);
  // Issue never charges, whoever asks (2026-10-19): the old tick issues the invoice, uncharged, and says so.
  r = await call(noLevel, "POST", `/service/jobs/${job.Id}/invoice`, { chargeCard: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.charge.ok, false);
  assert.equal(r.body.charge.code, "NOT_AT_ISSUE");
  assert.ok(r.body.warnings.some((w) => /never charges the card on file/.test(w)));
  const invM = fake.store.Sundial_Service_Invoice__c[0];
  assert.equal((await call(noLevel, "POST", `/service/invoices/${invM.Id}/charge`)).status, 403);
  await call(h, "POST", `/service/invoices/${invM.Id}/void`, { reason: "test" });
  // …but they may still read the status and open the card page.
  assert.equal((await call(noLevel, "GET", `/service/jobs/${job.Id}/card`)).status, 200);
  const manager = makeHandler(fake, { user: { id: "USR000000000000003" }, access: { level: "Manager", scope: "tenant", userId: "USR000000000000003", tenantId: TENANT } });

  // 5. The invoice is issued (the deposit rides on it); the office charges the $200 balance in part, then the rest.
  const iss = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {});
  assert.equal(iss.status, 201, JSON.stringify(iss.body));
  const inv = fake.store.Sundial_Service_Invoice__c.find((i) => i.Status__c !== "Void");
  assert.equal(inv.Paid_Amount__c, 100);
  r = await call(h, "GET", `/service/jobs/${job.Id}/card`);
  assert.equal(r.body.owedBasis, "invoice");
  assert.equal(r.body.owed, 200);
  // A Manager runs billing (2026-10-16): the part payment is theirs.
  r = await call(manager, "POST", `/service/jobs/${job.Id}/charge`, { amount: 75 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.type, "Payment");
  assert.equal(inv.Paid_Amount__c, 175);
  assert.equal(inv.Status__c, "Partially Paid");
  r = await call(h, "POST", `/service/jobs/${job.Id}/charge`, { amount: 125 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(inv.Status__c, "Paid");
  assert.equal(job.Status__c, "Paid");
  r = await call(h, "POST", `/service/jobs/${job.Id}/charge`, { amount: 1 });
  assert.equal(r.body.code, "NOTHING_DUE");
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
  // D-078: a FLAT secret (no `tenants` key) is the primary tenant's and nobody else's —
  // another tenant must never reach its SolarFax credentials or its team inbox.
  const FLAT_CLUB = { solarFacts: { apiKey: "k", accessToken: "t" }, solarFactsHookUrl: "https://hooks.zapier.com/catch/1/on", teamEmail: "service-team@example.com" };
  assert.equal(clubConfigFor(FLAT_CLUB, "harmon", {}).teamEmail, "service-team@example.com");
  assert.equal(clubConfigFor(FLAT_CLUB, "harmon", {}).solarFacts.apiKey, "k");
  assert.equal(clubConfigFor(FLAT_CLUB, "conops-demo", {}), null);
  assert.equal(clubConfigFor(FLAT_CLUB, null, {}), null);
  assert.equal(clubConfigFor(FLAT_CLUB, "acme", { SUNDIAL_PRIMARY_TENANT: "acme" }).teamEmail, "service-team@example.com");
  assert.equal(clubConfigFor(FLAT_CLUB, "harmon", { SUNDIAL_PRIMARY_TENANT: "acme" }), null);
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
  // D-083: the part is a Material line → RETAIL by default, taxed at Mesa's 8.6% on its share of the net (100 × 280/300).
  assert.equal(est.Tax_Amount__c, 8.03);
  assert.equal(est.Total__c, 288.03);
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
  assert.equal(inv.body.sendEmailTemplate, "Harmon Connect");
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
  const errLines = [];
  const realError = console.error;
  console.error = (...args) => { errLines.push(args.map(String).join(" ")); };
  try {
  r = await send(h, stripeDelivery(evt("evt_x3", "checkout.session.completed", { id: "cs_test_2", object: "checkout.session", mode: "subscription", customer: "cus_club2", subscription: "sub_y", metadata: { tenantId: TENANT, membershipId: m2.Id } })));
  assert.equal(r.status, 200);
  assert.equal(m2.Status__c, "Active");
  assert.equal(m2.SolarFacts_Status__c, "Failed");
  } finally { console.error = realError; }
  // SolarFax's body is stored for support: "<status>: <message> — <body>".
  assert.equal(m2.SolarFacts_Last_Error__c, '200: Invalid Api-Key — {"success":false,"message":"Invalid Api-Key"}');
  const logLine = errLines.find((l) => l.startsWith("club: SolarFax answered"));
  assert.ok(logLine, "the status + body + request are logged");
  const logged = JSON.parse(logLine.slice("club: SolarFax answered ".length));
  assert.equal(logged.status, 200);
  assert.deepEqual(logged.body, { success: false, message: "Invalid Api-Key" });
  assert.equal(logged.request.user.email, "b***@example.com", "the email is masked");
  assert.equal(logged.event, "member.activated");
  assert.ok(!errLines.some((l) => /key-1|tok-1|bo@example.com/.test(l)), "never the key, the token or the full email");
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

// ---------------------------------------------------------------------------
// D-078 — a customer link opens the TENANT'S OWN site, under the tenant's own name
// ---------------------------------------------------------------------------
test("D-078: SERVICE_PUBLIC_BASE_URL and SERVICE_BRAND_NAME are the PRIMARY tenant's — another tenant's estimate, card, report and club links use its own brand block, or are not built at all", async () => {
  const DEMO_URL = "https://demo.constructiveops.example";
  const world = async (brandBlock) => {
    const fake = fakeSalesforce();
    fake.brandSecret = { default: { accentColor: "#111111" }, harmon: { companyName: "Test Service" }, ...(brandBlock ? { "conops-demo": brandBlock } : {}) };
    fake.stripeSecret = { tenants: { harmon: { secretKey: "sk_test_h" }, "conops-demo": { secretKey: "sk_test_demo" } } };
    const stripeCalls = [];
    fake.stripe = async (url, init) => {
      stripeCalls.push({ url, params: init?.body ? new URLSearchParams(init.body) : null });
      if (url.endsWith("/customers") && init.method === "POST") return { ok: true, status: 200, json: async () => ({ id: "cus_demo" }) };
      if (url.endsWith("/checkout/sessions")) return { ok: true, status: 200, json: async () => ({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" }) };
      return { ok: true, status: 200, json: async () => ({ id: "cus_demo", deleted: false, invoice_settings: {} }) };
    };
    const texts = [];
    fake.sms = { sendText: async (args) => (texts.push(args), { ok: true, code: null, error: null, to: "+16025550101", message: { id: "m1" } }) };
    await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Ivy Lane", Primary_Email__c: "ivy@example.com", Primary_Phone__c: "602-555-0101" });
    // The Lambda's own values (makeHandler): publicBaseUrl https://portal.example.com, brandName "Test Electric".
    const h = makeHandler(fake, { tenantSlug: "conops-demo" });
    const j = await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Labor", kind: "Labor", unitPrice: 300 }] });
    assert.equal(j.status, 201, JSON.stringify(j.body));
    const job = fake.store.Sundial_Service_Job__c[0];
    return { fake, h, job, estId: job.Estimate__c, stripeCalls, texts };
  };
  const everything = (w) => JSON.stringify([w.fake.emails.map((e) => [e.subject, e.text, e.html]), w.texts.map((t) => t.body), w.stripeCalls.map((c) => String(c.params ?? ""))]);

  // --- configured: publicUrl (here from portalUrl) + companyName ---------------------
  const ok = await world({ companyName: "Constructive Operations", portalUrl: `${DEMO_URL}/` });
  let r = await call(ok.h, "POST", `/service/estimates/${ok.estId}/send`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.delivery, "email");
  assert.equal(r.body.publicUrl, `${DEMO_URL}/estimate/TOKEN123`);
  assert.ok(ok.fake.emails[0].html.includes(`${DEMO_URL}/estimate/TOKEN123`));
  assert.ok(ok.fake.emails[0].subject.includes("Constructive Operations"));
  r = await call(ok.h, "GET", `/service/jobs/${ok.job.Id}/card`);
  assert.equal(r.body.customerUrl, `${DEMO_URL}/estimate/TOKEN123`);
  r = await call(ok.h, "POST", `/service/jobs/${ok.job.Id}/card-session`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const session = ok.stripeCalls.find((c) => c.url.endsWith("/checkout/sessions"));
  assert.ok(session.params.get("success_url").startsWith(`${DEMO_URL}/`), session.params.get("success_url"));
  assert.ok(session.params.get("cancel_url").startsWith(`${DEMO_URL}/`));
  r = await call(ok.h, "POST", `/service/jobs/${ok.job.Id}/card-link`, { via: "sms" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.url, `${DEMO_URL}/estimate/TOKEN123`);
  assert.ok(ok.texts[0].body.includes("Constructive Operations here."));
  ok.job.Report_Public_Token__c = "REPORTTOKEN";
  r = await call(ok.h, "GET", `/service/jobs/${ok.job.Id}/report`);
  assert.equal(r.body.publicUrl, `${DEMO_URL}/report/REPORTTOKEN`);
  assert.ok(!everything(ok).includes("portal.example.com"), "the primary tenant's address reaches nothing");
  assert.ok(!everything(ok).includes("Test Electric"), "nor does its name");

  // --- not configured: no block at all, or a block with no address ----------------------
  for (const block of [null, { companyName: "Constructive Operations" }]) {
    const off = await world(block);
    r = await call(off.h, "POST", `/service/estimates/${off.estId}/send`, {});
    assert.equal(r.status, 200, "the version is still recorded");
    assert.equal(r.body.delivery, "recorded");
    assert.equal(r.body.publicUrl, null);
    assert.match(r.body.deliveryDetail, /PORTAL_URL_NOT_CONFIGURED/);
    assert.equal(off.fake.emails.length, 0, "no email with somebody else's link");
    r = await call(off.h, "GET", `/service/jobs/${off.job.Id}/card`);
    assert.equal(r.body.customerUrl, null);
    r = await call(off.h, "POST", `/service/jobs/${off.job.Id}/card-session`, {});
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "PORTAL_URL_NOT_CONFIGURED");
    assert.ok(!off.stripeCalls.some((c) => c.url.endsWith("/checkout/sessions")));
    r = await call(off.h, "POST", `/service/jobs/${off.job.Id}/card-link`, { via: "sms" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "PORTAL_URL_NOT_CONFIGURED");
    assert.equal(off.texts.length, 0);
    off.job.Report_Public_Token__c = "REPORTTOKEN";
    r = await call(off.h, "GET", `/service/jobs/${off.job.Id}/report`);
    assert.equal(r.body.publicUrl, null);
    assert.ok(!everything(off).includes("portal.example.com"));
  }

  // --- the public Service Club pages take the tenant from the URL's slug ------------------
  const joiner = { firstName: "Ann", lastName: "Lee", email: "ann@example.com", phone: "602-555-0101", street: "9 Oak St", city: "Mesa", state: "AZ", postalCode: "85201" };
  const clubWorld = async (block) => {
    const w = await world(block);
    w.fake.store.Sundial_Tenant__c = [{ Id: TENANT, Name: "conops-demo" }];
    for (const row of PLAN_ROWS(TENANT)) await w.fake.deps.sfCreateRecord("Sundial_Service_Plan__c", row);
    w.fake.stripe = clubStripe(w.fake, w.stripeCalls);
    return w;
  };
  const club = await clubWorld({ companyName: "Constructive Operations", publicUrl: DEMO_URL });
  r = await pub(club.h, "GET", "/public/club/conops-demo/plans");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.brand, "Constructive Operations");
  r = await pub(club.h, "POST", "/public/club/conops-demo/join", { planCode: "monitor", interval: "monthly", customer: joiner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const joinSession = club.stripeCalls.filter((c) => c.url.endsWith("/checkout/sessions")).at(-1);
  assert.equal(joinSession.params.get("success_url"), `${DEMO_URL}/club/joined?session={CHECKOUT_SESSION_ID}`);
  assert.ok(joinSession.params.get("cancel_url").startsWith(`${DEMO_URL}/club/join?`));
  assert.equal(joinSession.init.headers.Authorization, "Bearer sk_test_demo");

  const bareClub = await clubWorld(null);
  r = await pub(bareClub.h, "GET", "/public/club/conops-demo/plans");
  assert.equal(r.status, 200);
  assert.equal(r.body.brand, "Conops-Demo", "its own slug — never the Lambda's SERVICE_BRAND_NAME");
  r = await pub(bareClub.h, "POST", "/public/club/conops-demo/join", { planCode: "monitor", interval: "monthly", customer: joiner });
  assert.equal(r.status, 503, "no address to return to → the join is not offered");
  assert.equal(r.body.code, "PUBLIC_URL_NOT_SET");
  assert.ok(!bareClub.stripeCalls.some((c) => c.url.endsWith("/checkout/sessions")));
});

test("D-078: the PRIMARY tenant's links are built from the Lambda's own address whatever its brand block says — nothing changed for it", async () => {
  const fake = fakeSalesforce();
  // Even if somebody puts addresses in the primary tenant's block, they are not used for it.
  fake.brandSecret = { harmon: { companyName: "Test Service", portalUrl: "https://ignored.example.com", publicUrl: "https://ignored.example.com" } };
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Em", Primary_Email__c: "em@example.com" });
  const h = makeHandler(fake);
  const c = await call(h, "POST", "/service/estimates", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Truck roll", kind: "Labor", unitPrice: 275 }] });
  const s = await call(h, "POST", `/service/estimates/${c.body.id}/send`, {});
  assert.equal(s.body.publicUrl, "https://portal.example.com/estimate/TOKEN123");
  assert.ok(fake.emails[0].html.includes("https://portal.example.com/estimate/TOKEN123"));
  assert.ok(!fake.emails[0].html.includes("ignored.example.com"));
});

// ---------------------------------------------------------------------------
// D-081 — the payer is a Customer record: required for a partner type, the name derived,
// snapshotted onto the invoice at issue (and re-snapshotted on the -2 reissue)
// ---------------------------------------------------------------------------
test("D-081: New Job with a partner Bill To needs the paying customer — refused BEFORE the customer / estimate exist", async () => {
  const fake = fakeSalesforce();
  const h = makeHandler(fake);
  const r = await call(h, "POST", "/service/jobs", {
    customer: { new: { firstName: "Mark", lastName: "Haughn", email: "mark@example.com", phone: "623-555-0142" } },
    job: { billToType: "Leasing Partner" },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "BILL_TO_CUSTOMER_REQUIRED");
  assert.equal(r.body.field, "Bill_To_Customer__c");
  assert.equal(fake.store.Sundial_Customer__c.length, 0, "no customer was created");
  assert.equal(fake.store.Sundial_Estimate__c.length, 0, "no estimate was created");
  assert.equal(fake.store.Sundial_Service_Job__c.length, 0);
  // Another tenant's company is not a payer here.
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: "a1W000000OTHERTENA", Is_Company__c: true, Company_Name__c: "SunRun" });
  const other = fake.store.Sundial_Customer__c[0].Id;
  const r2 = await call(h, "POST", "/service/jobs", { customer: { new: { firstName: "Mark", lastName: "Haughn", email: "mark@example.com" } }, job: { billToType: "Leasing Partner", billToCustomerId: other } });
  assert.equal(r2.body.code, "BILL_TO_CUSTOMER_NOT_FOUND");
  assert.equal(fake.store.Sundial_Estimate__c.length, 0);
});

test("D-081: the job's Bill To name is derived from the paying company; billToName is ignored; issue snapshots the payer; the -2 reissue re-snapshots", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Mark Haughn", First_Name__c: "Mark", Last_Name__c: "Haughn", Primary_Email__c: "mark@example.com", Street__c: "25825 N 134th Drive", City__c: "Peoria", State__c: "AZ", Postal_Code__c: "85383" });
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "SunRun", Is_Company__c: true, Company_Name__c: "SunRun", First_Name__c: "Dana", Last_Name__c: "Ruiz", Mailing_Street__c: "Po Box 53940", Mailing_City__c: "Phoenix", Mailing_State__c: "AZ", Mailing_Postal_Code__c: "85072" });
  const [home, sunrun] = fake.store.Sundial_Customer__c;
  const h = makeHandler(fake);
  const j = await call(h, "POST", "/service/jobs", {
    customer: { id: home.Id },
    job: { billToType: "Leasing Partner", billToCustomerId: sunrun.Id, billToName: "Typed By Hand", billingReference: "SR-77120" },
    lines: [{ description: "Truck roll", kind: "Labor", unitPrice: 275 }],
  });
  assert.equal(j.status, 201, JSON.stringify(j.body));
  const job = fake.store.Sundial_Service_Job__c[0];
  assert.equal(job.Bill_To_Type__c, "Leasing Partner");
  assert.equal(job.Bill_To_Customer__c, sunrun.Id);
  assert.equal(job.Bill_To_Name__c, "SunRun", "derived, not the typed name");
  assert.equal(job.Customer_Name_at_Creation__c, "Mark Haughn");
  assert.ok(j.body.rejectedFields.includes("billToName"), "the caller is told the field was not taken");

  const iss = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {});
  assert.equal(iss.status, 201, JSON.stringify(iss.body));
  const inv = fake.store.Sundial_Service_Invoice__c[0];
  assert.equal(inv.Bill_To_Customer__c, sunrun.Id);
  assert.equal(inv.Bill_To_Name__c, "SunRun");
  assert.equal(inv.Bill_To_Address__c, "Po Box 53940, Phoenix, AZ 85072", "the mailing address when the payer has no site address");
  const pv = await call(h, "GET", `/service/invoices/${inv.Id}/preview`);
  assert.ok(pv.body.html.includes("Attn: Dana Ruiz"));
  assert.ok(pv.body.html.includes("Ref SR-77120"));
  assert.ok(pv.body.html.includes('<span class="k">Service address</span><div>Mark Haughn</div>'));

  // The company renames itself: the issued invoice keeps what it was issued with; a void
  // never rewrites; the -2 reissue takes the payer as it is now.
  sunrun.Company_Name__c = "SunRun Inc.";
  const v = await call(h, "POST", `/service/invoices/${inv.Id}/void`, { reason: "Wrong payer name" });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(inv.Bill_To_Name__c, "SunRun", "a void never rewrites the snapshot");
  const again = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {});
  assert.equal(again.status, 201, JSON.stringify(again.body));
  const inv2 = fake.store.Sundial_Service_Invoice__c[1];
  assert.match(inv2.Name, /-2$/);
  assert.equal(inv2.Bill_To_Name__c, "SunRun Inc.");
});

test("D-081: a customer-pay job's invoice snapshots the homeowner as the payer; a pre-D-081 partner job still issues, with a warning", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Ivy Lane", First_Name__c: "Ivy", Last_Name__c: "Lane", Primary_Email__c: "ivy@example.com", Street__c: "5 Fir", City__c: "Mesa", State__c: "AZ", Postal_Code__c: "85201" });
  const h = makeHandler(fake);
  await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Labor", kind: "Labor", unitPrice: 100 }] });
  const job = fake.store.Sundial_Service_Job__c[0];
  assert.equal(job.Bill_To_Customer__c, undefined, "type Customer: no second record");
  await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {});
  const inv = fake.store.Sundial_Service_Invoice__c[0];
  assert.equal(inv.Bill_To_Customer__c, job.Sundial_Customer__c);
  assert.equal(inv.Bill_To_Name__c, "Ivy Lane");
  assert.equal(inv.Bill_To_Address__c, "5 Fir, Mesa, AZ 85201");

  // An HCP-imported partner job from before D-081: a name, no record.
  await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Labor", kind: "Labor", unitPrice: 100 }] });
  const legacy = fake.store.Sundial_Service_Job__c[1];
  Object.assign(legacy, { Bill_To_Type__c: "Leasing Partner", Bill_To_Name__c: "SunRun" });
  const iss = await call(h, "POST", `/service/jobs/${legacy.Id}/invoice`, {});
  assert.equal(iss.status, 201, JSON.stringify(iss.body));
  const inv2 = fake.store.Sundial_Service_Invoice__c.at(-1);
  assert.equal(inv2.Bill_To_Name__c, "SunRun");
  assert.equal(inv2.Bill_To_Customer__c, undefined);
  assert.ok(iss.body.warnings.some((w) => /names no paying customer record/.test(w)));
});

/** A job with a summary, one complete call and two photos on it, two photo sections saved — ready to send. */
async function seedReportJob(fake, h) {
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Ivy", Primary_Email__c: "ivy@example.com", Primary_Phone__c: "602-555-0101", Street__c: "5 Fir", City__c: "Mesa", State__c: "AZ", Postal_Code__c: "85201" });
  const j = await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c.at(-1).Id }, lines: [{ description: "Labor", kind: "Labor", unitPrice: 275 }] });
  assert.equal(j.status, 201, JSON.stringify(j.body));
  const job = fake.store.Sundial_Service_Job__c.at(-1);
  job.Customer_Summary__c = "Replaced the failed breaker.";
  if (!fake.store.Sundial_User__c.some((u) => u.Id === USER)) fake.store.Sundial_User__c.push({ Id: USER, Client__c: TENANT, First_Name__c: "Paige", Last_Name__c: "King" });
  await fake.deps.sfCreateRecord("Sundial_Service_Call__c", { Client__c: TENANT, Sundial_Service_Job__c: job.Id, Name: "SC-00001", Status__c: "Complete", Scheduled_Start__c: "2026-09-08T16:00:00Z", Tech__c: USER });
  const callId = fake.store.Sundial_Service_Call__c.at(-1).Id;
  fake.files = [
    { key: `SUNDIAL/${job.Id}/photos/${callId}/before.jpg`, publicUrl: "https://s3/before.jpg", size: 4194304, lastModified: "2026-09-08T17:00:00Z" },
    { key: `SUNDIAL/${job.Id}/photos/${callId}/after.jpg`, publicUrl: "https://s3/after.jpg", size: 4194304, lastModified: "2026-09-08T18:00:00Z" },
  ];
  const r = await call(h, "PUT", `/service/jobs/${job.Id}/report`, { sections: [{ id: "a", photoKey: fake.files[0].key, caption: "Before." }, { id: "b", photoKey: fake.files[1].key, caption: "After." }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return job;
}

test("the report PDF shrinks big photos and caches the shrunk copy (2026-10-12): the first send resizes + writes the cache, the second reads it; past the budget a small original is embedded, a huge one is left to the hosted page", async () => {
  const fake = fakeSalesforce();
  const BIG = new Uint8Array(4 * 1024 * 1024).fill(0xff); // "a 4 MB photo"
  BIG[0] = 0xff; BIG[1] = 0xd8; BIG[2] = 0xff;
  fake.photoBytes = BIG;
  const resizes = [];
  fake.resizeImage = (bytes) => (resizes.push(bytes.length), { bytes: JPG_1x1, contentType: "image/jpeg", width: 1, height: 1, resized: true });
  const h = makeHandler(fake);
  const job = await seedReportJob(fake, h);
  let r = await call(h, "POST", `/service/jobs/${job.Id}/report/send`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(resizes.length, 2, "both photos were shrunk");
  const cachePuts = fake.puts.filter((p) => p.key.startsWith(`SUNDIAL/_cache/report-images/${job.Id}/`));
  assert.equal(cachePuts.length, 2, "the shrunk copies were cached, outside the job's folder");
  assert.ok(cachePuts.every((p) => p.contentType === "image/jpeg" && p.key.endsWith("-1600.jpg")));
  assert.ok(fake.emails.at(-1).attachments.length === 1, "a small PDF is attached");
  // second send: served from the cache, nothing shrunk again, the originals not even read
  const getsBefore = fake.gets.length;
  r = await call(h, "POST", `/service/jobs/${job.Id}/report/send`, {});
  assert.equal(r.status, 200);
  assert.equal(resizes.length, 2);
  assert.equal(fake.gets.length, getsBefore, "the originals were not read again");
  // no resizer (or past the budget): a 3 MB original is embedded, a 4 MB one is left out — the send still succeeds
  const fake2 = fakeSalesforce();
  fake2.photoBytes = BIG;
  fake2.resizeImage = null;
  const h2 = makeHandler(fake2);
  const job2 = await seedReportJob(fake2, h2);
  r = await call(h2, "POST", `/service/jobs/${job2.Id}/report/send`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(fake2.puts.filter((p) => p.key.startsWith("SUNDIAL/_cache/")).length, 0);
  assert.ok(fake2.puts.some((p) => p.contentType === "application/pdf"), "the PDF was still made (placeholders for the photos)");
});

test("POST /report/prepare warms the photo cache in rounds (2026-10-12 evening): a slow shrink leaves photos pending, the next round finishes them, the send then reads only the cache", async () => {
  const fake = fakeSalesforce();
  const BIG = new Uint8Array(4 * 1024 * 1024).fill(0xff);
  BIG[0] = 0xff; BIG[1] = 0xd8; BIG[2] = 0xff;
  fake.photoBytes = BIG;
  // every shrink "takes" 22 s: with a 21 s budget each round fits one photo
  let clock = 0;
  const realNow = Date.now;
  Date.now = () => realNow() + clock;
  try {
    fake.resizeImage = () => {
      clock += 22000;
      return { bytes: JPG_1x1, contentType: "image/jpeg", width: 1, height: 1, resized: true };
    };
    const h = makeHandler(fake);
    const job = await seedReportJob(fake, h);
    clock = 0;
    let r = await call(h, "POST", `/service/jobs/${job.Id}/report/prepare`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.total, r.body.ready, r.body.pending, r.body.done], [2, 1, 1, false]);
    clock = 0;
    r = await call(h, "POST", `/service/jobs/${job.Id}/report/prepare`, {});
    assert.deepEqual([r.body.total, r.body.ready, r.body.pending, r.body.done, r.body.shrunk], [2, 2, 0, true, 1]);
    clock = 0;
    r = await call(h, "POST", `/service/jobs/${job.Id}/report/prepare`, {});
    assert.deepEqual([r.body.ready, r.body.shrunk], [2, 0], "a third round finds everything cached");
    const getsBefore = (fake.gets || []).length;
    r = await call(h, "POST", `/service/jobs/${job.Id}/report/send`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(fake.gets.length, getsBefore, "the send read nothing but the cache");
    assert.equal(fake.emails.at(-1).attachments.length, 1);
  } finally {
    Date.now = realNow;
  }
});


// ---------------------------------------------------------------------------
// D-083 — sales tax from the Acumatica zone tables
// ---------------------------------------------------------------------------
test("D-083: a job whose city is no zone is stamped blank and says 'Tax zone needed'; issue refuses TAX_ZONE_REQUIRED until the office picks one", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Rural", Primary_Email__c: "r@example.com", City__c: "Nowhere Junction" });
  const h = makeHandler(fake);
  const j = await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, estimate: { taxRate: 8.6 }, lines: [{ description: "Labor", kind: "Labor", unitPrice: 200 }, { description: "Breaker", kind: "Material", unitPrice: 100, taxable: true }] });
  assert.equal(j.status, 201, JSON.stringify(j.body));
  assert.equal(j.body.taxZone.needed, true);
  assert.ok(j.body.warnings.some((w) => /Tax zone needed/.test(w) && /NOWHERE JUNCTION/.test(w)));
  assert.ok(j.body.rejectedFields.includes("taxRate"), "a typed rate is no longer an input");
  const job = fake.store.Sundial_Service_Job__c[0];
  const est = fake.store.Sundial_Estimate__c[0];
  assert.equal(job.Tax_Zone_Code__c, undefined, "never a guess");
  assert.equal(job.Tax_Zone_Label__c, undefined);
  assert.equal(est.Tax_Rate__c, null);
  assert.equal(est.Tax_Amount__c, 0, "no zone, no tax — not the old default");

  const blocked = await call(h, "GET", `/service/jobs/${job.Id}/invoice`);
  assert.equal(blocked.body.issueBlocker.code, "TAX_ZONE_REQUIRED");
  const refused = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {});
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "TAX_ZONE_REQUIRED");
  assert.equal(fake.store.Sundial_Service_Invoice__c.length, 0);

  // The picker: retail zones only, today's rates; ?city= says what the resolver would do.
  const zones = await call(h, "GET", "/service/tax-zones", null, { city: "Sun City" });
  assert.equal(zones.status, 200);
  assert.ok(!zones.body.zones.some((z) => z.code === "08PHOENIXC"), "contracting zones are not offered");
  assert.deepEqual(zones.body.zones.find((z) => z.code === "08MARICOPR"), { code: "08MARICOPR", label: "Maricopa County", county: "Maricopa", cityKey: null, countyOnly: true, rate: 6.3 });
  assert.deepEqual(zones.body.resolved, { matched: true, code: "08MARICOPR", label: "Maricopa County", via: "alias" });

  const bogus = await call(h, "POST", `/service/jobs/${job.Id}/tax-zone`, { zoneCode: "08PHOENIXC" });
  assert.equal(bogus.status, 400);
  assert.equal(bogus.body.code, "TAX_ZONE_UNKNOWN", "a contracting zone is not a Service zone");
  const set = await call(h, "POST", `/service/jobs/${job.Id}/tax-zone`, { zoneCode: "08phoenixr", label: "ignored" });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(job.Tax_Zone_Code__c, "08PHOENIXR");
  assert.equal(job.Tax_Zone_Label__c, "Phoenix", "the label is derived, never typed");
  assert.equal(est.Tax_Rate__c, 9.1, "the estimate is re-taxed by the job's zone");
  assert.equal(est.Tax_Jurisdiction__c, "Phoenix");
  assert.equal(est.Tax_Amount__c, 9.1);
  assert.ok(fake.activity.some((a) => a.event === "job_updated" && a.details.via === "tax-zone"));

  const inv = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {});
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.invoice.Tax_Rate__c, 9.1);
  assert.equal(inv.body.invoice.Tax_Amount__c, 9.1);
  assert.equal(inv.body.invoice.Total__c, 309.1);
  const doc = await call(h, "GET", `/service/invoices/${inv.body.id}/preview`);
  assert.ok(doc.body.html.includes("Phoenix (9.1%)"), "the jurisdiction and rate print under Total tax");
});

test("D-083: a mixed estimate — a Phoenix job taxes only Retail lines; every material defaults to RETAIL; the price-book item's SOLAR default rides onto the line; taxable is read-only and derived; a bad category is refused", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Mix", Primary_Email__c: "m@example.com", City__c: "laveen" }); // the CFO's alias → Phoenix
  await fake.deps.sfCreateRecord("Sundial_Price_Book_Item__c", { Client__c: TENANT, Name: "Optimizer", Item_Code__c: "OPT-1", Version__c: 1, Is_Active__c: true, Kind__c: "Material", Material_Price__c: 1000, Taxable__c: true, Tax_Category__c: "SOLAR" });
  const item = fake.store.Sundial_Price_Book_Item__c[0];
  const h = makeHandler(fake);
  const j = await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [
    { description: "Diagnostic", kind: "Labor", unitPrice: 300 },
    { description: "Breaker", kind: "Material", unitPrice: 200, taxable: false }, // the old checkbox is ignored: a material is RETAIL
    { priceBookItemId: item.Id },
    { description: "Disposal", kind: "Fee", unitPrice: 50 },
  ] });
  assert.equal(j.status, 201, JSON.stringify(j.body));
  assert.deepEqual(j.body.taxZone, { matched: true, zoneCode: "08PHOENIXR", label: "Phoenix", needed: false, reason: null });
  const est = fake.store.Sundial_Estimate__c[0];
  const lines = fake.store.Sundial_Service_Line__c;
  const opt = lines.find((l) => l.Price_Book_Item__c === item.Id);
  assert.equal(opt.Tax_Category__c, "SOLAR", "the item's default is snapshotted");
  assert.equal(opt.Taxable__c, false, "Taxable__c follows the category, not the item's old checkbox");
  // 1550 subtotal; only the 200 breaker is Retail: 200 × 9.1% = 18.20
  assert.equal(est.Subtotal__c, 1550);
  assert.equal(est.Tax_Amount__c, 18.2);
  assert.equal(est.Tax_Rate__c, 9.1);
  assert.equal(est.Tax_Jurisdiction__c, "Phoenix");

  const breaker = lines.find((l) => l.Description__c === "Breaker");
  assert.equal(breaker.Tax_Category__c, undefined, "a default is not stored — blank means the kind's default");
  assert.equal(breaker.Taxable__c, true, "derived: a material is RETAIL, so ticked");
  assert.equal(lines.find((l) => l.Description__c === "Diagnostic").Taxable__c, false);

  // The office marks the disposal fee Retail explicitly; clearing the choice sends it back to LABSERV.
  const fee = lines.find((l) => l.Description__c === "Disposal");
  const p1 = await call(h, "PATCH", `/service/estimates/${est.Id}/lines/${fee.Id}`, { taxCategory: "RETAIL" });
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal(fee.Taxable__c, true);
  assert.equal(p1.body.totals.Tax_Amount__c, 22.75, "250 × 9.1%");
  const p2 = await call(h, "PATCH", `/service/estimates/${est.Id}/lines/${fee.Id}`, { taxCategory: null });
  assert.equal(fee.Tax_Category__c, null);
  assert.equal(fee.Taxable__c, false);
  assert.equal(p2.body.totals.Tax_Amount__c, 18.2);
  // No "untick to exempt": the taxable key is read-only. Exempting the breaker = choosing SOLAR.
  const untick = await call(h, "PATCH", `/service/estimates/${est.Id}/lines/${breaker.Id}`, { taxable: false });
  assert.equal(untick.status, 400, "taxable alone is nothing to update");
  assert.deepEqual(untick.body.rejectedFields, ["taxable"]);
  assert.equal(breaker.Tax_Category__c, undefined);
  const exempt = await call(h, "PATCH", `/service/estimates/${est.Id}/lines/${breaker.Id}`, { taxCategory: "SOLAR" });
  assert.equal(breaker.Taxable__c, false);
  assert.equal(exempt.body.totals.Tax_Amount__c, 0);
  await call(h, "PATCH", `/service/estimates/${est.Id}/lines/${breaker.Id}`, { taxCategory: null });
  const bad = await call(h, "PATCH", `/service/estimates/${est.Id}/lines/${fee.Id}`, { taxCategory: "CONTRACTING" });
  assert.equal(bad.status, 400);

  // The estimate read carries the zone; the preview prints it.
  const g = await call(h, "GET", `/service/estimates/${est.Id}`);
  assert.equal(g.body.taxZone.label, "Phoenix");
  assert.equal(g.body.totals.taxByCategory.RETAIL.base, 200);
  const pv = await call(h, "GET", `/service/estimates/${est.Id}/preview`);
  assert.ok(pv.body.html.includes("Phoenix (9.1%)"));
});

test("D-083: an estimate with no job is taxed by the customer's city; Create Job stamps the zone; a template is never taxed", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Pre", Primary_Email__c: "p@example.com", City__c: "Tempe" });
  const h = makeHandler(fake);
  const c = await call(h, "POST", "/service/estimates", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Part", kind: "Material", unitPrice: 100, taxable: true }] });
  assert.equal(c.status, 201);
  const est = fake.store.Sundial_Estimate__c[0];
  assert.equal(est.Tax_Rate__c, 8.1);
  assert.equal(est.Tax_Jurisdiction__c, "Tempe");
  assert.equal(est.Tax_Amount__c, 8.1);
  const cj = await call(h, "POST", `/service/estimates/${est.Id}/create-job`, {});
  assert.equal(cj.status, 201, JSON.stringify(cj.body));
  assert.equal(fake.store.Sundial_Service_Job__c[0].Tax_Zone_Code__c, "08TEMPER");
  assert.equal(cj.body.taxZone.zoneCode, "08TEMPER");
  const t = await call(h, "POST", "/service/estimates", { isTemplate: true, lines: [{ description: "Part", kind: "Material", unitPrice: 100, taxable: true }] });
  const tpl = fake.store.Sundial_Estimate__c.find((e) => e.Id === t.body.id);
  assert.equal(tpl.Tax_Amount__c, 0);
  assert.equal(tpl.Tax_Rate__c, undefined, "a template's tax fields are never written");
});

test("D-083: no tax tables for the tenant (another tenant, a failed read) — nothing is guessed: no zone, no tax, issue refused", async () => {
  const fake = fakeSalesforce();
  fake.taxTables = null;
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Ivy", Primary_Email__c: "ivy@example.com", City__c: "Phoenix" });
  const h = makeHandler(fake);
  const j = await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Part", kind: "Material", unitPrice: 100, taxable: true }] });
  assert.equal(j.status, 201);
  assert.equal(j.body.taxZone.reason, "NO_TABLE");
  assert.equal(fake.store.Sundial_Estimate__c[0].Tax_Amount__c, 0);
  const zones = await call(h, "GET", "/service/tax-zones");
  assert.equal(zones.body.configured, false);
  assert.equal((await call(h, "POST", `/service/jobs/${fake.store.Sundial_Service_Job__c[0].Id}/invoice`, {})).body.code, "TAX_ZONE_REQUIRED");
});

test("D-083: issue freezes each line's EFFECTIVE category (after the warranty rule) onto the line — a later Bill To change never re-taxes the issued invoice; a void restores the lines so the reissue follows the job", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Wren", Primary_Email__c: "w@example.com", City__c: "Mesa" });
  const h = makeHandler(fake);
  const j = await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Labor", kind: "Labor", unitPrice: 200 }, { description: "Inverter part", kind: "Material", unitPrice: 100 }] });
  assert.equal(j.status, 201, JSON.stringify(j.body));
  const job = fake.store.Sundial_Service_Job__c[0];
  const est = fake.store.Sundial_Estimate__c[0];
  const part = fake.store.Sundial_Service_Line__c.find((l) => l.Description__c === "Inverter part");
  const labor = fake.store.Sundial_Service_Line__c.find((l) => l.Description__c === "Labor");
  assert.equal(est.Tax_Amount__c, 8.6, "a customer-pay job: the part is RETAIL at Mesa's 8.6%");

  // The job turns out to be manufacturer warranty work before it is billed (as the job page's PATCH would leave it).
  job.Bill_To_Type__c = "Manufacturer";
  const issued = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {});
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const inv = fake.store.Sundial_Service_Invoice__c[0];
  assert.equal(inv.Tax_Amount__c, 0, "warranty work: every line WARRANTY");
  assert.equal(inv.Total__c, 300);
  assert.equal(part.Tax_Category__c, "WARRANTY", "the EFFECTIVE category is written onto the frozen line");
  assert.equal(part.Taxable__c, false);
  assert.equal(labor.Tax_Category__c, "WARRANTY");
  const issuedRow = fake.activity.find((a) => a.event === "invoice_issued");
  assert.deepEqual(issuedRow.details.frozenCategories.map((f) => [f.lineId, f.from, f.to]), [[labor.Id, null, "WARRANTY"], [part.Id, null, "WARRANTY"]]);

  // Someone corrects the Bill To afterwards: the issued invoice is NOT re-taxed, anywhere.
  job.Bill_To_Type__c = "Customer";
  const read = await call(h, "GET", `/service/estimates/${est.Id}`);
  assert.equal(read.body.totals.taxAmount, 0, "the invoiced estimate reads its frozen categories");
  assert.deepEqual(read.body.totals.lineTotals.map((l) => l.taxCategory), ["WARRANTY", "WARRANTY"]);
  const doc = await call(h, "GET", `/service/invoices/${inv.Id}/preview`);
  assert.equal(doc.body.total, 300);
  await call(h, "POST", `/service/estimates/${est.Id}/recalculate`, {});
  assert.equal(est.Tax_Amount__c, 0, "a recalculate on the invoiced estimate writes nothing");
  assert.equal(inv.Tax_Amount__c, 0);

  // The other way round: a customer-pay invoice stays taxed when the job later becomes warranty.
  const fake2 = fakeSalesforce();
  await fake2.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Ott", Primary_Email__c: "o@example.com", City__c: "Mesa" });
  const h2 = makeHandler(fake2);
  await call(h2, "POST", "/service/jobs", { customer: { id: fake2.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Part", kind: "Material", unitPrice: 100 }] });
  const job2 = fake2.store.Sundial_Service_Job__c[0];
  assert.equal((await call(h2, "POST", `/service/jobs/${job2.Id}/invoice`, {})).status, 201);
  assert.equal(fake2.store.Sundial_Service_Line__c[0].Tax_Category__c, "RETAIL", "the default, now frozen explicitly");
  job2.Bill_To_Type__c = "Internal Warranty";
  const read2 = await call(h2, "GET", `/service/estimates/${fake2.store.Sundial_Estimate__c[0].Id}`);
  assert.equal(read2.body.totals.taxAmount, 8.6, "still taxed — the Bill To change does not reach an issued invoice");

  // Void the warranty invoice: the lines get back what they held, and the reissue follows the corrected Bill To.
  const v = await call(h, "POST", `/service/invoices/${inv.Id}/void`, { reason: "Billed to the wrong payer" });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.categoriesRestored, 2);
  assert.deepEqual(v.body.warnings, []);
  assert.equal(part.Tax_Category__c, null, "back to blank = the kind's default");
  assert.equal(part.Taxable__c, true, "a material's default is RETAIL");
  const re = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {});
  assert.equal(re.status, 201, JSON.stringify(re.body));
  assert.equal(fake.store.Sundial_Service_Invoice__c[1].Tax_Amount__c, 8.6, "customer-pay now: the part is taxed");
});

test("2026-10-16: an estimate invoiced BEFORE D-083 reads at what it was invoiced at — the blank material is not re-taxed as RETAIL on the estimate read or the invoice document", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Pre", Primary_Email__c: "p@example.com", City__c: "Mesa" });
  const h = makeHandler(fake);
  await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Panel clip", kind: "Material", unitPrice: 100 }] });
  const job = fake.store.Sundial_Service_Job__c[0];
  assert.equal((await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {})).status, 201);
  const est = fake.store.Sundial_Estimate__c[0];
  const inv = fake.store.Sundial_Service_Invoice__c[0];
  const line = fake.store.Sundial_Service_Line__c[0];
  // Rewind to how a pre-D-083 invoice sits in the org: the line untaxed with no category, no tax frozen anywhere.
  Object.assign(line, { Tax_Category__c: null, Taxable__c: false });
  Object.assign(est, { Tax_Amount__c: 0, Total__c: 100 });
  Object.assign(inv, { Tax_Amount__c: 0, Total__c: 100 });

  const read = await call(h, "GET", `/service/estimates/${est.Id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.totals.taxAmount, 0, "the stored snapshot, not a RETAIL recomputation (8.60)");
  assert.equal(read.body.totals.total, 100);
  const doc = await call(h, "GET", `/service/invoices/${inv.Id}/preview`);
  assert.equal(doc.body.total, 100);
  await call(h, "POST", `/service/estimates/${est.Id}/recalculate`, {});
  assert.equal(est.Tax_Amount__c, 0, "an invoiced estimate is never rewritten");
});

test("2026-10-16: a Sent / Viewed / Approved estimate shows its STORED totals — read, preview, send, approve and recalculate never re-price it; a line edit recomputes and re-stores; a Draft stays live", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Shown", Primary_Email__c: "s@example.com", City__c: "Mesa" });
  const h = makeHandler(fake);
  await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Disconnect", kind: "Material", unitPrice: 100 }] });
  const est = fake.store.Sundial_Estimate__c[0];
  const line = fake.store.Sundial_Service_Line__c[0];
  // As a pre-D-083 approved estimate sits in the org: a ticked material, no typed rate, so no tax was ever stored.
  Object.assign(line, { Tax_Category__c: null, Taxable__c: true });
  Object.assign(est, { Status__c: "Approved", Subtotal__c: 100, Material_Subtotal__c: 100, Tax_Amount__c: 0, Total__c: 100, Tax_Rate__c: null, Tax_Jurisdiction__c: null });

  const read = await call(h, "GET", `/service/estimates/${est.Id}`);
  assert.equal(read.body.totals.taxAmount, 0, "stored, not Mesa's 8.6% RETAIL");
  assert.equal(read.body.totals.total, 100);
  assert.equal((await call(h, "POST", `/service/estimates/${est.Id}/recalculate`, {})).body.totals.Total__c, 100);
  assert.equal(est.Total__c, 100, "recalculate does not re-price a shown estimate");
  assert.equal((await call(h, "POST", `/service/estimates/${est.Id}/send`, {})).status, 200);
  assert.equal(est.Status__c, "Sent");
  assert.equal(est.Tax_Amount__c, 0, "a re-send keeps what the customer was shown");
  assert.equal(est.Tax_Rate__c, null, "…and its printed rate");
  est.Status__c = "Viewed";
  assert.equal((await call(h, "GET", `/service/estimates/${est.Id}`)).body.totals.total, 100);
  const a = await call(h, "POST", `/service/estimates/${est.Id}/approve`, { method: "Verbal" });
  assert.equal(a.status, 200);
  assert.equal(a.body.approvedAmount, 100, "approved at the shown total");
  assert.equal(est.Total__c, 100);

  // The office edits a line: now it recomputes with the zone, and stores it.
  const e = await call(h, "PATCH", `/service/estimates/${est.Id}/lines/${line.Id}`, { quantity: 2 });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(est.Tax_Amount__c, 17.2);
  assert.equal(est.Total__c, 217.2);
  assert.equal((await call(h, "GET", `/service/estimates/${est.Id}`)).body.totals.total, 217.2, "and the read follows the new stored totals");

  // A Draft computes live, whatever is stored.
  Object.assign(est, { Status__c: "Draft", Tax_Amount__c: 0, Total__c: 200 });
  assert.equal((await call(h, "GET", `/service/estimates/${est.Id}`)).body.totals.taxAmount, 17.2);
});

// ---------------------------------------------------------------------------
// 2026-10-16 (Harmon's October batch): cost is Admin / Executive (lib/cost-gate.js), the
// estimate has its own Bill To (D-081 amendment 2), the send box (D-072 amendment 12), the
// Lead Source on a new service customer.
// ---------------------------------------------------------------------------
const MANAGER = { user: { id: "USR000000000000004", firstName: "Mo", lastName: "Manager" }, access: { level: "Manager", scope: "tenant", userId: "USR000000000000004", tenantId: TENANT } };

test("2026-10-16 cost: a Manager's BLANK cost key is not sent (200, cost unchanged), a value is 403 COSTING_FORBIDDEN; an Admin sets it; the estimate read hides line cost from a Manager, sell prices stay", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Cy", Primary_Email__c: "cy@example.com", City__c: "Mesa" });
  await fake.deps.sfCreateRecord("Sundial_Price_Book_Item__c", { Client__c: TENANT, Name: "Disconnect", Item_Code__c: "MAT-DISC", Version__c: 1, Is_Active__c: true, Kind__c: "Material", Material_Price__c: 120, Material_Cost__c: 60, Labor_Cost__c: 5 });
  const item = fake.store.Sundial_Price_Book_Item__c[0];
  const admin = makeHandler(fake);
  const manager = makeHandler(fake, MANAGER);

  // Today's portal sends both cost fields on every save, blank when it never saw them.
  let r = await call(manager, "PATCH", `/service/price-book-items/${item.Id}`, { name: "Disconnect 60A", laborCost: "", materialCost: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(item.Name, "Disconnect 60A");
  assert.equal(item.Labor_Cost__c, 5, "the stored cost is untouched");
  assert.equal(item.Material_Cost__c, 60);
  assert.ok(!fake.calls.updates.some((u) => "Labor_Cost__c" in u.fields || "Material_Cost__c" in u.fields), "no cost field was written");
  // A value from a Manager is refused out loud, never silently ignored.
  r = await call(manager, "PATCH", `/service/price-book-items/${item.Id}`, { laborCost: 12 });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "COSTING_FORBIDDEN");
  assert.deepEqual(r.body.fields, ["laborCost"]);
  assert.equal(item.Labor_Cost__c, 5);
  r = await call(manager, "POST", "/service/price-book-items", { name: "Fuse", itemCode: "MAT-FUSE", kind: "Material", materialPrice: 9, materialCost: 3 });
  assert.equal(r.status, 403);
  r = await call(manager, "POST", "/service/price-book-items", { name: "Fuse", itemCode: "MAT-FUSE", kind: "Material", materialPrice: 9, materialCost: "", laborCost: null });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(fake.store.Sundial_Price_Book_Item__c.find((i) => i.Id === r.body.id).Material_Cost__c, undefined);
  // An Admin sets cost.
  r = await call(admin, "PATCH", `/service/price-book-items/${item.Id}`, { laborCost: 12 });
  assert.equal(r.status, 200);
  assert.equal(item.Labor_Cost__c, 12);
  // A Manager's new version with blank cost keys carries the old version's cost forward.
  r = await call(manager, "POST", `/service/price-book-items/${item.Id}/new-version`, { materialPrice: 130, laborCost: "", materialCost: "" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v2 = fake.store.Sundial_Price_Book_Item__c.find((i) => i.Id === r.body.id);
  assert.equal(v2.Material_Price__c, 130);
  assert.equal(v2.Material_Cost__c, 60);
  assert.equal(v2.Labor_Cost__c, 12);

  // The estimate read: line cost for an Admin, none for a Manager; the sell price for both.
  const e = await call(admin, "POST", "/service/estimates", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ priceBookItemId: v2.Id, quantity: 1 }] });
  assert.equal(e.status, 201);
  const asAdmin = await call(admin, "GET", `/service/estimates/${e.body.id}`);
  assert.equal(asAdmin.body.lines[0].Unit_Material_Cost__c, 60);
  const asManager = await call(manager, "GET", `/service/estimates/${e.body.id}`);
  assert.equal(asManager.status, 200);
  assert.ok(!("Unit_Material_Cost__c" in asManager.body.lines[0]));
  assert.ok(!("Unit_Labor_Cost__c" in asManager.body.lines[0]));
  assert.equal(asManager.body.lines[0].Unit_Price__c, 130);
  assert.equal(fake.store.Sundial_Service_Line__c[0].Unit_Material_Cost__c, 60, "the line still snapshots the item's cost on add");
});

test("D-081 amendment 2: the estimate's Bill To — required payer, derived name, read + send defaults, the document's block; Create Job inherits it, quick-create shares it, then they are independent", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Mark Haughn", First_Name__c: "Mark", Last_Name__c: "Haughn", Primary_Email__c: "mark@example.com", Primary_Phone__c: "623-555-0142", Street__c: "25825 N 134th Drive", City__c: "Mesa", State__c: "AZ", Postal_Code__c: "85201" });
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "ZZ Bill-To Co", Is_Company__c: true, Company_Name__c: "ZZ Bill-To Co", First_Name__c: "Dana", Last_Name__c: "Ruiz", Primary_Email__c: "ap@billto.example.com", Primary_Phone__c: "(602) 555-0100", Street__c: "Po Box 53940", City__c: "Phoenix", State__c: "AZ", Postal_Code__c: "85072" });
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: "a1Q000000OTHERTEN", Name: "Elsewhere", Is_Company__c: true, Company_Name__c: "Elsewhere" });
  const [home, co, foreign] = fake.store.Sundial_Customer__c;
  const h = makeHandler(fake);

  // A partner type with no paying customer: refused before anything is created.
  let r = await call(h, "POST", "/service/estimates", { customer: { id: home.Id }, estimate: { billToType: "Leasing Partner" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "BILL_TO_CUSTOMER_REQUIRED");
  assert.equal(fake.store.Sundial_Estimate__c.length, 0);
  r = await call(h, "POST", "/service/estimates", { customer: { id: home.Id }, estimate: { billToType: "Leasing Partner", billToCustomerId: foreign.Id } });
  assert.equal(r.status, 400, "another tenant's customer is not found");
  // The payer named: the name is DERIVED; a typed billToName is ignored.
  r = await call(h, "POST", "/service/estimates", { customer: { id: home.Id }, estimate: { billToType: "Leasing Partner", billToCustomerId: co.Id, billToName: "Somebody Else" }, lines: [{ description: "Truck roll", kind: "Labor", unitPrice: 275 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const est = fake.store.Sundial_Estimate__c.find((x) => x.Id === r.body.id);
  assert.equal(est.Bill_To_Type__c, "Leasing Partner");
  assert.equal(est.Bill_To_Customer__c, co.Id);
  assert.equal(est.Bill_To_Name__c, "ZZ Bill-To Co");

  // The read: who pays, and the send box's prefill — the payer's address, said to be theirs.
  const g = await call(h, "GET", `/service/estimates/${est.Id}`);
  assert.deepEqual(g.body.billTo, { type: "Leasing Partner", customerId: co.Id, name: "ZZ Bill-To Co" });
  assert.deepEqual(g.body.sendDefaults, { email: "ap@billto.example.com", phone: "+16025550100", source: "billTo", name: "ZZ Bill-To Co" });
  // The document: the payer top-left with Attn and its address, the homeowner under Service address.
  const p = await call(h, "GET", `/service/estimates/${est.Id}/preview`);
  assert.ok(p.body.html.includes("Attn: Dana Ruiz"));
  assert.ok(p.body.html.includes("Po Box 53940"));
  assert.ok(p.body.html.includes("Service address"));
  // Send with an empty box goes to the payer.
  const s = await call(h, "POST", `/service/estimates/${est.Id}/send`, {});
  assert.equal(s.status, 200);
  assert.equal(s.body.recipient, "ap@billto.example.com");
  assert.equal(fake.emails.at(-1).to, "ap@billto.example.com");

  // PATCH: billToName is rejected (derived); a partner type with the payer cleared is refused.
  r = await call(h, "PATCH", `/service/estimates/${est.Id}`, { billToName: "X", scopeSummary: "Panel swap" });
  assert.equal(r.status, 200);
  assert.ok(r.body.rejectedFields.includes("billToName"));
  assert.equal(est.Bill_To_Name__c, "ZZ Bill-To Co");
  r = await call(h, "PATCH", `/service/estimates/${est.Id}`, { billToCustomerId: null });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "BILL_TO_CUSTOMER_REQUIRED");

  // Create Job copies the estimate's Bill To onto the job (unless the request names one).
  const cj = await call(h, "POST", `/service/estimates/${est.Id}/create-job`, {});
  assert.equal(cj.status, 201, JSON.stringify(cj.body));
  const job = fake.store.Sundial_Service_Job__c.find((j) => j.Id === cj.body.jobId);
  assert.equal(job.Bill_To_Type__c, "Leasing Partner");
  assert.equal(job.Bill_To_Customer__c, co.Id);
  assert.equal(job.Bill_To_Name__c, "ZZ Bill-To Co");
  // After creation they are independent: the estimate going back to the homeowner leaves the job alone.
  r = await call(h, "PATCH", `/service/estimates/${est.Id}`, { billToType: "Customer" });
  assert.equal(r.status, 200);
  assert.equal(est.Bill_To_Customer__c, null);
  assert.equal(est.Bill_To_Name__c, null);
  assert.equal(job.Bill_To_Customer__c, co.Id);
  // The invoice card reads the job's payer (what the invoice will snapshot).
  const inv = await call(h, "GET", `/service/jobs/${job.Id}/invoice`);
  assert.deepEqual(inv.body.sendDefaults, { email: "ap@billto.example.com", phone: "+16025550100", source: "billTo", name: "ZZ Bill-To Co" });

  // Quick-create: the estimate and the job are born with the same payer.
  const q = await call(h, "POST", "/service/jobs", { customer: { id: home.Id }, job: { billToType: "Manufacturer", billToCustomerId: co.Id }, lines: [{ description: "Truck roll", kind: "Labor", unitPrice: 275 }] });
  assert.equal(q.status, 201, JSON.stringify(q.body));
  const qe = fake.store.Sundial_Estimate__c.find((x) => x.Id === q.body.estimateId);
  assert.equal(qe.Bill_To_Type__c, "Manufacturer");
  assert.equal(qe.Bill_To_Customer__c, co.Id);
  assert.equal(qe.Bill_To_Name__c, "ZZ Bill-To Co");
  // A homeowner estimate reads type Customer and the customer's own address.
  const plain = await call(h, "POST", "/service/estimates", { customer: { id: home.Id } });
  const pg = await call(h, "GET", `/service/estimates/${plain.body.id}`);
  assert.deepEqual(pg.body.billTo, { type: "Customer", customerId: null, name: null });
  assert.deepEqual(pg.body.sendDefaults, { email: "mark@example.com", phone: "+16235550142", source: "customer", name: "Mark Haughn" });
});

test("D-072 amendment 12: invoice send — the box, else the frozen payer, else the customer; Email / SMS / Both; the partner-email detail is gone", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Ivy", Primary_Email__c: "ivy@example.com", Street__c: "5 Fir", City__c: "Mesa", State__c: "AZ", Postal_Code__c: "85201" });
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "ZZ Bill-To Co", Is_Company__c: true, Company_Name__c: "ZZ Bill-To Co", Primary_Email__c: "ap@billto.example.com", Primary_Phone__c: "602-555-0100" });
  const [ivy, co] = fake.store.Sundial_Customer__c;
  const texts = [];
  fake.sms = { sendText: async (args) => (texts.push(args), { ok: true, code: null, error: null, to: args.to, message: { id: "m1" } }) };
  const h = makeHandler(fake);
  const j = await call(h, "POST", "/service/jobs", { customer: { id: ivy.Id }, job: { billToType: "Leasing Partner", billToCustomerId: co.Id }, lines: [{ description: "Labor", kind: "Labor", unitPrice: 275 }] });
  assert.equal(j.status, 201, JSON.stringify(j.body));
  const iss = await call(h, "POST", `/service/jobs/${j.body.jobId}/invoice`, {});
  assert.equal(iss.status, 201, JSON.stringify(iss.body));
  const inv = fake.store.Sundial_Service_Invoice__c[0];
  const read = await call(h, "GET", `/service/invoices/${inv.Id}`);
  assert.deepEqual(read.body.sendDefaults, { email: "ap@billto.example.com", phone: "+16025550100", source: "billTo", name: "ZZ Bill-To Co" });

  // An empty box sends to the payer — no "enter the partner's email" any more.
  let s = await call(h, "POST", `/service/invoices/${inv.Id}/send`, {});
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.delivery, "email");
  assert.equal(s.body.recipient, "ap@billto.example.com");
  assert.equal(inv.Status__c, "Sent");
  // Both: the email to the typed address, the text to the payer's phone, into the job's conversation.
  s = await call(h, "POST", `/service/invoices/${inv.Id}/send`, { via: "Both", to: "billing@billto.example.com" });
  assert.equal(s.body.delivery, "both");
  assert.deepEqual(s.body.recipients, { email: "billing@billto.example.com", phone: "+16025550100" });
  assert.equal(texts.at(-1).job.Id, j.body.jobId);
  assert.ok(texts.at(-1).body.includes(inv.Name));
  assert.ok(texts.at(-1).body.includes("PDF comes by email"), "a partner has no pay page");
  const sentRow = fake.activity.filter((a) => a.event === "invoice_sent").at(-1);
  assert.equal(sentRow.details.via, "Both");
  // SMS to nobody: refused before anything is rendered.
  co.Primary_Phone__c = null;
  const puts = fake.puts.length;
  s = await call(h, "POST", `/service/invoices/${inv.Id}/send`, { via: "SMS" });
  assert.equal(s.status, 400);
  assert.equal(s.body.code, "RECIPIENT_REQUIRED");
  assert.deepEqual(s.body.missing, ["phone"]);
  assert.equal(fake.puts.length, puts, "no PDF was rendered for a refused send");
});

test("2026-10-16 Lead Source on a new service customer: matched case-insensitively, written in the org's spelling; an unknown value is 400 LEAD_SOURCE_INVALID and nothing is created", async () => {
  const fake = fakeSalesforce();
  const h = makeHandler(fake);
  let r = await call(h, "POST", "/service/customers", { customer: { new: { firstName: "Lu", lastName: "Source", email: "lu@example.com", leadSource: "Billboard" } } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "LEAD_SOURCE_INVALID");
  assert.ok(!/Referral|Harmon Direct/.test(r.body.message), "the list is not echoed");
  assert.equal(fake.store.Sundial_Customer__c.length, 0);
  r = await call(h, "POST", "/service/customers", { customer: { new: { firstName: "Lu", lastName: "Source", email: "lu@example.com", leadSource: "  harmon DIRECT " } } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(fake.store.Sundial_Customer__c[0].Lead_Source__c, "Harmon Direct");
  // The same on New Job's new-customer branch.
  r = await call(h, "POST", "/service/jobs", { customer: { new: { firstName: "Jo", lastName: "Bee", phone: "602-555-0177", leadSource: "referral" } }, lines: [] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(fake.store.Sundial_Customer__c.find((c) => c.First_Name__c === "Jo").Lead_Source__c, "Referral");
  r = await call(h, "POST", "/service/jobs", { customer: { new: { firstName: "No", lastName: "Way", phone: "602-555-0178", leadSource: "Carrier pigeon" } } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "LEAD_SOURCE_INVALID");
  assert.equal(fake.store.Sundial_Service_Job__c.length, 1);
});

test("2026-10-16 markup is a margin number: a Manager never sees it (record, totals, totals.fields, add-line / patch responses) and cannot set it — blank is ignored, a value is 403; an Admin sees and sets it; the markup is still applied", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Cy", Primary_Email__c: "cy@example.com", City__c: "Mesa" });
  const admin = makeHandler(fake);
  const manager = makeHandler(fake, MANAGER);
  const hasMarkup = (o) => JSON.stringify(o).match(/markup/i) !== null;

  const c = await call(admin, "POST", "/service/estimates", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, estimate: { markupType: "Percent", markupValue: 10 }, lines: [{ description: "Truck roll", kind: "Labor", unitPrice: 200 }] });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const est = fake.store.Sundial_Estimate__c[0];
  assert.equal(est.Markup_Value__c, 10);

  // The Admin read carries the markup; the Manager's carries none of it, anywhere — same money.
  const a = await call(admin, "GET", `/service/estimates/${est.Id}`);
  assert.equal(a.body.estimate.Markup_Type__c, "Percent");
  assert.equal(a.body.estimate.Markup_Value__c, 10);
  assert.equal(a.body.totals.markupAmount, 20);
  const m = await call(manager, "GET", `/service/estimates/${est.Id}`);
  assert.equal(m.status, 200);
  assert.ok(!hasMarkup(m.body), "no markup key anywhere in the Manager's read");
  assert.equal(m.body.totals.total, a.body.totals.total, "the markup is still applied");
  assert.equal(m.body.totals.subtotal, a.body.totals.subtotal);
  assert.equal(m.body.lines[0].Unit_Price__c, 200);
  // Add-line and recalculate responses (totals.fields) too.
  const l = await call(manager, "POST", `/service/estimates/${est.Id}/lines`, { description: "Fuse", kind: "Material", unitPrice: 10 });
  assert.equal(l.status, 201);
  assert.ok(!hasMarkup(l.body));
  assert.ok(l.body.totals.Total__c > 0);
  assert.ok(!hasMarkup((await call(manager, "POST", `/service/estimates/${est.Id}/recalculate`)).body));

  // Writes: a value is refused, blank is not sent.
  let r = await call(manager, "PATCH", `/service/estimates/${est.Id}`, { markupValue: 10 });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "COSTING_FORBIDDEN");
  assert.deepEqual(r.body.fields, ["markupValue"]);
  r = await call(manager, "PATCH", `/service/estimates/${est.Id}`, { markupType: "Fixed", markupValue: 0 });
  assert.equal(r.status, 403, "0 is a value, not blank");
  r = await call(manager, "PATCH", `/service/estimates/${est.Id}`, { markupValue: "" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.unchanged, true);
  r = await call(manager, "PATCH", `/service/estimates/${est.Id}`, { markupType: null, markupValue: "", scopeSummary: "Swap the breaker" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(est.Scope_Summary__c, "Swap the breaker");
  assert.equal(est.Markup_Type__c, "Percent", "the stored markup is untouched");
  assert.equal(est.Markup_Value__c, 10);
  assert.ok(!hasMarkup(r.body));
  // A Manager's New Estimate with a markup value is refused before anything is created.
  const before = fake.store.Sundial_Estimate__c.length;
  r = await call(manager, "POST", "/service/estimates", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, estimate: { markupValue: 5 } });
  assert.equal(r.status, 403);
  assert.equal(fake.store.Sundial_Estimate__c.length, before);

  // An Admin sets it.
  r = await call(admin, "PATCH", `/service/estimates/${est.Id}`, { markupValue: 15 });
  assert.equal(r.status, 200);
  assert.equal(est.Markup_Value__c, 15);
  assert.ok(hasMarkup(r.body), "an Admin's response keeps Markup_Amount__c");
});

test("GET /service/estimates/{id}/pdf (2026-10-22): the PDF as it stands — DRAFT watermark, base64 JSON, no version / file / status change; PREVIEW once sent; 403 without the action", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Pd", Primary_Email__c: "pd@example.com" });
  // The real painter, with the model it is handed kept for the watermark check (PDF text is encoded).
  const { renderEstimatePdf } = await import("../../lib/estimate-pdf.js");
  const painted = [];
  fake.deps.renderPdf = async (m) => (painted.push(m), renderEstimatePdf(m));
  const h = makeHandler(fake);
  const c = await call(h, "POST", "/service/estimates", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Truck roll", kind: "Labor", unitPrice: 275 }] });
  const est = fake.store.Sundial_Estimate__c[0];
  const versionBefore = est.Version__c;
  const putsBefore = fake.puts.length;
  const updatesBefore = fake.calls.updates.filter((u) => u.obj === "Sundial_Estimate__c").length;
  const r = await call(h, "GET", `/service/estimates/${c.body.id}/pdf`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.contentType, "application/pdf");
  assert.equal(r.body.watermark, "DRAFT");
  assert.equal(r.body.fileName, `${String(est.Name || "estimate").replace(/[^A-Za-z0-9._-]+/g, "-")}-draft.pdf`);
  const bytes = Buffer.from(r.body.base64, "base64");
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.equal(painted.at(-1).watermark, "DRAFT", "the painter draws the DRAFT watermark");
  assert.equal(est.Version__c, versionBefore, "version unchanged");
  assert.equal(est.Status__c, "Draft", "status unchanged");
  assert.equal(fake.puts.length, putsBefore, "nothing stored");
  assert.equal(fake.calls.updates.filter((u) => u.obj === "Sundial_Estimate__c").length, updatesBefore, "no estimate write");
  est.Status__c = "Sent";
  assert.equal((await call(h, "GET", `/service/estimates/${c.body.id}/pdf`)).body.watermark, "PREVIEW");
  const tech = makeHandler(fake, { access: { level: "Technician", scope: "tech", userId: USER, tenantId: TENANT } });
  assert.equal((await call(tech, "GET", `/service/estimates/${c.body.id}/pdf`)).status, 403);
  assert.equal((await call(h, "GET", "/service/estimates/000000000000000000/pdf")).status, 404);
});

test("POST /service/estimates/{id}/lines/reorder (2026-10-22): every line once → Sort_Order__c 1..n, money untouched; the read, the PDF model and the issued invoice follow the order; bad lists 400; invoiced 409", async () => {
  const fake = fakeSalesforce();
  await fake.deps.sfCreateRecord("Sundial_Customer__c", { Client__c: TENANT, Name: "Ro", Primary_Email__c: "ro@example.com", Street__c: "5 Fir", City__c: "Mesa", State__c: "AZ", Postal_Code__c: "85201" });
  const h = makeHandler(fake);
  const j = await call(h, "POST", "/service/jobs", { customer: { id: fake.store.Sundial_Customer__c[0].Id }, lines: [{ description: "Alpha", kind: "Labor", unitPrice: 100 }, { description: "Bravo", kind: "Labor", unitPrice: 200 }, { description: "Charlie", kind: "Fee", unitPrice: 50 }] });
  assert.equal(j.status, 201, JSON.stringify(j.body));
  const est = fake.store.Sundial_Estimate__c[0];
  const job = fake.store.Sundial_Service_Job__c[0];
  const read = async () => (await call(h, "GET", `/service/estimates/${est.Id}`)).body.lines.map((l) => l.Description__c);
  assert.deepEqual(await read(), ["Alpha", "Bravo", "Charlie"]);
  const ids = Object.fromEntries(fake.store.Sundial_Service_Line__c.map((l) => [l.Description__c, l.Id]));
  const totalBefore = est.Total__c;

  // Bad lists: a missing line, a duplicate, a stranger.
  for (const lineIds of [[ids.Alpha, ids.Bravo], [ids.Alpha, ids.Alpha, ids.Bravo], [ids.Alpha, ids.Bravo, "a1X000000000000AAA"], null]) {
    const bad = await call(h, "POST", `/service/estimates/${est.Id}/lines/reorder`, { lineIds });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "REORDER_INVALID");
  }

  const r = await call(h, "POST", `/service/estimates/${est.Id}/lines/reorder`, { lineIds: [ids.Charlie, ids.Alpha, ids.Bravo] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await read(), ["Charlie", "Alpha", "Bravo"]);
  assert.deepEqual(["Charlie", "Alpha", "Bravo"].map((n) => fake.store.Sundial_Service_Line__c.find((l) => l.Id === ids[n]).Sort_Order__c), [1, 2, 3]);
  assert.equal(est.Total__c, totalBefore, "money is order-independent");
  const act = fake.activity.find((a) => a.event === "estimate_updated" && a.details?.reordered === true);
  assert.ok(act, "activity estimate_updated with reordered: true");

  // The document model the PDF and the hosted page are painted from.
  const { buildEstimateModel } = await import("../../lib/estimate-document.js");
  const lines = (await fake.deps.sfQuery(`SELECT Id FROM Sundial_Service_Line__c WHERE Estimate__c = '${est.Id}' ORDER BY Sort_Order__c NULLS LAST, CreatedDate`));
  const model = buildEstimateModel({ estimate: est, lines, totals: { total: 0, rows: [] }, brand: {}, options: { mode: "pdf" } });
  assert.deepEqual(model.rows.map((row) => JSON.stringify(row)).map((s) => ["Charlie", "Alpha", "Bravo"].find((n) => s.includes(n))), ["Charlie", "Alpha", "Bravo"]);

  // Issue: the invoice is the estimate's lines in that order — the version log too.
  job.Tax_Zone_Code__c = job.Tax_Zone_Code__c || "MESA";
  const iss = await call(h, "POST", `/service/jobs/${job.Id}/invoice`, {});
  assert.equal(iss.status, 201, JSON.stringify(iss.body));
  const inv = fake.store.Sundial_Service_Invoice__c[0];
  const preview = await call(h, "GET", `/service/invoices/${inv.Id}/preview`);
  const html = preview.body.html;
  assert.ok(html.indexOf("Charlie") < html.indexOf("Alpha") && html.indexOf("Alpha") < html.indexOf("Bravo"), "invoice rows in the reordered order");

  // Every line reader asks Salesforce for the same order.
  const lineReads = fake.calls.queries.filter((q) => /FROM Sundial_Service_Line__c WHERE Estimate__c/.test(q) && /ORDER BY/.test(q));
  assert.ok(lineReads.length > 0 && lineReads.every((q) => /ORDER BY Sort_Order__c NULLS LAST, CreatedDate/.test(q)), lineReads.find((q) => !/Sort_Order__c NULLS LAST/.test(q)));

  // Locked once invoiced.
  const locked = await call(h, "POST", `/service/estimates/${est.Id}/lines/reorder`, { lineIds: [ids.Alpha, ids.Bravo, ids.Charlie] });
  assert.equal(locked.status, 409);
});

test("the customer feed's system lines (D-084) + the follow-up flag from the popups: create-with-intake → one intake comment; an existing customer's changed answers → one; unchanged → none; assignment → its own line; a follow-up date ticks Follow_Up_Needed__c", async () => {
  const fake = fakeSalesforce();
  fake.store.Sundial_User__c.push({ Id: "a0U000000000001AAA", Client__c: TENANT, First_Name__c: "Paige", Last_Name__c: "Ng", Active__c: true });
  const h = makeHandler(fake, { authUserId: "uuid-paige-king" });
  const r = await call(h, "POST", "/service/customers", {
    customer: { new: { firstName: "Nora", lastName: "Quinn", phone: "602-555-0177" } },
    intake: { systemOwnership: "Own", inverterManufacturer: "Enphase" },
    request: { assignedTo: "a0U000000000001AAA", nextFollowUp: "2026-09-25" },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const custId = r.body.customerId;
  const cust = fake.store.Sundial_Customer__c.find((c) => c.Id === custId);
  assert.equal(cust.Follow_Up_Needed__c, true, "a follow-up date ticks the flag");
  const intake = fake.comments.filter((c) => c.body.startsWith("Intake updated"));
  assert.equal(intake.length, 1);
  assert.match(intake[0].body, /^Intake updated by Paige King on .* \(Arizona\): Do you own or lease the system\? — Own; What brand is your solar inverter\? — Enphase$/);
  assert.equal(intake[0].record_object, "customer");
  assert.equal(intake[0].record_id, custId);
  assert.equal(intake[0].kind, "system");
  assert.equal(intake[0].author_id, "uuid-paige-king");
  const assigned = fake.comments.filter((c) => c.body.startsWith("Assigned to"));
  assert.equal(assigned.length, 1);
  assert.match(assigned[0].body, /^Assigned to Paige Ng by Paige King on /);

  // The same customer picked in New Estimate: a changed answer → one line; the same answers → none.
  const n0 = fake.comments.length;
  const e1 = await call(h, "POST", "/service/estimates", { customer: { id: custId }, intake: { systemOwnership: "Lease", inverterManufacturer: "Enphase" } });
  assert.equal(e1.status, 201, JSON.stringify(e1.body));
  assert.equal(fake.comments.length, n0 + 1);
  assert.match(fake.comments.at(-1).body, /: Do you own or lease the system\? — Lease$/);
  const e2 = await call(h, "POST", "/service/estimates", { customer: { id: custId }, intake: { systemOwnership: "Lease" } });
  assert.equal(e2.status, 201);
  assert.equal(fake.comments.length, n0 + 1, "unchanged answers say nothing");
});
