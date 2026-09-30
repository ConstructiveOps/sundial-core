// lib/tenant-settings.js — a tenant's own addresses and name for OUTBOUND messages (D-078).
//
// WHY THIS EXISTS. Three values were one-per-Lambda because there was one tenant:
//   PORTAL_BASE_URL           where invite / password-reset / @-mention emails link to
//   SERVICE_PUBLIC_BASE_URL   where customers open an estimate, a job report, a pay link
//   SERVICE_BRAND_NAME        the company name in "on my way" texts and appointment emails
// All three are the PRIMARY tenant's (lib/tenant-guard.js). On shared Lambdas a second
// tenant's invite would link to the primary tenant's portal and its customers would be
// texted in the primary tenant's name.
//
// THE RULE, as one resolver per value:
//   - the PRIMARY tenant gets `primaryValue` — the very value the calling Lambda computed
//     before this module existed (its env var and in-code default), handed in by the
//     caller so nothing about it can drift. The brand secret is NOT read for it: no new
//     Secrets Manager call, no new way to fail.
//   - ANY OTHER tenant gets what its own block in Secrets Manager `sundial/brand` says
//     (`portalUrl`, `publicUrl` — which defaults to portalUrl — and `companyName`, see
//     lib/brand.js), or null when it has none. Null means "not configured": the caller
//     refuses to send the link (code PORTAL_URL_NOT_CONFIGURED) or sends without one.
//     It never falls back to the primary tenant's value.
//   - a missing slug is never the primary tenant (fail closed) → null.
//
// Fail-soft like lib/brand.js: an unreadable secret is "not configured", never a throw.

import { createBrandLoader, brandPortalUrl, brandPublicUrl } from "./brand.js";
import { getSecret as realGetSecret } from "./secrets.js";
import { isPrimaryTenant } from "./tenant-guard.js";

export const PORTAL_URL_NOT_CONFIGURED = "PORTAL_URL_NOT_CONFIGURED";

/** The clean refusal for "this tenant has no address to put in the link". */
export function portalUrlNotConfiguredBody(message) {
  return {
    error: "not_configured",
    code: PORTAL_URL_NOT_CONFIGURED,
    message: message || "This account has no portal address configured yet, so a link can't be sent.",
  };
}

const str = (v) => (typeof v === "string" ? v.trim() : "");
const origin = (v) => str(v).replace(/\/+$/, "");

/**
 * @param {object} [deps]
 *   brands     an existing lib/brand.js loader to share (its five-minute cache), else one
 *              is created on first use from `getSecret`
 *   getSecret  Secrets Manager reader (injectable for tests)
 *   env        where SUNDIAL_PRIMARY_TENANT is read from
 * @returns {{ portalUrlFor, publicUrlFor, companyNameFor }}  each `(tenantSlug, primaryValue)`
 */
export function createTenantSettings({ brands = null, getSecret = realGetSecret, env = process.env } = {}) {
  let loader = brands;
  /** The tenant's merged brand, or null — never throws. */
  async function brandOf(tenantSlug) {
    if (!str(tenantSlug)) return null;
    try {
      if (!loader) loader = createBrandLoader({ getSecret, env });
      return await loader.brandFor({ tenantSlug });
    } catch (e) {
      console.error("tenant settings: brand unreadable:", e?.message || e);
      return null;
    }
  }

  return {
    /** The portal origin this tenant's staff are sent to. Primary → `primaryValue`; else its `portalUrl` or null. */
    async portalUrlFor(tenantSlug, primaryValue = origin(env.PORTAL_BASE_URL) || null) {
      if (isPrimaryTenant(tenantSlug, env)) return primaryValue;
      return origin(brandPortalUrl(await brandOf(tenantSlug))) || null;
    },
    /** The origin of this tenant's customer-facing pages. Primary → `primaryValue`; else `publicUrl`, else `portalUrl`, else null. */
    async publicUrlFor(tenantSlug, primaryValue = origin(env.SERVICE_PUBLIC_BASE_URL) || null) {
      if (isPrimaryTenant(tenantSlug, env)) return primaryValue;
      return origin(brandPublicUrl(await brandOf(tenantSlug))) || null;
    },
    /** The company name in this tenant's texts and emails. Primary → `primaryValue`; else its `companyName` or null. */
    async companyNameFor(tenantSlug, primaryValue = str(env.SERVICE_BRAND_NAME)) {
      if (isPrimaryTenant(tenantSlug, env)) return primaryValue;
      return str((await brandOf(tenantSlug))?.companyName) || null;
    },
  };
}
