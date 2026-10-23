// Does this Acumatica vendor exist, and is it usable for a purchase order?
//
// D-085 amendment 1. A dealer's Acumatica_Vendor_ID__c is typed by Constructive Ops; a
// typo, or a vendor Harmon finance later deactivates, would otherwise only surface as a
// rejected PO PUT — or worse, a PO raised against the wrong company if the typo happens
// to be a real id. The commission-PO engine asks this before every CREATE, and
// scripts/verify-dealer-vendor-coverage.mjs asks it for every active dealer.
//
// Read-only: one GET on the Vendor entity, filtered by VendorID.

import { getAcumaticaEntity } from "./acumatica.js";

const av = (v) => (v && typeof v === "object" && "value" in v ? v.value : v);

/**
 * @param {string} vendorId
 * @param {{get?: typeof getAcumaticaEntity}} [deps]
 * @returns {Promise<{ok: true, vendorId, vendorName, status}
 *                  |{ok: false, reason: "vendor_not_in_acumatica"|"vendor_lookup_failed", vendorId, status?, message}>}
 *   ok:true only for a vendor that exists and is not Inactive. Never throws.
 */
export async function checkAcumaticaVendor(vendorId, deps = {}) {
  const get = deps.get ?? getAcumaticaEntity;
  const id = String(vendorId ?? "").trim();
  let res;
  try {
    res = await get("Vendor", {
      $filter: `VendorID eq '${id.replace(/'/g, "''")}'`,
      $select: "VendorID,VendorName,Status",
    });
  } catch (err) {
    res = { ok: false, status: 0, text: err?.message || String(err) };
  }
  if (!res?.ok) {
    // Not "the vendor is missing": we could not ask. Still a refusal — a PO raised
    // without the check is the thing the check exists to prevent — but a different fix.
    return {
      ok: false, reason: "vendor_lookup_failed", vendorId: id, status: res?.status,
      message:
        `Could not look up Acumatica vendor ${id} before raising the PO (HTTP ${res?.status ?? "?"}). ` +
        "No PO was created. Retry the push once Acumatica answers.",
    };
  }
  const rows = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
  const hit = rows.find((r) => String(av(r?.VendorID) ?? "").trim() === id);
  if (!hit) {
    return {
      ok: false, reason: "vendor_not_in_acumatica", vendorId: id,
      message:
        `Vendor ID ${id} (the dealer's Acumatica_Vendor_ID__c) does not exist in Acumatica. ` +
        "No PO was created. Correct the vendor ID on the dealer record, or ask Harmon finance " +
        "to create the vendor, then re-push.",
    };
  }
  const status = String(av(hit.Status) ?? "").trim();
  const vendorName = String(av(hit.VendorName) ?? "").trim();
  if (status.toLowerCase() === "inactive") {
    return {
      ok: false, reason: "vendor_not_in_acumatica", vendorId: id, status,
      message:
        `Vendor ID ${id} ("${vendorName}") is Inactive in Acumatica. No PO was created — a PO ` +
        "against an inactive vendor is a payment nobody has agreed to make. Reactivate the " +
        "vendor in Acumatica, or correct the dealer's Acumatica_Vendor_ID__c, then re-push.",
    };
  }
  return { ok: true, vendorId: id, vendorName, status };
}
