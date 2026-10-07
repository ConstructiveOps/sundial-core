// lib/hcp-media.js — the HCP job attachments into the job's S3 folder (2026-10-05).
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentFromRow, copyJobMedia, copyJobsMedia, createHcpWebClient, isPhoto, planKeys } from "./hcp-media.js";

const T = "a1WTENANT000000001";
const row = (id, name, type, size, at, url = `https://s3.example/${id}`) => ({ id, file_name: name, file_type: type, file_file_size: size, uploaded_at: at, attachment_file_url: url, description: null });

/** A fake HCP web app: one customer with jobs → attachment rows; 429 once if asked. */
function fakeHcp({ jobs, failOnce = false, session = true } = {}) {
  const calls = [];
  let tripped = false;
  const fetchImpl = async (url, init) => {
    calls.push({ url, cookie: init.headers.Cookie });
    const u = new URL(url);
    if (!session) return { status: 401, headers: new Map(), text: async () => "" };
    if (failOnce && !tripped) {
      tripped = true;
      return { status: 429, headers: new Map([["retry-after", "0"]]), text: async () => "" };
    }
    const job = u.searchParams.get("attachable_uuid");
    const page = Number(u.searchParams.get("page"));
    const size = Number(u.searchParams.get("page_size"));
    const all = jobs[job] || [];
    const data = all.slice((page - 1) * size, page * size);
    return { status: 200, headers: new Map(), text: async () => JSON.stringify({ object: "list", page, page_size: size, total_pages_count: Math.max(1, Math.ceil(all.length / size)), total_count: all.length, data }) };
  };
  return { calls, client: createHcpWebClient({ cookie: "_s=abc", fetchImpl, sleep: async () => {}, minGapMs: 0 }) };
}

test("attachmentFromRow + isPhoto + planKeys: photos under photos/hcp, documents at the job root, a duplicate name gets the id's tail", () => {
  const a = attachmentFromRow(row("atc_1111aaaa", "IMG_0001.jpeg", "image/jpeg", 100, "2026-04-01T10:00:00Z"));
  assert.equal(a.fileName, "IMG_0001.jpeg");
  assert.equal(a.url, "https://s3.example/atc_1111aaaa");
  assert.equal(isPhoto("image/jpeg"), true);
  assert.equal(isPhoto("video/mp4"), true);
  assert.equal(isPhoto("application/pdf"), false);
  const planned = planKeys("a1JJOB000000000001", [
    attachmentFromRow(row("atc_1111aaaa", "IMG_0001.jpeg", "image/jpeg", 100, "2026-04-01T10:00:00Z")),
    attachmentFromRow(row("atc_2222bbbb", "IMG_0001.jpeg", "image/jpeg", 120, "2026-04-02T10:00:00Z")),
    attachmentFromRow(row("atc_3333cccc", "Site plan (final).pdf", "application/pdf", 900, "2026-04-03T10:00:00Z")),
    attachmentFromRow(row("atc_4444dddd", "../evil/..name.mp4", "video/mp4", 5, "2026-04-04T10:00:00Z")),
  ]);
  assert.deepEqual(planned.map((p) => p.key), [
    "SUNDIAL/a1JJOB000000000001/photos/hcp/IMG_0001.jpeg",
    "SUNDIAL/a1JJOB000000000001/photos/hcp/IMG_0001-bbbb.jpeg",
    "SUNDIAL/a1JJOB000000000001/Site_plan_(final).pdf",
    "SUNDIAL/a1JJOB000000000001/photos/hcp/name.mp4",
  ]);
  assert.equal(planned[2].subfolder, null);
  assert.equal(planned[0].subfolder, "photos/hcp");
});

test("the web client: cookie on every call, the list paginated and sorted oldest first, a 429 retried, a 401 = SESSION_EXPIRED", async () => {
  const rows = Array.from({ length: 130 }, (_, i) => row(`atc_${String(i).padStart(8, "0")}`, `IMG_${i}.jpeg`, "image/jpeg", 10, `2026-04-${String(1 + (i % 28)).padStart(2, "0")}T10:00:00Z`));
  const { calls, client } = fakeHcp({ jobs: { job_1: rows }, failOnce: true });
  const list = await client.listJobAttachments({ customerId: "cus_1", jobId: "job_1" });
  assert.equal(list.length, 130);
  assert.ok(calls.every((c) => c.cookie === "_s=abc"));
  assert.ok(calls[0].url.includes("/api/customers/cus_1/attachments?") && calls[0].url.includes("attachable_uuid=job_1") && calls[0].url.includes("page_size=100"));
  assert.equal(client.stats.retries, 1);
  assert.ok(list[0].uploadedAt <= list[1].uploadedAt);
  const gone = fakeHcp({ jobs: {}, session: false });
  await assert.rejects(() => gone.client.listJobAttachments({ customerId: "cus_1", jobId: "job_1" }), (e) => e.code === "SESSION_EXPIRED");
  assert.throws(() => createHcpWebClient({ cookie: "" }), /cookie is required/);
});

function fakeStore() {
  const objects = new Map();
  const rows = [];
  const supabase = {
    from: () => ({
      select: () => ({ eq: (_c, v) => ({ limit: () => ({ maybeSingle: async () => ({ data: rows.find((r) => r.s3_key === v) ? { id: 1 } : null, error: null }) }) }) }),
      insert: (r) => ({ select: () => ({ maybeSingle: async () => (rows.push(r), { data: { id: rows.length }, error: null }) }) }),
    }),
  };
  return {
    objects,
    rows,
    supabase,
    headObject: async (key) => (objects.has(key) ? { size: objects.get(key).length } : null),
    putObject: async ({ key, body }) => objects.set(key, body),
    fetchImpl: async (url) => ({ ok: !/broken/.test(url), status: /broken/.test(url) ? 403 : 200, arrayBuffer: async () => new TextEncoder().encode(url.endsWith("big") ? "x".repeat(120) : "bytes-of-" + url.split("/").pop()).buffer }),
  };
}

test("copyJobMedia: lists, copies, registers a row once; a re-run finds everything and copies nothing; a failed download is one failed row, not a failed job; dry run touches nothing", async () => {
  const jobs = {
    job_1: [row("atc_1111aaaa", "IMG_1.jpeg", "image/jpeg", 21, "2026-04-01T10:00:00Z"), row("atc_2222bbbb", "notes.pdf", "application/pdf", 17, "2026-04-02T10:00:00Z", "https://s3.example/broken"), row("atc_3333cccc", "clip.mp4", "video/mp4", 120, "2026-04-03T10:00:00Z", "https://s3.example/big")],
  };
  const { client } = fakeHcp({ jobs });
  const store = fakeStore();
  const deps = { client, ...store };
  const dry = await copyJobMedia({ hcpJobId: "job_1", hcpCustomerId: "cus_1", sfJobId: "a1JJOB000000000001", tenantId: T, dryRun: true, deps });
  assert.equal(dry.listed, 3);
  assert.equal(store.objects.size, 0);
  assert.ok(dry.files.every((f) => f.status === "planned"));
  const r1 = await copyJobMedia({ hcpJobId: "job_1", hcpCustomerId: "cus_1", sfJobId: "a1JJOB000000000001", tenantId: T, deps });
  assert.equal(r1.copied, 2);
  assert.equal(r1.failed, 1);
  assert.equal(r1.bytes, "bytes-of-atc_1111aaaa".length + 120);
  assert.deepEqual(r1.files.map((f) => f.status), ["copied", "failed", "copied"]);
  assert.match(r1.files[1].error, /download 403/);
  assert.ok(store.objects.has("SUNDIAL/a1JJOB000000000001/photos/hcp/IMG_1.jpeg"));
  assert.ok(store.objects.has("SUNDIAL/a1JJOB000000000001/photos/hcp/clip.mp4"));
  assert.equal(store.rows.length, 2);
  assert.equal(store.rows[0].category, "photo");
  assert.equal(store.rows[0].subfolder, "photos/hcp");
  assert.equal(store.rows[0].sf_record_id, "a1JJOB000000000001");
  assert.equal(store.rows[0].sf_object_type, "job");
  assert.equal(store.rows[0].uploaded_by_user_name, "Housecall Pro migration");
  assert.match(store.rows[0].description, /Uploaded to HCP 2026-04-01/);
  // run again: the two copied files exist at the same size, the broken one fails again, no new rows
  const r2 = await copyJobMedia({ hcpJobId: "job_1", hcpCustomerId: "cus_1", sfJobId: "a1JJOB000000000001", tenantId: T, deps });
  assert.equal(r2.copied, 0);
  assert.equal(r2.exists, 2);
  assert.equal(r2.failed, 1);
  assert.equal(store.rows.length, 2, "no duplicate metadata rows");
});

test("copyJobsMedia: a batch stops at the deadline and says where to resume; an expired session stops it at once", async () => {
  const jobs = { job_1: [row("atc_1111aaaa", "a.jpeg", "image/jpeg", 10, "2026-04-01T10:00:00Z")], job_2: [row("atc_2222bbbb", "b.jpeg", "image/jpeg", 10, "2026-04-01T10:00:00Z")], job_3: [] };
  const { client } = fakeHcp({ jobs });
  const store = fakeStore();
  const list = [{ hcpJobId: "job_1", hcpCustomerId: "cus_1", sfJobId: "a1JJOB000000000001" }, { hcpJobId: "job_2", hcpCustomerId: "cus_1", sfJobId: "a1JJOB000000000002" }, { hcpJobId: "job_3", hcpCustomerId: "cus_1", sfJobId: "a1JJOB000000000003" }];
  let t = 0;
  const r = await copyJobsMedia(list, { tenantId: T, deps: { client, ...store }, deadlineMs: 1, now: () => t++ * 1 });
  assert.equal(r.done, 2, "the clock ran out before the third");
  assert.deepEqual(r.remaining.map((j) => j.hcpJobId), ["job_3"]);
  assert.equal(r.results.length, 2);
  const gone = fakeHcp({ jobs, session: false });
  const r2 = await copyJobsMedia(list, { tenantId: T, deps: { client: gone.client, ...store } });
  assert.equal(r2.error, "SESSION_EXPIRED");
  assert.equal(r2.done, 0);
  assert.equal(r2.remaining.length, 3);
});
