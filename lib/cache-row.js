// Salesforce record -> Supabase cache row, shared.
//
// WHY THIS FILE EXISTS (2026-09-29): the mapping below lived in two hand-kept copies —
// sundial-sf-query (read-through) and sundial-cache-sync (scheduled sync) — with a note
// to promote it "if a third consumer appears". sundial-lead-intake is that consumer: a
// TCD lead must show in Sales the moment it is created, not at the next sync, so the
// intake writes the new record's cache row itself.
//
// SCOPE, deliberately narrow: only sundial-lead-intake imports this today. Switching
// sf-query and cache-sync over is a TASKS.md item, done when those two proven Lambdas
// are next deployed for their own reasons. Until then lib/cache-row.test.js runs one
// fixture record through THIS mapper and sf-query's copy and asserts the rows are
// identical, so the copies cannot drift apart silently.
//
// Rules the mapper enforces (unchanged from sf-query):
//   - a column is written only if it exists in the cache table (columnSet);
//   - lookups map to "<name>_sf_id", everything else to the lowercased name minus __c;
//   - control columns (sf_id, tenant_id, client_sf_id) come from the CALLER's tenant
//     context, never from the record.
//
// Value-safety: nothing here logs.

// Describe field types that can never be selected/cached (compound or binary).
export const EXCLUDED_FIELD_TYPES = new Set(["address", "location", "base64"]);

/** Queryable { name, type } fields from a raw describe — what sf-query's getQueryableFields returns. */
export function queryableFields(describe) {
  return (describe?.fields || [])
    .filter((f) => !EXCLUDED_FIELD_TYPES.has(f.type))
    .map((f) => ({ name: f.name, type: f.type }));
}

/** First non-empty source value for a record (the COALESCE behind created_date), or null. */
export function resolveCreatedDate(record, sources) {
  for (const name of sources || []) {
    const v = record[name];
    if (v != null && v !== "") return v;
  }
  return null;
}

/** Cache column name for a Salesforce field. */
export function sfFieldToColumn(field) {
  let base = field.name.replace(/__c$/i, "").toLowerCase();
  if (field.type === "reference") base += "_sf_id";
  return base;
}

/**
 * The SOQL SELECT for a cache row: every field whose column exists, plus Id and
 * Client__c always, plus the created_date source fields when that column exists.
 */
export function buildCacheSelect(fields, columnSet, createdDateSources) {
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

/**
 * Map one Salesforce record onto a cache row.
 * ctx = { tenantId, tenantSlug, createdDateSources, now, cacheVersion? }
 */
export function mapSfRecordToCacheRow(record, fields, columnSet, ctx) {
  const row = {};
  for (const f of fields) {
    if (f.name === "Id") continue;
    const val = record[f.name];
    if (val === undefined || val === null) continue;
    if (typeof val === "object") continue; // nested relationship objects
    const col = sfFieldToColumn(f);
    if (columnSet.has(col)) row[col] = val;
  }
  row.sf_id = record.Id;
  if (columnSet.has("tenant_id")) row.tenant_id = ctx.tenantSlug ?? null;
  row.client_sf_id = ctx.tenantId;
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

/**
 * Which columns does a cache table have? Read from PostgREST's OpenAPI document (the
 * same source sf-query uses). Returns a loader with a per-container cache.
 *
 * @param {{ getSupabaseConfig: () => Promise<{url:string, serviceRoleKey:string}>, fetchImpl?: typeof fetch }} deps
 */
export function createCacheColumnReader({ getSupabaseConfig, fetchImpl = fetch }) {
  let specPromise = null;
  const columns = new Map();
  async function spec() {
    if (!specPromise) {
      specPromise = (async () => {
        const cfg = await getSupabaseConfig();
        const resp = await fetchImpl(`${cfg.url}/rest/v1/`, {
          headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` },
        });
        if (!resp.ok) throw new Error(`OpenAPI fetch failed (${resp.status})`);
        return resp.json();
      })().catch((e) => {
        specPromise = null; // never cache a failure
        throw e;
      });
    }
    return specPromise;
  }
  return async function getCacheColumns(table) {
    if (columns.has(table)) return columns.get(table);
    const s = await spec();
    const def = s?.definitions?.[table] || s?.components?.schemas?.[table];
    const cols = new Set(def?.properties ? Object.keys(def.properties) : []);
    columns.set(table, cols);
    return cols;
  };
}

/**
 * Read ONE record back from Salesforce (tenant-filtered) and upsert its cache row.
 * For a record this Lambda just created, so the version starts at 1.
 *
 * Throws on any failure — callers treat it as best-effort and catch.
 * @returns {Promise<boolean>} true when a row was written
 */
export async function writeRecordToCache({
  supabase, sfQuery, soqlEscapeString, sfObject, cacheTable, fields, columnSet,
  id, tenantId, tenantSlug, createdDateSources, now = new Date().toISOString(),
}) {
  if (!columnSet || columnSet.size === 0) throw new Error(`cache table ${cacheTable} has no columns (missing?)`);
  const { selectFields, selectList } = buildCacheSelect(fields, columnSet, createdDateSources);
  const records = await sfQuery(
    `SELECT ${selectList} FROM ${sfObject} WHERE Id = '${soqlEscapeString(id)}' ` +
      `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
  );
  if (!records?.length) return false;
  const row = mapSfRecordToCacheRow(records[0], selectFields, columnSet, {
    tenantId, tenantSlug, createdDateSources, now, cacheVersion: 1,
  });
  const { error } = await supabase.from(cacheTable).upsert(row, { onConflict: "sf_id" });
  if (error) throw new Error(`cache upsert: ${error.message}`);
  return true;
}
