// Generate lib/acumatica-dealer-vendors.js from docs/integrations/dealer-vendor-map.csv.
//
// The CSV is the SOURCE OF TRUTH (D4). Harmon and Tim maintain it by matching the
// Sales Company picklist against the Acumatica vendor export; this script turns it into
// a module the Lambdas can import without parsing CSV at runtime.
//
// Re-runnable: edit the CSV, run this, commit both. Never hand-edit the generated file —
// the header says so and the next regeneration would silently discard the edit.
//
//   node scripts/generate-dealer-vendors.mjs           # write
//   node scripts/generate-dealer-vendors.mjs --check   # exit 1 if the file is stale
//
// `--check` exists so a stale generated file is a loud failure rather than a mystery:
// the CSV is the reviewable artefact in a PR, and it is entirely possible to update it
// and forget the regeneration step.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const CSV = path.join(repo, "docs", "integrations", "dealer-vendor-map.csv");
const OUT = path.join(repo, "lib", "acumatica-dealer-vendors.js");

/**
 * Minimal RFC-4180 CSV reader — quoted fields with embedded commas only.
 *
 * Written out rather than depending on a parser because the input is one small file we
 * control, and `"Impact Solar Energy, LLC"` is the only shape that needs handling. A
 * dependency here would be a bigger liability than fifteen lines.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  // Strip a UTF-8 BOM: Excel writes one, and it would otherwise become part of the
  // first header name and break every lookup by key.
  const s = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

const raw = parseCsv(fs.readFileSync(CSV, "utf8"));
const header = raw[0].map((h) => h.trim());
const EXPECTED = ["SalesCompanyPicklistValue", "AcumaticaVendorID", "AcumaticaVendorName", "VendorStatus", "Note"];
if (header.join(",") !== EXPECTED.join(",")) {
  console.error(`CSV header changed.\n  expected: ${EXPECTED.join(",")}\n  found:    ${header.join(",")}`);
  process.exit(1);
}

const records = raw.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));

// ---------------------------------------------------------------------------
// Validate before generating. A bad map is worse than no map: it would route a
// commission PO to the wrong vendor, which is a real payment to a real company.
// ---------------------------------------------------------------------------
const errors = [];
const seenKeys = new Map();
for (const [i, r] of records.entries()) {
  const line = i + 2; // 1-based, plus the header row
  if (!r.SalesCompanyPicklistValue) errors.push(`line ${line}: empty SalesCompanyPicklistValue`);
  if (!r.AcumaticaVendorID) errors.push(`line ${line}: empty AcumaticaVendorID`);
  if (!["Active", "Inactive"].includes(r.VendorStatus))
    errors.push(`line ${line}: VendorStatus must be Active or Inactive, got "${r.VendorStatus}"`);
  // A duplicate KEY is the dangerous direction — two rows claiming the same picklist
  // value means the lookup silently picks one. (Duplicate VENDOR ids are fine and
  // expected: those are the intentional aliases.)
  if (seenKeys.has(r.SalesCompanyPicklistValue))
    errors.push(`line ${line}: duplicate picklist value "${r.SalesCompanyPicklistValue}" (also line ${seenKeys.get(r.SalesCompanyPicklistValue)})`);
  seenKeys.set(r.SalesCompanyPicklistValue, line);
}
if (errors.length) {
  console.error("dealer-vendor-map.csv is invalid:\n  " + errors.join("\n  "));
  process.exit(1);
}

// The two rows whose Note column encodes a RULE rather than a comment. Recognised by
// value, not by position, and asserted below so a reordered CSV cannot lose them.
const INTERNAL_KEY = "Harmon Solar";
const internalRow = records.find((r) => r.SalesCompanyPicklistValue === INTERNAL_KEY);
if (!internalRow) {
  console.error(`CSV must contain the "${INTERNAL_KEY}" row — it is the internal-deal exclusion.`);
  process.exit(1);
}

const inactive = records.filter((r) => r.VendorStatus === "Inactive");
const aliasGroups = new Map();
for (const r of records) {
  if (!aliasGroups.has(r.AcumaticaVendorID)) aliasGroups.set(r.AcumaticaVendorID, []);
  aliasGroups.get(r.AcumaticaVendorID).push(r.SalesCompanyPicklistValue);
}
const aliased = [...aliasGroups.entries()].filter(([, ks]) => ks.length > 1);

const q = (s) => JSON.stringify(s);
const entries = records
  .map((r) => {
    const note = r.Note ? `  // ${r.Note}` : "";
    return `  [${q(r.SalesCompanyPicklistValue)}, { vendorId: ${q(r.AcumaticaVendorID)}, vendorName: ${q(r.AcumaticaVendorName)}, status: ${q(r.VendorStatus)}${r.SalesCompanyPicklistValue === INTERNAL_KEY ? ", internal: true" : ""} }],${note}`;
  })
  .join("\n");

const out = `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source:    docs/integrations/dealer-vendor-map.csv  (${records.length} rows)
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
// third case. \`lookupDealerVendor\` never guesses and never returns a partial answer:
//
//   ok: true            -> resolved to an ACTIVE vendor. Safe to raise a PO.
//   reason "internal"   -> "${INTERNAL_KEY}". Internal deals are payroll, not POs (D16).
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
${aliased.map(([v, ks]) => `//   ${v}  <-  ${ks.map((k) => `"${k}"`).join(" | ")}`).join("\n")}
//
// Note "Residental Solar Brokers" / "Residential Solar Brokers": both spellings are real
// picklist values. Do not "fix" either one — removing a key here makes every deal
// carrying it fail to resolve.

/** Sales Company picklist value -> vendor. Keys are EXACT picklist values. */
const DEALER_VENDORS = new Map([
${entries}
]);

/** The picklist value that means an internal Harmon deal (no PO — D16). */
export const INTERNAL_SALES_COMPANY = ${q(INTERNAL_KEY)};

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
 *   \`ok\` — a truthy \`vendorId\` on the inactive result is there for the message, not
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
        \`Sales company "\${key}" is not in the dealer-vendor map (D4). Add it to \` +
        "docs/integrations/dealer-vendor-map.csv and regenerate, or correct the record. " +
        "Refusing to guess a vendor — a wrong one is a real payment to the wrong company.",
    };
  }

  if (hit.internal) {
    return {
      ok: false, reason: "internal", salesCompany: key, vendorId: hit.vendorId,
      message:
        \`"\${key}" is an INTERNAL deal (D16): internal commissions are payroll, not POs. \` +
        "Reaching vendor resolution at all means the deal-type gate upstream did not " +
        "stop this — that is the bug to fix, not this refusal.",
    };
  }

  if (hit.status !== "Active") {
    return {
      ok: false, reason: "inactive", salesCompany: key, vendorId: hit.vendorId,
      message:
        \`Vendor \${hit.vendorId} ("\${hit.vendorName}") for sales company "\${key}" is \` +
        \`\${hit.status} in Acumatica. D4 requires failing loudly rather than raising a PO \` +
        "against an inactive vendor. Reactivate the vendor in Acumatica, or move the deal " +
        "to the dealer who is actually being paid.",
    };
  }

  return { ok: true, vendorId: hit.vendorId, vendorName: hit.vendorName, salesCompany: key };
}
`;

const mode = process.argv[2];
if (mode === "--check") {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== out) {
    console.error("lib/acumatica-dealer-vendors.js is STALE — run: node scripts/generate-dealer-vendors.mjs");
    process.exit(1);
  }
  console.log(`up to date (${records.length} rows)`);
} else {
  fs.writeFileSync(OUT, out);
  console.log(`wrote ${path.relative(repo, OUT)}`);
  console.log(`  rows          : ${records.length}`);
  console.log(`  distinct vendors: ${aliasGroups.size}`);
  console.log(`  aliased vendors : ${aliased.length}`);
  console.log(`  internal excl.  : ${INTERNAL_KEY} (${internalRow.AcumaticaVendorID})`);
  console.log(`  INACTIVE (fail loudly per D4): ${inactive.length ? inactive.map((r) => `${r.SalesCompanyPicklistValue} -> ${r.AcumaticaVendorID}`).join(", ") : "none"}`);
}
