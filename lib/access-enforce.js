// The shared ACCESS ENFORCEMENT helper — D-064 Phase 5 (§3.6).
//
// lib/access.js is PURE: it decides, and does no I/O. That is what makes it testable,
// and it is why it builds a SOQL string for `assertVisibleRecord` rather than running
// one. This module is the thin layer that runs it, so the seven action and file Lambdas
// share ONE implementation instead of seven copies of the same four lines.
//
// ---------------------------------------------------------------------------
// WHY A SHARED HELPER AND NOT A COPY PER LAMBDA
// ---------------------------------------------------------------------------
// The system D-064 replaces spread its one authorization decision across a hardcoded rep
// name in sundial-sf-query, a 403 in sundial-list-files, and a rail-id list in the
// browser — and the three disagreed. Copying "call canAction, then run the visibility
// SOQL" into seven Lambdas would rebuild exactly that, one careful paste at a time. The
// day the rule changes, it changes here.
//
// ⚠️ TWO QUESTIONS, BOTH REQUIRED, AND THEY ARE NOT THE SAME QUESTION.
// `canAction("aurora.design_request", access)` is TRUE for every sales rep — it asks
// whether the ROLE may perform the action at all. Whether THIS rep may act on THAT
// customer is `assertRecordVisible`. A caller that asks only the first would let a rep
// fire a design request at any customer id in the tenant.

import { canAction, assertVisibleRecord, DENY } from "./access.js";
import { sfQuery } from "./salesforce.js";
import { resolveMode, MODES } from "../lambdas/sundial-sf-query/shadow.js";

/**
 * The AccessContext to enforce with, or null when enforcement is off.
 *
 * Bound to the SAME env var as sf-query and sf-update, so the whole access model has one
 * switch and one rollback. A Lambda that read its own flag would be a Lambda that could
 * be left enforcing after the others were rolled back.
 *
 * ⚠️ Every function below treats a null access as "not enforcing" and returns null (=
 * proceed). That is what lets these Lambdas be DEPLOYED before the flag is set, which is
 * how every phase of this rollout has shipped.
 */
export function enforcedAccess(identity) {
  return resolveMode() === MODES.ENFORCE ? (identity?.access ?? null) : null;
}

/**
 * The AccessContext, REGARDLESS of ACCESS_MODEL_MODE — for gates that must not be
 * switchable off.
 *
 * ---------------------------------------------------------------------------
 * WHY PHASE 5's GATES IGNORE THE SWITCH, WHEN EVERY OTHER PHASE HONOURS IT
 * ---------------------------------------------------------------------------
 * The switch exists so code can be DEPLOYED INERT and turned on separately. That is
 * exactly right when the new gate REPLACES nothing — sf-query and sf-update served the
 * same answers with the flag off as they did the day before.
 *
 * It is exactly WRONG here, and the difference is that Phase 5 REMOVED an existing
 * control: sundial-list-files carried a TEMP 403 that blocked Solar files for a Sales
 * Rep. Replacing it with a switchable gate meant "mode off" no longer reproduced the
 * previous behaviour — it reproduced something LOOSER. Measured tonight: for four
 * minutes between the deploy and the flag being set, that endpoint had no rep
 * restriction at all. (CloudWatch: zero invocations in the window, so nothing was
 * exposed — but the next occurrence would not come with that guarantee.)
 *
 * The sharper version of the problem is the ROLLBACK. `ACCESS_MODEL_MODE=off` is the
 * documented first response to an incident. If these gates honoured it, the rollback
 * would re-open Solar files to every sales rep at precisely the moment somebody was
 * already dealing with a problem.
 *
 * So Phase 5's gates are always on. Rolling them back is a previous-zip redeploy — the
 * slower, more deliberate action that removing a security control should require. The
 * asymmetry is the point: the switch can make the system TIGHTER (the other phases were
 * off-by-default), never looser than the day before.
 */
export function alwaysEnforcedAccess(identity) {
  return identity?.access ?? null;
}

/**
 * May this caller perform this action? Returns null to proceed, or a denial descriptor.
 *
 * 403 rather than 404: an action key names a CAPABILITY, not a record, so refusing it
 * leaks nothing about what exists. (The record question below is the one that must 404.)
 */
export function assertAction(actionKey, access) {
  if (!access) return null;
  if (canAction(actionKey, access)) return null;
  return { status: 403, body: { error: "forbidden", code: DENY.ACTION_FORBIDDEN } };
}

/**
 * May this caller see this record? Returns null to proceed, or a denial descriptor.
 *
 * ⚠️ 404, NEVER 403. A record you may not see must be indistinguishable from one that
 * does not exist. A 403 on a record id confirms the record exists, which turns any of
 * these endpoints into an enumeration oracle for a rep who wants to know how big the
 * tenant is — and file endpoints take a record id in the path, so they are exactly the
 * shape that would leak it.
 *
 * A SOQL failure DENIES. An error here means we could not establish visibility, and
 * "could not establish" is not "allowed".
 */
export async function assertRecordVisible(objectKey, recordId, access) {
  if (!access) return null;
  const check = assertVisibleRecord(objectKey, recordId, access);
  if (check.deny) {
    return { status: 404, body: { error: "not_found", code: DENY.RECORD_NOT_FOUND } };
  }
  try {
    const rows = await sfQuery(check.soql);
    if (rows && rows.length > 0) return null;
  } catch (e) {
    console.error("access: visibility check failed:", e?.message || String(e));
  }
  return { status: 404, body: { error: "not_found", code: DENY.RECORD_NOT_FOUND } };
}

/**
 * Both questions, in the order that fails cheapest first: the action gate needs no I/O,
 * so a role that may not perform the action at all never costs a Salesforce round trip.
 */
export async function assertActionOnRecord(actionKey, objectKey, recordId, access) {
  return (
    assertAction(actionKey, access) ??
    (await assertRecordVisible(objectKey, recordId, access))
  );
}
