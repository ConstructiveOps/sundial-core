// lib/follow-up.js — a new follow-up date means a follow-up is needed (2026-10-22, Harmon).
//
// Whenever a customer write sets Next_Follow_Up_Date__c to a date it did not already hold,
// the same write sets Follow_Up_Needed__c = true. Never false here: clearing the date leaves
// the flag alone, and a `false` sent together with a new date loses to the date (the office
// asked for a follow-up by giving it a day). Used by sundial-sf-update (the Sales and Service
// customer pages) and sundial-service-estimate (the Service popups' Next follow-up).
//
// A Salesforce Flow may set the same flag (the portal calls the date "the reminder Flow's
// anchor"); the integration user cannot read FlowDefinitionView to check, and if one does,
// this write is the same value — harmless and idempotent.

export const FOLLOW_UP_DATE_FIELD = "Next_Follow_Up_Date__c";
export const FOLLOW_UP_FLAG_FIELD = "Follow_Up_Needed__c";

const keyOf = (obj, name) => Object.keys(obj || {}).find((k) => k.toLowerCase() === name.toLowerCase());
const norm = (v) => (v == null ? "" : String(v).trim());

/**
 * Mutates `written`: when it sets the follow-up date to a new non-blank value, the flag is
 * written true (replacing any flag key the caller sent). `before` is the record as it was
 * (null = unknown or new → any non-blank date counts as new). Returns true when it set the flag.
 */
export function applyFollowUpFlag(before, written) {
  const dk = keyOf(written, FOLLOW_UP_DATE_FIELD);
  if (!dk) return false;
  const to = norm(written[dk]);
  if (!to) return false;
  if (before && norm(before[FOLLOW_UP_DATE_FIELD]) === to) return false;
  const fk = keyOf(written, FOLLOW_UP_FLAG_FIELD);
  if (fk && fk !== FOLLOW_UP_FLAG_FIELD) delete written[fk];
  written[FOLLOW_UP_FLAG_FIELD] = true;
  return true;
}
