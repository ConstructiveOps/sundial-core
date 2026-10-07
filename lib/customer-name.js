// lib/customer-name.js — what a customer is CALLED, and where it is, in one place (D-081, 2026-10-07).
//
// A customer is either a person or a company (Is_Company__c). A company — "SunRun",
// "APS", a manufacturer — is a customer record like any other so it can be the PAYER on a
// job (Bill_To_Customer__c). Its name is Company_Name__c; First / Last on a company record
// are its CONTACT (printed as "Attn:" on the invoice), never its name.
//
//   customerDisplayName(record)   Company_Name__c when Is_Company__c and the name is set,
//                                 else First + Last, else Name, else null
//   customerContactName(record)   a company's contact (First + Last), else null
//   customerAddressLine(record)   "street, city, ST zip" — the site address, else the
//                                 mailing address when the site address is empty
//   addressLines(text)            one stored address line → [street, "City, ST ZIP"]
//
// Accepts Salesforce API names (Is_Company__c, First_Name__c …) OR cache column names
// (is_company, first_name …) so the Lambdas and anything reading cache rows share it.
// The portal mirrors customerDisplayName in TypeScript (harmon-crm
// src/lib/service-customers.ts); both are pinned by lib/customer-name.fixtures.json, so
// the two cannot drift — change the rule there and here, together.

const s = (v) => (v == null ? "" : String(v).trim());
const pick = (r, sfName, column) => (r?.[sfName] !== undefined ? r[sfName] : r?.[column]);

const personName = (r) => [s(pick(r, "First_Name__c", "first_name")), s(pick(r, "Last_Name__c", "last_name"))].filter(Boolean).join(" ");

/** True when the record is a company (the checkbox, either spelling). */
export function isCompany(record) {
  return pick(record, "Is_Company__c", "is_company") === true;
}

/** The name to print for a customer, or null when it has none at all. */
export function customerDisplayName(record) {
  if (!record) return null;
  const company = s(pick(record, "Company_Name__c", "company_name"));
  if (isCompany(record) && company) return company;
  return personName(record) || s(pick(record, "Name", "name")) || null;
}

/** A company's contact person ("Attn:"), or null for a person or a company with no contact. */
export function customerContactName(record) {
  if (!record || !isCompany(record) || !s(pick(record, "Company_Name__c", "company_name"))) return null;
  return personName(record) || null;
}

const joinAddress = (street, city, state, zip) => {
  const stateZip = [s(state), s(zip)].filter(Boolean).join(" ");
  return [s(street), s(city), stateZip].filter(Boolean).join(", ");
};

/** The customer's address as one line: site address, else mailing address, else null. */
export function customerAddressLine(record) {
  if (!record) return null;
  const site = joinAddress(pick(record, "Street__c", "street"), pick(record, "City__c", "city"), pick(record, "State__c", "state"), pick(record, "Postal_Code__c", "postal_code"));
  if (site) return site;
  const mailing = joinAddress(
    pick(record, "Mailing_Street__c", "mailing_street"),
    pick(record, "Mailing_City__c", "mailing_city"),
    pick(record, "Mailing_State__c", "mailing_state"),
    pick(record, "Mailing_Postal_Code__c", "mailing_postal_code")
  );
  return mailing || null;
}

/**
 * One stored address line → the two lines a document prints: [street, "City, ST ZIP"].
 * Understands the shapes Sundial stores:
 *   "25825 N 134th Drive, Peoria, AZ, 85383"   (the job / estimate snapshot)
 *   "25825 N 134th Drive, Peoria, AZ 85383"    (customerAddressLine, the invoice snapshot)
 *   "945 W Deer Valley Rd  Phoenix, AZ 85027"  (two spaces — the brand's addressLine)
 * Anything else comes back as one line, unchanged. Empty → [].
 */
export function addressLines(text) {
  const t = s(text);
  if (!t) return [];
  const gap = t.split(/\s{2,}/);
  if (gap.length === 2) return [gap[0].replace(/,\s*$/, ""), gap[1]];
  const parts = t.split(/\s*,\s*/).filter(Boolean);
  if (parts.length < 2) return [t];
  const [street, ...rest] = parts;
  // "Peoria, AZ, 85383" → "Peoria, AZ 85383": a bare state followed by a bare ZIP join with a space.
  if (rest.length >= 3 && /^[A-Za-z]{2}$/.test(rest[rest.length - 2]) && /^\d{5}(-\d{4})?$/.test(rest[rest.length - 1])) {
    const zip = rest.pop();
    rest[rest.length - 1] = `${rest[rest.length - 1]} ${zip}`;
  }
  return [street, rest.join(", ")];
}
