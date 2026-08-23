// Tests for the Acumatica project attribute builder.
//
// The values pinned here come from the LIVE enumeration of project R251282 (§7). That
// matters more than usual: attributes are the numbers Harmon's accounting reporting
// reads, and every one of them is derivable two or three plausible ways. The live pull
// is the only thing that says which way is right.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectAttributes, split7525, splitRepThirdParty, formatAttributeValue,
  DATE_ATTRIBUTES, attributeFieldNames, M1_SHARE, REP_M1_CAP,
} from "./acumatica-attributes.js";

/** R251282's shape: 12.76 kW, third-party, 7,314 rep commission. */
const LIVE = {
  Commission_Deal_Type__c: "3rd Party",
  System_Size__c: 12.76,
  Sales_Company_Harmon_Solar_or_Third__c: "Familia Sicairos",
  Sales_Rep_Commission_Amt__c: 7314,
  Sales_Mgr_Commission_Amt__c: 510.4,   // .04 x 12760 W
  Overhead_Commission_Amt__c: 191.4,    // .015 x 12760 W
  Audit_Date_and_DateTime__c: "2026-07-14",
  Approved_for_Design_Date__c: "2026-07-20",
  Scheduled_Install_Date__c: "2026-08-01",
  Inspection_Pass_Date__c: "2026-08-10",
  Commission_of_System__c: "2026-08-15",
};

const asMap = (values, opts) =>
  Object.fromEntries(buildProjectAttributes(values, opts).attributes.map((a) => [a.AttributeID, a.Value]));

test("reproduces the live R251282 commission attributes exactly", () => {
  // The four numbers verified against the live pull: SLSCOM 2500/4814 (the cap biting),
  // MGRCOM 382.80/127.60, MGMTOR 143.55/47.85. If a refactor changes any of these, it
  // has changed what Harmon's reports say people were paid.
  const m = asMap(LIVE);
  assert.equal(m.SLSCOM1, "2500");
  assert.equal(m.SLSCOM2, "4814");
  assert.equal(m.MGRCOM1, "382.8");
  assert.equal(m.MGRCOM2, "127.6");
  assert.equal(m.MGMTOR1, "143.55");
  assert.equal(m.MGMTOR2, "47.85");
});

test("SALESPERSO comes from the sales-company field (Q10, resolved)", () => {
  const m = asMap(LIVE);
  assert.equal(m.SALESPERSO, "Familia Sicairos");
  // Internal jobs carry the literal "Harmon Solar" — the attribute is named "Sales
  // Person" but holds the selling COMPANY, which is what the live data shows.
  const internal = asMap({ ...LIVE, Sales_Company_Harmon_Solar_or_Third__c: "Harmon Solar", Commission_Deal_Type__c: "Internal", Internal_Rep_Commission_Amt__c: 7314 });
  assert.equal(internal.SALESPERSO, "Harmon Solar");
});

test("the five lifecycle dates map to the fields the describe confirmed", () => {
  const m = asMap(LIVE);
  assert.equal(m.AUDITDATE, "2026-07-14");
  assert.equal(m.INDESIGN, "2026-07-20");
  assert.equal(m.INCOMDATE, "2026-08-01");
  assert.equal(m.GREENTAG, "2026-08-10");
  assert.equal(m.COMDATE, "2026-08-15");
  assert.equal(DATE_ATTRIBUTES.length, 5);
});

test("KW is the system size and JOBTYPE comes from the caller", () => {
  assert.equal(asMap(LIVE).KW, "12.76");
  assert.equal(asMap(LIVE, { jobType: "RSDC" }).JOBTYPE, "RSDC");
  // Without it, JOBTYPE is omitted rather than guessed — the template code is known at
  // Layer-1 push time and nowhere else.
  assert.ok(buildProjectAttributes(LIVE).omitted.includes("JOBTYPE"));
});

// ---------------------------------------------------------------------------
// The split that is not the same split
// ---------------------------------------------------------------------------

test("INTERNAL rep commission splits 75/25, NOT by the third-party milestone rule", () => {
  // D16: an internal deal raises no PO but still gets SLSCOM1/2. Using the third-party
  // rule would cap the first payment at 2,500 and understate it on every internal job
  // over $5,000 — which under D19's redline model is most of them.
  const m = asMap({ ...LIVE, Commission_Deal_Type__c: "Internal", Internal_Rep_Commission_Amt__c: 14032, Sales_Rep_Commission_Amt__c: 0 });
  assert.equal(m.SLSCOM1, "10524");   // 75% of 14032
  assert.equal(m.SLSCOM2, "3508");    // 25%
  // Emphatically not the capped rule:
  assert.notEqual(m.SLSCOM1, "2500");
});

test("an internal deal reads the INTERNAL amount field, not the third-party one", () => {
  // The two amounts live in different fields (D19 routes one or the other), and reading
  // the wrong one would silently report zero commission on every internal job.
  const m = asMap({ ...LIVE, Commission_Deal_Type__c: "Internal", Internal_Rep_Commission_Amt__c: 8000, Sales_Rep_Commission_Amt__c: 0 });
  assert.equal(m.SLSCOM1, "6000");
});

test("manager and overhead are 75/25 whichever way the deal was sold", () => {
  const ext = asMap(LIVE);
  const int = asMap({ ...LIVE, Commission_Deal_Type__c: "Internal", Internal_Rep_Commission_Amt__c: 9000 });
  for (const k of ["MGRCOM1", "MGRCOM2", "MGMTOR1", "MGMTOR2"]) {
    assert.equal(ext[k], int[k], `${k} should not depend on deal type`);
  }
});

test("manager and overhead stay SEPARATE attributes, never summed", () => {
  // D10 keeps them as two stored components precisely so this split is possible. The
  // budget's SLMC line sums them; doing that here too would collapse MGRCOM and MGMTOR
  // into one number and lose the distinction the attributes exist to make.
  const m = asMap(LIVE);
  const summed = split7525(510.4 + 191.4);
  assert.notEqual(m.MGRCOM1, String(summed.m1));
  assert.equal(Number(m.MGRCOM1) + Number(m.MGMTOR1), summed.m1);
});

test("both splits always sum to their total, to the cent", () => {
  for (const total of [0.01, 1, 33.33, 510.4, 1234.57, 4999.99, 5000.01, 7314, 99999.99]) {
    const a = split7525(total);
    assert.equal(Math.round((a.m1 + a.m2) * 100) / 100, Math.round(total * 100) / 100, `75/25 of ${total}`);
    const b = splitRepThirdParty(total);
    assert.equal(Math.round((b.m1 + b.m2) * 100) / 100, Math.round(total * 100) / 100, `rep split of ${total}`);
  }
  assert.equal(M1_SHARE, 0.75);
  assert.equal(REP_M1_CAP, 2500);
});

// ---------------------------------------------------------------------------
// Blanks
// ---------------------------------------------------------------------------

test("a blank date is OMITTED, never written as an empty string", () => {
  // This is the property that stops the sync being able to erase things. A milestone
  // that has not happened is not a milestone someone cleared, and an unreached date
  // written as "" would wipe a value entered in Acumatica by hand.
  const { attributes, omitted } = buildProjectAttributes({ ...LIVE, Inspection_Pass_Date__c: null, Commission_of_System__c: "" });
  const ids = attributes.map((a) => a.AttributeID);
  assert.ok(!ids.includes("GREENTAG"));
  assert.ok(!ids.includes("COMDATE"));
  assert.ok(omitted.includes("GREENTAG") && omitted.includes("COMDATE"));
  // ...and nothing was emitted with an empty value.
  for (const a of attributes) assert.notEqual(a.Value, "");
});

test("zero commissions omit their milestone pair rather than writing 0", () => {
  const { attributes, omitted } = buildProjectAttributes({ ...LIVE, Sales_Rep_Commission_Amt__c: 0, Overhead_Commission_Amt__c: 0 });
  const ids = attributes.map((a) => a.AttributeID);
  for (const k of ["SLSCOM1", "SLSCOM2", "MGMTOR1", "MGMTOR2"]) {
    assert.ok(!ids.includes(k), `${k} should be omitted`);
    assert.ok(omitted.includes(k));
  }
  // The manager pair is unaffected — omission is per-pair, not all-or-nothing.
  assert.ok(ids.includes("MGRCOM1"));
});

test("a totally empty record produces no attributes and no crash", () => {
  const { attributes, omitted } = buildProjectAttributes({});
  assert.deepEqual(attributes, []);
  assert.ok(omitted.length >= 13);
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test("a Salesforce DateTime is reduced to its date", () => {
  // Attributes here are calendar dates. Keeping the time would put a meaningless
  // 00:00:00Z into a reporting field, and reformatting is where timezones creep into a
  // value that never had one.
  assert.equal(formatAttributeValue("2026-07-14T00:00:00.000+0000"), "2026-07-14");
  assert.equal(formatAttributeValue("2026-07-14"), "2026-07-14");
  assert.equal(formatAttributeValue(new Date("2026-07-14T12:00:00Z")), "2026-07-14");
});

test("every value is a string, because attributes are string-valued", () => {
  for (const a of buildProjectAttributes(LIVE, { jobType: "RS" }).attributes) {
    assert.equal(typeof a.Value, "string", `${a.AttributeID} is ${typeof a.Value}`);
    assert.equal(typeof a.AttributeID, "string");
  }
});

test("attributeFieldNames covers every field the builder reads", () => {
  const names = attributeFieldNames();
  for (const a of DATE_ATTRIBUTES) assert.ok(names.includes(a.field), `${a.field} missing`);
  for (const f of ["System_Size__c", "Sales_Company_Harmon_Solar_or_Third__c", "Commission_Deal_Type__c",
    "Sales_Rep_Commission_Amt__c", "Internal_Rep_Commission_Amt__c", "Sales_Mgr_Commission_Amt__c",
    "Overhead_Commission_Amt__c"]) {
    assert.ok(names.includes(f), `${f} missing`);
  }
  assert.equal(new Set(names).size, names.length, "duplicate field name");
});
