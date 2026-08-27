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
export const ACCESS_LEVELS = new Set([
  "Executive", "Manager", "Admin", "Sales Dealer", "Sales Rep", "Technician",
]);
const DEPARTMENTS = new Set([
  "Residential Solar", "Roofing", "Service", "Commercial",
]);
// ~100 years — an effectively permanent Supabase auth ban for deactivated users.
const BAN_DURATION = "876000h";
// Hierarchy_Level__c is REQUIRED on Sundial_User__c and is DERIVED from the access
// level -- never taken from request input, and never a flat default.
//
// THE BUG THIS REPLACES. Until 2026-08-27 this was a constant, `"Sales Rep"`, stamped
// on EVERY user this endpoint created regardless of the access level the admin chose.
// The TEMP guard in `sundial-sf-query` restricts any caller whose Hierarchy_Level__c
// is exactly that string to one hardcoded rep's records. So every user created through
// Manage Users and not hand-corrected in Salesforce afterwards was served a Sales
// Rep's view of Customer and Solar whatever their real role -- a NARROWING, which is
// why it surfaced as "why can this person not see anything" rather than as a leak.
// docs/access-model-phase0-user-audit.md is the count.
//
// The picklist is RESTRICTED (Client, Dealer, Manager, Sales Rep, Sales Manager,
// Technician), so an unmapped value is not a silent no-op -- Salesforce rejects the
// insert with INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST. Every value this map can
// produce must exist in it; a describe is the only way to know, and the unit tests
// pin the three outputs so a picklist edit that removes one fails loudly here.
//
// access-model.md §10: the field is kept, written, and read by nothing once the TEMP
// guard is retired. It is derived rather than dropped only because it is required.
export const HIERARCHY_BY_ACCESS_LEVEL = {
  "Sales Rep": "Sales Rep",
  "Sales Dealer": "Sales Manager",
};
export const DEFAULT_HIERARCHY_LEVEL = "Client";

/**
 * Derive Hierarchy_Level__c from Access_Level__c.
 *
 * Everything that is not a sales role collapses to `Client` -- Executive, Admin,
 * Manager and Technician alike. That is deliberate and lossy: the value is not read
 * by anything, so precision here would be decoration. The one thing that matters is
 * that a non-rep never receives `"Sales Rep"`, because that string is what the TEMP
 * guard keys on.
 *
 * An unknown or missing access level also lands on `Client`, the least-privileged
 * value -- fail closed.
 */
export function deriveHierarchyLevel(accessLevel) {
  return HIERARCHY_BY_ACCESS_LEVEL[accessLevel] ?? DEFAULT_HIERARCHY_LEVEL;
}

// The access levels that carry a sales SCOPE (access-model.md §1.2: `dealer` and
// `own`). Super_Admin__c gates Manage Users and implies nothing about scope, so a
// super admin holding one of these would be a row-scoped user who can create users --
// the combination §1.2 says must not exist.
export const SALES_ACCESS_LEVELS = new Set(["Sales Rep", "Sales Dealer"]);

// Base URL of the portal. Invited users are redirected here to set their password.
// Env-configurable so a domain change is a Lambda config update, not a code edit.
// The default tracks the live portal domain (cutover from harmon-crm.vercel.app,
// which now only redirects) so a lost env var still produces a working link.
const PORTAL_BASE_URL = (process.env.PORTAL_BASE_URL || "https://sundial.harmonelectric.net").replace(/\/+$/, "");
const RESET_PASSWORD_URL = `${PORTAL_BASE_URL}/reset-password`;

// --- CORS (shared lib/http.js: localhost + portal domain + *.vercel.app; GET/POST/PATCH) ---
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

  // Super_Admin__c is Salesforce-set only (D-043) and this endpoint has never
  // written it -- a `superAdmin` key in the body is silently ignored on the way to
  // Salesforce. Silently is the problem: an admin who sends it believes they created
  // a super admin, and nothing tells them otherwise.
  //
  // Refuse the combination outright. access-model.md §1.2: a super admin whose access
  // level is a sales role resolves to `own`/`dealer` scope AND can manage users --
  // a row-scoped account that can provision its way out of its own scope. The request
  // is rejected rather than partially honoured, so the caller has to choose which of
  // the two they actually meant.
  //
  // The other door -- PATCHing an existing Salesforce-set super admin DOWN to a sales
  // access level -- is closed too, in handleUpdate, with this same code. That one is
  // the door that actually mattered: this endpoint never writes Super_Admin__c, so a
  // create request asking for it was always a misunderstanding, whereas the PATCH
  // path could genuinely produce the combination out of two individually-sane edits.
  const requestedSuperAdmin =
    b.superAdmin === true || b.superAdmin === "true" ||
    b.Super_Admin__c === true || b.Super_Admin__c === "true";
  if (requestedSuperAdmin && SALES_ACCESS_LEVELS.has(accessLevel)) {
    return jsonResponse(400, cors, {
      error: "invalid_role_combination",
      code: "SUPER_ADMIN_WITH_SALES_ROLE",
      message:
        `A super admin cannot hold the sales access level "${accessLevel}": it would be a ` +
        `record-scoped user who can manage users. Choose a tenant-wide access level ` +
        `(Executive, Admin, Manager), or create the user without super admin. ` +
        `Note that Super_Admin__c is set in Salesforce only and is never written by this endpoint.`,
    });
  }

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
    // DERIVED, never from input. See deriveHierarchyLevel above.
    Hierarchy_Level__c: deriveHierarchyLevel(accessLevel),
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
    else {
      fields.Access_Level__c = v;
      // Re-derive the hierarchy in the SAME patch. Without this, changing someone
      // from Sales Rep to Manager would leave Hierarchy_Level__c = "Sales Rep"
      // behind, and the TEMP guard would go on serving them a rep's records -- the
      // create-time bug reappearing on the update path.
      //
      // `hierarchyLevel` stays in the DISALLOWED list above: it is derived here, not
      // accepted from the caller. Those two facts are not in tension -- the server
      // owns the field, the client may not touch it.
      fields.Hierarchy_Level__c = deriveHierarchyLevel(v);
    }
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

  // Tenant pre-check FIRST (also fetch the auth user id for the ban step, and the
  // target's Super_Admin__c for the role-combination refusal below). A record
  // outside the caller's tenant is indistinguishable from missing -> 404.
  const owned = await sfQuery(
    `SELECT Id, Supabase_User_Id__c, Super_Admin__c FROM ${SF_OBJECT} ` +
      `WHERE Id = '${soqlEscapeString(id)}' ` +
      `AND Client__c = '${soqlEscapeString(identity.tenantId)}' LIMIT 1`
  );
  if (!owned || owned.length === 0) {
    return jsonResponse(404, cors, { error: "not_found", code: "RECORD_NOT_FOUND" });
  }
  const recordId = owned[0].Id;
  const uid = trimStr(owned[0].Supabase_User_Id__c);

  // The OTHER door into the combination handleCreate refuses. Create can only reject
  // a request that ASKS for super admin, and since this endpoint never writes
  // Super_Admin__c that request could only ever have been a misunderstanding. The
  // real way to reach a row-scoped user who can manage users is from the other side:
  // take an existing Salesforce-set super admin and PATCH their access level DOWN to
  // a sales role. Nothing about that request looks wrong in isolation.
  //
  // Refused here with the same code as create, for the same §1.2 reason: `own`/
  // `dealer` scope plus Manage Users is an account that can provision its way out of
  // its own scope. The fix is to clear Super_Admin__c in Salesforce first (it is
  // Salesforce-set only, D-043) and then re-level the user.
  //
  // Read from the RECORD, not from request input -- `superAdmin` is in DISALLOWED and
  // a caller cannot assert it either way.
  const targetIsSuperAdmin = owned[0].Super_Admin__c === true;
  if (targetIsSuperAdmin && hasOwn(fields, "Access_Level__c") &&
      SALES_ACCESS_LEVELS.has(fields.Access_Level__c)) {
    return jsonResponse(400, cors, {
      error: "invalid_role_combination",
      code: "SUPER_ADMIN_WITH_SALES_ROLE",
      message:
        `This user is a super admin and cannot be moved to the sales access level ` +
        `"${fields.Access_Level__c}": it would be a record-scoped user who can manage ` +
        `users. Clear Super_Admin__c in Salesforce first, then change the access level. ` +
        `Note that Super_Admin__c is set in Salesforce only and is never written by this endpoint.`,
    });
  }

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
