// lib/cost-gate.js — what a Service item or line COSTS is an Admin's number (2026-10-16, Harmon).
//
// Selling prices (Price__c, Labor_Price__c, Material_Price__c, Unit_Price__c …) are what the
// office quotes with and stay visible to everyone who builds an estimate. What the work COSTS
// Harmon — the price-book item's Labor_Cost__c / Material_Cost__c and the line's snapshots of
// them — is costing's business: tenant scope AND Admin / Executive (service.costing.read /
// service.costing.write in lib/access.js), the same people who see job costing and pay rates.
//
//   READ   anyone without service.costing.read gets the record / cache row WITHOUT the cost
//          keys (removed, not nulled — "absent" is how the portal knows to hide the input).
//   WRITE  a cost key from someone without service.costing.write:
//            blank (null, undefined, "") → treated as NOT SENT and dropped; the stored cost
//              is untouched. Today's portal sends both cost fields on every price-book save,
//              blank when it never saw them, so a Manager's save must not be refused — and
//              must not wipe the cost either.
//            any other value → 403 COSTING_FORBIDDEN. Never silently ignored: a non-blank
//              cost from a user who may not set one is a request we refuse out loud.
//
// One table for every surface: the estimate Lambda (price-book create / PATCH / new-version,
// estimate reads), sundial-sf-query (cache rows + Salesforce records) and sundial-sf-update
// (the generic PATCH / POST on pricebookitem and serviceline).

export const COSTING_READ = "service.costing.read";
export const COSTING_WRITE = "service.costing.write";
export const COSTING_FORBIDDEN = "COSTING_FORBIDDEN";

/** Per object: the Salesforce API names, the cache columns, and the estimate Lambda's body keys. */
export const COST_FIELDS = Object.freeze({
  pricebookitem: Object.freeze({
    sf: Object.freeze(["Labor_Cost__c", "Material_Cost__c"]),
    cache: Object.freeze(["labor_cost", "material_cost"]),
    body: Object.freeze(["laborCost", "materialCost"]),
  }),
  serviceline: Object.freeze({
    sf: Object.freeze(["Unit_Labor_Cost__c", "Unit_Material_Cost__c"]),
    cache: Object.freeze(["unit_labor_cost", "unit_material_cost"]),
    body: Object.freeze(["unitLaborCost", "unitMaterialCost"]),
  }),
});

const lowerSet = (list) => new Set(list.map((k) => k.toLowerCase()));
const ALL_KEYS = Object.fromEntries(
  Object.entries(COST_FIELDS).map(([obj, f]) => [obj, lowerSet([...f.sf, ...f.cache, ...f.body])])
);

/** Is this key (any spelling: API name, cache column, body key; any case) a cost key of the object? */
export function isCostKey(objectKey, key) {
  const set = ALL_KEYS[objectKey];
  return !!set && typeof key === "string" && set.has(key.toLowerCase());
}

/** Is a value "blank" for the write rule? null, undefined, or a string of only spaces. */
export const isBlankCost = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/**
 * Remove the cost keys from one record / row (any spelling). Returns a NEW object; the input
 * is left alone. A non-object comes back unchanged.
 */
export function stripCost(objectKey, record) {
  if (!record || typeof record !== "object" || !ALL_KEYS[objectKey]) return record;
  const out = {};
  for (const [k, v] of Object.entries(record)) if (!isCostKey(objectKey, k)) out[k] = v;
  return out;
}

/** stripCost unless the caller may read cost. `canRead` is a boolean. */
export function costView(objectKey, record, canRead) {
  return canRead ? record : stripCost(objectKey, record);
}

/**
 * The write rule for a body / field map.
 * @returns {{ ok:true, fields:object, dropped:string[] } | { ok:false, status:403, code:string, message:string, fields:string[] }}
 *   `fields` (on ok) is the input minus the blank cost keys a non-costing caller sent.
 */
export function costWriteGate(objectKey, body, canWrite) {
  const src = body && typeof body === "object" ? body : {};
  if (canWrite || !ALL_KEYS[objectKey]) return { ok: true, fields: src, dropped: [] };
  const fields = {};
  const dropped = [];
  const forbidden = [];
  for (const [k, v] of Object.entries(src)) {
    if (!isCostKey(objectKey, k)) fields[k] = v;
    else if (isBlankCost(v)) dropped.push(k);
    else forbidden.push(k);
  }
  if (forbidden.length) {
    return {
      ok: false,
      status: 403,
      code: COSTING_FORBIDDEN,
      message: `Only an Admin or Executive can set what an item costs (${forbidden.join(", ")}).`,
      fields: forbidden,
    };
  }
  return { ok: true, fields, dropped };
}
