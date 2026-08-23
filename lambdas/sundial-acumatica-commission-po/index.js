// sundial-acumatica-commission-po — third-party commission purchase orders (Stage D).
//
// STATUS: BUILT, GATED OFF, AND BLOCKED ON TWO SALESFORCE GAPS. Read this header before
// wiring anything.
//
// One PO per milestone payment to the dealer who sold the job:
//   M1 = min(50% of the commission, $2,500)   at Site Audit Complete
//   M2 = the balance                          at Glass on Roof
// Internal deals raise NO PO at all — internal commission is payroll (D16).
//
// Shape is cloned from a LIVE specimen, PO 016102 on project R261078 (vendor 02118),
// captured 2026-08-22. See SPECIMEN_DEFAULTS.
//
// ---------------------------------------------------------------------------
// WHY THIS CANNOT BE TURNED ON YET — two gaps, both needing Tim, neither inventable
// ---------------------------------------------------------------------------
//
// GAP 1 — THE WRITE-BACK FIELDS DO NOT EXIST. §4f of the rework doc was always a draft,
//   and a live describe of Sundial_Solar__c on 2026-08-22 confirms there is no
//   Commission_PO_* field of any kind. Without somewhere to store the OrderNbr there is
//   no idempotency: every push would create another PO, because "have we already raised
//   M1 for this job" is answered by a stored order number and nothing else. The field
//   list is in docs/integrations/commission-po-field-gap.md, for review — deliberately
//   NOT built as a package, because inventing Salesforce fields is how you end up with
//   two fields meaning the same thing.
//
// GAP 2 — THE MILESTONE TRIGGERS ARE NOT IDENTIFIED. §6 says "at Site Audit Complete"
//   and "at Glass on Roof". Neither exists as a field: there is no Site_Audit_Complete__c
//   and no Glass_on_Roof__c. Candidates exist (Audit_Date_and_DateTime__c,
//   Audit_Photos_Received__c; Stanchion_Installation__c, Install_Complete__c — and a
//   Days_to_Glass_on_Roof__c FORMULA that must reference a real date somewhere), but
//   picking one would be guessing about when Harmon gets paid. Recorded as Q13.
//
// Everything that does NOT depend on those two — the amounts, the body shape, the
// create-then-verify, the freeze rule, the re-push behaviour — is built and tested here,
// so that when the gaps close the remaining work is wiring rather than design.
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
 * It stays `false` until ALL THREE of:
 *   1. the §4f write-back fields are deployed (gap 1),
 *   2. the milestone triggers are named (gap 2),
 *   3. docs/integrations/acumatica-commission-po-runbook.md comes back clean.
 */
export const PO_GATE = { enabled: false };

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
 * No `id` — that is what makes this an insert.
 */
export function buildCommissionPoBody({ vendorId, acumaticaProjectId, milestone, amount }) {
  return {
    VendorID: { value: vendorId },
    Description: { value: commissionPoDescription(milestone, acumaticaProjectId) },
    Details: [
      {
        InventoryID: { value: COMMISSION_INVENTORY_ID },
        OrderQty: { value: 1 },
        UOM: { value: "EA" },
        UnitCost: { value: round2(numOf(amount)) },
        Project: { value: acumaticaProjectId },
        ProjectTask: { value: COMMISSION_PROJECT_TASK },
        LineDescription: { value: COMMISSION_LINE_DESCRIPTION },
      },
    ],
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
export const SPECIMEN_DEFAULTS = Object.freeze({
  header: Object.freeze({
    Type: "Normal",
    Branch: "HARMON",
    CurrencyID: "USD",
    Terms: "30D",
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
 * PO header statuses in which the document may still be changed.
 *
 * Anything else is FROZEN and the delta belongs in M2 (§6). This is a business rule, not
 * an API limitation: a released PO has been acted on, and silently editing it would
 * change a commitment somebody downstream has already worked from.
 */
export const UPDATABLE_STATUSES = Object.freeze(["Open", "On Hold"]);
export const FROZEN_STATUSES = Object.freeze(["Completed", "Closed", "Cancelled"]);

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
export function verifyCommissionPo(po, { vendorId, acumaticaProjectId, milestone, amount }) {
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

  // What Acumatica DERIVED. A mismatch here is a configuration difference, not a bug in
  // this code — but it still means the PO is not the document the specimen describes.
  for (const [field, want] of Object.entries(SPECIMEN_DEFAULTS.header)) {
    const key = { Type: "orderType", Branch: "branch", CurrencyID: "currencyId", Terms: "terms", Location: "location" }[field];
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
export async function createCommissionPo({ vendorId, acumaticaProjectId, milestone, amount }) {
  if (!PO_GATE.enabled) {
    return { ok: false, action: "create_blocked", reason: "PO_GATE is closed — commission PO creation is not enabled" };
  }
  if (!(Number.isFinite(amount) && amount > 0)) {
    return { ok: false, action: "create_refused", reason: `refusing to raise a purchase order for ${amount}` };
  }

  const body = buildCommissionPoBody({ vendorId, acumaticaProjectId, milestone, amount });
  console.log(`commission-po CREATE ${milestone} project=${acumaticaProjectId} vendor=${vendorId} amount=${amount}`);
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

  const mismatches = verifyCommissionPo(po, { vendorId, acumaticaProjectId, milestone, amount });
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

  return { ok: true, action: "created", milestone, orderNbr: po.orderNbr, poId: po.id, lineId: po.lines[0].id, amount, vendorId, status: po.status };
}

/**
 * Update an EXISTING milestone PO's amount, subject to the freeze rule.
 *
 * @param {string} orderNbr - the number stored on the Salesforce record (never a scan)
 */
export async function updateCommissionPo({ orderNbr, amount, vendorId, acumaticaProjectId, milestone }) {
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
  if (current === wanted) {
    return { ok: true, action: "unchanged", orderNbr, milestone, amount: wanted, poId: po.id };
  }

  // Address BOTH the header and the line by guid, from the read we just did. Same
  // discipline as the budget push: guids come from this run, never from storage.
  const put = await putAcumaticaEntity(PO_ENTITY, {
    id: po.id,
    Details: [{ id: po.lines[0].id, UnitCost: { value: wanted }, OrderQty: { value: 1 } }],
  });
  if (!put.ok) {
    return { ok: false, action: "update_failed", orderNbr, milestone, status: put.status, error: (put.text || "").slice(0, 300) };
  }

  const after = await readPurchaseOrder(orderNbr);
  const mismatches = verifyCommissionPo(after, { vendorId, acumaticaProjectId, milestone, amount: wanted });
  if (mismatches.length > 0) {
    return { ok: false, action: "update_unverified", orderNbr, milestone, mismatches, message: `PO ${orderNbr} was updated but no longer matches the expected shape: ${mismatches.join("; ")}.` };
  }
  return { ok: true, action: "updated", orderNbr, milestone, amount: wanted, previousAmount: current, poId: after.id };
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
  if (amount <= 0) return { milestone, action: "skip_zero", amount };
  if (existing) return { milestone, action: "update", amount, orderNbr: existing };
  return { milestone, action: "create", amount };
}
