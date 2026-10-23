// Tests for the commission PO engine.
//
// A purchase order authorises a PAYMENT, so the properties worth pinning are the ones
// whose failure costs money rather than correctness:
//
//   - the M1 cap, verified against the live R251282 split (2500 / 4814)
//   - M1 + M2 always equal the commission exactly, to the cent
//   - internal deals never reach a vendor at all
//   - the create body is MINIMAL and carries no `id`
//   - a create that 200s but produces the wrong document fails verification
//   - a re-push updates by guid and never raises a second PO
//   - a released PO is frozen, and the delta is reported rather than applied
import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const ctx = {
  orders: [],        // raw PurchaseOrder rows the fake Acumatica holds
  puts: [],
  createBehaviour: "insert",
  nextNbr: 20001,
  vendors: {},       // VendorID -> { name, status } the fake Acumatica knows (D-085 am. 1)
  vendorReads: [],
  vendorLookupFails: false,
  // The 2026-10-23 bug, acted out: an Open (not On Hold) PO answers a detail edit with 200
  // and keeps its old amount. Off by default so every older test sees an obedient API.
  openDiscardsEdits: false,
  failStep: null,         // "hold" | "amount" | "release" — that PUT returns 500
  holdIgnored: false,     // a Hold PUT 200s but the PO stays as it was
  releaseStatus: "Open",  // where a release lands ("Pending Approval" = approval re-entered)
  putQueries: [],
};

const DEFAULT_VENDORS = () => ({
  "01736": { name: "Blue Sky Solar LLC", status: "Active" },
  "02118": { name: "Heavenly Power LLC", status: "Active" },
  "01863": { name: "Derek Anderson", status: "Inactive" },
});

/**
 * Raw PO in Acumatica's shape, with the specimen's derived defaults applied.
 *
 * `when` mimics Acumatica's own behaviour: absent a requested date it defaults Requested
 * and Promised to the order date, and it returns both as full timestamps rather than the
 * bare date we sent. Both matter — the default is what makes a blank milestone date safe,
 * and the timestamp format is what datePart() exists for.
 */
function rawPo({ orderNbr, vendorId, description, project, amount, status = "Open", when = null, terms = "30D", overrides = {}, lineOverrides = {} }) {
  const stamp = `${when ?? "2026-08-24"}T00:00:00+00:00`;
  return {
    id: `po-guid-${orderNbr}`,
    OrderNbr: { value: orderNbr },
    Type: { value: "Normal" },
    Status: { value: status },
    Hold: { value: false },
    Branch: { value: "HARMON" },
    CurrencyID: { value: "USD" },
    Terms: { value: terms },
    Location: { value: "MAIN" },
    VendorID: { value: vendorId },
    Description: { value: description },
    OrderTotal: { value: amount },
    Details: [
      {
        id: `line-guid-${orderNbr}`,
        InventoryID: { value: "M1&M2COM" },
        LineType: { value: "Non-Stock" },
        Project: { value: project },
        ProjectTask: { value: "SLPC OUT" },
        LineDescription: { value: "Outside Sales commissions" },
        OrderQty: { value: 1 },
        UOM: { value: "EA" },
        UnitCost: { value: amount },
        ExtendedCost: { value: amount },
        Account: { value: "5450" },
        Subaccount: { value: "02" },
        TaxCategory: { value: "LABSERV" },
        WarehouseID: { value: "MAIN" },
        Requested: { value: stamp },
        Promised: { value: stamp },
        ...lineOverrides,
      },
    ],
    ...overrides,
  };
}

mock.module("../../lib/acumatica.js", {
  namedExports: {
    getAcumaticaEntity: async (_entity, query) => {
      // The vendor existence check (lib/acumatica-vendor-check.js) filters Vendor by id.
      if (_entity === "Vendor") {
        const id = /VendorID eq '([^']*)'/.exec(query?.$filter ?? "")?.[1];
        ctx.vendorReads.push(id);
        if (ctx.vendorLookupFails) return { ok: false, status: 503, data: null, text: "down" };
        const v = ctx.vendors[id];
        return { ok: true, status: 200, data: v ? [{ VendorID: { value: id }, VendorName: { value: v.name }, Status: { value: v.status } }] : [] };
      }
      // The engine only ever filters by OrderNbr.
      const m = /OrderNbr eq '([^']*)'/.exec(query?.$filter ?? "");
      const nbr = m ? m[1] : null;
      const rows = ctx.orders.filter((o) => o.OrderNbr.value === nbr);
      return { ok: true, status: 200, data: rows };
    },
    putAcumaticaEntity: async (_entity, body, query) => {
      ctx.puts.push(body);
      ctx.putQueries.push(query ?? null);

      // UPDATE — has a header id.
      if (body.id) {
        const po = ctx.orders.find((o) => o.id === body.id);
        if (!po) return { ok: false, status: 404, text: "not found" };
        const step = body.Hold ? (body.Hold.value ? "hold" : "release") : "amount";
        if (ctx.failStep === step) return { ok: false, status: 500, data: null, text: `${step} refused` };
        if (body.Hold) {
          if (!ctx.holdIgnored) {
            po.Hold = { value: body.Hold.value };
            po.Status = { value: body.Hold.value ? "On Hold" : ctx.releaseStatus };
          }
          return { ok: true, status: 200, data: po, text: "" };
        }
        if (ctx.openDiscardsEdits && po.Status?.value === "Open") return { ok: true, status: 200, data: po, text: "" };
        for (const d of body.Details ?? []) {
          const line = po.Details.find((x) => x.id === d.id);
          if (!line) return { ok: false, status: 404, text: "line not found" };
          if (d.UnitCost) {
            line.UnitCost = { value: d.UnitCost.value };
            line.ExtendedCost = { value: d.UnitCost.value };
          }
          // Echoed back as a timestamp, the way Acumatica does.
          for (const f of ["Requested", "Promised"]) {
            if (d[f]) line[f] = { value: `${d[f].value}T00:00:00+00:00` };
          }
        }
        return { ok: true, status: 200, data: po, text: "" };
      }

      // CREATE — no id.
      const nbr = String(ctx.nextNbr++).padStart(6, "0");
      const made = rawPo({
        orderNbr: nbr,
        vendorId: body.VendorID.value,
        description: body.Description.value,
        project: body.Details[0].Project.value,
        amount: body.Details[0].UnitCost.value,
        // No Requested sent -> Acumatica defaults it to the order date, as the specimen shows.
        when: body.Details[0].Requested?.value ?? null,
        ...(ctx.createBehaviour === "wrong_account" ? { lineOverrides: { Account: { value: "6100" } } } : {}),
        ...(ctx.createBehaviour === "born_closed" ? { status: "Closed" } : {}),
        ...(ctx.createBehaviour === "other_terms" ? { terms: "DOR" } : {}),
      });

      switch (ctx.createBehaviour) {
        case "reject":
          return { ok: false, status: 400, text: "Vendor 01863 is inactive" };
        case "silent": // 200, echoes a number, but the order never appears
          return { ok: true, status: 200, data: { OrderNbr: { value: nbr } }, text: "" };
        case "no_nbr": // 200 with no OrderNbr in the echo
          ctx.orders.push(made);
          return { ok: true, status: 200, data: {}, text: "" };
        default:
          ctx.orders.push(made);
          return { ok: true, status: 200, data: made, text: "" };
      }
    },
  },
});

// The write-back goes through lib/salesforce.js, so the fake records every field map the
// engine tries to persist — the ORDER of those calls is a tested property, not a detail.
const sfWrites = [];
mock.module("../../lib/salesforce.js", {
  namedExports: {
    sfUpdateRecord: async (obj, id, fields) => {
      sfWrites.push({ obj, id, fields });
      return { ok: true };
    },
  },
});

const mod = await import("./index.js");
const {
  computeCommissionMilestones, commissionPoDescription, buildCommissionPoBody,
  verifyCommissionPo, normalizePurchaseOrder, readPurchaseOrder,
  createCommissionPo, updateCommissionPo, planCommissionPos, planMilestone,
  storedOrderNbr, PO_GATE, M1_CAP, M1_RATE, SPECIMEN_DEFAULTS,
  UPDATABLE_STATUSES, FROZEN_STATUSES, COMMISSION_PROJECT_TASK, COMMISSION_INVENTORY_ID,
  PO_NUMBER_FIELDS, MILESTONE_DATE_FIELDS, milestoneDate, datePart,
  PO_WRITEBACK_FIELDS, PO_STATUSES, commissionPoStatus, syncCommissionPos,
  RECORDED_HEADER_FIELDS, resolveCommissionVendor, commissionVendorFieldNames,
  HOLD_UPDATE_GATE, HOLD_FIELD, MANUALLY_SET_PICKLIST, MANUALLY_SET_STATUS, frozenReason,
  manualSetMarkers, manualSetMessage, m2AmountAfter, commissionPoFieldNames,
} = mod;

async function withGate(state, fn) {
  const prior = PO_GATE.enabled;
  PO_GATE.enabled = state;
  try { return await fn(); } finally { PO_GATE.enabled = prior; }
}
const withPoEnabled = (fn) => withGate(true, fn);
// The gate is OPEN in the committed source now, so "what happens when it is shut" has to
// be arranged explicitly rather than relying on the default.
const withPoDisabled = (fn) => withGate(false, fn);

function reset() {
  ctx.orders = [];
  ctx.puts = [];
  ctx.createBehaviour = "insert";
  ctx.nextNbr = 20001;
  ctx.vendors = DEFAULT_VENDORS();
  ctx.vendorReads = [];
  ctx.vendorLookupFails = false;
  ctx.openDiscardsEdits = false;
  ctx.failStep = null;
  ctx.holdIgnored = false;
  ctx.releaseStatus = "Open";
  ctx.putQueries = [];
  sfWrites.length = 0;
}

/** Every field the write-back has touched so far, flattened in order. */
const writtenFields = () => Object.assign({}, ...sfWrites.map((w) => w.fields));

/** A third-party job with a 7,314 commission — the live R251282 numbers. */
const VALUES = {
  Commission_Deal_Type__c: "3rd Party",
  Acumatica_Project_ID__c: "R261078",
  Sales_Rep_Commission_Amt__c: 7314,
  Sales_Company_Harmon_Solar_or_Third__c: "Blue Sky Solar",
  Commission_PO_M1_Number__c: null,
  Commission_PO_M2_Number__c: null,
  // The two Q13 dates, unset — which is the ORDINARY state on a first budget push.
  Audit_Date_and_DateTime__c: null,
  Scheduled_Install_Date__c: null,
  // D-085 am. 1: a PICKLIST-era job — no dealer, its Customer created before 2026-09-04 —
  // so the vendor still comes from the D4 CSV map by sales company.
  Name: "SOL-R261078",
  CreatedDate: "2026-08-01T16:00:00.000+0000",
  Sundial_Customer__c: "a1P000000000CUSAAA",
  Sundial_Customer__r: { CreatedDate: "2026-08-01T16:00:00.000+0000" },
  Dealer__c: null,
  Dealer__r: null,
};

/** The same job sold after the cutover by a dealer (Heavenly Power, vendor 02118). */
const POST_CUTOVER = { Sundial_Customer__r: { CreatedDate: "2026-09-10T16:00:00.000+0000" } };
const DEALER_DEAL = {
  ...VALUES,
  ...POST_CUTOVER,
  Sales_Company_Harmon_Solar_or_Third__c: null,
  Dealer__c: "a0Y000000000HVNAAA",
  Dealer__r: { Name: "Heavenly Power", Is_Internal__c: false, Acumatica_Vendor_ID__c: "02118" },
};

/** The same job, with both milestones dated. */
const DATED = {
  ...VALUES,
  Audit_Date_and_DateTime__c: "2026-09-04",
  Scheduled_Install_Date__c: "2026-10-15",
};

// ===========================================================================
// The milestone split
// ===========================================================================

test("the M1 cap reproduces the live R251282 split exactly", () => {
  // SLSCOM1 = 2500.00 (the cap biting) and SLSCOM2 = 4814.00 on a 7,314 commission.
  // That a round 2,500 shows up in live attribute data is the best evidence we have
  // that §6's rule is stated correctly, so it is the pinned case.
  const m = computeCommissionMilestones(7314);
  assert.equal(m.m1, 2500);
  assert.equal(m.m2, 4814);
  assert.equal(m.capped, true);
});

test("below the cap, M1 is half", () => {
  const m = computeCommissionMilestones(4000);
  assert.equal(m.m1, 2000);
  assert.equal(m.m2, 2000);
  assert.equal(m.capped, false);
});

test("exactly at the cap boundary, M1 is 2500 and not capped", () => {
  const m = computeCommissionMilestones(5000);
  assert.equal(m.m1, 2500);
  assert.equal(m.m2, 2500);
  assert.equal(m.capped, false, "5000 hits the cap value without exceeding it");
  assert.equal(computeCommissionMilestones(5000.02).capped, true);
});

test("M1 + M2 equal the commission to the cent, at any amount", () => {
  // The balance is computed by SUBTRACTION, never rounded independently — rounding both
  // halves would let them miss the total by a cent on odd amounts, and an unpaid cent is
  // somebody's afternoon.
  for (const total of [0.01, 1, 33.33, 1234.57, 4999.99, 5000.01, 7314, 12345.67, 99999.99]) {
    const m = computeCommissionMilestones(total);
    assert.equal(Math.round((m.m1 + m.m2) * 100) / 100, Math.round(total * 100) / 100, `total ${total}`);
  }
});

test("M1 never exceeds the cap however large the commission", () => {
  for (const total of [5001, 20000, 1e6]) {
    assert.equal(computeCommissionMilestones(total).m1, M1_CAP, `total ${total}`);
  }
  assert.equal(M1_RATE, 0.5);
  assert.equal(M1_CAP, 2500);
});

test("zero, blank and negative commissions produce no payment", () => {
  for (const v of [0, null, undefined, "", "not a number"]) {
    const m = computeCommissionMilestones(v);
    assert.equal(m.m1, 0);
    assert.equal(m.m2, 0);
  }
  // Negative is nonsense rather than a refund; it must not become a positive M1.
  const neg = computeCommissionMilestones(-500);
  assert.equal(neg.m1, 0);
  assert.equal(neg.m2, 0);
});

// ===========================================================================
// Who gets a PO
// ===========================================================================

test("a third-party job with a mapped dealer plans two payments", () => {
  const p = planCommissionPos(VALUES);
  assert.equal(p.ok, true);
  assert.equal(p.vendorId, "01736");
  assert.equal(p.milestones.m1, 2500);
  assert.equal(p.milestones.m2, 4814);
});

test("an INTERNAL deal is refused before vendor resolution is even attempted", () => {
  // D16. The dealer-map's Harmon Solar exclusion is the backstop; this is the front door,
  // and it must not depend on the sales company field at all — an internal deal with a
  // dealer name on it is still an internal deal.
  const p = planCommissionPos({ ...VALUES, Commission_Deal_Type__c: "Internal", Sales_Company_Harmon_Solar_or_Third__c: "Blue Sky Solar" });
  assert.equal(p.ok, false);
  assert.equal(p.reason, "internal_deal");
  assert.match(p.message, /payroll/);
});

test("the dealer-map internal exclusion still catches a bypassed deal-type gate", () => {
  // Belt and braces: pretend the gate above did not exist (deal type says third party)
  // but the company is Harmon Solar. It must still refuse.
  const p = planCommissionPos({ ...VALUES, Sales_Company_Harmon_Solar_or_Third__c: "Harmon Solar" });
  assert.equal(p.ok, false);
  assert.equal(p.reason, "vendor_internal");
});

test("an UNMAPPED dealer refuses, naming the CSV", () => {
  const p = planCommissionPos({ ...VALUES, Sales_Company_Harmon_Solar_or_Third__c: "Solar Bill" });
  assert.equal(p.ok, false);
  assert.equal(p.reason, "vendor_unmapped");
  assert.match(p.message, /dealer-vendor-map\.csv/);
});

test("an INACTIVE vendor refuses per D4", () => {
  const p = planCommissionPos({ ...VALUES, Sales_Company_Harmon_Solar_or_Third__c: "Derek Anderson" });
  assert.equal(p.ok, false);
  assert.equal(p.reason, "vendor_inactive");
});

// ---------------------------------------------------------------------------
// D-085 am. 1 — the vendor is the DEALER's (lib/dealer-terms.js)
// ---------------------------------------------------------------------------

test("a dealer deal is paid to the dealer's Acumatica_Vendor_ID__c — the CSV is not read", () => {
  const p = planCommissionPos(DEALER_DEAL);
  assert.equal(p.ok, true);
  assert.equal(p.vendorId, "02118");
  assert.equal(p.vendorSource, "dealer");
  // A picklist value the CSV maps to a DIFFERENT vendor changes nothing.
  assert.equal(planCommissionPos({ ...DEALER_DEAL, Sales_Company_Harmon_Solar_or_Third__c: "Blue Sky Solar" }).vendorId, "02118");
  // And a pre-cutover deal with a dealer takes the dealer too (the rule's step 1).
  assert.equal(planCommissionPos({ ...DEALER_DEAL, Sundial_Customer__r: VALUES.Sundial_Customer__r }).vendorId, "02118");
});

test("vendor_missing: the dealer has no Acumatica_Vendor_ID__c", () => {
  const p = planCommissionPos({ ...DEALER_DEAL, Dealer__r: { ...DEALER_DEAL.Dealer__r, Acumatica_Vendor_ID__c: null } });
  assert.equal(p.ok, false);
  assert.equal(p.reason, "vendor_missing");
  assert.match(p.message, /Heavenly Power/);
});

test("vendor_internal: an internal DEALER is refused even when the deal type says 3rd Party", () => {
  const p = planCommissionPos({ ...DEALER_DEAL, Dealer__r: { Name: "Harmon Solar", Is_Internal__c: true, Acumatica_Vendor_ID__c: "09999" } });
  assert.equal(p.ok, false);
  assert.equal(p.reason, "vendor_internal", "belt-and-braces behind the internal_deal gate");
  // ...and the front door still comes first.
  assert.equal(planCommissionPos({ ...DEALER_DEAL, Commission_Deal_Type__c: "Internal" }).reason, "internal_deal");
});

test("dealer_missing: post-cutover with no dealer — the picklist is NOT a fallback", () => {
  const p = planCommissionPos({ ...VALUES, ...POST_CUTOVER });
  assert.equal(p.ok, false);
  assert.equal(p.reason, "dealer_missing");
  assert.match(p.message, /SOL-R261078/);
  assert.match(p.message, /Sales Rep/);
});

test("the vendor field list is the dealer-terms rule's", () => {
  assert.ok(commissionVendorFieldNames().includes("Dealer__r.Acumatica_Vendor_ID__c"));
  assert.ok(commissionVendorFieldNames().includes("Sundial_Customer__r.CreatedDate"));
  assert.equal(resolveCommissionVendor(DEALER_DEAL).source, "dealer");
});

test("a v1-calculated record refuses — same marker the budget push uses", () => {
  const p = planCommissionPos({ ...VALUES, Commission_Deal_Type__c: "" });
  assert.equal(p.ok, false);
  assert.equal(p.reason, "budget_calculated_by_previous_engine");
});

test("no Acumatica project, no PO", () => {
  const p = planCommissionPos({ ...VALUES, Acumatica_Project_ID__c: "" });
  assert.equal(p.ok, false);
  assert.equal(p.reason, "no_acumatica_project");
});

test("a zero commission is refused separately from a missing vendor", () => {
  const p = planCommissionPos({ ...VALUES, Sales_Rep_Commission_Amt__c: 0 });
  assert.equal(p.ok, false);
  assert.equal(p.reason, "no_commission");
});

// ===========================================================================
// The create body — minimal, and the specimen is the judge of the rest
// ===========================================================================

test("the create body carries NO id and only the fields we own", () => {
  const body = buildCommissionPoBody({ vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 });
  assert.equal(body.id, undefined, "a create must not carry an id");
  assert.deepEqual(Object.keys(body).sort(), ["Description", "Details", "VendorID"]);
  const line = body.Details[0];
  assert.deepEqual(
    Object.keys(line).sort(),
    ["InventoryID", "LineDescription", "OrderQty", "Project", "ProjectTask", "UOM", "UnitCost"]
  );
  assert.equal(line.InventoryID.value, "M1&M2COM");
  assert.equal(line.ProjectTask.value, "SLPC OUT");
  assert.equal(line.LineDescription.value, "Outside Sales commissions");
  assert.equal(line.OrderQty.value, 1);
  assert.equal(line.UnitCost.value, 2500);
});

test("the create body sends NONE of the derived values", () => {
  // Sending Account/Subaccount/TaxCategory/Warehouse/Terms/Branch would put a second,
  // silently-drifting copy of Harmon's item and vendor configuration in this repo:
  // change the posting class in Acumatica and we would keep overriding it.
  const body = buildCommissionPoBody({ vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 });
  const flat = JSON.stringify(body);
  for (const derived of ["Account", "Subaccount", "TaxCategory", "Warehouse", "Terms", "Branch", "LineType", "Location", "CurrencyID", "Status"]) {
    assert.ok(!flat.includes(derived), `create body must not send ${derived}`);
  }
});

test("SLPC OUT has ONE space, and the item id keeps its ampersand", () => {
  // Both are exact literals from the live scaffold (D18). A second space or a mangled
  // ampersand means the line lands on no project task at all.
  assert.equal(COMMISSION_PROJECT_TASK, "SLPC OUT");
  assert.ok(!COMMISSION_PROJECT_TASK.includes("  "));
  assert.equal(COMMISSION_INVENTORY_ID, "M1&M2COM");
});

test("the description names the milestone and the project, and is a LABEL only", () => {
  assert.equal(commissionPoDescription("M1", "R261078"), "Sales Commission M1 — R261078");
  assert.equal(commissionPoDescription("M2", "R261078"), "Sales Commission M2 — R261078");
  // Idempotency must never consult it — see the dedicated test further down.
});

// ===========================================================================
// Create, verify, and the four ways it can go wrong
// ===========================================================================

test("a create is verified by re-read and returns the OrderNbr to store", async () => {
  await withPoEnabled(async () => {
    reset();
    const r = await createCommissionPo({ vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 });
    assert.equal(r.ok, true);
    assert.equal(r.action, "created");
    assert.equal(r.orderNbr, "020001");
    assert.ok(r.poId && r.lineId);
    assert.equal(ctx.puts.length, 1);
    assert.equal(ctx.puts[0].id, undefined);
  });
});

test("the gate CLOSED means no PO is created at all", async () => {
  // Still tested with the gate open in source: closing it is the emergency stop, so it
  // has to keep working after it stops being the default.
  await withPoDisabled(async () => {
    reset();
    const r = await createCommissionPo({ vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 });
    assert.equal(r.ok, false);
    assert.equal(r.action, "create_blocked");
    assert.equal(ctx.puts.length, 0, "nothing may be written while the gate is closed");
  });
});

test("PO_GATE is OPEN, and its committed value is pinned", () => {
  // Opened 2026-08-24 in a reviewed commit, after all three blockers cleared: §4f fields
  // deployed with FLS, Q13/D23 answered, hand-proof re-run. It is a repo constant rather
  // than an env var precisely so a change in EITHER direction is a diff someone reviewed
  // — including closing it, which is the first move if a project ever grows a second M1.
  assert.equal(PO_GATE.enabled, true, "PO_GATE is open — see the runbook §Results and D-060");
});

test("a rejected create says plainly that nothing needs cleaning up", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.createBehaviour = "reject";
    const r = await createCommissionPo({ vendorId: "01863", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 });
    assert.equal(r.ok, false);
    assert.equal(r.action, "create_failed");
    assert.match(r.message, /nothing needs cleaning up/);
  });
});

test("a create that 200s but produces nothing fails verification", async () => {
  // The expensive silent failure: without the re-read this reports success, the OrderNbr
  // gets stored, and the dealer is never paid.
  await withPoEnabled(async () => {
    reset();
    ctx.createBehaviour = "silent";
    const r = await createCommissionPo({ vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 });
    assert.equal(r.ok, false);
    assert.equal(r.action, "create_unverified");
  });
});

test("a create whose echo carries no OrderNbr fails, and warns about retrying", async () => {
  // The PO exists but we cannot name it, so a retry would raise a second one.
  await withPoEnabled(async () => {
    reset();
    ctx.createBehaviour = "no_nbr";
    const r = await createCommissionPo({ vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 });
    assert.equal(r.ok, false);
    assert.equal(r.action, "create_unverified");
    assert.match(r.message, /the retry will duplicate it/);
  });
});

test("a create with a DERIVED value that differs from the specimen fails verification", async () => {
  // A wrong Account posts real cost to the wrong GL account. Nothing downstream flags
  // that, and it is tedious to unpick a month later — so it fails here.
  await withPoEnabled(async () => {
    reset();
    ctx.createBehaviour = "wrong_account";
    const r = await createCommissionPo({ vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 });
    assert.equal(r.ok, false);
    assert.equal(r.action, "create_unverified");
    assert.match(r.mismatches.join("; "), /Account is "6100", specimen has "5450"/);
  });
});

test("verifyCommissionPo checks every derived value the specimen records", () => {
  const args = { vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 };
  const good = normalizePurchaseOrder(rawPo({ orderNbr: "020001", vendorId: "01736", description: commissionPoDescription("M1", "R261078"), project: "R261078", amount: 2500 }));
  assert.deepEqual(verifyCommissionPo(good, args), []);

  // Each derived field, one at a time, so a missing check cannot hide behind another.
  for (const [field, bad] of [["Account", "6100"], ["Subaccount", "99"], ["TaxCategory", "EXEMPT"], ["WarehouseID", "OTHER"], ["LineType", "Goods for IN"], ["UOM", "HOUR"]]) {
    const po = normalizePurchaseOrder(rawPo({
      orderNbr: "020001", vendorId: "01736", description: commissionPoDescription("M1", "R261078"),
      project: "R261078", amount: 2500, lineOverrides: { [field]: { value: bad } },
    }));
    const out = verifyCommissionPo(po, args);
    assert.ok(out.some((m) => m.includes(field)), `${field} mismatch was not reported: ${out.join("; ")}`);
  }
  assert.deepEqual(Object.keys(SPECIMEN_DEFAULTS.line).sort(), ["Account", "LineType", "OrderQty", "Subaccount", "TaxCategory", "UOM", "WarehouseID"]);
});

test("verification catches a PO for the wrong amount or the wrong vendor", () => {
  const args = { vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 };
  const wrongAmount = normalizePurchaseOrder(rawPo({ orderNbr: "1", vendorId: "01736", description: commissionPoDescription("M1", "R261078"), project: "R261078", amount: 2600 }));
  assert.ok(verifyCommissionPo(wrongAmount, args).some((m) => /UnitCost/.test(m)));
  const wrongVendor = normalizePurchaseOrder(rawPo({ orderNbr: "1", vendorId: "01999", description: commissionPoDescription("M1", "R261078"), project: "R261078", amount: 2500 }));
  assert.ok(verifyCommissionPo(wrongVendor, args).some((m) => /VendorID/.test(m)));
});

test("verification catches a PO with more than one detail line", () => {
  const args = { vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 };
  const raw = rawPo({ orderNbr: "1", vendorId: "01736", description: commissionPoDescription("M1", "R261078"), project: "R261078", amount: 2500 });
  raw.Details.push({ ...raw.Details[0], id: "line-2" });
  assert.ok(verifyCommissionPo(normalizePurchaseOrder(raw), args).some((m) => /exactly 1 detail line/.test(m)));
});

// ===========================================================================
// Idempotency and re-push
// ===========================================================================

test("idempotency reads the STORED OrderNbr, never a description scan", () => {
  assert.equal(storedOrderNbr(VALUES, "M1"), null);
  assert.equal(storedOrderNbr({ ...VALUES, Commission_PO_M1_Number__c: "016102" }, "M1"), "016102");
  assert.equal(storedOrderNbr({ ...VALUES, Commission_PO_M1_Number__c: "  016102  " }, "M1"), "016102");
  assert.equal(storedOrderNbr({ ...VALUES, Commission_PO_M1_Number__c: "   " }, "M1"), null);
  // The two fields are distinct: M1 and M2 must never share a slot, or the second push
  // would "update" the first payment.
  assert.notEqual(PO_NUMBER_FIELDS.M1, PO_NUMBER_FIELDS.M2);
});

test("with no stored number the plan is CREATE; with one it is UPDATE", () => {
  const plan = planCommissionPos(DATED);
  assert.deepEqual(planMilestone(DATED, "M1", plan), { milestone: "M1", action: "create", amount: 2500, milestoneDate: "2026-09-04" });
  const after = { ...DATED, Commission_PO_M1_Number__c: "020001" };
  assert.deepEqual(planMilestone(after, "M1", plan), { milestone: "M1", action: "update", amount: 2500, orderNbr: "020001", milestoneDate: "2026-09-04" });
});

test("a zero milestone is skipped, not created", () => {
  // A commission small enough that M1 is the whole thing leaves M2 at zero; raising a
  // $0 purchase order would be noise in Harmon's books.
  const values = { ...VALUES, Sales_Rep_Commission_Amt__c: 0.02 };
  const plan = planCommissionPos(values);
  assert.equal(plan.milestones.m1, 0.01);
  assert.equal(plan.milestones.m2, 0.01);
  const zero = { ...VALUES, Sales_Rep_Commission_Amt__c: 100 };
  const p2 = planCommissionPos(zero);
  assert.equal(planMilestone(zero, "M2", p2).action, "create");
  // ...and an explicit zero-amount milestone skips.
  assert.equal(planMilestone(VALUES, "M1", { milestones: { m1: 0, m2: 0 } }).action, "skip_zero");
});

test("a re-push UPDATES by guid and never raises a second PO", async () => {
  await withPoEnabled(async () => {
    reset();
    const created = await createCommissionPo({ vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 });
    assert.equal(created.ok, true);
    const nbr = created.orderNbr;

    ctx.puts = [];
    const updated = await updateCommissionPo({ orderNbr: nbr, amount: 2400, storedAmount: 2500, vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1" });
    assert.equal(updated.ok, true);
    assert.equal(updated.action, "updated");
    assert.equal(updated.previousAmount, 2500);
    assert.equal(updated.amount, 2400);
    // Addressed by guid, both header and line.
    assert.equal(ctx.puts.length, 1);
    assert.equal(ctx.puts[0].id, created.poId);
    assert.equal(ctx.puts[0].Details[0].id, created.lineId);
    // And still exactly one PO exists.
    assert.equal(ctx.orders.length, 1);
  });
});

test("an update with the same amount writes nothing", async () => {
  await withPoEnabled(async () => {
    reset();
    const created = await createCommissionPo({ vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 });
    ctx.puts = [];
    const again = await updateCommissionPo({ orderNbr: created.orderNbr, amount: 2500, storedAmount: 2500, vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1" });
    assert.equal(again.ok, true);
    assert.equal(again.action, "unchanged");
    assert.equal(ctx.puts.length, 0);
  });
});

test("a stored OrderNbr pointing at nothing does NOT create a replacement", async () => {
  // The PO may have been deleted deliberately, or the stored number may be wrong.
  // Creating a replacement would risk a second payment on a guess.
  await withPoEnabled(async () => {
    reset();
    const r = await updateCommissionPo({ orderNbr: "099999", amount: 2500, vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1" });
    assert.equal(r.ok, false);
    assert.equal(r.action, "update_missing");
    assert.equal(ctx.puts.length, 0);
    assert.match(r.message, /Not creating a replacement/);
  });
});

// ===========================================================================
// The freeze rule (§6)
// ===========================================================================

test("THE FREEZE RULE IS THE ONLY PROTECTION — Acumatica allows the edit we refuse", async () => {
  // Established by the 2026-08-24 hand-proof re-run, step 8: a PUT to a CANCELED purchase
  // order returns 200 and the change PERSISTS. There is no API-side freeze to fall back
  // on. If updateCommissionPo's status check is ever weakened, bypassed for a "small"
  // correction, or moved behind a flag, nothing else anywhere stops a silent edit to a
  // released document.
  //
  // Only `Canceled` was tested live. Completed and Closed were not, and we deliberately
  // do not care: everything off the allow-list is never-touch whether or not the API
  // happens to agree.
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(rawPo({
      orderNbr: "016442", vendorId: "01736", description: commissionPoDescription("M1", "R261078"),
      project: "R261078", amount: 2400, status: "Canceled",
    }));
    const r = await updateCommissionPo({ orderNbr: "016442", amount: 9999, vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1" });
    assert.equal(r.ok, false);
    assert.equal(r.action, "frozen");
    assert.equal(ctx.puts.length, 0, "not one byte may reach Acumatica for a canceled PO");
  });
});

test("DENY BY DEFAULT — an unrecognised status is frozen, not updatable", async () => {
  // The guard is the ALLOW-list, never the deny-list. A status Acumatica invents in a
  // future release, a typo, an empty string, a null — all must fail closed. This is what
  // makes the FROZEN_STATUSES spelling non-load-bearing, which matters because it WAS
  // wrong: it read "Cancelled" (two Ls) while Acumatica returns "Canceled" (one), so it
  // had never matched anything. Harmless only because nothing ever used it as the guard.
  for (const status of ["Canceled", "Cancelled", "Completed", "Closed", "Pending Approval", "Rejected", "", null, "OPEN", "open"]) {
    await withPoEnabled(async () => {
      reset();
      ctx.orders.push(rawPo({
        orderNbr: "016442", vendorId: "01736", description: commissionPoDescription("M1", "R261078"),
        project: "R261078", amount: 2400, status,
      }));
      const r = await updateCommissionPo({ orderNbr: "016442", amount: 9999, vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1" });
      assert.equal(r.ok, false, `status ${JSON.stringify(status)} must not be updatable`);
      assert.equal(r.action, "frozen", `status ${JSON.stringify(status)} must be frozen`);
      assert.equal(ctx.puts.length, 0, `status ${JSON.stringify(status)}: nothing may be written`);
    });
  }
  // Note "OPEN"/"open" above: the allow-list is case-SENSITIVE, so a casing change from
  // Acumatica fails safe rather than silently unlocking the document.

  // And the shape a truncated or changed response would produce: no Status field at all.
  // A guard written as "is it frozen?" would read undefined and let this through.
  await withPoEnabled(async () => {
    reset();
    const noStatus = rawPo({
      orderNbr: "016442", vendorId: "01736", description: commissionPoDescription("M1", "R261078"),
      project: "R261078", amount: 2400,
    });
    delete noStatus.Status;
    ctx.orders.push(noStatus);
    const r = await updateCommissionPo({ orderNbr: "016442", amount: 9999, vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1" });
    assert.equal(r.action, "frozen", "a PO with no Status at all must be frozen");
    assert.equal(ctx.puts.length, 0);
  });
});

test("the frozen-status list matches what Acumatica actually returns", () => {
  // `Canceled`, one L — read off PO 016442 after it was canceled in the UI, 2026-08-24.
  assert.ok(FROZEN_STATUSES.includes("Canceled"));
  assert.ok(!FROZEN_STATUSES.includes("Cancelled"), "two Ls is not what Acumatica sends");
});

test("Open and On Hold are updatable; Completed / Closed / Canceled are frozen", async () => {
  assert.deepEqual([...UPDATABLE_STATUSES], ["Open", "On Hold"]);
  assert.deepEqual([...FROZEN_STATUSES], ["Completed", "Closed", "Canceled"]);

  for (const status of FROZEN_STATUSES) {
    await withPoEnabled(async () => {
      reset();
      ctx.orders.push(rawPo({ orderNbr: "016102", vendorId: "01736", description: commissionPoDescription("M1", "R261078"), project: "R261078", amount: 2500, status }));
      const r = await updateCommissionPo({ orderNbr: "016102", amount: 2900, vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1" });
      assert.equal(r.ok, false, `${status} should be frozen`);
      assert.equal(r.action, "frozen");
      assert.equal(ctx.puts.length, 0, `${status}: nothing may be written to a frozen PO`);
      // The delta is REPORTED, because §6 says it lands in M2 — a frozen PO that just
      // said "no" would leave the difference unpaid and unexplained.
      assert.equal(r.currentAmount, 2500);
      assert.equal(r.requestedAmount, 2900);
      assert.match(r.message, /belongs in M2/);
    });
  }
});

test("an On Hold PO is still updatable — status is lifecycle state, not a derived default", async () => {
  // Regression: an early version listed Status: "Open" among the specimen's derived
  // defaults, so verification rejected every On Hold order — and did it with a message
  // about the specimen, pointing at entirely the wrong thing. A PO legitimately moves
  // Open -> On Hold -> Completed; only the freeze rule gets to care.
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(rawPo({ orderNbr: "016102", vendorId: "01736", description: commissionPoDescription("M1", "R261078"), project: "R261078", amount: 2500, status: "On Hold" }));
    const r = await updateCommissionPo({ orderNbr: "016102", amount: 2600, storedAmount: 2500, vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1" });
    assert.equal(r.ok, true);
    assert.equal(r.action, "updated");
  });
});

test("TERMS IS RECORDED, NOT ASSERTED — a different vendor is not a failed create", async () => {
  // The 2026-08-24 hand-proof caught this: the specimen (vendor 02118) has Terms 30D, the
  // proof PO (vendor 01736) came back DOR, and both are correct because Terms derives
  // from the vendor's payment terms. Asserting the specimen's value would have rejected a
  // perfectly good Blue Sky Solar PO on the first live job — 35 mapped dealers, no shared
  // terms. Regression-pinned so it cannot creep back into SPECIMEN_DEFAULTS.
  assert.ok(!("Terms" in SPECIMEN_DEFAULTS.header), "Terms is vendor-derived, not a fixed specimen value");
  assert.deepEqual([...RECORDED_HEADER_FIELDS], ["terms"]);

  const args = { vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 };
  const dor = normalizePurchaseOrder(rawPo({
    orderNbr: "016442", vendorId: "01736", description: commissionPoDescription("M1", "R261078"),
    project: "R261078", amount: 2500, terms: "DOR",
  }));
  assert.deepEqual(verifyCommissionPo(dor, args), [], "DOR terms must not fail verification");

  // ...but the value still reaches the caller rather than vanishing.
  await withPoEnabled(async () => {
    reset();
    ctx.createBehaviour = "other_terms";
    const r = await createCommissionPo(args);
    assert.equal(r.ok, true);
    assert.equal(r.recorded.terms, "DOR");
  });
});

test("the header values that ARE asserted are the ones that do not vary by vendor", () => {
  // Branch, Currency and Location are properties of "a commission PO"; Terms is a
  // property of whoever is being paid. That is the whole rule.
  assert.deepEqual(Object.keys(SPECIMEN_DEFAULTS.header).sort(), ["Branch", "CurrencyID", "Location", "Type"]);
});

test("verification does not police Status or Hold", () => {
  const args = { vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 };
  for (const status of ["Open", "On Hold", "Completed", "Closed"]) {
    const po = normalizePurchaseOrder(rawPo({ orderNbr: "1", vendorId: "01736", description: commissionPoDescription("M1", "R261078"), project: "R261078", amount: 2500, status }));
    assert.deepEqual(verifyCommissionPo(po, args), [], `${status} should not be a verification failure`);
  }
  assert.ok(!("Status" in SPECIMEN_DEFAULTS.header), "Status is lifecycle state, not a derived default");
  assert.ok(!("Hold" in SPECIMEN_DEFAULTS.header), "Hold is lifecycle state, not a derived default");
});

test("a brand new PO that arrives already frozen fails the create", async () => {
  // Not a specimen mismatch — a create that lands in a state the freeze rule would never
  // let us correct. Different problem, so it is checked in a different place.
  await withPoEnabled(async () => {
    reset();
    ctx.createBehaviour = "born_closed";
    const r = await createCommissionPo({ vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 });
    assert.equal(r.ok, false);
    assert.equal(r.action, "create_unverified");
    assert.match(r.mismatches.join("; "), /already Closed/);
  });
});

test("an ambiguous OrderNbr throws rather than picking one", async () => {
  reset();
  const a = rawPo({ orderNbr: "016102", vendorId: "01736", description: "x", project: "R261078", amount: 100 });
  const b = { ...rawPo({ orderNbr: "016102", vendorId: "01736", description: "y", project: "R261078", amount: 200 }), id: "po-guid-dup" };
  ctx.orders.push(a, b);
  await assert.rejects(() => readPurchaseOrder("016102"), /matched 2 purchase orders/);
});

// ===========================================================================
// The milestone dates (Q13) — cargo, NOT a creation gate
// ===========================================================================

test("Q13 names the two date fields, and they are the AUDITDATE / INCOMDATE sources", () => {
  // Reusing the fields that already feed the Acumatica attributes is the point: the PO
  // and the attribute sync cannot end up disagreeing about when a milestone happened.
  assert.equal(MILESTONE_DATE_FIELDS.M1, "Audit_Date_and_DateTime__c");
  assert.equal(MILESTONE_DATE_FIELDS.M2, "Scheduled_Install_Date__c");
});

test("datePart takes the date out of whatever Acumatica or Salesforce hands over", () => {
  assert.equal(datePart("2026-09-04T00:00:00+00:00"), "2026-09-04");
  assert.equal(datePart("2026-09-04"), "2026-09-04");
  for (const junk of [null, undefined, "", "   ", "not a date", 0]) {
    assert.equal(datePart(junk), null, `${JSON.stringify(junk)} is not a date`);
  }
});

test("milestoneDate reads each milestone's own field, and blank means blank", () => {
  assert.equal(milestoneDate(DATED, "M1"), "2026-09-04");
  assert.equal(milestoneDate(DATED, "M2"), "2026-10-15");
  assert.equal(milestoneDate(VALUES, "M1"), null);
  assert.equal(milestoneDate(VALUES, "M2"), null);
  assert.throws(() => milestoneDate(DATED, "M3"), /unknown milestone/);
});

test("A MISSING MILESTONE DATE DOES NOT BLOCK THE PO", () => {
  // The load-bearing test for the 2026-08-24 workflow correction. §6 originally read as
  // though M1 waited for Site Audit Complete; Harmon's actual workflow raises BOTH POs on
  // the first budget push, when neither date is usually set yet. If this ever fails, a
  // dealer stops getting paid until somebody notices.
  const plan = planCommissionPos(VALUES);
  assert.equal(planMilestone(VALUES, "M1", plan).action, "create");
  assert.equal(planMilestone(VALUES, "M2", plan).action, "create");
  assert.equal(planMilestone(VALUES, "M1", plan).milestoneDate, null);
});

test("with no milestone date the create body is EXACTLY the specimen's shape", () => {
  // Sending no date is what makes the PO identical to every one Harmon has raised by
  // hand: Acumatica defaults Requested/Promised to the order date, as PO 016102 shows.
  const body = buildCommissionPoBody({ vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 });
  assert.deepEqual(
    Object.keys(body.Details[0]).sort(),
    ["InventoryID", "LineDescription", "OrderQty", "Project", "ProjectTask", "UOM", "UnitCost"]
  );
});

test("with a milestone date the line carries it in BOTH Requested and Promised", () => {
  const body = buildCommissionPoBody({
    vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500,
    milestoneDate: "2026-09-04",
  });
  assert.equal(body.Details[0].Requested.value, "2026-09-04");
  assert.equal(body.Details[0].Promised.value, "2026-09-04");
  // A timestamp from Salesforce is normalised, not passed through raw.
  const b2 = buildCommissionPoBody({
    vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M2", amount: 4814,
    milestoneDate: "2026-10-15T00:00:00.000+0000",
  });
  assert.equal(b2.Details[0].Promised.value, "2026-10-15");
});

test("a date we asked for is VERIFIED; a date we did not ask for is not policed", () => {
  const args = { vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500 };
  const po = normalizePurchaseOrder(rawPo({
    orderNbr: "1", vendorId: "01736", description: commissionPoDescription("M1", "R261078"),
    project: "R261078", amount: 2500, when: "2026-08-24",
  }));
  // No milestoneDate requested -> the order-date default is none of our business.
  assert.deepEqual(verifyCommissionPo(po, args), []);
  // Requested and ignored -> a mismatch, found on the create rather than never.
  const out = verifyCommissionPo(po, { ...args, milestoneDate: "2026-09-04" });
  assert.ok(out.some((m) => /Requested/.test(m)), out.join("; "));
  assert.ok(out.some((m) => /Promised/.test(m)), out.join("; "));
});

test("a create carries the milestone date through to the PO", async () => {
  await withPoEnabled(async () => {
    reset();
    const r = await createCommissionPo({
      vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500,
      milestoneDate: "2026-09-04",
    });
    assert.equal(r.ok, true);
    assert.equal(r.milestoneDate, "2026-09-04");
    assert.equal(ctx.puts[0].Details[0].Requested.value, "2026-09-04");
  });
});

test("a rescheduled install updates the PO even though the amount has not moved", async () => {
  await withPoEnabled(async () => {
    reset();
    const created = await createCommissionPo({
      vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M2", amount: 4814,
      milestoneDate: "2026-10-15",
    });
    ctx.puts = [];
    const moved = await updateCommissionPo({
      orderNbr: created.orderNbr, amount: 4814, storedAmount: 4814, vendorId: "01736",
      acumaticaProjectId: "R261078", milestone: "M2", milestoneDate: "2026-11-02",
    });
    assert.equal(moved.ok, true);
    assert.equal(moved.action, "updated");
    assert.equal(moved.previousMilestoneDate, "2026-10-15");
    assert.equal(moved.milestoneDate, "2026-11-02");
    assert.equal(ctx.puts.length, 1);
  });
});

test("an unchanged amount AND an unchanged date write nothing at all", async () => {
  await withPoEnabled(async () => {
    reset();
    const created = await createCommissionPo({
      vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500,
      milestoneDate: "2026-09-04",
    });
    ctx.puts = [];
    const again = await updateCommissionPo({
      orderNbr: created.orderNbr, amount: 2500, storedAmount: 2500, vendorId: "01736",
      acumaticaProjectId: "R261078", milestone: "M1", milestoneDate: "2026-09-04",
    });
    assert.equal(again.action, "unchanged");
    assert.equal(ctx.puts.length, 0);
  });
});

test("a BLANK milestone date never clears a date already on the PO", async () => {
  // Harmon may have set it by hand. Un-setting a date nobody asked us to un-set is
  // exactly the quiet edit to a live document this engine exists to avoid.
  await withPoEnabled(async () => {
    reset();
    const created = await createCommissionPo({
      vendorId: "01736", acumaticaProjectId: "R261078", milestone: "M1", amount: 2500,
      milestoneDate: "2026-09-04",
    });
    ctx.puts = [];
    const r = await updateCommissionPo({
      orderNbr: created.orderNbr, amount: 2500, storedAmount: 2500, vendorId: "01736",
      acumaticaProjectId: "R261078", milestone: "M1", milestoneDate: null,
    });
    assert.equal(r.action, "unchanged");
    assert.equal(ctx.puts.length, 0);
    assert.equal(normalizePurchaseOrder(ctx.orders[0]).lines[0].promised, "2026-09-04");
  });
});

// ===========================================================================
// The §4f write-back (salesforce/v4-commission-po-fields/)
// ===========================================================================

test("the write-back field names match the deployed package exactly", () => {
  // A typo here is an INVALID_FIELD at runtime on the one write that must not fail.
  assert.deepEqual(PO_WRITEBACK_FIELDS.M1, {
    number: "Commission_PO_M1_Number__c",
    amount: "Commission_PO_M1_Amount__c",
    created: "Commission_PO_M1_Created__c",
  });
  assert.deepEqual(PO_WRITEBACK_FIELDS.M2, {
    number: "Commission_PO_M2_Number__c",
    amount: "Commission_PO_M2_Amount__c",
    created: "Commission_PO_M2_Created__c",
  });
  assert.equal(PO_WRITEBACK_FIELDS.status, "Commission_PO_Status__c");
  assert.equal(PO_WRITEBACK_FIELDS.error, "Commission_PO_Error__c");
  // And the number fields are the SAME ones idempotency reads, or a create would store
  // its OrderNbr somewhere the next run does not look — a duplicate payment.
  assert.equal(PO_WRITEBACK_FIELDS.M1.number, PO_NUMBER_FIELDS.M1);
  assert.equal(PO_WRITEBACK_FIELDS.M2.number, PO_NUMBER_FIELDS.M2);
});

test("every status the engine writes is in the restricted picklist", () => {
  assert.deepEqual([...PO_STATUSES], ["None", "M1 Raised", "Both Raised", "Failed", "Frozen"]);
  const produced = [
    commissionPoStatus([], {}),
    commissionPoStatus([{ ok: true, action: "created" }], { M1: "020001" }),
    commissionPoStatus([{ ok: true, action: "created" }], { M1: "020001", M2: "020002" }),
    commissionPoStatus([{ ok: false, action: "create_failed" }], {}),
    commissionPoStatus([{ ok: false, action: "frozen" }], { M1: "016102" }),
  ];
  assert.deepEqual(produced, ["None", "M1 Raised", "Both Raised", "Failed", "Frozen"]);
  for (const s of produced) assert.ok(PO_STATUSES.includes(s), `${s} is not a valid picklist value`);
});

test("Failed outranks Frozen — a run with a real failure is a run somebody must look at", () => {
  const both = commissionPoStatus(
    [{ ok: false, action: "frozen" }, { ok: false, action: "create_failed" }],
    { M1: "016102" }
  );
  assert.equal(both, "Failed");
  // ...and Frozen outranks the raised-count, so a frozen PO is never hidden behind a
  // reassuring "Both Raised".
  assert.equal(commissionPoStatus([{ ok: false, action: "frozen" }], { M1: "a", M2: "b" }), "Frozen");
});

// ===========================================================================
// syncCommissionPos — the whole job, end to end
// ===========================================================================

const NOW = () => "2026-08-24T12:00:00.000Z";
const sync = (values) => syncCommissionPos("a0X000000000001AAA", values, { now: NOW });

test("a clean run raises both POs and stores both numbers", async () => {
  await withPoEnabled(async () => {
    reset();
    const r = await sync(DATED);
    assert.equal(r.ok, true);
    assert.equal(r.status, "Both Raised");
    assert.equal(ctx.orders.length, 2);

    const f = writtenFields();
    assert.equal(f.Commission_PO_M1_Number__c, "020001");
    assert.equal(f.Commission_PO_M2_Number__c, "020002");
    assert.equal(f.Commission_PO_M1_Amount__c, 2500);
    assert.equal(f.Commission_PO_M2_Amount__c, 4814);
    assert.equal(f.Commission_PO_M1_Created__c, NOW());
    assert.equal(f.Commission_PO_Status__c, "Both Raised");
    assert.equal(f.Commission_PO_Error__c, null);

    // Each PO carries its OWN milestone date.
    const dates = ctx.orders.map((o) => normalizePurchaseOrder(o).lines[0].promised);
    assert.deepEqual(dates, ["2026-09-04", "2026-10-15"]);
  });
});

test("M1's ORDER NUMBER IS STORED BEFORE M2 IS ATTEMPTED", async () => {
  // The property the whole write-back ordering exists for. If M2 fails, or the Lambda
  // dies between the two, M1's number must already be on the record — otherwise the next
  // push sees a blank field and raises a SECOND M1.
  await withPoEnabled(async () => {
    reset();
    await sync(DATED);
    const firstM1 = sfWrites.findIndex((w) => "Commission_PO_M1_Number__c" in w.fields);
    const firstM2 = sfWrites.findIndex((w) => "Commission_PO_M2_Number__c" in w.fields);
    assert.ok(firstM1 >= 0 && firstM2 > firstM1, `M1 stored at ${firstM1}, M2 at ${firstM2}`);
    // And M1's number is written before M2's PO is even created.
    assert.ok(sfWrites.length >= 3, "expected a write per milestone plus the final status");
  });
});

test("a re-push updates both POs and never raises a third", async () => {
  await withPoEnabled(async () => {
    reset();
    await sync(DATED);
    const after = { ...DATED, Commission_PO_M1_Number__c: "020001", Commission_PO_M2_Number__c: "020002", Commission_PO_M1_Amount__c: 2500, Commission_PO_M2_Amount__c: 4814 };
    sfWrites.length = 0;

    // The commission has grown: M1 is already at the cap so the whole delta lands in M2.
    const r = await sync({ ...after, Sales_Rep_Commission_Amt__c: 8000 });
    assert.equal(r.ok, true);
    assert.equal(ctx.orders.length, 2, "a re-push must never create a third PO");
    const f = writtenFields();
    assert.equal(f.Commission_PO_M1_Amount__c, 2500);
    assert.equal(f.Commission_PO_M2_Amount__c, 5500);
    // `Created` is a creation stamp and must not be re-stamped on an update.
    assert.ok(!("Commission_PO_M1_Created__c" in f), "Created must not move on an update");
  });
});

test("an internal deal writes None and NO error — it is the system working", async () => {
  await withPoEnabled(async () => {
    reset();
    const r = await sync({ ...DATED, Commission_Deal_Type__c: "Internal" });
    assert.equal(r.reason, "internal_deal");
    assert.equal(ctx.orders.length, 0);
    const f = writtenFields();
    assert.equal(f.Commission_PO_Status__c, "None");
    assert.equal(f.Commission_PO_Error__c, null, "an internal deal is not a failure");
  });
});

test("an unmapped dealer writes Failed and the message that names the fix", async () => {
  await withPoEnabled(async () => {
    reset();
    const r = await sync({ ...DATED, Sales_Company_Harmon_Solar_or_Third__c: "Solar Bill" });
    assert.equal(r.ok, false);
    assert.equal(ctx.orders.length, 0, "nothing may be raised without a resolved vendor");
    const f = writtenFields();
    assert.equal(f.Commission_PO_Status__c, "Failed");
    assert.match(f.Commission_PO_Error__c, /dealer-vendor-map\.csv/);
  });
});

test("a frozen M1 at the rule's amount: M2 takes the balance and the record reads Both Raised", async () => {
  // Superseded 2026-10-23 (D-057 am. 1): a frozen M1 used to stamp the record Frozen with
  // "the difference belongs in M2" — and then never put it there. M2 now absorbs it, so a
  // frozen M1 is a normal resting state, not something for a person.
  await withPoEnabled(async () => {
    reset();
    // M1 already raised and since Completed; M2 already raised and still Open.
    ctx.orders.push(rawPo({ orderNbr: "016102", vendorId: "01736", description: commissionPoDescription("M1", "R261078"), project: "R261078", amount: 2500, status: "Completed", when: "2026-09-04" }));
    ctx.orders.push(rawPo({ orderNbr: "016103", vendorId: "01736", description: commissionPoDescription("M2", "R261078"), project: "R261078", amount: 4814, status: "Open", when: "2026-10-15" }));
    const r = await sync({
      ...DATED,
      Sales_Rep_Commission_Amt__c: 9000, // M1 stays at 2500, M2 becomes 6500
      Commission_PO_M1_Number__c: "016102", Commission_PO_M1_Amount__c: 2500,
      Commission_PO_M2_Number__c: "016103", Commission_PO_M2_Amount__c: 4814,
    });
    assert.equal(r.status, "Both Raised");
    assert.equal(r.ok, true);
    const f = writtenFields();
    assert.equal(f.Commission_PO_Status__c, "Both Raised");
    assert.equal(f.Commission_PO_Error__c, null);
    assert.equal(normalizePurchaseOrder(ctx.orders[1]).lines[0].unitCost, 6500);
    assert.equal(normalizePurchaseOrder(ctx.orders[0]).lines[0].unitCost, 2500, "the frozen M1 is never touched");
  });
});

test("the gate CLOSED means syncCommissionPos writes NOTHING, to either system", async () => {
  // Not belt-and-braces: without the top-level check, gate-closed refusals would flow
  // into the status reducer and stamp `Failed` on every solar record the push touched.
  await withPoDisabled(async () => {
    reset();
    const r = await sync(DATED);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "gate_closed");
    assert.equal(ctx.puts.length, 0);
    assert.equal(sfWrites.length, 0, "the gate being shut is not a fact about the job");
  });
});

// ---------------------------------------------------------------------------
// D-085 am. 1 — vendor_not_in_acumatica: the vendor must exist before a CREATE
// ---------------------------------------------------------------------------

test("a dealer deal raises both POs against the dealer's vendor, after checking it exists", async () => {
  await withPoEnabled(async () => {
    reset();
    const r = await sync({ ...DEALER_DEAL, Audit_Date_and_DateTime__c: "2026-09-12" });
    assert.equal(r.status, "Both Raised");
    assert.deepEqual(ctx.vendorReads, ["02118"], "looked up once per run, by the dealer's id");
    assert.ok(ctx.orders.every((o) => o.VendorID.value === "02118"));
  });
});

test("vendor_not_in_acumatica: an unknown vendor id creates NOTHING and names the id", async () => {
  await withPoEnabled(async () => {
    reset();
    const r = await sync({ ...DEALER_DEAL, Dealer__r: { ...DEALER_DEAL.Dealer__r, Acumatica_Vendor_ID__c: "02119" } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "vendor_not_in_acumatica");
    assert.equal(ctx.puts.length, 0, "no PO without a real vendor");
    const f = writtenFields();
    assert.equal(f.Commission_PO_Status__c, "Failed");
    assert.match(f.Commission_PO_Error__c, /02119/);
  });
});

test("vendor_not_in_acumatica: an INACTIVE vendor refuses too — on the legacy path as well", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.vendors["01736"].status = "Inactive"; // the CSV says Active; Acumatica now says otherwise
    const r = await sync(DATED);
    assert.equal(r.reason, "vendor_not_in_acumatica");
    assert.match(writtenFields().Commission_PO_Error__c, /01736.*Inactive/);
    assert.equal(ctx.puts.length, 0);
  });
});

test("an Acumatica outage on the vendor check refuses rather than raising blind", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.vendorLookupFails = true;
    const r = await sync(DEALER_DEAL);
    assert.equal(r.reason, "vendor_lookup_failed");
    assert.equal(ctx.puts.length, 0);
  });
});

test("updates only (both POs already raised) skip the vendor check — the re-read verifies the vendor", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(rawPo({ orderNbr: "016102", vendorId: "02118", description: commissionPoDescription("M1", "R261078"), project: "R261078", amount: 2500 }));
    ctx.orders.push(rawPo({ orderNbr: "016103", vendorId: "02118", description: commissionPoDescription("M2", "R261078"), project: "R261078", amount: 4814 }));
    const r = await sync({ ...DEALER_DEAL, Commission_PO_M1_Number__c: "016102", Commission_PO_M2_Number__c: "016103" });
    assert.equal(r.status, "Both Raised");
    assert.deepEqual(ctx.vendorReads, []);
  });
});

test("PO_NUMBER_FIELDS idempotency is unchanged on the dealer path: a stored M1 is updated, never re-raised", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(rawPo({ orderNbr: "016102", vendorId: "02118", description: commissionPoDescription("M1", "R261078"), project: "R261078", amount: 2500 }));
    const r = await sync({ ...DEALER_DEAL, Commission_PO_M1_Number__c: "016102" });
    assert.equal(r.status, "Both Raised");
    const m1s = ctx.orders.filter((o) => o.Description.value === commissionPoDescription("M1", "R261078"));
    assert.equal(m1s.length, 1, "exactly one M1, ever");
    assert.deepEqual(PO_NUMBER_FIELDS, { M1: "Commission_PO_M1_Number__c", M2: "Commission_PO_M2_Number__c" });
  });
});

// ===========================================================================
// 2026-10-23 — the update fix: logging, Hold → PUT → release, the two guards
// (runbook "2026-10-23 — Why amount updates do not stick"; D-057 amendments 1 + 2)
// ===========================================================================

const M1_DESC = commissionPoDescription("M1", "R261078");
const M2_DESC = commissionPoDescription("M2", "R261078");
const po = (orderNbr, milestone, amount, opts = {}) =>
  rawPo({ orderNbr, vendorId: "01736", description: milestone === "M1" ? M1_DESC : M2_DESC, project: "R261078", amount, ...opts });
const upd = (orderNbr, milestone, amount, extra = {}) =>
  updateCommissionPo({ orderNbr, milestone, amount, vendorId: "01736", acumaticaProjectId: "R261078", ...extra });
const unitCost = (i) => normalizePurchaseOrder(ctx.orders[i]).lines[0].unitCost;
const statusOf = (i) => ctx.orders[i].Status.value;
const holdPuts = () => ctx.puts.filter((p) => p.Hold).map((p) => p.Hold.value);

async function withHoldGate(state, fn) {
  const prior = HOLD_UPDATE_GATE.enabled;
  HOLD_UPDATE_GATE.enabled = state;
  try { return await fn(); } finally { HOLD_UPDATE_GATE.enabled = prior; }
}
async function withManualPicklist(state, fn) {
  const prior = MANUALLY_SET_PICKLIST.deployed;
  MANUALLY_SET_PICKLIST.deployed = state;
  try { return await fn(); } finally { MANUALLY_SET_PICKLIST.deployed = prior; }
}
async function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try { await fn(); } finally { console.log = orig; }
  return lines;
}

test("committed values: the hold gate is CLOSED, Hold is a field, Manually Set is not deployed yet", () => {
  // Opening the gate is Tim's reviewed diff after scripts/probe-po-hold-update.mjs passes.
  assert.equal(HOLD_UPDATE_GATE.enabled, false);
  // Default/25.200.001 has no PurchaseOrder hold/release ACTION (swagger read 2026-10-23).
  assert.equal(HOLD_FIELD, "Hold");
  // Commission_PO_Status__c is restricted: writing an undeployed value fails the update.
  assert.equal(MANUALLY_SET_PICKLIST.deployed, false);
  assert.equal(MANUALLY_SET_STATUS, "Manually Set");
  assert.ok(!PO_STATUSES.includes("Manually Set"), "not in the deployed picklist yet");
});

// --- A. Logging -----------------------------------------------------------

test("A: the update PUT is logged with ids and amount, and the echo with what Acumatica returned", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(po("016939", "M2", 11868));
    const lines = await captureLogs(() => upd("016939", "M2", 12508, { storedAmount: 11868 }));
    const sent = lines.find((l) => l.startsWith("commission-po UPDATE amount M2"));
    const echo = lines.find((l) => l.startsWith("commission-po UPDATE-ECHO amount M2"));
    assert.ok(sent, lines.join("\n"));
    assert.match(sent, /nbr=016939 po=po-guid-016939 line=line-guid-016939 amount=12508/);
    assert.match(echo, /http=200 unitCost=12508 status=Open hold=false/);
    // The echo is only evidence if it carries the line.
    assert.deepEqual(ctx.putQueries[0], { $expand: "Details" });
  });
});

test("A: with the hold gate closed an Open PO still gets today's single PUT — and the discard is caught and logged", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.openDiscardsEdits = true;
    ctx.orders.push(po("016939", "M2", 11868));
    let r;
    const lines = await captureLogs(async () => { r = await upd("016939", "M2", 12508, { storedAmount: 11868 }); });
    assert.equal(ctx.puts.length, 1);
    assert.equal(holdPuts().length, 0, "no Hold toggling while the gate is closed");
    assert.equal(r.ok, false);
    assert.equal(r.action, "update_unverified");
    assert.equal(r.step, "amount");
    assert.match(r.message, /UnitCost is 11868, expected 12508/);
    // The question CloudWatch could not answer in October: did the echo already show the old amount?
    assert.match(lines.find((l) => l.includes("UPDATE-ECHO")), /unitCost=11868/);
  });
});

// --- C. Hold → amount → release -----------------------------------------------

test("C gate open: an Open PO is held, updated, released — and the edit sticks", async () => {
  await withPoEnabled(() => withHoldGate(true, async () => {
    reset();
    ctx.openDiscardsEdits = true;
    ctx.orders.push(po("016939", "M2", 11868));
    const r = await upd("016939", "M2", 12508, { storedAmount: 11868 });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.action, "updated");
    assert.equal(r.via, "hold");
    assert.deepEqual(holdPuts(), [true, false], "hold first, release last");
    assert.equal(ctx.puts.length, 3);
    assert.equal(unitCost(0), 12508);
    assert.equal(statusOf(0), "Open", "back where it started");
  }));
});

test("C gate open: an On Hold PO gets the single proven PUT and is left On Hold", async () => {
  await withPoEnabled(() => withHoldGate(true, async () => {
    reset();
    ctx.orders.push(po("016442", "M1", 2400, { status: "On Hold" }));
    const r = await upd("016442", "M1", 2500, { storedAmount: 2400 });
    assert.equal(r.action, "updated");
    assert.equal(r.via, "single_put");
    assert.deepEqual(holdPuts(), [], "never released — someone else put it on hold");
    assert.equal(statusOf(0), "On Hold");
  }));
});

test("C step hold refused: nothing else is sent and the outcome names the step", async () => {
  await withPoEnabled(() => withHoldGate(true, async () => {
    reset();
    ctx.failStep = "hold";
    ctx.orders.push(po("016939", "M2", 11868));
    const r = await upd("016939", "M2", 12508, { storedAmount: 11868 });
    assert.equal(r.ok, false);
    assert.equal(r.action, "update_failed");
    assert.equal(r.step, "hold");
    assert.equal(ctx.puts.length, 1);
    assert.equal(unitCost(0), 11868);
  }));
});

test("C step hold not honoured (200, still Open): the amount is never sent", async () => {
  await withPoEnabled(() => withHoldGate(true, async () => {
    reset();
    ctx.holdIgnored = true;
    ctx.orders.push(po("016939", "M2", 11868));
    const r = await upd("016939", "M2", 12508, { storedAmount: 11868 });
    assert.equal(r.action, "update_unverified");
    assert.equal(r.step, "hold");
    assert.match(r.message, /reads Open/);
    assert.equal(ctx.puts.length, 1);
  }));
});

test("C step amount refused: the PO is LEFT ON HOLD and the message says so", async () => {
  await withPoEnabled(() => withHoldGate(true, async () => {
    reset();
    ctx.failStep = "amount";
    ctx.orders.push(po("016939", "M2", 11868));
    const r = await upd("016939", "M2", 12508, { storedAmount: 11868 });
    assert.equal(r.action, "update_failed");
    assert.equal(r.step, "amount");
    assert.match(r.message, /LEFT ON HOLD/);
    assert.equal(statusOf(0), "On Hold", "On Hold cannot be received or billed — the safe place to stop");
    assert.deepEqual(holdPuts(), [true], "no release after a failed amount");
  }));
});

test("C step release refused: amount written and verified, PO still On Hold, outcome names release", async () => {
  await withPoEnabled(() => withHoldGate(true, async () => {
    reset();
    ctx.failStep = "release";
    ctx.orders.push(po("016939", "M2", 11868));
    const r = await upd("016939", "M2", 12508, { storedAmount: 11868 });
    assert.equal(r.ok, false);
    assert.equal(r.action, "update_failed");
    assert.equal(r.step, "release");
    assert.equal(r.amountWritten, 12508);
    assert.match(r.message, /STILL ON HOLD/);
    assert.equal(unitCost(0), 12508);
    assert.equal(statusOf(0), "On Hold");
  }));
});

test("C release re-enters approval: reported as such, not as success", async () => {
  await withPoEnabled(() => withHoldGate(true, async () => {
    reset();
    ctx.releaseStatus = "Pending Approval";
    ctx.orders.push(po("016939", "M2", 11868));
    const r = await upd("016939", "M2", 12508, { storedAmount: 11868 });
    assert.equal(r.ok, false);
    assert.equal(r.step, "release");
    assert.equal(r.approvalReentered, true);
    assert.match(r.message, /APPROVAL/);
  }));
});

// --- D.1 The manual-edit guard ----------------------------------------------

test("D1: live ≠ stored and live = ruled → reconciled: adopted, nothing written to Acumatica", async () => {
  for (const gate of [false, true]) {
    await withPoEnabled(() => withHoldGate(gate, async () => {
      reset();
      // SOL-10125: the engine wrote 11,868, Harmon typed 12,508, which is what the rule gives.
      ctx.orders.push(po("016939", "M2", 12508));
      const r = await upd("016939", "M2", 12508, { storedAmount: 11868 });
      assert.equal(r.ok, true);
      assert.equal(r.action, "reconciled", `gate ${gate}`);
      assert.equal(r.amount, 12508);
      assert.equal(r.previousStoredAmount, 11868);
      assert.equal(ctx.puts.length, 0);
    }));
  }
});

test("D1: live ≠ stored and live ≠ ruled → manually_set: NOT overwritten, gate open or closed", async () => {
  for (const gate of [false, true]) {
    await withPoEnabled(() => withHoldGate(gate, async () => {
      reset();
      // SOL-10134: one cent over the rule.
      ctx.orders.push(po("016998", "M2", 4663.75));
      const r = await upd("016998", "M2", 4663.74, { storedAmount: 4500 });
      assert.equal(r.ok, true);
      assert.equal(r.action, "manually_set", `gate ${gate}`);
      assert.equal(r.amount, 4663.75, "the LIVE amount is what gets stored");
      assert.equal(r.ruledAmount, 4663.74);
      assert.equal(r.message, "PO 016998 (M2) edited in Acumatica to 4663.75; Sundial will not overwrite (the commission rule gives 4663.74).");
      assert.equal(ctx.puts.length, 0);
    }));
  }
});

test("D1: a BLANK stored amount is no licence to overwrite", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(po("016939", "M2", 9000));
    const r = await upd("016939", "M2", 12508, { storedAmount: null });
    assert.equal(r.action, "manually_set");
    assert.equal(ctx.puts.length, 0);
    reset();
    ctx.orders.push(po("016939", "M2", 12508));
    assert.equal((await upd("016939", "M2", 12508, { storedAmount: null })).action, "reconciled");
  });
});

test("D1: the Manually Set marker survives the adoption — the NEXT run still does not overwrite", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(po("016998", "M2", 4663.75));
    // Run 2: stored now equals live (adopted last run) — the guard alone would let it through.
    const err = manualSetMessage("016998", "M2", 4663.75, 4663.74);
    assert.deepEqual(manualSetMarkers(`something else\n${err}`), { "016998": 4663.75 });
    const r = await upd("016998", "M2", 4663.74, { storedAmount: 4663.75, manualAmount: 4663.75 });
    assert.equal(r.action, "manually_set");
    assert.equal(ctx.puts.length, 0);
    // With the marker cleared (a person cleared Commission_PO_Error__c), the update goes ahead.
    const go = await upd("016998", "M2", 4663.74, { storedAmount: 4663.75, manualAmount: null });
    assert.equal(go.action, "updated");
    assert.equal(unitCost(0), 4663.74);
  });
});

test("D1 through sync: the marker in Commission_PO_Error__c is read back on the next push", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(po("016997", "M1", 2500, { status: "Closed" }));
    ctx.orders.push(po("016998", "M2", 4663.75));
    const r = await sync({
      ...VALUES, Sales_Rep_Commission_Amt__c: 7163.74,
      Commission_PO_M1_Number__c: "016997", Commission_PO_M1_Amount__c: 2500,
      Commission_PO_M2_Number__c: "016998", Commission_PO_M2_Amount__c: 4663.75, // adopted last run
      Commission_PO_Error__c: manualSetMessage("016998", "M2", 4663.75, 4663.74),
    });
    assert.equal(ctx.puts.length, 0);
    assert.equal(r.results.find((x) => x.milestone === "M2").action, "manually_set");
  });
});

test("D1 through sync: reconcile clears the error and puts the status back to Both Raised", async () => {
  await withPoEnabled(async () => {
    reset();
    // SOL-10125 exactly: commission 15,008; M1 Closed at the 2,500 cap; M2 hand-fixed to 12,508.
    ctx.orders.push(po("016938", "M1", 2500, { status: "Closed" }));
    ctx.orders.push(po("016939", "M2", 12508));
    const r = await sync({
      ...VALUES, Sales_Rep_Commission_Amt__c: 15008,
      Commission_PO_M1_Number__c: "016938", Commission_PO_M1_Amount__c: 2500,
      Commission_PO_M2_Number__c: "016939", Commission_PO_M2_Amount__c: 11868,
      Commission_PO_Status__c: "Failed",
      Commission_PO_Error__c: "PO 016939 was updated but no longer matches the expected shape: UnitCost is 11868, expected 12508.",
    });
    assert.equal(r.status, "Both Raised");
    assert.equal(ctx.puts.length, 0);
    const f = writtenFields();
    assert.equal(f.Commission_PO_M2_Amount__c, 12508);
    assert.equal(f.Commission_PO_Status__c, "Both Raised");
    assert.equal(f.Commission_PO_Error__c, null);
  });
});

test("D1 through sync: Manually Set writes Frozen + the marker until the picklist value is deployed", async () => {
  const values = {
    ...VALUES, Sales_Rep_Commission_Amt__c: 7163.74,
    Commission_PO_M1_Number__c: "016997", Commission_PO_M1_Amount__c: 2500,
    Commission_PO_M2_Number__c: "016998", Commission_PO_M2_Amount__c: 4663.74,
  };
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(po("016997", "M1", 2500, { status: "Closed" }));
    ctx.orders.push(po("016998", "M2", 4663.75));
    const r = await sync(values);
    assert.equal(r.status, "Frozen");
    assert.equal(ctx.puts.length, 0);
    const f = writtenFields();
    assert.equal(f.Commission_PO_M2_Amount__c, 4663.75);
    assert.match(f.Commission_PO_Error__c, /PO 016998 \(M2\) edited in Acumatica to 4663\.75; Sundial will not overwrite/);
    assert.match(f.Commission_PO_Error__c, /shows Frozen until the "Manually Set" picklist value is deployed/);
  });
  await withPoEnabled(() => withManualPicklist(true, async () => {
    reset();
    ctx.orders.push(po("016997", "M1", 2500, { status: "Closed" }));
    ctx.orders.push(po("016998", "M2", 4663.75));
    const r = await sync(values);
    assert.equal(r.status, "Manually Set");
    assert.doesNotMatch(writtenFields().Commission_PO_Error__c, /picklist value is deployed/);
  }));
});

// --- D.2 The frozen-M1 rule ---------------------------------------------------

test("D2: m2AmountAfter — a frozen M1's LIVE amount, never the rule's M1", () => {
  const ms = computeCommissionMilestones(4138);
  assert.deepEqual(m2AmountAfter({ action: "frozen", currentAmount: 2195 }, ms), { amount: 1943, basis: "frozen_m1", m1Live: 2195 });
  assert.deepEqual(m2AmountAfter({ action: "updated", amount: 2069 }, ms), { amount: 2069, basis: "rule" });
  assert.deepEqual(m2AmountAfter({ action: "manually_set", amount: 2000 }, ms), { amount: 2069, basis: "rule" }, "the ruling is about FROZEN M1s");
});

test("D2 (SOL-10061): M1 frozen at 2,195 → M2 = 4,138 − 2,195 = 1,943; Harmon's hand fix is reconciled, not undone", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(po("016793", "M1", 2195, { status: "Closed" }));
    ctx.orders.push(po("016794", "M2", 1943));
    const r = await sync({
      ...VALUES, Sales_Rep_Commission_Amt__c: 4138,
      Commission_PO_M1_Number__c: "016793", Commission_PO_M1_Amount__c: 2195,
      Commission_PO_M2_Number__c: "016794", Commission_PO_M2_Amount__c: 1745,
    });
    assert.equal(r.status, "Both Raised");
    assert.equal(ctx.puts.length, 0, "the old rule would have moved M2 to 2,069 and overpaid 126");
    assert.equal(writtenFields().Commission_PO_M2_Amount__c, 1943);
    assert.equal(r.results.find((x) => x.milestone === "M2").action, "reconciled");
  });
});

test("D2: M2 still on the old arithmetic (live = stored = 2,069) is UPDATED to commission − real M1", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(po("016793", "M1", 2195, { status: "Closed" }));
    ctx.orders.push(po("016794", "M2", 2069));
    const r = await sync({
      ...VALUES, Sales_Rep_Commission_Amt__c: 4138,
      Commission_PO_M1_Number__c: "016793", Commission_PO_M1_Amount__c: 2195,
      Commission_PO_M2_Number__c: "016794", Commission_PO_M2_Amount__c: 2069,
    });
    assert.equal(r.status, "Both Raised");
    assert.equal(unitCost(1), 1943);
  });
});

test("D2: an Open M1 with a RECEIPT is frozen — status alone does not decide", async () => {
  for (const lineOverrides of [
    { QtyOnReceipts: { value: 1 } },
    { ReceivedAmount: { value: 2195 } },
    { Completed: { value: true } },
  ]) {
    await withPoEnabled(async () => {
      reset();
      ctx.orders.push(po("016793", "M1", 2195, { lineOverrides }));
      const one = await upd("016793", "M1", 2069, { storedAmount: 2195 });
      assert.equal(one.action, "frozen", JSON.stringify(lineOverrides));
      assert.match(one.frozenBecause, /status Open/);
      assert.equal(ctx.puts.length, 0, "nothing is written to a PO with money moved against it");

      reset();
      ctx.orders.push(po("016793", "M1", 2195, { lineOverrides }));
      ctx.orders.push(po("016794", "M2", 2069));
      const r = await sync({
        ...VALUES, Sales_Rep_Commission_Amt__c: 4138,
        Commission_PO_M1_Number__c: "016793", Commission_PO_M1_Amount__c: 2195,
        Commission_PO_M2_Number__c: "016794", Commission_PO_M2_Amount__c: 2069,
      });
      assert.equal(unitCost(1), 1943, "M2 absorbs the received M1's real amount");
      assert.equal(r.status, "Both Raised");
    });
  }
});

test("D2: frozenReason — header status first, then the line", () => {
  const n = (opts) => normalizePurchaseOrder(po("1", "M1", 100, opts));
  assert.equal(frozenReason(n({})), null);
  assert.equal(frozenReason(n({ status: "On Hold" })), null);
  assert.equal(frozenReason(n({ status: "Closed" })), "is Closed");
  assert.match(frozenReason(n({ lineOverrides: { QtyOnReceipts: { value: 1 } } })), /1 received/);
  assert.match(frozenReason(n({ lineOverrides: { Cancelled: { value: true } } })), /Cancelled/);
});

test("D2: M1 frozen at the whole commission → M2 skipped by name; benign with no M2 PO", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(po("016934", "M1", 2500, { status: "Closed" }));
    const r = await sync({
      ...VALUES, Sales_Rep_Commission_Amt__c: 2500,
      Commission_PO_M1_Number__c: "016934", Commission_PO_M1_Amount__c: 2500,
    });
    const m2 = r.results.find((x) => x.milestone === "M2");
    assert.equal(m2.action, "skip_m2_covered_by_m1");
    assert.equal(m2.ok, true);
    assert.equal(r.status, "M1 Raised");
    assert.equal(ctx.orders.length, 1, "no M2 PO is raised");
  });
});

test("D2: M1 frozen ABOVE the commission → M2 skipped, Failed, the overpayment named; an existing M2 untouched", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(po("016934", "M1", 2500, { status: "Closed" }));
    ctx.orders.push(po("016935", "M2", 300));
    const r = await sync({
      ...VALUES, Sales_Rep_Commission_Amt__c: 2400,
      Commission_PO_M1_Number__c: "016934", Commission_PO_M1_Amount__c: 2500,
      Commission_PO_M2_Number__c: "016935", Commission_PO_M2_Amount__c: 300,
    });
    const m2 = r.results.find((x) => x.milestone === "M2");
    assert.equal(m2.action, "skip_m2_covered_by_m1");
    assert.equal(m2.ok, false);
    assert.equal(r.status, "Failed");
    assert.equal(ctx.puts.length, 0);
    assert.match(writtenFields().Commission_PO_Error__c, /overpaid 100.*M2 PO 016935 exists and was not touched/s);
  });
});

test("a frozen M2 at the ruled amount is settled; at a different amount it is Frozen for a person", async () => {
  const values = (m2Live) => ({
    ...VALUES, Sales_Rep_Commission_Amt__c: 7314,
    Commission_PO_M1_Number__c: "016102", Commission_PO_M1_Amount__c: 2500,
    Commission_PO_M2_Number__c: "016103", Commission_PO_M2_Amount__c: m2Live,
  });
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(po("016102", "M1", 2500, { status: "Closed" }));
    ctx.orders.push(po("016103", "M2", 4814, { status: "Closed" }));
    assert.equal((await sync(values(4814))).status, "Both Raised");

    reset();
    ctx.orders.push(po("016102", "M1", 2500, { status: "Closed" }));
    ctx.orders.push(po("016103", "M2", 4000, { status: "Closed" }));
    const r = await sync(values(4000));
    assert.equal(r.status, "Frozen");
    assert.match(writtenFields().Commission_PO_Error__c, /PO 016103 is Closed.*holds 4000; the commission rule gives 4814/);
  });
});

// --- Reconcile mode (budget-push { reconcilePos: true }) ----------------------

test("reconcile: settles what it can with ZERO Acumatica writes and no vendor check", async () => {
  await withPoEnabled(() => withHoldGate(true, async () => {
    reset();
    ctx.orders.push(rawPo({ orderNbr: "016938", vendorId: "02118", description: M1_DESC, project: "R261078", amount: 2500, status: "Closed" }));
    ctx.orders.push(rawPo({ orderNbr: "016939", vendorId: "02118", description: M2_DESC, project: "R261078", amount: 12508 }));
    const r = await syncCommissionPos("a0X000000000001AAA", {
      ...DEALER_DEAL, Sales_Rep_Commission_Amt__c: 15008,
      Commission_PO_M1_Number__c: "016938", Commission_PO_M1_Amount__c: 2500,
      Commission_PO_M2_Number__c: "016939", Commission_PO_M2_Amount__c: 11868,
      Commission_PO_Status__c: "Failed",
    }, { now: NOW, reconcileOnly: true });
    assert.equal(r.status, "Both Raised");
    assert.equal(ctx.puts.length, 0);
    assert.deepEqual(ctx.vendorReads, []);
    assert.equal(writtenFields().Commission_PO_Error__c, null);
  }));
});

test("reconcile: a PO that needs a real write reads needs_push and the record's status is left alone", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(po("016102", "M1", 2500));
    ctx.orders.push(po("016103", "M2", 4000));
    const r = await syncCommissionPos("a0X000000000001AAA", {
      ...VALUES, Sales_Rep_Commission_Amt__c: 7314,
      Commission_PO_M1_Number__c: "016102", Commission_PO_M1_Amount__c: 2500,
      Commission_PO_M2_Number__c: "016103", Commission_PO_M2_Amount__c: 4000, // ours, stale: rule says 4814
    }, { now: NOW, reconcileOnly: true });
    assert.equal(r.reason, "needs_push");
    assert.equal(r.results.find((x) => x.milestone === "M2").action, "needs_push");
    assert.equal(ctx.puts.length, 0);
    const f = writtenFields();
    assert.ok(!("Commission_PO_Status__c" in f), "a partial reconcile does not restamp the status");
  });
});

test("reconcile never creates — a missing PO is needs_push", async () => {
  await withPoEnabled(async () => {
    reset();
    const r = await syncCommissionPos("a0X000000000001AAA", DATED, { now: NOW, reconcileOnly: true });
    assert.equal(r.reason, "needs_push");
    assert.equal(ctx.orders.length, 0);
    assert.equal(ctx.puts.length, 0);
  });
});

test("commissionPoFieldNames includes the stored amounts and the error text the guards read", () => {
  const names = commissionPoFieldNames();
  for (const f of ["Commission_PO_M1_Amount__c", "Commission_PO_M2_Amount__c", "Commission_PO_Error__c",
    "Commission_PO_M1_Number__c", "Commission_PO_M2_Number__c", "Sales_Rep_Commission_Amt__c", ...commissionVendorFieldNames()]) {
    assert.ok(names.includes(f), f);
  }
});

test("status precedence: Failed > Frozen > Manually Set > raised; absorbed / settled frozen POs do not count", () => {
  const ms = { ok: true, action: "manually_set" };
  assert.equal(commissionPoStatus([ms], { M1: "a", M2: "b" }), "Frozen", "Manually Set falls back to Frozen until deployed");
  assert.equal(commissionPoStatus([{ ok: false, action: "frozen", absorbed: true }, { ok: true, action: "updated" }], { M1: "a", M2: "b" }), "Both Raised");
  assert.equal(commissionPoStatus([{ ok: false, action: "frozen", settled: true }], { M1: "a", M2: "b" }), "Both Raised");
  assert.equal(commissionPoStatus([{ ok: false, action: "frozen" }, ms], { M1: "a", M2: "b" }), "Frozen");
  assert.equal(commissionPoStatus([{ ok: false, action: "update_failed" }, ms], { M1: "a" }), "Failed");
  assert.equal(commissionPoStatus([{ ok: true, action: "reconciled" }], { M1: "a", M2: "b" }), "Both Raised");
});

test("reconcile: a post-cutover deal with no dealer still has its PO amounts adopted, and reads Failed with the DEALER reason", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(po("016660", "M1", 2500, { status: "Closed" }));
    ctx.orders.push(po("016661", "M2", 12489));
    const r = await syncCommissionPos("a0X000000000001AAA", {
      ...VALUES, ...POST_CUTOVER, Sales_Company_Harmon_Solar_or_Third__c: null, Sales_Rep_Commission_Amt__c: 14989,
      Commission_PO_M1_Number__c: "016660", Commission_PO_M1_Amount__c: 2500,
      Commission_PO_M2_Number__c: "016661", Commission_PO_M2_Amount__c: 12588,
      Commission_PO_Error__c: "PO 016661 was updated but no longer matches the expected shape: UnitCost is 12588, expected 12489.",
    }, { now: NOW, reconcileOnly: true });
    assert.equal(r.reason, "dealer_missing");
    assert.equal(ctx.puts.length, 0);
    const f = writtenFields();
    assert.equal(f.Commission_PO_M2_Amount__c, 12489, "the right amount is adopted anyway");
    assert.equal(f.Commission_PO_Status__c, "Failed");
    assert.match(f.Commission_PO_Error__c, /PO amounts were reconciled from Acumatica; the next budget push refuses/);
    assert.doesNotMatch(f.Commission_PO_Error__c, /no longer matches/, "the stale October text is gone");
  });
});

test("reconcile: a plan refusal it cannot settle leaves the record untouched (a push would write Failed)", async () => {
  await withPoEnabled(async () => {
    reset();
    const r = await syncCommissionPos("a0X000000000001AAA", { ...DATED, Acumatica_Project_ID__c: null }, { now: NOW, reconcileOnly: true });
    assert.equal(r.reason, "no_acumatica_project");
    assert.equal(sfWrites.length, 0);
    reset();
    await sync({ ...DATED, Acumatica_Project_ID__c: null });
    assert.equal(writtenFields().Commission_PO_Status__c, "Failed", "the push path is unchanged");
  });
});

test("a frozen PO already at the ruled amount does not claim a difference", async () => {
  await withPoEnabled(async () => {
    reset();
    ctx.orders.push(po("016938", "M1", 2500, { status: "Closed" }));
    const r = await upd("016938", "M1", 2500, { storedAmount: 2500 });
    assert.equal(r.settled, true);
    assert.match(r.message, /holds 2500, what the commission rule gives/);
    assert.doesNotMatch(r.message, /difference/);
  });
});
