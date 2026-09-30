// preflight.js — check the WHOLE plan against the org before a single record is written.
//
// WHY SO STRICT: the integration user cannot delete Dealers, Estimates, Service Jobs,
// Service Calls, Price Book Items, Invoices, Payments or Tech Days. There is no undo from
// this side. A run that fails on record 400 of 700 because of a picklist value leaves a
// half-seeded tenant that only an admin can clean up. So everything that Salesforce would
// reject — and everything the demo's own safety rules forbid — is found here, reported
// in one complete list, and the run stops before writing.
//
// Two kinds of finding:
//   ERROR    the run cannot go ahead (a required field is missing, a value would be refused)
//   WARNING  an OPTIONAL field the org does not have (or will not take this value) is
//            dropped from the plan, and the run continues without it

import { isIsoDate, isIsoDateTime } from "./dates.js";
import { isToken, refsIn } from "./tokens.js";
import {
  SEEDED_OBJECTS, FORBIDDEN_OBJECTS, OBJ, isForbiddenField, isRequiredField, isDemoOwnedPicklist,
  FAKE_PHONE_RE, FAKE_PHONE_E164_RE, FAKE_EMAIL_RE, OWNER_EMAIL_RE, NATURAL_KEYS,
} from "./policy.js";
import { OFFICE_SMS_NUMBER } from "./catalog.js";
import { canaryTags } from "./canary.js";

const TEXT_TYPES = new Set(["string", "textarea", "phone", "email", "url", "id", "encryptedstring", "combobox"]);
const NUMBER_TYPES = new Set(["double", "currency", "percent", "int", "long"]);

/** Does a number fit a field's precision and scale without Salesforce having to round it? */
function numberProblem(value, def) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "is not a number";
  const scale = def.scale ?? 0;
  const factor = 10 ** scale;
  if (Math.abs(Math.round(value * factor) / factor - value) > 1e-9) return `has more than ${scale} decimal place(s)`;
  if (def.precision) {
    const whole = def.precision - scale;
    if (Math.abs(value) >= 10 ** whole) return `is too large for ${def.type}(${def.precision},${scale})`;
  }
  return null;
}

function valueProblem(value, def, sfObject, field, schema, fields, keyObject) {
  if (isToken(value)) {
    if ("$ref" in value) {
      if (def.type !== "reference") return "is a record reference but the field is not a lookup";
      const target = keyObject.get(value.$ref);
      if (!target) return `points at "${value.$ref}", which the plan never creates`;
      if (!(def.referenceTo || []).includes(target)) return `points at a ${target} but the lookup is to ${(def.referenceTo || []).join(" / ") || "?"}`;
      return null;
    }
    if (def.type === "reference") return "must be a record reference";
    if (!TEXT_TYPES.has(def.type)) return `is text but the field is ${def.type}`;
    return null;
  }
  if (def.type === "reference") return "must be a record reference (a raw id is never planned)";
  if (def.type === "boolean") return typeof value === "boolean" ? null : "is not true/false";
  if (NUMBER_TYPES.has(def.type)) return numberProblem(value, def);
  if (def.type === "date") return isIsoDate(value) ? null : "is not a YYYY-MM-DD date";
  if (def.type === "datetime") return isIsoDateTime(value) ? null : "is not an ISO date-time";
  if (def.type === "picklist" || def.type === "multipicklist") {
    if (typeof value !== "string" || value === "") return "is not text";
    const parts = def.type === "multipicklist" ? value.split(";") : [value];
    const live = new Set(def.values || []);
    // Only the picklists the demo owns may receive a value the org does not already have —
    // and only while Salesforce itself would accept it (the list is not restricted).
    const mayAdd = isDemoOwnedPicklist(sfObject, field) && !def.restricted;
    for (const part of parts) {
      if (!live.has(part) && !mayAdd) return `"${part}" is not a live value${def.restricted ? " (restricted picklist)" : ""}`;
    }
    if (def.controlledBy) {
      const controlling = fields[def.controlledBy];
      if (controlling === undefined || controlling === null) return `depends on ${def.controlledBy}, which is not set`;
      const allowed = def.dependentValues?.[String(controlling)] || [];
      for (const part of parts) if (!allowed.includes(part)) return `"${part}" is not allowed when ${def.controlledBy} = "${controlling}"`;
    }
    return null;
  }
  if (TEXT_TYPES.has(def.type)) {
    if (typeof value !== "string") return "is not text";
    if (def.length && value.length > def.length) return `is ${value.length} characters, the field holds ${def.length}`;
    if (def.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return "is not an email address";
    return null;
  }
  return `has a type this script does not write (${def.type})`;
}

/**
 * @param {object} plan     from buildPlan()
 * @param {Schema} schema   LIVE describes on a real run
 * @param {{ knownKeys?: Map<string,string> }} [extra]  keys created by an earlier run (key -> object), for --freshen
 * @returns {{ errors: string[], warnings: string[], ops: object[], dropped: Record<string, number> }}
 */
export function preflightPlan(plan, schema, extra = {}) {
  const errors = [];
  const dropped = new Map();
  const notes = new Set();
  const keyObject = new Map(extra.knownKeys || []);
  const createFields = new Map();
  const seen = new Set();

  for (const op of plan.ops) {
    if (seen.has(`${op.op}:${op.key}`)) errors.push(`${op.key}: planned twice`);
    seen.add(`${op.op}:${op.key}`);
    if (op.op === "create") {
      keyObject.set(op.key, op.object);
      createFields.set(op.key, op.fields);
    }
  }
  for (const sfObject of new Set(plan.ops.map((o) => o.object))) {
    if (FORBIDDEN_OBJECTS.includes(sfObject)) errors.push(`${sfObject}: the demo seed must never write this object`);
    else if (!SEEDED_OBJECTS.includes(sfObject)) errors.push(`${sfObject}: not an object this script seeds`);
    else if (!schema.has(sfObject)) errors.push(`${sfObject}: the org has no such object (or the integration user cannot see it)`);
    else {
      const o = schema.object(sfObject);
      if (!o.createable && plan.ops.some((x) => x.object === sfObject && x.op === "create")) errors.push(`${sfObject}: the integration user cannot create records here`);
      if (!o.updateable && plan.ops.some((x) => x.object === sfObject && x.op === "update")) errors.push(`${sfObject}: the integration user cannot update records here`);
    }
  }

  const drop = (sfObject, field, why) => {
    const id = `${sfObject}.${field}: ${why}`;
    dropped.set(id, (dropped.get(id) || 0) + 1);
  };
  const out = [];
  const errorOnce = (msg) => { if (!notes.has(msg)) { notes.add(msg); errors.push(msg); } };

  for (const op of plan.ops) {
    if (!schema.has(op.object) || FORBIDDEN_OBJECTS.includes(op.object)) continue;
    const isCreate = op.op === "create";
    if (!isCreate) {
      // Safety rule 4: an update may only ever target a record this plan (or an earlier
      // run of it, via the id-map) created.
      if (!keyObject.has(op.target)) { errors.push(`${op.key}: updates "${op.target}", which the plan does not own`); continue; }
      if (keyObject.get(op.target) !== op.object) { errors.push(`${op.key}: target "${op.target}" is a ${keyObject.get(op.target)}, not a ${op.object}`); continue; }
    }
    const fields = {};
    // A dependent picklist on an update is checked against the record's planned controlling value.
    const context = isCreate ? op.fields : { ...(createFields.get(op.target) || {}), ...op.fields };
    for (const [field, value] of Object.entries(op.fields)) {
      if (value === undefined) continue;
      if (value === null) {
        // A planned blank: only an UPDATE may clear a field, and only one that exists and can be written.
        if (!isCreate && schema.field(op.object, field)?.updateable && !isForbiddenField(op.object, field)) fields[field] = null;
        continue;
      }
      const required = isRequiredField(op.object, field);
      if (isForbiddenField(op.object, field)) { errorOnce(`${op.object}.${field}: this field must never be written by the demo seed`); continue; }
      const def = schema.field(op.object, field);
      if (!def) {
        if (required) errorOnce(`${op.object}.${field}: REQUIRED for the demo, but the org has no such field`);
        else drop(op.object, field, "the org has no such field");
        continue;
      }
      const writable = isCreate ? def.createable : def.updateable;
      if (!writable) {
        const why = def.formula ? "it is a formula" : def.autoNumber ? "it is an auto-number" : isCreate ? "it is not createable" : "it is not updateable";
        if (required) errorOnce(`${op.object}.${field}: REQUIRED for the demo, but ${why}`);
        else drop(op.object, field, why);
        continue;
      }
      const problem = valueProblem(value, def, op.object, field, schema, context, keyObject);
      if (problem) {
        const shown = isToken(value) ? "(a reference)" : JSON.stringify(value).slice(0, 60);
        if (required) errors.push(`${op.key}: ${field} ${problem} — value ${shown}`);
        else drop(op.object, field, `${problem} (${shown})`);
        continue;
      }
      fields[field] = value;
    }
    if (isCreate) {
      const o = schema.object(op.object);
      for (const [field, def] of Object.entries(o.fields)) {
        if (def.required && fields[field] === undefined) errors.push(`${op.key}: ${field} is required by Salesforce and the plan does not supply it`);
      }
      // Safety rule 3: every record is stamped with the demo tenant.
      if (o.fields.Client__c && op.object !== OBJ.tenant) {
        const c = fields.Client__c;
        if (!c || c.$ref !== "tenant") errors.push(`${op.key}: Client__c is not the demo tenant`);
      }
      out.push({ ...op, fields });
    } else if (Object.keys(fields).length) {
      out.push({ ...op, fields });
    }
  }

  // A reference to a record whose own create was refused above would fail at write time.
  const planned = new Set(out.filter((o) => o.op === "create").map((o) => o.key));
  for (const [k] of extra.knownKeys || []) planned.add(k);
  for (const op of out) {
    for (const key of refsIn(op.fields)) if (!planned.has(key)) errors.push(`${op.key}: needs "${key}", which will not be created`);
  }

  // Which records are canaries: the first create of each object and, on customers and solar
  // projects, the first create in each stage (canary.js). `op.canary` lists what the record
  // is the first of — for plan.json and the summary; the writer decides again at write
  // time from what has actually been read back so far.
  const firstOf = new Set();
  for (const op of out) {
    if (op.op !== "create") continue;
    const mine = canaryTags(op.object, op.fields).filter((tag) => !firstOf.has(`${op.object}|${tag}`));
    for (const tag of mine) firstOf.add(`${op.object}|${tag}`);
    if (mine.length) op.canary = mine;
  }

  // Fields the ORG will fill with its own default because the plan does not write them.
  // In this org those defaults are a real client's rates and prices, so the dry run names
  // every one (a default of 0 says nothing and is left out).
  const orgDefaults = [];
  const writtenBy = new Map();
  for (const op of out) {
    if (op.op !== "create") continue;
    if (!writtenBy.has(op.object)) writtenBy.set(op.object, { n: 0, counts: new Map() });
    const w = writtenBy.get(op.object);
    w.n++;
    for (const f of Object.keys(op.fields)) w.counts.set(f, (w.counts.get(f) || 0) + 1);
  }
  for (const [sfObject, w] of writtenBy) {
    for (const [field, def] of Object.entries(schema.object(sfObject).fields)) {
      if (!def.defaultFormula || !def.createable || Number(def.defaultFormula) === 0) continue;
      const covered = w.counts.get(field) || 0;
      if (covered < w.n) orgDefaults.push(`${sfObject}.${field} (org default ${String(def.defaultFormula).slice(0, 20)}) on ${w.n - covered} record(s)`);
    }
  }

  const warnings = [...dropped].map(([id, n]) => `dropped on ${n} record(s) — ${id}`);
  return { errors, warnings, ops: out, dropped: Object.fromEntries(dropped), orgDefaults };
}

// ---------------------------------------------------------------------------------------
// The demo's own safety rules, independent of any describe (also asserted by the tests).
// ---------------------------------------------------------------------------------------

const PHONE_LIKE = /\+1\d{10}|\(\d{3}\)\s?\d{3}-\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b/g;
const EMAIL_LIKE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function* strings(value, path) {
  if (typeof value === "string") yield [value, path];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* strings(value[i], `${path}[${i}]`);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) yield* strings(v, `${path}.${k}`);
}

/**
 * Every phone number and email anywhere in the plan must be fictional — except the demo
 * logins (the owner's plus-addresses) and the owner's own --demo-phone / --demo-email.
 * Nothing may mention Harmon. Returns a list of problems (empty = clean).
 */
export function lintPlan(plan) {
  const problems = [];
  const { demoPhone, demoEmail } = plan.meta.options || {};
  const phoneOk = (p) => FAKE_PHONE_RE.test(p) || FAKE_PHONE_E164_RE.test(p) || p === OFFICE_SMS_NUMBER || (demoPhone && p === demoPhone);
  const emailOk = (e) => FAKE_EMAIL_RE.test(e.toLowerCase()) || OWNER_EMAIL_RE.test(e) || (demoEmail && e === demoEmail);
  const scan = (value, where) => {
    for (const [s, path] of strings(value, where)) {
      for (const m of s.match(PHONE_LIKE) || []) if (!phoneOk(m)) problems.push(`${path}: phone "${m}" is not in the fictional 555-01xx range`);
      for (const m of s.match(EMAIL_LIKE) || []) if (!emailOk(m)) problems.push(`${path}: email "${m}" is not @example.com`);
      if (/harmon/i.test(s)) problems.push(`${path}: mentions Harmon`);
    }
  };
  for (const op of plan.ops) {
    if (FORBIDDEN_OBJECTS.includes(op.object)) problems.push(`${op.key}: writes ${op.object}`);
    for (const f of Object.keys(op.fields)) if (isForbiddenField(op.object, f)) problems.push(`${op.key}: writes ${f}`);
    scan(op.fields, op.key);
  }
  for (const [table, rows] of Object.entries(plan.supabase)) rows.forEach((row, i) => scan(row, `${table}[${i}]`));
  plan.files.forEach((f) => scan(f.lines, f.key));
  return problems;
}

/** The natural key of every planned record is unique — crash recovery depends on it. */
export function naturalKeyClashes(ops) {
  const clashes = [];
  const seen = new Map();
  for (const op of ops) {
    if (op.op !== "create") continue;
    const parts = NATURAL_KEYS[op.object];
    if (!parts) { clashes.push(`${op.object}: no natural key defined`); continue; }
    const id = `${op.object}|${parts.map((f) => JSON.stringify(op.fields[f] ?? null)).join("|")}`;
    if (seen.has(id)) clashes.push(`${op.key} and ${seen.get(id)} share the natural key of ${op.object}`);
    seen.set(id, op.key);
  }
  return clashes;
}
