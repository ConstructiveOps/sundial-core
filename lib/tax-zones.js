// lib/tax-zones.js — the Service module's sales tax, from Acumatica's own tables (D-083).
//
// Acumatica is the source of truth for Harmon's sales tax: which TAX ZONE an address is in,
// which TAXES a zone carries, each tax's RATE SCHEDULE, and which taxes each TAX CATEGORY
// includes. scripts/acumatica-pull-tax.mjs (and the daily refresh in sundial-cache-sync)
// copies those four things into Supabase EXACTLY as Acumatica holds them — no corrections
// here; a wrong zone is fixed in Acumatica and arrives with the next refresh:
//
//   sundial_tax_zones        one row per zone: code, label, city_key, county, tax_ids, …
//   sundial_tax_rates        one row per tax: its full rate schedule [{ start, rate }]
//   sundial_tax_categories   one row per category: the tax ids it includes
//   sundial_tax_zone_aliases a city spelling → zone code (Sun City → Maricopa County, …)
//
// THE TAX RULE IS ACUMATICA'S, not a RETAIL special case (Tim, 2026-10-15):
//
//   tax(line) = Σ rates of the taxes present in BOTH the zone's taxes AND the line's
//               category's taxes, each as of the invoice date (issue date; an estimate
//               uses today)
//
// so a category that includes no tax the zone carries is 0%, whatever its name.
//
// NEVER GUESS A ZONE. resolveTaxZone normalises the city, tries the alias table, then the
// zones' city_key — and otherwise answers { matched: false }. The caller leaves the zone
// blank and the job shows "Tax zone needed"; invoice issue refuses (TAX_ZONE_REQUIRED)
// until the office picks one. A wrong guess is a wrong remittance.
//
// Pure functions first (tested in lib/tax-zones.test.js), then the Supabase loader and the
// Acumatica → table builder the pull, the seed and the refresh share.

import { normalizeCity, RAW_TAX_ZONES } from "./acumatica-tax-zones.js";

export { normalizeCity };

// --- line tax categories ---------------------------------------------------------------
// The picklist on Sundial_Service_Line__c.Tax_Category__c and the default on
// Sundial_Price_Book_Item__c.Tax_Category__c: Acumatica's own category ids. RESALE exists so
// a wholesale line can be marked by hand; no default ever produces it.
export const TAX_CATEGORIES = Object.freeze(["LABSERV", "RETAIL", "SOLAR", "WARRANTY", "RESALE"]);
const CATEGORY_SET = new Set(TAX_CATEGORIES);

/** Bill-to types whose work is warranty work (D-083): every line is WARRANTY but explicit Retail materials. */
export const WARRANTY_BILL_TO = Object.freeze(["Internal Warranty", "Manufacturer"]);

/** A valid category id, else null (case-insensitive; a blank or unknown value is "not set"). */
export function validTaxCategory(v) {
  const s = String(v ?? "").trim().toUpperCase();
  return CATEGORY_SET.has(s) ? s : null;
}

/**
 * The category a line gets when nobody chose one (Tax_Category__c blank) — Tim, 2026-10-15:
 *   Labor / Fee       → LABSERV
 *   Material / Product → RETAIL, always
 * SOLAR (or WARRANTY / RESALE) only ever comes from a choice: the price-book item's
 * Tax_Category__c snapshotted onto the line, or the office's pick on the line. The old
 * Taxable__c checkbox is NOT an input any more — it is derived (lineTaxable).
 */
export function defaultTaxCategory({ kind } = {}) {
  if (kind === "Material" || kind === "Product") return "RETAIL";
  return "LABSERV";
}

/** The line's own category: its explicit one, else the kind's default (no job-level rule). */
export function lineTaxCategory({ kind, taxCategory } = {}) {
  return validTaxCategory(taxCategory) || defaultTaxCategory({ kind });
}

/**
 * Taxable__c, derived and read-only (D-083): ticked exactly when the line's own category is
 * RETAIL. The portal shows the mark from the EFFECTIVE category (after the warranty rule),
 * which the estimate read returns per line in totals.lineTotals.
 */
export function lineTaxable(line = {}) {
  return lineTaxCategory(line) === "RETAIL";
}

/**
 * The category a line is TAXED under. A stored Tax_Category__c is an explicit choice (the
 * office's, or the price-book item's own default snapshotted at add time); blank falls back
 * to defaultTaxCategory. On a warranty-billed job every line is WARRANTY except a Material
 * line explicitly set RETAIL — applied here, at computation, so a job whose Bill To changes
 * after its lines exist is taxed by what it is now.
 *
 * @param {object} line { kind, taxable, taxCategory }
 * @param {object} [ctx] { billToType }
 */
export function effectiveTaxCategory(line = {}, { billToType = null } = {}) {
  const stored = validTaxCategory(line.taxCategory);
  if (WARRANTY_BILL_TO.includes(billToType)) {
    return stored === "RETAIL" && line.kind === "Material" ? "RETAIL" : "WARRANTY";
  }
  return stored || defaultTaxCategory(line);
}

// --- rates -------------------------------------------------------------------------------
const day = (d) => {
  if (!d) return new Date().toISOString().slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
};

/** The rate in force on `date` (YYYY-MM-DD or Date): the schedule row with the latest start ≤ date. null = none. */
export function rateAsOf(schedule, date) {
  const on = day(date);
  let best = null;
  for (const r of schedule || []) {
    const start = String(r?.start ?? "").slice(0, 10);
    if (!start || start > on || !Number.isFinite(Number(r.rate))) continue;
    if (!best || start > best.start) best = { start, rate: Number(r.rate) };
  }
  return best;
}

/** Sum percents without float dust (8.3 + 0.8 never prints 9.100000000000001). */
const addPct = (a, b) => Math.round((a + b) * 1e6) / 1e6;

/**
 * One category's rate in one zone on one date — Acumatica's rule.
 * @returns {{ rate: number, components: Array<{ taxId, rate, start }> }}
 */
export function categoryRate({ zone, categoryId, tables, date }) {
  const cat = tables?.categories?.get(categoryId);
  if (!zone || !cat) return { rate: 0, components: [] };
  const inCat = new Set(cat.taxIds);
  let rate = 0;
  const components = [];
  for (const taxId of zone.taxIds || []) {
    if (!inCat.has(taxId)) continue;
    const r = rateAsOf(tables.taxes.get(taxId)?.schedule, date);
    if (!r) continue;
    rate = addPct(rate, r.rate);
    components.push({ taxId, rate: r.rate, start: r.start });
  }
  return { rate, components };
}

/** Every category's rate in the zone on the date: { LABSERV: 0, RETAIL: 9.1, … }. */
export function zoneCategoryRates({ zone, tables, date }) {
  const out = {};
  for (const id of tables?.categories?.keys() ?? []) out[id] = categoryRate({ zone, categoryId: id, tables, date }).rate;
  return out;
}

/**
 * The rate a TAXED line pays in this zone on the date — the number printed beside the
 * jurisdiction ("Phoenix (9.1%)") and stored on Tax_Rate__c. The highest category rate,
 * so it is a fact about the zone's taxes, not a category name. 0 when nothing is taxed.
 */
export function headlineRate({ zone, tables, date }) {
  const rates = Object.values(zoneCategoryRates({ zone, tables, date }));
  return rates.length ? Math.max(0, ...rates) : 0;
}

/** "Phoenix - Retail" → "Phoenix"; "Coconino County  - Retail" → "Coconino County". */
export function zoneLabel(description) {
  return String(description ?? "")
    .replace(/\s*-?\s*retail\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- resolver ------------------------------------------------------------------------------
/**
 * City → zone, from the loaded tables. Pure.
 * normalize → alias → a RETAIL zone whose city_key matches → else { matched: false }.
 */
export function resolveTaxZoneIn(tables, city) {
  const normalized = normalizeCity(city);
  if (!normalized) return { matched: false, normalized, reason: "NO_CITY" };
  if (!tables || !tables.zones?.size) return { matched: false, normalized, reason: "NO_TABLE" };
  const alias = tables.aliases?.get(normalized);
  if (alias) {
    const zone = tables.zones.get(alias.zoneCode);
    if (zone) return { matched: true, normalized, via: "alias", zone };
    return { matched: false, normalized, reason: "ALIAS_ZONE_MISSING", aliasZoneCode: alias.zoneCode };
  }
  const hits = [...tables.zones.values()].filter((z) => z.isRetail && z.cityKey === normalized);
  if (hits.length === 1) return { matched: true, normalized, via: "city", zone: hits[0] };
  return { matched: false, normalized, reason: hits.length ? "AMBIGUOUS" : "UNMATCHED" };
}

/**
 * The spec's signature: resolveTaxZone({ tenant, city }) → the zone or { matched: false }.
 * `loadTables` defaults to the Supabase loader below.
 */
export async function resolveTaxZone({ tenant, city }, { loadTables = loadTaxTables } = {}) {
  const tables = tenant ? await loadTables(tenant) : null;
  return resolveTaxZoneIn(tables, city);
}

// --- loading the tables ------------------------------------------------------------------
export const TABLES = Object.freeze({
  zones: "sundial_tax_zones",
  rates: "sundial_tax_rates",
  categories: "sundial_tax_categories",
  aliases: "sundial_tax_zone_aliases",
});

/** Rows (as stored) → the Maps the pure functions read. */
export function tablesFromRows({ zones = [], rates = [], categories = [], aliases = [] } = {}) {
  return {
    zones: new Map(zones.map((z) => [z.zone_code, {
      code: z.zone_code,
      description: z.description ?? "",
      label: zoneLabel(z.description),
      cityKey: z.city_key ?? null,
      county: z.county ?? null,
      state: z.state ?? null,
      isRetail: z.is_retail === true,
      taxIds: Array.isArray(z.tax_ids) ? z.tax_ids : [],
      combinedRate: z.combined_rate == null ? null : Number(z.combined_rate),
    }])),
    taxes: new Map(rates.map((r) => [r.tax_id, { id: r.tax_id, description: r.description ?? "", schedule: Array.isArray(r.schedule) ? r.schedule : [] }])),
    categories: new Map(categories.map((c) => [c.category_id, { id: c.category_id, description: c.description ?? "", taxIds: Array.isArray(c.tax_ids) ? c.tax_ids : [], active: c.active !== false }])),
    aliases: new Map(aliases.map((a) => [normalizeCity(a.alias_key), { zoneCode: a.zone_code, note: a.note ?? null }])),
  };
}

const TABLE_TTL_MS = 10 * 60 * 1000;
const tableCache = new Map(); // tenant → { at, value }

/**
 * Load one tenant's four tables from Supabase (service role), cached 10 minutes per warm
 * container. A read failure is NOT cached and returns null — the caller treats it like an
 * unresolved zone (tax 0 on an estimate, TAX_ZONE_REQUIRED at issue), never a guess.
 */
export async function loadTaxTables(tenant, { getSupabaseClient, now = () => Date.now() } = {}) {
  if (!tenant) return null;
  const hit = tableCache.get(tenant);
  if (hit && now() - hit.at < TABLE_TTL_MS) return hit.value;
  try {
    const get = getSupabaseClient ?? (await import("./supabase.js")).getSupabaseClient;
    const supabase = await get();
    const read = async (table) => {
      const { data, error } = await supabase.from(table).select("*").eq("tenant", tenant).limit(5000);
      if (error) throw new Error(`${table}: ${error.message}`);
      return data || [];
    };
    const [zones, rates, categories, aliases] = await Promise.all([read(TABLES.zones), read(TABLES.rates), read(TABLES.categories), read(TABLES.aliases)]);
    const value = tablesFromRows({ zones, rates, categories, aliases });
    tableCache.set(tenant, { at: now(), value });
    return value;
  } catch (e) {
    console.error("tax tables read failed:", e?.message || e);
    return null;
  }
}
export function clearTaxTableCache() {
  tableCache.clear();
}

// --- the estimate's tax context ------------------------------------------------------------
/**
 * Everything totals.js needs to tax an estimate, decided in one place for the estimate
 * Lambda and the public page alike:
 *   - the job's zone (Tax_Zone_Code__c) when the estimate has a job — authoritative, blank
 *     = unresolved (the office sets it on the job page), never re-guessed from the city;
 *   - otherwise the customer's City__c through the resolver;
 *   - the job's Bill_To_Type__c (the warranty rule);
 *   - each category's rate as of `date`.
 * Templates and estimates with no customer get an unresolved context (no tax).
 * `date` omitted = today (`now`), except an INVOICED estimate, which is read at its live
 * invoice's issue date — the rates the invoice froze, so a later rate change never makes the
 * locked estimate disagree with its invoice. An invoiced estimate's lines also carry the
 * EFFECTIVE category frozen at issue (invoice.js), so the job's Bill To no longer applies
 * to it (billToType null): a later Bill To change never re-taxes an issued invoice.
 *
 * @returns {Promise<{ matched, zone, zoneCode, label, rate, categoryRates, billToType, source, reason }>}
 */
export async function estimateTaxContext({ est, tenantId, tenantSlug, date, now = new Date(), sfQuery, soqlEscapeString, loadTables = loadTaxTables, job = undefined }) {
  const none = (reason, extra = {}) => ({ matched: false, zone: null, zoneCode: null, label: null, rate: null, categoryRates: {}, billToType: null, source: null, reason, ...extra });
  if (!est || est.Is_Template__c === true) return none("TEMPLATE");
  let j = job;
  if (j === undefined && est.Service_Job__c) {
    const rows = await sfQuery(
      `SELECT Id, Tax_Zone_Code__c, Tax_Zone_Label__c, Bill_To_Type__c FROM Sundial_Service_Job__c WHERE Id = '${soqlEscapeString(est.Service_Job__c)}' ` +
        `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
    );
    j = rows?.[0] ?? null;
  }
  const billToType = est.Status__c === "Invoiced" ? null : j?.Bill_To_Type__c ?? null;
  if (date == null && est.Status__c === "Invoiced" && est.Service_Job__c) {
    try {
      const inv = await sfQuery(
        `SELECT Issued_At__c FROM Sundial_Service_Invoice__c WHERE Service_Job__c = '${soqlEscapeString(est.Service_Job__c)}' ` +
          `AND Client__c = '${soqlEscapeString(tenantId)}' AND Status__c != 'Void' ORDER BY CreatedDate DESC LIMIT 1`
      );
      date = inv?.[0]?.Issued_At__c ?? null;
    } catch (e) {
      console.error("tax context: invoice date read failed:", e?.message || e);
    }
  }
  if (date == null) date = now;
  const tables = await loadTables(tenantSlug);
  let zone = null;
  let source = null;
  if (j) {
    if (!j.Tax_Zone_Code__c) return { ...none("JOB_ZONE_BLANK"), billToType };
    zone = tables?.zones.get(j.Tax_Zone_Code__c) ?? null;
    if (!zone) return { ...none(tables ? "ZONE_UNKNOWN" : "NO_TABLE", { zoneCode: j.Tax_Zone_Code__c }), billToType };
    source = "job";
  } else {
    if (!est.Sundial_Customer__c) return none("NO_CUSTOMER");
    const rows = await sfQuery(
      `SELECT Id, City__c FROM Sundial_Customer__c WHERE Id = '${soqlEscapeString(est.Sundial_Customer__c)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
    );
    const r = resolveTaxZoneIn(tables, rows?.[0]?.City__c);
    if (!r.matched) return none(r.reason, { normalized: r.normalized });
    zone = r.zone;
    source = "customer";
  }
  return {
    matched: true,
    zone,
    zoneCode: zone.code,
    label: zone.label,
    rate: headlineRate({ zone, tables, date }),
    categoryRates: zoneCategoryRates({ zone, tables, date }),
    billToType,
    source,
    reason: null,
  };
}

// --- Acumatica → table rows (the pull, the seed and the daily refresh) ---------------------
const v = (f) => (f && typeof f === "object" && "value" in f ? f.value : f ?? null);
const isRetailZone = (code, description) => /R$/.test(code) || /retail/i.test(description);
const isCountyTax = (description) => /county/i.test(description);

/**
 * The raw Acumatica JSON (TaxZone + ApplicableTaxes, Tax + TaxSchedule, TaxCategory + Details)
 * → the four tables' rows, plus the drift report. Pure; `today` decides combined_rate /
 * components / effective_from (the per-date math reads the schedules, not these).
 *
 * city_key comes from lib/acumatica-tax-zones.js (the map the Acumatica customer push
 * already uses): each retail zone's FIRST city in that map. Its other spellings become
 * alias rows. County-only zones have no city_key; aliases point at them.
 */
export function buildTaxTableRows({ zones: rawZones = [], taxes: rawTaxes = [], categories: rawCategories = [] }, { tenant, today, syncedAt = new Date().toISOString(), cityMap = RAW_TAX_ZONES } = {}) {
  const on = day(today);
  const rates = rawTaxes.map((t) => ({
    tenant,
    tax_id: v(t.TaxID),
    description: v(t.Description) ?? null,
    schedule: (t.TaxSchedule || [])
      .map((r) => ({ start: String(v(r.StartDate) ?? "").slice(0, 10), rate: Number(v(r.TaxRate)) }))
      .filter((r) => r.start && Number.isFinite(r.rate))
      .sort((a, b) => a.start.localeCompare(b.start)),
    synced_at: syncedAt,
  }));
  const categories = rawCategories.map((c) => ({
    tenant,
    category_id: v(c.TaxCategoryID),
    description: v(c.Description) ?? null,
    tax_ids: [...new Set((c.Details || []).map((d) => v(d.TaxID)).filter(Boolean))].sort(),
    active: v(c.Active) !== false,
    exclude_listed: v(c.ExcludeListedTaxes) === true,
    synced_at: syncedAt,
  }));
  const rateRows = new Map(rates.map((r) => [r.tax_id, r]));

  // city map: code → [normalized cities] in the map's own order
  const citiesByCode = new Map();
  for (const [city, code] of Object.entries(cityMap || {})) {
    const k = normalizeCity(city);
    if (!citiesByCode.has(code)) citiesByCode.set(code, []);
    if (!citiesByCode.get(code).includes(k)) citiesByCode.get(code).push(k);
  }

  const tables = tablesFromRows({ zones: [], rates, categories, aliases: [] });
  const zones = rawZones.map((z) => {
    const code = v(z.TaxZoneID);
    const description = v(z.Description) ?? "";
    const taxIds = [...new Set((z.ApplicableTaxes || []).map((a) => v(a.TaxID)).filter(Boolean))];
    const retail = isRetailZone(code, description);
    const zoneObj = { code, taxIds };
    const components = taxIds.map((taxId) => {
      const r = rateAsOf(rateRows.get(taxId)?.schedule, on);
      return { taxId, rate: r ? r.rate : null, start: r ? r.start : null };
    });
    const starts = components.map((c) => c.start).filter(Boolean).sort();
    const countyTax = taxIds.map((id) => rateRows.get(id)?.description ?? "").find(isCountyTax) ?? null;
    const isCountyZone = /county/i.test(description);
    return {
      tenant,
      zone_code: code,
      description,
      city_key: retail && !isCountyZone ? citiesByCode.get(code)?.[0] ?? null : null,
      county: isCountyZone ? zoneLabel(description).replace(/\s*county\s*$/i, "") : countyTax ? countyTax.replace(/\s*county.*$/i, "").trim() : null,
      state: "AZ",
      combined_rate: headlineRate({ zone: zoneObj, tables, date: on }),
      components,
      tax_ids: taxIds,
      effective_from: starts.length ? starts[starts.length - 1] : null,
      is_retail: retail,
      synced_at: syncedAt,
    };
  });

  // The map's extra spellings (DEWEY, SNOW FLAKE, …) → alias rows, so one resolver path.
  const aliases = [];
  const zoneCodes = new Set(zones.map((z) => z.zone_code));
  for (const [code, cities] of citiesByCode) {
    if (!zoneCodes.has(code)) continue; // never an alias to a zone Acumatica does not have
    for (const k of cities.slice(1)) aliases.push({ tenant, alias_key: k, zone_code: code, note: "spelling from lib/acumatica-tax-zones.js" });
  }

  return { zones, rates, categories, aliases, drift: taxDrift({ zones, rates, categories }) };
}

/**
 * What Acumatica holds that would surprise a reader (Tim, 2026-10-15: copy Acumatica exactly,
 * make the drift visible every day):
 *   - cityTaxNotRetail: a RETAIL zone carries a non-zero tax that is in no category a
 *     retail line can be in (the city tax is never charged — Sierra Vista, Tombstone, …);
 *   - contractingTaxOnRetail: a RETAIL zone carries a tax from the CONTRACTING category
 *     (Apache Junction's Pinal County Contracting in place of Pinal County Retail).
 *   - unmappedRetail: a retail city zone no city in lib/acumatica-tax-zones.js points at.
 */
export function taxDrift({ zones, rates, categories }) {
  const rateById = new Map(rates.map((r) => [r.tax_id, r]));
  const contracting = new Set(categories.find((c) => c.category_id === "CONTRACTING")?.tax_ids ?? []);
  const retailCategories = categories.filter((c) => !/contract|purch|subcon|nontax/i.test(c.category_id));
  const inRetailCategory = new Set(retailCategories.flatMap((c) => c.tax_ids));
  const nonZero = (id) => (rateById.get(id)?.schedule || []).some((r) => Number(r.rate) > 0);
  const out = { cityTaxNotRetail: [], contractingTaxOnRetail: [], unmappedRetail: [] };
  for (const z of zones.filter((x) => x.is_retail)) {
    for (const id of z.tax_ids) {
      if (contracting.has(id)) out.contractingTaxOnRetail.push({ zone: z.zone_code, description: z.description, taxId: id, tax: rateById.get(id)?.description ?? null });
      else if (!inRetailCategory.has(id) && nonZero(id)) out.cityTaxNotRetail.push({ zone: z.zone_code, description: z.description, taxId: id, tax: rateById.get(id)?.description ?? null });
    }
    if (!z.city_key && !/county/i.test(z.description)) out.unmappedRetail.push({ zone: z.zone_code, description: z.description });
  }
  return out;
}

/**
 * Pull Acumatica and write the four tables for one tenant (the daily refresh + the seed).
 * Upserts every row, then deletes the tenant's zones / taxes / categories Acumatica no longer
 * has — unless the pull came back with fewer than half the zones already stored (a partial
 * read never empties the table). Aliases are never deleted here (the CFO's live in SQL);
 * the map's spellings are upserted.
 */
export async function syncTaxTables({ supabase, tenant, raw, today, syncedAt }) {
  const built = buildTaxTableRows(raw, { tenant, today, syncedAt });
  if (!built.zones.length) throw new Error("Acumatica returned no tax zones — nothing written");
  const upsert = async (table, rows, onConflict) => {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from(table).upsert(rows.slice(i, i + 500), { onConflict });
      if (error) throw new Error(`${table} upsert: ${error.message}`);
    }
  };
  await upsert(TABLES.rates, built.rates, "tenant,tax_id");
  await upsert(TABLES.categories, built.categories, "tenant,category_id");
  await upsert(TABLES.zones, built.zones, "tenant,zone_code");
  if (built.aliases.length) await upsert(TABLES.aliases, built.aliases, "tenant,alias_key");

  const { data: existing, error } = await supabase.from(TABLES.zones).select("zone_code").eq("tenant", tenant);
  if (error) throw new Error(`${TABLES.zones} read: ${error.message}`);
  let deleted = 0;
  if ((existing || []).length && built.zones.length >= existing.length / 2) {
    const keep = (rows, key) => `(${rows.map((r) => `"${String(r[key]).replace(/"/g, '""')}"`).join(",")})`;
    for (const [table, rows, key] of [[TABLES.zones, built.zones, "zone_code"], [TABLES.rates, built.rates, "tax_id"], [TABLES.categories, built.categories, "category_id"]]) {
      const { data, error: e } = await supabase.from(table).delete().eq("tenant", tenant).not(key, "in", keep(rows, key)).select(key);
      if (e) throw new Error(`${table} prune: ${e.message}`);
      deleted += (data || []).length;
    }
  }
  clearTaxTableCache();
  return { zones: built.zones.length, taxes: built.rates.length, categories: built.categories.length, aliases: built.aliases.length, deleted, drift: built.drift };
}

/** GET the three Acumatica entities (lib/acumatica.js getAcumaticaEntity). Throws on any failure. */
export async function pullAcumaticaTax(getAcumaticaEntity) {
  const out = {};
  for (const [key, entity, expand] of [["zones", "TaxZone", "ApplicableTaxes"], ["taxes", "Tax", "TaxSchedule,Zones"], ["categories", "TaxCategory", "Details"]]) {
    const res = await getAcumaticaEntity(entity, { $expand: expand });
    if (!res.ok || !Array.isArray(res.data)) throw new Error(`Acumatica ${entity} read failed: ${res.status}`);
    out[key] = res.data;
  }
  return out;
}

// --- the backfill (scripts/backfill-job-tax-zones.mjs) ---------------------------------------
/** The job statuses that are done (the tech app's CLOSED_JOB_STATUSES): never backfilled. */
export const CLOSED_JOB_STATUSES = Object.freeze(["Closed", "Cancelled", "Paid"]);

/**
 * The city out of a service-address snapshot ("123 N Main St, Unit 4, Phoenix, AZ 85001").
 * Read from the END — the ZIP and the state are dropped, the part before them is the city —
 * because the street itself may hold commas. null when the line has no city part.
 */
export function cityFromAddressLine(line) {
  const parts = String(line ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length && /^\d{5}(-\d{4})?$/.test(parts[parts.length - 1])) parts.pop();
  if (parts.length && /^(AZ|ARIZONA|[A-Z]{2})(\s+\d{5}(-\d{4})?)?$/i.test(parts[parts.length - 1])) parts.pop();
  return parts.length >= 2 ? parts[parts.length - 1] : null;
}

/**
 * Plan the backfill: for each open job with a blank zone, the service address's city (the
 * job's own snapshot, else its customer's City__c) through the SAME resolver the job create
 * uses. Exact matches only are written; everything else is listed, never guessed.
 * @param {Array} jobs  [{ Id, Name, Status__c, Tax_Zone_Code__c, Address_at_Creation__c, Customer_Name_at_Creation__c, Sundial_Customer__r: { City__c } }]
 * @returns {{ matched: Array<{ id, number, customer, city, source, zoneCode, label, via }>, unmatched: Array<{ id, number, customer, city, source, reason }>, skipped: number }}
 */
export function planJobZones(jobs, tables) {
  const matched = [];
  const unmatched = [];
  let skipped = 0;
  for (const j of jobs || []) {
    if (CLOSED_JOB_STATUSES.includes(j.Status__c) || (j.Tax_Zone_Code__c ?? "") !== "") {
      skipped += 1;
      continue;
    }
    const fromAddress = cityFromAddressLine(j.Address_at_Creation__c);
    const city = fromAddress ?? j.Sundial_Customer__r?.City__c ?? null;
    const source = fromAddress ? "service address" : city ? "customer city" : "none";
    const base = { id: j.Id, number: j.Name ?? null, customer: j.Customer_Name_at_Creation__c ?? null, city, source };
    const r = resolveTaxZoneIn(tables, city);
    if (r.matched) matched.push({ ...base, zoneCode: r.zone.code, label: r.zone.label, via: r.via });
    else unmatched.push({ ...base, reason: r.reason });
  }
  return { matched, unmatched, skipped };
}
