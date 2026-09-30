// tokens.js — placeholders the plan uses for values that only exist AFTER a write.
//
// WHY: the plan is built before anything is written, so it cannot know a Salesforce Id,
// an auto-number (SVC-00042) or a Supabase auth uuid. Instead of those values it carries
// small marker objects; the writer swaps each marker for the real value at the moment it
// writes the record. That keeps the plan pure, printable as JSON, and identical between
// two runs with the same seed.
//
//   { $ref: "customer:017" }            -> that record's Salesforce Id
//   { $name: "job:031" }                -> that record's auto-number Name (read back after insert)
//   { $auth: "user:dana" }              -> that demo user's Supabase auth uuid
//   { $json: <any structure> }          -> JSON text of the structure, markers inside resolved first
//   { $concat: [a, b, ...] }            -> the parts joined into one string
//   { $jobNotes: { kind, calls: [...] } } -> the job's call-notes roll-up (needs the call numbers)

export const ref = (key) => ({ $ref: key });
export const nameOf = (key) => ({ $name: key });
export const authId = (key) => ({ $auth: key });
export const json = (value) => ({ $json: value });
export const concat = (...parts) => ({ $concat: parts });

export const isToken = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) &&
  ("$ref" in v || "$name" in v || "$auth" in v || "$json" in v || "$concat" in v || "$jobNotes" in v);
export const isRef = (v) => v !== null && typeof v === "object" && "$ref" in v;

/** Every record key a value depends on (so the writer can say "run phase X first"). */
export function refsIn(value, out = new Set()) {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const v of value) refsIn(v, out);
    return out;
  }
  if ("$ref" in value) out.add(value.$ref);
  else if ("$name" in value) out.add(value.$name);
  else if ("$jobNotes" in value) for (const c of value.$jobNotes.calls) out.add(c.key);
  else for (const v of Object.values(value)) refsIn(v, out);
  return out;
}

/**
 * Swap markers for real values.
 * @param {*} value
 * @param {{ idOf:(key)=>string, nameOf:(key)=>Promise<string>, authOf:(key)=>string, jobNotes?:(spec)=>Promise<string|null> }} ctx
 */
export async function resolveValue(value, ctx) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolveValue(v, ctx)));
  if ("$ref" in value) return ctx.idOf(value.$ref);
  if ("$name" in value) return ctx.nameOf(value.$name);
  if ("$auth" in value) return ctx.authOf(value.$auth);
  if ("$concat" in value) return (await Promise.all(value.$concat.map((v) => resolveValue(v, ctx)))).join("");
  if ("$json" in value) return JSON.stringify(await resolveValue(value.$json, ctx));
  if ("$jobNotes" in value) return ctx.jobNotes(value.$jobNotes);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = await resolveValue(v, ctx);
  return out;
}

/** Resolve every field of a record. */
export async function resolveFields(fields, ctx) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = await resolveValue(v, ctx);
  return out;
}
