// schema.js — what the Salesforce org accepts, read from describes.
//
// WHY: the repo does not know the org's picklists, which fields are formulas, or which
// packages are deployed (CLAUDE.md: the base fields were created in Setup). A seed that
// guesses fails on a restricted picklist half-way through 700 records — and the
// integration user cannot delete most of what it created. So every field, type and
// picklist value the plan wants to write is checked against a describe FIRST.
//
// At run time the describes are LIVE (lib/salesforce.js describeObject). The captured
// migration/demo/probe.json has the same information in a summarised shape; it is used
// by the tests and by `--offline`, never as the truth for a real run.

/**
 * A dependent picklist's `validFor` is a base64 bitmap, bits packed MSB-first:
 * controlling index i lives in byte (i >> 3) at mask (0x80 >> (i & 7)). Same decoding as
 * sundial-sf-query and scripts/probe-demo-prereqs.mjs.
 */
export function decodeValidFor(validFor) {
  if (!validFor) return [];
  let bytes;
  try {
    bytes = Buffer.from(validFor, "base64");
  } catch {
    return [];
  }
  const out = [];
  for (let i = 0; i < bytes.length * 8; i++) {
    if (bytes[i >> 3] & (0x80 >> (i & 7))) out.push(i);
  }
  return out;
}

/** The reverse — only the test fake needs it, to hand back a realistic raw describe. */
export function encodeValidFor(indices, controllingCount) {
  const bytes = Buffer.alloc(Math.max(1, Math.ceil(controllingCount / 8)));
  for (const i of indices) bytes[i >> 3] |= 0x80 >> (i & 7);
  return bytes.toString("base64");
}

/** One raw describe field -> the facts the seed cares about. */
function summarizeField(f, byName) {
  const out = {
    label: f.label,
    type: f.type,
    createable: f.createable === true,
    updateable: f.updateable === true,
    // Required on create = may not be blank AND nothing fills it for us.
    required: f.nillable === false && f.defaultedOnCreate !== true && f.createable === true,
  };
  if (f.calculated) out.formula = true;
  if (f.autoNumber) out.autoNumber = true;
  if (f.externalId) out.externalId = true;
  if (f.unique) out.unique = true;
  if (f.length) out.length = f.length;
  if (f.precision) out.precision = f.precision;
  if (f.scale) out.scale = f.scale;
  if (f.referenceTo?.length) out.referenceTo = f.referenceTo;
  if (f.defaultValue != null) out.defaultValue = f.defaultValue;
  // A number/currency/percent default lives here as a formula expression ("75", "0").
  // The probe file did not capture it; a live describe does, and the canary needs it to
  // tell "the org filled its default" from "an automation wrote this".
  if (f.defaultValueFormula != null && f.defaultValueFormula !== "") out.defaultFormula = String(f.defaultValueFormula);
  if (f.defaultedOnCreate === true) out.defaultedOnCreate = true;
  if (f.type === "picklist" || f.type === "multipicklist") {
    const active = (f.picklistValues || []).filter((p) => p.active);
    out.values = active.map((p) => p.value);
    const dflt = active.find((p) => p.defaultValue);
    if (dflt) out.defaultPicklistValue = dflt.value;
    if (f.restrictedPicklist) out.restricted = true;
    if (f.controllerName) {
      out.controlledBy = f.controllerName;
      const controller = byName.get(f.controllerName);
      // A checkbox controller has two implicit values in this order.
      const controlling =
        controller?.type === "boolean" ? ["false", "true"] : (controller?.picklistValues || []).map((p) => p.value);
      const map = {};
      for (const c of controlling) map[c] = [];
      for (const p of active) {
        for (const i of decodeValidFor(p.validFor)) {
          const c = controlling[i];
          if (c !== undefined) map[c].push(p.value);
        }
      }
      out.dependentValues = map;
    }
  }
  return out;
}

/** A raw describe payload -> { label, createable, updateable, nameField, fields: { name: summary } }. */
export function summarizeDescribe(meta) {
  const byName = new Map((meta.fields || []).map((f) => [f.name, f]));
  const fields = {};
  for (const f of meta.fields || []) fields[f.name] = summarizeField(f, byName);
  const nameField = (meta.fields || []).find((f) => f.nameField);
  return {
    label: meta.label,
    createable: meta.createable === true,
    updateable: meta.updateable === true,
    deletable: meta.deletable === true,
    nameField: nameField ? { name: nameField.name, autoNumber: nameField.autoNumber === true } : null,
    fields,
  };
}

/** Read-only view over the summaries, with the questions the plan and the preflight ask. */
export class Schema {
  /** @param {Record<string, object>} objects  sfObject -> summary (or { absent: true }) */
  constructor(objects) {
    this.objects = objects;
  }
  has(sfObject) {
    const o = this.objects[sfObject];
    return !!o && !o.absent && !o.error;
  }
  object(sfObject) {
    return this.has(sfObject) ? this.objects[sfObject] : null;
  }
  field(sfObject, name) {
    return this.object(sfObject)?.fields?.[name] ?? null;
  }
  hasField(sfObject, name) {
    return !!this.field(sfObject, name);
  }
  /** Can a create carry this field? */
  writable(sfObject, name) {
    return this.field(sfObject, name)?.createable === true;
  }
  /** The active picklist values ([] when the field is missing or not a picklist). */
  values(sfObject, name) {
    return this.field(sfObject, name)?.values ?? [];
  }
  isLive(sfObject, name, value) {
    return this.values(sfObject, name).includes(value);
  }
  /** The entries of `preferred` the org really has, in the preferred order. */
  liveSubset(sfObject, name, preferred) {
    const live = new Set(this.values(sfObject, name));
    return preferred.filter((v) => live.has(v));
  }
  /** The first preferred value that is live, else null. */
  firstLive(sfObject, name, preferred) {
    return this.liveSubset(sfObject, name, preferred)[0] ?? null;
  }
  /** Dependent picklist: the values allowed under one controlling value. */
  dependent(sfObject, name, controllingValue) {
    return this.field(sfObject, name)?.dependentValues?.[controllingValue] ?? [];
  }
}

/** Describe every object live. A missing object (404) is recorded as absent, not thrown. */
export async function loadLiveSchema(describeObject, sfObjects) {
  const out = {};
  for (const o of sfObjects) {
    try {
      out[o] = summarizeDescribe(await describeObject(o, { forceRefresh: true }));
    } catch (e) {
      if (e?.sfStatus === 404) out[o] = { absent: true };
      else {
        const err = new Error(`describe ${o} failed (${e?.sfStatus ?? e?.message ?? "?"})`);
        err.cause = e;
        throw err;
      }
    }
  }
  return new Schema(out);
}

/** The captured probe file -> a Schema (tests and `--offline`). */
export function schemaFromProbe(probe) {
  return new Schema(probe.salesforce);
}
