// lib/tenant-guard.js — the PRIMARY-TENANT rule (D-078, 2026-09-29).
//
// WHY THIS EXISTS. Every tenant shares one set of deployed Lambdas and one Salesforce
// org; records are kept apart by `Client__c`. The INTEGRATIONS were never kept apart,
// because there was only one tenant: one Acumatica login, one Aurora account, one Retell
// agent, one shared texting line, one portal URL per Lambda, one company name per Lambda.
// All of those are Harmon's. The moment a second tenant exists on the same Lambdas, a
// button pressed in that tenant would create a customer in Harmon's ERP, a project in
// Harmon's Aurora, a real phone call on Harmon's Retell agent, or an email carrying
// Harmon's portal link.
//
// THE RULE. Harmon predates per-tenant configuration, so every single-credential
// integration and every un-keyed fallback belongs to the PRIMARY tenant and nobody else.
// Any other tenant gets an integration only by being named explicitly — a per-slug entry
// in a secret, or its slug in the integration's allowlist env var — and otherwise gets a
// clean "isn't enabled" / "not configured" answer. Never the primary tenant's
// credentials, phone line, company name or portal URL.
//
// WHY THE DEFAULT IS A LITERAL SLUG. The primary tenant is named by its slug
// (`Sundial_Tenant__c.Name`), not its record id: the slug is already on every identity
// (`identity.tenantSlug`), on every record read (`Client__r.Name`), and is the key of
// every per-tenant secret block — so the check costs nothing and needs no lookup. The
// default is the literal "harmon", overridable by env, exactly as
// lambdas/sundial-aurora-inbound/customerCreate.js already does
// (`process.env.SUNDIAL_TENANT_SLUG || "harmon"`): the deployed Lambdas need no new
// configuration to keep behaving as they do today, and a copy of this backend stood up
// for a different first tenant sets one env var instead of editing code.
//
// ENV KNOBS (none is needed for the primary tenant):
//   SUNDIAL_PRIMARY_TENANT     the primary tenant's slug. Default "harmon".
//   SUNDIAL_<NAME>_TENANTS     comma-separated slugs ALSO allowed to use integration
//                              <NAME> (upper-cased), e.g. SUNDIAL_ACUMATICA_TENANTS,
//                              SUNDIAL_AURORA_TENANTS, SUNDIAL_WELCOME_CALL_TENANTS.
//                              Set it on a Lambda only once that tenant really should
//                              share the primary tenant's account for that integration.
//
// Everything here is pure (no I/O, no secrets) and fails CLOSED: a missing or blank slug
// is never the primary tenant and is never enabled for anything.

export const DEFAULT_PRIMARY_TENANT = "harmon";

const norm = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** The primary tenant's slug, lower-cased. */
export function primaryTenantSlug(env = process.env) {
  return norm(env?.SUNDIAL_PRIMARY_TENANT) || DEFAULT_PRIMARY_TENANT;
}

/** Strict: true only for the primary tenant's slug. null / blank → false. */
export function isPrimaryTenant(slug, env = process.env) {
  const s = norm(slug);
  return s !== "" && s === primaryTenantSlug(env);
}

/** The env var that lists the extra tenants allowed to use an integration. */
export function integrationEnvName(name) {
  return `SUNDIAL_${String(name ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TENANTS`;
}

/**
 * May this tenant use the single-credential integration `name`?
 * The primary tenant: always. Anyone else: only when its slug is listed in
 * SUNDIAL_<NAME>_TENANTS. No slug → no (fail closed).
 */
export function integrationEnabled(name, slug, env = process.env) {
  const s = norm(slug);
  if (!s) return false;
  if (s === primaryTenantSlug(env)) return true;
  const listed = String(env?.[integrationEnvName(name)] ?? "")
    .split(",")
    .map(norm)
    .filter(Boolean);
  return listed.includes(s);
}

/** "acumatica" → "Acumatica", "welcome_call" → "Welcome call" — for the message a person reads. */
export function integrationLabel(name) {
  const words = String(name ?? "").trim().replace(/[_-]+/g, " ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "This integration";
}

/** The standard 403 body every guarded route answers with. No tenant name, no credential. */
export function integrationNotEnabledBody(name) {
  return {
    error: "integration_not_enabled",
    code: "INTEGRATION_NOT_ENABLED",
    message: `${integrationLabel(name)} isn't enabled for this account.`,
  };
}

/** Thrown by code paths that have no HTTP response to build (modules, direct invokes). */
export class IntegrationNotEnabledError extends Error {
  constructor(name) {
    super(integrationNotEnabledBody(name).message);
    this.name = "IntegrationNotEnabledError";
    this.code = "INTEGRATION_NOT_ENABLED";
    this.status = 403;
    this.integration = String(name ?? "");
    this.body = integrationNotEnabledBody(name);
  }
}

/** Throwing form of integrationEnabled, for code that is not building a response. */
export function assertIntegrationEnabled(name, slug, env = process.env) {
  if (!integrationEnabled(name, slug, env)) throw new IntegrationNotEnabledError(name);
}
