// Load the Acumatica tax tables into Supabase (D-083) — the first copy, before the daily
// refresh exists. Same builder + writer the refresh uses (lib/tax-zones.js syncTaxTables), so
// the seed and the schedule can never write different shapes.
//
//   node scripts/seed-tax-zones.mjs              # dry run: what would be written, from the last pull
//   node scripts/seed-tax-zones.mjs --apply      # write it
//   node scripts/seed-tax-zones.mjs --pull --apply   # pull Acumatica fresh first (read-only GETs)
//
// Reads _delivery/acumatica-tax/{tax-zones,taxes,tax-categories}.json (scripts/acumatica-pull-tax.mjs).
// The tenant is the PRIMARY tenant (Acumatica is a single-credential integration — D-078).
// Run sql/sundial_tax_zones.sql in the Supabase SQL editor first.

import fs from "node:fs";
import path from "node:path";
import { buildTaxTableRows, syncTaxTables, pullAcumaticaTax } from "../lib/tax-zones.js";
import { primaryTenantSlug } from "../lib/tenant-guard.js";

const APPLY = process.argv.includes("--apply");
const PULL = process.argv.includes("--pull");
const DIR = path.resolve("_delivery/acumatica-tax");
const tenant = primaryTenantSlug();
const today = new Date().toISOString().slice(0, 10);

let raw;
if (PULL) {
  const { getAcumaticaEntity } = await import("../lib/acumatica.js");
  raw = await pullAcumaticaTax(getAcumaticaEntity);
} else {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  raw = { zones: read("tax-zones.json"), taxes: read("taxes.json"), categories: read("tax-categories.json") };
}

const built = buildTaxTableRows(raw, { tenant, today });
const retail = built.zones.filter((z) => z.is_retail);
console.log(`tenant ${tenant}: ${built.zones.length} zones (${retail.length} retail), ${built.rates.length} taxes, ${built.categories.length} categories, ${built.aliases.length} map-spelling aliases`);
console.log(`drift: ${built.drift.cityTaxNotRetail.length} city taxes outside RETAIL, ${built.drift.contractingTaxOnRetail.length} contracting taxes on retail zones`);
for (const z of retail.slice(0, 5)) console.log(`   e.g. ${z.zone_code} ${z.city_key ?? "(county)"} ${z.combined_rate}%`);

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply.");
  process.exit(0);
}
const { getSupabaseClient } = await import("../lib/supabase.js");
const supabase = await getSupabaseClient();
const result = await syncTaxTables({ supabase, tenant, raw, today });
console.log(`written: ${JSON.stringify({ ...result, drift: undefined })}`);
const { data } = await supabase.from("sundial_tax_zones").select("zone_code", { count: "exact" }).eq("tenant", tenant).eq("is_retail", true);
console.log(`re-read: ${data?.length ?? "?"} retail zones for ${tenant}`);
