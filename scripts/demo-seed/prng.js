// prng.js — the seeded random source for the demo plan.
//
// WHY: the demo data must be REPRODUCIBLE. A re-run after a crash has to build the very
// same plan (same names, same amounts, same schedule) so the id-map's stable keys still
// point at the right records. Math.random() cannot be seeded, so the plan never uses it.
//
// Each part of the plan takes its own named sub-stream (`fork`), so adding one more
// random draw to the customers does not shift every value in the service schedule.

/** FNV-1a, 32 bit. Only used to turn a label into a number — not for security. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny, fast, good enough for picking names and prices. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number} seed   the run's seed (stored in the id-map on the first --apply)
 * @param {string} label  which part of the plan this stream belongs to
 */
export function createRng(seed, label = "root") {
  const base = (Number(seed) >>> 0) ^ hashString(label);
  const next = mulberry32(base);
  const rng = {
    /** 0 <= x < 1 */
    next,
    /** whole number, both ends included */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** one element of a non-empty array */
    pick(arr) {
      if (!arr.length) throw new Error(`rng.pick: empty list (${label})`);
      return arr[Math.floor(next() * arr.length)];
    },
    chance(p) {
      return next() < p;
    },
    /** a shuffled COPY (Fisher–Yates) */
    shuffle(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    /** pick by weight: [[value, weight], ...] */
    weighted(pairs) {
      const total = pairs.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [v, w] of pairs) {
        r -= w;
        if (r < 0) return v;
      }
      return pairs[pairs.length - 1][0];
    },
    /** a number rounded to `step` (e.g. money to the nearest 5) */
    stepped(min, max, step) {
      const n = Math.round((min + next() * (max - min)) / step) * step;
      return Math.round(n * 100) / 100;
    },
    /** an independent stream for a sub-part */
    fork(sub) {
      return createRng(seed, `${label}/${sub}`);
    },
  };
  return rng;
}
