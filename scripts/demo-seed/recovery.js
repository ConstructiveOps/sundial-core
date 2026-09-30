// recovery.js — rebuilding the id-map after migration/demo/id-map.json was lost.
//
// THE SITUATION: the id-map lives on one PC. Without it the script no longer knows which
// records it created, nor the ANCHOR date and SEED the plan was built from — and a plan
// built from today's date has different calls, payments and tech days, so a second seed
// would pile duplicates onto a tenant whose records the integration user cannot delete.
//
// WHAT MAKES RECOVERY POSSIBLE: run-record.js keeps the anchor, seed, options and the
// --freshen dates in the `sundial/demo-users` secret. With those, the ORIGINAL plan is
// rebuilt and every record under the tenant is matched back to its planned key
// (writer.js reconcile, `recovering: true`). This file holds the parts of that which are
// only ever used while rebuilding:
//
//   looksSeeded            is this tenant one the seed has written to before?
//   recoverFreshenRecords  calls / tech days that --freshen added (they are not in the plan)
//   recoverCallsByPosition a job's calls, by the order they were created in
//   restoreSteps           which follow-up updates were already made
//   restoreAuthUsers       which Supabase login each demo user is bound to
//
// WHAT IS NOT RECOVERABLE, by design: a planned record whose identifying fields were
// edited (a customer renamed, an estimate's scope rewritten, a payment's amount changed).
// It can no longer be told apart from a record somebody made by hand, so the run refuses
// rather than create it a second time — see `unresolved` in reconcile().

import { OBJ } from "./policy.js";
import { DEALERS, PERSONAS } from "./catalog.js";
import { PRICE_BOOK } from "./service-catalog.js";

/** Extra fields the rebuild reads, per object, on top of the natural key. */
export const RECOVERY_EXTRA_FIELDS = Object.freeze({
  [OBJ.call]: ["Clock_Intervals__c"],
  [OBJ.day]: ["Day_Log__c"],
});

/**
 * The lookup that ties a record to the one it hangs off. A planned record that was not
 * found can only be hiding among the unrecognised records under the SAME parent.
 * Objects not listed have no parent: any unrecognised record of the object counts.
 */
export const PARENT_FIELD = Object.freeze({
  [OBJ.solar]: "Sundial_Customer__c",
  [OBJ.roofing]: "Sundial_Customer__c",
  [OBJ.estimate]: "Sundial_Customer__c",
  [OBJ.line]: "Estimate__c",
  [OBJ.job]: "Estimate__c",
  [OBJ.call]: "Sundial_Service_Job__c",
  [OBJ.invoice]: "Service_Job__c",
  [OBJ.payment]: "Service_Job__c",
});

const id15 = (v) => String(v ?? "").slice(0, 15);
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const inList = (ids) => ids.map((id) => `'${id}'`).join(", ");
const soqlText = (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/**
 * READ-ONLY. Has the seed written to this tenant before? The three things every seed
 * writes first, and that do not depend on the date or the random seed: the dealers (by
 * name), the demo users (by login email) and the price book (by item code).
 * @returns {Promise<{ seeded:boolean, dealers:number, users:number, items:number }>}
 */
export async function looksSeeded({ sf, schema, tenantId }) {
  const count = async (sfObject, field, values) => {
    if (!schema.has(sfObject) || !schema.hasField(sfObject, field) || !schema.hasField(sfObject, "Client__c")) return 0;
    const rows = await sf.sfQuery(`SELECT Id, ${field} FROM ${sfObject} WHERE Client__c = '${tenantId}' AND ${field} IN (${values.map((v) => `'${soqlText(v)}'`).join(", ")})`);
    return (rows || []).length;
  };
  const dealers = await count(OBJ.dealer, "Name", DEALERS.map((d) => d.name));
  const users = await count(OBJ.user, "Email__c", PERSONAS.map((p) => p.email));
  const items = await count(OBJ.item, "Item_Code__c", PRICE_BOOK.map((i) => i.code));
  return { seeded: dealers + users + items > 0, dealers, users, items };
}

// --- records --freshen added ----------------------------------------------------------------
// freshen.js names every clock tap and day-log entry it writes after the record's own key:
//   call  "demo-fresh:2026-10-15:call:2026-10-13:marcus:3-1"   -> fresh:2026-10-15:call:2026-10-13:marcus:3
//   day   "demo-fresh:2026-10-15:day-marcus-2026-10-13-start"  -> fresh:2026-10-15:day:marcus:2026-10-13
// Those logs are append-only in the portal (a correction flags an entry, it never removes
// one), so the key can be read back off the record itself.
const FRESH_CALL_RE = /"demo-(fresh:\d{4}-\d{2}-\d{2}:call:\d{4}-\d{2}-\d{2}:[a-z0-9-]+:\d+)-\d+"/;
const FRESH_DAY_RE = /"demo-(fresh:\d{4}-\d{2}-\d{2}:day)-([a-z0-9]+)-(\d{4}-\d{2}-\d{2})-(?:start|end)/;
/** A call the SEED created, from a tap the seed (or a later --freshen) wrote on it: -> "call:031-2". */
const SEED_CALL_RE = /"demo-(?:fresh:\d{4}-\d{2}-\d{2}-)?call-(\d{3}-\d+)-\d+"/;

export function freshenKeyOf(sfObject, row) {
  if (sfObject === OBJ.call) return FRESH_CALL_RE.exec(String(row.Clock_Intervals__c ?? ""))?.[1] ?? null;
  if (sfObject === OBJ.day) {
    const m = FRESH_DAY_RE.exec(String(row.Day_Log__c ?? ""));
    return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
  }
  return null;
}
export function seedCallKeyOf(row) {
  const m = SEED_CALL_RE.exec(String(row.Clock_Intervals__c ?? ""));
  return m ? `call:${m[1]}` : null;
}

/** Calls / tech days an earlier --freshen added, recognised by the key in their own log. */
export function recoverFreshenRecords({ sfObject, rows, idmap, keyOfId }) {
  const hits = [];
  const seen = new Set();
  for (const row of rows) {
    if (keyOfId.has(row.Id)) continue;
    const key = freshenKeyOf(sfObject, row);
    if (!key || idmap.has(key) || seen.has(key)) continue;
    seen.add(key);
    hits.push({ key, id: row.Id });
  }
  return hits;
}

/**
 * A job's calls, by creation order.
 *
 * WHY THIS IS SOUND: the seed writes a job and then, straight away, that job's calls in
 * plan order — before the job can be seen anywhere (the list pages only show it after a
 * cache sync). So the oldest calls under a seeded job are the seed's, in plan order, no
 * matter what --freshen or the dispatch board did to their time, tech or status since.
 * Calls added later (in the portal, or by --freshen) are younger and come after them.
 *
 * It is only used for a job when nothing contradicts it: a call already recognised by
 * its natural key, or carrying its own key in its clock log, must sit at the very
 * position the order says. One contradiction and the whole job is left alone (and the
 * run then refuses, because a planned call is missing next to an unrecognised one).
 *
 * `rows` must be sorted oldest first.
 */
export function recoverCallsByPosition({ rows, planned, idmap, keyOfId }) {
  const hits = [];
  const plannedByJob = new Map();
  for (const op of planned) {
    const jobKey = op.fields.Sundial_Service_Job__c?.$ref;
    if (!jobKey) continue;
    if (!plannedByJob.has(jobKey)) plannedByJob.set(jobKey, []);
    plannedByJob.get(jobKey).push(op);
  }
  for (const [jobKey, list] of plannedByJob) {
    const jobId = idmap.idOf(jobKey);
    if (!jobId || list.every((op) => idmap.has(op.key))) continue;
    const inOrg = rows.filter((r) => id15(r.Sundial_Service_Job__c) === id15(jobId) && !String(keyOfId.get(r.Id) ?? "").startsWith("fresh:"));
    const n = Math.min(list.length, inOrg.length);
    let sound = true;
    for (let i = 0; i < n && sound; i++) {
      const mapped = idmap.idOf(list[i].key);
      const known = keyOfId.get(inOrg[i].Id);
      const marker = seedCallKeyOf(inOrg[i]);
      if (mapped && mapped !== inOrg[i].Id) sound = false;
      if (known && known !== list[i].key) sound = false;
      if (marker && marker !== list[i].key) sound = false;
    }
    if (!sound) continue;
    for (let i = 0; i < n; i++) if (!idmap.has(list[i].key) && !keyOfId.has(inOrg[i].Id)) hits.push({ key: list[i].key, id: inOrg[i].Id });
  }
  return hits;
}

/**
 * READ-ONLY apart from the id-map. Which of the plan's follow-up updates were already
 * made? An update whose every field already holds a value on its target is marked done
 * and never sent again — re-sending the job-notes roll-up, for one, would wipe the blocks
 * --freshen and the techs have added since. An update with a blank field is left to run.
 * @returns {Promise<number>} how many were marked done
 */
export async function restoreSteps({ sf, idmap, ops }) {
  const byObject = new Map();
  for (const op of ops) {
    if (op.op !== "update" || idmap.steps[op.key]) continue;
    const id = idmap.idOf(op.target);
    if (!id) continue;
    if (!byObject.has(op.object)) byObject.set(op.object, []);
    byObject.get(op.object).push({ op, id });
  }
  let done = 0;
  for (const [sfObject, list] of byObject) {
    const fields = [...new Set(list.flatMap((x) => Object.keys(x.op.fields)))];
    const rows = new Map();
    for (const part of chunk([...new Set(list.map((x) => x.id))], 150)) {
      for (const r of await sf.sfQuery(`SELECT Id, ${fields.join(", ")} FROM ${sfObject} WHERE Id IN (${inList(part)})`)) rows.set(r.Id, r);
    }
    for (const { op, id } of list) {
      const row = rows.get(id);
      if (!row) continue;
      const filled = Object.keys(op.fields).every((f) => row[f] !== null && row[f] !== undefined && row[f] !== "");
      if (filled) {
        idmap.data.steps[op.key] = true;
        done++;
      }
    }
  }
  return done;
}

/** READ-ONLY apart from the id-map: each demo user's login, as the user record itself says. */
export async function restoreAuthUsers({ sf, idmap }) {
  const keys = PERSONAS.map((p) => p.key).filter((k) => idmap.has(k) && !idmap.data.supabase.authUsers[k]);
  if (!keys.length) return 0;
  const rows = await sf.sfQuery(`SELECT Id, Supabase_User_Id__c FROM ${OBJ.user} WHERE Id IN (${inList(keys.map((k) => idmap.idOf(k)))})`);
  const byId = new Map((rows || []).map((r) => [r.Id, r.Supabase_User_Id__c]));
  let n = 0;
  for (const k of keys) {
    const auth = byId.get(idmap.idOf(k));
    if (auth) {
      idmap.data.supabase.authUsers[k] = auth;
      n++;
    }
  }
  return n;
}
