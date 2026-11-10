// lib/stage-rules.js — which solar stages are FINISHED (terminal). ONE home for the rule
// (D-080 amendment 1; corrected by D-092, 2026-11-10).
//
// Read by:
//   - sundial-sf-query (re-exported): the Dashboard's "Active Projects" count, passed to
//     public.sundial_solar_pipeline as p_terminal_stages;
//   - the report assistant's glossary (docs/reporting-glossary.md, pinned by
//     lib/report-glossary.test.js): "active" = stage NOT IN this list.
//
// WHY AN EXPLICIT LIST (D-092). Until 2026-11-10 the rule was a case-insensitive SUBSTRING
// match on five terms ("complete", "cancel", "pto", "closed", "archive"), with
// "Billing Complete - Pending Closeout" named as the one exception. The substring rule was
// wrong about two stages that merely contain the word "complete":
//   "Inspection Completed"    — the inspection passed; the project is still open work
//   "Go Back Items Complete"  — the go-back is done; the project is still open work
// Tim, 2026-11-10: both are ACTIVE. The list below is the substring result over the live
// picklist minus those two (and minus Billing Complete - Pending Closeout, as before).
// Live effect measured 2026-11-10: Harmon 0 projects change category; conops-demo 3
// (2 Inspection Completed, 1 Go Back Items Complete) move from finished to active.
//
// An exact list cannot silently pick up a new stage: lib/stage-rules.test.js derives the
// substring result from the generated catalog's picklist and fails when a NEW stage value
// contains one of the old terms, so somebody decides on purpose which side it is on.
//
// A stage that is blank is neither: the Dashboard counts only non-blank stages as active.

export const SOLAR_TERMINAL_STAGES = Object.freeze([
  "PTO Approval Granted",
  "Request to Archive",
  "Archive",
  "Cancelled - Awaiting Sales to Resell",
  "Cancelled",
]);

// The stages the old substring rule called finished that are ACTIVE (D-092 + the original
// D-080 am. 1 exception). Kept so the test can prove the list is "substring minus these".
export const SOLAR_ACTIVE_DESPITE_TERM = Object.freeze([
  "Billing Complete - Pending Closeout",
  "Inspection Completed",
  "Go Back Items Complete",
]);

// The OLD substring terms — history only, read by the test above. Never apply them.
export const LEGACY_TERMINAL_TERMS = Object.freeze(["complete", "cancel", "pto", "closed", "archive"]);

/** Is this solar stage finished? Exact match; blank is not. */
export function isTerminalSolarStage(stage) {
  return typeof stage === "string" && SOLAR_TERMINAL_STAGES.includes(stage);
}
