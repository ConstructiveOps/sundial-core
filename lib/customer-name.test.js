// D-081: the display-name rule and its fixture table (shared with the portal's TS copy).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { customerDisplayName, customerContactName, customerAddressLine, addressLines, isCompany } from "./customer-name.js";

const { cases } = JSON.parse(readFileSync(new URL("./customer-name.fixtures.json", import.meta.url), "utf8"));
const SF = { is_company: "Is_Company__c", company_name: "Company_Name__c", first_name: "First_Name__c", last_name: "Last_Name__c", name: "Name" };
const toSf = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [SF[k], v]));

test("fixtures: cache-column spelling", () => {
  for (const c of cases) assert.equal(customerDisplayName(c.record), c.expected, c.label);
});

test("fixtures: Salesforce spelling gives the same answers", () => {
  for (const c of cases) assert.equal(customerDisplayName(toSf(c.record)), c.expected, c.label);
});

test("null record → null", () => {
  assert.equal(customerDisplayName(null), null);
  assert.equal(customerContactName(undefined), null);
});

test("contact name: only a named company with a person on it", () => {
  assert.equal(customerContactName({ Is_Company__c: true, Company_Name__c: "SunRun", First_Name__c: "Dana", Last_Name__c: "Ruiz" }), "Dana Ruiz");
  assert.equal(customerContactName({ Is_Company__c: true, Company_Name__c: "APS" }), null);
  assert.equal(customerContactName({ Is_Company__c: false, First_Name__c: "Mark", Last_Name__c: "Haughn" }), null);
  // A company with a blank name prints the person AS the name, so they are not also "Attn:".
  assert.equal(customerContactName({ Is_Company__c: true, Company_Name__c: " ", First_Name__c: "Dana" }), null);
  assert.equal(isCompany({ is_company: true }), true);
  assert.equal(isCompany({ Is_Company__c: "true" }), false);
});

test("address line: site address, else mailing, else null", () => {
  assert.equal(customerAddressLine({ Street__c: "25825 N 134th Drive", City__c: "Peoria", State__c: "AZ", Postal_Code__c: "85383" }), "25825 N 134th Drive, Peoria, AZ 85383");
  assert.equal(
    customerAddressLine({ Mailing_Street__c: "Po Box 53940", Mailing_City__c: "Phoenix", Mailing_State__c: "AZ", Mailing_Postal_Code__c: "85072" }),
    "Po Box 53940, Phoenix, AZ 85072"
  );
  assert.equal(customerAddressLine({ Street__c: "1 Main", Mailing_Street__c: "Po Box 1" }), "1 Main");
  assert.equal(customerAddressLine({ City__c: "Phoenix", State__c: "AZ" }), "Phoenix, AZ");
  assert.equal(customerAddressLine({}), null);
});

test("addressLines splits every stored shape into street + city line", () => {
  assert.deepEqual(addressLines("25825 N 134th Drive, Peoria, AZ, 85383"), ["25825 N 134th Drive", "Peoria, AZ 85383"]);
  assert.deepEqual(addressLines("25825 N 134th Drive, Peoria, AZ 85383"), ["25825 N 134th Drive", "Peoria, AZ 85383"]);
  assert.deepEqual(addressLines("945 W Deer Valley Rd  Phoenix, AZ 85027"), ["945 W Deer Valley Rd", "Phoenix, AZ 85027"]);
  assert.deepEqual(addressLines("Po Box 53940, Phoenix, AZ 85072"), ["Po Box 53940", "Phoenix, AZ 85072"]);
  assert.deepEqual(addressLines("Somewhere rural"), ["Somewhere rural"]);
  assert.deepEqual(addressLines("  "), []);
  assert.deepEqual(addressLines(null), []);
});
