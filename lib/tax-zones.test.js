// lib/tax-zones.test.js — D-083: the resolver, the line-category defaults, the rate-by-date
// math, the Acumatica → table builder and its drift report. Pure; no Supabase, no Acumatica.
//
// Run: node --test lib/tax-zones.test.js   (also in `npm test`)

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCity,
  resolveTaxZoneIn,
  resolveTaxZone,
  tablesFromRows,
  defaultTaxCategory,
  effectiveTaxCategory,
  validTaxCategory,
  rateAsOf,
  categoryRate,
  zoneCategoryRates,
  headlineRate,
  lineTaxable,
  lineTaxCategory,
  zoneLabel,
  buildTaxTableRows,
  estimateTaxContext,
  syncTaxTables,
} from "./tax-zones.js";
import { computeTotals, lineFromRecord, estimateFromRecord } from "../lambdas/sundial-service-estimate/totals.js";

// Acumatica's own shape, trimmed to what the rule reads. Phoenix city tax rises on 2026-11-01.
const ROWS = {
  zones: [
    { zone_code: "08PHOENIXR", description: "Phoenix - Retail", city_key: "PHOENIX", county: "Maricopa", is_retail: true, tax_ids: ["08PHXRT", "08MCORT", "LABSERVE", "SOLAR", "WARRANTY"] },
    { zone_code: "08MARICOPR", description: "Maricopa County - Retail", city_key: null, county: "Maricopa", is_retail: true, tax_ids: ["08MCORT", "LABSERVE", "SOLAR", "WARRANTY"] },
    { zone_code: "14DEWEYHUR", description: "Dewey-Humboldt - Retail", city_key: "DEWEY", county: "Yavapai", is_retail: true, tax_ids: ["14YACRT", "14DHRT", "LABSERVE"] },
    { zone_code: "08PHOENIXC", description: "Phoenix - Contracting", city_key: null, is_retail: false, tax_ids: ["08PHXCO"] },
  ],
  rates: [
    { tax_id: "08PHXRT", schedule: [{ start: "2021-01-01", rate: 2.3 }, { start: "2025-07-01", rate: 2.8 }, { start: "2026-11-01", rate: 3.3 }] },
    { tax_id: "08MCORT", schedule: [{ start: "2021-01-01", rate: 6.3 }] },
    { tax_id: "14YACRT", schedule: [{ start: "2021-01-01", rate: 6.35 }] },
    { tax_id: "14DHRT", schedule: [{ start: "2021-01-01", rate: 2 }] }, // in NO category (Acumatica's own gap)
    { tax_id: "08PHXCO", schedule: [{ start: "2021-01-01", rate: 1.82 }] },
    { tax_id: "LABSERVE", schedule: [{ start: "2021-01-01", rate: 0 }] },
    { tax_id: "SOLAR", schedule: [{ start: "2021-01-01", rate: 0 }] },
    { tax_id: "WARRANTY", schedule: [{ start: "2021-01-01", rate: 0 }] },
  ],
  categories: [
    { category_id: "RETAIL", tax_ids: ["08PHXRT", "08MCORT", "14YACRT"] },
    { category_id: "LABSERV", tax_ids: ["LABSERVE"] },
    { category_id: "SOLAR", tax_ids: ["SOLAR"] },
    { category_id: "WARRANTY", tax_ids: ["WARRANTY"] },
    { category_id: "RESALE", tax_ids: [] },
    { category_id: "CONTRACTING", tax_ids: ["08PHXCO"] },
  ],
  aliases: [
    { alias_key: "SUN CITY", zone_code: "08MARICOPR", note: "from CFO 2026-10-06" },
    { alias_key: "Sun City West", zone_code: "08MARICOPR", note: "from CFO 2026-10-06" },
    { alias_key: "ANTHEM", zone_code: "08PHOENIXR", note: "from CFO 2026-10-06" },
    { alias_key: "LAVEEN", zone_code: "08PHOENIXR", note: "from CFO 2026-10-06" },
    { alias_key: "DEWEY HUMBOLDT", zone_code: "14DEWEYHUR", note: "spelling" },
    { alias_key: "GHOST TOWN", zone_code: "99GONER", note: "points at a zone Acumatica no longer has" },
  ],
};
const T = tablesFromRows(ROWS);

// --- the resolver -----------------------------------------------------------------------
test("resolver: case, spacing and punctuation never matter", () => {
  for (const c of ["Phoenix", "PHOENIX", "  phoenix ", "Phoenix,", "phoenix."]) {
    const r = resolveTaxZoneIn(T, c);
    assert.equal(r.matched, true, c);
    assert.equal(r.zone.code, "08PHOENIXR");
    assert.equal(r.via, "city");
  }
  assert.equal(normalizeCity("Dewey-Humboldt"), "DEWEY HUMBOLDT", "a hyphen is a space, not a join");
});

test("resolver: aliases (the CFO's four, a map spelling) win and are normalised the same way", () => {
  assert.equal(resolveTaxZoneIn(T, "Sun City").zone.code, "08MARICOPR");
  assert.equal(resolveTaxZoneIn(T, "sun city west").zone.code, "08MARICOPR");
  assert.equal(resolveTaxZoneIn(T, "Anthem").zone.label, "Phoenix");
  assert.equal(resolveTaxZoneIn(T, "LAVEEN").via, "alias");
  assert.equal(resolveTaxZoneIn(T, "Dewey-Humboldt").zone.code, "14DEWEYHUR");
});

test("resolver: never guesses — unmatched, blank, a county-only zone by its name, a dead alias, no tables", () => {
  assert.deepEqual(resolveTaxZoneIn(T, "Nowhere"), { matched: false, normalized: "NOWHERE", reason: "UNMATCHED" });
  assert.equal(resolveTaxZoneIn(T, "").reason, "NO_CITY");
  assert.equal(resolveTaxZoneIn(T, null).reason, "NO_CITY");
  assert.equal(resolveTaxZoneIn(T, "Maricopa County").matched, false, "a county zone is reached by alias or the picker, never by its name");
  assert.equal(resolveTaxZoneIn(T, "Phoenix Contracting").matched, false);
  assert.equal(resolveTaxZoneIn(T, "Ghost Town").reason, "ALIAS_ZONE_MISSING");
  assert.equal(resolveTaxZoneIn(null, "Phoenix").reason, "NO_TABLE");
  assert.equal(resolveTaxZoneIn(tablesFromRows({}), "Phoenix").reason, "NO_TABLE");
});

test("resolveTaxZone({ tenant, city }) loads the tenant's tables; no tenant → unmatched", async () => {
  const seen = [];
  const loadTables = async (tenant) => (seen.push(tenant), T);
  assert.equal((await resolveTaxZone({ tenant: "harmon", city: "Anthem" }, { loadTables })).zone.code, "08PHOENIXR");
  assert.deepEqual(seen, ["harmon"]);
  assert.equal((await resolveTaxZone({ tenant: null, city: "Phoenix" }, { loadTables })).matched, false);
});

// --- line categories ----------------------------------------------------------------------
test("category defaults (Tim, 2026-10-15): Labor / Fee → LABSERV; Material / Product → RETAIL ALWAYS — the old taxable flag is not an input", () => {
  assert.equal(defaultTaxCategory({ kind: "Labor" }), "LABSERV");
  assert.equal(defaultTaxCategory({ kind: "Fee", taxable: true }), "LABSERV");
  assert.equal(defaultTaxCategory({ kind: "Material", taxable: true }), "RETAIL");
  assert.equal(defaultTaxCategory({ kind: "Material", taxable: false }), "RETAIL", "never SOLAR by default");
  assert.equal(defaultTaxCategory({ kind: "Product" }), "RETAIL");
  assert.equal(defaultTaxCategory({}), "LABSERV");
});

test("taxable is derived and read-only: RETAIL (own category, else the kind's default) = ticked", () => {
  assert.equal(lineTaxable({ kind: "Material" }), true);
  assert.equal(lineTaxable({ kind: "Material", taxCategory: "SOLAR" }), false);
  assert.equal(lineTaxable({ kind: "Material", taxCategory: "WARRANTY" }), false);
  assert.equal(lineTaxable({ kind: "Material", taxCategory: "RESALE" }), false);
  assert.equal(lineTaxable({ kind: "Labor" }), false);
  assert.equal(lineTaxable({ kind: "Fee", taxCategory: "RETAIL" }), true);
  assert.equal(lineTaxCategory({ kind: "Product", taxCategory: "bogus" }), "RETAIL");
});

test("category: an explicit one (office or price-book item) wins; junk is not a category", () => {
  assert.equal(effectiveTaxCategory({ kind: "Material", taxable: true, taxCategory: "SOLAR" }), "SOLAR", "the item says solar");
  assert.equal(effectiveTaxCategory({ kind: "Labor", taxCategory: "resale" }), "RESALE");
  assert.equal(effectiveTaxCategory({ kind: "Material", taxable: true, taxCategory: "BOGUS" }), "RETAIL", "unknown = not set = the default");
  assert.equal(validTaxCategory(" retail "), "RETAIL");
  assert.equal(validTaxCategory("CONTRACTING"), null, "not a Service line category");
});

test("category: a warranty-billed job is WARRANTY on every line except materials explicitly set RETAIL", () => {
  for (const billToType of ["Internal Warranty", "Manufacturer"]) {
    const ctx = { billToType };
    assert.equal(effectiveTaxCategory({ kind: "Labor" }, ctx), "WARRANTY");
    assert.equal(effectiveTaxCategory({ kind: "Material", taxable: true }, ctx), "WARRANTY", "a DEFAULT retail material is warranty work");
    assert.equal(effectiveTaxCategory({ kind: "Material", taxCategory: "RETAIL" }, ctx), "RETAIL", "explicitly Retail stays Retail");
    assert.equal(effectiveTaxCategory({ kind: "Product", taxCategory: "RETAIL" }, ctx), "WARRANTY", "the exception is materials only");
    assert.equal(effectiveTaxCategory({ kind: "Material", taxCategory: "SOLAR" }, ctx), "WARRANTY");
  }
  assert.equal(effectiveTaxCategory({ kind: "Material", taxable: true }, { billToType: "Leasing Partner" }), "RETAIL");
});

// --- rates by date ------------------------------------------------------------------------
test("rateAsOf: the latest start on or before the date; none before the first", () => {
  const s = ROWS.rates[0].schedule;
  assert.deepEqual(rateAsOf(s, "2026-10-31"), { start: "2025-07-01", rate: 2.8 });
  assert.deepEqual(rateAsOf(s, "2026-11-01"), { start: "2026-11-01", rate: 3.3 });
  assert.deepEqual(rateAsOf(s, new Date("2026-11-02T03:00:00Z")), { start: "2026-11-01", rate: 3.3 });
  assert.equal(rateAsOf(s, "2020-12-31"), null);
  assert.equal(rateAsOf([], "2026-01-01"), null);
});

test("category rate = Σ taxes in BOTH the zone and the category, as of the date (Acumatica's rule, no RETAIL special case)", () => {
  const phx = T.zones.get("08PHOENIXR");
  assert.equal(categoryRate({ zone: phx, categoryId: "RETAIL", tables: T, date: "2026-10-15" }).rate, 9.1);
  assert.equal(categoryRate({ zone: phx, categoryId: "RETAIL", tables: T, date: "2026-11-01" }).rate, 9.6);
  assert.equal(categoryRate({ zone: phx, categoryId: "LABSERV", tables: T, date: "2026-10-15" }).rate, 0);
  assert.equal(categoryRate({ zone: phx, categoryId: "RESALE", tables: T, date: "2026-10-15" }).rate, 0, "a category with no taxes is 0%");
  assert.equal(categoryRate({ zone: phx, categoryId: "CONTRACTING", tables: T, date: "2026-10-15" }).rate, 0, "the zone does not carry the contracting tax");
  // Dewey-Humboldt carries 14DHRT, but no category includes it: Acumatica never charges it, nor do we.
  const dh = T.zones.get("14DEWEYHUR");
  assert.equal(categoryRate({ zone: dh, categoryId: "RETAIL", tables: T, date: "2026-10-15" }).rate, 6.35);
  assert.deepEqual(zoneCategoryRates({ zone: phx, tables: T, date: "2026-10-15" }), { RETAIL: 9.1, LABSERV: 0, SOLAR: 0, WARRANTY: 0, RESALE: 0, CONTRACTING: 0 });
  assert.equal(headlineRate({ zone: phx, tables: T, date: "2026-10-15" }), 9.1);
  assert.equal(zoneLabel("Coconino County  - Retail"), "Coconino County");
  assert.equal(zoneLabel("Coolidge -Retail"), "Coolidge");
  assert.equal(zoneLabel("Wilcox Retail"), "Wilcox");
});

// --- the math on a mixed invoice ------------------------------------------------------------
const MIXED = [
  { Id: "L1", Kind__c: "Labor", Quantity__c: 2, Unit_Price__c: 150, Taxable__c: false, Stage__c: "Approved" },                       // 300 LABSERV
  { Id: "L2", Kind__c: "Material", Quantity__c: 1, Unit_Price__c: 200, Taxable__c: true, Stage__c: "Approved" },                     // 200 RETAIL (default)
  { Id: "L3", Kind__c: "Material", Quantity__c: 1, Unit_Price__c: 1000, Taxable__c: false, Tax_Category__c: "SOLAR", Stage__c: "Approved" }, // 1000 SOLAR (item default)
  { Id: "L4", Kind__c: "Fee", Quantity__c: 1, Unit_Price__c: 50, Taxable__c: false, Stage__c: "Approved" },                          // 50 LABSERV
  { Id: "L5", Kind__c: "Material", Quantity__c: 4, Unit_Price__c: 12.5, Taxable__c: false, Tax_Category__c: "RETAIL", Stage__c: "Approved" }, // 50 RETAIL (explicit)
  { Id: "L6", Kind__c: "Material", Quantity__c: 1, Unit_Price__c: 999, Taxable__c: true, Stage__c: "Removed" },                      // ignored
];
const phxOn = (date, billToType = "Customer") => ({ categoryRates: zoneCategoryRates({ zone: T.zones.get("08PHOENIXR"), tables: T, date }), billToType });

test("math on a mixed invoice: only lines whose category carries a zone tax are taxed, at that rate, on the date", () => {
  const t = computeTotals(MIXED.map(lineFromRecord), estimateFromRecord({}, phxOn("2026-10-15")));
  assert.equal(t.subtotal, 1600);
  assert.equal(t.taxableValue, 250, "RETAIL 200 + 50; labor, fee and solar untaxed");
  assert.equal(t.taxAmount, 22.75, "250 × 9.1%");
  assert.equal(t.total, 1622.75);
  assert.deepEqual(t.taxByCategory.RETAIL, { base: 250, rate: 9.1, tax: 22.75 });
  assert.deepEqual(t.taxByCategory.SOLAR, { base: 1000, rate: 0, tax: 0 });
  assert.deepEqual(t.lineTotals.map((l) => l.taxCategory), ["LABSERV", "RETAIL", "SOLAR", "LABSERV", "RETAIL"]);
  // The same invoice issued on Nov 1 pays the new city rate.
  assert.equal(computeTotals(MIXED.map(lineFromRecord), estimateFromRecord({}, phxOn("2026-11-01"))).taxAmount, 24, "250 × 9.6%");
});

test("math: a discount is shared proportionally before tax; a warranty job taxes only the explicit Retail material", () => {
  const disc = computeTotals(MIXED.map(lineFromRecord), estimateFromRecord({ Discount_Scope__c: "Both", Discount_Type__c: "Amount", Discount_Value__c: 160 }, phxOn("2026-10-15")));
  // net 1440 of 1600 → taxable 250 × 0.9 = 225 × 9.1% = 20.475 → 20.48
  assert.equal(disc.taxAmount, 20.48);
  const warranty = computeTotals(MIXED.map(lineFromRecord), estimateFromRecord({}, phxOn("2026-10-15", "Manufacturer")));
  assert.equal(warranty.taxableValue, 50, "L5 is the only explicitly-Retail material");
  assert.equal(warranty.taxAmount, 4.55);
});

test("math: an unresolved zone (a context with no rates) taxes nothing; no context at all is the pre-D-083 rule", () => {
  const unresolved = computeTotals(MIXED.map(lineFromRecord), estimateFromRecord({ Tax_Rate__c: 8.6 }, { categoryRates: {}, billToType: null }));
  assert.equal(unresolved.taxAmount, 0, "never the old typed rate once the zone decides");
  const legacy = computeTotals(MIXED.map(lineFromRecord), estimateFromRecord({ Tax_Rate__c: 10 }));
  assert.equal(legacy.taxAmount, 20, "Taxable__c lines (L2 only) × the stored rate");
});

// --- the estimate's tax context ----------------------------------------------------------------
function fakeSf(rows) {
  const queries = [];
  return {
    queries,
    sfQuery: async (soql) => {
      queries.push(soql);
      const obj = soql.match(/FROM (\w+)/)[1];
      return rows[obj] ?? [];
    },
  };
}
const esc = (s) => String(s).replace(/'/g, "\\'");

test("tax context: the job's zone decides; a blank job zone is unresolved even when the city would match", async () => {
  const sf = fakeSf({ Sundial_Service_Job__c: [{ Id: "J1", Tax_Zone_Code__c: "08PHOENIXR", Bill_To_Type__c: "Manufacturer" }] });
  const ctx = await estimateTaxContext({ est: { Id: "E1", Service_Job__c: "J1", Sundial_Customer__c: "C1" }, tenantId: "T", tenantSlug: "harmon", date: "2026-11-02", sfQuery: sf.sfQuery, soqlEscapeString: esc, loadTables: async () => T });
  assert.equal(ctx.matched, true);
  assert.equal(ctx.source, "job");
  assert.equal(ctx.label, "Phoenix");
  assert.equal(ctx.rate, 9.6);
  assert.equal(ctx.billToType, "Manufacturer");
  const blank = fakeSf({ Sundial_Service_Job__c: [{ Id: "J1", Tax_Zone_Code__c: null }], Sundial_Customer__c: [{ Id: "C1", City__c: "Phoenix" }] });
  const b = await estimateTaxContext({ est: { Id: "E1", Service_Job__c: "J1", Sundial_Customer__c: "C1" }, tenantId: "T", tenantSlug: "harmon", sfQuery: blank.sfQuery, soqlEscapeString: esc, loadTables: async () => T });
  assert.equal(b.matched, false);
  assert.equal(b.reason, "JOB_ZONE_BLANK");
  assert.ok(!blank.queries.some((q) => q.includes("Sundial_Customer__c")), "the city is not re-guessed once a job exists");
});

test("tax context: no job → the customer's city; a template has none; an invoiced estimate reads at its invoice's issue date", async () => {
  const sf = fakeSf({ Sundial_Customer__c: [{ Id: "C1", City__c: "Laveen" }] });
  const c = await estimateTaxContext({ est: { Id: "E1", Sundial_Customer__c: "C1" }, tenantId: "T", tenantSlug: "harmon", now: new Date("2026-10-15T12:00:00Z"), sfQuery: sf.sfQuery, soqlEscapeString: esc, loadTables: async () => T });
  assert.equal(c.source, "customer");
  assert.equal(c.zoneCode, "08PHOENIXR");
  assert.equal(c.rate, 9.1);
  const tpl = await estimateTaxContext({ est: { Id: "E2", Is_Template__c: true }, tenantId: "T", tenantSlug: "harmon", sfQuery: sf.sfQuery, soqlEscapeString: esc, loadTables: async () => T });
  assert.equal(tpl.reason, "TEMPLATE");
  const inv = fakeSf({ Sundial_Service_Job__c: [{ Id: "J1", Tax_Zone_Code__c: "08PHOENIXR" }], Sundial_Service_Invoice__c: [{ Issued_At__c: "2026-10-20T17:00:00Z" }] });
  const frozen = await estimateTaxContext({ est: { Id: "E1", Status__c: "Invoiced", Service_Job__c: "J1" }, tenantId: "T", tenantSlug: "harmon", now: new Date("2026-11-05T12:00:00Z"), sfQuery: inv.sfQuery, soqlEscapeString: esc, loadTables: async () => T });
  assert.equal(frozen.rate, 9.1, "issued in October: October's rate, even read in November");
});

// --- Acumatica → rows ----------------------------------------------------------------------------
const val = (value) => ({ value });
const RAW = {
  zones: [
    { TaxZoneID: val("08PHOENIXR"), Description: val("Phoenix - Retail"), ApplicableTaxes: [{ TaxID: val("08PHXRT") }, { TaxID: val("08MCORT") }, { TaxID: val("LABSERVE") }] },
    { TaxZoneID: val("08MARICOPR"), Description: val("Maricopa County - Retail"), ApplicableTaxes: [{ TaxID: val("08MCORT") }] },
    { TaxZoneID: val("02SIERRAVR"), Description: val("Sierra Vista Retail"), ApplicableTaxes: [{ TaxID: val("02COCRT") }, { TaxID: val("02SIERRAVISTR") }] },
    { TaxZoneID: val("12APACHEJR"), Description: val("Apache Junction - Retail"), ApplicableTaxes: [{ TaxID: val("12AJRT") }, { TaxID: val("12PNCC") }] },
    { TaxZoneID: val("08PHOENIXC"), Description: val("Phoenix - Contracting"), ApplicableTaxes: [{ TaxID: val("08PHXCO") }] },
  ],
  taxes: [
    { TaxID: val("08PHXRT"), Description: val("Phoenix Retail"), TaxSchedule: [{ StartDate: val("2025-07-01T00:00:00+00:00"), TaxRate: val(2.8) }, { StartDate: val("2021-01-01T00:00:00+00:00"), TaxRate: val(2.3) }] },
    { TaxID: val("08MCORT"), Description: val("Maricopa County Retail"), TaxSchedule: [{ StartDate: val("2021-01-01T00:00:00+00:00"), TaxRate: val(6.3) }] },
    { TaxID: val("LABSERVE"), Description: val("Labor/Services - Exempt"), TaxSchedule: [{ StartDate: val("2021-01-01T00:00:00+00:00"), TaxRate: val(0) }] },
    { TaxID: val("02COCRT"), Description: val("Cochise County Retail"), TaxSchedule: [{ StartDate: val("2021-01-01T00:00:00+00:00"), TaxRate: val(6.6) }] },
    { TaxID: val("02SIERRAVISTR"), Description: val("Sierra Vista Retail"), TaxSchedule: [{ StartDate: val("2015-01-30T00:00:00+00:00"), TaxRate: val(1.95) }] },
    { TaxID: val("12AJRT"), Description: val("Apache Junction Retail"), TaxSchedule: [{ StartDate: val("2021-01-01T00:00:00+00:00"), TaxRate: val(2.4) }] },
    { TaxID: val("12PNCC"), Description: val("Pinal County Contracting"), TaxSchedule: [{ StartDate: val("2021-01-01T00:00:00+00:00"), TaxRate: val(4.355) }] },
    { TaxID: val("08PHXCO"), Description: val("Phoenix Contracting"), TaxSchedule: [{ StartDate: val("2021-01-01T00:00:00+00:00"), TaxRate: val(1.82) }] },
  ],
  categories: [
    { TaxCategoryID: val("RETAIL"), Description: val("Taxable Retail"), Active: val(true), ExcludeListedTaxes: val(false), Details: [{ TaxID: val("08PHXRT") }, { TaxID: val("08MCORT") }, { TaxID: val("02COCRT") }, { TaxID: val("12AJRT") }] },
    { TaxCategoryID: val("LABSERV"), Description: val("Labor/Services - Exempt (Retail)"), Active: val(true), Details: [{ TaxID: val("LABSERVE") }] },
    { TaxCategoryID: val("CONTRACTING"), Description: val("Contracting - Taxable"), Active: val(true), Details: [{ TaxID: val("12PNCC") }, { TaxID: val("08PHXCO") }] },
  ],
};
const CITY_MAP = { PHOENIX: "08PHOENIXR", "SIERRA VISTA": "02SIERRAVR", "APACHE JUNCTION": "12APACHEJR", "PHX": "08PHOENIXR" };

test("builder: rows exactly as Acumatica holds them — schedules sorted, city_key from the map, county zones keyless, extra spellings become aliases", () => {
  const b = buildTaxTableRows(RAW, { tenant: "harmon", today: "2026-10-15", syncedAt: "2026-10-15T12:00:00Z", cityMap: CITY_MAP });
  const phx = b.zones.find((z) => z.zone_code === "08PHOENIXR");
  assert.equal(phx.city_key, "PHOENIX");
  assert.equal(phx.county, "Maricopa");
  assert.equal(phx.combined_rate, 9.1);
  assert.equal(phx.effective_from, "2025-07-01");
  assert.deepEqual(phx.tax_ids, ["08PHXRT", "08MCORT", "LABSERVE"]);
  assert.equal(phx.is_retail, true);
  const county = b.zones.find((z) => z.zone_code === "08MARICOPR");
  assert.equal(county.city_key, null);
  assert.equal(county.county, "Maricopa");
  assert.equal(b.zones.find((z) => z.zone_code === "08PHOENIXC").is_retail, false);
  assert.equal(b.zones.find((z) => z.zone_code === "02SIERRAVR").combined_rate, 6.6, "copied exactly: the city tax is in no category, so it is not in the rate");
  assert.deepEqual(b.rates.find((r) => r.tax_id === "08PHXRT").schedule, [{ start: "2021-01-01", rate: 2.3 }, { start: "2025-07-01", rate: 2.8 }]);
  assert.deepEqual(b.categories.find((c) => c.category_id === "CONTRACTING").tax_ids, ["08PHXCO", "12PNCC"]);
  assert.deepEqual(b.aliases, [{ tenant: "harmon", alias_key: "PHX", zone_code: "08PHOENIXR", note: "spelling from lib/acumatica-tax-zones.js" }]);
});

test("builder drift: a retail city tax in no category, and a contracting tax on a retail zone, are flagged every run", () => {
  const { drift } = buildTaxTableRows(RAW, { tenant: "harmon", today: "2026-10-15", cityMap: CITY_MAP });
  assert.deepEqual(drift.cityTaxNotRetail.map((x) => [x.zone, x.taxId]), [["02SIERRAVR", "02SIERRAVISTR"]]);
  assert.deepEqual(drift.contractingTaxOnRetail.map((x) => [x.zone, x.taxId]), [["12APACHEJR", "12PNCC"]]);
  assert.deepEqual(drift.unmappedRetail, []);
});

test("sync: upserts the four tables, prunes what Acumatica dropped, and refuses to prune on a partial pull", async () => {
  const calls = [];
  const existing = { sundial_tax_zones: Array.from({ length: 4 }, (_, i) => ({ zone_code: `Z${i}` })) };
  const supabase = {
    from: (table) => ({
      upsert: async (rows, opts) => (calls.push(["upsert", table, rows.length, opts.onConflict]), { error: null }),
      select: () => ({ eq: async () => ({ data: existing[table] ?? [], error: null }) }),
      delete: () => ({ eq: () => ({ not: (col, op, list) => ({ select: async () => (calls.push(["delete", table, col, op, list.length > 2]), { data: [{}], error: null }) }) }) }),
    }),
  };
  const r = await syncTaxTables({ supabase, tenant: "harmon", raw: RAW, today: "2026-10-15" });
  assert.equal(r.zones, 5);
  assert.deepEqual(calls.filter((c) => c[0] === "upsert").map((c) => c[1]), ["sundial_tax_rates", "sundial_tax_categories", "sundial_tax_zones"]);
  assert.equal(calls.filter((c) => c[0] === "delete").length, 3, "zones, rates and categories pruned");
  // A pull with far fewer zones than are stored never prunes.
  calls.length = 0;
  existing.sundial_tax_zones = Array.from({ length: 140 }, (_, i) => ({ zone_code: `Z${i}` }));
  await syncTaxTables({ supabase, tenant: "harmon", raw: RAW, today: "2026-10-15" });
  assert.equal(calls.filter((c) => c[0] === "delete").length, 0);
  await assert.rejects(syncTaxTables({ supabase, tenant: "harmon", raw: { zones: [], taxes: [], categories: [] } }), /no tax zones/);
});

// --- the backfill planner ---------------------------------------------------------------------
import { cityFromAddressLine, planJobZones } from "./tax-zones.js";

test("backfill: the city is read from the END of the service address, a comma in the street is harmless", () => {
  assert.equal(cityFromAddressLine("123 N Main St, Phoenix, AZ, 85001"), "Phoenix");
  assert.equal(cityFromAddressLine("123 N Main St, Unit 4, Sun City, Arizona, 85351"), "Sun City");
  assert.equal(cityFromAddressLine("9 Ash Ct, Mesa, AZ 85201"), "Mesa");
  assert.equal(cityFromAddressLine("9 Ash Ct, Laveen"), "Laveen");
  assert.equal(cityFromAddressLine("9 Ash Ct"), null);
  assert.equal(cityFromAddressLine("AZ, 85001"), null);
  assert.equal(cityFromAddressLine(null), null);
});

test("backfill plan: open + blank only; exact matches (city or alias) planned, everything else listed with its reason", () => {
  const jobs = [
    { Id: "J1", Name: "SVC-1", Status__c: "Scheduled", Address_at_Creation__c: "1 A St, Phoenix, AZ, 85001", Customer_Name_at_Creation__c: "Ann" },
    { Id: "J2", Name: "SVC-2", Status__c: "New", Address_at_Creation__c: "2 B St, Sun City West, AZ, 85375", Customer_Name_at_Creation__c: "Bo" },
    { Id: "J3", Name: "SVC-3", Status__c: "Ready to Bill", Address_at_Creation__c: "3 C St, Nowhere, AZ, 85000", Customer_Name_at_Creation__c: "Cy" },
    { Id: "J4", Name: "SVC-4", Status__c: "Invoiced", Address_at_Creation__c: null, Sundial_Customer__r: { City__c: "laveen" }, Customer_Name_at_Creation__c: "Di" },
    { Id: "J5", Name: "SVC-5", Status__c: "Paid", Address_at_Creation__c: "5 E St, Phoenix, AZ, 85001" },
    { Id: "J6", Name: "SVC-6", Status__c: "Closed", Address_at_Creation__c: "6 F St, Phoenix, AZ, 85001" },
    { Id: "J7", Name: "SVC-7", Status__c: "Cancelled", Address_at_Creation__c: "7 G St, Phoenix, AZ, 85001" },
    { Id: "J8", Name: "SVC-8", Status__c: "Scheduled", Tax_Zone_Code__c: "08MARICOPR", Address_at_Creation__c: "8 H St, Phoenix, AZ, 85001" },
    { Id: "J9", Name: "SVC-9", Status__c: "Scheduled", Address_at_Creation__c: "", Customer_Name_at_Creation__c: "Ed" },
  ];
  const p = planJobZones(jobs, T);
  assert.deepEqual(p.matched.map((m) => [m.number, m.zoneCode, m.via, m.source]), [
    ["SVC-1", "08PHOENIXR", "city", "service address"],
    ["SVC-2", "08MARICOPR", "alias", "service address"],
    ["SVC-4", "08PHOENIXR", "alias", "customer city"],
  ]);
  assert.deepEqual(p.unmatched.map((u) => [u.number, u.customer, u.city, u.reason]), [["SVC-3", "Cy", "Nowhere", "UNMATCHED"], ["SVC-9", "Ed", null, "NO_CITY"]]);
  assert.equal(p.skipped, 4, "Paid / Closed / Cancelled and an already-zoned job are never touched");
});

// --- the city map (lib/acumatica-tax-zones.js) ----------------------------------------------------
import { lookupTaxZone, RAW_TAX_ZONES } from "./acumatica-tax-zones.js";

test("city map: \"Lake Havasu City\" (the real name) is the same zone as \"Lake Havasu\" — in the push and, as an alias row, in the resolver", () => {
  assert.equal(lookupTaxZone("Lake Havasu City").zone, "09LAKEHAVR");
  assert.equal(lookupTaxZone("lake havasu city,").zone, "09LAKEHAVR");
  assert.equal(lookupTaxZone("Lake Havasu").zone, "09LAKEHAVR");
  const raw = { zones: [{ TaxZoneID: { value: "09LAKEHAVR" }, Description: { value: "Lake Havasu - Retail" }, ApplicableTaxes: [] }], taxes: [], categories: [] };
  const b = buildTaxTableRows(raw, { tenant: "harmon", today: "2026-10-15", cityMap: RAW_TAX_ZONES });
  assert.equal(b.zones[0].city_key, "LAKE HAVASU", "the first spelling is the zone's city");
  assert.deepEqual(b.aliases.map((a) => [a.alias_key, a.zone_code]), [["LAKE HAVASU CITY", "09LAKEHAVR"]]);
  const t = tablesFromRows({ zones: b.zones, aliases: b.aliases });
  assert.equal(resolveTaxZoneIn(t, "Lake Havasu City").zone.code, "09LAKEHAVR");
});
