// budget-rates.js — the MADE-UP budget rates every demo Solar project carries.
//
// WHY THEY EXIST: the demo keeps the budget calculator (lambdas/sundial-budget). Several
// of its inputs have field-level DEFAULTS in the org that are Harmon's real numbers
// (adder prices, adder costs, the 75 % burden rates, the battery price). A demo project
// that left those blank would quietly show Harmon's pricing to a prospect. So the seed
// writes EVERY input the calculator reads, with round, obviously generic values, and the
// org default never applies.
//
// The list of inputs comes from lambdas/sundial-budget/budgetCalc.js (every `g('…')`
// read and the adder catalogs FLAT_ADDERS / PPW_ADDERS / SUBCON_ADDERS /
// PASSTHROUGH_ADDERS / NS_BLOCKS). OUTPUT fields (Total_*, *_Cost__c roll-ups, GP_*,
// Commission_* amounts, Budget_Calc_Status__c) are never written — press Recalculate.
//
// ┌──────────────────────────────────────────────────────────────────────────────────┐
// │ TUNE THESE FREELY — every number below is invented.                              │
// │                                                                                  │
// │ Labor                                                                            │
// │   Blended labor rate ............................ $30 / hour                     │
// │   Battery (Powerwall) labor rate ................ $40 / hour                     │
// │   Labor burden rate ............................. 50 %                           │
// │   Commission burden rate ........................ 10 %                           │
// │   Audit hours ................................... 2 h                            │
// │   QA / commissioning hours ...................... 2 h                            │
// │   Install hours per module ...................... 1 h                            │
// │   Battery install hours ......................... 8 h (0 without a battery)      │
// │ Material                                                                         │
// │   Module cost ................................... $0.30 / W                      │
// │   Microinverter unit cost ....................... $150 each (one per panel)      │
// │   Combiner ...................................... $500 x 1                       │
// │   Battery unit cost ............................. $8,000                         │
// │   Tesla expansion pack unit cost ................ $1,000 (qty 0)                 │
// │   BOS solar ..................................... $0.10 / W                      │
// │   BOS electrical ................................ $0.10 / W                      │
// │   Roof: penetrations per module ................. 2                              │
// │   Roof material cost per penetration ............ $5                             │
// │   Roofing labor cost per penetration ............ $10  (2 per module)            │
// │   Material — other .............................. $250                           │
// │ Other                                                                            │
// │   Constructive Ops fee .......................... $500                           │
// │   Permit pass-through ........................... $300                           │
// │   Dealer fee .................................... $0                             │
// │ Commission inputs                                                                │
// │   Sales manager commission ...................... $0.05 / W                      │
// │   Overhead commission ........................... $0.02 / W                      │
// │   Geo (setter) commission, flat ................. $100                           │
// │   Internal rep commission $/W (retired input) ... 0                              │
// │ Sold prices                                                                      │
// │   Battery unit PRICE ............................ $12,000                        │
// │   Tesla expansion pack unit PRICE ............... $6,000                         │
// │   Adder prices and costs ........................ the ADDERS table below         │
// │   Non-standard adder markup ..................... 25 %                           │
// │ Roofing (on the 10 roofing jobs)                                                 │
// │   Labor per square: shingle / tile / modified / recoat .. $150 / $200 / $100 / $125 │
// │   Material unit costs ........................... $10, $20, $25, $40, $50, $75,  │
// │                                                   $100 repeating; misc other $100 │
// └──────────────────────────────────────────────────────────────────────────────────┘
//
// NOTE ON PERCENT FIELDS: over the REST API a Percent field takes the DISPLAY number —
// 50 means 50 % (scripts/fix-burden-rate-percent-domain.mjs is the story of the day that
// was got wrong). The values below are display numbers.
//
// NOTE ON THE COMMISSION FORMULA: `Commission_Redline_PPW__c` is a Salesforce FORMULA
// with Harmon's redlines written into it ($2.10–2.20/W when the sales company is exactly
// "Harmon Solar", $1.75–1.85/W for anyone else). The demo cannot change a formula, so a
// demo deal's commission is "contract − 1.85 × watts − adders" whoever sold it, and an
// in-house "Constructive Solar" deal is treated as a third-party deal by the calculator.

export const BUDGET_RATES = Object.freeze({
  Blended_Labor_Rate__c: 30,
  Battery_Labor_Rate__c: 40,
  Labor_Burden_Rate__c: 50,
  Commission_Burden_Rate__c: 10,
  Audit_Hours__c: 2,
  QA_Commissioning_Hours__c: 2,
  Install_Hours_Per_Module__c: 1,
  Module_Cost_Per_Watt__c: 0.3,
  Microinverter_Unit_Cost__c: 150,
  Combiner_Unit_Cost__c: 500,
  Combiner_Qty__c: 1,
  Battery_Unit_Cost__c: 8000,
  Gateway_Unit_Cost__c: 1000,
  Gateway_Qty__c: 0,
  BOS_Solar_Cost_Per_Watt__c: 0.1,
  BOS_Electrical_Cost_Per_Watt__c: 0.1,
  Penetrations_Per_Module__c: 2,
  Roof_Material_Cost_Per_Pen__c: 5,
  Roofing_Cost_Per_Penetration__c: 10,
  Roofing_Pens_Per_Module__c: 2,
  Material_Other_Cost__c: 250,
  Constructive_Ops_Fee__c: 500,
  Permit_Pass_Through_Cost__c: 300,
  Dealer_Fee__c: 0,
  Sales_Mgr_Commission_PPW__c: 0.05,
  Overhead_Commission_PPW__c: 0.02,
  Geo_Commission_Amount__c: 100,
  Internal_Rep_Commission_PPW__c: 0,
  Battery_Unit_Price__c: 12000,
  Tesla_Expansion_Pack_Unit_Price__c: 6000,
});
export const BATTERY_INSTALL_HOURS = 8;
export const NS_MARKUP_PERCENT = 25;

/**
 * The adder price list. `base` is the middle of the field names:
 * Adder_<base>_Price__c / _Qty__c / _Cost__c. `perWatt` adders are priced per WATT
 * (budgetCalc refuses anything above $10/W, so these stay in cents). `cost` is null
 * where the calculator has no Cost field for that adder.
 */
export const ADDERS = Object.freeze([
  { base: "Sub_Panel", label: "Sub panel", price: 500, cost: 250 },
  { base: "Derate", label: "Derate", price: 500, cost: 250 },
  { base: "Heat_Detector", label: "Heat detector", price: 250, cost: 100 },
  { base: "Upgrade_225", label: "225A upgrade (overhead)", price: 2000, cost: 1000 },
  { base: "Upgrade_400", label: "400A upgrade", price: 4000, cost: 2000 },
  { base: "Upgrade_225_UG", label: "225A upgrade (underground)", price: 3000, cost: 1250 },
  { base: "Gateway3", label: "Gateway", price: 3500, cost: 2000 },
  { base: "Site_Audit", label: "Site audit", price: 300, cost: null },
  { base: "Travel", label: "Travel", price: 1000, cost: null },
  { base: "Structural", label: "Structural engineering", price: 500, cost: 250 },
  { base: "Small_System_10_12", label: "Small system (10-12 panels)", price: 1000, cost: null },
  { base: "Small_System_13_15", label: "Small system (13-15 panels)", price: 750, cost: null },
  { base: "Software_Fee", label: "Software fee", price: 50, cost: null },
  { base: "Active_Monitoring", label: "Active monitoring", price: 150, cost: null },
  { base: "LR_Battery_Warranty", label: "Battery warranty", price: 750, cost: null },
  { base: "Referral_Fee", label: "Referral fee", price: 250, cost: null },
  { base: "Conduit_Attic", label: "Conduit in attic", price: 0.1, cost: 0.05, perWatt: true },
  { base: "Flat_Roof", label: "Flat roof", price: 0.1, cost: 0.05, perWatt: true },
  { base: "Roof_Tile", label: "Roof tile", price: 0.05, cost: 0.01, perWatt: true },
  { base: "Bird_Blocking", label: "Bird blocking", price: 0.1, cost: 0.05, perWatt: true },
]);

/**
 * Roofing labor rates per square. The roofing object's defaults are Harmon's (168 / 224 /
 * 112 / 140), so the demo writes its own round ones where the fields exist.
 */
export const ROOFING_RATES = Object.freeze({
  Labor_Rate_Shingle__c: 150,
  Labor_Rate_Tile__c: 200,
  Labor_Rate_Modified__c: 100,
  Labor_Rate_Recoat__c: 125,
});

/**
 * Roofing material UNIT COSTS. The roofing object carries about 45 "Mat_…_Cost__c" fields
 * whose defaults are Harmon's supplier prices. The demo overwrites every one that exists
 * in the org with a repeating series of round numbers — plainly not a real price list —
 * and the catch-all "Misc_Other_Cost__c" with $100. Quantities stay at zero.
 */
export const ROOFING_GENERIC_COSTS = Object.freeze([10, 20, 25, 40, 50, 75, 100]);
export function roofingMaterialCostFields(schema) {
  const o = schema.object("Sundial_Roofing__c");
  const f = {};
  if (!o) return f;
  const names = Object.keys(o.fields).filter((n) => /^Mat_.+_Cost__c$/.test(n) && o.fields[n].createable && o.fields[n].type === "currency").sort();
  names.forEach((n, i) => { f[n] = ROOFING_GENERIC_COSTS[i % ROOFING_GENERIC_COSTS.length]; });
  if (o.fields.Misc_Other_Cost__c?.createable) f.Misc_Other_Cost__c = 100;
  return f;
}

/**
 * The budget-input fields for one project.
 * @param {{ watts:number, panelWatts:number, panels:number, batteryQty:number, microinverters:boolean,
 *           adderQty: Record<string, number>, ns?: { description:string, material:number, hours:number } | null }} p
 */
export function solarBudgetFields(p) {
  const f = { ...BUDGET_RATES };
  f.Module_STC_Wattage__c = p.panelWatts;
  f.Microinverter_Qty__c = p.microinverters ? p.panels : 0;
  f.Battery_Qty__c = p.batteryQty;
  f.Battery_Install_Hours__c = p.batteryQty > 0 ? BATTERY_INSTALL_HOURS : 0;
  for (const a of ADDERS) {
    f[`Adder_${a.base}_Price__c`] = a.price;
    f[`Adder_${a.base}_Qty__c`] = p.adderQty?.[a.base] ?? 0;
    if (a.cost !== null) f[`Adder_${a.base}_Cost__c`] = a.cost;
  }
  for (let n = 1; n <= 5; n++) f[`NS_Adder_${n}_Markup_Percent__c`] = NS_MARKUP_PERCENT;
  if (p.ns) {
    f.NS_Adder_1_Description__c = p.ns.description;
    f.NS_Adder_1_Material_Cost__c = p.ns.material;
    f.NS_Adder_1_Labor_Hours__c = p.ns.hours;
  }
  return f;
}

/**
 * The SOLD value of the adders on a project — what the contract amount includes on top of
 * price-per-watt x watts. Mirrors the org's Total_Adder_Price__c formula (flat adders,
 * per-watt adders x watts, the non-standard block, the battery), so the commission
 * formula — contract − redline x watts − adders — stays a sensible positive number.
 */
export function adderSoldTotal(p) {
  let total = 0;
  for (const a of ADDERS) {
    const qty = p.adderQty?.[a.base] ?? 0;
    total += a.perWatt ? a.price * qty * p.watts : a.price * qty;
  }
  if (p.ns) total += p.ns.material * (1 + NS_MARKUP_PERCENT / 100) + p.ns.hours * 33 * 1.75;
  total += BUDGET_RATES.Battery_Unit_Price__c * p.batteryQty;
  return Math.round(total * 100) / 100;
}

/** The adder price list as it sits on a CUSTOMER (prices only; quantities follow the deal). */
export function customerAdderFields(adderQty = {}) {
  const f = {
    Battery_Unit_Price__c: BUDGET_RATES.Battery_Unit_Price__c,
    Tesla_Expansion_Pack_Unit_Price__c: BUDGET_RATES.Tesla_Expansion_Pack_Unit_Price__c,
    Internal_Rep_Commission_PPW__c: 0,
  };
  for (const a of ADDERS) {
    f[`Adder_${a.base}_Price__c`] = a.price;
    f[`Adder_${a.base}_Qty__c`] = adderQty[a.base] ?? 0;
  }
  for (let n = 1; n <= 5; n++) f[`NS_Adder_${n}_Markup_Percent__c`] = NS_MARKUP_PERCENT;
  return f;
}
