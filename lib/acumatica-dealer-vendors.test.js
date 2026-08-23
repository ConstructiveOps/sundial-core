// Tests for the D4 dealer->vendor map.
//
// The map decides which company Harmon writes a purchase order to. A wrong answer here
// is not a bad row in a table, it is a real payment to the wrong business — so what is
// pinned below is mostly the REFUSALS, and the fact that they are distinguishable from
// each other.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  lookupDealerVendor,
  DEALER_VENDOR_ROWS,
  INTERNAL_SALES_COMPANY,
} from "./acumatica-dealer-vendors.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the generated file is in sync with the CSV", () => {
  // The CSV is the source of truth and the reviewable artefact. It is entirely possible
  // to edit it and forget to regenerate, and the symptom of that would be a vendor
  // lookup quietly returning last week's answer.
  execFileSync(process.execPath, ["scripts/generate-dealer-vendors.mjs", "--check"], {
    cwd: repo,
    stdio: "pipe",
  });
});

test("every row is complete and plausibly shaped", () => {
  assert.ok(DEALER_VENDOR_ROWS.length >= 50, `only ${DEALER_VENDOR_ROWS.length} rows`);
  for (const r of DEALER_VENDOR_ROWS) {
    assert.ok(r.salesCompany, "empty salesCompany");
    // Acumatica vendor ids are zero-padded numeric strings ("01926"). A number would
    // lose the leading zero, and that is a lookup failure in Acumatica, not an error here.
    assert.match(r.vendorId, /^\d{5}$/, `${r.salesCompany}: vendorId ${r.vendorId}`);
    assert.equal(typeof r.vendorId, "string");
    assert.ok(["Active", "Inactive"].includes(r.status), `${r.salesCompany}: ${r.status}`);
  }
});

test("no two picklist values claim different vendors under the same key", () => {
  const keys = DEALER_VENDOR_ROWS.map((r) => r.salesCompany);
  assert.equal(new Set(keys).size, keys.length, "duplicate picklist key — lookup would be ambiguous");
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test("a mapped active dealer resolves", () => {
  const r = lookupDealerVendor("Blue Sky Solar");
  assert.equal(r.ok, true);
  assert.equal(r.vendorId, "01736");
});

test("lookup TRIMS but does not otherwise normalise", () => {
  // Trim, because a trailing space in data is noise. Nothing else, because these are
  // PICKLIST values — the exact string is known, so a near-miss is a signal that
  // something is wrong rather than a spelling to forgive. Contrast the tax-zone map,
  // which case-folds free-text city names on purpose.
  assert.equal(lookupDealerVendor("  Blue Sky Solar  ").vendorId, "01736");
  assert.equal(lookupDealerVendor("blue sky solar").ok, false);
  assert.equal(lookupDealerVendor("BLUE SKY SOLAR").ok, false);
  assert.equal(lookupDealerVendor("BlueSkySolar").ok, false);
});

test("aliased spellings are separate keys reaching the same vendor", () => {
  // Intentional per the CSV: several dealers appear under two picklist spellings.
  for (const [a, b] of [
    ["Blue Sky Solar", "Blue Sky"],
    ["Machometa", "Machometa Enterprises"],
    ["Solar Buddy", "Solar Buddy AZ"],
    ["Mr. Clutch Solar", "Mr Clutch Solar"],
  ]) {
    const ra = lookupDealerVendor(a);
    const rb = lookupDealerVendor(b);
    assert.equal(ra.ok, true, `${a} did not resolve`);
    assert.equal(rb.ok, true, `${b} did not resolve`);
    assert.equal(ra.vendorId, rb.vendorId, `${a} and ${b} must share a vendor`);
  }
});

test("BOTH spellings of Residen[t]ial Solar Brokers resolve", () => {
  // The misspelled one is a real picklist value. "Correcting" the CSV by deleting it
  // would make every deal carrying it fail to resolve — the same trap as Acumatica's
  // RESIDENTAL inventory id.
  const misspelled = lookupDealerVendor("Residental Solar Brokers");
  const correct = lookupDealerVendor("Residential Solar Brokers");
  assert.equal(misspelled.ok, true);
  assert.equal(correct.ok, true);
  assert.equal(misspelled.vendorId, correct.vendorId);
});

// ---------------------------------------------------------------------------
// The four refusals — each distinguishable, because each needs a different fix
// ---------------------------------------------------------------------------

test("INTERNAL: Harmon Solar refuses, and says the gate upstream is the real fix", () => {
  const r = lookupDealerVendor(INTERNAL_SALES_COMPANY);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "internal");
  assert.equal(INTERNAL_SALES_COMPANY, "Harmon Solar");
  // It carries a vendorId — Harmon IS a vendor in Acumatica — which is exactly why the
  // refusal has to be explicit rather than falling out of a failed lookup.
  assert.equal(r.vendorId, "00821");
  assert.match(r.message, /deal-type gate upstream/);
});

test("INTERNAL is belt-and-braces, not the primary defence", () => {
  // D16 says internal deals are payroll and never reach a PO at all. This is the second
  // line: if the deal-type gate is ever bypassed or refactored wrong, the request stops
  // here rather than raising a purchase order against Harmon's own vendor record.
  assert.equal(lookupDealerVendor("Harmon Solar").ok, false);
  assert.equal(lookupDealerVendor("  Harmon Solar ").reason, "internal");
});

test("INACTIVE: Derek Anderson refuses loudly per D4", () => {
  const r = lookupDealerVendor("Derek Anderson");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "inactive");
  assert.equal(r.vendorId, "01863");
  assert.match(r.message, /Inactive in Acumatica/);
  // The distinction that matters: this is NOT "unmapped". The vendor exists and we know
  // exactly which one it is — it just cannot be paid. Conflating the two would send
  // someone to edit the CSV when the fix is in Acumatica.
  assert.notEqual(r.reason, "unmapped");
});

test("UNMAPPED: an unknown dealer refuses rather than guessing", () => {
  const r = lookupDealerVendor("Some Dealer Signed Last Tuesday");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unmapped");
  assert.equal(r.vendorId, undefined, "an unmapped result must not carry a vendorId");
  assert.match(r.message, /dealer-vendor-map\.csv/);
});

test("BLANK: no sales company is its own reason", () => {
  for (const v of [null, undefined, "", "   "]) {
    const r = lookupDealerVendor(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} should not resolve`);
    assert.equal(r.reason, "blank");
  }
});

test("no refusal ever leaks a usable vendorId as a success", () => {
  // The one property the caller depends on: branch on `ok`, never on truthiness of
  // vendorId. Two refusals DO carry a vendorId (internal, inactive) for their messages.
  for (const v of ["Harmon Solar", "Derek Anderson", "Nope", "", null]) {
    const r = lookupDealerVendor(v);
    if (!r.ok) assert.notEqual(r.reason, undefined, "every refusal must carry a reason");
  }
  assert.equal(lookupDealerVendor("Harmon Solar").ok, false);
});

test("every refusal message names the fix, not just the problem", () => {
  for (const v of ["Harmon Solar", "Derek Anderson", "Unknown Co", ""]) {
    const r = lookupDealerVendor(v);
    assert.ok(r.message && r.message.length > 40, `${v}: message too thin`);
  }
});
