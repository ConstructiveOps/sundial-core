// sundial-sf-query — cache-first, tenant-isolated read Lambda.
//
// Handles:
//   GET /sf/{object}                        -> LIST read (tenant-scoped)
//   GET /sf/{object}/{id}                   -> SINGLE-RECORD read (tenant-scoped);
//                                              ?full=true bypasses the cache and
//                                              returns ALL queryable fields live
//                                              from Salesforce (detail view)
//   GET /sf/meta/{object}/picklist/{field}  -> PICKLIST metadata read (org-wide)
//
// CORE ISOLATION GUARANTEE: the tenant is derived ONLY from the verified token
// (resolveIdentity -> tenantId = Salesforce Client record id). No request input
// (query string, path, body, header) can set or override the tenant. Every cache
// query filters client_sf_id = tenantId; every Salesforce record query filters
// Client__c = '<escaped tenantId>'.
//
// The picklist metadata route is the ONE deliberate exception to tenant scoping:
// a field's picklist definition is org-wide (part of the Salesforce describe),
// identical for every tenant, and carries no record data. It still requires a
// valid token; it simply has no Client__c filter to apply. See handlePicklistRead.
//
// Value-safety: never logs or returns tokens, secrets, or key material.
//
// See docs/api-endpoints.md (GET /sf/{object}, GET /sf/{object}/{id},
// GET /sf/meta/{object}/picklist/{field}).

import {
  getSalesforceToken,
  sfQuery,
  soqlEscapeString,
} from "../../lib/salesforce.js";
import { resolveIdentity } from "../../lib/identity.js";
import { getSupabaseClient, getSupabaseConfig } from "../../lib/supabase.js";

// --- Object allowlist (the security spine) ---------------------------------
// The {object} path param is one of these short keys. Anything else => 400.
// A caller can never reach a Salesforce object / cache table outside this map.
const OBJECT_ALLOWLIST = {
  solar: { sfObject: "Sundial_Solar__c", cacheTable: "sundial_solar_cache" },
  customer: {
    sfObject: "Sundial_Customer__c",
    cacheTable: "sundial_customer_cache",
  },
  roofing: { sfObject: "Sundial_Roofing__c", cacheTable: "sundial_roofing_cache" },
  po: { sfObject: "Sundial_PO__c", cacheTable: "sundial_po_cache" },
  user: { sfObject: "Sundial_User__c", cacheTable: "sundial_user_cache" },
};

const SF_API_VERSION = "v60.0";

// Ordered source fields that populate each object's `created_date` cache column —
// the list-ordering key (newest first). FIRST non-empty value wins (a COALESCE):
// Solar prefers Contract_Date__c, falling back to CreatedDate; others use the
// standard CreatedDate. Mirrors sundial-cache-sync. Only used when the cache table
// has a `created_date` column.
const CREATED_DATE_SOURCE = {
  solar: ["Sunbase_Created_Date__c", "Contract_Date__c", "CreatedDate"],
  // CUSTOMER list/board orders by MOST-RECENTLY-UPDATED (Harmon's daily working
  // set at the top). Sunbase_Last_Updated__c is the migrated Sunbase mod-date;
  // falls back to the created date, then CreatedDate, for the ~266 rows without one.
  customer: ["Sunbase_Last_Updated__c", "Sunbase_Created_Date__c", "CreatedDate"],
  roofing: ["CreatedDate"],
  po: ["CreatedDate"],
  user: ["CreatedDate"],
};
const DEFAULT_CREATED_DATE_SOURCE = ["CreatedDate"];

// ===========================================================================
// TEMP — Sales Rep hard-restrict (remove when the per-user visibility feature
// ships; see TASKS.md "Sales Rep visibility"). Harmon has exactly ONE Sales Rep,
// Dennis Alessandro. Until proper visibility lands, a caller whose
// Hierarchy_Level__c === "Sales Rep" is server-side limited to Dennis's own
// records, filtered on the AUTHORITATIVE Salesforce rep field.
//
// The authoritative field is NOT in the cache (the cache's `sales_rep_name` is a
// different, formula-derived field that is blank/other for Dennis's 3,511
// customers), so a restricted rep's list + single + full reads BYPASS the cache
// and query Salesforce live. Only `customer` and `solar` are gated (see note in
// TASKS.md re: roofing). No other role is affected.
const TEMP_SALES_REP_HIERARCHY = "Sales Rep";
const TEMP_SALES_REP_NAME = "Dennis Alessandro";
const TEMP_SALES_REP_FIELD = {
  customer: "Sunbase_Sales_Rep__c",
  solar: "Sales_Representative__c",
};
// Returns { sfField, value } when the caller is the restricted Sales Rep AND this
// object is gated; else null (no restriction). Because Harmon has a single rep,
// the rep NAME is hardcoded rather than read from the user record.
function repRestrictFor(objectKey, identity) {
  if (identity?.user?.hierarchyLevel !== TEMP_SALES_REP_HIERARCHY) return null;
  const sfField = TEMP_SALES_REP_FIELD[objectKey];
  if (!sfField) return null; // roofing/po/user not gated by this temp guard
  return { sfField, value: TEMP_SALES_REP_NAME };
}

// --- Server-side search (?q=) ----------------------------------------------
// Case-insensitive substring across an object's name columns, tenant-scoped,
// capped at SEARCH_CAP results (the response still carries the FULL match total).
// cache[] = cache columns for the cache-path ILIKE; sf[] = the equivalent
// Salesforce fields for the Sales-Rep live path. Only allowlisted here; anything
// else (po/user) has no name search.
const SEARCH_CAP = 200;
const SEARCH_FIELDS = {
  customer: {
    cache: ["first_name", "last_name", "name", "customer_name"],
    sf: ["First_Name__c", "Last_Name__c", "Name"],
  },
  solar: {
    cache: ["project_name", "customer_name_at_creation"],
    sf: ["Project_Name__c", "Customer_Name_at_Creation__c"],
  },
  roofing: {
    cache: ["project_name", "customer_name_at_creation"],
    sf: ["Project_Name__c", "Customer_Name_at_Creation__c"], // rep path unused for roofing
  },
};

// Sanitize a raw ?q= term. Returns a cleaned term (>= 2 chars) or null. Escapes by
// RESTRICTING to name-safe characters — drops every ILIKE/SOQL metacharacter
// (% _ " ( ) , \ / etc.), so neither an ILIKE wildcard nor a SOQL/PostgREST break
// can be injected. Apostrophe is KEPT (O'Brien) and is escaped per-path: SOQL via
// soqlEscapeString, and the cache path double-quotes the ILIKE value.
function sanitizeSearchTerm(q) {
  if (q == null) return null;
  const cleaned = String(q)
    .replace(/[^A-Za-z0-9 .&'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}

// First non-empty source value for a record (the COALESCE), or null.
function resolveCreatedDate(record, sources) {
  for (const name of sources || []) {
    const v = record[name];
    if (v != null && v !== "") return v;
  }
  return null;
}

// List pagination. The client sends ?limit= & ?offset= (both optional). limit is
// the PAGE SIZE (not a cap on the dataset) — real server-side paging returns a
// `total` so the frontend can render a pager / load-more. MAX_LIMIT bounds any
// single page so a caller can't ask for the whole 32k-row table in one request
// (that's what paging is for).
//
// WHY 5000 (G2): the old 500-row cap forced the frontend into 64 sequential round
// trips to sweep the 31.6k-row customer set. Under a paged burst that pushed the
// account past its Lambda concurrency ceiling and requests were throttled into
// 500s (see HARMON_PHASE1_PUNCHLIST.md G2). At 5000/page the same sweep is 7
// requests. 5000 rows of the customer cache is ~4.3 MB of JSON — inside Lambda's
// 6 MB response limit, which is the real ceiling on how far this can be raised.
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

// The LIVE-Salesforce list path (listColdCacheFallback: cold cache, and the TEMP
// Sales-Rep restrict) keeps the ORIGINAL 500 cap. SOQL has its own paging limits
// (OFFSET is hard-capped at 2000) and that path writes every row it returns into
// the cache, so the raised cap is deliberately CACHE-PATH ONLY.
const SF_LIVE_MAX_LIMIT = 500;

// PostgREST (Supabase) enforces a per-request row ceiling — the project's "Max
// Rows" API setting, 1000 by default — and SILENTLY TRUNCATES past it: a request
// for 5000 rows comes back 206 with 1000 rows and no error. Raising our own
// MAX_LIMIT alone would therefore have shipped a page size the cache layer quietly
// ignored. fetchCacheRange() below splits any read larger than this into
// consecutive .range() sub-requests, so the endpoint returns the full page whatever
// the dashboard setting happens to be. Raising "Max Rows" in the Supabase dashboard
// collapses this back to a single round trip; it does not change correctness.
const POSTGREST_PAGE_SIZE = 1000;

// --- Read-time cache freshness ---------------------------------------------
// A cache row is trustworthy on read only if BOTH: is_stale is false/null AND it
// was synced within this TTL window. A row failing EITHER is refreshed from
// Salesforce on read (see isRowFresh). Change this one constant to tune staleness.
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Max record Ids per SOQL IN() when surgically re-fetching stale rows. Beyond
// this we chunk into multiple queries (a single IN is fine at current volumes).
const REFETCH_ID_CHUNK_SIZE = 200;
// Some Sundial objects have hundreds of fields (Sundial_Solar__c has ~270) —
// far more than any cache table stores. We do NOT select an arbitrary slice.
// An earlier build capped the SELECT at the first 100 describe-order fields,
// which silently dropped Stage__c (and every other field past that point) from
// the query, so the cache's `stage` column was never written -> null. Instead
// we now SELECT exactly the fields whose mapped cache column EXISTS (plus Id and
// Client__c). See buildCacheSelect. This tracks the cache schema, so nothing the
// cache can store is ever truncated, and it stays small regardless of object width.

// --- CORS (mirrors auth-proxy) ---------------------------------------------
const STATIC_ALLOWED_ORIGINS = new Set(["http://localhost:5173"]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (STATIC_ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const u = new URL(origin);
    if (
      u.protocol === "https:" &&
      (u.hostname === "vercel.app" || u.hostname.endsWith(".vercel.app"))
    ) {
      return true;
    }
  } catch {
    /* not parseable -> disallowed */
  }
  return false;
}

function corsHeaders(origin) {
  const allowOrigin = isAllowedOrigin(origin) ? origin : "http://localhost:5173";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    Vary: "Origin",
  };
}

function normalizeHeaders(rawHeaders) {
  const out = {};
  if (rawHeaders && typeof rawHeaders === "object") {
    for (const [k, v] of Object.entries(rawHeaders)) out[k.toLowerCase()] = v;
  }
  return out;
}

function jsonResponse(statusCode, cors, bodyObj) {
  return {
    statusCode,
    headers: { ...cors, "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  };
}

// Same identity-error -> HTTP mapping auth-proxy uses.
function mapIdentityError(code) {
  switch (code) {
    case "AUTH_NO_TOKEN":
    case "AUTH_INVALID_TOKEN":
      return { status: 401, body: { error: "unauthorized", code } };
    case "NO_SUNDIAL_USER":
      return {
        status: 403,
        body: { error: "no_portal_user", code: "NO_SUNDIAL_USER" },
      };
    case "USER_INACTIVE":
      return {
        status: 403,
        body: { error: "inactive_user", code: "USER_INACTIVE" },
      };
    default:
      return null;
  }
}

// --- Routing ---------------------------------------------------------------
// Returns a discriminated route:
//   { kind: "picklist",  objectKey, field } -> GET /sf/meta/{object}/picklist/{field}
//   { kind: "picklists", objectKey }        -> GET /sf/meta/{object}/picklists (batch)
//   { kind: "users" }                        -> GET /sf/users (tenant users lookup)
//   { kind: "single",    objectKey, id }    -> GET /sf/{object}/{id}
//   { kind: "list",      objectKey }        -> GET /sf/{object}
//   { kind: "none" }                         -> unrecognized
//
// The META picklist route is matched FIRST — before any generic /sf/{object}
// handling — so the literal "meta" path segment is never mistaken for an object
// key. (It also isn't in OBJECT_ALLOWLIST, so even a mis-parse can't resolve it
// to a Salesforce object; the first-match ordering here is the primary guard,
// the allowlist is the backstop.)
function extractRoute(event) {
  const pp = event?.pathParameters || {};
  const path = event?.rawPath || event?.path || "";

  // 1) META picklist: /sf/meta/{object}/picklist/{field}
  //    Distinguished by the dedicated {field} path param (API Gateway) or, as a
  //    fallback, by matching the full meta path. Matched before the generic
  //    object routes so "meta" cannot leak in as an objectKey.
  if (pp.field) {
    return { kind: "picklist", objectKey: pp.object || null, field: pp.field };
  }
  const metaMatch = path.match(/\/sf\/meta\/([^/?]+)\/picklist\/([^/?]+)\/?$/);
  if (metaMatch) {
    return {
      kind: "picklist",
      objectKey: decodeURIComponent(metaMatch[1]),
      field: decodeURIComponent(metaMatch[2]),
    };
  }

  // 1b) META batch picklists (plural, NO field): /sf/meta/{object}/picklists
  //     Matched BEFORE the generic /sf/{object} branch so the plural path is
  //     never mistaken for a list read, and so neither the "meta" segment nor the
  //     "picklists" literal is ever treated as an object or a field. The plural
  //     "picklists" cannot collide with the singular "/picklist/{field}" pattern
  //     above: that requires a trailing "/{field}" segment which this path lacks,
  //     and "picklists" is not "picklist/" — so the two meta routes are
  //     unambiguous. (pp.field is absent here, so the singular checks don't fire.)
  const metaAllMatch = path.match(/\/sf\/meta\/([^/?]+)\/picklists\/?$/);
  if (metaAllMatch) {
    return {
      kind: "picklists",
      objectKey: decodeURIComponent(metaAllMatch[1]),
    };
  }

  // 1c) Tenant users lookup: GET /sf/users (literal path). Matched BEFORE the
  //     generic /sf/{object} branch so "users" is never treated as
  //     {object}="users" (which isn't an allowlist key anyway). This is its own
  //     literal path, distinct from the allowlist object key "user" (/sf/user,
  //     which stays a normal list read) — note the trailing "s". The regex
  //     requires the path to END at "users", so /sf/user and /sf/user/{id} do
  //     NOT match it.
  if (/\/sf\/users\/?$/.test(path)) {
    return { kind: "users" };
  }

  // 2) Generic object routes (existing behavior, unchanged).
  if (pp.object) {
    return {
      kind: pp.id ? "single" : "list",
      objectKey: pp.object,
      id: pp.id || null,
    };
  }
  // Fallback: parse the path if pathParameters weren't provided.
  const m = path.match(/\/sf\/([^/?]+)(?:\/([^/?]+))?\/?$/);
  if (m) {
    const objectKey = decodeURIComponent(m[1]);
    const id = m[2] ? decodeURIComponent(m[2]) : null;
    return { kind: id ? "single" : "list", objectKey, id };
  }
  return { kind: "none", objectKey: null, id: null };
}

// --- Salesforce describe (module-scope cached per object, WITH TTL) --------
// rawDescribeCache holds the FULL describe JSON (including each field's
// picklistValues). getQueryableFields derives its trimmed name/type list from
// the same cached describe, and the picklist metadata route reads picklistValues
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
const EXCLUDED_FIELD_TYPES = new Set(["address", "location", "base64"]);

async function getRawDescribe(sfObject) {
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
// The SELECT list is narrowed to cache-backed fields later, in buildCacheSelect.
async function getQueryableFields(sfObject) {
  if (describeCache.has(sfObject)) return describeCache.get(sfObject);

  const meta = await getRawDescribe(sfObject);
  const fields = (meta.fields || [])
    .filter((f) => !EXCLUDED_FIELD_TYPES.has(f.type))
    .map((f) => ({ name: f.name, type: f.type }));

  const result = { fields };
  describeCache.set(sfObject, result);
  return result;
}

// --- Cache column introspection (module-scope cached) ----------------------
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
async function getCacheColumns(table) {
  if (cacheColumnsCache.has(table)) return cacheColumnsCache.get(table);
  const spec = await getOpenApiSpec();
  const def = spec?.definitions?.[table] || spec?.components?.schemas?.[table];
  const cols = new Set(def?.properties ? Object.keys(def.properties) : []);
  cacheColumnsCache.set(table, cols);
  return cols;
}

// --- SF record -> cache row mapping ----------------------------------------
// Derive a cache column name from a Salesforce field. Reference (lookup) fields
// map to "<name>_sf_id"; others lowercase the API name minus the __c suffix.
// Only columns that actually exist in the cache table are written.
function sfFieldToColumn(field) {
  let base = field.name.replace(/__c$/i, "").toLowerCase();
  if (field.type === "reference") base += "_sf_id";
  return base;
}

// Build the SOQL SELECT list from ONLY the fields whose mapped cache column
// actually exists in the cache table (plus Id and Client__c, always retained:
// Id is the record key -> sf_id, Client__c is the tenant control/filter field).
//
// This is the core fix for the silently-dropped-field bug. Selecting by cache
// column means:
//   - every field the cache CAN store is fetched and written (e.g. Stage__c ->
//     "stage", Address_at_Creation__c -> "address_at_creation"),
//   - fields with no cache column are skipped up front instead of being fetched
//     and then dropped, and
//   - the SELECT tracks the (narrow) cache schema, so an object's total field
//     count no longer matters — nothing is truncated by an arbitrary cap.
function buildCacheSelect(fields, columnSet, createdDateSources) {
  const REQUIRED = new Set(["Id", "Client__c"]);
  const selectFields = fields.filter(
    (f) => REQUIRED.has(f.name) || columnSet.has(sfFieldToColumn(f))
  );
  // Belt-and-suspenders: ensure Id/Client__c are present even if absent above.
  for (const name of REQUIRED) {
    if (!selectFields.some((f) => f.name === name)) {
      const orig = fields.find((f) => f.name === name);
      if (orig) selectFields.push(orig);
    }
  }
  // When the cache has a `created_date` column, also select EVERY source field
  // (Contract_Date__c / CreatedDate) so the mapper can populate created_date — their
  // own sfFieldToColumn names aren't cache columns, so they aren't selected above.
  if (Array.isArray(createdDateSources) && columnSet.has("created_date")) {
    for (const srcName of createdDateSources) {
      const already = selectFields.some(
        (f) => f.name.toLowerCase() === srcName.toLowerCase()
      );
      if (already) continue;
      const src = fields.find(
        (f) => f.name.toLowerCase() === srcName.toLowerCase()
      );
      if (src) selectFields.push(src);
    }
  }
  return {
    selectFields,
    selectList: selectFields.map((f) => f.name).join(", "),
  };
}

function mapSfRecordToCacheRow(record, fields, columnSet, ctx) {
  const row = {};
  for (const f of fields) {
    if (f.name === "Id") continue; // -> sf_id (control column below)
    const val = record[f.name];
    if (val === undefined || val === null) continue;
    if (typeof val === "object") continue; // skip nested relationship objects
    const col = sfFieldToColumn(f);
    if (columnSet.has(col)) row[col] = val;
  }
  // Control columns are authoritative. Tenant values come ONLY from identity.
  row.sf_id = record.Id;
  if (columnSet.has("tenant_id")) row.tenant_id = ctx.tenantSlug ?? null;
  row.client_sf_id = ctx.tenantId; // isolation key
  // List-ordering key: created_date = first non-empty source value (COALESCE of
  // e.g. Contract_Date__c, CreatedDate). Always written when the column exists so a
  // refresh upsert never clobbers a sibling row via an inconsistent column set.
  if (columnSet.has("created_date")) {
    row.created_date = resolveCreatedDate(record, ctx.createdDateSources);
  }
  if (columnSet.has("last_synced_at")) row.last_synced_at = ctx.now;
  if (columnSet.has("is_stale")) row.is_stale = false;
  if (ctx.cacheVersion != null && columnSet.has("cache_version")) {
    row.cache_version = ctx.cacheVersion;
  }
  return row;
}

async function getExistingCacheVersion(supabase, table, sfId, tenantId) {
  const { data } = await supabase
    .from(table)
    .select("cache_version")
    .eq("sf_id", sfId)
    .eq("client_sf_id", tenantId)
    .maybeSingle();
  return data?.cache_version ?? 0;
}

// --- Read-time freshness rule (SINGLE definition, used everywhere) ----------
// A cache row is fresh/trustworthy only if BOTH hold:
//   1. is_stale is false or null (an explicit is_stale === true fails), AND
//   2. last_synced_at is within the TTL window (now - last_synced_at <= TTL).
// A row failing EITHER is "stale" and must be refreshed from Salesforce on read.
// Missing/invalid last_synced_at is treated as stale (fail-closed).
function isRowFresh(row, nowMs) {
  if (!row) return false;
  if (row.is_stale === true) return false;
  const syncedMs = row.last_synced_at ? Date.parse(row.last_synced_at) : NaN;
  if (!Number.isFinite(syncedMs)) return false;
  return nowMs - syncedMs <= CACHE_TTL_MS;
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
// Omitting nulls is safe because it is ALREADY the shape callers receive: rows
// refreshed from Salesforce come from mapSfRecordToCacheRow, which has always
// skipped null/undefined values, so every `source: "cache+salesforce"` page has
// been serving null-omitted rows. An absent key and a null key behave identically
// under `??`, `||` and optional chaining.
//
// The projection is applied ONLY when building the response array — never to the
// rows the freshness partition reads, and never to what is written back to the
// cache, so `notes` stays cached and intact for the detail view.
const LIST_CONTROL_COLUMNS = [
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
function isExcludedListColumn(col) {
  if (LIST_CONTROL_COLUMNS.includes(col)) return false; // control columns are never dropped
  return col === "notes" || col.endsWith("_notes") || col.includes("findings");
}

// Explicit PostgREST select list for LIST/SEARCH reads: every cache column except
// the excluded long-text ones. Falls back to "*" when column introspection came
// back empty, so a failed OpenAPI fetch degrades to today's behavior rather than
// selecting nothing.
function buildListSelect(columnSet) {
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
function projectListRow(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (value === null || value === undefined) continue;
    if (isExcludedListColumn(key)) continue;
    out[key] = value;
  }
  return out;
}

// Read `limit` rows starting at `offset` from a cache table, transparently
// splitting the read into POSTGREST_PAGE_SIZE-sized .range() sub-requests so the
// caller always gets the page size it asked for (see POSTGREST_PAGE_SIZE for why).
//
// `makeQuery(withCount)` must return a FRESH query builder each call — a
// supabase-js builder is single-use — with all filters/ordering applied but NO
// .range(). The exact `total` is requested on the FIRST sub-request only: it is a
// separate server-side COUNT, so asking for it once per sub-request would multiply
// the cost for a number that cannot change within one read.
//
// Stops early when a sub-request returns fewer rows than asked (end of data), and
// surfaces the first error rather than a partial page, matching the previous
// single-request behavior.
async function fetchCacheRange(makeQuery, offset, limit) {
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

// Upsert cache rows in bounded batches. A fully-stale 5000-row page would
// otherwise be one ~4 MB PostgREST request; chunking keeps each write ordinary.
// Best-effort by contract: a cache-write failure is logged, never fails the read.
async function upsertCacheRows(supabase, cacheTable, rows, label) {
  for (let i = 0; i < rows.length; i += POSTGREST_PAGE_SIZE) {
    const batch = rows.slice(i, i + POSTGREST_PAGE_SIZE);
    try {
      const { error } = await supabase
        .from(cacheTable)
        .upsert(batch, { onConflict: "sf_id" });
      if (error) console.error(`cache upsert error (${label}):`, error.message);
    } catch (e) {
      console.error(`cache upsert threw (${label}):`, e?.message || String(e));
    }
  }
}

// Re-fetch specific records by Id from Salesforce, using the cache-backed field
// SELECT. TENANT ISOLATION (defense in depth): Client__c is always in the WHERE
// even though we also constrain by Id — a cross-tenant Id can never be returned.
// The Id list is chunked so a large stale set never builds an oversized IN()/SOQL.
//
// Chunks run REFETCH_CONCURRENCY at a time. Strictly sequential chunks were fine
// at a 500-row page (3 chunks) but not at 5000 (25 chunks): at the ~1.5s per chunk
// measured against this org that is ~35s of Salesforce round trips, past the
// function's 30s timeout. Bounded waves keep a fully-stale max-size page inside the
// timeout without hammering the Salesforce API.
const REFETCH_CONCURRENCY = 5;
async function refetchByIds({ sfObject, selectList, tenantId, ids }) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += REFETCH_ID_CHUNK_SIZE) {
    chunks.push(ids.slice(i, i + REFETCH_ID_CHUNK_SIZE));
  }

  const out = [];
  for (let i = 0; i < chunks.length; i += REFETCH_CONCURRENCY) {
    const wave = chunks.slice(i, i + REFETCH_CONCURRENCY);
    const results = await Promise.all(
      wave.map((chunk) => {
        const quoted = chunk.map((id) => `'${soqlEscapeString(id)}'`).join(", ");
        const soql =
          `SELECT ${selectList} FROM ${sfObject} ` +
          `WHERE Client__c = '${soqlEscapeString(tenantId)}' ` +
          `AND Id IN (${quoted})`;
        return sfQuery(soql);
      })
    );
    for (const recs of results) {
      if (recs && recs.length) out.push(...recs);
    }
  }
  return out;
}

// --- SINGLE-RECORD read: FULL mode -----------------------------------------
// Detail-view read: return EVERY queryable field of one record, live from
// Salesforce. Reached only via ?full=true on GET /sf/{object}/{id}.
//
// Deliberately CACHE-FREE: no cache read and no cache write. The cache holds only
// a narrow ~15-column slice; the detail view needs all ~280 fields, and these
// reads are low-frequency, so round-tripping the cache would add nothing and the
// cache cannot represent the full record anyway.
//
// TENANT ISOLATION is identical to the cache-backed path: the SOQL still filters
// Id = '<id>' AND Client__c = '<tenantId>', with tenantId derived ONLY from the
// verified token. A record owned by another tenant returns 404, never data.
async function handleSingleReadFull(ctx) {
  const { sfObject, id, tenantId, repRestrict, cors } = ctx;

  // Every queryable field (compound/base64 already excluded by getQueryableFields).
  // We do NOT narrow to cache-backed columns — returning the fields the cache
  // does not store is the entire purpose of full mode.
  const { fields } = await getQueryableFields(sfObject);
  const selectList = fields.map((f) => f.name).join(", ");

  // TEMP Sales Rep guard: a restricted rep must not load another rep's record by
  // id — add the authoritative rep field to the WHERE so a non-matching id yields
  // 0 rows -> 404, identical to a cross-tenant miss.
  const repClause = repRestrict
    ? ` AND ${repRestrict.sfField} = '${soqlEscapeString(repRestrict.value)}'`
    : "";
  const soql =
    `SELECT ${selectList} FROM ${sfObject} ` +
    `WHERE Id = '${soqlEscapeString(id)}' ` +
    `AND Client__c = '${soqlEscapeString(tenantId)}'` +
    repClause +
    ` LIMIT 1`;
  const records = await sfQuery(soql);

  // Missing or cross-tenant -> 404.
  if (!records || records.length === 0) {
    return jsonResponse(404, cors, {
      error: "not_found",
      code: "RECORD_NOT_FOUND",
    });
  }

  // Return the raw Salesforce record verbatim — no cache mapping, no cache write.
  // It contains business fields only (never tokens/secrets) and is returned only
  // to the authenticated, tenant-matched caller. Strip the Salesforce `attributes`
  // envelope (object type + internal record URL) so `record` is pure field data.
  const { attributes, ...record } = records[0];
  return jsonResponse(200, cors, {
    source: "salesforce",
    full: true,
    record,
  });
}

// --- SINGLE-RECORD read ----------------------------------------------------
async function handleSingleRead(ctx) {
  const { supabase, sfObject, cacheTable, columnSet, id, tenantId, tenantSlug, createdDateSources, repRestrict, cors, full } =
    ctx;

  // ?full=true -> all-fields, cache-bypassing detail read (see handleSingleReadFull).
  if (full) return await handleSingleReadFull(ctx);

  // a. Cache-first. TENANT FILTER: .eq("client_sf_id", tenantId).
  //    Do NOT filter is_stale in the query — fetch the row and decide freshness
  //    in code (isRowFresh) so a stale OR time-aged row falls through to a
  //    Salesforce refresh below instead of being served outdated.
  //    TEMP Sales Rep guard: SKIP the cache shortcut for a restricted rep — a
  //    cache row cannot prove rep ownership (the rep field isn't cached), so we
  //    always verify against Salesforce with the rep field in the WHERE below.
  if (!repRestrict) {
    const { data: cached, error: cacheErr } = await supabase
      .from(cacheTable)
      .select("*")
      .eq("sf_id", id)
      .eq("client_sf_id", tenantId)
      .limit(1)
      .maybeSingle();
    if (cacheErr) console.error("cache read error (single):", cacheErr.message);
    if (cached && isRowFresh(cached, Date.now())) {
      return jsonResponse(200, cors, { source: "cache", record: cached });
    }
  }

  // b. Missing OR stale/aged (or a restricted rep) -> read from Salesforce.
  //    TENANT FILTER: AND Client__c = '<escaped tenantId>'. TEMP rep guard adds
  //    the authoritative rep field so another rep's record returns 0 rows -> 404.
  const { fields } = await getQueryableFields(sfObject);
  const { selectFields, selectList } = buildCacheSelect(fields, columnSet, createdDateSources);
  const repClause = repRestrict
    ? ` AND ${repRestrict.sfField} = '${soqlEscapeString(repRestrict.value)}'`
    : "";
  const soql =
    `SELECT ${selectList} FROM ${sfObject} ` +
    `WHERE Id = '${soqlEscapeString(id)}' ` +
    `AND Client__c = '${soqlEscapeString(tenantId)}'` +
    repClause +
    ` LIMIT 1`;
  const records = await sfQuery(soql);

  // c. Missing or cross-tenant -> 404.
  if (!records || records.length === 0) {
    return jsonResponse(404, cors, {
      error: "not_found",
      code: "RECORD_NOT_FOUND",
    });
  }

  // d. Upsert into cache (bump version), then return. Cache failure != read failure.
  const sfRecord = records[0];
  const existingVersion = await getExistingCacheVersion(
    supabase,
    cacheTable,
    sfRecord.Id,
    tenantId
  );
  const mapped = mapSfRecordToCacheRow(sfRecord, selectFields, columnSet, {
    tenantId,
    tenantSlug,
    createdDateSources,
    now: new Date().toISOString(),
    cacheVersion: existingVersion + 1,
  });
  try {
    const { error: upErr } = await supabase
      .from(cacheTable)
      .upsert(mapped, { onConflict: "sf_id" });
    if (upErr) console.error("cache upsert error (single):", upErr.message);
  } catch (e) {
    console.error("cache upsert threw (single):", e?.message || String(e));
  }
  return jsonResponse(200, cors, { source: "salesforce", record: mapped });
}

// --- Server-side cache search (non-rep callers) ----------------------------
// ILIKE '%term%' across the object's cache name columns, tenant-scoped, ordered
// like the normal list, capped at SEARCH_CAP. Searches the WHOLE tenant cache;
// count:"exact" returns the full match total even though only SEARCH_CAP rows come
// back. `term` is already sanitized (no wildcard/injection); each ILIKE value is
// double-quoted for PostgREST so name chars (space ' . & -) are treated literally.
async function handleCacheSearch({ supabase, cacheTable, columnSet, tenantId, searchCacheCols, term, cors }) {
  const cols = (searchCacheCols || []).filter((c) => columnSet.has(c));
  if (cols.length === 0) {
    return jsonResponse(200, cors, {
      source: "cache", count: 0, total: 0, limit: SEARCH_CAP, offset: 0, hasMore: false, records: [],
    });
  }
  const orExpr = cols.map((c) => `${c}.ilike."%${term}%"`).join(",");
  // Explicit select (not "*") so long-text columns never enter a search response —
  // see buildListSelect / the 6 MB payload note.
  let cq = supabase
    .from(cacheTable)
    .select(buildListSelect(columnSet), { count: "exact" })
    .eq("client_sf_id", tenantId)
    .or(orExpr);
  if (columnSet.has("created_date")) {
    cq = cq
      .order("created_date", { ascending: false, nullsFirst: false })
      .order("sf_id", { ascending: true });
  } else {
    cq = cq.order("sf_id", { ascending: true });
  }
  cq = cq.range(0, SEARCH_CAP - 1);
  const { data, count, error } = await cq;
  if (error) {
    console.error("cache search error:", error.message);
    return jsonResponse(500, cors, { error: "server_error" });
  }
  // Drop null-valued keys before responding (see projectListRow). SEARCH_CAP is
  // only 200 rows so this path was never the one blowing the payload cap, but the
  // shape stays identical to the list path so callers see one row shape.
  const records = (data || []).map(projectListRow);
  const total = count ?? records.length;
  return jsonResponse(200, cors, {
    source: "cache",
    count: records.length,
    total,
    limit: SEARCH_CAP,
    offset: 0,
    hasMore: total > records.length,
    records,
  });
}

// --- LIST read (server-side paginated) -------------------------------------
// Cache-first, tenant-scoped, PAGED. Inputs: ?limit= (page size, bounded by
// MAX_LIMIT) & ?offset= (start row). Returns a page PLUS the exact `total` across
// all pages so the frontend can render a pager / load-more. Stable ORDER BY sf_id
// means paging never shifts rows as they are re-synced. Only the rows ON THE PAGE
// are freshness-checked and refreshed — we never scan the whole (e.g. 32k-row)
// table on a read. Generic across every allowlisted object (customer/solar/…).
async function handleListRead(ctx) {
  const { supabase, sfObject, cacheTable, columnSet, tenantId, tenantSlug, createdDateSources, repRestrict, searchFields, qs, cors } =
    ctx;

  // Pagination inputs. limit = PAGE SIZE (not a dataset cap); offset = start row.
  let limit = parseInt(qs.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  let offset = parseInt(qs.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const { fields } = await getQueryableFields(sfObject);
  const { selectFields, selectList } = buildCacheSelect(fields, columnSet, createdDateSources);

  // Optional single-field filter. Validate against ALL real SF field names (not
  // just the cache-backed subset). A tenant/client filter from the caller is
  // never honored.
  let filterFieldName = null;
  let filterColumn = null;
  let filterValue = null;
  if (qs.field && qs.value != null) {
    const match = fields.find(
      (f) => f.name.toLowerCase() === String(qs.field).toLowerCase()
    );
    if (!match) {
      return jsonResponse(400, cors, {
        error: "invalid_filter_field",
        code: "INVALID_FILTER_FIELD",
      });
    }
    // Ignore any client-related filter; tenant scoping is forced separately.
    if (match.name !== "Client__c") {
      filterFieldName = match.name; // canonical SF field name (safe to interpolate)
      filterColumn = sfFieldToColumn(match);
      filterValue = String(qs.value);
      // NOTE: filter value is escaped+quoted, so this supports string/picklist
      // fields. Numeric/boolean filters may produce a SOQL type error for now.
    }
  }

  // Server-side search term (?q=), sanitized; null when absent/too short/unsupported.
  const searchTerm = searchFields ? sanitizeSearchTerm(qs.q) : null;

  // TEMP Sales Rep guard: the authoritative rep field isn't cached, so a restricted
  // rep's list is served LIVE from Salesforce (COUNT + paged SELECT, offset clamped
  // at the SOQL 2000 cap) filtered to the rep — bypassing the cache entirely. Any
  // caller ?field=&value= filter is preserved (ANDed with the rep clause). A ?q=
  // search adds a SOQL name LIKE ON TOP of the rep clause (never widens the rep's
  // set) and caps at SEARCH_CAP from the first page.
  if (repRestrict) {
    return await listColdCacheFallback({
      supabase, sfObject, cacheTable, columnSet, tenantId, tenantSlug,
      createdDateSources, cors, selectFields, selectList,
      filterFieldName, filterValue,
      // LIVE Salesforce path — keeps the original 500 cap (SF_LIVE_MAX_LIMIT); the
      // raised MAX_LIMIT is cache-path only.
      limit: searchTerm ? SEARCH_CAP : Math.min(limit, SF_LIVE_MAX_LIMIT),
      offset: searchTerm ? 0 : offset,
      repRestrict,
      searchTerm,
      searchSfFields: searchTerm ? searchFields.sf : null,
    });
  }

  // Non-rep server-side search: ILIKE across the cache name columns, tenant-scoped,
  // capped at SEARCH_CAP (response still carries the full match total). Searches the
  // WHOLE tenant cache, not just a loaded page.
  if (searchTerm) {
    return await handleCacheSearch({
      supabase, cacheTable, columnSet, tenantId,
      searchCacheCols: searchFields.cache, term: searchTerm, cors,
    });
  }

  // b. Cache-first PAGED fetch WITH exact total. TENANT FILTER: client_sf_id.
  //    - count:"exact" returns the FULL matching total regardless of the range.
  //    - ORDER BY created_date DESC (newest first) with NULLS LAST, then sf_id as a
  //      stable tiebreaker. created_date doesn't change on re-sync, so a row can't
  //      jump between pages; the sf_id tiebreaker keeps rows with equal/NULL dates
  //      in a deterministic order (no dup/skip under pagination). Backed by the
  //      (client_sf_id, created_date DESC NULLS LAST, sf_id) index.
  //    - is_stale is NOT filtered: stale rows stay on the page and get refreshed.
  //    - The read goes through fetchCacheRange, which splits a page larger than
  //      PostgREST's "Max Rows" ceiling into consecutive sub-requests. The ordering
  //      is deterministic (created_date DESC, sf_id ASC), so consecutive ranges
  //      concatenate into exactly the page a single request would have returned.
  //
  //    makeCacheQuery returns a FRESH builder per sub-request (supabase-js builders
  //    are single-use) with identical filters + ordering; only the first asks for
  //    the exact count.
  //    The select is EXPLICIT rather than "*" so long-text columns never leave the
  //    database — see buildListSelect and the 6 MB payload note. The control
  //    columns the freshness partition below reads (is_stale, last_synced_at,
  //    cache_version, sf_id) are always included.
  const listSelect = buildListSelect(columnSet);
  const makeCacheQuery = (withCount) => {
    let q = supabase
      .from(cacheTable)
      .select(listSelect, withCount ? { count: "exact" } : {})
      .eq("client_sf_id", tenantId);
    if (filterColumn && columnSet.has(filterColumn)) {
      q = q.eq(filterColumn, filterValue);
    }
    // Order newest-first by created_date WHEN the cache actually has that column;
    // otherwise fall back to the stable sf_id order. This keeps the endpoint healthy
    // and self-healing while the created_date column/backfill is rolled out — a
    // missing column would otherwise error the cache query and dump every list onto
    // the slow Salesforce cold path.
    if (columnSet.has("created_date")) {
      q = q
        .order("created_date", { ascending: false, nullsFirst: false })
        .order("sf_id", { ascending: true });
    } else {
      q = q.order("sf_id", { ascending: true });
    }
    return q;
  };

  const {
    rows: pageRows,
    total,
    error: cacheErr,
  } = await fetchCacheRange(makeCacheQuery, offset, limit);
  if (cacheErr) console.error("cache read error (list):", cacheErr.message);

  // c. Cold cache for this tenant/object (nothing cached yet) -> page-aware SF
  //    fallback + populate. Rare now that cache-sync's full resync backfills, but
  //    kept so a brand-new tenant/object still returns data.
  if ((total ?? 0) === 0 && (!pageRows || pageRows.length === 0)) {
    return await listColdCacheFallback({
      supabase, sfObject, cacheTable, columnSet, tenantId, tenantSlug, createdDateSources, cors,
      selectFields, selectList, filterFieldName, filterValue,
      // LIVE Salesforce path — original 500 cap, as above.
      limit: Math.min(limit, SF_LIVE_MAX_LIMIT), offset,
    });
  }

  // d. Partition ONLY THIS PAGE into fresh vs stale per the single freshness rule.
  const nowMs = Date.now();
  const freshBySfId = new Map();
  const staleRows = [];
  for (const row of pageRows) {
    if (isRowFresh(row, nowMs)) freshBySfId.set(row.sf_id, row);
    else staleRows.push(row);
  }

  // e. Refresh ONLY this page's stale rows from Salesforce, by Id, tenant-scoped
  //    (chunked). A stale id NOT returned by Salesforce was deleted/moved tenant.
  const refreshedBySfId = new Map();
  const deletedIds = [];
  if (staleRows.length > 0) {
    const staleIds = staleRows.map((r) => r.sf_id).filter(Boolean);
    const versionBySfId = new Map(
      staleRows.map((r) => [r.sf_id, r.cache_version ?? 0])
    );
    const nowIso = new Date().toISOString();

    const refetched = await refetchByIds({ sfObject, selectList, tenantId, ids: staleIds });
    const refetchedById = new Map(refetched.map((rec) => [rec.Id, rec]));

    const refreshedRows = [];
    for (const sfId of staleIds) {
      const rec = refetchedById.get(sfId);
      if (!rec) { deletedIds.push(sfId); continue; } // deleted in SF
      const mapped = mapSfRecordToCacheRow(rec, selectFields, columnSet, {
        tenantId, tenantSlug, createdDateSources, now: nowIso,
        cacheVersion: (versionBySfId.get(sfId) ?? 0) + 1,
      });
      refreshedRows.push(mapped);
      refreshedBySfId.set(sfId, mapped);
    }

    // Write refreshed rows back (best-effort — a cache-write failure != read fail),
    // batched so a full max-size page isn't one oversized PostgREST request.
    if (refreshedRows.length > 0) {
      await upsertCacheRows(supabase, cacheTable, refreshedRows, "list refresh");
    }

    // Delete-detection: orphaned cache rows (gone from SF), tenant-scoped, best-effort.
    // Chunked: .in() serializes every id into the request URL, so a large orphan set
    // on a max-size page would otherwise build a URL past PostgREST's length limit.
    for (let i = 0; i < deletedIds.length; i += POSTGREST_PAGE_SIZE) {
      const batch = deletedIds.slice(i, i + POSTGREST_PAGE_SIZE);
      try {
        const { error: delErr } = await supabase
          .from(cacheTable)
          .delete()
          .eq("client_sf_id", tenantId)
          .in("sf_id", batch);
        if (delErr) console.error("cache delete error (list refresh):", delErr.message);
      } catch (e) {
        console.error("cache delete threw (list refresh):", e?.message || String(e));
      }
    }
  }

  // f. Rebuild the page IN STABLE sf_id ORDER: fresh rows as-is, stale rows
  //    replaced by their refreshed version, deleted rows dropped. Order comes from
  //    the paged query (never reordered by refresh), so pages stay consistent.
  //
  //    projectListRow runs HERE — after the freshness partition has already read
  //    is_stale/last_synced_at/cache_version off the untouched rows, and after the
  //    FULL refreshed rows have been upserted to the cache. So the cache still
  //    stores `notes` for the detail view; only the response drops it. Refreshed
  //    rows especially need projecting: they come from Salesforce via
  //    mapSfRecordToCacheRow and would otherwise smuggle the long-text columns
  //    back into a list response.
  const deletedSet = new Set(deletedIds);
  const records = [];
  for (const row of pageRows) {
    if (deletedSet.has(row.sf_id)) continue;
    const chosen = refreshedBySfId.get(row.sf_id) || freshBySfId.get(row.sf_id) || row;
    records.push(projectListRow(chosen));
  }

  const adjustedTotal = Math.max(0, (total ?? records.length) - deletedIds.length);
  const source = staleRows.length === 0 ? "cache" : "cache+salesforce";
  return jsonResponse(200, cors, {
    source,
    count: records.length, // rows in THIS page (backward compatible)
    total: adjustedTotal, // total matching rows across ALL pages (for the pager)
    limit,
    offset,
    hasMore: offset + records.length < adjustedTotal,
    records,
  });
}

// Cold-cache list fallback: the tenant/object has nothing cached yet. Return the
// requested PAGE straight from Salesforce (page-aware) plus an exact COUNT() total,
// and populate the page's rows into the cache. Salesforce caps SOQL OFFSET at 2000,
// so a deep offset on a cold cache is clamped — the cache-sync full resync is the
// real fix for large sets, after which this path stops being hit.
async function listColdCacheFallback(ctx) {
  const {
    supabase, sfObject, cacheTable, columnSet, tenantId, tenantSlug, createdDateSources, cors,
    selectFields, selectList, filterFieldName, filterValue, limit, offset, repRestrict,
    searchTerm, searchSfFields,
  } = ctx;

  let where = `Client__c = '${soqlEscapeString(tenantId)}'`;
  // TEMP Sales Rep guard: AND the authoritative rep field (applies to both the
  // COUNT and the paged SELECT below, so total + rows are rep-scoped). The search
  // clause is ANDed AFTER this, so a rep's search can only NARROW their own set —
  // never reach another rep's records.
  if (repRestrict) {
    where += ` AND ${repRestrict.sfField} = '${soqlEscapeString(repRestrict.value)}'`;
  }
  if (filterFieldName) {
    where += ` AND ${filterFieldName} = '${soqlEscapeString(filterValue)}'`;
  }
  // ?q= name search: OR of LIKE '%term%' across the object's SF name fields, ANDed
  // into the WHERE. Term is sanitized (no % _ ' injection) then SOQL-escaped.
  if (searchTerm && Array.isArray(searchSfFields) && searchSfFields.length) {
    const t = soqlEscapeString(searchTerm);
    const likes = searchSfFields.map((f) => `${f} LIKE '%${t}%'`).join(" OR ");
    where += ` AND (${likes})`;
  }

  // Exact total for the pager (aggregate COUNT(Id) returns one row {c:N}).
  let total = 0;
  try {
    const cnt = await sfQuery(`SELECT COUNT(Id) c FROM ${sfObject} WHERE ${where}`);
    total = Number(cnt?.[0]?.c ?? cnt?.[0]?.expr0 ?? 0) || 0;
  } catch (e) {
    console.error("cold-cache count error:", e?.message || String(e));
  }

  // Order newest-first. SOQL has no COALESCE, so this rare cold path orders by the
  // LAST source in the chain — always the standard CreatedDate, which is never null
  // — rather than the coalesced expression. Canonical SF field name (safe to
  // interpolate), Id as the stable tiebreaker. Rows are cached immediately after,
  // so subsequent reads use the coalesced created_date column ordering.
  const orderField =
    createdDateSources?.[createdDateSources.length - 1] || "CreatedDate";
  const sfOffset = Math.min(offset, 2000); // SOQL OFFSET hard cap
  const soql =
    `SELECT ${selectList} FROM ${sfObject} WHERE ${where} ` +
    `ORDER BY ${orderField} DESC NULLS LAST, Id ASC LIMIT ${limit} OFFSET ${sfOffset}`;
  const sfRecords = await sfQuery(soql);

  const now = new Date().toISOString();
  const mappedRows = (sfRecords || []).map((rec) =>
    mapSfRecordToCacheRow(rec, selectFields, columnSet, {
      tenantId, tenantSlug, createdDateSources, now, cacheVersion: 1,
    })
  );
  if (mappedRows.length > 0) {
    try {
      const { error: upErr } = await supabase
        .from(cacheTable)
        .upsert(mappedRows, { onConflict: "sf_id" });
      if (upErr) console.error("cache upsert error (list cold):", upErr.message);
    } catch (e) {
      console.error("cache upsert threw (list cold):", e?.message || String(e));
    }
  }

  return jsonResponse(200, cors, {
    source: "salesforce",
    count: mappedRows.length,
    total,
    limit,
    offset,
    hasMore: offset + mappedRows.length < total,
    records: mappedRows,
  });
}

// Decode a Salesforce dependent-picklist "validFor" base64 string into the list
// of controlling-value indices this dependent value is valid for.
//
// validFor is a base64-encoded bitmap. Within each decoded byte the bits are
// packed MSB-first (big-endian bit order): controlling index i lives in
// byte (i >> 3), at bit mask (0x80 >> (i & 7)). The dependent value is valid for
// controlling index i exactly when that bit is set:
//     bytes[i >> 3] & (0x80 >> (i & 7))  !== 0
//
// Missing/empty validFor -> valid for NO controlling value (returns []). The
// controlling field's picklistValues order defines what each index means.
function decodeValidForIndices(validFor) {
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

// --- PICKLIST metadata read ------------------------------------------------
// Returns the ordered picklist values for an allowlisted object's field, sourced
// from the Salesforce describe. When the field is a DEPENDENT picklist (its
// describe carries a controllerName pointing at another picklist), the response
// additionally exposes the controlling field and a controlling-value ->
// dependent-values mapping decoded from each entry's validFor bitmap.
//
// DELIBERATELY NOT TENANT-SCOPED: a field's picklist definition is org-wide
// metadata (identical for every Client__c) and contains no record data, so there
// is no Client__c / tenant filter here — that absence is intentional, not an
// oversight. A valid token is still required (enforced by the caller).
async function handlePicklistRead(ctx) {
  const { sfObject, objectKey, field, cors } = ctx;

  const meta = await getRawDescribe(sfObject);

  // Case-insensitive match on the SF field API name.
  const fieldDef = (meta.fields || []).find(
    (f) => f.name.toLowerCase() === String(field).toLowerCase()
  );
  if (!fieldDef) {
    return jsonResponse(404, cors, {
      error: "field_not_found",
      code: "FIELD_NOT_FOUND",
    });
  }
  if (fieldDef.type !== "picklist" && fieldDef.type !== "multipicklist") {
    return jsonResponse(400, cors, {
      error: "not_a_picklist",
      code: "NOT_A_PICKLIST",
    });
  }

  // Preserve Salesforce's defined order exactly — do NOT sort. Inactive values
  // are included but flagged active:false so the frontend can show or hide them.
  const values = (fieldDef.picklistValues || []).map((pv) => ({
    label: pv.label,
    value: pv.value,
    active: pv.active === true,
    defaultValue: pv.defaultValue === true,
  }));

  // Existing flat shape — unchanged and always present (backward compatible).
  const body = {
    object: objectKey, // the short allowlist key the caller used (e.g. "solar")
    field: fieldDef.name, // canonical SF field API name
    values,
  };

  // --- Dependent-picklist enhancement --------------------------------------
  // A field is dependent when its describe names a controllerName. If that
  // controller resolves to a picklist field in the same describe, we build the
  // full controlling-value -> dependent-values mapping. Non-dependent fields
  // (e.g. Solar Stage__c) skip this entirely and keep the flat shape above, with
  // NO controllingField/dependencies keys — so existing callers are unaffected.
  const controllerName = fieldDef.controllerName || null;
  if (controllerName) {
    const controllingField = (meta.fields || []).find(
      (f) => f.name.toLowerCase() === controllerName.toLowerCase()
    );
    const controllerIsPicklist =
      !!controllingField &&
      (controllingField.type === "picklist" ||
        controllingField.type === "multipicklist");

    if (controllerIsPicklist) {
      // The controlling field's picklistValues define the index order the
      // validFor bitmaps refer to. Index i == controllingValues[i].
      const controllingValues = (controllingField.picklistValues || []).map(
        (pv) => pv.value
      );

      // Seed one ordered group per controlling value (SF order). A controlling
      // value with no valid dependents stays an empty array.
      const dependencies = {};
      for (const cv of controllingValues) dependencies[cv] = [];

      // Walk dependent values in SF-defined order so each group preserves that
      // order. An entry with missing/empty validFor decodes to [] -> it appears
      // in no group (valid for nothing), which is the intended treatment.
      for (const pv of fieldDef.picklistValues || []) {
        for (const i of decodeValidForIndices(pv.validFor)) {
          const cv = controllingValues[i];
          if (cv === undefined) continue; // bit past controlling range -> ignore
          dependencies[cv].push({ label: pv.label, value: pv.value });
        }
      }

      body.controllingField = controllingField.name; // canonical API name
      body.dependencies = dependencies;
    } else {
      // Controller exists but isn't a picklist (e.g. a checkbox). We can't build
      // a value->values map, so expose the controller name (so the frontend
      // knows the field is dependent) and keep only the flat values list.
      body.controllingField = controllingField
        ? controllingField.name
        : controllerName;
    }
  }

  return jsonResponse(200, cors, body);
}

// Build the normalized BATCH entry for one picklist/multipicklist field. Reuses
// the SAME validFor decoder (decodeValidForIndices) as the single-field endpoint.
// For a dependent field whose controller is itself a picklist, returns the
// decoded controlling-value -> dependent-values map; otherwise controllingField
// and dependencies are null. (Self-contained so the single-field endpoint stays
// unchanged.)
function buildPicklistEntry(fieldDef, meta) {
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

// --- BATCH PICKLIST metadata read ------------------------------------------
// Returns ALL picklist/multipicklist fields and their options for an allowlisted
// object in ONE call (GET /sf/meta/{object}/picklists), so the edit UI can
// populate every dropdown from a single request.
//
// EFFICIENCY: a single (module-scope cached) describe fetch serves the whole
// batch — Salesforce is NOT called once per field.
//
// DELIBERATELY NOT TENANT-SCOPED: picklist definitions are org-wide describe
// metadata (identical for every Client__c) and carry no record data, so there is
// no Client__c / tenant filter here — that absence is intentional, not an
// oversight. A valid token is still required (enforced by the caller).
async function handlePicklistsRead(ctx) {
  const { sfObject, objectKey, cors } = ctx;

  // One describe fetch for the whole object (cached across warm invocations).
  const meta = await getRawDescribe(sfObject);

  // Iterate ALL fields once; include every picklist/multipicklist. Keys are the
  // field API names; each entry is decoded from the same describe (no per-field
  // Salesforce call).
  const picklists = {};
  for (const fieldDef of meta.fields || []) {
    if (fieldDef.type !== "picklist" && fieldDef.type !== "multipicklist") {
      continue;
    }
    picklists[fieldDef.name] = buildPicklistEntry(fieldDef, meta);
  }

  return jsonResponse(200, cors, {
    object: objectKey, // the short allowlist key the caller used (e.g. "solar")
    picklists,
  });
}

// --- TENANT USERS lookup (GET /sf/users) -----------------------------------
// Returns the caller's tenant's ACTIVE Sundial_User__c records as a compact
// { id, name } list for populating lookup dropdowns (e.g. Sales Rep) in the
// frontend.
//
// TENANT ISOLATION IS MANDATORY: the query always filters Client__c = '<tenantId>'
// with tenantId derived ONLY from the verified token, so a caller can never see
// another tenant's users. The Client__c value is bound through soqlEscapeString.
//
// Direct tenant-scoped Salesforce read (NOT cache-first). This endpoint is
// low-frequency (only when opening a create/edit form) and returns a tiny
// {id,name} projection; a direct query keeps tenant correctness self-evident with
// no cache-mapping to reason about. (The sundial_user_cache is columnar per the
// object's fields; a bespoke display-name projection isn't worth a cache round-trip
// here.)
async function handleUsersRead(ctx) {
  const { tenantId, cors } = ctx;
  const sfObject = OBJECT_ALLOWLIST.user.sfObject; // "Sundial_User__c"

  // REQUIRED tenant filter: Client__c = '<esc tenantId>'. Active users only.
  // Supabase_User_Id__c is the field identity resolution maps a login to a
  // Sundial_User__c on (see lib/identity.js) — the caller needs it to @-mention
  // users against the Supabase-auth-id-keyed comment_mentions feed.
  const soql =
    `SELECT Id, First_Name__c, Last_Name__c, Email__c, Supabase_User_Id__c FROM ${sfObject} ` +
    `WHERE Client__c = '${soqlEscapeString(tenantId)}' ` +
    `AND Active__c = true ` +
    `ORDER BY Last_Name__c, First_Name__c`;
  const records = await sfQuery(soql);

  // Compact projection: id + display name + Supabase auth id. Name falls back to
  // Email, then Id, when the name fields are empty. supabaseUserId is null for a
  // user with no Supabase id set yet (the user is still returned). No other
  // (sensitive) fields are returned.
  const users = (records || []).map((r) => {
    const name =
      [r.First_Name__c, r.Last_Name__c].filter(Boolean).join(" ").trim() ||
      r.Email__c ||
      r.Id;
    return { id: r.Id, name, supabaseUserId: r.Supabase_User_Id__c ?? null };
  });

  return jsonResponse(200, cors, { users });
}

// --- handler ---------------------------------------------------------------
export const handler = async (event) => {
  const method =
    event?.requestContext?.http?.method || event?.httpMethod || "GET";
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (method !== "GET") {
    return jsonResponse(405, cors, {
      error: "method_not_allowed",
      code: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const route = extractRoute(event);
    const { objectKey } = route;

    // Allowlist gate — caller can never reach an object outside this map. Applies
    // to every object-addressed route, including the meta picklist routes. "meta"
    // is a path segment, never an object, and is absent from OBJECT_ALLOWLIST, so
    // it can never resolve to a Salesforce object here. The /sf/users lookup is a
    // fixed literal route with no {object}, so it is exempt from this gate (it
    // targets Sundial_User__c directly and is still tenant-scoped below).
    const entry = objectKey ? OBJECT_ALLOWLIST[objectKey] : null;
    if (!entry && route.kind !== "users") {
      return jsonResponse(400, cors, {
        error: "unsupported_object",
        code: "OBJECT_NOT_ALLOWED",
      });
    }

    // Auth on every call (all routes). Tenant is derived ONLY from the verified
    // token. Identity errors map the same way for every read path.
    let identity;
    try {
      identity = await resolveIdentity(headers["authorization"]);
    } catch (err) {
      const mapped = mapIdentityError(err?.code);
      if (mapped) return jsonResponse(mapped.status, cors, mapped.body);
      throw err; // unexpected -> 500 below
    }

    const tenantId = identity.tenantId;
    const tenantSlug = identity.tenantSlug;
    // Without a resolved tenant we cannot scope safely — refuse rather than
    // run an unscoped record query. (Applies to the record read paths; the
    // picklist route below carries no tenant filter by design, but we still
    // require the token to resolve to a real, tenant-bearing portal user.)
    if (!tenantId) {
      return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });
    }

    // META picklist route: org-wide metadata, NOT tenant-scoped (see
    // handlePicklistRead). Handled before Supabase/cache setup since it needs
    // neither the cache client nor the cache column set.
    if (route.kind === "picklist") {
      return await handlePicklistRead({
        sfObject: entry.sfObject,
        objectKey,
        field: route.field,
        cors,
      });
    }

    // META batch picklists route: org-wide metadata, NOT tenant-scoped (see
    // handlePicklistsRead). Like the single-field route, handled before Supabase/
    // cache setup since it needs neither the cache client nor the column set.
    if (route.kind === "picklists") {
      return await handlePicklistsRead({
        sfObject: entry.sfObject,
        objectKey,
        cors,
      });
    }

    // Tenant users lookup: /sf/users. Tenant-scoped (tenantId from the token,
    // already NO_TENANT-checked above). Needs no cache client / column set.
    if (route.kind === "users") {
      return await handleUsersRead({ tenantId, cors });
    }

    const supabase = await getSupabaseClient();
    const columnSet = await getCacheColumns(entry.cacheTable);

    const shared = {
      supabase,
      sfObject: entry.sfObject,
      cacheTable: entry.cacheTable,
      columnSet,
      tenantId,
      tenantSlug,
      createdDateSources:
        CREATED_DATE_SOURCE[objectKey] ?? DEFAULT_CREATED_DATE_SOURCE,
      // TEMP Sales Rep hard-restrict (null for every other role/object).
      repRestrict: repRestrictFor(objectKey, identity),
      // Name columns + SF fields this object supports for ?q= search (null if none).
      searchFields: SEARCH_FIELDS[objectKey] ?? null,
      cors,
    };

    const qs = event.queryStringParameters || {};

    if (route.kind === "single") {
      // ?full=true (exact, case-insensitive) opts into the all-fields, cache-
      // bypassing detail read. Any other value keeps existing cache-first behavior.
      const full = String(qs.full).toLowerCase() === "true";
      return await handleSingleRead({ ...shared, id: route.id, full });
    }
    return await handleListRead({ ...shared, qs });
  } catch (err) {
    console.error("sf-query unexpected error:", err?.message || String(err));
    return jsonResponse(500, cors, { error: "server_error" });
  }
};
