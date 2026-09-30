// test-helpers.js — shared by the demo-seed tests. Not a test file itself.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schemaFromProbe } from "./schema.js";
import { buildPlan } from "./plan.js";
import { preflightPlan } from "./preflight.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROBE_PATH = resolve(HERE, "..", "..", "migration", "demo", "probe.json");

let cached = null;
/** The live org's metadata as captured by scripts/probe-demo-prereqs.mjs. */
export function loadProbe() {
  cached ??= readFileSync(PROBE_PATH, "utf8");
  return JSON.parse(cached);
}

/**
 * Runs of the seed on different days and at different times of day. The plan must hold its
 * invariants on ALL of them — the owner's real run will be on a date no test has seen.
 * (Phoenix is UTC-7: 17:40Z is 10:40 local.)
 */
const FIXED_ANCHORS = [
  { date: "2026-09-29", now: "2026-09-29T17:40:00.000Z", label: "Tuesday mid-morning" },
  { date: "2026-10-05", now: "2026-10-05T13:05:00.000Z", label: "Monday 06:05, before the working day" },
  { date: "2026-10-09", now: "2026-10-09T22:30:00.000Z", label: "Friday 15:30, end of the day" },
  { date: "2026-10-10", now: "2026-10-10T19:00:00.000Z", label: "Saturday noon" },
  { date: "2026-10-11", now: "2026-10-12T03:30:00.000Z", label: "Sunday 20:30" },
  { date: "2026-11-25", now: "2026-11-25T16:00:00.000Z", label: "Wednesday 09:00" },
  { date: "2027-01-04", now: "2027-01-04T20:15:00.000Z", label: "Monday 13:15, after new year" },
];
/**
 * DEMO_SEED_SWEEP=90 node --test scripts/demo-seed/plan.test.js
 * adds that many consecutive days (each at a different time of day) to the list — a slow,
 * wide check to run after changing the plan. The default list keeps `npm test` quick.
 */
function sweepAnchors(days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.UTC(2026, 9, 1 + i));
    const date = day.toISOString().slice(0, 10);
    const hourUtc = 12 + ((i * 5) % 14); // 05:00 … 18:00 in Phoenix
    const now = new Date(Date.UTC(2026, 9, 1 + i, hourUtc, (i * 7) % 60)).toISOString();
    out.push({ date, now, label: `sweep ${date} ${String(hourUtc - 7).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}` });
  }
  return out;
}
export const ANCHORS = Object.freeze([...FIXED_ANCHORS, ...sweepAnchors(Number(process.env.DEMO_SEED_SWEEP || 0))]);

export function planFor(anchor = ANCHORS[0], extra = {}) {
  const schema = extra.schema ?? schemaFromProbe(loadProbe());
  const plan = buildPlan({ schema, tenantSlug: "conops-demo", anchorDate: anchor.date, anchorNow: anchor.now, seed: extra.seed, options: extra.options ?? {} });
  const pre = preflightPlan(plan, schema);
  return { schema, plan, pre, ops: pre.ops };
}

export const creates = (ops, sfObject) => ops.filter((o) => o.op === "create" && o.object === sfObject);
export const byKey = (ops) => new Map(ops.filter((o) => o.op === "create").map((o) => [o.key, o]));
