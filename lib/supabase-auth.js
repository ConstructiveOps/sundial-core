// Supabase access-token verification for Sundial Lambda functions.
//
// Verifies the Supabase-issued JWT using the project's published JWKS
// (asymmetric ES256). The JWKS set is built once in module scope so warm Lambda
// invocations reuse jose's internal key cache rather than refetching.
//
// Value-safety: never logs or returns the token, its signature, or key material.
// On failure the underlying reason is logged to CloudWatch only; the caller gets
// a typed error with a generic message.

import { createRemoteJWKSet, jwtVerify } from "jose";

// Confirmed project ref for the Harmon Supabase project.
const SUPABASE_PROJECT_REF = "qfsdpkwxahakegjnyijj";
const SUPABASE_BASE = `https://${SUPABASE_PROJECT_REF}.supabase.co`;

// Supabase signs auth tokens with this issuer.
export const SUPABASE_ISSUER = `${SUPABASE_BASE}/auth/v1`;

// JWKS endpoint (ES256 / EC key confirmed present).
const JWKS_URL = new URL(`${SUPABASE_ISSUER}/.well-known/jwks.json`);

// Module-scope remote JWKS. jose caches the fetched keys internally and only
// refetches on a cache miss / rotation, so this survives warm invocations.
const jwks = createRemoteJWKSet(JWKS_URL);

/**
 * Typed auth error. `code` is one of:
 *  - AUTH_NO_TOKEN     : no / malformed Authorization header
 *  - AUTH_INVALID_TOKEN: signature/issuer/expiry/alg verification failed
 */
export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/**
 * Verify the bearer token from an Authorization header.
 *
 * @param {string|undefined} authHeader - The raw Authorization header value.
 * @returns {Promise<object>} The verified JWT claims (sub, email, aud, ...).
 * @throws {AuthError} AUTH_NO_TOKEN or AUTH_INVALID_TOKEN.
 */
export async function verifySupabaseToken(authHeader) {
  if (!authHeader || typeof authHeader !== "string") {
    throw new AuthError("AUTH_NO_TOKEN", "Missing Authorization header.");
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new AuthError("AUTH_NO_TOKEN", "Malformed Authorization header.");
  }

  const token = match[1].trim();
  if (!token) {
    throw new AuthError("AUTH_NO_TOKEN", "Empty bearer token.");
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: SUPABASE_ISSUER,
      algorithms: ["ES256"], // restrict to the asymmetric alg; reject anything else
    });

    // Audience is read but intentionally NOT hard-failed on for now.
    // (Supabase typically sets aud to "authenticated".)
    const audience = payload.aud ?? null;
    void audience;

    return payload;
  } catch (err) {
    // Log the real reason server-side only; never leak it to the HTTP body.
    console.error(
      "Supabase token verification failed:",
      err?.code || err?.message || String(err)
    );
    throw new AuthError("AUTH_INVALID_TOKEN", "Token verification failed.");
  }
}
