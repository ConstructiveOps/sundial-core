// sundial-sf-update — tenant-isolated WRITE Lambda (create + update).
//
// Handles:
//   PATCH /sf/{object}/{id}  -> update an existing record
//   POST  /sf/{object}       -> create a new record
//   DELETE /sf/{object}/{id}  -> NOT IMPLEMENTED in this build (returns 501)
//
// CORE ISOLATION GUARANTEE (D-025 / D-035): the tenant is derived ONLY from the
// verified token (resolveIdentity -> tenantId = the Salesforce Client record id
// held in Client__c). NO request input (path, query, body, header) can set or
// override the tenant. Concretely:
//   - UPDATE first proves the target record belongs to the caller's tenant with
//     a SELECT ... WHERE Id = '<id>' AND Client__c = '<tenantId>' pre-check; a
//     cross-tenant or missing id is indistinguishable -> 404 (never reveal it).
//   - CREATE force-stamps Client__c = '<tenantId>' server-side; Client__c can
//     never arrive from the body (it is blocklisted and rejected).
//
// FIELD-WRITE SAFETY is layered and fail-closed:
//   1. Salesforce describe is the authority — a field is writable only if its
//      describe entry is updateable (PATCH) / createable (POST). Non-writable
//      fields are REJECTED (400), never silently dropped.
//   2. An explicit blocklist rejects fields that are technically writable but
//      must never be set via this API (Client__c, OwnerId, RecordTypeId, Id).
//   3. The body must be JSON { fields: { "Api_Name__c": value, ... } }.
//
// Value-safety: never logs or returns tokens, secrets, key material, or the raw
// request body. Salesforce validation messages ARE surfaced to the caller (they
// are useful and business-level, not sensitive).
//
// See DECISIONS.md D-036 (verb-split routing) and docs/api-endpoints.md.

import {
  getSalesforceToken,
  sfQuery,
  soqlEscapeString,
} from "../../lib/salesforce.js";
import { resolveIdentity } from "../../lib/identity.js";
import { getSupabaseClient } from "../../lib/supabase.js";

// --- Object allowlist (the security spine) ---------------------------------
// The {object} path param is one of these short keys. Anything else => 400.
// A caller can never reach a Salesforce object / cache table outside this map.
// Mirrors sundial-sf-query so reads and writes share one allowlist definition.
const OBJECT_ALLOWLIST = {
  solar: { sfObject: "Sundial_Solar__c", cacheTable: "sundial_solar_cache" },
  customer: {
    sfObject: "Sundial_Customer__c",
    cacheTable: "sundial_customer_cache",
  },
  roofing: { sfObject: "Sundial_Roofing__c", cacheTable: "sundial_roofing_cache" },
  po: { sfObject: "Sundial_PO__c", cacheTable: "sundial_po_cache" },
  user: { sfObject: "Sundial_User__c", cacheTable: "sundial_user_cache" },
};

const SF_API_VERSION = "v60.0";

// --- ACCESS MODEL (D-064 §3.4) ---------------------------------------------
// The WRITE path's four gates, in order, each failing closed:
//   1. canReadObject   -> 403 MODULE_FORBIDDEN   (a module closed to this scope)
//   2. assertVisible   -> 404 RECORD_NOT_FOUND   (a record outside the row filter)
//   3. field authority -> 403 FIELD_FORBIDDEN    (a field the manifest does not grant)
//   4. protected list  -> 403 FIELD_FORBIDDEN    (ownership fields, whatever the sheet says)
//
// ⚠️ ONE FORBIDDEN FIELD REJECTS THE WHOLE PATCH (§3.4 step 3). Not "drop it and write
// the rest" — a body carrying a field the caller cannot edit is either a stale client or
// a probe, and silently writing the remainder would make the two indistinguishable and
// leave the caller believing the whole thing landed.
//
// ⚠️ Gate 3 runs only for a SALES role. Tenant scope keeps today's behaviour exactly:
// describe-updateable plus the existing blocklist, and nothing else. Phase 4 must not
// narrow what Harmon staff can write.
import { resolveMode, MODES } from "../sundial-sf-query/shadow.js";
import {
  canReadObject,
  rowFilter,
  OBJECT_ACCESS,
  DENY,
  escapeSoqlValue,
} from "../../lib/access.js";
import { fieldsFor } from "../../lib/field-manifest/index.js";

/**
 * Fields a SALES role may never write, whatever the manifest says (§3.4 step 4).
 *
 * The generator already refuses to mark these `edit`, so this is the second of two
 * independent checks on the same rule. That duplication is deliberate: the generator
 * protects the sheet, this protects the request, and neither depends on the other having
 * run. A hand-edited manifest, a stale deploy, or a future generator bug all stop here.
 *
 * Lowercased, because the body's casing is the caller's choice.
 */
const SALES_PROTECTED_FIELDS = new Set([
  "sales_rep__c",
  "dealer__c",
  "client__c",
  "stage__c",
  "status__c",
]);

/** Objects a sales role may CREATE (§3.4 step 5). Customer, and nothing else. */
const SALES_CREATABLE = new Set(["customer"]);

// --- Field-write blocklist -------------------------------------------------
// Lowercased for case-insensitive matching. These are NEVER accepted from the
// request, even if the describe marks them updateable/createable:
//   - client__c    : the tenant anchor. Force-set server-side on create; never
//                    client-settable, or tenant isolation would be bypassable.
//   - ownerid      : record ownership is an admin/sharing concern, not a portal write.
//   - recordtypeid : record type drives layout/automation; not a portal write.
//   - id           : the record identity is addressed by the path, never the body.
const WRITE_BLOCKLIST = new Set(["id", "client__c", "ownerid", "recordtypeid"]);

// --- CORS (mirrors the other Lambdas; adds POST/PATCH) ---------------------
const STATIC_ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "https://sundial.harmonelectric.net",
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (STATIC_ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const u = new URL(origin);
    if (
      u.protocol === "https:" &&
      (u.hostname === "vercel.app" || u.hostname.endsWith(".vercel.app"))
    ) {
      return true;
    }
  } catch {
    /* not parseable -> disallowed */
  }
  return false;
}

function corsHeaders(origin) {
  const allowOrigin = isAllowedOrigin(origin) ? origin : "http://localhost:5173";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    Vary: "Origin",
  };
}

function normalizeHeaders(rawHeaders) {
  const out = {};
  if (rawHeaders && typeof rawHeaders === "object") {
    for (const [k, v] of Object.entries(rawHeaders)) out[k.toLowerCase()] = v;
  }
  return out;
}

function jsonResponse(statusCode, cors, bodyObj) {
  return {
    statusCode,
    headers: { ...cors, "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  };
}

// Same identity-error -> HTTP mapping the read paths use.
function mapIdentityError(code) {
  switch (code) {
    case "AUTH_NO_TOKEN":
    case "AUTH_INVALID_TOKEN":
      return { status: 401, body: { error: "unauthorized", code } };
    case "NO_SUNDIAL_USER":
      return {
        status: 403,
        body: { error: "no_portal_user", code: "NO_SUNDIAL_USER" },
      };
    case "USER_INACTIVE":
      return {
        status: 403,
        body: { error: "inactive_user", code: "USER_INACTIVE" },
      };
    default:
      return null;
  }
}

// --- Routing ---------------------------------------------------------------
// Method comes from requestContext.http.method (HTTP API) or httpMethod (REST).
// Object/id come from pathParameters, with a path-parse fallback.
function extractRoute(event) {
  const pp = event?.pathParameters || {};
  if (pp.object) {
    return { objectKey: pp.object, id: pp.id || null };
  }
  const path = event?.rawPath || event?.path || "";
  const m = path.match(/\/sf\/([^/?]+)(?:\/([^/?]+))?\/?$/);
  if (m) {
    return {
      objectKey: decodeURIComponent(m[1]),
      id: m[2] ? decodeURIComponent(m[2]) : null,
    };
  }
  return { objectKey: null, id: null };
}

// --- Salesforce describe (module-scope cached per object, WITH TTL) --------
// Holds the FULL describe JSON so each field's updateable/createable flags are
// available. Cached across warm invocations but only for DESCRIBE_TTL_MS.
//
// WHY A TTL (D-045): the describe carries each field's per-integration-user FLS
// (updateable/createable). When an admin grants FLS or adds a field, a warm Lambda
// container that cached the OLD describe keeps seeing the field as non-writable —
// and validateWritableFields rejects the ENTIRE PATCH if ANY one field is
// non-writable. That produced intermittent, un-reproducible "save blocked" errors
// (the Utility_Password__c report) that only self-healed when the container
// recycled. A short TTL bounds that staleness to minutes without a redeploy. A 401
// still forces an immediate refresh (auth change), as before.
const DESCRIBE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const describeCache = new Map(); // sfObject -> { meta, at }

async function getRawDescribe(sfObject) {
  const cached = describeCache.get(sfObject);
  if (cached && Date.now() - cached.at < DESCRIBE_TTL_MS) return cached.meta;

  async function run(forceRefresh) {
    const { access_token, instance_url } = await getSalesforceToken({
      forceRefresh,
    });
    const url = `${instance_url}/services/data/${SF_API_VERSION}/sobjects/${sfObject}/describe`;
    return fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
  }

  let resp = await run(false);
  if (resp.status === 401) resp = await run(true);
  if (!resp.ok) {
    throw new Error(`describe ${sfObject} failed (${resp.status})`);
  }

  const meta = await resp.json();
  describeCache.set(sfObject, { meta, at: Date.now() });
  return meta;
}

// --- Request body parsing --------------------------------------------------
// Expects JSON { fields: { "Api_Name__c": value, ... } } with >= 1 field.
// Returns { ok:false } for anything missing/malformed/empty (the handler turns
// that into the INVALID_BODY response).
//
// NOTE: API Gateway may deliver the request body BASE64-ENCODED
// (event.isBase64Encoded === true) — e.g. when the API's binaryMediaTypes cover
// the request content type. We MUST decode to UTF-8 BEFORE JSON.parse, or a
// perfectly valid `{ "fields": {...} }` body is never recognized. This single
// parser is used by BOTH the POST (create) and PATCH (update) paths.
function parseBody(event) {
  let raw = event?.body;

  // Defensive: if the body already arrived as a parsed object (some invokers or
  // tests pass an object rather than a JSON string), use it directly — never
  // double-parse (JSON.parse on an object would coerce to "[object Object]").
  if (raw != null && typeof raw === "object") {
    return extractFields(raw);
  }

  if (raw == null) return { ok: false };

  // API Gateway may base64-encode the body; decode first when flagged.
  if (event?.isBase64Encoded) {
    try {
      raw = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      return { ok: false };
    }
  }

  // Trim whitespace; an empty body after decoding is missing/malformed.
  raw = String(raw).trim();
  if (raw === "") return { ok: false };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  return extractFields(parsed);
}

// Validate the parsed body shape and pull out the { fields } map. Shared by the
// string and already-an-object paths above so the shape check lives in one place.
function extractFields(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false };
  }
  const fields = parsed.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return { ok: false };
  }
  if (Object.keys(fields).length === 0) return { ok: false };
  return { ok: true, fields };
}

// --- Field-write validation ------------------------------------------------
// mode "update" requires describe.updateable; mode "create" requires
// describe.createable. Blocklisted or unknown or non-writable fields are all
// collected into `rejected`. On success `clean` carries the CANONICAL SF field
// API names (from the describe) mapped to the caller's values, so casing is
// normalized before the write. Fail-closed: anything not provably writable is
// rejected.
function validateWritableFields(describe, fields, mode) {
  const describeFields = describe.fields || [];
  const byLower = new Map(
    describeFields.map((f) => [f.name.toLowerCase(), f])
  );

  const rejected = [];
  const clean = {};

  for (const [key, value] of Object.entries(fields)) {
    const lower = key.toLowerCase();

    // Layer 2: explicit blocklist (Client__c, OwnerId, RecordTypeId, Id).
    if (WRITE_BLOCKLIST.has(lower)) {
      rejected.push(key);
      continue;
    }

    // Layer 1: Salesforce describe is the authority.
    const def = byLower.get(lower);
    if (!def) {
      rejected.push(key); // unknown field -> not writable
      continue;
    }
    const writable =
      mode === "create" ? def.createable === true : def.updateable === true;
    if (!writable) {
      rejected.push(key);
      continue;
    }

    clean[def.name] = value; // canonical API name
  }

  return { rejected, clean };
}

// --- The access gate (D-064 §3.4) ------------------------------------------
//
// Returns null when the write may proceed, or a response to return instead. `access`
// is null unless ACCESS_MODEL_MODE=enforce, and a null access short-circuits every gate
// — the same switch that keeps sf-query's off/shadow modes byte-identical.
function accessGate({ objectKey, access, mode, cors, isCreate }) {
  if (!access) return null; // not enforcing

  // 1. Module gate. On a WRITE this is 403 even for a single record, unlike a read's
  //    404: the caller supplied the object, not a record id, so refusing the module
  //    leaks nothing about which records exist.
  if (!canReadObject(objectKey, access)) {
    return jsonResponse(403, cors, { error: "forbidden", code: DENY.MODULE_FORBIDDEN });
  }

  // 5. Create is narrower than read: a sales role may create a customer and nothing
  //    else (§3.4 step 5). Projects, users and POs are created by staff or by server
  //    automation, both of which run as tenant scope.
  if (isCreate && access.scope !== "tenant" && !SALES_CREATABLE.has(objectKey)) {
    return jsonResponse(403, cors, { error: "forbidden", code: DENY.MODULE_FORBIDDEN });
  }
  return null;
}

/**
 * Field authorization for a SALES role (§3.4 steps 3 and 4).
 *
 * Returns null to proceed, or the list of forbidden field names. The caller turns that
 * into one 403 naming them and LOGS IT: a hidden field in a PATCH body from a sales role
 * is an attack signal, not a validation slip, and the log line is how anyone would ever
 * know it happened.
 */
function forbiddenFields(objectKey, access, fields) {
  if (!access || access.scope === "tenant") return null; // tenant keeps describe rules
  const manifest = fieldsFor(objectKey, access);
  const bad = [];
  for (const key of Object.keys(fields)) {
    const lower = key.toLowerCase();
    // Protected first, so the message names the real reason even if the sheet is wrong.
    if (SALES_PROTECTED_FIELDS.has(lower)) {
      bad.push(key);
      continue;
    }
    // The manifest is keyed by canonical API name; the body's casing is the caller's.
    const canonical = manifest
      ? [...manifest.edit].find((f) => f.toLowerCase() === lower)
      : null;
    if (!canonical) bad.push(key);
  }
  return bad.length > 0 ? bad : null;
}

/**
 * §2.3 invariant 2 — REASSIGNMENT RE-STAMPS THE DEALER.
 *
 * When a PATCH changes `Sales_Rep__c`, `Dealer__c` is re-derived from the NEW rep and
 * written in the SAME Salesforce update. Not a follow-up write: a second call could fail
 * on its own and leave the record in exactly the broken state this exists to prevent.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT OPTIONAL, AND WHY IT FAILS SILENTLY WITHOUT IT
 * ---------------------------------------------------------------------------
 * Stamping on CREATE alone leaves a reassigned deal pointing at the OLD rep's dealer.
 * Nothing about that looks wrong from any seat that would notice:
 *
 *   - the record itself looks fine;
 *   - the NEW rep can see it, because `own` scope matches on Sales_Rep__c, which moved;
 *   - the OLD rep correctly loses it, for the same reason;
 *   - and the only person who sees anything wrong is the LOSING dealer's manager, who
 *     still sees a deal their organization no longer sells — while the WINNING dealer's
 *     manager cannot see a deal their own rep now owns.
 *
 * That is a cross-dealer data leak and a support ticket, and neither party is positioned
 * to report it as one. A1 says the dealer is derived from the rep, always; this is the
 * half of A1 that lives on the write path.
 *
 * NULL IS A VALID ANSWER AND MUST BE WRITTEN. Clearing the rep, or assigning a rep who
 * has no dealer, sets `Dealer__c` to null. Leaving the old value would be the same leak
 * with extra steps — the deal would stay shared with an organization that has no rep on
 * it at all.
 *
 * @returns {{ ok: true, dealerId: string|null } | { ok: false, response: object }}
 */
async function dealerForNewRep({ repValue, tenantId, cors }) {
  const repId = typeof repValue === "string" ? repValue.trim() : repValue;

  // Clearing the rep clears the dealer. No lookup needed, and no reason to make one.
  if (repId === null || repId === undefined || repId === "") {
    return { ok: true, dealerId: null };
  }

  // The lookup is TENANT-SCOPED, which is a second thing it buys: a reassignment can
  // never point at a user outside the caller's tenant, whatever id was supplied.
  const rows = await sfQuery(
    `SELECT Id, Dealer__c FROM Sundial_User__c ` +
      `WHERE Id = '${soqlEscapeString(String(repId))}' ` +
      `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
  );

  if (!rows || rows.length === 0) {
    // A successful query returning nothing means the id is not a user in this tenant.
    // Refuse with a clear error rather than letting Salesforce reject it later with a
    // cross-reference message nobody can act on — and rather than stamping a null
    // dealer onto a write that is about to fail anyway.
    return {
      ok: false,
      response: jsonResponse(400, cors, {
        error: "invalid_sales_rep",
        code: "INVALID_SALES_REP",
        message:
          "Sales_Rep__c must be an active Sundial_User__c in this tenant. " +
          "Dealer__c is derived from it and cannot be set independently.",
      }),
    };
  }

  // A rep with no dealer yields a null dealer. Explicitly, not by omission.
  return { ok: true, dealerId: rows[0].Dealer__c ?? null };
}

// --- Salesforce write (REST) with one 401 refresh/retry --------------------
async function sfWrite(method, path, bodyObj) {
  async function run(forceRefresh) {
    const { access_token, instance_url } = await getSalesforceToken({
      forceRefresh,
    });
    return fetch(`${instance_url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyObj),
    });
  }
  let resp = await run(false);
  if (resp.status === 401) resp = await run(true);
  return resp;
}

// Turn a non-2xx Salesforce write response into a caller-facing result.
// Salesforce returns a JSON array of { message, errorCode, fields }. For any 4xx
// we surface those messages (they are useful and business-level) as a 400
// SF_VALIDATION_ERROR. For 5xx (or an unparseable body) we THROW so the handler
// returns a generic 500 and the real detail stays in CloudWatch.
async function sfErrorResponse(resp, cors) {
  const text = await resp.text();

  let sfErrors = null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      sfErrors = parsed.map((e) => ({
        message: e?.message ?? null,
        errorCode: e?.errorCode ?? null,
        fields: Array.isArray(e?.fields) ? e.fields : [],
      }));
    }
  } catch {
    /* not JSON — handled below */
  }

  if (resp.status >= 400 && resp.status < 500) {
    const messages = (sfErrors || [])
      .map((e) => e.message)
      .filter(Boolean);
    return jsonResponse(400, cors, {
      error: "salesforce_validation",
      code: "SF_VALIDATION_ERROR",
      messages:
        messages.length > 0
          ? messages
          : ["Salesforce rejected the write."],
      salesforceErrors: sfErrors || [],
    });
  }

  // 5xx / unexpected — log status only, surface generic 500 upstream.
  const err = new Error(`Salesforce write failed (${resp.status})`);
  err.sfStatus = resp.status;
  throw err;
}

// --- UPDATE (PATCH /sf/{object}/{id}) --------------------------------------
async function handleUpdate({ entry, id, tenantId, fields, describe, cors, objectKey, access, identity }) {
  if (!id) {
    return jsonResponse(400, cors, {
      error: "missing_id",
      code: "MISSING_ID",
      message: "PATCH requires a record id in the path.",
    });
  }

  // 1) Tenant-ownership pre-check FIRST. A record outside the caller's tenant is
  //    indistinguishable from one that does not exist -> 404 either way. This is
  //    the isolation gate: we never touch a record we can't prove the caller owns.
  //
  //    §3.4 step 2: the ROW FILTER is ANDed into this same existence check rather than
  //    added as a second query. One question, one answer, and no window between "may I
  //    see it" and "I am writing it".
  const rowClause = (() => {
    if (!access) return "";
    const f = rowFilter(objectKey, access);
    // A denial here cannot happen — the module gate ran first — but if it ever did,
    // an empty clause would mean "unfiltered", so refuse to build the query instead.
    if (f.deny) return null;
    return ` AND ${f.soql}`;
  })();
  if (rowClause === null) {
    return jsonResponse(404, cors, { error: "not_found", code: "RECORD_NOT_FOUND" });
  }
  const ownSoql =
    `SELECT Id FROM ${entry.sfObject} ` +
    `WHERE Id = '${soqlEscapeString(id)}' ` +
    `AND Client__c = '${soqlEscapeString(tenantId)}'` +
    rowClause +
    ` LIMIT 1`;
  const owned = await sfQuery(ownSoql);
  if (!owned || owned.length === 0) {
    return jsonResponse(404, cors, {
      error: "not_found",
      code: "RECORD_NOT_FOUND",
    });
  }
  // Use the canonical 18-char Id returned by Salesforce for the write URL, not
  // the raw path value — it is guaranteed a real, well-formed id in this tenant.
  const recordId = owned[0].Id;

  // 2) FIELD AUTHORIZATION for a sales role (§3.4 steps 3 + 4), BEFORE the describe
  //    check, so the answer to "may I write this field" is the access model's and not
  //    an accident of what Salesforce happens to consider updateable.
  const forbidden = forbiddenFields(objectKey, access, fields);
  if (forbidden) {
    // Logged with the caller: a hidden field in a PATCH body from a sales role is an
    // attack signal, not a validation slip (§3.4 step 3).
    console.warn(
      JSON.stringify({
        accessDenial: "FIELD_FORBIDDEN",
        user: identity?.user?.id ?? null,
        level: access?.level ?? null,
        scope: access?.scope ?? null,
        object: objectKey,
        recordId: id,
        fields: forbidden,
      })
    );
    return jsonResponse(403, cors, {
      error: "forbidden_field",
      code: DENY.FIELD_FORBIDDEN,
      fields: forbidden,
    });
  }

  // 3) Validate the requested fields against describe (updateable) + blocklist.
  const { rejected, clean } = validateWritableFields(describe, fields, "update");
  if (rejected.length > 0) {
    return jsonResponse(400, cors, {
      error: "unwritable_field",
      code: "FIELD_NOT_WRITABLE",
      fields: rejected,
    });
  }

  // 4) §2.3 INVARIANT 2. If this PATCH moves the rep, the dealer moves with it, in
  //    this same update. Tenant scope only by construction: a sales role cannot reach
  //    Sales_Rep__c at all (it is in SALES_PROTECTED_FIELDS and was refused above).
  //
  //    The derived value WINS over anything the body said about Dealer__c. A1 is that
  //    the dealer is derived from the rep and is never an independent input; honouring
  //    both would let one PATCH set a rep from one dealer and a dealer from another,
  //    which is the disagreement invariant 5 exists to make impossible.
  const repKey = Object.keys(clean).find((k) => k.toLowerCase() === "sales_rep__c");
  if (repKey) {
    const derived = await dealerForNewRep({
      repValue: clean[repKey],
      tenantId,
      cors,
    });
    if (!derived.ok) return derived.response;

    const dealerKey =
      Object.keys(clean).find((k) => k.toLowerCase() === "dealer__c") ?? "Dealer__c";
    if (
      dealerKey in clean &&
      (clean[dealerKey] ?? null) !== derived.dealerId
    ) {
      console.warn(
        JSON.stringify({
          accessNote: "DEALER_DERIVED_OVERRIDE",
          message:
            "Dealer__c in the request body was replaced by the value derived from " +
            "Sales_Rep__c (A1: the dealer is never an independent input).",
          object: objectKey,
          recordId: recordId,
          supplied: clean[dealerKey] ?? null,
          derived: derived.dealerId,
        })
      );
    }
    clean[dealerKey] = derived.dealerId;
  }

  // 5) PATCH to Salesforce (success is 204 No Content).
  const resp = await sfWrite(
    "PATCH",
    `/services/data/${SF_API_VERSION}/sobjects/${entry.sfObject}/${encodeURIComponent(
      recordId
    )}`,
    clean
  );
  if (!resp.ok) return await sfErrorResponse(resp, cors);

  // 6) Mark the cache row stale (do NOT delete — just flag). Best-effort: a
  //    cache-flag failure must NEVER fail the write. Tenant-scoped update; a
  //    missing cache row is a harmless no-op.
  try {
    const supabase = await getSupabaseClient();
    const { error } = await supabase
      .from(entry.cacheTable)
      .update({ is_stale: true })
      .eq("sf_id", recordId)
      .eq("client_sf_id", tenantId);
    if (error) console.error("cache stale-flag error (update):", error.message);
  } catch (e) {
    console.error("cache stale-flag threw (update):", e?.message || String(e));
  }

  return jsonResponse(200, cors, {
    success: true,
    id: recordId,
    source: "salesforce",
  });
}

// --- CREATE (POST /sf/{object}) --------------------------------------------
async function handleCreate({ entry, tenantId, fields, describe, cors, objectKey, access, identity }) {
  // FIELD AUTHORIZATION for a sales role, as on update. Note the ownership fields are
  // in SALES_PROTECTED_FIELDS, so a body naming Sales_Rep__c or Dealer__c on create is
  // REJECTED rather than silently overwritten by the stamp below — the caller learns
  // their input was refused instead of believing it was honoured.
  const forbidden = forbiddenFields(objectKey, access, fields);
  if (forbidden) {
    console.warn(
      JSON.stringify({
        accessDenial: "FIELD_FORBIDDEN",
        user: identity?.user?.id ?? null,
        level: access?.level ?? null,
        scope: access?.scope ?? null,
        object: objectKey,
        create: true,
        fields: forbidden,
      })
    );
    return jsonResponse(403, cors, {
      error: "forbidden_field",
      code: DENY.FIELD_FORBIDDEN,
      fields: forbidden,
    });
  }

  // Validate against describe (createable) + blocklist. Client__c in the body is
  // blocklisted and rejected here — it is NEVER accepted from input.
  const { rejected, clean } = validateWritableFields(describe, fields, "create");
  if (rejected.length > 0) {
    return jsonResponse(400, cors, {
      error: "unwritable_field",
      code: "FIELD_NOT_WRITABLE",
      fields: rejected,
    });
  }

  // FORCE tenant server-side: stamp Client__c = the caller's resolved tenantId,
  // regardless of input. This is the ONLY place Client__c is set, and its value
  // comes solely from the verified token — so a new record cannot be created in
  // another tenant. (Client__c can never arrive via the body; the blocklist
  // rejects it above, so this assignment is authoritative and un-overridable.)
  const payload = { ...clean, Client__c: tenantId };

  // §2.3 invariant 1: OWNERSHIP IS STAMPED SERVER-SIDE for a sales role, from the
  // AccessContext, exactly as Client__c is. The body cannot reach these — they are in
  // SALES_PROTECTED_FIELDS and were rejected above — so this assignment is the only
  // writer and cannot be overridden.
  //
  // `Dealer__c` is stamped from the caller's own dealer rather than derived from the
  // rep, which is the same value by construction here: the rep IS the caller. A1's
  // "derive the dealer from the rep" matters on REASSIGNMENT (invariant 2), which is
  // tenant-scope only and is not this path.
  //
  // Tenant scope is untouched: staff keep setting Sales_Rep__c from the body, which is
  // how a coordinator creates a customer on a rep's behalf.
  if (access && access.scope !== "tenant") {
    payload.Sales_Rep__c = access.userId;
    payload.Dealer__c = access.dealerId;
  }

  const resp = await sfWrite(
    "POST",
    `/services/data/${SF_API_VERSION}/sobjects/${entry.sfObject}`,
    payload
  );
  if (!resp.ok) return await sfErrorResponse(resp, cors);

  // Success is 201 with { id, success, errors }.
  let created = null;
  try {
    created = await resp.json();
  } catch {
    /* fall through with null id */
  }
  const newId = created?.id ?? null;

  // KNOWN LIMITATION (intentional, not solved here): there is no cache row to
  // invalidate for a brand-new record. Because list reads are cache-first and may
  // serve a stale tenant list, this record might not appear in a list until that
  // tenant's list cache is refreshed / marked stale. Accepted for now.

  return jsonResponse(201, cors, {
    success: true,
    id: newId,
    source: "salesforce",
  });
}

// --- handler ---------------------------------------------------------------
export const handler = async (event) => {
  const method =
    event?.requestContext?.http?.method || event?.httpMethod || "";
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  // DELETE is intentionally NOT implemented in this build (see D-036 scope).
  if (method === "DELETE") {
    return jsonResponse(501, cors, {
      error: "not_implemented",
      code: "DELETE_NOT_IMPLEMENTED",
      message: "Delete is not implemented by sundial-sf-update in this build.",
    });
  }

  if (method !== "POST" && method !== "PATCH") {
    return jsonResponse(405, cors, {
      error: "method_not_allowed",
      code: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const { objectKey, id } = extractRoute(event);

    // Allowlist gate — caller can never reach an object outside this map.
    const entry = objectKey ? OBJECT_ALLOWLIST[objectKey] : null;
    if (!entry) {
      return jsonResponse(400, cors, {
        error: "unsupported_object",
        code: "OBJECT_NOT_ALLOWED",
      });
    }

    // Auth on every write. Tenant is derived ONLY from the verified token.
    let identity;
    try {
      identity = await resolveIdentity(headers["authorization"]);
    } catch (err) {
      const mapped = mapIdentityError(err?.code);
      if (mapped) return jsonResponse(mapped.status, cors, mapped.body);
      throw err; // unexpected -> 500 below
    }

    const tenantId = identity.tenantId;
    // Without a resolved tenant we cannot scope safely — refuse the write.
    if (!tenantId) {
      return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });
    }

    // Body must be present and well-formed for both POST and PATCH.
    const body = parseBody(event);
    if (!body.ok) {
      return jsonResponse(400, cors, {
        error: "invalid_body",
        code: "INVALID_BODY",
        message:
          'Expected JSON { "fields": { "Api_Name__c": value, ... } } with at least one field.',
      });
    }

    // ACCESS MODEL (D-064 §3.4). Null unless ACCESS_MODEL_MODE=enforce, and every gate
    // treats null as "not enforcing" — so this Lambda's behaviour is bound to the same
    // switch as sf-query's, and rolls back the same way.
    const enforcing = resolveMode() === MODES.ENFORCE;
    const access = enforcing ? identity.access : null;

    const gated = accessGate({
      objectKey,
      access,
      cors,
      isCreate: method === "POST",
    });
    if (gated) return gated;

    // Describe is the authority for field-write safety (cached per object).
    const describe = await getRawDescribe(entry.sfObject);

    if (method === "PATCH") {
      return await handleUpdate({
        entry,
        id,
        tenantId,
        fields: body.fields,
        describe,
        cors,
        objectKey,
        access,
        identity,
      });
    }
    // POST
    return await handleCreate({
      entry,
      tenantId,
      fields: body.fields,
      describe,
      cors,
      objectKey,
      access,
      identity,
    });
  } catch (err) {
    console.error("sf-update unexpected error:", err?.message || String(err));
    return jsonResponse(500, cors, { error: "server_error" });
  }
};
