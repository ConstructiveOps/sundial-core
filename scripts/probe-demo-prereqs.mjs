// Demo tenant groundwork — ask the LIVE org what the repo cannot tell us.
//
// WHY: the demo tenant (Constructive Ops Demo) needs ~700 seeded records whose stage,
// status and picklist fields hold values the org actually accepts. Several of those
// value lists exist only in Salesforce — Sundial_Customer__c.Stage__c and
// Sundial_Solar__c.Stage__c are in neither repo — and a seed that guesses them either
// fails on a restricted picklist or lands records in the board's "Other" column. The
// same goes for which fields are createable (formulas and roll-ups reject writes),
// which are required, and whether the roofing-revamp package is deployed.
//
// So: describe every Sundial object, decode the dependent picklists, count what each
// tenant holds today, and record the SHAPE (key names only) of the secrets and Supabase
// tables the demo setup touches. The seed script is then written against this file
// instead of against assumptions.
//
// STRICTLY READ-ONLY. Describes, COUNT() queries, one-row SELECTs, GetSecretValue.
// Writes nothing to Salesforce, Supabase or AWS.
//
// VALUE-SAFETY: no secret VALUE is ever written or printed — only key names, tenant
// slugs and booleans. No customer record data is written — Supabase tables are reported
// as column names + JS types only; Salesforce as metadata + counts only.
//
// Output: migration/demo/probe.json (git-ignored, like every other migration pull).
//
// Usage (from the sundial-core repo root):
//   node scripts/probe-demo-prereqs.mjs

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeObject, sfQuery } from "../lib/salesforce.js";
import { getSupabaseClient } from "../lib/supabase.js";
import { getSecret } from "../lib/secrets.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = resolve(REPO_ROOT, "migration", "demo", "probe.json");

// Every Sundial object the portal reads or the seed might write. An object that does
// not exist in the org is reported as ABSENT rather than skipped — "it isn't there" is
// itself an answer (e.g. whether Sundial_Tech_Day__c has been deployed).
const SF_OBJECTS = [
  "Sundial_Tenant__c",
  "Sundial_User__c",
  "Sundial_Dealer__c",
  "Sundial_Customer__c",
  "Sundial_Solar__c",
  "Sundial_Roofing__c",
  "Sundial_Commercial__c",
  "Sundial_Estimate__c",
  "Sundial_Service_Job__c",
  "Sundial_Service_Call__c",
  "Sundial_Service_Line__c",
  "Sundial_Price_Book_Item__c",
  "Sundial_Service_Invoice__c",
  "Sundial_Service_Payment__c",
  "Sundial_Service_Plan__c",
  "Sundial_Membership__c",
  "Sundial_Tech_Day__c",
  "Sundial_PO__c",
];

// Supabase tables the demo seed may read or write. Reported as column names only.
const SUPABASE_TABLES = [
  "profiles",
  "user_preferences",
  "comments",
  "comment_mentions",
  "sundial_file_metadata",
  "sundial_service_activity",
  "sundial_sms_messages",
  "sundial_notifications",
  "sundial_stripe_events",
  "sundial_sync_state",
  "sundial_customer_cache",
  "sundial_solar_cache",
  "sundial_roofing_cache",
  "sundial_user_cache",
  "sundial_estimate_cache",
  "sundial_service_job_cache",
  "sundial_service_call_cache",
  "sundial_service_line_cache",
  "sundial_service_invoice_cache",
  "sundial_service_payment_cache",
  "sundial_price_book_item_cache",
  "sundial_service_plan_cache",
  "sundial_membership_cache",
];

// Secrets whose SHAPE matters to the demo setup. Key names only, never values.
const SECRETS = ["sundial/twilio", "sundial/brand", "sundial/stripe", "sundial/service-club"];

// --- dependent picklists -------------------------------------------------------
// validFor is a base64 bitmap, bits packed MSB-first: controlling index i lives in
// byte (i >> 3) at mask (0x80 >> (i & 7)). Same decoding as sundial-sf-query.
function decodeValidForIndices(validFor) {
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

function summarizeField(f, byName) {
  const out = {
    label: f.label,
    type: f.type,
    createable: f.createable === true,
    updateable: f.updateable === true,
    // Required on create = not nillable AND nothing fills it for us.
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
        controller?.type === "boolean"
          ? ["false", "true"]
          : (controller?.picklistValues || []).map((p) => p.value);
      const map = {};
      for (const c of controlling) map[c] = [];
      for (const p of active) {
        for (const i of decodeValidForIndices(p.validFor)) {
          const c = controlling[i];
          if (c !== undefined) map[c].push(p.value);
        }
      }
      out.dependentValues = map;
    }
  }
  return out;
}

async function probeObject(sfObject) {
  let meta;
  try {
    meta = await describeObject(sfObject);
  } catch (e) {
    if (e?.sfStatus === 404) return { absent: true };
    return { error: `describe failed (${e?.sfStatus ?? "?"})` };
  }
  const byName = new Map(meta.fields.map((f) => [f.name, f]));
  const fields = {};
  for (const f of meta.fields) fields[f.name] = summarizeField(f, byName);
  const nameField = meta.fields.find((f) => f.nameField);
  return {
    label: meta.label,
    createable: meta.createable === true,
    updateable: meta.updateable === true,
    deletable: meta.deletable === true,
    nameField: nameField
      ? { name: nameField.name, autoNumber: nameField.autoNumber === true, type: nameField.type }
      : null,
    hasClientLookup: byName.has("Client__c"),
    recordTypes: (meta.recordTypeInfos || [])
      .filter((r) => r.available && !r.master)
      .map((r) => r.name),
    fieldCount: meta.fields.length,
    fields,
  };
}

// COUNT(Id) comes back as a real aggregate row (expr0); plain COUNT() returns an empty
// records array that reads as zero — see scripts/describe-access-fields.mjs.
async function countBy(sfObject, groupField) {
  try {
    const rows = await sfQuery(
      `SELECT ${groupField}, COUNT(Id) FROM ${sfObject} GROUP BY ${groupField}`
    );
    const out = {};
    for (const r of rows) out[r[groupField] ?? "(none)"] = r.expr0;
    return out;
  } catch (e) {
    return { error: `count failed (${e?.sfStatus ?? e?.message ?? "?"})` };
  }
}

async function probeSupabaseTable(client, table) {
  try {
    const { data, error } = await client.from(table).select("*").limit(1);
    if (error) return { error: error.code || error.message };
    if (!data || data.length === 0) return { empty: true, columns: null };
    const columns = {};
    for (const [k, v] of Object.entries(data[0])) {
      columns[k] = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    }
    return { empty: false, columns };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// Key names, nested one level for the per-tenant maps. Never a value — except tenant
// slugs, which are labels, and `defaultTenant`, which is a slug too.
function shapeOf(secret) {
  const out = { keys: Object.keys(secret).sort() };
  const SLUG_MAPS = ["tenantNumbers", "tenants"];
  for (const k of SLUG_MAPS) {
    if (secret[k] && typeof secret[k] === "object") {
      out[k] = {};
      for (const [slug, v] of Object.entries(secret[k])) {
        out[k][slug] = v && typeof v === "object" ? Object.keys(v).sort() : typeof v;
      }
    }
  }
  if (typeof secret.defaultTenant === "string") out.defaultTenant = secret.defaultTenant;
  if (typeof secret.default_tenant === "string") out.defaultTenant = secret.default_tenant;
  // sundial/brand is keyed by slug at the top level: report each block's key names.
  const blocks = {};
  for (const [k, v] of Object.entries(secret)) {
    if (SLUG_MAPS.includes(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) blocks[k] = Object.keys(v).sort();
  }
  if (Object.keys(blocks).length) out.blocks = blocks;
  return out;
}

async function probeSecret(name) {
  try {
    return shapeOf(await getSecret(name));
  } catch (e) {
    if (/ResourceNotFound/i.test(e?.name || e?.message || "")) return { absent: true };
    return { error: e?.name || "read failed" };
  }
}

async function main() {
  const result = { generatedAt: new Date().toISOString(), salesforce: {}, supabase: {}, secrets: {} };

  console.log("Salesforce: describing objects…");
  for (const o of SF_OBJECTS) {
    result.salesforce[o] = await probeObject(o);
    const r = result.salesforce[o];
    console.log(
      `  ${o}: ${r.absent ? "ABSENT" : r.error ? r.error : `${r.fieldCount} fields`}`
    );
  }

  console.log("Salesforce: tenants and per-tenant counts…");
  try {
    const tenants = await sfQuery("SELECT Id, Name FROM Sundial_Tenant__c ORDER BY Name");
    result.tenants = tenants.map((t) => ({ id: t.Id, slug: t.Name }));
  } catch (e) {
    result.tenants = { error: `query failed (${e?.sfStatus ?? "?"})` };
  }
  result.countsByTenant = {};
  for (const o of SF_OBJECTS) {
    const r = result.salesforce[o];
    if (r.absent || r.error || !r.hasClientLookup) continue;
    result.countsByTenant[o] = await countBy(o, "Client__c");
  }

  console.log("Supabase: table shapes (column names only)…");
  try {
    const client = await getSupabaseClient();
    for (const t of SUPABASE_TABLES) {
      result.supabase[t] = await probeSupabaseTable(client, t);
    }
  } catch (e) {
    result.supabase = { error: e?.message || String(e) };
  }

  console.log("Secrets: shapes (key names only)…");
  for (const s of SECRETS) result.secrets[s] = await probeSecret(s);

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(result, null, 2) + "\n", "utf8");

  const absent = SF_OBJECTS.filter((o) => result.salesforce[o].absent);
  console.log("");
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`Tenants: ${Array.isArray(result.tenants) ? result.tenants.map((t) => t.slug).join(", ") : "unreadable"}`);
  if (absent.length) console.log(`Absent objects: ${absent.join(", ")}`);
  console.log("Nothing was written to Salesforce, Supabase or AWS.");
}

main().catch((e) => {
  // Never print a response body here — a Salesforce error body can carry record data.
  console.error("probe failed:", e?.message || e);
  process.exit(1);
});
