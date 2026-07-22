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
const STATIC_ALLOWED_ORIGINS = new Set(["http://localhost:5173"]);

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

// --- Salesforce describe (module-scope cached per object) ------------------
// Holds the FULL describe JSON so each field's updateable/createable flags are
// available. Cached across warm invocations; refreshed on a 401.
const describeCache = new Map();

async function getRawDescribe(sfObject) {
  if (describeCache.has(sfObject)) return describeCache.get(sfObject);

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
  describeCache.set(sfObject, meta);
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
async function handleUpdate({ entry, id, tenantId, fields, describe, cors }) {
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
  const ownSoql =
    `SELECT Id FROM ${entry.sfObject} ` +
    `WHERE Id = '${soqlEscapeString(id)}' ` +
    `AND Client__c = '${soqlEscapeString(tenantId)}' ` +
    `LIMIT 1`;
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

  // 2) Validate the requested fields against describe (updateable) + blocklist.
  const { rejected, clean } = validateWritableFields(describe, fields, "update");
  if (rejected.length > 0) {
    return jsonResponse(400, cors, {
      error: "unwritable_field",
      code: "FIELD_NOT_WRITABLE",
      fields: rejected,
    });
  }

  // 3) PATCH to Salesforce (success is 204 No Content).
  const resp = await sfWrite(
    "PATCH",
    `/services/data/${SF_API_VERSION}/sobjects/${entry.sfObject}/${encodeURIComponent(
      recordId
    )}`,
    clean
  );
  if (!resp.ok) return await sfErrorResponse(resp, cors);

  // 4) Mark the cache row stale (do NOT delete — just flag). Best-effort: a
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
async function handleCreate({ entry, tenantId, fields, describe, cors }) {
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
      });
    }
    // POST
    return await handleCreate({
      entry,
      tenantId,
      fields: body.fields,
      describe,
      cors,
    });
  } catch (err) {
    console.error("sf-update unexpected error:", err?.message || String(err));
    return jsonResponse(500, cors, { error: "server_error" });
  }
};
