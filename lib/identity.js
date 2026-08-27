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
import { resolveScope, accessBlock } from "./access.js";

// The Sundial_User__c fields the portal identity depends on. Kept in one place
// so auth-proxy and any future caller select an identical set.
// Client__r.Name traverses the Client__c lookup to Sundial_Tenant__c to read the
// tenant slug (a human label only; the isolation key stays the Client record id).
// Dealer__r is traversed rather than looked up separately: the dealer's Active__c is
// part of the ACCESS DECISION (an inactive dealer resolves its users to scope `none`,
// docs/access-model.md §2.1), so fetching the id alone would mean either a second
// round-trip per request or an assumption. resolveScope() treats "dealer id present but
// Dealer__r absent" as unresolvable and denies -- so a caller who forgets to select the
// sub-object fails closed rather than silently granting dealer scope.
const USER_FIELDS =
  "Id, First_Name__c, Last_Name__c, Email__c, Phone__c, " +
  "Hierarchy_Level__c, Access_Level__c, Super_Admin__c, Default_Department__c, " +
  "Client__c, Client__r.Name, Parent_User__c, Active__c, Supabase_User_Id__c, " +
  "Dealer__c, Dealer__r.Name, Dealer__r.Active__c, Dealer__r.Is_Internal__c";

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
 * @returns {Promise<{ user: object, access: object, tenantId: string|null, tenantSlug: string|null }>}
 *   user: { id, firstName, lastName, email, phone, hierarchyLevel,
 *           accessLevel, superAdmin, defaultDepartment,
 *           parentUserId, supabaseUserId, dealer }
 *     dealer: { id, name, active, isInternal } or null (D-064). `active` decides
 *             whether this dealer's users see anything at all (§2.1).
 *   access: the resolved AccessContext (D-064 §1.3) —
 *           { level, scope, userId, dealerId, tenantId, dealerActive, dealerInternal,
 *             modules, actions }. scope is tenant | dealer | own | none.
 *           ⚠️ RETURNED, NOT ENFORCED, in Phase 1. Nothing filters on it yet; the
 *           client uses it to hide navigation it would be refused anyway, and a stale
 *           client is safe because it can only render a subset of what the server
 *           already agreed to send (§4.5).
 *     accessLevel: Access_Level__c picklist (UI-tier gating) or null.
 *     superAdmin:  Super_Admin__c === true (strict; gates Manage Users). Salesforce-
 *                  set only — never writable via any endpoint.
 *     defaultDepartment: Default_Department__c (landing page only) or null.
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

  // The dealer sub-object, normalized. NULL when Dealer__c is unset -- which for a
  // sales role means scope `none`, not "all dealers" (§1.2). Both booleans are STRICT
  // (=== true): a missing or non-boolean value must read as false, because `active`
  // is the field that decides whether this dealer's users can see anything.
  const dealer = r.Dealer__c
    ? {
        id: r.Dealer__c,
        name: r.Dealer__r?.Name ?? null,
        active: r.Dealer__r?.Active__c === true,
        isInternal: r.Dealer__r?.Is_Internal__c === true,
      }
    : null;

  const user = {
    id: r.Id,
    firstName: r.First_Name__c ?? null,
    lastName: r.Last_Name__c ?? null,
    email: r.Email__c ?? null,
    phone: r.Phone__c ?? null,
    hierarchyLevel: r.Hierarchy_Level__c ?? null,
    // Access-control fields (UI gating for now; see DECISIONS.md D-043).
    // accessLevel drives which tabs/sections/fields/reports the frontend shows, and
    // as of D-064 it is the ONLY input to row-visibility scope (§1.1).
    accessLevel: r.Access_Level__c ?? null,
    // superAdmin gates the Manage Users surface. STRICT boolean, fail closed:
    // anything other than a literal true (null/undefined/"false"/absent) => false.
    // Set ONLY manually in Salesforce; never writable through any Sundial endpoint.
    superAdmin: r.Super_Admin__c === true,
    // defaultDepartment is the portal landing page only — not an access restriction.
    defaultDepartment: r.Default_Department__c ?? null,
    parentUserId: r.Parent_User__c ?? null,
    supabaseUserId: r.Supabase_User_Id__c ?? null,
    // D-064: the dealer this user sells for, or null. Null on Harmon staff (tenant
    // scope never reads it) and null on an unattributed sales user (who then sees
    // nothing). Never writable by the user themselves.
    dealer,
  };

  // D-064 §1.3. Computed HERE so every caller of resolveIdentity gets the same answer
  // from the same inputs. resolveScope is pure and unit-tested (lib/access.test.js);
  // this is the only place the live identity meets it.
  //
  // ⚠️ NOT YET ENFORCED ANYWHERE. Phase 1 computes and RETURNS this block; no Lambda
  // filters on it. sundial-sf-query still runs the TEMP guard untouched, so what any
  // user can see today is exactly what they could see yesterday. Phase 2 wires it
  // behind ACCESS_MODEL_MODE=shadow, Phase 3 enforces.
  const scope = resolveScope(user, r.Client__c ?? null);

  return {
    user,
    // D-064 §1.3: the resolved AccessContext plus the modules/actions the client
    // reflects. Additive — every existing consumer of `user` is unaffected.
    access: accessBlock(scope),
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
