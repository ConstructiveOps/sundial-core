import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./index.js";

const T = "a1WTENANT000000001";
const row = (id, name, type, size) => ({ id, file_name: name, file_type: type, file_file_size: size, uploaded_at: "2026-04-01T10:00:00Z", attachment_file_url: `https://s3.example/${id}` });

function world({ cookie = "_s=abc" } = {}) {
  const objects = new Map();
  const rows = [];
  const supabase = {
    from: () => ({
      select: () => ({ eq: (_c, v) => ({ limit: () => ({ maybeSingle: async () => ({ data: rows.find((r) => r.s3_key === v) ? { id: 1 } : null, error: null }) }) }) }),
      insert: (r) => ({ select: () => ({ maybeSingle: async () => (rows.push(r), { data: { id: rows.length }, error: null }) }) }),
    }),
  };
  const lists = { job_1: [row("atc_1111aaaa", "a.jpeg", "image/jpeg", 21)], job_2: [row("atc_2222bbbb", "b.pdf", "application/pdf", 21)] };
  const handler = createHandler({
    getSecret: async () => ({ apiKey: "x", ...(cookie ? { webCookie: cookie } : {}) }),
    getSupabaseClient: async () => supabase,
    tenantIdFor: async (slug) => (slug === "harmon" ? T : null),
    headObject: async (key) => (objects.has(key) ? { size: objects.get(key).length } : null),
    putObject: async ({ key, body }) => objects.set(key, body),
    fetchImpl: async (url) => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("bytes-of-" + url.split("/").pop()).buffer }),
    fetchWeb: async (url) => {
      const u = new URL(url);
      const data = lists[u.searchParams.get("attachable_uuid")] || [];
      return { status: 200, headers: new Map(), text: async () => JSON.stringify({ page: 1, total_pages_count: 1, total_count: data.length, data }) };
    },
  });
  return { handler, objects, rows };
}

test("the handler: tenant → id, cookie from the secret, a batch copied, totals; refusals are plain", async () => {
  const w = world();
  const jobs = [{ hcpJobId: "job_1", hcpCustomerId: "cus_1", sfJobId: "a1JJOB000000000001" }, { hcpJobId: "job_2", hcpCustomerId: "cus_1", sfJobId: "a1JJOB000000000002" }];
  const r = await w.handler({ tenant: "harmon", jobs }, { getRemainingTimeInMillis: () => 600000 });
  assert.equal(r.ok, true);
  assert.equal(r.done, 2);
  assert.deepEqual(r.totals, { listed: 2, copied: 2, exists: 0, failed: 0, bytes: 42 });
  assert.ok(w.objects.has("SUNDIAL/a1JJOB000000000001/photos/hcp/a.jpeg"));
  assert.ok(w.objects.has("SUNDIAL/a1JJOB000000000002/b.pdf"));
  assert.equal(w.rows.length, 2);
  assert.equal(w.rows[0].tenant_id, T);
  assert.equal((await w.handler({ tenant: "harmon", jobs, dryRun: true })).totals.copied, 0);
  assert.equal((await w.handler({ jobs })).error, "TENANT_REQUIRED");
  assert.equal((await w.handler({ tenant: "nobody", jobs })).error, "TENANT_UNKNOWN");
  assert.equal((await world({ cookie: null }).handler({ tenant: "harmon", jobs })).error, "COOKIE_MISSING");
  assert.deepEqual(await w.handler({ tenant: "harmon", jobs: [] }), { ok: true, results: [], done: 0, remaining: [] });
});
