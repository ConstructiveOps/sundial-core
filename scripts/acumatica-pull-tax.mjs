// Read-only pull of Harmon's sales-tax setup from Acumatica (D-083, Part A).
//
// Julie's tax-table exports never arrived, so the source is Acumatica itself:
// TaxZone (+ ApplicableTaxes), Tax (+ TaxSchedule, Zones) and TaxCategory (+ Details)
// on the Default 25.200.001 endpoint. GET only — nothing here writes anywhere but
// _delivery/acumatica-tax/ (git-ignored; raw JSON for the seed script to load).
//
//   node scripts/acumatica-pull-tax.mjs            # pull + report
//   node scripts/acumatica-pull-tax.mjs --offline  # report from the last pull
//
// ⚠️ lib/acumatica.js's secret is a POINTER (D-058): the report prints the tenant the
// credential is scoped to so nobody mistakes a sandbox pull for live rates.

import fs from "node:fs";
import path from "node:path";
import { getAcumaticaEntity, ACUMATICA_SECRET_NAME } from "../lib/acumatica.js";
import { getSecret } from "../lib/secrets.js";
import { lookupTaxZone, normalizeCity } from "../lib/acumatica-tax-zones.js";

const OUT_DIR = path.resolve("_delivery/acumatica-tax");
const OFFLINE = process.argv.includes("--offline");

const PULLS = [
  { entity: "TaxZone", expand: "ApplicableTaxes", file: "tax-zones.json" },
  { entity: "Tax", expand: "TaxSchedule,Zones", file: "taxes.json" },
  { entity: "TaxCategory", expand: "Details", file: "tax-categories.json" },
];

const v = (f) => (f && typeof f === "object" && "value" in f ? f.value : f ?? null);

async function pull() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = {};
  for (const p of PULLS) {
    const res = await getAcumaticaEntity(p.entity, { $expand: p.expand });
    if (!res.ok || !Array.isArray(res.data)) {
      throw new Error(`${p.entity} ($expand=${p.expand}) failed: ${res.status} ${res.text.slice(0, 300)}`);
    }
    fs.writeFileSync(path.join(OUT_DIR, p.file), JSON.stringify(res.data, null, 2));
    out[p.entity] = res.data;
  }
  // Which tenant the pointer secret is scoped to (the client_id suffix after "@").
  const s = await getSecret(ACUMATICA_SECRET_NAME);
  const tenant = String(s.client_id ?? "").split("@")[1] ?? "(unknown)";
  const meta = { pulledAt: new Date().toISOString(), acumaticaTenant: tenant };
  fs.writeFileSync(path.join(OUT_DIR, "pull-meta.json"), JSON.stringify(meta, null, 2));
  return { ...out, meta };
}

function load() {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8"));
  return {
    TaxZone: read("tax-zones.json"),
    Tax: read("taxes.json"),
    TaxCategory: read("tax-categories.json"),
    meta: read("pull-meta.json"),
  };
}

// The rate in force today: the schedule row with the latest StartDate <= today.
function currentRate(tax, today) {
  const rows = (tax.TaxSchedule ?? [])
    .map((r) => ({ rate: v(r.TaxRate), start: String(v(r.StartDate) ?? "").slice(0, 10) }))
    .filter((r) => r.start && r.start <= today)
    .sort((a, b) => b.start.localeCompare(a.start));
  return rows[0] ?? null;
}

const pct = (n) => (n == null ? "—" : `${Number(n).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}%`);

const data = OFFLINE ? load() : await pull();
const today = new Date().toISOString().slice(0, 10);

const taxes = new Map(data.Tax.map((t) => [v(t.TaxID), t]));
const categories = data.TaxCategory.map((c) => ({
  id: v(c.TaxCategoryID),
  description: v(c.Description),
  active: v(c.Active),
  taxIds: new Set((c.Details ?? []).map((d) => v(d.TaxID))),
}));
const zones = data.TaxZone.map((z) => ({
  code: v(z.TaxZoneID),
  description: v(z.Description) ?? "",
  taxIds: (z.ApplicableTaxes ?? []).map((a) => v(a.TaxID)),
}));

const isRetail = (z) => /R$/.test(z.code) || /retail/i.test(z.description);
const isCounty = (z) => /county/i.test(z.description);
const retail = zones.filter(isRetail);
const contracting = zones.filter((z) => !isRetail(z));

console.log(`Acumatica tenant: ${data.meta.acumaticaTenant}   pulled ${data.meta.pulledAt}`);
console.log(`Zones: ${zones.length}  (retail ${retail.length}, other ${contracting.length})   Taxes: ${taxes.size}   Categories: ${categories.length}`);

console.log(`\n=== TAX CATEGORIES ===`);
for (const c of categories) {
  console.log(`${c.id}  "${c.description}"${c.active === false ? "  (INACTIVE)" : ""}  — ${c.taxIds.size} taxes`);
  console.log(`   ${[...c.taxIds].sort().join(", ")}`);
}

// Per zone: each tax's current rate, and the combined rate PER CATEGORY (a tax applies to
// a line only when the line's category includes it — Acumatica's own rule).
function zoneRates(z) {
  const rows = z.taxIds.map((id) => {
    const t = taxes.get(id);
    const cur = t ? currentRate(t, today) : null;
    return { id, description: t ? v(t.Description) : "(tax not found)", rate: cur?.rate ?? null, start: cur?.start ?? null };
  });
  const byCat = {};
  for (const c of categories) {
    const hits = rows.filter((r) => c.taxIds.has(r.id) && r.rate != null);
    if (hits.length) byCat[c.id] = hits.reduce((s, r) => s + Number(r.rate), 0);
  }
  return { rows, byCat };
}

console.log(`\n=== RETAIL ZONES (${retail.length}) ===`);
for (const z of retail.sort((a, b) => a.code.localeCompare(b.code))) {
  const { rows, byCat } = zoneRates(z);
  console.log(`\n${z.code}  "${z.description}"${isCounty(z) ? "  [COUNTY]" : ""}`);
  for (const r of rows) console.log(`   ${r.id.padEnd(10)} ${pct(r.rate).padStart(9)}  from ${r.start ?? "—"}  ${r.description}`);
  console.log(`   combined by category: ${Object.entries(byCat).map(([k, n]) => `${k} ${pct(n)}`).join(" · ") || "(none)"}`);
}

console.log(`\n=== COUNTY-ONLY ZONES ===`);
for (const z of zones.filter(isCounty)) console.log(`${z.code}  "${z.description}"${isRetail(z) ? "" : "  (not retail)"}`);

console.log(`\n=== CONTRACTING / OTHER ZONES (listed, otherwise ignored) ===`);
console.log(contracting.map((z) => `${z.code} "${z.description}"`).join("\n"));

// Cross-check against lib/acumatica-tax-zones.js (the map the customer push uses).
const src = fs.readFileSync("lib/acumatica-tax-zones.js", "utf8");
const mapCodes = new Set([...src.matchAll(/:\s*"([0-9]{2}[A-Z]+)"/g)].map((m) => m[1]));
const zoneCodes = new Set(zones.map((z) => z.code));
console.log(`\n=== CROSS-CHECK vs lib/acumatica-tax-zones.js ===`);
const notInMap = retail.filter((z) => !mapCodes.has(z.code));
console.log(`Retail zones in Acumatica with NO city in the map (${notInMap.length}):`);
for (const z of notInMap) {
  const city = z.description.split(/\s+-\s+/)[0];
  const hit = lookupTaxZone(city);
  console.log(`   ${z.code}  "${z.description}"${hit.matched ? `  (map sends "${normalizeCity(city)}" to ${hit.zone})` : ""}`);
}
const missing = [...mapCodes].filter((c) => !zoneCodes.has(c));
console.log(`Codes in the map that are NOT an Acumatica zone (${missing.length}): ${missing.join(", ") || "none"}`);
const mapNonRetail = [...mapCodes].filter((c) => zoneCodes.has(c) && !retail.some((z) => z.code === c));
console.log(`Codes in the map that exist but are not classed retail: ${mapNonRetail.join(", ") || "none"}`);

// --- DRIFT (D-083: copy Acumatica exactly; make what would surprise a reader visible) -----
// The same check the daily refresh logs (lib/tax-zones.js taxDrift), so this report and the
// refresh's CloudWatch line never disagree. Fix these IN ACUMATICA; the refresh brings it over.
const { buildTaxTableRows } = await import("../lib/tax-zones.js");
const built = buildTaxTableRows({ zones: data.TaxZone, taxes: data.Tax, categories: data.TaxCategory }, { tenant: "report", today });
const drift = built.drift;
console.log(`\n=== DRIFT — fix in Acumatica, the daily refresh carries it over ===`);
console.log(`Retail zones whose city tax is in NO retail category (never charged on a retail line) (${drift.cityTaxNotRetail.length}):`);
for (const x of drift.cityTaxNotRetail) console.log(`   ${x.zone.padEnd(12)} "${x.description}"  carries ${x.taxId} "${x.tax}"`);
console.log(`Retail zones carrying a CONTRACTING tax (${drift.contractingTaxOnRetail.length}):`);
for (const x of drift.contractingTaxOnRetail) console.log(`   ${x.zone.padEnd(12)} "${x.description}"  carries ${x.taxId} "${x.tax}"`);
console.log(`Retail city zones no city in lib/acumatica-tax-zones.js points at (${drift.unmappedRetail.length}): ${drift.unmappedRetail.map((x) => x.zone).join(", ") || "none"}`);
const upcoming = built.rates.flatMap((r) => r.schedule.filter((s) => s.start > today).map((s) => `${r.tax_id} ${s.rate}% from ${s.start}`));
console.log(`Future-dated rates (${upcoming.length}): ${upcoming.join(" · ") || "none"}`);
