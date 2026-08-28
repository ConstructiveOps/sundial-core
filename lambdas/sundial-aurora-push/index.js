// sundial-aurora-push — on-demand push of a Sundial Customer to Aurora Solar.
//
// Handles:
//   POST /customers/{recordId}/design-request/submit   (recordId = Sundial_Customer__c Id)
//        The "Submit Design Request" button. EVERYTHING Aurora-related in Sundial
//        operates on Sundial_Customer__c: at design-request time no Sundial_Solar__c
//        record exists yet (a Solar project is created only after the proposal is
//        done and docs are signed). See D-047.
//   POST /aurora/push   body { "object": "customer", "recordId": "<Sundial_Customer__c Id>" }
//        Manual/retry entry (also supports retryConsumptionOnly).
//
// WHAT IT DOES (in order):
//   1. Reads the Sundial_Customer__c record, TENANT-SCOPED (Id + Client__c). A
//      missing or cross-tenant id is indistinguishable -> 404. The record is read
//      FRESH at submit time — no field value is ever taken from the request body.
//   2. IDEMPOTENCY GUARD: if Sent_to_Aurora__c or Aurora_Project_ID__c is already
//      set, it does NOT create a second Aurora project (Aurora projects are REAL,
//      production records) -> returns already_pushed with the existing id.
//      PROJECT CREATION is once-only; NOTIFICATION is separately retryable — see
//      EMAIL_SENT_FIELD. A re-submit whose notification never landed re-sends it.
//   3. Creates an Aurora project (POST .../projects) with the customer's identity,
//      SITE address, and external_provider_id = the Salesforce record Id (the
//      cross-reference that lets Aurora point back at Sundial).
//   4. Pushes the 12 monthly usage values as an ordered Jan..Dec array to the
//      project's consumption profile (skipped, not failed, when all 12 are empty).
//   5. Writes back to Salesforce (Sent_to_Aurora__c = now, Aurora_Project_ID__c).
//   6. Design-request route only: emails the design manager the FULL Design Request
//      field set, then stamps Design_Request_Email_Sent__c. Aurora's API accepts
//      none of those form fields, so the email is their only delivery channel —
//      see designRequest.js for the split and docs/integrations/aurora-api-reference.md
//      for Aurora's request surface. Best-effort: an email failure never fails the
//      push, and leaves the request re-sendable via a re-submit.
//
// CORE ISOLATION GUARANTEE (mirrors sf-query / sf-update): the tenant is derived
// ONLY from the verified token (resolveIdentity -> tenantId = the Salesforce
// Client record id). NO request input can set or override it. Every Salesforce
// read/write filters Client__c = '<tenantId>'.
//
// PRODUCTION-SAFETY: this calls Aurora's PRODUCTION API and creates real records,
// so the code is deliberately fail-safe about NOT double-creating:
//   - The idempotency guard blocks a re-push once Aurora_Project_ID__c is saved.
//   - If the Aurora project is created but the Salesforce write-back FAILS, we
//     return HTTP 200 with status "pushed_writeback_failed" (NOT a 5xx). A 5xx
//     would invite the caller to retry, and since Aurora_Project_ID__c was never
//     saved, that retry would create a DUPLICATE Aurora project. Returning a
//     clear, non-retryable 200 status surfaces the problem without that risk.
//
// Value-safety: never logs or returns tokens, secrets, or key material. Aurora's
// own validation messages ARE surfaced to the caller (business-level, not
// sensitive); full Aurora error detail is logged to CloudWatch only.
//
// NOTE ON "tenant_id": there are TWO unrelated tenant ids in this file.
//   - identity.tenantId  = the SALESFORCE Client record id (isolation key).
//   - auroraConfig.tenantId = the AURORA tenant UUID from the secret (URL path).
// They are never interchanged.

import {
  getSalesforceToken,
  sfQuery,
  soqlEscapeString,
} from "../../lib/salesforce.js";
import { resolveIdentity } from "../../lib/identity.js";
import {
  alwaysEnforcedAccess,
  assertActionOnRecord,
} from "../../lib/access-enforce.js";
import { getSecret } from "../../lib/secrets.js";
import {
  ALL_EMAIL_FIELD_NAMES,
  sendDesignRequestNotification,
} from "./designRequest.js";

const SF_API_VERSION = "v60.0";

// The Aurora API credentials/config secret. Shape: { base_url, tenant_id, api_key }.
const AURORA_SECRET_NAME = "sundial/aurora/api";

// Only "customer" is a valid push source in this build. Anything else -> 400.
const SUPPORTED_OBJECT = "customer";
const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";

// DATETIME stamped the first time the design-request notification actually LANDS.
// This is deliberately SEPARATE from Sent_to_Aurora__c, and the reason matters:
// because Aurora has no design-request API, the email IS the design request. If the
// two shared one marker, a first submit whose email failed (SES down, env not yet
// configured) would leave the customer stamped as "submitted" with nobody notified,
// and every re-submit would short-circuit to already_submitted — an Aurora project
// with no design request behind it and no way to recover from inside the product.
// Splitting them makes project creation strictly once-only while leaving NOTIFICATION
// independently retryable: re-submit until it sends. Describe-guarded, so this all
// works before the field exists (see notes on the resend path below).
const EMAIL_SENT_FIELD = "Design_Request_Email_Sent__c";

// The 12 monthly usage fields in CALENDAR ORDER Jan..Dec. This order is the
// contract for Aurora's monthly_energy array (index 0 = January), so it must
// never be reordered or sorted.
const USAGE_FIELDS = [
  "Jan_Usage_kW__c",
  "Feb_Usage_kW__c",
  "Mar_Usage_kW__c",
  "Apr_Usage_kW__c",
  "May_Usage_kW__c",
  "Jun_Usage_kW__c",
  "Jul_Usage_kW__c",
  "Aug_Usage_kW__c",
  "Sep_Usage_kW__c",
  "Oct_Usage_kW__c",
  "Nov_Usage_kW__c",
  "Dec_Usage_kW__c",
];

// Fields read from the customer record on EVERY route. Id + Name are always needed
// (Id -> external_provider_id + write-back target; Name -> project name fallback).
// Sent_to_Aurora__c and Aurora_Project_ID__c drive the idempotency guard.
const CUSTOMER_SELECT_FIELDS = [
  "Id",
  "Name",
  "First_Name__c",
  "Last_Name__c",
  "Primary_Email__c",
  "Primary_Phone__c",
  "Street__c",
  "City__c",
  "State__c",
  "Postal_Code__c",
  ...USAGE_FIELDS,
  "Aurora_Project_ID__c",
  "Sent_to_Aurora__c",
];

// --- CORS (mirrors the other Lambdas; this route is POST/OPTIONS) -----------
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

// Same identity-error -> HTTP mapping the read/write Lambdas use.
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

// --- Request body parsing --------------------------------------------------
// Expects JSON { object: "customer", recordId: "<id>" }. API Gateway may deliver
// the body base64-encoded (event.isBase64Encoded) — decode to UTF-8 BEFORE parse.
function parseBody(event) {
  let raw = event?.body;

  if (raw != null && typeof raw === "object") return raw; // already parsed
  if (raw == null) return null;

  if (event?.isBase64Encoded) {
    try {
      raw = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  raw = String(raw).trim();
  if (raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// --- Small value helpers ---------------------------------------------------
// Trim a Salesforce string value to a clean string ("" for null/undefined).
function cleanStr(v) {
  return v == null ? "" : String(v).trim();
}
// Null-or-string for optional Aurora customer fields (empty -> null).
function orNull(v) {
  const s = cleanStr(v);
  return s === "" ? null : s;
}

// Return a copy of `obj` with every key whose value is null/undefined/"" (or a
// whitespace-only string) removed. Aurora rejects null for its string-typed
// optional fields, so an absent value MUST be an absent key, never null. This
// guards ALL optional fields uniformly — pass only optional fields to it.
function stripEmptyOptional(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = v;
  }
  return out;
}

// Build Aurora's single-string SITE address from the customer's address fields.
// Aurora nests the address as location.property_address (a full address string) —
// it has NO flat street/city/state/postal fields and no country field, so we
// assemble one geocodable line: "Street, City, State Postal, US". Empty parts are
// dropped; country "US" is appended only when there is at least some address.
function buildPropertyAddress(rec) {
  const street = cleanStr(rec.Street__c);
  const city = cleanStr(rec.City__c);
  const stateZip = [cleanStr(rec.State__c), cleanStr(rec.Postal_Code__c)]
    .filter(Boolean)
    .join(" ")
    .trim();
  const parts = [street, city, stateZip].filter(Boolean);
  if (parts.length === 0) return "";
  return `${parts.join(", ")}, US`;
}

// Aurora's sentinel for an empty month: the literal 4-character STRING "null",
// NOT JSON null. Aurora's rule: "An array of exactly 12 monthly energy values in
// kWh. Null values are allowed and represented as \"null\"." A JSON null is
// rejected ("must be an array of 12 numbers or strings equal to \"null\"").
const EMPTY_MONTH = "null";

// Assemble the ORDERED 12-element Jan..Dec monthly_energy array from the usage
// fields. Each slot is either a finite NUMBER (real value) or the STRING "null"
// (missing/empty/blank/non-numeric). The array is always exactly length 12,
// mixing numbers and the "null" sentinel. Returns { monthlyEnergy, hasData }
// where hasData is true iff >= 1 slot is a real number (not the "null" sentinel).
function buildMonthlyEnergy(rec) {
  let hasData = false;
  const monthlyEnergy = USAGE_FIELDS.map((field) => {
    const v = rec[field];
    if (v === null || v === undefined || v === "") return EMPTY_MONTH;
    const n = Number(v);
    if (!Number.isFinite(n)) return EMPTY_MONTH; // non-numeric -> empty sentinel
    hasData = true;
    return n;
  });
  return { monthlyEnergy, hasData };
}

// --- Aurora config (validated + cached in module scope) --------------------
let auroraConfigCache = null;
async function getAuroraConfig() {
  if (auroraConfigCache) return auroraConfigCache;
  const secret = await getSecret(AURORA_SECRET_NAME);
  const baseUrl = cleanStr(secret?.base_url);
  const tenantId = cleanStr(secret?.tenant_id); // AURORA tenant UUID (URL path)
  const apiKey = cleanStr(secret?.api_key);
  const missing = [];
  if (!baseUrl) missing.push("base_url");
  if (!tenantId) missing.push("tenant_id");
  if (!apiKey) missing.push("api_key");
  if (missing.length > 0) {
    throw new Error(
      `Secret "${AURORA_SECRET_NAME}" is missing field(s): ${missing.join(", ")}.`
    );
  }
  auroraConfigCache = {
    baseUrl: baseUrl.replace(/\/+$/, ""), // trim trailing slash
    tenantId,
    apiKey,
  };
  return auroraConfigCache;
}

// A single Aurora API call. Bearer auth uses the api_key directly (Aurora issues
// no separate token). Returns the raw fetch Response.
async function auroraFetch(method, url, apiKey, bodyObj) {
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyObj),
  });
}

// Send the customer's 12-month usage to an EXISTING Aurora project's consumption
// profile. Shared by the normal push path and the retryConsumptionOnly path so
// the "null" sentinel handling and skip-if-all-empty rule live in one place.
//
// Returns { consumption, consumptionError }:
//   - "skipped_no_data" : all 12 months empty -> PUT NOT sent (Aurora requires
//                         >= 1 real value; an all-"null" array would be rejected).
//   - "sent"            : PUT succeeded.
//   - "failed"          : PUT returned non-2xx (error captured, NOT thrown — the
//                         caller decides how to surface it; the project stands).
async function sendConsumption(aurora, auroraProjectId, rec) {
  const { monthlyEnergy, hasData } = buildMonthlyEnergy(rec);
  if (!hasData) {
    return { consumption: "skipped_no_data", consumptionError: null };
  }
  const consUrl = `${aurora.baseUrl}/tenants/${aurora.tenantId}/projects/${encodeURIComponent(
    auroraProjectId
  )}/consumption_profile`;
  const consResp = await auroraFetch("PUT", consUrl, aurora.apiKey, {
    consumption_profile: { monthly_energy: monthlyEnergy },
  });
  if (consResp.ok) {
    return { consumption: "sent", consumptionError: null };
  }
  const consText = await consResp.text();
  console.error(
    `aurora consumption failed (${consResp.status}) for project ${auroraProjectId}: ${consText}`
  );
  let consumptionError;
  try {
    consumptionError = JSON.parse(consText);
  } catch {
    consumptionError = consText;
  }
  return { consumption: "failed", consumptionError };
}

// --- Salesforce describe (module-scope cached, with TTL) -------------------
// Two uses: (a) at write-back time, to learn the type of Sent_to_Aurora__c
// (boolean vs datetime) and confirm both write-back fields exist before we PATCH;
// (b) on the design-request route, to build the SELECT from only the Design Request
// fields the org actually has (Design_Notes__c is not created yet — selecting a
// non-existent field would 400 the whole submit).
//
// TTL per D-045: a cached describe goes stale when fields are added or FLS changes,
// and a warm container would keep omitting a newly-created field indefinitely. Five
// minutes bounds that without a redeploy.
const DESCRIBE_TTL_MS = 5 * 60 * 1000;
const describeCache = new Map(); // sfObject -> { meta, fetchedAt }

async function getRawDescribe(sfObject) {
  const cached = describeCache.get(sfObject);
  if (cached && Date.now() - cached.fetchedAt < DESCRIBE_TTL_MS) {
    return cached.meta;
  }
  async function run(forceRefresh) {
    const { access_token, instance_url } = await getSalesforceToken({
      forceRefresh,
    });
    const url = `${instance_url}/services/data/${SF_API_VERSION}/sobjects/${sfObject}/describe`;
    return fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
  }
  let resp = await run(false);
  if (resp.status === 401) resp = await run(true);
  if (!resp.ok) throw new Error(`describe ${sfObject} failed (${resp.status})`);
  const meta = await resp.json();
  describeCache.set(sfObject, { meta, fetchedAt: Date.now() });
  return meta;
}

// The set of field API names (lowercased) the object actually has.
function describeFieldNameSet(describe) {
  return new Set((describe.fields || []).map((f) => f.name.toLowerCase()));
}

// Remembers the last "missing fields" signature so the warning below is logged on
// change only, not on every single submit.
let lastMissingWarning = null;

// Resolve which of the optional design-request fields (email display fields +
// EMAIL_SENT_FIELD) exist on the object, returning them in the object's canonical
// casing so the SELECT is exact. Fields the org doesn't have yet (Design_Notes__c,
// and Design_Request_Email_Sent__c until it's created) are dropped — the submit
// still succeeds.
function resolveOptionalFields(describe) {
  const byLower = new Map(
    (describe.fields || []).map((f) => [f.name.toLowerCase(), f])
  );
  const present = [];
  const missing = [];
  for (const api of [...ALL_EMAIL_FIELD_NAMES, EMAIL_SENT_FIELD]) {
    const match = byLower.get(api.toLowerCase());
    if (match) present.push(match.name);
    else missing.push(api);
  }
  const signature = missing.join(",");
  if (missing.length > 0 && signature !== lastMissingWarning) {
    console.warn(
      `design-request: ${CUSTOMER_SF_OBJECT} has no field(s) ${missing.join(
        ", "
      )} — see the notification-tracking note in index.js.`
    );
  }
  lastMissingWarning = signature;
  // The tracking field's canonical name (null when the org doesn't have it yet).
  const trackingField =
    present.find((n) => n.toLowerCase() === EMAIL_SENT_FIELD.toLowerCase()) ||
    null;
  return { present, missing, trackingField };
}

// Stamp "the design manager has actually been notified" on the customer. Called only
// after a notification genuinely lands. Best-effort: a failure here means the next
// re-submit re-sends the email (a duplicate notification), which is strictly better
// than the alternative failure mode — silence.
async function markEmailSent(trackingField, recordId) {
  if (!trackingField) return { ok: false, reason: "field_absent" };
  try {
    const resp = await sfPatch(CUSTOMER_SF_OBJECT, recordId, {
      [trackingField]: new Date().toISOString(),
    });
    if (resp.ok) return { ok: true };
    const text = await resp.text();
    console.error(
      `design-request: ${trackingField} write failed (${resp.status}) for ${recordId}: ${text}`
    );
    return { ok: false, reason: text };
  } catch (e) {
    const reason = e?.message || String(e);
    console.error(
      `design-request: ${trackingField} write threw for ${recordId}: ${reason}`
    );
    return { ok: false, reason };
  }
}

// --- Salesforce write (REST PATCH) with one 401 refresh/retry --------------
// Direct REST PATCH using the integration token — the same mechanism
// sundial-sf-update uses under the hood. The record was already proven to belong
// to the caller's tenant by the tenant-scoped read, so patching it by Id is safe.
async function sfPatch(sfObject, id, fieldsObj) {
  async function run(forceRefresh) {
    const { access_token, instance_url } = await getSalesforceToken({
      forceRefresh,
    });
    return fetch(
      `${instance_url}/services/data/${SF_API_VERSION}/sobjects/${sfObject}/${encodeURIComponent(
        id
      )}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(fieldsObj),
      }
    );
  }
  let resp = await run(false);
  if (resp.status === 401) resp = await run(true);
  return resp;
}

// Build the write-back field map for the new Aurora project id. Aurora_Project_ID__c
// is always set. Sent_to_Aurora__c is included only if the describe shows it exists,
// with its value shaped to the field's type (datetime -> ISO now, else boolean true).
// Using canonical describe casing for the keys keeps the PATCH robust.
function buildWritebackFields(describe, auroraProjectId) {
  const byLower = new Map(
    (describe.fields || []).map((f) => [f.name.toLowerCase(), f])
  );
  const out = {};

  const projField = byLower.get("aurora_project_id__c");
  // Fall back to the literal API name if describe somehow lacks it; a genuinely
  // missing field will surface as a Salesforce write error (-> writeback_failed).
  out[projField ? projField.name : "Aurora_Project_ID__c"] = auroraProjectId;

  const sentField = byLower.get("sent_to_aurora__c");
  if (sentField) {
    out[sentField.name] =
      sentField.type === "datetime" || sentField.type === "date"
        ? new Date().toISOString()
        : true;
  }
  return out;
}

// Detect the "Submit Design Request" route:
//   POST /customers/{recordId}/design-request/submit  (recordId = Sundial_Customer__c Id)
// Returns the CUSTOMER record id when on that route, else null (the body-based push).
// There is no project-side variant: no Sundial_Solar__c record exists at design-
// request time (D-047), so the customer id is the only id the caller can send.
function extractDesignRequestCustomerId(event) {
  const path = event?.rawPath || event?.path || "";
  if (!/\/design-request\/submit\/?$/.test(path)) return null;
  const pp = event?.pathParameters || {};
  if (pp.recordId) return decodeURIComponent(pp.recordId);
  const m = path.match(/\/customers\/([^/]+)\/design-request\/submit\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
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
  if (method !== "POST") {
    return jsonResponse(405, cors, {
      error: "method_not_allowed",
      code: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    // --- Input: two routes, one push -----------------------------------------
    // (a) Design-request route: POST /customers/{customerId}/design-request/submit —
    //     the "Submit Design Request" button. The path id IS the customer id; every
    //     value we send is read fresh from that record (never from the body).
    // (b) Body route (existing): POST body { object:"customer", recordId, ... } —
    //     direct customer push / manual / retry.
    const designRequestCustomerId = extractDesignRequestCustomerId(event);
    const viaDesignRequest = designRequestCustomerId !== null;

    let recordId; // the CUSTOMER id we push
    let retryConsumptionOnly = false;

    if (!viaDesignRequest) {
      const body = parseBody(event);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return jsonResponse(400, cors, {
          error: "invalid_body",
          code: "INVALID_BODY",
          message: 'Expected JSON { "object": "customer", "recordId": "<id>" }.',
        });
      }
      const objectKey = cleanStr(body.object).toLowerCase();
      if (objectKey !== SUPPORTED_OBJECT) {
        return jsonResponse(400, cors, {
          error: "unsupported_object",
          code: "OBJECT_NOT_ALLOWED",
          message: `Only "${SUPPORTED_OBJECT}" is supported by this endpoint.`,
        });
      }
      recordId = cleanStr(body.recordId);
      // Light Salesforce-id shape check — cheap 400 before touching Salesforce.
      // The value is still SOQL-escaped below regardless.
      if (!/^[a-zA-Z0-9]{15,18}$/.test(recordId)) {
        return jsonResponse(400, cors, {
          error: "invalid_record_id",
          code: "INVALID_RECORD_ID",
          message: "recordId must be a Salesforce record id.",
        });
      }
      // Optional "resend consumption" mode: (re)send the consumption profile to an
      // EXISTING Aurora project only — never creates one. Body route only.
      retryConsumptionOnly = body.retryConsumptionOnly === true;
    } else if (!/^[a-zA-Z0-9]{15,18}$/.test(designRequestCustomerId)) {
      return jsonResponse(400, cors, {
        error: "invalid_record_id",
        code: "INVALID_RECORD_ID",
        message:
          "Design request requires a Salesforce Customer record id in the path.",
      });
    } else {
      recordId = designRequestCustomerId;
    }

    // --- Auth: tenant derived ONLY from the verified token ------------------
    let identity;
    try {
      identity = await resolveIdentity(headers["authorization"]);
    } catch (err) {
      const mapped = mapIdentityError(err?.code);
      if (mapped) return jsonResponse(mapped.status, cors, mapped.body);
      throw err; // unexpected -> 500 below
    }
    const tenantId = identity.tenantId; // SALESFORCE Client record id
    if (!tenantId) {
      return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });
    }

    // ACCESS MODEL (D-064 §3.6). THE ONE ACTION OPEN TO SALES ROLES, and Tim's call
    // (§12.2): sending a design request IS the rep's job, and the dealer's name and the
    // stamped rep flow into the Aurora project.
    //
    // ⚠️ BOTH QUESTIONS. canAction says every rep MAY submit design requests;
    // assertRecordVisible says whether THIS rep may submit for THAT customer. Asking
    // only the first would let a rep fire a design request at any customer id in the
    // tenant — and this route creates a real Aurora project and emails a real person,
    // so the request itself is the side effect, not the response.
    {
      const denied = await assertActionOnRecord(
        "aurora.design_request",
        "customer",
        recordId,
        alwaysEnforcedAccess(identity)
      );
      if (denied) return jsonResponse(denied.status, cors, denied.body);
    }

    // --- Design-request: widen the SELECT to the notification-email field set.
    //     Resolved against the live describe so a field the org doesn't have yet
    //     (Design_Notes__c) is dropped instead of 400-ing the whole query. A
    //     describe failure here throws -> 500, which is safe: it happens BEFORE any
    //     Aurora call, so nothing can be half-created.
    let selectFields = CUSTOMER_SELECT_FIELDS;
    let availableFields = null; // lowercased field names, for the email builder
    let trackingField = null; // canonical EMAIL_SENT_FIELD name, or null if absent
    if (viaDesignRequest) {
      const describe = await getRawDescribe(CUSTOMER_SF_OBJECT);
      availableFields = describeFieldNameSet(describe);
      const resolved = resolveOptionalFields(describe);
      trackingField = resolved.trackingField;
      // Dedupe — the identity fields overlap CUSTOMER_SELECT_FIELDS.
      selectFields = [...new Set([...CUSTOMER_SELECT_FIELDS, ...resolved.present])];
    }

    // --- 1) Read the customer, TENANT-SCOPED (Id + Client__c) ---------------
    // Fresh read at submit time: every value pushed to Aurora and shown in the
    // email comes from here, never from the request body.
    const soql =
      `SELECT ${selectFields.join(", ")} FROM ${CUSTOMER_SF_OBJECT} ` +
      `WHERE Id = '${soqlEscapeString(recordId)}' ` +
      `AND Client__c = '${soqlEscapeString(tenantId)}' ` +
      `LIMIT 1`;
    const records = await sfQuery(soql);
    if (!records || records.length === 0) {
      // Missing OR cross-tenant -> 404 (never reveal which).
      return jsonResponse(404, cors, {
        error: "not_found",
        code: "RECORD_NOT_FOUND",
      });
    }
    const rec = records[0];
    const existingAuroraId = cleanStr(rec.Aurora_Project_ID__c);
    // Sent_to_Aurora__c is a DATETIME (verified by describe): a non-empty value
    // means "already submitted". Either marker counts, so a re-submit can never
    // create a second production Aurora project even if only one of the two
    // write-back fields landed.
    const alreadySubmitted =
      existingAuroraId !== "" || cleanStr(rec.Sent_to_Aurora__c) !== "";

    // --- RETRY-CONSUMPTION-ONLY path (guarded) ------------------------------
    // Only (re)send the consumption profile to the record's EXISTING Aurora
    // project. Requires a project to already exist; NEVER creates one. Tenant
    // safety is identical to the normal path (the record was read with the same
    // Id + Client__c filter above).
    if (retryConsumptionOnly) {
      if (existingAuroraId === "") {
        // Nothing to resend to — and this mode must not create a project.
        return jsonResponse(400, cors, {
          error: "no_aurora_project",
          code: "NO_AURORA_PROJECT",
          message:
            "retryConsumptionOnly requires the record to already have an Aurora_Project_ID__c.",
        });
      }
      const aurora = await getAuroraConfig();
      const { consumption, consumptionError } = await sendConsumption(
        aurora,
        existingAuroraId,
        rec
      );
      return jsonResponse(200, cors, {
        status: "consumption_retried",
        auroraProjectId: existingAuroraId,
        recordId: rec.Id,
        consumption,
        ...(consumptionError ? { consumptionError } : {}),
      });
    }

    // --- 2) IDEMPOTENCY: already pushed? Do NOT create a second project -----
    // Project creation is strictly once-only. NOTIFICATION is not: the two are
    // tracked separately (see EMAIL_SENT_FIELD) so a re-submit can recover a
    // notification that never landed.
    if (alreadySubmitted) {
      const base = {
        status: "already_pushed",
        auroraProjectId: existingAuroraId || null,
        recordId: rec.Id,
        sentToAurora: rec.Sent_to_Aurora__c ?? null,
      };
      if (!viaDesignRequest) return jsonResponse(200, cors, base);

      // Has a notification EVER landed for this customer? When the tracking field
      // doesn't exist on the org yet, we cannot know — and we choose to re-send
      // rather than assume success, because the failure we're guarding against is
      // the design team never hearing about a submitted request. Until the field
      // is created, this route doubles as a manual "re-send the design request"
      // button (flagged as tracking: "unavailable" in the response).
      const alreadyNotified =
        trackingField !== null && cleanStr(rec[trackingField]) !== "";

      if (alreadyNotified) {
        return jsonResponse(200, cors, {
          ...base,
          notifiedAt: rec[trackingField],
          email: { sent: false, reason: "already_submitted" },
        });
      }

      // Recovery re-send. Same payload, all values re-read fresh above. NO Aurora
      // calls happen on this path — nothing is created, nothing is re-pushed.
      const resent = await sendDesignRequestNotification({
        rec,
        auroraProjectId: existingAuroraId,
        monthlyEnergy: buildMonthlyEnergy(rec).monthlyEnergy,
        availableFields,
      });
      const email = { ...resent, resend: true };
      if (resent.sent) {
        const marked = await markEmailSent(trackingField, rec.Id);
        if (!marked.ok) {
          // Not fatal: worst case the next re-submit sends a duplicate.
          if (marked.reason === "field_absent") email.tracking = "unavailable";
          else email.trackingWriteFailed = true;
        }
      } else if (trackingField === null) {
        email.tracking = "unavailable";
      }
      return jsonResponse(200, cors, { ...base, email });
    }

    // --- Aurora config + build the create-project body ----------------------
    const aurora = await getAuroraConfig();

    const firstName = orNull(rec.First_Name__c);
    const lastName = orNull(rec.Last_Name__c);
    const name =
      [firstName, lastName].filter(Boolean).join(" ").trim() ||
      cleanStr(rec.Name) ||
      "Unnamed Customer";

    const propertyAddress = buildPropertyAddress(rec);
    // Aurora REQUIRES location (property_address OR lat/lng). We only have an
    // address, so refuse up front rather than fire a doomed production create.
    if (propertyAddress === "") {
      return jsonResponse(400, cors, {
        error: "missing_address",
        code: "MISSING_SITE_ADDRESS",
        message:
          "Customer has no site address; Aurora requires an address to create a project.",
      });
    }

    // Build the project object then STRIP every optional key whose value is
    // null/undefined/blank. Aurora types its optional customer_* fields as plain
    // "string" with NO null allowed — sending null yields a 422 "must be a
    // string". Omitting the key entirely is the only safe way to express "we
    // don't have this value". stripEmptyOptional (below) enforces this for ALL
    // optional fields at once, so a blank email/phone/name-part never breaks the
    // push. customer_salutation is intentionally not present here — we never
    // collect it, so it is never sent.
    //
    // REQUIRED fields (external_provider_id, name, status, location) are added
    // AFTER stripping so they always ship. `name` already falls back to a
    // non-empty string above, and location.property_address is guaranteed
    // non-empty by the MISSING_SITE_ADDRESS guard, so neither is ever blank.
    const optionalCustomerFields = stripEmptyOptional({
      customer_first_name: firstName,
      customer_last_name: lastName,
      customer_email: orNull(rec.Primary_Email__c),
      customer_phone: orNull(rec.Primary_Phone__c),
    });

    const projectBody = {
      project: {
        // Required — always present.
        external_provider_id: rec.Id, // cross-reference back to Sundial_Customer__c
        name,
        status: "active",
        // Address is nested per Aurora's schema (no flat property_* fields).
        location: { property_address: propertyAddress },
        // Optional customer fields, only those with real values.
        ...optionalCustomerFields,
      },
    };

    // --- 3) CREATE the Aurora project ---------------------------------------
    const createUrl = `${aurora.baseUrl}/tenants/${aurora.tenantId}/projects`;
    const createResp = await auroraFetch(
      "POST",
      createUrl,
      aurora.apiKey,
      projectBody
    );
    const createText = await createResp.text();
    if (!createResp.ok) {
      // Surface Aurora's message to the caller; full detail to CloudWatch only.
      console.error(
        `aurora create failed (${createResp.status}) for ${rec.Id}: ${createText}`
      );
      let auroraError = createText;
      try {
        auroraError = JSON.parse(createText);
      } catch {
        /* keep raw text */
      }
      return jsonResponse(502, cors, {
        error: "aurora_create_failed",
        status: createResp.status,
        auroraError,
      });
    }

    // Capture the new project id — Aurora returns it at project.id (or id).
    let created = null;
    try {
      created = JSON.parse(createText);
    } catch {
      /* handled below */
    }
    const auroraProjectId = created?.project?.id ?? created?.id ?? null;
    if (!auroraProjectId) {
      // 2xx but no id — we cannot proceed safely (no id to persist or attach
      // consumption to). Treat as a create failure so nothing silently strands.
      console.error(
        `aurora create returned no project id for ${rec.Id}: ${createText}`
      );
      return jsonResponse(502, cors, {
        error: "aurora_create_failed",
        status: createResp.status,
        auroraError: "Aurora response contained no project id.",
      });
    }

    // --- 4) CONSUMPTION: ordered Jan..Dec monthly_energy --------------------
    // consumption: "sent" | "skipped_no_data" | "failed". A failure here does NOT
    // unwind the just-created project; we continue to write-back so the id is
    // still saved.
    const { consumption, consumptionError } = await sendConsumption(
      aurora,
      auroraProjectId,
      rec
    );

    // --- 5) WRITE BACK the Aurora project id to Salesforce ------------------
    // A write-back failure is surfaced (status pushed_writeback_failed) rather
    // than thrown: the Aurora project WAS created, and returning a 5xx would
    // invite a retry that double-creates. See the header note.
    let writebackFailed = false;
    let writebackError = null;
    try {
      const describe = await getRawDescribe(CUSTOMER_SF_OBJECT);
      const writeFields = buildWritebackFields(describe, auroraProjectId);
      const patchResp = await sfPatch(CUSTOMER_SF_OBJECT, rec.Id, writeFields);
      if (!patchResp.ok) {
        writebackFailed = true;
        const pText = await patchResp.text();
        console.error(
          `salesforce write-back failed (${patchResp.status}) for ${rec.Id}, aurora ${auroraProjectId}: ${pText}`
        );
        try {
          writebackError = JSON.parse(pText);
        } catch {
          writebackError = pText;
        }
      }
    } catch (e) {
      writebackFailed = true;
      writebackError = e?.message || String(e);
      console.error(
        `salesforce write-back threw for ${rec.Id}, aurora ${auroraProjectId}:`,
        writebackError
      );
    }

    // --- 6) NOTIFY the design manager (design-request route only) -----------
    // Carries the FULL Design Request field set — Aurora's API accepts none of
    // those fields, so this email is how they actually reach the design team.
    // Sent even when the write-back failed: the request WAS submitted and the
    // design manager must not be the one who pays for a Salesforce hiccup.
    // Strictly best-effort — sendDesignRequestNotification never throws, and a
    // failure here no longer closes the door: EMAIL_SENT_FIELD stays empty, so a
    // re-submit re-sends (see the idempotency branch above).
    let email = null;
    if (viaDesignRequest) {
      email = await sendDesignRequestNotification({
        rec,
        auroraProjectId,
        consumption,
        monthlyEnergy: buildMonthlyEnergy(rec).monthlyEnergy,
        availableFields,
      });
      if (email.sent) {
        const marked = await markEmailSent(trackingField, rec.Id);
        if (!marked.ok) {
          if (marked.reason === "field_absent") email.tracking = "unavailable";
          else email.trackingWriteFailed = true;
        }
      } else if (trackingField === null) {
        email.tracking = "unavailable";
      }
    }

    if (writebackFailed) {
      // Loud, non-retryable partial success: the id is in the body so it is not
      // lost, and the caller knows the Salesforce link must be repaired.
      return jsonResponse(200, cors, {
        status: "pushed_writeback_failed",
        auroraProjectId,
        recordId: rec.Id,
        consumption,
        ...(consumptionError ? { consumptionError } : {}),
        ...(email ? { email } : {}),
        writebackError,
      });
    }

    // --- 7) SUCCESS ---------------------------------------------------------
    return jsonResponse(200, cors, {
      status: "pushed",
      auroraProjectId,
      recordId: rec.Id,
      consumption,
      ...(consumptionError ? { consumptionError } : {}),
      ...(email ? { email } : {}),
    });
  } catch (err) {
    console.error("aurora-push unexpected error:", err?.message || String(err));
    return jsonResponse(500, cors, { error: "server_error" });
  }
};
