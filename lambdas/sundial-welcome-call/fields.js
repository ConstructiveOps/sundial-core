// Describe-guarded field resolution for Sundial_Customer__c.
//
// Same pattern as sundial-aurora-inbound / sundial-aurora-push: intersect the fields
// we WANT with the fields the org ACTUALLY HAS (from the live describe, TTL-cached in
// lib/salesforce.js), and build the SOQL select list from the intersection. A field
// that doesn't exist is skipped instead of turning the whole query into a
// "No such column" error.
//
// WHAT'S DIFFERENT HERE: each logical value carries a CANDIDATE LIST of API names,
// not a single name, and the first one present in the org wins.
//
// That is not speculative generality — the org drifts from the spec in exactly this
// way today. The Welcome Call spec names `Due_at_Greentag_Amount__c`; the live
// Sundial_Customer__c has `Due_at_Green_Tag_Amount__c`. Both are listed, so the
// Lambda reads the right value now AND keeps working if the field is ever renamed to
// match the spec. When neither candidate exists the value is simply undefined, and
// format.js turns that into "not provided".

/**
 * Logical name -> Salesforce API name candidates, highest priority first.
 * The logical names are what format.js's `get()` is called with.
 */
export const FIELD_CANDIDATES = {
  name: ["Name"],
  street: ["Street__c"],
  city: ["City__c"],
  state: ["State__c"],
  postalCode: ["Postal_Code__c"],
  phone: ["Primary_Phone__c"],
  email: ["Primary_Email__c"],

  systemSizeKw: ["Final_System_Size_kW__c"],
  firstYearProduction: ["First_Year_kW_Production__c"],

  financingPartner: ["Financing_Partner__c"],
  monthlyPayment: ["Monthly_Payment__c"],
  energyRate: ["Energy_Rate__c"],
  escalator: ["Escalator__c"],

  contractAmount: ["Contract_Amount__c"],
  downPaymentAmount: ["Down_Payment_Amount__c"],
  dueAtAuditAmount: ["Due_at_Audit_Amount__c"],
  // Spec name first, live-org name second — see the header note.
  dueAtGreentagAmount: ["Due_at_Greentag_Amount__c", "Due_at_Green_Tag_Amount__c"],

  loanTermYears: ["Loan_Term_Years__c"],
  apr: ["APR__c"],
  prepaidLeaseAmount: ["Prepaid_Lease_Amount__c"],

  welcomeCallStatus: ["Welcome_Call_Status__c"],
  welcomeCallAttempts: ["Welcome_Call_Attempts__c"],
  welcomeCallLog: ["Welcome_Call_Log__c"],

  client: ["Client__c"],
};

/**
 * Logical names whose ABSENCE from the org breaks the feature rather than degrading
 * it. Without a status field there is no state machine, without an attempts field
 * there is no retry ceiling, and without a log there is nowhere to explain a skip —
 * so the caller refuses to place calls instead of dialing in an uncontrolled loop.
 */
export const REQUIRED_LOGICAL_FIELDS = [
  "welcomeCallStatus",
  "welcomeCallAttempts",
  "welcomeCallLog",
];

/**
 * Resolve the logical field map against a live describe.
 *
 * @param {object} describe - the raw describe payload (fields[])
 * @returns {{
 *   apiName: (logical: string) => string|null,
 *   selectFields: string[],
 *   missingLogical: string[],
 *   missingRequired: string[],
 *   reader: (record: object) => ((logical: string) => any)
 * }}
 */
export function resolveCustomerFields(describe) {
  const byLower = new Map(
    (describe?.fields || []).map((f) => [String(f.name).toLowerCase(), f])
  );

  const resolved = new Map(); // logical -> canonical API name
  const missingLogical = [];

  for (const [logical, candidates] of Object.entries(FIELD_CANDIDATES)) {
    const hit = candidates
      .map((c) => byLower.get(c.toLowerCase()))
      .find((f) => f != null);
    if (hit) resolved.set(logical, hit.name);
    else missingLogical.push(logical);
  }

  // Id is always selected — every downstream write addresses the record by it.
  const selectFields = ["Id", ...new Set(resolved.values())];

  return {
    apiName: (logical) => resolved.get(logical) ?? null,
    selectFields,
    missingLogical,
    missingRequired: REQUIRED_LOGICAL_FIELDS.filter((l) => !resolved.has(l)),
    /**
     * Bind a Salesforce record to a `get(logical)` accessor. An unresolved field
     * yields undefined, which format.js renders as "not provided".
     */
    reader: (record) => (logical) => {
      const api = resolved.get(logical);
      return api ? record?.[api] : undefined;
    },
  };
}
