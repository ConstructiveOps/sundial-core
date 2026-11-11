// Seed INVENTED sales-tax zones for the DEMO tenant (D-083 tables, demo slug `conops-demo`).
//
// WHY. The Service module taxes nothing until the tenant has rows in the four sundial_tax_*
// tables, and invoice issue refuses with TAX_ZONE_REQUIRED while a job's zone is blank. Those
// tables are Acumatica's, and Acumatica is Harmon's (D-078) — so the demo tenant gets its OWN
// rows, invented, under its own slug: one retail zone per city the demo's customers live in
// (scripts/demo-seed/catalog.js CITIES), at the SAME rate the seeded estimates already
// carry in Tax_Rate__c (`taxRate` there), so an invoice re-issued in a demo agrees with the
// seeded money. Nothing here is copied from Harmon's tables or from Acumatica.
//
// SHAPE. Written through the SAME builder + writer the Acumatica refresh uses
// (lib/tax-zones.js syncTaxTables), fed a raw payload in Acumatica's own JSON shape, so the
// rows are indistinguishable in form from Harmon's:
//   zone  DM-PHX "Phoenix (demo) - Retail", city_key PHOENIX, tax_ids [DM-PHX-CT, DM-MCORT, DM-LABSERV, DM-SOLAR, DM-WARRANTY]
//   taxes DM-MCORT (Maricopa County + Arizona, 6.3 %) + one city tax per zone (the catalog rate minus 6.3)
//         DM-LABSERV / DM-SOLAR / DM-WARRANTY at 0 % — the category rule needs a tax to intersect
//   categories RETAIL (county + every city tax) · LABSERV · SOLAR · WARRANTY (each its 0 % tax) · RESALE (none)
//   aliases "CITY OF <CITY>" and "<CITY> AZ" → the zone (the city itself is the zone's city_key)
// Category treatment is Harmon's: RETAIL is taxed; LABSERV, SOLAR, WARRANTY and RESALE are 0 %.
//
// REFRESH-SAFE. The daily `taxzones` task (lambdas/sundial-cache-sync/index.js
// runTaxZoneRefresh) syncs the PRIMARY tenant only, and syncTaxTables reads, upserts and
// prunes with `.eq("tenant", <slug>)` on every table — another slug's rows are never seen,
// let alone deleted. The test pins that.
//
// SAFETY. Dry run by default (prints the plan and how the demo's jobs would resolve; reads
// only). `--tenant` is REQUIRED, must exist in Sundial_Tenant__c, and is refused when it is
// the primary tenant (SUNDIAL_PRIMARY_TENANT, default `harmon`) or is not the demo slug
// (`--allow-other-slug` to seed a second demo tenant). Idempotent: a re-run upserts the same
// rows. No secret value is ever printed.
//
//   node scripts/seed-demo-tax-zones.mjs --tenant conops-demo            # dry run
//   node scripts/seed-demo-tax-zones.mjs --tenant conops-demo --apply    # write
// then
//   node scripts/backfill-job-tax-zones.mjs --tenant conops-demo         # dry run: every demo job resolves
//   node scripts/backfill-job-tax-zones.mjs --tenant conops-demo --apply
//
// Tests: node --test scripts/seed-demo-tax-zones.test.mjs (fakes; nothing real is touched).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { CITIES, COUNTY, STATE } from "./demo-seed/catalog.js";
import { DEFAULT_TENANT_SLUG } from "./demo-seed/policy.js";
import { buildTaxTableRows, syncTaxTables, tablesFromRows, planJobZones, resolveTaxZoneIn, categoryRate, headlineRate, cityFromAddressLine, TABLES, CLOSED_JOB_STATUSES } from "../lib/tax-zones.js";
import { isPrimaryTenant, primaryTenantSlug } from "../lib/tenant-guard.js";
import { soqlEscapeString } from "../lib/salesforce.js";

// --- the invented zones -------------------------------------------------------------------
/** Every zone code starts with this, so a demo row can never be mistaken for an Acumatica one. */
export const DEMO_ZONE_PREFIX = "DM-";
/** The county + state share of every demo city's rate (Arizona 5.6 + Maricopa 0.7 — a round, plausible demo number). */
export const COUNTY_STATE_RATE = 6.3;
/** The one tax every demo zone carries for the county + state share. */
export const COUNTY_TAX_ID = "DM-MCORT";
/** The 0 % taxes that give the untaxed categories something to intersect with (Harmon's shape). */
export const ZERO_TAXES = Object.freeze([
  { id: "DM-LABSERV", category: "LABSERV", description: "Labor / services (demo, not taxed)" },
  { id: "DM-SOLAR", category: "SOLAR", description: "Solar equipment (demo, not taxed)" },
  { id: "DM-WARRANTY", category: "WARRANTY", description: "Warranty work (demo, not taxed)" },
]);
/** Three-letter codes per demo city. A city the catalog adds without a code fails loudly (no guessing a code). */
const CITY_CODES = Object.freeze({
  Phoenix: "PHX", Scottsdale: "SCO", Tempe: "TEM", Mesa: "MES", Chandler: "CHA", Gilbert: "GIL", Glendale: "GLE",
  Peoria: "PEO", Surprise: "SUR", Goodyear: "GOO", "Queen Creek": "QCR", "Cave Creek": "CAV", Avondale: "AVO", Buckeye: "BUC",
});
const RATE_START = "2020-01-01"; // one schedule row per tax: the rate has "always" been this

const pct = (n) => Math.round(Number(n) * 1e6) / 1e6;

/** The zone code for a demo city: DM-PHX. Throws for a city CITY_CODES does not know. */
export function demoZoneCode(city) {
  const code = CITY_CODES[city];
  if (!code) throw new Error(`no demo zone code for city "${city}" — add it to CITY_CODES in scripts/seed-demo-tax-zones.mjs`);
  return `${DEMO_ZONE_PREFIX}${code}`;
}

/**
 * The demo zones, one per catalog city: { code, label, city, rate, cityRate }.
 * `rate` is the catalog's taxRate (what the seeded estimates carry); `cityRate` its share
 * above COUNTY_STATE_RATE. Pure.
 */
export function demoZones(cities = CITIES) {
  return cities.map((c) => {
    const cityRate = pct(c.taxRate - COUNTY_STATE_RATE);
    if (!(cityRate >= 0)) throw new Error(`demo city ${c.city}: taxRate ${c.taxRate} is below the county + state share ${COUNTY_STATE_RATE}`);
    return { code: demoZoneCode(c.city), label: `${c.city} (demo)`, city: c.city, rate: pct(c.taxRate), cityRate };
  });
}

/**
 * The raw payload in Acumatica's JSON shape (TaxZone + ApplicableTaxes, Tax + TaxSchedule,
 * TaxCategory + Details) that buildTaxTableRows / syncTaxTables turn into rows, plus the
 * city → zone map that gives each zone its city_key and its alias rows. Pure.
 */
export function buildDemoTaxRaw(cities = CITIES) {
  const zones = demoZones(cities);
  const taxes = [
    { TaxID: COUNTY_TAX_ID, Description: `${COUNTY} County + ${STATE} state retail (demo)`, TaxSchedule: [{ StartDate: RATE_START, TaxRate: COUNTY_STATE_RATE }] },
    ...zones.map((z) => ({ TaxID: `${z.code}-CT`, Description: `${z.city} city retail (demo)`, TaxSchedule: [{ StartDate: RATE_START, TaxRate: z.cityRate }] })),
    ...ZERO_TAXES.map((t) => ({ TaxID: t.id, Description: t.description, TaxSchedule: [{ StartDate: RATE_START, TaxRate: 0 }] })),
  ];
  const rawZones = zones.map((z) => ({
    TaxZoneID: z.code,
    Description: `${z.label} - Retail`, // "- Retail" is what marks a retail zone and is stripped from the label (zoneLabel)
    ApplicableTaxes: [{ TaxID: `${z.code}-CT` }, { TaxID: COUNTY_TAX_ID }, ...ZERO_TAXES.map((t) => ({ TaxID: t.id }))],
  }));
  const categories = [
    { TaxCategoryID: "RETAIL", Description: "Retail sales (demo)", Active: true, ExcludeListedTaxes: false, Details: [{ TaxID: COUNTY_TAX_ID }, ...zones.map((z) => ({ TaxID: `${z.code}-CT` }))] },
    ...ZERO_TAXES.map((t) => ({ TaxCategoryID: t.category, Description: t.description, Active: true, ExcludeListedTaxes: false, Details: [{ TaxID: t.id }] })),
    { TaxCategoryID: "RESALE", Description: "Resale / wholesale (demo, not taxed)", Active: true, ExcludeListedTaxes: false, Details: [] },
  ];
  // The city itself is the zone's city_key; the other spellings become alias rows.
  const cityMap = {};
  for (const z of zones) {
    cityMap[z.city] = z.code;
    cityMap[`City of ${z.city}`] = z.code;
    cityMap[`${z.city}, ${STATE}`] = z.code;
  }
  return { raw: { zones: rawZones, taxes, categories }, cityMap, zones };
}

// --- the run ---------------------------------------------------------------------------------
export function parseArgs(argv) {
  const args = [...argv];
  const flag = (f) => {
    const i = args.indexOf(f);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  };
  const value = (f) => {
    const i = args.indexOf(f);
    if (i < 0) return null;
    const v = args[i + 1] ?? null;
    args.splice(i, 2);
    return v;
  };
  const out = { apply: flag("--apply"), allowOtherSlug: flag("--allow-other-slug"), help: flag("--help"), tenant: value("--tenant") };
  out.unknown = args;
  return out;
}

const JOB_FIELDS = "Id, Name, Status__c, Tax_Zone_Code__c, Address_at_Creation__c, Customer_Name_at_Creation__c, Sundial_Customer__r.City__c";

/**
 * @param {string[]} argv
 * @param {{ sfQuery, getSupabase, log?, now?, env? }} io   real: lib/salesforce.js + lib/supabase.js; tests: fakes
 * @returns {Promise<number>} exit code
 */
export async function runSeedDemoTaxZones(argv, io) {
  const log = io.log ?? ((s) => console.log(s));
  const env = io.env ?? process.env;
  const now = io.now ? io.now() : new Date();
  const o = parseArgs(argv);
  if (o.help) {
    log("node scripts/seed-demo-tax-zones.mjs --tenant <slug> [--apply] [--allow-other-slug]");
    return 0;
  }
  if (o.unknown.length) {
    log(`Unknown argument(s): ${o.unknown.join(" ")}`);
    return 2;
  }
  const slug = String(o.tenant ?? "").trim().toLowerCase();
  if (!slug) {
    log("--tenant is required (the demo tenant's slug, conops-demo). Nothing read, nothing written.");
    return 2;
  }
  // The hard refusals come BEFORE any read.
  if (slug === "harmon" || isPrimaryTenant(slug, env)) {
    log(`REFUSED: "${slug}" is the primary tenant (its tax tables are Acumatica's, refreshed daily — never invented). Nothing written.`);
    return 1;
  }
  if (slug !== DEFAULT_TENANT_SLUG && !o.allowOtherSlug) {
    log(`REFUSED: "${slug}" is not the demo tenant (${DEFAULT_TENANT_SLUG}). Pass --allow-other-slug only for a second DEMO tenant. Nothing written.`);
    return 1;
  }
  const tenantRows = await io.sfQuery(`SELECT Id, Name FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(slug)}' LIMIT 1`);
  const tenant = tenantRows?.[0];
  if (!tenant?.Id) {
    log(`REFUSED: no Sundial_Tenant__c named "${slug}". Nothing written.`);
    return 1;
  }
  if (isPrimaryTenant(tenant.Name, env)) {
    log(`REFUSED: the tenant record for "${slug}" is the primary tenant (${primaryTenantSlug(env)}). Nothing written.`);
    return 1;
  }

  // --- the plan (pure) ---
  const today = now.toISOString().slice(0, 10);
  const { raw, cityMap, zones } = buildDemoTaxRaw();
  const built = buildTaxTableRows(raw, { tenant: slug, today, syncedAt: now.toISOString(), cityMap });
  const tables = tablesFromRows(built);
  log(`Demo tax zones for tenant ${slug} (${tenant.Id}) — ${o.apply ? "APPLY" : "DRY RUN"}`);
  log(`  ${built.zones.length} zones, ${built.rates.length} taxes, ${built.categories.length} categories, ${built.aliases.length} aliases (all codes ${DEMO_ZONE_PREFIX}*, every row tenant = ${slug})`);
  log("");
  log("  zone      rate     label                      city_key       aliases");
  for (const z of built.zones) {
    const al = built.aliases.filter((a) => a.zone_code === z.zone_code).map((a) => a.alias_key).join(" | ");
    log(`  ${z.zone_code.padEnd(9)} ${String(z.combined_rate).padEnd(8)} ${tables.zones.get(z.zone_code).label.padEnd(26)} ${String(z.city_key).padEnd(14)} ${al}`);
  }
  log("");
  log("  category rates in every zone (the catalog's taxRate for RETAIL, 0 for the rest):");
  for (const c of built.categories) {
    const r = categoryRate({ zone: tables.zones.get(zones[0].code), categoryId: c.category_id, tables, date: today }).rate;
    log(`     ${c.category_id.padEnd(9)} ${c.tax_ids.length ? `${r}% in ${zones[0].label}` : "no taxes — 0%"}`);
  }
  // The rates MUST equal the catalog's: that is the whole point.
  for (const z of zones) {
    const got = headlineRate({ zone: tables.zones.get(z.code), tables, date: today });
    if (got !== z.rate) throw new Error(`rate drift: ${z.code} computes ${got}% but the catalog says ${z.rate}%`);
  }
  if (built.drift.cityTaxNotRetail.length || built.drift.contractingTaxOnRetail.length || built.drift.unmappedRetail.length) {
    throw new Error(`the demo payload has drift: ${JSON.stringify(built.drift)}`);
  }

  // --- how the demo's jobs would resolve (read-only) ---
  const jobs = await io.sfQuery(`SELECT ${JOB_FIELDS} FROM Sundial_Service_Job__c WHERE Client__c = '${soqlEscapeString(tenant.Id)}' ORDER BY Name`);
  const byZone = new Map(built.zones.map((z) => [z.zone_code, { via: { city: 0, alias: 0 }, aliases: new Map() }]));
  const unmatched = new Map(); // city → count
  for (const j of jobs || []) {
    const city = cityFromJob(j);
    const r = resolveTaxZoneIn(tables, city);
    if (!r.matched) {
      const k = city ?? "(no city)";
      unmatched.set(k, (unmatched.get(k) || 0) + 1);
      continue;
    }
    const z = byZone.get(r.zone.code);
    z.via[r.via] += 1;
    if (r.via === "alias") z.aliases.set(r.normalized, (z.aliases.get(r.normalized) || 0) + 1);
  }
  log("");
  log(`  ${jobs?.length ?? 0} demo job(s) read. Where their cities land:`);
  for (const [code, z] of byZone) {
    const viaAlias = [...z.aliases].map(([k, n]) => `${k} ×${n}`).join(", ");
    log(`     ${code.padEnd(9)} ${String(z.via.city + z.via.alias).padStart(4)} job(s)${z.via.alias ? ` (${z.via.alias} through an alias: ${viaAlias})` : ""}`);
  }
  if (unmatched.size) {
    log(`  UNMATCHED cities (the backfill would leave these blank): ${[...unmatched].map(([c, n]) => `"${c}" ×${n}`).join(", ")}`);
  } else log("  every demo job's city resolves to a demo zone.");
  const plan = planJobZones(jobs || [], tables);
  log(`  backfill-job-tax-zones.mjs --tenant ${slug} would write ${plan.matched.length} open job(s) (${plan.skipped} already set or ${CLOSED_JOB_STATUSES.join("/")}, ${plan.unmatched.length} unmatched).`);

  if (!o.apply) {
    log("");
    log("Dry run — nothing written. Re-run with --apply to write the rows.");
    return unmatched.size ? 3 : 0;
  }

  // --- write, through the refresh's own writer ---
  const supabase = await io.getSupabase();
  const probe = await supabase.from(TABLES.zones).select("zone_code").eq("tenant", slug).limit(1);
  if (probe.error) {
    log(`The tax tables are not there (${probe.error.message}). Run sql/sundial_tax_zones.sql in the Supabase SQL editor first. Nothing written.`);
    return 1;
  }
  const result = await syncTaxTables({ supabase, tenant: slug, raw, today, syncedAt: now.toISOString(), cityMap });
  log("");
  log(`written for ${slug}: ${JSON.stringify({ zones: result.zones, taxes: result.taxes, categories: result.categories, aliases: result.aliases, deleted: result.deleted })}`);
  const { data, error } = await supabase.from(TABLES.zones).select("zone_code,combined_rate").eq("tenant", slug);
  if (error) {
    log(`re-read failed: ${error.message}`);
    return 1;
  }
  const bad = (data || []).filter((r) => !String(r.zone_code).startsWith(DEMO_ZONE_PREFIX));
  log(`re-read: ${data?.length ?? 0} zone(s) for ${slug}${bad.length ? ` — ${bad.length} WITHOUT the ${DEMO_ZONE_PREFIX} prefix: ${bad.map((b) => b.zone_code).join(", ")}` : ", all DM-*"}`);
  log(`next: node scripts/backfill-job-tax-zones.mjs --tenant ${slug}   (dry run, then --apply)`);
  return bad.length ? 1 : 0;
}

/** The job's city the way the backfill reads it (planJobZones): the address snapshot, else the customer's City__c. */
const cityFromJob = (j) => cityFromAddressLine(j.Address_at_Creation__c) ?? j.Sundial_Customer__r?.City__c ?? null;

// --- entrypoint ------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [{ sfQuery }, { getSupabaseClient }] = await Promise.all([import("../lib/salesforce.js"), import("../lib/supabase.js")]);
  runSeedDemoTaxZones(process.argv.slice(2), { sfQuery, getSupabase: getSupabaseClient })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`\nFAILED: ${err?.message || err}\n`);
      process.exitCode = 1;
    });
}
