// The Welcome Call write path: Salesforce -> Supabase cache -> Realtime broadcast.
//
// This mirrors sundial-sf-update's write path exactly, in the same order and with the
// same failure semantics:
//
//   1. Salesforce is written FIRST and is the only step allowed to fail the
//      operation. If it fails, nothing downstream runs — no partial writes
//      (docs/caching-architecture.md, "Write Path").
//   2. The cache row is touched BEST-EFFORT and tenant-scoped. sundial-sf-update
//      flags `is_stale = true` rather than trusting a hand-built row; we do the same,
//      and additionally write the three welcome-call columns WHEN THE CACHE TABLE HAS
//      THEM, so a cache-only reader sees the new status immediately. A cache failure
//      is logged and swallowed — it can never fail a write Salesforce accepted.
//   3. The Realtime broadcast is best-effort for the same reason.
//
// The one thing that is genuinely new here is the LOG FIELD, which is
// read-modify-write on a 32,768-char textarea. See prependLogLine().

import { sfUpdateRecord } from "../../lib/salesforce.js";
import { getSupabaseClient, getSupabaseConfig } from "../../lib/supabase.js";
import { broadcast, recordChannel } from "../../lib/realtime.js";

export const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";
export const CUSTOMER_CACHE_TABLE = "sundial_customer_cache";
export const CUSTOMER_CHANNEL_OBJECT = "sundial_customer";

// Fallback capacity for Welcome_Call_Log__c, used only when the describe doesn't
// report a length. The field is 131,072 in the org (Salesforce's long-text maximum),
// but the REAL number is read from the describe at call time — hardcoding it is how a
// field resize silently becomes either wasted capacity or a rejected PATCH.
export const LOG_FIELD_MAX_CHARS = 131072;

/** Start-of-line marker that begins each result entry (webhook.js » ENTRY_MARKER). */
const ENTRY_MARKER = "── ";
const TRIM_NOTICE = "… older entries trimmed …";

/**
 * Split a log field back into whole entries, newest first.
 *
 * An entry starts at a line beginning with the marker. Anything before the first
 * marker is legacy single-line history from before the block format — it is kept as
 * one leading chunk rather than discarded, so upgrading the format doesn't erase what
 * came before it.
 */
function splitEntries(text) {
  const lines = String(text ?? "").split("\n");
  const entries = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith(ENTRY_MARKER)) {
      if (current !== null) entries.push(current);
      current = line;
    } else if (current === null) {
      // Leading legacy content (or a stray trim notice we're about to rewrite).
      if (line.trim() === TRIM_NOTICE) continue;
      entries.push(line);
    } else {
      current += `\n${line}`;
    }
  }
  if (current !== null) entries.push(current);
  return entries.filter((e) => e.trim() !== "");
}

/**
 * Put the newest ENTRY at the TOP of the log, dropping whole entries from the BOTTOM
 * when the field would overflow.
 *
 * Newest-first is deliberate: the field is read in a Salesforce viewer that shows the
 * first lines, and the last thing that happened is what a human needs. It also means
 * overflow discards the OLDEST history, which is the half you can afford to lose.
 *
 * WHOLE ENTRIES, NOT CHARACTERS. The previous version clipped at a line boundary,
 * which could leave a half-entry — a header with no analysis under it, or analysis
 * lines with no header saying which call they belonged to. Both are worse than a
 * missing entry, because they read as real data. When anything is dropped, a single
 * `… older entries trimmed …` line marks the cut so the gap is visible.
 *
 * The NEW entry is never truncated. If a single entry somehow exceeded the whole
 * field — impossible with real Retell payloads, since even a verbose analysis is a few
 * kB against 131,072 — it is hard-clipped as an absolute last resort, because a
 * rejected PATCH would lose the status update too. That case logs loudly.
 *
 * @param {string|null} existing
 * @param {string} entry     - the new entry (may be multi-line)
 * @param {number} [maxChars] - from the describe; falls back to the constant
 */
export function prependLogEntry(existing, entry, maxChars = LOG_FIELD_MAX_CHARS) {
  const max = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : LOG_FIELD_MAX_CHARS;
  const prior = typeof existing === "string" ? existing : "";

  if (entry.length > max) {
    console.error(
      `welcome-call: a single log entry (${entry.length} chars) exceeds the ` +
        `Welcome_Call_Log__c capacity (${max}) — hard-clipping it to keep the ` +
        `status update from being rejected. Investigate the payload.`
    );
    return entry.slice(0, max);
  }

  const combined = prior.trim() === "" ? entry : `${entry}\n${prior}`;
  if (combined.length <= max) return combined;

  // Drop whole entries from the oldest end until the new one fits alongside the
  // notice. `kept` never includes the new entry, which is prepended at the end.
  const older = splitEntries(prior);
  while (older.length > 0) {
    older.pop();
    const candidate = [entry, ...older, TRIM_NOTICE].join("\n");
    if (candidate.length <= max) return candidate;
  }
  // Everything old had to go.
  const bare = `${entry}\n${TRIM_NOTICE}`;
  return bare.length <= max ? bare : entry;
}

// --- Cache column introspection --------------------------------------------
// Which columns does sundial_customer_cache actually have? Read from PostgREST's
// OpenAPI document, the same source sundial-cache-sync uses (its own copy of this
// helper lives in lambdas/sundial-cache-sync/index.js). Cached in module scope.
//
// WHY BOTHER: the welcome-call columns may not exist in a given tenant's cache table
// yet. Sending an unknown column makes PostgREST reject the ENTIRE update, which
// would also drop the `is_stale` flag and leave the cache serving a stale status
// with no signal to refresh. Asking first costs one cold-start request.
let cacheColumnsPromise = null;

export async function getCacheColumns(table = CUSTOMER_CACHE_TABLE) {
  if (!cacheColumnsPromise) {
    cacheColumnsPromise = (async () => {
      const cfg = await getSupabaseConfig();
      const resp = await fetch(`${String(cfg.url).replace(/\/+$/, "")}/rest/v1/`, {
        headers: {
          apikey: cfg.serviceRoleKey,
          Authorization: `Bearer ${cfg.serviceRoleKey}`,
        },
      });
      if (!resp.ok) throw new Error(`OpenAPI fetch failed (${resp.status})`);
      return resp.json();
    })();
  }
  try {
    const spec = await cacheColumnsPromise;
    const def = spec?.definitions?.[table] || spec?.components?.schemas?.[table];
    return new Set(def?.properties ? Object.keys(def.properties) : []);
  } catch (e) {
    // Not fatal: fall back to the is_stale-only update, which is what
    // sundial-sf-update does unconditionally.
    cacheColumnsPromise = null; // don't cache the failure
    console.warn("welcome-call: cache column introspection failed:", e?.message || e);
    return new Set();
  }
}

/** Reset the introspection cache (tests). */
export function clearCacheColumnCache() {
  cacheColumnsPromise = null;
}

/**
 * Apply one Welcome Call state change end to end.
 *
 * @param {object} args
 * @param {string} args.recordId      - Sundial_Customer__c id
 * @param {string|null} args.tenantId - the record's OWN Client__c (no caller tenant
 *                                      exists on either entry point, so the record
 *                                      scopes itself — same as sundial-aurora-inbound)
 * @param {object} args.sfFields      - { ApiName__c: value } to PATCH
 * @param {object} args.cacheValues   - { column: value } to write when present
 * @param {object} [args.broadcastPayload] - extra context for subscribed clients
 * @returns {Promise<{ ok: true, cache: string, realtime: boolean }>}
 * @throws only if the SALESFORCE write fails (the caller decides the HTTP status)
 */
export async function applyWelcomeCallUpdate({
  recordId,
  tenantId,
  sfFields,
  cacheValues = {},
  broadcastPayload = {},
}) {
  // 1) Salesforce first. A throw here aborts the whole update — no partial writes.
  await sfUpdateRecord(CUSTOMER_SF_OBJECT, recordId, sfFields);

  // 2) Cache — best effort, tenant-scoped, never fails the write.
  let cacheResult = "skipped";
  try {
    const columns = await getCacheColumns();
    const patch = {};
    for (const [col, val] of Object.entries(cacheValues)) {
      if (columns.has(col)) patch[col] = val;
    }
    if (columns.has("is_stale")) patch.is_stale = true;

    if (Object.keys(patch).length > 0) {
      const supabase = await getSupabaseClient();
      let q = supabase.from(CUSTOMER_CACHE_TABLE).update(patch).eq("sf_id", recordId);
      // Defense in depth (the service-role key bypasses RLS): scope to the record's
      // own tenant when we know it. A missing cache row is a harmless no-op.
      if (tenantId) q = q.eq("client_sf_id", tenantId);
      const { error } = await q;
      if (error) {
        console.error("welcome-call cache update error:", error.message);
        cacheResult = "failed";
      } else {
        cacheResult = Object.keys(patch).join(",");
      }
    }
  } catch (e) {
    console.error("welcome-call cache update threw:", e?.message || String(e));
    cacheResult = "failed";
  }

  // 3) Realtime — best effort. Carries the changed values so a subscribed client can
  //    apply them without a round trip (docs/caching-architecture.md).
  let realtimeOk = false;
  if (tenantId) {
    const res = await broadcast(
      recordChannel(tenantId, CUSTOMER_CHANNEL_OBJECT, recordId),
      "welcome_call_updated",
      { sf_id: recordId, object: CUSTOMER_SF_OBJECT, fields: sfFields, ...broadcastPayload }
    );
    realtimeOk = res.ok === true;
    if (!res.ok) console.warn("welcome-call realtime broadcast skipped:", res.reason);
  }

  return { ok: true, cache: cacheResult, realtime: realtimeOk };
}
