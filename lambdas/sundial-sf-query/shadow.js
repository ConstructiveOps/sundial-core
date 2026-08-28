// sundial-sf-query — ACCESS MODEL SHADOW MODE (D-064, docs/access-model.md §7 step 1,
// §8 Phase 2).
//
// WHAT THIS IS. On every read, this module computes what the NEW access model
// (lib/access.js) WOULD have answered, compares it to what the request is ACTUALLY
// serving, and writes one structured JSON line to CloudWatch. It serves nothing,
// filters nothing, and changes nothing.
//
// ---------------------------------------------------------------------------
// THE CONTRACT: ZERO BEHAVIOR CHANGE. NOT "ALMOST ZERO".
// ---------------------------------------------------------------------------
// Shadow can never change a status code, a payload byte, or the set of rows served, and
// it can never throw. Every public method here is try/caught IN ITS ENTIRETY: an error
// inside the shadow computation becomes one log line and the request proceeds exactly as
// it would have with ACCESS_MODEL_MODE unset. The call sites in index.js are bare
// `await shadow.x(...)` with no error handling of their own, and that is safe BECAUSE of
// the guarantee here — if you add a method, guard it the same way or you have moved the
// failure into the read path.
//
// This matters more than it sounds. The point of a shadow phase is to run the new model
// against real traffic for three business days BEFORE trusting it. A shadow that can 500
// a request has converted a measurement into an outage, and would be switched off before
// it ever produced the data the §8 gate needs.
//
// ---------------------------------------------------------------------------
// COST CONTROL: WHY MOST REQUESTS ADD NO QUERY AT ALL
// ---------------------------------------------------------------------------
// For `tenant` scope, rowFilter() returns the tenant clause AND NOTHING ELSE — which is
// exactly the predicate the endpoint already ran (`.eq("client_sf_id", tenantId)`). The
// new answer is therefore provably identical to the old one, and no second query is
// issued: the line is logged with `newCountSource: "identical_by_construction"`.
// Almost all live Harmon traffic is tenant scope, so almost all traffic pays nothing.
//
// ⚠️ WITH ONE EXCEPTION, AND IT IS THE INTERESTING CASE. If the TEMP guard is active
// (`repRestrict`), the request is NOT serving the tenant-wide set — it is serving
// Dennis's name-matched set, whoever the caller is. A tenant-scope user carrying
// `Hierarchy_Level__c = "Sales Rep"` (the mis-stamped case the Phase 0 audit found) is
// therefore served LESS than the new model would give them, and that is a WIDENING —
// precisely what §7 says to watch for. Taking the shortcut there would hide the one
// finding the phase exists to produce. So the shortcut requires tenant scope AND no
// repRestrict, and the extra count runs for everyone else.
//
// NO SALESFORCE ROUND TRIP IS EVER ADDED. Cache-side counts only.
//
// ---------------------------------------------------------------------------
// COUNTS, NOT ID SETS — a deliberate departure from §7 step 1 as first written
// ---------------------------------------------------------------------------
// §7.1 specified `onlyInOld: [...ids], onlyInNew: [...ids]` per request. On Dennis's
// customer list that is 3,534 record ids per request into CloudWatch. Per request the
// line carries COUNTS and outcome flags; the exact id-set differences are
// scripts/access-shadow-report.mjs's job, run offline against the same two rules. The
// doc is amended to match (§7).
//
// Value-safety: never logs a token, a secret, a `?q=` search term, an email address, or
// a record id. Salesforce field API names are logged (they come from the describe, not
// from the caller); caller-supplied VALUES are not.

import {
  rowFilter,
  rowMatchesFilter,
  userFilter,
  canReadObject,
  OBJECT_ACCESS,
  resolveScope,
} from "../../lib/access.js";

// --- Modes -----------------------------------------------------------------
// off     (default) — the code path is identical to before Phase 2: no computation, no
//                     query, no log line. This is what ships first, and the access
//                     matrix must be byte-identical under it.
// shadow            — compute and log; serve the old answer unchanged.
// enforce           — RECOGNIZED BUT NOT YET IMPLEMENTED (Phase 3). Warns and behaves as
//                     shadow. It exists as a valid value NOW so that an early or
//                     accidental env flip degrades to "measure" rather than crashing the
//                     Lambda or — worse — silently meaning "off", quietly producing no
//                     data for three days while everyone believes it is enforcing.
export const MODES = Object.freeze({ OFF: "off", SHADOW: "shadow", ENFORCE: "enforce" });

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/**
 * Resolve ACCESS_MODEL_MODE. Unset/blank -> off.
 *
 * An UNRECOGNIZED value resolves to `off`, not to shadow: a typo in an env var must
 * degrade to today's behavior, never to a mode nobody chose. It warns on the cold start
 * so the typo is visible in the logs rather than inferred from missing shadow lines.
 */
export function resolveMode(env = process.env) {
  const raw = (env.ACCESS_MODEL_MODE ?? "").trim().toLowerCase();
  if (raw === "" || raw === MODES.OFF) return MODES.OFF;
  if (raw === MODES.SHADOW) return MODES.SHADOW;
  if (raw === MODES.ENFORCE) {
    warnOnce(
      "enforce",
      "ACCESS_MODEL_MODE=enforce is not implemented yet (Phase 3). Behaving as shadow: " +
        "the new access decision is computed and logged, and the OLD answer is served."
    );
    return MODES.SHADOW;
  }
  warnOnce(
    `bad:${raw}`,
    `ACCESS_MODEL_MODE="${raw}" is not a recognized mode (off|shadow|enforce). ` +
      "Treating it as off — no shadow logging is happening."
  );
  return MODES.OFF;
}

// --- Outcome vocabulary ----------------------------------------------------
// One spelling per outcome, so the summary script groups on values that exist rather
// than on values it hopes exist.
const OUT = Object.freeze({
  SERVED: "served",
  NOT_FOUND: "not_found",
  FORBIDDEN: "forbidden", // 403 MODULE_FORBIDDEN — list/search only (§3.1)
  UNKNOWN: "unknown",
});

// How a newCount was arrived at. `identical_by_construction` is the free case above;
// `cache_count` cost one PostgREST count; `by_construction` needs no query because the
// answer is structural (a denial is zero rows).
const SRC = Object.freeze({
  IDENTICAL: "identical_by_construction",
  STRUCTURAL: "by_construction",
  CACHE_COUNT: "cache_count",
  ROW: "row_in_hand",
  CACHE_PROBE: "cache_probe",
  NONE: "not_computed",
});

/**
 * Compare the old and new SET SIZES.
 *
 * ⚠️ EQUAL COUNTS ARE NOT AN EQUAL SET. Two disjoint sets of 3,534 rows compare equal
 * here — which is exactly the mistake §7's gate calls out, and why the id-set comparison
 * lives in the offline report. `same_count` in this log means "nothing to see in the
 * counts", not "proven identical".
 */
export function verdictFor(oldOutcome, newOutcome, oldCount, newCount) {
  if (newOutcome === OUT.UNKNOWN) return "unknown";
  const oldServed = oldOutcome === OUT.SERVED;
  const newServed = newOutcome === OUT.SERVED;
  if (oldServed && !newServed) return "narrower";
  if (!oldServed && newServed) return "wider";
  if (!oldServed && !newServed) return "same_outcome";
  // Both served, and no counts to compare: a SINGLE read, where the outcome IS the whole
  // answer. Returning "unknown" here would have marked every ordinary single read as
  // unresolved and buried the handful that really are.
  if (typeof oldCount !== "number" || typeof newCount !== "number") return "same_outcome";
  if (newCount < oldCount) return "narrower";
  if (newCount > oldCount) return "wider";
  return "same_count";
}

/**
 * Build the pseudo cache row a Salesforce RECORD implies, so rowMatchesFilter() can be
 * asked about a record we already hold without a second fetch.
 *
 * Derived from OBJECT_ACCESS rather than hardcoded, so the mapping cannot drift from the
 * one rowFilter() filters on. Returns null for an object with no filter columns — those
 * are denied to sales scopes outright, so there is nothing to evaluate.
 */
function sfRecordToFilterRow(objectKey, record) {
  const def = OBJECT_ACCESS[objectKey];
  if (!def || !record) return null;
  const row = { client_sf_id: record.Client__c ?? null };
  if (def.repColumn && def.repField) row[def.repColumn] = record[def.repField] ?? null;
  if (def.dealerColumn && def.dealerField) {
    row[def.dealerColumn] = record[def.dealerField] ?? null;
  }
  return row;
}

/**
 * The loggable shape of the query string.
 *
 * ⚠️ THE SEARCH TERM IS NEVER LOGGED. `?q=` is whatever a user typed into a search box —
 * customer names, addresses, phone fragments. Its LENGTH is enough to correlate a line
 * with a search and carries none of that. The same rule applies to `?value=`: the FIELD
 * name is a canonical Salesforce API name from the describe and is safe; the value is
 * caller data and is not.
 */
export function sanitizeParams(qs) {
  const q = qs || {};
  const term = q.q == null ? null : String(q.q);
  return {
    limit: q.limit == null ? null : String(q.limit).slice(0, 12),
    offset: q.offset == null ? null : String(q.offset).slice(0, 12),
    hasQ: term != null && term !== "",
    qLen: term == null ? 0 : term.length,
    hasParentId: q.parentId != null && String(q.parentId).trim() !== "",
    field: q.field == null ? null : String(q.field).slice(0, 64),
    hasValue: q.value != null,
    full: String(q.full).toLowerCase() === "true",
  };
}

// --- The recorder ----------------------------------------------------------

/** The no-op returned when the mode is off. Every method is a resolved promise. */
const NOOP = Object.freeze({
  mode: MODES.OFF,
  enabled: false,
  list: async () => {},
  single: async () => {},
  users: async () => {},
  meta: async () => {},
});

function logShadowError(where, err) {
  try {
    console.log(
      JSON.stringify({
        shadow: true,
        mode: MODES.SHADOW,
        path: `error.${where}`,
        error: err?.message || String(err),
      })
    );
  } catch {
    /* logging the failure must not fail */
  }
}

/**
 * Create the per-request shadow recorder.
 *
 * @param {object} args
 * @param {object} args.identity   resolveIdentity()'s return (carries `access`)
 * @param {string|null} args.objectKey
 * @param {object} args.qs         raw query string params (values are NOT logged)
 * @param {object|null} args.repRestrict  the TEMP guard's decision for this request
 * @param {object} args.supabase   service-role client, used for cache counts only
 * @param {string} [args.mode]     override, for tests
 *
 * Returns a recorder whose methods each emit AT MOST ONE line. A request travels exactly
 * one read path, so one request produces one line.
 */
export function createShadow(args) {
  let mode;
  try {
    mode = args?.mode ?? resolveMode();
  } catch {
    return NOOP; // reading an env var cannot realistically throw; fail to off anyway.
  }
  if (mode !== MODES.SHADOW) return NOOP;

  try {
    return makeRecorder(args);
  } catch (e) {
    // A recorder that cannot be built must not take the request down with it.
    logShadowError("create", e);
    return NOOP;
  }
}

function makeRecorder({ identity, objectKey, qs, repRestrict, supabase }) {
  // Accepts a client OR a zero-arg factory. The meta and /sf/users routes run BEFORE the
  // handler creates a Supabase client, and shadow must not be the reason a picklist
  // request opens a database connection it would otherwise never need.
  async function resolveClient() {
    const c = typeof supabase === "function" ? await supabase() : supabase;
    if (!c) throw new Error("shadow: no supabase client available");
    return c;
  }

  // The AccessContext. identity.access is the block lib/identity.js already computed;
  // the resolveScope fallback covers a caller that predates it. A context that cannot be
  // built at all resolves to `none` inside lib/access, which is the correct answer to
  // "we do not know who this is".
  const access =
    identity?.access ?? resolveScope(identity?.user ?? null, identity?.tenantId ?? null);

  const base = {
    shadow: true,
    mode: MODES.SHADOW,
    // The Sundial_User__c id, not an email — enough to join to the user list in the
    // summary, and not a personal identifier sprayed across CloudWatch.
    //
    // ⚠️ TAKEN FROM THE IDENTITY, NOT FROM access.userId, AND THAT IS THE WHOLE POINT.
    // accessBlock() deliberately nulls userId and dealerId for scope `none` — correct for
    // the block the CLIENT reflects, because a `none` user has no scope-relevant ids to
    // render. As a LOG JOIN KEY it is wrong, and the first shadow run proved it: every
    // `none`-scope caller logged `user: null`, so three different test users (two
    // unattributed Sales Reps and a Technician) collapsed into one "(unknown)" row in the
    // summary, with whichever level happened to land first.
    //
    // That is precisely the population §8's gate says must be "identified and
    // re-levelled" before Phase 3 — and you cannot re-level a user the log cannot name.
    // The scope-resolved values stay below; the raw identity is what identifies WHO.
    user: identity?.user?.id ?? access?.userId ?? null,
    level: access?.level ?? null,
    scope: access?.scope ?? "none",
    // Same reasoning: fall back to the RAW dealer id so a `none` line still says whether
    // there was a dealer at all. With `level`, that makes each way of reaching `none`
    // self-diagnosing from the line — Technician (the level is the reason), a Sales Rep
    // with no dealer (unattributed), or a Sales Rep whose dealer is switched off.
    dealer: access?.dealerId ?? identity?.user?.dealer?.id ?? null,
    dealerActive: identity?.user?.dealer ? identity.user.dealer.active === true : null,
    // Whether the TEMP guard is filtering this request. The most useful column in the
    // summary: it separates "the old answer is the whole tenant" from "the old answer is
    // Dennis's book".
    temp: !!repRestrict,
    object: objectKey ?? null,
  };

  const params = sanitizeParams(qs);

  /** Emit exactly one line. Never throws. */
  function emit(line) {
    try {
      console.log(JSON.stringify({ ...base, ...line, params }));
    } catch (e) {
      logShadowError("emit", e);
    }
  }

  /**
   * One PostgREST COUNT with the new filter applied. HEAD-only: the count comes back in
   * a Content-Range header with no row payload, so this is cheap regardless of how many
   * rows match. Every caller filter the served query applied is applied here too —
   * otherwise the comparison is not like-for-like and every filtered list would read as
   * a narrowing.
   */
  async function cacheCount(cacheTable, eqs, { or = null, extraEq = [] } = {}) {
    const client = await resolveClient();
    let q = client.from(cacheTable).select("sf_id", { count: "exact", head: true });
    for (const { column, value } of [...eqs, ...extraEq]) q = q.eq(column, value);
    for (const group of Array.isArray(or) ? or : [or]) if (group) q = q.or(group);
    const { count, error } = await q;
    if (error) throw new Error(`cache count failed: ${error.message}`);
    return count ?? 0;
  }

  /** One indexed single-row cache read, used only on the 404 branch of a single read. */
  async function probeCacheRow(cacheTable, id, f) {
    const client = await resolveClient();
    let q = client.from(cacheTable).select("sf_id").eq("sf_id", id);
    for (const { column, value } of f.cache) q = q.eq(column, value);
    const { data, error } = await q.limit(1).maybeSingle();
    if (error) throw new Error(`cache probe failed: ${error.message}`);
    return !!data;
  }

  const recorder = {
    mode: MODES.SHADOW,
    enabled: true,

    /**
     * EVERY LIST AND SEARCH PATH (§3.2 rows "List (cache)", "List (cold-cache SOQL
     * fallback)", "?q= search", "?parentId=", "?field/value", "Counts / total").
     *
     * @param {string} path      the read path, verbatim: list.cache | list.live.rep |
     *                           list.live.cold | list.live.parent_uncached |
     *                           search.cache | search.live.rep | ...
     * @param {boolean} liveOld  was the OLD total a live SOQL COUNT rather than a cache
     *                           count? Passed rather than inferred from the path, so a
     *                           new path name cannot silently change how the summary
     *                           reads its numbers.
     * @param {Array} filters    the caller filters the served query applied (parentId,
     *                           field/value), so the comparison is like-for-like.
     * @param {string|null} or   the served query's PostgREST or-group (the ?q= ILIKE).
     */
    async list({ path, liveOld = false, cacheTable, oldCount, oldTotal, filters = [], or = null }) {
      const t0 = Date.now();
      try {
        // `user` is a UNION, not an equality — rowFilter refuses it on purpose (§3.5),
        // so the object's own shape decides which filter answers for it. Getting this
        // wrong would log every dealer's user list as a denial rather than as the union
        // Phase 3 will actually serve.
        const f = OBJECT_ACCESS[objectKey]?.unionFilter
          ? userFilter(access)
          : rowFilter(objectKey, access);
        if (f.deny) {
          return emit({
            path,
            oldOutcome: OUT.SERVED,
            oldCount,
            oldTotal,
            newOutcome: OUT.FORBIDDEN,
            newDeny: f.code,
            newTotal: 0,
            newCountSource: SRC.STRUCTURAL,
            verdict: "narrower",
            narrower: true,
            wider: false,
            shadowMs: Date.now() - t0,
          });
        }
        // The free case — see the header. Requires no TEMP guard on this request.
        if (access.scope === "tenant" && !repRestrict) {
          return emit({
            path,
            oldOutcome: OUT.SERVED,
            oldCount,
            oldTotal,
            newOutcome: OUT.SERVED,
            newTotal: oldTotal,
            newCountSource: SRC.IDENTICAL,
            verdict: "same_count",
            narrower: false,
            wider: false,
            shadowMs: Date.now() - t0,
          });
        }
        // Two or-groups (the union's and the search's) are ANDed by PostgREST, which
        // is what we want: a search narrows within what the role may see.
        const newTotal = await cacheCount(cacheTable, f.cache, {
          or: [f.cacheOr, or].filter(Boolean),
          extraEq: filters,
        });
        emit({
          path,
          oldOutcome: OUT.SERVED,
          oldCount,
          oldTotal,
          newOutcome: OUT.SERVED,
          newTotal,
          newCountSource: SRC.CACHE_COUNT,
          // On a live path the old total is a SOQL COUNT and the new one is a cache
          // count. A row or two of difference there is cache lag, not a widening, and
          // the summary must be able to tell those apart.
          countSourcesDiffer: liveOld,
          verdict: verdictFor(OUT.SERVED, OUT.SERVED, oldTotal, newTotal),
          narrower: newTotal < oldTotal,
          wider: newTotal > oldTotal,
          shadowMs: Date.now() - t0,
        });
      } catch (e) {
        emit({
          path,
          newOutcome: OUT.UNKNOWN,
          verdict: "unknown",
          error: e?.message || String(e),
          shadowMs: Date.now() - t0,
        });
      }
    },

    /**
     * SINGLE record read (§3.2 rows "Single read (cache shortcut)" and the SOQL path).
     *
     * NO SECOND RECORD FETCH. When the request served a record we already hold the
     * filter columns on it — buildCacheSelect selects Sales_Rep__c and Dealer__c because
     * their cache columns exist, and ?full=true selects every queryable field — so the
     * new decision is a pure in-memory check. When the request 404'd there is nothing in
     * hand, and that is the one case worth a cheap cache probe: "the old rule hid a
     * record the new rule would serve" is a WIDENING on a served path, and it is
     * invisible any other way.
     */
    async single({ path, served, row, record, id, cacheTable }) {
      const t0 = Date.now();
      try {
        const oldOutcome = served ? OUT.SERVED : OUT.NOT_FOUND;
        const f = rowFilter(objectKey, access);
        if (f.deny) {
          // §3.1: a module denial on a single read is a 404, never a 403 — a record you
          // may not see must be indistinguishable from one that does not exist.
          return emit({
            path,
            oldOutcome,
            newOutcome: OUT.NOT_FOUND,
            newDeny: f.code,
            newCountSource: SRC.STRUCTURAL,
            verdict: verdictFor(oldOutcome, OUT.NOT_FOUND),
            narrower: oldOutcome === OUT.SERVED,
            wider: false,
            shadowMs: Date.now() - t0,
          });
        }

        let newOutcome = OUT.UNKNOWN;
        let source = SRC.NONE;
        const filterRow = row ?? sfRecordToFilterRow(objectKey, record);
        if (filterRow) {
          newOutcome = rowMatchesFilter(objectKey, access, filterRow)
            ? OUT.SERVED
            : OUT.NOT_FOUND;
          source = SRC.ROW;
        } else if (!served && id && cacheTable) {
          const found = await probeCacheRow(cacheTable, id, f);
          newOutcome = found ? OUT.SERVED : OUT.NOT_FOUND;
          source = SRC.CACHE_PROBE;
        }

        emit({
          path,
          oldOutcome,
          newOutcome,
          newCountSource: source,
          verdict: verdictFor(oldOutcome, newOutcome),
          narrower: oldOutcome === OUT.SERVED && newOutcome === OUT.NOT_FOUND,
          wider: oldOutcome === OUT.NOT_FOUND && newOutcome === OUT.SERVED,
          shadowMs: Date.now() - t0,
        });
      } catch (e) {
        emit({
          path,
          newOutcome: OUT.UNKNOWN,
          verdict: "unknown",
          error: e?.message || String(e),
          shadowMs: Date.now() - t0,
        });
      }
    },

    /**
     * GET /sf/users — the literal route, whose old answer comes from a LIVE Salesforce
     * query. The §3.5 union, via userFilter().
     *
     * The `user` OBJECT list (GET /sf/user) is a different path and goes through list()
     * above, which picks userFilter for it by `unionFilter`. Two routes, one filter.
     *
     * The old count here is what Salesforce just returned; the new count is a cache
     * count. Different sources by nature, so countSourcesDiffer is always set and a
     * small difference is cache lag rather than a finding.
     *
     * ACTIVE-ONLY is applied here and NOT in list(): this route filters Active__c = true
     * and the object list does not, so each comparison matches the query it is comparing.
     */
    async users({ path = "users.route", oldCount, cacheTable = "sundial_user_cache" }) {
      const t0 = Date.now();
      try {
        const f = userFilter(access);
        if (f.deny) {
          return emit({
            path,
            oldOutcome: OUT.SERVED,
            oldCount,
            oldTotal: oldCount,
            newOutcome: OUT.FORBIDDEN,
            newDeny: f.code,
            newTotal: 0,
            newCountSource: SRC.STRUCTURAL,
            verdict: "narrower",
            narrower: true,
            wider: false,
            shadowMs: Date.now() - t0,
          });
        }
        if (!f.union) {
          // Tenant scope: §3.5 is "all active users in the tenant" — today's behavior.
          return emit({
            path,
            oldOutcome: OUT.SERVED,
            oldCount,
            oldTotal: oldCount,
            newOutcome: OUT.SERVED,
            newTotal: oldCount,
            newCountSource: SRC.IDENTICAL,
            verdict: "same_count",
            narrower: false,
            wider: false,
            shadowMs: Date.now() - t0,
          });
        }
        // Active-only is the ENDPOINT's rule, not the access model's (see userFilter's
        // note), so it is applied here rather than expected from the filter — and it
        // MUST be applied, or a union including inactive users would be compared against
        // an active-only old count and every dealer would read as a widening.
        const newTotal = await cacheCount(cacheTable, f.cache, {
          or: [f.cacheOr],
          extraEq: [{ column: "active", value: true }],
        });
        emit({
          path,
          oldOutcome: OUT.SERVED,
          oldCount,
          oldTotal: oldCount,
          newOutcome: OUT.SERVED,
          newTotal,
          newCountSource: SRC.CACHE_COUNT,
          countSourcesDiffer: true,
          verdict: verdictFor(OUT.SERVED, OUT.SERVED, oldCount, newTotal),
          narrower: newTotal < oldCount,
          wider: newTotal > oldCount,
          shadowMs: Date.now() - t0,
        });
      } catch (e) {
        emit({
          path,
          newOutcome: OUT.UNKNOWN,
          verdict: "unknown",
          error: e?.message || String(e),
          shadowMs: Date.now() - t0,
        });
      }
    },

    /**
     * The two picklist metadata routes (§3.1's last row, §4.4).
     *
     * ⚠️ ONLY THE MODULE GATE IS SHADOWED. §4.4's real rule is "only fields in the role's
     * read ∪ edit set", and that set comes from the FIELD MANIFEST, which Phase 4 builds:
     * the workbooks have not moved into sundial-core, they have no role columns yet, and
     * fieldsFor() does not exist. Emitting the module decision alone and SAYING SO is
     * honest; silently logging "served" would read as "Phase 3 changes nothing here",
     * which is false — a sales role loses fields from these responses in Phase 4.
     */
    async meta({ path, oldOutcome = OUT.SERVED }) {
      const t0 = Date.now();
      try {
        const allowed = canReadObject(objectKey, access);
        emit({
          path,
          oldOutcome,
          newOutcome: allowed ? OUT.SERVED : OUT.FORBIDDEN,
          newDeny: allowed ? undefined : "MODULE_FORBIDDEN",
          newCountSource: SRC.STRUCTURAL,
          fieldFilter: "deferred_phase4",
          verdict: verdictFor(oldOutcome, allowed ? OUT.SERVED : OUT.FORBIDDEN),
          narrower: !allowed,
          wider: false,
          shadowMs: Date.now() - t0,
        });
      } catch (e) {
        emit({
          path,
          newOutcome: OUT.UNKNOWN,
          verdict: "unknown",
          error: e?.message || String(e),
          shadowMs: Date.now() - t0,
        });
      }
    },
  };

  return recorder;
}
