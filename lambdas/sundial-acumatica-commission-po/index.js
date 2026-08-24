// sundial-acumatica-commission-po — third-party commission purchase orders (Stage D).
//
// STATUS: LIVE as of 2026-08-24 — PO_GATE is OPEN. This engine now raises real purchase
// orders against real vendors. Read this header, and read UPDATABLE_STATUSES, before
// changing anything in it.
//
// TWO POs per third-party job, one per milestone payment to the dealer who sold it:
//   M1 = min(50% of the commission, $2,500)
//   M2 = the balance
// Internal deals raise NO PO at all — internal commission is payroll (D16).
//
// Shape is cloned from a LIVE specimen, PO 016102 on project R261078 (vendor 02118),
// captured 2026-08-22. See SPECIMEN_DEFAULTS.
//
// ---------------------------------------------------------------------------
// WHEN THE POs ARE RAISED — confirmed 2026-08-24, and NOT what §6 first described
// ---------------------------------------------------------------------------
// §6 read as though M1 fired at Site Audit Complete and M2 later at Glass on Roof, which
// made "which field means Site Audit Complete" (Q13) a gating question. Harmon's actual
// workflow is simpler and was confirmed as already-built behaviour:
//
//   BOTH POs are created on the FIRST budget push, and both are UPDATED by later pushes
//   until Acumatica freezes them.
//
// So the two milestone dates are NOT creation gates — nothing here waits on a date, and a
// job with neither date set still gets both POs. What Q13 actually settled is which date
// each PO CARRIES: see MILESTONE_DATE_FIELDS. planMilestone() has always worked this way;
// the change in 2026-08-24 was deleting the trigger design, not adding one.
//
// ---------------------------------------------------------------------------
// THE TWO GAPS, BOTH NOW CLOSED (2026-08-24)
// ---------------------------------------------------------------------------
// GAP 1 — the write-back fields. Approved as proposed and packaged in
//   salesforce/v4-commission-po-fields/ (8 fields, collision-checked against the live
//   describe). Without a stored OrderNbr there is no idempotency: "have we already raised
//   M1 for this job" is answered by a stored order number and nothing else. THE PACKAGE
//   STILL HAS TO BE DEPLOYED, with Read + Edit FLS for the integration user — see
//   PO_WRITEBACK_FIELDS.
//
// GAP 2 — the milestone dates. Answered as Q13: M1 = Audit_Date_and_DateTime__c,
//   M2 = Scheduled_Install_Date__c — the same two fields that already feed the AUDITDATE
//   and INCOMDATE Acumatica attributes, so the PO and the attribute sync cannot disagree
//   about when a milestone happened.
//
// WHAT STILL GATES THIS: the hand-proof. Two of its steps have not come back clean —
// see PO_GATE.
//
// ---------------------------------------------------------------------------
// THE ASYMMETRY THAT SHAPES THIS FILE
// ---------------------------------------------------------------------------
// The budget push UPDATES existing scaffold lines: a wrong number is corrected by the
// next push. A purchase order is a document that authorises a PAYMENT. A duplicate is
// not a bad row, it is Harmon paying a dealer twice; a wrong vendor is paying the wrong
// company. So every write here is create-then-verify-by-re-read (the D20 pattern), and
// every refusal is loud.

import { getAcumaticaEntity, putAcumaticaEntity } from "../../lib/acumatica.js";
import { lookupDealerVendor } from "../../lib/acumatica-dealer-vendors.js";
import { sfUpdateRecord } from "../../lib/salesforce.js";

const PO_ENTITY = "PurchaseOrder";

/** The commission task and item, from the specimen. Same task the budget push writes. */
export const COMMISSION_PROJECT_TASK = "SLPC OUT"; // ONE space (D18)
export const COMMISSION_INVENTORY_ID = "M1&M2COM";
export const COMMISSION_LINE_DESCRIPTION = "Outside Sales commissions";

/**
 * M1 cap (§6). A dealer's first payment is half the commission, but never more than
 * $2,500 — so on any job whose commission exceeds $5,000 the M1 is exactly the cap and
 * M2 carries the rest.
 *
 * Corroborated by the live attribute pull on R251282: SLSCOM1 = 2500.00 exactly (the cap
 * biting) and SLSCOM2 = 4814.00, i.e. a 7,314 commission split 2500 / 4814. That the cap
 * shows up as a round number in live data is the strongest evidence we have that the
 * rule is stated correctly.
 */
export const M1_RATE = 0.5;
export const M1_CAP = 2500;

/**
 * THE GATE. Same mechanism and the same reasoning as the budget push's CREATE_GATE: a
 * repo constant rather than an environment variable, so turning it on is a diff someone
 * reviewed, not a console click. A test asserts the committed value.
 *
 * ⚠️ OPENED 2026-08-24. All three blockers cleared:
 *   1. ✅ §4f write-back fields DEPLOYED, with Read + Edit FLS for the integration user.
 *   2. ✅ milestone dates named (Q13/D23 — see MILESTONE_DATE_FIELDS).
 *   3. ✅ hand-proof re-run — see below.
 *
 * WHAT THE RE-RUN SETTLED, and what it did not:
 *
 *   - STEP 8 answered the freeze question the hard way: **Acumatica ALLOWS a PUT to a
 *     Canceled PO** (200, change persisted). So the freeze rule is not us agreeing with
 *     the API — it is the ONLY protection there is. See UPDATABLE_STATUSES.
 *   - STEP 7's duplicate probe is still not evidence: the corrected description scan
 *     returned 28, i.e. the vendor's whole PO history again, so the runbook's probe is
 *     itself buggy. Ruled 2026-08-24 as a runbook defect to fix separately, NOT a reason
 *     to hold the gate — idempotency here is the stored OrderNbr and never a scan, the
 *     first run's guid and OrderNbr were unchanged across an update, and the behaviour is
 *     covered by tests. **That is an accepted residual risk, not a proven negative.**
 *     Hence the watch below.
 *
 * ⚠️ FIRST-LIVE-JOB WATCH: exactly one PO per milestone per project, ever. If a project
 * ever grows a second M1, close this gate before doing anything else — that is a
 * duplicate payment, not a reporting glitch.
 */
export const PO_GATE = { enabled: true };

/**
 * Q13, answered 2026-08-24 — which date each milestone PO CARRIES.
 *
 * NOT creation triggers. Both POs are raised on the first budget push regardless of
 * whether either date is set; these decide what goes in the PO's Requested/Promised
 * dates once a date exists. See the header.
 *
 * Both are `date` fields on Sundial_Solar__c (confirmed by describe 2026-08-24 — note
 * Audit_Date_and_DateTime__c is a Date despite its name), and both are already the source
 * for an Acumatica attribute: AUDITDATE and INCOMDATE respectively (§7). Reusing them
 * means the PO and the attribute sync cannot end up disagreeing about the same milestone.
 */
export const MILESTONE_DATE_FIELDS = Object.freeze({
  M1: "Audit_Date_and_DateTime__c", // "Site Audit Complete"
  M2: "Scheduled_Install_Date__c", // "Glass on Roof"
});

/** `2026-08-24T00:00:00+00:00` / `2026-08-24` -> `2026-08-24`; anything else -> null. */
export function datePart(v) {
  const s = String(v ?? "").trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

/**
 * The milestone date for one PO, or null when Harmon has not set it yet.
 *
 * Null is the ORDINARY case on a first push — the audit is usually not done and the
 * install usually not scheduled when the budget is first pushed — and it is handled by
 * sending no date at all, so Acumatica applies its own default exactly as it does on
 * every PO Harmon has ever raised by hand. A later push fills it in.
 */
export function milestoneDate(values, milestone) {
  const f = MILESTONE_DATE_FIELDS[milestone];
  if (!f) throw new Error(`unknown milestone ${milestone}`);
  return datePart(values?.[f]);
}

function numOf(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
/** Unwrap an Acumatica field value ({ value: x } or scalar). */
function av(v) {
  return v && typeof v === "object" && "value" in v ? v.value : v;
}

/**
 * Split a third-party commission into its two milestone payments.
 *
 * Rounding is applied to M1 and the BALANCE is then computed by subtraction, never
 * rounded independently. Rounding both would let them fail to sum to the commission by a
 * cent on odd amounts — and a cent that never gets paid is a reconciliation item someone
 * spends an afternoon on.
 *
 * @param {number} totalCommission - Sales_Rep_Commission_Amt__c (third-party only)
 * @returns {{total:number, m1:number, m2:number, capped:boolean}}
 */
export function computeCommissionMilestones(totalCommission) {
  const total = round2(numOf(totalCommission));
  if (total <= 0) return { total: total < 0 ? total : 0, m1: 0, m2: 0, capped: false };
  const uncapped = round2(total * M1_RATE);
  const m1 = Math.min(uncapped, M1_CAP);
  return { total, m1: round2(m1), m2: round2(total - m1), capped: uncapped > M1_CAP };
}

/**
 * The PO Description, which is ALSO the human-readable M1/M2 identity in Acumatica.
 *
 * ⚠️ It is a LABEL, not a key. Idempotency is decided by the OrderNbr stored on the
 * Salesforce record — never by scanning descriptions. A description scan would match on
 * a hand-typed PO, miss one somebody edited, and quietly create a duplicate payment in
 * both cases.
 */
export function commissionPoDescription(milestone, acumaticaProjectId) {
  return `Sales Commission ${milestone} — ${acumaticaProjectId}`;
}

/**
 * Build the CREATE body — deliberately minimal.
 *
 * Account 5450, Subaccount 02, TaxCategory LABSERV, Warehouse/Location MAIN, Terms 30D,
 * Branch HARMON and LineType Non-Stock are all present on the specimen and are all
 * DERIVED by Acumatica from the inventory item and the vendor. Sending them would mean
 * this file carries a second, silently-drifting copy of Harmon's item and vendor
 * configuration: change the posting class in Acumatica and the integration would keep
 * overriding it with last year's value. So we send the minimum and VERIFY the rest came
 * back matching the specimen — which is the same trade the D20 referral-line create
 * makes, for the same reason.
 *
 * THE MILESTONE DATE (Q13) IS THE ONE ADDITION TO THE SPECIMEN'S SHAPE. On PO 016102 the
 * line's `Requested` and `Promised` both equal the order date (2026-07-14), because
 * nobody typing a PO by hand changes them — so the specimen cannot tell us what Harmon
 * WANTS there, only what the default is. Carrying the milestone date instead makes the
 * document say when the payment is actually expected, which is what those fields are for.
 * Two guards keep that from being a silent divergence:
 *   - a BLANK milestone date sends nothing, so the PO is byte-identical to the specimen's
 *     shape until a real date exists;
 *   - the dates are VERIFIED as something we asked for, not accepted as derived, so if
 *     Acumatica ignores or rewrites them we find out on the create rather than never.
 * Both line dates are set together because the specimen keeps them equal.
 *
 * No `id` — that is what makes this an insert.
 */
export function buildCommissionPoBody({ vendorId, acumaticaProjectId, milestone, amount, milestoneDate = null }) {
  const line = {
    InventoryID: { value: COMMISSION_INVENTORY_ID },
    OrderQty: { value: 1 },
    UOM: { value: "EA" },
    UnitCost: { value: round2(numOf(amount)) },
    Project: { value: acumaticaProjectId },
    ProjectTask: { value: COMMISSION_PROJECT_TASK },
    LineDescription: { value: COMMISSION_LINE_DESCRIPTION },
  };
  const when = datePart(milestoneDate);
  if (when) {
    line.Requested = { value: when };
    line.Promised = { value: when };
  }
  return {
    VendorID: { value: vendorId },
    Description: { value: commissionPoDescription(milestone, acumaticaProjectId) },
    Details: [line],
  };
}

/**
 * What the specimen says a correctly-derived commission PO looks like.
 *
 * Every one of these is a value we do NOT send. Checking them after a create is how we
 * find out that Acumatica derived something different — a wrong Account or Subaccount
 * would post the cost to the wrong GL account, which nothing downstream would flag and
 * which is tedious to unpick a month later.
 *
 * Source: PO 016102, project R261078, vendor 02118, captured 2026-08-22.
 */
// ⚠️ `Status` and `Hold` are deliberately NOT in here, even though the specimen shows
// Open / false. They are mutable LIFECYCLE STATE, not configuration Acumatica derived
// once: a PO legitimately moves Open -> On Hold -> Completed over its life. Asserting
// Status === "Open" would reject a perfectly valid On Hold order on every re-push, and
// would do it under a message about the specimen, which points at entirely the wrong
// thing. Status is checked where it means something — the freeze rule below, and the
// create's "landed in a state we can still correct" check.
// ⚠️ `Terms` was in here and CAME OUT on 2026-08-24. The specimen (vendor 02118) shows
// `30D`; the hand-proof PO on vendor 01736 came back `DOR`, and both are right — Terms
// derives from the VENDOR's payment terms, so it is not a constant of "a commission PO",
// it is a fact about whoever is being paid. Asserting the specimen's value would have
// rejected a perfectly good Blue Sky Solar purchase order on the first live job, and the
// D4 map has 35 resolvable dealers who will not share terms. It is REPORTED instead (see
// RECORDED_HEADER_FIELDS) so a surprise is still visible without being fatal.
export const SPECIMEN_DEFAULTS = Object.freeze({
  header: Object.freeze({
    Type: "Normal",
    Branch: "HARMON",
    CurrencyID: "USD",
    Location: "MAIN",
  }),
  line: Object.freeze({
    Account: "5450",
    Subaccount: "02",
    TaxCategory: "LABSERV",
    WarehouseID: "MAIN",
    LineType: "Non-Stock",
    UOM: "EA",
    OrderQty: 1,
  }),
});

/**
 * Derived header values we RECORD but do not assert.
 *
 * The distinction is whether the value is a property of "a commission PO" or a property of
 * the vendor. Branch, Currency and Location are the former and are checked. Terms is the
 * latter — see the note above SPECIMEN_DEFAULTS — so it is logged and returned, which
 * catches a genuinely odd value (a dealer set to something nobody intended) without
 * failing a create over a difference we predicted and cannot control.
 */
export const RECORDED_HEADER_FIELDS = Object.freeze(["terms"]);

/**
 * PO header statuses in which the document may still be changed.
 *
 * ⚠️ THIS ALLOW-LIST IS THE ONLY THING PROTECTING A RELEASED PURCHASE ORDER.
 *
 * The hand-proof re-run (2026-08-24, step 8) established that **Acumatica ALLOWS a PUT to
 * a Canceled PO** — 200, and the change persists. It is not a business rule the API
 * enforces and we mirror; it is a business rule the API does not have. Nothing outside
 * this file will stop a silent edit to a document somebody downstream has already worked
 * from, so the check below must never become conditional, never be skipped for a "small"
 * correction, and never move behind a flag.
 *
 * **Only `Canceled` was tested.** `Completed` and `Closed` were not, so we do not know
 * whether Acumatica happens to refuse those — and we treat that as irrelevant: every
 * status that is not on the allow-list is never-touch, whether or not the API agrees.
 *
 * DENY BY DEFAULT, and that is load-bearing rather than stylistic. The guard is
 * `!UPDATABLE_STATUSES.includes(status)`, so an unrecognised status is FROZEN. A future
 * Acumatica version adding a status we have never heard of therefore fails safe.
 */
export const UPDATABLE_STATUSES = Object.freeze(["Open", "On Hold"]);

/**
 * The frozen statuses we know of. **DOCUMENTATION ONLY — never the guard.**
 *
 * Note the spelling: Acumatica returns **`Canceled`**, one L, confirmed by reading PO
 * 016442 after the step 8 re-run. This list previously said `Cancelled` and had therefore
 * never matched anything. That was harmless *only* because the guard is the allow-list
 * above; had anything ever been written as `FROZEN_STATUSES.includes(status)`, a canceled
 * PO would have sailed straight through it. Which is the argument for deny-by-default
 * rather than a tidier-looking deny-list.
 */
export const FROZEN_STATUSES = Object.freeze(["Completed", "Closed", "Canceled"]);

/** Normalise a raw PurchaseOrder into the shape the rest of this file reasons about. */
export function normalizePurchaseOrder(raw) {
  const details = Array.isArray(raw?.Details) ? raw.Details : [];
  return {
    id: raw?.id,
    orderNbr: av(raw?.OrderNbr),
    orderType: av(raw?.Type),
    status: av(raw?.Status),
    hold: av(raw?.Hold),
    vendorId: av(raw?.VendorID),
    description: av(raw?.Description),
    orderTotal: av(raw?.OrderTotal),
    branch: av(raw?.Branch),
    currencyId: av(raw?.CurrencyID),
    terms: av(raw?.Terms),
    location: av(raw?.Location),
    lines: details.map((d) => ({
      id: d?.id,
      inventoryId: av(d?.InventoryID),
      project: av(d?.Project),
      projectTask: av(d?.ProjectTask),
      lineDescription: av(d?.LineDescription),
      unitCost: av(d?.UnitCost),
      extendedCost: av(d?.ExtendedCost),
      orderQty: av(d?.OrderQty),
      uom: av(d?.UOM),
      // Acumatica returns these as full timestamps (`2026-08-24T00:00:00+00:00`); the
      // date is the only part that means anything here, so normalise on the way in and
      // nothing downstream has to remember to.
      requested: datePart(d?.Requested?.value ?? d?.Requested),
      promised: datePart(d?.Promised?.value ?? d?.Promised),
      account: av(d?.Account),
      subaccount: av(d?.Subaccount),
      taxCategory: av(d?.TaxCategory),
      warehouseId: av(d?.WarehouseID),
      lineType: av(d?.LineType),
    })),
  };
}

/** Read one PO by its order number, with lines. Never cached — guids come from here. */
export async function readPurchaseOrder(orderNbr) {
  const res = await getAcumaticaEntity(PO_ENTITY, {
    $filter: `OrderNbr eq '${String(orderNbr).replace(/'/g, "''")}'`,
    $expand: "Details",
  });
  if (!res.ok) {
    const err = new Error(`PurchaseOrder read failed (${res.status})`);
    err.acuStatus = res.status;
    throw err;
  }
  const rows = Array.isArray(res.data) ? res.data : [];
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    // OrderNbr is supposed to be unique. If it is not, we do not get to pick one.
    const err = new Error(`OrderNbr ${orderNbr} matched ${rows.length} purchase orders`);
    err.ambiguous = true;
    throw err;
  }
  return normalizePurchaseOrder(rows[0]);
}

/**
 * Check a PO against the specimen and against what we asked for.
 *
 * Returns a list of human-readable mismatches — empty means it matches. Split out from
 * the create so the runbook, the tests and the live path all judge "correct" by the same
 * rule, rather than the runbook checking by eye.
 */
export function verifyCommissionPo(po, { vendorId, acumaticaProjectId, milestone, amount, milestoneDate = null }) {
  const bad = [];
  if (!po) return ["no purchase order came back on the re-read"];
  if (!po.id) bad.push("the PO came back without a guid, so nothing can update it later");
  if (!po.orderNbr) bad.push("the PO came back without an OrderNbr — there would be nothing to store, and no idempotency");

  // What we asked for.
  if (po.vendorId !== vendorId) bad.push(`VendorID is "${po.vendorId}", expected "${vendorId}"`);
  const wantDesc = commissionPoDescription(milestone, acumaticaProjectId);
  if (po.description !== wantDesc) bad.push(`Description is "${po.description}", expected "${wantDesc}"`);

  if (po.lines.length !== 1) {
    bad.push(`expected exactly 1 detail line, got ${po.lines.length}`);
    return bad; // the per-line checks below would be meaningless
  }
  const line = po.lines[0];
  if (line.inventoryId !== COMMISSION_INVENTORY_ID) bad.push(`InventoryID is "${line.inventoryId}", expected "${COMMISSION_INVENTORY_ID}"`);
  if (line.project !== acumaticaProjectId) bad.push(`line Project is "${line.project}", expected "${acumaticaProjectId}"`);
  if (line.projectTask !== COMMISSION_PROJECT_TASK) bad.push(`line ProjectTask is "${line.projectTask}", expected "${COMMISSION_PROJECT_TASK}"`);
  if (round2(numOf(line.unitCost)) !== round2(numOf(amount))) bad.push(`UnitCost is ${line.unitCost}, expected ${amount}`);
  // ExtendedCost = UnitCost x qty, and qty is 1. If these disagree the qty is not what
  // we think it is, and the PO is for the wrong amount of money.
  if (round2(numOf(line.extendedCost)) !== round2(numOf(amount))) bad.push(`ExtendedCost is ${line.extendedCost}, expected ${amount} (qty should be 1)`);

  // The milestone dates, when we sent them. Only checked when we asked for a date: with
  // no milestone date we send none, Acumatica defaults them to the order date, and
  // asserting anything about that would be asserting a derived value we deliberately do
  // not own.
  const wantWhen = datePart(milestoneDate);
  if (wantWhen) {
    if (line.requested !== wantWhen) bad.push(`line Requested is ${JSON.stringify(line.requested)}, expected ${wantWhen}`);
    if (line.promised !== wantWhen) bad.push(`line Promised is ${JSON.stringify(line.promised)}, expected ${wantWhen}`);
  }

  // What Acumatica DERIVED. A mismatch here is a configuration difference, not a bug in
  // this code — but it still means the PO is not the document the specimen describes.
  for (const [field, want] of Object.entries(SPECIMEN_DEFAULTS.header)) {
    const key = { Type: "orderType", Branch: "branch", CurrencyID: "currencyId", Location: "location" }[field];
    const got = po[key];
    if (got !== want) bad.push(`derived header ${field} is ${JSON.stringify(got)}, specimen has ${JSON.stringify(want)}`);
  }
  for (const [field, want] of Object.entries(SPECIMEN_DEFAULTS.line)) {
    const key = { Account: "account", Subaccount: "subaccount", TaxCategory: "taxCategory", WarehouseID: "warehouseId", LineType: "lineType", UOM: "uom", OrderQty: "orderQty" }[field];
    const got = key === "orderQty" ? numOf(line[key]) : line[key];
    if (got !== want) bad.push(`derived line ${field} is ${JSON.stringify(got)}, specimen has ${JSON.stringify(want)}`);
  }
  return bad;
}

/**
 * Resolve the vendor and the amounts for a job, WITHOUT writing anything.
 *
 * Every reason a job does not get a PO is a distinct, named refusal, because each has a
 * different fix: an internal deal is correct and needs nothing; an unmapped dealer needs
 * a CSV row; an inactive vendor needs an Acumatica change; a zero commission is a
 * calc question.
 *
 * @param {object} values - Sundial_Solar__c field values
 * @returns {{ok:true, vendorId, vendorName, milestones}|{ok:false, reason, message}}
 */
export function planCommissionPos(values) {
  const dealType = String(values?.Commission_Deal_Type__c ?? "").trim();
  if (dealType === "") {
    return {
      ok: false, reason: "budget_calculated_by_previous_engine",
      message: "Commission_Deal_Type__c is blank — the budget predates the v2 calc. Recalculate before raising commission POs.",
    };
  }
  // PRIMARY defence for internal deals (D16). The dealer-vendor map's internal exclusion
  // is the backstop behind this, not a substitute for it.
  if (dealType === "Internal") {
    return {
      ok: false, reason: "internal_deal",
      message: "Internal deal — commission is payroll, not a purchase order (D16). No PO is correct here.",
    };
  }

  const acumaticaProjectId = String(values?.Acumatica_Project_ID__c ?? "").trim();
  if (!acumaticaProjectId) {
    return { ok: false, reason: "no_acumatica_project", message: "No Acumatica_Project_ID__c — the project must exist before a PO can reference it." };
  }

  const milestones = computeCommissionMilestones(values?.Sales_Rep_Commission_Amt__c);
  if (milestones.total <= 0) {
    return {
      ok: false, reason: "no_commission",
      message: `Third-party commission is ${milestones.total}. Nothing to pay, so no PO.`,
    };
  }

  const vendor = lookupDealerVendor(values?.Sales_Company_Harmon_Solar_or_Third__c);
  if (!vendor.ok) {
    return { ok: false, reason: `vendor_${vendor.reason}`, message: vendor.message };
  }

  return {
    ok: true,
    vendorId: vendor.vendorId,
    vendorName: vendor.vendorName,
    acumaticaProjectId,
    milestones,
  };
}

/**
 * Create ONE milestone PO and prove it exists before saying so.
 *
 * The verification is not optional politeness. A create that returns 200 but produces
 * nothing means a dealer never gets paid and nothing says so; a create that produces a
 * PO with a derived Account we did not expect posts real cost to the wrong GL account.
 * Neither is self-correcting on the next run, so neither may be reported as success on
 * the strength of a status code.
 */
export async function createCommissionPo({ vendorId, acumaticaProjectId, milestone, amount, milestoneDate = null }) {
  if (!PO_GATE.enabled) {
    return { ok: false, action: "create_blocked", reason: "PO_GATE is closed — commission PO creation is not enabled" };
  }
  if (!(Number.isFinite(amount) && amount > 0)) {
    return { ok: false, action: "create_refused", reason: `refusing to raise a purchase order for ${amount}` };
  }

  const body = buildCommissionPoBody({ vendorId, acumaticaProjectId, milestone, amount, milestoneDate });
  console.log(`commission-po CREATE ${milestone} project=${acumaticaProjectId} vendor=${vendorId} amount=${amount} date=${datePart(milestoneDate) ?? "(none)"}`);
  const put = await putAcumaticaEntity(PO_ENTITY, body);
  if (!put.ok) {
    return {
      ok: false, action: "create_failed", milestone, status: put.status,
      error: (put.text || "").slice(0, 300),
      message: "The purchase order was rejected, so none was created and nothing needs cleaning up. Fix the cause and retry.",
    };
  }

  // The OrderNbr is assigned by Acumatica, so unlike the referral line we cannot re-read
  // by a key we already knew — the PUT's echo is the ONLY place the new number appears.
  // We take the number from the echo and then re-read by it, so the verification is
  // still against a fresh server read rather than the write's own account of itself.
  const echoedNbr = av(put.data?.OrderNbr);
  if (!echoedNbr) {
    return {
      ok: false, action: "create_unverified", milestone,
      message:
        "The purchase order was accepted but the response carried no OrderNbr, so there is " +
        "nothing to store and nothing to re-read. A PO may now exist — find it in Acumatica " +
        "under the project before retrying, or the retry will duplicate it.",
    };
  }

  let po;
  try {
    po = await readPurchaseOrder(echoedNbr);
  } catch (err) {
    return {
      ok: false, action: "create_unverified", milestone, orderNbr: echoedNbr,
      message: `PO ${echoedNbr} was created but the verifying re-read failed. It exists — check it before retrying.`,
      error: err?.message || String(err),
    };
  }

  const mismatches = verifyCommissionPo(po, { vendorId, acumaticaProjectId, milestone, amount, milestoneDate });
  // Status is not a derived default (see SPECIMEN_DEFAULTS), but a BRAND NEW PO that is
  // already Completed or Cancelled is a different document from the one we asked for,
  // and — worse — one the freeze rule means we could never correct. Checked here, where
  // it is about the create rather than about the specimen.
  if (po && !UPDATABLE_STATUSES.includes(po.status)) {
    mismatches.push(`the new PO is already ${po.status}, so the freeze rule would prevent ever correcting it`);
  }
  if (mismatches.length > 0) {
    return {
      ok: false, action: "create_unverified", milestone, orderNbr: echoedNbr, poId: po?.id, mismatches,
      message:
        `PO ${echoedNbr} was created but does not match the expected shape: ${mismatches.join("; ")}. ` +
        "It exists in Acumatica — review it rather than retrying, because a retry raises a second one.",
    };
  }

  // Recorded, not asserted — the vendor-derived values a human would want to see if they
  // ever came out odd. Logged too, because the return value goes to a caller that stores
  // three fields and drops the rest.
  const recorded = Object.fromEntries(RECORDED_HEADER_FIELDS.map((k) => [k, po[k]]));
  console.log(`commission-po CREATED ${milestone} nbr=${po.orderNbr} terms=${recorded.terms}`);

  return {
    ok: true, action: "created", milestone, orderNbr: po.orderNbr, poId: po.id,
    lineId: po.lines[0].id, amount, vendorId, status: po.status,
    milestoneDate: po.lines[0].promised, recorded,
  };
}

/**
 * Update an EXISTING milestone PO's amount, subject to the freeze rule.
 *
 * @param {string} orderNbr - the number stored on the Salesforce record (never a scan)
 */
export async function updateCommissionPo({ orderNbr, amount, vendorId, acumaticaProjectId, milestone, milestoneDate = null }) {
  if (!PO_GATE.enabled) {
    return { ok: false, action: "update_blocked", reason: "PO_GATE is closed" };
  }

  const po = await readPurchaseOrder(orderNbr);
  if (!po) {
    // The stored number points at nothing. Creating a replacement would be the wrong
    // reflex: the PO may have been deleted deliberately, or the number may be wrong, and
    // either way a human should decide.
    return {
      ok: false, action: "update_missing", orderNbr, milestone,
      message: `Salesforce has PO ${orderNbr} stored for ${milestone}, but Acumatica has no such order. Not creating a replacement — someone needs to say what happened to it.`,
    };
  }

  // FREEZE RULE (§6). A released PO has been acted on downstream; the difference belongs
  // in M2, not in a quiet edit of a document someone has already worked from.
  if (!UPDATABLE_STATUSES.includes(po.status)) {
    return {
      ok: false, action: "frozen", orderNbr, milestone, status: po.status,
      currentAmount: round2(numOf(po.lines[0]?.unitCost)),
      requestedAmount: round2(numOf(amount)),
      message:
        `PO ${orderNbr} is ${po.status} and cannot be changed (§6). The difference between ` +
        `${round2(numOf(po.lines[0]?.unitCost))} and ${round2(numOf(amount))} belongs in M2.`,
    };
  }

  if (po.lines.length !== 1) {
    return { ok: false, action: "update_refused", orderNbr, milestone, message: `PO ${orderNbr} has ${po.lines.length} detail lines; expected exactly 1. Not guessing which to update.` };
  }

  const current = round2(numOf(po.lines[0].unitCost));
  const wanted = round2(numOf(amount));
  // The milestone date can move on its own — an install gets rescheduled without the
  // commission changing a cent — so it is a second, independent reason to write. A blank
  // milestone date is NOT a reason to clear a date already on the PO: Harmon may have set
  // it by hand, and un-setting a date nobody asked us to un-set is the kind of quiet edit
  // this file exists to avoid.
  const whenWanted = datePart(milestoneDate);
  const dateChanged = Boolean(whenWanted) && po.lines[0].promised !== whenWanted;
  if (current === wanted && !dateChanged) {
    return { ok: true, action: "unchanged", orderNbr, milestone, amount: wanted, poId: po.id, milestoneDate: po.lines[0].promised };
  }

  // Address BOTH the header and the line by guid, from the read we just did. Same
  // discipline as the budget push: guids come from this run, never from storage.
  const detail = { id: po.lines[0].id, UnitCost: { value: wanted }, OrderQty: { value: 1 } };
  if (whenWanted) {
    detail.Requested = { value: whenWanted };
    detail.Promised = { value: whenWanted };
  }
  const put = await putAcumaticaEntity(PO_ENTITY, { id: po.id, Details: [detail] });
  if (!put.ok) {
    return { ok: false, action: "update_failed", orderNbr, milestone, status: put.status, error: (put.text || "").slice(0, 300) };
  }

  const after = await readPurchaseOrder(orderNbr);
  const mismatches = verifyCommissionPo(after, { vendorId, acumaticaProjectId, milestone, amount: wanted, milestoneDate: whenWanted });
  if (mismatches.length > 0) {
    return { ok: false, action: "update_unverified", orderNbr, milestone, mismatches, message: `PO ${orderNbr} was updated but no longer matches the expected shape: ${mismatches.join("; ")}.` };
  }
  return {
    ok: true, action: "updated", orderNbr, milestone, amount: wanted, previousAmount: current,
    poId: after.id, milestoneDate: after.lines[0].promised,
    previousMilestoneDate: po.lines[0].promised,
  };
}

/**
 * Idempotency, in one place: has this milestone already been raised?
 *
 * Reads the stored OrderNbr off the Salesforce record. Deliberately NOT a search of
 * Acumatica by description or by project+task — a scan would match a hand-typed PO,
 * miss one somebody renamed, and in both cases the failure mode is a duplicate payment.
 * If the field is blank, this job has no M-n PO as far as Sundial is concerned, and the
 * only way that is wrong is if a previous run created one and failed to write back —
 * which is why the write-back is part of the same operation and its failure is loud.
 */
export const PO_NUMBER_FIELDS = Object.freeze({
  M1: "Commission_PO_M1_Number__c",
  M2: "Commission_PO_M2_Number__c",
});

export function storedOrderNbr(values, milestone) {
  const f = PO_NUMBER_FIELDS[milestone];
  if (!f) throw new Error(`unknown milestone ${milestone}`);
  const v = String(values?.[f] ?? "").trim();
  return v === "" ? null : v;
}

/**
 * Decide what should happen for one milestone, without doing it.
 *
 * Separated from the doing so the dry run and the real run cannot disagree — the dry run
 * is the same decision with the writes left out, not a second implementation of the
 * rules.
 */
export function planMilestone(values, milestone, plan) {
  const amount = plan.milestones[milestone === "M1" ? "m1" : "m2"];
  const existing = storedOrderNbr(values, milestone);
  const when = milestoneDate(values, milestone);
  // NOTE what is NOT here: any test of `when`. Both POs are raised on the first budget
  // push whether or not the milestone has a date — the date is cargo, not a gate. See the
  // header.
  if (amount <= 0) return { milestone, action: "skip_zero", amount, milestoneDate: when };
  if (existing) return { milestone, action: "update", amount, orderNbr: existing, milestoneDate: when };
  return { milestone, action: "create", amount, milestoneDate: when };
}

// ===========================================================================
// Write-back — the §4f fields (salesforce/v4-commission-po-fields/)
// ===========================================================================

/**
 * The eight fields this engine writes. The integration user needs Read + Edit on all of
 * them; without Edit the create still happens and the OrderNbr is lost, which is the one
 * failure mode that costs money.
 */
export const PO_WRITEBACK_FIELDS = Object.freeze({
  M1: Object.freeze({ number: "Commission_PO_M1_Number__c", amount: "Commission_PO_M1_Amount__c", created: "Commission_PO_M1_Created__c" }),
  M2: Object.freeze({ number: "Commission_PO_M2_Number__c", amount: "Commission_PO_M2_Amount__c", created: "Commission_PO_M2_Created__c" }),
  status: "Commission_PO_Status__c",
  error: "Commission_PO_Error__c",
});

/** The five values Commission_PO_Status__c is restricted to. */
export const PO_STATUSES = Object.freeze(["None", "M1 Raised", "Both Raised", "Failed", "Frozen"]);

/**
 * Reduce a run's per-milestone outcomes to the single picklist value.
 *
 * Precedence is FAILED > FROZEN > raised-count, and the order is the point. A run where
 * M1 froze and M2 failed is a run somebody has to look at, so it reads `Failed`; a run
 * where a PO froze and nothing failed is a normal, expected resting state and reads
 * `Frozen` rather than being filed under failure — filing it under failure is how people
 * learn to ignore failures.
 *
 * @param {Array<{ok:boolean, action:string}>} results
 * @param {{M1?:string|null, M2?:string|null}} numbers - order numbers known AFTER the run
 */
export function commissionPoStatus(results, numbers) {
  const list = results ?? [];
  if (list.some((r) => !r.ok && r.action !== "frozen")) return "Failed";
  if (list.some((r) => r.action === "frozen")) return "Frozen";
  if (numbers?.M1 && numbers?.M2) return "Both Raised";
  if (numbers?.M1) return "M1 Raised";
  return "None";
}

/**
 * Raise or refresh both commission POs for one job, storing each order number the moment
 * it exists.
 *
 * THE WRITE-BACK ORDER IS THE WHOLE DESIGN. M1's number is persisted before M2 is even
 * attempted, so an M2 failure — or a Lambda timeout between the two — cannot lose the
 * fact that M1 was raised. Batching all eight fields into one tidy update at the end
 * would be neater code and a duplicate payment the first time anything went wrong
 * halfway.
 *
 * @param {string} recordId - the Sundial_Solar__c id
 * @param {object} values - its field values, including the two Q13 dates
 * @param {{now?: () => string, update?: Function}} [deps] - injected for tests
 */
export async function syncCommissionPos(recordId, values, deps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const update = deps.update ?? sfUpdateRecord;
  const F = PO_WRITEBACK_FIELDS;

  // Checked HERE as well as inside create/update, and not redundantly: without this the
  // gate-closed refusals would flow into the status reducer and stamp `Failed` plus an
  // error message on every solar record the budget push touched. The gate being shut is
  // not a fact about the job.
  if (!PO_GATE.enabled) {
    return { ok: false, reason: "gate_closed", message: "PO_GATE is closed — no commission POs were attempted and nothing was written to Salesforce.", results: [] };
  }

  const plan = planCommissionPos(values);
  if (!plan.ok) {
    // Two different kinds of "no". An internal deal or a zero commission is the system
    // working correctly and must not look like a failure on the record; the rest are
    // things somebody has to fix.
    const benign = plan.reason === "internal_deal" || plan.reason === "no_commission";
    await update("Sundial_Solar__c", recordId, {
      [F.status]: benign ? "None" : "Failed",
      [F.error]: benign ? null : plan.message,
    });
    return { ok: false, reason: plan.reason, message: plan.message, results: [] };
  }

  const numbers = { M1: storedOrderNbr(values, "M1"), M2: storedOrderNbr(values, "M2") };
  const results = [];

  for (const milestone of ["M1", "M2"]) {
    const step = planMilestone(values, milestone, plan);
    if (step.action === "skip_zero") {
      results.push({ ok: true, action: "skip_zero", milestone, amount: step.amount });
      continue;
    }

    const args = {
      vendorId: plan.vendorId,
      acumaticaProjectId: plan.acumaticaProjectId,
      milestone,
      amount: step.amount,
      milestoneDate: step.milestoneDate,
    };
    const r = step.action === "update"
      ? await updateCommissionPo({ ...args, orderNbr: step.orderNbr })
      : await createCommissionPo(args);
    results.push(r);

    if (r.ok) {
      numbers[milestone] = r.orderNbr;
      const f = F[milestone];
      // `created` is stamped on the create only. On an update it would stop meaning
      // "when this PO was raised" and start meaning "when we last touched it", which is
      // a different fact and one nothing needs.
      await update("Sundial_Solar__c", recordId, {
        [f.number]: r.orderNbr,
        [f.amount]: r.amount,
        ...(r.action === "created" ? { [f.created]: now() } : {}),
      });
    }
  }

  const status = commissionPoStatus(results, numbers);
  const problems = results
    .filter((r) => !r.ok || r.action === "frozen")
    .map((r) => r.message || r.reason || `${r.milestone}: ${r.action}`);
  await update("Sundial_Solar__c", recordId, {
    [F.status]: status,
    [F.error]: problems.length > 0 ? problems.join("\n") : null,
  });

  return { ok: problems.length === 0, status, numbers, results };
}
