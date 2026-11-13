// lib/report-live-picklists.js — the reporting catalog's picklist values, read live (D-089 am. 2,
// 2026-11-13).
//
// WHY. lib/report-catalog/*.json is a snapshot of the describe taken when the catalog was
// generated. A value Tim adds in Salesforce Setup would otherwise not reach the filter pickers
// (GET /reports/catalog) or the report assistant's field list until the catalog is regenerated
// and sundial-reports redeployed. So at request time each picklist / multipicklist field's
// values are replaced by the LIVE describe's, through lib/sf-describe.js — the same 5-minute
// TTL cache the rest of the platform reads (D-045), and the same active-only rule the generator
// uses (activePicklistValues). This reads Salesforce METADATA only, never a record.
//
// WHAT CHANGES. Only `picklistValues` on a field whose catalog type is picklist / multipicklist.
// Types, gates, nameField, valuesLookup, labels, the field set: all still the generated catalog.
// A new FIELD still needs the generator (it needs a cache column and the SQL seed).
//
// THE FALLBACK. The describe fails, times out or lacks the field (or the field is no longer a
// picklist there) → that field keeps its generated values. Never a reason to fail a request.
//
// NEVER LOGGED: a value. A failure logs the object name and the error message.

import { CATALOG } from "./report-catalog/index.js";
import { getRawDescribe } from "./sf-describe.js";
import { activePicklistValues } from "./report-catalog-build.js";

const PICKLIST_TYPES = new Set(["picklist", "multipicklist"]);
export const DESCRIBE_TIMEOUT_MS = 3000;

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * One object's catalog with its picklist values taken from `meta` (a raw describe). PURE.
 * Returns the SAME object when nothing changed, so an unchanged catalog stays shared.
 */
export function overlayPicklists(objCatalog, meta) {
  if (!objCatalog || !Array.isArray(meta?.fields)) return objCatalog;
  const byName = new Map(meta.fields.map((f) => [String(f.name).toLowerCase(), f]));
  let changed = false;
  const fields = objCatalog.fields.map((entry) => {
    if (!PICKLIST_TYPES.has(entry.type) || !entry.sfField) return entry;
    const live = byName.get(entry.sfField.toLowerCase());
    if (!live || !PICKLIST_TYPES.has(live.type)) return entry; // not in the describe: keep the snapshot
    const values = activePicklistValues(live);
    if (sameList(values, entry.picklistValues ?? [])) return entry;
    changed = true;
    return { ...entry, picklistValues: values };
  });
  return changed ? { ...objCatalog, fields } : objCatalog;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The catalog with live picklist values for `objectKeys` (the other objects untouched).
 * `describe` is injectable for tests; it defaults to lib/sf-describe.js getRawDescribe.
 * Never throws: an object whose describe fails keeps its generated values.
 */
export async function liveCatalog(objectKeys, { catalog = CATALOG, describe = getRawDescribe, timeoutMs = DESCRIBE_TIMEOUT_MS, log = console } = {}) {
  const keys = [...new Set(objectKeys)].filter((k) => catalog[k]?.fields?.some((f) => PICKLIST_TYPES.has(f.type)));
  if (!keys.length) return catalog;
  const metas = await Promise.all(
    keys.map(async (k) => {
      try {
        return await withTimeout(Promise.resolve().then(() => describe(catalog[k].sfObject)), timeoutMs);
      } catch (e) {
        log?.warn?.(`reports: live picklists for ${catalog[k].sfObject} unavailable, using the generated values: ${e?.message || String(e)}`);
        return null;
      }
    }),
  );
  const out = { ...catalog };
  let changed = false;
  keys.forEach((k, i) => {
    if (!metas[i]) return;
    const next = overlayPicklists(catalog[k], metas[i]);
    if (next !== catalog[k]) {
      out[k] = next;
      changed = true;
    }
  });
  return changed ? Object.freeze(out) : catalog;
}
