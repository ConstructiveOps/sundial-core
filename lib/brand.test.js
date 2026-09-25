// lib/brand.js — the tenant's brand from Secrets Manager `sundial/brand` (2026-09-24):
// the merge order, the sanitising, the logo fetch + cache, and that nothing here throws.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrandLoader, imageKind, mergeBrand, sanitizeBrand } from "./brand.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test("sanitizeBrand: strings only, https URLs only, a hex colour, unknown keys dropped", () => {
  const b = sanitizeBrand({ companyName: " Acme ", logoUrl: "http://insecure/x.png", termsUrl: "https://acme.test/terms", accentColor: "red", clubBlurb: 42, hacker: "x" });
  assert.deepEqual(b, { companyName: "Acme", termsUrl: "https://acme.test/terms", clubBlurb: "42" });
  assert.deepEqual(sanitizeBrand(null), {});
  assert.equal(sanitizeBrand({ accentColor: "#0F2140" }).accentColor, "#0F2140");
});

test("mergeBrand: defaults ← secret.default ← the tenant ← SERVICE_BRAND_NAME for a missing name", () => {
  const secret = { default: { accentColor: "#111111", termsUrl: "https://x.test/terms" }, harmon: { companyName: "Harmon Service", logoUrl: "https://x.test/logo.png" } };
  const h = mergeBrand({ secret, tenantSlug: "harmon", env: { SERVICE_BRAND_NAME: "Env Co" } });
  assert.equal(h.companyName, "Harmon Service");
  assert.equal(h.logoUrl, "https://x.test/logo.png");
  assert.equal(h.termsUrl, "https://x.test/terms");
  assert.equal(h.accentColor, "#111111");
  const other = mergeBrand({ secret, tenantSlug: "other", env: { SERVICE_BRAND_NAME: "Env Co" } });
  assert.equal(other.companyName, "Env Co", "the old env var still names an unconfigured tenant");
  assert.equal(other.logoUrl, "");
  const none = mergeBrand({ secret: null, tenantSlug: "harmon", env: {} });
  assert.equal(none.companyName, "");
  assert.equal(none.accentColor, "#1F3864");
});

test("imageKind", () => {
  assert.equal(imageKind(PNG), "png");
  assert.equal(imageKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assert.equal(imageKind(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), null);
});

test("the loader: one secret read per five minutes, the logo fetched once and kept, a bad fetch leaves the name; cached() answers synchronously", async () => {
  let t = 0;
  let secretReads = 0;
  const fetches = [];
  const loader = createBrandLoader({
    getSecret: async () => {
      secretReads++;
      return { harmon: { companyName: "Harmon Service", logoUrl: "https://cdn.test/logo.png", clubUrl: "https://club.test/" }, broken: { companyName: "Broken", logoUrl: "https://cdn.test/missing.png" } };
    },
    fetchUrl: async (url) => {
      fetches.push(url);
      if (url.endsWith("missing.png")) return { ok: false, status: 404 };
      return { ok: true, status: 200, arrayBuffer: async () => PNG.buffer.slice(0) };
    },
    env: {},
    now: () => t,
  });
  assert.equal(loader.cached("harmon"), null);
  const a = await loader.brandFor({ tenantSlug: "harmon" }, { withLogo: true });
  assert.equal(a.companyName, "Harmon Service");
  assert.equal(a.logoKind, "png");
  assert.ok(a.logoBytes instanceof Uint8Array);
  assert.equal(a.clubUrl, "https://club.test/");
  const b = await loader.brandFor({ tenantSlug: "harmon" }, { withLogo: true });
  assert.equal(secretReads, 1);
  assert.deepEqual(fetches, ["https://cdn.test/logo.png"], "the logo is fetched once");
  assert.equal(b.logoKind, "png");
  assert.equal(loader.cached("harmon").companyName, "Harmon Service");
  // without the logo: no fetch, no bytes
  const c = await loader.brandFor({ tenantSlug: "harmon" });
  assert.equal(c.logoBytes, undefined);
  assert.equal(c.logoUrl, "https://cdn.test/logo.png");
  // a 404 logo: the brand still comes back, without bytes
  const d = await loader.brandFor({ tenantSlug: "broken" }, { withLogo: true });
  assert.equal(d.companyName, "Broken");
  assert.equal(d.logoBytes, undefined);
  // the secret is re-read after five minutes
  t = 6 * 60 * 1000;
  await loader.brandFor({ tenantSlug: "harmon" });
  assert.equal(secretReads, 2);
});

test("no secret at all (ResourceNotFound) → defaults, never a throw", async () => {
  const loader = createBrandLoader({
    getSecret: async () => {
      const e = new Error("not found");
      e.name = "ResourceNotFoundException";
      throw e;
    },
    env: { SERVICE_BRAND_NAME: "Env Co" },
  });
  const b = await loader.brandFor({ tenantSlug: "harmon" }, { withLogo: true });
  assert.equal(b.companyName, "Env Co");
  assert.equal(b.logoUrl, "");
});
