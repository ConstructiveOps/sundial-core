// sundial-user-admin — Super Admin portal-user management (D-043 admin surface).
//
// Routes (REST API 5sktfwldh1):
//   GET   /admin/users        -> list the caller's tenant's Sundial_User__c (incl. inactive)
//   POST  /admin/users        -> create a portal user (Supabase auth user + Sundial_User__c)
//   PATCH /admin/users/{id}   -> update whitelisted fields; `active` also bans/unbans Supabase
//
// AUTHORIZATION (D-043): every route runs resolveIdentity() first, then requires
// identity.user.superAdmin === true — FAIL CLOSED (403 NOT_SUPER_ADMIN). The tenant
// comes ONLY from the verified token: every Sundial_User__c read/write filters
// Client__c = '<tenantId>' and creates force-stamp it, so a Super Admin can NEVER
// touch another tenant's users.
//
// NEVER writable from request input: Super_Admin__c (may appear in list responses
// only), Client__c, Supabase_User_Id__c, and email (on PATCH — email change is a
// deliberate non-feature for now). A Super Admin cannot deactivate themselves.
//
// Value-safety: never logs or returns tempPassword, the Supabase_User_Id__c VALUE,
// tokens, or secrets. No new npm deps (supabase-js + jsonwebtoken already present).

import { resolveIdentity } from "../../lib/identity.js";
import { getSupabaseClient } from "../../lib/supabase.js";
import {
  sfQuery,
  soqlEscapeString,
  sfCreateRecord,
  sfUpdateRecord,
} from "../../lib/salesforce.js";
import {
  normalizeHeaders,
  jsonResponse,
  mapIdentityError,
  parseJsonBody,
  httpMethod,
  isAllowedOrigin,
} from "../../lib/http.js";

const SF_OBJECT = "Sundial_User__c";
const ACCESS_LEVELS = new Set([
  "Executive", "Manager", "Admin", "Sales Dealer", "Sales Rep", "Technician",
]);
const DEPARTMENTS = new Set([
  "Residential Solar", "Roofing", "Service", "Commercial",
]);
// ~100 years — an effectively permanent Supabase auth ban for deactivated users.
const BAN_DURATION = "876000h";
// Hierarchy_Level__c is REQUIRED on Sundial_User__c but is NOT part of the D-043
// access model (reserved for the future dealer-visibility phase, and not admin-
// editable here). New users default to the least-privilege base tier to satisfy the
// requirement; a SF admin sets the real value when dealer visibility ships.
const DEFAULT_HIERARCHY_LEVEL = "Sales Rep";

// Base URL of the portal. Invited users are redirected here to set their password.
// Env-configurable so the go-live domain change (Harmon's real domain) is a Lambda
// config update, not a code edit; defaults to the current Vercel prod URL.
const PORTAL_BASE_URL = (process.env.PORTAL_BASE_URL || "https://harmon-crm.vercel.app").replace(/\/+$/, "");
const RESET_PASSWORD_URL = `${PORTAL_BASE_URL}/reset-password`;

// --- CORS (mirrors sundial-sf-update: localhost + *.vercel.app; GET/POST/PATCH) ---
function corsHeaders(origin) {
  const allowOrigin = isAllowedOrigin(origin) ? origin : "http://localhost:5173";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    Vary: "Origin",
  };
}

// --- small helpers ---------------------------------------------------------
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const trimStr = (v) => (v == null ? "" : String(v).trim());
function isEmailShape(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
// Supabase "email already registered" detection (create + invite both 422 on dupes).
function isAlreadyRegistered(error) {
  const m = (error?.message || "").toLowerCase();
  return (
    error?.status === 422 ||
    m.includes("already been registered") ||
    m.includes("already registered") ||
    m.includes("already exists")
  );
}

// PATCH /admin/users/{id} — pull {id} from the path.
function extractUserId(event) {
  const pp = event?.pathParameters || {};
  if (pp.id) return pp.id;
  const path = event?.rawPath || event?.path || "";
  const m = path.match(/\/admin\/users\/([^/?]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// --- authorization gate: identity + superAdmin + tenant --------------------
async function requireSuperAdmin(headers, cors) {
  let identity;
  try {
    identity = await resolveIdentity(headers["authorization"]);
  } catch (err) {
    const m = mapIdentityError(err?.code);
    if (m) return { error: jsonResponse(m.status, cors, m.body) };
    throw err; // unexpected -> 500 upstream
  }
  // D-043: Super_Admin__c must be a literal true. Fail closed.
  if (identity.user?.superAdmin !== true) {
    return {
      error: jsonResponse(403, cors, {
        error: "forbidden",
        code: "NOT_SUPER_ADMIN",
      }),
    };
  }
  if (!identity.tenantId) {
    return { error: jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" }) };
  }
  return { identity };
}

// === GET /admin/users ======================================================
async function handleList(identity, cors) {
  const soql =
    `SELECT Id, First_Name__c, Last_Name__c, Email__c, Phone__c, Access_Level__c, ` +
    `Default_Department__c, Active__c, Super_Admin__c, Hierarchy_Level__c, Supabase_User_Id__c ` +
    `FROM ${SF_OBJECT} ` +
    `WHERE Client__c = '${soqlEscapeString(identity.tenantId)}' ` +
    `ORDER BY Last_Name__c, First_Name__c`;
  const rows = await sfQuery(soql);
  const users = (rows || []).map((r) => ({
    id: r.Id,
    firstName: r.First_Name__c ?? null,
    lastName: r.Last_Name__c ?? null,
    email: r.Email__c ?? null,
    phone: r.Phone__c ?? null,
    accessLevel: r.Access_Level__c ?? null,
    defaultDepartment: r.Default_Department__c ?? null,
    active: r.Active__c === true,
    superAdmin: r.Super_Admin__c === true,
    hierarchyLevel: r.Hierarchy_Level__c ?? null,
    // Boolean only — the actual Supabase_User_Id__c value is NEVER returned.
    hasLogin: trimStr(r.Supabase_User_Id__c) !== "",
  }));
  return jsonResponse(200, cors, { users });
}

// Apply (or clear) a Supabase auth ban, with a small retry. A TRANSIENT failure
// here must not leave a deactivated user un-banned, or — worse — a REACTIVATED user
// stuck banned (SF says Active but login fails). ban_duration "none" clears the ban;
// a duration string applies one. Persistent failure is non-fatal (SF Active__c is
// the source of truth) but surfaced to the caller via supabaseBanFailed.
async function setSupabaseBan(supabase, uid, banDuration) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { error } = await supabase.auth.admin.updateUserById(uid, {
        ban_duration: banDuration,
      });
      if (!error) return { ok: true };
      lastErr = error.message;
    } catch (e) {
      lastErr = e?.message || String(e);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
  }
  console.error(`supabase ban/unban failed after retries (ban_duration=${banDuration}):`, lastErr);
  return { ok: false, error: lastErr };
}

// Find an existing Supabase auth user by email (case-insensitive). supabase-js admin
// has no getUserByEmail; listUsers is paginated — fine at Harmon's user scale. Used
// to REUSE an auth user after a partial failure instead of erroring.
async function findAuthUserByEmail(supabase, email) {
  const target = email.toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const users = data?.users || [];
    const found = users.find((u) => (u.email || "").toLowerCase() === target);
    if (found) return found;
    if (users.length < perPage) break; // last page
  }
  return null;
}

// === POST /admin/users =====================================================
async function handleCreate(identity, event, cors) {
  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return jsonResponse(400, cors, { error: "invalid_body", code: "INVALID_BODY" });
  }
  const b = parsed.data;

  // --- validation (field-level) ---
  const errors = {};
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (!email) errors.email = "email is required";
  else if (!isEmailShape(email)) errors.email = "email is not a valid address";
  const firstName = trimStr(b.firstName);
  const lastName = trimStr(b.lastName);
  if (!firstName) errors.firstName = "firstName is required";
  if (!lastName) errors.lastName = "lastName is required";
  const accessLevel = trimStr(b.accessLevel);
  if (!ACCESS_LEVELS.has(accessLevel)) {
    errors.accessLevel = `accessLevel must be one of: ${[...ACCESS_LEVELS].join(", ")}`;
  }
  const defaultDepartment = trimStr(b.defaultDepartment) || null;
  if (defaultDepartment && !DEPARTMENTS.has(defaultDepartment)) {
    errors.defaultDepartment = `defaultDepartment must be one of: ${[...DEPARTMENTS].join(", ")}`;
  }
  const credentialMode = b.credentialMode;
  if (credentialMode !== "invite" && credentialMode !== "password") {
    errors.credentialMode = 'credentialMode must be "invite" or "password"';
  }
  const tempPassword = typeof b.tempPassword === "string" ? b.tempPassword : "";
  if (credentialMode === "password" && tempPassword.length < 8) {
    errors.tempPassword = "tempPassword is required (min 8 chars) for password mode";
  }
  const phone = trimStr(b.phone) || null;

  if (Object.keys(errors).length > 0) {
    return jsonResponse(400, cors, {
      error: "validation_error",
      code: "VALIDATION_ERROR",
      fields: errors,
    });
  }

  // a. Duplicate guard within THIS tenant.
  const dupe = await sfQuery(
    `SELECT Id FROM ${SF_OBJECT} WHERE Email__c = '${soqlEscapeString(email)}' ` +
      `AND Client__c = '${soqlEscapeString(identity.tenantId)}' LIMIT 1`
  );
  if (dupe && dupe.length > 0) {
    return jsonResponse(409, cors, { error: "user_exists", code: "USER_ALREADY_EXISTS" });
  }

  const supabase = await getSupabaseClient();

  // b. Supabase auth user — create fresh, or REUSE an existing one by email (so a
  //    retry after a partial failure re-links instead of erroring).
  let authUserId = null;
  let freshlyCreated = false; // only a FRESH user is deleted on compensation
  let inviteSent = false;
  try {
    const res =
      credentialMode === "invite"
        ? await supabase.auth.admin.inviteUserByEmail(email, { redirectTo: RESET_PASSWORD_URL })
        : await supabase.auth.admin.createUser({
            email,
            password: tempPassword,
            email_confirm: true,
            user_metadata: { must_change_password: true },
          });

    if (res.error) {
      if (isAlreadyRegistered(res.error)) {
        const existing = await findAuthUserByEmail(supabase, email);
        if (!existing) throw new Error(res.error.message);
        authUserId = existing.id; // reuse — not freshly created
      } else {
        console.error("supabase auth create failed:", res.error.message);
        return jsonResponse(502, cors, {
          error: "supabase_create_failed",
          code: "SUPABASE_CREATE_FAILED",
          message: res.error.message,
        });
      }
    } else {
      authUserId = res.data?.user?.id ?? null;
      freshlyCreated = true;
      if (credentialMode === "invite") inviteSent = true;
    }
  } catch (e) {
    console.error("supabase auth step threw:", e?.message || String(e));
    return jsonResponse(502, cors, {
      error: "supabase_create_failed",
      code: "SUPABASE_CREATE_FAILED",
    });
  }
  if (!authUserId) {
    return jsonResponse(502, cors, {
      error: "supabase_create_failed",
      code: "SUPABASE_CREATE_FAILED",
      message: "Supabase returned no auth user id.",
    });
  }

  // c. Create Sundial_User__c. Client__c is force-stamped from the token; the auth
  //    user id is set internally (never from request input).
  const fields = {
    First_Name__c: firstName,
    Last_Name__c: lastName,
    Email__c: email,
    Access_Level__c: accessLevel,
    Hierarchy_Level__c: DEFAULT_HIERARCHY_LEVEL, // required field; base default (see const)
    Active__c: true,
    Supabase_User_Id__c: authUserId,
    Client__c: identity.tenantId,
  };
  if (phone) fields.Phone__c = phone;
  if (defaultDepartment) fields.Default_Department__c = defaultDepartment;

  try {
    const created = await sfCreateRecord(SF_OBJECT, fields);
    const resp = { id: created.id, email, credentialMode };
    if (inviteSent) resp.inviteSent = true;
    return jsonResponse(201, cors, resp);
  } catch (sfErr) {
    // Compensating action: delete the FRESH auth user so we don't orphan it. Never
    // delete a reused (pre-existing) user. If deletion also fails, surface loudly.
    console.error("sundial_user create failed:", sfErr?.message, sfErr?.sfBody || "");
    let orphanAuthUser = false;
    if (freshlyCreated) {
      try {
        const { error: delErr } = await supabase.auth.admin.deleteUser(authUserId);
        if (delErr) {
          orphanAuthUser = true;
          console.error("compensating deleteUser FAILED — orphaned auth user:", delErr.message);
        }
      } catch (de) {
        orphanAuthUser = true;
        console.error("compensating deleteUser THREW — orphaned auth user:", de?.message || String(de));
      }
    }
    const body = { error: "sf_create_failed", code: "SF_CREATE_FAILED" };
    if (orphanAuthUser) body.orphanAuthUser = true;
    return jsonResponse(502, cors, body);
  }
}

// === PATCH /admin/users/{id} ===============================================
async function handleUpdate(identity, event, cors) {
  const id = extractUserId(event);
  if (!id) return jsonResponse(400, cors, { error: "missing_id", code: "MISSING_ID" });

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return jsonResponse(400, cors, { error: "invalid_body", code: "INVALID_BODY" });
  }
  const b = parsed.data;

  // Explicitly reject disallowed fields (never mass-assignable here).
  const DISALLOWED = [
    "superAdmin", "super_admin", "Super_Admin__c",
    "email", "Email__c",
    "clientId", "Client__c",
    "supabaseUserId", "Supabase_User_Id__c",
    "hierarchyLevel", "Hierarchy_Level__c",
    "id",
  ];
  const rejected = DISALLOWED.filter((k) => hasOwn(b, k));
  if (rejected.length > 0) {
    return jsonResponse(400, cors, {
      error: "field_not_allowed",
      code: "FIELD_NOT_ALLOWED",
      fields: rejected,
    });
  }

  // Whitelist + validate.
  const errors = {};
  const fields = {};
  if (hasOwn(b, "firstName")) {
    const v = trimStr(b.firstName);
    if (!v) errors.firstName = "firstName cannot be empty";
    else fields.First_Name__c = v;
  }
  if (hasOwn(b, "lastName")) {
    const v = trimStr(b.lastName);
    if (!v) errors.lastName = "lastName cannot be empty";
    else fields.Last_Name__c = v;
  }
  if (hasOwn(b, "phone")) {
    fields.Phone__c = trimStr(b.phone) || null; // "" clears the field
  }
  if (hasOwn(b, "accessLevel")) {
    const v = trimStr(b.accessLevel);
    if (!ACCESS_LEVELS.has(v)) errors.accessLevel = "invalid accessLevel";
    else fields.Access_Level__c = v;
  }
  if (hasOwn(b, "defaultDepartment")) {
    const v = trimStr(b.defaultDepartment);
    if (v && !DEPARTMENTS.has(v)) errors.defaultDepartment = "invalid defaultDepartment";
    else fields.Default_Department__c = v || null;
  }
  let activeChange = null;
  if (hasOwn(b, "active")) {
    if (typeof b.active !== "boolean") errors.active = "active must be a boolean";
    else activeChange = b.active;
  }

  if (Object.keys(errors).length > 0) {
    return jsonResponse(400, cors, {
      error: "validation_error",
      code: "VALIDATION_ERROR",
      fields: errors,
    });
  }
  if (Object.keys(fields).length === 0 && activeChange === null) {
    return jsonResponse(400, cors, { error: "no_fields", code: "NO_FIELDS" });
  }

  // Self-deactivation guard — never let a Super Admin lock themselves out.
  if (activeChange === false && id === identity.user.id) {
    return jsonResponse(400, cors, {
      error: "cannot_deactivate_self",
      code: "CANNOT_DEACTIVATE_SELF",
    });
  }

  // Tenant pre-check FIRST (also fetch the auth user id for the ban step). A record
  // outside the caller's tenant is indistinguishable from missing -> 404.
  const owned = await sfQuery(
    `SELECT Id, Supabase_User_Id__c FROM ${SF_OBJECT} ` +
      `WHERE Id = '${soqlEscapeString(id)}' ` +
      `AND Client__c = '${soqlEscapeString(identity.tenantId)}' LIMIT 1`
  );
  if (!owned || owned.length === 0) {
    return jsonResponse(404, cors, { error: "not_found", code: "RECORD_NOT_FOUND" });
  }
  const recordId = owned[0].Id;
  const uid = trimStr(owned[0].Supabase_User_Id__c);

  if (activeChange !== null) fields.Active__c = activeChange;

  // Salesforce is the source of truth — apply it first.
  try {
    await sfUpdateRecord(SF_OBJECT, recordId, fields);
  } catch (sfErr) {
    console.error("sundial_user update failed:", sfErr?.message, sfErr?.sfBody || "");
    return jsonResponse(502, cors, { error: "sf_update_failed", code: "SF_UPDATE_FAILED" });
  }

  // Supabase ban/unban is defense-in-depth (kills live supabase-direct sessions,
  // e.g. comments RLS). Only when `active` changed AND the user has a login. A ban
  // failure does NOT fail the request — SF already changed; we flag it.
  let supabaseBanFailed = false;
  if (activeChange !== null && uid) {
    const supabase = await getSupabaseClient();
    const res = await setSupabaseBan(supabase, uid, activeChange ? "none" : BAN_DURATION);
    supabaseBanFailed = !res.ok;
  }

  const resp = { success: true, id: recordId };
  if (supabaseBanFailed) resp.supabaseBanFailed = true;
  return jsonResponse(200, cors, resp);
}

// --- handler ---------------------------------------------------------------
export const handler = async (event) => {
  const method = httpMethod(event);
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);

  if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  try {
    // AUTH GATE on every route: valid token + superAdmin. Fail closed.
    const gate = await requireSuperAdmin(headers, cors);
    if (gate.error) return gate.error;
    const { identity } = gate;

    if (method === "GET") return await handleList(identity, cors);
    if (method === "POST") return await handleCreate(identity, event, cors);
    if (method === "PATCH") return await handleUpdate(identity, event, cors);

    return jsonResponse(405, cors, {
      error: "method_not_allowed",
      code: "METHOD_NOT_ALLOWED",
    });
  } catch (err) {
    console.error("user-admin unexpected error:", err?.message || String(err));
    return jsonResponse(500, cors, { error: "server_error" });
  }
};
