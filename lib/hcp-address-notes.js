// lib/hcp-address-notes.js — Housecall Pro's "Address Notes" into the Customer's Warranty
// Notes (2026-10-07; Harmon's ask, docs/migration.md → "Address Notes").
//
// WHY A SEPARATE PASS. HCP keeps two notes on a customer. The customer-level Notes came
// through the public API (`customer.notes`, 8,664 of 9,524 customers) and the import put it
// in `Sundial_Customer__c.Description__c`. "Address Notes" is a different field, one per
// ADDRESS (the Edit Address dialog: Street / Unit / City / State / Zip / Address Notes), and
// the public API never returns it — every `customer.addresses[]` row in the pull has exactly
// id / type / street / street_line_2 / city / state / zip / country / latitude / longitude.
// The signed-in web app does return it (`GET /api/customers/{cus}/addresses`, each row with
// `notes`; reconnaissance on Ben's session 2026-10-07: 4 of 40 sampled customers had one,
// 23–78 characters — gate codes, access instructions). So this is a targeted backfill into
// `Warranty_Notes__c` (Tim's Setup field, D-081; the Service customer header's highlight and
// an Intake question), never a re-import.
//
// Pure: the text rule and the write rule take plain values, so the tests need no I/O. The
// script (`scripts/hcp-address-notes.mjs`) does the fetching and the writing.

export const WARRANTY_NOTES_FIELD = "Warranty_Notes__c";
/** Salesforce Long Text Area(32768) — never send more. */
export const WARRANTY_NOTES_MAX = 32768;

const s = (v) => (v == null ? "" : String(v).trim());
/** Whitespace-insensitive, case-insensitive — "already there" must survive a retyped space or a CRLF. */
const norm = (v) => s(v).toLowerCase().replace(/\s+/g, " ");

/**
 * One text for the customer from its addresses' notes. One noted address → its notes as
 * typed. Several → one line per address, headed by the street (unit appended), so the
 * office can tell which gate code goes with which property. Addresses without notes
 * contribute nothing; no notes anywhere → "".
 */
export function addressNotesText(addresses) {
  const noted = (addresses || []).filter((a) => s(a?.notes));
  if (!noted.length) return "";
  if (noted.length === 1) return s(noted[0].notes);
  return noted
    .map((a) => {
      const where = [s(a.street), s(a.unit)].filter(Boolean).join(" ") || s(a.city) || "Address";
      return `${where}: ${s(a.notes)}`;
    })
    .join("\n");
}

/**
 * What to write on one customer. `existing` is the field's current value.
 *   skip-empty    HCP has no address notes for this customer
 *   skip-present  the text is already in the field (a re-run, or the office typed it)
 *   set           the field is blank → the text
 *   append        the field has other text → kept, a blank line, then the text
 * Returns { action, value } — `value` only for set / append.
 */
export function planWarrantyNotes(existing, text) {
  const t = s(text);
  if (!t) return { action: "skip-empty" };
  const cur = s(existing);
  if (!cur) return { action: "set", value: t.slice(0, WARRANTY_NOTES_MAX) };
  if (norm(cur).includes(norm(t))) return { action: "skip-present" };
  const joined = `${cur}\n\n${t}`;
  if (joined.length > WARRANTY_NOTES_MAX) return { action: "skip-too-long" };
  return { action: "append", value: joined };
}

/** A CSV cell, Excel-safe. */
export function csvCell(v) {
  const str = v == null ? "" : String(v);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
