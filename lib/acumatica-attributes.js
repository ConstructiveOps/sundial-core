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
 * Decimal places per attribute — Harmon's existing convention, not ours (Q17).
 *
 * Attributes are STRING-valued and Acumatica stores exactly what it is given, so
 * `String(2500)` really does land in the reporting field as `2500` next to a
 * hand-entered `1538.00`. That is a formatting difference, not a rounding one, and the
 * live data is unambiguous about which format Harmon uses: every money attribute already
 * in Acumatica carries two decimals (`1538.00`, `250.80`, `94.05`) and KW carries three
 * (`8.360`). Verified on R261065, 2026-08-24; Harmon ruled the same day that we match it.
 *
 * Anything absent from this map is not a number — dates, JOBTYPE, SALESPERSO — and is
 * passed through untouched.
 */
export const ATTRIBUTE_DECIMALS = Object.freeze({
  SLSCOM1: 2, SLSCOM2: 2,
  MGRCOM1: 2, MGRCOM2: 2,
  MGMTOR1: 2, MGMTOR2: 2,
  KW: 3,
});

/**
 * Format a value for an Acumatica attribute, which is always a STRING.
 *
 * Dates pass through as the ISO date Salesforce already returns (`2026-07-14`) rather
 * than being reformatted. Two reasons: reformatting is where timezones get introduced
 * into a value that has none, and the accepted format is exactly the sort of thing the
 * hand-proof runbook is for. **The 2026-08-24 hand-proof confirmed Acumatica accepts it
 * as sent**, so this stays.
 *
 * `decimals` pads a numeric value to a fixed width (see ATTRIBUTE_DECIMALS). It is only
 * applied to something that actually parses as a number — a text attribute that somehow
 * arrived with a decimals rule set would be passed through rather than turned into `NaN`.
 *
 * @param {unknown} v
 * @param {number} [decimals] - fixed decimal places, for numeric attributes only
 */
export function formatAttributeValue(v, decimals) {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);

  if (Number.isInteger(decimals)) {
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (Number.isFinite(n)) return n.toFixed(decimals);
    // Fall through: not a number, so padding is meaningless and NaN would be worse.
  }

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
    const v = formatAttributeValue(raw, ATTRIBUTE_DECIMALS[attributeId]);
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

// ===========================================================================
// Verify by re-read — required, not optional (D24)
// ===========================================================================

/**
 * ⚠️ THE STANDING HAZARD THIS EXISTS FOR: an unknown `AttributeID` gets a **200 and is
 * silently discarded.**
 *
 * Proved on 2026-08-24 — `NOTAREALATTR` was accepted and never appeared. Nothing in the
 * response distinguishes "written" from "thrown away", so if a template change ever drops
 * an attribute, the sync keeps sending it, keeps getting 200, and that value silently
 * stops updating. A status code is not evidence that a write happened; only a re-read is.
 *
 * The same run also proved a PUT can CREATE an attribute the project does not yet carry —
 * but only where the project's template defines it. So "absent from the read-back" means
 * "the template does not define it here", which is exactly the case worth reporting.
 */

/** `2026-07-14T00:00:00+00:00` / `2026-07-14 00:00:00.000` / `2026-07-14` -> `2026-07-14`. */
export function attributeDatePart(v) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? "").trim());
  return m ? m[1] : null;
}

/**
 * Compare one sent value against what came back.
 *
 * DATES ARE COMPARED BY DATE PART, and that is load-bearing rather than lenient. We send
 * `2026-07-14`; Acumatica echoes `2026-07-14 00:00:00.000`. A string comparison would
 * report every single date attribute as a failed write, every run — which is worse than
 * no verification at all, because a check that always cries wolf gets switched off.
 *
 * Everything else compares as a trimmed string, because that is what an attribute is.
 */
export function attributeValueMatches(sent, got) {
  const a = String(sent ?? "").trim();
  const b = String(got ?? "").trim();
  if (a === b) return true;
  const da = attributeDatePart(a);
  const db = attributeDatePart(b);
  return da !== null && da === db;
}

/**
 * Check a completed attribute PUT against a fresh read of the project.
 *
 * @param {Array<{AttributeID: string, Value: string}>} sent - what buildProjectAttributes produced
 * @param {Array<object>} readBack - the `Attributes` array from a re-read (raw Acumatica shape)
 * @returns {{ok: boolean, missing: string[], mismatched: Array<{attributeId, sent, got}>}}
 *   missing    - accepted with a 200 and then discarded; the template does not define it
 *   mismatched - present but holding something else
 */
export function verifyAttributeWrite(sent, readBack) {
  const got = new Map(
    (Array.isArray(readBack) ? readBack : []).map((a) => [
      String(a?.AttributeID?.value ?? a?.AttributeID ?? ""),
      a?.Value?.value ?? a?.Value,
    ])
  );

  const missing = [];
  const mismatched = [];
  for (const { AttributeID, Value } of sent ?? []) {
    if (!got.has(AttributeID)) {
      missing.push(AttributeID);
      continue;
    }
    const back = got.get(AttributeID);
    if (!attributeValueMatches(Value, back)) {
      mismatched.push({ attributeId: AttributeID, sent: Value, got: back ?? null });
    }
  }
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
}
