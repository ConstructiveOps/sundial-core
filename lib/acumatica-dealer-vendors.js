// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source:    docs/integrations/dealer-vendor-map.csv  (53 rows)
// Generator: scripts/generate-dealer-vendors.mjs
// Regenerate: node scripts/generate-dealer-vendors.mjs
//
// Sales Company picklist value -> Acumatica VendorID, for commission PO creation (D4).
//
// The CSV is the source of truth and the thing to review in a PR. Editing this file
// directly works right up until someone regenerates, at which point the edit vanishes
// with no error — so don't.
//
// ---------------------------------------------------------------------------
// WHAT THE THREE OUTCOMES MEAN
// ---------------------------------------------------------------------------
// D4's rule is "fail loudly on unmapped or Inactive", and the internal exclusion adds a
// third case. `lookupDealerVendor` never guesses and never returns a partial answer:
//
//   ok: true            -> resolved to an ACTIVE vendor. Safe to raise a PO.
//   reason "internal"   -> "Harmon Solar". Internal deals are payroll, not POs (D16).
//   reason "inactive"   -> mapped, but the vendor is Inactive in Acumatica. A PO against
//                          an inactive vendor is a payment nobody has agreed to make.
//   reason "unmapped"   -> the picklist value is not in the CSV at all.
//   reason "blank"      -> no sales company on the record.
//
// The INTERNAL case is BELT AND BRACES, not the primary defence. Internal deals are
// supposed to be stopped by the deal-type gate long before vendor resolution — this
// exists so that if that gate is ever bypassed, refactored, or wrong, the request still
// stops here instead of raising a purchase order against Harmon's own vendor record.
//
// ---------------------------------------------------------------------------
// MATCHING: trim, then EXACT
// ---------------------------------------------------------------------------
// Deliberately stricter than lib/acumatica-tax-zones.js, which case-folds and strips
// punctuation. Cities are free text a human typed; these are PICKLIST values, so the
// exact string is known and a near-match is a signal that something is wrong rather
// than a spelling to be forgiven. "Solar Buddy" and "Solar Buddy AZ" are DIFFERENT
// picklist values that happen to share a vendor, and they are listed separately below.
//
// The aliases are intentional and each maps to the same VendorID:
//   01736  <-  "Blue Sky Solar" | "Blue Sky"
//   01799  <-  "Machometa" | "Machometa Enterprises"
//   01959  <-  "I AM ENERGY" | "I Am Energy Group"
//   01833  <-  "Residental Solar Brokers" | "Residential Solar Brokers"
//   01958  <-  "AZray Solar" | "Azray Solar LLC"
//   01951  <-  "Solar Specialists" | "Solar Specialist LLC"
//   01952  <-  "Blueberry Hill" | "Blueberry Hill Co LLC"
//   01962  <-  "Mr. Clutch Solar" | "Mr Clutch Solar"
//   01992  <-  "Solar Buddy" | "Solar Buddy AZ"
//   01834  <-  "Sonoran Solar" | "Sonoran Solar - Jared Alberts"
//
// Note "Residental Solar Brokers" / "Residential Solar Brokers": both spellings are real
// picklist values. Do not "fix" either one — removing a key here makes every deal
// carrying it fail to resolve.

/** Sales Company picklist value -> vendor. Keys are EXACT picklist values. */
const DEALER_VENDORS = new Map([
  ["Dennis Alessandro", { vendorId: "01926", vendorName: "Dennis Alessandro", status: "Active" }],
  ["Thomas Kopp", { vendorId: "01923", vendorName: "Thomas Kopp", status: "Active" }],
  ["Property Upgrades LLC", { vendorId: "01995", vendorName: "Property Upgrades LLC", status: "Active" }],
  ["Impact Solar Energy", { vendorId: "01954", vendorName: "Impact Solar Energy, LLC", status: "Active" }],
  ["Daniel Reese", { vendorId: "01924", vendorName: "Daniel Reese", status: "Active" }],
  ["Desert Sun Systems", { vendorId: "01967", vendorName: "Desert Sun Systems LLC", status: "Active" }],
  ["Renaissance Energy", { vendorId: "01905", vendorName: "Renaissance Energy", status: "Active" }],
  ["Suzuki Solar", { vendorId: "02050", vendorName: "Shota Suzuki", status: "Active" }],
  ["Blue Sky Solar", { vendorId: "01736", vendorName: "Blue Sky Solar LLC", status: "Active" }],
  ["Heavenly Power", { vendorId: "02118", vendorName: "Heavenly Power LLC", status: "Active" }],
  ["High Desert Energy", { vendorId: "01919", vendorName: "High Desert Energy, LLC", status: "Active" }],
  ["Machometa", { vendorId: "01799", vendorName: "Machometa Enterprises", status: "Active" }],
  ["I AM ENERGY", { vendorId: "01959", vendorName: "I Am Energy Group", status: "Active" }],
  ["Skys the Limit Solar", { vendorId: "01867", vendorName: "Sky's the Limit Solar, LLC", status: "Active" }],
  ["AZ Solar Experts", { vendorId: "01864", vendorName: "AZ Solar Expert", status: "Active" }],
  ["Residental Solar Brokers", { vendorId: "01833", vendorName: "Residential Solar", status: "Active" }],
  ["Edwin Sicairos", { vendorId: "01991", vendorName: "Edwin Sicairos", status: "Active" }],
  ["Clean Planet Energy Group", { vendorId: "01984", vendorName: "Clean Planet Energy Group LLC", status: "Active" }],
  ["David Vernon LLC", { vendorId: "01978", vendorName: "David Vernon LLC", status: "Active" }],
  ["Elevate Roofing Pros", { vendorId: "01965", vendorName: "Elevate Roofing Pros", status: "Active" }],
  ["Familia Sicairos", { vendorId: "02065", vendorName: "Miriam Sicairos", status: "Active" }],
  ["Ben Wollschlager", { vendorId: "01928", vendorName: "Benjamin Wollschlager", status: "Active" }],
  ["Lumen Solar", { vendorId: "01982", vendorName: "Lumen Solar LLC", status: "Active" }],
  ["AZray Solar", { vendorId: "01958", vendorName: "AZray Solar LLC", status: "Active" }],
  ["Ultraviolet Solar Solutions", { vendorId: "01966", vendorName: "UltraViolet Solar Solutions LLC", status: "Active" }],
  ["Solar Specialists", { vendorId: "01951", vendorName: "Solar Specialists, LLC", status: "Active" }],
  ["Blueberry Hill", { vendorId: "01952", vendorName: "BlueberryHill Co LLC", status: "Active" }],
  ["SunRate Energy", { vendorId: "01879", vendorName: "Low Rate Energy, LLC", status: "Active" }],
  ["Drake Solar Solutions", { vendorId: "02003", vendorName: "Drake Solar Solutions LLC", status: "Active" }],
  ["First Class Solar", { vendorId: "01979", vendorName: "First Class Solar", status: "Active" }],
  ["Radiant Energy", { vendorId: "01987", vendorName: "Radiant Energy Pros", status: "Active" }],
  ["Mr. Clutch Solar", { vendorId: "01962", vendorName: "Mr Clutch Solar LLC", status: "Active" }],
  ["Brankirs Sales", { vendorId: "01887", vendorName: "Brankirs Sales Inc", status: "Active" }],
  ["Solar Buddy", { vendorId: "01992", vendorName: "SolarBuddy AZ LLC", status: "Active" }],
  ["Volt Energy", { vendorId: "01955", vendorName: "Volt Energy, LLC", status: "Active" }],
  ["James Campbell Consulting LLC", { vendorId: "02123", vendorName: "James Campbell Consulting", status: "Active" }],
  ["EC Power", { vendorId: "01832", vendorName: "EC Power, LLC", status: "Active" }],
  ["Sonoran Solar", { vendorId: "01834", vendorName: "Sonoran Solar Consulting LLC", status: "Active" }],
  ["Franco Del Sol LLC", { vendorId: "02113", vendorName: "Franco Del Sol LLC", status: "Active" }],
  ["SunbaseData Admin", { vendorId: "02071", vendorName: "Sunbase Data LLC", status: "Active" }],
  ["Harmon Solar", { vendorId: "00821", vendorName: "Harmon Solar", status: "Active", internal: true }],  // INTERNAL - never generates POs; excluded from PO vendor resolution
  ["I Am Energy Group", { vendorId: "01959", vendorName: "I Am Energy Group", status: "Active" }],
  ["Residential Solar Brokers", { vendorId: "01833", vendorName: "Residential Solar", status: "Active" }],
  ["Azray Solar LLC", { vendorId: "01958", vendorName: "AZray Solar LLC", status: "Active" }],
  ["Machometa Enterprises", { vendorId: "01799", vendorName: "Machometa Enterprises", status: "Active" }],
  ["Blue Sky", { vendorId: "01736", vendorName: "Blue Sky Solar LLC", status: "Active" }],
  ["Solar Specialist LLC", { vendorId: "01951", vendorName: "Solar Specialists, LLC", status: "Active" }],
  ["Blueberry Hill Co LLC", { vendorId: "01952", vendorName: "BlueberryHill Co LLC", status: "Active" }],
  ["Mr Clutch Solar", { vendorId: "01962", vendorName: "Mr Clutch Solar LLC", status: "Active" }],
  ["Solar Buddy AZ", { vendorId: "01992", vendorName: "SolarBuddy AZ LLC", status: "Active" }],
  ["Sonoran Solar - Jared Alberts", { vendorId: "01834", vendorName: "Sonoran Solar Consulting LLC", status: "Active" }],
  ["REB Solar", { vendorId: "02084", vendorName: "Renewable Energy Brokers", status: "Active" }],
  ["Derek Anderson", { vendorId: "01863", vendorName: "Derek Anderson", status: "Inactive" }],  // Inactive vendor - PO creation will fail loudly until reactivated
]);

/** The picklist value that means an internal Harmon deal (no PO — D16). */
export const INTERNAL_SALES_COMPANY = "Harmon Solar";

/** Every row, for reporting and for the coverage check against the live picklist. */
export const DEALER_VENDOR_ROWS = Object.freeze(
  [...DEALER_VENDORS.entries()].map(([salesCompany, v]) => Object.freeze({ salesCompany, ...v }))
);

/**
 * Resolve a Sales Company picklist value to an Acumatica vendor.
 *
 * @param {*} salesCompany - Sundial_Solar__c.Sales_Company_Harmon_Solar_or_Third__c
 * @returns {{ok: true, vendorId: string, vendorName: string, salesCompany: string}
 *          |{ok: false, reason: "blank"|"internal"|"inactive"|"unmapped", message: string, salesCompany: string, vendorId?: string}}
 *   Never throws, never returns a vendorId with ok:false. The caller must branch on
 *   `ok` — a truthy `vendorId` on the inactive result is there for the message, not
 *   for use.
 */
export function lookupDealerVendor(salesCompany) {
  const key = String(salesCompany ?? "").trim();
  if (key === "") {
    return {
      ok: false, reason: "blank", salesCompany: key,
      message: "No sales company on the record, so there is no vendor to raise a PO against.",
    };
  }

  const hit = DEALER_VENDORS.get(key);
  if (!hit) {
    return {
      ok: false, reason: "unmapped", salesCompany: key,
      message:
        `Sales company "${key}" is not in the dealer-vendor map (D4). Add it to ` +
        "docs/integrations/dealer-vendor-map.csv and regenerate, or correct the record. " +
        "Refusing to guess a vendor — a wrong one is a real payment to the wrong company.",
    };
  }

  if (hit.internal) {
    return {
      ok: false, reason: "internal", salesCompany: key, vendorId: hit.vendorId,
      message:
        `"${key}" is an INTERNAL deal (D16): internal commissions are payroll, not POs. ` +
        "Reaching vendor resolution at all means the deal-type gate upstream did not " +
        "stop this — that is the bug to fix, not this refusal.",
    };
  }

  if (hit.status !== "Active") {
    return {
      ok: false, reason: "inactive", salesCompany: key, vendorId: hit.vendorId,
      message:
        `Vendor ${hit.vendorId} ("${hit.vendorName}") for sales company "${key}" is ` +
        `${hit.status} in Acumatica. D4 requires failing loudly rather than raising a PO ` +
        "against an inactive vendor. Reactivate the vendor in Acumatica, or move the deal " +
        "to the dealer who is actually being paid.",
    };
  }

  return { ok: true, vendorId: hit.vendorId, vendorName: hit.vendorName, salesCompany: key };
}
