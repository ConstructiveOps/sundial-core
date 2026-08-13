// lib/http.js — shared HTTP/CORS helpers for the Sundial file API Lambdas.
//
// Mirrors the inline CORS/JSON/identity-error conventions the sf-query and
// sf-update Lambdas use, factored out so the four file Lambdas share one copy.
// (The existing Lambdas keep their own inline versions — unchanged.)
//
// Value-safety: never logs tokens/secrets; body parsing never echoes raw input.

// localhost dev origin + the production portal domain are static; Vercel deploys
// (preview + prod, incl. the harmon-crm.vercel.app redirect) match by host below.
const STATIC_ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "https://sundial.harmonelectric.net",
]);

export function isAllowedOrigin(origin) {
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

export function corsHeaders(origin) {
  const allowOrigin = isAllowedOrigin(origin) ? origin : "http://localhost:5173";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    Vary: "Origin",
  };
}

export function normalizeHeaders(rawHeaders) {
  const out = {};
  if (rawHeaders && typeof rawHeaders === "object") {
    for (const [k, v] of Object.entries(rawHeaders)) out[k.toLowerCase()] = v;
  }
  return out;
}

export function jsonResponse(statusCode, cors, bodyObj) {
  return {
    statusCode,
    headers: { ...cors, "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  };
}

// Same identity-error -> HTTP mapping the read/write Lambdas use.
export function mapIdentityError(code) {
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

// Parse a JSON request body that API Gateway may deliver base64-encoded
// (isBase64Encoded). Returns { ok:true, data } or { ok:false }. Handles the body
// already being an object (defensive), decodes base64 BEFORE JSON.parse, trims.
export function parseJsonBody(event) {
  let raw = event?.body;
  if (raw != null && typeof raw === "object") return { ok: true, data: raw };
  if (raw == null) return { ok: false };
  if (event?.isBase64Encoded) {
    try {
      raw = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      return { ok: false };
    }
  }
  raw = String(raw).trim();
  if (raw === "") return { ok: false };
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

export function httpMethod(event) {
  return event?.requestContext?.http?.method || event?.httpMethod || "GET";
}
