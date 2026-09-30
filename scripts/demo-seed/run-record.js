// run-record.js — a second copy of what the seed must never lose, kept OFF the PC.
//
// The plan is rebuilt on every run from three things: the ANCHOR (the date and minute of
// the first --apply), the random SEED and the OPTIONS of that first apply. They live in
// migration/demo/id-map.json — a git-ignored file on one PC. Lose that file and a plan
// built "today" no longer matches what is in Salesforce.
//
// So the same facts (plus the tenant's id and the dates of every --freshen) are also kept
// in the `sundial/demo-users` secret, under ONE extra top-level key:
//
//   {
//     "tim+demo-avery@constructiveoperations.com": "<password>",   ← the logins (users.js)
//     …
//     "_run": { "conops-demo": { tenantId, anchor: { date, now }, seed, options, freshen: [{ date, at }], savedAt } }
//   }
//
// `_run` is not a login: users.js and --show-passwords only ever look up the eleven demo
// emails, and everything that lists the secret's logins goes through loginEntries() below.
// It is keyed by tenant slug so a second demo tenant cannot overwrite the first one's record.

import { DEMO_USERS_SECRET } from "./policy.js";

export const RUN_RECORD_KEY = "_run";

/** The secret's login entries only — never the run record. */
export function loginEntries(secret) {
  return Object.fromEntries(Object.entries(secret || {}).filter(([k]) => k !== RUN_RECORD_KEY && k.includes("@")));
}

const id15 = (v) => String(v ?? "").slice(0, 15);
/** JSON with the keys in a fixed order, so two records can be compared as text. */
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const sameAnchor = (a, b) => !!a && !!b && a.date === b.date && a.now === b.now;

/** What the id-map says the run record should be. */
export function runRecordFrom(idmap) {
  const d = idmap.data;
  return {
    tenantId: idmap.idOf("tenant") ?? null,
    anchor: d.anchor ?? null,
    seed: d.seed ?? null,
    options: d.options ?? null,
    freshen: (d.freshen || []).map((f) => ({ date: f.date, at: f.at })),
  };
}

/** READ-ONLY: the run record for this tenant slug, or null. */
export async function loadRunRecord(io, slug) {
  const secret = await io.secrets.load(DEMO_USERS_SECRET);
  const record = secret?.[RUN_RECORD_KEY]?.[slug] ?? null;
  return record && record.anchor ? record : null;
}

/** Why a stored record and the id-map cannot both be right — or null when they agree. */
export function runRecordConflict(record, want) {
  if (!record || !want.anchor) return null;
  if (record.tenantId && want.tenantId && id15(record.tenantId) !== id15(want.tenantId)) {
    return `the run record in "${DEMO_USERS_SECRET}" is for tenant record ${record.tenantId}, the id-map for ${want.tenantId}`;
  }
  if (!sameAnchor(record.anchor, want.anchor) || record.seed !== want.seed) {
    return `the run record in "${DEMO_USERS_SECRET}" says the seed was anchored to ${record.anchor?.date} (seed ${record.seed}), the id-map says ${want.anchor.date} (seed ${want.seed})`;
  }
  return null;
}

/**
 * Make the secret's run record say what the id-map says. One read; a write only when
 * something differs. `replaceStale`: this run is a brand-new seed (the tenant did not
 * exist), so a record left over from a tenant that was removed is simply replaced.
 * @returns {Promise<"unchanged"|"saved">}
 */
export async function syncRunRecord({ io, slug, idmap, counters, log, replaceStale = false }) {
  const want = runRecordFrom(idmap);
  if (!want.anchor) return "unchanged";
  const secret = await io.secrets.load(DEMO_USERS_SECRET);
  const all = { ...(secret?.[RUN_RECORD_KEY] || {}) };
  const have = all[slug] ?? null;
  const conflict = runRecordConflict(have, want);
  if (conflict && !replaceStale) {
    const err = new Error(`${conflict}. They must agree before anything is written — see "If the id-map is lost" in docs/demo-tenant-seed.md.`);
    err.code = "RUN_RECORD_MISMATCH";
    throw err;
  }
  if (conflict && log) log(`  note: replacing a run record left over from an earlier demo tenant (${have.anchor?.date}).`);
  const { savedAt: _ignored, ...haveBare } = have || {};
  if (have && canon(haveBare) === canon(want)) return "unchanged";
  all[slug] = { ...want, savedAt: io.now().toISOString() };
  await io.secrets.save(DEMO_USERS_SECRET, { ...(secret || {}), [RUN_RECORD_KEY]: all }, secret !== null);
  if (counters) counters.secretRun = "run record saved (anchor date, seed, options — no passwords)";
  return "saved";
}
