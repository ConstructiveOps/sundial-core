// lib/sf-describe.js — the Salesforce describe, cached, and the picklist decoding built on
// it. Shared by sundial-sf-query and sundial-dealer (moved here from sundial-sf-query,
// 2026-10-23, dealer module step 3), so a picklist's values and its dependent map are
// decoded by ONE function wherever a page asks for them.
//
// Value-safety: never logs the access token.

import { getSalesforceToken } from "./salesforce.js";

const SF_API_VERSION = "v60.0";

// --- Salesforce describe (module-scope cached per object, WITH TTL) --------
// rawDescribeCache holds the FULL describe JSON (including each field's
// picklistValues). getQueryableFields derives its trimmed name/type list from
// the same cached describe, and the picklist metadata routes read picklistValues
// straight from it — so both paths share a single describe fetch per object.
//
// TTL (D-045): the describe reflects per-integration-user FLS and the field set.
// A warm container that cached an OLD describe would keep missing a newly-added
// field or a newly-FLS-granted field (matching the write Lambda's stale-describe
// bug — the Utility_Password__c report). A short TTL bounds staleness to minutes
// without a redeploy; a refresh also clears the derived trimmed-field cache so it
// rebuilds from the fresh describe. A 401 still forces an immediate refresh.
const DESCRIBE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const rawDescribeCache = new Map(); // sfObject -> { meta, at }
const describeCache = new Map(); // sfObject -> { fields:[{name,type}] } (derived)
export const EXCLUDED_FIELD_TYPES = new Set(["address", "location", "base64"]);

export async function getRawDescribe(sfObject) {
  const cached = rawDescribeCache.get(sfObject);
  if (cached && Date.now() - cached.at < DESCRIBE_TTL_MS) return cached.meta;

  async function run(forceRefresh) {
    const { access_token, instance_url } = await getSalesforceToken({
      forceRefresh,
    });
    const url = `${instance_url}/services/data/${SF_API_VERSION}/sobjects/${sfObject}/describe`;
    return fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
  }

  let resp = await run(false);
  if (resp.status === 401) resp = await run(true);
  if (!resp.ok) {
    throw new Error(`describe ${sfObject} failed (${resp.status})`);
  }

  const meta = await resp.json();
  rawDescribeCache.set(sfObject, { meta, at: Date.now() });
  // Invalidate the derived trimmed-field cache so it rebuilds from this fresh
  // describe (otherwise a newly-added field would still be missing from queries).
  describeCache.delete(sfObject);
  return meta;
}

// Returns ALL queryable fields (name/type) for the object — no arbitrary cap.
export async function getQueryableFields(sfObject) {
  if (describeCache.has(sfObject)) return describeCache.get(sfObject);

  const meta = await getRawDescribe(sfObject);
  const fields = (meta.fields || [])
    .filter((f) => !EXCLUDED_FIELD_TYPES.has(f.type))
    .map((f) => ({ name: f.name, type: f.type }));

  const result = { fields };
  describeCache.set(sfObject, result);
  return result;
}

// --- Dependent-picklist decoding --------------------------------------------
// validFor is a base64-encoded bitmap. Within each decoded byte the bits are
// packed MSB-first (big-endian bit order): controlling index i lives in
// byte (i >> 3), at bit mask (0x80 >> (i & 7)). The dependent value is valid for
// controlling index i exactly when that bit is set:
//     bytes[i >> 3] & (0x80 >> (i & 7))  !== 0
//
// Missing/empty validFor -> valid for NO controlling value (returns []). The
// controlling field's picklistValues order defines what each index means.
export function decodeValidForIndices(validFor) {
  if (!validFor) return []; // no bitmap -> valid for nothing
  let bytes;
  try {
    bytes = Buffer.from(validFor, "base64");
  } catch {
    return []; // unparseable -> treat as valid for nothing
  }
  const indices = [];
  const bitCount = bytes.length * 8;
  for (let i = 0; i < bitCount; i++) {
    if (bytes[i >> 3] & (0x80 >> (i & 7))) indices.push(i);
  }
  return indices;
}

// Build the normalized BATCH entry for one picklist/multipicklist field. For a
// dependent field whose controller is itself a picklist, returns the decoded
// controlling-value -> dependent-values map; otherwise controllingField and
// dependencies are null.
export function buildPicklistEntry(fieldDef, meta) {
  // Values in Salesforce-defined order (do NOT sort). Inactive values are
  // included but flagged active:false so the edit UI can show or hide them.
  const values = (fieldDef.picklistValues || []).map((pv) => ({
    label: pv.label,
    value: pv.value,
    active: pv.active === true,
    defaultValue: pv.defaultValue === true,
  }));

  let controllingField = null;
  let dependencies = null;

  const controllerName = fieldDef.controllerName || null;
  if (controllerName) {
    const controller = (meta.fields || []).find(
      (f) => f.name.toLowerCase() === controllerName.toLowerCase()
    );
    const controllerIsPicklist =
      !!controller &&
      (controller.type === "picklist" || controller.type === "multipicklist");

    if (controllerIsPicklist) {
      // Controlling field's picklistValues define the index order the validFor
      // bitmaps refer to. Index i == controllingValues[i].
      const controllingValues = (controller.picklistValues || []).map(
        (pv) => pv.value
      );
      const map = {};
      for (const cv of controllingValues) map[cv] = []; // seed groups in SF order
      for (const pv of fieldDef.picklistValues || []) {
        for (const i of decodeValidForIndices(pv.validFor)) {
          const cv = controllingValues[i];
          if (cv === undefined) continue; // bit past controlling range -> ignore
          map[cv].push({ label: pv.label, value: pv.value });
        }
      }
      controllingField = controller.name; // canonical API name
      dependencies = map;
    } else {
      // Controller exists but isn't a picklist (e.g. a checkbox). Expose the
      // controller name so the UI knows the field is dependent; no value map.
      controllingField = controller ? controller.name : controllerName;
      dependencies = null;
    }
  }

  return {
    type: fieldDef.type, // "picklist" | "multipicklist"
    controllingField, // null, or the controlling field API name if dependent
    values, // SF-defined order, includes active flag
    dependencies, // null, or { <controllingValue>: [ {label,value}, ... ], ... }
  };
}
