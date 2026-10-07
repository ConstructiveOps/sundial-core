// customer.js — the customer half of the New Estimate / New Job popup
// (D-072 amendment; docs/service-data-model.md §3.1a).
//
// PURE helpers only: input normalization, the duplicate-candidate matcher, the
// SOQL that finds candidates, and the field map for a new customer. The Lambda does
// the I/O. Nothing here knows Harmon — the module tag ("Service") is passed in.

import { soqlEscapeString } from "../../lib/salesforce.js";

export const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";
export const PROJECT_TYPES_FIELD = "Requested_Project_Types__c";

/** The fields the popup may set on a NEW customer. Anything else is refused. */
export const NEW_CUSTOMER_FIELDS = Object.freeze({
  firstName: "First_Name__c",
  lastName: "Last_Name__c",
  street: "Street__c",
  city: "City__c",
  state: "State__c",
  postalCode: "Postal_Code__c",
  email: "Primary_Email__c",
  phone: "Primary_Phone__c",
});

/**
 * The columns the duplicate matcher reads back — also every customer read that feeds a
 * name snapshot, so Is_Company__c / Company_Name__c ride along (D-081, customerDisplayName).
 */
export const CANDIDATE_SELECT =
  "Id, Name, First_Name__c, Last_Name__c, Is_Company__c, Company_Name__c, Street__c, City__c, State__c, Postal_Code__c, " +
  "Primary_Email__c, Primary_Phone__c, Alternate_Contact_Phone__c, Alternate_Contact_Email__c, Requested_Project_Types__c, Customer_Type__c";
/** The sweep's row cap (2026-10-07: was 25 with no ORDER BY — a real twin could fall off the end). */
export const CANDIDATE_LIMIT = 200;

const clean = (v) => (v == null ? "" : String(v).trim());

/** Digits only; the last 10 so +1 / (602) / dashes all compare equal. */
export function normalizePhone(v) {
  const d = clean(v).replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
}

export function normalizeEmail(v) {
  return clean(v).toLowerCase();
}

/** House number + first street token, lowercased: "123 N Main St" -> "123 n". */
export function streetKey(v) {
  const parts = clean(v).toLowerCase().replace(/[.,#]/g, " ").split(/\s+/).filter(Boolean);
  return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : parts[0] || "";
}

export function normalizeZip(v) {
  return clean(v).replace(/\D/g, "").slice(0, 5);
}

/**
 * Validate + normalize the popup's "new customer" block.
 * @returns {{ ok:true, value:object } | { ok:false, missing:string[] }}
 */
export function normalizeNewCustomer(input) {
  const src = input && typeof input === "object" ? input : {};
  const value = {
    firstName: clean(src.firstName),
    lastName: clean(src.lastName),
    street: clean(src.street),
    city: clean(src.city),
    state: clean(src.state),
    postalCode: clean(src.postalCode),
    email: clean(src.email),
    phone: clean(src.phone),
  };
  const missing = [];
  if (!value.firstName && !value.lastName) missing.push("firstName|lastName");
  if (!value.email && !value.phone) missing.push("email|phone");
  if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) missing.push("email(format)");
  return missing.length ? { ok: false, missing } : { ok: true, value };
}

/**
 * SOQL for the duplicate sweep, tenant-scoped. Wide on purpose (LIKE on the phone
 * tail, zip + house number); `matchCandidates` does the exact comparison in JS,
 * because Salesforce cannot strip phone formatting in a WHERE clause.
 */
export function candidateSoql(tenantId, c) {
  const ors = [];
  const email = normalizeEmail(c.email);
  if (email) ors.push(`Primary_Email__c = '${soqlEscapeString(email)}'`, `Alternate_Contact_Email__c = '${soqlEscapeString(email)}'`);
  const phone = normalizePhone(c.phone);
  // The LAST SEVEN digits (2026-10-07; was four — every number ending in the same four
  // digits was a candidate and the real twin could fall outside the row cap), on both
  // phone fields: the twin may have been entered under the other one.
  if (phone.length >= 7) {
    const tail = soqlEscapeString(phone.slice(-7));
    const pattern = `%${tail.slice(0, 3)}%${tail.slice(3)}`;
    ors.push(`Primary_Phone__c LIKE '${pattern}'`, `Alternate_Contact_Phone__c LIKE '${pattern}'`);
  }
  const zip = normalizeZip(c.postalCode);
  const house = streetKey(c.street).split(" ")[0];
  if (zip && house) {
    ors.push(
      `(Postal_Code__c LIKE '${soqlEscapeString(zip)}%' AND Street__c LIKE '${soqlEscapeString(house)}%')`
    );
  }
  if (!ors.length) return null;
  return (
    `SELECT ${CANDIDATE_SELECT} FROM ${CUSTOMER_SF_OBJECT} ` +
    `WHERE Client__c = '${soqlEscapeString(tenantId)}' AND (${ors.join(" OR ")}) ORDER BY CreatedDate DESC LIMIT ${CANDIDATE_LIMIT}`
  );
}

/**
 * Exact-match filter over the wide sweep. A candidate is a duplicate when ANY of:
 * same email, same 10-digit phone, same zip + house number + street token.
 * Returns [{ id, name, reasons:[...], record }].
 */
export function matchCandidates(rows, c) {
  const email = normalizeEmail(c.email);
  const phone = normalizePhone(c.phone);
  const zip = normalizeZip(c.postalCode);
  const street = streetKey(c.street);
  const out = [];
  const house = street.split(" ")[0];
  for (const r of rows || []) {
    const reasons = [];
    if (email && [r.Primary_Email__c, r.Alternate_Contact_Email__c].some((e) => normalizeEmail(e) === email)) reasons.push("email");
    if (phone.length === 10 && [r.Primary_Phone__c, r.Alternate_Contact_Phone__c].some((p) => normalizePhone(p) === phone)) reasons.push("phone");
    if (zip && street && normalizeZip(r.Postal_Code__c) === zip) {
      // The same house number in the same zip is a duplicate even when the street was
      // typed differently ("123 N Main" vs "123 Main St", 2026-10-07) — the office
      // confirms; a wrong "possible duplicate" costs one click, a missed one costs a
      // second customer record.
      const rk = streetKey(r.Street__c);
      if (rk === street || (house && /^\d+$/.test(house) && rk.split(" ")[0] === house)) reasons.push("address");
    }
    if (reasons.length) {
      out.push({
        id: r.Id,
        name: r.Name,
        email: r.Primary_Email__c ?? null,
        phone: r.Primary_Phone__c ?? null,
        address: [r.Street__c, r.City__c, r.State__c, r.Postal_Code__c].filter(Boolean).join(", "),
        reasons,
      });
    }
  }
  return out;
}

/**
 * Field map for the new customer. `pickState` resolves the State__c picklist
 * (describe-guarded by the caller; returns null to skip). Client__c is stamped by
 * the caller from the verified token — never from input.
 */
export function buildNewCustomerFields(c, { pickState } = {}) {
  const f = {
    Name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || c.phone,
    First_Name__c: c.firstName || null,
    Last_Name__c: c.lastName || null,
    Street__c: c.street || null,
    City__c: c.city || null,
    Postal_Code__c: c.postalCode || null,
    Primary_Email__c: c.email || null,
    Primary_Phone__c: c.phone || null,
  };
  const state = c.state && pickState ? pickState(c.state) : c.state || null;
  if (state) f.State__c = state;
  for (const k of Object.keys(f)) if (f[k] == null) delete f[k];
  return f;
}

/**
 * Multi-select union: Salesforce stores multipicklists as "A;B;C". Adds `tag` if
 * absent; returns null when nothing changes (so the caller skips the write).
 */
export function unionProjectTypes(current, tag) {
  const have = clean(current) ? clean(current).split(";").map((s) => s.trim()).filter(Boolean) : [];
  if (have.includes(tag)) return null;
  return [...have, tag].join(";");
}

/** Case-insensitive picklist match against a describe's active values, or null. */
export function matchPicklist(value, picklistValues = []) {
  const want = clean(value).toLowerCase();
  if (!want) return null;
  for (const v of picklistValues) {
    const val = typeof v === "string" ? v : v?.value;
    const active = typeof v === "string" ? true : v?.active !== false;
    if (active && clean(val).toLowerCase() === want) return val;
    // "AZ" vs "Arizona": accept a label match too when describe carries labels.
    if (active && typeof v === "object" && clean(v?.label).toLowerCase() === want) return val;
  }
  return null;
}
