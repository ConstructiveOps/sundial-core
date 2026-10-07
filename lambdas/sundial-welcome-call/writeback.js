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
import { withRecordLock, RecordLockTimeout, WAIT_MS } from "../../lib/record-lock.js";

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

// --- Chronological insertion (D-082) ----------------------------------------
//
// A call's entry goes where its CALL TIME puts it, newest call at the top — not at the top
// because it was processed last. The rep-form sweep backfills calls hours or days later,
// and two results can be processed in either order; ordering by processing time made the
// voicemail of 9 pm look newer than the conversation of 9:05 pm.
//
// An ITEM is one entry: a line starting with the entry marker or with a log stamp
// ("2026-10-06 21:05 MST · …" — the dialer's "Call placed" lines and the match notes)
// plus the lines under it. An item's time is its `call_at=` (exact, written on every result
// entry since D-082), else its stamp read as Phoenix time (no DST: UTC−7), else unknown.

const STAMP_RE = /^(?:── )?(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})(?: [A-Z]{2,4})? · /;
const CALL_AT_RE = /\bcall_at=(\S+)/;

/** Split a log into items (see above), newest-first as stored. Drops the trim notice. */
export function parseLogItems(text) {
  const items = [];
  for (const line of String(text ?? "").split("\n")) {
    if (line.trim() === TRIM_NOTICE) continue;
    if (line.startsWith(ENTRY_MARKER) || STAMP_RE.test(line) || items.length === 0) items.push(line);
    else items[items.length - 1] += `\n${line}`;
  }
  return items.filter((it) => it.trim() !== "");
}

/** An item's time in ms: its call_at, else its Phoenix stamp, else null. */
export function logItemTime(item) {
  const header = String(item ?? "").split("\n", 1)[0];
  const exact = CALL_AT_RE.exec(header);
  if (exact) {
    const t = Date.parse(exact[1]);
    if (Number.isFinite(t)) return t;
  }
  const m = STAMP_RE.exec(header);
  if (m) {
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00-07:00`);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Insert `entry` at its call-time position: above the first item whose time is at or
 * before `callAtMs` (so of two calls the later one heads the log; a tie puts the newly
 * processed one above). Items with no readable time are passed over. No `callAtMs` →
 * the top, as prependLogEntry. Capacity is managed exactly like prependLogEntry: whole
 * OLDEST items are dropped from the bottom, never the new entry, and the cut is marked.
 */
export function insertLogEntryByTime(existing, entry, callAtMs, maxChars = LOG_FIELD_MAX_CHARS) {
  const max = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : LOG_FIELD_MAX_CHARS;
  if (!Number.isFinite(callAtMs)) return prependLogEntry(existing, entry, max);
  if (entry.length > max) return prependLogEntry(existing, entry, max); // its hard-clip path, logged there
  const items = parseLogItems(existing);
  let at = items.findIndex((it) => {
    const t = logItemTime(it);
    return t != null && t <= callAtMs;
  });
  if (at < 0) at = items.length;
  const list = [...items.slice(0, at), entry, ...items.slice(at)];
  const whole = list.join("\n");
  if (whole.length <= max) return whole;
  // Drop the oldest items (bottom first), never the new entry.
  const keep = [...list];
  for (let i = keep.length - 1; i >= 0; i--) {
    if (keep[i] === entry) continue;
    keep.splice(i, 1);
    const candidate = [...keep, TRIM_NOTICE].join("\n");
    if (candidate.length <= max) return candidate;
  }
  const bare = `${entry}\n${TRIM_NOTICE}`;
  return bare.length <= max ? bare : entry;
}

// --- The per-record write lock (D-082) --------------------------------------
//
// Every Welcome Call read → merge → write of Welcome_Call_Status__c / Welcome_Call_Log__c
// runs through lockedWelcomeCallUpdate: take the record's lock (lib/record-lock.js), READ
// THE RECORD AGAIN, let the caller merge into what is there NOW, write, release. The lock
// is keyed on the 15-character id so a 15- and an 18-character spelling of one record
// share it. A lock not acquired within the wait throws RecordLockTimeout — nothing is
// written; the entry points answer 409 (the Zap's sweep) or 503 (Retell's webhook) so the
// caller retries instead of anyone writing a merge built on stale data.

export function welcomeCallLockKey(recordId) {
  return `welcome-call:${String(recordId ?? "").trim().slice(0, 15)}`;
}

/** Lock wait in ms: WELCOME_CALL_LOCK_WAIT_MS when set (tests, tuning), else the library's 30 s. */
function lockWaitMs() {
  const n = Number(process.env.WELCOME_CALL_LOCK_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? n : WAIT_MS;
}

/**
 * @param {object} args
 * @param {string} args.recordId
 * @param {() => Promise<object|null>} args.read  - the fresh read, run INSIDE the lock
 * @param {(record: object) => Promise<object|null>|object|null} args.plan
 *   - returns null / { skip: true, outcome } to write nothing, else
 *     { sfFields, cacheValues, broadcastPayload, tenantId, outcome }
 * @returns {Promise<{ written: boolean, outcome: object, applied?: object, record?: object }>}
 * @throws {RecordLockTimeout} the lock was not acquired (nothing written)
 * @throws the Salesforce error, when the write itself failed
 */
export async function lockedWelcomeCallUpdate({ recordId, read, plan }) {
  return withRecordLock(
    welcomeCallLockKey(recordId),
    async () => {
      const fresh = await read();
      if (!fresh) return { written: false, outcome: { result: "record_not_found" } };
      const p = await plan(fresh);
      if (!p || p.skip) return { written: false, outcome: p?.outcome ?? { result: "skipped" }, record: fresh };
      const applied = await applyWelcomeCallUpdate({
        recordId: fresh.Id,
        tenantId: p.tenantId ?? null,
        sfFields: p.sfFields,
        cacheValues: p.cacheValues ?? {},
        broadcastPayload: p.broadcastPayload ?? {},
      });
      return { written: true, outcome: p.outcome ?? { result: "written" }, applied, record: fresh };
    },
    { getSupabaseClient, waitMs: lockWaitMs() }
  );
}

export { RecordLockTimeout };

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
