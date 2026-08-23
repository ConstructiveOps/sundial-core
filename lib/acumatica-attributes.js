// Acumatica Project ATTRIBUTE sync (Stage E).
//
// Attributes are the Acumatica-side summary of a job: five lifecycle dates, the job
// type, the system size, who sold it, and the six commission milestone amounts. Harmon's
// reporting reads them, so they are how a job looks from the accounting side.
//
// Enumerated live from project R251282 (§7 of the rework doc) — this is not a guess at
// what exists, it is a list of what does.
//
// ---------------------------------------------------------------------------
// SALESPERSO — resolved 2026-08-22 (Q10, the last open item here)
// ---------------------------------------------------------------------------
// Source is `Sales_Company_Harmon_Solar_or_Third__c`, the same field D19 uses as the
// deal-type discriminator. Confirmed against the live example: R251282's SALESPERSO
// reads "Familia Sicairos", which is a value of that picklist.
//
// Worth being clear about what the attribute therefore means, because the AttributeID
// says "Sales Person": for a dealer deal it carries the DEALER COMPANY, not an
// individual's name, and for an internal deal it carries the literal "Harmon Solar"
// rather than the Harmon rep who sold it. That matches the live data and Harmon's
// reporting; it is not a placeholder waiting for a better field.
//
// ---------------------------------------------------------------------------
// THE COMMISSION SPLITS ARE NOT ALL THE SAME SPLIT
// ---------------------------------------------------------------------------
// Three pairs of milestone attributes, and the rep pair follows a DIFFERENT rule from
// the other two:
//
//   SLSCOM1/2  rep        third-party: min(50%, $2,500) then the balance   (§6)
//                         internal:    75 / 25                             (D16)
//   MGRCOM1/2  manager    75 / 25 of the .04 component
//   MGMTOR1/2  overhead   75 / 25 of the .015 component
//
// An internal deal raises NO purchase order (D16) but STILL gets SLSCOM1/2 — the money
// is paid through payroll and the attributes still have to show it. Filling them from
// the third-party milestone rule would understate the first payment on every internal
// job whose commission exceeds $5,000, which under D19's redline model is most of them.

/** 75/25 is the split for manager, overhead, and the internal rep commission. */
export const M1_SHARE = 0.75;

/** Third-party rep milestone rule (§6). Kept in step with the PO engine's constants. */
export const REP_M1_RATE = 0.5;
export const REP_M1_CAP = 2500;

function numOf(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Split a total into M1/M2 at 75/25, with M2 as the remainder.
 *
 * Same reasoning as the PO engine: round the first part, subtract for the second, so the
 * two always sum to the total. Rounding both independently loses a cent on odd amounts,
 * and a cent that appears in a report and not in a payment is somebody's afternoon.
 */
export function split7525(total) {
  const t = round2(numOf(total));
  if (t <= 0) return { m1: 0, m2: 0 };
  const m1 = round2(t * M1_SHARE);
  return { m1, m2: round2(t - m1) };
}

/** Third-party rep split: capped half, then the balance (§6). */
export function splitRepThirdParty(total) {
  const t = round2(numOf(total));
  if (t <= 0) return { m1: 0, m2: 0 };
  const m1 = Math.min(round2(t * REP_M1_RATE), REP_M1_CAP);
  return { m1: round2(m1), m2: round2(t - m1) };
}

/**
 * Format a value for an Acumatica attribute, which is always a STRING.
 *
 * Dates pass through as the ISO date Salesforce already returns (`2026-07-14`) rather
 * than being reformatted. Two reasons: reformatting is where timezones get introduced
 * into a value that has none, and the accepted format is exactly the sort of thing the
 * hand-proof runbook is for. If the round-trip shows Acumatica wants something else,
 * this is the one place to change.
 */
export function formatAttributeValue(v) {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return String(v);
  const s = String(v);
  // Salesforce DateTime -> date only. Attributes here are all calendar dates; keeping
  // the time would put a meaningless 00:00:00Z in a reporting field.
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(s);
  return m ? m[1] : s;
}

/**
 * The five lifecycle dates (§7, Q10 resolved). Every source field verified present on
 * Sundial_Solar__c by live describe, 2026-08-22.
 */
export const DATE_ATTRIBUTES = Object.freeze([
  { attributeId: "AUDITDATE", field: "Audit_Date_and_DateTime__c", label: "Audit Date" },
  { attributeId: "INDESIGN", field: "Approved_for_Design_Date__c", label: "In Design Date" },
  { attributeId: "INCOMDATE", field: "Scheduled_Install_Date__c", label: "Install Complete Date" },
  { attributeId: "GREENTAG", field: "Inspection_Pass_Date__c", label: "Green Tag Date" },
  { attributeId: "COMDATE", field: "Commission_of_System__c", label: "Commissioning Date" },
]);

/** Every Salesforce field this module reads, so a caller can SELECT exactly these. */
export function attributeFieldNames() {
  return [
    ...DATE_ATTRIBUTES.map((a) => a.field),
    "System_Size__c",
    "Sales_Company_Harmon_Solar_or_Third__c",
    "Commission_Deal_Type__c",
    "Sales_Rep_Commission_Amt__c",
    "Internal_Rep_Commission_Amt__c",
    "Sales_Mgr_Commission_Amt__c",
    "Overhead_Commission_Amt__c",
  ];
}

/**
 * Build the attribute set for a job.
 *
 * BLANK VALUES ARE OMITTED, NOT SENT AS "". A date that has not happened yet is not the
 * same as a date that was cleared, and writing "" to every unreached milestone would
 * make the sync capable of erasing a value someone entered in Acumatica by hand. The
 * sync only ever moves information in the direction it has some.
 *
 * @param {object} values - Sundial_Solar__c field values
 * @param {{jobType?: string}} [opts] - RS / RSDC, known at Layer-1 push time
 * @returns {{attributes: Array<{AttributeID: string, Value: string}>, omitted: string[], dealType: string}}
 */
export function buildProjectAttributes(values, opts = {}) {
  const out = [];
  const omitted = [];
  const push = (attributeId, raw) => {
    const v = formatAttributeValue(raw);
    if (v === "") omitted.push(attributeId);
    else out.push({ AttributeID: attributeId, Value: v });
  };

  for (const a of DATE_ATTRIBUTES) push(a.attributeId, values?.[a.field]);

  if (opts.jobType) push("JOBTYPE", opts.jobType);
  else omitted.push("JOBTYPE");

  push("KW", values?.System_Size__c);
  push("SALESPERSO", values?.Sales_Company_Harmon_Solar_or_Third__c);

  // --- the six commission milestone attributes ---
  const dealType = String(values?.Commission_Deal_Type__c ?? "").trim();
  const isInternal = dealType === "Internal";

  // The rep pair, and the one place the two rules diverge.
  const repTotal = isInternal
    ? numOf(values?.Internal_Rep_Commission_Amt__c)
    : numOf(values?.Sales_Rep_Commission_Amt__c);
  const rep = isInternal ? split7525(repTotal) : splitRepThirdParty(repTotal);
  if (repTotal > 0) {
    push("SLSCOM1", rep.m1);
    push("SLSCOM2", rep.m2);
  } else {
    omitted.push("SLSCOM1", "SLSCOM2");
  }

  // Manager and overhead are 75/25 regardless of deal type. They are kept as SEPARATE
  // components on the record precisely so this split is possible — the budget's SLMC
  // line sums them (D10), and summing them here too would lose the distinction that
  // MGRCOM and MGMTOR are different attributes.
  for (const [field, a1, a2] of [
    ["Sales_Mgr_Commission_Amt__c", "MGRCOM1", "MGRCOM2"],
    ["Overhead_Commission_Amt__c", "MGMTOR1", "MGMTOR2"],
  ]) {
    const total = numOf(values?.[field]);
    if (total > 0) {
      const s = split7525(total);
      push(a1, s.m1);
      push(a2, s.m2);
    } else {
      omitted.push(a1, a2);
    }
  }

  return { attributes: out, omitted, dealType: dealType || null };
}
