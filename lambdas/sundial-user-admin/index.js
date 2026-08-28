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

const DEALER_OBJECT = "Sundial_Dealer__c";

/**
 * Resolve a caller-supplied dealerId to an ACTIVE dealer in the caller's tenant.
 *
 * @returns {{ok:true, id, name} | {ok:false, code, message}}
 *
 * Validated BY ID against Salesforce, never trusted from the request. Three separate
 * refusals, and they are deliberately indistinguishable to the caller — unknown id,
 * wrong tenant, and inactive all return the same code. A distinct "that dealer exists
 * but belongs to someone else" would confirm the existence of another tenant's records
 * to anyone willing to guess ids.
 *
 * ⚠️ INACTIVE IS A REFUSAL, NOT A WARNING. access-model.md §2.1 makes deactivating a
 * dealer the switch that turns off their people's access: resolveScope() sends a sales
 * user with an inactive dealer to scope `none`. Provisioning a rep INTO an inactive
 * dealer would therefore create an account that authenticates and then sees nothing —
 * a user who looks provisioned, cannot work, and whose problem is invisible from the
 * admin screen that created them.
 */
async function resolveDealer(dealerId, tenantId) {
  const id = trimStr(dealerId);
  if (!id) return { ok: false, code: "DEALER_NOT_FOUND", message: "dealerId is empty" };

  // SHAPE-CHECK BEFORE QUERYING. Salesforce rejects a malformed value in an `Id =`
  // filter with MALFORMED_ID rather than returning zero rows, so sfQuery THROWS and the
  // handler's catch turns it into a 500. Found by the provisioning e2e sending a
  // deliberately bogus id and getting 500 where 400 was specified: a caller mistake
  // must not read as a server fault. 15 or 18 case-sensitive alphanumerics, the same
  // shape check sundial-sf-query applies to ?parentId=.
  if (!/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(id)) {
    return {
      ok: false,
      code: "DEALER_NOT_FOUND",
      message: "dealerId is not a Salesforce record id.",
    };
  }

  // A query FAILURE denies too. "Could not establish which dealer this is" is not
  // "any dealer will do" -- the same fail-closed rule the read gates use.
  let rows;
  try {
    rows = await sfQuery(
      `SELECT Id, Name, Active__c FROM ${DEALER_OBJECT} ` +
        `WHERE Id = '${soqlEscapeString(id)}' ` +
        `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
    );
  } catch (e) {
    console.error("dealer lookup failed:", e?.message || String(e));
    return {
      ok: false,
      code: "DEALER_NOT_FOUND",
      message: "dealerId could not be validated.",
    };
  }
  if (!rows || rows.length === 0) {
    return {
      ok: false,
      code: "DEALER_NOT_FOUND",
      message: "dealerId is not a dealer in this tenant.",
    };
  }
  if (rows[0].Active__c !== true) {
    return {
      ok: false,
      code: "DEALER_NOT_FOUND",
      message:
        `Dealer "${rows[0].Name}" is INACTIVE. A sales user in an inactive dealer ` +
        `resolves to no access at all (access-model.md §2.1), so they would be able to ` +
        `sign in and see nothing. Reactivate the dealer first, or choose another.`,
    };
  }
  return { ok: true, id: rows[0].Id, name: rows[0].Name ?? null };
}

/**
 * ⚠️ A dealerId on a NON-SALES level is a 400, not a silent drop.
 *
 * The same reasoning as the SUPER_ADMIN_WITH_SALES_ROLE refusal below: an admin who
 * sends a field and is not told it was ignored believes it was applied. Here they would
 * believe an Executive had been attributed to a dealer. Nothing in the UI would
 * contradict them, because the field simply would not be there on the next read.
 *
 * Only `dealer` and `own` scopes read Dealer__c at all (§1.2), so attributing a
 * tenant-wide role to a dealer is not merely useless — it is a statement about the
 * access model that is not true.
 */
const DEALER_NOT_APPLICABLE = {
  error: "dealer_not_applicable",
  code: "DEALER_NOT_APPLICABLE",
  message:
    "dealerId applies only to the sales access levels (Sales Rep, Sales Dealer). " +
    "Tenant-wide roles see every record in the tenant and are never scoped by dealer.",
};

/** The refusal when a sales role would end up with no dealer. */
const DEALER_REQUIRED = {
  error: "dealer_required",
  code: "DEALER_REQUIRED_FOR_SALES_ROLE",
  message:
    "A Sales Rep or Sales Dealer must belong to a dealer: their record visibility is " +
    "defined by it. A sales user with no dealer resolves to no access at all " +
    "(access-model.md §1.2), so they could sign in and see nothing.",
};

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
    `Default_Department__c, Active__c, Super_Admin__c, Hierarchy_Level__c, Supabase_User_Id__c, ` +
    `Dealer__c, Dealer__r.Name ` +
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
    // D-064: the dealer this user sells for. Null on Harmon staff, who are never
    // scoped by one. The NAME travels with the id so the list can render without a
    // second lookup per row.
    dealerId: r.Dealer__c ?? null,
    dealerName: r.Dealer__r?.Name ?? null,
    // Boolean only — the actual Supabase_User_Id__c value is NEVER returned.
    hasLogin: trimStr(r.Supabase_User_Id__c) !== "",
  }));

  // The dealer options, alongside the users.
  //
  // ⚠️ ALSO available as GET /admin/dealers — this copy exists so the create/edit modal
  // works with NO API Gateway change. A new route is a manual console step (Actions →
  // Deploy API), and dealer onboarding is blocked until reps can be created with a
  // dealer. The modal already fetches this list when it opens, so riding along costs one
  // extra SOQL on a low-frequency admin screen and removes a deployment dependency from
  // the critical path. Both sources are the same function; they cannot disagree.
  const dealers = await listActiveDealers(identity.tenantId);
  return jsonResponse(200, cors, { users, dealers });
}

/** Active dealers in a tenant, as {id, name}, alphabetical. */
async function listActiveDealers(tenantId) {
  const rows = await sfQuery(
    `SELECT Id, Name FROM ${DEALER_OBJECT} ` +
      `WHERE Client__c = '${soqlEscapeString(tenantId)}' AND Active__c = true ` +
      `ORDER BY Name`
  );
  return (rows || []).map((d) => ({ id: d.Id, name: d.Name ?? null }));
}

// === GET /admin/dealers ====================================================
// Super-admin gated like every other route on this Lambda (requireSuperAdmin runs
// first). Active dealers only: the dropdown must not offer a dealer that would leave
// the new user with no access (§2.1).
//
// ⚠️ DELIBERATELY NOT IN sundial-sf-query's OBJECT_ALLOWLIST. That allowlist is the
// read surface every portal user reaches; dealers are an ADMIN lookup, and putting them
// there would expose the tenant's full dealer roster to every authenticated caller for
// the sake of one dropdown on one screen.
async function handleDealers(identity, cors) {
  return jsonResponse(200, cors, { dealers: await listActiveDealers(identity.tenantId) });
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

  // --- D-064: the dealer, required for sales roles and refused for the rest ---
  const isSalesRole = SALES_ACCESS_LEVELS.has(accessLevel);
  const dealerIdRaw = trimStr(b.dealerId);
  let dealer = null;
  if (isSalesRole) {
    if (!dealerIdRaw) return jsonResponse(400, cors, DEALER_REQUIRED);
    const resolved = await resolveDealer(dealerIdRaw, identity.tenantId);
    if (!resolved.ok) {
      return jsonResponse(400, cors, {
        error: "invalid_dealer",
        code: resolved.code,
        message: resolved.message,
      });
    }
    dealer = resolved;
  } else if (dealerIdRaw) {
    return jsonResponse(400, cors, DEALER_NOT_APPLICABLE);
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
  // Validated by id against an ACTIVE dealer in this tenant above — never the raw
  // request value, and never present for a tenant-wide role.
  if (dealer) fields.Dealer__c = dealer.id;

  try {
    const created = await sfCreateRecord(SF_OBJECT, fields);
    const resp = { id: created.id, email, credentialMode };
    if (dealer) {
      resp.dealerId = dealer.id;
      resp.dealerName = dealer.name;
    }
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
  // D-064: dealerId is accepted here, but WHETHER it is required depends on the
  // access level this PATCH leaves the user at — which may come from the body or may
  // already be on the record. Resolved after the record is read, below.
  const dealerIdProvided = hasOwn(b, "dealerId");
  const dealerIdRaw = dealerIdProvided ? trimStr(b.dealerId) : null;

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
  if (Object.keys(fields).length === 0 && activeChange === null && !dealerIdProvided) {
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
    `SELECT Id, Supabase_User_Id__c, Super_Admin__c, Access_Level__c, Dealer__c FROM ${SF_OBJECT} ` +
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

  // --- D-064: the dealer rule, evaluated against the RESULTING state ----------
  //
  // ⚠️ ORDERED AFTER the super-admin refusal, deliberately. Both can fire on the same
  // request — re-levelling a super admin to Sales Rep is BOTH a forbidden combination
  // and (usually) missing a dealer. The combination is the more specific and more
  // consequential problem: it describes an account that could provision its way out of
  // its own scope, and its message tells the admin to clear Super_Admin__c in Salesforce
  // first. A DEALER_REQUIRED_FOR_SALES_ROLE answer would send them off to pick a dealer
  // for a change that must not happen at all.
  //
  // ⚠️ THE QUESTION IS "WHERE DOES THIS USER END UP", NOT "WHAT DOES THIS BODY SAY".
  // A PATCH that sets only `accessLevel: "Sales Rep"` carries no dealer and looks
  // harmless; whether it is depends entirely on whether the record already has one.
  // Checking the body alone would let a Manager become a Sales Rep with no dealer —
  // an account that signs in and sees nothing, created by a request that mentioned
  // neither dealers nor access.
  const resultingLevel = hasOwn(fields, "Access_Level__c")
    ? fields.Access_Level__c
    : trimStr(owned[0].Access_Level__c);
  const resultingIsSales = SALES_ACCESS_LEVELS.has(resultingLevel);
  const existingDealerId = trimStr(owned[0].Dealer__c);

  if (dealerIdProvided && !resultingIsSales) {
    // Same reasoning as create: silently dropping it would leave the admin believing
    // a tenant-wide user had been attributed to a dealer.
    return jsonResponse(400, cors, DEALER_NOT_APPLICABLE);
  }

  if (resultingIsSales) {
    // Explicitly clearing the dealer of someone who stays in a sales role is the same
    // refusal as never giving them one.
    const willHaveDealer = dealerIdProvided ? dealerIdRaw : existingDealerId;
    if (!willHaveDealer) return jsonResponse(400, cors, DEALER_REQUIRED);
    if (dealerIdProvided) {
      const resolved = await resolveDealer(dealerIdRaw, identity.tenantId);
      if (!resolved.ok) {
        return jsonResponse(400, cors, {
          error: "invalid_dealer",
          code: resolved.code,
          message: resolved.message,
        });
      }
      fields.Dealer__c = resolved.id;
    }
  }
  // Moving to a tenant-wide role LEAVES Dealer__c as it is, deliberately. It is unread
  // for those scopes (§1.2), so it changes nothing about access; clearing it would
  // discard the attribution history, and would silently un-attribute someone who is
  // later moved back into a sales role.

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

    // GET /admin/dealers — the dropdown's source. Matched on the PATH, because this
    // Lambda serves several routes and they are otherwise distinguished by method
    // alone. (A GET that is not /admin/dealers is the user list, as before.)
    const path = event?.rawPath || event?.path || "";
    if (method === "GET" && /\/admin\/dealers\/?$/.test(path)) {
      return await handleDealers(identity, cors);
    }
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
