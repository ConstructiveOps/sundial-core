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
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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

// --- Salesforce describe (module-scope cached per object) ------------------
// rawDescribeCache holds the FULL describe JSON (including each field's
// picklistValues). getQueryableFields derives its trimmed name/type list from
// the same cached describe, and the picklist metadata route reads picklistValues
// straight from it — so both paths share a single describe fetch per object.
const rawDescribeCache = new Map(); // sfObject -> full describe JSON
const describeCache = new Map(); // sfObject -> { fields:[{name,type}] }
const EXCLUDED_FIELD_TYPES = new Set(["address", "location", "base64"]);

async function getRawDescribe(sfObject) {
  if (rawDescribeCache.has(sfObject)) return rawDescribeCache.get(sfObject);

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
  rawDescribeCache.set(sfObject, meta);
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
function buildCacheSelect(fields, columnSet) {
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

// Re-fetch specific records by Id from Salesforce, using the cache-backed field
// SELECT. TENANT ISOLATION (defense in depth): Client__c is always in the WHERE
// even though we also constrain by Id — a cross-tenant Id can never be returned.
// The Id list is chunked so a large stale set never builds an oversized IN()/SOQL.
async function refetchByIds({ sfObject, selectList, tenantId, ids }) {
  const out = [];
  for (let i = 0; i < ids.length; i += REFETCH_ID_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + REFETCH_ID_CHUNK_SIZE);
    const quoted = chunk.map((id) => `'${soqlEscapeString(id)}'`).join(", ");
    const soql =
      `SELECT ${selectList} FROM ${sfObject} ` +
      `WHERE Client__c = '${soqlEscapeString(tenantId)}' ` +
      `AND Id IN (${quoted})`;
    const recs = await sfQuery(soql);
    if (recs && recs.length) out.push(...recs);
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
  const { sfObject, id, tenantId, cors } = ctx;

  // Every queryable field (compound/base64 already excluded by getQueryableFields).
  // We do NOT narrow to cache-backed columns — returning the fields the cache
  // does not store is the entire purpose of full mode.
  const { fields } = await getQueryableFields(sfObject);
  const selectList = fields.map((f) => f.name).join(", ");

  const soql =
    `SELECT ${selectList} FROM ${sfObject} ` +
    `WHERE Id = '${soqlEscapeString(id)}' ` +
    `AND Client__c = '${soqlEscapeString(tenantId)}' ` +
    `LIMIT 1`;
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
  const { supabase, sfObject, cacheTable, columnSet, id, tenantId, tenantSlug, cors, full } =
    ctx;

  // ?full=true -> all-fields, cache-bypassing detail read (see handleSingleReadFull).
  if (full) return await handleSingleReadFull(ctx);

  // a. Cache-first. TENANT FILTER: .eq("client_sf_id", tenantId).
  //    Do NOT filter is_stale in the query — fetch the row and decide freshness
  //    in code (isRowFresh) so a stale OR time-aged row falls through to a
  //    Salesforce refresh below instead of being served outdated.
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

  // b. Missing OR stale/aged -> refresh from Salesforce (cache-backed fields).
  //    TENANT FILTER: AND Client__c = '<escaped tenantId>'
  const { fields } = await getQueryableFields(sfObject);
  const { selectFields, selectList } = buildCacheSelect(fields, columnSet);
  const soql =
    `SELECT ${selectList} FROM ${sfObject} ` +
    `WHERE Id = '${soqlEscapeString(id)}' ` +
    `AND Client__c = '${soqlEscapeString(tenantId)}' ` +
    `LIMIT 1`;
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

// --- LIST read -------------------------------------------------------------
async function handleListRead(ctx) {
  const { supabase, sfObject, cacheTable, columnSet, tenantId, tenantSlug, qs, cors } =
    ctx;

  let limit = parseInt(qs.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  const { fields } = await getQueryableFields(sfObject);
  const { selectFields, selectList } = buildCacheSelect(fields, columnSet);

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

  // b. Cache-first candidate fetch. TENANT FILTER: .eq("client_sf_id", tenantId).
  //    We intentionally do NOT filter is_stale here — stale rows must be IN the
  //    candidate set so we can refresh them. Freshness is decided in code (d).
  let cq = supabase
    .from(cacheTable)
    .select("*")
    .eq("client_sf_id", tenantId);
  if (filterColumn && columnSet.has(filterColumn)) {
    cq = cq.eq(filterColumn, filterValue);
  }
  cq = cq.order("last_synced_at", { ascending: false }).limit(limit);
  const { data: candidateRows, error: cacheErr } = await cq;
  if (cacheErr) console.error("cache read error (list):", cacheErr.message);

  // c. Empty cache for this tenant -> existing FULL Salesforce fallback + populate
  //    (behavior unchanged). TENANT FILTER: Client__c = '<escaped tenantId>'.
  if (!candidateRows || candidateRows.length === 0) {
    let where = `Client__c = '${soqlEscapeString(tenantId)}'`;
    if (filterFieldName) {
      where += ` AND ${filterFieldName} = '${soqlEscapeString(filterValue)}'`;
    }
    const soql = `SELECT ${selectList} FROM ${sfObject} WHERE ${where} LIMIT ${limit}`;
    const sfRecords = await sfQuery(soql);

    const now = new Date().toISOString();
    const mappedRows = (sfRecords || []).map((rec) =>
      mapSfRecordToCacheRow(rec, selectFields, columnSet, {
        tenantId,
        tenantSlug,
        now,
        // Cache was empty for this tenant -> first-population rows -> version 1.
        cacheVersion: 1,
      })
    );

    if (mappedRows.length > 0) {
      try {
        const { error: upErr } = await supabase
          .from(cacheTable)
          .upsert(mappedRows, { onConflict: "sf_id" });
        if (upErr) console.error("cache upsert error (list):", upErr.message);
      } catch (e) {
        console.error("cache upsert threw (list):", e?.message || String(e));
      }
    }

    return jsonResponse(200, cors, {
      source: "salesforce",
      count: mappedRows.length,
      records: mappedRows,
    });
  }

  // d. Partition candidates into fresh vs stale per the single freshness rule.
  const nowMs = Date.now();
  const freshRows = [];
  const staleRows = [];
  for (const row of candidateRows) {
    (isRowFresh(row, nowMs) ? freshRows : staleRows).push(row);
  }

  // e. All fresh -> serve from cache exactly as before.
  if (staleRows.length === 0) {
    return jsonResponse(200, cors, {
      source: "cache",
      count: freshRows.length,
      records: freshRows,
    });
  }

  // f. Surgically re-fetch ONLY the stale rows from Salesforce, by Id, tenant-
  //    scoped (chunked). Each stale row's current cache_version came back with
  //    the candidate fetch, so we bump versions without an extra query.
  const staleIds = staleRows.map((r) => r.sf_id).filter(Boolean);
  const versionBySfId = new Map(
    staleRows.map((r) => [r.sf_id, r.cache_version ?? 0])
  );
  const nowIso = new Date().toISOString();

  const refetched = await refetchByIds({
    sfObject,
    selectList,
    tenantId,
    ids: staleIds,
  });
  const refetchedById = new Map(refetched.map((rec) => [rec.Id, rec]));

  // Map refreshed records -> cache rows (bump cache_version). A stale id NOT
  // returned by Salesforce was DELETED (or moved tenant) -> dropped here so we
  // never return a record that no longer exists.
  const refreshedRows = [];
  for (const sfId of staleIds) {
    const rec = refetchedById.get(sfId);
    if (!rec) continue; // deleted in SF -> drop from results
    refreshedRows.push(
      mapSfRecordToCacheRow(rec, selectFields, columnSet, {
        tenantId,
        tenantSlug,
        now: nowIso,
        cacheVersion: (versionBySfId.get(sfId) ?? 0) + 1,
      })
    );
  }

  // g. Write refreshed rows back (last_synced_at=now, is_stale=false, version
  //    bumped — all set by mapSfRecordToCacheRow). Best-effort: a cache-write
  //    failure must NOT fail the read.
  if (refreshedRows.length > 0) {
    try {
      const { error: upErr } = await supabase
        .from(cacheTable)
        .upsert(refreshedRows, { onConflict: "sf_id" });
      if (upErr) console.error("cache upsert error (list refresh):", upErr.message);
    } catch (e) {
      console.error("cache upsert threw (list refresh):", e?.message || String(e));
    }
  }

  // h. Delete-detection: stale ids Salesforce did NOT return are gone. They're
  //    already dropped from the results; best-effort remove the orphaned cache
  //    rows too. TENANT-SCOPED delete (isolation preserved).
  const deletedIds = staleIds.filter((sfId) => !refetchedById.has(sfId));
  if (deletedIds.length > 0) {
    try {
      const { error: delErr } = await supabase
        .from(cacheTable)
        .delete()
        .eq("client_sf_id", tenantId)
        .in("sf_id", deletedIds);
      if (delErr) console.error("cache delete error (list refresh):", delErr.message);
    } catch (e) {
      console.error("cache delete threw (list refresh):", e?.message || String(e));
    }
  }

  // i. Merge fresh + refreshed, newest last_synced_at first.
  const merged = [...freshRows, ...refreshedRows].sort((a, b) => {
    const ta = a.last_synced_at ? Date.parse(a.last_synced_at) : 0;
    const tb = b.last_synced_at ? Date.parse(b.last_synced_at) : 0;
    return tb - ta;
  });

  return jsonResponse(200, cors, {
    source: "cache+salesforce",
    count: merged.length,
    records: merged,
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
