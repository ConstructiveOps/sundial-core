// lib/formula-parents.js — which PARENT records can change a cached formula column.
//
// THE GAP THIS CLOSES (2026-10-05, D-079): Salesforce does not bump a record's
// SystemModstamp when a cross-object formula on it changes value. The job's
// `Estimate_Total__c` (= Estimate__r.Total__c) changes when the ESTIMATE is edited;
// the job's own SystemModstamp stays put. sundial-cache-sync's incremental query
// (`SystemModstamp > watermark`) would therefore never re-read that job, and once the
// cache is authoritative (D-079) the Jobs list would show the old total forever.
//
// The fix: for every CACHED formula column that reads through a relationship, the
// incremental query also asks for rows whose PARENT changed:
//     WHERE SystemModstamp > wm OR Estimate__r.SystemModstamp > wm
// This function derives those relationship paths from the describe metadata itself
// (`calculatedFormula`), so a new formula column is covered without a code change.
//
// Every prefix of a multi-hop reference is included: for `A__r.B__r.Name`, a change
// on B changes the value, and so does re-pointing A's lookup (a change on A).
//
// UNCOVERABLE (reported, never silently ignored — scripts/check-cache-formula-coverage.mjs
// exits non-zero on them): TODAY()/NOW() formulas (change with the clock, not with any
// record), `$` globals ($User, $Setup, $Label...), polymorphic lookups, and any
// relationship name that does not resolve against the describe.
//
// Pure apart from the injected `describe(objectName)` (returns the raw describe JSON).

const TIME_FN_RE = /\b(TODAY|NOW|TIMENOW)\s*\(/i;
const DOTTED_RE = /(?<![\w$.])([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)/g;

/** Strip string literals so a "a.b" inside quotes is not read as a reference. */
function stripStrings(formula) {
  return String(formula).replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

/** Raw dotted references in a formula, e.g. ["Estimate__r.Total__c"]. */
export function dottedReferences(formula) {
  const out = new Set();
  for (const m of stripStrings(formula).matchAll(DOTTED_RE)) out.add(m[1]);
  return [...out];
}

/**
 * @param {object} p
 * @param {string} p.sfObject            the object being synced
 * @param {Array}  p.fields              its raw describe fields
 * @param {(f) => boolean} p.isCached    is this field backed by a cache column?
 * @param {(name: string) => Promise<object>} p.describe  raw describe of any object
 * @returns {Promise<{ paths: string[], covered: Array<{field, paths}>, uncoverable: Array<{field, reason}> }>}
 */
export async function parentModstampPaths({ sfObject, fields, isCached, describe }) {
  const paths = new Set();
  const covered = [];
  const uncoverable = [];
  const describeCache = new Map();
  const getFields = async (name) => {
    if (name === sfObject) return fields;
    if (!describeCache.has(name)) describeCache.set(name, (await describe(name))?.fields || []);
    return describeCache.get(name);
  };

  for (const f of fields || []) {
    if (!f.calculated || !f.calculatedFormula || !isCached(f)) continue;
    const formula = stripStrings(f.calculatedFormula);
    if (TIME_FN_RE.test(formula)) {
      uncoverable.push({ field: f.name, reason: "time-dependent (TODAY/NOW): changes with the clock, not with any record" });
      continue;
    }
    if (/\$[A-Za-z]/.test(formula)) {
      uncoverable.push({ field: f.name, reason: "references a $ global ($User, $Setup, $Label...)" });
      continue;
    }
    const mine = new Set();
    let failed = null;
    for (const ref of dottedReferences(formula)) {
      const segs = ref.split(".");
      const rels = segs.slice(0, -1);
      let objectName = sfObject;
      for (let i = 0; i < rels.length; i++) {
        const objFields = await getFields(objectName);
        const lookup = objFields.find(
          (x) => x.relationshipName && x.relationshipName.toLowerCase() === rels[i].toLowerCase()
        );
        if (!lookup) { failed = `relationship "${rels.slice(0, i + 1).join(".")}" does not resolve on ${objectName}`; break; }
        if (!Array.isArray(lookup.referenceTo) || lookup.referenceTo.length !== 1) {
          failed = `polymorphic lookup "${lookup.relationshipName}"`;
          break;
        }
        // Canonical spelling from the describe, never the formula's casing (earlier
        // hops were already canonicalised on previous iterations).
        rels[i] = lookup.relationshipName;
        mine.add(rels.slice(0, i + 1).join("."));
        objectName = lookup.referenceTo[0];
      }
      if (failed) break;
    }
    if (failed) {
      uncoverable.push({ field: f.name, reason: failed });
      continue;
    }
    if (mine.size > 0) {
      covered.push({ field: f.name, paths: [...mine] });
      for (const p of mine) paths.add(p);
    }
  }
  return { paths: [...paths].sort(), covered, uncoverable };
}

/** The incremental WHERE: own change OR any parent's change since the watermark. */
export function incrementalWhere(watermarkIso, parentPaths = []) {
  const parts = [`SystemModstamp > ${watermarkIso}`, ...parentPaths.map((p) => `${p}.SystemModstamp > ${watermarkIso}`)];
  return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

/** Read a nested value like rec.A__r.B__r.SystemModstamp; undefined when any hop is null. */
export function readPath(rec, path) {
  let cur = rec;
  for (const seg of path.split(".")) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}
