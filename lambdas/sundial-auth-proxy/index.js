// sundial-auth-proxy — GET /auth/me
//
// Verifies the caller's Supabase access token, resolves the matching
// Sundial_User__c record, and returns the user's identity + tenant scope.
// Identity resolution now lives in lib/identity.js (shared with future Lambdas);
// this handler only maps the resolved identity (or its typed errors) to HTTP.
//
// Value-safety: never logs or returns the token, secrets, or key material. Auth
// failures return 401; verification details are logged to CloudWatch only.
//
// See docs/api-endpoints.md (GET /auth/me).

import { resolveIdentity } from "../../lib/identity.js";
import { profileScopeColumns } from "../../lib/access.js";
import { getSupabaseClient } from "../../lib/supabase.js";

// --- CORS ------------------------------------------------------------------

// localhost dev origin + the production portal domain are static; Vercel deploys
// (preview + prod, incl. the harmon-crm.vercel.app redirect) match by host.
const STATIC_ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "https://sundial.harmonelectric.net",
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (STATIC_ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const u = new URL(origin);
    // Any https://*.vercel.app (covers production + preview deploys).
    if (
      u.protocol === "https:" &&
      (u.hostname === "vercel.app" || u.hostname.endsWith(".vercel.app"))
    ) {
      return true;
    }
  } catch {
    // Not a parseable origin — fall through to disallowed.
  }
  return false;
}

function corsHeaders(origin) {
  // Echo the caller's origin when allowed; otherwise fall back to localhost so
  // we never reflect an untrusted origin.
  const allowOrigin = isAllowedOrigin(origin)
    ? origin
    : "http://localhost:5173";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    Vary: "Origin",
  };
}

// --- helpers ---------------------------------------------------------------

// API Gateway header casing varies; normalize keys to lowercase for lookup.
function normalizeHeaders(rawHeaders) {
  const out = {};
  if (rawHeaders && typeof rawHeaders === "object") {
    for (const [k, v] of Object.entries(rawHeaders)) {
      out[k.toLowerCase()] = v;
    }
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

// Map a typed identity error code to the exact HTTP response /auth/me returns
// today. Returns null for an unrecognized error (handled as 500 by the caller).
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

// --- profile upsert (additive side effect) ---------------------------------
// Keep the caller's public.profiles row current on every successful /auth/me so
// Supabase RLS (auth.uid() = profiles.id) can resolve tenant/role for the
// upcoming comments feature. Uses the SERVICE-ROLE client (only it may write
// profiles under RLS). This is a pure side effect — it never affects the HTTP
// response, and it NEVER throws: all errors are caught and logged so a profile
// write failure cannot break login. Value-safe: logs no tokens/secrets/PII bodies.
async function upsertProfile(identity) {
  try {
    const u = identity?.user || {};
    // id MUST be the auth.users UUID (the verified token sub) for RLS to match.
    const authUserId = identity?.authUserId;
    if (!authUserId) {
      console.error("profiles upsert skipped: missing verified auth user id.");
      return;
    }

    const fullName =
      [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || null;

    // D-064 §5.2: the three SERVER-OWNED scope columns. This upsert is their ONLY
    // writer, and it runs under the service role. There is no client `update` grant on
    // profiles and none is added -- see sql/sundial_access_p1_profiles_revoke.sql for
    // why that matters more now than it did yesterday: RLS is row-level, so one
    // permissive update policy would let a session rewrite its own access_scope, which
    // is the column Phase 1b's record_visible() reads.
    //
    // Derived by lib/access.js from the identity, never taken from request input.
    const scopeColumns = profileScopeColumns(identity.access);

    const row = {
      id: authUserId, // = auth.users uuid (token sub) — the RLS key
      tenant_id: identity.tenantId ?? null, // Salesforce Client record id
      sundial_user_id: u.id ?? null, // Sundial_User__c Id
      role: u.hierarchyLevel ?? null, // Hierarchy_Level__c, stored as-is
      email: u.email ?? null,
      full_name: fullName,
      // access_scope | access_level | dealer_sf_id. Written on EVERY /auth/me, so a
      // user re-levelled in Salesforce carries the new scope from their next request
      // rather than from a scheduled job -- there is no cache to invalidate here.
      ...scopeColumns,
      updated_at: new Date().toISOString(),
    };

    const supabase = await getSupabaseClient();
    const { error } = await supabase
      .from("profiles")
      .upsert(row, { onConflict: "id" });
    if (error) {
      // Log the message only (no row/PII dump) and continue — do not fail login.
      console.error("profiles upsert error:", error.message);
    }
  } catch (e) {
    console.error("profiles upsert threw:", e?.message || String(e));
  }
}

// --- handler ---------------------------------------------------------------

export const handler = async (event) => {
  // Support both REST (v1, httpMethod) and HTTP API (v2, requestContext.http).
  const method =
    event?.requestContext?.http?.method || event?.httpMethod || "GET";
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);

  // CORS preflight.
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  try {
    // Resolve identity (verify token + load Sundial_User__c + tenant).
    let identity;
    try {
      identity = await resolveIdentity(headers["authorization"]);
    } catch (err) {
      const mapped = mapIdentityError(err?.code);
      if (mapped) return jsonResponse(mapped.status, cors, mapped.body);
      throw err; // unexpected -> 500 below
    }

    // Additive side effect (does NOT change the response): keep the caller's
    // public.profiles row current for Supabase RLS. Awaited so the write finishes
    // before the Lambda returns/freezes; upsertProfile swallows all errors so a
    // profile-write failure can never break login.
    await upsertProfile(identity);

    // Success. ADDITIVE: the existing `user` and `tenant` keys are byte-identical to
    // what this endpoint returned before, so an un-updated client is unaffected.
    //
    // `user.access` (D-064 §1.3) is new. The client REFLECTS it -- hides navigation
    // and buttons the server would refuse anyway -- and never DECIDES from it. That
    // asymmetry is what makes shipping it before the enforcement safe in both
    // directions: a client that ignores it renders what it always did and the server
    // has not started refusing anything yet; a client that honours it renders a subset
    // of what the server already agreed to send.
    return jsonResponse(200, cors, {
      user: { ...identity.user, access: identity.access },
      tenant: { clientId: identity.tenantId },
    });
  } catch (err) {
    // Real error to CloudWatch only; generic body to the caller.
    console.error("auth/me unexpected error:", err?.message || String(err));
    return jsonResponse(500, cors, { error: "server_error" });
  }
};
