// job-notes.js — a completed call's notes, rolled up onto the job (2026-09-19, Tim's ask).
//
// The job carries two long text fields the office reads without opening every call:
//   Notes_for_Summary__c        ← each call's WORK notes (the customer-visible kind); the
//                                  raw material for the job's "Summary of work"
//   Notes_From_Service_Calls__c ← each call's PRIVATE notes (office-only)
// The call keeps its own notes untouched — these are copies, one block per call.
//
// WHEN: when the call becomes Complete (the tech's tap, the board's status menu, the
// office's time correction with `complete`), and again whenever a Complete call's notes
// change. Before completion nothing reaches the job — a half-written note is not a
// summary. HOW: one block per call, headed by the call number, so a later edit REPLACES
// that call's block instead of stacking a second copy; a call whose notes were emptied has
// its block removed. Never a Salesforce Flow: a Flow cannot tell "appended" from "edited",
// fires on every save (double blocks), and the job cache would not hear about the write.
//
// Fixed-width Long Text Area (131,072) — a block that would overflow is cut with a marker.

import { soqlEscapeString } from "../../lib/salesforce.js";

export const JOB_NOTES_FIELDS = Object.freeze({
  work: "Notes_for_Summary__c",
  private: "Notes_From_Service_Calls__c",
});
export const JOB_NOTES_MAX = 131072;
const BLOCK_PREFIX = "— ";
const ZERO_WIDTH_MARKER = /​[^\s]*/g; // the tech app's replay-guard ids (invisible on the call, noise here)

const clean = (v) => (v == null ? "" : String(v).replace(/\r\n?/g, "\n").trim());

/** "— SC-00012 · Sep 18, 2026 · Larry Ng" */
export function blockHeader({ callNumber, techName, at, timeZone }) {
  const when = at
    ? new Intl.DateTimeFormat("en-US", { timeZone: timeZone || "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(at))
    : null;
  return `${BLOCK_PREFIX}${callNumber || "Call"}${when ? ` · ${when}` : ""}${techName ? ` · ${techName}` : ""}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Split a job field into blocks: [{ callNumber|null, text }]. Text before the first header
 * (the office's own typing) is a block with callNumber null and is always kept first.
 */
export function splitBlocks(existing) {
  const s = clean(existing);
  if (!s) return [];
  const re = new RegExp(`(^|\\n\\n)${escapeRe(BLOCK_PREFIX)}([A-Z]{1,4}-\\d{3,8})(?= ·|\\n|$)`, "g");
  const blocks = [];
  let last = 0;
  let lastNumber = null;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[1].length;
    const text = s.slice(last, m.index).trim();
    if (text || blocks.length === 0) blocks.push({ callNumber: lastNumber, text });
    lastNumber = m[2];
    last = start;
  }
  blocks.push({ callNumber: lastNumber, text: s.slice(last).trim() });
  return blocks.filter((b) => b.text);
}

/**
 * The job field with this call's block replaced / appended / removed.
 * Returns the new value (string or null when empty), or `undefined` when nothing changes.
 */
export function mergeCallBlock(existing, { callNumber, header, body }) {
  const text = clean(body).replace(ZERO_WIDTH_MARKER, "").trim();
  const block = text ? `${header}\n${text}` : null;
  const blocks = splitBlocks(existing);
  const idx = blocks.findIndex((b) => b.callNumber === callNumber);
  if (idx >= 0) {
    if (block) blocks[idx] = { callNumber, text: block };
    else blocks.splice(idx, 1);
  } else if (block) {
    blocks.push({ callNumber, text: block });
  }
  let out = blocks.map((b) => b.text).join("\n\n");
  if (out.length > JOB_NOTES_MAX) {
    const marker = "\n[… cut — the call's own notes hold the full text]";
    out = out.slice(0, JOB_NOTES_MAX - marker.length) + marker;
  }
  const next = out || null;
  const prev = clean(existing) || null;
  return next === prev ? undefined : next;
}

/**
 * The job fields to write for one Complete call, or null when the job already matches.
 * `job` needs the two notes fields; `call` needs Name, Work_Notes__c, Private_Notes__c.
 */
export function jobNotesFieldsFor(job, call, { techName, at, timeZone } = {}) {
  if (!call?.Name) return null;
  const header = blockHeader({ callNumber: call.Name, techName, at, timeZone });
  const fields = {};
  const work = mergeCallBlock(job?.[JOB_NOTES_FIELDS.work], { callNumber: call.Name, header, body: call.Work_Notes__c });
  if (work !== undefined) fields[JOB_NOTES_FIELDS.work] = work;
  const priv = mergeCallBlock(job?.[JOB_NOTES_FIELDS.private], { callNumber: call.Name, header, body: call.Private_Notes__c });
  if (priv !== undefined) fields[JOB_NOTES_FIELDS.private] = priv;
  return Object.keys(fields).length ? fields : null;
}

/**
 * The I/O half: read the job's two fields fresh (they are not in JOB_SELECT — long text on
 * every board read would be waste), merge, write, mark the job cache stale, log. Best-effort:
 * a failure is logged and never fails the tech's tap. Skips silently when the org does not
 * have the fields yet (the write would fail on an unknown field → logged, not thrown).
 */
export async function syncCallNotesToJob({ d, h, ctx, call, techName, at }) {
  const jobId = call?.Sundial_Service_Job__c;
  if (!jobId || call?.Status__c !== "Complete") return null;
  try {
    const rows = await d.sfQuery(
      `SELECT Id, ${JOB_NOTES_FIELDS.work}, ${JOB_NOTES_FIELDS.private} FROM ${h.JOB_SF_OBJECT} WHERE Id = '${soqlEscapeString(jobId)}' AND Client__c = '${soqlEscapeString(ctx.tenantId)}' LIMIT 1`
    );
    const job = rows?.[0];
    if (!job) return null;
    const fields = jobNotesFieldsFor(job, call, { techName, at, timeZone: h.DEFAULTS?.timeZone });
    if (!fields) return null;
    await d.sfUpdateRecord(h.JOB_SF_OBJECT, job.Id, fields);
    await h.markStale(h.CACHE.job, [job.Id], ctx.tenantId);
    await h.act(ctx, {
      event: h.EVENTS.JOB_UPDATED,
      recordType: "job",
      recordSfId: job.Id,
      jobSfId: job.Id,
      details: { callNotesRolledUp: call.Name, fields: Object.keys(fields), via: "call_complete" },
    });
    return fields;
  } catch (e) {
    console.error("job-notes: roll-up skipped:", e?.sfBody || e?.message || e);
    return null;
  }
}
