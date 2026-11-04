// lib/report-types.js — the report types (D-088, R1a; docs/reporting-module.md §6.2).
//
// A report type is a FIXED join, named like a Salesforce report type: a base object and the
// objects hung off it, each under an alias. A report definition names its fields as
// "<alias>.<column>" (e.g. "rep.name"), so one object can appear twice under two aliases.
//
// THE SHAPE all nine §6.2 types will use:
//   {
//     key, label,
//     base:  { object, alias },                         object = a key of the catalog
//     joins: [{ object, alias, label, kind: "left",
//               on: { left: "<alias>.<column>", right: "<column of the joined object>" } }],
//     defaultColumns: ["<alias>.<column>", ...],
//   }
// `on` is structured, never SQL text: sundial_report_run re-checks `left`'s alias and both
// columns against public.sundial_report_catalog and builds the ON clause itself, with the
// tenant clause (`<alias>.client_sf_id = tenant`) ANDed into every join.
//
// R1a implements `solar` only. Its joins are the ones the cache can serve today:
//   - customer on solar.sundial_customer_sf_id (Sundial_Customer__c lookup);
//   - user as rep on solar.sales_rep_sf_id (Sales_Rep__c → Sundial_User__c).
// NOT joined, on purpose (D-088):
//   - Dealer: there is no sundial_dealer_cache. The dealer is solar.dealer_sf_id /
//     solar.dealer_display_name. A dealer cache table is the first R1b item.
//   - "User as PM": Sundial_Solar__c.Project_Manager__c is a MULTIPICKLIST in the live org
//     (describe, 2026-11-03) — names, not a user id — and the cache's project_manager_sf_id /
//     project_manager_name columns are empty on every row (0 of 4,595) with no field behind
//     them. The PM is reported as solar.project_manager.

export const REPORT_TYPES = Object.freeze({
  solar: Object.freeze({
    key: "solar",
    label: "Solar projects",
    base: Object.freeze({ object: "solar", alias: "solar", label: "Solar project" }),
    joins: Object.freeze([
      Object.freeze({
        object: "customer", alias: "customer", label: "Customer", kind: "left",
        on: Object.freeze({ left: "solar.sundial_customer_sf_id", right: "sf_id" }),
      }),
      Object.freeze({
        object: "user", alias: "rep", label: "Sales rep", kind: "left",
        on: Object.freeze({ left: "solar.sales_rep_sf_id", right: "sf_id" }),
      }),
    ]),
    defaultColumns: Object.freeze([
      "solar.project_name",
      "customer.name",
      "solar.stage",
      "rep.name",
      "solar.project_manager",
      "solar.contract_amount",
      "solar.system_size",
      "solar.contract_date",
    ]),
  }),
});

/** The type, by own-property lookup (a key comes straight from a request body). */
export function reportType(key) {
  return typeof key === "string" && Object.hasOwn(REPORT_TYPES, key) ? REPORT_TYPES[key] : null;
}

/** alias → catalog object key, base first. */
export function aliasesOf(type) {
  const out = new Map([[type.base.alias, type.base.object]]);
  for (const j of type.joins) out.set(j.alias, j.object);
  return out;
}

/** The shape GET /reports/types returns. */
export function describeTypes() {
  return Object.values(REPORT_TYPES).map((t) => ({
    key: t.key,
    label: t.label,
    base: { alias: t.base.alias, object: t.base.object, label: t.base.label },
    joins: t.joins.map((j) => ({ alias: j.alias, object: j.object, label: j.label })),
    defaultColumns: [...t.defaultColumns],
  }));
}
