// totals.js — the estimate money math (D-072.8; docs/service-data-model.md §6).
//
// PURE. No I/O, no Salesforce field reads beyond the plain objects passed in, so the
// whole sequence — kind subtotals → scoped discount → hidden markup → tax → total →
// deposit — is unit-tested with exact cents and can be replayed by the nightly
// reconcile and the invoice freeze without a second implementation.
//
// ORDER AND ROUNDING, decided here and nowhere else:
//   1. Each line total is rounded to cents FIRST (qty x unit price), so the grid, the
//      PDF, and the totals all agree line by line.
//   2. Discount applies to the SCOPED base (labor / material / both). Fees are never
//      discounted. A Product line with a labor/material split contributes each half to
//      its bucket; a Product line WITHOUT a split sits in an "unsplit" bucket that only
//      a Both-scoped discount reaches (we refuse to guess which half a labor discount
//      should bite).
//   3. Markup is a percent of (subtotal - discount) or a flat amount. Hidden from the
//      customer: it is folded into Total, never printed as a line.
//   4. Tax = taxable line value, scaled by (net / subtotal) so a discount or markup is
//      shared proportionally by taxable and non-taxable lines, times the rate.
//      Tax_Rate__c is a Salesforce PERCENT (8.6 means 8.6%).
//   5. Deposit is a percent of Total or a flat amount capped at Total; zero unless
//      Deposit_Required__c.
// Lines with Stage__c = Removed are ignored everywhere.

export const KINDS = Object.freeze(["Labor", "Material", "Product", "Fee"]);

/** Round to cents, half away from zero, without float drift on values like 1.005. */
export function cents(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const sign = v < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(v) * 100 + 1e-9)) / 100;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {Array<object>} lines  [{ kind, quantity, unitPrice, unitLaborPrice,
 *   unitMaterialPrice, taxable, stage }]
 * @param {object} est  { discountScope, discountType, discountValue, markupType,
 *   markupValue, taxRate, depositRequired, depositType, depositValue }
 * @returns {object} every computed number, plus `fields` = the Salesforce field map
 *   to write on Sundial_Estimate__c.
 */
export function computeTotals(lines, est = {}) {
  const buckets = { labor: 0, material: 0, fee: 0, unsplit: 0 };
  let taxableValue = 0;
  const lineTotals = [];

  for (const raw of lines || []) {
    if (!raw || raw.stage === "Removed") continue;
    const qty = num(raw.quantity, 1);
    const lineTotal = cents(qty * num(raw.unitPrice));
    lineTotals.push({ id: raw.id ?? null, lineTotal });
    if (raw.taxable === true) taxableValue += lineTotal;

    switch (raw.kind) {
      case "Material":
        buckets.material += lineTotal;
        break;
      case "Fee":
        buckets.fee += lineTotal;
        break;
      case "Product": {
        const hasSplit =
          raw.unitLaborPrice != null || raw.unitMaterialPrice != null;
        if (hasSplit) {
          const labor = cents(qty * num(raw.unitLaborPrice));
          // Material takes the remainder so the two halves always sum to the line.
          buckets.labor += labor;
          buckets.material += cents(lineTotal - labor);
        } else {
          buckets.unsplit += lineTotal;
        }
        break;
      }
      case "Labor":
      default:
        buckets.labor += lineTotal;
    }
  }

  const laborSubtotal = cents(buckets.labor);
  const materialSubtotal = cents(buckets.material);
  const feeSubtotal = cents(buckets.fee);
  const unsplit = cents(buckets.unsplit);
  const subtotal = cents(laborSubtotal + materialSubtotal + feeSubtotal + unsplit);

  // --- discount ---------------------------------------------------------------
  const scope = est.discountScope || "Both";
  const discountBase =
    scope === "Labor"
      ? laborSubtotal
      : scope === "Material"
        ? materialSubtotal
        : cents(laborSubtotal + materialSubtotal + unsplit);
  let discountAmount = 0;
  const dv = num(est.discountValue);
  if (dv > 0 && discountBase > 0) {
    discountAmount =
      est.discountType === "Amount"
        ? Math.min(cents(dv), discountBase)
        : cents((discountBase * dv) / 100);
  }

  // --- markup (hidden) ----------------------------------------------------------
  const afterDiscount = cents(subtotal - discountAmount);
  let markupAmount = 0;
  const mv = num(est.markupValue);
  if (mv > 0) {
    markupAmount =
      est.markupType === "Amount" ? cents(mv) : cents((afterDiscount * mv) / 100);
  }

  // --- tax ------------------------------------------------------------------------
  const net = cents(afterDiscount + markupAmount);
  const taxRate = num(est.taxRate); // percent, e.g. 8.6
  let taxAmount = 0;
  if (taxRate > 0 && taxableValue > 0) {
    const scaled = subtotal > 0 ? (cents(taxableValue) * net) / subtotal : 0;
    taxAmount = cents((scaled * taxRate) / 100);
  }

  const total = cents(net + taxAmount);

  // --- deposit --------------------------------------------------------------------
  let depositAmount = 0;
  if (est.depositRequired === true) {
    const dep = num(est.depositValue);
    if (dep > 0) {
      depositAmount =
        est.depositType === "Flat"
          ? Math.min(cents(dep), total)
          : cents((total * dep) / 100);
    }
  }

  return {
    laborSubtotal,
    materialSubtotal,
    feeSubtotal,
    unsplitProductSubtotal: unsplit,
    subtotal,
    discountBase,
    discountAmount,
    markupAmount,
    taxableValue: cents(taxableValue),
    taxAmount,
    total,
    depositAmount,
    lineTotals,
    fields: {
      Labor_Subtotal__c: laborSubtotal,
      Material_Subtotal__c: materialSubtotal,
      Fee_Subtotal__c: feeSubtotal,
      Subtotal__c: subtotal,
      Discount_Amount__c: discountAmount,
      Markup_Amount__c: markupAmount,
      Tax_Amount__c: taxAmount,
      Total__c: total,
      Deposit_Amount__c: depositAmount,
    },
  };
}

/** Map a Sundial_Service_Line__c record (API names) to the plain shape above. */
export function lineFromRecord(r) {
  return {
    id: r.Id,
    kind: r.Kind__c,
    quantity: r.Quantity__c,
    unitPrice: r.Unit_Price__c,
    unitLaborPrice: r.Unit_Labor_Price__c,
    unitMaterialPrice: r.Unit_Material_Price__c,
    taxable: r.Taxable__c === true,
    stage: r.Stage__c,
  };
}

/** Map a Sundial_Estimate__c record (API names) to the plain shape above. */
export function estimateFromRecord(r) {
  return {
    discountScope: r.Discount_Scope__c,
    discountType: r.Discount_Type__c,
    discountValue: r.Discount_Value__c,
    markupType: r.Markup_Type__c,
    markupValue: r.Markup_Value__c,
    taxRate: r.Tax_Rate__c,
    depositRequired: r.Deposit_Required__c === true,
    depositType: r.Deposit_Type__c,
    depositValue: r.Deposit_Value__c,
  };
}
