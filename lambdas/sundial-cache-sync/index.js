// sundial-cache-sync — scheduled incremental cache refresh (SystemModstamp watermarks).
//
// TRUSTED SERVER-SIDE INFRASTRUCTURE. There is NO per-request user or token: this
// runs system-wide across ALL tenants (typically on an EventBridge schedule, or
// invoked manually). It keeps the Supabase cache current for records changed
// DIRECTLY in Salesforce — changes the read-time freshness path can't catch for
// records nobody happens to view.
//
// v1 SCOPE: CHANGED and NEW records only. DELETE-DETECTION IS DEFERRED — a record
// deleted in Salesforce is NOT removed from the cache by this job (a future v2
// reconciliation pass, or the read-time single-record 404 path, handles that).
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

// --- Sync tuning -----------------------------------------------------------
const SYNC_STATE_TABLE = "sundial_sync_state";
// Max records pulled per object per run. A batch that fills this is fine for v1:
// the watermark advances to the last processed record, and the next run continues.
const BATCH_LIMIT = 2000;
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

// Select ONLY cache-backed fields (+ Id + Client__c, always retained).
function buildCacheSelect(fields, columnSet) {
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
async function syncObject(supabase, objectKey) {
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

  const { fields } = await getQueryableFields(entry.sfObject);
  const { selectFields } = buildCacheSelect(fields, columnSet);

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
  const soql =
    `SELECT ${syncSelectList} FROM ${entry.sfObject} ` +
    `WHERE SystemModstamp > ${watermarkIso} ` +
    `ORDER BY SystemModstamp ASC ` +
    `LIMIT ${BATCH_LIMIT}`;
  const records = await sfQuery(soql);

  if (!records || records.length === 0) {
    await writeSyncState(supabase, objectKey, { modstamp: null, status: "ok", count: 0 });
    return { processed: 0, skipped: 0, newWatermark: watermarkIso, status: "ok" };
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
      newWatermark,
      status: "ok",
      batchFull: records.length >= BATCH_LIMIT,
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

  // Per-object try/catch so one object's failure doesn't abort the rest.
  for (const objectKey of objectKeys) {
    try {
      summary.objects[objectKey] = await syncObject(supabase, objectKey);
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
