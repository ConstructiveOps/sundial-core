// lib/tenant-settings.js — a tenant's own portal address, public-page address and company
// name (D-078). The two things that matter most: the PRIMARY tenant gets exactly the
// value its Lambda computed before — and the brand secret is never read for it — and no
// other tenant is ever handed the primary tenant's value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantSettings, portalUrlNotConfiguredBody, PORTAL_URL_NOT_CONFIGURED } from "./tenant-settings.js";

const PRIMARY_PORTAL = "https://sundial.harmonelectric.net";
const SECRET = {
  default: { accentColor: "#111111", portalUrl: "https://shared-default.example.com", companyName: "" },
  harmon: { companyName: "Harmon Service", portalUrl: "https://ignored-for-primary.example.com" },
  "conops-demo": { companyName: "Constructive Operations", portalUrl: "https://demo.example.com/" },
  split: { companyName: "Split Co", portalUrl: "https://portal.split.example.com", publicUrl: "https://pages.split.example.com" },
  bare: { tagline: "no name, no address" },
};
function world(secret = SECRET, env = {}) {
  const reads = [];
  const settings = createTenantSettings({
    getSecret: async (name) => {
      reads.push(name);
      if (secret instanceof Error) throw secret;
      return secret;
    },
    env,
  });
  return { settings, reads };
}

test("the PRIMARY tenant gets exactly the value handed in — and the brand secret is NEVER read for it", async () => {
  const { settings, reads } = world();
  assert.equal(await settings.portalUrlFor("harmon", PRIMARY_PORTAL), PRIMARY_PORTAL);
  assert.equal(await settings.publicUrlFor("harmon", "https://sundial.harmonelectric.net"), "https://sundial.harmonelectric.net");
  assert.equal(await settings.companyNameFor("harmon", "Harmon Electric"), "Harmon Electric");
  // …including "nothing": an unset env var stays unset rather than being filled from the secret.
  assert.equal(await settings.publicUrlFor("harmon", ""), "");
  assert.equal(await settings.companyNameFor("Harmon", ""), "");
  assert.deepEqual(reads, [], "no Secrets Manager read on the primary tenant's path");
});

test("the primary tenant's defaults, when the caller hands nothing in, are the Lambda's env vars — still no secret read", async () => {
  const { settings, reads } = world(SECRET, { PORTAL_BASE_URL: "https://portal.example.com/", SERVICE_PUBLIC_BASE_URL: "https://pages.example.com//", SERVICE_BRAND_NAME: " Env Co " });
  assert.equal(await settings.portalUrlFor("harmon"), "https://portal.example.com");
  assert.equal(await settings.publicUrlFor("harmon"), "https://pages.example.com");
  assert.equal(await settings.companyNameFor("harmon"), "Env Co");
  const none = world(SECRET, {});
  assert.equal(await none.settings.portalUrlFor("harmon"), null);
  assert.equal(await none.settings.publicUrlFor("harmon"), null);
  assert.equal(await none.settings.companyNameFor("harmon"), "");
  assert.deepEqual([...reads, ...none.reads], []);
});

test("another tenant gets ITS OWN block: portalUrl, publicUrl (defaulting to portalUrl), companyName — never the primary's", async () => {
  const { settings, reads } = world();
  assert.equal(await settings.portalUrlFor("conops-demo", PRIMARY_PORTAL), "https://demo.example.com");
  assert.equal(await settings.publicUrlFor("conops-demo", PRIMARY_PORTAL), "https://demo.example.com");
  assert.equal(await settings.companyNameFor("conops-demo", "Harmon Electric"), "Constructive Operations");
  assert.equal(await settings.portalUrlFor("split", PRIMARY_PORTAL), "https://portal.split.example.com");
  assert.equal(await settings.publicUrlFor("split", PRIMARY_PORTAL), "https://pages.split.example.com");
  assert.deepEqual(reads, ["sundial/brand"], "one read, then the five-minute cache");
});

test("not configured → null, whatever the primary value or the shared default block says", async () => {
  const { settings } = world();
  for (const slug of ["bare", "unknown-tenant"]) {
    assert.equal(await settings.portalUrlFor(slug, PRIMARY_PORTAL), null);
    assert.equal(await settings.publicUrlFor(slug, PRIMARY_PORTAL), null);
    assert.equal(await settings.companyNameFor(slug, "Harmon Electric"), null);
  }
});

test("no slug is never the primary tenant: null, and nothing is read", async () => {
  const { settings, reads } = world();
  for (const slug of [null, undefined, "", "  "]) {
    assert.equal(await settings.portalUrlFor(slug, PRIMARY_PORTAL), null);
    assert.equal(await settings.publicUrlFor(slug, PRIMARY_PORTAL), null);
    assert.equal(await settings.companyNameFor(slug, "Harmon Electric"), null);
  }
  assert.deepEqual(reads, []);
});

test("an unreadable or missing secret is 'not configured' for other tenants, never a throw — and never touches the primary tenant", async () => {
  for (const bad of [new Error("AccessDenied"), Object.assign(new Error("nope"), { name: "ResourceNotFoundException" }), null, "not-an-object"]) {
    const { settings } = world(bad);
    assert.equal(await settings.portalUrlFor("conops-demo", PRIMARY_PORTAL), null);
    assert.equal(await settings.companyNameFor("conops-demo", "Harmon Electric"), null);
    assert.equal(await settings.portalUrlFor("harmon", PRIMARY_PORTAL), PRIMARY_PORTAL);
  }
});

test("SUNDIAL_PRIMARY_TENANT moves the rule with it", async () => {
  const { settings, reads } = world(SECRET, { SUNDIAL_PRIMARY_TENANT: "conops-demo" });
  assert.equal(await settings.portalUrlFor("conops-demo", "https://primary.example.com"), "https://primary.example.com");
  assert.deepEqual(reads, []);
  assert.equal(await settings.portalUrlFor("harmon", "https://primary.example.com"), "https://ignored-for-primary.example.com", "harmon is now an ordinary tenant and reads its own block");
});

test("a shared brand loader is reused rather than a second one created", async () => {
  const calls = [];
  const brands = { brandFor: async ({ tenantSlug }) => (calls.push(tenantSlug), { companyName: "From Loader", portalUrl: "https://loader.example.com" }) };
  const settings = createTenantSettings({ brands, getSecret: async () => assert.fail("must not read the secret itself"), env: {} });
  assert.equal(await settings.companyNameFor("conops-demo", "x"), "From Loader");
  assert.equal(await settings.portalUrlFor("conops-demo", "x"), "https://loader.example.com");
  assert.deepEqual(calls, ["conops-demo", "conops-demo"]);
});

test("the refusal body carries PORTAL_URL_NOT_CONFIGURED in the existing not_configured style", () => {
  assert.equal(PORTAL_URL_NOT_CONFIGURED, "PORTAL_URL_NOT_CONFIGURED");
  assert.deepEqual(portalUrlNotConfiguredBody(), { error: "not_configured", code: "PORTAL_URL_NOT_CONFIGURED", message: "This account has no portal address configured yet, so a link can't be sent." });
  assert.equal(portalUrlNotConfiguredBody("Custom.").message, "Custom.");
});
