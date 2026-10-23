// The dealer-terms rule (D-085 amendment 1, 2026-10-22) — ONE answer to "whose terms
// does this deal run on", used by every Lambda that needs internal/external, the PO
// vendor, or the selling company's name.
//
//   1. Dealer__c set                      -> source "dealer": the flag, the vendor and the
//                                            name all come from the dealer row.
//   2. else cutover date < 2026-09-04     -> source "legacy": the sales-company picklist,
//                                            exactly as before D-085.
//   3. else                               -> refusal DEALER_MISSING.
//
// The cutover date is the CUSTOMER's CreatedDate when the record is linked to one
// (Sundial_Solar__c → Sundial_Customer__c), otherwise the record's own — the same anchor
// the v9 redline formulas use, so the redline and everything routed here agree on which
// side of the line a deal is. Compared as the GMT date, because the formula's
// DATEVALUE(CreatedDate) is the GMT date.
//
// ⚠️ A post-cutover record NEVER reads the picklist — not as a fallback when the dealer is
// missing. That is the whole point of rule 3: a deal sold after 9/4 with no dealer has no
// terms, and guessing them from a string is how the dead Invictus branch happened.
//
// ⚠️ Rule 1 does not look at the date. A PRE-cutover record with a dealer takes the
// dealer's flag and vendor, while its redline formula still reads the picklist (v9 keeps
// pre-9/4 redlines exactly as they were). The two agree on every calculated record;
// 6 uncalculated Solar records disagreed on 2026-10-22 (PROGRESS.md).
//
// Pure: no I/O. The caller SELECTs dealerTermsFieldNames(object) and passes the row.

/** The cutover, as a GMT date string — compared lexically against `YYYY-MM-DD`. */
export const DEALER_TERMS_CUTOVER = "2026-09-04";

/** The one legacy value that means INTERNAL (D19). Case-insensitive, like the formula. */
export const LEGACY_INTERNAL_SALES_COMPANY = "Harmon Solar";

/** The legacy sales-company picklist on each object (D19). */
export const LEGACY_SALES_COMPANY_FIELDS = Object.freeze({
  Sundial_Solar__c: "Sales_Company_Harmon_Solar_or_Third__c",
  Sundial_Customer__c: "Sales_Company__c",
});

/** Objects whose cutover date is their Customer's, not their own. */
const CUSTOMER_LINKED = new Set(["Sundial_Solar__c"]);

/**
 * Every field the rule reads on `object`, for the caller's SELECT. A field missing from
 * the SELECT would read as "no dealer" / "no date", so this list is the only safe source.
 */
export function dealerTermsFieldNames(object = "Sundial_Solar__c") {
  const legacy = LEGACY_SALES_COMPANY_FIELDS[object];
  if (!legacy) throw new Error(`dealer-terms: no legacy sales-company field known for ${object}`);
  return [
    "Dealer__c",
    "Dealer__r.Name",
    "Dealer__r.Is_Internal__c",
    "Dealer__r.Acumatica_Vendor_ID__c",
    "CreatedDate",
    ...(CUSTOMER_LINKED.has(object) ? ["Sundial_Customer__c", "Sundial_Customer__r.CreatedDate"] : []),
    legacy,
  ];
}

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

/**
 * Read `a.b` off a SOQL row, nested (`{ Dealer__r: { Name } }`, what REST returns) or
 * flat (`{ "Dealer__r.Name": … }`, what some fixtures and tools produce).
 */
function rel(rec, relName, field) {
  const nested = rec?.[relName];
  if (nested && typeof nested === "object" && field in nested) return nested[field];
  const flat = `${relName}.${field}`;
  return rec && flat in rec ? rec[flat] : undefined;
}

/** `2026-09-03T23:30:00.000+0000` → `2026-09-03` (GMT), or null when unparseable. */
export function gmtDate(v) {
  const s = str(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Salesforce writes `+0000`; Date.parse wants `+00:00`.
  const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/**
 * Apply the rule to one record.
 *
 * @param {object} rec - a row carrying dealerTermsFieldNames(object)
 * @param {{object?: string, recordLabel?: string}} [opts]
 * @returns {{ok: true, source: "dealer", dealerId, dealerName, salesCompanyName, isInternal, vendorId, cutoverDate}
 *          |{ok: true, source: "legacy", salesCompany, salesCompanyName, isInternal, vendorId: null, cutoverDate}
 *          |{ok: false, code: "DEALER_MISSING"|"DEALER_TERMS_UNAVAILABLE", message, cutoverDate}}
 *   Never throws. A legacy record with a BLANK picklist is still `ok` (salesCompany "")
 *   — each caller keeps its own blank-company refusal (SALES_COMPANY_MISSING, vendor_blank).
 */
export function resolveDealerTerms(rec, opts = {}) {
  const object = opts.object ?? "Sundial_Solar__c";
  const label = opts.recordLabel ?? (str(rec?.Name) || str(rec?.Id) || "this record");
  const legacyField = LEGACY_SALES_COMPANY_FIELDS[object];

  const dealerId = str(rec?.Dealer__c);
  if (dealerId) {
    const dealerName = str(rel(rec, "Dealer__r", "Name"));
    // A dealer id with no readable row means the SELECT left the relationship out or the
    // integration user cannot read the dealer — never "external with no vendor".
    if (!dealerName) {
      return {
        ok: false, code: "DEALER_TERMS_UNAVAILABLE", cutoverDate: null,
        message:
          `${label} has Dealer__c ${dealerId} but its dealer's Name / Is_Internal__c could not be ` +
          "read. Check that the query selects dealerTermsFieldNames() and that the integration " +
          "user can read Sundial_Dealer__c.",
      };
    }
    return {
      ok: true, source: "dealer", dealerId, dealerName,
      salesCompanyName: dealerName,
      isInternal: rel(rec, "Dealer__r", "Is_Internal__c") === true,
      vendorId: str(rel(rec, "Dealer__r", "Acumatica_Vendor_ID__c")) || null,
      cutoverDate: null,
    };
  }

  const linked = CUSTOMER_LINKED.has(object) &&
    (str(rec?.Sundial_Customer__c) !== "" || (rec?.Sundial_Customer__r && typeof rec.Sundial_Customer__r === "object"));
  const rawDate = linked ? rel(rec, "Sundial_Customer__r", "CreatedDate") : rec?.CreatedDate;
  const cutoverDate = gmtDate(rawDate);
  if (!cutoverDate) {
    // Not "legacy by default": an unreadable date on a post-cutover deal would quietly
    // read the picklist, which is the one thing this rule exists to stop.
    return {
      ok: false, code: "DEALER_TERMS_UNAVAILABLE", cutoverDate: null,
      message:
        `${label} has no dealer and its ${linked ? "Customer's " : ""}CreatedDate could not be read, ` +
        "so it cannot be placed either side of the 2026-09-04 cutover. Check that the query " +
        "selects dealerTermsFieldNames().",
    };
  }

  if (cutoverDate < DEALER_TERMS_CUTOVER) {
    const salesCompany = str(rec?.[legacyField]);
    return {
      ok: true, source: "legacy", salesCompany,
      salesCompanyName: salesCompany || null,
      isInternal: salesCompany.toLowerCase() === LEGACY_INTERNAL_SALES_COMPANY.toLowerCase(),
      vendorId: null,
      cutoverDate,
    };
  }

  return {
    ok: false, code: "DEALER_MISSING", cutoverDate,
    message:
      `${label} has no dealer (Dealer__c is blank) and was created on ${cutoverDate}, after the ` +
      `${DEALER_TERMS_CUTOVER} cutover, so it has no commercial terms — internal/external, redline ` +
      "and PO vendor all come from the dealer. Set the Sales Rep on the " +
      `${linked ? "customer and the project" : "record"} (the dealer is derived from the rep), then retry.`,
  };
}
