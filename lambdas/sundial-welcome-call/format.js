// Pure value formatting + mapping for the Welcome Call.
//
// Everything in this file is deterministic and side-effect free (the one exception
// is that the clock helpers take an optional Date so tests can pin "now"), which is
// why it is separated out: these values are READ ALOUD TO A CUSTOMER by the Retell
// agent, so they are the part of this Lambda that most needs to be directly testable.
//
// THREE RULES THAT DRIVE EVERY FUNCTION HERE:
//
//  1. Every dynamic variable is a STRING. Retell's template substitution is textual;
//     a number or a null reaches the prompt as something the agent has to guess at.
//  2. A blank source becomes the literal string "not provided". The Retell agent
//     prompt branches on that exact spelling, so it is a contract, not a placeholder.
//     Note that ZERO IS NOT BLANK — a $0 down payment is a real, sayable fact.
//  3. Values are formatted FOR SPEECH, not for a screen. "$142.50 per month" reads
//     correctly out loud; "142.5" does not.

/** The exact string the Retell agent prompt keys off for an absent value. */
export const NOT_PROVIDED = "not provided";

/**
 * Statuses that mean the call is FINISHED and its result is settled.
 *
 * Distinct from the set below, which also contains `Calling` — "a call is in flight"
 * is a reason not to dial again, but it is NOT a settled result. The rep-form backfill
 * needs the settled meaning: it must not overwrite a status a completed call already
 * established, but it SHOULD replace `Calling` or `No Answer` with what actually
 * happened.
 */
export const TERMINAL_STATUSES = new Set([
  "Verified",
  "Verified - Exceptions",
  "Refused",
  "Failed - Max Attempts",
]);

/** Salesforce picklist values that mean "do not place another call". */
export const TERMINAL_OR_IN_FLIGHT_STATUSES = new Set(["Calling", ...TERMINAL_STATUSES]);

/** "2:51" from a duration in milliseconds. Empty when absent or nonsense. */
export function durationMmSs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  const total = Math.round(n / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Attempt ceiling. At or above this, no new call is placed. */
export const MAX_ATTEMPTS = 5;

/** Calling window in America/Phoenix, [start, end) in 24h local hours. */
export const CALL_WINDOW_START_HOUR = 8;
export const CALL_WINDOW_END_HOUR = 20;

// Phoenix does not observe DST, so the abbreviation is MST all year — safe to
// hardcode in the log stamp rather than deriving it per-date.
const PHOENIX_TZ = "America/Phoenix";
const PHOENIX_ABBR = "MST";

// ---------------------------------------------------------------------------
// Blank / value helpers
// ---------------------------------------------------------------------------

/**
 * Is this source value absent? null, undefined and empty/whitespace strings are.
 * 0 and false are NOT — they are answers.
 */
export function isBlank(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (typeof v === "number") return Number.isNaN(v);
  return false;
}

function num(v) {
  if (isBlank(v)) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function group(intPart) {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ---------------------------------------------------------------------------
// Speech formatters — each returns NOT_PROVIDED for a blank/unparseable source
// ---------------------------------------------------------------------------

/**
 * Money: comma-grouped, 2 decimals, with a bare ".00" dropped.
 * "$45,900" reads better out loud than "$45,900.00" ("...and zero cents").
 */
export function money(v) {
  const n = num(v);
  if (n === null) return NOT_PROVIDED;
  const neg = n < 0;
  const abs = Math.abs(n);
  const fixed = abs.toFixed(2);
  const [i, d] = fixed.split(".");
  const body = d === "00" ? group(i) : `${group(i)}.${d}`;
  return `${neg ? "-" : ""}$${body}`;
}

/** Money with a cadence suffix, e.g. "$142.50 per month". */
export function moneyPerMonth(v) {
  const s = money(v);
  return s === NOT_PROVIDED ? NOT_PROVIDED : `${s} per month`;
}

/**
 * A $/kWh RATE, which needs more precision than a dollar amount: at 2 decimals
 * "$0.089 per kilowatt-hour" would collapse to "$0.09" and misstate the contract.
 * Keeps up to 4 decimals, trimming trailing zeros but never below 2.
 */
export function ratePerKwh(v) {
  const n = num(v);
  if (n === null) return NOT_PROVIDED;
  let s = Math.abs(n).toFixed(4).replace(/0+$/, "");
  if (/\.\d?$/.test(s)) s = Math.abs(n).toFixed(2);
  const [i, d] = s.split(".");
  return `${n < 0 ? "-" : ""}$${group(i)}${d ? `.${d}` : ""} per kilowatt-hour`;
}

/** Percent: up to 2 decimals, trailing zeros trimmed. 3.99 -> "3.99%", 4 -> "4%". */
export function percent(v) {
  const n = num(v);
  if (n === null) return NOT_PROVIDED;
  const s = n.toFixed(2).replace(/\.?0+$/, "");
  return `${s}%`;
}

/** Percent with a cadence suffix, e.g. "1.9% per year" (the lease escalator). */
export function percentPerYear(v) {
  const s = percent(v);
  return s === NOT_PROVIDED ? NOT_PROVIDED : `${s} per year`;
}

/** Trim a number to at most `places` decimals, dropping trailing zeros. */
function trimmed(n, places) {
  return n.toFixed(places).replace(/\.?0+$/, "");
}

/** System size in kW, spoken in full: 7.2 -> "7.2 kilowatts". */
export function kilowatts(v) {
  const n = num(v);
  if (n === null) return NOT_PROVIDED;
  const s = trimmed(n, 2);
  const [i, d] = s.split(".");
  return `${group(i)}${d ? `.${d}` : ""} kilowatt${Math.abs(n) === 1 ? "" : "s"}`;
}

/**
 * Annual production. The Salesforce field is named First_Year_kW_Production__c but
 * the VALUE IS kWh — the field label is simply wrong, and the agent must say
 * "kilowatt-hours" or the number is meaningless. Rounded to whole units.
 */
export function kilowattHours(v) {
  const n = num(v);
  if (n === null) return NOT_PROVIDED;
  return `${group(String(Math.round(n)))} kilowatt-hours`;
}

/** Term in years, singular-aware: 25 -> "25 years", 1 -> "1 year". */
export function years(v) {
  const n = num(v);
  if (n === null) return NOT_PROVIDED;
  const whole = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(1)));
  return `${whole} year${Math.abs(n) === 1 ? "" : "s"}`;
}

/** Plain text passthrough (name, email) with the blank rule applied. */
export function text(v) {
  return isBlank(v) ? NOT_PROVIDED : String(v).trim();
}

/**
 * Property address as one spoken line: "123 Main St, Phoenix, AZ 85032".
 * State and postal code are joined by a SPACE (they are one spoken unit); the other
 * parts are comma-joined. Blank parts drop out rather than leaving ", ,".
 */
export function address({ street, city, state, postalCode }) {
  const statePostal = [state, postalCode]
    .filter((p) => !isBlank(p))
    .map((p) => String(p).trim())
    .join(" ");
  const parts = [street, city]
    .filter((p) => !isBlank(p))
    .map((p) => String(p).trim());
  if (statePostal) parts.push(statePostal);
  return parts.length ? parts.join(", ") : NOT_PROVIDED;
}

// ---------------------------------------------------------------------------
// Financing partner -> finance_source
// ---------------------------------------------------------------------------

/**
 * Normalize a picklist value for comparison: trim, collapse internal whitespace,
 * fold every dash variant to a plain hyphen, lowercase.
 *
 * THE DASH FOLD IS NOT COSMETIC. The live org's picklist holds
 * "Participate Prepaid Lease – Cash" with an EN DASH (U+2013) and
 * "Participate Prepaid Lease - Financed" with an ASCII hyphen. A literal comparison
 * matches one and silently misses the other, which would route a real prepaid-lease
 * customer into "unmappable" and skip their call.
 */
export function normalizePartner(v) {
  return String(v ?? "")
    .replace(/[‐-―−]/g, "-") // hyphen/en/em dash, minus sign
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Normalized partner value -> the finance_source token the Retell agent expects. */
const FINANCE_SOURCE_BY_PARTNER = new Map([
  ["lightreach", "Lightreach_lease"],
  ["cash", "cash"],
  ["iccu", "loan"],
  ["credit human", "loan"],
  ["participate prepaid lease - cash", "Participate_prepaid_lease"],
  ["participate prepaid lease - financed", "Participate_prepaid_lease"],
]);

/** The one partner value that means a loan sits behind the prepaid lease. */
const PPL_FINANCED = "participate prepaid lease - financed";

/**
 * Map Financing_Partner__c to finance_source. The partner field ALONE decides this —
 * deliberately not combined with Financing_Type__c, so there is exactly one field to
 * look at when a mapping is wrong.
 *
 * An unrecognized or blank partner returns null. The caller must then SKIP the call
 * and write the reason to the log: reading the wrong financial terms to a customer is
 * far worse than not calling them, and a skipped call with a stated reason is a
 * data-quality task a human can close.
 *
 * @returns {{ financeSource: string, wasALoanUsed: "Yes"|"No" }|null}
 */
export function mapFinanceSource(financingPartner) {
  const key = normalizePartner(financingPartner);
  const financeSource = FINANCE_SOURCE_BY_PARTNER.get(key);
  if (!financeSource) return null;
  return { financeSource, wasALoanUsed: key === PPL_FINANCED ? "Yes" : "No" };
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

/**
 * Parse a US phone number to E.164, or null if it isn't one.
 *
 * Strict on purpose: this number gets DIALED. A wrong-but-plausible number reaches a
 * stranger and reads them somebody else's contract terms, so anything ambiguous
 * (short, long, an extension appended, an invalid NANP prefix) is rejected and the
 * call is skipped for a human to fix.
 *
 * @returns {string|null} e.g. "+16025551234"
 */
export function toE164US(raw) {
  if (isBlank(raw)) return null;
  const digits = String(raw).replace(/\D/g, "");
  let ten;
  if (digits.length === 10) ten = digits;
  else if (digits.length === 11 && digits[0] === "1") ten = digits.slice(1);
  else return null; // too short, too long, or an extension we won't guess at

  // NANP: area code and exchange code both start 2-9. This rejects the common
  // placeholder junk ("0000000000", "1111111111") that would otherwise dial out.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null;
  return `+1${ten}`;
}

// ---------------------------------------------------------------------------
// Phoenix clock
// ---------------------------------------------------------------------------

function phoenixParts(date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: PHOENIX_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23", // so midnight is "00", not "24"
  });
  const out = {};
  for (const { type, value } of fmt.formatToParts(date)) out[type] = value;
  return out;
}

/** Local hour (0-23) in America/Phoenix. */
export function phoenixHour(date = new Date()) {
  return Number(phoenixParts(date).hour);
}

/** Is `date` inside the 08:00-20:00 Phoenix calling window? End is exclusive. */
export function isWithinCallWindow(date = new Date()) {
  const h = phoenixHour(date);
  return h >= CALL_WINDOW_START_HOUR && h < CALL_WINDOW_END_HOUR;
}

/** Log-line timestamp: "2026-08-17 14:32 MST". */
export function phoenixStamp(date = new Date()) {
  const p = phoenixParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${PHOENIX_ABBR}`;
}

/**
 * Date only, "2026-08-17", in America/Phoenix.
 *
 * Used in recording FILENAMES, which is why it must be Phoenix and not UTC: a call
 * placed at 6pm Phoenix is already "tomorrow" in UTC, so a UTC-named file would sit
 * in the Files tab under a date the office never dialed on.
 */
export function phoenixDate(date = new Date()) {
  const p = phoenixParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

// ---------------------------------------------------------------------------
// Dynamic variables
// ---------------------------------------------------------------------------

/**
 * Build retell_llm_dynamic_variables from a Salesforce customer record.
 *
 * `get(logicalName)` is supplied by the caller and already resolves the
 * describe-guarded field-name candidates (see fields.js), so a field the org does
 * not have simply yields undefined here and formats to "not provided" — no branch,
 * no crash, no missing key.
 *
 * There is deliberately NO rep_name variable.
 *
 * @param {(logical: string) => any} get
 * @param {{ financeSource: string, wasALoanUsed: string }} finance
 * @returns {Record<string,string>} every value a string
 */
export function buildDynamicVariables(get, finance) {
  return {
    customer_name: text(get("name")),
    property_address: address({
      street: get("street"),
      city: get("city"),
      state: get("state"),
      postalCode: get("postalCode"),
    }),
    customer_email: text(get("email")),

    system_size: kilowatts(get("systemSizeKw")),
    // Field is named ..._kW_Production__c but carries kWh — see kilowattHours().
    estimated_production: kilowattHours(get("firstYearProduction")),

    finance_source: finance.financeSource,

    monthly_payment: moneyPerMonth(get("monthlyPayment")),
    energy_rate: ratePerKwh(get("energyRate")),
    escalator: percentPerYear(get("escalator")),

    total_price: money(get("contractAmount")),
    amount_due_signing: money(get("downPaymentAmount")),
    amount_due_design: money(get("dueAtAuditAmount")),
    amount_due_install: money(get("dueAtGreentagAmount")),

    // loan_amount intentionally reads the SAME source as total_price: for a financed
    // deal the amount financed IS the contract amount. Two variable names, one fact,
    // because the agent prompt uses them in different scripts.
    loan_amount: money(get("contractAmount")),
    loan_term: years(get("loanTermYears")),
    interest_rate: percent(get("apr")),

    prepaid_lease_amount: money(get("prepaidLeaseAmount")),
    was_a_loan_used: finance.wasALoanUsed,
    ppl_loan_payment: moneyPerMonth(get("monthlyPayment")),
    ppl_loan_interest_rate: percent(get("apr")),
    ppl_loan_term: years(get("loanTermYears")),
  };
}
