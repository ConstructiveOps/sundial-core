// lib/soql-budget.js — how many Ids fit in one `Id IN (…)` SOQL (pure, no I/O).
//
// sfQuery sends the SOQL as a GET (`/services/data/v60.0/query?q=<encodeURIComponent(soql)>`)
// and Salesforce refuses a URI over 16,384 bytes. A fixed 200-Id chunk was fine while the
// cache tables were narrow; after R0 (D-087) solar's SELECT alone is ~14,000 bytes encoded,
// and 200 quoted Ids add ~6,000 more. So the chunk is sized from what is left of the budget
// for THIS query, measured with the same encoding sfQuery uses.

/** Salesforce's REST URI limit. */
export const MAX_SOQL_URI = 16384;
/** Headroom for anything we do not measure (host-independent, but be conservative). */
export const SOQL_URI_SAFETY_MARGIN = 256;
/** The path sfQuery puts in front of the SOQL (lib/salesforce.js SF_API_VERSION). */
export const SOQL_QUERY_PATH = "/services/data/v60.0/query?q=";
/** The separator between quoted Ids in the IN list. */
export const ID_SEPARATOR = ", ";

/** The URI length sfQuery would send for this SOQL. */
export function soqlUriLength(soql) {
  return SOQL_QUERY_PATH.length + encodeURIComponent(soql).length;
}

/**
 * Ids per query: max(1, floor((limit − URI with an empty IN list − margin) / one quoted Id + separator)),
 * capped at `max`. `buildSoql(inList)` must return the full SOQL for a given IN-list body;
 * `quotedIds` are the already-escaped, already-quoted Ids.
 */
export function idChunkSize(buildSoql, quotedIds, { max = 200 } = {}) {
  const base = soqlUriLength(buildSoql(""));
  // Encoded the same way as the real list: a quoted Id plus the separator before it. The
  // longest encoded Id is the one measured, so no chunk can come out longer than budgeted.
  const sample = quotedIds.length ? quotedIds : ["'000000000000000000'"];
  const perId = sample.reduce((m, q) => Math.max(m, encodeURIComponent(ID_SEPARATOR + q).length), 0);
  const fit = Math.floor((MAX_SOQL_URI - base - SOQL_URI_SAFETY_MARGIN) / perId);
  return Math.min(max, Math.max(1, fit));
}

/**
 * The SOQL statements for a list of quoted Ids, each within the URI budget.
 * @returns {string[]}
 */
export function buildIdChunkQueries(buildSoql, quotedIds, opts) {
  const size = idChunkSize(buildSoql, quotedIds, opts);
  const out = [];
  for (let i = 0; i < quotedIds.length; i += size) {
    out.push(buildSoql(quotedIds.slice(i, i + size).join(ID_SEPARATOR)));
  }
  return out;
}
