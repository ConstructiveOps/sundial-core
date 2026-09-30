// canary.js — write ONE record, read it back in full, and stop if anything is off.
//
// CLAUDE.md, "Bulk data fixes: canary first": the integration user cannot list the org's
// Flows or triggers, and the repo's flow files may never have been deployed — so the only
// way to learn whether automation reacts to a demo record is to write one and look.
//
// Two checks on a canary record:
//
//   1. every field the script wrote reads back as written (allowing for the way
//      Salesforce hands values back: "+0000" on date-times, the order of a multi-select);
//   2. NO OTHER field holds a value. The exceptions are fields the describe itself
//      explains — formulas, auto-numbers, system fields, and fields with a default (a
//      checkbox is false, a picklist shows its default, a number shows its default
//      formula). Anything else was written by something that is not this script: a
//      record-triggered Flow, a trigger, a workflow. That is reported and the run STOPS.
//
// WHICH RECORDS are canaries (canaryTags below):
//   * the first record of every object;
//   * on Sundial_Customer__c and Sundial_Solar__c — the two objects with stage-driven
//     automation — ALSO the first record in each stage: a Flow that only fires on
//     "Install Scheduled" is invisible to a canary written in "Permit Submitted".
//
// The draft budget-recalc Flow on Solar (it would set Budget_Calc_Status__c = Pending)
// and any stage-driven automation on Customer are exactly what check 2 is for.
//
// THE READ-BACK AND SALESFORCE'S LIMITS: lib/salesforce.js sfQuery() sends the SOQL in the
// URL (GET /query?q=…). Salesforce refuses a request line much over 16,000 characters,
// and Sundial_Solar__c has 510 fields (12,600 characters of field names, more once the
// commas and spaces are URL-encoded). So the field list is split across several queries,
// each bounded by its ENCODED length and by a field count; and if Salesforce still refuses
// one as too long or too complicated, that query is halved and retried.

import { OBJ } from "./policy.js";

/** No single SOQL string this tool sends may be longer than this (asserted by the tests). */
export const SOQL_HARD_LIMIT = 12000;
/** What one canary read-back query aims for: URL-encoded length, and fields per query. */
export const CANARY_URI_CHARS = 7000;
export const CANARY_MAX_FIELDS = 210;
const SYSTEM_FIELDS = new Set([
  "Id", "OwnerId", "IsDeleted", "CreatedDate", "CreatedById", "LastModifiedDate", "LastModifiedById",
  "SystemModstamp", "LastActivityDate", "LastViewedDate", "LastReferencedDate", "Name",
]);

const blank = (v) => v === null || v === undefined || v === "";
const norm = (s) => String(s).replace(/\r\n?/g, "\n").trim();

/** Does a read-back value equal what was written, for a field of this type? */
export function sameValue(written, read, def) {
  if (blank(written) && blank(read)) return true;
  if (blank(written) || blank(read)) return false;
  switch (def?.type) {
    case "boolean":
      return written === read;
    case "double": case "currency": case "percent": case "int": case "long":
      // The preflight already made sure the value fits the field's scale, so this only
      // has to absorb floating-point noise.
      return Math.abs(Number(written) - Number(read)) < Math.max(1e-9, 10 ** -((def.scale ?? 0) + 1));
    case "datetime":
      // Salesforce keeps seconds, and returns "2026-09-20T17:03:11.000+0000".
      return Math.floor(Date.parse(written) / 1000) === Math.floor(Date.parse(String(read).replace(/\+0000$/, "Z")) / 1000);
    case "date":
      return String(written) === String(read).slice(0, 10);
    case "multipicklist":
      return String(written).split(";").sort().join(";") === String(read).split(";").sort().join(";");
    case "email":
      return norm(written).toLowerCase() === norm(read).toLowerCase();
    case "phone":
      // Only the digits matter; Salesforce may hand a number back with its own punctuation.
      return String(written).replace(/\D/g, "") === String(read).replace(/\D/g, "");
    case "reference":
      // 15- and 18-character forms of one id are the same record.
      return String(written).slice(0, 15) === String(read).slice(0, 15);
    default:
      return norm(written) === norm(read);
  }
}

/** Is an unplanned value explained by the describe (a default), so not a surprise? */
function explainedByDefault(value, def) {
  if (def.type === "boolean") return value === (String(def.defaultValue) === "true");
  if (def.defaultPicklistValue !== undefined) return value === def.defaultPicklistValue;
  if (def.defaultValue !== undefined && def.defaultValue !== null) return String(value) === String(def.defaultValue);
  if (def.defaultFormula) return true; // a number default ("0", "75") — reported, not refused
  if (def.defaultedOnCreate) return true;
  return false;
}

// ---------------------------------------------------------------------------------------
// Which canaries a record stands for
// ---------------------------------------------------------------------------------------

/**
 * The canary "tags" of a record: "first" (the first record of its object) and, on the two
 * objects with stage-driven automation, one tag per stage it sits in. A tag is settled
 * once ONE record carrying it has been read back clean.
 *
 *   Sundial_Solar__c     stage: <Stage__c>
 *   Sundial_Customer__c  stage: <Status__c> / <Stage__c>      (the sales pipeline — status
 *                        status: <Status__c>                   alone when there is no stage)
 *                        service stage: <Service_Stage__c>     (the Service pipeline, D-075)
 */
export function canaryTags(sfObject, fields) {
  const tags = ["first"];
  const v = (x) => (typeof x === "string" && x !== "" ? x : null);
  if (sfObject === OBJ.solar) {
    if (v(fields.Stage__c)) tags.push(`stage: ${fields.Stage__c}`);
  } else if (sfObject === OBJ.customer) {
    const status = v(fields.Status__c);
    const stage = v(fields.Stage__c);
    if (stage) tags.push(`stage: ${status ?? "(no status)"} / ${stage}`);
    else if (status) tags.push(`status: ${status}`);
    if (v(fields.Service_Stage__c)) tags.push(`service stage: ${fields.Service_Stage__c}`);
  }
  return tags;
}
/** For the log: "first record, stage: Sold". */
export const describeTags = (tags) => tags.map((t) => (t === "first" ? "first record" : t)).join(", ");

// ---------------------------------------------------------------------------------------
// Reading one record in full, inside Salesforce's URL limits
// ---------------------------------------------------------------------------------------

const readBackSoql = (sfObject, id, part) => `SELECT Id, ${part.join(", ")} FROM ${sfObject} WHERE Id = '${id}'`;

/** Split a field list into queries bounded by encoded length and by field count. */
export function packFields(sfObject, id, names, { maxUri = CANARY_URI_CHARS, maxFields = CANARY_MAX_FIELDS } = {}) {
  // The encoded length is counted as the list grows (", " is 6 characters once encoded)
  // rather than by re-encoding the whole query for every field.
  const base = encodeURIComponent(readBackSoql(sfObject, id, ["X"])).length - 1;
  const SEPARATOR = encodeURIComponent(", ").length;
  const parts = [];
  let part = [];
  let size = base;
  for (const name of names) {
    if (name === "Id") continue;
    const add = encodeURIComponent(name).length + (part.length ? SEPARATOR : 0);
    if (part.length && (part.length >= maxFields || size + add > maxUri)) {
      parts.push(part);
      part = [];
      size = base;
    }
    size += encodeURIComponent(name).length + (part.length ? SEPARATOR : 0);
    part.push(name);
  }
  if (part.length) parts.push(part);
  return parts;
}

/** Salesforce saying "this request is too big", as opposed to "this query is wrong". */
function tooBig(e) {
  if (e?.sfStatus === 414 || e?.sfStatus === 431) return true;
  return e?.sfStatus === 400 && /QUERY_TOO_COMPLICATED|URI_TOO_LONG|REQUEST_HEADER/i.test(typeof e?.sfBody === "string" ? e.sfBody : JSON.stringify(e?.sfBody ?? ""));
}

/**
 * Read every named field of one record. `limits` is remembered by the caller per object:
 * once a query had to be halved, later read-backs of that object start at the smaller size.
 * @returns {Promise<{ record: object|null, queries: number }>}
 */
export async function readRecordInFull({ sfQuery, sfObject, id, names, limits = {} }) {
  const record = {};
  let queries = 0;
  const queue = packFields(sfObject, id, names, limits);
  while (queue.length) {
    const part = queue.shift();
    let rows;
    try {
      queries++;
      rows = await sfQuery(readBackSoql(sfObject, id, part));
    } catch (e) {
      if (part.length > 1 && tooBig(e)) {
        const half = Math.ceil(part.length / 2);
        limits.maxFields = Math.min(limits.maxFields ?? CANARY_MAX_FIELDS, half);
        queue.unshift(part.slice(0, half), part.slice(half));
        continue;
      }
      throw e;
    }
    if (!rows?.[0]) return { record: null, queries };
    Object.assign(record, rows[0]);
  }
  return { record, queries };
}

/**
 * @param {object} p
 *   sfQuery, schema, sfObject, id
 *   written   the exact field map that was sent to Salesforce
 *   accepted  field names whose difference the owner has accepted (--accept-canary)
 *   limits    { maxUri?, maxFields? } — mutable, see readRecordInFull
 * @returns {Promise<{ ok:boolean, mismatches:string[], surprises:string[], fields:string[], tolerated:string[], defaulted:string[], checked:number, queries:number }>}
 */
export async function checkCanary({ sfQuery, schema, sfObject, id, written, accepted = [], limits = {} }) {
  const defs = schema.object(sfObject).fields;
  const names = Object.keys(defs).filter((n) => defs[n].type !== "address" && defs[n].type !== "location");
  const { record, queries } = await readRecordInFull({ sfQuery, sfObject, id, names, limits });
  if (!record) return { ok: false, mismatches: [`record ${id} could not be read back`], surprises: [], fields: [], tolerated: [], defaulted: [], checked: 0, queries };
  const ok = new Set(accepted);
  const mismatches = [];
  const surprises = [];
  const fields = [];
  const tolerated = [];
  const defaulted = [];
  const show = (v) => JSON.stringify(v ?? null).slice(0, 70);
  for (const [field, value] of Object.entries(written)) {
    if (sameValue(value, record[field], defs[field])) continue;
    if (ok.has(field)) { tolerated.push(field); continue; }
    fields.push(field);
    mismatches.push(`${field}: wrote ${show(value)}, read back ${show(record[field])}`);
  }
  for (const name of names) {
    if (name in written || SYSTEM_FIELDS.has(name)) continue;
    const def = defs[name];
    // Formulas, auto-numbers and roll-ups are Salesforce's to fill.
    if (def.formula || def.autoNumber || (!def.createable && !def.updateable)) continue;
    const value = record[name];
    if (blank(value)) continue;
    if (explainedByDefault(value, def)) {
      // Worth telling the owner about: a number the ORG put there (it may be a client's
      // rate or price). A default of zero, false or a picklist's own default says nothing.
      if (def.type !== "boolean" && def.defaultPicklistValue === undefined && Number(value) !== 0) defaulted.push(name);
      continue;
    }
    if (ok.has(name)) { tolerated.push(name); continue; }
    fields.push(name);
    surprises.push(`${name}: holds ${show(value)} but this script never wrote it`);
  }
  return { ok: mismatches.length === 0 && surprises.length === 0, mismatches, surprises, fields, tolerated, defaulted, checked: names.length, queries };
}
