// sundial-cache-sync — scheduled incremental cache refresh (SystemModstamp watermarks).
//
// TRUSTED SERVER-SIDE INFRASTRUCTURE. There is NO per-request user or token: this
// runs system-wide across ALL tenants (typically on an EventBridge schedule, or
// invoked manually). It keeps the Supabase cache current for records changed
// DIRECTLY in Salesforce — changes the read-time freshness path can't catch for
// records nobody happens to view.
//
// MODES:
//   - incremental (default): CHANGED and NEW records since the per-object
//     SystemModstamp watermark (bounded first-run lookback). Meant for the
//     EventBridge schedule.
//   - full resync: invoke with { "mode": "full" } (optionally + { "object": ... })
//     to ignore the watermark window and pull EVERY record for the object(s).
//     Use this to backfill after a bulk data load whose records fall outside the
//     incremental window, or whenever the cache count has drifted below Salesforce.
//     Idempotent (upsert on sf_id) — safe to re-run.
//
//   - reconcile: invoke with { "mode": "reconcile" } (optionally + { "object": ... },
//     { "dryRun": true }, { "force": true }) to DELETE cache rows whose Salesforce
//     record no longer exists. MANUAL INVOKE ONLY — not on any schedule. This is the
//     only destructive mode here; see reconcileObject for the safety rails.
//
// Both sync modes follow the Salesforce query locator to exhaustion (via sfQuery),
// so a single run captures the whole result set rather than one 2000-row page.
//
// DELETES DO NOT PROPAGATE ON THE SYNC PATH — by construction. Both incremental and
// full are UPSERT-ONLY, and a deleted record simply stops appearing in the SOQL
// result, which is indistinguishable from "unchanged" to an upsert. A record deleted
// in Salesforce therefore lingers in the cache as a GHOST: still listed, still in
// `total`, until someone opens it and the read path 404s. `mode: "reconcile"` is the
// bulk sweep that removes them.
//
// TENANT CORRECTNESS: the Salesforce query is intentionally CROSS-TENANT (no
// Client__c filter) BY DESIGN — the job refreshes every tenant. Each row is then
// written under the Client__c that CAME FROM Salesforce on that record; the tenant
// key is never blanked or cross-assigned. Records with a null Client__c are
// skipped (never write a tenant-less cache row).
//
// Value-safety: never logs or returns tokens, secrets, key material, or record
// field data — only object keys, counts, statuses, and watermarks.
//
// NOTE: the cache-mapping and column-introspection helpers below deliberately
// MIRROR sundial-sf-query/index.js (same logic, kept in sync by hand) so this new
// Lambda stays isolated from the proven read Lambda. If a third consumer appears,
// promote these to a shared lib/ module.

import { getSalesforceToken, sfQuery } from "../../lib/salesforce.js";
import { getSupabaseClient, getSupabaseConfig } from "../../lib/supabase.js";

// --- Object allowlist / map (mirrors sundial-sf-query) ---------------------
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

// Ordered list of Salesforce fields that populate each object's `created_date`
// cache column (the list-ordering key: newest first) — the FIRST non-empty value
// wins (a COALESCE). Most objects use the standard CreatedDate; Solar prefers
// Contract_Date__c and falls back to CreatedDate (3,025 of 4,545 solar rows have no
// Contract_Date__c). Only applied when the cache table has a `created_date` column.
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

// First non-empty source value for a record (the COALESCE), or null.
function resolveCreatedDate(record, sources) {
  for (const name of sources || []) {
    const v = record[name];
    if (v != null && v !== "") return v;
  }
  return null;
}

// --- Sync tuning -----------------------------------------------------------
const SYNC_STATE_TABLE = "sundial_sync_state";
// First-run backstop when an object has no stored watermark: only look back this
// far, so the first run is bounded (not an unbounded full-history scan). Chosen
// value: 24h. Trade-off noted in the runbook — records changed longer ago than
// this that were never viewed are picked up on their next SF change, or via reads.
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours
// Chunk sizes for Supabase round-trips (keep URLs/payloads sane).
const UPSERT_CHUNK = 500;
const VERSION_FETCH_CHUNK = 500;

// --- Salesforce describe (module-scope cached per object) ------------------
const rawDescribeCache = new Map();
const describeCache = new Map();
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

// --- SF record -> cache row mapping (mirrors sundial-sf-query) --------------
function sfFieldToColumn(field) {
  let base = field.name.replace(/__c$/i, "").toLowerCase();
  if (field.type === "reference") base += "_sf_id";
  return base;
}

// Select ONLY cache-backed fields (+ Id + Client__c, always retained). When the
// cache table has a `created_date` column, also force-include EVERY created-date
// source field (e.g. Contract_Date__c, CreatedDate) — their own sfFieldToColumn
// names aren't cache columns, so they wouldn't otherwise be selected, but the
// mapper reads them to populate created_date (first non-empty wins).
function buildCacheSelect(fields, columnSet, createdDateSources) {
  const REQUIRED = new Set(["Id", "Client__c"]);
  const selectFields = fields.filter(
    (f) => REQUIRED.has(f.name) || columnSet.has(sfFieldToColumn(f))
  );
  for (const name of REQUIRED) {
    if (!selectFields.some((f) => f.name === name)) {
      const orig = fields.find((f) => f.name === name);
      if (orig) selectFields.push(orig);
    }
  }
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
  // Control columns are authoritative. TENANT values come from the RECORD'S OWN
  // Client__c (ctx.tenantId), passed per-record by the caller — never a global.
  row.sf_id = record.Id;
  if (columnSet.has("tenant_id")) row.tenant_id = ctx.tenantSlug ?? null;
  row.client_sf_id = ctx.tenantId; // isolation key (per-record)
  // List-ordering key: created_date = first non-empty source value (COALESCE of
  // e.g. Contract_Date__c, CreatedDate). Always written when the column exists
  // (null when all sources empty) so a batch's column set is consistent and a
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

// Batch-fetch existing cache_version for a set of sf_ids (keyed on the globally
// unique sf_id; no tenant filter needed for a version lookup). Chunked.
async function getExistingCacheVersions(supabase, table, sfIds) {
  const map = new Map();
  for (let i = 0; i < sfIds.length; i += VERSION_FETCH_CHUNK) {
    const chunk = sfIds.slice(i, i + VERSION_FETCH_CHUNK);
    const { data, error } = await supabase
      .from(table)
      .select("sf_id, cache_version")
      .in("sf_id", chunk);
    if (error) {
      // Treat as all-new (version 0). Not fatal to the sync.
      console.error(`cache-sync version prefetch error (${table}):`, error.message);
      continue;
    }
    for (const r of data || []) map.set(r.sf_id, r.cache_version ?? 0);
  }
  return map;
}

// --- Reconcile (delete-detection) tuning -----------------------------------
// Ids per SOQL `Id IN (...)`. The REST query endpoint is a GET, so the whole SOQL
// travels in the URL and Salesforce caps that around 16 KB. URL-encoding inflates
// each id to ~24 bytes ('a1Q...' -> %27a1Q...%27%2C), so 400 ids is ~9.6 KB — a
// deliberate margin under the cap. Raising this risks a 414/malformed query, not a
// slow one.
const RECONCILE_ID_CHUNK_SIZE = 400;
// Cache ids read per PostgREST request (its "Max Rows" ceiling; it silently
// truncates past this, so never raise without raising the dashboard setting too).
const RECONCILE_CACHE_PAGE = 1000;
// Ghost ids per DELETE. `.in()` serializes every id into the request URL.
const RECONCILE_DELETE_CHUNK = 500;
// SAFETY RAIL. If more than this fraction of an object's cache looks absent from
// Salesforce, something systemic is wrong — the integration user lost read access,
// the wrong object was targeted, a permission set changed — and the honest response
// is to refuse rather than empty the cache. Override per-run with { force: true }
// once the count has been eyeballed. A genuine ghost set is a handful of rows.
const RECONCILE_MAX_GHOST_RATIO = 0.2;
// ...but the ratio ALONE is the wrong test on a small cache: one ghost out of two
// rows is 50% and perfectly ordinary, and the roofing cache currently holds a single
// row where any ghost is 100%. The rail exists to catch a MASS wipeout, so it only
// engages once the absolute count is big enough to be alarming. Below this, a purge
// proceeds regardless of ratio.
const RECONCILE_MIN_GHOSTS_FOR_RATIO_GUARD = 25;

// Salesforce ids come in 15-char (case-sensitive) and 18-char (case-insensitive,
// 3-char checksum suffix) forms, and BOTH are valid for the same record. The cache
// may hold either depending on what wrote the row, and Salesforce always returns
// 18. Comparing on the first 15 characters is the correct normalization: those 15
// are the unique, case-sensitive key and the suffix is derived from them. The
// comparison stays case-SENSITIVE on purpose — two distinct records can differ only
// by case in the 15-char form, which is the very reason the 18-char form exists.
function idKey(id) {
  return String(id).slice(0, 15);
}

// Read every sf_id in a cache table, paged under PostgREST's row ceiling.
// Returns the ids AS STORED, so deletes can target the exact stored value.
async function fetchAllCacheIds(supabase, table) {
  const ids = [];
  for (let from = 0; ; from += RECONCILE_CACHE_PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select("sf_id")
      .range(from, from + RECONCILE_CACHE_PAGE - 1);
    if (error) throw new Error(`cache id read failed (${table}): ${error.message}`);
    const batch = data || [];
    for (const r of batch) if (r.sf_id) ids.push(r.sf_id);
    if (batch.length < RECONCILE_CACHE_PAGE) break; // short read -> end of table
  }
  return ids;
}

// --- RECONCILE: purge cache rows whose Salesforce record no longer exists ----
// THE BLIND SPOT THIS CLOSES: both sync modes are UPSERT-ONLY. A record deleted in
// Salesforce is never removed from the cache by them, so it lingers as a "ghost" —
// still listed in the portal, still counted in `total` — until someone opens it and
// the read path 404s. Reconcile is the sweep that removes them in bulk.
//
// DIRECTION OF THE CHECK MATTERS. We ask Salesforce "which of THESE cache ids still
// exist" in batches, rather than pulling every Id and diffing. It costs more API
// calls, but it FAILS SAFE: if a batch errors, those ids are simply left alone. The
// diff approach would treat an incomplete Salesforce result as "everything is a
// ghost" and delete a live cache — an unacceptable failure mode for a destructive
// job.
//
// A record present in Salesforce under a DIFFERENT tenant is NOT a ghost — existence
// is the only test here. Tenant moves are the upsert path's job.
//
// Deliberately does NOT touch the sync watermark: reconcile is orthogonal to the
// incremental cursor and must never cause a window to be skipped.
async function reconcileObject(supabase, objectKey, { dryRun = false, force = false } = {}) {
  const entry = OBJECT_ALLOWLIST[objectKey];

  const cacheIds = await fetchAllCacheIds(supabase, entry.cacheTable);
  if (cacheIds.length === 0) {
    return {
      mode: "reconcile", status: "ok", cacheRows: 0, checked: 0,
      liveInSalesforce: 0, ghosts: 0, deleted: 0, soqlQueries: 0, dryRun,
    };
  }

  // Ask Salesforce which of these ids still exist, in URL-safe batches.
  const liveKeys = new Set();
  const unverifiedKeys = new Set(); // ids in a batch that errored — never deleted
  let soqlQueries = 0;
  for (let i = 0; i < cacheIds.length; i += RECONCILE_ID_CHUNK_SIZE) {
    const chunk = cacheIds.slice(i, i + RECONCILE_ID_CHUNK_SIZE);
    const quoted = chunk.map((id) => `'${String(id).replace(/'/g, "\\'")}'`).join(", ");
    try {
      // Plain query (NOT queryAll): a soft-deleted record sitting in the Recycle Bin
      // is gone from every read path, so it should be treated as a ghost.
      const rows = await sfQuery(`SELECT Id FROM ${entry.sfObject} WHERE Id IN (${quoted})`);
      soqlQueries++;
      for (const r of rows || []) liveKeys.add(idKey(r.Id));
    } catch (e) {
      soqlQueries++;
      console.error(
        `cache-sync reconcile: ${objectKey} batch at offset ${i} failed, leaving those ${chunk.length} id(s) alone:`,
        e?.message || String(e)
      );
      for (const id of chunk) unverifiedKeys.add(idKey(id));
    }
  }

  // A ghost is a cache id Salesforce did NOT return, and whose batch succeeded.
  const ghosts = cacheIds.filter(
    (id) => !liveKeys.has(idKey(id)) && !unverifiedKeys.has(idKey(id))
  );
  const checked = cacheIds.length - unverifiedKeys.size;

  const base = {
    mode: "reconcile",
    cacheRows: cacheIds.length,
    checked,
    unverified: unverifiedKeys.size,
    liveInSalesforce: liveKeys.size,
    ghosts: ghosts.length,
    soqlQueries,
    dryRun,
  };

  // Safety rail — refuse a MASS purge unless explicitly forced. Both conditions
  // must hold: a high proportion AND enough rows for that proportion to mean
  // anything (see RECONCILE_MIN_GHOSTS_FOR_RATIO_GUARD).
  const ratio = checked > 0 ? ghosts.length / checked : 0;
  if (
    !force &&
    ghosts.length >= RECONCILE_MIN_GHOSTS_FOR_RATIO_GUARD &&
    ratio > RECONCILE_MAX_GHOST_RATIO
  ) {
    console.error(
      `cache-sync reconcile: ${objectKey} — ${ghosts.length}/${checked} rows ` +
        `(${(ratio * 100).toFixed(1)}%) look absent from Salesforce, above the ` +
        `${(RECONCILE_MAX_GHOST_RATIO * 100).toFixed(0)}% safety threshold. REFUSING to delete. ` +
        `Verify the object and the integration user's access, then re-run with { "force": true } if correct.`
    );
    return { ...base, deleted: 0, status: "refused_ghost_ratio", ghostRatio: Number(ratio.toFixed(4)) };
  }

  if (ghosts.length === 0) return { ...base, deleted: 0, status: "ok" };
  if (dryRun) return { ...base, deleted: 0, status: "ok_dry_run", sampleGhosts: ghosts.slice(0, 20) };

  // Delete by the EXACT stored id so both 15- and 18-char rows are removed.
  let deleted = 0;
  for (let i = 0; i < ghosts.length; i += RECONCILE_DELETE_CHUNK) {
    const chunk = ghosts.slice(i, i + RECONCILE_DELETE_CHUNK);
    const { data, error } = await supabase
      .from(entry.cacheTable)
      .delete()
      .in("sf_id", chunk)
      .select("sf_id");
    if (error) {
      console.error(`cache-sync reconcile delete error (${objectKey}):`, error.message);
      return { ...base, deleted, status: "error", error: error.message };
    }
    deleted += (data || []).length;
  }

  console.log(
    `cache-sync reconcile: ${objectKey} purged ${deleted} ghost row(s) of ${cacheIds.length} cached.`
  );
  return { ...base, deleted, status: "ok" };
}

// --- Watermark state -------------------------------------------------------
async function readWatermark(supabase, objectKey) {
  const { data, error } = await supabase
    .from(SYNC_STATE_TABLE)
    .select("last_synced_modstamp")
    .eq("object_key", objectKey)
    .maybeSingle();
  if (error) {
    console.error(`cache-sync watermark read error (${objectKey}):`, error.message);
    return null;
  }
  return data?.last_synced_modstamp ?? null;
}

// Upsert the per-object run state. last_synced_modstamp is ONLY written when a
// non-null modstamp is supplied — on error we update run metadata but leave the
// watermark untouched so the next run retries the same window.
async function writeSyncState(supabase, objectKey, { modstamp, status, count }) {
  const row = {
    object_key: objectKey,
    last_run_at: new Date().toISOString(),
    last_run_status: status,
    last_run_count: count ?? 0,
  };
  if (modstamp != null) row.last_synced_modstamp = modstamp;
  const { error } = await supabase
    .from(SYNC_STATE_TABLE)
    .upsert(row, { onConflict: "object_key" });
  if (error) throw new Error(`sync-state write failed (${objectKey}): ${error.message}`);
}

// --- Per-object sync -------------------------------------------------------
// full=false (default): incremental — only records changed since the watermark
//   (or the bounded first-run lookback).
// full=true: FULL RESYNC — ignores the incremental window entirely and pulls
//   EVERY record for the object. Use this to backfill after a bulk load whose
//   records fall outside the incremental window, or whenever the cache count has
//   drifted below Salesforce. Still cross-tenant; each row's own Client__c drives
//   its cache tenant. Idempotent (upsert on sf_id), so it's safe to re-run.
async function syncObject(supabase, objectKey, { full = false } = {}) {
  const entry = OBJECT_ALLOWLIST[objectKey];
  const columnSet = await getCacheColumns(entry.cacheTable);

  // Graceful skip: an unknown/malformed cache table, or one missing the tenant
  // isolation key, cannot be safely written. No error — just skip.
  if (columnSet.size === 0 || !columnSet.has("client_sf_id")) {
    console.warn(
      `cache-sync: ${objectKey} cache table ${entry.cacheTable} has no usable columns (or no client_sf_id) — skipping.`
    );
    const status = "skipped_no_columns";
    await writeSyncState(supabase, objectKey, { modstamp: null, status, count: 0 });
    return { processed: 0, newWatermark: null, status };
  }

  const createdDateSources =
    CREATED_DATE_SOURCE[objectKey] ?? DEFAULT_CREATED_DATE_SOURCE;
  const { fields } = await getQueryableFields(entry.sfObject);
  const { selectFields } = buildCacheSelect(fields, columnSet, createdDateSources);

  // Sync SELECT = cache-backed fields + SystemModstamp (watermark) + Client__r.Name
  // (tenant slug for the tenant_id column). Dedupe so nothing is selected twice.
  const names = selectFields.map((f) => f.name);
  const seen = new Set(names.map((n) => n.toLowerCase()));
  for (const extra of ["SystemModstamp", "Client__r.Name"]) {
    if (!seen.has(extra.toLowerCase())) {
      names.push(extra);
      seen.add(extra.toLowerCase());
    }
  }
  const syncSelectList = names.join(", ");

  // Watermark, or the bounded first-run backstop (now - 24h). Normalized to an
  // ISO-8601 Z string, which is a valid unquoted SOQL dateTime literal.
  const stored = await readWatermark(supabase, objectKey);
  const watermarkIso = stored
    ? new Date(stored).toISOString()
    : new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString();

  // CROSS-TENANT system query — NO Client__c filter BY DESIGN. Each record still
  // carries its own Client__c, which drives its cache row's tenant below.
  //
  // NO SOQL LIMIT in either mode: sfQuery follows nextRecordsUrl to exhaustion, so
  // a single run captures the WHOLE result set (all ~40k on a full resync, or the
  // entire changed window on an incremental run). This removes the old 2000-per-run
  // cap AND the tie bug where >2000 records sharing one SystemModstamp could be
  // split across a page boundary and partially skipped by the "> watermark" cursor.
  //   - full:        every record for the object (ignores the window).
  //   - incremental: only records changed since the watermark / first-run lookback.
  const soql = full
    ? `SELECT ${syncSelectList} FROM ${entry.sfObject} ORDER BY SystemModstamp ASC`
    : `SELECT ${syncSelectList} FROM ${entry.sfObject} ` +
      `WHERE SystemModstamp > ${watermarkIso} ORDER BY SystemModstamp ASC`;
  const records = await sfQuery(soql);

  if (!records || records.length === 0) {
    await writeSyncState(supabase, objectKey, { modstamp: null, status: "ok", count: 0 });
    return { processed: 0, skipped: 0, fetched: 0, newWatermark: watermarkIso, status: "ok", mode: full ? "full" : "incremental" };
  }

  // Max SystemModstamp across ALL returned records (incl. skipped null-tenant
  // ones) so the watermark can't stall on a window of tenant-less records.
  let maxMs = 0;
  for (const rec of records) {
    const ms = Date.parse(rec.SystemModstamp);
    if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
  }
  const newWatermark = new Date(maxMs).toISOString();

  // Skip records with a null Client__c — never write a tenant-less cache row.
  const valid = [];
  let skipped = 0;
  for (const rec of records) {
    if (!rec.Client__c) {
      skipped++;
      continue;
    }
    valid.push(rec);
  }
  if (skipped > 0) {
    console.warn(`cache-sync: ${objectKey} skipped ${skipped} record(s) with null Client__c.`);
  }

  const nowIso = new Date().toISOString();
  const hasVersion = columnSet.has("cache_version");
  const versionMap = hasVersion
    ? await getExistingCacheVersions(
        supabase,
        entry.cacheTable,
        valid.map((r) => r.Id)
      )
    : new Map();

  const rows = valid.map((rec) =>
    mapSfRecordToCacheRow(rec, selectFields, columnSet, {
      tenantId: rec.Client__c, // per-record isolation key straight from Salesforce
      tenantSlug: rec.Client__r?.Name ?? null, // human label only
      now: nowIso,
      cacheVersion: hasVersion ? (versionMap.get(rec.Id) ?? 0) + 1 : null,
      createdDateSources,
    })
  );

  // Idempotent upsert keyed on sf_id (chunked). A re-run of the same window is
  // harmless because these are upserts, not inserts.
  let writeOk = true;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    try {
      const { error } = await supabase
        .from(entry.cacheTable)
        .upsert(chunk, { onConflict: "sf_id" });
      if (error) {
        writeOk = false;
        console.error(`cache-sync upsert error (${objectKey}):`, error.message);
        break;
      }
    } catch (e) {
      writeOk = false;
      console.error(`cache-sync upsert threw (${objectKey}):`, e?.message || String(e));
      break;
    }
  }

  // Advance the watermark ONLY on a clean write, and only to the DATA's own max
  // SystemModstamp (never "now") so nothing between the last record and now is
  // skipped. On a write failure, leave the watermark so the next run retries.
  if (writeOk) {
    await writeSyncState(supabase, objectKey, {
      modstamp: newWatermark,
      status: "ok",
      count: valid.length,
    });
    return {
      processed: valid.length,
      skipped,
      fetched: records.length,
      newWatermark,
      status: "ok",
      mode: full ? "full" : "incremental",
    };
  }

  await writeSyncState(supabase, objectKey, { modstamp: null, status: "error", count: 0 });
  return {
    processed: 0,
    skipped,
    newWatermark: watermarkIso, // unchanged
    status: "error",
    error: "cache_upsert_failed",
  };
}

// --- handler ---------------------------------------------------------------
// Suitable for an empty/scheduled EventBridge event (no input required). For
// manual testing, pass { "object": "solar" } to sync a single object; with no
// object, all five are synced. One object's failure never aborts the others.
export const handler = async (event) => {
  const summary = { startedAt: new Date().toISOString(), objects: {} };

  let supabase;
  try {
    supabase = await getSupabaseClient();
  } catch (e) {
    console.error("cache-sync: failed to init Supabase client:", e?.message || String(e));
    return { ok: false, error: "SUPABASE_INIT_FAILED" };
  }

  // Preflight: the watermark state table MUST exist. We do NOT create it from
  // the Lambda — fail with a clear, actionable log instead.
  const probe = await supabase
    .from(SYNC_STATE_TABLE)
    .select("object_key")
    .limit(1);
  if (probe.error) {
    console.error(
      `cache-sync: '${SYNC_STATE_TABLE}' is unavailable — create it in Supabase before running ` +
        `(see the CREATE TABLE SQL in the sundial-cache-sync runbook). Detail: ${probe.error.message}`
    );
    return {
      ok: false,
      error: "SYNC_STATE_TABLE_MISSING",
      message: `Create the '${SYNC_STATE_TABLE}' table in Supabase before running this job.`,
      detail: probe.error.message,
    };
  }

  // Which objects to sync?
  const requested = event?.object;
  let objectKeys;
  if (requested) {
    if (!OBJECT_ALLOWLIST[requested]) {
      return { ok: false, error: "OBJECT_NOT_ALLOWED", object: requested };
    }
    objectKeys = [requested];
  } else {
    objectKeys = Object.keys(OBJECT_ALLOWLIST);
  }

  // FULL RESYNC toggle: { "mode": "full" } (or { "full": true }) ignores the
  // incremental watermark window and pulls EVERY record for each selected object.
  // Combine with { "object": "customer" } to full-resync one object. Safe to
  // re-run (idempotent upserts). Absent this flag, runs are incremental as before.
  const full = event?.mode === "full" || event?.full === true;

  // RECONCILE (delete-detection): { "mode": "reconcile" }, optionally with
  // { "object": ... }, { "dryRun": true } to report without deleting, and
  // { "force": true } to override the mass-purge safety rail.
  //
  // MANUAL INVOKE ONLY — deliberately NOT on any EventBridge schedule. It is the
  // only destructive path in this Lambda, and its API cost scales with cache size
  // (one SOQL per 400 cached rows: ~79 queries for the 31.6k customer cache, ~12
  // for solar). Adding it to a schedule is a decision to be made explicitly, not a
  // side effect of it existing.
  if (event?.mode === "reconcile") {
    summary.mode = "reconcile";
    summary.dryRun = event?.dryRun === true;
    for (const objectKey of objectKeys) {
      try {
        summary.objects[objectKey] = await reconcileObject(supabase, objectKey, {
          dryRun: event?.dryRun === true,
          force: event?.force === true,
        });
      } catch (e) {
        const msg = e?.message || String(e);
        console.error(`cache-sync reconcile: object ${objectKey} failed:`, msg);
        summary.objects[objectKey] = { mode: "reconcile", deleted: 0, status: "error", error: msg };
      }
    }
    summary.finishedAt = new Date().toISOString();
    console.log("cache-sync reconcile summary:", JSON.stringify(summary));
    return summary;
  }

  summary.mode = full ? "full" : "incremental";

  // Per-object try/catch so one object's failure doesn't abort the rest.
  for (const objectKey of objectKeys) {
    try {
      summary.objects[objectKey] = await syncObject(supabase, objectKey, { full });
    } catch (e) {
      const msg = e?.message || String(e);
      console.error(`cache-sync: object ${objectKey} failed:`, msg);
      summary.objects[objectKey] = { processed: 0, status: "error", error: msg };
      // Best-effort: record the error run without touching the watermark.
      try {
        await writeSyncState(supabase, objectKey, { modstamp: null, status: "error", count: 0 });
      } catch (stateErr) {
        console.error(
          `cache-sync: also failed to record error state for ${objectKey}:`,
          stateErr?.message || String(stateErr)
        );
      }
    }
  }

  summary.finishedAt = new Date().toISOString();
  console.log("cache-sync summary:", JSON.stringify(summary));
  return summary;
};
