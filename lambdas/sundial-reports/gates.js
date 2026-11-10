// sundial-reports/gates.js — which catalog gates a caller holds. Shared by index.js (a request's
// caller) and schedule.js (a scheduled report's OWNER at send time, D-091). index.js re-exports
// both names, so nothing that imported them from there changes.

import { canAction } from "../../lib/access.js";
import { CATALOG } from "../../lib/report-catalog/index.js";

// Every gate any catalog column carries (today: service.costing.read). Derived, so a new gate
// in a regenerated catalog is honoured without a code change here.
export const CATALOG_GATES = Object.freeze([
  ...new Set(Object.values(CATALOG).flatMap((c) => c.fields.map((f) => f.gate).filter(Boolean))),
].sort());

/** The gates this access context holds, from the one table that decides it. */
export function heldGates(access) {
  return CATALOG_GATES.filter((g) => canAction(g, access));
}
