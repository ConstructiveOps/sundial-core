// scripts/build-pricebook-import.mjs — turn Housecall Pro's two price-book exports into
// ONE Data Loader file for Sundial_Price_Book_Item__c (D-072.4; 2026-09-15).
//
//   node scripts/build-pricebook-import.mjs
//     reads  salesforce/pricebook-import/source_HarmonElectric_pricebook_export.csv
//            salesforce/pricebook-import/source_HarmonElectric_pricebook_materials_export.csv
//     writes salesforce/pricebook-import/Sundial_Price_Book_Item__c.csv   (the upload)
//            salesforce/pricebook-import/Sundial_Price_Book_Item__c.sdl   (Data Loader mapping)
//            salesforce/pricebook-import/review.csv                       (one line per item: what was decided and why)
//
// WHAT IT DECIDES (every rule is visible in review.csv so Harmon can overrule per item):
//   Kind      services → Labor, except fee-shaped names (plans, trip/service charges, travel
//             adders, disposal, permit & design, engineering) → Fee; materials → Material,
//             same fee exception ("Trip Charge" lives in the materials export).
//   Job Type  HCP industry + sub-category: Electrical → Electrical (its "Electric Vehicle"
//             category → EV); Solar & Energy → Solar / EV by sub-category 2 ("Other" → blank);
//             materials by category: inverters, monitoring, panels → Solar; EV → EV;
//             AES parts → Commercial; wire / conduit / misc → blank.
//   Svc Type  HCP sub-category 1 (Installation / Repair) when present; otherwise from the
//             verb the name starts with (Install / Furnish → Installation, Replace / Repair →
//             Repair); blank when neither applies (materials).
//   Category  Electrical items keep HCP's category; Solar & Energy items get one derived
//             from the name (Service Call, Service Plan, RMA, Inspection, Quoted Work,
//             Disposal, Inverter, Monitoring, EV Charger, ...); materials by HCP category.
//             Category__c is an unrestricted picklist, so new values are accepted as-is.
//   Codes     SVC-<ELEC|SOLAR|EV|GEN>-nnnn for services, MAT-<INV|WIRE|CND|MON|EV|AES|PNL|MISC>-nnnn
//             for materials, numbered in export order. Stable across re-runs of this script
//             as long as the source files do not change order.
//   Active    Is_Active = false when BOTH price and cost are $0.00 (HCP's unpriced stock
//             items and the $0 placeholders) — they import, stay out of the picker, and the
//             office can price + activate them from the Price Book page.
//   Prices    Labor / Fee → Labor_Price (+ Labor_Cost); Material → Material_Price (+ Material_Cost).
//   Text      HCP's export mangles curly apostrophes and dashes into "?" — "system?s" → "system's",
//             "early?protecting" → "early — protecting". Names are trimmed. Descriptions are
//             capped at 4,000 characters (the field's length).
//   Unit      Each unless the HCP unit says otherwise; wire spools priced per foot → Foot.
//   Key       HCP_Id__c = HCP's uuid → Data Loader UPSERT on it, so a re-run updates rather
//             than duplicates, and the later HCP job migration can match lines to items.
//
// Pure file transform — no Salesforce, no network. Safe to run any number of times.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "salesforce", "pricebook-import");
const TENANT_ID = "a1W7y000007AszBEAS"; // Sundial_Tenant__c "harmon" (Client__c is required)

// --- tiny CSV reader/writer (RFC 4180: quoted fields, doubled quotes, embedded newlines) ---
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", i = 0, inQ = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((v) => v !== ""));
  return body.map((r) => Object.fromEntries(header.map((h, k) => [h.trim(), r[k] ?? ""])));
}
const q = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (cols, rows) => [cols.join(","), ...rows.map((r) => cols.map((c) => q(r[c])).join(","))].join("\r\n") + "\r\n";

// --- cleaners ----------------------------------------------------------------------
const money = (v) => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const cleanName = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
function cleanText(s) {
  let t = String(s ?? "").replace(/\r\n?/g, "\n");
  t = t.replace(/(\w)\?s\b/g, "$1's"); // system?s → system's
  t = t.replace(/(\w)\?(\w)/g, "$1 — $2"); // early?protecting → early — protecting
  t = t.replace(/\s\?\s/g, " — "); // Plan ? Clean → Plan — Clean
  t = t.replace(/"+$/g, "").trim(); // HCP's stray trailing quote
  return t.slice(0, 4000);
}
// "Disposal" is a fee only when it IS the item ("Disposal - Solar Panel", "Inverter
// Disposal"), not when a service mentions a garbage disposal.
const FEE_RE = /\b(plan|trip charge|service charge|travel adder|permit and design|engineering)\b|^disposal\b|\bdisposal$/i;
const unitOf = (raw, category) => {
  const u = String(raw ?? "").trim().toLowerCase();
  if (u === "hour") return "Hour";
  if (u === "foot" || /^wire$/i.test(category)) return "Foot";
  if (u === "lot") return "Lot";
  return "Each";
};

// --- classification -------------------------------------------------------------------
function serviceJobType(r) {
  if (r.industry === "Electrical") return /electric vehicle/i.test(r.category) ? "EV" : "Electrical";
  const sub = (r.subcategory_2 || "").trim();
  return sub === "Solar" ? "Solar" : sub === "EV" ? "EV" : "";
}
function serviceType(r) {
  const s1 = (r.subcategory_1 || "").trim();
  if (s1 === "Installation" || s1 === "Repair") return s1;
  if (/^(install|furnish)/i.test(r.name.trim())) return "Installation";
  if (/^(replace|repair)/i.test(r.name.trim())) return "Repair";
  return "";
}
function serviceCategory(r) {
  if (r.industry === "Electrical") {
    const c = r.category.trim();
    return /electric vehicle/i.test(c) ? "EV Charger" : c;
  }
  const n = r.name;
  if (/plan\s*$/i.test(n)) return "Service Plan";
  if (/^(installation|repair) - /i.test(n)) return "Service Call";
  if (/truck roll|service call|trip charge|labor|man hours|dispatch|service charge|travel/i.test(n)) return "Service Call";
  if (/\brma\b/i.test(n)) return "RMA";
  if (/inspection|inpsection/i.test(n)) return "Inspection";
  if (/quoted|removal|reinstall|roof repair|o&m/i.test(n)) return "Quoted Work";
  if (/disposal/i.test(n)) return "Disposal";
  if (/inverter/i.test(n)) return "Inverter";
  if (/meter|\bct\b|communication|catm1/i.test(n)) return "Monitoring";
  if (/disconnect/i.test(n)) return "Electrical";
  if (/bird/i.test(n)) return "Cleaning";
  if (/permit|engineering/i.test(n)) return "Permit & Design";
  if (/^(ct4|chargepoint|tesla|ev\b)/i.test(n) || (r.subcategory_2 || "").trim() === "EV") return "EV Charger";
  if (/string down|isolation|fault|troubleshooting|repair/i.test(n)) return "Solar Repair";
  return (r.subcategory_2 || "").trim() === "Solar" ? "Solar Repair" : "Other";
}
const MATERIAL_CATS = {
  INVERTER: { category: "Inverter", jobType: "Solar", code: "INV" },
  "Solar Monitoring": { category: "Monitoring", jobType: "Solar", code: "MON" },
  "Kyocera solar panel - gently used": { category: "Panel", jobType: "Solar", code: "PNL" },
  "Electric Vehicle": { category: "EV Charger", jobType: "EV", code: "EV" },
  AES: { category: "Commercial Parts", jobType: "Commercial", code: "AES" },
  Wire: { category: "Wire", jobType: "", code: "WIRE" },
  "CONDUIT/CONDUIT MATERIAL": { category: "Conduit", jobType: "", code: "CND" },
  "Misc material": { category: "Materials", jobType: "", code: "MISC" },
};
const SERVICE_CODE = { Electrical: "ELEC", Solar: "SOLAR", EV: "EV", "": "GEN" };

// --- build ----------------------------------------------------------------------------
const services = parseCsv(fs.readFileSync(path.join(DIR, "source_HarmonElectric_pricebook_export.csv"), "utf8"));
const materials = parseCsv(fs.readFileSync(path.join(DIR, "source_HarmonElectric_pricebook_materials_export.csv"), "utf8"));

const counters = {};
const nextCode = (prefix) => {
  counters[prefix] = (counters[prefix] || 0) + 1;
  return `${prefix}-${String(counters[prefix]).padStart(4, "0")}`;
};

const out = [];
const review = [];
function push(item, why) {
  out.push(item);
  review.push({ ...item, Why: why });
}

for (const r of services) {
  const name = cleanName(r.name);
  const price = money(r.price), cost = money(r.cost);
  const kind = FEE_RE.test(name) ? "Fee" : "Labor";
  const jobType = serviceJobType(r);
  const active = price > 0 || cost > 0;
  push({
    HCP_Id__c: r.uuid.trim(),
    Name: name,
    Item_Code__c: nextCode(`SVC-${SERVICE_CODE[jobType]}`),
    Version__c: 1,
    Is_Active__c: active,
    Kind__c: kind,
    Job_Type__c: jobType,
    Service_Type__c: serviceType(r),
    Category__c: serviceCategory(r),
    Description__c: cleanText(r.description),
    Unit_of_Measure__c: unitOf(r.unit_of_measure, ""),
    Default_Quantity__c: 1,
    Labor_Price__c: price,
    Labor_Cost__c: cost > 0 ? cost : "",
    Material_Price__c: "",
    Material_Cost__c: "",
    Taxable__c: String(r.taxable).trim().toLowerCase() === "true",
    Client__c: TENANT_ID,
  }, [
    `HCP ${r.industry}${r.subcategory_1 ? ` / ${r.subcategory_1}` : ""}${r.subcategory_2 ? ` / ${r.subcategory_2}` : ""} / ${r.category.trim()}`,
    kind === "Fee" ? "fee-shaped name → Fee" : "service → Labor",
    active ? "" : "$0 price and cost → imported INACTIVE",
    r.task_code ? `HCP stock item (${r.task_code})` : "",
  ].filter(Boolean).join("; "));
}

for (const r of materials) {
  const name = cleanName(r.name);
  const price = money(r.price), cost = money(r.cost);
  const cat = MATERIAL_CATS[r.category.trim()] || { category: "Materials", jobType: "", code: "MISC" };
  const kind = FEE_RE.test(name) ? "Fee" : "Material";
  const active = price > 0 || cost > 0;
  push({
    HCP_Id__c: r.uuid.trim(),
    Name: name,
    Item_Code__c: nextCode(`MAT-${cat.code}`),
    Version__c: 1,
    Is_Active__c: active,
    Kind__c: kind,
    Job_Type__c: cat.jobType,
    Service_Type__c: "",
    Category__c: kind === "Fee" ? "Service Call" : cat.category,
    Description__c: cleanText([r.description, r.part_number ? `Part # ${r.part_number.trim()}` : ""].filter(Boolean).join("\n")),
    Unit_of_Measure__c: unitOf(r.unit_of_measure, r.category.trim()),
    Default_Quantity__c: 1,
    Labor_Price__c: kind === "Fee" ? price : "",
    Labor_Cost__c: kind === "Fee" && cost > 0 ? cost : "",
    Material_Price__c: kind === "Fee" ? "" : price,
    Material_Cost__c: kind !== "Fee" && cost > 0 ? cost : "",
    Taxable__c: String(r.taxable).trim().toLowerCase() === "true",
    Client__c: TENANT_ID,
  }, [
    `HCP materials / ${r.category.trim()}${r.subcategory_1 ? ` / ${r.subcategory_1}` : ""}`,
    kind === "Fee" ? "fee-shaped name → Fee" : "material → Material",
    active ? "" : "$0 price and cost → imported INACTIVE",
  ].filter(Boolean).join("; "));
}

// Sanity: unique keys, no empty names.
const ids = new Set(), codes = new Set();
for (const it of out) {
  if (!it.Name) throw new Error(`empty name for ${it.HCP_Id__c}`);
  if (ids.has(it.HCP_Id__c)) throw new Error(`duplicate HCP id ${it.HCP_Id__c}`);
  if (codes.has(it.Item_Code__c)) throw new Error(`duplicate code ${it.Item_Code__c}`);
  ids.add(it.HCP_Id__c); codes.add(it.Item_Code__c);
}

const COLS = ["HCP_Id__c", "Name", "Item_Code__c", "Version__c", "Is_Active__c", "Kind__c", "Job_Type__c", "Service_Type__c", "Category__c", "Description__c", "Unit_of_Measure__c", "Default_Quantity__c", "Labor_Price__c", "Labor_Cost__c", "Material_Price__c", "Material_Cost__c", "Taxable__c", "Client__c"];
fs.writeFileSync(path.join(DIR, "Sundial_Price_Book_Item__c.csv"), "﻿" + toCsv(COLS, out), "utf8");
fs.writeFileSync(path.join(DIR, "Sundial_Price_Book_Item__c.sdl"), ["#Mapping values", "#" + new Date().toISOString(), ...COLS.map((c) => `${c}=${c}`)].join("\n") + "\n", "utf8");
fs.writeFileSync(path.join(DIR, "review.csv"), "﻿" + toCsv([...COLS.filter((c) => !["Client__c", "Version__c", "Default_Quantity__c"].includes(c)), "Why"], review), "utf8");

const n = (f) => out.filter(f).length;
console.log(`wrote ${out.length} items → salesforce/pricebook-import/Sundial_Price_Book_Item__c.csv`);
console.log(`  services ${services.length}, materials ${materials.length}; active ${n((i) => i.Is_Active__c)}, inactive ($0) ${n((i) => !i.Is_Active__c)}`);
console.log(`  kind: Labor ${n((i) => i.Kind__c === "Labor")}, Material ${n((i) => i.Kind__c === "Material")}, Fee ${n((i) => i.Kind__c === "Fee")}`);
for (const jt of ["Solar", "Electrical", "EV", "Commercial", ""]) console.log(`  job type ${jt || "(blank)"}: ${n((i) => i.Job_Type__c === jt)}`);
const cats = {};
for (const i of out) cats[i.Category__c] = (cats[i.Category__c] || 0) + 1;
console.log("  categories:", Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", "));
