// The decision table for scripts/backfill-line-tax-categories.mjs (2026-10-16).
//
// D-083 made a blank Tax_Category__c on a Material / Product line mean RETAIL, so every material
// line Harmon had left untaxed (Taxable__c off) started being taxed. This restores the pre-D-083
// numbers by making the old choice explicit: an untaxed blank material becomes SOLAR (Acumatica's
// exempt-materials category); a taxed one stays blank (its RETAIL default is what was charged).
// Labor / Fee are never written: their default (LABSERV) was already untaxed.
//
// Pure: no Salesforce here, so the table is tested on its own (line-tax-backfill.test.js).

import { validTaxCategory } from "./tax-zones.js";

export const MATERIAL_KINDS = Object.freeze(["Material", "Product"]);
export const EXEMPT_CATEGORY = "SOLAR";

/**
 * What to do with one line or price-book item.
 * @param {{ kind?: string|null, taxable?: boolean|null, taxCategory?: string|null }} r
 * @returns {{ write: string|null, reason: string }} write = the category to set, null = leave
 */
export function lineCategoryDecision({ kind, taxable, taxCategory } = {}) {
  if (validTaxCategory(taxCategory)) return { write: null, reason: "explicit category" };
  if (String(taxCategory ?? "").trim()) return { write: null, reason: "unknown category (left for a person)" };
  if (!MATERIAL_KINDS.includes(kind)) return { write: null, reason: "labor / fee default (LABSERV, untaxed)" };
  if (taxable === true) return { write: null, reason: "material, was taxed (RETAIL default)" };
  return { write: EXEMPT_CATEGORY, reason: "material, was untaxed → SOLAR" };
}

/** A ZZ test record (ZZ PORTAL TEST, ZZZ Test …): never touched by a bulk fix. */
export function isZzName(...names) {
  return names.some((n) => /^\s*zz/i.test(String(n ?? "")));
}

/**
 * Plan the line writes. Each row: the Sundial_Service_Line__c with Estimate__r { Status__c,
 * Customer_Name_at_Creation__c, Sundial_Customer__r { Name }, Service_Job__r { Archived__c } }.
 * @returns {{ writes: Array<{ Id, Tax_Category__c }>, rows: Array, byStatus: object, skipped: object, leave: object }}
 */
export function planLineBackfill(lines) {
  const writes = [];
  const rows = [];
  const byStatus = {};
  const skipped = { zz: 0, archivedJob: 0 };
  const leave = {};
  for (const l of lines || []) {
    const est = l.Estimate__r || {};
    if (isZzName(est.Customer_Name_at_Creation__c, est.Sundial_Customer__r?.Name)) { skipped.zz += 1; continue; }
    if (est.Service_Job__r?.Archived__c === true) { skipped.archivedJob += 1; continue; }
    const status = est.Status__c || "(no status)";
    const s = (byStatus[status] ||= { write: 0, leave: 0 });
    const d = lineCategoryDecision({ kind: l.Kind__c, taxable: l.Taxable__c, taxCategory: l.Tax_Category__c });
    if (d.write) {
      s.write += 1;
      writes.push({ Id: l.Id, Tax_Category__c: d.write });
      rows.push({ id: l.Id, estimate: est.Name ?? null, status, kind: l.Kind__c ?? null, description: l.Description__c ?? "", category: d.write });
    } else {
      s.leave += 1;
      leave[d.reason] = (leave[d.reason] || 0) + 1;
    }
  }
  return { writes, rows, byStatus, skipped, leave };
}

/** Plan the price-book writes (every version, active or not, so re-adding an item never re-taxes). */
export function planItemBackfill(items) {
  const writes = [];
  const rows = [];
  const skipped = { zz: 0 };
  const leave = {};
  for (const it of items || []) {
    if (isZzName(it.Name, it.Item_Code__c)) { skipped.zz += 1; continue; }
    const d = lineCategoryDecision({ kind: it.Kind__c, taxable: it.Taxable__c, taxCategory: it.Tax_Category__c });
    if (d.write) {
      writes.push({ Id: it.Id, Tax_Category__c: d.write });
      rows.push({ id: it.Id, code: it.Item_Code__c ?? null, name: it.Name ?? "", active: it.Is_Active__c === true, category: d.write });
    } else leave[d.reason] = (leave[d.reason] || 0) + 1;
  }
  return { writes, rows, skipped, leave };
}

/** Split into ≤ size chunks (the collection API's 200). */
export function chunk(list, size = 200) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
