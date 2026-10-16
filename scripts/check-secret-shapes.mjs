// Are the per-tenant secrets shaped the way the Lambdas read them?
//
// WHY (2026-10-01): adding the demo tenant's block to `sundial/stripe` made the PRIMARY
// tenant's Service module answer "Stripe isn't set up" — lib/stripe.js found no usable
// `tenants.harmon` entry any more. A secret can be saved in ways that look right in the
// console and still read wrong:
//
//   1. STRINGIFIED BLOCK — the console's "Key/value" editor saves a nested block as TEXT:
//        { "tenants": "{\"harmon\":{…}}" }      ← a string, not an object
//      so `secret.tenants.harmon` is undefined.
//   2. DUPLICATE KEY — a second `"tenants": { … }` block added beside the first. JSON keeps
//      only the LAST one, so the first block (the primary tenant's) silently disappears.
//   3. NOT VALID JSON — a missing or extra comma. Every tenant reads "not set up".
//   4. The block was put in the wrong place, or the primary tenant's block was replaced.
//
// This script reads each secret's raw text and says which of these it is.
//
// VALUE-SAFETY: it prints KEY NAMES and TYPES only — never a value. The one thing derived
// from a value is a Stripe key's mode ("live" / "test"), read off its public prefix.
//
//   node scripts/check-secret-shapes.mjs                      read-only: all four secrets
//   node scripts/check-secret-shapes.mjs sundial/stripe       read-only: one secret
//   node scripts/check-secret-shapes.mjs --fix sundial/stripe repair cases 1–3 where it is
//                                                             unambiguous, and save
//   node scripts/check-secret-shapes.mjs --restore-previous sundial/stripe
//                                                             case 4: put back the version from
//                                                             before the last save (only when
//                                                             that version checks out)
//
// --fix changes ONLY the secret's structure (un-stringifies blocks, merges duplicate
// blocks, drops a stray comma) — every value is carried over untouched and never shown.
// It refuses when the repair is ambiguous, and — for sundial/stripe — when the primary
// tenant would still not be configured afterwards. Secrets Manager keeps the version it
// replaces (stage AWSPREVIOUS), so the save can be undone.

import { pathToFileURL } from "node:url";
import { stripeConfigFor } from "../lib/stripe.js";
import { primaryTenantSlug } from "../lib/tenant-guard.js";

const REGION = "us-west-1";
export const SECRETS = ["sundial/stripe", "sundial/twilio", "sundial/brand", "sundial/service-club"];
/** The Lambdas that hold each secret in memory while warm (they must restart to see a change). */
export const READERS = {
  "sundial/stripe": ["sundial-service-estimate", "sundial-service-public"],
  "sundial/twilio": ["sundial-sms", "sundial-service-board", "sundial-service-estimate"],
  "sundial/brand": ["sundial-service-estimate", "sundial-service-public", "sundial-auth-proxy", "sundial-user-admin", "sundial-comment-notify", "sundial-sms", "sundial-service-board"],
  "sundial/service-club": ["sundial-service-estimate"],
};

// ---------------------------------------------------------------------------------------
// A JSON reader that KEEPS duplicate keys and forgives a stray / missing comma, so the
// shape can be reported (and repaired) where JSON.parse would either hide the problem
// (duplicates) or stop at it (commas). Errors carry a position, never any of the text.
// ---------------------------------------------------------------------------------------
export class ShapeError extends Error {}

export function readLoose(text) {
  let i = 0;
  const notes = [];
  const where = () => {
    const before = text.slice(0, i);
    const line = before.split("\n").length;
    const col = i - before.lastIndexOf("\n");
    return `line ${line}, column ${col}`;
  };
  const fail = (what) => { throw new ShapeError(`not valid JSON at ${where()}: ${what}`); };
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const string = () => {
    const start = i;
    i++; // opening quote
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i++;
      if (text[i] === "\n") fail("a text value is not closed before the end of the line (a missing \")");
      i++;
    }
    if (i >= text.length) fail("a text value is never closed (a missing \")");
    i++;
    try {
      return JSON.parse(text.slice(start, i));
    } catch {
      i = start;
      return fail("a text value holds an invalid escape (a lone backslash?)");
    }
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const entries = [];
      let afterComma = null; // where the last comma was, while nothing has followed it yet
      for (;;) {
        ws();
        if (text[i] === "}") { if (afterComma) notes.push(`an extra comma at ${afterComma}`); i++; break; }
        afterComma = null;
        if (text[i] === ",") { notes.push(`an extra comma at ${where()}`); i++; continue; }
        if (text[i] === "“" || text[i] === "”") fail("a curly “smart” quote where a plain \" is needed");
        if (text[i] !== '"') fail(i >= text.length ? "the text ends before a { is closed (a missing })" : "a key name in double quotes was expected here");
        const key = string();
        ws();
        if (text[i] !== ":") fail("a colon was expected after a key name");
        i++;
        entries.push([key, value()]);
        ws();
        if (text[i] === ",") { afterComma = where(); i++; continue; }
        if (text[i] === "}") { i++; break; }
        if (text[i] === '"') { notes.push(`a missing comma at ${where()}`); continue; }
        fail(i >= text.length ? "the text ends before a { is closed (a missing })" : "a comma or a } was expected here");
      }
      return { t: "object", entries };
    }
    if (c === "[") {
      i++;
      const items = [];
      let afterComma = null;
      for (;;) {
        ws();
        if (text[i] === "]") { if (afterComma) notes.push(`an extra comma at ${afterComma}`); i++; break; }
        afterComma = null;
        if (text[i] === ",") { notes.push(`an extra comma at ${where()}`); i++; continue; }
        if (i >= text.length) fail("the text ends before a [ is closed (a missing ])");
        items.push(value());
        ws();
        if (text[i] === ",") { afterComma = where(); i++; continue; }
        if (text[i] === "]") { i++; break; }
        fail("a comma or a ] was expected here");
      }
      return { t: "array", items };
    }
    if (c === '"') return { t: "leaf", v: string() };
    if (c === "“" || c === "”") fail("a curly “smart” quote where a plain \" is needed");
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 40));
    if (!m) fail(i >= text.length ? "the text ends where a value was expected" : "a value was expected here (text values need double quotes)");
    i += m[0].length;
    return { t: "leaf", v: JSON.parse(m[0]) };
  };
  const root = value();
  ws();
  if (i < text.length) fail("there is more text after the end of the JSON");
  return { root, notes };
}

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Turn the loose tree into a plain value, repairing what can be repaired without guessing.
 * `problems`: what is wrong (each one explains a symptom). `blocked`: what could NOT be
 * repaired automatically. Neither ever holds a value.
 */
export function repair(node, path, problems, blocked) {
  const at = (key) => (path ? `${path}.${key}` : key);
  if (node.t === "leaf") {
    const v = node.v;
    if (typeof v === "string" && /^\s*\{/.test(v)) {
      // A block that was saved as text (the console's Key/value editor does this).
      let inner = null;
      try {
        inner = readLoose(v);
      } catch {
        inner = null;
      }
      if (inner && inner.root.t === "object") {
        problems.push(`"${path}" is a block saved as TEXT, not as a block — the code cannot see inside it (the console's "Key/value" editor saves nested blocks this way)`);
        return repair(inner.root, path, problems, blocked);
      }
    }
    return v;
  }
  if (node.t === "array") return node.items.map((n, idx) => repair(n, `${path}[${idx}]`, problems, blocked));
  const out = {};
  const seen = new Map(); // key -> value so far
  for (const [key, child] of node.entries) {
    const v = repair(child, at(key), problems, blocked);
    if (!seen.has(key)) {
      seen.set(key, v);
      out[key] = v;
      continue;
    }
    const prev = seen.get(key);
    problems.push(`"${at(key)}" appears TWICE at the same level — JSON keeps only the last one, so the first block is ignored`);
    if (same(prev, v)) continue;
    if (isPlain(prev) && isPlain(v)) {
      const clash = Object.keys(v).filter((k) => k in prev && !same(prev[k], v[k]));
      if (clash.length) blocked.push(`the two "${at(key)}" blocks both hold ${clash.map((k) => `"${k}"`).join(", ")} with different contents — decide which one is right and remove the other by hand`);
      const merged = { ...prev, ...v };
      seen.set(key, merged);
      out[key] = merged;
    } else {
      blocked.push(`the two "${at(key)}" entries are different and are not both blocks — remove the wrong one by hand`);
    }
  }
  return out;
}

/** Key names and types, never a value. A Stripe key's mode is read off its public prefix. */
export function shapeLines(v, indent = "    ", key = null, depth = 0) {
  const lines = [];
  const label = key === null ? "" : `"${key}": `;
  if (isPlain(v)) {
    lines.push(`${indent}${label}{`);
    if (depth >= 4) lines.push(`${indent}  …`);
    else for (const [k, child] of Object.entries(v)) lines.push(...shapeLines(child, `${indent}  `, k, depth + 1));
    lines.push(`${indent}}`);
  } else if (Array.isArray(v)) {
    lines.push(`${indent}${label}[ ${v.length} item(s) ]`);
  } else if (typeof v === "string") {
    let note = v.trim() === "" ? "EMPTY text" : "text";
    if (key === "secretKey") {
      const m = /^(sk|rk|pk)_(live|test)_/.exec(v.trim());
      note = m ? `text — a ${m[2].toUpperCase()}-mode ${m[1] === "rk" ? "restricted " : m[1] === "pk" ? "PUBLISHABLE (wrong kind of) " : ""}key` : "text — does NOT look like a Stripe secret key";
    }
    if (v !== v.trim()) note += " (has a space or line break at the start or end)";
    lines.push(`${indent}${label}<${note}>`);
  } else {
    lines.push(`${indent}${label}<${v === null ? "null" : typeof v}>`);
  }
  return lines;
}

/**
 * Everything there is to say about one secret's text.
 * @returns {{ ok: boolean, lines: string[], fixable: boolean, repaired: object|null, changed: boolean }}
 */
export function examine(name, text, env = process.env) {
  const lines = [];
  let strict = null;
  let strictOk = true;
  try {
    strict = JSON.parse(text);
  } catch {
    strictOk = false;
  }
  let loose;
  try {
    loose = readLoose(text);
  } catch (e) {
    lines.push(`  PROBLEM: ${e instanceof ShapeError ? e.message : "the text could not be read"}`);
    lines.push("  Every Lambda that reads this secret fails on it, for EVERY tenant. Fix that spot in the console's Plaintext tab.");
    return { ok: false, lines, fixable: false, repaired: null, changed: false };
  }
  const problems = [];
  const blocked = [];
  if (!strictOk) problems.push(`the text is NOT valid JSON (${loose.notes.join("; ") || "a punctuation slip"}) — every Lambda that reads it fails, for every tenant`);
  const repaired = repair(loose.root, "", problems, blocked);
  if (!isPlain(repaired)) {
    lines.push("  PROBLEM: the secret is not a JSON object ({ … }).");
    return { ok: false, lines, fixable: false, repaired: null, changed: false };
  }
  const changed = !strictOk || !same(strict, repaired);

  lines.push(strictOk ? "  As the Lambdas read it today:" : "  As it would read once the punctuation is repaired:");
  lines.push(...shapeLines(strictOk ? strict : repaired));

  // What the code concludes from it.
  const verdicts = [];
  const judge = (secret) => {
    const out = [];
    if (name === "sundial/stripe") {
      const primary = primaryTenantSlug(env);
      const slugs = [...new Set([primary, ...(isPlain(secret?.tenants) ? Object.keys(secret.tenants) : [])])];
      for (const slug of slugs) {
        const cfg = stripeConfigFor(secret, slug, env);
        out.push({ slug, ok: !!cfg, text: cfg ? `payments ON (${cfg.mode.toUpperCase()} mode${cfg.webhookSecret ? "" : ", NO webhook secret — payments would not be recorded"})` : "NOT SET UP — the portal says \"Stripe isn't set up\"", primary: slug === primary });
      }
    }
    return out;
  };
  const today = strictOk ? judge(strict) : [];
  const after = judge(repaired);
  if (name === "sundial/stripe") {
    lines.push("  What lib/stripe.js concludes:");
    if (!strictOk) lines.push("    today: nothing can be read — every tenant is NOT SET UP");
    for (const v of today) lines.push(`    ${v.slug.padEnd(14)} ${v.text}`);
    verdicts.push(...today);
  }
  for (const [k, v] of Object.entries(strictOk ? strict : repaired)) {
    if (name === "sundial/brand" && !isPlain(v)) problems.push(`"${k}" should be a block of settings for the tenant "${k}", and is not`);
    if (name === "sundial/twilio" && k === "tenantNumbers" && !isPlain(v)) problems.push(`"tenantNumbers" should be a block of slug → number, and is not`);
  }

  const primaryBroken = name === "sundial/stripe" && (!strictOk || today.some((v) => v.primary && !v.ok));
  if (!problems.length && !primaryBroken) {
    lines.push("  OK — nothing wrong with the shape.");
    return { ok: true, lines, fixable: false, repaired, changed: false };
  }
  for (const p of problems) lines.push(`  PROBLEM: ${p}`);
  for (const b of blocked) lines.push(`  CANNOT REPAIR AUTOMATICALLY: ${b}`);

  let fixable = changed && blocked.length === 0;
  if (name === "sundial/stripe") {
    const primaryAfter = after.find((v) => v.primary);
    if (changed) {
      lines.push("  After the repair it would read:");
      lines.push(...shapeLines(repaired));
      for (const v of after) lines.push(`    ${v.slug.padEnd(14)} ${v.text}`);
    }
    if (!primaryAfter?.ok) {
      fixable = false;
      lines.push(`  PROBLEM: the primary tenant "${primaryTenantSlug(env)}" has no usable entry${changed ? " even after the repair" : ""}. It needs  "tenants": { "${primaryTenantSlug(env)}": { "secretKey": …, "webhookSecret": … } }  — its block was removed, renamed or put somewhere else. Restore the previous version (see the commands printed below).`);
    }
  }
  return { ok: false, lines, fixable, repaired, changed };
}

// ---------------------------------------------------------------------------------------
// the command line
// ---------------------------------------------------------------------------------------
export async function main(argv, deps = null) {
  const fix = argv.includes("--fix");
  const restore = argv.includes("--restore-previous");
  const names = argv.filter((a) => !a.startsWith("--"));
  const unknown = argv.filter((a) => a.startsWith("--") && a !== "--fix" && a !== "--restore-previous");
  if (unknown.length) { console.error(`unknown option ${unknown.join(", ")}`); return 2; }
  if (fix && restore) { console.error("use --fix or --restore-previous, not both"); return 2; }
  if ((fix || restore) && names.length !== 1) { console.error(`${fix ? "--fix" : "--restore-previous"} needs exactly one secret name, e.g.  ${fix ? "--fix" : "--restore-previous"} sundial/stripe`); return 2; }
  // `deps` is for the tests only: a stand-in for Secrets Manager.
  const { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } = deps ?? (await import("@aws-sdk/client-secrets-manager"));
  const client = new SecretsManagerClient({ region: REGION });
  let bad = 0;
  const restartLines = (name) => (READERS[name] || []).map((fn) => `    aws lambda update-function-configuration --function-name ${fn} --region ${REGION} --description "secret refresh ${new Date().toISOString().slice(0, 16)}Z" --query LastUpdateStatus`);
  /** The version Secrets Manager kept from before the last save, examined. null when there is none. */
  const previous = async (name) => {
    try {
      const text = (await client.send(new GetSecretValueCommand({ SecretId: name, VersionStage: "AWSPREVIOUS" }))).SecretString;
      return typeof text === "string" ? { text, r: examine(name, text) } : null;
    } catch {
      return null;
    }
  };
  console.log(fix ? "SECRET SHAPE REPAIR — values are carried over untouched and never shown" : restore ? "SECRET RESTORE — puts back the version from before the last save; no value is shown" : "SECRET SHAPE CHECK — read-only; key names and types only, never a value");

  if (restore) {
    const name = names[0];
    console.log("");
    console.log(name);
    const prev = await previous(name);
    if (!prev) { console.log("  Secrets Manager holds no previous version of this secret (or it could not be read). Nothing was changed."); return 1; }
    console.log("  The version from BEFORE the last save:");
    for (const line of prev.r.lines) console.log(`  ${line}`);
    if (!prev.r.ok) { console.log("  NOT RESTORED: the previous version has a problem of its own (it was probably saved twice). Nothing was changed."); return 1; }
    await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: prev.text }));
    console.log("  RESTORED: the secret is back to that version, exactly. (What it replaced is now the kept previous version.)");
    console.log("  Anything added in the last save — the new tenant's block — is no longer in it; add it again afterwards.");
    console.log("  Lambdas that are already running keep the old copy in memory. Restart them now:");
    for (const line of restartLines(name)) console.log(line);
    return 0;
  }
  for (const name of names.length ? names : SECRETS) {
    console.log("");
    console.log(name);
    let text;
    try {
      text = (await client.send(new GetSecretValueCommand({ SecretId: name }))).SecretString;
    } catch (e) {
      console.log(`  could not be read: ${e?.name || "error"}`);
      if (!/ResourceNotFound/i.test(e?.name || "")) bad++;
      continue;
    }
    if (typeof text !== "string") { console.log("  has no text value"); bad++; continue; }
    const r = examine(name, text);
    for (const line of r.lines) console.log(line);
    if (r.ok) continue;
    bad++;
    if (!fix) {
      if (r.fixable) {
        console.log(`  → This can be repaired automatically, keeping everything that is in it:`);
        console.log(`      node scripts/check-secret-shapes.mjs --fix ${name}`);
        continue;
      }
      const prev = await previous(name);
      if (prev?.r.ok) {
        console.log("  → The version from BEFORE the last save is fine (shape below). To put it back:");
        console.log(`      node scripts/check-secret-shapes.mjs --restore-previous ${name}`);
        for (const line of prev.r.lines) console.log(`    ${line}`);
      } else {
        console.log(`  → This needs a fix by hand in the console's Plaintext tab${prev ? " (the version before the last save has a problem too)" : " (no earlier version could be read)"}.`);
      }
      continue;
    }
    if (!r.fixable) { console.log("  NOT SAVED: this cannot be repaired automatically (see above)."); continue; }
    await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: JSON.stringify(r.repaired, null, 2) }));
    bad--;
    console.log("  SAVED. The version it replaced is kept by Secrets Manager (stage AWSPREVIOUS).");
    console.log("  Lambdas that are already running keep the old copy in memory. Restart them now:");
    for (const line of restartLines(name)) console.log(line);
  }
  return bad ? 1 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      // Never a response body: an AWS error can echo what was sent.
      console.error(`FAILED: ${err?.name || "error"}`);
      process.exitCode = 1;
    });
}
