// Aurora → Salesforce field mapping + agreement status precedence.
//
// Pure functions only: no network, no AWS, no Salesforce. Everything the worker
// decides about VALUES lives here so it can be tested directly.
//
// Sources: the confirmed financing mapping (2026-07-23), the design-results
// mapping (approved 2026-08-03), and the lease/PPA financing fields (2026-08-17),
// all recorded in docs/integrations/aurora-api-reference.md and DECISIONS.md D-048.
//
// Every field this module emits passes through the worker's describe guard before
// it reaches a PATCH (index.js » filterToExisting), so naming a field the org does
// not have costs a line in the notification email, never a failed write-back.

// Harmon is Phoenix (no DST). Contract_Signed_Date__c / Sold_Date__c are DATE
// fields, so the calendar date must be derived in LOCAL time — a signature at
// 18:00 MST is 01:00 UTC the NEXT day, and a UTC-derived date would file the
// contract a day late.
export const BUSINESS_TIME_ZONE = "America/Phoenix";

// --- agreement status precedence -------------------------------------------
// Aurora states plainly that duplicates are possible and ORDERING IS NOT
// GUARANTEED — a `signed` can arrive before a `viewed`. Ranking the statuses lets
// a late low-rank event be ignored instead of regressing the record.
//
// The rank alone cannot tell a genuine post-signature CANCELLATION from an
// out-of-order delivery, because nothing in Aurora's contract carries a status
// timestamp. That gap is closed outside this table: for the negative terminal
// statuses below, the worker RE-READS the agreement from Aurora and uses its
// current status as the authority (D-048 follow-up, 2026-08-04). Precedence is
// still what governs every other status, and still what rejects a confirmed-stale
// event. `error` is deliberately NOT in that set — it is a delivery/processing
// fault, not a statement that the contract is dead, so it stays rank-governed.
export const STATUS_RANK = {
  sent: 1,
  viewed: 2,
  "cancel-pending": 3,
  declined: 4,
  canceled: 4,
  error: 4,
  signed: 5,
};

/**
 * Statuses that assert "this contract is dead". A late one of these against a
 * recorded `signed` is the ambiguous case, so the worker confirms it with Aurora
 * instead of trusting (or discarding) delivery order.
 */
export const NEGATIVE_TERMINAL_STATUSES = new Set([
  "canceled",
  "cancel-pending",
  "declined",
]);

/** Normalize a status to the hyphenated lowercase form used as the canonical value. */
export function normalizeStatus(status) {
  return String(status ?? "").trim().toLowerCase().replace(/_/g, "-");
}

export function statusRank(status) {
  return STATUS_RANK[normalizeStatus(status)] ?? 0;
}

/**
 * Should an incoming status replace what's on the record?
 *
 * @param {string|null} currentStatus - Aurora_Agreement_Status__c today
 * @param {string|null} currentAgreementId - Aurora_Agreement_ID__c today
 * @param {string} incomingStatus
 * @param {string} incomingAgreementId
 * @returns {{ apply: boolean, reason: string }}
 */
export function shouldApplyStatus(
  currentStatus,
  currentAgreementId,
  incomingStatus,
  incomingAgreementId
) {
  const incoming = normalizeStatus(incomingStatus);
  const current = normalizeStatus(currentStatus);

  // A different agreement supersedes whatever the old one said — its lifecycle is
  // unrelated (e.g. the first was voided and a replacement was sent).
  if (currentAgreementId && incomingAgreementId && currentAgreementId !== incomingAgreementId) {
    return { apply: true, reason: "different_agreement" };
  }
  if (!current) return { apply: true, reason: "no_current_status" };
  if (current === incoming) return { apply: false, reason: "duplicate" };

  const rank = statusRank(incoming);
  const currentRankValue = statusRank(current);
  if (rank > currentRankValue) return { apply: true, reason: "advances" };
  return { apply: false, reason: "out_of_order" };
}

// --- picklist mapping -------------------------------------------------------

// Aurora financing_option -> the org's Financing_Type__c picklist (Cash|Loan|Lease).
// ppa / levelized_ppa have NO reasonable match in this picklist; they are reported
// as unmappable rather than guessed into "Lease" (a PPA is not a lease, and a wrong
// contract type flows into reporting and commissions).
const FINANCING_TYPE_MAP = {
  cash: "Cash",
  loans: "Loan",
  loan: "Loan",
  lease: "Lease",
};

/** @returns {{ value: string|null, warning: string|null }} */
export function mapFinancingType(financingOption) {
  const key = String(financingOption ?? "").trim().toLowerCase();
  if (!key) return { value: null, warning: null };
  const value = FINANCING_TYPE_MAP[key] ?? null;
  return {
    value,
    warning: value
      ? null
      : `Aurora financing_option "${financingOption}" has no match in the Financing_Type__c picklist (Cash|Loan|Lease) — left unset for manual review.`,
  };
}

/**
 * Aurora financier.provider -> Financing_Partner__c, matched case/punctuation-
 * insensitively against the org's ACTUAL picklist values (passed in from the
 * describe, so a newly-added partner works with no code change).
 *
 * Deliberately does NOT fall back to "Other": that would erase which lender it
 * actually was. Unmatched values are reported and left unset.
 */
export function mapFinancingPartner(provider, picklistValues = []) {
  const raw = String(provider ?? "").trim();
  if (!raw) return { value: null, warning: null };
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(raw);
  const hit = picklistValues.find((v) => norm(v) === target);
  return {
    value: hit ?? null,
    warning: hit
      ? null
      : `Aurora financier.provider "${raw}" has no match in the Financing_Partner__c picklist — left unset for manual review.`,
  };
}

// --- numeric helpers --------------------------------------------------------

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n) => Math.round(n * 100) / 100;

/** YYYY-MM-DD in Harmon's local time (for Salesforce DATE fields). */
export function localDateString(isoOrDate, timeZone = BUSINESS_TIME_ZONE) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA formats as YYYY-MM-DD, which is exactly Salesforce's DATE literal.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Total module count from the design's bill of materials. */
export function panelCountFromBom(bom) {
  if (!Array.isArray(bom)) return null;
  const modules = bom.filter(
    (i) => String(i?.component_type ?? "").toLowerCase() === "modules"
  );
  if (modules.length === 0) return null;
  return modules.reduce((sum, i) => sum + (num(i?.quantity) ?? 0), 0);
}

/**
 * Build the Salesforce field map for a SIGNED agreement.
 *
 * Every value is optional: whatever Aurora didn't give us is simply absent from
 * the returned map (never written as null), so a partial Aurora response can't
 * blank out good data already on the record.
 *
 * @param {object} args
 * @param {object|null} args.design    - design summary
 * @param {object|null} args.financing - financing (null when FINANCING_ID was empty)
 * @param {object|null} args.proposal  - default proposal
 * @param {string} args.receivedAt     - ISO time the webhook was received
 * @param {string[]} [args.partnerPicklistValues] - live Financing_Partner__c values
 * @returns {{ fields: object, warnings: string[] }}
 */
export function buildSignedFieldMap({
  design,
  financing,
  proposal,
  receivedAt,
  partnerPicklistValues = [],
}) {
  const fields = {};
  const warnings = [];
  const set = (name, value) => {
    if (value !== null && value !== undefined) fields[name] = value;
  };

  // --- design results ------------------------------------------------------
  // system_size_stc is WATTS (Aurora's unit); the SF field is kW.
  const sizeStcW = num(design?.system_size_stc);
  if (sizeStcW !== null) set("Final_System_Size_kW__c", round2(sizeStcW / 1000));

  set("Final_Panel_Count__c", panelCountFromBom(design?.bill_of_materials));

  // energy_production is only present once a performance simulation has run.
  // NOTE: the SF field is LABELED "kW" but holds Aurora's annual kWh figure —
  // documented in docs/salesforce-schema.md; the label is the thing that's wrong.
  const annualKwh = num(design?.energy_production?.annual);
  if (annualKwh === null && design && !design?.energy_production) {
    warnings.push(
      "Design has no energy_production (no performance simulation has run) — First_Year_kW_Production__c left unset."
    );
  }
  set("First_Year_kW_Production__c", annualKwh);

  // --- signing dates -------------------------------------------------------
  // The agreement object carries NO signed_at, and the webhook carries no
  // timestamp, so WEBHOOK RECEIPT TIME is the signing timestamp of record.
  const signedDate = localDateString(receivedAt);
  set("Contract_Signed_Date__c", signedDate);
  set("Sold_Date__c", signedDate);

  // --- proposal link (new field; written only if the org has it) -----------
  set("Aurora_Proposal_Link__c", proposal?.proposal_link ?? null);

  // --- financing -----------------------------------------------------------
  if (!financing) {
    return { fields, warnings };
  }

  const systemPrice = num(financing.system_price);
  set("Proposal_Amount__c", systemPrice);

  // Contract PPW needs BOTH the price and the STC size, and a non-zero size.
  if (systemPrice !== null && sizeStcW !== null && sizeStcW > 0) {
    set("Contract_Price_Per_Watt__c", round2(systemPrice / sizeStcW));
  }

  const option = String(financing.financing_option ?? "").trim().toLowerCase();
  const typeMap = mapFinancingType(option);
  set("Financing_Type__c", typeMap.value);
  if (typeMap.warning) warnings.push(typeMap.warning);

  // financier is nullable — only map a partner when Aurora actually gave one.
  if (financing.financier) {
    const partnerMap = mapFinancingPartner(
      financing.financier.provider,
      partnerPicklistValues
    );
    set("Financing_Partner__c", partnerMap.value);
    if (partnerMap.warning) warnings.push(partnerMap.warning);
  }

  const isLoan = option === "loans" || option === "loan";
  if (isLoan) {
    set("Down_Payment_Amount__c", num(financing.down_payment));
    set("Monthly_Payment__c", num(financing.monthly_payment_first_month));
    const months = num(financing.loans?.[0]?.duration_months);
    if (months !== null && months > 0) set("Loan_Term_Years__c", round2(months / 12));
  } else {
    // lease / ppa / levelized_ppa. monthly_payment, solar_rate, escalation and
    // upfront_payment are LEASE/PPA-ONLY in Aurora's response, so they are read
    // here and never on the loan branch — and `set` already skips anything absent,
    // which is what keeps a cash financing from writing any of them.
    set("Monthly_Payment__c", num(financing.monthly_payment));

    // The customer's energy rate in $/kWh — the price they pay for solar power.
    // NOT Solar_Price_per_Watt__c: that is contract amount ÷ system watts, a
    // different metric entirely (and one this pipeline writes as
    // Contract_Price_Per_Watt__c above). Confusing the two would put a ~$3 figure
    // in a ~$0.14 field.
    set("Energy_Rate__c", num(financing.solar_rate));

    // Annual escalation on that rate.
    const escalation = num(financing.escalation);
    set("Escalator__c", escalation);
    // UNIT UNVERIFIED. Escalator__c is a Salesforce PERCENT field, which stores the
    // percentage value itself (2.9 means 2.9%). Aurora's docs don't state whether
    // `escalation` is a percentage (2.9) or a fraction (0.029), and Aurora is
    // demonstrably inconsistent about this — `energy_production.annual_offset`
    // comes back as the STRING "87%". We pass the number through unconverted
    // rather than guess at a ×100, and flag the ambiguous case so a fraction can't
    // land silently as ~0%. Escalations are realistically 1-5%, so a value below 1
    // is the tell. Delete this warning once a real lease/PPA payload settles it
    // (TASKS.md).
    if (escalation !== null && escalation > 0 && escalation < 1) {
      warnings.push(
        `Aurora sent escalation = ${escalation}, which looks like a fraction rather than a percentage. ` +
          `Escalator__c is a percent field, so it now reads ${escalation}% — verify against the signed ` +
          `proposal; if Aurora reports fractions, this value needs multiplying by 100.`
      );
    }

    // DELIBERATELY NOT MAPPED: `upfront_payment`. Aurora documents it only as a
    // lease/PPA field with no definition. The plausible readings — a prepayment
    // that buys down the monthly, vs. a fee due at signing — belong in different
    // Salesforce fields and mean different things to finance.
    // Down_Payment_Amount__c is the tempting target and is the wrong one if this
    // is a prepayment. Left unmapped until a real Participate payload proves its
    // meaning — see TASKS.md.
  }

  // A stale financial simulation means these numbers may not match what the
  // customer signed — worth saying out loud rather than writing silently.
  if (financing.up_to_date === false) {
    warnings.push(
      "Aurora reports financing.up_to_date = false — the financial simulation is stale, so the written amounts may not match the signed proposal."
    );
  }

  return { fields, warnings };
}
