// lib/tenant-guard.js — the primary-tenant rule (D-078): who the primary tenant is, which
// tenants may use a single-credential integration, and that every answer fails CLOSED.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRIMARY_TENANT,
  IntegrationNotEnabledError,
  assertIntegrationEnabled,
  integrationEnabled,
  integrationEnvName,
  integrationNotEnabledBody,
  isPrimaryTenant,
  primaryTenantSlug,
} from "./tenant-guard.js";

test("primaryTenantSlug: 'harmon' unless SUNDIAL_PRIMARY_TENANT says otherwise; lower-cased and trimmed", () => {
  assert.equal(DEFAULT_PRIMARY_TENANT, "harmon");
  assert.equal(primaryTenantSlug({}), "harmon");
  assert.equal(primaryTenantSlug({ SUNDIAL_PRIMARY_TENANT: "" }), "harmon");
  assert.equal(primaryTenantSlug({ SUNDIAL_PRIMARY_TENANT: "   " }), "harmon");
  assert.equal(primaryTenantSlug({ SUNDIAL_PRIMARY_TENANT: "  Acme-Solar " }), "acme-solar");
  assert.equal(primaryTenantSlug(undefined), primaryTenantSlug(process.env), "defaults to process.env");
  assert.equal(primaryTenantSlug(null), "harmon", "a missing env object is not a crash");
});

test("isPrimaryTenant: strict — only the primary slug; null, blank and non-strings are never primary", () => {
  assert.equal(isPrimaryTenant("harmon", {}), true);
  assert.equal(isPrimaryTenant(" Harmon ", {}), true, "the slug is a label: case and stray spaces do not matter");
  for (const notPrimary of ["conops-demo", "harmon2", "harmo", "", "   ", null, undefined, 0, false, {}, ["harmon"]]) {
    assert.equal(isPrimaryTenant(notPrimary, {}), false, `${JSON.stringify(notPrimary)} must not be the primary tenant`);
  }
  assert.equal(isPrimaryTenant("acme", { SUNDIAL_PRIMARY_TENANT: "acme" }), true);
  assert.equal(isPrimaryTenant("harmon", { SUNDIAL_PRIMARY_TENANT: "acme" }), false);
});

test("integrationEnabled: the primary tenant always; anyone else only when named in SUNDIAL_<NAME>_TENANTS", () => {
  assert.equal(integrationEnvName("acumatica"), "SUNDIAL_ACUMATICA_TENANTS");
  assert.equal(integrationEnvName("welcome_call"), "SUNDIAL_WELCOME_CALL_TENANTS");
  assert.equal(integrationEnvName("Aurora"), "SUNDIAL_AURORA_TENANTS");

  assert.equal(integrationEnabled("acumatica", "harmon", {}), true, "no configuration is needed for the primary tenant");
  assert.equal(integrationEnabled("acumatica", "conops-demo", {}), false);
  assert.equal(integrationEnabled("acumatica", "conops-demo", { SUNDIAL_ACUMATICA_TENANTS: "" }), false);
  assert.equal(integrationEnabled("acumatica", "conops-demo", { SUNDIAL_ACUMATICA_TENANTS: "other, Conops-Demo ,third" }), true);
  assert.equal(integrationEnabled("acumatica", "conops", { SUNDIAL_ACUMATICA_TENANTS: "conops-demo" }), false, "an exact slug, never a prefix");
  // One integration's list says nothing about another's.
  const env = { SUNDIAL_AURORA_TENANTS: "conops-demo" };
  assert.equal(integrationEnabled("aurora", "conops-demo", env), true);
  assert.equal(integrationEnabled("acumatica", "conops-demo", env), false);
  assert.equal(integrationEnabled("welcome_call", "conops-demo", env), false);
  assert.equal(integrationEnabled("welcome_call", "conops-demo", { SUNDIAL_WELCOME_CALL_TENANTS: "conops-demo" }), true);
  // The list cannot take the primary tenant's access away.
  assert.equal(integrationEnabled("acumatica", "harmon", { SUNDIAL_ACUMATICA_TENANTS: "conops-demo" }), true);
});

test("integrationEnabled fails CLOSED: no slug is never enabled, not even when the list has an empty entry", () => {
  for (const slug of [null, undefined, "", "   ", 42, {}]) {
    assert.equal(integrationEnabled("acumatica", slug, {}), false);
    assert.equal(integrationEnabled("acumatica", slug, { SUNDIAL_ACUMATICA_TENANTS: ", ,," }), false);
  }
});

test("the 403 body and the error carry the standard code and a plain message — no tenant name, no credential", () => {
  assert.deepEqual(integrationNotEnabledBody("acumatica"), {
    error: "integration_not_enabled",
    code: "INTEGRATION_NOT_ENABLED",
    message: "Acumatica isn't enabled for this account.",
  });
  assert.equal(integrationNotEnabledBody("aurora").message, "Aurora isn't enabled for this account.");
  assert.equal(integrationNotEnabledBody("welcome_call").message, "Welcome call isn't enabled for this account.");

  const e = new IntegrationNotEnabledError("acumatica");
  assert.ok(e instanceof Error);
  assert.equal(e.name, "IntegrationNotEnabledError");
  assert.equal(e.code, "INTEGRATION_NOT_ENABLED");
  assert.equal(e.status, 403);
  assert.equal(e.message, "Acumatica isn't enabled for this account.");
  assert.deepEqual(e.body, integrationNotEnabledBody("acumatica"));

  assert.doesNotThrow(() => assertIntegrationEnabled("acumatica", "harmon", {}));
  assert.throws(() => assertIntegrationEnabled("acumatica", "conops-demo", {}), (err) => err.code === "INTEGRATION_NOT_ENABLED");
  assert.throws(() => assertIntegrationEnabled("acumatica", null, {}), IntegrationNotEnabledError);
});
