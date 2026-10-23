// Tests for the dealer-terms rule (D-085 amendment 1).
//
// The property that matters most: a post-cutover record never reads the picklist, even
// when the picklist holds a perfectly good value and the dealer is missing.
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveDealerTerms, dealerTermsFieldNames, gmtDate,
  DEALER_TERMS_CUTOVER, LEGACY_SALES_COMPANY_FIELDS,
} from "./dealer-terms.js";

const PRE = "2026-09-03T12:00:00.000+0000";
const POST = "2026-09-04T00:00:00.000+0000";

const dealer = (over = {}) => ({
  Dealer__c: "a0Y000000000DLRAAA",
  Dealer__r: { Name: "Heavenly Power", Is_Internal__c: false, Acumatica_Vendor_ID__c: "02118", ...over },
});
const solar = (over = {}) => ({
  Name: "SOL-1",
  Dealer__c: null,
  Dealer__r: null,
  CreatedDate: POST,
  Sundial_Customer__c: "a1P000000000CUSAAA",
  Sundial_Customer__r: { CreatedDate: PRE },
  Sales_Company_Harmon_Solar_or_Third__c: "Blue Sky Solar",
  ...over,
});

test("a dealer wins on either side of the cutover", () => {
  for (const when of [PRE, POST]) {
    const r = resolveDealerTerms(solar({ ...dealer(), Sundial_Customer__r: { CreatedDate: when } }));
    assert.equal(r.ok, true);
    assert.equal(r.source, "dealer");
    assert.equal(r.isInternal, false);
    assert.equal(r.vendorId, "02118");
    assert.equal(r.salesCompanyName, "Heavenly Power", "the dealer's Name, not the picklist");
  }
});

test("the dealer's internal flag is the internal answer — the picklist is ignored", () => {
  const r = resolveDealerTerms(solar({ ...dealer({ Name: "Harmon Solar", Is_Internal__c: true, Acumatica_Vendor_ID__c: null }) }));
  assert.equal(r.isInternal, true);
  assert.equal(r.vendorId, null);
  const ext = resolveDealerTerms(solar({ ...dealer(), Sales_Company_Harmon_Solar_or_Third__c: "Harmon Solar" }));
  assert.equal(ext.isInternal, false, "a Harmon Solar picklist value does not make a dealer deal internal");
});

test("no dealer, pre-cutover: legacy picklist behaviour, unchanged", () => {
  const r = resolveDealerTerms(solar());
  assert.deepEqual(
    { ok: r.ok, source: r.source, salesCompany: r.salesCompany, isInternal: r.isInternal, vendorId: r.vendorId },
    { ok: true, source: "legacy", salesCompany: "Blue Sky Solar", isInternal: false, vendorId: null }
  );
  for (const s of ["Harmon Solar", "HARMON SOLAR", "  harmon solar "]) {
    assert.equal(resolveDealerTerms(solar({ Sales_Company_Harmon_Solar_or_Third__c: s })).isInternal, true, s);
  }
  const blank = resolveDealerTerms(solar({ Sales_Company_Harmon_Solar_or_Third__c: null }));
  assert.equal(blank.ok, true, "a blank legacy company is the caller's refusal, not this one");
  assert.equal(blank.salesCompany, "");
});

test("no dealer, post-cutover: DEALER_MISSING — even with a good picklist value", () => {
  const r = resolveDealerTerms(solar({ Sundial_Customer__r: { CreatedDate: POST } }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "DEALER_MISSING");
  assert.match(r.message, /SOL-1/, "names the record");
  assert.match(r.message, /Sales Rep/, "and says to set the Sales Rep");
  assert.ok(!("salesCompany" in r), "the picklist is not read, so it is not returned");
});

test("Solar uses its CUSTOMER's date when linked, its own when not", () => {
  // Own date post, customer pre → legacy.
  assert.equal(resolveDealerTerms(solar({ CreatedDate: POST, Sundial_Customer__r: { CreatedDate: PRE } })).source, "legacy");
  // Own date pre, customer post → refused.
  assert.equal(resolveDealerTerms(solar({ CreatedDate: PRE, Sundial_Customer__r: { CreatedDate: POST } })).code, "DEALER_MISSING");
  // Unlinked → own date.
  const unlinked = { Sundial_Customer__c: null, Sundial_Customer__r: null };
  assert.equal(resolveDealerTerms(solar({ ...unlinked, CreatedDate: PRE })).source, "legacy");
  assert.equal(resolveDealerTerms(solar({ ...unlinked, CreatedDate: POST })).code, "DEALER_MISSING");
});

test("the boundary is the GMT date, like DATEVALUE(CreatedDate)", () => {
  // 2026-09-03 17:30 in Phoenix is 2026-09-04 00:30 GMT → post-cutover.
  const r = resolveDealerTerms(solar({ Sundial_Customer__r: { CreatedDate: "2026-09-04T00:30:00.000+0000" } }));
  assert.equal(r.code, "DEALER_MISSING");
  assert.equal(resolveDealerTerms(solar({ Sundial_Customer__r: { CreatedDate: "2026-09-03T23:59:59.000+0000" } })).source, "legacy");
  assert.equal(gmtDate("2026-09-03T20:00:00.000-0700"), "2026-09-04");
  assert.equal(gmtDate("2026-09-04"), "2026-09-04");
  assert.equal(gmtDate("not a date"), null);
  assert.equal(DEALER_TERMS_CUTOVER, "2026-09-04");
});

test("Customer object: its own date and Sales_Company__c", () => {
  const cust = { Name: "Jane Doe", Dealer__c: null, CreatedDate: PRE, Sales_Company__c: "Harmon Solar" };
  const r = resolveDealerTerms(cust, { object: "Sundial_Customer__c" });
  assert.equal(r.source, "legacy");
  assert.equal(r.isInternal, true);
  assert.equal(resolveDealerTerms({ ...cust, CreatedDate: POST }, { object: "Sundial_Customer__c" }).code, "DEALER_MISSING");
});

test("unreadable inputs refuse rather than fall back to the picklist", () => {
  const noRow = resolveDealerTerms(solar({ Dealer__c: "a0Y000000000DLRAAA", Dealer__r: undefined }));
  assert.equal(noRow.code, "DEALER_TERMS_UNAVAILABLE");
  const noDate = resolveDealerTerms(solar({ Sundial_Customer__r: { CreatedDate: undefined } }));
  assert.equal(noDate.code, "DEALER_TERMS_UNAVAILABLE");
});

test("flat relationship keys are read too", () => {
  const r = resolveDealerTerms({
    Name: "SOL-2", Dealer__c: "a0Y", "Dealer__r.Name": "Suzuki Solar",
    "Dealer__r.Is_Internal__c": false, "Dealer__r.Acumatica_Vendor_ID__c": " 02050 ",
  });
  assert.equal(r.salesCompanyName, "Suzuki Solar");
  assert.equal(r.vendorId, "02050", "trimmed");
});

test("dealerTermsFieldNames lists every field the rule reads", () => {
  assert.deepEqual(dealerTermsFieldNames("Sundial_Solar__c"), [
    "Dealer__c", "Dealer__r.Name", "Dealer__r.Is_Internal__c", "Dealer__r.Acumatica_Vendor_ID__c",
    "CreatedDate", "Sundial_Customer__c", "Sundial_Customer__r.CreatedDate",
    "Sales_Company_Harmon_Solar_or_Third__c",
  ]);
  assert.ok(!dealerTermsFieldNames("Sundial_Customer__c").includes("Sundial_Customer__r.CreatedDate"));
  assert.equal(LEGACY_SALES_COMPANY_FIELDS.Sundial_Customer__c, "Sales_Company__c");
  assert.throws(() => dealerTermsFieldNames("Sundial_Roofing__c"));
});
