// freshness.js — THE read-time freshness rule for sundial-sf-query (one definition,
// used by the list read AND the single-record cache read).
//
// THE RULE (2026-10-05, D-079 "Cache freshness is the sync job's health, not a
// per-row TTL"):
//
//   1. Once per request, look up the latest SUCCESSFUL INCREMENTAL run of
//      sundial-cache-sync for this object in public.cache_sync_runs (one tiny query,
//      remembered in the warm container for MEMO_MS = 60 s).
//
//   2. HEALTHY — that run finished within the object's healthy bar — the cache is
//      AUTHORITATIVE: a row is fresh iff `is_stale` is not true. No per-row clock.
//      The bar is HEALTHY_FACTOR (3) × the schedule interval the run itself recorded
//      (`expected_interval_s`: 5 min for the hot objects, 30 min for the rest), so a
//      30-minute object is never judged by the 5-minute bar. A run that recorded no
//      interval (a manual invoke) is judged by CACHE_SYNC_HEALTHY_MS (default 15 min).
//      The list read then only re-fetches rows something explicitly flagged stale (a
//      write-through, a Platform Event) — bounded and rare.
//
//   3. NOT HEALTHY — no run, an old run, the table missing, the query failing — fall
//      back to the pre-2026-10-05 rule EXACTLY: fresh iff not is_stale AND
//      last_synced_at within CACHE_TTL_MS (default 10 min). A dead schedule degrades
//      to slow-but-correct, never to stale-and-silent.
//
// WHY: the per-row 10-minute clock meant every Sales load after a quiet gap
// re-fetched all ~39k customers from Salesforce (~197 SOQL, 12 s pages, some hitting
// the 30 s timeout). The incremental sync already knows exactly which rows changed
// (SystemModstamp watermark, plus the parent-modstamp OR for cross-object formula
// columns — see lib/formula-parents.js), so once it runs on a schedule the clock is
// pure cost.

export const SYNC_RUNS_TABLE = "cache_sync_runs";
export const MEMO_MS = 60 * 1000;
export const HEALTHY_FACTOR = 3;

function envMs(name, dflt) {
  const raw = process.env[name];
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** The per-row TTL used by the fallback rule. Env-overridable (CACHE_TTL_MS). */
export function cacheTtlMs() {
  return envMs("CACHE_TTL_MS", 10 * 60 * 1000);
}

/** The healthy bar for a run that recorded no interval. Env-overridable. */
export function defaultHealthyMs() {
  return envMs("CACHE_SYNC_HEALTHY_MS", 15 * 60 * 1000);
}

/** The healthy bar for one run: 3 × its own schedule interval, else the default. */
export function healthyBarMs(run) {
  const s = Number(run?.expected_interval_s);
  return Number.isFinite(s) && s > 0 ? HEALTHY_FACTOR * s * 1000 : defaultHealthyMs();
}

// Warm-container memo: objectKey -> { at, run }. A failed lookup is memoized too
// (run = null), so a missing table costs one query per minute, not one per request.
const memo = new Map();
export function _resetFreshnessMemo() {
  memo.clear();
}

async function latestOkIncrementalRun(supabase, objectKey) {
  try {
    const { data, error } = await supabase
      .from(SYNC_RUNS_TABLE)
      .select("finished_at, expected_interval_s")
      .eq("object", objectKey)
      .eq("mode", "incremental")
      .eq("ok", true)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error(`freshness: ${SYNC_RUNS_TABLE} read error (${objectKey}):`, error.message);
      return null;
    }
    return data ?? null;
  } catch (e) {
    console.error(`freshness: ${SYNC_RUNS_TABLE} read threw (${objectKey}):`, e?.message || String(e));
    return null;
  }
}

/**
 * Which rule applies to this object right now. Never throws.
 * Returns { mode: "sync" | "ttl", objectKey, lastRunAt, barMs, ttlMs, memo }.
 */
export async function resolveFreshness(supabase, objectKey, nowMs = Date.now()) {
  let hit = memo.get(objectKey);
  const memoHit = !!hit && nowMs - hit.at < MEMO_MS;
  if (!memoHit) {
    hit = { at: nowMs, run: await latestOkIncrementalRun(supabase, objectKey) };
    memo.set(objectKey, hit);
  }
  const run = hit.run;
  const finishedMs = run?.finished_at ? Date.parse(run.finished_at) : NaN;
  const barMs = healthyBarMs(run);
  const healthy = Number.isFinite(finishedMs) && nowMs - finishedMs <= barMs;
  return {
    mode: healthy ? "sync" : "ttl",
    objectKey,
    lastRunAt: run?.finished_at ?? null,
    barMs,
    ttlMs: cacheTtlMs(),
    memo: memoHit,
  };
}

/**
 * Is this cache row trustworthy under `rule`? (rule from resolveFreshness.)
 *  - an explicit is_stale === true is never fresh, under either rule;
 *  - "sync": everything else is fresh;
 *  - "ttl": last_synced_at must be inside the TTL (missing/invalid -> stale).
 */
export function isRowFresh(row, rule, nowMs = Date.now()) {
  if (!row) return false;
  if (row.is_stale === true) return false;
  if (rule?.mode === "sync") return true;
  const syncedMs = row.last_synced_at ? Date.parse(row.last_synced_at) : NaN;
  if (!Number.isFinite(syncedMs)) return false;
  return nowMs - syncedMs <= (rule?.ttlMs ?? cacheTtlMs());
}

/** The one log line per request naming the rule (no record data). */
export function logFreshness(rule, extra = {}) {
  console.log(
    JSON.stringify({
      freshness: rule.mode,
      object: rule.objectKey,
      lastRunAt: rule.lastRunAt,
      barMs: rule.barMs,
      ttlMs: rule.ttlMs,
      memo: rule.memo,
      ...extra,
    })
  );
}
