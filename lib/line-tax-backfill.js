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

// --- --taxed-lines (2026-10-16, second pass) ------------------------------------------------------
// Before D-083 a TICKED material line was taxed only when the estimate also had a typed rate. With
// no rate the tick charged nothing, but D-083 reads the tick's blank category as RETAIL and taxes
// it at the zone's rate. The estimate's stored Tax_Amount__c says which case it was:
//   stored tax 0 / blank → the tick never charged anything → SOLAR
//   stored tax > 0       → left (RETAIL), and listed: the office compares the old typed rate with
//                          Acumatica's and decides.
// Invoiced estimates are never in this pass (they read their snapshot).

export const TAXED_PASS_STATUSES = Object.freeze(["Draft", "Sent", "Viewed", "Approved", "Declined", "Expired"]);

/**
 * Plan the ticked-material pass. Each row: a line with Kind__c, Taxable__c, Tax_Category__c and
 * Estimate__r { Id, Name, Status__c, Tax_Amount__c, Customer_Name_at_Creation__c,
 * Sundial_Customer__r { Name }, Service_Job__r { Archived__c } }.
 * @returns {{ writes, rows, keep: Array<{ estimateId, estimate, status, storedTax, lineCount, archived }>, byStatus, skipped }}
 *   keep = the estimates that stored tax, listed for the office (archived ones too, never written)
 */
export function planTaxedLineBackfill(lines) {
  const writes = [];
  const rows = [];
  const keepByEst = new Map();
  const byStatus = {};
  const skipped = { zz: 0, archivedJob: 0, otherStatus: 0, notTickedMaterial: 0 };
  for (const l of lines || []) {
    const est = l.Estimate__r || {};
    if (isZzName(est.Customer_Name_at_Creation__c, est.Sundial_Customer__r?.Name)) { skipped.zz += 1; continue; }
    if (!TAXED_PASS_STATUSES.includes(est.Status__c)) { skipped.otherStatus += 1; continue; }
    if (!MATERIAL_KINDS.includes(l.Kind__c) || l.Taxable__c !== true || String(l.Tax_Category__c ?? "").trim()) { skipped.notTickedMaterial += 1; continue; }
    const storedTax = Number(est.Tax_Amount__c) || 0;
    const archived = est.Service_Job__r?.Archived__c === true;
    if (archived) {
      // Never written; but one that stored tax is still LISTED (marked archived) for the office.
      skipped.archivedJob += 1;
      if (storedTax > 0) {
        const k = keepByEst.get(est.Id) || { estimateId: est.Id ?? null, estimate: est.Name ?? null, status: est.Status__c, storedTax, lineCount: 0, archived: true };
        k.lineCount += 1;
        keepByEst.set(est.Id, k);
      }
      continue;
    }
    const s = (byStatus[est.Status__c] ||= { write: 0, leave: 0 });
    if (storedTax > 0) {
      s.leave += 1;
      const k = keepByEst.get(est.Id) || { estimateId: est.Id ?? null, estimate: est.Name ?? null, status: est.Status__c, storedTax, lineCount: 0, archived: false };
      k.lineCount += 1;
      keepByEst.set(est.Id, k);
    } else {
      s.write += 1;
      writes.push({ Id: l.Id, Tax_Category__c: EXEMPT_CATEGORY });
      rows.push({ id: l.Id, estimate: est.Name ?? null, status: est.Status__c, description: l.Description__c ?? "" });
    }
  }
  const keep = [...keepByEst.values()].sort((a, b) => String(a.estimate).localeCompare(String(b.estimate)));
  return { writes, rows, keep, byStatus, skipped };
}
