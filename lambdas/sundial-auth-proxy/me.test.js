// node --test lambdas/sundial-auth-proxy/me.test.js
//
// GET /auth/me carries `user.access.manifestVersion` = lib/field-manifest's
// MANIFEST_VERSION (access-model §1.3 / §4.5; added 2026-10-27 after
// scripts/verify-dealer-module.mjs check E found it missing). The rest of the
// response is unchanged: the identity's access keys pass through as they are, and
// `user` / `tenant` keep their shape. Drives the real router through createHandler
// with fakes — no module mocks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./index.js";
import { MANIFEST_VERSION } from "../../lib/field-manifest/index.js";

const ACCESS = {
  level: "Sales Rep",
  scope: "own",
  userId: "a1O000000000001AAA",
  dealerId: "a1X000000000001AAA",
  tenantId: "a1W7y000007AszBEAS",
  dealerActive: true,
  dealerInternal: false,
  modules: ["customer", "solar"],
  actions: ["dealer.read", "aurora.design_request"],
};

function world(identity) {
  const upserts = [];
  // upsertProfile writes through the service-role client; it swallows any error, so a
  // minimal stub is enough and the response never depends on it.
  const supabase = { from: () => ({ upsert: async (row) => (upserts.push(row), { error: null }) }) };
  const handler = createHandler({
    resolveIdentity: async () => identity,
    getSupabaseClient: async () => supabase,
    getSecret: async () => ({}),
  });
  const me = () =>
    handler({
      requestContext: { http: { method: "GET" } },
      rawPath: "/prod/auth/me",
      headers: { origin: "https://sundial.harmonelectric.net", authorization: "Bearer t" },
    });
  return { me, upserts };
}

const identityWith = (access) => ({
  authUserId: "00000000-0000-0000-0000-000000000001",
  user: { id: ACCESS.userId, email: "tim+zz-rep-a1@constructiveoperations.com", firstName: "ZZ", lastName: "Rep" },
  tenantId: "a1W7y000007AszBEAS",
  tenantSlug: "harmon",
  access,
});

test("user.access.manifestVersion is the bundled field manifest's version", async () => {
  const { me } = world(identityWith({ ...ACCESS }));
  const r = await me();
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.user.access.manifestVersion, MANIFEST_VERSION);
  // The same derived string the record reads advertise (customer:…/roofing:…/solar:…).
  assert.match(body.user.access.manifestVersion, /^customer:[0-9a-f]{8}\/roofing:[0-9a-f]{8}\/solar:[0-9a-f]{8}$/);
});

test("every other access key passes through unchanged, and user / tenant keep their shape", async () => {
  const identity = identityWith({ ...ACCESS });
  const { me } = world(identity);
  const body = JSON.parse((await me()).body);
  const { manifestVersion, ...rest } = body.user.access;
  assert.ok(manifestVersion);
  assert.deepEqual(rest, ACCESS);
  assert.deepEqual(Object.keys(body), ["user", "tenant"]);
  assert.deepEqual(body.tenant, { clientId: "a1W7y000007AszBEAS", slug: "harmon" });
  assert.equal(body.user.email, identity.user.email);
});

test("the identity object is not mutated (it is shared with the profile upsert)", async () => {
  const identity = identityWith({ ...ACCESS });
  const { me } = world(identity);
  await me();
  assert.equal("manifestVersion" in identity.access, false);
});

test("an identity with no access block still answers, without inventing one", async () => {
  const { me } = world(identityWith(null));
  const r = await me();
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).user.access, null);
});
