// lib/dealer-journey.js — where a deal is on the ONE path a dealer or rep sees.
//
// The dealer shell (dealer module, step 3 of 9) shows each customer as a single journey:
// the sales funnel on Sundial_Customer__c (New … Sold - Pending Review), then the install
// on Sundial_Solar__c (Audit … Billing Complete - Pending Closeout). The two objects keep
// their own Stage__c picklists; this module is the only place that lays them end to end.
//
// THE RULE (decided with the plan, D-086's "solar is seen through its customer"):
//   - The Solar stage LEADS when the customer has a solar project. Its customer stage is
//     then never consulted — which is what "Sold - Final Review / Sold / Sold - Installed /
//     Sold - Archived are ignored when a solar exists" means in practice.
//   - Otherwise the Customer stage.
//   - A value on the path is that step. A value in OFF_PATH is drawn as a flag: anchored
//     to a named step, or to "current" — where the deal is (see FLOOR below). A value in
//     neither list is an `info` flag, logged once per cold start so a new picklist value
//     shows up in CloudWatch instead of silently in the wrong place.
//
// FLOOR: the step a deal is drawn at when its stage does not name one ("current" anchors,
// unknown values, a blank stage). We keep no stage history, so the most we can honestly
// say is which half of the journey the deal is in: a deal with a solar is at least at the
// first install step (Audit); one without is at least at New. `stage` is null in those
// cases — the deal is not ON a step — and a stage filter never matches it.
//
// The SQL side of the same rule is sql/sundial_dealer_customer_view.sql (which solar leads)
// and stageFilterValues() below (which values a step's filter matches). Both are pinned by
// lib/dealer-journey.test.js.
//
// Pure: no I/O, no secrets. The one console.warn names a picklist value, never a record.

const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const step = (object) => (value) => Object.freeze({ key: slug(value), object, value });

const CUSTOMER_PATH = [
  "New",
  "Contact Attempt Made",
  "Appointment Set",
  "Proposal Pending",
  "Proposal Complete",
  "Verbal Yes",
  "Waiting On Documents",
  "Processing Documents",
  "Sold - Pending Review",
].map(step("customer"));

const SOLAR_PATH = [
  "Audit",
  "Audit Photos Received",
  "Design Ordered",
  "Design Received",
  "PM Review",
  "Sent HO Design",
  "Permitting",
  "Permit Submitted",
  "Permitting Received",
  "Interconnection",
  "Interconnection Submitted",
  "Scheduling",
  "Install Scheduled",
  "Post Installation",
  "Inspection Scheduled",
  "Inspection Completed",
  "Green Tagged",
  "Billing",
  "Billing Complete - Pending Closeout",
].map(step("solar"));

/** The journey, in order: {key, object: 'customer'|'solar', value}. */
export const JOURNEY = Object.freeze([...CUSTOMER_PATH, ...SOLAR_PATH]);

/** Where an off-path flag is drawn when it names no step. */
export const CURRENT = "current";

const off = (anchor, tone) => Object.freeze({ anchor, tone });
const group = (values, entry) => Object.fromEntries(values.map((v) => [v, entry]));

/**
 * Off-path value → { anchor, tone }. `anchor` is a JOURNEY value, or CURRENT.
 * tone: info (a normal detour), warn (needs something), stop (the deal has ended).
 */
export const OFF_PATH = Object.freeze({
  ...group(["Follow Up", "Reschedule Needed", "Rescheduled Appointment", "10 Day Revive", "Reset"], off("Appointment Set", "info")),
  Hold: off(CURRENT, "warn"),
  ...group(
    ["Not Interested", "DNQ", "Wants for Free", "Closed Lost", "Cancelled", "Cancelled - Awaiting Sales to Resell"],
    off(CURRENT, "stop")
  ),
  // Only ever read when there is no solar: with one, the solar stage leads (header).
  ...group(["Sold - Final Review", "Sold", "Sold - Installed", "Sold - Archived"], off("Sold - Pending Review", "info")),
  "Site survey scheduled": off("Audit", "info"),
  "Utility Input": off("Design Ordered", "info"),
  "Re-Roof Needed": off("Design Received", "warn"),
  "HOA Pending": off("Sent HO Design", "warn"),
  ...group(["Post Install/Pending MPU", "Post Install/Pending BUS/MSA"], off("Post Installation", "warn")),
  ...group(["Go Back Items Needed", "Go Back Items Complete", "Awaiting Bird Blocking"], off("Inspection Completed", "warn")),
  ...group(["Request to Archive", "Archive"], off("Billing Complete - Pending Closeout", "info")),
});

const INDEX_BY_VALUE = new Map(JOURNEY.map((s, i) => [s.value, i]));
const INDEX_BY_KEY = new Map(JOURNEY.map((s, i) => [s.key, i]));
const SOLAR_FLOOR = INDEX_BY_VALUE.get(SOLAR_PATH[0].value);
const CUSTOMER_FLOOR = 0;

const nonBlank = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

// Unknown values already logged by this container. Once per value per cold start: the
// list endpoint computes a journey per row, and one new picklist value would otherwise
// write a line per row per request.
const loggedUnknown = new Set();

/**
 * Where this deal sits on the journey.
 *
 * @param {string|null} customerStage  Sundial_Customer__c.Stage__c, as the caller may see it
 * @param {string|null} solarStage     the leading Sundial_Solar__c's Stage__c, or null
 * @param {{hasSolar?: boolean}} [opts] whether the customer HAS a solar project. Defaults to
 *   "solarStage is not blank"; pass it explicitly whenever you know, because a solar with a
 *   blank stage still leads (it is an install that has not been staged), and only the
 *   caller can tell that apart from "no solar".
 * @returns {{ stage: string|null, source: 'customer'|'solar', index: number,
 *             offPath: { value: string, anchor: string|null, tone: 'info'|'warn'|'stop' } | null }}
 *   stage   the JOURNEY key the deal is on, or null when it is not on a step (FLOOR)
 *   index   the JOURNEY index it is drawn at (always a number)
 *   offPath the flag, when the value is not a step: `anchor` is the key of the step it
 *           belongs to, or null when it is drawn at the deal's floor
 */
export function journeyFor(customerStage, solarStage, opts = {}) {
  const solar = nonBlank(solarStage);
  const hasSolar = typeof opts.hasSolar === "boolean" ? opts.hasSolar || solar !== null : solar !== null;
  const source = hasSolar ? "solar" : "customer";
  const value = hasSolar ? solar : nonBlank(customerStage);
  const floor = hasSolar ? SOLAR_FLOOR : CUSTOMER_FLOOR;

  if (value === null) return { stage: null, source, index: floor, offPath: null };

  if (INDEX_BY_VALUE.has(value)) {
    const index = INDEX_BY_VALUE.get(value);
    return { stage: JOURNEY[index].key, source, index, offPath: null };
  }

  const known = Object.hasOwn(OFF_PATH, value) ? OFF_PATH[value] : null;
  if (known && known.anchor !== CURRENT) {
    const index = INDEX_BY_VALUE.get(known.anchor);
    const key = JOURNEY[index].key;
    return { stage: key, source, index, offPath: { value, anchor: key, tone: known.tone } };
  }
  if (known) {
    return { stage: null, source, index: floor, offPath: { value, anchor: null, tone: known.tone } };
  }

  if (!loggedUnknown.has(value)) {
    loggedUnknown.add(value);
    console.warn(`dealer-journey: unknown ${source} stage "${value}" — drawn as info at the ${source} floor; add it to JOURNEY or OFF_PATH`);
  }
  return { stage: null, source, index: floor, offPath: { value, anchor: null, tone: "info" } };
}

/** The JOURNEY step for a key, or null. */
export function journeyStep(key) {
  return INDEX_BY_KEY.has(key) ? JOURNEY[INDEX_BY_KEY.get(key)] : null;
}

/**
 * The stage VALUES a journey-step filter matches: the step's own value plus every
 * off-path value anchored to it. The same list applies to whichever stage leads (a value
 * is a value on either object), so the list query is
 *   (no solar AND customer stage IN values) OR (solar AND solar stage IN values).
 * Returns null for an unknown key. "current" anchors, unknown values and blanks belong
 * to no step, so no filter matches them — exactly as journeyFor gives them stage null.
 */
export function stageFilterValues(key) {
  const s = journeyStep(key);
  if (!s) return null;
  const values = [s.value];
  for (const [v, o] of Object.entries(OFF_PATH)) if (o.anchor === s.value) values.push(v);
  return values;
}

/** Test hook: forget which unknown values were logged. */
export function _resetUnknownLog() {
  loggedUnknown.clear();
}
