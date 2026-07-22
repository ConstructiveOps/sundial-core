// Shared portal-identity resolution for Sundial Lambda functions.
//
// Verifies the caller's Supabase token, resolves the matching Sundial_User__c
// record, and returns a normalized identity with the resolved tenant id. This is
// the single place that turns "an incoming request" into "who this is and which
// tenant they belong to" — every downstream Lambda (auth-proxy, sf-query, ...)
// should scope its work to the returned tenantId.
//
// Value-safety: never logs or returns the token, secrets, or key material.

import { sfQuery, soqlEscapeString } from "./salesforce.js";
import { verifySupabaseToken } from "./supabase-auth.js";

// The Sundial_User__c fields the portal identity depends on. Kept in one place
// so auth-proxy and any future caller select an identical set.
// Client__r.Name traverses the Client__c lookup to Sundial_Tenant__c to read the
// tenant slug (a human label only; the isolation key stays the Client record id).
const USER_FIELDS =
  "Id, First_Name__c, Last_Name__c, Email__c, Phone__c, " +
  "Hierarchy_Level__c, Client__c, Client__r.Name, Parent_User__c, Active__c, Supabase_User_Id__c";

/**
 * Typed identity error. `code` is one of:
 *  - AUTH_NO_TOKEN / AUTH_INVALID_TOKEN (also thrown by verifySupabaseToken)
 *  - NO_SUNDIAL_USER : verified token has no matching Sundial_User__c
 *  - USER_INACTIVE   : matching record exists but Active__c is false
 */
export class IdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
  }
}

/**
 * Resolve the portal identity for an incoming Authorization header.
 *
 * @param {string|undefined} authHeader
 * @returns {Promise<{ user: object, tenantId: string|null, tenantSlug: string|null }>}
 *   user: { id, firstName, lastName, email, phone, hierarchyLevel,
 *           parentUserId, supabaseUserId }
 *   tenantId: the Client__c value (Salesforce Client record id) — the ONLY
 *             source of tenant scoping downstream. This is the isolation key.
 *   tenantSlug: Client__r.Name (e.g. "harmon") — a human label ONLY, never used
 *             for isolation. Used to populate the cache's tenant_id column.
 * @throws {AuthError|IdentityError} typed errors (see codes above).
 */
export async function resolveIdentity(authHeader) {
  // Verify the Supabase ES256 token. Throws AuthError AUTH_NO_TOKEN /
  // AUTH_INVALID_TOKEN, which carry a `.code` just like IdentityError.
  const claims = await verifySupabaseToken(authHeader);

  if (!claims.sub) {
    throw new IdentityError("AUTH_INVALID_TOKEN", "Verified token has no subject.");
  }

  // The sub is bound through soqlEscapeString — never raw-concatenated.
  const escapedSub = soqlEscapeString(claims.sub);
  const soql =
    `SELECT ${USER_FIELDS} FROM Sundial_User__c ` +
    `WHERE Supabase_User_Id__c = '${escapedSub}' LIMIT 1`;

  const records = await sfQuery(soql);

  if (!records || records.length === 0) {
    throw new IdentityError(
      "NO_SUNDIAL_USER",
      "No Sundial_User__c record for this identity."
    );
  }

  const r = records[0];

  if (r.Active__c === false) {
    throw new IdentityError("USER_INACTIVE", "Sundial_User__c is inactive.");
  }

  return {
    user: {
      id: r.Id,
      firstName: r.First_Name__c ?? null,
      lastName: r.Last_Name__c ?? null,
      email: r.Email__c ?? null,
      phone: r.Phone__c ?? null,
      hierarchyLevel: r.Hierarchy_Level__c ?? null,
      parentUserId: r.Parent_User__c ?? null,
      supabaseUserId: r.Supabase_User_Id__c ?? null,
    },
    // The verified Supabase auth user id — the token `sub`, i.e. the authoritative
    // auth.users UUID. Surfaced from the VERIFIED CLAIM (not read back from
    // Salesforce) so callers that key on the auth user — e.g. the public.profiles
    // upsert whose `id` must satisfy RLS `auth.uid() = id` — use the exact JWT
    // subject. (SOQL string equality is case-insensitive, so the Salesforce field
    // could differ in casing; this is the canonical source.) Additive field.
    authUserId: claims.sub,
    // The resolved tenant id (Salesforce Client record id). This is the single
    // source of tenant scoping — the isolation key used in every query.
    tenantId: r.Client__c ?? null,
    // Human-readable tenant slug from Sundial_Tenant__c.Name (e.g. "harmon").
    // Label only — never used for isolation. r.Client__r is null if no Client.
    tenantSlug: r.Client__r?.Name ?? null,
  };
}
