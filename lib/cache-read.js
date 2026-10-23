// lib/cache-read.js — the Supabase-cache read helpers shared by sundial-sf-query and
// sundial-dealer (moved here from sundial-sf-query/index.js, 2026-10-23, dealer module
// step 3). One copy, so the dealer shell's list and the Sales list cannot disagree about
// search, paging, the row filter's composition or what a list row carries.
//
//   search      sanitizeSearchTerm · phonePattern · searchWords · searchOrExpr
//   access      applyEnforceToQuery (the D-064 row filter on a PostgREST builder)
//   paging      fetchCacheRange (splits past PostgREST's Max Rows ceiling)
//   rows        buildListSelect · projectListRow (the 6 MB payload rules)
//   schema      getCacheColumns (the cache table's columns, from PostgREST's OpenAPI)
//
// The WHY of each rule lives beside it, unchanged from where it was written.
//
// Value-safety: never logs keys or row data.

import { getSupabaseConfig } from "./supabase.js";

// --- Server-side search (?q=) ------------------------------------------------

// Sanitize a raw ?q= term. Returns a cleaned term (>= 2 chars) or null. Escapes by
// RESTRICTING to name-safe characters — drops every ILIKE/SOQL metacharacter
// (% _ " ( ) , \ / etc.), so neither an ILIKE wildcard nor a SOQL/PostgREST break
// can be injected. Apostrophe is KEPT (O'Brien) and is escaped per-path: SOQL via
// soqlEscapeString, and the cache path double-quotes the ILIKE value.
export function sanitizeSearchTerm(q) {
  if (q == null) return null;
  // `@` `+` `_` `#` `/` stay (an email, a "+1" phone, a unit number); the PostgREST
  // reserved characters (quotes, commas, parentheses, backslash) and everything else
  // become spaces. Before 2026-09-29 `@` was stripped too, which is why an email
  // address never matched anything.
  const cleaned = String(q)
    .replace(/[^A-Za-z0-9 .&'@+_#/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}

/**
 * A phone typed any which way → an ILIKE pattern over the digits (2026-09-29):
 * "(602) 555-0100", "602.555.0100", "6025550100", "+1 602 555 0100" all become
 * "%602%555%0100%", which matches however the number was stored. Seven digits (no
 * area code) → "%555%0100%". Fewer than seven digits, or mostly letters → null.
 */
export function phonePattern(term) {
  const raw = String(term ?? "");
  const digits = raw.replace(/\D/g, "");
  const letters = raw.replace(/[^A-Za-z]/g, "");
  if (digits.length < 7 || letters.length > 1) return null;
  const d = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (d.length === 10) return `%${d.slice(0, 3)}%${d.slice(3, 6)}%${d.slice(6)}%`;
  if (d.length === 7) return `%${d.slice(0, 3)}%${d.slice(3)}%`;
  const chunks = [];
  for (let i = 0; i < d.length; i += 3) chunks.push(d.slice(i, i + 3));
  return `%${chunks.join("%")}%`;
}

/**
 * The words of a search, each one to be matched on its own (2026-10-07, Harmon: "search
 * misses customers / jobs for an address"). "123 Main St Phoenix" used to be matched as
 * ONE substring, which no customer row holds (street and city are separate columns) and
 * no job row holds either (its address snapshot has commas: "123 Main St, Phoenix, AZ").
 * Now every word must appear in SOME searchable column: "123" in the street, "Phoenix"
 * in the city. One-character words are noise ("N" in "123 N Main") and are dropped; at
 * most 6 words count.
 */
export const SEARCH_MAX_WORDS = 6;
export function searchWords(term) {
  const words = String(term ?? "").split(" ").map((w) => w.trim()).filter((w) => w.length >= 2);
  return (words.length ? words : [String(term ?? "").trim()].filter(Boolean)).slice(0, SEARCH_MAX_WORDS);
}

/**
 * The PostgREST filter for a search: EVERY word ILIKE SOME column, OR (when the whole
 * term reads as a phone number) a phone column ILIKE the digit pattern. One word is the
 * flat OR-group it always was; the phone alternative sits beside the word group so
 * "(602) 555-0100" — which splits into "602" and "555-0100" — still finds a number
 * stored as "6025550100".
 */
export function searchOrExpr(cols, term, phoneCols = []) {
  const words = searchWords(term);
  const wordGroup = (w) => cols.map((c) => `${c}.ilike."%${w}%"`).join(",");
  const phone = phonePattern(term);
  const phoneParts = phone ? phoneCols.filter((c) => cols.includes(c)).map((c) => `${c}.ilike."${phone}"`) : [];
  if (words.length <= 1) return [wordGroup(words[0] ?? term), ...phoneParts].join(",");
  const all = `and(${words.map((w) => `or(${wordGroup(w)})`).join(",")})`;
  return [all, ...phoneParts].join(",");
}

// Per object: the cache columns the ?q= search ILIKEs (cache[]), the phone columns matched on
// digits (phone[]), and the equivalent Salesforce fields for the live SOQL path (sf[]).
// Only allowlisted here; anything else (po/user) has no name search.
// Phone / email / address columns joined the search on 2026-09-29 (Harmon: "we can only
// find people by name"). Phone columns are matched on DIGITS when the term looks like a
// number (see phonePattern) so "602-555-0100" finds "(602) 555-0100".
export const SEARCH_FIELDS = {
  customer: {
    // company_name (D-081, 2026-10-07): the Bill To picker finds "SunRun" by its company name.
    cache: ["first_name", "last_name", "name", "company_name", "primary_email", "primary_phone", "alternate_contact_phone", "alternate_contact_email", "street", "city", "postal_code"],
    phone: ["primary_phone", "alternate_contact_phone"],
    sf: ["First_Name__c", "Last_Name__c", "Name", "Company_Name__c", "Primary_Email__c", "Primary_Phone__c", "Alternate_Contact_Phone__c", "Alternate_Contact_Email__c", "Street__c", "City__c", "Postal_Code__c"],
  },
  // Solar / roofing search the address, phone and email snapshots too (2026-10-07 — the
  // placeholder promised "Project, Customer, or Address"); a column the cache lacks is skipped.
  solar: {
    cache: ["project_name", "customer_name_at_creation", "first_name", "last_name", "address_at_creation", "address", "primary_phone_at_creation", "primary_email_at_creation"],
    phone: ["primary_phone_at_creation"],
    sf: ["Project_Name__c", "Customer_Name_at_Creation__c", "Address_at_Creation__c", "Primary_Phone_at_Creation__c", "Primary_Email_at_Creation__c"],
  },
  roofing: {
    cache: ["project_name", "customer_name_at_creation", "first_name", "last_name", "address_at_creation", "primary_phone_at_creation", "primary_email_at_creation"],
    phone: ["primary_phone_at_creation"],
    sf: ["Project_Name__c", "Customer_Name_at_Creation__c", "Address_at_Creation__c", "Primary_Phone_at_Creation__c", "Primary_Email_at_Creation__c"], // rep path unused for roofing
  },
  // Service (D-072). Jobs search by job number, customer snapshot, AND the partner's
  // work-order number - "SunRun calls with THEIR number" is a named requirement
  // (Billing_Reference__c is an External ID for the same reason). Estimates add the
  // template name so the template picker is a search; the price book searches
  // name + item code + description.
  // D-081 amendment 2 (2026-10-16): an estimate is found by its payer's name too, as an invoice is.
  estimate: {
    cache: ["name", "customer_name_at_creation", "template_name", "address_at_creation", "primary_phone_at_creation", "primary_email_at_creation", "bill_to_name"],
    phone: ["primary_phone_at_creation"],
    sf: ["Name", "Customer_Name_at_Creation__c", "Template_Name__c", "Address_at_Creation__c", "Primary_Phone_at_Creation__c", "Primary_Email_at_Creation__c", "Bill_To_Name__c"],
  },
  job: {
    cache: ["name", "customer_name_at_creation", "billing_reference", "address_at_creation", "primary_phone_at_creation", "primary_email_at_creation"],
    phone: ["primary_phone_at_creation"],
    sf: ["Name", "Customer_Name_at_Creation__c", "Billing_Reference__c", "Address_at_Creation__c", "Primary_Phone_at_Creation__c", "Primary_Email_at_Creation__c"],
  },
  pricebookitem: {
    cache: ["name", "item_code", "description"],
    sf: ["Name", "Item_Code__c", "Description__c"],
  },
  serviceinvoice: {
    cache: ["name", "billing_reference", "bill_to_name", "customer_name_at_creation"],
    sf: ["Name", "Billing_Reference__c", "Bill_To_Name__c"],
  },
  servicepayment: {
    cache: ["name", "reference"],
    sf: ["Name", "Reference__c"],
  },
  serviceplan: {
    cache: ["name", "plan_code"],
    sf: ["Name", "Plan_Code__c"],
  },
  membership: {
    cache: ["name", "customer_name_at_creation", "primary_email_at_creation"],
    sf: ["Name", "Customer_Name_at_Creation__c", "Primary_Email_at_Creation__c"],
  },
};

// --- The row filter on a PostgREST builder (D-064) ----------------------------

/**
 * Apply a resolved row filter (lib/access.js rowFilter / userFilter) to a PostgREST
 * query builder. Both halves, always: dropping the or-group would hand a dealer their
 * own people and hide every Harmon employee.
 *
 * `enforce` null (or a denial, which the caller has already refused) changes nothing.
 * ⚠️ Call it FIRST, before any caller filter: every request input is then ANDed after
 * it and none can reach inside the conjunction.
 */
export function applyEnforceToQuery(q, enforce) {
  if (!enforce || enforce.deny) return q;
  for (const { column, value } of enforce.cache) q = q.eq(column, value);
  if (enforce.cacheOr) q = q.or(enforce.cacheOr);
  return q;
}

// --- Paging past PostgREST's Max Rows ------------------------------------------

// PostgREST (Supabase) enforces a per-request row ceiling — the project's "Max
// Rows" API setting, 1000 by default — and SILENTLY TRUNCATES past it: a request
// for 5000 rows comes back 206 with 1000 rows and no error. fetchCacheRange() below
// splits any read larger than this into consecutive .range() sub-requests, so a
// caller gets the full page whatever the dashboard setting happens to be.
export const POSTGREST_PAGE_SIZE = 1000;

// Read `limit` rows starting at `offset` from a cache table, transparently
// splitting the read into POSTGREST_PAGE_SIZE-sized .range() sub-requests so the
// caller always gets the page size it asked for.
//
// `makeQuery(withCount)` must return a FRESH query builder each call — a
// supabase-js builder is single-use — with all filters/ordering applied but NO
// .range(). The exact `total` is requested on the FIRST sub-request only: it is a
// separate server-side COUNT, so asking for it once per sub-request would multiply
// the cost for a number that cannot change within one read.
//
// Stops early when a sub-request returns fewer rows than asked (end of data), and
// surfaces the first error rather than a partial page.
export async function fetchCacheRange(makeQuery, offset, limit) {
  const rows = [];
  let total = null;
  let start = offset;
  let remaining = limit;
  let first = true;

  while (remaining > 0) {
    const take = Math.min(remaining, POSTGREST_PAGE_SIZE);
    const { data, count, error } = await makeQuery(first).range(
      start,
      start + take - 1
    );
    if (error) return { rows, total, error };
    if (first && count != null) total = count;

    const batch = data || [];
    rows.push(...batch);
    first = false;

    // Short read == no more matching rows past this point.
    if (batch.length < take) break;
    start += batch.length;
    remaining -= batch.length;
  }

  return { rows, total, error: null };
}

// --- LIST/SEARCH response projection (6 MB Lambda payload cap) -------------
// Lambda hard-caps a response payload at 6,291,556 bytes. Past it the runtime
// never delivers the response at all — it logs
//   LAMBDA_RUNTIME Failed to post handler success response. Http response code: 413.
//   {"errorType":"RequestEntityTooLarge"}
// and API Gateway turns that into a 502. Note the cap applies to the SERIALIZED
// RESPONSE OBJECT, not the body string: the body is a JSON string nested inside
// {statusCode, headers, body}, so every quote in it is escaped a second time.
// Measured on solar, that envelope adds ~9% on top of the body.
//
// Two reductions are applied to LIST and SEARCH rows only. Neither touches the
// single-record read (the detail view legitimately needs every column) or the
// live-Salesforce fallback paths.
//
// 1. Drop long-text columns (below). Cheap, but small: `notes` is only ~1.4% of
//    the solar payload.
// 2. Drop NULL-valued keys. This is the one that matters — 34.8% of the solar
//    payload was `"column":null` spelled out for absent values. Measured, solar
//    limit=5000: 6.14 MB payload (413) -> 4.04 MB. Dropping long text ALONE lands
//    at 6.02 MB, still over the 6.00 MB cap, so it does not fix this on its own.
//
// Omitting nulls is safe because an absent key and a null key behave identically
// under `??`, `||` and optional chaining. (Until 2026-10-14 mapSfRecordToCacheRow
// also skipped nulls — which is why a field cleared in Salesforce never cleared in
// the cache. It now writes them; this projection still drops them from the RESPONSE
// only, never from what is written to the cache.)
//
// The projection is applied ONLY when building the response array — never to the
// rows the freshness partition reads, and never to what is written back to the
// cache, so `notes` stays cached and intact for the detail view.
export const LIST_CONTROL_COLUMNS = [
  "sf_id",
  "client_sf_id",
  "tenant_id",
  "created_date",
  "last_synced_at",
  "is_stale",
  "cache_version",
];

// A long-text column the list/board/filter UIs never read. Verified against the
// harmon-crm frontend: the only `notes` references live in the DETAIL configs
// (customer-detail-config.ts / solar-detail-config.ts) and SolarProjectDetailPage,
// all of which read the single-record or ?full=true path — not the list.
// Re-check that grep before widening this rule.
export function isExcludedListColumn(col) {
  if (LIST_CONTROL_COLUMNS.includes(col)) return false; // control columns are never dropped
  return col === "notes" || col.endsWith("_notes") || col.includes("findings");
}

// Explicit PostgREST select list for LIST/SEARCH reads: every cache column except
// the excluded long-text ones. Falls back to "*" when column introspection came
// back empty, so a failed OpenAPI fetch degrades to today's behavior rather than
// selecting nothing.
export function buildListSelect(columnSet) {
  if (!columnSet || columnSet.size === 0) return "*";
  const cols = [];
  for (const col of columnSet) {
    if (!isExcludedListColumn(col)) cols.push(col);
  }
  // Belt-and-braces: guarantee the control columns the freshness partition and
  // pagination depend on are present even if the exclusion rule ever changes.
  for (const c of LIST_CONTROL_COLUMNS) {
    if (columnSet.has(c) && !cols.includes(c)) cols.push(c);
  }
  return cols.length > 0 ? cols.join(",") : "*";
}

// Project ONE row for a list/search response: drop nulls and any excluded column.
// Refreshed rows are re-checked for excluded columns because they are built from
// Salesforce by mapSfRecordToCacheRow (which knows nothing about this projection)
// rather than read through buildListSelect.
export function projectListRow(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (value === null || value === undefined) continue;
    if (isExcludedListColumn(key)) continue;
    out[key] = value;
  }
  return out;
}

// --- Cache column introspection (module-scope cached) ----------------------
// A view (sundial_dealer_customer_view) is described in the same OpenAPI document as a
// table, so this answers for both.
let openApiSpecPromise = null;
async function getOpenApiSpec() {
  if (!openApiSpecPromise) {
    openApiSpecPromise = (async () => {
      const cfg = await getSupabaseConfig();
      const resp = await fetch(`${cfg.url}/rest/v1/`, {
        headers: {
          apikey: cfg.serviceRoleKey,
          Authorization: `Bearer ${cfg.serviceRoleKey}`,
        },
      });
      if (!resp.ok) throw new Error(`OpenAPI fetch failed (${resp.status})`);
      return resp.json();
    })();
  }
  return openApiSpecPromise;
}

const cacheColumnsCache = new Map();
export async function getCacheColumns(table) {
  if (cacheColumnsCache.has(table)) return cacheColumnsCache.get(table);
  const spec = await getOpenApiSpec();
  const def = spec?.definitions?.[table] || spec?.components?.schemas?.[table];
  const cols = new Set(def?.properties ? Object.keys(def.properties) : []);
  cacheColumnsCache.set(table, cols);
  return cols;
}
